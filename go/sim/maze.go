package sim

import (
	"fmt"
	"sort"

	"github.com/simplex/tank/go/internal/jsmath"
	"github.com/simplex/tank/go/protocol"
)

// Porte de `packages/shared-sim/src/maze.ts`.

func densityFor(players float64) protocol.MazeDensity {
	n := int(jsmath.Min(10, jsmath.Max(2, jsmath.Round(players))))
	d, ok := protocol.MazeByPlayers[n]
	if !ok {
		panic(fmt.Sprintf("densidade de labirinto não definida para %d jogadores", n))
	}
	return d
}

// Piso de forma. Abaixo disso o "labirinto" vira um corredor reto e a geração perde sentido — e
// `SpawnPoints` precisa de pelo menos tantas células quanto jogadores (4×3 = 12 ≥ 10).
const (
	minRows = 3
	minCols = 4
)

// MazeShape devolve a forma do labirinto para uma proporção de tela.
//
// A saída NÃO é esticar nem cortar o labirinto: as células continuam quadradas, senão a bala
// deixa de ricochetear em 45°. O que muda é a FORMA da grade — o mesmo total de células,
// redistribuído entre colunas e linhas até `cols/rows` bater com a proporção da tela.
//
// Das duas formas candidatas (arredondando as linhas para baixo e para cima) fica a que menos
// erra a densidade calibrada; no empate ganha a MENOR, porque menos células = tanque maior na
// tela.
func MazeShape(players float64, aspect float64) protocol.MazeDensity {
	base := densityFor(players)
	alvoCelulas := float64(base.Cols * base.Rows)

	a := protocol.MazeAspectDefault
	if jsmath.IsFinite(aspect) {
		a = jsmath.Min(protocol.MazeAspectMax, jsmath.Max(protocol.MazeAspectMin, aspect))
	}

	linhasIdeais := jsmath.Sqrt(alvoCelulas / a)
	var melhor protocol.MazeDensity
	achou := false
	menorErro := jsmath.Inf()

	// Da menor para a maior: no empate de erro a primeira vence, e a primeira é sempre a de menos
	// células. Nada de ordenação — a ordem de avaliação já é o critério de desempate.
	for _, candidata := range [2]float64{jsmath.Floor(linhasIdeais), jsmath.Ceil(linhasIdeais)} {
		rows := int(jsmath.Max(minRows, candidata))
		cols := int(jsmath.Max(minCols, jsmath.Round(float64(rows)*a)))
		erro := jsmath.Abs(jsmath.Log(float64(cols*rows) / alvoCelulas))
		if erro < menorErro-1e-9 {
			menorErro = erro
			melhor = protocol.MazeDensity{Cols: cols, Rows: rows, BraidPct: base.BraidPct}
			achou = true
		}
	}

	if !achou {
		return protocol.MazeDensity{Cols: base.Cols, Rows: base.Rows, BraidPct: base.BraidPct}
	}
	return melhor
}

// wallGrid[x][y]: para `vw`, existe parede a leste da célula (x,y); para `hw`, ao sul.
type wallGrid [][]bool

func novaGrade(cols, rows int, valor bool) wallGrid {
	g := make(wallGrid, cols)
	for x := range g {
		g[x] = make([]bool, rows)
		if valor {
			for y := range g[x] {
				g[x][y] = true
			}
		}
	}
	return g
}

type vizinho struct {
	x, y, d int
}

// carve escava o labirinto por recursive backtracking com pilha explícita.
func carve(cols, rows int, rng *Rng) (vw, hw wallGrid) {
	vw = novaGrade(cols, rows, true)
	hw = novaGrade(cols, rows, true)
	visited := novaGrade(cols, rows, false)

	startX := rng.Int(cols)
	startY := rng.Int(rows)
	stack := [][2]int{{startX, startY}}
	visited[startX][startY] = true

	// Reaproveitado a cada iteração; o conteúdo é reconstruído do zero, então não há vazamento
	// de estado entre passos.
	vizinhos := make([]vizinho, 0, 4)

	for len(stack) > 0 {
		topo := stack[len(stack)-1]
		x, y := topo[0], topo[1]
		vizinhos = vizinhos[:0]
		if x < cols-1 && !visited[x+1][y] {
			vizinhos = append(vizinhos, vizinho{x + 1, y, 0})
		}
		if y < rows-1 && !visited[x][y+1] {
			vizinhos = append(vizinhos, vizinho{x, y + 1, 1})
		}
		if x > 0 && !visited[x-1][y] {
			vizinhos = append(vizinhos, vizinho{x - 1, y, 2})
		}
		if y > 0 && !visited[x][y-1] {
			vizinhos = append(vizinhos, vizinho{x, y - 1, 3})
		}

		if len(vizinhos) == 0 {
			stack = stack[:len(stack)-1]
			continue
		}
		n := Pick(rng, vizinhos)
		switch n.d {
		case 0:
			vw[x][y] = false
		case 1:
			hw[x][y] = false
		case 2:
			vw[n.x][n.y] = false
		default:
			hw[n.x][n.y] = false
		}
		visited[n.x][n.y] = true
		stack = append(stack, [2]int{n.x, n.y})
	}

	return vw, hw
}

type paredeInterna struct {
	vertical bool
	x, y     int
}

// braid remove uma fração das paredes internas, criando ciclos — é o que tira os becos sem saída
// e faz o ricochete valer a pena.
func braid(cols, rows int, vw, hw wallGrid, braidPct float64, rng *Rng) {
	internal := make([]paredeInterna, 0, cols*rows*2)
	for x := 0; x < cols; x++ {
		for y := 0; y < rows; y++ {
			if x < cols-1 && vw[x][y] {
				internal = append(internal, paredeInterna{true, x, y})
			}
			if y < rows-1 && hw[x][y] {
				internal = append(internal, paredeInterna{false, x, y})
			}
		}
	}
	Shuffle(rng, internal)
	remove := int(jsmath.Floor(float64(len(internal)) * braidPct))
	for i := 0; i < remove; i++ {
		p := internal[i]
		if p.vertical {
			vw[p.x][p.y] = false
		} else {
			hw[p.x][p.y] = false
		}
	}
}

// buildWalls funde paredes colineares adjacentes num único AABB — menos retângulos para o
// raycast percorrer, e é a ordem desta fusão que a comparação de paridade confere.
func buildWalls(cols, rows int, cell float64, vw, hw wallGrid) []Aabb {
	walls := make([]Aabb, 0, cols*rows)
	width := float64(cols) * cell
	height := float64(rows) * cell
	esp := protocol.WallThickness
	half := esp / 2

	walls = append(walls,
		Aabb{X: -half, Y: -half, W: width + esp, H: esp},
		Aabb{X: -half, Y: height - half, W: width + esp, H: esp},
		Aabb{X: -half, Y: -half, W: esp, H: height + esp},
		Aabb{X: width - half, Y: -half, W: esp, H: height + esp},
	)

	for x := 0; x < cols-1; x++ {
		y := 0
		for y < rows {
			if vw[x][y] {
				y2 := y
				for y2+1 < rows && vw[x][y2+1] {
					y2++
				}
				walls = append(walls, Aabb{
					X: float64(x+1)*cell - half,
					Y: float64(y)*cell - half,
					W: esp,
					H: float64(y2-y+1)*cell + esp,
				})
				y = y2 + 1
			} else {
				y++
			}
		}
	}

	for y := 0; y < rows-1; y++ {
		x := 0
		for x < cols {
			if hw[x][y] {
				x2 := x
				for x2+1 < cols && hw[x2+1][y] {
					x2++
				}
				walls = append(walls, Aabb{
					X: float64(x)*cell - half,
					Y: float64(y+1)*cell - half,
					W: float64(x2-x+1)*cell + esp,
					H: esp,
				})
				x = x2 + 1
			} else {
				x++
			}
		}
	}

	return walls
}

// MakeMaze gera o labirinto de uma rodada.
//
// `aspect` é a proporção largura/altura da ÁREA JOGÁVEL de quem vai desenhar, e NUNCA pode ser
// lida do tamanho da janela de cada cliente: derivar a forma localmente faria cada jogador gerar
// um labirinto diferente com a mesma seed. O servidor combina a proporção uma vez por rodada e a
// manda junto da seed.
func MakeMaze(seed uint32, players float64, aspect float64) *Maze {
	forma := MazeShape(players, aspect)
	rng := Mulberry32(seed)
	vw, hw := carve(forma.Cols, forma.Rows, rng)
	braid(forma.Cols, forma.Rows, vw, hw, forma.BraidPct, rng)
	walls := buildWalls(forma.Cols, forma.Rows, protocol.Cell, vw, hw)
	return &Maze{Cols: forma.Cols, Rows: forma.Rows, Cell: protocol.Cell, Walls: walls}
}

// CellCenter devolve o centro da célula (cx, cy).
func CellCenter(m *Maze, cx, cy int) Vec2 {
	return Vec2{X: (float64(cx) + 0.5) * m.Cell, Y: (float64(cy) + 0.5) * m.Cell}
}

func pointInAnyWall(walls []Aabb, px, py float64) bool {
	for i := range walls {
		w := &walls[i]
		if px >= w.X && px <= w.X+w.W && py >= w.Y && py <= w.Y+w.H {
			return true
		}
	}
	return false
}

// cellsConnected: duas células vizinhas estão conectadas se o ponto médio da fronteira entre
// elas não está dentro de nenhuma parede — assim validação e BFS funcionam só a partir de
// `Maze.Walls`, sem depender da grade de geração.
func cellsConnected(m *Maze, ax, ay, bx, by int) bool {
	midX := ((float64(ax)+0.5)*m.Cell + (float64(bx)+0.5)*m.Cell) / 2
	midY := ((float64(ay)+0.5)*m.Cell + (float64(by)+0.5)*m.Cell) / 2
	return !pointInAnyWall(m.Walls, midX, midY)
}

// neighborsOf devolve os vizinhos alcançáveis, na MESMA ordem do TypeScript (leste, oeste, sul,
// norte). A ordem importa: é ela que decide qual caminho o BFS encontra primeiro e, portanto,
// qual waypoint o bot persegue.
func neighborsOf(m *Maze, x, y int, buf [][2]int) [][2]int {
	buf = buf[:0]
	if x < m.Cols-1 && cellsConnected(m, x, y, x+1, y) {
		buf = append(buf, [2]int{x + 1, y})
	}
	if x > 0 && cellsConnected(m, x, y, x-1, y) {
		buf = append(buf, [2]int{x - 1, y})
	}
	if y < m.Rows-1 && cellsConnected(m, x, y, x, y+1) {
		buf = append(buf, [2]int{x, y + 1})
	}
	if y > 0 && cellsConnected(m, x, y, x, y-1) {
		buf = append(buf, [2]int{x, y - 1})
	}
	return buf
}

func bfsDistances(m *Maze, fromX, fromY int) [][]int {
	dist := make([][]int, m.Cols)
	for x := range dist {
		dist[x] = make([]int, m.Rows)
		for y := range dist[x] {
			dist[x][y] = -1
		}
	}
	dist[fromX][fromY] = 0
	queue := make([][2]int, 0, m.Cols*m.Rows)
	queue = append(queue, [2]int{fromX, fromY})
	buf := make([][2]int, 0, 4)
	for head := 0; head < len(queue); head++ {
		x, y := queue[head][0], queue[head][1]
		d := dist[x][y]
		for _, n := range neighborsOf(m, x, y, buf) {
			if dist[n[0]][n[1]] == -1 {
				dist[n[0]][n[1]] = d + 1
				queue = append(queue, n)
			}
		}
	}
	return dist
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// CellOf devolve a célula da grade que contém o ponto, sempre dentro dos limites.
func CellOf(m *Maze, p Vec2) (int, int) {
	return clampInt(int(jsmath.Floor(p.X/m.Cell)), 0, m.Cols-1),
		clampInt(int(jsmath.Floor(p.Y/m.Cell)), 0, m.Rows-1)
}

// NextStepTowards devolve o centro da célula vizinha que mais aproxima de `to` no grafo do
// labirinto. Puro e determinístico — só depende de `Maze.Walls`.
func NextStepTowards(m *Maze, from, to Vec2) Vec2 {
	sx, sy := CellOf(m, from)
	gx, gy := CellOf(m, to)
	if sx == gx && sy == gy {
		return to
	}

	dist := bfsDistances(m, gx, gy)
	here := dist[sx][sy]
	if here < 0 {
		return to
	}

	melhorDist := here
	var melhor [2]int
	achou := false
	for _, n := range neighborsOf(m, sx, sy, make([][2]int, 0, 4)) {
		d := dist[n[0]][n[1]]
		if d >= 0 && d < melhorDist {
			melhorDist = d
			melhor = n
			achou = true
		}
	}
	if achou {
		return CellCenter(m, melhor[0], melhor[1])
	}
	return to
}

// CountDeadEnds conta as células com exatamente uma saída.
func CountDeadEnds(m *Maze) int {
	count := 0
	buf := make([][2]int, 0, 4)
	for x := 0; x < m.Cols; x++ {
		for y := 0; y < m.Rows; y++ {
			if len(neighborsOf(m, x, y, buf)) == 1 {
				count++
			}
		}
	}
	return count
}

// MazeValidation é o veredito de `ValidateMaze`.
type MazeValidation struct {
	OK     bool
	Reason string
}

// ValidateMaze garante alcançabilidade total por flood fill, mais uma rede de segurança de
// regressão: acima de 50% de becos sem saída o braiding provavelmente não foi aplicado.
func ValidateMaze(m *Maze) MazeValidation {
	dist := bfsDistances(m, 0, 0)
	reachable := 0
	for x := 0; x < m.Cols; x++ {
		for y := 0; y < m.Rows; y++ {
			if dist[x][y] >= 0 {
				reachable++
			}
		}
	}
	total := m.Cols * m.Rows
	if reachable != total {
		return MazeValidation{OK: false, Reason: fmt.Sprintf("%d célula(s) inalcançável(is) a partir de (0,0)", total-reachable)}
	}

	deadEnds := CountDeadEnds(m)
	maxAllowed := int(jsmath.Ceil(float64(total) * 0.5))
	if deadEnds > maxAllowed {
		return MazeValidation{OK: false, Reason: fmt.Sprintf("%d becos sem saída, acima do esperado (%d)", deadEnds, maxAllowed)}
	}

	return MazeValidation{OK: true}
}

func distSq(a, b Vec2) float64 {
	dx := a.X - b.X
	dy := a.Y - b.Y
	return dx*dx + dy*dy
}

// seesCloseNeighbor: verdadeiro se `p` enxerga algum ponto de `others` a menos de `minDist` dele.
// A checagem de distância vem primeiro porque é ordens de grandeza mais barata que o raycast.
func seesCloseNeighbor(s *slabScratch, p Vec2, others []Vec2, walls []Aabb, minDist float64) bool {
	if minDist <= 0 {
		return false
	}
	limit := minDist * minDist
	for _, other := range others {
		if distSq(p, other) >= limit {
			continue
		}
		if s.HasLineOfSight(p, other, walls) {
			return true
		}
	}
	return false
}

// SpawnPoints escolhe os pontos de nascimento por farthest-point sampling sobre a distância real
// do grafo do labirinto: a cada passo entra a célula que maximiza a distância mínima aos spawns
// já escolhidos. Escolha gulosa, sem backtracking.
//
// A regra de linha de visão é LOCAL: ser visto de longe na largada não é injusto — injusto é
// nascer perto E à vista. Se nenhum candidato satisfizer o limiar, ele é relaxado em passos de
// uma célula até zero, e no limiar zero qualquer candidato serve, então o laço sempre termina.
func SpawnPoints(m *Maze, n int, rng *Rng) []Vec2 {
	if n <= 0 {
		return []Vec2{}
	}
	cells := make([][2]int, 0, m.Cols*m.Rows)
	for x := 0; x < m.Cols; x++ {
		for y := 0; y < m.Rows; y++ {
			cells = append(cells, [2]int{x, y})
		}
	}
	if n > len(cells) {
		panic("SpawnPoints: mais spawns pedidos que células no labirinto")
	}

	const unreachable = 1 << 28
	minGraphDist := make([]int32, len(cells))
	for i := range minGraphDist {
		minGraphDist[i] = unreachable
	}
	taken := make([]bool, len(cells))
	var scratch slabScratch

	absorb := func(cellIndex int) {
		dist := bfsDistances(m, cells[cellIndex][0], cells[cellIndex][1])
		for i, c := range cells {
			d := dist[c[0]][c[1]]
			value := int32(d)
			if d < 0 {
				value = unreachable
			}
			if value < minGraphDist[i] {
				minGraphDist[i] = value
			}
		}
	}

	firstIndex := rng.Int(len(cells))
	taken[firstIndex] = true
	absorb(firstIndex)
	chosen := []Vec2{CellCenter(m, cells[firstIndex][0], cells[firstIndex][1])}

	// Quantas vezes dá para descontar uma célula do limiar antes de ele chegar a zero.
	relaxLevels := int(jsmath.Ceil(protocol.SpawnLosMinDist / m.Cell))

	candidates := make([]int, 0, len(cells))
	for len(chosen) < n {
		// Candidatos livres ordenados pela distância mínima decrescente. O desempate é explícito
		// pelo índice da célula — nunca confiamos na estabilidade da ordenação.
		candidates = candidates[:0]
		for i := range cells {
			if !taken[i] {
				candidates = append(candidates, i)
			}
		}
		if len(candidates) == 0 {
			break
		}
		sort.SliceStable(candidates, func(i, j int) bool {
			a, b := candidates[i], candidates[j]
			if minGraphDist[a] != minGraphDist[b] {
				return minGraphDist[a] > minGraphDist[b]
			}
			return a < b
		})

		picked := -1
		for relax := 0; relax <= relaxLevels && picked < 0; relax++ {
			threshold := jsmath.Max(0, protocol.SpawnLosMinDist-float64(relax)*m.Cell)
			for _, i := range candidates {
				if seesCloseNeighbor(&scratch, CellCenter(m, cells[i][0], cells[i][1]), chosen, m.Walls, threshold) {
					continue
				}
				picked = i
				break
			}
		}
		if picked < 0 {
			picked = candidates[0]
		}

		taken[picked] = true
		absorb(picked)
		chosen = append(chosen, CellCenter(m, cells[picked][0], cells[picked][1]))
	}

	return chosen
}
