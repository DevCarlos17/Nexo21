import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NotasCreditoPage } from '../notas-credito-page'

// Mismo patron que traspasos.test.tsx (design.md §Decision 1): mockeamos los
// dos componentes de pestana para aislar el contenedor de tabs de sus
// dependencias internas de PowerSync/hooks (useFacturasEmpresa,
// useNotasCredito, useBuscarFacturaParaAnular, CrearNcrModal).
vi.mock('../facturas-empresa-tab', () => ({
  FacturasEmpresaTab: () => <div data-testid="facturas-tab-content">Contenido Facturas</div>,
}))
vi.mock('../notas-credito-tab', () => ({
  NotasCreditoTab: () => <div data-testid="notas-credito-tab-content">Contenido Notas de credito</div>,
}))

describe('NotasCreditoPage — pestanas Facturas emitidas (Slice C3a)', () => {
  it('la pestana "Facturas" esta activa por defecto y ambos triggers se renderizan', () => {
    render(<NotasCreditoPage />)

    expect(screen.getByRole('tab', { name: /^facturas$/i })).toHaveAttribute('data-state', 'active')
    expect(screen.getByRole('tab', { name: /notas de credito/i })).toBeInTheDocument()
    expect(screen.getByTestId('facturas-tab-content')).toBeInTheDocument()
  })

  it('al cambiar a "Notas de credito" se renderiza NotasCreditoTab sin perder acceso a Facturas', async () => {
    const user = userEvent.setup()
    render(<NotasCreditoPage />)

    await user.click(screen.getByRole('tab', { name: /notas de credito/i }))

    expect(screen.getByTestId('notas-credito-tab-content')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /^facturas$/i }))

    expect(screen.getByTestId('facturas-tab-content')).toBeInTheDocument()
  })
})
