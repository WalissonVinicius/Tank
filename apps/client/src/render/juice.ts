// Game feel: screen shake por trauma² (Eiserloh/Vlambeer) com ruído 1D suave — proibido
// Math.random() aqui, por isso o shake usa noise.ts — e hitstop que escala só o dt do MUNDO,
// nunca o da UI/HUD. O flash branco de 2 frames e o recuo do cano vivem perto do estado da
// entidade (tank.ts) mas seguem os mesmos princípios de calibração descritos aqui.

import { valueNoise1D } from './noise.js';

const TRAUMA_DECAY_PER_S = 1.6;
const SHAKE_MAX_OFFSET_PX = 16;
const SHAKE_MAX_ROTATION = 0.03;
const SHAKE_MAX_SCALE = 0.02;
const SHAKE_TIME_SCALE = 22;

export interface ShakeTransform {
  offsetX: number;
  offsetY: number;
  rotation: number;
  scale: number;
}

export class JuiceController {
  private trauma = 0;
  private hitstopLeftMs = 0;
  private realTimeSec = 0;

  /** tiro +0.05 · ricochete +0.03 · morte de outro +0.45 · morte própria/autogol +0.6-1.0 */
  addTrauma(v: number): void {
    this.trauma = Math.min(1, this.trauma + v);
  }

  hitstop(ms: number): void {
    this.hitstopLeftMs = Math.max(this.hitstopLeftMs, ms);
  }

  /** Avança 1 frame de tempo real; devolve o dt do MUNDO em segundos (0 durante hitstop). */
  tick(realDeltaMs: number): number {
    this.realTimeSec += realDeltaMs / 1000;
    let worldDeltaMs = realDeltaMs;
    if (this.hitstopLeftMs > 0) {
      this.hitstopLeftMs -= realDeltaMs;
      worldDeltaMs = 0;
    }
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY_PER_S * (realDeltaMs / 1000));
    return worldDeltaMs / 1000;
  }

  getShake(): ShakeTransform {
    const shake = this.trauma * this.trauma;
    const s = this.realTimeSec * SHAKE_TIME_SCALE;
    return {
      offsetX: valueNoise1D(s) * shake * SHAKE_MAX_OFFSET_PX,
      offsetY: valueNoise1D(s + 97.3) * shake * SHAKE_MAX_OFFSET_PX,
      rotation: valueNoise1D(s + 191.7) * shake * SHAKE_MAX_ROTATION,
      scale: 1 + shake * SHAKE_MAX_SCALE,
    };
  }
}
