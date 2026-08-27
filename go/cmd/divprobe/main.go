package main

// Prova a divergência entre o math NATIVO do Go e o jsmath (fdlibm, a mesma linhagem do V8).
// Se a diferença fosse desprezível, o porte do fdlibm não precisaria existir.
import (
	"fmt"
	"math"

	"github.com/simplex/tank/go/internal/jsmath"
)

func main() {
	const N = 200000
	difSin, difCos := 0, 0
	for i := 0; i < N; i++ {
		a := (float64(i)/N)*20*math.Pi - 10*math.Pi
		if math.Float64bits(math.Sin(a)) != math.Float64bits(jsmath.Sin(a)) {
			difSin++
		}
		if math.Float64bits(math.Cos(a)) != math.Float64bits(jsmath.Cos(a)) {
			difCos++
		}
	}
	fmt.Printf("sin: %d de %d ângulos divergem (%.1f%%)\n", difSin, N, 100*float64(difSin)/N)
	fmt.Printf("cos: %d de %d ângulos divergem (%.1f%%)\n", difCos, N, 100*float64(difCos)/N)
}
