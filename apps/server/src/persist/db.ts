import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Onde o SQLite mora. O caminho relativo a __dirname muda entre rodar de src/ (tsx) e de dist/
// (tsup), e no container ele precisa apontar para o volume — por isso DATA_DIR é a variável de
// ambiente oficial (ver .env.example / docker-compose.yml) e o relativo é só o padrão de dev.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'tank.db');

let instance: Database.Database | null = null;

export function openDb(): Database.Database {
  if (instance) return instance;

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      players_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS results (
      match_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      pontos INTEGER NOT NULL,
      kills INTEGER NOT NULL,
      deaths INTEGER NOT NULL,
      self_kills INTEGER NOT NULL,
      posicao INTEGER NOT NULL,
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );

    CREATE TABLE IF NOT EXISTS ratings (
      device_id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      mu REAL NOT NULL,
      sigma REAL NOT NULL,
      partidas INTEGER NOT NULL DEFAULT 0,
      atualizado_em INTEGER NOT NULL
    );
  `);

  instance = db;
  return db;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

export interface MatchRecord {
  id: string;
  startedAt: number;
  endedAt: number;
  playersJson: string;
}

export interface ResultRecord {
  matchId: string;
  deviceId: string;
  nome: string;
  pontos: number;
  kills: number;
  deaths: number;
  selfKills: number;
  posicao: number;
}

export function insertMatch(db: Database.Database, match: MatchRecord): void {
  db.prepare(
    `INSERT INTO matches (id, started_at, ended_at, players_json) VALUES (@id, @startedAt, @endedAt, @playersJson)`,
  ).run(match);
}

export function insertResults(db: Database.Database, results: ResultRecord[]): void {
  const stmt = db.prepare(
    `INSERT INTO results (match_id, device_id, nome, pontos, kills, deaths, self_kills, posicao)
     VALUES (@matchId, @deviceId, @nome, @pontos, @kills, @deaths, @selfKills, @posicao)`,
  );
  const insertMany = db.transaction((rows: ResultRecord[]) => {
    for (const row of rows) stmt.run(row);
  });
  insertMany(results);
}

export interface RatingRow {
  deviceId: string;
  nome: string;
  mu: number;
  sigma: number;
  partidas: number;
  atualizadoEm: number;
}

export function getRating(db: Database.Database, deviceId: string): RatingRow | undefined {
  const row = db.prepare(`SELECT device_id, nome, mu, sigma, partidas, atualizado_em FROM ratings WHERE device_id = ?`).get(deviceId) as
    | { device_id: string; nome: string; mu: number; sigma: number; partidas: number; atualizado_em: number }
    | undefined;

  if (!row) return undefined;

  return {
    deviceId: row.device_id,
    nome: row.nome,
    mu: row.mu,
    sigma: row.sigma,
    partidas: row.partidas,
    atualizadoEm: row.atualizado_em,
  };
}

export function upsertRating(db: Database.Database, row: RatingRow): void {
  db.prepare(
    `INSERT INTO ratings (device_id, nome, mu, sigma, partidas, atualizado_em)
     VALUES (@deviceId, @nome, @mu, @sigma, @partidas, @atualizadoEm)
     ON CONFLICT(device_id) DO UPDATE SET
       nome = excluded.nome,
       mu = excluded.mu,
       sigma = excluded.sigma,
       partidas = excluded.partidas,
       atualizado_em = excluded.atualizado_em`,
  ).run(row);
}
