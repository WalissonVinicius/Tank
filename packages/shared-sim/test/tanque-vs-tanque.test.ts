// Fase 12 §1 — "um tank tá entrando dentro do outro".
//
// Até a Fase 11 a simulação não tinha colisão tanque×tanque nenhuma: dois chassis ocupavam o
// mesmo ponto e se atravessavam. Estes testes fecham as três portas: a sobreposição em si, o
// empurrão que enfiava alguém na parede, e a ordem de iteração (que precisa sair do ID, não da
// ordem de inserção do `Map`, senão servidor e cliente divergem).

import { TANK_RADIUS, TANK_SPEED, TICK_HZ } from '@tank/protocol';
import { describe, expect, it } from 'vitest';
import { makeMaze, mulberry32, spawnPoints, step } from '../src/index.js';
import type { Input, Maze, SimState, Tank } from '../src/index.js';

const DT = 1 / TICK_HZ;
const DIAMETRO = TANK_RADIUS * 2;
/** Folga de ponto flutuante: a separação resolve por subtração, não por igualdade exata. */
const EPS = 1e-6;

/** Arena vazia de 4×4 células, só com as quatro paredes de borda. */
function arenaVazia(): Maze {
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

function tanque(id: string, x: number, y: number, heading: number): Tank {
  return { id, x, y, heading, turret: heading, alive: true, fireCooldownLeft: 0 };
}

function estado(maze: Maze, tanks: Tank[]): SimState {
  return { tick: 0, maze, tanks: new Map(tanks.map((t) => [t.id, t])), bullets: [], nextBulletId: 0 };
}

function distancia(a: Tank, b: Tank): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Menor distância do centro até a superfície de qualquer parede (negativa = dentro dela). */
function folgaAteAParede(t: Tank, maze: Maze): number {
  let menor = Infinity;
  for (const w of maze.walls) {
    const cx = Math.min(Math.max(t.x, w.x), w.x + w.w);
    const cy = Math.min(Math.max(t.y, w.y), w.y + w.h);
    menor = Math.min(menor, Math.hypot(t.x - cx, t.y - cy));
  }
  return menor;
}

describe('colisão tanque × tanque', () => {
  it('dois tanques andando um contra o outro nunca se sobrepõem', () => {
    const maze = arenaVazia();
    const a = tanque('pA', 120, 168, 0); // olhando para a direita
    const b = tanque('pB', 220, 168, Math.PI); // olhando para a esquerda
    const state = estado(maze, [a, b]);
    const inputs = new Map<string, Input>([
      ['pA', { mover: 0, fire: false }],
      ['pB', { mover: Math.PI, fire: false }],
    ]);

    let menorDistancia = Infinity;
    for (let i = 0; i < 240; i++) {
      step(state, inputs, DT);
      state.tick++;
      menorDistancia = Math.min(menorDistancia, distancia(a, b));
      expect(distancia(a, b), `tick ${i}: atravessaram`).toBeGreaterThanOrEqual(DIAMETRO - EPS);
    }

    // E encostaram de verdade — um teste que passasse porque eles nunca chegaram perto não
    // provaria nada.
    expect(menorDistancia).toBeLessThan(DIAMETRO + TANK_SPEED * DT);
  });

  it('um tanque empurrado contra a parede não entra nela', () => {
    const maze = arenaVazia();
    const larguraArena = maze.cols * maze.cell;
    // `parado` fica colado na parede da direita; `empurrador` vem de trás e força a passagem.
    const parado = tanque('pA', larguraArena - 6 - TANK_RADIUS, 168, 0);
    const empurrador = tanque('pB', larguraArena - 6 - TANK_RADIUS - DIAMETRO - 2, 168, 0);
    const state = estado(maze, [parado, empurrador]);
    const inputs = new Map<string, Input>([
      ['pA', { mover: 0, fire: false }],
      ['pB', { mover: 0, fire: false }],
    ]);

    for (let i = 0; i < 300; i++) {
      step(state, inputs, DT);
      state.tick++;
      for (const t of [parado, empurrador]) {
        expect(folgaAteAParede(t, maze), `tick ${i}: ${t.id} entrou na parede`).toBeGreaterThanOrEqual(
          TANK_RADIUS - 1e-3,
        );
      }
    }
  });

  it('centros coincidentes não viram NaN nem cospem ninguém para fora da arena', () => {
    const maze = arenaVazia();
    // Caso degenerado de propósito: dez centros praticamente no mesmo ponto, que é onde a normal
    // de separação não existe e um código ingênuo dividiria por zero. Dez tanques empilhados num
    // eixo só não CABEM nesta arena de 4 células, então o que se cobra aqui é robustez numérica e
    // arena estanque — a separação completa é o teste seguinte.
    const tanques = Array.from({ length: 10 }, (_, i) => tanque(`p${i}`, 168 + i * 1e-9, 168, 0));
    const state = estado(maze, tanques);
    const inputs = new Map<string, Input>(tanques.map((t) => [t.id, { mover: null, fire: false }]));

    for (let i = 0; i < 600; i++) {
      step(state, inputs, DT);
      state.tick++;
    }

    for (const t of tanques) {
      expect(Number.isFinite(t.x) && Number.isFinite(t.y), `${t.id} virou NaN`).toBe(true);
      expect(folgaAteAParede(t, maze), `${t.id} vazou pela parede`).toBeGreaterThanOrEqual(TANK_RADIUS - 1e-3);
    }
  });

  it('um amontoado que cabe na arena se desfaz por completo', () => {
    const maze = arenaVazia();
    // Quatro tanques quase no mesmo ponto, com uma pitada de deslocamento em direções diferentes
    // — o amontoado que de fato acontece no jogo, quando dois pares se encontram numa quina.
    const tanques = [
      tanque('p0', 168, 168, 0),
      tanque('p1', 170, 169, 0),
      tanque('p2', 167, 171, 0),
      tanque('p3', 169, 166, 0),
    ];
    const state = estado(maze, tanques);
    const inputs = new Map<string, Input>(tanques.map((t) => [t.id, { mover: null, fire: false }]));

    for (let i = 0; i < 300; i++) {
      step(state, inputs, DT);
      state.tick++;
    }

    for (let i = 0; i < tanques.length; i++) {
      expect(folgaAteAParede(tanques[i]!, maze)).toBeGreaterThanOrEqual(TANK_RADIUS - 1e-3);
      for (let j = i + 1; j < tanques.length; j++) {
        expect(distancia(tanques[i]!, tanques[j]!), `${i}×${j} continuaram um dentro do outro`).toBeGreaterThanOrEqual(
          DIAMETRO - 1e-3,
        );
      }
    }
  });

  it('o resultado não depende da ordem de inserção no Map — só do ID', () => {
    // O servidor insere pela ordem de chegada dos jogadores; o cliente, pela ordem em que o
    // estado frio chega. Se a separação seguisse a ordem do `Map`, as duas pontas divergiriam.
    const maze = makeMaze(4242, 6, 16 / 9);
    const rng = mulberry32(4242);
    const spawns = spawnPoints(maze, 6, rng);
    const construir = (ordem: readonly number[]): SimState => {
      const tanks = new Map<string, Tank>();
      for (const i of ordem) {
        const sp = spawns[i]!;
        tanks.set(`p${i}`, tanque(`p${i}`, sp.x, sp.y, (i / 6) * Math.PI * 2));
      }
      return { tick: 0, maze, tanks, bullets: [], nextBulletId: 0 };
    };

    const inputsDoTick = (tick: number): Map<string, Input> => {
      const inputs = new Map<string, Input>();
      for (let i = 0; i < 6; i++) {
        const fase = (tick + i * 3) % 24;
        inputs.set(`p${i}`, {
          mover: fase % 5 === 0 ? null : ((fase % 8) * Math.PI) / 4,
          fire: fase % 7 === 0,
        });
      }
      return inputs;
    };

    const rodar = (state: SimState): string => {
      for (let i = 0; i < 600; i++) {
        step(state, inputsDoTick(i), DT);
        state.tick++;
      }
      return [...state.tanks.keys()]
        .sort()
        .map((id) => {
          const t = state.tanks.get(id)!;
          return `${id}:${t.x.toFixed(6)}:${t.y.toFixed(6)}:${t.heading.toFixed(6)}:${t.alive}`;
        })
        .join('|');
    };

    const direta = rodar(construir([0, 1, 2, 3, 4, 5]));
    const invertida = rodar(construir([5, 4, 3, 2, 1, 0]));
    const embaralhada = rodar(construir([2, 5, 0, 4, 1, 3]));
    expect(invertida).toBe(direta);
    expect(embaralhada).toBe(direta);
  });

  it('tanque morto não empurra ninguém', () => {
    const maze = arenaVazia();
    const vivo = tanque('pA', 120, 168, 0);
    const morto = tanque('pB', 130, 168, 0);
    morto.alive = false;
    const state = estado(maze, [vivo, morto]);
    const inputs = new Map<string, Input>([['pA', { mover: null, fire: false }]]);

    step(state, inputs, DT);
    expect(vivo.x).toBe(120);
    expect(morto.x).toBe(130);
  });
});
