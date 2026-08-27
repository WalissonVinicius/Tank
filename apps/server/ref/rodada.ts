import {
  computeMatchTitles,
  computeRoundRanking,
  removeRandomInternalWall,
  roundScore,
  tallyKills,
  type MatchTitleStats,
} from '../src/rooms/roundLoop.js';
import { makeMaze } from '@tank/shared-sim';

const rankings = [
  { mortos: [], vivos: ['a', 'b'] },
  { mortos: ['c', 'a'], vivos: ['b'] },
  { mortos: ['e', 'd', 'c', 'b'], vivos: ['a'] },
  { mortos: ['a', 'b', 'c'], vivos: [] },
];

const mortes = [
  [],
  [{ victimId: 'a', killerId: 'b', autogol: false }],
  [
    { victimId: 'a', killerId: 'a', autogol: true },
    { victimId: 'b', killerId: 'c', autogol: false },
    { victimId: 'd', killerId: 'c', autogol: false },
    { victimId: 'c', killerId: 'c', autogol: true },
  ],
];

const titulos: MatchTitleStats[][] = [
  [],
  [
    { playerId: 'a', selfKills: 0, shotsFired: 10, shotsHit: 0, aliveSeconds: 50, killCount: 0 },
    { playerId: 'b', selfKills: 2, shotsFired: 8, shotsHit: 3, aliveSeconds: 20, killCount: 3 },
    { playerId: 'c', selfKills: 1, shotsFired: 30, shotsHit: 0, aliveSeconds: 5, killCount: 0 },
  ],
  [
    { playerId: 'x', selfKills: 0, shotsFired: 0, shotsHit: 0, aliveSeconds: 10, killCount: 1 },
    { playerId: 'y', selfKills: 0, shotsFired: 0, shotsHit: 0, aliveSeconds: 30, killCount: 1 },
  ],
];

// morte súbita: mesma seed, mesma parede removida
const paredes: { seed: number; tentativa: number; index: number | null }[] = [];
for (const seed of [1, 42, 4242424242]) {
  const maze = makeMaze(seed, 6, 16 / 9);
  for (let tentativa = 1; tentativa <= 5; tentativa++) {
    const r = removeRandomInternalWall(maze, seed, tentativa);
    paredes.push({ seed, tentativa, index: r ? r.index : null });
  }
}

console.log(
  JSON.stringify({
    rankings: rankings.map((c) => ({ ...c, saida: computeRoundRanking(c.mortos, c.vivos) })),
    mortes: mortes.map((m) => {
      const { kills, selfKills } = tallyKills(m);
      return { entrada: m, kills: Object.fromEntries(kills), selfKills: Object.fromEntries(selfKills) };
    }),
    escores: [
      [1, 0, 0], [3, 2, 1], [1, 0, 5], [4, 0, 2],
    ].map(([p, k, s]) => ({ p, k, s, saida: roundScore(p!, k!, s!) })),
    titulos: titulos.map((t) => ({ entrada: t, saida: computeMatchTitles(t) })),
    paredes,
  }),
);
