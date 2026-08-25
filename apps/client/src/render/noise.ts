// Value-noise determinístico (sem Math.random()) — usado pelo screen shake (juice.ts),
// tremeluzir de luzes (lights.ts) e variação por célula do piso/labirinto (maze.ts, textures.ts).

function hash1(i: number): number {
  let x = Math.imul(i | 0, 374761393);
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (((x >>> 0) % 100000) / 100000) * 2 - 1; // -1..1
}

// Ruído 1D suave (interpolação smoothstep entre hashes de inteiros vizinhos) — determinístico
// em função de `t`, nunca de Math.random(). É o que dá o tremor orgânico do screen shake.
export function valueNoise1D(t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}

export function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) % 100000) / 100000; // 0..1
}

// Ruído 2D em grade periódica (lattice), usado para o ruído do piso — período `n` evita
// costuras visíveis quando a textura é usada como TilingSprite.
export function valueNoise2D(x: number, y: number, period: number): number {
  const lat = (ix: number, iy: number): number =>
    hash2(((ix % period) + period) % period, ((iy % period) + period) % period);
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = lat(ix, iy);
  const b = lat(ix + 1, iy);
  const c = lat(ix, iy + 1);
  const d = lat(ix + 1, iy + 1);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}
