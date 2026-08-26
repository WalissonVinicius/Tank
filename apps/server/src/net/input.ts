import { decodeAim, direcaoDeMovimento } from '@tank/protocol';
import type { Input } from '@tank/shared-sim';

/**
 * Formato de entrada do jogador — mensagem `input` do cliente: `{ seq, bits, aim }`.
 *
 * `bits` é 1 byte com 5 flags (bitfield, mesma semântica de `InputMsg.up/down/left/right/fire`
 * do `@tank/protocol`, só que compactado para economizar banda a 30 Hz):
 *   bit 0 (0x01) — andar para cima na tela
 *   bit 1 (0x02) — andar para baixo na tela
 *   bit 2 (0x04) — andar para a esquerda na tela
 *   bit 3 (0x08) — andar para a direita na tela
 *   bit 4 (0x10) — atirar (borda de subida detectada no cliente)
 *
 * A direção do movimento é BOOLEANA na rede de propósito: 4 bits são baratos e não têm valor
 * inválido possível, enquanto um float de ângulo vindo do cliente seria entrada não confiável
 * (mandar 0,001 rad de cada vez daria uma precisão de movimento que o teclado não dá a ninguém).
 * Quem transforma os bits em ângulo é `direcaoDeMovimento`, do `@tank/protocol` — a MESMA função
 * que o cliente usa nas próprias teclas, para as duas pontas derivarem a mesma direção.
 *
 * `aim` é 1 byte com a direção do cursor do mouse quantizada em 256 passos (0..255 → 0..2π,
 * ≈1,4° cada). A torre gira devagar (`TURRET_RATE`), então essa resolução é invisível na tela.
 * A mira é ENTRADA como qualquer outra: entra no mesmo `Input` do `shared-sim` e é o `step()`
 * determinístico que decide quanto a torre girou naquele tick.
 *
 * O cliente precisa espelhar exatamente esta codificação ao empacotar o input.
 */
export interface InputBitsMsg {
  seq: number;
  bits: number;
  aim: number;
}

const BIT_UP = 0x01;
const BIT_DOWN = 0x02;
const BIT_LEFT = 0x04;
const BIT_RIGHT = 0x08;
const BIT_FIRE = 0x10;

export function decodeInputBits(bits: number, aim?: number): Input {
  const up = (bits & BIT_UP) !== 0;
  const down = (bits & BIT_DOWN) !== 0;
  const left = (bits & BIT_LEFT) !== 0;
  const right = (bits & BIT_RIGHT) !== 0;
  const fire = (bits & BIT_FIRE) !== 0;

  return {
    mover: direcaoDeMovimento(up, down, left, right),
    fire,
    // Cliente antigo (ou pacote sem o campo): sem mira o `step()` deixa a torre parada, em vez
    // de fabricar um ângulo que a outra ponta não conhece.
    aim: typeof aim === 'number' ? decodeAim(aim) : undefined,
  };
}
