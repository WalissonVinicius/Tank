package persist

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

// O `openskill` do TypeScript é a referência. `testdata_rating.json` foi gerado por ele:
//
//	cd apps/server && node ref/rating.mjs > ../../go/persist/testdata_rating.json
//
// A tolerância não é zero aqui, e é honesto dizer por quê: o cálculo passa por `Math.exp`, e o
// `exp` do Go e o do V8 podem discordar no último bit. Isso NÃO é o caso da simulação, onde um
// bit vira um ricochete no lugar errado — aqui vira 1e-15 num número que só serve para ordenar
// uma lista. O limite de 1e-12 relativo é várias ordens de grandeza mais apertado do que qualquer
// diferença que mude uma posição no ranking, e ainda assim pega qualquer erro de porte.
const toleranciaRelativa = 1e-12

type casoDeRating struct {
	Entrada  []Rating  `json:"entrada"`
	Saida    []Rating  `json:"saida"`
	Ordinais []float64 `json:"ordinais"`
}

type vetoresDeRating struct {
	Padrao Rating         `json:"padrao"`
	Casos  []casoDeRating `json:"casos"`
}

func (r *Rating) UnmarshalJSON(b []byte) error {
	var bruto struct {
		Mu    float64 `json:"mu"`
		Sigma float64 `json:"sigma"`
	}
	if err := json.Unmarshal(b, &bruto); err != nil {
		return err
	}
	r.Mu, r.Sigma = bruto.Mu, bruto.Sigma
	return nil
}

func lerVetores(t *testing.T) vetoresDeRating {
	t.Helper()
	bruto, err := os.ReadFile("testdata_rating.json")
	if err != nil {
		t.Fatalf("não consegui ler os vetores do TypeScript: %v", err)
	}
	var v vetoresDeRating
	if err := json.Unmarshal(bruto, &v); err != nil {
		t.Fatalf("vetores inválidos: %v", err)
	}
	return v
}

func perto(t *testing.T, oque string, emGo, ts float64) {
	t.Helper()
	escala := math.Max(1, math.Abs(ts))
	if math.Abs(emGo-ts) > toleranciaRelativa*escala {
		t.Errorf("%s: go %.17g, ts %.17g (diferença %.3g)", oque, emGo, ts, math.Abs(emGo-ts))
	}
}

func TestRatingPadraoBateComOTypeScript(t *testing.T) {
	v := lerVetores(t)
	padrao := NovoRating()
	perto(t, "mu padrão", padrao.Mu, v.Padrao.Mu)
	perto(t, "sigma padrão", padrao.Sigma, v.Padrao.Sigma)
}

func TestRateBateComOOpenskillDoTypeScript(t *testing.T) {
	v := lerVetores(t)
	for i, caso := range v.Casos {
		obtido := Rate(caso.Entrada)
		if len(obtido) != len(caso.Saida) {
			t.Fatalf("caso %d: %d saídas no Go, %d no TypeScript", i, len(obtido), len(caso.Saida))
		}
		for j := range obtido {
			perto(t, nomeDoCampo(i, j, "mu"), obtido[j].Mu, caso.Saida[j].Mu)
			perto(t, nomeDoCampo(i, j, "sigma"), obtido[j].Sigma, caso.Saida[j].Sigma)
			perto(t, nomeDoCampo(i, j, "ordinal"), Ordinal(obtido[j]), caso.Ordinais[j])
		}
	}
}

func nomeDoCampo(caso, jogador int, campo string) string {
	return "caso " + itoa(caso) + ", jogador " + itoa(jogador) + ", " + campo
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [8]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// Quem venceu tem que subir e quem perdeu tem que descer — a propriedade que qualquer erro de
// sinal no porte quebraria antes de qualquer comparação numérica.
func TestVencedorSobeEPerdedorDesce(t *testing.T) {
	entrada := []Rating{NovoRating(), NovoRating(), NovoRating()}
	saida := Rate(entrada)
	if saida[0].Mu <= entrada[0].Mu {
		t.Errorf("o campeão não subiu: %v -> %v", entrada[0].Mu, saida[0].Mu)
	}
	if saida[2].Mu >= entrada[2].Mu {
		t.Errorf("o último não desceu: %v -> %v", entrada[2].Mu, saida[2].Mu)
	}
	// A incerteza cai para todo mundo: a partida trouxe informação sobre os três.
	for i := range saida {
		if saida[i].Sigma >= entrada[i].Sigma {
			t.Errorf("o sigma do jogador %d não caiu: %v -> %v", i, entrada[i].Sigma, saida[i].Sigma)
		}
	}
}

func TestRateComListaVazia(t *testing.T) {
	if r := Rate(nil); r != nil {
		t.Fatalf("partida sem ninguém devolveu %v", r)
	}
}
