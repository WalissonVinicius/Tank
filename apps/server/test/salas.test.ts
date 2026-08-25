// Fase 13 §2 — a lista de SALAS ABERTAS da tela de entrada.
//
// A listagem sai do cadastro do matchMaker (`matchMaker.query`) lendo o `metadata` que cada sala
// publica. O que se prova aqui é que esse metadata acompanha a sala de verdade: entrou gente,
// entrou bot, começou a partida, acabou a partida.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloseCode, matchMaker, type Client } from '@colyseus/core';
import { MessageType, VAGAS_POR_SALA } from '@tank/protocol';
import { TankRoom } from '../src/rooms/TankRoom.js';
import { listarSalasAbertas } from '../src/net/salas.js';

const DT = 1 / 60;

interface EmissorInterno {
  onMessageEvents: { emit(tipo: string, client: Client, mensagem: unknown): void };
}

function cliente(sessionId: string): Client {
  return { sessionId } as Client;
}

function mandar(room: TankRoom, sessionId: string, tipo: string): void {
  (room as unknown as EmissorInterno).onMessageEvents.emit(tipo, cliente(sessionId), undefined);
}

async function novaSala(options: Record<string, unknown> = {}): Promise<TankRoom> {
  const cache = await matchMaker.createRoom('tank_room', { roundTimeoutSeconds: 5, ...options });
  return matchMaker.getLocalRoomById(cache.roomId) as TankRoom;
}

/** Só as salas criadas por ESTE teste — o processo de teste é único e as suítes dividem o driver. */
async function listarSo(codigos: string[]): Promise<Awaited<ReturnType<typeof listarSalasAbertas>>> {
  const todas = await listarSalasAbertas();
  return todas.filter((s) => codigos.includes(s.codigo));
}

describe('listagem de salas abertas', () => {
  beforeAll(async () => {
    await matchMaker.setup();
    matchMaker.defineRoomType('tank_room', TankRoom);
  });

  afterAll(async () => {
    await Promise.all(matchMaker.disconnectAll()).catch(() => undefined);
  });

  it('mostra código, quantos humanos, quantos bots e quantas vagas sobram', async () => {
    const room = await novaSala({ bots: 2 });
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    await room.onJoin(cliente('b'), { nome: 'Bruno' });

    const [sala] = await listarSo([room.roomId]);
    expect(sala).toBeDefined();
    expect(sala!.codigo).toBe(room.roomId);
    expect(sala!.humanos).toBe(2);
    expect(sala!.bots).toBe(2);
    expect(sala!.livres).toBe(VAGAS_POR_SALA - 4);
    expect(sala!.emPartida).toBe(false);

    await room.disconnect();
  });

  it('sala em partida continua na lista, marcada — quem entra nela vira espectador', async () => {
    const room = await novaSala({ bots: 3 });
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    room.state.players.forEach((p) => {
      p.ready = true;
    });
    for (let i = 0; i < 400 && room.state.phase === 'lobby'; i++) room.update(DT);
    expect(room.state.phase).not.toBe('lobby');

    const [sala] = await listarSo([room.roomId]);
    expect(sala?.emPartida).toBe(true);

    // E entrar nela de fato coloca a pessoa na plateia, sem roubar vaga de quem está jogando.
    const antes = room.state.players.size;
    await room.onJoin(cliente('z'), { nome: 'Zeca' });
    expect(room.state.players.size).toBe(antes);

    await room.disconnect();
  });

  it('sala cheia no lobby sai da lista, e volta assim que uma vaga abre', async () => {
    const room = await novaSala();
    for (let i = 0; i < VAGAS_POR_SALA; i++) await room.onJoin(cliente(`p${i}`), { nome: `J${i}` });
    expect(room.state.players.size).toBe(VAGAS_POR_SALA);

    expect(await listarSo([room.roomId])).toHaveLength(0);

    await room.onLeave(cliente('p3'), CloseCode.CONSENTED);
    const [sala] = await listarSo([room.roomId]);
    expect(sala?.livres).toBe(1);

    await room.disconnect();
  });

  it('partida encerrada some da lista', async () => {
    const room = await novaSala({ bots: 2, rodadas: 1, roundTimeoutSeconds: 1 });
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    room.state.players.forEach((p) => {
      p.ready = true;
    });
    for (let i = 0; i < 4000 && room.state.phase !== 'gameover'; i++) room.update(DT);
    expect(room.state.phase).toBe('gameover');

    expect(await listarSo([room.roomId])).toHaveLength(0);
    await room.disconnect();
  });

  it('sala encerrada (último humano saiu) some do cadastro e da lista', async () => {
    const room = await novaSala({ bots: 2 });
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    const codigo = room.roomId;
    expect(await listarSo([codigo])).toHaveLength(1);

    await room.onLeave(cliente('a'), CloseCode.CONSENTED);
    expect(await listarSo([codigo])).toHaveLength(0);
  });

  it('as que ainda não começaram vêm antes das que já estão jogando', async () => {
    const jogando = await novaSala({ bots: 3 });
    await jogando.onJoin(cliente('a'), { nome: 'Ana' });
    jogando.state.players.forEach((p) => {
      p.ready = true;
    });
    for (let i = 0; i < 400 && jogando.state.phase === 'lobby'; i++) jogando.update(DT);

    const esperando = await novaSala();
    await esperando.onJoin(cliente('b'), { nome: 'Bruno' });

    const lista = await listarSo([jogando.roomId, esperando.roomId]);
    expect(lista.map((s) => s.codigo)).toEqual([esperando.roomId, jogando.roomId]);

    await jogando.disconnect();
    await esperando.disconnect();
  });

  it('o metadata acompanha o + BOT do lobby', async () => {
    const room = await novaSala();
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    expect((await listarSo([room.roomId]))[0]!.bots).toBe(0);

    mandar(room, 'a', MessageType.AddBot);
    mandar(room, 'a', MessageType.AddBot);

    expect((await listarSo([room.roomId]))[0]!.bots).toBe(2);
    await room.disconnect();
  });
});
