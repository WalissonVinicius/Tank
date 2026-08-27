package server

import (
	"strconv"
	"strings"
	"time"

	"github.com/simplex/tank/go/sim"
)

// Jogadores, vagas, cores, dono e espectadores — a segunda metade do porte de `TankRoom.ts`.

func (s *Sala) proximaVagaLivre() int {
	usadas := map[int]bool{}
	for _, p := range s.jogadores {
		usadas[p.Slot] = true
	}
	for slot := 0; slot < VagasPorSala; slot++ {
		if !usadas[slot] {
			return slot
		}
	}
	return -1
}

// corEmUso responde se alguém que NÃO seja `exceto` já está com esta cor.
func (s *Sala) corEmUso(cor int, exceto string) bool {
	for _, p := range s.jogadores {
		if p.ID != exceto && p.Color == cor {
			return true
		}
	}
	return false
}

// corLivre decide a cor definitiva de quem está entrando. A preferida é atendida quando está
// livre; senão vale a primeira da paleta que ninguém pegou. Como há 10 cores e no máximo 10
// jogadores, sempre sobra uma.
func (s *Sala) corLivre(preferida int, temPreferida bool) int {
	if temPreferida && corDaPaleta(preferida) && !s.corEmUso(preferida, "") {
		return preferida
	}
	for _, c := range CoresDeJogador {
		if !s.corEmUso(c, "") {
			return c
		}
	}
	return CoresDeJogador[0]
}

func corDaPaleta(cor int) bool {
	for _, c := range CoresDeJogador {
		if c == cor {
			return true
		}
	}
	return false
}

func (s *Sala) adicionarJogador(sessionID, nome string, isBot bool, cor int, temCor bool) {
	slot := s.proximaVagaLivre()
	if slot == -1 {
		if !isBot {
			s.adicionarEspectador(sessionID)
		}
		return
	}

	p := &Jogador{ID: sessionID, Slot: slot, IsBot: isBot, Connected: true, Ready: isBot}
	// A cor deixou de ser função do slot: agora ela é escolhida e por isso viaja separada.
	// `corLivre` mantém a garantia antiga de que duas não se repetem na sala.
	p.Color = s.corLivre(cor, temCor)
	// Bot leva o nome do ANIMAL da própria cor. Antes ele pegava um nome da lista de teste pelo
	// slot, e com bots entrando pelo lobby isso passou a produzir dois "Bruno" na mesma sala — um
	// de carne e osso e outro não. Como cor e animal são par fixo e a cor é única por sala, o nome
	// do bot também é.
	if isBot {
		p.Name = "Bot " + NomeDoAnimal[AnimalDaCor(p.Color)]
	} else if n := strings.TrimSpace(nome); n != "" {
		p.Name = n
	} else {
		p.Name = NomesDeTeste[slot%len(NomesDeTeste)]
	}

	s.jogadores = append(s.jogadores, p)
	s.porID[p.ID] = p
	s.removerEspectador(sessionID)
	s.definirDono()
	s.publicarSala()
	s.marcarEstadoSujo()
}

// adicionarBot cria mais um bot na sala, com id próprio e a primeira cor livre. O contador nunca
// reaproveita id, nem depois de remover um.
func (s *Sala) adicionarBot() {
	s.adicionarJogador("bot-"+strconv.Itoa(s.proximoBot), "", true, 0, false)
	s.proximoBot++
}

// removerUmBot tira UM bot da sala — o do slot mais alto, isto é, o último que entrou. Devolve
// `false` se não havia nenhum. É por aqui que passam tanto o `− BOT` do lobby quanto a prioridade
// do humano que chega numa sala lotada de bots.
func (s *Sala) removerUmBot() bool {
	var alvo *Jogador
	for _, p := range s.jogadores {
		if p.IsBot && (alvo == nil || p.Slot > alvo.Slot) {
			alvo = p
		}
	}
	if alvo == nil {
		return false
	}
	s.removerJogador(alvo.ID)
	return true
}

// removerJogador apaga toda a pegada de um jogador (ou bot): estado frio, input pendente, cérebro
// de bot, reserva de espectador e — se a partida está rolando — o TANQUE dele na simulação.
//
// É a remoção do tanque que resolve o "tanque fantasma": até aqui quem saía no meio da rodada
// continuava de pé no meio da arena, servindo de obstáculo e de alvo. As balas que ele já tinha
// disparado continuam vivas de propósito — elas morrem sozinhas em ≤ 2,2 s, e apagá-las divergiria
// da previsão que cada cliente já está rodando.
func (s *Sala) removerJogador(sessionID string) {
	if _, existe := s.porID[sessionID]; existe {
		delete(s.porID, sessionID)
		for i, p := range s.jogadores {
			if p.ID == sessionID {
				s.jogadores = append(s.jogadores[:i], s.jogadores[i+1:]...)
				break
			}
		}
	}
	delete(s.ultimoInput, sessionID)
	delete(s.cerebros, sessionID)
	delete(s.estatisticas, sessionID)
	delete(s.deviceDaSessao, sessionID)
	delete(s.aspectoDaSessao, sessionID)
	s.removerEspectador(sessionID)
	delete(s.nomeDeEspectador, sessionID)
	delete(s.corDeEspectador, sessionID)
	s.removerTanque(sessionID)
	s.definirDono()
	s.marcarEstadoSujo()
}

// removerTanque tira o tanque da simulação em curso.
//
// `SimState` é remontado em vez de mutado porque o índice por ID dele é privado do pacote `sim` —
// e `go/sim` está fora de alcance de propósito: a paridade bit a bit está provada e qualquer
// mudança lá teria que ser reportada nos dois lados. Tick, balas e o contador de ids seguem
// intactos; o que se perde são os buffers de rascunho, que a própria `Step` reconstrói.
func (s *Sala) removerTanque(id string) {
	if s.simulacao == nil || s.simulacao.Tank(id) == nil {
		return
	}
	restantes := make([]*sim.Tank, 0, len(s.simulacao.Tanks))
	for _, t := range s.simulacao.Tanks {
		if t.ID != id {
			restantes = append(restantes, t)
		}
	}
	novo := sim.NewSimState(s.simulacao.Maze, restantes)
	novo.Tick = s.simulacao.Tick
	novo.Bullets = s.simulacao.Bullets
	novo.NextBulletID = s.simulacao.NextBulletID
	s.simulacao = novo
}

// humanosNaSala conta humanos com vaga mais quem está de espectador esperando a próxima rodada.
func (s *Sala) humanosNaSala() int {
	humanos := 0
	for _, p := range s.jogadores {
		if !p.IsBot {
			humanos++
		}
	}
	return humanos + len(s.espectadores)
}

// definirDono: o dono é o humano de menor slot — na prática o primeiro que entrou. Quando ele sai,
// o posto passa para o próximo em vez de a sala ficar sem ninguém no comando dos bots.
func (s *Sala) definirDono() {
	if atual, ok := s.porID[s.ownerID]; ok && !atual.IsBot {
		return
	}
	novo := ""
	menorSlot := VagasPorSala + 1
	for _, p := range s.jogadores {
		if !p.IsBot && p.Slot < menorSlot {
			menorSlot = p.Slot
			novo = p.ID
		}
	}
	if novo != s.ownerID {
		s.marcarEstadoSujo()
	}
	s.ownerID = novo
}

// publicarSala atualiza o cadastro que a tela de entrada lê para listar as salas abertas.
func (s *Sala) publicarSala() {
	humanos, bots := 0, 0
	for _, p := range s.jogadores {
		if p.IsBot {
			bots++
		} else {
			humanos++
		}
	}
	s.hub.publicar(MetadadosDaSala{
		Codigo:   s.codigo,
		Humanos:  humanos,
		Bots:     bots,
		Fase:     string(s.fase),
		Conexoes: len(s.clientes),
	})
}

func (s *Sala) adicionarEspectador(sessionID string) {
	for _, id := range s.espectadores {
		if id == sessionID {
			return
		}
	}
	s.espectadores = append(s.espectadores, sessionID)
}

func (s *Sala) removerEspectador(sessionID string) {
	for i, id := range s.espectadores {
		if id == sessionID {
			s.espectadores = append(s.espectadores[:i], s.espectadores[i+1:]...)
			return
		}
	}
}

// promoverEspectadores: quem entrou com a partida em andamento (ou com a sala cheia) joga a partir
// da próxima rodada.
func (s *Sala) promoverEspectadores() {
	pendentes := make([]string, len(s.espectadores))
	copy(pendentes, s.espectadores)
	for _, id := range pendentes {
		if len(s.jogadores) >= VagasPorSala {
			break
		}
		cor, temCor := s.corDeEspectador[id]
		s.adicionarJogador(id, s.nomeDeEspectador[id], false, cor, temCor)
		delete(s.nomeDeEspectador, id)
		delete(s.corDeEspectador, id)
	}
}

// -------------------------------------------------------------------------------------------
// Entrada, saída e reconexão
// -------------------------------------------------------------------------------------------

// PedidoDeEntrada é o que o cliente manda no primeiro quadro da conexão.
type PedidoDeEntrada struct {
	Modo     string   `json:"modo"` // "criar" | "codigo" | "reconectar"
	Codigo   string   `json:"codigo"`
	Nome     string   `json:"nome"`
	DeviceID string   `json:"deviceId"`
	Cor      *int     `json:"cor"`
	Bots     int      `json:"bots"`
	Rodadas  *int     `json:"rodadas"`
	Token    string   `json:"token"`
	Aspecto  *float64 `json:"aspect"`
}

// Entrar registra a conexão na sala. Roda na goroutine da sala. Devolve `false` quando a sala já
// está no teto de conexões — 10 jogadores mais espectadores. É o `maxClients` que o Colyseus
// aplicava sozinho: sem ele, uma sala popular acumularia plateia até a fila de saída de cada
// broadcast virar o gargalo do tick.
func (s *Sala) Entrar(c *Cliente, pedido PedidoDeEntrada) bool {
	if len(s.clientes) >= MaxClientes {
		return false
	}
	deviceID := strings.TrimSpace(pedido.DeviceID)
	if deviceID == "" {
		deviceID = c.sessionID
	}
	s.deviceDaSessao[c.sessionID] = deviceID
	s.clientes[c.sessionID] = c
	s.tokens[c.token] = c.sessionID

	emPartida := s.fase != FaseLobby
	cheia := len(s.jogadores) >= VagasPorSala

	// HUMANO TEM PRIORIDADE SOBRE BOT: sala lotada de bots não pode barrar gente de verdade na
	// porta. Um bot cede a vaga (e a cor) na hora. Com a partida em andamento não: aí a vaga é de
	// quem está jogando, e quem chega assiste até a rodada acabar.
	if !emPartida && cheia && s.removerUmBot() {
		cheia = false
	}

	if emPartida || cheia {
		s.adicionarEspectador(c.sessionID)
		if n := strings.TrimSpace(pedido.Nome); n != "" {
			s.nomeDeEspectador[c.sessionID] = n
		}
		// Cor pedida por quem entrou com a partida rolando — atendida quando ele vira jogador.
		if pedido.Cor != nil {
			s.corDeEspectador[c.sessionID] = *pedido.Cor
		}
		s.publicarSala()
		s.marcarEstadoSujo()
		return true
	}

	cor := 0
	if pedido.Cor != nil {
		cor = *pedido.Cor
	}
	s.adicionarJogador(c.sessionID, pedido.Nome, false, cor, pedido.Cor != nil)
	return true
}

// Reconectar reata a sessão antiga a um socket novo. Devolve o sessionId retomado.
func (s *Sala) Reconectar(c *Cliente, token string) (string, bool) {
	sessionID, ok := s.tokens[token]
	if !ok {
		return "", false
	}
	if prazo := s.prazosDeQueda[sessionID]; prazo != nil {
		prazo.Stop()
		delete(s.prazosDeQueda, sessionID)
	}
	if antigo := s.clientes[sessionID]; antigo != nil && antigo != c {
		antigo.encerrar(true, "sessão retomada em outra aba")
	}
	c.sessionID = sessionID
	s.clientes[sessionID] = c
	if p := s.porID[sessionID]; p != nil {
		p.Connected = true
	}
	s.publicarSala()
	s.marcarEstadoSujo()
	return sessionID, true
}

// Cair é a QUEDA de conexão: a vaga fica guardada por 30 s antes de virar saída de verdade.
func (s *Sala) Cair(sessionID string) {
	if _, ligado := s.clientes[sessionID]; !ligado {
		// Já saiu por outro caminho (saída consentida, sala fechada, sessão retomada em outra aba).
		// Sem esta guarda, o erro de leitura que o PRÓPRIO servidor provoca ao fechar o socket
		// abriria uma janela de reconexão para uma sessão que não existe mais.
		return
	}
	delete(s.clientes, sessionID)
	if p := s.porID[sessionID]; p != nil {
		p.Connected = false
		s.marcarEstadoSujo()
	}
	if s.prazosDeQueda[sessionID] != nil {
		return
	}
	s.prazosDeQueda[sessionID] = time.AfterFunc(janelaDeReconexao, func() {
		s.Executar(func() {
			delete(s.prazosDeQueda, sessionID)
			if s.clientes[sessionID] != nil {
				return // voltou antes do prazo por outro caminho
			}
			s.Sair(sessionID)
		})
	})
	s.publicarSala()
}

// Sair é a saída INTENCIONAL (menu de pausa) ou a queda que passou dos 30 s. A vaga é devolvida na
// hora, a cor volta para a paleta e o tanque some da arena dos outros — antes ficava um fantasma
// parado até o fim da rodada.
func (s *Sala) Sair(sessionID string) {
	if prazo := s.prazosDeQueda[sessionID]; prazo != nil {
		prazo.Stop()
		delete(s.prazosDeQueda, sessionID)
	}
	if c := s.clientes[sessionID]; c != nil {
		delete(s.clientes, sessionID)
		delete(s.tokens, c.token)
		c.encerrar(true, "saída consentida")
	}
	s.removerJogador(sessionID)
	s.publicarSala()

	// Sala sem nenhum humano não tem por que continuar viva: sem isto ela ficaria rodando uma
	// partida de bots para plateia nenhuma, e continuaria aparecendo na lista de salas abertas como
	// se alguém estivesse esperando lá dentro.
	if s.humanosNaSala() == 0 {
		s.Fechar("sala vazia")
	}
}
