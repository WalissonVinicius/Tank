package server

import (
	"math"
	"math/rand/v2"
	"sort"
	"strconv"
	"time"

	"github.com/coder/websocket"
	"github.com/simplex/tank/go/internal/jsmath"
	"github.com/simplex/tank/go/protocol"
	"github.com/simplex/tank/go/sim"
)

// Porte de `apps/server/src/rooms/TankRoom.ts` — a peça central.
//
// A troca de Colyseus por WebSocket cru não mexeu em NENHUMA regra: as decisões sutis do arquivo
// original (por que sala só de bots não começa, por que humano tem prioridade sobre bot, por que
// a saída consentida é diferente da queda, por que a cor é decidida aqui e não no cliente)
// continuam valendo e continuam comentadas onde acontecem. O que mudou é como o estado chega no
// outro lado: em vez do delta do `@colyseus/schema`, um JSON do estado frio quando ele muda.
//
// CONCORRÊNCIA: a sala inteira roda numa goroutine só. Tudo que vem de fora (mensagem de cliente,
// entrada, saída, expiração de reconexão) entra pelo canal `comandos` e é executado por ESSA
// goroutine, nunca pela do socket. É o equivalente Go do laço single-thread do Colyseus, e é o
// que permite ler e escrever o estado sem um mutex por campo.

// Fase da sala. Mesmos cinco valores do `RoomPhase` do TypeScript.
type Fase string

const (
	FaseLobby     Fase = "lobby"
	FaseCountdown Fase = "countdown"
	FasePlaying   Fase = "playing"
	FaseRoundEnd  Fase = "roundend"
	FaseGameOver  Fase = "gameover"
)

const (
	duracaoDoFimDeRodada   = 3.0
	intervaloDaMorteSubita = 3.0
	janelaDeReconexao      = 30 * time.Second
	intervaloDoEstadoFrio  = 50 * time.Millisecond // mesmo `patchRate` do Colyseus
	maxTicksDeRecuperacao  = 5                     // teto de ticks encadeados após uma pausa do SO
)

// Jogador é o estado frio de uma pessoa (ou bot) na sala. Espelha `PlayerState`.
type Jogador struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Color     int    `json:"color"`
	Score     int    `json:"score"`
	Alive     bool   `json:"alive"`
	Connected bool   `json:"connected"`
	Ready     bool   `json:"ready"`
	IsBot     bool   `json:"isBot"`
	Kills     int    `json:"kills"`
	Deaths    int    `json:"deaths"`
	SelfKills int    `json:"selfKills"`
	Slot      int    `json:"slot"`
}

// EstadoDaSala é o estado frio inteiro, do jeito que viaja para o cliente.
//
// `Players` é uma lista de PARES `[id, jogador]` e não um objeto porque o cliente faz
// `new Map(s.players)` — o mesmo formato que o `MapSchema` do Colyseus entregava ao iterar, o que
// deixou o `onStateChange` do `main.ts` intacto.
type EstadoDaSala struct {
	Phase       Fase    `json:"phase"`
	Round       int     `json:"round"`
	Seed        uint32  `json:"seed"`
	Aspect      float64 `json:"aspect"`
	TimeLeft    float64 `json:"timeLeft"`
	OwnerID     string  `json:"ownerId"`
	TotalRounds int     `json:"totalRounds"`
	Dificuldade string  `json:"dificuldade"`
	Players     []any   `json:"players"`
}

// OpcoesDaSala são as opções de criação. As três últimas existem só para teste, exatamente como
// no TypeScript — em produção valem `ROUND_TIMEOUT`, `ROUNDS` e "sala só de bots não começa".
type OpcoesDaSala struct {
	Bots                    int
	Rodadas                 int
	RoundTimeoutSegundos    float64
	PermitirPartidaSoDeBots bool
}

// Sala é uma partida e o lobby dela.
type Sala struct {
	hub    *Hub
	codigo string

	comandos chan func()
	parar    chan struct{}
	morta    bool

	// Estado frio -----------------------------------------------------------------------------
	fase         Fase
	round        int
	seed         uint32
	aspect       float64
	timeLeft     float64
	ownerID      string
	totalRodadas int
	dificuldade  string

	// `jogadores` guarda a ORDEM de entrada, que decide qual ponto de spawn cada um recebe e o
	// desempate dos títulos de fim de partida. O mapa é só índice de busca — `range` sobre mapa em
	// Go é aleatório de propósito e não serve para nada que precise de ordem.
	jogadores []*Jogador
	porID     map[string]*Jogador

	// Simulação -------------------------------------------------------------------------------
	simulacao       *sim.SimState
	ultimoInput     map[string]sim.Input
	cerebros        map[string]CerebroDeBot
	powerups        CampoDePowerUps
	efeitos         EfeitosDePowerUp
	proximoBot      int
	roundTimeout    float64
	soDeBotsPermite bool

	// Sessões ---------------------------------------------------------------------------------
	clientes         map[string]*Cliente
	tokens           map[string]string // token de reconexão -> sessionId
	espectadores     []string
	nomeDeEspectador map[string]string
	corDeEspectador  map[string]int
	deviceDaSessao   map[string]string
	aspectoDaSessao  map[string]float64
	prazosDeQueda    map[string]*time.Timer

	// Partida ---------------------------------------------------------------------------------
	ordemDeEliminacao []string
	diarioDeMortes    []RegistroDeMorte
	estatisticas      map[string]*EstatisticaDeTitulo
	morteSubita       struct {
		ativa      bool
		relogio    float64
		tentativas int
	}
	acumuladorDeSnapshot float64
	matchID              string
	comecouEm            int64

	// Publicação ------------------------------------------------------------------------------
	estadoSujo     bool
	ultimoEstadoEm time.Time
	vaziaDesde     time.Time
}

// NovaSala monta a sala e sobe a goroutine dela. O código já vem sorteado pelo hub.
func NovaSala(hub *Hub, codigo string, opcoes OpcoesDaSala) *Sala {
	s := montarSala(hub, codigo, opcoes)
	go s.laco()
	return s
}

// montarSala é a NovaSala sem o relógio. Os testes usam esta para chamar `update(dt)` na mão, do
// mesmo jeito que os testes do `TankRoom` chamavam o `update()` exposto do TypeScript: esperar
// 45 s de rodada real em cada caso tornaria a bateria inútil.
func montarSala(hub *Hub, codigo string, opcoes OpcoesDaSala) *Sala {
	s := &Sala{
		hub:              hub,
		codigo:           codigo,
		comandos:         make(chan func(), 256),
		parar:            make(chan struct{}),
		fase:             FaseLobby,
		dificuldade:      "medio",
		porID:            map[string]*Jogador{},
		ultimoInput:      map[string]sim.Input{},
		cerebros:         map[string]CerebroDeBot{},
		clientes:         map[string]*Cliente{},
		tokens:           map[string]string{},
		nomeDeEspectador: map[string]string{},
		corDeEspectador:  map[string]int{},
		deviceDaSessao:   map[string]string{},
		aspectoDaSessao:  map[string]float64{},
		prazosDeQueda:    map[string]*time.Timer{},
		estatisticas:     map[string]*EstatisticaDeTitulo{},
	}

	s.roundTimeout = protocol.RoundTimeout
	if opcoes.RoundTimeoutSegundos > 0 {
		s.roundTimeout = opcoes.RoundTimeoutSegundos
	}
	s.totalRodadas = limitarRodadas(opcoes.Rodadas)
	s.soDeBotsPermite = opcoes.PermitirPartidaSoDeBots

	bots := opcoes.Bots
	if bots < 0 {
		bots = 0
	}
	if bots > VagasPorSala {
		bots = VagasPorSala
	}
	for i := 0; i < bots; i++ {
		s.adicionarBot()
	}

	s.publicarSala()
	return s
}

func limitarRodadas(r int) int {
	if r <= 0 {
		return protocol.Rounds
	}
	if r > protocol.Rounds {
		return protocol.Rounds
	}
	return r
}

// Codigo devolve o código de 4 caracteres da sala.
func (s *Sala) Codigo() string { return s.codigo }

// Executar enfileira um comando para a goroutine da sala. Devolve `false` se a sala já morreu.
func (s *Sala) Executar(cmd func()) bool {
	select {
	case <-s.parar:
		return false
	default:
	}
	select {
	case s.comandos <- cmd:
		return true
	case <-s.parar:
		return false
	}
}

// laco é a goroutine da sala: um tick de simulação a `TICK_HZ` e os comandos que chegam de fora.
func (s *Sala) laco() {
	intervalo := time.Second / protocol.TickHz
	relogio := time.NewTicker(intervalo)
	defer relogio.Stop()

	anterior := time.Now()
	for {
		select {
		case <-s.parar:
			return
		case cmd := <-s.comandos:
			cmd()
			s.talvezPublicarEstado()
		case agora := <-relogio.C:
			dt := agora.Sub(anterior).Seconds()
			anterior = agora
			// Teto de recuperação: se o sistema tirou a goroutine do ar por meio segundo, avançar
			// meio segundo de simulação num tick só teleportaria as balas por cima das paredes.
			// Melhor perder o tempo perdido do que quebrar o ricochete.
			if dt > float64(maxTicksDeRecuperacao)/protocol.TickHz {
				dt = float64(maxTicksDeRecuperacao) / protocol.TickHz
			}
			s.update(dt)
			s.talvezPublicarEstado()
		}
	}
}

// Fechar derruba a sala e todas as conexões dela. Roda na goroutine da sala.
func (s *Sala) Fechar(motivo string) {
	if s.morta {
		return
	}
	s.morta = true
	for _, c := range s.clientes {
		c.encerrar(true, motivo)
	}
	s.clientes = map[string]*Cliente{}
	for _, t := range s.prazosDeQueda {
		t.Stop()
	}
	s.prazosDeQueda = map[string]*time.Timer{}
	s.hub.removerSala(s.codigo)
	close(s.parar)
}

// -------------------------------------------------------------------------------------------
// Update — as cinco fases
// -------------------------------------------------------------------------------------------

func (s *Sala) update(dt float64) {
	if s.salaAbandonada() {
		return
	}
	switch s.fase {
	case FaseLobby:
		s.updateLobby()
	case FaseCountdown:
		s.updateCountdown(dt)
	case FasePlaying:
		s.updatePlaying(dt)
	case FaseRoundEnd:
		s.updateRoundEnd(dt)
	case FaseGameOver:
	}
}

// salaAbandonada fecha a sala que ficou sem NENHUM socket ligado por mais tempo que a janela de
// reconexão.
//
// `Sair` já derruba a sala assim que o último humano vai embora, mas há um caminho que não passa
// por lá: a criação. Quem pede `criar` e some antes de a entrada chegar (aba fechada no meio do
// aperto de mão, rede caindo) deixaria uma sala vazia rodando um laço de 60 Hz para sempre.
func (s *Sala) salaAbandonada() bool {
	if len(s.clientes) > 0 {
		s.vaziaDesde = time.Time{}
		return false
	}
	if s.vaziaDesde.IsZero() {
		s.vaziaDesde = time.Now()
		return false
	}
	if time.Since(s.vaziaDesde) <= janelaDeReconexao+30*time.Second {
		return false
	}
	s.Fechar("sala abandonada")
	return true
}

func (s *Sala) updateLobby() {
	if len(s.jogadores) < 2 {
		return
	}
	todosProntos := true
	humanos := 0
	for _, p := range s.jogadores {
		if !p.Ready {
			todosProntos = false
		}
		if !p.IsBot {
			humanos++
		}
	}
	// Sala só de bots nunca começa. Sem isto, quem cria uma sala COM bots perde a corrida: os bots
	// entram já prontos, o tick seguinte vê "todos prontos" e a partida começa antes de a entrada
	// do criador ser processada — que então viraria espectador da própria sala.
	if humanos == 0 && !s.soDeBotsPermite {
		return
	}
	if todosProntos {
		s.beginCountdown()
	}
}

func (s *Sala) updateCountdown(dt float64) {
	s.timeLeft = jsmath.Max(0, s.timeLeft-dt)
	s.talvezEnviarSnapshot(dt)
	if s.timeLeft <= 0 {
		s.fase = FasePlaying
		s.timeLeft = s.roundTimeout
		s.marcarEstadoSujo()
	}
}

func (s *Sala) updatePlaying(dt float64) {
	if s.simulacao == nil {
		return
	}

	entradas := s.coletarEntradas()
	idsAntes := idsDasBalas(s.simulacao.Bullets)
	eventos := sim.Step(s.simulacao, entradas, dt)
	// `Step` não mexe no tick — quem é dono do relógio é quem chama. Sem isto todo evento sairia
	// carimbado com tick 0.
	s.simulacao.Tick++
	idsDepois := conjunto(idsDasBalas(s.simulacao.Bullets))

	s.tratarEventos(eventos, idsAntes, idsDepois)
	s.atualizarPowerUps(dt)

	for _, t := range s.simulacao.Tanks {
		if t.Alive {
			s.statsDe(t.ID).AliveSeconds += dt
		}
	}

	vivos := make([]string, 0, len(s.simulacao.Tanks))
	for _, t := range s.simulacao.Tanks {
		if t.Alive {
			vivos = append(vivos, t.ID)
		}
	}
	if len(vivos) <= 1 {
		s.endRound(vivos)
		return
	}

	if !s.morteSubita.ativa {
		s.timeLeft = jsmath.Max(0, s.timeLeft-dt)
		if s.timeLeft <= 0 {
			s.morteSubita.ativa = true
			s.morteSubita.relogio = 0
		}
	} else {
		s.morteSubita.relogio += dt
		if s.morteSubita.relogio >= intervaloDaMorteSubita {
			s.morteSubita.relogio -= intervaloDaMorteSubita
			s.morteSubita.tentativas++

			removida, ok := RemoveRandomInternalWall(s.simulacao.Maze, s.seed, s.morteSubita.tentativas)
			if ok {
				s.transmitir(MsgSuddenWall, map[string]any{
					"index": removida.Index,
					"wall":  map[string]float64{"x": removida.Wall.X, "y": removida.Wall.Y, "w": removida.Wall.W, "h": removida.Wall.H},
					"tick":  s.simulacao.Tick,
				})
			} else {
				// Não sobrou parede interna: empate técnico entre quem ainda está de pé.
				s.endRound(vivos)
				return
			}
		}
	}

	s.talvezEnviarSnapshot(dt)
}

func (s *Sala) updateRoundEnd(dt float64) {
	s.timeLeft = jsmath.Max(0, s.timeLeft-dt)
	if s.timeLeft > 0 {
		return
	}
	if s.round >= s.totalRodadas {
		s.finishMatch()
	} else {
		s.beginCountdown()
	}
}

// -------------------------------------------------------------------------------------------
// Rodada
// -------------------------------------------------------------------------------------------

func (s *Sala) beginCountdown() {
	s.promoverEspectadores()

	participantes := make([]string, 0, len(s.jogadores))
	for _, p := range s.jogadores {
		participantes = append(participantes, p.ID)
	}
	if len(participantes) < 2 {
		s.fase = FaseLobby
		s.marcarEstadoSujo()
		return
	}

	if s.matchID == "" {
		s.comecouEm = time.Now().UnixMilli()
		s.matchID = s.codigo + "-" + strconv.FormatInt(s.comecouEm, 10)
	}

	// A forma do labirinto é combinada AQUI, uma vez por rodada, e viaja junto da seed. Nenhum
	// cliente pode derivá-la da própria janela: a tela de cada um é de um tamanho e a mesma seed
	// geraria geometrias diferentes, quebrando a previsão de bala.
	aspecto := s.aspectoDaSala(participantes)

	seed := sortearSeed()
	labirinto := sim.MakeMaze(seed, float64(len(participantes)), aspecto)
	for tentativas := 0; !sim.ValidateMaze(labirinto).OK && tentativas < 8; tentativas++ {
		seed = sortearSeed()
		labirinto = sim.MakeMaze(seed, float64(len(participantes)), aspecto)
	}

	rng := sim.Mulberry32(seed)
	pontos := sim.SpawnPoints(labirinto, len(participantes), rng)

	tanques := make([]*sim.Tank, 0, len(participantes))
	spawns := make([]map[string]any, 0, len(participantes))

	s.cerebros = map[string]CerebroDeBot{}
	// Uma fábrica por rodada: é ela que carrega a memória compartilhada dos bots desta partida.
	fabrica := NovaFabricaDeBots()
	for i, id := range participantes {
		ponto := pontos[i]
		rumo := rng.Next() * math.Pi * 2
		tanques = append(tanques, &sim.Tank{ID: id, X: ponto.X, Y: ponto.Y, Heading: rumo, Turret: rumo, Alive: true})
		spawns = append(spawns, map[string]any{"playerId": id, "x": ponto.X, "y": ponto.Y})

		if p := s.porID[id]; p != nil {
			p.Alive = true
			if p.IsBot {
				// Semente derivada de (seed da rodada, slot): é o MESMO `makeBot` que o modo local
				// do cliente usa, então bot de servidor e bot de treino se comportam igual.
				s.cerebros[id] = fabrica.Novo(sim.Mulberry32(seed+uint32(p.Slot)*7919+1), s.dificuldade)
			}
		}
	}

	s.simulacao = sim.NewSimState(labirinto, tanques)
	// Mesma seed do labirinto: o cliente monta esta agenda sozinho ao receber o `round_start` e
	// chega aos mesmos itens, nos mesmos lugares, nos mesmos ticks — sem mensagem de nascimento.
	if NovoCampoDePowerUps != nil {
		s.powerups = NovoCampoDePowerUps(labirinto, seed)
	}
	if s.efeitos == nil && NovosEfeitosDePowerUp != nil {
		s.efeitos = NovosEfeitosDePowerUp()
	}
	if s.efeitos != nil {
		s.efeitos.Limpar()
	}
	s.ordemDeEliminacao = nil
	s.diarioDeMortes = nil
	s.morteSubita.ativa = false
	s.morteSubita.relogio = 0
	s.morteSubita.tentativas = 0
	s.acumuladorDeSnapshot = 0
	s.ultimoInput = map[string]sim.Input{}

	s.round++
	s.seed = seed
	s.aspect = aspecto
	s.timeLeft = protocol.Countdown
	s.fase = FaseCountdown
	// A sala sai da lista de "abertas" no instante em que a partida começa e volta marcada como
	// EM PARTIDA — quem clicar nela entra como espectador.
	s.publicarSala()
	s.marcarEstadoSujo()

	s.transmitir(MsgRoundStart, map[string]any{
		"round":       s.round,
		"seed":        seed,
		"playerCount": len(participantes),
		"aspect":      aspecto,
		"spawns":      spawns,
		"tick":        0,
	})
}

// aspectoDaSala é a MEDIANA das telas anunciadas pelos humanos que estão jogando.
//
// Mediana e não média: um único ultrawide na sala não deve esticar a arena de mais oito jogadores
// em 16:9, e um notebook 4:3 não deve encolher a de todo mundo. Com número par de telas fica a
// menor das duas do meio, para o resultado não depender de arredondamento.
func (s *Sala) aspectoDaSala(participantes []string) float64 {
	telas := make([]float64, 0, len(participantes))
	for _, id := range participantes {
		if a, ok := s.aspectoDaSessao[id]; ok {
			telas = append(telas, a)
		}
	}
	if len(telas) == 0 {
		return protocol.MazeAspectDefault
	}
	sort.Float64s(telas)
	return telas[(len(telas)-1)/2]
}

func (s *Sala) endRound(sobreviventes []string) {
	posicoes := ComputeRoundRanking(s.ordemDeEliminacao, sobreviventes)
	kills, autogols := TallyKills(s.diarioDeMortes)

	ranking := make([]EntradaDeRanking, 0, len(posicoes))
	for _, e := range posicoes {
		p := s.porID[e.PlayerID]
		if p == nil {
			continue
		}
		p.Score += RoundScore(e.Position, kills[e.PlayerID], autogols[e.PlayerID])
		ranking = append(ranking, EntradaDeRanking{PlayerID: e.PlayerID, Position: e.Position, Score: p.Score})
	}
	sort.SliceStable(ranking, func(i, j int) bool { return ranking[i].Position > ranking[j].Position })

	s.fase = FaseRoundEnd
	s.timeLeft = duracaoDoFimDeRodada
	s.simulacao = nil
	s.marcarEstadoSujo()

	s.transmitir(MsgRoundEnd, map[string]any{"round": s.round, "ranking": ranking})
}

func (s *Sala) finishMatch() {
	s.fase = FaseGameOver
	s.publicarSala()
	s.marcarEstadoSujo()

	final := make([]*Jogador, len(s.jogadores))
	copy(final, s.jogadores)
	sort.SliceStable(final, func(i, j int) bool { return final[i].Score > final[j].Score })

	rankingFinal := make([]map[string]any, 0, len(final))
	posicaoDe := map[string]int{}
	for i, p := range final {
		posicaoDe[p.ID] = i + 1
		rankingFinal = append(rankingFinal, map[string]any{
			"playerId": p.ID, "nome": p.Name, "pontos": p.Score, "posicao": i + 1,
		})
	}

	stats := make([]EstatisticaDeTitulo, 0, len(s.jogadores))
	for _, p := range s.jogadores {
		if e := s.estatisticas[p.ID]; e != nil {
			stats = append(stats, *e)
		} else {
			stats = append(stats, EstatisticaDeTitulo{PlayerID: p.ID})
		}
	}
	titulos := ComputeMatchTitles(stats)

	s.transmitir(MsgGameOver, map[string]any{"ranking": rankingFinal, "titulos": titulos})

	if s.hub.persistencia != nil {
		s.hub.persistencia.SalvarPartida(RegistroDaPartida{
			MatchID:      s.matchID,
			Sala:         s.codigo,
			ComecouEm:    s.comecouEm,
			TerminouEm:   time.Now().UnixMilli(),
			Jogadores:    copiarJogadores(s.jogadores),
			Posicao:      posicaoDe,
			DevicePorID:  copiarStrings(s.deviceDaSessao),
			RankingFinal: rankingFinal,
			Titulos:      titulos,
		})
	}
}

// reiniciarParaLobby é a REVANCHE: a sala volta ao lobby mantendo o código, o link e as pessoas.
//
// Zera tudo que é DA PARTIDA e preserva o que é DA PESSOA: nome, cor e a condição de dono
// continuam; placar, abates, mortes, autogols e as estatísticas de título recomeçam. Bots voltam
// prontos (é o estado natural deles) e humanos voltam a "não pronto", senão a revanche começaria
// sozinha antes de todo mundo perceber que voltou ao lobby.
func (s *Sala) reiniciarParaLobby() {
	for _, p := range s.jogadores {
		p.Score = 0
		p.Kills = 0
		p.Deaths = 0
		p.SelfKills = 0
		p.Alive = false
		p.Ready = p.IsBot
	}
	s.estatisticas = map[string]*EstatisticaDeTitulo{}
	s.matchID = ""
	s.round = 0
	s.timeLeft = 0
	s.fase = FaseLobby
	s.simulacao = nil
	s.powerups = nil
	if s.efeitos != nil {
		s.efeitos.Limpar()
	}
	s.cerebros = map[string]CerebroDeBot{}
	s.publicarSala()
	s.marcarEstadoSujo()
	s.transmitir(MsgRematch, nil)
}

// -------------------------------------------------------------------------------------------
// Simulação — entradas, eventos, snapshot
// -------------------------------------------------------------------------------------------

func (s *Sala) coletarEntradas() map[string]sim.Input {
	entradas := make(map[string]sim.Input, len(s.simulacao.Tanks))
	var itens []sim.Vec2
	if s.powerups != nil {
		// Uma leitura do campo por tick, copiada: `NoChao` devolve um slice reaproveitado e todos
		// os bots da sala consultam a mesma lista dentro deste laço.
		origem := s.powerups.NoChao(s.simulacao.Tick)
		itens = make([]sim.Vec2, len(origem))
		copy(itens, origem)
	}

	for _, tank := range s.simulacao.Tanks {
		if !tank.Alive {
			continue
		}
		if p := s.porID[tank.ID]; p != nil && p.IsBot {
			entradas[tank.ID] = s.entradaDeBot(tank, itens)
			continue
		}
		entradas[tank.ID] = s.ultimoInput[tank.ID]
	}
	return entradas
}

func (s *Sala) entradaDeBot(tank *sim.Tank, itens []sim.Vec2) sim.Input {
	cerebro := s.cerebros[tank.ID]
	if cerebro == nil {
		return sim.Input{}
	}
	alvo, ok := s.inimigoMaisProximo(tank.ID)
	if !ok {
		return sim.Input{}
	}
	return cerebro.Think(tank, alvo, s.simulacao.Maze, s.simulacao.Tick, s.simulacao.Bullets, itens)
}

func (s *Sala) inimigoMaisProximo(id string) (sim.Vec2, bool) {
	eu := s.simulacao.Tank(id)
	if eu == nil {
		return sim.Vec2{}, false
	}
	var melhor *sim.Tank
	melhorDist := math.Inf(1)
	for _, t := range s.simulacao.Tanks {
		if t.ID == id || !t.Alive {
			continue
		}
		dx := t.X - eu.X
		dy := t.Y - eu.Y
		d := dx*dx + dy*dy
		if d < melhorDist {
			melhorDist = d
			melhor = t
		}
	}
	if melhor == nil {
		return sim.Vec2{}, false
	}
	return sim.Vec2{X: melhor.X, Y: melhor.Y}, true
}

func (s *Sala) tratarEventos(eventos []sim.SimEvent, idsAntes []string, idsDepois map[string]bool) {
	expiradas := map[string]bool{}

	for _, ev := range eventos {
		switch ev.Type {
		case sim.EvShot:
			s.statsDe(ev.OwnerID).ShotsFired++
			s.transmitir(MsgBulletSpwn, map[string]any{
				"id": ev.BulletID, "ownerId": ev.OwnerID, "x": ev.X, "y": ev.Y,
				"angle": ev.Angle, "vx": ev.VX, "vy": ev.VY,
				// O bônus de ricochete viaja COM a bala, como `vx`/`vy` — nunca é lido do estado do
				// atirador do outro lado.
				"ricochete": ev.Ricochete, "tick": ev.Tick,
			})
		case sim.EvBulletExpired:
			expiradas[ev.BulletID] = true
			motivo := "expirou"
			if ev.Reason == "max_bounces" {
				motivo = "parede_excedeu_rebotes"
			}
			s.transmitir(MsgBulletDead, map[string]any{"id": ev.BulletID, "motivo": motivo, "tick": ev.Tick})
		case sim.EvBulletClash:
			// O cliente já simulou o mesmo encontro com a mesma `Step()` e já mostrou a explosão;
			// isto é a confirmação autoritativa da remoção. Entrar em `expiradas` é obrigatório:
			// sem isso os dois ids cairiam na lista de "sumiram sem evento", que é o que pareia
			// bala com morte de tanque logo abaixo.
			expiradas[ev.AID] = true
			expiradas[ev.BID] = true
			s.transmitir(MsgBulletDead, map[string]any{"id": ev.AID, "motivo": "colisao_bala", "tick": ev.Tick})
			s.transmitir(MsgBulletDead, map[string]any{"id": ev.BID, "motivo": "colisao_bala", "tick": ev.Tick})
		}
	}

	sumidas := make([]string, 0, 4)
	for _, id := range idsAntes {
		if !idsDepois[id] && !expiradas[id] {
			sumidas = append(sumidas, id)
		}
	}
	indice := 0

	for _, ev := range eventos {
		if ev.Type != sim.EvDeath {
			continue
		}
		vitima := s.porID[ev.VictimID]
		matador := s.porID[ev.KillerID]

		if vitima != nil {
			vitima.Deaths++
		}
		if ev.Autogol {
			if vitima != nil {
				vitima.SelfKills++
			}
			s.statsDe(ev.VictimID).SelfKills++
		} else if matador != nil {
			matador.Kills++
			s.statsDe(ev.KillerID).KillCount++
		}
		s.statsDe(ev.KillerID).ShotsHit++

		s.ordemDeEliminacao = append(s.ordemDeEliminacao, ev.VictimID)
		s.diarioDeMortes = append(s.diarioDeMortes, RegistroDeMorte{VictimID: ev.VictimID, KillerID: ev.KillerID, Autogol: ev.Autogol})
		s.marcarEstadoSujo()

		s.transmitir(MsgTankDeath, map[string]any{
			"victimId": ev.VictimID, "killerId": ev.KillerID,
			"x": ev.X, "y": ev.Y, "tick": ev.Tick, "autogol": ev.Autogol,
		})

		if indice < len(sumidas) {
			s.transmitir(MsgBulletDead, map[string]any{
				"id": sumidas[indice], "motivo": "acerto", "tick": ev.Tick, "targetId": ev.VictimID,
			})
			indice++
		}
	}
}

// atualizarPowerUps: primeiro o que ACABOU, depois o que foi PEGO.
//
// Nessa ordem porque o contrário deixaria um efeito recém-pego levar um decremento de `dt` no
// mesmo tick da coleta — e, no caso de uma renovação, poderia até expirá-lo na hora.
func (s *Sala) atualizarPowerUps(dt float64) {
	if s.simulacao == nil || s.powerups == nil || s.efeitos == nil {
		return
	}
	for _, fim := range s.efeitos.Passo(s.simulacao, dt) {
		s.transmitir(MsgPowerExpir, map[string]any{"playerId": fim.TankID, "tipo": fim.Tipo, "tick": s.simulacao.Tick})
	}
	for _, coleta := range s.powerups.Coletar(s.simulacao, s.simulacao.Tick) {
		tank := s.simulacao.Tank(coleta.TankID)
		if tank == nil {
			continue
		}
		s.efeitos.Aplicar(tank, coleta.Tipo)
		s.transmitir(MsgPowerTaken, map[string]any{
			"itemId": coleta.ItemID, "tipo": coleta.Tipo, "playerId": coleta.TankID,
			"x": coleta.X, "y": coleta.Y, "duracao": DuracaoDePowerUp[coleta.Tipo], "tick": s.simulacao.Tick,
		})
	}
}

func (s *Sala) talvezEnviarSnapshot(dt float64) {
	s.acumuladorDeSnapshot += dt
	intervalo := 1.0 / protocol.SnapshotHz
	if s.acumuladorDeSnapshot < intervalo {
		return
	}
	s.acumuladorDeSnapshot -= intervalo
	s.enviarSnapshot()
}

func (s *Sala) enviarSnapshot() {
	if s.simulacao == nil {
		return
	}
	linhas := make([]SnapshotTank, 0, len(s.simulacao.Tanks))
	for _, t := range s.simulacao.Tanks {
		p := s.porID[t.ID]
		if p == nil {
			continue
		}
		linhas = append(linhas, SnapshotTank{
			Slot: p.Slot, X: t.X, Y: t.Y, Heading: t.Heading, Turret: t.Turret,
			Alive: t.Alive, Connected: p.Connected,
		})
	}
	s.transmitirBytes(EncodeSnapshot(linhas))
}

func (s *Sala) statsDe(id string) *EstatisticaDeTitulo {
	e := s.estatisticas[id]
	if e == nil {
		e = &EstatisticaDeTitulo{PlayerID: id}
		s.estatisticas[id] = e
	}
	return e
}

func idsDasBalas(balas []*sim.Bullet) []string {
	ids := make([]string, len(balas))
	for i, b := range balas {
		ids[i] = b.ID
	}
	return ids
}

func conjunto(ids []string) map[string]bool {
	m := make(map[string]bool, len(ids))
	for _, id := range ids {
		m[id] = true
	}
	return m
}

func sortearSeed() uint32 { return rand.Uint32() }

func copiarJogadores(js []*Jogador) []Jogador {
	out := make([]Jogador, len(js))
	for i, p := range js {
		out[i] = *p
	}
	return out
}

func copiarStrings(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// -------------------------------------------------------------------------------------------
// Publicação do estado frio
// -------------------------------------------------------------------------------------------

func (s *Sala) marcarEstadoSujo() { s.estadoSujo = true }

func (s *Sala) talvezPublicarEstado() {
	agora := time.Now()
	// Fora do lobby o `timeLeft` anda a cada tick, então o estado sai no ritmo do antigo
	// `patchRate` do Colyseus (50 ms). No lobby nada muda sozinho e a sala fica muda até alguém
	// clicar em alguma coisa.
	relogioAndando := s.fase != FaseLobby && agora.Sub(s.ultimoEstadoEm) >= intervaloDoEstadoFrio
	if !s.estadoSujo && !relogioAndando {
		return
	}
	s.estadoSujo = false
	s.ultimoEstadoEm = agora
	s.transmitir(MsgEstado, s.estadoFrio())
}

func (s *Sala) estadoFrio() EstadoDaSala {
	pares := make([]any, 0, len(s.jogadores))
	for _, p := range s.jogadores {
		pares = append(pares, []any{p.ID, p})
	}
	return EstadoDaSala{
		Phase: s.fase, Round: s.round, Seed: s.seed, Aspect: s.aspect, TimeLeft: s.timeLeft,
		OwnerID: s.ownerID, TotalRounds: s.totalRodadas, Dificuldade: s.dificuldade, Players: pares,
	}
}

func (s *Sala) transmitir(canal string, corpo any) {
	dados, err := montarEnvelope(canal, corpo)
	if err != nil {
		return
	}
	s.transmitirQuadro(quadro{tipo: websocket.MessageText, dados: dados})
}

func (s *Sala) transmitirBytes(dados []byte) {
	s.transmitirQuadro(quadro{tipo: websocket.MessageBinary, dados: dados})
}

func (s *Sala) transmitirQuadro(q quadro) {
	var atrasados []string
	for id, c := range s.clientes {
		if !c.enviar(q) {
			atrasados = append(atrasados, id)
		}
	}
	// Cliente que não consegue mais acompanhar a fila é DESCONECTADO em vez de segurar o tick.
	// Ele cai no caminho normal de queda e tem os mesmos 30 s para voltar.
	for _, id := range atrasados {
		if c := s.clientes[id]; c != nil {
			c.encerrar(false, "fila de saída cheia")
		}
	}
}
