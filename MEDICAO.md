# Como medir desempenho neste jogo (e a armadilha que custou dias)

## A regra que resume tudo

**O Chromium do Playwright não é o Chrome.** Meça no navegador que o jogador usa
(`channel: 'chrome'`), em **produção**, numa **sala real**. Qualquer um dos três trocado
inventa um problema que não existe.

## O que o jogo entrega hoje

Chrome instalado, `https://tank.walisson.dev`, sala real com 7 bots, 35 s por amostra:

| Cenário | FPS | Frames ruins | p95 | Travadas > 500 ms | Pior frame | Degrau de FX |
|---|---|---|---|---|---|---|
| GPU integrada (Iris Xe) | 59,9 | 0–2% | 17 ms | **0** | 34 ms | alto |
| Integrada + CPU 4× mais lenta | 59,5 | 24–37% | 34 ms | **0** | 217 ms | reduzido / mínimo |
| Sem GPU (SwiftShader) | 15 | 100% | 83 ms | **0** | 150 ms | desligado |

Rede, na mesma amostra: ~580 snapshots por 35 s, ~22 buracos acima de 150 ms — que **não**
chegam ao jogador, porque o buffer de interpolação os cobre (0,08% de saltos no movimento
dos tanques, e os grandes são respawn).

## A armadilha

Uma investigação longa perseguiu um congelamento de 1,2 a 3,2 s que aparecia ~5 vezes a
cada 35 s. Mesma máquina, mesma GPU Intel, mesmo backend `d3d11`, mesma versão 151:

```
Chromium do Playwright : 4-7 travadas acima de 500ms, pior 1717ms
Chrome instalado       : 0 travadas,                  pior   34ms
Edge instalado         : 0 travadas,                  pior   34ms
```

O Chromium empacotado não traz os contornos de bug de driver que o Chrome e o Edge aplicam
na Intel. **O travamento era do arnês de teste.** Nenhum jogador jamais o viu.

## Hipóteses derrubadas por medição (não repita)

Todas foram testadas contra aquele congelamento fantasma e todas deram negativo:

| Hipótese | Como caiu |
|---|---|
| Filtros do Pixi | `?fx=desligado` manteve a mesma contagem |
| Upload de textura | As rodadas que mais congelavam não criavam textura |
| Coleta de lixo | Heap parado em 14,5 MB, zero coletas em 35 s |
| JavaScript longo | `setTimeout` disparou 124× **dentro** de um frame de 1922 ms |
| Leitura de GPU | 0 `toDataURL`, 0 `readPixels`, 0 `getImageData` em 30 s |
| A simulação | Congelava igual na tela de entrada, sem jogo rodando |
| MSAA | `?aa=0` (SAMPLES 4 → 0): 5,7 travadas dos dois lados |
| Cache de shader | Perfil persistente, 3 visitas: travou nas três |
| Blur de CSS sobre o canvas | Zero trocas de `fundo-vivo` durante as travadas |
| Rasterização da interface | `--disable-gpu-rasterization` e DOM escondido: sem efeito |
| `powerPreference` | No Windows o Chrome ignora; continuou na Intel |
| A mensagem de estado frio | Teste de permutação: 15 observados, 13,9 esperados por acaso |

## Método

1. **Meça o piso de ruído antes de acreditar em qualquer A/B.** Rode a MESMA configuração
   5 vezes. Se a dispersão for maior que o efeito procurado, a medição não serve.
2. **Teste de permutação para toda coincidência.** Janelas de ±250 ms cobrem 78% de uma
   linha do tempo de 35 s — "14 de 19 coincidiram" pode ser puro acaso, e já foi.
3. **Sala real, não `?local=1`.** O modo local não tem WebSocket, snapshot nem
   interpolação: ele mede o renderizador, não o jogo.
4. **Um controle que isola o arnês.** Antes de culpar o código, rode o mesmo teste em outro
   navegador. Foi o que resolveu isto aqui, e foi o último a ser tentado.

## Chaves de URL para diagnóstico

| Chave | Efeito |
|---|---|
| `?debug=1` | Publica em `window.__tank` o que este cliente está desenhando no frame |
| `?sw=1\|0` | Finge (ou nega) a ausência de GPU |
| `?aa=1\|0` | Força MSAA ligado ou desligado |
| `?fx=alto\|reduzido\|minimo\|desligado` | Trava o degrau de pós-processamento |
| `?local=1` | Simulação local, sem servidor — **não** use para medir desempenho de jogo |
| `?bots=N` | Quantidade de bots na sala |
