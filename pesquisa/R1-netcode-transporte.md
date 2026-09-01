# R1 — Netcode e transporte

> Nota de contexto: o `CLAUDE.md` da raiz descreve o backend como Colyseus/Node. Isso está
> **desatualizado**: o servidor em produção é **Go** (`go/server/`), WebSocket cru via
> `github.com/coder/websocket` (o antigo `nhooyr.io/websocket`), com a simulação portada para Go e
> paridade bit a bit provada contra `packages/shared-sim`. Este relatório usa o código Go como
> fonte da verdade. Todos os números de tuning citados vêm de `packages/protocol/src/constants.ts`
> (fonte única) — alguns diferem do que está impresso no `CLAUDE.md` (ex.: `MAX_BOUNCES` é **1**,
> não 2; a torre mira no mouse, não está travada no chassi — Fase 4).

## 1. Resumo

O netcode atual **já está adequado para 10–20 jogadores**: cadência de snapshot correta, estado
quente já binário, estado frio já joga leve (11,2 → 1,07 KB/s/jogador), compressão corretamente
desligada, e o buffer de interpolação já neutraliza o bloqueio de cabeça de linha do TCP (0,08% de
saltos medidos). O único ponto fraco real e mensurável é que **o próprio tanque do jogador local
sai do mesmo buffer atrasado que os tanques dos outros**, custando ~100–190 ms de atraso evitável
entre apertar uma tecla e o tanque reagir na tela — isso tem arquivo, linha e correção concretos
abaixo. WebTransport é tecnicamente viável a partir de 2026, mas resolveria um problema que o
cliente já esconde do jogador; não há número hoje que justifique o custo e o risco de trocar de
transporte.

## 2. Recomendações priorizadas

| # | Recomendação | Impacto esperado | Custo de implementação | Risco |
|---|---|---|---|---|
| 1 | Predição local do próprio tanque (movimento + torre), com reconciliação suave | **Alto** — remove ~100–190 ms de atraso de controle percebido no jogador local (o único que qualquer transporte novo não resolveria) | Médio — só cliente, reaproveita `sim.ts`/`collision.ts` já compartilhados | Baixo–médio — isolado do protocolo e do servidor; pior caso é um "correção visual" pontual, já resolvido pelo mesmo padrão de suavização que `interpolation.ts` já usa |
| 2 | Instrumentar bandwidth **por canal** (quente / frio / eventos) em produção | Informacional — hoje só existe o número agregado (1,07–1,16 KB/s/jogador); não dá para saber se eventos de combate (`bullet_spawn`/`bullet_dead`) dominam em partida cheia | Baixo — log/contador, sem mudar protocolo | Nenhum |
| 3 | Binarizar `bullet_spawn`/`bullet_dead`/`tank_death` | Incerto até medir (#2) — estimativa própria: pico teórico de ~4,7 KB/s/jogador com 10 jogadores atirando no teto simultaneamente, contra ~1,1–1,2 KB/s medidos hoje em jogo real | Baixo–médio — formato fixo, poucos campos | Baixo |
| — | WebTransport/HTTP3 como transporte | **Não recomendado agora** — ver §4 | Alto | Alto |
| — | Codificação binária do estado frio | **Não recomendado** — já resolvido por outro meio, ver §4 | — | — |
| — | Compressão delta / interest management | **Não recomendado** — não há problema a resolver no tamanho de sala deste jogo, ver §4 | — | — |
| — | Compensação de lag no servidor (rewind) | **Não recomendado** — a arquitetura de bala já não precisa disso, ver §4 | — | — |

## 3. As recomendações, em detalhe

### 3.1 Predição local do próprio tanque

**Por quê.** Hoje o tanque do PRÓPRIO jogador é lido do mesmo `InterpolationBuffer` que desenha
todo mundo:

```ts
// apps/client/src/main.ts:1476-1479
const meId = net.sessionId;
const minhaAmostra = meId ? interp.sample(meId, agora) : null;
```

e o buffer é alimentado por snapshots que chegam do servidor. Isso significa que entre apertar uma
tecla e o tanque começar a se mover na tela existe: tempo até o input chegar no servidor
(`~RTT/2`) → até 1 tick de processamento (16,7 ms) → tempo até o snapshot voltar (`~RTT/2`) → mais
o atraso proposital do buffer:

```ts
// apps/client/src/main.ts:869
const INTERP_DELAY_MS = 1000 / SNAPSHOT_HZ + 10; // = 60 ms

// apps/client/src/net/interpolation.ts:162
constructor(private delayMs = 100) {}
```

Com o RTT medido deste desenvolvedor até o servidor de produção (17–31 ms, média 19 ms —
`_o2-ping-tank.txt`), o atraso de controle já fica em ~80–100 ms; para um jogador com RTT típico
de 40–80 ms (mais realista para "colegas de trabalho" espalhados), sobe para ~140–190 ms. Isso é
exatamente o que o próprio comentário de cabeçalho de `interpolation.ts` já documenta como um
problema conhecido e não resolvido:

```ts
// apps/client/src/net/interpolation.ts:37-39
// Aumentar o atraso de interpolação resolveria a fome de amostra sem extrapolar nada, mas custaria
// os mesmos ~250 ms de latência em tudo — inclusive no tanque de quem está jogando, que sai deste
// mesmo buffer e é a referência da mira (`main.ts`). Por isso a escolha foi extrapolar.
```

A boa notícia é que a física deste jogo torna a predição **quase de graça** de implementar direito:
movimento não depende de outros tanques nem de balas, só do próprio input, da própria posição e do
labirinto (estático dentro da rodada, já conhecido no cliente):

```ts
// packages/shared-sim/src/sim.ts:63-74 (dentro de stepTanks)
if (input.mover !== null) {
  tank.heading = angleTowards(tank.heading, input.mover, TURN_RATE * dt);
  const velocidade = TANK_SPEED * (1 + (tank.turbo ?? 0));
  const candidate: Vec2 = {
    x: tank.x + Math.cos(input.mover) * velocidade * dt,
    y: tank.y + Math.sin(input.mover) * velocidade * dt,
  };
  const resolved = circleVsAabbSlide(candidate, TANK_RADIUS, state.maze.walls);
  tank.x = resolved.x;
  tank.y = resolved.y;
}
if (input.aim !== undefined) {
  tank.turret = angleTowards(tank.turret, input.aim, TURRET_RATE * dt);
}
```

Não existe colisão tanque-contra-tanque neste jogo (só `circleVsAabbSlide` contra paredes — grep
em `sim.ts` não encontra nenhuma resolução tanque×tanque). Ou seja, **a posição do meu tanque no
próximo frame nunca depende de informação que só o servidor tem.** É seguro prever localmente sem
o risco clássico de predição (agir sobre estado que na verdade era incerto).

**O que muda.**

1. `packages/shared-sim/src/sim.ts` — extrair o bloco acima de dentro de `stepTanks` para uma
   função exportada e pura, reaproveitada pelos dois lados:

```ts
// packages/shared-sim/src/sim.ts — nova função exportada
export function advanceTank(tank: Tank, input: Input, maze: Maze, dt: number): void {
  if (input.mover !== null) {
    tank.heading = angleTowards(tank.heading, input.mover, TURN_RATE * dt);
    const velocidade = TANK_SPEED * (1 + (tank.turbo ?? 0));
    const candidate: Vec2 = {
      x: tank.x + Math.cos(input.mover) * velocidade * dt,
      y: tank.y + Math.sin(input.mover) * velocidade * dt,
    };
    const resolved = circleVsAabbSlide(candidate, TANK_RADIUS, maze.walls);
    tank.x = resolved.x;
    tank.y = resolved.y;
  }
  if (input.aim !== undefined) {
    tank.turret = angleTowards(tank.turret, input.aim, TURRET_RATE * dt);
  }
}
```

   (`stepTanks` passa a chamar `advanceTank(tank, input, state.maze, dt)` em vez do bloco inline —
   comportamento idêntico, zero divergência com o servidor, porque é o MESMO código.)

2. `apps/client/src/main.ts` — ao lado de `interp`, manter uma cópia prevista do próprio tanque e
   usá-la só para desenhar/mirar o jogador local, sem tocar em como os outros são desenhados:

```ts
// apps/client/src/main.ts — perto de onde `interp` é criado
let previsaoLocal: { x: number; y: number; heading: number; turret: number } | null = null;
let correcaoPendente: { ex: number; ey: number; ate: number } | null = null;
const SUAVIZACAO_PREVISAO_MS = 140; // mesmo valor de SUAVIZACAO_MS em interpolation.ts

function frame(agora: number): void {
  // ...
  const meId = net.sessionId;
  const amostraServidor = meId ? interp.sample(meId, agora) : null;

  if (amostraServidor && !previsaoLocal) {
    previsaoLocal = { ...amostraServidor };
  }
  if (previsaoLocal && amostraServidor) {
    // avança a cópia local com o MESMO input que acabou de ser lido, antes de mandar pro servidor
    const dtFrame = ...; // dt real do frame, em segundos
    advanceTank(previsaoLocal, meu, mazeAtual, dtFrame);

    // reconcilia contra o que o servidor confirmou, na mesma lógica de
    // InterpolationBuffer.reconciliar: congela o erro e dissolve em SUAVIZACAO_PREVISAO_MS
    // em vez de saltar.
  }
  const minhaAmostra = previsaoLocal ?? amostraServidor;
  // ... usa minhaAmostra para mira, e no `view.tanks` do MEU id
}
```

O padrão de suavização (congelar o erro no instante da correção e dissolvê-lo em ~140 ms) **já
existe e está testado** em `InterpolationBuffer.reconciliar` (`interpolation.ts:304-337`) — a
predição local só precisa do mesmo truque, não de uma técnica nova.

**Extensão opcional, menor.** O tiro sofre o mesmo atraso: o "clarão do cano" só aparece quando o
`bullet_spawn` do servidor chega, mesmo para quem atirou —

```ts
// apps/client/src/main.ts:1137-1141
onBulletSpawn: (msg: BulletSpawnMsg) => {
  ...
  renderer.onShot(msg.x, msg.y, msg.angle, playersById.get(msg.ownerId)?.color ?? 0xffffff);
```

não tem um caminho otimista para o próprio disparo. Dá para mostrar o clarão e a bala prevista
localmente no instante do clique (o cliente já sabe seu próprio cooldown e munição) e simplesmente
não fazer nada quando a confirmação do servidor chegar — ela raramente vai divergir, porque quem
decide "pode atirar" é sempre o servidor por trás. Mas isso é um adendo pequeno à mesma técnica, não
uma segunda recomendação: o item que realmente dói é o movimento, não o tiro.

**O que isto NÃO muda.** Nenhum outro tanque, nenhuma bala de terceiro, nenhum protocolo de rede.
`SNAPSHOT_HZ`, `INTERP_DELAY_MS`, `MAX_EXTRAPOLACAO_MS` continuam exatamente como estão — eles
seguem certos para todo mundo que não é "eu".

### 3.2 Instrumentar bandwidth por canal

**Por quê.** Os números de produção que temos (`MEDICAO.md`, e "1,07 KB/s" / "1,16 KB/s por
jogador" da tarefa) são **agregados** — a redução de 11,2 → 1,07 KB/s documentada no comentário de
`sala.go:900-923` é especificamente do canal `state` (estado frio). Não existe, hoje, um número
separado para o canal de eventos (`bullet_spawn`, `bullet_dead`, `tank_death`, …), que em combate
intenso pode não ser pequeno: com `FIRE_COOLDOWN = 0,55 s` e `MAX_BULLETS = 2`
(`packages/protocol/src/constants.ts:24-25`), o teto teórico de 10 jogadores atirando no cooldown
mínimo é `10 / 0,55 ≈ 18,2` tiros/s, cada um gerando pelo menos um `bullet_spawn` (~170 bytes de
JSON) e um `bullet_dead` (~80 bytes) — na pior hipótese, **~4,7 KB/s por jogador**, contra os
~1,1–1,2 KB/s medidos em jogo real. A distância entre o pior caso teórico e o medido sugere que a
sala real nunca chega perto do teto (jogadores morrem, saem da linha de tiro, erram o ângulo), mas
isso é inferência, não medição — vale confirmar antes de decidir se vale a pena mexer no formato
dos eventos.

**O que muda.** Um contador de bytes por `canal` (`MessageType`) em `Sala.transmitir`/
`transmitirBytes` (`go/server/sala.go:936-946`), exposto em log periódico ou em `/healthz`, quebrado
por canal. Não é uma mudança de protocolo — só visibilidade.

### 3.3 Binarizar eventos de combate (condicional)

Só vale a pena decidir **depois** de 3.2 responder se eventos dominam em partida cheia. Se sim, o
formato é direto: `bullet_spawn` tem 8 campos numéricos + 1 booleano + 1 id de bala + 1 id de dono —
cabe em ~20 bytes binários (na linha do que `EncodeSnapshot` já faz em `go/server/codec.go:48-70`)
contra os ~170 bytes de JSON hoje. Não desenho o formato aqui porque, pelas contas de 3.2, é
provável que a sala real nunca chegue a um regime onde isso importe — ver §4.

## 4. O que foi investigado e descartado

### 4.1 WebTransport / HTTP3 / QUIC como transporte

**Investigado a fundo, não recomendado agora.** Resumo do que mudou e do que não:

- **Suporte de navegador.** WebTransport virou *Baseline* em março de 2026, quando o Safari 26.4
  passou a suportá-lo nativamente (desktop e iOS), fechando a lacuna que travava qualquer decisão
  antes disso — Chrome 97+, Edge 98+, Firefox 114+, Safari 26.4+, Opera 83+, Samsung Internet 18+
  já falam o protocolo. Isso está confirmado tanto pelo anúncio da própria WebKit (Interop 2026)
  quanto por fontes de mercado. Ou seja, a barreira de "Safari não suporta" que existia até 2025
  **caiu**.
- **O lado servidor em Go não acompanhou.** `quic-go` (a base) é maduro e é descrito como
  "production-ready". Mas `webtransport-go`, a camada que fala WebTransport de verdade, ainda
  implementa só o *draft-16* do protocolo e **não chegou à versão 1.0** — o próprio projeto avisa
  que o suporte a uma versão de draft pode quebrar durante uma transição para a próxima, sem
  garantia de compatibilidade dupla. Trocar o transporte do jogo por uma biblioteca pré-1.0 é
  assumir um risco de manutenção que hoje não tem contrapartida clara (ver abaixo).
- **Infra: Coolify/Traefik não está pronto para isso de fábrica.** O deploy atual é 1 container, 1
  porta TCP (3000), Coolify gerando o Traefik automaticamente (não há `docker-compose.yml`/labels
  de Traefik neste repo — é tudo autogerado). HTTP/3 no Traefik exige expor UDP na entrypoint
  segura (tipicamente `443/udp`) e ligar a flag experimental `experimentalHTTP3`, e isso é
  configuração de proxy que o painel do Coolify não expõe por padrão — precisaria de configuração
  dinâmica de Traefik por fora do fluxo gerenciado. É trabalho de infraestrutura genuíno, não só de
  código.
- **E o mais importante: o problema que WebTransport resolveria já está escondido do jogador.** O
  ganho central de WebTransport sobre WebSocket é eliminar o bloqueio de cabeça de linha do TCP —
  exatamente o problema que gerou os "~22 buracos acima de 150 ms" no canal de snapshot. Mas
  `interpolation.ts` já foi desenhado especificamente para absorver esse padrão de entrega (rajada
  após perda + RTO), e o resultado medido é **0,08% de saltos no movimento dos tanques** — o
  jogador não vê o problema que WebTransport removeria. Trocar de transporte para consertar algo
  que já não aparece na tela não tem métrica que justifique o custo/risco acima.
- **Ressalva honesta, não medida.** O canal de INPUT (cliente → servidor, 30 Hz,
  `apps/client/src/net/client.ts:358-367`) sofre do mesmo TCP e, em tese, do mesmo padrão de
  perda+RTO — mas, ao contrário do canal de snapshot, não tem um buffer de extrapolação do lado do
  servidor: `s.ultimoInput[sessionID]` (`go/server/sala_mensagens.go:174`) simplesmente continua
  repetindo o último input recebido até o retransmitido chegar. Isso é uma hipótese, não uma
  medição — `MEDICAO.md` mediu o canal de descida, não o de subida. Recomendação prática: se um dia
  isso for medido e mostrar um problema real, ele é resolvido pela predição local do §3.1 (que
  já esconde do jogador local qualquer soluço no envio de input, pela mesma razão que já esconde
  RTT) — não precisa de troca de transporte para isso.
- **Quando reconsiderar.** Se `webtransport-go` chegar à v1.0 estável **e** uma medição futura
  mostrar que o canal de input sofre stalls sem mitigação (o que a predição local do §3.1 não
  resolveria completamente, porque o servidor ficaria um tempo maior sem saber a intenção real do
  jogador para fins de tiro/colisão), vale reabrir esta discussão. Hoje não há essa medição.

### 4.2 Codificação binária do estado frio (`state`)

**Descartado.** Já foi resolvido — só que por outro caminho. O comentário em
`go/server/sala.go:900-923` documenta a investigação original: o custo de 11,2 KB/s/jogador não
vinha do formato (JSON), vinha da CADÊNCIA (o relógio da rodada publicando o estado inteiro a
20 Hz). Trocar a cadência para "só quando muda de verdade, mais 1×/s pelo relógio" resolveu o
problema na raiz e levou o canal a 1,07 KB/s/jogador — mais barato do que qualquer ganho que
MessagePack ou Protobuf trariam sobre um payload que já é pequeno (benchmarks de mercado mostram
ganhos de ~1,7–2,6× em payloads deste tamanho; 1,07 KB/s ÷ 2 ainda é irrelevante para qualquer
jogador, mesmo em 3G). Não há número que justifique a complexidade de um segundo formato de
serialização para o estado frio.

### 4.3 Compressão delta / interest management

**Descartado.** Estas técnicas existem para dois problemas que este jogo não tem: (1) mundos
grandes onde a maioria das entidades está fora do campo de visão de um jogador — aqui a sala inteira
(`VagasPorSala = 10`) cabe numa única arena pequena, todo mundo é potencialmente relevante o tempo
todo; (2) contagem de entidades alta o bastante para que "só o que mudou" seja uma fração pequena
do total — aqui o snapshot já é o estado inteiro em 8 bytes por tanque
(`go/server/codec.go:48-70`), e numa partida em andamento a imensa maioria dos tanques está se
movendo a cada snapshot, então o delta seria quase do tamanho do estado cheio mesmo. Os números de
produção confirmam que não há problema a resolver: 1,07–1,16 KB/s por jogador com até 19 jogadores
em 2 salas simultâneas, zero erros. Interest management é arquitetura para MMO de centenas de
entidades, não para uma arena FFA de até 10 tanques.

### 4.4 Compensação de lag no servidor para o tiro

**Descartado, com números.** A técnica clássica de *lag compensation* (rebobinar o mundo para o
instante em que o atirador viu o alvo) resolve um problema específico de armas **hitscan**: o tiro
acerta instantaneamente, então o servidor precisa reconstruir "onde o alvo estava" no momento do
clique. Balas neste jogo não são hitscan — são projéteis simulados tick a tick,
autoritativamente, no próprio servidor (`BULLET_SPEED = 215 px/s`,
`packages/protocol/src/constants.ts:8`), e a colisão é decidida pela simulação avançando pra
frente, nunca por reconstrução de um instante passado. Não existe "o que o atirador viu" a
reconciliar — existe só "onde a bala e o tanque estão, tick a tick", e os dois lados usam a mesma
física.

O erro posicional que a rede introduz é, na prática, pequeno demais para justificar a complexidade:
com `TANK_SPEED = 60 px/s`, um RTT de 100 ms desloca um tanque no máximo `60 × 0,1 = 6 px`; mesmo
150 ms de atraso (o pior caso comum, coberto por `MAX_EXTRAPOLACAO_MS = 260 ms` em
`interpolation.ts:67`) desloca só 9 px. Isso é muito menor que a tolerância de acerto
bala↔tanque, que é `TANK_RADIUS (18,48 px) + BULLET_RADIUS (4,2 px) ≈ 22,7 px`
(`TANK_RADIUS_F = 0,22`, `BULLET_RADIUS_F = 0,05`, `CELL = 84`). E o tempo de voo típico de uma
bala num labirinto deste tamanho (centenas de pixels ÷ 215 px/s) é de 1 a 3 segundos — a janela de
incerteza de rede (~100–150 ms) é 3–5% disso. Não há um "instante do clique" a defender porque não
existe clique instantâneo: existe uma trajetória de segundos, autoritativa, que já absorve esse
erro sozinha.

Se um dia o jogo trocar bala por arma hitscan (não é o caso hoje — `MAX_BOUNCES`, `BULLET_LIFE` e
toda a mecânica de ricochete pressupõem projétil), esta análise muda e vale reabrir.

## 5. Fontes

- [WebTransport Is Now Baseline. Here's What That Means for Real-Time Media](https://webrtc.ventures/2026/04/webtransport-is-now-baseline-what-it-means-for-real-time-media/) — confirma Baseline em 2026 e o motivo (Safari 26.4).
- [WebKit Features for Safari 26.4](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/) — anúncio oficial da WebKit do suporte a WebTransport.
- [Announcing Interop 2026 | WebKit](https://webkit.org/blog/17818/announcing-interop-2026/) — WebTransport como item formal do Interop 2026.
- [GitHub - quic-go/quic-go](https://github.com/quic-go/quic-go) — status "production-ready" da base QUIC em Go.
- [GitHub - quic-go/webtransport-go](https://github.com/quic-go/webtransport-go) — confirma draft-16, sem release 1.0.
- [webtransport package - pkg.go.dev](https://pkg.go.dev/github.com/quic-go/webtransport-go) — mesma confirmação, via documentação do pacote.
- [Traefik HTTP/3 Configuration Tutorial - Catchpoint/LogicMonitor](https://www.catchpoint.com/http2-vs-http3/traefik-http-3) — exigência de `443/udp` + `experimentalHTTP3`.
- [Traefik Overview | Coolify Docs](https://next.coolify.io/docs/core/networking/proxy/traefik/overview) — como o Coolify gera e gerencia a configuração do Traefik.
- [Your API Isn't Slow. Your Payload Is: Protobuf vs MessagePack vs CBOR vs FlatBuffers (Benchmarked)](https://medium.com/@the_atomic_architect/your-api-isnt-slow-your-payload-is-ca6d0193477c) — ordem de grandeza dos ganhos de serialização binária sobre JSON.
- [Client-Side Prediction and Server Reconciliation - Gabriel Gambetta](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html) — referência clássica, ainda válida, da técnica proposta em §3.1 (mecanismo não mudou desde 2013; o que mudou foi a maturidade de WebTransport, não de predição/reconciliação).
- [Netcode Series Part 4: Projectiles (Lag Compensation and Prediction)](https://medium.com/@geretti/netcode-series-part-4-projectiles-96427ac53633) — distinção hitscan × projétil usada em §4.4.
- [Performing Lag Compensation in Unreal Engine 5 | SnapNet](https://snapnet.dev/blog/performing-lag-compensation-in-unreal-engine-5/) — confirma que lag compensation por rebobinamento é uma técnica de hitscan, com janelas de 250–500 ms usadas por jogos de referência (Battlefield 4, Overwatch, CoD:IW) — contexto para o cálculo de tolerância em §4.4.
- `MEDICAO.md` (raiz do repo) — linha de base de produção e hipóteses já derrubadas, usadas como piso de todo este relatório.
- `_o2-ping-tank.txt`, `_o2-ping-g.txt` (raiz do repo) — RTT deste desenvolvedor até o servidor de produção, usado como piso otimista em §3.1 (não representativo da distribuição real de jogadores).
