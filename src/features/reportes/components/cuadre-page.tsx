import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useQuery } from '@powersync/react'
import { MagnifyingGlass, CheckSquare, Square, LockKey, Eye, Warning, Printer, X, Bank, CheckCircle, Gear, HandCoins, CaretDown, CaretRight, ArrowFatLineUp, ArrowFatLineDown } from '@phosphor-icons/react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/page-header'
import { useCajasActivas } from '@/features/configuracion/hooks/use-cajas'
import { todayStr } from '@/lib/dates'
import { formatTasa, formatUsd, formatBs } from '@/lib/currency'
import { formatDate, formatDateTime, formatHora } from '@/lib/format'
import { useCurrentUser } from '@/core/hooks/use-current-user'
import { cerrarSesionCaja } from '@/features/caja/hooks/use-sesiones-caja'
import { PagosResumen } from './pagos-resumen'
import { SafDetalleModal } from './saf-detalle-modal'
import { AuditModal } from './audit-modal'
import { CxcModal } from './cxc-modal'
import { CuadreMetodoModal } from './cuadre-metodo-modal'
import { CuadreTotalesFiscales } from './cuadre-totales-fiscales'
import { CuadreNotasCredito } from './cuadre-notas-credito'
import { CuadreConteoFisico } from './cuadre-conteo-fisico'
import { CuadreDetallePagos } from './cuadre-detalle-pagos'
import { CuadreDetalleFacturas } from './cuadre-detalle-facturas'
import { CuadreImprimir } from './cuadre-imprimir'
import { CuadreArqueoTeorico } from './cuadre-arqueo-teorico'
import { DiferencialCambiarioModal } from './diferencial-cambiario-modal'
import { AbsorcionModal } from './absorcion-modal'
import {
  useSesionesPorCajaYFecha,
  useTasaDelDia,
  useVentasDelDia,
  useCxcDelDia,
  useSafDiario,
  useSaldoEfectivoBimonetario,
  useCobrosViaPOS,
  useSesionApertura,
  usePagosPorMetodo,
  useMovimientosManualesDia,
  useTotalesFiscales,
  useVentasFinancieras,
  useMovimientosEfectivoCaja,
  useCobranzasCxCCaja,
  useResumenTiposVenta,
  usePropinasDelDia,
  useAnticiposDelDia,
  useDiferencialCambiarioDelDia,
  useAbsorcionDelDia,
  type MovimientoEfectivoDetalle,
  type CobranzaCxCItem,
  type CuadreFilters,
  type VerifiedEntry,
} from '../hooks/use-cuadre'
import { NativeSelect } from '@/components/ui/native-select'

interface CuadrePageProps {
  initialFecha?: string
  initialCajaId?: string
  initialSesionId?: string
}

export function CuadrePage({ initialFecha, initialCajaId, initialSesionId }: CuadrePageProps = {}) {
  const { user } = useCurrentUser()

  // Funnel state
  const [fecha, setFecha] = useState(initialFecha ?? todayStr)
  const [cajaId, setCajaId] = useState<string | null>(initialCajaId ?? null)
  const [sesionCajaIds, setSesionCajaIds] = useState<string[]>(
    initialSesionId ? [initialSesionId] : []
  )

  // Consulted state
  const [consulted, setConsulted] = useState(false)
  const [activeFilters, setActiveFilters] = useState<CuadreFilters | null>(null)

  // Modal states
  const [auditOpen, setAuditOpen] = useState(false)
  const [cxcOpen, setCxcOpen] = useState(false)
  const [resumenOpen, setResumenOpen] = useState(false)
  const [safModalOpen, setSafModalOpen] = useState(false)
  const [financieroOpen, setFinancieroOpen] = useState(false)
  const [diferencialOpen, setDiferencialOpen] = useState(false)
  const [absorcionOpen, setAbsorcionOpen] = useState(false)

  // Movimientos manuales — tablas opcionales al final del cuadre
  const [showIngresos, setShowIngresos] = useState(false)
  const [showEgresos, setShowEgresos] = useState(false)
  const [showVueltos, setShowVueltos] = useState(false)
  const [showCobranzasCxC, setShowCobranzasCxC] = useState(false)

  // Selected payment method — drives both row highlight in PagosResumen and CuadreMetodoModal
  const [selectedMetodoNombre, setSelectedMetodoNombre] = useState<string | null>(null)


  // Verified non-cash payment amounts (keyed by metodo_cobro_id)
  const [verifiedAmountsByMetodoId, setVerifiedAmountsByMetodoId] = useState<Record<string, VerifiedEntry>>({})

  // Totals lifted from CuadreConteoFisico
  const [totalSistemaUsd, setTotalSistemaUsd] = useState(0)
  const [totalFisicoUsd, setTotalFisicoUsd] = useState(0)
  const [totalFisicoBs, setTotalFisicoBs] = useState(0)

  // Conteo fisico por metodo (keyed por metodo_cobro_id, valor nativo) para cerrarSesionCaja
  const [conteoFisicoRecord, setConteoFisicoRecord] = useState<Record<string, number>>({})
  const [totalMetodosCount, setTotalMetodosCount] = useState(0)

  // Reset key para propagar limpiar conteo a CuadreDetallePagos
  const [detallePagosResetKey, setDetallePagosResetKey] = useState(0)
  const handleLimpiarConteo = useCallback(() => {
    setDetallePagosResetKey((k) => k + 1)
  }, [])

  // Opciones de impresion
  const [printOptions, setPrintOptions] = useState({
    desgloseFiscal: true,
    detalleTransferencias: false,
    listaFacturas: false,
    productosVendidos: false,
    mostrarCostos: false,
  })
  const togglePrintOption = useCallback((key: keyof typeof printOptions) => {
    setPrintOptions((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  // Modal de configuracion del informe
  const [printSettingsOpen, setPrintSettingsOpen] = useState(false)

  // Finalizar cuadre modal state
  const [finalizarOpen, setFinalizarOpen] = useState(false)
  const [observaciones, setObservaciones] = useState('')
  const [isCerrando, setIsCerrando] = useState(false)

  // Post-cierre success banner
  const [postCierreInfo, setPostCierreInfo] = useState<{
    diferencia: number
    resultado: 'CUADRADO' | 'SOBRANTE' | 'FALTANTE'
  } | null>(null)

  // Supervisor selector (for close modal + print header)
  const [selectedSupervisorId, setSelectedSupervisorId] = useState<string>('')

  // Query supervisors (propietario + supervisor)
  const { data: supervisoresData } = useQuery(
    user?.empresa_id
      ? `SELECT id, nombre FROM usuarios WHERE empresa_id = ? AND level <= 2 AND activo = 1 ORDER BY nombre`
      : '',
    user?.empresa_id ? [user.empresa_id] : []
  )
  const supervisores = (supervisoresData ?? []) as { id: string; nombre: string }[]
  const selectedSupervisorNombre = supervisores.find((s) => s.id === selectedSupervisorId)?.nombre

  const handleVerifiedChange = useCallback((amounts: Record<string, VerifiedEntry>) => {
    setVerifiedAmountsByMetodoId(amounts)
  }, [])

  const handleTotalesChange = useCallback((sistema: number, fisico: number, fisicoBs: number) => {
    setTotalSistemaUsd(sistema)
    setTotalFisicoUsd(fisico)
    setTotalFisicoBs(fisicoBs)
  }, [])

  const handleConteoFisicoChange = useCallback((conteo: Record<string, number>, totalMetodos: number) => {
    setConteoFisicoRecord(conteo)
    setTotalMetodosCount(totalMetodos)
  }, [])

  // Data
  const { cajas } = useCajasActivas()
  const { sesiones } = useSesionesPorCajaYFecha(cajaId, fecha)
  const { tasaPromedio, tasaCount } = useTasaDelDia(activeFilters?.fecha ?? null)

  // KPI data — shown after consultar
  const { totalVentasUsd, totalVentasBs, facturasCount } = useVentasDelDia(activeFilters)
  const { cxcTotalUsd, cxcTotalBs } = useCxcDelDia(activeFilters)
  const { items: safItems, totalUsd: safTotalUsd } = useSafDiario(activeFilters)

  // Data for CuadreNetoEsperado
  const { saldoEsperadoUsd: saldoContadoUsd } = useSaldoEfectivoBimonetario(activeFilters)
  const { totalCobrosUsd: cobrosAnterioresUsd, totalCobrosBs, totalCobrosBsEquiv, porMetodo: cobrosViaPOS } = useCobrosViaPOS(activeFilters)

  // Cobros CxC por tipo de moneda — para el Arqueo Teórico.
  // Solo métodos EFECTIVO: las transferencias no afectan el efectivo físico en caja.
  const cobrosUsdEnArqueo = cobrosViaPOS
    .filter((m) => m.tipo === 'EFECTIVO' && m.moneda !== 'BS')
    .reduce((s, m) => s + m.cobrosUsd, 0)
  const cobrosBsNativoEnArqueo = cobrosViaPOS
    .filter((m) => m.tipo === 'EFECTIVO' && m.moneda === 'BS')
    .reduce((s, m) => s + m.cobrosNativo, 0)

  // Data for CuadreArqueoTeorico
  const { aperturaUsd: fondoAperturaUsd, aperturaBs: fondoAperturaBs } = useSesionApertura(activeFilters)
  const { metodos: todosMetodos } = usePagosPorMetodo(activeFilters)
  const { movimientos: movManualesCaja } = useMovimientosManualesDia(activeFilters)
  const { totales: totalesFiscales } = useTotalesFiscales(activeFilters)
  const { contadoUsd, contadoBs, creditoUsd, creditoBs } = useResumenTiposVenta(activeFilters)
  const { propinaBs, propinaUsd } = usePropinasDelDia(activeFilters)
  const { anticipoUsd, anticipoBsNativo } = useAnticiposDelDia(activeFilters)
  const diferencialCambiario = useDiferencialCambiarioDelDia(activeFilters)
  const absorcion = useAbsorcionDelDia(activeFilters)
  // Detalle individual de movimientos para las tablas al pie del cuadre
  const { movimientos: movsEfectivoDetalle } = useMovimientosEfectivoCaja(activeFilters)
  const { items: cobranzasCxC } = useCobranzasCxCCaja(activeFilters)

  // Derived values for CuadreArqueoTeorico — track USD (moneda != BS)
  const ventasEfectivoUsd = todosMetodos
    .filter((m) => m.tipo === 'EFECTIVO' && m.moneda !== 'BS')
    .reduce((s, m) => s + m.totalUsd, 0)
  const ingresosEfectivoUsd = movManualesCaja
    .filter((m) => m.metodo_tipo === 'EFECTIVO' && m.metodo_moneda !== 'BS' && (m.origen === 'INGRESO_MANUAL' || m.origen === 'INGRESO_TESORERIA'))
    .reduce((s, m) => s + m.total, 0)
  const egresosEfectivoUsd = movManualesCaja
    .filter((m) => m.metodo_tipo === 'EFECTIVO' && m.metodo_moneda !== 'BS' && m.mov_tipo === 'EGRESO')
    .reduce((s, m) => s + m.total, 0)
  // Track Bs nativo (moneda == BS) — ventas, ingresos y egresos en bolívares
  const ventasEfectivoBsNativo = todosMetodos
    .filter((m) => m.tipo === 'EFECTIVO' && m.moneda === 'BS')
    .reduce((s, m) => s + m.totalOriginal, 0)
  const ingresosEfectivoBsNativo = movManualesCaja
    .filter((m) => m.metodo_tipo === 'EFECTIVO' && m.metodo_moneda === 'BS' && (m.origen === 'INGRESO_MANUAL' || m.origen === 'INGRESO_TESORERIA'))
    .reduce((s, m) => s + m.total, 0)
  const egresosEfectivoBsNativo = movManualesCaja
    .filter((m) => m.metodo_tipo === 'EFECTIVO' && m.metodo_moneda === 'BS' && m.mov_tipo === 'EGRESO')
    .reduce((s, m) => s + m.total, 0)

  // Separación vueltos vs retiros para el Arqueo Teórico (display)
  const vueltosEfectivoUsd = movManualesCaja
    .filter((m) => m.metodo_tipo === 'EFECTIVO' && m.metodo_moneda !== 'BS' && m.origen === 'VUELTO')
    .reduce((s, m) => s + m.total, 0)
  const vueltosEfectivoBsNativo = movManualesCaja
    .filter((m) => m.metodo_tipo === 'EFECTIVO' && m.metodo_moneda === 'BS' && m.origen === 'VUELTO')
    .reduce((s, m) => s + m.total, 0)
  const retirosManualesUsd      = egresosEfectivoUsd      - vueltosEfectivoUsd
  const retirosManualesBsNativo = egresosEfectivoBsNativo - vueltosEfectivoBsNativo

  // Detalle de movimientos manuales para tablas opcionales
  const ingresosDetalle = movsEfectivoDetalle.filter(
    (m) => m.origen === 'INGRESO_MANUAL' || m.origen === 'INGRESO_TESORERIA'
  )
  const egresosDetalle = movsEfectivoDetalle.filter(
    (m) => m.origen === 'EGRESO_MANUAL' || m.origen === 'EGRESO_TESORERIA' || m.origen === 'PAGO_PROVEEDOR'
  )
  const vueltosDetalle = movsEfectivoDetalle.filter(
    (m) => m.origen === 'VUELTO'
  )

  // Diferencial cambiario por redondeo (mismo calculo que PagosResumen)
  const totalCobradoBs = todosMetodos.reduce((s, m) =>
    s + (m.moneda === 'BS' ? m.totalOriginal : m.totalBs), 0
  )
  const diferencialBs = totalesFiscales.totalFacturadoBs + totalCobrosBs - totalCobradoBs - cxcTotalBs
  const diferencialCambiarioUsd = tasaPromedio > 0
    ? Number((diferencialBs / tasaPromedio).toFixed(2))
    : 0
  // Fondo apertura en Bs. nativos convertido a USD equivalente (para el total neto USD)
  const fondoAperturaBsEnUsd = tasaPromedio > 0 ? Number((fondoAperturaBs / tasaPromedio).toFixed(2)) : 0
  // "Total Contado" = facturas emitidas originalmente como CONTADO (tipo='CONTADO').
  // Usa el tipo original de la factura en lugar de la fórmula totalFacturado - cxcPendiente,
  // que distorsionaba el resultado cuando una factura crédito se cobraba en la misma sesión.
  const totalContadoUsd = contadoUsd
  const totalContadoBs  = contadoBs

  // totalNeto incluye: efectivo USD esperado (apertura_usd + ventas + movimientos)
  //                  + Bs. nativos de apertura convertidos a USD
  //                  + cobros anteriores CxC
  //                  + diferencial cambiario
  const totalNeto = saldoContadoUsd + fondoAperturaBsEnUsd + cobrosAnterioresUsd + diferencialCambiarioUsd
  // Para display en Bs.: sumar los Bs. nativos de apertura directamente (sin re-convertir)
  // Cuando hay tasa: convierte el track USD a Bs y suma los Bs nativos de apertura
  // Sin tasa: muestra solo los Bs nativos de apertura (sin conversión)
  const totalNetoBs = tasaPromedio > 0
    ? (saldoContadoUsd + cobrosAnterioresUsd + diferencialCambiarioUsd) * tasaPromedio + fondoAperturaBs
    : fondoAperturaBs

  // Determine if exactly one ABIERTA session is selected (enables finalizar cuadre)
  const sesionAbiertaId = useMemo(() => {
    if (sesionCajaIds.length !== 1) return null
    const found = sesiones.find((s) => s.id === sesionCajaIds[0])
    return found?.status === 'ABIERTA' ? sesionCajaIds[0] : null
  }, [sesionCajaIds, sesiones])

  // Determine if exactly one CERRADA session is selected (shows Ver resumen)
  const sesionCerradaId = useMemo(() => {
    if (sesionCajaIds.length !== 1) return null
    const found = sesiones.find((s) => s.id === sesionCajaIds[0])
    return found?.status === 'CERRADA' ? sesionCajaIds[0] : null
  }, [sesionCajaIds, sesiones])

  // Total overrides across all verified methods
  const totalOverrides = Object.values(verifiedAmountsByMetodoId).reduce(
    (sum, e) => sum + e.overrideCount,
    0
  )

  const diferencia = Number((totalFisicoUsd - totalSistemaUsd).toFixed(2))

  // Cajero name from the selected session's apertura user (for print header)
  const cajeroNombreImprimir = useMemo(() => {
    if (sesionCajaIds.length !== 1) return undefined
    return sesiones.find((s) => s.id === sesionCajaIds[0])?.usuario_nombre ?? undefined
  }, [sesionCajaIds, sesiones])

  // Metodos sin conteo fisico ingresado
  const metodosSinConteo = totalMetodosCount - Object.keys(conteoFisicoRecord).length

  const handleConsultar = useCallback(() => {
    setActiveFilters({ fecha, cajaId, sesionCajaIds })
    setConsulted(true)
  }, [fecha, cajaId, sesionCajaIds])

  // Auto-consult on mount when navigated from POS with pre-loaded session
  const didAutoConsult = useRef(false)
  useEffect(() => {
    if (!didAutoConsult.current && initialFecha && initialCajaId && initialSesionId) {
      didAutoConsult.current = true
      setActiveFilters({ fecha: initialFecha, cajaId: initialCajaId, sesionCajaIds: [initialSesionId] })
      setConsulted(true)
    }
  }, [initialFecha, initialCajaId, initialSesionId])

  const handleFechaChange = useCallback((newFecha: string) => {
    setFecha(newFecha)
    setSesionCajaIds([])
    setConsulted(false)
    setActiveFilters(null)
  }, [])

  const handleCajaChange = useCallback((newCajaId: string) => {
    const val = newCajaId === '' ? null : newCajaId
    setCajaId(val)
    setSesionCajaIds([])
    setConsulted(false)
    setActiveFilters(null)
  }, [])

  const toggleSesion = useCallback((sesionId: string) => {
    setSesionCajaIds((prev) => {
      const set = new Set(prev)
      if (set.has(sesionId)) set.delete(sesionId)
      else set.add(sesionId)
      return Array.from(set)
    })
    setConsulted(false)
    setActiveFilters(null)
  }, [])

  const toggleAllSesiones = useCallback(() => {
    setSesionCajaIds((prev) =>
      prev.length === sesiones.length ? [] : sesiones.map((s) => s.id)
    )
    setConsulted(false)
    setActiveFilters(null)
  }, [sesiones])

  function getSesionLabel(s: { status: string; fecha_apertura: string; usuario_nombre: string | null }) {
    // formatHora convierte a hora Venezuela correctamente, incluso cuando Supabase
    // devuelve el timestamp como UTC (sin el offset -04:00 original de localNow())
    const hora = formatHora(s.fecha_apertura)
    const estado = s.status === 'ABIERTA' ? 'Abierta' : 'Cerrada'
    const nombre = s.usuario_nombre ? ` · ${s.usuario_nombre}` : ''
    return `${hora}${nombre} (${estado})`
  }

  const handleCerrarSesion = async () => {
    if (!sesionAbiertaId || !user) return
    setIsCerrando(true)
    try {
      const parts: string[] = []
      if (selectedSupervisorNombre) {
        parts.push(`Supervisado por: ${selectedSupervisorNombre}`)
      }
      if (totalOverrides > 0) {
        parts.push(`${totalOverrides} transferencia(s) con monto ajustado por supervisor`)
      }
      if (observaciones.trim()) parts.push(observaciones.trim())
      const observacionesCierre = parts.join(' | ') || undefined

      await cerrarSesionCaja(sesionAbiertaId, {
        monto_fisico_usd: totalFisicoUsd,
        monto_fisico_bs: totalFisicoBs > 0 ? totalFisicoBs : undefined,
        monto_sistema_usd: totalSistemaUsd,
        observaciones_cierre: observacionesCierre,
        usuario_cierre_id: user.id,
        conteoFisicoPorMetodo: conteoFisicoRecord,
        tasaDelDia: tasaPromedio,
      })

      // Limpiar localStorage del conteo al cerrar exitosamente
      if (activeFilters?.sesionCajaIds.length) {
        const key = `cuadre-fisico-${[...activeFilters.sesionCajaIds].sort().join(',')}`
        localStorage.removeItem(key)
      }

      const resultado: 'CUADRADO' | 'SOBRANTE' | 'FALTANTE' =
        diferencia > 0.001 ? 'SOBRANTE' : diferencia < -0.001 ? 'FALTANTE' : 'CUADRADO'
      setPostCierreInfo({ diferencia, resultado })

      toast.success('Sesion cerrada exitosamente')
      setFinalizarOpen(false)
      setObservaciones('')
      setSelectedSupervisorId('')
      setActiveFilters({ fecha, cajaId, sesionCajaIds })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error al cerrar la sesion')
    } finally {
      setIsCerrando(false)
    }
  }

  return (
    <>
    <div className="space-y-6 print:hidden">
      <PageHeader titulo="Cuadre de Caja" descripcion="Resumen de operaciones y cierre de caja" />

      {/* Banner post-cierre */}
      {postCierreInfo && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 flex items-start gap-3">
          <CheckCircle size={20} weight="fill" className="text-green-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-green-800">
              Sesion cerrada &mdash; {postCierreInfo.resultado}
              <span className={`text-xs font-normal ml-2 ${postCierreInfo.diferencia > 0.001 ? 'text-green-700' : postCierreInfo.diferencia < -0.001 ? 'text-red-600' : 'text-green-700'}`}>
                ({postCierreInfo.diferencia > 0 ? '+' : ''}{formatUsd(postCierreInfo.diferencia)})
              </span>
            </p>
            <p className="text-xs text-green-700 mt-0.5">
              El reporte de cierre esta listo para imprimir.
            </p>
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                disabled
                title="Modulo en desarrollo"
                className="inline-flex items-center gap-1.5 rounded-md border border-green-300 bg-white px-3 py-1.5 text-xs text-green-700 opacity-60 cursor-not-allowed"
              >
                <Bank size={13} />
                Conciliacion Bancaria
              </button>
              <span className="text-[10px] text-green-600 italic">Modulo en desarrollo</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setPostCierreInfo(null)}
            className="text-green-500 hover:text-green-700 transition-colors"
          >
            <X size={15} />
          </button>
        </div>
      )}

      {/* Filter card + KPI cards */}
      <div className="flex flex-wrap gap-4 items-start">
        <div className="flex-1 min-w-[280px] rounded-2xl bg-card shadow-lg p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            {/* Fecha */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">Fecha</label>
              <input
                type="date"
                value={fecha}
                onChange={(e) => handleFechaChange(e.target.value)}
                className="rounded-md border border-input bg-white px-3 py-2 text-sm"
              />
            </div>

            {/* Caja */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">Caja</label>
              <NativeSelect
                value={cajaId ?? ''}
                onChange={(e) => handleCajaChange(e.target.value)}
                className="min-w-[160px]"
              >
                <option value="">Todas las cajas</option>
                {cajas.map((c) => (
                  <option key={c.id} value={c.id}>{c.nombre}</option>
                ))}
              </NativeSelect>
            </div>

            {/* Consultar */}
            <button
              onClick={handleConsultar}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <MagnifyingGlass className="w-4 h-4" />
              Consultar
            </button>

            {/* Finalizar Cuadre — solo cuando 1 sesion ABIERTA seleccionada */}
            {consulted && sesionAbiertaId && (
              <button
                onClick={() => setFinalizarOpen(true)}
                className="inline-flex items-center gap-2 rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 transition-colors"
              >
                <LockKey className="w-4 h-4" />
                Finalizar Cuadre
              </button>
            )}

            {/* Ver resumen — solo cuando 1 sesion CERRADA seleccionada */}
            {consulted && sesionCerradaId && (
              <button
                onClick={() => setResumenOpen(true)}
                className="inline-flex items-center gap-2 rounded-md bg-slate-600 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 transition-colors"
              >
                <Eye className="w-4 h-4" />
                Ver Resumen
              </button>
            )}

            {/* Imprimir + Configurar — visible cuando hay datos consultados */}
            {consulted && activeFilters && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted transition-colors"
                >
                  <Printer className="w-4 h-4" />
                  Imprimir
                </button>
                <button
                  type="button"
                  onClick={() => setPrintSettingsOpen(true)}
                  title="Configurar informe"
                  className="inline-flex items-center justify-center rounded-md border p-2 text-muted-foreground hover:bg-muted transition-colors"
                >
                  <Gear size={15} />
                </button>
              </div>
            )}
          </div>

          {/* Multi-session selector */}
          {cajaId && sesiones.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Sesiones del dia ({sesiones.length})
                </p>
                <button
                  type="button"
                  onClick={toggleAllSesiones}
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  {sesionCajaIds.length === sesiones.length ? (
                    <CheckSquare size={12} />
                  ) : (
                    <Square size={12} />
                  )}
                  {sesionCajaIds.length === sesiones.length ? 'Deseleccionar todas' : 'Seleccionar todas'}
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {sesiones.map((s) => {
                  const checked = sesionCajaIds.includes(s.id)
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggleSesion(s.id)}
                      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs border transition-colors ${
                        checked
                          ? 'bg-primary/10 border-primary/50 text-primary font-medium'
                          : 'bg-background border-input text-muted-foreground hover:border-primary/30'
                      }`}
                    >
                      {checked ? (
                        <CheckSquare size={12} weight="fill" />
                      ) : (
                        <Square size={12} />
                      )}
                      {getSesionLabel(s)}
                    </button>
                  )
                })}
              </div>
              {sesionCajaIds.length === 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Sin sesion seleccionada = todas las sesiones de la caja en la fecha
                </p>
              )}
            </div>
          )}

          {/* Tasa del dia */}
          {consulted && activeFilters && tasaCount > 0 && (
            <div className="text-xs text-muted-foreground border-t pt-2">
              Tasa vigente: <span className="font-semibold text-foreground">{formatTasa(tasaPromedio)} Bs/$</span>
            </div>
          )}
        </div>

      </div>

      {/* Content */}
      {!consulted || !activeFilters ? (
        <div className="text-center py-16 text-muted-foreground">
          <MagnifyingGlass className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Seleccione los filtros y presione Consultar</p>
        </div>
      ) : (
        <>
          {/* Resumen fiscal — full width, encabeza el contenido */}
          <CuadreTotalesFiscales filters={activeFilters} />

          {/* Two-column grid: LEFT = resumen financiero, RIGHT = métodos de pago */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* LEFT COLUMN — Resumen financiero */}
            <div className="rounded-2xl bg-card shadow-lg p-5 space-y-3">
              <h3 className="text-sm font-semibold">Resumen de Caja</h3>

              {/* Total Facturado (ventas puras, sin avances/préstamos) */}
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Total Facturado (ventas)</span>
                <div className="text-right">
                  <div>{formatBs(totalesFiscales.totalVentasBs + totalesFiscales.totalIgtfBs)}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatUsd(totalesFiscales.totalVentasUsd + totalesFiscales.totalIgtfUsd)}
                  </div>
                </div>
              </div>

              {/* Avances / Préstamos — solo si hay, clickeable para ver detalle */}
              {totalesFiscales.totalFinancieroUsd > 0.001 && (
                <button
                  type="button"
                  onClick={() => setFinancieroOpen(true)}
                  className="w-full flex justify-between items-center text-sm rounded-lg px-2 py-1 -mx-2 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors group"
                >
                  <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
                    <HandCoins size={14} weight="fill" />
                    Avances / Préstamos
                    <span className="text-[10px] text-amber-500 group-hover:underline">(ver detalle)</span>
                  </span>
                  <div className="text-right">
                    <div className="text-amber-700 dark:text-amber-400">{formatBs(totalesFiscales.totalFinancieroBs)}</div>
                    <div className="text-xs text-muted-foreground">{formatUsd(totalesFiscales.totalFinancieroUsd)}</div>
                  </div>
                </button>
              )}

              {/* Total General = ventas + financiero + IGTF */}
              {totalesFiscales.totalFinancieroUsd > 0.001 && (
                <div className="flex justify-between text-sm border-t pt-2">
                  <span className="font-medium">Total General</span>
                  <div className="text-right">
                    <div className="font-medium">
                      {formatBs(totalesFiscales.totalVentasBs + totalesFiscales.totalFinancieroBs + totalesFiscales.totalIgtfBs)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatUsd(totalesFiscales.totalVentasUsd + totalesFiscales.totalFinancieroUsd + totalesFiscales.totalIgtfUsd)}
                    </div>
                  </div>
                </div>
              )}

              <div className="border-t" />

              {/* Total Contado — solo ventas cobradas en efectivo, sin fondo de apertura */}
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Total Contado</span>
                <div className="text-right">
                  {totalContadoBs > 0.001 || (tasaPromedio > 0 && totalContadoUsd > 0.001) ? (
                    <>
                      {totalContadoBs > 0.001 && (
                        <div>{formatBs(totalContadoBs)}</div>
                      )}
                      {tasaPromedio > 0 && totalContadoUsd > 0.001 && (
                        <div className="text-xs text-muted-foreground">{formatUsd(totalContadoUsd)}</div>
                      )}
                      {totalContadoBs <= 0.001 && totalContadoUsd > 0.001 && (
                        <div>{formatUsd(totalContadoUsd)}</div>
                      )}
                    </>
                  ) : (
                    <div className="text-xs text-muted-foreground">{formatBs(0)}</div>
                  )}
                </div>
              </div>

              {/* Total Credito (CxC) — muestra el total emitido a crédito (tipo original) */}
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Total Credito (CxC)</span>
                <div className="text-right">
                  <div>{formatBs(creditoBs)}</div>
                  <div className="text-xs text-muted-foreground">{formatUsd(creditoUsd)}</div>
                </div>
              </div>

              {/* Cobros Anteriores (CxC) */}
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Cobros Anteriores (CxC)</span>
                <div className="text-right">
                  <div className="text-blue-600">
                    {formatBs(totalCobrosBsEquiv)}
                  </div>
                  <div className="text-xs text-muted-foreground">{formatUsd(cobrosAnterioresUsd)}</div>
                </div>
              </div>

              {/* Cobros por Adelantado (anticipos sin factura) */}
              {(anticipoUsd > 0.001 || anticipoBsNativo > 0.001) && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Cobros por Adelantado</span>
                  <div className="text-right">
                    {anticipoBsNativo > 0.001 && (
                      <div className="text-indigo-600">{formatBs(anticipoBsNativo)}</div>
                    )}
                    {anticipoUsd > 0.001 && (
                      <div className={anticipoBsNativo > 0.001 ? 'text-xs text-muted-foreground' : 'text-indigo-600'}>
                        {formatUsd(anticipoUsd)}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Cobros por Adelantado (SAF directo) — solo si hay */}
              {safTotalUsd > 0.001 && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Cobros por Adelantado (SAF)</span>
                  <div className="text-right">
                    {tasaPromedio > 0 && (
                      <div className="text-indigo-600">{formatBs(safTotalUsd * tasaPromedio)}</div>
                    )}
                    <div className="text-xs text-muted-foreground">{formatUsd(safTotalUsd)}</div>
                  </div>
                </div>
              )}

              {/* Propinas — solo si hay */}
              {(propinaBs > 0.001 || propinaUsd > 0.001) && (() => {
                // Calcular el total en Bs y en USD para mostrar ambos.
                // propinaBs = suma nativa de propinas en métodos VES
                // propinaUsd = suma nativa de propinas en métodos USD
                // Equivalente total: convertir cada porción con tasaPromedio
                const totalPropinaBs = propinaBs + (tasaPromedio > 0 ? propinaUsd * tasaPromedio : 0)
                const totalPropinaUsd = propinaUsd + (tasaPromedio > 0 ? propinaBs / tasaPromedio : 0)
                return (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Propinas</span>
                    <div className="text-right">
                      <div className="text-purple-600">{formatBs(totalPropinaBs)}</div>
                      <div className="text-xs text-muted-foreground">{formatUsd(totalPropinaUsd)}</div>
                    </div>
                  </div>
                )
              })()}

              {/* Diferencial Cambiario */}
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Diferencial Cambiario</span>
                <div className="text-right">
                  {tasaPromedio > 0 && (
                    <div className={diferencialCambiarioUsd >= 0 ? 'text-green-600' : 'text-orange-600'}>
                      {diferencialCambiarioUsd >= 0 ? '+' : ''}{formatBs(Math.abs(diferencialCambiarioUsd) * tasaPromedio)}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    {diferencialCambiarioUsd >= 0 ? '+' : ''}{formatUsd(diferencialCambiarioUsd)}
                  </div>
                </div>
              </div>

              {/* Separador + Total Neto Esperado */}
              <div className="border-t pt-3">
                <div className="flex justify-between items-start">
                  <span className="text-sm font-semibold">Total Caja Neto Esperado</span>
                  <div className="text-right">
                    <p className={`text-2xl font-bold tabular-nums ${totalNeto >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {fondoAperturaBs > 0 || tasaPromedio > 0 ? formatBs(totalNetoBs) : formatUsd(totalNeto)}
                    </p>
                    {(fondoAperturaBs > 0 || tasaPromedio > 0) && (
                      <p className="text-xs text-muted-foreground tabular-nums mt-0.5">
                        {formatUsd(totalNeto)}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* RIGHT COLUMN — Métodos de pago */}
            <PagosResumen
              filters={activeFilters}
              tasaDelDia={tasaPromedio}
              selectedMetodoId={selectedMetodoNombre}
              onMetodoClick={setSelectedMetodoNombre}
              onCreditoClick={() => setCxcOpen(true)}
              onSafClick={() => setSafModalOpen(true)}
              onDiferencialClick={() => setDiferencialOpen(true)}
              onAbsorcionClick={() => setAbsorcionOpen(true)}
            />
          </div>

          {/* Arqueo de caja */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <CuadreConteoFisico
              filters={activeFilters}
              tasaDelDia={tasaPromedio}
              verifiedAmountsByMetodoId={verifiedAmountsByMetodoId}
              onTotalesChange={handleTotalesChange}
              onConteoFisicoChange={handleConteoFisicoChange}
              onLimpiar={handleLimpiarConteo}

              readOnly={!!sesionCerradaId}
            />
            <CuadreArqueoTeorico
              fondoAperturaUsd={fondoAperturaUsd}
              fondoAperturaBs={fondoAperturaBs}
              ventasEfectivoUsd={Math.max(0, ventasEfectivoUsd - cobrosUsdEnArqueo)}
              ventasEfectivoBsNativo={Math.max(0, ventasEfectivoBsNativo - cobrosBsNativoEnArqueo)}
              cobrosUsd={cobrosUsdEnArqueo}
              cobrosBsNativo={cobrosBsNativoEnArqueo}
              ingresosEfectivoUsd={ingresosEfectivoUsd}
              ingresosEfectivoBsNativo={ingresosEfectivoBsNativo}
              egresosUsd={egresosEfectivoUsd}
              egresosBsNativo={egresosEfectivoBsNativo}
              retirosManualesUsd={retirosManualesUsd}
              retirosManualesBsNativo={retirosManualesBsNativo}
              vueltosUsd={vueltosEfectivoUsd}
              vueltosBsNativo={vueltosEfectivoBsNativo}
              tasaCambio={tasaPromedio}
            />
          </div>

          {/* Ventas del dia + Cobros desde POS — full width */}
          <div className="space-y-4">
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide px-1">
                Ventas del dia
              </h2>
              <CuadreDetalleFacturas filters={activeFilters} />
            </div>
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide px-1">
                Cobros desde POS
              </h2>
              <CuadreDetallePagos
                filters={activeFilters}
                onVerifiedChange={handleVerifiedChange}
                resetKey={detallePagosResetKey}
              />
            </div>
          </div>

          {/* Notas de Credito — reintegros por metodo + contado/credito split (Slice 5) */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide px-1">
              Notas de Credito
            </h2>
            <CuadreNotasCredito filters={activeFilters} />
          </div>

          {/* Cobranzas CxC ingresadas a caja */}
          {cobranzasCxC.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide px-1">
                Cobranzas CxC
              </h2>
              <div className="rounded-2xl bg-card shadow-lg overflow-hidden">
                <label className="flex items-center gap-3 px-5 py-3.5 cursor-pointer hover:bg-muted/40 transition-colors">
                  <input
                    type="checkbox"
                    checked={showCobranzasCxC}
                    onChange={(e) => setShowCobranzasCxC(e.target.checked)}
                    className="h-4 w-4 rounded border accent-blue-600"
                  />
                  <div className="flex items-center gap-2">
                    <ArrowFatLineUp size={15} weight="fill" className="text-blue-600" />
                    <span className="text-sm font-semibold">Cobranzas CxC</span>
                    <span className="text-xs text-muted-foreground">({cobranzasCxC.length})</span>
                  </div>
                </label>
                {showCobranzasCxC && <CobranzasCxCTable items={cobranzasCxC} />}
              </div>
            </div>
          )}

          {/* Movimientos manuales de caja — tablas opcionales colapsables */}
          {(ingresosDetalle.length > 0 || egresosDetalle.length > 0 || vueltosDetalle.length > 0) && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide px-1">
                Movimientos Manuales de Caja
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Ingresos */}
                {ingresosDetalle.length > 0 && (
                  <div className="rounded-2xl bg-card shadow-lg overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setShowIngresos((v) => !v)}
                      className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <ArrowFatLineUp size={15} weight="fill" className="text-green-600" />
                        <span className="text-sm font-semibold">Ingresos Manuales</span>
                        <span className="text-xs text-muted-foreground">({ingresosDetalle.length})</span>
                      </div>
                      {showIngresos
                        ? <CaretDown size={13} className="text-muted-foreground" />
                        : <CaretRight size={13} className="text-muted-foreground" />}
                    </button>
                    {showIngresos && (
                      <MovimientosManualesTable items={ingresosDetalle} />
                    )}
                  </div>
                )}

                {/* Salidas de caja: egresos manuales + pagos a proveedores */}
                {egresosDetalle.length > 0 && (
                  <div className="rounded-2xl bg-card shadow-lg overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setShowEgresos((v) => !v)}
                      className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <ArrowFatLineDown size={15} weight="fill" className="text-red-600" />
                        <span className="text-sm font-semibold">Salidas de Caja</span>
                        <span className="text-xs text-muted-foreground">({egresosDetalle.length})</span>
                      </div>
                      {showEgresos
                        ? <CaretDown size={13} className="text-muted-foreground" />
                        : <CaretRight size={13} className="text-muted-foreground" />}
                    </button>
                    {showEgresos && (
                      <MovimientosManualesTable items={egresosDetalle} />
                    )}
                  </div>
                )}

                {/* Vueltos entregados */}
                {vueltosDetalle.length > 0 && (
                  <div className="rounded-2xl bg-card shadow-lg overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setShowVueltos((v) => !v)}
                      className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <ArrowFatLineDown size={15} weight="fill" className="text-orange-500" />
                        <span className="text-sm font-semibold">Vueltos Entregados</span>
                        <span className="text-xs text-muted-foreground">({vueltosDetalle.length})</span>
                      </div>
                      {showVueltos
                        ? <CaretDown size={13} className="text-muted-foreground" />
                        : <CaretRight size={13} className="text-muted-foreground" />}
                    </button>
                    {showVueltos && (
                      <MovimientosManualesTable items={vueltosDetalle} />
                    )}
                  </div>
                )}

              </div>
            </div>
          )}

          <AuditModal isOpen={auditOpen} onClose={() => setAuditOpen(false)} filters={activeFilters} />
          <CxcModal isOpen={cxcOpen} onClose={() => setCxcOpen(false)} filters={activeFilters} />
          <DiferencialCambiarioModal
            open={diferencialOpen}
            onClose={() => setDiferencialOpen(false)}
            items={diferencialCambiario.items}
            totalFaltanteBs={diferencialCambiario.totalFaltanteBs}
            totalFaltanteUsd={diferencialCambiario.totalFaltanteUsd}
            totalSobranteBs={diferencialCambiario.totalSobranteBs}
            fecha={activeFilters?.fecha ?? ''}
          />
          <AbsorcionModal
            open={absorcionOpen}
            onClose={() => setAbsorcionOpen(false)}
            items={absorcion.items}
            totalBs={absorcion.totalBs}
            totalUsd={absorcion.totalUsd}
            fecha={activeFilters?.fecha ?? ''}
          />
          {financieroOpen && (
            <FinancieroDetalleModal
              filters={activeFilters}
              onClose={() => setFinancieroOpen(false)}
            />
          )}
          <SafDetalleModal
            open={safModalOpen}
            onClose={() => setSafModalOpen(false)}
            items={safItems}
            tasaDelDia={tasaPromedio}
          />
          <CuadreMetodoModal
            isOpen={selectedMetodoNombre !== null}
            onClose={() => setSelectedMetodoNombre(null)}
            filters={activeFilters}
            metodoNombre={selectedMetodoNombre ?? ''}
          />
        </>
      )}

      {/* Modal: Finalizar Cuadre */}
      {finalizarOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-card rounded-2xl shadow-xl w-full max-w-md p-6 space-y-5">
            <h2 className="text-base font-semibold">Finalizar Cuadre de Caja</h2>

            {/* Advertencia si hay metodos sin conteo */}
            {metodosSinConteo > 0 && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 flex items-start gap-2">
                <Warning size={14} className="mt-0.5 shrink-0" weight="fill" />
                <span>
                  {metodosSinConteo} metodo(s) sin conteo fisico ingresado. El cierre se guardara con diferencia nula para esos metodos.
                </span>
              </div>
            )}

            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Total cobros del sistema (USD)</span>
                <span className="font-mono font-bold tabular-nums">{formatUsd(totalSistemaUsd)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Total fisico contado (USD)</span>
                <span className="font-mono font-bold tabular-nums">{formatUsd(totalFisicoUsd)}</span>
              </div>
              {totalFisicoBs > 0.001 && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Total fisico contado (Bs.)</span>
                  <span className="font-mono tabular-nums">{formatBs(totalFisicoBs)}</span>
                </div>
              )}
              <div className="flex items-center justify-between border-t pt-2">
                <span className="font-semibold">Diferencia</span>
                <div className="flex items-center gap-2">
                  <span
                    className={`font-mono font-bold tabular-nums ${
                      diferencia > 0.001
                        ? 'text-green-600'
                        : diferencia < -0.001
                        ? 'text-red-600'
                        : 'text-muted-foreground'
                    }`}
                  >
                    {diferencia > 0 ? '+' : ''}
                    {formatUsd(diferencia)}
                  </span>
                  {diferencia > 0.001 && (
                    <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                      SOBRANTE
                    </span>
                  )}
                  {diferencia < -0.001 && (
                    <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                      FALTANTE
                    </span>
                  )}
                  {Math.abs(diferencia) <= 0.001 && (
                    <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                      CUADRADO
                    </span>
                  )}
                </div>
              </div>
            </div>

            {totalOverrides > 0 && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                {totalOverrides} transferencia(s) con monto ajustado por supervisor quedaran registradas en las observaciones.
              </div>
            )}

            {/* Supervisor que autoriza */}
            {supervisores.length > 0 && (
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">
                  Supervisor que autoriza (opcional)
                </label>
                <NativeSelect
                  value={selectedSupervisorId}
                  onChange={(e) => setSelectedSupervisorId(e.target.value)}
                  className="w-full"
                >
                  <option value="">— Sin especificar —</option>
                  {supervisores.map((s) => (
                    <option key={s.id} value={s.id}>{s.nombre}</option>
                  ))}
                </NativeSelect>
              </div>
            )}

            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                Observaciones de cierre (opcional)
              </label>
              <textarea
                value={observaciones}
                onChange={(e) => setObservaciones(e.target.value)}
                rows={3}
                placeholder="Observaciones adicionales..."
                className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm resize-none"
              />
            </div>

            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setFinalizarOpen(false)}
                disabled={isCerrando}
                className="rounded-md border px-4 py-2 text-sm hover:bg-muted transition-colors disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleCerrarSesion}
                disabled={isCerrando}
                className="inline-flex items-center gap-2 rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 transition-colors disabled:opacity-50"
              >
                <LockKey size={15} />
                {isCerrando ? 'Cerrando...' : 'Cerrar Sesion'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Ver Resumen (sesion cerrada) */}
      {resumenOpen && sesionCerradaId && (
        <ResumenSesionCerradaModal
          sesionId={sesionCerradaId}
          onClose={() => setResumenOpen(false)}
        />
      )}

      {/* Modal: Configuracion del Informe */}
      {printSettingsOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-card rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Configuracion del Informe</h2>
              <button type="button" onClick={() => setPrintSettingsOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X size={16} />
              </button>
            </div>
            <p className="text-xs text-muted-foreground">Seleccione las secciones que desea incluir en el informe impreso.</p>
            <div className="space-y-3">
              {([
                ['desgloseFiscal', 'Desglose fiscal', 'Base imponible, IVA por alicuota, descuentos y NCR'],
                ['detalleTransferencias', 'Detalle de transferencias', 'Listado de cada transferencia con referencia y monto'],
                ['listaFacturas', 'Lista de facturas', 'Todas las facturas del periodo con cliente y totales'],
                ['productosVendidos', 'Productos vendidos', 'Detalle por factura: producto, cantidad, base, IVA y total'],
              ] as [keyof typeof printOptions, string, string][]).map(([key, label, desc]) => (
                <label key={key} className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={printOptions[key]}
                    onChange={() => togglePrintOption(key)}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary cursor-pointer"
                  />
                  <div>
                    <p className="text-sm font-medium leading-none">{label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
                  </div>
                </label>
              ))}
              {/* Sub-opcion de costos — solo visible si productosVendidos esta activo */}
              {printOptions.productosVendidos && (
                <label className="flex items-start gap-3 cursor-pointer ml-7 border-l pl-3">
                  <input
                    type="checkbox"
                    checked={printOptions.mostrarCostos}
                    onChange={() => togglePrintOption('mostrarCostos')}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary cursor-pointer"
                  />
                  <div>
                    <p className="text-sm font-medium leading-none">Mostrar costos</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Incluye columna de costo total por linea</p>
                  </div>
                </label>
              )}
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => window.print()}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <Printer size={14} />
                Imprimir ahora
              </button>
              <button
                type="button"
                onClick={() => setPrintSettingsOpen(false)}
                className="rounded-md border px-4 py-2 text-sm hover:bg-muted transition-colors"
              >
                Listo
              </button>
            </div>
          </div>
        </div>
      )}
    </div>

    {/* Vista de impresion — oculta en pantalla, visible al imprimir */}
    {consulted && activeFilters && (
      <CuadreImprimir
        filters={activeFilters}
        tasaDelDia={tasaPromedio}
        totalVentasUsd={totalVentasUsd}
        totalVentasBs={totalVentasBs}
        facturasCount={facturasCount}
        cxcTotalUsd={cxcTotalUsd}
        totalSistemaUsd={totalSistemaUsd}
        totalFisicoUsd={totalFisicoUsd}
        diferencia={diferencia}
        conteoFisicoRecord={conteoFisicoRecord}
        cajeroNombre={cajeroNombreImprimir}
        supervisorNombre={selectedSupervisorNombre}
        printOptions={printOptions}
      />
    )}
    </>
  )
}

// ─── Tabla de movimientos manuales (ingresos o egresos) ──────

function MovimientosManualesTable({ items }: { items: MovimientoEfectivoDetalle[] }) {
  return (
    <div className="border-t overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/50 text-muted-foreground">
            <th className="text-left px-4 py-2 font-medium">Concepto</th>
            <th className="text-left px-3 py-2 font-medium">Método</th>
            <th className="text-right px-4 py-2 font-medium">Monto</th>
            <th className="text-right px-4 py-2 font-medium">Hora</th>
          </tr>
        </thead>
        <tbody>
          {items.map((m) => {
            const hora = m.fecha ? formatHora(m.fecha) || '—' : '—'
            const label = m.concepto ?? m.destinatario ?? m.metodo_nombre
            const monto = m.metodo_moneda === 'BS'
              ? formatBs(parseFloat(m.monto))
              : formatUsd(parseFloat(m.monto))
                    const isTesoreria = m.origen === 'INGRESO_TESORERIA' || m.origen === 'EGRESO_TESORERIA'
                    const isCxP = m.origen === 'PAGO_PROVEEDOR'
                    return (
                      <tr key={m.id} className="border-b last:border-0 hover:bg-muted/20">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            {isTesoreria && (
                              <span className="shrink-0 inline-flex items-center rounded px-1 py-0.5 text-[10px] bg-blue-100 text-blue-700 font-medium">
                                Tesorería
                              </span>
                            )}
                            {isCxP && (
                              <span className="shrink-0 inline-flex items-center rounded px-1 py-0.5 text-[10px] bg-orange-100 text-orange-700 font-medium">
                                CxP
                              </span>
                            )}
                            <span className="truncate max-w-[180px]">{label}</span>
                          </div>
                        </td>
                <td className="px-3 py-2.5 text-muted-foreground">{m.metodo_nombre}</td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums font-medium">
                  {monto}
                </td>
                <td className="px-4 py-2.5 text-right text-muted-foreground tabular-nums">{hora}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Tabla de cobranzas CxC ──────────────────────────────────

function CobranzasCxCTable({ items }: { items: CobranzaCxCItem[] }) {
  const [search, setSearch] = useState('')

  const filtered = search.trim()
    ? items.filter((item) => {
        const q = search.toLowerCase()
        return (
          item.nroFactura?.toLowerCase().includes(q) ||
          item.clienteNombre?.toLowerCase().includes(q) ||
          item.metodoNombre.toLowerCase().includes(q) ||
          item.referencia?.toLowerCase().includes(q)
        )
      })
    : items

  // Agrupar por (createdAt + metodo) — todos los pagos de un mismo abono global
  // comparten el mismo created_at (misma writeTransaction) y método.
  const groups: { key: string; rows: CobranzaCxCItem[] }[] = []
  for (const item of filtered) {
    const key = `${item.createdAt}|${item.metodoNombre}`
    const last = groups[groups.length - 1]
    if (last && last.key === key) {
      last.rows.push(item)
    } else {
      groups.push({ key, rows: [item] })
    }
  }

  function renderCell(item: CobranzaCxCItem) {
    const hora = formatHora(item.createdAt || item.fecha) || '—'
    const fecha = item.fecha && !isNaN(new Date(item.fecha).getTime()) ? formatDate(item.fecha) : '—'
    const tasa = parseFloat(item.tasa ?? '0')
    const montoNum = parseFloat(item.monto)
    const montoBs = item.metodoMoneda === 'BS' ? montoNum : (tasa > 0 ? montoNum * tasa : 0)
    const montoDisplay = item.metodoMoneda === 'BS' ? formatBs(montoNum) : formatUsd(montoNum)
    return { hora, fecha, tasa, montoBs, montoDisplay }
  }

  return (
    <div className="border-t">
      <div className="px-4 py-2 border-b bg-muted/20">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por factura, cliente, método, referencia..."
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-blue-50/60 text-muted-foreground">
              <th className="text-left px-4 py-2 font-medium">Factura / Cliente</th>
              <th className="text-left px-3 py-2 font-medium">Método</th>
              <th className="text-right px-3 py-2 font-medium">Tasa</th>
              <th className="text-right px-4 py-2 font-medium">Monto</th>
              <th className="text-right px-4 py-2 font-medium">Bs.</th>
              <th className="text-left px-3 py-2 font-medium">Ref.</th>
              <th className="text-right px-4 py-2 font-medium">Fecha</th>
              <th className="text-right px-4 py-2 font-medium">Hora</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-4 text-center text-muted-foreground">Sin resultados</td>
              </tr>
            ) : groups.map((group) => {
              const multi = group.rows.length > 1
              return group.rows.map((item, idx) => {
                const { hora, fecha, tasa, montoBs, montoDisplay } = renderCell(item)
                const isLast = idx === group.rows.length - 1

                // Subtotal para grupos de 2+ facturas (después de la última fila del grupo)
                const subtotalRow = multi && isLast ? (() => {
                  const totalMonto = group.rows.reduce((s, r) => s + parseFloat(r.monto), 0)
                  const totalBs   = group.rows.reduce((s, r) => {
                    const t = parseFloat(r.tasa ?? '0')
                    const m = parseFloat(r.monto)
                    return s + (r.metodoMoneda === 'BS' ? m : (t > 0 ? m * t : 0))
                  }, 0)
                  const isBs = item.metodoMoneda === 'BS'
                  return (
                    <tr key={`${group.key}-subtotal`} className="bg-blue-50/40 border-t border-blue-200">
                      <td colSpan={3} className="px-4 py-1.5 text-xs font-semibold text-blue-700">
                        Subtotal ({group.rows.length} facturas)
                      </td>
                      <td className="px-4 py-1.5 text-right font-mono font-bold text-blue-700 tabular-nums">
                        {isBs ? formatBs(totalMonto) : formatUsd(totalMonto)}
                      </td>
                      <td className="px-4 py-1.5 text-right font-mono font-bold text-blue-700 tabular-nums">
                        {totalBs > 0 ? formatBs(totalBs) : '—'}
                      </td>
                      <td colSpan={3} />
                    </tr>
                  )
                })() : null

                return (
                  <React.Fragment key={item.id}>
                    <tr className={`border-b hover:bg-blue-50/30 ${multi ? 'bg-blue-50/10' : ''}`}>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className="shrink-0 inline-flex items-center rounded px-1 py-0.5 text-[10px] bg-blue-100 text-blue-700 font-medium">CxC</span>
                          <div className="min-w-0">
                            {item.nroFactura && <span className="font-medium font-mono">#{item.nroFactura}</span>}
                            {item.clienteNombre && <span className="text-muted-foreground ml-1.5 truncate">{item.clienteNombre}</span>}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{item.metodoNombre}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{tasa > 0 ? tasa.toFixed(2) : '—'}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums font-medium text-blue-700">{montoDisplay}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{montoBs > 0 ? formatBs(montoBs) : '—'}</td>
                      <td className="px-3 py-2.5 text-muted-foreground truncate max-w-[80px]">{item.referencia ?? '—'}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground tabular-nums">{fecha}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground tabular-nums">{hora}</td>
                    </tr>
                    {subtotalRow}
                  </React.Fragment>
                )
              })
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Modal detalle operaciones financieras ───────────────────

function FinancieroDetalleModal({
  filters,
  onClose,
}: {
  filters: CuadreFilters
  onClose: () => void
}) {
  const { items, isLoading } = useVentasFinancieras(filters)

  const totalUsd = items.reduce((s, i) => s + i.cargoFinancieroUsd, 0)
  const totalBs  = items.reduce((s, i) => s + i.cargoFinancieroBs,  0)

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-card rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-xl bg-amber-100 dark:bg-amber-950">
              <HandCoins size={16} weight="fill" className="text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">Avances y Préstamos</h2>
              <p className="text-xs text-muted-foreground">Cargos financieros cobrados al cliente</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Lista */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-10 bg-muted rounded animate-pulse" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Sin operaciones financieras</p>
          ) : (
            <div className="space-y-1">
              {items.map((item) => {
                const hora = item.fecha.length >= 16 ? item.fecha.substring(11, 16) : ''
                return (
                  <div
                    key={item.id}
                    className="flex items-center justify-between px-2 py-2 rounded-lg hover:bg-muted/50 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">{item.nroFactura}</p>
                      <p className="text-xs text-muted-foreground truncate">{item.clienteNombre}</p>
                    </div>
                    <div className="text-right shrink-0 ml-3">
                      <p className="font-mono tabular-nums text-amber-700 dark:text-amber-400">
                        {formatBs(item.cargoFinancieroBs)}
                      </p>
                      <p className="text-xs text-muted-foreground font-mono tabular-nums">
                        {formatUsd(item.cargoFinancieroUsd)}
                        {hora && <span className="ml-2 text-[10px]">{hora}</span>}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Totales */}
        {items.length > 0 && (
          <div className="border-t pt-3 shrink-0">
            <div className="flex justify-between items-baseline">
              <span className="text-sm font-semibold">Total financiero</span>
              <div className="text-right">
                <p className="font-bold tabular-nums text-amber-700 dark:text-amber-400">
                  {formatBs(totalBs)}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">{formatUsd(totalUsd)}</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Modal resumen de sesion cerrada ─────────────────────────

function ResumenSesionCerradaModal({
  sesionId,
  onClose,
}: {
  sesionId: string
  onClose: () => void
}) {
  const { data: sesionData } = useQuery(
    `SELECT sc.*,
            ua.nombre as usuario_apertura_nombre,
            uc.nombre as usuario_cierre_nombre,
            c.nombre as caja_nombre
     FROM sesiones_caja sc
     LEFT JOIN usuarios ua ON sc.usuario_apertura_id = ua.id
     LEFT JOIN usuarios uc ON sc.usuario_cierre_id = uc.id
     LEFT JOIN cajas c ON sc.caja_id = c.id
     WHERE sc.id = ?`,
    [sesionId]
  )

  const { data: detalleData } = useQuery(
    `SELECT scd.metodo_cobro_id, mc.nombre as metodo_nombre,
            CASE WHEN mon.codigo_iso = 'VES' THEN 'BS' ELSE COALESCE(mon.codigo_iso, 'USD') END as moneda,
            scd.total_sistema, scd.total_fisico, scd.diferencia, scd.num_transacciones
     FROM sesiones_caja_detalle scd
     JOIN metodos_cobro mc ON scd.metodo_cobro_id = mc.id
     LEFT JOIN monedas mon ON mc.moneda_id = mon.id
     WHERE scd.sesion_caja_id = ?
     ORDER BY mc.nombre`,
    [sesionId]
  )

  const sesion = (sesionData ?? [])[0] as {
    monto_apertura_usd: string
    monto_apertura_bs: string
    monto_sistema_usd: string | null
    monto_fisico_usd: string | null
    diferencia_usd: string | null
    observaciones_cierre: string | null
    fecha_cierre: string | null
    fecha_apertura: string
    usuario_apertura_nombre: string | null
    usuario_cierre_nombre: string | null
    caja_nombre: string | null
  } | undefined

  type DetalleRow = {
    metodo_nombre: string
    moneda: string
    total_sistema: string
    total_fisico: string | null
    diferencia: string | null
    num_transacciones: number
  }
  const detalle = (detalleData ?? []) as DetalleRow[]

  const diferenciaUsd = sesion?.diferencia_usd !== null && sesion?.diferencia_usd !== undefined
    ? parseFloat(sesion.diferencia_usd)
    : null

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-card rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Resumen de Sesion Cerrada</h2>
            {sesion?.caja_nombre && (
              <p className="text-xs text-muted-foreground mt-0.5">{sesion.caja_nombre}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>

        {!sesion ? (
          <div className="h-20 bg-muted rounded animate-pulse" />
        ) : (
          <>
            {/* Info de apertura y cierre */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground mb-1">Apertura</p>
                <p className="font-medium">{formatDateTime(sesion.fecha_apertura)}</p>
                {sesion.usuario_apertura_nombre && (
                  <p className="text-xs text-muted-foreground mt-0.5">Cajero: {sesion.usuario_apertura_nombre}</p>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  Fondo: USD {parseFloat(sesion.monto_apertura_usd).toFixed(2)}
                  {parseFloat(sesion.monto_apertura_bs) > 0 && (
                    <> + Bs {parseFloat(sesion.monto_apertura_bs).toFixed(2)}</>
                  )}
                </p>
              </div>
              <div className="rounded-lg bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground mb-1">Cierre</p>
                <p className="font-medium">
                  {sesion.fecha_cierre ? formatDateTime(sesion.fecha_cierre) : '—'}
                </p>
                {sesion.usuario_cierre_nombre && (
                  <p className="text-xs text-muted-foreground mt-1">Por: {sesion.usuario_cierre_nombre}</p>
                )}
              </div>
            </div>

            {/* Totales globales */}
            <div className="space-y-2 text-sm border rounded-lg p-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total cobros del sistema</span>
                <span className="font-mono font-bold">{formatUsd(parseFloat(sesion.monto_sistema_usd ?? '0'))}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total fisico</span>
                <span className="font-mono font-bold">
                  {sesion.monto_fisico_usd !== null ? formatUsd(parseFloat(sesion.monto_fisico_usd)) : '—'}
                </span>
              </div>
              <div className="flex justify-between border-t pt-2">
                <span className="font-semibold">Diferencia</span>
                <div className="flex items-center gap-2">
                  {diferenciaUsd !== null ? (
                    <>
                      <span className={`font-mono font-bold ${diferenciaUsd > 0.001 ? 'text-green-600' : diferenciaUsd < -0.001 ? 'text-red-600' : 'text-muted-foreground'}`}>
                        {diferenciaUsd > 0 ? '+' : ''}{formatUsd(diferenciaUsd)}
                      </span>
                      {diferenciaUsd > 0.001 && (
                        <span className="text-xs rounded-full bg-green-100 px-2 py-0.5 text-green-700 font-medium">SOBRANTE</span>
                      )}
                      {diferenciaUsd < -0.001 && (
                        <span className="text-xs rounded-full bg-red-100 px-2 py-0.5 text-red-700 font-medium">FALTANTE</span>
                      )}
                      {Math.abs(diferenciaUsd) <= 0.001 && (
                        <span className="text-xs rounded-full bg-green-100 px-2 py-0.5 text-green-700 font-medium">CUADRADO</span>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
              </div>
            </div>

            {/* Desglose por metodo */}
            {detalle.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  Detalle por metodo
                </p>
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b bg-muted">
                        <th className="text-left px-3 py-2 font-medium">Metodo</th>
                        <th className="text-right px-3 py-2 font-medium">Sistema</th>
                        <th className="text-right px-3 py-2 font-medium">Fisico</th>
                        <th className="text-right px-3 py-2 font-medium">Dif.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detalle.map((d) => {
                        const dif = d.diferencia !== null ? parseFloat(d.diferencia) : null
                        return (
                          <tr key={d.metodo_nombre} className="border-b last:border-0">
                            <td className="px-3 py-2">{d.metodo_nombre}</td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {d.moneda === 'BS'
                                ? formatBs(parseFloat(d.total_sistema))
                                : formatUsd(parseFloat(d.total_sistema))}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {d.total_fisico !== null
                                ? d.moneda === 'BS'
                                  ? formatBs(parseFloat(d.total_fisico))
                                  : formatUsd(parseFloat(d.total_fisico))
                                : <span className="text-muted-foreground">—</span>}
                            </td>
                            <td className={`px-3 py-2 text-right tabular-nums font-medium ${
                              dif === null ? '' : dif > 0.001 ? 'text-green-600' : dif < -0.001 ? 'text-red-600' : 'text-muted-foreground'
                            }`}>
                              {dif !== null
                                ? `${dif > 0 ? '+' : ''}${d.moneda === 'BS' ? formatBs(dif) : formatUsd(dif)}`
                                : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Observaciones */}
            {sesion.observaciones_cierre && (
              <div className="rounded-lg bg-muted/40 p-3">
                <p className="text-xs font-medium text-muted-foreground mb-1">Observaciones</p>
                <p className="text-sm">{sesion.observaciones_cierre}</p>
              </div>
            )}
          </>
        )}

        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="rounded-md border px-4 py-2 text-sm hover:bg-muted transition-colors"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}
