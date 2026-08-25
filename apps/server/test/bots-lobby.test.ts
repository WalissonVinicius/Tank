// Fase 13 §3 — bots entram e saem PELO LOBBY DA SALA.
//
// O servidor já aceitava `bots` na criação, mas não havia como mexer depois nem como pedir isso
// pela interface. Aqui prova-se o contrato do lado do servidor: só o dono manda, o limite de 10
// vagas vale, e humano tem prioridade sobre bot.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloseCode, matchMaker, type Client } from '@colyseus/core';
import { MessageType, VAGAS_POR_SALA } from '@tank/protocol';
import { TankRoom } from '../src/rooms/TankRoom.js';

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

function bots(room: TankRoom): number {
  let n = 0;
  room.state.players.forEach((p) => {
    if (p.isBot) n += 1;
  });
  return n;
}

async function novaSala(options: Record<string, unknown> = {}): Promise<TankRoom> {
  const cache = await matchMaker.createRoom('tank_room', { roundTimeoutSeconds: 5, ...options });
  return matchMaker.getLocalRoomById(cache.roomId) as TankRoom;
}

describe('bots no lobby da sala', () => {
  beforeAll(async () => {
    await matchMaker.setup();
    matchMaker.defineRoomType('tank_room', TankRoom);
  });

  afterAll(async () => {
    await Promise.all(matchMaker.disconnectAll()).catch(() => undefined);
  });

  it('o primeiro humano a entrar vira o dono da sala', async () => {
    const room = await novaSala({ bots: 2 });
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    await room.onJoin(cliente('b'), { nome: 'Bruno' });
    expect(room.state.ownerId).toBe('a');
  });

  it('o dono adiciona e remove bot, e cada bot recebe uma cor só dele', async () => {
    const room = await novaSala();
    await room.onJoin(cliente('a'), { nome: 'Ana' });

    mandar(room, 'a', MessageType.AddBot);
    mandar(room, 'a', MessageType.AddBot);
    expect(bots(room)).toBe(2);

    const cores = Array.from(room.state.players.values()).map((p) => p.color);
    expect(new Set(cores).size).toBe(cores.length);

    mandar(room, 'a', MessageType.RemoveBot);
    expect(bots(room)).toBe(1);
  });

  it('quem não é dono não mexe nos bots', async () => {
    const room = await novaSala({ bots: 1 });
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    await room.onJoin(cliente('b'), { nome: 'Bruno' });

    mandar(room, 'b', MessageType.AddBot);
    expect(bots(room)).toBe(1);

    mandar(room, 'b', MessageType.RemoveBot);
    expect(bots(room)).toBe(1);
  });

  it('o limite de 10 vagas vale — o 11º + BOT não faz nada', async () => {
    const room = await novaSala();
    await room.onJoin(cliente('a'), { nome: 'Ana' });

    for (let i = 0; i < 15; i++) mandar(room, 'a', MessageType.AddBot);
    expect(room.state.players.size).toBe(VAGAS_POR_SALA);
    expect(bots(room)).toBe(VAGAS_POR_SALA - 1);
  });

  it('− BOT numa sala sem bot nenhum não derruba jogador', async () => {
    const room = await novaSala();
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    await room.onJoin(cliente('b'), { nome: 'Bruno' });

    mandar(room, 'a', MessageType.RemoveBot);
    expect(room.state.players.size).toBe(2);
  });

  it('com a partida em andamento os botões não valem mais', async () => {
    const room = await novaSala({ bots: 2 });
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    room.state.players.forEach((p) => {
      p.ready = true;
    });
    for (let i = 0; i < 400 && room.state.phase === 'lobby'; i++) room.update(DT);
    expect(room.state.phase).not.toBe('lobby');

    const antes = bots(room);
    mandar(room, 'a', MessageType.AddBot);
    mandar(room, 'a', MessageType.RemoveBot);
    expect(bots(room)).toBe(antes);
  });

  it('humano tem prioridade: sala cheia de bots abre vaga para quem chega', async () => {
    const room = await novaSala({ bots: 9 });
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    expect(room.state.players.size).toBe(VAGAS_POR_SALA);
    expect(bots(room)).toBe(9);

    await room.onJoin(cliente('b'), { nome: 'Bruno' });

    expect(room.state.players.has('b')).toBe(true);
    expect(room.state.players.size).toBe(VAGAS_POR_SALA);
    expect(bots(room)).toBe(8);
  });

  it('sala cheia de gente NÃO expulsa ninguém — o décimo primeiro humano assiste', async () => {
    const room = await novaSala();
    for (let i = 0; i < VAGAS_POR_SALA; i++) await room.onJoin(cliente(`p${i}`), { nome: `J${i}` });

    await room.onJoin(cliente('extra'), { nome: 'Extra' });
    expect(room.state.players.has('extra')).toBe(false);
    expect(room.state.players.size).toBe(VAGAS_POR_SALA);
  });

  it('o dono some junto com quem saiu e o próximo humano assume o controle dos bots', async () => {
    const room = await novaSala({ bots: 1 });
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    await room.onJoin(cliente('b'), { nome: 'Bruno' });

    await room.onLeave(cliente('a'), CloseCode.CONSENTED);
    expect(room.state.ownerId).toBe('b');

    mandar(room, 'b', MessageType.AddBot);
    expect(bots(room)).toBe(2);
  });
});
