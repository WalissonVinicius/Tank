// Fase 12 §4 — "meu amigo não tá conseguindo entrar com código, só com o link completo".
//
// A normalização do código passou a ser CONTRATO entre as duas pontas. Estes testes prendem esse
// contrato: o que o servidor sorteia tem que sobreviver intacto à normalização do cliente, e o
// que uma pessoa digita de qualquer jeito plausível tem que chegar no mesmo código.

import {
  isRoomCode,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_AMBIGUOS,
  ROOM_CODE_LENGTH,
  temCaractereAmbiguo,
} from '../src/index.js';

import { describe, expect, it } from 'vitest';

describe('código de sala', () => {
  it('o alfabeto não tem nenhum caractere ambíguo', () => {
    for (const ch of ROOM_CODE_AMBIGUOS) {
      expect(ROOM_CODE_ALPHABET.includes(ch), `${ch} não deveria estar no alfabeto`).toBe(false);
    }
    // E não tem repetição — um caractere duplicado enviesaria o sorteio silenciosamente.
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(ROOM_CODE_ALPHABET.length);
  });

  it('todo código sorteável sobrevive à normalização sem mudar', () => {
    // Cobre o alfabeto inteiro em blocos de ROOM_CODE_LENGTH, rodando pelo início ao fim.
    for (let i = 0; i < ROOM_CODE_ALPHABET.length; i++) {
      let codigo = '';
      for (let j = 0; j < ROOM_CODE_LENGTH; j++) codigo += ROOM_CODE_ALPHABET[(i + j) % ROOM_CODE_ALPHABET.length];
      expect(normalizeRoomCode(codigo), codigo).toBe(codigo);
      expect(isRoomCode(codigo), codigo).toBe(true);
    }
  });

  it('aceita o que uma pessoa realmente digita', () => {
    // minúsculas, espaço no meio, espaço nas pontas, hífen de quem leu "A-B-2-C" em voz alta
    expect(normalizeRoomCode('ab2c')).toBe('AB2C');
    expect(normalizeRoomCode(' AB2C ')).toBe('AB2C');
    expect(normalizeRoomCode('A B 2 C')).toBe('AB2C');
    expect(normalizeRoomCode('a-b-2-c')).toBe('AB2C');
    expect(normalizeRoomCode('AB2C\n')).toBe('AB2C');
  });

  it('descarta o que nunca pode fazer parte de um código', () => {
    // O filtro antigo do campo era `[^A-Z0-9]`, mais largo que o alfabeto: dava para digitar
    // quatro caracteres impossíveis e ficar com "sala não encontrada" sem entender por quê.
    expect(normalizeRoomCode('I0O1')).toBe('');
    expect(normalizeRoomCode('AI0B')).toBe('AB');
    // Teclado ABNT2: o acento é tecla morta e sai um `Á` no lugar do `A`. A cedilha idem.
    expect(normalizeRoomCode('ÁB2Ç')).toBe('AB2C');
    expect(isRoomCode('AI0B')).toBe(false);
  });

  it('corta no comprimento do código, não guarda sobra', () => {
    expect(normalizeRoomCode('AB2CDEF')).toBe('AB2C');
    expect(normalizeRoomCode('AB2CDEF').length).toBe(ROOM_CODE_LENGTH);
  });

  it('entrada vazia ou ausente vira string vazia, nunca erro', () => {
    expect(normalizeRoomCode('')).toBe('');
    expect(normalizeRoomCode(null)).toBe('');
    expect(normalizeRoomCode(undefined)).toBe('');
    expect(isRoomCode(null)).toBe(false);
  });

  it('sinaliza o caractere ambíguo para o campo poder avisar em vez de sumir com ele', () => {
    expect(temCaractereAmbiguo('AI2C')).toBe(true);
    expect(temCaractereAmbiguo('ab0c')).toBe(true);
    expect(temCaractereAmbiguo('AB2C')).toBe(false);
    expect(temCaractereAmbiguo('')).toBe(false);
    expect(temCaractereAmbiguo(null)).toBe(false);
  });

  it('normalizar é idempotente', () => {
    for (const bruto of ['ab2c', ' A B 2 C ', 'AI0B', 'AB2CDEF', '', 'ÁB2Ç']) {
      const uma = normalizeRoomCode(bruto);
      expect(normalizeRoomCode(uma), bruto).toBe(uma);
    }
  });
});
