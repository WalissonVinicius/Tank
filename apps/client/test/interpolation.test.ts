import { describe, expect, it } from 'vitest';
import { SNAPSHOT_HZ, TANK_SPEED } from '@tank/protocol';
import { InterpolationBuffer } from '../src/net/interpolation.js';

const PERIODO_MS = 1000 / SNAPSHOT_HZ; // 50 ms entre snapshots a 20 Hz
const ATRASO_MS = PERIODO_MS + 10; // mesmo INTERP_DELAY_MS usado por main.ts

/**
 * A prova de que o tanque remoto anda liso não pode depender do frame rate do navegador (num
 * headless com SwiftShader ele despenca para poucos fps e QUALQUER coisa parece "teleporte").
 * Aqui o buffer é alimentado com snapshots de 20 Hz de um tanque em linha reta a TANK_SPEED e
 * amostrado a 60 fps: o que se mede é a interpolação em si.
 */
describe('InterpolationBuffer — suavização do tanque remoto', () => {
  it('a 60 fps devolve posições intermediárias entre snapshots de 20 Hz, sem salto nem recuo', () => {
    const buf = new InterpolationBuffer(ATRASO_MS);
    const t0 = 1000;
    const posEm = (ms: number): number => (TANK_SPEED * ms) / 1000;

    const amostras: { t: number; x: number }[] = [];
    let proximoSnapshot = t0;

    for (let t = t0; t <= t0 + 1000; t += 1000 / 60) {
      while (proximoSnapshot <= t) {
        // o snapshot carrega a posição do servidor NAQUELE instante
        buf.push('remoto', {
          t: proximoSnapshot,
          x: posEm(proximoSnapshot - t0),
          y: 0,
          heading: 0,
          turret: 0,
          alive: true,
        });
        proximoSnapshot += PERIODO_MS;
      }
      const s = buf.sample('remoto', t);
      if (s) amostras.push({ t, x: s.x });
    }

    expect(amostras.length).toBeGreaterThan(50);

    let maiorSalto = 0;
    let recuos = 0;
    let posicoesDistintas = 0;
    for (let i = 1; i < amostras.length; i++) {
      const d = amostras[i]!.x - amostras[i - 1]!.x;
      if (d < -1e-9) recuos++;
      if (Math.abs(d) > 1e-9) posicoesDistintas++;
      maiorSalto = Math.max(maiorSalto, Math.abs(d));
    }

    // A 60 fps e 60 px/s, um passo "liso" é 1 px. Um render sem interpolação daria degraus de
    // 3 px (o deslocamento de um período inteiro de snapshot) a cada 50 ms.
    const passoLiso = TANK_SPEED / 60;
    expect(maiorSalto).toBeLessThan(passoLiso * 1.6);
    expect(recuos).toBe(0);
    // Praticamente todo frame anda um pouco: nada de congelar esperando o próximo snapshot.
    expect(posicoesDistintas).toBeGreaterThan(amostras.length * 0.9);
  });

  it('sem snapshot novo, congela na última amostra em vez de extrapolar para fora do mapa', () => {
    const buf = new InterpolationBuffer(ATRASO_MS);
    buf.push('remoto', { t: 0, x: 0, y: 0, heading: 0, turret: 0, alive: true });
    buf.push('remoto', { t: PERIODO_MS, x: 3, y: 0, heading: 0, turret: 0, alive: true });

    const congelado = buf.sample('remoto', 5_000);
    expect(congelado?.x).toBe(3);
  });

  it('interpola o ângulo pelo caminho curto ao cruzar ±π', () => {
    const buf = new InterpolationBuffer(0);
    buf.push('remoto', { t: 0, x: 0, y: 0, heading: Math.PI - 0.1, turret: 0, alive: true });
    buf.push('remoto', { t: 100, x: 0, y: 0, heading: -Math.PI + 0.1, turret: 0, alive: true });

    const meio = buf.sample('remoto', 50);
    // O caminho curto passa por ±π (0,2 rad de arco), não pela volta inteira de 6,08 rad.
    const distanciaDePi = Math.min(Math.abs(Math.abs(meio!.heading) - Math.PI), Math.abs(meio!.heading));
    expect(distanciaDePi).toBeLessThan(0.05);
  });
});
