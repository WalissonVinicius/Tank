package paridade

import (
	"github.com/simplex/tank/go/internal/jsmath"
	"github.com/simplex/tank/go/protocol"
	"github.com/simplex/tank/go/sim"
)

// TicksPadrao é quantos ticks cada seed simula. A 60 Hz, 300 ticks são 5 segundos — tempo de
// sobra para cada tanque disparar ~9 vezes (cadência de 0,55 s), as balas ricochetearem, matarem
// e morrerem de velhice. Rodadas mais longas não acrescentam tipo novo de evento; acrescentam
// custo.
const TicksPadrao = 300

// aspectos é a lista de proporções de tela testadas, uma por seed. Inclui de propósito valores
// fora da faixa [MazeAspectMin, MazeAspectMax] para exercitar o grampeamento de `MazeShape`.
var aspectos = [6]float64{16.0 / 9.0, 4.0 / 3.0, 21.0 / 9.0, 1.0, 3.2, 2.5}

// Cenario deriva os parâmetros da partida a partir da seed. Derivar em vez de fixar é o que faz a
// varredura de 10.000 seeds cobrir salas de 2 a 10 jogadores e seis formatos de tela, em vez de
// repetir 10.000 vezes o mesmo caso.
func Cenario(seed uint32) (players float64, aspect float64) {
	return float64(2 + seed%9), aspectos[seed%6]
}

// nomes dos tanques — ASCII e de comprimento fixo, porque a ordenação por ID entra na resolução
// de sobreposição entre tanques e a comparação de strings do Go (bytes UTF-8) só coincide com a
// do JavaScript (unidades UTF-16) enquanto tudo for ASCII.
func nomeTanque(i int) string {
	return "t" + string(rune('0'+i/10)) + string(rune('0'+i%10))
}

// Executar roda o cenário inteiro de uma seed e despeja tudo no sink.
//
// A ordem em que os registros saem faz parte do contrato: ela tem que ser idêntica à do
// `go/ts/paridade.mjs`, senão os resumos divergem mesmo com a simulação correta.
func Executar(seed uint32, ticks int, s Sink) {
	players, aspect := Cenario(seed)
	n := int(players)

	maze := sim.MakeMaze(seed, players, aspect)
	s.Registro(SecMaze, "maze", maze.Cols, maze.Rows, maze.Cell, len(maze.Walls))
	for i, w := range maze.Walls {
		s.Registro(SecMaze, "parede", i, w.X, w.Y, w.W, w.H)
	}

	val := sim.ValidateMaze(maze)
	s.Registro(SecMaze, "validacao", val.OK, val.Reason)
	s.Registro(SecMaze, "becos", sim.CountDeadEnds(maze))

	// Um punhado de consultas de caminho. `NextStepTowards` é BFS sobre o grafo do labirinto e não
	// é usado pelo `Step` — quem chama é a IA dos bots, que ainda não foi portada. Entra aqui
	// porque a função JÁ está portada, e código portado sem comparação é código não provado.
	for i := 0; i < 6; i++ {
		from := sim.Vec2{X: float64(i*37%maze.Cols) * maze.Cell, Y: float64(i*53%maze.Rows) * maze.Cell}
		to := sim.Vec2{X: float64((i*29+3)%maze.Cols) * maze.Cell, Y: float64((i*17+1)%maze.Rows) * maze.Cell}
		passo := sim.NextStepTowards(maze, from, to)
		cx, cy := sim.CellOf(maze, from)
		s.Registro(SecMaze, "caminho", i, from.X, from.Y, to.X, to.Y, passo.X, passo.Y, cx, cy)
	}

	// O RNG dos spawns é o mesmo objeto que já gerou o labirinto no TypeScript? Não: lá
	// `makeMaze` cria o seu e o descarta. Aqui e lá o gerador de spawns nasce de uma segunda
	// semente, derivada da primeira, para que as duas pontas consumam a mesma sequência.
	rngSpawn := sim.Mulberry32(seed ^ 0x9e3779b9)
	spawns := sim.SpawnPoints(maze, n, rngSpawn)
	for i, p := range spawns {
		s.Registro(SecSpawns, "spawn", i, p.X, p.Y)
	}
	s.Registro(SecSpawns, "estado_rng", int(rngSpawn.State()))

	// Power-ups distribuídos por um RNG PRÓPRIO, e não pelo do roteiro. Se saíssem do mesmo
	// gerador que sorteia os comandos, mudar a regra de distribuição deslocaria toda a sequência
	// de comandos junto, e uma divergência de paridade viria acompanhada de uma partida
	// completamente diferente — impossível de diagnosticar.
	//
	// Sem isto, os quatro efeitos ficariam em zero nas 10.000 seeds e o porte deles não estaria
	// provado: `ricochete` em especial MUDA A TRAJETÓRIA (a bala passa a quicar duas vezes), que é
	// exatamente o tipo de código que precisa bater bit a bit entre servidor e navegador.
	rngPower := sim.Mulberry32(seed ^ 0xa5a5a5a5)
	tanks := make([]*sim.Tank, n)
	for i := 0; i < n; i++ {
		p := spawns[i]
		t := &sim.Tank{
			ID:      nomeTanque(i),
			X:       p.X,
			Y:       p.Y,
			Heading: float64(i) * doisPi() / float64(n),
			Turret:  float64(i) * doisPi() / float64(n),
			Alive:   true,
		}
		if rngPower.Next() < 0.35 {
			t.Ricochete = int(protocol.PowerupValor["ricochete"])
		}
		if rngPower.Next() < 0.35 {
			t.Municao = int(protocol.PowerupValor["municao"])
		}
		if rngPower.Next() < 0.35 {
			t.Recarga = protocol.PowerupValor["recarga"]
		}
		if rngPower.Next() < 0.35 {
			t.Turbo = protocol.PowerupValor["turbo"]
		}
		s.Registro(SecSpawns, "powerup", i, t.Ricochete, t.Municao, t.Recarga, t.Turbo)
		tanks[i] = t
	}
	state := sim.NewSimState(maze, tanks)

	// O roteiro de comandos também sai de um RNG semeado — é o que dá variedade real (perseguir,
	// atirar, errar, ricochetear, se matar) sem precisar escrever à mão 10.000 partidas.
	rngRoteiro := sim.Mulberry32(seed ^ 0x5f356495)
	dt := 1.0 / float64(protocol.TickHz)
	inputs := make(map[string]sim.Input, n)
	direcoes := make([]int, n)
	for i := range direcoes {
		direcoes[i] = 16 // 16 = parado
	}

	for t := 0; t < ticks; t++ {
		state.Tick = t
		montarInputs(state, rngRoteiro, direcoes, inputs)
		eventos := sim.Step(state, inputs, dt)

		for _, tank := range state.Tanks {
			s.Registro(SecSim, "tanque", t, tank.ID, tank.X, tank.Y, tank.Heading, tank.Turret,
				tank.Alive, tank.FireCooldownLeft)
		}
		for _, b := range state.Bullets {
			s.Registro(SecSim, "bala", t, b.ID, b.OwnerID, b.X, b.Y, b.VX, b.VY, b.Bounces, b.Age, b.Ricochete)
		}
		for _, ev := range eventos {
			registrarEvento(s, ev)
		}
	}

	s.Registro(SecSim, "final", state.Tick, len(state.Bullets), state.NextBulletID, int(rngRoteiro.State()))
}

func doisPi() float64 { return jsmath.Pi() * 2 }

// montarInputs escreve o comando de cada tanque neste tick.
//
// Consome SEMPRE quatro números do RNG por tanque, mesmo para tanque morto, mesmo quando o valor
// não vai ser usado. Consumo condicional funcionaria, mas amarra o alinhamento do gerador à
// lógica do roteiro: bastaria uma das pontas checar "está vivo?" meio passo antes da outra para
// as duas sequências se descolarem, e o sintoma seria uma divergência na simulação — longe da
// causa.
func montarInputs(state *sim.SimState, rng *sim.Rng, direcoes []int, inputs map[string]sim.Input) {
	n := len(state.Tanks)
	for i, tank := range state.Tanks {
		p1 := rng.Next()
		p2 := rng.Next()
		p3 := rng.Next()
		p4 := rng.Next()

		if p1 < 0.10 {
			direcoes[i] = int(p2 * 17)
		}

		// Mira no vizinho seguinte da lista, com erro de ±0,3 rad. Perseguir um alvo de verdade é
		// o que faz aparecerem morte, autogol e choque entre balas — um roteiro de tiros ao acaso
		// quase nunca acerta e deixaria metade da simulação sem cobertura.
		alvo := state.Tanks[(i+1)%n]
		aim := jsmath.Atan2(alvo.Y-tank.Y, alvo.X-tank.X) + (p4*0.6 - 0.3)

		in := sim.Input{Fire: p3 < 0.06, Aim: aim, AimAtivo: true}
		if direcoes[i] < 16 {
			in.Mover = float64(direcoes[i]) * doisPi() / 16
			in.MoverAtivo = true
		}
		inputs[tank.ID] = in
	}
}

func registrarEvento(s Sink, ev sim.SimEvent) {
	switch ev.Type {
	case sim.EvShot:
		s.Registro(SecEventos, "shot", ev.Tick, ev.OwnerID, ev.BulletID, ev.X, ev.Y, ev.Angle, ev.VX, ev.VY, ev.Ricochete)
	case sim.EvBounce:
		s.Registro(SecEventos, "bounce", ev.Tick, ev.BulletID, ev.X, ev.Y, ev.Normal.X, ev.Normal.Y)
	case sim.EvDeath:
		s.Registro(SecEventos, "death", ev.Tick, ev.VictimID, ev.KillerID, ev.X, ev.Y, ev.Autogol)
	case sim.EvBulletExpired:
		s.Registro(SecEventos, "expired", ev.Tick, ev.BulletID, ev.Reason, ev.X, ev.Y)
	case sim.EvBulletClash:
		s.Registro(SecEventos, "clash", ev.Tick, ev.AID, ev.BID, ev.X, ev.Y)
	default:
		panic("evento desconhecido: " + string(ev.Type))
	}
}
