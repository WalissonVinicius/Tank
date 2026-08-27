// Controles de toque — dois polegares, dois analógicos virtuais (M1).
//
// Isto só existe porque o movimento virou ABSOLUTO: `Input.mover` é um ângulo de mundo, e um
// analógico virtual não produz outra coisa senão um ângulo. O polegar aponta, `atan2` converte,
// e o valor entra pelo mesmíssimo caminho do teclado — nada muda na simulação, no protocolo ou
// no servidor. Com o esquema antigo (A/D giravam o tanque) teria sido preciso inventar uma
// tradução de "para onde o polegar aponta" para "por quanto tempo segurar D", que é justamente o
// tipo de remendo que dá enjoo de controle.
//
// ESQUERDA — ANDAR. O analógico NASCE onde o dedo tocar na metade esquerda da tela, não num
//   canto fixo: polegar não acerta alvo fixo sem olhar, e olhar para o controle é olhar para
//   fora do jogo. Enquanto ninguém toca fica um fantasma na posição de descanso, só para
//   ensinar onde é. Zona morta no centro devolve `mover: null`.
//
// DIREITA — MIRAR E ATIRAR no mesmo polegar, com o TIRO NA SOLTURA. A alternativa (analógico de
//   mira + botão de tiro separado) exigiria que o polegar direito estivesse em dois lugares ao
//   mesmo tempo, ou um terceiro dedo. Aqui a mira é contínua enquanto o dedo está na tela — e é
//   exatamente durante esse tempo que a LINHA DE MIRA mostra o ricochete —, e soltar dispara na
//   direção que está desenhada. Toque curto sem arrastar = tiro rápido na direção atual.
//   Arrastar para fora e VOLTAR ao centro cancela: sem escape o autogol viraria acidente de
//   interface em vez de piada.
//
// O desenho é DOM + CSS por cima do canvas, como o resto do HUD. Por frame só mudam `transform` e
// `opacity` de quatro elementos — trabalho de compositor, não de layout.

/** Raio do analógico em px CSS, derivado do menor lado da tela e contido entre 42 e 62. */
function raioDoAnalogico(w: number, h: number): number {
  return Math.round(Math.min(62, Math.max(42, Math.min(w, h) * 0.15)));
}

/** Fração do raio abaixo da qual o polegar conta como parado. */
const ZONA_MORTA = 0.24;
/** Fração do raio que o dedo precisa ultrapassar para o gesto de cancelar ficar armado. */
const LIMIAR_ARMA_CANCELAMENTO = 0.42;
/** Voltando para dentro desta fração depois de armado, a soltura NÃO atira. */
const LIMIAR_CANCELA = 0.2;

interface Polegar {
  /** `pointerId` do dedo que está segurando este analógico. */
  id: number;
  /** Centro do analógico (px CSS, relativos à janela). */
  cx: number;
  cy: number;
  /** Deslocamento do dedo já limitado ao raio. */
  dx: number;
  dy: number;
  /** 0..1 — o quanto o dedo saiu do centro. */
  forca: number;
}

export interface LeituraDeToque {
  /** Ângulo de movimento, ou `null` quando o polegar esquerdo está parado / ausente. */
  mover: number | null;
  /** Ângulo de mira do polegar direito; `undefined` enquanto ele nunca apontou. */
  aim: number | undefined;
  /**
   * O polegar direito está apontando NESTE frame. É o sinal de que o dedo assumiu a mira e o
   * cursor do mouse (num tablet com teclado) deve ceder — o `aim` em si persiste depois da
   * soltura, senão a torre voltaria para o leste no instante em que o dedo saísse da tela.
   */
  apontando: boolean;
  /** Borda de tiro (soltura do polegar direito ou toque curto), consumida na leitura. */
  fire: boolean;
}

export interface ControlesDeToque {
  /** Lê e CONSOME a borda de tiro do frame. */
  ler(): LeituraDeToque;
  /** Redesenha os analógicos. Chamado uma vez por frame. */
  desenhar(): void;
  /**
   * Liga/desliga a captura. Desligar solta todos os dedos — é o que impede o tanque de sair
   * andando sozinho quando o aparelho volta para retrato ou o menu de pausa abre.
   */
  setAtivo(ativo: boolean): void;
  /** `true` quando os analógicos estão em cena. */
  readonly ativo: boolean;
  dispose(): void;
}

export interface OpcoesDeToque {
  /** Camada DOM que recebe o desenho dos analógicos (`#toque`). */
  camada: HTMLElement;
}

/**
 * O aparelho é de toque?
 *
 * `pointer: coarse` sozinho pega TV e alguns notebooks híbridos; `maxTouchPoints` sozinho pega
 * notebook com tela sensível cujo ponteiro principal é o trackpad. Os dois juntos são celular e
 * tablet — que é exatamente onde o analógico deve nascer. `?toque=1` força (bancada de teste),
 * `?toque=0` desliga.
 */
export function ehAparelhoDeToque(params: URLSearchParams = new URLSearchParams(location.search)): boolean {
  const forcado = params.get('toque');
  if (forcado === '1') return true;
  if (forcado === '0') return false;
  const grosso = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return grosso && (navigator.maxTouchPoints ?? 0) > 0;
}

export function criarControlesDeToque(opcoes: OpcoesDeToque): ControlesDeToque {
  const camada = opcoes.camada;
  camada.innerHTML = `
    <div class="analogico esq">
      <div class="base"></div>
      <div class="botao"></div>
    </div>
    <div class="analogico dir">
      <div class="base"></div>
      <div class="seta"></div>
      <div class="botao"></div>
    </div>
  `;
  const elEsq = camada.querySelector('.analogico.esq') as HTMLElement;
  const elDir = camada.querySelector('.analogico.dir') as HTMLElement;
  const botaoEsq = elEsq.querySelector('.botao') as HTMLElement;
  const botaoDir = elDir.querySelector('.botao') as HTMLElement;
  const setaDir = elDir.querySelector('.seta') as HTMLElement;

  let raio = raioDoAnalogico(window.innerWidth, window.innerHeight);
  let esq: Polegar | null = null;
  let dir: Polegar | null = null;
  /** Ficou armado quando o dedo direito passou do limiar; só então o retorno ao centro cancela. */
  let cancelamentoArmado = false;
  let cancelado = false;
  let fireEdge = false;
  let ultimoAim: number | undefined;
  // Nasce DESLIGADO. A camada cobre a tela inteira para o polegar poder pousar em qualquer lugar,
  // e enquanto o jogo monta (o `Renderer.create` é assíncrono) ela ficaria por cima do lobby
  // engolindo o toque no botão de ENTRAR. Quem liga é o laço de render, quando a arena entra.
  let ativo = false;
  camada.classList.add('desligado');

  // Entalhe e barra de gestos, lidos UMA vez por resize a partir das custom properties que o CSS
  // publica no `:root`. Sem isto o fantasma do analógico nasce embaixo do indicador de home do
  // aparelho — e o dedo que tenta pousar lá manda o gesto para o sistema, não para o jogo.
  let seguroL = 0;
  let seguroR = 0;
  let seguroB = 0;

  /** Onde o fantasma descansa enquanto ninguém está tocando. */
  const descansoX = (lado: 'esq' | 'dir'): number =>
    lado === 'esq' ? seguroL + raio + 18 : window.innerWidth - seguroR - raio - 18;
  const descansoY = (): number => window.innerHeight - seguroB - raio - 22;

  const aplicarRaio = (): void => {
    raio = raioDoAnalogico(window.innerWidth, window.innerHeight);
    camada.style.setProperty('--raio', `${raio}px`);
    const estilo = getComputedStyle(document.documentElement);
    const px = (nome: string): number => Math.max(0, parseFloat(estilo.getPropertyValue(nome)) || 0);
    seguroL = px('--sa-l');
    seguroR = px('--sa-r');
    seguroB = px('--sa-b');
  };
  aplicarRaio();

  const soltarTudo = (): void => {
    esq = null;
    dir = null;
    cancelamentoArmado = false;
    cancelado = false;
  };

  const capturar = (ev: PointerEvent): Polegar | null => {
    // Metade da tela decide a mão. Nada de zona reservada de canto: o polegar precisa poder
    // pousar onde chegar.
    if (ev.clientX < window.innerWidth / 2) {
      if (esq) return null;
      esq = { id: ev.pointerId, cx: ev.clientX, cy: ev.clientY, dx: 0, dy: 0, forca: 0 };
      return esq;
    }
    if (dir) return null;
    cancelamentoArmado = false;
    cancelado = false;
    dir = { id: ev.pointerId, cx: ev.clientX, cy: ev.clientY, dx: 0, dy: 0, forca: 0 };
    return dir;
  };

  const arrastar = (p: Polegar, x: number, y: number): void => {
    let dx = x - p.cx;
    let dy = y - p.cy;
    const dist = Math.hypot(dx, dy);
    if (dist > raio) {
      // Arrastou além do raio: o CENTRO acompanha o dedo. Sem isto o polegar "perde" o analógico
      // num arrasto longo e o jogador precisa olhar para reencontrá-lo.
      const sobra = 1 - raio / dist;
      p.cx += dx * sobra;
      p.cy += dy * sobra;
      dx *= raio / dist;
      dy *= raio / dist;
    }
    p.dx = dx;
    p.dy = dy;
    p.forca = Math.min(1, Math.hypot(dx, dy) / raio);
  };

  const onDown = (ev: PointerEvent): void => {
    if (!ativo || ev.pointerType !== 'touch') return;
    if (!capturar(ev)) return;
    ev.preventDefault();
  };

  const onMove = (ev: PointerEvent): void => {
    if (!ativo || ev.pointerType !== 'touch') return;
    if (esq && ev.pointerId === esq.id) {
      arrastar(esq, ev.clientX, ev.clientY);
      ev.preventDefault();
    } else if (dir && ev.pointerId === dir.id) {
      arrastar(dir, ev.clientX, ev.clientY);
      if (dir.forca > LIMIAR_ARMA_CANCELAMENTO) {
        cancelamentoArmado = true;
        cancelado = false;
      } else if (cancelamentoArmado && dir.forca < LIMIAR_CANCELA) {
        cancelado = true;
      }
      if (dir.forca > ZONA_MORTA) ultimoAim = Math.atan2(dir.dy, dir.dx);
      ev.preventDefault();
    }
  };

  const onUp = (ev: PointerEvent): void => {
    if (ev.pointerType !== 'touch') return;
    if (esq && ev.pointerId === esq.id) {
      esq = null;
    } else if (dir && ev.pointerId === dir.id) {
      // Soltou: atira, a não ser que o gesto de cancelar tenha sido feito. O toque curto (nunca
      // saiu da zona morta) atira na direção que já estava mirada — é o tiro rápido.
      if (ativo && !cancelado) fireEdge = true;
      dir = null;
      cancelamentoArmado = false;
      cancelado = false;
    }
  };

  // `pointercancel` chega quando o navegador rouba o dedo (barra de gestos do sistema, chamada
  // entrando). Tratado como soltura SEM tiro: um disparo mandado pelo sistema operacional seria o
  // pior autogol possível.
  const onCancel = (ev: PointerEvent): void => {
    if (ev.pointerType !== 'touch') return;
    if (esq && ev.pointerId === esq.id) esq = null;
    if (dir && ev.pointerId === dir.id) {
      dir = null;
      cancelamentoArmado = false;
      cancelado = false;
    }
  };

  // iOS ignora `user-scalable=no`; sem isto o pinça-zoom continua funcionando por cima do jogo.
  const onGesto = (ev: Event): void => ev.preventDefault();

  const onResize = (): void => {
    aplicarRaio();
    soltarTudo();
  };

  camada.addEventListener('pointerdown', onDown, { passive: false });
  camada.addEventListener('pointermove', onMove, { passive: false });
  camada.addEventListener('pointerup', onUp);
  camada.addEventListener('pointercancel', onCancel);
  camada.addEventListener('gesturestart', onGesto);
  camada.addEventListener('gesturechange', onGesto);
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  const posicionar = (el: HTMLElement, botao: HTMLElement, p: Polegar | null, lado: 'esq' | 'dir'): void => {
    const cx = p ? p.cx : descansoX(lado);
    const cy = p ? p.cy : descansoY();
    el.style.transform = `translate3d(${cx - raio}px, ${cy - raio}px, 0)`;
    el.classList.toggle('segurando', p !== null);
    botao.style.transform = p ? `translate3d(${p.dx}px, ${p.dy}px, 0)` : 'translate3d(0px, 0px, 0)';
  };

  return {
    ler(): LeituraDeToque {
      const f = fireEdge;
      fireEdge = false;
      const andar = esq && esq.forca > ZONA_MORTA ? Math.atan2(esq.dy, esq.dx) : null;
      return { mover: andar, aim: ultimoAim, fire: f, apontando: dir !== null && dir.forca > ZONA_MORTA };
    },
    desenhar(): void {
      posicionar(elEsq, botaoEsq, esq, 'esq');
      posicionar(elDir, botaoDir, dir, 'dir');
      elDir.classList.toggle('cancelando', cancelado);
      // A seta do analógico direito repete, na mão, o que a linha de mira desenha na arena: o
      // dedo aponta e a seta confirma para onde o tiro vai sair.
      if (dir && dir.forca > ZONA_MORTA) {
        setaDir.style.opacity = String(Math.min(1, dir.forca * 1.6));
        setaDir.style.transform = `rotate(${Math.atan2(dir.dy, dir.dx)}rad)`;
      } else {
        setaDir.style.opacity = '0';
      }
    },
    setAtivo(v: boolean): void {
      if (v === ativo) return;
      ativo = v;
      if (!v) {
        soltarTudo();
        fireEdge = false;
      }
      camada.classList.toggle('desligado', !v);
    },
    get ativo(): boolean {
      return ativo;
    },
    dispose(): void {
      camada.removeEventListener('pointerdown', onDown);
      camada.removeEventListener('pointermove', onMove);
      camada.removeEventListener('pointerup', onUp);
      camada.removeEventListener('pointercancel', onCancel);
      camada.removeEventListener('gesturestart', onGesto);
      camada.removeEventListener('gesturechange', onGesto);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      camada.innerHTML = '';
    },
  };
}
