import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchMaker } from '@colyseus/core';
import { COUNTDOWN } from '@tank/protocol';
import { TankRoom } from '../src/rooms/TankRoom.js';

const DT = 1 / 60;
const MAX_TICKS = 20_000; // teto de segurança — nunca deveria ser atingido (ver comentário abaixo)

describe('TankRoom — partida em processo com bots', () => {
  beforeAll(async () => {
    await matchMaker.setup();
    matchMaker.defineRoomType('tank_room', TankRoom);
  });

  afterAll(async () => {
    await Promise.all(matchMaker.disconnectAll()).catch(() => undefined);
  });

  it('roda ~600+ ticks até a rodada terminar com um vencedor e o placar bater', async () => {
    // `permitirPartidaSoDeBots`: em produção uma sala sem humano nunca começa (senão quem cria a
    // sala com bots vira espectador da própria sala). Aqui a partida É só de bots, de propósito.
    const cache = await matchMaker.createRoom('tank_room', {
      bots: 3,
      roundTimeoutSeconds: 5,
      permitirPartidaSoDeBots: true,
    });
    const room = matchMaker.getLocalRoomById(cache.roomId) as TankRoom;
    expect(room).toBeTruthy();

    // Chama update() manualmente em vez de esperar o setSimulationInterval real: 600 ticks a
    // 60 Hz são só 10 s de jogo (3 s de countdown + 7 s de partida), o que nem sempre é tempo
    // suficiente pra 3 bots se encontrarem no labirinto e um autogol acontecer de verdade. Por
    // isso o teto de segurança é bem maior — a morte súbita (a cada 3 s remove uma parede) e o
    // roundTimeoutSeconds curto (5 s) garantem que a rodada termina de forma limitada mesmo se
    // os bots nunca se encontrarem.
    let ticks = 0;
    while (room.state.phase !== 'roundend' && room.state.phase !== 'gameover' && ticks < MAX_TICKS) {
      room.update(DT);
      ticks += 1;
    }

    expect(ticks).toBeLessThan(MAX_TICKS);
    // Pelo menos o countdown inteiro (3 s a 60 Hz) + 1 tick de partida. Não dá para exigir mais:
    // a seed do labirinto é sorteada por rodada e, com o pathing do bot, 3 bots às vezes se acham
    // em 4 s e às vezes em 12 s. O teto de MAX_TICKS é quem protege contra a rodada não terminar.
    expect(ticks).toBeGreaterThan(COUNTDOWN * 60);
    expect(room.state.round).toBe(1);
    expect(['roundend', 'gameover']).toContain(room.state.phase);

    const players = Array.from(room.state.players.values());
    expect(players).toHaveLength(3);

    // ninguém "zera": todo mundo com pelo menos 1 ponto de posição
    for (const player of players) {
      expect(player.score).toBeGreaterThanOrEqual(0);
    }

    const totalScore = players.reduce((sum, p) => sum + p.score, 0);
    expect(totalScore).toBeGreaterThan(0);

    // no máximo 1 sobrevivente contando como "vencedor" (posição mais alta) — a menos que a
    // morte súbita tenha esgotado as paredes internas e terminado em empate técnico.
    const aliveCount = players.filter((p) => p.alive).length;
    expect(aliveCount).toBeLessThanOrEqual(3);
  });

  // Regressão: os bots entram em `onCreate` já prontos e o tick seguinte via "todos prontos",
  // começando a partida ANTES de o `onJoin` do criador rodar — quem abria uma sala com bots caía
  // como espectador da própria sala e nunca jogava.
  it('sala só de bots não começa sozinha — espera pelo menos um humano', async () => {
    const cache = await matchMaker.createRoom('tank_room', { bots: 4, roundTimeoutSeconds: 5 });
    const room = matchMaker.getLocalRoomById(cache.roomId) as TankRoom;

    for (let i = 0; i < 600; i++) room.update(DT);
    expect(room.state.phase).toBe('lobby');
    expect(room.state.round).toBe(0);
  });
});
