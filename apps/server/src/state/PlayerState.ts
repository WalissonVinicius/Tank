import { Schema, type } from '@colyseus/schema';

export class PlayerState extends Schema {
  @type('string') id: string = '';
  @type('string') name: string = '';
  @type('number') color: number = 0;
  @type('number') score: number = 0;
  @type('boolean') alive: boolean = false;
  @type('boolean') connected: boolean = true;
  @type('boolean') ready: boolean = false;
  @type('boolean') isBot: boolean = false;
  @type('number') kills: number = 0;
  @type('number') deaths: number = 0;
  @type('number') selfKills: number = 0;

  /** Índice 0–9 usado como "id" compacto no snapshot binário quente (net/snapshot.ts). */
  @type('uint8') slot: number = 0;
}
