// Cliente Colyseus: cria/entra na sala por código de 4 letras, envia input e "pronto", recebe
// os eventos de bala/morte/rodada e o snapshot binário de posições, e reconecta ao cair.
//
// Todos os nomes de canal vêm de `MessageType` (@tank/protocol) — nenhuma string literal aqui.
// Foi exatamente a divergência entre o canal escolhido no cliente e o escolhido no servidor
// que quase quebrou o modo online na Fase 2.
import { Client, type Room } from '@colyseus/sdk';
import { encodeAim, MessageType } from '@tank/protocol';
import type {
  BulletDeadMsg,
  BulletSpawnMsg,
  GameOverMsg,
  RoundEndMsg,
  RoundStartMsg,
  SuddenDeathWallMsg,
  TankDeathMsg,
} from '@tank/protocol';
import type { Input } from '@tank/shared-sim';
import { decodeSnapshot, type SnapshotTank } from './snapshot.js';

const DEVICE_ID_KEY = 'tank_device_id';
const RECONNECT_KEY = 'tank_reconnect';
// Mesma janela que `allowReconnection(client, 30)` no servidor: passou disso, o assento já
// morreu e insistir só rende um erro de matchmaking.
const RECONNECT_WINDOW_MS = 30_000;

// Espelha `apps/server/src/net/input.ts` (`decodeInputBits`): bit0 avançar, bit1 ré,
// bit2 esquerda, bit3 direita, bit4 atirar. O servidor recebe `{ seq, bits, aim }`, não o
// `InputMsg` completo do protocol — `aim` vai à parte porque é 1 byte de ângulo, não uma flag.
const BIT_UP = 0x01;
const BIT_DOWN = 0x02;
const BIT_LEFT = 0x04;
const BIT_RIGHT = 0x08;
const BIT_FIRE = 0x10;

function encodeInputBits(input: Input): number {
  let bits = 0;
  if (input.move > 0) bits |= BIT_UP;
  if (input.move < 0) bits |= BIT_DOWN;
  if (input.turn < 0) bits |= BIT_LEFT;
  if (input.turn > 0) bits |= BIT_RIGHT;
  if (input.fire) bits |= BIT_FIRE;
  return bits;
}

/**
 * ID local do aparelho, usado como chave do ranking (identidade sem conta).
 *
 * NÃO usa `crypto.randomUUID()` direto: essa API só existe em **contexto seguro** (HTTPS ou
 * localhost). O caso de uso principal do jogo é exatamente o que ela não cobre — abrir
 * `http://192.168.x.x:3000` na LAN do escritório —, e lá ela é `undefined`, quebrando a criação
 * de sala com "crypto.randomUUID is not a function" (relatado pelo usuário ao testar em rede).
 * `crypto.getRandomValues` funciona em contexto inseguro; o `Math.random` é só a última rede.
 */
function novoId(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  if (typeof c?.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = novoId();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

interface StoredReconnect {
  roomId: string;
  token: string;
  at: number; // último instante em que a aba ainda estava conectada
}

// O token vive em localStorage (não em memória): reconectar depois de FECHAR a aba é justamente
// o caso que o jogo precisa cobrir — quando a aba morre não sobra JS nenhum para segurar estado.
//
// `at` é reescrito periodicamente enquanto a conexão está viva porque a janela de 30 s do
// servidor (`allowReconnection`) conta a partir da QUEDA, não do login: gravar só uma vez no
// join faria o token parecer vencido depois de dois minutos de partida.
function saveReconnect(roomId: string, token: string): void {
  const payload: StoredReconnect = { roomId, token, at: Date.now() };
  try {
    localStorage.setItem(RECONNECT_KEY, JSON.stringify(payload));
  } catch {
    // modo privado / storage cheio — reconexão vira "entrar de novo", nada quebra
  }
}

function loadReconnect(roomId: string): string | null {
  try {
    const raw = localStorage.getItem(RECONNECT_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredReconnect;
    if (stored.roomId.toUpperCase() !== roomId.toUpperCase()) return null;
    if (Date.now() - stored.at > RECONNECT_WINDOW_MS) return null;
    return stored.token;
  } catch {
    return null;
  }
}

export function clearReconnect(): void {
  try {
    localStorage.removeItem(RECONNECT_KEY);
  } catch {
    // idem saveReconnect
  }
}

export interface NetHandlers {
  onStateChange(state: unknown): void;
  onSnapshot(tanks: SnapshotTank[]): void;
  onBulletSpawn(msg: BulletSpawnMsg): void;
  onBulletDead(msg: BulletDeadMsg): void;
  onTankDeath(msg: TankDeathMsg): void;
  onRoundStart(msg: RoundStartMsg): void;
  onRoundEnd(msg: RoundEndMsg): void;
  onSuddenDeathWall(msg: SuddenDeathWallMsg): void;
  onGameOver(msg: GameOverMsg): void;
  onReconnecting(): void;
  onReconnected(): void;
  onDisconnected(): void;
}

// Em dev o Vite proxeia `/colyseus` (HTTP do matchmaking + upgrade de WebSocket) para a porta
// 3000; em produção o próprio Node serve o client, então cliente e servidor dividem a origem —
// é a mesma porta única exigida pelo deploy no Coolify.
function wsEndpoint(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  if (import.meta.env.DEV) return `${proto}://${location.hostname}:${location.port}/colyseus`;
  return `${proto}://${location.host}`;
}

function toArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export interface JoinInfo {
  nome: string;
  /** Só usado ao CRIAR a sala: quantas vagas preencher com bots. */
  bots?: number;
  /** Cor preferida (0xRRGGBB), lida do `localStorage`. O servidor atende se estiver livre. */
  cor?: number;
  /**
   * Override só de teste (`?rodadas=N` na URL), espelhando o que o modo local já aceita: encurta
   * a partida para provar a tela de fim sem jogar as 10 rodadas. Sem o parâmetro o servidor usa
   * `ROUNDS`.
   */
  rodadas?: number;
}

const TOKEN_REFRESH_MS = 3_000;
/** Teto de espera pelo "saí mesmo" do servidor antes de a página recarregar (ver `sair`). */
const ESPERA_MAX_SAIDA_MS = 600;

export class NetClient {
  private client: Client;
  private room: Room | null = null;
  private reconnecting = false;
  /** Saída pedida pelo jogador: o `onLeave` que vier a seguir NÃO deve virar tentativa de reconexão. */
  private saindoDeProposito = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private handlers: NetHandlers) {
    this.client = new Client(wsEndpoint());
    // Fechar a aba não dispara `onLeave` no cliente — carimbar aqui garante que o token esteja
    // fresco no exato momento em que a página morre.
    window.addEventListener('pagehide', () => this.touchReconnect());
  }

  private touchReconnect(): void {
    const room = this.room;
    if (room?.reconnectionToken) saveReconnect(room.roomId, room.reconnectionToken);
  }

  /** Cria uma sala nova e já entra nela. O código de 4 letras sai em `roomId`. */
  async create(info: JoinInfo): Promise<void> {
    const room = await this.client.create('tank_room', {
      nome: info.nome,
      deviceId: getDeviceId(),
      bots: info.bots ?? 0,
      cor: info.cor,
      rodadas: info.rodadas,
    });
    this.attach(room);
  }

  /**
   * Entra na sala pelo código. Se houver um token de reconexão fresco para esse mesmo código
   * (aba fechada e reaberta dentro de 30 s), tenta primeiro retomar o assento antigo — assim a
   * pontuação e o slot do jogador são preservados em vez de nascer um jogador novo.
   */
  async join(roomCode: string, info: JoinInfo): Promise<void> {
    const token = loadReconnect(roomCode);
    if (token) {
      try {
        this.attach(await this.client.reconnect(token));
        return;
      } catch {
        clearReconnect();
      }
    }
    const room = await this.client.joinById(roomCode, { nome: info.nome, deviceId: getDeviceId(), cor: info.cor });
    this.attach(room);
  }

  sendInput(input: Input, seq: number): void {
    this.room?.send(MessageType.Input, {
      seq: seq & 0xffff,
      bits: encodeInputBits(input),
      // Sem mira ainda (mouse nunca moveu / tanque desconhecido) manda 0: o servidor não tem como
      // distinguir "0 rad" de "ausente" num Uint8, e apontar para o leste é um padrão inofensivo
      // — assim que o mouse se mexe o valor real chega no pacote seguinte, 33 ms depois.
      aim: encodeAim(input.aim ?? 0),
    });
  }

  sendReady(ready: boolean): void {
    this.room?.send(MessageType.Ready, { ready });
  }

  /**
   * Pede uma cor para o próprio tanque. Só um pedido: quem decide (e quem impede repetição) é o
   * servidor — a resposta chega como uma mudança no `PlayerState.color` do estado frio.
   */
  sendPickColor(color: number): void {
    this.room?.send(MessageType.PickColor, { color });
  }

  /**
   * Anuncia a proporção da área jogável desta tela. Não muda nada sozinho: o servidor junta as
   * telas da sala e decide UMA forma de labirinto por rodada (Fase 9). Reenviar no resize é de
   * graça — a proporção só é lida no início da rodada seguinte.
   */
  sendViewport(aspect: number): void {
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    this.room?.send(MessageType.Viewport, { aspect });
  }

  /**
   * Pede ao servidor para colocar (`+1`) ou tirar (`-1`) um bot da sala. Só o dono é atendido —
   * quem confere é o `TankRoom`, e o resultado aparece no `players` do estado frio.
   */
  sendBot(delta: 1 | -1): void {
    this.room?.send(delta > 0 ? MessageType.AddBot : MessageType.RemoveBot);
  }

  /** Pede revanche: a sala volta ao lobby com as mesmas pessoas, o mesmo código e o mesmo link. */
  sendRematch(): void {
    this.room?.send(MessageType.Rematch);
  }

  /** Só o dono da sala; o servidor recusa de qualquer outro. */
  sendConfig(cfg: { rodadas?: number; dificuldade?: 'facil' | 'medio' | 'dificil' }): void {
    this.room?.send(MessageType.Config, cfg);
  }

  leave(): void {
    this.saindoDeProposito = true;
    clearReconnect();
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.room?.leave(true);
    this.room = null;
  }

  /**
   * SAIR DA SALA pelo menu de pausa (Fase 13 §1) — a versão que ESPERA o servidor confirmar.
   *
   * A diferença para o `leave()` acima é que aqui quem chama vai recarregar a página em seguida,
   * e um `leave` disparado sem esperar morre junto com a aba: o servidor nunca receberia o pedido
   * de saída consentida, cairia no caminho de QUEDA e seguraria a vaga (e o tanque na arena) por
   * 30 s. O teto de espera evita prender a interface numa rede ruim — a saída acontece de um
   * jeito ou de outro.
   */
  async sair(): Promise<void> {
    this.saindoDeProposito = true;
    clearReconnect();
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;

    const room = this.room;
    this.room = null;
    if (!room) return;

    try {
      await Promise.race([room.leave(true), new Promise((resolve) => setTimeout(resolve, ESPERA_MAX_SAIDA_MS))]);
    } catch {
      // servidor já tinha fechado a conexão — para quem está saindo, dá no mesmo
    }
  }

  get roomId(): string {
    return this.room?.roomId ?? '';
  }

  /** Id do jogador NESTA sala. É a chave do Map de jogadores no estado frio — não é o deviceId. */
  get sessionId(): string {
    return this.room?.sessionId ?? '';
  }

  private attach(room: Room): void {
    this.room = room;
    this.reconnecting = false;
    this.touchReconnect();
    if (this.refreshTimer === null) {
      this.refreshTimer = setInterval(() => this.touchReconnect(), TOKEN_REFRESH_MS);
    }

    room.onStateChange((state: unknown) => this.handlers.onStateChange(state));

    room.onMessage(MessageType.Snapshot, (data: ArrayBuffer | Uint8Array) => {
      this.handlers.onSnapshot(decodeSnapshot(toArrayBuffer(data)));
    });
    room.onMessage(MessageType.BulletSpawn, (msg: BulletSpawnMsg) => this.handlers.onBulletSpawn(msg));
    room.onMessage(MessageType.BulletDead, (msg: BulletDeadMsg) => this.handlers.onBulletDead(msg));
    room.onMessage(MessageType.TankDeath, (msg: TankDeathMsg) => this.handlers.onTankDeath(msg));
    room.onMessage(MessageType.RoundStart, (msg: RoundStartMsg) => this.handlers.onRoundStart(msg));
    room.onMessage(MessageType.RoundEnd, (msg: RoundEndMsg) => this.handlers.onRoundEnd(msg));
    room.onMessage(MessageType.SuddenDeathWall, (msg: SuddenDeathWallMsg) => this.handlers.onSuddenDeathWall(msg));
    room.onMessage(MessageType.GameOver, (msg: GameOverMsg) => this.handlers.onGameOver(msg));

    room.onLeave((code: number) => {
      // Saída pedida pelo jogador fecha com código de "consentida" — reconectar aqui seria
      // reentrar na sala de onde ele acabou de sair.
      if (this.saindoDeProposito || this.reconnecting || code === 1000) return;
      void this.attemptReconnect(room);
    });
  }

  private async attemptReconnect(room: Room): Promise<void> {
    this.reconnecting = true;
    this.handlers.onReconnecting();

    const token = room.reconnectionToken;
    if (!token) {
      this.handlers.onDisconnected();
      return;
    }

    try {
      const restored = await this.client.reconnect(token);
      this.attach(restored);
      this.handlers.onReconnected();
    } catch {
      clearReconnect();
      this.handlers.onDisconnected();
    }
  }
}
