import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NotaCreditoPosModal } from '../nota-credito-pos-modal'
import { crearNotaCredito, useReversosFactura } from '../../hooks/use-notas-credito'
import { useFacturasSesionActiva, useBadgesReversoSesion } from '../../hooks/use-facturas-sesion-activa'
import { useDetalleFactura, usePagosFactura } from '@/features/cxc/hooks/use-cxc'
import { useCompany } from '@/features/configuracion/hooks/use-company'
import { useCurrentUser } from '@/core/hooks/use-current-user'
import { usePermissions } from '@/core/hooks/use-permissions'
import { useDepositosVentaActivos } from '@/features/inventario/hooks/use-depositos'
import { useMetodosPagoActivos } from '@/features/configuracion/hooks/use-payment-methods'
import { useCuentasTesoreria } from '@/features/tesoreria/hooks/use-cuentas-tesoreria'
import { toast } from 'sonner'
import type { FacturaParaAnular } from '../../hooks/use-notas-credito'
import type { SesionCaja } from '@/features/caja/hooks/use-sesiones-caja'
import type { Deposito } from '@/features/inventario/hooks/use-depositos'

// PIN A (emision) y PIN B (override de deposito, Slice 5a-2b) son DOS
// autorizaciones separadas (obs #2835/#2842) — mockeamos `SupervisorPinDialog`
// mostrando su `titulo` para poder distinguir CUAL de las dos instancias
// esta abierta en cada assertion (mismo patron que `crear-ncr-modal.test.tsx`,
// extendido con el titulo porque aqui coexisten dos instancias).
vi.mock('@/components/ui/supervisor-pin-dialog', () => ({
  SupervisorPinDialog: ({
    isOpen,
    titulo,
    onAuthorized,
    onClose,
  }: {
    isOpen: boolean
    titulo?: string
    onAuthorized: (id: string) => void
    onClose: () => void
  }) =>
    isOpen ? (
      <div data-testid="mock-pin-dialog">
        <p>{titulo}</p>
        <button
          onClick={() => {
            // Mismo orden que el `SupervisorPinDialog` real: autoriza y
            // luego cierra el dialogo (ver `handleVerificar`).
            onAuthorized('supervisor-1')
            onClose()
          }}
        >
          Autorizar
        </button>
      </div>
    ) : null,
}))

vi.mock('@/features/ventas/hooks/use-notas-credito', () => ({ crearNotaCredito: vi.fn(), useReversosFactura: vi.fn() }))
vi.mock('@/features/ventas/hooks/use-facturas-sesion-activa', () => ({
  useFacturasSesionActiva: vi.fn(),
  useBadgesReversoSesion: vi.fn(),
}))
vi.mock('@/features/cxc/hooks/use-cxc', () => ({
  useDetalleFactura: vi.fn(),
  usePagosFactura: vi.fn(),
}))
vi.mock('@/features/configuracion/hooks/use-company', () => ({ useCompany: vi.fn() }))
vi.mock('@/core/hooks/use-current-user', () => ({ useCurrentUser: vi.fn() }))
vi.mock('@/core/hooks/use-permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/hooks/use-permissions')>()
  return { ...actual, usePermissions: vi.fn() }
})
vi.mock('@/features/inventario/hooks/use-depositos', () => ({ useDepositosVentaActivos: vi.fn() }))
vi.mock('@/features/configuracion/hooks/use-payment-methods', () => ({ useMetodosPagoActivos: vi.fn() }))
vi.mock('@/features/tesoreria/hooks/use-cuentas-tesoreria', () => ({ useCuentasTesoreria: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const mockedCrearNotaCredito = vi.mocked(crearNotaCredito)
const mockedUseReversosFactura = vi.mocked(useReversosFactura)
const mockedUseFacturasSesionActiva = vi.mocked(useFacturasSesionActiva)
const mockedUseBadgesReversoSesion = vi.mocked(useBadgesReversoSesion)
const mockedUseDetalleFactura = vi.mocked(useDetalleFactura)
const mockedUsePagosFactura = vi.mocked(usePagosFactura)
const mockedUseCompany = vi.mocked(useCompany)
const mockedUseCurrentUser = vi.mocked(useCurrentUser)
const mockedUsePermissions = vi.mocked(usePermissions)
const mockedUseDepositosVentaActivos = vi.mocked(useDepositosVentaActivos)
const mockedToastSuccess = vi.mocked(toast.success)
const mockedToastInfo = vi.mocked(toast.info)
const mockedUseMetodosPagoActivos = vi.mocked(useMetodosPagoActivos)
const mockedUseCuentasTesoreria = vi.mocked(useCuentasTesoreria)

function depositoActivo(overrides: Partial<Deposito> = {}): Deposito {
  return {
    id: 'dep-1',
    empresa_id: 'emp-1',
    nombre: 'Deposito Secundario',
    direccion: null,
    es_principal: 0,
    permite_venta: 1,
    is_active: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    created_by: null,
    updated_by: null,
    ...overrides,
  }
}

const sesionActiva: SesionCaja = {
  id: 'sesion-1',
  empresa_id: 'emp-1',
  caja_id: 'caja-1',
  usuario_apertura_id: 'user-1',
  fecha_apertura: '2026-01-01T00:00:00Z',
  monto_apertura_usd: '0',
  monto_apertura_bs: '0',
  usuario_cierre_id: null,
  fecha_cierre: null,
  monto_sistema_usd: null,
  monto_fisico_usd: null,
  diferencia_usd: null,
  monto_sistema_bs: null,
  monto_fisico_bs: null,
  diferencia_bs: null,
  observaciones_cierre: null,
  status: 'ABIERTA',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

function facturaSesion(overrides: Partial<FacturaParaAnular> = {}): FacturaParaAnular {
  return {
    id: 'venta-1',
    nro_factura: 'C01-000001',
    cliente_id: 'cli-1',
    cliente_nombre: 'Maria Perez',
    cliente_identificacion: 'V-12345678',
    tasa: '40',
    total_usd: '30.00',
    total_bs: '1200.00',
    saldo_pend_usd: '0.00',
    tipo: 'CONTADO',
    fecha: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function setup(opts: { hasPermission: boolean }) {
  mockedUseFacturasSesionActiva.mockReturnValue({ facturas: [facturaSesion()], isLoading: false })
  mockedUseBadgesReversoSesion.mockReturnValue({ badgesPorVenta: {}, isLoading: false })
  mockedUseDetalleFactura.mockReturnValue({ detalle: [], isLoading: false })
  mockedUsePagosFactura.mockReturnValue({ pagos: [], isLoading: false })
  mockedUseReversosFactura.mockReturnValue({ reversos: [], isLoading: false })
  mockedUseCompany.mockReturnValue({
    company: { id: 'emp-1', nombre: 'ClaraPOS Estetica C.A.', rif: 'J-12345678-9', direccion: null } as never,
    isLoading: false,
  })
  mockedUseCurrentUser.mockReturnValue({
    user: { id: 'user-1', email: 'a@a.com', nombre: 'Cajero', level: 3, rol_id: 'rol-1', rol_nombre: 'Cajero', empresa_id: 'emp-1' },
    loading: false,
  })
  mockedUsePermissions.mockReturnValue({
    hasPermission: () => opts.hasPermission,
    hasAnyPermission: () => opts.hasPermission,
    hasAllPermissions: () => opts.hasPermission,
    isOwner: false,
    rolId: 'rol-1',
    rolNombre: 'Cajero',
    loading: false,
  })
  mockedCrearNotaCredito.mockResolvedValue({ ncrId: 'ncr-1', nroNcr: 'NCR-000001' })
  mockedUseDepositosVentaActivos.mockReturnValue({ depositos: [depositoActivo()], isLoading: false })
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
}

async function seleccionarPrimeraFactura() {
  const user = userEvent.setup()
  await user.click(screen.getByText(/C01-000001/i))
  return user
}

/**
 * Slice 4: EFECTIVO_REAL + TOTAL ahora exige un origen de dinero explicito
 * (picker multi-cuenta) en vez del stub automatico pre-Slice-4 (que siempre
 * armaba `{cuentaId: sesion.id, monto: factura.total_usd}` en silencio).
 * Helper compartido por los tests que solo necesitan "un origen valido
 * cualquiera" para poder confirmar — cubre exactamente el remanente de
 * `facturaSesion()` (`total_usd: '30.00'`) con la cuenta mockeada
 * `metodo-usd-1` ("Efectivo USD", saldo 500.00, ver `setup()`).
 */
async function llenarOrigenDineroValido(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Agregar origen/i }))
  await user.selectOptions(screen.getByLabelText('Tipo de origen'), 'SESION_EFECTIVO')
  await user.selectOptions(screen.getByLabelText('Cuenta'), 'metodo-usd-1')
  await user.type(screen.getByRole('spinbutton'), '30')
}

describe('NotaCreditoPosModal — Slice 5a-2a (entrada POS, PIN A, TOTAL only, sin coupling con cobro)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lista SOLO las facturas de la sesion activa (via useFacturasSesionActiva, query-enforced)', () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    expect(screen.getByText(/C01-000001/i)).toBeInTheDocument()
    expect(mockedUseFacturasSesionActiva).toHaveBeenCalled()
  })

  it('Slice 6: una factura con tiene_reverso_via_administracion=1 muestra el badge "Vía administración"', () => {
    setup({ hasPermission: true })
    mockedUseFacturasSesionActiva.mockReturnValue({
      facturas: [facturaSesion({ tiene_reverso_via_administracion: 1 })],
      isLoading: false,
    })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    expect(screen.getByText('Vía administración')).toBeInTheDocument()
  })

  it('Slice 6: una factura sin tiene_reverso_via_administracion NO muestra el badge "Vía administración"', () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    expect(screen.queryByText('Vía administración')).not.toBeInTheDocument()
  })

  it('con permiso ventas.nota_credito: confirmar emite directo, SIN pedir PIN', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await llenarOrigenDineroValido(user)
    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('mock-pin-dialog')).not.toBeInTheDocument()
    expect(mockedCrearNotaCredito.mock.calls[0][0]).toMatchObject({
      venta_id: 'venta-1',
      entryPoint: 'POS',
      sesionCajaActivaId: 'sesion-1',
      modalidad: 'EFECTIVO_REAL',
    })
    expect(mockedToastSuccess).toHaveBeenCalledWith(expect.stringContaining('NCR-000001'))
  })

  it('sin permiso ventas.nota_credito: exige PIN de supervisor antes de emitir', async () => {
    setup({ hasPermission: false })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await llenarOrigenDineroValido(user)
    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))

    expect(screen.getByTestId('mock-pin-dialog')).toBeInTheDocument()
    expect(mockedCrearNotaCredito).not.toHaveBeenCalled()

    await user.click(screen.getByText('Autorizar'))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
  })

  it('EFECTIVO_REAL reachable via caller POS real: entryPoint POS + sesion activa + modalidad EFECTIVO_REAL (dispara la Regla de Oro dentro de crearNotaCredito)', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await llenarOrigenDineroValido(user)
    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito.mock.calls[0][0]).toMatchObject({
      entryPoint: 'POS',
      modalidad: 'EFECTIVO_REAL',
    })
    expect(mockedCrearNotaCredito.mock.calls[0][0].tipo).toBeUndefined()
  })

  it('REGRESION obs #2814 reachable via caller POS real: SALDO_FAVOR (no-efectivo) se pasa correctamente a crearNotaCredito (la Regla de Oro no dispara dentro de la funcion)', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.selectOptions(screen.getByRole('combobox'), 'SALDO_FAVOR')
    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito.mock.calls[0][0]).toMatchObject({
      entryPoint: 'POS',
      modalidad: 'SALDO_FAVOR',
    })
  })

  it('por defecto (sin autorizar PIN B) NO pasa depositoReingresoId — usa el riel automatico', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await llenarOrigenDineroValido(user)
    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito.mock.calls[0][0].depositoReingresoId).toBeUndefined()
  })
})

describe('NotaCreditoPosModal — Slice 5a-2b (PIN B, override de deposito, SEPARADO de PIN A)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('el selector de deposito permanece bloqueado por defecto: solo muestra el texto "riel automatico" y un boton "Cambiar deposito"', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    await seleccionarPrimeraFactura()

    expect(screen.getByText(/Automatico/i)).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '' })).toBeInTheDocument() // solo el combobox de modalidad
    expect(screen.queryByText('Deposito Secundario')).not.toBeInTheDocument()
  })

  it('click en "Cambiar deposito" abre un PIN de supervisor SEPARADO del PIN de emision (PIN A), incluso con permiso de emision', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.click(screen.getByRole('button', { name: /Cambiar deposito/i }))

    expect(screen.getByTestId('mock-pin-dialog')).toBeInTheDocument()
    expect(screen.getByText(/Cambiar deposito de reingreso/i)).toBeInTheDocument()
    expect(mockedCrearNotaCredito).not.toHaveBeenCalled()
  })

  it('tras autorizar PIN B: aparece el selector de deposito y la eleccion del usuario se envia como depositoReingresoId', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.click(screen.getByRole('button', { name: /Cambiar deposito/i }))
    await user.click(screen.getByText('Autorizar'))

    const selects = screen.getAllByRole('combobox')
    const depositoSelect = selects[selects.length - 1]
    await user.selectOptions(depositoSelect, 'dep-1')
    await llenarOrigenDineroValido(user)
    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito.mock.calls[0][0].depositoReingresoId).toBe('dep-1')
  })

  it('UX C QA fix (Slice 5e): PIN B autorizado pero sin deposito elegido todavia — "Confirmar Anulacion" queda bloqueado, NUNCA cae en silencio al riel automatico (antes de este fix si lo hacia)', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.click(screen.getByRole('button', { name: /Cambiar deposito/i }))
    await user.click(screen.getByText('Autorizar'))

    expect(screen.getByRole('button', { name: /Confirmar Anulacion/i })).toBeDisabled()
    expect(mockedCrearNotaCredito).not.toHaveBeenCalled()
  })

  it('UX B (Slice 5e): hacer clic en "Volver" (deseleccionar factura) limpia la autorizacion del PIN de deposito (PIN B) — al re-seleccionar la misma factura, el selector vuelve a "Automatico"', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.click(screen.getByRole('button', { name: /Cambiar deposito/i }))
    await user.click(screen.getByText('Autorizar'))
    expect(screen.queryByText(/Automatico/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Volver/i }))
    await user.click(screen.getByText(/C01-000001/i))

    expect(screen.getByText(/Automatico/i)).toBeInTheDocument()
  })

  it('UX B (Slice 5e): seleccionar una factura DISTINTA limpia la autorizacion previa del PIN de deposito (PIN B)', async () => {
    setup({ hasPermission: true })
    mockedUseFacturasSesionActiva.mockReturnValue({
      facturas: [
        facturaSesion({ id: 'venta-1', nro_factura: 'C01-000001' }),
        facturaSesion({ id: 'venta-2', nro_factura: 'C01-000002' }),
      ],
      isLoading: false,
    })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = userEvent.setup()
    await user.click(screen.getByText(/C01-000001/i))
    await user.click(screen.getByRole('button', { name: /Cambiar deposito/i }))
    await user.click(screen.getByText('Autorizar'))
    expect(screen.queryByText(/Automatico/i)).not.toBeInTheDocument()

    await user.click(screen.getByText(/C01-000002/i))

    expect(screen.getByText(/Automatico/i)).toBeInTheDocument()
  })

  it('PIN A y PIN B son independientes: sin permiso de emision, autorizar PIN B para el deposito NO exime del PIN A al confirmar', async () => {
    setup({ hasPermission: false })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()

    // Autoriza PIN B (deposito) primero.
    await user.click(screen.getByRole('button', { name: /Cambiar deposito/i }))
    expect(screen.getByText(/Cambiar deposito de reingreso/i)).toBeInTheDocument()
    await user.click(screen.getByText('Autorizar'))
    expect(screen.queryByTestId('mock-pin-dialog')).not.toBeInTheDocument()

    const selects = screen.getAllByRole('combobox')
    await user.selectOptions(selects[selects.length - 1], 'dep-1')
    await llenarOrigenDineroValido(user)

    // Confirmar todavia exige PIN A (emision) — es una autorizacion separada.
    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))
    expect(mockedCrearNotaCredito).not.toHaveBeenCalled()
    expect(screen.getByText(/Emision de Nota de Credito/i)).toBeInTheDocument()

    await user.click(screen.getByText('Autorizar'))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito.mock.calls[0][0].depositoReingresoId).toBe('dep-1')
  })

  it('BUG 3 (QA C, Slice 5g): PIN A autorizado mientras PIN B quedo autorizado SIN deposito elegido — NUNCA debe emitir la NC (el callback async de PIN A debe revalidar depositoInvalido, igual que los handlers sincronos)', async () => {
    setup({ hasPermission: false })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    // Slice 4: el origen de dinero se llena PRIMERO — de otro modo el boton
    // queda `disabled` por `origenDineroInvalido` y el click ni siquiera
    // abre el PIN A, lo que rompe el escenario que este test quiere probar
    // (el gate de `depositoInvalido` especificamente).
    await llenarOrigenDineroValido(user)

    // Sin autorizar PIN B todavia, el riel es automatico -> depositoInvalido
    // es false y "Confirmar Anulacion" esta habilitado. Sin permiso de
    // emision, esto abre el PIN A (emision) y lo deja pendiente.
    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))
    expect(screen.getByText(/Emision de Nota de Credito/i)).toBeInTheDocument()
    expect(mockedCrearNotaCredito).not.toHaveBeenCalled()

    // Con el PIN A todavia pendiente de autorizar, el usuario abre y
    // autoriza el PIN B (deposito) SIN elegir un deposito concreto — el
    // selector de deposito de reingreso queda con el placeholder vacio.
    await user.click(screen.getByRole('button', { name: /Cambiar deposito/i }))
    const pinBDialog = screen
      .getByText(/Cambiar deposito de reingreso/i)
      .closest('[data-testid="mock-pin-dialog"]') as HTMLElement
    await user.click(within(pinBDialog).getByText('Autorizar'))

    // Ahora se autoriza el PIN A (emision), que estaba pendiente desde
    // antes — el deposito de reingreso NUNCA fue elegido. Antes de este
    // fix, el callback `onAuthorized` de PIN A no revalidaba
    // `depositoInvalido` y emitia la NC igual, cayendo en silencio al riel
    // automatico del backend.
    const pinADialog = screen
      .getByText(/Emision de Nota de Credito/i)
      .closest('[data-testid="mock-pin-dialog"]') as HTMLElement
    await user.click(within(pinADialog).getByText('Autorizar'))

    expect(mockedCrearNotaCredito).not.toHaveBeenCalled()
  })
})

describe('NotaCreditoPosModal — Slice 5e UX C (deposito de reingreso no puede quedar vacio al confirmar)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('TOTAL: tras autorizar PIN B sin elegir deposito, "Confirmar Anulacion" queda deshabilitado y se muestra el mensaje de validacion', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.click(screen.getByRole('button', { name: /Cambiar deposito/i }))
    await user.click(screen.getByText('Autorizar'))

    expect(screen.getByRole('button', { name: /Confirmar Anulacion/i })).toBeDisabled()
    expect(screen.getByText(/Debes seleccionar el deposito de reingreso/i)).toBeInTheDocument()
    expect(mockedCrearNotaCredito).not.toHaveBeenCalled()
  })

  it('TOTAL: elegir un deposito concreto habilita "Confirmar Anulacion" y limpia el mensaje de validacion', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await llenarOrigenDineroValido(user)
    await user.click(screen.getByRole('button', { name: /Cambiar deposito/i }))
    await user.click(screen.getByText('Autorizar'))

    const selects = screen.getAllByRole('combobox')
    await user.selectOptions(selects[selects.length - 1], 'dep-1')

    expect(screen.getByRole('button', { name: /Confirmar Anulacion/i })).not.toBeDisabled()
    expect(screen.queryByText(/Debes seleccionar el deposito de reingreso/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))
    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
  })

  it('sin autorizar PIN B (riel automatico): "Confirmar Anulacion" nunca se bloquea por deposito', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    // Slice 4: el picker de origen de dinero tiene su PROPIO gate
    // (`origenDineroInvalido`) independiente del de deposito — se llena
    // aqui para aislar la asercion de este test (que el deposito, en su
    // riel automatico, nunca bloquea).
    await llenarOrigenDineroValido(user)

    expect(screen.getByRole('button', { name: /Confirmar Anulacion/i })).not.toBeDisabled()
    expect(screen.queryByText(/Debes seleccionar el deposito de reingreso/i)).not.toBeInTheDocument()
  })

  it('PARCIAL: tras autorizar PIN B sin elegir deposito, "Confirmar Nota de Credito Parcial" queda deshabilitado aun con cantidad valida', async () => {
    setup({ hasPermission: true })
    mockedUseDetalleFactura.mockReturnValue({
      detalle: [
        {
          id: 'vd-1', venta_id: 'venta-1', producto_id: 'p1', cantidad: '5',
          precio_unitario_usd: '10.00', subtotal_usd: '50.00', subtotal_bs: '2000.00',
          producto_nombre: 'Botox 50U', producto_codigo: 'P001',
          tipo_impuesto: 'Gravable', impuesto_pct: '16', es_decimal: 0, precio_unitario_bs: '400.00',
        },
      ],
      isLoading: false,
    })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.click(screen.getByRole('button', { name: 'Parcial' }))
    await user.click(screen.getByRole('button', { name: /Cambiar deposito/i }))
    await user.click(screen.getByText('Autorizar'))
    await user.type(screen.getByRole('spinbutton'), '2')

    expect(screen.getByRole('button', { name: /Confirmar Nota de Credito Parcial/i })).toBeDisabled()
    expect(mockedCrearNotaCredito).not.toHaveBeenCalled()
  })
})

describe('NotaCreditoPosModal — Slice 2 (lista rediseñada: badges de estado/reverso, buscador, gating de reverso total)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('factura con saldo_pend_usd == total_usd (sin pagos) muestra el badge "Crédito"', () => {
    setup({ hasPermission: true })
    mockedUseFacturasSesionActiva.mockReturnValue({
      facturas: [facturaSesion({ total_usd: '30.00', saldo_pend_usd: '30.00' })],
      isLoading: false,
    })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    expect(screen.getByText('Crédito')).toBeInTheDocument()
  })

  it('factura Abonada + badge acumulado PARCIAL muestra AMBOS badges en la misma fila', () => {
    setup({ hasPermission: true })
    mockedUseFacturasSesionActiva.mockReturnValue({
      facturas: [facturaSesion({ total_usd: '30.00', saldo_pend_usd: '10.00', tiene_reverso_parcial: 1 })],
      isLoading: false,
    })
    mockedUseBadgesReversoSesion.mockReturnValue({ badgesPorVenta: { 'venta-1': 'PARCIAL' }, isLoading: false })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    expect(screen.getByText('Abonada')).toBeInTheDocument()
    expect(screen.getByText('Reverso Parcial')).toBeInTheDocument()
  })

  it('Slice 5e QA fix 3.5: el badge de reverso refleja lo ACUMULADO (via useBadgesReversoSesion), no el tipo de una NC individual — parcial acumulado a 100% muestra "Reverso Total", no "Reverso Parcial"', () => {
    setup({ hasPermission: true })
    mockedUseFacturasSesionActiva.mockReturnValue({
      // El flag por-NC dice "parcial" (existe una NC tipo PARCIAL)...
      facturas: [facturaSesion({ tiene_reverso_parcial: 1 })],
      isLoading: false,
    })
    // ...pero la acumulacion real (varias NCs PARCIALes sumando el 100%) es TOTAL.
    mockedUseBadgesReversoSesion.mockReturnValue({ badgesPorVenta: { 'venta-1': 'TOTAL' }, isLoading: false })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    expect(screen.getByText('Reverso Total')).toBeInTheDocument()
    expect(screen.queryByText('Reverso Parcial')).not.toBeInTheDocument()
    // BUG D fix: reverso TOTAL suprime el badge de pago, aunque la factura
    // tenga saldo_pend_usd == total_usd (que solo mostraria "Contado").
    expect(screen.queryByText('Contado')).not.toBeInTheDocument()
  })

  it('Slice 5e QA fix 3.5: sin entrada en badgesPorVenta para la factura, no muestra ningun badge de reverso', () => {
    setup({ hasPermission: true })
    mockedUseFacturasSesionActiva.mockReturnValue({ facturas: [facturaSesion()], isLoading: false })
    mockedUseBadgesReversoSesion.mockReturnValue({ badgesPorVenta: {}, isLoading: false })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    expect(screen.queryByText('Reverso Total')).not.toBeInTheDocument()
    expect(screen.queryByText('Reverso Parcial')).not.toBeInTheDocument()
  })

  it('F2 QA fix: Contado, Crédito y Abonada usan cada uno un color de badge distinto (antes compartian el mismo gris)', () => {
    setup({ hasPermission: true })
    mockedUseFacturasSesionActiva.mockReturnValue({
      facturas: [
        facturaSesion({ id: 'venta-contado', nro_factura: 'C01-000001', total_usd: '30.00', saldo_pend_usd: '0.00' }),
        facturaSesion({ id: 'venta-credito', nro_factura: 'C01-000002', total_usd: '30.00', saldo_pend_usd: '30.00' }),
        facturaSesion({ id: 'venta-abonada', nro_factura: 'C01-000003', total_usd: '30.00', saldo_pend_usd: '10.00' }),
      ],
      isLoading: false,
    })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const claseContado = screen.getByText('Contado').className
    const claseCredito = screen.getByText('Crédito').className
    const claseAbonada = screen.getByText('Abonada').className

    expect(claseContado).not.toBe(claseCredito)
    expect(claseContado).not.toBe(claseAbonada)
    expect(claseCredito).not.toBe(claseAbonada)
  })

  it('F1 QA fix: factura con tiene_reverso_total=1 (status ANULADA) permanece SELECCIONABLE — clickearla SI muestra su detalle, pero la ACCION "Nota de credito" queda bloqueada (read-only)', async () => {
    setup({ hasPermission: true })
    mockedUseFacturasSesionActiva.mockReturnValue({
      facturas: [facturaSesion({ status: 'ANULADA', tiene_reverso_total: 1 })],
      isLoading: false,
    })
    mockedUseBadgesReversoSesion.mockReturnValue({ badgesPorVenta: { 'venta-1': 'TOTAL' }, isLoading: false })
    // QA fix 5f: el gating de accion ahora deriva del acumulado por-linea
    // (detalle + reversos), NUNCA de los flags crudos — la unica linea de
    // la factura fue reversada al 100% por su unica NC TOTAL.
    mockedUseDetalleFactura.mockReturnValue({
      detalle: [
        {
          id: 'vd-1', venta_id: 'venta-1', producto_id: 'p1', cantidad: '5',
          precio_unitario_usd: '10.00', subtotal_usd: '50.00', subtotal_bs: '2000.00',
          producto_nombre: 'Botox 50U', producto_codigo: 'P001',
          tipo_impuesto: 'Gravable', impuesto_pct: '16', es_decimal: 0, precio_unitario_bs: '400.00',
        },
      ],
      isLoading: false,
    })
    mockedUseReversosFactura.mockReturnValue({
      reversos: [
        { nota_credito_id: 'nc-1', nro_ncr: 'NCR-000001', tipo: 'TOTAL', fecha: '2026-01-01T00:00:00Z', venta_det_id: 'vd-1', producto_descripcion: 'Botox 50U', cantidad: '5.000' },
      ],
      isLoading: false,
    })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    expect(screen.getByText('Reverso Total')).toBeInTheDocument()
    expect(screen.getByText(/C01-000001/i)).toBeInTheDocument()
    // BUG D fix: la factura (status ANULADA, 100% reversada) ya NO combina
    // "Reverso Total" con su badge de metodo de pago previo ("Contado").
    expect(screen.queryByText('Contado')).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByText(/C01-000001/i))

    // SELECCION funciona: el detalle de la factura se muestra (panel montado).
    expect(screen.getAllByText(/C01-000001/i).length).toBeGreaterThan(0)
    // ACCION bloqueada: no se ofrece emitir otra NC sobre esta factura.
    expect(screen.queryByRole('button', { name: /Confirmar Anulacion/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Total' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Parcial' })).not.toBeInTheDocument()
    expect(screen.getByText(/ya fue reversada totalmente/i)).toBeInTheDocument()
  })

  it('F1 QA fix: factura con tiene_reverso_parcial=1 (sin total) — la accion SIGUE disponible pero el tipo TOTAL ya no se ofrece, solo PARCIAL sobre el remanente', async () => {
    setup({ hasPermission: true })
    mockedUseFacturasSesionActiva.mockReturnValue({
      facturas: [facturaSesion({ tiene_reverso_parcial: 1 })],
      isLoading: false,
    })
    // QA fix 5f: el gating de TOTAL ahora deriva del acumulado por-linea —
    // una NC PARCIAL previa que NO completa el 100% (2 de 5) bloquea TOTAL
    // pero deja PARCIAL disponible sobre el remanente.
    mockedUseDetalleFactura.mockReturnValue({
      detalle: [
        {
          id: 'vd-1', venta_id: 'venta-1', producto_id: 'p1', cantidad: '5',
          precio_unitario_usd: '10.00', subtotal_usd: '50.00', subtotal_bs: '2000.00',
          producto_nombre: 'Botox 50U', producto_codigo: 'P001',
          tipo_impuesto: 'Gravable', impuesto_pct: '16', es_decimal: 0, precio_unitario_bs: '400.00',
        },
      ],
      isLoading: false,
    })
    mockedUseReversosFactura.mockReturnValue({
      reversos: [
        { nota_credito_id: 'nc-0', nro_ncr: 'NCR-000000', tipo: 'PARCIAL', fecha: '2026-01-01T00:00:00Z', venta_det_id: 'vd-1', producto_descripcion: 'Botox 50U', cantidad: '2.000' },
      ],
      isLoading: false,
    })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = userEvent.setup()
    await user.click(screen.getByText(/C01-000001/i))

    expect(screen.queryByRole('button', { name: 'Total' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Confirmar Anulacion/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirmar Nota de Credito Parcial/i })).toBeInTheDocument()
  })

  it('QA fix 5f (consistencia badge/gating, obs verify-combined-final-v2): DOS NCs PARCIALes que juntas reversan el 100% de la unica linea -> el badge ya dice "Reverso Total" Y la accion queda bloqueada (read-only), consistentes por construccion', async () => {
    setup({ hasPermission: true })
    mockedUseFacturasSesionActiva.mockReturnValue({
      // El flag por-NC dice "parcial" (ninguna NC individual es tipo TOTAL)...
      facturas: [facturaSesion({ tiene_reverso_parcial: 1 })],
      isLoading: false,
    })
    // ...pero el badge acumulado (misma fuente que el gating tras este fix)
    // ya dice TOTAL: dos NCs PARCIALes (2 + 3) suman exactamente los 5
    // facturados.
    mockedUseBadgesReversoSesion.mockReturnValue({ badgesPorVenta: { 'venta-1': 'TOTAL' }, isLoading: false })
    mockedUseDetalleFactura.mockReturnValue({
      detalle: [
        {
          id: 'vd-1', venta_id: 'venta-1', producto_id: 'p1', cantidad: '5',
          precio_unitario_usd: '10.00', subtotal_usd: '50.00', subtotal_bs: '2000.00',
          producto_nombre: 'Botox 50U', producto_codigo: 'P001',
          tipo_impuesto: 'Gravable', impuesto_pct: '16', es_decimal: 0, precio_unitario_bs: '400.00',
        },
      ],
      isLoading: false,
    })
    mockedUseReversosFactura.mockReturnValue({
      reversos: [
        { nota_credito_id: 'nc-0', nro_ncr: 'NCR-000000', tipo: 'PARCIAL', fecha: '2026-01-01T00:00:00Z', venta_det_id: 'vd-1', producto_descripcion: 'Botox 50U', cantidad: '2.000' },
        { nota_credito_id: 'nc-1', nro_ncr: 'NCR-000001', tipo: 'PARCIAL', fecha: '2026-01-02T00:00:00Z', venta_det_id: 'vd-1', producto_descripcion: 'Botox 50U', cantidad: '3.000' },
      ],
      isLoading: false,
    })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    expect(screen.getByText('Reverso Total')).toBeInTheDocument()
    // BUG D fix: dos NCs PARCIALes que ACUMULAN el 100% (sin ninguna NC
    // tipo TOTAL literal) tambien deben suprimir el badge de pago.
    expect(screen.queryByText('Contado')).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByText(/C01-000001/i))

    // ANTES del fix 5f: el gating leia `tiene_reverso_total` (crudo, aun 0
    // aqui porque ninguna NC individual es TOTAL) y mostraba el formulario
    // interactivo — INCONSISTENTE con el badge de arriba. DESPUES: bloqueado.
    expect(screen.queryByRole('button', { name: /Confirmar Anulacion/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Total' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Parcial' })).not.toBeInTheDocument()
    expect(screen.getByText(/ya fue reversada totalmente/i)).toBeInTheDocument()
  })

  it('F1+F6 QA fix: linea ya parcialmente reversada limita el stepper de SeleccionLineasNc al REMANENTE — el input RECHAZA valores por encima, no a lo facturado originalmente', async () => {
    setup({ hasPermission: true })
    mockedUseFacturasSesionActiva.mockReturnValue({
      facturas: [facturaSesion({ tiene_reverso_parcial: 1 })],
      isLoading: false,
    })
    mockedUseDetalleFactura.mockReturnValue({
      detalle: [
        {
          id: 'vd-1', venta_id: 'venta-1', producto_id: 'p1', cantidad: '5',
          precio_unitario_usd: '10.00', subtotal_usd: '50.00', subtotal_bs: '2000.00',
          producto_nombre: 'Botox 50U', producto_codigo: 'P001',
          tipo_impuesto: 'Gravable', impuesto_pct: '16', es_decimal: 0, precio_unitario_bs: '400.00',
        },
      ],
      isLoading: false,
    })
    // Ya se acredito 3 de 5 en una NC previa — el remanente real es 2.
    mockedUseReversosFactura.mockReturnValue({
      reversos: [
        { nota_credito_id: 'nc-0', nro_ncr: 'NCR-000000', tipo: 'PARCIAL', fecha: '2026-01-01T00:00:00Z', venta_det_id: 'vd-1', producto_descripcion: 'Botox 50U', cantidad: '3.000' },
      ],
      isLoading: false,
    })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = userEvent.setup()
    await user.click(screen.getByText(/C01-000001/i))
    await user.type(screen.getByRole('spinbutton'), '9')

    expect(screen.getByRole('spinbutton')).toHaveValue(null)

    await user.type(screen.getByRole('spinbutton'), '2')
    expect(screen.getByRole('spinbutton')).toHaveValue(2)
  })

  it('F1 QA fix: el panel muestra el historial de NC(s) aplicadas junto al detalle original de la factura', async () => {
    setup({ hasPermission: true })
    mockedUseReversosFactura.mockReturnValue({
      reversos: [
        { nota_credito_id: 'nc-1', nro_ncr: 'NCR-000005', tipo: 'PARCIAL', fecha: '2026-01-02T00:00:00Z', venta_det_id: 'vd-9', producto_descripcion: 'Botox 50U', cantidad: '1.000' },
      ],
      isLoading: false,
    })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    await seleccionarPrimeraFactura()

    expect(screen.getByText(/Notas de credito aplicadas/i)).toBeInTheDocument()
    expect(screen.getByText('NCR-000005')).toBeInTheDocument()
  })

  it('factura con tiene_reverso_parcial=1 pero status activo sigue siendo clickable (puede recibir otra NC parcial, F1: por defecto en PARCIAL, no TOTAL)', async () => {
    setup({ hasPermission: true })
    mockedUseFacturasSesionActiva.mockReturnValue({
      facturas: [facturaSesion({ tiene_reverso_parcial: 1 })],
      isLoading: false,
    })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = userEvent.setup()
    await user.click(screen.getByText(/C01-000001/i))

    // F1 QA fix: TOTAL ya no es opcion valida sobre una factura con reverso
    // parcial previo — la seleccion cae por defecto en PARCIAL.
    expect(screen.getByRole('button', { name: /Confirmar Nota de Credito Parcial/i })).toBeInTheDocument()
  })

  it('el buscador filtra client-side por numero de factura', async () => {
    setup({ hasPermission: true })
    mockedUseFacturasSesionActiva.mockReturnValue({
      facturas: [
        facturaSesion({ id: 'venta-1', nro_factura: 'C01-000001', cliente_nombre: 'Maria Perez' }),
        facturaSesion({ id: 'venta-2', nro_factura: 'C01-000002', cliente_nombre: 'Juan Gomez' }),
      ],
      isLoading: false,
    })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText(/Buscar por numero, cliente o estado/i), '000002')

    expect(screen.queryByText(/C01-000001/i)).not.toBeInTheDocument()
    expect(screen.getByText(/C01-000002/i)).toBeInTheDocument()
  })

  it('el buscador filtra client-side por nombre de cliente (case-insensitive)', async () => {
    setup({ hasPermission: true })
    mockedUseFacturasSesionActiva.mockReturnValue({
      facturas: [
        facturaSesion({ id: 'venta-1', nro_factura: 'C01-000001', cliente_nombre: 'Maria Perez' }),
        facturaSesion({ id: 'venta-2', nro_factura: 'C01-000002', cliente_nombre: 'Juan Gomez' }),
      ],
      isLoading: false,
    })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText(/Buscar por numero, cliente o estado/i), 'gomez')

    expect(screen.queryByText(/Maria Perez/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Juan Gomez/i)).toBeInTheDocument()
  })

  it('el buscador filtra client-side por estado de pago (ej. "credito")', async () => {
    setup({ hasPermission: true })
    mockedUseFacturasSesionActiva.mockReturnValue({
      facturas: [
        facturaSesion({ id: 'venta-1', nro_factura: 'C01-000001', total_usd: '30.00', saldo_pend_usd: '30.00' }),
        facturaSesion({ id: 'venta-2', nro_factura: 'C01-000002', total_usd: '30.00', saldo_pend_usd: '0.00' }),
      ],
      isLoading: false,
    })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText(/Buscar por numero, cliente o estado/i), 'credito')

    expect(screen.getByText(/C01-000001/i)).toBeInTheDocument()
    expect(screen.queryByText(/C01-000002/i)).not.toBeInTheDocument()
  })
})

describe('NotaCreditoPosModal — Slice 3a (panel de detalle montado, Design §Decision 5/6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sin seleccion: el panel derecho no muestra datos de factura alguna', () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    expect(screen.getByText(/Selecciona una factura del listado/i)).toBeInTheDocument()
  })

  it('al seleccionar una factura: el panel muestra su detalle fiscal via buildReciboData (linea gravada, linea exenta e IGTF de la factura real)', async () => {
    setup({ hasPermission: true })
    mockedUseFacturasSesionActiva.mockReturnValue({
      facturas: [facturaSesion({ total_igtf_usd: '0.60' })],
      isLoading: false,
    })
    mockedUseDetalleFactura.mockReturnValue({
      detalle: [
        {
          id: 'vd-1', venta_id: 'venta-1', producto_id: 'p1', cantidad: '2',
          precio_unitario_usd: '10.00', subtotal_usd: '20.00', subtotal_bs: '800.00',
          producto_nombre: 'Botox 50U', producto_codigo: 'P001',
          tipo_impuesto: 'Gravable', impuesto_pct: '16', es_decimal: 0, precio_unitario_bs: '400.00',
        },
        {
          id: 'vd-2', venta_id: 'venta-1', producto_id: 'p2', cantidad: '1',
          precio_unitario_usd: '5.00', subtotal_usd: '5.00', subtotal_bs: '200.00',
          producto_nombre: 'Consulta', producto_codigo: 'P002',
          tipo_impuesto: 'Exento', impuesto_pct: '0', es_decimal: 0, precio_unitario_bs: '200.00',
        },
      ],
      isLoading: false,
    })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    await seleccionarPrimeraFactura()

    expect(screen.getByText('Botox 50U')).toBeInTheDocument()
    expect(screen.getByText('Consulta')).toBeInTheDocument()
    expect(screen.getByText('Monto Exento')).toBeInTheDocument()
    expect(screen.getByText('Base Imponible')).toBeInTheDocument()
    expect(screen.getByText('IGTF')).toBeInTheDocument()
  })

  it('Slice 5d: NUNCA muestra la seccion de afectacion a cuentas por cobrar (dato no confiable en flujo SAF, obs #2896/#2897)', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    await seleccionarPrimeraFactura()

    expect(screen.queryByText(/afect(o|ó) cuentas por cobrar/i)).not.toBeInTheDocument()
  })

  it('el listado sigue visible en la columna izquierda incluso con una factura seleccionada (layout de dos columnas, no drill-down)', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    await seleccionarPrimeraFactura()

    expect(screen.getAllByText(/C01-000001/i).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Confirmar Anulacion/i })).toBeInTheDocument()
  })
})

describe('NotaCreditoPosModal — Slice 3b (eleccion TOTAL/PARCIAL, wiring completo a crearNotaCredito, Design §Decision 7)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function detalleUnaLinea() {
    return [
      {
        id: 'vd-1', venta_id: 'venta-1', producto_id: 'p1', cantidad: '5',
        precio_unitario_usd: '10.00', subtotal_usd: '50.00', subtotal_bs: '2000.00',
        producto_nombre: 'Botox 50U', producto_codigo: 'P001',
        tipo_impuesto: 'Gravable', impuesto_pct: '16', es_decimal: 0, precio_unitario_bs: '400.00',
      },
    ]
  }

  it('tras seleccionar una factura, se ofrece explicitamente elegir entre Total y Parcial', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    await seleccionarPrimeraFactura()

    expect(screen.getByRole('button', { name: 'Total' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Parcial' })).toBeInTheDocument()
    // TOTAL es la eleccion por defecto (preserva el flujo pre-existente byte-a-byte).
    expect(screen.getByRole('button', { name: /Confirmar Anulacion/i })).toBeInTheDocument()
  })

  it('elegir Parcial reemplaza el footer "Confirmar Anulacion" por la seleccion de lineas (SeleccionLineasNc) y NO llama crearNotaCredito todavia', async () => {
    setup({ hasPermission: true })
    mockedUseDetalleFactura.mockReturnValue({ detalle: detalleUnaLinea(), isLoading: false })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.click(screen.getByRole('button', { name: 'Parcial' }))

    expect(screen.queryByRole('button', { name: /Confirmar Anulacion/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirmar Nota de Credito Parcial/i })).toBeInTheDocument()
    expect(mockedCrearNotaCredito).not.toHaveBeenCalled()
  })

  it('con permiso: PARCIAL completo ingresando cantidad y confirmando invoca crearNotaCredito con tipo=PARCIAL y las lineas mapeadas', async () => {
    setup({ hasPermission: true })
    mockedUseDetalleFactura.mockReturnValue({ detalle: detalleUnaLinea(), isLoading: false })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.click(screen.getByRole('button', { name: 'Parcial' }))
    await user.type(screen.getByRole('spinbutton'), '2')
    await user.click(screen.getByRole('button', { name: /Confirmar Nota de Credito Parcial/i }))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito.mock.calls[0][0]).toMatchObject({
      venta_id: 'venta-1',
      entryPoint: 'POS',
      tipo: 'PARCIAL',
      lineas: [{ venta_det_id: 'vd-1', cantidadDevolver: '2.000' }],
    })
  })

  it('sin permiso: confirmar PARCIAL exige el mismo PIN de emision (PIN A) y, autorizado, invoca crearNotaCredito con tipo=PARCIAL', async () => {
    setup({ hasPermission: false })
    mockedUseDetalleFactura.mockReturnValue({ detalle: detalleUnaLinea(), isLoading: false })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.click(screen.getByRole('button', { name: 'Parcial' }))
    await user.type(screen.getByRole('spinbutton'), '1')
    await user.click(screen.getByRole('button', { name: /Confirmar Nota de Credito Parcial/i }))

    expect(screen.getByTestId('mock-pin-dialog')).toBeInTheDocument()
    expect(mockedCrearNotaCredito).not.toHaveBeenCalled()

    await user.click(screen.getByText('Autorizar'))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito.mock.calls[0][0]).toMatchObject({
      tipo: 'PARCIAL',
      lineas: [{ venta_det_id: 'vd-1', cantidadDevolver: '1.000' }],
    })
  })

  it('NC TOTAL sigue sin enviar tipo/lineas (contrato preservado byte-a-byte, Spec: NC TOTAL reversa completa)', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await llenarOrigenDineroValido(user)
    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito.mock.calls[0][0].tipo).toBeUndefined()
    expect(mockedCrearNotaCredito.mock.calls[0][0].lineas).toBeUndefined()
  })
})

describe('NotaCreditoPosModal — Slice 4 (placeholder "Editar metodos de pago" + gating PIN A extendido, Design §Decision 9)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('con permiso: click en "Editar metodos de pago" dispara un aviso de funcion no implementada y NUNCA llama crearNotaCredito', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.click(screen.getByRole('button', { name: /Editar metodos de pago/i }))

    expect(mockedToastInfo).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('mock-pin-dialog')).not.toBeInTheDocument()
    expect(mockedCrearNotaCredito).not.toHaveBeenCalled()
  })

  it('sin permiso: click en "Editar metodos de pago" exige el MISMO PIN de supervisor que emision (PIN A)', async () => {
    setup({ hasPermission: false })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.click(screen.getByRole('button', { name: /Editar metodos de pago/i }))

    expect(screen.getByTestId('mock-pin-dialog')).toBeInTheDocument()
    expect(screen.getByText(/Emision de Nota de Credito/i)).toBeInTheDocument()
    expect(mockedToastInfo).not.toHaveBeenCalled()
    expect(mockedCrearNotaCredito).not.toHaveBeenCalled()

    await user.click(screen.getByText('Autorizar'))

    await waitFor(() => expect(mockedToastInfo).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito).not.toHaveBeenCalled()
  })

  it('las dos acciones pendientes (NC y Editar metodos de pago) son independientes en la misma sesion del modal: autorizar cada una dispara solo la accion correcta', async () => {
    setup({ hasPermission: false })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await llenarOrigenDineroValido(user)

    await user.click(screen.getByRole('button', { name: /Editar metodos de pago/i }))
    expect(screen.getByTestId('mock-pin-dialog')).toBeInTheDocument()
    await user.click(screen.getByText('Autorizar'))
    await waitFor(() => expect(mockedToastInfo).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))
    expect(screen.getByTestId('mock-pin-dialog')).toBeInTheDocument()
    await user.click(screen.getByText('Autorizar'))
    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedToastInfo).toHaveBeenCalledTimes(1)
  })
})

describe('NotaCreditoPosModal — Slice 5g.5 (behavior F: el modal permanece abierto y se refresca en el lugar tras una emision exitosa)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function detalleUnaLinea() {
    return [
      {
        id: 'vd-1', venta_id: 'venta-1', producto_id: 'p1', cantidad: '5',
        precio_unitario_usd: '10.00', subtotal_usd: '50.00', subtotal_bs: '2000.00',
        producto_nombre: 'Botox 50U', producto_codigo: 'P001',
        tipo_impuesto: 'Gravable', impuesto_pct: '16', es_decimal: 0, precio_unitario_bs: '400.00',
      },
    ]
  }

  it('tras una emision TOTAL exitosa, el modal permanece abierto (onClose NO se llama) y la factura sigue seleccionada', async () => {
    setup({ hasPermission: true })
    const onClose = vi.fn()
    render(<NotaCreditoPosModal isOpen onClose={onClose} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await llenarOrigenDineroValido(user)
    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getAllByText(/C01-000001/i).length).toBeGreaterThan(0)
  })

  it('tras una emision PARCIAL exitosa, SeleccionLineasNc se remonta: la cantidad ingresada se resetea a vacio (anti double-submit), aunque la factura siga seleccionada', async () => {
    setup({ hasPermission: true })
    mockedUseDetalleFactura.mockReturnValue({ detalle: detalleUnaLinea(), isLoading: false })
    const { rerender } = render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.click(screen.getByRole('button', { name: 'Parcial' }))
    await user.type(screen.getByRole('spinbutton'), '2')
    expect(screen.getByRole('spinbutton')).toHaveValue(2)

    await user.click(screen.getByRole('button', { name: /Confirmar Nota de Credito Parcial/i }))
    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))

    // Simula el refresco de la live-query tras el commit de la transaccion:
    // el remanente ya refleja la NC parcial recien creada.
    mockedUseReversosFactura.mockReturnValue({
      reversos: [
        { nota_credito_id: 'nc-1', nro_ncr: 'NCR-000001', tipo: 'PARCIAL', fecha: '2026-01-01T00:00:00Z', venta_det_id: 'vd-1', producto_descripcion: 'Botox 50U', cantidad: '2.000' },
      ],
      isLoading: false,
    })
    rerender(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    expect(screen.getByRole('spinbutton')).toHaveValue(null)
  })

  it('tras una emision exitosa, la autorizacion del PIN de deposito (PIN B) se limpia: el selector vuelve a "Automatico" para la siguiente accion sobre la misma factura', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await llenarOrigenDineroValido(user)
    await user.click(screen.getByRole('button', { name: /Cambiar deposito/i }))
    await user.click(screen.getByText('Autorizar'))
    const selects = screen.getAllByRole('combobox')
    await user.selectOptions(selects[selects.length - 1], 'dep-1')
    expect(screen.queryByText(/Automatico/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))
    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))

    expect(screen.getByText(/Automatico/i)).toBeInTheDocument()
  })
})

describe('NotaCreditoPosModal — Slice 4 (selector multi-origen real, reemplaza el stub cuentaId=sesion.id)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('EFECTIVO_REAL + TOTAL: muestra el picker multi-origen ("Agregar origen") y bloquea "Confirmar Anulacion" hasta elegir un origen valido', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    await seleccionarPrimeraFactura()

    expect(screen.getByRole('button', { name: /Agregar origen/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirmar Anulacion/i })).toBeDisabled()
  })

  it('elegir sesion+monto valido en el picker habilita el submit y emite origenDinero con el metodos_cobro.id real (NO sesion.id, corrige el stub)', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.click(screen.getByRole('button', { name: /Agregar origen/i }))
    const tipoSelect = screen.getByLabelText('Tipo de origen')
    await user.selectOptions(tipoSelect, 'SESION_EFECTIVO')
    await user.selectOptions(screen.getByLabelText('Cuenta'), 'metodo-usd-1')
    await user.type(screen.getByRole('spinbutton'), '30')

    expect(screen.getByRole('button', { name: /Confirmar Anulacion/i })).not.toBeDisabled()
    await user.click(screen.getByRole('button', { name: /Confirmar Anulacion/i }))

    await waitFor(() => expect(mockedCrearNotaCredito).toHaveBeenCalledTimes(1))
    expect(mockedCrearNotaCredito.mock.calls[0][0]).toMatchObject({
      entryPoint: 'POS',
      sesionCajaActivaId: 'sesion-1',
      modalidad: 'EFECTIVO_REAL',
      origenDinero: [{ tipo: 'SESION_EFECTIVO', cuentaId: 'metodo-usd-1', monto: '30' }],
    })
  })

  it('el picker POS NUNCA renderiza un selector de sesion destino (carril protegido, Decision 4) — siempre usa la sesion activa propia', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.click(screen.getByRole('button', { name: /Agregar origen/i }))
    await user.selectOptions(screen.getByLabelText('Tipo de origen'), 'SESION_EFECTIVO')

    expect(screen.queryByText(/sesion destino/i)).not.toBeInTheDocument()
  })

  it('las opciones de "Efectivo de sesion" son SOLO los metodos_cobro efectivo de la empresa (Efectivo USD/Bs), no otros metodos', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.click(screen.getByRole('button', { name: /Agregar origen/i }))
    await user.selectOptions(screen.getByLabelText('Tipo de origen'), 'SESION_EFECTIVO')

    expect(screen.getByRole('option', { name: /Efectivo USD/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Efectivo Bs/i })).toBeInTheDocument()
  })

  it('las opciones de Tesoreria/Banco vienen de useCuentasTesoreria (caja fuerte + banco), libres para POS', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.click(screen.getByRole('button', { name: /Agregar origen/i }))
    await user.selectOptions(screen.getByLabelText('Tipo de origen'), 'TESORERIA_EFECTIVO')
    expect(screen.getByRole('option', { name: /Caja Fuerte Principal/i })).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Tipo de origen'), 'BANCO')
    expect(screen.getByRole('option', { name: /Banesco/i })).toBeInTheDocument()
  })

  it('modalidad SALDO_FAVOR (no-desembolso): NUNCA muestra el picker de origen de dinero', async () => {
    setup({ hasPermission: true })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.selectOptions(screen.getByRole('combobox'), 'SALDO_FAVOR')

    expect(screen.queryByRole('button', { name: /Agregar origen/i })).not.toBeInTheDocument()
  })

  it('cambiar a tipo PARCIAL retira "Efectivo / tarjeta" de las modalidades ofrecidas (combinacion cash+PARCIAL no soportada aun, evita reintegro fantasma)', async () => {
    setup({ hasPermission: true })
    mockedUseDetalleFactura.mockReturnValue({
      detalle: [
        {
          id: 'vd-1', venta_id: 'venta-1', producto_id: 'p1', cantidad: '5',
          precio_unitario_usd: '10.00', subtotal_usd: '50.00', subtotal_bs: '2000.00',
          producto_nombre: 'Botox 50U', producto_codigo: 'P001',
          tipo_impuesto: 'Gravable', impuesto_pct: '16', es_decimal: 0, precio_unitario_bs: '400.00',
        },
      ],
      isLoading: false,
    })
    render(<NotaCreditoPosModal isOpen onClose={() => {}} sesion={sesionActiva} />)

    const user = await seleccionarPrimeraFactura()
    await user.click(screen.getByRole('button', { name: 'Parcial' }))

    expect(screen.queryByRole('option', { name: /Efectivo \/ tarjeta/i })).not.toBeInTheDocument()
  })
})
