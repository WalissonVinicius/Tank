// Buffer de interpolação dos tanques: guarda as amostras que chegam no snapshot e devolve, a cada
// frame, a posição de `atraso` ms atrás — o que faz um fluxo de 20 Hz virar movimento liso a 60 fps.
//
// POR QUE ELE NÃO É MAIS UM PAR DE AMOSTRAS COM CARIMBO DE CHEGADA (tarefa O2)
//
// A entrega dos snapshots em produção não é lisa: a cada ~1,2 s um pacote se perde e o TCP só o
// recupera no RTO mínimo do Linux (200 ms). Enquanto o retransmitido não chega, o bloqueio de
// cabeça de linha segura TODOS os snapshots seguintes, que depois desembarcam JUNTOS, no mesmo
// milissegundo. Medido em produção: 20 a 35 desses episódios por 35 s, paradas de 224 a 244 ms.
//
// A versão antiga guardava duas amostras carimbadas pela HORA DE CHEGADA. Com esse padrão de
// entrega ela fazia exatamente o que o jogador reclama:
//   1. sem amostra futura, `sample` devolvia a última — o tanque CONGELAVA por ~170 ms;
//   2. a rajada chegava, as duas amostras guardadas ficavam com carimbos quase iguais e a mais
//      nova era descartada em favor da penúltima — o tanque SALTAVA os ~200 ms de movimento de
//      uma vez.
// O contador de fps não via nada: a thread principal estava livre (medido: 23 de 23 buracos com o
// relógio de 5 ms batendo normalmente).
//
// As três mudanças, todas do lado do cliente, porque a perda de pacote é do enlace e não tem
// conserto no código do jogo:
//
//   CARIMBO DE CADÊNCIA — o snapshot sai do servidor a cada 50 ms exatos, e o TCP não perde nem
//   embaralha nada: só atrasa. Então o carimbo não é mais a hora de chegada, é a grade de 50 ms
//   (`carimbar`). Uma rajada de cinco pacotes volta a ser os 250 ms de movimento que ela é, e é
//   reproduzida como tal em vez de virar um teleporte.
//
//   EXTRAPOLAÇÃO LIMITADA — faltando amostra futura, o tanque segue na velocidade recente
//   (suavizada, ver `PESO_VELOCIDADE`) por no máximo `MAX_EXTRAPOLACAO_MS`, e depois FREIA até
//   parar. Cobre o buraco do RTO inteiro. Extrapolar sem limite é o que joga tanque para fora do
//   mapa; cortar a seco é o que devolve a travada.
//
//   RECONCILIAÇÃO SUAVE — quando o dado real volta e desmente a extrapolação (o tanque virou, ou
//   bateu na parede), a diferença não é aplicada de uma vez: ela é dissolvida em
//   `SUAVIZACAO_MS`. É o que troca um salto por um deslize.
//
// Aumentar o atraso de interpolação resolveria a fome de amostra sem extrapolar nada, mas custaria
// os mesmos ~250 ms de latência em tudo — inclusive no tanque de quem está jogando, que sai deste
// mesmo buffer e é a referência da mira (`main.ts`). Por isso a escolha foi extrapolar.
import { SNAPSHOT_HZ } from '@tank/protocol';

export interface InterpSample {
  t: number; // instante de REPRODUÇÃO da amostra (grade de cadência), não a hora de chegada
  x: number;
  y: number;
  heading: number;
  turret: number;
  alive: boolean;
}

export interface InterpResult {
  x: number;
  y: number;
  heading: number;
  turret: number;
  alive: boolean;
}

/** Intervalo nominal entre snapshots do servidor. É a grade em que `carimbar` põe as amostras. */
const PERIODO_MS = 1000 / SNAPSHOT_HZ;

/**
 * Até onde a extrapolação anda em velocidade cheia. 260 ms cobre um RTO (200 ms) mais a folga da
 * cadência, que é o buraco típico de produção. A 60 px/s são 15,6 px de aposta — menos que o raio
 * do tanque.
 */
const MAX_EXTRAPOLACAO_MS = 260;

/**
 * Depois do teto, o tanque FREIA até parar em vez de estacar de uma vez.
 *
 * O TCP dobra o tempo de espera a cada retransmissão perdida, então além dos buracos de ~230 ms
 * aparecem alguns de 460 a 770 ms (medidos: 5 em 52 buracos, dois traces de 40 s). Cortar a
 * extrapolação a seco nesses casos devolve exatamente a travada que esta classe existe para
 * evitar. Freando, o movimento morre suave e a aposta total fica limitada a 260 + 160 = 420 ms,
 * ou ~25 px — e o erro que sobrar é dissolvido pela reconciliação quando o dado real chega.
 */
const FREIO_MS = 160;

/** Avanço efetivo da extrapolação: linear até o teto, depois assintótico até `+FREIO_MS`. */
function avancoFreado(bruto: number): number {
  if (bruto <= MAX_EXTRAPOLACAO_MS) return bruto;
  return MAX_EXTRAPOLACAO_MS + FREIO_MS * (1 - Math.exp(-(bruto - MAX_EXTRAPOLACAO_MS) / FREIO_MS));
}

/** Em quanto tempo o erro da extrapolação é dissolvido depois que o dado real volta. */
const SUAVIZACAO_MS = 140;

/**
 * Silêncio a partir do qual o buffer conclui que perdeu o fio e RECOMEÇA (ver `carimbar`).
 *
 * O valor separa duas coisas que se parecem: um engasgo de entrega, em que os snapshots existem e
 * estão só represados, e um silêncio de verdade, em que o servidor parou de mandar. Medido em
 * produção: o pior engasgo foi de 768 ms (retransmissão com espera dobrada), enquanto os silêncios
 * reais — a tela de fim de rodada — passam de 2,9 s. 1,2 s fica no meio, com folga dos dois lados.
 *
 * Baixo demais (500 ms, o primeiro valor que tentei) e um engasgo longo era tratado como perda do
 * fio: o histórico ia fora e o tanque aparecia teleportado 30 px adiante, que é justamente o
 * tranco que esta classe existe para evitar.
 */
const RESSINCRONIZAR_MS = 1200;

/** Histórico por tanque. 12 amostras são 600 ms — o dobro do maior buraco que se pretende cobrir. */
const MAX_AMOSTRAS = 12;

/**
 * Peso da amostra nova na velocidade usada para extrapolar.
 *
 * A velocidade instantânea (o último par de amostras) não serve: extrapolar 260 ms a partir de um
 * par de 50 ms multiplica por 5 qualquer erro dela. Um bot encostado na parede troca de direção a
 * cada duas amostras, e com velocidade instantânea a posição desenhada balança 38 px de um frame
 * para o outro (medido no trace de produção). Misturando 40% da medida nova com 60% do que já se
 * sabia, uma inversão isolada quase não mexe na aposta, e um movimento de verdade converge em
 * três amostras (150 ms).
 */
const PESO_VELOCIDADE = 0.4;

interface Velocidade {
  x: number;
  y: number;
  heading: number;
  turret: number;
}

interface Suavizacao {
  x: number;
  y: number;
  heading: number;
  turret: number;
  extrapolando: boolean;
  /** Erro congelado no instante em que a extrapolação terminou, e até quando ele ainda pesa. */
  ex: number;
  ey: number;
  eh: number;
  et: number;
  ate: number;
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/** Diferença angular pelo caminho curto: sempre em (-π, π]. */
function arcoCurto(de: number, para: number): number {
  let diff = (para - de) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

function angleLerp(a: number, b: number, k: number): number {
  return a + arcoCurto(a, b) * k;
}

export class InterpolationBuffer {
  private buffers = new Map<string, InterpSample[]>();
  private suave = new Map<string, Suavizacao>();
  private velocidades = new Map<string, Velocidade>();
  /** Relógio de reprodução: o carimbo dado ao último snapshot. Um só, para todos os tanques. */
  private ultimoCarimbo: number | null = null;

  constructor(private delayMs = 100) {}

  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  /**
   * Avança o relógio de reprodução em um período e devolve o carimbo do snapshot que acabou de
   * chegar. Chamar UMA vez por snapshot, antes de empurrar os tanques dele.
   *
   * Dois freios. O carimbo nunca passa do presente, senão a interpolação leria o futuro — esse é
   * o caso comum, e é ele que impede o atraso de uma rajada de virar atraso permanente.
   *
   * E depois de `RESSINCRONIZAR_MS` de silêncio o histórico inteiro é JOGADO FORA. Um silêncio
   * desses é fim de rodada, aba em segundo plano ou reconexão: o que estava guardado descreve
   * outro momento do jogo, e interpolar entre a última posição antiga e a primeira nova arrastaria
   * o tanque pela arena em vez de simplesmente colocá-lo onde ele está.
   */
  carimbar(agora: number): number {
    let c = agora;
    if (this.ultimoCarimbo !== null) {
      const daGrade = this.ultimoCarimbo + PERIODO_MS;
      if (agora - daGrade > RESSINCRONIZAR_MS) {
        this.buffers.clear();
        this.suave.clear();
        this.velocidades.clear();
      } else if (daGrade < agora) {
        c = daGrade;
      }
    }
    this.ultimoCarimbo = c;
    return c;
  }

  push(id: string, sample: InterpSample): void {
    const buf = this.buffers.get(id);
    if (!buf) {
      this.buffers.set(id, [sample]);
      return;
    }
    this.atualizarVelocidade(id, buf, sample);
    buf.push(sample);
    if (buf.length > MAX_AMOSTRAS) buf.splice(0, buf.length - MAX_AMOSTRAS);
  }

  /**
   * Mistura na velocidade guardada a que a amostra nova revela. A base é a amostra mais recente
   * que esteja pelo menos um período atrás: dois snapshots podem acabar com carimbos a poucos
   * milissegundos um do outro, e uma base tão curta transformaria 3 px em 1500 px/s.
   */
  private atualizarVelocidade(id: string, buf: InterpSample[], nova: InterpSample): void {
    let base: InterpSample | undefined;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (nova.t - buf[i]!.t >= PERIODO_MS * 0.8) {
        base = buf[i]!;
        break;
      }
    }
    if (!base) return;
    const dt = nova.t - base.t;
    const medida: Velocidade = {
      x: (nova.x - base.x) / dt,
      y: (nova.y - base.y) / dt,
      heading: arcoCurto(base.heading, nova.heading) / dt,
      turret: arcoCurto(base.turret, nova.turret) / dt,
    };
    const v = this.velocidades.get(id);
    if (!v) {
      this.velocidades.set(id, medida);
      return;
    }
    const a = PESO_VELOCIDADE;
    v.x += (medida.x - v.x) * a;
    v.y += (medida.y - v.y) * a;
    v.heading += (medida.heading - v.heading) * a;
    v.turret += (medida.turret - v.turret) * a;
  }

  sample(id: string, now: number): InterpResult | null {
    const buf = this.buffers.get(id);
    if (!buf || buf.length === 0) return null;

    const alvo = now - this.delayMs;
    const primeiro = buf[0]!;
    const ultimo = buf[buf.length - 1]!;

    let saida: InterpResult;
    let extrapolando = false;

    if (buf.length === 1 || alvo <= primeiro.t) {
      saida = { ...primeiro };
    } else if (alvo >= ultimo.t) {
      const r = this.extrapolar(id, buf, alvo);
      saida = r.saida;
      extrapolando = r.extrapolando;
    } else {
      saida = interpolarNoPar(buf, alvo);
    }

    return this.reconciliar(id, saida, extrapolando, now);
  }

  remove(id: string): void {
    this.buffers.delete(id);
    this.suave.delete(id);
    this.velocidades.delete(id);
  }

  clear(): void {
    this.buffers.clear();
    this.suave.clear();
    this.velocidades.clear();
    this.ultimoCarimbo = null;
  }

  /**
   * Sem amostra futura: segue na velocidade guardada, com teto. Tanque morto não anda — extrapolar
   * um destroço faria a carcaça deslizar sozinha pela arena.
   */
  private extrapolar(id: string, buf: InterpSample[], alvo: number): { saida: InterpResult; extrapolando: boolean } {
    const ultimo = buf[buf.length - 1]!;
    const v = this.velocidades.get(id);
    const avanco = avancoFreado(alvo - ultimo.t);
    if (!v || avanco <= 0 || !ultimo.alive) {
      return { saida: { ...ultimo }, extrapolando: false };
    }
    return {
      saida: {
        x: ultimo.x + v.x * avanco,
        y: ultimo.y + v.y * avanco,
        heading: ultimo.heading + v.heading * avanco,
        turret: ultimo.turret + v.turret * avanco,
        alive: ultimo.alive,
      },
      extrapolando: true,
    };
  }

  /**
   * Dissolve o erro da extrapolação em vez de corrigi-lo num frame só. O erro é congelado no
   * instante em que o dado real volta e some linearmente em `SUAVIZACAO_MS`.
   */
  private reconciliar(id: string, saida: InterpResult, extrapolando: boolean, now: number): InterpResult {
    const st = this.suave.get(id);
    if (!st) {
      this.suave.set(id, { ...saida, extrapolando, ex: 0, ey: 0, eh: 0, et: 0, ate: 0 });
      return saida;
    }

    if (st.extrapolando && !extrapolando) {
      st.ex = st.x - saida.x;
      st.ey = st.y - saida.y;
      st.eh = arcoCurto(saida.heading, st.heading);
      st.et = arcoCurto(saida.turret, st.turret);
      st.ate = now + SUAVIZACAO_MS;
    }
    st.extrapolando = extrapolando;

    let final = saida;
    if (now < st.ate) {
      const k = (st.ate - now) / SUAVIZACAO_MS;
      final = {
        x: saida.x + st.ex * k,
        y: saida.y + st.ey * k,
        heading: saida.heading + st.eh * k,
        turret: saida.turret + st.et * k,
        alive: saida.alive,
      };
    }

    st.x = final.x;
    st.y = final.y;
    st.heading = final.heading;
    st.turret = final.turret;
    return final;
  }
}

/** Interpola dentro do par de amostras que cerca `alvo`. A busca vem do fim: o alvo é recente. */
function interpolarNoPar(buf: InterpSample[], alvo: number): InterpResult {
  let i = buf.length - 2;
  while (i > 0 && buf[i]!.t > alvo) i--;
  const a = buf[i]!;
  const b = buf[i + 1]!;
  const span = b.t - a.t;
  const k = span > 0 ? (alvo - a.t) / span : 1;
  return {
    x: lerp(a.x, b.x, k),
    y: lerp(a.y, b.y, k),
    heading: angleLerp(a.heading, b.heading, k),
    turret: angleLerp(a.turret, b.turret, k),
    alive: b.alive,
  };
}
