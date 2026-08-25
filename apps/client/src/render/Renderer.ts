// Orquestra todas as camadas visuais do jogo. Dono do PIXI.Application — nenhum outro módulo
// cria a aplicação. sync() é chamado 1× por frame por main.ts com o estado já interpolado;
// internamente o Renderer roda seu próprio ticker para efeitos contínuos (partículas, luzes,
// screen shake, pós-processamento) que não dependem do ritmo da simulação.

import { Application, Container, Graphics, Sprite } from 'pixi.js';
import type { Filter } from 'pixi.js';
import type { Maze, Vec2 } from '@tank/shared-sim';
import { COUNTDOWN, WORLD_COLORS } from '@tank/protocol';

import { aplicarEscalaHud, aspectoDaArena, reservasDoJogo, type Reservas } from '../ui/layout.js';
import { createTextures, type GameTextures } from './textures.js';
import { MazeView } from './maze.js';
import { TankView } from './tank.js';
import { BulletPool } from './bullet.js';
import { LightFx } from './lights.js';
import { DecalLayer } from './decals.js';
import { ParticleSystem } from './particles.js';
import { JuiceController } from './juice.js';
import { PostFX, qualidadePara, type NivelFx } from './post.js';

export interface RenderTank {
  id: string;
  x: number;
  y: number;
  angle: number;
  turret: number;
  color: number;
  alive: boolean;
  name: string;
}

export interface RenderBullet {
  x: number;
  y: number;
  /** Cor do dono do tiro. Opcional: sem ela a bala cai num branco quente neutro. */
  color?: number;
}

export interface RenderView {
  tanks: RenderTank[];
  bullets: RenderBullet[];
  me: string;
}

// Raios/durações recalibrados para o mundo claro: luz aditiva sobre piso claro satura rápido,
// então o clarão é menor e mais curto — pontua o evento em vez de lavar a arena.
const MUZZLE_FLASH_RADIUS = 82;
const MUZZLE_FLASH_MS = 70;
const BOUNCE_FLASH_RADIUS = 24;
const BOUNCE_FLASH_MS = 55;
const DEATH_FLASH_RADIUS = 150;
const DEATH_FLASH_MS = 190;
// Explosão de BALA (fim de vida ou choque bala×bala, Fase 5): mesma linguagem da explosão de
// morte, em escala menor — é uma bala acabando, não um tanque morrendo.
const BULLET_POP_FLASH_RADIUS = 88;
const BULLET_POP_FLASH_MS = 130;
const TRACK_STEP_PX = 12;
const TRACK_TELEPORT_DIST = 30;
const RECOIL_MATCH_RADIUS = 40;

const WARM_SPARK_COLORS = [0xffb347, 0xfff1d6, 0xffd84d];
const FIRE_COLORS = [0xffb347, 0xff6a2a, 0xffd84d, 0xff3b3b];

/**
 * Teto do `devicePixelRatio`. 2 é o padrão; em tela cheia num monitor 4K isso quadruplica os
 * pixels que os filtros de tela cheia processam, e é a primeira alavanca da otimização da Fase 8
 * (§2, item c) caso a meta de p95 não seja batida.
 */
const DPR_MAX = 2;

// ---------------------------------------------------------------------------------------------
// ACHE O SEU TANQUE (Fase 11): tudo o que acontece DURANTE a contagem regressiva para cada um
// encontrar a própria cor antes de a rodada começar — e some antes de alguém poder atirar, para
// não virar vantagem competitiva.
// ---------------------------------------------------------------------------------------------

/** Quanto a câmera aproxima no auge da contagem. Sutil de propósito: a arena continua legível. */
const LARGADA_ZOOM = 0.22;
/** Fração do deslocamento até o meu tanque que a câmera percorre no auge. */
const LARGADA_PAN = 0.55;
/**
 * Quantos pixels ABAIXO do centro da área jogável a câmera tenta pousar o meu tanque. Sem este
 * desvio a mira da câmera e o número gigante da contagem disputam o mesmo pixel — e o número
 * ganha, tapando exatamente o tanque que a aproximação existe para mostrar. Com ele a composição
 * fica "contagem em cima, o seu tanque aceso logo abaixo".
 */
const LARGADA_DESLOC_Y = 122;
/** Quanto a borda da arena pode descolar da tela durante a aproximação, em px de MUNDO. */
const LARGADA_FOLGA = 44;
/** Tempo de entrada do zoom, em segundos. */
const LARGADA_SOBE = 0.45;
/**
 * Tempo de saída do zoom, contado do FIM da contagem para trás: o enquadramento já está em 100%
 * no instante do "VAI!", que é a exigência da especificação (a arena inteira visível antes do
 * primeiro tiro). Só o anel, a seta e o esmaecimento sobrevivem ao VAI, e por menos de 1 s.
 */
const LARGADA_DESCE = 0.9;
/** Constante de tempo do sumiço das marcas depois do "VAI!" — dá ~0,9 s até o invisível. */
const MARCA_TAU_SAI = 0.28;
const MARCA_TAU_ENTRA = 0.1;
/** Quanto os ADVERSÁRIOS escurecem no auge da contagem. */
const LARGADA_ESMAECE = 0.55;
/** Raio do anel pulsante sob o meu tanque. */
const ANEL_RAIO = 42;
/** Distância do centro do tanque até a ponta da seta. */
const SETA_DIST = 70;

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Aproximação exponencial independente do frame rate. */
function suavizar(atual: number, alvo: number, dt: number, tau: number): number {
  return atual + (alvo - atual) * (1 - Math.exp(-dt / tau));
}

interface TankRuntimeState {
  odometer: number;
  lastX: number;
  lastY: number;
  wasAlive: boolean;
}

export class Renderer {
  private readonly app: Application;
  private readonly textures: GameTextures;

  private readonly world: Container;
  private readonly shadowsLayer = new Container();
  private readonly entitiesLayer = new Container();
  private readonly fxLayer = new Container();
  private readonly labelLayer = new Container();
  // Recorta a camada de sombra no retângulo da arena: a sombra é enviesada e, sem máscara, a das
  // paredes de borda escorre para fora do piso e suja a moldura do canvas.
  private readonly shadowMask = new Graphics();

  /**
   * Holofote na cor do jogador sob o meu tanque. Existe porque o overlay da contagem escurece a
   * arena com um véu escuro: um traço fino de anel some atrás dele, uma mancha de
   * luz aditiva não.
   */
  private readonly holofoteLargada: Sprite;
  /** Anel pulsante sob o MEU tanque durante a contagem — entra antes das entidades. */
  private readonly anelLargada = new Graphics();
  /** Seta que aponta para o meu tanque — vive na camada de nomes, acima de tudo. */
  private readonly setaLargada = new Graphics();

  private readonly mazeView: MazeView;
  private readonly decals: DecalLayer;
  private readonly lights: LightFx;
  private readonly particles: ParticleSystem;
  private readonly bullets: BulletPool;
  private readonly juice = new JuiceController();
  private readonly post = new PostFX();
  /**
   * Mira do mouse. Vive no `stage`, não no `world`: fica fora do bloom e do shake, então não
   * borra nem treme junto com a arena — é UI desenhada em cima, não um objeto do mundo.
   */
  private readonly crosshair = new Graphics();

  private readonly tanks = new Map<string, TankView>();
  private readonly runtime = new Map<string, TankRuntimeState>();

  private currentMaze: Maze | null = null;
  private worldWidth = 1;
  private worldHeight = 1;
  private baseX = 0;
  private baseY = 0;
  private baseScale = 1;
  private lastScreenW = 0;
  private lastScreenH = 0;
  private meId = '';
  private filtrosAplicados: Filter[] | null = null;
  /** Faixas de tela ocupadas pelo HUD (relógio em cima, munição embaixo). Ver ui/layout.ts. */
  private reservas: Reservas = { top: 0, right: 0, bottom: 0, left: 0 };
  /** `?fx=alto|reduzido` trava o nível de pós-processamento — existe para MEDIR cada degrau. */
  private nivelForcado: NivelFx | null = null;

  /** Segundos restantes da contagem regressiva; `null` fora dela. Ver `setLargada()`. */
  private largadaRestante: number | null = null;
  private focoZoom = 0;
  private focoMarca = 0;
  private tempoLargada = 0;
  private meX = 0;
  private meY = 0;
  private meCor = 0xffffff;
  private meVivo = false;
  private corDasMarcas = -1;
  /** Câmera efetiva (sem o tremor), usada por `screenToWorld` para a mira não errar no zoom. */
  private camScale = 1;
  private camPivotX = 0;
  private camPivotY = 0;

  // Público (não privado) de propósito: main.ts referencia `InstanceType<typeof Renderer>`,
  // que exige um construtor público em TS. `static create()` continua sendo o jeito certo de
  // instanciar (é o único que faz o `await app.init(...)`).
  constructor(app: Application, textures: GameTextures) {
    this.app = app;
    this.textures = textures;

    this.world = new Container({ isRenderGroup: true });
    app.stage.addChild(this.world);

    this.mazeView = new MazeView(textures);
    this.decals = new DecalLayer(textures, 1, 1);
    this.lights = new LightFx(textures);
    this.particles = new ParticleSystem(textures);
    this.bullets = new BulletPool(textures);

    // ordem das camadas: chão → decalques → sombras → paredes → entidades → fx/partículas → luz → nomes
    this.world.addChild(this.mazeView.floorLayer);
    this.world.addChild(this.decals.sprite);
    this.shadowsLayer.addChild(this.mazeView.wallShadowLayer);
    this.world.addChild(this.shadowsLayer);
    this.world.addChild(this.shadowMask);
    this.shadowsLayer.mask = this.shadowMask;
    this.world.addChild(this.mazeView.wallLayer);
    // Holofote e anel entram ENTRE as paredes e os tanques: marcam o chão sob o meu tanque, não
    // uma auréola por cima dele.
    this.holofoteLargada = new Sprite(textures.light);
    this.holofoteLargada.anchor.set(0.5);
    this.holofoteLargada.setSize(240, 240);
    this.holofoteLargada.blendMode = 'add';
    this.holofoteLargada.visible = false;
    this.world.addChild(this.holofoteLargada);
    this.anelLargada.visible = false;
    this.anelLargada.blendMode = 'add';
    this.world.addChild(this.anelLargada);
    this.world.addChild(this.entitiesLayer);
    this.fxLayer.addChild(this.particles.smokeContainer, this.particles.container, this.bullets.container);
    this.world.addChild(this.fxLayer);
    this.world.addChild(this.lights.container);
    // labelLayer fica por cima da luz — nomes nunca são lavados pelo clarão de um evento.
    this.setaLargada.visible = false;
    this.labelLayer.addChild(this.setaLargada);
    this.world.addChild(this.labelLayer);

    this.world.filterArea = app.screen;
    this.world.filters = this.post.filters;

    this.drawCrosshair();
    this.crosshair.visible = false;
    app.stage.addChild(this.crosshair);

    app.ticker.add(() => this.onTick());
  }

  // Crosshair procedural discreto: quatro traços curtos afastados do centro (o alvo fica
  // visível no meio) + um ponto quente. Desenhado uma vez, depois só reposicionado.
  private drawCrosshair(): void {
    const g = this.crosshair;
    const gap = 5;
    const len = 9;
    g.clear();
    g.moveTo(-gap - len, 0).lineTo(-gap, 0);
    g.moveTo(gap, 0).lineTo(gap + len, 0);
    g.moveTo(0, -gap - len).lineTo(0, -gap);
    g.moveTo(0, gap).lineTo(0, gap + len);
    g.stroke({ width: 1.6, color: 0xffd9a0, alpha: 0.85 });
    g.circle(0, 0, 12).stroke({ width: 1, color: WORLD_COLORS.warmLight, alpha: 0.3 });
    g.circle(0, 0, 1.6).fill({ color: 0xfff1d6, alpha: 0.9 });
  }

  /** Posiciona a mira em coordenadas de TELA (px CSS). `visible: false` a esconde. */
  setCrosshair(sx: number, sy: number, visible: boolean): void {
    this.crosshair.visible = visible;
    if (visible) this.crosshair.position.set(sx, sy);
  }

  /**
   * Converte um ponto da tela (px CSS, relativo ao canvas) para coordenadas de mundo — é o que
   * transforma a posição do mouse no ângulo de mira da torre.
   *
   * De propósito usa a câmera BASE, ignorando o screen shake: a mira seguiria o tremor e o
   * jogador erraria o tiro por causa de um efeito puramente cosmético.
   */
  screenToWorld(sx: number, sy: number): Vec2 {
    return {
      x: (sx - this.baseX) / this.camScale + this.camPivotX,
      y: (sy - this.baseY) / this.camScale + this.camPivotY,
    };
  }

  /**
   * Estado da contagem regressiva (Fase 11): `restante` em segundos enquanto ela corre, `null` no
   * resto do tempo. É a partir daqui que saem o zoom de aproximação, o anel, a seta e o
   * esmaecimento dos adversários — o cliente não precisa coordenar nada, só repassar o relógio.
   */
  setLargada(restante: number | null): void {
    this.largadaRestante = restante;
  }

  static async create(parent: HTMLElement): Promise<Renderer> {
    const app = new Application();
    await app.init({
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, DPR_MAX),
      autoDensity: true,
      background: WORLD_COLORS.background,
      preference: ['webgl'],
      // A janela inteira, não um retângulo fixo: `#game` é `inset: 0` dentro de `#app`, que é
      // `position: fixed; inset: 0`. Em tela cheia (Fullscreen API) o elemento acompanha sozinho.
      resizeTo: parent,
    });
    parent.appendChild(app.canvas);

    const textures = createTextures(app.renderer);
    const renderer = new Renderer(app, textures);
    const fx = new URLSearchParams(location.search).get('fx');
    if (fx === 'alto' || fx === 'reduzido') renderer.nivelForcado = fx;
    renderer.resize();
    // Compila os shaders dos filtros de morte agora, na tela de entrada, e não no primeiro
    // abate — ver `PostFX.prewarm()`.
    renderer.post.prewarm();
    return renderer;
  }

  setMaze(maze: Maze): void {
    this.currentMaze = maze;
    this.worldWidth = maze.cols * maze.cell;
    this.worldHeight = maze.rows * maze.cell;

    this.mazeView.setMaze(maze);
    this.shadowMask.clear().rect(0, 0, this.worldWidth, this.worldHeight).fill(0xffffff);
    // Enquadrar ANTES de recriar os decalques: a textura deles é dimensionada pela escala da
    // câmera, e a escala só existe depois do `fitCamera` do labirinto novo. Fora de ordem, uma
    // arena ultrawide (câmera ~2,1×) ganharia uma textura de decalque na escala da rodada
    // anterior e as marcas de esteira sairiam borradas.
    this.fitCamera();
    this.decals.reset(this.worldWidth, this.worldHeight, this.baseScale * this.app.renderer.resolution);
    this.particles.setWorldBounds(this.worldWidth, this.worldHeight);
    // Nota: `runtime` (odômetro/wasAlive por tanque) NÃO é limpo aqui — os tanques em si
    // continuam existindo entre rounds (mesmos ids). Limpar o Map faria sync() reencontrar
    // `!rt` para tanques já existentes e criar TankView duplicadas por cima das antigas.
    // O salto de posição para o novo spawn já é tratado pelo guard de teleporte em sync().
  }

  sync(view: RenderView): void {
    this.meId = view.me;
    this.meVivo = false;
    const seenIds = new Set<string>();

    for (const t of view.tanks) {
      seenIds.add(t.id);
      if (t.id === view.me) {
        this.meX = t.x;
        this.meY = t.y;
        this.meCor = t.color;
        this.meVivo = t.alive;
      }
      let tankView = this.tanks.get(t.id);
      let rt = this.runtime.get(t.id);
      if (!tankView || !rt) {
        tankView = new TankView(t.color, t.name, this.textures);
        this.tanks.set(t.id, tankView);
        this.entitiesLayer.addChild(tankView.root);
        this.shadowsLayer.addChild(tankView.shadow);
        this.labelLayer.addChild(tankView.label);
        rt = { odometer: 0, lastX: t.x, lastY: t.y, wasAlive: t.alive };
        this.runtime.set(t.id, rt);
      }

      if (rt.wasAlive && !t.alive) {
        tankView.startDeathSequence();
        if (t.id === this.meId) this.post.triggerSelfDeathGlitch();
      }

      if (t.alive) {
        const dist = Math.hypot(t.x - rt.lastX, t.y - rt.lastY);
        if (dist < TRACK_TELEPORT_DIST) {
          rt.odometer += dist;
          while (rt.odometer >= TRACK_STEP_PX) {
            rt.odometer -= TRACK_STEP_PX;
            this.decals.stampTrack(t.x, t.y, t.angle);
          }
        } else {
          rt.odometer = 0;
        }
      }
      rt.lastX = t.x;
      rt.lastY = t.y;
      rt.wasAlive = t.alive;

      tankView.sync(t.x, t.y, t.angle, t.turret, t.alive);
    }

    for (const [id, tankView] of this.tanks) {
      if (seenIds.has(id)) continue;
      tankView.destroy();
      this.tanks.delete(id);
      this.runtime.delete(id);
    }

    this.bullets.sync(view.bullets);
  }

  onShot(x: number, y: number, angle: number, color: number): void {
    this.lights.flash(x, y, MUZZLE_FLASH_RADIUS, WORLD_COLORS.warmLight, MUZZLE_FLASH_MS, 0.55);

    for (let i = 0; i < 7; i++) {
      const a = angle + (Math.random() - 0.5) * 0.9;
      const speed = 120 + Math.random() * 200;
      this.particles.spawn(
        x,
        y,
        Math.cos(a) * speed,
        Math.sin(a) * speed,
        0.12 + Math.random() * 0.18,
        0.17 + Math.random() * 0.18,
        pickRandom(WARM_SPARK_COLORS),
        { drag: 6 },
      );
    }
    for (let i = 0; i < 3; i++) {
      const a = angle + (Math.random() - 0.5) * 0.6;
      const speed = 20 + Math.random() * 40;
      this.particles.spawn(x, y, Math.cos(a) * speed, Math.sin(a) * speed - 10, 0.5 + Math.random() * 0.4, 0.35 + Math.random() * 0.25, 0x39405c, {
        drag: 3,
        grow: 2.2,
        alpha: 0.3,
        smoke: true,
      });
    }

    this.juice.addTrauma(0.05);

    const nearest = this.findNearestAliveTank(x, y, RECOIL_MATCH_RADIUS);
    nearest?.recoilKick();
  }

  // Ricochete: faísca curta e seca. Clarão mínimo e — por pedido do usuário — nenhuma marca
  // deixada na parede; só a morte marca o mundo.
  onBounce(x: number, y: number): void {
    const normal = this.estimateWallNormal(x, y);
    this.lights.flash(x, y, BOUNCE_FLASH_RADIUS, 0xffd9a0, BOUNCE_FLASH_MS, 0.35);

    const base = Math.atan2(normal.y, normal.x);
    for (let i = 0; i < 4; i++) {
      const a = base + (Math.random() - 0.5) * 1.7;
      const speed = 70 + Math.random() * 130;
      this.particles.spawn(
        x,
        y,
        Math.cos(a) * speed,
        Math.sin(a) * speed,
        0.07 + Math.random() * 0.09,
        0.1 + Math.random() * 0.1,
        pickRandom(WARM_SPARK_COLORS),
        { drag: 6, gravity: 180 },
      );
    }
    this.juice.addTrauma(0.025);
  }

  /**
   * Estouro de bala. `escala` 1 é o fim de vida de uma bala; o choque entre duas usa um valor
   * maior, porque são dois projéteis se anulando no mesmo ponto.
   *
   * Deliberadamente NÃO chama `decals.stampScorch` nem `post.triggerShockwave`: por regra do
   * usuário só a morte de tanque marca o mundo, e uma onda de tela a cada bala que expira
   * transformaria a arena num tremor contínuo.
   */
  onBulletExplode(x: number, y: number, color: number, escala = 1): void {
    this.lights.flash(x, y, BULLET_POP_FLASH_RADIUS * escala, 0xffb066, BULLET_POP_FLASH_MS, 0.62);

    // Bola de fogo que abre e some — é a "onda" da explosão de morte, na metade do tamanho.
    this.particles.spawn(x, y, 0, 0, 0.14, 1.5 * escala, 0xffa848, { drag: 0, grow: 3, alpha: 0.45 });

    const faiscas = Math.round(22 * escala);
    for (let i = 0; i < faiscas; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 35 + Math.random() * 190 * escala;
      this.particles.spawn(
        x,
        y,
        Math.cos(a) * speed,
        Math.sin(a) * speed,
        0.18 + Math.random() * 0.26,
        (0.15 + Math.random() * 0.2) * escala,
        pickRandom(FIRE_COLORS),
        { drag: 3.2, gravity: 55 },
      );
    }
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 12 + Math.random() * 45;
      this.particles.spawn(x, y, Math.cos(a) * speed, Math.sin(a) * speed - 10, 0.45 + Math.random() * 0.35, 0.3 * escala, 0x39405c, {
        drag: 2.6,
        grow: 2.2,
        alpha: 0.3,
        smoke: true,
      });
    }
    // Um punhado de faíscas na cor de quem atirou, para o estouro ainda ter dono na leitura.
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 130;
      this.particles.spawn(x, y, Math.cos(a) * speed, Math.sin(a) * speed, 0.2 + Math.random() * 0.22, 0.14 * escala, color, {
        drag: 3,
        gravity: 60,
      });
    }

    this.juice.addTrauma(0.06 * escala);
  }

  onDeath(x: number, y: number, color: number): void {
    this.juice.hitstop(60);
    this.juice.addTrauma(0.6);
    this.post.triggerShockwave(x, y);
    this.lights.flash(x, y, DEATH_FLASH_RADIUS, 0xffb066, DEATH_FLASH_MS, 0.8);

    this.particles.spawn(x, y, 0, 0, 0.16, 2.4, 0xffa848, { drag: 0, grow: 3, alpha: 0.4 });

    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 2;
      const gray = i % 3 === 0;
      const speed = 30 + Math.random() * 250;
      this.particles.spawn(
        x,
        y,
        Math.cos(a) * speed,
        Math.sin(a) * speed,
        gray ? 0.5 + Math.random() * 0.7 : 0.26 + Math.random() * 0.4,
        gray ? 0.5 + Math.random() * 0.6 : 0.18 + Math.random() * 0.24,
        gray ? 0x2f3550 : pickRandom(FIRE_COLORS),
        { drag: gray ? 2.2 : 3.2, grow: gray ? 2.2 : 0, alpha: gray ? 0.4 : 1, gravity: gray ? -20 : 60, smoke: gray },
      );
    }
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 160;
      this.particles.spawn(x, y, Math.cos(a) * speed, Math.sin(a) * speed, 0.24 + Math.random() * 0.3, 0.18 + Math.random() * 0.16, color, {
        drag: 3,
        gravity: 80,
      });
    }

    this.decals.stampScorch(x, y, Math.random() * Math.PI * 2);
  }

  /**
   * Proporção da área jogável desta tela — o que o cliente anuncia ao servidor para ele escolher
   * a forma do labirinto da rodada (Fase 9). Sai do `app.screen` real, já descontadas as faixas
   * de HUD, e não do `window.innerWidth`: em tela cheia os dois divergem por um frame.
   */
  aspectoDaArena(): number {
    return aspectoDaArena(this.app.screen.width, this.app.screen.height);
  }

  addTrauma(v: number): void {
    this.juice.addTrauma(v);
  }

  hitstop(ms: number): void {
    this.juice.hitstop(ms);
  }

  resize(): void {
    // Mudar de monitor (ou de nível de zoom) troca o devicePixelRatio; sem isto o jogo continuaria
    // rasterizando na densidade do monitor anterior — borrado num, desperdiçando pixels no outro.
    const dprAlvo = Math.min(window.devicePixelRatio || 1, DPR_MAX);
    if (Math.abs(this.app.renderer.resolution - dprAlvo) > 0.01) {
      this.app.renderer.resolution = dprAlvo;
      this.app.resize();
    }
    aplicarEscalaHud(this.app.screen.height);
    this.reservas = reservasDoJogo(this.app.screen.height);
    // O que pesa nos filtros são os pixels REAIS do framebuffer: px CSS × resolução, ao quadrado.
    const res = this.app.renderer.resolution;
    const megapixels = (this.app.screen.width * res * this.app.screen.height * res) / 1e6;
    const auto = qualidadePara(megapixels);
    this.post.aplicarQualidade(
      this.nivelForcado === 'alto'
        ? { nivel: 'alto', resolucao: 1 }
        : this.nivelForcado === 'reduzido'
          ? { nivel: 'reduzido', resolucao: auto.resolucao }
          : auto,
    );
    this.fitCamera();
    this.world.filterArea = this.app.screen;
  }

  // A arena ocupa a área JOGÁVEL — a janela menos as faixas reservadas ao HUD — com escala
  // uniforme até encostar no eixo mais apertado dela. Com o placar fora de cena durante a ação
  // (Fase 8 §6) não há mais reserva lateral: em qualquer tela 16:9 ou mais larga o limite passa a
  // ser a ALTURA, a arena cresce até preencher, e a sobra que aparece nos lados é exatamente onde
  // munição e killfeed moram — nada de arena pequena no meio com faixa morta em volta.
  private fitCamera(): void {
    const screenW = this.app.screen.width;
    const screenH = this.app.screen.height;
    const margin = 0.985;
    const { top, right, bottom, left } = this.reservas;
    const playW = Math.max(1, screenW - right - left);
    const playH = Math.max(1, screenH - top - bottom);
    const scale = Math.max(0.01, Math.min(playW / this.worldWidth, playH / this.worldHeight) * margin);
    this.baseScale = scale;
    this.baseX = left + playW / 2;
    this.baseY = top + playH / 2;
    this.lastScreenW = screenW;
    this.lastScreenH = screenH;
    this.world.pivot.set(this.worldWidth / 2, this.worldHeight / 2);
    // Câmera efetiva inicial: sem isto o primeiro `screenToWorld` antes do primeiro tick usaria
    // uma escala de 1 e a mira nasceria fora da arena.
    this.camScale = this.baseScale;
    this.camPivotX = this.worldWidth / 2;
    this.camPivotY = this.worldHeight / 2;
  }

  /**
   * Redesenha anel e seta na cor de quem está jogando. Acontece uma vez por cor (a cada troca de
   * cor no lobby, na prática), nunca por frame: por frame só mudam posição, escala e alpha.
   */
  private redesenharMarcasDeLargada(cor: number): void {
    if (this.corDasMarcas === cor) return;
    this.corDasMarcas = cor;

    const anel = this.anelLargada;
    anel.clear();
    anel.circle(0, 0, ANEL_RAIO).stroke({ width: 4.5, color: cor, alpha: 0.95 });
    anel.circle(0, 0, ANEL_RAIO - 8).stroke({ width: 1.6, color: cor, alpha: 0.45 });
    // Quatro marcas de canto: dão ao anel uma leitura de RETÍCULA, que é o que diz "este é o seu"
    // em vez de "aqui tem um efeito bonito".
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      anel
        .moveTo(dx * (ANEL_RAIO + 4), dy * (ANEL_RAIO + 4))
        .lineTo(dx * (ANEL_RAIO + 13), dy * (ANEL_RAIO + 13))
        .stroke({ width: 3.4, color: cor, alpha: 0.85 });
    }

    const seta = this.setaLargada;
    seta.clear();
    seta
      .moveTo(0, 12)
      .lineTo(-11, -8)
      .lineTo(-4.5, -8)
      .lineTo(-4.5, -18)
      .lineTo(4.5, -18)
      .lineTo(4.5, -8)
      .lineTo(11, -8)
      .closePath()
      .fill({ color: cor })
      .stroke({ width: 3, color: 0x0b0f1a, alpha: 0.95 });
  }

  /**
   * Avança o foco de largada e aplica zoom/anel/seta/esmaecimento. Chamado uma vez por frame pelo
   * ticker interno, com `dt` de tempo REAL (não o do hitstop): a contagem regressiva é um relógio
   * de interface, não um evento da simulação.
   */
  private atualizarLargada(dt: number): void {
    this.tempoLargada += dt;
    const restante = this.largadaRestante;

    // O zoom sai direto do relógio, não de uma decaída livre: assim ele chega EXATAMENTE em 100%
    // no instante em que a contagem zera, que é quando o primeiro tiro passa a ser possível.
    const alvoZoom =
      restante === null ? 0 : clamp01(Math.min((COUNTDOWN - restante) / LARGADA_SOBE, restante / LARGADA_DESCE));
    this.focoZoom = suavizar(this.focoZoom, alvoZoom, dt, 0.1);

    const alvoMarca = restante === null ? 0 : 1;
    this.focoMarca = suavizar(this.focoMarca, alvoMarca, dt, alvoMarca > this.focoMarca ? MARCA_TAU_ENTRA : MARCA_TAU_SAI);
    if (this.focoMarca < 0.004) this.focoMarca = 0;

    const marcando = this.focoMarca > 0 && this.meVivo;
    this.anelLargada.visible = marcando;
    this.setaLargada.visible = marcando;
    this.holofoteLargada.visible = marcando;

    if (marcando) {
      this.redesenharMarcasDeLargada(this.meCor);
      const pulso = 0.5 + 0.5 * Math.sin(this.tempoLargada * 5.4);
      this.holofoteLargada.position.set(this.meX, this.meY);
      this.holofoteLargada.tint = this.meCor;
      this.holofoteLargada.alpha = this.focoMarca * (0.42 + 0.2 * pulso);
      this.anelLargada.position.set(this.meX, this.meY);
      this.anelLargada.scale.set(0.86 + 0.2 * pulso);
      this.anelLargada.alpha = this.focoMarca * (0.5 + 0.5 * pulso);

      const acima = this.meY > SETA_DIST + 10;
      const salto = pulso * 5;
      this.setaLargada.position.set(this.meX, this.meY + (acima ? -SETA_DIST - salto : SETA_DIST + salto));
      this.setaLargada.rotation = acima ? 0 : Math.PI;
      this.setaLargada.alpha = this.focoMarca;
    }

    // Esmaecer os adversários é o que faz o meu SALTAR sem precisar de mais efeito nenhum.
    const dim = 1 - LARGADA_ESMAECE * this.focoMarca;
    for (const [id, tank] of this.tanks) {
      const alvo = id === this.meId ? 1 : dim;
      if (tank.root.alpha !== alvo) {
        tank.root.alpha = alvo;
        tank.label.alpha = alvo;
        tank.shadow.alpha = 0.4 * alvo;
      }
    }
  }

  /**
   * Ponto do mundo que fica no centro da área jogável. Fora da contagem é o centro da arena; nela,
   * desliza em direção ao meu tanque — sempre limitado para a borda do labirinto não descolar da
   * tela e abrir faixa preta.
   */
  private pivoDaCamera(escala: number): Vec2 {
    let px = this.worldWidth / 2;
    let py = this.worldHeight / 2;
    if (this.focoZoom <= 0.001) return { x: px, y: py };
    // Desde a Fase 9 o labirinto NASCE na proporção da tela, então ele já preenche os dois eixos:
    // sem uma folga, "não deixar a borda descolar" travaria a câmera e o pan seria puro enfeite.
    // Meia célula de sobra é invisível sob o escurecimento da contagem e devolve o movimento.
    const folga = LARGADA_FOLGA * this.focoZoom;

    px += (this.meX - px) * LARGADA_PAN * this.focoZoom;
    py += (this.meY - py) * LARGADA_PAN * this.focoZoom;
    // Olhar um pouco ACIMA do tanque é o que o empurra para BAIXO na tela, para fora do número.
    py -= (LARGADA_DESLOC_Y / escala) * this.focoZoom;

    const { top, right, bottom, left } = this.reservas;
    const meiaL = Math.max(1, this.app.screen.width - right - left) / 2 / escala - folga;
    const meiaA = Math.max(1, this.app.screen.height - top - bottom) / 2 / escala - folga;
    px = this.worldWidth > meiaL * 2 ? clamp(px, meiaL, this.worldWidth - meiaL) : this.worldWidth / 2;
    py = this.worldHeight > meiaA * 2 ? clamp(py, meiaA, this.worldHeight - meiaA) : this.worldHeight / 2;
    return { x: px, y: py };
  }

  private findNearestAliveTank(x: number, y: number, maxDist: number): TankView | null {
    let best: TankView | null = null;
    let bestDist = maxDist;
    for (const tankView of this.tanks.values()) {
      const dist = Math.hypot(tankView.root.x - x, tankView.root.y - y);
      if (dist < bestDist) {
        bestDist = dist;
        best = tankView;
      }
    }
    return best;
  }

  // RenderView.onBounce não traz a normal do impacto — estimamos pela parede mais próxima do
  // ponto de contato para as faíscas saltarem para o lado certo.
  private estimateWallNormal(x: number, y: number): Vec2 {
    if (!this.currentMaze) return { x: 0, y: -1 };
    let best: Vec2 = { x: 0, y: -1 };
    let bestDist = Infinity;
    const pad = 6;
    for (const w of this.currentMaze.walls) {
      if (y >= w.y - pad && y <= w.y + w.h + pad) {
        const distLeft = Math.abs(x - w.x);
        const distRight = Math.abs(x - (w.x + w.w));
        if (distLeft < bestDist) {
          bestDist = distLeft;
          best = { x: -1, y: 0 };
        }
        if (distRight < bestDist) {
          bestDist = distRight;
          best = { x: 1, y: 0 };
        }
      }
      if (x >= w.x - pad && x <= w.x + w.w + pad) {
        const distTop = Math.abs(y - w.y);
        const distBottom = Math.abs(y - (w.y + w.h));
        if (distTop < bestDist) {
          bestDist = distTop;
          best = { x: 0, y: -1 };
        }
        if (distBottom < bestDist) {
          bestDist = distBottom;
          best = { x: 0, y: 1 };
        }
      }
    }
    return best;
  }

  private onTick(): void {
    // `resizeTo` do Pixi só publica o novo tamanho no início do frame seguinte, e a página do
    // demo não escuta `resize` — refazer o enquadramento aqui garante arena centrada em qualquer
    // caso, inclusive quando o primeiro fit pegou um tamanho de tela ainda provisório.
    if (this.app.screen.width !== this.lastScreenW || this.app.screen.height !== this.lastScreenH) {
      this.resize();
    }

    const deltaMs = this.app.ticker.deltaMS;
    const worldDtS = this.juice.tick(deltaMs);

    if (worldDtS > 0) {
      for (const tank of this.tanks.values()) tank.updateRecoil(worldDtS);
      this.particles.update(worldDtS);
      this.lights.update(worldDtS);
      this.bullets.updateTime(worldDtS);
      this.post.update(worldDtS);
    }
    for (const tank of this.tanks.values()) tank.tickDeathFlash();

    this.decals.flush(this.app.renderer);

    this.atualizarLargada(deltaMs / 1000);

    const shake = this.juice.getShake();
    this.camScale = this.baseScale * (1 + LARGADA_ZOOM * this.focoZoom);
    const pivo = this.pivoDaCamera(this.camScale);
    this.camPivotX = pivo.x;
    this.camPivotY = pivo.y;
    this.world.pivot.set(pivo.x, pivo.y);
    this.world.position.set(this.baseX + shake.offsetX, this.baseY + shake.offsetY);
    this.world.rotation = shake.rotation;
    this.world.scale.set(this.camScale * shake.scale);

    // Só reatribui quando a lista mudou de verdade: `Container.filters =` reconstrói o efeito de
    // filtro do render group, e fazer isso todo frame é trabalho puro de graça.
    const filtros = this.post.filters;
    if (filtros !== this.filtrosAplicados) {
      this.filtrosAplicados = filtros;
      this.world.filters = filtros;
    }
  }
}
