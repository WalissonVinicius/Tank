import { ordinal, rate, rating as newRating, type Rating } from 'openskill';
import type Database from 'better-sqlite3';
import { getRating, upsertRating } from './db.js';

export interface MatchPlacement {
  deviceId: string;
  nome: string;
  posicao: number; // 1 = campeão da partida (quanto menor, melhor — convenção de placar final)
}

export interface UpdatedRating extends MatchPlacement {
  mu: number;
  sigma: number;
  ordinal: number;
}

/**
 * Atualiza o ranking OpenSkill (Plackett-Luce, FFA nativo) ao fim da partida. Cada jogador é o
 * seu próprio "time" de 1; `rank` usa a posição final da partida (soma de pontos das 10 rodadas
 * — quem chamar decide a posição), onde 0 = melhor colocação.
 */
export function updateRatingsForMatch(db: Database.Database, placements: MatchPlacement[]): UpdatedRating[] {
  if (placements.length === 0) return [];

  const sorted = [...placements].sort((a, b) => a.posicao - b.posicao); // melhor posição (1) primeiro

  const current: Rating[] = sorted.map((p) => {
    const existing = getRating(db, p.deviceId);
    return existing ? { mu: existing.mu, sigma: existing.sigma } : newRating();
  });

  const teams = current.map((r) => [r]);
  const rank = sorted.map((_, index) => index); // já ordenado do melhor para o pior

  const result = rate(teams, { rank });

  const now = Date.now();
  const updated: UpdatedRating[] = sorted.map((p, index) => {
    const nextRating: Rating = result[index]![0]!;
    const existing = getRating(db, p.deviceId);

    upsertRating(db, {
      deviceId: p.deviceId,
      nome: p.nome,
      mu: nextRating.mu,
      sigma: nextRating.sigma,
      partidas: (existing?.partidas ?? 0) + 1,
      atualizadoEm: now,
    });

    return { ...p, mu: nextRating.mu, sigma: nextRating.sigma, ordinal: ordinal(nextRating) };
  });

  return updated;
}
