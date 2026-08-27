package protocol

import "github.com/simplex/tank/go/internal/jsmath"

// DirecaoDeMovimento espelha a função de mesmo nome em `packages/protocol/src/messages.ts`: é o
// único lugar onde as quatro teclas de direção viram uma direção de MUNDO em radianos.
//
// Devolve `(ângulo, true)` ou `(0, false)` quando nenhuma tecla está pressionada — o `null` do
// TypeScript.
//
// O `atan2` aqui recebe só nove combinações de (dx, dy) em {-1, 0, 1}, mas mesmo assim usa
// `jsmath.Atan2` e não o `math.Atan2` do Go: com dx e dy ambos não nulos o resultado é ±π/4 ou
// ±3π/4, e as duas bibliotecas discordam no último bit em parte desses casos. Um bit de
// diferença no ângulo vira um bit de diferença em `cos`/`sin`, que vira posição diferente do
// tanque, que vira uma bala passando raspando de um lado e acertando do outro.
func DirecaoDeMovimento(up, down, left, right bool) (float64, bool) {
	dx := 0.0
	if right {
		dx += 1
	}
	if left {
		dx -= 1
	}
	dy := 0.0
	if down {
		dy += 1
	}
	if up {
		dy -= 1
	}
	if dx == 0 && dy == 0 {
		return 0, false
	}
	return jsmath.Atan2(dy, dx), true
}
