// A BATALHA: o campeonato entre as IAs disponíveis.
//
// Não é teste de unidade — é o placar que decide qual estratégia entra no jogo. Roda com
// `pnpm vitest run packages/shared-sim/test/batalha.test.ts` e imprime a tabela.
//
// A regra do torneio: todo mundo joga contra todo mundo, 100 partidas por confronto, lados
// trocados na metade. Quem ganha vira o padrão do jogo.
//
// O único `expect` aqui é o que protege a ORDEM esperada (difícil > médio > fácil). Se um dia
// alguém "melhorar" o bot difícil e ele perder para o médio, este arquivo falha e conta.

import { describe, expect, it } from 'vitest';
import { BOT_DIFFICULTY, makeBot } from '@tank/shared-sim';
import { duelar, linhaPlacar, type Competidor } from './arena.js';

// O `console` vem pelo `globalThis`: `shared-sim` é matemática pura e não declara ambiente
// (nem DOM nem Node) no tsconfig — mesmo padrão do bot-esperto.test.ts.
const registrar = (m: string): void =>
  (globalThis as { console?: { log(mensagem: string): void } }).console?.log(m);

const facil: Competidor = { nome: 'fácil', criar: (rng) => makeBot(rng, BOT_DIFFICULTY.facil) };
const medio: Competidor = { nome: 'médio', criar: (rng) => makeBot(rng, BOT_DIFFICULTY.medio) };
const dificil: Competidor = { nome: 'difícil', criar: (rng) => makeBot(rng, BOT_DIFFICULTY.dificil) };

describe('batalha de IAs — todos contra todos', () => {
  it('difícil vence fácil com folga', () => {
    const p = duelar(dificil, facil, 100);
    registrar(`[batalha] ${linhaPlacar(dificil, facil, p)}`);
    expect(p.a).toBeGreaterThan(p.b);
  });

  it('difícil vence médio', () => {
    const p = duelar(dificil, medio, 100);
    registrar(`[batalha] ${linhaPlacar(dificil, medio, p)}`);
    expect(p.a).toBeGreaterThan(p.b);
  });

  it('médio vence fácil', () => {
    const p = duelar(medio, facil, 100);
    registrar(`[batalha] ${linhaPlacar(medio, facil, p)}`);
    expect(p.a).toBeGreaterThan(p.b);
  });

  // Determinismo é pré-requisito de tudo: sem ele o placar de ontem não se compara com o de hoje,
  // e o multiplayer (que roda a MESMA simulação no servidor e em cada cliente) dessincroniza.
  it('o placar é determinístico — mesma entrada, mesmo resultado', () => {
    const um = duelar(dificil, facil, 20);
    const dois = duelar(dificil, facil, 20);
    expect(dois).toEqual(um);
  });
});
