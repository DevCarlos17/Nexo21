import { useEffect, useMemo, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { Plus, Trash } from '@phosphor-icons/react'
import { formatUsd } from '@/lib/currency'
import { NativeSelect } from '@/components/ui/native-select'
import type { OrigenDinero } from '../hooks/use-notas-credito'
import {
  type CuentaOrigenDineroOption,
  type FilaOrigenDinero,
  type TipoCuentaOrigen,
  montoFilaEnUsd,
  calcularTotalCubiertoUsd,
  calcularCreditoAFavorUsd,
  filaExcedeDisponible,
  validarFilasParaSubmit,
  buildOrigenDineroPayload,
} from '../utils/origen-dinero-picker'

export interface SesionDestinoOption {
  id: string
  label: string
}

export interface OrigenDineroPickerResultado {
  origenDinero: OrigenDinero[]
  sesionDestinoId?: string
  valido: boolean
  motivo?: string
  totalCubiertoUsd: string
  creditoAFavorUsd: string
}

interface OrigenDineroPickerProps {
  /** Tope de la suma en USD — `remanenteALiquidar` del lado del servidor (Design §Decision 5 Pass 1). */
  remanenteUsd: string
  /** Tasa historica de la factura — misma tasa que usara `crearNotaCredito` para convertir BS→USD. */
  tasa: string
  /** Opciones SESION_EFECTIVO — cash `metodos_cobro` de la empresa (Efectivo USD/Bs). */
  cuentasSesion: CuentaOrigenDineroOption[]
  cuentasTesoreria: CuentaOrigenDineroOption[]
  cuentasBanco: CuentaOrigenDineroOption[]
  /**
   * true SOLO para la ruta `TRADICIONAL` (Decision 4/5) — habilita el
   * selector de sesion destino, que aparece UNA sola vez (no por fila)
   * cuando el array contiene al menos una asignacion SESION_EFECTIVO. En
   * POS este selector NUNCA se renderiza (la sesion es siempre la propia).
   */
  mostrarSelectorSesion: boolean
  sesionesDisponibles: SesionDestinoOption[]
  onChange: (resultado: OrigenDineroPickerResultado) => void
}

const TIPO_LABEL: Record<TipoCuentaOrigen, string> = {
  SESION_EFECTIVO: 'Efectivo de sesion',
  TESORERIA_EFECTIVO: 'Efectivo de tesoreria',
  BANCO: 'Banco',
}

function crearFilaVacia(): FilaOrigenDinero {
  return { id: uuidv4(), tipo: '', cuentaId: '', monto: '' }
}

function cuentasPorTipo(
  tipo: TipoCuentaOrigen | '',
  cuentasSesion: CuentaOrigenDineroOption[],
  cuentasTesoreria: CuentaOrigenDineroOption[],
  cuentasBanco: CuentaOrigenDineroOption[]
): CuentaOrigenDineroOption[] {
  if (tipo === 'SESION_EFECTIVO') return cuentasSesion
  if (tipo === 'TESORERIA_EFECTIVO') return cuentasTesoreria
  if (tipo === 'BANCO') return cuentasBanco
  return []
}

/**
 * Picker multi-origen COMPARTIDO por `nota-credito-pos-modal.tsx` y
 * `crear-ncr-modal.tsx` (Slice 4, Design §Decision 5). Filas dinamicas
 * (add/remove), total convertido a USD en vivo contra `remanenteUsd`, hint
 * de "credito a favor" cuando lo cubierto es menor al remanente (Design
 * §Leftover routing — la combinacion es el default) y pre-check de
 * disponibilidad de efectivo (obs #2950) ANTES de que el guard autoritativo
 * del backend lo rechace.
 */
export function OrigenDineroPicker({
  remanenteUsd,
  tasa,
  cuentasSesion,
  cuentasTesoreria,
  cuentasBanco,
  mostrarSelectorSesion,
  sesionesDisponibles,
  onChange,
}: OrigenDineroPickerProps) {
  const [filas, setFilas] = useState<FilaOrigenDinero[]>([])
  const [sesionDestinoId, setSesionDestinoId] = useState('')

  const todasLasCuentas = useMemo(
    () => [...cuentasSesion, ...cuentasTesoreria, ...cuentasBanco],
    [cuentasSesion, cuentasTesoreria, cuentasBanco]
  )

  const tieneSesionEfectivo = filas.some((f) => f.tipo === 'SESION_EFECTIVO')
  const mostrarSesionSelector = mostrarSelectorSesion && tieneSesionEfectivo

  const totalCubiertoUsd = useMemo(
    () => calcularTotalCubiertoUsd(filas, todasLasCuentas, tasa),
    [filas, todasLasCuentas, tasa]
  )
  const creditoAFavorUsd = useMemo(
    () => calcularCreditoAFavorUsd(remanenteUsd, totalCubiertoUsd),
    [remanenteUsd, totalCubiertoUsd]
  )
  const validacion = useMemo(
    () => validarFilasParaSubmit({ filas, cuentas: todasLasCuentas, remanenteUsd, tasa }),
    [filas, todasLasCuentas, remanenteUsd, tasa]
  )
  const validacionFinal =
    validacion.valido && mostrarSesionSelector && !sesionDestinoId
      ? { valido: false, motivo: 'Selecciona la sesion destino del reintegro.' }
      : validacion

  useEffect(() => {
    onChange({
      origenDinero: buildOrigenDineroPayload(filas),
      sesionDestinoId: mostrarSesionSelector && sesionDestinoId ? sesionDestinoId : undefined,
      valido: validacionFinal.valido,
      motivo: validacionFinal.motivo,
      totalCubiertoUsd: totalCubiertoUsd.toFixed(2),
      creditoAFavorUsd: creditoAFavorUsd.toFixed(2),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filas, sesionDestinoId, mostrarSesionSelector, validacionFinal.valido, validacionFinal.motivo])

  function actualizarFila(id: string, cambios: Partial<FilaOrigenDinero>) {
    setFilas((prev) => prev.map((f) => (f.id === id ? { ...f, ...cambios } : f)))
  }

  function agregarFila() {
    setFilas((prev) => [...prev, crearFilaVacia()])
  }

  function eliminarFila(id: string) {
    setFilas((prev) => prev.filter((f) => f.id !== id))
  }

  return (
    <div className="space-y-2">
      {filas.map((fila) => {
        const opcionesCuenta = cuentasPorTipo(fila.tipo, cuentasSesion, cuentasTesoreria, cuentasBanco)
        const cuentaSeleccionada = opcionesCuenta.find((c) => c.cuentaId === fila.cuentaId)
        const excede = cuentaSeleccionada ? filaExcedeDisponible(fila, cuentaSeleccionada) : false
        const montoUsdFila = montoFilaEnUsd(fila, todasLasCuentas, tasa)

        return (
          <div key={fila.id} className="rounded-lg border p-2 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <NativeSelect
                aria-label="Tipo de origen"
                value={fila.tipo}
                onChange={(e) =>
                  actualizarFila(fila.id, {
                    tipo: e.target.value as TipoCuentaOrigen | '',
                    cuentaId: '',
                  })
                }
                className="text-sm"
              >
                <option value="">Seleccionar tipo...</option>
                <option value="SESION_EFECTIVO">{TIPO_LABEL.SESION_EFECTIVO}</option>
                <option value="TESORERIA_EFECTIVO">{TIPO_LABEL.TESORERIA_EFECTIVO}</option>
                <option value="BANCO">{TIPO_LABEL.BANCO}</option>
              </NativeSelect>

              <NativeSelect
                aria-label="Cuenta"
                value={fila.cuentaId}
                onChange={(e) => actualizarFila(fila.id, { cuentaId: e.target.value })}
                disabled={!fila.tipo}
                className="text-sm"
              >
                <option value="">Seleccionar cuenta...</option>
                {opcionesCuenta.map((c) => (
                  <option key={c.cuentaId} value={c.cuentaId}>
                    {c.label} — Saldo: {c.saldoActual} {c.moneda}
                  </option>
                ))}
              </NativeSelect>

              <input
                type="number"
                role="spinbutton"
                inputMode="decimal"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={fila.monto}
                onChange={(e) => actualizarFila(fila.id, { monto: e.target.value })}
                onWheel={(e) => e.currentTarget.blur()}
                className={`no-spinner w-28 shrink-0 rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring ${
                  excede ? 'border-destructive' : ''
                }`}
              />

              <button
                type="button"
                aria-label="Eliminar origen"
                onClick={() => eliminarFila(fila.id)}
                className="shrink-0 p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-destructive transition-colors"
              >
                <Trash size={14} />
              </button>
            </div>

            {cuentaSeleccionada && fila.monto && (
              <p className="text-xs text-muted-foreground">≈ {formatUsd(montoUsdFila)}</p>
            )}
            {excede && cuentaSeleccionada && (
              <p className="text-xs text-destructive">
                Efectivo insuficiente en &quot;{cuentaSeleccionada.label}&quot; — disponible {cuentaSeleccionada.saldoActual} {cuentaSeleccionada.moneda}.
              </p>
            )}
          </div>
        )
      })}

      <button
        type="button"
        onClick={agregarFila}
        className="flex items-center gap-1.5 text-sm text-primary hover:underline"
      >
        <Plus size={14} />
        Agregar origen
      </button>

      {mostrarSesionSelector && (
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Sesion destino</label>
          <NativeSelect
            aria-label="Sesion destino"
            value={sesionDestinoId}
            onChange={(e) => setSesionDestinoId(e.target.value)}
            className="text-sm"
          >
            <option value="">Seleccionar sesion...</option>
            {sesionesDisponibles.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}

      <div className="rounded-lg border bg-muted/30 p-2 text-sm space-y-0.5">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Cubierto:</span>
          <span className="font-medium">
            {formatUsd(totalCubiertoUsd)} de {formatUsd(remanenteUsd)}
          </span>
        </div>
        {creditoAFavorUsd.gt(0) && (
          <p className="text-xs text-amber-600">
            Se dejara {formatUsd(creditoAFavorUsd)} como credito a favor del cliente.
          </p>
        )}
        {validacionFinal.motivo && !validacionFinal.motivo.includes('insuficiente') && (
          <p className="text-xs text-destructive">{validacionFinal.motivo}</p>
        )}
      </div>
    </div>
  )
}
