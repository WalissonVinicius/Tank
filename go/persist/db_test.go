package persist

import (
	"testing"
)

// O banco é o mesmo arquivo que o servidor Node grava: mesmas três tabelas, mesmos nomes de
// coluna. O que muda é o motor — `better-sqlite3` (extensão nativa em C) virou `modernc.org/sqlite`
// (Go puro), e é isso que mantém o Dockerfile de um estágio só.

func bancoDeTeste(t *testing.T) *Banco {
	t.Helper()
	b, err := Abrir(t.TempDir())
	if err != nil {
		t.Fatalf("não consegui abrir o banco: %v", err)
	}
	t.Cleanup(func() { _ = b.Fechar() })
	return b
}

func TestGravarPartidaEResultados(t *testing.T) {
	b := bancoDeTeste(t)

	if err := b.InserirPartida(Partida{
		ID: "ABCD-1", ComecouEm: 1000, TerminouEm: 2000,
		JogadoresJS: `[{"id":"a","nome":"Ana","isBot":false}]`,
	}); err != nil {
		t.Fatalf("insert de partida: %v", err)
	}

	if err := b.InserirResultados([]Resultado{
		{MatchID: "ABCD-1", DeviceID: "d1", Nome: "Ana", Pontos: 12, Kills: 3, Deaths: 2, SelfKills: 1, Posicao: 1},
		{MatchID: "ABCD-1", DeviceID: "d2", Nome: "Bruno", Pontos: 7, Kills: 1, Deaths: 4, SelfKills: 0, Posicao: 2},
	}); err != nil {
		t.Fatalf("insert de resultados: %v", err)
	}

	// Lista vazia não pode virar transação nem erro — é o caso de uma partida só de bots.
	if err := b.InserirResultados(nil); err != nil {
		t.Fatalf("lista vazia deveria ser inócua: %v", err)
	}
}

func TestRatingNasceEEvoluiNoBanco(t *testing.T) {
	b := bancoDeTeste(t)

	if _, existe := b.Rating("d1"); existe {
		t.Fatal("quem nunca jogou não tem linha de rating")
	}

	if err := b.AtualizarRatings([]Colocacao{
		{DeviceID: "d2", Nome: "Bruno", Posicao: 2},
		{DeviceID: "d1", Nome: "Ana", Posicao: 1},
	}); err != nil {
		t.Fatalf("atualizar ratings: %v", err)
	}

	campeao, ok := b.Rating("d1")
	if !ok {
		t.Fatal("o campeão deveria ter linha de rating")
	}
	vice, ok := b.Rating("d2")
	if !ok {
		t.Fatal("o vice deveria ter linha de rating")
	}
	if campeao.Mu <= vice.Mu {
		t.Errorf("o campeão (mu %v) tem que ficar acima do vice (mu %v)", campeao.Mu, vice.Mu)
	}
	if campeao.Partidas != 1 || vice.Partidas != 1 {
		t.Errorf("contagem de partidas errada: %d e %d", campeao.Partidas, vice.Partidas)
	}
	// A colocação é lida do campo, não da ordem em que a lista chegou — por isso o teste manda o
	// vice primeiro.
	if campeao.Nome != "Ana" {
		t.Errorf("o campeão deveria ser Ana, o banco diz %q", campeao.Nome)
	}

	if err := b.AtualizarRatings([]Colocacao{
		{DeviceID: "d1", Nome: "Ana", Posicao: 2},
		{DeviceID: "d2", Nome: "Bruno", Posicao: 1},
	}); err != nil {
		t.Fatalf("segunda partida: %v", err)
	}
	depois, _ := b.Rating("d1")
	if depois.Partidas != 2 {
		t.Errorf("esperava 2 partidas para d1, o banco diz %d", depois.Partidas)
	}
	if depois.Mu >= campeao.Mu {
		t.Errorf("perder tem que baixar o mu: %v -> %v", campeao.Mu, depois.Mu)
	}
}

func TestPartidaSemNinguemNaoQuebraOsRatings(t *testing.T) {
	b := bancoDeTeste(t)
	if err := b.AtualizarRatings(nil); err != nil {
		t.Fatalf("partida sem humano nenhum deveria ser inócua: %v", err)
	}
}
