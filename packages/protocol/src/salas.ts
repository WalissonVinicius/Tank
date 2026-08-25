// Listagem de salas abertas (Fase 13 §2) — contrato entre o endpoint do servidor e a tela de
// entrada do cliente. Antes disso só se entrava sabendo o código de 4 letras de cor; quem chegava
// depois do link ficar para trás no chat não tinha por onde começar.

/**
 * Rota HTTP da listagem. Em produção o próprio Node serve o client, então é a origem crua; em
 * desenvolvimento o Vite proxeia `/colyseus/*` para a porta 3000 e o prefixo é reescrito — ver
 * `apps/client/src/net/salas.ts`.
 */
export const ROTA_SALAS = '/salas';

/** Quantas vagas de JOGADOR uma sala tem. Além disso ainda cabe espectador (ver `MAX_CLIENTS`). */
export const VAGAS_POR_SALA = 10;

/** Uma sala como ela aparece na tela de entrada. */
export interface SalaAberta {
  /** Código de 4 letras — o mesmo que se digita à mão. */
  codigo: string;
  /** Pessoas de verdade na sala (não conta bot). */
  humanos: number;
  /** Bots ocupando vaga. */
  bots: number;
  /** Vagas de jogador ainda livres. 0 com a sala cheia — dá para entrar como espectador. */
  livres: number;
  /**
   * A partida já começou. Quem entra numa dessas vira ESPECTADOR e passa a jogar na rodada
   * seguinte (é o que o servidor já fazia para quem chegava pelo código no meio do jogo).
   */
  emPartida: boolean;
}

/** O que cada sala publica no `metadata` do matchMaker, de onde a listagem é montada. */
export interface SalaMetadata {
  codigo: string;
  humanos: number;
  bots: number;
  /** Fase da sala. `gameover` some da lista: a partida acabou e ninguém mais entra nela. */
  fase: 'lobby' | 'countdown' | 'playing' | 'roundend' | 'gameover';
}
