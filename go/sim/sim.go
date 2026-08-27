package sim

import (
	"sort"
	"strconv"

	"github.com/simplex/tank/go/internal/jsmath"
	"github.com/simplex/tank/go/protocol"
)

// Porte de `packages/shared-sim/src/sim.ts`.

// Multiplicado em tempo de execução, e não como constante untyped: é a mesma conta que o
// JavaScript faz em `Math.PI * 2`. Aqui as duas formas coincidem, mas depender disso é apostar
// que a próxima constante derivada também vai coincidir.
var doisPi = jsmath.Pi() * 2

func normalizeAngle(a float64) float64 {
	r := jsmath.Mod(a, doisPi)
	if r > jsmath.Pi() {
		r -= doisPi
	}
	if r < -jsmath.Pi() {
		r += doisPi
	}
	return r
}

// angleTowards gira `current` na direção de `target` pelo caminho curto, gastando no máximo
// `maxStep` rad. É o que dá peso à torre: mudar de lado da tela custa tempo real, não um frame.
func angleTowards(current, target, maxStep float64) float64 {
	diff := normalizeAngle(target - current)
	if jsmath.Abs(diff) <= maxStep {
		return normalizeAngle(target)
	}
	return normalizeAngle(current + jsmath.Sign(diff)*maxStep)
}

func maxBulletsFor(playerCount int) int {
	n := int(jsmath.Min(10, jsmath.Max(2, jsmath.Round(float64(playerCount)))))
	if v, ok := protocol.MaxBulletsByPlayers[n]; ok {
		return v
	}
	return protocol.MaxBullets
}

var emptyInput = Input{}

// maxReflexoesPorTick é quantas reflexões a bala pode TENTAR resolver dentro de um mesmo tick.
// Como ela morre no rebote de nº MaxBounces+1, este teto só precisa cobrir o caso de quina dupla
// antes da morte; as duas iterações extras são folga numérica.
const maxReflexoesPorTick = protocol.MaxBounces + protocol.PowerupMaxRicocheteExtra + 3

// pathSeg é um trecho retilíneo percorrido por uma bala DENTRO de um tick. Uma bala que
// ricocheteia no meio do passo produz mais de um trecho. `t0`/`t1` são instantes relativos ao
// início do tick, em segundos — é o que permite comparar duas balas no MESMO instante.
type pathSeg struct {
	t0, t1 float64
	x0, y0 float64
	vx, vy float64
}

type clashPair struct {
	i, j int
	t    float64
	x, y float64
}

type explosao struct {
	x, y    float64
	ownerID string
}

// rascunho guarda os buffers reaproveitados entre ticks. No TypeScript são variáveis de módulo
// (a simulação é síncrona e single-thread); aqui vivem no estado, porque a varredura de paridade
// roda milhares de simulações em goroutines paralelas e estado de pacote seria compartilhado.
type rascunho struct {
	slab slabScratch

	segPool   []pathSeg
	segTop    int
	pathBegin []int
	pathEnd   []int

	clashT, clashX, clashY float64
	clashPool              []clashPair

	explosoes []explosao

	tanquesVivos []*Tank
	remaining    []*Bullet
	mortas       map[string]bool
	hitBulletIDs map[string]bool
}

func (r *rascunho) pushSeg(t0, t1, x0, y0, vx, vy float64) {
	if r.segTop < len(r.segPool) {
		r.segPool[r.segTop] = pathSeg{t0, t1, x0, y0, vx, vy}
	} else {
		r.segPool = append(r.segPool, pathSeg{t0, t1, x0, y0, vx, vy})
	}
	r.segTop++
}

// expandWalls devolve as paredes infladas pelo raio da bala. O cache vive no labirinto e é
// invalidado pelo tamanho do slice, porque a morte súbita remove parede mutando o slice no lugar.
func expandWalls(m *Maze, margin float64) []Aabb {
	if m.expandidas != nil && m.expandidasLen == len(m.Walls) {
		return m.expandidas
	}
	expanded := make([]Aabb, len(m.Walls))
	for i, w := range m.Walls {
		expanded[i] = Aabb{X: w.X - margin, Y: w.Y - margin, W: w.W + margin*2, H: w.H + margin*2}
	}
	m.expandidas = expanded
	m.expandidasLen = len(m.Walls)
	return expanded
}

func stepTanks(state *SimState, inputs map[string]Input, dt float64, events *[]SimEvent) {
	maxBullets := maxBulletsFor(len(state.Tanks))
	r := &state.rascunho

	for _, tank := range state.Tanks {
		if !tank.Alive {
			continue
		}
		input, ok := inputs[tank.ID]
		if !ok {
			input = emptyInput
		}

		// Movimento ABSOLUTO: o tanque anda para onde o input mandou, no mesmo tick, na velocidade
		// cheia. O chassi vira para essa direção a TurnRate só como ENFEITE — nenhuma linha abaixo
		// depende de `tank.Heading` para deslocar.
		//
		// Diagonal não anda mais rápido que reto porque `Mover` é um ÂNGULO: cos/sen sempre dão um
		// vetor de módulo 1, não há o que normalizar depois.
		if input.MoverAtivo {
			tank.Heading = angleTowards(tank.Heading, input.Mover, protocol.TurnRate*dt)

			// `Turbo` é bônus ADITIVO com zero-value neutro — sem power-up a conta é a de sempre,
			// e `x * (1 + 0)` é exato em IEEE-754, então a paridade não muda por causa dele.
			velocidade := protocol.TankSpeed * (1 + tank.Turbo)
			candidate := Vec2{
				X: tank.X + jsmath.Cos(input.Mover)*velocidade*dt,
				Y: tank.Y + jsmath.Sin(input.Mover)*velocidade*dt,
			}
			resolved := CircleVsAabbSlide(candidate, protocol.TankRadius, state.Maze.Walls)
			tank.X = resolved.X
			tank.Y = resolved.Y
		}

		// Torre independente do chassi: persegue o ângulo de mira do input a TurretRate. Sem `Aim`
		// no input a torre fica onde está.
		if input.AimAtivo {
			tank.Turret = angleTowards(tank.Turret, input.Aim, protocol.TurretRate*dt)
		}

		if tank.FireCooldownLeft > 0 {
			tank.FireCooldownLeft = jsmath.Max(0, tank.FireCooldownLeft-dt)
		}

		if input.Fire && tank.FireCooldownLeft <= 0 {
			aliveOwned := 0
			for _, bullet := range state.Bullets {
				if bullet.OwnerID == tank.ID {
					aliveOwned++
				}
			}

			// `Municao` soma ao teto de balas simultâneas; 0 sem power-up.
			if aliveOwned < maxBullets+tank.Municao {
				// A bala sai pela boca do CANO, não pela frente do chassi: com torre livre, os dois
				// apontam para lados diferentes na maior parte do tempo.
				offset := protocol.TankRadius + protocol.BulletRadius + 4
				dirX := jsmath.Cos(tank.Turret)
				dirY := jsmath.Sin(tank.Turret)
				bx := tank.X + dirX*offset
				by := tank.Y + dirY*offset

				// O trecho centro→boca do cano é TESTADO contra as paredes antes de a bala existir.
				// Encostado numa parede com a torre virada para ela, esses ~27 px de offset
				// atravessavam a geometria e a bala nascia do outro lado. Havendo parede no meio,
				// ela nasce encostada do lado de DENTRO e ricocheteia normalmente no tick seguinte.
				boca, bateu := r.slab.RaycastSegment(
					Vec2{X: tank.X, Y: tank.Y},
					Vec2{X: bx, Y: by},
					expandWalls(state.Maze, protocol.BulletRadius),
				)
				if bateu {
					bx = boca.Point.X + boca.Normal.X*1e-4
					by = boca.Point.Y + boca.Normal.Y*1e-4
				}

				bullet := &Bullet{
					ID:      "b" + strconv.Itoa(state.NextBulletID),
					OwnerID: tank.ID,
					X:       bx,
					Y:       by,
					VX:      dirX * protocol.BulletSpeed,
					VY:      dirY * protocol.BulletSpeed,
					// O CARIMBO: o efeito de ricochete é COPIADO do atirador para a bala agora, e nunca
					// mais consultado no dono. É o que faz uma bala disparada com ricochete duplo
					// continuar com ricochete duplo depois de o power-up expirar em quem atirou — e é o
					// que permite ao cliente simular a mesma trajetória sem saber nada sobre o estado
					// atual do atirador.
					Ricochete: tank.Ricochete,
				}
				state.NextBulletID++
				state.Bullets = append(state.Bullets, bullet)
				// `Recarga` corta uma fração do cooldown; 0 sem power-up.
				tank.FireCooldownLeft = protocol.FireCooldown * (1 - tank.Recarga)
				*events = append(*events, SimEvent{
					Type:      EvShot,
					OwnerID:   tank.ID,
					BulletID:  bullet.ID,
					X:         bx,
					Y:         by,
					Angle:     tank.Turret,
					VX:        bullet.VX,
					VY:        bullet.VY,
					Ricochete: bullet.Ricochete,
					Tick:      state.Tick,
				})
			}
		}
	}
}

// tankSeparationPasses é quantas passadas de relaxamento a separação tanque×tanque faz por tick.
// FIXO — nada de laço até convergir: o número de iterações é parte do determinismo, e uma
// condição de parada baseada em ponto flutuante daria contagens diferentes em máquinas
// diferentes.
const tankSeparationPasses = 3

// resolveTankOverlaps é separação GEOMÉTRICA, não física de impulso: cada tanque recua metade da
// penetração ao longo da linha que liga os centros. Sem massa, sem quique e sem velocidade
// acumulada — o jogo não tem inércia de tanque.
//
// Determinismo: os pares são percorridos numa ordem total explícita pelo ID, com número FIXO de
// passadas. A comparação de strings do Go é byte a byte em UTF-8 e a do JavaScript é por unidade
// UTF-16; para os IDs do jogo (ASCII) as duas dão a mesma ordem.
func resolveTankOverlaps(state *SimState) {
	r := &state.rascunho
	r.tanquesVivos = r.tanquesVivos[:0]
	for _, tank := range state.Tanks {
		if tank.Alive {
			r.tanquesVivos = append(r.tanquesVivos, tank)
		}
	}
	vivos := r.tanquesVivos
	if len(vivos) < 2 {
		return
	}
	sort.SliceStable(vivos, func(i, j int) bool { return vivos[i].ID < vivos[j].ID })

	minDist := protocol.TankRadius * 2
	minDist2 := minDist * minDist

	for pass := 0; pass < tankSeparationPasses; pass++ {
		for i := 0; i < len(vivos); i++ {
			a := vivos[i]
			for j := i + 1; j < len(vivos); j++ {
				b := vivos[j]
				dx := b.X - a.X
				dy := b.Y - a.Y
				dist2 := dx*dx + dy*dy
				if dist2 >= minDist2 {
					continue
				}

				dist := jsmath.Sqrt(dist2)
				// Centros exatamente coincidentes não têm direção de separação. O eixo X e o sinal
				// saem da ordem dos IDs, que é a mesma nas duas pontas — qualquer sorteio aqui
				// quebraria o determinismo justamente no caso degenerado.
				nx, ny := 1.0, 0.0
				if dist > 1e-6 {
					nx = dx / dist
					ny = dy / dist
				}
				meia := (minDist - dist) / 2
				a.X -= nx * meia
				a.Y -= ny * meia
				b.X += nx * meia
				b.Y += ny * meia
			}
		}

		for _, tank := range vivos {
			resolved := CircleVsAabbSlide(Vec2{X: tank.X, Y: tank.Y}, protocol.TankRadius, state.Maze.Walls)
			tank.X = resolved.X
			tank.Y = resolved.Y
		}
	}
}

// stepBullets faz o CCD por bala, com "tempo restante" repassado entre reflexões dentro do mesmo
// tick — uma bala que bate perto de uma quina continua a trajetória refletida no mesmo passo em
// vez de parar encostada na parede por um tick.
//
// Além de mover, registra o CAMINHO de cada bala sobrevivente: a colisão bala×bala precisa do
// trajeto inteiro do tick, não só da posição final.
func stepBullets(state *SimState, dt float64, events *[]SimEvent) {
	r := &state.rascunho
	expandedWalls := expandWalls(state.Maze, protocol.BulletRadius)
	r.remaining = r.remaining[:0]
	r.segTop = 0

	for _, bullet := range state.Bullets {
		bullet.Age += dt
		if bullet.Age > protocol.BulletLife {
			// Fim de vida não é "sumiu", é explosão. A posição vai no evento porque é dela que o
			// render tira o lugar do estouro.
			*events = append(*events, SimEvent{
				Type:     EvBulletExpired,
				BulletID: bullet.ID,
				Reason:   "life",
				X:        bullet.X,
				Y:        bullet.Y,
				Tick:     state.Tick,
			})
			r.registrarExplosao(bullet.X, bullet.Y, bullet.OwnerID)
			continue
		}

		segStart := r.segTop
		elapsed := 0.0
		timeLeft := dt
		viva := true
		for iter := 0; iter < maxReflexoesPorTick && timeLeft > 0; iter++ {
			from := Vec2{X: bullet.X, Y: bullet.Y}
			to := Vec2{X: bullet.X + bullet.VX*timeLeft, Y: bullet.Y + bullet.VY*timeLeft}
			hit, bateu := r.slab.RaycastSegment(from, to, expandedWalls)
			if !bateu {
				r.pushSeg(elapsed, elapsed+timeLeft, from.X, from.Y, bullet.VX, bullet.VY)
				bullet.X = to.X
				bullet.Y = to.Y
				break
			}

			gasto := timeLeft * hit.T
			r.pushSeg(elapsed, elapsed+gasto, from.X, from.Y, bullet.VX, bullet.VY)
			elapsed += gasto

			bullet.X = hit.Point.X + hit.Normal.X*1e-4
			bullet.Y = hit.Point.Y + hit.Normal.Y*1e-4
			reflected := Reflect(Vec2{X: bullet.VX, Y: bullet.VY}, hit.Normal)
			bullet.VX = reflected.X
			bullet.VY = reflected.Y
			bullet.Bounces++
			*events = append(*events, SimEvent{
				Type:     EvBounce,
				BulletID: bullet.ID,
				X:        bullet.X,
				Y:        bullet.Y,
				Normal:   hit.Normal,
				Tick:     state.Tick,
			})

			timeLeft *= 1 - hit.T

			// O rebote de nº MaxBounces+1 mata a bala. Morte na parede é SILENCIOSA — a explosão é
			// a de fim de vida e a de choque entre balas, não a de encostar na parede.
			// O teto de rebotes é o da bala, não o do atirador — ver `Bullet.Ricochete`.
			if bullet.Bounces > protocol.MaxBounces+bullet.Ricochete {
				*events = append(*events, SimEvent{
					Type:     EvBulletExpired,
					BulletID: bullet.ID,
					Reason:   "max_bounces",
					X:        bullet.X,
					Y:        bullet.Y,
					Tick:     state.Tick,
				})
				viva = false
				break
			}
		}

		if viva {
			idx := len(r.remaining)
			for len(r.pathBegin) <= idx {
				r.pathBegin = append(r.pathBegin, 0)
				r.pathEnd = append(r.pathEnd, 0)
			}
			r.pathBegin[idx] = segStart
			r.pathEnd[idx] = r.segTop
			r.remaining = append(r.remaining, bullet)
		} else {
			// Devolve os trechos da bala morta ao pool: as faixas precisam ficar contíguas e
			// alinhadas com os índices de `remaining`.
			r.segTop = segStart
		}
	}

	state.Bullets = append(state.Bullets[:0], r.remaining...)
}

// bulletsClash testa se dois caminhos de bala ocuparam o mesmo espaço em algum instante do tick.
//
// Testar só a posição final deixaria duas balas se atravessarem sem detectar nada: a 215 px/s
// com raio ~4,2 px, basta um tick de 40 ms para uma passar inteira para o outro lado da outra.
//
// O teste é fechado e independente do `dt`: para cada par de trechos com sobreposição de TEMPO, o
// movimento relativo é uma reta `p + v·s`, e o mínimo de |p + v·s|² em `s ∈ [0, span]` sai da
// derivada, grampeado no intervalo.
//
// O recorte por TEMPO é o que separa "se cruzaram" de "cruzaram a mesma linha em instantes
// diferentes".
func (r *rascunho) bulletsClash(i, j int, raioSomado2 float64) bool {
	aBegin, aEnd := r.pathBegin[i], r.pathEnd[i]
	bBegin, bEnd := r.pathBegin[j], r.pathEnd[j]
	melhorT := jsmath.Inf()

	for ai := aBegin; ai < aEnd; ai++ {
		a := &r.segPool[ai]
		for bi := bBegin; bi < bEnd; bi++ {
			b := &r.segPool[bi]
			lo := a.t0
			if b.t0 > lo {
				lo = b.t0
			}
			hi := a.t1
			if b.t1 < hi {
				hi = b.t1
			}
			if hi < lo {
				continue
			}

			ax := a.x0 + a.vx*(lo-a.t0)
			ay := a.y0 + a.vy*(lo-a.t0)
			bx := b.x0 + b.vx*(lo-b.t0)
			by := b.y0 + b.vy*(lo-b.t0)
			px := ax - bx
			py := ay - by
			vx := a.vx - b.vx
			vy := a.vy - b.vy
			span := hi - lo
			vv := vx*vx + vy*vy

			s := 0.0
			if vv > 0 {
				s = -(px*vx + py*vy) / vv
				if s < 0 {
					s = 0
				} else if s > span {
					s = span
				}
			}

			dx := px + vx*s
			dy := py + vy*s
			if dx*dx+dy*dy > raioSomado2 {
				continue
			}

			t := lo + s
			if t >= melhorT {
				continue
			}
			melhorT = t
			r.clashT = t
			r.clashX = (ax + a.vx*s + bx + b.vx*s) / 2
			r.clashY = (ay + a.vy*s + by + b.vy*s) / 2
		}
	}

	return melhorT < jsmath.Inf()
}

// resolveBulletClashes: se duas balas se cruzam, as duas explodem — inclusive as do mesmo dono,
// porque regra sem exceção é a que o jogador consegue prever olhando para a tela.
//
// Determinismo: todos os pares são levantados ANTES de qualquer remoção e resolvidos numa ordem
// total explícita (instante do encontro, depois id das balas). Assim nem a ordem do slice nem a
// ordem de chegada dos `bullet_spawn` no cliente mudam o resultado.
func resolveBulletClashes(state *SimState, events *[]SimEvent) {
	n := len(state.Bullets)
	if n < 2 {
		return
	}
	r := &state.rascunho

	raioSomado := protocol.BulletRadius * 2
	raioSomado2 := raioSomado * raioSomado
	r.clashPool = r.clashPool[:0]

	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			if !r.bulletsClash(i, j, raioSomado2) {
				continue
			}
			// Par guardado com os índices na ordem do ID, não na ordem do slice: é o que faz o
			// evento e o critério de desempate saírem iguais nas duas pontas.
			pi, pj := i, j
			if state.Bullets[i].ID > state.Bullets[j].ID {
				pi, pj = j, i
			}
			r.clashPool = append(r.clashPool, clashPair{i: pi, j: pj, t: r.clashT, x: r.clashX, y: r.clashY})
		}
	}

	if len(r.clashPool) == 0 {
		return
	}

	ordem := r.clashPool
	sort.SliceStable(ordem, func(x, y int) bool {
		p, q := ordem[x], ordem[y]
		if p.t != q.t {
			return p.t < q.t
		}
		pa, qa := state.Bullets[p.i].ID, state.Bullets[q.i].ID
		if pa != qa {
			return pa < qa
		}
		return state.Bullets[p.j].ID < state.Bullets[q.j].ID
	})

	if r.mortas == nil {
		r.mortas = make(map[string]bool)
	}
	clear(r.mortas)
	for _, par := range ordem {
		a := state.Bullets[par.i]
		b := state.Bullets[par.j]
		// Uma bala explode uma vez só: se já morreu num encontro anterior deste mesmo tick, o par
		// seguinte que a envolve simplesmente não acontece.
		if r.mortas[a.ID] || r.mortas[b.ID] {
			continue
		}
		r.mortas[a.ID] = true
		r.mortas[b.ID] = true
		*events = append(*events, SimEvent{
			Type: EvBulletClash, AID: a.ID, BID: b.ID, X: par.x, Y: par.y, Tick: state.Tick,
		})
		r.registrarExplosao(par.x, par.y, a.OwnerID)
		r.registrarExplosao(par.x, par.y, b.OwnerID)
	}

	filtradas := state.Bullets[:0]
	for _, bala := range state.Bullets {
		if !r.mortas[bala.ID] {
			filtradas = append(filtradas, bala)
		}
	}
	state.Bullets = filtradas
}

// resolveBulletTankHits: bala×tanque mata em 1 toque. O dono só é atingido pela própria bala
// depois de SelfImmunity. Bala×bala é resolvido antes daqui — uma bala que se chocou com outra já
// saiu de `state.Bullets` e não chega a matar ninguém neste tick.
func resolveBulletTankHits(state *SimState, events *[]SimEvent) {
	r := &state.rascunho
	if r.hitBulletIDs == nil {
		r.hitBulletIDs = make(map[string]bool)
	}
	clear(r.hitBulletIDs)
	hitRadius := protocol.TankRadius + protocol.BulletRadius

	for _, tank := range state.Tanks {
		if !tank.Alive {
			continue
		}
		for _, bullet := range state.Bullets {
			if r.hitBulletIDs[bullet.ID] {
				continue
			}
			if bullet.OwnerID == tank.ID && bullet.Age < protocol.SelfImmunity {
				continue
			}

			dx := bullet.X - tank.X
			dy := bullet.Y - tank.Y
			if dx*dx+dy*dy > hitRadius*hitRadius {
				continue
			}

			tank.Alive = false
			r.hitBulletIDs[bullet.ID] = true
			*events = append(*events, SimEvent{
				Type:     EvDeath,
				VictimID: tank.ID,
				KillerID: bullet.OwnerID,
				X:        tank.X,
				Y:        tank.Y,
				Tick:     state.Tick,
				Autogol:  bullet.OwnerID == tank.ID,
			})
			break
		}
	}

	if len(r.hitBulletIDs) > 0 {
		filtradas := state.Bullets[:0]
		for _, b := range state.Bullets {
			if !r.hitBulletIDs[b.ID] {
				filtradas = append(filtradas, b)
			}
		}
		state.Bullets = filtradas
	}
}

// explosaoDeBalaELetal é o ÚNICO ponto que decide se a explosão de bala machuca alguém.
//
// Hoje a explosão (fim de vida e choque bala×bala) é PURAMENTE COSMÉTICA. Para torná-la letal
// basta trocar esta linha para `true`: `aplicarExplosoes` já mata todo tanque dentro de
// BulletExplosionRadius do ponto do estouro, atribuindo a morte ao dono da bala.
const explosaoDeBalaELetal = false

// registrarExplosao anota um estouro do tick. Uma bala que explode no choque registra o ponto de
// encontro.
func (r *rascunho) registrarExplosao(x, y float64, ownerID string) {
	r.explosoes = append(r.explosoes, explosao{x: x, y: y, ownerID: ownerID})
}

func aplicarExplosoes(state *SimState, events *[]SimEvent) {
	r := &state.rascunho
	if !explosaoDeBalaELetal {
		r.explosoes = r.explosoes[:0]
		return
	}

	raio2 := protocol.BulletExplosionRadius * protocol.BulletExplosionRadius
	for _, e := range r.explosoes {
		for _, tank := range state.Tanks {
			if !tank.Alive {
				continue
			}
			dx := tank.X - e.x
			dy := tank.Y - e.y
			if dx*dx+dy*dy > raio2 {
				continue
			}
			tank.Alive = false
			*events = append(*events, SimEvent{
				Type:     EvDeath,
				VictimID: tank.ID,
				KillerID: e.ownerID,
				X:        tank.X,
				Y:        tank.Y,
				Tick:     state.Tick,
				Autogol:  e.ownerID == tank.ID,
			})
		}
	}
	r.explosoes = r.explosoes[:0]
}

// Step roda um tick da simulação. Puro em relação a aleatoriedade: nenhuma decisão usa RNG não
// semeado, e `dt` é sempre recebido de fora.
func Step(state *SimState, inputs map[string]Input, dt float64) []SimEvent {
	events := make([]SimEvent, 0, 8)
	state.rascunho.explosoes = state.rascunho.explosoes[:0]
	stepTanks(state, inputs, dt, &events)
	resolveTankOverlaps(state)
	stepBullets(state, dt, &events)
	resolveBulletClashes(state, &events)
	resolveBulletTankHits(state, &events)
	aplicarExplosoes(state, &events)
	return events
}
