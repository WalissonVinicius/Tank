import { describe, expect, it } from 'vitest';
import { BULLET_LIFE, BULLET_SPEED, MAX_BOUNCES, TICK_HZ } from '@tank/protocol';
import { makeMaze, step } from '@tank/shared-sim';
import type { SimState } from '@tank/shared-sim';
import { BulletPredictor } from '../src/net/bullets.js';

const DT = 1 / TICK_HZ;

// O vetor vem PRONTO na mensagem (ver BulletSpawnMsg): o cliente nao recalcula cos/sin, para a
// trajetoria nao depender da trigonometria de cada ponta. Aqui ele e montado uma vez, como o
// servidor faria.
const ANGULO = 0.7;
const SPAWN = {
  id: 'b0',
  ownerId: 'jogador-a',
  x: 42,
  y: 42,
  angle: ANGULO,
  vx: Math.cos(ANGULO) * BULLET_SPEED,
  vy: Math.sin(ANGULO) * BULLET_SPEED,
  tick: 0,
};

function trajetoria(pred: BulletPredictor, ticks: number): { x: number; y: number }[] {
  const pontos: { x: number; y: number }[] = [];
  for (let i = 0; i < ticks; i++) {
    pred.tick(DT);
    const b = pred.bullets[0];
    if (b) pontos.push({ x: b.x, y: b.y });
  }
  return pontos;
}

/**
 * O contrato do modo online é que o servidor manda só `bullet_spawn` e cada cliente simula a
 * bala sozinho — só a MORTE é autoritativa. Isso só funciona se dois clientes com a mesma seed
 * de labirinto e a mesma mensagem de spawn produzirem exatamente a mesma trajetória, ricochetes
 * inclusive. É o que está sendo verificado aqui, sem navegador no meio.
 */
describe('BulletPredictor — a bala simulada localmente é determinística', () => {
  it('dois clientes com o mesmo labirinto e o mesmo spawn traçam trajetórias idênticas', () => {
    const maze = makeMaze(2024, 6);
    const clienteA = new BulletPredictor(maze);
    const clienteB = new BulletPredictor(maze);

    clienteA.spawn(SPAWN);
    clienteB.spawn(SPAWN);

    const a = trajetoria(clienteA, 300);
    const b = trajetoria(clienteB, 300);

    // O que importa é que os dois clientes viram exatamente os mesmos pontos, do spawn ao
    // último tick de vida da bala (que na Fase 10 termina no 2º toque de parede).
    expect(a.length).toBeGreaterThan(20);
    expect(a).toEqual(b);
  });

  it('bate exatamente na mesma trajetória que o `step()` do servidor para a mesma bala', () => {
    const maze = makeMaze(2024, 6);
    const cliente = new BulletPredictor(maze);
    cliente.spawn(SPAWN);

    // Réplica do lado servidor: mesma função `step` do shared-sim, mesma bala, mesmo dt.
    const servidor: SimState = {
      tick: 0,
      maze,
      tanks: new Map(),
      bullets: [
        {
          id: SPAWN.id,
          ownerId: SPAWN.ownerId,
          x: SPAWN.x,
          y: SPAWN.y,
          vx: Math.cos(SPAWN.angle) * BULLET_SPEED,
          vy: Math.sin(SPAWN.angle) * BULLET_SPEED,
          bounces: 0,
          age: 0,
        },
      ],
      nextBulletId: 1,
    };

    let ricochetes = 0;
    let ticksVivos = 0;
    for (let i = 0; i < 300; i++) {
      cliente.tick(DT);
      for (const ev of step(servidor, new Map(), DT)) {
        if (ev.type === 'bounce') ricochetes++;
      }
      const noCliente = cliente.bullets[0];
      const noServidor = servidor.bullets[0];
      expect(Boolean(noCliente)).toBe(Boolean(noServidor));
      if (!noCliente || !noServidor) break;
      expect(noCliente.x).toBe(noServidor.x);
      expect(noCliente.y).toBe(noServidor.y);
      expect(noCliente.bounces).toBe(noServidor.bounces);
      expect(noCliente.age).toBe(noServidor.age);
      ticksVivos = i + 1;
    }

    // A bala precisa ter de fato batido em parede, senão o teste não prova nada sobre ricochete.
    // Na Fase 10 ela gasta o rebote permitido e morre no toque seguinte — a paridade
    // cliente↔servidor é exercitada exatamente nesse ponto, que é onde as duas pontas têm que
    // concordar em DESCARTAR a bala no mesmo tick.
    expect(ricochetes).toBe(MAX_BOUNCES + 1);
    expect(ticksVivos * DT, 'a parede matou antes do teto de tempo').toBeLessThan(BULLET_LIFE);
    expect(cliente.bullets, 'as duas pontas descartam a bala no mesmo tick').toHaveLength(0);
    expect(servidor.bullets).toHaveLength(0);
  });

  it('trocar de labirinto (nova rodada) limpa as balas em voo', () => {
    const pred = new BulletPredictor(makeMaze(1, 6));
    pred.spawn(SPAWN);
    expect(pred.bullets).toHaveLength(1);

    pred.setMaze(makeMaze(2, 6));
    expect(pred.bullets).toHaveLength(0);
  });

  it('remover por id é idempotente — `bullet_dead` pode chegar depois da expiração local', () => {
    const pred = new BulletPredictor(makeMaze(1, 6));
    pred.spawn(SPAWN);
    pred.remove(SPAWN.id);
    pred.remove(SPAWN.id);
    expect(pred.bullets).toHaveLength(0);
  });
});
