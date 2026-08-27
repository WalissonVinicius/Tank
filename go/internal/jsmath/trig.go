package jsmath

import "math"

// Porte direto de `__kernel_sin` / `__kernel_cos` / `sin` / `cos` do fdlibm, na variante que o
// V8 carrega em `src/base/ieee754.cc`. Os comentários originais em inglês foram traduzidos; a
// aritmética está intocada, inclusive a ordem das operações — mexer nela é mexer no último bit.

// Coeficientes do polinômio de sen(x) em [-π/4, π/4].
const (
	kHalf = 5.00000000000000000000e-01 // 0x3FE0000000000000
	kS1   = -1.66666666666666324348e-01
	kS2   = 8.33333333332248946124e-03
	kS3   = -1.98412698298579493134e-04
	kS4   = 2.75573137070700676789e-06
	kS5   = -2.50507602534068634195e-08
	kS6   = 1.58969099521155010221e-10
)

// Coeficientes do polinômio de cos(x) em [-π/4, π/4].
const (
	kC1 = 4.16666666666666019037e-02
	kC2 = -1.38888888888741095749e-03
	kC3 = 2.48015872894767294178e-05
	kC4 = -2.75573143513906633035e-07
	kC5 = 2.08757232129817482790e-09
	kC6 = -1.13596475577881948265e-11
)

// kernelSin calcula sen(x + y) para |x| ≤ π/4, onde `y` é a cauda da redução de argumento.
// `iy == 0` significa "y é zero" e permite o caminho curto.
func kernelSin(x, y float64, iy int) float64 {
	z := x * x
	v := z * x
	r := kS2 + float64(z*(kS3+float64(z*(kS4+float64(z*(kS5+float64(z*kS6)))))))
	if iy == 0 {
		return x + v*(kS1+float64(z*r))
	}
	return x - ((z*(kHalf*y-v*r) - y) - v*kS1)
}

// kernelCos calcula cos(x + y) para |x| ≤ π/4.
//
// O truque do `qx` não é decoração: subtrair um valor exato próximo de `0,5·x²` ANTES da soma
// final é o que impede o cancelamento catastrófico quando `x` se aproxima de π/4. A versão
// moderna do FreeBSD trocou isso por outro arranjo — e o resultado difere no último bit, então
// aqui fica a variante original, que é a que o V8 carrega.
func kernelCos(x, y float64) float64 {
	ix := highWord(x) & 0x7fffffff
	z := x * x
	r := z * (kC1 + float64(z*(kC2+float64(z*(kC3+float64(z*(kC4+float64(z*(kC5+float64(z*kC6))))))))))

	if ix < 0x3FD33333 { // |x| < 0,3
		return 1.0 - (0.5*z - (z*r - x*y))
	}
	var qx float64
	if ix > 0x3fe90000 { // |x| > 0,78125
		qx = 0.28125
	} else {
		qx = fromWords(ix-0x00200000, 0) // x/4, exato
	}
	hz := 0.5*z - qx
	a := 1.0 - qx
	return a - (hz - (z*r - x*y))
}

// Sin é `Math.sin`.
func Sin(x float64) float64 {
	ix := highWord(x) & 0x7fffffff

	if ix <= 0x3fe921fb { // |x| < π/4
		if ix < 0x3e500000 { // |x| < 2^-26: sen(x) = x
			if int32(x) == 0 {
				return x
			}
		}
		return kernelSin(x, 0, 0)
	}
	if ix >= 0x7ff00000 { // ±Inf ou NaN
		return x - x
	}

	var y [2]float64
	n := remPio2(x, &y)
	switch n & 3 {
	case 0:
		return kernelSin(y[0], y[1], 1)
	case 1:
		return kernelCos(y[0], y[1])
	case 2:
		return -kernelSin(y[0], y[1], 1)
	default:
		return -kernelCos(y[0], y[1])
	}
}

// Cos é `Math.cos`.
func Cos(x float64) float64 {
	ix := highWord(x) & 0x7fffffff

	if ix <= 0x3fe921fb { // |x| < π/4
		if ix < 0x3e46a09e { // |x| < 2^-27·√2: cos(x) = 1
			if int32(x) == 0 {
				return 1
			}
		}
		return kernelCos(x, 0)
	}
	if ix >= 0x7ff00000 {
		return x - x
	}

	var y [2]float64
	n := remPio2(x, &y)
	switch n & 3 {
	case 0:
		return kernelCos(y[0], y[1])
	case 1:
		return -kernelSin(y[0], y[1], 1)
	case 2:
		return -kernelCos(y[0], y[1])
	default:
		return kernelSin(y[0], y[1], 1)
	}
}

// π/2 quebrado em pedaços de 33 bits, para que `n·(π/2)` seja subtraído sem perder precisão.
const (
	invpio2 = 6.36619772367581382433e-01 // 2/π
	pio21   = 1.57079632673412561417e+00
	pio21t  = 6.07710050650619224932e-11
	pio22   = 6.07710050630396597660e-11
	pio22t  = 2.02226624879595063154e-21
	pio23   = 2.02226624871116645580e-21
	pio23t  = 8.47842766036889956997e-32
)

// remPio2 é `__ieee754_rem_pio2`: escreve em `y` o resto de x módulo π/2 em precisão dupla-dupla
// e devolve o quadrante `n`, tal que x = n·(π/2) + y[0] + y[1].
//
// A forma exata desta função NÃO foi adivinhada: ela foi calibrada contra o V8, com 380.495
// casos que incluem todos os múltiplos de π/2 até 20π e suas vizinhanças de 1 ULP. O fdlibm tem
// duas linhagens que só diferem em detalhes, e cada detalhe custou uma medição:
//
//	· casos especiais até 9π/4 (variante FreeBSD)  → 1 divergência em 380.495;
//	· caso especial só até 3π/4 (variante Sun) +
//	  atalho `npio2_hw` no caso médio               → 12+6 divergências;
//	· caso especial só até 3π/4 + caso médio SEMPRE
//	  refinando (sem o atalho)                      → 0 divergências. ← esta.
//
// O atalho descartado é o que mais dói: ele pula as passadas de refino quando `x` não cai sobre
// um múltiplo de π/2 tabelado, e o V8 não o tem. Sem o refino, um `x` a poucos ULPs de 14π
// perdia dez bits do resultado.
func remPio2(x float64, y *[2]float64) int32 {
	hx := int32(highWord(x))
	ix := hx & 0x7fffffff

	if ix <= 0x3fe921fb { // |x| ≤ π/4: nada a reduzir
		y[0] = x
		y[1] = 0
		return 0
	}

	if ix < 0x4002d97c { // |x| < 3π/4: caso especial com n = ±1
		if hx > 0 {
			z := x - pio21
			if ix != 0x3ff921fb { // π com 33+53 bits basta
				y[0] = z - pio21t
				y[1] = (z - y[0]) - pio21t
			} else { // perto de π/2: precisa de 33+33+53 bits
				z -= pio22
				y[0] = z - pio22t
				y[1] = (z - y[0]) - pio22t
			}
			return 1
		}
		z := x + pio21
		if ix != 0x3ff921fb {
			y[0] = z + pio21t
			y[1] = (z - y[0]) + pio21t
		} else {
			z += pio22
			y[0] = z + pio22t
			y[1] = (z - y[0]) + pio22t
		}
		return -1
	}

	if ix <= 0x413921fb { // |x| ≤ 2^19·(π/2): caso médio
		return remPio2Medium(x, hx, ix, y)
	}

	if ix >= 0x7ff00000 { // ±Inf ou NaN
		y[0] = x - x
		y[1] = y[0]
		return 0
	}

	return remPio2Large(x, hx, ix, y)
}

// Caso médio: o quadrante sai de `trunc(|x|·2/π + 0,5)` e a subtração é refinada em até três
// passadas, conforme quantos bits o cancelamento comeu.
func remPio2Medium(x float64, hx, ix int32, y *[2]float64) int32 {
	t := math.Abs(x)
	n := int32(t*invpio2 + kHalf)
	fn := float64(n)
	r := t - fn*pio21
	w := fn * pio21t // 1ª passada: boa até 85 bits

	j := ix >> 20
	y[0] = r - w
	high := int32(highWord(y[0]))
	i := j - ((high >> 20) & 0x7ff)
	if i > 16 { // 2ª passada necessária, boa até 118 bits
		t = r
		w = fn * pio22
		r = t - w
		w = fn*pio22t - ((t - r) - w)
		y[0] = r - w
		high = int32(highWord(y[0]))
		i = j - ((high >> 20) & 0x7ff)
		if i > 49 { // 3ª passada, 151 bits — cobre todos os casos restantes
			t = r
			w = fn * pio23
			r = t - w
			w = fn*pio23t - ((t - r) - w)
			y[0] = r - w
		}
	}
	y[1] = (r - y[0]) - w
	if hx < 0 {
		y[0] = -y[0]
		y[1] = -y[1]
		return -n
	}
	return n
}

// Caso grande (|x| ≥ 2^20·π/2): Payne–Hanek com a expansão de 2/π em blocos de 24 bits.
// O jogo nunca chega aqui — todo ângulo da simulação está normalizado em [-π, π] — mas a função
// existe para que `Sin`/`Cos` sejam substitutos totais de `Math.sin`/`Math.cos`, e não apenas
// dentro da faixa que hoje nos interessa.
func remPio2Large(x float64, hx, ix int32, y *[2]float64) int32 {
	var tx [3]float64
	var ty [2]float64

	// z = |x| escalado para o expoente 2^23, para fatiar a mantissa em três pedaços de 24 bits.
	e0 := (ix >> 20) - 1046
	z := fromWords(uint32(ix-(e0<<20)), lowWord(x))

	for i := 0; i < 2; i++ {
		tx[i] = float64(int32(z))
		z = (z - tx[i]) * two24
	}
	tx[2] = z
	nx := 3
	for nx-1 > 0 && tx[nx-1] == 0 {
		nx--
	}

	n := kernelRemPio2(tx[:], ty[:], int(e0), nx)
	if hx < 0 {
		y[0] = -ty[0]
		y[1] = -ty[1]
		return -n
	}
	y[0] = ty[0]
	y[1] = ty[1]
	return n
}
