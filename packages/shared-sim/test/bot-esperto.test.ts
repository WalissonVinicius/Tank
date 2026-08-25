// Fase 13 §4 — o bot deixou de ser "anda até o alvo e atira quando enxerga".
//
// As quatro capacidades novas (desviar de bala, mirar com ricochete, não se matar sozinho e usar
// a parede) são ligadas por dificuldade, e o critério de pronto do usuário é um confronto: num
// duelo controlado, o bot DIFÍCIL precisa vencer o FÁCIL na maioria de 100 partidas com seeds
// diferentes. O número real sai no `console.log` do último teste.
import { describe, expect, it } from 'vitest';
import { BULLET_SPEED, CELL, TANK_RADIUS, TICK_HZ } from '@tank/protocol';
import { BOT_DIFFICULTY, makeBot, makeMaze, mulberry32, spawnPoints, step } from '@tank/shared-sim';
import type { Bot, Bullet, Input, Maze, SimState, Tank } from '@tank/shared-sim';

const DT = 1 / TICK_HZ;

function tanque(id: string, x: number, y: number, heading = 0): Tank {
  return { id, x, y, heading, turret: heading, alive: true, fireCooldownLeft: 0 };
}

function bala(id: string, ownerId: string, x: number, y: number, angulo: number): Bullet {
  return {
    id,
    ownerId,
    x,
    y,
    vx: Math.cos(angulo) * BULLET_SPEED,
    vy: Math.sin(angulo) * BULLET_SPEED,
    bounces: 0,
    age: 0.2,
  };
}

/** Labirinto de um corredor só: uma sala aberta cercada de paredes, para testar geometria à mão. */
function arenaVazia(cols = 8, rows = 6): Maze {
  const w = cols * CELL;
  const h = rows * CELL;
  const e = 10;
  return {
    cols,
    rows,
    cell: CELL,
    walls: [
      { x: -e, y: -e, w: w + e * 2, h: e },
      { x: -e, y: h, w: w + e * 2, h: e },
      { x: -e, y: -e, w: e, h: h + e * 2 },
      { x: w, y: -e, w: e, h: h + e * 2 },
    ],
  };
}

describe('bot — desvio de bala', () => {
  it('sai da linha quando uma bala vem em cima dele', () => {
    const maze = arenaVazia();
    const bot = makeBot(mulberry32(5), BOT_DIFFICULTY.dificil);
    // Tanque no meio da arena, bala vindo da esquerda exatamente na altura dele.
    const tank = tanque('bot', CELL * 4, CELL * 3, 0);
    const emVoo = [bala('b0', 'inimigo', CELL * 1.2, CELL * 3, 0)];
    const alvo = { x: CELL * 1.2, y: CELL * 3 };

    const comBalas = bot.think(tank, alvo, maze, 0, { bullets: emVoo });
    expect(comBalas.move).not.toBe(0);

    // O chassi tem que estar buscando a PERPENDICULAR da trajetória (norte ou sul), não a
    // direção do inimigo (oeste) — girar para o lado é o que tira o tanque da frente do tiro.
    const state: SimState = { tick: 0, maze, tanks: new Map([[tank.id, tank]]), bullets: [], nextBulletId: 0 };
    const yInicial = tank.y;
    for (let i = 0; i < 90; i++) {
      const input = bot.think(tank, alvo, maze, i, { bullets: emVoo });
      step(state, new Map([[tank.id, input]]), DT);
    }
    expect(Math.abs(tank.y - yInicial)).toBeGreaterThan(TANK_RADIUS);
  });

  it('ignora bala que já passou ou que vai passar longe', () => {
    const maze = arenaVazia();
    const bot = makeBot(mulberry32(5), BOT_DIFFICULTY.dificil);
    const tank = tanque('bot', CELL * 4, CELL * 3, 0);
    const alvo = { x: CELL * 6.5, y: CELL * 3 };

    // Bala indo embora (já passou do tanque, seguindo para o leste na frente dele).
    const passou = [bala('b0', 'inimigo', CELL * 5.5, CELL * 3, 0)];
    const semAmeaca = bot.think(tank, alvo, maze, 0, { bullets: passou });
    // Com o alvo à vista e sem ameaça, ele mira no alvo e avança — não corre para o lado.
    expect(Math.abs(semAmeaca.aim ?? 99)).toBeLessThan(0.2);

    // Bala paralela, duas células acima: nunca cruza o tanque.
    const longe = [bala('b1', 'inimigo', CELL * 1.2, CELL * 1, 0)];
    const semAmeaca2 = bot.think(tank, alvo, maze, 1, { bullets: longe });
    expect(Math.abs(semAmeaca2.aim ?? 99)).toBeLessThan(0.2);
  });

  it('sem `mundo` (nenhuma bala informada) o bot continua funcionando', () => {
    const maze = makeMaze(42, 6);
    const bot = makeBot(mulberry32(5), BOT_DIFFICULTY.dificil);
    const tank = tanque('bot', CELL / 2, CELL / 2);
    expect(() => bot.think(tank, { x: CELL * 3, y: CELL * 3 }, maze, 0)).not.toThrow();
  });
});

/**
 * Sala com um pilar no meio: o alvo fica na sombra do pilar (sem linha de visão), mas as paredes
 * de cima e de baixo são espelhos ao alcance da bala — a imagem espelhada do alvo fica a 420 px
 * do atirador, dentro dos 473 px que a bala percorre antes de morrer de velhice.
 */
function arenaComPilar(): { maze: Maze; tank: Tank; alvo: { x: number; y: number } } {
  const maze = arenaVazia(6, 4);
  maze.walls.push({ x: CELL * 2.6, y: CELL * 1.2, w: CELL * 0.8, h: CELL * 1.6 });
  return {
    maze,
    tank: tanque('bot', CELL * 1.5, CELL * 2, 0),
    alvo: { x: CELL * 4.5, y: CELL * 2 },
  };
}

describe('bot — mira com ricochete', () => {
  it('acha um ângulo que quica e alcança o alvo escondido atrás de uma parede', () => {
    const { maze, tank, alvo } = arenaComPilar();
    const bot = makeBot(mulberry32(3), BOT_DIFFICULTY.dificil);

    const input = bot.think(tank, alvo, maze, 0, { bullets: [] });
    expect(input.aim).toBeDefined();
    // Sem ricochete a mira nunca sairia da linha do alvo; aqui ela aponta para o teto/chão.
    const direto = Math.atan2(alvo.y - tank.y, alvo.x - tank.x);
    expect(Math.abs(input.aim! - direto)).toBeGreaterThan(0.4);
  });

  it('o bot fácil não ricocheteia — sem linha de visão ele não atira', () => {
    const { maze, tank, alvo } = arenaComPilar();
    const bot = makeBot(mulberry32(3), BOT_DIFFICULTY.facil);

    for (let tick = 0; tick < 30; tick++) {
      expect(bot.think(tank, alvo, maze, tick, { bullets: [] }).fire).toBe(false);
    }
  });
});

describe('bot — freio de autogol', () => {
  it('não atira quando a própria trajetória volta em cima dele', () => {
    // Beco: tanque encostado no fundo de um corredor curto, mirando na parede a poucos px. A bala
    // quica de volta e o atravessa antes de morrer.
    const fundo = 30;
    const maze: Maze = {
      cols: 4,
      rows: 3,
      cell: CELL,
      walls: [
        { x: 0, y: 0, w: CELL * 4, h: fundo },
        { x: 0, y: CELL * 3 - fundo, w: CELL * 4, h: fundo },
        { x: 0, y: 0, w: fundo, h: CELL * 3 },
        { x: CELL * 4 - fundo, y: 0, w: fundo, h: CELL * 3 },
      ],
    };

    const dificil = makeBot(mulberry32(9), BOT_DIFFICULTY.dificil);
    const facil = makeBot(mulberry32(9), BOT_DIFFICULTY.facil);

    // Tanque colado na parede de cima, torre apontada para ela: o tiro volta reto no dono.
    const perto = fundo + TANK_RADIUS + 1;
    const tankD = tanque('d', CELL * 2, perto, -Math.PI / 2);
    tankD.turret = -Math.PI / 2;
    const tankF = tanque('f', CELL * 2, perto, -Math.PI / 2);
    tankF.turret = -Math.PI / 2;
    const alvo = { x: CELL * 2, y: CELL * 3 - perto };

    expect(dificil.think(tankD, alvo, maze, 0, { bullets: [] }).fire).toBe(false);
    // O fácil não tem o freio: com o alvo à vista e a torre já alinhada, ele puxa o gatilho.
    expect(facil.think(tankF, alvo, maze, 0, { bullets: [] })).toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------
// O confronto pedido: 100 partidas com seeds diferentes, difícil × fácil
// ---------------------------------------------------------------------------------------------

const TICKS_POR_DUELO = 25 * TICK_HZ;

function duelo(seed: number, trocarLados: boolean): 'dificil' | 'facil' | 'empate' {
  const maze = makeMaze(seed, 2);
  const rng = mulberry32((seed * 2654435761) >>> 0);
  const pontos = spawnPoints(maze, 2, rng);
  const ordem: ('dificil' | 'facil')[] = trocarLados ? ['facil', 'dificil'] : ['dificil', 'facil'];

  const tanks = new Map<string, Tank>();
  const cerebros = new Map<string, Bot>();
  ordem.forEach((id, i) => {
    const p = pontos[i]!;
    const heading = rng.next() * Math.PI * 2;
    tanks.set(id, tanque(id, p.x, p.y, heading));
    cerebros.set(id, makeBot(mulberry32(seed + i * 7919 + 1), BOT_DIFFICULTY[id]));
  });

  const state: SimState = { tick: 0, maze, tanks, bullets: [], nextBulletId: 0 };
  const inputs = new Map<string, Input>();

  for (let tick = 0; tick < TICKS_POR_DUELO; tick++) {
    inputs.clear();
    for (const t of tanks.values()) {
      if (!t.alive) continue;
      let alvo: Tank | undefined;
      for (const outro of tanks.values()) if (outro.id !== t.id && outro.alive) alvo = outro;
      if (!alvo) continue;
      inputs.set(t.id, cerebros.get(t.id)!.think(t, alvo, maze, state.tick, { bullets: state.bullets }));
    }
    step(state, inputs, DT);
    state.tick += 1;

    const vivos = [...tanks.values()].filter((t) => t.alive);
    if (vivos.length <= 1) return vivos.length === 1 ? (vivos[0]!.id as 'dificil' | 'facil') : 'empate';
  }
  return 'empate';
}

describe('bot difícil × bot fácil — 100 duelos com seeds diferentes', () => {
  it('o difícil vence a maioria', () => {
    let dificil = 0;
    let facil = 0;
    let empates = 0;

    for (let i = 0; i < 100; i++) {
      // Lados trocados em metade das seeds: assim nenhuma vantagem vem do ponto de nascimento.
      const r = duelo(1000 + i * 37, i % 2 === 1);
      if (r === 'dificil') dificil += 1;
      else if (r === 'facil') facil += 1;
      else empates += 1;
    }

    console.log(`[Fase 13] duelo 100 partidas — difícil ${dificil} × fácil ${facil} (empates ${empates})`);
    expect(dificil).toBeGreaterThan(facil);
    expect(dificil + facil).toBeGreaterThan(40);
  });
});
