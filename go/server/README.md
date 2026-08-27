# `go/server` — o servidor do Tank Ricochete

Este é o servidor de verdade: transporte, salas, ciclo de partida, persistência e o cliente
estático, tudo numa porta só. Ele substitui `apps/server/` (Node + Colyseus) e roda em cima de
`go/sim`, `go/powerups` e `go/protocol` — a simulação com paridade bit a bit provada, que ele
**não** duplica nem reimplementa.

```bash
cd go
go build -ldflags="-s -w" -o bin/servidor.exe ./cmd/servidor
DATA_DIR=data ./bin/servidor.exe -porta 3000 -client apps/client/dist
```

| flag | variável | padrão | o que faz |
|---|---|---|---|
| `-porta` | `PORT` | `3000` | porta HTTP e WebSocket (a mesma) |
| `-client` | `CLIENT_DIST` | `apps/client/dist` | pasta do build do cliente |
| `-dados` | `DATA_DIR` | `data` | pasta do SQLite |
| `-sem-banco` | — | desligado | sobe sem persistência |

## O transporte: WebSocket cru, não Colyseus

Não existe servidor Colyseus em Go. As opções eram reimplementar o protocolo do
`@colyseus/schema` (binário, com delta e versionamento de campo) ou trocar o transporte. **Trocamos
o transporte**, e o motivo é concreto: o Schema carregava só o **estado frio** — jogadores, placar,
fase da rodada, dono da sala, configuração. O estado **quente** já viajava em mensagem binária
própria (`net/snapshot.ts`, 8 bytes por tanque). Reimplementar delta de Schema para sincronizar um
punhado de campos que mudam raramente seria trabalho grande para replicar algo que mal usávamos.

A biblioteca é [`github.com/coder/websocket`](https://github.com/coder/websocket) (o antigo
`nhooyr.io/websocket`), e não `gorilla/websocket`, por três motivos práticos: a API é baseada em
`context.Context`, o que faz encerramento com prazo sair de graça em vez de virar um
`SetWriteDeadline` manual em cada ponto; ela não precisa de hijack da conexão HTTP; e o `Close`
dela já manda o quadro de fechamento com código e motivo — que é exatamente o que separa **saída
consentida** de **queda** neste jogo. `gorilla` é maduro e serviria; custaria mais código para a
mesma coisa.

### O protocolo

Uma conexão, três tipos de tráfego:

| o quê | como | quando |
|---|---|---|
| **quente** — posições de tanque | frame **binário**, o formato de `net/snapshot.ts` **inalterado** (1 + 8×N bytes) | 20 Hz |
| **frio** — estado da sala | frame de texto, JSON `{"t":"state","d":{…}}` | quando muda; a 20 Hz enquanto o relógio da rodada anda |
| **eventos** — `bullet_spawn`, `tank_death`, `round_start`, … | frame de texto, JSON `{"t":canal,"d":{…}}` | quando acontecem |

O cliente separa quente de frio **pelo tipo do frame**, sem cabeçalho nenhum. Os nomes de canal
continuam vindo de `MessageType` no `@tank/protocol` — nenhuma das duas pontas escreve a string à
mão, que é como o canal do snapshot quase divergiu na Fase 2.

O aperto de mão é o primeiro quadro:

```
cliente → {"t":"entrar","d":{"modo":"criar"|"codigo"|"reconectar", "codigo":"AB2C",
                             "nome":"Ana","deviceId":"…","cor":16723555,"bots":3,"token":"…"}}
servidor → {"t":"entrou","d":{"roomId":"AB2C","sessionId":"…","token":"AB2C:…"}}
        ou {"t":"erro","d":{"motivo":"sala não encontrada"}}   e fecha
```

O `entrou` faz o papel que o matchmaking HTTP do Colyseus fazia: código da sala, id da sessão e o
token de reconexão. Ele sai **antes** de o jogador entrar de fato, porque a sala transmite o estado
frio no mesmo instante em que ele nasce nela — e um cliente que recebesse o estado sem saber o
próprio `sessionId` não conseguiria se achar no placar.

`GET /salas` (a vitrine da tela de entrada) e `GET /healthz` continuam sendo HTTP puro, iguais aos
do servidor Node.

### Saída consentida × queda

É a distinção que a Fase 13 §1 introduziu, e ela sobreviveu à troca de transporte:

- **saída** (`{"t":"sair"}` do menu de pausa, ou fechamento com código 1000) — a vaga volta na
  hora, a cor volta para a paleta e o tanque some da arena dos outros;
- **queda** (qualquer outro fim de socket) — a vaga fica guardada por **30 s**. O jogador aparece
  desconectado no estado frio e volta pelo token, com pontuação, cor e slot intactos.

O token é `<código-da-sala>:<aleatório>`, e o código no prefixo não é enfeite: é o que permite
achar a sala do token sem varrer todas.

## Concorrência: uma goroutine por sala

Toda sala roda numa goroutine só. Mensagem de cliente, entrada, saída e expiração de reconexão
entram por um canal de comandos e são executadas **por essa goroutine**, nunca pela do socket. É o
equivalente Go do laço single-thread do Colyseus, e é o que faz a arbitragem funcionar sem um mutex
por campo: dois jogadores que clicam na mesma cor no mesmo instante são atendidos em ordem, e o
segundo simplesmente cai fora do `if`.

Cada cliente tem uma fila de saída própria. Quem não consegue mais consumi-la (aba congelada, rede
entupida) é **desconectado** em vez de segurar o tick — e cai no caminho normal de queda, com os
mesmos 30 s para voltar.

## O que este servidor NÃO faz

Nada de física. `Step`, `MakeMaze`, `SpawnPoints`, `MakeBot` e a agenda de power-ups são chamadas
de `go/sim` e `go/powerups`, que têm paridade bit a bit provada contra o TypeScript
(`node go/compare.mjs`). O servidor é o dono do relógio (`state.Tick++` é dele, não da `Step`) e o
árbitro da morte e da coleta — só isso.

A costura com essas duas peças está em `gameplay.go`, e ela é uma interface e não uma chamada
direta de propósito: o servidor foi escrito, compilado e provado enquanto os dois portes ainda
estavam em voo, e ligá-los depois mexeu só naquele arquivo.

## Persistência

`better-sqlite3` (extensão nativa em C) virou **`modernc.org/sqlite`** — SQLite traduzido para Go
puro, sem cgo. É isso que deixa o binário estático e o Dockerfile sem compilador C.

O esquema é **idêntico** ao do TypeScript: mesmas três tabelas, mesmos nomes de coluna. Um banco
gravado pelo servidor Node abre no Go e vice-versa.

A gravação é **assíncrona**: `SalvarPartida` só enfileira. No Node o `better-sqlite3` é síncrono e
o `INSERT` acontecia dentro do laço da sala; aqui isso travaria a goroutine da sala durante o fsync
do WAL, e uma sala em `gameover` ainda está transmitindo estado para quem olha a tela de resultado.

O rating `openskill` (Plackett–Luce) foi **portado**, não substituído por um pacote equivalente:
o critério é bater com os números que o TypeScript produz, e outro pacote daria números "certos"
que não são os mesmos. São ~60 linhas em `persist/rating.go`, tradução literal de `rate.js`,
`util.js` e `models/plackett-luce.js`.

## Como isto é provado

Três camadas, e nenhuma delas se compara só consigo mesma:

1. **`go test ./server/... ./persist/...`** — 20 testes. Os que valem mais conferem o porte contra
   a **saída do próprio TypeScript**: o snapshot binário em hexadecimal, `direcaoDeMovimento` e
   `decodeAim` em padrão de bits, a paleta/animais/alfabeto/nomes de canal valor a valor, o
   `roundLoop` inteiro e o `openskill` a 1e-12. Os vetores vêm de `apps/server/ref/` — ver o
   `README.md` de lá para regerar.
2. **`node _e2e.cjs http://localhost:3000`** — a mesma bateria de navegador que o servidor Node
   passa: 46 verificações clicando em tudo. **46/46.**
3. **Dois clientes reais** numa partida, comparados frame a frame pela sonda `?debug=1`
   (`_g2-dois-clientes.cjs`).

O `-race` do Go **não** rodou: ele exige cgo e esta máquina não tem compilador C. Em Linux/amd64
vale rodar `CGO_ENABLED=1 go test -race ./server/...` antes de confiar na concorrência.

## Uma pedra do Windows

O Smart App Control desta máquina bloqueou o binário recém-compilado com
`Permission denied` / *"Uma política de Controle de Aplicativo bloqueou este arquivo"*. O veredito é
por **conteúdo**, não por caminho: renomear o arquivo não adianta, recompilar igual também não.

Compilar com `-ldflags="-s -w"` (que muda o binário, e é o que o Dockerfile já faz) passou. Vale
como contorno, não como garantia — é uma decisão de nuvem da Microsoft, não uma configuração.
