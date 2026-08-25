// Contagem regressiva antes da rodada: 3 · 2 · 1 · VAI!, em tela cheia sobre a arena.
//
// Vale para os dois modos — no local o relógio é a fase `countdown` do laço; no online é o
// `timeLeft` do estado frio na mesma fase. Durante a contagem ninguém anda nem atira (nenhum dos
// dois lados chama `step()` fora da fase `playing`), então o overlay é sincronizado com o jogo
// por construção, sem relógio próprio.
//
// Cada valor novo recria o `<div>` do número. Recriar é o que REINICIA as animações CSS — trocar
// só o `textContent` manteria a animação anterior rodando e o 2 apareceria já pequeno, e o anel
// de 1 s não voltaria ao começo. São 4 nós por rodada, custo irrelevante.

export interface CountdownState {
  /** Segundos restantes da contagem; `null` quando a contagem não está ativa. */
  restante: number | null;
  /** `true` no instante logo depois do zero — mostra "VAI!" no lugar do número. */
  vai: boolean;
}

let built = false;
let els: { numero: HTMLElement } | null = null;
let ultimaChave = '';

function ensureBuilt(root: HTMLElement): void {
  if (built) return;
  root.innerHTML = `<div class="numero-slot"></div>`;
  els = { numero: root.querySelector('.numero-slot')! };
  built = true;
}

/**
 * O anel é um SVG com o traço inteiro em `stroke-dasharray` e o `stroke-dashoffset` animado em
 * 1 s — o círculo se fecha exatamente no tempo do número que está na tela.
 */
function anel(): string {
  return `<svg class="anel" viewBox="0 0 120 120" aria-hidden="true">
    <circle class="trilho" cx="60" cy="60" r="54" />
    <circle class="progresso" cx="60" cy="60" r="54" />
  </svg>`;
}

/**
 * Desenha (ou esconde) a contagem. Devolve `true` no frame em que um valor NOVO entrou na tela —
 * quem chama usa isso para pontuar o momento (tremor de câmera no "VAI!", bipe, etc.).
 */
export function renderCountdown(root: HTMLElement, state: CountdownState): boolean {
  ensureBuilt(root);
  if (!els) return false;

  const ativo = state.vai || (state.restante !== null && state.restante > 0);
  root.classList.toggle('ativa', ativo);

  if (!ativo) {
    if (ultimaChave !== '') {
      els.numero.innerHTML = '';
      ultimaChave = '';
    }
    return false;
  }

  const chave = state.vai ? 'vai' : String(Math.max(1, Math.ceil(state.restante ?? 0)));
  if (chave === ultimaChave) return false;
  ultimaChave = chave;

  els.numero.innerHTML = state.vai
    ? `<div class="numero vai" data-texto="VAI!">VAI!</div><div class="risco"></div>`
    : `<div class="disco">${anel()}<div class="numero">${chave}</div></div><div class="prepare">PREPARE-SE</div>`;
  return true;
}

/** Zera o estado entre rodadas para o "3" da rodada seguinte voltar a animar do início. */
export function resetCountdown(): void {
  ultimaChave = '';
}
