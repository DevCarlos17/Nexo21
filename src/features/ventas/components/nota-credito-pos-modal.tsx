import { useState, useRef, useEffect, useMemo } from 'react'
import Decimal from 'decimal.js'
import { X, Warning, MagnifyingGlass } from '@phosphor-icons/react'
import { formatUsd, formatBs, formatTasa } from '@/lib/currency'
import { formatDateTime } from '@/lib/format'
import {
  crearNotaCredito,
  useReversosFactura,
  type LiquidacionModalidad,
  type FacturaParaAnular,
  type LineaNcSeleccionada,
} from '../hooks/use-notas-credito'
import { useFacturasSesionActiva, useBadgesReversoSesion } from '../hooks/use-facturas-sesion-activa'
import { resolverDepositoOverride } from '../utils/notas-credito-pin-gating'
import {
  derivarEstadoPago,
  facturaCoincideBusqueda,
  ESTADO_PAGO_LABEL,
  puedeEmitirNcAdicional,
  puedeElegirTipoTotal,
  calcularReversoPorLinea,
  agruparReversosPorNc,
  resolverBadgesFactura,
  debeMostrarBadgeAdministracion,
  type EstadoPago,
  type BadgeReverso,
} from '../utils/notas-credito-ui'
import { buildReciboData, type ReciboData, type TipoImpuestoLinea } from '../utils/factura-export'
import { FacturaDetallePanel } from './factura-detalle-panel'
import { SeleccionLineasNc, type LineaSeleccionNc } from './seleccion-lineas-nc'
import { useDetalleFactura, usePagosFactura } from '@/features/cxc/hooks/use-cxc'
import { useCompany } from '@/features/configuracion/hooks/use-company'
import { useCurrentUser } from '@/core/hooks/use-current-user'
import { usePermissions, PERMISSIONS } from '@/core/hooks/use-permissions'
import { useDepositosVentaActivos } from '@/features/inventario/hooks/use-depositos'
import { useMetodosPagoActivos } from '@/features/configuracion/hooks/use-payment-methods'
import { useCuentasTesoreria } from '@/features/tesoreria/hooks/use-cuentas-tesoreria'
import { SupervisorPinDialog } from '@/components/ui/supervisor-pin-dialog'
import { NativeSelect } from '@/components/ui/native-select'
import { Badge } from '@/components/ui/badge'
import { OrigenDineroPicker, type OrigenDineroPickerResultado } from './origen-dinero-picker'
import {
  type CuentaOrigenDineroOption,
  normalizarMonedaOrigen,
} from '../utils/origen-dinero-picker'
import { toast } from 'sonner'
import type { SesionCaja } from '@/features/caja/hooks/use-sesiones-caja'

/** Mismo mapeo que `venta-exitosa-modal.tsx` (Design §Decision 5) — no una formula nueva. */
function toTipoImpuestoLinea(val: string): TipoImpuestoLinea {
  return val === 'Gravable' || val === 'Exonerado' ? val : 'Exento'
}

interface NotaCreditoPosModalProps {
  isOpen: boolean
  onClose: () => void
  /** Sesion de caja actualmente abierta del cajero — null bloquea el flujo (sin sesion, sin NC-POS). */
  sesion: SesionCaja | null
}

/**
 * Modalidades ofrecidas desde el POS-express (Slice 5a-2a). `REFUND_TESORERIA`
 * queda deliberadamente excluida — Design/tasks (Slice 6, task 6.3) la
 * reserva SOLO al modulo Tradicional, nunca al POS.
 */
const MODALIDADES_POS: { value: LiquidacionModalidad; label: string }[] = [
  { value: 'EFECTIVO_REAL', label: 'Efectivo / tarjeta (afecta el cuadre de esta sesion)' },
  { value: 'SALDO_FAVOR', label: 'Saldo a favor del cliente' },
  { value: 'AJUSTE_CXC', label: 'Ajuste de cuentas por cobrar' },
  { value: 'COMPENSACION_VENTA', label: 'Compensar con una venta nueva' },
]

/**
 * Slice 4 (multi-origin picker UI): el reintegro real de efectivo (write-core
 * de `crearNotaCredito`, paso 6c) solo esta cableado para `tipoNc==='TOTAL'`
 * — la combinacion `PARCIAL` + `EFECTIVO_REAL` no fue disenada aun (deferida
 * a Slice 5a, ver comentario en `use-notas-credito.ts` linea ~1018) y hoy
 * enrutaria el dinero elegido en el picker COMPLETO a credito a favor (SAFC)
 * en silencio, sin devolverlo — un "reintegro fantasma" que engañaria al
 * cajero. Se retira `EFECTIVO_REAL` de las modalidades ofrecidas cuando
 * `tipoNc==='PARCIAL'` para no exponer una combinacion que el backend no
 * soporta todavia.
 */
function modalidadesParaTipoNc(tipoNc: 'TOTAL' | 'PARCIAL') {
  return tipoNc === 'PARCIAL' ? MODALIDADES_POS.filter((m) => m.value !== 'EFECTIVO_REAL') : MODALIDADES_POS
}

/**
 * F2 QA fix (Slice 5c, parche visual pendiente de rediseno futuro): cada
 * estado de pago tiene su propio color — antes de este fix "Contado",
 * "Crédito" y "Abonada" compartian el mismo gris (`border-slate-200`), sin
 * distincion visual entre ellos.
 */
const ESTADO_PAGO_BADGE_CLASS: Record<EstadoPago, string> = {
  CONTADO: 'border-green-200 bg-green-50 text-green-700',
  CREDITO: 'border-blue-200 bg-blue-50 text-blue-700',
  ABONADA: 'border-amber-200 bg-amber-50 text-amber-700',
}

/**
 * Badges de estado de pago + reverso de una fila del listado (Slice 2, Spec
 * notas-credito-pos: "Badges de estado de pago y reverso"). Puede combinar el
 * badge de pago con el badge de reverso.
 *
 * QA fix 3.5 (Slice 5e): `badgeReverso` viene de `useBadgesReversoSesion`
 * (facturado vs reversado ACUMULADO linea por linea) — NUNCA se deriva de
 * `f.tiene_reverso_total`/`tiene_reverso_parcial` (esos flags siguen vigentes
 * SOLO para el gating de ACCION en `puedeEmitirNcAdicional`/
 * `puedeElegirTipoTotal`, sin relacion con este badge).
 *
 * BUG D fix: la decision de que badges mostrar (pago suprimido cuando el
 * reverso es TOTAL, ver `resolverBadgesFactura`) es PURA — este componente
 * es un renderer delgado que solo consume su resultado.
 */
function FacturaBadges({ f, badgeReverso }: { f: FacturaParaAnular; badgeReverso: BadgeReverso }) {
  const badges = resolverBadgesFactura(derivarEstadoPago(f), badgeReverso)
  return (
    <div className="flex flex-wrap items-center gap-1">
      {badges.estadoPago && (
        <Badge variant="outline" className={ESTADO_PAGO_BADGE_CLASS[badges.estadoPago]}>
          {ESTADO_PAGO_LABEL[badges.estadoPago]}
        </Badge>
      )}
      {badges.reverso === 'TOTAL' && (
        <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700">
          Reverso Total
        </Badge>
      )}
      {badges.reverso === 'PARCIAL' && (
        <Badge variant="outline" className="border-orange-200 bg-orange-50 text-orange-700">
          Reverso Parcial
        </Badge>
      )}
      {debeMostrarBadgeAdministracion(f) && (
        <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
          Vía administración
        </Badge>
      )}
    </div>
  )
}

/**
 * Entrada POS-express de Notas de Credito (Slice 5a-2a, Spec
 * notas-credito-pos). Auto-contenido a proposito — NO importa ni toca
 * `cobro-modal.tsx` ni `facturas-espera-store.ts`: es un flujo lateral
 * independiente del carrito de venta, montado como sibling en
 * `pos-terminal.tsx`, para no arriesgar el flujo de venta.
 *
 * Alcance de este slice: NC tipo TOTAL unicamente (sin seleccion de lineas
 * — esa UI es un slice futuro separado, obs #2842).
 *
 * DOS autorizaciones SEPARADAS (Slice 5a-2b, obs #2835/#2842/#2802):
 * - PIN A (emision, por-falta-de-permiso): decide si el usuario actual
 *   puede emitir la NC sin PIN.
 * - PIN B (override de deposito, friccion deliberada — Opcion B): por
 *   defecto el modal usa el riel automatico interno de `crearNotaCredito`
 *   (sin `depositoReingresoId`). Cambiar el deposito de reingreso requiere
 *   un SEGUNDO PIN de supervisor, independiente del PIN A — un usuario
 *   puede enfrentar ninguno, uno o ambos PINs en la misma emision.
 */
export function NotaCreditoPosModal({ isOpen, onClose, sesion }: NotaCreditoPosModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { user } = useCurrentUser()
  const { hasPermission } = usePermissions()
  const { facturas, isLoading } = useFacturasSesionActiva()
  const { depositos: depositosActivos } = useDepositosVentaActivos()
  // QA fix 3.5 (Slice 5e): badge de reverso ACUMULADO por venta_id, para
  // TODAS las facturas de la sesion — se pasa a `FacturaBadges` en el
  // listado (ver mas abajo).
  const { badgesPorVenta } = useBadgesReversoSesion(user?.empresa_id ?? '', sesion?.id ?? '')

  // Slice 4 (multi-origin picker UI, Design §Decision 5): cuentas reales
  // seleccionables por el picker de origen de dinero. `SESION_EFECTIVO` se
  // restringe a los `metodos_cobro` tipo EFECTIVO de la empresa (mismo
  // lookup que `ingreso-retiro-modal.tsx:63-64` — "Efectivo USD"/"Efectivo
  // Bs"), NUNCA a la sesion como cuenta (esa reinterpretacion es exactamente
  // lo que Decision 5 exige y el stub pre-Slice-4 todavia no hacia).
  // Tesoreria/Banco se reusan de `useCuentasTesoreria` (Tesoreria feature) —
  // sin duplicar la query.
  const { metodos: metodosPago } = useMetodosPagoActivos()
  const { cuentas: cuentasTesoreriaRaw } = useCuentasTesoreria()
  const cuentasSesionOrigen: CuentaOrigenDineroOption[] = metodosPago
    .filter((m) => m.tipo === 'EFECTIVO')
    .map((m) => ({
      tipo: 'SESION_EFECTIVO' as const,
      cuentaId: m.id,
      label: m.nombre,
      moneda: m.moneda === 'BS' ? 'BS' : 'USD',
      saldoActual: m.saldo_actual,
    }))
  const cuentasTesoreriaOrigen: CuentaOrigenDineroOption[] = cuentasTesoreriaRaw
    .filter((c) => c.tipo === 'CAJA_FUERTE')
    .map((c) => ({
      tipo: 'TESORERIA_EFECTIVO' as const,
      cuentaId: c.id,
      label: c.nombre,
      moneda: normalizarMonedaOrigen(c.moneda_codigo),
      saldoActual: c.saldo_actual,
    }))
  const cuentasBancoOrigen: CuentaOrigenDineroOption[] = cuentasTesoreriaRaw
    .filter((c) => c.tipo === 'BANCO')
    .map((c) => ({
      tipo: 'BANCO' as const,
      cuentaId: c.id,
      label: c.nombre,
      moneda: normalizarMonedaOrigen(c.moneda_codigo),
      saldoActual: c.saldo_actual,
    }))
  const [origenDineroResultado, setOrigenDineroResultado] = useState<OrigenDineroPickerResultado | null>(
    null
  )

  const [facturaId, setFacturaId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [modalidad, setModalidad] = useState<LiquidacionModalidad>('EFECTIVO_REAL')
  const [motivo, setMotivo] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPin, setShowPin] = useState(false)
  // PIN B (override de deposito, Slice 5a-2b) — SEPARADO de `showPin`/PIN A.
  const [showPinDeposito, setShowPinDeposito] = useState(false)
  const [pinDepositoAutorizado, setPinDepositoAutorizado] = useState(false)
  const [depositoElegidoId, setDepositoElegidoId] = useState<string | null>(null)
  // Eleccion TOTAL/PARCIAL (Slice 3b, Spec notas-credito-pos: "Seleccion de
  // tipo de nota de credito"). TOTAL es el default — preserva el flujo
  // pre-existente byte-a-byte (mismo `crearNotaCredito` sin `tipo`/`lineas`).
  const [tipoNc, setTipoNc] = useState<'TOTAL' | 'PARCIAL'>('TOTAL')
  // Lineas PARCIAL pendientes de PIN A — solo se usan si el usuario confirmo
  // sin permiso y debe autorizar antes de que `emitirNc` se dispare de nuevo.
  const [lineasParcialPendientes, setLineasParcialPendientes] = useState<LineaNcSeleccionada[] | null>(null)
  // Accion pendiente detras del MISMO PIN A (Slice 4, Design §Decision 9):
  // "Nota de credito" y el placeholder "Editar metodos de pago" comparten un
  // unico SupervisorPinDialog — este estado le dice a `onAuthorized` cual de
  // las dos funciones debe disparar tras la autorizacion.
  const [accionPendiente, setAccionPendiente] = useState<'NC' | 'EDITAR_PAGOS' | null>(null)
  // Behavior F (Slice 5g.5): contador incrementado en CADA emision exitosa
  // — se usa como parte del `key` de `SeleccionLineasNc` mas abajo. El modal
  // ya NO se cierra tras emitir (permanece abierto sobre la MISMA factura,
  // que se refresca sola via las live-queries de PowerSync), por lo que
  // `SeleccionLineasNc` NUNCA se desmonta entre una emision PARCIAL y la
  // siguiente. Sin este contador, su estado interno (`cantidades`/
  // `excedidas`, uncontrolled) sobreviviria la emision y permitiria
  // re-enviar por accidente la MISMA cantidad ya acreditada (double-submit).
  // Cambiar el `key` fuerza un remount limpio tras cada emision exitosa.
  const [emisionGen, setEmisionGen] = useState(0)

  /**
   * UX B QA fix (Slice 5e): las autorizaciones de PIN son EFIMERAS —
   * escopeadas a un unico proceso de NC sobre UNA factura. Se limpian al
   * cerrar el modal, al deseleccionar la factura ("Volver") y al
   * seleccionar una factura distinta — nunca sobreviven a ese cambio de
   * contexto. Reingresar el MISMO PIN para una accion nueva es aceptable
   * (obs #2902) — esto NO fusiona PIN A y PIN B, solo evita que una
   * autorizacion ya usada quede "recordada" para la siguiente factura.
   */
  function resetAutorizacionesPin() {
    setShowPin(false)
    setShowPinDeposito(false)
    setPinDepositoAutorizado(false)
    setDepositoElegidoId(null)
    setAccionPendiente(null)
    setLineasParcialPendientes(null)
    setOrigenDineroResultado(null)
  }

  useEffect(() => {
    if (isOpen) {
      dialogRef.current?.showModal()
    } else {
      dialogRef.current?.close()
      setFacturaId(null)
      setSearchQuery('')
      setModalidad('EFECTIVO_REAL')
      setMotivo('')
      setTipoNc('TOTAL')
      setEmisionGen(0)
      resetAutorizacionesPin()
    }
  }, [isOpen])

  function handleBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === dialogRef.current) onClose()
  }

  // Slice 4: PARCIAL nunca ofrece EFECTIVO_REAL (ver `modalidadesParaTipoNc`)
  // — si el usuario cambia a PARCIAL con EFECTIVO_REAL ya elegido, cae a un
  // default seguro no-desembolso en vez de quedar en un valor invalido.
  useEffect(() => {
    if (tipoNc === 'PARCIAL' && modalidad === 'EFECTIVO_REAL') {
      setModalidad('SALDO_FAVOR')
    }
  }, [tipoNc, modalidad])

  const factura = facturas.find((f) => f.id === facturaId) ?? null

  // Filtro client-side sobre la lista ya escopeada por query (Slice 2, Spec
  // notas-credito-pos: buscador por numero, cliente o estado) — sin nueva
  // query, se recalcula en cada render sobre `facturas`.
  const facturasFiltradas = useMemo(
    () => facturas.filter((f) => facturaCoincideBusqueda(f, searchQuery)),
    [facturas, searchQuery]
  )

  // Panel de detalle fiscal (Slice 3a, Design §Decision 5) — reusa
  // buildReciboData/construirFilasTotales, NUNCA recalcula montos de forma
  // independiente. Mismo mapeo detalle->ReciboLineaInput que
  // venta-exitosa-modal.tsx:94-101.
  const { detalle } = useDetalleFactura(facturaId)
  const { pagos: pagosFactura } = usePagosFactura(facturaId)
  const { company } = useCompany()

  // F1 QA fix (Slice 5a): historial de NC(s) ya aplicadas a la factura
  // seleccionada — alimenta (a) la seccion aditiva del panel de detalle y
  // (b) el tope de remanente por linea que consume SeleccionLineasNc.
  const { reversos } = useReversosFactura(facturaId, user?.empresa_id ?? '')
  const historialReversos = useMemo(() => agruparReversosPorNc(reversos), [reversos])

  // QA fix 5f (consistencia badge/gating): MISMA fuente acumulada por-linea
  // que alimenta el badge del listado (`calcularBadgesReversoPorVenta`, via
  // `useBadgesReversoSesion`) — `reversos` ya esta cargado arriba para el
  // historial, se reusa aqui SIN disparar una query redundante.
  const lineasFacturaParaReverso = useMemo(
    () => detalle.map((d) => ({ venta_det_id: d.id, cantidad_facturada: d.cantidad })),
    [detalle]
  )

  // Gating de ACCION (NO de seleccion, Spec/QA fix F1+5f): reversado TOTAL
  // ACUMULADO (cualquier combinacion de NCs TOTAL/PARCIAL que complete el
  // 100% de cada linea) bloquea cualquier NC adicional; reversado PARCIAL
  // (sin completar el 100%) solo bloquea la opcion TOTAL, PARCIAL sigue
  // disponible sobre el remanente. Antes de este fix se leia el flag CRUDO
  // `tiene_reverso_total`/`tiene_reverso_parcial` (solo por-NC individual),
  // desincronizado del badge acumulado — ver `calcularEstadoReversoLineas`.
  const puedeEmitirNc = puedeEmitirNcAdicional(lineasFacturaParaReverso, reversos)
  const puedeTotal = puedeElegirTipoTotal(lineasFacturaParaReverso, reversos)

  // UX C QA fix (Slice 5e): con el selector de deposito desbloqueado (PIN B
  // autorizado) el usuario DEBE elegir un deposito concreto — el placeholder
  // "Seleccionar deposito..." nunca puede quedar seleccionado al confirmar.
  // Sin autorizar PIN B (riel automatico por defecto) esto nunca bloquea.
  const depositoInvalido = pinDepositoAutorizado && !depositoElegidoId

  // Slice 4: el picker de origen de dinero solo aplica a EFECTIVO_REAL +
  // TOTAL (ver `modalidadesParaTipoNc` — PARCIAL nunca ofrece EFECTIVO_REAL).
  // `remanenteUsd` espeja `remanenteALiquidar` del backend para TOTAL:
  // `total_usd - saldo_pend_usd` (lo YA cubierto en la venta original no
  // necesita reintegrarse, invariante `total_usd >= saldo_pend_usd`).
  const mostrarOrigenDineroPicker = modalidad === 'EFECTIVO_REAL' && tipoNc === 'TOTAL'
  const remanenteUsd = factura
    ? Decimal.max(new Decimal(0), new Decimal(factura.total_usd).minus(factura.saldo_pend_usd)).toFixed(2)
    : '0'
  const origenDineroInvalido = mostrarOrigenDineroPicker && !(origenDineroResultado?.valido ?? false)

  const recibo: ReciboData | null = useMemo(() => {
    if (!factura) return null
    return buildReciboData({
      nroFactura: factura.nro_factura,
      fecha: factura.fecha,
      emisor: { nombre: company?.nombre ?? '', rif: company?.rif ?? null, direccion: company?.direccion ?? null },
      cliente: { nombre: factura.cliente_nombre, identificacion: factura.cliente_identificacion, direccion: null },
      lineas: detalle.map((d) => ({
        codigo: d.producto_codigo,
        nombre: d.producto_nombre,
        cantidad: d.cantidad,
        precioUnitarioUsd: d.precio_unitario_usd,
        tipoImpuesto: toTipoImpuestoLinea(d.tipo_impuesto),
        impuestoPct: d.impuesto_pct,
      })),
      // SIEMPRE la tasa historica de la factura — nunca la tasa vigente del sistema.
      tasa: factura.tasa,
      igtfUsd:
        factura.total_igtf_usd && Number(factura.total_igtf_usd) > 0 ? Number(factura.total_igtf_usd) : null,
      pagos: pagosFactura.map((p) => ({
        metodo_cobro_id: p.metodo_cobro_id,
        metodo_nombre: p.metodo_nombre,
        moneda: p.moneda_label as 'USD' | 'BS',
        monto: Number(p.monto),
      })),
      discrepancy: null,
      saldoPendUsd: Number(factura.saldo_pend_usd),
    })
  }, [factura, detalle, pagosFactura, company])

  // Lineas candidatas a NC PARCIAL (Slice 3b, Design §Decision 7) — mismo
  // `detalle` de `useDetalleFactura` ya usado para el panel de detalle,
  // mapeado al contrato de presentacion de `SeleccionLineasNc`.
  const lineasParaNc: LineaSeleccionNc[] = useMemo(
    () =>
      detalle.map((d) => {
        // F1 QA fix: el remanente real (facturado - ya reversado por NCs
        // previas) es el TOPE efectivo, no la cantidad originalmente
        // facturada — evita sobre-reversar una linea ya parcialmente
        // acreditada (mismo criterio que el guard del backend).
        const { restante } = calcularReversoPorLinea(d.id, d.cantidad, reversos)
        return {
          venta_det_id: d.id,
          producto_nombre: d.producto_nombre,
          producto_codigo: d.producto_codigo,
          cantidadFacturada: Number(d.cantidad),
          cantidadDisponible: restante.toNumber(),
          esDecimal: d.es_decimal === 1,
          precioUnitarioUsd: Number(d.precio_unitario_usd),
          tipoImpuesto: toTipoImpuestoLinea(d.tipo_impuesto),
          impuestoPct: Number(d.impuesto_pct),
        }
      }),
    [detalle, reversos]
  )

  /**
   * `lineasParcial` presente + no vacio → NC PARCIAL (Design §Interfaces,
   * Slice 3b). Ausente → NC TOTAL, comportamiento pre-existente byte-a-byte
   * (mismo `crearNotaCredito` sin `tipo`/`lineas`, Spec: "NC TOTAL reversa
   * la factura completa").
   */
  async function emitirNc(lineasParcial?: LineaNcSeleccionada[]) {
    if (!factura || !user?.empresa_id || !sesion) return
    setLoading(true)
    try {
      const result = await crearNotaCredito({
        venta_id: factura.id,
        motivo: motivo.trim() || 'Anulacion desde POS',
        usuario_id: user.id,
        empresa_id: user.empresa_id,
        // Entrada POS-express: SIEMPRE la sesion activa del cajero — la
        // lista ya viene escopeada query-side (useFacturasSesionActiva).
        entryPoint: 'POS',
        sesionCajaActivaId: sesion.id,
        modalidad,
        // Slice 2 REWORK (Design §Decision 5): SOLO EFECTIVO_REAL mueve
        // dinero — `origenDinero` queda OMITIDO (array vacio/undefined)
        // para SALDO_FAVOR/AJUSTE_CXC/COMPENSACION_VENTA (el gate extension
        // de `validarOrigenDinero` rechaza si se envia igual). El
        // POS-express esta SIEMPRE restringido a su propia sesion activa
        // (carril protegido, Design §Decision 4) — nunca ofrece elegir
        // otra cuenta (no hay selector de sesion en `OrigenDineroPicker`
        // para POS, `mostrarSelectorSesion=false`).
        // Slice 4: reemplaza el stub pre-existente — `origenDineroResultado`
        // viene del picker multi-origen, ya resuelto contra `metodos_cobro`/
        // `caja_fuerte`/`bancos_empresa` reales (Decision 5), nunca contra
        // `sesion.id`. `handleConfirmarClick` ya garantiza que este objeto
        // existe y es valido antes de permitir llegar aqui.
        ...(mostrarOrigenDineroPicker && origenDineroResultado
          ? { origenDinero: origenDineroResultado.origenDinero }
          : {}),
        ...(lineasParcial ? { tipo: 'PARCIAL' as const, lineas: lineasParcial } : {}),
        // PIN B (Slice 5a-2b): `resolverDepositoOverride` retorna `null`
        // salvo que el segundo PIN ya haya autorizado el override Y el
        // usuario ya haya elegido un deposito — en cuyo caso retorna ese id.
        // `null` se convierte a `undefined` para que `crearNotaCredito`
        // caiga en su riel automatico existente (mismo contrato que el
        // selector Tradicional en `crear-ncr-modal.tsx`).
        depositoReingresoId:
          resolverDepositoOverride({
            pinOverrideAutorizado: pinDepositoAutorizado,
            depositoElegidoId,
          }) ?? undefined,
      })
      toast.success(`Nota de credito ${result.nroNcr} creada exitosamente`)
      // Behavior F (Slice 5g.5): el modal ya NO se cierra tras una emision
      // exitosa — permanece abierto sobre la MISMA factura (`facturaId` y
      // `searchQuery` se preservan a proposito) para que el usuario vea el
      // resultado y pueda seguir operando. El listado, los badges, el panel
      // de detalle y el historial de reversos son TODOS live-queries de
      // PowerSync (`useQuery`) — se refrescan solos cuando la transaccion de
      // `crearNotaCredito` hace commit, SIN invalidacion manual. Lo que SI
      // hay que resetear explicitamente es el estado transitorio de ESTA
      // accion, que antes limpiaba `onClose()` via el efecto de `isOpen`:
      resetAutorizacionesPin()
      setMotivo('')
      setModalidad('EFECTIVO_REAL')
      setEmisionGen((gen) => gen + 1)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error al crear nota de credito')
    } finally {
      setLoading(false)
    }
  }

  function handleConfirmarClick() {
    // UX C QA fix: defensa en profundidad — el boton ya viene `disabled`
    // cuando falta elegir deposito, este guard cubre cualquier disparo
    // programatico del handler.
    if (depositoInvalido) return
    // Slice 4: mismo patron de defensa en profundidad — el boton ya viene
    // `disabled` mientras el picker de origen de dinero no sea valido
    // (EFECTIVO_REAL + TOTAL).
    if (origenDineroInvalido) return
    // PIN A (Spec notas-credito-pos, obs #2835 regla definitiva): solo se
    // pide PIN cuando el usuario actual NO tiene el permiso de emision de
    // NC — con permiso, emite directo, sin friccion.
    setLineasParcialPendientes(null)
    setAccionPendiente('NC')
    if (hasPermission(PERMISSIONS.SALES_NOTA_CREDITO)) {
      void emitirNc()
    } else {
      setShowPin(true)
    }
  }

  /**
   * Confirmar de `SeleccionLineasNc` (Slice 3b, Design §Decision 7): mismo
   * gating de permiso/PIN A que TOTAL — el permiso NUNCA distingue por tipo
   * de NC (Spec: "Permiso determina el PIN para ambas acciones").
   */
  function handleConfirmarParcialClick(lineas: LineaNcSeleccionada[]) {
    // UX C QA fix: mismo guard de defensa en profundidad que TOTAL.
    if (depositoInvalido) return
    setAccionPendiente('NC')
    if (hasPermission(PERMISSIONS.SALES_NOTA_CREDITO)) {
      void emitirNc(lineas)
    } else {
      setLineasParcialPendientes(lineas)
      setShowPin(true)
    }
  }

  /**
   * Placeholder "Editar metodos de pago" (Slice 4, Design §Decision 9, Spec
   * notas-credito-pos: "Boton 'Editar metodos de pago' como placeholder").
   * CERO mutacion de datos — nunca llama `crearNotaCredito` ni ninguna otra
   * escritura. Existe unicamente para reservar el slot de UI, gateado por el
   * MISMO permiso/PIN A que "Nota de credito".
   */
  function ejecutarEditarPagosPlaceholder() {
    toast.info('Funcion "Editar metodos de pago" aun no implementada')
  }

  function handleEditarPagosClick() {
    setAccionPendiente('EDITAR_PAGOS')
    if (hasPermission(PERMISSIONS.SALES_NOTA_CREDITO)) {
      ejecutarEditarPagosPlaceholder()
    } else {
      setShowPin(true)
    }
  }

  return (
    <>
      <dialog
        ref={dialogRef}
        onClose={onClose}
        onClick={handleBackdropClick}
        className="backdrop:bg-black/50 rounded-lg p-0 w-full max-w-4xl shadow-xl max-h-[85vh]"
      >
        <div className="p-6 flex flex-col max-h-[85vh]">
          <div className="flex items-start justify-between mb-4 shrink-0">
            <h2 className="text-lg font-semibold">Nota de Credito — Sesion Actual</h2>
            <button onClick={onClose} className="p-1 rounded-md hover:bg-muted transition-colors">
              <X className="h-5 w-5 text-muted-foreground" />
            </button>
          </div>

          {!sesion ? (
            <p className="text-sm text-muted-foreground">No hay sesion de caja activa</p>
          ) : (
            // Layout de dos columnas (Slice 3a, reemplaza el drill-down
            // single-view anterior): lista+buscador a la izquierda (Slice 2),
            // panel de detalle fiscal montado a la derecha (Design §Decision 5).
            <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4 min-h-0">
              <div className="flex flex-col min-h-0">
                {facturas.length > 0 && (
                  <div className="relative mb-2 shrink-0">
                    <MagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Buscar por numero, cliente o estado..."
                      className="w-full rounded-md border border-input bg-background pl-8 pr-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                )}
                <div className="flex-1 overflow-y-auto space-y-1.5">
                  {isLoading ? (
                    Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="h-12 bg-muted rounded animate-pulse" />
                    ))
                  ) : facturas.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-6 text-center">
                      No hay facturas en esta sesion todavia.
                    </p>
                  ) : facturasFiltradas.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-6 text-center">
                      Ninguna factura coincide con la busqueda.
                    </p>
                  ) : (
                    facturasFiltradas.map((f) => {
                      // F1 QA fix (resuelve WARNING #2, obs #2877): una
                      // factura ya reversada (TOTAL o PARCIAL) permanece
                      // SELECCIONABLE — el gating se movio de la SELECCION a
                      // la ACCION (ver `puedeEmitirNc`/`puedeTotal` mas
                      // abajo, sobre la factura ya seleccionada).
                      const seleccionada = f.id === facturaId
                      return (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => {
                            setFacturaId(f.id)
                            // Guess INICIAL del tab (TOTAL/PARCIAL) a partir
                            // de los flags crudos ya disponibles en el
                            // listado (sin gap async, a diferencia de
                            // `detalle`/`reversos` que aun no cargaron para
                            // ESTA factura) — es solo el tab por defecto, NO
                            // el gating real: `puedeTotal`/`puedeEmitirNc`
                            // (fuente acumulada) son los que deciden que
                            // botones se muestran una vez cargados los datos.
                            setTipoNc(f.tiene_reverso_total !== 1 && f.tiene_reverso_parcial !== 1 ? 'TOTAL' : 'PARCIAL')
                            // UX B QA fix: seleccionar (incluso re-seleccionar)
                            // una factura arranca un proceso de NC nuevo — la
                            // autorizacion de PIN de la factura anterior nunca
                            // debe quedar vigente para esta.
                            resetAutorizacionesPin()
                          }}
                          className={`w-full flex items-center justify-between rounded-lg border p-3 text-left transition-colors ${
                            seleccionada ? 'border-primary bg-muted' : 'hover:bg-muted'
                          }`}
                        >
                          <div className="min-w-0">
                            <p className="text-xs text-muted-foreground">{formatDateTime(f.fecha)}</p>
                            <p className="text-sm font-medium">#{f.nro_factura}</p>
                            <p className="text-xs text-muted-foreground truncate">{f.cliente_nombre}</p>
                            <div className="mt-1">
                              <FacturaBadges f={f} badgeReverso={badgesPorVenta[f.id] ?? null} />
                            </div>
                          </div>
                          <div className="text-right shrink-0 pl-2">
                            <p className="text-sm font-semibold">{formatUsd(f.total_usd)}</p>
                            <p className="text-xs text-muted-foreground">{formatBs(f.total_bs)}</p>
                          </div>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>

              <div className="flex flex-col min-h-0 md:border-l md:pl-4 overflow-y-auto">
                {factura && (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 px-4 pt-1 pb-2 text-sm">
                    <div>
                      <span className="text-muted-foreground">Cliente:</span> {factura.cliente_nombre}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Tasa:</span> {formatTasa(factura.tasa)}
                    </div>
                  </div>
                )}

                <FacturaDetallePanel
                  recibo={recibo}
                  reversos={historialReversos}
                  badgeReverso={badgesPorVenta[facturaId ?? ''] ?? null}
                />

                {factura && !puedeEmitirNc && (
                  // F1 QA fix: reversado TOTAL -> vista de solo-lectura, sin
                  // ofrecer ninguna accion de emision de NC (el detalle de
                  // arriba, incluido el historial de reversos, ya cubre la
                  // trazabilidad completa de lo ocurrido con esta factura).
                  <div className="px-4 pb-4">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-muted-foreground">
                      Esta factura ya fue reversada totalmente. No es posible emitir una nueva nota de credito.
                    </div>
                  </div>
                )}

                {factura && puedeEmitirNc && (
                  <div className="space-y-4 px-4 pb-4">
                    <div className="rounded-lg border p-3">
                      <p className="text-xs font-semibold text-muted-foreground mb-2">
                        Tipo de nota de credito
                      </p>
                      <div className="flex gap-2">
                        {puedeTotal && (
                          <button
                            type="button"
                            onClick={() => setTipoNc('TOTAL')}
                            aria-pressed={tipoNc === 'TOTAL'}
                            className={`flex-1 px-3 py-1.5 text-sm rounded-md border transition-colors ${
                              tipoNc === 'TOTAL' ? 'border-primary bg-muted font-medium' : 'hover:bg-muted'
                            }`}
                          >
                            Total
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setTipoNc('PARCIAL')}
                          aria-pressed={tipoNc === 'PARCIAL'}
                          className={`flex-1 px-3 py-1.5 text-sm rounded-md border transition-colors ${
                            tipoNc === 'PARCIAL' ? 'border-primary bg-muted font-medium' : 'hover:bg-muted'
                          }`}
                        >
                          Parcial
                        </button>
                      </div>
                      {!puedeTotal && (
                        <p className="text-xs text-orange-600 mt-1.5">
                          Esta factura ya tiene una NC parcial aplicada — solo se puede reversar el remanente por linea.
                        </p>
                      )}
                    </div>

                    <div className="rounded-lg border p-3">
                      <p className="text-xs font-semibold text-muted-foreground mb-2">
                        Modalidad de liquidacion
                      </p>
                      <NativeSelect
                        value={modalidad}
                        onChange={(e) => setModalidad(e.target.value as LiquidacionModalidad)}
                        className="text-sm"
                      >
                        {modalidadesParaTipoNc(tipoNc).map((m) => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </NativeSelect>
                      {modalidad === 'EFECTIVO_REAL' && (
                        <p className="text-xs text-amber-600 mt-1.5">
                          Esta modalidad afecta el cuadre de la sesion activa (salida real de efectivo/tarjeta).
                        </p>
                      )}
                    </div>

                    {mostrarOrigenDineroPicker && (
                      <div className="rounded-lg border p-3">
                        <p className="text-xs font-semibold text-muted-foreground mb-2">
                          Origen del reintegro
                        </p>
                        <OrigenDineroPicker
                          remanenteUsd={remanenteUsd}
                          tasa={factura.tasa}
                          cuentasSesion={cuentasSesionOrigen}
                          cuentasTesoreria={cuentasTesoreriaOrigen}
                          cuentasBanco={cuentasBancoOrigen}
                          mostrarSelectorSesion={false}
                          sesionesDisponibles={[]}
                          onChange={setOrigenDineroResultado}
                        />
                      </div>
                    )}

                    <div className="rounded-lg border p-3">
                      <p className="text-xs font-semibold text-muted-foreground mb-2">
                        Deposito de reingreso de stock
                      </p>
                      {!pinDepositoAutorizado ? (
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm text-muted-foreground">
                            Automatico (riel de deposito principal)
                          </p>
                          <button
                            type="button"
                            onClick={() => setShowPinDeposito(true)}
                            className="text-xs text-primary hover:underline shrink-0"
                          >
                            Cambiar deposito
                          </button>
                        </div>
                      ) : (
                        <NativeSelect
                          value={depositoElegidoId ?? ''}
                          onChange={(e) => setDepositoElegidoId(e.target.value || null)}
                          className="text-sm"
                        >
                          <option value="">Seleccionar deposito...</option>
                          {depositosActivos.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.nombre}
                            </option>
                          ))}
                        </NativeSelect>
                      )}
                      {depositoInvalido && (
                        <p className="text-xs text-destructive mt-1.5">
                          Debes seleccionar el deposito de reingreso.
                        </p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">Motivo de anulacion</label>
                      <input
                        type="text"
                        value={motivo}
                        onChange={(e) => setMotivo(e.target.value)}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        placeholder="Motivo de la anulacion..."
                      />
                    </div>

                    {tipoNc === 'PARCIAL' ? (
                      // PARCIAL (Slice 3b, Design §Decision 7): reemplaza el
                      // warning/footer generico de TOTAL — la propia
                      // SeleccionLineasNc trae su boton de confirmar,
                      // gateado por la misma validacion de
                      // `derivarLineasNcParcial` (tope facturado, es_decimal,
                      // cantidad negativa, al menos una linea).
                      <SeleccionLineasNc
                        key={`${facturaId}-${emisionGen}`}
                        lineas={lineasParaNc}
                        factura={{
                          total_usd: Number(factura.total_usd),
                          total_bs: Number(factura.total_bs),
                          tasa: Number(factura.tasa),
                        }}
                        onConfirm={handleConfirmarParcialClick}
                        loading={loading}
                        depositoInvalido={depositoInvalido}
                      />
                    ) : (
                      <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
                        <Warning className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
                        <div className="text-sm text-red-700">
                          <p className="font-medium">Esta accion es irreversible</p>
                          <p className="text-xs mt-1">
                            Se reintegrara el stock de todos los productos y la factura quedara anulada.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {factura && (
            <div className="flex justify-end gap-3 mt-4 pt-4 border-t shrink-0">
              <button
                onClick={() => {
                  setFacturaId(null)
                  // UX B QA fix: deseleccionar la factura cierra el proceso
                  // de NC en curso — la autorizacion de PIN no debe persistir
                  // para la proxima factura que se seleccione.
                  resetAutorizacionesPin()
                }}
                disabled={loading}
                className="px-4 py-2 text-sm rounded-md border border-input hover:bg-muted transition-colors"
              >
                Volver
              </button>
              <button
                type="button"
                onClick={handleEditarPagosClick}
                disabled={loading}
                className="px-4 py-2 text-sm rounded-md border border-input hover:bg-muted transition-colors disabled:opacity-50"
              >
                Editar metodos de pago
              </button>
              {puedeEmitirNc && tipoNc === 'TOTAL' && (
                <button
                  onClick={handleConfirmarClick}
                  disabled={loading || depositoInvalido || origenDineroInvalido}
                  className="px-4 py-2 text-sm rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                >
                  {loading ? 'Procesando...' : 'Confirmar Anulacion'}
                </button>
              )}
            </div>
          )}
        </div>
      </dialog>

      <SupervisorPinDialog
        isOpen={showPin}
        onClose={() => setShowPin(false)}
        onAuthorized={() => {
          // Un unico dialogo, dos acciones posibles (Slice 4, Design
          // §Decision 9) — `accionPendiente` decide cual dispara, nunca
          // ambas ni la equivocada.
          if (accionPendiente === 'EDITAR_PAGOS') {
            ejecutarEditarPagosPlaceholder()
          } else {
            // BUG 3 (QA C) QA fix: defensa en profundidad — igual que
            // `handleConfirmarClick`/`handleConfirmarParcialClick`, este es
            // el UNICO camino de emision que faltaba revalidar. Como PIN A
            // es async, el PIN B (deposito) puede autorizarse SIN elegir
            // deposito mientras PIN A todavia esta pendiente.
            if (depositoInvalido) return
            // Slice 4: mismo criterio para el picker de origen de dinero.
            if (origenDineroInvalido) return
            void emitirNc(lineasParcialPendientes ?? undefined)
          }
        }}
        titulo="Emision de Nota de Credito"
        mensaje="No tienes permiso para emitir notas de credito. Ingresa el PIN de un supervisor autorizado."
        requiredPermission={PERMISSIONS.SALES_NOTA_CREDITO}
      />

      {/* PIN B (Slice 5a-2b, obs #2835/#2802) — SEPARADO del PIN A de
          arriba: autoriza unicamente el cambio del deposito de reingreso,
          nunca la emision de la NC en si. */}
      <SupervisorPinDialog
        isOpen={showPinDeposito}
        onClose={() => setShowPinDeposito(false)}
        onAuthorized={() => setPinDepositoAutorizado(true)}
        titulo="Cambiar deposito de reingreso"
        mensaje="Cambiar el deposito de reingreso requiere autorizacion de un supervisor."
        requiredPermission={PERMISSIONS.SALES_NOTA_CREDITO}
      />
    </>
  )
}
