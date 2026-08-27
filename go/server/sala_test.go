package server

import (
	"strconv"
	"testing"
	"time"

	"github.com/simplex/tank/go/protocol"
)

// Ciclo da sala. As regras conferidas aqui são as MESMAS que os comentários do `TankRoom.ts`
// registram — cada uma existe porque alguma coisa deu errado antes.

func salaDeTeste(t *testing.T, opcoes OpcoesDaSala) *Sala {
	t.Helper()
	s := montarSala(NovoHub(nil), "TEST", opcoes)
	// Sem cliente ligado a sala se autodestrói depois da janela de reconexão; nos testes ela nunca
	// chega perto disso, mas o carimbo deixa a intenção explícita.
	s.vaziaDesde = time.Now()
	return s
}

// avancar roda N ticks de `dt`. Mesmo papel do `update()` exposto do TypeScript.
func avancar(s *Sala, ticks int, dt float64) {
	for i := 0; i < ticks; i++ {
		s.update(dt)
	}
}

func entrarComoJogador(s *Sala, id, nome string) {
	s.clientes[id] = novoCliente(id, "", nil)
	s.adicionarJogador(id, nome, false, 0, false)
}

func TestSalaComUmJogadorNaoComeca(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{})
	entrarComoJogador(s, "a", "Ana")
	s.porID["a"].Ready = true

	avancar(s, 10, 1.0/60)
	if s.fase != FaseLobby {
		t.Fatalf("a sala saiu do lobby com um jogador só: %s", s.fase)
	}
}

// Sala só de bots nunca começa. Sem isto, quem cria uma sala COM bots perde a corrida: os bots
// entram já prontos e a partida começaria antes de a entrada do criador ser processada.
func TestSalaSoDeBotsNaoComeca(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{Bots: 4})
	if len(s.jogadores) != 4 {
		t.Fatalf("esperava 4 bots, achei %d", len(s.jogadores))
	}
	avancar(s, 120, 1.0/60)
	if s.fase != FaseLobby {
		t.Fatalf("uma sala só de bots começou sozinha: %s", s.fase)
	}

	// O override de teste (e SÓ ele) libera.
	s2 := salaDeTeste(t, OpcoesDaSala{Bots: 4, PermitirPartidaSoDeBots: true})
	avancar(s2, 2, 1.0/60)
	if s2.fase != FaseCountdown {
		t.Fatalf("com o override a partida deveria começar; fase %s", s2.fase)
	}
}

func TestTodosProntosComecaAContagem(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{Bots: 2})
	entrarComoJogador(s, "a", "Ana")
	avancar(s, 5, 1.0/60)
	if s.fase != FaseLobby {
		t.Fatalf("o humano ainda não está pronto e a partida começou: %s", s.fase)
	}

	s.Receber("a", MsgReady, nil)
	avancar(s, 1, 1.0/60)
	if s.fase != FaseCountdown {
		t.Fatalf("todos prontos deveria virar contagem; fase %s", s.fase)
	}
	if s.timeLeft != protocol.Countdown {
		t.Errorf("a contagem devia começar em %v, começou em %v", float64(protocol.Countdown), s.timeLeft)
	}
	if len(s.simulacao.Tanks) != 3 {
		t.Errorf("esperava 3 tanques na arena, achei %d", len(s.simulacao.Tanks))
	}
}

func TestContagemViraPartidaEDepoisMorteSubita(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{Bots: 1, RoundTimeoutSegundos: 1})
	entrarComoJogador(s, "a", "Ana")
	s.Receber("a", MsgReady, nil)
	avancar(s, 2, 1.0/60)

	avancar(s, 200, 1.0/60) // 3,3 s: passa a contagem de 3 s
	if s.fase != FasePlaying {
		t.Fatalf("depois da contagem a fase deveria ser playing, é %s", s.fase)
	}

	// Com o timeout de 1 s encurtado, a morte súbita entra logo depois.
	paredesAntes := len(s.simulacao.Maze.Walls)
	avancar(s, 60*5, 1.0/60)
	if s.fase == FasePlaying && len(s.simulacao.Maze.Walls) >= paredesAntes {
		t.Errorf("a morte súbita não removeu nenhuma parede (%d antes, %d agora)",
			paredesAntes, len(s.simulacao.Maze.Walls))
	}
}

func TestCoresNaoSeRepetemNaSala(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{})
	for i := 0; i < VagasPorSala; i++ {
		entrarComoJogador(s, string(rune('a'+i)), "Jogador")
	}
	vistas := map[int]string{}
	for _, p := range s.jogadores {
		if dono, repetida := vistas[p.Color]; repetida {
			t.Fatalf("a cor %#06x está com %s e com %s", p.Color, dono, p.ID)
		}
		vistas[p.Color] = p.ID
	}
	if len(vistas) != VagasPorSala {
		t.Fatalf("esperava %d cores distintas, achei %d", VagasPorSala, len(vistas))
	}
}

// A unicidade da cor é do SERVIDOR. Dois pedidos para o mesmo quadrado são atendidos em ordem e o
// segundo é recusado — o cliente descobre o que aconteceu lendo o estado frio.
func TestPedidoDeCorJaTomadaERecusado(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{})
	entrarComoJogador(s, "a", "Ana")
	entrarComoJogador(s, "b", "Bruno")

	corDoA := s.porID["a"].Color
	corDoB := s.porID["b"].Color
	s.Receber("b", MsgPickColor, []byte(`{"color":`+itoa(corDoA)+`}`))
	if s.porID["b"].Color != corDoB {
		t.Fatalf("o pedido de uma cor tomada foi atendido: %#06x", s.porID["b"].Color)
	}

	// Uma cor livre é atendida.
	livre := CoresDeJogador[5]
	s.Receber("b", MsgPickColor, []byte(`{"color":`+itoa(livre)+`}`))
	if s.porID["b"].Color != livre {
		t.Fatalf("o pedido de uma cor livre não foi atendido: %#06x", s.porID["b"].Color)
	}
}

func TestTrocaDeCorSoValeNoLobby(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{Bots: 1})
	entrarComoJogador(s, "a", "Ana")
	s.Receber("a", MsgReady, nil)
	avancar(s, 2, 1.0/60)

	antes := s.porID["a"].Color
	s.Receber("a", MsgPickColor, []byte(`{"color":`+itoa(CoresDeJogador[9])+`}`))
	if s.porID["a"].Color != antes {
		t.Fatal("trocar de cor no meio da partida embaralharia a leitura da arena")
	}
}

// O dono é o humano de menor slot. Quando ele sai, o posto passa para o próximo em vez de a sala
// ficar sem ninguém no comando dos bots.
func TestDonoEOPrimeiroHumanoEPassaAoSair(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{Bots: 2})
	entrarComoJogador(s, "a", "Ana")
	entrarComoJogador(s, "b", "Bruno")

	if s.ownerID != "a" {
		t.Fatalf("o dono deveria ser o primeiro humano, é %q", s.ownerID)
	}
	s.Sair("a")
	if s.ownerID != "b" {
		t.Fatalf("o posto deveria passar para b, ficou com %q", s.ownerID)
	}
}

func TestSoODonoMexeNosBotsENaConfiguracao(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{})
	entrarComoJogador(s, "a", "Ana")
	entrarComoJogador(s, "b", "Bruno")

	s.Receber("b", MsgAddBot, nil)
	if len(s.jogadores) != 2 {
		t.Fatalf("quem não é dono não coloca bot; a sala ficou com %d", len(s.jogadores))
	}
	s.Receber("b", MsgConfig, []byte(`{"rodadas":3,"dificuldade":"dificil"}`))
	if s.totalRodadas != protocol.Rounds || s.dificuldade != "medio" {
		t.Fatalf("quem não é dono não muda a configuração: %d rodadas, %q", s.totalRodadas, s.dificuldade)
	}

	s.Receber("a", MsgAddBot, nil)
	if len(s.jogadores) != 3 {
		t.Fatalf("o dono deveria ter colocado um bot; a sala ficou com %d", len(s.jogadores))
	}
	s.Receber("a", MsgConfig, []byte(`{"rodadas":3,"dificuldade":"dificil"}`))
	if s.totalRodadas != 3 || s.dificuldade != "dificil" {
		t.Fatalf("a configuração do dono não pegou: %d rodadas, %q", s.totalRodadas, s.dificuldade)
	}

	s.Receber("a", MsgRemoveBot, nil)
	if len(s.jogadores) != 2 {
		t.Fatalf("o `− BOT` do dono não tirou o bot; a sala ficou com %d", len(s.jogadores))
	}
}

// HUMANO TEM PRIORIDADE SOBRE BOT: sala lotada de bots não pode barrar gente de verdade na porta.
func TestHumanoTiraBotDeSalaLotada(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{Bots: VagasPorSala})
	c := novoCliente("humano", "", nil)
	s.Entrar(c, PedidoDeEntrada{Modo: "codigo", Nome: "Ana"})

	if _, entrou := s.porID["humano"]; !entrou {
		t.Fatal("o humano deveria ter entrado no lugar de um bot")
	}
	if len(s.jogadores) != VagasPorSala {
		t.Fatalf("a sala deveria continuar com %d, ficou com %d", VagasPorSala, len(s.jogadores))
	}
	bots := 0
	for _, p := range s.jogadores {
		if p.IsBot {
			bots++
		}
	}
	if bots != VagasPorSala-1 {
		t.Fatalf("um bot deveria ter cedido a vaga; sobraram %d", bots)
	}
}

// Com a partida em andamento a vaga é de quem está jogando: quem chega assiste até a rodada acabar
// e entra na seguinte.
func TestQuemChegaComPartidaRolandoAssisteEDepoisJoga(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{Bots: 1, RoundTimeoutSegundos: 1})
	entrarComoJogador(s, "a", "Ana")
	s.Receber("a", MsgReady, nil)
	avancar(s, 2, 1.0/60)

	c := novoCliente("tarde", "", nil)
	s.Entrar(c, PedidoDeEntrada{Modo: "codigo", Nome: "Atrasado", Cor: intPtr(CoresDeJogador[4])})
	if _, virouJogador := s.porID["tarde"]; virouJogador {
		t.Fatal("quem chega no meio da partida entra como espectador")
	}
	if len(s.espectadores) != 1 {
		t.Fatalf("esperava 1 espectador, achei %d", len(s.espectadores))
	}

	s.promoverEspectadores()
	p, virouJogador := s.porID["tarde"]
	if !virouJogador {
		t.Fatal("o espectador deveria virar jogador na rodada seguinte")
	}
	if p.Name != "Atrasado" {
		t.Errorf("o nome pedido na entrada se perdeu: %q", p.Name)
	}
	if p.Color != CoresDeJogador[4] {
		t.Errorf("a cor pedida na entrada se perdeu: %#06x", p.Color)
	}
}

// Quem sai no meio da rodada some da arena. Antes ficava um tanque fantasma de pé, servindo de
// obstáculo e de alvo.
func TestSairNoMeioDaRodadaTiraOTanqueDaArena(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{Bots: 2})
	entrarComoJogador(s, "a", "Ana")
	s.Receber("a", MsgReady, nil)
	avancar(s, 2, 1.0/60)

	if len(s.simulacao.Tanks) != 3 {
		t.Fatalf("esperava 3 tanques, achei %d", len(s.simulacao.Tanks))
	}
	tickAntes := s.simulacao.Tick
	s.Sair("a")
	if s.simulacao == nil {
		t.Fatal("a simulação não deveria morrer junto com o jogador")
	}
	if len(s.simulacao.Tanks) != 2 {
		t.Fatalf("o tanque de quem saiu ficou na arena: %d tanques", len(s.simulacao.Tanks))
	}
	if s.simulacao.Tank("a") != nil {
		t.Fatal("o índice por id ainda encontra o tanque removido")
	}
	if s.simulacao.Tick != tickAntes {
		t.Errorf("remontar o estado não pode mexer no relógio: %d -> %d", tickAntes, s.simulacao.Tick)
	}
}

// A QUEDA guarda a vaga por 30 s; a SAÍDA devolve na hora. É o `code` que separa os dois.
func TestQuedaGuardaAVagaESaidaDevolve(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{})
	entrarComoJogador(s, "a", "Ana")
	entrarComoJogador(s, "b", "Bruno")

	s.Cair("a")
	p, aindaTemVaga := s.porID["a"]
	if !aindaTemVaga {
		t.Fatal("a queda não pode devolver a vaga na hora — ela fica guardada por 30 s")
	}
	if p.Connected {
		t.Error("quem caiu tem que aparecer desconectado no estado frio")
	}
	if s.prazosDeQueda["a"] == nil {
		t.Error("a queda deveria ter aberto a janela de reconexão")
	}

	s.Sair("b")
	if _, aindaTem := s.porID["b"]; aindaTem {
		t.Fatal("a saída consentida devolve a vaga na hora")
	}
}

func TestReconexaoRetomaOAssentoEFechaAJanela(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{})
	c := novoCliente("a", "TEST:tok", nil)
	s.Entrar(c, PedidoDeEntrada{Modo: "codigo", Nome: "Ana"})
	entrarComoJogador(s, "b", "Bruno")

	pontos := 7
	s.porID["a"].Score = pontos
	s.Cair("a")

	novo := novoCliente("outro-socket", "", nil)
	sessao, ok := s.Reconectar(novo, "TEST:tok")
	if !ok {
		t.Fatal("o token deveria retomar o assento")
	}
	if sessao != "a" {
		t.Fatalf("retomou a sessão errada: %q", sessao)
	}
	if s.prazosDeQueda["a"] != nil {
		t.Error("a janela de 30 s deveria ter sido fechada pela volta")
	}
	if !s.porID["a"].Connected {
		t.Error("quem voltou tem que aparecer conectado")
	}
	if s.porID["a"].Score != pontos {
		t.Errorf("a pontuação se perdeu na reconexão: %d", s.porID["a"].Score)
	}
}

// REVANCHE: zera o que é DA PARTIDA e preserva o que é DA PESSOA.
func TestRevancheZeraPlacarEPreservaPessoa(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{Bots: 1})
	entrarComoJogador(s, "a", "Ana")

	s.fase = FaseGameOver
	s.round = 3
	a := s.porID["a"]
	a.Score, a.Kills, a.Deaths, a.SelfKills, a.Ready = 42, 5, 3, 1, true
	corDoA, nomeDoA := a.Color, a.Name

	s.Receber("a", MsgRematch, nil)

	if s.fase != FaseLobby {
		t.Fatalf("a revanche devolve a sala ao lobby, não a %s", s.fase)
	}
	if s.round != 0 || a.Score != 0 || a.Kills != 0 || a.Deaths != 0 || a.SelfKills != 0 {
		t.Errorf("o que é da partida não zerou: %+v", *a)
	}
	if a.Ready {
		t.Error("o humano tem que voltar a NÃO pronto, senão a revanche começaria sozinha")
	}
	if a.Color != corDoA || a.Name != nomeDoA {
		t.Errorf("nome e cor são da pessoa e deveriam continuar: %q %#06x", a.Name, a.Color)
	}
	for _, p := range s.jogadores {
		if p.IsBot && !p.Ready {
			t.Error("bot nasce pronto — é o estado natural dele")
		}
	}
	if s.matchID != "" {
		t.Error("a revanche tem que entrar no ranking como partida NOVA")
	}
}

func TestRevancheSoValeEmGameover(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{})
	entrarComoJogador(s, "a", "Ana")
	s.porID["a"].Score = 10
	s.Receber("a", MsgRematch, nil)
	if s.porID["a"].Score != 10 {
		t.Fatal("pedir revanche fora do fim de partida não pode zerar nada")
	}
}

// A proporção da sala é a MEDIANA das telas: um ultrawide sozinho não estica a arena de mais oito
// jogadores, e um 4:3 não encolhe a de todo mundo.
func TestAspectoDaSalaEAMediana(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{})
	if a := s.aspectoDaSala(nil); a != protocol.MazeAspectDefault {
		t.Errorf("sala sem tela anunciada devia cair no 16:9; deu %v", a)
	}

	s.aspectoDaSessao["a"] = 1.33
	s.aspectoDaSessao["b"] = 1.78
	s.aspectoDaSessao["c"] = 2.35
	if a := s.aspectoDaSala([]string{"a", "b", "c"}); a != 1.78 {
		t.Errorf("mediana de 3 telas devia ser 1,78; deu %v", a)
	}
	s.aspectoDaSessao["d"] = 2.7
	// Número par: fica a MENOR das duas do meio, para não depender de arredondamento.
	if a := s.aspectoDaSala([]string{"a", "b", "c", "d"}); a != 1.78 {
		t.Errorf("mediana de 4 telas devia ser a menor do meio (1,78); deu %v", a)
	}
}

func TestViewportEGrampeadoNaFaixaPermitida(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{})
	entrarComoJogador(s, "a", "Ana")

	s.Receber("a", MsgViewport, []byte(`{"aspect":32}`))
	if s.aspectoDaSessao["a"] != protocol.MazeAspectMax {
		t.Errorf("32:1 devia ser grampeado em %v; virou %v", protocol.MazeAspectMax, s.aspectoDaSessao["a"])
	}
	s.Receber("a", MsgViewport, []byte(`{"aspect":0.4}`))
	if s.aspectoDaSessao["a"] != protocol.MazeAspectMin {
		t.Errorf("0,4 devia ser grampeado em %v; virou %v", protocol.MazeAspectMin, s.aspectoDaSessao["a"])
	}
	s.Receber("a", MsgViewport, []byte(`{"aspect":-1}`))
	if s.aspectoDaSessao["a"] != protocol.MazeAspectMin {
		t.Error("proporção negativa tem que ser ignorada, não aplicada")
	}
}

func TestNomeDoBotSaiDoAnimalDaCor(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{Bots: 3})
	vistos := map[string]bool{}
	for _, p := range s.jogadores {
		if !p.IsBot {
			continue
		}
		esperado := "Bot " + NomeDoAnimal[AnimalDaCor(p.Color)]
		if p.Name != esperado {
			t.Errorf("bot da cor %#06x devia se chamar %q, chama %q", p.Color, esperado, p.Name)
		}
		if vistos[p.Name] {
			t.Errorf("dois bots com o mesmo nome: %q", p.Name)
		}
		vistos[p.Name] = true
	}
}

// O contador de ids de bot nunca reaproveita — nem depois de remover um.
func TestIdDeBotNuncaERepetido(t *testing.T) {
	s := salaDeTeste(t, OpcoesDaSala{})
	entrarComoJogador(s, "a", "Ana")
	s.Receber("a", MsgAddBot, nil)
	primeiro := ultimoBot(s)
	s.Receber("a", MsgRemoveBot, nil)
	s.Receber("a", MsgAddBot, nil)
	if ultimoBot(s) == primeiro {
		t.Fatalf("o id de bot %q foi reaproveitado", primeiro)
	}
}

func ultimoBot(s *Sala) string {
	id := ""
	for _, p := range s.jogadores {
		if p.IsBot {
			id = p.ID
		}
	}
	return id
}

func intPtr(v int) *int { return &v }

func itoa(n int) string { return strconv.Itoa(n) }
