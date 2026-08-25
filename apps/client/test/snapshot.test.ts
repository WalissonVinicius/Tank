import { describe, expect, it } from 'vitest';
import { decodeSnapshot } from '../src/net/snapshot.js';

/**
 * Os MESMOS bytes de referência de `apps/server/test/snapshot.test.ts`. Este teste prova que o
 * decodificador do cliente lê o formato que o servidor escreve, sem que nenhum dos dois pacotes
 * precise importar o outro (`apps/*` não conversam entre si — só via `packages/*`).
 */
const BYTES_REFERENCIA = new Uint8Array([
  2,
  3, 0x2c, 0x01, 0xce, 0xff, 0, 64, 0b11,
  7, 0xe8, 0x03, 0xd0, 0x02, 128, 128, 0b10,
]);

describe('decodeSnapshot — leitura do formato do servidor', () => {
  it('lê slot, posição assinada, ângulos quantizados e flags', () => {
    const tanks = decodeSnapshot(BYTES_REFERENCIA.buffer as ArrayBuffer);

    expect(tanks).toHaveLength(2);
    expect(tanks[0]).toMatchObject({ slot: 3, x: 300, y: -50, alive: true, connected: true });
    expect(tanks[0]!.heading).toBe(0);
    expect(tanks[0]!.turret).toBeCloseTo((64 / 255) * Math.PI * 2, 10);
    expect(tanks[1]).toMatchObject({ slot: 7, x: 1000, y: 720, alive: false, connected: true });
    expect(tanks[1]!.heading).toBeCloseTo((128 / 255) * Math.PI * 2, 10);
  });

  it('respeita o byteOffset quando o Colyseus entrega uma fatia de um buffer maior', () => {
    // `broadcastBytes` chega ao SDK como `buffer.subarray(offset)`: byteOffset != 0.
    const maior = new Uint8Array(5 + BYTES_REFERENCIA.length);
    maior.set(BYTES_REFERENCIA, 5);
    const fatia = maior.subarray(5);
    const comoArrayBuffer = fatia.buffer.slice(fatia.byteOffset, fatia.byteOffset + fatia.byteLength) as ArrayBuffer;

    expect(decodeSnapshot(comoArrayBuffer)[0]).toMatchObject({ slot: 3, x: 300, y: -50 });
  });
});
