// Identidade ANIMAL de cada jogador (Fase 11).
//
// Um animal por COR, em PAR FIXO: a cor 0 é sempre o caranguejo, a 1 sempre o tigre, e assim por
// diante. Isso é de propósito — a regra de unicidade que o servidor já aplica à cor passa a valer
// para o animal de graça, sem um segundo mecanismo e sem um campo novo no wire. O índice na
// paleta É o índice aqui.
//
// Critério de cada dupla: a cor tem que EMPURRAR a leitura do bicho (caranguejo vermelho, tigre
// laranja, cobra verde, urso polar branco) e, quando duas silhuetas correm risco de se confundir
// no tamanho do tanque — lobo × raposa é o par crítico —, as cores ficam em pontas opostas do
// círculo cromático (índigo × magenta).

import { PLAYER_COLORS } from './colors.js';

export type AnimalId =
  | 'caranguejo'
  | 'tigre'
  | 'aguia'
  | 'cobra'
  | 'tubarao'
  | 'coruja'
  | 'lobo'
  | 'touro'
  | 'raposa'
  | 'urso';

/** Mesma ordem de `PLAYER_COLORS` — índice a índice. */
export const PLAYER_ANIMALS: readonly AnimalId[] = [
  'caranguejo', // #ff2e63 rosa-vermelho
  'tigre', //      #ff7a1a laranja
  'aguia', //      #ffd400 amarelo
  'cobra', //      #5ceb3f verde
  'tubarao', //    #00f0c8 turquesa
  'coruja', //     #2ec6ff azul
  'lobo', //       #7d8cff índigo
  'touro', //      #c05cff roxo
  'raposa', //     #ff4fd8 magenta
  'urso', //       #e9eef8 osso
];

/** Nome em pt-BR para a interface (lobby, placar, killfeed). */
export const ANIMAL_NOME: Record<AnimalId, string> = {
  caranguejo: 'Caranguejo',
  tigre: 'Tigre',
  aguia: 'Águia',
  cobra: 'Cobra',
  tubarao: 'Tubarão',
  coruja: 'Coruja',
  lobo: 'Lobo',
  touro: 'Touro',
  raposa: 'Raposa',
  urso: 'Urso',
};

export function animalDoIndice(i: number): AnimalId {
  return PLAYER_ANIMALS[((i % PLAYER_ANIMALS.length) + PLAYER_ANIMALS.length) % PLAYER_ANIMALS.length]!;
}

/**
 * Animal de uma cor da paleta. Cor fora da paleta (fallback de render, tanque sem dono conhecido)
 * cai no primeiro animal — é decoração, nunca deve derrubar o desenho.
 */
export function animalDaCor(cor: number): AnimalId {
  const i = PLAYER_COLORS.indexOf(cor);
  return animalDoIndice(i < 0 ? 0 : i);
}
