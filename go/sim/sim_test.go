package sim

import (
	"testing"

	"github.com/simplex/tank/go/protocol"
)

// Os testes aqui NÃO tentam reprovar a paridade com o TypeScript — quem faz isso é
// `go/compare.mjs`, comparando os dois lados de verdade. O que eles cobrem são as invariantes
// que valem sozinhas, e que quebrariam de um jeito silencioso: um `range` sobre mapa que
// escapou, um RNG que perdeu o determinismo, um labirinto sem saída.

// TestRngDeterministico fixa a saída do mulberry32 para sementes conhecidas. Se este teste
// falhar, TUDO abaixo dele diverge — labirinto, spawns, roteiro.
func TestRngDeterministico(t *testing.T) {
	r := Mulberry32(42)
	primeiros := make([]float64, 5)
	for i := range primeiros {
		primeiros[i] = r.Next()
	}

	// A mesma semente, sempre a mesma sequência.
	r2 := Mulberry32(42)
	for i, esperado := range primeiros {
		if got := r2.Next(); got != esperado {
			t.Fatalf("valor %d: %v, esperado %v", i, got, esperado)
		}
	}

	// Toda saída em [0, 1).
	r3 := Mulberry32(7)
	for i := 0; i < 100000; i++ {
		v := r3.Next()
		if v < 0 || v >= 1 {
			t.Fatalf("Next() = %v, fora de [0,1)", v)
		}
	}

	// Sementes diferentes divergem já no primeiro valor.
	if Mulberry32(1).Next() == Mulberry32(2).Next() {
		t.Error("sementes diferentes produziram o mesmo primeiro valor")
	}
}

func TestRngIntRespeitaOLimite(t *testing.T) {
	r := Mulberry32(99)
	for _, limite := range []int{1, 2, 7, 16, 1000} {
		for i := 0; i < 10000; i++ {
			v := r.Int(limite)
			if v < 0 || v >= limite {
				t.Fatalf("Int(%d) = %d", limite, v)
			}
		}
	}
}

func TestShuffleEUmaPermutacao(t *testing.T) {
	r := Mulberry32(5)
	original := make([]int, 50)
	for i := range original {
		original[i] = i
	}
	arr := append([]int(nil), original...)
	Shuffle(r, arr)

	visto := make(map[int]bool, len(arr))
	for _, v := range arr {
		if visto[v] {
			t.Fatalf("valor %d repetido após embaralhar", v)
		}
		visto[v] = true
	}
	if len(visto) != len(original) {
		t.Fatalf("embaralhar perdeu elementos: %d de %d", len(visto), len(original))
	}
}

// TestMazeDeterministicoEValido roda a mesma faixa de seeds que a varredura de paridade usa, mas
// olhando para o conteúdo: labirinto reproduzível, sem célula ilhada e com spawns suficientes.
func TestMazeDeterministicoEValido(t *testing.T) {
	for seed := uint32(0); seed < 200; seed++ {
		players := float64(2 + seed%9)
		aspect := []float64{16.0 / 9.0, 4.0 / 3.0, 21.0 / 9.0, 1.0, 3.2, 2.5}[seed%6]

		a := MakeMaze(seed, players, aspect)
		b := MakeMaze(seed, players, aspect)
		if len(a.Walls) != len(b.Walls) {
			t.Fatalf("seed %d: contagem de paredes instável", seed)
		}
		for i := range a.Walls {
			if a.Walls[i] != b.Walls[i] {
				t.Fatalf("seed %d: parede %d instável entre duas gerações", seed, i)
			}
		}

		if v := ValidateMaze(a); !v.OK {
			t.Fatalf("seed %d: labirinto inválido — %s", seed, v.Reason)
		}

		spawns := SpawnPoints(a, int(players), Mulberry32(seed^0x9e3779b9))
		if len(spawns) != int(players) {
			t.Fatalf("seed %d: %d spawns para %d jogadores", seed, len(spawns), int(players))
		}
		for i, p := range spawns {
			for j := i + 1; j < len(spawns); j++ {
				if p == spawns[j] {
					t.Fatalf("seed %d: spawns %d e %d na mesma célula", seed, i, j)
				}
			}
		}
	}
}

// TestMazeShapeRespeitaOsLimites confere o grampeamento de proporção e os pisos de forma — é
// aqui que `Math.round` do JavaScript e `math.Round` do Go se separariam.
func TestMazeShapeRespeitaOsLimites(t *testing.T) {
	for players := 2; players <= 10; players++ {
		for _, aspect := range []float64{0.1, 1.0, 16.0 / 9.0, 3.0, 100.0} {
			f := MazeShape(float64(players), aspect)
			if f.Rows < minRows || f.Cols < minCols {
				t.Errorf("players=%d aspect=%v: forma %dx%d abaixo do piso", players, aspect, f.Cols, f.Rows)
			}
			if f.Cols*f.Rows < players {
				t.Errorf("players=%d aspect=%v: %d células para %d jogadores", players, aspect, f.Cols*f.Rows, players)
			}
		}
	}
}

// TestBalaMorreNoSegundoToque fixa a regra de balística: com MaxBounces = 1, a bala sobrevive ao
// primeiro ricochete e morre no segundo, em silêncio.
func TestBalaMorreNoSegundoToque(t *testing.T) {
	maze := MakeMaze(1, 4, 16.0/9.0)
	// Arena sem tanque nenhum: a bala tem que morrer sozinha, pela regra de balística. Com um
	// tanque vivo em cena ela o mataria no primeiro tick e sairia da arena por outro caminho.
	state := NewSimState(maze, nil)

	// Uma bala solta no centro da primeira célula, apontada para a parede mais próxima.
	state.Bullets = append(state.Bullets, &Bullet{
		ID: "b0", OwnerID: "zzz", X: maze.Cell * 0.5, Y: maze.Cell * 0.5,
		VX: -protocol.BulletSpeed, VY: 0,
	})

	dt := 1.0 / protocol.TickHz
	rebotes, expirou := 0, ""
	for i := 0; i < 400 && expirou == ""; i++ {
		state.Tick = i
		for _, ev := range Step(state, nil, dt) {
			switch ev.Type {
			case EvBounce:
				rebotes++
			case EvBulletExpired:
				expirou = ev.Reason
			}
		}
	}

	if expirou == "" {
		t.Fatal("a bala nunca saiu de cena")
	}
	if expirou == "max_bounces" && rebotes != protocol.MaxBounces+1 {
		t.Errorf("morreu por rebote com %d ricochetes, esperado %d", rebotes, protocol.MaxBounces+1)
	}
	if len(state.Bullets) != 0 {
		t.Errorf("bala expirada continuou viva: %d na arena", len(state.Bullets))
	}
}

// TestImunidadeAoProprioTiro é a regra que faz o autogol existir: o dono é imune por
// SelfImmunity, e depois disso a própria bala o mata.
func TestImunidadeAoProprioTiro(t *testing.T) {
	maze := MakeMaze(3, 2, 16.0/9.0)
	tank := &Tank{ID: "t00", X: maze.Cell * 1.5, Y: maze.Cell * 1.5, Alive: true}
	state := NewSimState(maze, []*Tank{tank})
	dt := 1.0 / protocol.TickHz

	// Bala parada em cima do dono: sem imunidade, morreria no primeiro tick.
	state.Bullets = append(state.Bullets, &Bullet{ID: "b0", OwnerID: tank.ID, X: tank.X, Y: tank.Y})

	ticksAteMorrer := -1
	for i := 0; i < 60; i++ {
		state.Tick = i
		for _, ev := range Step(state, nil, dt) {
			if ev.Type == EvDeath && ticksAteMorrer < 0 {
				ticksAteMorrer = i
				if !ev.Autogol {
					t.Error("morte pela própria bala não foi marcada como autogol")
				}
			}
		}
	}

	if ticksAteMorrer < 0 {
		t.Fatal("o dono nunca foi atingido pela própria bala")
	}
	janela := float64(protocol.SelfImmunity) * float64(protocol.TickHz)
	esperado := int(janela) - 1
	if ticksAteMorrer < esperado {
		t.Errorf("morreu no tick %d, antes da janela de imunidade (~%d)", ticksAteMorrer, esperado)
	}
}

// TestOrdemDeTanquesEEstavel é a defesa contra o erro mais fácil deste porte: trocar o slice por
// um mapa. Com mapa, `range` embaralharia a ordem e o resultado mudaria a cada execução.
func TestOrdemDeTanquesEEstavel(t *testing.T) {
	maze := MakeMaze(11, 6, 16.0/9.0)
	rng := Mulberry32(11 ^ 0x9e3779b9)
	spawns := SpawnPoints(maze, 6, rng)

	rodar := func() []float64 {
		tanks := make([]*Tank, 6)
		for i := range tanks {
			tanks[i] = &Tank{ID: "t0" + string(rune('0'+i)), X: spawns[i].X, Y: spawns[i].Y, Alive: true}
		}
		state := NewSimState(maze, tanks)
		inputs := make(map[string]Input, 6)
		dt := 1.0 / protocol.TickHz
		for tick := 0; tick < 120; tick++ {
			state.Tick = tick
			for i, tk := range tanks {
				inputs[tk.ID] = Input{
					Mover: float64(i) * 0.7, MoverAtivo: true,
					Fire: tick%20 == i, Aim: float64(i), AimAtivo: true,
				}
			}
			Step(state, inputs, dt)
		}
		out := make([]float64, 0, 12)
		for _, tk := range state.Tanks {
			out = append(out, tk.X, tk.Y)
		}
		return out
	}

	primeira := rodar()
	for tentativa := 0; tentativa < 20; tentativa++ {
		outra := rodar()
		for i := range primeira {
			if primeira[i] != outra[i] {
				t.Fatalf("tentativa %d: posição %d mudou de %v para %v — há ordem indefinida na simulação",
					tentativa, i, primeira[i], outra[i])
			}
		}
	}
}
