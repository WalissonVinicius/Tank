package server

import (
	"encoding/binary"
	"math"

	"github.com/simplex/tank/go/internal/jsmath"
	"github.com/simplex/tank/go/protocol"
	"github.com/simplex/tank/go/sim"
)

// Porte de `apps/server/src/net/snapshot.ts` e `apps/server/src/net/input.ts`.
//
// O formato do snapshot NÃO mudou com a troca de transporte: é o mesmo quadro binário de 8 bytes
// por tanque que o cliente já sabia decodificar. Ele viaja agora como frame binário do WebSocket
// em vez de `broadcastBytes` do Colyseus, e é o ÚNICO frame binário do protocolo — o cliente
// distingue quente de frio pelo tipo do frame, sem cabeçalho.

const bytesPorTanque = 8

// SnapshotTank é uma linha do snapshot.
type SnapshotTank struct {
	Slot      int
	X         float64
	Y         float64
	Heading   float64
	Turret    float64
	Alive     bool
	Connected bool
}

const doisPi = 2 * math.Pi

// quantizaAngulo espelha `quantizeAngle`: 0..2π em 1 byte.
//
// `jsmath.Round` e não `math.Round`: o JavaScript arredonda `.5` para CIMA e o Go arredonda para
// LONGE DO ZERO. O ângulo aqui é sempre positivo, então na prática coincidem — mas usar o do Go
// abriria a porta para a divergência voltar no dia em que alguém alimentar um ângulo negativo.
func quantizaAngulo(rad float64) uint8 {
	n := jsmath.Mod(rad, doisPi)
	if n < 0 {
		n += doisPi
	}
	return uint8(int(jsmath.Round((n/doisPi)*255)) & 0xff)
}

// EncodeSnapshot devolve o quadro binário de posições. Espelho exato de `encodeSnapshot`.
func EncodeSnapshot(tanks []SnapshotTank) []byte {
	buf := make([]byte, 1+len(tanks)*bytesPorTanque)
	buf[0] = byte(len(tanks))

	off := 1
	for _, t := range tanks {
		buf[off] = byte(t.Slot)
		binary.LittleEndian.PutUint16(buf[off+1:], uint16(int16(jsmath.Round(t.X))))
		binary.LittleEndian.PutUint16(buf[off+3:], uint16(int16(jsmath.Round(t.Y))))
		buf[off+5] = quantizaAngulo(t.Heading)
		buf[off+6] = quantizaAngulo(t.Turret)
		var flags byte
		if t.Alive {
			flags |= 0b01
		}
		if t.Connected {
			flags |= 0b10
		}
		buf[off+7] = flags
		off += bytesPorTanque
	}
	return buf
}

// Bits do canal `input` — espelho de `INPUT_BIT`.
const (
	bitCima     = 0x01
	bitBaixo    = 0x02
	bitEsquerda = 0x04
	bitDireita  = 0x08
	bitAtirar   = 0x10
)

// DecodeAim espelha `decodeAim`: 0..255 → 0..2π.
func DecodeAim(b int) float64 {
	return (float64(b&0xff) / 255) * doisPi
}

// DecodeInputBits traduz o bitfield da rede no `Input` da simulação.
//
// A direção do movimento sai de `protocol.DirecaoDeMovimento`, a MESMA função que o cliente usa
// nas próprias teclas — duas cópias dessa conta divergiriam no primeiro ajuste, e divergir aqui é
// o tanque andando para um lado no servidor e para outro na tela.
//
// `temAim == false` (cliente antigo ou pacote sem o campo) deixa a torre parada em vez de
// fabricar um ângulo que a outra ponta não conhece.
func DecodeInputBits(bits int, aim int, temAim bool) sim.Input {
	mover, ativo := protocol.DirecaoDeMovimento(
		bits&bitCima != 0,
		bits&bitBaixo != 0,
		bits&bitEsquerda != 0,
		bits&bitDireita != 0,
	)
	in := sim.Input{Mover: mover, MoverAtivo: ativo, Fire: bits&bitAtirar != 0}
	if temAim {
		in.Aim = DecodeAim(aim)
		in.AimAtivo = true
	}
	return in
}
