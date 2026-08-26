// Identidade visual da arena (V1): piso composto (TilingSprite + placas + sujeira + vinheta +
// clarão de ambiente) e paredes EXTRUDADAS — blocos com face lateral visível, não barras
// desenhadas no chão. Tudo é construído em setMaze(), uma vez por rodada; o único trabalho por
// frame é a poeira à deriva e a pulsação da luz, ambos presos ao `onRender` da camada de paredes.
//
// DIREÇÃO DE LUZ ÚNICA para a arena inteira: a fonte fica ao norte-noroeste. Disso decorre tudo —
// a face lateral dos blocos aparece a sudeste (EXTRUSAO), a sombra projetada sai na mesma direção
// e mais longe, o topo recebe fio de luz quente nas arestas norte/oeste e aresta escura nas
// arestas sul/leste. Nada disso é glow: parede não emite luz, parede reflete.

import { Container, Graphics, Particle, ParticleContainer, Rectangle, Sprite, TilingSprite } from 'pixi.js';
import type { Aabb, Maze } from '@tank/shared-sim';
import { mixColor, warm } from './color.js';
import { hash2, valueNoise2D } from './noise.js';
import { FLOOR_TEXEL_PER_WORLD, type GameTextures } from './textures.js';

// Paleta do mundo CLARO. Não existe lightmap multiplicativo escurecendo a cena, então estas cores
// são exatamente o que aparece na tela — não são albedos "pré-luz". A regra que não se negocia é
// que nenhum canto do labirinto pode ficar ilegível: sombra aqui é volume, nunca penumbra.
//
// Piso: ardósia azulada com saturação de verdade, não o cinza de concreto de estacionamento.
const FLOOR_TINT = 0x5f6da2;
const FLOOR_GROOVE_DARK = 0x2c3455;
const FLOOR_GROOVE_LIGHT = 0x93a1d0;
// Regiões do piso: a variação de valor deixou de ser sal-e-pimenta por célula e passou a seguir um
// ruído de baixa frequência em coordenadas de MUNDO (não da textura, que é ladrilhada a cada 256 px
// e denunciaria a repetição). São manchas largas de luz e de sombra — é o que dá ao jogador um
// mapa mental do lugar e o que permite se localizar de relance.
const FLOOR_REGIAO_CLARA = 0xd6def5;
const FLOOR_REGIAO_ESCURA = 0x232c52;
const FLOOR_SUJEIRA = 0x1d2138;

// Parede: o topo é a única face que recebe a luz de cima, então é a mais clara; as faces laterais
// caem forte e esfriam. É esse degrau de valor — e não contorno — que faz o bloco ter altura.
const WALL_TOP_A = 0x8793ba;
const WALL_TOP_B = 0xa6b1d6;
const WALL_TOP_HI = 0xf2f6ff;
const WALL_FACE_LESTE = 0x4a5478;
const WALL_FACE_SUL = 0x353d61;
const WALL_EDGE_DARK = 0x1c2340;
const WALL_JUNTA = 0x2a3255;
const WALL_RIVET = 0x8b96bb;

/**
 * Deslocamento da face lateral, em pixels de mundo. Mais vertical que horizontal de propósito: em
 * projeção oblíqua vista de cima é a componente Y que o olho lê como ALTURA.
 *
 * Fica deliberadamente modesto (a parede tem ~10 px de espessura e o corredor ~74 px): o AABB de
 * colisão continua sendo o TOPO, e o topo é o que tem contorno nítido, então o jogador continua
 * lendo onde a parede realmente está.
 */
const EXTRUSAO = { x: 4, y: 7 };
/** A sombra projetada sai na mesma direção do bloco, e mais longe — senão fica escondida sob ele. */
const SHADOW_SKEW_X = -0.035;
const SHADOW_OFFSET = { x: 9, y: 14 };
const SHADOW_ALPHA = 0.22;

/** Posição da fonte de luz implícita, em fração do mundo (norte-noroeste do centro). */
const FOCO_LUZ = { x: 0.4, y: 0.3 };
const LUZ_AMBIENTE_ALPHA = 0.12;
/** Pulsação da luz de ambiente: ±10% num ciclo de ~9,5 s. Se der para PERCEBER, está forte demais. */
const LUZ_AMBIENTE_PULSO = 0.1;
const LUZ_AMBIENTE_PERIODO = 0.66;
const VINHETA_ALPHA = 0.58;
const VINHETA_COR = 0x0c1226;

/**
 * Luminárias industriais: poças de luz quente projetadas no piso, numa grade esparsa. São o
 * elemento que transforma "um plano azul" em "um galpão" — dão ritmo, dão ao jogador pontos de
 * referência para se localizar de relance e são a razão física do contraste quente × frio.
 *
 * São ADITIVAS, então só clareiam: nenhuma parte do labirinto fica mais escura por causa delas.
 * E são sprites estáticos criados em setMaze() — custo por frame zero.
 */
const LUMINARIA_PASSO = { x: 4, y: 3 };
const LUMINARIA_ALPHA = 0.24;
const LUMINARIA_RAIO_CELULAS = 2.6;
const LUMINARIA_COR = 0xffa32e;
/** Amplitude da respiração de cada lâmpada. Acima de ~0,1 vira pisca-pisca e distrai. */
const LUMINARIA_PULSO = 0.07;

/** Poeira em suspensão: o único movimento da cena entre um tiro e outro. */
const POEIRA_N = 56;
const POEIRA_COR = 0xffe2bd;
const POEIRA_DERIVA = { x: 9, y: 4 };

interface Poeira {
  particula: Particle;
  fase: number;
  giro: number;
  balanco: number;
}

function pointInAnyWall(walls: readonly Aabb[], px: number, py: number): boolean {
  for (const w of walls) {
    if (px >= w.x && px <= w.x + w.w && py >= w.y && py <= w.y + w.h) return true;
  }
  return false;
}

/**
 * Silhueta do bloco extrudado: soma de Minkowski do retângulo com o vetor de extrusão, ou seja, o
 * hexágono que cobre o topo, a face leste e a face sul de uma vez. Convexo por construção enquanto
 * dx e dy forem positivos.
 */
function silhueta(x: number, y: number, w: number, h: number, dx: number, dy: number): number[] {
  return [x, y, x + w, y, x + w + dx, y + dy, x + w + dx, y + h + dy, x + dx, y + h + dy, x, y + h];
}

export class MazeView {
  readonly floorLayer = new Container();
  readonly wallShadowLayer = new Container();
  readonly wallLayer = new Container();

  worldWidth = 0;
  worldHeight = 0;

  private readonly textures: GameTextures;
  private floorSprite: TilingSprite | null = null;
  private readonly plates = new Graphics();
  private readonly vinheta: Sprite;
  private readonly luzAmbiente: Sprite;
  private readonly luminarias = new Container();
  private readonly wallShadow = new Graphics();
  private readonly wallGraphics = new Graphics();
  private readonly poeiraContainer: ParticleContainer;
  private readonly poeira: Poeira[] = [];
  private readonly luzes: Array<{ sprite: Sprite; base: number; fase: number }> = [];
  private pontosDeLuz: Array<{ x: number; y: number; brilho: number }> = [];
  private tempo = 0;
  private ultimoQuadroMs = 0;

  constructor(textures: GameTextures) {
    this.textures = textures;
    this.floorLayer.addChild(this.plates);

    // Vinheta em blend NORMAL sobre o piso (nunca sobre as paredes, que precisam continuar
    // legíveis de canto a canto): é só um afastamento de valor nas bordas, para o olho parar no
    // meio da arena em vez de escorregar para fora dela.
    this.vinheta = new Sprite(textures.vignette);
    this.vinheta.anchor.set(0.5);
    this.vinheta.tint = VINHETA_COR;
    this.vinheta.alpha = VINHETA_ALPHA;
    this.floorLayer.addChild(this.vinheta);

    // O clarão de ambiente é ADITIVO e quente: ele CLAREIA a arena, e é dele que sai a resposta
    // para "de onde vem a luz". Sendo aditivo e de valor baixo, não chega perto do threshold 0.88
    // do bloom — não vira halo, vira iluminação.
    this.luzAmbiente = new Sprite(textures.ambient);
    this.luzAmbiente.anchor.set(0.5);
    this.luzAmbiente.tint = 0xffb347;
    this.luzAmbiente.blendMode = 'add';
    this.luzAmbiente.alpha = LUZ_AMBIENTE_ALPHA;
    this.floorLayer.addChild(this.luzAmbiente);
    this.floorLayer.addChild(this.luminarias);

    this.wallShadowLayer.addChild(this.wallShadow);
    this.wallShadowLayer.alpha = SHADOW_ALPHA;
    this.wallShadowLayer.skew.set(SHADOW_SKEW_X, 0);
    this.wallLayer.addChild(this.wallGraphics);

    this.poeiraContainer = new ParticleContainer({ dynamicProperties: { position: true, color: true } });
    this.poeiraContainer.blendMode = 'add';
    this.wallLayer.addChild(this.poeiraContainer);
    this.criarPoeira();

    // `onRender` do PixiJS v8: roda uma vez por frame, dentro do render que já ia acontecer, sem
    // um segundo laço de requestAnimationFrame. É o único jeito de dar vida ambiente à arena sem
    // encostar no Renderer, que pertence a outra parte do código.
    this.ultimoQuadroMs = performance.now();
    this.wallLayer.onRender = () => this.animarAmbiente();
  }

  setMaze(maze: Maze): void {
    this.worldWidth = maze.cols * maze.cell;
    this.worldHeight = maze.rows * maze.cell;

    this.pontosDeLuz = this.posicoesLuminarias(maze);
    this.drawFloor(maze);
    this.drawWalls(maze);
    this.posicionarLuzes();
    this.drawLuminarias(maze);
    this.espalharPoeira();

    this.wallShadowLayer.pivot.set(this.worldWidth / 2, this.worldHeight / 2);
    this.wallShadowLayer.position.set(
      this.worldWidth / 2 + SHADOW_OFFSET.x,
      this.worldHeight / 2 + SHADOW_OFFSET.y,
    );
  }

  private posicionarLuzes(): void {
    this.vinheta.position.set(this.worldWidth / 2, this.worldHeight / 2);
    this.vinheta.setSize(this.worldWidth * 1.04, this.worldHeight * 1.04);

    // O clarão tem que ser bem maior que a arena: é a queda longa dele que lê como iluminação
    // de ambiente. Um halo do tamanho do mundo leria como mancha.
    const raio = Math.max(this.worldWidth, this.worldHeight) * 1.15;
    this.luzAmbiente.position.set(this.worldWidth * FOCO_LUZ.x, this.worldHeight * FOCO_LUZ.y);
    this.luzAmbiente.setSize(raio, raio);
  }

  /**
   * Onde ficam as lâmpadas do galpão. Calculado ANTES das paredes porque é dele que sai o "calor"
   * de cada parede: o topo de um bloco que está sob uma lâmpada tem que refletir a mesma luz que
   * a poça no chão embaixo dele, senão a iluminação não fecha e a cena vira colagem.
   */
  private posicoesLuminarias(maze: Maze): Array<{ x: number; y: number; brilho: number }> {
    const pontos: Array<{ x: number; y: number; brilho: number }> = [];
    for (let x = LUMINARIA_PASSO.x / 2; x < maze.cols; x += LUMINARIA_PASSO.x) {
      for (let y = LUMINARIA_PASSO.y / 2; y < maze.rows; y += LUMINARIA_PASSO.y) {
        pontos.push({
          x: x * maze.cell + maze.cell / 2,
          y: y * maze.cell + maze.cell / 2,
          // Cada lâmpada envelheceu de um jeito: a variação por hash impede que a grade de luzes
          // leia como padrão de papel de parede.
          brilho: 0.74 + hash2(Math.round(x), Math.round(y)) * 0.38,
        });
      }
    }
    return pontos;
  }

  private drawLuminarias(maze: Maze): void {
    this.luminarias.removeChildren().forEach((filho) => filho.destroy());
    this.luzes.length = 0;
    const raio = maze.cell * LUMINARIA_RAIO_CELULAS;
    for (const ponto of this.pontosDeLuz) {
      const fase = hash2(Math.round(ponto.x), Math.round(ponto.y)) * 6.28;
      // Duas camadas por lâmpada: o halo largo (a queda) e um segundo halo bem menor (o miolo). Só
      // o halo grande lia como névoa; é o miolo que dá à poça um CENTRO e a faz parecer luz
      // projetada. Os dois usam a MESMA textura de queda longa — a de `light` tem platô no meio e
      // transformava a poça num sol branco que roubava o olho dos tanques.
      const halo = new Sprite(this.textures.ambient);
      halo.anchor.set(0.5);
      halo.blendMode = 'add';
      halo.tint = LUMINARIA_COR;
      halo.alpha = LUMINARIA_ALPHA * ponto.brilho;
      halo.position.set(ponto.x, ponto.y);
      halo.setSize(raio, raio);
      this.luminarias.addChild(halo);

      const nucleo = new Sprite(this.textures.ambient);
      nucleo.anchor.set(0.5);
      nucleo.blendMode = 'add';
      nucleo.tint = LUMINARIA_COR;
      nucleo.alpha = LUMINARIA_ALPHA * ponto.brilho * 0.3;
      nucleo.position.set(ponto.x, ponto.y);
      nucleo.setSize(raio * 0.5, raio * 0.5);
      this.luminarias.addChild(nucleo);

      // Reator velho de lâmpada de galpão: cada uma respira no seu ritmo, fora de fase das outras.
      // Junto isso vira uma cena que nunca fica parada; sozinha, nenhuma delas chama atenção.
      this.luzes.push({ sprite: halo, base: halo.alpha, fase });
      this.luzes.push({ sprite: nucleo, base: nucleo.alpha, fase });
    }
  }

  private drawFloor(maze: Maze): void {
    const margin = maze.cell * 0.12;
    this.floorSprite?.destroy();
    this.floorSprite = new TilingSprite({
      texture: this.textures.floor,
      width: this.worldWidth + margin,
      height: this.worldHeight + margin,
    });
    this.floorSprite.position.set(-margin / 2, -margin / 2);
    // A textura tem mais texels que pixels de mundo (ver FLOOR_TEXEL_PER_WORLD): encolher o
    // ladrilho na mesma proporção devolve o padrão ao tamanho aparente de sempre e o detalhe
    // extra vira nitidez quando a câmera amplia numa tela grande.
    this.floorSprite.tileScale.set(1 / FLOOR_TEXEL_PER_WORLD);
    this.floorSprite.tint = FLOOR_TINT;
    this.floorLayer.addChildAt(this.floorSprite, 0);

    const plates = this.plates;
    plates.clear();

    // Placas: o tom de cada uma vem de um ruído SUAVE (manchas largas) somado a um empurrão por
    // hash da própria célula. Sem o ruído, o chão vira ruído branco de células; sem o hash, vira
    // um degradê liso demais para servir de referência espacial.
    for (let x = 0; x < maze.cols; x++) {
      for (let y = 0; y < maze.rows; y++) {
        const regiao = valueNoise2D(x * 0.36, y * 0.36, 97);
        const jitter = (hash2(x * 3 + 11, y * 5 + 7) - 0.5) * 0.34;
        const t = Math.min(1, Math.max(0, regiao + jitter));
        // t=0.5 é o piso puro; para os extremos entra a mancha clara ou a escura.
        const desvio = t - 0.5;
        if (Math.abs(desvio) < 0.06) continue;
        const cor = desvio > 0 ? FLOOR_REGIAO_CLARA : FLOOR_REGIAO_ESCURA;
        const alpha = Math.min(0.28, (Math.abs(desvio) - 0.06) * 0.72);
        plates.rect(x * maze.cell + 1, y * maze.cell + 1, maze.cell - 2, maze.cell - 2).fill({ color: cor, alpha });
      }
    }

    // Junta entre chapas: sulco escuro + fio de luz logo abaixo (relevo raso de placa metálica).
    // O fio claro é discreto de propósito — em alpha alto a grade lia como rejunte de azulejo.
    for (let x = 0; x <= maze.cols; x++) {
      const px = x * maze.cell;
      plates.moveTo(px, 0).lineTo(px, this.worldHeight).stroke({ width: 1, color: FLOOR_GROOVE_DARK, alpha: 0.55 });
      plates.moveTo(px + 1, 0).lineTo(px + 1, this.worldHeight).stroke({ width: 1, color: FLOOR_GROOVE_LIGHT, alpha: 0.26 });
    }
    for (let y = 0; y <= maze.rows; y++) {
      const py = y * maze.cell;
      plates.moveTo(0, py).lineTo(this.worldWidth, py).stroke({ width: 1, color: FLOOR_GROOVE_DARK, alpha: 0.55 });
      plates.moveTo(0, py + 1).lineTo(this.worldWidth, py + 1).stroke({ width: 1, color: FLOOR_GROOVE_LIGHT, alpha: 0.26 });
    }

    for (let x = 0; x < maze.cols; x++) {
      for (let y = 0; y < maze.rows; y++) {
        const cx = x * maze.cell;
        const cy = y * maze.cell;
        const corners: Array<[number, number]> = [
          [7, 7],
          [maze.cell - 7, 7],
          [7, maze.cell - 7],
          [maze.cell - 7, maze.cell - 7],
        ];
        for (const [dx, dy] of corners) {
          plates.circle(cx + dx, cy + dy, 1.6).fill({ color: FLOOR_GROOVE_DARK, alpha: 0.55 });
          plates.circle(cx + dx - 0.5, cy + dy - 0.6, 1).fill({ color: 0xffffff, alpha: 0.3 });
        }
        // Único acento por célula: um quadro raso gravado na chapa. As hachuras amarelas
        // diagonais saíram — sujavam o piso e o usuário reclamou disso três vezes.
        if (hash2(x, y) < 0.18) {
          plates
            .rect(cx + 14, cy + 14, maze.cell - 28, maze.cell - 28)
            .stroke({ width: 1, color: FLOOR_GROOVE_DARK, alpha: 0.3 });
        }
      }
    }

    this.drawSujeira(maze);
  }

  /**
   * Sujeira acumulada: um rodapé de poeira rente ao pé NORTE e OESTE de cada parede, que são
   * justamente os lados onde a sombra projetada NÃO cai. Sem isso o bloco parece flutuar de um
   * lado e assentado do outro. Mais algumas manchas soltas por célula, escolhidas por hash, para o
   * chão não ficar limpo demais para um lugar onde tanques brigam.
   */
  private drawSujeira(maze: Maze): void {
    const plates = this.plates;
    for (const w of maze.walls) {
      plates.rect(w.x - 3.5, w.y - 3.5, w.w + 7, 3.5).fill({ color: FLOOR_SUJEIRA, alpha: 0.13 });
      plates.rect(w.x - 3.5, w.y, 3.5, w.h).fill({ color: FLOOR_SUJEIRA, alpha: 0.13 });
    }

    for (let x = 0; x < maze.cols; x++) {
      for (let y = 0; y < maze.rows; y++) {
        const h = hash2(x * 17 + 3, y * 29 + 13);
        if (h > 0.22) continue;
        const cx = x * maze.cell + maze.cell * (0.2 + h * 2.6);
        const cy = y * maze.cell + maze.cell * (0.2 + hash2(y * 7, x * 11) * 0.6);
        for (let i = 0; i < 5; i++) {
          const a = hash2(x * 31 + i, y * 37 + i) * Math.PI * 2;
          const r = maze.cell * (0.08 + hash2(i, x + y) * 0.14);
          plates
            .circle(cx + Math.cos(a) * r, cy + Math.sin(a) * r, maze.cell * (0.07 + hash2(i * 5, x * y) * 0.1))
            .fill({ color: FLOOR_SUJEIRA, alpha: 0.05 });
        }
      }
    }
  }

  /**
   * Quanto de luz quente chega a um ponto do mundo: o clarão de ambiente (que varia devagar por
   * toda a arena) somado à lâmpada mais próxima. Roda por parede dentro de setMaze(), nunca por
   * frame — o custo é ~100 paredes × 15 lâmpadas, uma vez por rodada.
   */
  private calorEm(x: number, y: number, alcance: number, focoX: number, focoY: number): number {
    const ambiente = Math.max(0, 1 - Math.hypot(x - focoX, y - focoY) / alcance) * 0.45;
    let lampada = 0;
    for (const p of this.pontosDeLuz) {
      const d = Math.hypot(x - p.x, y - p.y) / (alcance * 0.28);
      if (d < 1) lampada = Math.max(lampada, (1 - d) * p.brilho);
    }
    return Math.min(1, ambiente + lampada);
  }

  private drawWalls(maze: Maze): void {
    const walls = maze.walls;
    const { x: ex, y: ey } = EXTRUSAO;
    const focoX = this.worldWidth * FOCO_LUZ.x;
    const focoY = this.worldHeight * FOCO_LUZ.y;
    const alcance = Math.hypot(this.worldWidth, this.worldHeight) * 0.62;
    this.wallShadow.clear();
    this.wallGraphics.clear();

    // Quem projeta sombra é o BLOCO inteiro, não o retângulo do topo — a silhueta extrudada.
    for (const w of walls) this.wallShadow.poly(silhueta(w.x, w.y, w.w, w.h, ex, ey)).fill(0x000000);

    // Contorno escuro contínuo por baixo. É preenchimento inflado, e não `stroke`, de propósito:
    // paredes longas são vários AABB encostados, e um traço por AABB deixaria costuras no meio de
    // uma parede reta. O fill do vizinho cobre o do lado e a linha sai contínua.
    for (const w of walls) {
      this.wallGraphics.poly(silhueta(w.x - 1.4, w.y - 1.4, w.w + 2.8, w.h + 2.8, ex, ey)).fill({
        color: WALL_EDGE_DARK,
        alpha: 0.92,
      });
    }
    // Faces laterais: sul (a mais escura, é a que mais foge da luz) e depois leste por cima dela.
    for (const w of walls) {
      this.wallGraphics.poly(silhueta(w.x, w.y, w.w, w.h, ex, ey)).fill(WALL_FACE_SUL);
    }
    for (const w of walls) {
      this.wallGraphics
        .poly([w.x + w.w, w.y, w.x + w.w + ex, w.y + ey, w.x + w.w + ex, w.y + w.h + ey, w.x + w.w, w.y + w.h])
        .fill(WALL_FACE_LESTE);
    }

    // Topo, na posição EXATA do AABB de colisão. O tom varia por parede (hash) para o labirinto
    // não ler como a mesma barra repetida, e esquenta conforme se aproxima de uma LÂMPADA — é o
    // que amarra a poça de luz no chão ao bloco em cima dela numa iluminação só.
    for (const w of walls) {
      const variacao = hash2(Math.round(w.x), Math.round(w.y));
      const base = mixColor(WALL_TOP_A, WALL_TOP_B, variacao);
      const calor = this.calorEm(w.x + w.w / 2, w.y + w.h / 2, alcance, focoX, focoY);
      this.wallGraphics.rect(w.x, w.y, w.w, w.h).fill(warm(base, 0.04 + 0.26 * calor));
    }

    // Biséis: fio quente nas arestas viradas para a luz (norte e oeste), aresta escura nas
    // opostas. É reflexo, não emissão — nada aqui usa blend aditivo.
    for (const w of walls) {
      const faixa = Math.min(3.2, Math.min(w.w, w.h) * 0.34);
      const calor = this.calorEm(w.x + w.w / 2, w.y + w.h / 2, alcance, focoX, focoY);
      const fio = warm(WALL_TOP_HI, 0.3 + 0.45 * calor);
      this.wallGraphics.rect(w.x, w.y, w.w, faixa).fill({ color: fio, alpha: 0.2 + 0.2 * calor });
      this.wallGraphics.rect(w.x, w.y, faixa, w.h).fill({ color: fio, alpha: 0.12 + 0.14 * calor });
      this.wallGraphics
        .moveTo(w.x, w.y + 0.5)
        .lineTo(w.x + w.w, w.y + 0.5)
        .stroke({ width: 1, color: fio, alpha: 0.95 });
      this.wallGraphics
        .moveTo(w.x + 0.5, w.y)
        .lineTo(w.x + 0.5, w.y + w.h)
        .stroke({ width: 1, color: fio, alpha: 0.7 });
      this.wallGraphics
        .moveTo(w.x, w.y + w.h - 0.5)
        .lineTo(w.x + w.w, w.y + w.h - 0.5)
        .stroke({ width: 1.2, color: WALL_EDGE_DARK, alpha: 0.9 });
      this.wallGraphics
        .moveTo(w.x + w.w - 0.5, w.y)
        .lineTo(w.x + w.w - 0.5, w.y + w.h)
        .stroke({ width: 1.2, color: WALL_EDGE_DARK, alpha: 0.75 });
    }

    // Juntas de módulo: cada parede longa vira uma fila de blocos pré-moldados encaixados em vez
    // de uma barra contínua. É o detalhe que tira a leitura de "maquete técnica".
    for (const w of walls) {
      const horizontal = w.w >= w.h;
      const comprimento = horizontal ? w.w : w.h;
      const modulos = Math.round(comprimento / 30);
      for (let i = 1; i < modulos; i++) {
        const t = (comprimento * i) / modulos;
        if (horizontal) {
          this.wallGraphics
            .moveTo(w.x + t, w.y + 1)
            .lineTo(w.x + t, w.y + w.h - 1)
            .stroke({ width: 1, color: WALL_JUNTA, alpha: 0.55 });
        } else {
          this.wallGraphics
            .moveTo(w.x + 1, w.y + t)
            .lineTo(w.x + w.w - 1, w.y + t)
            .stroke({ width: 1, color: WALL_JUNTA, alpha: 0.55 });
        }
      }
    }

    // rebites nas junções de grade que caem dentro de alguma parede
    for (let x = 0; x <= maze.cols; x++) {
      for (let y = 0; y <= maze.rows; y++) {
        const px = x * maze.cell;
        const py = y * maze.cell;
        if (!pointInAnyWall(walls, px, py)) continue;
        this.wallGraphics
          .circle(px, py, 2.2)
          .fill(WALL_RIVET)
          .stroke({ width: 1, color: WALL_EDGE_DARK, alpha: 0.8 });
        this.wallGraphics.circle(px - 0.6, py - 0.6, 0.9).fill({ color: warm(WALL_TOP_HI, 0.4), alpha: 0.95 });
      }
    }
  }

  private criarPoeira(): void {
    for (let i = 0; i < POEIRA_N; i++) {
      const escala = 0.05 + hash2(i, 91) * 0.09;
      const particula = new Particle({
        texture: this.textures.dot,
        x: 0,
        y: 0,
        anchorX: 0.5,
        anchorY: 0.5,
        scaleX: escala,
        scaleY: escala,
        tint: POEIRA_COR,
        alpha: 0.08 + hash2(i, 17) * 0.12,
      });
      this.poeiraContainer.addParticle(particula);
      this.poeira.push({
        particula,
        fase: hash2(i, 43) * Math.PI * 2,
        giro: 0.35 + hash2(i, 61) * 0.5,
        balanco: 3 + hash2(i, 73) * 6,
      });
    }
  }

  private espalharPoeira(): void {
    this.poeiraContainer.boundsArea = new Rectangle(-80, -80, this.worldWidth + 160, this.worldHeight + 160);
    for (let i = 0; i < this.poeira.length; i++) {
      const p = this.poeira[i]!;
      p.particula.x = hash2(i * 13 + 5, 29) * this.worldWidth;
      p.particula.y = hash2(i * 19 + 7, 53) * this.worldHeight;
    }
  }

  /**
   * O único trabalho por frame desta parte: 56 partículas de poeira e um alpha de sprite. Roda
   * dentro do render que já ia acontecer (`onRender`), sem laço próprio nem alocação.
   */
  private animarAmbiente(): void {
    const agora = performance.now();
    // Trava de 50 ms: quando a aba volta de segundo plano o delta seria de segundos e a poeira
    // daria um salto visível.
    const dt = Math.min(0.05, Math.max(0, (agora - this.ultimoQuadroMs) / 1000));
    this.ultimoQuadroMs = agora;
    this.tempo += dt;

    this.luzAmbiente.alpha =
      LUZ_AMBIENTE_ALPHA * (1 - LUZ_AMBIENTE_PULSO + LUZ_AMBIENTE_PULSO * Math.sin(this.tempo * LUZ_AMBIENTE_PERIODO));
    for (let i = 0; i < this.luzes.length; i++) {
      const l = this.luzes[i]!;
      l.sprite.alpha = l.base * (1 + LUMINARIA_PULSO * Math.sin(this.tempo * 0.9 + l.fase));
    }

    if (this.worldWidth <= 0) return;
    const limiteX = this.worldWidth + 60;
    const limiteY = this.worldHeight + 60;
    for (let i = 0; i < this.poeira.length; i++) {
      const p = this.poeira[i]!;
      const fase = this.tempo * p.giro + p.fase;
      let x = p.particula.x + (POEIRA_DERIVA.x + Math.cos(fase) * p.balanco) * dt;
      let y = p.particula.y + (POEIRA_DERIVA.y + Math.sin(fase * 1.3) * p.balanco) * dt;
      if (x > limiteX) x -= limiteX + 60;
      else if (x < -60) x += limiteX + 60;
      if (y > limiteY) y -= limiteY + 60;
      else if (y < -60) y += limiteY + 60;
      p.particula.x = x;
      p.particula.y = y;
    }
  }
}
