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
  // rad — para onde o chassi APONTA. Desde o movimento absoluto é puramente cosmético: ele
  // persegue `Input.mover` a TURN_RATE, mas quem decide o deslocamento é `Input.mover`, não ele.
  heading: number;
  turret: number; // rad — direção da torre, gira até `Input.aim` a TURRET_RATE; a BALA sai daqui
  alive: boolean;
  fireCooldownLeft: number; // segundos até poder atirar de novo

  // -------------------------------------------------------------------------------------------
  // POWER-UPS (P1) — quatro bônus ADITIVOS, todos com "sem efeito" no valor ZERO.
  //
  // São opcionais só por compatibilidade com quem monta `Tank` sem eles; a semântica é a de um
  // campo obrigatório cujo zero-value é o padrão do jogo, e é assim que o porte para Go deve
  // escrevê-los (`float64`/`int` comuns, sem ponteiro). Nenhuma regra do jogo lê "tem power-up?":
  // cada linha da simulação soma o bônus ao valor de tuning e segue.
  //
  // Quem LIGA e DESLIGA estes campos é `EfeitosDePowerUp` (powerups.ts) — a simulação só os lê.
  // -------------------------------------------------------------------------------------------

  /**
   * Rebotes EXTRAS que as balas disparadas A PARTIR DE AGORA recebem. Não afeta bala já em voo:
   * o número é COPIADO para `Bullet.ricochete` no instante do disparo, e é a cópia que manda.
   */
  ricochete?: number;
  /** Balas simultâneas EXTRAS, somadas ao teto de `MAX_BULLETS_BY_PLAYERS`. */
  municao?: number;
  /** Fração do cooldown de tiro descontada. 0,5 = recarrega na metade do tempo. */
  recarga?: number;
  /** Fração EXTRA de velocidade de deslocamento. 0,35 = +35%. */
  turbo?: number;
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
  /**
   * Rebotes EXTRAS DESTA bala, acima de `MAX_BOUNCES`, carimbados no disparo a partir de
   * `Tank.ricochete` (P1). 0 = bala comum.
   *
   * O carimbo é o ponto inteiro do desenho. A bala não trafega pela rede: cada cliente simula a
   * trajetória localmente, e o valor viaja junto dela em `BulletSpawnMsg.ricochete`. Ler o efeito
   * do atirador na hora de simular faria a bala trocar de regra no meio do voo, no instante em
   * que o power-up expirasse no dono — e trocaria em instantes diferentes em cada tela.
   */
  ricochete?: number;
}

export interface SimState {
  tick: number;
  maze: Maze;
  tanks: Map<string, Tank>;
  bullets: Bullet[];
  nextBulletId: number;
}

export interface Input {
  /**
   * Direção do movimento em radianos, em coordenadas de MUNDO (Y cresce para baixo). `null` =
   * parado. O tanque anda para lá NESTE tick, na velocidade cheia — o giro do chassi não atrasa
   * mais o deslocamento.
   *
   * É ângulo, e não um par `{x,y}` ou o antigo `turn`/`move`, por dois motivos. Ângulo é unitário
   * por construção, então a diagonal não tem como andar √2 vezes mais rápido que o reto (o bug
   * clássico do movimento em 8 direções nem chega a ser representável). E é a mesma unidade de
   * `heading`, `turret` e `aim`: uma direção no jogo se escreve de um jeito só.
   *
   * Quem monta esse ângulo a partir das quatro teclas é `direcaoDeMovimento` do `@tank/protocol`,
   * em ponta nenhuma — a rede continua carregando os booleanos.
   */
  mover: number | null;
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
  /**
   * `vx`/`vy` andam junto com `angle` de proposito, e nao sao redundancia.
   *
   * O `angle` e COSMETICO: serve para o muzzle flash apontar para o lado certo. Quem define a
   * FISICA da bala e o par `vx`/`vy`, e ele viaja pronto para o cliente em vez de ser
   * recalculado la com `cos`/`sin`.
   *
   * O motivo e portabilidade: o cliente simula a bala localmente com o MESMO codigo do servidor,
   * e se um dia o servidor for outra linguagem, `math.Cos` de la e `Math.cos` do V8 podem
   * divergir no ultimo bit. Mandando o vetor pronto, a trajetoria vira aritmetica linear pura
   * (soma e multiplicacao, mais troca de sinal no rebote), que e identica em qualquer
   * implementacao de IEEE 754. A divergencia deixa de ser possivel em vez de ser improvavel.
   */
  | {
      type: 'shot';
      ownerId: string;
      bulletId: string;
      x: number;
      y: number;
      angle: number;
      vx: number;
      vy: number;
      /** Rebotes extras carimbados nesta bala (P1). O servidor repassa em `BulletSpawnMsg`. */
      ricochete: number;
      tick: number;
    }
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
