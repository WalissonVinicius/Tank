// Ciclo de vida do áudio (Fase 8 §5) — um ÚNICO AudioContext para toda a aplicação, suspenso
// quando ninguém está ouvindo e devolvido ao sistema quando a página sai.
//
// O bug relatado pelo usuário: "escuto áudio do jogo e depois o áudio de outra página não
// funciona". Causa — o `zzfx` cria `new AudioContext` no CORPO do módulo (`ZZFX.audioContext`),
// e o código anterior só chamava `resume()`. Nunca `suspend()`, nunca `close()`. Cada carga da
// página deixava um contexto vivo e engatado na sessão de áudio do sistema; o navegador tem um
// teto de contextos simultâneos e, ao estourar, quem parava de tocar era todo mundo.
//
// O que este módulo garante:
//   · UM contexto — guardado em `globalThis` para sobreviver ao HMR do Vite; se o módulo do zzfx
//     for reavaliado e criar outro, o novo é fechado na hora e o antigo reassumido;
//   · `suspend()` quando a aba fica oculta ou quando o jogo não está em partida (lobby, placar,
//     tela de vencedor) — contexto suspenso não segura a sessão de áudio do sistema;
//   · `close()` no `pagehide`/`beforeunload` de saída de verdade, devolvendo o recurso. Saída para
//     o bfcache (`persisted`) só suspende, senão voltar pelo botão "voltar" traria o jogo mudo.

interface RegistroGlobal {
  ctx: AudioContext | null;
  /** Só para depuração/telemetria: quantos contextos esta aba criou desde o boot. */
  criados: number;
}

const CHAVE = '__tankAudio';

function registro(): RegistroGlobal {
  const alvo = globalThis as unknown as Record<string, RegistroGlobal | undefined>;
  alvo[CHAVE] ??= { ctx: null, criados: 0 };
  return alvo[CHAVE];
}

type ModuloZzfx = typeof import('zzfx');

let modulo: Promise<ModuloZzfx> | null = null;
let desbloqueado = false;
let querSom = false;
let ouvintesLigados = false;
let encerrado = false;

/**
 * Resolve o módulo do zzfx UMA vez e amarra o `ZZFX.audioContext` ao contexto singleton.
 *
 * O `await import()` a cada tiro devolveria uma promise nova por disparo — microtarefa de graça no
 * caminho quente do frame (§5 do relatório da Fase 4). Aqui ele também é o ponto onde o contexto
 * órfão criado pelo módulo é reconciliado com o que já existe.
 */
function carregar(): Promise<ModuloZzfx> {
  modulo ??= import('zzfx').then((m) => {
    const reg = registro();
    const doModulo = m.ZZFX.audioContext;
    if (reg.ctx && reg.ctx.state !== 'closed') {
      // Segunda avaliação do módulo (HMR): devolve o contexto recém-criado ao sistema em vez de
      // deixar dois vivos, e faz o zzfx voltar a tocar pelo contexto que já era o nosso.
      if (doModulo !== reg.ctx) void doModulo.close().catch(() => undefined);
      m.ZZFX.audioContext = reg.ctx;
    } else {
      reg.ctx = doModulo;
      reg.criados += 1;
    }
    ligarOuvintes();
    return m;
  });
  return modulo;
}

function contexto(): AudioContext | null {
  const ctx = registro().ctx;
  return ctx && ctx.state !== 'closed' ? ctx : null;
}

/** Estado atual do contexto — 'ausente' antes do primeiro som. Usado pela verificação da fase. */
export function estadoAudio(): string {
  return registro().ctx?.state ?? 'ausente';
}

function ligarOuvintes(): void {
  if (ouvintesLigados) return;
  ouvintesLigados = true;

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void suspender();
    else if (querSom) void retomar();
  });

  // `pagehide` cobre o caso que o `beforeunload` não cobre (fechar aba no mobile, navegar para
  // trás). `persisted` = a página vai para o bfcache e pode voltar: aí só suspende.
  window.addEventListener('pagehide', (ev) => {
    if (ev.persisted) void suspender();
    else fechar();
  });
  window.addEventListener('beforeunload', () => fechar());
  window.addEventListener('pageshow', (ev) => {
    if (ev.persisted && querSom) void retomar();
  });
}

async function suspender(): Promise<void> {
  const ctx = contexto();
  if (!ctx || ctx.state !== 'running') return;
  try {
    await ctx.suspend();
  } catch {
    // suspender é otimização de recurso — falhar aqui nunca pode derrubar o jogo
  }
}

async function retomar(): Promise<void> {
  const ctx = contexto();
  if (!ctx || ctx.state !== 'suspended') return;
  try {
    await ctx.resume();
  } catch {
    // sem gesto do usuário o navegador recusa; o próximo `tocar()` tenta de novo
  }
}

function fechar(): void {
  if (encerrado) return;
  encerrado = true;
  const reg = registro();
  const ctx = reg.ctx;
  reg.ctx = null;
  if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
}

/**
 * Liga/desliga a expectativa de som. `false` (lobby, fim de rodada, tela de vencedor) suspende o
 * contexto; `true` (contagem e partida) o retoma. É o que impede o jogo aberto e parado numa aba
 * de segurar a sessão de áudio do sistema.
 */
export function setAudioAtivo(ativo: boolean): void {
  if (querSom === ativo) return;
  querSom = ativo;
  if (ativo) void retomar();
  else void suspender();
}

/**
 * Marca que já houve gesto do usuário — sem isso o navegador recusa `resume()` e o primeiro som
 * sairia mudo. Um `pointerdown` ou `keydown` basta e vale para o resto da sessão.
 */
export function desbloquearAudioNoPrimeiroGesto(): void {
  const desbloquear = (): void => {
    desbloqueado = true;
    if (querSom) void retomar();
    window.removeEventListener('pointerdown', desbloquear);
    window.removeEventListener('keydown', desbloquear);
  };
  window.addEventListener('pointerdown', desbloquear, { once: true });
  window.addEventListener('keydown', desbloquear, { once: true });
}

// ---------------------------------------------------------------------------------------------
// Sons dos momentos do jogo (V2 §2).
//
// Os presets do combate (tiro, ricochete, morte) moram em `main.ts`, junto de quem dispara os
// eventos da simulação. Estes dois não: quem os dispara é o HUD, ao reconhecer no killfeed que o
// abate foi DO jogador local — e o HUD não tem nada a ver com a simulação. O lugar certo deles é
// o módulo de áudio.
// ---------------------------------------------------------------------------------------------

/**
 * Confirmação de abate: duas notas curtas e agudas, subindo. Agudo de propósito — ele toca por
 * cima do estouro grave da morte e precisa CORTAR, não somar.
 */
export const SOM_ABATE: readonly number[] = [
  0.9, 0, 1046, 0.005, 0.05, 0.09, 0, 1.4, 0, 0, 523, 0.05, 0, 0, 0, 0, 0, 0.6, 0.02,
];

/**
 * Autogol do jogador local: serra descendo com trêmulo — o "wah-wah" de piada. Entra ATRASADO em
 * relação à explosão (ver `tocarComAtraso`), porque a graça está no tempo, não no volume.
 */
export const SOM_AUTOGOL_ZOEIRA: readonly number[] = [
  1.1, 0.05, 330, 0.02, 0.22, 0.34, 2, 0.6, -9, 0, 0, 0, 0, 0.4, 0.12, 0, 0.15, 0.5, 0.12, 0.3,
];

/** Toca um preset do zzfx. Áudio é cosmético: qualquer falha morre aqui, nunca no laço de frame. */
export async function tocar(som: readonly number[]): Promise<void> {
  if (encerrado || !querSom) return;
  // Aba oculta NÃO toca. O `visibilitychange` já suspende o contexto, mas sem esta linha o
  // `resume()` logo abaixo o acordaria de volta no primeiro som — e o jogo em segundo plano
  // (a contagem dos últimos 10 s, por exemplo) apitaria por cima do que a pessoa está ouvindo.
  if (typeof document !== 'undefined' && document.hidden) return;
  try {
    const { zzfx } = await carregar();
    const ctx = contexto();
    if (!ctx) return;
    if (ctx.state === 'suspended' && desbloqueado) await ctx.resume();
    if (ctx.state !== 'running') return;
    zzfx(...som);
  } catch {
    // idem
  }
}

/**
 * Toca um preset depois de um intervalo. Existe por causa do tempo cômico do autogol: o "wah-wah"
 * só tem graça DEPOIS do estouro, não junto dele.
 *
 * Não guarda o timer nem cancela nada: são alguns milissegundos de piada, e um som atrasado que
 * chega com o jogo já em outra tela é inofensivo — `tocar()` sozinho já recusa tocar com a aba
 * oculta ou com o áudio desligado.
 */
export function tocarComAtraso(som: readonly number[], atrasoMs: number): void {
  window.setTimeout(() => void tocar(som), atrasoMs);
}
