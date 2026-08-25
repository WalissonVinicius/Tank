// Buffer de interpolação para os tanques dos OUTROS jogadores: guarda as 2 últimas amostras
// recebidas do snapshot e interpola posição/ângulo ~100 ms no passado (configurável; 50 ms em
// cabo, relatório G §4.4). O tanque local não passa por aqui — é simulado localmente (eco de
// input) e só corrigido (snap) se divergir demais do snapshot do servidor.

export interface InterpSample {
  t: number; // performance.now() de quando a amostra chegou
  x: number;
  y: number;
  heading: number;
  turret: number;
  alive: boolean;
}

export interface InterpResult {
  x: number;
  y: number;
  heading: number;
  turret: number;
  alive: boolean;
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

function angleLerp(a: number, b: number, k: number): number {
  let diff = (b - a) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * k;
}

export class InterpolationBuffer {
  private buffers = new Map<string, InterpSample[]>();

  constructor(private delayMs = 100) {}

  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  push(id: string, sample: InterpSample): void {
    const buf = this.buffers.get(id);
    if (!buf) {
      this.buffers.set(id, [sample]);
      return;
    }
    buf.push(sample);
    if (buf.length > 2) buf.shift();
  }

  sample(id: string, now: number): InterpResult | null {
    const buf = this.buffers.get(id);
    if (!buf || buf.length === 0) return null;
    if (buf.length === 1) return buf[0]!;

    const [a, b] = buf as [InterpSample, InterpSample];
    const renderTime = now - this.delayMs;
    if (renderTime <= a.t) return a;
    if (renderTime >= b.t) return b;

    const span = b.t - a.t || 1;
    const k = (renderTime - a.t) / span;
    return {
      x: lerp(a.x, b.x, k),
      y: lerp(a.y, b.y, k),
      heading: angleLerp(a.heading, b.heading, k),
      turret: angleLerp(a.turret, b.turret, k),
      alive: b.alive,
    };
  }

  remove(id: string): void {
    this.buffers.delete(id);
  }

  clear(): void {
    this.buffers.clear();
  }
}
