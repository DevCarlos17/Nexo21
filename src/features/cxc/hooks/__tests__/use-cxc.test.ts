// Mockeamos `@/core/db/powersync/db` porque `registrarSafExcedente`,
// `aplicarSaldoFavor` y `registrarPagoFactura` usan `db.writeTransaction` a
// nivel de modulo — sin este mock, importar `use-cxc.ts` construye una
// PowerSyncDatabase real y revienta con "Worker is not defined" en el
// entorno de test. Mismo patron que use-ventas.test.ts / use-ajustes.test.ts.
vi.mock('@/core/db/powersync/db', () => ({
  db: {
    writeTransaction: vi.fn(),
  },
}))

// `use-cxc.ts` importa `cargarMapaCuentas` (que a su vez importa `kysely`,
// backed por PowerSync real) y `generarAsientosPagoCxC`/`leerMonedaContable` —
// mockeados para que el import del modulo no construya un Kysely/PowerSync
// real en el entorno de test. Mismo patron que use-ventas.test.ts para
// generarAsientosVenta/leerMonedaContable.
vi.mock('@/features/contabilidad/hooks/use-cuentas-config', () => ({
  cargarMapaCuentas: vi.fn(async () => ({})),
}))
vi.mock('@/features/contabilidad/lib/generar-asientos', () => ({
  generarAsientosPagoCxC: vi.fn(async () => undefined),
  reversarAsientos: vi.fn(async () => undefined),
  leerMonedaContable: vi.fn(async () => 'USD'),
}))

// `useDetalleFactura` usa `useQuery` de `@powersync/react` — mismo patron que
// use-facturas-sesion-activa.test.ts / use-deuda-cliente.test.ts. Ninguna de
// las funciones ya testeadas en este archivo (registrarSafExcedente,
// aplicarSaldoFavor, registrarPagoFactura) llama useQuery, asi que mockear el
// modulo completo aqui es seguro para el resto de la suite.
vi.mock('@powersync/react', () => ({ useQuery: vi.fn() }))

import type { Transaction } from '@powersync/common'
import { renderHook } from '@testing-library/react'
import { useQuery } from '@powersync/react'
import { db } from '@/core/db/powersync/db'
import { toStorageString } from '@/lib/currency'
import {
  registrarSafExcedente,
  aplicarSaldoFavor,
  registrarPagoFactura,
  useDetalleFactura,
  useAfectacionCxc,
  type RegistrarSafExcedenteParams,
  type AplicarSaldoFavorParams,
  type PagoFacturaParams,
} from '../use-cxc'

const mockedDb = vi.mocked(db, true)
const mockedUseQuery = vi.mocked(useQuery)

interface Call {
  sql: string
  params: unknown[]
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────
// registrarSafExcedente — CREACION de credito (tipo 'SAFC', WARNING 2)
// ─────────────────────────────────────────────────────────────────────────

describe('registrarSafExcedente — creacion de credito standing (tipo SAFC, no SAF/PAG)', () => {
  function mockTx(opts: { saldoActual: string }) {
    const calls: Call[] = []
    mockedDb.writeTransaction.mockImplementation(async (callback) => {
      const tx = {
        execute: vi.fn(async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params })
          if (sql.startsWith('SELECT saldo_actual FROM clientes WHERE id = ?')) {
            return { rows: { length: 1, item: () => ({ saldo_actual: opts.saldoActual }) } }
          }
          return { rows: { length: 0, item: () => undefined } }
        }),
      } as unknown as Transaction
      return callback(tx)
    })
    return calls
  }

  function baseParams(overrides: Partial<RegistrarSafExcedenteParams> = {}): RegistrarSafExcedenteParams {
    return {
      cliente_id: 'cliente-1',
      venta_id: 'venta-1',
      nro_factura: 'F-001',
      excedenteUsd: 25,
      tasa: 40,
      empresa_id: 'emp-1',
      procesado_por: 'user-1',
      ...overrides,
    }
  }

  it('escribe UN SOLO movimiento_cuenta con tipo=SAFC (nunca SAF/PAG), con saldo_anterior/saldo_nuevo provistos', async () => {
    const calls = mockTx({ saldoActual: '0.00000000' })

    await registrarSafExcedente(baseParams({ excedenteUsd: 25 }))

    const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO movimientos_cuenta'))
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.sql).toContain("'SAFC'")

    // Columnas: id, cliente_id, [tipo literal 'SAFC'], referencia, monto,
    // saldo_anterior, saldo_nuevo, observacion, venta_id, fecha, empresa_id,
    // created_at, created_by, moneda_pago, monto_moneda, tasa_pago, saf_origen_refs
    const params = inserts[0]!.params
    expect(params[3]).toBe(toStorageString(25)) // monto = excedente
    expect(params[4]).toBe(toStorageString(0)) // saldo_anterior
    expect(params[5]).toBe(toStorageString(-25)) // saldo_nuevo = anterior - excedente (crea credito)
    expect(params[4]).not.toBeNull()
    expect(params[5]).not.toBeNull()
  })

  it('NO reduce saldo_pend_usd de ninguna factura — la creacion de credito es independiente de las facturas pendientes', async () => {
    const calls = mockTx({ saldoActual: '10.00000000' })

    await registrarSafExcedente(baseParams({ excedenteUsd: 15 }))

    const ventaUpdates = calls.filter((c) => c.sql.startsWith('UPDATE ventas'))
    expect(ventaUpdates).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// aplicarSaldoFavor — gate re-sourced a SUM(SAFC)-SUM(SAF), NO saldo_actual
// neteado (WARNING 2)
// ─────────────────────────────────────────────────────────────────────────

describe('aplicarSaldoFavor — gate de credito re-sourced (SUM(SAFC)-SUM(SAF)), no clientes.saldo_actual', () => {
  function mockTx(opts: {
    saldoActual: string
    creado: number
    consumido: number
    facturaSaldoPend: Record<string, string>
  }) {
    const calls: Call[] = []
    mockedDb.writeTransaction.mockImplementation(async (callback) => {
      const tx = {
        execute: vi.fn(async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params })
          if (sql.startsWith('SELECT saldo_actual FROM clientes WHERE id = ? AND empresa_id = ?')) {
            return { rows: { length: 1, item: () => ({ saldo_actual: opts.saldoActual }) } }
          }
          if (sql.includes('as creado') && sql.includes('as consumido')) {
            return { rows: { length: 1, item: () => ({ creado: opts.creado, consumido: opts.consumido }) } }
          }
          if (sql.startsWith('SELECT saldo_pend_usd FROM ventas WHERE id = ? AND empresa_id = ?')) {
            const ventaId = params[0] as string
            const saldo = opts.facturaSaldoPend[ventaId]
            return saldo !== undefined
              ? { rows: { length: 1, item: () => ({ saldo_pend_usd: saldo }) } }
              : { rows: { length: 0, item: () => undefined } }
          }
          return { rows: { length: 0, item: () => undefined } }
        }),
      } as unknown as Transaction
      return callback(tx)
    })
    return calls
  }

  function baseParams(overrides: Partial<AplicarSaldoFavorParams> = {}): AplicarSaldoFavorParams {
    return {
      clienteId: 'cliente-1',
      empresaId: 'emp-1',
      cajeroId: 'user-1',
      tasa: 40,
      facturas: [{ ventaId: 'venta-1', nroFactura: 'F-001', montoAplicarUsd: 50 }],
      totalAplicadoUsd: 50,
      ...overrides,
    }
  }

  it('el gate usa SUM(SAFC)-SUM(SAF), NO clientes.saldo_actual: procede aunque saldo_actual sea 0 (netaria "sin credito") mientras SAFC-SAF sea suficiente', async () => {
    const calls = mockTx({
      saldoActual: '0.00000000', // netted: parece "sin deuda ni credito"
      creado: 100, // SAFC
      consumido: 0, // SAF
      facturaSaldoPend: { 'venta-1': '50.00000000' },
    })

    await expect(aplicarSaldoFavor(baseParams({ totalAplicadoUsd: 50 }))).resolves.not.toThrow()

    const safInsert = calls.find((c) => c.sql.startsWith('INSERT INTO movimientos_cuenta') && c.sql.includes("'SAF'"))
    expect(safInsert).toBeDefined()
    expect(safInsert!.sql).not.toContain("'SAFC'")

    const ventaUpdate = calls.find((c) => c.sql.startsWith('UPDATE ventas SET saldo_pend_usd'))
    expect(ventaUpdate).toBeDefined()
    expect(ventaUpdate!.params).toEqual([toStorageString(0), 'venta-1']) // 50 - 50 = 0
  })

  it('regresion: rechaza cuando el monto excede SUM(SAFC)-SUM(SAF), AUNQUE clientes.saldo_actual sugiera mucho mas credito disponible (no se debe volver a leer saldo_actual como gate)', async () => {
    mockTx({
      saldoActual: '-500.00000000', // netted MUY negativo: un gate viejo basado en esto dejaria pasar cualquier monto
      creado: 10, // SAFC real
      consumido: 0, // SAF real -> disponible real = 10
      facturaSaldoPend: { 'venta-1': '50.00000000' },
    })

    await expect(
      aplicarSaldoFavor(baseParams({ totalAplicadoUsd: 50 }))
    ).rejects.toThrow(/excede el crédito disponible/i)
  })

  it('rechaza cuando no hay credito disponible (SAFC-SAF <= 0), sin importar cuantas facturas se seleccionen', async () => {
    mockTx({
      saldoActual: '0.00000000',
      creado: 0,
      consumido: 0,
      facturaSaldoPend: { 'venta-1': '50.00000000' },
    })

    await expect(
      aplicarSaldoFavor(baseParams({ totalAplicadoUsd: 10 }))
    ).rejects.toThrow(/no tiene saldo a favor disponible/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// registrarPagoFactura (rama SAF inline) — mismo re-source que
// aplicarSaldoFavor pero como gate embebido dentro del pago de una factura
// especifica (WARNING 2)
// ─────────────────────────────────────────────────────────────────────────

describe('registrarPagoFactura — rama SAF inline: gate re-sourced a SUM(SAFC)-SUM(SAF)', () => {
  function mockTx(opts: {
    saldoActual: string
    creado: number
    consumido: number
    facturaSaldoPend: string
    nroFactura?: string
  }) {
    const calls: Call[] = []
    mockedDb.writeTransaction.mockImplementation(async (callback) => {
      const tx = {
        execute: vi.fn(async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params })
          if (sql.startsWith('SELECT saldo_actual FROM clientes WHERE id = ? LIMIT 1')) {
            return { rows: { length: 1, item: () => ({ saldo_actual: opts.saldoActual }) } }
          }
          if (sql.includes('as creado') && sql.includes('as consumido')) {
            return { rows: { length: 1, item: () => ({ creado: opts.creado, consumido: opts.consumido }) } }
          }
          if (sql.startsWith('SELECT nro_factura, saldo_pend_usd FROM ventas WHERE id = ?')) {
            return {
              rows: {
                length: 1,
                item: () => ({ nro_factura: opts.nroFactura ?? 'F-001', saldo_pend_usd: opts.facturaSaldoPend }),
              },
            }
          }
          return { rows: { length: 0, item: () => undefined } }
        }),
      } as unknown as Transaction
      return callback(tx)
    })
    return calls
  }

  function baseParams(overrides: Partial<PagoFacturaParams> = {}): PagoFacturaParams {
    return {
      venta_id: 'venta-1',
      cliente_id: 'cliente-1',
      metodo_cobro_id: 'metodo-1',
      moneda: 'USD',
      tasa: 40,
      monto: 0, // SAF cubre todo — no se llama aplicarPagoFacturaEnTx
      empresa_id: 'emp-1',
      procesado_por: 'user-1',
      procesado_por_nombre: 'Cajero Test',
      aplicarSaf: true,
      ...overrides,
    }
  }

  it('procede con SAF aunque clientes.saldo_actual sea 0 (netted), porque SUM(SAFC)-SUM(SAF) es suficiente; escribe tipo=SAF y reduce SOLO la factura seleccionada', async () => {
    const calls = mockTx({
      saldoActual: '0.00000000',
      creado: 80,
      consumido: 0,
      facturaSaldoPend: '50.00000000',
    })

    await registrarPagoFactura(baseParams({ montoSaf: 50 }))

    const safInsert = calls.find((c) => c.sql.startsWith('INSERT INTO movimientos_cuenta') && c.sql.includes("'SAF'"))
    expect(safInsert).toBeDefined()
    expect(safInsert!.sql).not.toContain("'SAFC'")

    const ventaUpdates = calls.filter((c) => c.sql.startsWith('UPDATE ventas SET saldo_pend_usd = ? WHERE id = ?'))
    expect(ventaUpdates).toHaveLength(1)
    expect(ventaUpdates[0]!.params).toEqual([toStorageString(0), 'venta-1']) // 50 - 50 = 0
  })

  it('regresion: rechaza el SAF cuando excede SUM(SAFC)-SUM(SAF) real, aunque clientes.saldo_actual (netted) sea muy negativo y sugiera credito de sobra', async () => {
    mockTx({
      saldoActual: '-500.00000000',
      creado: 10,
      consumido: 0,
      facturaSaldoPend: '50.00000000',
    })

    await expect(
      registrarPagoFactura(baseParams({ montoSaf: 50 }))
    ).rejects.toThrow(/excede el saldo disponible/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// useDetalleFactura — extension aditiva (Design §Decision 3): es_decimal +
// precio_unitario_bs, via JOIN a ventas (tasa historica) + unidades.
// ─────────────────────────────────────────────────────────────────────────

describe('useDetalleFactura — extension aditiva (Design §Decision 3)', () => {
  it('agrega JOIN a ventas (tasa) y LEFT JOIN a unidades (es_decimal) al SQL, sin remover columnas existentes', () => {
    mockedUseQuery.mockReturnValue({ data: [], isLoading: false } as never)

    renderHook(() => useDetalleFactura('venta-1'))

    const [sql, params] = mockedUseQuery.mock.calls[0]
    expect(sql).toContain('es_decimal')
    expect(sql).toContain('precio_unitario_bs')
    expect(sql).toContain('JOIN ventas v ON vd.venta_id = v.id')
    expect(sql).toContain('LEFT JOIN unidades u ON p.unidad_base_id = u.id')
    // Columnas preexistentes (contrato de los 3 consumidores verificados) intactas:
    expect(sql).toContain('vd.subtotal_usd')
    expect(sql).toContain('vd.tipo_impuesto')
    expect(sql).toContain('p.nombre as producto_nombre')
    expect(params).toEqual(['venta-1'])
  })

  it('precio_unitario_bs se calcula con la tasa HISTORICA de la venta (v.tasa), nunca una tasa vigente', () => {
    mockedUseQuery.mockReturnValue({
      data: [
        {
          id: 'vd-1',
          venta_id: 'venta-1',
          producto_id: 'prod-1',
          cantidad: '2',
          precio_unitario_usd: '10.00',
          subtotal_usd: '20.00',
          subtotal_bs: '1000.00',
          tipo_impuesto: 'Gravable',
          impuesto_pct: '16',
          producto_nombre: 'Producto Test',
          producto_codigo: 'P001',
          es_decimal: 0,
          precio_unitario_bs: '500.00',
        },
      ],
      isLoading: false,
    } as never)

    const { result } = renderHook(() => useDetalleFactura('venta-1'))

    expect(result.current.detalle[0]).toMatchObject({ es_decimal: 0, precio_unitario_bs: '500.00' })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// useAfectacionCxc — Design §Decision 6: fuente correcta de "afectacion CxC"
// para el panel de detalle (Slice 3a). COUNT(*) sobre movimientos_cuenta,
// NUNCA construirCierreRecibo/discrepancy (estado efimero de React).
// ─────────────────────────────────────────────────────────────────────────

describe('useAfectacionCxc (Design §Decision 6: COUNT movimientos_cuenta WHERE venta_id + empresa_id)', () => {
  it('sin ventaId: no ejecuta la query (sql vacio) y retorna 0', () => {
    mockedUseQuery.mockReturnValue({ data: [], isLoading: false } as never)

    const { result } = renderHook(() => useAfectacionCxc(null, 'emp-1'))

    expect(result.current.cantidadMovimientos).toBe(0)
    expect(mockedUseQuery).toHaveBeenCalledWith('', [])
  })

  it('con ventaId: ejecuta COUNT escopeado a venta_id + empresa_id y retorna el conteo', () => {
    mockedUseQuery.mockReturnValue({ data: [{ n: 2 }], isLoading: false } as never)

    const { result } = renderHook(() => useAfectacionCxc('venta-1', 'emp-1'))

    const [sql, params] = mockedUseQuery.mock.calls[0]
    expect(sql).toContain('COUNT(*)')
    expect(sql).toContain('FROM movimientos_cuenta')
    expect(sql).toContain('WHERE venta_id = ? AND empresa_id = ?')
    expect(params).toEqual(['venta-1', 'emp-1'])
    expect(result.current.cantidadMovimientos).toBe(2)
  })

  it('0 movimientos: retorna cantidadMovimientos=0 (huboAfectacionCxc(0) sera false en el llamador)', () => {
    mockedUseQuery.mockReturnValue({ data: [{ n: 0 }], isLoading: false } as never)

    const { result } = renderHook(() => useAfectacionCxc('venta-2', 'emp-1'))

    expect(result.current.cantidadMovimientos).toBe(0)
  })
})
