import { useQuery } from '@powersync/react'
import { db } from '@/core/db/powersync/db'
import { useCurrentUser } from '@/core/hooks/use-current-user'
import { v4 as uuidv4 } from 'uuid'
import Decimal from 'decimal.js'
import { bsToUsd, toStorageString, usdToBs } from '@/lib/currency'
import { localNow } from '@/lib/dates'
import { cargarMapaCuentas } from '@/features/contabilidad/hooks/use-cuentas-config'
import { generarAsientosNCR } from '@/features/contabilidad/lib/generar-asientos'
import { reversarDiferencialEnTx, useDetalleFactura as useDetalleFacturaCanonica } from '@/features/cxc/hooks/use-cxc'
import { upsertStockDeposito } from '@/features/inventario/lib/stock-deposito'
import { resolveDepositoReingresoNcr } from '@/features/inventario/lib/deposito-inactivo'
import {
  calcularDesgloseLineaNC,
  validarTopeDobleCredito,
  buildSumCantidadYaAcreditadaQuery,
  mapSumCantidadYaAcreditadaRow,
  type TipoImpuestoLineaNc,
} from '@/features/ventas/utils/notas-credito-fiscal'
import {
  buildNotasCreditoFiltro,
  rangoMesActual,
} from '@/features/ventas/utils/notas-credito-admin-filters'

// ─── Interfaces ─────────────────────────────────────────────

export interface NotaCreditoRow {
  id: string
  nro_ncr: string
  venta_id: string
  cliente_id: string
  tipo: string
  motivo: string
  tasa_historica: string
  total_usd: string
  total_bs: string
  fecha: string
  nro_factura: string
  cliente_nombre: string
}

export interface FacturaParaAnular {
  id: string
  nro_factura: string
  cliente_id: string
  cliente_nombre: string
  cliente_identificacion: string
  tasa: string
  total_usd: string
  total_bs: string
  saldo_pend_usd: string
  tipo: string
  fecha: string
  /** Presente solo en filas devueltas por `useFacturasSesionActiva` (Design §Decision 2). */
  status?: string
  /** PowerSync boolean-as-integer: 1 si existe una NC tipo TOTAL asociada a esta venta. */
  tiene_reverso_total?: number
  /** PowerSync boolean-as-integer: 1 si existe una NC tipo PARCIAL asociada a esta venta. */
  tiene_reverso_parcial?: number
  /** Presente solo en filas de `useFacturasSesionActiva` (Slice 3a) — alimenta `igtfUsd` de `buildReciboData` en el panel de detalle. */
  total_igtf_usd?: string
  /** Presente solo en filas de `useFacturasSesionActiva` (Slice 6, Design §Decision 3): 1 si existe una NC con `entry_point='TRADICIONAL'` asociada a esta venta — alimenta el badge "Vía administración". */
  tiene_reverso_via_administracion?: number
}

export interface DetalleFacturaItem {
  producto_nombre: string
  producto_codigo: string
  cantidad: string
  precio_unitario_usd: string
}

export interface PagoFacturaItem {
  metodo_nombre: string
  moneda: string
  monto: string
  monto_usd: string
}

/**
 * Modalidad de liquidacion (Slice 3, Design §Decision 4, Spec
 * notas-credito-liquidacion). `EFECTIVO_REAL` es la condicion — no una
 * "modalidad" del selector de UI en el sentido estricto de la spec — que
 * dispara la Regla de Oro (egreso real del cajon POS activo); se incluye
 * aqui porque el mismo campo `liquidacion_modalidad` la persiste (CHECK de
 * `migrations/0091_notas_credito_schema.sql` y Design §5 tabla de schema
 * listan 5 valores, no 4 — obs #2812, reconciliado en este slice).
 * `REFUND_TESORERIA` comparte el MISMO write core que `EFECTIVO_REAL` desde
 * el two-pass de Slice 3a/3b (Design §Decision 5 "Consequence": ambas son
 * funcionalmente identicas al escribir — la diferencia es solo el valor
 * persistido en `liquidacion_modalidad` para auditoria). Un throw fantasma
 * que quedo del modelo pre-3a bloqueaba esta modalidad; retirado (obs
 * #2954). Convencion de ruta: `nota-credito-pos-modal.tsx` (POS) siempre usa
 * `EFECTIVO_REAL`; `crear-ncr-modal.tsx` (Tradicional) siempre usa
 * `REFUND_TESORERIA` para un reintegro en efectivo/banco/tesoreria.
 */
export type LiquidacionModalidad =
  | 'EFECTIVO_REAL'
  | 'SALDO_FAVOR'
  | 'COMPENSACION_VENTA'
  | 'AJUSTE_CXC'
  | 'REFUND_TESORERIA'

/** Modalidades que MUST NOT generar ninguna salida de efectivo/tarjeta (Spec notas-credito-liquidacion, Gate anti-fraude). */
const MODALIDADES_NO_DESEMBOLSO: readonly LiquidacionModalidad[] = [
  'SALDO_FAVOR',
  'COMPENSACION_VENTA',
  'AJUSTE_CXC',
]

export function esModalidadNoDesembolso(modalidad: LiquidacionModalidad): boolean {
  return (MODALIDADES_NO_DESEMBOLSO as readonly string[]).includes(modalidad)
}

/** Parametro que representaria un intento explicito de forzar una salida de caja. Solo lo consume el gate — nunca dispara el egreso real de la Regla de Oro (ese se calcula internamente, ver `aplicaReglaDeOro`). */
export interface EgresoCajaParams {
  metodoCobroId: string
  monto: number
}

/**
 * Gate anti-fraude de "comprobante de no-desembolso" (Design §3 paso 0b,
 * Spec notas-credito-liquidacion req. Gate anti-fraude). Bloquea A NIVEL DE
 * FUNCION — no depende de que la UI lo impida — cualquier intento de
 * combinar una modalidad no-efectivo con un pedido explicito de salida de
 * caja. Se evalua ANTES de abrir la transaccion (ni siquiera toca la DB):
 * una llamada directa a `crearNotaCredito` que bypasee la UI cae en el
 * mismo chequeo.
 */
export function assertGateAntiFraudeNoDesembolso(
  modalidad: LiquidacionModalidad,
  egresoParams: EgresoCajaParams | undefined
): void {
  if (egresoParams && esModalidadNoDesembolso(modalidad)) {
    throw new Error(
      `Comprobante de no-desembolso violado: la modalidad '${modalidad}' no admite una salida de efectivo/tarjeta. El bloqueo se aplica a nivel de funcion, no de UI.`
    )
  }
}

/**
 * Una asignacion dentro del array `origenDinero` (Slice 2 REWORK, Design
 * §Decision 5, obs #2948/#2949): una cuenta especifica de donde sale una
 * PARTE del dinero a reintegrar. Un NC puede combinar VARIAS asignaciones
 * de tipos distintos en un solo reintegro (owner's canonical example: Bs500
 * de efectivo de sesion + Bs500 de tesoreria via banco, en UNA sola NC) —
 * reemplaza el modelo pre-rework de una unica cuenta por NC.
 *
 * `monto` esta en la moneda NATIVA de la cuenta (espejo del patron de pago
 * del POS, `use-ventas.ts:771-807` — la cuenta ES la moneda, sin selector
 * de moneda aparte). Para `SESION_EFECTIVO`, `cuentaId` apunta a un
 * `metodos_cobro.id` de tipo efectivo (Decision 5) — esa reinterpretacion
 * (vs. una sesion) recien se materializa en el two-pass write de Slice 3a;
 * el WRITE branch heredado de Slice 1/2 (paso 6c, sin cambios en este
 * slice) sigue tratando la PRIMERA asignacion `SESION_EFECTIVO` del array
 * como si `cuentaId` fuera una sesion, exactamente como el objeto unico
 * pre-rework.
 */
export interface OrigenDinero {
  tipo: 'SESION_EFECTIVO' | 'TESORERIA_EFECTIVO' | 'BANCO'
  cuentaId: string
  monto: string
}

/**
 * Validacion pura (pre-tx, sin tocar la DB) del array `origenDinero` (Slice
 * 2 REWORK, Design §Decision 5, obs #2948/#2949/#2938). Se evalua junto a
 * `assertGateAntiFraudeNoDesembolso`, ANTES de abrir la transaccion — una
 * llamada directa que bypasee la UI cae en el mismo chequeo.
 *
 * Reemplaza por completo las Rules 1/2 pre-rework (tipo de cuenta
 * restringido POR modalidad: `EFECTIVO_REAL`⇒solo-sesion,
 * `REFUND_TESORERIA`⇒solo-tesoreria) — un NC ahora puede mezclar
 * libremente tipos de cuenta en un solo reintegro; que modalidad se eligio
 * solo afecta el valor persistido de `liquidacion_modalidad` (auditoria).
 *
 * Reglas (design.md §Decision 5 "Validation rules", en orden):
 * 1. Modalidad de DESEMBOLSO (`!esModalidadNoDesembolso`) exige un array
 *    NO vacio (≥1 asignacion) — no se puede elegir una modalidad que mueve
 *    dinero y no reintegrar nada.
 * 2. Modalidad SIN desembolso exige array vacio/indefinido (gate
 *    extension, mismo espiritu que `assertGateAntiFraudeNoDesembolso`).
 * 3. Cada asignacion: `monto > 0` (Decimal) — nunca cero ni negativo.
 * 4. Sin pares `(tipo, cuentaId)` duplicados en el array (defensivo, evita
 *    doble-conteo de una misma cuenta).
 * 5. `entryPoint==='POS'` + el array contiene `SESION_EFECTIVO` ⇒ la
 *    sesion resuelta es SIEMPRE `sesionCajaActivaId` (no hay eleccion
 *    per-asignacion, Decision 5) — validado aqui como
 *    `sesionCajaActivaId` obligatorio (simetrico a la Rule 6). El array ya
 *    NO restringe que TIPOS de cuenta puede usar POS (a diferencia de las
 *    Rules 1/2 viejas) — puede combinar sesion+tesoreria+banco libremente.
 * 6. `entryPoint==='TRADICIONAL'` + el array contiene `SESION_EFECTIVO` ⇒
 *    `sesionDestinoId` es obligatorio (una sola sesion elegida por el
 *    usuario, para TODA la NC — Decision 5 "simplificacion deliberada").
 */
export function validarOrigenDinero(params: {
  modalidad: LiquidacionModalidad
  entryPoint: 'POS' | 'TRADICIONAL'
  sesionCajaActivaId?: string
  sesionDestinoId?: string
  origenDinero?: OrigenDinero[]
}): void {
  const { modalidad, entryPoint, sesionCajaActivaId, sesionDestinoId, origenDinero } = params
  const asignaciones = origenDinero ?? []
  const noDesembolso = esModalidadNoDesembolso(modalidad)

  if (!noDesembolso && asignaciones.length === 0) {
    throw new Error(
      `origenDinero invalido: la modalidad '${modalidad}' mueve dinero y exige al menos una asignacion (array no vacio) en origenDinero.`
    )
  }

  if (noDesembolso && asignaciones.length > 0) {
    throw new Error(
      `origenDinero invalido: la modalidad '${modalidad}' es no-desembolso y no admite origenDinero.`
    )
  }

  for (const asignacion of asignaciones) {
    if (!new Decimal(asignacion.monto).gt(0)) {
      throw new Error(
        `origenDinero invalido: cada asignacion exige monto > 0 (recibido '${asignacion.monto}' para la cuenta '${asignacion.cuentaId}').`
      )
    }
  }

  const cuentasVistas = new Set<string>()
  for (const asignacion of asignaciones) {
    const clave = `${asignacion.tipo}::${asignacion.cuentaId}`
    if (cuentasVistas.has(clave)) {
      throw new Error(
        `origenDinero invalido: la cuenta '${asignacion.cuentaId}' (${asignacion.tipo}) esta duplicada en el array.`
      )
    }
    cuentasVistas.add(clave)
  }

  const tieneSesionEfectivo = asignaciones.some((a) => a.tipo === 'SESION_EFECTIVO')

  if (entryPoint === 'POS' && tieneSesionEfectivo && !sesionCajaActivaId) {
    throw new Error(
      `origenDinero invalido: desde el POS, una asignacion SESION_EFECTIVO exige sesionCajaActivaId — la sesion resuelta es siempre la propia, no elegible por asignacion (Design §Decision 5).`
    )
  }

  if (entryPoint === 'TRADICIONAL' && tieneSesionEfectivo && !sesionDestinoId) {
    throw new Error(
      `origenDinero invalido: desde 'TRADICIONAL', una asignacion SESION_EFECTIVO exige sesionDestinoId — una sola sesion elegida para toda la NC (Design §Decision 5).`
    )
  }
}

/** Linea seleccionada por el llamador para una NC PARCIAL (Slice 4b, Design §Interfaces). */
export interface LineaNcSeleccionada {
  /** FK a `ventas_det.id` — linea original de la factura a acreditar. */
  venta_det_id: string
  /** Cantidad a devolver de ESA linea (puede ser parcial respecto a lo vendido). */
  cantidadDevolver: string
}

export interface CrearNotaCreditoParams {
  venta_id: string
  motivo: string
  usuario_id: string
  empresa_id: string
  /**
   * Ambito de emision (Regla de Oro, obs #2804): 'POS' = cajero dentro de su
   * sesion de caja activa (solo facturas de esa sesion). 'TRADICIONAL' =
   * modulo dedicado de NC, cualquier factura de la empresa, NUNCA toca el
   * cajon fisico de una sesion activa sin egreso explicito salvo que
   * `origenDinero` lo pida (ver `REFUND_TESORERIA`, la modalidad reservada
   * a esta ruta para reintegros de tesoreria/banco).
   */
  entryPoint: 'POS' | 'TRADICIONAL'
  /** Id de la sesion de caja activa del cajero — solo relevante cuando `entryPoint === 'POS'`. */
  sesionCajaActivaId?: string
  /**
   * Sesion UNICA elegida para recibir el reintegro cuando `entryPoint ===
   * 'TRADICIONAL'` y `origenDinero` contiene alguna asignacion
   * `SESION_EFECTIVO` (Slice 2 REWORK, Design §Decision 5). Obligatorio en
   * ese caso (`validarOrigenDinero` rechaza si falta) — una sola sesion por
   * NC, nunca elegida per-asignacion. Irrelevante para `entryPoint ===
   * 'POS'` (siempre usa `sesionCajaActivaId`).
   */
  sesionDestinoId?: string
  /** Modalidad de liquidacion elegida (Slice 3, obligatoria). */
  modalidad: LiquidacionModalidad
  /**
   * Array de asignaciones de origen del dinero cuando la modalidad MUEVE
   * efectivo/tarjeta (Slice 2 REWORK, Design §Decision 5, obs
   * #2948/#2949). Reemplaza el objeto unico pre-rework: un NC puede
   * combinar VARIAS cuentas (sesion + tesoreria + banco) en un solo
   * reintegro — el monto reintegrado NUNCA es un input separado, se
   * DERIVA como la suma del array. Obligatorio (array no vacio) SOLO
   * cuando `modalidad` mueve dinero (`EFECTIVO_REAL` | `REFUND_TESORERIA`)
   * — validado ANTES de abrir la transaccion via `validarOrigenDinero`.
   * Omitido/vacio para las 3 modalidades sin desembolso. El array puede
   * cubrir MENOS que el remanente total (el resto queda como credito a
   * favor, SAFC) — esa logica de invariante-de-suma + escritura
   * multi-cuenta es Slice 3a/3b; este slice solo valida forma pura.
   */
  origenDinero?: OrigenDinero[]
  /**
   * Defensa en profundidad / prueba directa del gate anti-fraude: NUNCA se
   * envia en el flujo normal junto a una modalidad no-efectivo. El egreso
   * real de la Regla de Oro (EFECTIVO_REAL) se calcula internamente a partir
   * de `entryPoint`/`sesionCajaActivaId`/`venta.sesion_caja_id` — este
   * parametro NO lo dispara, solo existe para que el gate tenga algo
   * explicito que rechazar.
   */
  egresoParams?: EgresoCajaParams
  /**
   * Tipo de NC (Slice 4b, Design §3/§Interfaces). Default `'TOTAL'` cuando
   * se omite — preserva el comportamiento previo a este slice byte-a-byte
   * (todas las lineas de `ventas_det`, cantidad completa). `'PARCIAL'`
   * requiere `lineas`.
   */
  tipo?: 'TOTAL' | 'PARCIAL'
  /**
   * Lineas seleccionadas para devolver. Solo se usa cuando `tipo ===
   * 'PARCIAL'` — para `tipo === 'TOTAL'` (o cuando se omite `tipo`) SIEMPRE
   * se derivan TODAS las lineas de `ventas_det` con su cantidad completa,
   * ignorando cualquier valor pasado aqui (Design §2 "mismo codigo, sin
   * ramas duplicadas").
   */
  lineas?: LineaNcSeleccionada[]
  /**
   * Override explicito del deposito de reingreso de stock (Slice 5a-2a,
   * Design §Interfaces, obs #2840 — cierra el WARNING de threading diferido
   * en Slice 5a). Cuando se provee, DEBE ser un deposito ACTIVO de la MISMA
   * empresa — se valida dentro de la tx y se rechaza (sin escribir nada) si
   * no lo es. Cuando se omite, el deposito se resuelve por el riel
   * automatico existente (`resolveDepositoReingresoNcr`): origen de la
   * venta si sigue activo, o el principal si no. El modulo Tradicional
   * (`crear-ncr-modal.tsx`) ya threadea aqui la eleccion libre de su
   * selector; el POS-express (`nota-credito-pos-modal.tsx`, Slice 5a-2a)
   * todavia NO expone override propio — siempre omite este parametro y usa
   * el riel automatico (el override de deposito para POS es PIN B, Slice
   * 5a-2b, todavia sin construir).
   */
  depositoReingresoId?: string
}

export interface CrearNotaCreditoResult {
  ncrId: string
  nroNcr: string
}

// ─── Listado de NCR ─────────────────────────────────────────

/**
 * Filtros opcionales de `useNotasCredito` (Slice B,
 * notas-credito-ruta-administrativa, Design §Decision 4). `fechaDesde`/
 * `fechaHasta` son opcionales a este nivel — a diferencia de
 * `FiltroNotasCredito` (el builder puro de Slice A, donde son
 * obligatorios): cuando el llamador pasa un objeto `filtros` pero omite el
 * rango, el hook aplica `rangoMesActual()` (Spec: "Carga por defecto
 * limitada al mes en curso"). Pasar un rango explicito amplio es el
 * mecanismo de escape para "ver todo el historial" (Design §Riesgos) — no
 * existe un flag separado.
 *
 * Slice E.2 (tester QA feedback): `busqueda` reemplaza los campos
 * separados `nroNcr`/`tipo`/`clienteNombre`/`clienteIdentificacion`
 * (retirados, la UI ya no los expone por separado — un solo input de
 * busqueda, patron POS). Slice E.b (correccion sobre E.3): el filtro de
 * Estado (`EstadoFiltroNotaCredito`, Reverso Total/Reverso Parcial) se
 * RETIRO por completo de esta pestaña — a diferencia de Facturas, NO se
 * folded en la busqueda.
 */
export interface FiltroNotasCreditoHook {
  fechaDesde?: string
  fechaHasta?: string
  busqueda?: string
}

/**
 * `useNotasCredito()` sin argumentos preserva byte-a-byte el query historico
 * completo pre-existente (consumidores no migrados, p.ej.
 * `notas-credito-page.tsx` hasta que Slice C reescriba la pagina en tabs).
 * `useNotasCredito(filtros)` delega la construccion del SQL a
 * `buildNotasCreditoFiltro` (Slice A) aplicando `rangoMesActual()` cuando el
 * llamador omite `fechaDesde`/`fechaHasta`.
 */
export function useNotasCredito(filtros?: FiltroNotasCreditoHook) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''

  let sql: string
  let params: unknown[]

  if (filtros) {
    const fechaDesde = filtros.fechaDesde ?? rangoMesActual().fechaDesde
    const fechaHasta = filtros.fechaHasta ?? rangoMesActual().fechaHasta
    const built = buildNotasCreditoFiltro({
      empresaId,
      fechaDesde,
      fechaHasta,
      busqueda: filtros.busqueda,
    })
    sql = built.sql
    params = built.params
  } else {
    sql = `SELECT
       nc.id, nc.nro_ncr, nc.venta_id, nc.cliente_id, nc.tipo, nc.motivo,
       nc.tasa_historica, nc.total_usd, nc.total_bs, nc.fecha,
       v.nro_factura,
       c.nombre as cliente_nombre
     FROM notas_credito nc
     JOIN ventas v ON nc.venta_id = v.id
     JOIN clientes c ON nc.cliente_id = c.id
     WHERE nc.empresa_id = ?
     ORDER BY nc.fecha DESC`
    params = [empresaId]
  }

  const { data, isLoading } = useQuery(sql, params)

  return { notas: (data ?? []) as NotaCreditoRow[], isLoading }
}

// ─── Historial de reversos de una factura (F1 QA fix, Slice 5a) ─────

export interface ReversoFacturaRow {
  nota_credito_id: string
  nro_ncr: string
  tipo: string
  fecha: string
  venta_det_id: string | null
  producto_descripcion: string
  cantidad: string
}

/**
 * Historial COMPLETO de NCs ya aplicadas a una factura, a nivel de linea
 * (openspec/changes/notas-credito-ui-pos, QA batch 5a — F1). Alimenta (a) el
 * panel de detalle (seccion "Notas de credito aplicadas", via
 * `agruparReversosPorNc`) y (b) el tope de cantidad restante por linea (via
 * `calcularReversoPorLinea`) que consume `SeleccionLineasNc` para no permitir
 * sobre-reversar una linea ya parcialmente acreditada. Filtra `empresa_id`.
 */
export function useReversosFactura(ventaId: string | null, empresaId: string) {
  const { data, isLoading } = useQuery(
    ventaId && empresaId
      ? `SELECT nc.id as nota_credito_id, nc.nro_ncr, nc.tipo, nc.fecha,
           ncd.venta_det_id, ncd.descripcion as producto_descripcion, ncd.cantidad
         FROM notas_credito nc
         JOIN notas_credito_det ncd ON ncd.nota_credito_id = nc.id
         WHERE nc.venta_id = ? AND nc.empresa_id = ?
         ORDER BY nc.fecha ASC`
      : '',
    ventaId && empresaId ? [ventaId, empresaId] : []
  )
  return { reversos: (data ?? []) as ReversoFacturaRow[], isLoading }
}

// ─── Detalle de factura (articulos + pagos) ─────────────────
// La consulta de lineas (ventas_det + productos) vive en el hook canonico
// de `use-cxc.ts` — aca solo se agrega la consulta de pagos, propia de este
// flujo de anulacion/reimpresion.

export function useDetalleFactura(ventaId: string | null) {
  const { detalle, isLoading: loadingDetalles } = useDetalleFacturaCanonica(ventaId)

  const { data: pagos, isLoading: loadingPagos } = useQuery(
    ventaId
      ? `SELECT mp.nombre as metodo_nombre, CASE WHEN mon.codigo_iso = 'VES' THEN 'BS' ELSE COALESCE(mon.codigo_iso, 'USD') END as moneda, pg.monto, pg.monto_usd
         FROM pagos pg
         JOIN metodos_cobro mp ON pg.metodo_cobro_id = mp.id
         LEFT JOIN monedas mon ON pg.moneda_id = mon.id
         WHERE pg.venta_id = ?`
      : '',
    ventaId ? [ventaId] : []
  )

  return {
    detalles: detalle,
    pagos: (pagos ?? []) as PagoFacturaItem[],
    isLoading: loadingDetalles || loadingPagos,
  }
}

// ─── Funcion atomica: crearNotaCredito ──────────────────────

export async function crearNotaCredito(
  params: CrearNotaCreditoParams
): Promise<CrearNotaCreditoResult> {
  const {
    venta_id,
    motivo,
    usuario_id,
    empresa_id,
    entryPoint,
    sesionCajaActivaId,
    sesionDestinoId,
    modalidad,
    origenDinero,
    egresoParams,
    tipo,
    lineas,
    depositoReingresoId,
  } = params

  // 0b. Gate anti-fraude (Design §3 paso 0b): se evalua ANTES de abrir la
  // transaccion — sin tocar la DB. Ver `assertGateAntiFraudeNoDesembolso`.
  assertGateAntiFraudeNoDesembolso(modalidad, egresoParams)

  // 0c. Validacion de origenDinero (Slice 2 REWORK, Design §Decision 5):
  // igual que el gate anterior, se evalua ANTES de abrir la transaccion —
  // sin tocar la DB. Ver `validarOrigenDinero`.
  validarOrigenDinero({ modalidad, entryPoint, sesionCajaActivaId, sesionDestinoId, origenDinero })

  let ncrId = ''
  let nroNcr = ''

  await db.writeTransaction(async (tx) => {
    const now = localNow()
    ncrId = uuidv4()

    // 1. Leer factura y validar. El reingreso de stock vuelve al deposito
    //    de ORIGEN de la venta (`venta.deposito_id`, NOT NULL desde
    //    0006_ventas.sql) — NUNCA se re-deriva el deposito principal de la
    //    empresa (spec NCD/Reingreso al Deposito de Origen).
    const ventaResult = await tx.execute('SELECT * FROM ventas WHERE id = ?', [venta_id])
    if (!ventaResult.rows || ventaResult.rows.length === 0) {
      throw new Error('Factura no encontrada')
    }
    const venta = ventaResult.rows.item(0) as {
      id: string
      cliente_id: string
      nro_factura: string
      tasa: string
      total_usd: string
      total_bs: string
      saldo_pend_usd: string
      tipo: string
      status: string
      deposito_id: string
      sesion_caja_id: string | null
    }
    const depositoOrigenId = venta.deposito_id

    // Slice 2 (Regla de Oro, obs #2804/#2807 Design §4): la NC solo queda
    // vinculada a la sesion de caja ACTIVA cuando se emite desde el POS
    // express — el modulo Tradicional NUNCA la vincula (factura potencialmente
    // historica, ni idea de que sesion este abierta en este momento).
    const sesionCajaIdParaNc = entryPoint === 'POS' ? sesionCajaActivaId ?? null : null

    // Tipo TOTAL/PARCIAL (Slice 4b, Design §3/§Interfaces). Default 'TOTAL'
    // cuando el llamador omite `tipo` — preserva el comportamiento previo a
    // este slice byte-a-byte (todas las lineas, cantidad completa). La
    // reversa de pagos (paso 6c) solo aplica para tipo='TOTAL' (Design §3
    // paso 8: "PARCIAL nunca reversa pagos, siguen siendo validos por el
    // saldo remanente").
    const tipoNc: 'TOTAL' | 'PARCIAL' = tipo ?? 'TOTAL'

    // Persistido en `notas_credito.no_desembolso` (Design §5, Spec gate
    // anti-fraude) — TRUE para las 3 modalidades sin efectivo, FALSE para
    // EFECTIVO_REAL/REFUND_TESORERIA (estas SI mueven dinero, aunque por
    // rieles distintos: cajon POS vs tesoreria).
    const noDesembolso = esModalidadNoDesembolso(modalidad)

    // Slice 2 (decouple, Design §origenDinero shape/decoupling): tres
    // conceptos independientes reemplazan el boolean unico `aplicaReglaDeOro`
    // que antes acoplaba ambito+modalidad+"misma sesion que la venta" en un
    // solo flag. `movesCash` decide SI hay egreso real (categoria, viene de
    // `modalidad`, ya no exige `entryPoint==='POS'`: Decision 4 permite a
    // TRADICIONAL mover el cajon de cualquier sesion activa). La CUENTA
    // especifica es `origenDinero` (validado pre-tx por `validarOrigenDinero`
    // — incluye el carril protegido de POS). El requisito "misma sesion que
    // la venta" (`venta.sesion_caja_id === sesionCajaActivaId`) se DROPEA
    // por completo: la divergencia emision!=dinero es un feature intencional
    // desde TRADICIONAL (Design §Decision 4 "Intentional divergence", obs
    // #2938) — `venta.sesion_caja_id` ya no participa en esta decision.
    const movesCash = !noDesembolso

    if (venta.status === 'ANULADA') {
      throw new Error('Esta factura ya fue anulada')
    }

    // Reingreso automatico (change `guarda-deposito-inactivo` Slice B,
    // decision de producto #3, obs #2228): si el deposito de ORIGEN de la
    // venta sigue activo, el stock reingresa ahi (comportamiento pre-existente,
    // sin cambios). Si fue desactivado desde la venta, cae AUTOMATICAMENTE al
    // deposito principal ACTUAL de la empresa — el cajero NUNCA elige (flujo
    // POS-express, "reversar factura del dia"). Resuelto ANTES de construir
    // cualquier INSERT de `movimientos_inventario`, para que el trigger DB de
    // defensa en profundidad (migracion 0087) nunca vea un fallback en
    // transito — siempre recibe un deposito YA activo.
    //
    // La consulta al principal SOLO ocurre cuando el origen esta inactivo
    // (lazy) — preserva el comportamiento pre-existente de NUNCA tocar
    // `es_principal` cuando el origen sigue activo (test "NO al deposito
    // principal de la empresa").
    // Override explicito (Slice 5a-2a, obs #2840): si el llamador provee
    // `depositoReingresoId`, se valida ANTES de tocar cualquier kardex que
    // sea un deposito activo de la MISMA empresa, y se usa en vez del riel
    // automatico. Sin override, cae al riel preexistente sin cambios.
    let depositoId: string | null
    if (depositoReingresoId) {
      const overrideResult = await tx.execute(
        'SELECT id FROM depositos WHERE id = ? AND empresa_id = ? AND is_active = 1',
        [depositoReingresoId, empresa_id]
      )
      if (!overrideResult.rows || overrideResult.rows.length === 0) {
        throw new Error(
          'El deposito de reingreso seleccionado no esta activo o no pertenece a la empresa.'
        )
      }
      depositoId = depositoReingresoId
    } else {
      const depositoOrigenResult = await tx.execute(
        'SELECT is_active FROM depositos WHERE id = ?',
        [depositoOrigenId]
      )
      const depositoOrigenIsActive =
        !!depositoOrigenResult.rows &&
        depositoOrigenResult.rows.length > 0 &&
        (depositoOrigenResult.rows.item(0) as { is_active: number }).is_active === 1

      let principalDepositoId: string | null = null
      if (!depositoOrigenIsActive) {
        const principalResult = await tx.execute(
          'SELECT id FROM depositos WHERE empresa_id = ? AND es_principal = 1 AND is_active = 1 LIMIT 1',
          [empresa_id]
        )
        principalDepositoId =
          principalResult.rows && principalResult.rows.length > 0
            ? (principalResult.rows.item(0) as { id: string }).id
            : null
      }

      depositoId = resolveDepositoReingresoNcr(
        depositoOrigenId,
        depositoOrigenIsActive,
        principalDepositoId
      )
    }
    if (!depositoId) {
      throw new Error(
        'No se pudo reintegrar el stock: no hay un deposito activo disponible en la empresa. Configure un deposito principal.'
      )
    }

    // 2. Generar nro_ncr (por empresa)
    const countResult = await tx.execute(
      'SELECT COUNT(*) as cnt FROM notas_credito WHERE empresa_id = ?',
      [empresa_id]
    )
    const count = Number((countResult.rows?.item(0) as { cnt: number })?.cnt ?? 0)
    nroNcr = `NCR-${String(count + 1).padStart(6, '0')}`

    // 3. Leer TODAS las lineas de la venta (Design §3 paso 3/5/6, §2 formula
    //    de desglose). TOTAL deriva todas las lineas con su cantidad
    //    completa (Design §2 "mismo codigo, sin ramas duplicadas");
    //    PARCIAL valida que cada linea seleccionada pertenece a esta
    //    factura.
    const ventaDetResult = await tx.execute(
      'SELECT id, producto_id, cantidad, lote_id, precio_unitario_usd, tipo_impuesto, impuesto_pct FROM ventas_det WHERE venta_id = ?',
      [venta_id]
    )
    type VentaDetRow = {
      id: string
      producto_id: string
      cantidad: string
      lote_id: string | null
      precio_unitario_usd: string
      tipo_impuesto: string
      impuesto_pct: string
    }
    const ventaDetRows: VentaDetRow[] = []
    if (ventaDetResult.rows) {
      for (let i = 0; i < ventaDetResult.rows.length; i++) {
        ventaDetRows.push(ventaDetResult.rows.item(i) as VentaDetRow)
      }
    }

    const lineasAProcesar: Array<{ ventaDet: VentaDetRow; cantidadDevolver: Decimal }> =
      tipoNc === 'TOTAL'
        ? ventaDetRows.map((row) => ({ ventaDet: row, cantidadDevolver: new Decimal(row.cantidad) }))
        : (lineas ?? []).map((l) => {
            const row = ventaDetRows.find((r) => r.id === l.venta_det_id)
            if (!row) {
              throw new Error(`La linea ${l.venta_det_id} no pertenece a la factura ${venta.nro_factura}`)
            }
            return { ventaDet: row, cantidadDevolver: new Decimal(l.cantidadDevolver) }
          })

    if (tipoNc === 'PARCIAL' && lineasAProcesar.length === 0) {
      throw new Error('Una nota de credito PARCIAL requiere al menos una linea seleccionada')
    }

    // Guard de doble-credito (gap real, Design §2 — el trigger Postgres solo
    // topea el total de la factura, no la cantidad por linea) + desglose
    // fiscal por linea (Slice 4a, `calcularDesgloseLineaNC`) — ANTES de
    // escribir CUALQUIER registro: si una linea excede su cantidad
    // disponible se lanza y la transaccion completa se revierte (header,
    // det y kardex quedan sin persistir).
    const desglosesPorLinea: Array<
      ReturnType<typeof calcularDesgloseLineaNC> & { ventaDet: VentaDetRow }
    > = []
    for (const { ventaDet: ventaDetRow, cantidadDevolver } of lineasAProcesar) {
      const sumQuery = buildSumCantidadYaAcreditadaQuery()
      const sumResult = await tx.execute(sumQuery.sql, [ventaDetRow.id, empresa_id])
      const sumRow =
        sumResult.rows && sumResult.rows.length > 0
          ? (sumResult.rows.item(0) as { total: string | number | null })
          : { total: 0 }
      const yaAcreditado = mapSumCantidadYaAcreditadaRow(sumRow)

      const guard = validarTopeDobleCredito({
        ventaDetId: ventaDetRow.id,
        cantidadOriginalLinea: ventaDetRow.cantidad,
        yaAcreditado,
        cantidadDevolver,
      })
      if (!guard.valido) {
        throw new Error(guard.motivo)
      }

      const desglose = calcularDesgloseLineaNC(
        {
          ventaDetId: ventaDetRow.id,
          cantidadDevolver,
          precioUnitarioUsd: ventaDetRow.precio_unitario_usd,
          tipoImpuesto: (ventaDetRow.tipo_impuesto as TipoImpuestoLineaNc) || 'Exento',
          impuestoPct: ventaDetRow.impuesto_pct,
        },
        venta.tasa
      )
      desglosesPorLinea.push({ ...desglose, ventaDet: ventaDetRow })
    }

    // Agregados de header (Design §2 "Header"): TOTAL preserva
    // venta.total_usd/total_bs VERBATIM (incluyen cargos especiales y
    // descuento comercial que NO viven en `ventas_det` — sumar solo las
    // lineas los perderia y romperia la paridad con la factura original).
    // PARCIAL usa la suma de las lineas seleccionadas — es la UNICA
    // definicion posible, no existe "factura completa" de referencia.
    const totalExentoUsd = desglosesPorLinea.reduce((acc, d) => acc.plus(d.exentoUsd), new Decimal(0))
    const totalBaseUsd = desglosesPorLinea.reduce((acc, d) => acc.plus(d.baseUsd), new Decimal(0))
    const totalIvaUsd = desglosesPorLinea.reduce((acc, d) => acc.plus(d.ivaUsd), new Decimal(0))
    const totalLineasUsd = totalExentoUsd.plus(totalBaseUsd).plus(totalIvaUsd)
    const totalUsdNc = tipoNc === 'TOTAL' ? new Decimal(venta.total_usd) : totalLineasUsd
    const totalUsdNcStr = tipoNc === 'TOTAL' ? venta.total_usd : toStorageString(totalUsdNc)
    const totalBsNcStr =
      tipoNc === 'TOTAL' ? venta.total_bs : toStorageString(usdToBs(totalUsdNc, venta.tasa))

    // 4. INSERT notas_credito (snapshot de la factura + desglose fiscal)
    // entry_point (migracion 0092, Design §Decision 3): persiste
    // params.entryPoint verbatim — 'POS' | 'TRADICIONAL'. Colocado entre
    // sesion_caja_id y liquidacion_modalidad para no desplazar la posicion
    // de los ultimos 2 parametros (liquidacion_modalidad, no_desembolso),
    // que otros tests asertan por indice.
    await tx.execute(
      `INSERT INTO notas_credito (id, nro_ncr, venta_id, cliente_id, tipo, motivo, tasa_historica, total_exento_usd, total_base_usd, total_iva_usd, total_usd, total_bs, afecta_inventario, usuario_id, fecha, empresa_id, created_at, created_by, sesion_caja_id, entry_point, liquidacion_modalidad, no_desembolso)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ncrId,
        nroNcr,
        venta_id,
        venta.cliente_id,
        tipoNc,
        motivo,
        venta.tasa,
        toStorageString(totalExentoUsd),
        toStorageString(totalBaseUsd),
        toStorageString(totalIvaUsd),
        totalUsdNcStr,
        totalBsNcStr,
        1,
        usuario_id,
        now,
        empresa_id,
        now,
        usuario_id,
        sesionCajaIdParaNc,
        entryPoint,
        modalidad,
        noDesembolso ? 1 : 0,
      ]
    )

    // 5. Por cada linea seleccionada: notas_credito_det + reingreso de stock
    //    (Design §3 paso 5/6). TOTAL incluye todas las lineas con su
    //    cantidad completa (comportamiento previo preservado); PARCIAL solo
    //    las seleccionadas con la cantidad PARCIAL pedida — nunca la
    //    cantidad completa originalmente vendida.
    for (const d of desglosesPorLinea) {
      const ventaDetRow = d.ventaDet
      const cantidadDevolver = d.cantidadDevolver.toNumber()

      const prodResult = await tx.execute('SELECT tipo, stock, nombre FROM productos WHERE id = ?', [
        ventaDetRow.producto_id,
      ])
      if (!prodResult.rows || prodResult.rows.length === 0) {
        throw new Error('Producto no encontrado al revertir stock')
      }
      const producto = prodResult.rows.item(0) as { tipo: string; stock: string; nombre: string }

      await tx.execute(
        `INSERT INTO notas_credito_det (id, empresa_id, nota_credito_id, producto_id, deposito_id, cantidad, precio_unitario_usd, tipo_impuesto, impuesto_pct, subtotal_usd, afecta_inventario, descripcion, lote_id, created_at, venta_det_id, subtotal_bs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          empresa_id,
          ncrId,
          ventaDetRow.producto_id,
          depositoId,
          d.cantidadDevolver.toFixed(3),
          toStorageString(ventaDetRow.precio_unitario_usd),
          ventaDetRow.tipo_impuesto || 'Exento',
          toStorageString(ventaDetRow.impuesto_pct || 0),
          toStorageString(d.subtotalUsd),
          producto.tipo === 'P' ? 1 : 0,
          producto.nombre,
          ventaDetRow.lote_id ?? null,
          now,
          ventaDetRow.id,
          toStorageString(d.subtotalBs),
        ]
      )

      if (producto.tipo === 'P') {
        // PRODUCTO: reintegrar stock directo
        const stockActual = parseFloat(producto.stock)
        const stockNuevo = stockActual + cantidadDevolver
        const movId = uuidv4()

        await tx.execute(
          `INSERT INTO movimientos_inventario (id, producto_id, deposito_id, tipo, origen, cantidad, stock_anterior, stock_nuevo, lote_id, doc_origen_id, doc_origen_ref, motivo, usuario_id, fecha, empresa_id, created_at)
           VALUES (?, ?, ?, 'E', 'NCR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            movId,
            ventaDetRow.producto_id,
            depositoId,
            cantidadDevolver.toFixed(3),
            stockActual.toFixed(3),
            stockNuevo.toFixed(3),
            ventaDetRow.lote_id ?? null,
            ncrId,
            `NCR-${nroNcr}`,
            `${nroNcr} - Reintegro ${producto.nombre}`,
            usuario_id,
            now,
            empresa_id,
            now,
          ]
        )

        await upsertStockDeposito(tx, {
          empresa_id,
          producto_id: ventaDetRow.producto_id,
          deposito_id: depositoId,
          delta: new Decimal(cantidadDevolver),
          usuario_id,
          now,
          movimientoInventarioId: movId,
        })

        // Si la linea tenia lote, restaurar cantidad en el lote
        if (ventaDetRow.lote_id) {
          const loteResult = await tx.execute(
            'SELECT cantidad_actual, status FROM lotes WHERE id = ?',
            [ventaDetRow.lote_id]
          )
          if (loteResult.rows && loteResult.rows.length > 0) {
            const loteRow = loteResult.rows.item(0) as { cantidad_actual: string; status: string }
            const nuevaCantLote = parseFloat(loteRow.cantidad_actual) + cantidadDevolver
            await tx.execute(
              'UPDATE lotes SET cantidad_actual = ?, status = ?, updated_at = ? WHERE id = ?',
              [nuevaCantLote.toFixed(3), 'ACTIVO', now, ventaDetRow.lote_id]
            )
          }
        }
      } else if (producto.tipo === 'S') {
        // SERVICIO: reintegrar ingredientes via recetas, escalado a la
        // cantidad PARCIAL devuelta (no la cantidad completa vendida).
        const recetasResult = await tx.execute(
          'SELECT r.producto_id, r.cantidad, p.stock, p.nombre FROM recetas r JOIN productos p ON r.producto_id = p.id WHERE r.servicio_id = ?',
          [ventaDetRow.producto_id]
        )

        if (recetasResult.rows) {
          for (let j = 0; j < recetasResult.rows.length; j++) {
            const ingrediente = recetasResult.rows.item(j) as {
              producto_id: string
              cantidad: string
              stock: string
              nombre: string
            }

            const cantidadConsumida = parseFloat(ingrediente.cantidad) * cantidadDevolver
            const stockIngrediente = parseFloat(ingrediente.stock)
            const stockNuevoIng = stockIngrediente + cantidadConsumida
            const movIngId = uuidv4()

            await tx.execute(
              `INSERT INTO movimientos_inventario (id, producto_id, deposito_id, tipo, origen, cantidad, stock_anterior, stock_nuevo, doc_origen_id, doc_origen_ref, motivo, usuario_id, fecha, empresa_id, created_at)
               VALUES (?, ?, ?, 'E', 'NCR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                movIngId,
                ingrediente.producto_id,
                depositoId,
                cantidadConsumida.toFixed(3),
                stockIngrediente.toFixed(3),
                stockNuevoIng.toFixed(3),
                ncrId,
                `NCR-${nroNcr}`,
                `${nroNcr} - Reintegro ingrediente "${ingrediente.nombre}" (servicio "${producto.nombre}")`,
                usuario_id,
                now,
                empresa_id,
                now,
              ]
            )

            await upsertStockDeposito(tx, {
              empresa_id,
              producto_id: ingrediente.producto_id,
              deposito_id: depositoId,
              delta: new Decimal(cantidadConsumida),
              usuario_id,
              now,
              movimientoInventarioId: movIngId,
            })
          }
        }
      }
    }

    // 6. Step A (Design §3 paso 7): aplicar el monto de esta NC contra la
    //    deuda YA pendiente de la factura (`venta.saldo_pend_usd`), topeado
    //    por ambos limites — no se puede aplicar mas de lo pendiente NI mas
    //    de lo que vale esta NC. Para TOTAL, montoAplicadoAPendiente ==
    //    saldoPendVenta SIEMPRE (total_usd >= saldo_pend_usd es invariante
    //    de `ventas`) — preserva el comportamiento exacto pre-Slice-4b. Para
    //    PARCIAL escala proporcionalmente al valor de las lineas
    //    seleccionadas.
    const saldoPendVenta = new Decimal(venta.saldo_pend_usd)
    const montoAplicadoAPendiente = Decimal.min(saldoPendVenta, totalUsdNc)
    const nuevoSaldoPendVenta = Decimal.max(new Decimal(0), saldoPendVenta.minus(totalUsdNc))

    // Hoisted (Slice 3a, Design §Remanente reintegrable, obs #2945): antes
    // se calculaba recien en Step B (paso 9), DESPUES del write branch de
    // dinero (paso 6c) que ahora lo necesita como tope de entrada del
    // invariante de suma de Pass 1 (`montoADevolverUsd ≤ remanenteALiquidar
    // + epsilon`) — por eso se adelanta aqui, inmediatamente despues de
    // conocer `montoAplicadoAPendiente`.
    const remanenteALiquidar = Decimal.max(new Decimal(0), totalUsdNc.minus(montoAplicadoAPendiente))

    // Slice 3b (tasks 3.11/3.12, Design §Leftover routing): `montoADevolverUsd`
    // y `EPSILON` hoisted ANTES del bloque 6c (en vez de declarados dentro)
    // para que Step B (paso 9, mas abajo) pueda leer cuanto de
    // `remanenteALiquidar` fue REALMENTE cubierto en efectivo/banco y
    // calcular `leftoverUsd`. Para toda combinacion que NO entra al bloque
    // 6c (modalidad sin desembolso, o tipoNc==='PARCIAL') queda en 0 —
    // preserva el comportamiento pre-3b donde el leftover ERA el remanente
    // completo (SALDO_FAVOR/COMPENSACION_VENTA/AJUSTE_CXC).
    let montoADevolverUsd = new Decimal(0)
    const EPSILON = new Decimal('0.005') // obs #2945/#2948/#2949 convention

    if (montoAplicadoAPendiente.gt('0.01')) {
      const clienteResult = await tx.execute('SELECT saldo_actual FROM clientes WHERE id = ?', [
        venta.cliente_id,
      ])
      if (!clienteResult.rows || clienteResult.rows.length === 0) {
        throw new Error('Cliente no encontrado')
      }
      const saldoActual = new Decimal(
        (clienteResult.rows.item(0) as { saldo_actual: string }).saldo_actual
      )
      const saldoNuevo = Decimal.max(new Decimal(0), saldoActual.minus(montoAplicadoAPendiente))

      const movCuentaId = uuidv4()
      await tx.execute(
        `INSERT INTO movimientos_cuenta (id, cliente_id, tipo, referencia, monto, saldo_anterior, saldo_nuevo, observacion, venta_id, fecha, empresa_id, created_at)
         VALUES (?, ?, 'NCR', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          movCuentaId,
          venta.cliente_id,
          nroNcr,
          toStorageString(montoAplicadoAPendiente),
          toStorageString(saldoActual),
          toStorageString(saldoNuevo),
          `Anulacion de factura ${venta.nro_factura}`,
          venta_id,
          now,
          empresa_id,
          now,
        ]
      )

      await tx.execute('UPDATE clientes SET saldo_actual = ?, updated_at = ? WHERE id = ?', [
        toStorageString(saldoNuevo),
        now,
        venta.cliente_id,
      ])
    }

    // 6b. Si la factura tenía un diferencial cambiario aplicado, reversarlo también
    try {
      await reversarDiferencialEnTx(tx, {
        ventaId: venta_id,
        clienteId: venta.cliente_id,
        nroFactura: venta.nro_factura,
        empresaId: empresa_id,
        procesadoPor: usuario_id,
      }, now)
    } catch {
      // DIFE reversal opcional — no bloquea la anulación
    }

    // 6c. Two-pass write core sobre `origenDinero[]` (Slice 3a, Design
    //     §Decision 5 Pass 1/Pass 2, obs #2948/#2949): DESACOPLADO por
    //     completo de los `pagos` originales de la venta (axis 3, obs
    //     #2948) — reemplaza el loop de Slice 1/2 que reversaba pago-por-
    //     pago 1:1. SOLO para tipo='TOTAL' (Design §3 paso 8: "PARCIAL
    //     nunca reversa pagos" — el unico llamador de PARCIAL hoy fuerza
    //     entryPoint TRADICIONAL, que nunca dispara movesCash via este
    //     slice; EFECTIVO_REAL+PARCIAL vía POS queda deferido a Slice 5a).
    if (tipoNc === 'TOTAL' && movesCash) {
      const asignaciones = origenDinero ?? []
      const tieneSesionEfectivo = asignaciones.some((a) => a.tipo === 'SESION_EFECTIVO')

      // Sesion destino resuelta UNA sola vez para TODA la NC (Decision 5
      // "simplificacion deliberada" — nunca por asignacion). Guard de
      // sesion cerrada evaluado aqui, ANTES de abrir el loop de Pass 1
      // (Design §Decision 4 "Guard"). Filtra por empresa_id — nunca
      // replicar el gap de `use-traspasos.ts:396` (sin ese filtro).
      let sesionDestino: string | null = null
      if (tieneSesionEfectivo) {
        sesionDestino = entryPoint === 'POS' ? sesionCajaActivaId ?? null : sesionDestinoId ?? null
        const sesionResult = await tx.execute(
          'SELECT status FROM sesiones_caja WHERE id = ? AND empresa_id = ?',
          [sesionDestino, empresa_id]
        )
        if (!sesionResult.rows || sesionResult.rows.length === 0) {
          throw new Error(
            'La sesion de caja destino del reintegro no existe o no pertenece a la empresa'
          )
        }
        const sesionRow = sesionResult.rows.item(0) as { status: string }
        if (sesionRow.status === 'CERRADA') {
          throw new Error(
            'La sesion de caja destino del reintegro esta CERRADA — no se puede reintegrar efectivo ahi'
          )
        }
      }

      // Pass 1 (resolver + acumular, SIN escrituras — Design §Decision 5):
      // cada asignacion tiene una cuenta real propia (metodos_cobro /
      // caja_fuerte / bancos_empresa) con su moneda FIJA — se lee su
      // `saldo_actual` + moneda para convertir el monto nativo a USD (via
      // la tasa de LA VENTA, fotografia bimonetaria) y poder sumar todas
      // las asignaciones en una base comun antes de escribir nada.
      const TABLA_POR_TIPO: Record<OrigenDinero['tipo'], string> = {
        SESION_EFECTIVO: 'metodos_cobro',
        TESORERIA_EFECTIVO: 'caja_fuerte',
        BANCO: 'bancos_empresa',
      }

      const resueltas: Array<{
        tipo: OrigenDinero['tipo']
        cuentaId: string
        monto: Decimal
        saldoActual: Decimal
      }> = []

      for (const asignacion of asignaciones) {
        const tabla = TABLA_POR_TIPO[asignacion.tipo]
        const cuentaResult = await tx.execute(
          `SELECT t.saldo_actual as saldo_actual, m.codigo_iso as moneda_codigo
             FROM ${tabla} t JOIN monedas m ON m.id = t.moneda_id
            WHERE t.id = ? AND t.empresa_id = ?`,
          [asignacion.cuentaId, empresa_id]
        )
        if (!cuentaResult.rows || cuentaResult.rows.length === 0) {
          throw new Error(
            `La cuenta '${asignacion.cuentaId}' (${asignacion.tipo}) no existe o no pertenece a la empresa`
          )
        }
        const cuentaRow = cuentaResult.rows.item(0) as { saldo_actual: string; moneda_codigo: string }
        const montoNativo = new Decimal(asignacion.monto)
        const saldoActualCuenta = new Decimal(cuentaRow.saldo_actual)

        // Slice 3b (task 3.11, obs #2950): tope DURO de disponibilidad para
        // efectivo (SESION_EFECTIVO/TESORERIA_EFECTIVO) — invariante FISICA
        // (un cajon/caja fuerte no puede quedar en negativo), se valida SIEMPRE
        // en el punto de escritura, leyendo `saldo_actual` DENTRO de esta misma
        // tx (ya leido arriba, no se repite la lectura). BANCO queda
        // deliberadamente SIN tope aqui (sobregiro permitido — politica de
        // tesoreria futura, obs #2950/#2945 regla 3).
        if (
          (asignacion.tipo === 'SESION_EFECTIVO' || asignacion.tipo === 'TESORERIA_EFECTIVO') &&
          montoNativo.gt(saldoActualCuenta)
        ) {
          throw new Error(
            `Efectivo insuficiente en la cuenta '${asignacion.cuentaId}' (${asignacion.tipo}): disponible ${saldoActualCuenta.toFixed(2)}, solicitado ${montoNativo.toFixed(2)}`
          )
        }

        const montoUsd =
          cuentaRow.moneda_codigo === 'VES' ? bsToUsd(montoNativo, venta.tasa) : montoNativo

        montoADevolverUsd = montoADevolverUsd.plus(montoUsd)
        resueltas.push({
          tipo: asignacion.tipo,
          cuentaId: asignacion.cuentaId,
          monto: montoNativo,
          saldoActual: saldoActualCuenta,
        })
      }

      if (montoADevolverUsd.gt(remanenteALiquidar.plus(EPSILON))) {
        throw new Error(
          `El monto a devolver (${montoADevolverUsd.toFixed(2)} USD) excede el remanente disponible de la factura (${remanenteALiquidar.toFixed(2)} USD)`
        )
      }

      // Pass 2 (escritura — solo tras validar Pass 1 completo, atomicidad
      // regla de negocio #9): loop UNIFORME sobre los 3 tipos de cuenta, la
      // misma forma para todos salvo la tabla/columnas de cada ledger.
      // `metodos_cobro.saldo_actual` recibe el MISMO real-balance tracking
      // que `caja_fuerte`/`bancos_empresa` (Design §Decision 1 extension).
      for (const r of resueltas) {
        const saldoNuevo = r.saldoActual.minus(r.monto)

        if (r.tipo === 'SESION_EFECTIVO') {
          await tx.execute(
            `INSERT INTO movimientos_metodo_cobro
               (id, empresa_id, metodo_cobro_id, tipo, origen, monto, saldo_anterior, saldo_nuevo,
                doc_origen_id, doc_origen_ref, concepto, sesion_caja_id, fecha, created_at, created_by)
             VALUES (?, ?, ?, 'EGRESO', 'NCR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              uuidv4(),
              empresa_id,
              r.cuentaId,
              toStorageString(r.monto),
              toStorageString(r.saldoActual),
              toStorageString(saldoNuevo),
              ncrId,
              `NCR-${nroNcr}`,
              `Devolucion NCR ${nroNcr} - Venta ${venta.nro_factura}`,
              sesionDestino,
              now,
              now,
              usuario_id,
            ]
          )
          await tx.execute(
            'UPDATE metodos_cobro SET saldo_actual = ?, updated_at = ? WHERE id = ? AND empresa_id = ?',
            [toStorageString(saldoNuevo), now, r.cuentaId, empresa_id]
          )
        } else if (r.tipo === 'TESORERIA_EFECTIVO') {
          await tx.execute(
            `INSERT INTO mov_caja_fuerte
               (id, empresa_id, caja_fuerte_id, tipo, origen, monto, saldo_anterior, saldo_nuevo,
                doc_origen_id, doc_origen_tipo, referencia, descripcion, validado, reversado, fecha, created_at, created_by)
             VALUES (?, ?, ?, 'EGRESO', 'REFUND_NCR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              uuidv4(),
              empresa_id,
              r.cuentaId,
              toStorageString(r.monto),
              toStorageString(r.saldoActual),
              toStorageString(saldoNuevo),
              ncrId,
              'NOTA_CREDITO',
              `NCR-${nroNcr}`,
              `Devolucion NCR ${nroNcr} - Venta ${venta.nro_factura}`,
              1,
              0,
              now,
              now,
              usuario_id,
            ]
          )
          await tx.execute(
            'UPDATE caja_fuerte SET saldo_actual = ?, updated_at = ? WHERE id = ? AND empresa_id = ?',
            [toStorageString(saldoNuevo), now, r.cuentaId, empresa_id]
          )
        } else {
          await tx.execute(
            `INSERT INTO movimientos_bancarios
               (id, empresa_id, banco_empresa_id, tipo, origen, monto, saldo_anterior, saldo_nuevo,
                doc_origen_id, doc_origen_tipo, referencia, descripcion, validado, reversado, fecha, created_at, created_by)
             VALUES (?, ?, ?, 'EGRESO', 'REFUND_NCR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              uuidv4(),
              empresa_id,
              r.cuentaId,
              toStorageString(r.monto),
              toStorageString(r.saldoActual),
              toStorageString(saldoNuevo),
              ncrId,
              'NOTA_CREDITO',
              `NCR-${nroNcr}`,
              `Devolucion NCR ${nroNcr} - Venta ${venta.nro_factura}`,
              1,
              0,
              now,
              now,
              usuario_id,
            ]
          )
          await tx.execute(
            'UPDATE bancos_empresa SET saldo_actual = ?, updated_at = ? WHERE id = ? AND empresa_id = ?',
            [toStorageString(saldoNuevo), now, r.cuentaId, empresa_id]
          )
        }
      }
    }

    // Reversa de pagos (axis 2, Design §3 paso 8 — INDEPENDIENTE del axis 3
    // de arriba, obs #2948): siempre que la NC sea TOTAL, sin importar el
    // ambito (POS o Tradicional) — evita que el pago original siga contando
    // como ingreso valido en los totales por metodo (gap #3 en obs #2803).
    // YA NO se leen los pagos para calcular ningun egreso (esa relacion se
    // rompio por completo, obs #2948) — solo se marcan is_reversed=1.
    if (tipoNc === 'TOTAL') {
      await tx.execute(
        `UPDATE pagos SET is_reversed = 1, reversed_at = ?, reversed_by = ?, reversed_reason = ?
         WHERE venta_id = ? AND is_reversed = 0`,
        [now, usuario_id, motivo, venta_id]
      )
    }

    // 7. Step B (Design §3 paso 9, generalizado por Slice 3b tasks 3.12/3.17,
    //     Design §"Leftover routing — combination is the DEFAULT"):
    //     liquidar lo que NO quedo cubierto por el two-pass write core de
    //     arriba (paso 6c). `AJUSTE_CXC` es la UNICA modalidad que fuerza
    //     `origenDinero` vacio (Rule 2) — su rama usa el `remanenteALiquidar`
    //     completo, sin cambios (nunca crea credito, solo cancela deuda
    //     existente). Para CUALQUIER OTRA modalidad (incluidas
    //     SALDO_FAVOR/COMPENSACION_VENTA — que nunca entran al bloque 6c,
    //     `montoADevolverUsd` queda en 0 — Y EFECTIVO_REAL/REFUND_TESORERIA
    //     con cobertura PARCIAL en efectivo/banco) el SOBRANTE
    //     (`leftoverUsd = remanenteALiquidar - montoADevolverUsd`) se
    //     enruta como credito a favor (SAFC) — esta ES la "combinacion"
    //     que obs #2948 declara valida (parte efectivo + parte credito).
    //     `remanenteALiquidar`/`montoADevolverUsd`/`EPSILON` ya fueron
    //     hoisted arriba (Slice 3a/3b, antes de paso 6c) — no se
    //     redeclaran aqui. Estructura if/else-if: NUNCA ambas ramas
    //     escriben para la misma NC (sin doble-credito).
    if (modalidad === 'AJUSTE_CXC') {
      if (remanenteALiquidar.gt('0.01')) {
        // Reusa el MISMO patron de reduccion de saldo que Step A (paso 5,
        // lineas ~440-478) — nunca crea credito, solo cancela deuda
        // EXISTENTE del cliente (tope en 0). Task 3.4.
        const clienteAjusteResult = await tx.execute(
          'SELECT saldo_actual FROM clientes WHERE id = ?',
          [venta.cliente_id]
        )
        if (!clienteAjusteResult.rows || clienteAjusteResult.rows.length === 0) {
          throw new Error('Cliente no encontrado')
        }
        const saldoActualAjuste = new Decimal(
          (clienteAjusteResult.rows.item(0) as { saldo_actual: string }).saldo_actual || '0'
        )
        const saldoNuevoAjuste = Decimal.max(new Decimal(0), saldoActualAjuste.minus(remanenteALiquidar))

        await tx.execute(
          `INSERT INTO movimientos_cuenta (id, cliente_id, tipo, referencia, monto, saldo_anterior, saldo_nuevo, observacion, venta_id, fecha, empresa_id, created_at)
           VALUES (?, ?, 'NCR', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(),
            venta.cliente_id,
            `${nroNcr}-AJUSTE`,
            toStorageString(remanenteALiquidar),
            toStorageString(saldoActualAjuste),
            toStorageString(saldoNuevoAjuste),
            `Ajuste CxC por ${nroNcr} - Factura ${venta.nro_factura}`,
            venta_id,
            now,
            empresa_id,
            now,
          ]
        )

        await tx.execute('UPDATE clientes SET saldo_actual = ?, updated_at = ? WHERE id = ?', [
          toStorageString(saldoNuevoAjuste),
          now,
          venta.cliente_id,
        ])
      }
    } else {
      const leftoverUsd = remanenteALiquidar.minus(montoADevolverUsd)
      if (leftoverUsd.gt(EPSILON)) {
        // SALDO_FAVOR y COMPENSACION_VENTA dejan el MISMO SAFC trazable
        // (Design §3: "COMPENSACION_VENTA compone con una venta nueva
        // simultanea... dos transacciones secuenciales"). La diferencia
        // vive en el LLAMADOR (Slice 5 UI hara un crearVenta() separado que
        // consume este SAFC via `safEntry`) — crearNotaCredito nunca invoca
        // crearVenta() internamente (tradeoff aceptado, obs task 3.1).
        // Slice 3b generaliza esta MISMA rama para EFECTIVO_REAL/
        // REFUND_TESORERIA cuando el array no cubrio el remanente completo
        // (Design §Leftover routing) — `leftoverUsd` reemplaza a
        // `remanenteALiquidar` como monto escrito; para las 2 modalidades
        // sin desembolso son identicos (`montoADevolverUsd` siempre 0).
        //
        // Reusa el PATRON de `registrarSafExcedente`
        // (src/features/cxc/hooks/use-cxc.ts:1934) pero INLINE dentro de
        // esta misma transaccion — NO se invoca esa funcion standalone
        // porque abre su propia `db.writeTransaction` y anidar
        // transacciones rompe la atomicidad unica exigida por el diseño
        // (Design §Technical Approach: "un unico db.writeTransaction()").
        // `doc_origen_id`/`doc_origen_tipo` dejan el SAFC trazable hasta
        // `nota_credito_id` (Spec notas-credito-liquidacion, scenario
        // "SAFC generado referencia el nota_credito_id de origen").
        const clienteSafcResult = await tx.execute(
          'SELECT saldo_actual FROM clientes WHERE id = ?',
          [venta.cliente_id]
        )
        if (!clienteSafcResult.rows || clienteSafcResult.rows.length === 0) {
          throw new Error('Cliente no encontrado')
        }
        const saldoActualSafc = new Decimal(
          (clienteSafcResult.rows.item(0) as { saldo_actual: string }).saldo_actual || '0'
        )
        const saldoNuevoSafc = saldoActualSafc.minus(leftoverUsd)

        await tx.execute(
          `INSERT INTO movimientos_cuenta (id, cliente_id, tipo, referencia, monto, saldo_anterior, saldo_nuevo, observacion, venta_id, fecha, empresa_id, created_at, created_by, doc_origen_id, doc_origen_tipo)
           VALUES (?, ?, 'SAFC', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(),
            venta.cliente_id,
            `SAF-NCR-${nroNcr}`,
            toStorageString(leftoverUsd),
            toStorageString(saldoActualSafc),
            toStorageString(saldoNuevoSafc),
            `Saldo a favor generado por ${nroNcr} (${modalidad}) - Factura ${venta.nro_factura}`,
            venta_id,
            now,
            empresa_id,
            now,
            usuario_id,
            ncrId,
            'NOTA_CREDITO',
          ]
        )

        await tx.execute('UPDATE clientes SET saldo_actual = ?, updated_at = ? WHERE id = ?', [
          toStorageString(saldoNuevoSafc),
          now,
          venta.cliente_id,
        ])
      }
    }

    // 8. Actualizar saldo_pend_usd de la factura. TOTAL ademas marca
    //    status='ANULADA' (unico caso permitido por el trigger
    //    prevent_venta_mutation) — comportamiento identico a pre-Slice-4b.
    //    PARCIAL nunca cambia status: la factura sigue ACTIVA con su saldo
    //    reducido (Design §3 paso 7).
    if (tipoNc === 'TOTAL') {
      await tx.execute("UPDATE ventas SET status = 'ANULADA', saldo_pend_usd = ? WHERE id = ?", [
        '0.00',
        venta_id,
      ])
    } else {
      await tx.execute('UPDATE ventas SET saldo_pend_usd = ? WHERE id = ?', [
        toStorageString(nuevoSaldoPendVenta),
        venta_id,
      ])
    }

    // 9. Generar asientos contables NCR
    try {
      const cuentas = await cargarMapaCuentas(tx, empresa_id)
      await generarAsientosNCR(tx, {
        empresaId: empresa_id,
        ncrId,
        nroNcr,
        ventaId: venta_id,
        totalUsd: new Decimal(venta.total_usd).toNumber(),
        afectaCxC: saldoPendVenta.gt('0.01'),
        banco_empresa_id: null,
        cuentas,
        usuarioId: usuario_id,
      })
    } catch {
      // Fallo en contabilidad no bloquea la NCR
    }
  })

  return { ncrId, nroNcr }
}
