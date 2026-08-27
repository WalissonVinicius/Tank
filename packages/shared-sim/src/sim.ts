import {
  BULLET_EXPLOSION_RADIUS,
  BULLET_LIFE,
  BULLET_RADIUS,
  BULLET_SPEED,
  FIRE_COOLDOWN,
  MAX_BOUNCES,
  MAX_BULLETS,
  MAX_BULLETS_BY_PLAYERS,
  SELF_IMMUNITY,
  TANK_RADIUS,
  TANK_SPEED,
  TURN_RATE,
  TURRET_RATE,
} from '@tank/protocol';
import { circleVsAabbSlide, raycastSegment, reflect } from './collision.js';
import type { Aabb, Bullet, Input, SimEvent, SimState, Tank, Vec2 } from './types.js';

function normalizeAngle(a: number): number {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r < -Math.PI) r += Math.PI * 2;
  return r;
}

// Gira `current` na direção de `target` pelo caminho curto, gastando no máximo `maxStep` rad.
// É o que dá peso à torre: mudar de lado da tela custa tempo real, não um frame.
function angleTowards(current: number, target: number, maxStep: number): number {
  const diff = normalizeAngle(target - current);
  if (Math.abs(diff) <= maxStep) return normalizeAngle(target);
  return normalizeAngle(current + Math.sign(diff) * maxStep);
}

function maxBulletsFor(playerCount: number): number {
  const n = Math.min(10, Math.max(2, Math.round(playerCount)));
  return MAX_BULLETS_BY_PLAYERS[n] ?? MAX_BULLETS;
}

const emptyInput: Input = { mover: null, fire: false };

// Quantas reflexões a bala pode TENTAR resolver dentro de um mesmo tick. Como ela morre no
// rebote de nº MAX_BOUNCES + 1, este teto só precisa cobrir o caso de quina dupla antes da morte;
// as duas iterações extras são folga numérica. O que sobrar de `timeLeft` fica para o tick
// seguinte, e a bala que ainda tem rebote sobrando segue viva.
const MAX_REFLEXOES_POR_TICK = MAX_BOUNCES + 3;

function stepTanks(state: SimState, inputs: Map<string, Input>, dt: number, events: SimEvent[]): void {
  const maxBullets = maxBulletsFor(state.tanks.size);

  for (const tank of state.tanks.values()) {
    if (!tank.alive) continue;
    const input = inputs.get(tank.id) ?? emptyInput;

    // Movimento ABSOLUTO: o tanque anda para onde o input mandou, no mesmo tick, na velocidade
    // cheia. O chassi vira para essa direção a TURN_RATE só como ENFEITE — nenhuma linha abaixo
    // depende de `tank.heading` para deslocar. Com tank controls, estar virado errado custava
    // 0,49 s de giro antes do primeiro pixel andado, e era isso que dobrava (133 px → 239 px) o
    // raio em que sair da linha de uma bala é impossível.
    //
    // Diagonal não anda mais rápido que reto porque `mover` é um ÂNGULO: `cos`/`sin` sempre dão
    // um vetor de módulo 1, não há o que normalizar depois.
    if (input.mover !== null) {
      tank.heading = angleTowards(tank.heading, input.mover, TURN_RATE * dt);

      const candidate: Vec2 = {
        x: tank.x + Math.cos(input.mover) * TANK_SPEED * dt,
        y: tank.y + Math.sin(input.mover) * TANK_SPEED * dt,
      };
      const resolved = circleVsAabbSlide(candidate, TANK_RADIUS, state.maze.walls);
      tank.x = resolved.x;
      tank.y = resolved.y;
    }

    // Torre independente do chassi (Fase 4): persegue o ângulo de mira do input a TURRET_RATE.
    // Sem `aim` no input a torre fica onde está — ver comentário em `Input.aim`.
    if (input.aim !== undefined) {
      tank.turret = angleTowards(tank.turret, input.aim, TURRET_RATE * dt);
    }

    if (tank.fireCooldownLeft > 0) tank.fireCooldownLeft = Math.max(0, tank.fireCooldownLeft - dt);

    if (input.fire && tank.fireCooldownLeft <= 0) {
      let aliveOwned = 0;
      for (const bullet of state.bullets) if (bullet.ownerId === tank.id) aliveOwned++;

      if (aliveOwned < maxBullets) {
        // A bala sai pela boca do CANO, não pela frente do chassi: com torre livre, os dois
        // apontam para lados diferentes na maior parte do tempo.
        const offset = TANK_RADIUS + BULLET_RADIUS + 4;
        const dirX = Math.cos(tank.turret);
        const dirY = Math.sin(tank.turret);
        let bx = tank.x + dirX * offset;
        let by = tank.y + dirY * offset;

        // Fase 12: o trecho centro→boca do cano é TESTADO contra as paredes antes de a bala
        // existir. Encostado numa parede com a torre virada para ela, esses ~27 px de offset
        // atravessavam a geometria e a bala nascia do outro lado (relatado pelo usuário jogando
        // em rede). Havendo parede no meio, ela nasce encostada do lado de DENTRO — a parede
        // vem inflada pelo raio da bala, então o ponto de impacto já é a posição em que ela toca
        // sem penetrar — e ricocheteia normalmente no tick seguinte.
        //
        // O raio nunca começa dentro de uma parede inflada: `circleVsAabbSlide` mantém o centro
        // do tanque a pelo menos TANK_RADIUS de qualquer parede, e TANK_RADIUS > BULLET_RADIUS.
        const boca = raycastSegment(
          { x: tank.x, y: tank.y },
          { x: bx, y: by },
          expandWalls(state.maze.walls, BULLET_RADIUS),
        );
        if (boca) {
          bx = boca.point.x + boca.normal.x * 1e-4;
          by = boca.point.y + boca.normal.y * 1e-4;
        }

        const bullet: Bullet = {
          id: `b${state.nextBulletId++}`,
          ownerId: tank.id,
          x: bx,
          y: by,
          vx: dirX * BULLET_SPEED,
          vy: dirY * BULLET_SPEED,
          bounces: 0,
          age: 0,
        };
        state.bullets.push(bullet);
        tank.fireCooldownLeft = FIRE_COOLDOWN;
        events.push({
          type: 'shot',
          ownerId: tank.id,
          bulletId: bullet.id,
          x: bx,
          y: by,
          angle: tank.turret,
          vx: bullet.vx,
          vy: bullet.vy,
          tick: state.tick,
        });
      }
    }
  }
}

/**
 * Quantas passadas de relaxamento a separação tanque×tanque faz por tick. FIXO — nada de `while`
 * até convergir: o número de iterações é parte do determinismo, e uma condição de parada baseada
 * em ponto flutuante daria contagens diferentes em máquinas diferentes. Três passadas resolvem o
 * empilhamento realista (dois tanques se empurrando contra a mesma parede); a quarta seria ruído.
 */
const TANK_SEPARATION_PASSES = 3;

// Ordem total dos tanques vivos deste tick, reaproveitada entre ticks para não alocar (mesmo
// padrão do pool de trechos de bala). A simulação é síncrona e single-thread.
const tanquesVivos: Tank[] = [];

/**
 * Separação círculo×círculo entre tanques vivos (Fase 12): até a Fase 11 dois tanques ocupavam
 * o mesmo espaço e se atravessavam — "um tank tá entrando dentro do outro".
 *
 * É separação GEOMÉTRICA, não física de impulso: cada um recua metade da penetração ao longo da
 * linha que liga os centros. Não há massa, não há quique e não há velocidade acumulada — o jogo
 * não tem inércia de tanque, e um empurrão elástico aqui viraria um segundo sistema de movimento
 * competindo com o `heading + TANK_SPEED` que recomputa a posição a cada tick.
 *
 * Roda DEPOIS do movimento e da colisão com parede, e reaplica a parede ao fim de cada passada:
 * sem isso o empurrão de um enfia o outro dentro da geometria.
 *
 * Determinismo: os pares são percorridos numa ordem total explícita pelo ID (não pela ordem de
 * inserção do `Map`, que difere entre servidor e cliente), com número FIXO de passadas.
 */
function resolveTankOverlaps(state: SimState): void {
  tanquesVivos.length = 0;
  for (const tank of state.tanks.values()) if (tank.alive) tanquesVivos.push(tank);
  if (tanquesVivos.length < 2) return;
  tanquesVivos.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const minDist = TANK_RADIUS * 2;
  const minDist2 = minDist * minDist;

  for (let pass = 0; pass < TANK_SEPARATION_PASSES; pass++) {
    for (let i = 0; i < tanquesVivos.length; i++) {
      const a = tanquesVivos[i]!;
      for (let j = i + 1; j < tanquesVivos.length; j++) {
        const b = tanquesVivos[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 >= minDist2) continue;

        const dist = Math.sqrt(dist2);
        // Centros exatamente coincidentes não têm direção de separação. O eixo X e o sinal saem
        // da ordem dos IDs, que é a mesma nas duas pontas — qualquer sorteio aqui quebraria o
        // determinismo justamente no caso degenerado.
        const nx = dist > 1e-6 ? dx / dist : 1;
        const ny = dist > 1e-6 ? dy / dist : 0;
        const meia = (minDist - dist) / 2;
        a.x -= nx * meia;
        a.y -= ny * meia;
        b.x += nx * meia;
        b.y += ny * meia;
      }
    }

    for (const tank of tanquesVivos) {
      const resolved = circleVsAabbSlide(tank, TANK_RADIUS, state.maze.walls);
      tank.x = resolved.x;
      tank.y = resolved.y;
    }
  }
}

// As paredes infladas pelo raio da bala são as MESMAS a cada tick, mas recalculá-las alocava
// ~100 objetos 60×/s por simulação — 6 mil objetos por segundo só de lixo, que era a fonte de
// GC medida na Fase 4 (engasgos esparsos de 50 ms). O cache é indexado pelo próprio array de
// paredes; `length` entra na chave porque a morte súbita remove parede com `splice`, mutando o
// array no lugar sem trocar a identidade dele.
interface ExpandedCache {
  length: number;
  walls: Aabb[];
}
const expandedWallsCache = new WeakMap<readonly Aabb[], ExpandedCache>();

function expandWalls(walls: readonly Aabb[], margin: number): readonly Aabb[] {
  const cached = expandedWallsCache.get(walls);
  if (cached && cached.length === walls.length) return cached.walls;

  const expanded = walls.map((w) => ({
    x: w.x - margin,
    y: w.y - margin,
    w: w.w + margin * 2,
    h: w.h + margin * 2,
  }));
  expandedWallsCache.set(walls, { length: walls.length, walls: expanded });
  return expanded;
}

/**
 * Trecho retilíneo percorrido por uma bala DENTRO de um tick. Uma bala que ricocheteia no meio
 * do passo produz mais de um trecho. `t0`/`t1` são instantes relativos ao início do tick, em
 * segundos — é o que permite comparar duas balas no MESMO instante, em vez de comparar duas
 * linhas soltas no espaço (ver `resolveBulletClashes`).
 */
interface PathSeg {
  t0: number;
  t1: number;
  x0: number;
  y0: number;
  vx: number;
  vy: number;
}

// Pool de trechos reaproveitado entre ticks, pela mesma razão do cache de paredes infladas
// acima: montar o caminho de cada bala a cada tick devolveria o lixo de GC que a Fase 4 eliminou.
// A simulação é síncrona e single-thread, então estado de módulo aqui é seguro.
const segPool: PathSeg[] = [];
let segTop = 0;
// Faixa [início, fim) dentro de `segPool` de cada bala sobrevivente, alinhada por índice com
// `state.bullets` logo depois de `stepBullets`.
const pathBegin: number[] = [];
const pathEnd: number[] = [];

function pushSeg(t0: number, t1: number, x0: number, y0: number, vx: number, vy: number): void {
  let seg = segPool[segTop];
  if (seg === undefined) {
    seg = { t0: 0, t1: 0, x0: 0, y0: 0, vx: 0, vy: 0 };
    segPool[segTop] = seg;
  }
  seg.t0 = t0;
  seg.t1 = t1;
  seg.x0 = x0;
  seg.y0 = y0;
  seg.vx = vx;
  seg.vy = vy;
  segTop++;
}

// CCD por bala, com "tempo restante" repassado entre reflexões dentro do mesmo tick — uma
// bala que bate perto de uma quina continua a trajetória refletida no mesmo passo em vez de
// parar encostada na parede por um tick. O limite de iterações evita loop infinito num caso
// degenerado (bala presa entre duas paredes paralelas colando).
//
// Além de mover, registra o CAMINHO de cada bala sobrevivente em `segPool`: a colisão bala×bala
// da Fase 5 precisa do trajeto inteiro do tick, não só da posição final.
function stepBullets(state: SimState, dt: number, events: SimEvent[]): void {
  const expandedWalls = expandWalls(state.maze.walls, BULLET_RADIUS);
  const remaining: Bullet[] = [];
  segTop = 0;

  for (const bullet of state.bullets) {
    bullet.age += dt;
    if (bullet.age > BULLET_LIFE) {
      // Fase 5: fim de vida deixou de ser "sumiu" e virou explosão. A posição vai no evento
      // porque é dela que o render tira o lugar do estouro.
      events.push({
        type: 'bullet_expired',
        bulletId: bullet.id,
        reason: 'life',
        x: bullet.x,
        y: bullet.y,
        tick: state.tick,
      });
      registrarExplosao(bullet.x, bullet.y, bullet.ownerId);
      continue;
    }

    const segStart = segTop;
    let elapsed = 0;
    let timeLeft = dt;
    let viva = true;
    for (let iter = 0; iter < MAX_REFLEXOES_POR_TICK && timeLeft > 0; iter++) {
      const from: Vec2 = { x: bullet.x, y: bullet.y };
      const to: Vec2 = { x: bullet.x + bullet.vx * timeLeft, y: bullet.y + bullet.vy * timeLeft };
      const hit = raycastSegment(from, to, expandedWalls);
      if (!hit) {
        pushSeg(elapsed, elapsed + timeLeft, from.x, from.y, bullet.vx, bullet.vy);
        bullet.x = to.x;
        bullet.y = to.y;
        break;
      }

      const gasto = timeLeft * hit.t;
      pushSeg(elapsed, elapsed + gasto, from.x, from.y, bullet.vx, bullet.vy);
      elapsed += gasto;

      bullet.x = hit.point.x + hit.normal.x * 1e-4;
      bullet.y = hit.point.y + hit.normal.y * 1e-4;
      const reflected = reflect({ x: bullet.vx, y: bullet.vy }, hit.normal);
      bullet.vx = reflected.x;
      bullet.vy = reflected.y;
      bullet.bounces++;
      events.push({
        type: 'bounce',
        bulletId: bullet.id,
        x: bullet.x,
        y: bullet.y,
        normal: hit.normal,
        tick: state.tick,
      });

      timeLeft *= 1 - hit.t;

      // Fase 10 (volta da regra da Fase 4): o rebote de nº MAX_BOUNCES + 1 mata a bala. Morte na
      // parede é SILENCIOSA — a explosão pedida na Fase 5 é a de fim de vida e a de choque entre
      // balas, não a de encostar na parede pela última vez.
      if (bullet.bounces > MAX_BOUNCES) {
        events.push({
          type: 'bullet_expired',
          bulletId: bullet.id,
          reason: 'max_bounces',
          x: bullet.x,
          y: bullet.y,
          tick: state.tick,
        });
        viva = false;
        break;
      }
    }

    if (viva) {
      pathBegin[remaining.length] = segStart;
      pathEnd[remaining.length] = segTop;
      remaining.push(bullet);
    } else {
      // Devolve os trechos da bala morta ao pool: as faixas precisam ficar contíguas e alinhadas
      // com os índices de `remaining` para a colisão bala×bala ler o caminho certo.
      segTop = segStart;
    }
  }

  state.bullets = remaining;
}

// Resultado da aproximação máxima entre dois caminhos, publicado em variáveis de módulo para não
// alocar (mesmo padrão do raycast em collision.ts).
let clashT = 0;
let clashX = 0;
let clashY = 0;

/**
 * Testar só a posição final deixaria duas balas se atravessarem sem detectar nada: a 215 px/s
 * com raio ~4,2 px, basta um tick de 40 ms para uma passar inteira para o outro lado da outra.
 *
 * Aqui o teste é fechado e independente do `dt`: para cada par de trechos com sobreposição de
 * TEMPO, o movimento relativo é uma reta `p + v·s`, e o mínimo de |p + v·s|² em `s ∈ [0, span]`
 * sai da derivada (`s = -p·v / v·v`, grampeado no intervalo). Se essa distância mínima cabe
 * dentro da soma dos raios, as duas ocuparam o mesmo espaço em algum instante do tick.
 *
 * O recorte por TEMPO é o que separa "se cruzaram" de "cruzaram a mesma linha em instantes
 * diferentes" — sem ele, duas balas passando pelo mesmo corredor com meio tick de diferença
 * seriam destruídas sem nunca terem se encontrado.
 */
function bulletsClash(i: number, j: number, raioSomado2: number): boolean {
  const aBegin = pathBegin[i] ?? 0;
  const aEnd = pathEnd[i] ?? 0;
  const bBegin = pathBegin[j] ?? 0;
  const bEnd = pathEnd[j] ?? 0;
  let melhorT = Infinity;

  for (let ai = aBegin; ai < aEnd; ai++) {
    const a = segPool[ai]!;
    for (let bi = bBegin; bi < bEnd; bi++) {
      const b = segPool[bi]!;
      const lo = a.t0 > b.t0 ? a.t0 : b.t0;
      const hi = a.t1 < b.t1 ? a.t1 : b.t1;
      if (hi < lo) continue;

      const ax = a.x0 + a.vx * (lo - a.t0);
      const ay = a.y0 + a.vy * (lo - a.t0);
      const bx = b.x0 + b.vx * (lo - b.t0);
      const by = b.y0 + b.vy * (lo - b.t0);
      const px = ax - bx;
      const py = ay - by;
      const vx = a.vx - b.vx;
      const vy = a.vy - b.vy;
      const span = hi - lo;
      const vv = vx * vx + vy * vy;

      let s = 0;
      if (vv > 0) {
        s = -(px * vx + py * vy) / vv;
        if (s < 0) s = 0;
        else if (s > span) s = span;
      }

      const dx = px + vx * s;
      const dy = py + vy * s;
      if (dx * dx + dy * dy > raioSomado2) continue;

      const t = lo + s;
      if (t >= melhorT) continue;
      melhorT = t;
      clashT = t;
      clashX = (ax + a.vx * s + bx + b.vx * s) / 2;
      clashY = (ay + a.vy * s + by + b.vy * s) / 2;
    }
  }

  return melhorT < Infinity;
}

interface ClashPair {
  i: number;
  j: number;
  t: number;
  x: number;
  y: number;
}
const clashPool: ClashPair[] = [];
let clashCount = 0;

/**
 * Bala×bala (decisão do usuário na Fase 5, revertendo o "balas se atravessam"): se duas se
 * cruzam, as duas explodem — inclusive as do mesmo dono, porque regra sem exceção é a que o
 * jogador consegue prever olhando para a tela.
 *
 * Determinismo: todos os pares são levantados ANTES de qualquer remoção e resolvidos numa ordem
 * total explícita (instante do encontro, depois id das balas). Assim nem a ordem do array nem a
 * ordem de chegada dos `bullet_spawn` no cliente mudam o resultado.
 */
function resolveBulletClashes(state: SimState, events: SimEvent[]): void {
  const n = state.bullets.length;
  if (n < 2) return;

  const raioSomado = BULLET_RADIUS * 2;
  const raioSomado2 = raioSomado * raioSomado;
  clashCount = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!bulletsClash(i, j, raioSomado2)) continue;
      let par = clashPool[clashCount];
      if (par === undefined) {
        par = { i: 0, j: 0, t: 0, x: 0, y: 0 };
        clashPool[clashCount] = par;
      }
      // Par guardado com os índices na ordem do ID, não na ordem do array: é o que faz o evento
      // (`aId`/`bId`) e o critério de desempate saírem iguais nas duas pontas, mesmo que os
      // `bullet_spawn` tenham chegado em ordens diferentes no cliente.
      const trocar = state.bullets[i]!.id > state.bullets[j]!.id;
      par.i = trocar ? j : i;
      par.j = trocar ? i : j;
      par.t = clashT;
      par.x = clashX;
      par.y = clashY;
      clashCount++;
    }
  }

  if (clashCount === 0) return;

  const ordem = clashPool.slice(0, clashCount);
  ordem.sort((p, q) => {
    if (p.t !== q.t) return p.t - q.t;
    const pa = state.bullets[p.i]!.id;
    const qa = state.bullets[q.i]!.id;
    if (pa !== qa) return pa < qa ? -1 : 1;
    const pb = state.bullets[p.j]!.id;
    const qb = state.bullets[q.j]!.id;
    return pb < qb ? -1 : pb > qb ? 1 : 0;
  });

  const mortas = new Set<string>();
  for (const par of ordem) {
    const a = state.bullets[par.i]!;
    const b = state.bullets[par.j]!;
    // Uma bala explode uma vez só: se já morreu num encontro anterior deste mesmo tick, o par
    // seguinte que a envolve simplesmente não acontece.
    if (mortas.has(a.id) || mortas.has(b.id)) continue;
    mortas.add(a.id);
    mortas.add(b.id);
    events.push({ type: 'bullet_clash', aId: a.id, bId: b.id, x: par.x, y: par.y, tick: state.tick });
    registrarExplosao(par.x, par.y, a.ownerId);
    registrarExplosao(par.x, par.y, b.ownerId);
  }

  state.bullets = state.bullets.filter((bala) => !mortas.has(bala.id));
}

// Bala×tanque mata em 1 toque. O dono só é atingido pela própria bala depois de SELF_IMMUNITY.
// Bala×bala é resolvido antes daqui, em `resolveBulletClashes` — uma bala que se chocou com
// outra já saiu de `state.bullets` e não chega a matar ninguém neste tick.
function resolveBulletTankHits(state: SimState, events: SimEvent[]): void {
  const hitBulletIds = new Set<string>();
  const hitRadius = TANK_RADIUS + BULLET_RADIUS;

  for (const tank of state.tanks.values()) {
    if (!tank.alive) continue;
    for (const bullet of state.bullets) {
      if (hitBulletIds.has(bullet.id)) continue;
      if (bullet.ownerId === tank.id && bullet.age < SELF_IMMUNITY) continue;

      const dx = bullet.x - tank.x;
      const dy = bullet.y - tank.y;
      if (dx * dx + dy * dy > hitRadius * hitRadius) continue;

      tank.alive = false;
      hitBulletIds.add(bullet.id);
      events.push({
        type: 'death',
        victimId: tank.id,
        killerId: bullet.ownerId,
        x: tank.x,
        y: tank.y,
        tick: state.tick,
        autogol: bullet.ownerId === tank.id,
      });
      break;
    }
  }

  if (hitBulletIds.size > 0) {
    state.bullets = state.bullets.filter((b) => !hitBulletIds.has(b.id));
  }
}

/**
 * ÚNICO PONTO que decide se a explosão de bala machuca alguém.
 *
 * Decisão do coordenador na Fase 5: a explosão (fim de vida e choque bala×bala) é PURAMENTE
 * COSMÉTICA — leitura conservadora do pedido do usuário, que falou em "explodir" sem falar em
 * dano. Para torná-la letal basta trocar esta linha para `true`: `aplicarExplosoes` abaixo já
 * mata todo tanque dentro de `BULLET_EXPLOSION_RADIUS` do ponto do estouro, atribuindo a morte
 * ao dono da bala (e marcando autogol quando for o próprio).
 */
const EXPLOSAO_DE_BALA_E_LETAL: boolean = false;

interface Explosao {
  x: number;
  y: number;
  ownerId: string;
}
const explosaoPool: Explosao[] = [];
let explosaoCount = 0;

/** Anota um estouro do tick. Uma bala que explode no choque registra o ponto de encontro. */
function registrarExplosao(x: number, y: number, ownerId: string): void {
  let e = explosaoPool[explosaoCount];
  if (e === undefined) {
    e = { x: 0, y: 0, ownerId: '' };
    explosaoPool[explosaoCount] = e;
  }
  e.x = x;
  e.y = y;
  e.ownerId = ownerId;
  explosaoCount++;
}

function aplicarExplosoes(state: SimState, events: SimEvent[]): void {
  if (!EXPLOSAO_DE_BALA_E_LETAL) {
    explosaoCount = 0;
    return;
  }

  const raio2 = BULLET_EXPLOSION_RADIUS * BULLET_EXPLOSION_RADIUS;
  for (let i = 0; i < explosaoCount; i++) {
    const e = explosaoPool[i]!;
    for (const tank of state.tanks.values()) {
      if (!tank.alive) continue;
      const dx = tank.x - e.x;
      const dy = tank.y - e.y;
      if (dx * dx + dy * dy > raio2) continue;
      tank.alive = false;
      events.push({
        type: 'death',
        victimId: tank.id,
        killerId: e.ownerId,
        x: tank.x,
        y: tank.y,
        tick: state.tick,
        autogol: e.ownerId === tank.id,
      });
    }
  }
  explosaoCount = 0;
}

// Um tick da simulação. Puro em relação a aleatoriedade: nenhuma decisão usa RNG não semeado,
// e dt é sempre recebido de fora (nunca Date.now()/deltaMS do ticker).
export function step(state: SimState, inputs: Map<string, Input>, dt: number): SimEvent[] {
  const events: SimEvent[] = [];
  explosaoCount = 0;
  stepTanks(state, inputs, dt, events);
  resolveTankOverlaps(state);
  stepBullets(state, dt, events);
  resolveBulletClashes(state, events);
  resolveBulletTankHits(state, events);
  aplicarExplosoes(state, events);
  return events;
}
