package protocol

// Espelho da parte de `packages/protocol/src/powerups.ts` que a SIMULAÇÃO enxerga.
//
// O arquivo TypeScript tem muito mais (cores, nomes, agenda de nascimento, raio de coleta): isso
// é assunto de servidor e de render, não de física, e fica de fora até existir um servidor Go
// para precisar dele. O que está aqui é o que `sim.ts` lê e o que a comparação de paridade
// precisa conferir.
//
// Os quatro efeitos são ADITIVOS e têm "sem efeito" no valor ZERO — por isso a simulação nunca
// pergunta "tem power-up?": ela soma o bônus ao valor de tuning e segue.

// PowerupMaxRicocheteExtra é o teto do bônus de rebote que uma bala pode carregar. Serve só para
// dimensionar a folga do laço de reflexões por tick; o valor real de cada bala vem carimbado nela.
const PowerupMaxRicocheteExtra = 1

// PowerupValor é quanto cada efeito escreve no campo correspondente do tanque.
//
// Está aqui, e entra no dump de constantes, para que o arranjo de paridade DETECTE se o
// TypeScript reajustar um desses números sem o Go acompanhar. Um `turbo` de 0,35 de um lado e
// 0,40 do outro é exatamente o tipo de dessincronia que só apareceria em produção, como um
// tanque chegando meio corpo antes na tela de um jogador.
var PowerupValor = map[string]float64{
	"ricochete": 1,
	"municao":   1,
	"recarga":   0.5,
	"turbo":     0.35,
}

// TiposDePowerUp é a ordem canônica dos efeitos. Slice, e não as chaves do mapa: `range` sobre
// mapa em Go embaralha, e a ordem canônica é o que o saco de sorteio embaralha de propósito.
var TiposDePowerUp = [4]string{"ricochete", "municao", "recarga", "turbo"}
