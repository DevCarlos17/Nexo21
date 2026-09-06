import {
  derivarEstadoPago,
  huboAfectacionCxc,
  facturaCoincideBusqueda,
  previewMontoBsNc,
  derivarLineasNcParcial,
  puedeEmitirNcAdicional,
  puedeElegirTipoTotal,
  calcularReversoPorLinea,
  agruparReversosPorNc,
  calcularBadgesReversoPorVenta,
  resolverBadgesFactura,
  filaFacturaAtenuada,
  debeMostrarBadgeAdministracion,
} from '../notas-credito-ui'

// ─── derivarEstadoPago (Design §Decision 4 — tabla de verdad Contado/Credito/Abonada) ────────

describe('derivarEstadoPago (Design §Decision 4: pagado = total_usd - saldo_pend_usd, epsilon 0.005)', () => {
  it('CONTADO: saldo_pend_usd == 0 (pagado == total)', () => {
    expect(derivarEstadoPago({ total_usd: '100.00', saldo_pend_usd: '0.00' })).toBe('CONTADO')
  })

  it('CREDITO: saldo_pend_usd == total_usd (pagado == 0, sin ningun pago)', () => {
    expect(derivarEstadoPago({ total_usd: '50.00', saldo_pend_usd: '50.00' })).toBe('CREDITO')
  })

  it('ABONADA: saldo_pend_usd intermedio (0 < pagado < total)', () => {
    expect(derivarEstadoPago({ total_usd: '100.00', saldo_pend_usd: '40.00' })).toBe('ABONADA')
  })

  it('caso limite: saldo_pend_usd exactamente en el epsilon 0.005 -> CONTADO (lte)', () => {
    expect(derivarEstadoPago({ total_usd: '100.00', saldo_pend_usd: '0.005' })).toBe('CONTADO')
  })

  it('caso limite: saldo_pend_usd a distancia epsilon del total -> CREDITO (gte total - epsilon)', () => {
    expect(derivarEstadoPago({ total_usd: '100.00', saldo_pend_usd: '99.995' })).toBe('CREDITO')
  })

  it('justo fuera del epsilon de CREDITO por 0.01 -> ABONADA, no CREDITO', () => {
    expect(derivarEstadoPago({ total_usd: '100.00', saldo_pend_usd: '99.98' })).toBe('ABONADA')
  })
})

// ─── huboAfectacionCxc (Design §Decision 6 — COUNT(*) movimientos_cuenta) ────────

describe('huboAfectacionCxc (Design §Decision 6: fuente movimientos_cuenta, no recibo-pagos.ts)', () => {
  it('0 movimientos -> false (no afecto CxC)', () => {
    expect(huboAfectacionCxc(0)).toBe(false)
  })

  it('1 o mas movimientos -> true (afecto CxC)', () => {
    expect(huboAfectacionCxc(1)).toBe(true)
    expect(huboAfectacionCxc(3)).toBe(true)
  })
})

// ─── facturaCoincideBusqueda (Slice 2 — buscador por nro/cliente/estado) ────────

describe('facturaCoincideBusqueda (Slice 2: buscador client-side sobre nro_factura, cliente, estado y reverso)', () => {
  const base = {
    nro_factura: 'C01-000042',
    cliente_nombre: 'Maria Perez',
    total_usd: '100.00',
    saldo_pend_usd: '0.00',
  }

  it('query vacio coincide con cualquier factura', () => {
    expect(facturaCoincideBusqueda(base, '')).toBe(true)
  })

  it('coincide por substring de nro_factura', () => {
    expect(facturaCoincideBusqueda(base, '000042')).toBe(true)
  })

  it('coincide por cliente_nombre, case-insensitive', () => {
    expect(facturaCoincideBusqueda(base, 'MARIA')).toBe(true)
  })

  it('coincide por el estado de pago derivado (ej. "contado")', () => {
    expect(facturaCoincideBusqueda(base, 'contado')).toBe(true)
  })

  it('coincide por badge "Reverso Total" cuando tiene_reverso_total=1', () => {
    expect(facturaCoincideBusqueda({ ...base, tiene_reverso_total: 1 }, 'reverso total')).toBe(true)
  })

  it('coincide por badge "Reverso Parcial" cuando tiene_reverso_parcial=1', () => {
    expect(facturaCoincideBusqueda({ ...base, tiene_reverso_parcial: 1 }, 'parcial')).toBe(true)
  })

  it('no coincide si ningun campo contiene el query', () => {
    expect(facturaCoincideBusqueda(base, 'xyz-no-existe')).toBe(false)
  })
})

// ─── previewMontoBsNc (Design §Decision 8 — INVARIANTE BIMONETARIA) ────────
//
// Guardrail mas importante de todo el change: el preview de Bs de una NC
// jamas se recalcula con la tasa vigente del sistema — SIEMPRE la tasa
// historica de la factura original (`venta.tasa`). Slice 3a task 3.5/3.6.

describe('previewMontoBsNc (Design §Decision 8: invariante de tasa historica, NUNCA la tasa vigente)', () => {
  it('TOTAL usa factura.total_bs verbatim, sin ningun recalculo', () => {
    const result = previewMontoBsNc({
      tipo: 'TOTAL',
      factura: { total_usd: 100, total_bs: 4000, tasa: 40 },
    })

    expect(result).toEqual({ totalUsd: 100, totalBs: 4000 })
  })

  it('INVARIANTE: PARCIAL usa SIEMPRE la tasa historica de la factura (R1), NUNCA una tasa vigente distinta (R2)', () => {
    const tasaHistoricaR1 = 40
    const tasaVigenteSimuladaR2 = 130 // tasa "actual" del sistema, deliberadamente muy distinta de R1

    const result = previewMontoBsNc({
      tipo: 'PARCIAL',
      // factura.tasa es SIEMPRE R1 — el input nunca recibe la tasa vigente.
      factura: { total_usd: 100, total_bs: 4000, tasa: tasaHistoricaR1 },
      lineasSeleccionadas: [
        {
          codigo: 'P001',
          nombre: 'Botox 50U',
          cantidad: '1',
          precioUnitarioUsd: '10.00',
          tipoImpuesto: 'Gravable',
          impuestoPct: 16,
        },
      ],
    })

    // 10 USD + 16% IVA = 11.60 USD. A tasa historica R1=40 -> 464 Bs.
    expect(result.totalUsd).toBeCloseTo(11.6, 6)
    expect(result.totalBs).toBeCloseTo(464, 6)
    // Si el bug reapareciera (leer la tasa vigente), el monto seria 11.6*130=1508 — se prueba explicitamente que NO es ese valor.
    expect(result.totalBs).not.toBeCloseTo(11.6 * tasaVigenteSimuladaR2, 0)
  })

  it('PARCIAL con lineas mixtas gravadas/exentas: preserva el tratamiento de IVA de cada linea original', () => {
    const result = previewMontoBsNc({
      tipo: 'PARCIAL',
      factura: { total_usd: 100, total_bs: 4000, tasa: 40 },
      lineasSeleccionadas: [
        {
          codigo: 'P001',
          nombre: 'Gravado',
          cantidad: '1',
          precioUnitarioUsd: '10.00',
          tipoImpuesto: 'Gravable',
          impuestoPct: 16,
        },
        {
          codigo: 'P002',
          nombre: 'Exento',
          cantidad: '1',
          precioUnitarioUsd: '5.00',
          tipoImpuesto: 'Exento',
          impuestoPct: 0,
        },
      ],
    })

    // (10*1.16) + 5 = 16.60 USD a tasa 40 -> 664 Bs.
    expect(result.totalUsd).toBeCloseTo(16.6, 6)
    expect(result.totalBs).toBeCloseTo(664, 6)
  })
})

// ─── derivarLineasNcParcial (Design §Decision 7) ────────

describe('derivarLineasNcParcial (Design §Decision 7: mapeo UI -> contrato de crearNotaCredito)', () => {
  it('cantidad > 0 incluye la linea, mapeada a cantidadDevolver como string de 3 decimales', () => {
    const result = derivarLineasNcParcial(
      [{ venta_det_id: 'vd-1', cantidadFacturada: 5, esDecimal: true }],
      { 'vd-1': 2 }
    )

    expect(result.errores).toEqual([])
    expect(result.lineas).toEqual([{ venta_det_id: 'vd-1', cantidadDevolver: '2.000' }])
  })

  it('cantidad > cantidadFacturada rechaza la linea con error, excluida del resultado valido', () => {
    const result = derivarLineasNcParcial(
      [{ venta_det_id: 'vd-1', cantidadFacturada: 3, esDecimal: true }],
      { 'vd-1': 5 }
    )

    expect(result.lineas).toEqual([])
    expect(result.errores.length).toBeGreaterThan(0)
  })

  // F6 QA fix (Slice 5c, deuda de review de Slice 5a): el parametro
  // `cantidadFacturada` puede en realidad ser el REMANENTE (cuando el caller
  // lo capa via F1) — el mensaje decia "excede lo facturado", enganoso para
  // una linea ya parcialmente reversada. Ahora dice "cantidad disponible".
  it('F6: el mensaje de error usa "cantidad disponible" (no "lo facturado" — el tope puede ser un remanente, no lo originalmente facturado)', () => {
    const result = derivarLineasNcParcial(
      [{ venta_det_id: 'vd-1', cantidadFacturada: 2, esDecimal: true }],
      { 'vd-1': 5 }
    )

    expect(result.errores).toEqual([
      'La cantidad a devolver de la linea vd-1 excede la cantidad disponible (2).',
    ])
  })

  it('esDecimal=false rechaza cantidades no enteras', () => {
    const result = derivarLineasNcParcial(
      [{ venta_det_id: 'vd-1', cantidadFacturada: 5, esDecimal: false }],
      { 'vd-1': 1.5 }
    )

    expect(result.lineas).toEqual([])
    expect(result.errores.length).toBeGreaterThan(0)
  })

  it('todas las cantidades en 0: lineas vacio + al menos un error generico', () => {
    const result = derivarLineasNcParcial(
      [
        { venta_det_id: 'vd-1', cantidadFacturada: 5, esDecimal: true },
        { venta_det_id: 'vd-2', cantidadFacturada: 3, esDecimal: true },
      ],
      { 'vd-1': 0, 'vd-2': 0 }
    )

    expect(result.lineas).toEqual([])
    expect(result.errores.length).toBeGreaterThan(0)
  })

  it('mezcla: una linea valida + una invalida -> solo la valida aparece en lineas, la invalida genera error', () => {
    const result = derivarLineasNcParcial(
      [
        { venta_det_id: 'vd-1', cantidadFacturada: 5, esDecimal: true },
        { venta_det_id: 'vd-2', cantidadFacturada: 2, esDecimal: false },
      ],
      { 'vd-1': 2, 'vd-2': 1.5 }
    )

    expect(result.lineas).toEqual([{ venta_det_id: 'vd-1', cantidadDevolver: '2.000' }])
    expect(result.errores.length).toBeGreaterThan(0)
  })

  // ─── Deuda de Slice 3a (obs #2875): cantidad negativa NUNCA se descarta en
  // silencio como si fuera 0 — debe generar su PROPIO error explicito. ────

  it('NEGATIVE-QTY GUARD: cantidad negativa se rechaza EXPLICITAMENTE con su propio error (no en silencio)', () => {
    const result = derivarLineasNcParcial(
      [{ venta_det_id: 'vd-1', cantidadFacturada: 5, esDecimal: true }],
      { 'vd-1': -2 }
    )

    expect(result.lineas).toEqual([])
    expect(result.errores).toEqual(['La cantidad a devolver de la linea vd-1 no puede ser negativa.'])
  })

  it('NEGATIVE-QTY GUARD: mezcla negativa + valida -> la valida se incluye, la negativa genera SU error especifico (no el generico de "al menos una")', () => {
    const result = derivarLineasNcParcial(
      [
        { venta_det_id: 'vd-1', cantidadFacturada: 5, esDecimal: true },
        { venta_det_id: 'vd-2', cantidadFacturada: 3, esDecimal: true },
      ],
      { 'vd-1': 2, 'vd-2': -1 }
    )

    expect(result.lineas).toEqual([{ venta_det_id: 'vd-1', cantidadDevolver: '2.000' }])
    expect(result.errores).toEqual(['La cantidad a devolver de la linea vd-2 no puede ser negativa.'])
  })
})

// ─── F1 QA fix (Slice 5a) — facturas reversadas quedan SELECCIONABLES; el
// gating se mueve de la SELECCION a la ACCION. ────

describe('puedeEmitirNcAdicional (F1+5f: gating de accion — deriva del MISMO acumulado por-linea que el badge, NUNCA de tiene_reverso_total/parcial)', () => {
  it('factura sin ningun reverso: permite emitir', () => {
    expect(puedeEmitirNcAdicional([{ venta_det_id: 'vd-1', cantidad_facturada: 5 }], [])).toBe(true)
  })

  it('una NC TOTAL que reversa el 100% de la unica linea: NO permite ninguna NC adicional', () => {
    const lineas = [{ venta_det_id: 'vd-1', cantidad_facturada: 5 }]
    const notas = [{ venta_det_id: 'vd-1', cantidad: '5' }]
    expect(puedeEmitirNcAdicional(lineas, notas)).toBe(false)
  })

  it('una NC PARCIAL que NO completa el 100%: SI permite emitir (una NC adicional sobre el remanente)', () => {
    const lineas = [{ venta_det_id: 'vd-1', cantidad_facturada: 5 }]
    const notas = [{ venta_det_id: 'vd-1', cantidad: '2' }]
    expect(puedeEmitirNcAdicional(lineas, notas)).toBe(true)
  })

  it('QA fix 5f (mismatch badge/gating, obs verify-combined-final-v2): DOS NCs PARCIALes que juntas suman el 100% de cada linea de la factura -> bloquea igual que una sola NC TOTAL, CONSISTENTE con el badge (`calcularBadgesReversoPorVenta` marcaria esta misma factura como "Reverso Total")', () => {
    const lineas = [
      { venta_det_id: 'vd-1', cantidad_facturada: 5 },
      { venta_det_id: 'vd-2', cantidad_facturada: 3 },
    ]
    const notas = [
      { venta_det_id: 'vd-1', cantidad: '2' },
      { venta_det_id: 'vd-2', cantidad: '1' },
      { venta_det_id: 'vd-1', cantidad: '3' },
      { venta_det_id: 'vd-2', cantidad: '2' },
    ]
    expect(puedeEmitirNcAdicional(lineas, notas)).toBe(false)
  })

  it('sin lineas disponibles todavia (data en vuelo): permisivo por defecto, no bloquea antes de tener informacion real', () => {
    expect(puedeEmitirNcAdicional([], [])).toBe(true)
  })
})

describe('puedeElegirTipoTotal (F1+5f: el tipo TOTAL se oculta si YA existe CUALQUIER reverso acumulado, mismo criterio que el badge)', () => {
  it('factura sin ningun reverso: TOTAL es una opcion valida', () => {
    expect(puedeElegirTipoTotal([{ venta_det_id: 'vd-1', cantidad_facturada: 5 }], [])).toBe(true)
  })

  it('una NC TOTAL que reversa el 100%: TOTAL ya no es opcion (redundante con puedeEmitirNcAdicional=false)', () => {
    const lineas = [{ venta_det_id: 'vd-1', cantidad_facturada: 5 }]
    const notas = [{ venta_det_id: 'vd-1', cantidad: '5' }]
    expect(puedeElegirTipoTotal(lineas, notas)).toBe(false)
  })

  it('una NC PARCIAL que NO completa el 100%: TOTAL tampoco es opcion — solo PARCIAL sobre el remanente', () => {
    const lineas = [{ venta_det_id: 'vd-1', cantidad_facturada: 5 }]
    const notas = [{ venta_det_id: 'vd-1', cantidad: '2' }]
    expect(puedeElegirTipoTotal(lineas, notas)).toBe(false)
  })
})

describe('calcularReversoPorLinea (F1: remaining-qty por linea, mismo criterio de acumulacion que validarTopeDobleCredito)', () => {
  it('sin NCs previas sobre esta linea: reversado=0, restante=facturado completo', () => {
    const r = calcularReversoPorLinea('vd-1', 5, [])
    expect(r.facturado.toNumber()).toBe(5)
    expect(r.reversado.toNumber()).toBe(0)
    expect(r.restante.toNumber()).toBe(5)
  })

  it('una NC parcial previa acredito 2 de 5: restante correcto (3)', () => {
    const r = calcularReversoPorLinea('vd-1', 5, [{ venta_det_id: 'vd-1', cantidad: '2' }])
    expect(r.reversado.toNumber()).toBe(2)
    expect(r.restante.toNumber()).toBe(3)
  })

  it('FULLY-REVERSED GUARD: linea ya acreditada por completo -> restante=0 (no puede re-reversarse)', () => {
    const r = calcularReversoPorLinea('vd-1', 5, [{ venta_det_id: 'vd-1', cantidad: '5' }])
    expect(r.restante.toNumber()).toBe(0)
  })

  it('ignora notas_credito_det de OTRAS lineas de la misma factura (filtra por venta_det_id)', () => {
    const r = calcularReversoPorLinea('vd-1', 5, [{ venta_det_id: 'vd-2', cantidad: '3' }])
    expect(r.reversado.toNumber()).toBe(0)
    expect(r.restante.toNumber()).toBe(5)
  })

  it('acumula multiples NCs previas sobre la MISMA linea (SUM, no el ultimo valor)', () => {
    const r = calcularReversoPorLinea('vd-1', 10, [
      { venta_det_id: 'vd-1', cantidad: '2' },
      { venta_det_id: 'vd-1', cantidad: '3' },
    ])
    expect(r.reversado.toNumber()).toBe(5)
    expect(r.restante.toNumber()).toBe(5)
  })
})

describe('calcularBadgesReversoPorVenta (Slice 5e QA fix 3.5: badge de reverso ACUMULADO, no por opcion de NC individual)', () => {
  it('dos NCs PARCIALes que juntas reversan el 100% de la unica linea -> Reverso Total', () => {
    const lineas = [{ venta_id: 'venta-1', venta_det_id: 'vd-1', cantidad_facturada: '5' }]
    const notas = [
      { venta_det_id: 'vd-1', cantidad: '2' },
      { venta_det_id: 'vd-1', cantidad: '3' },
    ]
    expect(calcularBadgesReversoPorVenta(lineas, notas)).toEqual({ 'venta-1': 'TOTAL' })
  })

  it('NCs PARCIALes que NO suman el 100% -> Reverso Parcial', () => {
    const lineas = [{ venta_id: 'venta-1', venta_det_id: 'vd-1', cantidad_facturada: '5' }]
    const notas = [{ venta_det_id: 'vd-1', cantidad: '2' }]
    expect(calcularBadgesReversoPorVenta(lineas, notas)).toEqual({ 'venta-1': 'PARCIAL' })
  })

  it('una sola NC que reversa la cantidad completa de la unica linea -> Reverso Total', () => {
    const lineas = [{ venta_id: 'venta-1', venta_det_id: 'vd-1', cantidad_facturada: '5' }]
    const notas = [{ venta_det_id: 'vd-1', cantidad: '5' }]
    expect(calcularBadgesReversoPorVenta(lineas, notas)).toEqual({ 'venta-1': 'TOTAL' })
  })

  it('sin ninguna NC aplicada -> sin badge (null)', () => {
    const lineas = [{ venta_id: 'venta-1', venta_det_id: 'vd-1', cantidad_facturada: '5' }]
    expect(calcularBadgesReversoPorVenta(lineas, [])).toEqual({ 'venta-1': null })
  })

  it('factura con multiples lineas: TODAS deben llegar a 100% para Reverso Total — una sola linea incompleta mantiene Parcial', () => {
    const lineas = [
      { venta_id: 'venta-1', venta_det_id: 'vd-1', cantidad_facturada: '5' },
      { venta_id: 'venta-1', venta_det_id: 'vd-2', cantidad_facturada: '3' },
    ]
    const notas = [
      { venta_det_id: 'vd-1', cantidad: '5' },
      { venta_det_id: 'vd-2', cantidad: '1' },
    ]
    expect(calcularBadgesReversoPorVenta(lineas, notas)).toEqual({ 'venta-1': 'PARCIAL' })
  })

  it('calcula independiente por cada venta_id (multiples facturas de la misma sesion)', () => {
    const lineas = [
      { venta_id: 'venta-1', venta_det_id: 'vd-1', cantidad_facturada: '5' },
      { venta_id: 'venta-2', venta_det_id: 'vd-2', cantidad_facturada: '3' },
    ]
    const notas = [
      { venta_det_id: 'vd-1', cantidad: '5' },
      { venta_det_id: 'vd-2', cantidad: '1' },
    ]
    expect(calcularBadgesReversoPorVenta(lineas, notas)).toEqual({ 'venta-1': 'TOTAL', 'venta-2': 'PARCIAL' })
  })
})

describe('resolverBadgesFactura (BUG D: reverso TOTAL debe suprimir el badge de estado de pago, no combinarse con el)', () => {
  it('badgeReverso TOTAL: suprime el badge de pago (estadoPago=null) y NUNCA muestra Parcial', () => {
    expect(resolverBadgesFactura('CONTADO', 'TOTAL')).toEqual({ estadoPago: null, reverso: 'TOTAL' })
  })

  it('badgeReverso PARCIAL: el badge de pago se mantiene visible junto con Reverso Parcial', () => {
    expect(resolverBadgesFactura('CREDITO', 'PARCIAL')).toEqual({ estadoPago: 'CREDITO', reverso: 'PARCIAL' })
  })

  it('badgeReverso null: solo el badge de pago, sin ningun badge de reverso', () => {
    expect(resolverBadgesFactura('ABONADA', null)).toEqual({ estadoPago: 'ABONADA', reverso: null })
  })
})

describe('agruparReversosPorNc (F1: historial additivo — original + reverso, Requisito "mostrar ambos")', () => {
  it('agrupa multiples lineas de la MISMA NC en una sola entrada', () => {
    const result = agruparReversosPorNc([
      { nota_credito_id: 'nc-1', nro_ncr: 'NCR-000001', tipo: 'PARCIAL', fecha: '2026-01-02T00:00:00Z', producto_descripcion: 'Botox 50U', cantidad: '2.000' },
      { nota_credito_id: 'nc-1', nro_ncr: 'NCR-000001', tipo: 'PARCIAL', fecha: '2026-01-02T00:00:00Z', producto_descripcion: 'Consulta', cantidad: '1.000' },
    ])

    expect(result).toHaveLength(1)
    expect(result[0].nroNcr).toBe('NCR-000001')
    expect(result[0].lineas).toEqual([
      { descripcion: 'Botox 50U', cantidad: '2.000' },
      { descripcion: 'Consulta', cantidad: '1.000' },
    ])
  })

  it('separa NCs distintas en entradas distintas', () => {
    const result = agruparReversosPorNc([
      { nota_credito_id: 'nc-1', nro_ncr: 'NCR-000001', tipo: 'PARCIAL', fecha: '2026-01-02T00:00:00Z', producto_descripcion: 'Botox 50U', cantidad: '2.000' },
      { nota_credito_id: 'nc-2', nro_ncr: 'NCR-000002', tipo: 'TOTAL', fecha: '2026-01-03T00:00:00Z', producto_descripcion: 'Botox 50U', cantidad: '3.000' },
    ])

    expect(result.map((g) => g.nroNcr)).toEqual(['NCR-000001', 'NCR-000002'])
  })

  it('lista vacia produce arreglo vacio (sin reversos aplicados aun)', () => {
    expect(agruparReversosPorNc([])).toEqual([])
  })
})

// ─── filaFacturaAtenuada (Slice E.5, notas-credito-ruta-administrativa — QA feedback) ────────

describe('filaFacturaAtenuada (Slice E.5: fila 100% reversada se atenua en la tabla de Facturas emitidas)', () => {
  it('tiene_reverso_total=1 -> true (fila atenuada)', () => {
    expect(filaFacturaAtenuada({ tiene_reverso_total: 1 })).toBe(true)
  })

  it('tiene_reverso_total=0 -> false (fila normal)', () => {
    expect(filaFacturaAtenuada({ tiene_reverso_total: 0 })).toBe(false)
  })

  it('tiene_reverso_total ausente (undefined) -> false, nunca revienta', () => {
    expect(filaFacturaAtenuada({})).toBe(false)
  })
})

// ─── debeMostrarBadgeAdministracion (Slice 6, Design §Decision 3: badge "vía administración") ────────

describe('debeMostrarBadgeAdministracion (Slice 6: badge "vía administración" en el listado POS cuando la NC vino de Tradicional)', () => {
  it('tiene_reverso_via_administracion=1 -> true (la venta tiene una NC con entry_point=TRADICIONAL)', () => {
    expect(debeMostrarBadgeAdministracion({ tiene_reverso_via_administracion: 1 })).toBe(true)
  })

  it('tiene_reverso_via_administracion=0 -> false (ninguna NC de esta venta vino de Tradicional)', () => {
    expect(debeMostrarBadgeAdministracion({ tiene_reverso_via_administracion: 0 })).toBe(false)
  })

  it('tiene_reverso_via_administracion ausente (undefined) -> false, nunca revienta', () => {
    expect(debeMostrarBadgeAdministracion({})).toBe(false)
  })
})
