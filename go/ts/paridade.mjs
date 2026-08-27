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
  POWERUP_MAX_RICOCHETE_EXTRA,
  ROUNDS,
  ROUND_TIMEOUT,
  SELF_IMMUNITY,
  SNAPSHOT_HZ,
  SPAWN_LOS_MIN_DIST,
  TANK_RADIUS,
  TANK_RADIUS_F,
  TANK_SPEED,
  TICK_HZ,
  TURN_RATE,
  TURRET_RATE,
  WALL_THICKNESS,
  WALL_THICKNESS_F,
  direcaoDeMovimento,
} from '../../packages/protocol/src/index.ts';
import {
  cellOf,
  countDeadEnds,
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
  for (const tipo of ["ricochete", "municao", "recarga", "turbo"]) {
    num('POWERUP_' + tipo, POWERUP[tipo].valor);
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

// --- CLI ---

function arg(nome, padrao) {
  const idx = process.argv.indexOf(`--${nome}`);
  return idx >= 0 ? process.argv[idx + 1] : padrao;
}

const modo = arg('modo', 'resumo');
const ticks = Number(arg('ticks', TICKS_PADRAO));

if (modo === 'detalhe') {
  const d = new Detalhador();
  executar(Number(arg('seed', 0)) >>> 0, ticks, d);
  process.stdout.write(d.texto());
} else if (modo === 'constantes') {
  const d = new Detalhador();
  constantes(d);
  direcoes(d);
  process.stdout.write(d.texto());
} else {
  const de = Number(arg('de', 0));
  const ate = Number(arg('ate', 1000));
  const partes = [];
  for (let seed = de; seed < ate; seed++) {
    const r = new Resumidor();
    executar(seed >>> 0, ticks, r);
    partes.push(`${seed} ${r.resumos().join(' ')}\n`);
    // Escoa em blocos para não segurar 10.000 linhas na memória junto com o resto.
    if (partes.length >= 256) {
      process.stdout.write(partes.join(''));
      partes.length = 0;
    }
  }
  if (partes.length) process.stdout.write(partes.join(''));
}
