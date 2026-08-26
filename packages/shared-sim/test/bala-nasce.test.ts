// Fase 12 §2 — "se você mirar o cano para parede bem encostado atravessa bala pro outro lado".
//
// A bala nasce a TANK_RADIUS + BULLET_RADIUS + 4 px do centro, na direção da torre. Com o tanque
// colado numa parede e a torre virada para ela, esse ponto caía DO OUTRO LADO da geometria — e,
// como o slab test descarta o raio que já começa dentro do AABB, ela seguia viagem sem nunca
// ricochetear. Aqui a bala tem que nascer do lado de dentro e quicar.

import { BULLET_RADIUS, TANK_RADIUS, TICK_HZ } from '@tank/protocol';
import { describe, expect, it } from 'vitest';
import { step } from '../src/index.js';
import type { Input, Maze, SimEvent, SimState, Tank } from '../src/index.js';

const DT = 1 / TICK_HZ;
const ESPESSURA = 12;

/** Arena vazia de 4×4 células, só com as quatro paredes de borda. */
function arenaVazia(): Maze {
  const cols = 4;
  const rows = 4;
  const cell = 84;
  const w = cols * cell;
  const h = rows * cell;
  const half = ESPESSURA / 2;
  return {
    cols,
    rows,
    cell,
    walls: [
      { x: -half, y: -half, w: w + ESPESSURA, h: ESPESSURA },
      { x: -half, y: h - half, w: w + ESPESSURA, h: ESPESSURA },
      { x: -half, y: -half, w: ESPESSURA, h: h + ESPESSURA },
      { x: w - half, y: -half, w: ESPESSURA, h: h + ESPESSURA },
    ],
  };
}

const DISPARA: Input = { mover: null, fire: true };
const PARADO: Input = { mover: null, fire: false };

describe('nascimento da bala junto à parede', () => {
  it('colado na parede da direita, com a torre nela, a bala nasce do lado de dentro', () => {
    const maze = arenaVazia();
    const faceDaParede = maze.cols * maze.cell - ESPESSURA / 2; // x onde a parede começa
    const tank: Tank = {
      id: 'p1',
      x: faceDaParede - TANK_RADIUS, // encostado: mais perto que isso o slide empurraria de volta
      y: 168,
      heading: 0,
      turret: 0, // apontando direto para a parede
      alive: true,
      fireCooldownLeft: 0,
    };
    const state: SimState = { tick: 0, maze, tanks: new Map([['p1', tank]]), bullets: [], nextBulletId: 0 };

    const eventos = step(state, new Map<string, Input>([['p1', DISPARA]]), DT);
    state.tick++;

    const tiro = eventos.find((e): e is Extract<SimEvent, { type: 'shot' }> => e.type === 'shot');
    expect(tiro, 'o disparo tem que acontecer — a correção não pode virar "não atira"').toBeDefined();
    // Nasceu ANTES da parede, encostada: no máximo na face, com a folga do raio dela.
    expect(tiro!.x).toBeLessThanOrEqual(faceDaParede - BULLET_RADIUS + 1e-3);
    expect(tiro!.x).toBeGreaterThan(tank.x);

    const bala = state.bullets[0];
    expect(bala, 'a bala tem que existir depois do tick do disparo').toBeDefined();
    expect(bala!.x).toBeLessThanOrEqual(faceDaParede - BULLET_RADIUS + 1e-3);
  });

  it('o primeiro evento dessa bala é um ricochete — ela nunca aparece do outro lado', () => {
    const maze = arenaVazia();
    const faceDaParede = maze.cols * maze.cell - ESPESSURA / 2;
    const tank: Tank = {
      id: 'p1',
      x: faceDaParede - TANK_RADIUS,
      y: 168,
      heading: 0,
      turret: 0,
      alive: true,
      fireCooldownLeft: 0,
    };
    const state: SimState = { tick: 0, maze, tanks: new Map([['p1', tank]]), bullets: [], nextBulletId: 0 };

    // O `step` do disparo já move a bala: ela nasce, anda um tick e bate. O ricochete costuma
    // sair nesse MESMO tick, então a varredura começa nele.
    let primeiroEvento: SimEvent | undefined;
    let balaId = '';
    for (let i = 0; i < 30 && !primeiroEvento; i++) {
      const eventos = step(state, new Map<string, Input>([['p1', i === 0 ? DISPARA : PARADO]]), DT);
      state.tick++;
      const tiro = eventos.find((e): e is Extract<SimEvent, { type: 'shot' }> => e.type === 'shot');
      if (tiro) balaId = tiro.bulletId;
      primeiroEvento = eventos.find(
        (e) => (e.type === 'bounce' || e.type === 'bullet_expired') && e.bulletId === balaId,
      );
      // A cada tick: a bala continua deste lado da parede.
      for (const b of state.bullets) {
        expect(b.x, `tick ${i}: bala atravessou para o outro lado`).toBeLessThanOrEqual(faceDaParede + 1e-3);
      }
    }

    expect(primeiroEvento?.type).toBe('bounce');
  });

  it('vale para as quatro paredes e para a torre em diagonal', () => {
    const maze = arenaVazia();
    const largura = maze.cols * maze.cell;
    const altura = maze.rows * maze.cell;
    const min = -ESPESSURA / 2 + ESPESSURA; // face interna das paredes de cima/esquerda
    const maxX = largura - ESPESSURA / 2;
    const maxY = altura - ESPESSURA / 2;

    const casos: { x: number; y: number; turret: number; nome: string }[] = [
      { x: maxX - TANK_RADIUS, y: 168, turret: 0, nome: 'direita' },
      { x: min + TANK_RADIUS, y: 168, turret: Math.PI, nome: 'esquerda' },
      { x: 168, y: min + TANK_RADIUS, turret: -Math.PI / 2, nome: 'topo' },
      { x: 168, y: maxY - TANK_RADIUS, turret: Math.PI / 2, nome: 'baixo' },
      { x: maxX - TANK_RADIUS, y: maxY - TANK_RADIUS, turret: Math.PI / 4, nome: 'quina inferior direita' },
      { x: min + TANK_RADIUS, y: min + TANK_RADIUS, turret: (-3 * Math.PI) / 4, nome: 'quina superior esquerda' },
    ];

    for (const caso of casos) {
      const tank: Tank = {
        id: 'p1',
        x: caso.x,
        y: caso.y,
        heading: caso.turret,
        turret: caso.turret,
        alive: true,
        fireCooldownLeft: 0,
      };
      const state: SimState = { tick: 0, maze, tanks: new Map([['p1', tank]]), bullets: [], nextBulletId: 0 };
      step(state, new Map<string, Input>([['p1', DISPARA]]), DT);
      state.tick++;

      const bala = state.bullets[0];
      expect(bala, `${caso.nome}: nenhuma bala nasceu`).toBeDefined();
      // Dentro da arena, com a folga do próprio raio — nunca dentro nem além da parede.
      expect(bala!.x, `${caso.nome}: nasceu fora pela esquerda`).toBeGreaterThanOrEqual(min + BULLET_RADIUS - 1e-3);
      expect(bala!.x, `${caso.nome}: nasceu fora pela direita`).toBeLessThanOrEqual(maxX - BULLET_RADIUS + 1e-3);
      expect(bala!.y, `${caso.nome}: nasceu fora por cima`).toBeGreaterThanOrEqual(min + BULLET_RADIUS - 1e-3);
      expect(bala!.y, `${caso.nome}: nasceu fora por baixo`).toBeLessThanOrEqual(maxY - BULLET_RADIUS + 1e-3);
    }
  });

  it('longe de parede nenhuma, a bala continua nascendo na boca do cano', () => {
    const maze = arenaVazia();
    const tank: Tank = { id: 'p1', x: 168, y: 168, heading: 0, turret: 0, alive: true, fireCooldownLeft: 0 };
    const state: SimState = { tick: 0, maze, tanks: new Map([['p1', tank]]), bullets: [], nextBulletId: 0 };

    step(state, new Map<string, Input>([['p1', DISPARA]]), DT);
    const bala = state.bullets[0]!;
    const distanciaDoCentro = Math.hypot(bala.x - 168, bala.y - 168);
    // A bala já andou um tick quando o teste olha, então a folga é a de um passo.
    expect(distanciaDoCentro).toBeGreaterThan(TANK_RADIUS + BULLET_RADIUS);
  });
});
