// Prova de paridade cruzada entre a simulação em Go e a em TypeScript.
//
//   node go/compare.mjs [--seeds 10000] [--ticks 0] [--de 0] [--runner auto|nativo|wasm] [--partes 6]
//
// Roda as cinco etapas, nesta ordem, porque cada uma só faz sentido se a anterior passou:
//
//   1. constantes — a tabela de tuning inteira, em bits (inclusive as três receitas de bot e a
//      agenda de power-ups). Uma constante derivada calculada com regras de arredondamento
//      diferentes faria TUDO divergir sem dizer por quê.
//   2. math       — `Math.sin`, `cos`, `log`, `atan`, `atan2`, `hypot` e `round` do V8 contra o
//      `internal/jsmath`. É a fundação: a simulação chama essas funções milhares de vezes por
//      segundo, e a biblioteca padrão do Go diverge do V8 em mais de 20% dos ângulos.
//   3. paridade   — N seeds de partida roteirizada, resumidas em quatro SHA-256.
//   4. bots       — N seeds de partida dirigida pela IA. Compara a SEQUÊNCIA DE `Input` tick a
//      tick, e não só o resultado: um bot que chega ao mesmo lugar por um caminho diferente já é
//      divergência, e o estado final não pegaria isso.
//   5. power-ups  — N seeds com a camada de itens ligada: mesma agenda, mesmos pontos, mesmos
//      ticks, mesmas coletas, mesmos relógios de efeito — e a bala carimbada com ricochete duplo
//      voando igual dos dois lados depois de o efeito expirar no dono.
//
// Divergiu? O script NÃO esconde e NÃO arredonda: ele roda de novo a seed culpada nos dois
// lados em modo detalhe e imprime a primeira linha diferente, com a seção, o tick e os dois
// valores em hexadecimal.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spawnar `pnpm` no Windows exige `shell: true`, e o Node 22 emite um DEP0190 por isso no meio do
// relatório. Os argumentos aqui são todos construídos pelo próprio script, nunca vêm de fora.
process.noDeprecation = true;

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
/** 0 = cada cenário usa o próprio padrão (ver `TICKS_POR_CENARIO`). */
const TICKS = Number(arg('ticks', 0));
const DE = Number(arg('de', 0));
const RUNNER = arg('runner', 'auto');

/**
 * Em quantos processos cada varredura de seeds é dividida.
 *
 * Não é luxo: os dois lados rodam single-thread aqui (o Go tem alvo `js/wasm`, onde GOMAXPROCS é
 * 1), e a etapa dos bots custa ~0,23 s por seed no TypeScript — 10.000 seeds numa fila só passam
 * de meia hora. Como as seeds são independentes e cada fatia é um intervalo CONTÍGUO, concatenar
 * as saídas na ordem das fatias reproduz byte a byte o arquivo que um processo só produziria.
 */
const PARTES = Math.max(1, Number(arg('partes', Math.min(6, Math.max(1, cpus().length - 2)))));

/**
 * Ticks padrão de cada cenário. Ficam AQUI, e não só nos dois lados, porque o `compare.mjs` passa
 * o número explicitamente para os dois — assim nenhum dos lados pode usar um padrão diferente do
 * outro sem que a comparação perceba.
 */
const TICKS_POR_CENARIO = { partida: 300, bots: 300, powerups: 600 };

// --- execução dos dois lados ---

function argsTs(cenario, extras) {
  return cenario === 'partida' ? extras : ['--cenario', cenario, ...extras];
}

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

function comandoGo(runner, args) {
  if (runner === 'wasm') {
    return [
      process.execPath,
      [join(GOROOT, 'lib', 'wasm', 'wasm_exec_node.js'), join(AQUI, 'bin', args.bin + '.wasm'), ...args.argv],
    ];
  }
  return [join(AQUI, 'bin', args.bin + (process.platform === 'win32' ? '.exe' : '')), args.argv];
}

// Ambiente ENXUTO de propósito: o carregador WASM do Go limita argumentos + variáveis de ambiente
// a 4 KB somados, e o ambiente de um shell de desenvolvimento passa disso com folga — o programa
// nem chega a rodar, morre com "total length ... exceeds limit".
const AMBIENTE_ENXUTO = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };

function rodarGo(runner, args, arquivoSaida, arquivoEntrada) {
  const fd = openSync(arquivoSaida, 'w');
  const entrada = arquivoEntrada ? openSync(arquivoEntrada, 'r') : 'ignore';
  try {
    const [cmd, argv] = comandoGo(runner, args);
    const r = spawnSync(cmd, argv, { cwd: AQUI, stdio: [entrada, fd, 'inherit'], env: AMBIENTE_ENXUTO });
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

/** Um processo, assíncrono, com o stdout redirecionado para um arquivo. */
function rodarAssincrono(cmd, argv, opcoes, arquivoSaida) {
  return new Promise((resolve, reject) => {
    const fd = openSync(arquivoSaida, 'w');
    const p = spawn(cmd, argv, { ...opcoes, stdio: ['ignore', fd, 'inherit'] });
    p.on('error', (erro) => {
      closeSync(fd);
      reject(erro);
    });
    p.on('close', (codigo) => {
      closeSync(fd);
      // Mesma tolerância do caminho síncrono: o que vale é o arquivo ter conteúdo.
      if (codigo !== 0 && readFileSync(arquivoSaida).length === 0) {
        reject(new Error(`processo saiu com código ${codigo} e não escreveu nada`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Varre [de, ate) num dos lados, dividido em `PARTES` processos, e concatena as saídas NA ORDEM
 * das fatias — o arquivo final é idêntico ao que um processo só produziria.
 */
async function varrer(lado, runner, cenario, de, ate, ticks, arquivoSaida) {
  const total = ate - de;
  const partes = Math.min(PARTES, Math.max(1, total));
  const tamanho = Math.ceil(total / partes);
  const arquivos = [];
  const tarefas = [];

  for (let k = 0; k < partes; k++) {
    const inicio = de + k * tamanho;
    if (inicio >= ate) break;
    const fim = Math.min(ate, inicio + tamanho);
    const arquivo = join(OUT, `${lado}_${cenario}_${k}.txt`);
    arquivos.push(arquivo);

    if (lado === 'go') {
      const [cmd, argv] = comandoGo(runner, {
        bin: 'paridade',
        argv: ['-modo', 'resumo', '-cenario', cenario, '-de', String(inicio), '-ate', String(fim), '-ticks', String(ticks)],
      });
      tarefas.push(rodarAssincrono(cmd, argv, { cwd: AQUI, env: AMBIENTE_ENXUTO }, arquivo));
    } else {
      const argv = [
        'exec',
        'tsx',
        join(AQUI, 'ts', 'paridade.mjs'),
        ...argsTs(cenario, ['--modo', 'resumo', '--de', String(inicio), '--ate', String(fim), '--ticks', String(ticks)]),
      ];
      tarefas.push(
        rodarAssincrono('pnpm', argv, { cwd: RAIZ, shell: process.platform === 'win32' }, arquivo),
      );
    }
  }

  await Promise.all(tarefas);
  writeFileSync(arquivoSaida, arquivos.map((a) => readFileSync(a, 'utf8')).join(''));
}

/**
 * Separa os resumos por seed das linhas `#cobertura`, que não são resumo: são o que a varredura
 * REALMENTE exercitou. Cada fatia emite a sua e elas são somadas.
 */
function lerVarredura(arquivo) {
  const dados = [];
  const cobertura = {};
  for (const linha of readFileSync(arquivo, 'utf8').trimEnd().split('\n')) {
    if (linha.startsWith('#cobertura ')) {
      const toks = linha.slice('#cobertura '.length).split(' ');
      for (let k = 0; k + 1 < toks.length; k += 2) {
        cobertura[toks[k]] = (cobertura[toks[k]] ?? 0) + Number(toks[k + 1]);
      }
    } else if (linha) {
      dados.push(linha);
    }
  }
  return { dados, cobertura };
}

// --- relatório ---

let falhou = false;
const t0 = Date.now();

function titulo(n, texto) {
  console.log(`\n[${n}/5] ${texto}`);
}

const runner = detectarRunner();
console.log(`Prova de paridade Go × TypeScript`);
console.log(`  seeds:  ${DE}..${DE + SEEDS} (${SEEDS})`);
console.log(`  ticks:  ${TICKS > 0 ? TICKS : 'padrão de cada cenário (partida 300, bots 300, power-ups 600)'}`);
console.log(`  runner: Go em ${runner}`);
console.log(`  partes: ${PARTES} processos por varredura`);
compilarGo(runner);

// --- etapa 1: constantes ---

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

// --- etapas 3, 4 e 5: as varreduras de seeds ---

/** Roda uma varredura nos dois lados, compara linha a linha e relata. */
async function compararVarredura(cenario, nomesSecao, rotuloCobertura) {
  const ticks = TICKS > 0 ? TICKS : TICKS_POR_CENARIO[cenario];
  const arquivoGo = join(OUT, `seeds_${cenario}_go.txt`);
  const arquivoTs = join(OUT, `seeds_${cenario}_ts.txt`);

  const tGo = Date.now();
  await varrer('go', runner, cenario, DE, DE + SEEDS, ticks, arquivoGo);
  const msGo = Date.now() - tGo;
  const tTs = Date.now();
  await varrer('ts', runner, cenario, DE, DE + SEEDS, ticks, arquivoTs);
  const msTs = Date.now() - tTs;
  console.log(`      go: ${(msGo / 1000).toFixed(1)}s   ts: ${(msTs / 1000).toFixed(1)}s   (${ticks} ticks/seed)`);

  const go = lerVarredura(arquivoGo);
  const ts = lerVarredura(arquivoTs);
  if (go.dados.length !== ts.dados.length) {
    falhou = true;
    console.log(`      DIVERGIU — go escreveu ${go.dados.length} linhas e ts escreveu ${ts.dados.length}`);
  }

  const divergentes = [];
  const porSecao = nomesSecao.map(() => 0);
  const n = Math.min(go.dados.length, ts.dados.length);
  for (let k = 0; k < n; k++) {
    if (go.dados[k] === ts.dados[k]) continue;
    const a = go.dados[k].split(' ');
    const b = ts.dados[k].split(' ');
    const secoes = [];
    for (let s = 0; s < nomesSecao.length; s++) {
      if (a[s + 1] !== b[s + 1]) {
        secoes.push(nomesSecao[s]);
        porSecao[s]++;
      }
    }
    divergentes.push({ seed: Number(a[0]), secoes });
  }

  const passaram = n - divergentes.length;
  console.log(`      ${passaram}/${n} seeds idênticas bit a bit`);
  if (rotuloCobertura) {
    console.log(`      exercitado: ${rotuloCobertura(go.cobertura)}`);
  }
  if (divergentes.length > 0) {
    falhou = true;
    console.log(`      DIVERGIRAM ${divergentes.length} seeds`);
    for (let s = 0; s < nomesSecao.length; s++) {
      if (porSecao[s]) console.log(`        seção ${nomesSecao[s]}: ${porSecao[s]} seeds`);
    }
    diagnosticar(cenario, divergentes[0].seed, ticks);
  }
}

/** Roda a seed culpada nos dois lados em modo detalhe e mostra a PRIMEIRA linha diferente. */
function diagnosticar(cenario, seed, ticks) {
  console.log(`\n      --- primeira divergência, cenário ${cenario}, seed ${seed} ---`);
  const go = join(OUT, `detalhe_${cenario}_go_${seed}.txt`);
  const ts = join(OUT, `detalhe_${cenario}_ts_${seed}.txt`);
  rodarGo(
    runner,
    { bin: 'paridade', argv: ['-modo', 'detalhe', '-cenario', cenario, '-seed', String(seed), '-ticks', String(ticks)] },
    go,
  );
  rodarTs(argsTs(cenario, ['--modo', 'detalhe', '--seed', String(seed), '--ticks', String(ticks)]), ts);

  const linhasGo = readFileSync(go, 'utf8').trimEnd().split('\n');
  const linhasTs = readFileSync(ts, 'utf8').trimEnd().split('\n');
  const limite = Math.min(linhasGo.length, linhasTs.length);
  for (let k = 0; k < limite; k++) {
    if (linhasGo[k] === linhasTs[k]) continue;
    console.log(`      linha ${k + 1}`);
    console.log(`        go: ${linhasGo[k]}`);
    console.log(`        ts: ${linhasTs[k]}`);
    // O tick é o primeiro token numérico dos registros de simulação, de evento e de input de bot.
    const campos = linhasGo[k].split(' ');
    if (campos[0] === 'simulacao' || campos[0] === 'eventos' || campos[0] === 'bots' || campos[0] === 'powerups') {
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

titulo(3, `simulação completa em ${SEEDS} seeds`);
await compararVarredura('partida', ['labirinto', 'spawns', 'simulacao', 'eventos'], null);

titulo(4, `IA dos bots em ${SEEDS} seeds`);
await compararVarredura(
  'bots',
  ['bots', 'simulacao', 'eventos'],
  (c) => `${c.disparos ?? 0} disparos, ${c.mortes ?? 0} mortes, ` +
    `${c.seeds_com_morte ?? 0}/${c.seeds ?? 0} seeds com morte`,
);

titulo(5, `power-ups em ${SEEDS} seeds`);
await compararVarredura(
  'powerups',
  ['powerups', 'simulacao', 'eventos'],
  (c) => `${c.coletas ?? 0} coletas em ${c.seeds_com_coleta ?? 0}/${c.seeds ?? 0} seeds, ` +
    `${c.fins_de_efeito ?? 0} efeitos expirados, ${c.disparos_carimbados ?? 0} balas carimbadas`,
);

console.log(`\n${falhou ? 'FALHOU' : 'PARIDADE COMPLETA'} — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(falhou ? 1 : 0);
