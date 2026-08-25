// Lobby, em dois estados dentro da mesma moldura:
//   1. ENTRADA — ainda não há sala: nome + código de 4 letras, "entrar" ou "criar sala".
//   2. SALA — já conectado: código gigante, QR para entrar pelo celular, grade de 10 vagas com
//      a miniatura do tanque de cada um, botão PRONTO e as regras do jogo em uma frase.
//
// O fundo é a arena de verdade rodando com bots (ver `ui/vitrine.ts`), desfocada pelo CSS — quem
// chega pelo link vê o jogo acontecendo antes de entrar.

import { normalizeRoomCode, PLAYER_COLORS, ROOM_CODE_LENGTH, temCaractereAmbiguo, VAGAS_POR_SALA } from '@tank/protocol';
import type { SalaAberta } from '@tank/protocol';
import { emblemaHtml, nomeDoAnimal } from '../render/animais.js';
import { ICONE, img } from './icons.js';
import { desenharTanque } from './tankThumb.js';

export interface LobbyPlayer {
  id: string;
  name: string;
  color: number;
  ready: boolean;
  isBot: boolean;
}

export interface LobbyState {
  roomCode: string;
  players: LobbyPlayer[];
  meId: string;
  meReady: boolean;
  countdown: number | null; // segundos restantes, null = sem contagem ativa
  /** Mensagem de status exibida abaixo do botão (ex.: "esperando mais um jogador"). */
  aviso?: string;
  /** Aviso discreto do seletor de cor (ex.: a cor guardada estava ocupada). */
  avisoCor?: string;
  /**
   * Sou o dono da sala (o primeiro humano que entrou). Só para ele aparecem os botões de bot —
   * quem decide de verdade é o servidor, que recusa o pedido de qualquer outro (Fase 13 §3).
   */
  souDono?: boolean;
}

/** Estado do bloco SALAS ABERTAS da tela de entrada (Fase 13 §2). */
export interface SalasState {
  salas: SalaAberta[];
  /** Mensagem discreta quando a consulta falha — o formulário ao lado continua valendo. */
  erro?: string;
  /** Ainda não voltou nenhuma resposta desde que a tela abriu. */
  carregando?: boolean;
}

export interface EntradaState {
  nome: string;
  codigo: string;
  aviso?: string;
  ocupado?: boolean; // trava os botões enquanto a conexão está em andamento
}

export type AcaoEntrada = 'criar' | 'entrar';

/** Opções do seletor de bots do treino (Fase 12 §7). O padrão é o do meio. */
export const TREINO_BOTS = [3, 6, 9] as const;
const TREINO_BOTS_PADRAO = 6;

/** Vagas desenhadas na grade — a sala comporta 10 (uma cor de jogador para cada). */
const VAGAS = PLAYER_COLORS.length;

let built = false;
let els: {
  entrada: HTMLElement;
  sala: HTMLElement;
  campoNome: HTMLInputElement;
  campoCodigo: HTMLInputElement;
  botaoCriar: HTMLButtonElement;
  botaoEntrar: HTMLButtonElement;
  botaoTreinar: HTMLButtonElement;
  treinoBots: HTMLElement;
  aviso: HTMLElement;
  codigo: HTMLElement;
  link: HTMLElement;
  botaoCopiar: HTMLButtonElement;
  qr: HTMLCanvasElement;
  vagas: HTMLElement;
  contador: HTMLElement;
  botaoPronto: HTMLButtonElement;
  status: HTMLElement;
  cores: HTMLElement;
  avisoCor: HTMLElement;
  listaSalas: HTMLElement;
  controleBots: HTMLElement;
  contadorBots: HTMLElement;
} | null = null;

let onReadyToggle: (() => void) | null = null;
let onEntrada: ((acao: AcaoEntrada, nome: string, codigo: string) => void) | null = null;
let onTreinar: ((nome: string, bots: number) => void) | null = null;
let onDigitou: ((nome: string, codigo: string) => void) | null = null;
let onEscolherCor: ((cor: number) => void) | null = null;
let onEscolherSala: ((codigo: string) => void) | null = null;
let onMexerBots: ((delta: 1 | -1) => void) | null = null;
/** O jogador digitou um caractere que o alfabeto do código evita (I, O, 0, 1). */
let ambiguoDigitado = false;

let ultimaChaveVagas = '';
let ultimaChaveCores = '';
let ultimoQr = '';
let ultimoStatus = '';
let ultimoAvisoCor = '';
let ultimaChaveSalas = '';
let ultimaChaveBots = '';

function css(color: number): string {
  return '#' + (color >>> 0).toString(16).padStart(6, '0');
}

function ensureBuilt(root: HTMLElement): void {
  if (built) return;
  root.innerHTML = `
    <div class="lobby-fundo"></div>

    <div id="lobby-entrada">
      <div class="marca">
        <div class="linha-topo">FFA · ATÉ 10 TANQUES · 10 RODADAS</div>
        <img class="arte-tank" src="arte/tank.png" alt="" />
        <h1>TANK<span>RICOCHETE</span></h1>
        <p class="regra">${img(ICONE.mira, 'icone-3d')}<span>A bala <b>ricocheteia 1×</b> e mata em <b>1 toque</b> — inclusive quem atirou.</span></p>
      </div>

      <div class="cartao">
        <label class="campo">
          <span>SEU NOME</span>
          <input id="campo-nome" type="text" maxlength="14" placeholder="como quer aparecer" autocomplete="off" />
        </label>
        <label class="campo codigo">
          <span>CÓDIGO DA SALA</span>
          <input id="campo-codigo" type="text" maxlength="4" placeholder="ABCD" autocomplete="off" spellcheck="false" />
        </label>
        <button id="btn-entrar" type="button" class="botao-jogo">ENTRAR NA SALA</button>
        <div class="ou"><i></i>ou<i></i></div>
        <button id="btn-criar" type="button" class="botao-jogo secundario">CRIAR UMA SALA NOVA</button>
        <div id="lobby-aviso"></div>

        <div class="treino">
          <button id="btn-treinar" type="button" class="botao-jogo treino">TREINAR CONTRA BOTS</button>
          <div class="quantos" id="treino-bots" role="radiogroup" aria-label="Quantidade de bots">
            <span class="lbl">BOTS</span>
            ${TREINO_BOTS.map(
              (n) =>
                `<button type="button" class="qtd${n === TREINO_BOTS_PADRAO ? ' ativo' : ''}" data-bots="${n}" role="radio" aria-checked="${n === TREINO_BOTS_PADRAO}">${n}</button>`,
            ).join('')}
          </div>
          <p class="dica">Sozinho, sem sala, só para pegar o jeito do ricochete.</p>
        </div>
      </div>

      <!-- Fase 13 §2: até aqui só se entrava sabendo o código de cor. Agora as salas que estão
           esperando gente aparecem aqui, clicáveis. -->
      <div class="salas">
        <div class="cabeca"><span class="lbl">SALAS ABERTAS</span></div>
        <div id="lobby-lista-salas"></div>
      </div>
    </div>

    <div id="lobby-sala">
      <div class="coluna-esq">
        <div class="marca-sala">TANK<span>RICOCHETE</span></div>
        <div class="bloco-codigo">
          <span class="lbl">CÓDIGO DA SALA</span>
          <div class="codigo-sala" id="lobby-codigo">····</div>
          <div class="link-linha">
            <span id="lobby-link"></span>
            <button id="btn-copiar" type="button">COPIAR</button>
          </div>
        </div>

        <div class="bloco-qr">
          <canvas id="lobby-qr" width="128" height="128"></canvas>
          <p>Aponte a câmera do<br />celular e entre na<br />mesma sala.</p>
        </div>

        <div class="bloco-cores">
          <div class="cabeca"><span class="lbl">COR E BICHO</span><span id="lobby-aviso-cor"></span></div>
          <div id="lobby-cores"></div>
        </div>

        <div class="bloco-regra">
          ${img(ICONE.mira, 'icone-3d')}
          <p>A bala <b>ricocheteia 1×</b> e mata em <b>1 toque</b> — inclusive quem atirou. Some em 2,2 s.</p>
        </div>

        <div class="bloco-teclas">
          <div class="wasd"><kbd>W</kbd><div><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></div></div>
          <div class="legenda"><span>mover</span><span><kbd class="larga">mouse</kbd> mirar</span><span><kbd class="larga">clique</kbd> atirar</span></div>
        </div>
      </div>

      <div class="coluna-dir">
        <div class="cabeca-vagas">
          <span class="titulo">NA SALA</span>
          <span class="contador" id="lobby-contador"></span>
          <!-- Só o dono vê (Fase 13 §3). Bot ocupa vaga e cor como qualquer jogador. -->
          <span class="controle-bots" id="lobby-controle-bots" hidden>
            <button type="button" class="bot-menos" data-bot="-1" aria-label="Remover um bot">−</button>
            <span class="rot">BOTS <b id="lobby-bots-n">0</b></span>
            <button type="button" class="bot-mais" data-bot="1" aria-label="Adicionar um bot">+</button>
          </span>
        </div>
        <div id="lobby-vagas"></div>
        <div class="rodape-sala">
          <button id="btn-pronto" type="button" class="botao-jogo grande">ESTOU PRONTO</button>
          <div id="lobby-status"></div>
        </div>
      </div>
    </div>
  `;

  els = {
    entrada: root.querySelector('#lobby-entrada')!,
    sala: root.querySelector('#lobby-sala')!,
    campoNome: root.querySelector('#campo-nome')!,
    campoCodigo: root.querySelector('#campo-codigo')!,
    botaoCriar: root.querySelector('#btn-criar')!,
    botaoEntrar: root.querySelector('#btn-entrar')!,
    botaoTreinar: root.querySelector('#btn-treinar')!,
    treinoBots: root.querySelector('#treino-bots')!,
    aviso: root.querySelector('#lobby-aviso')!,
    codigo: root.querySelector('#lobby-codigo')!,
    link: root.querySelector('#lobby-link')!,
    botaoCopiar: root.querySelector('#btn-copiar')!,
    qr: root.querySelector('#lobby-qr')!,
    vagas: root.querySelector('#lobby-vagas')!,
    contador: root.querySelector('#lobby-contador')!,
    botaoPronto: root.querySelector('#btn-pronto')!,
    status: root.querySelector('#lobby-status')!,
    cores: root.querySelector('#lobby-cores')!,
    avisoCor: root.querySelector('#lobby-aviso-cor')!,
    listaSalas: root.querySelector('#lobby-lista-salas')!,
    controleBots: root.querySelector('#lobby-controle-bots')!,
    contadorBots: root.querySelector('#lobby-bots-n')!,
  };

  // Delegação nas duas listas que são redesenhadas: prender ouvinte por linha vazaria um a cada
  // atualização (a de salas se refaz a cada 3 s).
  els.listaSalas.addEventListener('click', (ev) => {
    const alvo = (ev.target as HTMLElement).closest<HTMLElement>('.sala');
    if (!alvo?.dataset.codigo) return;
    onEscolherSala?.(alvo.dataset.codigo);
  });

  els.controleBots.addEventListener('click', (ev) => {
    const alvo = (ev.target as HTMLElement).closest<HTMLElement>('[data-bot]');
    if (!alvo) return;
    onMexerBots?.(alvo.dataset.bot === '-1' ? -1 : 1);
  });

  // Delegação: a grade de cores é redesenhada a cada mudança de sala, então prender um ouvinte
  // por quadrado vazaria ouvinte a cada render.
  els.cores.addEventListener('click', (ev) => {
    const alvo = (ev.target as HTMLElement).closest<HTMLElement>('.cor');
    if (!alvo || alvo.classList.contains('ocupada') || alvo.classList.contains('minha')) return;
    onEscolherCor?.(Number(alvo.dataset.cor));
  });

  els.campoCodigo.addEventListener('input', () => {
    if (!els) return;
    // Fase 12: a normalização saiu daqui e virou contrato (`normalizeRoomCode` em @tank/protocol),
    // a MESMA que o sorteio do servidor respeita. O filtro anterior era `[^A-Z0-9]` — mais largo
    // que o alfabeto real, então dava para digitar um `I` ou um `0` que NUNCA aparecem num código
    // e ficar com quatro caracteres impossíveis e uma sala "não encontrada".
    //
    // Quem digitou um desses agora recebe um aviso em vez de ver o caractere sumir calado.
    const bruto = els.campoCodigo.value;
    // O aviso GRUDA até o campo ser esvaziado: o caractere ambíguo é descartado na hora, então
    // uma tecla depois o texto do campo já não tem vestígio dele — e o jogador ficaria sem
    // nenhuma pista de por que o código não fecha.
    if (temCaractereAmbiguo(bruto)) ambiguoDigitado = true;
    els.campoCodigo.value = normalizeRoomCode(bruto);
    if (els.campoCodigo.value.length === 0) ambiguoDigitado = false;
    onDigitou?.(els.campoNome.value, els.campoCodigo.value);
  });
  // O `renderEntrada` reescreve o campo a partir do estado sempre que ele não está focado. Sem
  // avisar o dono do estado a cada tecla, a sequência blur→click do botão apagava o nome digitado
  // ANTES do clique ler o valor, e o jogador virava "JogadorNNN" (relatado pelo usuário).
  els.campoNome.addEventListener('input', () => {
    if (!els) return;
    onDigitou?.(els.campoNome.value, els.campoCodigo.value);
  });
  // O valor sai do DOM na hora do clique, e normalizado pela MESMA função do campo: é o caminho
  // mais curto possível entre o que está escrito na tela e o que vai para o `join`.
  const disparar = (acao: AcaoEntrada): void => {
    if (!els) return;
    onEntrada?.(acao, els.campoNome.value.trim(), normalizeRoomCode(els.campoCodigo.value));
  };
  els.botaoEntrar.addEventListener('click', () => disparar('entrar'));
  els.botaoCriar.addEventListener('click', () => disparar('criar'));
  // Seletor de quantos bots: um grupo de rádio de verdade (três botões), não um `<select>` —
  // mesma linguagem dos outros controles da tela. Delegação em vez de um ouvinte por botão.
  els.treinoBots.addEventListener('click', (ev) => {
    if (!els) return;
    const alvo = (ev.target as HTMLElement).closest<HTMLElement>('.qtd');
    if (!alvo) return;
    for (const botao of els.treinoBots.querySelectorAll<HTMLElement>('.qtd')) {
      const marcado = botao === alvo;
      botao.classList.toggle('ativo', marcado);
      botao.setAttribute('aria-checked', String(marcado));
    }
  });
  els.botaoTreinar.addEventListener('click', () => {
    if (!els) return;
    const escolhido = els.treinoBots.querySelector<HTMLElement>('.qtd.ativo')?.dataset.bots;
    onTreinar?.(els.campoNome.value.trim(), Number(escolhido) || TREINO_BOTS_PADRAO);
  });
  els.campoCodigo.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') disparar('entrar');
  });
  els.campoNome.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') disparar(normalizeRoomCode(els?.campoCodigo.value).length === ROOM_CODE_LENGTH ? 'entrar' : 'criar');
  });
  // Fichas de quantidade de bots: delegação, e a seleção é só uma classe — o valor é lido no clique de TREINAR.
  els.treinoBots.addEventListener('click', (ev) => {
    const alvo = (ev.target as HTMLElement).closest<HTMLElement>('.qtd');
    if (!alvo || !els) return;
    els.treinoBots.querySelectorAll('.qtd').forEach((b) => {
      const ativo = b === alvo;
      b.classList.toggle('ativo', ativo);
      b.setAttribute('aria-checked', String(ativo));
    });
  });

  els.botaoPronto.addEventListener('click', () => onReadyToggle?.());
  // `navigator.clipboard` também só existe em contexto seguro (HTTPS/localhost) — na LAN do
  // escritório, que é o caso de uso principal, ela é `undefined` e o botão falhava calado
  // justamente quando o link precisa ser passado para os colegas. O `execCommand('copy')` é
  // obsoleto, mas é o único caminho que funciona em `http://192.168.x.x`.
  const copiarTexto = async (texto: string): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(texto);
        return true;
      }
    } catch {
      /* cai no plano B */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = texto;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };

  els.botaoCopiar.addEventListener('click', () => {
    if (!els) return;
    const texto = els.link.textContent ?? '';
    void copiarTexto(texto).then((ok) => {
      if (!els) return;
      els.botaoCopiar.textContent = ok ? 'COPIADO' : 'COPIE À MÃO';
      els.botaoCopiar.classList.toggle('ok', ok);
      window.setTimeout(() => {
        if (!els) return;
        els.botaoCopiar.textContent = 'COPIAR';
        els.botaoCopiar.classList.remove('ok');
      }, 1600);
    });
  });
  built = true;
}

export function setLobbyReadyHandler(handler: () => void): void {
  onReadyToggle = handler;
}

export function setLobbyEntradaHandler(handler: (acao: AcaoEntrada, nome: string, codigo: string) => void): void {
  onEntrada = handler;
}

/**
 * Clique em TREINAR CONTRA BOTS (Fase 12 §7). Não é modo de jogo novo: é o MESMO jogo, entrando
 * pelo caminho local, que já roda a partida inteira contra bots sem servidor. O que faltava era
 * alguém sem URL na mão conseguir chegar lá.
 */
export function setLobbyTreinoHandler(handler: (nome: string, bots: number) => void): void {
  onTreinar = handler;
}

/** Avisa a cada tecla digitada, para o estado acompanhar o campo e o render não apagar o que foi escrito. */
export function setLobbyDigitouHandler(handler: (nome: string, codigo: string) => void): void {
  onDigitou = handler;
}

/**
 * Clique num quadrado do seletor de cor. O cliente só PEDE — quem garante que duas pessoas não
 * fiquem com a mesma cor é o servidor (`TankRoom`, canal `pick_color`). A grade aqui reflete o
 * estado frio, então a confirmação chega no render seguinte.
 */
export function setLobbyCorHandler(handler: (cor: number) => void): void {
  onEscolherCor = handler;
}

/**
 * Clique numa sala da lista de SALAS ABERTAS. Entrar é o mesmo caminho de sempre (o `join` por
 * código) — o que a lista faz é dispensar a digitação e o "qual era o código mesmo?".
 */
export function setLobbySalaHandler(handler: (codigo: string) => void): void {
  onEscolherSala = handler;
}

/** Clique em `+ BOT` / `− BOT` no lobby da sala. Só o dono vê os botões; o servidor confere de novo. */
export function setLobbyBotHandler(handler: (delta: 1 | -1) => void): void {
  onMexerBots = handler;
}

/**
 * Bloco SALAS ABERTAS. Redesenha só quando a lista muda de verdade: a consulta acontece a cada
 * 3 s e reescrever o HTML a cada volta faria o cursor perder o botão que estava sob ele.
 */
export function renderSalasAbertas(root: HTMLElement, state: SalasState): void {
  ensureBuilt(root);
  if (!els) return;

  const chave = state.salas.map((s) => `${s.codigo}:${s.humanos}:${s.bots}:${s.emPartida ? 1 : 0}`).join('|') +
    `#${state.erro ?? ''}#${state.carregando ? 1 : 0}`;
  if (chave === ultimaChaveSalas) return;
  ultimaChaveSalas = chave;

  if (state.salas.length === 0) {
    const vazio = state.erro
      ? state.erro
      : state.carregando
        ? 'procurando salas…'
        : 'nenhuma sala aberta agora — crie a sua';
    els.listaSalas.innerHTML = `<p class="vazio">${vazio}</p>`;
    return;
  }

  els.listaSalas.innerHTML = state.salas
    .map((sala) => {
      const gente = `${sala.humanos} ${sala.humanos === 1 ? 'jogador' : 'jogadores'}`;
      const bots = sala.bots > 0 ? ` · ${sala.bots} ${sala.bots === 1 ? 'bot' : 'bots'}` : '';
      // Sala em partida não recusa ninguém: quem entra assiste e joga na rodada seguinte. Dizer
      // isso na ficha evita a impressão de que o clique não funcionou.
      const selo = sala.emPartida
        ? `<span class="selo jogando">EM PARTIDA</span>`
        : `<span class="selo">${sala.livres} ${sala.livres === 1 ? 'VAGA' : 'VAGAS'}</span>`;
      return `<button type="button" class="sala${sala.emPartida ? ' jogando' : ''}" data-codigo="${sala.codigo}">
        <span class="cod">${sala.codigo}</span>
        <span class="quem">${gente}${bots}${sala.emPartida ? '<i>você entra como espectador</i>' : ''}</span>
        ${selo}
      </button>`;
    })
    .join('');
}

/** Estado 1: ainda sem sala. */
/**
 * Leva o foco ao campo de nome e o destaca por um instante.
 *
 * Existe porque o nome virou OBRIGATÓRIO: quem chega por um link de sala já tem o código
 * preenchido e a ação óbvia na tela é clicar em ENTRAR — o campo vazio logo acima passa
 * despercebido. Recusar o clique sem mover o foco deixaria a pessoa lendo um aviso sem saber
 * onde escrever.
 */
export function focarCampoNome(): void {
  if (!els) return;
  els.campoNome.focus();
  els.campoNome.select();
  els.campoNome.classList.remove('faltando');
  // Reinicia a animação mesmo em cliques seguidos: sem o reflow o browser ignora a re-adição.
  void els.campoNome.offsetWidth;
  els.campoNome.classList.add('faltando');
}

export function renderEntrada(root: HTMLElement, state: EntradaState): void {
  ensureBuilt(root);
  if (!els) return;

  root.classList.add('em-entrada');
  root.classList.remove('em-sala');

  if (document.activeElement !== els.campoNome && els.campoNome.value !== state.nome) {
    els.campoNome.value = state.nome;
  }
  if (els.campoNome.value.trim().length > 0) els.campoNome.classList.remove('faltando');
  if (document.activeElement !== els.campoCodigo && els.campoCodigo.value !== state.codigo) {
    els.campoCodigo.value = state.codigo;
  }

  const digitado = normalizeRoomCode(els.campoCodigo.value);
  const temCodigo = digitado.length === ROOM_CODE_LENGTH;
  els.botaoCriar.disabled = state.ocupado === true;
  els.botaoTreinar.disabled = state.ocupado === true;
  // Fase 12: ENTRAR NA SALA deixou de ficar DESABILITADO com o código incompleto. Um botão morto
  // não diz o que falta — quem digitou 3 caracteres clicava e não acontecia nada, que é
  // exatamente a experiência relatada ("não consegui entrar com o código"). Agora ele sempre
  // responde, e quem responde é a linha de aviso logo abaixo.
  els.botaoEntrar.disabled = state.ocupado === true;
  // A ênfase segue a intenção: sem código digitado, a ação óbvia é abrir uma sala; com o código
  // completo, é entrar nela.
  els.botaoEntrar.classList.toggle('secundario', !temCodigo);
  els.botaoCriar.classList.toggle('secundario', temCodigo);

  // O aviso vindo do estado (erro de conexão, "entrando…") manda; na ausência dele, o campo se
  // explica sozinho.
  let aviso = state.aviso ?? '';
  if (!aviso && ambiguoDigitado) {
    aviso = 'O código não usa I, O, 0 nem 1 — confira as letras.';
  } else if (!aviso && digitado.length > 0 && !temCodigo) {
    const faltam = ROOM_CODE_LENGTH - digitado.length;
    aviso = `Falta${faltam > 1 ? 'm' : ''} ${faltam} ${faltam > 1 ? 'caracteres' : 'caractere'} para o código da sala.`;
  }
  if (els.aviso.textContent !== aviso) els.aviso.textContent = aviso;
}

/** Estado 2: dentro da sala, esperando todo mundo ficar pronto. */
export function renderLobby(root: HTMLElement, state: LobbyState): void {
  ensureBuilt(root);
  if (!els) return;

  root.classList.add('em-sala');
  root.classList.remove('em-entrada');

  if (els.codigo.textContent !== state.roomCode) els.codigo.textContent = state.roomCode;

  const link = `${location.origin}${location.pathname}?sala=${state.roomCode}`;
  if (els.link.textContent !== link) els.link.textContent = link;
  if (link !== ultimoQr && state.roomCode) {
    ultimoQr = link;
    void desenharQr(els.qr, link);
  }

  const prontos = state.players.filter((p) => p.ready).length;
  const contador = `${state.players.length}/${VAGAS}`;
  if (els.contador.textContent !== contador) els.contador.textContent = contador;

  // Controle de bots: existe só para o dono. Para os outros o bloco nem entra no layout — um
  // botão desabilitado ficaria sugerindo uma permissão que não é deles.
  const meusBots = state.players.filter((p) => p.isBot).length;
  const chaveBots = `${state.souDono ? 1 : 0}:${meusBots}:${state.players.length}`;
  if (chaveBots !== ultimaChaveBots) {
    ultimaChaveBots = chaveBots;
    els.controleBots.hidden = state.souDono !== true;
    els.contadorBots.textContent = String(meusBots);
    const menos = els.controleBots.querySelector<HTMLButtonElement>('.bot-menos');
    const mais = els.controleBots.querySelector<HTMLButtonElement>('.bot-mais');
    if (menos) menos.disabled = meusBots === 0;
    if (mais) mais.disabled = state.players.length >= VAGAS_POR_SALA;
  }

  const chave = state.players.map((p) => `${p.id}:${p.name}:${p.color}:${p.ready ? 1 : 0}:${p.isBot ? 1 : 0}`).join('|') + `#${state.meId}`;
  if (chave !== ultimaChaveVagas) {
    ultimaChaveVagas = chave;
    desenharVagas(els.vagas, state);
  }

  // O seletor depende só de QUEM está com QUAL cor — nome e "pronto" não mexem nele.
  const chaveCores = state.players.map((p) => `${p.id}:${p.color}`).join('|') + `#${state.meId}`;
  if (chaveCores !== ultimaChaveCores) {
    ultimaChaveCores = chaveCores;
    desenharCores(els.cores, state);
  }
  const avisoCor = state.avisoCor ?? '';
  if (avisoCor !== ultimoAvisoCor) {
    els.avisoCor.textContent = avisoCor;
    els.avisoCor.classList.toggle('ativo', avisoCor !== '');
    ultimoAvisoCor = avisoCor;
  }

  els.botaoPronto.classList.toggle('pronto', state.meReady);
  const rotuloPronto = state.meReady ? 'PRONTO ✓' : 'ESTOU PRONTO';
  if (els.botaoPronto.textContent !== rotuloPronto) els.botaoPronto.textContent = rotuloPronto;

  const status =
    state.countdown !== null
      ? `COMEÇA EM ${state.countdown}`
      : (state.aviso ?? `${prontos} de ${state.players.length} prontos`);
  if (status !== ultimoStatus) {
    els.status.textContent = status;
    els.status.classList.toggle('contando', state.countdown !== null);
    ultimoStatus = status;
  }
}

/**
 * Grade das 10 identidades: cada quadrado é uma COR + o ANIMAL que anda com ela (Fase 11). O par é
 * FIXO — a cor 4 é sempre o tubarão —, então escolher a cor já é escolher o bicho e a unicidade
 * que o servidor garante para uma vale para o outro, sem uma segunda regra.
 *
 * O emblema é da cor do jogador e o quadrado também, então ele vem numa pastilha escura: é o
 * único jeito de a silhueta ler em cima da própria tinta.
 *
 * Três estados: a minha (anel amarelo e marca de confirmado), as tomadas por outro (esmaecidas,
 * hachuradas e sem clique) e as livres. A grade é só a leitura do estado frio — quem decide é o
 * servidor, então o clique não pinta nada na hora: manda o pedido e espera o estado voltar.
 */
function desenharCores(root: HTMLElement, state: LobbyState): void {
  const donoDaCor = new Map<number, LobbyPlayer>();
  for (const p of state.players) donoDaCor.set(p.color, p);

  root.innerHTML = PLAYER_COLORS.map((cor) => {
    const dono = donoDaCor.get(cor);
    const minha = dono?.id === state.meId;
    const ocupada = dono !== undefined && !minha;
    const bicho = nomeDoAnimal(cor);
    const classes = ['cor'];
    if (minha) classes.push('minha');
    if (ocupada) classes.push('ocupada');
    const titulo = minha ? `você é o ${bicho}` : ocupada ? `o ${bicho} já é de ${dono.name}` : `ser o ${bicho}`;
    return `<button type="button" class="${classes.join(' ')}" data-cor="${cor}" style="--cor:${css(cor)}" title="${titulo}" aria-label="${titulo}"${ocupada ? ' disabled' : ''}>
      ${emblemaHtml(cor, 'bicho grande')}
      <span class="apelido">${bicho}</span>
    </button>`;
  }).join('');
}

function desenharVagas(root: HTMLElement, state: LobbyState): void {
  const ordenados = [...state.players];
  root.innerHTML = Array.from({ length: VAGAS }, (_, i) => {
    const p = ordenados[i];
    if (!p) {
      return `<div class="vaga vazia"><span class="silhueta"></span><span class="nome">aguardando…</span></div>`;
    }
    const eu = p.id === state.meId;
    // O emblema fica ENCAIXADO no canto da miniatura: um retrato só, em vez de dois elementos
    // disputando a largura do cartão numa coluna de 220 px.
    return `<div class="vaga${p.ready ? ' pronto' : ''}${eu ? ' eu' : ''}" style="--cor:${css(p.color)}">
      <span class="retrato"><canvas class="miniatura" data-cor="${p.color}"></canvas>${emblemaHtml(p.color, 'bicho selo')}</span>
      <span class="nome">${p.name}${eu ? ' <i>você</i>' : ''}${p.isBot ? ' <i>bot</i>' : ''}<b class="bicho-nome">${nomeDoAnimal(p.color)}</b></span>
      <span class="estado">${p.ready ? 'PRONTO' : 'AGUARDA'}</span>
    </div>`;
  }).join('');

  root.querySelectorAll<HTMLCanvasElement>('canvas.miniatura').forEach((c) => {
    desenharTanque(c, Number(c.dataset.cor), 46);
  });
}

/**
 * QR gerado NO CLIENTE (pacote `qrcode`), nunca por serviço externo: o jogo tem que funcionar na
 * rede do escritório sem internet. O import é dinâmico para a biblioteca não entrar no bundle de
 * quem abre o modo local.
 */
async function desenharQr(canvas: HTMLCanvasElement, texto: string): Promise<void> {
  try {
    const { toCanvas } = await import('qrcode');
    await toCanvas(canvas, texto, {
      width: 128,
      margin: 1,
      color: { dark: '#0b0f1a', light: '#e6ecf8' },
      errorCorrectionLevel: 'M',
    });
    // A biblioteca escreve `style.width/height` no canvas em pixels; sem isto o QR ignora o
    // tamanho que o layout do lobby reservou para ele.
    canvas.style.width = '';
    canvas.style.height = '';
  } catch {
    // Sem QR o lobby continua funcionando: o código de 4 letras e o link já resolvem.
  }
}
