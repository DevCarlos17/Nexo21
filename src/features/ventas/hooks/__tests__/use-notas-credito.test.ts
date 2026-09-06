// Mockeamos `@/core/db/powersync/db` porque `crearNotaCredito` usa
// `db.writeTransaction` a nivel de modulo — sin este mock, importar el
// archivo construye una PowerSyncDatabase real y revienta con "Worker is
// not defined" en el entorno de test. Mismo patron que use-ventas.test.ts.
vi.mock('@/core/db/powersync/db', () => ({
  db: {
    execute: vi.fn(),
    writeTransaction: vi.fn(),
  },
}))
// F1 QA fix: `useReversosFactura` (nuevo hook, historial de NC por factura)
// usa `useQuery` de `@powersync/react` — mismo patron aislado que
// `use-facturas-sesion-activa.test.ts`. El resto de tests de este archivo
// (crearNotaCredito, via writeTransaction) no se ven afectados: nunca llaman
// a un hook basado en `useQuery`.
vi.mock('@powersync/react', () => ({ useQuery: vi.fn() }))
vi.mock('@/core/db/powersync/connector', () => ({ connector: {} }))
// Slice B (notas-credito-ruta-administrativa): `useNotasCredito(filtros?)`
// resuelve `empresaId` via `useCurrentUser()` — mismo patron de mock aislado
// que `use-facturas-sesion-activa.test.ts`.
vi.mock('@/core/hooks/use-current-user', () => ({ useCurrentUser: vi.fn() }))

vi.mock('@/features/contabilidad/hooks/use-cuentas-config', () => ({
  cargarMapaCuentas: vi.fn(async () => ({})),
}))
vi.mock('@/features/contabilidad/lib/generar-asientos', () => ({
  generarAsientosNCR: vi.fn(async () => undefined),
}))
vi.mock('@/features/cxc/hooks/use-cxc', () => ({
  reversarDiferencialEnTx: vi.fn(async () => undefined),
  useDetalleFactura: vi.fn(),
}))
// Slice 3, task 3.1: espia usado para PROBAR que `crearNotaCredito` NUNCA
// compone internamente una segunda venta (COMPENSACION_VENTA deja el SAFC
// y el llamador — Slice 5 UI — hace un `crearVenta()` SEPARADO). El modulo
// no esta importado hoy por `use-notas-credito.ts`; este mock es una red de
// seguridad para que una futura importacion accidental rompa el test.
const crearVentaSpy = vi.fn()
vi.mock('@/features/ventas/hooks/use-ventas', () => ({
  crearVenta: crearVentaSpy,
}))

import type { Transaction } from '@powersync/common'
import { renderHook } from '@testing-library/react'
import { useQuery } from '@powersync/react'
import { db } from '@/core/db/powersync/db'
import { useCurrentUser } from '@/core/hooks/use-current-user'
import {
  crearNotaCredito,
  assertGateAntiFraudeNoDesembolso,
  validarOrigenDinero,
  useReversosFactura,
  useNotasCredito,
  type CrearNotaCreditoParams,
  type OrigenDinero,
} from '../use-notas-credito'

const mockedDb = vi.mocked(db, true)
const mockedUseQuery = vi.mocked(useQuery)
const mockedUseCurrentUser = vi.mocked(useCurrentUser)

interface Call {
  sql: string
  params: unknown[]
}

interface NcrTxFixtures {
  venta: {
    id: string
    cliente_id: string
    nro_factura: string
    tasa: string
    total_usd: string
    total_bs: string
    saldo_pend_usd: string
    tipo: string
    status: string
    deposito_id: string
    /** Slice 2: sesion de caja en la que se emitio la venta original. */
    sesion_caja_id?: string | null
  }
  /**
   * Slice 4b: `id`/`precio_unitario_usd`/`tipo_impuesto`/`impuesto_pct` son
   * opcionales — el mock les aplica defaults sensatos (`Exento`, `'0'`,
   * precio '10.00') para no obligar a los fixtures pre-4b a especificarlos.
   */
  ventaDet: Array<{
    id?: string
    producto_id: string
    cantidad: string
    lote_id: string | null
    precio_unitario_usd?: string
    tipo_impuesto?: string
    impuesto_pct?: string
  }>
  productos: Record<string, { tipo: string; stock: string; nombre: string }>
  /** key `${producto_id}::${deposito_id}` -> cantidad_actual previa en inventario_stock. */
  inventarioStock?: Record<string, string>
  recetas?: Record<string, Array<{ producto_id: string; cantidad: string; stock: string; nombre: string }>>
  /**
   * Slice B (change `guarda-deposito-inactivo`): is_active de
   * `venta.deposito_id` (el deposito de ORIGEN). Default `true` — preserva el
   * comportamiento de los tests pre-existentes (reingreso siempre al origen,
   * nunca consulta el principal).
   */
  depositoOrigenIsActive?: boolean
  /** Id del deposito principal activo de la empresa — solo se consulta/usa cuando `depositoOrigenIsActive` es `false` (fallback NCR). */
  principalDepositoId?: string
  /** Slice 2: pagos NO reversados de la venta (fuente del egreso condicional + reversa). */
  pagos?: Array<{ id: string; metodo_cobro_id: string; monto: string; moneda_id: string }>
  /** Slice 3: saldo_actual del cliente ANTES de liquidar el remanente (Step B). */
  clienteSaldoActual?: string
  /** Slice 4b: SUM(cantidad) ya acreditado por venta_det_id — alimenta el guard de doble-credito (`buildSumCantidadYaAcreditadaQuery`). */
  yaAcreditadoPorLinea?: Record<string, string>
  /** Slice 5a-2a: si `false`, la validacion del override de deposito falla (inactivo/otra empresa). Default `true` (valido) cuando no se especifica. */
  overrideDepositoValido?: boolean
  /**
   * Slice 3a: estado de las sesiones de caja consultadas por el guard de
   * sesion cerrada del two-pass write core (Design §Decision 4/5 "Guard"),
   * keyed por session id. Una sesion ausente de este mapa simula "no
   * encontrada / no pertenece a la empresa".
   */
  sesionesCaja?: Record<string, { status: string }>
  /**
   * Slice 3a: `saldo_actual` + moneda (`codigo_iso`) de las cuentas
   * reales resueltas por el two-pass write core (Pass 1) — cubre las 3
   * tablas (`metodos_cobro`, `caja_fuerte`, `bancos_empresa`), keyed por
   * `cuentaId`. Una cuenta ausente de este mapa simula "no existe / no
   * pertenece a la empresa" (rechazo de Pass 1).
   */
  cuentas?: Record<string, { saldo_actual: string; moneda_codigo: string }>
}

/**
 * Simula la unica `db.writeTransaction` de `crearNotaCredito` — captura cada
 * `tx.execute(sql, params)` para las aserciones. Mismo patron que
 * `mockCrearVentaTx` en `use-ventas.test.ts`.
 */
function mockCrearNcrTx(opts: NcrTxFixtures) {
  const calls: Call[] = []
  mockedDb.writeTransaction.mockImplementation(async (callback) => {
    const tx = {
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params })

        if (sql.startsWith('SELECT * FROM ventas WHERE id')) {
          return { rows: { length: 1, item: () => opts.venta } }
        }
        if (sql.startsWith('SELECT is_active FROM depositos WHERE id')) {
          return {
            rows: { length: 1, item: () => ({ is_active: (opts.depositoOrigenIsActive ?? true) ? 1 : 0 }) },
          }
        }
        if (sql.startsWith('SELECT id FROM depositos WHERE empresa_id = ? AND es_principal = 1')) {
          return opts.principalDepositoId
            ? { rows: { length: 1, item: () => ({ id: opts.principalDepositoId }) } }
            : { rows: { length: 0, item: () => undefined } }
        }
        // Slice 5a-2a: validacion del override explicito de deposito
        // (`depositoReingresoId`, obs #2840) — activo + de la misma empresa.
        if (sql.startsWith('SELECT id FROM depositos WHERE id = ? AND empresa_id = ? AND is_active = 1')) {
          return opts.overrideDepositoValido === false
            ? { rows: { length: 0, item: () => undefined } }
            : { rows: { length: 1, item: () => ({ id: params[0] }) } }
        }
        if (sql.startsWith('SELECT COUNT(*) as cnt FROM notas_credito')) {
          return { rows: { length: 1, item: () => ({ cnt: 0 }) } }
        }
        if (sql.startsWith('INSERT INTO notas_credito')) {
          return { rows: { length: 0, item: () => undefined } }
        }
        if (sql.startsWith('SELECT id, producto_id, cantidad, lote_id, precio_unitario_usd, tipo_impuesto, impuesto_pct FROM ventas_det')) {
          const rows = opts.ventaDet.map((v, i) => ({
            id: v.id ?? `vdet-fixture-${i}`,
            producto_id: v.producto_id,
            cantidad: v.cantidad,
            lote_id: v.lote_id,
            precio_unitario_usd: v.precio_unitario_usd ?? '10.00',
            tipo_impuesto: v.tipo_impuesto ?? 'Exento',
            impuesto_pct: v.impuesto_pct ?? '0',
          }))
          return { rows: { length: rows.length, item: (i: number) => rows[i] } }
        }
        // Slice 4b: guard de doble-credito — SUM(cantidad) ya acreditado
        // por venta_det_id (`buildSumCantidadYaAcreditadaQuery`).
        if (sql.startsWith('SELECT COALESCE(SUM(cantidad), 0) as total FROM notas_credito_det')) {
          const ventaDetId = params[0] as string
          const total = opts.yaAcreditadoPorLinea?.[ventaDetId] ?? '0'
          return { rows: { length: 1, item: () => ({ total }) } }
        }
        if (sql.startsWith('INSERT INTO notas_credito_det')) {
          return { rows: { length: 0, item: () => undefined } }
        }
        if (sql.startsWith('SELECT tipo, stock, nombre FROM productos')) {
          const productoId = params[0] as string
          const p = opts.productos[productoId]
          return p ? { rows: { length: 1, item: () => p } } : { rows: { length: 0, item: () => undefined } }
        }
        if (sql.startsWith('SELECT id, cantidad_actual FROM inventario_stock')) {
          const productoId = params[1] as string
          const depositoId = params[2] as string
          const cant = opts.inventarioStock?.[`${productoId}::${depositoId}`]
          return cant !== undefined
            ? {
                rows: {
                  length: 1,
                  item: () => ({ id: `stock-row-${productoId}-${depositoId}`, cantidad_actual: cant }),
                },
              }
            : { rows: { length: 0, item: () => undefined } }
        }
        // INSERT guardado (WHERE NOT EXISTS + RETURNING id) — simula insercion exitosa,
        // sin carrera (no hay otra escritura concurrente en estos tests).
        if (sql.startsWith('INSERT INTO inventario_stock')) {
          return { rows: { length: 1, item: () => ({ id: 'stock-insert-fake-id' }) } }
        }
        if (sql.startsWith('SELECT producto_id, deposito_id, tipo, cantidad FROM movimientos_inventario')) {
          return { rows: { length: 0, item: () => undefined } }
        }
        if (sql.startsWith('SELECT stock FROM productos')) {
          const productoId = params[0] as string
          const p = opts.productos[productoId]
          return { rows: { length: 1, item: () => ({ stock: p?.stock ?? '0.000' }) } }
        }
        if (sql.startsWith('SELECT r.producto_id, r.cantidad, p.stock, p.nombre FROM recetas')) {
          const servicioId = params[0] as string
          const ingredientes = opts.recetas?.[servicioId] ?? []
          return { rows: { length: ingredientes.length, item: (i: number) => ingredientes[i] } }
        }
        if (sql.startsWith('UPDATE ventas SET status')) {
          return { rows: { length: 0, item: () => undefined } }
        }
        if (sql.startsWith('SELECT id, metodo_cobro_id, monto FROM pagos')) {
          const pagos = opts.pagos ?? []
          return { rows: { length: pagos.length, item: (i: number) => pagos[i] } }
        }
        if (sql.startsWith('UPDATE pagos SET is_reversed')) {
          return { rows: { length: 0, item: () => undefined } }
        }
        // Slice 3a: guard de sesion cerrada (Design §Decision 4/5), evaluado
        // UNA vez para toda la NC — resuelto ANTES del loop de Pass 1.
        if (sql.startsWith('SELECT status FROM sesiones_caja WHERE id = ? AND empresa_id = ?')) {
          const sesionId = params[0] as string
          const row = opts.sesionesCaja?.[sesionId]
          return row ? { rows: { length: 1, item: () => row } } : { rows: { length: 0, item: () => undefined } }
        }
        // Slice 3a: Pass 1 — resolucion de cuenta real (metodos_cobro |
        // caja_fuerte | bancos_empresa) + su moneda fija, por tipo.
        if (
          sql.includes('FROM metodos_cobro t JOIN monedas') ||
          sql.includes('FROM caja_fuerte t JOIN monedas') ||
          sql.includes('FROM bancos_empresa t JOIN monedas')
        ) {
          const cuentaId = params[0] as string
          const row = opts.cuentas?.[cuentaId]
          return row ? { rows: { length: 1, item: () => row } } : { rows: { length: 0, item: () => undefined } }
        }
        if (sql.startsWith('INSERT INTO movimientos_metodo_cobro')) {
          return { rows: { length: 0, item: () => undefined } }
        }
        // Slice 3a: Pass 2 — egresos de tesoreria/banco + actualizacion de
        // saldo_actual real en las 3 tablas de cuenta.
        if (sql.startsWith('INSERT INTO mov_caja_fuerte') || sql.startsWith('INSERT INTO movimientos_bancarios')) {
          return { rows: { length: 0, item: () => undefined } }
        }
        if (
          sql.startsWith('UPDATE metodos_cobro SET saldo_actual') ||
          sql.startsWith('UPDATE caja_fuerte SET saldo_actual') ||
          sql.startsWith('UPDATE bancos_empresa SET saldo_actual')
        ) {
          return { rows: { length: 0, item: () => undefined } }
        }
        if (sql.startsWith('SELECT saldo_actual FROM clientes WHERE id = ?')) {
          return { rows: { length: 1, item: () => ({ saldo_actual: opts.clienteSaldoActual ?? '0.00' }) } }
        }
        if (sql.startsWith('INSERT INTO movimientos_cuenta')) {
          return { rows: { length: 0, item: () => undefined } }
        }
        if (sql.startsWith('UPDATE clientes SET saldo_actual')) {
          return { rows: { length: 0, item: () => undefined } }
        }

        return { rows: { length: 0, item: () => undefined } }
      }),
    } as unknown as Transaction

    return callback(tx)
  })
  return calls
}

function baseParams(overrides: Partial<CrearNotaCreditoParams> = {}): CrearNotaCreditoParams {
  return {
    venta_id: 'venta-1',
    motivo: 'Devolucion cliente',
    usuario_id: 'user-1',
    empresa_id: 'emp-1',
    entryPoint: 'TRADICIONAL',
    // Slice 2 (decouple, Design §origenDinero validation): el default YA NO
    // puede ser EFECTIVO_REAL — esa modalidad ahora EXIGE `origenDinero`
    // (`validarOrigenDinero` rechaza si falta), y la enorme mayoria de los
    // tests de este archivo (reingreso de stock, deposito override, etc.)
    // no les importa la modalidad de liquidacion en absoluto. AJUSTE_CXC es
    // no-desembolso (no exige `origenDinero`) y preserva byte-a-byte el
    // comportamiento de esos tests no relacionados con dinero. Los tests que
    // SI ejercitan EFECTIVO_REAL (describe "Slice 2") lo sobreescriben
    // explicitamente junto con `origenDinero`.
    modalidad: 'AJUSTE_CXC',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('crearNotaCredito — Slice 4 (reingreso de stock al deposito de ORIGEN de la venta)', () => {
  it('devuelve el stock al deposito de la venta (venta.deposito_id), NO al deposito principal de la empresa', async () => {
    const calls = mockCrearNcrTx({
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '40',
        total_usd: '30.00',
        total_bs: '1200.00',
        saldo_pend_usd: '0.00',
        tipo: 'CONTADO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
      },
      ventaDet: [{ producto_id: 'prod-1', cantidad: '3.000', lote_id: null }],
      productos: { 'prod-1': { tipo: 'P', stock: '20.000', nombre: 'Producto 1' } },
      inventarioStock: { 'prod-1::dep-B': '10.000' },
    })

    await crearNotaCredito(baseParams())

    const kardexInsert = calls.find((c) => c.sql.startsWith('INSERT INTO movimientos_inventario'))
    expect(kardexInsert).toBeDefined()
    expect(kardexInsert!.params).toContain('dep-B')

    const stockUpsertRead = calls.find((c) => c.sql.startsWith('SELECT id, cantidad_actual FROM inventario_stock'))
    expect(stockUpsertRead).toBeDefined()
    expect(stockUpsertRead!.params).toContain('dep-B')

    // Nunca debe consultar el deposito principal — la fuente es venta.deposito_id.
    const principalLookup = calls.find((c) => c.sql.includes('es_principal'))
    expect(principalLookup).toBeUndefined()
  })

  it('inventario_stock del deposito de origen se incrementa (delta POSITIVO) en la cantidad devuelta', async () => {
    const calls = mockCrearNcrTx({
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '40',
        total_usd: '30.00',
        total_bs: '1200.00',
        saldo_pend_usd: '0.00',
        tipo: 'CONTADO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
      },
      ventaDet: [{ producto_id: 'prod-1', cantidad: '3.000', lote_id: null }],
      productos: { 'prod-1': { tipo: 'P', stock: '20.000', nombre: 'Producto 1' } },
      inventarioStock: { 'prod-1::dep-B': '10.000' },
    })

    await crearNotaCredito(baseParams())

    const stockWrite = calls.find(
      (c) => c.sql.startsWith('INSERT INTO inventario_stock') || c.sql.startsWith('UPDATE inventario_stock')
    )
    expect(stockWrite).toBeDefined()
    expect(stockWrite!.params).toContain('13.000') // 10 (previo en dep-B) + 3 devueltos
  })

  it('productos.stock (total cross-deposito) se incrementa EXACTAMENTE UNA VEZ — sin doble-incremento entre el manual anterior y upsertStockDeposito', async () => {
    const calls = mockCrearNcrTx({
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '40',
        total_usd: '30.00',
        total_bs: '1200.00',
        saldo_pend_usd: '0.00',
        tipo: 'CONTADO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
      },
      ventaDet: [{ producto_id: 'prod-1', cantidad: '3.000', lote_id: null }],
      productos: { 'prod-1': { tipo: 'P', stock: '20.000', nombre: 'Producto 1' } },
      inventarioStock: { 'prod-1::dep-B': '10.000' },
    })

    await crearNotaCredito(baseParams())

    const productoStockUpdates = calls.filter((c) => c.sql.startsWith('UPDATE productos SET stock ='))
    expect(productoStockUpdates).toHaveLength(1)
    expect(productoStockUpdates[0]!.params).toContain('23.000') // 20 (global previo) + 3
  })

  it('el movimiento de kardex insertado (E, NCR) trae el movimientoInventarioId correcto a upsertStockDeposito (sin fila previa en inventario_stock, baseline reconstruido excluyendo ese mismo movimiento)', async () => {
    const calls = mockCrearNcrTx({
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '40',
        total_usd: '30.00',
        total_bs: '1200.00',
        saldo_pend_usd: '0.00',
        tipo: 'CONTADO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
      },
      ventaDet: [{ producto_id: 'prod-1', cantidad: '3.000', lote_id: null }],
      productos: { 'prod-1': { tipo: 'P', stock: '20.000', nombre: 'Producto 1' } },
      // Sin fila previa en inventario_stock para prod-1::dep-B — fuerza el
      // camino de reconstruccion de baseline desde kardex dentro de
      // upsertStockDeposito, que EXCLUYE el movimiento recien insertado por
      // su `id` (movimientoInventarioId).
    })

    await crearNotaCredito(baseParams())

    const kardexInsert = calls.find((c) => c.sql.startsWith('INSERT INTO movimientos_inventario'))
    expect(kardexInsert).toBeDefined()
    const movId = kardexInsert!.params[0] as string
    expect(movId).toBeTruthy()

    const baselineRebuild = calls.find((c) =>
      c.sql.startsWith('SELECT producto_id, deposito_id, tipo, cantidad FROM movimientos_inventario')
    )
    expect(baselineRebuild).toBeDefined()
    // El baseline excluye explicitamente el movimiento recien insertado (ultimo param `id != ?`).
    expect(baselineRebuild!.params[baselineRebuild!.params.length - 1]).toBe(movId)

    // Insercion resultante en inventario_stock (sin fila previa -> INSERT), con delta +3 sobre baseline 0.
    const stockInsert = calls.find((c) => c.sql.startsWith('INSERT INTO inventario_stock'))
    expect(stockInsert).toBeDefined()
    expect(stockInsert!.params).toContain('3.000')
  })

  it('servicio con receta: reintegra el ingrediente al deposito de la venta (venta.deposito_id), no al principal', async () => {
    const calls = mockCrearNcrTx({
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '40',
        total_usd: '30.00',
        total_bs: '1200.00',
        saldo_pend_usd: '0.00',
        tipo: 'CONTADO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
      },
      ventaDet: [{ producto_id: 'servicio-1', cantidad: '2.000', lote_id: null }],
      productos: {
        'servicio-1': { tipo: 'S', stock: '0.000', nombre: 'Servicio 1' },
        'ing-1': { tipo: 'P', stock: '50.000', nombre: 'Ingrediente 1' },
      },
      recetas: {
        'servicio-1': [{ producto_id: 'ing-1', cantidad: '1.000', stock: '50.000', nombre: 'Ingrediente 1' }],
      },
      inventarioStock: { 'ing-1::dep-B': '5.000' },
    })

    await crearNotaCredito(baseParams())

    const kardexInsert = calls.find(
      (c) => c.sql.startsWith('INSERT INTO movimientos_inventario') && c.params.includes('ing-1')
    )
    expect(kardexInsert).toBeDefined()
    expect(kardexInsert!.params).toContain('dep-B')

    const stockUpsertRead = calls.find(
      (c) => c.sql.startsWith('SELECT id, cantidad_actual FROM inventario_stock') && c.params.includes('ing-1')
    )
    expect(stockUpsertRead).toBeDefined()
    expect(stockUpsertRead!.params).toContain('dep-B')
  })
})

describe('crearNotaCredito — Slice B (change guarda-deposito-inactivo): fallback automatico al principal cuando el deposito de origen esta inactivo', () => {
  it('Scenario: Fallback automatico al principal — venta.deposito_id (dep-B) esta inactivo: reintegra al deposito PRINCIPAL actual, no al origen, sin preguntar al cajero', async () => {
    const calls = mockCrearNcrTx({
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '40',
        total_usd: '30.00',
        total_bs: '1200.00',
        saldo_pend_usd: '0.00',
        tipo: 'CONTADO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
      },
      ventaDet: [{ producto_id: 'prod-1', cantidad: '3.000', lote_id: null }],
      productos: { 'prod-1': { tipo: 'P', stock: '20.000', nombre: 'Producto 1' } },
      inventarioStock: { 'prod-1::dep-principal-actual': '10.000' },
      depositoOrigenIsActive: false,
      principalDepositoId: 'dep-principal-actual',
    })

    await crearNotaCredito(baseParams())

    const kardexInsert = calls.find((c) => c.sql.startsWith('INSERT INTO movimientos_inventario'))
    expect(kardexInsert).toBeDefined()
    expect(kardexInsert!.params).toContain('dep-principal-actual')
    expect(kardexInsert!.params).not.toContain('dep-B')
  })

  it('origen inactivo y sin deposito principal configurado (caso borde): rechaza en espanol, sin escribir ningun kardex', async () => {
    mockCrearNcrTx({
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '40',
        total_usd: '30.00',
        total_bs: '1200.00',
        saldo_pend_usd: '0.00',
        tipo: 'CONTADO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
      },
      ventaDet: [{ producto_id: 'prod-1', cantidad: '3.000', lote_id: null }],
      productos: { 'prod-1': { tipo: 'P', stock: '20.000', nombre: 'Producto 1' } },
      depositoOrigenIsActive: false,
      // Sin principalDepositoId: no hay deposito principal activo configurado.
    })

    await expect(crearNotaCredito(baseParams())).rejects.toThrow(/deposito/i)
  })
})

describe('validarOrigenDinero — funcion pura, contrato ARRAY multi-origen (Slice 2 REWORK, Design §Decision 5, obs #2948/#2949)', () => {
  function asignacion(overrides: Partial<OrigenDinero> = {}): OrigenDinero {
    return { tipo: 'SESION_EFECTIVO', cuentaId: 'metodo-efectivo-usd', monto: '30.00', ...overrides }
  }

  function validarBase(overrides: Partial<Parameters<typeof validarOrigenDinero>[0]> = {}) {
    return validarOrigenDinero({
      modalidad: 'EFECTIVO_REAL',
      entryPoint: 'POS',
      sesionCajaActivaId: 'sesion-activa-1',
      origenDinero: [asignacion()],
      ...overrides,
    })
  }

  // Rule 1 (design.md linea 60): modalidad de desembolso exige array NO vacio.
  it('modalidad de desembolso (EFECTIVO_REAL) + origenDinero vacio ([]): rechaza — el dinero real exige al menos una asignacion', () => {
    expect(() => validarBase({ origenDinero: [] })).toThrow(/al menos una asignacion|no vacio/i)
  })

  it('modalidad de desembolso (EFECTIVO_REAL) + origenDinero indefinido: rechaza', () => {
    expect(() => validarBase({ origenDinero: undefined })).toThrow(/al menos una asignacion|no vacio/i)
  })

  it('modalidad de desembolso (REFUND_TESORERIA) + array con CUALQUIER tipo de cuenta: NO rechaza — Rules 1/2 viejas (tipo restringido por modalidad) fueron DROPPED (design.md §Decision 5)', () => {
    expect(() =>
      validarBase({
        modalidad: 'REFUND_TESORERIA',
        origenDinero: [asignacion({ tipo: 'BANCO', cuentaId: 'banco-1' })],
      })
    ).not.toThrow()
  })

  it('modalidad de desembolso (EFECTIVO_REAL) + array con tipo TESORERIA_EFECTIVO/BANCO (sin SESION_EFECTIVO): NO rechaza — un NC puede mezclar tipos libremente ahora (owner canonical example)', () => {
    expect(() =>
      validarBase({ origenDinero: [asignacion({ tipo: 'BANCO', cuentaId: 'banco-1' })] })
    ).not.toThrow()
  })

  // Rule 2 (design.md linea 61): modalidad no-desembolso exige array vacio/undefined.
  it.each(['SALDO_FAVOR', 'COMPENSACION_VENTA', 'AJUSTE_CXC'] as const)(
    'modalidad no-desembolso %s + origenDinero NO vacio: rechaza (gate extension)',
    (modalidad) => {
      expect(() => validarBase({ modalidad, origenDinero: [asignacion()] })).toThrow(/no-desembolso|no admite/i)
    }
  )

  it('modalidad no-desembolso SIN origenDinero (undefined): no rechaza (flujo normal)', () => {
    expect(() => validarBase({ modalidad: 'AJUSTE_CXC', origenDinero: undefined })).not.toThrow()
  })

  it('modalidad no-desembolso con origenDinero=[] (array vacio explicito): no rechaza', () => {
    expect(() => validarBase({ modalidad: 'AJUSTE_CXC', origenDinero: [] })).not.toThrow()
  })

  // Rule 3 (design.md linea 62): cada asignacion exige monto > 0.
  it('asignacion con monto = "0": rechaza', () => {
    expect(() => validarBase({ origenDinero: [asignacion({ monto: '0' })] })).toThrow(/monto/i)
  })

  it('asignacion con monto negativo: rechaza', () => {
    expect(() => validarBase({ origenDinero: [asignacion({ monto: '-5.00' })] })).toThrow(/monto/i)
  })

  it('asignacion con monto > 0: no rechaza por esta regla', () => {
    expect(() => validarBase({ origenDinero: [asignacion({ monto: '0.01' })] })).not.toThrow()
  })

  // Rule 4 (design.md linea 63): no duplicar (tipo, cuentaId) — defensivo, evita doble-conteo de una cuenta.
  it('dos asignaciones con el MISMO (tipo, cuentaId): rechaza (duplicado)', () => {
    expect(() =>
      validarBase({
        origenDinero: [
          asignacion({ cuentaId: 'metodo-1' }),
          asignacion({ cuentaId: 'metodo-1' }),
        ],
      })
    ).toThrow(/duplicad/i)
  })

  it('dos asignaciones con el MISMO cuentaId pero DISTINTO tipo (tablas distintas): NO rechaza', () => {
    expect(() =>
      validarBase({
        origenDinero: [
          asignacion({ tipo: 'SESION_EFECTIVO', cuentaId: 'cuenta-x' }),
          asignacion({ tipo: 'BANCO', cuentaId: 'cuenta-x' }),
        ],
      })
    ).not.toThrow()
  })

  // Rule 5 (design.md linea 64): POS + SESION_EFECTIVO en el array ⇒ la sesion
  // resuelta es SIEMPRE sesionCajaActivaId (no hay eleccion por-asignacion,
  // Decision 5) — validado aqui como "sesionCajaActivaId debe estar definido"
  // (simetrico a la Rule 6 de TRADICIONAL). El array YA NO restringe tipos
  // por entryPoint (a diferencia de las Rules 1/2 viejas).
  it('POS + array contiene SESION_EFECTIVO + sesionCajaActivaId definido: NO rechaza', () => {
    expect(() => validarBase({ entryPoint: 'POS', sesionCajaActivaId: 'sesion-activa-1' })).not.toThrow()
  })

  it('POS + array contiene SESION_EFECTIVO + sesionCajaActivaId FALTANTE: rechaza (la sesion resuelta es siempre la propia, no elegible por asignacion)', () => {
    expect(() => validarBase({ entryPoint: 'POS', sesionCajaActivaId: undefined })).toThrow(
      /sesionCajaActivaId|propia|POS/i
    )
  })

  it('POS + array SOLO con TESORERIA_EFECTIVO/BANCO (sin SESION_EFECTIVO): sesionCajaActivaId NO requerido', () => {
    expect(() =>
      validarBase({
        entryPoint: 'POS',
        sesionCajaActivaId: undefined,
        modalidad: 'REFUND_TESORERIA',
        origenDinero: [asignacion({ tipo: 'BANCO', cuentaId: 'banco-1' })],
      })
    ).not.toThrow()
  })

  // Rule 6 (design.md linea 65): TRADICIONAL + SESION_EFECTIVO en el array ⇒
  // sesionDestinoId obligatorio (una sola sesion por NC, elegida por el usuario).
  it('TRADICIONAL + array contiene SESION_EFECTIVO + sesionDestinoId definido: NO rechaza', () => {
    expect(() =>
      validarBase({
        entryPoint: 'TRADICIONAL',
        sesionCajaActivaId: undefined,
        sesionDestinoId: 'sesion-destino-1',
      })
    ).not.toThrow()
  })

  it('TRADICIONAL + array contiene SESION_EFECTIVO + sesionDestinoId FALTANTE: rechaza (sesion unica por NC obligatoria)', () => {
    expect(() =>
      validarBase({ entryPoint: 'TRADICIONAL', sesionCajaActivaId: undefined, sesionDestinoId: undefined })
    ).toThrow(/sesionDestinoId/i)
  })

  it('TRADICIONAL + array SOLO con BANCO/TESORERIA_EFECTIVO (sin SESION_EFECTIVO): sesionDestinoId NO requerido', () => {
    expect(() =>
      validarBase({
        entryPoint: 'TRADICIONAL',
        modalidad: 'REFUND_TESORERIA',
        origenDinero: [asignacion({ tipo: 'TESORERIA_EFECTIVO', cuentaId: 'caja-fuerte-1' })],
      })
    ).not.toThrow()
  })
})

describe('crearNotaCredito — Slice 3a (two-pass write core sobre origenDinero[], Design §Decision 5 Pass 1/Pass 2)', () => {
  function fixturesConCuentas(
    overrides: Partial<NcrTxFixtures['venta']> = {},
    extra: Partial<NcrTxFixtures> = {}
  ) {
    return {
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '40',
        total_usd: '30.00',
        total_bs: '1200.00',
        saldo_pend_usd: '0.00',
        tipo: 'CONTADO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
        sesion_caja_id: 'sesion-activa-1',
        ...overrides,
      },
      ventaDet: [{ producto_id: 'prod-1', cantidad: '3.000', lote_id: null }],
      productos: { 'prod-1': { tipo: 'P', stock: '20.000', nombre: 'Producto 1' } },
      inventarioStock: { 'prod-1::dep-B': '10.000' },
      pagos: [],
      sesionesCaja: { 'sesion-activa-1': { status: 'ABIERTA' } },
      cuentas: {
        'metodo-efectivo-usd': { saldo_actual: '500.00000000', moneda_codigo: 'USD' },
      },
      ...extra,
    }
  }

  // NOTA (Slice 3a): reemplaza por completo el loop viejo de Slice 1/2
  // (paso 6c, iteraba `pagos` originales 1:1). El write core ahora itera
  // `origenDinero[]` — sin relacion con como pago el cliente (obs #2948,
  // axis 3 independiente de axis 2). `cuentaId` para SESION_EFECTIVO es un
  // `metodos_cobro.id` real (Decision 5), no una sesion.
  const origenSesionActiva: OrigenDinero = {
    tipo: 'SESION_EFECTIVO',
    cuentaId: 'metodo-efectivo-usd',
    monto: '30.00',
  }

  it('POS + origenDinero (1 asignacion SESION_EFECTIVO en USD): inserta EGRESO en movimientos_metodo_cobro (origen NCR) con sesion_caja_id=sesionCajaActivaId y actualiza metodos_cobro.saldo_actual (real balance tracking)', async () => {
    const calls = mockCrearNcrTx(fixturesConCuentas({ sesion_caja_id: 'sesion-activa-1' }))

    await crearNotaCredito(
      baseParams({
        entryPoint: 'POS',
        sesionCajaActivaId: 'sesion-activa-1',
        modalidad: 'EFECTIVO_REAL',
        origenDinero: [origenSesionActiva],
      })
    )

    // Nota: 'EGRESO' y 'NCR' van hardcodeados como literales en el SQL
    // (VALUES (?, ?, ?, 'EGRESO', 'NCR', ...)), no como parametros bindeados
    // — se detectan via c.sql.includes(), no c.params.includes().
    const egresoInsert = calls.find(
      (c) => c.sql.startsWith('INSERT INTO movimientos_metodo_cobro') && c.sql.includes("'NCR'")
    )
    expect(egresoInsert).toBeDefined()
    expect(egresoInsert!.sql).toContain('EGRESO')
    expect(egresoInsert!.params).toContain('metodo-efectivo-usd')
    expect(egresoInsert!.params).toContain('30.00000000') // toStorageString, 8dp
    expect(egresoInsert!.params).toContain('sesion-activa-1')

    const updateSaldo = calls.find((c) => c.sql.startsWith('UPDATE metodos_cobro SET saldo_actual'))
    expect(updateSaldo).toBeDefined()
    expect(updateSaldo!.params).toContain('470.00000000') // 500 - 30
    expect(updateSaldo!.params).toContain('metodo-efectivo-usd')
  })

  it('DROP same-session-as-sale: POS + venta.sesion_caja_id de OTRA sesion (factura emitida en otra sesion) — SI inserta egreso en la sesion propia del cajero (el requisito "misma sesion que la venta" ya no existe)', async () => {
    const calls = mockCrearNcrTx(fixturesConCuentas({ sesion_caja_id: 'sesion-vieja' }))

    await crearNotaCredito(
      baseParams({
        entryPoint: 'POS',
        sesionCajaActivaId: 'sesion-activa-1',
        modalidad: 'EFECTIVO_REAL',
        origenDinero: [origenSesionActiva],
      })
    )

    const egresoInsert = calls.find(
      (c) => c.sql.startsWith('INSERT INTO movimientos_metodo_cobro') && c.sql.includes("'NCR'")
    )
    expect(egresoInsert).toBeDefined()
    expect(egresoInsert!.params).toContain('sesion-activa-1')
  })

  it('Decision 4/5 — Tradicional con origenDinero apuntando a una sesion DISTINTA a la de emision (+ sesionDestinoId, exigido por Rule 6): SI inserta egreso en esa sesion (divergencia emision!=dinero intencional, obs #2938), y notas_credito.sesion_caja_id (emision) queda NULL', async () => {
    const calls = mockCrearNcrTx(
      fixturesConCuentas(
        { sesion_caja_id: null },
        { sesionesCaja: { 'sesion-B-de-otro-cajero': { status: 'ABIERTA' } } }
      )
    )

    await crearNotaCredito(
      baseParams({
        entryPoint: 'TRADICIONAL',
        modalidad: 'EFECTIVO_REAL',
        sesionDestinoId: 'sesion-B-de-otro-cajero',
        origenDinero: [{ tipo: 'SESION_EFECTIVO', cuentaId: 'metodo-efectivo-usd', monto: '30.00' }],
      })
    )

    const egresoInsert = calls.find(
      (c) => c.sql.startsWith('INSERT INTO movimientos_metodo_cobro') && c.sql.includes("'NCR'")
    )
    expect(egresoInsert).toBeDefined()
    expect(egresoInsert!.params).toContain('sesion-B-de-otro-cajero')

    // notas_credito.sesion_caja_id (columna de EMISION, no de dinero) sigue
    // NULL para TRADICIONAL — la divergencia vive en `origenDinero`, no en
    // esta columna (Design §Decision 4 "Intentional divergence").
    const ncrInsert = calls.find((c) => c.sql.startsWith('INSERT INTO notas_credito'))
    expect(ncrInsert).toBeDefined()
    expect(ncrInsert!.params).toContain(null)
  })

  it('Tradicional SIN origenDinero, modalidad no-desembolso (AJUSTE_CXC): NO inserta egreso (comportamiento previo intacto para las modalidades sin efectivo)', async () => {
    const calls = mockCrearNcrTx(fixturesConCuentas({ sesion_caja_id: 'sesion-vieja' }))

    await crearNotaCredito(baseParams({ entryPoint: 'TRADICIONAL', modalidad: 'AJUSTE_CXC' }))

    const egresoInsert = calls.find(
      (c) => c.sql.startsWith('INSERT INTO movimientos_metodo_cobro') && c.sql.includes("'NCR'")
    )
    expect(egresoInsert).toBeUndefined()
  })

  it('el write core NUNCA lee pagos originales (SELECT ... metodo_cobro_id, monto FROM pagos) para calcular el egreso — axis 3 desacoplado de axis 2 (obs #2948, task 3.8/3.14): 2 pagos originales de metodos distintos producen exactamente 1 egreso (== tamano de origenDinero, no de pagos)', async () => {
    const calls = mockCrearNcrTx(
      fixturesConCuentas(
        { sesion_caja_id: 'sesion-activa-1' },
        {
          pagos: [
            { id: 'pago-1', metodo_cobro_id: 'metodo-efectivo', monto: '10.00', moneda_id: 'usd-id' },
            { id: 'pago-2', metodo_cobro_id: 'metodo-tarjeta', monto: '20.00', moneda_id: 'usd-id' },
          ],
        }
      )
    )

    await crearNotaCredito(
      baseParams({
        entryPoint: 'POS',
        sesionCajaActivaId: 'sesion-activa-1',
        modalidad: 'EFECTIVO_REAL',
        origenDinero: [origenSesionActiva],
      })
    )

    const pagosSelect = calls.find((c) => c.sql.startsWith('SELECT id, metodo_cobro_id, monto FROM pagos'))
    expect(pagosSelect).toBeUndefined()

    const egresos = calls.filter(
      (c) => c.sql.startsWith('INSERT INTO movimientos_metodo_cobro') && c.sql.includes("'NCR'")
    )
    expect(egresos).toHaveLength(1)
    expect(egresos[0]!.params).toContain('metodo-efectivo-usd')
  })

  it('marca is_reversed=1 para los pagos no reversados de la venta (NC tipo TOTAL) — axis 2, independiente del axis 3 de arriba', async () => {
    const calls = mockCrearNcrTx(
      fixturesConCuentas(
        { sesion_caja_id: 'sesion-activa-1' },
        { pagos: [{ id: 'pago-1', metodo_cobro_id: 'metodo-efectivo', monto: '30.00', moneda_id: 'usd-id' }] }
      )
    )

    await crearNotaCredito(
      baseParams({
        entryPoint: 'POS',
        sesionCajaActivaId: 'sesion-activa-1',
        modalidad: 'EFECTIVO_REAL',
        origenDinero: [origenSesionActiva],
      })
    )

    const reversa = calls.find((c) => c.sql.startsWith('UPDATE pagos SET is_reversed'))
    expect(reversa).toBeDefined()
    expect(reversa!.params).toContain('venta-1')
  })

  it('CERO pagos originales (venta de credito sin abonos): el write core IGUAL inserta el egreso de origenDinero — la existencia del egreso NUNCA dependio de que existan pagos previos (decoupling completo)', async () => {
    const calls = mockCrearNcrTx(fixturesConCuentas({ sesion_caja_id: 'sesion-activa-1' }, { pagos: [] }))

    await crearNotaCredito(
      baseParams({
        entryPoint: 'POS',
        sesionCajaActivaId: 'sesion-activa-1',
        modalidad: 'EFECTIVO_REAL',
        origenDinero: [origenSesionActiva],
      })
    )

    const egresoInsert = calls.find(
      (c) => c.sql.startsWith('INSERT INTO movimientos_metodo_cobro') && c.sql.includes("'NCR'")
    )
    expect(egresoInsert).toBeDefined()

    const reversa = calls.find((c) => c.sql.startsWith('UPDATE pagos SET is_reversed'))
    expect(reversa).toBeDefined()
  })
})

describe('crearNotaCredito — Slice 3a, Pass 1 sum-invariant (task 3.9): Σ(origenDinero→USD) ≤ remanenteALiquidar + epsilon(0.005)', () => {
  function fixturesInvariante(cuentas: NcrTxFixtures['cuentas']) {
    return {
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '40',
        total_usd: '30.00',
        total_bs: '1200.00',
        saldo_pend_usd: '0.00', // remanenteALiquidar = 30.00 - 0 = 30.00
        tipo: 'CONTADO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
        sesion_caja_id: 'sesion-activa-1',
      },
      ventaDet: [{ producto_id: 'prod-1', cantidad: '3.000', lote_id: null }],
      productos: { 'prod-1': { tipo: 'P', stock: '20.000', nombre: 'Producto 1' } },
      inventarioStock: { 'prod-1::dep-B': '10.000' },
      pagos: [],
      sesionesCaja: { 'sesion-activa-1': { status: 'ABIERTA' } },
      cuentas,
    }
  }

  it('suma EXACTA al remanente (30.00 USD): acepta, no rechaza', async () => {
    mockCrearNcrTx(
      fixturesInvariante({ 'metodo-efectivo-usd': { saldo_actual: '500.00000000', moneda_codigo: 'USD' } })
    )

    await expect(
      crearNotaCredito(
        baseParams({
          entryPoint: 'POS',
          sesionCajaActivaId: 'sesion-activa-1',
          modalidad: 'EFECTIVO_REAL',
          origenDinero: [{ tipo: 'SESION_EFECTIVO', cuentaId: 'metodo-efectivo-usd', monto: '30.00' }],
        })
      )
    ).resolves.toBeDefined()
  })

  it('suma en el BORDE del epsilon (30.005 USD, exactamente remanente+0.005): acepta, no rechaza', async () => {
    mockCrearNcrTx(
      fixturesInvariante({ 'metodo-efectivo-usd': { saldo_actual: '500.00000000', moneda_codigo: 'USD' } })
    )

    await expect(
      crearNotaCredito(
        baseParams({
          entryPoint: 'POS',
          sesionCajaActivaId: 'sesion-activa-1',
          modalidad: 'EFECTIVO_REAL',
          origenDinero: [{ tipo: 'SESION_EFECTIVO', cuentaId: 'metodo-efectivo-usd', monto: '30.005' }],
        })
      )
    ).resolves.toBeDefined()
  })

  it('suma por ENCIMA del remanente+epsilon (30.01 USD): rechaza', async () => {
    mockCrearNcrTx(
      fixturesInvariante({ 'metodo-efectivo-usd': { saldo_actual: '500.00000000', moneda_codigo: 'USD' } })
    )

    await expect(
      crearNotaCredito(
        baseParams({
          entryPoint: 'POS',
          sesionCajaActivaId: 'sesion-activa-1',
          modalidad: 'EFECTIVO_REAL',
          origenDinero: [{ tipo: 'SESION_EFECTIVO', cuentaId: 'metodo-efectivo-usd', monto: '30.01' }],
        })
      )
    ).rejects.toThrow(/excede el remanente/i)
  })

  it('cuentaId desconocido/no perteneciente a la empresa (ausente del filtro WHERE t.id=? AND t.empresa_id=?): rechaza', async () => {
    mockCrearNcrTx(fixturesInvariante({})) // cuenta 'metodo-ajeno' nunca resuelve

    await expect(
      crearNotaCredito(
        baseParams({
          entryPoint: 'POS',
          sesionCajaActivaId: 'sesion-activa-1',
          modalidad: 'EFECTIVO_REAL',
          origenDinero: [{ tipo: 'SESION_EFECTIVO', cuentaId: 'metodo-ajeno', monto: '10.00' }],
        })
      )
    ).rejects.toThrow(/no existe|no pertenece/i)
  })

  it('conversion Bs→USD via tasa de la venta: 500 Bs a tasa 40 = 12.50 USD, dentro del remanente (30.00) — acepta', async () => {
    mockCrearNcrTx(
      fixturesInvariante({ 'metodo-efectivo-bs': { saldo_actual: '5000.00000000', moneda_codigo: 'VES' } })
    )

    await expect(
      crearNotaCredito(
        baseParams({
          entryPoint: 'POS',
          sesionCajaActivaId: 'sesion-activa-1',
          modalidad: 'EFECTIVO_REAL',
          origenDinero: [{ tipo: 'SESION_EFECTIVO', cuentaId: 'metodo-efectivo-bs', monto: '500' }],
        })
      )
    ).resolves.toBeDefined()
  })
})

describe('crearNotaCredito — Slice 3a, mixed-type multi-asignacion (task 3.10, ejemplo canonico del owner)', () => {
  it('Bs500 SESION_EFECTIVO + Bs500 BANCO en UNA sola NC: escribe en movimientos_metodo_cobro Y movimientos_bancarios, guard de sesion cerrada evaluado UNA sola vez para toda la NC', async () => {
    const calls = mockCrearNcrTx({
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '500',
        total_usd: '2.00',
        total_bs: '1000.00',
        saldo_pend_usd: '0.00', // remanenteALiquidar = 2.00 USD
        tipo: 'CONTADO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
        sesion_caja_id: 'sesion-activa-1',
      },
      ventaDet: [{ producto_id: 'prod-1', cantidad: '3.000', lote_id: null }],
      productos: { 'prod-1': { tipo: 'P', stock: '20.000', nombre: 'Producto 1' } },
      inventarioStock: { 'prod-1::dep-B': '10.000' },
      pagos: [],
      sesionesCaja: { 'sesion-activa-1': { status: 'ABIERTA' } },
      cuentas: {
        'metodo-efectivo-bs': { saldo_actual: '5000.00000000', moneda_codigo: 'VES' },
        'banco-1': { saldo_actual: '10000.00000000', moneda_codigo: 'VES' },
      },
    })

    await crearNotaCredito(
      baseParams({
        entryPoint: 'POS',
        sesionCajaActivaId: 'sesion-activa-1',
        modalidad: 'EFECTIVO_REAL',
        origenDinero: [
          { tipo: 'SESION_EFECTIVO', cuentaId: 'metodo-efectivo-bs', monto: '500' },
          { tipo: 'BANCO', cuentaId: 'banco-1', monto: '500' },
        ],
      })
    )

    const egresoSesion = calls.find(
      (c) => c.sql.startsWith('INSERT INTO movimientos_metodo_cobro') && c.sql.includes("'NCR'")
    )
    expect(egresoSesion).toBeDefined()
    expect(egresoSesion!.params).toContain('500.00000000')
    expect(egresoSesion!.params).toContain('sesion-activa-1')

    const egresoBanco = calls.find((c) => c.sql.startsWith('INSERT INTO movimientos_bancarios'))
    expect(egresoBanco).toBeDefined()
    expect(egresoBanco!.sql).toContain('REFUND_NCR')
    expect(egresoBanco!.params).toContain('500.00000000')
    expect(egresoBanco!.params).toContain('banco-1')

    // Guard de sesion cerrada: evaluado UNA sola vez para toda la NC, no
    // una vez por asignacion SESION_EFECTIVO (Design §Decision 4/5).
    const sesionChecks = calls.filter((c) => c.sql.startsWith('SELECT status FROM sesiones_caja'))
    expect(sesionChecks).toHaveLength(1)

    // Real balance tracking: metodos_cobro.saldo_actual Y bancos_empresa.saldo_actual ambos actualizados.
    const updateMetodo = calls.find((c) => c.sql.startsWith('UPDATE metodos_cobro SET saldo_actual'))
    const updateBanco = calls.find((c) => c.sql.startsWith('UPDATE bancos_empresa SET saldo_actual'))
    expect(updateMetodo).toBeDefined()
    expect(updateBanco).toBeDefined()
  })

  it('sesion destino CERRADA: rechaza ANTES de escribir cualquier egreso (guard evaluado antes del loop de Pass 1)', async () => {
    const calls = mockCrearNcrTx({
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '40',
        total_usd: '30.00',
        total_bs: '1200.00',
        saldo_pend_usd: '0.00',
        tipo: 'CONTADO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
        sesion_caja_id: 'sesion-activa-1',
      },
      ventaDet: [{ producto_id: 'prod-1', cantidad: '3.000', lote_id: null }],
      productos: { 'prod-1': { tipo: 'P', stock: '20.000', nombre: 'Producto 1' } },
      inventarioStock: { 'prod-1::dep-B': '10.000' },
      pagos: [],
      sesionesCaja: { 'sesion-activa-1': { status: 'CERRADA' } },
      cuentas: { 'metodo-efectivo-usd': { saldo_actual: '500.00000000', moneda_codigo: 'USD' } },
    })

    await expect(
      crearNotaCredito(
        baseParams({
          entryPoint: 'POS',
          sesionCajaActivaId: 'sesion-activa-1',
          modalidad: 'EFECTIVO_REAL',
          origenDinero: [{ tipo: 'SESION_EFECTIVO', cuentaId: 'metodo-efectivo-usd', monto: '30.00' }],
        })
      )
    ).rejects.toThrow(/cerrada/i)

    expect(calls.find((c) => c.sql.startsWith('INSERT INTO movimientos_metodo_cobro'))).toBeUndefined()
  })
})

describe('crearNotaCredito — Slice 3a, ausencia del modelo FIFO viejo (task 3.8)', () => {
  it('el modulo NO referencia capearEgresosPorRemanente/PagoParaReversaEfectivo/EgresoReversaCapeado (modelo FIFO-sobre-pagos removido por completo — nunca existio en esta rama, confirmado por lectura de codigo)', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const sourcePath = path.resolve(__dirname, '../use-notas-credito.ts')
    const source = await fs.readFile(sourcePath, 'utf-8')

    expect(source).not.toMatch(/capearEgresosPorRemanente/)
    expect(source).not.toMatch(/PagoParaReversaEfectivo/)
    expect(source).not.toMatch(/EgresoReversaCapeado/)
    // La SELECT que alimentaba el modelo viejo (leer pagos para calcular el
    // egreso) tambien debe estar ausente — el write core solo lee `pagos`
    // para el UPDATE is_reversed (axis 2), nunca para el monto del egreso.
    expect(source).not.toMatch(/SELECT id, metodo_cobro_id, monto FROM pagos/)
  })
})

describe('crearNotaCredito — Slice 3 (modalidades de liquidacion + gate anti-fraude de no-desembolso)', () => {
  function fixturesModalidad(overrides: Partial<NcrTxFixtures['venta']> = {}) {
    return {
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '40',
        total_usd: '30.00',
        total_bs: '1200.00',
        saldo_pend_usd: '0.00',
        tipo: 'CONTADO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
        sesion_caja_id: 'sesion-activa-1',
        ...overrides,
      },
      ventaDet: [{ producto_id: 'prod-1', cantidad: '3.000', lote_id: null }],
      productos: { 'prod-1': { tipo: 'P', stock: '20.000', nombre: 'Producto 1' } },
      inventarioStock: { 'prod-1::dep-B': '10.000' },
      clienteSaldoActual: '0.00',
    }
  }

  describe('gate anti-fraude — funcion pura (nivel de funcion, no UI)', () => {
    it.each(['SALDO_FAVOR', 'AJUSTE_CXC', 'COMPENSACION_VENTA'] as const)(
      'rechaza egresoParams cuando la modalidad es %s (no-efectivo)',
      (modalidad) => {
        expect(() =>
          assertGateAntiFraudeNoDesembolso(modalidad, { metodoCobroId: 'm', monto: 30 })
        ).toThrow(/no-desembolso/i)
      }
    )

    it('permite egresoParams cuando la modalidad es EFECTIVO_REAL', () => {
      expect(() =>
        assertGateAntiFraudeNoDesembolso('EFECTIVO_REAL', { metodoCobroId: 'm', monto: 30 })
      ).not.toThrow()
    })

    it('permite egresoParams cuando la modalidad es REFUND_TESORERIA', () => {
      expect(() =>
        assertGateAntiFraudeNoDesembolso('REFUND_TESORERIA', { metodoCobroId: 'm', monto: 30 })
      ).not.toThrow()
    })

    it('no rechaza una modalidad no-efectivo SIN egresoParams (flujo normal)', () => {
      expect(() => assertGateAntiFraudeNoDesembolso('SALDO_FAVOR', undefined)).not.toThrow()
    })
  })

  it('crearNotaCredito: el gate rechaza ANTES de abrir la transaccion — llamada directa (bypass de UI) con modalidad SALDO_FAVOR + egresoParams forzado', async () => {
    mockCrearNcrTx(fixturesModalidad())

    await expect(
      crearNotaCredito(
        baseParams({
          entryPoint: 'POS',
          sesionCajaActivaId: 'sesion-activa-1',
          modalidad: 'SALDO_FAVOR',
          egresoParams: { metodoCobroId: 'metodo-efectivo', monto: 30 },
        })
      )
    ).rejects.toThrow(/no-desembolso/i)

    expect(mockedDb.writeTransaction).not.toHaveBeenCalled()
  })

  it('crearNotaCredito: REFUND_TESORERIA rechaza como "no implementado" (Slice 3a/3b), sin abrir transaccion — origenDinero valido (array no vacio, Rule 1) para llegar a este throw y no al de validarOrigenDinero', async () => {
    mockCrearNcrTx(fixturesModalidad())

    await expect(
      crearNotaCredito(
        baseParams({
          modalidad: 'REFUND_TESORERIA',
          origenDinero: [{ tipo: 'BANCO', cuentaId: 'banco-1', monto: '30.00' }],
        })
      )
    ).rejects.toThrow(/no esta implementado/i)

    expect(mockedDb.writeTransaction).not.toHaveBeenCalled()
  })

  it('SALDO_FAVOR: inserta movimientos_cuenta tipo SAFC trazable a nota_credito_id, CERO escritura en movimientos_metodo_cobro', async () => {
    const calls = mockCrearNcrTx(fixturesModalidad())

    await crearNotaCredito(baseParams({ entryPoint: 'TRADICIONAL', modalidad: 'SALDO_FAVOR' }))

    const safcInsert = calls.find(
      (c) => c.sql.startsWith('INSERT INTO movimientos_cuenta') && c.sql.includes("'SAFC'")
    )
    expect(safcInsert).toBeDefined()
    expect(safcInsert!.params).toContain('30.00000000') // remanente = total_usd(30) - saldoPend(0), toStorageString = 8dp

    // Trazabilidad: doc_origen_id del SAFC apunta al id de la NC recien creada
    const ncrInsert = calls.find((c) => c.sql.startsWith('INSERT INTO notas_credito'))
    const ncrId = ncrInsert!.params[0] as string
    expect(safcInsert!.params).toContain(ncrId)

    // BUGFIX (verify obs #2815): doc_origen_tipo del SAFC debe ser un valor
    // valido para el CHECK `movimientos_cuenta_doc_origen_tipo_check`
    // (migrations/0043_saldo_inicial_import.sql: VENTA | PAGO | NOTA_CREDITO |
    // NOTA_DEBITO | SALDO_INICIAL). 'NCR' NO esta en esa lista — es un valor
    // valido para `movimientos_cuenta.tipo` y para el CHECK de
    // `movimientos_metodo_cobro.origen`, pero NO para `doc_origen_tipo` de
    // `movimientos_cuenta`, y por eso el INSERT violaba el constraint.
    expect(safcInsert!.params).toContain('NOTA_CREDITO')
    expect(safcInsert!.params).not.toContain('NCR')

    const egresoInsert = calls.find((c) => c.sql.startsWith('INSERT INTO movimientos_metodo_cobro'))
    expect(egresoInsert).toBeUndefined()

    // notas_credito.liquidacion_modalidad / no_desembolso persistidos (ultimos 2 params posicionales)
    expect(ncrInsert!.params[ncrInsert!.params.length - 2]).toBe('SALDO_FAVOR')
    expect(ncrInsert!.params[ncrInsert!.params.length - 1]).toBe(1) // no_desembolso = TRUE
  })

  it.each([
    { entryPoint: 'TRADICIONAL' as const, sesionCajaActivaId: undefined },
    { entryPoint: 'POS' as const, sesionCajaActivaId: 'sesion-activa-1' },
  ])(
    'persiste entry_point=$entryPoint verbatim en el INSERT de notas_credito (Slice 1, migracion 0092)',
    async ({ entryPoint, sesionCajaActivaId }) => {
      const calls = mockCrearNcrTx(fixturesModalidad())

      await crearNotaCredito(
        baseParams({ modalidad: 'SALDO_FAVOR', entryPoint, sesionCajaActivaId })
      )

      const ncrInsert = calls.find((c) => c.sql.startsWith('INSERT INTO notas_credito ('))
      expect(ncrInsert).toBeDefined()

      // Localiza la posicion real de la columna `entry_point` en el SQL en
      // vez de asumir un indice fijo — el assert queda atado al SQL real,
      // no a un numero magico que se desincroniza si el orden cambia.
      const columnList = ncrInsert!.sql
        .slice(ncrInsert!.sql.indexOf('(') + 1, ncrInsert!.sql.indexOf(')'))
        .split(',')
        .map((c) => c.trim())
      const entryPointIndex = columnList.indexOf('entry_point')
      expect(entryPointIndex).toBeGreaterThanOrEqual(0)
      expect(ncrInsert!.params[entryPointIndex]).toBe(entryPoint)
    }
  )

  it('COMPENSACION_VENTA: MISMO comportamiento SAFC que SALDO_FAVOR dentro de esta funcion, y NUNCA invoca crearVenta() internamente', async () => {
    const calls = mockCrearNcrTx(fixturesModalidad())

    await crearNotaCredito(baseParams({ entryPoint: 'TRADICIONAL', modalidad: 'COMPENSACION_VENTA' }))

    const safcInsert = calls.find(
      (c) => c.sql.startsWith('INSERT INTO movimientos_cuenta') && c.sql.includes("'SAFC'")
    )
    expect(safcInsert).toBeDefined()
    expect(crearVentaSpy).not.toHaveBeenCalled()
  })

  it('AJUSTE_CXC: reduce clientes.saldo_actual via movimientos_cuenta (Step B), CERO escritura de caja', async () => {
    const calls = mockCrearNcrTx(fixturesModalidad())

    await crearNotaCredito(baseParams({ entryPoint: 'TRADICIONAL', modalidad: 'AJUSTE_CXC' }))

    const ajusteInsert = calls.find(
      (c) => c.sql.startsWith('INSERT INTO movimientos_cuenta') && c.sql.includes("'NCR'")
    )
    expect(ajusteInsert).toBeDefined()
    expect(ajusteInsert!.params).toContain('30.00000000')

    const egresoInsert = calls.find((c) => c.sql.startsWith('INSERT INTO movimientos_metodo_cobro'))
    expect(egresoInsert).toBeUndefined()
  })

  it('AJUSTE_CXC nunca deja el saldo del cliente negativo — tope en 0 aunque el remanente exceda la deuda existente', async () => {
    const calls = mockCrearNcrTx(fixturesModalidad())
    // clienteSaldoActual por defecto en el fixture es '0.00' — el remanente
    // (30.00) excede la deuda existente (0), el tope debe evitar negativo.

    await crearNotaCredito(baseParams({ entryPoint: 'TRADICIONAL', modalidad: 'AJUSTE_CXC' }))

    const ajusteInsert = calls.find(
      (c) => c.sql.startsWith('INSERT INTO movimientos_cuenta') && c.sql.includes("'NCR'")
    )
    expect(ajusteInsert).toBeDefined()
    // saldo_nuevo (saldoActual - remanente, topeado en 0) queda en '0.00000000', nunca negativo
    expect(ajusteInsert!.params).toContain('0.00000000')
  })

  it('REGRESION obs #2814 — POS + sesion activa + modalidad SALDO_FAVOR: la Regla de Oro NO escribe ningun EGRESO (pin del fix de modalidad)', async () => {
    const calls = mockCrearNcrTx(fixturesModalidad({ sesion_caja_id: 'sesion-activa-1' }))

    await crearNotaCredito(
      baseParams({
        entryPoint: 'POS',
        sesionCajaActivaId: 'sesion-activa-1',
        modalidad: 'SALDO_FAVOR',
      })
    )

    const egresoInsert = calls.find(
      (c) => c.sql.startsWith('INSERT INTO movimientos_metodo_cobro') && c.sql.includes("'NCR'")
    )
    expect(egresoInsert).toBeUndefined()
  })

  it('remanente cero (factura nunca cobrada, saldoPend == total_usd): ninguna modalidad no-efectivo escribe Step B (SAFC)', async () => {
    const calls = mockCrearNcrTx(fixturesModalidad({ total_usd: '30.00', saldo_pend_usd: '30.00' }))

    await crearNotaCredito(baseParams({ entryPoint: 'TRADICIONAL', modalidad: 'SALDO_FAVOR' }))

    const safcInsert = calls.find(
      (c) => c.sql.startsWith('INSERT INTO movimientos_cuenta') && c.sql.includes("'SAFC'")
    )
    expect(safcInsert).toBeUndefined()
  })
})

describe('crearNotaCredito — Slice 5a-2a (depositoReingresoId threading, obs #2840, cierra el WARNING de Slice 5a)', () => {
  function fixturesDeposito(overrides: Partial<NcrTxFixtures> = {}) {
    return {
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '40',
        total_usd: '30.00',
        total_bs: '1200.00',
        saldo_pend_usd: '0.00',
        tipo: 'CONTADO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
      },
      ventaDet: [{ producto_id: 'prod-1', cantidad: '3.000', lote_id: null }],
      productos: { 'prod-1': { tipo: 'P', stock: '20.000', nombre: 'Producto 1' } },
      ...overrides,
    }
  }

  it('depositoReingresoId explicito y activo: se usa en vez del riel automatico, ignorando venta.deposito_id', async () => {
    const calls = mockCrearNcrTx(
      fixturesDeposito({ inventarioStock: { 'prod-1::dep-override': '5.000' } })
    )

    await crearNotaCredito(baseParams({ depositoReingresoId: 'dep-override' }))

    const kardexInsert = calls.find((c) => c.sql.startsWith('INSERT INTO movimientos_inventario'))
    expect(kardexInsert).toBeDefined()
    expect(kardexInsert!.params).toContain('dep-override')
    expect(kardexInsert!.params).not.toContain('dep-B')

    // El override evita por completo el riel automatico (nunca consulta
    // is_active del origen ni busca el principal).
    expect(calls.find((c) => c.sql.startsWith('SELECT is_active FROM depositos'))).toBeUndefined()
    expect(calls.find((c) => c.sql.includes('es_principal'))).toBeUndefined()
  })

  it('depositoReingresoId invalido (inactivo o de otra empresa): rechaza ANTES de escribir cualquier kardex', async () => {
    const calls = mockCrearNcrTx(fixturesDeposito({ overrideDepositoValido: false }))

    await expect(
      crearNotaCredito(baseParams({ depositoReingresoId: 'dep-ajena' }))
    ).rejects.toThrow(/deposito/i)

    expect(calls.find((c) => c.sql.startsWith('INSERT INTO movimientos_inventario'))).toBeUndefined()
    expect(calls.find((c) => c.sql.startsWith('INSERT INTO notas_credito'))).toBeUndefined()
  })

  it('sin depositoReingresoId: preserva el riel automatico existente (regresion — comportamiento previo intacto)', async () => {
    const calls = mockCrearNcrTx(fixturesDeposito({ inventarioStock: { 'prod-1::dep-B': '10.000' } }))

    await crearNotaCredito(baseParams())

    const overrideValidation = calls.find((c) =>
      c.sql.startsWith('SELECT id FROM depositos WHERE id = ? AND empresa_id = ? AND is_active = 1')
    )
    expect(overrideValidation).toBeUndefined()

    const kardexInsert = calls.find((c) => c.sql.startsWith('INSERT INTO movimientos_inventario'))
    expect(kardexInsert!.params).toContain('dep-B')
  })
})

describe('crearNotaCredito — Slice 4b (wiring PARCIAL en la tx atomica: notas_credito_det, guard doble-credito, desglose fiscal por linea)', () => {
  const ventaDetDosLineas = [
    {
      id: 'vdet-A',
      producto_id: 'prod-A',
      cantidad: '4.000',
      lote_id: null,
      precio_unitario_usd: '10.00',
      tipo_impuesto: 'Gravable',
      impuesto_pct: '16',
    },
    {
      id: 'vdet-B',
      producto_id: 'prod-B',
      cantidad: '2.000',
      lote_id: null,
      precio_unitario_usd: '15.00',
      tipo_impuesto: 'Exento',
      impuesto_pct: '0',
    },
  ]
  const productosDosLineas = {
    'prod-A': { tipo: 'P', stock: '50.000', nombre: 'Producto A' },
    'prod-B': { tipo: 'P', stock: '20.000', nombre: 'Producto B' },
  }

  it('TOTAL (tipo omitido): sigue derivando TODAS las lineas — escribe un notas_credito_det POR LINEA (antes NUNCA se escribia) y preserva total_usd/total_bs verbatim de venta.total_usd/total_bs, sumando el desglose SOLO en las columnas nuevas', async () => {
    const calls = mockCrearNcrTx({
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '40',
        total_usd: '100.00',
        total_bs: '4000.00',
        saldo_pend_usd: '0.00',
        tipo: 'CONTADO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
      },
      ventaDet: ventaDetDosLineas,
      productos: productosDosLineas,
      inventarioStock: { 'prod-A::dep-B': '10.000', 'prod-B::dep-B': '5.000' },
    })

    await crearNotaCredito(baseParams({ entryPoint: 'TRADICIONAL', modalidad: 'AJUSTE_CXC' }))

    const detInserts = calls.filter((c) => c.sql.startsWith('INSERT INTO notas_credito_det'))
    expect(detInserts).toHaveLength(2)
    expect(detInserts.some((c) => c.params.includes('vdet-A'))).toBe(true)
    expect(detInserts.some((c) => c.params.includes('vdet-B'))).toBe(true)

    const kardexInserts = calls.filter((c) => c.sql.startsWith('INSERT INTO movimientos_inventario'))
    expect(kardexInserts).toHaveLength(2)
    expect(kardexInserts.some((c) => c.params.includes('4.000'))).toBe(true) // linea A completa
    expect(kardexInserts.some((c) => c.params.includes('2.000'))).toBe(true) // linea B completa

    const ncrInsert = calls.find((c) => c.sql.startsWith('INSERT INTO notas_credito ('))
    expect(ncrInsert).toBeDefined()
    expect(ncrInsert!.params).toContain('TOTAL')
    // total_usd/total_bs preservan venta.total_usd/total_bs VERBATIM (no se recomputan sumando lineas)
    expect(ncrInsert!.params).toContain('100.00')
    expect(ncrInsert!.params).toContain('4000.00')
    // Columnas nuevas (antes siempre 0, nunca escritas): exento=linea B (30.00), base=linea A (40.00), iva=linea A (6.40)
    expect(ncrInsert!.params).toContain('30.00000000')
    expect(ncrInsert!.params).toContain('40.00000000')
    expect(ncrInsert!.params).toContain('6.40000000')
  })

  it('PARCIAL: escribe notas_credito_det + Kardex SOLO para la linea/cantidad seleccionada, tipo=PARCIAL, y el header usa la suma de lineas (no venta.total_usd completo)', async () => {
    const calls = mockCrearNcrTx({
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '40',
        total_usd: '100.00',
        total_bs: '4000.00',
        saldo_pend_usd: '0.00',
        tipo: 'CONTADO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
      },
      ventaDet: ventaDetDosLineas,
      productos: productosDosLineas,
      inventarioStock: { 'prod-A::dep-B': '10.000' },
      clienteSaldoActual: '0.00',
    })

    await crearNotaCredito(
      baseParams({
        entryPoint: 'TRADICIONAL',
        modalidad: 'AJUSTE_CXC',
        tipo: 'PARCIAL',
        lineas: [{ venta_det_id: 'vdet-A', cantidadDevolver: '2.000' }],
      })
    )

    const detInserts = calls.filter((c) => c.sql.startsWith('INSERT INTO notas_credito_det'))
    expect(detInserts).toHaveLength(1)
    expect(detInserts[0]!.params).toContain('vdet-A')
    expect(detInserts[0]!.params).toContain('2.000') // cantidad devuelta, NO los 4.000 vendidos
    expect(detInserts[0]!.params).toContain('20.00000000') // subtotal_usd = 2 * 10.00

    const kardexInserts = calls.filter((c) => c.sql.startsWith('INSERT INTO movimientos_inventario'))
    expect(kardexInserts).toHaveLength(1)
    expect(kardexInserts[0]!.params).toContain('2.000')
    expect(kardexInserts[0]!.params).not.toContain('prod-B')

    const ncrInsert = calls.find((c) => c.sql.startsWith('INSERT INTO notas_credito ('))
    expect(ncrInsert).toBeDefined()
    expect(ncrInsert!.params).toContain('PARCIAL')
    // total_usd = 23.20 (base 20.00 + iva 3.20 de la linea A parcial) — NO 100.00 (venta.total_usd completo)
    expect(ncrInsert!.params).toContain('23.20000000')
    expect(ncrInsert!.params).toContain('928.00000000') // total_bs = usdToBs(23.20, 40)
    expect(ncrInsert!.params).toContain('20.00000000') // total_base_usd
    expect(ncrInsert!.params).toContain('3.20000000') // total_iva_usd
    expect(ncrInsert!.params).not.toContain('100.00')

    // Step B (remanente = 23.20, saldoPend=0) liquida via AJUSTE_CXC
    const ajusteInsert = calls.find(
      (c) => c.sql.startsWith('INSERT INTO movimientos_cuenta') && c.sql.includes("'NCR'")
    )
    expect(ajusteInsert).toBeDefined()
    expect(ajusteInsert!.params).toContain('23.20000000')

    // La factura permanece ACTIVA — nunca se marca ANULADA para PARCIAL
    const ventaUpdate = calls.find((c) => c.sql.startsWith('UPDATE ventas SET saldo_pend_usd'))
    expect(ventaUpdate).toBeDefined()
    expect(ventaUpdate!.sql).not.toContain('status')
    const statusUpdate = calls.find((c) => c.sql.includes("status = 'ANULADA'"))
    expect(statusUpdate).toBeUndefined()
  })

  it('PARCIAL: el guard de doble-credito rechaza cuando ya-acreditado + cantidadDevolver excede la cantidad original — NADA se persiste (ni header ni det)', async () => {
    const calls = mockCrearNcrTx({
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '40',
        total_usd: '100.00',
        total_bs: '4000.00',
        saldo_pend_usd: '0.00',
        tipo: 'CONTADO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
      },
      ventaDet: ventaDetDosLineas,
      productos: productosDosLineas,
      yaAcreditadoPorLinea: { 'vdet-A': '3.000' }, // ya se acredito 3 de 4 en una NC previa
    })

    await expect(
      crearNotaCredito(
        baseParams({
          entryPoint: 'TRADICIONAL',
          modalidad: 'AJUSTE_CXC',
          tipo: 'PARCIAL',
          lineas: [{ venta_det_id: 'vdet-A', cantidadDevolver: '2.000' }], // 3 + 2 = 5 > 4 original
        })
      )
    ).rejects.toThrow(/ya tiene/i)

    expect(calls.find((c) => c.sql.startsWith('INSERT INTO notas_credito ('))).toBeUndefined()
    expect(calls.find((c) => c.sql.startsWith('INSERT INTO notas_credito_det'))).toBeUndefined()
  })

  it('PARCIAL: linea de servicio NO seleccionada no genera movimiento de receta (Kardex/receta escopeado a la seleccion)', async () => {
    const calls = mockCrearNcrTx({
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '40',
        total_usd: '100.00',
        total_bs: '4000.00',
        saldo_pend_usd: '0.00',
        tipo: 'CONTADO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
      },
      ventaDet: [
        {
          id: 'vdet-A',
          producto_id: 'prod-A',
          cantidad: '4.000',
          lote_id: null,
          precio_unitario_usd: '10.00',
          tipo_impuesto: 'Exento',
        },
        {
          id: 'vdet-S',
          producto_id: 'servicio-1',
          cantidad: '2.000',
          lote_id: null,
          precio_unitario_usd: '50.00',
          tipo_impuesto: 'Exento',
        },
      ],
      productos: {
        'prod-A': { tipo: 'P', stock: '50.000', nombre: 'Producto A' },
        'servicio-1': { tipo: 'S', stock: '0.000', nombre: 'Servicio 1' },
        'ing-1': { tipo: 'P', stock: '50.000', nombre: 'Ingrediente 1' },
      },
      recetas: {
        'servicio-1': [{ producto_id: 'ing-1', cantidad: '1.000', stock: '50.000', nombre: 'Ingrediente 1' }],
      },
      inventarioStock: { 'prod-A::dep-B': '10.000' },
      clienteSaldoActual: '0.00',
    })

    await crearNotaCredito(
      baseParams({
        entryPoint: 'TRADICIONAL',
        modalidad: 'AJUSTE_CXC',
        tipo: 'PARCIAL',
        lineas: [{ venta_det_id: 'vdet-A', cantidadDevolver: '4.000' }], // solo el producto, NUNCA el servicio
      })
    )

    const detInserts = calls.filter((c) => c.sql.startsWith('INSERT INTO notas_credito_det'))
    expect(detInserts).toHaveLength(1)
    expect(detInserts[0]!.params).toContain('vdet-A')

    // La receta del servicio nunca se consulta — la linea no fue seleccionada
    expect(calls.find((c) => c.sql.startsWith('SELECT r.producto_id'))).toBeUndefined()
    const kardexIngrediente = calls.find(
      (c) => c.sql.startsWith('INSERT INTO movimientos_inventario') && c.params.includes('ing-1')
    )
    expect(kardexIngrediente).toBeUndefined()
  })

  it('PARCIAL con factura CREDITO parcialmente pendiente: Step A aplica solo hasta el limite de la deuda pendiente (no el total de la NC), y Step B liquida el resto', async () => {
    const calls = mockCrearNcrTx({
      venta: {
        id: 'venta-1',
        cliente_id: 'cliente-1',
        nro_factura: 'C01-000001',
        tasa: '40',
        total_usd: '46.40',
        total_bs: '1856.00',
        saldo_pend_usd: '10.00', // deuda pendiente MENOR al valor de la NC parcial (23.20)
        tipo: 'CREDITO',
        status: 'ACTIVA',
        deposito_id: 'dep-B',
      },
      ventaDet: [
        {
          id: 'vdet-A',
          producto_id: 'prod-A',
          cantidad: '4.000',
          lote_id: null,
          precio_unitario_usd: '10.00',
          tipo_impuesto: 'Gravable',
          impuesto_pct: '16',
        },
      ],
      productos: { 'prod-A': { tipo: 'P', stock: '50.000', nombre: 'Producto A' } },
      inventarioStock: { 'prod-A::dep-B': '10.000' },
      clienteSaldoActual: '0.00',
    })

    await crearNotaCredito(
      baseParams({
        entryPoint: 'TRADICIONAL',
        modalidad: 'SALDO_FAVOR',
        tipo: 'PARCIAL',
        lineas: [{ venta_det_id: 'vdet-A', cantidadDevolver: '2.000' }], // totalUsdNc = 23.20
      })
    )

    // Step A: reduce la deuda pendiente de la FACTURA — topeado por saldoPend (10.00), no por totalUsdNc (23.20)
    const stepAInsert = calls.find(
      (c) => c.sql.startsWith('INSERT INTO movimientos_cuenta') && c.sql.includes("'NCR'") && c.params.includes('venta-1')
    )
    expect(stepAInsert).toBeDefined()
    expect(stepAInsert!.params).toContain('10.00000000')

    // Step B: liquida el remanente (23.20 - 10.00 = 13.20) via SALDO_FAVOR (SAFC)
    const safcInsert = calls.find(
      (c) => c.sql.startsWith('INSERT INTO movimientos_cuenta') && c.sql.includes("'SAFC'")
    )
    expect(safcInsert).toBeDefined()
    expect(safcInsert!.params).toContain('13.20000000')

    // saldo_pend_usd de la factura queda en 0 (10.00 - 23.20 topeado en 0), sin marcar ANULADA
    const ventaUpdate = calls.find((c) => c.sql.startsWith('UPDATE ventas SET saldo_pend_usd'))
    expect(ventaUpdate).toBeDefined()
    expect(ventaUpdate!.params).toContain('0.00000000')
  })
})

describe('useReversosFactura (F1 QA fix: historial de NC aplicadas a una factura, JOIN notas_credito+notas_credito_det, empresa_id-scoped)', () => {
  beforeEach(() => {
    mockedUseQuery.mockReturnValue({ data: [], isLoading: false } as never)
  })

  it('sin ventaId: no ejecuta la query (sql vacio), retorna lista vacia', () => {
    const { result } = renderHook(() => useReversosFactura(null, 'emp-1'))

    expect(result.current.reversos).toEqual([])
    expect(mockedUseQuery).toHaveBeenCalledWith('', [])
  })

  it('con ventaId + empresaId: ejecuta la query JOIN notas_credito+notas_credito_det escopeada por empresa_id', () => {
    renderHook(() => useReversosFactura('venta-1', 'emp-1'))

    const [sql, params] = mockedUseQuery.mock.calls[0]
    expect(sql).toContain('notas_credito_det')
    expect(sql).toContain('nc.empresa_id = ?')
    expect(params).toEqual(['venta-1', 'emp-1'])
  })

  it('mapea las filas retornadas al shape ReversoFacturaRow (nro_ncr, tipo, venta_det_id, cantidad)', () => {
    mockedUseQuery.mockReturnValue({
      data: [
        {
          nota_credito_id: 'nc-1',
          nro_ncr: 'NCR-000001',
          tipo: 'PARCIAL',
          fecha: '2026-01-02T00:00:00Z',
          venta_det_id: 'vd-1',
          producto_descripcion: 'Botox 50U',
          cantidad: '2.000',
        },
      ],
      isLoading: false,
    } as never)

    const { result } = renderHook(() => useReversosFactura('venta-1', 'emp-1'))

    expect(result.current.reversos).toHaveLength(1)
    expect(result.current.reversos[0]).toMatchObject({ nro_ncr: 'NCR-000001', venta_det_id: 'vd-1', cantidad: '2.000' })
  })
})

describe('useNotasCredito — Slice B (notas-credito-ruta-administrativa, Design §Decision 4): filtros opcionales con default mes actual', () => {
  beforeEach(() => {
    mockedUseCurrentUser.mockReturnValue({
      user: { id: 'user-1', empresa_id: 'emp-1', email: '', nombre: '', level: 1, rol_id: null, rol_nombre: null },
      loading: false,
    })
    mockedUseQuery.mockReturnValue({ data: [], isLoading: false } as never)
  })

  it('sin args: preserva el comportamiento actual byte-a-byte (consumidores no migrados, smoke) — sin rango de fecha, params = [empresaId]', () => {
    renderHook(() => useNotasCredito())

    const [sql, params] = mockedUseQuery.mock.calls[0]!
    expect(sql).not.toContain('datetime(')
    expect(sql).not.toContain('nc.fecha >=')
    expect(params).toEqual(['emp-1'])
  })

  it('con filtros={} (sin fecha explicita): aplica rangoMesActual() por defecto', () => {
    vi.setSystemTime(new Date('2026-05-21T12:00:00'))

    renderHook(() => useNotasCredito({}))

    const [sql, params] = mockedUseQuery.mock.calls[0]!
    expect(sql).toContain('nc.empresa_id = ?')
    expect(params).toEqual(['emp-1', '2026-05-01', '2026-05-21'])
    vi.useRealTimers()
  })

  it('fechaDesde/fechaHasta explicitos bypasean el default de mes actual (escape hatch "ver todo el historial")', () => {
    renderHook(() => useNotasCredito({ fechaDesde: '2020-01-01', fechaHasta: '2026-05-21' }))

    const [, params] = mockedUseQuery.mock.calls[0]!
    expect(params).toEqual(['emp-1', '2020-01-01', '2026-05-21'])
  })

  it('Slice E.2: filtro busqueda (unificado) se aplica via buildNotasCreditoFiltro', () => {
    renderHook(() => useNotasCredito({ fechaDesde: '2026-05-01', fechaHasta: '2026-05-21', busqueda: 'NCR-000012' }))

    const [sql, params] = mockedUseQuery.mock.calls[0]!
    expect(sql).toContain('AND (nc.nro_ncr LIKE ? OR c.nombre LIKE ? OR c.identificacion LIKE ?)')
    expect(params).toContain('%NCR-000012%')
  })

  it('Slice E.b: el filtro de estado se retiro por completo — nc.tipo nunca es filtrable via el hook', () => {
    renderHook(() => useNotasCredito({ fechaDesde: '2026-05-01', fechaHasta: '2026-05-21', busqueda: 'Maria' }))

    const [sql] = mockedUseQuery.mock.calls[0]!
    expect(sql).not.toContain('nc.tipo = ?')
  })

  it('el campo `estado` YA NO existe en FiltroNotasCreditoHook (retirado, tester QA feedback Slice E.b)', () => {
    // @ts-expect-error — `estado` fue retirado del contrato publico del hook
    renderHook(() => useNotasCredito({ fechaDesde: '2026-05-01', fechaHasta: '2026-05-21', estado: 'REVERSO_TOTAL' }))

    const [sql] = mockedUseQuery.mock.calls[0]!
    expect(sql).not.toContain('nc.tipo = ?')
  })

  it('empresa_id SIEMPRE presente en params, con o sin filtros', () => {
    renderHook(() => useNotasCredito())
    expect(mockedUseQuery.mock.calls[0]![1]).toContain('emp-1')

    mockedUseQuery.mockClear()
    renderHook(() => useNotasCredito({ fechaDesde: '2026-05-01', fechaHasta: '2026-05-21' }))
    expect(mockedUseQuery.mock.calls[0]![1]).toContain('emp-1')
  })
})
