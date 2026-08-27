package server

import (
	"math/rand/v2"
	"sort"
	"sync"
)

// Hub é o cadastro de salas vivas — o equivalente do `matchMaker` do Colyseus, reduzido ao que o
// jogo usa: sortear um código livre, achar sala por código e listar as abertas.
//
// A LISTAGEM SAI DAQUI, e não de um registro paralelo mantido à parte: cada sala publica os
// próprios números (quantos humanos, quantos bots, em que fase) sempre que eles mudam, e a lista é
// uma leitura desse mesmo cadastro. Um registro à parte teria que ser mantido em sincronia com
// criação, entrada, saída e morte de sala — três caminhos a mais para ficar desatualizado.
type Hub struct {
	mu           sync.RWMutex
	salas        map[string]*Sala
	metadados    map[string]MetadadosDaSala
	persistencia Persistencia
}

// MetadadosDaSala é o que cada sala publica para a tela de entrada montar a vitrine.
type MetadadosDaSala struct {
	Codigo   string
	Humanos  int
	Bots     int
	Fase     string
	Conexoes int
}

// SalaAberta é uma sala como ela aparece na tela de entrada. Espelha `SalaAberta` do protocolo.
type SalaAberta struct {
	Codigo    string `json:"codigo"`
	Humanos   int    `json:"humanos"`
	Bots      int    `json:"bots"`
	Livres    int    `json:"livres"`
	EmPartida bool   `json:"emPartida"`
}

// NovoHub monta o cadastro. `persistencia` pode ser nil (servidor sem banco).
func NovoHub(p Persistencia) *Hub {
	return &Hub{
		salas:        map[string]*Sala{},
		metadados:    map[string]MetadadosDaSala{},
		persistencia: p,
	}
}

// CriarSala sorteia um código livre e sobe a sala.
func (h *Hub) CriarSala(opcoes OpcoesDaSala) *Sala {
	h.mu.Lock()
	codigo := h.codigoLivreSemTrava()
	// Reserva o código ANTES de a sala existir: sem isso duas criações simultâneas poderiam
	// sortear o mesmo código, e a segunda sobrescreveria a primeira no mapa.
	h.salas[codigo] = nil
	h.mu.Unlock()

	sala := NovaSala(h, codigo, opcoes)

	h.mu.Lock()
	h.salas[codigo] = sala
	h.mu.Unlock()
	return sala
}

func (h *Hub) codigoLivreSemTrava() string {
	for {
		codigo := sortearCodigo()
		if _, existe := h.salas[codigo]; !existe {
			return codigo
		}
	}
}

// sortearCodigo espelha `randomRoomCode`: 4 caracteres do alfabeto sem I, O, 0 nem 1.
func sortearCodigo() string {
	b := make([]byte, TamanhoDoCodigo)
	for i := range b {
		b[i] = AlfabetoDoCodigo[rand.IntN(len(AlfabetoDoCodigo))]
	}
	return string(b)
}

// Sala devolve a sala do código, se ela existir e já estiver de pé.
func (h *Hub) Sala(codigo string) *Sala {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.salas[codigo]
}

// SalaPorToken procura a sala que emitiu um token de reconexão. O token carrega o código no
// prefixo justamente para que esta busca não precise varrer todas as salas.
func (h *Hub) SalaPorToken(token string) *Sala {
	codigo := codigoDoToken(token)
	if codigo == "" {
		return nil
	}
	return h.Sala(codigo)
}

func (h *Hub) removerSala(codigo string) {
	h.mu.Lock()
	delete(h.salas, codigo)
	delete(h.metadados, codigo)
	h.mu.Unlock()
}

func (h *Hub) publicar(m MetadadosDaSala) {
	h.mu.Lock()
	h.metadados[m.Codigo] = m
	h.mu.Unlock()
}

// SalasAbertas devolve as salas em que ainda dá para entrar, na ordem em que aparecem na tela:
// primeiro as que ainda não começaram (é onde se entra jogando), depois as em partida (onde se
// entra assistindo); dentro de cada grupo, as mais cheias primeiro — sala com gente é mais
// convidativa que sala vazia.
//
// Fica de fora quem já acabou (`gameover`, ninguém mais entra) e quem não tem nem vaga de
// espectador.
func (h *Hub) SalasAbertas() []SalaAberta {
	h.mu.RLock()
	metas := make([]MetadadosDaSala, 0, len(h.metadados))
	for _, m := range h.metadados {
		metas = append(metas, m)
	}
	h.mu.RUnlock()

	salas := make([]SalaAberta, 0, len(metas))
	for _, m := range metas {
		if m.Fase == string(FaseGameOver) {
			continue
		}
		if m.Conexoes >= MaxClientes {
			continue
		}
		ocupadas := m.Humanos + m.Bots
		if ocupadas > VagasPorSala {
			ocupadas = VagasPorSala
		}
		emPartida := m.Fase != string(FaseLobby)
		// Sala cheia e parada no lobby não recebe ninguém: a vaga só abre quando alguém sai. Em
		// partida a lotação não impede — quem chega assiste e entra na rodada seguinte.
		if !emPartida && ocupadas >= VagasPorSala {
			continue
		}
		salas = append(salas, SalaAberta{
			Codigo: m.Codigo, Humanos: m.Humanos, Bots: m.Bots,
			Livres: VagasPorSala - ocupadas, EmPartida: emPartida,
		})
	}

	sort.SliceStable(salas, func(i, j int) bool {
		a, b := salas[i], salas[j]
		if a.EmPartida != b.EmPartida {
			return !a.EmPartida
		}
		if a.Humanos != b.Humanos {
			return a.Humanos > b.Humanos
		}
		return a.Codigo < b.Codigo
	})
	return salas
}

// Quantidade devolve quantas salas estão vivas (usado por `/healthz`).
func (h *Hub) Quantidade() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.salas)
}
