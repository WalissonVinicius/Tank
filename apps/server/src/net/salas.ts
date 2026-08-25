// Listagem de salas abertas (Fase 13 §2).
//
// A fonte é o CADASTRO DO MATCHMAKER (`matchMaker.query`), não um registro paralelo: cada
// `TankRoom` publica no próprio `metadata` quantos humanos e quantos bots tem e em que fase está
// (ver `publicarSala`), e aqui isso vira a lista que a tela de entrada desenha. Um registro à
// parte teria que ser mantido em sincronia com criação, entrada, saída e morte de sala — três
// caminhos a mais para ficar desatualizado.
import { matchMaker } from '@colyseus/core';
import { VAGAS_POR_SALA, type SalaAberta, type SalaMetadata } from '@tank/protocol';

/** Nome do tipo de sala registrado em `gameServer.define`. */
export const TIPO_DE_SALA = 'tank_room';

/**
 * Salas em que ainda dá para entrar, na ordem em que aparecem na tela: primeiro as que ainda não
 * começaram (é onde se entra jogando), depois as em partida (onde se entra assistindo); dentro de
 * cada grupo, as mais cheias primeiro — sala com gente é mais convidativa que sala vazia.
 *
 * Fica de fora quem já acabou (`gameover`, ninguém mais entra) e quem não tem nem vaga de
 * espectador. Sala sem metadata é sala recém-criada que ainda não publicou: some da lista por um
 * instante e aparece na atualização seguinte.
 */
export async function listarSalasAbertas(): Promise<SalaAberta[]> {
  const cadastro = await matchMaker.query({ name: TIPO_DE_SALA });

  const salas: SalaAberta[] = [];
  for (const sala of cadastro) {
    const meta = sala.metadata as SalaMetadata | undefined;
    if (!meta || typeof meta.codigo !== 'string') continue;
    if (meta.fase === 'gameover') continue;
    if (sala.clients >= sala.maxClients) continue;

    const ocupadas = Math.min(VAGAS_POR_SALA, meta.humanos + meta.bots);
    const emPartida = meta.fase !== 'lobby';
    // Sala cheia e parada no lobby não recebe ninguém: a vaga só abre quando alguém sai. Em
    // partida a lotação não impede — quem chega assiste e entra na rodada seguinte.
    if (!emPartida && ocupadas >= VAGAS_POR_SALA) continue;

    salas.push({
      codigo: meta.codigo,
      humanos: meta.humanos,
      bots: meta.bots,
      livres: VAGAS_POR_SALA - ocupadas,
      emPartida,
    });
  }

  salas.sort((a, b) => {
    if (a.emPartida !== b.emPartida) return a.emPartida ? 1 : -1;
    const gente = b.humanos - a.humanos;
    if (gente !== 0) return gente;
    return a.codigo < b.codigo ? -1 : a.codigo > b.codigo ? 1 : 0;
  });

  return salas;
}
