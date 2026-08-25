import { MapSchema, Schema, type } from '@colyseus/schema';
import { PlayerState } from './PlayerState.js';

export type RoomPhase = 'lobby' | 'countdown' | 'playing' | 'roundend' | 'gameover';

export class TankRoomState extends Schema {
  @type('string') phase: RoomPhase = 'lobby';
  @type('number') round: number = 0;
  @type('number') seed: number = 0;
  /**
   * Proporção do labirinto combinada para a rodada atual (Fase 9). Anda no estado FRIO, e não só
   * no `round_start`, por causa de quem entra com a partida já em andamento: essa pessoa nunca
   * recebeu o `round_start` da rodada e reconstrói o labirinto pela seed — sem a proporção junto,
   * reconstruiria com outra forma e veria as balas ricochetearem no lugar errado.
   */
  @type('number') aspect: number = 0;
  @type('number') timeLeft: number = 0;
  /**
   * DONO da sala (Fase 13 §3): o primeiro humano que entrou, e quem herdar o posto quando ele
   * sair. É só ele que coloca e tira bots no lobby — para os outros os botões nem aparecem, e o
   * servidor recusa o pedido de qualquer jeito. Vazio numa sala sem humano nenhum.
   */
  @type('string') ownerId: string = '';
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}
