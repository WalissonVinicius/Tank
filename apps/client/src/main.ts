import './style.css';
import {
  COUNTDOWN,
  isRoomCode,
  MAX_BULLETS,
  MAX_BULLETS_BY_PLAYERS,
  normalizeRoomCode,
  PLAYER_COLORS,
  ROOM_CODE_LENGTH,
  ROUNDS,
  ROUND_TIMEOUT,
  SNAPSHOT_HZ,
  TEST_PLAYER_NAMES,
  TICK_HZ,
} from '@tank/protocol';
import type {
  BulletDeadMsg,
  BulletSpawnMsg,
  GameOverMsg,
  RoundEndMsg,
  RoundStartMsg,
  SuddenDeathWallMsg,
  TankDeathMsg,
} from '@tank/protocol';
import { makeBot, makeMaze, mulberry32, spawnPoints, step } from '@tank/shared-sim';
import type { Bot, Input, Maze, SimEvent, SimState, Tank, Vec2 } from '@tank/shared-sim';

import { desbloquearAudioNoPrimeiroGesto, setAudioAtivo, tocar } from './audio.js';
import { criarContagemSonora } from './somDoTempo.js';
import { createControls } from './input/controls.js';
import { BulletPredictor } from './net/bullets.js';
import { NetClient } from './net/client.js';
import { InterpolationBuffer } from './net/interpolation.js';
import type { SnapshotTank } from './net/snapshot.js';
import { renderCountdown, resetCountdown } from './ui/countdown.js';
import { iniciarTelaCheia } from './ui/fullscreen.js';
import { pushKillfeed, renderHud, resetKillfeed, type HudState } from './ui/hud.js';
import {
  destaqueAutogol,
  destaqueDuplo,
  destaqueKill,
  fraseEmpate,
  melhoresDestaques,
  type Destaque,
} from './ui/zoeira.js';
import {
  renderEntrada,
  renderLobby,
  renderSalasAbertas,
  setLobbyBotHandler,
  setLobbyCorHandler,
  setLobbyDigitouHandler,
  focarCampoNome,
  setLobbyEntradaHandler,
  setLobbyReadyHandler,
  setLobbySalaHandler,
  setLobbyTreinoHandler,
  type AcaoEntrada,
  type LobbyPlayer,
} from './ui/lobby.js';
import { renderPausa, setPausaHandlers } from './ui/pausa.js';
import { MonitorDeSalas } from './net/salas.js';
import {
  renderResult,
  resetResult,
  setResultReplayHandler,
  setResultVoltarHandler,
  type ResultEntry,
  type ResultState,
} from './ui/result.js';
import { renderRoundend, resetRoundend, type RoundendEntry } from './ui/roundend.js';
import { Vitrine } from './ui/vitrine.js';
import { Renderer } from './render/Renderer.js';
import type { RenderView } from './render/Renderer.js';

type TelaId = 'lobby' | 'hud' | 'roundend' | 'result';

interface Telas {
  lobby: HTMLElement;
  hud: HTMLElement;
  roundend: HTMLElement;
  result: HTMLElement;
}

/**
 * Elementos que ficam POR CIMA das telas em vez de substituí-las (a contagem regressiva precisa
 * da arena e do HUD visíveis atrás dela), mais o container do canvas — que é o alvo dos cliques
 * de tiro, para que clicar num botão do HUD não dispare.
 */
interface Camadas {
  contagem: HTMLElement;
  game: HTMLElement;
  /** Menu de pausa (Fase 13 §1) — também por cima, e é ele que segura os cliques quando aberto. */
  pausa: HTMLElement;
}

/** Quanto tempo o "VAI!" fica na tela depois que a contagem zera — casa com `contagem-vai` no CSS. */
const VAI_MS = 900;

function css(color: number): string {
  return '#' + (color >>> 0).toString(16).padStart(6, '0');
}

/** Cor guardada no navegador (`tank:cor`), 0 quando não há nenhuma ou o valor saiu da paleta. */
function corPreferidaSalva(): number {
  try {
    const bruto = Number(localStorage.getItem('tank:cor'));
    return PLAYER_COLORS.includes(bruto) ? bruto : 0;
  } catch {
    return 0; // modo privado
  }
}

function guardarCorPreferida(cor: number): void {
  try {
    localStorage.setItem('tank:cor', String(cor));
  } catch {
    // idem
  }
}

function showErro(msg: string): void {
  const el = document.getElementById('erro');
  if (!el) return;
  el.style.display = 'block';
  el.textContent += msg + '\n';
}

function setTela(telas: Telas, ativa: TelaId): void {
  (Object.keys(telas) as TelaId[]).forEach((k) => telas[k].classList.toggle('ativa', k === ativa));
  // Fora do jogo a arena continua rodando atrás da tela; o CSS a desfoca e escurece para virar
  // fundo em vez de competir com a leitura (ver `#app.fundo-vivo` em style.css).
  document.getElementById('app')?.classList.toggle('fundo-vivo', ativa === 'lobby' || ativa === 'result');
  // Fase 9: com a arena em cena (contagem + rodada) some todo botão de canto — inclusive o de
  // tela cheia, que vive FORA das `.tela` e por isso não sai sozinho. Só a marca no `<body>`
  // muda; o atalho `F` continua ligado o tempo todo (ver `ui/fullscreen.ts`).
  document.body.classList.toggle('em-jogo', ativa === 'hud');
}

// Sonda de depuração, ligada só com `?debug=1` na URL: publica em `window.__tank` exatamente o
// que este cliente está desenhando neste frame. É como o teste de integração compara duas abas
// (posição de tanque, posição de bala, placar) sem depender de ler pixels. Sem a flag nada é
// exposto e o custo é zero.
export interface DebugSnapshot {
  /**
   * Relógio de parede (Date.now()) do frame que publicou. Tem que ser Date.now() e não
   * performance.now(): a origem do performance.now() é o carregamento de CADA aba, então duas
   * abas abertas com 1 s de diferença teriam relógios deslocados em 1 s e comparar as duas
   * viraria bobagem.
   */
  t: number;
  fase: string;
  sala: string;
  round: number;
  me: string;
  tanks: RenderView['tanks'];
  bullets: { id: string; ownerId: string; x: number; y: number }[];
  placar: { id: string; name: string; score: number; alive: boolean }[];
  /**
   * Ângulo de mira (rad) que os controles calcularam a partir do cursor neste frame — a ENTRADA
   * que o `step()` usa para girar a torre. Exposto para o teste de controles conseguir comparar
   * "para onde o mouse aponta" com "para onde a torre virou" sem refazer a matemática da câmera.
   */
  aim?: number;
}

function publicarDebug(ativo: boolean, snap: DebugSnapshot): void {
  if (!ativo) return;
  (window as unknown as { __tank?: DebugSnapshot }).__tank = snap;
}

// ---------- áudio (zzfx) ----------
const SOM_TIRO = [1.1, 0, 380, 0, 0.02, 0.05, 1, 1.4, 0, 0, 0, 0, 0, 0.2, 0, 0, 0, 0.4, 0.01] as const;
const SOM_RICOCHETE = [0.9, 0.1, 620, 0, 0.015, 0.04, 2, 2.1, -30, 0, 0, 0, 0, 0.3, 0, 0.1, 0, 0.5, 0.01] as const;
const SOM_MORTE = [1.4, 0, 90, 0.02, 0.14, 0.28, 4, 1.8, 0, 0, 0, 0, 0.06, 0.5, 0, 0.3, 0, 0.4, 0.14] as const;
const SOM_AUTOGOL = [1.4, 0.2, 60, 0.02, 0.2, 0.35, 4, 2.4, -8, 0, 0, 0, 0.08, 0.6, 0, 0.4, 0, 0.3, 0.2] as const;
const SOM_ESTOURO_BALA = [0.9, 0.05, 160, 0.01, 0.06, 0.12, 4, 1.6, -4, 0, 0, 0, 0.03, 0.4, 0, 0.2, 0, 0.45, 0.06] as const;
const SOM_BIPE = [0.7, 0, 440, 0.01, 0.05, 0.08, 0, 1.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0.02] as const;
const SOM_VAI = [1, 0, 880, 0.01, 0.09, 0.14, 0, 1.6, 0, 0, 220, 0.04, 0, 0, 0, 0, 0, 0.7, 0.02] as const;

// Contagem sonora dos últimos 10 s (Fase 10 §4). A regra mora em `somDoTempo.ts`, fora daqui,
// porque os dois modos precisam dela idêntica e porque assim ela é testável sem navegador.
// Uma instância por aba: os modos local e online nunca rodam ao mesmo tempo.
const contagemSonora = criarContagemSonora((som) => void tocar(som));

// O ciclo de vida do AudioContext (singleton, suspend/close) mora em `audio.ts` — ver §5 da
// Fase 8: cada carga da página deixava um contexto vivo e o áudio de OUTRAS páginas parava.

// ---------- estado de partida local ----------
interface MatchPlayer {
  id: string;
  name: string;
  color: number;
  score: number;
  kills: number;
  deaths: number;
  selfKills: number;
  /** Estatísticas de partida usadas só pelos títulos de zoeira do fim (espelham `MatchTitleStats` do servidor). */
  shotsFired: number;
  shotsHit: number;
  aliveSeconds: number;
  isBot: boolean;
  bot?: Bot;
}

type FaseLocal = 'countdown' | 'playing' | 'roundend' | 'gameover';

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function maxBulletsFor(n: number): number {
  const clamped = Math.min(10, Math.max(2, Math.round(n)));
  return MAX_BULLETS_BY_PLAYERS[clamped] ?? MAX_BULLETS;
}

function nearestAliveTarget(tank: Tank, tanks: Map<string, Tank>, maze: Maze): Vec2 {
  let best: Tank | null = null;
  let bestDist = Infinity;
  for (const other of tanks.values()) {
    if (other.id === tank.id || !other.alive) continue;
    const d = (other.x - tank.x) ** 2 + (other.y - tank.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = other;
    }
  }
  if (best) return { x: best.x, y: best.y };
  return { x: (maze.cols * maze.cell) / 2, y: (maze.rows * maze.cell) / 2 };
}

async function runLocalMode(params: URLSearchParams, renderer: Renderer, telas: Telas, camadas: Camadas): Promise<void> {
  const seed = Number(params.get('seed')) || 1;
  const total = clamp(Number(params.get('bots')) || 6, 2, 10);
  // Fase 12 §7: `?treino=1` é a MESMA partida local, só marcada como treino — muda o selo do HUD
  // e os botões do fim, nada da simulação. Sem a marca (`?local=1` puro) continua sendo o modo de
  // desenvolvimento de sempre.
  const treino = params.has('treino');
  // Override só de teste (`?rodadas=2`): permite provar a tela de fim de partida sem jogar as 10
  // rodadas de verdade. Sem o parâmetro vale `ROUNDS`, que continua 10.
  const totalRodadas = clamp(Number(params.get('rodadas')) || ROUNDS, 1, ROUNDS);

  // Offline não há sala nem servidor para arbitrar a cor, mas a preferência guardada no lobby
  // online continua valendo: o humano fica com ela e os bots pegam as que sobraram, na ordem.
  const corSalva = corPreferidaSalva();
  const paletaLocal = corSalva ? [corSalva, ...PLAYER_COLORS.filter((c) => c !== corSalva)] : PLAYER_COLORS;

  // O nome escolhido na tela de entrada vale no treino também (Fase 12 §7). Sem nome guardado
  // continua sendo "Você", que é o que o modo local sempre mostrou.
  const meuNome =
    (params.get('nome') ?? (() => {
      try { return localStorage.getItem('tank:nome'); } catch { return null; }
    })())?.trim() || 'Você';

  const novoJogador = (i: number): MatchPlayer => ({
    id: `p${i}`,
    name: i === 0 ? meuNome : (TEST_PLAYER_NAMES[i % TEST_PLAYER_NAMES.length] ?? `Bot ${i}`),
    color: paletaLocal[i % paletaLocal.length]!,
    score: 0,
    kills: 0,
    deaths: 0,
    selfKills: 0,
    shotsFired: 0,
    shotsHit: 0,
    aliveSeconds: 0,
    isBot: i !== 0,
  });

  const players: MatchPlayer[] = Array.from({ length: total }, (_, i) => novoJogador(i));
  const playersById = new Map(players.map((p) => [p.id, p]));
  // Dono de cada bala em voo. O evento de estouro traz só o id da bala, e a essa altura ela já
  // saiu de `state.bullets` — sem este registro a explosão não teria de que cor ser.
  const bulletOwners = new Map<string, string>();
  const meId = players[0]!.id;
  const ammoMax = maxBulletsFor(total);

  const controls = createControls({
    fireTarget: camadas.game,
    screenToWorld: (x, y) => renderer.screenToWorld(x, y),
  });
  const debug = params.has('debug');
  desbloquearAudioNoPrimeiroGesto();

  let round = 1;
  let fase: FaseLocal = 'countdown';
  let countdownLeft = COUNTDOWN;
  let roundTimeLeft = ROUND_TIMEOUT;
  let roundendLeft = 3;
  let proximaPartidaEm = 6;
  let vaiAte = 0;
  let ultimoAim: number | undefined;
  let eliminationOrder: string[] = [];
  let state: SimState;
  let vencedorRodadaId: string | null = null;
  // Pontuação de cada um no INÍCIO da rodada: é a diferença para o fim que a tela de fim de
  // rodada mostra como "ganho" (inclui os +1 por abate creditados durante a rodada).
  let scoreInicioRodada = new Map<string, number>();
  let entradasRodada: RoundendEntry[] = [];
  // As frases de zoeira saíram do killfeed (Fase 8 §3): ficam guardadas aqui e reaparecem na tela
  // de fim de rodada (1 ou 2) e na de vencedor (as 3 melhores da partida inteira).
  let destaquesRodada: Destaque[] = [];
  const destaquesPartida: Destaque[] = [];
  let destaquesDaTela: string[] = [];

  function novaRodada(): void {
    // Sem servidor no modo local não há com quem combinar a proporção: quem decide é esta aba, e
    // decide UMA vez, no início da rodada. Redimensionar no meio do jogo não regenera o labirinto
    // — o formato novo entra na rodada seguinte, como no online.
    const maze = makeMaze(seed + round - 1, total, renderer.aspectoDaArena());
    const roundRng = mulberry32(seed + round * 104729);
    const spawns = spawnPoints(maze, total, roundRng);

    const tanks = new Map<string, Tank>();
    players.forEach((p, i) => {
      const spawn = spawns[i]!;
      const heading = roundRng.next() * Math.PI * 2;
      tanks.set(p.id, { id: p.id, x: spawn.x, y: spawn.y, heading, turret: heading, alive: true, fireCooldownLeft: 0 });
      // Mesma IA que o servidor usa (@tank/shared-sim/bot.ts): navegação por BFS quando não há
      // linha de visão, mira/tiro quando há. Antes o pathing morava aqui e os bots do servidor
      // ficavam presos na parede — agora existe uma implementação só.
      if (p.isBot) p.bot = makeBot(mulberry32(seed + round * 104729 + i * 7919 + 1));
    });

    state = { tick: 0, maze, tanks, bullets: [], nextBulletId: 0 };
    bulletOwners.clear();
    renderer.setMaze(maze);
    eliminationOrder = [];
    vencedorRodadaId = null;
    scoreInicioRodada = new Map(players.map((p) => [p.id, p.score]));
    destaquesRodada = [];
    countdownLeft = COUNTDOWN;
    roundTimeLeft = ROUND_TIMEOUT;
    fase = 'countdown';
    resetKillfeed();
    resetCountdown();
    setTela(telas, 'hud');
  }

  function reiniciarPartida(): void {
    resetRoundend();
    // Sem isto, duas partidas terminadas com o MESMO placar reaproveitariam a árvore desenhada da
    // primeira (o `renderResult` só redesenha quando a chave do ranking muda).
    resetResult();
    destaquesPartida.length = 0;
    for (const p of players) {
      p.score = 0;
      p.kills = 0;
      p.deaths = 0;
      p.selfKills = 0;
      p.shotsFired = 0;
      p.shotsHit = 0;
      p.aliveSeconds = 0;
    }
    round = 1;
    novaRodada();
  }

  setResultReplayHandler(reiniciarPartida);
  // No treino o fim de partida oferece as duas saídas (Fase 12 §7); no modo local de
  // desenvolvimento continua só o "jogar de novo" de sempre.
  setResultVoltarHandler(treino ? () => location.assign(location.pathname) : null);

  // Menu de pausa (Fase 13 §1). Offline não há ninguém esperando, então `Esc` pausa DE VERDADE:
  // o laço fixo abaixo simplesmente não avança enquanto o menu está aberto.
  let menuAberto = false;
  window.addEventListener('keydown', (ev) => {
    if (ev.code !== 'Escape') return;
    ev.preventDefault();
    menuAberto = !menuAberto;
  });
  setPausaHandlers(
    () => {
      menuAberto = false;
    },
    () => location.assign(location.pathname),
  );

  const corDaBala = (ownerId: string | undefined): number =>
    (ownerId ? playersById.get(ownerId)?.color : undefined) ?? 0xffb347;

  function guardarDestaque(d: Destaque): void {
    destaquesRodada.push(d);
    destaquesPartida.push(d);
  }

  function processarEventos(events: SimEvent[], ownerHasBounced: Set<string>): void {
    const deathEvents = events.filter((e): e is Extract<SimEvent, { type: 'death' }> => e.type === 'death');

    for (const ev of events) {
      if (ev.type === 'shot') {
        const p = playersById.get(ev.ownerId);
        bulletOwners.set(ev.bulletId, ev.ownerId);
        if (p) p.shotsFired += 1;
        renderer.onShot(ev.x, ev.y, ev.angle, p?.color ?? 0xffffff);
        void tocar(SOM_TIRO);
      } else if (ev.type === 'bounce') {
        renderer.onBounce(ev.x, ev.y);
        void tocar(SOM_RICOCHETE);
      } else if (ev.type === 'bullet_expired') {
        // Só o fim de vida explode; morrer na parede depois do último ricochete segue silencioso.
        if (ev.reason === 'life') {
          renderer.onBulletExplode(ev.x, ev.y, corDaBala(bulletOwners.get(ev.bulletId)));
          void tocar(SOM_ESTOURO_BALA);
        }
        bulletOwners.delete(ev.bulletId);
      } else if (ev.type === 'bullet_clash') {
        renderer.onBulletExplode(ev.x, ev.y, corDaBala(bulletOwners.get(ev.aId)), 1.45);
        void tocar(SOM_ESTOURO_BALA);
        bulletOwners.delete(ev.aId);
        bulletOwners.delete(ev.bId);
      } else if (ev.type === 'death') {
        const victim = playersById.get(ev.victimId);
        if (!victim) continue;
        renderer.onDeath(ev.x, ev.y, victim.color);
        renderer.addTrauma(ev.autogol ? 0.4 : 0.55);
        renderer.hitstop(60);
        void tocar(ev.autogol ? SOM_AUTOGOL : SOM_MORTE);

        victim.deaths += 1;
        eliminationOrder.push(ev.victimId);
        const atirador = playersById.get(ev.killerId);
        if (atirador) atirador.shotsHit += 1;

        if (ev.autogol) {
          victim.selfKills += 1;
          victim.score = Math.max(0, victim.score - 1);
          pushKillfeed({ tag: 'autogol', vitima: victim });
          guardarDestaque(destaqueAutogol(victim));
          continue;
        }

        const killer = playersById.get(ev.killerId);
        if (killer) {
          killer.score += 1;
          killer.kills += 1;
        }

        if (killer) pushKillfeed({ tag: 'kill', matador: killer, vitima: victim });

        const mutuo = deathEvents.find((other) => other !== ev && other.killerId === ev.victimId && other.victimId === ev.killerId);
        if (mutuo && killer) {
          guardarDestaque(destaqueDuplo(killer, victim));
        } else if (killer) {
          guardarDestaque(destaqueKill(killer, victim, ownerHasBounced.has(killer.id)));
        }
      }
    }
  }

  // Mesma regra do servidor (`roundLoop.ts`, decisão confirmada do usuário): a rodada distribui
  // pontos por ordem de eliminação — primeira morte 1 ponto, último vivo `total` — somados aos
  // +1 por abate / −1 por autogol já creditados durante a rodada. Ninguém zera.
  function encerrarRodada(empate: boolean): void {
    // `empate` aqui é exatamente "o relógio zerou" (quem chama passa `false` quando sobrou um
    // vivo). É o único instante em que a buzina de fim de tempo faz sentido.
    if (empate) contagemSonora.fimDoTempo();
    fase = 'roundend';
    roundendLeft = 3;

    const naoEliminados = [...state.tanks.values()].filter((t) => t.alive).map((t) => t.id);
    vencedorRodadaId = !empate && naoEliminados.length === 1 ? naoEliminados[0]! : null;
    // Sem nenhuma morte na rodada a piada é justamente essa: ninguém saiu de trás da parede.
    destaquesDaTela = destaquesRodada.length ? melhoresDestaques(destaquesRodada, 2) : [fraseEmpate()];

    eliminationOrder.forEach((id, i) => {
      playersById.get(id)!.score += i + 1;
    });
    for (const id of naoEliminados) {
      playersById.get(id)!.score += total;
    }

    const sobreviventes = new Set(naoEliminados);
    entradasRodada = players.map(
      (p): RoundendEntry => ({
        id: p.id,
        name: p.name,
        color: p.color,
        score: p.score,
        ganho: p.score - (scoreInicioRodada.get(p.id) ?? 0),
        sobreviveu: sobreviventes.has(p.id),
      }),
    );
  }

  novaRodada();

  const acumulador = { valor: 0 };
  let ultimoFrame = performance.now();
  const dt = 1 / TICK_HZ;

  function frame(agora: number): void {
    let delta = (agora - ultimoFrame) / 1000;
    ultimoFrame = agora;
    // Clamp bem generoso (não os 0.25s clássicos): captura headless com --virtual-time-budget
    // entrega pouquíssimos rAF reais (às vezes só 1) para vários segundos de tempo virtual — um
    // clamp apertado deixaria a simulação praticamente parada no screenshot. 60s de teto é
    // barato (poucos milhares de ticks de `step()`, roda em milissegundos) e só existe para não
    // rodar ticks demais se a aba ficar em segundo plano por muito tempo.
    delta = Math.min(delta, 60);
    // Com o menu aberto o tempo não corre: sem isto o acumulador guardaria os segundos parados e
    // a partida daria um salto de vários ticks no instante em que o menu fechasse.
    acumulador.valor += menuAberto ? 0 : delta;

    while (acumulador.valor >= dt) {
      acumulador.valor -= dt;

      if (fase === 'countdown') {
        countdownLeft -= dt;
        // Ninguém anda nem atira durante a contagem: `step()` só é chamado na fase `playing`.
        // A leitura aqui existe só para DESCARTAR um clique feito durante a contagem — sem ela
        // a borda de tiro ficaria guardada e sairia um disparo de graça no instante do "VAI!".
        controls.read(null);
        if (countdownLeft <= 0) {
          fase = 'playing';
          vaiAte = agora + VAI_MS;
        }
      } else if (fase === 'playing') {
        const inputs = new Map<string, Input>();
        for (const p of players) {
          const tank = state.tanks.get(p.id)!;
          if (!tank.alive) continue;
          p.aliveSeconds += dt;
          if (p.isBot && p.bot) {
            const target = nearestAliveTarget(tank, state.tanks, state.maze);
            inputs.set(p.id, p.bot.think(tank, target, state.maze, state.tick, { bullets: state.bullets }));
          } else if (!p.isBot) {
            const meu = controls.read(tank);
            ultimoAim = meu.aim;
            inputs.set(p.id, meu);
          }
        }

        const ownerHasBounced = new Set<string>();
        for (const b of state.bullets) if (b.bounces > 0) ownerHasBounced.add(b.ownerId);

        const events = step(state, inputs, dt);
        state.tick++;
        processarEventos(events, ownerHasBounced);

        roundTimeLeft -= dt;
        const aliveCount = [...state.tanks.values()].filter((t) => t.alive).length;
        if (aliveCount <= 1) encerrarRodada(false);
        else if (roundTimeLeft <= 0) encerrarRodada(true);
      } else if (fase === 'roundend') {
        roundendLeft -= dt;
        if (roundendLeft <= 0) {
          round += 1;
          if (round > totalRodadas) {
            fase = 'gameover';
            proximaPartidaEm = 15;
            setTela(telas, 'result');
          } else {
            novaRodada();
          }
        }
      } else if (fase === 'gameover') {
        proximaPartidaEm -= dt;
        if (proximaPartidaEm <= 0) reiniciarPartida();
      }
    }

    const emJogo = fase === 'countdown' || fase === 'playing';
    const view: RenderView = {
      tanks: [...state.tanks.values()].map((t) => ({
        id: t.id,
        x: t.x,
        y: t.y,
        angle: t.heading,
        turret: t.turret,
        color: playersById.get(t.id)!.color,
        alive: t.alive,
        name: playersById.get(t.id)!.name,
      })),
      // Fora da rodada o `step()` não roda mais, mas as balas que estavam em voo continuavam em
      // `state.bullets` — e ficavam PARADAS no ar durante a tela de fim de rodada (3 s) ou de fim
      // de partida (15 s). Medido na Fase 6: era isso que fazia a bala parecer viver muito mais do
      // que os 3 s de BULLET_LIFE. Fora de jogo, nenhuma bala vai para a tela.
      bullets: emJogo ? state.bullets.map((b) => ({ x: b.x, y: b.y, color: playersById.get(b.ownerId)?.color })) : [],
      me: meId,
    };
    renderer.sync(view);

    const ponteiro = controls.pointer;
    renderer.setCrosshair(ponteiro?.x ?? 0, ponteiro?.y ?? 0, emJogo && ponteiro !== null);
    // Ache o seu tanque (Fase 11): o Renderer recebe só o relógio da contagem e cuida sozinho do
    // zoom, do anel, da seta e do esmaecimento dos adversários.
    renderer.setLargada(fase === 'countdown' ? countdownLeft : null);

    const mostrandoVai = agora < vaiAte;
    if (
      renderCountdown(camadas.contagem, {
        restante: fase === 'countdown' ? countdownLeft : null,
        vai: mostrandoVai,
      })
    ) {
      renderer.addTrauma(mostrandoVai ? 0.32 : 0.06);
      void tocar(mostrandoVai ? SOM_VAI : SOM_BIPE);
    }

    renderPausa(camadas.pausa, { aberto: menuAberto, modo: 'treino' });

    setAudioAtivo(emJogo && !menuAberto);
    contagemSonora.acompanhar(roundTimeLeft, fase === 'playing');

    if (emJogo) {
      const meTank = state.tanks.get(meId)!;
      const meBullets = state.bullets.filter((b) => b.ownerId === meId).length;
      const hudState: HudState = {
        round,
        totalRounds: totalRodadas,
        timeLeft: fase === 'countdown' ? countdownLeft : roundTimeLeft,
        vivos: [...state.tanks.values()].filter((t) => t.alive).length,
        meName: playersById.get(meId)!.name,
        ammoAvailable: meTank.alive ? ammoMax - meBullets : 0,
        ammoMax,
        meAlive: meTank.alive,
        reconnecting: false,
        emAcao: fase === 'playing',
        treino,
      };
      renderHud(telas.hud, hudState);
      setTela(telas, 'hud');
    } else if (fase === 'roundend') {
      renderRoundend(telas.roundend, {
        round,
        totalRounds: totalRodadas,
        vencedor: vencedorRodadaId ? playersById.get(vencedorRodadaId)!.name : null,
        entradas: entradasRodada,
        meId,
        roomCode: 'LOCAL',
        destaques: destaquesDaTela,
      });
      setTela(telas, 'roundend');
    } else if (fase === 'gameover') {
      const ranking = [...players]
        .sort((a, b) => b.score - a.score)
        .map((p, i): ResultEntry => ({ id: p.id, name: p.name, color: p.color, position: i + 1, score: p.score }));
      const resultState: ResultState = {
        ranking,
        titulos: calcularTitulos(players),
        proximaPartidaEm,
        meId,
        destaques: melhoresDestaques(destaquesPartida, 3),
        rotuloReplay: treino ? 'TREINAR DE NOVO' : 'JOGAR DE NOVO',
        rotuloVoltar: treino ? 'VOLTAR' : '',
      };
      renderResult(telas.result, resultState);
    }

    publicarDebug(debug, {
      t: Date.now(),
      fase,
      sala: 'LOCAL',
      round,
      me: meId,
      tanks: view.tanks,
      bullets: state.bullets.map((b) => ({ id: b.id, ownerId: b.ownerId, x: b.x, y: b.y })),
      placar: players.map((p) => ({ id: p.id, name: p.name, score: p.score, alive: state.tanks.get(p.id)!.alive })),
      aim: ultimoAim,
    });

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

interface Titulo {
  titulo: string;
  jogador: string;
}

/**
 * Os MESMOS três títulos que `computeMatchTitles` (apps/server/src/rooms/roundLoop.ts) entrega no
 * modo online — Kamikaze (mais autogols), Bala Perdida (mais tiros sem acertar nada) e Covarde
 * Estratégico (menos abates, desempatando por mais tempo vivo). A regra é reimplementada aqui em
 * vez de importada porque `apps/*` não importa de `apps/*`; o servidor continua sendo a fonte da
 * verdade do modo online.
 */
function calcularTitulos(players: MatchPlayer[]): Titulo[] {
  if (players.length === 0) return [];
  const titulos: Titulo[] = [];

  const kamikaze = players.reduce((a, b) => (b.selfKills > a.selfKills ? b : a));
  if (kamikaze.selfKills > 0) titulos.push({ titulo: 'Kamikaze', jogador: kamikaze.name });

  const balaPerdida = players
    .filter((p) => p.shotsFired > 0 && p.shotsHit === 0)
    .reduce<MatchPlayer | null>((best, p) => (!best || p.shotsFired > best.shotsFired ? p : best), null);
  if (balaPerdida) titulos.push({ titulo: 'Bala Perdida', jogador: balaPerdida.name });

  const covarde = players.reduce((best, p) => {
    if (p.kills > best.kills) return best;
    if (p.kills < best.kills) return p;
    return p.aliveSeconds > best.aliveSeconds ? p : best;
  });
  titulos.push({ titulo: 'Covarde Estratégico', jogador: covarde.name });

  return titulos;
}

// Espelha `apps/server/src/state/{PlayerState,TankRoomState}.ts` (campos em inglês — só o
// texto exposto na UI é pt-BR, o wire format do servidor não é traduzido).
interface ServerPlayerState {
  id: string;
  name: string;
  color: number;
  score: number;
  alive: boolean;
  connected: boolean;
  ready: boolean;
  isBot: boolean;
  kills: number;
  deaths: number;
  selfKills: number;
  slot: number;
}
type ServerPhase = 'lobby' | 'countdown' | 'playing' | 'roundend' | 'gameover';
interface ServerRoomState {
  phase: ServerPhase;
  round: number;
  seed: number;
  /** Proporção do labirinto da rodada, decidida pelo servidor (Fase 9). 0 = ainda não houve rodada. */
  aspect: number;
  timeLeft: number;
  /** Dono da sala — o único que pode colocar e tirar bots no lobby (Fase 13 §3). */
  ownerId: string;
  players: Iterable<[string, ServerPlayerState]>;
}

// Atraso de interpolação: um intervalo de snapshot (50 ms a 20 Hz) mais uma folga curta para
// jitter. Menos que isso e o buffer fica sem amostra futura para interpolar (trava e salta);
// muito mais e o tanque do próprio jogador responde com atraso perceptível.
const INTERP_DELAY_MS = 1000 / SNAPSHOT_HZ + 10;

/** Teto de espera de um `create`/`join` antes de a tela de entrada voltar a aceitar cliques. */
const ESPERA_MAX_CONEXAO_MS = 12_000;

async function runOnlineMode(params: URLSearchParams, renderer: Renderer, telas: Telas, camadas: Camadas): Promise<void> {
  const controls = createControls({
    fireTarget: camadas.game,
    screenToWorld: (x, y) => renderer.screenToWorld(x, y),
  });
  const debug = params.has('debug');
  desbloquearAudioNoPrimeiroGesto();

  let nome = params.get('nome') ?? localStorage.getItem('tank:nome') ?? '';
  // Normalizado pela MESMA função do campo de texto: um link com o código em minúsculas, com
  // espaço ou com um caractere que o alfabeto não usa entra igual ao que foi digitado à mão.
  let codigoDigitado = normalizeRoomCode(params.get('sala'));
  // Cor que este navegador quer (Fase 10 §5). Vai como PEDIDO no join e a cada clique no
  // seletor; quem decide, e quem impede repetição na sala, é o servidor.
  let corPreferida = corPreferidaSalva();
  let ultimoPedidoCor = 0;
  // Quem acabou de sair de uma partida encerrada chega aqui numa página recarregada e sem
  // contexto nenhum. Sem esta linha a tela de entrada parece a de sempre e o jogador fica sem
  // saber se o "jogar de novo" fez alguma coisa.
  let avisoEntrada = (() => {
    try {
      if (sessionStorage.getItem('tank:saiu') === '1') {
        sessionStorage.removeItem('tank:saiu');
        return 'Você saiu da sala. Entre em outra ou crie a sua.';
      }
      if (sessionStorage.getItem('tank:voltou') !== '1') return '';
      sessionStorage.removeItem('tank:voltou');
      return 'Partida encerrada. Crie uma sala nova ou entre com o código de outra.';
    } catch {
      return '';
    }
  })();
  // Chegou por link de sala (`?sala=ABCD`) e ainda não tem nome: o código já está preenchido e
  // ENTRAR fica a um clique, então o campo vazio é o único passo que falta — leva o foco até ele
  // em vez de esperar a pessoa descobrir sozinha. Quem já jogou tem o nome no localStorage e não
  // é interrompido. O foco só pode ir DEPOIS da primeira renderização (antes dela a tela de
  // entrada ainda não existe no DOM e o pedido seria descartado em silêncio).
  let focoInicialPendente = Boolean(codigoDigitado) && !nome;

  let conectando = false;
  let conectado = false;
  // Menu de pausa e saída da sala (Fase 13 §1).
  let menuAberto = false;
  let saindo = false;
  // Salas abertas da tela de entrada (Fase 13 §2): a consulta roda fora do laço de render, e o
  // resultado só é redesenhado quando muda.
  let primeiraRespostaDeSalas = false;

  let playersById = new Map<string, ServerPlayerState>();
  let slotToId = new Map<number, string>();
  let maze: Maze | null = null;
  let bulletPredictor: BulletPredictor | null = null;
  const interp = new InterpolationBuffer(INTERP_DELAY_MS);

  let fase: ServerPhase = 'lobby';
  let round = 0;
  let timeLeft = 0;
  let seedAtual = -1;
  let ownerId = '';
  let reconnecting = false;
  let vencedorRodada: string | null = null;
  let titulosFinais: Titulo[] = [];
  let faseAnterior: ServerPhase = 'lobby';
  let vaiAte = 0;
  let ultimoAim: number | undefined;
  let entradasRodada: RoundendEntry[] = [];
  let scoreInicioRodada = new Map<string, number>();
  // Mesma mecânica do modo local: a zoeira sai do killfeed e vai para o fim de rodada / vencedor.
  let destaquesRodada: Destaque[] = [];
  const destaquesPartida: Destaque[] = [];
  let destaquesDaTela: string[] = [];
  // Arena rodando com bots por trás do lobby. Ela é a dona do renderer enquanto ninguém está em
  // partida; assim que a primeira rodada de verdade começa (`round_start`) ela para e sai de cena.
  let vitrine: Vitrine | null = new Vitrine(renderer, Math.floor(performance.now()) % 100000 || 7, 6);
  // Mesma função do `bulletOwners` do modo local: colorir o estouro de uma bala que já sumiu.
  const donosDeBala = new Map<string, string>();
  const corDaBala = (ownerId: string | undefined): number =>
    (ownerId ? playersById.get(ownerId)?.color : undefined) ?? 0xffb347;

  const nomeDe = (id: string | null | undefined): string => (id ? (playersById.get(id)?.name ?? id) : '—');

  function guardarDestaque(d: Destaque): void {
    destaquesRodada.push(d);
    destaquesPartida.push(d);
  }

  // Relógio da bala ancorado em tempo ABSOLUTO, não no somatório dos deltas de frame. Somar
  // deltas faz a simulação ficar para trás quando um frame demora, e duas telas com frame rates
  // diferentes acabam mostrando a mesma bala em lugares diferentes.
  const dtFixo = 1 / TICK_HZ;
  const relogioZero = performance.now();
  const MAX_CATCHUP_TICKS = 600; // 10 s de recuperação; além disso ressincroniza de uma vez
  let ticksSimulados = 0;

  /**
   * Avança a simulação de balas até o tick correspondente a `agora`.
   *
   * Chamado no início de cada frame E logo antes de inserir uma bala nova. Essa segunda chamada
   * é o que faz duas telas concordarem: sem ela, uma bala que chega no meio de um frame lento
   * recebe TODO o catch-up pendente daquele frame (ticks anteriores ao próprio disparo), e o
   * excesso é diferente em cada cliente porque os frames caem em instantes diferentes.
   */
  function avancarBalas(agora: number): void {
    const alvoTick = Math.floor(((agora - relogioZero) * TICK_HZ) / 1000);
    if (!bulletPredictor || (fase !== 'playing' && fase !== 'countdown')) {
      ticksSimulados = alvoTick;
      return;
    }
    let executados = 0;
    while (ticksSimulados < alvoTick && executados < MAX_CATCHUP_TICKS) {
      for (const ev of bulletPredictor.tick(dtFixo)) {
        if (ev.type === 'bounce') {
          renderer.onBounce(ev.x, ev.y);
          void tocar(SOM_RICOCHETE);
        } else if (ev.type === 'bullet_expired' && ev.reason === 'life') {
          renderer.onBulletExplode(ev.x, ev.y, corDaBala(donosDeBala.get(ev.bulletId)));
          void tocar(SOM_ESTOURO_BALA);
          donosDeBala.delete(ev.bulletId);
        } else if (ev.type === 'bullet_clash') {
          // O choque sai da MESMA `step()` do servidor, então a explosão aparece aqui sem
          // esperar o `bullet_dead` chegar pela rede — o servidor manda depois só para confirmar
          // a remoção, que é idempotente.
          renderer.onBulletExplode(ev.x, ev.y, corDaBala(donosDeBala.get(ev.aId)), 1.45);
          void tocar(SOM_ESTOURO_BALA);
          donosDeBala.delete(ev.aId);
          donosDeBala.delete(ev.bId);
        }
      }
      ticksSimulados += 1;
      executados += 1;
    }
    // Aba parada por mais de 10 s: em vez de simular minutos de bala de uma vez (que já morreram
    // por BULLET_LIFE), pula o relógio para o presente.
    if (ticksSimulados < alvoTick) ticksSimulados = alvoTick;
  }

  function trocarLabirinto(novo: Maze): void {
    maze = novo;
    renderer.setMaze(novo);
    if (bulletPredictor) bulletPredictor.setMaze(novo);
    else bulletPredictor = new BulletPredictor(novo);
  }

  const net = new NetClient({
    onStateChange: (raw: unknown) => {
      const s = raw as ServerRoomState;
      playersById = new Map(s.players);
      slotToId = new Map([...playersById.values()].map((p) => [p.slot, p.id]));
      // A largada da rodada é a transição countdown→playing do estado frio: é o mesmo instante em
      // que o servidor liberou o `step()`, então o "VAI!" aparece exatamente quando o jogo começa.
      if (faseAnterior === 'countdown' && s.phase === 'playing') vaiAte = performance.now() + VAI_MS;
      // Fim da rodada com o relógio quase zerado = o tempo acabou (com alguém vivo a rodada teria
      // terminado bem antes do fim). O servidor zera `timeLeft` no MESMO tick em que troca a
      // fase, então este é o único lugar onde dá para saber que a buzina é devida.
      if (faseAnterior === 'playing' && s.phase === 'roundend' && timeLeft <= 1.5) {
        contagemSonora.fimDoTempo();
      }
      // Quem entra numa sala que JÁ está em partida nunca recebe o `round_start` daquela rodada;
      // sem este corte a vitrine continuaria desenhando por cima da arena de verdade.
      if (s.phase !== 'lobby' && vitrine) {
        vitrine.parar();
        vitrine = null;
      }
      faseAnterior = s.phase;
      fase = s.phase;
      round = s.round;
      timeLeft = s.timeLeft;
      ownerId = s.ownerId ?? '';

      // Rede de segurança para quem entra com a partida já em andamento e nunca recebeu o
      // `round_start` daquela rodada: reconstrói o labirinto pela seed do estado frio.
      if (!maze && s.phase !== 'lobby' && s.seed !== seedAtual) {
        seedAtual = s.seed;
        // A proporção vem do estado FRIO, não da janela local: é a mesma que o servidor mandou
        // no `round_start` que esta aba perdeu.
        trocarLabirinto(makeMaze(s.seed, Math.max(2, playersById.size), s.aspect || undefined));
      }
    },
    onSnapshot: (tanks: SnapshotTank[]) => {
      const agora = performance.now();
      for (const t of tanks) {
        const id = slotToId.get(t.slot);
        if (!id) continue;
        interp.push(id, { t: agora, x: t.x, y: t.y, heading: t.heading, turret: t.turret, alive: t.alive });
      }
    },
    onBulletSpawn: (msg: BulletSpawnMsg) => {
      avancarBalas(performance.now());
      bulletPredictor?.spawn(msg);
      donosDeBala.set(msg.id, msg.ownerId);
      renderer.onShot(msg.x, msg.y, msg.angle, playersById.get(msg.ownerId)?.color ?? 0xffffff);
      void tocar(SOM_TIRO);
    },
    onBulletDead: (msg: BulletDeadMsg) => {
      bulletPredictor?.remove(msg.id);
      donosDeBala.delete(msg.id);
    },
    onTankDeath: (msg: TankDeathMsg) => {
      const vitima = playersById.get(msg.victimId);
      const matador = msg.killerId ? playersById.get(msg.killerId) : undefined;
      renderer.onDeath(msg.x, msg.y, vitima?.color ?? 0xffffff);
      renderer.addTrauma(msg.autogol ? 0.4 : 0.55);
      renderer.hitstop(60);
      void tocar(msg.autogol ? SOM_AUTOGOL : SOM_MORTE);
      if (msg.autogol && vitima) {
        pushKillfeed({ tag: 'autogol', vitima });
        guardarDestaque(destaqueAutogol(vitima));
      } else if (vitima && matador) {
        pushKillfeed({ tag: 'kill', matador, vitima });
        guardarDestaque(destaqueKill(matador, vitima, false));
      }
    },
    onRoundStart: (msg: RoundStartMsg) => {
      vitrine?.parar();
      vitrine = null;
      resetKillfeed();
      resetCountdown();
      interp.clear();
      vencedorRodada = null;
      destaquesRodada = [];
      scoreInicioRodada = new Map([...playersById.values()].map((p) => [p.id, p.score]));
      seedAtual = msg.seed;
      // MESMA chamada do servidor (mesma seed, mesmo nº de jogadores) — é o que garante que a
      // bala simulada aqui ricocheteie exatamente onde ela ricocheteou lá.
      donosDeBala.clear();
      trocarLabirinto(makeMaze(msg.seed, msg.playerCount, msg.aspect));
    },
    onRoundEnd: (msg: RoundEndMsg) => {
      // `position` do servidor é ordem de SOBREVIVÊNCIA (maior = morreu por último), não posição
      // no ranking — quem tem a maior chegou vivo ao fim da rodada.
      const melhor = msg.ranking.reduce<{ playerId: string; position: number } | null>(
        (best, r) => (!best || r.position > best.position ? r : best),
        null,
      );
      const empatados = melhor ? msg.ranking.filter((r) => r.position === melhor.position) : [];
      vencedorRodada = empatados.length === 1 && melhor ? melhor.playerId : null;
      destaquesDaTela = destaquesRodada.length ? melhoresDestaques(destaquesRodada, 2) : [fraseEmpate()];

      const sobreviventes = new Set(empatados.map((r) => r.playerId));
      entradasRodada = msg.ranking.flatMap((r): RoundendEntry[] => {
        const p = playersById.get(r.playerId);
        if (!p) return [];
        return [
          {
            id: p.id,
            name: p.name,
            color: p.color,
            score: r.score,
            ganho: r.score - (scoreInicioRodada.get(p.id) ?? r.score),
            sobreviveu: sobreviventes.has(p.id),
          },
        ];
      });
    },
    onSuddenDeathWall: (msg: SuddenDeathWallMsg) => {
      if (!maze) return;
      // Muta o MESMO objeto que o BulletPredictor referencia: a bala em voo continua viva e já
      // passa a ignorar a parede removida, sem recriar o labirinto nem perder projéteis.
      maze.walls.splice(msg.index, 1);
      renderer.setMaze(maze);
    },
    onGameOver: (msg: GameOverMsg) => {
      titulosFinais = [
        { titulo: 'Kamikaze', jogador: nomeDe(msg.titulos.kamikaze) },
        { titulo: 'Bala Perdida', jogador: nomeDe(msg.titulos.balaPerdida) },
        { titulo: 'Covarde Estratégico', jogador: nomeDe(msg.titulos.covardeEstrategico) },
      ].filter((t) => t.jogador !== '—');
    },
    onReconnecting: () => {
      reconnecting = true;
    },
    onReconnected: () => {
      reconnecting = false;
    },
    onDisconnected: () => {
      reconnecting = false;
      conectado = false;
      avisoEntrada = 'Conexão perdida. Entre de novo com o código da sala.';
    },
  });

  setLobbyDigitouHandler((n, c) => {
    nome = n;
    codigoDigitado = c;
    // Digitar DISPENSA o aviso anterior. Sem isto o "o código tem 4 caracteres" da tentativa
    // passada ficava na tela por cima das dicas do próprio campo (Fase 12 §4).
    avisoEntrada = '';
  });

  setLobbyReadyHandler(() => {
    const me = playersById.get(net.sessionId);
    net.sendReady(!(me?.ready ?? false));
  });

  setLobbyCorHandler((cor) => {
    corPreferida = cor;
    ultimoPedidoCor = performance.now();
    guardarCorPreferida(cor);
    net.sendPickColor(cor);
  });

  // Online a sala morre com a partida (o servidor fica em `gameover` e não volta ao lobby), então
  // "jogar de novo" significa voltar para a tela de entrada e abrir/entrar numa sala nova.
  //
  // A volta é uma RECARGA de propósito (Fase 12 §3): é a única forma de garantir que não sobra
  // nada da partida anterior — placar, killfeed, decalques, contagem, preditor de bala. Nome e
  // cor sobrevivem porque moram no `localStorage`, não em memória. O `?sala=` sai da URL para a
  // aba não tentar reentrar sozinha na sala que acabou.
  const voltarParaEntrada = (): void => {
    net.leave();
    try { sessionStorage.setItem('tank:voltou', '1'); } catch { /* modo privado */ }
    location.assign(location.pathname);
  };
  setResultReplayHandler(voltarParaEntrada);
  // Online não há segunda saída: "jogar de novo" JÁ é voltar para a tela de entrada. Dois botões
  // com o mesmo destino só criariam dúvida.
  setResultVoltarHandler(null);

  /**
   * SAIR DA SALA (Fase 13 §1). O `net.sair()` ESPERA o servidor confirmar antes da recarga: é
   * essa confirmação que faz a saída chegar lá como intencional (a vaga é devolvida na hora e o
   * tanque some da arena dos outros) em vez de como queda de conexão, que seguraria tudo por 30 s.
   *
   * A volta é uma recarga pelo mesmo motivo do "jogar de novo" da Fase 12: é o único jeito de não
   * sobrar nada da partida. Nome e cor sobrevivem porque moram no `localStorage`.
   */
  const sairDaSala = async (): Promise<void> => {
    if (saindo) return;
    saindo = true;
    menuAberto = false;
    await net.sair();
    try {
      sessionStorage.setItem('tank:saiu', '1');
    } catch {
      /* modo privado */
    }
    location.assign(location.pathname);
  };

  // `Esc` abre e fecha o menu. Vale no lobby da sala também: ficar preso esperando os outros
  // ficarem prontos era exatamente o outro jeito de não conseguir sair.
  window.addEventListener('keydown', (ev) => {
    if (ev.code !== 'Escape') return;
    if (!conectado || saindo) return;
    ev.preventDefault();
    menuAberto = !menuAberto;
  });
  setPausaHandlers(
    () => {
      menuAberto = false;
    },
    () => void sairDaSala(),
  );

  // Lista de SALAS ABERTAS (Fase 13 §2): pergunta a cada 3 s enquanto a tela de entrada está à
  // vista e para sozinha quando ela sai (ver `MonitorDeSalas`).
  const monitorDeSalas = new MonitorDeSalas((salas, erro) => {
    primeiraRespostaDeSalas = true;
    renderSalasAbertas(telas.lobby, { salas, erro, carregando: false });
  });

  setLobbySalaHandler((codigo) => {
    if (conectando || conectado) return;
    codigoDigitado = codigo;
    if (!nome.trim()) {
      avisoEntrada = 'Escolha seu nome para entrar na sala.';
      return;
    }
    avisoEntrada = '';
    void conectar('entrar', nome, codigo);
  });

  // `+ BOT` / `− BOT` do lobby. O cliente só PEDE: quem confere que o pedido veio do dono, que a
  // sala ainda está no lobby e que há vaga é o servidor.
  setLobbyBotHandler((delta) => net.sendBot(delta));

  async function conectar(acao: AcaoEntrada, nomeInformado: string, codigo: string): Promise<void> {
    if (conectando) return;
    conectando = true;
    avisoEntrada = acao === 'criar' ? 'Criando sala…' : `Entrando na sala ${codigo}…`;
    nome = nomeInformado || nome || `Jogador${Math.floor(Math.random() * 900) + 100}`;
    try { localStorage.setItem('tank:nome', nome); } catch { /* modo privado */ }

    try {
      // Teto de espera: um `join` que nunca resolve (WebSocket pendurado numa rede de escritório
      // instável) deixava `conectando` preso em `true` para sempre, e a partir daí TODO clique em
      // ENTRAR era engolido em silêncio — a falha se parecia exatamente com "digitei o código e
      // não acontece nada".
      const tentativa =
        acao === 'criar'
          ? net.create({
              nome,
              bots: clamp(Number(params.get('bots')) || 0, 0, 9),
              cor: corPreferida || undefined,
              rodadas: params.has('rodadas') ? clamp(Number(params.get('rodadas')) || ROUNDS, 1, ROUNDS) : undefined,
            })
          : net.join(codigo, { nome, cor: corPreferida || undefined });
      await Promise.race([
        tentativa,
        new Promise((_, rejeitar) =>
          setTimeout(() => rejeitar(new Error('o servidor não respondeu a tempo')), ESPERA_MAX_CONEXAO_MS),
        ),
      ]);
      conectado = true;
      avisoEntrada = '';
      // Anuncia a tela ANTES de a primeira rodada ser sorteada: é a partir das telas da sala que
      // o servidor escolhe a forma do labirinto (Fase 9). Reenviado a cada resize logo abaixo.
      net.sendViewport(renderer.aspectoDaArena());
      codigoDigitado = net.roomId;
      const url = new URL(location.href);
      url.searchParams.set('sala', net.roomId);
      history.replaceState(null, '', url);
    } catch (e) {
      avisoEntrada =
        acao === 'criar'
          ? `Não deu para criar a sala: ${String(e)}`
          : `Não achei a sala ${codigo}. Confira o código com quem criou (ele não tem I, O, 0 nem 1) ou crie uma sala nova.`;
      console.error(e);
    } finally {
      conectando = false;
    }
  }

  setLobbyEntradaHandler((acao, nomeInformado, codigo) => {
    // O nome é OBRIGATÓRIO nas duas ações. Sem ele o servidor batizava a pessoa de "Jogador N" e
    // ninguém se achava na arena nem no placar — o oposto do que o jogo é. Vale principalmente
    // para quem chega por link de sala: o código já vem preenchido, então ENTRAR fica a um clique
    // e o campo vazio passa batido. Por isso não basta avisar: o foco vai para o campo.
    if (!nomeInformado.trim()) {
      avisoEntrada = acao === 'entrar'
        ? 'Escolha um nome antes de entrar — é assim que o pessoal vai te achar na arena.'
        : 'Escolha um nome antes de criar a sala.';
      focarCampoNome();
      return;
    }
    if (acao === 'entrar' && !isRoomCode(codigo)) {
      // O botão não fica mais desabilitado (Fase 12 §4): clicar com o código incompleto tem que
      // DIZER o que falta, não ficar mudo.
      avisoEntrada = codigo.length === 0
        ? 'Digite o código de 4 caracteres da sala — ou crie uma sala nova.'
        : `O código tem ${ROOM_CODE_LENGTH} caracteres; você digitou ${codigo.length}.`;
      return;
    }
    avisoEntrada = '';
    void conectar(acao, nomeInformado, codigo);
  });

  // Treino contra bots (Fase 12 §7): o modo local já roda a partida inteira sem servidor — o que
  // faltava era chegar nele sem montar URL na mão. Guarda nome e cor antes de recarregar, para o
  // treino começar com a mesma identidade que a pessoa acabou de escolher.
  setLobbyTreinoHandler((nomeInformado, bots) => {
    const escolhido = (nomeInformado || nome).trim();
    if (!escolhido) {
      avisoEntrada = 'Escolha um nome antes de treinar.';
      focarCampoNome();
      return;
    }
    if (escolhido) {
      nome = escolhido;
      try { localStorage.setItem('tank:nome', escolhido); } catch { /* modo privado */ }
    }
    net.leave();
    // `?debug=1` atravessa junto quando está ligado: é a sonda que os testes de navegador leem, e
    // sem ela o treino seria o único caminho do jogo impossível de inspecionar.
    const extra = params.has('debug') ? '&debug=1' : '';
    location.assign(`${location.pathname}?local=1&treino=1&bots=${bots}${extra}`);
  });

  // Redimensionar (ou entrar em tela cheia) muda a proporção da área jogável. O servidor só lê
  // isso no sorteio da próxima rodada, então não há troca de labirinto no meio do jogo — a rodada
  // seguinte é que nasce no formato certo.
  window.addEventListener('resize', () => net.sendViewport(renderer.aspectoDaArena()));
  document.addEventListener('fullscreenchange', () => net.sendViewport(renderer.aspectoDaArena()));

  setTela(telas, 'lobby');

  // Entrada por link: `?sala=XXXX` só entra direto se JÁ existir um nome (salvo de uma partida
  // anterior ou passado na URL). Quem chega pelo link sem nome vê o formulário com o código já
  // preenchido, escolhe como quer aparecer e entra — antes disso ele era jogado na sala como
  // "JogadorNNN" sem nunca poder se identificar (relatado pelo usuário).
  if (params.has('criar')) void conectar('criar', nome, '');
  else if (isRoomCode(codigoDigitado) && nome.trim()) void conectar('entrar', nome, codigoDigitado);
  else if (isRoomCode(codigoDigitado)) avisoEntrada = 'Escolha seu nome para entrar na sala.';

  // ---------- laço de render (independente da chegada de snapshots) ----------
  let ultimoEnvio = 0;
  let seq = 0;

  function frame(agora: number): void {
    // A bala roda no MESMO passo fixo do servidor: qualquer outro dt daria uma trajetória de
    // ricochete diferente da autoritativa e as duas telas divergiriam.
    avancarBalas(agora);

    const meId = net.sessionId;
    // Mira do frame: precisa da posição do MEU tanque em coordenadas de mundo, que vem do mesmo
    // buffer interpolado que desenha o tanque — assim o ângulo enviado bate com o que está na tela.
    const minhaAmostra = meId ? interp.sample(meId, agora) : null;

    if (conectado && agora - ultimoEnvio >= 1000 / 30) {
      ultimoEnvio = agora;
      // Com o menu de pausa aberto o tanque para de responder — a partida continua para os
      // outros, mas as teclas que a pessoa está usando para navegar o menu não podem virar
      // movimento. `read(null)` continua sendo chamado para CONSUMIR a borda de tiro: sem isso,
      // um clique dado no menu sairia como disparo no instante em que ele fechasse.
      const bruto = controls.read(menuAberto ? null : minhaAmostra);
      const meu: Input = menuAberto ? { turn: 0, move: 0, fire: false } : bruto;
      ultimoAim = meu.aim;
      net.sendInput(meu, seq++);
    }

    const emJogo = conectado && (fase === 'countdown' || fase === 'playing');
    const view: RenderView = {
      tanks: [...playersById.values()].flatMap((p) => {
        const s = interp.sample(p.id, agora);
        if (!s) return [];
        return [{ id: p.id, x: s.x, y: s.y, angle: s.heading, turret: s.turret, color: p.color, alive: s.alive, name: p.name }];
      }),
      // Mesma correção do modo local (Fase 6): fora da rodada o preditor para de avançar, e as
      // balas que sobraram ficavam paradas no ar durante a tela de fim de rodada. Fora de jogo,
      // nenhuma bala vai para a tela.
      bullets: emJogo
        ? (bulletPredictor?.bullets ?? []).map((b) => ({ x: b.x, y: b.y, color: playersById.get(b.ownerId)?.color }))
        : [],
      me: meId,
    };
    // A vitrine é dona do renderer até a primeira rodada começar — os dois nunca desenham no
    // mesmo frame.
    if (vitrine) vitrine.frame(agora);
    else renderer.sync(view);

    const ponteiro = controls.pointer;
    renderer.setCrosshair(ponteiro?.x ?? 0, ponteiro?.y ?? 0, emJogo && ponteiro !== null);
    setAudioAtivo(emJogo);
    // Mesma chamada do modo local: aqui o relógio da contagem é o `timeLeft` do estado frio.
    renderer.setLargada(conectado && fase === 'countdown' ? timeLeft : null);

    const mostrandoVai = agora < vaiAte;
    if (
      renderCountdown(camadas.contagem, {
        restante: conectado && fase === 'countdown' ? timeLeft : null,
        vai: mostrandoVai,
      })
    ) {
      renderer.addTrauma(mostrandoVai ? 0.32 : 0.06);
      void tocar(mostrandoVai ? SOM_VAI : SOM_BIPE);
    }

    contagemSonora.acompanhar(timeLeft, conectado && fase === 'playing');
    renderPausa(camadas.pausa, { aberto: menuAberto, modo: 'online', roomCode: net.roomId });

    if (!conectado) {
      // A lista de salas só existe enquanto esta tela existe: entrar numa sala desliga o monitor
      // e para de consultar o servidor.
      monitorDeSalas.ligar();
      if (!primeiraRespostaDeSalas) renderSalasAbertas(telas.lobby, { salas: [], carregando: true });
      renderEntrada(telas.lobby, { nome, codigo: codigoDigitado, aviso: avisoEntrada, ocupado: conectando });
      if (focoInicialPendente) {
        focoInicialPendente = false;
        focarCampoNome();
      }
      setTela(telas, 'lobby');
    } else if (fase === 'lobby') {
      monitorDeSalas.desligar();
      const lobbyPlayers: LobbyPlayer[] = [...playersById.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        ready: p.ready,
        isBot: p.isBot,
      }));
      // Aviso discreto de cor: o servidor entregou uma cor diferente da pedida porque alguém
      // chegou nela primeiro. A folga de 900 ms evita piscar a mensagem durante a ida e volta
      // normal do próprio clique.
      const minhaCor = playersById.get(meId)?.color ?? 0;
      const corNegada =
        corPreferida !== 0 && minhaCor !== 0 && minhaCor !== corPreferida && agora - ultimoPedidoCor > 900;
      renderLobby(telas.lobby, {
        roomCode: net.roomId,
        players: lobbyPlayers,
        meId,
        meReady: playersById.get(meId)?.ready ?? false,
        countdown: null,
        aviso: lobbyPlayers.length < 2 ? 'ESPERANDO MAIS UM JOGADOR' : 'TODOS PRONTOS = COMEÇA',
        avisoCor: corNegada ? 'aquela já era de outro' : '',
        souDono: ownerId !== '' && ownerId === meId,
      });
      setTela(telas, 'lobby');
    } else if (fase === 'countdown' || fase === 'playing') {
      monitorDeSalas.desligar();
      const me = playersById.get(meId);
      const ammoMax = maxBulletsFor(playersById.size);
      const minhasBalas = (bulletPredictor?.bullets ?? []).filter((b) => b.ownerId === meId).length;
      renderHud(telas.hud, {
        round,
        totalRounds: ROUNDS,
        timeLeft,
        vivos: [...playersById.values()].filter((p) => p.alive).length,
        meName: me?.name ?? nome,
        ammoAvailable: me?.alive ? Math.max(0, ammoMax - minhasBalas) : 0,
        ammoMax,
        meAlive: me?.alive ?? false,
        reconnecting,
        emAcao: fase === 'playing',
      });
      setTela(telas, 'hud');
    } else if (fase === 'roundend') {
      renderRoundend(telas.roundend, {
        round,
        totalRounds: ROUNDS,
        vencedor: vencedorRodada ? nomeDe(vencedorRodada) : null,
        entradas: entradasRodada,
        meId,
        roomCode: net.roomId,
        destaques: destaquesDaTela,
      });
      setTela(telas, 'roundend');
    } else if (fase === 'gameover') {
      const ranking = [...playersById.values()]
        .sort((a, b) => b.score - a.score)
        .map((p, i): ResultEntry => ({ id: p.id, name: p.name, color: p.color, position: i + 1, score: p.score }));
      renderResult(telas.result, {
        ranking,
        titulos: titulosFinais,
        proximaPartidaEm: null,
        meId,
        destaques: melhoresDestaques(destaquesPartida, 3),
        rotuloReplay: 'JOGAR DE NOVO',
      });
      setTela(telas, 'result');
    }

    publicarDebug(debug, {
      t: Date.now(),
      fase: conectado ? fase : 'entrada',
      sala: net.roomId,
      round,
      me: meId,
      tanks: view.tanks,
      bullets: (bulletPredictor?.bullets ?? []).map((b) => ({ id: b.id, ownerId: b.ownerId, x: b.x, y: b.y })),
      placar: [...playersById.values()].map((p) => ({ id: p.id, name: p.name, score: p.score, alive: p.alive })),
      aim: ultimoAim,
    });

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

async function main(): Promise<void> {
  window.addEventListener('error', (ev) => showErro(`Erro: ${ev.message}`));
  window.addEventListener('unhandledrejection', (ev) => showErro(`Promise: ${String(ev.reason)}`));

  const gameEl = document.getElementById('game');
  const lobbyEl = document.getElementById('lobby');
  const hudEl = document.getElementById('hud');
  const roundendEl = document.getElementById('roundend');
  const resultEl = document.getElementById('result');
  const contagemEl = document.getElementById('contagem');
  const pausaEl = document.getElementById('pausa');
  const telaCheiaEl = document.getElementById('btn-tela-cheia');
  if (
    !gameEl ||
    !lobbyEl ||
    !hudEl ||
    !roundendEl ||
    !resultEl ||
    !contagemEl ||
    !pausaEl ||
    !(telaCheiaEl instanceof HTMLButtonElement)
  ) {
    throw new Error('Estrutura do index.html incompleta.');
  }

  const telas: Telas = { lobby: lobbyEl, hud: hudEl, roundend: roundendEl, result: resultEl };
  const camadas: Camadas = { contagem: contagemEl, game: gameEl, pausa: pausaEl };

  const renderer = await Renderer.create(gameEl);
  window.addEventListener('resize', () => renderer.resize());
  // Entrar e sair da tela cheia troca o tamanho da janela em dois passos; `iniciarTelaCheia`
  // chama de volta nos dois, e o `resize()` do Renderer refaz enquadramento e escala do HUD.
  iniciarTelaCheia(telaCheiaEl, () => renderer.resize());

  const params = new URLSearchParams(location.search);
  if (params.has('local')) {
    await runLocalMode(params, renderer, telas, camadas);
  } else {
    await runOnlineMode(params, renderer, telas, camadas);
  }
}

main().catch((e) => showErro(`Falha ao iniciar: ${String(e)}`));
