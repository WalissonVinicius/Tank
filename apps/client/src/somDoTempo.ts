// Contagem sonora dos últimos segundos da rodada (Fase 10 §4: "tem que ter um som quando tiver
// acabando").
//
// Fica fora do `main.ts` por dois motivos: os dois modos (local e online) precisam exatamente da
// mesma regra, e a regra é testável sem navegador — é só um relógio contra o último segundo já
// anunciado. Quem decide se o som SAI (aba oculta, contexto suspenso, jogo fora de partida) é o
// `tocar()` de `audio.ts`; aqui só se decide QUANDO pedir.

/** A partir de quantos segundos restantes o relógio começa a tiquetaquear. */
export const AVISO_TEMPO_S = 10;

/**
 * Tique de um segundo. O tom SOBE conforme o tempo acaba (620 Hz faltando 10 s → 1160 Hz faltando
 * 1 s) e o volume vai junto: é a mesma informação do relógio da tela, chegando pelo ouvido.
 */
export function somDoTique(segundosRestantes: number): number[] {
  const bruto = (AVISO_TEMPO_S - segundosRestantes) / (AVISO_TEMPO_S - 1);
  const p = bruto < 0 ? 0 : bruto > 1 ? 1 : bruto; // 0 no primeiro tique, 1 no último
  return [0.5 + p * 0.5, 0, 620 + p * 540, 0.005, 0.03, 0.05 + p * 0.03, 0, 1.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.55, 0.02];
}

/** Buzina do fim do tempo — grave, longa e com queda de tom. Não se confunde com o tique. */
export const SOM_TEMPO_ESGOTADO: readonly number[] = [
  1.3, 0, 190, 0.02, 0.24, 0.4, 1, 2.2, -3.5, 0, 0, 0, 0.05, 0.2, 0, 0.1, 0.05, 0.55, 0.16,
];

export interface ContagemSonora {
  /** Chamada a cada frame com o relógio da rodada. Dispara um tique por segundo no fim. */
  acompanhar(timeLeft: number, emRodada: boolean): void;
  /**
   * Buzina de fim de tempo, no máximo uma por rodada.
   *
   * Existe separada porque nenhum dos dois modos entrega de forma confiável um frame com
   * `timeLeft === 0` AINDA em jogo: no local o `encerrarRodada` roda no mesmo tick em que o
   * relógio cruza o zero, e no online o servidor já troca a fase para `roundend` no tick em que
   * zera. Sem este gancho explícito o último som da rodada simplesmente nunca sairia.
   */
  fimDoTempo(): void;
}

/**
 * Cria a contagem. O estado guardado é o último segundo já anunciado, e não um temporizador
 * próprio: assim o áudio segue o MESMO relógio que a tela desenha (o `timeLeft` do servidor no
 * online, o acumulador de passo fixo no local) e nunca desanda em relação a ele. Sair da rodada —
 * ou o relógio voltar para cima do limiar — rearma o estado, então a rodada seguinte conta do 10.
 */
export function criarContagemSonora(tocar: (som: readonly number[]) => void): ContagemSonora {
  let ultimoSegundo = -1;

  const anunciar = (s: number): void => {
    if (s === ultimoSegundo) return;
    ultimoSegundo = s;
    tocar(s === 0 ? SOM_TEMPO_ESGOTADO : somDoTique(s));
  };

  return {
    acompanhar(timeLeft: number, emRodada: boolean): void {
      if (!emRodada) {
        ultimoSegundo = -1;
        return;
      }
      const s = Math.max(0, Math.ceil(timeLeft));
      if (s > AVISO_TEMPO_S) {
        ultimoSegundo = -1;
        return;
      }
      anunciar(s);
    },
    fimDoTempo(): void {
      anunciar(0);
    },
  };
}
