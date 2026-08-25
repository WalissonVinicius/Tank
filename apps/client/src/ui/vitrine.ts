// "Attract mode": a arena de verdade rodando sozinha com bots atrás do lobby, desfocada e
// escurecida pelo CSS. É o que tira do lobby a cara de formulário — quem abre o link já vê o
// jogo acontecendo antes de entrar.
//
// Não há nada de novo de simulação aqui: é a MESMA `step()` da shared-sim com os MESMOS bots do
// servidor, alimentando o Renderer pelas APIs públicas dele. Nenhum efeito que roube a atenção —
// sem tremor de câmera, sem hitstop, sem som.

import { PLAYER_COLORS, TICK_HZ } from '@tank/protocol';
import { makeBot, makeMaze, mulberry32, spawnPoints, step } from '@tank/shared-sim';
import type { Bot, Input, Maze, SimState, Tank, Vec2 } from '@tank/shared-sim';
import type { Renderer } from '../render/Renderer.js';

const DT = 1 / TICK_HZ;
/** Pausa entre uma rodada de vitrine e a próxima, em segundos. */
const RESPIRO = 1.5;

interface Piloto {
  id: string;
  color: number;
  bot: Bot;
}

function alvoMaisProximo(tank: Tank, tanks: Map<string, Tank>, maze: Maze): Vec2 {
  let best: Tank | null = null;
  let bestDist = Infinity;
  for (const other of tanks.values()) {
    if (other.id === tank.id || !other.alive) continue;
    const d = (other.x - tank.x) ** 2 + (other.y - tank.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = other;
    }
  }
  if (best) return { x: best.x, y: best.y };
  return { x: (maze.cols * maze.cell) / 2, y: (maze.rows * maze.cell) / 2 };
}

export class Vitrine {
  private state!: SimState;
  private pilotos: Piloto[] = [];
  private acumulador = 0;
  private ultimo = 0;
  private descanso = 0;
  private rodada = 0;
  private viva = true;

  constructor(
    private readonly renderer: Renderer,
    private readonly seed: number,
    private readonly quantos = 6,
  ) {
    this.novaRodada();
  }

  private novaRodada(): void {
    this.rodada += 1;
    const semente = this.seed + this.rodada * 7919;
    // A vitrine é decoração local (ninguém prevê bala em cima dela), então pode ler a proporção
    // desta tela direto — é o que faz o fundo do lobby preencher a janela igual ao jogo.
    const maze = makeMaze(semente, this.quantos, this.renderer.aspectoDaArena());
    const rng = mulberry32(semente);
    const spawns = spawnPoints(maze, this.quantos, rng);

    const tanks = new Map<string, Tank>();
    this.pilotos = [];
    for (let i = 0; i < this.quantos; i++) {
      const id = `v${i}`;
      const spawn = spawns[i]!;
      const heading = rng.next() * Math.PI * 2;
      tanks.set(id, { id, x: spawn.x, y: spawn.y, heading, turret: heading, alive: true, fireCooldownLeft: 0 });
      this.pilotos.push({ id, color: PLAYER_COLORS[i % PLAYER_COLORS.length]!, bot: makeBot(mulberry32(semente + i * 104729)) });
    }

    this.state = { tick: 0, maze, tanks, bullets: [], nextBulletId: 0 };
    this.descanso = 0;
    this.renderer.setMaze(maze);
  }

  /** Avança a vitrine até `agora` e desenha. Chamar uma vez por frame enquanto o lobby está na tela. */
  frame(agora: number): void {
    if (!this.viva) return;
    if (this.ultimo === 0) this.ultimo = agora;
    // Teto curto de propósito: aba em segundo plano não deve acumular minutos de simulação para
    // rodar de uma vez quando o jogador volta.
    this.acumulador = Math.min(this.acumulador + (agora - this.ultimo) / 1000, 0.5);
    this.ultimo = agora;

    while (this.acumulador >= DT) {
      this.acumulador -= DT;
      this.tick();
    }

    this.renderer.sync({
      tanks: [...this.state.tanks.values()].map((t) => ({
        id: t.id,
        x: t.x,
        y: t.y,
        angle: t.heading,
        turret: t.turret,
        color: this.pilotos.find((p) => p.id === t.id)?.color ?? 0xffffff,
        alive: t.alive,
        name: '',
      })),
      bullets: this.state.bullets.map((b) => ({ x: b.x, y: b.y, color: this.pilotos.find((p) => p.id === b.ownerId)?.color })),
      me: '',
    });
  }

  private tick(): void {
    if (this.descanso > 0) {
      this.descanso -= DT;
      if (this.descanso <= 0) this.novaRodada();
      return;
    }

    const inputs = new Map<string, Input>();
    for (const piloto of this.pilotos) {
      const tank = this.state.tanks.get(piloto.id)!;
      if (!tank.alive) continue;
      inputs.set(
        piloto.id,
        piloto.bot.think(tank, alvoMaisProximo(tank, this.state.tanks, this.state.maze), this.state.maze, this.state.tick, {
          bullets: this.state.bullets,
        }),
      );
    }

    for (const ev of step(this.state, inputs, DT)) {
      if (ev.type === 'shot') {
        this.renderer.onShot(ev.x, ev.y, ev.angle, this.pilotos.find((p) => p.id === ev.ownerId)?.color ?? 0xffffff);
      } else if (ev.type === 'bounce') {
        this.renderer.onBounce(ev.x, ev.y);
      } else if (ev.type === 'death') {
        this.renderer.onDeath(ev.x, ev.y, this.pilotos.find((p) => p.id === ev.victimId)?.color ?? 0xffffff);
      } else if (ev.type === 'bullet_expired' && ev.reason === 'life') {
        this.renderer.onBulletExplode(ev.x, ev.y, 0xffb347);
      }
    }
    this.state.tick++;

    const vivos = [...this.state.tanks.values()].filter((t) => t.alive).length;
    // Rodada de vitrine dura no máximo 40 s: se os bots se enrolarem, troca de labirinto na
    // mesma cadência de uma rodada real.
    if (vivos <= 1 || this.state.tick > 40 * TICK_HZ) this.descanso = RESPIRO;
  }

  /** Para a vitrine — o labirinto da partida de verdade assume o renderer a partir daqui. */
  parar(): void {
    this.viva = false;
  }
}
