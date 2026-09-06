import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CrearNcrModal } from '../crear-ncr-modal'
import { crearNotaCredito, useReversosFactura, type FacturaParaAnular } from '../../hooks/use-notas-credito'
import { useDetalleFactura, usePagosFactura } from '@/features/cxc/hooks/use-cxc'
import { useCompany } from '@/features/configuracion/hooks/use-company'
import { useCurrentUser } from '@/core/hooks/use-current-user'
import { useDepositosVentaActivos, type Deposito } from '@/features/inventario/hooks/use-depositos'
import { useMetodosPagoActivos } from '@/features/configuracion/hooks/use-payment-methods'
import { useCuentasTesoreria } from '@/features/tesoreria/hooks/use-cuentas-tesoreria'
import { useSesionesActivasDashboard } from '@/features/caja/hooks/use-sesiones-caja'
import { toast } from 'sonner'

/**
 * Slice D (notas-credito-ruta-administrativa, Design §Decision 2/5/6):
 * reescritura completa de `CrearNcrModal` como wrapper delgado de la ruta
 * administrativa "Facturas emitidas" — reusa la MISMA capa pura de
 * `notas-credito-ui-pos` (FacturaDetallePanel, SeleccionLineasNc,
 * puedeEmitirNcAdicional/puedeElegirTipoTotal) que `nota-credito-pos-modal.tsx`
 * ya usa, SIN tocar ese archivo (FROZEN) ni generalizarlo con un flag
 * POS/ADMIN. Mockeamos `SupervisorPinDialog` para detectar sin ambiguedad si
 * el componente todavia intenta abrir un dialogo de PIN — no debe existir
 * ninguna referencia a el en este modal (a diferencia de POS).
 */
vi.mock('@/components/ui/supervisor-pin-dialog', () => ({
  SupervisorPinDialog: ({ isOpen, titulo }: { isOpen: boolean; titulo?: string }) =>
    isOpen ? <div data-testid="mock-pin-dialog">{titulo ?? 'PIN de supervisor'}</div> : null,
}))

vi.mock('@/features/ventas/hooks/use-notas-credito', () => ({
  crearNotaCredito: vi.fn(),
  useReversosFactura: vi.fn(),
}))
vi.mock('@/features/cxc/hooks/use-cxc', () => ({
  useDetalleFactura: vi.fn(),
  usePagosFactura: vi.fn(),
}))
vi.mock('@/features/configuracion/hooks/use-company', () => ({ useCompany: vi.fn() }))
vi.mock('@/core/hooks/use-current-user', () => ({ useCurrentUser: vi.fn() }))
vi.mock('@/features/inventario/hooks/use-depositos', () => ({ useDepositosVentaActivos: vi.fn() }))
vi.mock('@/features/configuracion/hooks/use-payment-methods', () => ({ useMetodosPagoActivos: vi.fn() }))
vi.mock('@/features/tesoreria/hooks/use-cuentas-tesoreria', () => ({ useCuentasTesoreria: vi.fn() }))
vi.mock('@/features/caja/hooks/use-sesiones-caja', () => ({ useSesionesActivasDashboard: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const mockedCrearNotaCredito = vi.mocked(crearNotaCredito)
const mockedUseReversosFactura = vi.mocked(useReversosFactura)
const mockedUseDetalleFactura = vi.mocked(useDetalleFactura)
const mockedUsePagosFactura = vi.mocked(usePagosFactura)
const mockedUseCompany = vi.mocked(useCompany)
const mockedUseCurrentUser = vi.mocked(useCurrentUser)
const mockedUseDepositosVentaActivos = vi.mocked(useDepositosVentaActivos)
const mockedToastSuccess = vi.mocked(toast.success)
const mockedUseMetodosPagoActivos = vi.mocked(useMetodosPagoActivos)
const mockedUseCuentasTesoreria = vi.mocked(useCuentasTesoreria)
const mockedUseSesionesActivasDashboard = vi.mocked(useSesionesActivasDashboard)

function baseFactura(overrides: Partial<FacturaParaAnular> = {}): FacturaParaAnular {
  return {
    id: 'venta-1',
    nro_factura: 'FAC-000123',
    cliente_id: 'cli-1',
    cliente_nombre: 'Maria Perez',
    cliente_identificacion: 'V-12345678',
    tasa: '36.50',
    total_usd: '10.00',
    total_bs: '365.00',
    saldo_pend_usd: '0.00',
    tipo: 'CONTADO',
    fecha: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function baseDepositos(): Deposito[] {
  return [
    {
      id: 'dep-1', empresa_id: 'emp-1', nombre: 'Principal', direccion: null,
      es_principal: 1, permite_venta: 1, is_active: 1,
      created_at: '2026-01-01', updated_at: '2026-01-01', created_by: null, updated_by: null,
    },
    {
      id: 'dep-2', empresa_id: 'emp-1', nombre: 'Sucursal', direccion: null,
      es_principal: 0, permite_venta: 1, is_active: 1,
      created_at: '2026-01-01', updated_at: '2026-01-01', created_by: null, updated_by: null,
    },
  ]
}

function detalleUnaLinea() {
  return [
    {
      id: 'vd-1', venta_id: 'venta-1', producto_id: 'p1', cantidad: '5',
      precio_unitario_usd: '10.00', subtotal_usd: '50.00', subtotal_bs: '1825.00',
      producto_nombre: 'Botox 50U', producto_codigo: 'P001',
      tipo_impuesto: 'Gravable', impuesto_pct: '16', es_decimal: 0, precio_unitario_bs: '365.00',
    },
  ]
}

function setup() {
  mockedUseDetalleFactura.mockReturnValue({ detalle: [], isLoading: false })
  mockedUsePagosFactura.mockReturnValue({ pagos: [], isLoading: false })
  mockedUseReversosFactura.mockReturnValue({ reversos: [], isLoading: false })
  mockedUseCompany.mockReturnValue({
    company: { id: 'emp-1', nombre: 'ClaraPOS Estetica C.A.', rif: 'J-12345678-9', direccion: null } as never,
    isLoading: false,
  })
  mockedUseCurrentUser.mockReturnValue({
    user: { id: 'user-1', email: 'a@a.com', nombre: 'Admin', level: 1, rol_id: 'rol-1', rol_nombre: 'Propietario', empresa_id: 'emp-1' },
    loading: false,
  })
  mockedUseDepositosVentaActivos.mockReturnValue({ depositos: baseDepositos(), isLoading: false })
  mockedCrearNotaCredito.mockResolvedValue({ ncrId: 'ncr-1', nroNcr: 'NCR-000001' })
  mockedUseMetodosPagoActivos.mockReturnValue({
    metodos: [
      { id: 'metodo-usd-1', nombre: 'Efectivo USD', tipo: 'EFECTIVO', moneda_id: 'mon-usd', moneda: 'USD', banco_empresa_id: null, banco_nombre: null, caja_fuerte_id: null, caja_nombre: null, requiere_referencia: 0, saldo_actual: '500.00', is_active: 1, empresa_id: 'emp-1', created_at: '2026-01-01', deposito_directo: 0, comision_pct: '0', usa_pos: 1, usa_cxc: 0, usa_cxp: 0, consolidar_lotes: 0 },
      { id: 'metodo-bs-1', nombre: 'Efectivo Bs', tipo: 'EFECTIVO', moneda_id: 'mon-bs', moneda: 'BS', banco_empresa_id: null, banco_nombre: null, caja_fuerte_id: null, caja_nombre: null, requiere_referencia: 0, saldo_actual: '20000.00', is_active: 1, empresa_id: 'emp-1', created_at: '2026-01-01', deposito_directo: 0, comision_pct: '0', usa_pos: 1, usa_cxc: 0, usa_cxp: 0, consolidar_lotes: 0 },
    ] as never,
    isLoading: false,
  })
  mockedUseCuentasTesoreria.mockReturnValue({
    cuentas: [
      { id: 'caja-1', tipo: 'CAJA_FUERTE', nombre: 'Caja Fuerte Principal', moneda_id: 'mon-usd', moneda_codigo: 'USD', moneda_simbolo: '$', saldo_actual: '1000.00', is_active: true, detalle: {} as never },
      { id: 'banco-1', tipo: 'BANCO', nombre: 'Banesco', moneda_id: 'mon-bs', moneda_codigo: 'VES', moneda_simbolo: 'Bs', saldo_actual: '50000.00', is_active: true, detalle: {} as never },
    ],
    bancos: [],
    cajas: [],
    isLoading: false,
  })
  mockedUseSesionesActivasDashboard.mockReturnValue({
    sesiones: [
      { id: 'sesion-a', empresa_id: 'emp-1', caja_id: 'caja-a', caja_nombre: 'Caja 1', cajera_nombre: 'Maria', fecha_apertura: '2026-01-01T00:00:00Z', monto_apertura_usd: '0', monto_apertura_bs: '0', saldoUsd: 0, saldoBs: 0, totalFacturas: 0, totalFacturadoUsd: 0, totalArticulos: 0, horasTranscurridas: 1, factHora: 0, itemsHora: 0, atv: 0, upt: 0, score: 100 },
    ] as never,
    isLoading: false,
    soloUna: true,
  } as never)
}

/**
 * Slice 4 (notas-credito-cuadre-origen-dinero): "Devolver dinero" ahora
 * exige llenar el picker multi-origen antes de poder confirmar. Helper
 * compartido — cubre exactamente el remanente de `baseFactura()`
 * (`total_usd: '10.00'`, `saldo_pend_usd: '0.00'`).
 */
async function llenarOrigenDineroValido(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Agregar origen/i }))
  await user.selectOptions(screen.getByLabelText('Tipo de origen'), 'SESION_EFECTIVO')
  await user.selectOptions(screen.getByLabelText('Cuenta'), 'metodo-usd-1')
  await user.type(screen.getByRole('spinbutton'), '10')
  await user.selectOptions(screen.getByLabelText(/sesion destino/i), 'sesion-a')
}

describe('CrearNcrModal (ruta administrativa, Slice D) — sin PIN, reversa cualquier factura', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setup()
  })

  it('nunca monta SupervisorPinDialog, ni antes ni despues de confirmar', async () => {
    const user = userEvent.setup()
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    expect(screen.queryByTestId('mock-pin-dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('mock-pin-dialog')).not.toBeInTheDocument()
  })

  it('confirmar TOTAL emite directo con entryPoint TRADICIONAL, modalidad AJUSTE_CXC y tipo TOTAL', async () => {
    const user = userEvent.setup()
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito.mock.calls[0][0]).toMatchObject({
      venta_id: 'venta-1',
      entryPoint: 'TRADICIONAL',
      modalidad: 'AJUSTE_CXC',
      tipo: 'TOTAL',
    })
    expect(mockedToastSuccess).toHaveBeenCalledWith(expect.stringContaining('NCR-000001'))
  })

  it('ofrece elegir TOTAL o PARCIAL tras abrir con una factura sin reversos previos', () => {
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    expect(screen.getByRole('button', { name: 'Total' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Parcial' })).toBeInTheDocument()
  })

  it('elegir Parcial reemplaza el footer TOTAL por SeleccionLineasNc y NO llama crearNotaCredito todavia', async () => {
    const user = userEvent.setup()
    mockedUseDetalleFactura.mockReturnValue({ detalle: detalleUnaLinea(), isLoading: false })
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    await user.click(screen.getByRole('button', { name: 'Parcial' }))

    expect(screen.queryByRole('button', { name: /Confirmar Anulacion/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirmar Nota de Credito Parcial/i })).toBeInTheDocument()
    expect(mockedCrearNotaCredito).not.toHaveBeenCalled()
  })

  it('confirmar PARCIAL invoca crearNotaCredito con tipo PARCIAL y las lineas seleccionadas', async () => {
    const user = userEvent.setup()
    mockedUseDetalleFactura.mockReturnValue({ detalle: detalleUnaLinea(), isLoading: false })
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    await user.click(screen.getByRole('button', { name: 'Parcial' }))
    await user.type(screen.getByRole('spinbutton'), '2')
    await user.click(screen.getByRole('button', { name: /Confirmar Nota de Credito Parcial/i }))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito.mock.calls[0][0]).toMatchObject({
      venta_id: 'venta-1',
      entryPoint: 'TRADICIONAL',
      modalidad: 'AJUSTE_CXC',
      tipo: 'PARCIAL',
      lineas: [{ venta_det_id: 'vd-1', cantidadDevolver: '2.000' }],
    })
  })

  it('el boton PARCIAL queda deshabilitado con todas las lineas en 0', async () => {
    mockedUseDetalleFactura.mockReturnValue({ detalle: detalleUnaLinea(), isLoading: false })
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Parcial' }))

    expect(screen.getByRole('button', { name: /Confirmar Nota de Credito Parcial/i })).toBeDisabled()
  })

  it('reversa una factura fuera de cualquier sesion de caja (no exige sesion, a diferencia del flujo POS)', async () => {
    const user = userEvent.setup()
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito.mock.calls[0][0]).not.toHaveProperty('sesionCajaActivaId')
  })

  it('Slice 4: "Devolver dinero" esta HABILITADA (ya no es un placeholder) — al elegirla se ofrece el picker multi-origen', async () => {
    const user = userEvent.setup()
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    const devolverDinero = screen.getByRole('button', { name: /Devolver dinero/i })
    expect(devolverDinero).toBeEnabled()
    expect(screen.queryByText(/Proximamente/i)).not.toBeInTheDocument()

    await user.click(devolverDinero)

    expect(screen.getByRole('button', { name: /Agregar origen/i })).toBeInTheDocument()
    expect(mockedCrearNotaCredito).not.toHaveBeenCalled()
  })

  it('Slice 4: "Devolver dinero" sin completar el picker bloquea "Confirmar Anulacion"', async () => {
    const user = userEvent.setup()
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    await user.click(screen.getByRole('button', { name: /Devolver dinero/i }))

    expect(screen.getByRole('button', { name: /Confirmar Anulacion/i })).toBeDisabled()
  })

  it('Slice 4: completar el picker + elegir sesion destino habilita el submit y emite modalidad EFECTIVO_REAL con origenDinero y sesionDestinoId', async () => {
    const user = userEvent.setup()
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    await user.click(screen.getByRole('button', { name: /Devolver dinero/i }))
    await llenarOrigenDineroValido(user)

    expect(screen.getByRole('button', { name: /Confirmar Anulacion/i })).not.toBeDisabled()
    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito.mock.calls[0][0]).toMatchObject({
      entryPoint: 'TRADICIONAL',
      modalidad: 'EFECTIVO_REAL',
      sesionDestinoId: 'sesion-a',
      origenDinero: [{ tipo: 'SESION_EFECTIVO', cuentaId: 'metodo-usd-1', monto: '10' }],
    })
  })

  it('Slice 4: el selector de sesion destino ofrece TODAS las sesiones activas de la empresa (empresa-wide, Decision 4/5)', async () => {
    const user = userEvent.setup()
    mockedUseSesionesActivasDashboard.mockReturnValue({
      sesiones: [
        { id: 'sesion-a', empresa_id: 'emp-1', caja_id: 'caja-a', caja_nombre: 'Caja 1', cajera_nombre: 'Maria', fecha_apertura: '2026-01-01T00:00:00Z', monto_apertura_usd: '0', monto_apertura_bs: '0', saldoUsd: 0, saldoBs: 0, totalFacturas: 0, totalFacturadoUsd: 0, totalArticulos: 0, horasTranscurridas: 1, factHora: 0, itemsHora: 0, atv: 0, upt: 0, score: 100 },
        { id: 'sesion-b', empresa_id: 'emp-1', caja_id: 'caja-b', caja_nombre: 'Caja 2', cajera_nombre: 'Juan', fecha_apertura: '2026-01-01T00:00:00Z', monto_apertura_usd: '0', monto_apertura_bs: '0', saldoUsd: 0, saldoBs: 0, totalFacturas: 0, totalFacturadoUsd: 0, totalArticulos: 0, horasTranscurridas: 1, factHora: 0, itemsHora: 0, atv: 0, upt: 0, score: 100 },
      ] as never,
      isLoading: false,
      soloUna: false,
    } as never)
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    await user.click(screen.getByRole('button', { name: /Devolver dinero/i }))
    await user.click(screen.getByRole('button', { name: /Agregar origen/i }))
    await user.selectOptions(screen.getByLabelText('Tipo de origen'), 'SESION_EFECTIVO')

    expect(screen.getByRole('option', { name: /Caja 1.*Maria/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Caja 2.*Juan/i })).toBeInTheDocument()
  })

  it('Slice 4: elegir "Credito a favor" luego de haber elegido "Devolver dinero" oculta el picker y vuelve a AJUSTE_CXC', async () => {
    const user = userEvent.setup()
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    await user.click(screen.getByRole('button', { name: /Devolver dinero/i }))
    expect(screen.getByRole('button', { name: /Agregar origen/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Credito a favor/i }))
    expect(screen.queryByRole('button', { name: /Agregar origen/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))
    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito.mock.calls[0][0].modalidad).toBe('AJUSTE_CXC')
  })

  it('Slice 4 (FLIP — antes "Credito a favor" era la unica opcion seleccionable, "Devolver dinero" era un shell deshabilitado): ambas opciones estan habilitadas, "Credito a favor" sigue siendo el default activo', () => {
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    const creditoAFavor = screen.getByRole('button', { name: /Credito a favor/i })
    const devolverDinero = screen.getByRole('button', { name: /Devolver dinero/i })
    expect(creditoAFavor).toBeEnabled()
    expect(creditoAFavor).toHaveAttribute('aria-pressed', 'true')
    expect(devolverDinero).toBeEnabled()
  })

  it('emision siempre resulta en modalidad AJUSTE_CXC sin importar el estado del selector', async () => {
    const user = userEvent.setup()
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    await user.click(screen.getByRole('button', { name: /Credito a favor/i }))
    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito.mock.calls[0][0].modalidad).toBe('AJUSTE_CXC')
  })

  it('una factura ya reversada totalmente (gating via puedeEmitirNcAdicional) queda de solo lectura, sin ofrecer TOTAL/PARCIAL ni "Confirmar Anulacion"', () => {
    mockedUseDetalleFactura.mockReturnValue({ detalle: detalleUnaLinea(), isLoading: false })
    mockedUseReversosFactura.mockReturnValue({
      reversos: [
        { nota_credito_id: 'nc-1', nro_ncr: 'NCR-000000', tipo: 'TOTAL', fecha: '2026-01-01T00:00:00Z', venta_det_id: 'vd-1', producto_descripcion: 'Botox 50U', cantidad: '5.000' },
      ],
      isLoading: false,
    })
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    expect(screen.queryByRole('button', { name: 'Total' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Parcial' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Confirmar Anulacion/i })).not.toBeInTheDocument()
    expect(screen.getByText(/ya fue reversada totalmente/i)).toBeInTheDocument()
  })

  it('una factura con reverso parcial previo ya no ofrece TOTAL, solo PARCIAL sobre el remanente (puedeElegirTipoTotal)', () => {
    mockedUseDetalleFactura.mockReturnValue({ detalle: detalleUnaLinea(), isLoading: false })
    mockedUseReversosFactura.mockReturnValue({
      reversos: [
        { nota_credito_id: 'nc-0', nro_ncr: 'NCR-000000', tipo: 'PARCIAL', fecha: '2026-01-01T00:00:00Z', venta_det_id: 'vd-1', producto_descripcion: 'Botox 50U', cantidad: '2.000' },
      ],
      isLoading: false,
    })
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    expect(screen.queryByRole('button', { name: 'Total' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirmar Nota de Credito Parcial/i })).toBeInTheDocument()
  })

  it('el selector de deposito esta desbloqueado desde el inicio, sin boton "Cambiar deposito", y su eleccion se threadea a depositoReingresoId', async () => {
    const user = userEvent.setup()
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    expect(screen.queryByRole('button', { name: /Cambiar deposito/i })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox'), 'dep-2')
    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito.mock.calls[0][0]).toMatchObject({ depositoReingresoId: 'dep-2' })
  })

  it('sin elegir deposito: depositoReingresoId es undefined (cae al riel automatico)', async () => {
    const user = userEvent.setup()
    render(<CrearNcrModal isOpen onClose={() => {}} factura={baseFactura()} />)

    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito.mock.calls[0][0].depositoReingresoId).toBeUndefined()
  })

  it('al confirmar exitosamente, cierra el modal (onClose)', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<CrearNcrModal isOpen onClose={onClose} factura={baseFactura()} />)

    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})
