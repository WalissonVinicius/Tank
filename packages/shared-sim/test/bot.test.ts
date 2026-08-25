import { describe, expect, it } from 'vitest';
import { CELL, TICK_HZ } from '@tank/protocol';
import { hasLineOfSight, makeBot, makeMaze, mulberry32, nextStepTowards, step } from '@tank/shared-sim';
import type { Input, SimState, Tank, Vec2 } from '@tank/shared-sim';

const DT = 1 / TICK_HZ;

function tanque(id: string, x: number, y: number, heading = 0): Tank {
  return { id, x, y, heading, turret: heading, alive: true, fireCooldownLeft: 0 };
}

describe('makeBot — IA única de cliente e servidor', () => {
  it('devolve inputs idênticos para dois bots com o mesmo seed (determinismo)', () => {
    const maze = makeMaze(42, 6);
    const a = makeBot(mulberry32(1234));
    const b = makeBot(mulberry32(1234));

    const alvo: Vec2 = { x: maze.cols * CELL - CELL / 2, y: maze.rows * CELL - CELL / 2 };
    const tankA = tanque('a', CELL / 2, CELL / 2);
    const tankB = tanque('b', CELL / 2, CELL / 2);

    for (let tick = 0; tick < 300; tick++) {
      const inA = a.think(tankA, alvo, maze, tick);
      const inB = b.think(tankB, alvo, maze, tick);
      expect(inA).toEqual(inB);
      // avança os dois de verdade para o estado divergir se a IA não for determinística
      for (const [tank, input] of [
        [tankA, inA],
        [tankB, inB],
      ] as [Tank, Input][]) {
        const state: SimState = { tick, maze, tanks: new Map([[tank.id, tank]]), bullets: [], nextBulletId: 0 };
        step(state, new Map([[tank.id, input]]), DT);
      }
      expect(tankA.x).toBeCloseTo(tankB.x, 10);
      expect(tankA.y).toBeCloseTo(tankB.y, 10);
    }
  });

  // Fase 4: o bot ganhou a mesma torre livre do jogador. Ele mira no INIMIGO mesmo quando o
  // chassi está indo para outro lado (contornando parede), e sofre o mesmo TURRET_RATE.
  it('aponta a torre para o inimigo mesmo com o chassi virado para outra direção', () => {
    const maze = makeMaze(42, 6);
    const bot = makeBot(mulberry32(7));
    // Inimigo à direita, chassi virado para trás.
    const alvo: Vec2 = { x: CELL * 1.5, y: CELL / 2 };
    const tank = tanque('bot', CELL / 2, CELL / 2, Math.PI);

    const input = bot.think(tank, alvo, maze, 0);
    expect(input.aim).toBeDefined();
    // mira ≈ leste (0 rad), dentro do erro de mira da dificuldade média (0,18 rad)
    expect(Math.abs(input.aim!)).toBeLessThan(0.2);
  });

  it('a torre do bot obedece TURRET_RATE — não pula para o alvo em um tick', () => {
    const maze = makeMaze(42, 6);
    const bot = makeBot(mulberry32(11));
    const alvo: Vec2 = { x: CELL * 1.5, y: CELL / 2 };
    const tank = tanque('bot', CELL / 2, CELL / 2, Math.PI);
    tank.turret = Math.PI; // torre começa apontada para o lado oposto do alvo

    const input = bot.think(tank, alvo, maze, 0);
    const state: SimState = { tick: 0, maze, tanks: new Map([[tank.id, tank]]), bullets: [], nextBulletId: 0 };
    step(state, new Map([[tank.id, input]]), DT);

    // Andou só um passo de giro na direção do alvo, não a meia-volta inteira.
    expect(Math.abs(Math.PI - Math.abs(tank.turret))).toBeGreaterThan(0);
    expect(Math.abs(Math.PI - Math.abs(tank.turret))).toBeLessThan(0.2);
  });

  it('nextStepTowards devolve um vizinho conectado, nunca atravessa parede', () => {
    const maze = makeMaze(7, 6);
    const de = { x: CELL / 2, y: CELL / 2 };
    const para = { x: (maze.cols - 0.5) * CELL, y: (maze.rows - 0.5) * CELL };
    const passo = nextStepTowards(maze, de, para);

    expect(Math.hypot(passo.x - de.x, passo.y - de.y)).toBeLessThanOrEqual(CELL + 1e-6);
    expect(hasLineOfSight(de, passo, maze.walls)).toBe(true);
  });

  it('sem linha de visão o bot navega e diminui a distância de grafo até o alvo', () => {
    const maze = makeMaze(99, 6);
    const alvo: Vec2 = { x: (maze.cols - 0.5) * CELL, y: (maze.rows - 0.5) * CELL };
    const tank = tanque('bot', CELL / 2, CELL / 2);
    const bot = makeBot(mulberry32(2024));

    const distInicial = Math.hypot(alvo.x - tank.x, alvo.y - tank.y);
    let melhorDist = distInicial;

    for (let tick = 0; tick < 60 * TICK_HZ; tick++) {
      const input = bot.think(tank, alvo, maze, tick);
      const state: SimState = { tick, maze, tanks: new Map([[tank.id, tank]]), bullets: [], nextBulletId: 0 };
      step(state, new Map([[tank.id, input]]), DT);
      melhorDist = Math.min(melhorDist, Math.hypot(alvo.x - tank.x, alvo.y - tank.y));
      if (melhorDist < CELL) break;
    }

    // O bot da Fase 2 travava na primeira parede; com pathing ele chega perto do alvo.
    expect(melhorDist).toBeLessThan(CELL);
  });
});
