// Tela de fim de partida: troféu e nome do vencedor em destaque máximo, pódio dos 3 primeiros,
// ranking completo, títulos de zoeira calculados pelo servidor e botão de jogar de novo.
//
// Fase 8: entram aqui os MELHORES MOMENTOS da partida — as frases de zoeira que saíram do
// killfeed (ver ui/zoeira.ts) —, e sai a linha de créditos: nenhum asset do jogo exige atribuição
// desde que os ícones passaram a ser SVG desenhado em código.

import { emblemaHtml } from '../render/animais.js';
import { ICONE, img } from './icons.js';

export interface ResultEntry {
  id: string;
  name: string;
  color: number;
  position: number; // 1 = vencedor
  score: number;
}

export interface ResultState {
  ranking: ResultEntry[];
  titulos: { titulo: string; jogador: string }[];
  /** Segundos até a próxima partida começar sozinha. `null` esconde a linha (online espera o lobby). */
  proximaPartidaEm: number | null;
  /** Id do jogador local — marca a linha dele no ranking. */
  meId?: string;
  /** Melhores momentos da partida (frases de zoeira), no máximo 3. */
  destaques: string[];
  /**
   * Rótulo do botão principal. Muda com o contexto (Fase 12): online ele leva de volta à tela de
   * entrada para abrir/entrar em outra sala, no treino ele recomeça o treino.
   */
  rotuloReplay?: string;
  /** Rótulo do botão secundário; ausente ou vazio esconde o botão. */
  rotuloVoltar?: string;
}

let built = false;
let els: {
  vencedor: HTMLElement;
  podio: HTMLElement;
  ranking: HTMLElement;
  titulos: HTMLElement;
  destaques: HTMLElement;
  proxima: HTMLElement;
  botao: HTMLButtonElement;
  botaoVoltar: HTMLButtonElement;
} | null = null;

let onReplay: (() => void) | null = null;
let onVoltar: (() => void) | null = null;
let ultimaChave = '';
let ultimaProxima = '';

function css(color: number): string {
  return '#' + (color >>> 0).toString(16).padStart(6, '0');
}

function ensureBuilt(root: HTMLElement): void {
  if (built) return;
  root.innerHTML = `
    <div class="painel-final">
      <div class="rotulo">FIM DE PARTIDA</div>
      <div id="vencedor"></div>
      <div id="podio"></div>
      <div id="resultado-ranking"></div>
      <div id="resultado-titulos"></div>
      <div id="resultado-destaques"></div>
      <!-- Fase 12 secao 3: as acoes ficam GRUDADAS no rodape do painel (position sticky). Em 720p o
           painel enche e o botao caia abaixo da dobra: o jogador via a borda de cima dele, clicava
           e nada acontecia. Agora ele esta sempre na tela, role o painel ou nao. -->
      <div class="acoes-final">
        <button id="btn-jogar-de-novo" type="button" class="botao-jogo grande">JOGAR DE NOVO</button>
        <button id="btn-voltar-entrada" type="button" class="botao-jogo secundario">VOLTAR</button>
        <div id="resultado-proxima"></div>
      </div>
    </div>
  `;
  els = {
    vencedor: root.querySelector('#vencedor')!,
    podio: root.querySelector('#podio')!,
    ranking: root.querySelector('#resultado-ranking')!,
    titulos: root.querySelector('#resultado-titulos')!,
    destaques: root.querySelector('#resultado-destaques')!,
    proxima: root.querySelector('#resultado-proxima')!,
    botao: root.querySelector('#btn-jogar-de-novo')!,
    botaoVoltar: root.querySelector('#btn-voltar-entrada')!,
  };
  els.botao.addEventListener('click', () => onReplay?.());
  els.botaoVoltar.addEventListener('click', () => onVoltar?.());
  built = true;
}

export function setResultReplayHandler(handler: () => void): void {
  onReplay = handler;
}

/** Botão secundário (VOLTAR). Sem handler registrado o botão fica fora de cena. */
export function setResultVoltarHandler(handler: (() => void) | null): void {
  onVoltar = handler;
}

/**
 * Esquece a última tela desenhada. O `renderResult` só redesenha quando o ranking MUDA, e duas
 * partidas seguidas podem terminar com o mesmo placar — sem este reset, a segunda mostraria a
 * árvore da primeira (Fase 12 §3: "não fica nenhum estado velho preso").
 */
export function resetResult(): void {
  ultimaChave = '';
  ultimaProxima = '';
}

export function renderResult(root: HTMLElement, state: ResultState): void {
  ensureBuilt(root);
  if (!els) return;

  // O ranking só muda quando a partida acaba; sem esse guarda a árvore inteira seria recriada
  // 60×/s enquanto a contagem da próxima partida corre embaixo.
  const chave =
    state.ranking.map((r) => `${r.id}:${r.position}:${r.score}`).join('|') +
    `#${state.titulos.length}#${state.destaques.length}`;
  if (chave !== ultimaChave) {
    ultimaChave = chave;
    desenharRanking(els, state);
  }

  const rotulo = state.rotuloReplay ?? 'JOGAR DE NOVO';
  if (els.botao.textContent !== rotulo) els.botao.textContent = rotulo;
  const voltar = state.rotuloVoltar ?? '';
  if (els.botaoVoltar.textContent !== voltar) els.botaoVoltar.textContent = voltar;
  els.botaoVoltar.hidden = voltar === '' || onVoltar === null;

  const proxima = state.proximaPartidaEm === null ? '' : `PRÓXIMA PARTIDA EM ${Math.max(0, Math.ceil(state.proximaPartidaEm))}s`;
  if (proxima !== ultimaProxima) {
    els.proxima.textContent = proxima;
    ultimaProxima = proxima;
  }
}

function desenharRanking(e: NonNullable<typeof els>, state: ResultState): void {
  const ordenado = [...state.ranking].sort((a, b) => a.position - b.position);
  const campeao = ordenado[0];

  // O emblema do campeão entra em tamanho de brasão, ao lado do troféu: é a mesma marca que ficou
  // a partida inteira em cima do tanque dele.
  e.vencedor.innerHTML = campeao
    ? `<div class="trofeu">${img(ICONE.trofeu, 'icone-3d')}</div>
       <div class="faixa">VENCEDOR</div>
       <div class="nome" style="--cor:${css(campeao.color)}">${emblemaHtml(campeao.color, 'bicho brasao')}${campeao.name}</div>
       <div class="pontos"><b>${campeao.score}</b> PONTOS</div>`
    : '';

  const top3 = ordenado.filter((r) => r.position <= 3);
  e.podio.innerHTML = top3
    .map(
      (r) => `
      <div class="lugar p${r.position}" style="--cor:${css(r.color)}">
        <div class="cabeca"><span class="pos">${r.position}º</span>${emblemaHtml(r.color)}<span class="nome">${r.name}</span></div>
        <div class="base"><span class="pts">${r.score}</span></div>
      </div>`,
    )
    .join('');

  e.ranking.innerHTML = ordenado
    .map(
      (r) => `<div class="linha${r.id === state.meId ? ' eu' : ''}" style="--cor:${css(r.color)}">
        <span class="faixa"></span>
        <span class="pos">${r.position}</span>
        ${emblemaHtml(r.color)}
        <span class="nome">${r.name}</span>
        <span class="pts">${r.score}</span>
      </div>`,
    )
    .join('');

  e.titulos.innerHTML = state.titulos
    .map((t) => `<span class="titulo"><b>${t.titulo}</b>${t.jogador}</span>`)
    .join('');

  e.destaques.innerHTML = state.destaques.length
    ? '<div class="rotulo-destaques">MELHORES MOMENTOS</div>' +
      state.destaques.map((d, i) => `<div class="destaque" style="--atraso:${420 + i * 110}ms">${d}</div>`).join('')
    : '';
}
