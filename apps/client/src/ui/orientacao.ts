// Tela deitada (M1 §2). O dono pediu explicitamente — e a geometria concorda: a arena nasce com
// proporção entre 1,2 e 2,7, e retrato de celular é ~0,46. Encolher o jogo para caber em retrato
// daria uma arena do tamanho de um selo com duas faixas pretas gigantes. Então em retrato o jogo
// não é jogado: aparece um aviso pedindo para virar o aparelho.
//
// Travar a orientação é TENTATIVA, nunca requisito. `screen.orientation.lock()` só existe em
// Chromium e, mesmo lá, exige tela cheia — em iOS não existe. Por isso a trava é oportunista
// (roda quando dá certo, é engolida quando não) e o AVISO é o que garante o comportamento em
// todo aparelho.

/** `true` quando a janela está mais alta que larga. */
export function emRetrato(): boolean {
  return window.innerHeight > window.innerWidth;
}

/**
 * A Screen Orientation API é opcional: `screen.orientation` existe nos tipos do DOM, mas `lock`
 * some em tempo de execução no Safari (todos os iOS). Por isso a checagem é feita no OBJETO, não
 * no tipo.
 */
type Travavel = { lock?: (orientacao: string) => Promise<void>; unlock?: () => void };

/**
 * Tenta travar em paisagem. Só funciona em tela cheia na maioria dos navegadores, e em nenhum
 * iOS — a promessa é sempre engolida. Devolve `true` quando a trava pegou, para quem chamar poder
 * decidir se ainda precisa mostrar o aviso.
 */
export async function travarPaisagem(): Promise<boolean> {
  const orientacao: Travavel | undefined = screen.orientation;
  if (typeof orientacao?.lock !== 'function') return false;
  try {
    await orientacao.lock('landscape');
    return true;
  } catch {
    return false;
  }
}

export function destravarOrientacao(): void {
  const orientacao: Travavel | undefined = screen.orientation;
  try {
    orientacao?.unlock?.();
  } catch {
    // navegador que não trava também não destrava
  }
}

export interface VigiaDeOrientacao {
  /** `true` enquanto o aviso de virar o aparelho está em cena. */
  readonly bloqueado: boolean;
  /** Reavalia agora (usado depois de entrar/sair da tela cheia). */
  revisar(): void;
  dispose(): void;
}

export interface OpcoesDeOrientacao {
  /** Elemento do aviso (`#gire`). */
  alvo: HTMLElement;
  /**
   * Chamado toda vez que o bloqueio muda. É por aqui que o jogo solta os dedos dos analógicos e
   * reenquadra a arena — a partida NÃO para (os outros jogadores continuam), só fica encoberta.
   */
  aoMudar(bloqueado: boolean): void;
}

/**
 * Monta o aviso e passa a vigiar a orientação. O desenho é um celular que gira, feito em SVG
 * inline como o resto da arte do jogo — nenhum arquivo externo.
 */
export function vigiarOrientacao(opcoes: OpcoesDeOrientacao): VigiaDeOrientacao {
  const alvo = opcoes.alvo;
  alvo.innerHTML = `
    <div class="cartao-gire">
      <div class="desenho">
        <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
          <rect class="aparelho" x="38" y="14" width="44" height="92" rx="9" />
          <rect class="tela-do-aparelho" x="43" y="23" width="34" height="74" rx="4" />
          <path class="seta-gire" d="M22 66a38 38 0 0 1 12-27" fill="none" stroke-width="5" stroke-linecap="round" />
          <path class="seta-gire ponta" d="M30 33l6 8-10 3z" stroke="none" />
        </svg>
      </div>
      <h2>VIRE O CELULAR</h2>
      <p>A arena é deitada. Gire o aparelho para o lado e o jogo aparece.</p>
      <button id="btn-gire-cheia" type="button" class="botao-jogo">TELA CHEIA E GIRAR</button>
    </div>
  `;

  let bloqueado = false;

  const revisar = (): void => {
    const agora = emRetrato();
    if (agora === bloqueado) return;
    bloqueado = agora;
    alvo.classList.toggle('ativa', bloqueado);
    document.body.classList.toggle('em-retrato', bloqueado);
    opcoes.aoMudar(bloqueado);
  };

  // O botão é o único caminho que o navegador aceita para pedir tela cheia + trava: as duas APIs
  // exigem gesto do usuário. Em quem não trava (iOS) a tela cheia sozinha já ganha os ~15% de
  // altura da barra do navegador, que numa tela de 390 px fazem diferença de verdade.
  const botao = alvo.querySelector('#btn-gire-cheia') as HTMLButtonElement | null;
  const onBotao = (): void => {
    void (async (): Promise<void> => {
      try {
        if (document.fullscreenElement === null) {
          await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        }
      } catch {
        // recusado (política do SO, iframe sem allow) — segue para a trava mesmo assim
      }
      await travarPaisagem();
      revisar();
    })();
  };
  botao?.addEventListener('click', onBotao);

  // Três fontes porque nenhuma é confiável sozinha: `resize` é o que sempre chega, `orientationchange`
  // às vezes chega ANTES de a janela ter o tamanho novo (daí o segundo tique), e o `change` da
  // Screen Orientation API é o único que dispara em alguns Android quando a barra do sistema
  // some junto.
  const onResize = (): void => revisar();
  const onOrientacao = (): void => {
    revisar();
    window.setTimeout(revisar, 180);
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onOrientacao);
  screen.orientation?.addEventListener('change', onOrientacao);

  revisar();
  // `revisar()` só avisa quando MUDA; o primeiro estado (quase sempre "não bloqueado") precisa
  // chegar em quem chamou de qualquer jeito, para o CSS e os controles nascerem coerentes.
  alvo.classList.toggle('ativa', bloqueado);
  document.body.classList.toggle('em-retrato', bloqueado);

  return {
    get bloqueado(): boolean {
      return bloqueado;
    },
    revisar,
    dispose(): void {
      botao?.removeEventListener('click', onBotao);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onOrientacao);
      screen.orientation?.removeEventListener('change', onOrientacao);
      alvo.innerHTML = '';
    },
  };
}
