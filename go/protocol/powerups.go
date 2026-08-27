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

// -------------------------------------------------------------------------------------------
// Nascimento — tudo em SEGUNDOS aqui; quem converte para tick é `AgendaDePowerUps`.
// -------------------------------------------------------------------------------------------

const (
	// PowerupPrimeiroS é a espera até o primeiro item da rodada.
	PowerupPrimeiroS = 4.0
	// PowerupIntervaloS é o ritmo dos nascimentos seguintes.
	PowerupIntervaloS = 6.0
	// PowerupJitterS é o jitter (±) sorteado do RNG semeado em cima do ritmo.
	PowerupJitterS = 1.0
	// PowerupVidaNoMapaS é quanto tempo o item espera por alguém antes de sumir sozinho.
	PowerupVidaNoMapaS = 11.0
	// PowerupMaxNoChao é o teto de itens no chão ao mesmo tempo.
	PowerupMaxNoChao = 3
	// PowerupRaio é o raio de colisão do item, em px.
	PowerupRaio = 15.0
	// PowerupQuedaS é quanto tempo o item passa no ar, de paraquedas, ANTES de tocar o chão. É uma
	// ANTECIPAÇÃO, não um atraso: ele aparece no céu em `nasceEmTick - PowerupQuedaS*TickHz` e pousa
	// exatamente em `nasceEmTick`, que continua sendo o tick em que ele fica pegável.
	PowerupQuedaS = 2.5
)

// PowerupDuracao é quanto tempo cada efeito dura, em segundos.
//
// Entra no dump de constantes pelo mesmo motivo de `PowerupValor`: uma duração reajustada de um
// lado só apareceria como um relógio de efeito desligando em ticks diferentes nas duas pontas.
var PowerupDuracao = map[string]float64{
	"ricochete": 9,
	"municao":   12,
	"recarga":   10,
	"turbo":     10,
}
