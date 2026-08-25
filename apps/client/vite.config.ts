import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      '@tank/protocol': fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)),
      '@tank/shared-sim': fileURLToPath(new URL('../../packages/shared-sim/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // O SDK do Colyseus preserva o pathname do endpoint em TODAS as rotas (matchmaking HTTP
      // e upgrade de WebSocket): '/colyseus' vira '/colyseus/matchmake/...'. O servidor só conhece
      // '/matchmake/...', então o prefixo tem que cair aqui — sem o rewrite o matchmaking recebe o
      // index.html do fallback SPA e falha ao fazer JSON.parse.
      '/colyseus': {
        target: 'http://localhost:3000',
        ws: true,
        changeOrigin: true,
        rewrite: (caminho) => caminho.replace(/^\/colyseus/, ''),
      },
    },
  },
});
