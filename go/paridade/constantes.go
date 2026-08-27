package paridade

import "github.com/simplex/tank/go/protocol"

// Constantes despeja a tabela de tuning inteira no sink.
//
// Existe como etapa separada porque uma constante errada aparece na varredura de seeds como
// "tudo divergiu", sem dizer o quê. Aqui a resposta é uma linha: qual constante, e com que bits
// de cada lado.
//
// Os derivados (`TankRadius`, `WallThickness`…) são o motivo principal: eles são produto de dois
// float64 e o Go, se deixado à vontade, calcularia esse produto em precisão arbitrária antes de
// arredondar — resultado potencialmente diferente do que o JavaScript obtém.
func Constantes(s Sink) {
	num := func(nome string, v float64) { s.Registro(SecMaze, "const", nome, v) }
	inteiro := func(nome string, v int) { s.Registro(SecMaze, "const_int", nome, v) }

	inteiro("TICK_HZ", protocol.TickHz)
	inteiro("SNAPSHOT_HZ", protocol.SnapshotHz)
	num("CELL", protocol.Cell)
	num("TANK_SPEED", protocol.TankSpeed)
	num("BULLET_SPEED", protocol.BulletSpeed)
	num("TANK_RADIUS_F", protocol.TankRadiusF)
	num("BULLET_RADIUS_F", protocol.BulletRadiusF)
	num("WALL_THICKNESS_F", protocol.WallThicknessF)
	inteiro("MAX_BOUNCES", protocol.MaxBounces)
	num("BULLET_LIFE", protocol.BulletLife)
	inteiro("MAX_BULLETS", protocol.MaxBullets)
	num("FIRE_COOLDOWN", protocol.FireCooldown)
	num("TURN_RATE", protocol.TurnRate)
	num("SELF_IMMUNITY", protocol.SelfImmunity)
	inteiro("ROUNDS", protocol.Rounds)
	inteiro("ROUND_TIMEOUT", protocol.RoundTimeout)
	inteiro("COUNTDOWN", protocol.Countdown)
	num("TURRET_RATE", protocol.TurretRate)
	num("TANK_RADIUS", protocol.TankRadius)
	num("BULLET_RADIUS", protocol.BulletRadius)
	num("WALL_THICKNESS", protocol.WallThickness)
	num("BULLET_EXPLOSION_RADIUS", protocol.BulletExplosionRadius)
	num("SPAWN_LOS_MIN_DIST", protocol.SpawnLosMinDist)
	num("MAZE_ASPECT_MIN", protocol.MazeAspectMin)
	num("MAZE_ASPECT_MAX", protocol.MazeAspectMax)
	num("MAZE_ASPECT_DEFAULT", protocol.MazeAspectDefault)

	inteiro("POWERUP_MAX_RICOCHETE_EXTRA", protocol.PowerupMaxRicocheteExtra)
	for _, tipo := range protocol.TiposDePowerUp {
		num("POWERUP_"+tipo, protocol.PowerupValor[tipo])
	}

	for n := 2; n <= 10; n++ {
		d := protocol.MazeByPlayers[n]
		s.Registro(SecMaze, "densidade", n, d.Cols, d.Rows, d.BraidPct)
		s.Registro(SecMaze, "municao", n, protocol.MaxBulletsByPlayers[n])
	}
}

// DirecoesDeMovimento despeja as 16 combinações possíveis das quatro teclas de direção.
//
// É pouca coisa e é essencial: `direcaoDeMovimento` é a ponte entre o input que chega pela rede
// e o ângulo que a simulação usa, e ela passa por `atan2` — a função em que o Go mais diverge do
// V8 (21,48% dos valores). São só oito ângulos possíveis, mas se um deles sair um bit diferente,
// TODO tanque andando naquela diagonal anda para um lugar levemente diferente em cada ponta.
func DirecoesDeMovimento(s Sink) {
	for bits := 0; bits < 16; bits++ {
		up := bits&1 != 0
		down := bits&2 != 0
		left := bits&4 != 0
		right := bits&8 != 0
		ang, ativo := protocol.DirecaoDeMovimento(up, down, left, right)
		s.Registro(SecMaze, "direcao", bits, ativo, ang)
	}
}
