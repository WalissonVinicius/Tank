package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Transporte de ponta a ponta: servidor HTTP de verdade, WebSocket de verdade, dois clientes.
//
// É o teste que o `_e2e.cjs` faz pelo navegador, reduzido ao que é do SERVIDOR: criar sala pelo
// socket, entrar por código, ver o estado frio chegar, aparecer na lista de salas abertas e
// retomar o assento com o token.

type clienteDeTeste struct {
	t     *testing.T
	conn  *websocket.Conn
	ctx   context.Context
	sala  string
	sess  string
	token string
}

func subirServidor(t *testing.T) (*Servidor, string) {
	t.Helper()
	srv := NovoServidor(Opcoes{})
	http := httptest.NewServer(srv.Handler())
	t.Cleanup(http.Close)
	return srv, http.URL
}

func conectar(t *testing.T, base string, pedido map[string]any) *clienteDeTeste {
	t.Helper()
	ctx, cancelar := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancelar)

	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+"/ws", nil)
	if err != nil {
		t.Fatalf("não consegui abrir o socket: %v", err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })

	c := &clienteDeTeste{t: t, conn: conn, ctx: ctx}
	c.mandar(MsgEntrar, pedido)

	canal, corpo := c.esperar(MsgEntrou, MsgErro)
	if canal == MsgErro {
		t.Fatalf("entrada recusada: %s", corpo)
	}
	var entrou struct {
		RoomID    string `json:"roomId"`
		SessionID string `json:"sessionId"`
		Token     string `json:"token"`
	}
	if err := json.Unmarshal(corpo, &entrou); err != nil {
		t.Fatalf("`entrou` ilegível: %v", err)
	}
	c.sala, c.sess, c.token = entrou.RoomID, entrou.SessionID, entrou.Token
	return c
}

func (c *clienteDeTeste) mandar(canal string, corpo any) {
	c.t.Helper()
	dados, err := montarEnvelope(canal, corpo)
	if err != nil {
		c.t.Fatalf("envelope inválido: %v", err)
	}
	if err := c.conn.Write(c.ctx, websocket.MessageText, dados); err != nil {
		c.t.Fatalf("não consegui escrever: %v", err)
	}
}

// esperar lê até chegar um dos canais pedidos, ignorando o resto (snapshot binário incluído).
func (c *clienteDeTeste) esperar(canais ...string) (string, json.RawMessage) {
	c.t.Helper()
	prazo, cancelar := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancelar()

	quero := map[string]bool{}
	for _, canal := range canais {
		quero[canal] = true
	}
	for {
		tipo, dados, err := c.conn.Read(prazo)
		if err != nil {
			c.t.Fatalf("esperando %v: %v", canais, err)
		}
		if tipo != websocket.MessageText {
			continue
		}
		var env Envelope
		if err := json.Unmarshal(dados, &env); err != nil {
			continue
		}
		if quero[env.T] {
			return env.T, env.D
		}
	}
}

func (c *clienteDeTeste) estado() EstadoDaSala {
	c.t.Helper()
	_, corpo := c.esperar(MsgEstado)
	var e EstadoDaSala
	if err := json.Unmarshal(corpo, &e); err != nil {
		c.t.Fatalf("estado frio ilegível: %v", err)
	}
	return e
}

func TestCriarSalaEEntrarPeloCodigo(t *testing.T) {
	srv, base := subirServidor(t)

	dono := conectar(t, base, map[string]any{"modo": "criar", "nome": "Ana", "deviceId": "d1", "bots": 1})
	if len(dono.sala) != TamanhoDoCodigo {
		t.Fatalf("o código da sala tem %d caracteres: %q", len(dono.sala), dono.sala)
	}
	if dono.token == "" {
		t.Fatal("sem token não há reconexão possível")
	}

	estado := dono.estado()
	if estado.Phase != FaseLobby {
		t.Errorf("sala nova deveria estar em lobby, está em %s", estado.Phase)
	}
	if len(estado.Players) != 2 {
		t.Fatalf("esperava dono + 1 bot, achei %d", len(estado.Players))
	}
	if estado.OwnerID != dono.sess {
		t.Errorf("o dono deveria ser quem criou (%s), é %s", dono.sess, estado.OwnerID)
	}

	// Entrar pelo código, em minúsculas e com espaço — o servidor normaliza como o campo do lobby.
	convidado := conectar(t, base, map[string]any{
		"modo": "codigo", "codigo": " " + strings.ToLower(dono.sala) + " ", "nome": "Bruno", "deviceId": "d2",
	})
	if convidado.sala != dono.sala {
		t.Fatalf("o convidado entrou em %q e o dono está em %q", convidado.sala, dono.sala)
	}

	estado = convidado.estado()
	for len(estado.Players) < 3 {
		estado = convidado.estado()
	}

	if srv.Hub().Quantidade() != 1 {
		t.Errorf("esperava 1 sala viva, achei %d", srv.Hub().Quantidade())
	}
}

func TestCodigoInexistenteERecusadoComMotivo(t *testing.T) {
	_, base := subirServidor(t)

	ctx, cancelar := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelar()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+"/ws", nil)
	if err != nil {
		t.Fatalf("não consegui abrir o socket: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()

	dados, _ := montarEnvelope(MsgEntrar, map[string]any{"modo": "codigo", "codigo": "ZZZZ", "nome": "Ana"})
	if err := conn.Write(ctx, websocket.MessageText, dados); err != nil {
		t.Fatalf("não consegui escrever: %v", err)
	}

	_, resposta, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("esperava um erro legível, o socket morreu: %v", err)
	}
	var env Envelope
	if err := json.Unmarshal(resposta, &env); err != nil || env.T != MsgErro {
		t.Fatalf("esperava o canal `erro`, veio %q", string(resposta))
	}
	// O motivo é o que a tela de entrada usa para explicar; sem ele o jogador só vê a tela travar.
	if !strings.Contains(string(env.D), "sala") {
		t.Errorf("o motivo não menciona a sala: %s", env.D)
	}
}

func TestListaDeSalasAbertasMostraASalaCriada(t *testing.T) {
	_, base := subirServidor(t)
	dono := conectar(t, base, map[string]any{"modo": "criar", "nome": "Ana", "deviceId": "d1"})
	dono.estado()

	resp, err := http.Get(base + RotaSalas)
	if err != nil {
		t.Fatalf("não consegui consultar a lista: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if cache := resp.Header.Get("Cache-Control"); cache != "no-store" {
		t.Errorf("a lista não pode ser cacheada (a tela repergunta a cada 3 s); veio %q", cache)
	}

	var corpo struct {
		Salas []SalaAberta `json:"salas"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&corpo); err != nil {
		t.Fatalf("lista ilegível: %v", err)
	}
	if len(corpo.Salas) != 1 {
		t.Fatalf("esperava 1 sala aberta, achei %d", len(corpo.Salas))
	}
	sala := corpo.Salas[0]
	if sala.Codigo != dono.sala {
		t.Errorf("a lista mostra %q e a sala é %q", sala.Codigo, dono.sala)
	}
	if sala.Humanos != 1 || sala.Bots != 0 || sala.EmPartida {
		t.Errorf("a vitrine da sala saiu errada: %+v", sala)
	}
	if sala.Livres != VagasPorSala-1 {
		t.Errorf("esperava %d vagas livres, a lista diz %d", VagasPorSala-1, sala.Livres)
	}
}

func TestQuedaEReconexaoPeloToken(t *testing.T) {
	srv, base := subirServidor(t)
	dono := conectar(t, base, map[string]any{"modo": "criar", "nome": "Ana", "deviceId": "d1"})
	dono.estado()
	// Um segundo humano segura a sala de pé enquanto o primeiro está fora.
	amigo := conectar(t, base, map[string]any{"modo": "codigo", "codigo": dono.sala, "nome": "Bruno", "deviceId": "d2"})
	amigo.estado()

	sala := srv.Hub().Sala(dono.sala)
	if sala == nil {
		t.Fatal("a sala sumiu do cadastro")
	}

	// QUEDA (não saída): fecha o socket na marra, sem quadro de fechamento normal.
	_ = dono.conn.CloseNow()

	esperarNaSala(t, sala, func() bool {
		p := sala.porID[dono.sess]
		return p != nil && !p.Connected
	}, "o jogador que caiu deveria aparecer desconectado")

	// A vaga continua de pé — é a janela de 30 s.
	volta := conectar(t, base, map[string]any{"modo": "reconectar", "token": dono.token})
	if volta.sess != dono.sess {
		t.Fatalf("a reconexão criou uma sessão nova (%s) em vez de retomar %s", volta.sess, dono.sess)
	}
	esperarNaSala(t, sala, func() bool {
		p := sala.porID[dono.sess]
		return p != nil && p.Connected
	}, "quem voltou deveria aparecer conectado")
}

func TestSaidaConsentidaDevolveAVagaNaHora(t *testing.T) {
	srv, base := subirServidor(t)
	dono := conectar(t, base, map[string]any{"modo": "criar", "nome": "Ana", "deviceId": "d1"})
	dono.estado()
	amigo := conectar(t, base, map[string]any{"modo": "codigo", "codigo": dono.sala, "nome": "Bruno", "deviceId": "d2"})
	amigo.estado()

	sala := srv.Hub().Sala(dono.sala)
	amigo.mandar(MsgSair, nil)

	esperarNaSala(t, sala, func() bool { return sala.porID[amigo.sess] == nil },
		"a saída consentida devolve a vaga na hora, sem esperar os 30 s")
	esperarNaSala(t, sala, func() bool { return len(sala.prazosDeQueda) == 0 },
		"saída consentida não pode abrir janela de reconexão")
}

// esperarNaSala consulta a condição DENTRO da goroutine da sala — ler os campos de fora seria
// corrida de dados, e o `-race` reprovaria com razão.
func esperarNaSala(t *testing.T, s *Sala, condicao func() bool, oque string) {
	t.Helper()
	limite := time.Now().Add(5 * time.Second)
	for time.Now().Before(limite) {
		resposta := make(chan bool, 1)
		if !s.Executar(func() { resposta <- condicao() }) {
			t.Fatalf("%s: a sala morreu antes", oque)
		}
		if <-resposta {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal(oque)
}
