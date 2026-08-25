// Arena de duelo: o ÁRBITRO neutro que decide qual IA é melhor.
//
// Existe porque "o bot ficou mais esperto" não é afirmação verificável — só duelo é. Aqui duas
// fábricas de bot entram, N partidas são simuladas e sai um placar. É o que permite iterar a IA
// de verdade: mudou alguma coisa, roda a arena, e o número diz se melhorou ou piorou.
//
// Três cuidados que fazem o resultado significar alguma coisa:
//
// 1. LADOS TROCADOS. Cada seed é jogada DUAS vezes, invertendo quem nasce em qual ponto. O
//    labirinto não é simétrico e o spawn às vezes entrega vantagem; sem a troca, metade do placar
//    mediria sorte de nascimento.
// 2. DETERMINISMO. Nada de `Math.random()` — a seed manda em tudo (labirinto, spawns, RNG de cada
//    cérebro). A mesma chamada devolve o mesmo placar sempre, senão não dá para comparar duas
//    execuções.
// 3. EMPATE CONTA. Duelo que estoura o tempo sem morte não vira vitória de ninguém. Bot que
//    aprende a fugir e não resolve a partida não pode ser premiado por isso.

import { CELL, TICK_HZ } from '@tank/protocol';
import { makeMaze, mulberry32, spawnPoints, step } from '@tank/shared-sim';
import type { Bot, Input, Rng, SimState, Tank } from '@tank/shared-sim';

const DT = 1 / TICK_HZ;

/** Uma fábrica recebe o RNG semeado do cérebro e devolve o bot. */
export type FabricaBot = (rng: Rng) => Bot;

export interface Competidor {
  nome: string;
  criar: FabricaBot;
}

export interface Placar {
  a: number;
  b: number;
  empates: number;
  partidas: number;
  /** Percentual de vitórias de A sobre as partidas DECIDIDAS (empates fora da conta). */
  aproveitamentoA: number;
  /** Média de segundos até a partida ser decidida — duelo bom termina, não se arrasta. */
  duracaoMedia: number;
}

function tanque(id: string, x: number, y: number, heading: number): Tank {
  return { id, x, y, heading, turret: heading, alive: true, fireCooldownLeft: 0 };
}

/**
 * Uma partida. Devolve o vencedor ('a' | 'b') ou 'empate', e em quantos ticks foi decidida.
 *
 * `trocado` inverte os pontos de nascimento — a mesma seed jogada dos dois lados.
 */
export function partida(
  a: Competidor,
  b: Competidor,
  seed: number,
  trocado: boolean,
  segundosMax: number,
): { vencedor: 'a' | 'b' | 'empate'; ticks: number } {
  const maze = makeMaze(seed, 2);
  const rng = mulberry32((seed * 2654435761) >>> 0);
  const pontos = spawnPoints(maze, 2, rng);
  const ordem: ('a' | 'b')[] = trocado ? ['b', 'a'] : ['a', 'b'];

  const tanks = new Map<string, Tank>();
  const cerebros = new Map<string, Bot>();
  ordem.forEach((lado, i) => {
    const p = pontos[i]!;
    const heading = rng.next() * Math.PI * 2;
    tanks.set(lado, tanque(lado, p.x, p.y, heading));
    // O RNG do cérebro depende do índice de NASCIMENTO, não do lado: assim a troca de lados
    // testa a estratégia, e não uma sequência de números diferente.
    cerebros.set(lado, (lado === 'a' ? a : b).criar(mulberry32(seed + i * 7919 + 1)));
  });

  const state: SimState = { tick: 0, maze, tanks, bullets: [], nextBulletId: 0 };
  const inputs = new Map<string, Input>();
  const ticksMax = Math.round(segundosMax * TICK_HZ);

  for (let tick = 0; tick < ticksMax; tick++) {
    inputs.clear();
    for (const t of tanks.values()) {
      if (!t.alive) continue;
      let alvo: Tank | undefined;
      for (const outro of tanks.values()) if (outro.id !== t.id && outro.alive) alvo = outro;
      if (!alvo) continue;
      inputs.set(t.id, cerebros.get(t.id)!.think(t, alvo, maze, state.tick, { bullets: state.bullets }));
    }
    step(state, inputs, DT);
    state.tick += 1;

    const vivos = [...tanks.values()].filter((t) => t.alive);
    if (vivos.length <= 1) {
      return { vencedor: vivos.length === 1 ? (vivos[0]!.id as 'a' | 'b') : 'empate', ticks: state.tick };
    }
  }
  return { vencedor: 'empate', ticks: ticksMax };
}

/**
 * Duela A contra B por `partidas` confrontos (metade com os lados trocados).
 *
 * `segundosMax` limita cada partida. 25 s é o padrão porque a rodada real dura 45 s e um duelo
 * de dois tanques que passa disso já não vai ser resolvido.
 */
export function duelar(a: Competidor, b: Competidor, partidas = 100, segundosMax = 25): Placar {
  let vitoriasA = 0;
  let vitoriasB = 0;
  let empates = 0;
  let ticksTotais = 0;

  for (let i = 0; i < partidas; i++) {
    // Seeds espaçadas por um primo grande: seeds vizinhas geram labirintos parecidos, e 100
    // variações do mesmo mapa mediriam menos que 100 mapas diferentes.
    const seed = 1_000 + i * 7_919;
    const r = partida(a, b, seed, i % 2 === 1, segundosMax);
    ticksTotais += r.ticks;
    if (r.vencedor === 'a') vitoriasA++;
    else if (r.vencedor === 'b') vitoriasB++;
    else empates++;
  }

  const decididas = vitoriasA + vitoriasB;
  return {
    a: vitoriasA,
    b: vitoriasB,
    empates,
    partidas,
    aproveitamentoA: decididas === 0 ? 0 : Math.round((vitoriasA / decididas) * 1000) / 10,
    duracaoMedia: Math.round((ticksTotais / partidas / TICK_HZ) * 10) / 10,
  };
}

/** Linha de placar pronta para `console.log` — mesmo formato em todo lugar que duela. */
export function linhaPlacar(a: Competidor, b: Competidor, p: Placar): string {
  return `${a.nome} ${p.a} × ${p.b} ${b.nome}  (empates ${p.empates}, aproveitamento ${p.aproveitamentoA}%, ${p.duracaoMedia}s por partida)`;
}

export { CELL };
