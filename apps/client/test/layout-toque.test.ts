// M1 — o modo toque muda o layout, e a restrição número 1 é NÃO regredir o desktop.
//
// Estes testes existem para transformar essa promessa em algo verificável: com o modo desligado
// (que é como o desktop roda) todo número tem que sair exatamente igual ao que saía antes de a
// M1 existir; com ele ligado, as faixas laterais aparecem e o HUD encolhe.

import { afterEach, describe, expect, it } from 'vitest';

import {
  aspectoDaArena,
  definirModoToque,
  emModoToque,
  escalaHud,
  reservasDoJogo,
} from '../src/ui/layout.js';

afterEach(() => definirModoToque(false));

describe('desktop (modo toque desligado)', () => {
  it('não reserva nada nas laterais', () => {
    for (const [w, h] of [
      [1366, 768],
      [1920, 1080],
      [2560, 1440],
      [3440, 1440],
    ] as const) {
      const r = reservasDoJogo(h, w);
      expect(r.left, `${w}x${h}`).toBe(0);
      expect(r.right, `${w}x${h}`).toBe(0);
    }
  });

  it('mantém o piso de escala em 0,82', () => {
    expect(escalaHud(600)).toBe(0.82);
    expect(escalaHud(1080)).toBe(1.2);
    expect(escalaHud(4000)).toBe(1.5);
  });

  it('mantém as reservas de topo e base da Fase 10', () => {
    expect(reservasDoJogo(1080, 1920)).toEqual({ top: 118, right: 0, bottom: 31, left: 0 });
  });
});

describe('celular deitado (modo toque ligado)', () => {
  it('reserva uma faixa para cada polegar', () => {
    definirModoToque(true);
    expect(emModoToque()).toBe(true);
    const r = reservasDoJogo(390, 844);
    expect(r.left).toBeGreaterThan(100);
    expect(r.left).toBe(r.right);
    // As duas faixas juntas não podem comer mais que 36% da largura, senão sobra uma arena de selo.
    expect(r.left * 2).toBeLessThanOrEqual(844 * 0.36);
  });

  it('deixa o analógico em posição de descanso INTEIRO fora da arena', () => {
    definirModoToque(true);
    // Mesma conta de `input/toque.ts`: raio e centro de descanso do controle.
    const raio = Math.round(Math.min(62, Math.max(42, Math.min(844, 390) * 0.15)));
    const centro = raio + 18;
    expect(centro + raio).toBeLessThanOrEqual(reservasDoJogo(390, 844).left);
  });

  it('abaixa o piso do HUD para caber em 390 px de altura', () => {
    definirModoToque(true);
    expect(escalaHud(390)).toBe(0.6);
    // A faixa do relógio passa a ser ~15% da tela em vez dos ~21% do piso de desktop.
    expect(reservasDoJogo(390, 844).top).toBeLessThan(390 * 0.16);
  });

  it('devolve uma proporção de arena dentro do que o labirinto sabe gerar', () => {
    definirModoToque(true);
    const a = aspectoDaArena(844, 390);
    expect(a).toBeGreaterThan(1.2);
    expect(a).toBeLessThan(2.7);
  });

  it('não deixa a arena sumir num celular pequeno deitado (568x320)', () => {
    definirModoToque(true);
    const r = reservasDoJogo(320, 568);
    expect(568 - r.left - r.right).toBeGreaterThan(568 * 0.6);
  });
});
