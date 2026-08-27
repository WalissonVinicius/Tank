// Camada visual dos power-ups (P1 + P2): a CHEGADA do item de paraquedas, o item no chão, o
// crachá de quem está sob efeito e o pop da coleta. Tudo procedural, como o resto da arena —
// nenhum arquivo de imagem.
//
// A HIERARQUIA VISUAL É O REQUISITO, e ela decide os números daqui. A bala tem 19,2 px e o tanque
// 37 px; o item fica no meio, a 30 px, e resolve isso de dois jeitos ao mesmo tempo: é maior que a
// bala (então lê de relance) e é o único elemento da arena que FLUTUA e GIRA (então nunca é
// confundido com um projétil, que anda reto e rápido). Glow ele tem, e pode ter: é a regra do
// projeto, glow só no que emite luz.
//
// A cor vem do tipo do efeito, mas o que IDENTIFICA é o símbolo. As dez cores de jogador já
// ocupam a roda inteira de matizes, então mais uma cor não seria distinguível — o zigue-zague do
// ricochete, sim.
//
// A QUEDA (P2) é animação e nada mais, e é lida do TICK DA RODADA — nunca de um relógio local.
// `restante` vale `(sumeEmTick - tick) / TICK_HZ`, então `restante - POWERUP_VIDA_NO_MAPA_S` é
// exatamente o que falta para o item POUSAR, e é o mesmo número em todos os clientes no mesmo
// tick. A janela de queda é uma ANTECIPAÇÃO — o item aparece no céu 2,5 s ANTES do `nasceEmTick` e
// toca o chão exatamente nele —, então a disponibilidade não mudou um tick sequer em relação a
// antes de o paraquedas existir e ninguém arranca o item do ar (ver `caindo()` em
// shared-sim/powerups.ts).

import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import {
  POWERUP,
  POWERUP_QUEDA_S,
  POWERUP_RAIO,
  POWERUP_VIDA_NO_MAPA_S,
  type TipoPowerUp,
} from '@tank/protocol';
import type { GameTextures } from './textures.js';
import { darken, mixColor } from './color.js';

/** Raio do disco desenhado. Bate com `POWERUP_RAIO` (colisão): o que se vê é o que se pega. */
const RAIO = POWERUP_RAIO;
/** Amplitude da flutuação vertical, em px. */
const BOB = 4;
/** Ciclos de flutuação por segundo. */
const BOB_HZ = 0.6;
/** Voltas por segundo do anel externo. */
const GIRO_HZ = 0.18;
/** Duração da animação de entrada de quem NÃO chegou de paraquedas, em segundos. */
const ENTRADA_S = 0.32;
/** Nos últimos segundos de vida o item pisca — some por tempo, mas avisa antes. */
const AVISO_S = 2.2;
/** Piscadas por segundo durante o aviso. */
const AVISO_HZ = 4;
/** Duração do pop de coleta/expiração, em segundos. */
const POP_S = 0.42;

const TAU = Math.PI * 2;
/** Opacidade de pico da poeira do pouso. */
const POEIRA_ALPHA = 0.7;
/** Duração do anel de poeira que abre no toque, em segundos. */
const IMPACTO_S = 0.42;
/** Raio de referência do anel de impacto, em px. */
const IMPACTO_RAIO = 26;
/** O mesmo quase-preto de contorno de `animais.ts` — é a gramática de desenho da casa. */
const TRACO = 0x0b0f1a;

// ---------------------------------------------------------------------------------------------
// A chegada de paraquedas (P2)
// ---------------------------------------------------------------------------------------------

/**
 * Altura do ponto de largada, em px de mundo (~1,5 célula).
 *
 * Foi 200 na primeira passada e era demais: um item sorteado na fileira de cima nascia FORA da
 * arena, sobre a moldura preta e por baixo do HUD, e metade da queda acontecia num lugar onde
 * não há chão para ler. Metade da altura virou deslocamento e a outra metade virou ESCALA (ver
 * `VOO_ESCALA`): em top-down, o que está mais alto está mais perto da câmera, e crescer diz
 * "alto" sem sair do enquadramento.
 */
const ALTURA = 130;
/** Quanto o conjunto cresce no ponto mais alto — a outra metade da leitura de altura. */
const VOO_ESCALA = 0.45;
/** Fração da queda gasta abrindo a copa. Antes disso o item despenca — é o que dá peso a ele. */
const ABRE = 0.14;
/** Quanto da altura se perde durante essa abertura. */
const DESPENCA = 0.2;
/** Meia-largura da copa. 64 px de boca contra 30 px de item: o paraquedas é quem chama a atenção. */
const COPA_W = 32;
/** Altura de referência da abóbada — o ápice do bezier sai em ~1,2×. */
const COPA_H = 21;
/** Da boca da copa até o nó onde os tirantes se juntam. */
const NO = 10;
/** Comprimento do cabo entre o nó e o item. Folgado: cabo curto cola o item no pano. */
const CABO = 32;
/** Ciclos de balanço por segundo. Devagar: é carga pesada descendo, não pêndulo de relógio. */
const BALANCO_HZ = 0.42;
/** Deriva lateral da copa, em px. */
const BALANCO_PX = 26;
/**
 * ATRASO de fase do item em relação à copa, em radianos.
 *
 * É o truque inteiro. Se o item balançasse em fase com o pano os dois seriam UM desenho rígido;
 * chegando ao extremo do balanço um quinto de ciclo DEPOIS, o olho preenche sozinho a corda e o
 * peso que a física teria.
 */
const ATRASO = 1.15;
/** Amplitude angular do cabo, em radianos. */
const CABO_ANG = 0.34;
/** Inclinação máxima do pano, em radianos. */
const COPA_ANG = 0.16;
/** Duração do sobressalto de escala no pouso, em segundos. */
const POUSO_S = 0.34;
/** Duração da solta do paraquedas depois do pouso, em segundos. */
const SOLTA_S = 0.8;
/** Sombra do item POUSADO, em px. Elipse, na mesma proporção da do tanque (58×44). */
const SOMBRA_W = 34;
const SOMBRA_H = 26;
/** Quanto a sombra cresce no ponto mais alto da queda. */
const SOMBRA_ALTO = 2.6;
/** Opacidade da sombra do item pousado — o fim da linha do "encolhendo e escurecendo". */
const SOMBRA_ALPHA = 0.46;
/**
 * Opacidade lá no alto. Começou em 0,16 e some: um radial de 100 px a 16% desaparece no ruído
 * do piso, e sem sombra visível a queda não diz ONDE vai cair, que é a única coisa que ela
 * precisa dizer. O "difusa" da leitura vem do TAMANHO (3,6× no ápice), não da transparência.
 */
const SOMBRA_ALPHA_ALTO = 0.28;

/**
 * Progresso da queda: 0 recém-largado no céu, 1 pousado.
 *
 * Derivado do TICK, via `restante`. Um cliente que entra no meio da queda cai no mesmo ponto da
 * animação que os outros, e um cliente que só enxerga o item depois do pouso recebe 1 e nunca
 * desenha paraquedas nenhum.
 */
function progressoDaQueda(restante: number): number {
  const paraPousar = restante - POWERUP_VIDA_NO_MAPA_S;
  if (!(paraPousar > 0)) return 1;
  return Math.max(0, 1 - paraPousar / POWERUP_QUEDA_S);
}

/** Altura normalizada já percorrida: despenca até a copa abrir, depois desce em ritmo constante. */
function descida(p: number): number {
  if (p < ABRE) return (p / ABRE) * DESPENCA;
  return DESPENCA + (1 - DESPENCA) * ((p - ABRE) / (1 - ABRE));
}

/**
 * A copa, na gramática de `animais.ts`: silhueta CHEIA na cor do efeito, contorno escuro grosso,
 * detalhe interno escuro. Boca ondulada em três lóbulos — é a ondulação que diz "pano" no tamanho
 * em que isto chega à tela de um celular.
 *
 * Origem em (0,0) na BOCA da copa; a abóbada sobe em y negativo e os tirantes descem até o nó.
 */
function desenharCopa(g: Graphics, cor: number): void {
  const W = COPA_W;
  const H = COPA_H;
  g.moveTo(-W, 0)
    .bezierCurveTo(-W * 1.08, -H * 1.6, W * 1.08, -H * 1.6, W, 0)
    .quadraticCurveTo(W * 0.66, 7, W * 0.33, 0)
    .quadraticCurveTo(0, 7, -W * 0.33, 0)
    .quadraticCurveTo(-W * 0.66, 7, -W, 0)
    .fill({ color: cor })
    .stroke({ width: 3.4, color: TRACO, join: 'round' });

  // Gomos: as duas costuras que separam o pano em três e dão volume a uma cor chapada.
  g.moveTo(-W * 0.33, -1)
    .quadraticCurveTo(-W * 0.46, -H * 0.8, 0, -H * 1.2)
    .moveTo(W * 0.33, -1)
    .quadraticCurveTo(W * 0.46, -H * 0.8, 0, -H * 1.2)
    .stroke({ width: 2.2, color: darken(cor, 0.42), alpha: 0.85 });

  // Tirantes: da boca até o nó de onde sai o cabo.
  g.moveTo(-W * 0.94, -0.5)
    .lineTo(0, NO)
    .moveTo(W * 0.94, -0.5)
    .lineTo(0, NO)
    .moveTo(-W * 0.36, 1.5)
    .lineTo(0, NO)
    .moveTo(W * 0.36, 1.5)
    .lineTo(0, NO)
    .stroke({ width: 1.5, color: TRACO, alpha: 0.9, cap: 'round' });
}

/**
 * A poeira do toque no chão. Pool minúsculo e LOCAL: 14 sprites, uma vez por item que pousa, com
 * no máximo 3 itens no ar ao mesmo tempo. Não vai ao `ParticleSystem` porque a camada de itens não
 * o enxerga, e ~36 sprites por rodada não justificam abrir essa dependência.
 */
class Poeira {
  readonly container = new Container();
  private readonly vivos: { s: Sprite; vx: number; vy: number; vida: number; max: number; base: number }[] = [];

  constructor(private readonly textura: Texture) {}

  estourar(): void {
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU + Math.random() * 0.5;
      // Rápida e para FORA: a 60 px/s a poeira morria embaixo do disco do item, que tem 30 px
      // de largura e um halo por cima. Ela só existe se escapar dele.
      const v = 110 + Math.random() * 90;
      const base = 10 + Math.random() * 8;
      const s = new Sprite(this.textura);
      s.anchor.set(0.5);
      s.position.set(Math.cos(a) * 9, Math.sin(a) * 5);
      s.width = base;
      s.height = base;
      // Poeira do piso pegando a luz quente da arena: cinza-ardósia puxando para o âmbar.
      s.tint = mixColor(0x9aa6c4, 0xffb347, Math.random() * 0.45);
      s.alpha = POEIRA_ALPHA;
      this.container.addChild(s);
      const vida = 0.42 + Math.random() * 0.3;
      // O `* 0.42` no eixo Y achata o estouro contra o chão: em top-down, poeira se espalha no
      // plano do piso, não sobe para a câmera.
      this.vivos.push({ s, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.42, vida, max: vida, base });
    }
  }

  update(dt: number): void {
    for (let i = this.vivos.length - 1; i >= 0; i--) {
      const p = this.vivos[i]!;
      p.vida -= dt;
      if (p.vida <= 0) {
        p.s.destroy();
        this.vivos.splice(i, 1);
        continue;
      }
      const t = 1 - p.vida / p.max;
      p.s.x += p.vx * dt;
      p.s.y += p.vy * dt;
      const arrasto = 1 - 4.2 * dt;
      p.vx *= arrasto;
      p.vy *= arrasto;
      const tam = p.base * (1 + t * 1.6);
      p.s.width = tam;
      p.s.height = tam;
      p.s.alpha = (1 - t) * POEIRA_ALPHA;
    }
  }
}

/**
 * O símbolo dentro do item. Regra que guiou o desenho: **citar o que o jogador já conhece**, em
 * vez de inventar vocabulário novo num quadradinho de 20 px.
 *
 * Há precedente registrado neste projeto: um ícone ao lado dos pips de munição fez o dono ler
 * "2 tipos de munição" (ver o comentário no topo de `ui/hud.ts`), e a correção foi trocar pelo
 * que o HUD já mostrava. A primeira versão do símbolo de munição aqui repetiu o mesmo erro —
 * dois círculos com tracinhos, que o dono leu como "nem dá para entender o que é".
 */
function desenharSimbolo(g: Graphics, tipo: TipoPowerUp, cor: number): void {
  const l = 2.6;
  switch (tipo) {
    // Ricochete DUPLO: a bala batendo em DUAS paredes. O número de quinas é a informação, e os
    // tracinhos curtos nas quinas são as paredes — sem eles o zigue-zague vira só um raio.
    case 'ricochete':
      g.moveTo(-8, 4).lineTo(-2.5, -4).lineTo(3, 3).lineTo(8, -3.5)
        .stroke({ width: l, color: cor, cap: 'round', join: 'round' });
      // Os DOIS pontos de impacto, marcados por bolinhas. Tentei desenhar as paredes como
      // tracinhos e ficou pior nas duas vezes: longe das quinas liam como enfeite, e encostadas
      // atravessavam o zigue-zague e embaralhavam a leitura. O ponto diz "bateu aqui" sem
      // acrescentar linha nenhuma.
      g.circle(-2.5, -4, 2).circle(3, 3, 2).fill({ color: cor });
      break;
    // Munição: a MESMA silhueta de cartucho que o HUD mostra (topo arredondado, base quase reta —
    // ver `#hud-municao .marcas i`, que é 22x32 com raio 11/11/5/5), mais um "+" gordo. O jogador
    // olha para essa forma a partida inteira; é ela que significa munição para ele.
    case 'municao': {
      const w = 6.4;
      const h = 12;
      const x = -8.5;
      const y = -6;
      g.moveTo(x, y + h)
        .lineTo(x, y + w * 0.55)
        .quadraticCurveTo(x, y, x + w / 2, y)
        .quadraticCurveTo(x + w, y, x + w, y + w * 0.55)
        .lineTo(x + w, y + h)
        .closePath()
        .fill({ color: cor });
      // O "+" fica à direita, na altura do meio do cartucho: lê como "mais uma dessas".
      g.moveTo(3.5, 0).lineTo(9.5, 0).moveTo(6.5, -3).lineTo(6.5, 3)
        .stroke({ width: 2.9, color: cor, cap: 'round' });
      break;
    }
    // Recarga: relâmpago. Velocidade de cadência, não de deslocamento.
    case 'recarga':
      g.poly([1, -8, -5, 0.5, -0.5, 0.5, -2, 8, 5, -0.5, 0.5, -0.5]).fill({ color: cor });
      break;
    // Turbo: chevron duplo apontando para a frente.
    case 'turbo':
      g.moveTo(-6, -5).lineTo(-1, 0).lineTo(-6, 5).stroke({ width: l, color: cor, cap: 'round', join: 'round' });
      g.moveTo(1, -5).lineTo(6, 0).lineTo(1, 5).stroke({ width: l, color: cor, cap: 'round', join: 'round' });
      break;
  }
}

/** Um item: a chegada de paraquedas e, depois dela, a vida dele no chão. */
class ItemView {
  readonly root = new Container();
  private readonly sombra: Sprite;
  private readonly halo: Sprite;
  /** Anel + corpo: o item propriamente dito, o que sobe, balança e se esmaga no pouso. */
  private readonly conjunto = new Container();
  private readonly anel = new Graphics();
  private readonly corpo = new Graphics();
  private readonly poeira: Poeira;
  /** Copa + cabo. Existe só até o paraquedas se soltar depois do pouso. */
  private paraquedas: Container | null = null;
  private copa: Graphics | null = null;
  private cabo: Graphics | null = null;
  /** Anel de poeira do toque. Só existe para quem chegou de paraquedas. */
  private impacto: Graphics | null = null;
  /** >= 0 enquanto o anel de impacto abre. */
  private impactoT = -1;
  /** Idade NO CHÃO. Só começa a correr depois do pouso. */
  private idade = 0;
  /** Progresso da queda no frame anterior — é a borda dele para 1 que dispara o pouso. */
  private queda: number;
  private readonly chegouDoCeu: boolean;
  /** Última deriva lateral da copa: decide para que lado o paraquedas esvoaça ao se soltar. */
  private deriva = 0;
  /** >= 0 enquanto o sobressalto do pouso roda. */
  private pouso = -1;
  /** >= 0 enquanto o paraquedas solto esvoaça. */
  private solta = -1;
  /** >= 0 enquanto o pop de saída roda; ao chegar a `POP_S` a view pode ser destruída. */
  private saindo = -1;
  private popForte = false;

  constructor(
    readonly id: number,
    readonly tipo: TipoPowerUp,
    x: number,
    y: number,
    restante: number,
    textures: GameTextures,
  ) {
    const cor = POWERUP[tipo].cor;

    // A SOMBRA É O QUE DENUNCIA A CHEGADA: grande e difusa lá no alto, pequena e fechada no chão.
    // Sem ela ninguém sabe ONDE o item vai cair, e a queda vira enfeite em vez de corrida.
    this.sombra = new Sprite(textures.shadow);
    this.sombra.anchor.set(0.5);
    this.sombra.width = SOMBRA_W;
    this.sombra.height = SOMBRA_H;
    this.sombra.alpha = SOMBRA_ALPHA;

    // Halo aditivo por baixo: o item é uma fonte de luz na arena escura, e é ele que o torna
    // visível pelo canto do olho a meia tela de distância.
    this.halo = new Sprite(textures.glow);
    this.halo.anchor.set(0.5);
    this.halo.width = RAIO * 5;
    this.halo.height = RAIO * 5;
    this.halo.tint = cor;
    this.halo.alpha = 0.3;
    this.halo.blendMode = 'add';

    // Disco de base ESCURO com contorno na cor: sem ele o símbolo se dissolveria no piso, e com
    // um disco chapado colorido o item competiria com os tanques em vez de se distinguir deles.
    this.corpo
      .circle(0, 0, RAIO)
      .fill({ color: darken(cor, 0.82) })
      .circle(0, 0, RAIO)
      .stroke({ width: 2.2, color: cor, alpha: 0.9 });
    desenharSimbolo(this.corpo, tipo, cor);

    // Anel externo tracejado, o que gira. Quatro arcos curtos bastam para a rotação ser legível.
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      this.anel.arc(0, 0, RAIO + 4.5, a, a + Math.PI / 4).stroke({ width: 2, color: cor, alpha: 0.7, cap: 'round' });
    }
    this.conjunto.addChild(this.anel, this.corpo);

    this.poeira = new Poeira(textures.dot);
    this.root.addChild(this.sombra, this.halo, this.poeira.container, this.conjunto);
    this.root.position.set(x, y);

    this.queda = progressoDaQueda(restante);
    this.chegouDoCeu = this.queda < 1;
    if (this.chegouDoCeu) {
      this.montarParaquedas(cor);
      this.aplicarQueda(this.queda);
    } else {
      this.conjunto.scale.set(0);
    }
  }

  private montarParaquedas(cor: number): void {
    // Anel de poeira do toque: cinza-ardósia e SEM glow, porque poeira não emite luz — a regra
    // do projeto reserva o halo para quem é fonte. Desenhado uma vez, achatado no plano do
    // chão, e depois só a escala anima.
    const impacto = new Graphics();
    impacto.circle(0, 0, IMPACTO_RAIO).stroke({ width: 5, color: 0x9aa6c4, alpha: 0.55 });
    impacto.scale.set(1, 0.62);
    impacto.visible = false;
    this.impacto = impacto;
    this.root.addChildAt(impacto, this.root.children.indexOf(this.poeira.container));

    const copa = new Graphics();
    desenharCopa(copa, cor);
    const cabo = new Graphics();
    cabo.moveTo(0, 0).lineTo(0, CABO).stroke({ width: 2.2, color: TRACO, cap: 'round' });
    const conjunto = new Container();
    // Cabo por baixo do pano: assim a copa cobre o nó e o encontro dos dois desenhos some.
    conjunto.addChild(cabo, copa);
    this.paraquedas = conjunto;
    this.copa = copa;
    this.cabo = cabo;
    // Por último no root: está no alto do mundo, e por isso passa por cima do que está no chão.
    this.root.addChild(conjunto);
  }

  /** Começa o pop de saída. `pego` deixa o estouro mais forte que o sumiço por tempo. */
  sair(pego: boolean): void {
    if (this.saindo >= 0) return;
    this.saindo = 0;
    this.popForte = pego;
    // A sombra não acompanha o estouro: sombra que incha é sombra que virou objeto.
    this.sombra.visible = false;
  }

  /**
   * Um quadro da queda. TUDO aqui sai de `p`, que veio do tick — nenhum `dt` acumulado —, então
   * dois clientes com fps diferentes desenham o paraquedas no mesmo lugar no mesmo tick.
   */
  private aplicarQueda(p: number): void {
    const t = p * POWERUP_QUEDA_S;
    const altura = ALTURA * (1 - descida(p));
    /** 1 no alto, 0 no chão — é ele que comanda sombra e halo. */
    const h = altura / ALTURA;

    // O balanço morre ANTES do toque. É o que garante que o item pouse exatamente no ponto de
    // nascimento sorteado pela seed, e não a alguns pixels dele.
    const fade = Math.min(1, (1 - p) * 3.2);
    const fase = t * TAU * BALANCO_HZ;
    const copaX = Math.sin(fase) * BALANCO_PX * fade;
    const copaAng = Math.sin(fase) * COPA_ANG * fade;
    const caboAng = Math.sin(fase - ATRASO) * CABO_ANG * fade;

    // O conjunto inteiro cresce com a altura, e o nó e o cabo crescem JUNTO. O cabo desenhado
    // vive DENTRO do paraquedas (já escalado) e o item é posicionado em coordenadas de mundo:
    // sem multiplicar os comprimentos pela mesma escala, o cabo descolaria do item.
    const esc = 1 + h * VOO_ESCALA;
    const noLocalX = -Math.sin(copaAng) * NO;
    const noLocalY = Math.cos(copaAng) * NO;
    const noX = copaX + noLocalX * esc;
    const itemX = noX - Math.sin(caboAng) * CABO * esc;
    const itemY = -altura;
    // A cadeia é montada de baixo para cima: o item TEM de terminar em `-altura`, então a copa
    // fica onde o cabo e os tirantes a colocam a partir dali.
    const copaY = itemY - Math.cos(caboAng) * CABO * esc - noLocalY * esc;

    this.deriva = copaX;
    this.conjunto.position.set(itemX, itemY);
    this.conjunto.scale.set(esc);
    this.conjunto.rotation = caboAng * 0.6;
    this.anel.rotation = t * TAU * GIRO_HZ;

    if (this.paraquedas && this.copa && this.cabo) {
      this.paraquedas.position.set(copaX, copaY);
      this.paraquedas.scale.set(esc);
      this.copa.rotation = copaAng;
      // A copa ABRE: entra fechada e estufa com um estouro curto, como pano pegando ar.
      const abertura = Math.min(1, p / ABRE);
      this.copa.scale.set(0.3 + 0.7 * abertura + Math.sin(abertura * Math.PI) * 0.22);
      this.cabo.position.set(noLocalX, noLocalY);
      this.cabo.rotation = caboAng;
    }

    const cresce = 1 + h * SOMBRA_ALTO;
    this.sombra.x = itemX;
    this.sombra.width = SOMBRA_W * cresce;
    this.sombra.height = SOMBRA_H * cresce;
    this.sombra.alpha = SOMBRA_ALPHA - h * (SOMBRA_ALPHA - SOMBRA_ALPHA_ALTO);

    // No CHÃO o halo é a poça de luz que o item lança no piso, e por isso fica parado embaixo
    // dele. NO AR ele SOBE JUNTO: é a lanterna do próprio item, e o lugar onde ela ficaria se
    // não subisse é exatamente onde a sombra precisa aparecer. Na segunda passada de tuning era
    // isto que apagava a sombra — um glow aditivo de 110 px deitado em cima dela.
    const halo = RAIO * 5 * esc;
    this.halo.position.set(itemX, itemY);
    this.halo.width = halo;
    this.halo.height = halo;
    this.halo.alpha = 0.3;

    this.root.alpha = 1;
    this.root.scale.set(1);
  }

  /** O toque no chão: poeira, sobressalto de escala e o paraquedas se soltando. */
  private aterrissar(): void {
    this.pouso = 0;
    this.poeira.estourar();
    this.impactoT = 0;
    if (this.impacto) this.impacto.visible = true;
    if (this.paraquedas) this.solta = 0;
  }

  /** O anel de poeira abrindo. Escala só — a geometria foi desenhada uma vez. */
  private abrirImpacto(dt: number): void {
    const anel = this.impacto;
    if (!anel) return;
    this.impactoT += dt;
    const t = Math.min(1, this.impactoT / IMPACTO_S);
    const abre = 0.35 + t * 1.35;
    anel.scale.set(abre, abre * 0.62);
    anel.alpha = (1 - t) * (1 - t);
    if (t < 1) return;
    anel.visible = false;
    this.impactoT = -1;
  }

  /** O paraquedas solto: esvoaça para o lado da última deriva, encolhe e some. Nunca some seco. */
  private soltarParaquedas(dt: number): void {
    const conjunto = this.paraquedas;
    if (!conjunto) return;
    this.solta += dt;
    const t = Math.min(1, this.solta / SOLTA_S);
    const lado = this.deriva >= 0 ? 1 : -1;
    conjunto.x += (lado * 58 + Math.sin(this.solta * 11) * 26) * dt;
    conjunto.y += (16 + t * 34) * dt;
    conjunto.rotation += lado * 1.7 * dt;
    conjunto.scale.set(1 - t * 0.5);
    conjunto.alpha = 1 - t * t;
    if (t < 1) return;
    conjunto.destroy({ children: true });
    this.paraquedas = null;
    this.copa = null;
    this.cabo = null;
    this.solta = -1;
  }

  /** `true` quando a animação de saída terminou e a view pode ser removida. */
  update(dt: number, restante: number): boolean {
    this.poeira.update(dt);
    if (this.impactoT >= 0) this.abrirImpacto(dt);
    if (this.solta >= 0) this.soltarParaquedas(dt);

    if (this.saindo >= 0) {
      this.saindo += dt;
      const t = Math.min(1, this.saindo / POP_S);
      const escala = this.popForte ? 1 + t * 1.8 : 1 - t * 0.5;
      this.root.scale.set(escala);
      this.root.alpha = 1 - t;
      return t >= 1;
    }

    const queda = progressoDaQueda(restante);
    if (queda < 1) {
      this.queda = queda;
      this.aplicarQueda(queda);
      return false;
    }
    if (this.queda < 1) {
      this.queda = 1;
      this.aterrissar();
    }

    this.idade += dt;

    // Entrada com overshoot curto para quem NÃO chegou de paraquedas (entrou na sala com o item já
    // no chão): o item não "aparece", ele CHEGA. Quem caiu já teve a própria entrada.
    const entrada = this.chegouDoCeu ? 1 : Math.min(1, this.idade / ENTRADA_S);
    const pulo = entrada < 1 ? 1 + Math.sin(entrada * Math.PI) * 0.35 : 1;
    const onda = Math.sin(this.idade * TAU * BOB_HZ);
    const respiro = 1 + onda * 0.05;

    // Sobressalto do pouso: esmaga na horizontal no toque e devolve com um repique. Amortecido
    // por `(1-t)²` para fechar exatamente em 1 e não deixar o item vibrando.
    let esmaga = 0;
    if (this.pouso >= 0) {
      this.pouso += dt;
      const tp = Math.min(1, this.pouso / POUSO_S);
      esmaga = Math.cos(tp * Math.PI * 2.4) * 0.3 * (1 - tp) * (1 - tp);
      if (tp >= 1) this.pouso = -1;
    }

    const escala = entrada * pulo * respiro;
    this.conjunto.scale.set(escala * (1 + esmaga), escala * (1 - esmaga));
    this.conjunto.rotation = 0;
    this.anel.rotation = this.idade * TAU * GIRO_HZ;
    this.halo.position.set(0, 0);
    this.halo.width = RAIO * 5;
    this.halo.height = RAIO * 5;
    this.halo.alpha = 0.24 + onda * 0.1;
    // A flutuação é do CONJUNTO menos o halo: o brilho fica preso ao chão e o disco sobe e desce
    // sobre ele, que é o que dá a leitura de "isto está pairando".
    this.conjunto.position.set(0, onda * BOB);

    // A sombra respira ao contrário: item mais baixo, sombra menor e mais fechada.
    this.sombra.x = 0;
    this.sombra.width = SOMBRA_W * (1 - onda * 0.06);
    this.sombra.height = SOMBRA_H * (1 - onda * 0.06);

    // Piscada de aviso antes de sumir sozinho.
    this.root.alpha =
      restante < AVISO_S ? 0.45 + 0.55 * Math.abs(Math.sin(restante * Math.PI * AVISO_HZ)) : 1;

    return false;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}

/** O que o Renderer entrega por frame: os itens que existem no chão agora — ou caindo para ele. */
export interface ItemVisivel {
  id: number;
  tipo: TipoPowerUp;
  x: number;
  y: number;
  /**
   * Segundos até sumir sozinho — abaixo de `AVISO_S` o item começa a piscar.
   *
   * ACIMA de `POWERUP_VIDA_NO_MAPA_S` o item ainda está NO AR, e a sobra é exatamente o que falta
   * para ele pousar. É por aqui que a queda inteira herda o determinismo do tick.
   */
  restante: number;
}

/**
 * A camada de itens. Sincroniza por id: o que aparece na lista nasce, o que some dela sai com
 * pop. Quem foi PEGO passa por `pegar()` antes de sumir da lista, e ganha o estouro forte.
 */
export class PowerUpFieldView {
  readonly container = new Container();
  private readonly views = new Map<number, ItemView>();
  private readonly restantes = new Map<number, number>();

  constructor(private readonly textures: GameTextures) {}

  sync(itens: readonly ItemVisivel[]): void {
    const vistos = new Set<number>();
    for (const item of itens) {
      vistos.add(item.id);
      this.restantes.set(item.id, item.restante);
      if (this.views.has(item.id)) continue;
      const view = new ItemView(item.id, item.tipo, item.x, item.y, item.restante, this.textures);
      this.views.set(item.id, view);
      this.container.addChild(view.root);
    }
    // Sumiu da lista sem ter sido pego: acabou o tempo dele no chão.
    for (const [id, view] of this.views) if (!vistos.has(id)) view.sair(false);
  }

  /** O item foi pego por alguém — estouro forte. Idempotente. */
  pegar(id: number): void {
    this.views.get(id)?.sair(true);
  }

  update(dt: number): void {
    for (const [id, view] of this.views) {
      // O padrão é `POWERUP_VIDA_NO_MAPA_S`, e não `Infinity`: `progressoDaQueda(Infinity)` daria
      // uma queda que nunca termina, e o item ficaria pendurado no céu para sempre.
      if (!view.update(dt, this.restantes.get(id) ?? POWERUP_VIDA_NO_MAPA_S)) continue;
      view.destroy();
      this.views.delete(id);
      this.restantes.delete(id);
    }
  }

  /** Rodada nova: nenhum item atravessa a virada. */
  limpar(): void {
    for (const view of this.views.values()) view.destroy();
    this.views.clear();
    this.restantes.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// Crachá de efeito — o que os OUTROS veem
//
// "O adversário tem que saber que aquele tanque está com ricochete duplo antes de escolher trocar
// tiro com ele." O crachá fica ABAIXO do tanque, porque acima já mora a plaqueta de nome +
// emblema, e ele carrega o mesmo símbolo do item que foi pego — quem viu o item no chão reconhece
// o efeito sem precisar aprender um segundo vocabulário.
// ---------------------------------------------------------------------------------------------

/** Distância do centro do tanque até o crachá. */
const CRACHA_DIST = 30;
/** Largura de cada selo dentro do crachá. */
const CRACHA_W = 22;
const CRACHA_H = 20;

export class CrachaDeEfeitos {
  readonly root = new Container();
  private atual = '';
  private idade = 0;

  /** Redesenha só quando a lista de efeitos muda de verdade. */
  sync(efeitos: readonly TipoPowerUp[], x: number, y: number, visivel: boolean): void {
    this.root.visible = visivel && efeitos.length > 0;
    this.root.position.set(x, y + CRACHA_DIST);
    if (!this.root.visible) return;

    const chave = efeitos.join(',');
    if (chave === this.atual) return;
    this.atual = chave;
    this.idade = 0;
    this.root.removeChildren().forEach((filho) => filho.destroy({ children: true }));

    const total = efeitos.length;
    efeitos.forEach((tipo, i) => {
      const cor = POWERUP[tipo].cor;
      const selo = new Graphics();
      const cx = (i - (total - 1) / 2) * (CRACHA_W + 3);
      // Fundo de ELEVAÇÃO NEUTRA, sem halo colorido: é painel de interface dentro do mundo, e a
      // regra do projeto reserva o glow para o que emite luz. O acento colorido é o contorno.
      selo
        .roundRect(cx - CRACHA_W / 2, -CRACHA_H / 2, CRACHA_W, CRACHA_H, 6)
        .fill({ color: 0x0b0f1a, alpha: 0.82 })
        .roundRect(cx - CRACHA_W / 2, -CRACHA_H / 2, CRACHA_W, CRACHA_H, 6)
        .stroke({ width: 1.6, color: cor, alpha: 0.95 });
      const simbolo = new Graphics();
      desenharSimbolo(simbolo, tipo, cor);
      simbolo.scale.set(0.78);
      simbolo.position.set(cx, 0);
      this.root.addChild(selo, simbolo);
    });
  }

  /** Pulso curto na entrada e respiração lenta depois — presença sem roubar a cena. */
  update(dt: number): void {
    if (!this.root.visible) return;
    this.idade += dt;
    const entrada = Math.min(1, this.idade / 0.25);
    this.root.scale.set(entrada * (1 + Math.sin(this.idade * 3.4) * 0.03));
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
