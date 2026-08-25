// Cores dos 10 jogadores e paleta do mundo — fonte única da verdade (CLAUDE.md).

// Fase 10: a paleta foi SATURADA a pedido do usuário ("cor dos tank pode ser mais viva também").
// São as mesmas 10 famílias de matiz de antes, empurradas para o croma máximo que ainda:
//   · mantém as 10 distinguíveis entre si (matizes espalhados ~36° em média);
//   · lê bem sobre o piso azul-ardósia (#141a2b) — todas bem mais claras que o fundo;
//   · aceita TEXTO ESCURO por cima, porque na interface nova a faixa do jogador é chapada na
//     cor dele e o nome é escrito em cima (contraste mínimo medido: ~5,2:1 no rosa e no roxo).
// O índigo (7) é o único que ficou de propósito mais claro que o "puro": abaixo disto ele
// escurece demais e o nome escrito por cima deixa de ler.
export const PLAYER_COLORS: number[] = [
  0xff2e63, 0xff7a1a, 0xffd400, 0x5ceb3f, 0x00f0c8,
  0x2ec6ff, 0x7d8cff, 0xc05cff, 0xff4fd8, 0xe9eef8,
];

export const TEST_PLAYER_NAMES: string[] = [
  'Ana', 'Bruno', 'Carla', 'Diego', 'Elisa',
  'Fábio', 'Gabi', 'Hugo', 'Ítalo', 'Júlia',
];

export const WORLD_COLORS = {
  background: 0x0b0f1a,
  floor: 0x141a2b,
  wall: 0x1f2a44,
  wallTop: 0x3a4a73,
  warmLight: 0xffb347,
  alert: 0xff3b3b,
  lightmapAmbient: 0x1e2236,
} as const;
