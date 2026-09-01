# R4 — Design de jogo, diversão e retenção

## Resumo

O laço de sessão já está bem construído — rodadas curtas, câmera que mostra a arena inteira (então
morrer cedo não significa ficar cego), morte súbita contra travamento, revanche que mantém a sala
viva e um sistema de rating já calculado e nunca exibido. As lacunas reais são três: não existe
nenhuma mecânica de virada entre rodadas, os bots "fáceis" do treino ainda atiram para matar (o
dono pediu um modo calmo e ele não existe), e um texto de risco de power-up já escrito no código
nunca chega à tela. É nisso que este relatório foca — não em reformar o que já funciona.

## Recomendações priorizadas

| # | Recomendação | Impacto esperado | Custo de implementação | Risco |
|---|---|---|---|---|
| 1 | Vantagem entre rodadas (mecânica de virada, estilo Rounds adaptado a 10 jogadores) | Alto — ataca direto o "de novo!" | Médio-alto (protocolo + servidor + UI) | Médio (pacing, se mal calibrado) |
| 2 | Bots pacíficos no modo treino | Alto para quem pediu — desbloqueia testar power-up sem pressão | Médio (TS + Go, dois portes) | Baixo (só aditivo) |
| 3 | Placar de vitórias da sala entre revanches | Médio-alto — alavanca uma feature que já existe (revanche) | Baixo | Baixo |
| 4 | Mostrar o risco de cada power-up na primeira coleta | Médio — reduz a "pegadinha" de descobrir o preço na marra | Baixo (o texto já existe, só falta aparecer) | Baixo |
| 5 | Expor o rating OpenSkill que já é calculado e salvo, com tom leve | Médio, potencial alto se bem calibrado | Baixo (o backend já funciona e tem teste) | Médio (pode pesar o clima casual se exposto como MMR cru) |

---

## 1. Vantagem entre rodadas — mecânica de virada

### Por quê

Hoje a única coisa que empurra uma rodada travada para frente é a morte súbita (remove parede
depois do timeout, `go/server/sala.go:395-420`, `go/server/rodada.go:141-150`) e a pontuação em
`RoundScore` (`go/server/rodada.go:53-59`), que só registra posição de sobrevivência + abates −
autogols. Não existe nada que dê a quem está atrás uma chance concreta de virar — se alguém cai
para o fundo do placar na rodada 3, as sete rodadas seguintes são cumprir tabela.

A pesquisa confirma que isso é exatamente o motor de "jogar de novo" em ROUNDS: "Only the losing
player gets to choose a card"; o jogo mostra normalmente 3–5 cartas, e a escolha "stay with you for
the entire match" — comeback sempre possível [Rounds Network](https://rounds.network/rounds-fundamentals-core-mechanics-explained/).
Ultimate Chicken Horse faz algo parecido, mas automático: pontos de bônus para quem está "underdog"
(perdeu 2 rodadas seguidas) [Xbox Achievements](https://www.xboxachievements.com/game/ultimate-chicken-horse/achievement/144444-Comeback-Kid.html).
E a pesquisa acadêmica mais recente sobre o assunto (CHI 2024) reforça um ponto que vale a pena
levar a sério: mecânicas de equilíbrio são percebidas como mais justas quando dão uma
**oportunidade** a quem está atrás — não uma vitória garantida — e quando são **transparentes**
sobre como funcionam [CHI 2024 — The Trick is to Stay Behind?](https://doi.org/10.1145/3613904.3642441).

Duas coisas do ROUNDS **não** dá para copiar direto:

1. **É 1v1.** "Only the losing player" funciona porque só há um perdedor por rodada. Com até 10
   tanques, um sorteio sequencial ("o último escolhe, depois o penúltimo...") empilharia dezenas de
   segundos de espera — e o motivo pelo qual jogos de festa curtos funcionam é exatamente o oposto:
   "rounds last seconds, keeping the energy high and the salt levels low" (sobre Stick Fight)
   [couchcoopfavorites.com](https://couchcoopfavorites.com/stick-fight-the-game); partidas de
   "about five seconds" continuam sendo o ponto alto do gênero
   [saveorquit.com](https://saveorquit.com/2018/02/05/review-stick-fight-the-game/); em formatos de
   alta energia, "the next opportunity arrives soon" é o que evita o desgaste
   [playbattlesquare.com](https://playbattlesquare.com/editors-picks/how-short-high-energy-matches-keep-players-coming-back-for-more/).
2. **As cartas de ROUNDS são permanentes e empilham para o resto da partida.** Isso contraria uma
   regra que este projeto já decidiu, com justificativa escrita no código: pegar o mesmo power-up
   de novo **renova o relógio, nunca empilha**, porque "empilhar somaria dois ricochetes e a bala
   passaria a quicar três vezes — a arena vira pinball e o teto do efeito, que é parte do
   equilíbrio, deixa de existir" (`packages/shared-sim/src/powerups.ts:296-309`). Uma mecânica de
   virada que deixasse vantagens se acumularem entre as 10 rodadas reabriria exatamente esse
   problema — só que agora para quem está perdendo, criando o efeito oposto ao pretendido (quem
   vira a mesa uma vez fica intocável dali para frente).

### O desenho concreto

**Não é uma carta nova.** É acesso GARANTIDO a um dos 4 power-ups que já existem
(`packages/protocol/src/powerups.ts:39-78`) para a rodada seguinte, com a mesma duração e o mesmo
risco de sempre — ricochete duplo continua dobrando a chance de autogol, turbo continua podendo
atropelar a própria bala. Isso resolve o empilhamento de graça: é o MESMO efeito, com o MESMO teto,
só que **oferecido** em vez de **sorteado no chão**. Nenhuma arte nova: cada tipo já tem símbolo
próprio ("o zigue-zague do ricochete" — `apps/client/src/render/powerups.ts:11-13`).

**Quem recebe oferta, e quantas opções**, sai do ranking que `endRound()` acabou de calcular
(`go/server/sala.go:555-568`) — nenhuma segunda passada pelos jogadores:

- **Terço de baixo da sala** (por placar acumulado, não só da rodada): 3 das 4 opções.
- **Terço do meio**: 1 opção — pegar ou deixar, sem vitrine.
- **Terço de cima**: nenhuma oferta. Quem está ganhando não precisa, e isso já derruba pela metade
  quantas pessoas precisam decidir algo — é o que mantém o tempo curto com sala cheia.

**A escolha é simultânea e privada**, não em turnos — cada jogador só vê e decide a própria oferta,
como mão escondida. Ninguém espera a vez de ninguém. Um prazo curto e compartilhado resolve tudo de
uma vez; quem não responde a tempo não leva nada (bots respondem na hora, seguindo a própria
`BotConfig` — um bot difícil sempre pega ricochete).

**Orçamento de tempo**: o painel de fim de rodada já dura 3 s
(`go/server/sala.go:41` — `duracaoDoFimDeRodada = 3.0`; espelhado no cliente em
`apps/client/src/main.ts:342,549`) e já gasta os primeiros ~2,3 s animando o placar subindo
(`ESPERA = 900` + `DURACAO = 1400`, `apps/client/src/ui/roundend.ts:155-156`). A oferta de vantagem
entra no mesmo painel, aparecendo quando a contagem termina — o tempo extra percebido fica perto de
zero, não dos 3 s completos que a janela precisaria ganhar. Proponho estender
`duracaoDoFimDeRodada` só nas rodadas em que alguém recebe oferta (nunca na última rodada, que não
tem "próxima" para preparar).

### O que muda

`packages/protocol/src/messages.ts` (perto de `RoundEndMsg`, linha 315):

```ts
export interface VantagemOfertaMsg {
  /** Tipos que ESTE jogador pode escolher — vazio quando ninguém oferece nada a ele. */
  opcoes: TipoPowerUp[];
  /** Prazo em segundos para escolher; passou disso, não leva nada. */
  prazo: number;
}

export interface VantagemEscolhidaMsg {
  tipo: TipoPowerUp;
}
```

`go/server/rodada.go` (nova função, ao lado de `RoundScore`):

```go
// OfertaDeVantagem devolve as opções de UM jogador para a rodada seguinte, a partir do ranking que
// endRound() ACABOU de montar. Terço de baixo por placar acumulado vê as 4; terço do meio vê 1;
// terço de cima não vê nada — é a metade (ou menos) da sala que precisa decidir algo.
func OfertaDeVantagem(porScore []EntradaDeRanking, playerID string) []string {
	total := len(porScore)
	if total == 0 {
		return nil
	}
	idx := -1
	for i, r := range porScore {
		if r.PlayerID == playerID {
			idx = i // porScore já vem ORDENADO do pior placar para o melhor
			break
		}
	}
	if idx < 0 {
		return nil
	}
	terco := total / 3
	switch {
	case idx < terco || terco == 0:
		return protocol.TiposDePowerUp[:]
	case idx < 2*terco:
		return protocol.TiposDePowerUp[:1]
	default:
		return nil
	}
}
```

`go/server/sala.go`, dentro de `endRound()` (depois de montar `ranking`, linha ~568): computar a
oferta de cada humano, transmitir `VantagemOfertaMsg` individualmente por sessão, e só então definir
`s.timeLeft` — se alguma oferta não-vazia saiu e `s.round < s.totalRodadas`, usar
`duracaoDoFimDeRodada + JANELA_VANTAGEM` (proponho `JANELA_VANTAGEM = 3.0`); senão, o valor de hoje.

`apps/client/src/ui/roundend.ts`: adicionar um bloco opcional `oferta?: { opcoes: TipoPowerUp[]; prazoS: number }`
a `RoundendState`, desenhado dentro do mesmo `.painel-rodada` já existente, reaproveitando o símbolo
de cada tipo. Ao clicar, enviar `VantagemEscolhidaMsg`; sem clique dentro do prazo, nada é enviado
(o servidor já decidiu que "sem resposta = sem bônus").

### Risco

Se o terço de baixo vencer a rodada seguinte com frequência demais, o placar vira gangorra e passa a
impressão de sorte em vez de mérito — o próprio ponto que o estudo do CHI levanta sobre transparência
e percepção de justiça. Meça antes de generalizar para 10 rodadas: rode a mesma sala de bots (fácil
vs. difícil) com e sem a oferta e compare quantas vezes o terço de baixo vira campeão. Comece só com
o terço de baixo recebendo oferta (sem o terço do meio) — é a versão mínima que já resolve o "sem
chance nenhuma de virar" sem dobrar a superfície de decisão logo de cara.

---

## 2. Modo de treino sem bots hostis

### Por quê

O dono pediu explicitamente um jeito de testar power-up com calma. Hoje isso não existe: mesmo o bot
"fácil" persegue e atira — a única coisa que muda entre dificuldades é a precisão e o reflexo, nunca
a intenção de matar (`packages/shared-sim/src/bot.ts:70-98`, espelhado em
`go/sim/bot.go:51-79`). O comentário do próprio arquivo já documenta a régua: "o que separa os
níveis agora é o CORPO" (mira, reação, horizonte de ameaça), não se o bot atira ou não.

### O desenho concreto

Um quarto nível, `pacifico`, que reaproveita o MESMO caminho de sempre — `TREINAR CONTRA BOTS`
(`apps/client/src/ui/lobby.ts:157-167`, que já existe e já roda a partida inteira localmente, sem
servidor: `packages/shared-sim` como está, sem um segundo jogo). O bot continua navegando o
labirinto e pegando power-up (para o item ainda fazer sentido de testar), só nunca aperta o gatilho.

`packages/shared-sim/src/bot.ts:70-98` — novo campo e nova receita:

```ts
export interface BotConfig {
  // ...campos existentes...
  /** Nunca atira. Continua andando, desviando e pegando power-up — só não puxa o gatilho. */
  pacifico: boolean;
}

export const BOT_DIFFICULTY: Record<'pacifico' | 'facil' | 'medio' | 'dificil', BotConfig> = {
  pacifico: {
    aimErrorRad: 0.55,
    turnThreshold: 0.3,
    ticksDeReacao: 12,
    horizonteDeAmeaca: 0,
    ricocheteia: false,
    evitaAutogol: false,
    usaParede: false,
    pacifico: true,
  },
  facil: { /* ...como está, + pacifico: false... */ },
  // ...
};
```

E, no ponto em que o tiro é decidido (mesmo arquivo, na montagem do `Input` final):

```ts
fire: temTiro && torreAlinhada && !config.pacifico,
```

Espelho em Go, `go/sim/bot.go:23-42` (novo campo `Pacifico bool` em `BotConfig`) e linha 805:

```go
Fire: temTiro && torreAlinhada && !config.Pacifico,
```

Mais a entrada `"pacifico"` em `BotDificuldade` (`go/sim/bot.go:51`) e em `NiveisDeBot`
(linha 46). Como bots pacíficos nunca disparam, a prova de paridade bit-a-bit entre TS e Go
(mencionada no `CLAUDE.md` do repositório) só precisa rodar um novo lote de seeds com este nível —
não deveria quebrar as 10.000 seeds já provadas, porque nenhum código de tiro/ricochete muda, só o
gate que impede o `Fire`.

`apps/client/src/ui/lobby.ts`: acrescentar `pacifico` a `OPCOES_DIFICULDADE` (linha 69-73), com
rótulo tipo "CALMO" — reaproveita o seletor que já existe para a dificuldade dos bots da sala, não
cria um controle novo.

### Risco

Baixo — é puramente aditivo, não toca em nenhuma regra usada nas partidas normais. O único cuidado é
de nomenclatura: "pacifico" não deve aparecer como opção na dificuldade de bots de uma sala PÚBLICA
(`souDono` em `lobby.ts:35-41` já existe para restringir quem vê o seletor) — bot que não atira numa
sala de verdade tiraria a graça de quem quer jogar de verdade contra a máquina. Vale restringir a
opção ao fluxo de `TREINAR CONTRA BOTS`, que já é offline e sozinho.

---

## 3. Placar de vitórias da sala entre revanches

### Por quê

A revanche já é o feature certo: "JOGAR DE NOVO" hoje é revanche de verdade — a sala continua viva,
com o mesmo código, e só o que é da partida é zerado (`go/server/sala.go:623-652`,
`apps/client/src/main.ts:1282-1287`). Isso é exatamente o oposto do que os 12 anos de sabedoria de
"one more round" pedem — nenhuma fricção para a próxima partida. O problema é que cada revanche
apaga toda a memória da anterior: `p.Score = 0` (`go/server/sala.go:631`) e não sobra nenhum rastro
de "quem ganhou mais vezes hoje" — que é justamente o tipo de placar de grupo que dá o gancho social
que o pessoal do escritório comenta no corredor.

### O desenho concreto

Um contador que sobrevive à revanche (mas não à saída da sala) — `Jogador.VitoriasNaSala`
(`go/server/sala.go:49-62`):

```go
type Jogador struct {
	// ...campos existentes...
	VitoriasNaSala int `json:"vitoriasNaSala"`
}
```

Incrementar em `finishMatch()` (`go/server/sala.go:578` em diante) para quem fechar a partida em 1º
lugar no ranking final. **Não** incluir `VitoriasNaSala` no laço de reset de `reiniciarParaLobby()`
(`go/server/sala.go:629-637`) — é a única linha que precisa ficar de fora do "zera tudo que é da
partida".

Exibição: uma pequena marca (🏆×N) ao lado do nome em `apps/client/src/ui/lobby.ts` (na grade de
vagas, `desenharVagas`, linha 689-709) e em `apps/client/src/ui/result.ts` (linha do ranking,
139-173) — dado que já chega pelo mesmo `players`/`ranking` que essas telas já leem.

### Risco

Baixo. É um número que só existe em memória, some quando a sala fecha, não depende de conta nem
de dispositivo — continua 100% dentro da filosofia "sem conta" do jogo. O único cuidado é de tom: não
transformar isso num placar competitivo de verdade (sem ranking global, sem "melhor deste mês") —
é só o placar da mesa, do dia.

---

## 4. Mostrar o risco de cada power-up na primeira coleta

### Por quê

Cada power-up já tem um texto de risco escrito e pronto —
`packages/protocol/src/powerups.ts:39-78`, campo `risco` ("a bala quica 2× em vez de 1 — mata mais
e se mata mais", "+35% de velocidade — chega antes, inclusive na frente da própria bala" etc.). Ele
nunca aparece em lugar nenhum do cliente: `apps/client/src/ui/hud.ts:369-395` só desenha `def.curto`
(o rótulo, tipo "RICOCHETE") e a barra de tempo — o texto do `risco` não é lido em canto nenhum do
código do cliente. Um jogador de primeira viagem pega "TURBO" no meio de um tiroteio sem saber que
ele pode acabar de atropelar a própria bala. Isso é atrito de entendimento, não de regra: o jogo já
escreveu a explicação, só não entrega.

Isso é "juice" no sentido certo para 2026: feedback que aumenta a compreensão sem custar quadro —
texto estático não pesa no orçamento de frame, ao contrário de partícula ou pós-processamento
["Squeezing more juice out of your game design"](https://www.gamedeveloper.com/design/squeezing-more-juice-out-of-your-game-design-);
juice de verdade "prioriza a satisfação do jogador com feedback imediato" — e feedback imediato
inclui entender o que acabou de acontecer, não só sentir
[thedesignlab.blog, 2025](https://thedesignlab.blog/2025/01/06/making-gameplay-irresistibly-satisfying-using-game-juice/).

### O desenho concreto

Um toast curto (1,5–2 s, mesma linguagem visual dos `destaques` de `roundend.ts`/`result.ts`) na
PRIMEIRA vez que aquele tipo de power-up é coletado, por sessão de navegador — guardado em
`localStorage` do mesmo jeito que `tank:nome` e `tank:cor` já são (`apps/client/src/main.ts:122-135`),
com uma chave nova tipo `tank:powerups-vistos`. Da segunda coleta em diante, silêncio — o jogador já
sabe.

`apps/client/src/ui/hud.ts`, em `desenharEfeitos` (linha 369): ao entrar um tipo que ainda não está
no set de "vistos", emitir o toast com `def.risco` (o texto já existe, é só ler o campo que hoje
ninguém lê).

### Risco

Muito baixo. Não altera nenhuma regra, nenhum número de jogo — é só texto que já foi escrito.

---

## 5. Expor o rating OpenSkill que já é calculado e salvo

### Por quê

Esta é a descoberta que mais vale a pena registrar: o servidor já roda um sistema completo de
rating por dispositivo — modelo Plackett–Luce (OpenSkill), com `mu`/`sigma` por `device_id`,
persistido em SQLite e **testado** (`go/persist/rating.go`, `go/persist/db.go:78-85` — tabela
`ratings` — e `go/persist/rating_test.go`, com dado de referência gerado pelo próprio `openskill.js`
original). Ele é atualizado a cada fim de partida (`go/cmd/servidor/gravador.go:101`,
`AtualizarRatings`) — mas **nenhuma rota HTTP nem mensagem de WebSocket jamais lê esse dado de
volta**. As únicas rotas que o servidor expõe são `/ws`, `/healthz`, a lista de salas abertas e os
arquivos estáticos (`go/server/servidor.go:40-50`). O rating existe, funciona, é gravado — e é
completamente invisível para quem joga.

Isso já resolve, de graça, a pergunta "apelido persistente" de um jeito mais profundo do que nome +
cor: o `device_id` já é a mesma identidade sem conta que o jogo usa para nome/cor/reconexão
(`getDeviceId()`, `apps/client/src/net/client.ts:77-84`, guardado em `localStorage`). Não seria
preciso inventar identidade nova — só ler o que já está guardado sob a mesma chave.

### O desenho concreto

Backend: nenhuma mudança de cálculo — só uma leitura. Ao entrar na sala (mensagem `entrou` /
`EntrouMsg`, `packages/protocol/src/messages.ts:390`), o servidor consulta
`banco.Rating(deviceID)` (já existe, `go/persist/db.go:154-163`) e inclui `partidas` (não `mu`/
`sigma` crus) na resposta.

Cliente: um selo discreto perto do nome no lobby — não um número de "força", que puxa o clima para
competitivo demais para uma sala de escritório. Proponho **faixas por partidas jogadas** em vez de
expor o `mu` bruto: "estreando" (0), sem selo (1–9), "veterano" (10+). O `sigma` (incerteza do
rating) já resolve sozinho o problema de "novato aparenta fraco" — só não precisa aparecer como
número, só como ausência de selo.

### Risco

O maior risco aqui não é técnico — é de tom. Mostrar um número de habilidade cru (tipo "1204 MMR")
para uma sala pensada como "o pessoal do escritório jogando junto" pode empurrar o clima para
ranqueado e afastar quem só quer rir do próprio autogol. Por isso a recomendação concreta é **não**
mostrar `mu`/`sigma`, só contagem de partidas — é bragging right ("já jogo aqui há um tempo"), não
placar de habilidade. Se o produto quiser ir mais longe (matchmaking por força, por exemplo), o
rating já está pronto para isso — mas essa é uma decisão de produto separada desta, e maior.

---

## O que investiguei e descartei

**Draft sequencial de cartas (cópia literal de ROUNDS).** Descartado — ROUNDS é 1v1
[Rounds Network](https://rounds.network/rounds-fundamentals-core-mechanics-explained/) e um turno
por jogador não escala para 10 pessoas sem empurrar a duração da tela de fim de rodada para dezenas
de segundos, o oposto do que faz jogos de festa curtos funcionarem
[couchcoopfavorites.com](https://couchcoopfavorites.com/stick-fight-the-game). Resolvido com escolha
simultânea e privada em vez de turnos (recomendação 1).

**Vantagens permanentes/empilháveis para o resto da partida.** Descartado — contraria uma decisão de
balanceamento já tomada e documentada em código
(`packages/shared-sim/src/powerups.ts:296-309`: "empilhar... a arena vira pinball e o teto do
efeito... deixa de existir"). Resolvido reaproveitando o mesmo catálogo de power-up com a mesma
duração de sempre, só com acesso garantido em vez de sorteado (recomendação 1).

**Escudo, ou qualquer vantagem que remova o risco de autogol.** Descartado — o próprio código já
rejeitou isso de propósito: "Escudo ficou de fora... o risco que ele removeria é justamente o
autogol — a alma do jogo" (`packages/protocol/src/powerups.ts:14-16`). Qualquer vantagem nova, de
virada ou não, precisa continuar cobrando alguma coisa; nenhuma das quatro sugeridas na
recomendação 1 quebra essa regra.

**Câmera de espectador / "modo assistir" para quem morreu cedo numa rodada de 45 s.** Investigado a
fundo, porque à primeira vista parece um problema real (rodada pode durar até 45 s e alguém pode
morrer nos primeiros segundos). Mas não é: a câmera do jogo **não segue o próprio tanque** — ela
enquadra o labirinto inteiro o tempo todo (`fitCamera()`, `apps/client/src/render/Renderer.ts:1324`,
chamado uma vez por rodada). Quem morre continua vendo a arena inteira ao vivo, do mesmo jeito que
via enquanto estava vivo — só sem controle. Some a isso que a rodada **termina assim que resta 1 vivo**
(`aliveCount <= 1`, `apps/client/src/main.ts:643`), não quando o relógio zera — então o pior caso
de espera parada é bem menor do que os 45 s do teto. Não há nada para consertar aqui.

**Tutorial passo a passo / modal de "como jogar".** Investigado e descartado. A pesquisa de 2025–2026
sobre onboarding de jogo de navegador sem conta converge para "sem tutorial, um link, um nome,
pronto" — jogos são testados para ter as duas pessoas jogando "inside 30 seconds"
[gamebuddies.io](https://gamebuddies.io/blog/best-browser-games-to-play-with-friends). O lobby atual
já segue essa régua: nome obrigatório com foco automático quando falta
(`apps/client/src/ui/lobby.ts:506-523`), a regra do jogo em UMA frase, repetida no cartão de entrada
E na sala (`lobby.ts:140`, `lobby.ts:200-203`), teclas resumidas em três ícones
(`lobby.ts:205-208`), e um "attract mode" com a arena rodando de verdade atrás do formulário
(`apps/client/src/ui/vitrine.ts:1-8`) — quem abre o link já vê o jogo antes de precisar entender a
regra escrita. Isso já está no ponto; a única lacuna real de entendimento (o risco de cada
power-up) é a recomendação 4, e é deliberadamente pequena — um toast, não uma tela.

**Reformar o killfeed / mostrar zoeira durante a ação.** Descartado — isso já foi tentado e revertido
de propósito pelo próprio projeto: "Fase 8 §3: elas SAÍRAM do killfeed... ler uma piada de duas
linhas no meio de um tiroteio custa atenção que o jogador não tem"
(`apps/client/src/ui/zoeira.ts:1-9`). O feed ao vivo hoje é só "Matador ✕ Vítima"; a piada aparece
depois, na tela de fim de rodada e na de fim de partida, quando todo mundo está parado lendo. É a
decisão certa e não deveria ser desfeita.

**Escalar dificuldade dos bots automaticamente pela pontuação (DDA clássico).** Considerado como
alternativa à recomendação 1 e descartado em favor da vantagem entre rodadas. A literatura de DDA é
inconclusiva sobre qual abordagem funciona melhor — "no one approach demonstrably surpasses static
difficulty settings" — e ajustar a IA dos bots por trás das cortinas não ajuda em nada quando os
outros 9 jogadores da sala são humanos, que é o caso comum aqui (sala cheia de pessoas reais, bots
só de preenchimento). Uma vantagem visível e escolhida pelo próprio jogador tem a transparência que
o estudo do CHI aponta como o que faz uma mecânica de equilíbrio parecer justa, em vez de arbitrária.

**Qualquer coisa sobre desempenho, frame time, ou GPU.** Fora do escopo desta tarefa por definição,
e o `MEDICAO.md` já teria descartado a maior parte das hipóteses óbvias mesmo que estivesse (veja o
arquivo na raiz do repositório — doze hipóteses já derrubadas por medição).

### Armadilhas que este jogo específico corre risco de cair

- **Empilhar poder sem teto** (detalhado acima) — o projeto já sabe disso e escreveu a regra; só
  não deixar uma feature nova reabrir a porta.
- **Draft em turno com sala cheia** — qualquer mecânica de escolha entre rodadas tem que ser
  simultânea, nunca sequencial, ou o tempo morto cresce linear com o número de jogadores.
  - **Adicionar um segundo modo de jogo para "resolver" o treino calmo.** O pedido era treino sem
  bots hostis, não um modo novo — a recomendação 2 é deliberadamente um quarto nível de dificuldade
  dentro do mesmo caminho `TREINAR CONTRA BOTS` que já existe, não uma tela nova.
- **Expor rating como MMR competitivo** — o dado já existe e é tentador de mostrar como está
  (`mu`/`sigma`), mas isso empurra o tom para "ranqueado" numa sala pensada para ser despretensiosa.
- **Exigir conta para qualquer feature nova de retenção** — toda recomendação aqui (placar da sala,
  rating, vantagem entre rodadas) usa identidade que já existe hoje (sessão de sala, `device_id` em
  `localStorage`); nenhuma pede login.

---

## Fontes

- [Rounds Fundamentals: Core Mechanics Explained — Rounds Network](https://rounds.network/rounds-fundamentals-core-mechanics-explained/)
- [Comeback Kid Achievement in Ultimate Chicken Horse — XboxAchievements](https://www.xboxachievements.com/game/ultimate-chicken-horse/achievement/144444-Comeback-Kid.html)
- [REVIEW: Stick Fight: The Game — Save or Quit](https://saveorquit.com/2018/02/05/review-stick-fight-the-game/)
- [Stick Fight: The Game — Couch Co-Op Favorites](https://couchcoopfavorites.com/stick-fight-the-game)
- [How Short, High-Energy Matches Keep Players Coming Back for More — Playbattlesquare](https://playbattlesquare.com/editors-picks/how-short-high-energy-matches-keep-players-coming-back-for-more/)
- [Best Browser Games to Play With Friends (2026) — GameBuddies.io](https://gamebuddies.io/blog/best-browser-games-to-play-with-friends)
- [Best Multiplayer Browser Games to Play With Friends in 2026 — Minix Games](https://minix.games/blog/best-multiplayer-browser-games-friends-2026)
- [Squeezing more juice out of your game design! — Game Developer](https://www.gamedeveloper.com/design/squeezing-more-juice-out-of-your-game-design-)
- [Making Gameplay Irresistibly Satisfying Using Game Juice — The Design Lab, jan/2025](https://thedesignlab.blog/2025/01/06/making-gameplay-irresistibly-satisfying-using-game-juice/)
- [The Trick is to Stay Behind? Defining and Exploring the Design Space of Player Balancing Mechanics — CHI 2024](https://doi.org/10.1145/3613904.3642441)
- [Rubber-Band A.I. — discussão da comunidade sobre Mario Kart (NeoGAF)](https://www.neogaf.com/threads/how-does-mari-kart-still-get-away-with-rubber-band-ai.1228491/) — fonte de comunidade, não acadêmica; usada só para corroborar um padrão de design amplamente documentado (itens mais fortes para quem está atrás), não para números específicos.

Código lido para embasar cada recomendação: `packages/protocol/src/{constants,powerups,messages}.ts`,
`packages/shared-sim/src/{powerups,bot}.ts`, `apps/client/src/ui/{lobby,hud,roundend,result,zoeira,vitrine}.ts`,
`apps/client/src/render/{powerups,Renderer}.ts`, `apps/client/src/{main,net/client}.ts`,
`go/server/{sala,rodada,gameplay,servidor}.go`, `go/sim/bot.go`, `go/persist/{db,rating}.go`,
`go/cmd/servidor/gravador.go`, `go/protocol/powerups.go`, `MEDICAO.md`.
