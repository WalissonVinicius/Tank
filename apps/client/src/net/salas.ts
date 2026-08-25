// Lista de salas abertas para a tela de entrada (Fase 13 §2).
//
// É HTTP puro, não Colyseus: o SDK do matchmaking só sabe procurar sala para ENTRAR, e o que a
// tela precisa é uma vitrine — código, quanta gente tem e se já começou. O servidor monta isso a
// partir do próprio cadastro do matchMaker (`apps/server/src/net/salas.ts`).
import { ROTA_SALAS, type SalaAberta } from '@tank/protocol';

/**
 * Em produção o Node serve o client na mesma origem, então a rota é crua. Em desenvolvimento o
 * Vite proxeia `/colyseus/*` para a porta 3000 reescrevendo o prefixo — mesmo caminho que o
 * WebSocket do jogo já usa (ver `wsEndpoint` em `net/client.ts`).
 */
function urlDaLista(): string {
  return import.meta.env.DEV ? `/colyseus${ROTA_SALAS}` : ROTA_SALAS;
}

export async function buscarSalasAbertas(sinal?: AbortSignal): Promise<SalaAberta[]> {
  const resposta = await fetch(urlDaLista(), { signal: sinal, headers: { accept: 'application/json' } });
  if (!resposta.ok) throw new Error(`servidor respondeu ${resposta.status}`);
  const corpo = (await resposta.json()) as { salas?: SalaAberta[] };
  return Array.isArray(corpo.salas) ? corpo.salas : [];
}

/** Intervalo entre atualizações da lista. Sala abre e enche em segundos; 3 s acompanha sem pesar. */
const INTERVALO_MS = 3000;

/**
 * Repergunta a lista enquanto a tela de entrada está à vista, e SÓ enquanto ela está à vista.
 *
 * Para de perguntar em três situações: quando a tela sai (`desligar`), quando a aba vai para
 * segundo plano (`visibilitychange`) e enquanto a requisição anterior ainda não voltou — numa
 * rede ruim, um `setInterval` cego empilharia pedidos que chegam todos juntos depois.
 */
export class MonitorDeSalas {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private emVoo: AbortController | null = null;
  private ligado = false;

  constructor(private readonly aoAtualizar: (salas: SalaAberta[], erro: string) => void) {
    document.addEventListener('visibilitychange', () => {
      if (!this.ligado) return;
      if (document.hidden) this.pararRelogio();
      else this.agendar(0);
    });
  }

  ligar(): void {
    if (this.ligado) return;
    this.ligado = true;
    this.agendar(0);
  }

  desligar(): void {
    if (!this.ligado) return;
    this.ligado = false;
    this.pararRelogio();
    this.emVoo?.abort();
    this.emVoo = null;
  }

  private pararRelogio(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private agendar(atraso: number): void {
    this.pararRelogio();
    this.timer = setTimeout(() => void this.buscar(), atraso);
  }

  private async buscar(): Promise<void> {
    if (!this.ligado || document.hidden) return;
    this.emVoo?.abort();
    const controle = new AbortController();
    this.emVoo = controle;

    try {
      const salas = await buscarSalasAbertas(controle.signal);
      if (this.ligado) this.aoAtualizar(salas, '');
    } catch (e) {
      if (controle.signal.aborted) return;
      // Falhar a listagem não pode atrapalhar quem já sabe o código: a mensagem é discreta e o
      // formulário continua funcionando do lado.
      if (this.ligado) this.aoAtualizar([], 'não deu para consultar as salas agora');
      void e;
    } finally {
      if (this.emVoo === controle) this.emVoo = null;
      if (this.ligado) this.agendar(INTERVALO_MS);
    }
  }
}
