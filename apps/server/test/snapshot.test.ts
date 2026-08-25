import { describe, expect, it } from 'vitest';
import { decodeSnapshot, encodeSnapshot, type SnapshotTank } from '../src/net/snapshot.js';

/**
 * Layout congelado do snapshot binário (little-endian):
 *   [0]   u8  — nº de tanques
 *   por tanque, 8 bytes: slot u8 · x i16 · y i16 · heading u8 · torre u8 · flags u8
 *
 * Os bytes literais abaixo são a MESMA referência usada por `apps/client/test/snapshot.test.ts`.
 * Se um dos lados mudar o layout sem o outro, um destes dois testes quebra — foi assim que a
 * divergência de formato entre cliente e servidor deixou de ser possível de passar despercebida.
 */
const BYTES_REFERENCIA = [
  2,
  // slot 3, x = 300 (0x012c), y = -50 (0xffce), heading 0, torre 64, flags vivo+conectado
  3, 0x2c, 0x01, 0xce, 0xff, 0, 64, 0b11,
  // slot 7, x = 1000 (0x03e8), y = 720 (0x02d0), heading 128, torre 128, flags morto+conectado
  7, 0xe8, 0x03, 0xd0, 0x02, 128, 128, 0b10,
];

describe('encodeSnapshot — formato de fio dos tanques', () => {
  it('produz exatamente os bytes de referência', () => {
    const tanks: SnapshotTank[] = [
      { slot: 3, x: 300, y: -50, heading: 0, turret: (64 / 255) * Math.PI * 2, alive: true, connected: true },
      { slot: 7, x: 1000, y: 720, heading: Math.PI, turret: Math.PI, alive: false, connected: true },
    ];
    expect([...encodeSnapshot(tanks)]).toEqual(BYTES_REFERENCIA);
  });

  it('tem 1 + 8n bytes — 81 bytes com a sala cheia de 10 jogadores', () => {
    const dez: SnapshotTank[] = Array.from({ length: 10 }, (_, slot) => ({
      slot,
      x: slot * 10,
      y: slot * 7,
      heading: slot,
      turret: slot,
      alive: slot % 2 === 0,
      connected: true,
    }));
    expect(encodeSnapshot(dez).byteLength).toBe(81);
  });

  it('ida e volta preserva slot, posição, flags e ângulo dentro da precisão da quantização', () => {
    const original: SnapshotTank[] = [
      { slot: 0, x: -12, y: 4096, heading: 1.234, turret: 5.4, alive: true, connected: false },
      { slot: 9, x: 0, y: 0, heading: 0, turret: 0, alive: false, connected: true },
    ];
    const voltou = decodeSnapshot(encodeSnapshot(original));

    expect(voltou).toHaveLength(2);
    voltou.forEach((t, i) => {
      const o = original[i]!;
      expect(t.slot).toBe(o.slot);
      expect(t.x).toBe(o.x);
      expect(t.y).toBe(o.y);
      expect(t.alive).toBe(o.alive);
      expect(t.connected).toBe(o.connected);
      // heading/torre viajam em 1 byte: meio passo de quantização = 2π/510 ≈ 0,0123 rad
      expect(Math.abs(t.heading - o.heading)).toBeLessThan(Math.PI * 2 / 255);
      expect(Math.abs(t.turret - o.turret)).toBeLessThan(Math.PI * 2 / 255);
    });
  });
});
