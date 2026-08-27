// Package sim é o porte de `packages/shared-sim` para Go: a mesma simulação, bit a bit.
//
// Regras que valem para o pacote inteiro e não são negociáveis:
//
//   - toda operação de ponto flutuante que o TypeScript faz com `Math.*` passa por
//     `internal/jsmath`, nunca pelo `math` da biblioteca padrão;
//   - onde o TypeScript depende da ordem de inserção de um `Map`, aqui existe um slice ordenado;
//     `range` sobre mapa em Go é aleatório de propósito e destruiria o determinismo;
//   - nada de `math/rand`, `time` ou qualquer entrada de fora: `dt` vem de parâmetro e o acaso
//     vem de `Rng`, semeado.
package sim

// Rng é o mulberry32 — RNG determinístico de 32 bits, portável byte a byte entre o servidor e o
// navegador. É o alicerce de tudo: se ele divergir, o labirinto diverge, os spawns divergem e a
// partida inteira diverge.
//
// O estado é `uint32` em vez do `number` do JavaScript porque as operações originais (`|0`,
// `>>>`, `Math.imul`) são todas aritmética de 32 bits com transbordo circular — exatamente o que
// `uint32` faz em Go, e sem o risco de um valor intermediário escapar para float64.
type Rng struct {
	a uint32
}

// Mulberry32 cria o gerador a partir de uma semente de 32 bits.
func Mulberry32(seed uint32) *Rng {
	return &Rng{a: seed}
}

// Next devolve um float64 em [0, 1). A divisão por 2^32 é exata nas duas linguagens: o numerador
// é inteiro e cabe na mantissa, e o divisor é potência de dois.
func (r *Rng) Next() float64 {
	r.a += 0x6d2b79f5
	t := (r.a ^ (r.a >> 15)) * (1 | r.a)
	t = (t + (t^(t>>7))*(61|t)) ^ t
	return float64(t^(t>>14)) / 4294967296
}

// Int devolve um inteiro em [0, maxExclusive).
func (r *Rng) Int(maxExclusive int) int {
	return int(r.Next() * float64(maxExclusive))
}

// Shuffle embaralha no lugar (Fisher–Yates de trás para frente), como `Rng.shuffle`.
func Shuffle[T any](r *Rng, arr []T) []T {
	for i := len(arr) - 1; i > 0; i-- {
		j := r.Int(i + 1)
		arr[i], arr[j] = arr[j], arr[i]
	}
	return arr
}

// Pick escolhe um elemento, como `Rng.pick`.
func Pick[T any](r *Rng, arr []T) T {
	return arr[r.Int(len(arr))]
}

// State e SetState expõem o estado interno, como `getState`/`setState`.
func (r *Rng) State() uint32     { return r.a }
func (r *Rng) SetState(s uint32) { r.a = s }
