// Comando `servidor` — o Tank Ricochete inteiro numa porta só: cliente estático, lista de salas,
// WebSocket do jogo e o banco.
//
// Substitui `apps/server` (Node + Colyseus). Mesmas rotas, mesmo formato de snapshot, mesmo banco.
package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/simplex/tank/go/persist"
	"github.com/simplex/tank/go/server"
)

func main() {
	porta := flag.String("porta", valorOuPadrao("PORT", "3000"), "porta HTTP")
	dist := flag.String("client", valorOuPadrao("CLIENT_DIST", padraoDoCliente()), "pasta do build do cliente")
	dados := flag.String("dados", valorOuPadrao("DATA_DIR", "data"), "pasta do banco SQLite")
	semBanco := flag.Bool("sem-banco", false, "sobe sem persistência (útil para teste de carga)")
	flag.Parse()

	var gravador *Gravador
	if !*semBanco {
		banco, err := persist.Abrir(*dados)
		if err != nil {
			log.Printf("[persist] sem banco (%v) — a partida roda, o ranking não é gravado", err)
		} else {
			defer func() { _ = banco.Fechar() }()
			gravador = NovoGravador(banco)
		}
	}

	opcoes := server.Opcoes{Endereco: ":" + *porta, ClientDist: *dist}
	// Interface com valor nil dentro não é nil: sem este desvio a sala acharia que tem
	// persistência e chamaria um ponteiro vazio no fim da primeira partida.
	if gravador != nil {
		opcoes.Persistente = gravador
	}

	srv := server.NovoServidor(opcoes)

	ctx, parar := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer parar()

	log.Printf("Tank Ricochete rodando em http://localhost:%s", *porta)
	if err := srv.Escutar(ctx); err != nil {
		log.Fatalf("falha ao iniciar o servidor: %v", err)
	}
	log.Println("encerrado com calma")
}

func valorOuPadrao(env, padrao string) string {
	if v := os.Getenv(env); v != "" {
		return v
	}
	return padrao
}

// padraoDoCliente aponta para `apps/client/dist` a partir da raiz do repositório, que é onde o
// `pnpm build` deixa o cliente. No contêiner o caminho vem por `CLIENT_DIST`.
func padraoDoCliente() string {
	return filepath.Join("apps", "client", "dist")
}
