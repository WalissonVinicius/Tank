// Power-ups temporários que nascem pela arena durante a rodada (P1) — tuning, identidade visual
// e fonte única da verdade para servidor, cliente e simulação.
//
// A REGRA QUE ORGANIZA TUDO ESTÁ AQUI, e não é estilo: só UM dos efeitos mexe na FÍSICA DA BALA
// (`ricochete`). Como a bala não trafega pela rede — o servidor manda `bullet_spawn` e cada
// cliente simula a trajetória localmente com o mesmo código —, esse efeito é CARIMBADO NA BALA no
// instante do disparo e viaja com ela em `BulletSpawnMsg.ricochete`. Nunca é lido do estado do
// atirador na hora de simular: uma bala disparada com ricochete duplo continua com ricochete
// duplo depois de o efeito expirar no dono, porque o número mora na bala.
//
// Os outros três (`municao`, `recarga`, `turbo`) mudam só o TANQUE, cuja posição vem do snapshot
// autoritativo do servidor. Esses não têm como divergir e por isso não viajam por bala.
//
// Escudo ficou de fora de propósito. Ele é o único da lista de sugestões que REMOVE risco em vez
// de acrescentar, e o risco que ele removeria é justamente o autogol — a alma do jogo. "Poder vem
// com risco" é o princípio de equilíbrio pedido; os quatro abaixo cobram alguma coisa.

export type TipoPowerUp = 'ricochete' | 'municao' | 'recarga' | 'turbo';

/** Ordem canônica — é ela que o saco de sorteio embaralha, então mexer aqui muda as agendas. */
export const TIPOS_DE_POWERUP: readonly TipoPowerUp[] = ['ricochete', 'municao', 'recarga', 'turbo'];

export interface PowerUpDef {
  tipo: TipoPowerUp;
  /** Nome cheio — aviso de coleta e legenda. */
  nome: string;
  /** Etiqueta curta do HUD e do crachá sobre o tanque. */
  curto: string;
  /** Cor de acento: símbolo do item, contorno do crachá e barra do HUD. */
  cor: number;
  /** Duração do efeito, em segundos. Faixa da spec: 8–12 s numa rodada de 11–22 s. */
  duracao: number;
  /** Quanto o efeito escreve no campo correspondente do tanque (ver `Tank` em shared-sim). */
  valor: number;
  /** O que ele dá E o que ele cobra — todo item da lista tem os dois lados. */
  risco: string;
}

export const POWERUP: Record<TipoPowerUp, PowerUpDef> = {
  // O mais forte e o mais perigoso: dobra o alcance do ricochete e dobra junto a chance de a
  // bala voltar na cara de quem atirou. É a assinatura do jogo virada para cima.
  ricochete: {
    tipo: 'ricochete',
    nome: 'RICOCHETE DUPLO',
    curto: 'RICOCHETE',
    cor: 0xffd84d,
    duracao: 9,
    valor: 1,
    risco: 'a bala quica 2× em vez de 1 — mata mais e se mata mais',
  },
  municao: {
    tipo: 'municao',
    nome: 'MUNIÇÃO EXTRA',
    curto: 'MUNIÇÃO',
    cor: 0x6bd6ff,
    duracao: 12,
    valor: 1,
    risco: '+1 bala simultânea — mais bala sua na arena é mais bala sua para pisar',
  },
  recarga: {
    tipo: 'recarga',
    nome: 'RECARGA RÁPIDA',
    curto: 'RECARGA',
    cor: 0xff8c42,
    duracao: 10,
    valor: 0.5,
    risco: 'cadência na metade do tempo — o corredor enche do seu próprio tiro',
  },
  turbo: {
    tipo: 'turbo',
    nome: 'TURBO',
    curto: 'TURBO',
    cor: 0x7cff6b,
    duracao: 10,
    valor: 0.35,
    risco: '+35% de velocidade — chega antes, inclusive na frente da própria bala',
  },
};

// -------------------------------------------------------------------------------------------
// Nascimento — tudo em SEGUNDOS aqui; quem converte para tick é `agendaDePowerUps` em shared-sim.
// -------------------------------------------------------------------------------------------

/** Espera até o primeiro item da rodada. Depois do "VAI!", com todo mundo já fora do spawn. */
export const POWERUP_PRIMEIRO_S = 4;
/** Ritmo dos nascimentos seguintes. */
export const POWERUP_INTERVALO_S = 6;
/** Jitter (±) sorteado do RNG semeado em cima do ritmo — o QUANDO também sai da seed. */
export const POWERUP_JITTER_S = 1;
/** Quanto tempo o item espera por alguém antes de sumir sozinho. */
export const POWERUP_VIDA_NO_MAPA_S = 11;
/**
 * Teto de itens no chão ao mesmo tempo. Com intervalo 6 s e vida 11 s a conta natural dá ~2; o 3
 * é folga para o jitter, não meta. Mais que isso e a arena de 8×8 vira tabuleiro de coleta.
 */
export const POWERUP_MAX_NO_CHAO = 3;
/**
 * Raio de colisão do item, em px. O disco desenhado tem ~30 px de diâmetro: acima da bala
 * (19,2 px) e abaixo do tanque (37 px), que é a hierarquia pedida — óbvio de relance, sem
 * disputar o primeiro plano com quem atira e com o que mata.
 */
export const POWERUP_RAIO = 15;
/**
 * Teto do bônus de rebote que uma bala pode carregar. Existe só para dimensionar a folga do laço
 * de reflexões por tick em `sim.ts` — o valor real de cada bala vem carimbado nela.
 */
export const POWERUP_MAX_RICOCHETE_EXTRA = 1;
