# syntax=docker/dockerfile:1

# ---------- Stage 1: build ----------
# Debian (glibc), NÃO Alpine (musl) — e isso é uma decisão de rede, não de gosto.
#
# No Alpine o better-sqlite3 não encontra binário pré-compilado (os prebuilds publicados são
# para glibc), então cai no node-gyp, que precisa baixar os headers do Node do
# `unofficial-builds.nodejs.org` — o único host que serve headers musl e o mais frágil da
# cadeia, sem CDN. O build morria ali com `read ETIMEDOUT`.
#
# Com glibc o prebuild casa e nada é compilado. python3/make/g++ ficam só como rede de
# segurança: se algum dia o prebuild faltar, o node-gyp compila buscando os headers no
# nodejs.org oficial.
FROM node:24-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile
RUN pnpm build
# Remove as devDependencies (typescript, vite, tsup, tsx, vitest...) do node_modules antes de
# copiar para o stage final — mantém a imagem de produção enxuta.
#
# O `confirm-modules-purge false` NÃO é opcional aqui: para podar, o pnpm precisa apagar o
# node_modules e pede confirmação interativa antes. Dentro do Docker não existe TTY, então ele
# aborta com ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY e derruba o build inteiro na última
# linha do estágio — depois de já ter instalado tudo e compilado o better-sqlite3.
RUN pnpm config set confirm-modules-purge false && pnpm prune --prod

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
