// Package server é o servidor de jogo do Tank Ricochete em Go: transporte WebSocket cru, salas,
// ciclo de partida e o serviço dos arquivos estáticos do cliente, tudo na mesma porta.
//
// Ele SUBSTITUI `apps/server/` (Colyseus). A simulação continua sendo `go/sim`, que tem paridade
// bit a bit provada com `packages/shared-sim` — nada aqui recalcula física.
package server

// Espelho da parte de `packages/protocol/` que o SERVIDOR precisa e que `go/protocol` não carrega.
//
// `go/protocol` foi escrito para a prova de paridade e por isso guarda só o que a SIMULAÇÃO lê
// (tuning e valores de power-up). Cores, animais, nomes de teste, alfabeto do código de sala e
// nomes de canal são assunto de rede e de sala, e moram aqui — mas continuam sendo CÓPIA: a fonte
// da verdade é o TypeScript, e `TestEspelhoDoProtocolo` confere valor a valor contra ele.

// VagasPorSala espelha `VAGAS_POR_SALA`.
const VagasPorSala = 10

// MaxClientes é o teto de conexões numa sala: 10 jogadores + espectadores.
const MaxClientes = 24

// RotaSalas espelha `ROTA_SALAS`.
const RotaSalas = "/salas"

// CoresDeJogador espelha `PLAYER_COLORS`.
var CoresDeJogador = []int{
	0xff2e63, 0xff7a1a, 0xffd400, 0x5ceb3f, 0x00f0c8,
	0x2ec6ff, 0x7d8cff, 0xc05cff, 0xff4fd8, 0xe9eef8,
}

// NomesDeTeste espelha `TEST_PLAYER_NAMES`.
var NomesDeTeste = []string{
	"Ana", "Bruno", "Carla", "Diego", "Elisa",
	"Fábio", "Gabi", "Hugo", "Ítalo", "Júlia",
}

// AnimaisDeJogador espelha `PLAYER_ANIMALS` — mesma ordem de `CoresDeJogador`, índice a índice.
var AnimaisDeJogador = []string{
	"caranguejo", "tigre", "aguia", "cobra", "tubarao",
	"coruja", "lobo", "touro", "raposa", "urso",
}

// NomeDoAnimal espelha `ANIMAL_NOME` — o rótulo em pt-BR que aparece no lobby e no placar.
var NomeDoAnimal = map[string]string{
	"caranguejo": "Caranguejo",
	"tigre":      "Tigre",
	"aguia":      "Águia",
	"cobra":      "Cobra",
	"tubarao":    "Tubarão",
	"coruja":     "Coruja",
	"lobo":       "Lobo",
	"touro":      "Touro",
	"raposa":     "Raposa",
	"urso":       "Urso",
}

// AnimalDaCor espelha `animalDaCor`: cor fora da paleta cai no primeiro animal, como no TypeScript.
func AnimalDaCor(cor int) string {
	for i, c := range CoresDeJogador {
		if c == cor {
			return AnimaisDeJogador[i]
		}
	}
	return AnimaisDeJogador[0]
}

// AlfabetoDoCodigo espelha `ROOM_CODE_ALPHABET` — sem I, O, 0 nem 1.
const AlfabetoDoCodigo = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// TamanhoDoCodigo espelha `ROOM_CODE_LENGTH`.
const TamanhoDoCodigo = 4

// Nomes de canal — espelho de `MessageType`. Servidor e cliente nunca escrevem a string à mão.
const (
	MsgEntrar     = "entrar"
	MsgEntrou     = "entrou"
	MsgErro       = "erro"
	MsgSair       = "sair"
	MsgSaiu       = "saiu"
	MsgEstado     = "state"
	MsgInput      = "input"
	MsgReady      = "ready"
	MsgPickColor  = "pick_color"
	MsgAddBot     = "add_bot"
	MsgRemoveBot  = "remove_bot"
	MsgRematch    = "rematch"
	MsgConfig     = "config"
	MsgViewport   = "viewport"
	MsgBulletSpwn = "bullet_spawn"
	MsgBulletDead = "bullet_dead"
	MsgTankDeath  = "tank_death"
	MsgRoundStart = "round_start"
	MsgRoundEnd   = "round_end"
	MsgSuddenWall = "sudden_death_wall"
	MsgPowerTaken = "powerup_taken"
	MsgPowerExpir = "powerup_expired"
	MsgGameOver   = "game_over"
)

// DuracaoDePowerUp espelha `POWERUP[tipo].duracao` — o HUD monta o contador a partir daqui.
var DuracaoDePowerUp = map[string]float64{
	"ricochete": 9,
	"municao":   12,
	"recarga":   10,
	"turbo":     10,
}
