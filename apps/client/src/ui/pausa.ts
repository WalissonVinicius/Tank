// Menu de pausa (Fase 13 §1). `Esc` abre, `Esc` fecha.
//
// NÃO é pausa de verdade: a partida continua rodando para todo mundo, e o servidor nem fica
// sabendo que este menu existe. É só a porta de saída que faltava — até aqui, quem entrava numa
// sala só saía dela com F5.
//
// Vive fora das `.tela` (é overlay, como a contagem regressiva) e captura os cliques: com ele
// aberto, clicar na arena atrás não dispara tiro.

export interface PausaState {
  aberto: boolean;
  /** `online` mostra o código da sala; `treino` não tem sala nenhuma para mostrar. */
  modo: 'online' | 'treino';
  /** Código da sala, exibido para quem quiser ditá-lo antes de sair. */
  roomCode?: string;
  /** Texto do botão de saída — muda entre sala e treino. */
  rotuloSair?: string;
}

let built = false;
let els: {
  painel: HTMLElement;
  codigo: HTMLElement;
  sair: HTMLButtonElement;
  voltar: HTMLButtonElement;
  dica: HTMLElement;
} | null = null;
let onVoltar: (() => void) | null = null;
let onSair: (() => void) | null = null;
let ultimaChave = '';

function ensureBuilt(root: HTMLElement): void {
  if (built) return;
  root.innerHTML = `
    <div class="pausa-painel" role="dialog" aria-modal="true" aria-label="Menu de pausa">
      <h2>PAUSA</h2>
      <p class="pausa-sala" id="pausa-codigo"></p>
      <button id="btn-voltar-jogo" type="button" class="botao-jogo grande">VOLTAR AO JOGO</button>
      <button id="btn-sair-sala" type="button" class="botao-jogo sair">SAIR DA SALA</button>
      <p class="pausa-dica" id="pausa-dica"></p>
    </div>
  `;
  els = {
    painel: root.querySelector('.pausa-painel')!,
    codigo: root.querySelector('#pausa-codigo')!,
    sair: root.querySelector('#btn-sair-sala')!,
    voltar: root.querySelector('#btn-voltar-jogo')!,
    dica: root.querySelector('#pausa-dica')!,
  };
  els.voltar.addEventListener('click', () => onVoltar?.());
  els.sair.addEventListener('click', () => onSair?.());
  built = true;
}

export function setPausaHandlers(voltar: () => void, sair: () => void): void {
  onVoltar = voltar;
  onSair = sair;
}

export function renderPausa(root: HTMLElement, state: PausaState): void {
  ensureBuilt(root);
  if (!els) return;

  root.classList.toggle('aberto', state.aberto);
  if (!state.aberto) {
    ultimaChave = '';
    return;
  }

  const rotulo = state.rotuloSair ?? (state.modo === 'treino' ? 'SAIR DO TREINO' : 'SAIR DA SALA');
  const chave = `${state.modo}|${state.roomCode ?? ''}|${rotulo}`;
  if (chave === ultimaChave) return;
  ultimaChave = chave;

  els.codigo.textContent = state.modo === 'online' && state.roomCode ? `SALA ${state.roomCode}` : '';
  els.sair.textContent = rotulo;
  // No treino a simulação para de verdade (é offline, não há ninguém esperando); online ela
  // continua, e dizer isso evita a impressão de que dá para "pausar" a partida dos outros.
  els.dica.textContent =
    state.modo === 'treino'
      ? 'O treino fica parado enquanto este menu está aberto.'
      : 'A partida continua rolando para os outros enquanto este menu está aberto.';
  // O foco vai para VOLTAR AO JOGO: é a saída mais provável do menu, e assim `Enter` não manda
  // ninguém para fora da sala por engano.
  els.voltar.focus();
}
