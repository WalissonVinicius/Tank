import {
  BULLET_EXPLOSION_RADIUS,
  BULLET_LIFE,
  BULLET_RADIUS,
  BULLET_SPEED,
  MAX_BOUNCES,
  TANK_RADIUS,
  TICK_HZ,
} from '@tank/protocol';
import { describe, expect, it } from 'vitest';
import { step } from '../src/index.js';
import type { Bullet, Maze, SimEvent, SimState, Tank } from '../src/index.js';

/** Arena sem parede nenhuma: aqui só interessa a bala contra o relógio e contra outra bala. */
function arenaAberta(): Maze {
  return { cols: 10, rows: 10, cell: 84, walls: [] };
}

function novaBala(id: string, x: number, y: number, angulo: number, ownerId = 'p1'): Bullet {
  return {
    id,
    ownerId,
    x,
    y,
    vx: Math.cos(angulo) * BULLET_SPEED,
    vy: Math.sin(angulo) * BULLET_SPEED,
    bounces: 0,
    age: 0,
  };
}

function novoEstado(bullets: Bullet[], tanks: Tank[] = [], maze: Maze = arenaAberta()): SimState {
  return {
    tick: 0,
    maze,
    tanks: new Map(tanks.map((t) => [t.id, t])),
    bullets,
    nextBulletId: bullets.length,
  };
}

function avancar(state: SimState, dt: number, ticks: number): SimEvent[] {
  const todos: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    todos.push(...step(state, new Map(), dt));
    state.tick++;
  }
  return todos;
}

describe('vida da bala (Fase 10: 1 ricochete OU 2,2 s, o que vier primeiro)', () => {
  it('sem parede nenhuma, a bala vive exatamente BULLET_LIFE = 2,2 s e explode ao esgotar', () => {
    expect(BULLET_LIFE).toBe(2.2);

    const dt = 1 / TICK_HZ;
    const state = novoEstado([novaBala('b0', 100, 100, 0)]);

    let expirou: Extract<SimEvent, { type: 'bullet_expired' }> | undefined;
    let idadeNoUltimoTickVivo = 0;
    let xAntes = 0;
    let yAntes = 0;
    let ticksVividos = 0;

    for (let i = 0; i < 400 && !expirou; i++) {
      const viva = state.bullets[0]!;
      idadeNoUltimoTickVivo = viva.age;
      xAntes = viva.x;
      yAntes = viva.y;
      for (const ev of step(state, new Map(), dt)) {
        if (ev.type === 'bullet_expired') expirou = ev;
      }
      state.tick++;
      ticksVividos = i + 1;
    }

    expect(expirou, 'a bala tinha que expirar sozinha').toBeDefined();
    expect(expirou).toMatchObject({ bulletId: 'b0', reason: 'life' });
    expect(state.bullets).toHaveLength(0);

    // Exatamente 3 s: no tick anterior a idade ainda não tinha chegado a BULLET_LIFE, e a morte
    // cai no primeiro tick que atravessa a marca — nem um passo antes, nem um depois.
    expect(idadeNoUltimoTickVivo).toBeLessThan(BULLET_LIFE);
    expect(idadeNoUltimoTickVivo + dt).toBeGreaterThan(BULLET_LIFE);
    expect(ticksVividos * dt).toBeCloseTo(BULLET_LIFE, 1);

    // O evento carrega a posição do estouro — é dela que o render tira o lugar da explosão. A
    // bala não anda no tick em que expira, então explode exatamente onde parou.
    expect(expirou).toMatchObject({ x: xAntes, y: yAntes });
  });

  it('a explosão de fim de vida não mata quem está dentro do raio dela', () => {
    const dt = 1 / TICK_HZ;
    // Tanque a uma distância que NÃO encosta na bala (senão morreria por contato, que é outra
    // regra) mas está bem dentro do raio da explosão.
    const distancia = (TANK_RADIUS + BULLET_RADIUS + BULLET_EXPLOSION_RADIUS) / 2;
    expect(distancia).toBeGreaterThan(TANK_RADIUS + BULLET_RADIUS);
    expect(distancia).toBeLessThan(BULLET_EXPLOSION_RADIUS);

    const bala: Bullet = { id: 'b0', ownerId: 'p2', x: 300, y: 300, vx: 0, vy: 0, bounces: 0, age: 0 };
    const alvo: Tank = { id: 'p1', x: 300 + distancia, y: 300, heading: 0, turret: 0, alive: true, fireCooldownLeft: 0 };
    const state = novoEstado([bala], [alvo]);

    const eventos = avancar(state, dt, Math.ceil(BULLET_LIFE / dt) + 5);

    expect(eventos.some((e) => e.type === 'bullet_expired' && e.reason === 'life')).toBe(true);
    expect(eventos.some((e) => e.type === 'death'), 'explosão de bala é cosmética por decisão da Fase 5').toBe(false);
    expect(alvo.alive).toBe(true);
  });

  // Fase 10: a parede volta a ser causa de morte. No corredor fechado a bala nem chega perto do
  // teto de tempo — ela vai, volta e morre no segundo toque, em silêncio (sem explosão).
  it('num corredor fechado ela quica uma vez e morre no segundo toque, sem esperar o relógio', () => {
    const dt = 1 / TICK_HZ;
    // Duas paredes paralelas a 220 px de distância: a 215 px/s a bala alcança as duas dentro
    // dos 2,2 s de teto, então quem decide é o rebote e não o tempo.
    const corredor: Maze = {
      cols: 4,
      rows: 4,
      cell: 84,
      walls: [
        { x: 300, y: 0, w: 20, h: 400 },
        { x: 60, y: 0, w: 20, h: 400 },
      ],
    };
    const state = novoEstado([novaBala('b0', 150, 100, 0)], [], corredor);

    const ticksAteOTeto = Math.ceil(BULLET_LIFE / dt) + 5;
    const eventos = avancar(state, dt, ticksAteOTeto);
    const ricochetes = eventos.filter((e) => e.type === 'bounce').length;
    const fim = eventos.find((e) => e.type === 'bullet_expired');

    expect(ricochetes, 'exatamente o rebote permitido mais o que a mata').toBe(MAX_BOUNCES + 1);
    expect(fim, 'a bala tinha que morrer na parede').toBeDefined();
    expect(fim).toMatchObject({ bulletId: 'b0', reason: 'max_bounces' });
    expect(fim).toHaveProperty('x');
    expect(state.bullets).toHaveLength(0);
  });

  it('a vida é o MENOR entre 1 ricochete e BULLET_LIFE: quem bate morre antes de quem não bate', () => {
    const dt = 1 / TICK_HZ;
    const corredor: Maze = {
      cols: 4,
      rows: 4,
      cell: 84,
      walls: [
        { x: 300, y: 0, w: 20, h: 400 },
        { x: 60, y: 0, w: 20, h: 400 },
      ],
    };

    const medir = (maze: Maze): { ticks: number; ricochetes: number; reason: string } => {
      const state = novoEstado([novaBala('b0', 150, 100, 0)], [], maze);
      let ricochetes = 0;
      for (let i = 0; i < 400; i++) {
        for (const ev of step(state, new Map(), dt)) {
          if (ev.type === 'bounce') ricochetes++;
          if (ev.type === 'bullet_expired') return { ticks: i + 1, ricochetes, reason: ev.reason };
        }
        state.tick++;
      }
      throw new Error('a bala não morreu');
    };

    const aberto = medir(arenaAberta());
    const preso = medir(corredor);

    expect(aberto.ricochetes).toBe(0);
    expect(aberto.reason, 'sem parede, quem mata é o relógio').toBe('life');
    expect(aberto.ticks * dt).toBeCloseTo(BULLET_LIFE, 1);

    expect(preso.ricochetes).toBe(MAX_BOUNCES + 1);
    expect(preso.reason, 'com parede, quem mata é o rebote').toBe('max_bounces');
    expect(preso.ticks, 'a parede alcança a bala antes do relógio').toBeLessThan(aberto.ticks);
  });
});

describe('colisão bala × bala (Fase 5)', () => {
  it('duas balas em rota frontal se destroem, e o evento traz o ponto de encontro', () => {
    const dt = 1 / TICK_HZ;
    const state = novoEstado([novaBala('b0', 200, 300, 0, 'p1'), novaBala('b1', 400, 300, Math.PI, 'p2')]);

    const eventos = avancar(state, dt, 60);
    const choque = eventos.find((e) => e.type === 'bullet_clash');
    expect(choque, 'as duas balas tinham que se encontrar').toBeDefined();
    expect(choque).toMatchObject({ aId: 'b0', bId: 'b1' });
    expect(state.bullets, 'as DUAS somem no choque').toHaveLength(0);

    // Encontro no meio do caminho entre os dois pontos de partida.
    const c = choque as Extract<SimEvent, { type: 'bullet_clash' }>;
    expect(c.x).toBeGreaterThan(295);
    expect(c.x).toBeLessThan(305);
    expect(c.y).toBeCloseTo(300, 6);
  });

  /**
   * O teste que prova o segment–segment: com `dt` grande as duas balas trocam de lado DENTRO do
   * mesmo tick. Uma checagem baseada na posição final não veria nada — as duas terminariam o tick
   * já separadas, cada uma do lado oposto de onde começou.
   */
  it('se destroem mesmo quando se cruzam entre dois ticks (dt grande)', () => {
    const dt = 0.5; // 30× o tick normal; a 215 px/s cada bala anda 107,5 px neste único passo
    const partidaA = { x: 200, y: 300 };
    const partidaB = { x: 300, y: 300 };
    const state = novoEstado([
      novaBala('b0', partidaA.x, partidaA.y, 0, 'p1'),
      novaBala('b1', partidaB.x, partidaB.y, Math.PI, 'p2'),
    ]);

    // Sanidade do cenário: sem detecção contínua, no fim do tick elas estariam a ~115 px uma da
    // outra e do lado trocado — qualquer teste por posição final passaria batido.
    const avancoNoTick = BULLET_SPEED * dt;
    expect(partidaA.x + avancoNoTick).toBeGreaterThan(partidaB.x - avancoNoTick);

    const eventos = step(state, new Map(), dt);
    expect(eventos.some((e) => e.type === 'bullet_clash')).toBe(true);
    expect(state.bullets).toHaveLength(0);
  });

  it('balas em rotas paralelas próximas não se destroem', () => {
    const dt = 1 / TICK_HZ;
    // Separação de 3× o raio somado: perto o suficiente para ficarem lado a lado a viagem
    // inteira, longe o suficiente para nunca se tocarem.
    const separacao = BULLET_RADIUS * 6;
    const state = novoEstado([novaBala('b0', 100, 300, 0, 'p1'), novaBala('b1', 100, 300 + separacao, 0, 'p2')]);

    const eventos = avancar(state, dt, 120);
    expect(eventos.some((e) => e.type === 'bullet_clash')).toBe(false);
    expect(state.bullets).toHaveLength(2);
  });

  it('duas balas que cruzam a mesma linha em instantes diferentes não se destroem', () => {
    // Cruzamento em X: a vertical só chega ao ponto de cruzamento bem depois de a horizontal ter
    // passado. A distância mínima entre os dois TRAÇADOS é zero, mas elas nunca se encontram —
    // é o falso positivo que o recorte por tempo evita.
    const dt = 0.5;
    const state = novoEstado([
      novaBala('b0', 250, 300, 0, 'p1'), // passa por x=300 em ~0,23 s
      novaBala('b1', 300, 190, Math.PI / 2, 'p2'), // só alcança y=300 em ~0,51 s
    ]);

    const eventos = step(state, new Map(), dt);
    expect(eventos.some((e) => e.type === 'bullet_clash')).toBe(false);
    expect(state.bullets).toHaveLength(2);
  });

  it('balas do mesmo dono também se destroem', () => {
    const dt = 1 / TICK_HZ;
    const state = novoEstado([novaBala('b0', 200, 300, 0, 'p1'), novaBala('b1', 400, 300, Math.PI, 'p1')]);

    const eventos = avancar(state, dt, 60);
    expect(eventos.some((e) => e.type === 'bullet_clash')).toBe(true);
    expect(state.bullets).toHaveLength(0);
  });

  it('uma bala explode uma vez só: no choque triplo sobra exatamente a terceira', () => {
    const dt = 1 / TICK_HZ;
    // b0 e b1 se encontram no meio (x≈300); b2 vem atrás de b1 e só alcançaria b0 depois.
    const state = novoEstado([
      novaBala('b0', 200, 300, 0, 'p1'),
      novaBala('b1', 400, 300, Math.PI, 'p2'),
      novaBala('b2', 460, 300, Math.PI, 'p3'),
    ]);

    const eventos = avancar(state, dt, 60);
    const choques = eventos.filter((e) => e.type === 'bullet_clash');
    expect(choques).toHaveLength(1);
    expect(state.bullets.map((b) => b.id)).toEqual(['b2']);
  });

  it('o resultado não depende da ordem das balas no array', () => {
    const dt = 1 / 90; // dt qualquer, diferente do tick padrão
    const rodar = (ordem: readonly string[]): string => {
      const porId: Record<string, Bullet> = {
        b0: novaBala('b0', 200, 300, 0, 'p1'),
        b1: novaBala('b1', 400, 300, Math.PI, 'p2'),
        b2: novaBala('b2', 300, 120, Math.PI / 2, 'p3'),
      };
      const state = novoEstado(ordem.map((id) => porId[id]!));
      const choques: string[] = [];
      for (let i = 0; i < 90; i++) {
        for (const ev of step(state, new Map(), dt)) {
          if (ev.type === 'bullet_clash') choques.push(`${ev.aId}+${ev.bId}@${ev.x.toFixed(6)},${ev.y.toFixed(6)}`);
        }
        state.tick++;
      }
      return `${choques.join('|')} :: ${state.bullets.map((b) => b.id).sort().join(',')}`;
    };

    const direta = rodar(['b0', 'b1', 'b2']);
    expect(direta).toContain('b0+b1');
    expect(rodar(['b2', 'b1', 'b0'])).toBe(direta);
    expect(rodar(['b1', 'b0', 'b2'])).toBe(direta);
  });

  it('detecta o choque com o mesmo par de balas em qualquer dt', () => {
    // Mesmo cenário resolvido com passos de tamanhos bem diferentes: quem decide é a geometria,
    // não a granularidade do tick. Com sub-amostragem grosseira, o dt maior deixaria passar.
    for (const dt of [1 / 240, 1 / 60, 1 / 30, 0.1, 0.25, 0.5]) {
      const state = novoEstado([novaBala('b0', 200, 300, 0, 'p1'), novaBala('b1', 400, 300, Math.PI, 'p2')]);
      const eventos = avancar(state, dt, Math.ceil(1 / dt));
      expect(eventos.some((e) => e.type === 'bullet_clash'), `dt=${dt}`).toBe(true);
      expect(state.bullets, `dt=${dt}`).toHaveLength(0);
    }
  });
});
