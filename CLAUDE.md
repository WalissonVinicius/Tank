# Tank Ricochete — jogo FFA de navegador (PixiJS v8 + Colyseus)

Você é um worker coordenado via Orca. Sua tarefa exata chega no preâmbulo de dispatch. **Siga o contrato abaixo à risca** — outros workers estão construindo partes vizinhas em paralelo e dependem dele.

## O jogo

Arena 2D top-down de tanques em labirinto gerado por seed. **Até 10 colegas de trabalho**, todos contra todos, entram por link + código de sala de 4 letras, sem conta. Tanques lentos; balas ricocheteiam até 2× e matam em **1 toque — inclusive quem atirou** (o autogol é a piada central). Rodadas de 20–45 s, 10 rodadas por partida. Servidor Node autoritativo. Visual **neon-noir industrial**, tudo desenhado por código (procedural), sem nenhum arquivo de imagem.

Pesquisa completa que embasa tudo isto: `C:\Users\walis\pesquisa-jogo-pixi\` — leia `G-tanques-design-e-arquitetura.md` (design, tuning, labirinto, netcode, plano) e `E-tanques-stack.md` (stack) antes de codar. O alvo visual é o mockup `mockups/tanques-ricochete.html` da mesma pasta (leia o código dele: lightmap, decalques e juice já estão resolvidos ali — porte, não reinvente).

## Decisões já tomadas (NÃO reabrir)

| Tema | Decisão |
|---|---|
| Renderer | PixiJS 8.20.0, `preference: ['webgl']` **fixo** (nunca webgpu) |
| Rede | Colyseus 0.17 — estado frio no Schema; **balas NUNCA no Schema** |
| Balas | Servidor emite evento `bullet_spawn` (id, dono, x, y, ângulo, tick); **todo cliente simula localmente** com o mesmo código de `shared-sim`. Só a morte vem do servidor. |
| Torre | **Travada no chassi** (gira junto, com atraso de mola cosmético de ~180 ms). Sem mira independente, sem mouse. |
| Imunidade ao próprio tiro | **110 ms** (não 220 ms — o autogol precisa acontecer) |
| Física | **Nenhuma engine.** Círculo×AABB + reflexão vetorial à mão, determinística |
| Entidades | **Classes simples + arrays.** Sem ECS |
| Arte | **100% procedural** (`PIXI.Graphics`, `RenderTexture`, texturas geradas em canvas). Nenhum PNG/SVG externo |
| Build | TypeScript **5.9.3** e Vite **7.3.6** — NÃO usar TS 7 (tsgo) nem Vite 8 |
| Deploy | Docker no Coolify: **1 container, 1 porta (3000)**, servidor Node serve o client estático + WebSocket na mesma porta |

## Stack (versões fixas)

`pixi.js@8.20.0` · `pixi-filters@6.1.5` · `colyseus@0.17.10` · `@colyseus/core@0.17.50` · `@colyseus/schema@4.0.31` · `@colyseus/sdk@0.17.43` · `gsap@3.15.0` · `@pixi/sound@6.0.1` · `zzfx@1.3.2` · `vite@7.3.6` · `typescript@5.9.3` · `tsx@4.23.12` · `tsup@8.5.1` · `vitest@4.1.11` · `better-sqlite3` (última 13.x) · `tweakpane@4.0.5` (dev)

## Monorepo e propriedade de arquivos

```
tank/
├── package.json, pnpm-workspace.yaml, tsconfig.base.json, Dockerfile, .dockerignore, .gitignore
├── packages/
│   ├── protocol/src/        constants.ts (tuning), messages.ts (tipos), colors.ts
│   └── shared-sim/src/      rng.ts, maze.ts, collision.ts, sim.ts, types.ts  (+ test/)
└── apps/
    ├── server/src/          index.ts, rooms/TankRoom.ts, state/*.ts, persist/*.ts
    └── client/              index.html, src/main.ts, src/net/*, src/input/*, src/ui/*, src/render/*
```

**Regra de ouro:** `apps/*` importam de `packages/*`; `packages/*` **nunca** importam de `apps/*`. `shared-sim` é matemática pura — **proibido** `document`, `window`, `Math.random()`, `Date.now()`, I/O. Recebe `dt` fixo e um RNG semeado.

**Edite apenas os caminhos que a sua tarefa listar.** Se precisar de algo de outra área, use a interface publicada abaixo — não edite o arquivo do vizinho.

## Contratos entre as partes

```ts
// packages/protocol/src/constants.ts — FONTE DA VERDADE do tuning (§1.2 do relatório G)
export const TICK_HZ = 60, SNAPSHOT_HZ = 20, CELL = 84;
export const TANK_SPEED = 60, BULLET_SPEED = 215, TANK_RADIUS_F = 0.22, BULLET_RADIUS_F = 0.05;
export const WALL_THICKNESS_F = 0.12, MAX_BOUNCES = 2, BULLET_LIFE = 5.5;
export const MAX_BULLETS = 3, FIRE_COOLDOWN = 0.35, TURN_RATE = 3.2, SELF_IMMUNITY = 0.11;
export const ROUNDS = 10, ROUND_TIMEOUT = 45, COUNTDOWN = 3;

// packages/shared-sim/src/sim.ts — a simulação, idêntica no servidor e no cliente
export function step(state: SimState, inputs: Map<string, Input>, dt: number): SimEvent[];
export function makeMaze(seed: number, players: number): Maze;   // determinístico
export function spawnPoints(maze: Maze, n: number, rng: Rng): Vec2[];

// apps/client/src/render/Renderer.ts — implementado pelo worker de render, usado pelo main.ts
export class Renderer {
  static create(parent: HTMLElement): Promise<Renderer>;
  setMaze(maze: Maze): void;                    // redesenha chão/paredes, limpa decalques
  sync(view: RenderView): void;                 // 1× por frame, estado já interpolado
  onShot(x: number, y: number, angle: number, color: number): void;   // muzzle flash + luz + recuo
  onBounce(x: number, y: number): void;                               // faíscas + marca na parede
  onDeath(x: number, y: number, color: number): void;                 // explosão + shockwave + cratera
  addTrauma(v: number): void;                   // 0..1, screen shake por trauma²
  hitstop(ms: number): void;
  resize(): void;
}
// RenderView = { tanks: {id,x,y,angle,turret,color,alive,name}[], bullets: {x,y}[], me: string }
```

## Fundação entregue (Fase 1) — assinaturas REAIS, use exatamente assim

```ts
import { step, makeMaze, validateMaze, spawnPoints, mulberry32, makeBot } from '@tank/shared-sim';

step(state: SimState, inputs: Map<string, Input>, dt: number): SimEvent[]
// Input = { turn: -1|0|1, move: -1|0|1, fire: boolean }   <- NÃO é o InputMsg da rede!
// O servidor traduz InputMsg (up/down/left/right booleanos) para Input antes de chamar step().

Maze = { cols, rows, cell, walls: Aabb[] }   // origem em (0,0), SEM offset de centralização —
                                             // quem renderiza decide o deslocamento na tela.
SimEvent = { type:'shot'|'bounce'|'death'|'bullet_expired', ... }
           // bullet_expired traz reason: 'max_bounces' | 'life'
Tank NÃO guarda vx/vy — o movimento é recomputado por heading + TANK_SPEED a cada tick.
```

**Alias obrigatório:** o `vitest.config.ts` da raiz aponta `@tank/protocol` e `@tank/shared-sim` direto para o `src/index.ts` de cada um. Quem usar Vite precisa do alias equivalente no `vite.config.ts`, senão o import quebra.

## Regras de código

- **API PixiJS v8 apenas**: `Graphics` encadeado (`.circle(x,y,r).fill({color})`, `.rect(...).stroke({width,color})`), `new PIXI.Text({text, style})`, `blendMode` como string (`'add'`, `'multiply'`), `app.renderer.render({container, target, clear:false})`, `new ParticleContainer({dynamicProperties})` + `new Particle({...})`. **Proibido** API v7: `beginFill`, `drawCircle`, `endFill`, `BLEND_MODES`, `PIXI.Text(str, style)`.
- **Pós-processamento**: no máximo 3 filtros fullscreen, só no container do mundo, **nunca no HUD**. `world.filterArea = app.screen`.
- **HUD**: DOM + CSS por cima do canvas (não `@pixi/ui`). Texto que muda todo frame e vive dentro do mundo (nomes sobre tanques) usa `BitmapText`.
- **Tipografia**: display `Chakra Petch`; corpo **`Sora`** (Google Fonts) — não usar Inter/Roboto/Space Grotesk.
- **Glow só no que emite luz** (bala, muzzle flash, power-up). Painel de UI usa elevação neutra, sem halo colorido.
- **Idioma**: toda a interface, killfeed e comentários em **português (Brasil)** com acentuação correta, UTF-8.
- **TypeScript estrito**, sem `any` solto. Sem comentário explicando o óbvio.

## Cores dos 10 jogadores

`#ff4d6d` `#ff8c42` `#ffd84d` `#7cff6b` `#5cffd1` `#4dd2ff` `#6b8cff` `#c77dff` `#ff5ce1` `#d9dee8`
Nomes de teste: Ana, Bruno, Carla, Diego, Elisa, Fábio, Gabi, Hugo, Ítalo, Júlia.

## Paleta do mundo

fundo `#0b0f1a` · piso `#141a2b` (ruído procedural) · parede `#1f2a44` com topo `#3a4a73` · luz quente `#ffb347` · alerta `#ff3b3b` · ambiente do lightmap `#1e2236`

## Como rodar e testar

```bash
pnpm install
pnpm dev            # sobe servidor (tsx watch) + client (vite) juntos
pnpm test           # vitest — simulação determinística
pnpm build          # tsup (server) + vite build (client)
```

Screenshot de verificação — **use Playwright com viewport exato**, não o Edge headless direto:

> ⚠️ `msedge --headless --window-size=1280,720 --screenshot` entrega **viewport de 1256×628** (a moldura da janela é descontada) enquanto o PNG sai 1280×720. Isso cria uma faixa morta na imagem e faz o `fitCamera` calcular errado. Descoberto na Fase 2E — não use esse comando para avaliar enquadramento.

```bash
npx playwright screenshot --viewport-size=1280,720 --wait-for-timeout=8000 \
  "http://localhost:5173/?local=1&bots=6&seed=42" "C:\Users\walis\tank\_shot.png"
```
Depois **abra o PNG com a ferramenta Read** e avalie de verdade. Para medir luminância, leia os pixels do PNG e calcule por blocos (o alvo do projeto é média 0,35–0,55 com nenhum bloco grande abaixo de 0,15).

## Ao terminar

Rode `pnpm test` (e o build, se a sua parte afeta) antes de reportar. Envie `worker_done` **exatamente uma vez**, com `--outcome succeeded|failed` e `--files-modified`. Não faça commit — o coordenador cuida do git. Nunca reporte sucesso com teste quebrado.
