package server

import (
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"testing"

	"github.com/simplex/tank/go/sim"
)

// Os vetores de `testdata/` foram GERADOS PELO TYPESCRIPT, não escritos à mão. Regerar:
//
//	cd apps/server
//	npx tsx ref/codec.ts     > ../../go/server/testdata/codec.json
//	npx tsx ref/protocolo.ts > ../../go/server/testdata/protocolo.json
//	npx tsx ref/rodada.ts    > ../../go/server/testdata/rodada.json
//
// É o mesmo princípio da prova de paridade da simulação: um porte comparado só consigo mesmo não
// prova nada. Aqui a tolerância também é zero — o snapshot é comparado em HEXADECIMAL.

type vetoresDeCodec struct {
	Snapshots []string `json:"snapshots"`
	Movimento []struct {
		Bits  int      `json:"bits"`
		Mover *float64 `json:"mover"`
	} `json:"movimento"`
	Aim []struct {
		Byte int     `json:"byte"`
		Rad  float64 `json:"rad"`
	} `json:"aim"`
}

func lerVetores(t *testing.T, arquivo string, destino any) {
	t.Helper()
	bruto, err := os.ReadFile("testdata/" + arquivo)
	if err != nil {
		t.Fatalf("não consegui ler %s: %v", arquivo, err)
	}
	if err := json.Unmarshal(bruto, destino); err != nil {
		t.Fatalf("%s inválido: %v", arquivo, err)
	}
}

// casosDeSnapshot repete, em Go, os mesmos tanques que o gerador TypeScript usou. A ordem importa:
// é ela que casa com `vetores.Snapshots`.
var casosDeSnapshot = [][]SnapshotTank{
	{},
	{{Slot: 0, X: 0, Y: 0, Heading: 0, Turret: 0, Alive: true, Connected: true}},
	{
		{Slot: 3, X: 123.49, Y: -87.51, Heading: math.Pi, Turret: math.Pi / 2, Alive: true, Connected: false},
		{Slot: 9, X: -1.5, Y: 2.5, Heading: -0.75, Turret: 6.28318, Alive: false, Connected: true},
		{Slot: 7, X: 32767.4, Y: -32767.4, Heading: 12.5, Turret: -12.5, Alive: true, Connected: true},
	},
}

func TestSnapshotBateComOTypeScript(t *testing.T) {
	var v vetoresDeCodec
	lerVetores(t, "codec.json", &v)

	if len(v.Snapshots) != len(casosDeSnapshot) {
		t.Fatalf("o gerador produziu %d casos e o teste tem %d", len(v.Snapshots), len(casosDeSnapshot))
	}
	for i, esperado := range v.Snapshots {
		obtido := hex.EncodeToString(EncodeSnapshot(casosDeSnapshot[i]))
		if obtido != esperado {
			t.Errorf("caso %d: snapshot divergiu\n  go: %s\n  ts: %s", i, obtido, esperado)
		}
	}
}

func TestDecodeInputBitsBateComOTypeScript(t *testing.T) {
	var v vetoresDeCodec
	lerVetores(t, "codec.json", &v)

	for _, caso := range v.Movimento {
		in := DecodeInputBits(caso.Bits, 0, false)
		if caso.Mover == nil {
			if in.MoverAtivo {
				t.Errorf("bits %d: o TypeScript diz parado e o Go diz %v", caso.Bits, in.Mover)
			}
			continue
		}
		if !in.MoverAtivo {
			t.Errorf("bits %d: o TypeScript diz %v e o Go diz parado", caso.Bits, *caso.Mover)
			continue
		}
		// Bit a bit: um bit de diferença no ângulo vira posição diferente do tanque, que vira uma
		// bala passando raspando de um lado e acertando do outro.
		if math.Float64bits(in.Mover) != math.Float64bits(*caso.Mover) {
			t.Errorf("bits %d: mover divergiu\n  go: %016x\n  ts: %016x",
				caso.Bits, math.Float64bits(in.Mover), math.Float64bits(*caso.Mover))
		}
	}
}

func TestDecodeAimBateComOTypeScript(t *testing.T) {
	var v vetoresDeCodec
	lerVetores(t, "codec.json", &v)

	for _, caso := range v.Aim {
		obtido := DecodeAim(caso.Byte)
		if math.Float64bits(obtido) != math.Float64bits(caso.Rad) {
			t.Errorf("aim %d divergiu\n  go: %016x\n  ts: %016x",
				caso.Byte, math.Float64bits(obtido), math.Float64bits(caso.Rad))
		}
	}
}

func TestBitDeTiroEntraNoInput(t *testing.T) {
	if in := DecodeInputBits(0x10, 0, false); !in.Fire {
		t.Fatal("o bit 4 deveria ligar o disparo")
	}
	if in := DecodeInputBits(0x0f, 0, false); in.Fire {
		t.Fatal("sem o bit 4 não há disparo")
	}
	in := DecodeInputBits(0, 128, true)
	if !in.AimAtivo {
		t.Fatal("com `aim` presente a torre tem alvo")
	}
	if semAim := DecodeInputBits(0, 0, false); semAim.AimAtivo {
		t.Fatal("sem `aim` a torre fica onde está — não pode fabricar 0 rad")
	}
	_ = sim.Input(in)
}
