import { vi } from 'vitest'
import {
  rangoMesActual,
  buildFacturasEmpresaFiltro,
  buildNotasCreditoFiltro,
} from '../notas-credito-admin-filters'

// ─── rangoMesActual (Slice A.1/A.2, Design §Decision 3/4) ────────

describe('rangoMesActual (compone startOfMonth()/todayStr() de @/lib/dates)', () => {
  it('retorna el 1ro del mes actual como fechaDesde y hoy como fechaHasta', () => {
    vi.setSystemTime(new Date('2026-05-21T12:00:00'))
    expect(rangoMesActual()).toEqual({ fechaDesde: '2026-05-01', fechaHasta: '2026-05-21' })
    vi.useRealTimers()
  })

  it('boundary: primer dia del mes -> fechaDesde y fechaHasta son el mismo dia', () => {
    vi.setSystemTime(new Date('2026-01-01T15:00:00-04:00'))
    expect(rangoMesActual()).toEqual({ fechaDesde: '2026-01-01', fechaHasta: '2026-01-01' })
    vi.useRealTimers()
  })
})

// ─── buildFacturasEmpresaFiltro (Slice A.3/A.4 + Slice E.2/E.3) ────────

describe('buildFacturasEmpresaFiltro (empresa_id + rango de fecha siempre presentes)', () => {
  const base = { empresaId: 'emp-1', fechaDesde: '2026-05-01', fechaHasta: '2026-05-21' }

  it('sin filtros opcionales: WHERE incluye empresa_id y rango de fecha, params = [empresaId, fechaDesde, fechaHasta]', () => {
    const { sql, params } = buildFacturasEmpresaFiltro(base)
    expect(sql).toContain('v.empresa_id = ?')
    expect(sql).toContain("T00:00:00-04:00")
    expect(sql).toContain("T23:59:59-04:00")
    expect(params).toEqual(['emp-1', '2026-05-01', '2026-05-21'])
  })

  it('incluye el shape de FacturaParaAnular: status, tiene_reverso_total/parcial via EXISTS, total_igtf_usd', () => {
    const { sql } = buildFacturasEmpresaFiltro(base)
    expect(sql).toContain('v.status')
    expect(sql).toContain('v.total_igtf_usd')
    expect(sql).toContain("tiene_reverso_total")
    expect(sql).toContain("tiene_reverso_parcial")
    expect(sql).toContain('EXISTS(SELECT 1 FROM notas_credito nc WHERE nc.venta_id = v.id')
  })

  it('NUNCA filtra por sesion_caja_id (a diferencia de useFacturasSesionActiva)', () => {
    const { sql } = buildFacturasEmpresaFiltro(base)
    expect(sql).not.toContain('sesion_caja_id')
  })

  // ─── Slice E.2 — busqueda unificada (patron POS: un solo input) ────────

  it('busqueda: agrega OR sobre nro_factura/cliente_nombre/cliente_identificacion, con el termino repetido 3 veces en params', () => {
    const { sql, params } = buildFacturasEmpresaFiltro({ ...base, busqueda: 'C01-0042' })
    expect(sql).toContain('AND (v.nro_factura LIKE ? OR c.nombre LIKE ? OR c.identificacion LIKE ?)')
    expect(params).toEqual(['emp-1', '2026-05-01', '2026-05-21', '%C01-0042%', '%C01-0042%', '%C01-0042%'])
  })

  it('busqueda matchea por nombre de cliente (mismo termino, misma clausula OR)', () => {
    const { sql, params } = buildFacturasEmpresaFiltro({ ...base, busqueda: 'Maria' })
    expect(sql).toContain('OR c.nombre LIKE ?')
    expect(params).toContain('%Maria%')
  })

  it('busqueda matchea por RIF (mismo termino, misma clausula OR)', () => {
    const { sql, params } = buildFacturasEmpresaFiltro({ ...base, busqueda: 'V-123' })
    expect(sql).toContain('OR c.identificacion LIKE ?')
    expect(params).toContain('%V-123%')
  })

  it('busqueda vacia o solo whitespace: NO agrega la clausula OR ni parametros', () => {
    const { sql, params } = buildFacturasEmpresaFiltro({ ...base, busqueda: '   ' })
    expect(sql).not.toContain('LIKE ?')
    expect(params).toEqual(['emp-1', '2026-05-01', '2026-05-21'])
  })

  it('busqueda omitida: comportamiento identico a busqueda vacia', () => {
    const { sql, params } = buildFacturasEmpresaFiltro(base)
    expect(sql).not.toContain('LIKE ?')
    expect(params).toEqual(['emp-1', '2026-05-01', '2026-05-21'])
  })

  it('params SIEMPRE parametrizados: ningun valor de busqueda se interpola directo en el SQL', () => {
    const { sql } = buildFacturasEmpresaFiltro({ ...base, busqueda: "'; DROP TABLE ventas; --" })
    expect(sql).not.toContain('DROP TABLE')
  })

  // ─── Slice E.b — estado FOLDED en la busqueda (tester QA feedback: el
  // select separado de Estado se retira; el texto de busqueda reconoce
  // palabras clave de estado y agrega su clausula ADEMAS del OR de
  // nro/cliente/RIF, nunca en su lugar) ────────

  it('busqueda="contado": agrega la clausula de estado CONTADO ADEMAS del OR de nro/cliente/rif (wide OR, nunca reemplaza)', () => {
    const { sql, params } = buildFacturasEmpresaFiltro({ ...base, busqueda: 'contado' })
    expect(sql).toContain('v.nro_factura LIKE ?')
    expect(sql).toContain('c.nombre LIKE ?')
    expect(sql).toContain('c.identificacion LIKE ?')
    expect(sql).toContain('CAST(v.saldo_pend_usd AS REAL) <= 0.005')
    expect(params).toEqual(['emp-1', '2026-05-01', '2026-05-21', '%contado%', '%contado%', '%contado%'])
  })

  it('busqueda="Crédito" (con tilde y mayuscula): agrega la clausula CREDITO (case/acento-insensitive)', () => {
    const { sql } = buildFacturasEmpresaFiltro({ ...base, busqueda: 'Crédito' })
    expect(sql).toContain('CAST(v.saldo_pend_usd AS REAL) >= (CAST(v.total_usd AS REAL) - 0.005)')
  })

  it('busqueda="abonada": agrega la clausula ABONADA (NUEVO estado, no existia en el select viejo) consistente con derivarEstadoPago', () => {
    const { sql, params } = buildFacturasEmpresaFiltro({ ...base, busqueda: 'abonada' })
    expect(sql).toContain('CAST(v.saldo_pend_usd AS REAL) > 0.005')
    expect(sql).toContain('CAST(v.saldo_pend_usd AS REAL) < (CAST(v.total_usd AS REAL) - 0.005)')
    expect(params).toEqual(['emp-1', '2026-05-01', '2026-05-21', '%abonada%', '%abonada%', '%abonada%'])
  })

  it('busqueda="reverso parcial": agrega EXISTS notas_credito con tipo PARCIAL', () => {
    const { sql } = buildFacturasEmpresaFiltro({ ...base, busqueda: 'reverso parcial' })
    expect(sql).toMatch(/EXISTS\(SELECT 1 FROM notas_credito \w+ WHERE \w+\.venta_id = v\.id AND \w+\.tipo = 'PARCIAL'\)/)
  })

  it('busqueda="REVERSO TOTAL" (mayusculas): agrega EXISTS notas_credito con tipo TOTAL', () => {
    const { sql } = buildFacturasEmpresaFiltro({ ...base, busqueda: 'REVERSO TOTAL' })
    expect(sql).toMatch(/EXISTS\(SELECT 1 FROM notas_credito \w+ WHERE \w+\.venta_id = v\.id AND \w+\.tipo = 'TOTAL'\)/)
  })

  it('busqueda="Maria" (texto normal de cliente): NO agrega ninguna clausula de estado, solo el OR de nro/cliente/rif', () => {
    const { sql, params } = buildFacturasEmpresaFiltro({ ...base, busqueda: 'Maria' })
    expect(sql).not.toContain('saldo_pend_usd AS REAL')
    // El SELECT-list SIEMPRE tiene 2 EXISTS(...notas_credito nc...) para
    // tiene_reverso_total/parcial (Slice A) — lo que NO debe aparecer es el
    // EXISTS de la clausula de estado (alias `nce`, WHERE).
    expect(sql).not.toContain('notas_credito nce')
    expect(sql).toContain('AND (v.nro_factura LIKE ? OR c.nombre LIKE ? OR c.identificacion LIKE ?)')
    expect(params).toEqual(['emp-1', '2026-05-01', '2026-05-21', '%Maria%', '%Maria%', '%Maria%'])
  })

  it('busqueda="reverso" (palabra suelta, no es keyword exacto): NO agrega clausula de estado — sigue matcheando por nombre/nro/rif (ej. cliente llamado "Reverso")', () => {
    const { sql } = buildFacturasEmpresaFiltro({ ...base, busqueda: 'reverso' })
    expect(sql).not.toContain('notas_credito nce')
    expect(sql).toContain('AND (v.nro_factura LIKE ? OR c.nombre LIKE ? OR c.identificacion LIKE ?)')
  })

  it('busqueda vacia: no agrega ninguna clausula de estado (sin busqueda no hay deteccion de keyword)', () => {
    const { sql, params } = buildFacturasEmpresaFiltro(base)
    expect(sql).not.toContain('saldo_pend_usd AS REAL')
    expect(sql).not.toContain('notas_credito nce')
    expect(params).toEqual(['emp-1', '2026-05-01', '2026-05-21'])
  })

  it('empresa_id SIEMPRE presente incluso cuando la busqueda dispara la clausula de estado', () => {
    const { sql, params } = buildFacturasEmpresaFiltro({ ...base, busqueda: 'reverso total' })
    expect(sql).toContain('v.empresa_id = ?')
    expect(params[0]).toBe('emp-1')
  })

  it('el campo `estado` YA NO existe en FiltroFacturasEmpresa (folded en busqueda, tester QA feedback Slice E.b)', () => {
    // @ts-expect-error — `estado` fue retirado del contrato publico del builder
    const built = buildFacturasEmpresaFiltro({ ...base, estado: 'CONTADO' })
    // Un `estado` suelto sin `busqueda` no dispara ninguna deteccion de keyword.
    expect(built.sql).not.toContain('saldo_pend_usd AS REAL')
  })
})

// ─── buildNotasCreditoFiltro (Slice A.5/A.6 + Slice E.2/E.3) ────────

describe('buildNotasCreditoFiltro (mismos casos + filtro de estado reverso TOTAL/PARCIAL)', () => {
  const base = { empresaId: 'emp-1', fechaDesde: '2026-05-01', fechaHasta: '2026-05-21' }

  it('sin filtros opcionales: WHERE incluye empresa_id y rango de fecha, params = [empresaId, fechaDesde, fechaHasta]', () => {
    const { sql, params } = buildNotasCreditoFiltro(base)
    expect(sql).toContain('nc.empresa_id = ?')
    expect(sql).toContain("T00:00:00-04:00")
    expect(sql).toContain("T23:59:59-04:00")
    expect(params).toEqual(['emp-1', '2026-05-01', '2026-05-21'])
  })

  it('preserva el buscador/JOIN existente: nc.venta_id -> ventas v, nc.cliente_id -> clientes c', () => {
    const { sql } = buildNotasCreditoFiltro(base)
    expect(sql).toContain('FROM notas_credito nc')
    expect(sql).toContain('JOIN ventas v ON nc.venta_id = v.id')
    expect(sql).toContain('JOIN clientes c ON nc.cliente_id = c.id')
  })

  // ─── Slice E.2 — busqueda unificada (patron POS: un solo input) ────────

  it('busqueda: agrega OR sobre nro_ncr/cliente_nombre/cliente_identificacion, con el termino repetido 3 veces en params', () => {
    const { sql, params } = buildNotasCreditoFiltro({ ...base, busqueda: 'NCR-000012' })
    expect(sql).toContain('AND (nc.nro_ncr LIKE ? OR c.nombre LIKE ? OR c.identificacion LIKE ?)')
    expect(params).toEqual(['emp-1', '2026-05-01', '2026-05-21', '%NCR-000012%', '%NCR-000012%', '%NCR-000012%'])
  })

  it('busqueda matchea por nombre de cliente', () => {
    const { sql, params } = buildNotasCreditoFiltro({ ...base, busqueda: 'Maria' })
    expect(sql).toContain('OR c.nombre LIKE ?')
    expect(params).toContain('%Maria%')
  })

  it('busqueda matchea por RIF', () => {
    const { sql, params } = buildNotasCreditoFiltro({ ...base, busqueda: 'V-123' })
    expect(sql).toContain('OR c.identificacion LIKE ?')
    expect(params).toContain('%V-123%')
  })

  it('busqueda vacia o solo whitespace: NO agrega la clausula OR ni parametros', () => {
    const { sql, params } = buildNotasCreditoFiltro({ ...base, busqueda: '\t' })
    expect(sql).not.toContain('LIKE ?')
    expect(params).toEqual(['emp-1', '2026-05-01', '2026-05-21'])
  })

  it('params SIEMPRE parametrizados: ningun valor de busqueda se interpola directo en el SQL', () => {
    const { sql } = buildNotasCreditoFiltro({ ...base, busqueda: "'; DROP TABLE notas_credito; --" })
    expect(sql).not.toContain('DROP TABLE')
  })

  // ─── Slice E.b — estado RETIRADO por completo de NC (tester QA feedback:
  // a diferencia de Facturas, el estado de NC NO se folded en la busqueda —
  // simplemente deja de ser un filtro. `nc.tipo` ya no es filtrable) ────────

  it('nunca agrega clausula de nc.tipo, ni con busqueda ni sin ella (el filtro de estado se retiro por completo)', () => {
    const { sql, params } = buildNotasCreditoFiltro({ ...base, busqueda: 'Maria' })
    expect(sql).not.toContain('nc.tipo = ?')
    expect(params).toEqual(['emp-1', '2026-05-01', '2026-05-21', '%Maria%', '%Maria%', '%Maria%'])
  })

  it('el campo `estado` YA NO existe en FiltroNotasCredito (retirado por completo, tester QA feedback Slice E.b)', () => {
    // @ts-expect-error — `estado` fue retirado del contrato publico del builder
    const built = buildNotasCreditoFiltro({ ...base, estado: 'REVERSO_TOTAL' })
    expect(built.sql).not.toContain('nc.tipo = ?')
  })
})
