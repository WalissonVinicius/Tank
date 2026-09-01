# R2 — Renderização e frontend

## Resumo

O renderizador já está maduro: `renderGroup` no lugar certo, `ParticleContainer` com
`dynamicProperties`, pooling disciplinado (decalques, luzes, tanques) e um adaptador de qualidade
que já resolve o essencial do problema de máquina fraca. O maior desperdício real que encontrei é
CPU gasta rasterizando o labirinto (paredes + placas do piso) do zero em **todo frame**, quando ele
é 100% estático dentro de uma rodada — `cacheAsTexture` resolve isso e ajuda mais exatamente no
cenário que mais importa (sem GPU) e no CPU 4× mais lento. WebGPU deve continuar desligado — a
própria documentação da PixiJS recomenda WebGL em produção em 2026. Encontrei duas regras CSS que
custam pintura/layout de verdade (peguei elas nominalmente), mas a maioria das 25 é gratuita.
Bundle e memória já estão bons; não mexeria neles além de um item de higiene.

## Recomendações priorizadas

| # | Recomendação | Cenário que melhora | Impacto esperado | Custo | Risco |
|---|---|---|---|---|---|
| 1 | `cacheAsTexture` nas paredes e placas do piso do labirinto | **Sem GPU**: alto (menos rasterização por frame). **CPU 4× mais lenta**: moderado. GPU integrada: neutro | Alto no pior cenário | Médio (~15 linhas, precisa validar com o painel de FPS) | Baixo |
| 2 | `efeito-acaba` anima `background` em vez de `opacity` | CPU 4× mais lenta: pequeno, só quando há power-up prestes a expirar | Pequeno | Trivial (1 linha) | Nenhum |
| 3 | `tremor-vai` anima `margin-left` (layout) em vez de `translate` | CPU 4× mais lenta: pequeno, só na largada (10×/partida, ~340 ms cada) | Pequeno | Trivial (usar o mesmo padrão que `toque.css` já usa) | Nenhum |
| 4 | Auto-hospedar as fontes do Google | Tempo até jogar (não é nenhum dos 3 cenários de FPS) | ~200–300 ms de LCP/FCP, medido pela indústria | Baixo | Baixo |
| 5 | Screen Wake Lock durante a partida (celular) | Mobile: evita a tela apagar e a aba ser suspensa no meio de uma partida de 5–10 min | Funcional, não é FPS | Baixo | Baixo |
| 6 | Ignorar/ajustar o aviso de chunk do Vite | Nenhum — é ruído | Nenhum | Trivial | Nenhum |
| 7 | Remover `gsap` e `@colyseus/sdk` do `package.json` do client | Nenhum — os dois já saem do bundle final (não são importados) | Nenhum (higiene) | Trivial | Nenhum |

---

## 1. `cacheAsTexture` no labirinto — a maior sobra de CPU no caminho quente

**Por quê.** `MazeView.drawWalls()` (`apps/client/src/render/maze.ts:380-482`) desenha ~15
operações de `poly`/`rect`/`stroke` **por parede** (silhueta, contorno, duas faces, topo, bisel ×4,
juntas de módulo, rebites) dentro de um único `Graphics` (`wallGraphics`, campo declarado na linha
125). Para um labirinto de ~100 paredes isso são bem mais de mil primitivas. `drawFloor()`
(`maze.ts:259-333`, chama `drawSujeira` na 332) desenha outra centena a milhares de círculos/traços
por célula em `plates` (linha 120). O comentário do próprio arquivo já diz que isso roda **uma vez
por rodada** (`setMaze()`), mas isso descreve só a construção da geometria — o Pixi ainda
**rasteriza essas mesmas mil-e-tantas primitivas em todo frame**, porque nada aqui está marcado
como estático para o renderizador. É exatamente o padrão que a documentação oficial da PixiJS 8
recomenda resolver com `cacheAsTexture`: "pode ser ótimo para desempenho se o container for
estático... renderiza uma única textura em vez de todos os filhos" — e adverte para não usar em
containers com poucos elementos, o que não é o caso aqui.

Isso ajuda mais exatamente onde o próprio código já diagnosticou o gargalo: o comentário de
`DPR_MAX_SOFTWARE` em `Renderer.ts:97-99` diz que sem GPU "o que manda é FILL RATE puro: cada pixel
do mundo custa caro quando quem rasteriza é a CPU" — que é precisamente o que `cacheAsTexture`
elimina para o labirinto (rasteriza uma vez por rodada, não 60×/s). No cenário "integrada + CPU 4×
mais lenta" o ganho é menor (ali o gargalo já é mais JS/simulação que fill rate), mas ainda reduz
comandos de desenho e overdraw das camadas de bisel semi-transparentes empilhadas. No cenário "GPU
integrada" (59,9 fps hoje) não deve mudar nada perceptível — é um caso que já está bom.

**O que muda.** `apps/client/src/render/maze.ts`.

No construtor (perto da linha 160-165, logo depois de criar `wallShadow`/`wallGraphics`/`plates`):

```ts
this.wallShadow.cacheAsTexture(true);
this.wallGraphics.cacheAsTexture(true);
this.plates.cacheAsTexture(true);
```

No fim de `drawWalls()` (depois da linha 481, que fecha o loop de rebites):

```ts
this.wallShadow.updateCacheTexture();
this.wallGraphics.updateCacheTexture();
```

No fim de `drawFloor()` (depois de `this.drawSujeira(maze);`, linha 332):

```ts
this.plates.updateCacheTexture();
```

**Ressalvas.** `luminarias` e `floorSprite` ficam de fora de propósito: `luminarias` pulsa alpha por
frame em `animarAmbiente()` (linha 533) — cachear e ficar chamando `updateCacheTexture()` 60×/s
anularia o ganho — e `floorSprite` já é um `TilingSprite` (amostragem nativa da GPU, nada a
cachear). O custo é uma textura extra na GPU do tamanho do mundo × resolução (poucos MB, recriada só
quando `updateCacheTexture()` é chamado, ou seja, uma vez por rodada). Antes de considerar isto
pronto, validar com o painel de FPS (`ui/desempenho.ts`) e `?fx=` nos três cenários da tabela — a
API é nova o bastante (mixin dedicado em `cacheAsTextureMixin.d.ts` da própria 8.20.0) para merecer
essa checagem antes de confiar de olhos fechados.

## 2. `efeito-acaba` anima uma propriedade que força pintura

**Por quê.** `style.css:719-728`:

```css
#hud-efeitos .efeito.acabando {
  animation: efeito-acaba 380ms steps(2, jump-none) infinite;
}

@keyframes efeito-acaba {
  50% {
    background: var(--painel-3);
    opacity: 0.55;
  }
}
```

`transform`, `opacity` e (parcialmente) `filter` são as únicas propriedades que o Chrome consegue
animar inteiramente na *compositor thread*, sem tocar a *main thread*. `background` não está nessa
lista — toda vez que a cor de fundo muda, o Blink tem que repintar aquele elemento. Essa é a única
das 25 regras `animation:` do projeto que mistura uma propriedade de pintura com `infinite`: ela
roda a cada 190 ms (dois passos em 380 ms) o tempo todo que um power-up do jogador local está a
menos de 3 s de expirar (`ui/hud.ts`, classe `.acabando`). Isso compete por tempo de main thread
exatamente no cenário "CPU 4× mais lenta", onde a simulação e o parse de rede já disputam o mesmo
núcleo. O custo por si é pequeno (é uma pastilha de HUD, não a tela inteira), mas é o único dos 25
que não é gratuito, e a troca é de uma linha.

**O que muda.** `apps/client/src/style.css:723-728` — tirar a propriedade que pinta e manter só
`opacity`, que já está na mesma regra:

```css
@keyframes efeito-acaba {
  50% {
    opacity: 0.55;
  }
}
```

A leitura visual muda ligeiramente (antes escurecia E piscava; agora só pisca), mas continua sendo o
aviso "isto está acabando" que a barra ao lado já reforça — não perde a função.

## 3. `tremor-vai` anima `margin-left`, que é layout (pior que pintura)

**Por quê.** `style.css:2416-2423`:

```css
@keyframes tremor-vai {
  0% { margin-left: -5px; }
  100% { margin-left: 5px; }
}
```

Usada em `#contagem .numero.vai` (`style.css:2321`) junto com `contagem-vai`: `animation:
contagem-vai 0.9s ..., tremor-vai 0.34s steps(2) 3;`. `margin` é uma propriedade de **layout**
(reflow), a categoria mais cara das três (layout → pintura → composição) — pior que o caso do item
2. Ela dispara 10× por partida (uma por rodada, no "VAI!"), por ~340 ms, exatamente no mesmo
instante em que a arena está se montando (`Renderer.ts`, `MONTAGEM_*`) e a câmera está saindo do
zoom da largada — ou seja, empilha em cima de outro trabalho pesado do mesmo frame, no pior momento
possível dentro da rodada.

**O que muda.** Não dá para trocar `margin-left` direto por `transform: translateX(...)` porque
`contagem-vai`, na MESMA regra, já anima `transform` (scale) — duas animações escrevendo a
propriedade `transform` shorthand não compõem, uma sobrescreve a outra. O próprio projeto já
resolveu esse exato problema em outro lugar: `toque.css:300-308` usa a propriedade `translate`
avulsa (não o shorthand `transform`) justamente para não colidir com uma animação de entrada que já
usa `transform`, com o comentário explicando o motivo. Mesmo padrão aqui:

```css
/* style.css:2416 */
@keyframes tremor-vai {
  0% { translate: -5px 0; }
  100% { translate: 5px 0; }
}
```

`translate`/`scale`/`rotate` como propriedades próprias (não o shorthand `transform`) são suportadas
em todos os browsers relevantes desde 2021-2022 e compõem com `transform` em vez de brigar com ele,
e continuam animáveis pelo compositor.

## 4. Auto-hospedar Chakra Petch e Sora

**Por quê.** `apps/client/index.html:22-27` carrega as fontes assim:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=Sora:wght@400;500;600;700&display=swap"
  rel="stylesheet"
/>
```

Isso é duas viagens em série: o browser busca o CSS em `fonts.googleapis.com`, só então descobre as
URLs dos arquivos `.woff2` e busca em `fonts.gstatic.com`. Desde que o Chrome particionou o cache
HTTP por origem (2020), o argumento antigo de "cache compartilhado entre sites" não existe mais — a
fonte baixada num outro site não ajuda o seu. A recomendação de 2025-2026 é hospedar os `.woff2` no
próprio domínio (aqui, servidos pelo Go junto do resto do client estático), cortando a viagem extra.
Isso não aparece em nenhum dos 3 cenários da tabela (eles medem quadro, não carregamento) — é
especificamente sobre "tempo até jogar", que é o que a área 4 pediu.

**O que muda.** Baixar os `.woff2` das duas famílias (pesos 500/600/700 para Chakra Petch, 400-700
para Sora) para `apps/client/public/fontes/`, declarar `@font-face` no topo de `style.css` com
`font-display: swap` (mantendo o comportamento atual) e apontar para eles, removendo os três links
de `index.html`. É trabalho mecânico, baixo risco, sem mudança de comportamento visível — só menos
uma conexão TLS e uma viagem HTTP antes do texto certo aparecer.

## 5. Screen Wake Lock durante a partida

**Por quê.** `apps/client/src/input/toque.ts` já cobre bem o celular: `touch-action`, trava de
orientação, DPR limitado (`DPR_MAX_TOQUE`), zona segura (`env(safe-area-inset-*)`). O que falta é a
Screen Wake Lock API, que está em todos os browsers relevantes desde março de 2025 (Chrome 84+,
Safari 16.4+ em iOS, Firefox 126+) e existe exatamente para o problema que uma partida deste jogo
tem: 10 rodadas de até 45 s cada é uma sessão de vários minutos com o dedo às vezes parado na tela
(esperando reconectar, olhando o placar) — tempo de sobra para o celular apagar a tela sozinho. Uma
vez que a tela apaga, a aba fica oculta pelo sistema e o `requestAnimationFrame` é jogado a ~1 Hz —
o jogo trava de verdade para aquele jogador, e ele só descobre ao acordar o aparelho. Isso não
aparece em nenhum dos 3 cenários medidos (são todos desktop) — é um problema específico de celular
que a tabela não captura.

**O que muda.** Em `apps/client/src/main.ts`, pedir o lock ao entrar na partida (gesto do usuário já
existe — o clique em "ENTRAR"/"CRIAR SALA") e sempre readquirir em `visibilitychange` (o lock é
liberado automaticamente quando a aba fica oculta e precisa ser pedido de novo ao voltar):

```ts
let wakeLock: WakeLockSentinel | null = null;
async function manterTelaAcesa(): Promise<void> {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // Sem permissão ou sem suporte: o jogo continua, só sem a garantia.
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock === null) void manterTelaAcesa();
});
```

Chamar `manterTelaAcesa()` só em modo toque (`emModoToque()`, já existe em `ui/layout.ts`) e só
depois de entrar na sala — não faz sentido segurar a tela acesa no lobby.

## 6. O aviso de chunk do Vite: ruído, não sinal

`npx vite build` (rodado para este relatório) produz:

```
dist/assets/index-DHXb10M9.js   527.67 kB │ gzip: 166.55 kB
(!) Some chunks are larger than 500 kB after minification...
```

Naveguei o build de produção (`vite preview`) com Playwright e capturei a rede: com
`preference: ['webgl']` fixo (`Renderer.ts:884`), o browser **não baixa** `WebGPURenderer-*.js`
(46 kB / 13 kB gzip) nem `CanvasRenderer-*.js` (18 kB / 6 kB gzip) — a PixiJS 8 já faz import
dinâmico condicionado à preferência, então esses chunks existem no `dist/` mas nunca chegam à rede.
O que é de fato transferido é: `index-DHXb10M9.js` (166,55 kB gz, código do jogo + `pixi-filters` +
`zzfx`) + `WebGLRenderer`/`BufferResource`/`RenderTargetSystem`/`browserAll`/`webworkerAll` (mais
~53 kB gz de internals da PixiJS) + CSS (10,79 kB gz) ≈ **230 kB gzip** de JS+CSS até a tela de
entrada. Isso é razoável para um jogo com toda a arte procedural embutida — não é o "SPA de texto"
que o limite de 500 kB do Vite foi calibrado para, e como o jogo não tem rotas (o lobby já roda o
Renderer atrás, `.fundo-vivo` em `style.css:107`), praticamente 100% desse JS é necessário antes da
primeira tela mesmo com mais divisão de código.

**O que muda (opcional, sem ganho de bytes).** Se o aviso incomodar, silenciar em
`apps/client/vite.config.ts` em vez de perseguir divisão de código que não reduziria o total
baixado:

```ts
export default defineConfig({
  build: { chunkSizeWarningLimit: 700 },
  // ...resto igual
});
```

## 7. Higiene de dependências (sem efeito em bytes)

`apps/client/package.json:12-20` lista `gsap` e `@colyseus/sdk` como dependências, mas nenhum
arquivo em `apps/client/src` importa nenhum dos dois (busquei `gsap|colyseus` em todo o diretório —
os únicos acertos são comentários explicando a migração para WebSocket cru, não `import`s reais).
Como o Vite/Rollup só inclui o que é importado, isso não infla o bundle — os 527 kB medidos já não
contêm nem gsap nem o SDK do Colyseus. É só `package.json` desatualizado (sobra da migração para o
backend Go descrita no `CLAUDE.md`). Vale limpar por clareza, não por desempenho. `qrcode` está
correto como dependência: é importado dinamicamente em `ui/lobby.ts:718` (`await import('qrcode')`),
então já fica fora do bundle principal por padrão.

---

## O que investigei e descartei

- **Culling automático (Pixi v8).** A API de culling da v8 (`cullable = true` por objeto) só ajuda
  quando existe conteúdo fora da câmera. Neste jogo `fitCamera()` (`Renderer.ts:1324-1344`) sempre
  enquadra o labirinto inteiro na tela — não existe mundo fora de vista para cortar. Habilitar
  culling adicionaria o teste de bounds por objeto todo frame sem nunca eliminar nada: puro custo,
  zero ganho. A própria documentação da PixiJS avisa que culling **piora** o desempenho quando o
  jogo é CPU-bound, que é justamente o cenário "CPU 4× mais lenta" que mais importa aqui.
- **WebGPU em vez de WebGL.** A documentação oficial da PixiJS 8 diz textualmente: "o renderizador
  WebGPU está funcionalmente completo, porém inconsistências entre implementações de browser podem
  levar a comportamento inesperado. É recomendado usar o renderizador WebGL para aplicações em
  produção." Fora da PixiJS, o levantamento de bugs de 2025-2026 encontrou: driver da NVIDIA
  572.xx travando com RTX 30/40, artefatos de triangulação em Radeon HD 7700 no Chrome (mas não no
  Edge), hangs de driver em Intel integrada com indirect draw calls, inicialização falhando em
  Apple Silicon, um CVE de use-after-free no Dawn (CVE-2026-5281, corrigido em abril/2026) e
  travamentos de aba por "Device Lost" quando abas em segundo plano esgotam memória de GPU. Nada
  disso aparece na tabela de medição deste projeto (que já descartou GPU/driver como causa dos
  travamentos investigados — ver `MEDICAO.md`), e trocar de backend trocaria um problema resolvido
  por uma superfície nova de bugs, sem nenhum ganho medido para compensar. **Mantenha `preference:
  ['webgl']` fixo.** Não vale nem testar atrás de chave de URL agora: não há hipótese pendente que
  justifique o esforço de manter os filtros funcionando nos dois backends (o `AdvancedBloomFilter`
  já tem um bug documentado de blend mode avançado não escalar com resolução não inteira do
  framebuffer, que teria que ser revalidado em WebGPU).
- **Pressão de GC pelas partículas (`ParticleSystem.spawn()`, `particles.ts:77`).** Diferente de
  `DecalLayer` e `LightFx`, que reciclam `Sprite`s de um pool, `ParticleSystem.spawn()` sempre cria
  um `Particle` novo. Cheguei a cogitar isso como fonte de pressão de coleta de lixo (um abate sozinho
  gera 46+10 partículas, ou seja, milhares por partida) — mas o `MEDICAO.md` já teve essa hipótese
  testada e refutada durante a caça ao congelamento fantasma: "Coleta de lixo | Heap parado em
  14,5 MB, zero coletas em 35 s". `Particle` na Pixi v8 é uma estrutura de dados deliberadamente leve
  (não um `DisplayObject` completo) feita para esse padrão de uso; o V8 lida com objetos pequenos de
  vida curta por scavenge quase grátis. Não proponho pool aqui sem uma medição nova que contradiga o
  que já foi medido.
- **`cacheAsTexture` nas luminárias e no piso base.** `luminarias` pulsa alpha todo frame em
  `MazeView.animarAmbiente()` (`maze.ts:533`) e `floorSprite` já é um `TilingSprite` (amostragem
  nativa da GPU) — cachear o primeiro exigiria `updateCacheTexture()` 60×/s (perde o ganho) e
  cachear o segundo não tem o que economizar. Só `wallGraphics`, `wallShadow` e `plates` — que são
  desenhados uma vez por rodada e nunca mudam depois — se qualificam (recomendação 1).
  Renderização por nível: no cenário "sem GPU" a cadeia inteira já está desligada (`desligado`), e
  ali o custo por pixel do MUNDO é o que domina, não os filtros — outro motivo para
  `cacheAsTexture` no labirinto valer mais nesse cenário que qualquer ajuste de pós-processamento.
- **`renderGroup` aninhado em `entitiesLayer`/`fxLayer`.** `world` já é a única `renderGroup`
  (`Renderer.ts:515`), e é o lugar certo: ela concentra a câmera (posição/escala/rotação do shake,
  que muda todo frame) numa fronteira só, evitando que a atualização de transform se propague pela
  árvore inteira a partir do `stage`. Aninhar uma segunda `renderGroup` dentro dela para os tanques
  (que se movem individualmente, não como grupo) não tem o padrão de uso que a documentação da
  PixiJS recomenda para essa otimização — "conteúdo que não muda com frequência" ou "uma subárvore
  que transforma como um todo" — e adicionaria a sobrecarga própria de cada `renderGroup` sem
  contrapartida. Não proponho sem dado de profiler que mostre o contrário.
- **Passive event listeners no toque (`toque.ts:257-264`).** `pointerdown`/`pointermove` estão como
  `{ passive: false }` porque chamam `preventDefault()`. Como `touch-action: none` já está declarado
  em CSS para essas camadas (`toque.css:35-39`), parte desse `preventDefault` pode já ser redundante
  — mas não tenho como confirmar sem um aparelho de toque real na mão (o Chromium do Playwright já
  provou neste projeto que não serve de substituto para medir comportamento de browser real — ver
  `MEDICAO.md`), então não incluo como recomendação, só registro como algo a testar em aparelho
  físico antes de mexer.
- **Divisão de código adicional do bundle principal.** Ver recomendação 6 — medi via rede real
  (Playwright + `vite preview`) que o que baixa hoje já é quase só o necessário para a primeira
  tela; mais `manualChunks` trocaria uma requisição grande por várias pequenas sem reduzir o total
  de bytes, e o jogo não tem rotas para justificar lazy-loading de telas inteiras.
- **Memória/vazamento ao longo de 10 rodadas.** Revisei `TankView.destroy()` (`tank.ts:258-264`,
  distingue textura compartilhada de textura própria), `DecalLayer` (reusa a `RenderTexture` quando
  o tamanho não muda, `decals.ts:69-72`, comentário explícito citando isso como ex-candidato a
  travamento na Fase 4), `LightFx` (pool de `Sprite`, `lights.ts:74-76`) e os listeners globais de
  `main.ts` (todos registrados uma vez na inicialização, nenhum por rodada/por entidade). Não achei
  padrão de acumulação. Não é preciso testar heap ao vivo para este relatório — o código já mostra
  by design que não acumula.

## Fontes

- [Cache As Texture — PixiJS](https://pixijs.com/8.x/guides/components/scene-objects/container/cache-as-texture)
- [`cacheAsTextureMixin.d.ts` — `pixi.js@8.20.0` instalado no projeto](../node_modules/.pnpm/pixi.js@8.20.0/node_modules/pixi.js/lib/scene/container/container-mixins/cacheAsTextureMixin.d.ts)
- [Render Groups — PixiJS](https://pixijs.com/8.x/guides/concepts/render-groups)
- [Performance Tips — PixiJS](https://pixijs.com/8.x/guides/concepts/performance-tips)
- [Optimizing Rendering with PixiJS v8: A Deep Dive into the New Culling API — Richard Fu](https://www.richardfu.net/optimizing-rendering-with-pixijs-v8-a-deep-dive-into-the-new-culling-api/)
- [Renderers (WebGL vs WebGPU) — PixiJS](https://pixijs.com/8.x/guides/components/renderers) — fonte da recomendação oficial "use WebGL em produção"
- [WebGPU vs WebGL for Games (2026) — Cinevva](https://app.cinevva.com/guides/webgpu-vs-webgl-games)
- [Google's Fourth Chrome Zero-Day of 2026 — CVE-2026-5281 (Dawn/WebGPU)](https://www.gblock.app/articles/chrome-zero-day-cve-2026-5281-webgpu)
- [Stick to Compositor-Only Properties and Manage Layer Count — web.dev](https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count)
- [Animations and performance — web.dev](https://developers.google.com/web/fundamentals/design-and-ux/animations/animations-and-performance)
- [The Web Animation Performance Tier List — Motion Magazine](https://motion.dev/magazine/web-animation-performance-tier-list)
- [Self-hosted fonts vs. Google Fonts API — LogRocket](https://blog.logrocket.com/self-hosted-fonts-vs-google-fonts-api/)
- [Self host Google fonts for better Core Web Vitals — corewebvitals.io](https://www.corewebvitals.io/pagespeed/self-host-google-fonts)
- [Screen Wake Lock API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)
- [The Screen Wake Lock API is now supported in all browsers — web.dev](https://web.dev/blog/screen-wake-lock-supported-in-all-browsers)
- [Stay awake with the Screen Wake Lock API — Chrome for Developers](https://developer.chrome.com/docs/capabilities/web-apis/wake-lock)
- Medição própria: `npx vite build` em `apps/client` (01/09/2026) + inspeção de rede via Playwright
  contra `vite preview`, confirmando que os chunks `WebGPURenderer`/`CanvasRenderer` não são
  baixados com `preference: ['webgl']`.
- `MEDICAO.md` (raiz do repositório) — linha de base medida e hipóteses já derrubadas, citadas onde
  aplicável.
