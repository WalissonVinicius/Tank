// A bala é um OBJETO DESENHADO, não um projétil de energia. Mesma técnica do tanque
// (`tank.ts`): corpo sólido preenchido, contorno escuro grosso por cima e um detalhe na cor do
// dono. É o contorno que faz a peça existir sobre o piso claro — sem ele qualquer coisa pequena
// vira borrão luminoso. Nada de núcleo branco saturado, halo aditivo ou tracer comprido: a bala
// não emite luz, é metal voando. Quem brilha é o muzzle flash (fogo de verdade), em `lights.ts`.
//
// RenderView traz só {x,y[,color]} por bala (a trajetória é simulada localmente pela shared-sim),
// então o pool reconcilia por índice e infere o ângulo pela posição anterior do mesmo slot.

import { Container, Graphics, Sprite } from 'pixi.js';
import { darken, lighten } from './color.js';
import type { GameTextures } from './textures.js';

interface BulletSlot {
  root: Container;
  body: Graphics;
  dust: Sprite[];
  prevX: number;
  prevY: number;
  hasPrev: boolean;
  /** Já sabemos a direção de voo? Antes disso a peça não gira e a poeira fica escondida. */
  aimed: boolean;
  angle: number;
  tint: number;
}

// Acima desta distância entre dois sync() consecutivos, o slot trocou de bala (uma expirou e
// outra entrou no mesmo índice) — não é movimento real, então não desenha rastro nem gira.
// Folga grande de propósito: num frame longo (aba recuperando, captura de screenshot) a
// simulação adianta dezenas de ticks de uma vez e a bala anda muito entre dois sync() — isso é
// deslocamento legítimo, e cortar o rastro aí fazia a bala virar um pontinho parado.
const TELEPORT_DIST = 150;

// Silhueta de ~19,2 × 10,8 px de mundo. A original (13,2 × 7,2) sumia contra o piso claro; o
// dobro (26,4 × 14,4) foi longe demais e o dono apontou: "a bala ficou grande demais,
// desproporcional". O tanque tem 37 px de diâmetro, entao 26,4 dava 71% dele — a bala
// competia com quem a atirou. 19,2 é pouco mais da METADE do tanque: lê como projétil de
// relance e continua subordinada ao tanque na hierarquia visual. O raio de COLISÃO
// (BULLET_RADIUS_F em constants.ts) segue intocado em 4,2 px — só o desenho mudou, duas vezes.
// O corpo metálico vive dentro da silhueta com ~2,5 px de contorno sobrando de cada lado. A
// margem é mantida em px ABSOLUTOS ao redimensionar: escalá-la junto deixaria o traço fino
// demais para ler numa peça menor. Duas medidas em vez de um stroke porque um traço centrado
// comeria metade do preenchimento e a bala voltaria a ser um borrão escuro.
const OUT_HALF = 9.6;
const OUT_HW = 5.4;
const BODY_HALF = 7;
const BODY_HW = 3;
const OUTLINE_COLOR = 0x0b1020;
const METAL = 0xdfe6f4;
const METAL_SHADE = 0x8b97b4;
const DEFAULT_TINT = 0xd9dee8;

// Poeira levantada atrás da bala: três borrões escuros em blend normal (fumaça aditiva clareia
// o piso claro e vira névoa branca). Distâncias fixas em px de mundo, não posições históricas —
// assim o rastro tem o mesmo comprimento curto em qualquer frame rate. Reforçado junto com o
// corpo (A2): distâncias mais longas para acompanhar a peça maior e alpha mais alto para o
// rastro ler como direção de voo num relance, não só como uma sombra colada na bala.
const DUST = [
  { dist: 16, scale: 0.4, alpha: 0.55 },
  { dist: 24, scale: 0.3, alpha: 0.32 },
  { dist: 32, scale: 0.2, alpha: 0.16 },
] as const;

export class BulletPool {
  readonly container = new Container();

  private readonly slots: BulletSlot[] = [];
  private readonly textures: GameTextures;

  constructor(textures: GameTextures) {
    this.textures = textures;
  }

  /** Mantido para o Renderer: a bala não tem mais pulso/animação própria, mas a chamada é barata. */
  updateTime(_dtSeconds: number): void {
    // sem estado temporal — a bala é um objeto rígido
  }

  sync(bullets: ReadonlyArray<{ x: number; y: number; color?: number }>): void {
    while (this.slots.length < bullets.length) this.slots.push(this.createSlot());
    while (this.slots.length > bullets.length) {
      const slot = this.slots.pop();
      if (slot) this.destroySlot(slot);
    }

    for (let i = 0; i < bullets.length; i++) {
      const b = bullets[i]!;
      const slot = this.slots[i]!;
      const tint = b.color ?? DEFAULT_TINT;
      if (tint !== slot.tint) this.drawBody(slot, tint);

      const dx = slot.hasPrev ? b.x - slot.prevX : 0;
      const dy = slot.hasPrev ? b.y - slot.prevY : 0;
      const dist = Math.hypot(dx, dy);
      const teleported = dist > TELEPORT_DIST;

      if (dist > 0.05 && !teleported) {
        slot.angle = Math.atan2(dy, dx);
        slot.aimed = true;
      } else if (teleported) {
        slot.aimed = false;
      }

      slot.body.position.set(b.x, b.y);
      slot.body.rotation = slot.angle;

      const back = slot.aimed ? 1 : 0;
      const cos = Math.cos(slot.angle);
      const sin = Math.sin(slot.angle);
      for (let d = 0; d < DUST.length; d++) {
        const cfg = DUST[d]!;
        const sprite = slot.dust[d]!;
        sprite.position.set(b.x - cos * cfg.dist * back, b.y - sin * cfg.dist * back);
        sprite.alpha = cfg.alpha * back;
      }

      slot.prevX = b.x;
      slot.prevY = b.y;
      slot.hasPrev = true;
    }
  }

  // Ogiva apontando para +x: base reta atrás (onde fica a faixa do dono), ponta arredondada na
  // frente. Mesma construção do chassi em `tank.ts`: silhueta quase preta desenhada maior por
  // baixo, corpo colorido menor por cima. É o contorno grosso que faz a peça existir sobre o
  // piso claro.
  private drawBody(slot: BulletSlot, tint: number): void {
    slot.tint = tint;
    const g = slot.body;
    g.clear();

    // Ogiva: lado reto até x=0, ponta em curva quadrática a partir daí.
    const ogiva = (half: number, hw: number): void => {
      g.moveTo(-half, -hw)
        .lineTo(0, -hw)
        .quadraticCurveTo(half * 0.86, -hw * 0.9, half, 0)
        .quadraticCurveTo(half * 0.86, hw * 0.9, 0, hw)
        .lineTo(-half, hw)
        .closePath();
    };

    ogiva(OUT_HALF, OUT_HW);
    g.fill(OUTLINE_COLOR);

    // corpo: metade de baixo em tom mais fundo, metade de cima em metal claro — dois blocos
    // chapados leem melhor que gradiente numa peça deste tamanho em tela.
    ogiva(BODY_HALF, BODY_HW);
    g.fill(METAL_SHADE);

    g.moveTo(-BODY_HALF, -BODY_HW)
      .lineTo(0, -BODY_HW)
      .quadraticCurveTo(BODY_HALF * 0.86, -BODY_HW * 0.9, BODY_HALF, 0)
      .lineTo(-BODY_HALF, 0)
      .closePath()
      .fill(METAL);

    // faixa de forçamento na cor do dono, colada na base reta — é por ela que se sabe quem
    // atirou sem a bala virar bola de luz colorida.
    const bandW = 6.4;
    g.rect(-BODY_HALF, -BODY_HW, bandW, BODY_HW).fill(lighten(tint, 0.16));
    g.rect(-BODY_HALF, 0, bandW, BODY_HW).fill(darken(tint, 0.32));
  }

  private createSlot(): BulletSlot {
    const dust = DUST.map((cfg) => {
      const sprite = new Sprite(this.textures.dot);
      sprite.anchor.set(0.5);
      sprite.scale.set(cfg.scale);
      sprite.tint = 0x2a3149;
      sprite.alpha = 0;
      return sprite;
    });

    const body = new Graphics();
    const root = new Container();
    root.addChild(...dust, body);
    this.container.addChild(root);

    const slot: BulletSlot = {
      root,
      body,
      dust,
      prevX: 0,
      prevY: 0,
      hasPrev: false,
      aimed: false,
      angle: 0,
      tint: -1,
    };
    this.drawBody(slot, DEFAULT_TINT);
    return slot;
  }

  private destroySlot(slot: BulletSlot): void {
    slot.root.destroy({ children: true });
  }

  destroy(): void {
    for (const slot of this.slots) this.destroySlot(slot);
    this.slots.length = 0;
    this.container.destroy();
  }
}
