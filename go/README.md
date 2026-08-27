# `go/` — a simulação do Tank Ricochete portada para Go, com paridade provada

Este diretório é a simulação (`packages/shared-sim`) reescrita em Go, o arranjo que prova que as
duas implementações produzem **exatamente o mesmo resultado, bit a bit** — e, desde a tarefa G2, o
**servidor** construído em volta dela.

O servidor tem documento próprio: [`server/README.md`](server/README.md) (transporte, protocolo,
salas, persistência e como ele é provado). O resto deste arquivo é sobre a PARIDADE, que continua
sendo o entregável principal do porte.

## Por que a prova é o entregável, e não o código

A bala não trafega pela rede. O servidor emite `bullet_spawn` (id, dono, posição, `vx`/`vy`,
tick) e **cada cliente simula a trajetória sozinho** com o mesmo código. É isso que torna o jogo
imune a jitter — e é isso que transforma qualquer diferença de um bit numa doença invisível: o
ricochete acontece num lugar na tela de um jogador e noutro na do adversário, e ninguém consegue
depurar.

Portar as 2.600 linhas de TypeScript de `shared-sim` para Go é um dia de trabalho. Provar que o
porte não moveu nenhum bit é o resto.

## O comando

```bash
node go/compare.mjs                                  # 10.000 seeds, todas as cinco etapas
node go/compare.mjs --seeds 200 --ticks 600          # varredura menor, partidas mais longas
node go/compare.mjs --de 50000 --seeds 1000          # outra faixa de seeds
node go/compare.mjs --partes 1                       # tudo num processo só (mais lento, mais fácil de depurar)
node go/compare.mjs --runner nativo                  # força o Go nativo (ver "execução local")
```

Ele compila o lado Go, roda as duas implementações e compara. Sai com código 0 só se **tudo**
bater. Não há tolerância, não há arredondamento, não há "perto o bastante".

### O que ele faz, em cinco etapas

| # | Etapa | O que compara |
|---|---|---|
| 1 | **constantes** | as 79 entradas da tabela de tuning (inclusive as 16 saídas de `direcaoDeMovimento`, as três receitas de `BOT_DIFFICULTY` e a agenda de power-ups), em padrão de bits. Uma constante derivada calculada com regras de arredondamento diferentes faria tudo divergir sem dizer por quê |
| 2 | **math** | `sin`, `cos`, `log`, `atan`, `atan2`, `hypot` e `round` do V8 contra `internal/jsmath`, em 380.495 casos |
| 3 | **paridade** | N seeds × 300 ticks de partida completa, resumidas em quatro SHA-256: labirinto, spawns, simulação e eventos |
| 4 | **bots** | N seeds × 300 ticks de partida dirigida pela IA, com os três níveis na mesma sala. Compara a **sequência de `Input` tick a tick**, e não o resultado: um bot que chega ao mesmo canto por outro caminho já é divergência, e o estado final não pegaria isso |
| 5 | **power-ups** | N seeds × 600 ticks com a camada de itens ligada: a agenda inteira (20 itens, tipo, ponto e tick), o que está no chão e no ar a cada tick, quem pegou o quê, o relógio de cada efeito em segundos e os quatro campos que a simulação lê do tanque |

Cada varredura é dividida em `--partes` processos (padrão: `CPUs − 2`, no máximo 6). Não é luxo:
os dois lados rodam single-thread aqui — o alvo do Go é `js/wasm`, onde `GOMAXPROCS` é 1 — e a
etapa dos bots custa ~0,23 s por seed no TypeScript, o que numa fila só passaria de meia hora.
Como as seeds são independentes e cada fatia é um intervalo **contíguo**, concatenar as saídas na
ordem das fatias reproduz byte a byte o arquivo que um processo só produziria.

Cada varredura também informa **o que ela realmente exercitou** (disparos, mortes, coletas,
efeitos expirados, balas carimbadas). Um relatório que só sabe dizer "10.000/10.000 bateram" não
distingue "provei" de "os dois lados não fizeram nada".

### Quando diverge

O script **não esconde**. Ele identifica a primeira seed culpada, roda as duas implementações de
novo em modo detalhe e imprime a primeira linha diferente — com a seção, o registro, o tick e os
dois valores em hexadecimal:

```
      --- primeira divergência, seed 0 ---
      linha 568
        go: simulacao bala 137 b3 t00 4073e4270081e438 406726ae615aa44a ...
        ts: simulacao bala 137 b3 t00 4073e4270081e426 406726ae615aa44a ...
        seção: simulacao   registro: bala   tick: 137
      dumps completos: go/out/detalhe_partida_go_0.txt
                       go/out/detalhe_partida_ts_0.txt
```

(saída real, de uma divergência injetada de propósito — ver adiante).

Para investigar uma seed sozinho, sem a varredura (troque `--cenario` por `bots` ou `powerups`
conforme a etapa que caiu):

```bash
node go/ts/paridade.mjs --modo detalhe --cenario bots --seed 4173 > /tmp/ts.txt
cd go && ./run-go.sh build -o bin/p.wasm ./cmd/paridade   # ou `go build` em Linux
node "$(go env GOROOT)/lib/wasm/wasm_exec_node.js" bin/p.wasm -modo detalhe -cenario bots -seed 4173 > /tmp/go.txt
diff /tmp/go.txt /tmp/ts.txt
```

## Resultado atual

```
[1/5] constantes de tuning
      OK — 79 constantes idênticas bit a bit

[2/5] Math.* do V8 contra internal/jsmath
      sin    OK   380495/380495 idênticos bit a bit
      cos    OK   380495/380495 idênticos bit a bit
      log    OK   380495/380495 idênticos bit a bit
      atan   OK   380495/380495 idênticos bit a bit
      atan2  OK   380495/380495 idênticos bit a bit
      hypot  OK   380495/380495 idênticos bit a bit
      round  OK   380495/380495 idênticos bit a bit

[3/5] simulação completa em 10000 seeds
      go: 62.1s   ts: 75.8s   (300 ticks/seed)
      10000/10000 seeds idênticas bit a bit

[4/5] IA dos bots em 10000 seeds
      go: 111.0s   ts: 115.5s   (300 ticks/seed)
      10000/10000 seeds idênticas bit a bit
      exercitado: 149441 disparos, 29466 mortes, 9319/10000 seeds com morte

[5/5] power-ups em 10000 seeds
      go: 186.4s   ts: 693.3s   (600 ticks/seed)
      10000/10000 seeds idênticas bit a bit
      exercitado: 6374 coletas em 6262/10000 seeds, 77689 efeitos expirados, 105942 balas carimbadas

PARIDADE COMPLETA — 1258.0s
```

**10.000 de 10.000 nas três varreduras.** Cada uma cobre salas de 2 a 10 jogadores e seis
proporções de tela (inclusive duas fora da faixa permitida, para exercitar o grampeamento):

- **partida** — 3 milhões de ticks com tiro, ricochete, morte, autogol, choque entre balas e bala
  morrendo de velhice;
- **bots** — 3 milhões de ticks decididos pela IA, com os três níveis na mesma sala. Não é uma
  varredura em que "quase nada acontece": 149.441 disparos e 29.466 mortes, com morte em
  **9.319 das 10.000 seeds**;
- **power-ups** — 6 milhões de ticks com a camada de itens ligada: **6.374 coletas espalhadas por
  6.262 seeds**, 77.689 efeitos expirando no relógio e 105.942 balas nascendo carimbadas com
  ricochete extra. As balas carimbadas são o número que mais importa: é a única parte do sistema
  de power-ups que **muda a trajetória**, e trajetória é o que o cliente simula sozinho.

### O caminho de erro também foi testado

Um relatório que só sabe dizer "tudo certo" não vale nada. O diagnóstico foi exercitado com uma
divergência injetada de propósito no lado Go — 1e-12 somado à posição de uma bala específica, num
tick específico:

```
      2/5 seeds idênticas bit a bit
      DIVERGIRAM 3 seeds
        seção simulacao: 3 seeds
        seção eventos: 3 seeds

      --- primeira divergência, seed 0 ---
      linha 568
        go: simulacao bala 137 b3 t00 4073e4270081e438 406726ae615aa44a ...
        ts: simulacao bala 137 b3 t00 4073e4270081e426 406726ae615aa44a ...
        seção: simulacao   registro: bala   tick: 137
```

Achou a seed, o tick, a bala e os dois valores. A injeção foi revertida em seguida.

As duas etapas novas passaram pelo mesmo exercício, com o erro menor que a aritmética consegue
carregar: **1e-12 rad** somados à mira de um bot num tick específico, e **1e-15 s** somados ao
relógio de um efeito. Nenhum dos dois muda nada que um humano veja na tela; os dois foram achados:

```
[4/5] IA dos bots em 5 seeds
      0/5 seeds idênticas bit a bit
        seção bots: 5 seeds
        seção simulacao: 5 seeds
      --- primeira divergência, cenário bots, seed 0 ---
      linha 558
        go: bots input 137 t01 40063b50a532e471 1 0 4008ccea487d87b0 1
        ts: bots input 137 t01 40063b50a532e471 1 0 4008ccea487d7ee4 1
        seção: bots   registro: input   tick: 137

[5/5] power-ups em 5 seeds
      1/5 seeds idênticas bit a bit
        seção powerups: 4 seeds
      --- primeira divergência, cenário powerups, seed 0 ---
      linha 33
        go: powerups efeito 0 t01 ricochete 4021f77777777778 4022000000000000
        ts: powerups efeito 0 t01 ricochete 4021f77777777777 4022000000000000
        seção: powerups   registro: efeito   tick: 0
```

Repare no caso dos power-ups: **4 de 5 seeds**, e não 5. A quinta não tinha efeito nenhum ligado
naquele tanque — o relatório não arredondou isso para "todas". As duas injeções foram revertidas
em seguida.

## A descoberta que decidiu o porte

`math.Sin` do Go **não é** `Math.sin` do V8. Medido aqui, com 200.000 ângulos na faixa real do
jogo:

| função | divergência entre `math` do Go e `Math` do V8 |
|---|---|
| `sin` | **22,30%** dos valores |
| `cos` | **27,00%** |
| `atan2` | **21,48%** |
| `log` | **1,27%** |

Não é bug de ninguém: as duas bibliotecas são corretas dentro de 1 ULP. O Go herdou sin/cos/atan
do **Cephes** e o V8 herdou do **fdlibm**. São polinômios e reduções de argumento diferentes, e
"correto dentro de 1 ULP" é incompatível com "idêntico".

Um porte ingênuo teria passado em todo teste de tolerância e falhado em produção, num ricochete a
cada poucos minutos.

`internal/jsmath` resolve isso portando o **mesmo fdlibm que o V8 carrega**. Não são funções
equivalentes: é a mesma sequência de operações de ponto flutuante, na mesma ordem, com as mesmas
constantes.

Achar a variante certa do fdlibm exigiu três medições — as duas linhagens (Sun e FreeBSD)
diferem em detalhes, e cada detalhe custou divergências:

| variante da redução de argumento | divergências em 380.495 casos |
|---|---|
| casos especiais até 9π/4 (FreeBSD) | 1 |
| casos especiais até 3π/4 + atalho `npio2_hw` (Sun) | 18 |
| casos especiais até 3π/4 + refino sempre | **0** |

As tabelas de constantes não foram confiadas de memória: `go test ./internal/jsmath` reconstrói
2/π e π/2 com `math/big` e confere os 66 blocos de 24 bits da redução de Payne–Hanek e os 8
blocos de π/2, bloco a bloco.

## Os cenários comparados

São três, e eles são INDEPENDENTES de propósito: cada um deriva os parâmetros da mesma seed, mas
nenhum depende do código que o outro prova. Se a agenda de power-ups quebrar, "bots:
10.000/10.000" continua significando alguma coisa.

### O cenário de partida (etapa 3)

Cada seed vira uma partida:

- **parâmetros derivados da seed** — `players = 2 + seed % 9` e uma de seis proporções de tela.
  Derivar em vez de fixar é o que faz a varredura cobrir a matriz inteira em vez de repetir
  10.000 vezes o mesmo caso;
- **labirinto** — `MakeMaze`, mais a validação de alcançabilidade e a contagem de becos;
- **spawns** — `SpawnPoints`, com o estado final do RNG conferido junto (um consumo a mais ou a
  menos aparece imediatamente);
- **power-ups** — sorteados por um RNG próprio, para que os quatro efeitos não fiquem em zero
  nas 10.000 seeds. `ricochete` importa em especial: ele **muda a trajetória** da bala;
- **300 ticks** com comandos roteirizados por um terceiro RNG semeado — cada tanque persegue o
  vizinho seguinte com erro de mira de ±0,3 rad, o que faz aparecerem morte, autogol e choque
  entre balas de verdade (tiro ao acaso quase nunca acerta e deixaria metade da simulação sem
  cobertura);
- **caminho** — seis consultas a `nextStepTowards` (BFS sobre o grafo do labirinto), porque a
  função está portada e código portado sem comparação é código não provado;
- **tudo tick a tick** — posição, ângulo, torre, cooldown e vida de cada tanque; posição,
  velocidade, rebotes e idade de cada bala; e a sequência inteira de eventos.

Tudo isso vira bytes crus (nunca texto decimal) e alimenta SHA-256 separados por seção. Separar é
o que permite dizer "o labirinto bate, o que divergiu foi a trajetória" sem abrir o dump.

### O cenário dos bots (etapa 4)

Mesma seed, mesmo labirinto e mesmos spawns do cenário de partida — o que muda é quem dirige:

- **os três níveis na mesma sala**, distribuídos por `NIVEIS[(seed + índice) % 3]`. O
  deslocamento pela seed é o que faz `dificil` aparecer também nas salas de dois jogadores ao
  longo da varredura;
- **uma semente por bot**, `(seed ^ 0x0b07b07b) + índice × 0x9e3779b9`. Sementes diferentes são
  parte do desenho, não detalhe: a FASE do escalonamento sai do RNG do bot, e é ela que impede os
  dez bots da sala de começarem a varredura de ricochete no mesmo tick;
- **alvo escolhido como o `TankRoom` escolhe** — o tanque vivo mais próximo, com o empate pelo
  primeiro da ordem de inserção — e entregue como CÓPIA da posição, porque o bot compara a posição
  do alvo de um tick para o outro para estimar a velocidade dele;
- **itens sintéticos** alimentando `mundo.powerups`, sorteados de um RNG próprio e com calendário
  de aritmética inteira. Eles NÃO saem da agenda de `powerups`, e isso é deliberado: se saíssem,
  uma divergência na agenda derrubaria as duas etapas ao mesmo tempo e os dois números deixariam
  de ser independentes;
- **o `Input` de cada bot, tick a tick**, na seção `bots`: direção de movimento, gatilho e ângulo
  de mira, em bits.

Comparar o `Input` e não o resultado é o ponto inteiro. A trajetória do tanque é consequência de
`step()`, que já está provado; o que esta etapa prova é a DECISÃO — a varredura de ricochete
fatiada, a fase do escalonamento, o memo do voo previsto, o memo do BFS, o freio de autogol e o
desvio para pegar item.

### O cenário dos power-ups (etapa 5)

600 ticks (10 s), porque o primeiro item da agenda só nasce aos 4 s e os efeitos duram de 9 a 12 s.
A rodada cobre um nascimento, a coleta dele, a expiração dos efeitos e o sumiço por tempo de um
item que ninguém pegou. O que entra no resumo:

- **a agenda inteira**, os 20 itens, mesmo os que nunca chegam a nascer;
- **o chão e o ar** de cada tick — `noChao` e `caindo`, que é a janela de antecipação do paraquedas;
- **cada coleta**, com item, tipo, dono e ponto;
- **o relógio de cada efeito ativo**, em segundos, mais os quatro campos do tanque;
- **a bala**, tick a tick, com o `ricochete` carimbado nela.

Duas decisões de roteiro que a etapa precisa para não ser vazia:

1. **o tanque anda na direção do item** quando há um no chão. Andando ao acaso ele quase nunca
   encosta num item de 15 px de raio, e coleta, arbitragem de empate e renovação de efeito
   ficariam sem cobertura nenhuma nas 10.000 seeds — a comparação diria "bateu" sobre um caminho
   que ninguém percorreu;
2. **35% de chance de cada efeito já vir ligado na largada**, pelo relógio de verdade
   (`EfeitosDePowerUp.aplicar`), e não escrevendo nos campos do tanque à mão. Sem isso não haveria
   bala carimbada antes do tick 240 e a EXPIRAÇÃO — que é a armadilha do ricochete — nunca
   aconteceria dentro da janela.

### O que os cenários NÃO exercitam

Algumas partes estão portadas mas não têm comparação rodando em cima delas, e é justo dizer isso
em voz alta:

- **`aplicarExplosoes`** — a explosão de bala é hoje puramente cosmética
  (`explosaoDeBalaELetal = false`, o mesmo do TypeScript). O código está portado dos dois lados,
  mas nenhuma das 10.000 seeds passa por ele. Se a explosão virar letal, ligue a constante nas
  duas pontas e rode a comparação de novo antes de confiar.
- **labirinto com parede removida** — a morte súbita tira paredes do slice durante a rodada, e é
  isso que invalida o cache de paredes infladas (por tamanho, nos dois lados). O cenário roda 300
  ticks com o labirinto intacto, então esse caminho de invalidação não é comparado. **Atenção:** o
  cache de paredes do BOT (`BotMemos.paredesParaBala`) copia o TypeScript à risca e NÃO invalida —
  lá é um `WeakMap` sem checagem de tamanho. Os dois lados ficam desatualizados juntos, que é o
  que preserva a paridade; "consertar" só o Go criaria uma divergência de verdade contra o
  navegador. Se a morte súbita entrar no cenário, arrume os dois lados, não um.
- **rodada nova** — `EfeitosDePowerUp.limpar()` e `CampoDePowerUps.marcarPego()` (o caminho do
  cliente, que recebe a coleta pela rede em vez de arbitrar) estão portados mas não são chamados
  pelo cenário, que roda uma rodada só e arbitra localmente.

## O que foi portado

| TypeScript | Go | Observação |
|---|---|---|
| `shared-sim/src/rng.ts` | `sim/rng.go` | mulberry32; estado em `uint32`, não em `number` |
| `shared-sim/src/maze.ts` | `sim/maze.go` | geração, braiding, `mazeShape`, BFS, spawns, validação |
| `shared-sim/src/collision.ts` | `sim/collision.go` | círculo×AABB, slab test, raycast, reflexão |
| `shared-sim/src/sim.ts` | `sim/sim.go` | `step()` inteiro, com power-ups |
| `shared-sim/src/types.ts` | `sim/types.go` | |
| `shared-sim/src/bot.ts` | `sim/bot.go` | a IA inteira: varredura de ricochete fatiada, fase do escalonamento, memos de voo e de rota, freio de autogol, desvio para item |
| `shared-sim/src/powerups.ts` | `powerups/powerups.go` | agenda, chão/ar, arbitragem da coleta, relógio dos efeitos |
| `protocol/src/constants.ts` | `protocol/constants.go` | |
| `protocol/src/messages.ts` (`direcaoDeMovimento`) | `protocol/input.go` | só essa função |
| `protocol/src/powerups.ts` | `protocol/powerups.go` | tuning, agenda em segundos e durações — **sem cores nem nomes**, que são assunto de render |

Duas escolhas de lugar valem a explicação:

- **`bot.go` mora DENTRO do pacote `sim`**, e não num pacote próprio, porque a IA chama
  `raycastSegment` e `hasLineOfSight` — que neste porte são métodos de `slabScratch`, um tipo não
  exportado (o resultado do slab test sai em campos do rascunho em vez de num objeto alocado, que
  é o que elimina o lixo de coleta do caminho mais chamado da simulação). Um pacote separado teria
  que **copiar** as noventa linhas de `collision.go`, e duas cópias da mesma física é exatamente a
  doença invisível que este porte existe para não ter. Nenhuma linha dos arquivos já provados foi
  alterada: `bot.go` é arquivo novo.
- **`powerups` é um pacote separado**, porque ele não precisa de nada privado de `sim` — e porque
  ele não é física. `step()` nunca o chama; quem chama é o host da simulação. A separação deixa
  isso explícito no grafo de dependências em vez de num comentário.

### O que **não** foi portado

- **`protocol/src/messages.ts`** fora de `direcaoDeMovimento` — o resto (`encodeAim`,
  `bitsDeMovimento`, códigos de sala) foi portado depois, em `server/`, e é conferido lá contra a
  saída do próprio TypeScript.
- **`apps/server/src/state/`** — as classes de `@colyseus/schema`. Elas não têm equivalente: o
  estado frio virou JSON. O resto de `apps/server/` está portado em `server/` e `persist/`.

### O que falta para o servidor Go existir

1. ~~**Transporte**~~ — feito: WebSocket cru em `server/`, e o cliente trocou o `@colyseus/sdk`
   por um cliente fino nosso. O porquê da troca está em [`server/README.md`](server/README.md).
2. ~~**Salas e ciclo de partida**~~ — feito: `server/sala.go`, porte de `TankRoom.ts`.
3. ~~**Bots**~~ — feito: `sim/bot.go`, provado na etapa 4.
4. ~~**Power-ups**~~ — feito: `powerups/powerups.go`, provado na etapa 5.
5. ~~**Persistência**~~ — feito: `persist/`, com `modernc.org/sqlite` (sem cgo) e o `openskill`
   portado.
6. ~~**Servir o cliente estático**~~ — feito, na mesma porta 3000.

Não falta mais nada para o servidor Go existir: ele existe, passa a bateria de navegador inteira
(46/46) e o `Dockerfile` da raiz constrói ele. **A parte determinística de `shared-sim` está
portada inteira e provada inteira** — não há mais peça de simulação esperando porte.

## Execução local: uma pedra no caminho

O **Smart App Control** do Windows 11 nesta máquina bloqueia a execução de binários
recém-compilados e sem assinatura — inclusive os que o `go test` gera em pasta temporária:

```
fork/exec ...\jsmath.test: Uma política de Controle de Aplicativo bloqueou este arquivo.
```

Por isso o alvo padrão aqui é **`js/wasm`**, que roda dentro do Node (já assinado e confiável). O
`compare.mjs` detecta sozinho: se o binário nativo rodar, usa nativo; senão, WASM.

Isso **não enfraquece a prova**. A aritmética de ponto flutuante do WebAssembly é IEEE-754
estrita e, como a do amd64, não contrai `a*b + c` em FMA. Os dois caminhos executam a mesma
sequência de arredondamentos.

Em Linux/amd64 — o alvo de produção — o caminho normal funciona:

```bash
cd go
go build ./...
go test ./...
node compare.mjs --runner nativo
```

Nesta máquina, use o embrulho que já traz o ambiente certo:

```bash
cd go
./run-go.sh build ./...
./run-go.sh test ./...
./run-go.sh vet ./...
```

### Aviso sobre arquiteturas com FMA

Em **arm64, ppc64, s390x, riscv64 e loong64** o compilador Go pode fundir `a*b + c` numa única
instrução FMA, que pula um arredondamento e **muda o resultado**. Em amd64 e wasm isso não
acontece.

Os kernels de `internal/jsmath` já se defendem: todo produto dentro de uma soma vai envolto em
`float64(...)`, que a especificação do Go define como barreira de arredondamento e proíbe a
fusão. O código de `sim/` **não** tem essa blindagem — se um dia o servidor for para arm64, rode
`node compare.mjs` lá antes de confiar. É exatamente para isso que este arranjo existe.

## Determinismo: as armadilhas que este porte teve que desviar

| Armadilha | O que foi feito |
|---|---|
| `range` sobre mapa em Go é **aleatório de propósito** | `SimState.Tanks` é slice ordenado; o mapa é só índice de busca. `TestOrdemDeTanquesEEstavel` roda a mesma partida 20 vezes e exige resultado idêntico |
| `Math.round(-0.5)` é `-0` no JS e `-1` no Go | `jsmath.Round` segue a ECMA-262, inclusive o caso `Math.round(0.49999999999999994) === 0` |
| `0.12 * 84` como constante untyped é avaliado em precisão arbitrária | as constantes derivadas são `var` calculadas em float64, com a mesma conta do JavaScript |
| `>>>` não existe em Go | o RNG opera em `uint32` do início ao fim |
| estado de módulo (pools de reuso do TS) | virou campo do `SimState`, o que de quebra deixa a simulação segura para rodar em paralelo — a varredura de 10.000 seeds usa isso |
| `a.id < b.id` compara UTF-16 no JS e bytes UTF-8 no Go | coincide enquanto os IDs forem ASCII; o cenário usa `t00`..`t09` e o comentário em `resolveTankOverlaps` registra a condição |
| **`passo === alvo`**: o bot memoriza o BFS e distingue "achei rota" de "não há rota, vá direto" por comparação de **identidade**, que Go não tem | `passoOuAlvo` sonda `NextStepTowards` com um SEGUNDO ponto da mesma célula. Comparar por valor daria a resposta errada justamente no caso mais comum — alvo no centro da célula vizinha, que é onde todo power-up e todo spawn nascem — e o erro só apareceria ticks depois, quando aquela entrada do cache fosse reusada para outro alvo |
| memos de módulo do `bot.ts` (`WeakMap` de voo previsto, de rota e de paredes infladas) | viraram `BotMemos`, criado uma vez por partida. O valor guardado é idêntico ao recalculado, então compartilhar entre os bots da sala não acopla ninguém — e tirar do escopo de pacote é o que permite rodar 10.000 partidas em goroutines paralelas |
| `porTanque` do `EfeitosDePowerUp` é um `Map` percorrido na ordem de INSERÇÃO | virou slice ordenado + mapa de busca; a remoção é adiada para o fim do laço, que é a tradução exata de apagar uma chave durante o `for...of` de um `Map` |

## Mapa dos arquivos

```
go/
├── compare.mjs              o comando: roda as três etapas e relata
├── run-go.sh                embrulho do toolchain nesta máquina (WASM + ambiente enxuto)
├── go.mod
├── internal/jsmath/         réplica bit a bit do Math do V8 (fdlibm)
│   ├── jsmath.go            Round (ECMA-262), Hypot (V8), Sign, Min/Max, bits
│   ├── trig.go              Sin, Cos, kernels e redução de argumento
│   ├── rempio2.go           Payne–Hanek com a expansão de 2/π em 66 blocos
│   ├── log.go               Log
│   ├── atan.go              Atan, Atan2
│   └── jsmath_test.go       valida as tabelas contra math/big
├── protocol/                espelho verificado do tuning
│   ├── constants.go
│   ├── powerups.go          só o que a simulação lê
│   └── input.go             direcaoDeMovimento
├── sim/                     o porte de shared-sim
│   ├── rng.go  types.go  collision.go  maze.go  sim.go
│   ├── bot.go               a IA — mora aqui porque usa o raycast não exportado
│   ├── sim_test.go          determinismo, balística, imunidade, ordem estável
│   └── bot_test.go          determinismo do bot, RNG por decisão, autogol, desvio para item
├── powerups/                a camada de itens — agenda, coleta, relógio dos efeitos
│   ├── powerups.go
│   └── powerups_test.go     espelho de `powerups.test.ts`, inclusive A ARMADILHA do carimbo
├── paridade/                cenários e serialização canônica
│   ├── canon.go             resumo SHA-256 e dump legível, seis seções
│   ├── cenario.go           a partida roteirizada (etapa 3)
│   ├── cenario_bots.go      a partida dirigida pela IA (etapa 4)
│   ├── cenario_powerups.go  a rodada com itens (etapa 5)
│   └── constantes.go        dump da tabela de tuning
├── server/                  O SERVIDOR: transporte, salas, ciclo de partida (README próprio)
│   ├── servidor.go          HTTP, WebSocket, estáticos, /salas, /healthz
│   ├── hub.go               cadastro de salas, código de 4 letras, vitrine
│   ├── sala.go              porte de TankRoom.ts — fases, rodada, eventos, snapshot
│   ├── sala_jogadores.go    vagas, cores, dono, espectadores, queda × saída
│   ├── sala_mensagens.go    os canais que o cliente fala
│   ├── conexao.go           uma conexão WebSocket, com fila de saída própria
│   ├── codec.go  rodada.go  gameplay.go  protocolo.go
│   └── testdata/            vetores GERADOS pelo TypeScript (ver apps/server/ref/)
├── persist/                 SQLite sem cgo (modernc) e o openskill portado
├── cmd/servidor/            o binário do servidor
├── cmd/paridade/            CLI do lado Go (-modo, -cenario)
├── cmd/mathprobe/           sonda das funções matemáticas
├── ts/                      o espelho, do lado TypeScript
│   ├── paridade.mjs  canon.mjs  mathprobe.mjs  mathdiff.mjs
└── out/                     saídas da última comparação (ignorado pelo git)
```

## Sincronia com o TypeScript

O lado TypeScript continua sendo a **fonte da verdade**. Este porte não alterou nada lá.

Quando `shared-sim` ou `constants.ts` mudarem, o porte precisa acompanhar — e `node
compare.mjs` é o detector: uma constante reajustada de um lado só cai na etapa 1, uma regra da
simulação cai na etapa 3, uma decisão de IA cai na etapa 4 e a agenda ou o relógio de um efeito
caem na etapa 5, sempre com a seed e o tick na mão.

Este porte acompanha o `shared-sim` inteiro na parte determinística: os quatro power-ups
(`ricochete`, `municao`, `recarga`, `turbo`), a chegada de paraquedas (`caindo`, que é
antecipação e não atraso — a disponibilidade do item não muda um tick) e as três receitas de
`BOT_DIFFICULTY`, que entram no dump de constantes justamente para que um `ticksDeReacao`
reajustado de um lado só não vire uma divergência de input no meio da partida sem dizer por quê.
