import Decimal from 'decimal.js'
import {
  calcularDesgloseLineaNC,
  validarTopeDobleCredito,
  buildSumCantidadYaAcreditadaQuery,
  mapSumCantidadYaAcreditadaRow,
  type LineaNcOrigen,
} from '../notas-credito-fiscal'

// ─── calcularDesgloseLineaNC ────────────────────────────────────

function linea(overrides: Partial<LineaNcOrigen> = {}): LineaNcOrigen {
  return {
    ventaDetId: 'vd-1',
    cantidadDevolver: '1',
    precioUnitarioUsd: '10.00',
    tipoImpuesto: 'Gravable',
    impuestoPct: 16,
    ...overrides,
  }
}

describe('calcularDesgloseLineaNC (Design §2 — desglose fiscal por linea, formula identica a crearVenta L398-408)', () => {
  it('linea Exento: todo el subtotal va a exentoUsd, baseUsd=0, ivaUsd=0', () => {
    const r = calcularDesgloseLineaNC(
      linea({ cantidadDevolver: '2', precioUnitarioUsd: '10.00', tipoImpuesto: 'Exento', impuestoPct: 0 }),
      '500'
    )

    expect(r.subtotalUsd.toFixed(2)).toBe('20.00')
    expect(r.exentoUsd.toFixed(2)).toBe('20.00')
    expect(r.baseUsd.toFixed(2)).toBe('0.00')
    expect(r.ivaUsd.toFixed(2)).toBe('0.00')
    expect(r.totalLineaUsd.toFixed(2)).toBe('20.00')
  })

  it('linea Gravable al 16%: subtotal va a baseUsd, IVA calculado sobre esa base', () => {
    const r = calcularDesgloseLineaNC(
      linea({ cantidadDevolver: '3', precioUnitarioUsd: '10.00', tipoImpuesto: 'Gravable', impuestoPct: 16 }),
      '500'
    )

    expect(r.subtotalUsd.toFixed(2)).toBe('30.00')
    expect(r.exentoUsd.toFixed(2)).toBe('0.00')
    expect(r.baseUsd.toFixed(2)).toBe('30.00')
    expect(r.ivaUsd.toFixed(2)).toBe('4.80')
    expect(r.totalLineaUsd.toFixed(2)).toBe('34.80')
  })

  it('linea Gravable al 8% (alicuota reducida): IVA se calcula con el pct de ESA linea, no 16% fijo', () => {
    const r = calcularDesgloseLineaNC(
      linea({ cantidadDevolver: '1', precioUnitarioUsd: '100.00', tipoImpuesto: 'Gravable', impuestoPct: 8 }),
      '500'
    )

    expect(r.baseUsd.toFixed(2)).toBe('100.00')
    expect(r.ivaUsd.toFixed(2)).toBe('8.00')
  })

  it('linea Exonerado: mirror EXACTO de use-ventas.ts — cae en la rama base+IVA (no exento), igual que crearVenta clasifica cualquier tipo != "Exento"', () => {
    const r = calcularDesgloseLineaNC(
      linea({ cantidadDevolver: '1', precioUnitarioUsd: '50.00', tipoImpuesto: 'Exonerado', impuestoPct: 0 }),
      '500'
    )

    expect(r.exentoUsd.toFixed(2)).toBe('0.00')
    expect(r.baseUsd.toFixed(2)).toBe('50.00')
    expect(r.ivaUsd.toFixed(2)).toBe('0.00')
  })

  it('tasa historica de la venta se usa verbatim para subtotalBs, sin importar la tasa vigente hoy', () => {
    const r = calcularDesgloseLineaNC(
      linea({ cantidadDevolver: '1', precioUnitarioUsd: '10.00', tipoImpuesto: 'Exento', impuestoPct: 0 }),
      '123.4567'
    )

    // subtotalBs = subtotalUsd * ventaTasa (usdToBs), igual formula que crearVenta L516
    expect(r.subtotalBs.toFixed(4)).toBe('1234.5670')
  })

  it('cantidad devuelta parcial (menor a la original) escala el subtotal proporcionalmente', () => {
    const r = calcularDesgloseLineaNC(
      linea({ cantidadDevolver: '0.5', precioUnitarioUsd: '10.00', tipoImpuesto: 'Gravable', impuestoPct: 16 }),
      '500'
    )

    expect(r.subtotalUsd.toFixed(2)).toBe('5.00')
    expect(r.ivaUsd.toFixed(2)).toBe('0.80')
  })

  it('ecoa ventaDetId y cantidadDevolver en el resultado, para que el llamador (4b) arme el INSERT sin recalcular', () => {
    const r = calcularDesgloseLineaNC(linea({ ventaDetId: 'vd-xyz', cantidadDevolver: '2' }), '500')

    expect(r.ventaDetId).toBe('vd-xyz')
    expect(r.cantidadDevolver.toFixed(3)).toBe('2.000')
  })

  it('mixed-alicuota multi-linea PARCIAL: cada linea se clasifica de forma independiente (simula la agregacion de header que 4b hara con Array.reduce)', () => {
    const lineas = [
      linea({ ventaDetId: 'vd-a', cantidadDevolver: '1', precioUnitarioUsd: '10.00', tipoImpuesto: 'Exento', impuestoPct: 0 }),
      linea({ ventaDetId: 'vd-b', cantidadDevolver: '1', precioUnitarioUsd: '10.00', tipoImpuesto: 'Gravable', impuestoPct: 16 }),
      linea({ ventaDetId: 'vd-c', cantidadDevolver: '1', precioUnitarioUsd: '10.00', tipoImpuesto: 'Gravable', impuestoPct: 8 }),
    ]
    const desgloses = lineas.map((l) => calcularDesgloseLineaNC(l, '500'))

    const totalExentoUsd = desgloses.reduce((s, d) => s.plus(d.exentoUsd), new Decimal(0))
    const totalBaseUsd = desgloses.reduce((s, d) => s.plus(d.baseUsd), new Decimal(0))
    const totalIvaUsd = desgloses.reduce((s, d) => s.plus(d.ivaUsd), new Decimal(0))

    expect(totalExentoUsd.toFixed(2)).toBe('10.00')
    expect(totalBaseUsd.toFixed(2)).toBe('20.00')
    // 16% de 10 = 1.60, 8% de 10 = 0.80 → 2.40
    expect(totalIvaUsd.toFixed(2)).toBe('2.40')
  })

  it('no redondea a nivel de linea (mantiene precision Decimal completa) — solo se formatea/almacena en el storage layer, igual que crearVenta', () => {
    // 1/3 * 10.00 = 3.3333... — la funcion NO debe truncar prematuramente a 2 decimales.
    const r = calcularDesgloseLineaNC(
      linea({ cantidadDevolver: '0.333', precioUnitarioUsd: '10.00', tipoImpuesto: 'Exento', impuestoPct: 0 }),
      '500'
    )

    expect(r.subtotalUsd.toFixed(8)).toBe('3.33000000')
    expect(r.subtotalUsd).toBeInstanceOf(Decimal)
  })
})

// ─── validarTopeDobleCredito ────────────────────────────────────

describe('validarTopeDobleCredito (Design §2 — gap real no cubierto por el trigger existente: el trigger solo topea el TOTAL de la factura, no la cantidad por linea)', () => {
  it('acepta cuando yaAcreditado + cantidadDevolver queda DENTRO de la cantidad original de la linea', () => {
    const r = validarTopeDobleCredito({
      ventaDetId: 'vd-1',
      cantidadOriginalLinea: '5',
      yaAcreditado: '2',
      cantidadDevolver: '3',
    })

    expect(r.valido).toBe(true)
    expect(r.cantidadDisponible.toFixed(3)).toBe('3.000')
  })

  it('acepta exactamente en el limite (yaAcreditado + cantidadDevolver === cantidadOriginal)', () => {
    const r = validarTopeDobleCredito({
      ventaDetId: 'vd-1',
      cantidadOriginalLinea: '5',
      yaAcreditado: '2',
      cantidadDevolver: '3.000',
    })

    expect(r.valido).toBe(true)
  })

  it('rechaza cuando yaAcreditado + cantidadDevolver EXCEDE la cantidad original de la linea', () => {
    const r = validarTopeDobleCredito({
      ventaDetId: 'vd-1',
      cantidadOriginalLinea: '5',
      yaAcreditado: '4',
      cantidadDevolver: '2',
    })

    expect(r.valido).toBe(false)
    expect(r.motivo).toMatch(/vd-1/)
  })

  it('rechaza doble-credito total: linea ya completamente acreditada (yaAcreditado === cantidadOriginal), cualquier nueva solicitud es invalida', () => {
    const r = validarTopeDobleCredito({
      ventaDetId: 'vd-2',
      cantidadOriginalLinea: '10',
      yaAcreditado: '10',
      cantidadDevolver: '0.001',
    })

    expect(r.valido).toBe(false)
    expect(r.cantidadDisponible.toFixed(3)).toBe('0.000')
  })

  it('acepta el primer credito contra una linea nunca antes acreditada (yaAcreditado=0)', () => {
    const r = validarTopeDobleCredito({
      ventaDetId: 'vd-3',
      cantidadOriginalLinea: '1',
      yaAcreditado: '0',
      cantidadDevolver: '1',
    })

    expect(r.valido).toBe(true)
  })

  it('precision de cantidades a 3 decimales (stock): 0.001 de margen es suficiente para aceptar', () => {
    const r = validarTopeDobleCredito({
      ventaDetId: 'vd-4',
      cantidadOriginalLinea: '2.500',
      yaAcreditado: '1.499',
      cantidadDevolver: '1.001',
    })

    expect(r.valido).toBe(true)
  })

  it('precision de cantidades a 3 decimales: 0.001 de exceso es suficiente para rechazar', () => {
    const r = validarTopeDobleCredito({
      ventaDetId: 'vd-5',
      cantidadOriginalLinea: '2.500',
      yaAcreditado: '1.500',
      cantidadDevolver: '1.001',
    })

    expect(r.valido).toBe(false)
  })
})

// ─── sumCantidadYaAcreditada (query-shape helper, tx-agnostic) ──

describe('buildSumCantidadYaAcreditadaQuery / mapSumCantidadYaAcreditadaRow (query-shape helper — SQL string + row-mapping, sin ejecutar contra DB)', () => {
  it('retorna SQL que suma cantidad de notas_credito_det escopeado a venta_det_id Y empresa_id (multi-tenant)', () => {
    const q = buildSumCantidadYaAcreditadaQuery()

    expect(q.sql).toContain('SUM(cantidad)')
    expect(q.sql).toContain('notas_credito_det')
    expect(q.sql).toContain('venta_det_id')
    expect(q.sql).toContain('empresa_id')
  })

  it('el orden de parametros documentado es [ventaDetId, empresaId] — coincide con los ? en el SQL', () => {
    const q = buildSumCantidadYaAcreditadaQuery()

    expect(q.paramsOrder).toEqual(['ventaDetId', 'empresaId'])
  })

  it('row-mapping: fila con total numerico string se mapea a Decimal', () => {
    const total = mapSumCantidadYaAcreditadaRow({ total: '3.500' })
    expect(total.toFixed(3)).toBe('3.500')
  })

  it('row-mapping: fila con total null (COALESCE deberia evitarlo, pero defensivo) se mapea a Decimal(0)', () => {
    const total = mapSumCantidadYaAcreditadaRow({ total: null })
    expect(total.toFixed(3)).toBe('0.000')
  })

  it('row-mapping: fila con total numero (no string) tambien se mapea correctamente', () => {
    const total = mapSumCantidadYaAcreditadaRow({ total: 2 })
    expect(total.toFixed(3)).toBe('2.000')
  })
})
