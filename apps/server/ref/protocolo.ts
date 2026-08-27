import {
  ANIMAL_NOME,
  MessageType,
  PLAYER_ANIMALS,
  PLAYER_COLORS,
  POWERUP,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROTA_SALAS,
  TEST_PLAYER_NAMES,
  TIPOS_DE_POWERUP,
  TransportType,
  VAGAS_POR_SALA,
  animalDaCor,
} from '@tank/protocol';

console.log(
  JSON.stringify({
    cores: PLAYER_COLORS,
    nomes: TEST_PLAYER_NAMES,
    animais: PLAYER_ANIMALS,
    nomeDoAnimal: ANIMAL_NOME,
    animalPorCor: PLAYER_COLORS.map((c) => animalDaCor(c)),
    alfabeto: ROOM_CODE_ALPHABET,
    tamanhoDoCodigo: ROOM_CODE_LENGTH,
    vagas: VAGAS_POR_SALA,
    rotaSalas: ROTA_SALAS,
    canais: MessageType,
    transporte: TransportType,
    duracoes: Object.fromEntries(TIPOS_DE_POWERUP.map((t) => [t, POWERUP[t].duracao])),
  }),
);
