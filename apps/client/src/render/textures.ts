// Todas as texturas do jogo nascem aqui, geradas em <canvas> (gradientes/ruído) ou via
// Graphics + renderer.generateTexture (formas vetoriais simples). Nenhum arquivo de imagem
// externo é carregado — regra de arte 100% procedural do CLAUDE.md.

import { Graphics, Texture, type Renderer } from 'pixi.js';
import { hash2, valueNoise2D } from './noise.js';

export interface GameTextures {
  /** Halo/luz grande e suave — usado em luzes de tanque, lâmpadas e flashes. */
  light: Texture;
  /** Glow menor — muzzle flash e brilho de explosão. */
  glow: Texture;
  /** Ponto sólido pequeno — partículas (faísca, fumaça, fragmento) e poeira da bala. */
  dot: Texture;
  /** Sombra elíptica preta (blob shadow) sob tanques e destroços. */
  shadow: Texture;
  /** Queimadura discreta no chão onde um tanque morreu. Único decalque persistente além da esteira. */
  scorch: Texture;
  /** Par de tracinhos escuros — rastro de esteira do tanque. */
  track: Texture;
  /** Ruído tileável para o piso (TilingSprite, addressMode 'repeat'). */
  floor: Texture;
  /**
   * Clarão de ambiente: radial branco com queda longa e macia, bem mais suave que `light`.
   * É a fonte de luz implícita da arena — esticado sobre o mundo inteiro, tingido de quente e
   * somado ao piso, é o que dá um CENTRO à composição sem estourar o threshold do bloom.
   */
  ambient: Texture;
  /**
   * Moldura de vinheta: transparente no miolo, escurecendo só nos ~30% externos. Usada em blend
   * NORMAL (não multiply) e com alpha contido — a regra do projeto é que nenhum canto do
   * labirinto pode ficar ilegível, então isto é profundidade, não penumbra.
   */
  vignette: Texture;
  /**
   * Setor (fatia) de luz saindo de um ápice à esquerda — o farol do chassi. Ápice em (0, altura/2),
   * então o anchor (0, 0.5) o mantém preso à frente do tanque; girar o sprite gira o cone inteiro.
   */
  headlightCone: Texture;
}

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('textures: contexto 2D indisponível');
  return { canvas, ctx };
}

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, size: number) => void): Texture {
  const { canvas, ctx } = makeCanvas(size);
  draw(ctx, size);
  return Texture.from(canvas);
}

function radialTexture(size: number, stops: Array<[number, string]>): Texture {
  return canvasTexture(size, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    for (const [offset, color] of stops) g.addColorStop(offset, color);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

// Queimadura de morte: mancha de fuligem morna, borda irregular por manchinhas sobrepostas.
// Sem anel brilhante e sem raios radiais — o pedido do usuário é uma marca discreta, não uma
// cratera cenográfica. O tamanho final vem do scale aplicado em decals.stampScorch().
function makeScorchTexture(): Texture {
  return canvasTexture(96, (ctx, s) => {
    const c = s / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, 'rgba(26,20,17,0.62)');
    g.addColorStop(0.4, 'rgba(26,20,17,0.34)');
    g.addColorStop(0.75, 'rgba(26,20,17,0.1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + Math.random() * 0.5;
      const r = c * 0.24 + Math.random() * c * 0.24;
      ctx.beginPath();
      ctx.arc(c + Math.cos(a) * r, c + Math.sin(a) * r, 4 + Math.random() * 9, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(26,20,17,${(0.05 + Math.random() * 0.09).toFixed(3)})`;
      ctx.fill();
    }
  });
}

/**
 * Quantos texels da textura de piso cabem em UM pixel de mundo.
 *
 * A textura é gerada em 512 e desenhada com `tileScale = 1 / FLOOR_TEXEL_PER_WORLD`, então o
 * padrão continua exatamente do mesmo tamanho aparente — o que dobra é a densidade de detalhe.
 * Isso importa porque a Fase 9 fez a arena preencher a janela: em 3440×1440 a câmera amplia o
 * mundo ~2,1×, e um piso com 1 texel por pixel de mundo chegaria à tela borrado. Com 2 texels a
 * relação texel:pixel volta para ~1:1 justamente nas telas grandes.
 *
 * As frequências do ruído são relativas ao tamanho do canvas (`(x / S) * 4`), então gerar em 512
 * em vez de 256 dá o MESMO desenho com o dobro de amostras — não um desenho diferente.
 */
export const FLOOR_TEXEL_PER_WORLD = 2;

function makeFloorTexture(): Texture {
  const size = 256 * FLOOR_TEXEL_PER_WORLD;
  return canvasTexture(size, (ctx, S) => {
    const img = ctx.createImageData(S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const v =
          0.45 * valueNoise2D((x / S) * 4, (y / S) * 4, 4) +
          0.3 * valueNoise2D((x / S) * 8, (y / S) * 8, 8) +
          0.25 * valueNoise2D((x / S) * 32, (y / S) * 32, 32);
        // O grão é por TEXEL, então em 512 ele fica com metade do tamanho aparente de antes —
        // o que é exatamente o desejado: grão fino é o que sobrevive à ampliação da câmera.
        const grain = hash2(x * 7 + 1, y * 13 + 5);
        // Escovado horizontal: a senoide tem 48 ciclos inteiros no canvas, então continua
        // tileável, e o ruído por cima tira o ar de listra mecânica. É o que faz a chapa ler como
        // metal laminado em vez de plano de cor com granulado.
        const escovado =
          Math.sin((y / S) * Math.PI * 2 * 48) * (0.35 + 0.65 * valueNoise2D((x / S) * 8, (y / S) * 8, 8));
        // Amplitude alta de propósito: num mundo claro (sem lightmap escurecendo) a variação do
        // piso é o que impede a arena aberta de parecer chapada.
        let val = 236 + (v - 0.5) * 92 + (grain - 0.5) * 30 + escovado * 5;
        val = Math.min(255, Math.max(140, val));
        const i = (y * S + x) * 4;
        // Viés frio nos canais quentes: o multiply com o tint da ardósia sai azulado de verdade
        // em vez de virar cinza de concreto quando o ruído clareia.
        d[i] = Math.round(val * 0.93);
        d[i + 1] = Math.round(val * 0.97);
        d[i + 2] = Math.round(Math.min(255, val + 2));
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
}

/**
 * Vinheta em moldura: 60% centrais completamente limpos, escurecimento só no anel externo.
 *
 * O canvas é gerado por pixel (e não com createRadialGradient) para a curva poder ser uma
 * potência — `t^2.2` sobe devagar e só fecha perto da borda, que é a diferença entre
 * "profundidade" e "penumbra". A regra do projeto proíbe esconder canto de labirinto, então o topo
 * da curva fica em 0,80 de alpha e ainda passa por um `alpha` de sprite menor que 1 em maze.ts —
 * o efeito medido nos blocos de borda é ~0,30 de luminância, o dobro do piso mínimo aceitável.
 */
function makeVignetteTexture(): Texture {
  return canvasTexture(256, (ctx, S) => {
    const img = ctx.createImageData(S, S);
    const d = img.data;
    const c = (S - 1) / 2;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const r = Math.hypot((x - c) / c, (y - c) / c);
        const t = Math.min(1, Math.max(0, (r - 0.45) / 0.62));
        const i = (y * S + x) * 4;
        d[i] = 255;
        d[i + 1] = 255;
        d[i + 2] = 255;
        d[i + 3] = Math.round(Math.pow(t, 2.2) * 0.8 * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  });
}

// Abertura do cone de UM farol — mantida em radianos aqui porque é o único lugar que desenha o
// setor; tank.ts só escala e gira o sprite resultante, nunca recalcula o ângulo.
//
// Fase 12: caiu de 27° para 20°. Antes era um cone só, no eixo do chassi, e precisava ser largo
// para cobrir a frente inteira. Agora são dois, um por farol, e a cobertura vem do CRUZAMENTO
// deles à frente do tanque — cone largo demais apagaria justamente o desenho de dois feixes.
export const HEADLIGHT_HALF_ANGLE = (20 * Math.PI) / 180;

// Farol do chassi: um setor (fatia de pizza) com o ápice na borda esquerda do canvas, gradiente
// linear ao longo do eixo do cone (branco no ápice, transparente no arco distante). tank.ts tinge
// esse branco com a cor do jogador via `sprite.tint` — uma única textura serve os 10 jogadores
// e os dois faróis de cada um.
function makeHeadlightConeTexture(): Texture {
  const width = 220;
  const height = 240;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('textures: contexto 2D indisponível');

  const apexX = 0;
  const apexY = height / 2;
  const radius = width;

  ctx.beginPath();
  ctx.moveTo(apexX, apexY);
  ctx.arc(apexX, apexY, radius, -HEADLIGHT_HALF_ANGLE, HEADLIGHT_HALF_ANGLE);
  ctx.closePath();

  const gradient = ctx.createLinearGradient(apexX, apexY, apexX + radius, apexY);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.4)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fill();

  return Texture.from(canvas);
}

function generateFromGraphics(renderer: Renderer, draw: (g: Graphics) => void): Texture {
  const g = new Graphics();
  draw(g);
  const texture = renderer.generateTexture(g);
  g.destroy();
  return texture;
}

export function createTextures(renderer: Renderer): GameTextures {
  const light = radialTexture(256, [
    [0, 'rgba(255,255,255,1)'],
    [0.3, 'rgba(255,255,255,0.85)'],
    [0.55, 'rgba(255,255,255,0.45)'],
    [0.8, 'rgba(255,255,255,0.12)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  const glow = radialTexture(64, [
    [0, 'rgba(255,255,255,1)'],
    [0.3, 'rgba(255,255,255,0.55)'],
    [0.7, 'rgba(255,255,255,0.1)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  const dot = radialTexture(32, [
    [0, 'rgba(255,255,255,1)'],
    [0.45, 'rgba(255,255,255,0.9)'],
    [0.6, 'rgba(255,255,255,0.35)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  const shadow = radialTexture(64, [
    [0, 'rgba(0,0,0,1)'],
    [0.5, 'rgba(0,0,0,0.85)'],
    [1, 'rgba(0,0,0,0)'],
  ]);
  // Queda muito mais longa que a de `light`: esticado sobre a arena inteira, um halo com platô no
  // meio viraria um disco visível. Estes stops fazem o clarão morrer devagar do começo ao fim.
  const ambient = radialTexture(256, [
    [0, 'rgba(255,255,255,1)'],
    [0.25, 'rgba(255,255,255,0.72)'],
    [0.5, 'rgba(255,255,255,0.38)'],
    [0.75, 'rgba(255,255,255,0.13)'],
    [1, 'rgba(255,255,255,0)'],
  ]);

  const track = generateFromGraphics(renderer, (g) => {
    g.roundRect(0, 0, 4.5, 7, 1).fill(0x000000).roundRect(0, 21, 4.5, 7, 1).fill(0x000000);
  });

  return {
    light,
    glow,
    dot,
    shadow,
    scorch: makeScorchTexture(),
    track,
    floor: makeFloorTexture(),
    ambient,
    vignette: makeVignetteTexture(),
    headlightCone: makeHeadlightConeTexture(),
  };
}
