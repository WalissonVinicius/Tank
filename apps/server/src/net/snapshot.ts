/**
 * Snapshot binário de posições de tanque — enviado via `room.broadcastBytes` a `SNAPSHOT_HZ`
 * (20 Hz). Balas NUNCA entram aqui (ver `bullet_spawn`/`bullet_dead`); só os tanques, porque é
 * o único estado "quente" que muda todo tick e precisa de baixa latência sem o overhead do
 * `@colyseus/schema`.
 *
 * Formato (little-endian, via `DataView`):
 *   [0]                 u8   — quantidade de tanques neste snapshot (n)
 *   por tanque (8 bytes, repetido n vezes):
 *     [0]   u8   — slot (0–9). O cliente resolve slot → sessionId pelo campo `slot` do
 *                  `PlayerState` no Schema "frio" (que já tem sessionId como chave do Map).
 *     [1-2] i16  — x, em pixels de mundo, arredondado ao inteiro mais próximo.
 *     [3-4] i16  — y, em pixels de mundo, arredondado ao inteiro mais próximo.
 *     [5]   u8   — heading do chassi, quantizado: 0..255 representa 0..2π.
 *     [6]   u8   — heading da torre, mesma quantização.
 *     [7]   u8   — flags: bit0 = vivo, bit1 = conectado.
 *
 * Tamanho total = 1 + n × 8 bytes. Para 10 jogadores: 81 bytes por snapshot.
 * O cliente (Fase 2C) precisa espelhar exatamente este decode em `apps/client/src/net/snapshot.ts`.
 */

export interface SnapshotTank {
  slot: number;
  x: number;
  y: number;
  heading: number; // rad
  turret: number; // rad
  alive: boolean;
  connected: boolean;
}

const BYTES_PER_TANK = 8;
const TWO_PI = Math.PI * 2;

function quantizeAngle(rad: number): number {
  let normalized = rad % TWO_PI;
  if (normalized < 0) normalized += TWO_PI;
  return Math.round((normalized / TWO_PI) * 255) & 0xff;
}

function dequantizeAngle(byte: number): number {
  return (byte / 255) * TWO_PI;
}

export function encodeSnapshot(tanks: readonly SnapshotTank[]): Uint8Array {
  const buffer = new ArrayBuffer(1 + tanks.length * BYTES_PER_TANK);
  const view = new DataView(buffer);
  view.setUint8(0, tanks.length);

  let offset = 1;
  for (const tank of tanks) {
    view.setUint8(offset, tank.slot);
    view.setInt16(offset + 1, Math.round(tank.x), true);
    view.setInt16(offset + 3, Math.round(tank.y), true);
    view.setUint8(offset + 5, quantizeAngle(tank.heading));
    view.setUint8(offset + 6, quantizeAngle(tank.turret));
    const flags = (tank.alive ? 0b01 : 0) | (tank.connected ? 0b10 : 0);
    view.setUint8(offset + 7, flags);
    offset += BYTES_PER_TANK;
  }

  return new Uint8Array(buffer);
}

export function decodeSnapshot(bytes: Uint8Array): SnapshotTank[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint8(0);
  const tanks: SnapshotTank[] = [];

  let offset = 1;
  for (let i = 0; i < count; i++) {
    const slot = view.getUint8(offset);
    const x = view.getInt16(offset + 1, true);
    const y = view.getInt16(offset + 3, true);
    const heading = dequantizeAngle(view.getUint8(offset + 5));
    const turret = dequantizeAngle(view.getUint8(offset + 6));
    const flags = view.getUint8(offset + 7);
    tanks.push({
      slot,
      x,
      y,
      heading,
      turret,
      alive: (flags & 0b01) !== 0,
      connected: (flags & 0b10) !== 0,
    });
    offset += BYTES_PER_TANK;
  }

  return tanks;
}
