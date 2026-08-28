import { describe, expect, it } from 'vitest';

import { AdaptadorDeQualidade, ehRenderizacaoPorSoftware } from '../src/render/adaptativo.js';
import type { NivelFx } from '../src/render/post.js';

interface Troca {
  s: number;
  nivel: NivelFx;
}

/**
 * Roda o adaptador com uma máquina de MENTIRA que responde ao degrau — o tempo de frame sai de
 * `custo(nivel, s)`, exatamente como na vida real, onde baixar a qualidade muda o tempo de frame
 * do frame seguinte. Testar com uma trilha de durações fixa esconderia justamente o laço fechado
 * que é o objeto desta tarefa.
 */
function simular(
  ad: AdaptadorDeQualidade,
  custo: (nivel: NivelFx, s: number) => number,
  segundos: number,
  t0 = 1000,
): Troca[] {
  let t = t0;
  const trocas: Troca[] = [];
  ad.amostrar(t);
  let nivel = ad.nivel;
  while (t - t0 < segundos * 1000) {
    t += custo(nivel, (t - t0) / 1000);
    const novo = ad.amostrar(t);
    if (novo !== null) {
      nivel = novo;
      trocas.push({ s: Math.round((t - t0) / 100) / 10, nivel: novo });
    }
  }
  return trocas;
}

/** Máquina folgada: 60 fps em qualquer degrau. */
const FOLGADA = (): number => 16.7;

describe('AdaptadorDeQualidade', () => {
  it('não mexe em nada numa máquina que fecha 60 fps', () => {
    const ad = new AdaptadorDeQualidade('alto');
    expect(simular(ad, FOLGADA, 180)).toEqual([]);
    expect(ad.nivel).toBe('alto');
  });

  it('desce um degrau quando a cadeia cheia não fecha o orçamento', () => {
    const ad = new AdaptadorDeQualidade('alto');
    // O notebook fraco: com a cadeia cheia dá 24 fps, sem ela fecha 60.
    const trocas = simular(ad, (nivel) => (nivel === 'alto' ? 41 : 16.7), 60);
    expect(trocas.map((x) => x.nivel)).toEqual(['reduzido']);
    // Adaptação RÁPIDA: menos de 8 s desde o carregamento, aquecimento incluído.
    expect(trocas[0]?.s).toBeLessThan(8);
  });

  it('desce a escada inteira, degrau a degrau, quando o frame é catastrófico', () => {
    const ad = new AdaptadorDeQualidade('alto');
    // SwiftShader: 560 ms de frame enquanto houver qualquer filtro, 20 ms sem nenhum.
    const trocas = simular(ad, (nivel) => (nivel === 'desligado' ? 20 : 560), 60);
    expect(trocas.map((x) => x.nivel)).toEqual(['reduzido', 'minimo', 'desligado']);
    // A reação começa rápido e o fundo da escada chega em segundos, não em meio minuto.
    expect(trocas[0]?.s).toBeLessThan(8);
    expect(trocas[2]?.s).toBeLessThan(20);
    expect(ad.trilha.every((t) => t.motivo === 'catastrofe')).toBe(true);
  });

  it('desce degrau a degrau enquanto cada um encurta o frame de verdade', () => {
    const ad = new AdaptadorDeQualidade('alto');
    const tabela: Record<NivelFx, number> = { alto: 70, reduzido: 55, minimo: 42, desligado: 16.7 };
    const trocas = simular(ad, (nivel) => tabela[nivel], 90);
    expect(trocas.map((x) => x.nivel)).toEqual(['reduzido', 'minimo', 'desligado']);
  });

  it('trava a escada quando descer não encurta o frame — o gargalo não é a cadeia', () => {
    const ad = new AdaptadorDeQualidade('alto');
    // Máquina limitada por CPU: 40 ms em TODO degrau. Desce uma vez para descobrir, e para.
    const trocas = simular(ad, () => 40, 120);
    expect(trocas.map((x) => x.nivel)).toEqual(['reduzido']);
    expect(ad.diagnostico.travada).toBe(true);
  });

  it('não confunde uma tela de 30 Hz com uma máquina fraca', () => {
    const ad = new AdaptadorDeQualidade('alto');
    expect(simular(ad, () => 33.3, 120)).toEqual([]);
    expect(ad.diagnostico.limiteRuimMs).toBeGreaterThan(33.3);
  });

  it('não volta para cima quando a descida foi o que resolveu', () => {
    const ad = new AdaptadorDeQualidade('alto');
    // Máquina que não fecha 60 fps com a cadeia cheia e fecha sem ela. Descer resolveu, então
    // subir de volta traria o problema de volta: a imagem muda UMA vez na partida inteira.
    const trocas = simular(ad, (nivel) => (nivel === 'alto' ? 41 : 16.7), 300);
    expect(trocas.map((x) => x.nivel)).toEqual(['reduzido']);
  });

  it('volta a subir quando o que atrapalhava era outra coisa e ela passou', () => {
    const ad = new AdaptadorDeQualidade('alto');
    // Outro programa comendo a CPU: 40 ms em TODO degrau (descer não adianta). Em 40 s ele fecha.
    const trocas = simular(ad, (_nivel, s) => (s > 40 ? 16.7 : 40), 120);
    expect(trocas.map((x) => x.nivel)).toEqual(['reduzido', 'alto']);
    // 25 s contínuos de folga é a exigência: a subida não pode acontecer logo depois da queda.
    expect(trocas[1]?.s ?? 0).toBeGreaterThanOrEqual(65);
  });

  it('nunca volta ao degrau que já falhou — no máximo uma oscilação', () => {
    const ad = new AdaptadorDeQualidade('alto');
    // Mesma máquina do teste anterior, só que o alívio dura pouco: aos 80 s o degrau cheio volta
    // a engasgar. A promoção foi um erro de julgamento e não se repete nunca mais.
    const trocas = simular(
      ad,
      (nivel, s) => (s <= 40 ? 40 : s < 80 || nivel !== 'alto' ? 16.7 : 41),
      400,
    );
    expect(trocas.map((x) => x.nivel)).toEqual(['reduzido', 'alto', 'reduzido']);
    expect(ad.nivel).toBe('reduzido');
  });

  it('não oscila em 5 minutos de máquina limitada por CPU', () => {
    const ad = new AdaptadorDeQualidade('alto');
    // Ruído de verdade em cima do regime: ±6 ms, e um engasgo isolado a cada ~2 s.
    let k = 0;
    const trocas = simular(
      ad,
      () => {
        k += 1;
        return (k % 120 === 0 ? 90 : 38) + ((k * 7919) % 13) - 6;
      },
      300,
    );
    expect(trocas.length).toBeLessThanOrEqual(1);
  });

  it('ignora a janela pedida pela troca de rodada', () => {
    const ad = new AdaptadorDeQualidade('alto');
    let t = 1000;
    ad.amostrar(t);
    for (let i = 0; i < 300; i++) {
      t += 16.7;
      ad.amostrar(t);
    }
    ad.ignorarPor(t, 4000);
    // 4 s de frames horríveis dentro da janela ignorada não podem derrubar nada.
    for (let i = 0; i < 20; i++) {
      t += 200;
      expect(ad.amostrar(t)).toBeNull();
    }
    expect(ad.nivel).toBe('alto');
  });

  it('aguenta um trecho ruim de 2 s logo no começo sem derrubar a qualidade', () => {
    // Outro programa abrindo enquanto o jogo carrega. A pressa inicial não pode virar uma
    // sentença: "nunca por precaução" é regra da especificação.
    const ad = new AdaptadorDeQualidade('alto');
    const trocas = simular(ad, (_nivel, s) => (s > 3 && s < 5 ? 30 : 16.7), 60);
    expect(trocas).toEqual([]);
    expect(ad.nivel).toBe('alto');
  });

  it('não trata a cauda de um engasgo isolado como catástrofe', () => {
    // Rabo da troca de rodada: quatro frames longos em fila e o jogo volta ao normal. Não pode
    // derrubar dois degraus de uma vez — é exatamente o que a régua de VÃO existe para impedir.
    const ad = new AdaptadorDeQualidade('alto');
    let t = 1000;
    ad.amostrar(t);
    for (let i = 0; i < 400; i++) {
      t += 16.7;
      ad.amostrar(t);
    }
    for (let i = 0; i < 4; i++) {
      t += 180;
      expect(ad.amostrar(t)).toBeNull();
    }
    for (let i = 0; i < 400; i++) {
      t += 16.7;
      ad.amostrar(t);
    }
    expect(ad.nivel).toBe('alto');
  });

  it('não derruba a qualidade quando o navegador baixa o rAF para 1 Hz', () => {
    // Janela coberta por outra: o Chrome passa a chamar o rAF 1×/s e o `document.hidden` continua
    // false. Sem o descarte por duração o jogo voltaria do alt-tab no degrau sem filtros.
    const ad = new AdaptadorDeQualidade('alto');
    let t = 1000;
    ad.amostrar(t);
    for (let i = 0; i < 400; i++) {
      t += 16.7;
      ad.amostrar(t);
    }
    for (let i = 0; i < 40; i++) {
      t += 1000;
      expect(ad.amostrar(t)).toBeNull();
    }
    expect(ad.nivel).toBe('alto');
  });

  it('não mexe no degrau quando o jogador forçou por ?fx=', () => {
    const ad = new AdaptadorDeQualidade('alto', true);
    expect(simular(ad, () => 600, 90)).toEqual([]);
    expect(ad.nivel).toBe('alto');
  });

  it('descarta os frames em que a aba esteve escondida', () => {
    const ad = new AdaptadorDeQualidade('alto');
    let t = 1000;
    ad.amostrar(t);
    for (let i = 0; i < 400; i++) {
      t += 16.7;
      ad.amostrar(t);
    }
    for (let i = 0; i < 30; i++) {
      t += 1000;
      expect(ad.amostrar(t, false)).toBeNull();
    }
    expect(ad.nivel).toBe('alto');
  });

  it('registra a trilha com o segundo e o motivo de cada troca', () => {
    const ad = new AdaptadorDeQualidade('alto');
    simular(ad, (nivel) => (nivel === 'desligado' ? 20 : 560), 40);
    expect(ad.trilha).toHaveLength(3);
    expect(ad.trilha[0]).toMatchObject({ de: 'alto', para: 'reduzido', motivo: 'catastrofe' });
    expect(ad.trilha[0]?.s).toBeGreaterThan(0);
  });

  it('começa de onde mandarem — é assim que a detecção de software entra', () => {
    const ad = new AdaptadorDeQualidade('desligado');
    expect(ad.nivel).toBe('desligado');
    // E não tenta subir: quem começou no fim da escada foi posto ali de propósito.
    expect(simular(ad, FOLGADA, 180)).toEqual([]);
  });
});

describe('ehRenderizacaoPorSoftware', () => {
  it('reconhece os rasterizadores por software', () => {
    for (const nome of [
      'Google SwiftShader',
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)',
      'Mesa/X.org, llvmpipe (LLVM 15.0.7, 256 bits)',
      'Microsoft Basic Render Driver',
      'Apple Software Renderer',
    ]) {
      expect(ehRenderizacaoPorSoftware(nome)).toBe(true);
    }
  });

  it('não confunde uma GPU de verdade com software', () => {
    for (const nome of [
      'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'Adreno (TM) 730',
      'Apple GPU',
      'Mali-G78',
    ]) {
      expect(ehRenderizacaoPorSoftware(nome)).toBe(false);
    }
  });
});
