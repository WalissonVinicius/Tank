package sim

import (
	"fmt"
	"strconv"
	"strings"
	"testing"

	"github.com/simplex/tank/go/internal/jsmath"
	"github.com/simplex/tank/go/protocol"
)

// Testes do porte de `bot.ts`. Eles NÃO substituem a prova de paridade — quem responde "o Go faz o
// mesmo que o TypeScript" é `node compare.mjs`, bit a bit, em 10.000 seeds. O que está aqui é a
// rede de segurança local: determinismo, o escalonamento saindo do RNG e não do relógio, e as
// duas decisões que dão caráter ao bot (não se matar e desviar para pegar item).

const espessuraDeTeste = 12.0

func arenaDeTeste(cols, rows int) *Maze {
	cell := 84.0
	w := float64(cols) * cell
	h := float64(rows) * cell
	half := espessuraDeTeste / 2
	return &Maze{
		Cols: cols, Rows: rows, Cell: cell,
		Walls: []Aabb{
			{X: -half, Y: -half, W: w + espessuraDeTeste, H: espessuraDeTeste},
			{X: -half, Y: h - half, W: w + espessuraDeTeste, H: espessuraDeTeste},
			{X: -half, Y: -half, W: espessuraDeTeste, H: h + espessuraDeTeste},
			{X: w - half, Y: -half, W: espessuraDeTeste, H: h + espessuraDeTeste},
		},
	}
}

func tanqueDeTeste(id string, x, y float64) *Tank {
	return &Tank{ID: id, X: x, Y: y, Alive: true}
}

// sequenciaDeInputs roda N ticks de decisão e devolve os inputs como texto, em bits.
func sequenciaDeInputs(semente uint32, config BotConfig, ticks int, mundo *BotMundo) string {
	maze := arenaDeTeste(8, 8)
	bot := MakeBot(NovosBotMemos(), Mulberry32(semente), config)
	tank := tanqueDeTeste("b1", 200, 200)
	alvo := Vec2{X: 620, Y: 200}

	var sb strings.Builder
	for tick := 0; tick < ticks; tick++ {
		in := bot.Think(tank, alvo, maze, tick, mundo)
		// Hexadecimal de ponto flutuante: exato, sem casa decimal escondendo o último bit.
		fmt.Fprintf(&sb, "%s|%t|%s\n",
			strconv.FormatFloat(in.Mover, 'x', -1, 64), in.Fire, strconv.FormatFloat(in.Aim, 'x', -1, 64))
	}
	return sb.String()
}

// Dois bots com a mesma semente têm que produzir exatamente a mesma sequência de comandos. É o
// contrato inteiro: se isto quebrar, servidor e cliente veem partidas diferentes.
func TestMesmaSementeMesmaSequenciaDeInputs(t *testing.T) {
	for _, nivel := range NiveisDeBot {
		config := BotDificuldade[nivel]
		a := sequenciaDeInputs(4242, config, 120, &BotMundo{})
		b := sequenciaDeInputs(4242, config, 120, &BotMundo{})
		if a != b {
			t.Fatalf("nível %s não é determinístico", nivel)
		}
		if len(a) == 0 {
			t.Fatalf("nível %s não produziu input nenhum", nivel)
		}
	}
}

// Sementes diferentes têm que dar bots diferentes — é delas que saem o erro de mira, o lado de
// fuga e a FASE do escalonamento, que é o que impede os dez bots da sala de replanejar no mesmo
// tick.
func TestSementesDiferentesDaoBotsDiferentes(t *testing.T) {
	config := BotDificuldade["medio"]
	if sequenciaDeInputs(1, config, 120, &BotMundo{}) == sequenciaDeInputs(2, config, 120, &BotMundo{}) {
		t.Fatal("duas sementes diferentes produziram a mesma sequência")
	}
}

// A memória compartilhada entre os bots da sala guarda VALOR IDÊNTICO ao recalculado (voo previsto
// e passo de BFS são função pura da bala e do labirinto). Duas salas intercaladas no mesmo
// processo não podem interferir uma na outra.
func TestMemoriaCompartilhadaNaoAcoplaSalas(t *testing.T) {
	config := BotDificuldade["dificil"]
	sozinho := sequenciaDeInputs(7, config, 90, &BotMundo{})

	maze := arenaDeTeste(8, 8)
	memos := NovosBotMemos()
	a := MakeBot(memos, Mulberry32(7), config)
	b := MakeBot(memos, Mulberry32(99), config)
	tankA := tanqueDeTeste("b1", 200, 200)
	tankB := tanqueDeTeste("b2", 300, 500)
	alvo := Vec2{X: 620, Y: 200}

	var sb strings.Builder
	for tick := 0; tick < 90; tick++ {
		// O bot 99 consulta os mesmos memos ANTES do bot 7 em todo tick.
		b.Think(tankB, Vec2{X: 100, Y: 100}, maze, tick, &BotMundo{})
		in := a.Think(tankA, alvo, maze, tick, &BotMundo{})
		// Hexadecimal de ponto flutuante: exato, sem casa decimal escondendo o último bit.
		fmt.Fprintf(&sb, "%s|%t|%s\n",
			strconv.FormatFloat(in.Mover, 'x', -1, 64), in.Fire, strconv.FormatFloat(in.Aim, 'x', -1, 64))
	}
	if sb.String() != sozinho {
		t.Fatal("a presença de outro bot na mesma memória mudou as decisões do primeiro")
	}
}

// O bot difícil simula o próprio tiro antes de puxar o gatilho. Encostado numa parede e mirando
// nela, o tiro volta em cima dele — e ele tem que engolir o gatilho.
func TestDificilEngoleOGatilhoQuandoOTiroVoltaNaCara(t *testing.T) {
	// Corredor curtíssimo: a bala sai, bate na parede da frente e volta pelo mesmo caminho.
	maze := arenaDeTeste(1, 1)
	tank := tanqueDeTeste("b1", 42, 42)
	tank.Turret = 0

	memos := NovosBotMemos()
	if !memos.autogolProvavel(tank, 0, maze) {
		t.Fatal("mirar na parede a meio corredor não foi reconhecido como autogol")
	}

	// E o mesmo ângulo numa arena grande, com espaço de sobra, não é autogol.
	grande := arenaDeTeste(8, 8)
	longe := tanqueDeTeste("b1", 100, 300)
	if memos.autogolProvavel(longe, 0, grande) {
		t.Fatal("tiro com corredor livre pela frente foi acusado de autogol")
	}
}

// Com um item ao alcance e o inimigo do lado oposto, o bot DESVIA para pegá-lo. É a diferença
// entre um bot que parece atento e um que passa reto por um ricochete duplo encostado nele.
func TestBotDesviaParaPegarItem(t *testing.T) {
	rumoMedio := func(comItem bool) float64 {
		maze := arenaDeTeste(8, 8)
		bot := MakeBot(NovosBotMemos(), Mulberry32(4242), BotDificuldade["medio"])
		tank := tanqueDeTeste("b1", 200, 200)
		alvo := Vec2{X: 620, Y: 200} // inimigo bem à direita
		var itens []Vec2
		if comItem {
			itens = []Vec2{{X: 90, Y: 200}} // item na direção OPOSTA
		}

		soma := 0.0
		for tick := 0; tick < 30; tick++ {
			in := bot.Think(tank, alvo, maze, tick, &BotMundo{Powerups: itens})
			soma += jsmath.Cos(in.Mover)
		}
		return soma / 30
	}

	if rumoMedio(false) < 0.5 {
		t.Fatal("sem item, o bot deveria ir na direção do inimigo")
	}
	if rumoMedio(true) > -0.5 {
		t.Fatal("com item ao alcance do lado oposto, o bot deveria desviar para pegá-lo")
	}
}

// Sem `powerups` no mundo, o comportamento tem que ser exatamente o de antes de os itens
// existirem — um campo ausente e um campo vazio são a mesma coisa.
func TestCampoDeItensVazioNaoMudaNada(t *testing.T) {
	semCampo := sequenciaDeInputs(4242, BotDificuldade["medio"], 30, &BotMundo{})
	comCampoVazio := sequenciaDeInputs(4242, BotDificuldade["medio"], 30, &BotMundo{Powerups: []Vec2{}})
	if semCampo != comCampoVazio {
		t.Fatal("campo de itens vazio mudou a decisão")
	}
}

// `passoOuAlvo` é a tradução da comparação de IDENTIDADE do TypeScript (`passo === alvo`). O caso
// que a comparação por valor erraria é justamente o mais comum: alvo no centro da célula vizinha.
func TestPassoOuAlvoDistingueRotaDeAlvoNoCentroDaCelula(t *testing.T) {
	maze := arenaDeTeste(8, 8)
	origem := CellCenter(maze, 0, 0)
	destinoLonge := CellCenter(maze, 5, 5)

	passo, tem := passoOuAlvo(maze, origem, destinoLonge)
	if !tem {
		t.Fatal("numa arena aberta tem que haver passo intermediário até uma célula distante")
	}
	if passo == destinoLonge {
		t.Fatal("o passo até uma célula a 5 de distância não pode ser o próprio destino")
	}

	// Alvo na MESMA célula: não há passo, e o TypeScript devolve o próprio alvo.
	if _, tem := passoOuAlvo(maze, origem, Vec2{X: origem.X + 1, Y: origem.Y + 1}); tem {
		t.Fatal("alvo na mesma célula não deveria produzir passo")
	}

	// E o caso que a comparação por valor erraria: destino no CENTRO da célula vizinha, que é onde
	// todo power-up e todo spawn nascem. O passo legítimo é numericamente igual ao alvo.
	vizinha := CellCenter(maze, 1, 0)
	passo, tem = passoOuAlvo(maze, origem, vizinha)
	if !tem || passo != vizinha {
		t.Fatalf("esperava o passo até a célula vizinha (%v), veio (%v, tem=%t)", vizinha, passo, tem)
	}
}

// O escalonamento tem que sair do RNG semeado e do NÚMERO DO TICK — nunca de relógio ou de carga.
// Rodar a mesma partida 20 vezes seguidas, com trabalho diferente entre elas, não pode mudar nada.
func TestEscalonamentoNaoDependeDeRelogio(t *testing.T) {
	referencia := ""
	for rodada := 0; rodada < 20; rodada++ {
		// Trabalho descartado no meio, só para mexer no relógio e no coletor de lixo.
		lixo := NovosBotMemos()
		for i := 0; i < rodada*50; i++ {
			lixo.tracarTiro(float64(i), float64(i), float64(i)*0.01, arenaDeTeste(4, 4))
		}
		texto := sequenciaDeInputs(31337, BotDificuldade["dificil"], 150, &BotMundo{})
		if rodada == 0 {
			referencia = texto
			continue
		}
		if texto != referencia {
			t.Fatalf("rodada %d produziu outra sequência", rodada)
		}
	}
}

// O bot não pode consumir o RNG de forma dependente do caminho tomado dentro do `Think`: é UMA
// tirada por decisão, sempre. Se isso quebrar, as duas pontas se descolam em silêncio.
func TestConsomeUmNumeroDoRngPorDecisao(t *testing.T) {
	maze := arenaDeTeste(8, 8)
	rng := Mulberry32(2026)
	bot := MakeBot(NovosBotMemos(), rng, BotDificuldade["dificil"])
	// `MakeBot` já consumiu dois: o lado de fuga e a fase.
	referencia := Mulberry32(2026)
	referencia.Next()
	referencia.Next()

	tank := tanqueDeTeste("b1", 200, 200)
	for tick := 0; tick < 60; tick++ {
		bot.Think(tank, Vec2{X: 620, Y: 200}, maze, tick, &BotMundo{})
		referencia.Next()
		if rng.State() != referencia.State() {
			t.Fatalf("no tick %d o bot consumiu uma quantidade de RNG diferente de 1", tick)
		}
	}
}

// Só para garantir que o teto de rebotes que a IA usa ao traçar o tiro é o mesmo da simulação.
func TestTracadoDeTiroRespeitaOTetoDeRebotes(t *testing.T) {
	memos := NovosBotMemos()
	memos.tracarTiro(42, 42, 0.7, arenaDeTeste(1, 1))
	if memos.nTrechos == 0 {
		t.Fatal("o traçado não produziu trecho nenhum")
	}
	if memos.nTrechos > protocol.MaxBounces+2 {
		t.Fatalf("o traçado passou do teto: %d trechos", memos.nTrechos)
	}
}
