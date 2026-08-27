// Lado TypeScript da serialização canônica — o espelho de `go/paridade/canon.go`.
//
// Mesma regra: nenhum número vira texto decimal. Todo float64 entra no resumo como os 8 bytes do
// seu padrão de bits IEEE-754, em little-endian. Comparação exata ou nada.
import { createHash } from 'node:crypto';

export const SEC = { maze: 0, spawns: 1, sim: 2, eventos: 3, bots: 4, powerups: 5 };
export const NOMES_SECAO = ['labirinto', 'spawns', 'simulacao', 'eventos', 'bots', 'powerups'];

const utf8 = new TextEncoder();

/** Resumidor: um SHA-256 por seção, alimentado com bytes crus. */
export class Resumidor {
  constructor() {
    this.h = NOMES_SECAO.map(() => createHash('sha256'));
    // Buffer de trabalho reaproveitado: são milhões de registros por varredura, e alocar oito
    // bytes em cada um coloca o coletor de lixo no caminho crítico da medição.
    this.buf = Buffer.allocUnsafe(8);
    this.sep = Buffer.from([0x1e]);
    this.nul = Buffer.from([0]);
    this.um = Buffer.from([1]);
    this.zero = Buffer.from([0]);
  }

  registro(sec, rotulo, ...tokens) {
    const h = this.h[sec];
    h.update(utf8.encode(rotulo));
    h.update(this.nul);
    for (const tk of tokens) {
      switch (typeof tk) {
        case 'number':
          // Inteiro e float64 têm codificações diferentes de propósito, espelhando os tipos `int`
          // e `float64` do Go. Quem decide qual é qual é o `Number.isInteger`? NÃO: seria uma
          // armadilha, porque `2.0` é inteiro em JavaScript e `float64` no Go. Quem decide é o
          // chamador, via `f()` e `i()` abaixo.
          throw new Error('use f() para float64 e i() para int — número solto é ambíguo');
        case 'string':
          h.update(utf8.encode(tk));
          h.update(this.nul);
          break;
        case 'boolean':
          h.update(tk ? this.um : this.zero);
          break;
        case 'object':
          if (tk.tipo === 'f') {
            this.buf.writeDoubleLE(tk.v, 0);
            h.update(this.buf);
          } else if (tk.tipo === 'i') {
            this.buf.writeBigInt64LE(BigInt(tk.v), 0);
            h.update(this.buf);
          } else {
            throw new Error(`token inválido: ${JSON.stringify(tk)}`);
          }
          break;
        default:
          throw new Error(`token de tipo não suportado: ${typeof tk}`);
      }
    }
    h.update(this.sep);
  }

  resumos() {
    return this.h.map((h) => h.digest('hex'));
  }
}

/** Detalhador: uma linha de texto por registro, com os floats em hexadecimal. */
export class Detalhador {
  constructor() {
    this.linhas = [];
    this.buf = Buffer.allocUnsafe(8);
  }

  registro(sec, rotulo, ...tokens) {
    const partes = [NOMES_SECAO[sec], rotulo];
    for (const tk of tokens) {
      if (typeof tk === 'string') partes.push(tk);
      else if (typeof tk === 'boolean') partes.push(tk ? '1' : '0');
      else if (tk && tk.tipo === 'f') {
        this.buf.writeDoubleBE(tk.v, 0);
        partes.push(this.buf.toString('hex'));
      } else if (tk && tk.tipo === 'i') partes.push(String(tk.v));
      else throw new Error(`token inválido: ${JSON.stringify(tk)}`);
    }
    this.linhas.push(partes.join(' '));
  }

  texto() {
    return this.linhas.join('\n') + '\n';
  }
}

// Marcadores de tipo. São objetos e não números soltos porque `float64` e `int` têm codificações
// diferentes no resumo, e em JavaScript `3` e `3.0` são o mesmo valor — sem o marcador, o lado JS
// escolheria a codificação errada em metade dos campos e o resumo divergiria sem nenhum bug real
// na simulação.
export const f = (v) => ({ tipo: 'f', v });
export const i = (v) => ({ tipo: 'i', v });
