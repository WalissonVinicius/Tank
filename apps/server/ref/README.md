# `ref/` — geradores dos vetores de referência do servidor Go

O servidor Go (`go/server`, `go/persist`) é um PORTE deste servidor. Porte comparado só consigo
mesmo não prova nada, então os testes Go conferem contra a saída do TypeScript de verdade — e
estes quatro scripts são quem produz essa saída.

```bash
cd apps/server
npx tsx ref/codec.ts     > ../../go/server/testdata/codec.json
npx tsx ref/protocolo.ts > ../../go/server/testdata/protocolo.json
npx tsx ref/rodada.ts    > ../../go/server/testdata/rodada.json
node    ref/rating.mjs   > ../../go/persist/testdata_rating.json
```

Rode de novo quando mexer no tuning, na paleta, nos nomes de canal, no `roundLoop` ou no formato
do snapshot: os testes Go quebram na hora, apontando o valor exato que divergiu.

Eles moram aqui, e não em `go/ts/`, porque importam módulos deste pacote (`src/net/snapshot.ts`,
`src/rooms/roundLoop.ts`) e o `openskill` do `node_modules` daqui. De outro diretório a resolução
de módulos não os encontraria.
