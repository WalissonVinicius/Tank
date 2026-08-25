// Os 10 emblemas de animal, DESENHADOS EM CÓDIGO (Canvas 2D) — nenhum arquivo de imagem, como
// todo o resto da arte do jogo.
//
// Por que Canvas e não PIXI.Graphics: o mesmo emblema precisa aparecer DENTRO da arena (sprite no
// mundo, sobre o tanque) e FORA dela (lobby, killfeed, placar, tela de vencedor — tudo DOM).
// Canvas serve os dois: vira `Texture` para o Pixi e `data:` URL para o `<img>` do HUD a partir do
// MESMO traço. Desenhar duas vezes seria duas artes divergindo com o tempo.
//
// Linguagem: silhueta CHEIA na cor do jogador, contorno quase preto GROSSO, detalhe interno
// escuro. Nada de fidelidade zoológica — o critério é ler de relance no tamanho do tanque (~30 px
// na tela), e é por isso que quase todos são CABEÇAS DE FRENTE: no tamanho pequeno o que
// sobrevive é o contorno externo (orelhas, chifres, tufos, bico), não o miolo.
//
// Cada bicho é desenhado numa caixa de 100×100. Quem chama escolhe o tamanho final. Tudo é
// cacheado por (animal, cor) — são 10 combinações no jogo inteiro.

import { Texture } from 'pixi.js';
import { ANIMAL_NOME, animalDaCor, type AnimalId } from '@tank/protocol';
import { darken, mixColor } from './color.js';

type Ctx = CanvasRenderingContext2D;

const TRACO = '#0b0f1a';
const TAU = Math.PI * 2;
/** Lado da caixa de desenho de todos os animais. */
const CAIXA = 100;
/** Espessura padrão do contorno, no espaço da caixa. */
const CONTORNO = 9;

function hex(c: number): string {
  return '#' + (c >>> 0).toString(16).padStart(6, '0');
}

function luminancia(c: number): number {
  const r = ((c >> 16) & 0xff) / 255;
  const g = ((c >> 8) & 0xff) / 255;
  const b = (c & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Tom da MANCHA de apoio (focinho, bochecha, bico, chifre) que sempre separa da cor de base. Numa
 * cor saturada ela vai para o creme; numa cor já clara (o osso do urso) ela ESCURECE, senão some
 * dentro da cabeça e o bicho perde o único detalhe de volume que tem.
 */
function realce(cor: number): string {
  return hex(luminancia(cor) > 0.62 ? darken(cor, 0.3) : mixColor(cor, 0xfff2d4, 0.62));
}

/** Fecha a forma corrente: contorno escuro grosso por fora, preenchimento por dentro. */
function silhueta(ctx: Ctx, preenche: string, largura = CONTORNO): void {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = TRACO;
  ctx.lineWidth = largura;
  ctx.stroke();
  ctx.fillStyle = preenche;
  ctx.fill();
}

/** Preenche a forma corrente com o escuro do contorno — olhos, listras, narinas. */
function escuro(ctx: Ctx): void {
  ctx.fillStyle = TRACO;
  ctx.fill();
}

/**
 * Membro tubular (corpo da cobra, chifre do touro, perna do caranguejo): o mesmo traçado passado
 * duas vezes, grosso em escuro e fino na cor. Sai um tubo já contornado, sem fechar o contorno à
 * mão.
 */
function tubo(ctx: Ctx, caminho: () => void, cor: string, fora: number, dentro: number): void {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  caminho();
  ctx.strokeStyle = TRACO;
  ctx.lineWidth = fora;
  ctx.stroke();
  ctx.strokeStyle = cor;
  ctx.lineWidth = dentro;
  ctx.stroke();
}

function elipse(ctx: Ctx, x: number, y: number, rx: number, ry: number, giro = 0): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, giro, 0, TAU);
}

function poligono(ctx: Ctx, pontos: readonly (readonly [number, number])[]): void {
  ctx.beginPath();
  pontos.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

function disco(ctx: Ctx, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
}

function risco(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, largura: number): void {
  ctx.strokeStyle = TRACO;
  ctx.lineWidth = largura;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** Olho amendoado inclinado — o olhar de tigre, lobo e raposa. */
function olhoAmendoa(ctx: Ctx, x: number, y: number, lado: number): void {
  ctx.beginPath();
  ctx.moveTo(x - lado * 9, y - 4);
  ctx.quadraticCurveTo(x, y - 8, x + lado * 8, y + 1);
  ctx.quadraticCurveTo(x, y + 6, x - lado * 9, y - 4);
  ctx.closePath();
  escuro(ctx);
}

// ---------------------------------------------------------------------------------------------
// Os dez bichos. Cada função desenha na caixa 100×100 do `ctx` já posicionado.
// ---------------------------------------------------------------------------------------------

function caranguejo(ctx: Ctx, cor: string, claro: string): void {
  for (const lado of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const y0 = 60 + i * 5;
      tubo(
        ctx,
        () => {
          ctx.moveTo(50 + lado * 18, y0);
          ctx.quadraticCurveTo(50 + lado * 32, y0 + 4, 50 + lado * (33 + i * 1.5), 72 + i * 8);
        },
        cor,
        10,
        4.5,
      );
    }
    // braço + pinça: é a pinça que dá o contorno de caranguejo já nos primeiros 20 px
    tubo(
      ctx,
      () => {
        ctx.moveTo(50 + lado * 16, 54);
        ctx.quadraticCurveTo(50 + lado * 34, 48, 50 + lado * 34, 34);
      },
      cor,
      13,
      6.5,
    );
    const cx = 50 + lado * 34;
    elipse(ctx, cx, 24, 15, 12, lado * -0.4);
    silhueta(ctx, cor, 8);
    poligono(ctx, [
      [cx, 24],
      [cx + lado * 18, 11],
      [cx + lado * 19, 26],
    ]);
    escuro(ctx);
  }

  elipse(ctx, 50, 58, 30, 20);
  silhueta(ctx, cor);

  for (const lado of [-1, 1]) {
    tubo(
      ctx,
      () => {
        ctx.moveTo(50 + lado * 9, 50);
        ctx.lineTo(50 + lado * 11, 36);
      },
      cor,
      10,
      4,
    );
    disco(ctx, 50 + lado * 11, 32, 6.5);
    escuro(ctx);
    disco(ctx, 50 + lado * 13, 30, 2.2);
    ctx.fillStyle = claro;
    ctx.fill();
  }

  ctx.strokeStyle = TRACO;
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(40, 66);
  ctx.lineTo(45, 71);
  ctx.lineTo(50, 66);
  ctx.lineTo(55, 71);
  ctx.lineTo(60, 66);
  ctx.stroke();
}

function tigre(ctx: Ctx, cor: string, claro: string): void {
  for (const lado of [-1, 1]) {
    disco(ctx, 50 + lado * 27, 27, 13.5);
    silhueta(ctx, cor);
    disco(ctx, 50 + lado * 27, 28, 6.5);
    escuro(ctx);
  }

  elipse(ctx, 50, 58, 32, 29);
  silhueta(ctx, cor);

  // listras: três na testa e duas em cada bochecha — é o que separa o tigre do urso a 20 px
  for (const dx of [-10, 0, 10]) {
    risco(ctx, 50 + dx, 32 + Math.abs(dx) * 0.34, 50 + dx * 1.3, 46 + Math.abs(dx) * 0.2, 6);
  }
  for (const lado of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      risco(ctx, 50 + lado * (30 - i * 2), 55 + i * 11, 50 + lado * 17, 58 + i * 10, 5.5);
    }
  }

  elipse(ctx, 50, 72, 19, 13);
  silhueta(ctx, claro, 5);

  for (const lado of [-1, 1]) olhoAmendoa(ctx, 50 + lado * 13, 53, lado);

  poligono(ctx, [
    [43, 65],
    [57, 65],
    [50, 73],
  ]);
  escuro(ctx);
  risco(ctx, 50, 72, 50, 78, 3.5);
}

function aguia(ctx: Ctx, cor: string, claro: string): void {
  // penas da nuca — três pontas que quebram o contorno redondo e dizem "ave de rapina"
  for (let i = 0; i < 3; i++) {
    poligono(ctx, [
      [27, 33 + i * 13],
      [7, 31 + i * 15],
      [25, 47 + i * 13],
    ]);
    silhueta(ctx, cor, 7);
  }

  ctx.beginPath();
  ctx.moveTo(22, 54);
  ctx.bezierCurveTo(20, 26, 44, 13, 64, 26);
  ctx.bezierCurveTo(72, 32, 70, 46, 66, 55);
  ctx.bezierCurveTo(62, 72, 40, 80, 27, 70);
  ctx.bezierCurveTo(21, 65, 22, 59, 22, 54);
  ctx.closePath();
  silhueta(ctx, cor);

  // bico ganchudo: a assinatura da águia, num tom que nunca se funde com a cabeça
  ctx.beginPath();
  ctx.moveTo(59, 32);
  ctx.lineTo(94, 42);
  ctx.quadraticCurveTo(84, 58, 72, 59);
  ctx.quadraticCurveTo(62, 60, 59, 50);
  ctx.closePath();
  silhueta(ctx, claro, 7);
  risco(ctx, 62, 47, 87, 47, 3);

  poligono(ctx, [
    [37, 27],
    [64, 31],
    [60, 39],
    [39, 35],
  ]);
  escuro(ctx);
  disco(ctx, 53, 41, 5.4);
  escuro(ctx);
  disco(ctx, 55, 39, 1.9);
  ctx.fillStyle = claro;
  ctx.fill();
}

function cobra(ctx: Ctx, cor: string, claro: string): void {
  tubo(
    ctx,
    () => {
      ctx.moveTo(16, 90);
      ctx.bezierCurveTo(64, 92, 70, 60, 44, 54);
      ctx.bezierCurveTo(20, 49, 26, 24, 54, 27);
    },
    cor,
    25,
    15,
  );

  elipse(ctx, 68, 26, 16, 12, 0.08);
  silhueta(ctx, cor, 8);

  // língua bífida — junto com a curva em S é o que identifica a cobra em qualquer tamanho
  ctx.strokeStyle = TRACO;
  ctx.lineWidth = 3.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(82, 28);
  ctx.lineTo(93, 30);
  ctx.moveTo(93, 30);
  ctx.lineTo(98, 24);
  ctx.moveTo(93, 30);
  ctx.lineTo(98, 36);
  ctx.stroke();

  disco(ctx, 71, 21, 4.4);
  escuro(ctx);
  disco(ctx, 72.5, 19.5, 1.6);
  ctx.fillStyle = claro;
  ctx.fill();

  ctx.fillStyle = TRACO;
  for (const [x, y, r] of [
    [30, 84, 4.4],
    [51, 74, 4],
    [56, 57, 3.8],
    [32, 45, 3.6],
  ] as const) {
    disco(ctx, x, y, r);
    ctx.fill();
  }
}

function tubarao(ctx: Ctx, cor: string, claro: string): void {
  // peitoral primeiro: fica por baixo do corpo, como um plano atrás
  poligono(ctx, [
    [52, 66],
    [37, 93],
    [63, 72],
  ]);
  silhueta(ctx, claro, 7);

  ctx.beginPath();
  ctx.moveTo(5, 33);
  ctx.lineTo(23, 50);
  ctx.lineTo(5, 71);
  ctx.quadraticCurveTo(34, 79, 58, 73);
  ctx.quadraticCurveTo(84, 67, 96, 48);
  ctx.quadraticCurveTo(82, 33, 63, 29);
  ctx.lineTo(54, 29);
  ctx.lineTo(45, 5);
  ctx.lineTo(37, 31);
  ctx.quadraticCurveTo(19, 32, 5, 33);
  ctx.closePath();
  silhueta(ctx, cor);

  // boca: arco escuro com dentes claros — a leitura de "tubarão" mora aqui
  ctx.beginPath();
  ctx.moveTo(62, 57);
  ctx.quadraticCurveTo(79, 63, 93, 49);
  ctx.strokeStyle = TRACO;
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.fillStyle = claro;
  for (const [x, y] of [
    [68, 59],
    [76, 61],
    [84, 58],
    [90, 53],
  ] as const) {
    poligono(ctx, [
      [x - 3.2, y - 2],
      [x + 3.2, y - 2],
      [x, y + 3.6],
    ]);
    ctx.fill();
  }

  disco(ctx, 70, 41, 4.6);
  escuro(ctx);

  for (let i = 0; i < 3; i++) risco(ctx, 44 + i * 6, 41 + i, 42 + i * 6, 57 + i, 3.4);
}

function coruja(ctx: Ctx, cor: string, claro: string): void {
  for (const lado of [-1, 1]) {
    poligono(ctx, [
      [50 + lado * 31, 36],
      [50 + lado * 28, 5],
      [50 + lado * 8, 28],
    ]);
    silhueta(ctx, cor);
  }

  ctx.beginPath();
  ctx.moveTo(50, 19);
  ctx.bezierCurveTo(82, 19, 88, 50, 84, 65);
  ctx.bezierCurveTo(80, 84, 65, 94, 50, 94);
  ctx.bezierCurveTo(35, 94, 20, 84, 16, 65);
  ctx.bezierCurveTo(12, 50, 18, 19, 50, 19);
  ctx.closePath();
  silhueta(ctx, cor);

  // asas dobradas — dois arcos escuros que sugerem o corpo sem sujar a silhueta
  ctx.strokeStyle = TRACO;
  ctx.lineWidth = 4;
  for (const lado of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(50 + lado * 31, 56);
    ctx.quadraticCurveTo(50 + lado * 35, 77, 50 + lado * 20, 89);
    ctx.stroke();
  }

  // olhos enormes: o traço mais reconhecível da coruja
  for (const lado of [-1, 1]) {
    const x = 50 + lado * 15;
    disco(ctx, x, 51, 14.5);
    escuro(ctx);
    disco(ctx, x, 51, 8);
    ctx.fillStyle = claro;
    ctx.fill();
    disco(ctx, x + lado * 1.6, 51, 4);
    escuro(ctx);
  }

  poligono(ctx, [
    [50, 57],
    [42, 67],
    [58, 67],
  ]);
  silhueta(ctx, claro, 4);

  for (const lado of [-1, 1]) risco(ctx, 50 + lado * 8, 92, 50 + lado * 11, 98, 5);
}

function lobo(ctx: Ctx, cor: string, claro: string): void {
  for (const lado of [-1, 1]) {
    poligono(ctx, [
      [50 + lado * 29, 46],
      [50 + lado * 28, 7],
      [50 + lado * 5, 30],
    ]);
    silhueta(ctx, cor);
    poligono(ctx, [
      [50 + lado * 24, 40],
      [50 + lado * 23, 18],
      [50 + lado * 11, 31],
    ]);
    escuro(ctx);
  }

  poligono(ctx, [
    [22, 38],
    [38, 27],
    [62, 27],
    [78, 38],
    [73, 55],
    [61, 65],
    [57, 80],
    [50, 92],
    [43, 80],
    [39, 65],
    [27, 55],
  ]);
  silhueta(ctx, cor);

  poligono(ctx, [
    [41, 66],
    [59, 66],
    [50, 91],
  ]);
  silhueta(ctx, claro, 4);

  for (const lado of [-1, 1]) olhoAmendoa(ctx, 50 + lado * 13, 47, lado);

  poligono(ctx, [
    [45, 78],
    [55, 78],
    [50, 87],
  ]);
  escuro(ctx);
}

function touro(ctx: Ctx, cor: string, claro: string): void {
  // chifres: sobem, abrem e voltam para cima. É o contorno que resolve o touro sozinho.
  for (const lado of [-1, 1]) {
    tubo(
      ctx,
      () => {
        ctx.moveTo(50 + lado * 20, 34);
        ctx.quadraticCurveTo(50 + lado * 46, 32, 50 + lado * 43, 8);
      },
      claro,
      18,
      10,
    );
  }

  for (const lado of [-1, 1]) {
    elipse(ctx, 50 + lado * 33, 49, 12, 8, lado * 0.35);
    silhueta(ctx, cor, 7);
  }

  poligono(ctx, [
    [27, 31],
    [73, 31],
    [70, 58],
    [64, 76],
    [36, 76],
    [30, 58],
  ]);
  silhueta(ctx, cor);

  for (const dx of [-7, 0, 7]) risco(ctx, 50 + dx, 33, 50 + dx * 1.4, 42, 4.5);

  ctx.beginPath();
  ctx.roundRect(35, 59, 30, 21, 10);
  silhueta(ctx, claro, 5);

  for (const lado of [-1, 1]) {
    disco(ctx, 50 + lado * 11, 48, 5.4);
    escuro(ctx);
    elipse(ctx, 50 + lado * 7, 68, 3.6, 4.8, lado * 0.4);
    escuro(ctx);
  }

  // argola no focinho — nada lê como "touro" tão rápido quanto ela
  disco(ctx, 50, 86, 8.5);
  ctx.strokeStyle = TRACO;
  ctx.lineWidth = 6.5;
  ctx.stroke();
  ctx.strokeStyle = claro;
  ctx.lineWidth = 3;
  ctx.stroke();
}

function raposa(ctx: Ctx, cor: string, claro: string): void {
  // orelhas exageradas: é o que impede a raposa de ser lida como lobo no tamanho do tanque
  for (const lado of [-1, 1]) {
    poligono(ctx, [
      [50 + lado * 40, 52],
      [50 + lado * 32, 4],
      [50 + lado * 3, 34],
    ]);
    silhueta(ctx, cor);
    poligono(ctx, [
      [50 + lado * 32, 45],
      [50 + lado * 27, 16],
      [50 + lado * 12, 34],
    ]);
    escuro(ctx);
  }

  ctx.beginPath();
  ctx.moveTo(15, 41);
  ctx.quadraticCurveTo(50, 24, 85, 41);
  ctx.lineTo(66, 62);
  ctx.lineTo(55, 92);
  ctx.lineTo(45, 92);
  ctx.lineTo(34, 62);
  ctx.closePath();
  silhueta(ctx, cor);

  poligono(ctx, [
    [37, 58],
    [63, 58],
    [53, 91],
    [47, 91],
  ]);
  silhueta(ctx, claro, 4);

  for (const lado of [-1, 1]) olhoAmendoa(ctx, 50 + lado * 14, 47, lado);

  disco(ctx, 50, 86, 5.2);
  escuro(ctx);
}

function urso(ctx: Ctx, cor: string, claro: string): void {
  for (const lado of [-1, 1]) {
    disco(ctx, 50 + lado * 29, 25, 15);
    silhueta(ctx, cor);
    disco(ctx, 50 + lado * 29, 26, 7.2);
    escuro(ctx);
  }

  elipse(ctx, 50, 58, 33, 31);
  silhueta(ctx, cor);

  elipse(ctx, 50, 74, 21, 15);
  silhueta(ctx, claro, 5);

  for (const lado of [-1, 1]) {
    disco(ctx, 50 + lado * 13, 52, 5.6);
    escuro(ctx);
  }

  ctx.beginPath();
  ctx.roundRect(43, 63, 14, 10, 5);
  escuro(ctx);
  ctx.strokeStyle = TRACO;
  ctx.lineWidth = 3.6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(50, 73);
  ctx.lineTo(50, 79);
  ctx.moveTo(50, 79);
  ctx.lineTo(44, 82);
  ctx.moveTo(50, 79);
  ctx.lineTo(56, 82);
  ctx.stroke();
}

const DESENHOS: Record<AnimalId, (ctx: Ctx, cor: string, claro: string) => void> = {
  caranguejo,
  tigre,
  aguia,
  cobra,
  tubarao,
  coruja,
  lobo,
  touro,
  raposa,
  urso,
};

/** Desenha o animal na caixa 100×100 do `ctx` atual. */
export function desenharAnimal(ctx: Ctx, id: AnimalId, cor: number): void {
  ctx.save();
  ctx.miterLimit = 3;
  DESENHOS[id](ctx, hex(cor), realce(cor));
  ctx.restore();
}

/** Canvas quadrado com o emblema já desenhado e escalado para `lado` px de bitmap. */
export function canvasDoAnimal(id: AnimalId, cor: number, lado: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = lado;
  canvas.height = lado;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const escala = lado / CAIXA;
  ctx.setTransform(escala, 0, 0, escala, 0, 0);
  desenharAnimal(ctx, id, cor);
  return canvas;
}

/** Lado do bitmap dos emblemas. 128 cobre da pastilha de 18 px do killfeed ao cartão do lobby. */
const LADO = 128;

const cacheTextura = new Map<string, Texture>();
const cacheUrl = new Map<string, string>();

/** Textura Pixi do emblema da cor — para o sprite que acompanha o tanque na arena. */
export function texturaDoAnimal(cor: number): Texture {
  const id = animalDaCor(cor);
  const chave = `${id}:${cor}`;
  const pronta = cacheTextura.get(chave);
  if (pronta) return pronta;
  const textura = Texture.from(canvasDoAnimal(id, cor, LADO));
  // O emblema é desenhado em 128 e aparece na arena com ~26 px de mundo: sem mipmap a redução
  // serrilha justamente o contorno grosso que faz o bicho ler.
  textura.source.autoGenerateMipmaps = true;
  textura.source.scaleMode = 'linear';
  cacheTextura.set(chave, textura);
  return textura;
}

/** `data:` URL do emblema da cor — para os `<img>` do HUD, lobby, placar e tela de vencedor. */
export function urlDoAnimal(cor: number): string {
  const id = animalDaCor(cor);
  const chave = `${id}:${cor}`;
  const pronta = cacheUrl.get(chave);
  if (pronta) return pronta;
  const url = canvasDoAnimal(id, cor, LADO).toDataURL('image/png');
  cacheUrl.set(chave, url);
  return url;
}

/** Nome do animal da cor, já capitalizado para a interface. */
export function nomeDoAnimal(cor: number): string {
  return ANIMAL_NOME[animalDaCor(cor)];
}

/**
 * `<img>` pronto para entrar em qualquer `innerHTML` do HUD. A classe `bicho` (ver style.css) põe
 * o emblema numa pastilha ESCURA — sem ela o bicho, que é da cor do jogador, sumiria em cima das
 * faixas do placar e do lobby, que também são chapadas na cor dele.
 */
export function emblemaHtml(cor: number, classe = 'bicho'): string {
  const nome = nomeDoAnimal(cor);
  return `<img class="${classe}" src="${urlDoAnimal(cor)}" alt="${nome}" title="${nome}" />`;
}
