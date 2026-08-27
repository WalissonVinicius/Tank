package persist

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"
)

// Porte de `apps/server/src/persist/webhook.ts`: dispara o ranking final para o n8n postar no
// canal. Falha de webhook NUNCA derruba a partida — qualquer erro (rede, DNS, timeout, 4xx/5xx) é
// só registrado.

// EnviarWebhook posta o resumo da partida em `WEBHOOK_URL`. Sem a variável, não faz nada.
func EnviarWebhook(payload any) {
	url := os.Getenv("WEBHOOK_URL")
	if url == "" {
		return
	}
	corpo, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[webhook] payload inválido: %v", err)
		return
	}

	ctx, cancelar := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelar()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(corpo))
	if err != nil {
		log.Printf("[webhook] requisição inválida: %v", err)
		return
	}
	req.Header.Set("content-type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("[webhook] falha ao notificar WEBHOOK_URL: %v", err)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("[webhook] resposta não-ok do WEBHOOK_URL: %d", resp.StatusCode)
	}
}
