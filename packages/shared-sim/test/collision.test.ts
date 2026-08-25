import { describe, expect, it } from 'vitest';
import { circleVsAabbSlide, raycastSegment, reflect } from '../src/index.js';

describe('colisão', () => {
  it('bala disparada contra parede perpendicular volta com ângulo espelhado', () => {
    const wall = { x: 100, y: 0, w: 10, h: 200 };
    const from = { x: 50, y: 100 };
    const to = { x: 150, y: 100 };

    const hit = raycastSegment(from, to, [wall]);
    expect(hit).not.toBeNull();

    const reflected = reflect({ x: 1, y: 0 }, hit!.normal);
    expect(reflected.x).toBeCloseTo(-1, 5);
    expect(reflected.y).toBeCloseTo(0, 5);
  });

  it('bala em quina reflete nos dois eixos e não fica presa', () => {
    // Duas paredes que se tocam formando uma quina externa em (100,100), como os segmentos
    // mesclados do labirinto real.
    const wallA = { x: 100, y: 0, w: 10, h: 100 };
    const wallB = { x: 100, y: 100, w: 100, h: 10 };
    const walls = [wallA, wallB];

    const from = { x: 90, y: 90 };
    const to = { x: 110, y: 110 }; // mira direto na quina

    const hit = raycastSegment(from, to, walls);
    expect(hit).not.toBeNull();

    const dir = { x: 1, y: 1 };
    const reflected = reflect(dir, hit!.normal);

    // reflexão de verdade: a direção geral se inverte (produto escalar negativo)...
    const dot = dir.x * reflected.x + dir.y * reflected.y;
    expect(dot).toBeLessThan(0);

    // ...e seguir na direção refletida a partir do ponto de impacto não colide de novo
    // imediatamente — prova de que a bala não fica "grudada" na quina.
    const nextTo = { x: hit!.point.x + reflected.x * 0.1, y: hit!.point.y + reflected.y * 0.1 };
    const secondHit = raycastSegment(hit!.point, nextTo, walls);
    expect(secondHit).toBeNull();
  });

  it('bala rápida em tick grande não atravessa parede fina (CCD)', () => {
    const wall = { x: 100, y: 0, w: 4, h: 200 }; // parede bem fina
    const from = { x: 50, y: 100 };
    const to = { x: 300, y: 100 }; // pulo grande, atravessaria sem CCD

    const hit = raycastSegment(from, to, [wall]);
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(100, 5);
  });

  it('tanque raspando na parede desliza em vez de travar', () => {
    const wall = { x: 100, y: 90, w: 20, h: 20 };
    const radius = 10;
    const pos = { x: 95, y: 85 }; // penetra levemente a quina superior-esquerda do bloco

    const resolved = circleVsAabbSlide(pos, radius, [wall]);

    const cx = Math.max(wall.x, Math.min(resolved.x, wall.x + wall.w));
    const cy = Math.max(wall.y, Math.min(resolved.y, wall.y + wall.h));
    const dist = Math.hypot(resolved.x - cx, resolved.y - cy);

    expect(dist).toBeGreaterThanOrEqual(radius - 1e-6);
  });
});
