import Decimal from 'decimal.js'
import {
  calcularPrecioPreservandoMargen,
  calcularViolacionCostoPvp,
  debeBackCalcularCosto,
  backcalcularCostoYCascada,
  calcularCostoBsBackCalculado,
} from '../producto-precio-gating'

describe('calcularPrecioPreservandoMargen', () => {
  it('calcula el PVP proyectado preservando el margen configurado (costo=10, margen=50%)', () => {
    expect(calcularPrecioPreservandoMargen(10, 50)).toBe(15)
  })

  it('calcula el PVP proyectado con un margen distinto (costo=20, margen=25%)', () => {
    expect(calcularPrecioPreservandoMargen(20, 25)).toBe(25)
  })

  it('nunca retorna un valor negativo aunque el margen sea muy negativo', () => {
    expect(calcularPrecioPreservandoMargen(10, -200)).toBe(0)
  })
})

describe('calcularViolacionCostoPvp', () => {
  it('marca violacion cuando el nuevo costo supera el PVP actual', () => {
    expect(calcularViolacionCostoPvp(12, 10)).toBe(true)
  })

  it('marca violacion cuando el nuevo costo iguala el PVP actual (regla #7: costo >= pvp)', () => {
    expect(calcularViolacionCostoPvp(10, 10)).toBe(true)
  })

  it('no marca violacion cuando el nuevo costo es menor al PVP actual', () => {
    expect(calcularViolacionCostoPvp(8, 10)).toBe(false)
  })
})

describe('debeBackCalcularCosto', () => {
  it('dispara cuando el costo esta vacio, hay margen y PVP detal cargados, y no es combo', () => {
    expect(
      debeBackCalcularCosto({ costoUsd: '', esCombo: false, margenDetalPct: '50', pvpDetalUsd: 150 })
    ).toBe(true)
  })

  it('no dispara cuando el costo ya tiene el valor "0" explicito (\'0\' no es vacio)', () => {
    expect(
      debeBackCalcularCosto({ costoUsd: '0', esCombo: false, margenDetalPct: '50', pvpDetalUsd: 150 })
    ).toBe(false)
  })

  it('no dispara cuando el margen DETAL esta ausente', () => {
    expect(
      debeBackCalcularCosto({ costoUsd: '', esCombo: false, margenDetalPct: '', pvpDetalUsd: 150 })
    ).toBe(false)
  })

  it('no dispara cuando no hay PVP ni precio final DETAL cargado', () => {
    expect(
      debeBackCalcularCosto({ costoUsd: '', esCombo: false, margenDetalPct: '50', pvpDetalUsd: 0 })
    ).toBe(false)
  })

  it('no dispara para combos aunque las demas condiciones se cumplan', () => {
    expect(
      debeBackCalcularCosto({ costoUsd: '', esCombo: true, margenDetalPct: '50', pvpDetalUsd: 150 })
    ).toBe(false)
  })
})

describe('backcalcularCostoYCascada', () => {
  it('ejemplo canonico: pvp detal 150, margen detal 50%, mayor 25%, especial 0.01% -> costo 100, mayor 125, especial 100.01', () => {
    const resultado = backcalcularCostoYCascada({
      pvpDetalUsd: new Decimal(150),
      margenDetalPct: new Decimal(50),
      margenMayorPct: new Decimal(25),
      margenEspecialPct: new Decimal(0.01),
      ultimaFuenteMayor: 'margen',
      ultimaFuenteEspecial: 'margen',
    })
    expect(resultado.costoUsd.toFixed(2)).toBe('100.00')
    expect(resultado.mayorUsd?.toFixed(2)).toBe('125.00')
    expect(resultado.especialUsd?.toFixed(2)).toBe('100.01')
  })

  it('desde precio final con IVA 16%: final 174 -> pvp intermedio 150 -> costo 100', () => {
    const pvpDesdeFinal = new Decimal(174).dividedBy(new Decimal(1).plus(new Decimal(16).dividedBy(100)))
    expect(pvpDesdeFinal.toFixed(2)).toBe('150.00')

    const resultado = backcalcularCostoYCascada({
      pvpDetalUsd: pvpDesdeFinal,
      margenDetalPct: new Decimal(50),
      margenMayorPct: new Decimal(0),
      margenEspecialPct: new Decimal(0),
      ultimaFuenteMayor: null,
      ultimaFuenteEspecial: null,
    })
    expect(resultado.costoUsd.toFixed(2)).toBe('100.00')
  })

  it('margen detal 0% -> costo iguala el pvp (sin division real)', () => {
    const resultado = backcalcularCostoYCascada({
      pvpDetalUsd: new Decimal(80),
      margenDetalPct: new Decimal(0),
      margenMayorPct: new Decimal(0),
      margenEspecialPct: new Decimal(0),
      ultimaFuenteMayor: null,
      ultimaFuenteEspecial: null,
    })
    expect(resultado.costoUsd.toFixed(2)).toBe('80.00')
  })

  it('preserva el precio tipeado a mano (ultima fuente = precio) y solo cascada el nivel en margen', () => {
    const resultado = backcalcularCostoYCascada({
      pvpDetalUsd: new Decimal(150),
      margenDetalPct: new Decimal(50),
      margenMayorPct: new Decimal(25),
      margenEspecialPct: new Decimal(10),
      ultimaFuenteMayor: 'precio',
      ultimaFuenteEspecial: 'margen',
    })
    expect(resultado.mayorUsd).toBeNull()
    expect(resultado.especialUsd?.toFixed(2)).toBe('110.00')
  })

  it('clampa defensivamente un margen de nivel negativo a 0% antes de cascadear', () => {
    const resultado = backcalcularCostoYCascada({
      pvpDetalUsd: new Decimal(150),
      margenDetalPct: new Decimal(50),
      margenMayorPct: new Decimal(-10),
      margenEspecialPct: new Decimal(0),
      ultimaFuenteMayor: 'margen',
      ultimaFuenteEspecial: null,
    })
    expect(resultado.mayorUsd?.toFixed(2)).toBe('100.00')
  })
})

describe('calcularCostoBsBackCalculado', () => {
  it('retorna null cuando la tasa es 0 (guard, sin escribir un Bs invalido)', () => {
    expect(calcularCostoBsBackCalculado(new Decimal(100), new Decimal(0))).toBeNull()
  })

  it('calcula el equivalente en Bs cuando la tasa es valida', () => {
    const bs = calcularCostoBsBackCalculado(new Decimal(100), new Decimal(40))
    expect(bs?.toFixed(2)).toBe('4000.00')
  })
})
