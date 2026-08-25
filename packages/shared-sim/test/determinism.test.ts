import { describe, expect, it } from 'vitest';
import { makeMaze, mulberry32, spawnPoints, step } from '../src/index.js';
import type { Input, SimState, Tank } from '../src/index.js';

function buildState(seed: number, playerCount: number): SimState {
  const maze = makeMaze(seed, playerCount);
  const rng = mulberry32(seed);
  const spawns = spawnPoints(maze, playerCount, rng);
  const tanks = new Map<string, Tank>();
  spawns.forEach((spawn, i) => {
    tanks.set(`p${i}`, {
      id: `p${i}`,
      x: spawn.x,
      y: spawn.y,
      heading: (i / playerCount) * Math.PI * 2,
      turret: 0,
      alive: true,
      fireCooldownLeft: 0,
    });
  });
  return { tick: 0, maze, tanks, bullets: [], nextBulletId: 0 };
}

// Sequência fixa de inputs sintéticos, derivada só do índice do tick e do jogador — nenhum
// RNG, então é reproduzível byte a byte entre as duas execuções.
function inputsForTick(ids: readonly string[], tick: number): Map<string, Input> {
  const inputs = new Map<string, Input>();
  ids.forEach((id, idx) => {
    const phase = (tick + idx * 3) % 24;
    inputs.set(id, {
      turn: phase < 8 ? 1 : phase < 16 ? -1 : 0,
      move: phase % 5 === 0 ? 0 : 1,
      fire: phase % 7 === 0,
    });
  });
  return inputs;
}

function hashState(state: SimState): string {
  const parts: string[] = [];
  const tankIds = [...state.tanks.keys()].sort();
  for (const id of tankIds) {
    const t = state.tanks.get(id)!;
    parts.push(`${id}:${t.x.toFixed(6)}:${t.y.toFixed(6)}:${t.heading.toFixed(6)}:${t.turret.toFixed(6)}:${t.alive}`);
  }
  for (const b of state.bullets) {
    parts.push(`${b.id}:${b.x.toFixed(6)}:${b.y.toFixed(6)}:${b.vx.toFixed(6)}:${b.vy.toFixed(6)}:${b.bounces}`);
  }
  return parts.join('|');
}

function runFixedInputs(seed: number, playerCount: number, ticks: number): string {
  const state = buildState(seed, playerCount);
  const ids = [...state.tanks.keys()];
  const dt = 1 / 60;
  for (let i = 0; i < ticks; i++) {
    step(state, inputsForTick(ids, i), dt);
    state.tick++;
  }
  return hashState(state);
}

describe('determinismo da simulação', () => {
  it('produz hash idêntico em duas execuções independentes, para 1000 seeds', () => {
    for (let seed = 0; seed < 1000; seed++) {
      const playerCount = 2 + (seed % 9); // varia 2..10
      const hashA = runFixedInputs(seed, playerCount, 600);
      const hashB = runFixedInputs(seed, playerCount, 600);
      expect(hashB, `seed ${seed}, ${playerCount} jogadores`).toBe(hashA);
    }
  });
});
