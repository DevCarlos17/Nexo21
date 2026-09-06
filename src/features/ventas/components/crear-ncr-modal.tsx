import { useState, useRef, useEffect, useMemo } from 'react'
import Decimal from 'decimal.js'
import { X, Warning } from '@phosphor-icons/react'
import {
  crearNotaCredito,
  useReversosFactura,
  type FacturaParaAnular,
  type LineaNcSeleccionada,
} from '../hooks/use-notas-credito'
import {
  puedeEmitirNcAdicional,
  puedeElegirTipoTotal,
  calcularReversoPorLinea,
  agruparReversosPorNc,
  type BadgeReverso,
} from '../utils/notas-credito-ui'
import { buildReciboData, type ReciboData, type TipoImpuestoLinea } from '../utils/factura-export'
import { FacturaDetallePanel } from './factura-detalle-panel'
import { SeleccionLineasNc, type LineaSeleccionNc } from './seleccion-lineas-nc'
import { OrigenDineroPicker, type OrigenDineroPickerResultado } from './origen-dinero-picker'
import {
  type CuentaOrigenDineroOption,
  normalizarMonedaOrigen,
} from '../utils/origen-dinero-picker'
import { useDetalleFactura, usePagosFactura } from '@/features/cxc/hooks/use-cxc'
import { useCompany } from '@/features/configuracion/hooks/use-company'
import { useCurrentUser } from '@/core/hooks/use-current-user'
import { useDepositosVentaActivos } from '@/features/inventario/hooks/use-depositos'
import { useMetodosPagoActivos } from '@/features/configuracion/hooks/use-payment-methods'
import { useCuentasTesoreria } from '@/features/tesoreria/hooks/use-cuentas-tesoreria'
import { useSesionesActivasDashboard } from '@/features/caja/hooks/use-sesiones-caja'
import { NativeSelect } from '@/components/ui/native-select'
import { toast } from 'sonner'

/** Mismo mapeo que `nota-credito-pos-modal.tsx`/`venta-exitosa-modal.tsx` (Design §Decision 5) — no una formula nueva. */
function toTipoImpuestoLinea(val: string): TipoImpuestoLinea {
  return val === 'Gravable' || val === 'Exonerado' ? val : 'Exento'
}

interface CrearNcrModalProps {
  isOpen: boolean
  onClose: () => void
  factura: FacturaParaAnular | null
}

/**
 * Origen del reverso — placeholder de "Devolver dinero"/"Credito a favor"
 * (Design §Decision 5, Spec "Selector Devolver dinero / Credito a favor
 * como placeholder"). Costura deliberada: cuando un change futuro habilite
 * sesion/tesoreria, este seam crece sin reestructurar el modal — hoy
 * "Devolver dinero" NUNCA es seleccionable y este estado NUNCA alimenta la
 * `modalidad` real de `crearNotaCredito` (siempre 'AJUSTE_CXC').
 */
type OrigenReverso = 'DEVOLVER_DINERO' | 'CREDITO_A_FAVOR'

/**
 * Modal delgado de la ruta administrativa "Facturas emitidas" (Slice D,
 * notas-credito-ruta-administrativa, Design §Decision 2/5/6). Reescritura
 * completa: reusa la MISMA capa pura de `notas-credito-ui-pos`
 * (`FacturaDetallePanel`, `SeleccionLineasNc`, `puedeEmitirNcAdicional`,
 * `puedeElegirTipoTotal`, `agruparReversosPorNc`, `calcularReversoPorLinea`,
 * `buildReciboData`) que ya usa `nota-credito-pos-modal.tsx` — SIN tocar ese
 * archivo (FROZEN) ni generalizarlo con un flag POS/ADMIN.
 *
 * Diferencias deliberadas frente al POS: reversa CUALQUIER factura de la
 * empresa (recibida por prop, no de una lista escopeada a sesion), SIN PIN
 * (la ruta ya esta gateada por `PERMISSIONS.SALES_VOID` a nivel de acceso,
 * obs #2835 — pedir PIN encima seria friccion redundante), `entryPoint:
 * 'TRADICIONAL'` y `modalidad` SIEMPRE `'AJUSTE_CXC'` — el selector "Devolver
 * dinero" es un shell visual deshabilitado, "Credito a favor" es la unica
 * opcion funcional (Design §Decision 5).
 */
export function CrearNcrModal({ isOpen, onClose, factura }: CrearNcrModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { user } = useCurrentUser()
  const { depositos: depositosActivos } = useDepositosVentaActivos()

  // Slice 4 (multi-origin picker UI, Design §Decision 5): mismas cuentas
  // reales que `nota-credito-pos-modal.tsx` — SESION_EFECTIVO restringido a
  // los `metodos_cobro` tipo EFECTIVO de la empresa (nunca a la sesion como
  // cuenta); Tesoreria/Banco via `useCuentasTesoreria` (sin duplicar la
  // query). La ruta TRADICIONAL es empresa-wide (Decision 4): ademas ofrece
  // el selector de sesion destino via `useSesionesActivasDashboard` (ya
  // filtra `status='ABIERTA'` — una sesion CERRADA nunca aparece aqui,
  // cumpliendo el pre-check UX del task 4.5 por construccion).
  const { metodos: metodosPago } = useMetodosPagoActivos()
  const { cuentas: cuentasTesoreriaRaw } = useCuentasTesoreria()
  const { sesiones: sesionesActivas } = useSesionesActivasDashboard()
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
  const sesionesDestinoOpciones = sesionesActivas.map((s) => ({
    id: s.id,
    label: `${s.caja_nombre ?? 'Caja'} — ${s.cajera_nombre ?? 'Sin cajera'}`,
  }))
  const [origenDineroResultado, setOrigenDineroResultado] = useState<OrigenDineroPickerResultado | null>(
    null
  )

  const [motivo, setMotivo] = useState('Anulacion total de factura')
  const [loading, setLoading] = useState(false)
  const [depositoElegidoId, setDepositoElegidoId] = useState<string | null>(null)
  const [tipoNc, setTipoNc] = useState<'TOTAL' | 'PARCIAL'>('TOTAL')
  const [origenReverso, setOrigenReverso] = useState<OrigenReverso>('CREDITO_A_FAVOR')

  const ventaId = isOpen ? factura?.id ?? null : null
  const { detalle, isLoading: loadingDetalle } = useDetalleFactura(ventaId)
  const { pagos: pagosFactura } = usePagosFactura(ventaId)
  const { company } = useCompany()
  const { reversos } = useReversosFactura(ventaId, user?.empresa_id ?? '')

  useEffect(() => {
    if (isOpen) {
      dialogRef.current?.showModal()
      setMotivo('Anulacion total de factura')
      setDepositoElegidoId(null)
      setTipoNc('TOTAL')
      setOrigenReverso('CREDITO_A_FAVOR')
      setOrigenDineroResultado(null)
    } else {
      dialogRef.current?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, factura?.id])

  function handleBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === dialogRef.current) onClose()
  }

  const historialReversos = useMemo(() => agruparReversosPorNc(reversos), [reversos])

  const lineasFacturaParaReverso = useMemo(
    () => detalle.map((d) => ({ venta_det_id: d.id, cantidad_facturada: d.cantidad })),
    [detalle]
  )

  // Gating de ACCION (F1/5f QA fix ya probado en notas-credito-ui-pos, reusado
  // sin reimplementar): reversado TOTAL acumulado bloquea cualquier NC
  // adicional; reversado PARCIAL (sin completar el 100%) solo bloquea TOTAL.
  const puedeEmitirNc = puedeEmitirNcAdicional(lineasFacturaParaReverso, reversos)
  const puedeTotal = puedeElegirTipoTotal(lineasFacturaParaReverso, reversos)

  // Badge de reverso derivado de las MISMAS dos funciones de gating de arriba
  // (sin duplicar la acumulacion por-linea en una tercera funcion): TOTAL
  // cuando ya no se puede emitir NC adicional (100% acumulado); PARCIAL
  // cuando TOTAL ya no es una opcion valida pero la accion sigue disponible.
  const badgeReverso: BadgeReverso = !puedeEmitirNc ? 'TOTAL' : !puedeTotal ? 'PARCIAL' : null

  useEffect(() => {
    if (!puedeTotal && tipoNc === 'TOTAL') setTipoNc('PARCIAL')
  }, [puedeTotal, tipoNc])

  // Slice 4: "Devolver dinero" solo aplica a TOTAL (ver comentario en
  // `emitirNc`) — si el usuario cae en PARCIAL con "Devolver dinero" ya
  // elegido, vuelve al default seguro "Credito a favor" (mismo criterio que
  // `nota-credito-pos-modal.tsx` retira EFECTIVO_REAL de sus modalidades).
  useEffect(() => {
    if (tipoNc === 'PARCIAL' && origenReverso === 'DEVOLVER_DINERO') {
      setOrigenReverso('CREDITO_A_FAVOR')
    }
  }, [tipoNc, origenReverso])

  // Slice 4: el picker de origen de dinero solo aplica a "Devolver dinero" +
  // TOTAL — igual que POS, el write-core de `crearNotaCredito` (paso 6c)
  // solo esta cableado para `tipoNc==='TOTAL'` (PARCIAL sigue usando
  // AJUSTE_CXC sin cambios, ver `emitirNc`). `remanenteUsd` espeja
  // `remanenteALiquidar` del backend: `total_usd - saldo_pend_usd`.
  const mostrarOrigenDineroPicker = origenReverso === 'DEVOLVER_DINERO' && tipoNc === 'TOTAL'
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

  const lineasParaNc: LineaSeleccionNc[] = useMemo(
    () =>
      detalle.map((d) => {
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

  async function emitirNc(lineasParcial?: LineaNcSeleccionada[]) {
    if (!factura || !user?.empresa_id) return
    // Slice 4: "Devolver dinero" solo mueve dinero real cuando aplica a
    // TOTAL (ver `mostrarOrigenDineroPicker`) — para PARCIAL (`lineasParcial`
    // presente) siempre cae a AJUSTE_CXC sin cambios (movesCash+PARCIAL no
    // esta cableado en el backend, ver comentario en `use-notas-credito.ts`
    // linea ~1018; combinarlo aqui enrutaria el dinero elegido en el picker
    // COMPLETO a credito a favor en silencio, mismo riesgo documentado en
    // `nota-credito-pos-modal.tsx`).
    const dispararDesembolso = !lineasParcial && mostrarOrigenDineroPicker && origenDineroResultado
    setLoading(true)
    try {
      const result = await crearNotaCredito({
        venta_id: factura.id,
        motivo: motivo.trim() || 'Anulacion desde modulo administrativo',
        usuario_id: user.id,
        empresa_id: user.empresa_id,
        // Modulo Tradicional (ruta admin "Facturas emitidas") — NUNCA vincula
        // la sesion de caja activa (factura potencialmente historica, ni idea
        // de que sesion este abierta ahora). Ver Regla de Oro, obs #2804.
        entryPoint: 'TRADICIONAL',
        // Slice 4 (FLIP — Design §Decision 5): "Devolver dinero" ya NO es un
        // placeholder — dispara la modalidad EFECTIVO_REAL real, con el
        // array `origenDinero` resuelto por el picker multi-cuenta y la
        // `sesionDestinoId` elegida (empresa-wide, Decision 4). "Credito a
        // favor" (default) sigue siendo AJUSTE_CXC, comportamiento
        // preservado byte-a-byte.
        modalidad: dispararDesembolso ? 'EFECTIVO_REAL' : 'AJUSTE_CXC',
        ...(dispararDesembolso
          ? {
              origenDinero: origenDineroResultado.origenDinero,
              sesionDestinoId: origenDineroResultado.sesionDestinoId,
            }
          : {}),
        tipo: lineasParcial ? 'PARCIAL' : 'TOTAL',
        ...(lineasParcial ? { lineas: lineasParcial } : {}),
        depositoReingresoId: depositoElegidoId ?? undefined,
      })
      toast.success(`Nota de credito ${result.nroNcr} creada exitosamente`)
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error al crear nota de credito')
    } finally {
      setLoading(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={handleBackdropClick}
      className="backdrop:bg-black/50 rounded-lg p-0 w-full max-w-2xl shadow-xl max-h-[85vh]"
    >
      <div className="p-6 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-start justify-between mb-4 shrink-0">
          <div>
            <h2 className="text-lg font-semibold">Aplicar Nota de Credito</h2>
            {factura && (
              <p className="text-sm text-muted-foreground">Factura #{factura.nro_factura}</p>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-muted transition-colors">
            <X className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>

        {!factura ? (
          <p className="text-sm text-muted-foreground">No se selecciono factura</p>
        ) : loadingDetalle ? (
          <div className="space-y-2 flex-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-8 bg-muted rounded animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-4">
            <FacturaDetallePanel recibo={recibo} reversos={historialReversos} badgeReverso={badgeReverso} />

            {!puedeEmitirNc ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-muted-foreground">
                Esta factura ya fue reversada totalmente. No es posible emitir una nueva nota de credito.
              </div>
            ) : (
              <>
                {/* Tipo de NC (Design §Decision 6: selector duplicado, sin
                    extraerse a componente compartido — mismo criterio que la
                    Decision 2 de este mismo change). */}
                <div className="rounded-lg border p-3">
                  <p className="text-xs font-semibold text-muted-foreground mb-2">Tipo de nota de credito</p>
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

                {/* Origen del reverso (Slice 4, FLIP — Design §Decision 5): "Devolver
                    dinero" ya NO es un shell deshabilitado, dispara el picker
                    multi-origen debajo. Solo disponible para TOTAL (ver
                    `mostrarOrigenDineroPicker`). */}
                <div className="rounded-lg border p-3">
                  <p className="text-xs font-semibold text-muted-foreground mb-2">Origen del reverso</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setOrigenReverso('DEVOLVER_DINERO')}
                      disabled={tipoNc === 'PARCIAL'}
                      aria-pressed={origenReverso === 'DEVOLVER_DINERO'}
                      title={tipoNc === 'PARCIAL' ? 'Disponible solo para reverso Total' : undefined}
                      className={`flex-1 px-3 py-1.5 text-sm rounded-md border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                        origenReverso === 'DEVOLVER_DINERO' ? 'border-primary bg-muted font-medium' : 'hover:bg-muted'
                      }`}
                    >
                      Devolver dinero
                    </button>
                    <button
                      type="button"
                      onClick={() => setOrigenReverso('CREDITO_A_FAVOR')}
                      aria-pressed={origenReverso === 'CREDITO_A_FAVOR'}
                      className={`flex-1 px-3 py-1.5 text-sm rounded-md border transition-colors ${
                        origenReverso === 'CREDITO_A_FAVOR' ? 'border-primary bg-muted font-medium' : 'hover:bg-muted'
                      }`}
                    >
                      Credito a favor
                    </button>
                  </div>
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
                      mostrarSelectorSesion
                      sesionesDisponibles={sesionesDestinoOpciones}
                      onChange={setOrigenDineroResultado}
                    />
                  </div>
                )}

                {/* Deposito de reingreso — libre, SIN PIN (obs #2835, la
                    pantalla Tradicional dedicada ya esta protegida a nivel de
                    ACCESO — pedir PIN encima seria friccion redundante). */}
                <div className="rounded-lg border p-3">
                  <p className="text-xs font-semibold text-muted-foreground mb-2">
                    Deposito de reingreso de stock
                  </p>
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
                </div>

                {/* Motivo */}
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
                  <SeleccionLineasNc
                    key={factura.id}
                    lineas={lineasParaNc}
                    factura={{
                      total_usd: Number(factura.total_usd),
                      total_bs: Number(factura.total_bs),
                      tasa: Number(factura.tasa),
                    }}
                    onConfirm={(lineas) => void emitirNc(lineas)}
                    loading={loading}
                  />
                ) : (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
                    <Warning className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
                    <div className="text-sm text-red-700">
                      <p className="font-medium">Esta accion es irreversible</p>
                      <p className="text-xs mt-1">
                        Se reintegrara el stock de todos los productos, se cancelara el saldo pendiente
                        y la factura quedara marcada como anulada permanentemente.
                      </p>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Actions */}
        {factura && (
          <div className="flex justify-end gap-3 mt-4 pt-4 border-t shrink-0">
            <button
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-sm rounded-md border border-input hover:bg-muted transition-colors"
            >
              {puedeEmitirNc ? 'Cancelar' : 'Cerrar'}
            </button>
            {puedeEmitirNc && tipoNc === 'TOTAL' && (
              <button
                onClick={() => void emitirNc()}
                disabled={loading || !motivo.trim() || origenDineroInvalido}
                className="px-4 py-2 text-sm rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {loading ? 'Procesando...' : 'Confirmar Anulacion'}
              </button>
            )}
          </div>
        )}
      </div>
    </dialog>
  )
}
