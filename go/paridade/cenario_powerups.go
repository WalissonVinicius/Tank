package paridade

import (
	"github.com/simplex/tank/go/internal/jsmath"
	"github.com/simplex/tank/go/powerups"
	"github.com/simplex/tank/go/protocol"
	"github.com/simplex/tank/go/sim"
)

// Cenário de paridade dos power-ups — o espelho de `executarPowerups` em `go/ts/paridade.mjs`.
//
// Ele responde a quatro perguntas, e as quatro entram no mesmo resumo:
//
//  1. a AGENDA inteira da rodada (20 itens): mesmos tipos, nos mesmos pontos, nos mesmos ticks;
//  2. o que está no CHÃO e o que está CAINDO em cada tick;
//  3. quem PEGOU o quê, com a arbitragem de empate por distância e por id;
//  4. o RELÓGIO de cada efeito, em segundos, e os quatro campos que a simulação lê do tanque.
//
// E, por cima disso, a bala: `simulacao` e `eventos` carregam `Bullet.Ricochete` tick a tick, que
// é o carimbo. Uma bala disparada com ricochete duplo tem que voar igual nos dois lados DEPOIS de
// o efeito expirar no dono — a armadilha que o `powerups.test.ts` chama pelo nome.

// TicksPowerupsPadrao é quantos ticks cada seed simula aqui. Bem mais que os 300 do cenário de
// partida, e por um motivo: o primeiro item da agenda só nasce aos 4 s (tick 240) e os efeitos
// duram de 9 a 12 s. Com 600 ticks (10 s) a rodada cobre um nascimento, a coleta dele, a expiração
// dos efeitos sorteados na largada e o sumiço por tempo de um item que ninguém pegou.
const TicksPowerupsPadrao = 600

// chanceDeEfeitoInicial é a probabilidade de cada tanque começar a rodada com cada um dos quatro
// efeitos ligados.
//
// Existe porque a agenda sozinha não cobriria o assunto em 600 ticks: sem efeito na largada não há
// bala carimbada antes do tick 240, e a EXPIRAÇÃO — que é a armadilha do ricochete — nunca
// aconteceria dentro da janela. Ligar os efeitos pelo relógio de verdade (`Efeitos.Aplicar`), e
// não escrevendo nos campos do tanque à mão, é o que faz este atalho exercitar o código portado em
// vez de contorná-lo.
const chanceDeEfeitoInicial = 0.35

// Cobertura conta o que uma varredura de seeds realmente exercitou. Um relatório que só sabe dizer
// "10.000/10.000 bateram" não distingue "provei" de "os dois lados não fizeram nada".
type Cobertura struct {
	Seeds              int
	SeedsComColeta     int
	SeedsComMorte      int
	SeedsComDisparo    int
	Coletas            int
	FinsDeEfeito       int
	Disparos           int
	DisparosCarimbados int
	Mortes             int
}

// Somar acumula a cobertura de uma seed.
func (c *Cobertura) Somar(o Cobertura) {
	c.Seeds += o.Seeds
	c.SeedsComColeta += o.SeedsComColeta
	c.SeedsComMorte += o.SeedsComMorte
	c.SeedsComDisparo += o.SeedsComDisparo
	c.Coletas += o.Coletas
	c.FinsDeEfeito += o.FinsDeEfeito
	c.Disparos += o.Disparos
	c.DisparosCarimbados += o.DisparosCarimbados
	c.Mortes += o.Mortes
}

// ExecutarPowerups roda uma rodada inteira com a camada de power-ups ligada.
func ExecutarPowerups(seed uint32, ticks int, s Sink) Cobertura {
	var cob Cobertura
	cob.Seeds = 1

	players, aspect := Cenario(seed)
	n := int(players)

	maze := sim.MakeMaze(seed, players, aspect)
	s.Registro(SecMaze, "maze", maze.Cols, maze.Rows, maze.Cell, len(maze.Walls))

	campo := powerups.NovoCampo(maze, seed)
	for _, item := range campo.AgendaDaRodada() {
		s.Registro(SecPowerups, "agenda", item.Id, item.Tipo, item.X, item.Y, item.NasceEmTick, item.SumeEmTick)
	}

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

	efeitos := powerups.NovosEfeitos()
	rngPower := sim.Mulberry32(seed ^ 0xa5a5a5a5)
	for i, tank := range tanks {
		for _, tipo := range protocol.TiposDePowerUp {
			if rngPower.Next() < chanceDeEfeitoInicial {
				efeitos.Aplicar(tank, tipo)
			}
		}
		s.Registro(SecPowerups, "inicial", i, tank.Ricochete, tank.Municao, tank.Recarga, tank.Turbo)
	}

	rngRoteiro := sim.Mulberry32(seed ^ 0x5f356495)
	dt := 1.0 / float64(protocol.TickHz)
	inputs := make(map[string]sim.Input, n)
	direcoes := make([]int, n)
	for i := range direcoes {
		direcoes[i] = 16 // 16 = parado
	}

	for t := 0; t < ticks; t++ {
		state.Tick = t

		itens := campo.NoChao(t)
		s.Registro(SecPowerups, "chao", t, len(itens))
		for _, item := range itens {
			s.Registro(SecPowerups, "item", t, item.Id, item.Tipo, item.X, item.Y)
		}
		// `Caindo` usa um buffer próprio, então chamar aqui não estraga `itens`.
		noAr := campo.Caindo(t)
		s.Registro(SecPowerups, "ar", t, len(noAr))
		for _, item := range noAr {
			s.Registro(SecPowerups, "caindo", t, item.Id)
		}

		montarInputsColetor(state, rngRoteiro, direcoes, inputs, itens)
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
				if ev.Ricochete > 0 {
					cob.DisparosCarimbados++
				}
			case sim.EvDeath:
				cob.Mortes++
			}
		}

		// Primeiro o que ACABOU, depois o que foi PEGO — a mesma ordem do `TankRoom`. O contrário
		// deixaria um efeito recém-pego levar um decremento de `dt` no mesmo tick da coleta e, no
		// caso de uma renovação, poderia até expirá-lo na hora.
		for _, fim := range efeitos.Passo(state, dt) {
			s.Registro(SecPowerups, "fim", t, fim.TankId, fim.Tipo)
			cob.FinsDeEfeito++
		}
		for _, coleta := range campo.Coletar(state, t) {
			if tank := state.Tank(coleta.TankId); tank != nil {
				efeitos.Aplicar(tank, coleta.Tipo)
			}
			s.Registro(SecPowerups, "coleta", t, coleta.ItemId, coleta.Tipo, coleta.TankId, coleta.X, coleta.Y)
			cob.Coletas++
		}

		for _, tank := range state.Tanks {
			s.Registro(SecPowerups, "campos", t, tank.ID, tank.Ricochete, tank.Municao, tank.Recarga, tank.Turbo)
			for _, ef := range efeitos.Ativos(tank.ID) {
				s.Registro(SecPowerups, "efeito", t, tank.ID, ef.Tipo, ef.Restante, ef.Duracao)
			}
		}
	}

	s.Registro(SecSim, "final", state.Tick, len(state.Bullets), state.NextBulletID, int(rngRoteiro.State()))

	if cob.Coletas > 0 {
		cob.SeedsComColeta = 1
	}
	if cob.Mortes > 0 {
		cob.SeedsComMorte = 1
	}
	if cob.Disparos > 0 {
		cob.SeedsComDisparo = 1
	}
	return cob
}

// itemMaisPerto é o item no chão mais próximo do tanque, com empate resolvido pelo primeiro da
// lista — que chega na ordem da agenda, determinística.
func itemMaisPerto(tank *sim.Tank, itens []powerups.Item) (powerups.Item, bool) {
	var melhor powerups.Item
	achou := false
	melhorDist2 := jsmath.Inf()
	for _, item := range itens {
		dx := item.X - tank.X
		dy := item.Y - tank.Y
		dist2 := dx*dx + dy*dy
		if dist2 < melhorDist2 {
			melhorDist2 = dist2
			melhor = item
			achou = true
		}
	}
	return melhor, achou
}

// montarInputsColetor é o roteiro de comandos desta etapa: o mesmo do cenário de partida, com UMA
// diferença — havendo item no chão, o tanque anda na direção dele.
//
// Sem isso a etapa seria vazia. Tanques andando ao acaso quase nunca encostam num item de 15 px de
// raio, e a coleta, a arbitragem de empate e a renovação de efeito ficariam sem cobertura nenhuma
// nas 10.000 seeds — a comparação diria "bateu" sobre um caminho que ninguém percorreu.
//
// O consumo do RNG continua sendo de QUATRO números por tanque por tick, sempre, mesmo para tanque
// morto e mesmo quando o valor não é usado: é o alinhamento do gerador que amarra as duas pontas.
func montarInputsColetor(
	state *sim.SimState,
	rng *sim.Rng,
	direcoes []int,
	inputs map[string]sim.Input,
	itens []powerups.Item,
) {
	n := len(state.Tanks)
	for i, tank := range state.Tanks {
		p1 := rng.Next()
		p2 := rng.Next()
		p3 := rng.Next()
		p4 := rng.Next()

		if p1 < 0.10 {
			direcoes[i] = int(p2 * 17)
		}

		alvo := state.Tanks[(i+1)%n]
		aim := jsmath.Atan2(alvo.Y-tank.Y, alvo.X-tank.X) + (p4*0.6 - 0.3)

		in := sim.Input{Fire: p3 < 0.06, Aim: aim, AimAtivo: true}
		if item, temItem := itemMaisPerto(tank, itens); temItem {
			in.Mover = jsmath.Atan2(item.Y-tank.Y, item.X-tank.X)
			in.MoverAtivo = true
		} else if direcoes[i] < 16 {
			in.Mover = float64(direcoes[i]) * doisPi() / 16
			in.MoverAtivo = true
		}
		inputs[tank.ID] = in
	}
}
