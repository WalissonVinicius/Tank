// Desenha o piso (TilingSprite com ruído + variação por hash de célula) e as paredes
// (corpo + topo 1px + sombra enviesada) do labirinto. Só redesenha quando setMaze() é chamado —
// nunca por frame.

import { Container, Graphics, TilingSprite } from 'pixi.js';
import type { Aabb, Maze } from '@tank/shared-sim';
import { hash2 } from './noise.js';
import { FLOOR_TEXEL_PER_WORLD, type GameTextures } from './textures.js';

// Paleta do mundo CLARO. Não existe mais lightmap multiplicativo escurecendo a cena, então estas
// cores são exatamente o que aparece na tela — não são albedos "pré-luz". Os hex de
// WORLD_COLORS.floor/wall descreviam um mundo dominado pela sombra e foram deliberadamente
// reinterpretados aqui (mesma família azul-aço, luminância muito mais alta) para que o labirinto
// leia de canto a canto e os tanques escuros se destaquem contra o piso.
//
// Piso: ardósia azulada com saturação de verdade, não o cinza de concreto de estacionamento. O
// multiply do tint com a textura fria cai em ~0x536297 (luminância ~0,39, dentro da faixa
// 0,35–0,55) com quase o dobro do croma do tom anterior.
const FLOOR_TINT = 0x5f6da2;
const FLOOR_GROOVE_DARK = 0x2c3455;
const FLOOR_GROOVE_LIGHT = 0x93a1d0;
// Variação por célula em cor (mais fria / mais clara), não em preto e branco: é o que dá
// caráter ao chão sem sujá-lo nem mexer na luminância média.
const FLOOR_CELL_COOL = 0x2f3b6b;
const FLOOR_CELL_WARM = 0xb3bee0;
const WALL_FILL = 0x99a3c0;
const WALL_TOP_HI = 0xdde5f7;
const WALL_EDGE_DARK = 0x2b3557;
const WALL_RIVET = 0x6a769e;
const SHADOW_SKEW_X = -0.035;
const SHADOW_OFFSET = { x: 5, y: 8 };

function pointInAnyWall(walls: readonly Aabb[], px: number, py: number): boolean {
  for (const w of walls) {
    if (px >= w.x && px <= w.x + w.w && py >= w.y && py <= w.y + w.h) return true;
  }
  return false;
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
  private readonly wallShadow = new Graphics();
  private readonly wallGraphics = new Graphics();

  constructor(textures: GameTextures) {
    this.textures = textures;
    this.floorLayer.addChild(this.plates);
    this.wallShadowLayer.addChild(this.wallShadow);
    this.wallShadowLayer.alpha = 0.27;
    this.wallShadowLayer.skew.set(SHADOW_SKEW_X, 0);
    this.wallLayer.addChild(this.wallGraphics);
  }

  setMaze(maze: Maze): void {
    this.worldWidth = maze.cols * maze.cell;
    this.worldHeight = maze.rows * maze.cell;

    this.drawFloor(maze);
    this.drawWalls(maze);

    this.wallShadowLayer.pivot.set(this.worldWidth / 2, this.worldHeight / 2);
    this.wallShadowLayer.position.set(
      this.worldWidth / 2 + SHADOW_OFFSET.x,
      this.worldHeight / 2 + SHADOW_OFFSET.y,
    );
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

    // Variação por célula: numa arena aberta (braiding 65%) sobra muito chão à vista, e chapas
    // levemente mais claras/escuras impedem que ele leia como uma superfície lisa só de ruído.
    for (let x = 0; x < maze.cols; x++) {
      for (let y = 0; y < maze.rows; y++) {
        const h = hash2(x * 3 + 11, y * 5 + 7);
        const shade =
          h < 0.36 ? { color: FLOOR_CELL_COOL, alpha: 0.13 } : h > 0.68 ? { color: FLOOR_CELL_WARM, alpha: 0.11 } : null;
        if (shade) plates.rect(x * maze.cell + 1, y * maze.cell + 1, maze.cell - 2, maze.cell - 2).fill(shade);
      }
    }

    // Junta entre chapas: sulco escuro + fio de luz logo abaixo (relevo raso de placa metálica).
    // O fio claro é discreto de propósito — em alpha alto a grade lia como rejunte de azulejo e
    // devolvia ao piso a cara de piscina/estacionamento que o usuário reclamou.
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
  }

  private drawWalls(maze: Maze): void {
    const walls = maze.walls;
    this.wallShadow.clear();
    this.wallGraphics.clear();

    for (const w of walls) this.wallShadow.rect(w.x, w.y, w.w, w.h).fill(0x000000);

    // Contorno escuro contínuo por baixo: é ele que separa a parede clara do piso claro. Sem
    // isso, num mundo sem sombra global, o labirinto se dissolve no chão.
    for (const w of walls) {
      this.wallGraphics.rect(w.x - 1.5, w.y - 1.5, w.w + 3, w.h + 3).fill({ color: WALL_EDGE_DARK, alpha: 0.9 });
    }
    for (const w of walls) {
      this.wallGraphics.rect(w.x, w.y, w.w, w.h).fill(WALL_FILL);
    }
    for (const w of walls) {
      this.wallGraphics
        .moveTo(w.x + 0.5, w.y + 0.5)
        .lineTo(w.x + w.w - 0.5, w.y + 0.5)
        .stroke({ width: 1.5, color: WALL_TOP_HI, alpha: 1 });
      this.wallGraphics
        .moveTo(w.x + 0.5, w.y + 0.5)
        .lineTo(w.x + 0.5, w.y + w.h - 0.5)
        .stroke({ width: 1, color: WALL_TOP_HI, alpha: 0.75 });
      this.wallGraphics
        .moveTo(w.x + 0.5, w.y + w.h - 0.5)
        .lineTo(w.x + w.w - 0.5, w.y + w.h - 0.5)
        .stroke({ width: 1.5, color: WALL_EDGE_DARK, alpha: 0.85 });
      this.wallGraphics
        .moveTo(w.x + w.w - 0.5, w.y + 0.5)
        .lineTo(w.x + w.w - 0.5, w.y + w.h - 0.5)
        .stroke({ width: 1.5, color: WALL_EDGE_DARK, alpha: 0.7 });
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
        this.wallGraphics.circle(px - 0.6, py - 0.6, 0.9).fill({ color: WALL_TOP_HI, alpha: 0.95 });
      }
    }
  }
}
