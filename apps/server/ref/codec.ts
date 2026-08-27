import { encodeSnapshot, type SnapshotTank } from '../src/net/snapshot.js';
import { direcaoDeMovimento, decodeAim } from '@tank/protocol';

const casos: SnapshotTank[][] = [
  [],
  [{ slot: 0, x: 0, y: 0, heading: 0, turret: 0, alive: true, connected: true }],
  [
    { slot: 3, x: 123.49, y: -87.51, heading: Math.PI, turret: Math.PI / 2, alive: true, connected: false },
    { slot: 9, x: -1.5, y: 2.5, heading: -0.75, turret: 6.28318, alive: false, connected: true },
    { slot: 7, x: 32767.4, y: -32767.4, heading: 12.5, turret: -12.5, alive: true, connected: true },
  ],
];

const snapshots = casos.map((c) => Buffer.from(encodeSnapshot(c)).toString('hex'));

const movimento: { bits: number; mover: number | null }[] = [];
for (let bits = 0; bits < 16; bits++) {
  movimento.push({
    bits,
    mover: direcaoDeMovimento(!!(bits & 1), !!(bits & 2), !!(bits & 4), !!(bits & 8)),
  });
}

const aim = [0, 1, 42, 127, 128, 200, 255].map((b) => ({ byte: b, rad: decodeAim(b) }));

console.log(JSON.stringify({ snapshots, movimento, aim }));
