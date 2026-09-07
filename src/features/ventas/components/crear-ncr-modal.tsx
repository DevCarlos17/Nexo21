import { useState, useRef, useEffect, useMemo } from 'react'
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
import { useDetalleFactura, usePagosFactura } from '@/features/cxc/hooks/use-cxc'
import { useCompany } from '@/features/configuracion/hooks/use-company'
import { useCurrentUser } from '@/core/hooks/use-current-user'
import { useDepositosVentaActivos } from '@/features/inventario/hooks/use-depositos'
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
        // Design §Decision 5: el selector "Devolver dinero"/"Credito a favor"
        // es un placeholder — `origenReverso` NUNCA alimenta este valor,
        // siempre AJUSTE_CXC sin importar el estado del selector.
        modalidad: 'AJUSTE_CXC',
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

                {/* Origen del reverso — placeholder (Design §Decision 5). */}
                <div className="rounded-lg border p-3">
                  <p className="text-xs font-semibold text-muted-foreground mb-2">Origen del reverso</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled
                      title="Proximamente"
                      className="flex-1 px-3 py-1.5 text-sm rounded-md border opacity-50 cursor-not-allowed"
                    >
                      Devolver dinero
                    </button>
                    <button
                      type="button"
                      onClick={() => setOrigenReverso('CREDITO_A_FAVOR')}
                      aria-pressed={origenReverso === 'CREDITO_A_FAVOR'}
                      className="flex-1 px-3 py-1.5 text-sm rounded-md border border-primary bg-muted font-medium"
                    >
                      Credito a favor
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5">
                    "Devolver dinero" estara disponible en una entrega futura (Proximamente).
                  </p>
                </div>

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
                disabled={loading || !motivo.trim()}
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
