# syntax=docker/dockerfile:1

# Tank Ricochete — 1 container, 1 porta (3000), servidor Go servindo o cliente estático e o
# WebSocket do jogo na mesma porta.
#
# O servidor Node (Colyseus) continua no repo e continua compilando: `Dockerfile.node`. Ele não é
# mais o que sobe aqui porque o cliente trocou o `@colyseus/sdk` por um WebSocket cru — ver
# `go/README.md`, seção "O servidor".

# ---------- Estágio 1: o cliente ----------
# Debian (glibc), NÃO Alpine (musl): no Alpine o esbuild/rollup do Vite cai em prebuilds que nem
# sempre existem para musl, e o build morria baixando headers de hosts sem CDN. Foi a mesma
# decisão que a imagem antiga já carregava, e ela continua valendo — só que agora vale apenas
# para o cliente, porque o servidor não tem mais nenhuma dependência nativa.
FROM node:24-slim AS cliente
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile --filter @tank/client...
RUN pnpm --filter @tank/client run build

# ---------- Estágio 2: o servidor ----------
# `CGO_ENABLED=0` é o ponto da troca de `better-sqlite3` por `modernc.org/sqlite`: sem cgo o
# binário sai estático, o estágio de runtime não precisa de compilador C nem de node_modules, e o
# `pnpm prune --prod` que derrubava o container antigo deixa de existir como problema.
FROM golang:1.27 AS servidor
WORKDIR /src

COPY go/go.mod go/go.sum ./
RUN go mod download

COPY go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/servidor ./cmd/servidor

# ---------- Estágio 3: runtime ----------
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

ENV PORT=3000
ENV DATA_DIR=/app/data
ENV CLIENT_DIST=/app/client

COPY --from=servidor /out/servidor /app/servidor
COPY --from=cliente /app/apps/client/dist /app/client

EXPOSE 3000
CMD ["/app/servidor"]
