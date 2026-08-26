import { describe, expect, it } from 'vitest';
import { decodeAim, encodeAim } from '@tank/protocol';
import { decodeInputBits } from '../src/net/input.js';

const BIT_UP = 0x01;
const BIT_LEFT = 0x04;
const BIT_FIRE = 0x10;

/** Meio passo da quantização em 256 direções (≈0,7°) — o erro máximo de ida e volta. */
const MEIO_PASSO = Math.PI / 255;

describe('mira no canal de input (Fase 4)', () => {
  it('o ângulo sobrevive à ida e volta pelo byte com erro menor que meio passo', () => {
    const passo = (Math.PI * 2) / 255;
    for (let i = 0; i <= 64; i++) {
      const rad = (i / 64) * Math.PI * 2;
      const volta = decodeAim(encodeAim(rad));
      const erro = Math.abs(((volta - rad + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      expect(erro, `${rad} rad`).toBeLessThanOrEqual(passo / 2 + 1e-9);
    }
  });

  it('ângulo negativo é normalizado para a mesma direção no intervalo 0..2π', () => {
    const volta = decodeAim(encodeAim(-Math.PI / 2));
    expect(Math.abs(volta - (3 * Math.PI) / 2)).toBeLessThanOrEqual(MEIO_PASSO);
  });

  it('decodeInputBits entrega a mira junto com a direção do movimento', () => {
    const input = decodeInputBits(BIT_UP | BIT_LEFT | BIT_FIRE, encodeAim(Math.PI));
    // Cima + esquerda é a diagonal noroeste: −3π/4 (o Y do mundo cresce para baixo).
    expect(input.mover).toBeCloseTo((-3 * Math.PI) / 4, 12);
    expect(input.fire).toBe(true);
    expect(Math.abs(input.aim! - Math.PI)).toBeLessThanOrEqual(MEIO_PASSO);
  });

  it('nenhuma tecla de direção = `mover` nulo (parado), não uma direção qualquer', () => {
    expect(decodeInputBits(BIT_FIRE).mover).toBeNull();
  });

  it('pacote sem mira deixa `aim` indefinido — a torre fica onde está em vez de saltar para leste', () => {
    expect(decodeInputBits(BIT_UP).aim).toBeUndefined();
  });
});
