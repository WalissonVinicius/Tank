# Tank Ricochete

Jogo FFA (todos contra todos) de tanques num labirinto gerado por seed, para navegador. Até 10
jogadores entram pelo link da sala + código de 4 letras, sem precisar de conta. Os tanques são
lentos, a torre mira no cursor do mouse com velocidade de giro limitada, e as balas ricocheteiam
uma vez antes de expirar — matam em **1 toque, inclusive quem atirou** (o autogol é a piada central
do jogo). A partida tem 10 rodadas curtas (20–45 s cada); quem soma mais pontos no fim vence.

Servidor Node autoritativo (Colyseus); todo o visual é desenhado por código (PixiJS), sem nenhum
arquivo de imagem.

## Como jogar

- **Mover**: WASD (setas também funcionam) — `W`/`S` andam e dão ré, `A`/`D` giram o tanque
- **Mirar**: a torre segue o cursor do mouse; ela não vira instantâneo, gira até lá
- **Atirar**: botão esquerdo do mouse (espaço também funciona). A bala sai na direção da torre
- Antes de cada rodada aparece a contagem **3 · 2 · 1 · VAI!** — ninguém anda nem atira até o VAI
- A bala ricocheteia 1× e mata em 1 toque — **inclusive quem atirou**
- Pontuação por rodada: sobreviver rende mais pontos (quem sai por último ganha mais), **+1** por
  abate e **−1** por autogol. Depois de 10 rodadas aparece a tela de vencedor, com pódio, ranking
  completo e os títulos de zoeira da partida.

## Rodando em desenvolvimento

Requer Node ≥ 22 e pnpm (via corepack).

```bash
pnpm install
pnpm dev
```

Isso sobe o servidor (`tsx watch`, porta 3000) e o client (Vite, porta 5173) juntos. Abra
`http://localhost:5173` no navegador.

- **Modo local** (sem servidor, só para testar o render/jogo sozinho, com bots):
  `http://localhost:5173/?local=1&bots=6&seed=42`
- **Modo online**: crie uma sala pelo lobby ou entre direto com `?sala=XXXX` no link.

## Testes

```bash
pnpm typecheck   # tsc --noEmit em todos os pacotes
pnpm test        # vitest — simulação determinística (shared-sim, protocolo de rede, etc.)
pnpm build       # build de produção: client (Vite) + servidor (tsup)
```

## Tuning

Toda a tabela de balanceamento (velocidade, alcance, cadência de tiro, tamanho do labirinto por
nº de jogadores etc.) mora em **`packages/protocol/src/constants.ts`** — é a fonte única da
verdade, usada tanto pelo servidor quanto pelo client.

## Publicando no Coolify

1. Crie uma aplicação a partir deste repositório Git (o Coolify detecta o `Dockerfile` na raiz e
   builda a imagem multi-stage — client com Vite, servidor com tsup).
2. Configure a porta em **"Ports Exposes"** (`3000`) — **nunca** em "Ports Mappings": isso pula o
   proxy reverso (Traefik) e desliga os rolling updates. O Traefik faz o upgrade de conexão para
   WebSocket sozinho, sem configuração extra, já que client e servidor dividem a mesma porta.
3. Configure as variáveis de ambiente (veja `.env.example` abaixo) e, se quiser persistir
   ranking entre deploys, monte um volume em `DATA_DIR` (por padrão `/app/data` — veja
   `docker-compose.yml` para rodar o equivalente localmente).
4. Deploy. O healthcheck fica em `GET /healthz`.

### Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta única do HTTP + WebSocket (client estático e jogo saem daqui) |
| `NODE_ENV` | — | Use `production` no deploy |
| `DATA_DIR` | `./data` (relativo, dev) | Pasta onde o SQLite (`tank.db`) é gravado — no container, aponte para o volume |
| `WEBHOOK_URL` | — | URL do n8n que recebe o ranking final de cada partida (POST JSON). Vazio desativa; falha de envio nunca derruba a partida, só é logada |

Copie `.env.example` para `.env` para rodar localmente com Docker Compose.

### SQLite

O servidor grava rating/histórico de partidas em `tank.db` dentro de `DATA_DIR`. Em dev, isso é
`apps/server/../../data` (a pasta `data/` na raiz do repo) se `DATA_DIR` não for definida. No
container, defina `DATA_DIR=/app/data` e monte um volume nesse caminho para não perder os dados
a cada deploy (já configurado em `docker-compose.yml`).

### Webhook do n8n

Ao fim de cada partida (`GameOver`), o servidor faz um `POST` em `WEBHOOK_URL` com o ranking final
(posição, nome e pontos de cada jogador) e os títulos da partida (Kamikaze, Bala Perdida, Covarde
Estratégico). Configure um workflow no n8n com um nó de Webhook para receber e postar isso onde
quiser (ex.: um canal do Slack/Discord). Deixe `WEBHOOK_URL` vazio para desativar.

## Rodando com Docker localmente

```bash
docker compose up --build
```

Sobe o jogo em `http://localhost:3000`, com o SQLite persistido em `./data`.
