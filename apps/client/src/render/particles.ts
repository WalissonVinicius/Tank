// Pool de partículas em ParticleContainer (v8) — faíscas de ricochete, fumaça de disparo e
// fragmentos de explosão. Teto de ~1900 partículas simultâneas (spec P2B).
//
// Dois containers: `container` aditivo (tudo que emite luz — faísca, fogo, brasa) e
// `smokeContainer` em blend normal (poeira e fumaça). Num mundo claro, fumaça aditiva clareia o
// piso e vira névoa branca; em blend normal ela escurece, que é como fumaça se lê de verdade.

import { Particle, ParticleContainer, Rectangle } from 'pixi.js';
import type { GameTextures } from './textures.js';

export interface SpawnOptions {
  drag?: number;
  grow?: number;
  gravity?: number;
  alpha?: number;
  /** Manda a partícula para a camada não-aditiva (poeira/fumaça, que escurece em vez de clarear). */
  smoke?: boolean;
}

interface ParticleState {
  particle: Particle;
  smoke: boolean;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  baseScale: number;
  drag: number;
  grow: number;
  gravity: number;
  baseAlpha: number;
}

const MAX_PARTICLES = 1900;
const easeInQuad = (t: number): number => t * t;

export class ParticleSystem {
  readonly container: ParticleContainer;
  readonly smokeContainer: ParticleContainer;

  private readonly items: ParticleState[] = [];
  private readonly texture;

  constructor(textures: GameTextures) {
    this.texture = textures.dot;
    this.container = new ParticleContainer({
      dynamicProperties: { position: true, scale: true, color: true },
    });
    this.container.blendMode = 'add';
    this.container.boundsArea = new Rectangle(-1000, -1000, 4000, 4000);

    this.smokeContainer = new ParticleContainer({
      dynamicProperties: { position: true, scale: true, color: true },
    });
    this.smokeContainer.boundsArea = new Rectangle(-1000, -1000, 4000, 4000);
  }

  setWorldBounds(width: number, height: number): void {
    const pad = 400;
    const area = new Rectangle(-pad, -pad, width + pad * 2, height + pad * 2);
    this.container.boundsArea = area;
    this.smokeContainer.boundsArea = area;
  }

  spawn(
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    scale: number,
    tint: number,
    opts: SpawnOptions = {},
  ): void {
    if (this.items.length > MAX_PARTICLES) return;
    const alpha = opts.alpha ?? 1;
    const particle = new Particle({
      texture: this.texture,
      x,
      y,
      anchorX: 0.5,
      anchorY: 0.5,
      scaleX: scale,
      scaleY: scale,
      tint,
      alpha,
    });
    const smoke = opts.smoke ?? false;
    (smoke ? this.smokeContainer : this.container).addParticle(particle);
    this.items.push({
      particle,
      smoke,
      vx,
      vy,
      life,
      maxLife: life,
      baseScale: scale,
      drag: opts.drag ?? 2.5,
      grow: opts.grow ?? 0,
      gravity: opts.gravity ?? 0,
      baseAlpha: alpha,
    });
  }

  update(dtSeconds: number): void {
    if (dtSeconds <= 0) return;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i]!;
      p.life -= dtSeconds;
      if (p.life <= 0) {
        (p.smoke ? this.smokeContainer : this.container).removeParticle(p.particle);
        this.items[i] = this.items[this.items.length - 1]!;
        this.items.pop();
        continue;
      }
      const k = p.life / p.maxLife;
      const f = 1 - Math.exp(-p.drag * dtSeconds);
      p.vx -= p.vx * f;
      p.vy -= p.vy * f;
      p.vy += p.gravity * dtSeconds;
      p.particle.x += p.vx * dtSeconds;
      p.particle.y += p.vy * dtSeconds;

      const scale = p.baseScale * (1 + p.grow * (1 - k)) * (p.grow ? 1 : 0.4 + 0.6 * k);
      p.particle.scaleX = scale;
      p.particle.scaleY = scale;
      p.particle.alpha = p.baseAlpha * easeInQuad(k);
    }
  }

  get count(): number {
    return this.items.length;
  }

  destroy(): void {
    this.container.destroy();
    this.smokeContainer.destroy();
    this.items.length = 0;
  }
}
