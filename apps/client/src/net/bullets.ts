// Simulação local das balas em modo online: ao receber `bullet_spawn`, a bala é criada aqui e
// segue a MESMA função `step()` da `shared-sim` usada pelo servidor — determinística, dá no
// mesmo lugar em todos os clientes (relatório G §4.2). O `tanks` do SimState fica sempre vazio:
// não há colisão bala×tanque a decidir localmente, só trajetória contra as paredes (a morte é
// sempre autoridade do servidor, via `tank_death`). A bala só sai daqui por `bullet_dead` (id
// removido) ou expiração local (`bullet_expired`, tratado como estética — o servidor também vai
// mandar `bullet_dead` para o mesmo id, então a remoção aqui é idempotente).
import { BULLET_SPEED } from '@tank/protocol';
import { step } from '@tank/shared-sim';
import type { Bullet, Maze, SimEvent, SimState } from '@tank/shared-sim';
import type { BulletSpawnMsg } from '@tank/protocol';

export class BulletPredictor {
  private state: SimState;

  constructor(maze: Maze) {
    this.state = { tick: 0, maze, tanks: new Map(), bullets: [], nextBulletId: 0 };
  }

  setMaze(maze: Maze): void {
    this.state.maze = maze;
    this.state.bullets = [];
  }

  spawn(msg: BulletSpawnMsg): void {
    const bullet: Bullet = {
      id: msg.id,
      ownerId: msg.ownerId,
      x: msg.x,
      y: msg.y,
      // Vetor VINDO DO SERVIDOR, nao recalculado aqui. Ver BulletSpawnMsg: recomputar
      // cos/sin faria a trajetoria depender da trigonometria de cada ponta.
      vx: msg.vx,
      vy: msg.vy,
      bounces: 0,
      age: 0,
    };
    this.state.bullets.push(bullet);
  }

  remove(id: string): void {
    this.state.bullets = this.state.bullets.filter((b) => b.id !== id);
  }

  tick(dt: number): SimEvent[] {
    const events = step(this.state, new Map(), dt);
    this.state.tick++;
    return events;
  }

  get bullets(): readonly Bullet[] {
    return this.state.bullets;
  }
}
