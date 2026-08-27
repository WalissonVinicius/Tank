package sim

// Vec2 é um ponto ou vetor no plano do jogo. Y cresce para BAIXO (é o eixo da tela e o do
// labirinto).
type Vec2 struct {
	X float64
	Y float64
}

// Aabb é um retângulo alinhado aos eixos — a única forma de parede que existe no jogo.
type Aabb struct {
	X float64
	Y float64
	W float64
	H float64
}

// Maze é o labirinto pronto. A origem fica em (0,0), SEM deslocamento de centralização: quem
// renderiza decide onde colocar na tela.
type Maze struct {
	Cols  int
	Rows  int
	Cell  float64
	Walls []Aabb

	// Cache das paredes infladas pelo raio da bala. No TypeScript isso é um `WeakMap` de módulo;
	// aqui mora no próprio labirinto, o que além de mais simples torna a simulação segura para
	// rodar várias partidas em paralelo (a varredura de 10.000 seeds faz exatamente isso).
	// `expandidasLen` invalida o cache quando a morte súbita remove uma parede.
	expandidas    []Aabb
	expandidasLen int
}

// Tank é um jogador vivo ou morto na arena.
type Tank struct {
	ID string
	X  float64
	Y  float64
	// Para onde o chassi APONTA. Desde o movimento absoluto é puramente cosmético: persegue
	// `Input.Mover` a TurnRate, mas quem decide o deslocamento é `Input.Mover`, não ele.
	Heading float64
	// Direção da torre; gira até `Input.Aim` a TurretRate. A BALA sai daqui.
	Turret           float64
	Alive            bool
	FireCooldownLeft float64

	// -----------------------------------------------------------------------------------------
	// POWER-UPS — quatro bônus ADITIVOS, todos com "sem efeito" no valor ZERO.
	//
	// No TypeScript são campos opcionais (`ricochete?: number`); aqui são campos comuns, porque em
	// Go o zero-value já é exatamente o "sem power-up" que o `?? 0` do outro lado produz. Nenhuma
	// regra do jogo pergunta "tem power-up?": cada linha soma o bônus ao valor de tuning e segue.
	//
	// Quem LIGA e DESLIGA estes campos é a camada de power-ups (ainda não portada); a simulação
	// só os lê.
	// -----------------------------------------------------------------------------------------

	// Rebotes EXTRAS que as balas disparadas A PARTIR DE AGORA recebem. Não afeta bala já em voo:
	// o número é COPIADO para `Bullet.Ricochete` no instante do disparo, e é a cópia que manda.
	Ricochete int
	// Balas simultâneas EXTRAS, somadas ao teto de MaxBulletsByPlayers.
	Municao int
	// Fração do cooldown de tiro descontada. 0,5 = recarrega na metade do tempo.
	Recarga float64
	// Fração EXTRA de velocidade de deslocamento. 0,35 = +35%.
	Turbo float64
}

// Bullet é um projétil em voo.
type Bullet struct {
	ID      string
	OwnerID string
	X       float64
	Y       float64
	VX      float64
	VY      float64
	Bounces int
	Age     float64
	// Rebotes EXTRAS DESTA bala, acima de MaxBounces, carimbados no disparo a partir de
	// `Tank.Ricochete`. 0 = bala comum.
	//
	// O carimbo é o ponto inteiro do desenho. A bala não trafega pela rede: cada cliente simula a
	// trajetória localmente, e o valor viaja junto dela em `BulletSpawnMsg.ricochete`. Ler o efeito
	// do atirador na hora de simular faria a bala trocar de regra no meio do voo, no instante em
	// que o power-up expirasse no dono — e trocaria em instantes diferentes em cada tela.
	Ricochete int
}

// Input é o comando de um tanque num tick. Não confundir com o `InputMsg` da rede: o servidor
// traduz um no outro antes de chamar `Step`.
type Input struct {
	// Direção do movimento em radianos, em coordenadas de mundo. `MoverAtivo == false` é o
	// `null` do TypeScript: parado.
	Mover      float64
	MoverAtivo bool
	Fire       bool
	// Ângulo absoluto para onde a torre deve apontar. `AimAtivo == false` é o `undefined` do
	// TypeScript: a torre fica onde está.
	Aim      float64
	AimAtivo bool
}

// SimState é o estado inteiro da simulação num tick.
//
// `Tanks` é um SLICE, e não um mapa, por uma razão de determinismo e não de gosto: o TypeScript
// usa `Map<string, Tank>` e percorre `tanks.values()`, que devolve os tanques na ordem em que
// foram inseridos. `range` sobre um mapa em Go embaralha de propósito — usar mapa aqui faria a
// ordem de resolução de colisões mudar a cada execução, e com ela quem morre quando duas balas
// chegam no mesmo tick. O índice por ID existe só para busca.
type SimState struct {
	Tick         int
	Maze         *Maze
	Tanks        []*Tank
	porID        map[string]*Tank
	Bullets      []*Bullet
	NextBulletID int

	rascunho rascunho
}

// NewSimState monta o estado a partir dos tanques na ordem em que eles devem ser processados.
func NewSimState(maze *Maze, tanks []*Tank) *SimState {
	s := &SimState{
		Maze:  maze,
		Tanks: tanks,
		porID: make(map[string]*Tank, len(tanks)),
	}
	for _, t := range tanks {
		s.porID[t.ID] = t
	}
	return s
}

// Tank devolve o tanque com o ID dado, ou nil.
func (s *SimState) Tank(id string) *Tank { return s.porID[id] }

// TipoEvento identifica o tipo de um SimEvent.
type TipoEvento string

const (
	EvShot          TipoEvento = "shot"
	EvBounce        TipoEvento = "bounce"
	EvDeath         TipoEvento = "death"
	EvBulletExpired TipoEvento = "bullet_expired"
	EvBulletClash   TipoEvento = "bullet_clash"
)

// SimEvent é a união de eventos do TypeScript achatada numa struct só. Achatar em vez de usar
// uma interface é intencional: os eventos são serializados campo a campo na comparação de
// paridade, e uma struct fixa torna essa serialização trivialmente idêntica à do lado TS.
//
// Campos não usados por um tipo de evento ficam no zero e não são serializados.
type SimEvent struct {
	Type TipoEvento
	Tick int

	// shot, bounce, bullet_expired
	BulletID string
	X        float64
	Y        float64

	// shot
	OwnerID string
	Angle   float64
	VX      float64
	VY      float64
	// Rebotes extras carimbados nesta bala. O servidor repassa em `BulletSpawnMsg`.
	Ricochete int

	// bounce
	Normal Vec2

	// death
	VictimID string
	KillerID string
	Autogol  bool

	// bullet_expired: "max_bounces" ou "life"
	Reason string

	// bullet_clash
	AID string
	BID string
}
