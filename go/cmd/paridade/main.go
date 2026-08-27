// paridade roda os cenários de comparação do lado Go.
//
//	-modo resumo     (padrão) uma linha por seed: `<seed> <resumo> <resumo> ...`, mais uma linha
//	                 final `#cobertura ...` com o que a varredura realmente exercitou
//	-modo detalhe    o dump completo de UMA seed, um registro por linha
//	-modo constantes a tabela de tuning inteira
//
//	-cenario partida   labirinto + spawns + 300 ticks de partida roteirizada
//	-cenario bots      partida dirigida pela IA; compara a sequência de `Input` tick a tick
//	-cenario powerups  rodada com a camada de power-ups ligada: agenda, coleta, efeitos
//
// A saída do modo resumo é comparável linha a linha com a de `go/ts/paridade.mjs`; a do modo
// detalhe é comparável com `diff`, e é ela que responde "em que tick e com que valores divergiu".
package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"

	"github.com/simplex/tank/go/paridade"
)

// executor é um cenário: roda uma seed, despeja no sink e devolve o que exercitou.
type executor func(seed uint32, ticks int, s paridade.Sink) paridade.Cobertura

// cenario amarra o nome do cenário ao executor, ao número de ticks padrão e às seções que entram
// na linha de resumo. Seções diferentes por cenário é o que permite dizer "os inputs bateram, o
// que divergiu foi a trajetória" sem abrir o dump.
type cenario struct {
	executar executor
	ticks    int
	secoes   []paridade.Secao
}

func cenarios() map[string]cenario {
	return map[string]cenario{
		"partida": {
			executar: func(seed uint32, ticks int, s paridade.Sink) paridade.Cobertura {
				paridade.Executar(seed, ticks, s)
				return paridade.Cobertura{Seeds: 1}
			},
			ticks:  paridade.TicksPadrao,
			secoes: []paridade.Secao{paridade.SecMaze, paridade.SecSpawns, paridade.SecSim, paridade.SecEventos},
		},
		"bots": {
			executar: paridade.ExecutarBots,
			ticks:    paridade.TicksBotsPadrao,
			secoes:   []paridade.Secao{paridade.SecBots, paridade.SecSim, paridade.SecEventos},
		},
		"powerups": {
			executar: paridade.ExecutarPowerups,
			ticks:    paridade.TicksPowerupsPadrao,
			secoes:   []paridade.Secao{paridade.SecPowerups, paridade.SecSim, paridade.SecEventos},
		},
	}
}

func main() {
	modo := flag.String("modo", "resumo", "resumo | detalhe | constantes")
	nomeCenario := flag.String("cenario", "partida", "partida | bots | powerups")
	de := flag.Uint("de", 0, "primeira seed (inclusive)")
	ate := flag.Uint("ate", 1000, "última seed (exclusive)")
	seed := flag.Uint("seed", 0, "seed única, para o modo detalhe")
	ticks := flag.Int("ticks", 0, "ticks simulados por seed (0 = o padrão do cenário)")
	flag.Parse()

	out := bufio.NewWriterSize(os.Stdout, 1<<20)
	defer out.Flush()

	if *modo == "constantes" {
		d := paridade.NovoDetalhador()
		paridade.Constantes(d)
		paridade.DirecoesDeMovimento(d)
		out.WriteString(d.Texto())
		return
	}

	cen, ok := cenarios()[*nomeCenario]
	if !ok {
		fmt.Fprintf(os.Stderr, "cenário desconhecido: %s\n", *nomeCenario)
		os.Exit(2)
	}
	if *ticks <= 0 {
		*ticks = cen.ticks
	}

	if *modo == "detalhe" {
		d := paridade.NovoDetalhador()
		cen.executar(uint32(*seed), *ticks, d)
		out.WriteString(d.Texto())
		return
	}

	total := int(*ate) - int(*de)
	if total <= 0 {
		fmt.Fprintln(os.Stderr, "faixa de seeds vazia")
		os.Exit(2)
	}

	linhas := make([]string, total)
	coberturas := make([]paridade.Cobertura, total)
	trabalhadores := runtime.GOMAXPROCS(0)
	proxima := make(chan int, trabalhadores*4)
	var wg sync.WaitGroup

	// Cada seed é uma simulação independente e nem `sim` nem `powerups` guardam estado de pacote
	// (todos os buffers reaproveitados vivem dentro do SimState, do BotMemos ou do Campo), então
	// paralelizar aqui não muda nenhum resultado — só o tempo de parede.
	for w := 0; w < trabalhadores; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range proxima {
				s := uint32(int(*de) + i)
				r := paridade.NovoResumidor()
				coberturas[i] = cen.executar(s, *ticks, r)
				res := r.Resumos()
				partes := make([]string, 0, len(cen.secoes)+1)
				partes = append(partes, fmt.Sprintf("%d", s))
				for _, sec := range cen.secoes {
					partes = append(partes, res[sec])
				}
				linhas[i] = strings.Join(partes, " ")
			}
		}()
	}
	for i := 0; i < total; i++ {
		proxima <- i
	}
	close(proxima)
	wg.Wait()

	for _, l := range linhas {
		out.WriteString(l)
		out.WriteByte('\n')
	}

	// A última linha não é um resumo: é o que a varredura REALMENTE exercitou. Um relatório que só
	// sabe dizer "10.000/10.000 bateram" não distingue "provei" de "os dois lados não fizeram
	// nada", e é o `compare.mjs` que transforma isto em número no relatório final.
	var soma paridade.Cobertura
	for _, c := range coberturas {
		soma.Somar(c)
	}
	fmt.Fprintf(out, "#cobertura seeds %d seeds_com_disparo %d seeds_com_morte %d seeds_com_coleta %d"+
		" disparos %d disparos_carimbados %d mortes %d coletas %d fins_de_efeito %d\n",
		soma.Seeds, soma.SeedsComDisparo, soma.SeedsComMorte, soma.SeedsComColeta,
		soma.Disparos, soma.DisparosCarimbados, soma.Mortes, soma.Coletas, soma.FinsDeEfeito)
}
