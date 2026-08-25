// Sorteio do código de 4 caracteres. O ALFABETO não mora mais aqui: ele é contrato entre as duas
// pontas (`@tank/protocol`), porque o campo de texto do lobby precisa filtrar exatamente o mesmo
// conjunto que este sorteio produz — ver `normalizeRoomCode`.
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@tank/protocol';

export function randomRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}
