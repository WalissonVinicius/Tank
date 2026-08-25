export interface WebhookRanking {
  playerId: string;
  nome: string;
  pontos: number;
  posicao: number;
}

export interface WebhookTitles {
  kamikaze: string | null;
  balaPerdida: string | null;
  covardeEstrategico: string | null;
}

export interface WebhookPayload {
  roomId: string;
  finalizadaEm: string;
  ranking: WebhookRanking[];
  titulos: WebhookTitles;
}

/**
 * Dispara o ranking final da partida para o n8n postar no canal. Falha de webhook nunca derruba
 * a partida — qualquer erro (rede, DNS, timeout, 4xx/5xx) é só logado.
 */
export async function sendMatchWebhook(payload: WebhookPayload): Promise<void> {
  const url = process.env.WEBHOOK_URL;
  if (!url) return;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`[webhook] resposta não-ok do WEBHOOK_URL: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    console.error('[webhook] falha ao notificar WEBHOOK_URL:', err);
  }
}
