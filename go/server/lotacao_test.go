package server

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Teto de conexões por sala: 10 jogadores mais espectadores, `MaxClientes` no total.
//
// O Colyseus aplicava isso sozinho (`maxClients`); com WebSocket cru é responsabilidade nossa. Sem
// ele uma sala popular acumularia plateia até a fila de saída de cada broadcast virar o gargalo do
// tick — e o `Entrar` recusa DENTRO da goroutine da sala, antes de o `entrou` ser enfileirado,
// para que ninguém receba "você entrou" seguido de um socket fechado.
func TestSalaRecusaAlemDoTetoDeConexoes(t *testing.T) {
	_, base := subirServidor(t)
	dono := conectar(t, base, map[string]any{"modo": "criar", "nome": "Ana", "deviceId": "d0"})
	dono.estado()

	// Enche até o teto. Do 11º em diante entram como espectadores, o que é esperado.
	for i := 1; i < MaxClientes; i++ {
		c := conectar(t, base, map[string]any{
			"modo": "codigo", "codigo": dono.sala, "nome": "Gente", "deviceId": "d" + itoa(i),
		})
		c.estado()
	}

	// O próximo tem que ser recusado COM MOTIVO, e não aceito e derrubado em seguida.
	ctx, cancelar := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelar()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+"/ws", nil)
	if err != nil {
		t.Fatalf("não consegui abrir o socket: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()

	dados, _ := montarEnvelope(MsgEntrar, map[string]any{"modo": "codigo", "codigo": dono.sala, "nome": "Tarde"})
	if err := conn.Write(ctx, websocket.MessageText, dados); err != nil {
		t.Fatalf("não consegui escrever: %v", err)
	}

	_, resposta, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("esperava uma recusa legível, o socket morreu: %v", err)
	}
	var env Envelope
	if err := json.Unmarshal(resposta, &env); err != nil {
		t.Fatalf("resposta ilegível: %s", resposta)
	}
	if env.T != MsgErro {
		t.Fatalf("esperava o canal `erro`, veio %q com %s", env.T, env.D)
	}
	if !strings.Contains(string(env.D), "cheia") {
		t.Errorf("o motivo não explica a lotação: %s", env.D)
	}
}
