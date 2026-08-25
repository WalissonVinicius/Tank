import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  sourcemap: true,
  // @tank/protocol e @tank/shared-sim são pacotes do workspace que só publicam TypeScript-fonte
  // (main/types apontam pra src/index.ts) — sem inliná-los aqui, o `node dist/index.js` final
  // tentaria resolver `./constants.js` num arquivo que só existe como `.ts`, e quebraria.
  noExternal: [/^@tank\//],
});
