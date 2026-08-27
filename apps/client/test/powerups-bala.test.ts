// P1 — A ARMADILHA, provada ponta a ponta.
//
// A bala não trafega pela rede: o servidor emite `bullet_spawn` e cada cliente simula a trajetória
// localmente com o mesmo `step()`. Um power-up que muda a FÍSICA da bala (aqui, o ricochete duplo)
// só funciona se o efeito viajar CARIMBADO na mensagem e for aplicado POR BALA.
//
// Se em vez disso o cliente lesse o efeito do estado do atirador, aconteceria isto: a bala é
// disparada com ricochete duplo, o efeito expira no dono enquanto ela ainda voa, e a partir daí as
// duas pontas discordam — no cliente ela morre no primeiro rebote e some da tela, no servidor ela
// continua viva e mata alguém. "O jogador vê a bala passar longe e morrer mesmo assim."
//
// O teste abaixo monta exatamente esse cenário: SERVIDOR com tanque, efeito e expiração no meio do
// voo; CLIENTE com o `BulletPredictor` de verdade, que só recebe o `BulletSpawnMsg` e não sabe
// nada sobre power-ups. Os dois têm que produzir a MESMA trajetória, ponto a ponto.

import { BULLET_SPEED, MAX_BOUNCES, POWERUP, TICK_HZ } from '@tank/protocol';
import type { BulletSpawnMsg } from '@tank/protocol';
import { EfeitosDePowerUp, step } from '@tank/shared-sim';
import type { Input, Maze, SimState, Tank } from '@tank/shared-sim';
import { describe, expect, it } from 'vitest';
import { BulletPredictor } from '../src/net/bullets.js';

const DT = 1 / TICK_HZ;
const ESPESSURA = 12;
/** Caixa pequena: a bala completa os rebotes bem dentro de `BULLET_LIFE`. */
const LADO = 130;

function caixa(): Maze {
  const half = ESPESSURA / 2;
  return {
    cols: 1,
    rows: 1,
    cell: LADO,
    walls: [
      { x: -half, y: -half, w: LADO + ESPESSURA, h: ESPESSURA },
      { x: -half, y: LADO - half, w: LADO + ESPESSURA, h: ESPESSURA },
      { x: -half, y: -half, w: ESPESSURA, h: LADO + ESPESSURA },
      { x: LADO - half, y: -half, w: ESPESSURA, h: LADO + ESPESSURA },
    ],
  };
}

const DISPARA: Input = { mover: null, fire: true };
const PARADO: Input = { mover: null, fire: false };
const TICKS = 60 * 3;

interface Voo {
  /** Posição da bala a cada tick, enquanto ela existe. */
  pontos: { x: number; y: number }[];
  rebotes: number;
}

/**
 * O SERVIDOR. Dispara com o efeito ligado e, `ticksAteExpirar` depois, encerra o power-up no dono
 * com a bala ainda no ar. Devolve o voo autoritativo e a mensagem que sairia na rede.
 */
function servidor(comRicochete: boolean, ticksAteExpirar: number): { voo: Voo; msg: BulletSpawnMsg } {
  const maze = caixa();
  const atirador: Tank = { id: 'p1', x: LADO / 2, y: LADO / 2, heading: 0, turret: 0, alive: true, fireCooldownLeft: 0 };
  const state: SimState = { tick: 0, maze, tanks: new Map([['p1', atirador]]), bullets: [], nextBulletId: 0 };
  const efeitos = new EfeitosDePowerUp();
  if (comRicochete) efeitos.aplicar(atirador, 'ricochete');

  let msg: BulletSpawnMsg | null = null;
  const voo: Voo = { pontos: [], rebotes: 0 };
  let ticksDesdeODisparo = -1;

  for (let i = 0; i < TICKS; i++) {
    for (const ev of step(state, new Map([['p1', msg ? PARADO : DISPARA]]), DT)) {
      if (ev.type === 'shot') {
        // Exatamente o que `TankRoom.handleSimEvents` monta e transmite.
        msg = {
          id: ev.bulletId,
          ownerId: ev.ownerId,
          x: ev.x,
          y: ev.y,
          angle: ev.angle,
          vx: ev.vx,
          vy: ev.vy,
          ricochete: ev.ricochete,
          tick: ev.tick,
        };
        ticksDesdeODisparo = 0;
        // O atirador sai de cena assim que a bala nasce: numa caixa fechada ela volta e o mata no
        // segundo trecho, e o voo terminaria antes da hora. O assunto aqui é a TRAJETÓRIA, não o
        // autogol. A referência `atirador` continua viva para o efeito poder expirar nela.
        state.tanks.clear();
      } else if (ev.type === 'bounce') {
        voo.rebotes++;
      }
    }
    state.tick++;

    if (ticksDesdeODisparo >= 0) {
      const bala = state.bullets[0];
      if (bala) voo.pontos.push({ x: bala.x, y: bala.y });
      ticksDesdeODisparo++;
      // O efeito acaba no DONO com a bala ainda no ar.
      if (ticksDesdeODisparo === ticksAteExpirar) {
        efeitos.passo(new Map([['p1', atirador]]), POWERUP.ricochete.duracao + DT);
        // `?? 0` porque no caso de controle (sem power-up) o campo nunca chegou a ser escrito —
        // o que importa nos dois é o mesmo: daqui em diante o DONO não tem bônus nenhum.
        expect(atirador.ricochete ?? 0).toBe(0);
      }
      if (voo.pontos.length > 0 && state.bullets.length === 0) break;
    }
  }

  expect(msg).not.toBeNull();
  return { voo, msg: msg! };
}

/**
 * O CLIENTE, com o `BulletPredictor` de produção. Ele recebe SÓ a mensagem — sem tanque, sem
 * estado de power-up, sem saber quem atirou.
 */
function cliente(msg: BulletSpawnMsg): Voo {
  const pred = new BulletPredictor(caixa());
  pred.spawn(msg);

  const voo: Voo = { pontos: [], rebotes: 0 };
  for (let i = 0; i < TICKS; i++) {
    for (const ev of pred.tick(DT)) if (ev.type === 'bounce') voo.rebotes++;
    const bala = pred.bullets[0];
    if (bala) voo.pontos.push({ x: bala.x, y: bala.y });
    if (voo.pontos.length > 0 && pred.bullets.length === 0) break;
  }
  return voo;
}

describe('efeito que muda a física da bala viaja COM a bala', () => {
  it('o `bullet_spawn` carrega o bônus de ricochete do instante do disparo', () => {
    expect(servidor(true, 999).msg.ricochete).toBe(POWERUP.ricochete.valor);
    expect(servidor(false, 999).msg.ricochete).toBe(0);
  });

  it('bala comum: cliente e servidor traçam a MESMA trajetória', () => {
    const { voo, msg } = servidor(false, 999);
    const local = cliente(msg);
    expect(local.rebotes).toBe(MAX_BOUNCES + 1);
    expect(local.pontos).toEqual(voo.pontos);
  });

  it('bala com ricochete duplo: cliente e servidor traçam a MESMA trajetória', () => {
    const { voo, msg } = servidor(true, 999);
    const local = cliente(msg);
    expect(local.rebotes).toBe(MAX_BOUNCES + POWERUP.ricochete.valor + 1);
    expect(local.pontos).toEqual(voo.pontos);
  });

  it('A ARMADILHA: o efeito expira no dono NO MEIO DO VOO e as duas pontas continuam iguais', () => {
    // 6 ticks depois do disparo — a bala nem chegou na primeira parede.
    const { voo, msg } = servidor(true, 6);
    const local = cliente(msg);

    // A bala mantém o ricochete duplo mesmo com o dono já sem o power-up...
    expect(voo.rebotes).toBe(MAX_BOUNCES + POWERUP.ricochete.valor + 1);
    expect(local.rebotes).toBe(voo.rebotes);
    // ...e o cliente, que nunca soube do power-up, desenha exatamente o mesmo voo.
    expect(local.pontos).toEqual(voo.pontos);
    // A prova de que o teste não é vazio: sem o bônus, a bala teria morrido bem antes.
    expect(voo.pontos.length).toBeGreaterThan(servidor(false, 6).voo.pontos.length);
  });

  it('a bala não sabe quem atirou: o preditor devolve o mesmo voo sem tanque nenhum em cena', () => {
    const msg = servidor(true, 999).msg;
    // Duas simulações locais da mesma mensagem, como duas abas diferentes.
    expect(cliente(msg).pontos).toEqual(cliente(msg).pontos);
  });
});

describe('regressão: sem power-up nada mudou', () => {
  it('o vetor continua sendo o do servidor, e o ângulo continua cosmético', () => {
    const { msg } = servidor(false, 999);
    expect(Math.hypot(msg.vx, msg.vy)).toBeCloseTo(BULLET_SPEED, 6);
    expect(msg.ricochete).toBe(0);
  });
});
