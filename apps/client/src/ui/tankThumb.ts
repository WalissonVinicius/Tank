// Miniatura do tanque para os slots do lobby.
//
// É o MESMO desenho do `render/tank.ts` — mesmas coordenadas, mesmas proporções, mesma derivação
// de cor — só que em Canvas 2D em vez de PIXI.Graphics. O renderer do jogo está ocupado com a
// arena, e criar uma segunda Application do Pixi só para desenhar 10 quadradinhos de 64 px seria
// caro; portar as formas é barato e mantém a arte única (nada de tanque novo inventado aqui).

import { darken, lighten } from '../render/color.js';

function hex(c: number): string {
  return '#' + (c >>> 0).toString(16).padStart(6, '0');
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/**
 * Desenha o tanque num canvas quadrado de `lado` px (CSS), já com devicePixelRatio aplicado.
 * `angulo` gira o conjunto inteiro; a torre fica sempre reta em relação ao chassi.
 */
export function desenharTanque(canvas: HTMLCanvasElement, cor: number, lado: number, angulo = -0.5): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(lado * dpr);
  canvas.height = Math.round(lado * dpr);
  canvas.style.width = `${lado}px`;
  canvas.style.height = `${lado}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const escala = (lado / 52) * dpr; // o tanque ocupa ~44 px de largura no espaço do jogo
  ctx.setTransform(escala, 0, 0, escala, (lado * dpr) / 2, (lado * dpr) / 2);
  ctx.rotate(angulo);

  const dark = darken(cor, 0.68);
  const mid = darken(cor, 0.5);
  const hi = lighten(cor, 0.4);

  // sombra projetada — dá o volume que separa o tanque do fundo do cartão
  ctx.save();
  ctx.translate(2, 3);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  rr(ctx, -19, -16, 38, 32, 6);
  ctx.filter = 'blur(2px)';
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = 'rgba(13,18,32,0.92)';
  rr(ctx, -18, -16.5, 36, 33, 5);
  ctx.fill();

  ctx.fillStyle = '#0a0e18';
  rr(ctx, -19, -15, 38, 9, 2.5);
  ctx.fill();
  rr(ctx, -19, 6, 38, 9, 2.5);
  ctx.fill();

  ctx.fillStyle = 'rgba(42,52,82,0.9)';
  for (let i = -16; i <= 16; i += 4) {
    ctx.fillRect(i - 1, -14, 2, 7);
    ctx.fillRect(i - 1, 7, 2, 7);
  }

  ctx.fillStyle = hex(mid);
  ctx.strokeStyle = hex(cor);
  ctx.lineWidth = 1.8;
  rr(ctx, -16, -10, 32, 20, 4);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = hex(dark);
  ctx.globalAlpha = 0.75;
  rr(ctx, -12, -6, 12, 12, 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.globalAlpha = 0.7;
  ctx.fillStyle = hex(cor);
  ctx.fillRect(9, -7, 4, 14);
  ctx.globalAlpha = 1;

  // torre: cano, boca e cúpula
  ctx.fillStyle = '#0f1422';
  ctx.strokeStyle = hex(cor);
  ctx.lineWidth = 1;
  rr(ctx, 5, -2.6, 20, 5.2, 1.5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = hex(cor);
  ctx.fillRect(21, -3.4, 4.5, 6.8);

  ctx.fillStyle = hex(dark);
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(0, 0, 8.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = hex(cor);
  ctx.beginPath();
  ctx.arc(0, 0, 3.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = hex(hi);
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  ctx.arc(-3, -3, 1.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}
