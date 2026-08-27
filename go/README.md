# `go/` — a simulação do Tank Ricochete portada para Go, com paridade provada

Este diretório é a **fundação** do futuro servidor Go. Ele ainda **não é o servidor**: é a
simulação (`packages/shared-sim`) reescrita em Go e, principalmente, o arranjo que prova que as
duas implementações produzem **exatamente o mesmo resultado, bit a bit**.

## Por que a prova é o entregável, e não o código

A bala não trafega pela rede. O servidor emite `bullet_spawn` (id, dono, posição, `vx`/`vy`,
tick) e **cada cliente simula a trajetória sozinho** com o mesmo código. É isso que torna o jogo
imune a jitter — e é isso que transforma qualquer diferença de um bit numa doença invisível: o
ricochete acontece num lugar na tela de um jogador e noutro na do adversário, e ninguém consegue
depurar.

Portar 1.200 linhas de TypeScript para Go é meio dia de trabalho. Provar que o porte não moveu
nenhum bit é o resto.

## O comando

```bash
node go/compare.mjs                                  # 10.000 seeds, 300 ticks cada
node go/compare.mjs --seeds 200 --ticks 600          # varredura menor, partidas mais longas
node go/compare.mjs --de 50000 --seeds 1000          # outra faixa de seeds
node go/compare.mjs --runner nativo                  # força o Go nativo (ver "execução local")
```

Ele compila o lado Go, roda as duas implementações e compara. Sai com código 0 só se **tudo**
bater. Não há tolerância, não há arredondamento, não há "perto o bastante".

### O que ele faz, em três etapas

| # | Etapa | O que compara |
|---|---|---|
| 1 | **constantes** | as 65 entradas da tabela de tuning (inclusive as 16 saídas de `direcaoDeMovimento`), em padrão de bits. Uma constante derivada calculada com regras de arredondamento diferentes faria tudo divergir sem dizer por quê |
| 2 | **math** | `sin`, `cos`, `log`, `atan`, `atan2`, `hypot` e `round` do V8 contra `internal/jsmath`, em 380.495 casos |
| 3 | **paridade** | N seeds × 300 ticks de partida completa, resumidas em quatro SHA-256: labirinto, spawns, simulação e eventos |

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
      dumps completos: go/out/detalhe_go_0.txt
                       go/out/detalhe_ts_0.txt
```

(saída real, de uma divergência injetada de propósito — ver adiante).

Para investigar uma seed sozinho, sem a varredura:

```bash
node go/ts/paridade.mjs --modo detalhe --seed 4173 > /tmp/ts.txt
cd go && ./run-go.sh build -o bin/p.wasm ./cmd/paridade   # ou `go build` em Linux
node "$(go env GOROOT)/lib/wasm/wasm_exec_node.js" bin/p.wasm -modo detalhe -seed 4173 > /tmp/go.txt
diff /tmp/go.txt /tmp/ts.txt
```

## Resultado atual

```
[1/3] constantes de tuning
      OK — 65 constantes idênticas bit a bit

[2/3] Math.* do V8 contra internal/jsmath
      sin    OK   380495/380495 idênticos bit a bit
      cos    OK   380495/380495 idênticos bit a bit
      log    OK   380495/380495 idênticos bit a bit
      atan   OK   380495/380495 idênticos bit a bit
      atan2  OK   380495/380495 idênticos bit a bit
      hypot  OK   380495/380495 idênticos bit a bit
      round  OK   380495/380495 idênticos bit a bit

[3/3] simulação completa em 10000 seeds
      go: 197.7s   ts: 160.5s
      10000/10000 seeds idênticas bit a bit

PARIDADE COMPLETA — 363.3s
```

**10.000 de 10.000.** As 10.000 seeds cobrem salas de 2 a 10 jogadores, seis proporções de tela
(inclusive duas fora da faixa permitida, para exercitar o grampeamento), power-ups sorteados nos
quatro efeitos e 3 milhões de ticks de partida com tiro, ricochete, morte, autogol, choque entre
balas e bala morrendo de velhice.

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

## O cenário comparado

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

Tudo isso vira bytes crus (nunca texto decimal) e alimenta quatro SHA-256 separados. Separar por
seção é o que permite dizer "o labirinto bate, o que divergiu foi a trajetória" sem abrir o dump.

### O que o cenário NÃO exercita

Duas partes estão portadas mas não têm comparação rodando em cima delas, e é justo dizer isso em
voz alta:

- **`aplicarExplosoes`** — a explosão de bala é hoje puramente cosmética
  (`explosaoDeBalaELetal = false`, o mesmo do TypeScript). O código está portado dos dois lados,
  mas nenhuma das 10.000 seeds passa por ele. Se a explosão virar letal, ligue a constante nas
  duas pontas e rode a comparação de novo antes de confiar.
- **labirinto com parede removida** — a morte súbita tira paredes do slice durante a rodada, e é
  isso que invalida o cache de paredes infladas (por tamanho, nos dois lados). O cenário roda 300
  ticks com o labirinto intacto, então esse caminho de invalidação não é comparado.

## O que foi portado

| TypeScript | Go | Observação |
|---|---|---|
| `shared-sim/src/rng.ts` | `sim/rng.go` | mulberry32; estado em `uint32`, não em `number` |
| `shared-sim/src/maze.ts` | `sim/maze.go` | geração, braiding, `mazeShape`, BFS, spawns, validação |
| `shared-sim/src/collision.ts` | `sim/collision.go` | círculo×AABB, slab test, raycast, reflexão |
| `shared-sim/src/sim.ts` | `sim/sim.go` | `step()` inteiro, com power-ups |
| `shared-sim/src/types.ts` | `sim/types.go` | |
| `protocol/src/constants.ts` | `protocol/constants.go` | |
| `protocol/src/messages.ts` (`direcaoDeMovimento`) | `protocol/input.go` | só essa função |
| `protocol/src/powerups.ts` | `protocol/powerups.go` | **só o que a simulação lê** |

### O que **não** foi portado

- **`shared-sim/src/bot.ts`** — a IA dos bots. Ela roda **só no servidor** (o cliente nunca
  simula um bot), então uma divergência ali não quebra a previsão de bala. Vai precisar do porte
  quando o servidor Go existir, e vai poder entrar neste mesmo arranjo: `hasLineOfSight` e
  `NextStepTowards`, de que ela depende, já estão portados e cobertos.
- **`shared-sim/src/powerups.ts`** — a agenda de nascimento, coleta e expiração dos itens. A
  simulação só **lê** os quatro campos do tanque; quem os liga e desliga é essa camada, que é
  assunto de servidor.
- **`protocol/src/messages.ts`** fora de `direcaoDeMovimento` — tipos de mensagem,
  `encodeAim`/`decodeAim`, `bitsDeMovimento`, códigos de sala.
- **`apps/server/` inteiro** — Colyseus/Schema, salas, persistência SQLite, HTTP estático.

### O que falta para o servidor Go existir

1. **Transporte.** O cliente fala Colyseus 0.17 (`@colyseus/sdk`). Não existe servidor Colyseus
   em Go, então a decisão é entre (a) reimplementar o protocolo `@colyseus/schema` em Go, que é
   um formato binário com delta e versionamento de campo, ou (b) trocar o transporte por
   WebSocket cru e ajustar o cliente. **(b) é o caminho honesto**: o Schema hoje carrega só o
   estado frio (jogadores, placar, fase da rodada) — o estado quente já vai por mensagem própria.
2. **Salas e ciclo de partida** — lobby, código de 4 letras, contagem regressiva, 10 rodadas,
   morte súbita, placar.
3. **Bots** — porte de `bot.ts`, que só faz sentido depois de 1 e 2.
4. **Power-ups** — porte de `shared-sim/src/powerups.ts` (agenda e efeitos).
5. **Persistência** — hoje `better-sqlite3`; em Go seria `modernc.org/sqlite` (sem cgo, para o
   Dockerfile continuar de um estágio só).
6. **Servir o cliente estático** na mesma porta 3000, que o Dockerfile já assume.

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
│   └── sim_test.go          determinismo, balística, imunidade, ordem estável
├── paridade/                cenário e serialização canônica
│   ├── canon.go             resumo SHA-256 e dump legível
│   ├── cenario.go           a partida roteirizada
│   └── constantes.go        dump da tabela de tuning
├── cmd/paridade/            CLI do lado Go
├── cmd/mathprobe/           sonda das funções matemáticas
├── ts/                      o espelho, do lado TypeScript
│   ├── paridade.mjs  canon.mjs  mathprobe.mjs  mathdiff.mjs
└── out/                     saídas da última comparação (ignorado pelo git)
```

## Sincronia com o TypeScript

O lado TypeScript continua sendo a **fonte da verdade**. Este porte não alterou nada lá.

Quando `shared-sim` ou `constants.ts` mudarem, o porte precisa acompanhar — e `node
compare.mjs` é o detector: uma constante reajustada de um lado só cai na etapa 1, e uma regra
mudada cai na etapa 3, com a seed e o tick na mão.

Este porte acompanha o `shared-sim` **incluindo os quatro power-ups** (`ricochete`, `municao`,
`recarga`, `turbo`), que entraram no TypeScript durante o trabalho e estão portados e cobertos
pela varredura.
