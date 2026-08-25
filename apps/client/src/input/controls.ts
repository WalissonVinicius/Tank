// Controles do jogador (Fase 4). Duas mãos, duas direções independentes:
//
//   CHASSI — `W`/`S` (ou ↑/↓) andam para frente/ré, `A`/`D` (ou ←/→) giram o tanque.
//   TORRE  — segue o cursor do mouse. O ângulo vai como ENTRADA (`Input.aim`) e quem limita o
//            giro é o `step()` do shared-sim, a `TURRET_RATE` — o cliente nunca escreve `turret`.
//   TIRO   — botão ESQUERDO do mouse, com `espaço` mantido como alternativa.
//
// `fire` é entregue como borda de subida (consumida no primeiro `read()` depois do clique/tecla),
// que é exatamente o que o servidor espera em `InputMsg.fire`. `turn`/`move` são estado de nível.

import type { Input, Vec2 } from '@tank/shared-sim';

const LEFT = new Set(['ArrowLeft', 'KeyA']);
const RIGHT = new Set(['ArrowRight', 'KeyD']);
const UP = new Set(['ArrowUp', 'KeyW']);
const DOWN = new Set(['ArrowDown', 'KeyS']);
const FIRE = new Set(['Space']);

export interface ControlsOptions {
  /** Elemento que recebe os cliques de tiro — normalmente a div do canvas, para que clique em botão do HUD não atire. */
  fireTarget: HTMLElement;
  /** Converte um ponto da tela (px CSS, relativo ao canvas) para coordenadas de mundo. */
  screenToWorld(sx: number, sy: number): Vec2;
  target?: Window;
}

export interface Controls {
  /**
   * Input do frame. `myPos` é a posição do MEU tanque em coordenadas de mundo — sem ela (antes do
   * primeiro snapshot, ou morto) o `aim` sai indefinido e a torre fica onde está.
   */
  read(myPos: Vec2 | null): Input;
  /** Cursor em coordenadas de tela, ou `null` enquanto o mouse ainda não se moveu sobre a página. */
  readonly pointer: Readonly<Vec2> | null;
  dispose(): void;
}

export function createControls(options: ControlsOptions): Controls {
  const target = options.target ?? window;
  const held = new Set<string>();
  let fireEdge = false;
  let pointer: Vec2 | null = null;
  // Última mira válida: enquanto o mouse está parado o ângulo continua sendo recalculado a partir
  // da posição do tanque (que se move), então isso só cobre o intervalo antes do primeiro
  // `pointermove` da sessão.
  let ultimoAim: number | undefined;

  const isTracked = (code: string): boolean =>
    LEFT.has(code) || RIGHT.has(code) || UP.has(code) || DOWN.has(code) || FIRE.has(code);

  // W, A, S, D e espaço são teclas de jogo E letras normais. Sem esta guarda o `preventDefault`
  // abaixo engole a tecla antes de ela chegar no campo, e o jogador não consegue escrever o
  // próprio nome nem o código da sala (relatado pelo usuário).
  const digitando = (alvo: EventTarget | null): boolean =>
    alvo instanceof HTMLInputElement ||
    alvo instanceof HTMLTextAreaElement ||
    alvo instanceof HTMLSelectElement ||
    (alvo instanceof HTMLElement && alvo.isContentEditable);

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (!isTracked(ev.code) || digitando(ev.target)) return;
    ev.preventDefault();
    if (FIRE.has(ev.code)) {
      if (!ev.repeat) fireEdge = true;
    } else {
      held.add(ev.code);
    }
  };

  const onKeyUp = (ev: KeyboardEvent): void => {
    if (!isTracked(ev.code) || digitando(ev.target)) return;
    ev.preventDefault();
    held.delete(ev.code);
  };

  const onPointerMove = (ev: PointerEvent): void => {
    const rect = options.fireTarget.getBoundingClientRect();
    if (!pointer) pointer = { x: 0, y: 0 };
    pointer.x = ev.clientX - rect.left;
    pointer.y = ev.clientY - rect.top;
  };

  const onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    onPointerMove(ev);
    fireEdge = true;
  };

  target.addEventListener('keydown', onKeyDown, { passive: false });
  target.addEventListener('keyup', onKeyUp, { passive: false });
  target.addEventListener('pointermove', onPointerMove, { passive: true });
  options.fireTarget.addEventListener('pointerdown', onPointerDown);

  return {
    read(myPos: Vec2 | null): Input {
      let left = false;
      let right = false;
      let up = false;
      let down = false;
      // Iteração direta no Set em vez de `[...held].some(...)` × 4: aquilo alocava quatro arrays
      // por leitura, 60×/s, só para responder quatro perguntas booleanas.
      for (const code of held) {
        if (LEFT.has(code)) left = true;
        else if (RIGHT.has(code)) right = true;
        if (UP.has(code)) up = true;
        else if (DOWN.has(code)) down = true;
      }

      const turn: -1 | 0 | 1 = left === right ? 0 : left ? -1 : 1;
      const move: -1 | 0 | 1 = up === down ? 0 : up ? 1 : -1;

      if (pointer && myPos) {
        const alvo = options.screenToWorld(pointer.x, pointer.y);
        const dx = alvo.x - myPos.x;
        const dy = alvo.y - myPos.y;
        // Cursor praticamente em cima do tanque: o ângulo fica instável, mantém o último.
        if (dx * dx + dy * dy > 4) ultimoAim = Math.atan2(dy, dx);
      }

      const fire = fireEdge;
      fireEdge = false;

      return { turn, move, fire, aim: ultimoAim };
    },
    get pointer(): Readonly<Vec2> | null {
      return pointer;
    },
    dispose(): void {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('pointermove', onPointerMove);
      options.fireTarget.removeEventListener('pointerdown', onPointerDown);
    },
  };
}
