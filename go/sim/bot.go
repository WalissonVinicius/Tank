package sim

// Porte de `packages/shared-sim/src/bot.ts` — a IA determinística dos bots.
//
// POR QUE ELE MORA AQUI DENTRO, e não num pacote próprio: o bot chama `raycastSegment` e
// `hasLineOfSight`, que neste porte são métodos de `slabScratch` — um tipo NÃO exportado, porque
// o resultado do slab test sai em campos do rascunho em vez de num objeto alocado. Um pacote
// separado teria que copiar as noventa linhas de `collision.go`, e duas cópias da mesma física é
// exatamente a doença invisível que este porte existe para não ter. Nenhuma linha dos arquivos já
// provados foi tocada: este é um arquivo novo.
//
// Todo o "acaso" (erro de mira, lado de fuga, fase do escalonamento) vem do `Rng` semeado recebido
// por parâmetro — nunca de relógio, nunca de carga de CPU, nunca de `math/rand`.

import (
	"github.com/simplex/tank/go/internal/jsmath"
	"github.com/simplex/tank/go/protocol"
)

// BotConfig são as capacidades do bot, ligadas por dificuldade. Não é sistema de configuração:
// são três chaves booleanas mais quatro números de corpo (mira, gatilho, reflexo e visão de
// ameaça), e as três receitas de `BotDificuldade` são o que o jogo usa.
type BotConfig struct {
	// AimErrorRad é o erro de mira em radianos; maior = bot pior de mira.
	AimErrorRad float64
	// TurnThreshold é o desvio, em rad, abaixo do qual ele considera "já mirando" o bastante para
	// atirar.
	TurnThreshold float64
	// TicksDeReacao é de quantos em quantos ticks ele OLHA para o campo de balas. Entre duas
	// leituras age com a decisão anterior. 1 = reflexo de máquina.
	TicksDeReacao int
	// HorizonteDeAmeaca são os segundos de futuro que ele enxerga na trajetória de uma bala.
	// ZERO = não desvia, e é isso que separa o fácil dos outros dois.
	HorizonteDeAmeaca float64
	// Ricocheteia: sem linha de visão, procura um ângulo que quica e chega no alvo.
	Ricocheteia bool
	// EvitaAutogol: simula o próprio tiro antes de puxar o gatilho e engole o que voltaria em cima
	// dele.
	EvitaAutogol bool
	// UsaParede: sob ameaça ou recarregando, procura posição sem linha de visão; mira antecipando.
	UsaParede bool
}

// NiveisDeBot é a ordem canônica das dificuldades. Slice, e não as chaves do mapa: `range` sobre
// mapa em Go embaralha de propósito.
var NiveisDeBot = [3]string{"facil", "medio", "dificil"}

// BotDificuldade são as três receitas do jogo. O que separa os níveis é o CORPO — quanto de futuro
// ele enxerga, quanto demora para processar o que vê e o quanto a mão treme — e não uma lista de
// capacidades ligadas ou desligadas.
var BotDificuldade = map[string]BotConfig{
	"facil": {
		AimErrorRad:       0.55,
		TurnThreshold:     0.3,
		TicksDeReacao:     12,
		HorizonteDeAmeaca: 0,
		Ricocheteia:       false,
		EvitaAutogol:      false,
		UsaParede:         false,
	},
	"medio": {
		AimErrorRad:       0.16,
		TurnThreshold:     0.13,
		TicksDeReacao:     16,
		HorizonteDeAmeaca: 0.3,
		Ricocheteia:       true,
		EvitaAutogol:      false,
		UsaParede:         false,
	},
	"dificil": {
		AimErrorRad:       0.005,
		TurnThreshold:     0.04,
		TicksDeReacao:     1,
		HorizonteDeAmeaca: protocol.BulletLife,
		Ricocheteia:       true,
		EvitaAutogol:      true,
		UsaParede:         true,
	},
}

// BotMundo é o que o bot enxerga além do labirinto e do inimigo. Ponteiro nulo = ele decide só com
// a geometria.
type BotMundo struct {
	// Bullets são as balas em voo, inclusive as dele — a própria bala também mata depois de
	// SelfImmunity.
	Bullets []*Bullet
	// Powerups são os itens no chão AGORA. Só a posição interessa: o bot desvia para o item mais
	// perto, não escolhe por tipo.
	Powerups []Vec2
}

func powerupsDe(mundo *BotMundo) []Vec2 {
	if mundo == nil {
		return nil
	}
	return mundo.Powerups
}

// -------------------------------------------------------------------------------------------
// Constantes derivadas
//
// Todas são `var` calculadas em float64, e não constantes untyped, pela mesma razão de
// `protocol/constants.go`: `60 * 1.1` como constante untyped do Go é avaliado em precisão
// arbitrária e dá 66 exato, enquanto o JavaScript multiplica o double de 1,1 por 60 e obtém
// 66,00000000000001. A diferença é de um bit e muda o momento em que o bot grampeia a velocidade
// observada do alvo.
// -------------------------------------------------------------------------------------------

var (
	// alcanceBala é o quanto uma bala percorre antes de morrer de velhice, em px.
	alcanceBala = float64(protocol.BulletSpeed) * float64(protocol.BulletLife)
	// raioAcerto é a distância entre centros abaixo da qual a bala encosta no tanque.
	raioAcerto = protocol.TankRadius + protocol.BulletRadius
	// vooAteFicarLetal é o quanto a bala já voou quando a imunidade ao próprio tiro acaba.
	vooAteFicarLetal = float64(protocol.SelfImmunity) * float64(protocol.BulletSpeed)
	// offsetDaBoca é o mesmo de `stepTanks`: a bala nasce da boca do cano, não do centro.
	offsetDaBoca = protocol.TankRadius + protocol.BulletRadius + 4
	// passoDeFuga é a distância percorrida ao sair da linha de tiro. Menos que isso não tira o
	// tanque da frente.
	passoDeFuga = float64(protocol.Cell) * 0.85
	// passoDeCobertura é o raio em que ele procura parede para se esconder.
	passoDeCobertura = float64(protocol.Cell) * 1.15
	// erroQueValeRefinar: acima disso o melhor ângulo grosso nem chegou perto e refinar não
	// salvaria o tiro.
	erroQueValeRefinar = float64(protocol.Cell) * 2
	// raioDeInteressePorItem é até onde ele considera trocar o destino da rota por um item.
	raioDeInteressePorItem = float64(protocol.Cell) * 4
	// raioDeItemImperdivel é a distância em que o item é pego mesmo em pleno duelo.
	raioDeItemImperdivel = float64(protocol.Cell) * 1.5
	// velocidadeMaximaDoAlvo grampeia a velocidade observada do inimigo.
	velocidadeMaximaDoAlvo = float64(protocol.TankSpeed) * 1.1
	// passoDaTorre é quanto a torre gira num tick.
	passoDaTorre = float64(protocol.TurretRate) / float64(protocol.TickHz)
	// limiarDeTorre é o piso da tolerância de disparo: sem ele um bot com erro de mira menor que a
	// resolução de giro nunca se considera "mirado". No TypeScript o divisor é o literal 60, e não
	// TICK_HZ — o valor coincide, a origem não.
	limiarDeTorre = float64(protocol.TurretRate) / 60
	// velocidadeDaBala2 é BULLET_SPEED², usado na equação da mira antecipada.
	velocidadeDaBala2 = float64(protocol.BulletSpeed) * float64(protocol.BulletSpeed)
	// limiarDeRecarga: acima disso o bot se considera recarregando e procura parede.
	limiarDeRecarga = float64(protocol.FireCooldown) * 0.55
	// idadeDeBalaNova é a idade máxima de uma bala para ela contar como "acabou de nascer".
	idadeDeBalaNova = 1.5 / float64(protocol.TickHz)
)

const (
	// margemDeAmeaca é a folga além do raio de acerto: reagir só ao que passaria raspando é reagir
	// tarde demais.
	margemDeAmeaca = 10
	// direcoesDeCobertura é quantas direções ele testa ao procurar parede.
	direcoesDeCobertura = 8
	// maximoDeRotas é o teto da tabela de rotas por labirinto — passou disso, esvazia e recomeça.
	maximoDeRotas = 4096
	// ticksEntreRecalculoDeRota: 6 recálculos de BFS por segundo bastam, o inimigo não troca de
	// célula mais rápido.
	ticksEntreRecalculoDeRota = 10
	// ticksEntrePlanosDeTiro é a espera mínima entre duas varreduras de ricochete.
	ticksEntrePlanosDeTiro = 20
	// ticksEntreBuscasDeCobertura é a espera mínima entre duas buscas de parede.
	ticksEntreBuscasDeCobertura = 12
	// ticksDeMemoriaDeAmeaca é por quanto tempo depois de uma bala passar raspando ele continua se
	// comportando como acuado.
	ticksDeMemoriaDeAmeaca = 45
	// angulosGrossos é a varredura grossa de ângulos: 24 passos de 15° acham a família certa.
	angulosGrossos = 24
	// amostrasDeRefino é o refino local em volta do melhor ângulo grosso.
	amostrasDeRefino = 8
	// amostrasPorFatia é o teto DURO de ângulos avaliados por tick. É ele que transforma o pico da
	// IA no custo de uma fatia, e não no de uma varredura inteira.
	amostrasPorFatia = 8
	// totalDeAmostras é a varredura completa: os grossos mais o refino.
	totalDeAmostras = angulosGrossos + amostrasDeRefino
)

// -------------------------------------------------------------------------------------------
// Memos compartilhados entre os bots da sala
// -------------------------------------------------------------------------------------------

// trechoDeTiro é um trecho reto da trajetória traçada por `tracarTiro`. `d0` é a distância já
// percorrida pela bala quando ela entra neste trecho.
type trechoDeTiro struct {
	x0, y0, x1, y1, d0 float64
}

// trechoDeVoo é um trecho reto do voo FUTURO de uma bala. `dx`/`dy` são unitários e `d0` é a
// distância já percorrida quando ela entra aqui.
type trechoDeVoo struct {
	x, y, dx, dy, comprimento, d0 float64
}

// vooPrevisto é a trajetória futura de uma bala mais o estado que a gerou — o "selo" do cache.
type vooPrevisto struct {
	maze         *Maze
	x, y, vx, vy float64
	bounces      int
	age          float64
	trechos      []trechoDeVoo
	n            int
}

// rotaMemo é a resposta memorizada do BFS para um par (célula de origem, célula de destino).
// `tem == false` significa "não há passo intermediário, vá direto no alvo".
type rotaMemo struct {
	passo Vec2
	tem   bool
}

// BotMemos guarda tudo o que no TypeScript são variáveis e WeakMaps de MÓDULO: o pool de trechos,
// a ameaça publicada pela última varredura, o voo previsto de cada bala e a tabela de rotas.
//
// Lá aquilo é global porque a simulação é síncrona e single-thread; aqui vira um objeto explícito,
// criado uma vez por partida e compartilhado pelos bots dela. Não é só higiene: a varredura de
// paridade roda milhares de partidas em goroutines paralelas, e estado de pacote seria
// compartilhado entre elas.
//
// Compartilhar entre os bots da MESMA sala não acopla ninguém a ninguém: o valor guardado é
// idêntico ao recalculado (voo de bala e passo de BFS são função pura da bala e do labirinto), e
// por isso quem consulta primeiro não muda o resultado de quem consulta depois.
type BotMemos struct {
	paredesDaBala map[*Maze][]Aabb
	vooPorBala    map[*Bullet]*vooPrevisto
	rotas         map[*Maze]map[int]rotaMemo

	trechos  []trechoDeTiro
	nTrechos int

	// A ameaça publicada por `ameacaMaisUrgente`: é dela que sai a direção de fuga.
	ameacaVx, ameacaVy, ameacaBx, ameacaBy float64

	slab slabScratch
}

// NovosBotMemos cria a memória compartilhada de uma partida.
func NovosBotMemos() *BotMemos {
	return &BotMemos{
		paredesDaBala: make(map[*Maze][]Aabb),
		vooPorBala:    make(map[*Bullet]*vooPrevisto),
		rotas:         make(map[*Maze]map[int]rotaMemo),
	}
}

// paredesParaBala é a mesma expansão que `stepTanks` e `stepBullets` usam, calculada uma vez por
// labirinto.
//
// O cache é PRÓPRIO do bot, e não o `expandWalls` da simulação, para copiar o TypeScript à risca:
// lá é um `WeakMap` sem invalidação, enquanto `expandWalls` invalida por tamanho. Enquanto o
// labirinto não perde parede os dois dão exatamente os mesmos retângulos; quando a morte súbita
// remove uma, os dois lados ficam desatualizados JUNTOS — que é o que preserva a paridade. Trocar
// por `expandWalls` "consertaria" o Go e criaria uma divergência real contra o navegador.
func (m *BotMemos) paredesParaBala(maze *Maze) []Aabb {
	if existentes, ok := m.paredesDaBala[maze]; ok {
		return existentes
	}
	infladas := make([]Aabb, len(maze.Walls))
	for i, parede := range maze.Walls {
		infladas[i] = Aabb{
			X: parede.X - protocol.BulletRadius,
			Y: parede.Y - protocol.BulletRadius,
			W: parede.W + protocol.BulletRadius*2,
			H: parede.H + protocol.BulletRadius*2,
		}
	}
	m.paredesDaBala[maze] = infladas
	return infladas
}

// -------------------------------------------------------------------------------------------
// Traçado de tiro — a mesma trajetória serve para mirar com ricochete E para não se matar
// -------------------------------------------------------------------------------------------

func (m *BotMemos) empurrarTrecho(x0, y0, x1, y1, d0 float64) {
	if m.nTrechos < len(m.trechos) {
		m.trechos[m.nTrechos] = trechoDeTiro{x0: x0, y0: y0, x1: x1, y1: y1, d0: d0}
	} else {
		m.trechos = append(m.trechos, trechoDeTiro{x0: x0, y0: y0, x1: x1, y1: y1, d0: d0})
	}
	m.nTrechos++
}

// tracarTiro percorre a trajetória de um tiro saído de (ox,oy) no ângulo dado, refletindo nas
// paredes até MaxBounces e parando no alcance da bala. O resultado fica no pool de trechos.
func (m *BotMemos) tracarTiro(ox, oy, angulo float64, maze *Maze) {
	m.nTrechos = 0
	x, y := ox, oy
	dx := jsmath.Cos(angulo)
	dy := jsmath.Sin(angulo)
	restante := alcanceBala
	percorrido := 0.0
	quicadas := 0
	paredes := m.paredesParaBala(maze)

	for restante > 1 && m.nTrechos <= protocol.MaxBounces+1 {
		de := Vec2{X: x, Y: y}
		para := Vec2{X: x + dx*restante, Y: y + dy*restante}
		hit, bateu := m.slab.RaycastSegment(de, para, paredes)
		if !bateu {
			m.empurrarTrecho(x, y, para.X, para.Y, percorrido)
			return
		}

		m.empurrarTrecho(x, y, hit.Point.X, hit.Point.Y, percorrido)
		percorrido += hit.Distance
		restante -= hit.Distance
		// O rebote de nº MaxBounces+1 mata a bala: daqui não sai mais trajetória.
		if quicadas >= protocol.MaxBounces {
			return
		}
		quicadas++

		// Reflexão em linha, sem passar por `Reflect()`: aqui dentro ela roda milhares de vezes por
		// segundo e o Vec2 de retorno virava lixo de coleta no lado JavaScript.
		projecao := dx*hit.Normal.X + dy*hit.Normal.Y
		dx -= 2 * projecao * hit.Normal.X
		dy -= 2 * projecao * hit.Normal.Y
		x = hit.Point.X + hit.Normal.X*0.05
		y = hit.Point.Y + hit.Normal.Y*0.05
	}
}

// distanciaAteATrajetoria é a menor distância entre o ponto e a trajetória traçada, considerando
// só o pedaço percorrido DEPOIS de `voarPeloMenos` px. É esse recorte que separa "a bala volta em
// cima de mim" de "a bala está saindo de dentro de mim agora".
func (m *BotMemos) distanciaAteATrajetoria(px, py, voarPeloMenos float64) float64 {
	melhor := jsmath.Inf()
	for i := 0; i < m.nTrechos; i++ {
		t := &m.trechos[i]
		dx := t.x1 - t.x0
		dy := t.y1 - t.y0
		comprimento := jsmath.Hypot(dx, dy)
		if comprimento < 1e-6 {
			continue
		}

		sMin := voarPeloMenos - t.d0
		if sMin > comprimento {
			continue
		}

		s := ((px-t.x0)*dx + (py-t.y0)*dy) / comprimento
		if s < sMin {
			s = sMin
		}
		if s < 0 {
			s = 0
		}
		if s > comprimento {
			s = comprimento
		}

		qx := t.x0 + (dx/comprimento)*s
		qy := t.y0 + (dy/comprimento)*s
		d := jsmath.Hypot(px-qx, py-qy)
		if d < melhor {
			melhor = d
		}
	}
	return melhor
}

// tracarTiroDoTanque traça desde o ponto onde a bala realmente nascerá. Quando o cano atravessa
// uma parede inflada, `stepTanks` recorta centro→boca e encosta a bala do lado interno.
func (m *BotMemos) tracarTiroDoTanque(tank *Tank, angulo float64, maze *Maze) {
	boca := Vec2{
		X: tank.X + jsmath.Cos(angulo)*offsetDaBoca,
		Y: tank.Y + jsmath.Sin(angulo)*offsetDaBoca,
	}
	centro := Vec2{X: tank.X, Y: tank.Y}
	bloqueio, bateu := m.slab.RaycastSegment(centro, boca, m.paredesParaBala(maze))
	x, y := boca.X, boca.Y
	if bateu {
		x = bloqueio.Point.X + bloqueio.Normal.X*1e-4
		y = bloqueio.Point.Y + bloqueio.Normal.Y*1e-4
	}
	m.tracarTiro(x, y, angulo, maze)
}

// erroDoTiro é a distância entre a trajetória de um tiro nesse ângulo e o alvo — quanto menor,
// melhor a mira.
func (m *BotMemos) erroDoTiro(tank *Tank, angulo float64, alvo Vec2, maze *Maze) float64 {
	m.tracarTiroDoTanque(tank, angulo, maze)
	return m.distanciaAteATrajetoria(alvo.X, alvo.Y, 0)
}

// autogolProvavel responde se o tiro que sair neste ângulo volta em cima de quem atirou. Olha só o
// trecho já letal, depois da janela de SelfImmunity.
func (m *BotMemos) autogolProvavel(tank *Tank, angulo float64, maze *Maze) bool {
	m.tracarTiroDoTanque(tank, angulo, maze)
	return m.distanciaAteATrajetoria(tank.X, tank.Y, vooAteFicarLetal) <= raioAcerto+3
}

// -------------------------------------------------------------------------------------------
// Trajetória prevista de cada bala — calculada UMA vez por bala por tick, não uma por bot
// -------------------------------------------------------------------------------------------

func (m *BotMemos) preverVoo(bala *Bullet, maze *Maze) *vooPrevisto {
	voo, existia := m.vooPorBala[bala]
	if existia &&
		voo.maze == maze &&
		voo.x == bala.X &&
		voo.y == bala.Y &&
		voo.vx == bala.VX &&
		voo.vy == bala.VY &&
		voo.bounces == bala.Bounces &&
		voo.age == bala.Age {
		return voo
	}
	if !existia {
		voo = &vooPrevisto{}
		m.vooPorBala[bala] = voo
	}
	voo.maze = maze
	voo.x = bala.X
	voo.y = bala.Y
	voo.vx = bala.VX
	voo.vy = bala.VY
	voo.bounces = bala.Bounces
	voo.age = bala.Age
	voo.n = 0

	velocidade := jsmath.Hypot(bala.VX, bala.VY)
	if velocidade < 1e-6 {
		return voo
	}

	dx := bala.VX / velocidade
	dy := bala.VY / velocidade
	x := bala.X
	y := bala.Y
	restante := jsmath.Max(0, protocol.BulletLife-bala.Age) * velocidade
	percorrido := 0.0
	quicadas := bala.Bounces
	paredes := m.paredesParaBala(maze)

	for restante > 1e-6 && voo.n <= protocol.MaxBounces+1 {
		de := Vec2{X: x, Y: y}
		para := Vec2{X: x + dx*restante, Y: y + dy*restante}
		hit, bateu := m.slab.RaycastSegment(de, para, paredes)
		comprimento := restante
		if bateu {
			comprimento = restante * hit.T
		}

		for len(voo.trechos) <= voo.n {
			voo.trechos = append(voo.trechos, trechoDeVoo{})
		}
		t := &voo.trechos[voo.n]
		t.x = x
		t.y = y
		t.dx = dx
		t.dy = dy
		t.comprimento = comprimento
		t.d0 = percorrido
		voo.n++

		if !bateu {
			return voo
		}
		percorrido += comprimento
		restante -= comprimento
		if quicadas >= protocol.MaxBounces {
			return voo
		}
		quicadas++

		projecao := dx*hit.Normal.X + dy*hit.Normal.Y
		dx -= 2 * projecao * hit.Normal.X
		dy -= 2 * projecao * hit.Normal.Y
		x = hit.Point.X + hit.Normal.X*0.05
		y = hit.Point.Y + hit.Normal.Y*0.05
	}
	return voo
}

// -------------------------------------------------------------------------------------------
// Desvio de bala
// -------------------------------------------------------------------------------------------

// ameacaMaisUrgente devolve em quantos segundos a bala mais urgente passa em cima deste tanque, e
// publica a velocidade dela em `ameacaVx/Vy` — é dela que sai a direção de fuga.
//
// O teste é o mesmo mínimo de distância relativa que a colisão bala×bala usa: em cada trecho a
// posição relativa anda em linha reta, então o instante de aproximação máxima sai da derivada.
func (m *BotMemos) ameacaMaisUrgente(
	tank *Tank,
	bullets []*Bullet,
	maze *Maze,
	preveRicochete bool,
	horizonteSegundos float64,
) (float64, bool) {
	limite := raioAcerto + margemDeAmeaca
	melhorT := jsmath.Inf()
	posTanque := Vec2{X: tank.X, Y: tank.Y}

	for _, bala := range bullets {
		velocidade := jsmath.Hypot(bala.VX, bala.VY)
		if velocidade < 1e-6 {
			continue
		}
		horizonte := jsmath.Min(protocol.BulletLife-bala.Age, horizonteSegundos)
		if horizonte <= 0 {
			continue
		}

		alcance := horizonte * velocidade
		voo := m.preverVoo(bala, maze)
		// Sem previsão de ricochete o bot só enxerga o trecho retilíneo em que a bala está agora.
		ateTrecho := voo.n
		if !preveRicochete && ateTrecho > 1 {
			ateTrecho = 1
		}
		// Distância que a bala ainda precisa voar para ficar letal para o próprio dono.
		letalA := jsmath.NegInf()
		if bala.OwnerID == tank.ID {
			letalA = (protocol.SelfImmunity - bala.Age) * velocidade
		}

		for i := 0; i < ateTrecho; i++ {
			t := &voo.trechos[i]
			if t.d0 >= alcance {
				break
			}
			comprimento := jsmath.Min(t.comprimento, alcance-t.d0)
			inicio := jsmath.Max(0, letalA-t.d0)
			if inicio > comprimento {
				continue
			}

			px := t.x - tank.X
			py := t.y - tank.Y
			s := -(px*t.dx + py*t.dy)
			if s < inicio {
				s = inicio
			} else if s > comprimento {
				s = comprimento
			}

			encontro := (t.d0 + s) / velocidade
			if encontro >= melhorT {
				continue
			}
			ex := px + t.dx*s
			ey := py + t.dy*s
			if jsmath.Hypot(ex, ey) > limite {
				continue
			}

			posBala := Vec2{X: t.x + t.dx*s, Y: t.y + t.dy*s}
			if !m.slab.HasLineOfSight(posBala, posTanque, maze.Walls) {
				continue
			}

			melhorT = encontro
			m.ameacaVx = t.dx * velocidade
			m.ameacaVy = t.dy * velocidade
			m.ameacaBx = t.x
			m.ameacaBy = t.y
		}
	}

	if melhorT == jsmath.Inf() {
		return 0, false
	}
	return melhorT, true
}

// cabeTanque responde se o ponto está livre de parede para um tanque INTEIRO, e não só para um
// raio de laser.
func cabeTanque(x, y float64, maze *Maze) bool {
	ajustado := CircleVsAabbSlide(Vec2{X: x, Y: y}, protocol.TankRadius, maze.Walls)
	return jsmath.Hypot(ajustado.X-x, ajustado.Y-y) < 1
}

// escolherFuga devolve para onde correr para sair da linha da bala: perpendicular à trajetória
// dela, para o lado em que o tanque JÁ está. Se a parede fecha esse lado, tenta o outro; se os
// dois estão fechados, não há desvio a fazer.
func (m *BotMemos) escolherFuga(tank *Tank, maze *Maze, desempate float64) (float64, bool) {
	anguloDaBala := jsmath.Atan2(m.ameacaVy, m.ameacaVx)
	// Sinal do produto vetorial entre a velocidade da bala e o vetor bala→tanque: diz de que lado
	// da trajetória o tanque está.
	cross := m.ameacaVx*(tank.Y-m.ameacaBy) - m.ameacaVy*(tank.X-m.ameacaBx)
	preferido := desempate
	if cross > 0 {
		preferido = 1
	} else if cross < 0 {
		preferido = -1
	}

	for _, lado := range [2]float64{preferido, -preferido} {
		angulo := normalizeAngle(anguloDaBala + (jsmath.Pi()/2)*lado)
		if cabeTanque(tank.X+jsmath.Cos(angulo)*passoDeFuga, tank.Y+jsmath.Sin(angulo)*passoDeFuga, maze) {
			return angulo, true
		}
	}
	return 0, false
}

// -------------------------------------------------------------------------------------------
// Cobertura
// -------------------------------------------------------------------------------------------

// procurarCobertura acha um ponto a uma célula daqui que quebre a linha de visão do inimigo. Entre
// os que servem, o mais próximo da direção em que o tanque já vai.
func (m *BotMemos) procurarCobertura(tank *Tank, alvo Vec2, maze *Maze) (float64, bool) {
	melhorAngulo := 0.0
	achou := false
	melhorGiro := jsmath.Inf()

	for i := 0; i < direcoesDeCobertura; i++ {
		angulo := float64(i) * jsmath.Pi() * 2 / float64(direcoesDeCobertura)
		ponto := Vec2{
			X: tank.X + jsmath.Cos(angulo)*passoDeCobertura,
			Y: tank.Y + jsmath.Sin(angulo)*passoDeCobertura,
		}
		if !cabeTanque(ponto.X, ponto.Y, maze) {
			continue
		}
		if m.slab.HasLineOfSight(ponto, alvo, maze.Walls) {
			continue
		}

		giro := jsmath.Abs(normalizeAngle(angulo - tank.Heading))
		if giro < melhorGiro {
			melhorGiro = giro
			melhorAngulo = angulo
			achou = true
		}
	}
	return melhorAngulo, achou
}

// -------------------------------------------------------------------------------------------
// Rota — o BFS do labirinto, memorizado por par de células
// -------------------------------------------------------------------------------------------

// celulaDe é o índice linear da célula que contém o ponto, com o mesmo grampeamento de `CellOf`.
func celulaDe(maze *Maze, x, y float64) int {
	cx := int(jsmath.Floor(x / maze.Cell))
	cy := int(jsmath.Floor(y / maze.Cell))
	if cx < 0 {
		cx = 0
	} else if cx > maze.Cols-1 {
		cx = maze.Cols - 1
	}
	if cy < 0 {
		cy = 0
	} else if cy > maze.Rows-1 {
		cy = maze.Rows - 1
	}
	return cy*maze.Cols + cx
}

// passoOuAlvo responde o que `NextStepTowards` devolveu: um passo intermediário de verdade, ou o
// PRÓPRIO alvo (o caso "não há caminho, vá direto nele").
//
// No TypeScript a resposta é uma comparação de IDENTIDADE (`passo === alvo`), que Go não tem —
// `NextStepTowards` devolve `Vec2` por valor. Comparar por valor NÃO serve: quando o alvo está no
// centro da célula vizinha (e todo power-up está, e todo spawn também), o passo legítimo é
// numericamente igual ao alvo, e o memo guardaria "não há caminho" onde o TypeScript guarda a
// rota. A divergência só apareceria ticks depois, quando aquela entrada do cache fosse reusada
// para outro alvo na mesma célula.
//
// A sonda resolve isso sem tocar em `NextStepTowards`: um SEGUNDO ponto dentro da mesma célula e
// diferente do primeiro. O BFS depende do alvo só pela célula dele, então um passo de verdade sai
// idêntico nas duas chamadas, enquanto o retorno "vá direto no alvo" sai diferente — porque é o
// próprio argumento de volta.
func passoOuAlvo(m *Maze, from, to Vec2) (Vec2, bool) {
	cx, cy := CellOf(m, to)
	sonda := Vec2{X: (float64(cx) + 0.25) * m.Cell, Y: (float64(cy) + 0.25) * m.Cell}
	if sonda == to {
		sonda = Vec2{X: (float64(cx) + 0.75) * m.Cell, Y: (float64(cy) + 0.75) * m.Cell}
	}

	a := NextStepTowards(m, from, to)
	b := NextStepTowards(m, from, sonda)
	if a == b {
		return a, true
	}
	return Vec2{}, false
}

// proximoPassoMemorizado é `NextStepTowards` memorizado. O BFS só depende do par (célula de
// origem, célula de destino), e numa sala de 10 bots quase todos perseguem alvos nas mesmas poucas
// células.
func (m *BotMemos) proximoPassoMemorizado(maze *Maze, tank *Tank, alvo Vec2) (Vec2, bool) {
	origem := celulaDe(maze, tank.X, tank.Y)
	destino := celulaDe(maze, alvo.X, alvo.Y)
	if origem == destino {
		return Vec2{}, false
	}

	tabela, ok := m.rotas[maze]
	if !ok {
		tabela = make(map[int]rotaMemo)
		m.rotas[maze] = tabela
	}
	chave := origem*maze.Cols*maze.Rows + destino
	if guardado, ok := tabela[chave]; ok {
		return guardado.passo, guardado.tem
	}

	passo, tem := passoOuAlvo(maze, Vec2{X: tank.X, Y: tank.Y}, alvo)
	if len(tabela) >= maximoDeRotas {
		clear(tabela)
	}
	tabela[chave] = rotaMemo{passo: passo, tem: tem}
	return passo, tem
}

// -------------------------------------------------------------------------------------------
// Combate avançado
// -------------------------------------------------------------------------------------------

// miraAntecipada resolve o encontro entre a bala e um alvo que mantém a velocidade observada no
// último tick. Se a projeção atravessaria parede ou sairia do alcance, conserva a mira atual.
func (m *BotMemos) miraAntecipada(tank *Tank, alvo Vec2, vx, vy float64, maze *Maze) float64 {
	rx := alvo.X - tank.X
	ry := alvo.Y - tank.Y
	a := vx*vx + vy*vy - velocidadeDaBala2
	b := 2 * (rx*vx + ry*vy)
	c := rx*rx + ry*ry
	discriminante := b*b - 4*a*c
	tempo := -1.0

	if discriminante >= 0 && jsmath.Abs(a) > 1e-6 {
		raiz := jsmath.Sqrt(discriminante)
		t1 := (-b - raiz) / (2 * a)
		t2 := (-b + raiz) / (2 * a)
		if t1 > 0 && t2 > 0 {
			tempo = jsmath.Min(t1, t2)
		} else if t1 > 0 {
			tempo = t1
		} else if t2 > 0 {
			tempo = t2
		}
	}

	if tempo <= 0 || tempo > protocol.BulletLife {
		return jsmath.Atan2(ry, rx)
	}

	previsto := Vec2{X: alvo.X + vx*tempo, Y: alvo.Y + vy*tempo}
	if !cabeTanque(previsto.X, previsto.Y, maze) ||
		!m.slab.HasLineOfSight(Vec2{X: tank.X, Y: tank.Y}, previsto, maze.Walls) {
		return jsmath.Atan2(ry, rx)
	}
	return jsmath.Atan2(previsto.Y-tank.Y, previsto.X-tank.X)
}

// -------------------------------------------------------------------------------------------
// Power-ups — o bot desvia para pegar
// -------------------------------------------------------------------------------------------

// itemMaisProximo devolve o item mais próximo dentro do raio. Só distância — o bot não pesa tipo,
// porque pesar exigiria um modelo de valor por efeito que a IA determinística não tem.
//
// Empate resolvido pelo primeiro da lista, que chega na ordem da agenda — determinística.
func itemMaisProximo(tank *Tank, itens []Vec2, raio float64) (Vec2, bool) {
	if len(itens) == 0 {
		return Vec2{}, false
	}
	var melhor Vec2
	achou := false
	melhorDist2 := raio * raio
	for _, item := range itens {
		dx := item.X - tank.X
		dy := item.Y - tank.Y
		dist2 := dx*dx + dy*dy
		if dist2 >= melhorDist2 {
			continue
		}
		melhorDist2 = dist2
		melhor = item
		achou = true
	}
	return melhor, achou
}

// -------------------------------------------------------------------------------------------
// Montagem do input
// -------------------------------------------------------------------------------------------

// anguloDoDisparoNesteTick é o ângulo que a torre terá DEPOIS do giro deste tick, imediatamente
// antes de `stepTanks` criar a bala. O freio de autogol precisa validar esse ângulo, e não
// `tank.Turret`, que ainda guarda a direção do tick anterior.
func anguloDoDisparoNesteTick(tank *Tank, aim float64, aimAtivo bool) float64 {
	if !aimAtivo {
		return tank.Turret
	}
	diff := normalizeAngle(aim - tank.Turret)
	if jsmath.Abs(diff) <= passoDaTorre {
		return normalizeAngle(aim)
	}
	return normalizeAngle(tank.Turret + jsmath.Sign(diff)*passoDaTorre)
}

// BotInput traduz a estratégia (ir até `moveTarget`, mirar em `anguloDeMira`) no `Input` que a
// simulação consome. Com o movimento absoluto a tradução entrega uma DIREÇÃO pronta.
func BotInput(tank *Tank, moveTarget Vec2, anguloDeMira float64, temTiro bool, ruido float64, config BotConfig) Input {
	mover := jsmath.Atan2(moveTarget.Y-tank.Y, moveTarget.X-tank.X)

	aim := normalizeAngle(anguloDeMira + (ruido*2-1)*config.AimErrorRad)
	// Tolerância de disparo proporcional à distância que a torre ainda cobre num tick.
	torreAlinhada := jsmath.Abs(normalizeAngle(aim-tank.Turret)) < jsmath.Max(config.TurnThreshold, limiarDeTorre)

	return Input{Mover: mover, MoverAtivo: true, Fire: temTiro && torreAlinhada, Aim: aim, AimAtivo: true}
}

// -------------------------------------------------------------------------------------------
// O bot
// -------------------------------------------------------------------------------------------

// Bot é a IA de um tanque. O estado interno guarda os caches de replanejamento, o movimento
// observado do alvo e os sinais do estilo do adversário. Tudo deriva de entradas determinísticas:
// dois processos com o mesmo `Rng`, labirinto e sequência de chamadas produzem exatamente os
// mesmos inputs.
//
// Os campos `tem*` são o `null` do TypeScript. Em Go o zero-value de `float64` é 0, que é um
// ângulo VÁLIDO — sem o par (valor, presente) um plano de tiro ausente viraria "mire para leste".
type Bot struct {
	memos  *BotMemos
	rng    *Rng
	config BotConfig

	waypoint        Vec2
	temWaypoint     bool
	waypointTick    int
	temWaypointTick bool
	// waypointEraItem: o waypoint em cache foi traçado até um item, e não até o inimigo.
	waypointEraItem bool

	planoDeTiro        float64
	temPlanoDeTiro     bool
	planoConcluidoTick int
	temPlanoConcluido  bool

	cobertura        float64
	temCobertura     bool
	coberturaTick    int
	temCoberturaTick bool

	tickDaUltimaAmeaca     int
	adversarioUsaRicochete bool
	losAnterior            bool
	temLosAnterior         bool

	// Reflexo: a última leitura do campo de balas e a fuga que ela produziu. Entre duas leituras o
	// bot age com esta decisão — é o `TicksDeReacao` da dificuldade.
	fugaMemorizada        float64
	temFugaMemorizada     bool
	tickDaLeituraDeAmeaca int
	temLeituraDeAmeaca    bool

	// Varredura de ricochete em curso: em que amostra ela está e qual o melhor ângulo até agora.
	varreduraAmostra      int
	varreduraMelhorAngulo float64
	varreduraMelhorErro   float64

	alvoAnteriorX      float64
	alvoAnteriorY      float64
	temAlvoAnterior    bool
	tickDoAlvoAnterior int

	// ladoDeFuga: num tiro perfeitamente centralizado não existe um lado geometricamente melhor
	// para fugir. Este desempate nasce do RNG semeado.
	ladoDeFuga float64
	// fase é o lugar deste bot no escalonamento: em que ticks do ciclo ele tem direito de COMEÇAR
	// uma varredura de ricochete. Sai do MESMO RNG semeado que o resto — dois bots da sala recebem
	// seeds diferentes e caem em ticks diferentes, e um bot recriado com a mesma seed cai sempre no
	// mesmo lugar. Nada de relógio, nada de ordem de chamada, nada de carga de CPU.
	fase int
}

// MakeBot cria um bot. A ordem em que `ladoDeFuga` e `fase` consomem o RNG faz parte do contrato:
// trocá-la desloca a sequência inteira de decisões.
func MakeBot(memos *BotMemos, rng *Rng, config BotConfig) *Bot {
	ladoDeFuga := 1.0
	if rng.Int(2) == 0 {
		ladoDeFuga = -1
	}
	fase := rng.Int(amostrasPorFatia)

	return &Bot{
		memos:               memos,
		rng:                 rng,
		config:              config,
		tickDaUltimaAmeaca:  -9999,
		varreduraAmostra:    -1,
		varreduraMelhorErro: jsmath.Inf(),
		ladoDeFuga:          ladoDeFuga,
		fase:                fase,
	}
}

// Think é um tick de decisão. `target` é o inimigo escolhido por quem chama (normalmente o mais
// próximo vivo); `tick` é o tick da simulação, usado para o escalonamento dos replanejamentos;
// `mundo` traz as balas em voo — sem ele o bot simplesmente não desvia de nada.
//
// O RNG é consumido UMA vez por decisão, sempre no mesmo ponto, para que a sequência não dependa
// do caminho tomado aqui dentro.
func (b *Bot) Think(tank *Tank, target Vec2, maze *Maze, tick int, mundo *BotMundo) Input {
	m := b.memos
	ruido := b.rng.Next()
	temLos := m.slab.HasLineOfSight(Vec2{X: tank.X, Y: tank.Y}, target, maze.Walls)

	alvoVx, alvoVy := 0.0, 0.0
	if b.temAlvoAnterior && tick > b.tickDoAlvoAnterior {
		segundos := float64(tick-b.tickDoAlvoAnterior) / float64(protocol.TickHz)
		alvoVx = (target.X - b.alvoAnteriorX) / segundos
		alvoVy = (target.Y - b.alvoAnteriorY) / segundos
		velocidade := jsmath.Hypot(alvoVx, alvoVy)
		if velocidade > velocidadeMaximaDoAlvo {
			escala := velocidadeMaximaDoAlvo / velocidade
			alvoVx *= escala
			alvoVy *= escala
		}
	}
	b.alvoAnteriorX = target.X
	b.alvoAnteriorY = target.Y
	b.tickDoAlvoAnterior = tick
	b.temAlvoAnterior = true

	if mundo != nil && !b.adversarioUsaRicochete && b.temLosAnterior && !b.losAnterior && !temLos {
		// Bala nascendo sem que ninguém esteja à vista de ninguém: o adversário está mirando por
		// ricochete. Quem percebe isso (só o difícil) passa a replanejar o próprio tiro mais rápido.
		for _, bala := range mundo.Bullets {
			if bala.OwnerID != tank.ID && bala.Age <= idadeDeBalaNova {
				b.adversarioUsaRicochete = true
			}
		}
	}
	b.losAnterior = temLos
	b.temLosAnterior = true

	// ---- 1. estou na mira de alguma bala? ----
	fuga, temFuga := 0.0, false
	if b.config.HorizonteDeAmeaca > 0 && mundo != nil {
		// O reflexo é a única parte que o difícil paga TODO tick: sair da linha é reação, não
		// planejamento, e amortizá-la seria enfraquecer o bot.
		if !b.temLeituraDeAmeaca || tick-b.tickDaLeituraDeAmeaca >= b.config.TicksDeReacao {
			b.tickDaLeituraDeAmeaca = tick
			b.temLeituraDeAmeaca = true
			b.temFugaMemorizada = false
			if len(mundo.Bullets) > 0 {
				_, ameacado := m.ameacaMaisUrgente(tank, mundo.Bullets, maze, b.config.UsaParede, b.config.HorizonteDeAmeaca)
				if ameacado {
					b.tickDaUltimaAmeaca = tick
					b.fugaMemorizada, b.temFugaMemorizada = m.escolherFuga(tank, maze, b.ladoDeFuga)
				}
			}
		}
		fuga, temFuga = b.fugaMemorizada, b.temFugaMemorizada
	}

	// ---- 2. para onde mirar ----
	anguloDeMira := jsmath.Atan2(target.Y-tank.Y, target.X-tank.X)
	if b.config.UsaParede && temLos {
		anguloDeMira = m.miraAntecipada(tank, target, alvoVx*0.8, alvoVy*0.8, maze)
	}
	temTiro := temLos

	if !temLos && b.config.Ricocheteia {
		intervaloDoPlano := ticksEntrePlanosDeTiro
		if b.config.UsaParede && b.adversarioUsaRicochete {
			intervaloDoPlano = 8
		}
		// A PRIMEIRA varredura depois de perder o inimigo de vista sai na hora. As REavaliações é
		// que respeitam a fase deste bot, e é isso que impede os 10 bots da sala de replanejar
		// todos no mesmo tick.
		if b.varreduraAmostra < 0 &&
			(!b.temPlanoConcluido ||
				(tick-b.planoConcluidoTick >= intervaloDoPlano && (tick+b.fase)%amostrasPorFatia == 0)) {
			b.varreduraAmostra = 0
			b.varreduraMelhorAngulo = 0
			b.varreduraMelhorErro = jsmath.Inf()
		}

		if b.varreduraAmostra >= 0 {
			passo := jsmath.Pi() * 2 / float64(angulosGrossos)
			fim := totalDeAmostras
			if b.varreduraAmostra+amostrasPorFatia < fim {
				fim = b.varreduraAmostra + amostrasPorFatia
			}
			// Terminou o grosso sem chegar perto: refinar não salvaria o tiro, desiste.
			desistiu := b.varreduraAmostra >= angulosGrossos && b.varreduraMelhorErro > erroQueValeRefinar

			for !desistiu && b.varreduraAmostra < fim {
				var angulo float64
				if b.varreduraAmostra < angulosGrossos {
					angulo = float64(b.varreduraAmostra) * passo
				} else if b.varreduraAmostra == angulosGrossos && b.varreduraMelhorErro > erroQueValeRefinar {
					desistiu = true
					break
				} else {
					// Amostras 24..31 viram k ∈ {-4,-3,-2,-1,1,2,3,4} passos finos ao redor do melhor.
					k := b.varreduraAmostra - angulosGrossos - amostrasDeRefino/2
					kf := float64(k)
					if k >= 0 {
						kf = float64(k + 1)
					}
					angulo = b.varreduraMelhorAngulo + kf*(passo/float64(amostrasDeRefino+1))
				}
				erro := m.erroDoTiro(tank, angulo, target, maze)
				if erro < b.varreduraMelhorErro {
					b.varreduraMelhorErro = erro
					b.varreduraMelhorAngulo = angulo
				}
				b.varreduraAmostra++
			}

			if desistiu || b.varreduraAmostra >= totalDeAmostras {
				serve := !desistiu &&
					b.varreduraMelhorErro <= raioAcerto &&
					!(b.config.EvitaAutogol && m.autogolProvavel(tank, b.varreduraMelhorAngulo, maze))
				if serve {
					b.planoDeTiro = normalizeAngle(b.varreduraMelhorAngulo)
					b.temPlanoDeTiro = true
				} else {
					b.planoDeTiro = 0
					b.temPlanoDeTiro = false
				}
				b.planoConcluidoTick = tick
				b.temPlanoConcluido = true
				b.varreduraAmostra = -1
			}
		}

		if b.temPlanoDeTiro {
			anguloDeMira = b.planoDeTiro
			temTiro = true
		}
	} else if temLos {
		b.planoDeTiro = 0
		b.temPlanoDeTiro = false
		b.planoConcluidoTick = 0
		b.temPlanoConcluido = false
		b.varreduraAmostra = -1
	}

	// ---- 3. para onde ir ----
	moveTarget := target
	// Direção pronta que ATROPELA `moveTarget`: fugir e se cobrir já são um ângulo, não um ponto a
	// perseguir.
	rumo, temRumo := 0.0, false

	if temFuga {
		rumo, temRumo = fuga, true
	} else if b.config.UsaParede && temLos &&
		(tick-b.tickDaUltimaAmeaca < ticksDeMemoriaDeAmeaca || tank.FireCooldownLeft > limiarDeRecarga) {
		if !b.temCoberturaTick || tick-b.coberturaTick >= ticksEntreBuscasDeCobertura {
			b.coberturaTick = tick
			b.temCoberturaTick = true
			b.cobertura, b.temCobertura = m.procurarCobertura(tank, target, maze)
		}
		if b.temCobertura {
			rumo, temRumo = b.cobertura, true
		}
	} else if !temLos {
		// Sem o inimigo à vista, um item dentro do raio de interesse VIRA o destino da rota. O
		// caminho continua saindo do mesmo BFS — o bot não corta parede para pegar power-up.
		item, temItem := itemMaisProximo(tank, powerupsDe(mundo), raioDeInteressePorItem)
		destino := target
		if temItem {
			destino = item
		}
		// Trocar de destino invalida o waypoint na hora: esperar os 10 ticks do escalonamento faria
		// o bot andar quase 1/6 de segundo na direção do alvo antigo depois de mudar de ideia.
		trocouDeDestino := temItem != b.waypointEraItem
		if !b.temWaypointTick || trocouDeDestino || tick-b.waypointTick >= ticksEntreRecalculoDeRota {
			b.waypoint, b.temWaypoint = m.proximoPassoMemorizado(maze, tank, destino)
			b.waypointTick = tick
			b.temWaypointTick = true
			b.waypointEraItem = temItem
		}
		moveTarget = destino
		if b.temWaypoint {
			moveTarget = b.waypoint
		}
	}

	// Item encostado: com um item a menos de 1,5 célula E sem parede no meio, ele atropela qualquer
	// destino escolhido acima — inclusive a perseguição com o inimigo à vista. O que NÃO atropela é
	// a fuga: sair da linha de uma bala continua valendo mais que qualquer power-up, senão o bot
	// morre indo buscar o item que ia salvá-lo.
	if !temFuga {
		encostado, temEncostado := itemMaisProximo(tank, powerupsDe(mundo), raioDeItemImperdivel)
		if temEncostado && m.slab.HasLineOfSight(Vec2{X: tank.X, Y: tank.Y}, encostado, maze.Walls) {
			moveTarget = encostado
			temRumo = false
		}
	}

	if b.config.UsaParede && b.adversarioUsaRicochete {
		anguloDeMira = normalizeAngle(anguloDeMira + (ruido*2-1)*0.001)
	}

	input := BotInput(tank, moveTarget, anguloDeMira, temTiro, ruido, b.config)

	// Fugir e se cobrir MANDAM no deslocamento; a torre continua com a mira montada acima, então o
	// bot atira de lado enquanto corre — que é exatamente o que um jogador humano faz.
	if temRumo {
		input.Mover = rumo
	}

	// ---- 4. freio de autogol ----
	if input.Fire && b.config.EvitaAutogol &&
		m.autogolProvavel(tank, anguloDoDisparoNesteTick(tank, input.Aim, input.AimAtivo), maze) {
		input.Fire = false
	}

	return input
}
