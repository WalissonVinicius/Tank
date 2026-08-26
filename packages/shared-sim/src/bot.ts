import {
  BULLET_LIFE,
  BULLET_RADIUS,
  BULLET_SPEED,
  CELL,
  FIRE_COOLDOWN,
  MAX_BOUNCES,
  SELF_IMMUNITY,
  TANK_RADIUS,
  TANK_SPEED,
  TICK_HZ,
  TURRET_RATE,
} from '@tank/protocol';
import { circleVsAabbSlide, hasLineOfSight, raycastSegment } from './collision.js';
import { nextStepTowards } from './maze.js';
import type { Rng } from './rng.js';
import type { Aabb, Bullet, Input, Maze, Tank, Vec2 } from './types.js';

/**
 * Capacidades do bot, ligadas por dificuldade. Não é sistema de configuração: são três chaves
 * booleanas mais quatro números de "corpo" (mira, gatilho, reflexo e visão de ameaça), e as três
 * receitas prontas de `BOT_DIFFICULTY` são o que o jogo usa.
 */
export interface BotConfig {
  aimErrorRad: number; // erro de mira em radianos, maior = bot pior de mira
  turnThreshold: number; // rad — abaixo disso considera "já mirando" o suficiente para atirar
  /**
   * Tempo de reação, em ticks: de quantos em quantos ticks ele OLHA para o campo de balas. Entre
   * duas leituras ele age com a decisão anterior, como um jogador que ainda não processou o que
   * apareceu na tela. 1 = reflexo de máquina (olha todo tick).
   */
  ticksDeReacao: number;
  /**
   * Quantos segundos à frente ele enxerga na trajetória de uma bala. Curto = só percebe o que já
   * está em cima dele; longo = antecipa e sai da linha com folga. **Zero = não desvia**: ele nem
   * repara nas balas, e é isso que separa o fácil dos outros dois.
   */
  horizonteDeAmeaca: number;
  /** Sem linha de visão, procura um ângulo que quica 1× e chega no alvo. */
  ricocheteia: boolean;
  /** Simula o próprio tiro antes de puxar o gatilho e engole o que voltaria em cima dele. */
  evitaAutogol: boolean;
  /** Sob ameaça ou recarregando, procura posição sem linha de visão para o inimigo; mira antecipando. */
  usaParede: boolean;
}

/**
 * As três receitas do jogo, recalibradas para o movimento absoluto.
 *
 * O degrau entre elas não pode mais ser só capacidade booleana. Com o movimento absoluto SAIR DA
 * LINHA ficou barato para todo mundo (não há mais giro de chassi a pagar antes de andar para o
 * lado), e o antigo `desvia: true` idêntico nos três níveis nivelava o jogo por baixo: o fácil
 * ganhava com a mudança tanto quanto o difícil. O que separa os níveis agora é o CORPO —
 *
 *   · `horizonteDeAmeaca` — quanto de futuro ele enxerga. O fácil enxerga ZERO: ele entra na linha
 *     de tiro, que é o erro mais humano e mais reconhecível que um jogador ruim comete. O médio vê
 *     0,3 s (64 px): percebe a bala quando ela já está perto, e sai correndo em cima da hora. O
 *     difícil vê a vida inteira da bala E acompanha os ricochetes dela.
 *   · `ticksDeReacao` — quanto ele demora para processar o que vê. 16 ticks são 267 ms, reação de
 *     jogador de fim de tarde; 1 tick é reflexo de máquina.
 *   · `aimErrorRad` — o quanto a mão treme. 0,55 rad espalha o tiro do fácil por meia tela.
 *
 * E o freio de autogol virou exclusividade do difícil: o tiro que volta em cima do dono é a piada
 * central do jogo, e um bot que nunca cai nela é justamente o que separa "difícil" de "padrão".
 *
 * Placar medido em 100 duelos com lados trocados, nas mesmas seeds do `bot-esperto.test.ts`:
 * difícil 88 × 12 fácil, difícil 77 × 23 médio, médio 68 × 31 fácil. Numa amostra de 300 seeds
 * espalhadas os mesmos confrontos dão 86% e 76%, então o número oficial não é sorte de seed.
 */
export const BOT_DIFFICULTY: Record<'facil' | 'medio' | 'dificil', BotConfig> = {
  facil: {
    aimErrorRad: 0.55,
    turnThreshold: 0.3,
    ticksDeReacao: 12,
    horizonteDeAmeaca: 0,
    ricocheteia: false,
    evitaAutogol: false,
    usaParede: false,
  },
  medio: {
    aimErrorRad: 0.16,
    turnThreshold: 0.13,
    ticksDeReacao: 16,
    horizonteDeAmeaca: 0.3,
    ricocheteia: true,
    evitaAutogol: false,
    usaParede: false,
  },
  dificil: {
    aimErrorRad: 0.005,
    turnThreshold: 0.04,
    ticksDeReacao: 1,
    horizonteDeAmeaca: BULLET_LIFE,
    ricocheteia: true,
    evitaAutogol: true,
    usaParede: true,
  },
};

/** O que o bot enxerga além do labirinto e do inimigo. Ausente = ele decide só com a geometria. */
export interface BotMundo {
  /** Balas em voo, inclusive as dele — a própria bala também mata depois de `SELF_IMMUNITY`. */
  bullets: readonly Bullet[];
}

function normalizeAngle(a: number): number {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r < -Math.PI) r += Math.PI * 2;
  return r;
}

// ------------------------------------------------------------------------------------------
// Traçado de tiro — a mesma trajetória serve para mirar com ricochete E para não se matar
// ------------------------------------------------------------------------------------------

/** Alcance máximo de uma bala, em px: ela morre por tempo de vida antes de percorrer mais que isso. */
const ALCANCE_BALA = BULLET_SPEED * BULLET_LIFE;
/** Distância entre centros abaixo da qual a bala encosta no tanque. */
const RAIO_ACERTO = TANK_RADIUS + BULLET_RADIUS;
/** Distância que a bala já percorreu quando a imunidade ao próprio tiro acaba. */
const VOO_ATE_FICAR_LETAL = SELF_IMMUNITY * BULLET_SPEED;
/** Offset da boca do cano, igual ao de `stepTanks` em sim.ts — a bala nasce daqui, não do centro. */
const OFFSET_DA_BOCA = TANK_RADIUS + BULLET_RADIUS + 4;

const paredesDaBalaPorLabirinto = new WeakMap<Maze, readonly Aabb[]>();

/** Mesma expansão usada por `stepTanks` e `stepBullets`, calculada uma vez por labirinto. */
function paredesParaBala(maze: Maze): readonly Aabb[] {
  const existentes = paredesDaBalaPorLabirinto.get(maze);
  if (existentes) return existentes;
  const infladas = maze.walls.map((parede) => ({
    x: parede.x - BULLET_RADIUS,
    y: parede.y - BULLET_RADIUS,
    w: parede.w + BULLET_RADIUS * 2,
    h: parede.h + BULLET_RADIUS * 2,
  }));
  paredesDaBalaPorLabirinto.set(maze, infladas);
  return infladas;
}

interface Trecho {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Distância já percorrida pela bala quando ela entra neste trecho. */
  d0: number;
}

// Pool de trechos reaproveitado entre chamadas, mesmo padrão do resto da simulação: traçar tiro
// roda dezenas de vezes por bot em cada replanejamento, e alocar aqui devolveria o lixo de GC que
// a Fase 4 eliminou. Tudo síncrono e single-thread — nenhuma dessas funções reentra.
const trechos: Trecho[] = [];
let nTrechos = 0;

function empurrarTrecho(x0: number, y0: number, x1: number, y1: number, d0: number): void {
  let t = trechos[nTrechos];
  if (t === undefined) {
    t = { x0: 0, y0: 0, x1: 0, y1: 0, d0: 0 };
    trechos[nTrechos] = t;
  }
  t.x0 = x0;
  t.y0 = y0;
  t.x1 = x1;
  t.y1 = y1;
  t.d0 = d0;
  nTrechos++;
}

/**
 * Percorre a trajetória de um tiro saído de (`ox`,`oy`) no ângulo `angulo`, refletindo nas
 * paredes até `MAX_BOUNCES` e parando no alcance da bala. O resultado fica em `trechos`.
 *
 * Usa as paredes infladas pelo raio da bala, exatamente como a simulação. Elas ficam num cache
 * por labirinto para que a precisão extra não recrie a geometria a cada tentativa de mira.
 */
function tracarTiro(ox: number, oy: number, angulo: number, maze: Maze): void {
  nTrechos = 0;
  let x = ox;
  let y = oy;
  let dx = Math.cos(angulo);
  let dy = Math.sin(angulo);
  let restante = ALCANCE_BALA;
  let percorrido = 0;
  let quicadas = 0;

  const de: Vec2 = { x: 0, y: 0 };
  const para: Vec2 = { x: 0, y: 0 };
  const paredes = paredesParaBala(maze);

  while (restante > 1 && nTrechos <= MAX_BOUNCES + 1) {
    de.x = x;
    de.y = y;
    para.x = x + dx * restante;
    para.y = y + dy * restante;
    const hit = raycastSegment(de, para, paredes);
    if (!hit) {
      empurrarTrecho(x, y, para.x, para.y, percorrido);
      return;
    }

    empurrarTrecho(x, y, hit.point.x, hit.point.y, percorrido);
    percorrido += hit.distance;
    restante -= hit.distance;
    // O rebote de nº MAX_BOUNCES + 1 mata a bala (constants.ts): daqui não sai mais trajetória.
    if (quicadas >= MAX_BOUNCES) return;
    quicadas++;

    // Reflexão em linha, sem passar por `reflect()`: aqui dentro ela roda milhares de vezes por
    // segundo e o Vec2 de retorno virava lixo de GC — e é a coleta que produz os picos de tick.
    const projecao = dx * hit.normal.x + dy * hit.normal.y;
    dx -= 2 * projecao * hit.normal.x;
    dy -= 2 * projecao * hit.normal.y;
    x = hit.point.x + hit.normal.x * 0.05;
    y = hit.point.y + hit.normal.y * 0.05;
  }
}

/**
 * Menor distância entre o ponto (`px`,`py`) e a trajetória traçada, considerando só o pedaço dela
 * percorrido DEPOIS de `voarPeloMenos` px. É esse recorte que separa "a bala volta em cima de
 * mim" de "a bala está saindo de dentro de mim agora" — nos primeiros `VOO_ATE_FICAR_LETAL` px o
 * dono é imune ao próprio tiro.
 */
function distanciaAteATrajetoria(px: number, py: number, voarPeloMenos: number): number {
  let melhor = Infinity;
  for (let i = 0; i < nTrechos; i++) {
    const t = trechos[i]!;
    const dx = t.x1 - t.x0;
    const dy = t.y1 - t.y0;
    const comprimento = Math.hypot(dx, dy);
    if (comprimento < 1e-6) continue;

    const sMin = voarPeloMenos - t.d0;
    if (sMin > comprimento) continue;

    let s = ((px - t.x0) * dx + (py - t.y0) * dy) / comprimento;
    if (s < sMin) s = sMin;
    if (s < 0) s = 0;
    if (s > comprimento) s = comprimento;

    const qx = t.x0 + (dx / comprimento) * s;
    const qy = t.y0 + (dy / comprimento) * s;
    const d = Math.hypot(px - qx, py - qy);
    if (d < melhor) melhor = d;
  }
  return melhor;
}

/** Distância entre a trajetória de um tiro nesse ângulo e o alvo — quanto menor, melhor a mira. */
function erroDoTiro(tank: Tank, angulo: number, alvo: Vec2, maze: Maze): number {
  tracarTiroDoTanque(tank, angulo, maze);
  return distanciaAteATrajetoria(alvo.x, alvo.y, 0);
}

/**
 * Traça desde o ponto onde a bala realmente nascerá. Quando o cano atravessa uma parede inflada,
 * `stepTanks` recorta centro→boca e encosta a bala do lado interno antes do primeiro movimento.
 */
function tracarTiroDoTanque(tank: Tank, angulo: number, maze: Maze): void {
  const boca = {
    x: tank.x + Math.cos(angulo) * OFFSET_DA_BOCA,
    y: tank.y + Math.sin(angulo) * OFFSET_DA_BOCA,
  };
  const centro = { x: tank.x, y: tank.y };
  const bloqueio = raycastSegment(centro, boca, paredesParaBala(maze));
  const x = bloqueio ? bloqueio.point.x + bloqueio.normal.x * 1e-4 : boca.x;
  const y = bloqueio ? bloqueio.point.y + bloqueio.normal.y * 1e-4 : boca.y;
  tracarTiro(x, y, angulo, maze);
}

/**
 * O tiro que sair neste ângulo volta em cima de quem atirou? Traça a trajetória inteira e olha
 * só o trecho já letal (depois da janela de `SELF_IMMUNITY`). É a checagem que faz o bot difícil
 * engolir o gatilho no corredor curto em vez de virar a piada da rodada.
 */
function autogolProvavel(tank: Tank, angulo: number, maze: Maze): boolean {
  tracarTiroDoTanque(tank, angulo, maze);
  return distanciaAteATrajetoria(tank.x, tank.y, VOO_ATE_FICAR_LETAL) <= RAIO_ACERTO + 3;
}

// ------------------------------------------------------------------------------------------
// Trajetória prevista de cada bala — calculada UMA vez por bala por tick, não uma por bot
// ------------------------------------------------------------------------------------------

/**
 * Um trecho reto do voo futuro de uma bala. `dx`/`dy` são unitários e `d0` é a distância já
 * percorrida quando ela entra aqui — dividir por `BULLET_SPEED` converte para segundos.
 */
interface TrechoDeVoo {
  x: number;
  y: number;
  dx: number;
  dy: number;
  comprimento: number;
  d0: number;
}

/** Trajetória futura de uma bala + o estado dela que gerou essa previsão (o "selo" do cache). */
interface VooPrevisto {
  maze: Maze | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  bounces: number;
  age: number;
  trechos: TrechoDeVoo[];
  n: number;
}

// A previsão do voo de uma bala não depende de QUEM está perguntando: é função pura da bala e do
// labirinto. Sem este cache, os 10 bots da sala refaziam o mesmo raycast de ricochete para as
// mesmas 30 balas em todo tick — 10× o trabalho e 10× o lixo de GC, que é o que estourava o
// orçamento do tick. Como o valor guardado é idêntico ao recalculado, compartilhar entre bots
// (e até entre salas do mesmo processo) não interfere no determinismo de ninguém.
const vooPorBala = new WeakMap<Bullet, VooPrevisto>();

function preverVoo(bala: Bullet, maze: Maze): VooPrevisto {
  let voo = vooPorBala.get(bala);
  if (
    voo !== undefined &&
    voo.maze === maze &&
    voo.x === bala.x &&
    voo.y === bala.y &&
    voo.vx === bala.vx &&
    voo.vy === bala.vy &&
    voo.bounces === bala.bounces &&
    voo.age === bala.age
  ) {
    return voo;
  }
  if (voo === undefined) {
    voo = { maze: null, x: 0, y: 0, vx: 0, vy: 0, bounces: 0, age: 0, trechos: [], n: 0 };
    vooPorBala.set(bala, voo);
  }
  voo.maze = maze;
  voo.x = bala.x;
  voo.y = bala.y;
  voo.vx = bala.vx;
  voo.vy = bala.vy;
  voo.bounces = bala.bounces;
  voo.age = bala.age;
  voo.n = 0;

  const velocidade = Math.hypot(bala.vx, bala.vy);
  if (velocidade < 1e-6) return voo;

  let dx = bala.vx / velocidade;
  let dy = bala.vy / velocidade;
  let x = bala.x;
  let y = bala.y;
  let restante = Math.max(0, BULLET_LIFE - bala.age) * velocidade;
  let percorrido = 0;
  let quicadas = bala.bounces;

  const de: Vec2 = { x: 0, y: 0 };
  const para: Vec2 = { x: 0, y: 0 };
  const paredes = paredesParaBala(maze);

  while (restante > 1e-6 && voo.n <= MAX_BOUNCES + 1) {
    de.x = x;
    de.y = y;
    para.x = x + dx * restante;
    para.y = y + dy * restante;
    const hit = raycastSegment(de, para, paredes);
    const comprimento = hit ? restante * hit.t : restante;

    let t = voo.trechos[voo.n];
    if (t === undefined) {
      t = { x: 0, y: 0, dx: 0, dy: 0, comprimento: 0, d0: 0 };
      voo.trechos[voo.n] = t;
    }
    t.x = x;
    t.y = y;
    t.dx = dx;
    t.dy = dy;
    t.comprimento = comprimento;
    t.d0 = percorrido;
    voo.n++;

    if (!hit) return voo;
    percorrido += comprimento;
    restante -= comprimento;
    if (quicadas >= MAX_BOUNCES) return voo;
    quicadas++;

    const projecao = dx * hit.normal.x + dy * hit.normal.y;
    dx -= 2 * projecao * hit.normal.x;
    dy -= 2 * projecao * hit.normal.y;
    x = hit.point.x + hit.normal.x * 0.05;
    y = hit.point.y + hit.normal.y * 0.05;
  }
  return voo;
}

// ------------------------------------------------------------------------------------------
// Desvio de bala
// ------------------------------------------------------------------------------------------

/** Folga além do raio de acerto: reagir só ao que passaria raspando é reagir tarde demais. */
const MARGEM_DE_AMEACA = 10;

let ameacaVx = 0;
let ameacaVy = 0;
let ameacaBx = 0;
let ameacaBy = 0;

/**
 * A bala mais urgente que vai passar em cima deste tanque, ou `null`. Publica a velocidade dela
 * em `ameacaVx/Vy` (é dela que sai a direção de fuga) e devolve em quantos segundos o encontro
 * acontece.
 *
 * O teste é o mesmo mínimo de distância relativa que a colisão bala×bala usa: em cada trecho a
 * posição relativa anda em linha reta, então o instante de aproximação máxima sai da derivada.
 * `preveRicochete` decide se ele acompanha a bala depois de ela quicar; `horizonteSegundos` é
 * quanto de futuro ele enxerga — os dois saem da dificuldade.
 */
function ameacaMaisUrgente(
  tank: Tank,
  bullets: readonly Bullet[],
  maze: Maze,
  preveRicochete: boolean,
  horizonteSegundos: number,
): number | null {
  const limite = RAIO_ACERTO + MARGEM_DE_AMEACA;
  let melhorT = Infinity;
  const posBala: Vec2 = { x: 0, y: 0 };
  const posTanque: Vec2 = { x: tank.x, y: tank.y };

  for (const bala of bullets) {
    const velocidade = Math.hypot(bala.vx, bala.vy);
    if (velocidade < 1e-6) continue;
    const horizonte = Math.min(BULLET_LIFE - bala.age, horizonteSegundos);
    if (horizonte <= 0) continue;

    const alcance = horizonte * velocidade;
    const voo = preverVoo(bala, maze);
    // Sem previsão de ricochete o bot só enxerga o trecho retilíneo em que a bala está agora.
    const ateTrecho = preveRicochete ? voo.n : Math.min(voo.n, 1);
    // Distância que a bala ainda precisa voar para ficar letal para o próprio dono.
    const letalA = bala.ownerId === tank.id ? (SELF_IMMUNITY - bala.age) * velocidade : -Infinity;

    for (let i = 0; i < ateTrecho; i++) {
      const t = voo.trechos[i]!;
      if (t.d0 >= alcance) break;
      const comprimento = Math.min(t.comprimento, alcance - t.d0);
      const inicio = Math.max(0, letalA - t.d0);
      if (inicio > comprimento) continue;

      const px = t.x - tank.x;
      const py = t.y - tank.y;
      let s = -(px * t.dx + py * t.dy);
      if (s < inicio) s = inicio;
      else if (s > comprimento) s = comprimento;

      const encontro = (t.d0 + s) / velocidade;
      if (encontro >= melhorT) continue;
      const ex = px + t.dx * s;
      const ey = py + t.dy * s;
      if (Math.hypot(ex, ey) > limite) continue;

      posBala.x = t.x + t.dx * s;
      posBala.y = t.y + t.dy * s;
      if (!hasLineOfSight(posBala, posTanque, maze.walls)) continue;

      melhorT = encontro;
      ameacaVx = t.dx * velocidade;
      ameacaVy = t.dy * velocidade;
      ameacaBx = t.x;
      ameacaBy = t.y;
    }
  }

  return melhorT === Infinity ? null : melhorT;
}

/** O ponto está livre de parede para um tanque inteiro (não só para um raio de laser)? */
function cabeTanque(x: number, y: number, maze: Maze): boolean {
  const ajustado = circleVsAabbSlide({ x, y }, TANK_RADIUS, maze.walls);
  return Math.hypot(ajustado.x - x, ajustado.y - y) < 1;
}

/** Distância percorrida ao sair da linha de tiro, em px. Menos que isso não tira o tanque da frente. */
const PASSO_DE_FUGA = CELL * 0.85;

/**
 * Para onde correr para sair da linha da bala: perpendicular à trajetória dela, para o lado em
 * que o tanque JÁ está (aumentar um desvio que existe é sempre mais curto que atravessar a frente
 * do tiro). Se a parede fecha esse lado, tenta o outro; se os dois estão fechados, não há desvio
 * a fazer e o bot segue com o plano que tinha.
 */
function escolherFuga(tank: Tank, maze: Maze, desempate: 1 | -1): number | null {
  const anguloDaBala = Math.atan2(ameacaVy, ameacaVx);
  // Sinal do produto vetorial entre a velocidade da bala e o vetor bala→tanque: diz de que lado
  // da trajetória o tanque está.
  const cross = ameacaVx * (tank.y - ameacaBy) - ameacaVy * (tank.x - ameacaBx);
  const preferido = cross === 0 ? desempate : cross > 0 ? 1 : -1;

  for (const lado of [preferido, -preferido]) {
    const angulo = normalizeAngle(anguloDaBala + (Math.PI / 2) * lado);
    if (cabeTanque(tank.x + Math.cos(angulo) * PASSO_DE_FUGA, tank.y + Math.sin(angulo) * PASSO_DE_FUGA, maze)) {
      return angulo;
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------
// Cobertura
// ------------------------------------------------------------------------------------------

/** Direções testadas ao procurar parede para se esconder. */
const DIRECOES_DE_COBERTURA = 8;
const PASSO_DE_COBERTURA = CELL * 1.15;

/**
 * Um ponto a uma célula daqui que quebre a linha de visão do inimigo. Entre os que servem, o mais
 * próximo da direção em que o tanque já vai — girar deixou de custar tempo com o movimento
 * absoluto, mas manter o rumo evita ziguezague entre duas coberturas igualmente boas.
 */
function procurarCobertura(tank: Tank, alvo: Vec2, maze: Maze): number | null {
  let melhorAngulo: number | null = null;
  let melhorGiro = Infinity;
  const ponto: Vec2 = { x: 0, y: 0 };

  for (let i = 0; i < DIRECOES_DE_COBERTURA; i++) {
    const angulo = (i * Math.PI * 2) / DIRECOES_DE_COBERTURA;
    ponto.x = tank.x + Math.cos(angulo) * PASSO_DE_COBERTURA;
    ponto.y = tank.y + Math.sin(angulo) * PASSO_DE_COBERTURA;
    if (!cabeTanque(ponto.x, ponto.y, maze)) continue;
    if (hasLineOfSight(ponto, alvo, maze.walls)) continue;

    const giro = Math.abs(normalizeAngle(angulo - tank.heading));
    if (giro < melhorGiro) {
      melhorGiro = giro;
      melhorAngulo = angulo;
    }
  }
  return melhorAngulo;
}

// ------------------------------------------------------------------------------------------
// Rota — o BFS do labirinto, memorizado por par de células
// ------------------------------------------------------------------------------------------

/** Índice linear da célula que contém o ponto, com o mesmo clamp de `cellOf` do maze.ts. */
function celulaDe(maze: Maze, x: number, y: number): number {
  let cx = Math.floor(x / maze.cell);
  let cy = Math.floor(y / maze.cell);
  if (cx < 0) cx = 0;
  else if (cx > maze.cols - 1) cx = maze.cols - 1;
  if (cy < 0) cy = 0;
  else if (cy > maze.rows - 1) cy = maze.rows - 1;
  return cy * maze.cols + cx;
}

const rotasPorLabirinto = new WeakMap<Maze, Map<number, Vec2 | null>>();
/** Teto da tabela de rotas por labirinto — passou disso, esvazia e recomeça. */
const MAXIMO_DE_ROTAS = 4096;

/**
 * `nextStepTowards` memorizado. O BFS só depende do par (célula de origem, célula de destino), e
 * numa sala de 10 bots quase todos perseguem alvos nas mesmas poucas células — sem o memo o mesmo
 * flood fill era refeito dezenas de vezes por segundo, alocando a grade inteira de novo a cada
 * chamada. `null` significa "não há passo intermediário, vá direto no alvo".
 */
function proximoPassoMemorizado(maze: Maze, tank: Tank, alvo: Vec2): Vec2 | null {
  const origem = celulaDe(maze, tank.x, tank.y);
  const destino = celulaDe(maze, alvo.x, alvo.y);
  if (origem === destino) return null;

  let tabela = rotasPorLabirinto.get(maze);
  if (tabela === undefined) {
    tabela = new Map();
    rotasPorLabirinto.set(maze, tabela);
  }
  const chave = origem * maze.cols * maze.rows + destino;
  const guardado = tabela.get(chave);
  if (guardado !== undefined) return guardado;

  // `nextStepTowards` devolve o PRÓPRIO `alvo` quando não há caminho — e nesse caso o valor
  // depende da posição exata do alvo, que não cabe num cache por célula.
  const passo = nextStepTowards(maze, tank, alvo);
  const valor = passo === alvo ? null : passo;
  if (tabela.size >= MAXIMO_DE_ROTAS) tabela.clear();
  tabela.set(chave, valor);
  return valor;
}

// ------------------------------------------------------------------------------------------
// Combate avançado
// ------------------------------------------------------------------------------------------

/**
 * Resolve o encontro entre a bala e um alvo que mantém a velocidade observada no último tick.
 * Se a projeção atravessaria parede ou sairia do alcance, conserva a mira atual: nesses casos o
 * tanque vai frear ou virar, portanto extrapolar sua reta seria pior que não antecipar.
 */
function miraAntecipada(tank: Tank, alvo: Vec2, vx: number, vy: number, maze: Maze): number {
  const rx = alvo.x - tank.x;
  const ry = alvo.y - tank.y;
  const a = vx * vx + vy * vy - BULLET_SPEED * BULLET_SPEED;
  const b = 2 * (rx * vx + ry * vy);
  const c = rx * rx + ry * ry;
  const discriminante = b * b - 4 * a * c;
  let tempo = -1;

  if (discriminante >= 0 && Math.abs(a) > 1e-6) {
    const raiz = Math.sqrt(discriminante);
    const t1 = (-b - raiz) / (2 * a);
    const t2 = (-b + raiz) / (2 * a);
    if (t1 > 0 && t2 > 0) tempo = Math.min(t1, t2);
    else if (t1 > 0) tempo = t1;
    else if (t2 > 0) tempo = t2;
  }

  if (tempo <= 0 || tempo > BULLET_LIFE) return Math.atan2(ry, rx);

  const previsto = { x: alvo.x + vx * tempo, y: alvo.y + vy * tempo };
  if (!cabeTanque(previsto.x, previsto.y, maze) || !hasLineOfSight(tank, previsto, maze.walls)) {
    return Math.atan2(ry, rx);
  }
  return Math.atan2(previsto.y - tank.y, previsto.x - tank.x);
}

// ------------------------------------------------------------------------------------------
// Montagem do input
// ------------------------------------------------------------------------------------------

/**
 * `rumoPara` e o par `turn`/`move` sumiram com o movimento absoluto: fugir, se cobrir e navegar
 * viraram um ÂNGULO só, que é o que `Input.mover` pede. O caso "destino atrás, dá ré em vez de
 * girar meia-volta" também deixou de existir — não há mais giro a pagar antes de andar.
 */

/** Ângulo que a torre terá depois do giro deste tick, imediatamente antes de `stepTanks` atirar. */
function anguloDoDisparoNesteTick(tank: Tank, aim: number | undefined): number {
  if (aim === undefined) return tank.turret;
  const diff = normalizeAngle(aim - tank.turret);
  const passo = TURRET_RATE / TICK_HZ;
  if (Math.abs(diff) <= passo) return normalizeAngle(aim);
  return normalizeAngle(tank.turret + Math.sign(diff) * passo);
}

// IA determinística. O bot tem DUAS direções para cuidar, igual ao jogador: para onde anda e para
// onde a torre aponta. A primeira é imediata (movimento absoluto); a segunda o servidor limita a
// `TURRET_RATE`, então ele sofre a mesma espera de virar o cano que o jogador sofre.
//
// Todo o "acaso" (erro de mira) vem do RNG semeado recebido por parâmetro — nunca Math.random().
// O RNG é consumido UMA vez por decisão, sempre no mesmo ponto, para que a sequência não dependa
// do caminho tomado dentro do `think`.
export function botInput(
  tank: Tank,
  moveTarget: Vec2,
  anguloDeMira: number,
  temTiro: boolean,
  ruido: number,
  config: BotConfig,
): Input {
  // A estratégia não mudou: o bot continua querendo ir até `moveTarget` (o inimigo, o waypoint da
  // rota, o lado de fuga ou a cobertura, decididos lá em cima). O que mudou é só a TRADUÇÃO —
  // antes ela virava `turn`/`move`, agora entrega a direção pronta.
  const mover = Math.atan2(moveTarget.y - tank.y, moveTarget.x - tank.x);

  const aim = normalizeAngle(anguloDeMira + (ruido * 2 - 1) * config.aimErrorRad);
  // Tolerância de disparo proporcional à distância que a torre ainda consegue cobrir num tick:
  // sem isso um bot com `aimErrorRad` menor que a resolução de giro nunca considera "mirado".
  const torreAlinhada = Math.abs(normalizeAngle(aim - tank.turret)) < Math.max(config.turnThreshold, TURRET_RATE / 60);

  // Sumiu daqui o "com o inimigo à vista, só avança depois de encarar o alvo": aquilo era uma
  // espera pelo GIRO DO CHASSI, que não existe mais. O bot larga na direção escolhida no mesmo
  // tick, exatamente como o jogador — `config.turnThreshold` segue mandando só no gatilho.
  return { mover, fire: temTiro && torreAlinhada, aim };
}

// ------------------------------------------------------------------------------------------
// Escalonamento — o teto de custo por tick
// ------------------------------------------------------------------------------------------
//
// O problema não era o custo MÉDIO da IA (0,2 ms num tick de 16,67 ms), era o PICO: os 10 bots da
// sala replanejavam ricochete no mesmo tick e o servidor perdia dois ticks inteiros — a sala
// engasgava para todo mundo, inclusive para os humanos. A correção tem três camadas, e as três
// dependem só de coisas determinísticas: a fase sorteada do RNG semeado do bot e o número do tick
// da simulação. Nada de relógio de parede, nada de "sobrou CPU neste tick?".
//
//   1. FASE POR BOT. Cada bot sorteia do próprio RNG semeado uma fase fixa e só COMEÇA a tarefa
//      cara nos ticks em que `(tick + fase) % período === 0`. Como os bots da sala nascem de seeds
//      diferentes, eles caem em ticks diferentes.
//   2. VARREDURA FATIADA. Mesmo quando dois bots colidem na mesma fase, nenhum deles paga uma
//      varredura de ricochete inteira num tick só: ela sai em fatias de `AMOSTRAS_POR_FATIA`
//      ângulos, uma por tick. É o teto duro, e ele é ESTRUTURAL: o pico por bot é o custo de uma
//      fatia, não de uma varredura, aconteça o que acontecer com as fases. O plano anterior
//      continua valendo enquanto o novo não fica pronto — degradação suave, não trava.
//   3. MEMOS PUROS. Voo previsto de bala e passo de BFS são função só da bala e do labirinto, então
//      são calculados uma vez e reaproveitados por todos os bots (ver `preverVoo` e
//      `proximoPassoMemorizado`). Como o valor guardado é idêntico ao recalculado, o cache não
//      acopla uma sala à outra: quem consulta primeiro não muda o resultado de quem consulta
//      depois. O `bot-esperto.test.ts` cobre exatamente isso com duas salas intercaladas.
//
// Medido no `_bench.ts` com 10 bots difíceis, antes → depois: média 0,20 → 0,06 ms, p99 1,76 →
// 0,49 ms, pior caso 4,2 → 1,6 ms.

/** BFS custa caro: 6 recálculos de rota por segundo bastam, o inimigo não troca de célula mais rápido. */
const TICKS_ENTRE_RECALCULO_DE_ROTA = 10;
/**
 * Espera mínima entre duas varreduras de ricochete: ~3 planos/s (a fase do bot adia o começo em
 * até mais 7 ticks). Contra quem ricocheteia, o difícil encurta para 8 ticks.
 */
const TICKS_ENTRE_PLANOS_DE_TIRO = 20;
const TICKS_ENTRE_BUSCAS_DE_COBERTURA = 12;
/** Por quanto tempo depois de uma bala passar raspando o bot continua se comportando como acuado. */
const TICKS_DE_MEMORIA_DE_AMEACA = 45;

// Varredura grossa de ângulos + refino local em volta do melhor. Grosso demais nunca acerta um
// tanque de 18 px a 300 px de distância; fino demais custa raycast à toa. 24 passos de 15° acham
// a "família" de ângulos certa e o refino fecha a pontaria.
const ANGULOS_GROSSOS = 24;
const AMOSTRAS_DE_REFINO = 8;
/** Acima disso o melhor ângulo grosso nem chegou perto — refinar não salvaria o tiro. */
const ERRO_QUE_VALE_REFINAR = CELL * 2;
/**
 * Ângulos avaliados por tick. Os 32 da varredura completa saem em 4 ticks (67 ms) em vez de todos
 * de uma vez — abaixo do tempo de reação humano, e com 1/4 do pico de custo.
 */
const AMOSTRAS_POR_FATIA = 8;
/** Varredura completa: os 24 ângulos grossos mais os 8 do refino. */
const TOTAL_DE_AMOSTRAS = ANGULOS_GROSSOS + AMOSTRAS_DE_REFINO;

export interface Bot {
  /**
   * Um tick de decisão. `target` é o inimigo escolhido por quem chama (normalmente o mais
   * próximo vivo); `tick` é o tick da simulação, usado para o throttle dos replanejamentos;
   * `mundo` traz as balas em voo — sem ele o bot simplesmente não desvia de nada.
   */
  think(tank: Tank, target: Vec2, maze: Maze, tick: number, mundo?: BotMundo): Input;
}

/**
 * Bot com navegação, desvio de bala, mira por ricochete, freio de autogol e uso de parede — o que
 * cada um desses está ligado sai de `config` (ver `BOT_DIFFICULTY`).
 *
 * O estado interno guarda caches de replanejamento, o movimento observado do alvo e sinais do
 * estilo do adversário. Tudo deriva de entradas determinísticas: dois processos com o mesmo
 * `rng`, labirinto e sequência de chamadas produzem exatamente os mesmos inputs.
 */
export function makeBot(rng: Rng, config: BotConfig = BOT_DIFFICULTY.medio): Bot {
  let waypoint: Vec2 | null = null;
  let waypointTick: number | null = null;

  let planoDeTiro: number | null = null;
  let planoConcluidoTick: number | null = null;

  let cobertura: number | null = null;
  let coberturaTick: number | null = null;

  let tickDaUltimaAmeaca = -9999;
  let adversarioUsaRicochete = false;
  let tinhaLosNoTickAnterior: boolean | null = null;

  // Reflexo: a última leitura do campo de balas e a fuga que ela produziu. Entre duas leituras o
  // bot age com esta decisão — é o `ticksDeReacao` da dificuldade.
  let fugaMemorizada: number | null = null;
  let tickDaLeituraDeAmeaca: number | null = null;

  // Varredura de ricochete em curso: em que amostra ela está e qual o melhor ângulo até agora.
  let varreduraAmostra = -1;
  let varreduraMelhorAngulo = 0;
  let varreduraMelhorErro = Infinity;

  let alvoAnteriorX: number | null = null;
  let alvoAnteriorY: number | null = null;
  let tickDoAlvoAnterior: number | null = null;
  // Num tiro perfeitamente centralizado não existe um lado geometricamente melhor para fugir.
  // Este desempate nasce do RNG semeado e evita que todos os bots escolham sempre o mesmo lado.
  const ladoDeFuga: 1 | -1 = rng.int(2) === 0 ? -1 : 1;

  // Fase deste bot no escalonamento: em que ticks do ciclo ele tem direito de começar uma
  // varredura de ricochete. Sai do MESMO RNG semeado que o resto — dois bots da sala recebem
  // seeds diferentes e caem em ticks diferentes, e um bot recriado com a mesma seed cai sempre no
  // mesmo lugar. Nada de relógio, nada de ordem de chamada, nada de carga de CPU.
  const fase = rng.int(AMOSTRAS_POR_FATIA);

  return {
    think(tank: Tank, target: Vec2, maze: Maze, tick: number, mundo?: BotMundo): Input {
      const ruido = rng.next();
      const temLos = hasLineOfSight(tank, target, maze.walls);

      let alvoVx = 0;
      let alvoVy = 0;
      if (alvoAnteriorX !== null && alvoAnteriorY !== null && tickDoAlvoAnterior !== null && tick > tickDoAlvoAnterior) {
        const segundos = (tick - tickDoAlvoAnterior) / TICK_HZ;
        alvoVx = (target.x - alvoAnteriorX) / segundos;
        alvoVy = (target.y - alvoAnteriorY) / segundos;
        const velocidade = Math.hypot(alvoVx, alvoVy);
        if (velocidade > TANK_SPEED * 1.1) {
          const escala = (TANK_SPEED * 1.1) / velocidade;
          alvoVx *= escala;
          alvoVy *= escala;
        }
      }
      alvoAnteriorX = target.x;
      alvoAnteriorY = target.y;
      tickDoAlvoAnterior = tick;

      if (mundo && !adversarioUsaRicochete && tinhaLosNoTickAnterior === false && !temLos) {
        // Bala nascendo sem que ninguém esteja à vista de ninguém: o adversário está mirando por
        // ricochete. Quem percebe isso (só o difícil) passa a replanejar o próprio tiro mais rápido.
        for (const bala of mundo.bullets) {
          if (bala.ownerId !== tank.id && bala.age <= 1.5 / TICK_HZ) adversarioUsaRicochete = true;
        }
      }
      tinhaLosNoTickAnterior = temLos;

      // ---- 1. estou na mira de alguma bala? ----
      let fuga: number | null = null;
      if (config.horizonteDeAmeaca > 0 && mundo) {
        // O reflexo é a única parte que o difícil paga TODO tick (`ticksDeReacao: 1`): sair da
        // linha é reação, não planejamento, e amortizá-la seria enfraquecer o bot. Nos níveis
        // abaixo o intervalo maior é a característica — e sai de graça no orçamento.
        if (tickDaLeituraDeAmeaca === null || tick - tickDaLeituraDeAmeaca >= config.ticksDeReacao) {
          tickDaLeituraDeAmeaca = tick;
          fugaMemorizada = null;
          if (mundo.bullets.length > 0) {
            const quando = ameacaMaisUrgente(tank, mundo.bullets, maze, config.usaParede, config.horizonteDeAmeaca);
            if (quando !== null) {
              tickDaUltimaAmeaca = tick;
              fugaMemorizada = escolherFuga(tank, maze, ladoDeFuga);
            }
          }
        }
        fuga = fugaMemorizada;
      }

      // ---- 2. para onde mirar ----
      let anguloDeMira =
        config.usaParede && temLos
          ? miraAntecipada(
              tank,
              target,
              alvoVx * 0.8,
              alvoVy * 0.8,
              maze,
            )
          : Math.atan2(target.y - tank.y, target.x - tank.x);
      let temTiro = temLos;
      if (!temLos && config.ricocheteia) {
        const intervaloDoPlano = config.usaParede && adversarioUsaRicochete ? 8 : TICKS_ENTRE_PLANOS_DE_TIRO;
        // A PRIMEIRA varredura depois de perder o inimigo de vista sai na hora — ficar meio
        // segundo sem resposta seria pior que o custo, e a fatia já limita o pico. As
        // REavaliações é que respeitam a fase deste bot, e é isso que impede os 10 bots da sala
        // de replanejar todos no mesmo tick.
        if (
          varreduraAmostra < 0 &&
          (planoConcluidoTick === null || (tick - planoConcluidoTick >= intervaloDoPlano && (tick + fase) % AMOSTRAS_POR_FATIA === 0))
        ) {
          varreduraAmostra = 0;
          varreduraMelhorAngulo = 0;
          varreduraMelhorErro = Infinity;
        }

        if (varreduraAmostra >= 0) {
          const passo = (Math.PI * 2) / ANGULOS_GROSSOS;
          const fim = Math.min(TOTAL_DE_AMOSTRAS, varreduraAmostra + AMOSTRAS_POR_FATIA);
          // Terminou o grosso sem chegar perto: refinar não salvaria o tiro, desiste da varredura.
          let desistiu = varreduraAmostra >= ANGULOS_GROSSOS && varreduraMelhorErro > ERRO_QUE_VALE_REFINAR;

          for (; !desistiu && varreduraAmostra < fim; varreduraAmostra++) {
            let angulo: number;
            if (varreduraAmostra < ANGULOS_GROSSOS) {
              angulo = varreduraAmostra * passo;
            } else if (varreduraAmostra === ANGULOS_GROSSOS && varreduraMelhorErro > ERRO_QUE_VALE_REFINAR) {
              desistiu = true;
              break;
            } else {
              // Amostras 24..31 viram k ∈ {-4,-3,-2,-1,1,2,3,4} passos finos ao redor do melhor.
              const k = varreduraAmostra - ANGULOS_GROSSOS - AMOSTRAS_DE_REFINO / 2;
              angulo = varreduraMelhorAngulo + (k < 0 ? k : k + 1) * (passo / (AMOSTRAS_DE_REFINO + 1));
            }
            const erro = erroDoTiro(tank, angulo, target, maze);
            if (erro < varreduraMelhorErro) {
              varreduraMelhorErro = erro;
              varreduraMelhorAngulo = angulo;
            }
          }

          if (desistiu || varreduraAmostra >= TOTAL_DE_AMOSTRAS) {
            const serve =
              !desistiu &&
              varreduraMelhorErro <= RAIO_ACERTO &&
              !(config.evitaAutogol && autogolProvavel(tank, varreduraMelhorAngulo, maze));
            planoDeTiro = serve ? normalizeAngle(varreduraMelhorAngulo) : null;
            planoConcluidoTick = tick;
            varreduraAmostra = -1;
          }
        }

        if (planoDeTiro !== null) {
          anguloDeMira = planoDeTiro;
          temTiro = true;
        }
      } else if (temLos) {
        planoDeTiro = null;
        planoConcluidoTick = null;
        varreduraAmostra = -1;
      }

      // ---- 3. para onde ir ----
      let moveTarget: Vec2 = target;
      // Direção pronta que ATROPELA `moveTarget`: fugir e se cobrir já são um ângulo, não um
      // ponto a perseguir.
      let rumo: number | null = null;

      if (fuga !== null) {
        rumo = fuga;
      } else if (
        config.usaParede &&
        temLos &&
        (tick - tickDaUltimaAmeaca < TICKS_DE_MEMORIA_DE_AMEACA || tank.fireCooldownLeft > FIRE_COOLDOWN * 0.55)
      ) {
        if (coberturaTick === null || tick - coberturaTick >= TICKS_ENTRE_BUSCAS_DE_COBERTURA) {
          coberturaTick = tick;
          cobertura = procurarCobertura(tank, target, maze);
        }
        if (cobertura !== null) rumo = cobertura;
      } else if (!temLos) {
        if (waypointTick === null || tick - waypointTick >= TICKS_ENTRE_RECALCULO_DE_ROTA) {
          waypoint = proximoPassoMemorizado(maze, tank, target);
          waypointTick = tick;
        }
        moveTarget = waypoint ?? target;
      }

      if (config.usaParede && adversarioUsaRicochete) {
        anguloDeMira = normalizeAngle(anguloDeMira + (ruido * 2 - 1) * 0.001);
      }

      const input = botInput(tank, moveTarget, anguloDeMira, temTiro, ruido, config);

      // Fugir e se cobrir MANDAM no deslocamento; a torre continua com a mira montada acima, então
      // o bot atira de lado enquanto corre — que é exatamente o que um jogador humano faz. Com o
      // movimento absoluto isso deixou de ser uma intenção e virou um fato: antes ele ainda tinha
      // que girar o chassi para começar a sair da linha.
      if (rumo !== null) input.mover = rumo;

      // ---- 4. freio de autogol ----
      // `stepTanks` gira a torre antes de criar a bala; a segurança precisa validar esse ângulo
      // pós-giro, não `tank.turret`, que ainda guarda a direção do tick anterior.
      if (input.fire && config.evitaAutogol && autogolProvavel(tank, anguloDoDisparoNesteTick(tank, input.aim), maze)) {
        input.fire = false;
      }

      return input;
    },
  };
}
