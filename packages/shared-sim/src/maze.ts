import {
  CELL,
  MAZE_ASPECT_DEFAULT,
  MAZE_ASPECT_MAX,
  MAZE_ASPECT_MIN,
  MAZE_BY_PLAYERS,
  SPAWN_LOS_MIN_DIST,
  WALL_THICKNESS,
  type MazeDensity,
} from '@tank/protocol';
import { hasLineOfSight } from './collision.js';
import { mulberry32, type Rng } from './rng.js';
import type { Aabb, Maze, Vec2 } from './types.js';

function densityFor(players: number): MazeDensity {
  const n = Math.min(10, Math.max(2, Math.round(players)));
  const density = MAZE_BY_PLAYERS[n];
  if (!density) throw new Error(`densidade de labirinto não definida para ${n} jogadores`);
  return density;
}

// Piso de forma. Abaixo disso o "labirinto" vira um corredor reto e a geração perde sentido —
// e `spawnPoints` precisa de pelo menos tantas células quanto jogadores (4×3 = 12 ≥ 10).
const MIN_ROWS = 3;
const MIN_COLS = 4;

/**
 * Forma do labirinto para uma proporção de tela (Fase 9).
 *
 * O pedido do usuário foi "o mapa do jogo precisa ser em tela cheia também". A saída NÃO é
 * esticar nem cortar o labirinto: as células têm que continuar quadradas, senão a bala deixa de
 * ricochetear em 45° e a leitura do jogo morre. O que muda é a FORMA da grade — o mesmo total de
 * células, redistribuído entre colunas e linhas até `cols/rows` bater com a proporção da tela.
 *
 * Como a grade é discreta, o total nunca cai exatamente no orçamento. Das duas formas candidatas
 * (arredondando as linhas para baixo e para cima) fica a que menos erra a densidade calibrada; no
 * empate ganha a MENOR, porque menos células = tanque maior na tela, que é o que a legibilidade
 * pede quando a arena passa a ocupar a janela inteira.
 *
 * Determinístico e sem estado: dados os mesmos `players` e `aspect`, devolve sempre a mesma forma
 * — é isso que permite ao servidor combinar a proporção uma vez por rodada e cada cliente chegar
 * ao mesmo labirinto.
 */
export function mazeShape(players: number, aspect: number = MAZE_ASPECT_DEFAULT): MazeDensity {
  const base = densityFor(players);
  const alvoCelulas = base.cols * base.rows;
  const a = Number.isFinite(aspect)
    ? Math.min(MAZE_ASPECT_MAX, Math.max(MAZE_ASPECT_MIN, aspect))
    : MAZE_ASPECT_DEFAULT;

  const linhasIdeais = Math.sqrt(alvoCelulas / a);
  let melhor: MazeDensity | null = null;
  let menorErro = Infinity;

  // Da menor para a maior: no empate de erro a primeira vence, e a primeira é sempre a de menos
  // células. Nada de `sort` — a ordem de avaliação já é o critério de desempate.
  for (const candidata of [Math.floor(linhasIdeais), Math.ceil(linhasIdeais)]) {
    const rows = Math.max(MIN_ROWS, candidata);
    const cols = Math.max(MIN_COLS, Math.round(rows * a));
    const erro = Math.abs(Math.log((cols * rows) / alvoCelulas));
    if (erro < menorErro - 1e-9) {
      menorErro = erro;
      melhor = { cols, rows, braidPct: base.braidPct };
    }
  }

  return melhor ?? { cols: base.cols, rows: base.rows, braidPct: base.braidPct };
}

// vw[x][y] = true → existe parede a leste da célula (x,y) (entre (x,y) e (x+1,y)).
// hw[x][y] = true → existe parede ao sul da célula (x,y) (entre (x,y) e (x,y+1)).
type WallGrid = boolean[][];

function carve(cols: number, rows: number, rng: Rng): { vw: WallGrid; hw: WallGrid } {
  const vw: WallGrid = Array.from({ length: cols }, () => Array<boolean>(rows).fill(true));
  const hw: WallGrid = Array.from({ length: cols }, () => Array<boolean>(rows).fill(true));
  const visited: WallGrid = Array.from({ length: cols }, () => Array<boolean>(rows).fill(false));

  const startX = rng.int(cols);
  const startY = rng.int(rows);
  const stack: [number, number][] = [[startX, startY]];
  visited[startX]![startY] = true;

  while (stack.length > 0) {
    const [x, y] = stack[stack.length - 1]!;
    const neighbors: [number, number, 0 | 1 | 2 | 3][] = [];
    if (x < cols - 1 && !visited[x + 1]![y]) neighbors.push([x + 1, y, 0]);
    if (y < rows - 1 && !visited[x]![y + 1]) neighbors.push([x, y + 1, 1]);
    if (x > 0 && !visited[x - 1]![y]) neighbors.push([x - 1, y, 2]);
    if (y > 0 && !visited[x]![y - 1]) neighbors.push([x, y - 1, 3]);

    if (neighbors.length === 0) {
      stack.pop();
      continue;
    }
    const [nx, ny, d] = rng.pick(neighbors);
    if (d === 0) vw[x]![y] = false;
    else if (d === 1) hw[x]![y] = false;
    else if (d === 2) vw[nx]![ny] = false;
    else hw[nx]![ny] = false;
    visited[nx]![ny] = true;
    stack.push([nx, ny]);
  }

  return { vw, hw };
}

function braid(cols: number, rows: number, vw: WallGrid, hw: WallGrid, braidPct: number, rng: Rng): void {
  const internal: ['v' | 'h', number, number][] = [];
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      if (x < cols - 1 && vw[x]![y]) internal.push(['v', x, y]);
      if (y < rows - 1 && hw[x]![y]) internal.push(['h', x, y]);
    }
  }
  rng.shuffle(internal);
  const remove = Math.floor(internal.length * braidPct);
  for (let i = 0; i < remove; i++) {
    const [kind, x, y] = internal[i]!;
    if (kind === 'v') vw[x]![y] = false;
    else hw[x]![y] = false;
  }
}

function buildWalls(cols: number, rows: number, cell: number, vw: WallGrid, hw: WallGrid): Aabb[] {
  const walls: Aabb[] = [];
  const width = cols * cell;
  const height = rows * cell;
  const half = WALL_THICKNESS / 2;

  walls.push({ x: -half, y: -half, w: width + WALL_THICKNESS, h: WALL_THICKNESS });
  walls.push({ x: -half, y: height - half, w: width + WALL_THICKNESS, h: WALL_THICKNESS });
  walls.push({ x: -half, y: -half, w: WALL_THICKNESS, h: height + WALL_THICKNESS });
  walls.push({ x: width - half, y: -half, w: WALL_THICKNESS, h: height + WALL_THICKNESS });

  for (let x = 0; x < cols - 1; x++) {
    let y = 0;
    while (y < rows) {
      if (vw[x]![y]) {
        let y2 = y;
        while (y2 + 1 < rows && vw[x]![y2 + 1]) y2++;
        walls.push({
          x: (x + 1) * cell - half,
          y: y * cell - half,
          w: WALL_THICKNESS,
          h: (y2 - y + 1) * cell + WALL_THICKNESS,
        });
        y = y2 + 1;
      } else {
        y++;
      }
    }
  }

  for (let y = 0; y < rows - 1; y++) {
    let x = 0;
    while (x < cols) {
      if (hw[x]![y]) {
        let x2 = x;
        while (x2 + 1 < cols && hw[x2 + 1]![y]) x2++;
        walls.push({
          x: x * cell - half,
          y: (y + 1) * cell - half,
          w: (x2 - x + 1) * cell + WALL_THICKNESS,
          h: WALL_THICKNESS,
        });
        x = x2 + 1;
      } else {
        x++;
      }
    }
  }

  return walls;
}

/**
 * `aspect` é a proporção largura/altura da ÁREA JOGÁVEL de quem vai desenhar. Ele NUNCA pode ser
 * lido do `innerWidth` de cada cliente: a tela de cada jogador tem um tamanho, e derivar a forma
 * localmente faria cada um gerar um labirinto diferente com a mesma seed — a bala prevista no
 * cliente ricochetearia num lugar e a do servidor em outro. O servidor combina a proporção uma
 * vez por rodada e a manda junto da seed (`RoundStartMsg.aspect`).
 */
export function makeMaze(seed: number, players: number, aspect: number = MAZE_ASPECT_DEFAULT): Maze {
  const { cols, rows, braidPct } = mazeShape(players, aspect);
  const rng = mulberry32(seed);
  const { vw, hw } = carve(cols, rows, rng);
  braid(cols, rows, vw, hw, braidPct, rng);
  const walls = buildWalls(cols, rows, CELL, vw, hw);
  return { cols, rows, cell: CELL, walls };
}

export function cellCenter(maze: Maze, cx: number, cy: number): Vec2 {
  return { x: (cx + 0.5) * maze.cell, y: (cy + 0.5) * maze.cell };
}

function pointInAnyWall(walls: readonly Aabb[], px: number, py: number): boolean {
  for (const w of walls) {
    if (px >= w.x && px <= w.x + w.w && py >= w.y && py <= w.y + w.h) return true;
  }
  return false;
}

// Duas células vizinhas estão conectadas se o ponto médio da fronteira compartilhada entre
// elas não está dentro de nenhuma parede — evita depender da grade de geração (vw/hw) fora
// deste módulo, então validação/BFS funcionam só a partir de `Maze.walls`.
function cellsConnected(maze: Maze, ax: number, ay: number, bx: number, by: number): boolean {
  const midX = ((ax + 0.5) * maze.cell + (bx + 0.5) * maze.cell) / 2;
  const midY = ((ay + 0.5) * maze.cell + (by + 0.5) * maze.cell) / 2;
  return !pointInAnyWall(maze.walls, midX, midY);
}

function neighborsOf(maze: Maze, x: number, y: number): [number, number][] {
  const result: [number, number][] = [];
  if (x < maze.cols - 1 && cellsConnected(maze, x, y, x + 1, y)) result.push([x + 1, y]);
  if (x > 0 && cellsConnected(maze, x, y, x - 1, y)) result.push([x - 1, y]);
  if (y < maze.rows - 1 && cellsConnected(maze, x, y, x, y + 1)) result.push([x, y + 1]);
  if (y > 0 && cellsConnected(maze, x, y, x, y - 1)) result.push([x, y - 1]);
  return result;
}

function bfsDistances(maze: Maze, from: [number, number]): number[][] {
  const dist: number[][] = Array.from({ length: maze.cols }, () => Array<number>(maze.rows).fill(-1));
  dist[from[0]]![from[1]] = 0;
  const queue: [number, number][] = [from];
  let head = 0;
  while (head < queue.length) {
    const [x, y] = queue[head++]!;
    const d = dist[x]![y]!;
    for (const [nx, ny] of neighborsOf(maze, x, y)) {
      if (dist[nx]![ny] === -1) {
        dist[nx]![ny] = d + 1;
        queue.push([nx, ny]);
      }
    }
  }
  return dist;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Célula da grade que contém o ponto, sempre dentro dos limites do labirinto. */
export function cellOf(maze: Maze, p: Vec2): { cx: number; cy: number } {
  return {
    cx: clampInt(Math.floor(p.x / maze.cell), 0, maze.cols - 1),
    cy: clampInt(Math.floor(p.y / maze.cell), 0, maze.rows - 1),
  };
}

// Um passo de caminho no grafo do labirinto: BFS a partir da célula do destino, devolvendo o
// centro da célula vizinha da origem com a menor distância até lá. Puro e determinístico — só
// depende de `maze.walls`, então cliente e servidor chegam ao mesmo waypoint. Se origem e
// destino já estão na mesma célula (ou o destino é inalcançável), devolve o destino bruto.
export function nextStepTowards(maze: Maze, from: Vec2, to: Vec2): Vec2 {
  const start = cellOf(maze, from);
  const goal = cellOf(maze, to);
  if (start.cx === goal.cx && start.cy === goal.cy) return to;

  const dist = bfsDistances(maze, [goal.cx, goal.cy]);
  const here = dist[start.cx]![start.cy]!;
  if (here < 0) return to;

  let best: [number, number] | null = null;
  let bestDist = here;
  for (const [nx, ny] of neighborsOf(maze, start.cx, start.cy)) {
    const d = dist[nx]![ny]!;
    if (d >= 0 && d < bestDist) {
      bestDist = d;
      best = [nx, ny];
    }
  }
  return best ? cellCenter(maze, best[0], best[1]) : to;
}

export function countDeadEnds(maze: Maze): number {
  let count = 0;
  for (let x = 0; x < maze.cols; x++) {
    for (let y = 0; y < maze.rows; y++) {
      if (neighborsOf(maze, x, y).length === 1) count++;
    }
  }
  return count;
}

export interface MazeValidation {
  ok: boolean;
  reason?: string;
}

// Flood fill garantindo alcançabilidade total, mais uma rede de segurança de regressão: se a
// fração de becos sem saída ficar acima de 50% das células, o braiding provavelmente não foi
// aplicado (bug), já que o braiding atual (65%) deixa quase todos os becos conectados por loops.
export function validateMaze(maze: Maze): MazeValidation {
  const dist = bfsDistances(maze, [0, 0]);
  let reachable = 0;
  for (let x = 0; x < maze.cols; x++) {
    for (let y = 0; y < maze.rows; y++) {
      if (dist[x]![y]! >= 0) reachable++;
    }
  }
  const total = maze.cols * maze.rows;
  if (reachable !== total) {
    return { ok: false, reason: `${total - reachable} célula(s) inalcançável(is) a partir de (0,0)` };
  }

  const deadEnds = countDeadEnds(maze);
  const maxAllowedDeadEnds = Math.ceil(total * 0.5);
  if (deadEnds > maxAllowedDeadEnds) {
    return { ok: false, reason: `${deadEnds} becos sem saída, acima do esperado (${maxAllowedDeadEnds})` };
  }

  return { ok: true };
}

// Distância euclidiana ao quadrado entre dois pontos — evita a raiz quando só comparamos limiares.
function distSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

// Verdadeiro se `p` enxerga algum ponto de `others` que esteja a menos de `minDist` dele. A
// checagem de distância vem primeiro porque é ordens de grandeza mais barata que o raycast.
function seesCloseNeighbor(p: Vec2, others: readonly Vec2[], walls: readonly Aabb[], minDist: number): boolean {
  if (minDist <= 0) return false;
  const limit = minDist * minDist;
  for (const other of others) {
    if (distSq(p, other) >= limit) continue;
    if (hasLineOfSight(p, other, walls)) return true;
  }
  return false;
}

// Farthest-point sampling sobre a distância real do grafo do labirinto (BFS): a cada passo entra
// a célula que maximiza a distância mínima aos spawns já escolhidos. Escolha gulosa, sem
// backtracking.
//
// A regra de linha de visão é LOCAL: numa arena aberta (braiding alto) exigir zero LOS entre
// todos os pares é inviável, e ser visto de longe na largada não é injusto — injusto é nascer
// perto E à vista. Por isso só proibimos LOS entre spawns a menos de SPAWN_LOS_MIN_DIST um do
// outro. Se nenhum candidato satisfizer o limiar, ele é relaxado em passos fixos de uma célula
// até zero; no limiar zero qualquer candidato serve, então o laço sempre termina. Custo máximo
// O(células × spawns × relaxações), sem busca ilimitada.
export function spawnPoints(maze: Maze, n: number, rng: Rng): Vec2[] {
  if (n <= 0) return [];
  const cells: [number, number][] = [];
  for (let x = 0; x < maze.cols; x++) {
    for (let y = 0; y < maze.rows; y++) cells.push([x, y]);
  }
  if (n > cells.length) throw new Error('spawnPoints: mais spawns pedidos que células no labirinto');

  const UNREACHABLE = 1 << 28;
  const minGraphDist = new Int32Array(cells.length).fill(UNREACHABLE);
  const taken = new Uint8Array(cells.length);

  const absorb = (cellIndex: number): void => {
    const dist = bfsDistances(maze, cells[cellIndex]!);
    for (let i = 0; i < cells.length; i++) {
      const [x, y] = cells[i]!;
      const d = dist[x]![y]!;
      const value = d < 0 ? UNREACHABLE : d;
      if (value < minGraphDist[i]!) minGraphDist[i] = value;
    }
  };

  const firstIndex = rng.int(cells.length);
  taken[firstIndex] = 1;
  absorb(firstIndex);
  const chosen: Vec2[] = [cellCenter(maze, cells[firstIndex]![0], cells[firstIndex]![1])];

  // Quantas vezes dá para descontar uma célula do limiar antes de ele chegar a zero.
  const relaxLevels = Math.ceil(SPAWN_LOS_MIN_DIST / maze.cell);

  while (chosen.length < n) {
    // Candidatos livres ordenados pela distância mínima decrescente. O desempate é explícito
    // pelo índice da célula (ordem fixa de varredura) — nunca confiamos na estabilidade do sort.
    const candidates: number[] = [];
    for (let i = 0; i < cells.length; i++) {
      if (!taken[i]) candidates.push(i);
    }
    if (candidates.length === 0) break;
    candidates.sort((a, b) => minGraphDist[b]! - minGraphDist[a]! || a - b);

    let picked = -1;
    for (let relax = 0; relax <= relaxLevels && picked < 0; relax++) {
      const threshold = Math.max(0, SPAWN_LOS_MIN_DIST - relax * maze.cell);
      for (const i of candidates) {
        const [cx, cy] = cells[i]!;
        if (seesCloseNeighbor(cellCenter(maze, cx, cy), chosen, maze.walls, threshold)) continue;
        picked = i;
        break;
      }
    }
    if (picked < 0) picked = candidates[0]!;

    taken[picked] = 1;
    absorb(picked);
    chosen.push(cellCenter(maze, cells[picked]![0], cells[picked]![1]));
  }

  return chosen;
}
