// Relógio LOCAL dos power-ups ativos, no modo online (P1).
//
// O servidor é a autoridade: ele manda `powerup_taken` quando alguém pega e `powerup_expired`
// quando acaba. Este relógio existe só para o que acontece ENTRE as duas mensagens — a barra do
// HUD encolhendo e o crachá aparecendo sobre o tanque. Ele nunca decide nada: se o contador daqui
// zerar antes do `powerup_expired` chegar, o efeito some da tela alguns milissegundos cedo, e é
// só isso; se a mensagem chegar antes, ela manda.
//
// Por isso ele NÃO é o `EfeitosDePowerUp` da `shared-sim`: aquele escreve nos campos do `Tank`
// para a simulação ler, e no cliente online não existe `Tank` — as posições vêm do snapshot e as
// balas já chegam com o ricochete carimbado nelas.

import type { TipoPowerUp } from '@tank/protocol';

export interface EfeitoNoJogador {
  tipo: TipoPowerUp;
  restante: number;
  duracao: number;
}

export class RelogioDeEfeitos {
  private readonly porJogador = new Map<string, EfeitoNoJogador[]>();
  /**
   * Só os tipos, um array POR JOGADOR, recomputado quando a lista muda. Um único array
   * compartilhado não serviria: o `RenderView` de um frame guarda a referência de todos os
   * tanques ao mesmo tempo, e todos acabariam apontando para o conteúdo do último.
   */
  private readonly tiposPorJogador = new Map<string, TipoPowerUp[]>();
  private readonly vazio: readonly EfeitoNoJogador[] = [];
  private readonly vazioTipos: readonly TipoPowerUp[] = [];

  /** Chegou `powerup_taken`. Pegar o mesmo tipo de novo renova, como no servidor. */
  aplicar(playerId: string, tipo: TipoPowerUp, duracao: number): void {
    let lista = this.porJogador.get(playerId);
    if (!lista) {
      lista = [];
      this.porJogador.set(playerId, lista);
    }
    const existente = lista.find((e) => e.tipo === tipo);
    if (existente) {
      existente.restante = duracao;
      existente.duracao = duracao;
      return;
    }
    lista.push({ tipo, restante: duracao, duracao });
    this.recomputarTipos(playerId, lista);
  }

  /** Chegou `powerup_expired` — a palavra final do servidor. */
  remover(playerId: string, tipo: TipoPowerUp): void {
    const lista = this.porJogador.get(playerId);
    if (!lista) return;
    const i = lista.findIndex((e) => e.tipo === tipo);
    if (i >= 0) lista.splice(i, 1);
    if (lista.length === 0) {
      this.porJogador.delete(playerId);
      this.tiposPorJogador.delete(playerId);
      return;
    }
    this.recomputarTipos(playerId, lista);
  }

  private recomputarTipos(playerId: string, lista: readonly EfeitoNoJogador[]): void {
    let tipos = this.tiposPorJogador.get(playerId);
    if (!tipos) {
      tipos = [];
      this.tiposPorJogador.set(playerId, tipos);
    }
    tipos.length = 0;
    for (const efeito of lista) tipos.push(efeito.tipo);
  }

  /**
   * Faz os relógios andarem. Não remove nada ao chegar a zero: quem remove é o servidor. Segurar
   * a faixa em zero por alguns quadros é melhor que apagá-la e vê-la voltar quando a mensagem
   * chega — e o `Math.max(0, …)` do HUD já impede o número negativo.
   */
  passo(dt: number): void {
    for (const lista of this.porJogador.values()) {
      for (const efeito of lista) efeito.restante = Math.max(0, efeito.restante - dt);
    }
  }

  ativos(playerId: string): readonly EfeitoNoJogador[] {
    return this.porJogador.get(playerId) ?? this.vazio;
  }

  /** Só os tipos, que é o que o crachá sobre o tanque precisa. */
  tiposAtivos(playerId: string): readonly TipoPowerUp[] {
    return this.tiposPorJogador.get(playerId) ?? this.vazioTipos;
  }

  limpar(): void {
    this.porJogador.clear();
    this.tiposPorJogador.clear();
  }
}
