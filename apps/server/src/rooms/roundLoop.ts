import type { Aabb, Maze } from '@tank/shared-sim';
import { mulberry32 } from '@tank/shared-sim';

export interface RoundRankingEntry {
  playerId: string;
  position: number; // 1 = último a morrer / vencedor, sobe conforme sobrevive mais
  score: number;
}

/**
 * Pontuação da rodada por ordem de eliminação (relatório G §5.2, simplificado pelo contrato
 * da Fase 2A): quem morre primeiro fica com a posição mais baixa, o último vivo (ou o vencedor,
 * se sobrou 1) fica com a posição mais alta — todo mundo pontua pela posição, ninguém zera.
 *
 * `eliminationOrder` — ids na ordem em que morreram (primeiro elemento = primeira morte).
 * `survivors` — ids que continuavam vivos quando a rodada terminou (1 = vitória clara;
 *   mais de 1 só acontece se todas as paredes internas da morte súbita já sumiram).
 */
export function computeRoundRanking(eliminationOrder: string[], survivors: string[]): RoundRankingEntry[] {
  const totalPlayers = eliminationOrder.length + survivors.length;
  const ranking: RoundRankingEntry[] = [];

  eliminationOrder.forEach((playerId, index) => {
    const position = index + 1; // primeira morte = posição 1 (pior)
    ranking.push({ playerId, position, score: position });
  });

  // sobreviventes empatam na posição mais alta (empate técnico da morte súbita, se ocorrer)
  const survivorsPosition = totalPlayers;
  survivors.forEach((playerId) => {
    ranking.push({ playerId, position: survivorsPosition, score: survivorsPosition });
  });

  return ranking;
}

export interface KillTally {
  kills: Map<string, number>;
  selfKills: Map<string, number>;
}

/** +1 por abate feito, −1 por autogol (registrado à parte para o título "Kamikaze"). */
export function tallyKills(deaths: { victimId: string; killerId: string; autogol: boolean }[]): KillTally {
  const kills = new Map<string, number>();
  const selfKills = new Map<string, number>();

  for (const death of deaths) {
    if (death.autogol) {
      selfKills.set(death.victimId, (selfKills.get(death.victimId) ?? 0) + 1);
    } else {
      kills.set(death.killerId, (kills.get(death.killerId) ?? 0) + 1);
    }
  }

  return { kills, selfKills };
}

/** Pontos finais da rodada, combinando posição + abates + autogols. Nunca fica negativo. */
export function roundScore(basePosition: number, kills: number, selfKills: number): number {
  return Math.max(0, basePosition + kills - selfKills);
}

export interface MatchTitleStats {
  playerId: string;
  selfKills: number;
  shotsFired: number;
  shotsHit: number;
  aliveSeconds: number;
  killCount: number;
}

export interface MatchTitles {
  kamikaze: string | null; // mais autogols
  balaPerdida: string | null; // mais tiros disparados sem nenhum acerto
  covardeEstrategico: string | null; // mais tempo vivo somado, com menos abates
}

/** Títulos de zoeira de fim de partida (relatório G §5.3, os 3 pedidos pela Fase 2A). */
export function computeMatchTitles(stats: MatchTitleStats[]): MatchTitles {
  if (stats.length === 0) {
    return { kamikaze: null, balaPerdida: null, covardeEstrategico: null };
  }

  const kamikaze = stats.reduce((best, s) => (s.selfKills > best.selfKills ? s : best));

  const balaPerdida = stats
    .filter((s) => s.shotsFired > 0 && s.shotsHit === 0)
    .reduce<MatchTitleStats | null>((best, s) => (!best || s.shotsFired > best.shotsFired ? s : best), null);

  const covardeEstrategico = stats.reduce((best, s) => {
    if (s.killCount > best.killCount) return best;
    if (s.killCount < best.killCount) return s;
    return s.aliveSeconds > best.aliveSeconds ? s : best;
  });

  return {
    kamikaze: kamikaze.selfKills > 0 ? kamikaze.playerId : null,
    balaPerdida: balaPerdida?.playerId ?? null,
    covardeEstrategico: covardeEstrategico.playerId,
  };
}

export interface RemovedWall {
  index: number;
  wall: Aabb;
}

/**
 * Morte súbita: a cada 3 s do timeout, remove uma parede interna aleatória (seed determinística
 * por rodada) até sobrar 1 vivo — mais legível que encolher a arena e reaproveita `mulberry32`.
 * As 4 paredes de borda (sempre as 4 primeiras em `Maze.walls`, ver `buildWalls` em
 * `packages/shared-sim/src/maze.ts`) nunca são removidas.
 *
 * Retorna a parede removida (ou `null` se não sobrou nenhuma parede interna) para quem chamar
 * poder avisar os clientes — eles precisam remover a mesma parede da própria cópia do labirinto.
 */
export function removeRandomInternalWall(maze: Maze, seed: number, attempt: number): RemovedWall | null {
  if (maze.walls.length <= 4) return null;
  const rng = mulberry32(seed + attempt * 7919);
  const index = 4 + rng.int(maze.walls.length - 4);
  const [wall] = maze.walls.splice(index, 1);
  return wall ? { index, wall } : null;
}
