// zzfx@1.3.2 não publica tipos — declaração mínima do que `main.ts` consome.
declare module 'zzfx' {
  export function zzfx(...parameters: number[]): AudioBufferSourceNode | undefined;
  export const ZZFX: {
    audioContext: AudioContext;
    play(...parameters: number[]): AudioBufferSourceNode | undefined;
  };
}
