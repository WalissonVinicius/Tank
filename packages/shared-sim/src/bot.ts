import { TURRET_RATE } from '@tank/protocol';
import { hasLineOfSight } from './collision.js';
import { nextStepTowards } from './maze.js';
import type { Rng } from './rng.js';
import type { Input, Maze, Tank, Vec2 } from './types.js';

export interface BotConfig {
  aimErrorRad: number; // erro de mira em radianos, maior = bot pior de mira
  turnThreshold: number; // rad — abaixo disso considera "já mirando" o suficiente para atirar
}

export const BOT_DIFFICULTY: Record<'facil' | 'medio' | 'dificil', BotConfig> = {
  facil: { aimErrorRad: 0.35, turnThreshold: 0.25 },
  medio: { aimErrorRad: 0.18, turnThreshold: 0.15 },
  dificil: { aimErrorRad: 0.05, turnThreshold: 0.08 },
};

function normalizeAngle(a: number): number {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r < -Math.PI) r += Math.PI * 2;
  return r;
}

// IA determinística e simples. Depois da Fase 4 o bot tem DUAS direções para cuidar, igual ao
// jogador: o chassi aponta para onde ele quer ir (`moveTarget` — o inimigo se há linha de visão,
// senão o próximo passo do caminho) e a torre aponta para onde ele quer atirar (`aimTarget`, que
// é sempre o inimigo). Atira quando tem LOS e a TORRE — não o chassi — já está dentro do
// threshold; como o servidor limita o giro dela a `TURRET_RATE`, o bot sofre exatamente a mesma
// espera de virar o cano que o jogador sofre.
//
// Todo o "acaso" (erro de mira) vem do RNG semeado recebido por parâmetro — nunca Math.random().
export function botInput(tank: Tank, moveTarget: Vec2, aimTarget: Vec2, maze: Maze, rng: Rng, config: BotConfig): Input {
  const desiredHeading = Math.atan2(moveTarget.y - tank.y, moveTarget.x - tank.x);
  const headingDiff = normalizeAngle(desiredHeading - tank.heading);
  const turn: -1 | 0 | 1 = Math.abs(headingDiff) < 0.02 ? 0 : headingDiff > 0 ? 1 : -1;

  const aim = normalizeAngle(
    Math.atan2(aimTarget.y - tank.y, aimTarget.x - tank.x) + (rng.next() * 2 - 1) * config.aimErrorRad,
  );

  const hasLos = hasLineOfSight(tank, aimTarget, maze.walls);
  const chassiAlinhado = Math.abs(headingDiff) < config.turnThreshold;
  // Tolerância de disparo proporcional à distância que a torre ainda consegue cobrir num tick:
  // sem isso um bot com `aimErrorRad` menor que a resolução de giro nunca considera "mirado".
  const torreAlinhada = Math.abs(normalizeAngle(aim - tank.turret)) < Math.max(config.turnThreshold, TURRET_RATE / 60);

  const move: -1 | 0 | 1 = hasLos ? (chassiAlinhado ? 1 : 0) : 1;
  const fire = hasLos && torreAlinhada;

  return { turn, move, fire, aim };
}

// BFS custa caro para rodar todo tick × todo bot. Recalcula a rota só a cada ~10 ticks (6×/s)
// e reaproveita o último waypoint nos demais — o inimigo não muda de célula rápido o bastante
// para precisar de mais que isso. O throttle é contado em ticks de simulação (não em tempo de
// relógio), então é idêntico no servidor e no cliente.
const TICKS_ENTRE_RECALCULO_DE_ROTA = 10;

export interface Bot {
  /**
   * Um tick de decisão. `target` é o inimigo escolhido por quem chama (normalmente o mais
   * próximo vivo); `tick` é o tick da simulação, usado para o throttle do recálculo de rota.
   */
  think(tank: Tank, target: Vec2, maze: Maze, tick: number): Input;
}

/**
 * Bot com navegação: quando não há linha de visão até o alvo, o CHASSI persegue o centro da
 * próxima célula no caminho do labirinto (`nextStepTowards`) em vez de empurrar a parede
 * tentando apontar para uma direção que a geometria não permite. A TORRE continua apontada para
 * o inimigo o tempo todo — é assim que ele já chega mirado ao virar a esquina.
 *
 * Estado interno = só o waypoint em cache e o tick do último recálculo, ambos derivados de
 * entradas determinísticas — dois processos com o mesmo `rng`, mesmo labirinto e mesma
 * sequência de chamadas produzem exatamente os mesmos inputs.
 */
export function makeBot(rng: Rng, config: BotConfig = BOT_DIFFICULTY.medio): Bot {
  let waypoint: Vec2 | null = null;
  let waypointTick: number | null = null;

  return {
    think(tank: Tank, target: Vec2, maze: Maze, tick: number): Input {
      if (hasLineOfSight(tank, target, maze.walls)) {
        return botInput(tank, target, target, maze, rng, config);
      }

      if (waypointTick === null || tick - waypointTick >= TICKS_ENTRE_RECALCULO_DE_ROTA) {
        waypoint = nextStepTowards(maze, tank, target);
        waypointTick = tick;
      }

      return botInput(tank, waypoint ?? target, target, maze, rng, config);
    },
  };
}
