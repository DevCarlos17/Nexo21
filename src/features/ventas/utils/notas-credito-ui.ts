import Decimal from 'decimal.js'
import type { DecimalInput } from '@/lib/currency'
import { buildReciboData, type ReciboLineaInput } from './factura-export'
import type { LineaNcSeleccionada } from '../hooks/use-notas-credito'

/**
 * Modulo PURO (sin I/O) compartido POS/Tradicional para el rediseno UI de
 * Notas de Credito (openspec/changes/notas-credito-ui-pos/design.md).
 */

// =============================================
// derivarEstadoPago — Design §Decision 4
// =============================================

export type EstadoPago = 'CONTADO' | 'CREDITO' | 'ABONADA'

/**
 * `ventas.saldo_pend_usd` ya es el campo persistido/mantenido por
 * `aplicarPagoFacturaEnTx`/`crearNotaCredito` — NUNCA se suma
 * `pagos.monto_usd` de forma independiente (evitaria doble fuente de
 * verdad y divergiria si algun pago esta reversado). Epsilon `0.005`,
 * consistente con el umbral ya usado en `vencimientos_cobrar`.
 */
export function derivarEstadoPago(f: { total_usd: DecimalInput; saldo_pend_usd: DecimalInput }): EstadoPago {
  const total = new Decimal(f.total_usd)
  const saldo = new Decimal(f.saldo_pend_usd)
  if (saldo.lte('0.005')) return 'CONTADO'
  if (saldo.gte(total.minus('0.005'))) return 'CREDITO'
  return 'ABONADA'
}

// =============================================
// huboAfectacionCxc — Design §Decision 6
// =============================================

/**
 * Fuente correcta y persistida de "afectacion a CxC": COUNT(*) de
 * `movimientos_cuenta WHERE venta_id = ?`. NUNCA `construirCierreRecibo`/
 * `discrepancy` de `recibo-pagos.ts` — ese estado es efimero de React
 * (calculado en el momento del cobro, nunca persistido) e irrecuperable
 * para facturas historicas del listado de sesion.
 */
export function huboAfectacionCxc(cantidadMovimientosCuenta: number): boolean {
  return cantidadMovimientosCuenta > 0
}

// =============================================
// facturaCoincideBusqueda — Slice 2 (buscador de la lista)
// =============================================

export const ESTADO_PAGO_LABEL: Record<EstadoPago, string> = {
  CONTADO: 'Contado',
  CREDITO: 'Crédito',
  ABONADA: 'Abonada',
}

export interface FacturaBuscable {
  nro_factura: string
  cliente_nombre: string
  total_usd: DecimalInput
  saldo_pend_usd: DecimalInput
  tiene_reverso_total?: number
  tiene_reverso_parcial?: number
}

/** Normaliza acentos para busqueda tolerante (ej. "credito" matchea "Crédito"). */
function normalizarBusqueda(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

/**
 * Filtro client-side de la lista de facturas de sesion (Spec
 * notas-credito-pos: "buscador por numero, cliente o estado"). Coincide por
 * substring case/acento-insensitive contra `nro_factura`, `cliente_nombre`,
 * el label de `derivarEstadoPago` y los labels de reverso (si aplican).
 * Query vacio siempre coincide (sin filtro).
 */
export function facturaCoincideBusqueda(f: FacturaBuscable, query: string): boolean {
  const q = normalizarBusqueda(query.trim())
  if (!q) return true
  const haystack = [
    f.nro_factura,
    f.cliente_nombre,
    ESTADO_PAGO_LABEL[derivarEstadoPago(f)],
    f.tiene_reverso_total === 1 ? 'Reverso Total' : '',
    f.tiene_reverso_parcial === 1 ? 'Reverso Parcial' : '',
  ]
  return haystack.some((campo) => normalizarBusqueda(campo).includes(q))
}

// =============================================
// previewMontoBsNc — Design §Decision 8 (INVARIANTE BIMONETARIA)
// =============================================

/**
 * Preview del monto de NC en USD/Bs. GUARDRAIL mas importante del change:
 * el monto en Bs NUNCA se deriva de la tasa vigente del sistema — SIEMPRE
 * de `factura.tasa` (tasa historica ya persistida en `ventas`).
 *
 * TOTAL: `factura.total_bs` verbatim, sin ningun calculo (la NC TOTAL replica
 * exactamente el total de la factura original).
 *
 * PARCIAL: reusa `buildReciboData` sobre el subconjunto de lineas
 * seleccionadas con `tasa: factura.tasa` — estructuralmente igual a
 * `calcularDesgloseLineaNC` del backend (misma `applyImpuesto` de
 * `lib/currency.ts`), imposible de divergir del monto que `crearNotaCredito`
 * calculara al confirmar. CERO formula paralela nueva.
 */
export function previewMontoBsNc(input: {
  tipo: 'TOTAL' | 'PARCIAL'
  factura: { total_usd: number; total_bs: number; tasa: number }
  lineasSeleccionadas?: ReciboLineaInput[]
}): { totalUsd: number; totalBs: number } {
  if (input.tipo === 'TOTAL') {
    return { totalUsd: input.factura.total_usd, totalBs: input.factura.total_bs }
  }

  const preview = buildReciboData({
    nroFactura: '',
    fecha: '',
    emisor: { nombre: '', rif: null, direccion: null },
    cliente: { nombre: '', identificacion: '', direccion: null },
    lineas: input.lineasSeleccionadas ?? [],
    // SIEMPRE la tasa historica de la factura — nunca la tasa vigente del sistema.
    tasa: input.factura.tasa,
    igtfUsd: null,
    pagos: [],
    discrepancy: null,
    saldoPendUsd: 0,
  })

  return { totalUsd: preview.totales.totalFacturaUsd, totalBs: preview.totales.totalFacturaBs }
}

// =============================================
// derivarLineasNcParcial — Design §Decision 7
// =============================================

export interface LineaFacturaParaNc {
  venta_det_id: string
  cantidadFacturada: number
  esDecimal: boolean
}

export interface DerivarLineasNcResult {
  lineas: LineaNcSeleccionada[]
  errores: string[]
}

/**
 * Mapea las cantidades ingresadas en la UI de seleccion PARCIAL al contrato
 * exacto de `crearNotaCredito` (`LineaNcSeleccionada[]`). El tope acumulado
 * cross-NC (`validarTopeDobleCredito`) sigue siendo responsabilidad exclusiva
 * del backend — esta funcion solo valida contra la cantidad facturada de
 * ESTA factura y el `es_decimal` de la unidad.
 */
export function derivarLineasNcParcial(
  facturaLineas: LineaFacturaParaNc[],
  cantidadesUi: Record<string, number>
): DerivarLineasNcResult {
  const lineas: LineaNcSeleccionada[] = []
  const errores: string[] = []

  for (const linea of facturaLineas) {
    const cantidad = cantidadesUi[linea.venta_det_id] ?? 0

    // NEGATIVE-QTY GUARD (deuda de Slice 3a, obs #2875): una cantidad
    // negativa NUNCA se descarta en silencio como si fuera 0 — genera su
    // PROPIO error explicito, distinto del error generico "selecciona al
    // menos una linea" (que solo aplica cuando NINGUNA linea es valida).
    if (cantidad < 0) {
      errores.push(`La cantidad a devolver de la linea ${linea.venta_det_id} no puede ser negativa.`)
      continue
    }
    if (cantidad === 0) continue

    if (cantidad > linea.cantidadFacturada) {
      // F6 QA fix (Slice 5c, deuda de review de Slice 5a): el tope aqui
      // recibido como `cantidadFacturada` es en realidad el REMANENTE
      // disponible (el caller, `SeleccionLineasNc`, ya lo capa a
      // `cantidadDisponible` — ver F1). Llamarlo "lo facturado" era enganoso
      // para una linea ya parcialmente reversada; "cantidad disponible" es
      // preciso en ambos casos (factura sin reversos previos: coincide con
      // lo facturado; con reversos previos: es el remanente real).
      errores.push(
        `La cantidad a devolver de la linea ${linea.venta_det_id} excede la cantidad disponible (${linea.cantidadFacturada}).`
      )
      continue
    }
    if (!linea.esDecimal && !Number.isInteger(cantidad)) {
      errores.push(`La linea ${linea.venta_det_id} no admite cantidades decimales.`)
      continue
    }

    lineas.push({
      venta_det_id: linea.venta_det_id,
      cantidadDevolver: new Decimal(cantidad).toFixed(3),
    })
  }

  // El mensaje generico solo aplica cuando NINGUNA linea tiene una razon ya
  // explicada (negativa/excede/decimal invalido) — evita ruido redundante
  // cuando ya existe un error especifico por linea.
  if (lineas.length === 0 && errores.length === 0) {
    errores.push('Selecciona al menos una linea con cantidad mayor a 0.')
  }

  return { lineas, errores }
}

// =============================================
// F1 QA fix (Slice 5a): facturas reversadas selectionables — gating de
// ACCION, no de SELECCION (openspec/changes/notas-credito-ui-pos, apply-
// progress obs). Antes (Slice 2) una factura con `status==='ANULADA'` (NC
// TOTAL ya emitida) quedaba con la fila `disabled` en el listado, ocultando
// el detalle. Ahora CUALQUIER factura es seleccionable (ver
// nota-credito-pos-modal.tsx) — estas funciones solo deciden si la ACCION
// "Nota de credito" (y cual tipo) esta disponible para la factura ya
// seleccionada.
// =============================================

/**
 * Linea minima requerida para derivar estado de reverso acumulado: el
 * `venta_det_id` (para casar contra `notas_credito_det`) y la cantidad
 * ORIGINALMENTE facturada de esa linea.
 */
export interface LineaConCantidadFacturada {
  venta_det_id: string
  cantidad_facturada: DecimalInput
}

export interface EstadoReversoLineas {
  /** Al menos una linea tiene `reversado > 0` (alguna NC previa la afecto). */
  algunaConReverso: boolean
  /** TODAS las lineas tienen `reversado >= facturado` (100% acreditado). */
  todasCompletas: boolean
}

/**
 * QA fix 5f (consistencia badge/gating, obs verify-combined-final-v2): NUCLEO
 * COMPARTIDO de acumulacion reverso por-linea — UNICA fuente de verdad,
 * consumida tanto por el badge del listado (`calcularBadgesReversoPorVenta`)
 * como por el gating de accion (`puedeEmitirNcAdicional`/
 * `puedeElegirTipoTotal`). Antes de este fix el gating leia el flag CRUDO
 * `tiene_reverso_total` (solo `true` si ALGUNA NC individual tenia
 * `tipo='TOTAL'` literal), lo que lo desincronizaba del badge cuando 2+ NCs
 * PARCIALes sumaban juntas el 100% de la factura: el badge ya mostraba
 * "Reverso Total" (calculo acumulado) pero el gating de accion seguia
 * habilitando el formulario de NC (calculo NO acumulado). Reusa
 * `calcularReversoPorLinea` — mismo criterio de acumulacion que el guard
 * autoritativo del backend (`validarTopeDobleCredito`).
 */
export function calcularEstadoReversoLineas(
  lineas: LineaConCantidadFacturada[],
  notasCreditoDet: NotaCreditoDetParaReverso[]
): EstadoReversoLineas {
  let algunaConReverso = false
  let todasCompletas = true
  for (const linea of lineas) {
    const { facturado, reversado } = calcularReversoPorLinea(
      linea.venta_det_id,
      linea.cantidad_facturada,
      notasCreditoDet
    )
    if (reversado.gt(0)) algunaConReverso = true
    if (reversado.lt(facturado)) todasCompletas = false
  }
  return { algunaConReverso, todasCompletas }
}

/**
 * Reversado TOTAL (TODAS las lineas de la factura ya alcanzaron su cantidad
 * facturada, via CUALQUIER combinacion de NCs TOTAL/PARCIAL — mismo
 * criterio acumulado que el badge) -> NUNCA se puede emitir otra NC:
 * `validarTopeDobleCredito` rechazaria cualquier cantidad adicional en
 * TODAS sus lineas. Con reverso PARCIAL (sin completar el 100%) SI permite
 * una NC adicional, limitada al remanente por linea. Sin lineas disponibles
 * todavia (data en vuelo) se asume permisivo por defecto.
 */
export function puedeEmitirNcAdicional(
  lineas: LineaConCantidadFacturada[],
  notasCreditoDet: NotaCreditoDetParaReverso[]
): boolean {
  if (lineas.length === 0) return true
  return !calcularEstadoReversoLineas(lineas, notasCreditoDet).todasCompletas
}

/**
 * Restriccion mas fina: el tipo TOTAL especificamente deja de ser una opcion
 * valida en cuanto existe CUALQUIER reverso acumulado previo (total o
 * parcial, en cualquier linea). `crearNotaCredito` con tipo=TOTAL siempre
 * deriva TODAS las lineas de `ventas_det` con su cantidad COMPLETA original
 * (use-notas-credito.ts) — eso excederia el tope por-linea en cualquier
 * linea ya parcialmente acreditada. La UI oculta la opcion proactivamente
 * en vez de dejar que el backend la rechace con un error confuso.
 */
export function puedeElegirTipoTotal(
  lineas: LineaConCantidadFacturada[],
  notasCreditoDet: NotaCreditoDetParaReverso[]
): boolean {
  if (lineas.length === 0) return true
  return !calcularEstadoReversoLineas(lineas, notasCreditoDet).algunaConReverso
}

// =============================================
// calcularReversoPorLinea — F1 QA fix (remaining-qty por linea)
// =============================================

export interface NotaCreditoDetParaReverso {
  venta_det_id: string | null
  cantidad: DecimalInput
}

export interface ReversoLineaResult {
  facturado: Decimal
  reversado: Decimal
  restante: Decimal
}

/**
 * Cuanto de una linea de factura ya fue devuelto por NCs previas, y cuanto
 * queda disponible para una NUEVA NC PARCIAL. MISMO criterio de acumulacion
 * que el guard autoritativo y ya probado del backend
 * (`validarTopeDobleCredito` + `buildSumCantidadYaAcreditadaQuery`,
 * `notas-credito-fiscal.ts`): `SUM(cantidad)` de `notas_credito_det` para
 * esa `venta_det_id`, clampeado a `>= 0`. Una linea con `restante=0` NO
 * puede re-reversarse — el caller (`SeleccionLineasNc`, via
 * `nota-credito-pos-modal.tsx`) usa `restante` como el TOPE real en vez de
 * `cantidadFacturada` (cantidad originalmente vendida).
 */
export function calcularReversoPorLinea(
  ventaDetId: string,
  cantidadFacturada: DecimalInput,
  notasCreditoDet: NotaCreditoDetParaReverso[]
): ReversoLineaResult {
  const facturado = new Decimal(cantidadFacturada)
  const reversado = notasCreditoDet
    .filter((d) => d.venta_det_id === ventaDetId)
    .reduce((acc, d) => acc.plus(d.cantidad), new Decimal(0))
  const restante = Decimal.max(new Decimal(0), facturado.minus(reversado))
  return { facturado, reversado, restante }
}

// =============================================
// calcularBadgesReversoPorVenta — Slice 5e QA fix 3.5: badge de reverso
// ACUMULADO, no por opcion de NC individual
// =============================================

export type BadgeReverso = 'TOTAL' | 'PARCIAL' | null

export interface LineaFacturaReversoRow {
  venta_id: string
  venta_det_id: string
  cantidad_facturada: DecimalInput
}

/**
 * QA fix 3.5: el badge de reverso de una factura en el listado debe
 * reflejar la REALIDAD acumulada (facturado vs reversado por TODAS sus
 * NCs, cualquier `tipo`), NUNCA el tipo de una NC individual. Antes: dos
 * NCs PARCIALes que juntas reversan el 100% de cada linea mostraban
 * "Reverso Parcial" (el badge solo miraba si EXISTIA una NC con
 * `tipo='TOTAL'`). Reusa `calcularReversoPorLinea` (mismo criterio de
 * acumulacion que el guard autoritativo del backend, `validarTopeDobleCredito`)
 * linea por linea: "TOTAL" exige que TODAS las lineas de la factura tengan
 * reversado >= facturado; "PARCIAL" cuando alguna linea tiene reversado > 0
 * pero no todas llegan al 100%; `null` (sin badge) cuando ninguna linea
 * tiene reverso. NUNCA lee `notas_credito.tipo` para esta decision.
 *
 * QA fix 5f: la acumulacion por-linea vive en `calcularEstadoReversoLineas`
 * (compartida con el gating de accion `puedeEmitirNcAdicional`/
 * `puedeElegirTipoTotal`) — este badge y ese gating son AHORA consistentes
 * por construccion, nunca pueden divergir.
 */
export function calcularBadgesReversoPorVenta(
  lineasFacturas: LineaFacturaReversoRow[],
  notasCreditoDet: NotaCreditoDetParaReverso[]
): Record<string, BadgeReverso> {
  const lineasPorVenta = new Map<string, LineaFacturaReversoRow[]>()
  for (const linea of lineasFacturas) {
    const grupo = lineasPorVenta.get(linea.venta_id) ?? []
    grupo.push(linea)
    lineasPorVenta.set(linea.venta_id, grupo)
  }

  const resultado: Record<string, BadgeReverso> = {}
  for (const [ventaId, lineas] of lineasPorVenta) {
    const { algunaConReverso, todasCompletas } = calcularEstadoReversoLineas(lineas, notasCreditoDet)
    resultado[ventaId] = algunaConReverso ? (todasCompletas ? 'TOTAL' : 'PARCIAL') : null
  }
  return resultado
}

// =============================================
// resolverBadgesFactura — BUG D fix (payment-method badge no se limpia en
// reverso total)
// =============================================

export interface BadgesFacturaVisibles {
  /** `null` significa "no renderizar el badge de estado de pago". */
  estadoPago: EstadoPago | null
  reverso: BadgeReverso
}

/**
 * BUG D fix (obs #2875): `FacturaBadges` renderizaba el badge de estado de
 * pago (Contado/Credito/Abonada) de forma INCONDICIONAL, sin importar
 * `badgeReverso`. Una factura reversada al 100% (`badgeReverso === 'TOTAL'`,
 * sin importar si se llego con una sola NC TOTAL o acumulando PARCIALes —
 * mismo criterio que `calcularBadgesReversoPorVenta`) mostraba a la vez
 * "Contado"/"Credito"/"Abonada" Y "Reverso Total", cuando el negocio exige
 * que el reverso total DEJE SIN EFECTO cualquier badge previo (metodo de
 * pago o "Reverso Parcial") y muestre UNICAMENTE "Reverso Total". Con
 * cualquier otro estado (`PARCIAL`/`null`) el badge de pago se mantiene,
 * igual que antes de este fix.
 */
export function resolverBadgesFactura(estadoPago: EstadoPago, badgeReverso: BadgeReverso): BadgesFacturaVisibles {
  if (badgeReverso === 'TOTAL') {
    return { estadoPago: null, reverso: 'TOTAL' }
  }
  return { estadoPago, reverso: badgeReverso }
}

// =============================================
// agruparReversosPorNc — F1 QA fix (historial additivo: original + reverso)
// =============================================

export interface ReversoFacturaRowInput {
  nota_credito_id: string
  nro_ncr: string
  tipo: string
  fecha: string
  producto_descripcion: string
  cantidad: string
}

export interface ReversoLineaDetalle {
  descripcion: string
  cantidad: string
}

export interface ReversoAplicado {
  notaCreditoId: string
  nroNcr: string
  tipo: string
  fecha: string
  lineas: ReversoLineaDetalle[]
}

/**
 * Agrupa las filas planas de `useReversosFactura` (JOIN
 * `notas_credito`+`notas_credito_det`, una fila por linea de NC) en un
 * arreglo por-NC para el panel de detalle — Requisito de negocio: el panel
 * SIEMPRE muestra la factura original completa y, si tiene NC(s) aplicadas,
 * ADEMAS el historial de lo reversado (aditivo, nunca reemplaza la vista
 * original). Funcion PURA — el hook resuelve el fetch, esta funcion solo
 * re-forma la data ya cargada.
 */
// =============================================
// filaFacturaAtenuada — Slice E.5 (notas-credito-ruta-administrativa, QA
// feedback del tester)
// =============================================

/**
 * Una factura con reverso TOTAL (`tiene_reverso_total === 1`) debe
 * renderizarse con la FILA COMPLETA atenuada en la tabla de "Facturas
 * emitidas" — EXCEPTO el badge "Reverso Total", que conserva su color
 * explicito. El consumidor (`facturas-empresa-tab.tsx`) aplica esto via un
 * color de texto HEREDABLE en el `<tr>` (p.ej. `text-muted-foreground`),
 * nunca `opacity` — `opacity` atenuaria tambien el badge (afecta a todos
 * los descendientes por igual, sin importar su color explicito).
 */
export function filaFacturaAtenuada(f: { tiene_reverso_total?: number }): boolean {
  return f.tiene_reverso_total === 1
}

// =============================================
// debeMostrarBadgeAdministracion — Slice 6 (Design §Decision 3)
// =============================================

/**
 * Badge "Vía administración" en el listado POS-express (Design §Decision 3:
 * `entry_point` persiste el origen de emision de la NC — 'POS' | 'TRADICIONAL').
 * Cuando la venta activa fue reversada por una NC emitida desde el modulo
 * Tradicional (admin), el cajero POS debe ver esta señal — el reintegro pudo
 * afectar una sesion distinta a la suya. `undefined`/`0` -> no renderiza.
 */
export function debeMostrarBadgeAdministracion(f: { tiene_reverso_via_administracion?: number }): boolean {
  return f.tiene_reverso_via_administracion === 1
}

export function agruparReversosPorNc(rows: ReversoFacturaRowInput[]): ReversoAplicado[] {
  const porId = new Map<string, ReversoAplicado>()
  for (const row of rows) {
    let grupo = porId.get(row.nota_credito_id)
    if (!grupo) {
      grupo = { notaCreditoId: row.nota_credito_id, nroNcr: row.nro_ncr, tipo: row.tipo, fecha: row.fecha, lineas: [] }
      porId.set(row.nota_credito_id, grupo)
    }
    grupo.lineas.push({ descripcion: row.producto_descripcion, cantidad: row.cantidad })
  }
  return Array.from(porId.values())
}
