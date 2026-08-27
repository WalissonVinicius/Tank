package server

import "github.com/simplex/tank/go/sim"

// Porte de `apps/server/src/rooms/roundLoop.ts`.

// EntradaDeRanking é uma linha do ranking da rodada.
type EntradaDeRanking struct {
	PlayerID string `json:"playerId"`
	Position int    `json:"position"`
	Score    int    `json:"score"`
}

// ComputeRoundRanking pontua a rodada por ordem de eliminação: quem morre primeiro fica com a
// posição mais baixa, e quem chega vivo ao fim fica com a mais alta. Todo mundo pontua.
func ComputeRoundRanking(ordemDeEliminacao, sobreviventes []string) []EntradaDeRanking {
	total := len(ordemDeEliminacao) + len(sobreviventes)
	ranking := make([]EntradaDeRanking, 0, total)

	for i, id := range ordemDeEliminacao {
		pos := i + 1 // primeira morte = posição 1 (pior)
		ranking = append(ranking, EntradaDeRanking{PlayerID: id, Position: pos, Score: pos})
	}
	// Sobreviventes empatam na posição mais alta (empate técnico da morte súbita, se ocorrer).
	for _, id := range sobreviventes {
		ranking = append(ranking, EntradaDeRanking{PlayerID: id, Position: total, Score: total})
	}
	return ranking
}

// RegistroDeMorte é uma linha do diário de mortes da rodada.
type RegistroDeMorte struct {
	VictimID string
	KillerID string
	Autogol  bool
}

// TallyKills conta +1 por abate e registra os autogols à parte (é o que rende o título Kamikaze).
func TallyKills(mortes []RegistroDeMorte) (kills, autogols map[string]int) {
	kills = map[string]int{}
	autogols = map[string]int{}
	for _, m := range mortes {
		if m.Autogol {
			autogols[m.VictimID]++
		} else {
			kills[m.KillerID]++
		}
	}
	return kills, autogols
}

// RoundScore combina posição, abates e autogols. Nunca fica negativo.
func RoundScore(posicao, kills, autogols int) int {
	v := posicao + kills - autogols
	if v < 0 {
		return 0
	}
	return v
}

// EstatisticaDeTitulo é o que a partida acumula por jogador para decidir os títulos de zoeira.
type EstatisticaDeTitulo struct {
	PlayerID     string
	SelfKills    int
	ShotsFired   int
	ShotsHit     int
	AliveSeconds float64
	KillCount    int
}

// Titulos são os três títulos de fim de partida. `null` no JSON quando ninguém se qualifica.
type Titulos struct {
	Kamikaze           *string `json:"kamikaze"`
	BalaPerdida        *string `json:"balaPerdida"`
	CovardeEstrategico *string `json:"covardeEstrategico"`
}

func ptr(s string) *string { return &s }

// ComputeMatchTitles espelha `computeMatchTitles`, inclusive o critério de desempate: o `reduce`
// do TypeScript só troca de campeão quando o candidato é ESTRITAMENTE melhor, então em empate
// vence quem aparece primeiro na lista. A ordem da lista é a ordem dos jogadores na sala.
func ComputeMatchTitles(stats []EstatisticaDeTitulo) Titulos {
	if len(stats) == 0 {
		return Titulos{}
	}

	kamikaze := stats[0]
	for _, s := range stats[1:] {
		if s.SelfKills > kamikaze.SelfKills {
			kamikaze = s
		}
	}

	var balaPerdida *EstatisticaDeTitulo
	for i := range stats {
		s := stats[i]
		if s.ShotsFired > 0 && s.ShotsHit == 0 {
			if balaPerdida == nil || s.ShotsFired > balaPerdida.ShotsFired {
				balaPerdida = &stats[i]
			}
		}
	}

	covarde := stats[0]
	for _, s := range stats[1:] {
		if s.KillCount > covarde.KillCount {
			continue
		}
		if s.KillCount < covarde.KillCount {
			covarde = s
			continue
		}
		if s.AliveSeconds > covarde.AliveSeconds {
			covarde = s
		}
	}

	out := Titulos{CovardeEstrategico: ptr(covarde.PlayerID)}
	if kamikaze.SelfKills > 0 {
		out.Kamikaze = ptr(kamikaze.PlayerID)
	}
	if balaPerdida != nil {
		out.BalaPerdida = ptr(balaPerdida.PlayerID)
	}
	return out
}

// ParedeRemovida é o resultado de uma remoção da morte súbita.
type ParedeRemovida struct {
	Index int
	Wall  sim.Aabb
}

// RemoveRandomInternalWall remove uma parede INTERNA do labirinto (as 4 primeiras são as bordas e
// nunca saem). O sorteio vem do mesmo `mulberry32` da rodada, então o cliente remove a mesma
// parede ao receber o aviso.
//
// Muta `m.Walls` no lugar, exatamente como o `splice` do TypeScript — é essa mutação que invalida
// o cache de paredes infladas dentro da simulação (ele confere o tamanho do slice).
func RemoveRandomInternalWall(m *sim.Maze, seed uint32, tentativa int) (ParedeRemovida, bool) {
	if len(m.Walls) <= 4 {
		return ParedeRemovida{}, false
	}
	rng := sim.Mulberry32(seed + uint32(tentativa)*7919)
	idx := 4 + rng.Int(len(m.Walls)-4)
	parede := m.Walls[idx]
	m.Walls = append(m.Walls[:idx], m.Walls[idx+1:]...)
	return ParedeRemovida{Index: idx, Wall: parede}, true
}
