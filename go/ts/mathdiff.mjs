// Compara a saída da sonda matemática do V8 com a do Go, função por função.
// Uso: node go/ts/mathdiff.mjs <entrada> <saida-js> <saida-go>
import { readFileSync } from 'node:fs';

const linhas = (p) => readFileSync(p, 'utf8').trimEnd().split('\n');
const entrada = linhas(process.argv[2]);
const js = linhas(process.argv[3]);
const go = linhas(process.argv[4]);

const nomes = ['sin', 'cos', 'log', 'atan', 'atan2', 'hypot', 'round'];
const divergencias = nomes.map(() => 0);
const exemplos = nomes.map(() => null);

const daBits = (hex) => {
  const b = new BigUint64Array(1);
  b[0] = BigInt('0x' + hex);
  return new Float64Array(b.buffer)[0];
};

for (let i = 0; i < js.length; i++) {
  const a = js[i].split(' ');
  const b = go[i].split(' ');
  for (let k = 0; k < nomes.length; k++) {
    // NaN tem muitos padrões de bits; só o "é NaN" precisa bater.
    if (a[k] === b[k]) continue;
    if (Number.isNaN(daBits(a[k])) && Number.isNaN(daBits(b[k]))) continue;
    divergencias[k]++;
    if (!exemplos[k]) exemplos[k] = { entrada: entrada[i], js: a[k], go: b[k] };
  }
}

const total = js.length;
let falhou = false;
console.log(`casos: ${total}`);
for (let k = 0; k < nomes.length; k++) {
  const d = divergencias[k];
  if (d === 0) {
    console.log(`  ${nomes[k].padEnd(6)} OK        ${total}/${total} idênticos bit a bit`);
    continue;
  }
  falhou = true;
  const e = exemplos[k];
  const [x, y] = e.entrada.split(' ');
  console.log(
    `  ${nomes[k].padEnd(6)} DIVERGE   ${d}/${total} (${((100 * d) / total).toFixed(4)}%)\n` +
      `           1º caso: x=0x${x} (${daBits(x)}) y=0x${y} (${daBits(y)})\n` +
      `                    js=0x${e.js} (${daBits(e.js)})\n` +
      `                    go=0x${e.go} (${daBits(e.go)})`,
  );
}
process.exit(falhou ? 1 : 0);
