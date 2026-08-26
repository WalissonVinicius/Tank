// As frases de zoeira do jogo (relatório G §5.4) e onde elas passam a aparecer.
//
// Fase 8 §3: elas SAÍRAM do killfeed — durante a ação o feed é só `Matador ✕ Vítima`, porque ler
// uma piada de duas linhas no meio de um tiroteio custa atenção que o jogador não tem. As frases
// continuam existindo: viram DESTAQUE na tela de fim de rodada (1 ou 2 mortes da rodada) e na
// tela de vencedor (os melhores momentos da partida), onde todo mundo está parado lendo.
//
// O sorteio usa `Math.random()` de propósito: isto é texto de UI, não simulação — nada aqui entra
// no estado autoritativo nem precisa ser determinístico entre clientes.

export interface Ator {
  name: string;
  color: number;
}

const FRASES_AUTOGOL = [
  '{v} testemunhou a própria bala fazer o L',
  '{v} devia ter estudado geometria',
  '{v} tentou intimidar a parede e perdeu',
  '{v} provou que ricochete não escolhe lado',
];
const FRASES_KILL_RICOCHETE = [
  '{k} fez a bala dar a volta por trás de {v}',
  '{v} não viu a curva chegando de {k}',
  '{k} calculou o ângulo e {v} pagou a conta',
  '{v} achou que a parede era aliada — não era, cortesia de {k}',
];
const FRASES_KILL_DIRETO = [
  '{k} não deu chance pra física ajudar {v}',
  '{v} foi apagado por {k} sem escalas',
  '{k} encontrou {v} no pior corredor possível',
];
const FRASES_EMPATE = [
  'Ninguém teve coragem de sair de trás da parede',
  'O labirinto venceu essa rodada sozinho',
  'Todo mundo travou — a sala decidiu por eles',
];
const FRASES_KILL_DUPLO = [
  '{k} e {v} se entenderam ao mesmo tempo — e explodiram juntos',
  'Ninguém foi mais rápido — os dois pagaram o preço',
];

/**
 * Linhas do carimbo de AUTOGOL (V2 §2) — as únicas frases de zoeira que aparecem DURANTE a ação.
 *
 * Elas cabem aqui, e as outras não, porque o carimbo é do próprio jogador sobre a própria morte:
 * ele acabou de perder o controle do tanque e não tem mais nada para ler na tela. É a exceção que
 * a Fase 8 §3 abriu quando tirou a zoeira do killfeed.
 */
const CARIMBOS_AUTOGOL = [
  'a bala voltou pra casa',
  'obra sua, ninguém ajudou',
  'o ricochete não perdoa',
  'foi você mesmo, sim',
  'a parede só devolveu',
];

function sorteia<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function css(color: number): string {
  return '#' + (color >>> 0).toString(16).padStart(6, '0');
}

export function nomeColorido(p: Ator): string {
  return `<b style="color:${css(p.color)}">${p.name}</b>`;
}

function fmt(frase: string, k: Ator | undefined, v: Ator | undefined): string {
  return frase.replace('{k}', k ? nomeColorido(k) : '').replace('{v}', v ? nomeColorido(v) : '');
}

/** Prioridade do destaque na hora de escolher o que mostrar: autogol > duplo > ricochete > direto. */
export type PesoDestaque = 3 | 2 | 1 | 0;

export interface Destaque {
  html: string;
  peso: PesoDestaque;
}

export function destaqueAutogol(v: Ator): Destaque {
  return { html: fmt(sorteia(FRASES_AUTOGOL), undefined, v), peso: 3 };
}

export function destaqueDuplo(a: Ator, b: Ator): Destaque {
  return { html: fmt(sorteia(FRASES_KILL_DUPLO), a, b), peso: 2 };
}

export function destaqueKill(k: Ator, v: Ator, ricochete: boolean): Destaque {
  return ricochete
    ? { html: fmt(sorteia(FRASES_KILL_RICOCHETE), k, v), peso: 1 }
    : { html: fmt(sorteia(FRASES_KILL_DIRETO), k, v), peso: 0 };
}

/** Uma linha curta para o carimbo de autogol do jogador local. */
export function carimboDeAutogol(): string {
  return sorteia(CARIMBOS_AUTOGOL);
}

export function fraseEmpate(): string {
  return sorteia(FRASES_EMPATE);
}

/**
 * Escolhe os melhores destaques de um lote. Ordena por peso (autogol na frente — é a piada
 * central do jogo) mantendo, dentro do mesmo peso, a ordem em que aconteceram.
 */
export function melhoresDestaques(lote: readonly Destaque[], quantos: number): string[] {
  return [...lote]
    .map((d, i) => ({ d, i }))
    .sort((a, b) => b.d.peso - a.d.peso || a.i - b.i)
    .slice(0, quantos)
    .map((x) => x.d.html);
}
