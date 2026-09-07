import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@powersync/react'
import { Plus, Trash, FloppyDisk, ListBullets, ArrowCircleDown, ArrowCircleUp, Wallet, Handshake, XCircle, User, ShoppingCart, Tag, X, CaretDown, FileX } from '@phosphor-icons/react'
import { toast } from 'sonner'
import { v4 as uuidv4 } from 'uuid'
import { useBlocker, useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTasaActual } from '@/features/configuracion/hooks/use-tasas'
import { useCurrentUser } from '@/core/hooks/use-current-user'
import { useMetodosPOS } from '@/features/configuracion/hooks/use-payment-methods'
import { usePermissions, PERMISSIONS } from '@/core/hooks/use-permissions'
import Decimal from 'decimal.js'
import { formatUsd, formatBs, usdToBs, bsToUsd } from '@/lib/currency'
import { localNow } from '@/lib/dates'
import { type ProductoVenta, type CargoEspecial } from '../hooks/use-ventas'
import { useSesionActiva } from '@/features/caja/hooks/use-sesiones-caja'
import { useDepositoActivoVenta } from '../hooks/use-deposito-activo'
import { useDeudaFacturasCliente } from '@/features/cxc/hooks/use-deuda-cliente'
import { calcularDisponibleCredito } from '@/features/cxc/lib/deuda-credito-cliente'
import { useInventarioStockBackfillListo } from '@/features/inventario/stores/inventario-stock-backfill-gate-store'
import { useNivelesPrecioActivos, type NivelPrecio } from '@/features/configuracion/hooks/use-niveles-precio'
import type { LineaVentaForm } from '../schemas/venta-schema'
import type { Cliente } from '@/features/clientes/hooks/use-clientes'
import { ClienteSelector, type ClienteSelectorHandle } from './cliente-selector'
import { ProductoBuscador, type ProductoBuscadorHandle } from './producto-buscador'
import { LineaItems, type LineaItemsHandle } from './linea-items'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SupervisorPinDialog } from '@/components/ui/supervisor-pin-dialog'
import { FacturasEsperaModal } from './facturas-espera-modal'
import { NuevoClienteRapidoModal } from './nuevo-cliente-rapido-modal'
import { VentaExitosaModal, type VentaExitosaData } from './venta-exitosa-modal'
import { AperturaSesionPosModal } from '@/features/caja/components/apertura-sesion-pos-modal'
import { SesionCajaForm } from '@/features/caja/components/sesion-caja-form'
import { IngresoRetiroModal } from '@/features/caja/components/ingreso-retiro-modal'
import { AvanceModal, type AvanceAplicado } from '@/features/caja/components/avance-modal'
import { useCuentasTesoreria } from '@/features/tesoreria/hooks/use-cuentas-tesoreria'
import { useCajasFuerteActivas } from '@/features/tesoreria/hooks/use-caja-fuerte'
import { PrestamoModal, type PrestamoAplicado } from '@/features/caja/components/prestamo-modal'
import { useFacturasEsperaStore, type FacturaEnEspera } from '../stores/facturas-espera-store'
import { CobroModal } from './cobro-modal'
// Nota de Credito POS-express (Slice 5a-2a) — modal auto-contenido, sibling
// del flujo de venta. Deliberadamente NO comparte estado con CobroModal ni
// con facturas-espera-store: es un flujo lateral independiente que nunca
// toca `lineas`/`cargosEspeciales`/el carrito en curso.
import { NotaCreditoPosModal } from './nota-credito-pos-modal'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'

// Descuentos comerciales pausados — ver decisión #1470. El estado y el threading
// hacia CobroModal/crearVenta se mantienen intactos (descuentoBs siempre 0) para
// poder reactivar la funcionalidad mas adelante cambiando este flag a `true`.
const DESCUENTOS_HABILITADOS = false

export function PosTerminal() {
  const { tasaValor, isLoading: tasaLoading } = useTasaActual()
  const { user } = useCurrentUser()
  const { metodos } = useMetodosPOS()
  const { hasPermission, isOwner } = usePermissions()
  const canMovManualPos = isOwner || hasPermission(PERMISSIONS.CAJA_MOV_MANUAL)
  const canCloseCajaPos = isOwner || hasPermission(PERMISSIONS.CAJA_CLOSE)
  const esperaStore = useFacturasEsperaStore()
  const { sesion, isLoading: sesionLoading } = useSesionActiva()
  // Deposito de la caja activa (Slice 2a) — escopea lectura/validacion de
  // stock en el article select y en el guard de cantidad. NO afecta el
  // deposito real usado al escribir la venta (crearVenta sigue con su propia
  // resolucion hardcodeada al principal hasta Slice 2b).
  const { depositoId, isLoading: depositoLoading } = useDepositoActivoVenta()
  // Gate de primer arranque del backfill de inventario_stock (cierre de
  // WARNING post-2a) — solo lectura, NUNCA dispara el backfill (eso lo hace
  // unicamente useInventarioStockBackfill() montado en _app/route.tsx).
  // true en arranques posteriores al primero (sin delay alguno).
  const backfillListo = useInventarioStockBackfillListo()
  const { cuentas: cuentasTesoreria } = useCuentasTesoreria()
  const { cajas: cajasFuerteActivas } = useCajasFuerteActivas()
  const navigate = useNavigate()

  // Datos de contexto para la barra de caja
  const { data: empresaData } = useQuery(
    user?.empresa_id ? 'SELECT nombre FROM empresas WHERE id = ? LIMIT 1' : '',
    user?.empresa_id ? [user.empresa_id] : []
  )
  const empresaNombre = empresaData?.[0]
    ? (empresaData[0] as { nombre: string }).nombre
    : null

  const { data: cajaData } = useQuery(
    sesion?.caja_id ? 'SELECT nombre FROM cajas WHERE id = ? LIMIT 1' : '',
    sesion?.caja_id ? [sesion.caja_id] : []
  )
  const cajaNombre = cajaData?.[0]
    ? (cajaData[0] as { nombre: string }).nombre
    : null

  // Factura
  const [clienteId, setClienteId] = useState<string | null>(null)
  const [clienteNombre, setClienteNombre] = useState('')
  const [clienteData, setClienteData] = useState<Cliente | null>(null)
  // Deuda real de facturas — fuente del badge de credito (nunca saldo_actual
  // neteado, nunca suma saldo a favor). Ver design.md Decision 3.
  const { deudaFacturasUsd } = useDeudaFacturasCliente(clienteId)
  const [lineas, setLineas] = useState<LineaVentaForm[]>([])
  const [cargosEspeciales, setCargosEspeciales] = useState<CargoEspecial[]>([])

  // UI state
  const [showCarritoSheet, setShowCarritoSheet] = useState(false)
  const [showCajaSheet, setShowCajaSheet] = useState(false)
  const [showEsperaModal, setShowEsperaModal] = useState(false)
  const [showNuevoClienteModal, setShowNuevoClienteModal] = useState(false)
  const [showSupervisorPin, setShowSupervisorPin] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)
  const [confirmConfig, setConfirmConfig] = useState<{
    titulo: string
    mensaje: string
  } | null>(null)

  // Caja state - modales dedicados
  const [showIngresoModal, setShowIngresoModal] = useState(false)
  const [showRetiroModal, setShowRetiroModal] = useState(false)
  const [showAvanceModal, setShowAvanceModal] = useState(false)
  const [showPrestamoModal, setShowPrestamoModal] = useState(false)
  const [showCierrePosPin, setShowCierrePosPin] = useState(false)
  const [showCierrePos, setShowCierrePos] = useState(false)
  const [showCobroModal, setShowCobroModal] = useState(false)
  const [showNotaCreditoModal, setShowNotaCreditoModal] = useState(false)
  const [ventaExitosa, setVentaExitosa] = useState<VentaExitosaData | null>(null)

  // Refs for navigation blocker (always captures latest state)
  const lineasRef = useRef(lineas)
  const clienteIdRef = useRef(clienteId)
  const clienteNombreRef = useRef(clienteNombre)
  const cargosEspecialesRef = useRef(cargosEspeciales)
  lineasRef.current = lineas
  clienteIdRef.current = clienteId
  clienteNombreRef.current = clienteNombre
  cargosEspecialesRef.current = cargosEspeciales

  // Refs para atajos de teclado y flujo de foco
  const productoBuscadorRef = useRef<ProductoBuscadorHandle>(null)
  const clienteSelectorRef = useRef<ClienteSelectorHandle>(null)
  const lineaItemsRef = useRef<LineaItemsHandle>(null)
  const keyboardHandlerRef = useRef<((e: KeyboardEvent) => void) | undefined>(undefined)
  const pendingFocusIndexRef = useRef<number | null>(null)

  // Totales de la factura — usar Decimal para evitar drift en sumas monetarias
  const totalProductosUsd = lineas.reduce((sum, l) => sum.plus(new Decimal(l.cantidad).times(l.precio_unitario_usd)), new Decimal(0))
  const totalCargosEspUsd = cargosEspeciales.reduce((sum, c) => sum.plus(c.montoCargoUsd), new Decimal(0))
  const totalIvaUsd = lineas
    .filter(l => ((l.tipo_impuesto as string | undefined) ?? 'Exento') !== 'Exento')
    .reduce((sum, l) => sum.plus(
      new Decimal(l.cantidad).times(l.precio_unitario_usd).times((l.impuesto_pct as number | undefined) ?? 0).dividedBy(100)
    ), new Decimal(0))
  const totalUsd = totalProductosUsd.plus(totalIvaUsd).plus(totalCargosEspUsd)

  // Desglose fiscal por alicuota y tipo
  const _ivaByAlicuota = new Map<number, Decimal>()
  for (const l of lineas) {
    if ((l.tipo_impuesto as string | undefined) === 'Gravable') {
      const pct = (l.impuesto_pct as number | undefined) ?? 0
      if (pct > 0) {
        const iva = new Decimal(l.cantidad).times(l.precio_unitario_usd).times(pct).dividedBy(100)
        _ivaByAlicuota.set(pct, (_ivaByAlicuota.get(pct) ?? new Decimal(0)).plus(iva))
      }
    }
  }
  const ivaEntries = [..._ivaByAlicuota.entries()].filter(([, v]) => v.gt('0.001')).sort((a, b) => b[0] - a[0])
  const baseGravableUsd = lineas
    .filter(l => ((l.tipo_impuesto as string | undefined) ?? 'Exento') === 'Gravable')
    .reduce((sum, l) => sum.plus(new Decimal(l.cantidad).times(l.precio_unitario_usd)), new Decimal(0))
  const baseExentoUsd = lineas
    .filter(l => ((l.tipo_impuesto as string | undefined) ?? 'Exento') === 'Exento')
    .reduce((sum, l) => sum.plus(new Decimal(l.cantidad).times(l.precio_unitario_usd)), new Decimal(0))
  const baseExoneradoUsd = lineas
    .filter(l => ((l.tipo_impuesto as string | undefined) ?? 'Exento') === 'Exonerado')
    .reduce((sum, l) => sum.plus(new Decimal(l.cantidad).times(l.precio_unitario_usd)), new Decimal(0))
  const mostrarDesgloseFiscal = ivaEntries.length > 0 || baseExentoUsd.gt('0.001') || baseExoneradoUsd.gt('0.001')
  // Calcular totalBs usando el monto nativo de cada cargo especial (si existe)
  // para evitar diferencias cuando la tasa cambia entre el momento del avance y el display.
  const totalCargosEspBs = cargosEspeciales.reduce((s, c) =>
    s.plus(c.totalCargoBs !== undefined ? new Decimal(c.totalCargoBs) : usdToBs(c.montoCargoUsd, tasaValor)),
    new Decimal(0))
  const totalBs = usdToBs(totalUsd.minus(totalCargosEspUsd), tasaValor).plus(totalCargosEspBs)
  const totalItems = lineas.reduce((sum, l) => sum + l.cantidad, 0)

  // Egresos de caja pendientes: factura actual + todas las facturas en espera (aun no debitados de DB)
  const efectivoUsdMetodo = metodos.find((m) => m.tipo === 'EFECTIVO' && m.moneda === 'USD')
  const efectivoBsMetodo = metodos.find((m) => m.tipo === 'EFECTIVO' && m.moneda === 'BS')
  const allPendingCargos = [
    ...cargosEspeciales,
    ...esperaStore.facturas.flatMap((f) => f.cargosEspeciales),
  ]
  const pendingCajaUsd = allPendingCargos
    .filter((c) => c.origenFondosTipo === 'CAJA')
    .flatMap((c) => c.egresosCaja ?? [])
    .filter((e) => efectivoUsdMetodo != null && e.metodo_cobro_id === efectivoUsdMetodo.id)
    .reduce((sum, e) => sum + e.monto, 0)
  const pendingCajaBs = allPendingCargos
    .filter((c) => c.origenFondosTipo === 'CAJA')
    .flatMap((c) => c.egresosCaja ?? [])
    .filter((e) => efectivoBsMetodo != null && e.metodo_cobro_id === efectivoBsMetodo.id)
    .reduce((sum, e) => sum + e.monto, 0)

  // --- Nivel de precio activo (ciclo por los niveles activos de la empresa) ---
  const { niveles: nivelesPrecio } = useNivelesPrecioActivos()
  const [nivelIdx, setNivelIdx] = useState(0)
  const nivelActivo: NivelPrecio | null = nivelesPrecio[nivelIdx] ?? null

  // --- Descuento comercial / cortesia ---
  const [descuentoBs, setDescuentoBs] = useState(0)
  const [descuentoMotivo, setDescuentoMotivo] = useState('')
  const [showDescuento, setShowDescuento] = useState(false)

  // --- Auto-focus en buscador cuando carga el POS ---
  useEffect(() => {
    if (!tasaLoading && !sesionLoading && !depositoLoading && backfillListo && tasaValor > 0) {
      productoBuscadorRef.current?.focus()
    }
  // Solo la primera vez que los datos esten listos
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasaLoading, sesionLoading, depositoLoading, backfillListo])

  // --- Focus a cantidad tras agregar/incrementar producto ---
  useEffect(() => {
    const idx = pendingFocusIndexRef.current
    if (idx !== null) {
      pendingFocusIndexRef.current = null
      lineaItemsRef.current?.focusCantidad(idx)
    }
  }, [lineas])

  // --- Restaurar borrador al montar ---
  useEffect(() => {
    if (!user) return
    const borrador = esperaStore.borradorActual
    if (
      borrador &&
      borrador.usuarioId === user.id &&
      borrador.empresaId === user.empresa_id &&
      (borrador.lineas.length > 0 || (borrador.cargosEspeciales ?? []).length > 0)
    ) {
      setClienteId(borrador.clienteId)
      setClienteNombre(borrador.clienteNombre === 'Sin cliente' ? '' : borrador.clienteNombre)
      setLineas(borrador.lineas)
      setCargosEspeciales(borrador.cargosEspeciales ?? [])
      toast.info('Se restauro tu factura en proceso')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // --- Guardar borrador en cada cambio significativo ---
  useEffect(() => {
    if (!user?.empresa_id) return
    if (lineas.length === 0 && cargosEspeciales.length === 0) return
    esperaStore.guardarBorrador({
      clienteId,
      clienteNombre: clienteNombre || 'Sin cliente',
      lineas: [...lineas],
      pagos: [],
      cargosEspeciales: [...cargosEspeciales],
      tasa: tasaValor,
      usuarioId: user.id,
      empresaId: user.empresa_id,
      ultimaActualizacion: localNow(),
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineas, cargosEspeciales, clienteId, clienteNombre])

  // --- Bloqueador de navegacion: auto-guarda en Facturas Guardadas antes de navegar ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useBlocker(async (): Promise<any> => {
    const lineasActuales = lineasRef.current
    const cargosActuales = cargosEspecialesRef.current
    if ((lineasActuales.length > 0 || cargosActuales.length > 0) && user) {
      const totalLineasUsd = lineasActuales.reduce((s, l) => s.plus(new Decimal(l.cantidad).times(l.precio_unitario_usd)), new Decimal(0))
      const totalCargosUsd = cargosActuales.reduce((s, c) => s.plus(c.montoCargoUsd), new Decimal(0))
      const totalUsdFactura = totalLineasUsd.plus(totalCargosUsd)
      const factura: FacturaEnEspera = {
        id: uuidv4(),
        clienteId: clienteIdRef.current,
        clienteNombre: clienteNombreRef.current || 'Sin cliente',
        lineas: [...lineasActuales],
        pagos: [],
        cargosEspeciales: [...cargosActuales],
        tasa: tasaValor,
        totalUsd: totalUsdFactura.toNumber(),
        totalBs: usdToBs(totalUsdFactura, tasaValor).toNumber(),
        itemsCount: lineasActuales.reduce((s, l) => s + l.cantidad, 0),
        usuarioId: user.id,
        usuarioNombre: user.nombre ?? user.email ?? '',
        fecha: localNow(),
      }
      esperaStore.agregar(factura)
      esperaStore.limpiarBorrador()
      toast.info('Factura guardada en "Facturas Guardadas". Puedes recuperarla luego.')
    }
    return false // Permitir la navegacion
  }, lineas.length > 0 || cargosEspeciales.length > 0)

  // --- Accion protegida ---
  const handleProtectedAction = (
    action: () => void,
    titulo: string,
    mensaje: string
  ) => {
    setPendingAction(() => action)
    setConfirmConfig({ titulo, mensaje })
    if (hasPermission(PERMISSIONS.SALES_VOID)) {
      setShowConfirm(true)
    } else {
      setShowSupervisorPin(true)
    }
  }

  const executePendingAction = () => {
    pendingAction?.()
    setPendingAction(null)
    setConfirmConfig(null)
  }

  // --- Handlers ---

  const handleSelectCliente = (cliente: Cliente) => {
    setClienteId(cliente.id)
    setClienteNombre(cliente.nombre)
    setClienteData(cliente)
  }

  const handleClearCliente = () => {
    setClienteId(null)
    setClienteNombre('')
    setClienteData(null)
  }

  const handleNuevoClienteCreado = (cliente: { id: string; nombre: string; identificacion: string }) => {
    setClienteId(cliente.id)
    setClienteNombre(cliente.nombre)
    setClienteData(null) // Nuevo cliente: sin limite de credito por defecto
  }

  const handleSelectProducto = (producto: ProductoVenta) => {
    const existing = lineas.findIndex((l) => l.producto_id === producto.id)
    if (existing >= 0) {
      pendingFocusIndexRef.current = existing
      setLineas((prev) =>
        prev.map((l, i) =>
          i === existing
            ? { ...l, cantidad: l.cantidad + 1 }
            : l
        )
      )
      return
    }
    pendingFocusIndexRef.current = lineas.length
    const p1 = parseFloat(producto.precio_venta_usd)    || 0
    const p2 = parseFloat(producto.precio_mayor_usd ?? '0') || 0
    const p3 = parseFloat(producto.precio_especial_usd ?? '0') || 0
    const orden = nivelActivo?.orden ?? 1
    const precioActivoUsd = (() => {
      if (orden === 2) return p2 > 0 ? p2 : p1
      if (orden === 3) return p3 > 0 ? p3 : p1
      return p1
    })()
    setLineas((prev) => [
      ...prev,
      {
        producto_id: producto.id,
        codigo: producto.codigo,
        nombre: producto.nombre,
        tipo: producto.tipo,
        cantidad: 1,
        precio_unitario_usd: precioActivoUsd,
        precio_nivel1_usd: p1,
        precio_nivel2_usd: p2 > 0 ? p2 : undefined,
        precio_nivel3_usd: p3 > 0 ? p3 : undefined,
        stock_actual: parseFloat(producto.stock),
        es_decimal: producto.es_decimal === 1,
        tipo_impuesto: (producto.tipo_impuesto ?? 'Exento') as 'Gravable' | 'Exento' | 'Exonerado',
        impuesto_pct: producto.impuesto_pct ?? 0,
      },
    ])
  }

  const handleUpdateCantidad = (index: number, cantidad: number) => {
    setLineas((prev) => prev.map((l, i) => (i === index ? { ...l, cantidad } : l)))
  }

  const handleRemoveLinea = (index: number) => {
    handleProtectedAction(
      () => setLineas((prev) => prev.filter((_, i) => i !== index)),
      'Eliminar articulo',
      '¿Seguro que deseas eliminar este articulo de la venta?'
    )
  }

  const resetForm = () => {
    setClienteId(null)
    setClienteNombre('')
    setClienteData(null)
    setLineas([])
    setCargosEspeciales([])
    setDescuentoBs(0)
    setDescuentoMotivo('')
    setShowDescuento(false)
    esperaStore.limpiarBorrador()
    productoBuscadorRef.current?.clear()
  }

  const handleCancelar = () => {
    if (lineas.length === 0 && cargosEspeciales.length === 0) {
      resetForm()
      return
    }
    handleProtectedAction(
      resetForm,
      'Cancelar venta',
      '¿Seguro que deseas cancelar esta venta? Se perderan todos los articulos registrados.'
    )
  }

  const handleGuardarFactura = () => {
    if (lineas.length === 0 && cargosEspeciales.length === 0) {
      toast.error('Agrega al menos un producto o cargo especial antes de guardar')
      return
    }
    if (!user) return

    const factura: FacturaEnEspera = {
      id: uuidv4(),
      clienteId,
      clienteNombre: clienteNombre || 'Sin cliente',
      lineas: [...lineas],
      pagos: [],
      cargosEspeciales: [...cargosEspeciales],
      tasa: tasaValor,
      totalUsd: totalUsd.toNumber(),
      totalBs: totalBs.toNumber(),
      itemsCount: totalItems,
      usuarioId: user.id,
      usuarioNombre: user.nombre ?? user.email ?? '',
      fecha: localNow(),
    }

    esperaStore.agregar(factura)
    resetForm()
    toast.success('Factura guardada')
  }

  const handleRecuperarEspera = (factura: FacturaEnEspera) => {
    if (lineas.length > 0 || cargosEspeciales.length > 0) {
      toast.error('Hay una venta en curso. Cancela o guarda primero.')
      return
    }

    const recuperada = esperaStore.recuperar(factura.id)
    if (!recuperada) return

    setClienteId(recuperada.clienteId)
    setClienteNombre(recuperada.clienteNombre === 'Sin cliente' ? '' : recuperada.clienteNombre)
    setLineas(recuperada.lineas)
    setCargosEspeciales(recuperada.cargosEspeciales ?? [])
    toast.success('Factura recuperada')
  }

  const handleAbrirCobro = () => {
    if (!clienteId) {
      toast.error('Selecciona un cliente')
      return
    }
    if (lineas.length === 0 && cargosEspeciales.length === 0) {
      toast.error('Agrega al menos un producto o aplica un avance/prestamo')
      return
    }
    if (lineas.some((l) => l.cantidad <= 0)) {
      toast.error('Hay articulos con cantidad invalida')
      return
    }

    // Validacion de stock negativo (sin permiso de override)
    const canOverrideStock = hasPermission(PERMISSIONS.SALES_OVERRIDE_STOCK)
    const productosConStockInsuficiente = lineas.filter(
      (l) => l.tipo === 'P' && l.cantidad > l.stock_actual
    )
    if (productosConStockInsuficiente.length > 0 && !canOverrideStock) {
      const nombres = productosConStockInsuficiente.map((l) => l.nombre).join(', ')
      toast.error(`Stock insuficiente: ${nombres}. No tienes permiso para facturar en negativo.`)
      return
    }

    setShowCobroModal(true)
  }

  // --- Caja desde POS ---
  const navigateToCuadre = () => {
    if (sesion) {
      const fecha = sesion.fecha_apertura.substring(0, 10)
      void navigate({
        to: '/ventas/cuadre-de-caja',
        search: { fecha, cajaId: sesion.caja_id, sesionId: sesion.id },
      })
    } else {
      void navigate({ to: '/ventas/cuadre-de-caja' })
    }
  }

  const handleCerrarCajaPos = () => {
    if (canCloseCajaPos) {
      navigateToCuadre()
    } else {
      setShowCierrePosPin(true)
    }
  }

  // ---- Validaciones para el boton Cobrar ----
  const tieneLineasValidas = lineas.length > 0 && lineas.every((l) => l.cantidad > 0)
  const tieneContenido = tieneLineasValidas || cargosEspeciales.length > 0
  const puedeAbrir = !!clienteId && tieneContenido

  // ---- Handlers de cargos especiales ----
  const handleAvanceAplicado = (avance: AvanceAplicado) => {
    setCargosEspeciales((prev) => [
      ...prev,
      {
        tipo: 'AVANCE',
        descripcion: avance.descripcion,
        montoCargoUsd: avance.totalCargoUsd,
        totalCargoBs: avance.totalCargoBs,
        movimientoIds: [],
        origenFondosTipo: avance.origenFondosTipo,
        egresosCaja: avance.egresosCaja,
      },
    ])
  }

  const handlePrestamoAplicado = (prestamo: PrestamoAplicado) => {
    setCargosEspeciales((prev) => [
      ...prev,
      {
        tipo: 'PRESTAMO',
        descripcion: prestamo.descripcion,
        montoCargoUsd: prestamo.totalDeudaUsd,
        totalCargoBs: prestamo.totalDeudaBs,
        movimientoIds: [],
        diasPlazo: prestamo.diasPlazo,
        clienteId: clienteId ?? undefined,
        origenFondosTipo: prestamo.origenFondosTipo,
        egresosCaja: prestamo.egresosCaja,
      },
    ])
  }

  const handleRemoveCargo = (index: number) => {
    setCargosEspeciales((prev) => prev.filter((_, i) => i !== index))
  }

  /** Cicla al siguiente nivel activo.
   *  Solo afecta productos agregados a partir de este momento;
   *  los ya existentes en la factura conservan sus precios. */
  function handleToggleModo() {
    if (nivelesPrecio.length <= 1) return
    setNivelIdx((prev) => (prev + 1) % nivelesPrecio.length)
  }

  // --- Atajos de teclado (Option B) ---
  // F3=Toggle Detal/Mayor  F5=Ingreso  F6=Retiro  F7=Avance  F8=Prestamo
  // F9=GuardarFactura  F10=FacturasGuardadas  F12=ConfirmarVenta  Esc=Cancelar  Alt+A=AgregarPago
  keyboardHandlerRef.current = (e: KeyboardEvent) => {
    const anyModalOpen =
      showConfirm || showSupervisorPin || showEsperaModal || showNuevoClienteModal ||
      showIngresoModal || showRetiroModal || showAvanceModal || showPrestamoModal ||
      showCierrePosPin || showCierrePos || !!ventaExitosa || showCobroModal || showNotaCreditoModal
    if (anyModalOpen) return

    const isInInput =
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement

    switch (e.key) {
      case 'F1':
        e.preventDefault()
        productoBuscadorRef.current?.focus()
        break
      case 'F2':
        e.preventDefault()
        clienteSelectorRef.current?.focus()
        break
      case 'F3':
        e.preventDefault()
        handleToggleModo()
        break
      case 'F5':
        e.preventDefault()
        if (sesion && canMovManualPos) setShowIngresoModal(true)
        break
      case 'F6':
        e.preventDefault()
        if (sesion && canMovManualPos) setShowRetiroModal(true)
        break
      case 'F7':
        e.preventDefault()
        if (sesion && canMovManualPos) setShowAvanceModal(true)
        break
      case 'F8':
        e.preventDefault()
        if (sesion && canMovManualPos) setShowPrestamoModal(true)
        break
      case 'F9':
        e.preventDefault()
        handleGuardarFactura()
        break
      case 'F10':
        e.preventDefault()
        setShowEsperaModal(true)
        break
      case 'F12':
        e.preventDefault()
        handleAbrirCobro()
        break
      case 'Escape':
        if (!isInInput) {
          e.preventDefault()
          handleCancelar()
        }
        break
      default:
        break
    }
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyboardHandlerRef.current?.(e)
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  if (tasaLoading || sesionLoading || depositoLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        Cargando...
      </div>
    )
  }

  // Gate de PRIMER arranque unicamente (Slice 2a — cierre de WARNING): mientras
  // el backfill de inventario_stock corre por primera vez en este dispositivo,
  // evita que un producto legado con stock real pero sin fila propia en
  // inventario_stock parezca "no encontrado". En arranques posteriores
  // (flag ya marcado) backfillListo es true de inmediato, sin este bloque.
  if (!backfillListo) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        Verificando inventario…
      </div>
    )
  }

  if (tasaValor <= 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <p className="text-sm text-muted-foreground">
          No hay tasa de cambio configurada. Configura una tasa antes de realizar ventas.
        </p>
      </div>
    )
  }

  const esperaCount = esperaStore.facturas.length

  // Suppress unused variable warning — empresaNombre is available for future use
  void empresaNombre

  return (
    <>
      {/* Modal de apertura de sesion si no hay sesion activa */}
      {!sesion && (
        <AperturaSesionPosModal
          onAbierta={() => {/* useSesionActiva se actualiza reactivamente */}}
          tasa={tasaValor}
        />
      )}

      {/* MAIN POS CONTAINER */}
      <div className="flex flex-col h-[calc(100vh-4rem)] overflow-hidden bg-muted/30 p-2 gap-2 sm:p-3 sm:gap-3">

        {/* ── HEADER BAR (3 rows) ── */}
        <div className="shrink-0 rounded-2xl bg-card shadow-lg overflow-hidden">

          {/* Row 1: Session info + Cliente selector */}
          <div className="px-3 py-2 sm:px-4 sm:py-2.5 flex flex-col sm:flex-row sm:items-center sm:gap-3 gap-2 border-b">
            {/* Session status + botón Caja (mobile only, a la derecha) */}
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
              {/* Nombre + caja: flex-1 para que el nombre trunce si es largo */}
              <div className="flex items-center gap-1 min-w-0 flex-1">
                {user?.nombre && (
                  <span className="text-xs sm:text-sm font-medium truncate">{user.nombre}</span>
                )}
                {cajaNombre && (
                  <span className="text-xs sm:text-sm text-muted-foreground shrink-0">· {cajaNombre}</span>
                )}
              </div>
              {/* Botón Caja — mobile only, siempre visible */}
              {sesion && (canMovManualPos || canCloseCajaPos) && (
                <button
                  type="button"
                  onClick={() => setShowCajaSheet(true)}
                  className="sm:hidden shrink-0 inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border text-muted-foreground bg-muted/40 hover:bg-muted transition-colors"
                >
                  <Wallet size={12} />Caja<CaretDown size={10} />
                </button>
              )}
              {/* Botón Facturas de caja (Slice 2, rename de "Nota de Credito")
                  — mobile only, siempre visible con sesion (independiente de
                  permisos de caja — el PIN A vive dentro del propio modal,
                  Spec notas-credito-pos) */}
              {sesion && (
                <button
                  type="button"
                  onClick={() => setShowNotaCreditoModal(true)}
                  className="sm:hidden shrink-0 inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border text-muted-foreground bg-muted/40 hover:bg-muted transition-colors"
                >
                  <FileX size={12} />Fact.
                </button>
              )}
            </div>
            {/* Divider — desktop only */}
            <div className="hidden sm:block h-4 w-px bg-border shrink-0" />
            {/* Cliente row: label + selector + Nuevo + credit info */}
            <div className="flex items-center gap-2 flex-1 min-w-0">
              {/* F2 label — desktop only */}
              <label className="hidden sm:flex text-xs text-muted-foreground items-center gap-1 shrink-0">
                <User size={12} />
                <kbd className="rounded border bg-muted px-1 py-px text-[10px] font-mono leading-none">F2</kbd>
              </label>
              <div className="flex-1 min-w-0 max-w-2xl sm:max-w-sm">
                <ClienteSelector
                  ref={clienteSelectorRef}
                  clienteId={clienteId}
                  onSelect={handleSelectCliente}
                  onClear={handleClearCliente}
                />
              </div>
              {!clienteId && (
                <button
                  type="button"
                  onClick={() => setShowNuevoClienteModal(true)}
                  className="shrink-0 flex items-center gap-1 rounded border border-primary/40 bg-primary/5 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/15 transition-colors"
                >
                  <Plus size={12} />Nuevo
                </button>
              )}
              {/* Credit info — desktop only */}
              {clienteData && parseFloat(clienteData.limite_credito_usd) > 0 && (
                <div className="hidden sm:flex shrink-0 items-center gap-1.5 rounded bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
                  <span>Credito:</span>
                  <span className="font-semibold text-green-600">
                    {formatUsd(calcularDisponibleCredito(clienteData.limite_credito_usd, deudaFacturasUsd).toNumber())}
                  </span>
                  <span>/ {formatUsd(parseFloat(clienteData.limite_credito_usd))}</span>
                </div>
              )}
            </div>
          </div>

          {/* Row 2: Product search + toggle Detal/Mayor */}
          <div className="px-3 py-2 sm:px-4 sm:py-2.5 border-b">
            <div className="flex items-center gap-2">
              <label className="hidden sm:flex text-xs text-muted-foreground shrink-0 items-center gap-1">
                <kbd className="rounded border bg-muted px-1 py-px text-[10px] font-mono leading-none">F1</kbd>
              </label>
              <div className="flex-1 max-w-2xl">
                <ProductoBuscador ref={productoBuscadorRef} onSelect={handleSelectProducto} tasa={tasaValor} nivelActivo={nivelActivo} depositoId={depositoId} />
              </div>
              {/* Toggle nivel de precio — visible solo si hay más de 1 nivel activo */}
              {nivelesPrecio.length > 1 && (
                <button
                  type="button"
                  onClick={handleToggleModo}
                  title={`Nivel activo: ${nivelActivo?.nombre ?? '—'} — F3 para ciclar`}
                  className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                    nivelIdx === 0
                      ? 'bg-muted/40 text-muted-foreground border-border hover:bg-muted'
                      : nivelIdx === 1
                        ? 'bg-amber-500 text-white border-amber-500 shadow-sm'
                        : 'bg-blue-500 text-white border-blue-500 shadow-sm'
                  }`}
                >
                  <Tag size={12} weight={nivelIdx === 0 ? 'regular' : 'fill'} />
                  <span className="max-w-[5rem] truncate">{nivelActivo?.nombre ?? '—'}</span>
                  <kbd className={`hidden sm:inline rounded border px-1 py-px text-[10px] font-mono leading-none ${
                    nivelIdx === 0 ? 'border-border bg-muted' : 'border-white/30 bg-white/20'
                  }`}>F3</kbd>
                </button>
              )}
            </div>
          </div>

          {/* Row 3: Caja operation buttons — desktop only (mobile usa el botón en Row 1) */}
          {sesion && (
            <>
              {/* Desktop: botones individuales */}
              <div className="hidden sm:flex px-4 py-2 items-center gap-1.5 flex-wrap justify-center">
                {canMovManualPos && (
                  <>
                    <button type="button" onClick={() => setShowIngresoModal(true)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border text-muted-foreground hover:text-green-700 hover:bg-green-50 hover:border-green-200 transition-colors">
                      <ArrowCircleDown size={12} />Ingreso
                      <kbd className="rounded border bg-muted px-1 py-px text-[10px] font-mono leading-none">F5</kbd>
                    </button>
                    <button type="button" onClick={() => setShowRetiroModal(true)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border text-muted-foreground hover:text-red-700 hover:bg-red-50 hover:border-red-200 transition-colors">
                      <ArrowCircleUp size={12} />Retiro
                      <kbd className="rounded border bg-muted px-1 py-px text-[10px] font-mono leading-none">F6</kbd>
                    </button>
                    <button type="button" onClick={() => setShowAvanceModal(true)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border text-muted-foreground hover:text-amber-700 hover:bg-amber-50 hover:border-amber-200 transition-colors">
                      <Wallet size={12} />Avance
                      <kbd className="rounded border bg-muted px-1 py-px text-[10px] font-mono leading-none">F7</kbd>
                    </button>
                    <button type="button" onClick={() => setShowPrestamoModal(true)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border text-muted-foreground hover:text-purple-700 hover:bg-purple-50 hover:border-purple-200 transition-colors">
                      <Handshake size={12} />Prestamo
                      <kbd className="rounded border bg-muted px-1 py-px text-[10px] font-mono leading-none">F8</kbd>
                    </button>
                  </>
                )}
                {canCloseCajaPos && (
                  <button type="button" onClick={handleCerrarCajaPos}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
                    <XCircle size={12} />Cerrar Caja
                  </button>
                )}
                {/* Facturas de caja (Slice 2, rename de "Nota de Credito") —
                    visible siempre que haya sesion, independiente de
                    canMovManualPos/canCloseCajaPos: el PIN A
                    por-falta-de-permiso vive dentro del propio modal. */}
                <button type="button" onClick={() => setShowNotaCreditoModal(true)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border text-muted-foreground hover:text-red-700 hover:bg-red-50 hover:border-red-200 transition-colors">
                  <FileX size={12} />Facturas de caja
                </button>
              </div>
            </>
          )}
        </div>

        {/* ── 2-COLUMN BODY ── */}
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[1fr_320px] gap-3 overflow-hidden">

          {/* COL LEFT: Items table + cargos (scrollable) */}
          <div className="flex flex-col min-h-0 rounded-2xl bg-card shadow-lg overflow-hidden">
            <div className="flex-1 min-h-0 overflow-y-auto">
              <LineaItems
                ref={lineaItemsRef}
                lineas={lineas}
                tasa={tasaValor}
                onUpdateCantidad={handleUpdateCantidad}
                onRemove={handleRemoveLinea}
                onCantidadEnter={() => productoBuscadorRef.current?.focus()}
                compact
              />

              {/* Cargos especiales */}
              {cargosEspeciales.length > 0 && (
                <div className="mx-3 my-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 space-y-1.5">
                  <p className="text-xs font-semibold text-amber-900 uppercase tracking-wide">Cargos especiales</p>
                  {cargosEspeciales.map((cargo, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <div className="min-w-0 flex items-center gap-1.5">
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                          cargo.tipo === 'PRESTAMO' ? 'bg-purple-100 text-purple-700' : 'bg-amber-100 text-amber-700'
                        }`}>{cargo.tipo}</span>
                        <span className="text-amber-800 truncate text-xs">{cargo.descripcion}</span>
                        {cargo.tipo === 'PRESTAMO' && cargo.diasPlazo && (
                          <span className="text-[10px] text-amber-600">({cargo.diasPlazo}d)</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-xs font-semibold text-amber-900">{formatUsd(cargo.montoCargoUsd)}</span>
                        <button type="button" onClick={() => handleRemoveCargo(i)}
                          className="rounded p-0.5 text-amber-600 hover:text-destructive hover:bg-destructive/10 transition-colors">
                          <Trash size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Cargos footer */}
            <div className="shrink-0 border-t px-3 py-1.5 flex items-center justify-between text-xs text-muted-foreground bg-muted/20">
              <span>Cargos especiales</span>
              <span className={totalCargosEspUsd.gt(0) ? 'font-medium text-amber-700' : ''}>
                {formatUsd(totalCargosEspUsd)}
              </span>
            </div>
          </div>

          {/* COL RIGHT: Total + payments (sticky panel) — hidden on mobile, replaced by cart bar */}
          <div className="hidden md:flex flex-col min-h-0 rounded-2xl bg-card shadow-lg overflow-hidden">

            {/* Total */}
            <div className="px-4 py-4 shrink-0 bg-gradient-to-br from-primary/10 to-primary/5 border-b">
              <p className="text-[10px] font-semibold text-primary/70 uppercase tracking-widest mb-1">Total</p>
              {mostrarDesgloseFiscal && (
                <div className="space-y-0.5 mb-2">
                  {baseGravableUsd.gt('0.001') && (
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Base Gravable</span>
                      <span>{formatBs(usdToBs(baseGravableUsd, tasaValor))}</span>
                    </div>
                  )}
                  {ivaEntries.map(([pct, iva]) => (
                    <div key={pct} className="flex justify-between text-xs text-amber-700 font-medium">
                      <span>IVA {pct}%</span>
                      <span>+{formatBs(usdToBs(iva, tasaValor))}</span>
                    </div>
                  ))}
                  {baseExentoUsd.gt('0.001') && (
                    <div className="flex justify-between text-xs text-blue-600">
                      <span>Exento</span>
                      <span>{formatBs(usdToBs(baseExentoUsd, tasaValor))}</span>
                    </div>
                  )}
                  {baseExoneradoUsd.gt('0.001') && (
                    <div className="flex justify-between text-xs text-green-700">
                      <span>Exonerado</span>
                      <span>{formatBs(usdToBs(baseExoneradoUsd, tasaValor))}</span>
                    </div>
                  )}
                </div>
              )}
              <p className="text-3xl font-bold leading-tight tabular-nums">{formatBs(totalBs)}</p>
              <p className="text-sm text-muted-foreground mt-0.5">{formatUsd(totalUsd)}</p>
            </div>

            {/* Descuento Comercial / Cortesia — pausado, ver DESCUENTOS_HABILITADOS */}
            {DESCUENTOS_HABILITADOS && (!showDescuento ? (
              <div className="px-4 py-1.5 shrink-0 border-b">
                <button
                  type="button"
                  onClick={() => setShowDescuento(true)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-orange-600 transition-colors"
                >
                  <Tag size={12} />
                  Agregar descuento comercial
                </button>
              </div>
            ) : (
              <div className="px-4 py-3 shrink-0 border-b bg-orange-50/60">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-orange-700 flex items-center gap-1">
                    <Tag size={12} />
                    Descuento comercial
                  </p>
                  <button
                    type="button"
                    onClick={() => { setShowDescuento(false); setDescuentoBs(0); setDescuentoMotivo('') }}
                    className="text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className="flex gap-2 items-end">
                  <div className="w-28">
                    <p className="text-[10px] text-muted-foreground mb-0.5">Monto Bs.</p>
                    <Input
                      type="number"
                      min={0}
                      max={totalBs.toNumber()}
                      step={1}
                      value={descuentoBs || ''}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value) || 0
                        setDescuentoBs(Math.min(Math.max(0, v), totalBs.toNumber()))
                      }}
                      className="h-7 text-sm"
                      placeholder="0"
                    />
                  </div>
                  <div className="flex-1">
                    <p className="text-[10px] text-muted-foreground mb-0.5">Motivo</p>
                    <Input
                      type="text"
                      value={descuentoMotivo}
                      onChange={(e) => setDescuentoMotivo(e.target.value)}
                      className="h-7 text-sm"
                      placeholder="Cortesia, ajuste..."
                      maxLength={100}
                    />
                  </div>
                </div>
                {descuentoBs > 0 && (
                  <p className="text-xs font-medium text-orange-600 mt-1.5 text-right">
                    −{formatBs(descuentoBs)} ({formatUsd(bsToUsd(descuentoBs, tasaValor))})
                  </p>
                )}
              </div>
            ))}

            {/* Indicador de accion pendiente */}
            <div className="flex-1 flex flex-col items-center justify-center gap-3 p-4 text-center">
              {tieneContenido && clienteId ? (
                <>
                  <div className="rounded-full bg-primary/10 p-3">
                    <ShoppingCart size={20} className="text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{formatBs(totalBs)}</p>
                    <p className="text-xs text-muted-foreground">{formatUsd(totalUsd)} · {totalItems} item{totalItems !== 1 ? 's' : ''}</p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Presiona <strong>Cobrar</strong> o <kbd className="rounded border bg-muted px-1 py-px font-mono leading-none">F12</kbd> para registrar el pago
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Agrega productos y selecciona un cliente para cobrar
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ── MOBILE: Barra de totales (sustituye al panel derecho en pantallas pequeñas) ── */}
        <button
          type="button"
          disabled={!tieneContenido}
          onClick={() => tieneContenido && setShowCarritoSheet(true)}
          className="md:hidden shrink-0 rounded-2xl bg-gradient-to-r from-primary/10 to-primary/5 shadow-lg px-4 py-3 flex items-start gap-3 w-full text-left transition-colors disabled:cursor-default active:from-primary/20 active:to-primary/10"
        >
          <div className="flex-1 min-w-0">
            {tieneContenido ? (
              <>
                <p className="text-[10px] font-semibold text-primary/70 uppercase tracking-widest">Total</p>
                <p className="text-2xl font-bold leading-tight tabular-nums">{formatBs(totalBs)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {formatUsd(totalUsd)} · {totalItems} item{totalItems !== 1 ? 's' : ''}
                  {descuentoBs > 0 && (
                    <span className="text-orange-600 ml-2">· Desc. −{formatBs(descuentoBs)}</span>
                  )}
                </p>
              </>
            ) : (
              <>
                <p className="text-[10px] font-semibold text-primary/70 uppercase tracking-widest">Total</p>
                <p className="text-2xl font-bold leading-tight tabular-nums text-muted-foreground">Bs. 0,00</p>
                <p className="text-xs text-muted-foreground mt-0.5">Agrega productos para iniciar</p>
              </>
            )}
          </div>
          {tieneContenido && (
            <ListBullets size={16} className="shrink-0 text-primary/50 mt-0.5" />
          )}
        </button>

        {/* ── FOOTER MOBILE (sm:hidden) — 2 filas ── */}
        <div className="sm:hidden shrink-0 rounded-2xl bg-card shadow-lg px-4 py-2.5 flex flex-col gap-2">
          {/* Fila 1: acciones secundarias (izquierda, sin spacer para evitar overflow) */}
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm"
              onClick={handleGuardarFactura}
              disabled={lineas.length === 0 && cargosEspeciales.length === 0}>
              <FloppyDisk size={14} className="mr-1.5" />Guardar
            </Button>
            <Button variant={esperaCount > 0 ? 'secondary' : 'outline'} size="sm"
              onClick={() => setShowEsperaModal(true)}>
              <ListBullets size={14} className="mr-1.5" />
              {esperaCount > 0 ? `Guardadas (${esperaCount})` : 'Guardadas'}
            </Button>
            <Button variant="outline" size="sm" onClick={handleCancelar}>
              Cancelar
            </Button>
          </div>
          {/* Fila 2: accion principal */}
          <Button size="sm" className="w-full" onClick={handleAbrirCobro} disabled={!puedeAbrir}>
            <ShoppingCart size={14} className="mr-1.5" />
            Cobrar
          </Button>
        </div>

        {/* ── FOOTER DESKTOP (hidden sm:flex) — 1 fila con kbds ── */}
        <div className="hidden sm:flex shrink-0 rounded-2xl bg-card shadow-lg px-4 py-2.5 items-center gap-2">
          <Button variant="outline" size="sm"
            onClick={handleGuardarFactura}
            disabled={lineas.length === 0 && cargosEspeciales.length === 0}>
            <FloppyDisk size={14} className="mr-1.5" />Guardar
            <kbd className="ml-1.5 rounded border bg-muted px-1 py-px text-[10px] font-mono leading-none">F9</kbd>
          </Button>
          <Button variant={esperaCount > 0 ? 'secondary' : 'outline'} size="sm"
            onClick={() => setShowEsperaModal(true)}>
            <ListBullets size={14} className="mr-1.5" />
            {esperaCount > 0 ? `Guardadas (${esperaCount})` : 'Guardadas'}
            <kbd className="ml-1.5 rounded border bg-muted px-1 py-px text-[10px] font-mono leading-none">F10</kbd>
          </Button>
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={handleCancelar}>
            Cancelar<kbd className="ml-1.5 rounded border bg-muted px-1 py-px text-[10px] font-mono leading-none">Esc</kbd>
          </Button>
          <Button size="sm" onClick={handleAbrirCobro} disabled={!puedeAbrir}>
            <ShoppingCart size={14} className="mr-1.5" />
            Cobrar
            <kbd className="ml-1.5 rounded border bg-muted/40 px-1 py-px text-[10px] font-mono leading-none opacity-70">F12</kbd>
          </Button>
        </div>
      </div>

      {/* ── DIALOGS ── */}

      {/* Sheet de operaciones de caja — mobile only */}
      <Sheet open={showCajaSheet} onOpenChange={setShowCajaSheet}>
        <SheetContent side="bottom" className="rounded-t-2xl px-0 pb-6">
          <SheetHeader className="px-4 py-3 border-b">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Wallet size={16} />
              Operaciones de Caja
            </SheetTitle>
          </SheetHeader>
          <div className="p-4 flex flex-col gap-3">
            {canMovManualPos && (
              <div className="grid grid-cols-2 gap-3">
                <button type="button"
                  onClick={() => { setShowCajaSheet(false); setShowIngresoModal(true) }}
                  className="flex items-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm font-medium text-foreground hover:bg-muted transition-colors">
                  <ArrowCircleDown size={20} className="shrink-0 text-green-600" />Ingreso
                </button>
                <button type="button"
                  onClick={() => { setShowCajaSheet(false); setShowRetiroModal(true) }}
                  className="flex items-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm font-medium text-foreground hover:bg-muted transition-colors">
                  <ArrowCircleUp size={20} className="shrink-0 text-red-500" />Retiro
                </button>
                <button type="button"
                  onClick={() => { setShowCajaSheet(false); setShowAvanceModal(true) }}
                  className="flex items-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm font-medium text-foreground hover:bg-muted transition-colors">
                  <Wallet size={20} className="shrink-0 text-amber-500" />Avance
                </button>
                <button type="button"
                  onClick={() => { setShowCajaSheet(false); setShowPrestamoModal(true) }}
                  className="flex items-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm font-medium text-foreground hover:bg-muted transition-colors">
                  <Handshake size={20} className="shrink-0 text-muted-foreground" />Prestamo
                </button>
              </div>
            )}
            {canCloseCajaPos && (
              <button type="button"
                onClick={() => { setShowCajaSheet(false); handleCerrarCajaPos() }}
                className="w-full flex items-center justify-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm font-medium text-destructive hover:bg-muted transition-colors">
                <XCircle size={20} className="shrink-0" />Cerrar Caja
              </button>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Sheet de carrito — vista limpia de items para mobile */}
      <Sheet open={showCarritoSheet} onOpenChange={setShowCarritoSheet}>
        <SheetContent side="bottom" className="h-[75vh] flex flex-col rounded-t-2xl px-0 pb-0">
          <SheetHeader className="px-4 py-3 border-b shrink-0">
            <SheetTitle className="flex items-center gap-2 text-base">
              <ShoppingCart size={16} />
              Carrito · {totalItems} item{totalItems !== 1 ? 's' : ''}
            </SheetTitle>
          </SheetHeader>

          {/* Lista de items */}
          <div className="flex-1 overflow-y-auto">
            {lineas.map((linea, i) => (
              <div key={linea.producto_id} className="flex items-start gap-3 px-4 py-3 border-b last:border-0">
                <span className="text-xs text-muted-foreground w-5 shrink-0 pt-0.5">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium leading-tight">{linea.nombre}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{linea.codigo}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-semibold tabular-nums">{formatUsd(linea.cantidad * linea.precio_unitario_usd)}</p>
                  <p className="text-xs text-muted-foreground tabular-nums">{linea.cantidad} × {formatUsd(linea.precio_unitario_usd)}</p>
                </div>
              </div>
            ))}
            {cargosEspeciales.length > 0 && (
              <>
                <div className="px-4 py-2 bg-amber-50 border-b">
                  <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide">Cargos especiales</p>
                </div>
                {cargosEspeciales.map((cargo, i) => (
                  <div key={i} className="flex items-center justify-between px-4 py-3 border-b last:border-0">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{cargo.descripcion}</p>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">{cargo.tipo}</span>
                    </div>
                    <p className="text-sm font-semibold shrink-0 ml-3 tabular-nums">{formatUsd(cargo.montoCargoUsd)}</p>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Descuento comercial — mobile — pausado, ver DESCUENTOS_HABILITADOS */}
          {DESCUENTOS_HABILITADOS && (
            <div className="shrink-0 border-t">
              {!showDescuento ? (
                <button
                  type="button"
                  onClick={() => setShowDescuento(true)}
                  className="w-full flex items-center gap-1.5 px-4 py-2.5 text-xs text-muted-foreground hover:text-orange-600 transition-colors"
                >
                  <Tag size={12} />
                  Agregar descuento comercial
                </button>
              ) : (
                <div className="px-4 py-3 bg-orange-50/60">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-orange-700 flex items-center gap-1">
                      <Tag size={12} />
                      Descuento comercial
                    </p>
                    <button
                      type="button"
                      onClick={() => { setShowDescuento(false); setDescuentoBs(0); setDescuentoMotivo('') }}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <div className="flex gap-2 items-end">
                    <div className="w-28">
                      <p className="text-[10px] text-muted-foreground mb-0.5">Monto Bs.</p>
                      <Input
                        type="number"
                        min={0}
                        max={totalBs.toNumber()}
                        step={1}
                        value={descuentoBs || ''}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value) || 0
                          setDescuentoBs(Math.min(Math.max(0, v), totalBs.toNumber()))
                        }}
                        className="h-7 text-sm"
                        placeholder="0"
                      />
                    </div>
                    <div className="flex-1">
                      <p className="text-[10px] text-muted-foreground mb-0.5">Motivo</p>
                      <Input
                        type="text"
                        value={descuentoMotivo}
                        onChange={(e) => setDescuentoMotivo(e.target.value)}
                        className="h-7 text-sm"
                        placeholder="Cortesia, ajuste..."
                        maxLength={100}
                      />
                    </div>
                  </div>
                  {descuentoBs > 0 && (
                    <p className="text-xs font-medium text-orange-600 mt-1.5 text-right">
                      −{formatBs(descuentoBs)} ({formatUsd(bsToUsd(descuentoBs, tasaValor))})
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Footer con total */}
          <div className="shrink-0 border-t px-4 py-3 bg-gradient-to-r from-primary/10 to-primary/5">
            {descuentoBs > 0 && (
              <div className="flex justify-between text-xs text-orange-600 mb-1.5">
                <span>Descuento</span>
                <span className="tabular-nums">−{formatBs(descuentoBs)}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">Total</p>
              <div className="text-right">
                <p className="text-xl font-bold tabular-nums">{formatBs(totalBs)}</p>
                <p className="text-xs text-muted-foreground tabular-nums">{formatUsd(totalUsd)}</p>
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <VentaExitosaModal
        isOpen={!!ventaExitosa}
        data={ventaExitosa}
        onClose={() => {
          setVentaExitosa(null)
          setTimeout(() => productoBuscadorRef.current?.focus(), 50)
        }}
      />

      {confirmConfig && (
        <ConfirmDialog
          isOpen={showConfirm}
          onClose={() => {
            setShowConfirm(false)
            setPendingAction(null)
            setConfirmConfig(null)
          }}
          onConfirm={executePendingAction}
          titulo={confirmConfig.titulo}
          mensaje={confirmConfig.mensaje}
          confirmarTexto="Confirmar"
          destructive
        />
      )}

      <SupervisorPinDialog
        isOpen={showSupervisorPin}
        onClose={() => {
          setShowSupervisorPin(false)
          setPendingAction(null)
          setConfirmConfig(null)
        }}
        onAuthorized={() => executePendingAction()}
        titulo={confirmConfig?.titulo ?? 'Autorizacion de Supervisor'}
        mensaje={confirmConfig?.mensaje ?? 'Esta accion requiere autorizacion de un supervisor.'}
      />

      <FacturasEsperaModal
        isOpen={showEsperaModal}
        onClose={() => setShowEsperaModal(false)}
        onRecuperar={handleRecuperarEspera}
      />

      <NuevoClienteRapidoModal
        isOpen={showNuevoClienteModal}
        onClose={() => setShowNuevoClienteModal(false)}
        onCreado={handleNuevoClienteCreado}
      />

      {/* Modal de cobro split-tender */}
      <CobroModal
        isOpen={showCobroModal}
        onClose={() => setShowCobroModal(false)}
        tasa={tasaValor}
        totalBrutoUsd={totalUsd.toNumber()}
        descuentoBs={descuentoBs}
        descuentoMotivo={descuentoMotivo}
        clienteId={clienteId ?? ''}
        clienteNombre={clienteNombre || 'Sin cliente'}
        clienteData={clienteData}
        lineas={lineas}
        cargosEspeciales={cargosEspeciales}
        sesionCajaId={sesion?.id ?? null}
        usuarioId={user?.id ?? ''}
        empresaId={user?.empresa_id ?? ''}
        metodos={metodos}
        depositoId={depositoId}
        onSuccess={(data) => {
          setVentaExitosa(data)
          setShowCobroModal(false)
          resetForm()
        }}
      />

      {/* Modales de caja desde POS */}
      {sesion && (
        <>
          <IngresoRetiroModal
            isOpen={showIngresoModal}
            onClose={() => setShowIngresoModal(false)}
            sesionCajaId={sesion.id}
            modo="INGRESO"
            pendingCajaUsd={pendingCajaUsd}
            pendingCajaBs={pendingCajaBs}
          />
          <IngresoRetiroModal
            isOpen={showRetiroModal}
            onClose={() => setShowRetiroModal(false)}
            sesionCajaId={sesion.id}
            modo="RETIRO"
            pendingCajaUsd={pendingCajaUsd}
            pendingCajaBs={pendingCajaBs}
            cajasFuerteActivas={cajasFuerteActivas}
          />
          <AvanceModal
            isOpen={showAvanceModal}
            onClose={() => setShowAvanceModal(false)}
            sesionCajaId={sesion.id}
            tasaActual={tasaValor}
            clienteNombre={clienteNombre || undefined}
            onAplicado={handleAvanceAplicado}
            pendingCajaUsd={pendingCajaUsd}
            pendingCajaBs={pendingCajaBs}
            cuentas={cuentasTesoreria}
          />
          <PrestamoModal
            isOpen={showPrestamoModal}
            onClose={() => setShowPrestamoModal(false)}
            sesionCajaId={sesion.id}
            tasaActual={tasaValor}
            clienteNombre={clienteNombre || undefined}
            onAplicado={handlePrestamoAplicado}
            pendingCajaUsd={pendingCajaUsd}
            pendingCajaBs={pendingCajaBs}
            cuentas={cuentasTesoreria}
          />
        </>
      )}

      {/* PIN para cerrar caja desde POS (si no tiene permiso directo) */}
      <SupervisorPinDialog
        isOpen={showCierrePosPin}
        onClose={() => setShowCierrePosPin(false)}
        onAuthorized={() => navigateToCuadre()}
        titulo="Cerrar Sesion de Caja"
        mensaje="Ingresa el PIN de supervisor para cerrar la sesion de caja."
        requiredPermission="caja.close"
      />

      {/* Formulario de cierre desde POS */}
      <SesionCajaForm
        mode="cierre"
        isOpen={showCierrePos}
        onClose={() => setShowCierrePos(false)}
        sesionId={sesion?.id}
      />

      {/* Nota de Credito POS-express (Slice 5a-2a) — auto-contenido, no
          comparte estado con el carrito/CobroModal */}
      <NotaCreditoPosModal
        isOpen={showNotaCreditoModal}
        onClose={() => setShowNotaCreditoModal(false)}
        sesion={sesion}
      />
    </>
  )
}
