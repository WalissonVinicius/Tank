package sim

import "github.com/simplex/tank/go/internal/jsmath"

// Porte de `packages/shared-sim/src/collision.ts`.

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// CircleVsAabbSlide empurra o círculo para fora de todas as paredes penetradas, corrigindo só o
// eixo penetrado — o tanque desliza ao raspar em vez de travar. Duas passadas resolvem o caso
// comum de penetração simultânea em duas paredes (quina externa).
func CircleVsAabbSlide(pos Vec2, radius float64, aabbs []Aabb) Vec2 {
	x, y := pos.X, pos.Y
	for pass := 0; pass < 2; pass++ {
		for i := range aabbs {
			wall := &aabbs[i]
			cx := clamp(x, wall.X, wall.X+wall.W)
			cy := clamp(y, wall.Y, wall.Y+wall.H)
			dx := x - cx
			dy := y - cy
			distSq := dx*dx + dy*dy
			if distSq >= radius*radius {
				continue
			}
			// `Math.sqrt(distSq) || 0.0001` do TypeScript: o `||` troca o zero por 0,0001 para
			// não dividir por zero quando o centro está exatamente sobre a borda.
			dist := jsmath.Sqrt(distSq)
			if dist == 0 {
				dist = 0.0001
			}
			nx := dx / dist
			ny := dy / dist
			penetration := radius - dist
			x += nx * penetration
			y += ny * penetration
		}
	}
	return Vec2{X: x, Y: y}
}

// Hit é o resultado de um raycast contra as paredes.
type Hit struct {
	Point    Vec2
	Normal   Vec2
	Distance float64
	T        float64 // 0..1 ao longo do segmento from→to
}

// naoBate sinaliza ausência de interseção sem precisar de um ponteiro nulo.
var naoBate = jsmath.Inf()

const epsSlab = 1e-9

// Resultado do slab test, publicado em campos do rascunho para não alocar. No TypeScript isso
// são variáveis de módulo; aqui vive no estado, porque a varredura de paridade roda várias
// simulações em paralelo e variável de pacote seria compartilhada entre elas.
type slabScratch struct {
	clipNear float64
	clipFar  float64
	clipSign float64

	hitT  float64
	hitNx float64
	hitNy float64
}

// clipAxis devolve `false` quando o eixo já elimina a parede; senão publica em clipNear/Far/Sign.
func (s *slabScratch) clipAxis(o, d, lo, hi float64) bool {
	if jsmath.Abs(d) < epsSlab {
		if o < lo || o > hi {
			return false
		}
		s.clipNear = jsmath.NegInf()
		s.clipFar = jsmath.Inf()
		s.clipSign = 0
		return true
	}
	t1 := (lo - o) / d
	t2 := (hi - o) / d
	if t1 < t2 {
		s.clipNear = t1
		s.clipFar = t2
		s.clipSign = -1
	} else {
		s.clipNear = t2
		s.clipFar = t1
		s.clipSign = 1
	}
	return true
}

// segmentVsAabb devolve o `t` de entrada no AABB, ou `naoBate`. Quando bate, publica a normal.
func (s *slabScratch) segmentVsAabb(ox, oy, dx, dy float64, wall *Aabb) float64 {
	if !s.clipAxis(ox, dx, wall.X, wall.X+wall.W) {
		return naoBate
	}
	xNear, xFar, xSign := s.clipNear, s.clipFar, s.clipSign

	if !s.clipAxis(oy, dy, wall.Y, wall.Y+wall.H) {
		return naoBate
	}
	yNear, yFar, ySign := s.clipNear, s.clipFar, s.clipSign

	tEnter := xNear
	if yNear > tEnter {
		tEnter = yNear
	}
	tExit := xFar
	if yFar < tExit {
		tExit = yFar
	}
	if tEnter > tExit+epsSlab {
		return naoBate
	}
	if tEnter < -epsSlab || tEnter > 1+epsSlab {
		return naoBate
	}

	// Quina: quando os dois eixos entram no mesmo instante, soma as duas normais (refletindo nos
	// dois eixos ao mesmo tempo) em vez de escolher um eixo dominante arbitrário.
	nx, ny := 0.0, 0.0
	if xNear >= tEnter-epsSlab {
		nx = xSign
	}
	if yNear >= tEnter-epsSlab {
		ny = ySign
	}
	length := jsmath.Hypot(nx, ny)
	if length == 0 {
		length = 1
	}
	s.hitNx = nx / length
	s.hitNy = ny / length
	switch {
	case tEnter < 0:
		s.hitT = 0
	case tEnter > 1:
		s.hitT = 1
	default:
		s.hitT = tEnter
	}
	return s.hitT
}

// RaycastSegment é o CCD da bala: testa o segmento percorrido no tick inteiro contra cada
// parede, não só o ponto final. Quando duas paredes vizinhas empatam no menor `t`, as normais
// das duas são somadas — mesmo tratamento de quina do slab test, aplicado entre paredes
// distintas.
//
// Duas passadas (achar o menor t, depois somar as normais dos empatados) em vez de guardar a
// lista de acertos: refazer o slab test é aritmética pura e sai mais barato que alocar.
func (s *slabScratch) RaycastSegment(from, to Vec2, aabbs []Aabb) (Hit, bool) {
	dx := to.X - from.X
	dy := to.Y - from.Y

	minT := naoBate
	for i := range aabbs {
		t := s.segmentVsAabb(from.X, from.Y, dx, dy, &aabbs[i])
		if t < minT {
			minT = t
		}
	}
	if minT == naoBate {
		return Hit{}, false
	}

	const eps = 1e-6
	nx, ny := 0.0, 0.0
	for i := range aabbs {
		t := s.segmentVsAabb(from.X, from.Y, dx, dy, &aabbs[i])
		if t != naoBate && t-minT <= eps {
			nx += s.hitNx
			ny += s.hitNy
		}
	}
	length := jsmath.Hypot(nx, ny)
	if length == 0 {
		length = 1
	}
	return Hit{
		Point:    Vec2{X: from.X + dx*minT, Y: from.Y + dy*minT},
		Normal:   Vec2{X: nx / length, Y: ny / length},
		Distance: jsmath.Hypot(dx, dy) * minT,
		T:        minT,
	}, true
}

// Reflect é r = d − 2(d·n)n. Com normal diagonal (quina), reflete os dois eixos de uma vez pela
// própria fórmula, sem caso especial.
func Reflect(dir, normal Vec2) Vec2 {
	d := dir.X*normal.X + dir.Y*normal.Y
	return Vec2{X: dir.X - 2*d*normal.X, Y: dir.Y - 2*d*normal.Y}
}

// HasLineOfSight só responde "bate ou não bate" — sem ponto de impacto, sem normal. É o caminho
// mais chamado da simulação inteira.
func (s *slabScratch) HasLineOfSight(a, b Vec2, aabbs []Aabb) bool {
	dx := b.X - a.X
	dy := b.Y - a.Y
	for i := range aabbs {
		if s.segmentVsAabb(a.X, a.Y, dx, dy, &aabbs[i]) != naoBate {
			return false
		}
	}
	return true
}
