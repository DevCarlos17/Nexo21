// Slice 5 (notas-credito-cuadre-origen-dinero): componente nuevo que refleja
// el motor de dinero de las NC en el cuadre (efectos #2 y #3 del design).
// Mockeamos SOLO los 2 hooks de datos que consume (mock hygiene: 2 mocks) —
// el componente es puro presentacional sobre esos hooks.
vi.mock('../../hooks/use-cuadre', () => ({
  useReintegrosPorMetodo: vi.fn(),
  useNotasCreditoDeSesion: vi.fn(),
}))

import { render, screen } from '@testing-library/react'
import { CuadreNotasCredito } from '../cuadre-notas-credito'
import { useReintegrosPorMetodo, useNotasCreditoDeSesion } from '../../hooks/use-cuadre'
import type { CuadreFilters } from '../../hooks/use-cuadre'

const mockedUseReintegros = vi.mocked(useReintegrosPorMetodo)
const mockedUseNotas = vi.mocked(useNotasCreditoDeSesion)

const filters: CuadreFilters = { fecha: '2026-09-06', cajaId: 'caja-1', sesionCajaIds: ['sesion-1'] }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('CuadreNotasCredito — Slice 5 (task 5.8)', () => {
  it('mientras carga: no renderiza las tablas de datos', () => {
    mockedUseReintegros.mockReturnValue({ reintegros: [], isLoading: true })
    mockedUseNotas.mockReturnValue({ notas: [], isLoading: true })

    render(<CuadreNotasCredito filters={filters} />)

    expect(screen.queryAllByRole('table')).toHaveLength(0)
  })

  it('sin datos: muestra los mensajes de estado vacio para ambas secciones', () => {
    mockedUseReintegros.mockReturnValue({ reintegros: [], isLoading: false })
    mockedUseNotas.mockReturnValue({ notas: [], isLoading: false })

    render(<CuadreNotasCredito filters={filters} />)

    expect(screen.getByText(/Sin reintegros de notas de credito/i)).toBeInTheDocument()
    expect(screen.getByText(/Sin notas de credito en este periodo/i)).toBeInTheDocument()
  })

  it('con reintegros: muestra el nro_ncr y el metodo para trazabilidad', () => {
    mockedUseReintegros.mockReturnValue({
      reintegros: [
        { metodoCobroId: 'm-1', metodoNombre: 'Efectivo Bs', moneda: 'BS', totalUsd: 5, totalOriginal: 200, nroNcr: 'NCR-000002' },
        { metodoCobroId: 'm-2', metodoNombre: 'Efectivo USD', moneda: 'USD', totalUsd: 3, totalOriginal: 3, nroNcr: 'NCR-000002' },
      ],
      isLoading: false,
    })
    mockedUseNotas.mockReturnValue({ notas: [], isLoading: false })

    render(<CuadreNotasCredito filters={filters} />)

    const ncrCells = screen.getAllByText('NCR-000002')
    expect(ncrCells).toHaveLength(2)
    expect(screen.getByText('Efectivo Bs')).toBeInTheDocument()
    expect(screen.getByText('Efectivo USD')).toBeInTheDocument()
  })

  it('con notas de credito: muestra el split contado/credito segun el tipo de la venta original', () => {
    mockedUseReintegros.mockReturnValue({ reintegros: [], isLoading: false })
    mockedUseNotas.mockReturnValue({
      notas: [
        { id: 'ncr-1', nroNcr: 'NCR-000001', ventaId: 'v-1', tipo: 'TOTAL', totalUsd: 10, totalBs: 400, fecha: '2026-09-06T10:00:00Z', nroFactura: 'F-001', tipoVenta: 'CONTADO', clienteNombre: 'Juan Perez' },
        { id: 'ncr-2', nroNcr: 'NCR-000002', ventaId: 'v-2', tipo: 'PARCIAL', totalUsd: 5, totalBs: 200, fecha: '2026-09-06T11:00:00Z', nroFactura: 'F-002', tipoVenta: 'CREDITO', clienteNombre: 'Maria Lopez' },
      ],
      isLoading: false,
    })

    render(<CuadreNotasCredito filters={filters} />)

    expect(screen.getByText('CONTADO')).toBeInTheDocument()
    expect(screen.getByText('CREDITO')).toBeInTheDocument()
    expect(screen.getByText('Juan Perez')).toBeInTheDocument()
    expect(screen.getByText('Maria Lopez')).toBeInTheDocument()
  })
})
