import { describe, expect, it } from 'vitest';
import {
  MAZE_ASPECT_MAX,
  MAZE_ASPECT_MIN,
  MAZE_BY_PLAYERS,
  SPAWN_LOS_MIN_DIST,
} from '@tank/protocol';
import {
  countDeadEnds,
  hasLineOfSight,
  makeMaze,
  mazeShape,
  mulberry32,
  spawnPoints,
  validateMaze,
} from '../src/index.js';
import type { Maze, Vec2 } from '../src/index.js';

// As proporções de ÁREA JOGÁVEL das telas que o jogo precisa atender (já descontadas as faixas
// de HUD que `apps/client/src/ui/layout.ts` reserva). São elas, e não a razão crua da janela,
// que o cliente anuncia ao servidor.
const TELAS_REAIS: readonly { nome: string; aspect: number }[] = [
  { nome: '1366×768', aspect: 1366 / 686 },
  { nome: '1920×1080', aspect: 1920 / 965 },
  { nome: '2560×1440', aspect: 2560 / 1296 },
  { nome: '3440×1440 (ultrawide)', aspect: 3440 / 1296 },
  { nome: '1024×768 (4:3)', aspect: 1024 / 686 },
  { nome: '16:9 puro', aspect: 16 / 9 },
];

// Pares de spawn que quebram a regra da arena aberta: perto o bastante para ser injusto
// (< SPAWN_LOS_MIN_DIST) E com linha de visão direta. Pares distantes podem se enxergar.
function closeLosPairs(spawns: readonly Vec2[], maze: Maze): number {
  let pairs = 0;
  for (let i = 0; i < spawns.length; i++) {
    for (let j = i + 1; j < spawns.length; j++) {
      const a = spawns[i]!;
      const b = spawns[j]!;
      if (Math.hypot(a.x - b.x, a.y - b.y) >= SPAWN_LOS_MIN_DIST) continue;
      if (hasLineOfSight(a, b, maze.walls)) pairs++;
    }
  }
  return pairs;
}

describe('geração de labirinto', () => {
  for (let players = 2; players <= 10; players++) {
    it(`gera labirintos válidos para ${players} jogadores (200 seeds)`, () => {
      for (let seed = 0; seed < 200; seed++) {
        const maze = makeMaze(seed, players);

        const result = validateMaze(maze);
        expect(result.ok, `seed ${seed}, ${players} jogadores: ${result.reason ?? ''}`).toBe(true);

        const deadEnds = countDeadEnds(maze);
        expect(deadEnds).toBeLessThanOrEqual(Math.ceil(maze.cols * maze.rows * 0.5));

        const rng = mulberry32(seed * 7919 + players);
        const spawns = spawnPoints(maze, players, rng);
        expect(spawns.length).toBe(players);

        const keys = new Set(spawns.map((s) => `${s.x.toFixed(2)}:${s.y.toFixed(2)}`));
        expect(keys.size, 'spawns devem ser distintos').toBe(players);

        for (const s of spawns) {
          expect(s.x).toBeGreaterThanOrEqual(0);
          expect(s.x).toBeLessThanOrEqual(maze.cols * maze.cell);
          expect(s.y).toBeGreaterThanOrEqual(0);
          expect(s.y).toBeLessThanOrEqual(maze.rows * maze.cell);
        }

        expect(
          closeLosPairs(spawns, maze),
          `seed ${seed}, ${players} jogadores: nenhum par a menos de ${SPAWN_LOS_MIN_DIST}px deveria ter linha de visão`,
        ).toBe(0);
      }
    });
  }

  it('sempre entrega 10 spawns distintos na sala cheia (200 seeds)', () => {
    for (let seed = 0; seed < 200; seed++) {
      const maze = makeMaze(seed, 10);
      const rng = mulberry32(seed * 104729 + 17);
      const spawns = spawnPoints(maze, 10, rng);
      expect(spawns.length, `seed ${seed}: spawnPoints devolveu ${spawns.length} pontos`).toBe(10);
      const keys = new Set(spawns.map((s) => `${s.x.toFixed(2)}:${s.y.toFixed(2)}`));
      expect(keys.size, `seed ${seed}: spawns repetidos`).toBe(10);
    }
  });

  it('é determinístico: mesma seed e mesmo RNG produzem os mesmos spawns', () => {
    for (let seed = 0; seed < 100; seed++) {
      const players = 2 + (seed % 9);
      const a = spawnPoints(makeMaze(seed, players), players, mulberry32(seed));
      const b = spawnPoints(makeMaze(seed, players), players, mulberry32(seed));
      expect(JSON.stringify(b), `seed ${seed}, ${players} jogadores`).toBe(JSON.stringify(a));
    }
  });
});

// Fase 9: o labirinto passou a nascer na proporção da tela para preencher a janela em vez de
// deixar faixa morta nos lados. A forma muda, o resto do contrato não pode mudar.
describe('forma do labirinto por proporção de tela', () => {
  it('a arena acompanha a proporção pedida, dentro da faixa travada', () => {
    for (const { nome, aspect } of TELAS_REAIS) {
      const alvo = Math.min(MAZE_ASPECT_MAX, Math.max(MAZE_ASPECT_MIN, aspect));
      for (let players = 2; players <= 10; players++) {
        const { cols, rows } = mazeShape(players, aspect);
        const real = cols / rows;
        // 15% é a folga da grade discreta: com poucas linhas, uma coluna a mais ou a menos já
        // mexe bastante na razão. Acima disso volta a sobrar faixa morta na tela.
        expect(Math.abs(real - alvo) / alvo, `${nome}, ${players} jogadores: ${cols}×${rows}`).toBeLessThan(0.15);
      }
    }
  });

  it('mantém a densidade calibrada: o total de células por jogador quase não muda', () => {
    for (const { nome, aspect } of TELAS_REAIS) {
      for (let players = 2; players <= 10; players++) {
        const base = MAZE_BY_PLAYERS[players]!;
        const alvo = base.cols * base.rows;
        const { cols, rows } = mazeShape(players, aspect);
        const razao = (cols * rows) / alvo;
        expect(razao, `${nome}, ${players} jogadores: ${cols}×${rows}`).toBeGreaterThan(0.7);
        expect(razao, `${nome}, ${players} jogadores: ${cols}×${rows}`).toBeLessThan(1.35);
      }
    }
  });

  it('nunca degenera em corredor: mínimo de 3 linhas e 4 colunas, e células para todo mundo', () => {
    // Inclui proporções fora da faixa (retrato e 32:9) de propósito: é justamente aí que a trava
    // precisa aparecer — o labirinto para de esticar e o render centraliza o que sobra.
    for (const aspect of [0.5, 1, 1.2, 1.78, 2.7, 3.55, 12]) {
      for (let players = 2; players <= 10; players++) {
        const { cols, rows } = mazeShape(players, aspect);
        expect(rows, `aspect ${aspect}`).toBeGreaterThanOrEqual(3);
        expect(cols, `aspect ${aspect}`).toBeGreaterThanOrEqual(4);
        expect(cols / rows).toBeGreaterThanOrEqual(MAZE_ASPECT_MIN - 0.15);
        expect(cols / rows).toBeLessThanOrEqual(MAZE_ASPECT_MAX + 0.15);
        expect(cols * rows, 'toda gente precisa de uma célula para nascer').toBeGreaterThanOrEqual(players);
      }
    }
  });

  it('é uma função pura: a mesma proporção devolve sempre a mesma forma', () => {
    for (const { aspect } of TELAS_REAIS) {
      for (let players = 2; players <= 10; players++) {
        expect(mazeShape(players, aspect)).toEqual(mazeShape(players, aspect));
      }
    }
  });

  it('gera labirintos válidos e spawns justos em todas as telas reais (60 seeds)', () => {
    for (const { nome, aspect } of TELAS_REAIS) {
      for (let players = 2; players <= 10; players++) {
        for (let seed = 0; seed < 60; seed++) {
          const maze = makeMaze(seed, players, aspect);
          const forma = mazeShape(players, aspect);
          expect(maze.cols).toBe(forma.cols);
          expect(maze.rows).toBe(forma.rows);

          const result = validateMaze(maze);
          expect(result.ok, `${nome}, seed ${seed}, ${players} jogadores: ${result.reason ?? ''}`).toBe(true);
          expect(countDeadEnds(maze)).toBeLessThanOrEqual(Math.ceil(maze.cols * maze.rows * 0.5));

          const spawns = spawnPoints(maze, players, mulberry32(seed * 7919 + players));
          expect(spawns.length).toBe(players);
          const keys = new Set(spawns.map((s) => `${s.x.toFixed(2)}:${s.y.toFixed(2)}`));
          expect(keys.size, 'spawns devem ser distintos').toBe(players);
          expect(
            closeLosPairs(spawns, maze),
            `${nome}, seed ${seed}, ${players} jogadores: par próximo com linha de visão`,
          ).toBe(0);
        }
      }
    }
  });

  it('duas telas diferentes com a MESMA proporção combinada dão o mesmo labirinto', () => {
    // É o contrato de paridade: quem manda na forma é a proporção que o servidor combinou, não o
    // tamanho da janela de cada um. 1920×1080 e 3840×2160 têm a mesma razão e a mesma arena.
    for (let players = 2; players <= 10; players++) {
      const a = makeMaze(2024, players, 1920 / 965);
      const b = makeMaze(2024, players, 3840 / 1930);
      expect(JSON.stringify(b), `${players} jogadores`).toBe(JSON.stringify(a));
    }
  });
});
