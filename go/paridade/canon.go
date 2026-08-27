// Package paridade define o cenário e a serialização canônica usados para provar que a
// simulação em Go e a em TypeScript produzem exatamente o mesmo resultado.
//
// A serialização é o coração da prova, e ela tem uma regra só: NADA de texto decimal para
// número. Todo float64 vai para o resumo criptográfico como os 8 bytes do seu padrão de bits
// IEEE-754. Comparar `-12.340000000000001` com `-12.34` exige escolher uma tolerância, e uma
// tolerância transforma "provei que é igual" em "achei que estava perto o bastante" — que é
// exatamente o erro que esta tarefa existe para não cometer.
package paridade

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"hash"
	"math"
	"strings"

	"crypto/sha256"
)

// Secao agrupa os registros por assunto, e cada assunto tem seu próprio resumo. É o que permite
// dizer "o labirinto bate, o que divergiu foi a trajetória" sem precisar abrir o dump inteiro.
type Secao int

const (
	SecMaze Secao = iota
	SecSpawns
	SecSim
	SecEventos
	// SecBots é a sequência de `Input` que a IA produz, tick a tick. Seção PRÓPRIA de propósito:
	// dois bots que chegam ao mesmo lugar por caminhos diferentes têm a mesma `simulacao` e
	// `bots` diferentes, e é a segunda que denuncia o porte errado.
	SecBots
	// SecPowerups é a agenda, a coleta, os relógios dos efeitos e os campos que a simulação lê.
	SecPowerups
	numSecoes
)

var nomesSecao = [numSecoes]string{"labirinto", "spawns", "simulacao", "eventos", "bots", "powerups"}

// NomeSecao devolve o rótulo legível de uma seção.
func NomeSecao(s Secao) string { return nomesSecao[s] }

// Sink recebe os registros do cenário. Duas implementações: uma resume em SHA-256 (varredura de
// 10.000 seeds) e outra escreve texto legível (diagnóstico de uma seed que divergiu).
type Sink interface {
	Registro(sec Secao, rotulo string, tokens ...any)
}

// --- resumo criptográfico ---

// Resumidor alimenta um SHA-256 por seção com os BYTES dos valores, nunca com sua representação
// decimal.
type Resumidor struct {
	h [numSecoes]hash.Hash
	b [8]byte
}

func NovoResumidor() *Resumidor {
	r := &Resumidor{}
	for i := range r.h {
		r.h[i] = sha256.New()
	}
	return r
}

func (r *Resumidor) Registro(sec Secao, rotulo string, tokens ...any) {
	h := r.h[sec]
	r.escreverString(h, rotulo)
	for _, tk := range tokens {
		switch v := tk.(type) {
		case float64:
			binary.LittleEndian.PutUint64(r.b[:], math.Float64bits(v))
			h.Write(r.b[:])
		case int:
			binary.LittleEndian.PutUint64(r.b[:], uint64(int64(v)))
			h.Write(r.b[:])
		case string:
			r.escreverString(h, v)
		case bool:
			if v {
				h.Write([]byte{1})
			} else {
				h.Write([]byte{0})
			}
		default:
			panic(fmt.Sprintf("token de tipo não suportado: %T", tk))
		}
	}
	h.Write([]byte{0x1e}) // separador de registro
}

func (r *Resumidor) escreverString(h hash.Hash, s string) {
	h.Write([]byte(s))
	h.Write([]byte{0})
}

// Resumos devolve os quatro resumos em hexadecimal, na ordem das seções.
func (r *Resumidor) Resumos() [numSecoes]string {
	var out [numSecoes]string
	for i, h := range r.h {
		out[i] = hex.EncodeToString(h.Sum(nil))
	}
	return out
}

// --- dump legível ---

// Detalhador escreve uma linha de texto por registro. Os floats saem em hexadecimal E em decimal:
// o hexadecimal é o que decide se são iguais, o decimal é para um humano entender o que quebrou.
type Detalhador struct {
	sb strings.Builder
}

func NovoDetalhador() *Detalhador { return &Detalhador{} }

func (d *Detalhador) Registro(sec Secao, rotulo string, tokens ...any) {
	d.sb.WriteString(nomesSecao[sec])
	d.sb.WriteByte(' ')
	d.sb.WriteString(rotulo)
	for _, tk := range tokens {
		d.sb.WriteByte(' ')
		switch v := tk.(type) {
		case float64:
			fmt.Fprintf(&d.sb, "%016x", math.Float64bits(v))
		case int:
			fmt.Fprintf(&d.sb, "%d", v)
		case string:
			d.sb.WriteString(v)
		case bool:
			if v {
				d.sb.WriteByte('1')
			} else {
				d.sb.WriteByte('0')
			}
		default:
			panic(fmt.Sprintf("token de tipo não suportado: %T", tk))
		}
	}
	d.sb.WriteByte('\n')
}

func (d *Detalhador) Texto() string { return d.sb.String() }
