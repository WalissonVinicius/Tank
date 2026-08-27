#!/usr/bin/env bash
# Embrulho do toolchain Go para esta pasta.
#
# Em Linux/macOS você não precisa dele: `go build ./...` e `go test ./...` funcionam direto.
# Ele existe por causa de duas peculiaridades de máquinas Windows com Smart App Control:
#
#  1. O Smart App Control bloqueia a EXECUÇÃO de binários recém-compilados e sem assinatura —
#     inclusive os que o `go test` gera em pasta temporária. Por isso o alvo padrão aqui é
#     `js/wasm`, que roda dentro do Node (já assinado e confiável). A aritmética de ponto
#     flutuante do WebAssembly é IEEE-754 estrita e, como a do amd64, não contrai `a*b + c` em
#     FMA: a paridade medida por um caminho vale para o outro.
#  2. O carregador WASM do Go limita argumentos + variáveis de ambiente a 4 KB somados, e o
#     ambiente de um shell de desenvolvimento passa disso. Daí o `env -i` com o mínimo.
#
# Uso:
#   ./run-go.sh test ./...
#   ./run-go.sh build -o bin/paridade.wasm ./cmd/paridade
#   GOOS_ALVO=linux GOARCH_ALVO=amd64 ./run-go.sh build -o bin/paridade ./cmd/paridade
set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"

# Onde está o Go: escape manual → instalação no PATH → toolchain baixado no home.
if [ -n "${GOROOT_LOCAL:-}" ]; then
  RAIZ_GO="$GOROOT_LOCAL"
elif command -v go >/dev/null 2>&1; then
  RAIZ_GO="$(dirname "$(dirname "$(command -v go)")")"
elif [ -d "$HOME/.toolchain/go/bin" ]; then
  RAIZ_GO="$HOME/.toolchain/go"
else
  echo "Go não encontrado. Instale-o, baixe o zip oficial para ~/.toolchain/go, ou aponte GOROOT_LOCAL." >&2
  exit 1
fi

PERFIL="${USERPROFILE:-$HOME}"

exec env -i \
  PATH="$RAIZ_GO/bin:$AQUI/tools:/c/Program Files/nodejs:/usr/bin:/usr/local/bin:/bin" \
  GOOS="${GOOS_ALVO:-js}" GOARCH="${GOARCH_ALVO:-wasm}" \
  GOCACHE="${GOCACHE:-$PERFIL/AppData/Local/go-build}" \
  GOMODCACHE="${GOMODCACHE:-$PERFIL/go/pkg/mod}" \
  GOPATH="${GOPATH:-$PERFIL/go}" \
  USERPROFILE="$PERFIL" \
  HOME="$HOME" \
  go "$@"
