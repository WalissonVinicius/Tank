// Tela cheia de verdade (Fase 8 §1): a Fullscreen API precisa ser chamada DENTRO de um gesto do
// usuário — clique no botão do canto ou a tecla `F`. `Esc` sai sozinho (o navegador cuida), e o
// evento `fullscreenchange` é o gancho para reenquadrar tudo.
//
// O alvo é o `<html>`, não o canvas: o HUD é DOM por cima do canvas e precisa entrar em tela
// cheia junto, senão o jogo ficaria sem placar, sem relógio e sem munição.

const ROTULO_ENTRAR = 'TELA CHEIA';
const ROTULO_SAIR = 'SAIR DA TELA CHEIA';

export function emTelaCheia(): boolean {
  return document.fullscreenElement !== null;
}

export async function alternarTelaCheia(): Promise<void> {
  try {
    if (emTelaCheia()) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    // navegador pode recusar (iframe sem allow="fullscreen", política do SO) — o jogo continua
    // funcionando em janela, só sem o modo cheio
  }
}

/**
 * Liga o botão do canto e o atalho `F`, e devolve o reenquadramento para quem chamou sempre que
 * o estado de tela cheia muda.
 *
 * `aoMudar` é chamado no `fullscreenchange` E um tique depois: o navegador troca o tamanho da
 * janela em dois passos (evento primeiro, layout final depois), e reenquadrar só no evento pega
 * a medida antiga em parte dos casos.
 */
export function iniciarTelaCheia(botao: HTMLButtonElement, aoMudar: () => void): void {
  const sincronizarBotao = (): void => {
    const cheia = emTelaCheia();
    botao.classList.toggle('ativo', cheia);
    botao.title = cheia ? ROTULO_SAIR : ROTULO_ENTRAR;
    botao.setAttribute('aria-label', botao.title);
  };

  botao.addEventListener('click', () => void alternarTelaCheia());

  window.addEventListener('keydown', (ev) => {
    if (ev.code !== 'KeyF' || ev.repeat || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const alvo = ev.target;
    // Não sequestrar o `F` de quem está digitando o nome ou o código da sala.
    if (alvo instanceof HTMLInputElement || alvo instanceof HTMLTextAreaElement) return;
    ev.preventDefault();
    void alternarTelaCheia();
  });

  document.addEventListener('fullscreenchange', () => {
    sincronizarBotao();
    aoMudar();
    window.setTimeout(aoMudar, 120);
  });

  sincronizarBotao();
}
