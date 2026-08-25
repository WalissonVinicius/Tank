// Ícones da interface, DESENHADOS EM CÓDIGO (SVG inline) — nenhum arquivo de imagem, nenhuma
// licença a cumprir, nenhuma atribuição devida.
//
// Fase 8: os PNGs 3D da WoopicX saíram junto com a linha de créditos do lobby (o plano gratuito
// deles exige "Images by Woopicx.com" visível, e o usuário não quer essa linha). O jogo já é
// 100% procedural — parede, tanque, bala, piso —, então ícone desenhado à mão em SVG combina
// melhor com o resto do que volume 3D importado, e custa zero de download.
//
// Linguagem: silhueta cheia, luz vindo de cima à esquerda (um realce claro por cima da forma
// base), paleta do jogo (quente #ffb347/#ffcb6b, osso #dfe6f5, alerta #ff3b3b). Sem gradiente
// com `id` — o mesmo ícone aparece várias vezes na página e ids repetidos em `<defs>` seriam
// colisão garantida.

function svg(corpo: string): string {
  return `<svg class="svg-icone" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${corpo}</svg>`;
}

/** Copa — líder do placar e vencedor da partida. */
const TROFEU = svg(`
  <path d="M7.2 4.2H3.4v2.1c0 2.3 1.6 4.2 3.8 4.6" fill="none" stroke="#e0a340" stroke-width="1.7"/>
  <path d="M16.8 4.2h3.8v2.1c0 2.3-1.6 4.2-3.8 4.6" fill="none" stroke="#e0a340" stroke-width="1.7"/>
  <path d="M6.6 2.6h10.8v6.2a5.4 5.4 0 0 1-10.8 0z" fill="#ffcb6b"/>
  <path d="M6.6 2.6h10.8v1.9H6.6z" fill="#ffe6b0"/>
  <path d="M8.6 4.5h2.1v4.3a2 2 0 0 1-2.1-2z" fill="#fff2d4" opacity=".55"/>
  <rect x="10.9" y="13.6" width="2.2" height="3.6" fill="#e0a340"/>
  <path d="M7.4 21.4l1.2-3.1h6.8l1.2 3.1z" fill="#e08b1c"/>
  <path d="M7.4 21.4h9.2v.9H7.4z" fill="#a9640c"/>
`);

/** Medalha — quem sobreviveu à rodada. */
const MEDALHA = svg(`
  <path d="M7.1 2.2h2.8l2.1 5.1-1.4 1.5z" fill="#5c74a8"/>
  <path d="M16.9 2.2h-2.8l-2.1 5.1 1.4 1.5z" fill="#455a8c"/>
  <circle cx="12" cy="15.2" r="6.4" fill="#e0a340"/>
  <circle cx="12" cy="15.2" r="5" fill="#ffcb6b"/>
  <path d="M12 11.4l1.2 2.5 2.7.4-2 1.9.5 2.7-2.4-1.3-2.4 1.3.5-2.7-2-1.9 2.7-.4z" fill="#fff2d4"/>
`);

/** Caveira — jogador eliminado. */
const CAVEIRA = svg(`
  <path d="M12 2.4c-4.5 0-7.7 3.1-7.7 7.4 0 2.5 1.1 4.5 2.7 5.7v2.3c0 .9.7 1.6 1.6 1.6h6.8c.9 0 1.6-.7 1.6-1.6v-2.3c1.6-1.2 2.7-3.2 2.7-5.7 0-4.3-3.2-7.4-7.7-7.4z" fill="#dfe6f5"/>
  <path d="M12 2.4c-2.4 0-4.4.9-5.8 2.4 1.3-.8 2.9-1.2 4.6-1.2 4.5 0 7.7 3.1 7.7 7.4 0 1.5-.4 2.8-1 3.9 1.4-1.2 2.2-3 2.2-5.1 0-4.3-3.2-7.4-7.7-7.4z" fill="#fff"/>
  <ellipse cx="8.7" cy="10.4" rx="2.4" ry="2.6" fill="#0b0f1a"/>
  <ellipse cx="15.3" cy="10.4" rx="2.4" ry="2.6" fill="#0b0f1a"/>
  <path d="M12 13.4l-1.2 2.6h2.4z" fill="#0b0f1a"/>
  <rect x="9.3" y="17.4" width="1.5" height="2.4" fill="#0b0f1a"/>
  <rect x="11.5" y="17.4" width="1.5" height="2.4" fill="#0b0f1a"/>
  <rect x="13.7" y="17.4" width="1.5" height="2.4" fill="#0b0f1a"/>
`);

/** Estouro — autogol e rodada sem vencedor. */
const BOOM = svg(`
  <path d="M12 1.3l2.4 4.3 4.4-2.2-1.5 4.7 4.9.6-3.7 3.2 3.7 3.2-4.9.6 1.5 4.7-4.4-2.2-2.4 4.3-2.4-4.3-4.4 2.2 1.5-4.7-4.9-.6 3.7-3.2-3.7-3.2 4.9-.6L5.2 3.4l4.4 2.2z" fill="#ff8c42"/>
  <path d="M12 5.4l1.6 2.9 3-1.5-1 3.2 3.3.4-2.5 2.1 2.5 2.1-3.3.4 1 3.2-3-1.5-1.6 2.9-1.6-2.9-3 1.5 1-3.2-3.3-.4 2.5-2.1-2.5-2.1 3.3-.4-1-3.2 3 1.5z" fill="#ffd84d"/>
  <circle cx="12" cy="12" r="2.6" fill="#fff2d4"/>
`);

// O ícone de PENTE DE BALAS saiu na Fase 10. Ele desenhava três cartuchos ao lado dos três pips
// de munição do HUD, e o usuário leu os dois grupos como "2 tipos de munição". Um indicador só,
// e são os pips — ver `#hud-municao` em style.css.

/** Retículo — cartão de regra do lobby. */
const MIRA = svg(`
  <circle cx="12" cy="12" r="7.4" fill="none" stroke="#ffb347" stroke-width="2.1"/>
  <path d="M12 1.2v5.2M12 17.6v5.2M1.2 12h5.2M17.6 12h5.2" stroke="#ffb347" stroke-width="2.1" stroke-linecap="round"/>
  <circle cx="12" cy="12" r="1.9" fill="#fff2d4"/>
`);

/** Bala em voo, apontando para a direita — separa MATADOR de VÍTIMA no killfeed. */
const BALA = svg(`
  <path d="M13.4 6.6 21.6 12l-8.2 5.4z" fill="#ffcb6b"/>
  <path d="M8.4 9.3h5.6v5.4H8.4z" fill="#ffb347"/>
  <path d="M13.4 6.6 21.6 12l-8.2 1.1z" fill="#fff2d4"/>
  <path d="M1.6 12h5.4" stroke="#ffb347" stroke-width="1.8" stroke-linecap="round" opacity=".55"/>
  <path d="M3.4 8.4h3.6M3.4 15.6h3.6" stroke="#ffb347" stroke-width="1.4" stroke-linecap="round" opacity=".3"/>
`);

export const ICONE = {
  trofeu: TROFEU,
  medalha: MEDALHA,
  caveira: CAVEIRA,
  boom: BOOM,
  mira: MIRA,
  bala: BALA,
} as const;

/**
 * Envelope do ícone pronto para o HUD. O SVG entra dentro de um `<span>` para a classe de
 * dimensionamento continuar valendo nos mesmos lugares em que antes havia um `<img>`.
 */
export function img(icone: string, classe: string): string {
  return `<span class="${classe}">${icone}</span>`;
}
