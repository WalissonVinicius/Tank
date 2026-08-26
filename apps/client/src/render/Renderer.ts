// Orquestra todas as camadas visuais do jogo. Dono do PIXI.Application — nenhum outro módulo
// cria a aplicação. sync() é chamado 1× por frame por main.ts com o estado já interpolado;
// internamente o Renderer roda seu próprio ticker para efeitos contínuos (partículas, luzes,
// screen shake, pós-processamento) que não dependem do ritmo da simulação.

import { Application, BitmapText, Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { Filter } from 'pixi.js';
import { raycastSegment } from '@tank/shared-sim';
import type { Aabb, Maze, Vec2 } from '@tank/shared-sim';
import { BULLET_RADIUS, COUNTDOWN, TANK_RADIUS, WORLD_COLORS } from '@tank/protocol';

import { aplicarEscalaHud, aspectoDaArena, reservasDoJogo, type Reservas } from '../ui/layout.js';
import { createTextures, type GameTextures } from './textures.js';
import { lighten } from './color.js';
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

// ---------------------------------------------------------------------------------------------
// LINHA DE MIRA (Fase A3): mostra o ângulo de saída do cano até a PRIMEIRA parede — e para ali.
//
// Não mostrar o rebote é decisão de design, não limitação: desenhar a trajetória inteira entrega
// a resposta pronta e o jogo vira apontar e clicar. Só o ângulo de saída é o que a sinuca faz, e
// é o bastante para o jogador fechar a conta do ricochete DE CABEÇA — que é a habilidade que dá
// nome ao jogo.
// ---------------------------------------------------------------------------------------------

/** Onde a bala nasce, medido do centro do tanque. É a MESMA conta de `stepTanks` em shared-sim. */
const MIRA_OFFSET_BOCA = TANK_RADIUS + BULLET_RADIUS + 4;
/** Espessura da linha, em px de MUNDO (a câmera ainda a escala). */
const MIRA_ESPESSURA = 2;
/** Trecho junto ao cano que sai mais aceso, para a linha nascer PRESA ao tanque. */
const MIRA_TRECHO_QUENTE = 34;
/**
 * Translucidez baixa de propósito: a linha é ajuda de leitura, não holofote. Nesta faixa ela
 * some atrás da bala e dos tanques em vez de disputar atenção com eles.
 */
const MIRA_ALPHA = 0.22;
const MIRA_ALPHA_QUENTE = 0.16;
/** Meia altura do tracinho que marca o ponto de impacto. */
const MIRA_MARCA_METADE = 6.5;

// ---------------------------------------------------------------------------------------------
// V2 §1 — A ARENA SE MONTA NA TROCA DE RODADA
//
// Antes, `setMaze()` trocava a arena inteira num frame: o placar saía, o jogo voltava e o mapa
// simplesmente era outro. Agora a arena se MONTA, e a montagem cabe inteira dentro da contagem
// regressiva que já existia (COUNTDOWN = 3 s) — ela preenche a espera, não a estende.
//
// A hierarquia de leitura é PISO → PAREDES → TANQUES, e as paredes surgem em SEQUÊNCIA a partir
// do centro, cada uma se estendendo pelo próprio eixo longo.
//
// Como isso é feito de graça: a máscara. Um único `Graphics` de retângulos serve de máscara de
// STENCIL para a camada de paredes, e é ele que cresce — a arte das paredes (extrusão, fio de
// luz, aresta escura) continua sendo exatamente a que `MazeView` já desenhou uma vez. Nada é
// redesenhado, nenhum passe de tela cheia entra, e no fim da montagem a máscara sai de cena.
//
// Por que a máscara em vez de um pop de escala por parede: as paredes vivem TODAS num único
// `Graphics` dentro de `MazeView` (arquivo que não pertence a esta tarefa), então não existe um
// nó por parede para escalar. Um `Container` de sprites como máscara também estava fora de
// questão — máscara que não é `Graphics` vira `AlphaMaskFilter`, ou seja, um passe de tela cheia
// a mais, exatamente o que o CLAUDE.md limita.
// ---------------------------------------------------------------------------------------------

/** Quanto o piso leva para entrar. É o primeiro degrau da hierarquia de leitura. */
const MONTAGEM_PISO_S = 0.26;
/** Instante em que a primeira parede (a mais próxima do centro) começa a nascer. */
const MONTAGEM_PAREDES_INICIO_S = 0.12;
/** Tempo que a onda leva para ir do centro ao canto mais distante da arena. */
const MONTAGEM_ONDA_S = 0.62;
/** Tempo que UMA parede leva para se estender por inteiro. */
const MONTAGEM_PAREDE_S = 0.22;
const MONTAGEM_TANQUES_INICIO_S = 0.6;
const MONTAGEM_TANQUES_S = 0.34;
/** Duração total. Bem abaixo dos 3 s da contagem: a arena tem que estar LEGÍVEL antes do "VAI!". */
const MONTAGEM_TOTAL_S = 1;
/** Folga da máscara sobre a silhueta da parede (a extrusão de MazeView sai 4 px a leste, 7 ao sul). */
const MONTAGEM_PAD = 9;
/** Sombra das paredes só entra na segunda metade — antes disso ela seria o fantasma do mapa. */
const MONTAGEM_SOMBRA_INICIO = 0.45;

// ---------------------------------------------------------------------------------------------
// V2 §2 — A CONFIRMAÇÃO DE ABATE
//
// Quem mata não recebia retorno nenhum: a explosão acontece na VÍTIMA, e num jogo de ricochete o
// autor do tiro muitas vezes nem estava olhando para lá. Agora o matador ganha, no próprio tanque,
// um "+1" com o nome de quem caiu e um pulso na sua cor.
//
// E o autogol — a piada central do jogo — tem tratamento PRÓPRIO: etiqueta vermelha "AUTOGOL!"
// saindo do tanque de quem se explodiu (de qualquer um: é o momento que faz a sala rir), somada,
// quando a vítima é o jogador local, ao carimbo do HUD e ao mundo perdendo a cor.
// ---------------------------------------------------------------------------------------------

/** Quanto tempo o "+1" fica na tela. Curto: é confirmação, não troféu. */
const ABATE_VIDA_S = 1.05;
/** Quanto ele sobe, em px de MUNDO. */
const ABATE_SUBIDA = 38;
/**
 * Altura do "+1" acima do centro do tanque. Alto o bastante para o nome da vítima ficar ACIMA da
 * plaqueta de identidade do próprio tanque, em vez de brigar com ela.
 */
const ABATE_ALTURA = 58;
/** Janela em que um segundo abate vira "+2" em vez de reiniciar a etiqueta. */
const ABATE_COMBO_S = 0.9;
const ABATE_ANEL_RAIO = 26;
const ABATE_ANEL_VIDA_S = 0.42;
const AUTOGOL_VIDA_S = 1.5;
const AUTOGOL_SUBIDA = 30;
/** Altura em que a etiqueta de autogol nasce, acima do centro do tanque. */
const AUTOGOL_ALTURA = 40;
/** Cor de alerta da paleta do mundo — a mesma do CLAUDE.md. */
const COR_AUTOGOL = 0xff3b3b;
/** Quantas etiquetas de autogol podem estar no ar ao mesmo tempo (mortes simultâneas). */
const AUTOGOL_POOL = 3;

/** Aceleração/desaceleração cúbica de saída — o assentar de tudo que entra em cena. */
function saidaCubica(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

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

/**
 * Instância viva do `Renderer`.
 *
 * Existe UMA por página — este arquivo é o dono do `PIXI.Application`, e criar um segundo já
 * seria um bug. Publicá-la aqui é o que permite ao HUD (`ui/hud.ts`), que é quem recebe o evento
 * de abate com matador e vítima, pedir a confirmação no mundo sem que `main.ts` precise ganhar
 * um parâmetro novo. A dependência ui → render já existe no projeto (o killfeed importa o emblema
 * de `render/animais.ts`), então nenhuma direção nova de import é criada por causa disto.
 */
let instanciaAtiva: Renderer | null = null;

export function rendererAtivo(): Renderer | null {
  return instanciaAtiva;
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

  /**
   * Linha de mira do jogador local (ver bloco LINHA DE MIRA acima). Ao contrário da mira do
   * mouse, esta É um objeto do mundo: nasce na boca do cano e mede uma distância de mundo, então
   * precisa acompanhar zoom, pan e tremor da câmera.
   *
   * Corpo e realce são `Sprite` esticados, não `Graphics`: mudar largura/rotação de um sprite é
   * só transformação, enquanto redesenhar um `Graphics` reconstrói a geometria e sobe buffer para
   * a GPU — e isto aqui muda TODO frame.
   */
  private readonly miraLayer = new Container();
  private readonly miraLinha = new Sprite(Texture.WHITE);
  private readonly miraQuente = new Sprite(Texture.WHITE);
  /** Tracinho rente à parede no ponto de impacto — é ele que deixa o ÂNGULO legível. */
  private readonly miraMarca = new Graphics();

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
  /** `true` depois que um `sync()` encontrou o meu tanque na cena — antes disso `meCor` é chute. */
  private meConhecido = false;
  private meTurret = 0;
  private corDasMarcas = -1;

  /** Ligada por `setLinhaDeMira()`; a morte do jogador ainda a desliga sozinha. */
  private miraLigada = false;
  /**
   * Paredes já INFLADAS pelo raio da bala. É contra esta geometria que a bala ricocheteia na
   * simulação, então é dela que sai o ponto de impacto certo. Inflar custa um `map` sobre ~100
   * paredes: acontece uma vez por labirinto, nunca por frame.
   */
  private paredesDaBala: Aabb[] = [];
  private diagonalDoMundo = 1;
  private corDaMira = -1;
  /** Pontas do raio, reaproveitadas entre frames — `raycastSegment` só lê estes dois. */
  private readonly miraDe: Vec2 = { x: 0, y: 0 };
  private readonly miraPara: Vec2 = { x: 0, y: 0 };
  /** Último estado já resolvido: com tanque e torre parados o raycast nem chega a rodar. */
  private miraCacheX = Number.NaN;
  private miraCacheY = Number.NaN;
  private miraCacheAng = Number.NaN;
  /** O que o último cálculo decidiu. Sem isto, um acerto de cache reexibiria geometria velha. */
  private miraCacheVisivel = false;
  // --- V2 §1: montagem da arena ---------------------------------------------------------------
  /** Máscara de stencil da camada de paredes. Só existe enquanto a arena está se montando. */
  private readonly mascaraParedes = new Graphics();
  /** Frente de onda da montagem: um anel desenhado UMA vez e só escalado depois. */
  private readonly ondaMontagem = new Graphics();
  /**
   * Geometria da montagem, achatada em 5 números por parede (cx, cy, meiaLargura, meiaAltura,
   * atraso). Um array plano em vez de objetos porque isto é percorrido inteiro a cada frame da
   * montagem — não vale gerar ~100 leituras de propriedade por quadro.
   */
  private montagemGeo = new Float32Array(0);
  /** Segundos desde o início da montagem; negativo quando não há montagem em curso. */
  private montagemT = -1;
  private montagemQtd = 0;
  private montagemAlcance = 1;
  /**
   * Quanto da entrada dos TANQUES já passou (1 fora da montagem). O anel, a seta e o holofote da
   * largada moram fora de `entitiesLayer`, então precisam deste fator para não aparecerem
   * apontando um tanque que ainda não entrou em cena.
   */
  private montagemTanques = 1;
  /** Alpha original da camada de sombra das paredes, para devolvê-lo intacto no fim. */
  private sombraAlphaBase = -1;

  // --- V2 §2: confirmação de abate --------------------------------------------------------------
  private readonly abateRoot = new Container();
  private readonly abateMais: BitmapText;
  private readonly abateNome: BitmapText;
  private readonly abateAnel = new Graphics();
  private abateVida = 0;
  private abateAnelVida = 0;
  private abateCombo = 0;
  private abateX = 0;
  private abateY = 0;
  private readonly autogolTags: Array<{ root: Container; vida: number; x: number; y: number }> = [];
  private autogolProximo = 0;

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
    // A linha de mira entra ACIMA das paredes (senão a marca de impacto ficaria escondida atrás
    // da própria parede que ela aponta) e ABAIXO dos tanques e das balas — nunca por cima deles.
    // Blend normal, não aditivo: glow é vocabulário de quem EMITE luz, e a linha não emite nada.
    // Frente de onda da montagem: acima das paredes que ela acabou de revelar, abaixo dos tanques.
    this.ondaMontagem.blendMode = 'add';
    this.ondaMontagem.visible = false;
    this.world.addChild(this.ondaMontagem);
    // A máscara não é desenhada (o Pixi tira de cena o que vira máscara), mas precisa estar na
    // árvore para herdar a transformação do mundo — mesmo arranjo do `shadowMask` acima.
    this.world.addChild(this.mascaraParedes);
    this.montarLinhaDeMira();
    this.world.addChild(this.miraLayer);
    this.world.addChild(this.entitiesLayer);
    this.fxLayer.addChild(this.particles.smokeContainer, this.particles.container, this.bullets.container);
    this.world.addChild(this.fxLayer);
    this.world.addChild(this.lights.container);
    // labelLayer fica por cima da luz — nomes nunca são lavados pelo clarão de um evento.
    this.setaLargada.visible = false;
    this.labelLayer.addChild(this.setaLargada);
    // Anel do abate entra ANTES das etiquetas: é marca de chão sob o tanque, não auréola.
    this.abateAnel.visible = false;
    this.abateAnel.blendMode = 'add';
    this.fxLayer.addChild(this.abateAnel);
    this.labelLayer.addChild(this.abateRoot);
    this.montarEtiquetasDeAutogol();
    this.world.addChild(this.labelLayer);

    this.world.filterArea = app.screen;
    this.world.filters = this.post.filters;

    this.drawCrosshair();
    this.crosshair.visible = false;
    app.stage.addChild(this.crosshair);

    const confirmacao = this.montarConfirmacaoDeAbate();
    this.abateMais = confirmacao.mais;
    this.abateNome = confirmacao.nome;

    instanciaAtiva = this;
    app.ticker.add(() => this.onTick());
  }

  private montarLinhaDeMira(): void {
    // Âncora à esquerda e no meio da altura: a origem do sprite fica exatamente na boca do cano,
    // e esticar `width` faz a linha crescer só para a frente.
    for (const s of [this.miraLinha, this.miraQuente]) {
      s.anchor.set(0, 0.5);
      s.height = MIRA_ESPESSURA;
    }
    this.miraLinha.alpha = MIRA_ALPHA;
    this.miraQuente.alpha = MIRA_ALPHA_QUENTE;
    this.miraLayer.addChild(this.miraLinha, this.miraQuente, this.miraMarca);
    this.miraLayer.visible = false;
  }

  /**
   * Liga ou desliga a linha de mira do jogador local — só dele: desenhar a dos adversários
   * entregaria a intenção deles.
   *
   * Quem chama só precisa dizer se a RODADA está em andamento; morrer já apaga a linha aqui
   * dentro, porque o `sync()` sabe se o meu tanque está vivo. Fora da rodada (lobby, contagem,
   * fim de rodada, fim de partida) é só passar `false`.
   */
  setLinhaDeMira(ligada: boolean): void {
    this.miraLigada = ligada;
    // Apagar na hora, sem esperar o próximo `sync()`: na vitrine do lobby o `sync()` nem é
    // chamado, e a linha ficaria congelada na tela.
    if (!ligada) this.miraLayer.visible = false;
  }

  /**
   * Recalcula a linha: do cano até o primeiro toque em parede, e para ali.
   *
   * Chamada no fim do `sync()`, não no ticker interno, para a linha usar a MESMA posição de
   * tanque que foi desenhada neste frame — no ticker ela sairia um frame atrasada e descolaria
   * visivelmente do cano com o tanque em movimento.
   *
   * Sobre lixo de GC: `raycastSegment` devolve um `Hit` novo (3 objetos pequenos) por chamada.
   * Aqui ele roda no MÁXIMO uma vez por frame, e nem isso quando tanque e torre estão parados —
   * ~6 KB/s no pior caso, contra os 3,35 MB/s que motivaram a limpeza do slab test na Fase 4.
   * As pontas do raio (`miraDe`/`miraPara`) e as paredes infladas são reaproveitadas.
   */
  private atualizarLinhaDeMira(): void {
    if (!this.miraLigada || !this.meVivo || this.paredesDaBala.length === 0) {
      this.miraLayer.visible = false;
      // Invalida o cache: ao reaparecer, a linha tem de ser recalculada mesmo parada no lugar.
      this.miraCacheX = Number.NaN;
      return;
    }

    const ang = this.meTurret;
    if (this.meX === this.miraCacheX && this.meY === this.miraCacheY && ang === this.miraCacheAng) {
      this.miraLayer.visible = this.miraCacheVisivel;
      return;
    }
    this.miraCacheX = this.meX;
    this.miraCacheY = this.meY;
    this.miraCacheAng = ang;
    this.miraCacheVisivel = false;

    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    // O raio parte do CENTRO do tanque, não da boca: assim ele também pega o caso de estar
    // encostado numa parede com a torre virada para ela — o mesmo cuidado que `stepTanks` tem
    // antes de fazer a bala nascer. `circleVsAabbSlide` garante que o centro nunca está dentro
    // de uma parede inflada (TANK_RADIUS > BULLET_RADIUS), então o raio nunca começa por dentro.
    this.miraDe.x = this.meX;
    this.miraDe.y = this.meY;
    this.miraPara.x = this.meX + dx * this.diagonalDoMundo;
    this.miraPara.y = this.meY + dy * this.diagonalDoMundo;

    const hit = raycastSegment(this.miraDe, this.miraPara, this.paredesDaBala);
    const comprimento = (hit?.distance ?? 0) - MIRA_OFFSET_BOCA;
    // Sem parede à frente (impossível dentro da borda do labirinto) ou cano colado nela: nada a
    // mostrar — uma linha de 2 px só sujaria o tanque.
    if (!hit || comprimento < 1) {
      this.miraLayer.visible = false;
      return;
    }

    this.redesenharLinhaDeMira(this.meCor);
    this.miraCacheVisivel = true;
    this.miraLayer.visible = true;

    const bocaX = this.meX + dx * MIRA_OFFSET_BOCA;
    const bocaY = this.meY + dy * MIRA_OFFSET_BOCA;
    this.miraLinha.position.set(bocaX, bocaY);
    this.miraLinha.rotation = ang;
    this.miraLinha.width = comprimento;
    this.miraQuente.position.set(bocaX, bocaY);
    this.miraQuente.rotation = ang;
    this.miraQuente.width = Math.min(MIRA_TRECHO_QUENTE, comprimento);

    this.miraMarca.position.set(hit.point.x, hit.point.y);
    // Girar pela NORMAL deixa o tracinho rente à parede: é o que dá a leitura do ângulo de saída.
    this.miraMarca.rotation = Math.atan2(hit.normal.y, hit.normal.x);
  }

  /** Repinta linha e marca na cor de quem está jogando. Uma vez por cor, nunca por frame. */
  private redesenharLinhaDeMira(cor: number): void {
    if (this.corDaMira === cor) return;
    this.corDaMira = cor;
    // Clarear a cor do jogador iguala a leitura das 10 sobre o piso azul-ardósia: os tons mais
    // fechados da paleta (índigo, roxo) sumiriam nesta translucidez, os já claros mal mudam.
    const tinta = lighten(cor, 0.45);
    this.miraLinha.tint = tinta;
    this.miraQuente.tint = tinta;

    const g = this.miraMarca;
    g.clear();
    g.moveTo(0, -MIRA_MARCA_METADE).lineTo(0, MIRA_MARCA_METADE).stroke({ width: 2, color: tinta, alpha: 0.5 });
    g.circle(0, 0, 1.9).fill({ color: tinta, alpha: 0.62 });
  }

  /**
   * Monta a etiqueta de confirmação de abate — "+1" gordo na cor de quem matou, com o nome da
   * vítima logo abaixo, na cor DELA — e o anel do pulso que a acompanha.
   *
   * `BitmapText` e não `Text`: a etiqueta vive dentro do mundo e reaparece a cada abate, e um
   * `Text` novo por morte significaria gerar uma textura no frame mais cheio do jogo — o mesmo
   * motivo pelo qual o nome sobre o tanque já é `BitmapText`. Aqui os dois nós são criados uma
   * única vez e depois só trocam texto, cor e posição.
   */
  private montarConfirmacaoDeAbate(): { mais: BitmapText; nome: BitmapText } {
    const mais = new BitmapText({
      text: '+1',
      style: { fontFamily: 'Chakra Petch', fontSize: 26, fontWeight: '700', fill: 0xffffff, stroke: { color: 0x0a0e18, width: 5 } },
    });
    mais.anchor.set(0.5, 1);
    const nome = new BitmapText({
      text: '',
      style: { fontFamily: 'Sora', fontSize: 12, fontWeight: '700', fill: 0xffffff, stroke: { color: 0x0a0e18, width: 4 }, letterSpacing: 0.6 },
    });
    nome.anchor.set(0.5, 0);
    nome.y = 2;
    this.abateRoot.addChild(mais, nome);
    this.abateRoot.visible = false;
    // Traço fino de propósito: o anel é ESCALADO na animação, e a espessura cresce junto — a 1,7×
    // um traço grosso viraria um disco.
    this.abateAnel.circle(0, 0, ABATE_ANEL_RAIO).stroke({ width: 2.6, color: 0xffffff, alpha: 0.9 });
    return { mais, nome };
  }

  /**
   * Etiquetas de "AUTOGOL!". Um punhado reaproveitado em rodízio: duas pessoas podem se explodir
   * no mesmo tick, e criar nó por evento seria alocar exatamente no frame da explosão.
   */
  private montarEtiquetasDeAutogol(): void {
    for (let i = 0; i < AUTOGOL_POOL; i++) {
      const root = new Container();
      const texto = new BitmapText({
        text: 'AUTOGOL!',
        style: {
          fontFamily: 'Chakra Petch',
          fontSize: 19,
          fontWeight: '700',
          fill: COR_AUTOGOL,
          stroke: { color: 0x0a0e18, width: 5 },
          letterSpacing: 1.4,
        },
      });
      texto.anchor.set(0.5, 0.5);
      root.addChild(texto);
      root.visible = false;
      this.labelLayer.addChild(root);
      this.autogolTags.push({ root, vida: 0, x: 0, y: 0 });
    }
  }

  /**
   * `true` quando `cor` é a do tanque do jogador local. É por aqui que o HUD descobre se o abate
   * que acabou de entrar no killfeed foi DELE — a cor é única por jogador dentro de uma partida,
   * ao contrário do nome, que ninguém impede de repetir.
   */
  souOJogadorLocal(cor: number): boolean {
    return this.meConhecido && cor === this.meCor;
  }

  /**
   * Confirmação de abate para o jogador local: "+1" com o nome da vítima subindo do próprio
   * tanque e um pulso na cor de quem matou. Dois abates seguidos viram "+2" em vez de reiniciar
   * a etiqueta do zero — num ricochete duplo o número é a informação, não a repetição.
   */
  confirmarAbate(vitimaNome: string, vitimaCor: number): void {
    this.abateCombo = this.abateVida > ABATE_VIDA_S - ABATE_COMBO_S ? this.abateCombo + 1 : 1;
    this.abateVida = ABATE_VIDA_S;
    this.abateAnelVida = ABATE_ANEL_VIDA_S;
    this.abateX = this.meX;
    this.abateY = this.meY;

    const texto = '+' + this.abateCombo;
    if (this.abateMais.text !== texto) this.abateMais.text = texto;
    if (this.abateNome.text !== vitimaNome) this.abateNome.text = vitimaNome;
    this.abateMais.tint = lighten(this.meCor, 0.3);
    this.abateNome.tint = lighten(vitimaCor, 0.25);
    this.abateAnel.tint = this.meCor;
    this.abateRoot.visible = true;
    this.abateRoot.alpha = 1;
    this.abateRoot.scale.set(0.55);
    this.abateAnel.visible = true;
    this.abateAnel.alpha = 0.85;
    this.abateAnel.scale.set(0.45);
    this.abateRoot.position.set(this.abateX, this.abateY - ABATE_ALTURA);
    this.abateAnel.position.set(this.abateX, this.abateY);
  }

  /**
   * Etiqueta de autogol sobre o tanque de quem se explodiu — de QUALQUER jogador. A posição sai
   * do próprio tanque (achado pela cor, que é única na partida); sem ele em cena, a etiqueta é
   * descartada em silêncio, porque um "AUTOGOL!" flutuando no vazio não conta piada nenhuma.
   */
  marcarAutogol(vitimaCor: number): void {
    let alvo: TankView | null = null;
    for (const tank of this.tanks.values()) {
      if (tank.color === vitimaCor) {
        alvo = tank;
        break;
      }
    }
    if (!alvo) return;
    const tag = this.autogolTags[this.autogolProximo % this.autogolTags.length];
    if (!tag) return;
    this.autogolProximo += 1;
    tag.vida = AUTOGOL_VIDA_S;
    tag.x = alvo.root.x;
    tag.y = alvo.root.y - AUTOGOL_ALTURA;
    tag.root.visible = true;
    tag.root.position.set(tag.x, tag.y);
    tag.root.scale.set(0.6);
    tag.root.alpha = 1;
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
    // A morte súbita remove UMA parede e repassa o MESMO objeto de labirinto; só um labirinto
    // novo (rodada nova) manda a arena se montar outra vez. Sem esta comparação a arena inteira
    // se remontaria no meio do tiroteio.
    const outroLabirinto = maze !== this.currentMaze;
    this.currentMaze = maze;
    this.worldWidth = maze.cols * maze.cell;
    this.worldHeight = maze.rows * maze.cell;

    this.mazeView.setMaze(maze);
    this.shadowMask.clear().rect(0, 0, this.worldWidth, this.worldHeight).fill(0xffffff);
    // Geometria da linha de mira, montada uma vez por labirinto (ver `atualizarLinhaDeMira`).
    // A diagonal é o comprimento máximo do raio: dentro da borda do labirinto ela sempre alcança
    // uma parede, venha o tiro de onde vier.
    this.paredesDaBala = maze.walls.map((w) => ({
      x: w.x - BULLET_RADIUS,
      y: w.y - BULLET_RADIUS,
      w: w.w + BULLET_RADIUS * 2,
      h: w.h + BULLET_RADIUS * 2,
    }));
    this.diagonalDoMundo = Math.hypot(this.worldWidth, this.worldHeight);
    this.miraCacheX = Number.NaN;
    // Enquadrar ANTES de recriar os decalques: a textura deles é dimensionada pela escala da
    // câmera, e a escala só existe depois do `fitCamera` do labirinto novo. Fora de ordem, uma
    // arena ultrawide (câmera ~2,1×) ganharia uma textura de decalque na escala da rodada
    // anterior e as marcas de esteira sairiam borradas.
    this.fitCamera();
    this.decals.reset(this.worldWidth, this.worldHeight, this.baseScale * this.app.renderer.resolution);
    this.particles.setWorldBounds(this.worldWidth, this.worldHeight);
    if (outroLabirinto) this.iniciarMontagem(maze);
    // A rodada nova devolve a cor: mesmo que o `sync()` da partida anterior tenha deixado o mundo
    // cinza, o labirinto novo já começa colorido (ver V2 §3).
    this.post.setMundoCinza(false);
    // Nota: `runtime` (odômetro/wasAlive por tanque) NÃO é limpo aqui — os tanques em si
    // continuam existindo entre rounds (mesmos ids). Limpar o Map faria sync() reencontrar
    // `!rt` para tanques já existentes e criar TankView duplicadas por cima das antigas.
    // O salto de posição para o novo spawn já é tratado pelo guard de teleporte em sync().
  }

  sync(view: RenderView): void {
    this.meId = view.me;
    this.meVivo = false;
    this.meConhecido = false;
    let algumAdversarioVivo = false;
    const seenIds = new Set<string>();

    for (const t of view.tanks) {
      seenIds.add(t.id);
      if (t.id === view.me) {
        this.meX = t.x;
        this.meY = t.y;
        this.meCor = t.color;
        this.meVivo = t.alive;
        this.meConhecido = true;
        this.meTurret = t.turret;
      } else if (t.alive) {
        algumAdversarioVivo = true;
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
    this.atualizarLinhaDeMira();

    // V2 §3: o mundo perde a cor enquanto EU estou eliminado e a rodada continua sem mim. Exigir
    // um adversário vivo é o que atende à regra "no fim de partida, com todo mundo morto, o mundo
    // não fica cinza" — ali quem manda é a tela de resultado.
    this.post.setMundoCinza(this.meConhecido && !this.meVivo && algumAdversarioVivo);
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
      this.holofoteLargada.alpha = this.focoMarca * this.montagemTanques * (0.42 + 0.2 * pulso);
      this.anelLargada.position.set(this.meX, this.meY);
      this.anelLargada.scale.set(0.86 + 0.2 * pulso);
      this.anelLargada.alpha = this.focoMarca * this.montagemTanques * (0.5 + 0.5 * pulso);

      const acima = this.meY > SETA_DIST + 10;
      const salto = pulso * 5;
      this.setaLargada.position.set(this.meX, this.meY + (acima ? -SETA_DIST - salto : SETA_DIST + salto));
      this.setaLargada.rotation = acima ? 0 : Math.PI;
      this.setaLargada.alpha = this.focoMarca * this.montagemTanques;
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
   * Prepara a montagem da arena (V2 §1): mede cada parede, sorteia o atraso dela pela distância
   * até o centro e zera as camadas que vão entrar em sequência.
   *
   * O custo acontece UMA vez por rodada, não por frame: o laço por frame só lê este `Float32Array`.
   */
  private iniciarMontagem(maze: Maze): void {
    const centroX = this.worldWidth / 2;
    const centroY = this.worldHeight / 2;
    const n = maze.walls.length;
    if (this.montagemGeo.length < n * 5) this.montagemGeo = new Float32Array(n * 5);
    const geo = this.montagemGeo;
    this.montagemAlcance = Math.max(1, Math.hypot(centroX, centroY));

    for (let i = 0; i < n; i++) {
      const w = maze.walls[i]!;
      const wx = w.x + w.w / 2;
      const wy = w.y + w.h / 2;
      const o = i * 5;
      // O centro é deslocado por METADE da extrusão de `MazeView` (4 px a leste, 7 ao sul): é a
      // silhueta extrudada que aparece na tela, não o AABB da colisão.
      geo[o] = wx + 2;
      geo[o + 1] = wy + 3.5;
      geo[o + 2] = w.w / 2 + MONTAGEM_PAD;
      geo[o + 3] = w.h / 2 + MONTAGEM_PAD;
      geo[o + 4] = Math.min(1, Math.hypot(wx - centroX, wy - centroY) / this.montagemAlcance) * MONTAGEM_ONDA_S;
    }

    this.montagemQtd = n;
    this.montagemT = 0;
    this.montagemTanques = 0;
    this.mascaraParedes.clear();
    this.mazeView.wallLayer.mask = this.mascaraParedes;
    if (this.sombraAlphaBase < 0) this.sombraAlphaBase = this.mazeView.wallShadowLayer.alpha;
    this.mazeView.floorLayer.alpha = 0;
    this.mazeView.wallShadowLayer.alpha = 0;
    this.entitiesLayer.alpha = 0;
    this.labelLayer.alpha = 0;
  }

  /**
   * Um frame da montagem. Piso, paredes e tanques têm janelas de tempo próprias — é a hierarquia
   * de leitura que dá sentido à espera: primeiro o chão, depois o labirinto, os tanques por último.
   *
   * O laço reconstrói a máscara inteira a cada frame. São ~100 retângulos num ÚNICO `fill()`,
   * durante 1 s por rodada e num momento em que a simulação está parada (ninguém anda nem atira
   * na contagem) — o orçamento de frame nesse trecho está praticamente vazio.
   */
  private atualizarMontagem(dt: number): void {
    if (this.montagemT < 0) return;
    this.montagemT += dt;
    const t = this.montagemT;

    this.mazeView.floorLayer.alpha = clamp01(t / MONTAGEM_PISO_S);

    const g = this.mascaraParedes;
    const geo = this.montagemGeo;
    g.clear();
    for (let i = 0; i < this.montagemQtd; i++) {
      const o = i * 5;
      const k = clamp01((t - MONTAGEM_PAREDES_INICIO_S - geo[o + 4]!) / MONTAGEM_PAREDE_S);
      if (k <= 0) continue;
      const e = saidaCubica(k);
      const hw = geo[o + 2]!;
      const hh = geo[o + 3]!;
      // Cresce só pelo eixo LONGO: a parede se ESTENDE a partir do meio, como uma peça deslizando
      // para o lugar. Crescer pelos dois eixos a faria inchar, que lê como balão, não como obra.
      const fx = hw >= hh ? e : 1;
      const fy = hw >= hh ? 1 : e;
      g.rect(geo[o]! - hw * fx, geo[o + 1]! - hh * fy, hw * 2 * fx, hh * 2 * fy);
    }
    g.fill(0xffffff);

    // Frente de onda: um anel quente que passa por cima das paredes no instante em que elas
    // nascem. É o que dá CAUSA à sequência — sem ele as paredes só apareceriam sozinhas.
    const onda = clamp01((t - MONTAGEM_PAREDES_INICIO_S) / MONTAGEM_ONDA_S);
    const acesa = onda > 0 && onda < 1;
    this.ondaMontagem.visible = acesa;
    if (acesa) {
      this.ondaMontagem
        .clear()
        .circle(this.worldWidth / 2, this.worldHeight / 2, 10 + onda * this.montagemAlcance)
        .stroke({ width: 5, color: WORLD_COLORS.warmLight, alpha: Math.sin(Math.PI * onda) * 0.4 });
    }

    const sombra = clamp01((t - MONTAGEM_SOMBRA_INICIO) / (MONTAGEM_TOTAL_S - MONTAGEM_SOMBRA_INICIO));
    this.mazeView.wallShadowLayer.alpha = this.sombraAlphaBase * sombra;

    this.montagemTanques = clamp01((t - MONTAGEM_TANQUES_INICIO_S) / MONTAGEM_TANQUES_S);
    this.entitiesLayer.alpha = this.montagemTanques;
    this.labelLayer.alpha = this.montagemTanques;

    if (t < MONTAGEM_TOTAL_S) return;

    // Fim: a máscara sai de cena (com ela vazia, o `Graphics` que volta a ser desenhável não
    // desenha nada) e todas as camadas voltam ao valor de regime.
    this.montagemT = -1;
    this.montagemTanques = 1;
    this.mazeView.wallLayer.mask = null;
    this.mascaraParedes.clear();
    this.ondaMontagem.visible = false;
    this.mazeView.floorLayer.alpha = 1;
    this.mazeView.wallShadowLayer.alpha = this.sombraAlphaBase;
    this.entitiesLayer.alpha = 1;
    this.labelLayer.alpha = 1;
    // A arena ASSENTA. O tranco é curto e cai ainda dentro da contagem, longe do primeiro tiro.
    this.juice.addTrauma(0.16);
  }

  /**
   * Um frame das confirmações de abate (V2 §2): a etiqueta "+N" do jogador local, o pulso na cor
   * dele e as etiquetas de autogol de quem quer que seja.
   *
   * Tudo aqui é transformação de nós que já existem — nenhum objeto nasce no frame da morte, que
   * é justamente o mais cheio do jogo.
   */
  private atualizarConfirmacoes(dt: number): void {
    if (this.abateVida > 0) {
      this.abateVida = Math.max(0, this.abateVida - dt);
      const k = 1 - this.abateVida / ABATE_VIDA_S;
      this.abateRoot.position.set(this.abateX, this.abateY - ABATE_ALTURA - ABATE_SUBIDA * saidaCubica(k));
      // Entra estourando e assenta: é o gesto que faz o número ser LIDO antes de começar a subir.
      const escala = k < 0.12 ? 0.55 + 5.25 * k : k < 0.3 ? 1.18 - ((k - 0.12) / 0.18) * 0.18 : 1;
      this.abateRoot.scale.set(escala);
      this.abateRoot.alpha = k < 0.6 ? 1 : Math.max(0, 1 - (k - 0.6) / 0.4);
      if (this.abateVida === 0) {
        this.abateRoot.visible = false;
        this.abateCombo = 0;
      }
    }

    if (this.abateAnelVida > 0) {
      this.abateAnelVida = Math.max(0, this.abateAnelVida - dt);
      const k = 1 - this.abateAnelVida / ABATE_ANEL_VIDA_S;
      this.abateAnel.scale.set(0.45 + 1.25 * saidaCubica(k));
      this.abateAnel.alpha = (1 - k) * 0.85;
      if (this.abateAnelVida === 0) this.abateAnel.visible = false;
    }

    for (const tag of this.autogolTags) {
      if (tag.vida <= 0) continue;
      tag.vida = Math.max(0, tag.vida - dt);
      const k = 1 - tag.vida / AUTOGOL_VIDA_S;
      tag.root.position.set(tag.x, tag.y - AUTOGOL_SUBIDA * saidaCubica(k));
      // Tremidinha de desenho animado, decrescente. É o que separa o autogol de um abate comum
      // antes mesmo de a pessoa ler a palavra.
      tag.root.rotation = Math.sin(k * 38) * 0.1 * (1 - k);
      tag.root.scale.set(k < 0.14 ? 0.5 + 4.57 * k : Math.max(1, 1.14 - ((k - 0.14) / 0.16) * 0.14));
      tag.root.alpha = k < 0.66 ? 1 : Math.max(0, 1 - (k - 0.66) / 0.34);
      if (tag.vida === 0) tag.root.visible = false;
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

    const dtRealS = deltaMs / 1000;
    this.atualizarMontagem(dtRealS);
    this.atualizarLargada(dtRealS);
    this.atualizarConfirmacoes(dtRealS);
    // Drenagem de cor em tempo REAL: o hitstop da morte congela o mundo por 60 ms e a cor tem que
    // continuar saindo por baixo dele.
    this.post.atualizarCor(dtRealS);

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
