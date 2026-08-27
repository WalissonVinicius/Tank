package jsmath

import "math"

// Porte de `__kernel_rem_pio2` do fdlibm — a redução de Payne–Hanek usada quando |x| é grande
// demais para a subtração direta de múltiplos de π/2 sobrar algum dígito significativo.
//
// A ideia: multiplicar x pela expansão binária de 2/π guardada em blocos exatos de 24 bits,
// ficar só com a parte fracionária do produto e devolvê-la de volta a radianos. É aritmética
// inteira disfarçada de ponto flutuante — cada `f[i]` cabe em 24 bits e cada produto parcial é
// exato, então o resultado não depende de nenhuma escolha de arredondamento.
//
// A simulação do jogo nunca chega aqui (os ângulos vivem em [-π, π]), mas sem esta função
// `Sin`/`Cos` não seriam substitutos totais de `Math.sin`/`Math.cos`, e um dia alguém passaria
// um ângulo grande sem desconfiar.

const (
	two24  = 1.67772160000000000000e+07 // 2^24
	twon24 = 5.96046447753906250000e-08 // 2^-24
)

// Expansão binária de 2/π em blocos de 24 bits, do mais significativo para o menos. A precisão
// vem daqui: são 66 blocos ≈ 1584 bits, o suficiente para reduzir qualquer float64.
//
// `TestTabelaDoisSobrePi` confere cada bloco contra `math/big` — a tabela não é confiada de
// memória nem de cópia.
var twoOverPi = [66]int32{
	0xA2F983, 0x6E4E44, 0x1529FC, 0x2757D1, 0xF534DD, 0xC0DB62,
	0x95993C, 0x439041, 0xFE5163, 0xABDEBB, 0xC561B7, 0x246E3A,
	0x424DD2, 0xE00649, 0x2EEA09, 0xD1921C, 0xFE1DEB, 0x1CB129,
	0xA73EE8, 0x8235F5, 0x2EBB44, 0x84E99C, 0x7026B4, 0x5F7E41,
	0x3991D6, 0x398353, 0x39F49C, 0x845F8B, 0xBDF928, 0x3B1FF8,
	0x97FFDE, 0x05980F, 0xEF2F11, 0x8B5A0A, 0x6D1F6D, 0x367ECF,
	0x27CB09, 0xB74F46, 0x3F669E, 0x5FEA2D, 0x7527BA, 0xC7EBE5,
	0xF17B3D, 0x0739F7, 0x8A5292, 0xEA6BFB, 0x5FB11F, 0x8D5D08,
	0x560330, 0x46FC7B, 0x6BABF0, 0xCFBC20, 0x9AF436, 0x1DA9E3,
	0x91615E, 0xE61B08, 0x659985, 0x5F14A0, 0x68408D, 0xFFD880,
	0x4D7327, 0x310606, 0x1556CA, 0x73A8C9, 0x60E27B, 0xC08C6B,
}

// π/2 em blocos de 24 bits — o caminho de volta de "fração de 2/π" para radianos.
var pio2Chunks = [8]float64{
	1.57079625129699707031e+00,
	7.54978941586159635335e-08,
	5.39030252995776476554e-15,
	3.28200341580791294123e-22,
	1.27065575308067607349e-29,
	1.22933308981111328932e-36,
	2.73370053816464559624e-44,
	2.16741683877804819444e-51,
}

// kernelRemPio2 recebe |x| fatiado em `nx` blocos de 24 bits (`x[i]`, com expoente base `e0`) e
// escreve em `y` o resto módulo π/2 em precisão dupla-dupla. Devolve `n & 7`, o quadrante.
//
// Só o caso `prec == 2` do fdlibm original está aqui: é o único que `sin`/`cos`/`tan` usam.
func kernelRemPio2(x, y []float64, e0, nx int) int32 {
	const jk = 4 // blocos de 2/π por termo, para prec == 2
	const jp = jk

	var f [20]float64
	var q [20]float64
	var fq [20]float64
	var iq [20]int32

	jx := nx - 1
	jv := (e0 - 3) / 24
	if jv < 0 {
		jv = 0
	}
	q0 := e0 - 24*(jv+1)

	// f[] recebe a janela de 2/π alinhada com o expoente de x.
	j := jv - jx
	m := jx + jk
	for i := 0; i <= m; i, j = i+1, j+1 {
		if j < 0 {
			f[i] = 0
		} else {
			f[i] = float64(twoOverPi[j])
		}
	}

	// q[] = x × f[], por convolução. Cada produto é exato (24 bits × 24 bits em float64).
	for i := 0; i <= jk; i++ {
		fw := 0.0
		for j := 0; j <= jx; j++ {
			fw += x[j] * f[jx+i-j]
		}
		q[i] = fw
	}

	jz := jk
	var n, ih int32
	var z float64

recompute:
	for {
		// Destila q[] em blocos inteiros de 24 bits, do menos para o mais significativo.
		z = q[jz]
		for i, j := 0, jz; j > 0; i, j = i+1, j-1 {
			fw := float64(int32(twon24 * z))
			iq[i] = int32(z - two24*fw)
			z = q[j-1] + fw
		}

		// Parte inteira do produto → quadrante.
		z = math.Ldexp(z, q0)
		z -= 8.0 * math.Floor(z*0.125) // descarta múltiplos de 8: só o quadrante importa
		n = int32(z)
		z -= float64(n)
		ih = 0
		switch {
		case q0 > 0: // o último bloco ainda tem bits inteiros
			i := iq[jz-1] >> (24 - q0)
			n += i
			iq[jz-1] -= i << (24 - q0)
			ih = iq[jz-1] >> (23 - q0)
		case q0 == 0:
			ih = iq[jz-1] >> 23
		default:
			if z >= 0.5 {
				ih = 2
			}
		}

		if ih > 0 { // fração > 0,5: usa o complemento e soma 1 ao quadrante
			n++
			carry := int32(0)
			for i := 0; i < jz; i++ {
				j := iq[i]
				if carry == 0 {
					if j != 0 {
						carry = 1
						iq[i] = 0x1000000 - j
					}
				} else {
					iq[i] = 0xffffff - j
				}
			}
			if q0 > 0 {
				switch q0 {
				case 1:
					iq[jz-1] &= 0x7fffff
				case 2:
					iq[jz-1] &= 0x3fffff
				}
			}
			if ih == 2 {
				z = 1 - z
				if carry != 0 {
					z -= math.Ldexp(1, q0)
				}
			}
		}

		// Cancelamento total: precisa de mais blocos de 2/π para achar um dígito não nulo.
		if z == 0 {
			j := int32(0)
			for i := jz - 1; i >= jk; i-- {
				j |= iq[i]
			}
			if j == 0 {
				k := 1
				for iq[jk-k] == 0 {
					k++
				}
				for i := jz + 1; i <= jz+k; i++ {
					f[jx+i] = float64(twoOverPi[jv+i])
					fw := 0.0
					for j := 0; j <= jx; j++ {
						fw += x[j] * f[jx+i-j]
					}
					q[i] = fw
				}
				jz += k
				continue recompute
			}
		}
		break
	}

	// Poda os blocos nulos à direita, ou fatia z em mais um bloco de 24 bits.
	if z == 0 {
		jz--
		q0 -= 24
		for iq[jz] == 0 {
			jz--
			q0 -= 24
		}
	} else {
		z = math.Ldexp(z, -q0)
		if z >= two24 {
			fw := float64(int32(twon24 * z))
			iq[jz] = int32(z - two24*fw)
			jz++
			q0 += 24
			iq[jz] = int32(fw)
		} else {
			iq[jz] = int32(z)
		}
	}

	// Blocos inteiros de volta a ponto flutuante, e depois de volta a radianos via π/2.
	fw := math.Ldexp(1, q0)
	for i := jz; i >= 0; i-- {
		q[i] = fw * float64(iq[i])
		fw *= twon24
	}

	for i := jz; i >= 0; i-- {
		fw = 0.0
		for k := 0; k <= jp && k <= jz-i; k++ {
			fw += pio2Chunks[k] * q[i+k]
		}
		fq[jz-i] = fw
	}

	fw = 0.0
	for i := jz; i >= 0; i-- {
		fw += fq[i]
	}
	if ih == 0 {
		y[0] = fw
	} else {
		y[0] = -fw
	}
	fw = fq[0] - fw
	for i := 1; i <= jz; i++ {
		fw += fq[i]
	}
	if ih == 0 {
		y[1] = fw
	} else {
		y[1] = -fw
	}

	return n & 7
}
