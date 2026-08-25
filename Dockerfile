# syntax=docker/dockerfile:1

# ---------- Stage 1: build ----------
# Debian (glibc), NÃO Alpine (musl) — e isso é uma decisão de rede, não de gosto.
#
# No Alpine o better-sqlite3 não encontra binário pré-compilado (os prebuilds publicados são
# para glibc), então cai no node-gyp, que precisa baixar os headers do Node do
# `unofficial-builds.nodejs.org` — o único host que serve headers musl e o mais frágil da
# cadeia, sem CDN. O build morria ali com `read ETIMEDOUT`.
#
# Com glibc os headers vêm do nodejs.org oficial, que tem CDN, e o download passa. A
# compilação em si CONTINUA acontecendo (o prebuild não é aplicado aqui) — por isso
# python3/make/g++ são obrigatórios, não rede de segurança. Custa ~2 min de build.
FROM node:24-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile
RUN pnpm build
# NAO usar `pnpm prune --prod` aqui. Ele e so otimizacao de tamanho, e a imagem so
# chegou a rodar com a arvore podada -- o container crashava em loop (restart_count 10,
# last_restart_type "crash") enquanto o mesmo bundle sobe sem erro fora do container.
# Carregar node_modules inteiro custa alguns MB e elimina a variavel.

# ---------- Stage 2: runtime ----------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

# @tank/protocol e @tank/shared-sim já foram inlinados no bundle do tsup (ver
# apps/server/tsup.config.ts) — só as dependências externas de produção (express, colyseus,
# better-sqlite3, openskill...) e o client já compilado precisam ir para a imagem final.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/client/dist ./apps/client/dist

EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
