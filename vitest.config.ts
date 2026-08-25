import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@tank/protocol': fileURLToPath(new URL('./packages/protocol/src/index.ts', import.meta.url)),
      '@tank/shared-sim': fileURLToPath(new URL('./packages/shared-sim/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
