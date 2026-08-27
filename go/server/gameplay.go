package server

import (
	"github.com/simplex/tank/go/powerups"
	"github.com/simplex/tank/go/sim"
)

// A COSTURA entre a sala e as duas peças de simulação que não são dela: a IA dos bots
// (`shared-sim/src/bot.ts` → `go/sim/bot.go`) e a agenda de power-ups
// (`shared-sim/src/powerups.ts` → `go/powerups`), ambas portadas em paralelo a este servidor.
//
// A sala não chama `sim.MakeBot` nem `powerups.NovoCampo` direto: ela fala com as interfaces
// daqui. Foi isso que permitiu escrever, compilar e PROVAR o servidor enquanto os dois portes
// ainda estavam em voo — e depois ligá-los mexendo só neste arquivo, sem tocar em `sala.go`.
//
// As interfaces não são as assinaturas dos portes. São o que a SALA precisa: `NoChao` devolve
// posições porque é com isso que ela alimenta os bots, e não itens inteiros, que são assunto de
// quem desenha. Adaptar aqui é o que impede a forma de um pacote vizinho de vazar para o ciclo de
// partida.

// CerebroDeBot é tudo que a sala precisa de um bot: um `Input` por tick.
//
// Assinatura espelhando `Bot.think(tank, target, maze, tick, mundo)` do TypeScript — `balas` e
// `itens` são o `BotMundo`, achatado em dois parâmetros porque em Go um struct opcional só
// renderia um ponteiro a mais para conferir.
type CerebroDeBot interface {
	Think(tank *sim.Tank, alvo sim.Vec2, maze *sim.Maze, tick int, balas []*sim.Bullet, itens []sim.Vec2) sim.Input
}

// FabricaDeBots cria os cérebros de UMA rodada.
//
// Ela existe por causa do `BotMemos`, que é a memória compartilhada do porte: voo de bala previsto
// e passo de BFS memorizados. Compartilhar entre os bots da MESMA sala é de graça (o valor
// guardado é idêntico ao recalculado, então quem consulta primeiro não muda o resultado de quem
// consulta depois) e economiza a varredura; compartilhar entre SALAS acoplaria partidas que não
// têm nada a ver uma com a outra. Uma fábrica por rodada é exatamente esse recorte.
type FabricaDeBots interface {
	Novo(rng *sim.Rng, dificuldade string) CerebroDeBot
}

// ColetaDePowerUp é um item pego por um tanque neste tick — decisão do SERVIDOR, como a morte.
type ColetaDePowerUp struct {
	ItemID int
	Tipo   string
	TankID string
	X      float64
	Y      float64
}

// FimDeEfeito é um bônus que acabou (relógio zerou ou o tanque morreu).
type FimDeEfeito struct {
	TankID string
	Tipo   string
}

// CampoDePowerUps é a agenda determinística de itens da rodada. Nasce da MESMA seed do labirinto,
// então o cliente monta um igual sozinho e o nascimento não gasta um byte de rede.
//
// `NoChao` devolve só POSIÇÕES porque é o que o servidor faz com elas: alimentar os bots. Quem
// desenha o item (tipo, cor, relógio, paraquedas) é o cliente, que tem a agenda inteira.
type CampoDePowerUps interface {
	NoChao(tick int) []sim.Vec2
	Coletar(estado *sim.SimState, tick int) []ColetaDePowerUp
	MarcarPego(itemID int)
}

// EfeitosDePowerUp é o relógio dos bônus ativos. É o único lugar do servidor que liga e desliga os
// campos de power-up do `Tank`.
type EfeitosDePowerUp interface {
	Aplicar(tank *sim.Tank, tipo string)
	Passo(estado *sim.SimState, dt float64) []FimDeEfeito
	Limpar()
}

// NovaFabricaDeBots aponta para o porte de `bot.ts` que aterrissou em `go/sim/bot.go`.
var NovaFabricaDeBots = func() FabricaDeBots {
	return &fabricaDoSim{memos: sim.NovosBotMemos()}
}

// NovoCampoDePowerUps aponta para o porte de `powerups.ts` que aterrissou em `go/powerups`.
//
// `nil` aqui não é erro: a rodada simplesmente roda sem itens. Foi assim que o servidor rodou
// enquanto o porte estava em voo — e é melhor do que uma agenda inventada aqui, porque o cliente
// deriva a dele da seed com o código do TypeScript e duas agendas diferentes colocariam o item num
// canto da arena para o servidor e noutro para a tela.
var NovoCampoDePowerUps = func(maze *sim.Maze, seed uint32) CampoDePowerUps {
	return &campoDoPorte{campo: powerups.NovoCampo(maze, seed)}
}

// NovosEfeitosDePowerUp acompanha `NovoCampoDePowerUps`.
var NovosEfeitosDePowerUp = func() EfeitosDePowerUp {
	return &efeitosDoPorte{efeitos: powerups.NovosEfeitos()}
}

type campoDoPorte struct {
	campo *powerups.Campo
	// Reaproveitado entre ticks pelo mesmo motivo que o slice de dentro do porte: `NoChao` é
	// chamada uma vez por tick por sala.
	posicoes []sim.Vec2
	coletas  []ColetaDePowerUp
}

func (c *campoDoPorte) NoChao(tick int) []sim.Vec2 {
	itens := c.campo.NoChao(tick)
	c.posicoes = c.posicoes[:0]
	for _, item := range itens {
		c.posicoes = append(c.posicoes, sim.Vec2{X: item.X, Y: item.Y})
	}
	return c.posicoes
}

func (c *campoDoPorte) Coletar(estado *sim.SimState, tick int) []ColetaDePowerUp {
	c.coletas = c.coletas[:0]
	for _, coleta := range c.campo.Coletar(estado, tick) {
		c.coletas = append(c.coletas, ColetaDePowerUp{
			ItemID: coleta.ItemId, Tipo: coleta.Tipo, TankID: coleta.TankId, X: coleta.X, Y: coleta.Y,
		})
	}
	return c.coletas
}

func (c *campoDoPorte) MarcarPego(itemID int) { c.campo.MarcarPego(itemID) }

type efeitosDoPorte struct {
	efeitos *powerups.Efeitos
	fins    []FimDeEfeito
}

func (e *efeitosDoPorte) Aplicar(tank *sim.Tank, tipo string) { e.efeitos.Aplicar(tank, tipo) }
func (e *efeitosDoPorte) Limpar()                             { e.efeitos.Limpar() }

func (e *efeitosDoPorte) Passo(estado *sim.SimState, dt float64) []FimDeEfeito {
	e.fins = e.fins[:0]
	for _, fim := range e.efeitos.Passo(estado, dt) {
		e.fins = append(e.fins, FimDeEfeito{TankID: fim.TankId, Tipo: fim.Tipo})
	}
	return e.fins
}

type fabricaDoSim struct {
	memos *sim.BotMemos
}

func (f *fabricaDoSim) Novo(rng *sim.Rng, dificuldade string) CerebroDeBot {
	config, conhecida := sim.BotDificuldade[dificuldade]
	if !conhecida {
		config = sim.BotDificuldade["medio"]
	}
	return &cerebroDoSim{bot: sim.MakeBot(f.memos, rng, config)}
}

type cerebroDoSim struct {
	bot   *sim.Bot
	mundo sim.BotMundo
}

func (c *cerebroDoSim) Think(tank *sim.Tank, alvo sim.Vec2, maze *sim.Maze, tick int, balas []*sim.Bullet, itens []sim.Vec2) sim.Input {
	// O `BotMundo` é reaproveitado entre ticks: ele é lido e descartado dentro de `Think`, e
	// alocar um por tanque por tick renderia lixo de sobra num laço de 60 Hz com dez bots.
	c.mundo.Bullets = balas
	c.mundo.Powerups = itens
	return c.bot.Think(tank, alvo, maze, tick, &c.mundo)
}
