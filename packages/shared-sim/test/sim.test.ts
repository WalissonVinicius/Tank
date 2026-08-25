import { BULLET_LIFE, BULLET_SPEED, MAX_BOUNCES, SELF_IMMUNITY, TANK_RADIUS, TURRET_RATE } from '@tank/protocol';
import { describe, expect, it } from 'vitest';
import { step } from '../src/index.js';
import type { Bullet, Input, Maze, SimEvent, SimState, Tank } from '../src/index.js';

function emptyArenaMaze(): Maze {
  const cols = 4;
  const rows = 4;
  const cell = 84;
  const w = cols * cell;
  const h = rows * cell;
  const t = 12;
  const half = t / 2;
  return {
    cols,
    rows,
    cell,
    walls: [
      { x: -half, y: -half, w: w + t, h: t },
      { x: -half, y: h - half, w: w + t, h: t },
      { x: -half, y: -half, w: t, h: h + t },
      { x: w - half, y: -half, w: t, h: h + t },
    ],
  };
}

describe('sim.step', () => {
  it('autogol acontece depois da imunidade do atirador, e não antes', () => {
    const maze = emptyArenaMaze();
    const tank: Tank = { id: 'p1', x: 200, y: 200, heading: 0, turret: 0, alive: true, fireCooldownLeft: 0 };
    const bullet: Bullet = { id: 'b1', ownerId: 'p1', x: 200, y: 200, vx: 0, vy: 0, bounces: 0, age: 0 };
    const state: SimState = { tick: 0, maze, tanks: new Map([['p1', tank]]), bullets: [bullet], nextBulletId: 1 };
    const inputs = new Map<string, Input>([['p1', { turn: 0, move: 0, fire: false }]]);
    const dt = 1 / 60;

    const ticksBeforeImmunity = Math.floor(SELF_IMMUNITY / dt) - 2;
    for (let i = 0; i < ticksBeforeImmunity; i++) {
      step(state, inputs, dt);
      state.tick++;
    }
    expect(state.tanks.get('p1')!.alive, 'não deveria morrer antes da imunidade acabar').toBe(true);

    let events: SimEvent[] = [];
    for (let i = 0; i < 10 && state.tanks.get('p1')!.alive; i++) {
      events = step(state, inputs, dt);
      state.tick++;
    }
    expect(state.tanks.get('p1')!.alive).toBe(false);
    expect(events.some((e) => e.type === 'death' && e.autogol === true)).toBe(true);
  });

  // Decisão do usuário na Fase 10, revertendo a Fase 9 e restaurando a regra da Fase 4: a bala
  // ricocheteia UMA vez e morre no toque de parede seguinte. Numa arena fechada ela nunca chega
  // perto de BULLET_LIFE — a parede a alcança antes. Se alguém tirar a morte por rebote de novo,
  // este teste reprova pelos dois lados (a contagem de rebotes sobe e a razão da morte muda).
  it('a bala ricocheteia uma vez e morre no segundo toque de parede', () => {
    const dt = 1 / 60;
    const maze = emptyArenaMaze();
    const bullet: Bullet = {
      id: 'b1',
      ownerId: 'p1',
      x: 168,
      y: 168,
      vx: Math.cos(0.6) * BULLET_SPEED,
      vy: Math.sin(0.6) * BULLET_SPEED,
      bounces: 0,
      age: 0,
    };
    const state: SimState = { tick: 0, maze, tanks: new Map(), bullets: [bullet], nextBulletId: 2 };

    let ricochetes = 0;
    let motivo: string | null = null;
    let ticksVividos = 0;
    for (let i = 0; i < 600 && state.bullets.length > 0; i++) {
      for (const ev of step(state, new Map(), dt)) {
        if (ev.type === 'bounce') ricochetes += 1;
        if (ev.type === 'bullet_expired') motivo = ev.reason;
      }
      state.tick++;
      ticksVividos = i + 1;
    }

    expect(motivo, 'quem tirou a bala de cena foi a parede, não o relógio').toBe('max_bounces');
    // O evento de rebote é emitido ANTES da checagem que mata: o 2º toque conta como bounce e
    // já é o que encerra a bala. Ou seja: exatamente MAX_BOUNCES + 1 rebotes na vida inteira.
    expect(ricochetes).toBe(MAX_BOUNCES + 1);
    expect(ticksVividos * dt, 'ela morreu bem antes do teto de tempo').toBeLessThan(BULLET_LIFE);
    expect(state.bullets).toHaveLength(0);
  });

  it('a bala que já gastou o rebote dela morre no toque seguinte, sem refletir', () => {
    const maze = emptyArenaMaze();
    maze.walls.push({ x: 245, y: 150, w: 10, h: 100 });
    const tank: Tank = { id: 'p1', x: 50, y: 200, heading: 0, turret: 0, alive: true, fireCooldownLeft: 0 };
    // Rebote já gasto (`bounces === MAX_BOUNCES`): o próximo contato com parede é o que a mata.
    const bullet: Bullet = {
      id: 'b1',
      ownerId: 'p1',
      x: 200,
      y: 200,
      vx: 300,
      vy: 0,
      bounces: MAX_BOUNCES,
      age: 1,
    };
    const state: SimState = { tick: 0, maze, tanks: new Map([['p1', tank]]), bullets: [bullet], nextBulletId: 1 };

    const events = step(state, new Map(), 0.2); // passo largo: 60 px, o bastante para alcançar a parede

    expect(events.some((e) => e.type === 'bounce'), 'o cenário precisa mesmo bater na parede').toBe(true);
    expect(events.some((e) => e.type === 'bullet_expired' && e.reason === 'max_bounces')).toBe(true);
    expect(state.bullets, 'a parede tirou a bala de cena').toHaveLength(0);
  });

  it('a bala que não encosta em nada ainda morre pelo teto de tempo', () => {
    const dt = 1 / 60;
    // Corredor mais comprido que o alcance (215 px/s x 2,2 s = 473 px): nada para ricochetear.
    const corredor: Maze = { cols: 20, rows: 4, cell: 84, walls: [] };
    const bullet: Bullet = { id: 'b1', ownerId: 'p1', x: 10, y: 200, vx: BULLET_SPEED, vy: 0, bounces: 0, age: 0 };
    const state: SimState = { tick: 0, maze: corredor, tanks: new Map(), bullets: [bullet], nextBulletId: 2 };

    let motivo: string | null = null;
    let ticksVividos = 0;
    for (let i = 0; i < 600 && state.bullets.length > 0; i++) {
      for (const ev of step(state, new Map(), dt)) {
        if (ev.type === 'bullet_expired') motivo = ev.reason;
      }
      state.tick++;
      ticksVividos = i + 1;
    }

    expect(motivo).toBe('life');
    expect(ticksVividos * dt).toBeCloseTo(BULLET_LIFE, 1);
  });

  it('respeita o limite de balas vivas por jogador', () => {
    const maze = emptyArenaMaze();
    // Tanques e balas já existentes ficam bem afastados uns dos outros (bem além de
    // TANK_RADIUS+BULLET_RADIUS) para que nenhuma colisão bala×tanque incidental interfira
    // na contagem — o único efeito sob teste aqui é o bloqueio de disparo pelo limite de munição.
    const p1: Tank = { id: 'p1', x: 50, y: 50, heading: 0, turret: 0, alive: true, fireCooldownLeft: 0 };
    const p2: Tank = { id: 'p2', x: 50, y: 280, heading: 0, turret: 0, alive: true, fireCooldownLeft: 0 };
    const bullets: Bullet[] = [
      { id: 'b1', ownerId: 'p1', x: 300, y: 300, vx: 0, vy: 0, bounces: 0, age: 1 },
      { id: 'b2', ownerId: 'p1', x: 300, y: 310, vx: 0, vy: 0, bounces: 0, age: 1 },
      { id: 'b3', ownerId: 'p1', x: 300, y: 320, vx: 0, vy: 0, bounces: 0, age: 1 },
    ];
    const state: SimState = {
      tick: 0,
      maze,
      tanks: new Map([
        ['p1', p1],
        ['p2', p2],
      ]),
      bullets,
      nextBulletId: 3,
    };
    const inputs = new Map<string, Input>([
      ['p1', { turn: 0, move: 0, fire: true }],
      ['p2', { turn: 0, move: 0, fire: false }],
    ]);

    const before = state.bullets.filter((b) => b.ownerId === 'p1').length;
    step(state, inputs, 1 / 60);
    const after = state.bullets.filter((b) => b.ownerId === 'p1').length;

    expect(after).toBe(before);
  });
});

// Fase 4 — a torre deixou de ser travada no chassi: mira onde o input mandar, no ritmo de
// TURRET_RATE, e é dela que a bala sai.
describe('sim.step — torre independente com giro limitado', () => {
  function tanqueSozinho(heading: number, turret: number): SimState {
    const tank: Tank = { id: 'p1', x: 168, y: 168, heading, turret, alive: true, fireCooldownLeft: 0 };
    return { tick: 0, maze: emptyArenaMaze(), tanks: new Map([['p1', tank]]), bullets: [], nextBulletId: 0 };
  }

  it('a torre não teleporta: gasta o tempo previsto por TURRET_RATE para virar meia-volta', () => {
    const state = tanqueSozinho(0, 0);
    const dt = 1 / 60;
    const inputs = new Map<string, Input>([['p1', { turn: 0, move: 0, fire: false, aim: Math.PI }]]);

    step(state, inputs, dt);
    // Depois de UM tick a torre andou no máximo TURRET_RATE·dt — não pulou para o alvo.
    expect(Math.abs(state.tanks.get('p1')!.turret)).toBeCloseTo(TURRET_RATE * dt, 6);

    const ticksNecessarios = Math.ceil(Math.PI / (TURRET_RATE * dt));
    for (let i = 1; i < ticksNecessarios; i++) step(state, inputs, dt);
    expect(Math.abs(state.tanks.get('p1')!.turret)).toBeCloseTo(Math.PI, 4);
  });

  it('sem `aim` no input a torre fica parada onde está (não volta para o chassi)', () => {
    const state = tanqueSozinho(0, 1.2);
    for (let i = 0; i < 120; i++) step(state, new Map([['p1', { turn: 1, move: 1, fire: false }]]), 1 / 60);
    expect(state.tanks.get('p1')!.turret).toBeCloseTo(1.2, 10);
  });

  it('a bala sai na direção da TORRE, não do chassi', () => {
    // Chassi virado para o leste, torre já apontada para o norte.
    const state = tanqueSozinho(0, -Math.PI / 2);
    const events = step(state, new Map([['p1', { turn: 0, move: 0, fire: true, aim: -Math.PI / 2 }]]), 1 / 60);

    const tiro = events.find((e) => e.type === 'shot');
    expect(tiro).toBeDefined();

    const tank = state.tanks.get('p1')!;
    const bala = state.bullets[0]!;
    expect(bala.vy).toBeLessThan(-BULLET_SPEED * 0.99); // subindo, não indo para a direita
    expect(Math.abs(bala.vx)).toBeLessThan(BULLET_SPEED * 0.05);
    // e nasce na boca do cano, à frente da torre — não à frente do chassi
    expect(bala.y).toBeLessThan(tank.y - TANK_RADIUS);
    expect(bala.x).toBeCloseTo(tank.x, 4);
  });

  it('o autogol continua possível com 1 rebote: bala que volta pela mesma parede mata o dono', () => {
    // Tanque encostado numa parede, atirando de frente para ela: a bala volta pelo mesmo eixo e
    // acerta quem atirou depois da janela de SELF_IMMUNITY. É o cenário canônico do autogol.
    const maze = emptyArenaMaze();
    const tank: Tank = { id: 'p1', x: 240, y: 100, heading: 0, turret: -Math.PI / 2, alive: true, fireCooldownLeft: 0 };
    const state: SimState = { tick: 0, maze, tanks: new Map([['p1', tank]]), bullets: [], nextBulletId: 0 };
    const dt = 1 / 60;

    step(state, new Map([['p1', { turn: 0, move: 0, fire: true, aim: -Math.PI / 2 }]]), dt);
    state.tick++;
    expect(state.bullets).toHaveLength(1);

    let autogol = false;
    for (let i = 0; i < 300 && !autogol; i++) {
      for (const ev of step(state, new Map(), dt)) {
        if (ev.type === 'death' && ev.autogol) autogol = true;
      }
      state.tick++;
    }

    expect(autogol, 'o autogol tem que continuar acontecendo com a bala vivendo por tempo').toBe(true);
    expect(state.tanks.get('p1')!.alive).toBe(false);
  });
});
