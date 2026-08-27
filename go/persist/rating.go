// Package persist guarda o histórico de partidas e o ranking dos jogadores.
package persist

import "math"

// Porte de `openskill@5.0.1` (modelo Plackett–Luce), que é o que `apps/server/src/persist/rating.ts`
// usa. Só o caminho que o jogo exercita foi portado: times de UM jogador, `rank` explícito, sem
// `balance`, sem `margin`, sem `limitSigma`.
//
// Portar em vez de procurar um pacote Go equivalente foi decisão de PROVA: o critério de pronto
// é bater com os mesmos casos que o TypeScript produz, e um pacote de terceiros com outra ordem
// de operações daria números "certos" que não são os mesmos. As 60 linhas abaixo são a tradução
// literal de `rate.js`, `util.js` e `models/plackett-luce.js`.

// Constantes padrão do openskill (`constants.ts`, todas com os valores de fábrica).
const (
	mu0    = 25.0
	sigma0 = 25.0 / 3.0
	beta   = 25.0 / 6.0
	tau    = 25.0 / 300.0
	kappa  = 1e-4
	z      = 3.0
	alpha  = 1.0
	alvo   = 0.0
)

// Rating é a habilidade estimada de um jogador.
type Rating struct {
	Mu    float64
	Sigma float64
}

// NovoRating é o `rating()` do openskill: a estimativa de quem nunca jogou.
func NovoRating() Rating { return Rating{Mu: mu0, Sigma: sigma0} }

// Ordinal é o número único que ordena o ranking: `mu − 3σ`, o piso conservador da habilidade.
func Ordinal(r Rating) float64 { return alvo + alpha*(r.Mu-z*r.Sigma) }

// Rate atualiza os ratings de uma partida FFA em que cada jogador é o próprio time de um.
//
// `ratings` já vem na ordem do resultado — o primeiro elemento é o campeão. O `rank` do openskill
// seria `[0, 1, 2, ...]`, que com postos todos distintos e já ordenados faz o `unwind` do pacote
// virar identidade; por isso ele não aparece aqui.
func Rate(ratings []Rating) []Rating {
	n := len(ratings)
	if n == 0 {
		return nil
	}

	// `rate()`: a incerteza cresce de τ antes de qualquer conta — é o esquecimento que impede um
	// rating antigo de ficar cravado.
	inflados := make([]Rating, n)
	for i, r := range ratings {
		inflados[i] = Rating{Mu: r.Mu, Sigma: math.Sqrt(r.Sigma*r.Sigma + tau*tau)}
	}

	// `teamRating()` sem balance: time de um jogador é (mu, sigma²).
	muDoTime := make([]float64, n)
	sigSqDoTime := make([]float64, n)
	c := 0.0
	for i, r := range inflados {
		muDoTime[i] = r.Mu
		sigSqDoTime[i] = r.Sigma * r.Sigma
		c += sigSqDoTime[i] + beta*beta
	}
	c = math.Sqrt(c)

	// `utilSumQ`: para cada posto q, a soma de exp(mu/c) de todos os times que ficaram na mesma
	// posição ou pior. Postos distintos, então o laço é o sufixo.
	somaQ := make([]float64, n)
	for q := 0; q < n; q++ {
		soma := 0.0
		for i := q; i < n; i++ {
			soma += math.Exp(muDoTime[i] / c)
		}
		somaQ[q] = soma
	}

	saida := make([]Rating, n)
	for i := 0; i < n; i++ {
		expMuSobreC := math.Exp(muDoTime[i] / c)
		omega, delta := 0.0, 0.0
		// `a[q]` é quantos times empatam no posto q — sempre 1 aqui, então some da conta.
		for q := 0; q <= i; q++ {
			quociente := expMuSobreC / somaQ[q]
			if i == q {
				omega += 1 - quociente
			} else {
				omega -= quociente
			}
			delta += quociente * (1 - quociente)
		}
		gama := math.Sqrt(sigSqDoTime[i]) / c
		omega *= sigSqDoTime[i] / c
		delta *= (sigSqDoTime[i] / (c * c)) * gama

		r := inflados[i]
		sigSq := r.Sigma * r.Sigma
		novoMu := r.Mu + (sigSq/sigSqDoTime[i])*omega
		fator := 1 - (sigSq/sigSqDoTime[i])*delta
		if fator < kappa {
			fator = kappa
		}
		saida[i] = Rating{Mu: novoMu, Sigma: r.Sigma * math.Sqrt(fator)}
	}
	return saida
}
