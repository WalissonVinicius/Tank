package jsmath

import "math"

// Porte de `atan` e `__ieee754_atan2` do fdlibm — os `Math.atan`/`Math.atan2` do V8.
//
// O Go herdou o `atan` do Cephes; medido nesta tarefa, 21,48% dos `math.Atan2` divergem de
// `Math.atan2`. Quem depende disso é `direcaoDeMovimento` do protocolo, que transforma as quatro
// teclas de direção num ângulo de mundo — a mesma conta tem que rodar no servidor e no cliente.

var atanHi = [4]float64{
	4.63647609000806093515e-01, // atan(0.5)
	7.85398163397448278999e-01, // atan(1.0)
	9.82793723247329054082e-01, // atan(1.5)
	1.57079632679489655800e+00, // atan(inf)
}

var atanLo = [4]float64{
	2.26987774529616870924e-17,
	3.06161699786838301793e-17,
	1.39033110312309984516e-17,
	6.12323399573676603587e-17,
}

var aT = [11]float64{
	3.33333333333329318027e-01,
	-1.99999999998764832476e-01,
	1.42857142725034663711e-01,
	-1.11111104054623557880e-01,
	9.09088713343650656196e-02,
	-7.69187620504482999495e-02,
	6.66107313738753120669e-02,
	-5.83357013379057348645e-02,
	4.97687799461593236017e-02,
	-3.65315727442169155270e-02,
	1.62858201153657823623e-02,
}

const huge = 1.0e300

// Atan é `Math.atan`.
func Atan(x float64) float64 {
	hx := int32(highWord(x))
	ix := hx & 0x7fffffff

	if ix >= 0x44100000 { // |x| ≥ 2^66: atan(x) = ±π/2
		if ix > 0x7ff00000 || (ix == 0x7ff00000 && lowWord(x) != 0) {
			return x + x // NaN
		}
		if hx > 0 {
			return atanHi[3] + math.Float64frombits(0x0080000000000000)
		}
		return -atanHi[3] - math.Float64frombits(0x0080000000000000)
	}

	id := -1
	if ix < 0x3fdc0000 { // |x| < 0,4375
		if ix < 0x3e400000 { // |x| < 2^-27: atan(x) = x
			if huge+x > 1.0 {
				return x
			}
		}
	} else {
		x = math.Abs(x)
		switch {
		case ix < 0x3ff30000: // |x| < 1,1875
			if ix < 0x3fe60000 { // 7/16 ≤ |x| < 11/16
				id = 0
				x = (2.0*x - 1.0) / (2.0 + x)
			} else { // 11/16 ≤ |x| < 19/16
				id = 1
				x = (x - 1.0) / (x + 1.0)
			}
		case ix < 0x40038000: // |x| < 2,4375
			id = 2
			x = (x - 1.5) / (1.0 + 1.5*x)
		default: // 2,4375 ≤ |x| < 2^66
			id = 3
			x = -1.0 / x
		}
	}

	z := x * x
	w := z * z
	s1 := z * (aT[0] + w*(aT[2]+w*(aT[4]+w*(aT[6]+w*(aT[8]+w*aT[10])))))
	s2 := w * (aT[1] + w*(aT[3]+w*(aT[5]+w*(aT[7]+w*aT[9]))))
	if id < 0 {
		return x - x*(s1+s2)
	}
	z = atanHi[id] - ((x*(s1+s2) - atanLo[id]) - x)
	if hx < 0 {
		return -z
	}
	return z
}

const (
	tiny  = 1.0e-300
	pi    = 3.14159265358979311600e+00
	piLo  = 1.2246467991473531772e-16
	pio2H = 1.57079632679489655800e+00
	pio2L = 6.12323399573676603587e-17
)

// Atan2 é `Math.atan2`.
func Atan2(y, x float64) float64 {
	hx := int32(highWord(x))
	ix := hx & 0x7fffffff
	lx := lowWord(x)
	hy := int32(highWord(y))
	iy := hy & 0x7fffffff
	ly := lowWord(y)

	if (ix|int32((lx|-lx)>>31)) > 0x7ff00000 || (iy|int32((ly|-ly)>>31)) > 0x7ff00000 {
		return x + y // NaN em qualquer entrada
	}
	if hx == 0x3ff00000 && lx == 0 { // x = 1: atan2(y,1) = atan(y)
		return Atan(y)
	}

	m := ((hy >> 31) & 1) | ((hx >> 30) & 2) // 2·sinal(x) + sinal(y)

	if iy|int32(ly) == 0 { // y = 0
		switch m {
		case 0, 1: // atan(±0, +x) = ±0
			return y
		case 2: // atan(+0, -x) = +π
			return pi + tiny
		default: // atan(-0, -x) = -π
			return -pi - tiny
		}
	}
	if ix|int32(lx) == 0 { // x = 0: ±π/2
		if hy < 0 {
			return -pio2H - tiny
		}
		return pio2H + tiny
	}

	if ix == 0x7ff00000 && lx == 0 { // x infinito
		if iy == 0x7ff00000 && ly == 0 {
			switch m {
			case 0:
				return pi/4 + tiny
			case 1:
				return -pi/4 - tiny
			case 2:
				return 3.0*pi/4 + tiny
			default:
				return -3.0*pi/4 - tiny
			}
		}
		switch m {
		case 0:
			return 0
		case 1:
			return math.Copysign(0, -1)
		case 2:
			return pi + tiny
		default:
			return -pi - tiny
		}
	}
	if iy == 0x7ff00000 && ly == 0 { // y infinito, x finito
		if hy < 0 {
			return -pio2H - tiny
		}
		return pio2H + tiny
	}

	k := (iy - ix) >> 20
	var z float64
	switch {
	case k > 60: // |y/x| enorme
		z = pio2H + 0.5*piLo
		m &= 1 // o sinal de x deixa de importar: o resultado já é ±π/2
	case hx < 0 && k < -60: // |y/x| minúsculo com x negativo
		z = 0.0
	default:
		z = Atan(math.Abs(y / x))
	}
	switch m {
	case 0:
		return z
	case 1:
		return math.Float64frombits(math.Float64bits(z) | 1<<63) // -z, preservando -0
	case 2:
		return pi - (z - piLo)
	default:
		return (z - piLo) - pi
	}
}
