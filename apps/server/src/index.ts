import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ROTA_SALAS } from '@tank/protocol';
import { TankRoom } from './rooms/TankRoom.js';
import { listarSalasAbertas, TIPO_DE_SALA } from './net/salas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');
const PORT = Number(process.env.PORT ?? 3000);

const httpServer = createServer();

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  // Colyseus só consegue mesclar rotas próprias (matchmaking) com rotas de app custom (estáticos
  // do client + /healthz) através do app Express — sem isso, o router interno do Colyseus
  // responderia sozinho por toda a porta e nunca serviria o client. Ver bindRouterToTransport em
  // @colyseus/core/src/router/index.ts.
  express: (app) => {
    app.get('/healthz', (_req, res) => {
      res.json({ ok: true, uptime: process.uptime(), rooms: matchMaker.stats.local.roomCount });
    });

    // Salas abertas (Fase 13 §2). Fica ANTES do estático e do fallback de SPA: registrada depois,
    // ela cairia no `index.html` e o cliente tentaria dar `JSON.parse` numa página inteira.
    // `no-store` porque a tela de entrada repergunta a cada 3 s e uma resposta em cache mostraria
    // sala que já encheu (ou esconderia a que acabou de abrir).
    app.get(ROTA_SALAS, (_req, res) => {
      void listarSalasAbertas()
        .then((salas) => {
          res.set('Cache-Control', 'no-store');
          res.json({ salas });
        })
        .catch((err: unknown) => {
          console.error('[salas] falha ao listar:', err);
          res.status(500).json({ salas: [] });
        });
    });

    app.use(express.static(CLIENT_DIST));

    // fallback SPA — qualquer rota não estática nem de matchmaking cai no index.html do client
    app.use((_req, res) => {
      res.sendFile(path.join(CLIENT_DIST, 'index.html'), (err) => {
        if (err) res.status(404).send('Not found');
      });
    });
  },
});

gameServer.define(TIPO_DE_SALA, TankRoom);

gameServer
  .listen(PORT)
  .then(() => {
    console.log(`Tank Ricochete rodando em http://localhost:${PORT}`);
  })
  .catch((err) => {
    console.error('Falha ao iniciar o servidor:', err);
    process.exit(1);
  });

async function shutdown(signal: string): Promise<void> {
  console.log(`\nRecebido ${signal}, encerrando com calma...`);
  try {
    await gameServer.gracefullyShutdown(false);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
