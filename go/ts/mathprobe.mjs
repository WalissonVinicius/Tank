// Lado V8 da sonda matemática: gera os casos de teste e imprime o resultado de `Math.*` em
// padrão de bits, no mesmo formato de `go/cmd/mathprobe`.
//
// Uso: node go/ts/mathprobe.mjs <arquivo-de-entrada> <arquivo-de-saída> [casos]
//
// Os casos cobrem, de propósito, mais do que o jogo usa: além da faixa real de ângulos
// ([-2π, 2π]), entram valores minúsculos, gigantes (que forçam a redução de Payne–Hanek),
// múltiplos exatos de π/2 (onde o cancelamento é máximo) e os casos degenerados de ±0 e ±∞.
import { writeFileSync } from 'node:fs';

const buf = new ArrayBuffer(8);
const f64 = new Float64Array(buf);
const u32 = new Uint32Array(buf);
const bits = (v) => {
  f64[0] = v;
  return ((BigInt(u32[1]) << 32n) | BigInt(u32[0])).toString(16).padStart(16, '0');
};

// mulberry32, o mesmo do jogo — a sonda também precisa ser reproduzível.
let a = 0x1234abcd >>> 0;
const nextU32 = () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
};
const next = () => nextU32() / 4294967296;

const casos = [];
const push = (x, y) => casos.push([x, y]);

// 1) Casos fixos: os cantos onde as implementações costumam divergir.
const fixos = [
  0, -0, 1, -1, 0.5, -0.5, 0.49999999999999994, -0.49999999999999994, 2.5, -2.5, 1.5, -1.5,
  Math.PI, -Math.PI, Math.PI / 2, -Math.PI / 2, Math.PI / 4, Math.PI * 2, Math.PI * 1.5,
  3 * Math.PI, 4 * Math.PI, 1e-300, -1e-300, 1e300, Number.MIN_VALUE, Number.EPSILON,
  Number.MAX_SAFE_INTEGER, 2 ** 20 * (Math.PI / 2), 2 ** 30, 1e17, 1e9 + 0.5, 123456789.123456,
  0.4375, 0.6875, 1.1875, 2.4375, 0.3, 0.78125, 1 / 3, Infinity, -Infinity, NaN,
];
for (const x of fixos) for (const y of [1, -1, 0, 1.5, -1e-8, Infinity]) push(x, y);

// 2) Múltiplos de π/2 e vizinhos imediatos — o pior caso da redução de argumento.
for (let k = -40; k <= 40; k++) {
  const base = (k * Math.PI) / 2;
  push(base, 1);
  push(base + Number.EPSILON * Math.abs(base || 1), 1);
  push(base - Number.EPSILON * Math.abs(base || 1), 1);
}

// 3) Faixa real do jogo, densa.
const N = Number(process.argv[4] ?? 300000);
for (let i = 0; i < N; i++) push((next() * 4 - 2) * Math.PI, next() * 4 - 2);

// 4) Faixa média (até 2^20·π/2, onde ainda vale a redução direta).
for (let i = 0; i < 40000; i++) push((next() * 2 - 1) * 1.6e6, next() * 200 - 100);

// 5) Faixa grande (força `__kernel_rem_pio2`).
for (let i = 0; i < 40000; i++) push((next() * 2 - 1) * 10 ** (10 + next() * 280), next() * 2 - 1);

const entrada = [];
const saida = [];
for (const [x, y] of casos) {
  entrada.push(`${bits(x)} ${bits(y)}`);
  saida.push(
    [
      bits(Math.sin(x)),
      bits(Math.cos(x)),
      bits(Math.log(Math.abs(x) + 1)),
      bits(Math.atan(x)),
      bits(Math.atan2(x, y)),
      bits(Math.hypot(x, y)),
      bits(Math.round(x)),
    ].join(' '),
  );
}

writeFileSync(process.argv[2], entrada.join('\n') + '\n');
writeFileSync(process.argv[3], saida.join('\n') + '\n');
process.stderr.write(`mathprobe: ${casos.length} casos gerados\n`);
