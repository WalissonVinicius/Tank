// Verificação empírica da vida da bala (Fase 6, §6): mede quanto tempo uma bala fica no ar e
// quantos ricochetes ela realmente dá — nos DOIS caminhos que existem no jogo:
//
//   1. modo local  — `step()` da shared-sim direto, a bala nasce do input de tiro;
//   2. modo online — `BulletPredictor`, a bala nasce de um `bullet_spawn` vindo do servidor.
//
// Os dois usam a mesma `step()`, e o teste de paridade abaixo prova que a bala morre no MESMO
// tick nos dois caminhos, e não só que cada um respeita a vida útil isoladamente.
//
// Fase 10: a regra voltou a ter DUAS causas de morte por conta própria, e o que vale é a que
// chegar primeiro — o 2º toque de parede (`MAX_BOUNCES = 1`) ou os `BULLET_LIFE` = 2,2 s. É
// exatamente esse "o que vier primeiro" que estes testes medem, nos dois caminhos do jogo.
import { describe, expect, it } from 'vitest';
import { BULLET_LIFE, BULLET_SPEED, CELL, FIRE_COOLDOWN, MAX_BOUNCES, TICK_HZ } from '@tank/protocol';
import { makeMaze, mulberry32, spawnPoints, step } from '@tank/shared-sim';
import type { Aabb, Input, Maze, SimState, Tank } from '@tank/shared-sim';
import { BulletPredictor } from '../src/net/bullets.js';

const DT = 1 / TICK_HZ;
const PARADO: Input = { turn: 0, move: 0, fire: false };

/** Caixa retangular oca: 4 paredes grossas, nada dentro. É o "corredor livre" da medição. */
function caixa(largura: number, altura: number): Maze {
  const t = 20;
  const walls: Aabb[] = [
    { x: 0, y: 0, w: largura, h: t },
    { x: 0, y: altura - t, w: largura, h: t },
    { x: 0, y: 0, w: t, h: altura },
    { x: largura - t, y: 0, w: t, h: altura },
  ];
  return { cols: Math.round(largura / CELL), rows: Math.round(altura / CELL), cell: CELL, walls };
}

interface Medida {
  /** Segundos que a bala passou no ar, do tiro ao evento que a tirou de cena. */
  vida: number;
  /** Quantos eventos `bounce` ela gerou ao longo da vida. O de nº MAX_BOUNCES + 1 é o que a mata. */
  ricochetes: number;
  motivo: 'life' | 'max_bounces' | 'nunca_morreu';
}

/**
 * Dispara UMA bala pelo caminho local (tanque + input de tiro) e mede a vida dela.
 *
 * Assim que o tiro sai, o tanque é desligado (`alive = false`): senão a bala que volta pelo
 * ricochete mata o próprio dono e sai de cena por acerto, não por tempo — e o que se quer medir
 * aqui é a vida da bala, exatamente como o `BulletPredictor` do modo online a vê (lá não existe
 * tanque nenhum na simulação).
 */
function medirLocal(maze: Maze, x: number, y: number, angulo: number, tetoTicks = 1200): Medida {
  const tank: Tank = { id: 'p0', x, y, heading: angulo, turret: angulo, alive: true, fireCooldownLeft: 0 };
  const state: SimState = { tick: 0, maze, tanks: new Map([['p0', tank]]), bullets: [], nextBulletId: 0 };
  const inputs = new Map<string, Input>([['p0', { turn: 0, move: 0, fire: true, aim: angulo }]]);

  let tickDoTiro = -1;
  let ricochetes = 0;
  for (let t = 0; t < tetoTicks; t++) {
    const eventos = step(state, tickDoTiro < 0 ? inputs : new Map([['p0', PARADO]]), DT);
    state.tick++;
    for (const ev of eventos) {
      if (ev.type === 'shot') {
        tickDoTiro = t;
        tank.alive = false;
      } else if (ev.type === 'bounce') ricochetes++;
      else if (ev.type === 'bullet_expired') {
        return { vida: (t - tickDoTiro + 1) * DT, ricochetes, motivo: ev.reason };
      }
    }
  }
  return { vida: (tetoTicks - tickDoTiro) * DT, ricochetes, motivo: 'nunca_morreu' };
}

/** Mesma medição pelo caminho online: a bala entra por `bullet_spawn` no BulletPredictor. */
function medirOnline(maze: Maze, x: number, y: number, angulo: number, tetoTicks = 1200): Medida {
  const preditor = new BulletPredictor(maze);
  preditor.spawn({ id: 'b0', ownerId: 'p0', x, y, angle: angulo, tick: 0 });

  let ricochetes = 0;
  for (let t = 0; t < tetoTicks; t++) {
    for (const ev of preditor.tick(DT)) {
      if (ev.type === 'bounce') ricochetes++;
      else if (ev.type === 'bullet_expired') return { vida: (t + 1) * DT, ricochetes, motivo: ev.reason };
    }
  }
  return { vida: tetoTicks * DT, ricochetes, motivo: 'nunca_morreu' };
}

/** Reproduz o ponto/ângulo de saída que a `step()` usa, para alimentar o caminho online. */
function tiroDe(maze: Maze, x: number, y: number, angulo: number): { x: number; y: number; angle: number } {
  const tank: Tank = { id: 'p0', x, y, heading: angulo, turret: angulo, alive: true, fireCooldownLeft: 0 };
  const state: SimState = { tick: 0, maze, tanks: new Map([['p0', tank]]), bullets: [], nextBulletId: 0 };
  const eventos = step(state, new Map([['p0', { turn: 0, move: 0, fire: true, aim: angulo }]]), DT);
  const tiro = eventos.find((e) => e.type === 'shot');
  if (!tiro || tiro.type !== 'shot') throw new Error('o tanque não atirou');
  return { x: tiro.x, y: tiro.y, angle: tiro.angle };
}

describe('vida da bala — corredor livre', () => {
  it('morre por fim de vida em BULLET_LIFE segundos quando nada atrapalha', () => {
    // Corredor bem mais comprido que o alcance da bala (215 px/s x 2,2 s = 473 px): ela não
    // encosta em nada e o único jeito de sair de cena é o relógio.
    const maze = caixa(2400, 400);
    const m = medirLocal(maze, 200, 200, 0);
    expect(m.motivo).toBe('life');
    expect(m.ricochetes).toBe(0);
    expect(m.vida).toBeGreaterThanOrEqual(BULLET_LIFE);
    expect(m.vida).toBeLessThanOrEqual(BULLET_LIFE + 2 * DT);
  });

  it('percorre BULLET_SPEED x BULLET_LIFE pixels antes de expirar', () => {
    const maze = caixa(2400, 400);
    const state: SimState = { tick: 0, maze, tanks: new Map(), bullets: [], nextBulletId: 0 };
    state.bullets.push({ id: 'b', ownerId: 'p', x: 100, y: 200, vx: BULLET_SPEED, vy: 0, bounces: 0, age: 0 });
    let ticks = 0;
    while (state.bullets.length > 0 && ticks < 1200) {
      step(state, new Map(), DT);
      state.tick++;
      ticks++;
    }
    // O corte é `age > BULLET_LIFE`, estrito: a bala ainda vive o tick em que a idade chega a
    // 2,2 s e some no seguinte — 133 ticks, 2,217 s. O alcance é essa vida vezes a velocidade.
    expect(ticks).toBe(Math.floor(BULLET_LIFE * TICK_HZ) + 1);
    expect(ticks * DT).toBeGreaterThanOrEqual(BULLET_LIFE);
    expect(ticks * DT).toBeLessThanOrEqual(BULLET_LIFE + 2 * DT);
    expect(BULLET_SPEED * ticks * DT).toBeGreaterThanOrEqual(BULLET_SPEED * BULLET_LIFE);
  });

  // Fase 10: a caixa curta é o teste da regra nova. A bala bate na parede logo no começo, quica
  // uma vez e morre no toque seguinte — muito antes do teto de 2,2 s.
  it('na caixa curta ricocheteia UMA vez e morre na parede, bem antes do teto de tempo', () => {
    const maze = caixa(300, 300);
    const m = medirLocal(maze, 150, 150, 0);
    expect(m.motivo).toBe('max_bounces');
    expect(m.ricochetes, 'o rebote permitido mais o que a mata').toBe(MAX_BOUNCES + 1);
    expect(m.vida).toBeLessThan(BULLET_LIFE);
  });
});

describe('vida da bala — labirintos reais, várias seeds', () => {
  it('nenhuma bala passa de MAX_BOUNCES + 1 rebotes nem de BULLET_LIFE segundos', () => {
    const medidas: Medida[] = [];
    for (const seed of [1, 7, 42, 99, 1234, 31337]) {
      const maze = makeMaze(seed, 6);
      const spawns = spawnPoints(maze, 6, mulberry32(seed));
      for (const sp of spawns) {
        for (let k = 0; k < 8; k++) medidas.push(medirLocal(maze, sp.x, sp.y, (k * Math.PI) / 4));
      }
    }
    expect(medidas.length).toBeGreaterThan(200);
    // Duas causas de morte por conta própria, e nada além delas.
    expect(medidas.every((m) => m.motivo === 'life' || m.motivo === 'max_bounces')).toBe(true);
    // Nenhuma bala ultrapassa o teto de rebotes nem o teto de tempo.
    expect(medidas.every((m) => m.ricochetes <= MAX_BOUNCES + 1)).toBe(true);
    expect(medidas.every((m) => m.vida <= BULLET_LIFE + 2 * DT)).toBe(true);
    // Quem morre na parede sempre gastou o rebote permitido mais o que a matou; quem morre por
    // tempo viveu os 2,2 s inteiros. As duas populações são disjuntas por construção.
    const naParede = medidas.filter((m) => m.motivo === 'max_bounces');
    const noRelogio = medidas.filter((m) => m.motivo === 'life');
    expect(naParede.every((m) => m.ricochetes === MAX_BOUNCES + 1)).toBe(true);
    expect(naParede.every((m) => m.vida < BULLET_LIFE)).toBe(true);
    expect(noRelogio.every((m) => m.vida >= BULLET_LIFE)).toBe(true);
    expect(naParede.length / medidas.length).toBeGreaterThan(0.5);
    // Dentro do labirinto de verdade a parede é a causa DOMINANTE: medido aqui, ~63% das balas
    // morrem no 2º toque e o resto atravessa um corredor livre até o teto de tempo. O piso de
    // 0,5 é a afirmação que interessa — quem encurta a bala é o ricochete, não o relógio.
  });
});

describe('paridade local x online', () => {
  it('a mesma bala morre no mesmo tick e no mesmo ponto nos dois caminhos', () => {
    for (const seed of [1, 42, 1234]) {
      const maze = makeMaze(seed, 6);
      const spawns = spawnPoints(maze, 6, mulberry32(seed));
      for (const sp of spawns) {
        for (let k = 0; k < 8; k++) {
          const ang = (k * Math.PI) / 4;
          const local = medirLocal(maze, sp.x, sp.y, ang);
          // O ponto de spawn da bala é o mesmo que a `step()` calcula (boca do cano) — no
          // online é ele que viaja no `bullet_spawn`.
          const boca = tiroDe(maze, sp.x, sp.y, ang);
          const online = medirOnline(maze, boca.x, boca.y, boca.angle);
          expect(online.motivo).toBe(local.motivo);
          expect(online.ricochetes).toBe(local.ricochetes);
          expect(online.vida).toBeCloseTo(local.vida, 6);
        }
      }
    }
  });

  it('a trajetória bate tick a tick entre os dois caminhos', () => {
    const maze = makeMaze(42, 6);
    const sp = spawnPoints(maze, 6, mulberry32(42))[0]!;
    const ang = 0.7;
    const boca = tiroDe(maze, sp.x, sp.y, ang);

    const tank: Tank = { id: 'p0', x: sp.x, y: sp.y, heading: ang, turret: ang, alive: true, fireCooldownLeft: 0 };
    const state: SimState = { tick: 0, maze, tanks: new Map([['p0', tank]]), bullets: [], nextBulletId: 0 };
    step(state, new Map([['p0', { turn: 0, move: 0, fire: true, aim: ang }]]), DT);
    state.tick++;
    tank.alive = false; // mesma razão do `medirLocal`: a bala não pode morrer no próprio dono

    const preditor = new BulletPredictor(maze);
    preditor.spawn({ id: 'b0', ownerId: 'p0', x: boca.x, y: boca.y, angle: boca.angle, tick: 0 });
    // O tick que criou a bala no modo local já a moveu; o preditor precisa do mesmo passo para
    // os dois relógios ficarem alinhados.
    preditor.tick(DT);

    for (let t = 0; t < 240; t++) {
      const a = state.bullets[0];
      const b = preditor.bullets[0];
      expect(a === undefined).toBe(b === undefined);
      if (!a || !b) break;
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.y).toBeCloseTo(a.y, 6);
      expect(b.age).toBeCloseTo(a.age, 6);
      step(state, new Map([['p0', PARADO]]), DT);
      state.tick++;
      preditor.tick(DT);
    }
  });
});

// Guarda-chuva contra regressão de tuning: se alguém mexer nas constantes, os testes acima
// passam a medir outra coisa e este aqui denuncia.
it('as constantes medidas são as da Fase 10', () => {
  expect(MAX_BOUNCES).toBe(1);
  expect(BULLET_LIFE).toBe(2.2);
  expect(FIRE_COOLDOWN).toBeGreaterThan(0);
  expect(CELL).toBe(84);
});
