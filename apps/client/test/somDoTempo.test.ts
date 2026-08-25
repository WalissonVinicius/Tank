// Contagem sonora do fim de rodada (Fase 10 §4). O que estes testes fixam é a REGRA, não o
// timbre: um tique por segundo nos últimos 10, tom subindo, uma buzina diferente no zero e
// nenhum som antes da hora nem repetido no mesmo segundo.
import { describe, expect, it } from 'vitest';
import { AVISO_TEMPO_S, SOM_TEMPO_ESGOTADO, criarContagemSonora, somDoTique } from '../src/somDoTempo.js';
import type { ContagemSonora } from '../src/somDoTempo.js';

/** Índice do parâmetro de FREQUÊNCIA no preset do zzfx (o terceiro da lista). */
const FREQ = 2;
/** Índice do parâmetro de VOLUME (o primeiro). */
const VOL = 0;

function gravador(): { tocados: number[][]; tocar: (som: readonly number[]) => void } {
  const tocados: number[][] = [];
  return { tocados, tocar: (som) => void tocados.push([...som]) };
}

/**
 * Roda o relógio de `de` até `ate` segundos restantes no passo de um frame de 60 Hz — que é como
 * o jogo chama de verdade, muitas vezes por segundo com o mesmo valor arredondado.
 */
function correr(contagem: ContagemSonora, de: number, ate: number): void {
  const passo = 1 / 60;
  for (let t = de; t > ate + passo / 2; t -= passo) contagem.acompanhar(t, true);
  contagem.acompanhar(ate, true);
}

describe('contagem sonora dos últimos segundos', () => {
  it('não toca nada enquanto sobra mais que o limiar', () => {
    const { tocados, tocar } = gravador();
    const contagem = criarContagemSonora(tocar);
    correr(contagem, 45, AVISO_TEMPO_S + 0.5);
    expect(tocados).toHaveLength(0);
  });

  it('toca exatamente um tique por segundo nos últimos 10 e uma buzina no zero', () => {
    const { tocados, tocar } = gravador();
    const contagem = criarContagemSonora(tocar);
    correr(contagem, 45, 1 / 60);
    contagem.fimDoTempo();

    // 10 tiques (10, 9, …, 1) + a buzina do zero.
    expect(tocados).toHaveLength(AVISO_TEMPO_S + 1);
    expect(tocados[tocados.length - 1]).toEqual([...SOM_TEMPO_ESGOTADO]);
    // Nenhum dos tiques é a buzina.
    for (const som of tocados.slice(0, -1)) {
      expect(som).not.toEqual([...SOM_TEMPO_ESGOTADO]);
    }
  });

  it('o tom e o volume SOBEM conforme o tempo acaba', () => {
    const { tocados, tocar } = gravador();
    const contagem = criarContagemSonora(tocar);
    correr(contagem, 45, 1 / 60);
    contagem.fimDoTempo();

    const tiques = tocados.slice(0, -1);
    for (let i = 1; i < tiques.length; i++) {
      expect(tiques[i]![FREQ], `tique ${i}`).toBeGreaterThan(tiques[i - 1]![FREQ]!);
      expect(tiques[i]![VOL], `tique ${i}`).toBeGreaterThan(tiques[i - 1]![VOL]!);
    }
    expect(somDoTique(AVISO_TEMPO_S)[FREQ]).toBe(620);
    expect(somDoTique(1)[FREQ]).toBe(1160);
  });

  it('sair da rodada rearma a contagem — a rodada seguinte volta a tocar do 10', () => {
    const { tocados, tocar } = gravador();
    const contagem = criarContagemSonora(tocar);

    correr(contagem, 12, 6);
    const naPrimeira = tocados.length;
    expect(naPrimeira).toBe(5); // 10, 9, 8, 7, 6

    contagem.acompanhar(0, false); // fim de rodada / placar
    correr(contagem, 12, 6);
    expect(tocados.length - naPrimeira, 'a rodada nova conta de novo').toBe(5);
  });

  it('a buzina de fim de tempo toca uma vez só, mesmo pedida duas vezes', () => {
    const { tocados, tocar } = gravador();
    const contagem = criarContagemSonora(tocar);
    correr(contagem, 3, 1 / 60);
    const antes = tocados.length;
    contagem.fimDoTempo();
    contagem.fimDoTempo();
    contagem.acompanhar(0, true);
    expect(tocados.length - antes).toBe(1);
    expect(tocados[tocados.length - 1]).toEqual([...SOM_TEMPO_ESGOTADO]);
  });

  it('um valor repetido no mesmo segundo não toca duas vezes', () => {
    const { tocados, tocar } = gravador();
    const contagem = criarContagemSonora(tocar);
    for (let i = 0; i < 200; i++) contagem.acompanhar(4.5, true);
    expect(tocados).toHaveLength(1);
  });

  it('o relógio andando para trás por reconexão não dispara uma rajada de tiques', () => {
    const { tocados, tocar } = gravador();
    const contagem = criarContagemSonora(tocar);
    correr(contagem, 10, 3);
    const antes = tocados.length;
    // O servidor reenvia um `timeLeft` mais alto (snapshot atrasado): o estado se rearma e o
    // próximo tique é o do segundo novo, um só — não um por segundo pulado.
    contagem.acompanhar(30, true);
    contagem.acompanhar(9.2, true);
    expect(tocados.length - antes).toBe(1);
  });
});
