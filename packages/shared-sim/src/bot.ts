import {
  BULLET_LIFE,
  BULLET_RADIUS,
  BULLET_SPEED,
  CELL,
  FIRE_COOLDOWN,
  MAX_BOUNCES,
  SELF_IMMUNITY,
  TANK_RADIUS,
  TURRET_RATE,
} from '@tank/protocol';
import { circleVsAabbSlide, hasLineOfSight, raycastSegment, reflect } from './collision.js';
import { nextStepTowards } from './maze.js';
import type { Rng } from './rng.js';
import type { Bullet, Input, Maze, Tank, Vec2 } from './types.js';

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
  dificil: { aimErrorRad: 0.04, turnThreshold: 0.12, desvia: true, ricocheteia: true, evitaAutogol: true, usaParede: true },
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
 * Usa as paredes CRUAS (não infladas pelo raio da bala como a simulação faz): a diferença é de
 * ~4 px no ponto de impacto, invisível para uma heurística de mira, e evita duplicar o cache de
 * paredes infladas do `sim.ts` aqui dentro.
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

  while (restante > 1 && nTrechos <= MAX_BOUNCES + 1) {
    de.x = x;
    de.y = y;
    para.x = x + dx * restante;
    para.y = y + dy * restante;
    const hit = raycastSegment(de, para, maze.walls);
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
  tracarTiro(tank.x + Math.cos(angulo) * OFFSET_DA_BOCA, tank.y + Math.sin(angulo) * OFFSET_DA_BOCA, angulo, maze);
  return distanciaAteATrajetoria(alvo.x, alvo.y, 0);
}

/**
 * O tiro que sair neste ângulo volta em cima de quem atirou? Traça a trajetória inteira e olha
 * só o trecho já letal (depois da janela de `SELF_IMMUNITY`). É a checagem que faz o bot difícil
 * engolir o gatilho no corredor curto em vez de virar a piada da rodada.
 */
function autogolProvavel(tank: Tank, angulo: number, maze: Maze): boolean {
  tracarTiro(tank.x + Math.cos(angulo) * OFFSET_DA_BOCA, tank.y + Math.sin(angulo) * OFFSET_DA_BOCA, angulo, maze);
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
 * O teste é o mesmo mínimo de distância relativa que a colisão bala×bala usa: a posição relativa
 * anda em linha reta, então o instante de aproximação máxima sai da derivada. Balas sem linha de
 * visão até aqui são ignoradas — elas ainda vão ricochetear no caminho, e prever isso deixaria o
 * bot fugindo de sombra.
 */
function ameacaMaisUrgente(tank: Tank, bullets: readonly Bullet[], maze: Maze): number | null {
  const limite = RAIO_ACERTO + MARGEM_DE_AMEACA;
  let melhorT = Infinity;
  const posBala: Vec2 = { x: 0, y: 0 };
  const posTanque: Vec2 = { x: tank.x, y: tank.y };

  for (const bala of bullets) {
    const px = bala.x - tank.x;
    const py = bala.y - tank.y;
    const vv = bala.vx * bala.vx + bala.vy * bala.vy;
    if (vv < 1e-6) continue;

    let t = -(px * bala.vx + py * bala.vy) / vv;
    if (t < 0) continue; // já passou
    if (t > HORIZONTE_DE_AMEACA) continue;

    // A própria bala não machuca enquanto a imunidade dura; se o encontro é dentro dela, passa.
    if (bala.ownerId === tank.id && bala.age + t < SELF_IMMUNITY) continue;

    const dx = px + bala.vx * t;
    const dy = py + bala.vy * t;
    if (Math.hypot(dx, dy) > limite) continue;

    posBala.x = bala.x;
    posBala.y = bala.y;
    if (!hasLineOfSight(posBala, posTanque, maze.walls)) continue;

    if (t < melhorT) {
      melhorT = t;
      ameacaVx = bala.vx;
      ameacaVy = bala.vy;
      ameacaBx = bala.x;
      ameacaBy = bala.y;
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
function escolherFuga(tank: Tank, maze: Maze): number | null {
  const anguloDaBala = Math.atan2(ameacaVy, ameacaVx);
  // Sinal do produto vetorial entre a velocidade da bala e o vetor bala→tanque: diz de que lado
  // da trajetória o tanque está.
  const cross = ameacaVx * (tank.y - ameacaBy) - ameacaVy * (tank.x - ameacaBx);
  const preferido = cross >= 0 ? 1 : -1;

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

  const move: -1 | 0 | 1 = temTiro ? (chassiAlinhado ? 1 : 0) : 1;
  return { turn, move, fire: temTiro && torreAlinhada, aim };
}

// BFS custa caro para rodar todo tick × todo bot. Recalcula a rota só a cada ~10 ticks (6×/s)
// e reaproveita o último waypoint nos demais — o inimigo não muda de célula rápido o bastante
// para precisar de mais que isso. O throttle é contado em ticks de simulação (não em tempo de
// relógio), então é idêntico no servidor e no cliente.
const TICKS_ENTRE_RECALCULO_DE_ROTA = 10;
/** Replanejar ricochete é o que custa mais caro na IA — 3×/s é suficiente para o alvo não fugir. */
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
 * Estado interno = só caches de replanejamento (waypoint, ângulo de ricochete, cobertura) e o
 * tick de cada um, todos derivados de entradas determinísticas: dois processos com o mesmo `rng`,
 * mesmo labirinto e mesma sequência de chamadas produzem exatamente os mesmos inputs.
 */
export function makeBot(rng: Rng, config: BotConfig = BOT_DIFFICULTY.medio): Bot {
  let waypoint: Vec2 | null = null;
  let waypointTick: number | null = null;

  let planoDeTiro: number | null = null;
  let planoTick: number | null = null;

  let cobertura: number | null = null;
  let coberturaTick: number | null = null;

  let tickDaUltimaAmeaca = -9999;

  // Defasagem fixa por bot, sorteada uma vez: sem ela os nove bots da sala replanejam ricochete
  // no MESMO tick e o servidor leva uma agulhada de trabalho a cada 20 ticks em vez de trabalho
  // espalhado. Vem do RNG semeado, então continua idêntica no cliente e no servidor.
  const defasagem = rng.int(TICKS_ENTRE_PLANOS_DE_TIRO);

  return {
    think(tank: Tank, target: Vec2, maze: Maze, tick: number, mundo?: BotMundo): Input {
      const ruido = rng.next();
      const temLos = hasLineOfSight(tank, target, maze.walls);

      // ---- 1. estou na mira de alguma bala? ----
      let fuga: number | null = null;
      if (config.desvia && mundo && mundo.bullets.length > 0) {
        const quando = ameacaMaisUrgente(tank, mundo.bullets, maze);
        if (quando !== null) {
          tickDaUltimaAmeaca = tick;
          fuga = escolherFuga(tank, maze);
        }
      }

      // ---- 2. para onde mirar ----
      let anguloDeMira = Math.atan2(target.y - tank.y, target.x - tank.x);
      let temTiro = temLos;
      if (!temLos && config.ricocheteia) {
        if (planoTick === null || tick - planoTick >= TICKS_ENTRE_PLANOS_DE_TIRO) {
          planoTick = tick + (defasagem % 3);
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

      const input = botInput(tank, moveTarget, anguloDeMira, temTiro, ruido, config);

      // Fugir e se cobrir MANDAM no chassi; a torre continua com a mira montada acima, então o
      // bot atira de lado enquanto corre — que é exatamente o que um jogador humano faz.
      if (rumo) {
        input.turn = rumo.turn;
        input.move = rumo.move;
      }

      // ---- 4. freio de autogol ----
      // Checa o ângulo REAL da torre, não o desejado: é dele que a bala sai neste tick.
      if (input.fire && config.evitaAutogol && autogolProvavel(tank, tank.turret, maze)) {
        input.fire = false;
      }

      return input;
    },
  };
}
