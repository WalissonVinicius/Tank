package server

import (
	"encoding/json"

	"github.com/simplex/tank/go/internal/jsmath"
	"github.com/simplex/tank/go/protocol"
)

// Canais que o cliente pode falar depois de entrar. Toda mensagem vira um comando executado na
// goroutine da sala — é isso que serializa os pedidos e faz a arbitragem funcionar sem mutex.

type msgReady struct {
	Ready *bool `json:"ready"`
}

type msgPickColor struct {
	Color *int `json:"color"`
}

type msgConfig struct {
	Rodadas     *float64 `json:"rodadas"`
	Dificuldade *string  `json:"dificuldade"`
}

type msgViewport struct {
	Aspect *float64 `json:"aspect"`
}

type msgInput struct {
	Seq  int  `json:"seq"`
	Bits int  `json:"bits"`
	Aim  *int `json:"aim"`
}

// Receber trata uma mensagem já dentro da goroutine da sala.
func (s *Sala) Receber(sessionID, canal string, corpo json.RawMessage) {
	switch canal {
	case MsgReady:
		s.aoReady(sessionID, corpo)
	case MsgAddBot:
		s.aoAddBot(sessionID)
	case MsgRemoveBot:
		s.aoRemoveBot(sessionID)
	case MsgRematch:
		s.aoRematch(sessionID)
	case MsgConfig:
		s.aoConfig(sessionID, corpo)
	case MsgPickColor:
		s.aoPickColor(sessionID, corpo)
	case MsgInput:
		s.aoInput(sessionID, corpo)
	case MsgViewport:
		s.aoViewport(sessionID, corpo)
	case MsgSair:
		s.Sair(sessionID)
	}
}

func (s *Sala) aoReady(sessionID string, corpo json.RawMessage) {
	p := s.porID[sessionID]
	if p == nil || p.IsBot {
		return
	}
	var m msgReady
	_ = json.Unmarshal(corpo, &m)
	p.Ready = m.Ready == nil || *m.Ready
	s.marcarEstadoSujo()
}

// Bots entram e saem PELO LOBBY, não só pela opção de criação da sala. Quem manda é o dono (o
// primeiro humano que entrou): para os outros o cliente nem desenha os botões, e o servidor recusa
// de novo aqui — o cliente nunca é a autoridade.
func (s *Sala) aoAddBot(sessionID string) {
	if s.fase != FaseLobby || s.ownerID != sessionID {
		return
	}
	if len(s.jogadores) >= VagasPorSala {
		return
	}
	s.adicionarBot()
	s.publicarSala()
}

func (s *Sala) aoRemoveBot(sessionID string) {
	if s.fase != FaseLobby || s.ownerID != sessionID {
		return
	}
	if s.removerUmBot() {
		s.publicarSala()
	}
}

// REVANCHE. A sala volta ao lobby em vez de morrer com a partida.
//
// Qualquer pessoa da sala pode pedir, não só o dono: se o dono fecha a aba depois da última
// rodada, exigir que fosse ele deixaria a sala presa em `gameover` para sempre.
func (s *Sala) aoRematch(sessionID string) {
	if s.fase != FaseGameOver {
		return
	}
	if _, ok := s.porID[sessionID]; !ok {
		return
	}
	s.reiniciarParaLobby()
}

// Rodadas e dificuldade dos bots, ajustadas pelo DONO no lobby. A dificuldade estava fixa em
// `medio` no código — nem o bot difícil chegava a ser usado numa partida online.
func (s *Sala) aoConfig(sessionID string, corpo json.RawMessage) {
	if s.fase != FaseLobby || s.ownerID != sessionID {
		return
	}
	var m msgConfig
	_ = json.Unmarshal(corpo, &m)
	if m.Rodadas != nil {
		r := int(arredondarParaInteiro(*m.Rodadas))
		if r < 1 {
			r = 1
		}
		if r > protocol.Rounds {
			r = protocol.Rounds
		}
		s.totalRodadas = r
	}
	if m.Dificuldade != nil {
		switch *m.Dificuldade {
		case "facil", "medio", "dificil":
			s.dificuldade = *m.Dificuldade
		}
	}
	s.marcarEstadoSujo()
	s.publicarSala()
}

// Escolha de cor. A UNICIDADE É DAQUI, não do cliente: as mensagens chegam serializadas na
// goroutine da sala, então dois jogadores que clicam no mesmo quadrado no mesmo instante são
// atendidos em ordem e o segundo cai fora do `if`. O cliente descobre o que aconteceu lendo o
// `color` do estado frio.
func (s *Sala) aoPickColor(sessionID string, corpo json.RawMessage) {
	if s.fase != FaseLobby {
		return // trocar de cor no meio da partida, não
	}
	p := s.porID[sessionID]
	if p == nil || p.IsBot {
		return
	}
	var m msgPickColor
	_ = json.Unmarshal(corpo, &m)
	if m.Color == nil || !corDaPaleta(*m.Color) || *m.Color == p.Color {
		return
	}
	if s.corEmUso(*m.Color, sessionID) {
		return
	}
	p.Color = *m.Color
	s.marcarEstadoSujo()
}

func (s *Sala) aoInput(sessionID string, corpo json.RawMessage) {
	p := s.porID[sessionID]
	if p == nil || p.IsBot || !p.Alive {
		return
	}
	var m msgInput
	if err := json.Unmarshal(corpo, &m); err != nil {
		return
	}
	aim := 0
	temAim := m.Aim != nil
	if temAim {
		aim = *m.Aim
	}
	s.ultimoInput[sessionID] = DecodeInputBits(m.Bits, aim, temAim)
}

// Cada cliente anuncia a proporção da própria área jogável, e reanuncia a cada resize. É uma dica,
// não um comando: quem decide a forma do labirinto é `aspectoDaSala` logo antes de gerar a rodada,
// e o resultado vai igual para todo mundo em `round_start`.
func (s *Sala) aoViewport(sessionID string, corpo json.RawMessage) {
	var m msgViewport
	if err := json.Unmarshal(corpo, &m); err != nil || m.Aspect == nil {
		return
	}
	bruto := *m.Aspect
	if bruto <= 0 || bruto != bruto {
		return
	}
	s.aspectoDaSessao[sessionID] = limitar(bruto, protocol.MazeAspectMin, protocol.MazeAspectMax)
}

func limitar(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// arredondarParaInteiro segue a regra do JavaScript (`.5` sempre para cima), que é a que o
// TypeScript aplicava a `Math.round(message.rodadas)` — `math.Round` do Go arredonda para longe
// do zero e discordaria em `-0,5`.
func arredondarParaInteiro(v float64) float64 {
	return jsmath.Round(v)
}
