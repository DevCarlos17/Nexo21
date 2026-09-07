// Slice C3b (notas-credito-ruta-administrativa): NotasCreditoTab gana
// filtros ampliados (fecha, nro NC, tipo TOTAL/PARCIAL, cliente, RIF) sobre
// `useNotasCredito(filtros)` + boton "Ver todo el historial" (Design §Riesgos:
// mitigacion del cambio de default a mes actual). El buscador de facturas
// (`useBuscarFacturaParaAnular`) y el modal se retiran de esta pestana: la
// pestana Facturas (empresa-wide) ahora es el unico punto de entrada para
// seleccionar una factura y aplicar NC (Design §Decision 7 — dead code).
vi.mock('../../hooks/use-notas-credito', () => ({ useNotasCredito: vi.fn() }))

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useNotasCredito } from '../../hooks/use-notas-credito'
import { NotasCreditoTab } from '../notas-credito-tab'
import type { NotaCreditoRow } from '../../hooks/use-notas-credito'

const mockedUseNotasCredito = vi.mocked(useNotasCredito)

function nota(overrides: Partial<NotaCreditoRow> = {}): NotaCreditoRow {
  return {
    id: 'nc-1',
    nro_ncr: 'NCR-000001',
    venta_id: 'venta-1',
    cliente_id: 'cli-1',
    tipo: 'TOTAL',
    motivo: 'Anulacion total de factura',
    tasa_historica: '36.50',
    total_usd: '100.00',
    total_bs: '3650.00',
    fecha: '2026-05-10T10:00:00-04:00',
    nro_factura: 'C01-000001',
    cliente_nombre: 'Maria Perez',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedUseNotasCredito.mockReturnValue({ notas: [], isLoading: false })
})

describe('NotasCreditoTab (Slice C3b) — filtros ampliados sobre useNotasCredito(filtros)', () => {
  it('renderiza las NC devueltas por useNotasCredito', () => {
    mockedUseNotasCredito.mockReturnValue({ notas: [nota()], isLoading: false })

    render(<NotasCreditoTab />)

    expect(screen.getByText('NCR-000001')).toBeInTheDocument()
    expect(screen.getByText('$100.00')).toBeInTheDocument()
  })

  it('carga inicial: aplica rangoMesActual() por defecto (mes actual) al hook', () => {
    vi.setSystemTime(new Date('2026-05-21T12:00:00'))

    render(<NotasCreditoTab />)

    expect(mockedUseNotasCredito).toHaveBeenCalledWith(
      expect.objectContaining({ fechaDesde: '2026-05-01', fechaHasta: '2026-05-21' })
    )
    vi.useRealTimers()
  })

  it('Slice E.2: input de busqueda UNIFICADO (unico) actualiza el argumento `busqueda` pasado al hook', async () => {
    const user = userEvent.setup()
    render(<NotasCreditoTab />)

    await user.type(screen.getByLabelText(/buscar/i), 'NCR-000012')

    await waitFor(() => {
      expect(mockedUseNotasCredito).toHaveBeenLastCalledWith(
        expect.objectContaining({ busqueda: 'NCR-000012' })
      )
    })
  })

  it('Slice E.2: los 3 inputs separados (nro NC, cliente, RIF) YA NO existen', () => {
    render(<NotasCreditoTab />)
    expect(screen.queryByLabelText(/nro nc/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^cliente$/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^rif$/i)).not.toBeInTheDocument()
  })

  it('Slice E.4: el filtro "Tipo" YA NO existe (reemplazado por el selector de Estado)', () => {
    render(<NotasCreditoTab />)
    expect(screen.queryByLabelText(/^tipo$/i)).not.toBeInTheDocument()
  })

  it('Slice E.b (tester QA feedback): el selector de Estado YA NO existe en la pestaña NC — se retiro por completo, sin fold en la busqueda', () => {
    render(<NotasCreditoTab />)
    expect(screen.queryByLabelText(/^estado$/i)).not.toBeInTheDocument()
  })

  it('Slice E.4: el boton "Ver todo el historial" YA NO existe — el rango de fecha es el UNICO control de amplitud', () => {
    render(<NotasCreditoTab />)
    expect(screen.queryByRole('button', { name: /ver todo el historial/i })).not.toBeInTheDocument()
  })

  it('estado vacio: sin NC, sin error, muestra mensaje explicito', () => {
    render(<NotasCreditoTab />)
    expect(screen.getByText(/no hay notas de credito/i)).toBeInTheDocument()
  })

  it('ya NO monta el buscador de facturas (useBuscarFacturaParaAnular retirado en este slice)', () => {
    render(<NotasCreditoTab />)
    expect(screen.queryByPlaceholderText(/buscar factura por numero/i)).not.toBeInTheDocument()
  })
})
