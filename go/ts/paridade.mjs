// Lado TypeScript do arranjo de paridade — o espelho exato de `go/paridade/cenario.go`.
//
//   pnpm exec tsx go/ts/paridade.mjs --modo resumo  --de 0 --ate 10000 [--ticks 300]
//   pnpm exec tsx go/ts/paridade.mjs --modo detalhe --seed 42 [--ticks 300]
//
// Este arquivo NÃO pode "melhorar" nada em relação ao Go: a ordem dos registros, a ordem de
// consumo do RNG e o que entra em cada seção fazem parte do contrato. Qualquer diferença aqui
// aparece como divergência de paridade sem haver bug nenhum na simulação.
import {
  BULLET_EXPLOSION_RADIUS,
  BULLET_LIFE,
  BULLET_RADIUS,
  BULLET_RADIUS_F,
  BULLET_SPEED,
  CELL,
  COUNTDOWN,
  FIRE_COOLDOWN,
  MAX_BOUNCES,
  MAX_BULLETS,
  MAX_BULLETS_BY_PLAYERS,
  MAZE_ASPECT_DEFAULT,
  MAZE_ASPECT_MAX,
  MAZE_ASPECT_MIN,
  MAZE_BY_PLAYERS,
  POWERUP,
  POWERUP_INTERVALO_S,
  POWERUP_JITTER_S,
  POWERUP_MAX_NO_CHAO,
  POWERUP_MAX_RICOCHETE_EXTRA,
  POWERUP_PRIMEIRO_S,
  POWERUP_QUEDA_S,
  POWERUP_RAIO,
  POWERUP_VIDA_NO_MAPA_S,
  ROUNDS,
  ROUND_TIMEOUT,
  SELF_IMMUNITY,
  SNAPSHOT_HZ,
  SPAWN_LOS_MIN_DIST,
  TANK_RADIUS,
  TANK_RADIUS_F,
  TANK_SPEED,
  TICK_HZ,
  TIPOS_DE_POWERUP,
  TURN_RATE,
  TURRET_RATE,
  WALL_THICKNESS,
  WALL_THICKNESS_F,
  direcaoDeMovimento,
} from '../../packages/protocol/src/index.ts';
import {
  BOT_DIFFICULTY,
  CampoDePowerUps,
  EfeitosDePowerUp,
  cellCenter,
  cellOf,
  countDeadEnds,
  makeBot,
  makeMaze,
  nextStepTowards,
  mulberry32,
  spawnPoints,
  step,
  validateMaze,
} from '../../packages/shared-sim/src/index.ts';
import { Detalhador, Resumidor, SEC, f, i } from './canon.mjs';

export const TICKS_PADRAO = 300;

const ASPECTOS = [16 / 9, 4 / 3, 21 / 9, 1, 3.2, 2.5];

/** Espelho de `paridade.Cenario`. */
export function cenario(seed) {
  return { players: 2 + (seed % 9), aspect: ASPECTOS[seed % 6] };
}

const DOIS_PI = Math.PI * 2;

/** Ordem canônica das dificuldades — espelho de `sim.NiveisDeBot`. */
const NIVEIS_DE_BOT = ['facil', 'medio', 'dificil'];

const nomeTanque = (idx) => 't' + Math.floor(idx / 10) + (idx % 10);

/** Espelho de `paridade.Executar`. */
export function executar(seed, ticks, sink) {
  const { players, aspect } = cenario(seed);
  const n = players;

  const maze = makeMaze(seed, players, aspect);
  sink.registro(SEC.maze, 'maze', i(maze.cols), i(maze.rows), f(maze.cell), i(maze.walls.length));
  for (let k = 0; k < maze.walls.length; k++) {
    const w = maze.walls[k];
    sink.registro(SEC.maze, 'parede', i(k), f(w.x), f(w.y), f(w.w), f(w.h));
  }

  const val = validateMaze(maze);
  sink.registro(SEC.maze, 'validacao', val.ok, val.reason ?? '');
  sink.registro(SEC.maze, 'becos', i(countDeadEnds(maze)));

  // Um punhado de consultas de caminho. `nextStepTowards` é BFS sobre o grafo do labirinto e não
  // é usado pelo `step` — quem chama é a IA dos bots, que ainda não foi portada. Entra aqui
  // porque a função JÁ está portada, e código portado sem comparação é código não provado.
  for (let k = 0; k < 6; k++) {
    const from = { x: ((k * 37) % maze.cols) * maze.cell, y: ((k * 53) % maze.rows) * maze.cell };
    const to = { x: ((k * 29 + 3) % maze.cols) * maze.cell, y: ((k * 17 + 1) % maze.rows) * maze.cell };
    const passo = nextStepTowards(maze, from, to);
    const c = cellOf(maze, from);
    sink.registro(SEC.maze, 'caminho', i(k), f(from.x), f(from.y), f(to.x), f(to.y),
      f(passo.x), f(passo.y), i(c.cx), i(c.cy));
  }

  const rngSpawn = mulberry32(seed ^ 0x9e3779b9);
  const spawns = spawnPoints(maze, n, rngSpawn);
  for (let k = 0; k < spawns.length; k++) {
    sink.registro(SEC.spawns, 'spawn', i(k), f(spawns[k].x), f(spawns[k].y));
  }
  sink.registro(SEC.spawns, 'estado_rng', i(rngSpawn.getState() >>> 0));

  // Power-ups distribuídos por um RNG PRÓPRIO — espelho do `rngPower` do lado Go, e pela mesma
  // razão: sem eles os quatro efeitos ficariam em zero nas 10.000 seeds e o porte deles não
  // estaria provado. `ricochete` em especial MUDA A TRAJETÓRIA da bala.
  const rngPower = mulberry32(seed ^ 0xa5a5a5a5);
  const tanks = new Map();
  for (let k = 0; k < n; k++) {
    const p = spawns[k];
    const tank = {
      id: nomeTanque(k),
      x: p.x,
      y: p.y,
      heading: (k * DOIS_PI) / n,
      turret: (k * DOIS_PI) / n,
      alive: true,
      fireCooldownLeft: 0,
      ricochete: 0,
      municao: 0,
      recarga: 0,
      turbo: 0,
    };
    if (rngPower.next() < 0.35) tank.ricochete = POWERUP.ricochete.valor;
    if (rngPower.next() < 0.35) tank.municao = POWERUP.municao.valor;
    if (rngPower.next() < 0.35) tank.recarga = POWERUP.recarga.valor;
    if (rngPower.next() < 0.35) tank.turbo = POWERUP.turbo.valor;
    sink.registro(SEC.spawns, 'powerup', i(k), i(tank.ricochete), i(tank.municao),
      f(tank.recarga), f(tank.turbo));
    tanks.set(tank.id, tank);
  }
  const state = { tick: 0, maze, tanks, bullets: [], nextBulletId: 0 };

  const rngRoteiro = mulberry32(seed ^ 0x5f356495);
  const dt = 1 / TICK_HZ;
  const inputs = new Map();
  const direcoes = new Array(n).fill(16); // 16 = parado

  for (let t = 0; t < ticks; t++) {
    state.tick = t;
    montarInputs(state, rngRoteiro, direcoes, inputs);
    const eventos = step(state, inputs, dt);

    for (const tank of state.tanks.values()) {
      sink.registro(SEC.sim, 'tanque', i(t), tank.id, f(tank.x), f(tank.y), f(tank.heading),
        f(tank.turret), tank.alive, f(tank.fireCooldownLeft));
    }
    for (const b of state.bullets) {
      sink.registro(SEC.sim, "bala", i(t), b.id, b.ownerId, f(b.x), f(b.y), f(b.vx), f(b.vy),
        i(b.bounces), f(b.age), i(b.ricochete ?? 0));
    }
    for (const ev of eventos) registrarEvento(sink, ev);
  }

  sink.registro(SEC.sim, 'final', i(state.tick), i(state.bullets.length), i(state.nextBulletId),
    i(rngRoteiro.getState() >>> 0));
}

// Espelho de `paridade.montarInputs`: quatro números do RNG por tanque por tick, SEMPRE, mesmo
// para tanque morto e mesmo quando o valor não é usado.
function montarInputs(state, rng, direcoes, inputs) {
  const tanques = [...state.tanks.values()];
  const n = tanques.length;
  for (let k = 0; k < n; k++) {
    const tank = tanques[k];
    const p1 = rng.next();
    const p2 = rng.next();
    const p3 = rng.next();
    const p4 = rng.next();

    if (p1 < 0.1) direcoes[k] = Math.floor(p2 * 17);

    const alvo = tanques[(k + 1) % n];
    const aim = Math.atan2(alvo.y - tank.y, alvo.x - tank.x) + (p4 * 0.6 - 0.3);

    inputs.set(tank.id, {
      mover: direcoes[k] < 16 ? (direcoes[k] * DOIS_PI) / 16 : null,
      fire: p3 < 0.06,
      aim,
    });
  }
}

function registrarEvento(sink, ev) {
  switch (ev.type) {
    case 'shot':
      sink.registro(SEC.eventos, "shot", i(ev.tick), ev.ownerId, ev.bulletId, f(ev.x), f(ev.y),
        f(ev.angle), f(ev.vx), f(ev.vy), i(ev.ricochete ?? 0));
      break;
    case 'bounce':
      sink.registro(SEC.eventos, 'bounce', i(ev.tick), ev.bulletId, f(ev.x), f(ev.y),
        f(ev.normal.x), f(ev.normal.y));
      break;
    case 'death':
      sink.registro(SEC.eventos, 'death', i(ev.tick), ev.victimId, ev.killerId, f(ev.x), f(ev.y),
        ev.autogol);
      break;
    case 'bullet_expired':
      sink.registro(SEC.eventos, 'expired', i(ev.tick), ev.bulletId, ev.reason, f(ev.x), f(ev.y));
      break;
    case 'bullet_clash':
      sink.registro(SEC.eventos, 'clash', i(ev.tick), ev.aId, ev.bId, f(ev.x), f(ev.y));
      break;
    default:
      throw new Error(`evento desconhecido: ${ev.type}`);
  }
}

/** Espelho de `paridade.Constantes`. */
export function constantes(sink) {
  const num = (nome, v) => sink.registro(SEC.maze, 'const', nome, f(v));
  const inteiro = (nome, v) => sink.registro(SEC.maze, 'const_int', nome, i(v));

  inteiro('TICK_HZ', TICK_HZ);
  inteiro('SNAPSHOT_HZ', SNAPSHOT_HZ);
  num('CELL', CELL);
  num('TANK_SPEED', TANK_SPEED);
  num('BULLET_SPEED', BULLET_SPEED);
  num('TANK_RADIUS_F', TANK_RADIUS_F);
  num('BULLET_RADIUS_F', BULLET_RADIUS_F);
  num('WALL_THICKNESS_F', WALL_THICKNESS_F);
  inteiro('MAX_BOUNCES', MAX_BOUNCES);
  num('BULLET_LIFE', BULLET_LIFE);
  inteiro('MAX_BULLETS', MAX_BULLETS);
  num('FIRE_COOLDOWN', FIRE_COOLDOWN);
  num('TURN_RATE', TURN_RATE);
  num('SELF_IMMUNITY', SELF_IMMUNITY);
  inteiro('ROUNDS', ROUNDS);
  inteiro('ROUND_TIMEOUT', ROUND_TIMEOUT);
  inteiro('COUNTDOWN', COUNTDOWN);
  num('TURRET_RATE', TURRET_RATE);
  num('TANK_RADIUS', TANK_RADIUS);
  num('BULLET_RADIUS', BULLET_RADIUS);
  num('WALL_THICKNESS', WALL_THICKNESS);
  num('BULLET_EXPLOSION_RADIUS', BULLET_EXPLOSION_RADIUS);
  num('SPAWN_LOS_MIN_DIST', SPAWN_LOS_MIN_DIST);
  num('MAZE_ASPECT_MIN', MAZE_ASPECT_MIN);
  num('MAZE_ASPECT_MAX', MAZE_ASPECT_MAX);
  num('MAZE_ASPECT_DEFAULT', MAZE_ASPECT_DEFAULT);

  inteiro("POWERUP_MAX_RICOCHETE_EXTRA", POWERUP_MAX_RICOCHETE_EXTRA);
  for (const tipo of TIPOS_DE_POWERUP) {
    num('POWERUP_' + tipo, POWERUP[tipo].valor);
  }
  // Duração e agenda entram aqui pelo mesmo motivo dos valores: `agendaDePowerUps` converte
  // segundos em tick com `Math.round`, e um segundo diferente de um lado só desloca o item
  // inteiro sem dizer por quê.
  for (const tipo of TIPOS_DE_POWERUP) {
    num('POWERUP_DUR_' + tipo, POWERUP[tipo].duracao);
  }
  num('POWERUP_PRIMEIRO_S', POWERUP_PRIMEIRO_S);
  num('POWERUP_INTERVALO_S', POWERUP_INTERVALO_S);
  num('POWERUP_JITTER_S', POWERUP_JITTER_S);
  num('POWERUP_VIDA_NO_MAPA_S', POWERUP_VIDA_NO_MAPA_S);
  inteiro('POWERUP_MAX_NO_CHAO', POWERUP_MAX_NO_CHAO);
  num('POWERUP_RAIO', POWERUP_RAIO);
  num('POWERUP_QUEDA_S', POWERUP_QUEDA_S);

  // As três receitas de bot. Tuning como qualquer outro: um `ticksDeReacao` diferente de um lado
  // só apareceria como uma divergência de input no meio da partida, sem dizer por quê.
  for (const nivel of NIVEIS_DE_BOT) {
    const c = BOT_DIFFICULTY[nivel];
    sink.registro(SEC.maze, 'bot', nivel, f(c.aimErrorRad), f(c.turnThreshold), i(c.ticksDeReacao),
      f(c.horizonteDeAmeaca), c.ricocheteia, c.evitaAutogol, c.usaParede);
  }

  for (let n = 2; n <= 10; n++) {
    const d = MAZE_BY_PLAYERS[n];
    sink.registro(SEC.maze, 'densidade', i(n), i(d.cols), i(d.rows), f(d.braidPct));
    sink.registro(SEC.maze, 'municao', i(n), i(MAX_BULLETS_BY_PLAYERS[n]));
  }
}


/** Espelho de `paridade.DirecoesDeMovimento`. */
export function direcoes(sink) {
  for (let bits = 0; bits < 16; bits++) {
    const up = (bits & 1) !== 0;
    const down = (bits & 2) !== 0;
    const left = (bits & 4) !== 0;
    const right = (bits & 8) !== 0;
    const ang = direcaoDeMovimento(up, down, left, right);
    sink.registro(SEC.maze, 'direcao', i(bits), ang !== null, f(ang ?? 0));
  }
}

// ===========================================================================================
// Cenário dos BOTS — espelho de `paridade/cenario_bots.go`
// ===========================================================================================
//
// O que ele compara NÃO é o placar nem a posição final: é a SEQUÊNCIA DE `Input` que cada bot
// produz, tick a tick. Um bot que chega ao mesmo canto do labirinto por um caminho diferente já é
// divergência, e só a sequência de comandos pega isso.
//
// Os itens que alimentam `mundo.powerups` são SINTÉTICOS aqui, e não saem de `agendaDePowerUps`:
// se saíssem, uma divergência na agenda derrubaria as duas etapas ao mesmo tempo e os dois números
// deixariam de ser independentes.

export const TICKS_BOTS_PADRAO = 300;

const ITENS_SINTETICOS = 3;
const CICLO_DO_ITEM = 240;
const ITEM_NO_CHAO_ATE = 150;
const PASSO_ENTRE_ITENS = 37;

/** Espelho de `paridade.sementeDoBot`. Sementes diferentes por bot são o que espalha as fases. */
function sementeDoBot(seed, k) {
  return (((seed ^ 0x0b07b07b) >>> 0) + k * 0x9e3779b9) >>> 0;
}

/** Espelho de `paridade.nivelDoBot`. */
function nivelDoBot(seed, k) {
  return NIVEIS_DE_BOT[(seed + k) % 3];
}

/** Espelho de `paridade.inimigoMaisProximo` — o mesmo alvo que o `TankRoom` escolhe. */
function inimigoMaisProximo(state, eu) {
  let melhor = null;
  let melhorDist2 = 0;
  for (const tank of state.tanks.values()) {
    if (tank.id === eu.id || !tank.alive) continue;
    const dx = tank.x - eu.x;
    const dy = tank.y - eu.y;
    const dist2 = dx * dx + dy * dy;
    if (melhor === null || dist2 < melhorDist2) {
      melhorDist2 = dist2;
      melhor = tank;
    }
  }
  // Cópia, e não o próprio tanque: o bot guarda a posição do alvo de um tick para o outro para
  // estimar a velocidade dele, e uma referência viva faria a diferença dar sempre zero.
  return melhor ? { x: melhor.x, y: melhor.y } : null;
}

function novoTanque(k, p, n) {
  return {
    id: nomeTanque(k),
    x: p.x,
    y: p.y,
    heading: (k * DOIS_PI) / n,
    turret: (k * DOIS_PI) / n,
    alive: true,
    fireCooldownLeft: 0,
    ricochete: 0,
    municao: 0,
    recarga: 0,
    turbo: 0,
  };
}

function registrarSimulacao(sink, state, t) {
  for (const tank of state.tanks.values()) {
    sink.registro(SEC.sim, 'tanque', i(t), tank.id, f(tank.x), f(tank.y), f(tank.heading),
      f(tank.turret), tank.alive, f(tank.fireCooldownLeft));
  }
  for (const b of state.bullets) {
    sink.registro(SEC.sim, 'bala', i(t), b.id, b.ownerId, f(b.x), f(b.y), f(b.vx), f(b.vy),
      i(b.bounces), f(b.age), i(b.ricochete ?? 0));
  }
}

function coberturaVazia() {
  return {
    seeds: 0,
    seedsComColeta: 0,
    seedsComMorte: 0,
    seedsComDisparo: 0,
    coletas: 0,
    finsDeEfeito: 0,
    disparos: 0,
    disparosCarimbados: 0,
    mortes: 0,
  };
}

/** Espelho de `paridade.ExecutarBots`. */
export function executarBots(seed, ticks, sink) {
  const cob = coberturaVazia();
  cob.seeds = 1;

  const { players, aspect } = cenario(seed);
  const n = players;

  const maze = makeMaze(seed, players, aspect);
  sink.registro(SEC.maze, 'maze', i(maze.cols), i(maze.rows), f(maze.cell), i(maze.walls.length));

  const rngSpawn = mulberry32(seed ^ 0x9e3779b9);
  const spawns = spawnPoints(maze, n, rngSpawn);

  const tanks = new Map();
  const ordem = [];
  for (let k = 0; k < n; k++) {
    const tank = novoTanque(k, spawns[k], n);
    tanks.set(tank.id, tank);
    ordem.push(tank);
    sink.registro(SEC.spawns, 'spawn', i(k), f(spawns[k].x), f(spawns[k].y));
  }
  const state = { tick: 0, maze, tanks, bullets: [], nextBulletId: 0 };

  const bots = [];
  for (let k = 0; k < n; k++) {
    const nivel = nivelDoBot(seed, k);
    bots.push(makeBot(mulberry32(sementeDoBot(seed, k)), BOT_DIFFICULTY[nivel]));
    sink.registro(SEC.bots, 'nivel', i(k), nomeTanque(k), nivel);
  }

  const rngItens = mulberry32(seed ^ 0x17e11a5b);
  const posicoes = [];
  for (let k = 0; k < ITENS_SINTETICOS; k++) {
    const p = cellCenter(maze, rngItens.int(maze.cols), rngItens.int(maze.rows));
    posicoes.push(p);
    sink.registro(SEC.bots, 'item', i(k), f(p.x), f(p.y));
  }

  const dt = 1 / TICK_HZ;
  const inputs = new Map();
  const itens = [];

  for (let t = 0; t < ticks; t++) {
    state.tick = t;

    itens.length = 0;
    for (let k = 0; k < ITENS_SINTETICOS; k++) {
      if ((t + k * PASSO_ENTRE_ITENS) % CICLO_DO_ITEM < ITEM_NO_CHAO_ATE) itens.push(posicoes[k]);
    }
    const mundo = { bullets: state.bullets, powerups: itens };

    inputs.clear();
    for (let k = 0; k < ordem.length; k++) {
      const tank = ordem[k];
      if (!tank.alive) continue;
      const alvo = inimigoMaisProximo(state, tank);
      if (!alvo) continue;
      const input = bots[k].think(tank, alvo, maze, t, mundo);
      inputs.set(tank.id, input);
      sink.registro(SEC.bots, 'input', i(t), tank.id, f(input.mover ?? 0), input.mover !== null,
        input.fire, f(input.aim ?? 0), input.aim !== undefined);
    }

    const eventos = step(state, inputs, dt);
    registrarSimulacao(sink, state, t);
    for (const ev of eventos) {
      registrarEvento(sink, ev);
      if (ev.type === 'shot') cob.disparos++;
      else if (ev.type === 'death') cob.mortes++;
    }
  }

  sink.registro(SEC.sim, 'final', i(state.tick), i(state.bullets.length), i(state.nextBulletId));
  if (cob.mortes > 0) cob.seedsComMorte = 1;
  if (cob.disparos > 0) cob.seedsComDisparo = 1;
  return cob;
}

// ===========================================================================================
// Cenário dos POWER-UPS — espelho de `paridade/cenario_powerups.go`
// ===========================================================================================

export const TICKS_POWERUPS_PADRAO = 600;

/**
 * Probabilidade de cada tanque começar a rodada com cada um dos quatro efeitos ligados.
 *
 * Existe porque a agenda sozinha não cobriria o assunto em 600 ticks: sem efeito na largada não há
 * bala carimbada antes do tick 240, e a EXPIRAÇÃO — que é a armadilha do ricochete — nunca
 * aconteceria dentro da janela. Ligar pelo relógio de verdade (`efeitos.aplicar`), e não
 * escrevendo nos campos do tanque à mão, é o que faz este atalho exercitar o código em vez de
 * contorná-lo.
 */
const CHANCE_DE_EFEITO_INICIAL = 0.35;

/** Espelho de `paridade.itemMaisPerto`. */
function itemMaisPerto(tank, itens) {
  let melhor = null;
  let melhorDist2 = Infinity;
  for (const item of itens) {
    const dx = item.x - tank.x;
    const dy = item.y - tank.y;
    const dist2 = dx * dx + dy * dy;
    if (dist2 < melhorDist2) {
      melhorDist2 = dist2;
      melhor = item;
    }
  }
  return melhor;
}

/**
 * Espelho de `paridade.montarInputsColetor`: o roteiro do cenário de partida com UMA diferença —
 * havendo item no chão, o tanque anda na direção dele. Sem isso a etapa seria vazia: tanques
 * andando ao acaso quase nunca encostam num item de 15 px de raio.
 */
function montarInputsColetor(state, rng, direcoes, inputs, itens) {
  const tanques = [...state.tanks.values()];
  const n = tanques.length;
  for (let k = 0; k < n; k++) {
    const tank = tanques[k];
    const p1 = rng.next();
    const p2 = rng.next();
    const p3 = rng.next();
    const p4 = rng.next();

    if (p1 < 0.1) direcoes[k] = Math.floor(p2 * 17);

    const alvo = tanques[(k + 1) % n];
    const aim = Math.atan2(alvo.y - tank.y, alvo.x - tank.x) + (p4 * 0.6 - 0.3);

    const item = itemMaisPerto(tank, itens);
    let mover = null;
    if (item) mover = Math.atan2(item.y - tank.y, item.x - tank.x);
    else if (direcoes[k] < 16) mover = (direcoes[k] * DOIS_PI) / 16;

    inputs.set(tank.id, { mover, fire: p3 < 0.06, aim });
  }
}

/** Espelho de `paridade.ExecutarPowerups`. */
export function executarPowerups(seed, ticks, sink) {
  const cob = coberturaVazia();
  cob.seeds = 1;

  const { players, aspect } = cenario(seed);
  const n = players;

  const maze = makeMaze(seed, players, aspect);
  sink.registro(SEC.maze, 'maze', i(maze.cols), i(maze.rows), f(maze.cell), i(maze.walls.length));

  const campo = new CampoDePowerUps(maze, seed);
  for (const item of campo.agenda) {
    sink.registro(SEC.powerups, 'agenda', i(item.id), item.tipo, f(item.x), f(item.y),
      i(item.nasceEmTick), i(item.sumeEmTick));
  }

  const rngSpawn = mulberry32(seed ^ 0x9e3779b9);
  const spawns = spawnPoints(maze, n, rngSpawn);

  const tanks = new Map();
  const ordem = [];
  for (let k = 0; k < n; k++) {
    const tank = novoTanque(k, spawns[k], n);
    tanks.set(tank.id, tank);
    ordem.push(tank);
    sink.registro(SEC.spawns, 'spawn', i(k), f(spawns[k].x), f(spawns[k].y));
  }
  const state = { tick: 0, maze, tanks, bullets: [], nextBulletId: 0 };

  const efeitos = new EfeitosDePowerUp();
  const rngPower = mulberry32(seed ^ 0xa5a5a5a5);
  for (let k = 0; k < n; k++) {
    const tank = ordem[k];
    for (const tipo of TIPOS_DE_POWERUP) {
      if (rngPower.next() < CHANCE_DE_EFEITO_INICIAL) efeitos.aplicar(tank, tipo);
    }
    sink.registro(SEC.powerups, 'inicial', i(k), i(tank.ricochete), i(tank.municao),
      f(tank.recarga), f(tank.turbo));
  }

  const rngRoteiro = mulberry32(seed ^ 0x5f356495);
  const dt = 1 / TICK_HZ;
  const inputs = new Map();
  const direcoes = new Array(n).fill(16); // 16 = parado

  for (let t = 0; t < ticks; t++) {
    state.tick = t;

    const itens = campo.noChao(t);
    sink.registro(SEC.powerups, 'chao', i(t), i(itens.length));
    for (const item of itens) {
      sink.registro(SEC.powerups, 'item', i(t), i(item.id), item.tipo, f(item.x), f(item.y));
    }
    // `caindo` usa um buffer próprio, então chamar aqui não estraga `itens`.
    const noAr = campo.caindo(t);
    sink.registro(SEC.powerups, 'ar', i(t), i(noAr.length));
    for (const item of noAr) sink.registro(SEC.powerups, 'caindo', i(t), i(item.id));

    montarInputsColetor(state, rngRoteiro, direcoes, inputs, itens);
    const eventos = step(state, inputs, dt);

    registrarSimulacao(sink, state, t);
    for (const ev of eventos) {
      registrarEvento(sink, ev);
      if (ev.type === 'shot') {
        cob.disparos++;
        if ((ev.ricochete ?? 0) > 0) cob.disparosCarimbados++;
      } else if (ev.type === 'death') {
        cob.mortes++;
      }
    }

    // Primeiro o que ACABOU, depois o que foi PEGO — a mesma ordem do `TankRoom`.
    for (const fim of efeitos.passo(state.tanks, dt)) {
      sink.registro(SEC.powerups, 'fim', i(t), fim.tankId, fim.tipo);
      cob.finsDeEfeito++;
    }
    for (const coleta of campo.coletar(state, t)) {
      const tank = state.tanks.get(coleta.tankId);
      if (tank) efeitos.aplicar(tank, coleta.tipo);
      sink.registro(SEC.powerups, 'coleta', i(t), i(coleta.itemId), coleta.tipo, coleta.tankId,
        f(coleta.x), f(coleta.y));
      cob.coletas++;
    }

    for (const tank of state.tanks.values()) {
      sink.registro(SEC.powerups, 'campos', i(t), tank.id, i(tank.ricochete ?? 0),
        i(tank.municao ?? 0), f(tank.recarga ?? 0), f(tank.turbo ?? 0));
      for (const ef of efeitos.ativos(tank.id)) {
        sink.registro(SEC.powerups, 'efeito', i(t), tank.id, ef.tipo, f(ef.restante), f(ef.duracao));
      }
    }
  }

  sink.registro(SEC.sim, 'final', i(state.tick), i(state.bullets.length), i(state.nextBulletId),
    i(rngRoteiro.getState() >>> 0));

  if (cob.coletas > 0) cob.seedsComColeta = 1;
  if (cob.mortes > 0) cob.seedsComMorte = 1;
  if (cob.disparos > 0) cob.seedsComDisparo = 1;
  return cob;
}

// --- CLI ---

/**
 * Os três cenários. `secoes` é o que entra na linha de resumo, e é por isso que cada cenário tem
 * as suas: separar permite dizer "os inputs bateram, o que divergiu foi a trajetória" sem abrir o
 * dump. O cenário `partida` continua com as quatro seções e o mesmo formato de sempre.
 */
const CENARIOS = {
  partida: {
    executar: (seed, ticks, sink) => {
      executar(seed, ticks, sink);
      const cob = coberturaVazia();
      cob.seeds = 1;
      return cob;
    },
    ticks: TICKS_PADRAO,
    secoes: [SEC.maze, SEC.spawns, SEC.sim, SEC.eventos],
  },
  bots: { executar: executarBots, ticks: TICKS_BOTS_PADRAO, secoes: [SEC.bots, SEC.sim, SEC.eventos] },
  powerups: {
    executar: executarPowerups,
    ticks: TICKS_POWERUPS_PADRAO,
    secoes: [SEC.powerups, SEC.sim, SEC.eventos],
  },
};

function arg(nome, padrao) {
  const idx = process.argv.indexOf(`--${nome}`);
  return idx >= 0 ? process.argv[idx + 1] : padrao;
}

const modo = arg('modo', 'resumo');

if (modo === 'constantes') {
  const d = new Detalhador();
  constantes(d);
  direcoes(d);
  process.stdout.write(d.texto());
} else {
  const nomeCenario = arg('cenario', 'partida');
  const cen = CENARIOS[nomeCenario];
  if (!cen) throw new Error(`cenário desconhecido: ${nomeCenario}`);
  const ticks = Number(arg('ticks', 0)) || cen.ticks;

  if (modo === 'detalhe') {
    const d = new Detalhador();
    cen.executar(Number(arg('seed', 0)) >>> 0, ticks, d);
    process.stdout.write(d.texto());
  } else {
    const de = Number(arg('de', 0));
    const ate = Number(arg('ate', 1000));
    const partes = [];
    const soma = coberturaVazia();
    for (let seed = de; seed < ate; seed++) {
      const r = new Resumidor();
      const parcial = cen.executar(seed >>> 0, ticks, r);
      for (const chave of Object.keys(soma)) soma[chave] += parcial[chave];
      const res = r.resumos();
      partes.push(`${seed} ${cen.secoes.map((s) => res[s]).join(' ')}\n`);
      // Escoa em blocos para não segurar 10.000 linhas na memória junto com o resto.
      if (partes.length >= 256) {
        process.stdout.write(partes.join(''));
        partes.length = 0;
      }
    }
    if (partes.length) process.stdout.write(partes.join(''));
    // A última linha não é um resumo: é o que a varredura REALMENTE exercitou. Espelho do
    // `#cobertura` do lado Go — sem ele, "10.000/10.000 bateram" não distingue "provei" de "os
    // dois lados não fizeram nada".
    const ordem = ['seeds', 'seedsComDisparo', 'seedsComMorte', 'seedsComColeta', 'disparos',
      'disparosCarimbados', 'mortes', 'coletas', 'finsDeEfeito'];
    const rotulos = ['seeds', 'seeds_com_disparo', 'seeds_com_morte', 'seeds_com_coleta', 'disparos',
      'disparos_carimbados', 'mortes', 'coletas', 'fins_de_efeito'];
    process.stdout.write(`#cobertura ${ordem.map((c, k) => `${rotulos[k]} ${soma[c]}`).join(' ')}\n`);
  }
}
