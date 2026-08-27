import { CloseCode, Room, matchMaker, type Client } from '@colyseus/core';
import {
  ANIMAL_NOME,
  animalDaCor,
  COUNTDOWN,
  MAZE_ASPECT_DEFAULT,
  MAZE_ASPECT_MAX,
  MAZE_ASPECT_MIN,
  MessageType,
  PLAYER_COLORS,
  ROUNDS,
  ROUND_TIMEOUT,
  SNAPSHOT_HZ,
  TEST_PLAYER_NAMES,
  TICK_HZ,
  VAGAS_POR_SALA,
} from '@tank/protocol';
import type { ConfigMsg, InputBitsMsg, PickColorMsg, ReadyMsg, SalaMetadata, ViewportMsg } from '@tank/protocol';
import {
  BOT_DIFFICULTY,
  makeBot,
  makeMaze,
  mulberry32,
  spawnPoints,
  step,
  validateMaze,
  type Bot,
  type Input,
  type SimEvent,
  type SimState,
  type Tank,
  type Vec2,
} from '@tank/shared-sim';
import { decodeInputBits } from '../net/input.js';
import { encodeSnapshot, type SnapshotTank } from '../net/snapshot.js';
import { openDb, insertMatch, insertResults } from '../persist/db.js';
import { updateRatingsForMatch } from '../persist/rating.js';
import { sendMatchWebhook } from '../persist/webhook.js';
import { randomRoomCode } from '../util/roomCode.js';
import {
  computeMatchTitles,
  computeRoundRanking,
  removeRandomInternalWall,
  roundScore,
  tallyKills,
  type MatchTitleStats,
} from './roundLoop.js';
import { PlayerState } from '../state/PlayerState.js';
import { TankRoomState } from '../state/TankRoomState.js';

export interface TankRoomOptions {
  /** Quantas vagas preencher com bots determinísticos (padrão 0, máx. 10). */
  bots?: number;
  /**
   * Override só para teste: encurta o timeout de rodada (`ROUND_TIMEOUT` real é usado em
   * produção). Evita que o vitest precise simular 45 s reais de partida por rodada.
   */
  roundTimeoutSeconds?: number;
  /**
   * Override só para teste: deixa uma sala 100% de bots começar sozinha. Em produção isso é
   * proibido (ver `updateLobby`) — sem um humano na sala a partida rodaria para ninguém, e quem
   * cria a sala com bots perderia a corrida contra o próprio `onJoin`.
   */
  permitirPartidaSoDeBots?: boolean;
  /**
   * Override só para teste: encurta a PARTIDA (o valor de produção é `ROUNDS`, 10). Existe pelo
   * mesmo motivo de `roundTimeoutSeconds` — provar a tela de fim de partida (e o "jogar de novo"
   * dela) sem jogar dez rodadas de verdade em cada execução.
   */
  rodadas?: number;
}

interface JoinOptions {
  nome?: string;
  deviceId?: string;
  /**
   * Cor que o jogador tinha da última vez (guardada em `localStorage` no cliente). É PEDIDO:
   * se outra pessoa já estiver com ela, quem entra recebe a primeira livre — ver `corLivre`.
   */
  cor?: number;
}

interface DeathRecord {
  victimId: string;
  killerId: string;
  autogol: boolean;
}

const MAX_CLIENTS = 24; // 10 jogadores + espectadores
const ROUND_END_DURATION = 3;
const SUDDEN_DEATH_INTERVAL = 3;
const EMPTY_INPUT: Input = { mover: null, fire: false };

export class TankRoom extends Room<{ state: TankRoomState; metadata: SalaMetadata }> {
  private sim: SimState | null = null;
  private roundTimeoutSeconds = ROUND_TIMEOUT;
  private totalRodadas = ROUNDS;
  /** Dificuldade dos bots desta sala (Config). Era fixa em `medio`. */
  private botDificuldade: 'facil' | 'medio' | 'dificil' = 'medio';
  private permitirPartidaSoDeBots = false;
  /** Contador de ids de bot da sala — nunca reaproveita id, nem depois de remover um. */
  private proximoBot = 0;

  private lastInput = new Map<string, Input>();
  // Um cérebro por bot, recriado a cada rodada com semente derivada de (seed da rodada, slot):
  // é o MESMO makeBot() que o modo local do cliente usa, então bot de servidor e bot de treino
  // se comportam igual (na Fase 2 a IA estava duplicada e divergente).
  private botBrains = new Map<string, Bot>();

  private spectatorSessions = new Set<string>();
  private pendingSpectatorNames = new Map<string, string>();
  /** Cor pedida por quem entrou com a partida rolando — atendida quando ele vira jogador. */
  private pendingSpectatorColors = new Map<string, number>();
  private deviceIdBySession = new Map<string, string>();
  // Proporção da área jogável anunciada por cada cliente (canal `viewport`). Fica fora do Schema
  // de propósito: é estado frio de servidor, ninguém precisa ver a tela do vizinho — só o
  // labirinto combinado, que já viaja no `round_start`.
  private aspectBySession = new Map<string, number>();

  private eliminationOrder: string[] = [];
  private deathLog: DeathRecord[] = [];
  private matchStats = new Map<string, MatchTitleStats>();

  private suddenDeath = { active: false, timer: 0, attempts: 0 };
  private snapshotAccum = 0;

  private matchId = '';
  private startedAt = 0;

  async onCreate(options: TankRoomOptions = {}): Promise<void> {
    let code = randomRoomCode();
    while (matchMaker.getLocalRoomById(code)) code = randomRoomCode();
    this.roomId = code;

    await this.setPrivate(true);
    this.maxClients = MAX_CLIENTS;
    this.patchRate = 50;

    this.state = new TankRoomState();
    this.roundTimeoutSeconds = options.roundTimeoutSeconds ?? ROUND_TIMEOUT;
    this.totalRodadas = Math.min(ROUNDS, Math.max(1, Math.round(options.rodadas ?? ROUNDS)));
    this.state.totalRounds = this.totalRodadas;
    this.permitirPartidaSoDeBots = options.permitirPartidaSoDeBots === true;

    const botCount = Math.min(VAGAS_POR_SALA, Math.max(0, Math.round(options.bots ?? 0)));
    for (let i = 0; i < botCount; i++) this.adicionarBot();

    this.onMessage(MessageType.Ready, (client: Client, message: Partial<ReadyMsg> | undefined) => {
      const player = this.state.players.get(client.sessionId);
      if (player && !player.isBot) player.ready = message?.ready !== false;
    });

    // Fase 13 §3 — bots entram e saem PELO LOBBY, não só pela opção de criação da sala. Quem
    // manda é o dono (o primeiro humano que entrou): para os outros o cliente nem desenha os
    // botões, e o servidor recusa de novo aqui — o cliente nunca é a autoridade.
    this.onMessage(MessageType.AddBot, (client: Client) => {
      if (this.state.phase !== 'lobby') return;
      if (this.state.ownerId !== client.sessionId) return;
      if (this.state.players.size >= VAGAS_POR_SALA) return;
      this.adicionarBot();
      this.publicarSala();
    });

    this.onMessage(MessageType.RemoveBot, (client: Client) => {
      if (this.state.phase !== 'lobby') return;
      if (this.state.ownerId !== client.sessionId) return;
      if (this.removerUmBot()) this.publicarSala();
    });

    /**
     * REVANCHE. A sala volta ao lobby em vez de morrer com a partida.
     *
     * Antes o "jogar de novo" do cliente era uma RECARGA que devolvia a pessoa à tela de entrada:
     * para jogar de novo com o mesmo grupo era preciso criar sala nova e redistribuir o código.
     * Agora o placar zera, todo mundo volta a "não pronto" e o mesmo link continua valendo.
     *
     * Qualquer pessoa da sala pode pedir, não só o dono: se o dono fecha a aba depois da última
     * rodada, exigir que fosse ele deixaria a sala presa em `gameover` para sempre.
     */
    this.onMessage(MessageType.Rematch, (client: Client) => {
      if (this.state.phase !== 'gameover') return;
      if (!this.state.players.has(client.sessionId)) return;
      this.reiniciarParaLobby();
    });

    /**
     * Rodadas e dificuldade dos bots, ajustadas pelo DONO no lobby.
     *
     * A dificuldade estava fixa em `medio` no código — nem o bot difícil chegava a ser usado
     * numa partida online. As rodadas só existiam como opção de criação da sala, então quem
     * entrava por código não tinha como saber nem mudar.
     */
    this.onMessage(MessageType.Config, (client: Client, message: Partial<ConfigMsg> | undefined) => {
      if (this.state.phase !== 'lobby') return;
      if (this.state.ownerId !== client.sessionId) return;
      const r = Number(message?.rodadas);
      if (Number.isFinite(r)) {
        this.totalRodadas = Math.min(ROUNDS, Math.max(1, Math.round(r)));
        this.state.totalRounds = this.totalRodadas;
      }
      const d = message?.dificuldade;
      if (d === 'facil' || d === 'medio' || d === 'dificil') {
        this.botDificuldade = d;
        this.state.dificuldade = d;
      }
      this.publicarSala();
    });

    // Fase 10 — escolha de cor. A UNICIDADE É DAQUI, não do cliente: as mensagens chegam
    // serializadas neste laço, então dois jogadores que clicam no mesmo quadrado no mesmo
    // instante são atendidos em ordem e o segundo cai fora do `if`. O cliente descobre o que
    // aconteceu lendo o `PlayerState.color` do estado frio.
    this.onMessage(MessageType.PickColor, (client: Client, message: Partial<PickColorMsg> | undefined) => {
      if (this.state.phase !== 'lobby') return; // trocar de cor no meio da partida, não
      const player = this.state.players.get(client.sessionId);
      if (!player || player.isBot) return;
      const pedida = Number(message?.color);
      if (!PLAYER_COLORS.includes(pedida)) return;
      if (pedida === player.color) return;
      if (this.corEmUso(pedida, client.sessionId)) return;
      player.color = pedida;
    });

    this.onMessage(MessageType.Input, (client: Client, message: InputBitsMsg) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.isBot || !player.alive) return;
      this.lastInput.set(client.sessionId, decodeInputBits(message.bits, message.aim));
    });

    // Cada cliente anuncia a proporção da própria área jogável, e reanuncia a cada resize. É
    // uma dica, não um comando: quem decide a forma do labirinto é `aspectoDaSala()` logo antes
    // de gerar a rodada, e o resultado vai igual para todo mundo em `RoundStartMsg.aspect`.
    this.onMessage(MessageType.Viewport, (client: Client, message: Partial<ViewportMsg> | undefined) => {
      const bruto = Number(message?.aspect);
      if (!Number.isFinite(bruto) || bruto <= 0) return;
      this.aspectBySession.set(client.sessionId, Math.min(MAZE_ASPECT_MAX, Math.max(MAZE_ASPECT_MIN, bruto)));
    });

    this.publicarSala();
    this.setSimulationInterval((deltaMs) => this.update(deltaMs / 1000), 1000 / TICK_HZ);
  }

  async onJoin(client: Client, options: JoinOptions = {}): Promise<void> {
    const deviceId = options.deviceId?.trim() || client.sessionId;
    this.deviceIdBySession.set(client.sessionId, deviceId);

    const isMidMatch = this.state.phase !== 'lobby';
    let isFull = this.state.players.size >= VAGAS_POR_SALA;

    // Fase 13 §3 — HUMANO TEM PRIORIDADE SOBRE BOT: sala lotada de bots não pode barrar gente de
    // verdade na porta. Um bot cede a vaga (e a cor) na hora. Com a partida em andamento não:
    // aí a vaga é de quem está jogando, e quem chega assiste até a rodada acabar.
    if (!isMidMatch && isFull && this.removerUmBot()) isFull = false;

    if (isMidMatch || isFull) {
      this.spectatorSessions.add(client.sessionId);
      if (options.nome?.trim()) this.pendingSpectatorNames.set(client.sessionId, options.nome.trim());
      if (typeof options.cor === 'number') this.pendingSpectatorColors.set(client.sessionId, options.cor);
      this.publicarSala();
      return;
    }

    this.addPlayer(client.sessionId, options.nome, false, options.cor);
  }

  /**
   * Chamado em DOIS momentos distintos (Fase 13 §1), e é o `code` que os separa:
   *
   *   · `CloseCode.CONSENTED` — a pessoa clicou em SAIR DA SALA no menu de pausa. Não há vaga a
   *     guardar: o jogador sai do estado frio na hora, a cor volta para a paleta e o tanque some
   *     da arena dos outros (antes ficava um fantasma parado até o fim da rodada);
   *   · qualquer outro código — a conexão caiu, o `onDrop` já segurou a vaga por 30 s e ELES
   *     acabaram de expirar. Mesmo destino, 30 s depois.
   *
   * Reconexão bem-sucedida nunca chega aqui: o Colyseus para o fluxo antes (`ClientState.
   * RECONNECTED`), então a vaga segue de pé com `connected` voltando a `true` no `onReconnect`.
   */
  async onLeave(client: Client, code?: number): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = false;

    this.removerJogador(client.sessionId);
    this.publicarSala();

    // Sala sem nenhum humano não tem por que continuar viva: sem isto ela ficaria rodando uma
    // partida de bots para plateia nenhuma, e continuaria aparecendo na lista de salas abertas
    // como se alguém estivesse esperando lá dentro. `disconnect()` já é idempotente.
    if (this.humanosNaSala() === 0) {
      void this.disconnect(CloseCode.CONSENTED).catch(() => undefined);
    }
    void code;
  }

  async onDrop(client: Client, _code?: number): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = false;
    try {
      await this.allowReconnection(client, 30);
    } catch {
      // janela de 30 s expirou — `onLeave` roda em seguida e libera a vaga de vez
    }
  }

  onReconnect(client: Client): void {
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = true;
  }

  /**
   * Ids dos tanques na rodada em curso (vazio fora dela). Exposto — como o `update()` — só para o
   * teste conferir que quem saiu da sala não ficou de fantasma parado na arena.
   */
  tanquesNaSimulacao(): string[] {
    return this.sim ? Array.from(this.sim.tanks.keys()) : [];
  }

  /**
   * Um tick da simulação, em segundos. Exposto (não privado) para o teste chamar diretamente
   * em vez de esperar o `setSimulationInterval` real — `dt` sempre em segundos, igual ao `step()`
   * do `shared-sim` (o `setSimulationInterval` de produção converte `clock.deltaTime` de ms).
   */
  update(dt: number): void {
    switch (this.state.phase) {
      case 'lobby':
        this.updateLobby();
        break;
      case 'countdown':
        this.updateCountdown(dt);
        break;
      case 'playing':
        this.updatePlaying(dt);
        break;
      case 'roundend':
        this.updateRoundEnd(dt);
        break;
      case 'gameover':
        break;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Jogadores / vagas
  // ---------------------------------------------------------------------------------------

  private nextFreeSlot(): number {
    const used = new Set<number>();
    this.state.players.forEach((p) => used.add(p.slot));
    for (let slot = 0; slot < VAGAS_POR_SALA; slot++) {
      if (!used.has(slot)) return slot;
    }
    return -1;
  }

  /** Alguém que NÃO seja `exceto` já está com esta cor? */
  private corEmUso(cor: number, exceto?: string): boolean {
    let usada = false;
    this.state.players.forEach((p) => {
      if (p.id !== exceto && p.color === cor) usada = true;
    });
    return usada;
  }

  /**
   * Cor definitiva de quem está entrando. A preferida é atendida quando está livre; senão vale
   * a primeira da paleta que ninguém pegou. Como há 10 cores e no máximo 10 jogadores, sempre
   * sobra uma — o `?? PLAYER_COLORS[0]` é só para o compilador.
   */
  private corLivre(preferida?: number): number {
    if (preferida !== undefined && PLAYER_COLORS.includes(preferida) && !this.corEmUso(preferida)) {
      return preferida;
    }
    return PLAYER_COLORS.find((c) => !this.corEmUso(c)) ?? PLAYER_COLORS[0]!;
  }

  private addPlayer(sessionId: string, nome: string | undefined, isBot = false, cor?: number): void {
    const slot = this.nextFreeSlot();
    if (slot === -1) {
      if (!isBot) this.spectatorSessions.add(sessionId);
      return;
    }

    const player = new PlayerState();
    player.id = sessionId;
    // A cor deixou de ser função do slot (Fase 10): agora ela é escolhida e por isso viaja
    // separada. `corLivre` mantém a garantia antiga de que duas não se repetem na sala.
    player.color = this.corLivre(cor);
    // Bot leva o nome do ANIMAL da própria cor (Fase 13 §3). Antes ele pegava um nome da lista de
    // teste pelo slot, e com bots entrando pelo lobby isso passou a produzir dois "Bruno" na
    // mesma sala — um de carne e osso e outro não. Como cor e animal são par fixo e a cor é única
    // por sala, o nome do bot também é.
    player.name = isBot
      ? `Bot ${ANIMAL_NOME[animalDaCor(player.color)]}`
      : nome?.trim() || TEST_PLAYER_NAMES[slot % TEST_PLAYER_NAMES.length]!;
    player.slot = slot;
    player.isBot = isBot;
    player.ready = isBot;

    this.state.players.set(sessionId, player);
    this.spectatorSessions.delete(sessionId);
    this.definirDono();
    this.publicarSala();
  }

  /** Cria mais um bot na sala, com id próprio e a primeira cor livre. */
  private adicionarBot(): void {
    this.addPlayer(`bot-${this.proximoBot++}`, undefined, true);
  }

  /**
   * Tira UM bot da sala — o do slot mais alto, isto é, o último que entrou. Devolve `false` se
   * não havia nenhum. É por aqui que passam tanto o `− BOT` do lobby quanto a prioridade do
   * humano que chega numa sala lotada de bots.
   */
  private removerUmBot(): boolean {
    let alvo: PlayerState | undefined;
    this.state.players.forEach((p) => {
      if (p.isBot && (alvo === undefined || p.slot > alvo.slot)) alvo = p;
    });
    if (!alvo) return false;
    this.removerJogador(alvo.id);
    return true;
  }

  /**
   * Apaga toda a pegada de um jogador (ou bot): estado frio, input pendente, cérebro de bot,
   * reserva de espectador e — se a partida está rolando — o TANQUE dele na simulação.
   *
   * É a remoção do tanque que resolve o "tanque fantasma" da Fase 13 §1: até aqui quem saía no
   * meio da rodada continuava de pé no meio da arena, servindo de obstáculo e de alvo. As balas
   * que ele já tinha disparado continuam vivas de propósito — elas morrem sozinhas em ≤ 2,2 s, e
   * apagá-las divergiria da previsão que cada cliente já está rodando.
   */
  private removerJogador(sessionId: string): void {
    this.state.players.delete(sessionId);
    this.lastInput.delete(sessionId);
    this.botBrains.delete(sessionId);
    this.matchStats.delete(sessionId);
    this.deviceIdBySession.delete(sessionId);
    this.aspectBySession.delete(sessionId);
    this.spectatorSessions.delete(sessionId);
    this.pendingSpectatorNames.delete(sessionId);
    this.pendingSpectatorColors.delete(sessionId);
    this.sim?.tanks.delete(sessionId);
    this.definirDono();
  }

  /** Humanos com vaga na sala + quem está de espectador esperando a próxima rodada. */
  private humanosNaSala(): number {
    let humanos = 0;
    this.state.players.forEach((p) => {
      if (!p.isBot) humanos += 1;
    });
    return humanos + this.spectatorSessions.size;
  }

  /**
   * O dono é o humano de menor slot — na prática o primeiro que entrou. Quando ele sai, o posto
   * passa para o próximo em vez de a sala ficar sem ninguém no comando dos bots.
   */
  private definirDono(): void {
    const atual = this.state.ownerId ? this.state.players.get(this.state.ownerId) : undefined;
    if (atual && !atual.isBot) return;

    let novo = '';
    let menorSlot = Infinity;
    this.state.players.forEach((p) => {
      if (!p.isBot && p.slot < menorSlot) {
        menorSlot = p.slot;
        novo = p.id;
      }
    });
    this.state.ownerId = novo;
  }

  /**
   * Publica no `metadata` do matchMaker o que a tela de entrada precisa para listar esta sala
   * (Fase 13 §2). Não é um registro paralelo de salas: é o mesmo cadastro que o `matchMaker.query`
   * já percorre, e a listagem sai dele.
   */
  private publicarSala(): void {
    let humanos = 0;
    let bots = 0;
    this.state.players.forEach((p) => {
      if (p.isBot) bots += 1;
      else humanos += 1;
    });
    void this.setMetadata({ codigo: this.roomId, humanos, bots, fase: this.state.phase }).catch(() => undefined);
  }

  /** Quem entrou como espectador (partida em andamento ou sala cheia) joga a partir da próxima rodada. */
  private promoteSpectators(): void {
    for (const sessionId of Array.from(this.spectatorSessions)) {
      if (this.state.players.size >= VAGAS_POR_SALA) break;
      this.addPlayer(sessionId, this.pendingSpectatorNames.get(sessionId), false, this.pendingSpectatorColors.get(sessionId));
      this.pendingSpectatorNames.delete(sessionId);
      this.pendingSpectatorColors.delete(sessionId);
    }
  }

  private statsFor(id: string): MatchTitleStats {
    let stats = this.matchStats.get(id);
    if (!stats) {
      stats = { playerId: id, selfKills: 0, shotsFired: 0, shotsHit: 0, aliveSeconds: 0, killCount: 0 };
      this.matchStats.set(id, stats);
    }
    return stats;
  }

  // ---------------------------------------------------------------------------------------
  // Fases
  // ---------------------------------------------------------------------------------------

  private updateLobby(): void {
    const total = this.state.players.size;
    if (total < 2) return;

    let allReady = true;
    let humanos = 0;
    this.state.players.forEach((p) => {
      if (!p.ready) allReady = false;
      if (!p.isBot) humanos += 1;
    });

    // Sala só de bots nunca começa. Sem isto, quem cria uma sala COM bots perde a corrida: os bots
    // entram em `onCreate` já prontos, o tick seguinte vê "todos prontos" e a partida começa antes
    // de o `onJoin` do criador rodar — que então entra como espectador da própria sala.
    if (humanos === 0 && !this.permitirPartidaSoDeBots) return;

    if (allReady) this.beginCountdown();
  }

  private beginCountdown(): void {
    this.promoteSpectators();

    const participantIds = Array.from(this.state.players.keys());
    const playerCount = participantIds.length;
    if (playerCount < 2) {
      this.state.phase = 'lobby';
      return;
    }

    if (!this.matchId) {
      this.startedAt = Date.now();
      this.matchId = `${this.roomId}-${this.startedAt}`;
    }

    // A forma do labirinto é combinada AQUI, uma vez por rodada, e viaja junto da seed. Nenhum
    // cliente pode derivá-la da própria janela: a tela de cada um é de um tamanho e a mesma seed
    // geraria geometrias diferentes, quebrando a previsão de bala.
    const aspect = this.aspectoDaSala(participantIds);

    let seed = pickSeed();
    let maze = makeMaze(seed, playerCount, aspect);
    let attempts = 0;
    while (!validateMaze(maze).ok && attempts < 8) {
      seed = pickSeed();
      maze = makeMaze(seed, playerCount, aspect);
      attempts += 1;
    }

    const rng = mulberry32(seed);
    const points = spawnPoints(maze, playerCount, rng);

    const tanks = new Map<string, Tank>();
    const spawns: { playerId: string; x: number; y: number }[] = [];

    this.botBrains.clear();
    participantIds.forEach((id, index) => {
      const point = points[index]!;
      const heading = rng.next() * Math.PI * 2;
      tanks.set(id, { id, x: point.x, y: point.y, heading, turret: heading, alive: true, fireCooldownLeft: 0 });
      spawns.push({ playerId: id, x: point.x, y: point.y });

      const player = this.state.players.get(id);
      if (player) player.alive = true;
      if (player?.isBot) {
        this.botBrains.set(id, makeBot(mulberry32(seed + player.slot * 7919 + 1), BOT_DIFFICULTY[this.botDificuldade]));
      }
    });

    this.sim = { tick: 0, maze, tanks, bullets: [], nextBulletId: 0 };
    this.eliminationOrder = [];
    this.deathLog = [];
    this.suddenDeath = { active: false, timer: 0, attempts: 0 };
    this.snapshotAccum = 0;
    this.lastInput.clear();

    this.state.round += 1;
    this.state.seed = seed;
    this.state.aspect = aspect;
    this.state.timeLeft = COUNTDOWN;
    this.state.phase = 'countdown';
    // A sala sai da lista de "abertas" no instante em que a partida começa e volta marcada como
    // EM PARTIDA — quem clicar nela entra como espectador.
    this.publicarSala();

    this.broadcast(MessageType.RoundStart, {
      round: this.state.round,
      seed,
      playerCount,
      aspect,
      spawns,
      tick: 0,
    });
  }

  /**
   * Proporção única da sala: a MEDIANA das telas anunciadas pelos humanos que estão jogando.
   *
   * Mediana e não média: um único ultrawide na sala não deve esticar a arena de mais oito
   * jogadores em 16:9, e um notebook 4:3 não deve encolher a de todo mundo. Com número par de
   * telas fica a menor das duas do meio, para o resultado não depender de arredondamento. Sala só
   * de bots (ou ninguém anunciou ainda) cai no 16:9 padrão.
   */
  private aspectoDaSala(participantIds: readonly string[]): number {
    const telas: number[] = [];
    for (const id of participantIds) {
      const a = this.aspectBySession.get(id);
      if (a !== undefined) telas.push(a);
    }
    if (telas.length === 0) return MAZE_ASPECT_DEFAULT;
    telas.sort((x, y) => x - y);
    return telas[Math.floor((telas.length - 1) / 2)]!;
  }

  private updateCountdown(dt: number): void {
    this.state.timeLeft = Math.max(0, this.state.timeLeft - dt);
    this.maybeSendSnapshot(dt);
    if (this.state.timeLeft <= 0) {
      this.state.phase = 'playing';
      this.state.timeLeft = this.roundTimeoutSeconds;
    }
  }

  private updatePlaying(dt: number): void {
    if (!this.sim) return;

    const inputs = this.collectInputs();
    const bulletIdsBefore = new Set(this.sim.bullets.map((b) => b.id));
    const events = step(this.sim, inputs, dt);
    // `step()` não mexe em `tick` — quem chama é o dono do relógio. Sem isso todo evento sai
    // carimbado com tick 0 e o throttle de rota dos bots (que conta ticks) nunca reavalia.
    this.sim.tick += 1;
    const bulletIdsAfter = new Set(this.sim.bullets.map((b) => b.id));

    this.handleSimEvents(events, bulletIdsBefore, bulletIdsAfter);

    this.sim.tanks.forEach((tank) => {
      if (tank.alive) this.statsFor(tank.id).aliveSeconds += dt;
    });

    const aliveIds = Array.from(this.sim.tanks.values())
      .filter((t) => t.alive)
      .map((t) => t.id);

    if (aliveIds.length <= 1) {
      this.endRound(aliveIds);
      return;
    }

    if (!this.suddenDeath.active) {
      this.state.timeLeft = Math.max(0, this.state.timeLeft - dt);
      if (this.state.timeLeft <= 0) {
        this.suddenDeath.active = true;
        this.suddenDeath.timer = 0;
      }
    } else {
      this.suddenDeath.timer += dt;
      if (this.suddenDeath.timer >= SUDDEN_DEATH_INTERVAL) {
        this.suddenDeath.timer -= SUDDEN_DEATH_INTERVAL;
        this.suddenDeath.attempts += 1;

        const removed = removeRandomInternalWall(this.sim.maze, this.state.seed, this.suddenDeath.attempts);
        if (removed) {
          this.broadcast(MessageType.SuddenDeathWall, { index: removed.index, wall: removed.wall, tick: this.sim.tick });
        } else {
          // não sobrou parede interna pra remover — empate técnico entre quem ainda está de pé
          this.endRound(aliveIds);
          return;
        }
      }
    }

    this.maybeSendSnapshot(dt);
  }

  private maybeSendSnapshot(dt: number): void {
    this.snapshotAccum += dt;
    const snapshotInterval = 1 / SNAPSHOT_HZ;
    if (this.snapshotAccum < snapshotInterval) return;
    this.snapshotAccum -= snapshotInterval;
    this.sendSnapshot();
  }

  private updateRoundEnd(dt: number): void {
    this.state.timeLeft = Math.max(0, this.state.timeLeft - dt);
    if (this.state.timeLeft > 0) return;

    if (this.state.round >= this.totalRodadas) {
      void this.finishMatch();
    } else {
      this.beginCountdown();
    }
  }

  // ---------------------------------------------------------------------------------------
  // Simulação — inputs, eventos, snapshot
  // ---------------------------------------------------------------------------------------

  private collectInputs(): Map<string, Input> {
    const inputs = new Map<string, Input>();
    if (!this.sim) return inputs;

    for (const tank of this.sim.tanks.values()) {
      if (!tank.alive) continue;
      const player = this.state.players.get(tank.id);
      if (player?.isBot) {
        inputs.set(tank.id, this.computeBotInput(tank));
      } else {
        inputs.set(tank.id, this.lastInput.get(tank.id) ?? EMPTY_INPUT);
      }
    }
    return inputs;
  }

  private computeBotInput(tank: Tank): Input {
    if (!this.sim) return EMPTY_INPUT;
    const target = this.nearestEnemy(tank.id);
    if (!target) return EMPTY_INPUT;

    const brain = this.botBrains.get(tank.id);
    if (!brain) return EMPTY_INPUT;

    return brain.think(tank, target, this.sim.maze, this.sim.tick, { bullets: this.sim.bullets });
  }

  private nearestEnemy(selfId: string): Vec2 | undefined {
    if (!this.sim) return undefined;
    const self = this.sim.tanks.get(selfId);
    if (!self) return undefined;

    let best: Tank | undefined;
    let bestDistSq = Infinity;
    for (const tank of this.sim.tanks.values()) {
      if (tank.id === selfId || !tank.alive) continue;
      const dx = tank.x - self.x;
      const dy = tank.y - self.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = tank;
      }
    }
    return best ? { x: best.x, y: best.y } : undefined;
  }

  private handleSimEvents(events: SimEvent[], bulletIdsBefore: Set<string>, bulletIdsAfter: Set<string>): void {
    const expiredIds = new Set<string>();

    for (const event of events) {
      if (event.type === 'shot') {
        this.statsFor(event.ownerId).shotsFired += 1;
        this.broadcast(MessageType.BulletSpawn, {
          id: event.bulletId,
          ownerId: event.ownerId,
          x: event.x,
          y: event.y,
          angle: event.angle,
          vx: event.vx,
          vy: event.vy,
          tick: event.tick,
        });
      } else if (event.type === 'bullet_expired') {
        expiredIds.add(event.bulletId);
        this.broadcast(MessageType.BulletDead, {
          id: event.bulletId,
          // Fase 10: a bala volta a morrer no 2º toque de parede. O motivo viaja separado de
          // `expirou` porque só o fim de vida explode na tela — morte na parede é silenciosa.
          motivo: event.reason === 'max_bounces' ? 'parede_excedeu_rebotes' : 'expirou',
          tick: event.tick,
        });
      } else if (event.type === 'bullet_clash') {
        // Choque bala×bala (Fase 5). O cliente já simulou o mesmo encontro com a mesma `step()`
        // e já mostrou a explosão; isto aqui é a confirmação autoritativa da remoção. Entrar em
        // `expiredIds` é obrigatório: sem isso os dois ids cairiam na lista de "sumiram sem
        // evento", que é o que pareia bala com morte de tanque logo abaixo.
        expiredIds.add(event.aId);
        expiredIds.add(event.bId);
        this.broadcast(MessageType.BulletDead, { id: event.aId, motivo: 'colisao_bala', tick: event.tick });
        this.broadcast(MessageType.BulletDead, { id: event.bId, motivo: 'colisao_bala', tick: event.tick });
      }
    }

    const vanished = Array.from(bulletIdsBefore).filter((id) => !bulletIdsAfter.has(id) && !expiredIds.has(id));
    let vanishedIndex = 0;

    for (const event of events) {
      if (event.type !== 'death') continue;

      const victim = this.state.players.get(event.victimId);
      const killer = this.state.players.get(event.killerId);

      if (victim) victim.deaths += 1;

      if (event.autogol) {
        if (victim) victim.selfKills += 1;
        this.statsFor(event.victimId).selfKills += 1;
      } else if (killer) {
        killer.kills += 1;
        this.statsFor(event.killerId).killCount += 1;
      }
      this.statsFor(event.killerId).shotsHit += 1;

      this.eliminationOrder.push(event.victimId);
      this.deathLog.push({ victimId: event.victimId, killerId: event.killerId, autogol: event.autogol });

      this.broadcast(MessageType.TankDeath, {
        victimId: event.victimId,
        killerId: event.killerId,
        x: event.x,
        y: event.y,
        tick: event.tick,
        autogol: event.autogol,
      });

      const bulletId = vanished[vanishedIndex];
      if (bulletId !== undefined) {
        vanishedIndex += 1;
        this.broadcast(MessageType.BulletDead, { id: bulletId, motivo: 'acerto', tick: event.tick, targetId: event.victimId });
      }
    }
  }

  private sendSnapshot(): void {
    if (!this.sim) return;
    const tanks: SnapshotTank[] = [];

    for (const tank of this.sim.tanks.values()) {
      const player = this.state.players.get(tank.id);
      if (!player) continue;
      tanks.push({
        slot: player.slot,
        x: tank.x,
        y: tank.y,
        heading: tank.heading,
        turret: tank.turret,
        alive: tank.alive,
        connected: player.connected,
      });
    }

    this.broadcastBytes(MessageType.Snapshot, encodeSnapshot(tanks), {});
  }

  // ---------------------------------------------------------------------------------------
  // Fim de rodada / fim de partida
  // ---------------------------------------------------------------------------------------

  private endRound(survivors: string[]): void {
    const positions = computeRoundRanking(this.eliminationOrder, survivors);
    const { kills, selfKills } = tallyKills(this.deathLog);

    const ranking: { playerId: string; position: number; score: number }[] = [];
    for (const entry of positions) {
      const player = this.state.players.get(entry.playerId);
      if (!player) continue;
      const points = roundScore(entry.position, kills.get(entry.playerId) ?? 0, selfKills.get(entry.playerId) ?? 0);
      player.score += points;
      ranking.push({ playerId: entry.playerId, position: entry.position, score: player.score });
    }
    ranking.sort((a, b) => b.position - a.position);

    this.state.phase = 'roundend';
    this.state.timeLeft = ROUND_END_DURATION;
    this.sim = null;

    this.broadcast(MessageType.RoundEnd, { round: this.state.round, ranking });
  }

  /**
   * Volta de `gameover` para o lobby mantendo a sala, o código e as pessoas (revanche).
   *
   * Zera tudo que é DA PARTIDA e preserva o que é DA PESSOA: nome, cor e a condição de dono
   * continuam; placar, abates, mortes, autogols e as estatísticas de título recomeçam. Bots
   * voltam prontos (é o estado natural deles) e humanos voltam a "não pronto", senão a revanche
   * começaria sozinha antes de todo mundo perceber que voltou ao lobby.
   *
   * `matchId` é limpo para que a próxima partida entre no ranking como uma partida NOVA, e não
   * some pontuação na anterior.
   */
  private reiniciarParaLobby(): void {
    for (const player of this.state.players.values()) {
      player.score = 0;
      player.kills = 0;
      player.deaths = 0;
      player.selfKills = 0;
      player.alive = false;
      player.ready = player.isBot;
    }
    this.matchStats.clear();
    this.matchId = '';
    this.state.round = 0;
    this.state.timeLeft = 0;
    this.state.phase = 'lobby';
    this.sim = null;
    this.botBrains.clear();
    this.publicarSala();
    this.broadcast(MessageType.Rematch, undefined);
  }

  private async finishMatch(): Promise<void> {
    this.state.phase = 'gameover';
    this.publicarSala();

    const players = Array.from(this.state.players.values());
    const finalRanking = [...players]
      .sort((a, b) => b.score - a.score)
      .map((p, index) => ({ playerId: p.id, nome: p.name, pontos: p.score, posicao: index + 1 }));

    const titleStats: MatchTitleStats[] = players.map((p) => {
      const stats = this.matchStats.get(p.id);
      return {
        playerId: p.id,
        selfKills: stats?.selfKills ?? 0,
        shotsFired: stats?.shotsFired ?? 0,
        shotsHit: stats?.shotsHit ?? 0,
        aliveSeconds: stats?.aliveSeconds ?? 0,
        killCount: stats?.killCount ?? 0,
      };
    });
    const titles = computeMatchTitles(titleStats);

    this.broadcast(MessageType.GameOver, { ranking: finalRanking, titulos: titles });

    try {
      const db = openDb();
      insertMatch(db, {
        id: this.matchId,
        startedAt: this.startedAt,
        endedAt: Date.now(),
        playersJson: JSON.stringify(players.map((p) => ({ id: p.id, nome: p.name, isBot: p.isBot }))),
      });

      const humanResults = players
        .filter((p) => !p.isBot)
        .map((p) => ({
          matchId: this.matchId,
          deviceId: this.deviceIdBySession.get(p.id) ?? p.id,
          nome: p.name,
          pontos: p.score,
          kills: p.kills,
          deaths: p.deaths,
          selfKills: p.selfKills,
          posicao: finalRanking.find((r) => r.playerId === p.id)?.posicao ?? players.length,
        }));

      if (humanResults.length > 0) {
        insertResults(db, humanResults);
        updateRatingsForMatch(
          db,
          humanResults.map((r) => ({ deviceId: r.deviceId, nome: r.nome, posicao: r.posicao })),
        );
      }
    } catch (err) {
      console.error('[persist] falha ao salvar resultado da partida:', err);
    }

    void sendMatchWebhook({
      roomId: this.roomId,
      finalizadaEm: new Date().toISOString(),
      ranking: finalRanking,
      titulos: titles,
    });
  }
}

function pickSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}
