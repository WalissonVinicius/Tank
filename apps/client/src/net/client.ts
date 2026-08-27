// Cliente de rede: cria/entra na sala por código de 4 letras, envia input e "pronto", recebe os
// eventos de bala/morte/rodada e o snapshot binário de posições, e reconecta ao cair.
//
// TRANSPORTE: WebSocket cru, falando com o servidor Go (`go/server`). Antes disto aqui morava o
// `@colyseus/sdk`. A troca aconteceu porque não existe servidor Colyseus em Go e reimplementar o
// protocolo do `@colyseus/schema` (binário, com delta e versionamento de campo) seria trabalho
// grande para replicar algo que o jogo mal usa: o Schema carregava só o estado FRIO (jogadores,
// placar, fase, dono, configuração), enquanto o estado quente já viajava em mensagem binária
// própria — a mesma de sempre, byte a byte, ver `net/snapshot.ts`.
//
// A INTERFACE DESTA CLASSE NÃO MUDOU. `main.ts` continua chamando `create`, `join`, `sendInput`,
// `sendReady`, `sendPickColor`, `sendViewport`, `sendBot`, `sendRematch`, `sendConfig`, `leave` e
// `sair`, e continua recebendo os mesmos `NetHandlers` — inclusive `onStateChange`, que segue
// entregando um objeto com `players` iterável em pares `[id, jogador]`.
//
// Todos os nomes de canal vêm de `MessageType`/`TransportType` (@tank/protocol) — nenhuma string
// literal aqui. Foi exatamente a divergência entre o canal escolhido no cliente e o escolhido no
// servidor que quase quebrou o modo online na Fase 2.
import { bitsDeMovimento, encodeAim, MessageType, TransportType } from '@tank/protocol';
import type {
  BulletDeadMsg,
  BulletSpawnMsg,
  EntrarMsg,
  EntrouMsg,
  GameOverMsg,
  RoundEndMsg,
  PowerupExpiredMsg,
  PowerupTakenMsg,
  RoundStartMsg,
  SuddenDeathWallMsg,
  TankDeathMsg,
} from '@tank/protocol';
import type { Input } from '@tank/shared-sim';
import { decodeSnapshot, type SnapshotTank } from './snapshot.js';

const DEVICE_ID_KEY = 'tank_device_id';
const RECONNECT_KEY = 'tank_reconnect';
// Mesma janela que `janelaDeReconexao` no servidor: passou disso, o assento já morreu e insistir
// só rende um erro de entrada.
const RECONNECT_WINDOW_MS = 30_000;

// Espelha `DecodeInputBits` em `go/server/codec.go`: bit0 cima, bit1 baixo, bit2 esquerda,
// bit3 direita, bit4 atirar. O servidor recebe `{ seq, bits, aim }`, não o `InputMsg` completo do
// protocol — `aim` vai à parte porque é 1 byte de ângulo, não uma flag.
//
// A direção de movimento volta a virar BITS aqui: `bitsDeMovimento` é o inverso exato de
// `direcaoDeMovimento`, então o ângulo que o cliente montou das teclas é o mesmo que o servidor
// remonta do outro lado. O float de ângulo do movimento não trafega — só a mira, que é do mouse
// e não teria como ser representada em 4 flags.
const BIT_FIRE = 0x10;

function encodeInputBits(input: Input): number {
  let bits = bitsDeMovimento(input.mover);
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
// servidor conta a partir da QUEDA, não do login: gravar só uma vez na entrada faria o token
// parecer vencido depois de dois minutos de partida.
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
  onPowerupTaken(msg: PowerupTakenMsg): void;
  onPowerupExpired(msg: PowerupExpiredMsg): void;
  onGameOver(msg: GameOverMsg): void;
  onReconnecting(): void;
  onReconnected(): void;
  onDisconnected(): void;
}

// Em dev o Vite proxeia `/colyseus` (o mesmo prefixo de antes, mantido para não mexer no
// `vite.config.ts`) para a porta 3000, reescrevendo o prefixo fora; em produção o próprio Go
// serve o client, então cliente e servidor dividem a origem — é a mesma porta única exigida pelo
// deploy no Coolify.
function wsEndpoint(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  if (import.meta.env.DEV) return `${proto}://${location.hostname}:${location.port}/colyseus/ws`;
  return `${proto}://${location.host}/ws`;
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
/** Teto de espera pelo `entrou` depois de o socket abrir. */
const ESPERA_MAX_ENTRADA_MS = 10_000;

/** Envelope de toda mensagem de texto: `{ t: canal, d: corpo }`. */
interface Envelope {
  t: string;
  d?: unknown;
}

export class NetClient {
  private socket: WebSocket | null = null;
  private sala = '';
  private sessao = '';
  private token = '';
  private reconnecting = false;
  /** Saída pedida pelo jogador: o fechamento que vier a seguir NÃO vira tentativa de reconexão. */
  private saindoDeProposito = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private handlers: NetHandlers) {
    // Fechar a aba não dispara evento de saída no servidor — carimbar aqui garante que o token
    // esteja fresco no exato momento em que a página morre.
    window.addEventListener('pagehide', () => this.touchReconnect());
  }

  private touchReconnect(): void {
    if (this.sala && this.token) saveReconnect(this.sala, this.token);
  }

  /** Cria uma sala nova e já entra nela. O código de 4 letras sai em `roomId`. */
  async create(info: JoinInfo): Promise<void> {
    await this.abrir({
      modo: 'criar',
      nome: info.nome,
      deviceId: getDeviceId(),
      bots: info.bots ?? 0,
      cor: info.cor,
      rodadas: info.rodadas,
    });
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
        await this.abrir({ modo: 'reconectar', token, nome: info.nome, deviceId: getDeviceId() });
        return;
      } catch {
        clearReconnect();
      }
    }
    await this.abrir({
      modo: 'codigo',
      codigo: roomCode,
      nome: info.nome,
      deviceId: getDeviceId(),
      cor: info.cor,
    });
  }

  /**
   * Abre o socket, manda o pedido de entrada e só resolve quando o `entrou` chega.
   *
   * O `entrou` é o equivalente do que o matchmaking HTTP do Colyseus devolvia: código da sala,
   * id da sessão e o token de reconexão. Sem ele o cliente não sabe nem em que sala está nem
   * quem é dentro dela.
   */
  private abrir(pedido: EntrarMsg): Promise<void> {
    this.desligarSocketAtual();
    this.saindoDeProposito = false;

    return new Promise<void>((resolver, rejeitar) => {
      const socket = new WebSocket(wsEndpoint());
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      let resolvido = false;
      const prazo = setTimeout(() => {
        if (resolvido) return;
        resolvido = true;
        socket.close();
        rejeitar(new Error('o servidor não respondeu a tempo'));
      }, ESPERA_MAX_ENTRADA_MS);

      const concluir = (erro?: Error): void => {
        if (resolvido) return;
        resolvido = true;
        clearTimeout(prazo);
        if (erro) rejeitar(erro);
        else resolver();
      };

      socket.onopen = () => this.mandar(TransportType.Entrar, pedido);

      socket.onmessage = (ev: MessageEvent) => {
        if (ev.data instanceof ArrayBuffer) {
          this.handlers.onSnapshot(decodeSnapshot(ev.data));
          return;
        }
        let env: Envelope;
        try {
          env = JSON.parse(String(ev.data)) as Envelope;
        } catch {
          return;
        }
        if (env.t === TransportType.Entrou) {
          const corpo = env.d as EntrouMsg;
          this.sala = corpo.roomId;
          this.sessao = corpo.sessionId;
          this.token = corpo.token;
          this.touchReconnect();
          if (this.refreshTimer === null) {
            this.refreshTimer = setInterval(() => this.touchReconnect(), TOKEN_REFRESH_MS);
          }
          concluir();
          return;
        }
        if (env.t === TransportType.Erro) {
          const motivo = (env.d as { motivo?: string })?.motivo ?? 'entrada recusada';
          concluir(new Error(motivo));
          return;
        }
        this.despachar(env);
      };

      socket.onerror = () => concluir(new Error('não deu para falar com o servidor'));

      socket.onclose = (ev: CloseEvent) => {
        if (this.socket === socket) this.socket = null;
        concluir(new Error('a conexão fechou antes de entrar na sala'));
        // Saída pedida pelo jogador fecha com código de "consentida" — reconectar aqui seria
        // reentrar na sala de onde ele acabou de sair.
        if (this.saindoDeProposito || this.reconnecting || ev.code === 1000) return;
        void this.tentarReconectar();
      };
    });
  }

  private despachar(env: Envelope): void {
    switch (env.t) {
      case TransportType.Estado:
        this.handlers.onStateChange(env.d);
        break;
      case MessageType.BulletSpawn:
        this.handlers.onBulletSpawn(env.d as BulletSpawnMsg);
        break;
      case MessageType.BulletDead:
        this.handlers.onBulletDead(env.d as BulletDeadMsg);
        break;
      case MessageType.TankDeath:
        this.handlers.onTankDeath(env.d as TankDeathMsg);
        break;
      case MessageType.RoundStart:
        this.handlers.onRoundStart(env.d as RoundStartMsg);
        break;
      case MessageType.RoundEnd:
        this.handlers.onRoundEnd(env.d as RoundEndMsg);
        break;
      case MessageType.SuddenDeathWall:
        this.handlers.onSuddenDeathWall(env.d as SuddenDeathWallMsg);
        break;
      case MessageType.PowerupTaken:
        this.handlers.onPowerupTaken(env.d as PowerupTakenMsg);
        break;
      case MessageType.PowerupExpired:
        this.handlers.onPowerupExpired(env.d as PowerupExpiredMsg);
        break;
      case MessageType.GameOver:
        this.handlers.onGameOver(env.d as GameOverMsg);
        break;
      default:
        break;
    }
  }

  private mandar(canal: string, corpo?: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(corpo === undefined ? JSON.stringify({ t: canal }) : JSON.stringify({ t: canal, d: corpo }));
  }

  sendInput(input: Input, seq: number): void {
    this.mandar(MessageType.Input, {
      seq: seq & 0xffff,
      bits: encodeInputBits(input),
      // Sem mira ainda (mouse nunca moveu / tanque desconhecido) manda 0: o servidor não tem como
      // distinguir "0 rad" de "ausente" num byte, e apontar para o leste é um padrão inofensivo
      // — assim que o mouse se mexe o valor real chega no pacote seguinte, 33 ms depois.
      aim: encodeAim(input.aim ?? 0),
    });
  }

  sendReady(ready: boolean): void {
    this.mandar(MessageType.Ready, { ready });
  }

  /**
   * Pede uma cor para o próprio tanque. Só um pedido: quem decide (e quem impede repetição) é o
   * servidor — a resposta chega como uma mudança no `color` do estado frio.
   */
  sendPickColor(color: number): void {
    this.mandar(MessageType.PickColor, { color });
  }

  /**
   * Anuncia a proporção da área jogável desta tela. Não muda nada sozinho: o servidor junta as
   * telas da sala e decide UMA forma de labirinto por rodada (Fase 9). Reenviar no resize é de
   * graça — a proporção só é lida no início da rodada seguinte.
   */
  sendViewport(aspect: number): void {
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    this.mandar(MessageType.Viewport, { aspect });
  }

  /**
   * Pede ao servidor para colocar (`+1`) ou tirar (`-1`) um bot da sala. Só o dono é atendido —
   * quem confere é a sala, e o resultado aparece no `players` do estado frio.
   */
  sendBot(delta: 1 | -1): void {
    this.mandar(delta > 0 ? MessageType.AddBot : MessageType.RemoveBot);
  }

  /** Pede revanche: a sala volta ao lobby com as mesmas pessoas, o mesmo código e o mesmo link. */
  sendRematch(): void {
    this.mandar(MessageType.Rematch);
  }

  /** Só o dono da sala; o servidor recusa de qualquer outro. */
  sendConfig(cfg: { rodadas?: number; dificuldade?: 'facil' | 'medio' | 'dificil' }): void {
    this.mandar(MessageType.Config, cfg);
  }

  leave(): void {
    this.saindoDeProposito = true;
    clearReconnect();
    this.pararRelogioDeToken();
    this.mandar(TransportType.Sair);
    this.desligarSocketAtual();
  }

  /**
   * SAIR DA SALA pelo menu de pausa (Fase 13 §1) — a versão que ESPERA o servidor confirmar.
   *
   * A diferença para o `leave()` acima é que aqui quem chama vai recarregar a página em seguida,
   * e um pedido disparado sem esperar morre junto com a aba: o servidor nunca receberia a saída
   * consentida, cairia no caminho de QUEDA e seguraria a vaga (e o tanque na arena) por 30 s. O
   * teto de espera evita prender a interface numa rede ruim — a saída acontece de um jeito ou de
   * outro.
   */
  async sair(): Promise<void> {
    this.saindoDeProposito = true;
    clearReconnect();
    this.pararRelogioDeToken();

    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.desligarSocketAtual();
      return;
    }

    const confirmado = new Promise<void>((resolver) => {
      socket.addEventListener('close', () => resolver(), { once: true });
    });
    this.mandar(TransportType.Sair);

    await Promise.race([confirmado, new Promise((resolver) => setTimeout(resolver, ESPERA_MAX_SAIDA_MS))]);
    this.desligarSocketAtual();
  }

  get roomId(): string {
    return this.sala;
  }

  /** Id do jogador NESTA sala. É a chave do Map de jogadores no estado frio — não é o deviceId. */
  get sessionId(): string {
    return this.sessao;
  }

  private pararRelogioDeToken(): void {
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private desligarSocketAtual(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close(1000);
    } catch {
      // já estava fechando — para quem está saindo, dá no mesmo
    }
  }

  private async tentarReconectar(): Promise<void> {
    this.reconnecting = true;
    this.handlers.onReconnecting();

    if (!this.token) {
      this.reconnecting = false;
      this.handlers.onDisconnected();
      return;
    }

    try {
      await this.abrir({ modo: 'reconectar', token: this.token });
      this.reconnecting = false;
      this.handlers.onReconnected();
    } catch {
      this.reconnecting = false;
      clearReconnect();
      this.handlers.onDisconnected();
    }
  }
}
