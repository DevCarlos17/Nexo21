import Decimal from 'decimal.js'
import {
  type CuentaOrigenDineroOption,
  type FilaOrigenDinero,
  montoFilaEnUsd,
  calcularTotalCubiertoUsd,
  calcularCreditoAFavorUsd,
  calcularExcedenteUsd,
  filaExcedeDisponible,
  hayCuentaDuplicada,
  validarFilasParaSubmit,
  buildOrigenDineroPayload,
  normalizarMonedaOrigen,
} from '../origen-dinero-picker'

/**
 * Slice 4 (notas-credito-cuadre-origen-dinero, multi-origin picker UI):
 * capa PURA que alimenta `OrigenDineroPicker` en ambos modales. Espeja el
 * contrato bimonetario de `use-notas-credito.ts` Pass 1 (obs #2949): monto
 * en moneda NATIVA de la cuenta, invariante de suma en USD via `venta.tasa`.
 */

function cuentaUsd(overrides: Partial<CuentaOrigenDineroOption> = {}): CuentaOrigenDineroOption {
  return {
    tipo: 'SESION_EFECTIVO',
    cuentaId: 'metodo-usd-1',
    label: 'Efectivo USD',
    moneda: 'USD',
    saldoActual: '100.00',
    ...overrides,
  }
}

function cuentaBs(overrides: Partial<CuentaOrigenDineroOption> = {}): CuentaOrigenDineroOption {
  return {
    tipo: 'SESION_EFECTIVO',
    cuentaId: 'metodo-bs-1',
    label: 'Efectivo Bs',
    moneda: 'BS',
    saldoActual: '4000.00',
    ...overrides,
  }
}

function fila(overrides: Partial<FilaOrigenDinero> = {}): FilaOrigenDinero {
  return { id: 'fila-1', tipo: 'SESION_EFECTIVO', cuentaId: 'metodo-usd-1', monto: '10.00', ...overrides }
}

describe('montoFilaEnUsd — conversion bimonetaria por fila (obs #2949)', () => {
  it('cuenta en USD: el monto ya esta en USD, no convierte', () => {
    const resultado = montoFilaEnUsd(fila({ monto: '25.00' }), [cuentaUsd()], '40')
    expect(resultado.toString()).toBe('25')
  })

  it('cuenta en BS: convierte via bsToUsd(monto, tasa)', () => {
    const resultado = montoFilaEnUsd(
      fila({ cuentaId: 'metodo-bs-1', monto: '400.00' }),
      [cuentaBs()],
      '40'
    )
    expect(resultado.toString()).toBe('10')
  })

  it('cuenta no encontrada (tipo/cuentaId no matchea ninguna opcion): retorna 0', () => {
    const resultado = montoFilaEnUsd(fila({ cuentaId: 'no-existe' }), [cuentaUsd()], '40')
    expect(resultado.toString()).toBe('0')
  })

  it('monto vacio o invalido: retorna 0 (nunca NaN)', () => {
    const resultado = montoFilaEnUsd(fila({ monto: '' }), [cuentaUsd()], '40')
    expect(resultado.toString()).toBe('0')
  })
})

describe('calcularTotalCubiertoUsd — suma de filas convertidas a USD', () => {
  it('suma dos filas mixtas (USD + BS) — ejemplo canonico del owner (Bs500 sesion + Bs500 banco = USD2 c/u a tasa 500)', () => {
    const cuentas: CuentaOrigenDineroOption[] = [
      cuentaUsd({ tipo: 'SESION_EFECTIVO', cuentaId: 'sesion-usd' }),
      { tipo: 'BANCO', cuentaId: 'banco-1', label: 'Banco Bs', moneda: 'BS', saldoActual: '10000.00' },
    ]
    const filas: FilaOrigenDinero[] = [
      { id: 'f1', tipo: 'SESION_EFECTIVO', cuentaId: 'sesion-usd', monto: '30.00' },
      { id: 'f2', tipo: 'BANCO', cuentaId: 'banco-1', monto: '500.00' },
    ]
    const resultado = calcularTotalCubiertoUsd(filas, cuentas, '500')
    // 30 USD + (500 Bs / 500) = 30 + 1 = 31
    expect(resultado.toString()).toBe('31')
  })

  it('array vacio: retorna 0', () => {
    expect(calcularTotalCubiertoUsd([], [cuentaUsd()], '40').toString()).toBe('0')
  })
})

describe('calcularCreditoAFavorUsd / calcularExcedenteUsd — remanente vs cubierto', () => {
  it('cubierto menor al remanente: el resto queda como credito a favor', () => {
    expect(calcularCreditoAFavorUsd('100.00', montoFijo('60')).toString()).toBe('40')
  })

  it('cubierto exactamente igual al remanente: credito a favor es 0', () => {
    expect(calcularCreditoAFavorUsd('100.00', montoFijo('100')).toString()).toBe('0')
  })

  it('cubierto mayor al remanente: excedente positivo (nunca negativo el credito a favor)', () => {
    expect(calcularCreditoAFavorUsd('100.00', montoFijo('150')).toString()).toBe('0')
    expect(calcularExcedenteUsd('100.00', montoFijo('150')).toString()).toBe('50')
  })

  it('cubierto menor al remanente: excedente es 0 (no hay exceso)', () => {
    expect(calcularExcedenteUsd('100.00', montoFijo('60')).toString()).toBe('0')
  })

  function montoFijo(v: string) {
    return new Decimal(v)
  }
})

describe('filaExcedeDisponible — guard de disponibilidad (obs #2950, pre-check UI del tope duro del backend)', () => {
  it('SESION_EFECTIVO con monto > saldo_actual: excede', () => {
    const excede = filaExcedeDisponible(fila({ monto: '150.00' }), cuentaUsd({ saldoActual: '100.00' }))
    expect(excede).toBe(true)
  })

  it('SESION_EFECTIVO con monto <= saldo_actual: no excede', () => {
    const excede = filaExcedeDisponible(fila({ monto: '100.00' }), cuentaUsd({ saldoActual: '100.00' }))
    expect(excede).toBe(false)
  })

  it('TESORERIA_EFECTIVO con monto > saldo_actual: excede (mismo tope duro que SESION_EFECTIVO)', () => {
    const cuenta = cuentaUsd({ tipo: 'TESORERIA_EFECTIVO', saldoActual: '50.00' })
    const excede = filaExcedeDisponible(fila({ tipo: 'TESORERIA_EFECTIVO', monto: '60.00' }), cuenta)
    expect(excede).toBe(true)
  })

  it('BANCO con monto > saldo_actual: NUNCA excede (sobregiro permitido, obs #2950)', () => {
    const cuenta: CuentaOrigenDineroOption = {
      tipo: 'BANCO',
      cuentaId: 'banco-1',
      label: 'Banco Bs',
      moneda: 'BS',
      saldoActual: '10.00',
    }
    const excede = filaExcedeDisponible(fila({ tipo: 'BANCO', cuentaId: 'banco-1', monto: '999.00' }), cuenta)
    expect(excede).toBe(false)
  })
})

describe('hayCuentaDuplicada — mismo (tipo, cuentaId) en dos filas (espeja Rule 4 del backend)', () => {
  it('dos filas con el mismo (tipo, cuentaId): detecta duplicado', () => {
    const filas: FilaOrigenDinero[] = [
      fila({ id: 'f1', cuentaId: 'metodo-1' }),
      fila({ id: 'f2', cuentaId: 'metodo-1' }),
    ]
    expect(hayCuentaDuplicada(filas)).toBe(true)
  })

  it('mismo cuentaId pero distinto tipo: NO es duplicado (tablas distintas, mismo criterio que el backend)', () => {
    const filas: FilaOrigenDinero[] = [
      fila({ id: 'f1', tipo: 'SESION_EFECTIVO', cuentaId: 'cuenta-x' }),
      fila({ id: 'f2', tipo: 'BANCO', cuentaId: 'cuenta-x' }),
    ]
    expect(hayCuentaDuplicada(filas)).toBe(false)
  })

  it('una sola fila: nunca duplicado', () => {
    expect(hayCuentaDuplicada([fila()])).toBe(false)
  })
})

describe('validarFilasParaSubmit — validacion combinada que habilita/deshabilita el submit', () => {
  const cuentas: CuentaOrigenDineroOption[] = [cuentaUsd(), cuentaBs()]

  it('array vacio: invalido (no hay nada que cubrir)', () => {
    const resultado = validarFilasParaSubmit({ filas: [], cuentas, remanenteUsd: '100.00', tasa: '40' })
    expect(resultado.valido).toBe(false)
  })

  it('fila con cuenta y monto validos, dentro del remanente: valido', () => {
    const resultado = validarFilasParaSubmit({
      filas: [fila({ monto: '50.00' })],
      cuentas,
      remanenteUsd: '100.00',
      tasa: '40',
    })
    expect(resultado.valido).toBe(true)
  })

  it('fila con monto = 0: invalido', () => {
    const resultado = validarFilasParaSubmit({
      filas: [fila({ monto: '0' })],
      cuentas,
      remanenteUsd: '100.00',
      tasa: '40',
    })
    expect(resultado.valido).toBe(false)
  })

  it('fila sin tipo/cuenta elegida (placeholder): invalido', () => {
    const resultado = validarFilasParaSubmit({
      filas: [fila({ tipo: '', cuentaId: '' })],
      cuentas,
      remanenteUsd: '100.00',
      tasa: '40',
    })
    expect(resultado.valido).toBe(false)
  })

  it('cuentas duplicadas entre filas: invalido', () => {
    const resultado = validarFilasParaSubmit({
      filas: [fila({ id: 'f1', monto: '10' }), fila({ id: 'f2', monto: '10' })],
      cuentas,
      remanenteUsd: '100.00',
      tasa: '40',
    })
    expect(resultado.valido).toBe(false)
  })

  it('fila excede disponibilidad de efectivo (pre-check del tope duro del backend): invalido', () => {
    const resultado = validarFilasParaSubmit({
      filas: [fila({ monto: '9999.00' })],
      cuentas,
      remanenteUsd: '100000.00',
      tasa: '40',
    })
    expect(resultado.valido).toBe(false)
  })

  it('total cubierto excede el remanente (+ epsilon 0.005): invalido', () => {
    const resultado = validarFilasParaSubmit({
      filas: [fila({ monto: '100.00' })],
      cuentas: [cuentaUsd({ saldoActual: '1000.00' })],
      remanenteUsd: '50.00',
      tasa: '40',
    })
    expect(resultado.valido).toBe(false)
  })

  it('total cubierto menor al remanente (deja credito a favor): valido — combinacion es el default, no se rechaza (obs #2948)', () => {
    const resultado = validarFilasParaSubmit({
      filas: [fila({ monto: '10.00' })],
      cuentas: [cuentaUsd({ saldoActual: '1000.00' })],
      remanenteUsd: '100.00',
      tasa: '40',
    })
    expect(resultado.valido).toBe(true)
  })

  it('BANCO por encima de su saldo_actual (sobregiro permitido): sigue siendo valido si no excede el remanente', () => {
    const cuentasConBanco: CuentaOrigenDineroOption[] = [
      { tipo: 'BANCO', cuentaId: 'banco-1', label: 'Banco Bs', moneda: 'BS', saldoActual: '10.00' },
    ]
    const resultado = validarFilasParaSubmit({
      filas: [{ id: 'f1', tipo: 'BANCO', cuentaId: 'banco-1', monto: '400.00' }],
      cuentas: cuentasConBanco,
      remanenteUsd: '100.00',
      tasa: '40',
    })
    expect(resultado.valido).toBe(true)
  })
})

describe('normalizarMonedaOrigen — mismo mapeo VES->BS que use-bancos.ts/use-payment-methods.ts', () => {
  it("codigo_iso 'VES' se normaliza a 'BS'", () => {
    expect(normalizarMonedaOrigen('VES')).toBe('BS')
  })

  it("codigo_iso 'USD' se mantiene 'USD'", () => {
    expect(normalizarMonedaOrigen('USD')).toBe('USD')
  })

  it('codigo_iso nulo/vacio: default USD (mismo fallback que COALESCE(m.codigo_iso, \'USD\'))', () => {
    expect(normalizarMonedaOrigen(null)).toBe('USD')
    expect(normalizarMonedaOrigen('')).toBe('USD')
  })
})

describe('buildOrigenDineroPayload — mapea filas validas al contrato exacto de crearNotaCredito', () => {
  it('mapea {tipo, cuentaId, monto} en el mismo orden, sin campos extra (id de fila NO viaja)', () => {
    const filas: FilaOrigenDinero[] = [
      { id: 'ui-row-1', tipo: 'SESION_EFECTIVO', cuentaId: 'metodo-usd-1', monto: '25.00' },
      { id: 'ui-row-2', tipo: 'BANCO', cuentaId: 'banco-1', monto: '500.00' },
    ]
    const payload = buildOrigenDineroPayload(filas)
    expect(payload).toEqual([
      { tipo: 'SESION_EFECTIVO', cuentaId: 'metodo-usd-1', monto: '25.00' },
      { tipo: 'BANCO', cuentaId: 'banco-1', monto: '500.00' },
    ])
  })

  it('filas con tipo vacio (placeholder no completado) se excluyen del payload', () => {
    const filas: FilaOrigenDinero[] = [
      { id: 'f1', tipo: '', cuentaId: '', monto: '' },
      { id: 'f2', tipo: 'BANCO', cuentaId: 'banco-1', monto: '10.00' },
    ]
    const payload = buildOrigenDineroPayload(filas)
    expect(payload).toEqual([{ tipo: 'BANCO', cuentaId: 'banco-1', monto: '10.00' }])
  })
})
