// Movimento ABSOLUTO: `W` anda para cima na tela, não "para onde o tanque aponta".
//
// O que está sendo protegido aqui é a razão de a mudança existir: com tank controls, estar virado
// errado custava 0,49 s de giro antes do primeiro pixel andado, e sair da linha de uma bala virava
// impossível dentro de 239 px (quase 3 células) em vez de 133 px. Se um dia alguém reintroduzir o
// giro como pré-requisito do deslocamento, o primeiro teste abaixo cai no primeiro tick.

import { TANK_SPEED, TICK_HZ, TURN_RATE, bitsDeMovimento, direcaoDeMovimento } from '@tank/protocol';
import { describe, expect, it } from 'vitest';
import { step } from '../src/index.js';
import type { Input, Maze, SimState, Tank } from '../src/index.js';

const DT = 1 / TICK_HZ;

/** Arena aberta e grande: nada de parede no caminho para atrapalhar a medida de distância. */
function arenaVazia(): Maze {
  const cols = 10;
  const rows = 10;
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

function tanqueSozinho(heading: number): { state: SimState; tank: Tank } {
  const maze = arenaVazia();
  const tank: Tank = { id: 'p1', x: 420, y: 420, heading, turret: 0, alive: true, fireCooldownLeft: 0 };
  return { state: { tick: 0, maze, tanks: new Map([['p1', tank]]), bullets: [], nextBulletId: 0 }, tank };
}

function andar(mover: number | null, ticks: number, heading = 0): { dx: number; dy: number; tank: Tank } {
  const { state, tank } = tanqueSozinho(heading);
  const x0 = tank.x;
  const y0 = tank.y;
  const inputs = new Map<string, Input>([['p1', { mover, fire: false }]]);
  for (let i = 0; i < ticks; i++) {
    step(state, inputs, DT);
    state.tick++;
  }
  return { dx: tank.x - x0, dy: tank.y - y0, tank };
}

describe('movimento absoluto', () => {
  it('W sozinho move para CIMA na tela (Y do mundo cresce para baixo)', () => {
    const mover = direcaoDeMovimento(true, false, false, false);
    expect(mover).toBeCloseTo(-Math.PI / 2, 12);

    const { dx, dy } = andar(mover, 60);
    expect(dy).toBeLessThan(0);
    expect(Math.abs(dx)).toBeLessThan(1e-9);
    expect(-dy).toBeCloseTo(TANK_SPEED, 4); // 60 ticks = 1 s = TANK_SPEED px
  });

  it('W+D move na diagonal cima-direita, e não só num dos eixos', () => {
    const mover = direcaoDeMovimento(true, false, false, true);
    expect(mover).toBeCloseTo(-Math.PI / 4, 12);

    const { dx, dy } = andar(mover, 60);
    expect(dx).toBeGreaterThan(0);
    expect(dy).toBeLessThan(0);
    // Os dois eixos recebem a mesma fatia: a diagonal é 45°, não 45° "com um eixo mais rápido".
    expect(dx).toBeCloseTo(-dy, 6);
  });

  it('diagonal NÃO anda mais rápido que reto — o bug clássico das 8 direções', () => {
    const TICKS = 120;
    const reto = andar(direcaoDeMovimento(true, false, false, false), TICKS);
    const diagonal = andar(direcaoDeMovimento(true, false, false, true), TICKS);

    const distReto = Math.hypot(reto.dx, reto.dy);
    const distDiagonal = Math.hypot(diagonal.dx, diagonal.dy);

    expect(distReto).toBeCloseTo(TANK_SPEED * (TICKS * DT), 4);
    // Sem normalizar, a diagonal andaria √2 ≈ 1,414× isto. A folga de 1e-6 é só ruído de float.
    expect(distDiagonal).toBeCloseTo(distReto, 6);
    expect(distDiagonal / distReto).toBeLessThan(1 + 1e-6);
  });

  it('as 8 direções percorrem exatamente a mesma distância', () => {
    const TICKS = 90;
    const teclas: readonly [boolean, boolean, boolean, boolean][] = [
      [true, false, false, false],
      [true, false, false, true],
      [false, false, false, true],
      [false, true, false, true],
      [false, true, false, false],
      [false, true, true, false],
      [false, false, true, false],
      [true, false, true, false],
    ];
    const esperado = TANK_SPEED * (TICKS * DT);
    for (const [up, down, left, right] of teclas) {
      const { dx, dy } = andar(direcaoDeMovimento(up, down, left, right), TICKS);
      expect(Math.hypot(dx, dy), `${up}${down}${left}${right}`).toBeCloseTo(esperado, 4);
    }
  });

  it('soltar tudo (mover = null) para o tanque no mesmo tick', () => {
    const { state, tank } = tanqueSozinho(0);
    const andando = new Map<string, Input>([['p1', { mover: 0, fire: false }]]);
    for (let i = 0; i < 30; i++) {
      step(state, andando, DT);
      state.tick++;
    }
    const x = tank.x;
    const y = tank.y;

    const parado = new Map<string, Input>([['p1', { mover: null, fire: false }]]);
    for (let i = 0; i < 120; i++) {
      step(state, parado, DT);
      state.tick++;
    }
    // Nada de inércia: o tanque não desliza nem um pixel depois que a tecla sobe.
    expect(tank.x).toBe(x);
    expect(tank.y).toBe(y);
  });

  it('teclas opostas se cancelam (A+D = parado, não uma direção qualquer)', () => {
    expect(direcaoDeMovimento(false, false, true, true)).toBeNull();
    expect(direcaoDeMovimento(true, true, false, false)).toBeNull();
    expect(direcaoDeMovimento(true, true, true, true)).toBeNull();
    expect(direcaoDeMovimento(false, false, false, false)).toBeNull();
  });

  it('estar virado ao contrário não atrasa o deslocamento em nenhum tick', () => {
    // Chassi apontado para o LESTE, jogador pede OESTE: com tank controls o tanque só começaria a
    // andar depois de ~0,98 s de giro. Aqui o primeiro tick já anda a velocidade cheia.
    const { dx, dy } = andar(Math.PI, 1, 0);
    expect(dx).toBeCloseTo(-TANK_SPEED * DT, 9);
    expect(Math.abs(dy)).toBeLessThan(1e-9);
  });

  it('o chassi persegue a direção do movimento a TURN_RATE — mas só de enfeite', () => {
    // Um único tick com o chassi 180° errado: a posição já andou tudo, o chassi andou TURN_RATE·dt.
    const { dx, tank } = andar(Math.PI, 1, 0);
    expect(dx).toBeCloseTo(-TANK_SPEED * DT, 9);
    expect(Math.abs(tank.heading)).toBeCloseTo(TURN_RATE * DT, 9);

    // E, com tempo, o chassi chega lá — é o giro cosmético de mola que o desenho precisa.
    const longo = andar(Math.PI, 90, 0);
    expect(Math.abs(longo.tank.heading)).toBeCloseTo(Math.PI, 4);
  });
});

describe('bits de direção na rede', () => {
  it('ida e volta pelos bits preserva a direção exatamente', () => {
    const combinacoes: readonly [boolean, boolean, boolean, boolean][] = [
      [true, false, false, false],
      [true, false, false, true],
      [false, false, false, true],
      [false, true, false, true],
      [false, true, false, false],
      [false, true, true, false],
      [false, false, true, false],
      [true, false, true, false],
      [false, false, false, false],
    ];
    for (const [up, down, left, right] of combinacoes) {
      const direcao = direcaoDeMovimento(up, down, left, right);
      const bits = bitsDeMovimento(direcao);
      const volta = direcaoDeMovimento(
        (bits & 0x01) !== 0,
        (bits & 0x02) !== 0,
        (bits & 0x04) !== 0,
        (bits & 0x08) !== 0,
      );
      expect(volta, `${up}${down}${left}${right}`).toBe(direcao);
    }
  });

  it('ângulo fora das 8 direções (o do bot) encaixa na oitava mais próxima', () => {
    // 0,3 rad ≈ 17°: mais perto do leste puro que da diagonal, então só o bit da direita acende.
    expect(bitsDeMovimento(0.3)).toBe(0x08);
    // 0,7 rad ≈ 40°: já é a diagonal sudeste.
    expect(bitsDeMovimento(0.7)).toBe(0x08 | 0x02);
    expect(bitsDeMovimento(null)).toBe(0);
  });
});
