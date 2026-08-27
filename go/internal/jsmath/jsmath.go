// Package jsmath reproduz, bit a bit, o `Math` do JavaScript como o V8 o implementa.
//
// Por que isto existe: a simulação do Tank Ricochete roda nos dois lados (servidor e navegador)
// e a bala NÃO trafega pela rede — cada cliente calcula a trajetória sozinho. Se o servidor Go
// e o cliente V8 discordarem em UM bit, o ricochete acontece num lugar na tela de um jogador e
// noutro na do adversário.
//
// A biblioteca padrão do Go NÃO serve para isso. Medição feita nesta tarefa, com 200.000
// ângulos sorteados na faixa [-2π, 2π] (a faixa real do jogo):
//
//	math.Sin   diverge de Math.sin   em 22,30% dos valores
//	math.Cos   diverge de Math.cos   em 27,00% dos valores
//	math.Log   diverge de Math.log   em  1,27% dos valores
//	math.Atan2 diverge de Math.atan2 em 21,48% dos valores
//
// A causa é linhagem: o Go herdou sin/cos/atan do Cephes e o V8 herdou do fdlibm (via
// `src/base/ieee754.cc`). São polinômios e reduções de argumento diferentes; ambos corretos
// dentro de 1 ULP, e por isso mesmo incompatíveis quando o critério é igualdade exata.
//
// O que este pacote faz é portar o fdlibm — o MESMO que o V8 usa — para Go. As funções abaixo
// não são "equivalentes" a `Math.*`: são a mesma sequência de operações de ponto flutuante, na
// mesma ordem, com as mesmas constantes. `go test ./internal/jsmath` verifica as constantes
// contra `math/big` e o comando `cmd/mathprobe` compara a saída com a do V8 valor a valor.
//
// ATENÇÃO — arquiteturas com contração FMA: o compilador Go pode fundir `a*b + c` numa única
// instrução FMA em arm64/ppc64/s390x/riscv64, o que MUDA o resultado (a fusão pula um
// arredondamento). Em amd64 isso não acontece. Por segurança, todo produto dentro de uma soma
// nos kernels abaixo vai envolto em `float64(...)`, que a especificação do Go define como uma
// barreira de arredondamento explícita e proíbe a fusão.
package jsmath

import "math"

// Abs, Floor, Ceil e Sqrt são bit a bit iguais em qualquer implementação de IEEE 754: as três
// primeiras são exatas por definição e `sqrt` tem arredondamento correto exigido pela norma.
// Ficam aqui só para o código da simulação ler igual ao TypeScript de origem.

func Abs(x float64) float64   { return math.Abs(x) }
func Floor(x float64) float64 { return math.Floor(x) }
func Ceil(x float64) float64  { return math.Ceil(x) }
func Sqrt(x float64) float64  { return math.Sqrt(x) }

// Min e Max de dois argumentos, com a semântica do JavaScript (NaN contamina, -0 < +0).
func Min(a, b float64) float64 {
	if math.IsNaN(a) || math.IsNaN(b) {
		return math.NaN()
	}
	if a == 0 && b == 0 {
		if math.Signbit(a) {
			return a
		}
		return b
	}
	if a < b {
		return a
	}
	return b
}

func Max(a, b float64) float64 {
	if math.IsNaN(a) || math.IsNaN(b) {
		return math.NaN()
	}
	if a == 0 && b == 0 {
		if math.Signbit(a) {
			return b
		}
		return a
	}
	if a > b {
		return a
	}
	return b
}

// Sign com a semântica do JavaScript: preserva ±0 e propaga NaN.
func Sign(x float64) float64 {
	if math.IsNaN(x) || x == 0 {
		return x
	}
	if x < 0 {
		return -1
	}
	return 1
}

// Round implementa `Math.round` da ECMA-262 §21.3.2.28, que NÃO é o `math.Round` do Go.
//
// Duas diferenças que quebram paridade se ignoradas:
//
//  1. empate vai para +∞, não para longe do zero: `Math.round(-0.5)` é `-0` e `math.Round(-0.5)`
//     é `-1`;
//  2. o famoso caso `Math.round(0.49999999999999994)`, que é `0`. A definição ingênua
//     `floor(x+0.5)` daria `1` porque a soma arredonda para exatamente `1.0` antes do piso —
//     por isso aqui a comparação é feita sobre `x - floor(x)`, que é exata para |x| < 2^52.
func Round(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) || x == math.Trunc(x) {
		return x
	}
	if x > 0 && x < 0.5 {
		return 0
	}
	if x < 0 && x >= -0.5 {
		return math.Copysign(0, -1)
	}
	f := math.Floor(x)
	if x-f >= 0.5 {
		return f + 1
	}
	return f
}

// Mod reproduz o operador `%` do JavaScript sobre números: resto truncado, com o sinal do
// dividendo. É o mesmo `math.Mod` do Go, e é exato nas duas linguagens (nenhum arredondamento
// intermediário), então não há divergência possível aqui.
func Mod(x, y float64) float64 { return math.Mod(x, y) }

// Imul reproduz `Math.imul`: multiplicação de 32 bits com truncamento, sem passar por float64.
func Imul(a, b uint32) uint32 { return a * b }

// Hypot reproduz `Math.hypot` do V8 (`src/builtins/math.tq`), que NÃO é o `math.Hypot` do Go.
//
// O Go faz `p*sqrt(1 + (q/p)²)`; o V8 faz uma soma de Kahan dos quadrados já escalados pelo
// maior valor e só então tira a raiz. As duas evitam overflow, mas erram em casas diferentes.
func Hypot(x, y float64) float64 {
	ax, ay := math.Abs(x), math.Abs(y)
	if math.IsInf(ax, 1) || math.IsInf(ay, 1) {
		return math.Inf(1)
	}
	if math.IsNaN(ax) || math.IsNaN(ay) {
		return math.NaN()
	}
	max := ax
	if ay > max {
		max = ay
	}
	if max == 0 {
		return 0
	}

	sum, compensation := 0.0, 0.0
	for _, v := range [2]float64{ax, ay} {
		n := v / max
		n = n * n
		summand := n - compensation
		preliminary := sum + summand
		compensation = (preliminary - sum) - summand
		sum = preliminary
	}
	return math.Sqrt(sum) * max
}

// --- utilitários de bits, o equivalente das macros GET_HIGH_WORD/SET_HIGH_WORD do fdlibm ---

func highWord(x float64) uint32 { return uint32(math.Float64bits(x) >> 32) }
func lowWord(x float64) uint32  { return uint32(math.Float64bits(x)) }

func withHighWord(x float64, hi uint32) float64 {
	return math.Float64frombits(math.Float64bits(x)&0x00000000ffffffff | uint64(hi)<<32)
}

func fromWords(hi, lo uint32) float64 {
	return math.Float64frombits(uint64(hi)<<32 | uint64(lo))
}

// Inf, NegInf e IsNaN existem para que o pacote `sim` não precise importar `math` diretamente —
// a regra lá é que toda conta passe por aqui, e uma exceção abre precedente para a próxima.
func Inf() float64            { return math.Inf(1) }
func NegInf() float64         { return math.Inf(-1) }
func IsNaN(x float64) bool    { return math.IsNaN(x) }
func IsFinite(x float64) bool { return !math.IsNaN(x) && !math.IsInf(x, 0) }

// Pi é `Math.PI`: o double mais próximo de π. Vem de `math.Pi` do Go, que é a mesma constante
// com precisão de sobra — ao ser convertida para float64, arredonda para o mesmo valor.
func Pi() float64 { return math.Pi }
