// Camada visual dos power-ups (P1): o item no chão, o crachá de quem está sob efeito e o pop da
// coleta. Tudo procedural, como o resto da arena — nenhum arquivo de imagem.
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

import { Container, Graphics, Sprite } from 'pixi.js';
import { POWERUP, POWERUP_RAIO, type TipoPowerUp } from '@tank/protocol';
import type { GameTextures } from './textures.js';
import { darken } from './color.js';

/** Raio do disco desenhado. Bate com `POWERUP_RAIO` (colisão): o que se vê é o que se pega. */
const RAIO = POWERUP_RAIO;
/** Amplitude da flutuação vertical, em px. */
const BOB = 4;
/** Ciclos de flutuação por segundo. */
const BOB_HZ = 0.6;
/** Voltas por segundo do anel externo. */
const GIRO_HZ = 0.18;
/** Duração da animação de entrada, em segundos. */
const ENTRADA_S = 0.32;
/** Nos últimos segundos de vida o item pisca — some por tempo, mas avisa antes. */
const AVISO_S = 2.2;
/** Piscadas por segundo durante o aviso. */
const AVISO_HZ = 4;
/** Duração do pop de coleta/expiração, em segundos. */
const POP_S = 0.42;

function desenharSimbolo(g: Graphics, tipo: TipoPowerUp, cor: number): void {
  const l = 2.6;
  switch (tipo) {
    // Ricochete: o zigue-zague de uma bala batendo na parede e voltando. É o símbolo do jogo.
    case 'ricochete':
      g.moveTo(-7, 3).lineTo(-1, -5).lineTo(5, 3).lineTo(8, -1).stroke({ width: l, color: cor, cap: 'round', join: 'round' });
      break;
    // Munição: duas balas empilhadas — a leitura é "você tem mais uma".
    case 'municao':
      g.circle(-4, 0, 2.6).circle(4, 0, 2.6).fill({ color: cor });
      g.moveTo(-4, -5.5).lineTo(-4, -8).moveTo(4, -5.5).lineTo(4, -8).stroke({ width: l, color: cor, cap: 'round' });
      break;
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

/** Um item no chão. Só a transform anima — o desenho é feito uma vez. */
class ItemView {
  readonly root = new Container();
  private readonly anel = new Graphics();
  private readonly corpo = new Graphics();
  private readonly halo: Sprite;
  private idade = 0;
  /** > 0 enquanto o pop de saída roda; ao chegar a `POP_S` a view pode ser destruída. */
  private saindo = -1;
  private popForte = false;

  constructor(
    readonly id: number,
    readonly tipo: TipoPowerUp,
    x: number,
    y: number,
    textures: GameTextures,
  ) {
    const cor = POWERUP[tipo].cor;

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

    this.root.addChild(this.halo, this.anel, this.corpo);
    this.root.position.set(x, y);
    this.root.scale.set(0);
  }

  /** Começa o pop de saída. `pego` deixa o estouro mais forte que o sumiço por tempo. */
  sair(pego: boolean): void {
    if (this.saindo >= 0) return;
    this.saindo = 0;
    this.popForte = pego;
  }

  /** `true` quando a animação de saída terminou e a view pode ser removida. */
  update(dt: number, restanteS: number): boolean {
    this.idade += dt;

    if (this.saindo >= 0) {
      this.saindo += dt;
      const t = Math.min(1, this.saindo / POP_S);
      const escala = this.popForte ? 1 + t * 1.8 : 1 - t * 0.5;
      this.root.scale.set(escala);
      this.root.alpha = 1 - t;
      return t >= 1;
    }

    // Entrada com overshoot curto: o item não "aparece", ele CHEGA — é o que faz alguém olhar.
    const entrada = Math.min(1, this.idade / ENTRADA_S);
    const pulo = entrada < 1 ? 1 + Math.sin(entrada * Math.PI) * 0.35 : 1;
    const respiro = 1 + Math.sin(this.idade * Math.PI * 2 * BOB_HZ) * 0.05;
    this.root.scale.set(entrada * pulo * respiro);

    this.anel.rotation = this.idade * Math.PI * 2 * GIRO_HZ;
    this.halo.alpha = 0.24 + Math.sin(this.idade * Math.PI * 2 * BOB_HZ) * 0.1;
    // A flutuação é do CONJUNTO menos o halo: o brilho fica preso ao chão e o disco sobe e desce
    // sobre ele, que é o que dá a leitura de "isto está pairando".
    const bob = Math.sin(this.idade * Math.PI * 2 * BOB_HZ) * BOB;
    this.anel.y = bob;
    this.corpo.y = bob;

    // Piscada de aviso antes de sumir sozinho.
    this.root.alpha =
      restanteS < AVISO_S ? 0.45 + 0.55 * Math.abs(Math.sin(restanteS * Math.PI * AVISO_HZ)) : 1;

    return false;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}

/** O que o Renderer entrega por frame: os itens que existem no chão agora. */
export interface ItemVisivel {
  id: number;
  tipo: TipoPowerUp;
  x: number;
  y: number;
  /** Segundos até sumir sozinho — abaixo de `AVISO_S` o item começa a piscar. */
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
      const view = new ItemView(item.id, item.tipo, item.x, item.y, this.textures);
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
      if (!view.update(dt, this.restantes.get(id) ?? Infinity)) continue;
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
