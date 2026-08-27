package main

import (
	"encoding/json"
	"log"
	"time"

	"github.com/simplex/tank/go/persist"
	"github.com/simplex/tank/go/server"
)

// Gravador liga o fim de partida ao banco e ao webhook — o que `finishMatch` fazia inline no
// TypeScript.
//
// A gravação é ASSÍNCRONA de propósito: `SalvarPartida` só enfileira e volta na hora. No Node o
// `better-sqlite3` é síncrono e o `INSERT` acontecia dentro do laço da sala; aqui isso travaria a
// goroutine da sala durante o fsync do WAL, e uma sala em `gameover` ainda está transmitindo
// estado para quem está olhando a tela de resultado.
type Gravador struct {
	banco *persist.Banco
	fila  chan server.RegistroDaPartida
}

// NovoGravador sobe a goroutine de escrita. `banco` nil devolve nil — o servidor roda sem banco.
func NovoGravador(banco *persist.Banco) *Gravador {
	if banco == nil {
		return nil
	}
	g := &Gravador{banco: banco, fila: make(chan server.RegistroDaPartida, 32)}
	go g.laco()
	return g
}

// SalvarPartida enfileira. Fila cheia (banco travado, disco cheio) descarta e avisa: perder o
// registro de uma partida é ruim, perder a partida em si é pior.
func (g *Gravador) SalvarPartida(r server.RegistroDaPartida) {
	select {
	case g.fila <- r:
	default:
		log.Printf("[persist] fila cheia, resultado da partida %s descartado", r.MatchID)
	}
}

func (g *Gravador) laco() {
	for r := range g.fila {
		if err := g.gravar(r); err != nil {
			log.Printf("[persist] falha ao salvar resultado da partida: %v", err)
		}
		persist.EnviarWebhook(map[string]any{
			"roomId":       r.Sala,
			"finalizadaEm": time.UnixMilli(r.TerminouEm).UTC().Format(time.RFC3339),
			"ranking":      r.RankingFinal,
			"titulos":      r.Titulos,
		})
	}
}

func (g *Gravador) gravar(r server.RegistroDaPartida) error {
	// O JSON de jogadores guarda exatamente os três campos que o TypeScript guardava.
	resumo := make([]map[string]any, 0, len(r.Jogadores))
	for _, p := range r.Jogadores {
		resumo = append(resumo, map[string]any{"id": p.ID, "nome": p.Name, "isBot": p.IsBot})
	}
	jogadoresJS, err := json.Marshal(resumo)
	if err != nil {
		return err
	}

	if err := g.banco.InserirPartida(persist.Partida{
		ID: r.MatchID, ComecouEm: r.ComecouEm, TerminouEm: r.TerminouEm, JogadoresJS: string(jogadoresJS),
	}); err != nil {
		return err
	}

	resultados := make([]persist.Resultado, 0, len(r.Jogadores))
	colocacoes := make([]persist.Colocacao, 0, len(r.Jogadores))
	for _, p := range r.Jogadores {
		if p.IsBot {
			continue // bot não entra no ranking
		}
		device := r.DevicePorID[p.ID]
		if device == "" {
			device = p.ID
		}
		posicao := r.Posicao[p.ID]
		if posicao == 0 {
			posicao = len(r.Jogadores)
		}
		resultados = append(resultados, persist.Resultado{
			MatchID: r.MatchID, DeviceID: device, Nome: p.Name, Pontos: p.Score,
			Kills: p.Kills, Deaths: p.Deaths, SelfKills: p.SelfKills, Posicao: posicao,
		})
		colocacoes = append(colocacoes, persist.Colocacao{DeviceID: device, Nome: p.Name, Posicao: posicao})
	}
	if len(resultados) == 0 {
		return nil
	}
	if err := g.banco.InserirResultados(resultados); err != nil {
		return err
	}
	return g.banco.AtualizarRatings(colocacoes)
}
