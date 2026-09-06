// Slice 5 (notas-credito-cuadre-origen-dinero): primer harness de tests para
// `use-cuadre.ts` (2199 lineas, cero tests hasta esta slice). Mismo patron
// aislado que `use-facturas-sesion-activa.test.ts`: mockeamos `useQuery` de
// `@powersync/react` y `useCurrentUser`, y enrutamos las respuestas mockeadas
// por el contenido del SQL (no ejecutamos SQLite real).
vi.mock('@powersync/react', () => ({ useQuery: vi.fn() }))
vi.mock('@/core/hooks/use-current-user', () => ({ useCurrentUser: vi.fn() }))

import { renderHook } from '@testing-library/react'
import { useQuery } from '@powersync/react'
import { useCurrentUser } from '@/core/hooks/use-current-user'
import {
  useTotalesFiscales,
  useReintegrosPorMetodo,
  useNotasCreditoDeSesion,
  useSaldoEfectivoBimonetario,
  type CuadreFilters,
} from '../use-cuadre'

const mockedUseQuery = vi.mocked(useQuery)
const mockedUseCurrentUser = vi.mocked(useCurrentUser)

const EMPRESA_ID = 'emp-1'

function setUser() {
  mockedUseCurrentUser.mockReturnValue({
    user: { id: 'user-1', empresa_id: EMPRESA_ID, email: '', nombre: '', level: 1, rol_id: null, rol_nombre: null },
    loading: false,
  })
}

function filtersConSesion(sesionCajaIds: string[]): CuadreFilters {
  return { fecha: '2026-09-06', cajaId: 'caja-1', sesionCajaIds }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useTotalesFiscales — total NCR pasa de date-scoped a session-scoped (task 5.2/5.5)', () => {
  it('con sesionCajaIds seleccionadas, la query de notas_credito filtra por sesion_caja_id (buildCuadreWhere), NO solo por fecha', () => {
    setUser()
    const filters = filtersConSesion(['sesion-1', 'sesion-2'])

    mockedUseQuery.mockImplementation(((sql: string) => {
      if (sql.includes('FROM notas_credito')) {
        return { data: [{ total_ncr: 15.5, total_ncr_bs: 620 }], isLoading: false }
      }
      // Query principal de ventas (no tocada por esta slice) — fila neutra.
      return { data: [{}], isLoading: false }
    }) as unknown as typeof useQuery)

    renderHook(() => useTotalesFiscales(filters))

    const ncrCall = mockedUseQuery.mock.calls.find(([sql]) => (sql as string).includes('FROM notas_credito'))
    expect(ncrCall).toBeDefined()
    const [sql, params] = ncrCall! as [string, unknown[]]
    expect(sql).toContain('sesion_caja_id IN')
    expect(sql).not.toMatch(/WHERE empresa_id = \? AND DATE\(/)
    expect(params).toEqual([EMPRESA_ID, 'sesion-1', 'sesion-2'])
  })

  it('el total NCR devuelto (totalNcrUsd/totalNcrBs) refleja la suma de la query session-scoped', () => {
    setUser()
    const filters = filtersConSesion(['sesion-1'])

    mockedUseQuery.mockImplementation(((sql: string) => {
      if (sql.includes('FROM notas_credito')) {
        return { data: [{ total_ncr: 42.123, total_ncr_bs: 1684.92 }], isLoading: false }
      }
      return { data: [{}], isLoading: false }
    }) as unknown as typeof useQuery)

    const { result } = renderHook(() => useTotalesFiscales(filters))

    expect(result.current.totales.totalNcrUsd).toBe(42.12)
    expect(result.current.totales.totalNcrBs).toBe(1684.92)
  })
})

describe('useReintegrosPorMetodo — nuevo hook (task 5.3/5.6)', () => {
  it('consulta movimientos_metodo_cobro JOIN notas_credito filtrando origen=NCR, session-scoped, y aisla por empresa_id', () => {
    setUser()
    const filters = filtersConSesion(['sesion-1'])
    mockedUseQuery.mockReturnValue({ data: [], isLoading: false } as never)

    renderHook(() => useReintegrosPorMetodo(filters))

    const [sql, params] = mockedUseQuery.mock.calls[0]
    expect(sql).toContain('FROM movimientos_metodo_cobro')
    expect(sql).toContain('JOIN notas_credito')
    expect(sql).toContain("origen = 'NCR'")
    expect(sql).toContain('sesion_caja_id IN')
    expect(sql).toContain('GROUP BY')
    expect(params).toContain(EMPRESA_ID)
  })

  it('mapea nro_ncr, metodo y montos desde las filas — surfaces nro_ncr para trazabilidad', () => {
    setUser()
    const filters = filtersConSesion(['sesion-1'])
    mockedUseQuery.mockReturnValue({
      data: [
        { metodo_cobro_id: 'metodo-1', metodo_nombre: 'Efectivo USD', moneda: 'USD', total_usd: 10, total_original: 10, nro_ncr: 'NCR-000001' },
      ],
      isLoading: false,
    } as never)

    const { result } = renderHook(() => useReintegrosPorMetodo(filters))

    expect(result.current.reintegros).toEqual([
      { metodoCobroId: 'metodo-1', metodoNombre: 'Efectivo USD', moneda: 'USD', totalUsd: 10, totalOriginal: 10, nroNcr: 'NCR-000001' },
    ])
  })

  it('task 5.10 — un NC con 2 targets de dinero (2 metodos distintos) produce >1 fila, ambas comparten el mismo nro_ncr (GROUP BY ya lo soporta, sin cambio de codigo)', () => {
    setUser()
    const filters = filtersConSesion(['sesion-1'])
    mockedUseQuery.mockReturnValue({
      data: [
        { metodo_cobro_id: 'metodo-bs', metodo_nombre: 'Efectivo Bs', moneda: 'BS', total_usd: 5, total_original: 200, nro_ncr: 'NCR-000002' },
        { metodo_cobro_id: 'metodo-usd', metodo_nombre: 'Efectivo USD', moneda: 'USD', total_usd: 3, total_original: 3, nro_ncr: 'NCR-000002' },
      ],
      isLoading: false,
    } as never)

    const { result } = renderHook(() => useReintegrosPorMetodo(filters))

    expect(result.current.reintegros).toHaveLength(2)
    expect(result.current.reintegros.every((r) => r.nroNcr === 'NCR-000002')).toBe(true)
  })

  it('sin filtros: no ejecuta query (sql vacio) y retorna lista vacia', () => {
    setUser()
    mockedUseQuery.mockImplementation(((sql: string) => (sql ? { data: [{ nro_ncr: 'x' }], isLoading: false } : { data: [], isLoading: false })) as unknown as typeof useQuery)

    const { result } = renderHook(() => useReintegrosPorMetodo(null))

    expect(result.current.reintegros).toEqual([])
  })
})

describe('useNotasCreditoDeSesion — nuevo hook (task 5.4/5.7)', () => {
  it('consulta notas_credito JOIN ventas, session-scoped via buildCuadreWhere', () => {
    setUser()
    const filters = filtersConSesion(['sesion-1'])
    mockedUseQuery.mockReturnValue({ data: [], isLoading: false } as never)

    renderHook(() => useNotasCreditoDeSesion(filters))

    const [sql, params] = mockedUseQuery.mock.calls[0]
    expect(sql).toContain('FROM notas_credito')
    expect(sql).toContain('JOIN ventas')
    expect(sql).toContain('sesion_caja_id IN')
    expect(params).toEqual([EMPRESA_ID, 'sesion-1'])
  })

  it('surfaces el tipo de la venta original (v.tipo) para el split contado/credito', () => {
    setUser()
    const filters = filtersConSesion(['sesion-1'])
    mockedUseQuery.mockReturnValue({
      data: [
        { id: 'ncr-1', nro_ncr: 'NCR-000001', venta_id: 'venta-1', tipo: 'TOTAL', total_usd: 10, total_bs: 400, fecha: '2026-09-06T10:00:00Z', nro_factura: 'F-001', tipo_venta: 'CONTADO', cliente_nombre: 'Juan Perez' },
        { id: 'ncr-2', nro_ncr: 'NCR-000002', venta_id: 'venta-2', tipo: 'PARCIAL', total_usd: 5, total_bs: 200, fecha: '2026-09-06T11:00:00Z', nro_factura: 'F-002', tipo_venta: 'CREDITO', cliente_nombre: 'Maria Lopez' },
      ],
      isLoading: false,
    } as never)

    const { result } = renderHook(() => useNotasCreditoDeSesion(filters))

    expect(result.current.notas).toHaveLength(2)
    expect(result.current.notas[0].tipoVenta).toBe('CONTADO')
    expect(result.current.notas[1].tipoVenta).toBe('CREDITO')
  })

  it('sin filtros: no ejecuta query (sql vacio) y retorna lista vacia', () => {
    setUser()
    mockedUseQuery.mockImplementation(((sql: string) => (sql ? { data: [{ nro_ncr: 'x' }], isLoading: false } : { data: [], isLoading: false })) as unknown as typeof useQuery)

    const { result } = renderHook(() => useNotasCreditoDeSesion(null))

    expect(result.current.notas).toEqual([])
  })
})

describe('useSaldoEfectivoBimonetario — regresion (task 5.9): sigue neteando egresos NCR correctamente (sin cambio de codigo)', () => {
  it('un egreso NCR de USD 30 (incluido en total_egr via mmc.origen NOT IN VENTA/COBRO/PROPINA) reduce el saldo esperado USD', () => {
    setUser()
    const filters = filtersConSesion(['sesion-1'])

    mockedUseQuery.mockImplementation(((sql: string) => {
      if (sql.includes('monto_apertura_usd')) return { data: [{ usd: 100, bs: 0 }], isLoading: false }
      if (sql.includes("mo.codigo_iso = 'USD'") && sql.includes('FROM pagos')) return { data: [{ total: 50 }], isLoading: false }
      if (sql.includes("mo.codigo_iso = 'VES'") && sql.includes('FROM pagos')) return { data: [{ total: 0 }], isLoading: false }
      if (sql.includes("mo.codigo_iso = 'USD'") && sql.includes('movimientos_metodo_cobro')) {
        // total_egr=30 simula el egreso NCR (origen='NCR' pasa el filtro NOT IN VENTA/COBRO/PROPINA)
        return { data: [{ total_ing: 0, total_egr: 30 }], isLoading: false }
      }
      if (sql.includes("mo.codigo_iso = 'VES'") && sql.includes('movimientos_metodo_cobro')) {
        return { data: [{ total_ing: 0, total_egr: 0 }], isLoading: false }
      }
      return { data: [], isLoading: false }
    }) as unknown as typeof useQuery)

    const { result } = renderHook(() => useSaldoEfectivoBimonetario(filters))

    // 100 (apertura) + 50 (pagos efectivo) + 0 (ingresos) - 30 (egreso NCR) = 120
    expect(result.current.saldoEsperadoUsd).toBe(120)
  })
})
