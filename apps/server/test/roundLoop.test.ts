import { describe, expect, it } from 'vitest';
import {
  computeMatchTitles,
  computeRoundRanking,
  removeRandomInternalWall,
  roundScore,
  tallyKills,
} from '../src/rooms/roundLoop.js';
import { makeMaze } from '@tank/shared-sim';

describe('computeRoundRanking', () => {
  it('dá a posição mais alta para o vencedor e mais baixa para quem morreu primeiro', () => {
    const ranking = computeRoundRanking(['a', 'b'], ['c']);
    const byId = Object.fromEntries(ranking.map((r) => [r.playerId, r.position]));
    expect(byId.a).toBe(1);
    expect(byId.b).toBe(2);
    expect(byId.c).toBe(3);
  });
});

describe('roundScore', () => {
  it('soma posição + abates', () => {
    expect(roundScore(3, 2, 0)).toBe(5);
  });

  it('desconta 1 ponto por autogol', () => {
    expect(roundScore(3, 0, 1)).toBe(2);
  });

  it('nunca fica negativo', () => {
    expect(roundScore(1, 0, 5)).toBe(0);
  });
});

describe('tallyKills', () => {
  it('separa abates de autogols', () => {
    const { kills, selfKills } = tallyKills([
      { victimId: 'b', killerId: 'a', autogol: false },
      { victimId: 'a', killerId: 'a', autogol: true },
    ]);
    expect(kills.get('a')).toBe(1);
    expect(selfKills.get('a')).toBe(1);
  });
});

describe('computeMatchTitles', () => {
  it('escolhe Kamikaze, Bala Perdida e Covarde Estratégico corretamente', () => {
    const titles = computeMatchTitles([
      { playerId: 'a', selfKills: 3, shotsFired: 5, shotsHit: 2, aliveSeconds: 10, killCount: 2 },
      { playerId: 'b', selfKills: 0, shotsFired: 4, shotsHit: 0, aliveSeconds: 40, killCount: 0 },
      { playerId: 'c', selfKills: 1, shotsFired: 2, shotsHit: 2, aliveSeconds: 5, killCount: 3 },
    ]);

    expect(titles.kamikaze).toBe('a');
    expect(titles.balaPerdida).toBe('b');
    expect(titles.covardeEstrategico).toBe('b');
  });

  it('lida com lista vazia sem quebrar', () => {
    expect(computeMatchTitles([])).toEqual({ kamikaze: null, balaPerdida: null, covardeEstrategico: null });
  });
});

describe('removeRandomInternalWall', () => {
  it('remove uma parede interna determinística e nunca mexe nas 4 de borda', () => {
    const maze = makeMaze(42, 4);
    const wallsBefore = maze.walls.length;

    const removed = removeRandomInternalWall(maze, 42, 1);

    expect(removed).not.toBeNull();
    expect(removed!.index).toBeGreaterThanOrEqual(4);
    expect(maze.walls.length).toBe(wallsBefore - 1);
  });

  it('retorna null quando só sobram as 4 paredes de borda', () => {
    const maze = makeMaze(7, 2);
    while (maze.walls.length > 4) maze.walls.pop();

    expect(removeRandomInternalWall(maze, 7, 1)).toBeNull();
  });
});
