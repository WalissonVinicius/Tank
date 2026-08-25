// Tanque desenhado 100% proceduralmente: chassi retangular arredondado + esteiras + torre
// circular com cano. Chassi e torre são nós separados para a torre girar independente do
// chassi (efeito de mola cosmético calculado pela shared-sim, aqui só aplicado).

import { BitmapText, Container, Graphics, Sprite } from 'pixi.js';
import { darken, lighten, mixColor } from './color.js';
import { texturaDoAnimal } from './animais.js';
import type { GameTextures } from './textures.js';

const DEATH_FLASH_FRAMES = 2;
const LABEL_FLIP_Y = 56;
const RECOIL_DECAY_PER_S = 8;

// Emblema animal (Fase 11). Ele NÃO vai no casco: o chassi tem 36 px de mundo e, com a torre e as
// esteiras em cima, sobra um quadrado de ~12 px para o bicho — nesse tamanho nenhuma silhueta
// sobrevive. A especificação prevê exatamente esta saída ("coloque o emblema junto do nome acima
// do tanque"), e junto do nome ele tem 30 px de mundo, quase a largura do tanque inteiro.
const EMBLEMA = 30;
/** Folga entre o emblema e o nome dentro da plaqueta. */
const EMBLEMA_GAP = 4;
/** Distância do centro do tanque até o centro da plaqueta. */
const PLAQUETA_DIST = 32;

// Farol (Fase 7): marca a frente do CHASSI, não da torre — desde a Fase 4 a torre segue o mouse
// independente do chassi, e o jogo ficou sem nenhuma pista visual de qual das duas direções é o
// "para onde eu ando". O cone e os pontos abaixo são filhos de `root`, então giram com
// `tank.heading` de graça (mesma rotação já aplicada ao chassi em sync()) — nenhum custo por frame.
const HEADLIGHT_ORIGIN_X = 17; // borda frontal do casco, logo à frente do detalhe da placa dianteira
const HEADLIGHT_RANGE = 100; // px — ~1,2 célula (CELL=84 em @tank/protocol), pedido do usuário
//
// Fase 12: "no farol deveria deixar dois farol né, simular um farol mesmo". Saiu o cone único no
// eixo do chassi, entrou um PAR: uma lâmpada em cada canto da dianteira, afastada simetricamente
// do eixo, cada uma com seu cone aberto levemente para fora. Os dois feixes se cruzam à frente e
// é esse cruzamento que forma a área iluminada — a leitura de veículo vem do par, não do cone.
/** Afastamento de cada farol em relação ao eixo do chassi (o casco tem 20 px de largura útil). */
const HEADLIGHT_OFFSET_Y = 6.5;
/** Quanto cada feixe abre para FORA do eixo — o suficiente para os dois se cruzarem, não divergirem. */
const HEADLIGHT_SPLAY = (7 * Math.PI) / 180;
// Discreto de propósito: o pedido foi "não precisa ser um farol forte, só para se localizar", e a
// calibração aprovada era um cone único a 0,12. Como agora são dois feixes somando em `add` na
// região onde se cruzam, cada um entra a 0,075: o miolo iluminado fica em ~0,15 e as bordas mais
// fracas que antes, mantendo a intensidade percebida onde o jogador olha.
const HEADLIGHT_CONE_ALPHA = 0.075;
/** Diâmetro (px) do ponto de luz da lâmpada — é o que marca ONDE está cada farol. */
const HEADLIGHT_BULB = 7;
const HEADLIGHT_BULB_ALPHA = 0.5;

export class TankView {
  /** Chassi (posição + rotação = heading do tanque). */
  readonly root = new Container();
  /** Torre — filho do chassi, rotação local = ângulo absoluto da torre menos o heading. */
  readonly turret = new Container();
  /** Sombra elíptica — não é filha de `root`; o Renderer a posiciona na camada de sombras. */
  readonly shadow: Sprite;
  /**
   * Plaqueta de identidade sobre o tanque: EMBLEMA DO ANIMAL + nome. O Renderer a anexa à camada
   * de nomes, que fica por cima da luz — nenhum clarão apaga quem é quem.
   */
  readonly label = new Container();

  readonly color: number;
  readonly name: string;

  private readonly nomeTexto: BitmapText;
  private readonly emblema: Sprite;
  private larguraNomeMedida = -1;
  private readonly turretGfx: Graphics;
  private readonly flashOverlay: Graphics;
  private recoil = 0;
  private alive = true;
  private dying = false;
  private deathFlashFrames = 0;

  constructor(color: number, name: string, textures: GameTextures) {
    this.color = color;
    this.name = name;

    // Num piso claro o tanque lê como silhueta escura com contorno neon: chassi bem mais fundo
    // que a cor do jogador e um contorno quase preto por baixo de tudo.
    const dark = darken(color, 0.68);
    const mid = darken(color, 0.5);
    const hi = lighten(color, 0.4);

    const body = new Graphics();
    body.roundRect(-18, -16.5, 36, 33, 5).fill({ color: 0x0d1220, alpha: 0.92 });
    body
      .roundRect(-19, -15, 38, 9, 2.5)
      .fill(0x0a0e18)
      .roundRect(-19, 6, 38, 9, 2.5)
      .fill(0x0a0e18);
    for (let i = -16; i <= 16; i += 4) {
      body.rect(i - 1, -14, 2, 7).fill({ color: 0x2a3452, alpha: 0.9 });
      body.rect(i - 1, 7, 2, 7).fill({ color: 0x2a3452, alpha: 0.9 });
    }
    body
      .roundRect(-16, -10, 32, 20, 4)
      .fill(mid)
      .stroke({ width: 1.8, color, alpha: 1 });
    body
      .roundRect(-12, -6, 12, 12, 2)
      .fill({ color: dark, alpha: 0.75 })
      .stroke({ width: 1, color, alpha: 0.35 });
    body.rect(9, -7, 4, 14).fill({ color, alpha: 0.7 });
    body.rect(-15, -8, 2, 16).fill({ color: 0x000000, alpha: 0.35 });
    body.moveTo(-11, -9.5).lineTo(12, -9.5).stroke({ width: 1, color: hi, alpha: 0.35 });

    // Os dois faróis são filhos de `root`, então giram com `tank.heading` de graça — continuam
    // presos ao CHASSI, nunca à torre. Texturas pré-geradas com `tint`: nenhum `Graphics` por frame.
    const farois = new Container();
    for (const lado of [-1, 1] as const) {
      const cone = new Sprite(textures.headlightCone);
      cone.anchor.set(0, 0.5);
      cone.position.set(HEADLIGHT_ORIGIN_X, lado * HEADLIGHT_OFFSET_Y);
      cone.rotation = lado * HEADLIGHT_SPLAY;
      cone.scale.set(HEADLIGHT_RANGE / textures.headlightCone.width);
      cone.tint = color;
      cone.alpha = HEADLIGHT_CONE_ALPHA;
      cone.blendMode = 'add';

      // A lâmpada em si: sem ela os dois cones viram uma mancha só e o par não lê. Fica no ápice
      // do próprio feixe, clareada em relação à cor do jogador para não sumir nos tons escuros.
      const lampada = new Sprite(textures.glow);
      lampada.anchor.set(0.5);
      lampada.setSize(HEADLIGHT_BULB, HEADLIGHT_BULB);
      lampada.position.set(HEADLIGHT_ORIGIN_X - 1, lado * HEADLIGHT_OFFSET_Y);
      lampada.tint = lighten(color, 0.5);
      lampada.alpha = HEADLIGHT_BULB_ALPHA;
      lampada.blendMode = 'add';

      farois.addChild(cone, lampada);
    }

    const turretGfx = new Graphics();
    turretGfx
      .roundRect(5, -2.6, 20, 5.2, 1.5)
      .fill(0x0f1422)
      .stroke({ width: 1, color, alpha: 0.85 });
    turretGfx.rect(21, -3.4, 4.5, 6.8).fill(color);
    turretGfx
      .circle(0, 0, 8.5)
      .fill(dark)
      .stroke({ width: 1.8, color, alpha: 1 });
    turretGfx.circle(0, 0, 3.2).fill({ color, alpha: 0.95 });
    turretGfx.circle(-3, -3, 1.2).fill({ color: hi, alpha: 0.8 });
    this.turretGfx = turretGfx;
    this.turret.addChild(turretGfx);

    const flashOverlay = new Graphics();
    flashOverlay.roundRect(-19, -15, 38, 30, 3).fill(0xffffff);
    flashOverlay.circle(0, 0, 9).fill(0xffffff);
    flashOverlay.visible = false;
    this.flashOverlay = flashOverlay;

    this.root.addChild(body, farois, this.turret, flashOverlay);

    this.shadow = new Sprite(textures.shadow);
    this.shadow.anchor.set(0.5);
    this.shadow.alpha = 0.4;
    this.shadow.width = 58;
    this.shadow.height = 44;

    this.nomeTexto = new BitmapText({
      text: name,
      style: {
        fontFamily: 'Sora',
        fontSize: 11,
        fontWeight: '600',
        fill: mixColor(color, 0xffffff, 0.55),
        stroke: { color: 0x0d1220, width: 3.5 },
        letterSpacing: 0.3,
      },
    });
    this.nomeTexto.anchor.set(0, 0.5);

    this.emblema = new Sprite(texturaDoAnimal(color));
    this.emblema.anchor.set(0.5);
    this.emblema.setSize(EMBLEMA, EMBLEMA);

    this.label.addChild(this.emblema, this.nomeTexto);
    this.medirPlaqueta();
  }

  /**
   * Centraliza emblema + nome em torno da origem da plaqueta. A largura do `BitmapText` só é
   * confiável depois de a fonte estar instalada, então a medida é refeita quando ela muda — são
   * duas comparações de float por frame, e é o que evita a plaqueta nascer torta enquanto a Sora
   * ainda está carregando.
   */
  private medirPlaqueta(): void {
    const larguraNome = this.name ? this.nomeTexto.width : 0;
    this.larguraNomeMedida = larguraNome;
    const gap = larguraNome > 0 ? EMBLEMA_GAP : 0;
    const total = EMBLEMA + gap + larguraNome;
    this.emblema.position.set(-total / 2 + EMBLEMA / 2, 0);
    this.nomeTexto.position.set(-total / 2 + EMBLEMA + gap, 0);
  }

  sync(x: number, y: number, angle: number, turretAngle: number, aliveNow: boolean): void {
    this.root.position.set(x, y);
    this.root.rotation = angle;
    this.turret.rotation = turretAngle - angle;
    this.shadow.position.set(x + 4, y + 6);
    if (this.nomeTexto.width !== this.larguraNomeMedida) this.medirPlaqueta();
    // Perto da borda de cima não há espaço para a plaqueta acima do tanque — ela vira para baixo
    // em vez de ser cortada pela margem do canvas.
    const acimaDoTanque = y > LABEL_FLIP_Y;
    this.label.position.set(x, y + (acimaDoTanque ? -PLAQUETA_DIST : PLAQUETA_DIST));

    if (aliveNow && !this.alive && !this.dying) this.revive();
    this.alive = aliveNow;
  }

  /** Chamado pelo Renderer ao detectar a transição vivo→morto entre dois sync(). */
  startDeathSequence(): void {
    if (this.dying) return;
    this.dying = true;
    this.deathFlashFrames = DEATH_FLASH_FRAMES;
    this.flashOverlay.visible = true;
  }

  private revive(): void {
    this.dying = false;
    this.deathFlashFrames = 0;
    this.flashOverlay.visible = false;
    this.root.visible = true;
    this.shadow.visible = true;
    this.label.visible = true;
  }

  /** Avança o flash de morte 1 frame — chamado pelo ticker interno do Renderer. */
  tickDeathFlash(): void {
    if (this.deathFlashFrames <= 0) return;
    this.deathFlashFrames--;
    if (this.deathFlashFrames === 0) {
      this.flashOverlay.visible = false;
      this.root.visible = false;
      this.shadow.visible = false;
      this.label.visible = false;
      // sequência de morte concluída — solta `dying` para que um próximo sync() vivo reviva o tanque.
      this.dying = false;
    }
  }

  recoilKick(): void {
    this.recoil = 1;
  }

  updateRecoil(dtSeconds: number): void {
    if (this.recoil <= 0) return;
    this.recoil = Math.max(0, this.recoil - dtSeconds * RECOIL_DECAY_PER_S);
    this.turretGfx.position.x = -3 * this.recoil;
  }

  get isDying(): boolean {
    return this.dying;
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.shadow.destroy();
    // A textura do emblema é COMPARTILHADA (cache por cor em render/animais.ts) — destruir a
    // plaqueta não pode levar junto o bitmap que os outros nove tanques ainda usam.
    this.label.destroy({ children: true, texture: false });
  }
}
