// paridade roda o cenário de comparação do lado Go.
//
//	-modo resumo   (padrão) uma linha por seed: `<seed> <labirinto> <spawns> <simulacao> <eventos>`
//	-modo detalhe  o dump completo de UMA seed, um registro por linha
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
	"sync"

	"github.com/simplex/tank/go/paridade"
)

func main() {
	modo := flag.String("modo", "resumo", "resumo | detalhe")
	de := flag.Uint("de", 0, "primeira seed (inclusive)")
	ate := flag.Uint("ate", 1000, "última seed (exclusive)")
	seed := flag.Uint("seed", 0, "seed única, para o modo detalhe")
	ticks := flag.Int("ticks", paridade.TicksPadrao, "ticks simulados por seed")
	flag.Parse()

	out := bufio.NewWriterSize(os.Stdout, 1<<20)
	defer out.Flush()

	if *modo == "detalhe" {
		d := paridade.NovoDetalhador()
		paridade.Executar(uint32(*seed), *ticks, d)
		out.WriteString(d.Texto())
		return
	}

	if *modo == "constantes" {
		d := paridade.NovoDetalhador()
		paridade.Constantes(d)
		paridade.DirecoesDeMovimento(d)
		out.WriteString(d.Texto())
		return
	}

	total := int(*ate) - int(*de)
	if total <= 0 {
		fmt.Fprintln(os.Stderr, "faixa de seeds vazia")
		os.Exit(2)
	}

	linhas := make([]string, total)
	trabalhadores := runtime.GOMAXPROCS(0)
	proxima := make(chan int, trabalhadores*4)
	var wg sync.WaitGroup

	// Cada seed é uma simulação independente e o pacote `sim` não guarda estado global (todos os
	// buffers reaproveitados vivem dentro do SimState), então paralelizar aqui não muda nenhum
	// resultado — só o tempo de parede.
	for w := 0; w < trabalhadores; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range proxima {
				s := uint32(int(*de) + i)
				r := paridade.NovoResumidor()
				paridade.Executar(s, *ticks, r)
				res := r.Resumos()
				linhas[i] = fmt.Sprintf("%d %s %s %s %s", s, res[0], res[1], res[2], res[3])
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
}
