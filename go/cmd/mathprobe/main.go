// mathprobe imprime o resultado das funções de `internal/jsmath` em padrão de bits, para ser
// comparado com a saída do V8 produzida por `go/ts/mathprobe.mjs`.
//
// Entrada: uma linha por caso, com dois float64 em hexadecimal (`x y`).
// Saída: uma linha por caso, com os bits de sin/cos/log/atan/atan2/hypot/round.
//
// A comparação byte a byte é feita por `go/compare.mjs`, etapa "math".
package main

import (
	"bufio"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"

	"github.com/simplex/tank/go/internal/jsmath"
)

func main() {
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1<<20), 1<<20)
	out := bufio.NewWriterSize(os.Stdout, 1<<20)
	defer out.Flush()

	for in.Scan() {
		campos := strings.Fields(in.Text())
		if len(campos) != 2 {
			continue
		}
		x := paraFloat(campos[0])
		y := paraFloat(campos[1])
		fmt.Fprintf(out, "%016x %016x %016x %016x %016x %016x %016x\n",
			math.Float64bits(jsmath.Sin(x)),
			math.Float64bits(jsmath.Cos(x)),
			math.Float64bits(jsmath.Log(math.Abs(x)+1)),
			math.Float64bits(jsmath.Atan(x)),
			math.Float64bits(jsmath.Atan2(x, y)),
			math.Float64bits(jsmath.Hypot(x, y)),
			math.Float64bits(jsmath.Round(x)))
	}
}

func paraFloat(hex string) float64 {
	bits, err := strconv.ParseUint(hex, 16, 64)
	if err != nil {
		panic(err)
	}
	return math.Float64frombits(bits)
}
