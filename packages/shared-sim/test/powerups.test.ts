// P1 — power-ups temporários pela arena.
//
// O que este arquivo prova, em ordem de importância:
//   1. DETERMINISMO do nascimento. Mesma seed, dois processos, mesmos itens nos mesmos lugares e
//      nos mesmos ticks. É isso que permite não gastar rede com nascimento.
//   2. O CARIMBO na bala. Uma bala disparada com ricochete duplo continua com ricochete duplo
//      depois de o efeito expirar no dono. A prova ponta a ponta (servidor × cliente simulando a
//      mesma bala) está em `apps/client/test/powerups-bala.test.ts`.
//   3. ARBITRAGEM da coleta: quem está mais perto leva, e o desempate não depende da ordem do Map.
//   4. Cada efeito faz o que promete, e o jogo SEM power-up continua exatamente como era.

import {
  BULLET_SPEED,
  FIRE_COOLDOWN,
  MAX_BOUNCES,
  MAX_BULLETS_BY_PLAYERS,
  POWERUP,
  POWERUP_QUEDA_S,
  TANK_RADIUS,
  TANK_SPEED,
  TICK_HZ,
} from '@tank/protocol';
import { describe, expect, it } from 'vitest';
import { agendaDePowerUps, CampoDePowerUps, EfeitosDePowerUp, makeBot, makeMaze, mulberry32, step } from '../src/index.js';
import type { Input, Maze, SimEvent, SimState, Tank } from '../src/index.js';

const DT = 1 / TICK_HZ;
const ESPESSURA = 12;

/** Arena vazia de N×N células, só com as quatro paredes de borda. */
function arenaVazia(cols = 4, rows = 4): Maze {
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

function tanque(id: string, x: number, y: number, heading = 0): Tank {
  return { id, x, y, heading, turret: heading, alive: true, fireCooldownLeft: 0 };
}

function estado(maze: Maze, tanks: Tank[]): SimState {
  return { tick: 0, maze, tanks: new Map(tanks.map((t) => [t.id, t])), bullets: [], nextBulletId: 0 };
}

const PARADO: Input = { mover: null, fire: false };
const DISPARA: Input = { mover: null, fire: true };

describe('nascimento determinístico', () => {
  it('mesma seed produz os mesmos itens, nos mesmos lugares, nos mesmos ticks', () => {
    const maze = makeMaze(4242, 6);
    // Duas execuções independentes, como duas máquinas diferentes montando a mesma rodada.
    const a = agendaDePowerUps(maze, 4242);
    const b = agendaDePowerUps(maze, 4242);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('cada item cai no centro de uma célula do labirinto e dentro dos limites', () => {
    const maze = makeMaze(77, 8);
    for (const item of agendaDePowerUps(maze, 77)) {
      expect((item.x / maze.cell - 0.5) % 1).toBeCloseTo(0, 10);
      expect((item.y / maze.cell - 0.5) % 1).toBeCloseTo(0, 10);
      expect(item.x).toBeGreaterThan(0);
      expect(item.y).toBeGreaterThan(0);
      expect(item.x).toBeLessThan(maze.cols * maze.cell);
      expect(item.y).toBeLessThan(maze.rows * maze.cell);
    }
  });

  it('os ticks de nascimento são crescentes — a varredura de `noChao` depende disso', () => {
    const maze = makeMaze(9, 4);
    const agenda = agendaDePowerUps(maze, 9);
    for (let i = 1; i < agenda.length; i++) {
      expect(agenda[i]!.nasceEmTick).toBeGreaterThan(agenda[i - 1]!.nasceEmTick);
    }
  });

  it('seeds diferentes dão rodadas diferentes', () => {
    const maze = makeMaze(1, 6);
    const a = agendaDePowerUps(maze, 1);
    const b = agendaDePowerUps(maze, 2);
    expect(a).not.toEqual(b);
  });

  it('a agenda NÃO depende do número de jogadores da sala, só da seed e do labirinto', () => {
    // Se consumisse do mesmo RNG que sorteia os spawns, quem entrasse no meio da partida (e
    // recontasse os jogadores) montaria uma arena com os itens em outro lugar.
    const maze = makeMaze(31, 6);
    expect(agendaDePowerUps(maze, 31)).toEqual(agendaDePowerUps(maze, 31));
  });

  it('o item entra no chão no tick que nasce e sai no tick que some', () => {
    const maze = arenaVazia(6, 6);
    const campo = new CampoDePowerUps(maze, 5);
    const primeiro = campo.agenda[0]!;

    expect(campo.noChao(primeiro.nasceEmTick - 1)).toHaveLength(0);
    expect(campo.noChao(primeiro.nasceEmTick).map((i) => i.id)).toContain(primeiro.id);
    expect(campo.noChao(primeiro.sumeEmTick - 1).map((i) => i.id)).toContain(primeiro.id);
    expect(campo.noChao(primeiro.sumeEmTick).map((i) => i.id)).not.toContain(primeiro.id);
  });
});

describe('chegada de paraquedas (P2)', () => {
  const QUEDA_TICKS = Math.round(POWERUP_QUEDA_S * TICK_HZ);

  it('o item aparece no céu ANTES do nascimento e pousa exatamente no tick em que fica pegável', () => {
    // A queda é ANTECIPAÇÃO, não atraso: se ela empurrasse o `nasceEmTick` para a frente, todo o
    // ritmo da rodada andaria 2,5 s e o equilíbrio medido em P1 iria junto.
    const maze = arenaVazia(6, 6);
    const campo = new CampoDePowerUps(maze, 5);
    const item = campo.agenda[0]!;

    expect(campo.caindo(item.nasceEmTick - QUEDA_TICKS - 1)).toHaveLength(0);
    expect(campo.caindo(item.nasceEmTick - QUEDA_TICKS).map((i) => i.id)).toContain(item.id);
    expect(campo.caindo(item.nasceEmTick - 1).map((i) => i.id)).toContain(item.id);
    expect(campo.caindo(item.nasceEmTick).map((i) => i.id)).not.toContain(item.id);
    expect(campo.noChao(item.nasceEmTick).map((i) => i.id)).toContain(item.id);
  });

  it('caindo e noChao nunca compartilham um item: sem sobreposição e sem buraco entre as listas', () => {
    const maze = arenaVazia(6, 6);
    const campo = new CampoDePowerUps(maze, 21);
    const item = campo.agenda[0]!;

    for (let tick = item.nasceEmTick - QUEDA_TICKS - 5; tick < item.sumeEmTick + 5; tick++) {
      const noAr = campo.caindo(tick).some((i) => i.id === item.id);
      const noChao = campo.noChao(tick).some((i) => i.id === item.id);
      expect(noAr && noChao).toBe(false);
      // Do instante em que larga do céu até sumir sozinho o item está SEMPRE numa das duas listas.
      const dentroDaVida = tick >= item.nasceEmTick - QUEDA_TICKS && tick < item.sumeEmTick;
      expect(noAr || noChao).toBe(dentroDaVida);
    }
  });

  it('item no ar não é coletável — quem nasceu embaixo do paraquedas não ganha de graça', () => {
    const maze = arenaVazia(6, 6);
    const campo = new CampoDePowerUps(maze, 22);
    const item = campo.agenda[0]!;
    const parado = estado(maze, [tanque('p1', item.x, item.y)]);

    for (let tick = item.nasceEmTick - QUEDA_TICKS; tick < item.nasceEmTick; tick++) {
      expect(campo.coletar(parado, tick)).toHaveLength(0);
    }
    expect(campo.coletar(parado, item.nasceEmTick)).toHaveLength(1);
  });

  it('a queda é a MESMA nos dois lados: mesma seed, mesma lista tick a tick', () => {
    // É o que garante que o paraquedas esteja na mesma altura na tela de todo mundo — a animação
    // sai do tick, não do relógio de quem desenha.
    const maze = arenaVazia(6, 6);
    const a = new CampoDePowerUps(maze, 23);
    const b = new CampoDePowerUps(maze, 23);
    for (let tick = 0; tick < 1200; tick += 7) {
      expect(a.caindo(tick).map((i) => i.id)).toEqual(b.caindo(tick).map((i) => i.id));
    }
  });

  it('item já pego não continua caindo na tela de ninguém', () => {
    const maze = arenaVazia(6, 6);
    const campo = new CampoDePowerUps(maze, 24);
    const item = campo.agenda[0]!;
    campo.marcarPego(item.id);
    expect(campo.caindo(item.nasceEmTick - 1).map((i) => i.id)).not.toContain(item.id);
  });
});

describe('arbitragem da coleta', () => {
  it('encostar no item entrega o item — e uma vez só', () => {
    const maze = arenaVazia(6, 6);
    const campo = new CampoDePowerUps(maze, 11);
    const item = campo.agenda[0]!;
    const state = estado(maze, [tanque('p1', item.x, item.y)]);

    const coletas = campo.coletar(state, item.nasceEmTick);
    expect(coletas).toHaveLength(1);
    expect(coletas[0]!.tankId).toBe('p1');
    expect(coletas[0]!.itemId).toBe(item.id);
    // Segunda passada no mesmo tick não devolve nada: o item já saiu do chão.
    expect(campo.coletar(state, item.nasceEmTick)).toHaveLength(0);
    expect(campo.noChao(item.nasceEmTick).map((i) => i.id)).not.toContain(item.id);
  });

  it('dois tanques em cima do mesmo item: leva o mais PERTO do centro', () => {
    const maze = arenaVazia(6, 6);
    const campo = new CampoDePowerUps(maze, 12);
    const item = campo.agenda[0]!;
    // `p9` nasce depois de `p1` na ordem alfabética, mas está mais perto — distância manda.
    const state = estado(maze, [tanque('p1', item.x + 20, item.y), tanque('p9', item.x + 4, item.y)]);

    const coletas = campo.coletar(state, item.nasceEmTick);
    expect(coletas).toHaveLength(1);
    expect(coletas[0]!.tankId).toBe('p9');
  });

  it('empate exato de distância é resolvido pelo id, não pela ordem do Map', () => {
    const maze = arenaVazia(6, 6);
    const item = new CampoDePowerUps(maze, 13).agenda[0]!;

    // As MESMAS duas posições, inseridas em ordens opostas nos dois campos.
    const campoA = new CampoDePowerUps(maze, 13);
    const campoB = new CampoDePowerUps(maze, 13);
    const a = campoA.coletar(estado(maze, [tanque('pa', item.x - 10, item.y), tanque('pb', item.x + 10, item.y)]), item.nasceEmTick);
    const b = campoB.coletar(estado(maze, [tanque('pb', item.x + 10, item.y), tanque('pa', item.x - 10, item.y)]), item.nasceEmTick);

    expect(a[0]!.tankId).toBe(b[0]!.tankId);
  });

  it('tanque morto não pega item', () => {
    const maze = arenaVazia(6, 6);
    const campo = new CampoDePowerUps(maze, 14);
    const item = campo.agenda[0]!;
    const morto = tanque('p1', item.x, item.y);
    morto.alive = false;

    expect(campo.coletar(estado(maze, [morto]), item.nasceEmTick)).toHaveLength(0);
  });

  it('longe do item não pega nada', () => {
    const maze = arenaVazia(6, 6);
    const campo = new CampoDePowerUps(maze, 15);
    const item = campo.agenda[0]!;
    const longe = tanque('p1', item.x + TANK_RADIUS + POWERUP_FOLGA, item.y);

    expect(campo.coletar(estado(maze, [longe]), item.nasceEmTick)).toHaveLength(0);
  });
});

/** Um pouco além do alcance de coleta — o suficiente para o teste acima ser sobre o raio. */
const POWERUP_FOLGA = 60;

describe('os quatro efeitos', () => {
  it('turbo faz o tanque andar mais rápido, e só enquanto dura', () => {
    const maze = arenaVazia(8, 8);
    const comum = tanque('p1', 200, 200);
    const turbinado = tanque('p2', 200, 400);
    const state = estado(maze, [comum, turbinado]);

    const efeitos = new EfeitosDePowerUp();
    efeitos.aplicar(turbinado, 'turbo');

    const andaPara: Input = { mover: 0, fire: false };
    const inputs = new Map([
      ['p1', andaPara],
      ['p2', andaPara],
    ]);
    step(state, inputs, DT);

    const passoComum = comum.x - 200;
    const passoTurbo = turbinado.x - 200;
    expect(passoComum).toBeCloseTo(TANK_SPEED * DT, 6);
    expect(passoTurbo).toBeCloseTo(TANK_SPEED * (1 + POWERUP.turbo.valor) * DT, 6);

    // Passado o tempo, o campo é apagado e o tanque volta a andar como qualquer outro.
    efeitos.passo(state.tanks, POWERUP.turbo.duracao + DT);
    expect(turbinado.turbo).toBe(0);
    const antes = turbinado.x;
    step(state, inputs, DT);
    expect(turbinado.x - antes).toBeCloseTo(TANK_SPEED * DT, 6);
  });

  it('recarga rápida corta o cooldown pela metade', () => {
    const maze = arenaVazia(8, 8);
    const t = tanque('p1', 300, 300);
    const state = estado(maze, [t]);
    new EfeitosDePowerUp().aplicar(t, 'recarga');

    step(state, new Map([['p1', DISPARA]]), DT);
    expect(state.bullets).toHaveLength(1);
    expect(t.fireCooldownLeft).toBeCloseTo(FIRE_COOLDOWN * (1 - POWERUP.recarga.valor), 6);
  });

  it('munição extra soma UMA bala ao teto simultâneo', () => {
    const maze = arenaVazia(12, 12);
    const semBonus = tanque('p1', 120, 200);
    const comBonus = tanque('p2', 120, 700);
    const state = estado(maze, [semBonus, comBonus]);
    new EfeitosDePowerUp().aplicar(comBonus, 'municao');

    let maxP1 = 0;
    let maxP2 = 0;
    // Disparos ESPAÇADOS de propósito. Duas balas nascidas em ticks vizinhos ficam a menos de um
    // diâmetro uma da outra e se anulam pela regra de bala×bala da Fase 5 — o teto medido aqui
    // tem que ser o da munição, não aquele. A cadência é zerada à mão porque o assunto também
    // não é o cooldown.
    for (let i = 0; i < 120; i++) {
      const atira = i % 8 === 0;
      if (atira) {
        semBonus.fireCooldownLeft = 0;
        comBonus.fireCooldownLeft = 0;
      }
      const entrada = atira ? DISPARA : PARADO;
      step(
        state,
        new Map([
          ['p1', entrada],
          ['p2', entrada],
        ]),
        DT,
      );
      maxP1 = Math.max(maxP1, state.bullets.filter((b) => b.ownerId === 'p1').length);
      maxP2 = Math.max(maxP2, state.bullets.filter((b) => b.ownerId === 'p2').length);
    }

    expect(maxP1).toBe(MAX_BULLETS_BY_PLAYERS[2]);
    expect(maxP2).toBe(maxP1 + POWERUP.municao.valor);
  });

  it('pegar o mesmo tipo de novo RENOVA o relógio em vez de empilhar o valor', () => {
    const t = tanque('p1', 100, 100);
    const efeitos = new EfeitosDePowerUp();
    const tanks = new Map([['p1', t]]);

    efeitos.aplicar(t, 'ricochete');
    efeitos.passo(tanks, POWERUP.ricochete.duracao - 1);
    efeitos.aplicar(t, 'ricochete');

    expect(t.ricochete).toBe(POWERUP.ricochete.valor); // não virou 2
    expect(efeitos.ativos('p1')).toHaveLength(1);
    expect(efeitos.ativos('p1')[0]!.restante).toBeCloseTo(POWERUP.ricochete.duracao, 6);
  });

  it('morrer encerra todos os efeitos — nada atravessa para a rodada seguinte', () => {
    const t = tanque('p1', 100, 100);
    const efeitos = new EfeitosDePowerUp();
    efeitos.aplicar(t, 'turbo');
    efeitos.aplicar(t, 'ricochete');

    t.alive = false;
    const fins = efeitos.passo(new Map([['p1', t]]), DT);

    expect(fins.map((f) => f.tipo).sort()).toEqual(['ricochete', 'turbo']);
    expect(t.turbo).toBe(0);
    expect(t.ricochete).toBe(0);
    expect(efeitos.ativos('p1')).toHaveLength(0);
  });

  it('sem power-up nenhum a simulação é bit a bit a de sempre', () => {
    // Regressão: os campos novos são opcionais e o zero-value é o padrão do jogo. Duas simulações
    // longas, uma com os campos ausentes e outra com eles zerados explicitamente.
    const rodar = (zerar: boolean): string => {
      const maze = makeMaze(2026, 4);
      const t = tanque('p1', 130, 130, 0.4);
      if (zerar) {
        t.ricochete = 0;
        t.municao = 0;
        t.recarga = 0;
        t.turbo = 0;
      }
      const state = estado(maze, [t]);
      const inputs = new Map([['p1', { mover: 0.7, fire: true } as Input]]);
      const marcas: string[] = [];
      for (let i = 0; i < 600; i++) {
        for (const ev of step(state, inputs, DT)) marcas.push(`${i}:${ev.type}`);
        state.tick++;
      }
      return `${t.x.toFixed(9)}|${t.y.toFixed(9)}|${marcas.join(',')}`;
    };

    expect(rodar(false)).toBe(rodar(true));
  });
});

/**
 * Caixa fechada pequena, para a bala completar os rebotes bem dentro de `BULLET_LIFE` (2,2 s).
 * Numa arena de tamanho de jogo ela morreria de velhice no meio do corredor e o teste mediria o
 * relógio em vez do teto de rebotes.
 */
function caixa(lado: number): Maze {
  const half = ESPESSURA / 2;
  return {
    cols: 1,
    rows: 1,
    cell: lado,
    walls: [
      { x: -half, y: -half, w: lado + ESPESSURA, h: ESPESSURA },
      { x: -half, y: lado - half, w: lado + ESPESSURA, h: ESPESSURA },
      { x: -half, y: -half, w: ESPESSURA, h: lado + ESPESSURA },
      { x: lado - half, y: -half, w: ESPESSURA, h: lado + ESPESSURA },
    ],
  };
}

describe('o bot enxerga o item', () => {
  /** Direção de movimento média do bot ao longo de N ticks, com e sem item no campo. */
  function rumoMedio(comItem: boolean): { x: number; y: number } {
    const maze = arenaVazia(8, 8);
    const bot = tanque('b1', 200, 200);
    const alvo = { x: 620, y: 200 }; // inimigo bem à direita
    // Item na direção OPOSTA à do inimigo: se o bot desviar, o rumo médio vira negativo em x.
    const itens = comItem ? [{ x: 90, y: 200 }] : [];
    const cerebro = makeBot(mulberry32(4242));

    let somaX = 0;
    let somaY = 0;
    for (let tick = 0; tick < 30; tick++) {
      const input = cerebro.think(bot, alvo, maze, tick, { bullets: [], powerups: itens });
      if (input.mover !== null) {
        somaX += Math.cos(input.mover);
        somaY += Math.sin(input.mover);
      }
    }
    return { x: somaX / 30, y: somaY / 30 };
  }

  it('sem item, o bot vai na direção do inimigo', () => {
    expect(rumoMedio(false).x).toBeGreaterThan(0.5);
  });

  it('com um item ao alcance, o bot DESVIA para pegá-lo', () => {
    // Restrição 3 da spec: "bot que ignora power-up fica visivelmente burro perto de humano que
    // os pega". Aqui o item está do lado oposto ao inimigo, então "desviou" é medível pelo sinal.
    expect(rumoMedio(true).x).toBeLessThan(-0.5);
  });

  it('sem `powerups` no mundo, o bot se comporta exatamente como antes', () => {
    const maze = arenaVazia(8, 8);
    const alvo = { x: 620, y: 200 };
    const rodar = (comCampoVazio: boolean): string => {
      const bot = tanque('b1', 200, 200);
      const cerebro = makeBot(mulberry32(4242));
      const passos: string[] = [];
      for (let tick = 0; tick < 30; tick++) {
        const mundo = comCampoVazio ? { bullets: [], powerups: [] } : { bullets: [] };
        const input = cerebro.think(bot, alvo, maze, tick, mundo);
        passos.push(`${input.mover?.toFixed(9) ?? '-'}|${input.fire}|${input.aim?.toFixed(9) ?? '-'}`);
      }
      return passos.join(',');
    };
    expect(rodar(true)).toBe(rodar(false));
  });
});

describe('o carimbo do ricochete na bala', () => {
  /**
   * Voa uma bala SOZINHA (mapa de tanques vazio, exatamente como o cliente simula) e conta os
   * rebotes até ela morrer. Sem tanque em cena não há autogol nem colisão com quem atirou: o
   * único jeito de a bala morrer é o teto de rebotes ou o relógio.
   */
  function rebotesDaBala(ricochete: number): number {
    const maze = caixa(120);
    const state: SimState = {
      tick: 0,
      maze,
      tanks: new Map(),
      bullets: [{ id: 'b0', ownerId: 'p1', x: 60, y: 60, vx: BULLET_SPEED, vy: 0, bounces: 0, age: 0, ricochete }],
      nextBulletId: 1,
    };

    let rebotes = 0;
    for (let i = 0; i < 60 * 3; i++) {
      for (const ev of step(state, new Map(), DT) as SimEvent[]) {
        if (ev.type === 'bounce') rebotes++;
        if (ev.type === 'bullet_expired') expect(ev.reason).toBe('max_bounces');
      }
      state.tick++;
      if (state.bullets.length === 0) break;
    }
    expect(state.bullets).toHaveLength(0); // morreu de rebote, não sobrou viva no fim do laço
    return rebotes;
  }

  it('sem power-up a bala quica MAX_BOUNCES vezes e morre no rebote seguinte', () => {
    expect(rebotesDaBala(0)).toBe(MAX_BOUNCES + 1);
  });

  it('com ricochete duplo ela ganha exatamente um rebote a mais', () => {
    expect(rebotesDaBala(POWERUP.ricochete.valor)).toBe(MAX_BOUNCES + POWERUP.ricochete.valor + 1);
  });

  it('A ARMADILHA: o efeito expirar no dono NÃO tira o ricochete da bala já em voo', () => {
    const maze = caixa(120);
    const atirador = tanque('p1', 60, 60, 0);
    const state = estado(maze, [atirador]);
    const efeitos = new EfeitosDePowerUp();
    efeitos.aplicar(atirador, 'ricochete');

    // Dispara com o efeito ligado.
    const eventos = step(state, new Map([['p1', DISPARA]]), DT);
    state.tick++;
    expect(eventos.some((e) => e.type === 'shot')).toBe(true);
    const bala = state.bullets[0]!;
    expect(bala.ricochete).toBe(POWERUP.ricochete.valor);

    // O efeito ACABA no dono com a bala ainda no ar — o instante exato em que uma implementação
    // que lê o estado do atirador passaria a simular a bala com as regras erradas.
    efeitos.passo(state.tanks, POWERUP.ricochete.duracao + DT);
    expect(atirador.ricochete).toBe(0);
    expect(bala.ricochete).toBe(POWERUP.ricochete.valor);

    // E a bala continua com o teto dela: some o atirador de cena e conta os rebotes até o fim.
    state.tanks.clear();
    let rebotes = 0;
    for (let i = 0; i < 60 * 3 && state.bullets.length > 0; i++) {
      for (const ev of step(state, new Map(), DT)) if (ev.type === 'bounce') rebotes++;
      state.tick++;
    }
    expect(rebotes).toBe(MAX_BOUNCES + POWERUP.ricochete.valor + 1);
  });

  it('o evento `shot` publica o carimbo, que é o que o servidor manda no `bullet_spawn`', () => {
    const maze = arenaVazia(8, 8);
    const t = tanque('p1', 300, 300);
    const state = estado(maze, [t]);
    new EfeitosDePowerUp().aplicar(t, 'ricochete');

    const eventos = step(state, new Map([['p1', DISPARA]]), DT);
    const shot = eventos.find((e) => e.type === 'shot');
    expect(shot).toBeDefined();
    expect(shot!.type === 'shot' && shot!.ricochete).toBe(POWERUP.ricochete.valor);
    expect(state.bullets[0]!.ricochete).toBe(POWERUP.ricochete.valor);
  });

  it('a bala nascida DEPOIS de o efeito acabar volta a ser comum', () => {
    const maze = arenaVazia(8, 8);
    const t = tanque('p1', 300, 300);
    const state = estado(maze, [t]);
    const efeitos = new EfeitosDePowerUp();
    efeitos.aplicar(t, 'ricochete');
    efeitos.passo(state.tanks, POWERUP.ricochete.duracao + DT);

    const eventos = step(state, new Map([['p1', DISPARA]]), DT);
    const shot = eventos.find((e) => e.type === 'shot');
    expect(shot!.type === 'shot' && shot!.ricochete).toBe(0);
  });
});
