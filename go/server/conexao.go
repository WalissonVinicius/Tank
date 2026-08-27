package server

import (
	"context"
	"encoding/json"
	"time"

	"github.com/coder/websocket"
)

// Transporte: uma conexão WebSocket crua por cliente.
//
// Por que `github.com/coder/websocket` (o antigo `nhooyr.io/websocket`) e não `gorilla/websocket`:
// ele é o único dos dois com API baseada em `context.Context`, o que faz o encerramento com
// prazo (`CloseNow`, escrita com timeout) sair de graça em vez de virar um `SetWriteDeadline`
// manual em cada ponto; ele fala `net.Conn` padrão sem hijack; e o `Close` dele já manda o quadro
// de fechamento com código e motivo, que é justamente o que separa SAÍDA CONSENTIDA de QUEDA
// neste jogo. `gorilla` é maduro e serviria, mas custaria mais código para a mesma coisa.
//
// O quadro de saída carrega o tipo junto porque o protocolo é misto de propósito: estado frio e
// eventos vão em TEXTO (JSON, legível no DevTools de qualquer navegador) e o snapshot de posições
// vai em BINÁRIO (8 bytes por tanque). O cliente separa um do outro pelo tipo do frame, sem
// cabeçalho nenhum.
type quadro struct {
	tipo  websocket.MessageType
	dados []byte
}

// Envelope é a forma de toda mensagem de texto: `{"t": canal, "d": corpo}`.
type Envelope struct {
	T string          `json:"t"`
	D json.RawMessage `json:"d,omitempty"`
}

// Cliente é uma conexão viva. Só a goroutine de escrita toca no socket para escrever; a sala fala
// com ele exclusivamente por `saida`, que nunca bloqueia o laço da sala (ver `enviar`).
type Cliente struct {
	sessionID string
	token     string
	conn      *websocket.Conn
	saida     chan quadro
	fechado   chan struct{}
	// espectador só afeta o que a sala faz com ele; o transporte é o mesmo.
	nome     string
	deviceID string
}

// tamanhoDaFila é a folga de saída por cliente. Um cliente que não consome (aba congelada, rede
// entupida) enche a fila e é DESCONECTADO em vez de segurar o laço da sala — 128 quadros são
// ~6 s de snapshot a 20 Hz, tempo de sobra para uma rede ruim se recuperar.
const tamanhoDaFila = 128

func novoCliente(sessionID, token string, conn *websocket.Conn) *Cliente {
	return &Cliente{
		sessionID: sessionID,
		token:     token,
		conn:      conn,
		saida:     make(chan quadro, tamanhoDaFila),
		fechado:   make(chan struct{}),
	}
}

// enviar enfileira um quadro. Devolve `false` quando a fila estourou ou o cliente já morreu —
// quem chama (a sala) usa isso para derrubar a conexão sem nunca bloquear no meio de um tick.
func (c *Cliente) enviar(q quadro) bool {
	select {
	case <-c.fechado:
		return false
	default:
	}
	select {
	case c.saida <- q:
		return true
	default:
		return false
	}
}

// enviarJSON monta o envelope e enfileira. `corpo` nil vira mensagem sem `d` (é o caso dos canais
// que não levam corpo, como `rematch`).
func (c *Cliente) enviarJSON(canal string, corpo any) bool {
	dados, err := montarEnvelope(canal, corpo)
	if err != nil {
		return false
	}
	return c.enviar(quadro{tipo: websocket.MessageText, dados: dados})
}

func montarEnvelope(canal string, corpo any) ([]byte, error) {
	env := Envelope{T: canal}
	if corpo != nil {
		bruto, err := json.Marshal(corpo)
		if err != nil {
			return nil, err
		}
		env.D = bruto
	}
	return json.Marshal(env)
}

// escrever é a goroutine de saída. Ela é a ÚNICA que escreve no socket: o WebSocket não aceita
// duas escritas concorrentes, e centralizar aqui evita ter que serializar com mutex a cada
// broadcast.
func (c *Cliente) escrever(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.fechado:
			return
		case q := <-c.saida:
			prazo, cancelar := context.WithTimeout(ctx, 5*time.Second)
			err := c.conn.Write(prazo, q.tipo, q.dados)
			cancelar()
			if err != nil {
				return
			}
		}
	}
}

// encerrar fecha a conexão. `motivo` vazio com `consentida` verdadeira usa o código 1000, que é
// o que o cliente lê como "saí de propósito" e por isso NÃO tenta reconectar.
func (c *Cliente) encerrar(consentida bool, motivo string) {
	select {
	case <-c.fechado:
		return
	default:
	}
	close(c.fechado)
	// `conn` nulo é o cliente sem socket que os testes de sala usam: eles exercitam entrada, saída
	// e queda sem subir um servidor HTTP.
	if c.conn == nil {
		return
	}
	codigo := websocket.StatusGoingAway
	if consentida {
		codigo = websocket.StatusNormalClosure
	}
	_ = c.conn.Close(codigo, motivo)
}
