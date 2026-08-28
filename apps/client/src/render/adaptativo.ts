// ---------------------------------------------------------------------------------------------
// O JOGO SE MEDE E SE AJUSTA (O1)
//
// Antes desta tarefa o degrau de pós-processamento era escolhido só pelo TAMANHO DA TELA. Tamanho
// de tela não diz nada sobre a força da GPU: um notebook fraco em 1366×768 (1,05 MPX) passava
// folgado pelo orçamento de pixels e recebia a cadeia CHEIA — bloom com quatro passes de Kawase
// mais o CRT — e engasgava sem o jogo nunca perceber. Medido em produção, no mesmo 1366×768: 28%
// de frames acima de 33 ms com a CPU 4× mais lenta, e 2 fps sem GPU nenhuma.
//
// A correção é medir o próprio tempo de frame e descer a escada sozinho. Este arquivo é só a
// DECISÃO: nada de DOM, nada de Pixi aqui dentro — quem chama entrega um relógio e recebe de
// volta o degrau novo (ou null, que é o caso de 99,9% dos frames). Assim a política inteira cabe
// num teste de unidade, que é onde regra de histerese tem que ser provada.
// ---------------------------------------------------------------------------------------------

import { DEGRAUS, type NivelFx } from './post.js';

/** Motivo da última mudança de degrau — vai para a trilha de diagnóstico. */
export type MotivoFx = 'janela' | 'catastrofe' | 'folga';

export interface TrocaDeDegrau {
  /** Segundos desde o primeiro frame amostrado. */
  s: number;
  de: NivelFx;
  para: NivelFx;
  motivo: MotivoFx;
}

/**
 * Tempo mínimo de frame que ainda conta como cadência de tela. Abaixo disto é ruído de medição
 * (dois quadros no mesmo vsync, relógio de baixa resolução).
 */
const MENOR_FRAME_PLAUSIVEL = 4;
/**
 * Cadência de tela mais lenta que existe de verdade, em ms (30 Hz). O adaptador estima a cadência
 * pelo MENOR frame já visto, e essa estimativa é limitada aqui: se a máquina nunca entregou um
 * frame rápido, a leitura ingênua diria "a tela dela é de 25 Hz" e o jogo nunca acharia problema
 * nenhum. Entre 33,4 ms e 50 ms não existe taxa de atualização de monitor — só máquina lenta.
 */
const CADENCIA_MAX_MS = 33.4;
/**
 * Piso do limite de "frame ruim". Numa tela de 60 Hz um frame de 24 ms já perdeu um vsync.
 */
const RUIM_MIN_MS = 24;
/**
 * Folga sobre a cadência da tela antes de um frame contar como ruim.
 *
 * O limite NÃO é fixo: sai da cadência real (menor frame visto × folga). Fixo em 24 ms, uma tela
 * de 30 Hz — que existe, e num notebook de escritório aparece sozinha quando o Windows resolve
 * economizar bateria — teria TODO frame classificado como ruim e o jogo desceria a escada inteira
 * sem nenhum motivo.
 */
const RUIM_FOLGA = 1.4;

/**
 * Duração MÉDIA de frame que condena o degrau sozinha, sem olhar a cauda.
 *
 * A régua da fração de frames ruins é relativa à cadência da tela e por isso é cega para o caso
 * uniforme: uma máquina travada em 25 fps entrega 40 ms em TODO frame, sem jitter nenhum, e a
 * fração de frames "fora da cadência" dá zero. 36 ms é 27,8 fps — abaixo de qualquer cadência de
 * monitor real, então só máquina lenta cai aqui.
 */
const MEDIA_RUIM_MS = 36;
/** Média que ainda conta como folga para efeito de SUBIR de degrau (33 fps). */
const MEDIA_BOA_MS = 30;

/** Frame acima disto não é engasgo: é a cadeia de filtros não dando conta do quadro inteiro. */
const MS_GRAVE = 120;
/** Frames graves consecutivos que disparam a descida por catástrofe. */
const GRAVES_PARA_DESCER = 3;
/**
 * Tempo contínuo de frames graves que a catástrofe exige, além da contagem.
 *
 * A contagem sozinha não separa "esta máquina não desenha um quadro" de "acabou de acontecer um
 * engasgo": a troca de rodada ainda congela por segundos (tarefa B3) e a CAUDA dela entregava
 * três frames longos em fila, derrubando dois degraus de uma vez. Medindo o VÃO, um SwiftShader
 * de 560 ms fecha os 1,2 s em três frames, enquanto uma cauda de 150 ms precisaria de oito
 * seguidos — que aí já é problema de verdade.
 */
const GRAVES_MS_MIN = 1200;

/**
 * Acima disto o frame deixa de ser medição de renderização.
 *
 * O número é baixo de propósito. O Chrome derruba o requestAnimationFrame para 1 Hz quando a
 * janela fica COBERTA por outra (não é o mesmo que aba escondida, e o document.hidden continua
 * false), e a troca de rodada congela ~3,3 s por upload de textura (tarefa B3) — os dois
 * entregariam frames enormes que nada no pós-processamento explica ou conserta. Do outro lado,
 * o frame legítimo mais lento que já medimos é o do SwiftShader em 1366x768: 649 ms. Entre 900
 * ms e o infinito não existe jogo, só ambiente.
 */
const MS_DESCARTE = 900;

/** Carregamento, compilação de shader e primeira montagem da arena não entram na amostra. */
const AQUECIMENTO_MS = 2500;
/**
 * Janela deslizante curta, usada até a PRIMEIRA descida: uma máquina fraca não pode sofrer 30 s
 * antes de o jogo perceber.
 */
const JANELA_CURTA_MS = 4000;
/** Janela de regime — longa o bastante para um susto isolado não derrubar a qualidade. */
const JANELA_LONGA_MS = 6000;
/** Até quando a janela curta vale, contado do fim do aquecimento. */
const FASE_CURTA_MS = 12000;
/** Sem este mínimo de frames a fração é chute: 2 ruins de 3 dariam 67%. */
const MIN_AMOSTRAS = 12;

/** Fração de frames ruins na janela longa que derruba um degrau. */
const FRACAO_DESCE = 0.25;
/**
 * A mesma fração na janela CURTA, que é a da pressa inicial.
 *
 * O limite é mais alto de propósito: a janela curta é curta, e um trecho ruim de dois segundos —
 * outro programa abrindo, o antivírus acordando — não pode deixar o jogo mais feio pelo resto da
 * partida. Com metade dos frames ruins a reação rápida fica reservada a quem está claramente mal;
 * o caso intermediário espera a janela longa e cai por volta dos 12 s, ainda muito antes dos 30 s
 * que a especificação chama de tarde demais.
 */
const FRACAO_DESCE_PRESSA = 0.5;
/** Fração máxima de frames ruins que ainda conta como folga para efeito de subir. */
const FRACAO_SOBE = 0.03;
/** Tempo contínuo de folga exigido para tentar subir um degrau. */
const ESTAVEL_MS = 25000;
/** Carência depois de qualquer troca: o próprio remonte da cadeia custa um frame ou dois. */
const CARENCIA_MS = 1500;

/**
 * Quanto a duração média do frame precisa ENCURTAR para a descida ter valido a pena.
 *
 * Sem isto uma máquina limitada por CPU (e não pela cadeia de filtros) cairia a escada inteira até
 * o degrau sem filtros e ficaria feia à toa — os filtros nunca foram o gargalo dela. Se o degrau
 * novo não tirou pelo menos 15% do tempo de frame, a escada TRAVA: o problema não é o
 * pós-processamento e deixar o jogo mais feio não vai consertá-lo.
 */
const GANHO_MINIMO = 0.85;

const CAPACIDADE = 1024;

/** Leitura segura da escada — o índice vem sempre de aritmética já limitada, mas o tsconfig não sabe. */
function degrau(indice: number): NivelFx {
  return DEGRAUS[Math.min(DEGRAUS.length - 1, Math.max(0, indice))] ?? 'desligado';
}

export interface DiagnosticoFx {
  nivel: NivelFx;
  /** Fração de frames ruins na janela atual. */
  fracao: number;
  amostras: number;
  limiteRuimMs: number;
  /** `true` quando a escada travou porque descer mais não estava pagando. */
  travada: boolean;
}

/**
 * Decide o degrau de pós-processamento pela medição do próprio tempo de frame.
 *
 * Ciclo de vida: `amostrar()` uma vez por frame, com o relógio de tempo real. Devolve o degrau
 * NOVO quando ele muda e `null` no resto — que é quase sempre.
 */
export class AdaptadorDeQualidade {
  private indice: number;
  /** Melhor degrau que ainda pode ser tentado. Só piora, nunca melhora — é a trava da histerese. */
  private teto: number;
  /** Pior degrau que a régua da janela pode alcançar. A catástrofe ignora esta trava. */
  private piso = DEGRAUS.length - 1;
  /** Degrau em que a última PROMOÇÃO pousou; -1 quando o degrau atual veio de uma descida. */
  private promovidoPara = -1;

  private readonly instante = new Float64Array(CAPACIDADE);
  private readonly duracao = new Float64Array(CAPACIDADE);
  private readonly ruim = new Uint8Array(CAPACIDADE);
  private ini = 0;
  private prox = 0;
  private n = 0;
  private ruins = 0;
  private soma = 0;

  private anteriorMs = -1;
  private inicioMs = -1;
  private ignorarAte = -1;
  private travadoAte = -1;
  private estavelDesde = -1;
  private pular = true;
  private graves = 0;
  private gravesMs = 0;
  private menorFrame = Number.POSITIVE_INFINITY;
  /** Duração média do frame no instante da última descida — o "antes" da comparação. */
  private mediaAntes = Number.POSITIVE_INFINITY;
  private avaliarDescidaApos = -1;

  readonly trilha: TrocaDeDegrau[] = [];

  /**
   * @param inicial degrau em que o jogo começa (o que a régua de megapixels escolheu).
   * @param congelado `true` quando o jogador forçou o degrau por `?fx=` — aí o adaptador só mede
   *   e não mexe em nada. Respeitar quem escolheu é regra da especificação.
   */
  constructor(inicial: NivelFx, private readonly congelado = false) {
    this.indice = Math.max(0, DEGRAUS.indexOf(inicial));
    this.teto = this.indice;
  }

  get nivel(): NivelFx {
    return degrau(this.indice);
  }

  get diagnostico(): DiagnosticoFx {
    return {
      nivel: this.nivel,
      fracao: this.n > 0 ? Math.round((1000 * this.ruins) / this.n) / 1000 : 0,
      amostras: this.n,
      limiteRuimMs: Math.round(this.limiteRuim() * 10) / 10,
      travada: this.piso <= this.indice,
    };
  }

  /**
   * Manda ignorar os próximos `ms` de frames. É o que o `Renderer` usa na troca de rodada: o
   * congelamento de upload de textura (3,3 s, tarefa B3) não é culpa da cadeia de filtros, e
   * derrubar a qualidade por causa dele não resolveria nada.
   */
  ignorarPor(agoraMs: number, ms: number): void {
    this.ignorarAte = Math.max(this.ignorarAte, agoraMs + ms);
  }

  /** Amostra um frame. Devolve o degrau novo quando ele mudou, `null` quando nada mudou. */
  amostrar(agoraMs: number, visivel = true): NivelFx | null {
    const anterior = this.anteriorMs;
    this.anteriorMs = agoraMs;
    if (anterior < 0) {
      this.inicioMs = agoraMs;
      this.estavelDesde = agoraMs;
      return null;
    }
    const dt = agoraMs - anterior;
    // O piso do relógio de tela sai da MENOR duração já vista, e continua sendo colhido mesmo
    // quando a amostra é descartada: é informação sobre o monitor, não sobre o jogo.
    if (dt >= MENOR_FRAME_PLAUSIVEL && dt < this.menorFrame) this.menorFrame = dt;

    if (this.congelado) return null;

    const aquecendo = agoraMs < this.inicioMs + AQUECIMENTO_MS;
    if (aquecendo || !visivel || agoraMs < this.ignorarAte || dt > MS_DESCARTE) {
      this.descartar(agoraMs);
      return null;
    }
    // O primeiro frame depois de uma pausa mede a PAUSA, não a renderização.
    if (this.pular) {
      this.pular = false;
      return null;
    }

    if (dt > MS_GRAVE) {
      this.graves += 1;
      this.gravesMs += dt;
    } else {
      this.graves = 0;
      this.gravesMs = 0;
    }
    this.empurrar(agoraMs, dt, dt > this.limiteRuim());

    if (agoraMs < this.travadoAte) return null;

    // Catástrofe: frames graves em sequência E cobrindo um VÃO de tempo, não só uma contagem.
    // É o que separa "esta máquina não desenha um quadro" de "acabou de acontecer um engasgo" —
    // a troca de rodada ainda congela por segundos (tarefa B3) e a cauda dela, mesmo depois da
    // janela ignorada, entregava três frames longos em fila.
    //
    // E desce UM degrau, como qualquer outra descida. Já houve um atalho aqui que pulava a escada
    // inteira quando o frame passava de 250 ms; ele existia para o caso sem GPU, que hoje é
    // resolvido no boot pela detecção de rasterizador — e, com a CPU 4× mais lenta, o que ele
    // realmente pegava era a cauda da troca de rodada, levando o jogo de `alto` a `desligado` de
    // uma vez só (medido).
    if (this.graves >= GRAVES_PARA_DESCER && this.gravesMs >= GRAVES_MS_MIN) {
      return this.descer(agoraMs, 'catastrofe');
    }

    // A janela curta existe para a máquina fraca não sofrer 30 s antes de o jogo perceber — e é
    // só para a PRIMEIRA descida. Depois que o jogo já mexeu uma vez, a pressa acabou: qualquer
    // degrau a mais passa a exigir a janela longa, que é o que impede a escada de escorregar
    // inteira por causa de um trecho ruim.
    const comPressa = this.trilha.length === 0 && agoraMs < this.inicioMs + AQUECIMENTO_MS + FASE_CURTA_MS;
    const janela = comPressa ? JANELA_CURTA_MS : JANELA_LONGA_MS;
    this.podar(agoraMs - janela);
    // Só decide com a janela CHEIA. Sem isto, um tropeço de dois segundos logo depois do
    // aquecimento ocuparia a janela inteira (que ainda nem tinha história) e daria 100% de frames
    // ruins — o jogo desceria um degrau por causa de um antivírus acordando, e o degrau não
    // voltaria mais.
    const vao = this.n > 0 ? agoraMs - (this.instante[this.ini] ?? agoraMs) : 0;
    if (this.n < MIN_AMOSTRAS || vao < janela * 0.8) return null;
    const fracao = this.ruins / this.n;

    // PERÍODO DE OBSERVAÇÃO da descida anterior. Enquanto ele corre nada mais muda (a não ser
    // catástrofe, que sai lá em cima): a régua da janela precisa de uma janela INTEIRA no degrau
    // novo para poder dizer se ele adiantou alguma coisa.
    if (this.avaliarDescidaApos >= 0) {
      if (agoraMs < this.avaliarDescidaApos) return null;
      this.avaliarDescidaApos = -1;
      // O veredito é sobre a DURAÇÃO média do frame, não sobre a fração de frames ruins: 60 ms e
      // 45 ms são os dois 100% ruins, e mesmo assim a diferença entre eles é enorme.
      //
      // E ele fecha UMA das duas portas, sempre:
      //
      //  · encurtou o frame → a cadeia ERA o gargalo. Voltar para cima traria o problema de
      //    volta, então o teto desce aqui e não se sobe mais. É o que impede a oscilação no caso
      //    comum — a máquina que simplesmente não dá conta do degrau cheio muda de aparência UMA
      //    vez na partida inteira, e não de ida e volta a cada 25 s.
      //  · não encurtou → o gargalo é outro (CPU, aba disputando a GPU) e continuar descendo só
      //    deixaria o jogo feio de graça: a escada trava para baixo, mas a volta continua
      //    autorizada, porque quando o outro programa fechar a qualidade cheia cabe de novo.
      if (this.media() > this.mediaAntes * GANHO_MINIMO) this.piso = this.indice;
      else this.teto = this.indice;
    }

    // Duas réguas, porque nenhuma sozinha vê os dois jeitos de o jogo ficar ruim: a FRAÇÃO pega o
    // engasgo (frames rápidos com picos, que é o que o jogador chama de travado) e a MÉDIA pega o
    // regime uniformemente lento, que não tem pico nenhum e por isso escapa da primeira.
    const media = this.media();
    if (fracao > (comPressa ? FRACAO_DESCE_PRESSA : FRACAO_DESCE) || media > MEDIA_RUIM_MS) {
      const novo = this.descer(agoraMs, 'janela');
      if (novo !== null) {
        this.mediaAntes = media;
        // A observação usa sempre a janela LONGA, mesmo quando a descida saiu da curta: a pressa
        // vale para a primeira reação, não para o veredito. Medido: com observação curta o jogo
        // caía dois degraus em três segundos numa máquina que estava só passando por um trecho
        // ruim.
        this.avaliarDescidaApos = agoraMs + CARENCIA_MS + JANELA_LONGA_MS;
      }
      return novo;
    }

    if (fracao > FRACAO_SOBE || media > MEDIA_BOA_MS) this.estavelDesde = agoraMs;
    if (this.indice > this.teto && agoraMs - this.estavelDesde >= ESTAVEL_MS) return this.subir(agoraMs);
    return null;
  }

  /** Cadência estimada da tela — ver `CADENCIA_MAX_MS`. */
  private cadencia(): number {
    return Number.isFinite(this.menorFrame) ? Math.min(CADENCIA_MAX_MS, this.menorFrame) : 16.7;
  }

  private limiteRuim(): number {
    return Math.max(RUIM_MIN_MS, this.cadencia() * RUIM_FOLGA);
  }

  private descer(agoraMs: number, motivo: MotivoFx): NivelFx | null {
    const limite = motivo === 'catastrofe' ? DEGRAUS.length - 1 : this.piso;
    const alvo = Math.min(limite, DEGRAUS.length - 1, this.indice + 1);
    if (alvo <= this.indice) return null;
    // Se este degrau veio de uma PROMOÇÃO e não aguentou, a promoção foi um erro de julgamento e
    // o teto desce para sempre — a segunda metade da garantia de no máximo UMA oscilação.
    // Catástrofe fecha a porta na hora: três frames seguidos acima de 120 ms não são um susto.
    if (this.promovidoPara === this.indice || motivo === 'catastrofe') this.teto = alvo;
    return this.mudar(agoraMs, alvo, motivo);
  }

  private subir(agoraMs: number): NivelFx {
    const alvo = this.indice - 1;
    const nivel = this.mudar(agoraMs, alvo, 'folga');
    this.promovidoPara = alvo;
    return nivel;
  }

  private mudar(agoraMs: number, alvo: number, motivo: MotivoFx): NivelFx {
    const de = degrau(this.indice);
    this.indice = alvo;
    this.promovidoPara = -1;
    this.graves = 0;
    this.gravesMs = 0;
    this.limpar();
    this.travadoAte = agoraMs + CARENCIA_MS;
    this.estavelDesde = agoraMs + CARENCIA_MS;
    this.pular = true;
    if (this.trilha.length < 64) {
      this.trilha.push({ s: Math.round((agoraMs - this.inicioMs) / 10) / 100, de, para: degrau(alvo), motivo });
    }
    return degrau(alvo);
  }

  private descartar(agoraMs: number): void {
    this.pular = true;
    this.graves = 0;
    this.gravesMs = 0;
    this.limpar();
    // Aba escondida, depurador parado, troca de rodada: nada disso é prova de que a máquina anda
    // bem, então o relógio da folga que autoriza subir de degrau recomeça do zero.
    this.estavelDesde = agoraMs;
  }

  private limpar(): void {
    this.ini = 0;
    this.prox = 0;
    this.n = 0;
    this.ruins = 0;
    this.soma = 0;
  }

  /** Duração média do frame na janela atual. */
  private media(): number {
    return this.n > 0 ? this.soma / this.n : Number.POSITIVE_INFINITY;
  }

  private empurrar(agoraMs: number, dt: number, ruim: boolean): void {
    if (this.n === CAPACIDADE) this.soltarMaisAntigo();
    this.instante[this.prox] = agoraMs;
    this.duracao[this.prox] = dt;
    this.ruim[this.prox] = ruim ? 1 : 0;
    this.soma += dt;
    if (ruim) this.ruins += 1;
    this.prox = (this.prox + 1) % CAPACIDADE;
    this.n += 1;
  }

  private soltarMaisAntigo(): void {
    this.ruins -= this.ruim[this.ini] ?? 0;
    this.soma -= this.duracao[this.ini] ?? 0;
    this.ini = (this.ini + 1) % CAPACIDADE;
    this.n -= 1;
  }

  private podar(corteMs: number): void {
    while (this.n > 0 && (this.instante[this.ini] ?? 0) < corteMs) this.soltarMaisAntigo();
  }
}

/**
 * `true` quando o `UNMASKED_RENDERER_WEBGL` denuncia rasterização por SOFTWARE.
 *
 * Aqui o problema não é o jogo: é aceleração por hardware desligada no navegador (ou um driver
 * que o Chrome pôs na lista negra). Vale dizer isso ao jogador em vez de deixá-lo achar que o
 * jogo é ruim — e vale começar já no degrau sem filtros, porque com software a cadeia cheia dá
 * 2 fps e esperar o adaptador descer sozinho é sofrimento à toa.
 */
export function ehRenderizacaoPorSoftware(renderer: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
}
