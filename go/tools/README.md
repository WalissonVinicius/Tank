# `tools/`

`go_js_wasm_exec.bat` é o que o `go test` procura no PATH para EXECUTAR um binário compilado para
`js/wasm`: o Go invoca `$GOOS_$GOARCH_exec` e passa o caminho do `.wasm`. A instalação do Go traz
a versão shell (`lib/wasm/go_js_wasm_exec`), que o Windows não sabe executar — este `.bat` é a
mesma coisa em duas linhas.

Só é usado no caminho WASM (ver `../run-go.sh`). Em Linux/amd64 nada disso entra em cena.
