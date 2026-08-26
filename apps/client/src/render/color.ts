// Utilitários de cor em inteiro 0xRRGGBB — usados por tank.ts, bullet.ts e particles.ts
// para derivar tons (escuro/claro/mistura com branco quente) a partir da cor do jogador.

export function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

export function darken(color: number, t: number): number {
  return mixColor(color, 0x000000, t);
}

export function lighten(color: number, t: number): number {
  return mixColor(color, 0xffffff, t);
}

/** Luz quente da paleta do mundo (CLAUDE.md). Superfície que a recebe REFLETE — não brilha. */
export const LUZ_QUENTE = 0xffb347;

/**
 * Puxa uma cor na direção da luz quente da arena. É o gesto oposto de `lighten`: em vez de lavar
 * o tom em direção ao branco, ele o desloca para o âmbar, que é o que faz uma superfície fria
 * parecer virada para a fonte de luz.
 */
export function warm(color: number, t: number): number {
  return mixColor(color, LUZ_QUENTE, t);
}
