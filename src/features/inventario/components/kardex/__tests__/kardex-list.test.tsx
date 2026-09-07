import { render, screen, within } from '@testing-library/react'
import { KardexList } from '../kardex-list'
import { useMovimientosFiltrados, useUltimosMovimientosKardex } from '@/features/inventario/hooks/use-kardex'
import { useDepartamentos } from '@/features/inventario/hooks/use-departamentos'
import { useCompany } from '@/features/configuracion/hooks/use-company'

// `KardexList` no hace fetch propio — mockeamos sus 4 hooks de datos
// directamente (mismo patron que movimiento-form.test.tsx) para evitar
// levantar PowerSync real.
vi.mock('@/features/inventario/hooks/use-kardex', () => ({
  useMovimientosFiltrados: vi.fn(),
  useUltimosMovimientosKardex: vi.fn(),
}))
vi.mock('@/features/inventario/hooks/use-departamentos', () => ({ useDepartamentos: vi.fn() }))
vi.mock('@/features/configuracion/hooks/use-company', () => ({ useCompany: vi.fn() }))
vi.mock('../kardex-producto-buscador', () => ({ KardexProductoBuscador: () => null }))

const mockedUseMovimientosFiltrados = vi.mocked(useMovimientosFiltrados)
const mockedUseUltimosMovimientosKardex = vi.mocked(useUltimosMovimientosKardex)
const mockedUseDepartamentos = vi.mocked(useDepartamentos)
const mockedUseCompany = vi.mocked(useCompany)

function movimiento(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'mov-1',
    producto_id: 'prod-1',
    prod_codigo: 'P001',
    prod_nombre: 'Botox 50U',
    departamento_id: 'dep-1',
    tipo: 'E',
    origen: 'NCR',
    tipo_salida: null,
    cantidad: '2.000',
    stock_anterior: '10.000',
    stock_nuevo: '12.000',
    motivo: 'NCR-000001 - Reintegro Botox 50U',
    usuario_id: 'user-1',
    fecha: '2026-01-01T00:00:00Z',
    venta_id: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedUseDepartamentos.mockReturnValue({ departamentos: [], isLoading: false } as never)
  mockedUseCompany.mockReturnValue({ company: null, isLoading: false } as never)
  mockedUseMovimientosFiltrados.mockReturnValue({ movimientos: [], isLoading: false } as never)
})

describe('KardexList — F4 QA fix (Slice 5c): causa de un movimiento con origen NCR (reintegro por Nota de Credito)', () => {
  it('un movimiento con origen="NCR" (reintegro de crearNotaCredito) muestra el badge "Nota de crédito" en la columna Causa, no el fallback "—"', () => {
    mockedUseUltimosMovimientosKardex.mockReturnValue({
      movimientos: [movimiento({ origen: 'NCR', tipo_salida: null })],
      isLoading: false,
    } as never)

    render(<KardexList />)

    const fila = screen.getByText('NCR-000001 - Reintegro Botox 50U').closest('tr')!
    expect(within(fila).getByText('Nota de crédito')).toBeInTheDocument()
    expect(within(fila).queryByText('—')).not.toBeInTheDocument()
  })

  it('un movimiento con origen="VEN" sigue mostrando "Facturación" en la fila (comportamiento pre-existente intacto)', () => {
    mockedUseUltimosMovimientosKardex.mockReturnValue({
      movimientos: [movimiento({ origen: 'VEN', tipo_salida: null })],
      isLoading: false,
    } as never)

    render(<KardexList />)

    const fila = screen.getByText('P001').closest('tr')!
    expect(within(fila).getByText('Facturación')).toBeInTheDocument()
  })

  it('un movimiento sin tipo_salida y sin origen NCR/VEN sigue mostrando el fallback "—" en la fila', () => {
    mockedUseUltimosMovimientosKardex.mockReturnValue({
      movimientos: [movimiento({ origen: 'MAN', tipo_salida: null })],
      isLoading: false,
    } as never)

    render(<KardexList />)

    const fila = screen.getByText('P001').closest('tr')!
    expect(within(fila).getByText('—')).toBeInTheDocument()
  })
})
