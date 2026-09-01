# R3 — Backend Go, escala e operação

> Nota de contexto: o `CLAUDE.md` da raiz descreve o backend como Colyseus/Node — está
> **desatualizado**. O servidor em produção é **Go** (`go/server/`), WebSocket cru via
> `github.com/coder/websocket`, com a simulação portada em `go/sim/` e paridade bit a bit provada
> contra `packages/shared-sim`. `go.mod` e o `Dockerfile` fixam `go 1.27`/`golang:1.27` (o
> `CLAUDE.md` da tarefa fala em "1.26.7" — a versão real do toolchain é a que está nesses dois
> arquivos, e é ela que uso abaixo).

## 1. Resumo

O gargalo de hoje **não é a arquitetura, é a falta de instrumento**: uma goroutine por sala com
ticker de 60 Hz é o padrão certo para este tamanho de jogo, e a conta feita abaixo (§3.1) mostra
folga de sobra até 200 salas/2.000 jogadores num único container — mas essa conta é uma estimativa,
não uma medição, porque **o servidor não expõe `pprof` nem métrica nenhuma hoje**. O único ponto
fraco real e concreto é a ausência de qualquer defesa contra abuso de conexão (nenhum teto de
salas, nenhum limitador de handshake, nenhum limite de taxa de `input` por cliente) e a ausência de
`GOMEMLIMIT`, que é uma mudança de configuração de duas linhas, sem risco. Escala horizontal e
GC agressivo **não são a prioridade agora** — nada no código ou nos números aponta necessidade, e
implementá-los cedo trocaria simplicidade por complexidade que ninguém vai usar tão cedo.

## 2. Recomendações priorizadas

| # | Recomendação | Impacto esperado | Custo | Risco |
|---|---|---|---|---|
| 1 | `pprof` interno (loopback, opt-in) + métricas Prometheus mínimas | **Alto** — sem isto, todas as outras contas desta pesquisa (inclusive a minha) são estimativa, não medição | Baixo — ~40 linhas, nenhuma dependência nova para pprof; 1 dependência pequena para métricas | Baixo — endpoints fechados por padrão |
| 2 | Teto de salas simultâneas + limitador de handshake em `/ws` | Médio — fecha o único vetor de exaustão de recursos que existe hoje (criação irrestrita de salas) | Baixo — ~20 linhas | Baixo |
| 3 | Limite de taxa de `input` por conexão | Médio — protege o tick de um cliente malicioso/quebrado inundando o canal `comandos` | Baixo — ~15 linhas, 1 dependência já na stdlib estendida (`golang.org/x/time/rate`) | Baixo |
| 4 | `GOMEMLIMIT` via variável de ambiente (manter `GOGC` padrão) | Médio — proteção preventiva contra OOM-kill do Coolify; hoje não existe teto nenhum | Muito baixo — 1 linha no Dockerfile/Coolify, zero código Go | Baixo |
| 5 | Fila do `Gravador` (32) virar métrica em vez de só log, e crescer um pouco | Baixo — hoje é só um log perdido em caso de pico; não há evidência de que já tenha acontecido | Baixo | Baixo |
| 6 | Cobrir os scripts de carga com bots, correlação com métricas e checagem do próprio *event loop* | Médio — evita repetir o erro que o `MEDICAO.md` já documentou (medir o arnês, não o jogo) | Médio | Baixo |
| — | Escala horizontal por subdomínio (uma instância Coolify por link) | Alto **quando** o público crescer, mas **não fazer agora** — ver §3.7 | Médio–alto | Médio (SQLite fica isolado por instância) |
| — | GC agressivo (`GOGC` baixo ou desligado) | **Não recomendado agora** — ver §4 | — | — |
| — | Reduzir alocações por tick em `sala.go`/`sim.go` | **Não recomendado agora sem medir** — ver §4 | — | — |
| — | Trocar SQLite por Postgres/Turso/rqlite | **Não recomendado agora** — ver §4 | — | — |

## 3. As recomendações, em detalhe

### 3.1 Arquitetura de sala em escala — a conta que sustenta "não mexa"

**Por quê.** A pergunta era "uma goroutine por sala com ticker é o padrão certo para 2026, e onde
isso quebra". `go/server/sala.go:157-161` sobe uma goroutine (`go s.laco()`) por sala, com um
`time.Ticker` de 60 Hz (`sala.go:239-240`) e um canal de comandos com buffer 256
(`sala.go:170`, `comandos: make(chan func(), 256)`). Isso é exatamente o "laço single-thread" que o
Colyseus dava de graça, e é o desenho recomendado pela literatura de 2025/2026 para arquitetura de
sala em Go: cada goroutine ociosa custa poucos KB de stack, e o problema só aparece quando
goroutines *trabalham* de verdade (alocam, giram em loop apertado, disputam canal/mutex) — não pela
contagem em si (fontes: goperf.dev, tpaschalis.me, abaixo).

A conta, para 200 salas cheias (2.000 jogadores, o teto realista de "50 → 200 salas" da tarefa):

- **Goroutines**: 200 salas × 1 (`laco`) + até 24 clientes/sala × 2 goroutines de rede
  (`conexao.go:104`, `escrever`, mais a goroutine do handler HTTP que lê o socket em
  `servidor.go:244`, `lacoDeLeitura`) ≈ 200 + 200×2×10 (jogadores reais, não o teto de
  espectadores) ≈ 4.200 goroutines. Go rotineiramente sustenta 100 mil a 1 milhão de goroutines
  ociosas num laptop médio — 4.200 é irrelevante.
- **CPU de física**: 200 salas × 60 Hz = 12.000 chamadas de `sim.Step` por segundo
  (`sala.go:369`). Cada chamada resolve no máximo ~20 balas vivas (`MaxBulletsByPlayers`,
  `go/protocol/constants.go`) contra um labirinto de até 9×13 células
  (`MazeByPlayers`, mesmo arquivo) — algumas centenas de segmentos de parede, sem *broadphase*
  espacial (é busca linear em `go/sim/collision.go`, mas sobre um conjunto pequeno). Mesmo a
  50 µs por chamada — bem acima do que colisão círculo×AABB nessa escala costuma custar em Go —
  isso é 12.000 × 50 µs = 600 ms de CPU por segundo, ou **~0,6 núcleo** para 2.000 jogadores
  simultâneos jogando ao mesmo tempo. Um único vCPU moderno sobra.
- **Rede**: o snapshot binário (`codec.go:48`, `EncodeSnapshot`) é 1 + 8×N bytes — 81 bytes para
  10 tanques — a 20 Hz. 200 salas cheias = 40.000 envios/s ≈ 3,2 MB/s de saída total. O número
  medido hoje (1,16 KB/s/jogador, `MEDICAO.md` não cobre isto, é da tarefa) escala linearmente para
  ~2,3 MB/s em 2.000 jogadores — mesma ordem de grandeza.

**O que falta para isto deixar de ser estimativa.** Os 50 µs/chamada de `sim.Step` acima são um
chute conservador, não uma medição — é exatamente o número que a recomendação #1 (pprof) mede em
minutos com `_carga-ws.cjs` apontado para uma cópia local com os mesmos limites de CPU/memória do
container de produção. Sem isso, "aguenta 200 salas" é uma hipótese bem fundamentada, não um fato
— e o `MEDICAO.md` já documentou o preço de tratar hipótese como fato neste projeto.

**Onde isso de fato quebraria primeiro, se quebrasse**: não é o laço de 60 Hz, é um dos três pontos
abaixo (#2, #3, #5) — recursos **sem teto nenhum** hoje, ao contrário da física, que tem um teto
natural baixo por causa do tamanho fixo de sala (10 jogadores, `VagasPorSala`).

### 3.2 `pprof` interno — passo a passo, não a teoria

**Por quê.** O binário (`go/cmd/servidor/main.go`) não importa `net/http/pprof` em lugar nenhum.
Hoje não há como saber quanto `sim.Step`, `transmitir` (JSON) ou `enviarSnapshot` custam de CPU e
alocação — é a lacuna que sustenta toda a incerteza de §3.1.

**Onde muda.** `go/cmd/servidor/main.go`, depois do `flag.Parse()`:

```go
import (
	"net/http"
	_ "net/http/pprof"
)

// Fica DESLIGADO por padrão. Só sobe se alguém pedir explicitamente, e só em loopback — nunca na
// porta pública que o Traefik expõe.
if endereco := os.Getenv("PPROF_ADDR"); endereco != "" {
	go func() {
		log.Printf("[pprof] escutando em %s (loopback apenas)", endereco)
		log.Println(http.ListenAndServe(endereco, nil))
	}()
}
```

Em produção isso significa: **não** setar `PPROF_ADDR` no dia a dia (endpoint nem existe). Quando
precisar medir, setar `PPROF_ADDR=127.0.0.1:6061` num deploy temporário e abrir um túnel SSH até a
máquina do Coolify (`ssh -L 6061:127.0.0.1:6061 <host-coolify>`) — o pprof nunca atravessa o
Traefik, então não precisa de autenticação própria nem risco de ficar público por engano. É a
recomendação padrão de 2025/2026 (blog.oodle.ai, abaixo): pprof em porta separada, sempre atrás de
loopback ou rede privada.

**O que medir primeiro, e como ler:**

1. **CPU sob carga real**: suba o servidor local com os mesmos limites do container
   (`docker run --cpus=<N> --memory=<M> ...`, os valores configurados no Coolify para esta app),
   rode `node _carga-ws.cjs 50 60` contra ele (trocando `BASE` no topo do script para
   `ws://localhost:3000/ws`) e, durante os 60 s, capture:
   ```bash
   go tool pprof http://127.0.0.1:6061/debug/pprof/profile?seconds=30
   ```
   Dentro do pprof interativo: `top -cum` mostra quem consome mais tempo acumulado; `list Sala.update`
   ou `list sim.Step` mostra linha a linha. Se `transmitir`/`json.Marshal` aparecer acima de
   `sim.Step` no `top`, o gargalo é serialização, não física — e a resposta muda.
2. **Alocação**: `go tool pprof http://127.0.0.1:6061/debug/pprof/heap` (snapshot do heap vivo) e
   `.../debug/pprof/allocs` (todo mundo que já foi alocado, inclusive o que o GC já limpou) — é
   aqui que os candidatos de §4 (`coletarEntradas`, `tratarEventos`, `EncodeSnapshot`) aparecem, se
   de fato importarem.
3. **Vazamento de goroutine**: `.../debug/pprof/goroutine?debug=1` antes e depois de um ciclo de
   "sala cheia → todo mundo sai → sala fecha" — a contagem tem que voltar ao nível anterior. É o
   jeito mais barato de flagrar uma sala que não morreu (`Fechar`, `sala.go:267`) ou um `time.Timer`
   de reconexão (`prazosDeQueda`, `sala_jogadores.go:358`) que não foi parado.

### 3.3 Teto de salas + limitador de handshake

**Por quê.** `Hub.CriarSala` (`hub.go:51-65`) não tem limite algum: qualquer requisição
`{"t":"entrar","d":{"modo":"criar"}}` sobe uma sala nova, com goroutine, ticker e mapas próprios.
Uma sala vazia se fecha sozinha depois de 60 s (`salaAbandonada`, `sala.go:311-325`,
`janelaDeReconexao+30s`), mas nada impede um cliente malicioso de abrir milhares delas num minuto
antes desse prazo — não é fatal para o Go (§3.1), mas é um vetor de exaustão de memória/CPU gratuito
que não existe hoje em lugar nenhum do código, nem como constante nem como checagem.

**Onde muda.** `go/server/hub.go`:

```go
const MaxSalasSimultaneas = 300 // folga generosa sobre a conta de §3.1; ajustar com o pprof

func (h *Hub) CriarSala(opcoes OpcoesDaSala) (*Sala, bool) {
	h.mu.Lock()
	if len(h.salas) >= MaxSalasSimultaneas {
		h.mu.Unlock()
		return nil, false
	}
	codigo := h.codigoLivreSemTrava()
	h.salas[codigo] = nil
	h.mu.Unlock()

	sala := NovaSala(h, codigo, opcoes)
	h.mu.Lock()
	h.salas[codigo] = sala
	h.mu.Unlock()
	return sala, true
}
```

(`servidor.go:198`, o chamador em `receberEntrada`, passa a tratar o `false` como
`erroSalaLotada` ou um novo `erroServidorCheio`.)

Para o handshake, `Servidor.aoConectar` (`servidor.go:106`) aceita qualquer conexão sem limite de
taxa. Um limitador **global** (não por IP — mais simples, e o Coolify/Traefik já absorve picos de
conexão TCP antes de chegar aqui) usando `golang.org/x/time/rate`:

```go
// no Servidor:
handshakes *rate.Limiter // rate.NewLimiter(rate.Limit(20), 40) — 20/s sustentado, rajada de 40

func (s *Servidor) aoConectar(w http.ResponseWriter, r *http.Request) {
	if !s.handshakes.Allow() {
		http.Error(w, "muitas conexões, tente de novo", http.StatusTooManyRequests)
		return
	}
	// ... resto igual
}
```

É o "caminho mais simples que funciona": um limitador global e sem estado por IP resolve o caso
real (flood de conexões) sem precisar rastrear e limpar um mapa de IP → limiter.

### 3.4 Limite de taxa de `input` por conexão

**Por quê.** `Sala.aoInput` (`sala_mensagens.go:160-175`) só sobrescreve
`s.ultimoInput[sessionID]` — não há custo de simulação extra por mensagem repetida, e o disparo em
si já é limitado no servidor por `FireCooldown` dentro de `sim.Step` (não em `go/server`, então um
cliente que manda `fire` em toda mensagem não ganha tiro extra). O risco real é outro: cada
mensagem de `input` passa por `json.Unmarshal` e por `sala.Executar` (`sala.go:223-235`), que
enfileira no canal `comandos` de 256. Nada no código impede um cliente (bug ou má-fé) de mandar
milhares de mensagens por segundo — o cliente real manda a 30 Hz
(`_carga-ws.cjs:52`, `setInterval(..., 33)`). Um cliente hostil nessa fila compete por espaço com
os ticks do relógio no mesmo `select` de `laco()` (`sala.go:244-263`) e, na pior hipótese, empurra
outros jogadores da mesma sala para fora da janela de `talvezPublicarEstado`.

**Onde muda.** `go/server/conexao.go`, no `Cliente`:

```go
import "golang.org/x/time/rate"

type Cliente struct {
	// ... campos existentes
	limiteDeEntrada *rate.Limiter // criado em novoCliente: rate.NewLimiter(40, 80) — 40 msg/s, rajada 80
}
```

E em `servidor.go:244`, `lacoDeLeitura`, antes de repassar para a sala:

```go
if tipo == websocket.MessageText {
	if !c.limiteDeEntrada.Allow() {
		continue // descarta a mensagem, não derruba a conexão — um pico de 1 tick não é abuso
	}
	// ... unmarshal e sala.Executar como já é hoje
}
```

40 msg/s dá folga de mais de 30% sobre a cadência real do cliente (30 Hz) sem abrir a porta para um
cliente mandando milhares por segundo. Descartar em vez de desconectar evita punir uma rajada
legítima (reconexão, recuperação de rede) com a mesma queda que hoje já existe para fila de saída
cheia (`conexao.go:65-77`).

### 3.5 `GOMEMLIMIT`

**Por quê.** O runtime do Go não lê limite de cgroup para memória sozinho — só para CPU
(`GOMAXPROCS`, e só a partir do Go 1.25; ver nota abaixo). Sem `GOMEMLIMIT`, o coletor só reage ao
`GOGC` (padrão 100: dobra o heap vivo antes de coletar), sem noção nenhuma do teto de memória que o
Coolify vai aplicar ao container — se o Coolify tiver um limite de memória configurado nesta app
(não está no repositório; é ajuste do painel), o processo pode ser morto pelo OOM killer do Docker
*antes* de o GC decidir que precisa correr, porque ele não sabe que existe um teto.

**Onde muda.** Nenhuma linha de Go — `GOMEMLIMIT` e `GOGC` são lidas pelo runtime como variáveis de
ambiente puras. `Dockerfile:44-46`:

```dockerfile
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV CLIENT_DIST=/app/client
# Ajustar para ~90% do limite de memória configurado para esta app no Coolify. Sem um limite
# configurado lá, esta variável não tem contra o que proteger — confirmar o valor no painel antes
# de fixar o número abaixo.
ENV GOMEMLIMIT=460MiB
```

**Por que não `GOGC=off`** (só `GOMEMLIMIT` como teto): é a recomendação comum para cargas de
lote/alto throughput, mas este é um laço de *tick* com latência apertada (16,7 ms de orçamento por
frame) — desligar `GOGC` faz o coletor só agir perto do teto de memória, e é exatamente perto do
teto que uma pausa grande dói mais (ex.: durante uma rajada de salas terminando ao mesmo tempo,
§3.1). Manter `GOGC=100` (o padrão, não precisa nem declarar) como gatilho proativo e
`GOMEMLIMIT` como cinto de segurança é a combinação que a literatura de 2025/2026 recomenda para
este perfil de carga (support.tools, weaviate.io, abaixo). Se o pprof (§3.2) mostrar pausas de GC
relevantes no p99 do tick, `GOGC` mais baixo (25–50) é o próximo passo — não antes de medir.

**Nota sobre `GOMAXPROCS`**: como o toolchain já é 1.27 (`go.mod`, `Dockerfile`), o runtime já
ajusta `GOMAXPROCS` sozinho ao limite de CPU do cgroup automaticamente desde o Go 1.25 — não é
preciso `go.uber.org/automaxprocs` nem nenhuma configuração manual. A única ação necessária é
**confirmar que a app tem um limite de CPU configurado no Coolify**; se não tiver, não há nada
para o runtime respeitar (e também não há risco de *throttling*, então não é urgente).

### 3.6 Fila do `Gravador`

**Por quê.** `go/cmd/servidor/gravador.go:29` cria a fila de gravação com `make(chan
server.RegistroDaPartida, 32)`. Se mais de 32 partidas terminam antes de a goroutine única de
escrita (`laco`, `gravador.go:44`) drenar a fila — plausível numa rajada de dezenas de salas
terminando quase juntas, não no volume de hoje —, o resultado é descartado silenciosamente, só um
`log.Printf` (`gravador.go:40`). Isso é coerente com a decisão documentada ("perder o registro de
uma partida é ruim, perder a partida em si é pior"), mas hoje não há como saber, de fora de um log
de texto, que isso já aconteceu.

**Onde muda.** Trocar o `log.Printf` por um contador exposto nas métricas da recomendação #1
(`partidas_descartadas_total`), e considerar subir a fila de 32 para algo como 128 — o custo de
memória é irrelevante (128 × tamanho de `RegistroDaPartida`, uns poucos KB) e dá bem mais folga
para uma rajada sem mudar a garantia "não bloqueia o tick da sala".

### 3.7 Escala horizontal — o caminho mais simples que funciona (não implementar agora)

**Por quê isto não é prioridade agora.** A conta de §3.1 diz que uma instância aguenta a ordem de
200 salas com folga. O jogo é "até 10 colegas de trabalho" por link — não existe hoje matchmaking
público que precise distribuir jogadores entre instâncias. Implementar isto agora trocaria uma
arquitetura de 1 processo, sem estado distribuído, por uma com routing e dados fragmentados — pelo
motivo errado.

**Se algum dia for necessário, o caminho mais simples (não o mais elegante):**

- **Roteamento**: nada de sessão fixa/Traefik sticky por trás de um domínio único. O link que o
  dono da sala compartilha já carrega tudo que é preciso: se cada instância do Coolify tiver o
  **próprio subdomínio** (`tank-a.walisson.dev`, `tank-b.walisson.dev`, ...), "o jogador cai na
  instância da sua sala" já está resolvido — o link inteiro (host + código de 4 letras) aponta para
  a instância certa, sem cookie, sem afinidade, sem coordenação entre instâncias. É a mesma
  observação que fez o Traefik descartar o sticky-session-para-WebSocket como problema aqui: ele só
  ajuda a *escolher* uma instância na hora do *upgrade* inicial (community.traefik.io,
  stackharbor.com, abaixo), e neste jogo essa escolha já é feita — pelo link — antes mesmo de a
  conexão abrir.
- **Traefik/Coolify**: o recurso nativo de réplicas do Coolify usa Docker Swarm e está documentado
  como experimental, com um problema conhecido de nomes de container fixos que atrapalha réplica
  de verdade (github.com/coollabsio/coolify #3862, #1579, abaixo) — **não** é o caminho certo aqui.
  Multi-servidor do Coolify (uma app por servidor, cada uma com seu domínio) é o recurso maduro e é
  exatamente o que o esquema acima usa.
- **SQLite**: cada instância mantém seu próprio arquivo/volume, exatamente como hoje
  (`go/persist/db.go:35`). Isso significa que o rating OpenSkill (`AtualizarRatings`,
  `db.go:185`) fica **isolado por instância** — mas isso não quebra nada que exista hoje: não há
  nenhuma rota HTTP em `go/server/servidor.go` que leia ranking do banco (só `EnviarWebhook`,
  que é fire-and-forget para um canal externo, `go/persist/webhook.go`). Se um ranking global
  entre instâncias vier a existir, o ponto certo para agregar é fora do caminho de jogo — um job
  periódico lendo os SQLite locais, não um banco compartilhado entrando no tick.

### 3.8 Observabilidade — métricas, sem virar projeto paralelo

**Por quê.** Hoje o único sinal de vida é `/healthz` (`servidor.go:41-43`, só `{"ok":true,
"rooms":N}`). Não dá para saber, de fora, se um tick está atrasado, quantos jogadores por sala, ou
se a fila de saída de algum cliente está perto de estourar.

**Onde muda.** `github.com/prometheus/client_golang` é a única dependência nova recomendada aqui —
pequena, sem cgo, coerente com o resto do `go.mod` (que já é enxuto de propósito). Métricas com
**cardinalidade baixa** (nunca rotular por código de sala — são efêmeros, milhares ao longo do
tempo, e isso explodiria a cardinalidade do Prometheus):

```go
var (
	ticksAtrasados = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "tank_ticks_atrasados_total",
		Help: "Ticks em que o dt precisou ser cortado por maxTicksDeRecuperacao",
	})
	tempoDeTick = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "tank_tick_segundos",
		Help:    "Duração de Sala.update, uma amostra por tick por sala",
		Buckets: prometheus.ExponentialBuckets(0.0001, 2, 12), // 0,1ms .. ~400ms
	})
	salasAtivas = prometheus.NewGauge(prometheus.GaugeOpts{Name: "tank_salas_ativas"})
	clientesConectados = prometheus.NewGauge(prometheus.GaugeOpts{Name: "tank_clientes_conectados"})
	filaDeSaidaCheia = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "tank_fila_saida_cheia_total", // incrementa onde conexao.go:65-77 já devolve `false`
	})
	partidasDescartadas = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "tank_partidas_descartadas_total", // ver §3.6
	})
)
```

`sala.go:257-260` (dentro de `laco`, no caso `agora := <-relogio.C`) é onde `dt > teto` já é
detectado — só falta `ticksAtrasados.Inc()` ali, e envolver `s.update(dt)` com
`tempoDeTick.Observe(...)`. `salasAtivas`/`clientesConectados` são atualizados onde `publicarSala`
já roda (`sala_jogadores.go:202`). Expor tudo em `/metrics` no mesmo mux HTTP que já serve
`/healthz` e `/salas` (`servidor.go:37-52`) — mesma porta, sem processo nem projeto novo; texto
Prometheus não vaza nada sensível, ao contrário do pprof, então não precisa do mesmo cuidado de
loopback.

### 3.9 Teste de carga — o que `_carga-ws.cjs`/`_carga-sala.cjs` medem errado

Os dois scripts já acertam o ponto mais importante, que é justamente a lição central do
`MEDICAO.md`: simular jogadores como conexões WebSocket cruas, e não como navegadores de verdade,
porque "rodar vários Chromium mede a máquina, não o jogo" (comentário no topo dos dois arquivos).
Isso é o desenho certo. Mas os dois só medem o que chega no **cliente sintético** — nunca o que
acontece **dentro** do servidor:

1. **Não correlacionam com custo de servidor.** `m.snapshots`, `m.bytes`, `m.erros` são só o que
   cada `ws.onmessage` viu. Sem a recomendação #1 (métricas) não há como saber, durante o mesmo
   teste, se o tick atrasou, quanta CPU/memória o container usou, ou se a fila de saída de algum
   cliente quase estourou (`conexao.go:51`, `tamanhoDaFila = 128`). Um teste "limpo" (zero erros,
   tráfego dentro do esperado) pode estar escondendo um servidor a 90% de CPU.
2. **Não testam salas com bots.** `_carga-ws.cjs:74`, `{ modo: 'criar', bots: 0 }` — todo jogador é
   uma conexão real. A IA dos bots (`gameplay.go:157`, `cerebroDoSim.Think`, que embrulha
   `sim.MakeBot`) faz busca de caminho e nunca é exercitada por estes scripts, mas é código real
   que roda em produção sempre que alguém preenche a sala com bots — um padrão de uso comum o
   bastante para o lobby ter botão de "+ bot" (`sala_mensagens.go:74`).
3. **Criam salas todas de uma vez, não em regime permanente.** `_carga-ws.cjs:71-81` sobe todas as
   salas em rajada, com pausas curtas fixas (3,5 s entre salas, 150 ms entre jogadores da mesma
   sala) e roda por um tempo fixo. Isso testa "encher tudo de uma vez", não o padrão real de
   crescimento (salas nascendo e morrendo o tempo todo, partidas de 10 rodadas terminando em
   momentos espalhados) nem sustenta carga por tempo suficiente para ver o efeito de GC/memória se
   acumulando.
4. **O próprio gerador de carga não se audita.** É um único processo Node com um `setInterval` de
   33 ms por jogador simulado. Em N grande (algumas centenas), o *event loop* do Node pode começar
   a atrasar os próprios timers antes de o servidor sentir alguma coisa — exatamente o padrão que o
   `MEDICAO.md` descreve para o Chromium do Playwright: o arnês vira o gargalo, e o número que sai
   parece bom porque mediu a ferramenta errada. Nenhum dos dois scripts expõe o próprio atraso de
   *event loop* (`perf_hooks.monitorEventLoopDelay()` resolveria isso em poucas linhas).

**Recomendação prática, sem trocar de ferramenta**: nenhuma reescrita é necessária — os scripts já
usam a abordagem certa. Adicionar, nesta ordem de custo/benefício: (a) alguma fração de salas
criadas com bots reais; (b) uma leitura de `/metrics` (§3.8) a cada poucos segundos durante o teste,
salva junto do resultado; (c) `monitorEventLoopDelay()` reportado no resumo final, para descartar o
gerador como suspeito antes de acusar o servidor; (d) criação de salas espalhada no tempo (Poisson
simples) em vez de rajada única, para simular chegada orgânica. Migrar para `k6`/`xk6-websockets`
é uma opção válida mais adiante (suporta VUs paralelos de verdade, então o problema do item 4 some
por construção), mas é troca de ferramenta, não correção do que existe — custo maior, para um
ganho que os quatro ajustes acima já entregam por uma fração do preço.

## 4. O que investiguei e descartei

- **Reduzir alocações por tick agora** (`coletarEntradas`, `sala.go:658-680`; `idsDasBalas`
  chamado duas vezes por tick, `sala.go:368` e `373`; `tratarEventos`, `sala.go:719-797`, aloca um
  `map[string]bool` e um `[]string` por tick mesmo quando não há evento; `sim.Step`,
  `go/sim/sim.go:655`, aloca `events := make([]SimEvent, 0, 8)` a cada chamada). Todos são
  candidatos reais a *buffers* reaproveitados — o próprio `gameplay.go:97-109`
  (`campoDoPorte.NoChao`) já mostra o padrão (`c.posicoes = c.posicoes[:0]`) em uso no mesmo
  arquivo. Descartei mexer **agora** porque a conta de §3.1 estima um volume de lixo desprezível
  para o Go absorver na escala atual e na de 200 salas, e otimizar sem medir é exatamente o erro
  que o `MEDICAO.md` já pagou caro do lado do cliente. Isto é candidato de primeira linha **se** o
  perfil de alocação do pprof (§3.2) mostrar GC como fração relevante do tempo — não antes.
- **`GOGC` baixo ou desligado.** Rejeitado para este workload por ser um laço de tick de latência
  apertada; ver justificativa completa em §3.5.
- **Réplicas nativas do Coolify (Docker Swarm) para escalar horizontalmente.** Descartado: a
  própria comunidade do Coolify documenta a feature como experimental e com um defeito conhecido de
  nomes de container fixos que atrapalha réplica de verdade (github.com/coollabsio/coolify #3862).
  O caminho por subdomínio (§3.7) é mais simples e não depende de um recurso instável da
  plataforma.
- **Trocar SQLite por Postgres/Turso/rqlite agora.** O próprio código já documenta o motivo de
  ficar com SQLite (`db.go:39-41`: "o volume de escrita deste jogo é uma partida a cada poucos
  minutos"), e nada nesta pesquisa muda essa conta — o gargalo de escrita de banco não aparece em
  lugar nenhum antes de existir escala horizontal de verdade (§3.7), que por sua vez não é
  prioridade agora. Turso/rqlite voltam à mesa **somente** se/quando a escala horizontal virar
  necessidade real e um ranking global entre instâncias for exigido.
- **`go.uber.org/automaxprocs`.** Redundante: desde o Go 1.25, `GOMAXPROCS` já respeita o limite de
  CPU do cgroup automaticamente, e o toolchain deste projeto (`go.mod`: `go 1.27`) já está acima
  dessa versão. Ver nota em §3.5.
- **Migrar já para `k6`/`xk6-websockets`.** Descartado por ora — os scripts atuais já acertam a
  decisão mais importante (WebSocket cru, não navegador). O problema é cobertura de medição, não a
  ferramenta; ver a recomendação prática em §3.9.
- **Rate limit por IP (em vez de global) no handshake.** Descartado como primeira versão: exige
  mapa de IP → limiter com faxina própria (memória cresce com IPs únicos vistos) para resolver um
  problema que um limitador global e sem estado já cobre — é a "opção mais simples que funciona"
  pedida na tarefa. Fica como upgrade se um dia o abuso vier concentrado de poucos IPs.

## 5. Fontes

- [Managing 10K+ Concurrent Connections in Go — Go Optimization Guide](https://goperf.dev/02-networking/10k-connections/)
- [Reaching the ceiling of single-instance Go — tpaschalis](https://tpaschalis.me/reaching-the-ceiling-of-single-instance-go/)
- [Memory Efficiency and Go's Garbage Collector — Go Optimization Guide](https://goperf.dev/01-common-patterns/gc/)
- [Go Profiling in Production: A Practical pprof Guide — Oodle](https://blog.oodle.ai/go-profiling-in-production/)
- [How to Implement Continuous Profiling in Go with pprof and Pyroscope — OneUptime](https://oneuptime.com/blog/post/2026-01-07-go-continuous-profiling/view)
- [Go Garbage Collection Tuning: Production Performance Optimization Guide — support.tools](https://support.tools/go-garbage-collection-tuning-production-guide/)
- [GOMEMLIMIT is a game changer for high-memory applications — Weaviate](https://weaviate.io/blog/gomemlimit-a-game-changer-for-high-memory-applications)
- [Garbage Collection Under Pressure: Memory Limits in Containers — stdout](https://daveamit.com/posts/2026-07-01-gc-pressure/)
- [The Green Tea Garbage Collector — go.dev/blog](https://go.dev/blog/greenteagc)
- [runtime: green tea garbage collector — golang/go#73581](https://github.com/golang/go/issues/73581)
- [Container-aware GOMAXPROCS — go.dev/blog](https://go.dev/blog/container-aware-gomaxprocs)
- [Container-Aware GOMAXPROCS (New in Go 1.25) — Applied Go](https://appliedgo.net/spotlight/go-1.25-container-aware-gomaxprocs/)
- [rate package — golang.org/x/time/rate (pkg.go.dev)](https://pkg.go.dev/golang.org/x/time/rate)
- [Go Wiki: Rate Limiting](https://go.dev/wiki/RateLimiting)
- [Rate limiter in Go: per-IP token bucket with golang.org/x/time/rate — DEV Community](https://dev.to/ohugonnot/rate-limiter-in-go-per-ip-token-bucket-with-golangorgxtimerate-5ff8)
- [Sticky session doesn't work with websocket — traefik/traefik#3343](https://github.com/traefik/traefik/issues/3343)
- [Traefik sticky sessions — cookie-based affinity, secure attributes, and the limits — Stack Harbor](https://stackharbor.com/en/knowledge-base/traefik-sticky-sessions/)
- [Sticky sessions & linear scalability — Traefik Labs Community Forum](https://community.traefik.io/t/sticky-sessions-linear-scalability-traefik-docker-cluster-spring-mvc-sockjs-websockets-http-polling/3528)
- [Allow scaling docker deployments using replicas — coollabsio/coolify#3862](https://github.com/coollabsio/coolify/discussions/3862)
- [App scaling — coollabsio/coolify#1579](https://github.com/coollabsio/coolify/discussions/1579)
- [Multi-Server & Scaling on Coolify — AZdigi](https://azdigi.com/en/blog/self-hosted/multi-server-scaling-on-coolify-expanding-your-system)
- [SQLite-on-the-Server Is Misunderstood — Rivet](https://rivet.dev/blog/2025-02-16-sqlite-on-the-server-is-misunderstood/)
- [LiteFS vs Litestream vs rqlite vs dqlite on VPS in 2025 — Onidel](https://onidel.com/blog/sqlite-replication-vps-2025)
- [Debugging Game Server Tick Rate Issues — Bugnet Blog](https://bugnet.io/blog/debugging-game-server-tick-rate-issues)
- [Observability Features — Gameye Infrastructure](https://gameye.com/observability-platform/)
- [WebSockets — Grafana k6 documentation](https://grafana.com/docs/k6/latest/using-k6/protocols/websockets/)
- [Load Testing WebSockets With k6 — Better Programming](https://betterprogramming.pub/load-testing-websockets-with-k6-feb99bf75798)
