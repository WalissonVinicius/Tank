// Placar de fim de rodada (~3 s entre uma rodada e a próxima).
//
// Fase 8: esta tela virou o LUGAR do placar. Ele saiu do HUD (durante a ação a tela é da ação) e
// veio para cá, onde todo mundo está parado olhando — e é por isso que a movimentação no ranking
// aparece aqui em animação, não em corte seco:
//   · a linha DESLIZA da posição antiga para a nova (~320 ms, easing de saída);
//   · uma seta ▲/▼ com quantas posições mudou fica ~2 s e some;
//   · o total CONTA do valor anterior até o novo, com pulso de escala.
// Tudo por `transform`/`opacity` — nada que force reflow.
//
// Também voltam para cá o CÓDIGO DA SALA (é justo agora que alguém atrasado entra) e uma ou duas
// frases de zoeira da rodada, que saíram do killfeed.

import { emblemaHtml } from '../render/animais.js';
import { ICONE, img } from './icons.js';

export interface RoundendEntry {
  id: string;
  name: string;
  color: number;
  /** Pontuação acumulada DEPOIS de somar a rodada. */
  score: number;
  /** Pontos ganhos nesta rodada (pode ser negativo por autogol). */
  ganho: number;
  /** Chegou vivo ao fim da rodada. */
  sobreviveu: boolean;
}

export interface RoundendState {
  round: number;
  totalRounds: number;
  /** Nome de quem sobreviveu sozinho; `null` quando a rodada acabou empatada no tempo. */
  vencedor: string | null;
  entradas: RoundendEntry[];
  meId: string;
  /** Código da sala — some durante o jogo e reaparece aqui. `LOCAL` no modo offline. */
  roomCode: string;
  /** Frases de zoeira das mortes desta rodada (0 a 2). */
  destaques: string[];
}

let built = false;
let els: {
  titulo: HTMLElement;
  sub: HTMLElement;
  lista: HTMLElement;
  selo: HTMLElement;
  sala: HTMLElement;
  destaques: HTMLElement;
} | null = null;
let ultimaChave = '';
/** Ordem do ranking no fim da rodada anterior — é dela que sai a seta e o deslize. */
let ordemAnterior: string[] = [];
let animacao = 0;

function css(color: number): string {
  return '#' + (color >>> 0).toString(16).padStart(6, '0');
}

function ensureBuilt(root: HTMLElement): void {
  if (built) return;
  root.innerHTML = `
    <div class="painel-rodada">
      <div class="cabeca">
        <div class="selo" id="roundend-selo"></div>
        <div class="textos">
          <div class="titulo" id="roundend-titulo"></div>
          <div class="sub" id="roundend-sub"></div>
        </div>
        <div class="sala"><span class="lbl">SALA</span><span class="codigo" id="roundend-sala"></span></div>
      </div>
      <div class="destaques" id="roundend-destaques"></div>
      <div class="lista" id="roundend-lista"></div>
    </div>
  `;
  els = {
    titulo: root.querySelector('#roundend-titulo')!,
    sub: root.querySelector('#roundend-sub')!,
    lista: root.querySelector('#roundend-lista')!,
    selo: root.querySelector('#roundend-selo')!,
    sala: root.querySelector('#roundend-sala')!,
    destaques: root.querySelector('#roundend-destaques')!,
  };
  built = true;
}

export function renderRoundend(root: HTMLElement, state: RoundendState): void {
  ensureBuilt(root);
  if (!els) return;

  // A tela é desenhada UMA vez por rodada: as animações de entrada (e a contagem dos ganhos)
  // não podem reiniciar 60×/s.
  const chave = `${state.round}:${state.entradas.map((e) => `${e.id}${e.score}`).join(',')}`;
  if (chave === ultimaChave) return;
  ultimaChave = chave;

  const ordenado = [...state.entradas].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const corDoVencedor = state.vencedor ? ordenado.find((e) => e.name === state.vencedor)?.color : undefined;
  els.selo.innerHTML = img(state.vencedor ? ICONE.medalha : ICONE.boom, 'icone-3d');
  els.titulo.innerHTML = state.vencedor
    ? `${corDoVencedor === undefined ? '' : emblemaHtml(corDoVencedor, 'bicho medio')}<b>${state.vencedor}</b> sobreviveu`
    : 'NINGUÉM SOBROU EM PÉ';
  els.sub.textContent = state.vencedor
    ? `RODADA ${state.round} DE ${state.totalRounds} · PRÓXIMO LABIRINTO JÁ`
    : `RODADA ${state.round} DE ${state.totalRounds} · O TEMPO ACABOU`;
  if (els.sala.textContent !== state.roomCode) els.sala.textContent = state.roomCode;

  els.destaques.innerHTML = state.destaques
    .map((d, i) => `<div class="destaque" style="--atraso:${260 + i * 90}ms">${d}</div>`)
    .join('');

  els.lista.innerHTML = ordenado
    .map((e, i) => {
      const antes = ordemAnterior.indexOf(e.id);
      // `delta > 0` = subiu (estava num índice maior). O mesmo número serve para a seta e para o
      // deslize: a linha nasce `delta` alturas ABAIXO do lugar novo e sobe até ele.
      const delta = antes < 0 ? 0 : antes - i;
      const seta =
        delta > 0
          ? `<span class="mov sobe">▲${delta}</span>`
          : delta < 0
            ? `<span class="mov desce">▼${-delta}</span>`
            : '<span class="mov"></span>';
      const ganho = e.ganho > 0 ? `+${e.ganho}` : String(e.ganho);
      const classes = ['linha'];
      if (e.id === state.meId) classes.push('eu');
      if (e.sobreviveu) classes.push('vivo');
      if (delta !== 0) classes.push('mexeu');
      return `<div class="${classes.join(' ')}" style="--cor:${css(e.color)};--atraso:${i * 45}ms;--n:${delta}">
        <span class="faixa"></span>
        <span class="pos">${i + 1}</span>
        ${emblemaHtml(e.color)}
        <span class="nome">${e.name}</span>
        ${e.sobreviveu ? '<span class="tag-vivo">SOBREVIVEU</span>' : ''}
        ${seta}
        <span class="ganho${e.ganho > 0 ? ' bom' : e.ganho < 0 ? ' ruim' : ''}">${ganho}</span>
        <span class="total${e.ganho !== 0 ? ' pulsa' : ''}" data-de="${e.score - e.ganho}" data-para="${e.score}">${e.score - e.ganho}</span>
      </div>`;
    })
    .join('');

  animarTotais(els.lista);
  ordemAnterior = ordenado.map((e) => e.id);
}

/**
 * Conta cada total do valor anterior até o novo. Uma rAF só para a lista inteira.
 *
 * A contagem NÃO começa junto com o painel: ele entra mostrando o placar como estava ANTES da
 * rodada, segura por `ESPERA`, e só então os números sobem e as setas aparecem. Sem essa pausa a
 * mudança acontecia enquanto o jogador ainda estava achando o placar na tela e ele via só o
 * resultado final — "acontece até antes da gente conseguir ver", nas palavras do usuário.
 */
const ESPERA = 900;
const DURACAO = 1400;

function animarTotais(lista: HTMLElement): void {
  cancelAnimationFrame(animacao);
  const alvos = [...lista.querySelectorAll<HTMLElement>('.total')].map((no) => ({
    no,
    de: Number(no.dataset.de ?? '0'),
    para: Number(no.dataset.para ?? '0'),
  }));
  if (alvos.every((a) => a.de === a.para)) return;

  // Enquanto espera, tudo fica no estado ANTIGO: números de antes e setas escondidas.
  lista.classList.remove('revelado');
  for (const a of alvos) a.no.textContent = String(a.de);

  const inicio = performance.now() + ESPERA;
  const passo = (t: number): void => {
    if (t < inicio) {
      animacao = requestAnimationFrame(passo);
      return;
    }
    lista.classList.add('revelado');
    const k = Math.min(1, (t - inicio) / DURACAO);
    const suave = 1 - (1 - k) ** 3;
    for (const a of alvos) {
      const v = String(Math.round(a.de + (a.para - a.de) * suave));
      if (a.no.textContent !== v) a.no.textContent = v;
    }
    if (k < 1) animacao = requestAnimationFrame(passo);
  };
  animacao = requestAnimationFrame(passo);
}

/** Zera o histórico de posições entre partidas (senão a rodada 1 da partida nova herda setas). */
export function resetRoundend(): void {
  cancelAnimationFrame(animacao);
  ordemAnterior = [];
  ultimaChave = '';
}
