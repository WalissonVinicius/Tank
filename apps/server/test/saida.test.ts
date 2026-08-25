// Fase 13 §1 — SAIR DA SALA de verdade.
//
// Até aqui `onLeave` era um só para dois acontecimentos muito diferentes: quem clica em sair e
// quem perde a conexão. O resultado era o mesmo dos dois lados — a vaga ficava presa e o tanque
// continuava de pé no meio da arena. Agora o `code` separa os casos, e é isso que se prova aqui.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloseCode, matchMaker, type Client } from '@colyseus/core';
import { PLAYER_COLORS } from '@tank/protocol';
import { TankRoom } from '../src/rooms/TankRoom.js';

const DT = 1 / 60;

function cliente(sessionId: string): Client {
  return { sessionId } as Client;
}

async function novaSala(options: Record<string, unknown> = {}): Promise<TankRoom> {
  const cache = await matchMaker.createRoom('tank_room', { roundTimeoutSeconds: 5, ...options });
  return matchMaker.getLocalRoomById(cache.roomId) as TankRoom;
}

/** Leva a sala do lobby até a rodada rolando, com todo mundo pronto. */
function comecarPartida(room: TankRoom): void {
  room.state.players.forEach((p) => {
    p.ready = true;
  });
  for (let i = 0; i < 400 && room.state.phase !== 'playing'; i++) room.update(DT);
}

describe('sair da sala — intencional × queda de conexão', () => {
  beforeAll(async () => {
    await matchMaker.setup();
    matchMaker.defineRoomType('tank_room', TankRoom);
  });

  afterAll(async () => {
    await Promise.all(matchMaker.disconnectAll()).catch(() => undefined);
  });

  it('saída intencional some com o jogador e devolve a cor para a paleta', async () => {
    const room = await novaSala();
    await room.onJoin(cliente('a'), { nome: 'Ana', cor: PLAYER_COLORS[3] });
    await room.onJoin(cliente('b'), { nome: 'Bruno' });
    expect(room.state.players.size).toBe(2);

    await room.onLeave(cliente('a'), CloseCode.CONSENTED);

    expect(room.state.players.has('a')).toBe(false);
    expect(room.state.players.size).toBe(1);

    // A cor que Ana levava volta a ser oferecida a quem chegar depois.
    await room.onJoin(cliente('c'), { nome: 'Carla', cor: PLAYER_COLORS[3] });
    expect(room.state.players.get('c')!.color).toBe(PLAYER_COLORS[3]);
  });

  it('quem sai no meio da rodada não deixa tanque fantasma na arena dos outros', async () => {
    const room = await novaSala({ bots: 3 });
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    comecarPartida(room);
    expect(room.state.phase).toBe('playing');

    const tanquesAntes = room.tanquesNaSimulacao();
    expect(tanquesAntes).toContain('a');

    await room.onLeave(cliente('a'), CloseCode.CONSENTED);

    expect(room.tanquesNaSimulacao()).not.toContain('a');
    expect(room.state.players.has('a')).toBe(false);
  });

  it('queda de conexão NÃO devolve a vaga — ela fica guardada durante a janela de reconexão', async () => {
    const room = await novaSala();
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    await room.onJoin(cliente('b'), { nome: 'Bruno' });

    // `onDrop` é o que o Colyseus chama quando a conexão cai (o `onLeave` só vem depois, se a
    // janela de 30 s expirar). Aqui ele fica pendurado de propósito: é a janela correndo.
    const janela = room.onDrop(cliente('a'), 1006);

    expect(room.state.players.has('a')).toBe(true);
    expect(room.state.players.get('a')!.connected).toBe(false);

    // E a reconexão devolve o jogador inteiro, com o mesmo slot e a mesma cor.
    room.onReconnect(cliente('a'));
    expect(room.state.players.get('a')!.connected).toBe(true);
    void janela;
  });

  it('a janela expirada (onLeave depois do onDrop) libera a vaga do mesmo jeito', async () => {
    const room = await novaSala();
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    await room.onJoin(cliente('b'), { nome: 'Bruno' });

    // É exatamente o que o Colyseus faz quando os 30 s acabam sem reconexão.
    await room.onLeave(cliente('a'), 1006);

    expect(room.state.players.has('a')).toBe(false);
    expect(room.state.players.size).toBe(1);
  });

  it('o último humano saindo encerra a sala em vez de deixá-la viva com bots', async () => {
    const room = await novaSala({ bots: 4 });
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    const codigo = room.roomId;

    expect((await matchMaker.query({ roomId: codigo })).length).toBe(1);

    await room.onLeave(cliente('a'), CloseCode.CONSENTED);

    // Some do cadastro do matchMaker: ninguém mais a encontra pelo código nem pela listagem.
    expect((await matchMaker.query({ roomId: codigo })).length).toBe(0);
  });

  it('com dois humanos, a saída de um NÃO encerra a sala', async () => {
    const room = await novaSala({ bots: 2 });
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    await room.onJoin(cliente('b'), { nome: 'Bruno' });
    const codigo = room.roomId;

    await room.onLeave(cliente('a'), CloseCode.CONSENTED);

    expect((await matchMaker.query({ roomId: codigo })).length).toBe(1);
    expect(room.state.players.has('b')).toBe(true);
  });

  it('o posto de dono passa para o próximo humano quando o dono sai', async () => {
    const room = await novaSala();
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    await room.onJoin(cliente('b'), { nome: 'Bruno' });
    expect(room.state.ownerId).toBe('a');

    await room.onLeave(cliente('a'), CloseCode.CONSENTED);
    expect(room.state.ownerId).toBe('b');
  });
});
