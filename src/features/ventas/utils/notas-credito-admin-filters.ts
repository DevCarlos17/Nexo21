import { VE_OFFSET, startOfMonth, todayStr } from '@/lib/dates'

/**
 * Query-builders PUROS (sin I/O, sin `db`/`useQuery`) para la ruta
 * administrativa de "Facturas emitidas" (openspec/changes/notas-credito-ruta-administrativa,
 * Slice A — Design §Decision 3/4). Consumidos por `useFacturasEmpresa`
 * (Slice B, `use-facturas-empresa.ts`) y por `useNotasCredito(filtros?)`
 * (Slice B, `use-notas-credito.ts`).
 *
 * Ambos builders SIEMPRE incluyen `empresa_id` en el `WHERE` — aislamiento
 * multi-tenant no negociable (Spec: "Aislamiento multi-tenant en consultas
 * nuevas") — y SIEMPRE parametrizan cada valor via `params`, nunca
 * interpolacion de string en el SQL.
 *
 * El rango de fecha usa el mismo patron que `kardex-sql.ts`
 * (`datetime(col) >= datetime(? || 'T00:00:00' || VE_OFFSET)`): compara
 * contra la columna `fecha` (timestamp ISO con offset VE) via `datetime()`
 * de SQLite, en vez de comparacion de string directa, para que el bound
 * sea correcto sin importar el offset literal guardado en cada fila.
 */

export interface RangoFecha {
  fechaDesde: string
  fechaHasta: string
}

/**
 * Rango de fecha por defecto para la carga inicial de ambas pestañas
 * (Spec: "Carga por defecto limitada al mes en curso"). Compone
 * `startOfMonth()`/`todayStr()` de `@/lib/dates` — sin formula paralela.
 */
export function rangoMesActual(): RangoFecha {
  return { fechaDesde: startOfMonth(), fechaHasta: todayStr() }
}

export interface SqlFiltroResult {
  sql: string
  params: unknown[]
}

/**
 * Estado unico de una factura (Slice E.b, notas-credito-ruta-administrativa
 * — correccion de tester QA sobre Slice E.3: el `<select>` de Estado
 * separado se RETIRA por completo, el estado se detecta como PALABRA CLAVE
 * dentro del termino unico de `busqueda`, ver `detectarEstadoFacturaEnBusqueda`
 * abajo). `CONTADO`/`CREDITO`/`ABONADA` derivan del mismo epsilon 0.005 que
 * `derivarEstadoPago` (`notas-credito-ui.ts`) sobre `saldo_pend_usd`/
 * `total_usd` — `ABONADA` es NUEVO en este slice (Slice E.3 lo excluia
 * explicitamente del selector viejo; el tester pidio incluirlo en el
 * universo de busqueda). `REVERSO_PARCIAL`/`REVERSO_TOTAL` derivan de la
 * existencia de una NC con ese `tipo` para la venta (mismo criterio que las
 * columnas `tiene_reverso_total`/`tiene_reverso_parcial` ya seleccionadas).
 */
export type EstadoFiltroFactura = 'CONTADO' | 'CREDITO' | 'ABONADA' | 'REVERSO_PARCIAL' | 'REVERSO_TOTAL'

/** Normaliza para comparacion de palabra clave: minusculas, sin espacios sobrantes, sin acentos. */
function normalizarPalabraClaveEstado(texto: string): string {
  return texto
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

const ESTADO_FACTURA_POR_PALABRA_CLAVE: Record<string, EstadoFiltroFactura> = {
  contado: 'CONTADO',
  credito: 'CREDITO',
  abonada: 'ABONADA',
  'reverso parcial': 'REVERSO_PARCIAL',
  'reverso total': 'REVERSO_TOTAL',
}

/**
 * Detecta si el termino de busqueda (ya normalizado, case/acento-insensitive)
 * ES exactamente una palabra clave de estado conocida — nunca un substring
 * (una busqueda de "reverso" sola NO dispara ninguna clausula: sigue
 * matcheando solo por nro/cliente/RIF, preservando el hallazgo de un
 * cliente literalmente llamado "Reverso"). Retorna `null` cuando el texto
 * no es una palabra clave reconocida.
 */
function detectarEstadoFacturaEnBusqueda(busqueda: string): EstadoFiltroFactura | null {
  return ESTADO_FACTURA_POR_PALABRA_CLAVE[normalizarPalabraClaveEstado(busqueda)] ?? null
}

/**
 * Fragmento SQL (sin el prefijo `AND`) de la clausula de estado, para
 * insertar como una rama ADICIONAL dentro del OR de busqueda — nunca
 * reemplaza el match por nro/cliente/RIF (wide OR, Slice E.b acceptance
 * criteria: "nunca pierde resultados"). Mismo epsilon 0.005 que
 * `derivarEstadoPago` para CONTADO/CREDITO/ABONADA; mismo patron `EXISTS`
 * ya usado en Slice E.3 para REVERSO_PARCIAL/REVERSO_TOTAL (alias `nce`
 * para no colisionar con el alias `nc` ya usado en el SELECT-list de
 * `tiene_reverso_total`/`tiene_reverso_parcial`).
 */
function clausulaEstadoFactura(estado: EstadoFiltroFactura): string {
  switch (estado) {
    case 'CONTADO':
      return 'CAST(v.saldo_pend_usd AS REAL) <= 0.005'
    case 'CREDITO':
      return 'CAST(v.saldo_pend_usd AS REAL) >= (CAST(v.total_usd AS REAL) - 0.005)'
    case 'ABONADA':
      return '(CAST(v.saldo_pend_usd AS REAL) > 0.005 AND CAST(v.saldo_pend_usd AS REAL) < (CAST(v.total_usd AS REAL) - 0.005))'
    case 'REVERSO_PARCIAL':
      return "EXISTS(SELECT 1 FROM notas_credito nce WHERE nce.venta_id = v.id AND nce.tipo = 'PARCIAL')"
    case 'REVERSO_TOTAL':
      return "EXISTS(SELECT 1 FROM notas_credito nce WHERE nce.venta_id = v.id AND nce.tipo = 'TOTAL')"
  }
}

export interface FiltroFacturasEmpresa {
  empresaId: string
  /** 'YYYY-MM-DD'. El llamador aplica el default (`rangoMesActual()`) — este builder no asume ninguno. */
  fechaDesde: string
  /** 'YYYY-MM-DD'. Ver `fechaDesde`. */
  fechaHasta: string
  /**
   * Termino unico de busqueda (Slice E.2 — patron POS "un solo input").
   * Coincide OR contra `nro_factura`, `cliente_nombre`,
   * `cliente_identificacion` (RIF) — reemplaza los 3 campos separados de
   * Slice A (`nroFactura`/`clienteNombre`/`clienteIdentificacion`,
   * retirados: la UI ya no los expone por separado).
   *
   * Slice E.b (correccion de tester QA sobre E.3): cuando el texto
   * coincide EXACTAMENTE (case/acento-insensitive) con una palabra clave de
   * `EstadoFiltroFactura` ("contado", "credito", "abonada", "reverso
   * parcial", "reverso total"), se agrega ADEMAS la clausula de estado
   * correspondiente como una rama mas del OR — nunca en lugar del match por
   * nro/cliente/RIF. Ya NO existe un campo `estado` separado — el
   * `<select>` de Estado de E.3 se retiro por completo de esta pestaña.
   */
  busqueda?: string
}

/**
 * SQL + params para el listado empresa-wide de facturas (Spec: "Pestaña
 * Facturas — listado empresa-wide"). Mismo shape de fila que
 * `FacturaParaAnular` (`use-notas-credito.ts`) y mismo patron de
 * `tiene_reverso_total`/`tiene_reverso_parcial` via `EXISTS` que
 * `useFacturasSesionActiva` — pero SIN filtrar por `sesion_caja_id`
 * (Design §Decision 3: "NO reutiliza `useFacturasSesionActiva`").
 */
export function buildFacturasEmpresaFiltro(f: FiltroFacturasEmpresa): SqlFiltroResult {
  const params: unknown[] = [f.empresaId, f.fechaDesde, f.fechaHasta]

  let sql = `SELECT
       v.id, v.nro_factura, v.cliente_id, v.tasa, v.total_usd, v.total_bs,
       v.saldo_pend_usd, v.tipo, v.status, v.fecha, v.total_igtf_usd,
       c.nombre as cliente_nombre,
       c.identificacion as cliente_identificacion,
       EXISTS(SELECT 1 FROM notas_credito nc WHERE nc.venta_id = v.id AND nc.tipo = 'TOTAL')   as tiene_reverso_total,
       EXISTS(SELECT 1 FROM notas_credito nc WHERE nc.venta_id = v.id AND nc.tipo = 'PARCIAL') as tiene_reverso_parcial
     FROM ventas v
     JOIN clientes c ON v.cliente_id = c.id
     WHERE v.empresa_id = ?
       AND datetime(v.fecha) >= datetime(? || 'T00:00:00${VE_OFFSET}')
       AND datetime(v.fecha) <= datetime(? || 'T23:59:59${VE_OFFSET}')`

  const busqueda = f.busqueda?.trim()
  if (busqueda) {
    const like = `%${busqueda}%`
    const estadoDetectado = detectarEstadoFacturaEnBusqueda(busqueda)
    if (estadoDetectado) {
      sql += `\n       AND (v.nro_factura LIKE ? OR c.nombre LIKE ? OR c.identificacion LIKE ? OR ${clausulaEstadoFactura(estadoDetectado)})`
    } else {
      sql += `\n       AND (v.nro_factura LIKE ? OR c.nombre LIKE ? OR c.identificacion LIKE ?)`
    }
    params.push(like, like, like)
  }

  sql += `\n     ORDER BY v.fecha DESC`

  return { sql, params }
}

export interface FiltroNotasCredito {
  empresaId: string
  /** 'YYYY-MM-DD'. El llamador aplica el default (`rangoMesActual()`) — este builder no asume ninguno. */
  fechaDesde: string
  /** 'YYYY-MM-DD'. Ver `fechaDesde`. */
  fechaHasta: string
  /**
   * Termino unico de busqueda (Slice E.2 — patron POS "un solo input").
   * Coincide OR contra `nro_ncr`, `cliente_nombre`, `cliente_identificacion`
   * (RIF) — reemplaza los 3 campos separados de Slice A (`nroNcr`/
   * `clienteNombre`/`clienteIdentificacion`, retirados).
   *
   * Slice E.b (correccion de tester QA sobre E.3): el filtro de Estado
   * (`EstadoFiltroNotaCredito`, Reverso Total/Reverso Parcial) se RETIRO
   * por completo de esta pestaña — a diferencia de Facturas, NO se folded
   * en la busqueda. `nc.tipo` deja de ser filtrable desde esta pestaña.
   */
  busqueda?: string
}

/**
 * SQL + params para el listado de NC con filtros ampliados (Spec: "Pestaña
 * Notas de crédito — filtros ampliados"). Mismo JOIN/columnas base que el
 * `useNotasCredito()` sin filtros (comportamiento preservado byte-a-byte
 * para consumidores no migrados — Design §Decision 4).
 */
export function buildNotasCreditoFiltro(f: FiltroNotasCredito): SqlFiltroResult {
  const params: unknown[] = [f.empresaId, f.fechaDesde, f.fechaHasta]

  let sql = `SELECT
       nc.id, nc.nro_ncr, nc.venta_id, nc.cliente_id, nc.tipo, nc.motivo,
       nc.tasa_historica, nc.total_usd, nc.total_bs, nc.fecha,
       v.nro_factura,
       c.nombre as cliente_nombre
     FROM notas_credito nc
     JOIN ventas v ON nc.venta_id = v.id
     JOIN clientes c ON nc.cliente_id = c.id
     WHERE nc.empresa_id = ?
       AND datetime(nc.fecha) >= datetime(? || 'T00:00:00${VE_OFFSET}')
       AND datetime(nc.fecha) <= datetime(? || 'T23:59:59${VE_OFFSET}')`

  const busqueda = f.busqueda?.trim()
  if (busqueda) {
    sql += `\n       AND (nc.nro_ncr LIKE ? OR c.nombre LIKE ? OR c.identificacion LIKE ?)`
    const like = `%${busqueda}%`
    params.push(like, like, like)
  }

  sql += `\n     ORDER BY nc.fecha DESC`

  return { sql, params }
}
