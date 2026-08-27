package paridade

import (
	"github.com/simplex/tank/go/protocol"
	"github.com/simplex/tank/go/sim"
)

// Cenário de paridade da IA — o espelho de `executarBots` em `go/ts/paridade.mjs`.
//
// O que ele compara NÃO é o placar nem a posição final: é a SEQUÊNCIA DE `Input` que cada bot
// produz, tick a tick. Um bot que chega ao mesmo canto do labirinto por um caminho diferente já é
// divergência, e só a sequência de comandos pega isso — o estado final não pega.
//
// Os itens de power-up que alimentam `BotMundo.Powerups` são SINTÉTICOS aqui, sorteados de um RNG
// próprio e com um calendário de aritmética inteira. Não saem da agenda de `powerups`, e isso é
// deliberado: se saíssem, uma divergência na agenda derrubaria as duas etapas ao mesmo tempo e os
// dois números deixariam de ser independentes. Assim, "bots: 10.000/10.000" continua significando
// alguma coisa mesmo que os power-ups quebrem.

// TicksBotsPadrao é quantos ticks cada seed de bot simula. A 60 Hz são 5 segundos — tempo para a
// varredura de ricochete fatiada completar várias vezes (32 amostras em 4 ticks, com espera de 20
// entre planos), para a memória de ameaça de 45 ticks entrar e sair, e para haver morte.
const TicksBotsPadrao = 300

// itensSinteticos é quantas posições de item o cenário sorteia por seed.
const itensSinteticos = 3

// Calendário dos itens sintéticos: puro inteiro, para não haver nem a chance de um arredondamento
// diferente decidir se o item está no chão neste tick.
const (
	cicloDoItem     = 240
	itemNoChaoAte   = 150
	passoEntreItens = 37
)

// sementeDoBot deriva a semente de cada bot da seed da partida e do índice do tanque.
//
// Sementes DIFERENTES por bot são parte do desenho, não detalhe: a fase do escalonamento sai do
// RNG do bot, e é ela que impede os dez bots da sala de começarem a varredura de ricochete no
// mesmo tick. Bots com a mesma semente cairiam todos na mesma fase.
func sementeDoBot(seed uint32, i int) uint32 {
	return (seed ^ 0x0b07b07b) + uint32(i)*0x9e3779b9
}

// nivelDoBot distribui as três dificuldades pelos tanques. O deslocamento pela seed é o que faz as
// três aparecerem mesmo nas salas de dois jogadores, ao longo da varredura.
func nivelDoBot(seed uint32, i int) string {
	return sim.NiveisDeBot[(int(seed)+i)%3]
}

// inimigoMaisProximo é o mesmo alvo que o `TankRoom` escolhe: o tanque vivo mais próximo, com o
// empate resolvido pelo primeiro da ordem de inserção — nunca pela ordem de um mapa.
func inimigoMaisProximo(state *sim.SimState, eu *sim.Tank) (sim.Vec2, bool) {
	var melhor *sim.Tank
	melhorDist2 := 0.0
	for _, tank := range state.Tanks {
		if tank.ID == eu.ID || !tank.Alive {
			continue
		}
		dx := tank.X - eu.X
		dy := tank.Y - eu.Y
		dist2 := dx*dx + dy*dy
		if melhor == nil || dist2 < melhorDist2 {
			melhorDist2 = dist2
			melhor = tank
		}
	}
	if melhor == nil {
		return sim.Vec2{}, false
	}
	// Cópia, e não o próprio tanque: o bot guarda a posição do alvo de um tick para o outro para
	// estimar a velocidade dele, e uma referência viva faria a diferença dar sempre zero.
	return sim.Vec2{X: melhor.X, Y: melhor.Y}, true
}

// ExecutarBots roda uma partida inteira dirigida por bots e despeja tudo no sink.
func ExecutarBots(seed uint32, ticks int, s Sink) Cobertura {
	var cob Cobertura
	cob.Seeds = 1

	players, aspect := Cenario(seed)
	n := int(players)

	maze := sim.MakeMaze(seed, players, aspect)
	s.Registro(SecMaze, "maze", maze.Cols, maze.Rows, maze.Cell, len(maze.Walls))

	rngSpawn := sim.Mulberry32(seed ^ 0x9e3779b9)
	spawns := sim.SpawnPoints(maze, n, rngSpawn)

	tanks := make([]*sim.Tank, n)
	for i := 0; i < n; i++ {
		p := spawns[i]
		tanks[i] = &sim.Tank{
			ID:      nomeTanque(i),
			X:       p.X,
			Y:       p.Y,
			Heading: float64(i) * doisPi() / float64(n),
			Turret:  float64(i) * doisPi() / float64(n),
			Alive:   true,
		}
		s.Registro(SecSpawns, "spawn", i, p.X, p.Y)
	}
	state := sim.NewSimState(maze, tanks)

	// Uma memória para a partida inteira, compartilhada pelos bots dela — é assim que o
	// TypeScript funciona (lá os memos são de MÓDULO) e é o que garante que o voo previsto de uma
	// bala seja calculado uma vez, e não uma vez por bot.
	memos := sim.NovosBotMemos()
	bots := make([]*sim.Bot, n)
	for i := 0; i < n; i++ {
		nivel := nivelDoBot(seed, i)
		bots[i] = sim.MakeBot(memos, sim.Mulberry32(sementeDoBot(seed, i)), sim.BotDificuldade[nivel])
		s.Registro(SecBots, "nivel", i, nomeTanque(i), nivel)
	}

	rngItens := sim.Mulberry32(seed ^ 0x17e11a5b)
	posicoes := make([]sim.Vec2, itensSinteticos)
	for k := range posicoes {
		posicoes[k] = sim.CellCenter(maze, rngItens.Int(maze.Cols), rngItens.Int(maze.Rows))
		s.Registro(SecBots, "item", k, posicoes[k].X, posicoes[k].Y)
	}

	dt := 1.0 / float64(protocol.TickHz)
	inputs := make(map[string]sim.Input, n)
	itens := make([]sim.Vec2, 0, itensSinteticos)

	for t := 0; t < ticks; t++ {
		state.Tick = t

		itens = itens[:0]
		for k := 0; k < itensSinteticos; k++ {
			if (t+k*passoEntreItens)%cicloDoItem < itemNoChaoAte {
				itens = append(itens, posicoes[k])
			}
		}
		mundo := &sim.BotMundo{Bullets: state.Bullets, Powerups: itens}

		clear(inputs)
		for i, tank := range state.Tanks {
			if !tank.Alive {
				continue
			}
			alvo, temAlvo := inimigoMaisProximo(state, tank)
			if !temAlvo {
				continue
			}
			in := bots[i].Think(tank, alvo, maze, t, mundo)
			inputs[tank.ID] = in
			s.Registro(SecBots, "input", t, tank.ID, in.Mover, in.MoverAtivo, in.Fire, in.Aim, in.AimAtivo)
		}

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
			switch ev.Type {
			case sim.EvShot:
				cob.Disparos++
			case sim.EvDeath:
				cob.Mortes++
			}
		}
	}

	s.Registro(SecSim, "final", state.Tick, len(state.Bullets), state.NextBulletID)
	if cob.Mortes > 0 {
		cob.SeedsComMorte = 1
	}
	if cob.Disparos > 0 {
		cob.SeedsComDisparo = 1
	}
	return cob
}
