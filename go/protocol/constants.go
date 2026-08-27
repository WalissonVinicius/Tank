// Package protocol espelha `packages/protocol/src/constants.ts` — a tabela de tuning do Tank
// Ricochete.
//
// A fonte da verdade continua sendo o TypeScript. Este arquivo é uma CÓPIA, e a cópia é
// verificada: a etapa "constantes" de `go/compare.mjs` compara o padrão de bits de cada valor
// aqui com o do módulo TypeScript. Mudar o tuning de um lado só quebra a comparação na hora.
package protocol

const (
	TickHz     = 60
	SnapshotHz = 20
	Cell       = 84.0

	TankSpeed   = 60.0
	BulletSpeed = 215.0

	TankRadiusF     = 0.22
	BulletRadiusF   = 0.05
	WallThicknessF  = 0.12
	MaxBounces      = 1
	BulletLife      = 2.2
	MaxBullets      = 2
	FireCooldown    = 0.55
	TurnRate        = 3.2
	SelfImmunity    = 0.11
	Rounds          = 10
	RoundTimeout    = 45
	Countdown       = 3
	TurretRate      = 5.0
	MazeAspectMin   = 1.2
	MazeAspectMax   = 2.7
	SpawnLosMinDist = 5 * Cell
)

// Constantes derivadas.
//
// São `var` calculadas em tempo de execução, e não `const`, DE PROPÓSITO. Uma constante untyped
// do Go é avaliada em precisão arbitrária antes de virar float64, então `0.12 * 84` daria o
// double mais próximo de 10,08 exato — enquanto o JavaScript multiplica o double de 0,12 pelo
// double de 84 e arredonda o produto. Os dois coincidem na maioria dos casos e é justamente por
// isso que a diferença passaria despercebida até um ricochete cair do lado errado de uma parede.
// Forçando o cálculo em float64 aqui, a conta é a mesma dos dois lados.
var (
	TankRadius            = float64(TankRadiusF) * float64(Cell)
	BulletRadius          = float64(BulletRadiusF) * float64(Cell)
	WallThickness         = float64(WallThicknessF) * float64(Cell)
	BulletExplosionRadius = 0.55 * float64(Cell)
	MazeAspectDefault     = 16.0 / 9.0
)

// MazeDensity é o orçamento de células e o braiding de uma forma de labirinto.
type MazeDensity struct {
	Cols     int
	Rows     int
	BraidPct float64
}

// MazeByPlayers é o orçamento de células por número de jogadores. Acesso só por chave — nunca
// iterado — porque `range` sobre mapa em Go tem ordem aleatória de propósito.
var MazeByPlayers = map[int]MazeDensity{
	2:  {Cols: 6, Rows: 4, BraidPct: 0.65},
	3:  {Cols: 7, Rows: 5, BraidPct: 0.65},
	4:  {Cols: 8, Rows: 6, BraidPct: 0.65},
	5:  {Cols: 9, Rows: 6, BraidPct: 0.65},
	6:  {Cols: 8, Rows: 8, BraidPct: 0.65},
	7:  {Cols: 8, Rows: 8, BraidPct: 0.65},
	8:  {Cols: 9, Rows: 10, BraidPct: 0.65},
	9:  {Cols: 9, Rows: 11, BraidPct: 0.65},
	10: {Cols: 9, Rows: 13, BraidPct: 0.65},
}

// MaxBulletsByPlayers é o teto de balas vivas por jogador, por tamanho de sala.
var MaxBulletsByPlayers = map[int]int{
	2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2, 8: 2, 9: 1, 10: 1,
}
