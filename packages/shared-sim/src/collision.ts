import type { Aabb, Vec2 } from './types.js';

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Empurra o círculo para fora de todas as paredes penetradas, corrigindo só o eixo penetrado
// (normal do ponto mais próximo do AABB) — o tanque desliza ao raspar em vez de travar.
// Duas passadas resolvem o caso comum de penetração simultânea em duas paredes (quina externa).
export function circleVsAabbSlide(pos: Vec2, radius: number, aabbs: readonly Aabb[]): Vec2 {
  let x = pos.x;
  let y = pos.y;
  for (let pass = 0; pass < 2; pass++) {
    for (const wall of aabbs) {
      const cx = clamp(x, wall.x, wall.x + wall.w);
      const cy = clamp(y, wall.y, wall.y + wall.h);
      const dx = x - cx;
      const dy = y - cy;
      const distSq = dx * dx + dy * dy;
      if (distSq >= radius * radius) continue;
      const dist = Math.sqrt(distSq) || 0.0001;
      const nx = dx / dist;
      const ny = dy / dist;
      const penetration = radius - dist;
      x += nx * penetration;
      y += ny * penetration;
    }
  }
  return { x, y };
}

export interface Hit {
  point: Vec2;
  normal: Vec2;
  distance: number;
  t: number; // 0..1 ao longo do segmento from→to
}

// Slab test SEM alocação. A versão anterior devolvia `{near, far, sign}` por eixo e por parede —
// 2 objetos × ~100 paredes por raycast, e o raycast roda várias vezes por tick por bala E por bot
// (a linha de visão da IA usa o mesmo caminho). Media 3,35 MB/s de lixo e uma coleta a cada 1,5 s
// (medição da Fase 4, `_specs/_p4-perf-*.json`). Agora o resultado sai em variáveis de módulo:
// a simulação é síncrona e single-thread, e nenhuma dessas funções reentra.
//
// `NAO_BATE` sinaliza ausência de interseção sem precisar de `null` (que forçaria um objeto).
const NAO_BATE = Number.POSITIVE_INFINITY;
const EPS_SLAB = 1e-9;

let clipNear = 0;
let clipFar = 0;
let clipSign = 0;

/** Devolve `false` quando o eixo já elimina a parede; senão publica em `clipNear/Far/Sign`. */
function clipAxis(o: number, d: number, lo: number, hi: number): boolean {
  if (Math.abs(d) < EPS_SLAB) {
    if (o < lo || o > hi) return false;
    clipNear = -Infinity;
    clipFar = Infinity;
    clipSign = 0;
    return true;
  }
  const t1 = (lo - o) / d;
  const t2 = (hi - o) / d;
  if (t1 < t2) {
    clipNear = t1;
    clipFar = t2;
    clipSign = -1;
  } else {
    clipNear = t2;
    clipFar = t1;
    clipSign = 1;
  }
  return true;
}

// Saída de `segmentVsAabb`: t de entrada + normal, em variáveis de módulo.
let hitT = 0;
let hitNx = 0;
let hitNy = 0;

/** `t` de entrada no AABB, ou `NAO_BATE`. Quando bate, publica a normal em `hitNx/hitNy`. */
function segmentVsAabb(ox: number, oy: number, dx: number, dy: number, wall: Aabb): number {
  if (!clipAxis(ox, dx, wall.x, wall.x + wall.w)) return NAO_BATE;
  const xNear = clipNear;
  const xFar = clipFar;
  const xSign = clipSign;

  if (!clipAxis(oy, dy, wall.y, wall.y + wall.h)) return NAO_BATE;
  const yNear = clipNear;
  const yFar = clipFar;
  const ySign = clipSign;

  const tEnter = xNear > yNear ? xNear : yNear;
  const tExit = xFar < yFar ? xFar : yFar;
  if (tEnter > tExit + EPS_SLAB) return NAO_BATE;
  if (tEnter < -EPS_SLAB || tEnter > 1 + EPS_SLAB) return NAO_BATE;

  // Quina: quando os dois eixos entram no mesmo instante, soma as duas normais (refletindo
  // nos dois eixos ao mesmo tempo) em vez de escolher um eixo dominante arbitrário.
  let nx = 0;
  let ny = 0;
  if (xNear >= tEnter - EPS_SLAB) nx = xSign;
  if (yNear >= tEnter - EPS_SLAB) ny = ySign;
  const len = Math.hypot(nx, ny) || 1;
  hitNx = nx / len;
  hitNy = ny / len;
  hitT = tEnter < 0 ? 0 : tEnter > 1 ? 1 : tEnter;
  return hitT;
}

// CCD da bala: testa o segmento percorrido no tick inteiro contra cada parede, não só o ponto
// final — uma bala rápida em tick lento não atravessa uma parede fina. Quando duas paredes
// vizinhas (ex.: segmentos mesclados do labirinto que se tocam numa quina) empatam no menor t,
// as normais das duas são somadas — mesmo tratamento de quina do slab test acima, aplicado
// entre paredes distintas.
//
// Duas passadas (achar o menor t, depois somar as normais dos empatados) em vez de guardar a
// lista de acertos: refazer o slab test é aritmética pura e sai muito mais barato que alocar um
// array de objetos por chamada.
export function raycastSegment(from: Vec2, to: Vec2, aabbs: readonly Aabb[]): Hit | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;

  let minT = NAO_BATE;
  for (const wall of aabbs) {
    const t = segmentVsAabb(from.x, from.y, dx, dy, wall);
    if (t < minT) minT = t;
  }
  if (minT === NAO_BATE) return null;

  const EPS = 1e-6;
  let nx = 0;
  let ny = 0;
  for (const wall of aabbs) {
    const t = segmentVsAabb(from.x, from.y, dx, dy, wall);
    if (t !== NAO_BATE && t - minT <= EPS) {
      nx += hitNx;
      ny += hitNy;
    }
  }
  const len = Math.hypot(nx, ny) || 1;
  return {
    point: { x: from.x + dx * minT, y: from.y + dy * minT },
    normal: { x: nx / len, y: ny / len },
    distance: Math.hypot(dx, dy) * minT,
    t: minT,
  };
}

// r = d − 2(d·n)n — reflexão vetorial pura. Com uma normal diagonal (quina), reflete os dois
// eixos de uma vez pela própria fórmula, sem caso especial.
export function reflect(dir: Vec2, normal: Vec2): Vec2 {
  const d = dir.x * normal.x + dir.y * normal.y;
  return { x: dir.x - 2 * d * normal.x, y: dir.y - 2 * d * normal.y };
}

/**
 * Só "bate ou não bate" — sem ponto de impacto, sem normal, sem objeto de retorno. É o caminho
 * mais chamado da simulação inteira (cada bot testa linha de visão em todo tick, e o BFS testa
 * de novo a cada waypoint), então vale ter uma versão que sai no primeiro acerto.
 */
export function hasLineOfSight(a: Vec2, b: Vec2, aabbs: readonly Aabb[]): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const wall of aabbs) {
    if (segmentVsAabb(a.x, a.y, dx, dy, wall) !== NAO_BATE) return false;
  }
  return true;
}
