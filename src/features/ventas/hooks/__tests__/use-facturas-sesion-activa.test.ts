// `useFacturasSesionActiva` (Slice 5a-2a) usa `useQuery` de `@powersync/react`
// directamente — mismo patron que `use-deposito-activo.test.ts` (primer
// precedente de hooks puros de `@powersync/react` en el repo).
vi.mock('@powersync/react', () => ({ useQuery: vi.fn() }))
vi.mock('@/core/hooks/use-current-user', () => ({ useCurrentUser: vi.fn() }))
vi.mock('@/features/caja/hooks/use-sesiones-caja', () => ({ useSesionActiva: vi.fn() }))

import { renderHook } from '@testing-library/react'
import { useQuery } from '@powersync/react'
import { useCurrentUser } from '@/core/hooks/use-current-user'
import { useSesionActiva } from '@/features/caja/hooks/use-sesiones-caja'
import { useFacturasSesionActiva, useBadgesReversoSesion } from '../use-facturas-sesion-activa'

const mockedUseQuery = vi.mocked(useQuery)
const mockedUseCurrentUser = vi.mocked(useCurrentUser)
const mockedUseSesionActiva = vi.mocked(useSesionActiva)

function setup(opts: { sesionId?: string | null; rows?: unknown[] }) {
  mockedUseCurrentUser.mockReturnValue({
    user: { id: 'user-1', empresa_id: 'emp-1', email: '', nombre: '', level: 1, rol_id: null, rol_nombre: null },
    loading: false,
  })
  mockedUseSesionActiva.mockReturnValue({
    sesion: (opts.sesionId ? { id: opts.sesionId, caja_id: 'caja-1' } : null) as never,
    isLoading: false,
  })
  mockedUseQuery.mockImplementation(((sql: string) => {
    if (sql.includes('sesion_caja_id')) {
      return { data: opts.rows ?? [], isLoading: false }
    }
    return { data: [], isLoading: false }
  }) as unknown as typeof useQuery)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useFacturasSesionActiva — Slice 5a-2a (Spec notas-credito-pos: alcance limitado a la sesion activa)', () => {
  it('sin sesion activa: no ejecuta la query de facturas (sql vacio) y retorna lista vacia', () => {
    setup({ sesionId: null })

    const { result } = renderHook(() => useFacturasSesionActiva())

    expect(result.current.facturas).toEqual([])
    expect(mockedUseQuery).toHaveBeenCalledWith('', [])
  })

  it('con sesion activa: ejecuta la query escopeada a empresa_id + sesion_caja_id (query-enforced, no solo UI)', () => {
    setup({ sesionId: 'sesion-1', rows: [{ id: 'venta-1', nro_factura: 'C01-000001' }] })

    const { result } = renderHook(() => useFacturasSesionActiva())

    expect(result.current.facturas).toHaveLength(1)
    const [sql, params] = mockedUseQuery.mock.calls[0]
    expect(sql).toContain('sesion_caja_id')
    expect(params).toEqual(['emp-1', 'sesion-1'])
  })

  it('Design §Decision 2: ya NO filtra status != ANULADA — una factura reversada de la sesion activa se sigue trayendo', () => {
    setup({ sesionId: 'sesion-1', rows: [] })

    renderHook(() => useFacturasSesionActiva())

    const [sql] = mockedUseQuery.mock.calls[0]
    expect(sql).not.toContain("status != 'ANULADA'")
  })

  it('Design §Decision 2: agrega tiene_reverso_total/tiene_reverso_parcial (EXISTS sobre notas_credito) y v.status al SELECT', () => {
    setup({ sesionId: 'sesion-1', rows: [] })

    renderHook(() => useFacturasSesionActiva())

    const [sql] = mockedUseQuery.mock.calls[0]
    expect(sql).toContain('tiene_reverso_total')
    expect(sql).toContain('tiene_reverso_parcial')
    expect(sql).toContain("nc.tipo = 'TOTAL'")
    expect(sql).toContain("nc.tipo = 'PARCIAL'")
    expect(sql).toContain('v.status')
  })

  it('Slice 3a: agrega v.total_igtf_usd al SELECT (panel de detalle necesita IGTF de la factura real)', () => {
    setup({ sesionId: 'sesion-1', rows: [] })

    renderHook(() => useFacturasSesionActiva())

    const [sql] = mockedUseQuery.mock.calls[0]
    expect(sql).toContain('v.total_igtf_usd')
  })

  it('venta ANULADA con NC tipo TOTAL: tiene_reverso_total=1 y tiene_reverso_parcial=0 en la fila retornada', () => {
    setup({
      sesionId: 'sesion-1',
      rows: [
        {
          id: 'venta-1',
          nro_factura: 'C01-000001',
          status: 'ANULADA',
          tiene_reverso_total: 1,
          tiene_reverso_parcial: 0,
        },
      ],
    })

    const { result } = renderHook(() => useFacturasSesionActiva())

    expect(result.current.facturas[0]).toMatchObject({
      status: 'ANULADA',
      tiene_reverso_total: 1,
      tiene_reverso_parcial: 0,
    })
  })

  it('venta con NC tipo PARCIAL: tiene_reverso_parcial=1 y tiene_reverso_total=0 en la fila retornada', () => {
    setup({
      sesionId: 'sesion-1',
      rows: [
        {
          id: 'venta-2',
          nro_factura: 'C01-000002',
          status: null,
          tiene_reverso_total: 0,
          tiene_reverso_parcial: 1,
        },
      ],
    })

    const { result } = renderHook(() => useFacturasSesionActiva())

    expect(result.current.facturas[0]).toMatchObject({
      tiene_reverso_total: 0,
      tiene_reverso_parcial: 1,
    })
  })

  it('venta sin NC asociada: ambos flags en 0', () => {
    setup({
      sesionId: 'sesion-1',
      rows: [
        { id: 'venta-3', nro_factura: 'C01-000003', status: null, tiene_reverso_total: 0, tiene_reverso_parcial: 0 },
      ],
    })

    const { result } = renderHook(() => useFacturasSesionActiva())

    expect(result.current.facturas[0]).toMatchObject({ tiene_reverso_total: 0, tiene_reverso_parcial: 0 })
  })

  it('Slice 6 (badge "vía administración"): agrega tiene_reverso_via_administracion (EXISTS sobre notas_credito con entry_point=TRADICIONAL) al SELECT', () => {
    setup({ sesionId: 'sesion-1', rows: [] })

    renderHook(() => useFacturasSesionActiva())

    const [sql] = mockedUseQuery.mock.calls[0]
    expect(sql).toContain('tiene_reverso_via_administracion')
    expect(sql).toContain("nc.entry_point = 'TRADICIONAL'")
  })

  it('Slice 6: venta con una NC entry_point=TRADICIONAL -> tiene_reverso_via_administracion=1 en la fila retornada', () => {
    setup({
      sesionId: 'sesion-1',
      rows: [
        {
          id: 'venta-4',
          nro_factura: 'C01-000004',
          status: null,
          tiene_reverso_total: 1,
          tiene_reverso_parcial: 0,
          tiene_reverso_via_administracion: 1,
        },
      ],
    })

    const { result } = renderHook(() => useFacturasSesionActiva())

    expect(result.current.facturas[0]).toMatchObject({ tiene_reverso_via_administracion: 1 })
  })
})

describe('useBadgesReversoSesion (Slice 5e QA fix 3.5: badge de reverso acumulado por venta_id de la sesion activa)', () => {
  function setupBadges(opts: { lineas?: unknown[]; notas?: unknown[] }) {
    mockedUseQuery.mockImplementation(((sql: string) => {
      if (sql.includes('FROM ventas_det')) return { data: opts.lineas ?? [], isLoading: false }
      if (sql.includes('FROM notas_credito_det')) return { data: opts.notas ?? [], isLoading: false }
      return { data: [], isLoading: false }
    }) as unknown as typeof useQuery)
  }

  it('filtra ambas queries por empresa_id + sesion_caja_id (query-enforced)', () => {
    setupBadges({})

    renderHook(() => useBadgesReversoSesion('emp-1', 'sesion-1'))

    const lineasCall = mockedUseQuery.mock.calls.find(([sql]) => (sql as string).includes('FROM ventas_det'))
    const notasCall = mockedUseQuery.mock.calls.find(([sql]) => (sql as string).includes('FROM notas_credito_det'))
    expect(lineasCall?.[1]).toEqual(['emp-1', 'sesion-1'])
    expect(notasCall?.[1]).toEqual(['emp-1', 'sesion-1'])
  })

  it('sin sesion activa: no ejecuta ninguna query (sql vacio)', () => {
    setupBadges({})

    renderHook(() => useBadgesReversoSesion('emp-1', ''))

    expect(mockedUseQuery).toHaveBeenCalledWith('', [])
  })

  it('dos NCs PARCIALes que juntas reversan el 100% de la unica linea de una venta -> badge TOTAL', () => {
    setupBadges({
      lineas: [{ venta_id: 'venta-1', venta_det_id: 'vd-1', cantidad_facturada: '5' }],
      notas: [
        { venta_det_id: 'vd-1', cantidad: '2' },
        { venta_det_id: 'vd-1', cantidad: '3' },
      ],
    })

    const { result } = renderHook(() => useBadgesReversoSesion('emp-1', 'sesion-1'))

    expect(result.current.badgesPorVenta).toEqual({ 'venta-1': 'TOTAL' })
  })

  it('sin ninguna nota de credito: badgesPorVenta vacio', () => {
    setupBadges({ lineas: [{ venta_id: 'venta-1', venta_det_id: 'vd-1', cantidad_facturada: '5' }], notas: [] })

    const { result } = renderHook(() => useBadgesReversoSesion('emp-1', 'sesion-1'))

    expect(result.current.badgesPorVenta).toEqual({ 'venta-1': null })
  })
})
