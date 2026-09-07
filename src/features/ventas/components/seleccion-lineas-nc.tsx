import { useState } from 'react'
import { Minus, Plus } from '@phosphor-icons/react'
import { formatUsd, formatBs } from '@/lib/currency'
import type { LineaNcSeleccionada } from '../hooks/use-notas-credito'
import { derivarLineasNcParcial, previewMontoBsNc, type LineaFacturaParaNc } from '../utils/notas-credito-ui'
import type { TipoImpuestoLinea } from '../utils/factura-export'

/**
 * Linea de factura candidata a NC PARCIAL (Design §Decision 7, Spec
 * notas-credito-pos: "Selección de tipo de nota de crédito"). Mapeada por el
 * llamador desde `useDetalleFactura` (cxc) — este componente NUNCA hace
 * fetch propio.
 */
export interface LineaSeleccionNc {
  venta_det_id: string
  producto_nombre: string
  producto_codigo: string
  cantidadFacturada: number
  esDecimal: boolean
  precioUnitarioUsd: number
  tipoImpuesto: TipoImpuestoLinea
  impuestoPct: number
  /**
   * F1 QA fix (Slice 5a): remanente real disponible para devolver
   * (`cantidadFacturada` menos lo ya acreditado por NCs previas — ver
   * `calcularReversoPorLinea`). Opcional: cuando se omite, el cap sigue
   * siendo `cantidadFacturada` (comportamiento pre-F1 intacto para
   * facturas sin ningun reverso previo). Una linea con `0` esta totalmente
   * reversada y NO puede recibir otra NC.
   */
  cantidadDisponible?: number
}

interface SeleccionLineasNcProps {
  lineas: LineaSeleccionNc[]
  /** Factura original — SIEMPRE `venta.tasa` historica (Design §Decision 8, invariante bimonetaria). */
  factura: { total_usd: number; total_bs: number; tasa: number }
  onConfirm: (lineas: LineaNcSeleccionada[]) => void
  loading?: boolean
  /**
   * UX C QA fix (Slice 5e): true cuando el selector de deposito de reingreso
   * esta desbloqueado (PIN B autorizado) pero el usuario todavia no eligio
   * un deposito concreto — bloquea la confirmacion sin importar que las
   * cantidades ya sean validas.
   */
  depositoInvalido?: boolean
}

/**
 * Componente de PRESENTACION (Slice 3b, Design §Decision 7): columna de
 * cantidad a devolver por linea, con el mismo patron de stepper es_decimal
 * de `linea-items.tsx:88-137` (paso entero/decimal, bloqueo de tecla
 * decimal). La validacion real (tope de cantidad facturada, es_decimal,
 * cantidad negativa) vive en la funcion pura `derivarLineasNcParcial` —
 * este componente solo la invoca, nunca reimplementa las reglas.
 */
export function SeleccionLineasNc({
  lineas,
  factura,
  onConfirm,
  loading = false,
  depositoInvalido = false,
}: SeleccionLineasNcProps) {
  const [cantidades, setCantidades] = useState<Record<string, number>>({})
  // F6 QA fix (Slice 5c): estado de error POR LINEA cuando el usuario intenta
  // escribir una cantidad por encima del tope (`cantidadDisponible` o, en su
  // ausencia, `cantidadFacturada`) — antes se clampeaba en silencio, ahora se
  // rechaza el valor y se avisa visualmente (input en rojo + mensaje) ANTES
  // de que la accion pueda procesarse.
  const [excedidas, setExcedidas] = useState<Record<string, boolean>>({})

  // F1 QA fix: el TOPE real de una linea es su remanente
  // (`cantidadDisponible`) cuando ya recibio NCs previas, NO la cantidad
  // originalmente facturada. Sin `cantidadDisponible` (factura sin ningun
  // reverso previo) el cap sigue siendo `cantidadFacturada`.
  function cap(l: LineaSeleccionNc): number {
    return l.cantidadDisponible ?? l.cantidadFacturada
  }

  function setCantidad(ventaDetId: string, tope: number, valor: number) {
    // Defensa en profundidad en la UI (clamp) — el guardrail real y
    // autoritativo contra negativos/excesos vive en `derivarLineasNcParcial`.
    const clamped = Math.max(0, Math.min(valor, tope))
    setCantidades((prev) => ({ ...prev, [ventaDetId]: clamped }))
  }

  const facturaLineasParaNc: LineaFacturaParaNc[] = lineas.map((l) => ({
    venta_det_id: l.venta_det_id,
    // El pure-function guard (`derivarLineasNcParcial`) recibe el REMANENTE
    // como su "cantidadFacturada" — asi el tope de linea-ya-parcialmente-
    // reversada se hace cumplir sin duplicar logica de validacion.
    cantidadFacturada: cap(l),
    esDecimal: l.esDecimal,
  }))
  const { lineas: lineasValidas, errores } = derivarLineasNcParcial(facturaLineasParaNc, cantidades)

  const lineasSeleccionadas = lineas.filter((l) => (cantidades[l.venta_det_id] ?? 0) > 0)
  const preview = previewMontoBsNc({
    tipo: 'PARCIAL',
    factura,
    lineasSeleccionadas: lineasSeleccionadas.map((l) => ({
      codigo: l.producto_codigo,
      nombre: l.producto_nombre,
      cantidad: String(cantidades[l.venta_det_id] ?? 0),
      precioUnitarioUsd: String(l.precioUnitarioUsd),
      tipoImpuesto: l.tipoImpuesto,
      impuestoPct: l.impuestoPct,
    })),
  })

  const puedeConfirmar = !loading && errores.length === 0 && !depositoInvalido

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left px-2 py-1.5 font-medium">Producto</th>
              <th className="text-center px-2 py-1.5 font-medium w-16">Facturado</th>
              <th className="text-center px-2 py-1.5 font-medium w-32">A devolver</th>
            </tr>
          </thead>
          <tbody>
            {lineas.map((linea) => {
              const cantidad = cantidades[linea.venta_det_id] ?? 0
              const step = linea.esDecimal ? 0.001 : 1
              const tope = cap(linea)
              const totalmenteReversada = tope <= 0
              return (
                <tr key={linea.venta_det_id} className="border-b last:border-b-0">
                  <td className="px-2 py-1.5">
                    <p className="font-medium">{linea.producto_nombre}</p>
                    <p className="text-muted-foreground">{linea.producto_codigo}</p>
                  </td>
                  <td className="px-2 py-1.5 text-center text-muted-foreground">
                    {linea.cantidadFacturada.toFixed(linea.esDecimal ? 3 : 0)}
                    {/* F1 QA fix: linea ya (parcialmente) reversada — el remanente
                        real difiere de lo facturado, se aclara explicitamente. */}
                    {tope < linea.cantidadFacturada && (
                      <p className="text-[10px] text-orange-600">
                        {totalmenteReversada ? 'Ya reversada' : `Disp. ${tope.toFixed(linea.esDecimal ? 3 : 0)}`}
                      </p>
                    )}
                  </td>
                  <td className="px-1.5 py-1.5">
                    <div className="flex items-center justify-center gap-0.5">
                      <button
                        type="button"
                        aria-label="Disminuir cantidad"
                        onClick={() => setCantidad(linea.venta_det_id, tope, cantidad - step)}
                        disabled={cantidad <= 0 || totalmenteReversada}
                        className="shrink-0 flex items-center justify-center h-5 w-5 rounded border text-muted-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <Minus size={10} />
                      </button>
                      <input
                        type="number"
                        role="spinbutton"
                        min="0"
                        max={tope}
                        step={linea.esDecimal ? 'any' : '1'}
                        value={cantidad === 0 ? '' : cantidad}
                        disabled={totalmenteReversada}
                        aria-invalid={excedidas[linea.venta_det_id] ?? false}
                        onChange={(e) => {
                          const raw = e.target.value
                          if (raw === '') {
                            setCantidad(linea.venta_det_id, tope, 0)
                            setExcedidas((prev) => ({ ...prev, [linea.venta_det_id]: false }))
                            return
                          }
                          // F5 QA fix: tope de 3 decimales en unidades decimales
                          // (misma precision NUMERIC de `inventario_stock`) — un
                          // 4to decimal se rechaza, el input controlado se
                          // congela en el ultimo valor valido en vez de aceptar
                          // mas precision de la que el backend puede persistir.
                          if (linea.esDecimal) {
                            const decimales = raw.split('.')[1]
                            if (decimales && decimales.length > 3) return
                          }
                          const val = linea.esDecimal ? parseFloat(raw) : parseInt(raw, 10)
                          if (isNaN(val)) return
                          // F6 QA fix: exceder el tope disponible NUNCA se
                          // clampea en silencio — se rechaza el valor (el input
                          // controlado vuelve a su ultimo valor valido, "no se
                          // escribe" el exceso) y se avisa ANTES de que el
                          // usuario intente confirmar (input en rojo + mensaje).
                          if (val > tope) {
                            setExcedidas((prev) => ({ ...prev, [linea.venta_det_id]: true }))
                            return
                          }
                          setExcedidas((prev) => ({ ...prev, [linea.venta_det_id]: false }))
                          setCantidad(linea.venta_det_id, tope, val)
                        }}
                        onKeyDown={(e) => {
                          if (!linea.esDecimal && (e.key === '.' || e.key === ',')) e.preventDefault()
                          if (e.key === '+') {
                            e.preventDefault()
                            setCantidad(linea.venta_det_id, tope, cantidad + step)
                          }
                          if (e.key === '-') {
                            e.preventDefault()
                            setCantidad(linea.venta_det_id, tope, cantidad - step)
                          }
                        }}
                        className={`min-w-0 w-16 text-center rounded border px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-40 disabled:cursor-not-allowed ${
                          excedidas[linea.venta_det_id] ? 'border-destructive text-destructive bg-destructive/5' : 'bg-white'
                        }`}
                      />
                      <button
                        type="button"
                        aria-label="Incrementar cantidad"
                        onClick={() => setCantidad(linea.venta_det_id, tope, cantidad + step)}
                        disabled={cantidad >= tope || totalmenteReversada}
                        className="shrink-0 flex items-center justify-center h-5 w-5 rounded border text-muted-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <Plus size={10} />
                      </button>
                    </div>
                    {/* F6 QA fix: mensaje de error visible ANTES de procesar —
                        reemplaza el clampeo silencioso pre-existente. */}
                    {excedidas[linea.venta_det_id] && (
                      <p className="text-[10px] text-destructive mt-0.5 text-center">
                        No puedes devolver más de la cantidad disponible.
                      </p>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {errores.length > 0 && (
        <ul className="text-xs text-destructive space-y-0.5">
          {errores.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}

      {depositoInvalido && (
        <p className="text-xs text-destructive">Debes seleccionar el deposito de reingreso.</p>
      )}

      <div className="flex items-center justify-between rounded-lg border bg-muted/30 p-2 text-sm">
        <span className="text-muted-foreground">Total a devolver:</span>
        <span className="font-semibold">
          {formatUsd(preview.totalUsd)} / {formatBs(preview.totalBs)}
        </span>
      </div>

      <button
        type="button"
        disabled={!puedeConfirmar}
        onClick={() => onConfirm(lineasValidas)}
        className="w-full px-4 py-2 text-sm rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? 'Procesando...' : 'Confirmar Nota de Credito Parcial'}
      </button>
    </div>
  )
}
