// Decode do snapshot binário de posições (estado "quente", 20 Hz) — espelha byte a byte
// `apps/server/src/net/snapshot.ts` (dono: worker do servidor, `encodeSnapshot`):
// [nTanques: u8] + nTanques × { slot: u8, x: i16, y: i16, heading: u8, torre: u8, flags: u8 }.
// `slot` (0–9) é o índice compacto de `PlayerState.slot` no Schema frio — quem consome
// correlaciona slot→sessionId via `net/client.ts` a partir do estado frio já recebido.

export interface SnapshotTank {
  slot: number;
  x: number;
  y: number;
  heading: number; // rad, decodificado de u8 (0..255 → 0..2π)
  turret: number; // rad
  alive: boolean;
  connected: boolean;
}

const TWO_PI = Math.PI * 2;

function dequantizeAngle(byte: number): number {
  return (byte / 255) * TWO_PI;
}

export function decodeSnapshot(buffer: ArrayBuffer): SnapshotTank[] {
  const view = new DataView(buffer);
  const n = view.getUint8(0);
  const tanks: SnapshotTank[] = [];
  let offset = 1;

  for (let i = 0; i < n; i++) {
    const slot = view.getUint8(offset);
    const x = view.getInt16(offset + 1, true);
    const y = view.getInt16(offset + 3, true);
    const heading = dequantizeAngle(view.getUint8(offset + 5));
    const turret = dequantizeAngle(view.getUint8(offset + 6));
    const flags = view.getUint8(offset + 7);
    offset += 8;

    tanks.push({
      slot,
      x,
      y,
      heading,
      turret,
      alive: (flags & 0b01) !== 0,
      connected: (flags & 0b10) !== 0,
    });
  }

  return tanks;
}
