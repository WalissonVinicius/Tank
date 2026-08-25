// Luz como ACENTO, nunca como escuridão. Não existe mais lightmap multiplicativo: a arena é
// desenhada iluminada por igual e esta camada só soma brilho local por alguns frames em cima de
// eventos (muzzle flash, ricochete, explosão). Container aditivo puro — onde não há evento, não
// há sprite, e a cena aparece exatamente como o albedo do labirinto.

import { Container, Sprite } from 'pixi.js';
import type { GameTextures } from './textures.js';

interface DynamicLight {
  sprite: Sprite;
  life: number;
  maxLife: number;
  radius: number;
  baseAlpha: number;
}

const easeOutQuad = (t: number): number => 1 - (1 - t) * (1 - t);

export class LightFx {
  readonly container = new Container();

  private readonly textures: GameTextures;
  private readonly lights: DynamicLight[] = [];
  // Cada tiro, ricochete e morte acendia um clarão — e cada clarão criava e destruía um Sprite.
  // Num tiroteio de 6 tanques isso é dezenas de Sprites (objetos pesados do Pixi) por segundo,
  // indo direto para o lixo. Agora eles voltam para esta pilha e são reusados.
  private readonly reserva: Sprite[] = [];

  constructor(textures: GameTextures) {
    this.textures = textures;
    this.container.blendMode = 'add';
  }

  /** Clarão temporário e local. `ms` curto de propósito: o brilho é tempero, não iluminação. */
  flash(x: number, y: number, radius: number, tint: number, ms: number, alpha = 1): void {
    const sprite = this.reserva.pop() ?? this.novoSprite();
    sprite.width = radius * 2;
    sprite.height = radius * 2;
    sprite.tint = tint;
    sprite.alpha = alpha;
    sprite.position.set(x, y);
    sprite.visible = true;
    this.container.addChild(sprite);
    this.lights.push({ sprite, life: ms, maxLife: ms, radius, baseAlpha: alpha });
  }

  private novoSprite(): Sprite {
    const sprite = new Sprite(this.textures.light);
    sprite.anchor.set(0.5);
    sprite.blendMode = 'add';
    return sprite;
  }

  update(dtSeconds: number): void {
    for (let i = this.lights.length - 1; i >= 0; i--) {
      const l = this.lights[i]!;
      l.life -= dtSeconds * 1000;
      if (l.life <= 0) {
        this.container.removeChild(l.sprite);
        l.sprite.visible = false;
        this.reserva.push(l.sprite);
        this.lights[i] = this.lights[this.lights.length - 1]!;
        this.lights.pop();
        continue;
      }
      const k = l.life / l.maxLife;
      l.sprite.alpha = l.baseAlpha * easeOutQuad(k);
      const size = l.radius * 2 * (0.8 + 0.35 * (1 - k));
      l.sprite.width = size;
      l.sprite.height = size;
    }
  }

  destroy(): void {
    for (const l of this.lights) l.sprite.destroy();
    for (const s of this.reserva) s.destroy();
    this.lights.length = 0;
    this.reserva.length = 0;
    this.container.destroy({ children: true });
  }
}
