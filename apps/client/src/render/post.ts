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

/** Acima deste framebuffer (em megapixels) a qualidade cheia deixa de fechar 60 fps. */
const ORCAMENTO_MPX = 2.2;
/**
 * Pixels efetivos que a cadeia passa a processar quando o orçamento estoura.
 *
 * Não é o mesmo número de `ORCAMENTO_MPX` porque, ao cair para `reduzido`, a cadeia fica quase
 * pela METADE: o CRT sai (um passe cheio a menos) e o bloom vai de `quality` 4 para 2, o que
 * corta quatro dos oito passes de blur. Sobram ~5 passes contra ~10. Manter o alvo em 1,95 MPX
 * (o que se pagava com a cadeia CHEIA) jogava a resolução para 0,63 em 3440×1440 — e a Fase 9,
 * que fez a arena preencher a tela inteira, deixou esse amassado óbvio no piso. 3,6 MPX é
 * aproximadamente o mesmo custo de GPU com a cadeia curta, com margem.
 */
const ALVO_MPX = 3.6;
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
  private timeSec = 0;
  private listaCache: Filter[] | null = null;
  private composicaoAtual = -1;
  private prewarmLeft = 0;
  private qualidade: Qualidade = { nivel: 'alto', resolucao: 1 };

  constructor() {
    this.adjust = new AdjustmentFilter({ saturation: 1.08, contrast: 1.04 });
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
