// Unicidade de cor (Fase 10 §5). A regra é do SERVIDOR — "o cliente só sugere" —, então é aqui
// que ela precisa estar provada: dois jogadores podem clicar na mesma cor no mesmo instante, e a
// sala tem que atender um só.
//
// As mensagens são despachadas direto no emissor interno do Room (`onMessageEvents`), que é o
// mesmo caminho que o `_onMessage` do Colyseus usa quando o pacote chega pela rede — assim o
// teste exercita o handler de verdade registrado em `onCreate`, sem WebSocket no meio.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchMaker, type Client } from '@colyseus/core';
import { MessageType, PLAYER_COLORS } from '@tank/protocol';
import { TankRoom } from '../src/rooms/TankRoom.js';

interface EmissorInterno {
  onMessageEvents: { emit(tipo: string, client: Client, mensagem: unknown): void };
}

function cliente(sessionId: string): Client {
  return { sessionId } as Client;
}

function pedirCor(room: TankRoom, sessionId: string, cor: number): void {
  (room as unknown as EmissorInterno).onMessageEvents.emit(MessageType.PickColor, cliente(sessionId), { color: cor });
}

async function novaSala(bots = 0): Promise<TankRoom> {
  const cache = await matchMaker.createRoom('tank_room', { bots, roundTimeoutSeconds: 5 });
  return matchMaker.getLocalRoomById(cache.roomId) as TankRoom;
}

function corDe(room: TankRoom, sessionId: string): number {
  return room.state.players.get(sessionId)!.color;
}

describe('cor do tanque — a unicidade é do servidor', () => {
  beforeAll(async () => {
    await matchMaker.setup();
    matchMaker.defineRoomType('tank_room', TankRoom);
  });

  afterAll(async () => {
    await Promise.all(matchMaker.disconnectAll()).catch(() => undefined);
  });

  it('quem entra sem pedir nada recebe a primeira cor livre, em ordem', async () => {
    const room = await novaSala();
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    await room.onJoin(cliente('b'), { nome: 'Bruno' });
    await room.onJoin(cliente('c'), { nome: 'Carla' });

    expect(corDe(room, 'a')).toBe(PLAYER_COLORS[0]);
    expect(corDe(room, 'b')).toBe(PLAYER_COLORS[1]);
    expect(corDe(room, 'c')).toBe(PLAYER_COLORS[2]);
  });

  it('a cor guardada no navegador é atendida quando está livre', async () => {
    const room = await novaSala();
    await room.onJoin(cliente('a'), { nome: 'Ana', cor: PLAYER_COLORS[7] });
    expect(corDe(room, 'a')).toBe(PLAYER_COLORS[7]);
  });

  it('cor guardada já ocupada cai na primeira livre em vez de repetir', async () => {
    const room = await novaSala();
    await room.onJoin(cliente('a'), { nome: 'Ana', cor: PLAYER_COLORS[4] });
    await room.onJoin(cliente('b'), { nome: 'Bruno', cor: PLAYER_COLORS[4] });

    expect(corDe(room, 'a')).toBe(PLAYER_COLORS[4]);
    expect(corDe(room, 'b')).toBe(PLAYER_COLORS[0]);
    expect(corDe(room, 'b')).not.toBe(corDe(room, 'a'));
  });

  it('trocar de cor no lobby vale, e libera a cor antiga para outro', async () => {
    const room = await novaSala();
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    await room.onJoin(cliente('b'), { nome: 'Bruno' });

    pedirCor(room, 'a', PLAYER_COLORS[9]!);
    expect(corDe(room, 'a')).toBe(PLAYER_COLORS[9]);

    // A cor que Ana largou (índice 0) volta a ser escolhível.
    pedirCor(room, 'b', PLAYER_COLORS[0]!);
    expect(corDe(room, 'b')).toBe(PLAYER_COLORS[0]);
  });

  it('dois pedidos da MESMA cor no mesmo instante: o segundo é ignorado', async () => {
    const room = await novaSala();
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    await room.onJoin(cliente('b'), { nome: 'Bruno' });
    const corDeBrunoAntes = corDe(room, 'b');

    // As mensagens chegam serializadas no laço do servidor — é isso que decide o empate.
    pedirCor(room, 'a', PLAYER_COLORS[5]!);
    pedirCor(room, 'b', PLAYER_COLORS[5]!);

    expect(corDe(room, 'a')).toBe(PLAYER_COLORS[5]);
    expect(corDe(room, 'b'), 'quem chegou depois fica com a cor que já tinha').toBe(corDeBrunoAntes);
  });

  it('cor fora da paleta é recusada', async () => {
    const room = await novaSala();
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    const antes = corDe(room, 'a');

    pedirCor(room, 'a', 0x123456);
    pedirCor(room, 'a', Number.NaN);
    expect(corDe(room, 'a')).toBe(antes);
  });

  it('durante a partida a cor trava — trocar só no lobby', async () => {
    const room = await novaSala(2);
    await room.onJoin(cliente('a'), { nome: 'Ana' });
    const antes = corDe(room, 'a');

    // Todo mundo pronto: os bots já entram prontos, e o humano marca pronto no lobby.
    room.state.players.get('a')!.ready = true;
    for (let i = 0; i < 5 && room.state.phase === 'lobby'; i++) room.update(1 / 60);
    expect(room.state.phase).not.toBe('lobby');

    pedirCor(room, 'a', PLAYER_COLORS[8]!);
    expect(corDe(room, 'a')).toBe(antes);
  });

  it('sala cheia: as 10 cores saem sem repetir nenhuma', async () => {
    const room = await novaSala();
    for (let i = 0; i < 10; i++) await room.onJoin(cliente(`p${i}`), { nome: `J${i}` });

    const cores = Array.from(room.state.players.values()).map((p) => p.color);
    expect(cores).toHaveLength(10);
    expect(new Set(cores).size).toBe(10);
    expect([...cores].sort()).toEqual([...PLAYER_COLORS].sort());
  });
});
