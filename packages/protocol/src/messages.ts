// Tipos das mensagens cliente↔servidor (relatório G §4.1–4.2).

import type { TipoPowerUp } from './powerups.js';

// Nomes de mensagem — usados como `type`/canal ao trocar via Colyseus ou WebSocket cru.
// FONTE DA VERDADE do nome do canal: servidor e cliente importam daqui, nunca escrevem a
// string à mão (foi assim que o canal do snapshot quase divergiu entre as duas pontas).
export const MessageType = {
  Input: 'input',
  Ready: 'ready',
  PickColor: 'pick_color',
  AddBot: 'add_bot',
  RemoveBot: 'remove_bot',
  Rematch: 'rematch',
  Config: 'config',
  Viewport: 'viewport',
  Snapshot: 'snapshot',
  BulletSpawn: 'bullet_spawn',
  BulletDead: 'bullet_dead',
  TankDeath: 'tank_death',
  RoundStart: 'round_start',
  RoundEnd: 'round_end',
  SuddenDeathWall: 'sudden_death_wall',
  PowerupTaken: 'powerup_taken',
  PowerupExpired: 'powerup_expired',
  GameOver: 'game_over',
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

// Input do jogador. Escolha: booleans/literais em vez de bitfield — mais simples de tipar e
// depurar; o empacotamento em bits (se necessário para banda) fica a cargo da camada de rede.
export interface InputMsg {
  seq: number; // uint16, incrementa a cada input enviado
  up: boolean; // anda para CIMA na tela
  down: boolean; // anda para BAIXO na tela
  left: boolean; // anda para a ESQUERDA na tela
  right: boolean; // anda para a DIREITA na tela
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
  bits: number; // bit0 cima, bit1 baixo, bit2 esquerda, bit3 direita, bit4 atirar
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

/**
 * ÚNICO lugar onde as quatro teclas de direção viram uma direção de MUNDO (rad), e a razão de ela
 * morar no `protocol` e não em cada ponta: o servidor monta o `Input` a partir dos bits que
 * chegaram pela rede e o cliente monta o dele a partir das MESMAS quatro teclas. Duas cópias
 * dessa conta, ainda que idênticas hoje, divergiriam no primeiro ajuste — e divergir aqui é o
 * tanque andando para um lado no servidor e para outro na tela.
 *
 * O eixo Y cresce para BAIXO (é o do labirinto e o da tela), então `W` sozinho é `-π/2`.
 *
 * Devolve ÂNGULO, não vetor, de propósito: ângulo já é unitário por construção, e com ele é
 * impossível representar a diagonal de módulo √2 que faria o tanque andar 41% mais rápido na
 * diagonal — o bug clássico do movimento em 8 direções. De quebra, é a mesma unidade de
 * `heading`, `turret` e `aim`, que o resto da simulação já fala.
 */
export function direcaoDeMovimento(
  up: boolean,
  down: boolean,
  left: boolean,
  right: boolean,
): number | null {
  const dx = (right ? 1 : 0) - (left ? 1 : 0);
  const dy = (down ? 1 : 0) - (up ? 1 : 0);
  if (dx === 0 && dy === 0) return null;
  return Math.atan2(dy, dx);
}

/**
 * Inverso de `direcaoDeMovimento`: a direção volta a ser as quatro flags de `INPUT_BIT` para
 * viajar na rede. Quem manda input é o cliente, que já tem a direção pronta em `Input.mover`;
 * a rede continua carregando BOOLEANOS (baratos e à prova de valor inválido) e o float de ângulo
 * nunca sai da máquina que o produziu — ângulo vindo do cliente é entrada não confiável.
 *
 * Ângulo fora das 8 direções canônicas é ENCAIXADO na oitava mais próxima; arredondar para
 * múltiplo de π/4 antes de extrair os sinais é o que torna exato o ida-e-volta
 * `direcaoDeMovimento → bitsDeMovimento → direcaoDeMovimento`.
 */
export function bitsDeMovimento(mover: number | null): number {
  if (mover === null) return 0;
  const oitava = Math.round(mover / (Math.PI / 4)) * (Math.PI / 4);
  const dx = Math.round(Math.cos(oitava));
  const dy = Math.round(Math.sin(oitava));
  let bits = 0;
  if (dx > 0) bits |= INPUT_BIT.right;
  else if (dx < 0) bits |= INPUT_BIT.left;
  if (dy > 0) bits |= INPUT_BIT.down;
  else if (dy < 0) bits |= INPUT_BIT.up;
  return bits;
}

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
 * Canal `rematch` (revanche): no fim da partida a sala VOLTA para o lobby em vez de morrer.
 *
 * Antes, "jogar de novo" recarregava a página e devolvia a pessoa à tela de entrada — o grupo
 * tinha que criar sala nova e redistribuir o código a cada partida, o que inviabiliza jogar
 * várias seguidas no escritório. Agora o placar zera, todo mundo volta a "não pronto" e a sala
 * segue viva com as mesmas pessoas, o mesmo código e o mesmo link.
 *
 * Não leva corpo: só vale em `gameover`, e QUALQUER pessoa da sala pode pedir (esperar o dono
 * travaria a revanche se ele fechasse a aba).
 */
export type RematchMsg = undefined;

/**
 * Canal `config`: o DONO ajusta o número de rodadas e a dificuldade dos bots no lobby.
 *
 * Ficava só na URL de criação (`rodadas`) e a dificuldade era fixa em `medio` — nem o bot
 * difícil que existe no código chegava a ser usado numa partida online. Campos opcionais: manda
 * só o que mudou.
 */
export interface ConfigMsg {
  rodadas?: number;
  dificuldade?: 'facil' | 'medio' | 'dificil';
}

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

/**
 * Nascimento de bala. O servidor manda o EVENTO e cada cliente simula a trajetoria localmente
 * com o mesmo codigo de `shared-sim` — e por isso que bala nao trafega pela rede.
 *
 * `vx`/`vy` vem PRONTOS e nao sao redundancia do `angle`. O `angle` e cosmetico (muzzle
 * flash); a fisica e o vetor. Se o cliente recalculasse `cos(angle)`, a trajetoria dependeria da
 * implementacao de trigonometria de cada ponta — e o dia em que o servidor for outra linguagem,
 * `math.Cos` e `Math.cos` podem divergir no ultimo bit e o ricochete acontece em lugares
 * diferentes em cada tela. Com o vetor pronto, o voo vira aritmetica linear pura, identica em
 * qualquer implementacao de IEEE 754.
 */
export interface BulletSpawnMsg {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  /** Direcao do cano no disparo — SO para o efeito visual. Nao use para fisica. */
  angle: number;
  /** Velocidade em px/s. E ISTO que define a trajetoria. */
  vx: number;
  vy: number;
  /**
   * Rebotes EXTRAS desta bala, acima de `MAX_BOUNCES` — o carimbo do power-up de ricochete que o
   * atirador tinha NO INSTANTE do disparo. 0 quando ele não tinha nenhum.
   *
   * Está aqui pelo MESMO motivo que `vx`/`vy`: é física de bala, e a bala é simulada localmente
   * em cada cliente. Se o cliente lesse o efeito do estado do atirador, uma bala disparada com
   * ricochete duplo passaria a quicar só uma vez no instante em que o efeito expirasse no dono —
   * ela sumiria na parede aqui e continuaria voando lá, e alguém morreria de uma bala que a
   * própria tela mostrou desaparecendo. Viajando por bala, o efeito acompanha o projétil até o
   * fim do voo, mesmo depois de acabar para quem atirou.
   */
  ricochete: number;
  /** Tick de simulacao do servidor em que o disparo ocorreu. */
  tick: number;
}

/**
 * Alguém PEGOU um item do chão. Quem arbitra é sempre o SERVIDOR, como na morte: dois tanques
 * podem encostar no mesmo item no mesmo tick, e nenhum cliente pode decidir isso sozinho.
 *
 * O NASCIMENTO do item não tem mensagem — ele sai do RNG semeado da rodada (`agendaDePowerUps`),
 * então todo cliente já sabe onde e quando cada item aparece sem gastar um byte de rede.
 */
export interface PowerupTakenMsg {
  /** Índice do item na agenda da rodada — é por ele que o cliente tira o item do chão. */
  itemId: number;
  tipo: TipoPowerUp;
  playerId: string;
  x: number;
  y: number;
  /** Duração do efeito em segundos, para o HUD montar o contador sem consultar a tabela. */
  duracao: number;
  tick: number;
}

/** O efeito acabou (relógio zerou ou o tanque morreu). O cliente apaga o crachá e o contador. */
export interface PowerupExpiredMsg {
  playerId: string;
  tipo: TipoPowerUp;
  tick: number;
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

/**
 * Canais do TRANSPORTE — os que existem por causa do WebSocket cru, e não do jogo.
 *
 * Com o Colyseus eles não precisavam existir: entrar numa sala era um HTTP de matchmaking, o
 * estado frio vinha pelo `@colyseus/schema` e a saída era o `leave()` do SDK. Com um WebSocket
 * cru, tudo isso passa a ser mensagem — e pelo mesmo motivo dos canais de jogo acima, o nome mora
 * aqui e não escrito à mão nas duas pontas.
 *
 * Espelhados em `go/server/protocolo.go`.
 */
export const TransportType = {
  /** Primeiro quadro da conexão: `{ modo: 'criar' | 'codigo' | 'reconectar', ... }`. */
  Entrar: 'entrar',
  /** Resposta do servidor: `{ roomId, sessionId, token }`. */
  Entrou: 'entrou',
  /** Recusa da entrada, com motivo legível. Vem antes do fechamento. */
  Erro: 'erro',
  /** Saída CONSENTIDA (menu de pausa). Distingue "saí" de "caiu" — ver `allowReconnection`. */
  Sair: 'sair',
  /** Estado frio da sala, o que o `@colyseus/schema` carregava. */
  Estado: 'state',
} as const;

export type TransportType = (typeof TransportType)[keyof typeof TransportType];

/** Modo de entrada pedido no canal `entrar`. */
export type ModoDeEntrada = 'criar' | 'codigo' | 'reconectar';

/** Corpo do canal `entrar`. */
export interface EntrarMsg {
  modo: ModoDeEntrada;
  codigo?: string;
  nome?: string;
  deviceId?: string;
  cor?: number;
  bots?: number;
  rodadas?: number;
  /** Token de reconexão guardado no `localStorage`; só no modo `reconectar`. */
  token?: string;
  /** Proporção da área jogável, adiantada já na entrada (ver `ViewportMsg`). */
  aspect?: number;
}

/** Corpo do canal `entrou`. */
export interface EntrouMsg {
  roomId: string;
  sessionId: string;
  token: string;
}
