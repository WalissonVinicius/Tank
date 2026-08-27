package server

import (
	"testing"

	"github.com/simplex/tank/go/sim"
)

// Porte de `roundLoop.ts` conferido contra a saída do próprio TypeScript (`testdata/rodada.json`).

type vetoresDeRodada struct {
	Rankings []struct {
		Mortos []string           `json:"mortos"`
		Vivos  []string           `json:"vivos"`
		Saida  []EntradaDeRanking `json:"saida"`
	} `json:"rankings"`
	Mortes []struct {
		Entrada []struct {
			VictimID string `json:"victimId"`
			KillerID string `json:"killerId"`
			Autogol  bool   `json:"autogol"`
		} `json:"entrada"`
		Kills     map[string]int `json:"kills"`
		SelfKills map[string]int `json:"selfKills"`
	} `json:"mortes"`
	Escores []struct {
		P     int `json:"p"`
		K     int `json:"k"`
		S     int `json:"s"`
		Saida int `json:"saida"`
	} `json:"escores"`
	Titulos []struct {
		Entrada []struct {
			PlayerID     string  `json:"playerId"`
			SelfKills    int     `json:"selfKills"`
			ShotsFired   int     `json:"shotsFired"`
			ShotsHit     int     `json:"shotsHit"`
			AliveSeconds float64 `json:"aliveSeconds"`
			KillCount    int     `json:"killCount"`
		} `json:"entrada"`
		Saida Titulos `json:"saida"`
	} `json:"titulos"`
	Paredes []struct {
		Seed      uint32 `json:"seed"`
		Tentativa int    `json:"tentativa"`
		Index     *int   `json:"index"`
	} `json:"paredes"`
}

func TestRankingDaRodadaBateComOTypeScript(t *testing.T) {
	var v vetoresDeRodada
	lerVetores(t, "rodada.json", &v)

	for i, caso := range v.Rankings {
		obtido := ComputeRoundRanking(caso.Mortos, caso.Vivos)
		if len(obtido) != len(caso.Saida) {
			t.Fatalf("caso %d: %d entradas no Go, %d no TypeScript", i, len(obtido), len(caso.Saida))
		}
		for j := range obtido {
			if obtido[j] != caso.Saida[j] {
				t.Errorf("caso %d, entrada %d: go %+v, ts %+v", i, j, obtido[j], caso.Saida[j])
			}
		}
	}
}

func TestContagemDeAbatesBateComOTypeScript(t *testing.T) {
	var v vetoresDeRodada
	lerVetores(t, "rodada.json", &v)

	for i, caso := range v.Mortes {
		mortes := make([]RegistroDeMorte, 0, len(caso.Entrada))
		for _, m := range caso.Entrada {
			mortes = append(mortes, RegistroDeMorte{VictimID: m.VictimID, KillerID: m.KillerID, Autogol: m.Autogol})
		}
		kills, autogols := TallyKills(mortes)
		compararContagem(t, i, "kills", caso.Kills, kills)
		compararContagem(t, i, "autogols", caso.SelfKills, autogols)
	}
}

func compararContagem(t *testing.T, caso int, oque string, ts, emGo map[string]int) {
	t.Helper()
	if len(ts) != len(emGo) {
		t.Errorf("caso %d, %s: %d chaves no TypeScript, %d no Go", caso, oque, len(ts), len(emGo))
	}
	for id, n := range ts {
		if emGo[id] != n {
			t.Errorf("caso %d, %s[%s]: go %d, ts %d", caso, oque, id, emGo[id], n)
		}
	}
}

func TestPontuacaoDaRodadaBateComOTypeScript(t *testing.T) {
	var v vetoresDeRodada
	lerVetores(t, "rodada.json", &v)

	for _, caso := range v.Escores {
		if obtido := RoundScore(caso.P, caso.K, caso.S); obtido != caso.Saida {
			t.Errorf("RoundScore(%d, %d, %d) = %d, o TypeScript diz %d", caso.P, caso.K, caso.S, obtido, caso.Saida)
		}
	}
}

func TestTitulosBatemComOTypeScript(t *testing.T) {
	var v vetoresDeRodada
	lerVetores(t, "rodada.json", &v)

	for i, caso := range v.Titulos {
		stats := make([]EstatisticaDeTitulo, 0, len(caso.Entrada))
		for _, e := range caso.Entrada {
			stats = append(stats, EstatisticaDeTitulo{
				PlayerID: e.PlayerID, SelfKills: e.SelfKills, ShotsFired: e.ShotsFired,
				ShotsHit: e.ShotsHit, AliveSeconds: e.AliveSeconds, KillCount: e.KillCount,
			})
		}
		obtido := ComputeMatchTitles(stats)
		compararTitulo(t, i, "kamikaze", caso.Saida.Kamikaze, obtido.Kamikaze)
		compararTitulo(t, i, "balaPerdida", caso.Saida.BalaPerdida, obtido.BalaPerdida)
		compararTitulo(t, i, "covardeEstrategico", caso.Saida.CovardeEstrategico, obtido.CovardeEstrategico)
	}
}

func compararTitulo(t *testing.T, caso int, oque string, ts, emGo *string) {
	t.Helper()
	if (ts == nil) != (emGo == nil) {
		t.Errorf("caso %d, %s: go %v, ts %v", caso, oque, textoOuNulo(emGo), textoOuNulo(ts))
		return
	}
	if ts != nil && *ts != *emGo {
		t.Errorf("caso %d, %s: go %q, ts %q", caso, oque, *emGo, *ts)
	}
}

func textoOuNulo(p *string) string {
	if p == nil {
		return "null"
	}
	return *p
}

// A morte súbita remove a MESMA parede nos dois lados: o cliente recebe só o índice e tem que
// apagar a mesma da própria cópia do labirinto, senão a previsão de bala diverge.
func TestMorteSubitaRemoveAMesmaParedeQueOTypeScript(t *testing.T) {
	var v vetoresDeRodada
	lerVetores(t, "rodada.json", &v)

	var labirinto *sim.Maze
	var seedAtual uint32
	for _, caso := range v.Paredes {
		if labirinto == nil || seedAtual != caso.Seed {
			seedAtual = caso.Seed
			labirinto = sim.MakeMaze(caso.Seed, 6, 16.0/9.0)
		}
		removida, ok := RemoveRandomInternalWall(labirinto, caso.Seed, caso.Tentativa)
		if caso.Index == nil {
			if ok {
				t.Errorf("seed %d tentativa %d: o TypeScript não removeu nada e o Go removeu %d",
					caso.Seed, caso.Tentativa, removida.Index)
			}
			continue
		}
		if !ok {
			t.Errorf("seed %d tentativa %d: o TypeScript removeu %d e o Go não removeu nada",
				caso.Seed, caso.Tentativa, *caso.Index)
			continue
		}
		if removida.Index != *caso.Index {
			t.Errorf("seed %d tentativa %d: go removeu %d, ts removeu %d",
				caso.Seed, caso.Tentativa, removida.Index, *caso.Index)
		}
	}
}

func TestMorteSubitaNuncaTiraParedeDeBorda(t *testing.T) {
	labirinto := sim.MakeMaze(7, 4, 16.0/9.0)
	bordas := make([]sim.Aabb, 4)
	copy(bordas, labirinto.Walls[:4])

	for tentativa := 1; tentativa <= 200; tentativa++ {
		if _, ok := RemoveRandomInternalWall(labirinto, 7, tentativa); !ok {
			break
		}
	}
	if len(labirinto.Walls) < 4 {
		t.Fatalf("sobraram %d paredes; as 4 de borda nunca deveriam sair", len(labirinto.Walls))
	}
	for i := range bordas {
		if labirinto.Walls[i] != bordas[i] {
			t.Errorf("a parede de borda %d foi trocada: %+v virou %+v", i, bordas[i], labirinto.Walls[i])
		}
	}
}
