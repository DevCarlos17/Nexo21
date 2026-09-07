import autoTable from 'jspdf-autotable'
import {
  buildReciboData,
  buildReciboTextoPlano,
  buildReciboImagenBlob,
  buildReciboPdfBlob,
  descargarReciboPdf,
  compartirReciboImagen,
  nombreArchivoRecibo,
  RECIBO_ANCHO_CHARS,
  generarSeparador,
  medirAnchoPngDesdeSeparador,
  esperarFuentesRecibo,
  construirFilasTotales,
  formatParPrimarioContraparte,
  formatMontoBimonetario,
  formatMontoPrimario,
  formatMontoPago,
  sumarAbonos,
  type BuildReciboDataInput,
  type ReciboData,
  type ReciboTotales,
} from '../factura-export'
import type { ReciboPagoInput, ReciboPagoLinea } from '../recibo-pagos'

// Envuelve la implementacion REAL de jspdf-autotable con un spy: preserva el
// renderizado real (los tests de PDF existentes siguen generando un Blob valido)
// mientras permite inspeccionar los argumentos (`body`) de cada llamada — usado
// por el test de paridad PDF vs texto mas abajo.
vi.mock('jspdf-autotable', async (importOriginal) => {
  const actual = await importOriginal<{ default: (doc: unknown, opts: unknown) => void }>()
  return { ...actual, default: vi.fn(actual.default) }
})

function baseInput(overrides: Partial<BuildReciboDataInput> = {}): BuildReciboDataInput {
  return {
    nroFactura: 'FAC-000123',
    fecha: '2026-08-13T10:30:00.000-04:00',
    emisor: { nombre: 'ClaraPOS Estetica C.A.', rif: 'J-12345678-9', direccion: 'Av. Principal, Caracas' },
    cliente: { nombre: 'Maria Perez', identificacion: 'V-12345678', direccion: 'Calle 5, Valencia' },
    lineas: [],
    tasa: '40.5000',
    igtfUsd: null,
    pagos: [],
    discrepancy: null,
    saldoPendUsd: 0,
    ...overrides,
  }
}

describe('RECIBO_ANCHO_CHARS y generarSeparador', () => {
  it('RECIBO_ANCHO_CHARS es 32 (58mm termico, fuente ESC/POS Font A)', () => {
    expect(RECIBO_ANCHO_CHARS).toBe(32)
  })

  it('generarSeparador() sin argumentos retorna exactamente 32 guiones', () => {
    const separador = generarSeparador()

    expect(separador).toBe('-'.repeat(32))
    expect(separador.length).toBe(RECIBO_ANCHO_CHARS)
  })

  it('generarSeparador(10) retorna exactamente 10 guiones', () => {
    expect(generarSeparador(10)).toBe('----------')
  })
})

describe('medirAnchoPngDesdeSeparador', () => {
  /** Mock deterministico: 10px por caracter, igual convencion que recibo-pagos.test.ts. */
  function mockCtx(): CanvasRenderingContext2D {
    return {
      measureText: (text: string) => ({ width: text.length * 10 }) as TextMetrics,
    } as unknown as CanvasRenderingContext2D
  }

  it('mide el ancho del separador canonico de 32 caracteres + padding a cada lado', () => {
    const separador = generarSeparador()

    expect(medirAnchoPngDesdeSeparador(mockCtx(), separador, 24)).toBe(32 * 10 + 24 * 2)
  })

  it('con un separador mas corto, el ancho medido es proporcionalmente menor', () => {
    const separador = generarSeparador(10)

    expect(medirAnchoPngDesdeSeparador(mockCtx(), separador, 24)).toBe(10 * 10 + 24 * 2)
  })
})

describe('formatParPrimarioContraparte y formatMontoBimonetario', () => {
  it("moneda 'USD': USD es primario, Bs entre parentesis", () => {
    expect(formatParPrimarioContraparte(10, 5000, 'USD')).toEqual({
      primario: '$10.00',
      contraparte: 'Bs. 5.000,00',
    })
    expect(formatMontoBimonetario(10, 5000, 'USD')).toBe('$10.00 (Bs. 5.000,00)')
  })

  it("moneda 'BS': Bs es primario, USD entre parentesis", () => {
    expect(formatParPrimarioContraparte(10, 5000, 'BS')).toEqual({
      primario: 'Bs. 5.000,00',
      contraparte: '$10.00',
    })
    expect(formatMontoBimonetario(10, 5000, 'BS')).toBe('Bs. 5.000,00 ($10.00)')
  })
})

describe('formatMontoPrimario', () => {
  it("moneda 'USD': retorna SOLO el monto en USD, sin contraparte", () => {
    expect(formatMontoPrimario(10, 5000, 'USD')).toBe('$10.00')
  })

  it("moneda 'BS': retorna SOLO el monto en Bs, sin contraparte", () => {
    expect(formatMontoPrimario(10, 5000, 'BS')).toBe('Bs. 5.000,00')
  })
})

describe('buildReciboData', () => {
  it('single alicuota: una linea Gravable al 16% calcula base, iva y total general', () => {
    const recibo = buildReciboData(
      baseInput({
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Crema Facial',
            cantidad: '2',
            precioUnitarioUsd: '10.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
      })
    )

    expect(recibo.totales.baseImponibleUsd).toBe(20)
    expect(recibo.totales.montoExentoUsd).toBe(0)
    expect(recibo.totales.alicuotas).toEqual([{ pct: 16, baseUsd: 20, ivaUsd: 3.2, ivaBs: 129.6 }])
    expect(recibo.totales.totalGeneralUsd).toBe(23.2)
    expect(recibo.totales.totalGeneralBs).toBeCloseTo(23.2 * 40.5, 5)
  })

  it('mixed alicuotas: lineas al 16% y al 8% generan dos buckets separados', () => {
    const recibo = buildReciboData(
      baseInput({
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Crema Facial',
            cantidad: '1',
            precioUnitarioUsd: '100.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
          {
            codigo: 'PROD-002',
            nombre: 'Vitamina C',
            cantidad: '1',
            precioUnitarioUsd: '50.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '8',
          },
        ],
      })
    )

    expect(recibo.totales.baseImponibleUsd).toBe(150)
    expect(recibo.totales.alicuotas).toEqual([
      { pct: 8, baseUsd: 50, ivaUsd: 4, ivaBs: 162 },
      { pct: 16, baseUsd: 100, ivaUsd: 16, ivaBs: 648 },
    ])
    expect(recibo.totales.totalGeneralUsd).toBe(170)
  })

  it('fully exento/exonerado: ambos tipos van al bucket montoExentoUsd, sin alicuotas', () => {
    const recibo = buildReciboData(
      baseInput({
        lineas: [
          {
            codigo: 'PROD-003',
            nombre: 'Servicio Medico',
            cantidad: '1',
            precioUnitarioUsd: '30.00',
            tipoImpuesto: 'Exento',
            impuestoPct: '0',
          },
          {
            codigo: 'PROD-004',
            nombre: 'Consulta Exonerada',
            cantidad: '1',
            precioUnitarioUsd: '20.00',
            tipoImpuesto: 'Exonerado',
            impuestoPct: '0',
          },
        ],
      })
    )

    expect(recibo.totales.montoExentoUsd).toBe(50)
    expect(recibo.totales.baseImponibleUsd).toBe(0)
    expect(recibo.totales.alicuotas).toEqual([])
    expect(recibo.totales.totalGeneralUsd).toBe(50)
    expect(recibo.lineas.every((l) => l.esExento)).toBe(true)
  })

  it('igtf presente: se suma al total general y queda expuesto en totales.igtfUsd', () => {
    const recibo = buildReciboData(
      baseInput({
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Crema Facial',
            cantidad: '1',
            precioUnitarioUsd: '100.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
        igtfUsd: 3.48,
      })
    )

    expect(recibo.totales.igtfUsd).toBe(3.48)
    expect(recibo.totales.totalGeneralUsd).toBe(119.48)
  })

  it('igtf ausente: totales.igtfUsd es null y no se suma nada al total general', () => {
    const recibo = buildReciboData(
      baseInput({
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Crema Facial',
            cantidad: '1',
            precioUnitarioUsd: '100.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
        igtfUsd: null,
      })
    )

    expect(recibo.totales.igtfUsd).toBeNull()
    expect(recibo.totales.totalGeneralUsd).toBe(116)
  })

  it('propaga nroFactura, fecha, emisor y cliente sin transformarlos', () => {
    const recibo = buildReciboData(baseInput())

    expect(recibo.nroFactura).toBe('FAC-000123')
    expect(recibo.fecha).toBe('2026-08-13T10:30:00.000-04:00')
    expect(recibo.emisor).toEqual({
      nombre: 'ClaraPOS Estetica C.A.',
      rif: 'J-12345678-9',
      direccion: 'Av. Principal, Caracas',
    })
    expect(recibo.cliente).toEqual({
      nombre: 'Maria Perez',
      identificacion: 'V-12345678',
      direccion: 'Calle 5, Valencia',
    })
  })

  it('agrupa los pagos por metodo usando agruparPagosPorMetodo', () => {
    const pagos: ReciboPagoInput[] = [
      { metodo_cobro_id: 'pm-1', metodo_nombre: 'Pago Movil Mercantil', moneda: 'BS', monto: 100 },
      { metodo_cobro_id: 'pm-1', metodo_nombre: 'Pago Movil Mercantil', moneda: 'BS', monto: 100 },
      { metodo_cobro_id: 'ef-usd', metodo_nombre: 'Efectivo Dolares', moneda: 'USD', monto: 1 },
    ]
    const recibo = buildReciboData(baseInput({ tasa: '500', pagos }))

    expect(recibo.pagos).toHaveLength(2)
    const pagoMovil = recibo.pagos.find((p) => p.metodoCobroId === 'pm-1')
    expect(pagoMovil?.montoBs).toBe(200)
    const efectivo = recibo.pagos.find((p) => p.metodoCobroId === 'ef-usd')
    expect(efectivo?.montoUsd).toBe(1)
    expect(efectivo?.montoBs).toBe(500)
  })

  it('sin discrepancia ni saldo pendiente, cierre es null', () => {
    const recibo = buildReciboData(baseInput())
    expect(recibo.cierre).toBeNull()
  })

  it('con saldo_pend_usd > 0, cierre es CREDITO calculado con la tasa', () => {
    const recibo = buildReciboData(baseInput({ tasa: '100', saldoPendUsd: 5 }))
    expect(recibo.cierre).toEqual({ tipo: 'CREDITO', montoUsd: 5, montoBs: 500 })
  })

  it('con discrepancy VUELTO, cierre refleja el modo y montos de la discrepancia', () => {
    const recibo = buildReciboData(
      baseInput({
        discrepancy: { mode: 'VUELTO', montoUsd: 2, montoBs: 100 },
      })
    )
    expect(recibo.cierre).toEqual({ tipo: 'VUELTO', montoUsd: 2, montoBs: 100 })
  })
})

describe('buildReciboData — campos Bs y monedaPresentacion (WU2)', () => {
  it('lineas[].precioUnitarioBs y totalBs se calculan como usd * tasa (tasa 40.5)', () => {
    const recibo = buildReciboData(
      baseInput({
        tasa: '40.5000',
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Crema Facial',
            cantidad: '2',
            precioUnitarioUsd: '10.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
      })
    )

    expect(recibo.lineas[0].precioUnitarioBs).toBe(405)
    expect(recibo.lineas[0].totalBs).toBe(810)
  })

  it('totales.montoExentoBs, baseImponibleBs, igtfBs y alicuotas[].ivaBs se calculan como usd * tasa (tasa 10)', () => {
    const recibo = buildReciboData(
      baseInput({
        tasa: '10',
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Exento',
            cantidad: '1',
            precioUnitarioUsd: '1.00',
            tipoImpuesto: 'Exento',
            impuestoPct: '0',
          },
          {
            codigo: 'PROD-002',
            nombre: 'Gravable 16%',
            cantidad: '1',
            precioUnitarioUsd: '2.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
        igtfUsd: 0.5,
      })
    )

    expect(recibo.totales.montoExentoBs).toBe(10)
    expect(recibo.totales.baseImponibleBs).toBe(20)
    expect(recibo.totales.alicuotas[0]).toEqual({ pct: 16, baseUsd: 2, ivaUsd: 0.32, ivaBs: 3.2 })
    expect(recibo.totales.igtfBs).toBe(5)
  })

  it('totales.igtfBs es null cuando igtfUsd es null', () => {
    const recibo = buildReciboData(baseInput({ tasa: '10', igtfUsd: null }))
    expect(recibo.totales.igtfBs).toBeNull()
  })

  it("monedaPresentacion por defecto es 'USD' cuando se omite en el input", () => {
    const recibo = buildReciboData(baseInput())
    expect(recibo.monedaPresentacion).toBe('USD')
  })

  it("monedaPresentacion 'BS' explicita se propaga sin logica ad-hoc", () => {
    const recibo = buildReciboData(baseInput({ monedaPresentacion: 'BS' }))
    expect(recibo.monedaPresentacion).toBe('BS')
  })
})

describe('buildReciboData — totalFacturaUsd/totalFacturaBs (subtotal pre-IGTF)', () => {
  function reciboConIgtf() {
    return buildReciboData(
      baseInput({
        tasa: '10',
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Exento',
            cantidad: '1',
            precioUnitarioUsd: '1.00',
            tipoImpuesto: 'Exento',
            impuestoPct: '0',
          },
          {
            codigo: 'PROD-002',
            nombre: 'Gravable 8%',
            cantidad: '1',
            precioUnitarioUsd: '1.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '8',
          },
          {
            codigo: 'PROD-003',
            nombre: 'Gravable 16%',
            cantidad: '1',
            precioUnitarioUsd: '1.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
        igtfUsd: 0.06,
      })
    )
  }

  it('totalFacturaUsd = exento + base imponible + iva total, excluye IGTF', () => {
    const recibo = reciboConIgtf()
    // Exento $1 + Base $2 (dos lineas gravables) + IVA8% $0.08 + IVA16% $0.16 = $3.24
    expect(recibo.totales.totalFacturaUsd).toBe(3.24)
  })

  it('con IGTF, totalGeneralUsd = totalFacturaUsd + igtf, pero totalFacturaUsd no cambia', () => {
    const recibo = reciboConIgtf()
    expect(recibo.totales.totalGeneralUsd).toBe(3.3)
    expect(recibo.totales.totalFacturaUsd).toBe(3.24)
  })

  it('totalFacturaBs = totalFacturaUsd convertido a la tasa de la venta', () => {
    const recibo = reciboConIgtf()
    expect(recibo.totales.totalFacturaBs).toBe(32.4)
  })

  it('sin IGTF, totalFacturaUsd coincide con totalGeneralUsd (no hay IGTF que restar)', () => {
    const recibo = buildReciboData(
      baseInput({
        tasa: '10',
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Gravable 16%',
            cantidad: '1',
            precioUnitarioUsd: '10.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
        igtfUsd: null,
      })
    )
    expect(recibo.totales.totalFacturaUsd).toBe(recibo.totales.totalGeneralUsd)
    expect(recibo.totales.totalFacturaUsd).toBe(11.6)
  })
})

describe('construirFilasTotales', () => {
  function totalesFixture(overrides: Partial<ReciboTotales> = {}): ReciboTotales {
    return {
      montoExentoUsd: 1,
      montoExentoBs: 10,
      baseImponibleUsd: 3,
      baseImponibleBs: 30,
      alicuotas: [
        { pct: 8, baseUsd: 1, ivaUsd: 0.08, ivaBs: 0.8 },
        { pct: 16, baseUsd: 2, ivaUsd: 0.16, ivaBs: 1.6 },
      ],
      igtfUsd: 0.06,
      igtfBs: 0.6,
      totalFacturaUsd: 4.24,
      totalFacturaBs: 42.4,
      totalGeneralUsd: 4.3,
      totalGeneralBs: 43,
      ...overrides,
    }
  }

  it("con IGTF > 0 y moneda 'USD': orden Exento -> Base -> alicuotas -> TOTAL FACTURA (subtotal) -> IGTF -> TOTAL + IGTF (bold, final); intermedias muestran SOLO USD, las 2 filas finales muestran USD + equivalente Bs entre parentesis", () => {
    const filas = construirFilasTotales(totalesFixture(), 'USD')

    expect(filas.map((f) => f.label)).toEqual([
      'Monto Exento',
      'Base Imponible',
      'IVA 8%',
      'IVA 16%',
      'TOTAL FACTURA',
      'IGTF',
      'TOTAL + IGTF',
    ])
    expect(filas[0]).toEqual({ label: 'Monto Exento', monto: '$1.00', montoBs: 'Bs. 10,00', bold: false })
    expect(filas[1]).toEqual({ label: 'Base Imponible', monto: '$3.00', montoBs: 'Bs. 30,00', bold: false })
    expect(filas[2]).toEqual({ label: 'IVA 8%', monto: '$0.08', montoBs: 'Bs. 0,80', bold: false })
    expect(filas[4]).toEqual({ label: 'TOTAL FACTURA', monto: '$4.24 (Bs. 42,40)', montoBs: null, bold: false })
    expect(filas[5]).toEqual({ label: 'IGTF', monto: '$0.06', montoBs: 'Bs. 0,60', bold: false })
    expect(filas[6]).toEqual({ label: 'TOTAL + IGTF', monto: '$4.30 (Bs. 43,00)', montoBs: null, bold: true })
  })

  it("con moneda 'BS': las filas intermedias muestran SOLO Bs; las 2 filas finales (TOTAL FACTURA e TOTAL + IGTF) muestran Bs primario + USD entre parentesis (toggle-aware)", () => {
    const filas = construirFilasTotales(totalesFixture(), 'BS')

    expect(filas[0]).toEqual({ label: 'Monto Exento', monto: 'Bs. 10,00', montoBs: null, bold: false })
    expect(filas[1]).toEqual({ label: 'Base Imponible', monto: 'Bs. 30,00', montoBs: null, bold: false })
    expect(filas[2]).toEqual({ label: 'IVA 8%', monto: 'Bs. 0,80', montoBs: null, bold: false })
    expect(filas[4]).toEqual({ label: 'TOTAL FACTURA', monto: 'Bs. 42,40 ($4.24)', montoBs: null, bold: false })
    expect(filas[5]).toEqual({ label: 'IGTF', monto: 'Bs. 0,60', montoBs: null, bold: false })
    expect(filas[6]).toEqual({ label: 'TOTAL + IGTF', monto: 'Bs. 43,00 ($4.30)', montoBs: null, bold: true })
  })

  it('sin IGTF (null): TOTAL FACTURA es la fila final, bold, muestra USD + equivalente Bs entre parentesis (toggle-aware), sin fila de IGTF ni sufijo "+ IGTF"', () => {
    const filas = construirFilasTotales(totalesFixture({ igtfUsd: null, igtfBs: null }), 'USD')

    expect(filas.map((f) => f.label)).not.toContain('IGTF')
    expect(filas.map((f) => f.label)).not.toContain('TOTAL + IGTF')
    expect(filas.at(-1)).toEqual({ label: 'TOTAL FACTURA', monto: '$4.24 (Bs. 42,40)', montoBs: null, bold: true })
  })

  it('sin IGTF (0): mismo comportamiento que null — sin fila de IGTF', () => {
    const filas = construirFilasTotales(totalesFixture({ igtfUsd: 0, igtfBs: 0 }), 'USD')

    expect(filas.map((f) => f.label)).not.toContain('IGTF')
    expect(filas.at(-1)?.bold).toBe(true)
  })

  it('sin monto exento ni base imponible: omite esas filas (no aparecen en 0)', () => {
    const filas = construirFilasTotales(
      totalesFixture({ montoExentoUsd: 0, montoExentoBs: 0, baseImponibleUsd: 0, baseImponibleBs: 0, alicuotas: [] }),
      'USD'
    )

    expect(filas.map((f) => f.label)).toEqual(['TOTAL FACTURA', 'IGTF', 'TOTAL + IGTF'])
  })
})

describe('paridad: PDF vs texto en orden de totales', () => {
  it('el body de la tabla de totales del PDF coincide exactamente con construirFilasTotales del mismo recibo', () => {
    const mockedAutoTable = vi.mocked(autoTable)
    mockedAutoTable.mockClear()

    const recibo = buildReciboData(
      baseInput({
        tasa: '10',
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Exento',
            cantidad: '1',
            precioUnitarioUsd: '1.00',
            tipoImpuesto: 'Exento',
            impuestoPct: '0',
          },
          {
            codigo: 'PROD-002',
            nombre: 'Gravable 8%',
            cantidad: '1',
            precioUnitarioUsd: '1.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '8',
          },
          {
            codigo: 'PROD-003',
            nombre: 'Gravable 16%',
            cantidad: '1',
            precioUnitarioUsd: '1.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
        igtfUsd: 0.06,
      })
    )

    buildReciboPdfBlob(recibo)

    // 1ra llamada a autoTable: tabla de articulos. 2da llamada: tabla de totales
    // (orden fijo dentro de buildReciboPdfBlob).
    const totalesCall = mockedAutoTable.mock.calls[1]
    const totalesBody = (totalesCall[1] as { body: string[][] }).body

    const filasEsperadas = construirFilasTotales(recibo.totales, recibo.monedaPresentacion).map((f) => [
      f.label,
      f.monto,
    ])

    expect(totalesBody).toEqual(filasEsperadas)

    const texto = buildReciboTextoPlano(recibo)
    for (const fila of construirFilasTotales(recibo.totales, recibo.monedaPresentacion)) {
      expect(texto).toContain(`${fila.label}: ${fila.monto}`)
    }
  })
})

describe('paridad: PDF vs texto en linea de articulos (WU3)', () => {
  it('con moneda "USD" (default), la tabla de articulos del PDF muestra SOLO USD (sin contraparte), igual que el texto/PNG', () => {
    const mockedAutoTable = vi.mocked(autoTable)
    mockedAutoTable.mockClear()

    const recibo = buildReciboData(
      baseInput({
        tasa: '500',
        lineas: [
          {
            codigo: 'PROD-999',
            nombre: 'Item Bimonetario',
            cantidad: '1',
            precioUnitarioUsd: '10.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
      })
    )

    buildReciboPdfBlob(recibo)

    // 1ra llamada a autoTable: tabla de articulos (orden fijo dentro de buildReciboPdfBlob).
    const articulosCall = mockedAutoTable.mock.calls[0]
    const articulosBody = (articulosCall[1] as { body: string[][] }).body

    expect(articulosBody).toEqual([['PROD-999', 'Item Bimonetario', '1', '$10.00', '$10.00']])

    const texto = buildReciboTextoPlano(recibo)
    expect(texto).toContain('1 x $10.00 = $10.00')
  })

  it('con moneda "BS", la tabla de articulos del PDF muestra SOLO Bs (sin contraparte), igual que el texto/PNG', () => {
    const mockedAutoTable = vi.mocked(autoTable)
    mockedAutoTable.mockClear()

    const recibo = buildReciboData(
      baseInput({
        tasa: '500',
        monedaPresentacion: 'BS',
        lineas: [
          {
            codigo: 'PROD-999',
            nombre: 'Item Bimonetario',
            cantidad: '1',
            precioUnitarioUsd: '10.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
      })
    )

    buildReciboPdfBlob(recibo)

    const articulosCall = mockedAutoTable.mock.calls[0]
    const articulosBody = (articulosCall[1] as { body: string[][] }).body

    expect(articulosBody).toEqual([['PROD-999', 'Item Bimonetario', '1', 'Bs. 5.000,00', 'Bs. 5.000,00']])

    const texto = buildReciboTextoPlano(recibo)
    expect(texto).toContain('1 x Bs. 5.000,00 = Bs. 5.000,00')
  })
})

describe('buildReciboPdfBlob — Total abonos en tabla de pagos (paridad con texto)', () => {
  it('el body de la tabla de pagos del PDF termina con la fila Total abonos, igual que el texto', () => {
    const mockedAutoTable = vi.mocked(autoTable)
    mockedAutoTable.mockClear()

    const recibo = buildReciboData(
      baseInput({
        tasa: '100',
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Crema Facial',
            cantidad: '1',
            precioUnitarioUsd: '10.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
        pagos: [
          { metodo_cobro_id: 'ef-usd', metodo_nombre: 'Efectivo Dolares', moneda: 'USD', monto: 10 },
          { metodo_cobro_id: 'pv-bs', metodo_nombre: 'Punto de Venta Banesco', moneda: 'BS', monto: 200 },
        ],
      })
    )

    buildReciboPdfBlob(recibo)

    // 1ra llamada: articulos, 2da: totales, 3ra: pagos (orden fijo dentro de buildReciboPdfBlob).
    const pagosCall = mockedAutoTable.mock.calls[2]
    const pagosBody = (pagosCall[1] as { body: string[][] }).body

    expect(pagosBody.at(-1)).toEqual(['Total abonos', '$12.00 (Bs. 1.200,00)'])
  })
})

describe('formatearCierre — SAF con referencia de factura(s) (B5)', () => {
  function reciboConDiscrepancy(discrepancy: BuildReciboDataInput['discrepancy']): ReciboData {
    return buildReciboData(
      baseInput({
        tasa: '500',
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Crema Facial',
            cantidad: '1',
            precioUnitarioUsd: '10.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
        discrepancy,
      })
    )
  }

  it('1 factura: la linea de cierre muestra "Abono aplicado a factura(s) {nro} por Bs X ($Y)"', () => {
    const texto = buildReciboTextoPlano(
      reciboConDiscrepancy({
        mode: 'SAF',
        montoUsd: 1,
        montoBs: 500,
        invoiceAssignments: [{ nroFactura: '1234', montoUsd: 1 }],
      })
    )

    expect(texto).toContain('Abono aplicado a factura(s) 1234 por Bs. 500,00 ($1.00)')
  })

  it('2 facturas (FIFO): la linea de cierre lista ambas con su monto aplicado', () => {
    const texto = buildReciboTextoPlano(
      reciboConDiscrepancy({
        mode: 'SAF',
        montoUsd: 1,
        montoBs: 500,
        invoiceAssignments: [
          { nroFactura: '1234', montoUsd: 0.6 },
          { nroFactura: '1235', montoUsd: 0.4 },
        ],
      })
    )

    expect(texto).toContain(
      'Abono aplicado a factura(s) 1234 por Bs. 300,00 ($0.60), 1235 por Bs. 200,00 ($0.40)'
    )
  })

  it('SAF sin invoiceAssignments (saldo a favor puro): conserva el texto actual', () => {
    const texto = buildReciboTextoPlano(reciboConDiscrepancy({ mode: 'SAF', montoUsd: 1, montoBs: 500 }))

    expect(texto).toContain('Saldo a favor del cliente: Bs. 500,00 ($1.00)')
    expect(texto).not.toContain('Abono aplicado a factura')
  })

  it('VUELTO no cambia su texto/comportamiento (invoiceAssignments no aplica a este modo)', () => {
    const texto = buildReciboTextoPlano(reciboConDiscrepancy({ mode: 'VUELTO', montoUsd: 1, montoBs: 500 }))

    expect(texto).toContain('Vuelto entregado: Bs. 500,00 ($1.00)')
  })

  it('PROPINA no cambia su texto/comportamiento', () => {
    const texto = buildReciboTextoPlano(reciboConDiscrepancy({ mode: 'PROPINA', montoUsd: 1, montoBs: 500 }))

    expect(texto).toContain('Propina: Bs. 500,00 ($1.00)')
  })

  it('DIFERENCIAL_SOBRANTE no cambia su texto/comportamiento', () => {
    const texto = buildReciboTextoPlano(
      reciboConDiscrepancy({ mode: 'DIFERENCIAL_SOBRANTE', montoUsd: 1, montoBs: 500 })
    )

    expect(texto).toContain('Diferencial cambiario (sobrante): Bs. 500,00 ($1.00)')
  })
})

describe('formatMontoPago (moneda del pago coincide con M -> solo M; si no coincide -> nativa primaria + equivalente)', () => {
  function pagoFixture(overrides: Partial<ReciboPagoLinea> = {}): ReciboPagoLinea {
    return {
      metodoCobroId: 'pm-1',
      metodoNombre: 'PDV Banesco',
      moneda: 'BS',
      montoNativo: 300,
      montoBs: 300,
      montoUsd: 0.6,
      ...overrides,
    }
  }

  it("pago nativo USD y M='USD' (coinciden): muestra SOLO USD, sin equivalente", () => {
    const linea = pagoFixture({ moneda: 'USD', montoNativo: 1, montoUsd: 1, montoBs: 500 })
    expect(formatMontoPago(linea, 'USD')).toBe('$1.00')
  })

  it("pago nativo USD y M='BS' (no coinciden): USD sigue siendo primario, con Bs entre parentesis", () => {
    const linea = pagoFixture({ moneda: 'USD', montoNativo: 1, montoUsd: 1, montoBs: 500 })
    expect(formatMontoPago(linea, 'BS')).toBe('$1.00 (Bs. 500,00)')
  })

  it("pago nativo BS y M='BS' (coinciden): muestra SOLO Bs, sin equivalente", () => {
    const linea = pagoFixture({ moneda: 'BS', montoNativo: 300, montoBs: 300, montoUsd: 0.6 })
    expect(formatMontoPago(linea, 'BS')).toBe('Bs. 300,00')
  })

  it("pago nativo BS y M='USD' (no coinciden): Bs sigue siendo primario, con USD entre parentesis", () => {
    const linea = pagoFixture({ moneda: 'BS', montoNativo: 300, montoBs: 300, montoUsd: 0.6 })
    expect(formatMontoPago(linea, 'USD')).toBe('Bs. 300,00 ($0.60)')
  })
})

describe('sumarAbonos', () => {
  it('suma montoUsd y montoBs de todas las lineas de pago (USD + BS mezclados)', () => {
    const pagos: ReciboPagoLinea[] = [
      {
        metodoCobroId: 'ef-usd',
        metodoNombre: 'Efectivo Dolares',
        moneda: 'USD',
        montoNativo: 10,
        montoUsd: 10,
        montoBs: 1000,
      },
      {
        metodoCobroId: 'pv-bs',
        metodoNombre: 'Punto de Venta Banesco',
        moneda: 'BS',
        montoNativo: 200,
        montoUsd: 2,
        montoBs: 200,
      },
    ]

    expect(sumarAbonos(pagos)).toEqual({ usd: 12, bs: 1200 })
  })

  it('con un solo metodo de pago, retorna exactamente su monto (sin duplicar)', () => {
    const pagos: ReciboPagoLinea[] = [
      {
        metodoCobroId: 'ef-usd',
        metodoNombre: 'Efectivo Dolares',
        moneda: 'USD',
        montoNativo: 5,
        montoUsd: 5,
        montoBs: 500,
      },
    ]

    expect(sumarAbonos(pagos)).toEqual({ usd: 5, bs: 500 })
  })
})

describe('buildReciboTextoPlano', () => {
  function reciboConLineas(): ReciboData {
    return buildReciboData(
      baseInput({
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Crema Facial',
            cantidad: '1',
            precioUnitarioUsd: '100.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
          {
            codigo: 'PROD-002',
            nombre: 'Vitamina C',
            cantidad: '1',
            precioUnitarioUsd: '50.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '8',
          },
          {
            codigo: 'PROD-003',
            nombre: 'Servicio Medico',
            cantidad: '1',
            precioUnitarioUsd: '30.00',
            tipoImpuesto: 'Exento',
            impuestoPct: '0',
          },
        ],
        igtfUsd: 5.4,
      })
    )
  }

  it('usa la palabra RECIBO y nunca la palabra Factura', () => {
    const texto = buildReciboTextoPlano(reciboConLineas())

    expect(texto).toContain('RECIBO')
    expect(texto).not.toContain('Factura')
  })

  it('marca las lineas exentas con (E)', () => {
    const texto = buildReciboTextoPlano(reciboConLineas())

    expect(texto).toContain('Servicio Medico (E)')
  })

  it('incluye una linea por cada alicuota agrupada', () => {
    const texto = buildReciboTextoPlano(reciboConLineas())

    expect(texto).toContain('IVA 16%')
    expect(texto).toContain('IVA 8%')
  })

  it('incluye la linea de IGTF solo cuando igtfUsd no es null', () => {
    const conIgtf = buildReciboTextoPlano(reciboConLineas())
    expect(conIgtf).toContain('IGTF')

    const sinIgtf = buildReciboTextoPlano(
      buildReciboData(
        baseInput({
          lineas: [
            {
              codigo: 'PROD-001',
              nombre: 'Crema Facial',
              cantidad: '1',
              precioUnitarioUsd: '100.00',
              tipoImpuesto: 'Gravable',
              impuestoPct: '16',
            },
          ],
          igtfUsd: null,
        })
      )
    )
    expect(sinIgtf).not.toContain('IGTF')
  })

  it('el emisor aparece antes que el numero/fecha de recibo (orden de secciones)', () => {
    const texto = buildReciboTextoPlano(reciboConLineas())

    const idxEmisor = texto.indexOf('ClaraPOS Estetica C.A.')
    const idxNroFecha = texto.indexOf('RECIBO\nNro:')
    expect(idxEmisor).toBeGreaterThanOrEqual(0)
    expect(idxNroFecha).toBeGreaterThan(idxEmisor)
  })

  it("linea de articulo con moneda 'USD' (default): muestra SOLO USD (sin contraparte) en precio unitario y total", () => {
    const recibo = buildReciboData(
      baseInput({
        tasa: '500',
        lineas: [
          {
            codigo: 'PROD-999',
            nombre: 'Item Bimonetario',
            cantidad: '1',
            precioUnitarioUsd: '10.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
      })
    )
    const texto = buildReciboTextoPlano(recibo)

    expect(texto).toContain('1 x $10.00 = $10.00')
  })

  it("linea de articulo con moneda 'BS': muestra SOLO Bs (sin contraparte) en precio unitario y total", () => {
    const recibo = buildReciboData(
      baseInput({
        tasa: '500',
        monedaPresentacion: 'BS',
        lineas: [
          {
            codigo: 'PROD-999',
            nombre: 'Item Bimonetario',
            cantidad: '1',
            precioUnitarioUsd: '10.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
      })
    )
    const texto = buildReciboTextoPlano(recibo)

    expect(texto).toContain('1 x Bs. 5.000,00 = Bs. 5.000,00')
  })

  it('sin pagos, no incluye la seccion Metodos de pago', () => {
    const texto = buildReciboTextoPlano(reciboConLineas())
    expect(texto).not.toContain('Metodos de pago')
  })

  it('con pagos agrupados, incluye la seccion Metodos de pago con cada linea', () => {
    const recibo = buildReciboData(
      baseInput({
        tasa: '40.5000',
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Crema Facial',
            cantidad: '1',
            precioUnitarioUsd: '100.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
        pagos: [
          { metodo_cobro_id: 'pv-1', metodo_nombre: 'Punto de Venta Banesco', moneda: 'BS', monto: 300 },
        ],
      })
    )
    const texto = buildReciboTextoPlano(recibo)

    expect(texto).toContain('Metodos de pago')
    expect(texto).toContain('Punto de Venta Banesco')
    expect(texto).toContain('Bs. 300,00')
  })

  it("con pagos mixtos (USD + BS) y monedaPresentacion 'USD' (default), la seccion de pagos termina con 'Total abonos: $12.00 (Bs. 1.200,00)'", () => {
    const recibo = buildReciboData(
      baseInput({
        tasa: '100',
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Crema Facial',
            cantidad: '1',
            precioUnitarioUsd: '10.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
        pagos: [
          { metodo_cobro_id: 'ef-usd', metodo_nombre: 'Efectivo Dolares', moneda: 'USD', monto: 10 },
          { metodo_cobro_id: 'pv-bs', metodo_nombre: 'Punto de Venta Banesco', moneda: 'BS', monto: 200 },
        ],
      })
    )
    const texto = buildReciboTextoPlano(recibo)

    expect(texto).toContain('Total abonos: $12.00 (Bs. 1.200,00)')
  })

  it("con pagos mixtos (USD + BS) y monedaPresentacion 'BS', la seccion de pagos termina con 'Total abonos: Bs. 1.200,00 ($12.00)'", () => {
    const recibo = buildReciboData(
      baseInput({
        tasa: '100',
        monedaPresentacion: 'BS',
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Crema Facial',
            cantidad: '1',
            precioUnitarioUsd: '10.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
        pagos: [
          { metodo_cobro_id: 'ef-usd', metodo_nombre: 'Efectivo Dolares', moneda: 'USD', monto: 10 },
          { metodo_cobro_id: 'pv-bs', metodo_nombre: 'Punto de Venta Banesco', moneda: 'BS', monto: 200 },
        ],
      })
    )
    const texto = buildReciboTextoPlano(recibo)

    expect(texto).toContain('Total abonos: Bs. 1.200,00 ($12.00)')
  })

  it('sin cierre (sin discrepancia ni credito), no incluye linea de credito/vuelto', () => {
    const texto = buildReciboTextoPlano(reciboConLineas())
    expect(texto).not.toContain('Quedo a credito')
  })

  it('sin pagos, no incluye la linea Total abonos', () => {
    const texto = buildReciboTextoPlano(reciboConLineas())
    expect(texto).not.toContain('Total abonos')
  })

  it('con saldo a credito, la ultima linea muestra "Quedo a credito"', () => {
    const recibo = buildReciboData(
      baseInput({
        tasa: '100',
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Crema Facial',
            cantidad: '1',
            precioUnitarioUsd: '100.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
        saldoPendUsd: 10,
      })
    )
    const texto = buildReciboTextoPlano(recibo)
    const lineas = texto.split('\n').filter((l) => l.trim() !== '')

    expect(lineas[lineas.length - 1]).toContain('Quedo a credito')
    expect(lineas[lineas.length - 1]).toContain('Bs. 1.000,00')
    expect(lineas[lineas.length - 1]).toContain('$10.00')
  })
})

describe('backward-compat guard (WU2, task 4.1): moneda_presentacion_documentos ausente', () => {
  it('con monedaPresentacion default USD: pago nativo USD coincide con M (solo USD), formatearCierre sin cambios y fila final bold muestra USD + equivalente Bs', () => {
    const recibo = buildReciboData(
      baseInput({
        tasa: '500',
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Crema Facial',
            cantidad: '1',
            precioUnitarioUsd: '10.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
        igtfUsd: null,
        pagos: [{ metodo_cobro_id: 'ef-usd', metodo_nombre: 'Efectivo Dolares', moneda: 'USD', monto: 1 }],
        discrepancy: { mode: 'VUELTO', montoUsd: 1, montoBs: 500 },
        // monedaPresentacion omitida a proposito: simula empresas sin config (default 'USD')
      })
    )

    expect(recibo.monedaPresentacion).toBe('USD')

    const texto = buildReciboTextoPlano(recibo)
    // Pago USD-nativo con M='USD' (default): coinciden -> SOLO USD, sin equivalente
    expect(texto).toContain('Efectivo Dolares: $1.00')
    // Cierre (formatearCierre, no tocado en esta regla): formato sin cambios
    expect(texto).toContain('Vuelto entregado: Bs. 500,00 ($1.00)')
    // Fila final bold (sin IGTF -> TOTAL FACTURA es la final): USD primario + Bs entre parentesis (toggle-aware)
    const filas = construirFilasTotales(recibo.totales, recibo.monedaPresentacion)
    expect(filas.at(-1)).toEqual({
      label: 'TOTAL FACTURA',
      monto: '$11.60 (Bs. 5.800,00)',
      montoBs: null,
      bold: true,
    })
  })
})

describe('contrato v1: recibo sin descuento comercial (decision #1470)', () => {
  it('totalGeneralUsd = exento + base imponible + suma(iva) + igtf, sin restar ningun descuento', () => {
    const recibo = buildReciboData(
      baseInput({
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Crema Facial',
            cantidad: '2',
            precioUnitarioUsd: '25.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
          {
            codigo: 'PROD-002',
            nombre: 'Consulta',
            cantidad: '1',
            precioUnitarioUsd: '15.00',
            tipoImpuesto: 'Exento',
            impuestoPct: '0',
          },
        ],
        igtfUsd: 2.5,
      })
    )

    const sumaComponentes =
      recibo.totales.montoExentoUsd +
      recibo.totales.baseImponibleUsd +
      recibo.totales.alicuotas.reduce((sum, a) => sum + a.ivaUsd, 0) +
      (recibo.totales.igtfUsd ?? 0)

    expect(recibo.totales.totalGeneralUsd).toBeCloseTo(sumaComponentes, 8)
    // Los descuentos comerciales estan pausados (decision #1470): el contrato de
    // ReciboTotales no expone ningun campo de descuento, por lo que no existe
    // forma de que un descuento reduzca el total del recibo.
    expect('descuento' in recibo.totales).toBe(false)
    expect('descuentoUsd' in recibo.totales).toBe(false)
  })
})

function reciboMinimo(): ReciboData {
  return buildReciboData(
    baseInput({
      lineas: [
        {
          codigo: 'PROD-001',
          nombre: 'Crema Facial',
          cantidad: '1',
          precioUnitarioUsd: '10.00',
          tipoImpuesto: 'Gravable',
          impuestoPct: '16',
        },
      ],
    })
  )
}

describe('nombreArchivoRecibo', () => {
  function reciboCon(nroFactura: string, clienteNombre: string): ReciboData {
    return buildReciboData(
      baseInput({
        nroFactura,
        cliente: { nombre: clienteNombre, identificacion: 'V-1', direccion: null },
        lineas: [
          {
            codigo: 'PROD-001',
            nombre: 'Crema Facial',
            cantidad: '1',
            precioUnitarioUsd: '10.00',
            tipoImpuesto: 'Gravable',
            impuestoPct: '16',
          },
        ],
      })
    )
  }

  it('nombre normal: mayusculas, espacios a guiones, extension correcta', () => {
    const recibo = reciboCon('C01-000276', 'Francisco Palmar')

    expect(nombreArchivoRecibo(recibo, 'pdf')).toBe('RECIBO_C01-000276_FRANCISCO-PALMAR.pdf')
    expect(nombreArchivoRecibo(recibo, 'png')).toBe('RECIBO_C01-000276_FRANCISCO-PALMAR.png')
  })

  it('nombre con acentos y ene: normaliza sin diacriticos', () => {
    const recibo = reciboCon('C01-000300', 'José Ñoño')

    expect(nombreArchivoRecibo(recibo, 'pdf')).toBe('RECIBO_C01-000300_JOSE-NONO.pdf')
  })

  it('nombre con caracteres invalidos para sistema de archivos: los elimina', () => {
    const recibo = reciboCon('C01-000400', 'A/B:C')

    expect(nombreArchivoRecibo(recibo, 'pdf')).toBe('RECIBO_C01-000400_ABC.pdf')
  })

  it('nombre vacio o solo espacios: cae a solo el nro, sin segmento de cliente ni guion bajo colgante', () => {
    const recibo = reciboCon('C01-000500', '   ')

    expect(nombreArchivoRecibo(recibo, 'pdf')).toBe('RECIBO_C01-000500.pdf')
  })
})

describe('descargarReciboPdf', () => {
  it('genera el PDF y dispara la descarga via blob + anchor con el nombre de archivo sanitizado', () => {
    const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-pdf')
    const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const recibo = reciboMinimo()
    descargarReciboPdf(recibo)

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1)
    expect(createObjectURLSpy.mock.calls[0][0]).toBeInstanceOf(Blob)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:mock-pdf')

    clickSpy.mockRestore()
    createObjectURLSpy.mockRestore()
    revokeObjectURLSpy.mockRestore()
  })
})

describe('buildReciboImagenBlob', () => {
  it('cuando el entorno no soporta contexto 2D de canvas, rechaza con un error claro en vez de crashear', async () => {
    // happy-dom (entorno de test) no implementa render 2D real: HTMLCanvasElement.getContext()
    // siempre retorna null. Este test documenta la ruta de degradacion elegante ante esa
    // limitacion (o ante un fallo real de contexto 2D en un dispositivo de baja memoria).
    await expect(buildReciboImagenBlob(reciboMinimo())).rejects.toThrow(/contexto 2D/i)
  })
})

describe('esperarFuentesRecibo', () => {
  /**
   * Mock deterministico de FontFaceSet: solo se espia `.load()`, que es el unico
   * metodo que usa el gate de fuentes (ver bug de wrapping con fuente fallback en
   * DEUDA-3 / buildReciboImagenBlob).
   */
  function mockFontFaceSet(): FontFaceSet {
    return {
      load: vi.fn().mockResolvedValue([]),
    } as unknown as FontFaceSet
  }

  it('con un FontFaceSet real, carga la fuente monospace normal Y bold 13px antes de resolver', async () => {
    const fonts = mockFontFaceSet()

    await esperarFuentesRecibo(fonts)

    expect(fonts.load).toHaveBeenCalledWith('13px monospace')
    expect(fonts.load).toHaveBeenCalledWith('bold 13px monospace')
    expect(fonts.load).toHaveBeenCalledTimes(2)
  })

  it('sin FontFaceSet (entorno sin CSS Font Loading API), resuelve sin lanzar y sin llamar load', async () => {
    await expect(esperarFuentesRecibo(undefined)).resolves.toBeUndefined()
  })
})

describe('compartirReciboImagen', () => {
  const fakePngBlob = async (): Promise<Blob> => new Blob(['fake-png-bytes'], { type: 'image/png' })

  it('cuando navigator.share no existe, rechaza con un error claro (el boton Compartir debe estar oculto en la UI)', async () => {
    vi.stubGlobal('navigator', { ...navigator, share: undefined })

    await expect(compartirReciboImagen(reciboMinimo())).rejects.toThrow(/no esta disponible/i)

    vi.unstubAllGlobals()
  })

  it('cuando navigator.canShare({files}) es true, comparte la imagen PNG como archivo', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined)
    const canShareMock = vi.fn().mockReturnValue(true)
    vi.stubGlobal('navigator', { ...navigator, share: shareMock, canShare: canShareMock })

    const recibo = reciboMinimo()
    await compartirReciboImagen(recibo, fakePngBlob)

    expect(canShareMock).toHaveBeenCalledTimes(1)
    expect(shareMock).toHaveBeenCalledTimes(1)
    const payload = shareMock.mock.calls[0][0] as { files?: File[]; title?: string; text?: string }
    expect(payload.files).toHaveLength(1)
    expect(payload.files?.[0]).toBeInstanceOf(File)
    expect(payload.files?.[0].name).toBe(nombreArchivoRecibo(recibo, 'png'))
    expect(payload.title).toContain(recibo.nroFactura)
    expect(payload.text).toBeUndefined()

    vi.unstubAllGlobals()
  })

  it('cuando navigator.canShare({files}) es false, cae a compartir texto plano', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined)
    const canShareMock = vi.fn().mockReturnValue(false)
    vi.stubGlobal('navigator', { ...navigator, share: shareMock, canShare: canShareMock })

    await compartirReciboImagen(reciboMinimo(), fakePngBlob)

    expect(shareMock).toHaveBeenCalledTimes(1)
    const payload = shareMock.mock.calls[0][0] as { files?: File[]; text?: string }
    expect(payload.files).toBeUndefined()
    expect(payload.text).toContain('RECIBO')

    vi.unstubAllGlobals()
  })

  it('cuando la generacion de la imagen falla (ej. canvas no soportado), cae a compartir texto plano', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, share: shareMock })

    await compartirReciboImagen(reciboMinimo(), async () => {
      throw new Error('canvas no soportado')
    })

    expect(shareMock).toHaveBeenCalledTimes(1)
    const payload = shareMock.mock.calls[0][0] as { files?: File[]; text?: string }
    expect(payload.files).toBeUndefined()
    expect(payload.text).toContain('RECIBO')

    vi.unstubAllGlobals()
  })

  it('cuando navigator.share rechaza con AbortError, la promesa se resuelve sin lanzar', async () => {
    const shareMock = vi.fn().mockRejectedValue(new DOMException('AbortError', 'AbortError'))
    vi.stubGlobal('navigator', { ...navigator, share: shareMock })

    await expect(compartirReciboImagen(reciboMinimo(), fakePngBlob)).resolves.toBeUndefined()

    vi.unstubAllGlobals()
  })

  it('cuando navigator.share rechaza con un error generico, la promesa se rechaza', async () => {
    const shareMock = vi.fn().mockRejectedValue(new Error('permission denied'))
    vi.stubGlobal('navigator', { ...navigator, share: shareMock })

    await expect(compartirReciboImagen(reciboMinimo(), fakePngBlob)).rejects.toThrow('permission denied')

    vi.unstubAllGlobals()
  })
})
