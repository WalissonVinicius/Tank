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
import { circleVsAabbSlide, hasLineOfSight, raycastSegment, reflect } from './collision.js';
import { nextStepTowards } from './maze.js';
import type { Rng } from './rng.js';
import type { Aabb, Bullet, Input, Maze, Tank, Vec2 } from './types.js';

/**
 * Capacidades do bot, ligadas por dificuldade (Fase 13 §4). Não é sistema de configuração: são
 * quatro chaves booleanas em cima do erro de mira que já existia, e as três receitas prontas de
 * `BOT_DIFFICULTY` são o que o jogo usa.
 */
export interface BotConfig {
  aimErrorRad: number; // erro de mira em radianos, maior = bot pior de mira
  turnThreshold: number; // rad — abaixo disso considera "já mirando" o suficiente para atirar
  /** Percebe bala vindo na direção dele e sai da linha. */
  desvia: boolean;
  /** Sem linha de visão, procura um ângulo que quica 1× e chega no alvo. */
  ricocheteia: boolean;
  /** Simula o próprio tiro antes de puxar o gatilho e engole o que voltaria em cima dele. */
  evitaAutogol: boolean;
  /** Sob ameaça ou recarregando, procura posição sem linha de visão para o inimigo. */
  usaParede: boolean;
}

// Escalonamento pedido na Fase 13: fácil SÓ desvia; difícil desvia, ricocheteia, evita autogol e
// usa a parede. O médio é o degrau do meio (desvia, ricocheteia e não se mata).
export const BOT_DIFFICULTY: Record<'facil' | 'medio' | 'dificil', BotConfig> = {
  facil: { aimErrorRad: 0.35, turnThreshold: 0.25, desvia: true, ricocheteia: false, evitaAutogol: false, usaParede: false },
  medio: { aimErrorRad: 0.18, turnThreshold: 0.15, desvia: true, ricocheteia: true, evitaAutogol: true, usaParede: false },
  dificil: { aimErrorRad: 0.005, turnThreshold: 0.04, desvia: true, ricocheteia: true, evitaAutogol: true, usaParede: true },
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

    const refletido = reflect({ x: dx, y: dy }, hit.normal);
    dx = refletido.x;
    dy = refletido.y;
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

// Varredura grossa de ângulos + refino local em volta do melhor. Grosso demais nunca acerta um
// tanque de 18 px a 300 px de distância; fino demais custa raycast à toa. 24 passos de 15° acham
// a "família" de ângulos certa e o refino fecha a pontaria.
const ANGULOS_GROSSOS = 24;
const AMOSTRAS_DE_REFINO = 8;
/** Acima disso o melhor ângulo grosso nem chegou perto — refinar não salvaria o tiro. */
const ERRO_QUE_VALE_REFINAR = CELL * 2;

/**
 * Ângulo de tiro que quica uma vez e alcança o alvo, ou `null` se não achou nenhum.
 *
 * Não procura o ótimo: procura UM. O ricochete é a assinatura do jogo e o que faltava na IA da
 * Fase 2 — sem isto o bot atravessa a rodada inteira contornando parede sem nunca revidar de
 * quem está do outro lado dela.
 */
function planejarRicochete(tank: Tank, alvo: Vec2, maze: Maze, evitaAutogol: boolean): number | null {
  const passo = (Math.PI * 2) / ANGULOS_GROSSOS;
  let melhorAngulo = 0;
  let melhorErro = Infinity;

  for (let i = 0; i < ANGULOS_GROSSOS; i++) {
    const angulo = i * passo;
    const erro = erroDoTiro(tank, angulo, alvo, maze);
    if (erro < melhorErro) {
      melhorErro = erro;
      melhorAngulo = angulo;
    }
  }

  if (melhorErro > ERRO_QUE_VALE_REFINAR) return null;

  const fino = passo / (AMOSTRAS_DE_REFINO + 1);
  for (let k = -AMOSTRAS_DE_REFINO / 2; k <= AMOSTRAS_DE_REFINO / 2; k++) {
    if (k === 0) continue;
    const angulo = melhorAngulo + k * fino;
    const erro = erroDoTiro(tank, angulo, alvo, maze);
    if (erro < melhorErro) {
      melhorErro = erro;
      melhorAngulo = angulo;
    }
  }

  if (melhorErro > RAIO_ACERTO) return null;
  if (evitaAutogol && autogolProvavel(tank, melhorAngulo, maze)) return null;
  return normalizeAngle(melhorAngulo);
}

// ------------------------------------------------------------------------------------------
// Desvio de bala
// ------------------------------------------------------------------------------------------

/**
 * Quanto à frente o bot enxerga na trajetória de uma bala, em segundos. A 215 px/s isso são ~2,8
 * células — o tanque anda a 60 px/s e precisa de tempo para girar E sair da linha; menos que isso
 * e ele "reage" já morto.
 */
const HORIZONTE_DE_AMEACA = 1.2;
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
 * No difícil, a previsão acompanha também o único ricochete permitido; nos outros níveis conserva
 * o horizonte curto e retilíneo anterior.
 */
function ameacaMaisUrgente(tank: Tank, bullets: readonly Bullet[], maze: Maze, preveRicochete: boolean): number | null {
  const limite = RAIO_ACERTO + MARGEM_DE_AMEACA;
  let melhorT = Infinity;
  const posBala: Vec2 = { x: 0, y: 0 };
  const posTanque: Vec2 = { x: tank.x, y: tank.y };
  const destino: Vec2 = { x: 0, y: 0 };
  const paredes = paredesParaBala(maze);

  for (const bala of bullets) {
    const horizonte = Math.min(BULLET_LIFE - bala.age, preveRicochete ? BULLET_LIFE : HORIZONTE_DE_AMEACA);
    if (horizonte <= 0) continue;

    let x = bala.x;
    let y = bala.y;
    let vx = bala.vx;
    let vy = bala.vy;
    let quicadas = bala.bounces;
    let decorrido = 0;

    while (decorrido < horizonte) {
      const restante = horizonte - decorrido;
      posBala.x = x;
      posBala.y = y;
      destino.x = x + vx * restante;
      destino.y = y + vy * restante;
      const hit = raycastSegment(posBala, destino, paredes);
      const duracao = hit ? restante * hit.t : restante;
      const px = x - tank.x;
      const py = y - tank.y;
      const vv = vx * vx + vy * vy;

      const inicioLetal = bala.ownerId === tank.id ? SELF_IMMUNITY - bala.age - decorrido : 0;
      if (vv > 1e-6 && inicioLetal <= duracao) {
        let noTrecho = -(px * vx + py * vy) / vv;
        if (noTrecho < Math.max(0, inicioLetal)) noTrecho = Math.max(0, inicioLetal);
        else if (noTrecho > duracao) noTrecho = duracao;
        const encontro = decorrido + noTrecho;
        const dx = px + vx * noTrecho;
        const dy = py + vy * noTrecho;

        posBala.x = x + vx * noTrecho;
        posBala.y = y + vy * noTrecho;
        if (
          encontro < melhorT &&
          Math.hypot(dx, dy) <= limite &&
          hasLineOfSight(posBala, posTanque, maze.walls)
        ) {
          melhorT = encontro;
          ameacaVx = vx;
          ameacaVy = vy;
          ameacaBx = x;
          ameacaBy = y;
        }
      }

      if (!hit || !preveRicochete || quicadas >= MAX_BOUNCES || duracao < 1e-6) break;
      const refletida = reflect({ x: vx, y: vy }, hit.normal);
      vx = refletida.x;
      vy = refletida.y;
      x = hit.point.x + hit.normal.x * 0.05;
      y = hit.point.y + hit.normal.y * 0.05;
      quicadas++;
      decorrido += duracao;
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
 * Um ponto a uma célula daqui que quebre a linha de visão do inimigo. Entre os que servem, o que
 * exige menos giro — cobertura que custa meia-volta chega depois do tiro.
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

interface Rumo {
  turn: -1 | 0 | 1;
  move: -1 | 0 | 1;
}

/**
 * Giro e marcha para apontar o CHASSI em `desejado`. Com o destino atrás, dá RÉ em vez de girar
 * meia-volta: o giro custa ~1 s e uma bala atravessa a arena nesse tempo.
 */
function rumoPara(tank: Tank, desejado: number, podeDarRe: boolean): Rumo {
  const diff = normalizeAngle(desejado - tank.heading);
  if (!podeDarRe || Math.abs(diff) <= Math.PI / 2) {
    return { turn: Math.abs(diff) < 0.02 ? 0 : diff > 0 ? 1 : -1, move: 1 };
  }
  const deRe = normalizeAngle(diff > 0 ? diff - Math.PI : diff + Math.PI);
  return { turn: Math.abs(deRe) < 0.02 ? 0 : deRe > 0 ? 1 : -1, move: -1 };
}

/** Ângulo que a torre terá depois do giro deste tick, imediatamente antes de `stepTanks` atirar. */
function anguloDoDisparoNesteTick(tank: Tank, aim: number | undefined): number {
  if (aim === undefined) return tank.turret;
  const diff = normalizeAngle(aim - tank.turret);
  const passo = TURRET_RATE / TICK_HZ;
  if (Math.abs(diff) <= passo) return normalizeAngle(aim);
  return normalizeAngle(tank.turret + Math.sign(diff) * passo);
}

// IA determinística. Depois da Fase 4 o bot tem DUAS direções para cuidar, igual ao jogador: o
// chassi aponta para onde ele quer ir e a torre para onde quer atirar; como o servidor limita o
// giro dela a `TURRET_RATE`, ele sofre a mesma espera de virar o cano que o jogador sofre.
//
// Todo o "acaso" (erro de mira) vem do RNG semeado recebido por parâmetro — nunca Math.random().
// O RNG é consumido UMA vez por decisão, sempre no mesmo ponto, para que a sequência não dependa
// do caminho tomado dentro do `think`.
export function botInput(
  tank: Tank,
  moveTarget: Vec2,
  anguloDeMira: number,
  temLos: boolean,
  temTiro: boolean,
  ruido: number,
  config: BotConfig,
): Input {
  const desejado = Math.atan2(moveTarget.y - tank.y, moveTarget.x - tank.x);
  const headingDiff = normalizeAngle(desejado - tank.heading);
  const turn: -1 | 0 | 1 = Math.abs(headingDiff) < 0.02 ? 0 : headingDiff > 0 ? 1 : -1;

  const aim = normalizeAngle(anguloDeMira + (ruido * 2 - 1) * config.aimErrorRad);
  const chassiAlinhado = Math.abs(headingDiff) < config.turnThreshold;
  // Tolerância de disparo proporcional à distância que a torre ainda consegue cobrir num tick:
  // sem isso um bot com `aimErrorRad` menor que a resolução de giro nunca considera "mirado".
  const torreAlinhada = Math.abs(normalizeAngle(aim - tank.turret)) < Math.max(config.turnThreshold, TURRET_RATE / 60);

  // Quem MANDA no `move` é a linha de visão, não o gatilho: com o inimigo à vista o bot só avança
  // depois de encarar o alvo, mas navegando às cegas pelo labirinto ele não pode parar a cada
  // curva — e desde o ricochete ele atira sem ter o inimigo à vista, que é justamente o caso em
  // que ele está andando por waypoint.
  const move: -1 | 0 | 1 = temLos ? (chassiAlinhado ? 1 : 0) : 1;
  return { turn, move, fire: temTiro && torreAlinhada, aim };
}

// BFS custa caro para rodar todo tick × todo bot. Recalcula a rota só a cada ~10 ticks (6×/s)
// e reaproveita o último waypoint nos demais — o inimigo não muda de célula rápido o bastante
// para precisar de mais que isso. O throttle é contado em ticks de simulação (não em tempo de
// relógio), então é idêntico no servidor e no cliente.
const TICKS_ENTRE_RECALCULO_DE_ROTA = 10;
/** Base de 3 planos/s; contra quem ricocheteia, o difícil reage a cada 8 ticks (7,5 planos/s). */
const TICKS_ENTRE_PLANOS_DE_TIRO = 20;
const TICKS_ENTRE_BUSCAS_DE_COBERTURA = 12;
/** Por quanto tempo depois de uma bala passar raspando o bot continua se comportando como acuado. */
const TICKS_DE_MEMORIA_DE_AMEACA = 45;

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
  let planoTick: number | null = null;

  let cobertura: number | null = null;
  let coberturaTick: number | null = null;

  let tickDaUltimaAmeaca = -9999;
  let adversarioUsaRicochete = false;
  let tinhaLosNoTickAnterior: boolean | null = null;

  let alvoAnteriorX: number | null = null;
  let alvoAnteriorY: number | null = null;
  let tickDoAlvoAnterior: number | null = null;
  // Num tiro perfeitamente centralizado não existe um lado geometricamente melhor para fugir.
  // Este desempate nasce do RNG semeado e evita que todos os bots escolham sempre o mesmo lado.
  const ladoDeFuga: 1 | -1 = rng.int(2) === 0 ? -1 : 1;

  // Defasagem fixa deste bot dentro do ciclo de replanejamento (ver o uso, logo abaixo). Vem do
  // RNG semeado, então é idêntica no cliente e no servidor.
  const defasagem = rng.int(TICKS_ENTRE_PLANOS_DE_TIRO);

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

      let balasProprias = 0;
      if (mundo) {
        for (const bala of mundo.bullets) {
          if (bala.ownerId === tank.id) balasProprias++;
          else if (tinhaLosNoTickAnterior === false && !temLos && bala.age <= 1.5 / TICK_HZ) {
            adversarioUsaRicochete = true;
          }
        }
      }
      tinhaLosNoTickAnterior = temLos;

      // ---- 1. estou na mira de alguma bala? ----
      let fuga: number | null = null;
      if (config.desvia && mundo && mundo.bullets.length > 0) {
        const quando = ameacaMaisUrgente(tank, mundo.bullets, maze, config.usaParede);
        if (quando !== null) {
          tickDaUltimaAmeaca = tick;
          fuga = escolherFuga(tank, maze, ladoDeFuga);
        }
      }

      // ---- 2. para onde mirar ----
      let anguloDeMira =
        config.usaParede && temLos && balasProprias > 0
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
        if (planoTick === null || tick - planoTick >= intervaloDoPlano) {
          // A primeira avaliação sai na hora (perder o inimigo de vista e ficar meio segundo sem
          // resposta seria pior que o custo), mas o relógio dela nasce RECUADO pela defasagem
          // deste bot: é isso que espalha os replanejamentos seguintes entre os bots da sala, em
          // vez de deixar os nove recalculando ricochete no mesmo tick.
          planoTick = planoTick === null ? tick - defasagem : tick;
          planoDeTiro = planejarRicochete(tank, target, maze, config.evitaAutogol);
        }
        if (planoDeTiro !== null) {
          anguloDeMira = planoDeTiro;
          temTiro = true;
        }
      } else if (temLos) {
        planoDeTiro = null;
        planoTick = null;
      }

      // ---- 3. para onde ir ----
      let moveTarget: Vec2 = target;
      let rumo: Rumo | null = null;

      if (fuga !== null) {
        rumo = rumoPara(tank, fuga, true);
      } else if (
        config.usaParede &&
        temLos &&
        (tick - tickDaUltimaAmeaca < TICKS_DE_MEMORIA_DE_AMEACA || tank.fireCooldownLeft > FIRE_COOLDOWN * 0.55)
      ) {
        if (coberturaTick === null || tick - coberturaTick >= TICKS_ENTRE_BUSCAS_DE_COBERTURA) {
          coberturaTick = tick;
          cobertura = procurarCobertura(tank, target, maze);
        }
        if (cobertura !== null) rumo = rumoPara(tank, cobertura, true);
      } else if (!temLos) {
        if (waypointTick === null || tick - waypointTick >= TICKS_ENTRE_RECALCULO_DE_ROTA) {
          waypoint = nextStepTowards(maze, tank, target);
          waypointTick = tick;
        }
        moveTarget = waypoint ?? target;
      }

      if (config.usaParede && adversarioUsaRicochete) {
        anguloDeMira = normalizeAngle(anguloDeMira + (ruido * 2 - 1) * 0.001);
      }

      const input = botInput(tank, moveTarget, anguloDeMira, temLos, temTiro, ruido, config);

      // Fugir e se cobrir MANDAM no chassi; a torre continua com a mira montada acima, então o
      // bot atira de lado enquanto corre — que é exatamente o que um jogador humano faz.
      if (rumo) {
        input.turn = rumo.turn;
        input.move = rumo.move;
      }

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
