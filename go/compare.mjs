// Prova de paridade cruzada entre a simulação em Go e a em TypeScript.
//
//   node go/compare.mjs [--seeds 10000] [--ticks 300] [--de 0] [--runner auto|nativo|wasm]
//
// Roda as três etapas, nesta ordem, porque cada uma só faz sentido se a anterior passou:
//
//   1. constantes — a tabela de tuning inteira, em bits. Uma constante derivada calculada com
//      regras de arredondamento diferentes faria TUDO divergir sem dizer por quê.
//   2. math       — `Math.sin`, `cos`, `log`, `atan`, `atan2`, `hypot` e `round` do V8 contra o
//      `internal/jsmath`. É a fundação: a simulação chama essas funções milhares de vezes por
//      segundo, e a biblioteca padrão do Go diverge do V8 em mais de 20% dos ângulos.
//   3. paridade   — N seeds, cada uma gerando labirinto, spawns e 300 ticks de partida
//      roteirizada, resumidos em quatro SHA-256 (labirinto, spawns, simulação, eventos).
//
// Divergiu? O script NÃO esconde e NÃO arredonda: ele roda de novo a seed culpada nos dois
// lados em modo detalhe e imprime a primeira linha diferente, com a seção, o tick e os dois
// valores em hexadecimal.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const OUT = join(AQUI, 'out');

mkdirSync(OUT, { recursive: true });

/**
 * Onde está o Go.
 *
 * A ordem é: `GOROOT_LOCAL` (escape manual) → `go env GOROOT` (instalação normal, no PATH) →
 * um toolchain baixado em `~/.toolchain/go`. A terceira opção existe porque nem toda máquina tem
 * o Go instalado, e baixar o zip oficial para o home resolve sem privilégio de administrador.
 */
function acharGoroot() {
  if (process.env.GOROOT_LOCAL) return process.env.GOROOT_LOCAL;
  const r = spawnSync('go', ['env', 'GOROOT'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const local = join(home, '.toolchain', 'go');
  if (existsSync(join(local, 'bin'))) return local;
  throw new Error(
    'Go não encontrado. Instale-o, ou baixe o zip oficial para ~/.toolchain/go, ou aponte GOROOT_LOCAL.',
  );
}

const GOROOT = acharGoroot();

const arg = (nome, padrao) => {
  const idx = process.argv.indexOf(`--${nome}`);
  return idx >= 0 ? process.argv[idx + 1] : padrao;
};

const SEEDS = Number(arg('seeds', 10000));
const TICKS = Number(arg('ticks', 300));
const DE = Number(arg('de', 0));
const RUNNER = arg('runner', 'auto');

// --- execução dos dois lados ---

function rodarTs(args, arquivoSaida) {
  const fd = openSync(arquivoSaida, 'w');
  try {
    const r = spawnSync('pnpm', ['exec', 'tsx', join(AQUI, 'ts', 'paridade.mjs'), ...args], {
      cwd: RAIZ,
      stdio: ['ignore', fd, 'inherit'],
      shell: process.platform === 'win32',
    });
    if (r.status !== 0) throw new Error(`lado TypeScript saiu com código ${r.status}`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Como o lado Go é executado.
 *
 * Nesta máquina de desenvolvimento o Smart App Control do Windows 11 bloqueia binários
 * recém-compilados e sem assinatura, inclusive os que o `go test` gera — daí o alvo `js/wasm`,
 * que roda dentro do Node. A aritmética de ponto flutuante do WASM é IEEE-754 estrita e sem
 * contração FMA, igual à do amd64, então a paridade medida por um caminho vale para o outro.
 * Em Linux/amd64 o `nativo` é usado direto e é bem mais rápido.
 */
function detectarRunner() {
  if (RUNNER !== 'auto') return RUNNER;
  const exe = join(AQUI, 'bin', process.platform === 'win32' ? 'paridade.exe' : 'paridade');
  if (!existsSync(exe)) return 'wasm';
  const r = spawnSync(exe, ['-modo', 'constantes'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.length > 0 ? 'nativo' : 'wasm';
}

function compilarGo(runner) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const ext = runner === 'wasm' ? '.wasm' : process.platform === 'win32' ? '.exe' : '';
  const env = {
    ...process.env,
    PATH: `${join(GOROOT, 'bin')}${sep}${process.env.PATH}`,
    ...(runner === 'wasm' ? { GOOS: 'js', GOARCH: 'wasm' } : {}),
  };
  for (const nome of ['paridade', 'mathprobe']) {
    const r = spawnSync('go', ['build', '-o', `bin/${nome}${ext}`, `./cmd/${nome}`], {
      cwd: AQUI,
      env,
      stdio: 'inherit',
    });
    if (r.status !== 0) throw new Error(`go build ./cmd/${nome} falhou`);
  }
}

function rodarGo(runner, args, arquivoSaida, arquivoEntrada) {
  const fd = openSync(arquivoSaida, 'w');
  const entrada = arquivoEntrada ? openSync(arquivoEntrada, 'r') : 'ignore';
  try {
    let cmd, argv;
    if (runner === 'wasm') {
      cmd = process.execPath;
      argv = [join(GOROOT, 'lib', 'wasm', 'wasm_exec_node.js'), join(AQUI, 'bin', args.bin + '.wasm'), ...args.argv];
    } else {
      cmd = join(AQUI, 'bin', args.bin + (process.platform === 'win32' ? '.exe' : ''));
      argv = args.argv;
    }
    const r = spawnSync(cmd, argv, {
      cwd: AQUI,
      stdio: [entrada, fd, 'inherit'],
      // Ambiente ENXUTO de propósito: o carregador WASM do Go limita argumentos + variáveis de
      // ambiente a 4 KB somados, e o ambiente de um shell de desenvolvimento passa disso com
      // folga — o programa nem chega a rodar, morre com "total length ... exceeds limit".
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    });
    // O carregador WASM às vezes dispara um assert do libuv ao fechar o stdout redirecionado,
    // DEPOIS de já ter escrito tudo. O que vale é o arquivo — se ele veio vazio, aí sim é erro.
    if (r.status !== 0 && r.status !== null) {
      const tam = readFileSync(arquivoSaida).length;
      if (tam === 0) throw new Error(`lado Go saiu com código ${r.status} e não escreveu nada`);
    }
  } finally {
    closeSync(fd);
    if (arquivoEntrada) closeSync(entrada);
  }
}

// --- relatório ---

let falhou = false;
const t0 = Date.now();

function titulo(n, texto) {
  console.log(`\n[${n}/3] ${texto}`);
}

// --- etapa 1: constantes ---

const runner = detectarRunner();
console.log(`Prova de paridade Go × TypeScript`);
console.log(`  seeds:  ${DE}..${DE + SEEDS} (${SEEDS})`);
console.log(`  ticks:  ${TICKS} por seed`);
console.log(`  runner: Go em ${runner}`);
compilarGo(runner);

titulo(1, 'constantes de tuning');
{
  rodarGo(runner, { bin: 'paridade', argv: ['-modo', 'constantes'] }, join(OUT, 'const_go.txt'));
  rodarTs(['--modo', 'constantes'], join(OUT, 'const_ts.txt'));
  const go = readFileSync(join(OUT, 'const_go.txt'), 'utf8').trimEnd().split('\n');
  const ts = readFileSync(join(OUT, 'const_ts.txt'), 'utf8').trimEnd().split('\n');
  const dif = go.map((l, k) => [l, ts[k]]).filter(([a, b]) => a !== b);
  if (dif.length === 0) {
    console.log(`      OK — ${go.length} constantes idênticas bit a bit`);
  } else {
    falhou = true;
    console.log(`      DIVERGIU — ${dif.length} de ${go.length} constantes`);
    for (const [a, b] of dif.slice(0, 10)) console.log(`        go: ${a}\n        ts: ${b}`);
  }
}

// --- etapa 2: funções matemáticas ---

titulo(2, 'Math.* do V8 contra internal/jsmath');
{
  const entrada = join(OUT, 'math_in.txt');
  const saidaTs = join(OUT, 'math_js.txt');
  const saidaGo = join(OUT, 'math_go.txt');
  const gerar = spawnSync(process.execPath, [join(AQUI, 'ts', 'mathprobe.mjs'), entrada, saidaTs], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (gerar.status !== 0) throw new Error('mathprobe.mjs falhou');
  rodarGo(runner, { bin: 'mathprobe', argv: [] }, saidaGo, entrada);
  const r = spawnSync(process.execPath, [join(AQUI, 'ts', 'mathdiff.mjs'), entrada, saidaTs, saidaGo], {
    encoding: 'utf8',
  });
  process.stdout.write(
    r.stdout
      .split('\n')
      .map((l) => (l ? '      ' + l : l))
      .join('\n'),
  );
  if (r.status !== 0) falhou = true;
}

// --- etapa 3: varredura de seeds ---

titulo(3, `simulação completa em ${SEEDS} seeds`);
const arquivoGo = join(OUT, 'seeds_go.txt');
const arquivoTs = join(OUT, 'seeds_ts.txt');
{
  const tGo = Date.now();
  rodarGo(
    runner,
    { bin: 'paridade', argv: ['-modo', 'resumo', '-de', String(DE), '-ate', String(DE + SEEDS), '-ticks', String(TICKS)] },
    arquivoGo,
  );
  const msGo = Date.now() - tGo;
  const tTs = Date.now();
  rodarTs(['--modo', 'resumo', '--de', String(DE), '--ate', String(DE + SEEDS), '--ticks', String(TICKS)], arquivoTs);
  const msTs = Date.now() - tTs;
  console.log(`      go: ${(msGo / 1000).toFixed(1)}s   ts: ${(msTs / 1000).toFixed(1)}s`);

  const go = readFileSync(arquivoGo, 'utf8').trimEnd().split('\n');
  const ts = readFileSync(arquivoTs, 'utf8').trimEnd().split('\n');
  if (go.length !== ts.length) {
    falhou = true;
    console.log(`      DIVERGIU — go escreveu ${go.length} linhas e ts escreveu ${ts.length}`);
  }

  const NOMES = ['labirinto', 'spawns', 'simulacao', 'eventos'];
  const divergentes = [];
  const porSecao = [0, 0, 0, 0];
  const n = Math.min(go.length, ts.length);
  for (let k = 0; k < n; k++) {
    if (go[k] === ts[k]) continue;
    const a = go[k].split(' ');
    const b = ts[k].split(' ');
    const secoes = [];
    for (let s = 0; s < 4; s++) {
      if (a[s + 1] !== b[s + 1]) {
        secoes.push(NOMES[s]);
        porSecao[s]++;
      }
    }
    divergentes.push({ seed: Number(a[0]), secoes });
  }

  const passaram = n - divergentes.length;
  console.log(`      ${passaram}/${n} seeds idênticas bit a bit`);
  if (divergentes.length > 0) {
    falhou = true;
    console.log(`      DIVERGIRAM ${divergentes.length} seeds`);
    for (let s = 0; s < 4; s++) if (porSecao[s]) console.log(`        seção ${NOMES[s]}: ${porSecao[s]} seeds`);
    diagnosticar(divergentes[0].seed);
  }
}

/** Roda a seed culpada nos dois lados em modo detalhe e mostra a PRIMEIRA linha diferente. */
function diagnosticar(seed) {
  console.log(`\n      --- primeira divergência, seed ${seed} ---`);
  const go = join(OUT, `detalhe_go_${seed}.txt`);
  const ts = join(OUT, `detalhe_ts_${seed}.txt`);
  rodarGo(runner, { bin: 'paridade', argv: ['-modo', 'detalhe', '-seed', String(seed), '-ticks', String(TICKS)] }, go);
  rodarTs(['--modo', 'detalhe', '--seed', String(seed), '--ticks', String(TICKS)], ts);

  const linhasGo = readFileSync(go, 'utf8').trimEnd().split('\n');
  const linhasTs = readFileSync(ts, 'utf8').trimEnd().split('\n');
  const limite = Math.min(linhasGo.length, linhasTs.length);
  for (let k = 0; k < limite; k++) {
    if (linhasGo[k] === linhasTs[k]) continue;
    console.log(`      linha ${k + 1}`);
    console.log(`        go: ${linhasGo[k]}`);
    console.log(`        ts: ${linhasTs[k]}`);
    // O tick é o primeiro token numérico dos registros de simulação e de evento.
    const campos = linhasGo[k].split(' ');
    if (campos[0] === 'simulacao' || campos[0] === 'eventos') {
      console.log(`        seção: ${campos[0]}   registro: ${campos[1]}   tick: ${campos[2]}`);
    }
    console.log(`      dumps completos: ${go}\n                       ${ts}`);
    return;
  }
  if (linhasGo.length !== linhasTs.length) {
    console.log(`      os dumps têm tamanhos diferentes: go ${linhasGo.length}, ts ${linhasTs.length}`);
    const k = limite;
    console.log(`        go: ${linhasGo[k] ?? '(fim)'}`);
    console.log(`        ts: ${linhasTs[k] ?? '(fim)'}`);
  }
}

console.log(`\n${falhou ? 'FALHOU' : 'PARIDADE COMPLETA'} — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(falhou ? 1 : 0);
