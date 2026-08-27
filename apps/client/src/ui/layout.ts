// Escala e reservas de espaço do HUD em tela cheia (Fase 8).
//
// O jogo passou a ocupar a janela inteira, de 1366×768 a 2560×1440 e além. Duas coisas precisam
// crescer junto — e com contenção, senão em 1440p o HUD vira outdoor:
//
//   1. os TAMANHOS do HUD (DOM): saem daqui como a variável CSS `--k`, que o style.css multiplica
//      em cada medida (`calc(var(--k) * 42px)`). Uma variável só, um ponto de verdade;
//   2. as RESERVAS de tela (px) que o `fitCamera` do Renderer subtrai antes de escalar a arena —
//      elas TÊM que sair do mesmo `k`, senão a faixa reservada e o painel desenhado divergem.
//
// Não há reserva lateral: com o placar fora de cena durante a ação (§6 da Fase 8) a arena é
// limitada pela ALTURA em qualquer tela 16:9 ou mais larga, e as sobras laterais que aparecem
// sozinhas são exatamente onde munição e killfeed moram.

/** Altura de referência do desenho original do HUD (o layout da Fase 6 foi feito em 900p). */
const ALTURA_BASE = 900;
const K_MIN = 0.82;
/**
 * Piso do `k` no CELULAR (M1). Um aparelho deitado tem ~390 px de altura: com o piso de desktop
 * (0,82) a placa do relógio sozinha comeria 80 px, mais de 20% da tela. 0,6 é o menor valor em
 * que o número do relógio continua legível a um braço de distância — abaixo disso o HUD começa a
 * mentir sobre o próprio tamanho.
 */
const K_MIN_TOQUE = 0.6;
const K_MAX = 1.5;

export interface Reservas {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Modo toque (M1). Muda DUAS coisas e só elas: o piso do `k` e as faixas LATERAIS, que no
 * desktop são zero. Nada aqui roda em teclado — a restrição 1 da M1 é não regredir o desktop.
 */
let modoToque = false;

export function definirModoToque(ligado: boolean): void {
  modoToque = ligado;
}

export function emModoToque(): boolean {
  return modoToque;
}

/** Fator de escala do HUD para uma janela — cresce com a altura, mas nunca fora de [piso; 1,5]. */
export function escalaHud(alturaTela: number): number {
  const bruto = alturaTela / ALTURA_BASE;
  const piso = modoToque ? K_MIN_TOQUE : K_MIN;
  return Math.min(K_MAX, Math.max(piso, Math.round(bruto * 1000) / 1000));
}

/**
 * Raio do analógico virtual, em px CSS. Repetido de `input/toque.ts` de propósito: a FAIXA
 * lateral que a arena cede precisa sair da mesma conta que desenha o controle, senão a arena
 * cede espaço demais (desperdício) ou de menos (o polegar volta a tapar o labirinto).
 */
function raioDoAnalogico(larguraTela: number, alturaTela: number): number {
  return Math.round(Math.min(62, Math.max(42, Math.min(larguraTela, alturaTela) * 0.15)));
}

/**
 * Faixa lateral reservada a cada polegar no modo toque; 0 no desktop.
 *
 * A conta é o DIÂMETRO do analógico mais a folga da borda: com ela, o controle em posição de
 * DESCANSO (canto de baixo, onde o polegar cai sozinho) fica inteiro fora do labirinto. O
 * analógico ainda nasce onde o dedo tocar — quem escolher pousar o polegar no meio da arena vai
 * tapar a arena, e isso é escolha de quem joga; o que o layout garante é que existe um lugar
 * confortável que NÃO tapa nada.
 *
 * O teto de 18% da largura existe para telas estreitas (celular pequeno deitado, 667 px): sem
 * ele as duas faixas comeriam 40% da tela e sobraria uma arena de selo.
 */
function faixaDoPolegar(larguraTela: number, alturaTela: number): number {
  if (!modoToque) return 0;
  const raio = raioDoAnalogico(larguraTela, alturaTela);
  return Math.round(Math.min(larguraTela * 0.18, raio * 2 + 20));
}

/**
 * Publica `--k` no `:root`. Chamado a cada resize; só escreve quando o valor muda de verdade,
 * porque mexer numa custom property do `:root` invalida o estilo da página inteira.
 */
let kAplicado = -1;
export function aplicarEscalaHud(alturaTela: number): number {
  const k = escalaHud(alturaTela);
  if (k !== kAplicado) {
    kAplicado = k;
    document.documentElement.style.setProperty('--k', String(k));
  }
  return k;
}

/**
 * Faixas de tela que a arena NÃO ocupa.
 *
 * Desde a Fase 9 o labirinto NASCE na proporção desta área (ver `aspectoDaArena` abaixo), então a
 * arena encosta nos dois eixos em vez de deixar faixa morta nas laterais. O que sobra é a folga de
 * `margin` do `fitCamera` — e é sobre ela que munição e killfeed flutuam, que é o motivo de os
 * dois terem virado overlays translúcidos e não colunas fixas. Só o RELÓGIO, centralizado no topo
 * e sem margem para onde ir, tem faixa própria; embaixo fica uma folga fina para o bloco de
 * munição não encostar na parede de baixo.
 *
 * A reserva é a MESMA em todas as fases, de propósito. Soltá-la fora da ação (lobby, fim de
 * rodada) deixaria a arena ~8% maior e a troca de fase daria um pulo de zoom bem visível na arena
 * que continua rodando ao fundo — exatamente o "piscar" que a Fase 8 §6 manda evitar.
 */
export function reservasDoJogo(alturaTela: number, larguraTela = alturaTela * 2): Reservas {
  const k = escalaHud(alturaTela);
  const lado = faixaDoPolegar(larguraTela, alturaTela);
  // 98 px (Fase 10) contra os 70 px anteriores: a placa do relógio ficou maior de propósito — é
  // ela que o usuário pediu como "a informação mais legível da tela depois da arena" —, e a faixa
  // TEM que acompanhar o desenho, senão o número volta a cavalgar a parede do labirinto. A conta
  // é o alto da placa (4 + rótulo + número + barra + folga + contorno ≈ 88) mais os 10 px em que
  // ela flutua. A pastilha de VIVOS continua de fora da conta, junto com killfeed e munição.
  return { top: Math.round(98 * k), right: lado, bottom: Math.round(26 * k), left: lado };
}

/**
 * Proporção (largura/altura) da área que a arena realmente pode ocupar — a janela MENOS as faixas
 * reservadas acima. É este número, e não `innerWidth / innerHeight`, que a Fase 9 usa para
 * escolher a forma do labirinto: em 1920×1080 a janela é 1,78 mas a área jogável é ~1,99, e um
 * labirinto gerado em 1,78 deixaria justamente a faixa morta nas laterais que o usuário reclamou.
 *
 * Quem consome isto manda o valor para o SERVIDOR (canal `viewport`); é ele que combina uma
 * proporção só para a sala inteira. Nunca gere o labirinto direto deste número.
 */
export function aspectoDaArena(larguraTela: number, alturaTela: number): number {
  const { top, right, bottom, left } = reservasDoJogo(alturaTela, larguraTela);
  const largura = Math.max(1, larguraTela - left - right);
  const altura = Math.max(1, alturaTela - top - bottom);
  return largura / altura;
}
