// Power-ups temporários pela arena (P1) — nascimento determinístico, arbitragem da coleta e
// relógio dos efeitos. Matemática pura como o resto de `shared-sim`: nenhum `Math.random()`,
// nenhum relógio de parede, `dt` sempre recebido de fora.
//
// Este arquivo é NOVO de propósito. A alternativa era engordar `step()` com um quinto sistema, e
// `sim.ts` está sendo portado para Go em paralelo — o que entrou lá foram cinco leituras de campo
// aditivo (ver `Tank` e `Bullet` em types.ts), e mais nada. A gestão dos itens mora aqui e é
// chamada pelo HOST da simulação (o `TankRoom` no online, o `main.ts` no modo local), nunca de
// dentro de `step()`.
//
// A DIVISÃO DE PODER, que é o que faz isto funcionar em rede:
//   · o NASCIMENTO (onde, quando, qual tipo) sai do RNG semeado da rodada — cliente e servidor
//     chegam à mesma agenda sem trocar um byte, igual ao labirinto e aos spawns;
//   · QUEM PEGOU é decisão exclusiva do servidor, e vira evento como a morte. Dois tanques podem
//     encostar no mesmo item no mesmo tick, e cliente nenhum arbitra isso sozinho.

import {
  POWERUP,
  POWERUP_INTERVALO_S,
  POWERUP_JITTER_S,
  POWERUP_MAX_NO_CHAO,
  POWERUP_PRIMEIRO_S,
  POWERUP_RAIO,
  POWERUP_VIDA_NO_MAPA_S,
  TANK_RADIUS,
  TICK_HZ,
  TIPOS_DE_POWERUP,
  type TipoPowerUp,
} from '@tank/protocol';
import { cellCenter } from './maze.js';
import { mulberry32 } from './rng.js';
import type { Maze, SimState, Tank } from './types.js';

/** Um item da agenda da rodada. Imutável depois de gerado. */
export interface ItemDePowerUp {
  /** Índice na agenda — é a identidade do item na rede (`PowerupTakenMsg.itemId`). */
  id: number;
  tipo: TipoPowerUp;
  x: number;
  y: number;
  /** Tick da rodada em que ele aparece no chão. */
  nasceEmTick: number;
  /** Tick em que ele some sozinho, se ninguém tiver pegado. */
  sumeEmTick: number;
}

export interface ColetaDePowerUp {
  itemId: number;
  tipo: TipoPowerUp;
  tankId: string;
  x: number;
  y: number;
}

/**
 * Quantos itens a agenda cobre. `ROUND_TIMEOUT` é 45 s, mas a morte súbita pode esticar a rodada
 * além disso — 20 itens cobrem ~2 min de jogo e custam 20 objetos por rodada, então não vale
 * apertar. O que não chega a nascer simplesmente nunca sai da lista.
 */
const ITENS_POR_RODADA = 20;

/** Distância mínima, em células, entre dois itens consecutivos da agenda. */
const CELULAS_DE_FOLGA = 2;

/** Tentativas de sorteio de célula por item. FIXO — ver o comentário dentro do laço. */
const TENTATIVAS_DE_CELULA = 8;

/**
 * A agenda da rodada: mesma seed produz os mesmos itens, nos mesmos lugares, nos mesmos ticks.
 *
 * O RNG é PRÓPRIO, derivado da seed, e não o mesmo objeto que gera labirinto e spawns. Se
 * consumisse daquela sequência, a agenda mudaria conforme o número de jogadores da sala (que
 * decide quantos spawns são sorteados antes dela) e quem entrasse no meio da partida montaria uma
 * arena diferente da dos outros.
 */
export function agendaDePowerUps(maze: Maze, seed: number): ItemDePowerUp[] {
  const rng = mulberry32((seed ^ 0x5f356495) >>> 0);
  const itens: ItemDePowerUp[] = [];

  // Saco de sorteio em vez de escolha solta: os quatro tipos saem antes de qualquer um repetir.
  // Sorteio independente daria três ricochetes seguidos com facilidade, e a rodada em que isso
  // acontece é outra rodada.
  const saco: TipoPowerUp[] = [];
  const proximoTipo = (): TipoPowerUp => {
    if (saco.length === 0) saco.push(...rng.shuffle([...TIPOS_DE_POWERUP]));
    return saco.pop()!;
  };

  const folga = CELULAS_DE_FOLGA * maze.cell;
  let anteriorX = Number.NaN;
  let anteriorY = Number.NaN;

  for (let i = 0; i < ITENS_POR_RODADA; i++) {
    // O QUANDO também sai da seed: ritmo fixo com jitter sorteado. `Math.round` fecha num tick
    // inteiro idêntico nas duas pontas, sem depender de como cada uma acumula segundos.
    const segundos = POWERUP_PRIMEIRO_S + i * POWERUP_INTERVALO_S + (rng.next() * 2 - 1) * POWERUP_JITTER_S;
    const nasceEmTick = Math.round(segundos * TICK_HZ);

    // Célula sorteada, rejeitando as coladas no item anterior — dois itens em corredores vizinhos
    // viram uma coleta dupla de graça em vez de duas decisões de posição. Número FIXO de
    // tentativas: um laço "até achar" consumiria uma quantidade variável de RNG, e a agenda
    // passaria a depender da geometria de cada labirinto para continuar reproduzível.
    let x = 0;
    let y = 0;
    for (let tentativa = 0; tentativa < TENTATIVAS_DE_CELULA; tentativa++) {
      const centro = cellCenter(maze, rng.int(maze.cols), rng.int(maze.rows));
      x = centro.x;
      y = centro.y;
      if (Number.isNaN(anteriorX) || Math.hypot(x - anteriorX, y - anteriorY) >= folga) break;
    }
    anteriorX = x;
    anteriorY = y;

    itens.push({
      id: i,
      tipo: proximoTipo(),
      x,
      y,
      nasceEmTick,
      sumeEmTick: nasceEmTick + Math.round(POWERUP_VIDA_NO_MAPA_S * TICK_HZ),
    });
  }

  return itens;
}

/**
 * Os itens de uma rodada e o que já saiu do chão.
 *
 * As DUAS pontas instanciam esta classe com a mesma seed. O servidor chama `coletar()`; o cliente
 * nunca — lá ela existe só para saber o que desenhar, e o `powerup_taken` que chega pela rede
 * entra por `marcarPego()`.
 */
export class CampoDePowerUps {
  readonly agenda: readonly ItemDePowerUp[];
  private readonly pegos = new Set<number>();
  private readonly visiveis: ItemDePowerUp[] = [];
  private readonly coletas: ColetaDePowerUp[] = [];

  constructor(maze: Maze, seed: number) {
    this.agenda = agendaDePowerUps(maze, seed);
  }

  private estaNoChao(item: ItemDePowerUp, tick: number): boolean {
    return item.nasceEmTick <= tick && item.sumeEmTick > tick && !this.pegos.has(item.id);
  }

  /**
   * Itens no chão neste tick. O array é REAPROVEITADO entre chamadas (mesmo padrão do pool de
   * trechos de bala em sim.ts): vale até a próxima chamada, não guarde a referência.
   */
  noChao(tick: number): readonly ItemDePowerUp[] {
    this.visiveis.length = 0;
    for (const item of this.agenda) {
      // A agenda é crescente em tick: o primeiro que ainda não nasceu encerra a varredura.
      if (item.nasceEmTick > tick) break;
      if (!this.estaNoChao(item, tick)) continue;
      this.visiveis.push(item);
      if (this.visiveis.length >= POWERUP_MAX_NO_CHAO) break;
    }
    return this.visiveis;
  }

  /** Tira o item do chão. Chamado pelo servidor ao arbitrar e pelo cliente ao receber o evento. */
  marcarPego(id: number): void {
    this.pegos.add(id);
  }

  /**
   * SÓ O HOST CHAMA. Decide quem encostou em quê neste tick e já tira os itens do chão.
   *
   * Empate resolvido por distância ao centro do item e, se ela empatar, pelo id do tanque — nunca
   * pela ordem do `Map`, que difere entre servidor e cliente. Um mesmo tanque pode levar dois
   * itens no mesmo tick; um mesmo item nunca vai para dois tanques.
   */
  coletar(state: SimState, tick: number): readonly ColetaDePowerUp[] {
    this.coletas.length = 0;
    const raio = TANK_RADIUS + POWERUP_RAIO;
    const raio2 = raio * raio;

    for (const item of this.agenda) {
      if (item.nasceEmTick > tick) break;
      if (!this.estaNoChao(item, tick)) continue;

      let dono: Tank | null = null;
      let menorDist2 = Infinity;
      for (const tank of state.tanks.values()) {
        if (!tank.alive) continue;
        const dx = tank.x - item.x;
        const dy = tank.y - item.y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 > raio2) continue;
        if (dist2 < menorDist2 || (dist2 === menorDist2 && dono !== null && tank.id < dono.id)) {
          menorDist2 = dist2;
          dono = tank;
        }
      }
      if (!dono) continue;

      this.pegos.add(item.id);
      this.coletas.push({ itemId: item.id, tipo: item.tipo, tankId: dono.id, x: item.x, y: item.y });
    }

    return this.coletas;
  }
}

export interface EfeitoAtivo {
  tipo: TipoPowerUp;
  /** Segundos que faltam. */
  restante: number;
  /** Duração cheia, para o HUD desenhar a fração sem consultar a tabela. */
  duracao: number;
}

export interface FimDeEfeito {
  tankId: string;
  tipo: TipoPowerUp;
}

/** Escreve (ou apaga, com `valor` 0) o bônus no campo correspondente do tanque. */
function escreverNoTanque(tank: Tank, tipo: TipoPowerUp, valor: number): void {
  switch (tipo) {
    case 'ricochete':
      tank.ricochete = valor;
      break;
    case 'municao':
      tank.municao = valor;
      break;
    case 'recarga':
      tank.recarga = valor;
      break;
    case 'turbo':
      tank.turbo = valor;
      break;
  }
}

/**
 * Os relógios dos efeitos ativos — o ÚNICO lugar que liga e desliga os campos de power-up do
 * `Tank`. Vive no host da simulação, ao lado do `CampoDePowerUps`.
 */
export class EfeitosDePowerUp {
  private readonly porTanque = new Map<string, EfeitoAtivo[]>();
  /**
   * Só os tipos, um array POR TANQUE, para o crachá do render. Um array único compartilhado não
   * serviria: o `RenderView` de um frame guarda a referência de todos os tanques ao mesmo tempo,
   * e todos acabariam apontando para o conteúdo do último.
   */
  private readonly tiposPorTanque = new Map<string, TipoPowerUp[]>();
  private readonly fins: FimDeEfeito[] = [];
  private readonly vazio: readonly EfeitoAtivo[] = [];
  private readonly vazioTipos: readonly TipoPowerUp[] = [];

  /** Liga o efeito no tanque. Pegar o mesmo tipo de novo RENOVA o relógio, nunca empilha. */
  aplicar(tank: Tank, tipo: TipoPowerUp): void {
    const def = POWERUP[tipo];
    let lista = this.porTanque.get(tank.id);
    if (!lista) {
      lista = [];
      this.porTanque.set(tank.id, lista);
    }

    // Empilhar somaria dois ricochetes e a bala passaria a quicar três vezes — a arena vira
    // pinball e o teto do efeito, que é parte do equilíbrio, deixa de existir.
    const existente = lista.find((e) => e.tipo === tipo);
    if (existente) {
      existente.restante = def.duracao;
    } else {
      lista.push({ tipo, restante: def.duracao, duracao: def.duracao });
      this.recomputarTipos(tank.id, lista);
    }

    escreverNoTanque(tank, tipo, def.valor);
  }

  private recomputarTipos(tankId: string, lista: readonly EfeitoAtivo[]): void {
    let tipos = this.tiposPorTanque.get(tankId);
    if (!tipos) {
      tipos = [];
      this.tiposPorTanque.set(tankId, tipos);
    }
    tipos.length = 0;
    for (const efeito of lista) tipos.push(efeito.tipo);
  }

  /**
   * Um passo dos relógios. Devolve o que acabou NESTE passo, com o campo do tanque já apagado —
   * o host só precisa avisar a rede.
   *
   * Bala já disparada não é tocada: o ricochete dela está carimbado nela, e é assim que uma bala
   * com ricochete duplo sobrevive ao fim do efeito no dono.
   */
  passo(tanks: Map<string, Tank>, dt: number): readonly FimDeEfeito[] {
    this.fins.length = 0;

    for (const [tankId, lista] of this.porTanque) {
      const tank = tanks.get(tankId);
      let mudou = false;
      for (let i = lista.length - 1; i >= 0; i--) {
        const efeito = lista[i]!;
        efeito.restante -= dt;
        // Morrer também encerra: voltar vivo na rodada seguinte com ricochete sobrando seria
        // vantagem herdada de uma rodada que já acabou para aquele tanque.
        if (efeito.restante > 0 && tank?.alive === true) continue;
        lista.splice(i, 1);
        if (tank) escreverNoTanque(tank, efeito.tipo, 0);
        this.fins.push({ tankId, tipo: efeito.tipo });
        mudou = true;
      }
      if (mudou) this.recomputarTipos(tankId, lista);
      if (lista.length === 0) {
        this.porTanque.delete(tankId);
        this.tiposPorTanque.delete(tankId);
      }
    }

    return this.fins;
  }

  /** Efeitos ativos de um tanque. Array interno — leitura por frame, não guarde a referência. */
  ativos(tankId: string): readonly EfeitoAtivo[] {
    return this.porTanque.get(tankId) ?? this.vazio;
  }

  /** Só os tipos, que é o que o crachá sobre o tanque precisa. */
  tiposAtivos(tankId: string): readonly TipoPowerUp[] {
    return this.tiposPorTanque.get(tankId) ?? this.vazioTipos;
  }

  /** Rodada nova: nenhum efeito atravessa a virada. */
  limpar(): void {
    this.porTanque.clear();
    this.tiposPorTanque.clear();
  }
}
