// Pós-processamento: no máximo 3 filtros fullscreen em regime estável (ajuste de cor, bloom,
// CRT sutil), só no container do mundo — nunca no HUD (DOM). ShockwaveFilter entra e sai só no
// evento de morte; RGBSplitFilter aparece ~100ms só na morte do próprio jogador.

// Fase 8 §2: o pós-processamento passou a ter NÍVEIS, escolhidos pelo tamanho do framebuffer —
// em tela cheia num monitor grande são 4× os pixels de 720p, e cada passe de tela cheia custa
// proporcional a isso.

import { AdjustmentFilter, AdvancedBloomFilter, CRTFilter, RGBSplitFilter, ShockwaveFilter } from 'pixi-filters';
import type { Filter } from 'pixi.js';

const RGB_SPLIT_S = 0.1;
const SHOCKWAVE_DURATION_S = 0.7;
const SHOCKWAVE_AMPLITUDE = 15;

// ---------------------------------------------------------------------------------------------
// O MUNDO PERDE A COR QUANDO VOCÊ MORRE (V2 §3)
//
// Eliminado, o jogador vira espectador — e a cena precisa dizer isso sem uma palavra. O efeito
// sai de GRAÇA: o `AdjustmentFilter` já está permanentemente na cadeia, então animar a saturação
// dele para perto de zero não acrescenta NENHUM passe de tela cheia e não encosta no teto de 3
// filtros do CLAUDE.md. Nenhum filtro novo entra aqui por causa disto.
//
// O HUD não é afetado por construção: os filtros vivem no container do MUNDO e o HUD é DOM por
// cima do canvas — munição, relógio e o cartão de ELIMINADO continuam coloridos.
// ---------------------------------------------------------------------------------------------

/** Saturação de regime — o mundo vivo. */
const SAT_VIVA = 1.08;
/**
 * Saturação de espectador. Não é zero absoluto de propósito: um resto mínimo de cor mantém a
 * diferença entre a bala incandescente e o piso, e quem morreu continua ACOMPANHANDO a rodada.
 */
const SAT_CINZA = 0.07;
const CONTRASTE_VIVO = 1.04;
/** Cinza puro achata a cena; um passo a mais de contraste devolve a leitura de volume. */
const CONTRASTE_CINZA = 1.14;
/**
 * Constante de tempo da drenagem de cor. τ = 0,11 s dá ~330 ms até o cinza — dentro da faixa de
 * 250–500 ms da especificação: rápido o bastante para pertencer ao instante da morte, lento o
 * bastante para o olho VER a cor indo embora em vez de levar um corte seco.
 */
const CINZA_TAU_S = 0.11;

/**
 * Qualidade do pós-processamento (Fase 8 §2).
 *
 * O custo dos filtros de tela cheia é proporcional ao número de PIXELS: em 2560×1440 são 3,7 Mpx,
 * 4× os 0,9 Mpx de 720p, e a cadeia estável já são 3 passes de tela cheia (mais 4 do blur Kawase
 * dentro do bloom). Medido num Intel Iris Xe com 8 tanques: em qualidade cheia dá 56 fps em
 * 1080p e **24 fps** em 1440p (p95 55 ms).
 *
 * A investigação percorreu as alavancas na ordem da Fase 8 e o resultado foi claro: baixar
 * `quality` do bloom de 4 para 2 e tirar o CRT levou 1440p de 24 para 28 fps — quase nada. O que
 * decide é a RESOLUÇÃO da cadeia de filtros. Por isso a regra final é um ORÇAMENTO DE PIXELS: até
 * ~2,2 Mpx nada muda (1366×768 e 1920×1080 continuam com bloom quality 4 e CRT ligado); acima
 * disso a cadeia passa a rodar na resolução que devolve ~1,95 Mpx efetivos, que é exatamente o
 * ponto em que este GPU fecha 60 fps.
 */
export type NivelFx = 'alto' | 'reduzido';

export interface Qualidade {
  nivel: NivelFx;
  /** Resolução da cadeia de filtros (1 = nativa). */
  resolucao: number;
}

interface PerfilFx {
  bloomQuality: number;
  bloomPixelSize: number;
  crt: boolean;
}

const PERFIS: Record<NivelFx, PerfilFx> = {
  alto: { bloomQuality: 4, bloomPixelSize: 1, crt: true },
  // Sem o CRT o tail melhora bastante (p99 19 ms contra 37 ms com ele ligado na mesma resolução),
  // e o ruído dele já era imperceptível numa tela desse tamanho. `pixelSize` maior compensa os
  // dois kernels de blur que saíram, mantendo o halo do bloom com a mesma largura aparente.
  reduzido: { bloomQuality: 2, bloomPixelSize: 1.6, crt: false },
};

/**
 * Acima deste framebuffer (em megapixels) a qualidade cheia deixa de fechar 60 fps.
 *
 * Medido num Intel Iris Xe com 6 bots, 25 s por amostra, contando FRAMES RUINS (acima de 33 ms)
 * em vez de média — a média mentia aqui: 1080p marcava 59,9 fps de mediana com UM QUARTO dos
 * frames engasgando, que é exatamente a sensação de "travado" que o jogador relata.
 *
 * Com o orçamento em 2,2 o 1080p (2,07 MPX) passava raspando e ficava com a cadeia CHEIA: 25,6%
 * de frames ruins. Baixando para 1,5 ele passa a usar a cadeia curta e cai para 5%.
 */
const ORCAMENTO_MPX = 1.5;
/**
 * Pixels efetivos que a cadeia passa a processar quando o orçamento estoura.
 *
 * Já esteve em 3,6 — valor escolhido para evitar amassar o piso em ultrawide, com a hipótese de
 * que a cadeia curta (~5 passes contra ~10) compensaria os pixels a mais. A medição desmentiu:
 * em 2560×1440 (3,69 MPX) o alvo 3,6 devolvia resolução 0,99, ou seja, economia nenhuma, e o
 * jogo rodava a 20 fps com 70% dos frames ruins.
 *
 * 2,2 devolve 0,77 em 1440p e restaura 59,9 fps com 7% de frames ruins. A nitidez não sofre
 * porque quem roda em resolução reduzida é só a CADEIA DE FILTROS — o mundo (tanques, paredes,
 * texto) continua sendo rasterizado em resolução cheia.
 */
const ALVO_MPX = 2.2;
/** Piso da resolução: abaixo disto a arena começa a ler como borrada, não como suave. */
const RES_MIN = 0.55;

export function qualidadePara(megapixels: number): Qualidade {
  if (megapixels <= ORCAMENTO_MPX) return { nivel: 'alto', resolucao: 1 };
  const bruta = Math.sqrt(ALVO_MPX / megapixels);
  return { nivel: 'reduzido', resolucao: Math.max(RES_MIN, Math.min(1, Math.round(bruta * 100) / 100)) };
}

export class PostFX {
  private readonly adjust: AdjustmentFilter;
  private readonly bloom: AdvancedBloomFilter;
  private readonly crt: CRTFilter;
  private readonly shockwave: ShockwaveFilter;
  private readonly rgbSplit: RGBSplitFilter;

  private shockwaveActive = false;
  private shockwaveTimeS = 0;
  private rgbSplitLeftS = 0;
  /** Alvo da drenagem de cor: `true` enquanto o jogador local está eliminado. */
  private cinza = false;
  /** 0 = mundo colorido, 1 = mundo cinza. Interpolado em tempo REAL (ver `atualizarCor`). */
  private drenagem = 0;
  private timeSec = 0;
  private listaCache: Filter[] | null = null;
  private composicaoAtual = -1;
  private prewarmLeft = 0;
  private qualidade: Qualidade = { nivel: 'alto', resolucao: 1 };

  constructor() {
    this.adjust = new AdjustmentFilter({ saturation: SAT_VIVA, contrast: CONTRASTE_VIVO });
    // Mundo claro pesa MUITO mais no bloom: com threshold baixo, o piso inteiro entrava no filtro
    // e a tela estourava. Só o que é realmente incandescente (núcleo da bala, clarão, explosão)
    // fica acima de 0,88 — o resto passa limpo.
    this.bloom = new AdvancedBloomFilter({ threshold: 0.88, bloomScale: 0.42, blur: 5, quality: 4 });
    // vignetting zerado: nada de gradiente escuro nas bordas — a arena tem que ler de canto a canto.
    this.crt = new CRTFilter({
      lineWidth: 0,
      curvature: 0,
      noise: 0.022,
      noiseSize: 1.2,
      vignetting: 0,
      vignettingAlpha: 0,
    });
    this.shockwave = new ShockwaveFilter({
      center: { x: 0, y: 0 },
      speed: 760,
      amplitude: SHOCKWAVE_AMPLITUDE,
      wavelength: 120,
      radius: 300,
      time: 0,
    });
    this.rgbSplit = new RGBSplitFilter({ red: { x: 0, y: 0 }, green: { x: 0, y: 0 }, blue: { x: 0, y: 0 } });
  }

  /**
   * Aplica uma qualidade. O Pixi resolve a resolução da cadeia pelo MENOR `resolution` entre os
   * filtros aplicados (`FilterSystem._calculateFilterArea`), então todos recebem o mesmo valor —
   * pôr só um em 0,75 arrastaria a cadeia inteira junto de qualquer jeito, e explicitar evita a
   * surpresa.
   */
  aplicarQualidade(q: Qualidade): void {
    if (q.nivel === this.qualidade.nivel && q.resolucao === this.qualidade.resolucao) return;
    this.qualidade = q;
    const perfil = PERFIS[q.nivel];
    this.bloom.quality = perfil.bloomQuality;
    this.bloom.pixelSize = perfil.bloomPixelSize;
    for (const f of [this.adjust, this.bloom, this.crt, this.shockwave, this.rgbSplit]) {
      f.resolution = q.resolucao;
    }
    // Força a remontagem da lista no próximo `get filters` (o CRT entra e sai por nível).
    this.composicaoAtual = -1;
    this.listaCache = null;
  }

  get qualidadeAtual(): Qualidade {
    return this.qualidade;
  }

  /**
   * Roda o shockwave e o RGB split por alguns frames com amplitude ZERO, logo depois do boot.
   *
   * Esses dois filtros só entram na cadeia quando alguém morre. A PRIMEIRA vez que isso acontece
   * o driver compila o shader e o Pixi pede um render target novo para o passe extra — custo que
   * cai inteiro no frame da explosão, justamente o frame mais cheio do jogo. Pagando aqui, na
   * tela de entrada, o frame da morte já encontra tudo quente. Visualmente é nulo: amplitude 0 e
   * deslocamentos 0 fazem os dois passes serem identidade. (Investigação §5 da Fase 4: os frames
   * longos que sobraram caíam sobre eventos de morte.)
   */
  prewarm(frames = 4): void {
    this.prewarmLeft = frames;
    this.shockwave.amplitude = 0;
  }

  triggerShockwave(x: number, y: number): void {
    this.shockwave.center = { x, y };
    this.shockwave.time = 0;
    this.shockwave.amplitude = SHOCKWAVE_AMPLITUDE;
    this.shockwaveTimeS = 0;
    this.shockwaveActive = true;
  }

  /** ~100ms de aberração cromática — só na morte do próprio jogador local (autogol incluso). */
  triggerSelfDeathGlitch(): void {
    this.rgbSplitLeftS = RGB_SPLIT_S;
  }

  /**
   * Liga/desliga o mundo cinza (V2 §3). Idempotente: quem chama pode repetir o mesmo valor todo
   * frame — é exatamente o que o `Renderer.sync()` faz, já que ele deriva o estado do `alive` do
   * meu tanque em vez de guardar um sinal próprio.
   */
  setMundoCinza(cinza: boolean): void {
    this.cinza = cinza;
  }

  /**
   * Avança a drenagem de cor. Recebe `dt` de tempo REAL, não o do hitstop: a morte dispara 60 ms
   * de congelamento e, com o relógio do mundo, a cor ficaria parada justamente no instante em que
   * ela precisa começar a sair.
   *
   * Sai cedo quando já chegou no alvo — no regime normal do jogo isto é uma comparação por frame
   * e o filtro nem chega a ser tocado.
   */
  atualizarCor(dtRealS: number): void {
    const alvo = this.cinza ? 1 : 0;
    if (this.drenagem === alvo) return;
    this.drenagem += (alvo - this.drenagem) * (1 - Math.exp(-dtRealS / CINZA_TAU_S));
    if (Math.abs(alvo - this.drenagem) < 0.002) this.drenagem = alvo;
    const k = this.drenagem;
    this.adjust.saturation = SAT_VIVA + (SAT_CINZA - SAT_VIVA) * k;
    this.adjust.contrast = CONTRASTE_VIVO + (CONTRASTE_CINZA - CONTRASTE_VIVO) * k;
  }

  update(dtSeconds: number): void {
    if (this.prewarmLeft > 0) this.prewarmLeft -= 1;
    this.timeSec += dtSeconds;
    this.crt.time = this.timeSec;
    this.crt.seed = (this.timeSec * 7) % 1;

    if (this.shockwaveActive) {
      this.shockwaveTimeS += dtSeconds;
      this.shockwave.time = this.shockwaveTimeS;
      if (this.shockwaveTimeS > SHOCKWAVE_DURATION_S) this.shockwaveActive = false;
    }

    if (this.rgbSplitLeftS > 0) {
      this.rgbSplitLeftS = Math.max(0, this.rgbSplitLeftS - dtSeconds);
      const k = this.rgbSplitLeftS / RGB_SPLIT_S;
      this.rgbSplit.red = { x: -5 * k, y: 0 };
      this.rgbSplit.blue = { x: 5 * k, y: 0 };
    } else {
      this.rgbSplit.red = { x: 0, y: 0 };
      this.rgbSplit.blue = { x: 0, y: 0 };
    }
  }

  /**
   * A lista é montada só quando a COMPOSIÇÃO muda (shockwave/rgbSplit entrando ou saindo) — nos
   * outros frames devolve exatamente o mesmo array. Antes um array novo saía daqui 60×/s e o
   * `Renderer` o atribuía a `world.filters` em todo frame, o que faz o Pixi reconstruir o efeito
   * de filtro do render group sem nenhuma mudança real. Quem chama compara por identidade e só
   * reatribui quando o valor muda de verdade.
   */
  get filters(): Filter[] {
    const aquecendo = this.prewarmLeft > 0;
    const usaRgb = this.rgbSplitLeftS > 0 || aquecendo;
    const usaShock = this.shockwaveActive || aquecendo;
    const composicao = (usaRgb ? 1 : 0) | (usaShock ? 2 : 0);
    if (composicao !== this.composicaoAtual || this.listaCache === null) {
      this.composicaoAtual = composicao;
      const list: Filter[] = [];
      if (usaRgb) list.push(this.rgbSplit);
      if (usaShock) list.push(this.shockwave);
      list.push(this.adjust, this.bloom);
      if (PERFIS[this.qualidade.nivel].crt) list.push(this.crt);
      this.listaCache = list;
    }
    return this.listaCache;
  }

  destroy(): void {
    this.adjust.destroy();
    this.bloom.destroy();
    this.crt.destroy();
    this.shockwave.destroy();
    this.rgbSplit.destroy();
  }
}
