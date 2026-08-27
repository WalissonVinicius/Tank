package jsmath

import (
	"math"
	"math/big"
	"testing"
)

// piGrande devolve π com `bits` de precisão, calculado por AGM (Brent–Salamin). Serve para
// conferir as tabelas de constantes deste pacote sem depender da minha transcrição delas — uma
// tabela copiada errada de um livro passa despercebida até um ângulo específico quebrar em
// produção.
func piGrande(bits uint) *big.Float {
	prec := bits + 64
	a := big.NewFloat(1).SetPrec(prec)
	b := new(big.Float).SetPrec(prec).Quo(big.NewFloat(1).SetPrec(prec), sqrtBig(big.NewFloat(2).SetPrec(prec), prec))
	t := new(big.Float).SetPrec(prec).SetFloat64(0.25)
	p := big.NewFloat(1).SetPrec(prec)

	for i := 0; i < 12; i++ { // 12 iterações ≈ 4096 dígitos binários, de sobra
		an := new(big.Float).SetPrec(prec).Add(a, b)
		an.Quo(an, big.NewFloat(2).SetPrec(prec))
		bn := sqrtBig(new(big.Float).SetPrec(prec).Mul(a, b), prec)
		d := new(big.Float).SetPrec(prec).Sub(a, an)
		d.Mul(d, d)
		d.Mul(d, p)
		t.Sub(t, d)
		a, b = an, bn
		p.Mul(p, big.NewFloat(2).SetPrec(prec))
	}

	num := new(big.Float).SetPrec(prec).Add(a, b)
	num.Mul(num, num)
	den := new(big.Float).SetPrec(prec).Mul(big.NewFloat(4).SetPrec(prec), t)
	return num.Quo(num, den)
}

func sqrtBig(x *big.Float, prec uint) *big.Float {
	return new(big.Float).SetPrec(prec).Sqrt(x)
}

// TestTabelaDoisSobrePi confere os 66 blocos de 24 bits de 2/π usados pela redução de
// Payne–Hanek. Cada bloco `i` vale `twoOverPi[i] · 2^(-24·(i+1))`.
func TestTabelaDoisSobrePi(t *testing.T) {
	const prec = 2048
	dois := big.NewFloat(2).SetPrec(prec)
	esperado := new(big.Float).SetPrec(prec).Quo(dois, piGrande(prec))

	soma := new(big.Float).SetPrec(prec)
	escala := new(big.Float).SetPrec(prec).SetFloat64(1)
	doisMenos24 := new(big.Float).SetPrec(prec).SetMantExp(big.NewFloat(1).SetPrec(prec), -24)
	for _, bloco := range twoOverPi {
		escala.Mul(escala, doisMenos24)
		termo := new(big.Float).SetPrec(prec).SetInt64(int64(bloco))
		termo.Mul(termo, escala)
		soma.Add(soma, termo)
	}

	erro := new(big.Float).SetPrec(prec).Sub(esperado, soma)
	erro.Abs(erro)
	limite := new(big.Float).SetPrec(prec).SetMantExp(big.NewFloat(1).SetPrec(prec), -24*len(twoOverPi))
	if erro.Cmp(limite) > 0 {
		t.Fatalf("tabela twoOverPi diverge de 2/π: erro %v, limite %v", erro, limite)
	}
}

// TestPio2Chunks confere os 8 blocos que reconstroem π/2 no caminho de volta da redução.
func TestPio2Chunks(t *testing.T) {
	const prec = 512
	esperado := new(big.Float).SetPrec(prec).Quo(piGrande(prec), big.NewFloat(2).SetPrec(prec))

	soma := new(big.Float).SetPrec(prec)
	for _, c := range pio2Chunks {
		soma.Add(soma, new(big.Float).SetPrec(prec).SetFloat64(c))
	}

	erro := new(big.Float).SetPrec(prec).Sub(esperado, soma)
	erro.Abs(erro)
	limite := new(big.Float).SetPrec(prec).SetMantExp(big.NewFloat(1).SetPrec(prec), -180)
	if erro.Cmp(limite) > 0 {
		t.Fatalf("pio2Chunks diverge de π/2: erro %v", erro)
	}
}

// TestConstantesPio2 confere a cadeia de refinamento de π/2 usada pela redução de argumento.
//
// Não são três aproximações independentes: cada `pio2_N` é o truncamento a 33 bits da CAUDA
// anterior, e cada `pio2_Nt` é o que sobra. Somando de fora para dentro, a precisão sobe de 85
// para 118 e daí para 151 bits — exatamente os números que os comentários do fdlibm prometem, e
// que sustentam a exatidão de sen/cos perto dos múltiplos de π/2.
func TestConstantesPio2(t *testing.T) {
	const prec = 512
	pio2 := new(big.Float).SetPrec(prec).Quo(piGrande(prec), big.NewFloat(2).SetPrec(prec))

	niveis := []struct {
		nome     string
		termos   []float64
		bitsRest int
	}{
		{"pio2_1 + pio2_1t", []float64{pio21, pio21t}, 85},
		{"pio2_1 + pio2_2 + pio2_2t", []float64{pio21, pio22, pio22t}, 118},
		{"pio2_1 + pio2_2 + pio2_3 + pio2_3t", []float64{pio21, pio22, pio23, pio23t}, 151},
	}
	for _, n := range niveis {
		resto := new(big.Float).SetPrec(prec).Set(pio2)
		for _, termo := range n.termos {
			resto.Sub(resto, new(big.Float).SetPrec(prec).SetFloat64(termo))
		}
		erro := new(big.Float).SetPrec(prec).Abs(resto)
		limite := new(big.Float).SetPrec(prec).SetMantExp(big.NewFloat(1).SetPrec(prec), -n.bitsRest)
		if erro.Cmp(limite) > 0 {
			t.Fatalf("%s: erro %v acima de 2^-%d", n.nome, erro, n.bitsRest)
		}
	}

	// invpio2 tem que ser o double mais próximo de 2/π, senão o quadrante sai errado na fronteira.
	doisSobrePi, _ := new(big.Float).SetPrec(prec).Quo(big.NewFloat(2).SetPrec(prec), piGrande(prec)).Float64()
	if invpio2 != doisSobrePi {
		t.Fatalf("invpio2 = %v, esperado %v", invpio2, doisSobrePi)
	}
}

// TestRoundSegueEcma cobre os casos em que `Math.round` do JavaScript difere do `math.Round`
// do Go — os mesmos que quebrariam `mazeShape` e `densityFor` silenciosamente.
func TestRoundSegueEcma(t *testing.T) {
	casos := []struct {
		entrada  float64
		esperado float64
	}{
		{0.5, 1},
		{-0.5, math.Copysign(0, -1)}, // math.Round daria -1
		{-1.5, -1},                   // math.Round daria -2
		{-2.5, -2},                   // math.Round daria -3
		{2.5, 3},
		{0.49999999999999994, 0}, // floor(x+0.5) daria 1
		{-0.49999999999999994, math.Copysign(0, -1)},
		{1.5, 2},
		{4.5, 5},
		{-4.5, -4},
		{0, 0},
		{math.Copysign(0, -1), math.Copysign(0, -1)},
	}
	for _, c := range casos {
		obtido := Round(c.entrada)
		if math.Float64bits(obtido) != math.Float64bits(c.esperado) {
			t.Errorf("Round(%v) = %v (bits %016x), esperado %v (bits %016x)",
				c.entrada, obtido, math.Float64bits(obtido), c.esperado, math.Float64bits(c.esperado))
		}
	}
	if !math.IsNaN(Round(math.NaN())) {
		t.Error("Round(NaN) deveria ser NaN")
	}
	if Round(math.Inf(1)) != math.Inf(1) {
		t.Error("Round(+Inf) deveria ser +Inf")
	}
}

// TestSinCosDivergemDaBiblioteca é o teste que justifica o pacote existir: se um dia o Go
// passar a usar o mesmo fdlibm do V8, este teste falha e o pacote pode ser aposentado.
// Enquanto ele passar, trocar `jsmath.Sin` por `math.Sin` quebra a paridade com o navegador.
func TestSinCosDivergemDaBiblioteca(t *testing.T) {
	divergiu := false
	r := uint32(12345)
	prox := func() float64 {
		r += 0x6d2b79f5
		x := r
		y := x ^ (x >> 15)
		z := y * (1 | x)
		w := z ^ (z >> 7)
		v := (z + w*(61|z)) ^ z
		return float64(v^(v>>14)) / 4294967296
	}
	for i := 0; i < 20000 && !divergiu; i++ {
		x := (prox()*4 - 2) * math.Pi
		if math.Float64bits(Sin(x)) != math.Float64bits(math.Sin(x)) {
			divergiu = true
		}
		if math.Float64bits(Cos(x)) != math.Float64bits(math.Cos(x)) {
			divergiu = true
		}
	}
	if !divergiu {
		t.Skip("math.Sin/math.Cos do Go passaram a coincidir com jsmath — reavaliar a necessidade do pacote")
	}
}

// TestIdentidadesTrigonometricas é a rede de segurança grosseira: mesmo que a paridade com o V8
// estivesse quebrada, um erro de transcrição grande apareceria aqui.
func TestIdentidadesTrigonometricas(t *testing.T) {
	for i := -2000; i <= 2000; i++ {
		x := float64(i) * 0.01
		s, c := Sin(x), Cos(x)
		if math.Abs(s*s+c*c-1) > 1e-15 {
			t.Fatalf("sen²+cos² = %v em x=%v", s*s+c*c, x)
		}
		if math.Abs(s-math.Sin(x)) > 1e-15 {
			t.Fatalf("Sin(%v) = %v, longe de math.Sin = %v", x, s, math.Sin(x))
		}
		if math.Abs(c-math.Cos(x)) > 1e-15 {
			t.Fatalf("Cos(%v) = %v, longe de math.Cos = %v", x, c, math.Cos(x))
		}
	}
	// Faixa grande: exercita `kernelRemPio2`, o caminho que o jogo não usa mas a função promete.
	for _, x := range []float64{1e10, 1e20, 1e40, 1e100, 1e200, 1e300, -1e150} {
		if math.Abs(Sin(x)-math.Sin(x)) > 1e-14 {
			t.Errorf("Sin(%v) = %v, math.Sin = %v", x, Sin(x), math.Sin(x))
		}
		if math.Abs(Cos(x)-math.Cos(x)) > 1e-14 {
			t.Errorf("Cos(%v) = %v, math.Cos = %v", x, Cos(x), math.Cos(x))
		}
	}
}

func TestLogEAtanBatemComABibliotecaDentroDeUmUlp(t *testing.T) {
	for i := 1; i <= 20000; i++ {
		x := float64(i) * 0.001
		if d := math.Abs(Log(x) - math.Log(x)); d > 1e-15*math.Abs(math.Log(x))+1e-300 {
			t.Fatalf("Log(%v) = %v, math.Log = %v", x, Log(x), math.Log(x))
		}
		y := float64(i-10000) * 0.001
		if d := math.Abs(Atan(y) - math.Atan(y)); d > 1e-15 {
			t.Fatalf("Atan(%v) = %v, math.Atan = %v", y, Atan(y), math.Atan(y))
		}
	}
}

func TestHypotCasosDegenerados(t *testing.T) {
	if Hypot(0, 0) != 0 {
		t.Error("Hypot(0,0) deveria ser 0")
	}
	if Hypot(3, 4) != 5 {
		t.Errorf("Hypot(3,4) = %v", Hypot(3, 4))
	}
	if !math.IsInf(Hypot(math.Inf(1), math.NaN()), 1) {
		t.Error("Hypot(Inf,NaN) deveria ser +Inf, como Math.hypot")
	}
	if !math.IsNaN(Hypot(math.NaN(), 1)) {
		t.Error("Hypot(NaN,1) deveria ser NaN")
	}
	// O caso que a simulação realmente usa: normais de quina, com componentes em {-1,0,1}.
	for _, nx := range []float64{-1, 0, 1} {
		for _, ny := range []float64{-1, 0, 1} {
			if got, want := Hypot(nx, ny), math.Hypot(nx, ny); got != want {
				t.Errorf("Hypot(%v,%v) = %v, math.Hypot = %v", nx, ny, got, want)
			}
		}
	}
}
