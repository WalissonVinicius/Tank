import { describe, expect, it } from 'vitest';
import { SNAPSHOT_HZ, TANK_SPEED } from '@tank/protocol';
import { InterpolationBuffer, type InterpSample } from '../src/net/interpolation.js';

const PERIODO_MS = 1000 / SNAPSHOT_HZ; // 50 ms entre snapshots a 20 Hz
const ATRASO_MS = PERIODO_MS + 10; // mesmo INTERP_DELAY_MS usado por main.ts
const FRAME_MS = 1000 / 60;
/** A 60 fps e 60 px/s, um passo "liso" é 1 px. */
const PASSO_LISO = TANK_SPEED / 60;

/**
 * A prova de que o tanque remoto anda liso não pode depender do frame rate do navegador (num
 * headless com SwiftShader ele despenca para poucos fps e QUALQUER coisa parece "teleporte").
 * Aqui o buffer é alimentado com snapshots de 20 Hz de um tanque em linha reta a TANK_SPEED e
 * amostrado a 60 fps: o que se mede é a interpolação em si.
 */
describe('InterpolationBuffer — suavização do tanque remoto', () => {
  it('a 60 fps devolve posições intermediárias entre snapshots de 20 Hz, sem salto nem recuo', () => {
    const buf = new InterpolationBuffer(ATRASO_MS);
    const t0 = 1000;
    const posEm = (ms: number): number => (TANK_SPEED * ms) / 1000;

    const amostras: { t: number; x: number }[] = [];
    let proximoSnapshot = t0;

    for (let t = t0; t <= t0 + 1000; t += FRAME_MS) {
      while (proximoSnapshot <= t) {
        // o snapshot carrega a posição do servidor NAQUELE instante
        buf.push('remoto', {
          t: proximoSnapshot,
          x: posEm(proximoSnapshot - t0),
          y: 0,
          heading: 0,
          turret: 0,
          alive: true,
        });
        proximoSnapshot += PERIODO_MS;
      }
      const s = buf.sample('remoto', t);
      if (s) amostras.push({ t, x: s.x });
    }

    expect(amostras.length).toBeGreaterThan(50);

    let maiorSalto = 0;
    let recuos = 0;
    let posicoesDistintas = 0;
    for (let i = 1; i < amostras.length; i++) {
      const d = amostras[i]!.x - amostras[i - 1]!.x;
      if (d < -1e-9) recuos++;
      if (Math.abs(d) > 1e-9) posicoesDistintas++;
      maiorSalto = Math.max(maiorSalto, Math.abs(d));
    }

    // Um render sem interpolação daria degraus de 3 px (o deslocamento de um período inteiro de
    // snapshot) a cada 50 ms.
    expect(maiorSalto).toBeLessThan(PASSO_LISO * 1.6);
    expect(recuos).toBe(0);
    // Praticamente todo frame anda um pouco: nada de congelar esperando o próximo snapshot.
    expect(posicoesDistintas).toBeGreaterThan(amostras.length * 0.9);
  });

  it('interpola o ângulo pelo caminho curto ao cruzar ±π', () => {
    const buf = new InterpolationBuffer(0);
    buf.push('remoto', { t: 0, x: 0, y: 0, heading: Math.PI - 0.1, turret: 0, alive: true });
    buf.push('remoto', { t: 100, x: 0, y: 0, heading: -Math.PI + 0.1, turret: 0, alive: true });

    const meio = buf.sample('remoto', 50);
    // O caminho curto passa por ±π (0,2 rad de arco), não pela volta inteira de 6,08 rad.
    const distanciaDePi = Math.min(Math.abs(Math.abs(meio!.heading) - Math.PI), Math.abs(meio!.heading));
    expect(distanciaDePi).toBeLessThan(0.05);
  });
});

/**
 * O padrão de entrega REAL de produção, medido na tarefa O2: a cada ~1,2 s um pacote se perde e o
 * TCP só o recupera no RTO mínimo (200 ms). Durante a espera o bloqueio de cabeça de linha segura
 * todos os snapshots seguintes, que depois chegam JUNTOS, no mesmo milissegundo.
 *
 * `entregar` transforma a cadência perfeita do servidor nessa cadência esburacada.
 */
function chegadasComRetransmissao(qtd: number, latenciaMs: number, aCadaMs: number, rtoMs: number): number[] {
  const chegadas: number[] = [];
  let represadoAte = -Infinity;
  for (let k = 0; k < qtd; k++) {
    const emitido = k * PERIODO_MS;
    // O pacote perdido é o primeiro de cada janela: ele e tudo que vem atrás esperam o RTO.
    if (k > 0 && Math.floor(emitido / aCadaMs) !== Math.floor((emitido - PERIODO_MS) / aCadaMs)) {
      represadoAte = emitido + latenciaMs + rtoMs;
    }
    chegadas.push(Math.max(emitido + latenciaMs, represadoAte));
  }
  return chegadas;
}

interface Buffer {
  carimbar(agora: number): number;
  push(id: string, s: InterpSample): void;
  sample(id: string, now: number): { x: number } | null;
}

/**
 * O buffer COMO ERA antes da O2: duas amostras, carimbo pela hora de chegada, e a última amostra
 * segurada quando falta dado futuro. Fica aqui como referência do "antes" — é contra ele que os
 * números do "depois" valem alguma coisa.
 */
class BufferAntigo implements Buffer {
  private buf: InterpSample[] = [];
  constructor(private atraso: number) {}
  carimbar(agora: number): number {
    return agora;
  }
  push(_id: string, s: InterpSample): void {
    this.buf.push(s);
    if (this.buf.length > 2) this.buf.shift();
  }
  sample(_id: string, now: number): { x: number } | null {
    if (this.buf.length === 0) return null;
    if (this.buf.length === 1) return this.buf[0]!;
    const [a, b] = this.buf as [InterpSample, InterpSample];
    const rt = now - this.atraso;
    if (rt <= a.t) return a;
    if (rt >= b.t) return b;
    const span = b.t - a.t || 1;
    return { x: a.x + (b.x - a.x) * ((rt - a.t) / span) };
  }
}

interface Medida {
  maiorSalto: number;
  maiorCongelamento: number;
  piorErro: number;
}

/** Roda o buffer contra uma lista de chegadas e mede tranco (salto) e travada (congelamento). */
function medir(buf: Buffer, chegadas: number[]): Medida {
  const posEm = (ms: number): number => (TANK_SPEED * ms) / 1000;
  const fim = chegadas[chegadas.length - 1]! + 100;
  // Os primeiros 500 ms são o buffer enchendo; medir ali só mediria a partida a frio.
  const AQUECIMENTO_MS = 500;
  let proximo = 0;
  let anterior: number | null = null;
  let paradoDesde = 0;
  const m: Medida = { maiorSalto: 0, maiorCongelamento: 0, piorErro: 0 };

  for (let t = 0; t <= fim; t += FRAME_MS) {
    while (proximo < chegadas.length && chegadas[proximo]! <= t) {
      const emitido = proximo * PERIODO_MS;
      buf.push('remoto', { t: buf.carimbar(t), x: posEm(emitido), y: 0, heading: 0, turret: 0, alive: true });
      proximo++;
    }
    const s = buf.sample('remoto', t);
    if (!s) continue;
    if (anterior !== null && t > AQUECIMENTO_MS) {
      const d = Math.abs(s.x - anterior);
      m.maiorSalto = Math.max(m.maiorSalto, d);
      if (d < 1e-9) m.maiorCongelamento = Math.max(m.maiorCongelamento, t - paradoDesde);
      else paradoDesde = t;
      m.piorErro = Math.max(m.piorErro, Math.abs(s.x - posEm(t - ATRASO_MS - 25)));
    } else {
      paradoDesde = t;
    }
    anterior = s.x;
  }
  return m;
}

describe('InterpolationBuffer — entrega esburacada de produção (O2)', () => {
  const CHEGADAS = () => chegadasComRetransmissao(200, 25, 1200, 230);

  it('o buffer ANTIGO travava ~170 ms e depois saltava — o "antes" da O2', () => {
    const m = medir(new BufferAntigo(ATRASO_MS), CHEGADAS());

    // Parado a maior parte do buraco do RTO...
    expect(m.maiorCongelamento).toBeGreaterThan(150);
    // ...e depois um frame andando o que deveriam ser vários (mais de 4 passos lisos de uma vez).
    expect(m.maiorSalto).toBeGreaterThan(PASSO_LISO * 4);
  });

  it('atravessa a retransmissão do TCP sem congelar e sem saltar', () => {
    const m = medir(new InterpolationBuffer(ATRASO_MS), CHEGADAS());

    // Sem tranco: nenhum frame anda mais do que um passo liso e pouco.
    expect(m.maiorSalto).toBeLessThan(PASSO_LISO * 1.6);
    // Sem travada: nada de ficar parado dois frames seguidos.
    expect(m.maiorCongelamento).toBeLessThan(FRAME_MS * 2);
    // E continua fiel à posição do servidor — a extrapolação não é chute solto.
    expect(m.piorErro).toBeLessThan(PASSO_LISO * 2);
  });

  it('a rajada é reespaçada na grade de 50 ms em vez de virar um carimbo só', () => {
    const buf = new InterpolationBuffer(ATRASO_MS);
    // Um snapshot normal, silêncio de 250 ms, e cinco chegando no mesmo milissegundo.
    expect(buf.carimbar(1000)).toBe(1000);
    const rajada = [1250, 1250, 1250, 1250, 1250].map((t) => buf.carimbar(t));
    expect(rajada).toEqual([1050, 1100, 1150, 1200, 1250]);
  });

  it('o carimbo nunca vai para o futuro e ressincroniza depois de um silêncio longo', () => {
    const buf = new InterpolationBuffer(ATRASO_MS);
    buf.carimbar(1000);
    // Servidor um tico mais rápido que a grade: o carimbo gruda no presente, não o ultrapassa.
    expect(buf.carimbar(1040)).toBe(1040);
    // Aba em segundo plano por 5 s: reproduzir a grade arrastaria segundos de atraso.
    expect(buf.carimbar(6040)).toBe(6040);
  });

  it('um engasgo longo de entrega não é confundido com perda do fio', () => {
    // 800 ms é o pior engasgo visto em produção (retransmissão com espera dobrada). Os snapshots
    // existem e estão só represados: o histórico tem que sobreviver e a grade tem que ser mantida,
    // senão o tanque aparece teleportado em vez de reproduzir o movimento que ficou preso.
    const buf = new InterpolationBuffer(ATRASO_MS);
    buf.carimbar(1000);
    buf.push('remoto', { t: 1000, x: 0, y: 0, heading: 0, turret: 0, alive: true });
    expect(buf.carimbar(1800)).toBe(1050);
    expect(buf.sample('remoto', 1800)).not.toBeNull();

    // Já 3 s é a tela de fim de rodada: aí o servidor parou mesmo e recomeçar é o certo.
    const outro = new InterpolationBuffer(ATRASO_MS);
    outro.carimbar(1000);
    outro.push('remoto', { t: 1000, x: 0, y: 0, heading: 0, turret: 0, alive: true });
    expect(outro.carimbar(4000)).toBe(4000);
    expect(outro.sample('remoto', 4000)).toBeNull();
  });
});

describe('InterpolationBuffer — limites da extrapolação', () => {
  it('extrapola por um tempo limitado e depois segura, sem sair do mapa', () => {
    const buf = new InterpolationBuffer(0);
    buf.push('remoto', { t: 0, x: 0, y: 0, heading: 0, turret: 0, alive: true });
    buf.push('remoto', { t: PERIODO_MS, x: 3, y: 0, heading: 0, turret: 0, alive: true });

    // Dentro do teto: segue na velocidade das duas últimas amostras (3 px por 50 ms).
    expect(buf.sample('remoto', PERIODO_MS + 100)?.x).toBeCloseTo(9, 6);
    // Muito depois: freou e parou em 260 + 160 ms de avanço — nada de deslizar para fora da arena.
    const teto = 3 + (3 / PERIODO_MS) * (260 + 160);
    expect(buf.sample('remoto', 5_000)?.x).toBeCloseTo(teto, 6);
    expect(buf.sample('remoto', 60_000)?.x).toBeCloseTo(teto, 6);
    // E a frenagem é suave: entre o teto e a parada o tanque continua andando, cada vez menos.
    const a = buf.sample('remoto', PERIODO_MS + 260)!.x;
    const b = buf.sample('remoto', PERIODO_MS + 360)!.x;
    const c = buf.sample('remoto', PERIODO_MS + 460)!.x;
    expect(b - a).toBeGreaterThan(0);
    expect(c - b).toBeGreaterThan(0);
    expect(c - b).toBeLessThan(b - a);
  });

  it('não deixa um tanque que troca de direção balançar na tela', () => {
    // Um bot encostado na parede vai e volta a cada duas amostras. Com velocidade instantânea, a
    // aposta de 260 ms inverte junto e a posição desenhada oscila dezenas de pixels de um frame
    // para o outro — foi o pior tranco encontrado no trace de produção.
    const buf = new InterpolationBuffer(0);
    let t = 0;
    for (const x of [170, 173, 176, 173, 170, 173, 176, 173]) {
      buf.push('vaievem', { t, x, y: 0, heading: 0, turret: 0, alive: true });
      t += PERIODO_MS;
    }
    // Silêncio: o buffer extrapola. Nada do que ele desenhar pode sair da faixa em que o tanque
    // realmente anda, com folga de um período de movimento.
    const ultimo = t - PERIODO_MS;
    for (let q = ultimo; q <= ultimo + 300; q += FRAME_MS) {
      const x = buf.sample('vaievem', q)!.x;
      expect(x).toBeGreaterThan(160);
      expect(x).toBeLessThan(186);
    }
  });

  it('não extrapola tanque morto — carcaça não desliza sozinha', () => {
    const buf = new InterpolationBuffer(0);
    buf.push('remoto', { t: 0, x: 0, y: 0, heading: 0, turret: 0, alive: true });
    buf.push('remoto', { t: PERIODO_MS, x: 3, y: 0, heading: 0, turret: 0, alive: false });

    expect(buf.sample('remoto', PERIODO_MS + 200)?.x).toBe(3);
  });

  it('dissolve o erro da extrapolação em vez de corrigi-lo num frame só', () => {
    const buf = new InterpolationBuffer(0);
    // Duas amostras andando 3 px por período, e então o tanque PARA (bateu na parede).
    buf.push('remoto', { t: 0, x: 0, y: 0, heading: 0, turret: 0, alive: true });
    buf.push('remoto', { t: 50, x: 3, y: 0, heading: 0, turret: 0, alive: true });
    // Extrapolando: aos 100 ms o buffer aposta em 6 px.
    expect(buf.sample('remoto', 100)?.x).toBeCloseTo(6, 6);

    // Chega o dado real desmentindo a aposta: o tanque nunca saiu de 3, e fica lá.
    for (let t = 100; t <= 400; t += PERIODO_MS) {
      buf.push('remoto', { t, x: 3, y: 0, heading: 0, turret: 0, alive: true });
    }

    // O frame seguinte não pula os 3 px de erro de uma vez.
    const logoDepois = buf.sample('remoto', 100 + FRAME_MS)!.x;
    expect(Math.abs(logoDepois - 6)).toBeLessThan(1);
    // E em ~140 ms o erro acabou.
    expect(buf.sample('remoto', 300)?.x).toBeCloseTo(3, 6);
  });
});
