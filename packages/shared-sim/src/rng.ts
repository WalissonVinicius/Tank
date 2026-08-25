export interface Rng {
  next(): number; // [0, 1)
  int(maxExclusive: number): number; // [0, maxExclusive)
  pick<T>(arr: readonly T[]): T;
  shuffle<T>(arr: T[]): T[]; // in-place, também retorna o array
  getState(): number;
  setState(state: number): void;
}

// mulberry32 — RNG determinístico de 32 bits, período ~2^32, barato e fácil de portar
// byte a byte entre cliente e servidor. Nunca usar Math.random() em seu lugar aqui dentro.
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;

  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (maxExclusive: number): number => Math.floor(next() * maxExclusive);

  const pick = <T>(arr: readonly T[]): T => {
    const item = arr[int(arr.length)];
    if (item === undefined) throw new Error('Rng.pick: array vazio');
    return item;
  };

  const shuffle = <T>(arr: T[]): T[] => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const tmp = arr[i]!;
      arr[i] = arr[j]!;
      arr[j] = tmp;
    }
    return arr;
  };

  return {
    next,
    int,
    pick,
    shuffle,
    getState: () => a,
    setState: (state: number) => {
      a = state >>> 0;
    },
  };
}
