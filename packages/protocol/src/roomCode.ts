// Código de sala — FONTE ÚNICA da verdade do alfabeto e da normalização (Fase 12 §4).
//
// O código nasce no servidor (`apps/server/src/util/roomCode.ts`) e morre no campo de texto do
// lobby, mas até aqui cada ponta tinha a própria ideia do que era um código válido: o servidor
// sorteava de um alfabeto sem caracteres ambíguos e o campo do cliente filtrava por um regex
// próprio, mais largo. Duas definições para a mesma coisa é o tipo de divergência que produz
// "digitei o código e não entrei; pelo link inteiro funcionou" — o relato que abriu esta fase.
//
// Agora as duas pontas importam daqui.

/**
 * Alfabeto do código de sala. NÃO tem `I`, `O`, `0` nem `1`: são os quatro caracteres que as
 * pessoas confundem lendo em voz alta ou olhando a tela do colega do outro lado da mesa, que é
 * como o código circula no escritório.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Comprimento do código. */
export const ROOM_CODE_LENGTH = 4;

/**
 * Caracteres que o alfabeto evita justamente por serem confundidos com os que ele usa. Digitar um
 * deles é sempre erro de leitura — e vale AVISAR, não adivinhar: `1` tanto pode ser `L` quanto
 * `I`, e chutar erraria mais do que acerta, trocando "caractere impossível" por "sala não
 * encontrada", que é uma mensagem pior.
 */
export const ROOM_CODE_AMBIGUOS = 'IO01';

/**
 * Marcas de acento combinantes do Unicode (U+0300–U+036F), que é no que `normalize('NFD')`
 * transforma o acento de `Á`, o til de `Ã` e a cedilha de `Ç`. Escrito por código, não por
 * literal: uma faixa de caracteres invisíveis no meio de um regex é impossível de revisar.
 */
const MARCAS_DE_ACENTO = new RegExp(`[\u{0300}-\u{036F}]`, 'gu');

/**
 * Deixa o que o jogador digitou no formato exato que o servidor conhece: sem espaço, sem hífen,
 * maiúsculo, só caracteres do alfabeto, no máximo `ROOM_CODE_LENGTH`.
 *
 * É a MESMA função no filtro do campo de texto e no `join` — normalizar em dois lugares
 * diferentes é como as duas pontas passam a discordar.
 */
export function normalizeRoomCode(bruto: string | null | undefined): string {
  if (!bruto) return '';
  // Tira o acento antes de filtrar: num teclado ABNT2 o acento agudo é tecla morta, e um `Á` no
  // lugar do `A` (ou um `Ç` no lugar do `C`) é errata de digitação, não outro caractere. Sem esta
  // dobra ele seria descartado e o código ficaria curto sem o jogador entender o motivo.
  const semAcento = bruto.normalize('NFD').replace(MARCAS_DE_ACENTO, '');
  let saida = '';
  for (const ch of semAcento.toUpperCase()) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) continue;
    saida += ch;
    if (saida.length === ROOM_CODE_LENGTH) break;
  }
  return saida;
}

/** `true` quando o texto já é um código completo e válido. */
export function isRoomCode(bruto: string | null | undefined): boolean {
  return normalizeRoomCode(bruto).length === ROOM_CODE_LENGTH;
}

/** `true` se o jogador digitou algum caractere que o alfabeto evita — rende um aviso, não um erro. */
export function temCaractereAmbiguo(bruto: string | null | undefined): boolean {
  if (!bruto) return false;
  for (const ch of bruto.toUpperCase()) {
    if (ROOM_CODE_AMBIGUOS.includes(ch)) return true;
  }
  return false;
}
