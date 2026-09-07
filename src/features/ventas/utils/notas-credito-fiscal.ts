import Decimal from 'decimal.js'
import { usdToBs, type DecimalInput } from '@/lib/currency'

/**
 * Modulo PURO (sin I/O, sin tx) para el desglose fiscal por linea de una Nota
 * de Credito PARCIAL y el guard anti-doble-credito por linea.
 *
 * Contexto (openspec/changes/notas-credito/design.md, Decision 2 — Slice 4a):
 * `ventas.tasa` es un campo a nivel de FACTURA (no existe tasa por linea), por
 * lo que "tasa historica" = `venta.tasa` verbatim, sin importar la tasa
 * vigente hoy. Cada linea de `notas_credito_det` hereda su PROPIO
 * `tipo_impuesto`/`impuesto_pct` original de `ventas_det` (no la alicuota
 * vigente), para preservar auditoria SENIAT ante facturas con alicuotas
 * mixtas.
 *
 * `calcularDesgloseLineaNC` reproduce la formula EXACTA de `crearVenta`
 * (src/features/ventas/hooks/use-ventas.ts L398-408): clasifica por
 * `tipo_impuesto === 'Exento'` → exento; cualquier otro valor ('Gravable' o
 * 'Exonerado') → base + IVA sobre `impuesto_pct`. Esto es deliberado: mismo
 * comportamiento que la venta original, no una clasificacion nueva de
 * 'Exonerado' como exento.
 *
 * No se redondea a nivel de linea — se mantiene precision Decimal completa
 * hasta el storage layer (`toStorageString`) o la vista (`formatUsd`), igual
 * que `crearVenta`. El llamador (Slice 4b) suma los resultados de multiples
 * lineas via `Array.reduce` para los agregados de header
 * (`total_exento_usd`/`total_base_usd`/`total_iva_usd`).
 */

export type TipoImpuestoLineaNc = 'Gravable' | 'Exento' | 'Exonerado'

export interface LineaNcOrigen {
  /** FK a `ventas_det.id` — linea original de la factura que se esta acreditando. */
  ventaDetId: string
  /** Cantidad seleccionada para devolver en ESTA nota de credito (puede ser parcial). */
  cantidadDevolver: DecimalInput
  /** `ventas_det.precio_unitario_usd` de la linea ORIGINAL (no el precio vigente hoy). */
  precioUnitarioUsd: DecimalInput
  /** `ventas_det.tipo_impuesto` de la linea ORIGINAL. */
  tipoImpuesto: TipoImpuestoLineaNc
  /** `ventas_det.impuesto_pct` de la linea ORIGINAL. */
  impuestoPct: DecimalInput
}

export interface DesgloseLineaNC {
  ventaDetId: string
  cantidadDevolver: Decimal
  /** cantidadDevolver * precioUnitarioUsd — antes de clasificar exento/base. */
  subtotalUsd: Decimal
  /** Equivalente en Bs a la tasa HISTORICA de la venta (usdToBs(subtotalUsd, ventaTasa)). Persistido en `notas_credito_det.subtotal_bs`. */
  subtotalBs: Decimal
  /** subtotalUsd si tipoImpuesto === 'Exento', si no 0. */
  exentoUsd: Decimal
  /** subtotalUsd si tipoImpuesto !== 'Exento' ('Gravable' o 'Exonerado'), si no 0. */
  baseUsd: Decimal
  /** IVA calculado sobre baseUsd con el impuestoPct de ESTA linea (0 si Exonerado con pct=0). */
  ivaUsd: Decimal
  /** exentoUsd + baseUsd + ivaUsd — total de la linea incluyendo impuesto. */
  totalLineaUsd: Decimal
}

/**
 * Desglose fiscal de una linea de NC PARCIAL. Formula identica a
 * `crearVenta` (use-ventas.ts L398-408): reproduce byte-a-byte la
 * clasificacion exento/base+IVA para preservar reconciliacion con la factura
 * original.
 */
export function calcularDesgloseLineaNC(linea: LineaNcOrigen, ventaTasa: DecimalInput): DesgloseLineaNC {
  const cantidadDevolver = new Decimal(linea.cantidadDevolver)
  const subtotalUsd = cantidadDevolver.times(linea.precioUnitarioUsd)
  const subtotalBs = usdToBs(subtotalUsd, ventaTasa)

  let exentoUsd = new Decimal(0)
  let baseUsd = new Decimal(0)
  let ivaUsd = new Decimal(0)

  if (linea.tipoImpuesto === 'Exento') {
    exentoUsd = subtotalUsd
  } else {
    baseUsd = subtotalUsd
    const pct = new Decimal(linea.impuestoPct ?? 0)
    ivaUsd = subtotalUsd.times(pct).dividedBy(100)
  }

  const totalLineaUsd = exentoUsd.plus(baseUsd).plus(ivaUsd)

  return {
    ventaDetId: linea.ventaDetId,
    cantidadDevolver,
    subtotalUsd,
    subtotalBs,
    exentoUsd,
    baseUsd,
    ivaUsd,
    totalLineaUsd,
  }
}

// =============================================
// GUARD ANTI-DOBLE-CREDITO POR LINEA
// =============================================
//
// Gap real (Design §2): el trigger Postgres `validate_nota_credito_insert`
// solo topea la SUMA de NCs contra el TOTAL de la factura (`ventas.total_usd`),
// no la cantidad acreditada POR LINEA. Sin este guard, dos NCs PARCIALES
// distintas podrian acreditar la MISMA linea mas alla de su cantidad
// originalmente vendida, siempre que el total agregado de la factura no se
// exceda (ej: factura con 2 lineas de $50 c/u — una NC podria "sobre-acreditar"
// la linea A y "sub-acreditar" la linea B sin que el trigger de tope lo note).

export interface ValidarTopeDobleCreditoInput {
  /** FK a `ventas_det.id` — usado solo para el mensaje de error, no participa en el calculo. */
  ventaDetId: string
  /** `ventas_det.cantidad` original de la linea (cantidad vendida en la factura). */
  cantidadOriginalLinea: DecimalInput
  /** SUM(cantidad) ya acreditado contra esta linea en NCs previas (via `sumCantidadYaAcreditada`). */
  yaAcreditado: DecimalInput
  /** Cantidad solicitada en la NUEVA nota de credito para esta linea. */
  cantidadDevolver: DecimalInput
}

export interface ValidarTopeDobleCreditoResult {
  valido: boolean
  /** Cantidad restante disponible para acreditar ANTES de esta solicitud (cantidadOriginalLinea - yaAcreditado). */
  cantidadDisponible: Decimal
  /** Presente solo cuando valido=false — mensaje listo para usar como Error. */
  motivo?: string
}

/**
 * Guard PURO (sin DB): rechaza cuando `yaAcreditado + cantidadDevolver`
 * excede `cantidadOriginalLinea`. Acepta en el limite exacto (`<=`).
 */
export function validarTopeDobleCredito(input: ValidarTopeDobleCreditoInput): ValidarTopeDobleCreditoResult {
  const cantidadOriginalLinea = new Decimal(input.cantidadOriginalLinea)
  const yaAcreditado = new Decimal(input.yaAcreditado)
  const cantidadDevolver = new Decimal(input.cantidadDevolver)

  const cantidadDisponible = Decimal.max(new Decimal(0), cantidadOriginalLinea.minus(yaAcreditado))
  const totalSolicitado = yaAcreditado.plus(cantidadDevolver)
  const valido = totalSolicitado.lessThanOrEqualTo(cantidadOriginalLinea)

  if (valido) {
    return { valido, cantidadDisponible }
  }

  return {
    valido,
    cantidadDisponible,
    motivo: `La linea ${input.ventaDetId} ya tiene ${yaAcreditado.toFixed(3)} acreditado de ${cantidadOriginalLinea.toFixed(3)} vendido; no se puede acreditar ${cantidadDevolver.toFixed(3)} adicional (disponible: ${cantidadDisponible.toFixed(3)}).`,
  }
}

// =============================================
// QUERY-SHAPE HELPER (tx-agnostic): sumCantidadYaAcreditada
// =============================================
//
// El SQL string y el row-mapping son PUROS (no ejecutan contra ninguna DB).
// El caller (Slice 4b) ejecuta esta query DENTRO del `db.writeTransaction()`
// existente, pasando params en el orden `paramsOrder`.

export interface SumCantidadYaAcreditadaQuery {
  sql: string
  /** Orden documentado de los parametros posicionales (`?`) del SQL, para que el caller no adivine. */
  paramsOrder: ['ventaDetId', 'empresaId']
}

/**
 * Query-shape para sumar cuanto ya se acredito de una linea especifica,
 * escopeada por `venta_det_id` Y `empresa_id` (aislamiento multi-tenant en
 * profundidad, aunque `venta_det_id` ya es unico por empresa via FK).
 */
export function buildSumCantidadYaAcreditadaQuery(): SumCantidadYaAcreditadaQuery {
  return {
    sql: `SELECT COALESCE(SUM(cantidad), 0) as total FROM notas_credito_det WHERE venta_det_id = ? AND empresa_id = ?`,
    paramsOrder: ['ventaDetId', 'empresaId'],
  }
}

export interface SumCantidadYaAcreditadaRow {
  total: string | number | null
}

/** Row-mapping: convierte el resultado crudo de la query a `Decimal`, defensivo ante `null`. */
export function mapSumCantidadYaAcreditadaRow(row: SumCantidadYaAcreditadaRow): Decimal {
  if (row.total === null || row.total === undefined) return new Decimal(0)
  return new Decimal(row.total)
}
