// Tipos das mensagens cliente↔servidor (relatório G §4.1–4.2).

// Nomes de mensagem — usados como `type`/canal ao trocar via Colyseus ou WebSocket cru.
// FONTE DA VERDADE do nome do canal: servidor e cliente importam daqui, nunca escrevem a
// string à mão (foi assim que o canal do snapshot quase divergiu entre as duas pontas).
export const MessageType = {
  Input: 'input',
  Ready: 'ready',
  PickColor: 'pick_color',
  AddBot: 'add_bot',
  RemoveBot: 'remove_bot',
  Viewport: 'viewport',
  Snapshot: 'snapshot',
  BulletSpawn: 'bullet_spawn',
  BulletDead: 'bullet_dead',
  TankDeath: 'tank_death',
  RoundStart: 'round_start',
  RoundEnd: 'round_end',
  SuddenDeathWall: 'sudden_death_wall',
  GameOver: 'game_over',
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

// Input do jogador. Escolha: booleans/literais em vez de bitfield — mais simples de tipar e
// depurar; o empacotamento em bits (se necessário para banda) fica a cargo da camada de rede.
export interface InputMsg {
  seq: number; // uint16, incrementa a cada input enviado
  up: boolean; // avança
  down: boolean; // dá ré
  left: boolean; // gira à esquerda
  right: boolean; // gira à direita
  fire: boolean; // borda de subida detectada no cliente; servidor debita munição
  /**
   * Ângulo absoluto (rad) para onde a TORRE deve apontar — direção do cursor do mouse vista do
   * tanque. A torre não pula para lá: o servidor gira até esse alvo a `TURRET_RATE`. É entrada
   * como qualquer outra, então entra no mesmo caminho determinístico de `up/down/left/right`.
   */
  aim: number;
}

/** Formato realmente trafegado no canal `input` — bitfield de 5 flags, ver `server/net/input.ts`. */
export interface InputBitsMsg {
  seq: number; // uint16
  bits: number; // bit0 frente, bit1 ré, bit2 esquerda, bit3 direita, bit4 atirar
  /**
   * Mira quantizada em 1 byte: 0..255 cobre 0..2π (≈1,4° por passo). A torre gira devagar
   * (`TURRET_RATE`), então essa resolução é invisível na tela e economiza banda a 30 Hz.
   */
  aim: number;
}

/** 0..2π → 0..255. Espelhado por `decodeAim` no servidor; nenhuma das pontas escreve a conta à mão. */
export function encodeAim(rad: number): number {
  const TWO_PI = Math.PI * 2;
  let normalized = rad % TWO_PI;
  if (normalized < 0) normalized += TWO_PI;
  return Math.round((normalized / TWO_PI) * 255) & 0xff;
}

/** 0..255 → 0..2π. Inverso exato de `encodeAim`. */
export function decodeAim(byte: number): number {
  return ((byte & 0xff) / 255) * Math.PI * 2;
}

export const INPUT_BIT = {
  up: 0x01,
  down: 0x02,
  left: 0x04,
  right: 0x08,
  fire: 0x10,
} as const;

/** Canal `ready`: alterna o estado de pronto do jogador no lobby. */
export interface ReadyMsg {
  ready: boolean;
}

/**
 * Canal `pick_color`: o jogador PEDE uma das 10 cores da paleta para o próprio tanque.
 *
 * É pedido, não ordem. Quem garante que duas pessoas não fiquem com a mesma cor é o `TankRoom`,
 * que atende na ordem em que as mensagens chegam e ignora a que pedir uma cor já tomada — dois
 * jogadores podem clicar no mesmo quadrado no mesmo instante, e nesse caso o segundo simplesmente
 * continua com a cor que já tinha. O cliente descobre o resultado olhando o `PlayerState.color`
 * do estado frio, que é a única fonte da verdade.
 *
 * Só vale na fase `lobby`: trocar de cor com a partida em andamento embaralharia a leitura da
 * arena no meio de uma rodada.
 */
export interface PickColorMsg {
  /** Cor pedida, em 0xRRGGBB. Tem que ser uma das de `PLAYER_COLORS`. */
  color: number;
}

/**
 * Canais `add_bot` / `remove_bot` (Fase 13 §3): o DONO da sala coloca e tira bots enquanto
 * ninguém começou. Não levam corpo — a quantidade é sempre ±1, e quem conta as vagas (e recusa
 * o pedido de quem não é dono, ou que chega com a partida rolando) é o `TankRoom`.
 *
 * Bot ocupa vaga e cor como qualquer jogador; a unicidade de cor continua sendo do servidor. E
 * humano tem prioridade: se alguém entra com a sala cheia de bots, um bot sai para dar lugar.
 */
export type BotLobbyMsg = undefined;

/**
 * Canal `viewport`: cada cliente informa a proporção (largura/altura) da própria ÁREA JOGÁVEL.
 *
 * O servidor não tem tela, mas é ele que precisa decidir a forma do labirinto — se cada cliente
 * derivasse a forma do próprio `innerWidth`, a mesma seed geraria geometrias diferentes em cada
 * aba e a bala prevista localmente ricochetearia no lugar errado. Então as telas são recolhidas
 * aqui, o servidor tira UMA proporção da sala no início da rodada e a manda de volta em
 * `RoundStartMsg.aspect`.
 */
export interface ViewportMsg {
  aspect: number;
}

// `parede_excedeu_rebotes` voltou na Fase 10 junto com a regra que o produz (`MAX_BOUNCES = 1`):
// a bala morre no segundo toque de parede, e o cliente precisa distinguir isso de `expirou` —
// só o segundo caso explode na tela.
export type BulletDeathReason = 'acerto' | 'colisao_bala' | 'parede_excedeu_rebotes' | 'expirou';

export interface BulletSpawnMsg {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  angle: number; // rad
  tick: number; // tick de simulação do servidor em que o disparo ocorreu
}

export interface BulletDeadMsg {
  id: string;
  motivo: BulletDeathReason;
  tick: number;
  targetId?: string; // presente quando motivo === 'acerto'
}

export interface TankDeathMsg {
  victimId: string;
  killerId: string | null; // null só é possível em morte por evento externo (ex.: colapso de arena futuro)
  x: number;
  y: number;
  tick: number;
  autogol: boolean;
}

export interface RoundSpawn {
  playerId: string;
  x: number;
  y: number;
}

export interface RoundStartMsg {
  round: number;
  seed: number;
  /**
   * Nº de participantes usado para gerar o labirinto. O cliente precisa dele para chamar
   * `makeMaze(seed, playerCount, aspect)` com exatamente a mesma densidade do servidor — sem isso
   * a geometria diverge e a bala simulada localmente ricocheteia no lugar errado.
   */
  playerCount: number;
  /**
   * Proporção combinada para ESTA rodada (Fase 9), decidida pelo servidor a partir das telas
   * anunciadas em `ViewportMsg`. Vai junto da seed justamente para que o cliente NÃO derive a
   * forma do labirinto do próprio tamanho de janela — cada tela é de um tamanho, e o labirinto
   * tem que ser o mesmo para todos.
   */
  aspect: number;
  spawns: RoundSpawn[];
  tick: number;
}

export interface RoundRankingEntry {
  playerId: string;
  position: number; // 1 = vencedor
  score: number;
}

export interface RoundEndMsg {
  round: number;
  ranking: RoundRankingEntry[];
}

/**
 * Morte súbita: o servidor removeu uma parede interna do labirinto. O cliente tem que remover
 * a MESMA parede (`index` em `Maze.walls`) da própria cópia, senão a previsão de bala diverge.
 */
export interface SuddenDeathWallMsg {
  index: number;
  wall: { x: number; y: number; w: number; h: number };
  tick: number;
}

export interface GameOverEntry {
  playerId: string;
  nome: string;
  pontos: number;
  posicao: number;
}

export interface GameOverMsg {
  ranking: GameOverEntry[];
  titulos: {
    kamikaze: string | null;
    balaPerdida: string | null;
    covardeEstrategico: string | null;
  };
}
