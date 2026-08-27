package server

// RegistroDaPartida é tudo que o fim de partida entrega para quem grava. A sala não conhece SQL
// nem webhook: ela monta este registro e passa adiante, o que mantém o laço de 60 Hz livre de I/O.
type RegistroDaPartida struct {
	MatchID      string
	Sala         string
	ComecouEm    int64
	TerminouEm   int64
	Jogadores    []Jogador
	Posicao      map[string]int
	DevicePorID  map[string]string
	RankingFinal []map[string]any
	Titulos      Titulos
}

// Persistencia é o que a sala precisa do banco. Uma interface (e não o pacote direto) porque o
// servidor tem que subir sem banco nenhum — nos testes e num contêiner sem volume — sem espalhar
// `if db != nil` pelo ciclo de partida.
//
// A implementação REAL é assíncrona: `SalvarPartida` só enfileira. Gravar em SQLite dentro da
// goroutine da sala travaria o tick durante o fsync do WAL.
type Persistencia interface {
	SalvarPartida(RegistroDaPartida)
}
