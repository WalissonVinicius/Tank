import { describe, expect, it } from 'vitest';
import { BULLET_LIFE, BULLET_SPEED, CELL, MAZE_BY_PLAYERS, TANK_SPEED } from '@tank/protocol';

// A4 — trava de regressão para o ritmo da arena. Cada valor aqui é medido, não chutado: ver
// `_specs/A4-arena-densa.md`. "Largura" é `cols * CELL` (o eixo mais comprido da grade base,
// coerente com `_ritmo.ts`) — o mesmo eixo que `mazeShape()` alinha à tela mais larga.
const ALCANCE_BALA = BULLET_SPEED * BULLET_LIFE;

describe('ritmo da arena com sala cheia (A4)', () => {
  for (let jogadores = 6; jogadores <= 10; jogadores++) {
    it(`${jogadores} jogadores: atravessar a pé leva de 10 a 13 s`, () => {
      const densidade = MAZE_BY_PLAYERS[jogadores]!;
      const largura = densidade.cols * CELL;
      const travessia = largura / TANK_SPEED;
      expect(travessia, `${densidade.cols}x${densidade.rows} = ${largura}px`).toBeGreaterThanOrEqual(10);
      expect(travessia, `${densidade.cols}x${densidade.rows} = ${largura}px`).toBeLessThanOrEqual(13);
    });

    it(`${jogadores} jogadores: a bala alcança pelo menos metade da largura`, () => {
      const densidade = MAZE_BY_PLAYERS[jogadores]!;
      const largura = densidade.cols * CELL;
      const pctAlcance = ALCANCE_BALA / largura;
      expect(pctAlcance).toBeGreaterThanOrEqual(0.5);
    });
  }
});
