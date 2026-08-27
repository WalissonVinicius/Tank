package persist

import (
	"database/sql"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// Porte de `apps/server/src/persist/db.ts`. O `better-sqlite3` (que é uma extensão nativa e
// obriga o Dockerfile a carregar toolchain de C) virou `modernc.org/sqlite`: SQLite traduzido
// para Go puro, sem cgo. O Dockerfile continua de um estágio só e o binário continua estático.
//
// O esquema é IDÊNTICO ao do TypeScript — mesmas três tabelas, mesmos nomes de coluna. Um banco
// gravado pelo servidor Node abre no servidor Go e vice-versa.

// Banco é a conexão aberta.
type Banco struct {
	db *sql.DB
}

// Abrir cria (ou abre) o arquivo do banco e garante o esquema.
//
// O caminho vem de `DATA_DIR`, a mesma variável do servidor Node — é ela que aponta para o volume
// no contêiner.
func Abrir(dir string) (*Banco, error) {
	if dir == "" {
		dir = "data"
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "tank.db"))
	if err != nil {
		return nil, err
	}
	// O SQLite em Go puro é seguro para concorrência, mas uma conexão só evita `database is
	// locked` sem ter que embrulhar cada escrita num laço de repetição. O volume de escrita deste
	// jogo é uma partida a cada poucos minutos.
	db.SetMaxOpenConns(1)

	if _, err := db.Exec(`PRAGMA journal_mode = WAL;`); err != nil {
		_ = db.Close()
		return nil, err
	}
	if _, err := db.Exec(esquema); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Banco{db: db}, nil
}

// Fechar encerra a conexão.
func (b *Banco) Fechar() error { return b.db.Close() }

const esquema = `
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
`

// Partida é uma linha de `matches`.
type Partida struct {
	ID          string
	ComecouEm   int64
	TerminouEm  int64
	JogadoresJS string
}

// Resultado é uma linha de `results`.
type Resultado struct {
	MatchID   string
	DeviceID  string
	Nome      string
	Pontos    int
	Kills     int
	Deaths    int
	SelfKills int
	Posicao   int
}

// LinhaDeRating é uma linha de `ratings`.
type LinhaDeRating struct {
	DeviceID     string
	Nome         string
	Mu           float64
	Sigma        float64
	Partidas     int
	AtualizadoEm int64
}

// InserirPartida grava o cabeçalho da partida.
func (b *Banco) InserirPartida(p Partida) error {
	_, err := b.db.Exec(
		`INSERT INTO matches (id, started_at, ended_at, players_json) VALUES (?, ?, ?, ?)`,
		p.ID, p.ComecouEm, p.TerminouEm, p.JogadoresJS)
	return err
}

// InserirResultados grava os resultados dos humanos numa transação só.
func (b *Banco) InserirResultados(rs []Resultado) error {
	if len(rs) == 0 {
		return nil
	}
	tx, err := b.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.Prepare(`INSERT INTO results
	  (match_id, device_id, nome, pontos, kills, deaths, self_kills, posicao)
	  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()

	for _, r := range rs {
		if _, err := stmt.Exec(r.MatchID, r.DeviceID, r.Nome, r.Pontos, r.Kills, r.Deaths, r.SelfKills, r.Posicao); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Rating lê o rating de um aparelho. `ok` falso significa "nunca jogou".
func (b *Banco) Rating(deviceID string) (LinhaDeRating, bool) {
	var l LinhaDeRating
	err := b.db.QueryRow(
		`SELECT device_id, nome, mu, sigma, partidas, atualizado_em FROM ratings WHERE device_id = ?`,
		deviceID).Scan(&l.DeviceID, &l.Nome, &l.Mu, &l.Sigma, &l.Partidas, &l.AtualizadoEm)
	if err != nil {
		return LinhaDeRating{}, false
	}
	return l, true
}

// GravarRating insere ou atualiza.
func (b *Banco) GravarRating(l LinhaDeRating) error {
	_, err := b.db.Exec(`INSERT INTO ratings (device_id, nome, mu, sigma, partidas, atualizado_em)
	  VALUES (?, ?, ?, ?, ?, ?)
	  ON CONFLICT(device_id) DO UPDATE SET
	    nome = excluded.nome, mu = excluded.mu, sigma = excluded.sigma,
	    partidas = excluded.partidas, atualizado_em = excluded.atualizado_em`,
		l.DeviceID, l.Nome, l.Mu, l.Sigma, l.Partidas, l.AtualizadoEm)
	return err
}

// Colocacao é a posição final de um jogador numa partida (1 = campeão).
type Colocacao struct {
	DeviceID string
	Nome     string
	Posicao  int
}

// AtualizarRatings roda o OpenSkill sobre o resultado da partida e grava. Porte de
// `updateRatingsForMatch`.
func (b *Banco) AtualizarRatings(colocacoes []Colocacao) error {
	if len(colocacoes) == 0 {
		return nil
	}
	ordenadas := make([]Colocacao, len(colocacoes))
	copy(ordenadas, colocacoes)
	// Melhor posição (1) primeiro — é a ordem que o `rank` do openskill assume.
	for i := 1; i < len(ordenadas); i++ {
		for j := i; j > 0 && ordenadas[j].Posicao < ordenadas[j-1].Posicao; j-- {
			ordenadas[j], ordenadas[j-1] = ordenadas[j-1], ordenadas[j]
		}
	}

	atuais := make([]Rating, len(ordenadas))
	anteriores := make([]LinhaDeRating, len(ordenadas))
	for i, c := range ordenadas {
		if linha, ok := b.Rating(c.DeviceID); ok {
			atuais[i] = Rating{Mu: linha.Mu, Sigma: linha.Sigma}
			anteriores[i] = linha
		} else {
			atuais[i] = NovoRating()
		}
	}

	novos := Rate(atuais)
	agora := time.Now().UnixMilli()
	for i, c := range ordenadas {
		if err := b.GravarRating(LinhaDeRating{
			DeviceID: c.DeviceID, Nome: c.Nome,
			Mu: novos[i].Mu, Sigma: novos[i].Sigma,
			Partidas: anteriores[i].Partidas + 1, AtualizadoEm: agora,
		}); err != nil {
			return err
		}
	}
	return nil
}
