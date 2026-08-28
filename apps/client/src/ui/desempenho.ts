// Painel de desempenho do canto superior direito (O1).
//
// Duas coisas moram aqui, e as duas existem pela mesma razão: o jogo passou a MEXER na própria
// qualidade sozinho, e mudança de aparência sem explicação é a pior interface possível.
//
//  1. O contador de FPS — pedido do dono. Fica sempre em cena, discreto, e diz junto em que
//     degrau de pós-processamento o jogo está quando ele NÃO é o cheio. É a resposta visível para
//     "por que a imagem mudou".
//  2. O aviso de renderização por software — quando o `UNMASKED_RENDERER_WEBGL` entrega
//     SwiftShader (ou parente), o gargalo não é o jogo: é aceleração por hardware desligada no
//     navegador. Nesse caso nenhum degrau salva (medimos 2 fps em produção), então o texto é
//     acionável em vez de decorativo.
//
// É DOM por cima do canvas, como todo o resto do HUD — nada disto passa pelo Pixi.

import type { NivelFx } from '../render/post.js';

/** Intervalo entre atualizações do número. Texto piscando a 60 Hz é ilegível e ainda custa DOM. */
const PASSO_MS = 500;
/** Abaixo disto o número fica vermelho: a partida deixou de ser jogável de verdade. */
const FPS_RUIM = 30;
/** Entre este e o anterior o número fica amarelo. */
const FPS_MEDIO = 50;

const ROTULO: Record<NivelFx, string> = {
  alto: '',
  reduzido: 'FX REDUZIDO',
  minimo: 'FX MÍNIMO',
  desligado: 'FX DESLIGADO',
};

export interface PainelDeDesempenho {
  /** Uma vez por frame, com o relógio de tempo real. */
  quadro(agoraMs: number): void;
  /** Degrau atual — acende o rótulo ao lado do número, e só quando não é a qualidade cheia. */
  setNivel(nivel: NivelFx): void;
  /** Liga o aviso de aceleração por hardware desligada. Só some se o jogador fechar. */
  avisarSoftware(): void;
}

export function montarPainelDeDesempenho(pai: HTMLElement): PainelDeDesempenho {
  const raiz = document.createElement('div');
  raiz.id = 'desempenho';
  raiz.innerHTML = `
    <div class="medidor">
      <i id="desempenho-degrau" hidden></i>
      <b id="desempenho-fps">--</b><span>FPS</span>
    </div>
    <div class="aviso" id="desempenho-aviso" hidden>
      <b>SEM ACELERAÇÃO DE VÍDEO</b>
      <p>O navegador está desenhando sem placa de vídeo e o jogo fica lento. Ligue
      <em>"Usar aceleração de hardware quando disponível"</em> nas configurações do navegador e
      reinicie.</p>
      <button type="button" id="desempenho-aviso-ok">ENTENDI</button>
    </div>
  `;
  pai.appendChild(raiz);

  const numero = raiz.querySelector('#desempenho-fps') as HTMLElement;
  const degrau = raiz.querySelector('#desempenho-degrau') as HTMLElement;
  const aviso = raiz.querySelector('#desempenho-aviso') as HTMLElement;
  (raiz.querySelector('#desempenho-aviso-ok') as HTMLButtonElement).addEventListener('click', () => {
    aviso.hidden = true;
  });

  // O killfeed mora no mesmo canto. Em vez de chutar uma folga fixa — que erraria quando o cartão
  // de aviso entra, ou quando a escala do HUD muda de tela para tela — o painel PUBLICA a própria
  // altura e o CSS do feed desce por baixo dela.
  const publicarAltura = (): void => {
    document.documentElement.style.setProperty('--fps-altura', `${Math.round(raiz.offsetHeight)}px`);
  };
  new ResizeObserver(publicarAltura).observe(raiz);
  publicarAltura();

  let quadros = 0;
  let janelaDesde = -1;
  let ultimoTexto = '';
  let ultimaClasse = '';

  return {
    quadro(agoraMs: number): void {
      if (janelaDesde < 0) {
        janelaDesde = agoraMs;
        return;
      }
      quadros += 1;
      const decorrido = agoraMs - janelaDesde;
      if (decorrido < PASSO_MS) return;
      const fps = Math.round((quadros * 1000) / decorrido);
      quadros = 0;
      janelaDesde = agoraMs;
      const texto = String(fps);
      // Escrever no DOM só quando o valor muda: 2×/s já é pouco, mas de 59 para 59 é zero.
      if (texto !== ultimoTexto) {
        ultimoTexto = texto;
        numero.textContent = texto;
      }
      const classe = fps < FPS_RUIM ? 'ruim' : fps < FPS_MEDIO ? 'medio' : '';
      if (classe !== ultimaClasse) {
        ultimaClasse = classe;
        numero.className = classe;
      }
    },
    setNivel(nivel: NivelFx): void {
      const rotulo = ROTULO[nivel];
      degrau.textContent = rotulo;
      degrau.hidden = rotulo === '';
    },
    avisarSoftware(): void {
      aviso.hidden = false;
    },
  };
}
