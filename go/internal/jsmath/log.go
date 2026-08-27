package jsmath

import "math"

// Porte de `__ieee754_log` do fdlibm, que é o `Math.log` do V8.
//
// O `math.Log` do Go resolve o mesmo problema por outro caminho: normaliza com `Frexp` e
// compara contra √2/2, enquanto o fdlibm normaliza com máscara de bits e tem um ramo dedicado a
// |f| < 2^-20. Medido nesta tarefa: 1,27% dos valores saem diferentes.
const (
	ln2Hi = 6.93147180369123816490e-01
	ln2Lo = 1.90821492927058770002e-10
	two54 = 1.80143985094819840000e+16

	lg1 = 6.666666666666735130e-01
	lg2 = 3.999999999940941908e-01
	lg3 = 2.857142874366239149e-01
	lg4 = 2.222219843214978396e-01
	lg5 = 1.818357216161805012e-01
	lg6 = 1.531383769920937332e-01
	lg7 = 1.479819860511658591e-01
)

// Log é `Math.log` (logaritmo natural).
func Log(x float64) float64 {
	hx := int32(highWord(x))
	lx := lowWord(x)

	k := int32(0)
	if hx < 0x00100000 { // subnormal ou zero ou negativo
		if (hx&0x7fffffff)|int32(lx) == 0 {
			return math.Inf(-1) // log(±0) = -∞
		}
		if hx < 0 {
			return math.NaN() // log(negativo) = NaN
		}
		k -= 54
		x *= two54 // reescala o subnormal
		hx = int32(highWord(x))
	}
	if hx >= 0x7ff00000 { // ±Inf ou NaN
		return x + x
	}

	k += (hx >> 20) - 1023
	hx &= 0x000fffff
	i := (hx + 0x95f64) & 0x100000
	x = withHighWord(x, uint32(hx|(i^0x3ff00000))) // normaliza para [√2/2, √2)
	k += i >> 20
	f := x - 1.0

	if (0x000fffff & (2 + hx)) < 3 { // -2^-20 ≤ f < 2^-20: polinômio curto
		if f == 0 {
			if k == 0 {
				return 0
			}
			dk := float64(k)
			return dk*ln2Hi + dk*ln2Lo
		}
		r := f * f * (0.5 - 0.33333333333333333*f)
		if k == 0 {
			return f - r
		}
		dk := float64(k)
		return dk*ln2Hi - ((r - dk*ln2Lo) - f)
	}

	s := f / (2.0 + f)
	dk := float64(k)
	z := s * s
	i = hx - 0x6147a
	w := z * z
	j := 0x6b851 - hx
	t1 := w * (lg2 + w*(lg4+w*lg6))
	t2 := z * (lg1 + w*(lg3+w*(lg5+w*lg7)))
	i |= j
	r := t2 + t1
	if i > 0 {
		hfsq := 0.5 * f * f
		if k == 0 {
			return f - (hfsq - s*(hfsq+r))
		}
		return dk*ln2Hi - ((hfsq - (s*(hfsq+r) + dk*ln2Lo)) - f)
	}
	if k == 0 {
		return f - s*(f-r)
	}
	return dk*ln2Hi - ((s*(f-r) - dk*ln2Lo) - f)
}
