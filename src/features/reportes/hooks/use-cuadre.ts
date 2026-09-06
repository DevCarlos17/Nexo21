import { useMemo } from 'react'
import { useQuery } from '@powersync/react'
import { useCurrentUser } from '@/core/hooks/use-current-user'

// ─── Shared types ───────────────────────────────────────────

/**
 * Verified payment entry emitted by CuadreDetallePagos per metodo_cobro_id.
 * native  = amount in the method's own currency (Bs for BS methods, USD for USD methods)
 * usd     = USD equivalent
 * moneda  = 'USD' | 'BS'
 * overrideCount = number of payments whose amount was adjusted by a supervisor
 */
export interface VerifiedEntry {
  native: number
  usd: number
  moneda: string
  overrideCount: number
}

// ─── Filters ────────────────────────────────────────────────

export interface CuadreFilters {
  fecha: string
  cajaId: string | null
  sesionCajaIds: string[]   // empty = todas las sesiones del dia/caja
}

/**
 * Builds dynamic WHERE clause fragments for cuadre queries.
 * Returns [whereClause, params].
 * `tableAlias` is the alias prefix (e.g. 'v' for ventas).
 * `dateColumn` is the column name for date filtering (default: 'fecha').
 */
function buildCuadreWhere(
  filters: CuadreFilters,
  empresaId: string,
  tableAlias = '',
  dateColumn = 'fecha'
): [string, unknown[]] {
  const prefix = tableAlias ? `${tableAlias}.` : ''
  const clauses: string[] = [`${prefix}empresa_id = ?`]
  const params: unknown[] = [empresaId]

  if (filters.sesionCajaIds.length > 0) {
    // IDs de sesion ya acotan el rango — no se aplica filtro de fecha
    const placeholders = filters.sesionCajaIds.map(() => '?').join(', ')
    clauses.push(`${prefix}sesion_caja_id IN (${placeholders})`)
    params.push(...filters.sesionCajaIds)
  } else if (filters.cajaId) {
    clauses.push(`DATE(${prefix}${dateColumn}, 'localtime') = ?`)
    clauses.push(
      `${prefix}sesion_caja_id IN (SELECT id FROM sesiones_caja WHERE caja_id = ? AND empresa_id = ?)`
    )
    params.push(filters.fecha, filters.cajaId, empresaId)
  } else {
    clauses.push(`DATE(${prefix}${dateColumn}, 'localtime') = ?`)
    params.push(filters.fecha)
  }

  return [clauses.join(' AND '), params]
}

/**
 * Same as buildCuadreWhere but for tables without sesion_caja_id (like ventas_det).
 * Filters via a JOIN to the ventas table using ventaAlias.
 */
function buildCuadreWhereViaVenta(
  filters: CuadreFilters,
  empresaId: string,
  ventaAlias: string,
  dateColumn = 'fecha'
): [string, unknown[]] {
  const clauses: string[] = [`${ventaAlias}.empresa_id = ?`]
  const params: unknown[] = [empresaId]

  if (filters.sesionCajaIds.length > 0) {
    // IDs de sesion ya acotan el rango — no se aplica filtro de fecha
    const placeholders = filters.sesionCajaIds.map(() => '?').join(', ')
    clauses.push(`${ventaAlias}.sesion_caja_id IN (${placeholders})`)
    params.push(...filters.sesionCajaIds)
  } else if (filters.cajaId) {
    clauses.push(`DATE(${ventaAlias}.${dateColumn}, 'localtime') = ?`)
    clauses.push(
      `${ventaAlias}.sesion_caja_id IN (SELECT id FROM sesiones_caja WHERE caja_id = ? AND empresa_id = ?)`
    )
    params.push(filters.fecha, filters.cajaId, empresaId)
  } else {
    clauses.push(`DATE(${ventaAlias}.${dateColumn}, 'localtime') = ?`)
    params.push(filters.fecha)
  }

  return [clauses.join(' AND '), params]
}

// ─── Interfaces ─────────────────────────────────────────────

export interface CuadreKpis {
  totalVentasUsd: number
  totalVentasBs: number
  facturasCount: number
  ticketPromedio: number
  gananciaEstimada: number
  cxcTotalUsd: number
  cxcTotalBs: number
}

export interface VentaDeptItem {
  departamento: string
  totalUsd: number
}

export interface MetodoPagoResumen {
  nombre: string
  moneda: string
  tipo: string
  totalUsd: number
  totalOriginal: number
  totalBs: number
}

export interface TopProducto {
  nombre: string
  codigo: string
  cantidad: number
  totalUsd: number
}

export interface TopGananciaItem {
  nombre: string
  codigo: string
  cantidad: number
  gananciaUsd: number
}

export interface VentaAudit {
  id: string
  nro_factura: string
  cliente_nombre: string
  cliente_identificacion: string
  total_usd: string
  total_bs: string
  tasa: string
  tipo: string
  fecha: string
  status: string
  saldo_pend_usd: string
  metodos_pago: string | null
}

export interface DetalleCxc {
  id: string
  nro_factura: string
  cliente_nombre: string
  cliente_identificacion: string
  saldo_pend_usd: string
  tasa: string
  fecha: string
}

export interface FacturaMetodoItem {
  venta_id: string
  nro_factura: string
  cliente_nombre: string
  monto: string
  monto_usd: string
  referencia: string | null
  fecha: string
  moneda: string
  venta_tipo: string
  /** 1 si el pago fue inicial (contado al emitir), 0 si es cobro CxC posterior */
  es_pago_inicial: number
}

export interface ProductoDeptoItem {
  codigo: string
  nombre: string
  cantidad: number
  totalUsd: number
}

// ─── KPIs ──────────────────────────────────────────────────

export function useVentasDelDia(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhere(filters, empresaId) : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data, isLoading } = useQuery(
    `SELECT
       COUNT(*) as cnt,
       COALESCE(SUM(CAST(total_usd AS REAL)), 0) as sum_usd,
       COALESCE(SUM(CAST(total_bs AS REAL)), 0) as sum_bs
     FROM ventas
     WHERE ${where}`,
    params
  )

  const row = (data?.[0] ?? {}) as { cnt: number; sum_usd: number; sum_bs: number }
  const count = Number(row.cnt ?? 0)
  const totalUsd = Number(row.sum_usd ?? 0)
  const totalBs = Number(row.sum_bs ?? 0)

  return {
    facturasCount: count,
    totalVentasUsd: totalUsd,
    totalVentasBs: totalBs,
    ticketPromedio: count > 0 ? Number((totalUsd / count).toFixed(2)) : 0,
    isLoading,
  }
}

export function useGananciaEstimada(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhereViaVenta(filters, empresaId, 'v') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data, isLoading } = useQuery(
    `SELECT
       COALESCE(SUM(
         (CAST(dv.precio_unitario_usd AS REAL) - CAST(p.costo_usd AS REAL)) * CAST(dv.cantidad AS REAL)
       ), 0) as ganancia
     FROM ventas_det dv
     JOIN ventas v ON dv.venta_id = v.id
     JOIN productos p ON dv.producto_id = p.id
     WHERE ${where}`,
    params
  )

  const ganancia = Number((data?.[0] as { ganancia: number })?.ganancia ?? 0)
  return { ganancia: Number(ganancia.toFixed(2)), isLoading }
}

export function useCxcDelDia(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhere(filters, empresaId) : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data, isLoading } = useQuery(
    `SELECT
       COALESCE(SUM(CAST(saldo_pend_usd AS REAL)), 0) as cxc_usd,
       COALESCE(SUM(CAST(saldo_pend_usd AS REAL) * CAST(tasa AS REAL)), 0) as cxc_bs
     FROM ventas
     WHERE ${where}
       AND tipo = 'CREDITO'
       AND CAST(saldo_pend_usd AS REAL) > 0.001`,
    params
  )

  const row = (data?.[0] ?? {}) as { cxc_usd: number; cxc_bs: number }
  return {
    cxcTotalUsd: Number(Number(row.cxc_usd ?? 0).toFixed(2)),
    cxcTotalBs: Number(Number(row.cxc_bs ?? 0).toFixed(2)),
    isLoading,
  }
}

// ─── Breakdown: Departamentos ──────────────────────────────

export function useVentasPorDepto(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhereViaVenta(filters, empresaId, 'v') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data, isLoading } = useQuery(
    `SELECT
       d.nombre as departamento,
       COALESCE(SUM(CAST(dv.precio_unitario_usd AS REAL) * CAST(dv.cantidad AS REAL)), 0) as total_usd
     FROM ventas_det dv
     JOIN ventas v ON dv.venta_id = v.id
     JOIN productos p ON dv.producto_id = p.id
     JOIN departamentos d ON p.departamento_id = d.id
     WHERE ${where}
     GROUP BY d.id, d.nombre
     ORDER BY total_usd DESC`,
    params
  )

  const items: VentaDeptItem[] = (data ?? []).map((row: Record<string, unknown>) => ({
    departamento: String(row.departamento ?? ''),
    totalUsd: Number(Number(row.total_usd ?? 0).toFixed(2)),
  }))

  return { deptos: items, isLoading }
}

// ─── Helper: WHERE para movimientos_metodo_cobro ───────────

/**
 * Construye WHERE para movimientos_metodo_cobro usando los mismos filtros de cuadre.
 * Se usa para detectar metodos EFECTIVO con saldo manual (sin pagos de venta).
 */
function buildMovsWhere(
  filters: CuadreFilters,
  empresaId: string,
  alias = 'mmc'
): [string, unknown[]] {
  const p = alias ? `${alias}.` : ''
  const clauses: string[] = [`${p}empresa_id = ?`]
  const params: unknown[] = [empresaId]

  if (filters.sesionCajaIds.length > 0) {
    const ph = filters.sesionCajaIds.map(() => '?').join(', ')
    clauses.push(`${p}sesion_caja_id IN (${ph})`)
    params.push(...filters.sesionCajaIds)
  } else if (filters.cajaId) {
    clauses.push(
      `${p}sesion_caja_id IN (SELECT id FROM sesiones_caja WHERE caja_id = ? AND empresa_id = ?)`
    )
    params.push(filters.cajaId, empresaId)
  } else {
    clauses.push(`DATE(${p}fecha, 'localtime') = ?`)
    params.push(filters.fecha)
  }

  return [clauses.join(' AND '), params]
}

// ─── Breakdown: Metodos de Pago ────────────────────────────

export function usePagosPorMetodo(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhere(filters, empresaId, 'pg') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )
  const [whereNotIn, paramsNotIn] = useMemo(
    () => filters ? buildCuadreWhere(filters, empresaId, 'pg2') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )
  const [whereMmc, paramsMmc] = useMemo(
    () => filters ? buildMovsWhere(filters, empresaId, 'mmc') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  // Query principal: metodos con pagos de ventas
  // GROUP BY solo por mp.id para evitar filas duplicadas cuando moneda es NULL en algunos pagos
  const { data, isLoading } = useQuery(
    `SELECT
       mp.id as metodo_cobro_id,
       mp.nombre,
       mp.tipo,
       CASE WHEN mon.codigo_iso = 'VES' THEN 'BS' ELSE COALESCE(mon.codigo_iso, 'USD') END as moneda,
       COALESCE(SUM(CAST(pg.monto_usd AS REAL)), 0) as total_usd,
       COALESCE(SUM(CAST(pg.monto AS REAL)), 0) as total_original,
       COALESCE(SUM(CAST(pg.monto_usd AS REAL) * CAST(v.tasa AS REAL)), 0) as total_bs
     FROM pagos pg
     JOIN metodos_cobro mp ON pg.metodo_cobro_id = mp.id
     LEFT JOIN monedas mon ON mp.moneda_id = mon.id
     LEFT JOIN ventas v ON pg.venta_id = v.id
     WHERE ${where}
       AND pg.venta_id IS NOT NULL
     GROUP BY mp.id
     ORDER BY total_usd DESC`,
    params
  )

  // Query secundaria: metodos EFECTIVO con movimientos manuales pero sin pagos de venta.
  // Cubre el caso de caja con ingresos/egresos manuales y sin ventas en efectivo.
  const { data: extraData, isLoading: extraLoading } = useQuery(
    filters
      ? `SELECT
           mc.id as metodo_cobro_id,
           mc.nombre,
           mc.tipo,
           CASE WHEN mon.codigo_iso = 'VES' THEN 'BS' ELSE COALESCE(mon.codigo_iso, 'USD') END as moneda,
           0 as total_usd,
           0 as total_original,
           0 as total_bs
         FROM metodos_cobro mc
         LEFT JOIN monedas mon ON mc.moneda_id = mon.id
         WHERE mc.tipo = 'EFECTIVO'
           AND mc.empresa_id = ?
           AND mc.id NOT IN (
             SELECT DISTINCT pg2.metodo_cobro_id FROM pagos pg2 WHERE ${whereNotIn}
           )
             AND mc.id IN (
              SELECT DISTINCT mmc.metodo_cobro_id
              FROM movimientos_metodo_cobro mmc
              WHERE ${whereMmc}
            )
          GROUP BY mc.id`
       : '',
    filters ? [empresaId, ...paramsNotIn, ...paramsMmc] : []
  )

  // Query terciaria: metodos EFECTIVO con solo fondo inicial (apertura) pero sin pagos ni movimientos.
  // Cubre el caso de caja con fondo inicial registrado en sesiones_caja pero sin ventas ni movimientos manuales.
  const hasSessionForApertura = filters !== null && filters.sesionCajaIds.length > 0
  const aperturaPlaceholders = hasSessionForApertura
    ? filters!.sesionCajaIds.map(() => '?').join(', ')
    : ''
  const { data: aperturaData, isLoading: aperturaLoading } = useQuery(
    hasSessionForApertura
      ? `SELECT
           mc.id as metodo_cobro_id,
           mc.nombre,
           mc.tipo,
           CASE WHEN mon.codigo_iso = 'VES' THEN 'BS' ELSE COALESCE(mon.codigo_iso, 'USD') END as moneda,
           0 as total_usd,
           0 as total_original,
           0 as total_bs
         FROM metodos_cobro mc
         LEFT JOIN monedas mon ON mc.moneda_id = mon.id
         WHERE mc.tipo = 'EFECTIVO'
           AND mc.empresa_id = ?
           AND mc.id NOT IN (
             SELECT DISTINCT pg2.metodo_cobro_id FROM pagos pg2 WHERE ${whereNotIn}
           )
           AND mc.id NOT IN (
             SELECT DISTINCT mmc.metodo_cobro_id
             FROM movimientos_metodo_cobro mmc
             WHERE ${whereMmc}
           )
           AND (
             (COALESCE(mon.codigo_iso, 'USD') != 'VES' AND EXISTS (
               SELECT 1 FROM sesiones_caja sc
               WHERE sc.id IN (${aperturaPlaceholders})
                 AND CAST(COALESCE(sc.monto_apertura_usd, '0') AS REAL) > 0.001
             ))
             OR (mon.codigo_iso = 'VES' AND EXISTS (
                SELECT 1 FROM sesiones_caja sc
                WHERE sc.id IN (${aperturaPlaceholders})
                  AND CAST(COALESCE(sc.monto_apertura_bs, '0') AS REAL) > 0.001
              ))
            )
          GROUP BY mc.id`
       : '',
    hasSessionForApertura
      ? [empresaId, ...paramsNotIn, ...paramsMmc, ...filters!.sesionCajaIds, ...filters!.sesionCajaIds]
      : []
  )

  const toItem = (row: Record<string, unknown>) => ({
    metodo_cobro_id: String(row.metodo_cobro_id ?? ''),
    nombre: String(row.nombre ?? ''),
    tipo: String(row.tipo ?? ''),
    moneda: String(row.moneda ?? 'USD'),
    totalUsd: Number(Number(row.total_usd ?? 0).toFixed(2)),
    totalOriginal: Number(Number(row.total_original ?? 0).toFixed(2)),
    totalBs: Number(Number(row.total_bs ?? 0).toFixed(2)),
  })

  // Deduplicar los tres conjuntos: pagos > extra > apertura — memoizado para referencia estable.
  // Solo dedup por metodo_cobro_id: las tres queries ya son mutuamente excluyentes por diseño
  // (extra y apertura usan NOT IN para no repetir métodos que aparecen en la query principal).
  const metodos = useMemo(() => {
    const seenId = new Set<string>()
    return [
      ...(data ?? []).map(toItem),
      ...(extraData ?? []).map(toItem),
      ...(aperturaData ?? []).map(toItem),
    ].filter((m) => {
      if (seenId.has(m.metodo_cobro_id)) return false
      seenId.add(m.metodo_cobro_id)
      return true
    })
  }, [data, extraData, aperturaData])

  return { metodos, isLoading: isLoading || extraLoading || aperturaLoading }
}

// ─── Reintegros de Notas de Credito por Metodo (Slice 5) ───

/**
 * Reintegros en efectivo de sesion (`SESION_EFECTIVO`) generados por notas de
 * credito (Design §"Cuadre Integration" efecto #2). Lee `movimientos_metodo_cobro`
 * con `origen='NCR'` (el unico valor que el write core de `crearNotaCredito`
 * usa para este origen, obs #2956) y hace JOIN a `notas_credito` via
 * `doc_origen_id` para surfacar `nro_ncr` (trazabilidad).
 *
 * Alcance BASE (Slice 5, ver tasks.md Phase 5 SCOPE BOUNDARY): solo la porcion
 * de `SESION_EFECTIVO` — tesoreria (`mov_caja_fuerte`) y banco
 * (`movimientos_bancarios`) tienen su PROPIO cuadre/conciliacion (design.md:
 * "each account's own cuadre picks up exactly its slice via existing
 * filters"), no se tocan aqui.
 *
 * `total_usd` no viene precomputado (obs #2949: `movimientos_metodo_cobro` NO
 * tiene columna `monto_usd`, solo `pagos` la tiene) — se reconstruye para
 * metodos en Bs dividiendo por `notas_credito.tasa_historica`, la MISMA tasa
 * (`venta.tasa`, fotografia bimonetaria) usada por el write core al calcular
 * `montoUsd = bsToUsd(montoNativo, venta.tasa)`.
 */
export interface ReintegroNcrItem {
  metodoCobroId: string
  metodoNombre: string
  moneda: string
  totalUsd: number
  totalOriginal: number
  nroNcr: string
}

export function useReintegrosPorMetodo(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildMovsWhere(filters, empresaId, 'mmc') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data, isLoading } = useQuery(
    filters
      ? `SELECT
           mc.id as metodo_cobro_id,
           mc.nombre as metodo_nombre,
           CASE WHEN mon.codigo_iso = 'VES' THEN 'BS' ELSE COALESCE(mon.codigo_iso, 'USD') END as moneda,
           COALESCE(SUM(
             CASE WHEN mon.codigo_iso = 'VES'
               THEN CAST(mmc.monto AS REAL) / NULLIF(CAST(nc.tasa_historica AS REAL), 0)
               ELSE CAST(mmc.monto AS REAL)
             END
           ), 0) as total_usd,
           COALESCE(SUM(CAST(mmc.monto AS REAL)), 0) as total_original,
           nc.nro_ncr as nro_ncr
         FROM movimientos_metodo_cobro mmc
         JOIN metodos_cobro mc ON mmc.metodo_cobro_id = mc.id
         LEFT JOIN monedas mon ON mc.moneda_id = mon.id
         JOIN notas_credito nc ON mmc.doc_origen_id = nc.id
         WHERE ${where} AND mmc.origen = 'NCR' AND nc.empresa_id = ?
         GROUP BY mc.id, nc.nro_ncr
         ORDER BY nc.nro_ncr, mc.nombre`
      : '',
    filters ? [...params, empresaId] : []
  )

  const reintegros: ReintegroNcrItem[] = (data ?? []).map((row: Record<string, unknown>) => ({
    metodoCobroId: String(row.metodo_cobro_id ?? ''),
    metodoNombre: String(row.metodo_nombre ?? ''),
    moneda: String(row.moneda ?? 'USD'),
    totalUsd: Number(Number(row.total_usd ?? 0).toFixed(2)),
    totalOriginal: Number(Number(row.total_original ?? 0).toFixed(2)),
    nroNcr: String(row.nro_ncr ?? ''),
  }))

  return { reintegros, isLoading }
}

// ─── Top Productos ─────────────────────────────────────────

export function useTopProductos(filters: CuadreFilters | null, limit = 15) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhereViaVenta(filters, empresaId, 'v') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data, isLoading } = useQuery(
    `SELECT
       p.nombre,
       p.codigo,
       COALESCE(SUM(CAST(dv.cantidad AS REAL)), 0) as cantidad,
       COALESCE(SUM(CAST(dv.precio_unitario_usd AS REAL) * CAST(dv.cantidad AS REAL)), 0) as total_usd
     FROM ventas_det dv
     JOIN ventas v ON dv.venta_id = v.id
     JOIN productos p ON dv.producto_id = p.id
     WHERE ${where}
     GROUP BY p.id, p.nombre, p.codigo
     ORDER BY cantidad DESC
     LIMIT ${limit}`,
    params
  )

  const items: TopProducto[] = (data ?? []).map((row: Record<string, unknown>) => ({
    nombre: String(row.nombre ?? ''),
    codigo: String(row.codigo ?? ''),
    cantidad: Number(row.cantidad ?? 0),
    totalUsd: Number(Number(row.total_usd ?? 0).toFixed(2)),
  }))

  return { productos: items, isLoading }
}

// ─── Audit: Lista de Ventas ────────────────────────────────

export function useVentasAudit(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhere(filters, empresaId, 'v') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data, isLoading } = useQuery(
    `SELECT
       v.id, v.nro_factura, v.total_usd, v.total_bs, v.tasa, v.tipo, v.fecha, v.status,
       v.saldo_pend_usd,
       c.nombre as cliente_nombre,
       c.identificacion as cliente_identificacion,
       (SELECT GROUP_CONCAT(nombre, ', ')
        FROM (SELECT DISTINCT mp.nombre as nombre
              FROM pagos pg
              JOIN metodos_cobro mp ON pg.metodo_cobro_id = mp.id
              WHERE pg.venta_id = v.id AND pg.is_reversed = 0
              ORDER BY mp.nombre)) as metodos_pago
     FROM ventas v
     JOIN clientes c ON v.cliente_id = c.id
     WHERE ${where}
     ORDER BY v.fecha DESC`,
    params
  )

  return { ventas: (data ?? []) as VentaAudit[], isLoading }
}

// ─── Audit: Detalle de una venta ───────────────────────────

export interface DetalleVentaAudit {
  producto_nombre: string
  producto_codigo: string
  cantidad: string
  precio_unitario_usd: string
}

export interface PagoVentaAudit {
  metodo_nombre: string
  moneda: string
  monto: string
  monto_usd: string
  tasa: string
  referencia: string | null
}

export function useDetalleVenta(ventaId: string | null) {
  const { data: detalles, isLoading: loadingDetalles } = useQuery(
    ventaId
      ? `SELECT p.nombre as producto_nombre, p.codigo as producto_codigo, dv.cantidad, dv.precio_unitario_usd
         FROM ventas_det dv
         JOIN productos p ON dv.producto_id = p.id
         WHERE dv.venta_id = ?`
      : '',
    ventaId ? [ventaId] : []
  )

  const { data: pagos, isLoading: loadingPagos } = useQuery(
    ventaId
      ? `SELECT mp.nombre as metodo_nombre, CASE WHEN mon.codigo_iso = 'VES' THEN 'BS' ELSE COALESCE(mon.codigo_iso, 'USD') END as moneda, pg.monto, pg.monto_usd, pg.tasa, pg.referencia
         FROM pagos pg
         JOIN metodos_cobro mp ON pg.metodo_cobro_id = mp.id
         LEFT JOIN monedas mon ON pg.moneda_id = mon.id
         WHERE pg.venta_id = ?`
      : '',
    ventaId ? [ventaId] : []
  )

  return {
    detalles: (detalles ?? []) as DetalleVentaAudit[],
    pagos: (pagos ?? []) as PagoVentaAudit[],
    isLoading: loadingDetalles || loadingPagos,
  }
}

// ─── CxC del dia ───────────────────────────────────────────

export function useDetalleCxcDia(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhere(filters, empresaId, 'v') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data, isLoading } = useQuery(
    `SELECT
       v.id, v.nro_factura, v.saldo_pend_usd, v.tasa, v.fecha,
       c.nombre as cliente_nombre,
       c.identificacion as cliente_identificacion
     FROM ventas v
     JOIN clientes c ON v.cliente_id = c.id
     WHERE ${where}
       AND v.tipo = 'CREDITO'
       AND CAST(v.saldo_pend_usd AS REAL) > 0.001
     ORDER BY v.fecha ASC`,
    params
  )

  return { facturas: (data ?? []) as DetalleCxc[], isLoading }
}

// ─── Sesiones por Caja y Fecha ─────────────────────────────

export interface SesionCajaOption {
  id: string
  status: string
  fecha_apertura: string
  usuario_nombre: string | null
}

export function useSesionesPorCajaYFecha(cajaId: string | null, fecha: string) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''

  const { data, isLoading } = useQuery(
    cajaId
      ? `SELECT sc.id, sc.status, sc.fecha_apertura, u.nombre as usuario_nombre
         FROM sesiones_caja sc
         LEFT JOIN usuarios u ON sc.usuario_apertura_id = u.id
         WHERE sc.empresa_id = ? AND sc.caja_id = ? AND DATE(sc.fecha_apertura, 'localtime') = ?
         ORDER BY sc.fecha_apertura ASC`
      : '',
    cajaId ? [empresaId, cajaId, fecha] : []
  )

  return { sesiones: (data ?? []) as SesionCajaOption[], isLoading }
}

// ─── Tasa del Dia ──────────────────────────────────────────

/**
 * Tasa vigente para el cierre. Devuelve la ULTIMA tasa registrada hasta la fecha
 * del cierre (inclusive), no un promedio del dia.
 *
 * Razon: el BCV publica una sola tasa por dia y el cierre se procesa en tiempo
 * real. Si un dia no hay registro de actualizacion, significa que la tasa no
 * vario respecto al dia anterior, por lo que la ultima vigente sigue aplicando.
 * El AVG diario anterior devolvia 0 en dias sin registro y rompia el cierre con
 * comision bancaria en Bs. Ademas apuntaba a columnas inexistentes (`tasa` en
 * vez de `valor`, `created_at` en vez de `fecha`), enmascarado por el COALESCE.
 * Se usa el mismo patron de columnas que useTasaActual (fecha DESC, created_at DESC).
 */
export function useTasaDelDia(fecha: string | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''

  const { data, isLoading } = useQuery(
    fecha
      ? `SELECT CAST(valor AS REAL) as tasa_vigente
         FROM tasas_cambio
         WHERE empresa_id = ? AND fecha <= ?
         ORDER BY fecha DESC, created_at DESC
         LIMIT 1`
      : '',
    fecha ? [empresaId, fecha] : []
  )

  const row = (data?.[0] ?? {}) as { tasa_vigente: number }
  const tasaVigente = Number(Number(row.tasa_vigente ?? 0).toFixed(4))
  return {
    tasaPromedio: tasaVigente,
    // Se conserva el nombre por compatibilidad con los consumidores; ahora es 1
    // si hay una tasa vigente, 0 si no existe ninguna registrada.
    tasaCount: tasaVigente > 0 ? 1 : 0,
    isLoading,
  }
}

// ─── Top Ganancias ─────────────────────────────────────────

export function useTopGanancias(filters: CuadreFilters | null, limit = 10) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhereViaVenta(filters, empresaId, 'v') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data, isLoading } = useQuery(
    `SELECT
       p.nombre,
       p.codigo,
       COALESCE(SUM(CAST(dv.cantidad AS REAL)), 0) as cantidad,
       COALESCE(SUM(
         (CAST(dv.precio_unitario_usd AS REAL) - CAST(p.costo_usd AS REAL)) * CAST(dv.cantidad AS REAL)
       ), 0) as ganancia_usd
     FROM ventas_det dv
     JOIN ventas v ON dv.venta_id = v.id
     JOIN productos p ON dv.producto_id = p.id
     WHERE ${where}
     GROUP BY p.id, p.nombre, p.codigo
     HAVING ganancia_usd > 0
     ORDER BY ganancia_usd DESC
     LIMIT ${limit}`,
    params
  )

  const items: TopGananciaItem[] = (data ?? []).map((row: Record<string, unknown>) => ({
    nombre: String(row.nombre ?? ''),
    codigo: String(row.codigo ?? ''),
    cantidad: Number(row.cantidad ?? 0),
    gananciaUsd: Number(Number(row.ganancia_usd ?? 0).toFixed(2)),
  }))

  return { productos: items, isLoading }
}

// ─── Productos por Factura (para informe impreso) ───────────

export interface ProductoFacturaItem {
  venta_id: string
  nro_factura: string
  cliente_nombre: string
  producto_nombre: string
  producto_codigo: string
  cantidad: number
  precio_unitario_usd: number
  costo_usd: number
  impuesto_pct: number
  subtotal_usd: number
  tipo_impuesto: string
}

export function useProductosPorFactura(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhereViaVenta(filters, empresaId, 'v') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data, isLoading } = useQuery(
    `SELECT
       v.id as venta_id,
       v.nro_factura,
       c.nombre as cliente_nombre,
       p.nombre as producto_nombre,
       p.codigo as producto_codigo,
       CAST(p.costo_usd AS REAL) as costo_usd,
       CAST(dv.cantidad AS REAL) as cantidad,
       CAST(dv.precio_unitario_usd AS REAL) as precio_unitario_usd,
       CAST(dv.impuesto_pct AS REAL) as impuesto_pct,
       CAST(dv.subtotal_usd AS REAL) as subtotal_usd,
       COALESCE(dv.tipo_impuesto, '') as tipo_impuesto
     FROM ventas_det dv
     JOIN ventas v ON dv.venta_id = v.id
     JOIN productos p ON dv.producto_id = p.id
     JOIN clientes c ON v.cliente_id = c.id
     WHERE ${where}
     ORDER BY v.nro_factura, p.nombre`,
    params
  )

  return { items: (data ?? []) as ProductoFacturaItem[], isLoading }
}

// ─── Movimientos Manuales por Sesion ───────────────────────

export interface MovimientoManualItem {
  metodo_cobro_id: string
  metodo_nombre: string
  metodo_tipo: string
  metodo_moneda: string
  mov_tipo: string
  origen: string
  total: number
}

export function useMovimientosManualesDia(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''

  const hasSession = !!filters && filters.sesionCajaIds.length > 0
  const placeholders = hasSession ? filters!.sesionCajaIds.map(() => '?').join(', ') : ''

  const { data, isLoading } = useQuery(
    hasSession
      ? `SELECT
           mmc.metodo_cobro_id,
           mc.nombre as metodo_nombre,
           mc.tipo as metodo_tipo,
           CASE WHEN mon.codigo_iso = 'VES' THEN 'BS'
                ELSE COALESCE(mon.codigo_iso, 'USD') END as metodo_moneda,
           mmc.tipo as mov_tipo,
           mmc.origen,
           COALESCE(SUM(CAST(mmc.monto AS REAL)), 0) as total
         FROM movimientos_metodo_cobro mmc
         JOIN metodos_cobro mc ON mmc.metodo_cobro_id = mc.id
         LEFT JOIN monedas mon ON mc.moneda_id = mon.id
         WHERE mmc.empresa_id = ?
           AND mmc.sesion_caja_id IN (${placeholders})
         GROUP BY mmc.metodo_cobro_id, mc.nombre, mc.tipo, metodo_moneda, mmc.tipo, mmc.origen
         ORDER BY mc.nombre, mmc.tipo`
      : '',
    hasSession ? [empresaId, ...filters!.sesionCajaIds] : []
  )

  const items: MovimientoManualItem[] = (data ?? []).map((row: Record<string, unknown>) => ({
    metodo_cobro_id: String(row.metodo_cobro_id ?? ''),
    metodo_nombre: String(row.metodo_nombre ?? ''),
    metodo_tipo: String(row.metodo_tipo ?? ''),
    metodo_moneda: String(row.metodo_moneda ?? 'USD'),
    mov_tipo: String(row.mov_tipo ?? ''),
    origen: String(row.origen ?? ''),
    total: Number(Number(row.total ?? 0).toFixed(2)),
  }))

  return { movimientos: items, isLoading }
}

// ─── Apertura de Sesion para conteo fisico ─────────────────

export function useSesionApertura(filters: CuadreFilters | null) {
  const hasSession = !!filters && filters.sesionCajaIds.length > 0
  const placeholders = hasSession ? filters!.sesionCajaIds.map(() => '?').join(', ') : ''

  const { data, isLoading } = useQuery(
    hasSession
      ? `SELECT
           COALESCE(SUM(CAST(monto_apertura_usd AS REAL)), 0) as apertura_usd,
           COALESCE(SUM(CAST(monto_apertura_bs AS REAL)), 0) as apertura_bs
         FROM sesiones_caja
         WHERE id IN (${placeholders})`
      : '',
    hasSession ? filters!.sesionCajaIds : []
  )

  const row = (data?.[0] ?? {}) as { apertura_usd: number; apertura_bs: number }
  return {
    aperturaUsd: Number(Number(row.apertura_usd ?? 0).toFixed(2)),
    aperturaBs: Number(Number(row.apertura_bs ?? 0).toFixed(2)),
    isLoading,
  }
}

// ─── Saldo Esperado Efectivo Bimonetario ───────────────────
/**
 * Calcula el saldo esperado en caja para CADA divisa de forma independiente.
 * Formula por divisa: apertura + pagos_efectivo + ingresos_manuales - egresos_manuales
 * Los egresos incluyen vueltos (origen='VUELTO') porque se guardan en movimientos_metodo_cobro.
 * Solo aplica cuando hay exactamente sesionCajaIds definidos en filters.
 */
export function useSaldoEfectivoBimonetario(filters: CuadreFilters | null) {
  const hasSession = !!filters && filters.sesionCajaIds.length > 0
  const placeholders = hasSession ? filters!.sesionCajaIds.map(() => '?').join(', ') : ''

  // Montos de apertura por divisa
  const { data: dataApertura } = useQuery(
    hasSession
      ? `SELECT COALESCE(SUM(CAST(monto_apertura_usd AS REAL)), 0) as usd,
                COALESCE(SUM(CAST(monto_apertura_bs AS REAL)), 0) as bs
         FROM sesiones_caja WHERE id IN (${placeholders})`
      : '',
    hasSession ? filters!.sesionCajaIds : []
  )

  // Pagos efectivo USD (monto_usd = valor en USD).
  // Excluye asignaciones internas de excedente POS (is_pos_saf_allocation = 1)
  // porque ese efectivo ya se contabilizó en el pago de la venta original.
  const { data: dataPagosUsd } = useQuery(
    hasSession
      ? `SELECT COALESCE(SUM(CAST(p.monto_usd AS REAL)), 0) as total
         FROM pagos p
         JOIN metodos_cobro mc ON p.metodo_cobro_id = mc.id
         JOIN monedas mo ON mc.moneda_id = mo.id
         WHERE p.sesion_caja_id IN (${placeholders})
           AND mc.tipo = 'EFECTIVO' AND mo.codigo_iso = 'USD'
           AND p.venta_id IS NOT NULL`
      : '',
    hasSession ? filters!.sesionCajaIds : []
  )

  // Pagos efectivo VES (monto = valor nativo en Bs.).
  // Excluye asignaciones internas de excedente POS (is_pos_saf_allocation = 1).
  const { data: dataPagosVes } = useQuery(
    hasSession
      ? `SELECT COALESCE(SUM(CAST(p.monto AS REAL)), 0) as total
         FROM pagos p
         JOIN metodos_cobro mc ON p.metodo_cobro_id = mc.id
         JOIN monedas mo ON mc.moneda_id = mo.id
         WHERE p.sesion_caja_id IN (${placeholders})
           AND mc.tipo = 'EFECTIVO' AND mo.codigo_iso = 'VES'
           AND p.venta_id IS NOT NULL`
      : '',
    hasSession ? filters!.sesionCajaIds : []
  )

  // Movimientos manuales efectivo USD (incluye VUELTO como EGRESO).
  // Excluye origen='VENTA' porque esos pagos ya se cuentan en dataPagosUsd.
  const { data: dataMovUsd } = useQuery(
    hasSession
      ? `SELECT
           COALESCE(SUM(CASE WHEN mmc.tipo = 'INGRESO' THEN CAST(mmc.monto AS REAL) ELSE 0 END), 0) as total_ing,
           COALESCE(SUM(CASE WHEN mmc.tipo = 'EGRESO' THEN CAST(mmc.monto AS REAL) ELSE 0 END), 0) as total_egr
         FROM movimientos_metodo_cobro mmc
         JOIN metodos_cobro mc ON mmc.metodo_cobro_id = mc.id
         JOIN monedas mo ON mc.moneda_id = mo.id
         WHERE mmc.sesion_caja_id IN (${placeholders})
            AND mc.tipo = 'EFECTIVO' AND mo.codigo_iso = 'USD'
            AND mmc.origen NOT IN ('VENTA', 'COBRO', 'PROPINA')`
      : '',
    hasSession ? filters!.sesionCajaIds : []
  )

  // Movimientos manuales efectivo VES (incluye VUELTO como EGRESO).
  // Excluye: VENTA (ya en dataPagosVes), COBRO (ya en dataPagosVes via CxC),
  // PROPINA (el excedente ya está en pagos.monto del pago de la venta).
  const { data: dataMovVes } = useQuery(
    hasSession
      ? `SELECT
           COALESCE(SUM(CASE WHEN mmc.tipo = 'INGRESO' THEN CAST(mmc.monto AS REAL) ELSE 0 END), 0) as total_ing,
           COALESCE(SUM(CASE WHEN mmc.tipo = 'EGRESO' THEN CAST(mmc.monto AS REAL) ELSE 0 END), 0) as total_egr
         FROM movimientos_metodo_cobro mmc
         JOIN metodos_cobro mc ON mmc.metodo_cobro_id = mc.id
         JOIN monedas mo ON mc.moneda_id = mo.id
         WHERE mmc.sesion_caja_id IN (${placeholders})
            AND mc.tipo = 'EFECTIVO' AND mo.codigo_iso = 'VES'
            AND mmc.origen NOT IN ('VENTA', 'COBRO', 'PROPINA')`
      : '',
    hasSession ? filters!.sesionCajaIds : []
  )

  const aperRow = (dataApertura?.[0] ?? {}) as { usd: number; bs: number }
  const movUsdRow = (dataMovUsd?.[0] ?? {}) as { total_ing: number; total_egr: number }
  const movVesRow = (dataMovVes?.[0] ?? {}) as { total_ing: number; total_egr: number }

  const saldoEsperadoUsd = Number((
    Number(aperRow.usd ?? 0)
    + Number((dataPagosUsd?.[0] as { total: number } | undefined)?.total ?? 0)
    + Number(movUsdRow.total_ing ?? 0)
    - Number(movUsdRow.total_egr ?? 0)
  ).toFixed(2))

  const saldoEsperadoBs = Number((
    Number(aperRow.bs ?? 0)
    + Number((dataPagosVes?.[0] as { total: number } | undefined)?.total ?? 0)
    + Number(movVesRow.total_ing ?? 0)
    - Number(movVesRow.total_egr ?? 0)
  ).toFixed(2))

  return { saldoEsperadoUsd, saldoEsperadoBs }
}

// ─── Facturas por Metodo de Pago ───────────────────────────

export function useFacturasPorMetodo(filters: CuadreFilters | null, metodoNombre: string | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters && metodoNombre ? buildCuadreWhere(filters, empresaId, 'pg') : ['1=0', [] as unknown[]],
    [filters, empresaId, metodoNombre]
  )

  const { data, isLoading } = useQuery(
    filters && metodoNombre
      ? `SELECT
           pg.venta_id,
           v.nro_factura,
           c.nombre as cliente_nombre,
           pg.monto,
           pg.monto_usd,
           pg.referencia,
           pg.fecha,
           CASE WHEN mon.codigo_iso = 'VES' THEN 'BS' ELSE COALESCE(mon.codigo_iso, 'USD') END as moneda,
           v.tipo as venta_tipo,
           -- Un pago es INICIAL (contado al emitir) si comparte created_at con la venta
           -- (misma writeTransaction). Un cobro CxC posterior tiene created_at distinto.
           CASE WHEN pg.created_at = v.created_at THEN 1 ELSE 0 END as es_pago_inicial
         FROM pagos pg
         JOIN ventas v ON pg.venta_id = v.id
         JOIN clientes c ON v.cliente_id = c.id
         JOIN metodos_cobro mp ON pg.metodo_cobro_id = mp.id
         LEFT JOIN monedas mon ON mp.moneda_id = mon.id
         WHERE ${where} AND mp.nombre = ?
         ORDER BY pg.fecha DESC`
      : '',
    filters && metodoNombre ? [...params, metodoNombre] : []
  )

  return { facturas: (data ?? []) as FacturaMetodoItem[], isLoading }
}

// ─── Productos por Departamento ────────────────────────────

export function useProductosPorDepto(filters: CuadreFilters | null, deptoNombre: string | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters && deptoNombre ? buildCuadreWhereViaVenta(filters, empresaId, 'v') : ['1=0', [] as unknown[]],
    [filters, empresaId, deptoNombre]
  )

  const { data, isLoading } = useQuery(
    filters && deptoNombre
      ? `SELECT
           p.codigo,
           p.nombre,
           COALESCE(SUM(CAST(dv.cantidad AS REAL)), 0) as cantidad,
           COALESCE(SUM(CAST(dv.precio_unitario_usd AS REAL) * CAST(dv.cantidad AS REAL)), 0) as total_usd
         FROM ventas_det dv
         JOIN ventas v ON dv.venta_id = v.id
         JOIN productos p ON dv.producto_id = p.id
         JOIN departamentos d ON p.departamento_id = d.id
         WHERE ${where} AND d.nombre = ?
         GROUP BY p.id, p.nombre, p.codigo
         ORDER BY cantidad DESC`
      : '',
    filters && deptoNombre ? [...params, deptoNombre] : []
  )

  const items: ProductoDeptoItem[] = (data ?? []).map((row: Record<string, unknown>) => ({
    codigo: String(row.codigo ?? ''),
    nombre: String(row.nombre ?? ''),
    cantidad: Number(row.cantidad ?? 0),
    totalUsd: Number(Number(row.total_usd ?? 0).toFixed(2)),
  }))

  return { productos: items, isLoading }
}

// ─── Totales Fiscales ──────────────────────────────────────

export interface TotalesFiscales {
  baseImponibleUsd: number
  baseImponibleBs: number
  totalExentoUsd: number
  totalExentoBs: number
  totalIvaUsd: number
  totalIvaBs: number
  totalIgtfUsd: number
  totalIgtfBs: number
  totalFacturadoUsd: number
  totalFacturadoBs: number
  totalDescuentoUsd: number
  totalDescuentoBs: number
  totalNcrUsd: number
  totalNcrBs: number
  /** Solo productos/servicios (sin avances ni préstamos). Uso: Resumen Fiscal. */
  totalVentasUsd: number
  totalVentasBs: number
  /** Porción financiera: avances + préstamos cobrados al cliente. */
  totalFinancieroUsd: number
  totalFinancieroBs: number
}

export function useTotalesFiscales(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [whereV, paramsV] = useMemo(
    () => filters ? buildCuadreWhere(filters, empresaId) : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data: dataVentas, isLoading: loadingVentas } = useQuery(
    `SELECT
       COALESCE(SUM(CAST(total_base_usd AS REAL)), 0) as base_imponible,
       COALESCE(SUM(CAST(total_base_usd AS REAL) * CAST(tasa AS REAL)), 0) as base_imponible_bs,
       COALESCE(SUM(CAST(total_exento_usd AS REAL)), 0) as total_exento,
       COALESCE(SUM(CAST(total_exento_usd AS REAL) * CAST(tasa AS REAL)), 0) as total_exento_bs,
       COALESCE(SUM(CAST(total_iva_usd AS REAL)), 0) as total_iva,
       COALESCE(SUM(CAST(total_iva_usd AS REAL) * CAST(tasa AS REAL)), 0) as total_iva_bs,
       COALESCE(SUM(CAST(total_igtf_usd AS REAL)), 0) as total_igtf,
       COALESCE(SUM(CAST(total_igtf_usd AS REAL) * CAST(tasa AS REAL)), 0) as total_igtf_bs,
       COALESCE(SUM(CAST(total_usd AS REAL)), 0) as total_facturado,
       COALESCE(SUM(CAST(total_bs AS REAL)), 0) as total_facturado_bs,
       COALESCE(SUM(CAST(COALESCE(descuento_usd, '0') AS REAL)), 0) as total_descuento,
       COALESCE(SUM(CAST(COALESCE(descuento_bs, '0') AS REAL)), 0) as total_descuento_bs,
       -- Ventas puras: solo productos/servicios (sin avances ni préstamos)
       COALESCE(SUM(
         CAST(total_base_usd AS REAL) + CAST(total_exento_usd AS REAL) + CAST(total_iva_usd AS REAL)
         - CAST(COALESCE(descuento_usd, '0') AS REAL)
       ), 0) as total_ventas_puras,
       COALESCE(SUM(
         (CAST(total_base_usd AS REAL) + CAST(total_exento_usd AS REAL) + CAST(total_iva_usd AS REAL)
         - CAST(COALESCE(descuento_usd, '0') AS REAL)) * CAST(tasa AS REAL)
       ), 0) as total_ventas_puras_bs,
       -- Financiero: avances y préstamos = diferencia entre total facturado y ventas puras
       COALESCE(SUM(
         MAX(0,
           CAST(total_usd AS REAL)
           - CAST(total_base_usd AS REAL)
           - CAST(total_exento_usd AS REAL)
           - CAST(total_iva_usd AS REAL)
           + CAST(COALESCE(descuento_usd, '0') AS REAL)
         )
       ), 0) as total_financiero,
       COALESCE(SUM(
         MAX(0,
           CAST(total_usd AS REAL)
           - CAST(total_base_usd AS REAL)
           - CAST(total_exento_usd AS REAL)
           - CAST(total_iva_usd AS REAL)
           + CAST(COALESCE(descuento_usd, '0') AS REAL)
         ) * CAST(tasa AS REAL)
       ), 0) as total_financiero_bs
     FROM ventas
     WHERE ${whereV}`,
    paramsV
  )

  const row = (dataVentas?.[0] ?? {}) as {
    base_imponible: number
    base_imponible_bs: number
    total_exento: number
    total_exento_bs: number
    total_iva: number
    total_iva_bs: number
    total_igtf: number
    total_igtf_bs: number
    total_facturado: number
    total_facturado_bs: number
    total_descuento: number
    total_descuento_bs: number
    total_ventas_puras: number
    total_ventas_puras_bs: number
    total_financiero: number
    total_financiero_bs: number
  }

  // NCR de la sesion — session-scoped via buildCuadreWhere (Slice 5, task
  // 5.2/5.5: notas_credito.sesion_caja_id ya existe desde Slice 1, antes esta
  // query solo filtraba por fecha+empresa_id e ignoraba la sesion elegida).
  const [whereNcr, paramsNcr] = useMemo(
    () => filters ? buildCuadreWhere(filters, empresaId) : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )
  const { data: dataNcr, isLoading: loadingNcr } = useQuery(
    `SELECT
       COALESCE(SUM(CAST(total_usd AS REAL)), 0) as total_ncr,
       COALESCE(SUM(CAST(total_bs AS REAL)), 0) as total_ncr_bs
     FROM notas_credito
     WHERE ${whereNcr}`,
    paramsNcr
  )

  const ncrRow = (dataNcr?.[0] ?? {}) as { total_ncr: number; total_ncr_bs: number }

  return {
    totales: {
      baseImponibleUsd: Number(Number(row.base_imponible ?? 0).toFixed(2)),
      baseImponibleBs: Number(Number(row.base_imponible_bs ?? 0).toFixed(2)),
      totalExentoUsd: Number(Number(row.total_exento ?? 0).toFixed(2)),
      totalExentoBs: Number(Number(row.total_exento_bs ?? 0).toFixed(2)),
      totalIvaUsd: Number(Number(row.total_iva ?? 0).toFixed(2)),
      totalIvaBs: Number(Number(row.total_iva_bs ?? 0).toFixed(2)),
      totalIgtfUsd: Number(Number(row.total_igtf ?? 0).toFixed(2)),
      totalIgtfBs: Number(Number(row.total_igtf_bs ?? 0).toFixed(2)),
      totalFacturadoUsd: Number(Number(row.total_facturado ?? 0).toFixed(2)),
      totalFacturadoBs: Number(Number(row.total_facturado_bs ?? 0).toFixed(2)),
      totalDescuentoUsd: Number(Number(row.total_descuento ?? 0).toFixed(2)),
      totalDescuentoBs: Number(Number(row.total_descuento_bs ?? 0).toFixed(2)),
      totalNcrUsd: Number(Number(ncrRow.total_ncr ?? 0).toFixed(2)),
      totalNcrBs: Number(Number(ncrRow.total_ncr_bs ?? 0).toFixed(2)),
      totalVentasUsd: Number(Number(row.total_ventas_puras ?? 0).toFixed(2)),
      totalVentasBs: Number(Number(row.total_ventas_puras_bs ?? 0).toFixed(2)),
      totalFinancieroUsd: Number(Number(row.total_financiero ?? 0).toFixed(2)),
      totalFinancieroBs: Number(Number(row.total_financiero_bs ?? 0).toFixed(2)),
    } as TotalesFiscales,
    isLoading: loadingVentas || loadingNcr,
  }
}

// ─── Notas de Credito de la Sesion (Slice 5) ────────────────

/**
 * Lista de notas de credito de la sesion/fecha filtrada (Design §"Cuadre
 * Integration" efecto #3: "keyed on issuance session, not affected by the
 * array"). JOIN a `ventas` para surfacar `tipo_venta` (CONTADO/CREDITO) —
 * el tipo ORIGINAL de la factura anulada/reversada, para que la UI arme el
 * split contado/credito (task 5.4/5.7).
 */
export interface NotaCreditoSesionItem {
  id: string
  nroNcr: string
  ventaId: string
  tipo: string
  totalUsd: number
  totalBs: number
  fecha: string
  nroFactura: string
  tipoVenta: string
  clienteNombre: string
}

export function useNotasCreditoDeSesion(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhere(filters, empresaId, 'nc') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data, isLoading } = useQuery(
    filters
      ? `SELECT
           nc.id, nc.nro_ncr, nc.venta_id, nc.tipo,
           CAST(nc.total_usd AS REAL) as total_usd,
           CAST(nc.total_bs AS REAL) as total_bs,
           nc.fecha,
           v.nro_factura,
           v.tipo as tipo_venta,
           c.nombre as cliente_nombre
         FROM notas_credito nc
         JOIN ventas v ON nc.venta_id = v.id
         JOIN clientes c ON v.cliente_id = c.id
         WHERE ${where}
         ORDER BY nc.fecha DESC`
      : '',
    filters ? params : []
  )

  const notas: NotaCreditoSesionItem[] = (data ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id ?? ''),
    nroNcr: String(row.nro_ncr ?? ''),
    ventaId: String(row.venta_id ?? ''),
    tipo: String(row.tipo ?? ''),
    totalUsd: Number(Number(row.total_usd ?? 0).toFixed(2)),
    totalBs: Number(Number(row.total_bs ?? 0).toFixed(2)),
    fecha: String(row.fecha ?? ''),
    nroFactura: String(row.nro_factura ?? ''),
    tipoVenta: String(row.tipo_venta ?? ''),
    clienteNombre: String(row.cliente_nombre ?? ''),
  }))

  return { notas, isLoading }
}

// ─── IVA por Alicuota ──────────────────────────────────────

export interface IvaAlicuota {
  impuestoPct: number
  baseUsd: number
  baseBs: number
  montoIvaUsd: number
  montoIvaBs: number
}

export function useIvaPorAlicuota(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhereViaVenta(filters, empresaId, 'v') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data, isLoading } = useQuery(
    `SELECT
       CAST(dv.impuesto_pct AS REAL) as impuesto_pct,
       COALESCE(SUM(CAST(dv.subtotal_usd AS REAL)), 0) as base_usd,
       COALESCE(SUM(CAST(dv.subtotal_usd AS REAL) * CAST(v.tasa AS REAL)), 0) as base_bs,
       COALESCE(SUM(CAST(dv.subtotal_usd AS REAL) * CAST(dv.impuesto_pct AS REAL) / 100), 0) as monto_iva,
       COALESCE(SUM(CAST(dv.subtotal_usd AS REAL) * CAST(dv.impuesto_pct AS REAL) / 100 * CAST(v.tasa AS REAL)), 0) as monto_iva_bs
     FROM ventas_det dv
     JOIN ventas v ON dv.venta_id = v.id
     WHERE ${where}
       AND dv.tipo_impuesto != 'EXENTO'
       AND CAST(dv.impuesto_pct AS REAL) > 0
     GROUP BY dv.impuesto_pct
     ORDER BY dv.impuesto_pct DESC`,
    params
  )

  const items: IvaAlicuota[] = (data ?? []).map((row: Record<string, unknown>) => ({
    impuestoPct: Number(row.impuesto_pct ?? 0),
    baseUsd: Number(Number(row.base_usd ?? 0).toFixed(2)),
    baseBs: Number(Number(row.base_bs ?? 0).toFixed(2)),
    montoIvaUsd: Number(Number(row.monto_iva ?? 0).toFixed(2)),
    montoIvaBs: Number(Number(row.monto_iva_bs ?? 0).toFixed(2)),
  }))

  return { alicuotas: items, isLoading }
}

// ─── Pagos Detalle Completo ────────────────────────────────

export interface PagoDetalleCompleto {
  id: string
  ventaId: string | null
  nroFactura: string | null
  clienteNombre: string | null
  metodoNombre: string
  metodoCobro_id: string
  metodoTipo: string
  moneda: string
  monto: string
  montoUsd: string
  referencia: string | null
  fecha: string
}

export function usePagosDetalleCompleto(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhere(filters, empresaId, 'pg') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data, isLoading } = useQuery(
    `SELECT
       pg.id,
       pg.venta_id,
       pg.monto,
       pg.monto_usd,
       pg.referencia,
       pg.fecha,
       pg.metodo_cobro_id,
       v.nro_factura,
       c.nombre as cliente_nombre,
       mp.nombre as metodo_nombre,
       mp.tipo as metodo_tipo,
       CASE WHEN mon.codigo_iso = 'VES' THEN 'BS' ELSE COALESCE(mon.codigo_iso, 'USD') END as moneda
     FROM pagos pg
     LEFT JOIN ventas v ON pg.venta_id = v.id
     LEFT JOIN clientes c ON pg.cliente_id = c.id
     JOIN metodos_cobro mp ON pg.metodo_cobro_id = mp.id
     LEFT JOIN monedas mon ON mp.moneda_id = mon.id
     WHERE ${where}
     ORDER BY pg.fecha DESC`,
    params
  )

  const items: PagoDetalleCompleto[] = (data ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id ?? ''),
    ventaId: row.venta_id ? String(row.venta_id) : null,
    nroFactura: row.nro_factura ? String(row.nro_factura) : null,
    clienteNombre: row.cliente_nombre ? String(row.cliente_nombre) : null,
    metodoNombre: String(row.metodo_nombre ?? ''),
    metodoCobro_id: String(row.metodo_cobro_id ?? ''),
    metodoTipo: String(row.metodo_tipo ?? ''),
    moneda: String(row.moneda ?? 'USD'),
    monto: String(row.monto ?? '0'),
    montoUsd: String(row.monto_usd ?? '0'),
    referencia: row.referencia ? String(row.referencia) : null,
    fecha: String(row.fecha ?? ''),
  }))

  return { pagos: items, isLoading }
}

// ─── Busqueda de Facturas ──────────────────────────────────

export interface FacturaBusqueda {
  id: string
  nroFactura: string
  clienteNombre: string
  clienteIdentificacion: string
  totalUsd: string
  totalBs: string
  tipo: string
  status: string
  fecha: string
}

export interface BusquedaParams {
  empresaId: string
  fechaInicio: string
  fechaFin: string
  busqFactura: string
  busqCliente: string
}

export function useFacturasBusqueda(params: BusquedaParams | null) {
  const clauses: string[] = []
  const sqlParams: unknown[] = []

  if (params) {
    clauses.push('v.empresa_id = ?')
    sqlParams.push(params.empresaId)

    clauses.push("DATE(v.fecha, 'localtime') >= ?")
    sqlParams.push(params.fechaInicio)

    clauses.push("DATE(v.fecha, 'localtime') <= ?")
    sqlParams.push(params.fechaFin)

    if (params.busqFactura.trim()) {
      clauses.push("v.nro_factura LIKE ?")
      sqlParams.push(`%${params.busqFactura.trim()}%`)
    }

    if (params.busqCliente.trim()) {
      clauses.push("(c.nombre LIKE ? OR c.identificacion LIKE ?)")
      sqlParams.push(`%${params.busqCliente.trim()}%`, `%${params.busqCliente.trim()}%`)
    }
  }

  const where = clauses.length > 0 ? clauses.join(' AND ') : '1=0'

  const { data, isLoading } = useQuery(
    params
      ? `SELECT
           v.id, v.nro_factura, v.total_usd, v.total_bs, v.tipo, v.status, v.fecha,
           c.nombre as cliente_nombre,
           c.identificacion as cliente_identificacion
         FROM ventas v
         JOIN clientes c ON v.cliente_id = c.id
         WHERE ${where}
         ORDER BY v.fecha DESC
         LIMIT 200`
      : '',
    params ? sqlParams : []
  )

  const items: FacturaBusqueda[] = (data ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id ?? ''),
    nroFactura: String(row.nro_factura ?? ''),
    clienteNombre: String(row.cliente_nombre ?? ''),
    clienteIdentificacion: String(row.cliente_identificacion ?? ''),
    totalUsd: String(row.total_usd ?? '0'),
    totalBs: String(row.total_bs ?? '0'),
    tipo: String(row.tipo ?? ''),
    status: String(row.status ?? ''),
    fecha: String(row.fecha ?? ''),
  }))

  return { facturas: items, isLoading }
}

// ─── Cobros efectivo individuales (para saldo de caja) ─────

export interface CobrosEfectivoDetalle {
  id: string
  nro_factura: string
  cliente_nombre: string
  monto: string
  moneda: string
  metodo_nombre: string
  fecha: string
}

export function useCobrosEfectivoCaja(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhere(filters, empresaId, 'pg') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data, isLoading } = useQuery(
    filters
      ? `SELECT
           pg.id, pg.monto, pg.fecha,
           v.nro_factura,
           c.nombre as cliente_nombre,
           mp.nombre as metodo_nombre,
           CASE WHEN mon.codigo_iso = 'VES' THEN 'BS'
                ELSE COALESCE(mon.codigo_iso, 'USD') END as moneda
         FROM pagos pg
         JOIN ventas v ON pg.venta_id = v.id
         JOIN clientes c ON v.cliente_id = c.id
         JOIN metodos_cobro mp ON pg.metodo_cobro_id = mp.id
         LEFT JOIN monedas mon ON mp.moneda_id = mon.id
         WHERE ${where}
           AND mp.tipo = 'EFECTIVO'
           AND pg.is_reversed = 0
         ORDER BY pg.fecha DESC`
      : '',
    filters ? params : []
  )

  const items: CobrosEfectivoDetalle[] = (data ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id ?? ''),
    nro_factura: String(row.nro_factura ?? ''),
    cliente_nombre: String(row.cliente_nombre ?? ''),
    monto: String(row.monto ?? '0'),
    moneda: String(row.moneda ?? 'USD'),
    metodo_nombre: String(row.metodo_nombre ?? ''),
    fecha: String(row.fecha ?? ''),
  }))

  return { cobros: items, isLoading }
}

// ─── Movimientos efectivo individuales (para saldo de caja) ─

export interface MovimientoEfectivoDetalle {
  id: string
  origen: string
  tipo: string
  monto: string
  metodo_nombre: string
  metodo_moneda: string
  concepto: string | null
  fecha: string
  destinatario: string | null
}

export function useMovimientosEfectivoCaja(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const hasSession = !!filters && filters.sesionCajaIds.length > 0
  const placeholders = hasSession ? filters!.sesionCajaIds.map(() => '?').join(', ') : ''

  const { data, isLoading } = useQuery(
    hasSession
      ? `SELECT
           mmc.id, mmc.origen, mmc.tipo, mmc.monto, mmc.concepto, mmc.fecha,
           mc.nombre as metodo_nombre,
           CASE WHEN mon.codigo_iso = 'VES' THEN 'BS'
                ELSE COALESCE(mon.codigo_iso, 'USD') END as metodo_moneda,
           ud.nombre as destinatario
         FROM movimientos_metodo_cobro mmc
         JOIN metodos_cobro mc ON mmc.metodo_cobro_id = mc.id
         LEFT JOIN monedas mon ON mc.moneda_id = mon.id
         LEFT JOIN usuarios ud ON mmc.destinatario_id = ud.id
         WHERE mmc.empresa_id = ?
           AND mmc.sesion_caja_id IN (${placeholders})
           AND mc.tipo = 'EFECTIVO'
         ORDER BY mmc.fecha DESC`
      : '',
    hasSession ? [empresaId, ...filters!.sesionCajaIds] : []
  )

  const items: MovimientoEfectivoDetalle[] = (data ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id ?? ''),
    origen: String(row.origen ?? ''),
    tipo: String(row.tipo ?? ''),
    monto: String(row.monto ?? '0'),
    metodo_nombre: String(row.metodo_nombre ?? ''),
    metodo_moneda: String(row.metodo_moneda ?? 'USD'),
    concepto: row.concepto ? String(row.concepto) : null,
    fecha: String(row.fecha ?? ''),
    destinatario: row.destinatario ? String(row.destinatario) : null,
  }))

  return { movimientos: items, isLoading }
}

// ─── SAF Diario (saldo a favor como metodo de pago en POS) ────

export interface OtroPago {
  metodoNombre: string
  montoUsd: number
}

export interface SafFacturaItem {
  movimientoCuentaId: string
  ventaId: string
  nroFactura: string
  clienteNombre: string
  montoSafUsd: number
  totalFacturaUsd: number
  esPagoTotal: boolean  // montoSafUsd >= totalFacturaUsd - 0.01
  tasa: number
  otrosPagos: OtroPago[]
}

export interface SafDiarioResult {
  totalUsd: number
  items: SafFacturaItem[]
  isLoading: boolean
}

/**
 * Retorna el total de saldo a favor aplicado como pago directo en el POS
 * durante la sesion de caja indicada por `filters`.
 * Excluye registros historicos con sesion_caja_id IS NULL.
 * Solo aplica cuando hay sesionCajaIds definidos en filters.
 */
export function useSafDiario(filters: CuadreFilters | null): SafDiarioResult {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''

  // buildMovsWhere usa sesion_caja_id (tabla mc alias) — reutilizamos con alias 'mc'
  const [whereMc, paramsMc] = useMemo(
    () => filters ? buildMovsWhere(filters, empresaId, 'mc') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data: dataAggregate, isLoading: loadingAgg } = useQuery(
    filters
      ? `SELECT COALESCE(SUM(CAST(mc.monto AS REAL)), 0) as total_saf
         FROM movimientos_cuenta mc
         WHERE mc.tipo = 'SAF'
           AND mc.sesion_caja_id IS NOT NULL
           AND ${whereMc}`
      : '',
    filters ? paramsMc : []
  )

  const { data: dataItems, isLoading: loadingItems } = useQuery(
    filters
      ? `SELECT
           mc.id as movimiento_cuenta_id,
           mc.venta_id,
           mc.monto,
           mc.tasa_pago,
           v.nro_factura,
           v.total_usd,
           c.nombre as cliente_nombre,
           GROUP_CONCAT(mp.nombre || ':' || pg.monto_usd, '|') as otros_pagos_raw
         FROM movimientos_cuenta mc
         JOIN ventas v ON mc.venta_id = v.id
         JOIN clientes c ON v.cliente_id = c.id
         LEFT JOIN pagos pg ON pg.venta_id = mc.venta_id
           AND pg.empresa_id = mc.empresa_id
           AND pg.is_reversed = 0
         LEFT JOIN metodos_cobro mp ON pg.metodo_cobro_id = mp.id
         WHERE mc.tipo = 'SAF'
           AND mc.sesion_caja_id IS NOT NULL
           AND ${whereMc}
         GROUP BY mc.id, mc.venta_id, mc.monto, mc.tasa_pago,
                  v.nro_factura, v.total_usd, c.nombre
         ORDER BY mc.fecha DESC`
      : '',
    filters ? paramsMc : []
  )

  const totalUsd = Number(
    Number((dataAggregate?.[0] as { total_saf: number } | undefined)?.total_saf ?? 0).toFixed(2)
  )

  const items: SafFacturaItem[] = (dataItems ?? []).map((row: Record<string, unknown>) => {
    const montoSafUsd = Number(Number(row.monto ?? 0).toFixed(2))
    const totalFacturaUsd = Number(Number(row.total_usd ?? 0).toFixed(2))
    const rawStr = String(row.otros_pagos_raw ?? '')
    const otrosPagos: OtroPago[] = rawStr
      ? rawStr.split('|').map((part) => {
          const colonIdx = part.lastIndexOf(':')
          if (colonIdx < 0) return null
          return {
            metodoNombre: part.slice(0, colonIdx),
            montoUsd: Number(part.slice(colonIdx + 1)) || 0,
          }
        }).filter((p): p is OtroPago => p !== null)
      : []
    return {
      movimientoCuentaId: String(row.movimiento_cuenta_id ?? ''),
      ventaId: String(row.venta_id ?? ''),
      nroFactura: String(row.nro_factura ?? ''),
      clienteNombre: String(row.cliente_nombre ?? ''),
      montoSafUsd,
      totalFacturaUsd,
      esPagoTotal: montoSafUsd >= totalFacturaUsd - 0.01,
      tasa: Number(Number(row.tasa_pago ?? 0).toFixed(4)),
      otrosPagos,
    }
  })

  return { totalUsd, items, isLoading: loadingAgg || loadingItems }
}

// ─── Cobros CxC vía POS (SAF-APL) ──────────────────────────

export interface CobroViaPOS {
  metodo_cobro_id: string
  nombre: string
  moneda: string
  tipo: string        // mc.tipo: 'EFECTIVO' | 'TRANSFERENCIA' | 'PUNTO' | etc.
  cobrosUsd: number
  cobrosNativo: number
  cobsBsEquiv: number
}

/**
 * Retorna totales de cobros de CxC realizados desde el POS vía SAF (saldo a favor).
 * Estos se registran en movimientos_metodo_cobro con origen='COBRO'.
 * El monto se guarda en moneda nativa del método (BS o USD).
 */
export function useCobrosViaPOS(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  // Usa buildCuadreWhere (filtra por p.sesion_caja_id / p.fecha) en lugar de
  // buildMovsWhere (mmc) para evitar acumulación de registros históricos en mmc.
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhere(filters, empresaId, 'p') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data, isLoading } = useQuery(
    filters
      ? `SELECT
           p.metodo_cobro_id,
           mc.nombre,
           mc.tipo,
           CASE WHEN mon.codigo_iso = 'VES' THEN 'BS' ELSE COALESCE(mon.codigo_iso, 'USD') END as moneda,
           COALESCE(SUM(CASE WHEN COALESCE(mon.codigo_iso,'USD') = 'VES'
             THEN CAST(p.monto AS REAL) ELSE 0 END), 0) AS cobros_bs,
           COALESCE(SUM(CAST(p.monto_usd AS REAL)), 0) AS cobros_usd,
           COALESCE(SUM(CASE
             WHEN COALESCE(mon.codigo_iso,'USD') = 'VES'
               THEN CAST(p.monto AS REAL)
               ELSE CAST(p.monto_usd AS REAL) * CAST(COALESCE(p.tasa, '0') AS REAL)
           END), 0) AS cobros_bs_equiv
         FROM pagos p
         JOIN ventas v ON p.venta_id = v.id
         JOIN metodos_cobro mc ON p.metodo_cobro_id = mc.id
         LEFT JOIN monedas mon ON mc.moneda_id = mon.id
         WHERE v.tipo = 'CREDITO'
           AND (p.is_reversed IS NULL OR p.is_reversed = 0)
           -- Excluir el pago inicial de una factura mixta (mismo created_at que la venta).
           -- Ver nota en useCobranzasCxCCaja.
           AND p.created_at != v.created_at
           AND ${where}
         GROUP BY p.metodo_cobro_id, mc.nombre, mc.tipo, moneda
         ORDER BY cobros_bs DESC, cobros_usd DESC`
      : '',
    filters ? params : []
  )

  const porMetodo: CobroViaPOS[] = (data ?? []).map((row: Record<string, unknown>) => {
    const moneda = String(row.moneda ?? 'USD')
    const cobrosNativo = moneda === 'BS'
      ? Number(Number(row.cobros_bs ?? 0).toFixed(2))
      : Number(Number(row.cobros_usd ?? 0).toFixed(2))
    return {
      metodo_cobro_id: String(row.metodo_cobro_id ?? ''),
      nombre: String(row.nombre ?? ''),
      moneda,
      tipo: String(row.tipo ?? ''),
      cobrosUsd: Number(Number(row.cobros_usd ?? 0).toFixed(2)),
      cobrosNativo,
      cobsBsEquiv: Number(Number(row.cobros_bs_equiv ?? 0).toFixed(2)),
    }
  })

  const totalCobrosUsd = porMetodo.reduce((s, m) => s + m.cobrosUsd, 0)
  const totalCobrosBs  = porMetodo
    .filter(m => m.moneda === 'BS')
    .reduce((s, m) => s + m.cobrosNativo, 0)
  const totalCobrosBsEquiv = porMetodo.reduce((s, m) => s + m.cobsBsEquiv, 0)

  return { porMetodo, totalCobrosUsd, totalCobrosBs, totalCobrosBsEquiv, isLoading }
}

// ─── Cobranzas CxC dirigidas a la sesión de caja ─────────────

export interface CobranzaCxCItem {
  id: string           // pagos.id
  nroFactura: string | null
  clienteNombre: string | null
  metodoNombre: string
  metodoMoneda: string
  monto: string        // pagos.monto = monto nativo por factura (Bs o USD)
  montoUsd: string     // pagos.monto_usd
  tasa: string         // pagos.tasa
  referencia: string | null
  fecha: string
  createdAt: string
}

/**
 * Retorna los pagos de facturas a crédito (CxC) que entraron en la sesión de caja.
 * Expande a una fila por factura (en abono global muestra cada factura afectada).
 */
export function useCobranzasCxCCaja(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhere(filters, empresaId, 'p') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )
  const { data, isLoading } = useQuery(
    filters
      ? `SELECT
           p.id,
           p.monto,
           p.monto_usd,
           COALESCE(p.tasa, '0') as tasa,
           p.referencia,
           p.fecha,
           p.created_at,
           mc.nombre as metodo_nombre,
           CASE WHEN mon.codigo_iso = 'VES' THEN 'BS' ELSE COALESCE(mon.codigo_iso, 'USD') END as metodo_moneda,
           v.nro_factura,
           c.nombre as cliente_nombre
         FROM pagos p
         JOIN ventas v ON p.venta_id = v.id
         JOIN clientes c ON v.cliente_id = c.id
         JOIN metodos_cobro mc ON p.metodo_cobro_id = mc.id
         LEFT JOIN monedas mon ON mc.moneda_id = mon.id
         WHERE v.tipo = 'CREDITO'
           AND (p.is_reversed IS NULL OR p.is_reversed = 0)
           -- Excluir el pago inicial de una factura mixta (contado + crédito):
           -- ese pago se inserta en la misma writeTransaction que la venta y comparte
           -- created_at. Un cobro CxC posterior corre en otra transacción con timestamp
           -- distinto, por lo que sí entra. Esto separa Case A (pago inicial) de Case B (cobro posterior).
           AND p.created_at != v.created_at
           AND ${where}
         ORDER BY p.fecha ASC`
      : '',
    filters ? params : []
  )

  const items: CobranzaCxCItem[] = (data ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id ?? ''),
    nroFactura: row.nro_factura ? String(row.nro_factura) : null,
    clienteNombre: row.cliente_nombre ? String(row.cliente_nombre) : null,
    metodoNombre: String(row.metodo_nombre ?? ''),
    metodoMoneda: String(row.metodo_moneda ?? 'USD'),
    monto: String(row.monto ?? '0'),
    montoUsd: String(row.monto_usd ?? '0'),
    tasa: String(row.tasa ?? '0'),
    referencia: row.referencia ? String(row.referencia) : null,
    fecha: String(row.fecha ?? ''),
    createdAt: String(row.created_at ?? ''),
  }))

  return { items, isLoading }
}

// ─── Ventas con cargos financieros (avances/préstamos) ────────

export interface VentaFinancieraItem {
  id: string
  nroFactura: string
  clienteNombre: string
  fecha: string
  cargoFinancieroUsd: number
  cargoFinancieroBs: number
}

/**
 * Retorna las ventas del periodo que contienen avances o préstamos,
 * con el monto financiero desglosado (total_usd − ventas_puras).
 */
export function useVentasFinancieras(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhere(filters, empresaId, 'v') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data, isLoading } = useQuery(
    `SELECT
       v.id,
       v.nro_factura,
       v.fecha,
       c.nombre as cliente_nombre,
       (
         CAST(v.total_usd AS REAL)
         - CAST(v.total_base_usd AS REAL)
         - CAST(v.total_exento_usd AS REAL)
         - CAST(v.total_iva_usd AS REAL)
         + CAST(COALESCE(v.descuento_usd, '0') AS REAL)
       ) as cargo_financiero_usd,
       (
         CAST(v.total_usd AS REAL)
         - CAST(v.total_base_usd AS REAL)
         - CAST(v.total_exento_usd AS REAL)
         - CAST(v.total_iva_usd AS REAL)
         + CAST(COALESCE(v.descuento_usd, '0') AS REAL)
       ) * CAST(v.tasa AS REAL) as cargo_financiero_bs
     FROM ventas v
     JOIN clientes c ON v.cliente_id = c.id
     WHERE ${where}
       AND (
         CAST(v.total_usd AS REAL)
         - CAST(v.total_base_usd AS REAL)
         - CAST(v.total_exento_usd AS REAL)
         - CAST(v.total_iva_usd AS REAL)
         + CAST(COALESCE(v.descuento_usd, '0') AS REAL)
       ) > 0.001
     ORDER BY v.fecha DESC`,
    params
  )

  const items: VentaFinancieraItem[] = (data ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id ?? ''),
    nroFactura: String(row.nro_factura ?? ''),
    clienteNombre: String(row.cliente_nombre ?? ''),
    fecha: String(row.fecha ?? ''),
    cargoFinancieroUsd: Number(Number(row.cargo_financiero_usd ?? 0).toFixed(2)),
    cargoFinancieroBs: Number(Number(row.cargo_financiero_bs ?? 0).toFixed(2)),
  }))

  return { items, isLoading }
}

// ─── Resumen por tipo de venta (preserva naturaleza original) ──
/**
 * Calcula el total facturado separado en la porción CONTADO (pagada al emitir)
 * y la porción CRÉDITO (que quedó pendiente en CxC) de cada factura.
 *
 * Estas porciones son INVARIABLES una vez emitido el documento y no cambian
 * cuando la porción a crédito se cobra después. Para obtenerlas se usa la fila
 * inmutable movimientos_cuenta (tipo='FAC'), que guarda exactamente el saldo
 * que quedó a crédito al emitir la factura:
 *   - creditoPortion = monto de la fila FAC de esa venta
 *   - contadoPortion = total de la venta − creditoPortion
 *
 * FACTURAS MIXTAS (ej: total 525, contado 500, crédito 25): la venta se guarda
 * con tipo='CREDITO' porque quedó saldo, pero solo los 25 son crédito. La fila
 * FAC guarda 25 → contado = 525 − 25 = 500. Correcto.
 * CONTADO PURO: no hay fila FAC → credito=0, contado=total.
 * CRÉDITO PURO: FAC=total → credito=total, contado=0.
 *
 * El IGTF siempre se cobra al momento, por lo que se suma a la porción contado.
 */
export function useResumenTiposVenta(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const [where, params] = useMemo(
    () => filters ? buildCuadreWhere(filters, empresaId, 'v') : ['1=0', [] as unknown[]],
    [filters, empresaId]
  )

  const { data, isLoading } = useQuery(
    `SELECT
       COALESCE(SUM(
         (CAST(v.total_usd AS REAL) + CAST(COALESCE(v.total_igtf_usd, '0') AS REAL))
         - COALESCE(fac.credito_usd, 0)
       ), 0) as contado_usd,
       COALESCE(SUM(
         (CAST(v.total_bs AS REAL)
           + CAST(COALESCE(v.total_igtf_usd, '0') AS REAL) * CAST(COALESCE(v.tasa, '0') AS REAL))
         - COALESCE(fac.credito_usd, 0) * CAST(COALESCE(v.tasa, '0') AS REAL)
       ), 0) as contado_bs,
       COALESCE(SUM(COALESCE(fac.credito_usd, 0)), 0) as credito_usd,
       COALESCE(SUM(COALESCE(fac.credito_usd, 0) * CAST(COALESCE(v.tasa, '0') AS REAL)), 0) as credito_bs
     FROM ventas v
     LEFT JOIN (
       SELECT venta_id, SUM(CAST(monto AS REAL)) as credito_usd
       FROM movimientos_cuenta
       WHERE tipo = 'FAC'
       GROUP BY venta_id
     ) fac ON fac.venta_id = v.id
     WHERE ${where}`,
    params
  )

  const row = (data?.[0] ?? {}) as {
    contado_usd: number; contado_bs: number
    credito_usd: number; credito_bs: number
  }
  return {
    contadoUsd: Number(Number(row.contado_usd ?? 0).toFixed(2)),
    contadoBs:  Number(Number(row.contado_bs  ?? 0).toFixed(2)),
    creditoUsd: Number(Number(row.credito_usd ?? 0).toFixed(2)),
    creditoBs:  Number(Number(row.credito_bs  ?? 0).toFixed(2)),
    isLoading,
  }
}

// ─── Cobros por adelantado (SAF directo desde POS) ────────────
/**
 * Suma los anticipos / saldos a favor registrados en la sesión.
 * Se identifican como pagos con venta_id IS NULL y cliente_id IS NOT NULL:
 * el cliente pagó más de lo que debe y el excedente queda a su favor.
 * El monto está en la moneda nativa del método de pago.
 */
export function useAnticiposDelDia(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const hasSession = !!filters && filters.sesionCajaIds.length > 0
  const placeholders = hasSession ? filters!.sesionCajaIds.map(() => '?').join(', ') : ''

  const { data, isLoading } = useQuery(
    hasSession
      ? `SELECT
           COALESCE(SUM(CAST(p.monto_usd AS REAL)), 0) as total_usd,
           COALESCE(SUM(CASE WHEN COALESCE(mo.codigo_iso,'USD') = 'VES'
             THEN CAST(p.monto AS REAL) ELSE 0 END), 0) as total_bs_nativo
         FROM pagos p
         JOIN metodos_cobro mc ON p.metodo_cobro_id = mc.id
         LEFT JOIN monedas mo ON mc.moneda_id = mo.id
         WHERE p.empresa_id = ?
           AND p.sesion_caja_id IN (${placeholders})
           AND p.venta_id IS NULL
           AND p.cliente_id IS NOT NULL
           AND (p.is_reversed IS NULL OR p.is_reversed = 0)`
      : '',
    hasSession ? [empresaId, ...filters!.sesionCajaIds] : []
  )

  const row = (data?.[0] ?? {}) as { total_usd: number; total_bs_nativo: number }
  return {
    anticipoUsd:    Number(Number(row.total_usd       ?? 0).toFixed(2)),
    anticipoBsNativo: Number(Number(row.total_bs_nativo ?? 0).toFixed(2)),
    isLoading,
  }
}

// ─── Propinas del día ─────────────────────────────────────────
/**
 * Suma todas las propinas registradas en la sesión.
 * Las propinas se guardan en movimientos_metodo_cobro con origen='PROPINA'.
 * El monto es el excedente nativo que el cliente dejó voluntariamente.
 */
export function usePropinasDelDia(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const hasSession = !!filters && filters.sesionCajaIds.length > 0
  const placeholders = hasSession ? filters!.sesionCajaIds.map(() => '?').join(', ') : ''

  const { data, isLoading } = useQuery(
    hasSession
      ? `SELECT
           COALESCE(SUM(CASE WHEN mo.codigo_iso = 'VES'
             THEN CAST(mmc.monto AS REAL) ELSE 0 END), 0) as total_bs,
           COALESCE(SUM(CASE WHEN mo.codigo_iso != 'VES'
             THEN CAST(mmc.monto AS REAL) ELSE 0 END), 0) as total_usd
         FROM movimientos_metodo_cobro mmc
         JOIN metodos_cobro mc ON mmc.metodo_cobro_id = mc.id
         LEFT JOIN monedas mo ON mc.moneda_id = mo.id
         WHERE mmc.empresa_id = ?
           AND mmc.sesion_caja_id IN (${placeholders})
           AND mmc.origen = 'PROPINA'`
      : '',
    hasSession ? [empresaId, ...filters!.sesionCajaIds] : []
  )

  const row = (data?.[0] ?? {}) as { total_bs: number; total_usd: number }
  return {
    propinaBs:  Number(Number(row.total_bs  ?? 0).toFixed(2)),
    propinaUsd: Number(Number(row.total_usd ?? 0).toFixed(2)),
    isLoading,
  }
}

// ─── Absorción de faltante autorizado (Negocio asume) ────────
/**
 * Retorna los faltantes de caja que el negocio absorbió (autorizados por supervisor/dueño).
 * Se identifican en `gastos` con descripcion = 'ABSORCION_DIFERENCIAL_POS'.
 * Se une con `ventas` para poder filtrar por sesion_caja_id.
 */

export interface AbsorcionItem {
  id: string
  nroFactura: string
  montoBs: number
  montoUsd: number
  observaciones: string | null
  fecha: string
}

export function useAbsorcionDelDia(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''

  const hasSession = !!filters && filters.sesionCajaIds.length > 0
  const hasCaja    = !!filters && !!filters.cajaId

  const [query, params] = useMemo(() => {
    if (!filters) return ['', [] as unknown[]]

    const base = `
      SELECT g.id, COALESCE(g.nro_factura, '') as nro_factura,
             CAST(g.monto_usd AS REAL) as monto_usd,
             CAST(g.monto_usd AS REAL) * CAST(COALESCE(g.tasa, '0') AS REAL) as monto_bs,
             g.observaciones, g.fecha
      FROM gastos g
      JOIN ventas v ON v.empresa_id = g.empresa_id AND v.nro_factura = g.nro_factura
      WHERE g.empresa_id = ?
        AND g.descripcion = 'ABSORCION_DIFERENCIAL_POS'`

    if (hasSession) {
      const ph = filters.sesionCajaIds.map(() => '?').join(', ')
      return [
        `${base} AND v.sesion_caja_id IN (${ph}) ORDER BY g.fecha DESC`,
        [empresaId, ...filters.sesionCajaIds] as unknown[],
      ]
    } else if (hasCaja) {
      return [
        `${base} AND v.sesion_caja_id IN (SELECT id FROM sesiones_caja WHERE caja_id = ? AND empresa_id = ?) ORDER BY g.fecha DESC`,
        [empresaId, filters.cajaId!, empresaId] as unknown[],
      ]
    } else {
      return [
        `${base} AND DATE(g.fecha, 'localtime') = ? ORDER BY g.fecha DESC`,
        [empresaId, filters.fecha] as unknown[],
      ]
    }
  }, [filters, empresaId, hasSession, hasCaja])

  const { data, isLoading } = useQuery(query, params)

  const items: AbsorcionItem[] = (data ?? []).map((row: Record<string, unknown>) => ({
    id:           String(row.id ?? ''),
    nroFactura:   String(row.nro_factura ?? ''),
    montoBs:      Number(Number(row.monto_bs  ?? 0).toFixed(2)),
    montoUsd:     Number(Number(row.monto_usd ?? 0).toFixed(2)),
    observaciones: row.observaciones ? String(row.observaciones) : null,
    fecha:        String(row.fecha ?? ''),
  }))

  const totalBs  = Number(items.reduce((s, i) => s + i.montoBs,  0).toFixed(2))
  const totalUsd = Number(items.reduce((s, i) => s + i.montoUsd, 0).toFixed(2))

  return { items, totalBs, totalUsd, hayAbsorcion: items.length > 0, isLoading }
}

// ─── Diferencial cambiario del día ────────────────────────────
/**
 * Retorna el total acumulado de diferenciales cambiarios (faltantes autorizados)
 * registrados durante la sesión.
 *
 * - FALTANTE: cliente paga menos que el total → guardado en `gastos` con
 *   descripcion='DIFERENCIAL_CAMBIARIO_FALTANTE'. Se une con `ventas` para
 *   poder filtrar por sesion_caja_id.
 * - SOBRANTE: cliente paga más → guardado en `movimientos_metodo_cobro` con
 *   origen='DIFERENCIAL_CAMBIARIO' y tipo='INGRESO'.
 *
 * El resultado neto = faltante − sobrante (positivo = caja debería tener menos).
 */

export interface DiferencialCambioItem {
  id: string
  nroFactura: string
  montoBs: number
  montoUsd: number
  tipo: 'FALTANTE' | 'SOBRANTE'
  fecha: string
}

export function useDiferencialCambiarioDelDia(filters: CuadreFilters | null) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''

  const hasSession = !!filters && filters.sesionCajaIds.length > 0
  const hasCaja    = !!filters && !!filters.cajaId

  // ── FALTANTE: gastos JOIN ventas ────────────────────────────
  const [faltanteQuery, faltanteParams] = useMemo(() => {
    if (!filters) return ['', [] as unknown[]]
    if (hasSession) {
      const ph = filters.sesionCajaIds.map(() => '?').join(', ')
      return [
        `SELECT g.id, COALESCE(g.nro_factura, '') as nro_factura,
                CAST(g.monto_usd AS REAL) as monto_usd,
                CAST(g.monto_usd AS REAL) * CAST(COALESCE(g.tasa, '0') AS REAL) as monto_bs,
                g.fecha, 'FALTANTE' as tipo
         FROM gastos g
         JOIN ventas v ON v.empresa_id = g.empresa_id AND v.nro_factura = g.nro_factura
         WHERE g.empresa_id = ?
           AND g.descripcion = 'DIFERENCIAL_CAMBIARIO_FALTANTE'
           AND v.sesion_caja_id IN (${ph})
         ORDER BY g.fecha DESC`,
        [empresaId, ...filters.sesionCajaIds] as unknown[],
      ]
    } else if (hasCaja) {
      return [
        `SELECT g.id, COALESCE(g.nro_factura, '') as nro_factura,
                CAST(g.monto_usd AS REAL) as monto_usd,
                CAST(g.monto_usd AS REAL) * CAST(COALESCE(g.tasa, '0') AS REAL) as monto_bs,
                g.fecha, 'FALTANTE' as tipo
         FROM gastos g
         JOIN ventas v ON v.empresa_id = g.empresa_id AND v.nro_factura = g.nro_factura
         WHERE g.empresa_id = ?
           AND g.descripcion = 'DIFERENCIAL_CAMBIARIO_FALTANTE'
           AND v.sesion_caja_id IN (SELECT id FROM sesiones_caja WHERE caja_id = ? AND empresa_id = ?)
         ORDER BY g.fecha DESC`,
        [empresaId, filters.cajaId!, empresaId] as unknown[],
      ]
    } else {
      return [
        `SELECT g.id, COALESCE(g.nro_factura, '') as nro_factura,
                CAST(g.monto_usd AS REAL) as monto_usd,
                CAST(g.monto_usd AS REAL) * CAST(COALESCE(g.tasa, '0') AS REAL) as monto_bs,
                g.fecha, 'FALTANTE' as tipo
         FROM gastos g
         WHERE g.empresa_id = ?
           AND g.descripcion = 'DIFERENCIAL_CAMBIARIO_FALTANTE'
           AND DATE(g.fecha, 'localtime') = ?
         ORDER BY g.fecha DESC`,
        [empresaId, filters.fecha] as unknown[],
      ]
    }
  }, [filters, empresaId, hasSession, hasCaja])

  const { data: dataFaltante, isLoading: loadingFaltante } = useQuery(
    faltanteQuery, faltanteParams
  )

  // ── SOBRANTE: movimientos_metodo_cobro ───────────────────────
  const [sobraQuery, sobraParams] = useMemo(() => {
    if (!filters) return ['', [] as unknown[]]
    if (hasSession) {
      const ph = filters.sesionCajaIds.map(() => '?').join(', ')
      return [
        `SELECT mmc.id, COALESCE(mmc.doc_origen_ref, '') as nro_factura,
                CAST(mmc.monto AS REAL) as monto_bs,
                0 as monto_usd,
                mmc.fecha, 'SOBRANTE' as tipo
         FROM movimientos_metodo_cobro mmc
         WHERE mmc.empresa_id = ?
           AND mmc.origen = 'DIFERENCIAL_CAMBIARIO'
           AND mmc.tipo = 'INGRESO'
           AND mmc.sesion_caja_id IN (${ph})
         ORDER BY mmc.fecha DESC`,
        [empresaId, ...filters.sesionCajaIds] as unknown[],
      ]
    } else if (hasCaja) {
      return [
        `SELECT mmc.id, COALESCE(mmc.doc_origen_ref, '') as nro_factura,
                CAST(mmc.monto AS REAL) as monto_bs,
                0 as monto_usd,
                mmc.fecha, 'SOBRANTE' as tipo
         FROM movimientos_metodo_cobro mmc
         WHERE mmc.empresa_id = ?
           AND mmc.origen = 'DIFERENCIAL_CAMBIARIO'
           AND mmc.tipo = 'INGRESO'
           AND mmc.sesion_caja_id IN (SELECT id FROM sesiones_caja WHERE caja_id = ? AND empresa_id = ?)
         ORDER BY mmc.fecha DESC`,
        [empresaId, filters.cajaId!, empresaId] as unknown[],
      ]
    } else {
      return [
        `SELECT mmc.id, COALESCE(mmc.doc_origen_ref, '') as nro_factura,
                CAST(mmc.monto AS REAL) as monto_bs,
                0 as monto_usd,
                mmc.fecha, 'SOBRANTE' as tipo
         FROM movimientos_metodo_cobro mmc
         WHERE mmc.empresa_id = ?
           AND mmc.origen = 'DIFERENCIAL_CAMBIARIO'
           AND mmc.tipo = 'INGRESO'
           AND DATE(mmc.fecha, 'localtime') = ?
         ORDER BY mmc.fecha DESC`,
        [empresaId, filters.fecha] as unknown[],
      ]
    }
  }, [filters, empresaId, hasSession, hasCaja])

  const { data: dataSobrante, isLoading: loadingSobrante } = useQuery(
    sobraQuery, sobraParams
  )

  const toItem = (row: Record<string, unknown>): DiferencialCambioItem => ({
    id:          String(row.id ?? ''),
    nroFactura:  String(row.nro_factura ?? ''),
    montoBs:     Number(Number(row.monto_bs  ?? 0).toFixed(2)),
    montoUsd:    Number(Number(row.monto_usd ?? 0).toFixed(2)),
    tipo:        String(row.tipo ?? 'FALTANTE') as 'FALTANTE' | 'SOBRANTE',
    fecha:       String(row.fecha ?? ''),
  })

  const faltantes: DiferencialCambioItem[] = (dataFaltante ?? []).map(toItem)
  const sobrantes: DiferencialCambioItem[] = (dataSobrante ?? []).map(toItem)
  const items = [...faltantes, ...sobrantes].sort((a, b) => a.fecha.localeCompare(b.fecha))

  const totalFaltanteBs  = faltantes.reduce((s, i) => s + i.montoBs,  0)
  const totalFaltanteUsd = faltantes.reduce((s, i) => s + i.montoUsd, 0)
  const totalSobranteBs  = sobrantes.reduce((s, i) => s + i.montoBs,  0)

  // Neto desde la perspectiva de caja:
  // positivo = caja debería recibir este monto pero no lo recibió (FALTANTE > SOBRANTE)
  const netoBs  = Number((totalFaltanteBs  - totalSobranteBs).toFixed(2))
  const netoUsd = Number(totalFaltanteUsd.toFixed(2))

  return {
    items,
    totalFaltanteBs,
    totalFaltanteUsd,
    totalSobranteBs,
    netoBs,
    netoUsd,
    hayDiferencial: items.length > 0,
    isLoading: loadingFaltante || loadingSobrante,
  }
}
