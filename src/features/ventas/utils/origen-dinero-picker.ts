import Decimal from 'decimal.js'
import { bsToUsd } from '@/lib/currency'
import type { OrigenDinero } from '../hooks/use-notas-credito'

/**
 * Capa PURA que alimenta `OrigenDineroPicker` (Slice 4, notas-credito-cuadre-
 * origen-dinero, Design §Decision 5). Espeja EXACTAMENTE las reglas
 * bimonetarias y de disponibilidad que `crearNotaCredito` ya aplica del lado
 * del servidor (Pass 1/Pass 2, obs #2948/#2949/#2950) — esta capa es un
 * PRE-CHECK de UX, NUNCA la fuente de verdad: el guard autoritativo sigue
 * viviendo en `use-notas-credito.ts` dentro de la transaccion.
 */

/** Tipo de cuenta de una asignacion — mismo union que `OrigenDinero['tipo']`. */
export type TipoCuentaOrigen = OrigenDinero['tipo']

/**
 * Una cuenta real seleccionable en el picker (metodos_cobro efectivo,
 * caja_fuerte o bancos_empresa) — cada una con su moneda FIJA (Decision 5:
 * "la cuenta ES la moneda").
 */
export interface CuentaOrigenDineroOption {
  tipo: TipoCuentaOrigen
  cuentaId: string
  label: string
  moneda: 'USD' | 'BS'
  saldoActual: string
}

/**
 * Una fila del picker en la UI — `tipo`/`cuentaId` pueden estar vacios
 * mientras el usuario todavia no completo la seleccion (placeholder). El
 * `id` es un identificador de FILA en el cliente (React key / remove), NUNCA
 * viaja al backend — ver `buildOrigenDineroPayload`.
 */
export interface FilaOrigenDinero {
  id: string
  tipo: TipoCuentaOrigen | ''
  cuentaId: string
  monto: string
}

const EPSILON = new Decimal('0.005') // mismo convenio que obs #2945/#2948/#2949

function toDecimalSeguro(valor: string): Decimal {
  if (valor.trim() === '') return new Decimal(0)
  try {
    const d = new Decimal(valor)
    return d.isNaN() ? new Decimal(0) : d
  } catch {
    return new Decimal(0)
  }
}

function encontrarCuenta(
  cuentas: CuentaOrigenDineroOption[],
  tipo: TipoCuentaOrigen | '',
  cuentaId: string
): CuentaOrigenDineroOption | undefined {
  return cuentas.find((c) => c.tipo === tipo && c.cuentaId === cuentaId)
}

/**
 * Convierte el monto NATIVO de una fila a USD, resolviendo la cuenta para
 * saber su moneda (mismo criterio que Pass 1: BS via `bsToUsd(monto, tasa)`,
 * USD sin conversion). Retorna `Decimal(0)` (nunca throw/NaN) cuando la
 * cuenta no se encuentra o el monto es invalido — un picker a medio llenar
 * no debe romper el calculo del total en vivo.
 */
export function montoFilaEnUsd(
  fila: FilaOrigenDinero,
  cuentas: CuentaOrigenDineroOption[],
  tasa: string
): Decimal {
  const cuenta = encontrarCuenta(cuentas, fila.tipo, fila.cuentaId)
  if (!cuenta) return new Decimal(0)
  const montoNativo = toDecimalSeguro(fila.monto)
  return cuenta.moneda === 'BS' ? bsToUsd(montoNativo, tasa) : montoNativo
}

/** Suma de todas las filas convertidas a USD — el "total cubierto" en vivo. */
export function calcularTotalCubiertoUsd(
  filas: FilaOrigenDinero[],
  cuentas: CuentaOrigenDineroOption[],
  tasa: string
): Decimal {
  return filas.reduce((acc, fila) => acc.plus(montoFilaEnUsd(fila, cuentas, tasa)), new Decimal(0))
}

/**
 * Sobrante que queda como credito a favor (SAFC) cuando lo cubierto es
 * MENOR al remanente — nunca negativo (Design §Leftover routing: la
 * combinacion parcial-efectivo + credito es el default, no un error).
 */
export function calcularCreditoAFavorUsd(remanenteUsd: string, totalCubiertoUsd: Decimal): Decimal {
  return Decimal.max(new Decimal(0), new Decimal(remanenteUsd).minus(totalCubiertoUsd))
}

/**
 * Excedente por encima del remanente disponible — nunca negativo. Usado
 * para bloquear el submit (espeja el throw de Pass 1: `montoADevolverUsd >
 * remanenteALiquidar + EPSILON`).
 */
export function calcularExcedenteUsd(remanenteUsd: string, totalCubiertoUsd: Decimal): Decimal {
  return Decimal.max(new Decimal(0), totalCubiertoUsd.minus(new Decimal(remanenteUsd)))
}

/**
 * Pre-check de disponibilidad (obs #2950): SESION_EFECTIVO/TESORERIA_EFECTIVO
 * son tope DURO (monto > saldo_actual excede) — mismo criterio que el guard
 * autoritativo del backend. BANCO NUNCA excede aqui (sobregiro permitido,
 * politica de tesoreria futura) — el backend tampoco lo valida.
 */
export function filaExcedeDisponible(fila: FilaOrigenDinero, cuenta: CuentaOrigenDineroOption): boolean {
  if (cuenta.tipo === 'BANCO') return false
  const montoNativo = toDecimalSeguro(fila.monto)
  return montoNativo.gt(new Decimal(cuenta.saldoActual))
}

/** Detecta pares (tipo, cuentaId) repetidos entre filas — espeja la Rule 4 pura del backend. */
export function hayCuentaDuplicada(filas: FilaOrigenDinero[]): boolean {
  const vistas = new Set<string>()
  for (const fila of filas) {
    if (!fila.tipo || !fila.cuentaId) continue
    const clave = `${fila.tipo}::${fila.cuentaId}`
    if (vistas.has(clave)) return true
    vistas.add(clave)
  }
  return false
}

export interface ResultadoValidacionFilas {
  valido: boolean
  motivo?: string
}

/**
 * Validacion combinada que decide si el boton "Confirmar" puede habilitarse.
 * Es un PRE-CHECK — el backend (`crearNotaCredito`) sigue siendo la unica
 * fuente de verdad autoritativa dentro de la transaccion.
 */
export function validarFilasParaSubmit(params: {
  filas: FilaOrigenDinero[]
  cuentas: CuentaOrigenDineroOption[]
  remanenteUsd: string
  tasa: string
}): ResultadoValidacionFilas {
  const { filas, cuentas, remanenteUsd, tasa } = params

  if (filas.length === 0) {
    return { valido: false, motivo: 'Agrega al menos un origen de dinero.' }
  }

  for (const fila of filas) {
    if (!fila.tipo || !fila.cuentaId) {
      return { valido: false, motivo: 'Selecciona una cuenta para cada fila.' }
    }
    if (!toDecimalSeguro(fila.monto).gt(0)) {
      return { valido: false, motivo: 'Cada fila exige un monto mayor a 0.' }
    }
  }

  if (hayCuentaDuplicada(filas)) {
    return { valido: false, motivo: 'No repitas la misma cuenta en dos filas.' }
  }

  for (const fila of filas) {
    const cuenta = encontrarCuenta(cuentas, fila.tipo, fila.cuentaId)
    if (!cuenta) {
      return { valido: false, motivo: 'Cuenta invalida o no disponible.' }
    }
    if (filaExcedeDisponible(fila, cuenta)) {
      return { valido: false, motivo: `Efectivo insuficiente en "${cuenta.label}".` }
    }
  }

  const totalCubiertoUsd = calcularTotalCubiertoUsd(filas, cuentas, tasa)
  if (totalCubiertoUsd.gt(new Decimal(remanenteUsd).plus(EPSILON))) {
    return { valido: false, motivo: 'El monto total excede el remanente disponible de la factura.' }
  }

  return { valido: true }
}

/**
 * Mapea las filas de la UI al contrato EXACTO de `CrearNotaCreditoParams.origenDinero`
 * (`{tipo, cuentaId, monto}[]`) — el `id` de fila (React key) NUNCA viaja.
 * Filas incompletas (placeholder sin tipo/cuenta) se excluyen.
 */
export function buildOrigenDineroPayload(filas: FilaOrigenDinero[]): OrigenDinero[] {
  return filas
    .filter((f): f is FilaOrigenDinero & { tipo: TipoCuentaOrigen } => f.tipo !== '' && f.cuentaId !== '')
    .map((f) => ({ tipo: f.tipo, cuentaId: f.cuentaId, monto: f.monto }))
}

/**
 * Mismo mapeo `CASE WHEN codigo_iso = 'VES' THEN 'BS' ELSE COALESCE(codigo_iso, 'USD') END`
 * ya usado en `use-bancos.ts`/`use-payment-methods.ts` — se repite aqui
 * porque `useCuentasTesoreria` expone `moneda_codigo` SIN normalizar
 * (codigo ISO crudo), a diferencia de `PaymentMethod.moneda` que ya viene
 * normalizado desde el SQL.
 */
export function normalizarMonedaOrigen(codigoIso: string | null | undefined): 'USD' | 'BS' {
  if (codigoIso === 'VES') return 'BS'
  return (codigoIso as 'USD' | 'BS') || 'USD'
}
