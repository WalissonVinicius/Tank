package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/simplex/tank/go/protocol"
)

// O servidor HTTP: uma porta só, como o Dockerfile assume. Ela serve o cliente estático, a rota
// de salas abertas, o `/healthz` e o WebSocket do jogo.

// Opcoes do servidor.
type Opcoes struct {
	Endereco    string // ":3000"
	ClientDist  string // pasta com o build do cliente
	Persistente Persistencia
}

// Servidor amarra hub, HTTP e WebSocket.
type Servidor struct {
	hub    *Hub
	opcoes Opcoes
	mux    *http.ServeMux
}

// NovoServidor monta as rotas.
func NovoServidor(opcoes Opcoes) *Servidor {
	s := &Servidor{hub: NovoHub(opcoes.Persistente), opcoes: opcoes, mux: http.NewServeMux()}

	s.mux.HandleFunc("/ws", s.aoConectar)
	s.mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		responderJSON(w, map[string]any{"ok": true, "rooms": s.hub.Quantidade()})
	})
	// Salas abertas. `no-store` porque a tela de entrada repergunta a cada 3 s e uma resposta em
	// cache mostraria sala que já encheu (ou esconderia a que acabou de abrir).
	s.mux.HandleFunc(RotaSalas, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		responderJSON(w, map[string]any{"salas": s.hub.SalasAbertas()})
	})
	s.mux.HandleFunc("/", s.aoEstatico)
	return s
}

// Hub expõe o cadastro de salas (usado pelos testes).
func (s *Servidor) Hub() *Hub { return s.hub }

// Handler devolve o roteador HTTP inteiro.
func (s *Servidor) Handler() http.Handler { return s.mux }

// Escutar sobe o servidor e só volta quando o contexto morre.
func (s *Servidor) Escutar(ctx context.Context) error {
	srv := &http.Server{
		Addr:              s.opcoes.Endereco,
		Handler:           s.mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		prazo, cancelar := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelar()
		_ = srv.Shutdown(prazo)
	}()
	err := srv.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

// aoEstatico serve o build do cliente com fallback de SPA: qualquer rota que não seja arquivo cai
// no `index.html`.
func (s *Servidor) aoEstatico(w http.ResponseWriter, r *http.Request) {
	if s.opcoes.ClientDist == "" {
		http.NotFound(w, r)
		return
	}
	limpo := filepath.Clean("/" + strings.TrimPrefix(r.URL.Path, "/"))
	caminho := filepath.Join(s.opcoes.ClientDist, limpo)
	if info, err := os.Stat(caminho); err == nil && !info.IsDir() {
		http.ServeFile(w, r, caminho)
		return
	}
	http.ServeFile(w, r, filepath.Join(s.opcoes.ClientDist, "index.html"))
}

func responderJSON(w http.ResponseWriter, corpo any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(corpo)
}

// -------------------------------------------------------------------------------------------
// WebSocket
// -------------------------------------------------------------------------------------------

// aoConectar aceita a conexão, espera o quadro de entrada e entrega o socket à sala.
func (s *Servidor) aoConectar(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// O jogo é servido pela MESMA origem em produção e por um proxy do Vite em
		// desenvolvimento; o cliente também é aberto por IP de LAN no escritório, o que faz a
		// checagem de origem do pacote recusar conexões legítimas. Não há sessão nem cookie neste
		// servidor — a identidade é o token de reconexão, que a origem não protege de qualquer
		// jeito —, então dispensar a checagem não abre nada.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	// O snapshot é minúsculo e o estado frio de uma sala cheia não passa de 2 KB; o teto existe
	// só para um cliente hostil não conseguir alocar memória do servidor com um quadro gigante.
	conn.SetReadLimit(32 * 1024)

	ctx, cancelar := context.WithCancel(r.Context())
	defer cancelar()

	cliente := novoCliente(novoID(), "", conn)
	go cliente.escrever(ctx)

	sala, err := s.receberEntrada(ctx, cliente)
	if err != nil {
		cliente.enviarJSON(MsgErro, map[string]string{"motivo": err.Error()})
		// Uma pausa curta antes de fechar: sem ela o `Close` corre com a goroutine de escrita e o
		// cliente recebe o fechamento sem nunca ver o motivo.
		time.Sleep(50 * time.Millisecond)
		cliente.encerrar(true, err.Error())
		return
	}

	s.lacoDeLeitura(ctx, sala, cliente)
}

var erroSalaInexistente = erroDeEntrada("sala não encontrada")
var erroPedidoInvalido = erroDeEntrada("pedido de entrada inválido")
var erroTokenVencido = erroDeEntrada("sessão expirada")
var erroSalaLotada = erroDeEntrada("a sala está cheia, nem de espectador cabe mais")

type erroDeEntrada string

func (e erroDeEntrada) Error() string { return string(e) }

// receberEntrada lê o PRIMEIRO quadro, que tem que ser o pedido de entrada, e resolve a sala.
func (s *Servidor) receberEntrada(ctx context.Context, c *Cliente) (*Sala, error) {
	prazo, cancelar := context.WithTimeout(ctx, 15*time.Second)
	defer cancelar()

	tipo, dados, err := c.conn.Read(prazo)
	if err != nil {
		return nil, err
	}
	if tipo != websocket.MessageText {
		return nil, erroPedidoInvalido
	}

	var env Envelope
	if err := json.Unmarshal(dados, &env); err != nil || env.T != MsgEntrar {
		return nil, erroPedidoInvalido
	}
	var pedido PedidoDeEntrada
	if err := json.Unmarshal(env.D, &pedido); err != nil {
		return nil, erroPedidoInvalido
	}

	if pedido.Modo == "reconectar" {
		sala := s.hub.SalaPorToken(pedido.Token)
		if sala == nil {
			return nil, erroTokenVencido
		}
		c.token = pedido.Token
		pronto := make(chan bool, 1)
		if !sala.Executar(func() {
			_, ok := sala.Reconectar(c, pedido.Token)
			// Dentro do comando, e antes de sair dele: ver o comentário em `anunciarEntrada`.
			if ok {
				anunciarEntrada(sala, c)
			}
			pronto <- ok
		}) {
			return nil, erroTokenVencido
		}
		if !<-pronto {
			return nil, erroTokenVencido
		}
		return sala, nil
	}

	var sala *Sala
	if pedido.Modo == "criar" {
		sala = s.hub.CriarSala(OpcoesDaSala{Bots: pedido.Bots, Rodadas: valorOuZero(pedido.Rodadas)})
	} else {
		sala = s.hub.Sala(normalizarCodigo(pedido.Codigo))
		if sala == nil {
			return nil, erroSalaInexistente
		}
	}

	pronto := make(chan bool, 1)
	if !sala.Executar(func() {
		if pedido.Aspecto != nil && *pedido.Aspecto > 0 {
			sala.aspectoDaSessao[c.sessionID] = limitarAspecto(*pedido.Aspecto)
		}
		if len(sala.clientes) >= MaxClientes {
			pronto <- false
			return
		}
		c.token = sala.Codigo() + ":" + novoID()
		anunciarEntrada(sala, c)
		pronto <- sala.Entrar(c, pedido)
	}) {
		return nil, erroSalaInexistente
	}
	if !<-pronto {
		return nil, erroSalaLotada
	}
	return sala, nil
}

// anunciarEntrada enfileira o `entrou` — e é DE DENTRO da goroutine da sala, sempre antes de a
// entrada acontecer, por causa da ordem dos quadros.
//
// `Entrar` e `Reconectar` marcam o estado frio como sujo, e ele é transmitido assim que o comando
// devolve. Anunciar de fora deixaria o estado chegar primeiro, e um cliente que recebe o placar
// antes de saber o próprio `sessionId` não consegue se achar nele. A conferência de lotação
// também mora no comando pelo mesmo motivo: recusar DEPOIS de já ter mandado o `entrou` deixaria
// o cliente convencido de que entrou numa sala que o largou.
func anunciarEntrada(sala *Sala, c *Cliente) {
	c.enviarJSON(MsgEntrou, map[string]string{
		"roomId": sala.Codigo(), "sessionId": c.sessionID, "token": c.token,
	})
}

// lacoDeLeitura repassa cada mensagem do cliente para a goroutine da sala e trata o fim da
// conexão: fechamento normal é SAÍDA CONSENTIDA (vaga devolvida na hora), qualquer outro é QUEDA
// (vaga guardada por 30 s).
func (s *Servidor) lacoDeLeitura(ctx context.Context, sala *Sala, c *Cliente) {
	for {
		tipo, dados, err := c.conn.Read(ctx)
		if err != nil {
			sessao := c.sessionID
			if consentido(err) {
				sala.Executar(func() { sala.Sair(sessao) })
			} else {
				sala.Executar(func() { sala.Cair(sessao) })
			}
			return
		}
		if tipo != websocket.MessageText {
			continue
		}
		var env Envelope
		if err := json.Unmarshal(dados, &env); err != nil {
			continue
		}
		sessao := c.sessionID
		canal := env.T
		corpo := env.D
		if !sala.Executar(func() { sala.Receber(sessao, canal, corpo) }) {
			return
		}
	}
}

func consentido(err error) bool {
	return websocket.CloseStatus(err) == websocket.StatusNormalClosure
}

func novoID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		log.Printf("[ws] falha ao sortear id: %v", err)
	}
	return hex.EncodeToString(b)
}

func codigoDoToken(token string) string {
	i := strings.IndexByte(token, ':')
	if i <= 0 {
		return ""
	}
	return token[:i]
}

func valorOuZero(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

// normalizarCodigo espelha `normalizeRoomCode`: maiúsculo, só caracteres do alfabeto, no máximo 4.
// O acento é tirado antes de filtrar porque num teclado ABNT2 o agudo é tecla morta e um `Á` no
// lugar do `A` é errata de digitação, não outro caractere.
func normalizarCodigo(bruto string) string {
	var saida strings.Builder
	for _, r := range strings.ToUpper(bruto) {
		ch := semAcento(r)
		if strings.ContainsRune(AlfabetoDoCodigo, ch) {
			saida.WriteRune(ch)
			if saida.Len() == TamanhoDoCodigo {
				break
			}
		}
	}
	return saida.String()
}

var acentuadas = map[rune]rune{
	'Á': 'A', 'À': 'A', 'Â': 'A', 'Ã': 'A', 'Ä': 'A',
	'É': 'E', 'È': 'E', 'Ê': 'E', 'Ë': 'E',
	'Í': 'I', 'Ì': 'I', 'Î': 'I', 'Ï': 'I',
	'Ó': 'O', 'Ò': 'O', 'Ô': 'O', 'Õ': 'O', 'Ö': 'O',
	'Ú': 'U', 'Ù': 'U', 'Û': 'U', 'Ü': 'U',
	'Ç': 'C', 'Ñ': 'N',
}

func semAcento(r rune) rune {
	if base, ok := acentuadas[r]; ok {
		return base
	}
	return r
}

func limitarAspecto(v float64) float64 {
	return limitar(v, protocol.MazeAspectMin, protocol.MazeAspectMax)
}
