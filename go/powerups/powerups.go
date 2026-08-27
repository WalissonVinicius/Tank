// Package powerups é o porte de `packages/shared-sim/src/powerups.ts`: a agenda determinística de
// nascimento dos itens, a arbitragem da coleta e o relógio dos efeitos.
//
// Ele NÃO é chamado de dentro de `sim.Step` — quem chama é o HOST da simulação (o `TankRoom` no
// online, o `main.ts` no modo local). A simulação apenas LÊ os quatro campos aditivos do tanque
// (`Ricochete`, `Municao`, `Recarga`, `Turbo`); quem os liga e desliga é esta camada. Por isso
// mora num pacote separado de `sim`, e não dentro dele.
//
// A DIVISÃO DE PODER, que é o que faz isto funcionar em rede:
//
//   - o NASCIMENTO (onde, quando, qual tipo) sai do RNG semeado da rodada — servidor e cliente
//     chegam à mesma agenda sem trocar um byte, igual ao labirinto e aos spawns;
//   - QUEM PEGOU é decisão exclusiva do servidor, e vira evento como a morte.
//
// Regras do porte, iguais às do pacote `sim`: toda conta de ponto flutuante passa por
// `internal/jsmath`, nunca pelo `math` nativo, e onde o TypeScript depende da ordem de inserção de
// um `Map` aqui existe um slice ordenado — `range` sobre mapa em Go é aleatório de propósito.
package powerups

import (
	"github.com/simplex/tank/go/internal/jsmath"
	"github.com/simplex/tank/go/protocol"
	"github.com/simplex/tank/go/sim"
)

// Item é uma entrada da agenda da rodada. Imutável depois de gerada.
type Item struct {
	// Id é o índice na agenda — é a identidade do item na rede (`PowerupTakenMsg.itemId`).
	Id   int
	Tipo string
	X    float64
	Y    float64
	// NasceEmTick é o tick da rodada em que ele aparece no chão.
	NasceEmTick int
	// SumeEmTick é o tick em que ele some sozinho, se ninguém tiver pegado.
	SumeEmTick int
}

// Coleta é um item que saiu do chão na mão de alguém.
type Coleta struct {
	ItemId int
	Tipo   string
	TankId string
	X      float64
	Y      float64
}

// itensPorRodada é quantos itens a agenda cobre. `ROUND_TIMEOUT` é 45 s, mas a morte súbita pode
// esticar a rodada além disso — 20 itens cobrem ~2 min de jogo. O que não chega a nascer
// simplesmente nunca sai da lista.
const itensPorRodada = 20

// celulasDeFolga é a distância mínima, em células, entre dois itens consecutivos da agenda.
const celulasDeFolga = 2

// tentativasDeCelula é quantas vezes o sorteio de célula é refeito por item. FIXO — um laço "até
// achar" consumiria uma quantidade variável de RNG e a agenda deixaria de ser reproduzível entre
// as pontas.
const tentativasDeCelula = 8

// Agenda monta a agenda da rodada: mesma seed produz os mesmos itens, nos mesmos lugares, nos
// mesmos ticks.
//
// O RNG é PRÓPRIO, derivado da seed, e não o mesmo objeto que gera labirinto e spawns. Se
// consumisse daquela sequência, a agenda mudaria conforme o número de jogadores da sala (que
// decide quantos spawns são sorteados antes dela) e quem entrasse no meio da partida montaria uma
// arena diferente da dos outros.
func Agenda(m *sim.Maze, seed uint32) []Item {
	rng := sim.Mulberry32(seed ^ 0x5f356495)
	itens := make([]Item, 0, itensPorRodada)

	// Saco de sorteio em vez de escolha solta: os quatro tipos saem antes de qualquer um repetir.
	// Sorteio independente daria três ricochetes seguidos com facilidade.
	saco := make([]string, 0, len(protocol.TiposDePowerUp))
	proximoTipo := func() string {
		if len(saco) == 0 {
			embaralhado := make([]string, len(protocol.TiposDePowerUp))
			copy(embaralhado, protocol.TiposDePowerUp[:])
			sim.Shuffle(rng, embaralhado)
			saco = append(saco, embaralhado...)
		}
		ultimo := saco[len(saco)-1]
		saco = saco[:len(saco)-1]
		return ultimo
	}

	folga := float64(celulasDeFolga) * m.Cell
	anteriorX, anteriorY := 0.0, 0.0
	temAnterior := false

	vidaEmTicks := int(jsmath.Round(protocol.PowerupVidaNoMapaS * float64(protocol.TickHz)))

	for i := 0; i < itensPorRodada; i++ {
		// O QUANDO também sai da seed: ritmo fixo com jitter sorteado. `Round` fecha num tick
		// inteiro idêntico nas duas pontas, sem depender de como cada uma acumula segundos.
		segundos := protocol.PowerupPrimeiroS + float64(i)*protocol.PowerupIntervaloS +
			(rng.Next()*2-1)*protocol.PowerupJitterS
		nasceEmTick := int(jsmath.Round(segundos * float64(protocol.TickHz)))

		// Célula sorteada, rejeitando as coladas no item anterior. Número FIXO de tentativas: ver
		// o comentário de `tentativasDeCelula`.
		x, y := 0.0, 0.0
		for tentativa := 0; tentativa < tentativasDeCelula; tentativa++ {
			centro := sim.CellCenter(m, rng.Int(m.Cols), rng.Int(m.Rows))
			x = centro.X
			y = centro.Y
			if !temAnterior || jsmath.Hypot(x-anteriorX, y-anteriorY) >= folga {
				break
			}
		}
		anteriorX, anteriorY = x, y
		temAnterior = true

		// `proximoTipo()` é consumido AQUI, depois do sorteio de célula: no TypeScript ele está no
		// literal do objeto, que o JavaScript avalia na ordem em que os campos aparecem. Trocar a
		// ordem desloca a sequência inteira do RNG.
		tipo := proximoTipo()
		itens = append(itens, Item{
			Id:          i,
			Tipo:        tipo,
			X:           x,
			Y:           y,
			NasceEmTick: nasceEmTick,
			SumeEmTick:  nasceEmTick + vidaEmTicks,
		})
	}

	return itens
}

// Campo são os itens de uma rodada e o que já saiu do chão.
//
// As DUAS pontas instanciam isto com a mesma seed. O servidor chama `Coletar`; o cliente nunca —
// lá ele existe só para saber o que desenhar, e o `powerup_taken` que chega pela rede entra por
// `MarcarPego`.
type Campo struct {
	agenda   []Item
	pegos    map[int]bool
	visiveis []Item
	noAr     []Item
	coletas  []Coleta
}

// NovoCampo monta o campo da rodada a partir do labirinto e da seed.
func NovoCampo(m *sim.Maze, seed uint32) *Campo {
	return &Campo{agenda: Agenda(m, seed), pegos: make(map[int]bool)}
}

// AgendaDaRodada é a lista completa de itens, nascidos ou não.
func (c *Campo) AgendaDaRodada() []Item { return c.agenda }

func (c *Campo) estaNoChao(item *Item, tick int) bool {
	return item.NasceEmTick <= tick && item.SumeEmTick > tick && !c.pegos[item.Id]
}

// NoChao devolve os itens no chão neste tick. O slice é REAPROVEITADO entre chamadas (mesmo padrão
// do pool de trechos de bala em `sim`): vale até a próxima chamada, não guarde a referência.
func (c *Campo) NoChao(tick int) []Item {
	c.visiveis = c.visiveis[:0]
	for i := range c.agenda {
		item := &c.agenda[i]
		// A agenda é crescente em tick: o primeiro que ainda não nasceu encerra a varredura.
		if item.NasceEmTick > tick {
			break
		}
		if !c.estaNoChao(item, tick) {
			continue
		}
		c.visiveis = append(c.visiveis, *item)
		if len(c.visiveis) >= protocol.PowerupMaxNoChao {
			break
		}
	}
	return c.visiveis
}

// quedaEmTicks é a queda de paraquedas medida em TICKS. É ela que faz a animação ser IGUAL em
// todo mundo: a altura do item é lida do tick da rodada, nunca do relógio de quem desenha.
var quedaEmTicks = int(jsmath.Round(protocol.PowerupQuedaS * float64(protocol.TickHz)))

// Caindo devolve os itens CAINDO DE PARAQUEDAS neste tick — os que ainda não pousaram.
//
// É uma janela de ANTECIPAÇÃO, não de atraso: o item entra aqui em `NasceEmTick - quedaEmTicks` e
// sai dela no mesmo tick em que `NoChao` o assume, sem buraco entre as duas listas. Por isso a
// DISPONIBILIDADE não muda um tick sequer, e `Coletar` — que lê `estaNoChao` — nunca enxerga um
// item no ar.
//
// Método SEPARADO de `NoChao` de propósito: quem arbitra a coleta e quem alimenta os bots continua
// chamando `NoChao`, e só quem DESENHA chama isto.
func (c *Campo) Caindo(tick int) []Item {
	c.noAr = c.noAr[:0]
	for i := range c.agenda {
		item := &c.agenda[i]
		// A agenda é crescente em tick: o primeiro que nem começou a cair encerra a varredura.
		if item.NasceEmTick-quedaEmTicks > tick {
			break
		}
		if item.NasceEmTick <= tick || c.pegos[item.Id] {
			continue
		}
		c.noAr = append(c.noAr, *item)
		if len(c.noAr) >= protocol.PowerupMaxNoChao {
			break
		}
	}
	return c.noAr
}

// MarcarPego tira o item do chão. Chamado pelo servidor ao arbitrar e pelo cliente ao receber o
// evento.
func (c *Campo) MarcarPego(id int) { c.pegos[id] = true }

// Coletar decide quem encostou em quê neste tick e já tira os itens do chão. SÓ O HOST CHAMA.
//
// Empate resolvido por distância ao centro do item e, se ela empatar, pelo id do tanque — nunca
// pela ordem de iteração, que difere entre servidor e cliente. Um mesmo tanque pode levar dois
// itens no mesmo tick; um mesmo item nunca vai para dois tanques.
func (c *Campo) Coletar(state *sim.SimState, tick int) []Coleta {
	c.coletas = c.coletas[:0]
	raio := protocol.TankRadius + protocol.PowerupRaio
	raio2 := raio * raio

	for i := range c.agenda {
		item := &c.agenda[i]
		if item.NasceEmTick > tick {
			break
		}
		if !c.estaNoChao(item, tick) {
			continue
		}

		var dono *sim.Tank
		menorDist2 := jsmath.Inf()
		for _, tank := range state.Tanks {
			if !tank.Alive {
				continue
			}
			dx := tank.X - item.X
			dy := tank.Y - item.Y
			dist2 := dx*dx + dy*dy
			if dist2 > raio2 {
				continue
			}
			if dist2 < menorDist2 || (dist2 == menorDist2 && dono != nil && tank.ID < dono.ID) {
				menorDist2 = dist2
				dono = tank
			}
		}
		if dono == nil {
			continue
		}

		c.pegos[item.Id] = true
		c.coletas = append(c.coletas, Coleta{
			ItemId: item.Id, Tipo: item.Tipo, TankId: dono.ID, X: item.X, Y: item.Y,
		})
	}

	return c.coletas
}

// EfeitoAtivo é um efeito em curso num tanque.
type EfeitoAtivo struct {
	Tipo string
	// Restante são os segundos que faltam.
	Restante float64
	// Duracao é a duração cheia, para o HUD desenhar a fração sem consultar a tabela.
	Duracao float64
}

// FimDeEfeito é um efeito que acabou neste passo.
type FimDeEfeito struct {
	TankId string
	Tipo   string
}

// escreverNoTanque escreve (ou apaga, com `valor` 0) o bônus no campo correspondente do tanque.
func escreverNoTanque(tank *sim.Tank, tipo string, valor float64) {
	switch tipo {
	case "ricochete":
		tank.Ricochete = int(valor)
	case "municao":
		tank.Municao = int(valor)
	case "recarga":
		tank.Recarga = valor
	case "turbo":
		tank.Turbo = valor
	}
}

// Efeitos são os relógios dos efeitos ativos — o ÚNICO lugar que liga e desliga os campos de
// power-up do `Tank`. Vive no host da simulação, ao lado do `Campo`.
//
// `ordem` existe porque no TypeScript `porTanque` é um `Map`, e `passo()` percorre os tanques na
// ordem de INSERÇÃO. `range` sobre mapa em Go embaralha de propósito: sem o slice, a ordem dos
// eventos de fim de efeito mudaria a cada execução.
type Efeitos struct {
	porTanque map[string][]EfeitoAtivo
	ordem     []string
	fins      []FimDeEfeito
}

// NovosEfeitos cria o relógio vazio.
func NovosEfeitos() *Efeitos {
	return &Efeitos{porTanque: make(map[string][]EfeitoAtivo)}
}

// Aplicar liga o efeito no tanque. Pegar o mesmo tipo de novo RENOVA o relógio, nunca empilha.
//
// Empilhar somaria dois ricochetes e a bala passaria a quicar três vezes — a arena vira pinball e
// o teto do efeito, que é parte do equilíbrio, deixa de existir.
func (e *Efeitos) Aplicar(tank *sim.Tank, tipo string) {
	duracao := protocol.PowerupDuracao[tipo]
	valor := protocol.PowerupValor[tipo]

	lista, existia := e.porTanque[tank.ID]
	if !existia {
		e.ordem = append(e.ordem, tank.ID)
	}

	renovou := false
	for i := range lista {
		if lista[i].Tipo == tipo {
			lista[i].Restante = duracao
			renovou = true
			break
		}
	}
	if !renovou {
		lista = append(lista, EfeitoAtivo{Tipo: tipo, Restante: duracao, Duracao: duracao})
	}
	e.porTanque[tank.ID] = lista

	escreverNoTanque(tank, tipo, valor)
}

// Passo roda um passo dos relógios. Devolve o que acabou NESTE passo, com o campo do tanque já
// apagado — o host só precisa avisar a rede. O slice devolvido é reaproveitado entre chamadas.
//
// Bala já disparada não é tocada: o ricochete dela está carimbado nela, e é assim que uma bala com
// ricochete duplo sobrevive ao fim do efeito no dono.
func (e *Efeitos) Passo(state *sim.SimState, dt float64) []FimDeEfeito {
	e.fins = e.fins[:0]

	// Tanques cujo último efeito acabou. A remoção sai do laço porque em JavaScript apagar uma
	// chave durante o `for...of` de um `Map` não altera a ordem do que falta percorrer — adiar a
	// remoção aqui é a tradução exata daquilo, e não uma otimização.
	var esvaziados []string

	for _, tankID := range e.ordem {
		lista := e.porTanque[tankID]
		tank := state.Tank(tankID)

		// De trás para a frente porque a remoção é por índice — e é essa ordem que decide a
		// sequência dos eventos de fim de efeito.
		for i := len(lista) - 1; i >= 0; i-- {
			lista[i].Restante -= dt
			// Morrer também encerra: voltar vivo na rodada seguinte com ricochete sobrando seria
			// vantagem herdada de uma rodada que já acabou para aquele tanque.
			if lista[i].Restante > 0 && tank != nil && tank.Alive {
				continue
			}
			tipo := lista[i].Tipo
			lista = append(lista[:i], lista[i+1:]...)
			if tank != nil {
				escreverNoTanque(tank, tipo, 0)
			}
			e.fins = append(e.fins, FimDeEfeito{TankId: tankID, Tipo: tipo})
		}

		e.porTanque[tankID] = lista
		if len(lista) == 0 {
			esvaziados = append(esvaziados, tankID)
		}
	}

	for _, tankID := range esvaziados {
		delete(e.porTanque, tankID)
		for i, id := range e.ordem {
			if id == tankID {
				e.ordem = append(e.ordem[:i], e.ordem[i+1:]...)
				break
			}
		}
	}

	return e.fins
}

// Ativos devolve os efeitos ativos de um tanque. Slice interno — leitura por frame, não guarde a
// referência.
func (e *Efeitos) Ativos(tankID string) []EfeitoAtivo { return e.porTanque[tankID] }

// Limpar zera tudo: rodada nova, nenhum efeito atravessa a virada.
func (e *Efeitos) Limpar() {
	e.porTanque = make(map[string][]EfeitoAtivo)
	e.ordem = e.ordem[:0]
}
