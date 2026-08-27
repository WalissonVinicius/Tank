package server

import (
	"testing"
)

// O espelho do protocolo é CÓPIA, e cópia sem conferência apodrece. Este teste compara valor a
// valor com o que o TypeScript exporta de verdade (ver `testdata/protocolo.json` e o comando que
// o regera, documentado em `codec_test.go`).
//
// É o mesmo papel da etapa "constantes" de `go/compare.mjs` para o tuning: uma cor reajustada, um
// animal renomeado ou um canal com nome novo de um lado só cai aqui, e não numa sala de verdade.

type vetoresDeProtocolo struct {
	Cores           []int              `json:"cores"`
	Nomes           []string           `json:"nomes"`
	Animais         []string           `json:"animais"`
	NomeDoAnimal    map[string]string  `json:"nomeDoAnimal"`
	AnimalPorCor    []string           `json:"animalPorCor"`
	Alfabeto        string             `json:"alfabeto"`
	TamanhoDoCodigo int                `json:"tamanhoDoCodigo"`
	Vagas           int                `json:"vagas"`
	RotaSalas       string             `json:"rotaSalas"`
	Canais          map[string]string  `json:"canais"`
	Transporte      map[string]string  `json:"transporte"`
	Duracoes        map[string]float64 `json:"duracoes"`
}

func TestEspelhoDoProtocolo(t *testing.T) {
	var v vetoresDeProtocolo
	lerVetores(t, "protocolo.json", &v)

	if len(v.Cores) != len(CoresDeJogador) {
		t.Fatalf("a paleta tem %d cores no TypeScript e %d no Go", len(v.Cores), len(CoresDeJogador))
	}
	for i, c := range v.Cores {
		if CoresDeJogador[i] != c {
			t.Errorf("cor %d: go %#06x, ts %#06x", i, CoresDeJogador[i], c)
		}
	}

	compararStrings(t, "nomes de teste", v.Nomes, NomesDeTeste)
	compararStrings(t, "animais", v.Animais, AnimaisDeJogador)
	compararStrings(t, "animal por cor", v.AnimalPorCor, animaisDasCores())

	for id, nome := range v.NomeDoAnimal {
		if NomeDoAnimal[id] != nome {
			t.Errorf("nome do animal %q: go %q, ts %q", id, NomeDoAnimal[id], nome)
		}
	}

	if v.Alfabeto != AlfabetoDoCodigo {
		t.Errorf("alfabeto do código: go %q, ts %q", AlfabetoDoCodigo, v.Alfabeto)
	}
	if v.TamanhoDoCodigo != TamanhoDoCodigo {
		t.Errorf("tamanho do código: go %d, ts %d", TamanhoDoCodigo, v.TamanhoDoCodigo)
	}
	if v.Vagas != VagasPorSala {
		t.Errorf("vagas por sala: go %d, ts %d", VagasPorSala, v.Vagas)
	}
	if v.RotaSalas != RotaSalas {
		t.Errorf("rota de salas: go %q, ts %q", RotaSalas, v.RotaSalas)
	}

	canaisDoGo := map[string]bool{
		MsgInput: true, MsgReady: true, MsgPickColor: true, MsgAddBot: true, MsgRemoveBot: true,
		MsgRematch: true, MsgConfig: true, MsgViewport: true, "snapshot": true,
		MsgBulletSpwn: true, MsgBulletDead: true, MsgTankDeath: true, MsgRoundStart: true,
		MsgRoundEnd: true, MsgSuddenWall: true, MsgPowerTaken: true, MsgPowerExpir: true,
		MsgGameOver: true,
	}
	for chave, canal := range v.Canais {
		if !canaisDoGo[canal] {
			t.Errorf("o canal %s (%q) do TypeScript não existe no Go", chave, canal)
		}
	}

	transporteDoGo := map[string]bool{MsgEntrar: true, MsgEntrou: true, MsgErro: true, MsgSair: true, MsgEstado: true}
	for chave, canal := range v.Transporte {
		if !transporteDoGo[canal] {
			t.Errorf("o canal de transporte %s (%q) do TypeScript não existe no Go", chave, canal)
		}
	}

	for tipo, duracao := range v.Duracoes {
		if DuracaoDePowerUp[tipo] != duracao {
			t.Errorf("duração de %q: go %v, ts %v", tipo, DuracaoDePowerUp[tipo], duracao)
		}
	}
}

func animaisDasCores() []string {
	out := make([]string, len(CoresDeJogador))
	for i, c := range CoresDeJogador {
		out[i] = AnimalDaCor(c)
	}
	return out
}

func compararStrings(t *testing.T, oque string, ts, emGo []string) {
	t.Helper()
	if len(ts) != len(emGo) {
		t.Errorf("%s: %d no TypeScript, %d no Go", oque, len(ts), len(emGo))
		return
	}
	for i := range ts {
		if ts[i] != emGo[i] {
			t.Errorf("%s [%d]: go %q, ts %q", oque, i, emGo[i], ts[i])
		}
	}
}

func TestSorteioDeCodigoRespeitaOAlfabeto(t *testing.T) {
	for i := 0; i < 2000; i++ {
		codigo := sortearCodigo()
		if len(codigo) != TamanhoDoCodigo {
			t.Fatalf("código com %d caracteres: %q", len(codigo), codigo)
		}
		for _, ch := range codigo {
			// Sem I, O, 0 nem 1: são os quatro caracteres que as pessoas confundem lendo em voz
			// alta, que é como o código circula no escritório.
			if !contemRune(AlfabetoDoCodigo, ch) {
				t.Fatalf("caractere fora do alfabeto em %q: %q", codigo, ch)
			}
		}
	}
}

func TestNormalizarCodigo(t *testing.T) {
	casos := map[string]string{
		"abcd":     "ABCD",
		" a b c d": "ABCD",
		"ABCDEF":   "ABCD",
		"AB":       "AB",
		"a1b0c":    "ABC", // 1 e 0 não existem no alfabeto e são descartados
		"áéçx":     "AECX",
		"":         "",
	}
	for entrada, esperado := range casos {
		if obtido := normalizarCodigo(entrada); obtido != esperado {
			t.Errorf("normalizarCodigo(%q) = %q, esperava %q", entrada, obtido, esperado)
		}
	}
}

func contemRune(s string, r rune) bool {
	for _, c := range s {
		if c == r {
			return true
		}
	}
	return false
}
