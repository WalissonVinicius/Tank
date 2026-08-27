package powerups

import (
	"testing"

	"github.com/simplex/tank/go/internal/jsmath"
	"github.com/simplex/tank/go/protocol"
	"github.com/simplex/tank/go/sim"
)

// Espelho de `packages/shared-sim/test/powerups.test.ts`. Os casos que importam são os mesmos, na
// mesma ordem de importância: determinismo do nascimento, o carimbo na bala, arbitragem da coleta
// e o relógio dos efeitos.

const dt = 1.0 / protocol.TickHz

const espessura = 12.0

// arenaVazia é uma arena de cols×rows células só com as quatro paredes de borda.
func arenaVazia(cols, rows int) *sim.Maze {
	cell := 84.0
	w := float64(cols) * cell
	h := float64(rows) * cell
	half := espessura / 2
	return &sim.Maze{
		Cols: cols, Rows: rows, Cell: cell,
		Walls: []sim.Aabb{
			{X: -half, Y: -half, W: w + espessura, H: espessura},
			{X: -half, Y: h - half, W: w + espessura, H: espessura},
			{X: -half, Y: -half, W: espessura, H: h + espessura},
			{X: w - half, Y: -half, W: espessura, H: h + espessura},
		},
	}
}

func tanque(id string, x, y float64) *sim.Tank {
	return &sim.Tank{ID: id, X: x, Y: y, Alive: true}
}

func TestAgendaEDeterministica(t *testing.T) {
	maze := sim.MakeMaze(4242, 6, protocol.MazeAspectDefault)
	a := Agenda(maze, 4242)
	b := Agenda(maze, 4242)
	if len(a) == 0 {
		t.Fatal("agenda vazia")
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("item %d difere entre duas execuções: %+v vs %+v", i, a[i], b[i])
		}
	}
}

func TestAgendaCaiNoCentroDeCelulaEDentroDosLimites(t *testing.T) {
	maze := sim.MakeMaze(77, 8, protocol.MazeAspectDefault)
	for _, item := range Agenda(maze, 77) {
		fx := jsmath.Mod(item.X/maze.Cell-0.5, 1)
		fy := jsmath.Mod(item.Y/maze.Cell-0.5, 1)
		if jsmath.Abs(fx) > 1e-9 || jsmath.Abs(fy) > 1e-9 {
			t.Fatalf("item %d fora do centro de célula: (%v, %v)", item.Id, item.X, item.Y)
		}
		if item.X <= 0 || item.Y <= 0 ||
			item.X >= float64(maze.Cols)*maze.Cell || item.Y >= float64(maze.Rows)*maze.Cell {
			t.Fatalf("item %d fora do labirinto: (%v, %v)", item.Id, item.X, item.Y)
		}
	}
}

// Os ticks de nascimento têm que ser crescentes: `NoChao` encerra a varredura no primeiro item que
// ainda não nasceu, e um fora de ordem sumiria da lista sem explicação.
func TestTicksDeNascimentoSaoCrescentes(t *testing.T) {
	maze := sim.MakeMaze(9, 4, protocol.MazeAspectDefault)
	agenda := Agenda(maze, 9)
	for i := 1; i < len(agenda); i++ {
		if agenda[i].NasceEmTick <= agenda[i-1].NasceEmTick {
			t.Fatalf("item %d nasce em %d, não depois de %d", i, agenda[i].NasceEmTick, agenda[i-1].NasceEmTick)
		}
	}
}

func TestSeedsDiferentesDaoRodadasDiferentes(t *testing.T) {
	maze := sim.MakeMaze(1, 6, protocol.MazeAspectDefault)
	a := Agenda(maze, 1)
	b := Agenda(maze, 2)
	igual := true
	for i := range a {
		if a[i] != b[i] {
			igual = false
			break
		}
	}
	if igual {
		t.Fatal("seeds diferentes produziram a mesma agenda")
	}
}

func TestItemEntraESaiDoChaoNosTicksDaAgenda(t *testing.T) {
	maze := arenaVazia(6, 6)
	campo := NovoCampo(maze, 5)
	primeiro := campo.AgendaDaRodada()[0]

	if len(campo.NoChao(primeiro.NasceEmTick-1)) != 0 {
		t.Fatal("item no chão antes de nascer")
	}
	if !contem(campo.NoChao(primeiro.NasceEmTick), primeiro.Id) {
		t.Fatal("item ausente no tick em que nasce")
	}
	if !contem(campo.NoChao(primeiro.SumeEmTick-1), primeiro.Id) {
		t.Fatal("item ausente um tick antes de sumir")
	}
	if contem(campo.NoChao(primeiro.SumeEmTick), primeiro.Id) {
		t.Fatal("item ainda no chão no tick em que some")
	}
}

// A queda de paraquedas é ANTECIPAÇÃO, não atraso: o item aparece no ar antes e pousa no mesmo
// tick de sempre. Se ela virasse atraso, a disponibilidade mudaria e a agenda toda se deslocaria.
func TestQuedaNaoMudaADisponibilidade(t *testing.T) {
	maze := arenaVazia(6, 6)
	campo := NovoCampo(maze, 21)
	primeiro := campo.AgendaDaRodada()[0]

	if !contem(campo.Caindo(primeiro.NasceEmTick-1), primeiro.Id) {
		t.Fatal("item não estava no ar um tick antes de pousar")
	}
	if contem(campo.Caindo(primeiro.NasceEmTick), primeiro.Id) {
		t.Fatal("item continuou no ar no tick do pouso")
	}
	if !contem(campo.NoChao(primeiro.NasceEmTick), primeiro.Id) {
		t.Fatal("item não entrou no chão no tick do pouso")
	}
}

func contem(itens []Item, id int) bool {
	for _, item := range itens {
		if item.Id == id {
			return true
		}
	}
	return false
}

func TestEncostarNoItemEntregaOItemUmaVezSo(t *testing.T) {
	maze := arenaVazia(6, 6)
	campo := NovoCampo(maze, 11)
	item := campo.AgendaDaRodada()[0]
	state := sim.NewSimState(maze, []*sim.Tank{tanque("p1", item.X, item.Y)})

	coletas := campo.Coletar(state, item.NasceEmTick)
	if len(coletas) != 1 || coletas[0].TankId != "p1" || coletas[0].ItemId != item.Id {
		t.Fatalf("coleta inesperada: %+v", coletas)
	}
	if len(campo.Coletar(state, item.NasceEmTick)) != 0 {
		t.Fatal("o mesmo item foi coletado duas vezes")
	}
	if contem(campo.NoChao(item.NasceEmTick), item.Id) {
		t.Fatal("item coletado continuou no chão")
	}
}

func TestDoisTanquesNoMesmoItemLevaOMaisPerto(t *testing.T) {
	maze := arenaVazia(6, 6)
	campo := NovoCampo(maze, 12)
	item := campo.AgendaDaRodada()[0]
	// `p9` entra depois de `p1` na ordem, mas está mais perto — distância manda.
	state := sim.NewSimState(maze, []*sim.Tank{
		tanque("p1", item.X+20, item.Y),
		tanque("p9", item.X+4, item.Y),
	})

	coletas := campo.Coletar(state, item.NasceEmTick)
	if len(coletas) != 1 || coletas[0].TankId != "p9" {
		t.Fatalf("esperava p9, veio %+v", coletas)
	}
}

// Empate exato de distância tem que sair pelo id, e não pela ordem de inserção: o servidor e o
// cliente montam a lista de tanques em ordens diferentes.
func TestEmpateExatoSaiPeloId(t *testing.T) {
	maze := arenaVazia(6, 6)
	item := NovoCampo(maze, 13).AgendaDaRodada()[0]

	a := NovoCampo(maze, 13).Coletar(sim.NewSimState(maze, []*sim.Tank{
		tanque("pa", item.X-10, item.Y), tanque("pb", item.X+10, item.Y),
	}), item.NasceEmTick)
	b := NovoCampo(maze, 13).Coletar(sim.NewSimState(maze, []*sim.Tank{
		tanque("pb", item.X+10, item.Y), tanque("pa", item.X-10, item.Y),
	}), item.NasceEmTick)

	if len(a) != 1 || len(b) != 1 || a[0].TankId != b[0].TankId {
		t.Fatalf("ordem de inserção mudou o vencedor: %+v vs %+v", a, b)
	}
}

func TestTanqueMortoNaoPegaItem(t *testing.T) {
	maze := arenaVazia(6, 6)
	campo := NovoCampo(maze, 14)
	item := campo.AgendaDaRodada()[0]
	morto := tanque("p1", item.X, item.Y)
	morto.Alive = false

	if len(campo.Coletar(sim.NewSimState(maze, []*sim.Tank{morto}), item.NasceEmTick)) != 0 {
		t.Fatal("tanque morto pegou item")
	}
}

func TestPegarDeNovoRenovaEmVezDeEmpilhar(t *testing.T) {
	maze := arenaVazia(6, 6)
	tank := tanque("p1", 100, 100)
	state := sim.NewSimState(maze, []*sim.Tank{tank})
	efeitos := NovosEfeitos()

	efeitos.Aplicar(tank, "ricochete")
	efeitos.Passo(state, protocol.PowerupDuracao["ricochete"]-1)
	efeitos.Aplicar(tank, "ricochete")

	if tank.Ricochete != 1 {
		t.Fatalf("ricochete empilhou: %d", tank.Ricochete)
	}
	ativos := efeitos.Ativos("p1")
	if len(ativos) != 1 {
		t.Fatalf("esperava 1 efeito ativo, veio %d", len(ativos))
	}
	if jsmath.Abs(ativos[0].Restante-protocol.PowerupDuracao["ricochete"]) > 1e-9 {
		t.Fatalf("relógio não foi renovado: %v", ativos[0].Restante)
	}
}

func TestMorrerEncerraTodosOsEfeitos(t *testing.T) {
	maze := arenaVazia(6, 6)
	tank := tanque("p1", 100, 100)
	state := sim.NewSimState(maze, []*sim.Tank{tank})
	efeitos := NovosEfeitos()
	efeitos.Aplicar(tank, "turbo")
	efeitos.Aplicar(tank, "ricochete")

	tank.Alive = false
	fins := efeitos.Passo(state, dt)

	if len(fins) != 2 {
		t.Fatalf("esperava 2 fins, veio %d", len(fins))
	}
	if tank.Turbo != 0 || tank.Ricochete != 0 {
		t.Fatalf("campos não foram apagados: turbo=%v ricochete=%d", tank.Turbo, tank.Ricochete)
	}
	if len(efeitos.Ativos("p1")) != 0 {
		t.Fatal("sobrou efeito ativo depois da morte")
	}
}

// A ARMADILHA. O efeito expira no dono com a bala ainda no ar; a bala tem que continuar com o
// teto de rebotes dela. Ler o número do atirador na hora de simular faria a bala trocar de regra
// no meio do voo, e trocaria em instantes diferentes em cada tela.
func TestEfeitoExpirarNaoTiraORicocheteDaBalaEmVoo(t *testing.T) {
	maze := caixa(120)
	atirador := tanque("p1", 60, 60)
	state := sim.NewSimState(maze, []*sim.Tank{atirador})
	efeitos := NovosEfeitos()
	efeitos.Aplicar(atirador, "ricochete")

	eventos := sim.Step(state, map[string]sim.Input{"p1": {Fire: true}}, dt)
	state.Tick++
	if len(eventos) == 0 || eventos[0].Type != sim.EvShot {
		t.Fatalf("o tiro não saiu: %+v", eventos)
	}
	bala := state.Bullets[0]
	if bala.Ricochete != 1 {
		t.Fatalf("bala nasceu sem carimbo: %d", bala.Ricochete)
	}

	efeitos.Passo(state, protocol.PowerupDuracao["ricochete"]+dt)
	if atirador.Ricochete != 0 {
		t.Fatal("o efeito não expirou no dono")
	}
	if bala.Ricochete != 1 {
		t.Fatal("o carimbo da bala foi apagado junto com o efeito do dono")
	}

	// E a bala continua com o teto dela: tira o atirador de cena e conta os rebotes até o fim.
	semTanques := sim.NewSimState(maze, nil)
	semTanques.Bullets = state.Bullets
	rebotes := 0
	for i := 0; i < 60*3 && len(semTanques.Bullets) > 0; i++ {
		for _, ev := range sim.Step(semTanques, nil, dt) {
			if ev.Type == sim.EvBounce {
				rebotes++
			}
		}
		semTanques.Tick++
	}
	if rebotes != protocol.MaxBounces+1+1 {
		t.Fatalf("esperava %d rebotes, contei %d", protocol.MaxBounces+2, rebotes)
	}
}

// caixa é uma arena fechada pequena, para a bala completar os rebotes bem dentro de BulletLife.
func caixa(lado float64) *sim.Maze {
	half := espessura / 2
	return &sim.Maze{
		Cols: 1, Rows: 1, Cell: lado,
		Walls: []sim.Aabb{
			{X: -half, Y: -half, W: lado + espessura, H: espessura},
			{X: -half, Y: lado - half, W: lado + espessura, H: espessura},
			{X: -half, Y: -half, W: espessura, H: lado + espessura},
			{X: lado - half, Y: -half, W: espessura, H: lado + espessura},
		},
	}
}

// A ordem de iteração dos efeitos NÃO pode vir de um mapa: `range` sobre mapa em Go embaralha de
// propósito, e a sequência dos eventos de fim de efeito mudaria a cada execução.
func TestOrdemDosFinsDeEfeitoEEstavel(t *testing.T) {
	referencia := ""
	for rodada := 0; rodada < 20; rodada++ {
		maze := arenaVazia(6, 6)
		tanks := []*sim.Tank{tanque("t02", 100, 100), tanque("t00", 200, 100), tanque("t01", 300, 100)}
		state := sim.NewSimState(maze, tanks)
		efeitos := NovosEfeitos()
		for _, tank := range tanks {
			for _, tipo := range protocol.TiposDePowerUp {
				efeitos.Aplicar(tank, tipo)
			}
		}

		texto := ""
		for i := 0; i < 13*protocol.TickHz; i++ {
			for _, fim := range efeitos.Passo(state, dt) {
				texto += fim.TankId + ":" + fim.Tipo + ","
			}
		}
		if rodada == 0 {
			referencia = texto
			if texto == "" {
				t.Fatal("nenhum efeito expirou — o teste não testa nada")
			}
			continue
		}
		if texto != referencia {
			t.Fatalf("rodada %d produziu outra ordem:\n%s\n%s", rodada, referencia, texto)
		}
	}
}
