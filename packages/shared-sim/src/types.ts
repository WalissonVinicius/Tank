export interface Vec2 {
  x: number;
  y: number;
}

export interface Aabb {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Maze {
  cols: number;
  rows: number;
  cell: number;
  walls: Aabb[];
}

export interface Tank {
  id: string;
  x: number;
  y: number;
  heading: number; // rad — direção do chassi (só movimento sai daqui)
  turret: number; // rad — direção da torre, gira até `Input.aim` a TURRET_RATE; a BALA sai daqui
  alive: boolean;
  fireCooldownLeft: number; // segundos até poder atirar de novo
}

export interface Bullet {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  bounces: number;
  age: number; // segundos desde o disparo
}

export interface SimState {
  tick: number;
  maze: Maze;
  tanks: Map<string, Tank>;
  bullets: Bullet[];
  nextBulletId: number;
}

export interface Input {
  turn: -1 | 0 | 1; // -1 esquerda, 1 direita
  move: -1 | 0 | 1; // -1 ré, 1 frente
  fire: boolean;
  /**
   * Ângulo absoluto (rad) para onde a torre deve apontar — no jogador, a direção do cursor do
   * mouse; no bot, a direção do alvo com o erro de mira da dificuldade. Ausente = a torre fica
   * parada onde está (é o caso de quem não mandou input naquele tick: nada de "voltar ao chassi",
   * que reintroduziria uma segunda regra de torre e quebraria o determinismo entre as pontas).
   */
  aim?: number;
}

export type SimEvent =
  | { type: 'shot'; ownerId: string; bulletId: string; x: number; y: number; angle: number; tick: number }
  | { type: 'bounce'; bulletId: string; x: number; y: number; normal: Vec2; tick: number }
  | {
      type: 'death';
      victimId: string;
      killerId: string;
      x: number;
      y: number;
      tick: number;
      autogol: boolean;
    }
  | {
      /**
       * A bala saiu de cena por conta própria, de um de dois jeitos (Fase 10):
       *   · `'max_bounces'` — encostou na parede uma vez a mais do que `MAX_BOUNCES` permite.
       *     Morte silenciosa: nem explosão, nem som;
       *   · `'life'` — esgotou os `BULLET_LIFE` segundos sem encostar em nada, e EXPLODE.
       * `x`/`y` são o ponto onde ela estava; sem a posição o render não teria onde desenhar o
       * estouro do segundo caso.
       */
      type: 'bullet_expired';
      bulletId: string;
      reason: 'max_bounces' | 'life';
      x: number;
      y: number;
      tick: number;
    }
  | {
      /**
       * Duas balas se cruzaram dentro do mesmo tick e se destruíram (Fase 5). `x`/`y` são o ponto
       * de encontro — o meio do caminho entre as duas no instante de aproximação máxima, não a
       * posição final de nenhuma delas.
       */
      type: 'bullet_clash';
      aId: string;
      bId: string;
      x: number;
      y: number;
      tick: number;
    };
