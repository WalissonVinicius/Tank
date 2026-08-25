// Decalques persistentes do chão: rastro de esteira e queimadura de morte. Só isso — marca de
// ricochete na parede foi removida a pedido do usuário ("a marca na parede da bala não precisa
// ficar, só quando matar mesmo"). Uma RenderTexture do tamanho do mundo carimbada via
// renderer.render({container, target, clear:false}), nunca limpa durante a rodada e recriada
// inteira quando a rodada acaba (setMaze → reset), para a próxima começar com o chão limpo.

import { Container, RenderTexture, Sprite, type Renderer, type Texture } from 'pixi.js';
import type { GameTextures } from './textures.js';

interface StampOptions {
  rotation?: number;
  scale?: number;
  tint?: number;
  alpha?: number;
}

export class DecalLayer {
  readonly sprite: Sprite;

  private rt: RenderTexture;
  private readonly queue = new Container();
  private readonly textures: GameTextures;
  // Rastro de esteira carimba a cada 12 px percorridos por tanque vivo — dezenas de Sprites por
  // segundo criados e destruídos. Aqui eles são reciclados; a textura do carimbo muda por Sprite,
  // então o pool guarda o Sprite e troca `texture` na hora de usar.
  private readonly reserva: Sprite[] = [];
  /** Container sempre vazio, usado só como alvo do `render({clear:true})` que apaga a textura. */
  private readonly vazio = new Container();
  private precisaLimpar = false;
  // O que foi PEDIDO na última criação. `rt.width` do Pixi já vem dividido pela resolução, então
  // comparar com ele para decidir "mesmo tamanho?" daria falso negativo assim que a resolução
  // deixasse de ser 1.
  private larguraAtual = 0;
  private alturaAtual = 0;
  private resolucaoAtual = 1;

  constructor(textures: GameTextures, worldWidth: number, worldHeight: number) {
    this.textures = textures;
    this.larguraAtual = Math.max(1, worldWidth);
    this.alturaAtual = Math.max(1, worldHeight);
    this.rt = RenderTexture.create({ width: this.larguraAtual, height: this.alturaAtual, resolution: 1 });
    this.sprite = new Sprite(this.rt);
  }

  /**
   * Fim de rodada / novo labirinto — única situação em que os decalques somem.
   *
   * `resolucao` é quantos texels a textura deve ter por pixel de MUNDO. Ela existe por causa da
   * Fase 9: com a arena preenchendo a janela, a câmera amplia o mundo até ~2,1× em ultrawide, e
   * uma textura de 1 texel por pixel de mundo chegaria à tela como mancha borrada. Quem chama
   * passa a escala real da câmera (ver `Renderer.setMaze`).
   */
  reset(worldWidth: number, worldHeight: number, resolucao = 1): void {
    // A fila precisa morrer junto: uma morte no último tick da rodada enfileira a queimadura
    // ANTES do reset e o flush() do fim do frame a carimbaria já na textura nova, fazendo a
    // rodada seguinte nascer suja. Foi exatamente esse o bug de estado entre rodadas.
    // (Voltam para o pool, não são destruídos — a fila fica vazia do mesmo jeito.)
    for (const child of this.queue.removeChildren()) this.reserva.push(child as Sprite);

    const w = Math.max(1, worldWidth);
    const h = Math.max(1, worldHeight);
    const res = Math.min(2, Math.max(1, Math.round(resolucao * 100) / 100));

    // Mesmo tamanho (o caso comum: labirintos de uma partida têm sempre o mesmo nº de jogadores)
    // → LIMPA a textura em vez de destruir e alocar outra. Destruir/criar uma textura de ~1100×760
    // toda rodada é uma alocação de GPU no meio do jogo, um dos candidatos investigados para os
    // engasgos da Fase 4. A limpeza propriamente dita acontece no próximo `flush()`, que é onde
    // temos o renderer em mãos.
    if (this.larguraAtual === w && this.alturaAtual === h && this.resolucaoAtual === res) {
      this.precisaLimpar = true;
      return;
    }

    this.rt.destroy(true);
    this.rt = RenderTexture.create({ width: w, height: h, resolution: res });
    this.sprite.texture = this.rt;
    this.larguraAtual = w;
    this.alturaAtual = h;
    this.resolucaoAtual = res;
    this.precisaLimpar = false;
  }

  private stamp(texture: Texture, x: number, y: number, opts: StampOptions): void {
    const s = this.reserva.pop() ?? new Sprite();
    s.texture = texture;
    s.anchor.set(0.5);
    s.position.set(x, y);
    s.rotation = opts.rotation ?? 0;
    s.scale.set(opts.scale ?? 1);
    s.tint = opts.tint ?? 0xffffff;
    s.alpha = opts.alpha ?? 1;
    this.queue.addChild(s);
  }

  // Alphas calibrados para piso CLARO: aqui um decalque escuro aparece de verdade, e o que antes
  // era invisível na penumbra vira buraco preto se não for contido.

  /** Chame a cada `distance` percorrida por um tanque vivo para marcar a esteira no chão. */
  stampTrack(x: number, y: number, heading: number): void {
    this.stamp(this.textures.track, x, y, { rotation: heading + Math.PI / 2, tint: 0x1b2038, alpha: 0.09 });
  }

  /** Queimadura no ponto em que um tanque morreu — ~48 px de mundo, pouco maior que o tanque. */
  stampScorch(x: number, y: number, rotation: number): void {
    this.stamp(this.textures.scorch, x, y, { rotation, scale: 0.5, alpha: 0.56 });
  }

  flush(renderer: Renderer): void {
    if (this.precisaLimpar) {
      // `clear: true` com a fila vazia zera a textura inteira — é o "apagar o chão" da rodada nova.
      renderer.render({ container: this.vazio, target: this.rt, clear: true });
      this.precisaLimpar = false;
    }
    if (!this.queue.children.length) return;
    renderer.render({ container: this.queue, target: this.rt, clear: false });
    for (const child of this.queue.removeChildren()) this.reserva.push(child as Sprite);
  }

  destroy(): void {
    this.rt.destroy(true);
    this.sprite.destroy();
    for (const s of this.reserva) s.destroy();
    this.reserva.length = 0;
    this.vazio.destroy();
    this.queue.destroy();
  }
}
