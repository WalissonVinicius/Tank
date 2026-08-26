// Tabela de tuning inteira do Tank Ricochete — fonte única da verdade.
// Cada constante tem a faixa recomendada de ajuste anotada ao lado (relatório G §1.2).

export const TICK_HZ = 60; // faixa: 30–60 — taxa de simulação do servidor, fixa em 60 no plano
export const SNAPSHOT_HZ = 20; // faixa: 20–30 — taxa de envio do estado quente (posições de tanque)
export const CELL = 84; // faixa: 60–100 px — tamanho da célula do labirinto, referência de escala
export const TANK_SPEED = 60; // faixa: 50–75 px/s — velocidade de avanço/ré do tanque
export const BULLET_SPEED = 215; // faixa: 180–260 px/s — mantém razão bala:tanque ≈ 3,6:1
export const TANK_RADIUS_F = 0.22; // faixa: 0,18–0,26 × CELL — raio de colisão do tanque
export const BULLET_RADIUS_F = 0.05; // faixa: 0,04–0,06 × CELL — raio de colisão/acerto da bala
export const WALL_THICKNESS_F = 0.12; // faixa: 0,10–0,15 × CELL — espessura de parede
// Decisão do usuário na Fase 10, revertendo a Fase 9 e restaurando a regra da Fase 4: a bala
// quica UMA vez. No SEGUNDO toque em parede ela morre — quem errou o ângulo não ganha um terceiro
// salto de sorte, e a tela deixa de virar pinball. Faixa razoável: 1–3.
export const MAX_BOUNCES = 1; // nº de rebotes que a bala sobrevive; o seguinte a mata
// Teto de segurança para a bala que não encosta em NADA. Caiu de 3,0 s para 2,2 s na Fase 10
// ("achei 3 s longo demais"). Com o ricochete único matando a bala antes, este relógio quase
// nunca chega a disparar dentro do labirinto — ver `_specs/P10-balistica.md`. Faixa: 1,8–4 s.
export const BULLET_LIFE = 2.2; // vida útil máxima da bala, em segundos
// Fase 12: "tem muito bala, tem que diminuir isso aí". A munição simultânea caiu de 3 para 2 e a
// cadência de 0,35 s para 0,55 s. Medido em partida de bots de verdade (`_specs/_p12-densidade.mjs`,
// 6 jogadores, ~500 disparos): a média de balas VIVAS AO MESMO TEMPO na arena caiu de 3,39 para
// 2,27 (−33%), o p90 de 7 para 5 e o pico de 13 para 10. Por tanque vivo: 1,01 → 0,68 bala.
export const MAX_BULLETS = 2; // faixa: 1–4 — munição simultânea padrão (ver MAX_BULLETS_BY_PLAYERS)
export const FIRE_COOLDOWN = 0.55; // faixa: 0,35–0,7 s — cadência mínima entre disparos
export const TURN_RATE = 3.2; // faixa: 1,5–2,5 s por 360° (~2,5–4,2 rad/s) — giro do chassi
export const SELF_IMMUNITY = 0.11; // faixa: 0,10–0,12 s — janela de imunidade ao próprio tiro
export const ROUNDS = 10; // fixo — nº de rodadas por partida
export const ROUND_TIMEOUT = 45; // faixa: 20–45 s, escalando com nº de jogadores — teto por rodada
export const COUNTDOWN = 3; // faixa: 2–4 s — contagem regressiva antes de cada rodada

// Fase 4: a torre deixou de ser travada no chassi e passou a mirar no cursor do mouse. Ela NÃO
// gira instantâneo — girar de um lado ao outro custa tempo, e é essa latência que transforma
// "apontar" em habilidade. Faixa: 3,5–7 rad/s (≈1,8 s a 0,9 s por 360°). Abaixo de 3,5 a torre
// fica pesada demais para revidar; acima de 7 vira mira instantânea e o jogo perde a leitura.
export const TURRET_RATE = 5.0; // rad/s — velocidade máxima de giro da torre até o ângulo de mira

// Constantes derivadas em pixels, calculadas a partir de CELL — evita repetir a conta em cada consumidor.
export const TANK_RADIUS = TANK_RADIUS_F * CELL;
export const BULLET_RADIUS = BULLET_RADIUS_F * CELL;
export const WALL_THICKNESS = WALL_THICKNESS_F * CELL;

// Raio (px) da explosão de bala — tanto a de fim de vida quanto a de colisão bala×bala. Hoje a
// explosão é puramente cosmética: este raio só vira dano se `EXPLOSAO_DE_BALA_E_LETAL` for
// ligado em shared-sim/src/sim.ts. Faixa razoável: 0,4–0,8 × CELL.
export const BULLET_EXPLOSION_RADIUS = 0.55 * CELL;

// Distância (px) abaixo da qual dois spawns não podem ter linha de visão direta um para o outro.
// Numa arena aberta (braiding alto) ser visto de longe na largada é aceitável — injusto é nascer
// perto E à vista. Acima deste limiar os pares podem se enxergar livremente. 5 células ≈ 2 s de
// voo de bala, tempo de sobra para reagir. Ver spawnPoints() em shared-sim/src/maze.ts.
export const SPAWN_LOS_MIN_DIST = 5 * CELL;

export interface MazeDensity {
  cols: number;
  rows: number;
  braidPct: number;
}

// Faixa em que a proporção do labirinto pode ser esticada para acompanhar a tela (Fase 9). Fora
// dela a arena é centralizada e sobra faixa preta — de propósito: sem trava, uma tela 32:9 pediria
// um labirinto de 30 colunas por 3 linhas, que não é mais um labirinto, é um corredor.
//
// O teto de 2,7 não é a razão da JANELA e sim a da ÁREA JOGÁVEL (a janela menos as faixas de HUD
// que `ui/layout.ts` reserva no topo e embaixo): em 3440×1440 ela dá ~2,65, então 21:9 preenche a
// tela inteira e só o que passa disso é centralizado. O piso de 1,2 cobre 4:3 e 5:4 com folga.
export const MAZE_ASPECT_MIN = 1.2;
export const MAZE_ASPECT_MAX = 2.7;
/** Proporção assumida quando ninguém informou a da tela (16:9, a mais comum). */
export const MAZE_ASPECT_DEFAULT = 16 / 9;

// ORÇAMENTO de células por nº de jogadores (relatório G §2.3), braiding padrão de 65%.
//
// Desde a Fase 9 estas colunas e linhas NÃO são a forma final do labirinto: o que vale é o
// PRODUTO (o total de células, isto é, a densidade calibrada). `mazeShape()` em shared-sim
// redistribui esse mesmo total entre colunas e linhas para bater com a proporção da tela — é o
// que faz a arena preencher a janela em vez de ficar com margem morta nos lados.
//
// Fase A4: com sala cheia a arena antiga (6 jog. 1008×588, 10 jog. 1092×756) levava 17–18 s para
// atravessar a pé — quase metade dos 45 s de rodada é perseguição, não combate, e a pesquisa de
// design de jogos de festa pede arenas menores. As linhas de 6 a 10 travaram `cols` em 8 ou 9 (o
// intervalo que dá 10–13 s de travessia a `TANK_SPEED` fixo — ver `arena-densidade.test.ts`) e
// `rows` foi o menor valor que ainda garante 100% de spawns válidos (`SPAWN_LOS_MIN_DIST`) nas 200
// seeds × 6 proporções de tela de `maze.test.ts`, não um chute. `braidPct` ficou em 0,65 — igual
// ao resto da tabela — de propósito: só `rows` já bastou para fechar a folga de spawn, então não
// havia motivo para arriscar sem medir o efeito no ricochete (`_economia.ts` mede antes/depois).
export const MAZE_BY_PLAYERS: Record<number, MazeDensity> = {
  2: { cols: 6, rows: 4, braidPct: 0.65 },
  3: { cols: 7, rows: 5, braidPct: 0.65 },
  4: { cols: 8, rows: 6, braidPct: 0.65 },
  5: { cols: 9, rows: 6, braidPct: 0.65 },
  6: { cols: 8, rows: 8, braidPct: 0.65 },
  7: { cols: 8, rows: 8, braidPct: 0.65 },
  8: { cols: 9, rows: 10, braidPct: 0.65 },
  9: { cols: 9, rows: 11, braidPct: 0.65 },
  10: { cols: 9, rows: 13, braidPct: 0.65 },
};

// Limite de balas vivas por jogador (relatório G §7.4, risco 7) — mantém a leitura da tela quando
// a contagem de projéteis simultâneos cresce com a sala.
//
// Fase 12: a tabela inteira desceu um degrau junto com `MAX_BULLETS` (3→2). Continua valendo a
// mesma relação de antes: o padrão até 8 jogadores, e um a menos na sala cheia, onde 10 tanques
// atirando ao mesmo tempo é o pior caso de leitura.
export const MAX_BULLETS_BY_PLAYERS: Record<number, number> = {
  2: 2,
  3: 2,
  4: 2,
  5: 2,
  6: 2,
  7: 2,
  8: 2,
  9: 1,
  10: 1,
};
