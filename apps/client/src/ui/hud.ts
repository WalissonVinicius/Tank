// HUD in-game em DOM sobre o canvas.
//
// Forma (Fase 8, apertada na Fase 9): HUD MÍNIMO. Durante a rodada a tela é da ação — saíram de
// cena o placar lateral (foi para a tela de fim de rodada, onde a animação de subida/descida fica
// legível) e o código da sala (lobby + fim de rodada, que é quando alguém atrasado entra). A
// legenda de controles saiu de vez na Fase 9, junto com o botão de tela cheia: "na hora do jogo
// não precisa aparecer os botão, só no lobby". O esquema de teclas mora no lobby.
//
// Fica só o que muda decisão dentro de uma rodada de 45 s: relógio, quantos ainda estão vivos,
// a própria munição, a trilha da rodada e um killfeed enxuto de uma linha por abate.
//
// Fase 10, três mudanças de forma:
//   · RODADA e TEMPO foram refeitos ("tá muito feio"): a trilha de rodada virou ficha + degraus
//     grossos com contorno, e o relógio virou PLACA AMARELA com número escuro — o elemento mais
//     legível da tela depois da arena, e o que fica vermelho e pulsa nos últimos 10 s;
//   · a munição virou UM grupo só. Antes havia o ícone de pente (três cartuchos desenhados) ao
//     lado dos três pips de munição, e o usuário leu isso como "2 tipos de munição" — o ícone
//     saiu, ficaram só os pips, que são os que contam de verdade;
//   · a linguagem visual é de desenho animado: cor chapada, contorno escuro grosso, sombra dura.
//
// Tudo dimensionado em `calc(var(--k) * …)` (ver ui/layout.ts): em 2560×1440 o HUD cresce junto
// com a janela, com teto, em vez de virar um selo no canto.
//
// Desempenho: atualiza por diff — só encosta em `textContent`/classe que mudou.
import { emblemaHtml } from '../render/animais.js';
import { ICONE, img } from './icons.js';
import { nomeColorido, type Ator } from './zoeira.js';

export interface HudState {
  round: number;
  totalRounds: number;
  timeLeft: number;
  /** Quantos tanques ainda estão vivos nesta rodada. */
  vivos: number;
  meName: string;
  ammoAvailable: number;
  ammoMax: number;
  meAlive: boolean;
  reconnecting: boolean;
  /** `true` só na fase `playing`: é o que tira os módulos supérfluos de cena. */
  emAcao: boolean;
  /** Partida de TREINO contra bots (Fase 12 §7) — ganha um selo discreto, para não confundir com partida valendo. */
  treino?: boolean;
}

export type KillfeedTag = 'kill' | 'autogol';

export interface KillfeedEvento {
  tag: KillfeedTag;
  /** Ausente no autogol — lá a vítima é o próprio matador. */
  matador?: Ator;
  vitima: Ator;
}

/** Quanto tempo cada linha do killfeed fica na tela antes de sair sozinha. */
const FEED_VIDA_MS = 4000;
/** Máximo de linhas visíveis ao mesmo tempo — mais que isso vira parede de texto. */
const MAX_FEED = 4;
interface FeedItem {
  html: string;
  tag: KillfeedTag;
  nascido: number;
  seq: number;
}

let built = false;
let els: {
  rodadaNum: HTMLElement;
  pips: HTMLElement;
  timer: HTMLElement;
  timerBarra: HTMLElement;
  relogio: HTMLElement;
  vivos: HTMLElement;
  feedItens: HTMLElement;
  municao: HTMLElement;
  municaoNome: HTMLElement;
  marcas: HTMLElement;
  municaoStatus: HTMLElement;
  eliminado: HTMLElement;
  eliminadoSub: HTMLElement;
  reconectando: HTMLElement;
  treino: HTMLElement;
} | null = null;

let raiz: HTMLElement | null = null;
let lastTimer = '';
let lastRodada = '';
let lastVivos = '';
let lastFeedKey = '';
let lastAmmo = -1;
let lastAmmoMax = -1;
let lastMeAlive: boolean | null = null;
let lastEliminadoSub = '';
let lastReconnecting: boolean | null = null;
let lastBaixo: boolean | null = null;
let lastEmAcao: boolean | null = null;
let lastTreino: boolean | null = null;
/**
 * Maior tempo já visto na rodada atual — é a referência da barra do relógio. Ler daqui em vez de
 * usar ROUND_TIMEOUT fixo faz a barra continuar certa se o servidor encurtar a rodada (o teto
 * escala com o número de jogadores) ou se a morte súbita mexer no relógio.
 */
let tempoBase = 1;
let rodadaDaBase = -1;

const feed: FeedItem[] = [];
let feedSeq = 0;

function ensureBuilt(root: HTMLElement): void {
  if (built) return;
  raiz = root;
  root.innerHTML = `
    <div id="hud-rodada">
      <div class="topo"><span class="lbl">RODADA</span><div class="ficha" id="hud-rodada-num"></div></div>
      <div class="pips" id="hud-pips"></div>
    </div>

    <div id="hud-relogio">
      <div class="placa-tempo">
        <span class="lbl">TEMPO</span>
        <div class="timer" id="hud-timer">0:00</div>
        <div class="barra"><i id="hud-timer-barra"></i></div>
      </div>
      <div class="vivos" id="hud-vivos"></div>
    </div>

    <div id="hud-feed"></div>

    <!-- UM grupo de marcas, e só. O ícone de pente que ficava ao lado saiu na Fase 10: ele
         desenhava três cartuchos, os pips desenhavam outros três, e a leitura virava
         "dois tipos de munição". -->
    <div id="hud-municao">
      <div class="topo"><span class="lbl">MUNIÇÃO</span><b id="hud-municao-nome"></b></div>
      <div class="marcas" id="hud-marcas"></div>
      <div class="status" id="hud-municao-status"></div>
    </div>

    <div id="hud-eliminado">
      ${img(ICONE.caveira, 'icone-3d')}
      <div class="texto">
        <div class="titulo">ELIMINADO</div>
        <div class="sub" id="hud-eliminado-sub">volta na próxima rodada</div>
      </div>
    </div>

    <div id="hud-reconectando">RECONECTANDO<i>…</i></div>

    <!-- Selo de treino: canto discreto, fora do caminho do relógio e da munição. -->
    <div id="hud-treino" hidden>TREINO</div>
  `;

  els = {
    rodadaNum: root.querySelector('#hud-rodada-num')!,
    pips: root.querySelector('#hud-pips')!,
    timer: root.querySelector('#hud-timer')!,
    timerBarra: root.querySelector('#hud-timer-barra')!,
    relogio: root.querySelector('#hud-relogio')!,
    vivos: root.querySelector('#hud-vivos')!,
    feedItens: root.querySelector('#hud-feed')!,
    municao: root.querySelector('#hud-municao')!,
    municaoNome: root.querySelector('#hud-municao-nome')!,
    marcas: root.querySelector('#hud-marcas')!,
    municaoStatus: root.querySelector('#hud-municao-status')!,
    eliminado: root.querySelector('#hud-eliminado')!,
    eliminadoSub: root.querySelector('#hud-eliminado-sub')!,
    reconectando: root.querySelector('#hud-reconectando')!,
    treino: root.querySelector('#hud-treino')!,
  };
  built = true;
}

/**
 * Killfeed mínimo: `Matador ✕ Vítima`, cada nome na cor do jogador, bala no meio. Autogol vira
 * `Fulano ✕ ele mesmo` na cor de alerta. Uma linha por evento — as frases longas de zoeira
 * migraram para o fim de rodada e a tela de vencedor (ver ui/zoeira.ts).
 */
export function pushKillfeed(ev: KillfeedEvento): void {
  // Fase 11: cada nome vem com o EMBLEMA DO ANIMAL na frente. No meio de um tiroteio ninguém lê
  // quatro nomes de 6 letras — mas reconhece o bicho, que é a mesma marca que está sobre o tanque.
  const ator = (p: Ator): string => `${emblemaHtml(p.color)}${nomeColorido(p)}`;
  const alvo = ev.tag === 'autogol' ? '<i class="ele-mesmo">ele mesmo</i>' : ator(ev.vitima);
  const origem = ev.tag === 'autogol' ? ator(ev.vitima) : ator(ev.matador ?? ev.vitima);
  const html = `<span class="quem">${origem}</span>${img(ev.tag === 'autogol' ? ICONE.boom : ICONE.bala, 'marca')}<span class="quem alvo">${alvo}</span>`;
  feed.push({ html, tag: ev.tag, nascido: performance.now(), seq: feedSeq++ });
  while (feed.length > MAX_FEED) feed.shift();
  desenharFeed();
}

export function resetKillfeed(): void {
  feed.length = 0;
  desenharFeed();
}

/**
 * Sincroniza o feed nó a nó em vez de reescrever o `innerHTML`: recriar a lista inteira faria a
 * animação de entrada disparar de novo em TODAS as linhas a cada abate, e o feed piscaria junto.
 * Aqui só o nó novo entra (e anima) e só o nó expirado sai.
 */
function desenharFeed(): void {
  if (!els) return;
  const chave = feed.map((f) => f.seq).join(',');
  if (chave === lastFeedKey) return;
  lastFeedKey = chave;

  const vivos = new Set(feed.map((f) => String(f.seq)));
  for (const nó of [...els.feedItens.children]) {
    if (!vivos.has((nó as HTMLElement).dataset.seq ?? '')) nó.remove();
  }
  for (const f of feed) {
    if (els.feedItens.querySelector(`[data-seq="${f.seq}"]`)) continue;
    const item = document.createElement('div');
    item.className = `item ${f.tag}`;
    item.dataset.seq = String(f.seq);
    item.innerHTML = f.html;
    els.feedItens.appendChild(item);
  }
}

/** Tira do feed as linhas que já passaram do tempo. Chamado uma vez por frame. */
function expirarFeed(agora: number): void {
  const antes = feed.length;
  for (let i = feed.length - 1; i >= 0; i--) {
    if (agora - feed[i]!.nascido > FEED_VIDA_MS) feed.splice(i, 1);
  }
  if (feed.length !== antes) desenharFeed();
}

/**
 * Trilha da rodada. Fase 10: os pips eram tiras finas e apagadas que juntas viravam "uma barra
 * cinza" no canto. Agora são DEGRAUS grossos com contorno escuro — vencido é amarelo cheio, o
 * atual é branco e pulsa, o que falta é vazado. Some a ficha com o número gordo ao lado, para
 * quem prefere ler o número a contar degrau.
 */
function desenharPips(total: number, atual: number): void {
  if (!els) return;
  const chave = `${atual}/${total}`;
  if (chave === lastRodada) return;
  lastRodada = chave;
  els.rodadaNum.innerHTML = `<b>${atual}</b><span>/${total}</span>`;
  els.pips.innerHTML = Array.from({ length: total }, (_, i) => {
    const estado = i + 1 < atual ? 'feito' : i + 1 === atual ? 'agora' : '';
    return `<i class="${estado}"></i>`;
  }).join('');
}

export function renderHud(root: HTMLElement, state: HudState): void {
  ensureBuilt(root);
  if (!els) return;
  const agora = performance.now();

  desenharPips(state.totalRounds, state.round);

  const treino = state.treino === true;
  if (treino !== lastTreino) {
    els.treino.hidden = !treino;
    lastTreino = treino;
  }

  const tt = Math.max(0, state.timeLeft);
  const timerLabel = tt >= 60 ? `${Math.floor(tt / 60)}:${String(Math.ceil(tt % 60) % 60).padStart(2, '0')}` : String(Math.ceil(tt));
  if (timerLabel !== lastTimer) {
    els.timer.textContent = timerLabel;
    lastTimer = timerLabel;
  }
  // Só a RODADA fica em estado crítico. Sem o `emAcao`, os 3 s da contagem regressiva (que usam
  // o mesmo campo `timeLeft`) deixavam a placa vermelha e pulsando antes de o jogo começar,
  // avisando de um fim de tempo que ainda nem tinha relógio.
  const baixo = state.emAcao && tt <= 10;
  if (baixo !== lastBaixo) {
    els.relogio.classList.toggle('baixo', baixo);
    lastBaixo = baixo;
  }
  if (state.round !== rodadaDaBase) {
    rodadaDaBase = state.round;
    tempoBase = Math.max(1, tt);
  } else if (tt > tempoBase) {
    tempoBase = tt;
  }
  els.timerBarra.style.transform = `scaleX(${Math.min(1, tt / tempoBase)})`;

  if (state.emAcao !== lastEmAcao) {
    raiz?.classList.toggle('em-acao', state.emAcao);
    lastEmAcao = state.emAcao;
  }

  const vivosLabel = `${state.vivos} VIVOS`;
  if (vivosLabel !== lastVivos) {
    els.vivos.textContent = vivosLabel;
    lastVivos = vivosLabel;
  }

  if (els.municaoNome.textContent !== state.meName) els.municaoNome.textContent = state.meName;

  if (state.ammoMax !== lastAmmoMax) {
    els.marcas.innerHTML = Array.from({ length: state.ammoMax }, () => '<i></i>').join('');
    lastAmmoMax = state.ammoMax;
    lastAmmo = -1;
  }
  if (state.ammoAvailable !== lastAmmo) {
    [...els.marcas.children].forEach((m, i) => m.classList.toggle('gasta', i >= state.ammoAvailable));
    lastAmmo = state.ammoAvailable;
  }

  if (state.meAlive !== lastMeAlive) {
    els.municao.classList.toggle('morto', !state.meAlive);
    els.eliminado.classList.toggle('ativa', !state.meAlive);
    lastMeAlive = state.meAlive;
  }
  // Recarregando (zero balas prontas) muda a cor do MESMO bloco, em vez de acrescentar um
  // segundo indicador ao lado — foi o segundo grupo que confundiu o usuário na Fase 9.
  els.municao.classList.toggle('recarregando', state.meAlive && state.ammoAvailable === 0);
  if (!state.meAlive) {
    const sub = `volta na próxima rodada · ${Math.ceil(tt)}s`;
    if (sub !== lastEliminadoSub) {
      els.eliminadoSub.textContent = sub;
      lastEliminadoSub = sub;
    }
  }
  const statusLabel = !state.meAlive
    ? 'ELIMINADO'
    : state.ammoAvailable === 0
      ? 'RECARREGANDO…'
      : `${state.ammoAvailable} DE ${state.ammoMax} PRONTAS`;
  if (els.municaoStatus.textContent !== statusLabel) els.municaoStatus.textContent = statusLabel;

  if (state.reconnecting !== lastReconnecting) {
    els.reconectando.classList.toggle('ativa', state.reconnecting);
    lastReconnecting = state.reconnecting;
  }

  expirarFeed(agora);
}
