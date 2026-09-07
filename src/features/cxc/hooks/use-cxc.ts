import { useQuery } from '@powersync/react'
import type { Transaction } from '@powersync/common'
import { db } from '@/core/db/powersync/db'
import { useCurrentUser } from '@/core/hooks/use-current-user'
import { v4 as uuidv4 } from 'uuid'
import { localNow, todayStr, daysFromNow, VE_OFFSET } from '@/lib/dates'
import { cargarMapaCuentas } from '@/features/contabilidad/hooks/use-cuentas-config'
import { generarAsientosPagoCxC, reversarAsientos, leerMonedaContable } from '@/features/contabilidad/lib/generar-asientos'
import Decimal from 'decimal.js'
import { bsToUsd, usdToBs, toStorageString } from '@/lib/currency'
import { calcularSaldoNuevoMovimientoCuenta } from '@/features/cxc/lib/saldo-cliente'
import { calcularCreditoDisponible } from '@/features/cxc/lib/deuda-credito-cliente'

export interface VentaPendiente {
  id: string
  nro_factura: string
  fecha: string
  total_usd: string
  total_bs: string
  saldo_pend_usd: string
  tasa: string
  tipo: string
  cliente_id: string
}

export interface ClienteConDeuda {
  id: string
  identificacion: string
  nombre: string
  telefono: string | null
  saldo_actual: string
  limite_credito_usd: string
  facturas_pendientes: number
  /** Deuda real: SUM(ventas.saldo_pend_usd) — nunca neteada contra credito. */
  deuda_usd: number
  /** Saldo a favor disponible: MAX(0, SUM(SAFC) - SUM(SAF)) — nunca neteado contra deuda. */
  credito_disponible_usd: number
}

export interface PagoFacturaParams {
  venta_id: string
  cliente_id: string
  metodo_cobro_id: string
  moneda: 'USD' | 'BS'
  tasa: number
  monto: number
  fechaPago?: string       // YYYY-MM-DD; por defecto la fecha actual
  referencia?: string
  empresa_id: string
  procesado_por: string
  procesado_por_nombre: string
  sesion_caja_id?: string | null
  // SAF (saldo a favor) params — optional manual credit application
  aplicarSaf?: boolean
  montoSaf?: number
  safOrigenRefs?: string[]
}

export interface AbonoGlobalParams {
  cliente_id: string
  metodo_cobro_id: string
  moneda: 'USD' | 'BS'
  tasa: number
  monto: number
  referencia?: string
  empresa_id: string
  procesado_por: string
  procesado_por_nombre: string
  sesion_caja_id?: string | null
  // SAF (saldo a favor) params — optional manual credit application
  aplicarSaf?: boolean
  montoSaf?: number
  safOrigenRefs?: string[]
}

// Deuda y credito se calculan por separado, NUNCA neteados entre si (ver
// openspec/changes/cxc-saldo-favor-modelo/design.md Decision 1/3):
// - deuda_usd: SUM(ventas.saldo_pend_usd) de facturas realmente pendientes.
// - credito_disponible_usd: MAX(0, SUM(SAFC) - SUM(SAF)) en movimientos_cuenta.
//   'SAFC' aun no existe hasta que Slice B lo introduzca (migrations/0090); hasta
//   entonces esta columna retorna $0 de forma legitima, no es un bug.
// Se envuelve en subconsulta para poder filtrar/ordenar por los alias calculados.
const DEUDA_CREDITO_CLIENTE_SELECT = `
  c.id, c.identificacion, c.nombre, c.telefono, c.saldo_actual, c.limite_credito_usd,
  (SELECT COUNT(*) FROM ventas v WHERE v.cliente_id = c.id AND v.empresa_id = c.empresa_id AND CAST(v.saldo_pend_usd AS REAL) > 0.001) as facturas_pendientes,
  COALESCE((SELECT SUM(CAST(v.saldo_pend_usd AS REAL)) FROM ventas v WHERE v.cliente_id = c.id AND v.empresa_id = c.empresa_id AND CAST(v.saldo_pend_usd AS REAL) > 0.001), 0) as deuda_usd,
  MAX(0,
    COALESCE((SELECT SUM(CAST(mc.monto AS REAL)) FROM movimientos_cuenta mc WHERE mc.cliente_id = c.id AND mc.empresa_id = c.empresa_id AND mc.tipo = 'SAFC'), 0)
    - COALESCE((SELECT SUM(CAST(mc.monto AS REAL)) FROM movimientos_cuenta mc WHERE mc.cliente_id = c.id AND mc.empresa_id = c.empresa_id AND mc.tipo = 'SAF'), 0)
  ) as credito_disponible_usd
`

/**
 * Clientes con deuda pendiente y/o saldo a favor (nunca neteados).
 */
export function useClientesConDeuda() {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''

  const { data, isLoading } = useQuery(
    `SELECT * FROM (
       SELECT ${DEUDA_CREDITO_CLIENTE_SELECT}
       FROM clientes c
       WHERE c.empresa_id = ? AND c.is_active = 1
     ) t
     WHERE deuda_usd > 0.001 OR credito_disponible_usd > 0.001
     ORDER BY deuda_usd DESC`,
    [empresaId]
  )
  return { clientes: (data ?? []) as ClienteConDeuda[], isLoading }
}

/**
 * Buscar clientes con deuda y/o saldo a favor por nombre/identificacion.
 */
export function useBuscarClientesDeuda(query: string) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const searchTerm = query.trim()
  const shouldSearch = searchTerm.length >= 2
  const pattern = `%${searchTerm}%`

  const { data, isLoading } = useQuery(
    shouldSearch
      ? `SELECT * FROM (
           SELECT ${DEUDA_CREDITO_CLIENTE_SELECT}
           FROM clientes c
           WHERE c.empresa_id = ? AND c.is_active = 1
             AND (c.identificacion LIKE ? OR c.nombre LIKE ?)
         ) t
         WHERE deuda_usd > 0.001 OR credito_disponible_usd > 0.001
         ORDER BY nombre ASC LIMIT 20`
      : '',
    shouldSearch ? [empresaId, pattern, pattern] : []
  )
  return { clientes: (data ?? []) as ClienteConDeuda[], isLoading }
}

/**
 * Facturas de un cliente ordenadas por fecha ASC.
 * Por defecto solo devuelve las pendientes (saldo_pend_usd > 0).
 * Con incluirPagadas=true devuelve todas menos las anuladas/reversadas,
 * lo que permite acceder al historial de pagos para reversarlos.
 */
export function useFacturasPendientes(clienteId: string | null, incluirPagadas = false) {
  const { data, isLoading } = useQuery(
    clienteId
      ? incluirPagadas
        ? `SELECT * FROM ventas
           WHERE cliente_id = ?
             AND (status IS NULL OR status NOT IN ('ANULADA', 'REVERSADA'))
           ORDER BY fecha ASC`
        : `SELECT * FROM ventas
           WHERE cliente_id = ? AND CAST(saldo_pend_usd AS REAL) > 0.001
           ORDER BY fecha ASC`
      : '',
    clienteId ? [clienteId] : []
  )
  return { facturas: (data ?? []) as VentaPendiente[], isLoading }
}

export interface DetalleFacturaCxc {
  id: string
  venta_id: string
  producto_id: string
  cantidad: string
  precio_unitario_usd: string
  subtotal_usd: string
  subtotal_bs: string
  producto_nombre: string
  producto_codigo: string
  tipo_impuesto: string
  impuesto_pct: string
  /** `unidades.es_decimal` del producto (PowerSync boolean-as-integer). `null` si el producto no tiene unidad_base_id. */
  es_decimal: number | null
  /** `precio_unitario_usd` convertido a Bs con la tasa HISTORICA de la venta (`v.tasa`), no la tasa vigente. */
  precio_unitario_bs: string
}

export interface PagoFacturaCxc {
  id: string
  venta_id: string
  metodo_cobro_id: string
  moneda_id: string
  tasa: string
  monto: string
  monto_usd: string
  referencia: string | null
  fecha: string
  metodo_nombre: string
  moneda_label: string
  is_reversed: number
  reversed_at: string | null
  reversed_by: string | null
  reversed_reason: string | null
  procesado_por_nombre: string | null
  created_by: string | null
}

export interface PagoClienteCxc extends PagoFacturaCxc {
  nro_factura: string | null
}

/**
 * Todos los pagos de un cliente (para vista de estado de cuenta del cliente)
 */
export function usePagosCliente(clienteId: string | null) {
  const { data, isLoading } = useQuery(
    clienteId
      ? `SELECT pg.id, pg.venta_id, pg.metodo_cobro_id, pg.moneda_id, pg.tasa, pg.monto, pg.monto_usd,
           pg.referencia, pg.fecha, pg.created_by,
           pg.is_reversed, pg.reversed_at, pg.reversed_by, pg.reversed_reason, pg.procesado_por_nombre,
           v.nro_factura,
           mc.nombre as metodo_nombre,
           CASE WHEN mon.codigo_iso = 'VES' THEN 'BS' ELSE 'USD' END as moneda_label
         FROM pagos pg
         LEFT JOIN ventas v ON pg.venta_id = v.id
         JOIN metodos_cobro mc ON pg.metodo_cobro_id = mc.id
         LEFT JOIN monedas mon ON pg.moneda_id = mon.id
         WHERE pg.cliente_id = ?
         ORDER BY pg.fecha DESC`
      : '',
    clienteId ? [clienteId] : []
  )
  return { pagos: (data ?? []) as PagoClienteCxc[], isLoading }
}

/**
 * Detalle de articulos de una venta
 */
export function useDetalleFactura(ventaId: string | null) {
  const { data, isLoading } = useQuery(
    ventaId
      ? `SELECT vd.id, vd.venta_id, vd.producto_id, vd.cantidad, vd.precio_unitario_usd, vd.subtotal_usd, vd.subtotal_bs,
           vd.tipo_impuesto, vd.impuesto_pct,
           p.nombre as producto_nombre, p.codigo as producto_codigo,
           u.es_decimal,
           ROUND(CAST(vd.precio_unitario_usd AS REAL) * CAST(v.tasa AS REAL), 2) as precio_unitario_bs
         FROM ventas_det vd
         JOIN productos p ON vd.producto_id = p.id
         JOIN ventas v ON vd.venta_id = v.id
         LEFT JOIN unidades u ON p.unidad_base_id = u.id
         WHERE vd.venta_id = ?`
      : '',
    ventaId ? [ventaId] : []
  )
  return { detalle: (data ?? []) as DetalleFacturaCxc[], isLoading }
}

interface AfectacionCxcRow {
  n: number
}

/**
 * Fuente correcta y persistida de "afectacion a CxC" de una factura (Design
 * §Decision 6, openspec/changes/notas-credito-ui-pos): COUNT(*) de
 * `movimientos_cuenta WHERE venta_id = ?`. NUNCA `construirCierreRecibo`/
 * `discrepancy` de `recibo-pagos.ts` — ese estado es efimero de React
 * (calculado en el momento del cobro, nunca persistido) e irrecuperable
 * para facturas historicas. El llamador deriva el booleano final via
 * `huboAfectacionCxc(cantidadMovimientos)` (notas-credito-ui.ts).
 */
export function useAfectacionCxc(ventaId: string | null, empresaId: string) {
  const { data, isLoading } = useQuery(
    ventaId && empresaId
      ? 'SELECT COUNT(*) as n FROM movimientos_cuenta WHERE venta_id = ? AND empresa_id = ?'
      : '',
    ventaId && empresaId ? [ventaId, empresaId] : []
  )
  const row = (data?.[0] as AfectacionCxcRow | undefined) ?? null
  return { cantidadMovimientos: row?.n ?? 0, isLoading }
}

interface VentaFechaRow {
  fecha: string
}

/**
 * Fecha persistida de una venta (para documentos/recibos que deben reflejar
 * el momento real de la transaccion, no el momento en que se genera el PDF/share).
 */
export function useVentaFecha(ventaId: string | null) {
  const { data, isLoading } = useQuery(
    ventaId ? 'SELECT fecha FROM ventas WHERE id = ?' : '',
    ventaId ? [ventaId] : []
  )
  const row = (data?.[0] as VentaFechaRow | undefined) ?? null
  return { fecha: row?.fecha ?? null, isLoading }
}

export interface CargoEspecialVenta {
  id: string
  tipo: string          // 'AVANCE' | 'PRESTAMO'
  concepto: string
  monto: string         // efectivo entregado (egreso de caja)
  fecha: string
}

/**
 * Cargos especiales (avance/prestamo) vinculados a una venta especifica.
 * Se identifican por doc_origen_id = ventaId y origen IN ('AVANCE','PRESTAMO')
 */
export function useCargosEspecialesVenta(ventaId: string | null) {
  const { data, isLoading } = useQuery(
    ventaId
      ? `SELECT id, origen as tipo, concepto, monto, fecha
         FROM movimientos_metodo_cobro
         WHERE doc_origen_id = ? AND origen IN ('AVANCE','PRESTAMO')
         ORDER BY fecha ASC`
      : '',
    ventaId ? [ventaId] : []
  )
  return { cargos: (data ?? []) as CargoEspecialVenta[], isLoading }
}

export interface VencimientoVenta {
  id: string
  nro_cuota: number
  fecha_vencimiento: string
  monto_original_usd: string
  monto_pagado_usd: string
  saldo_pendiente_usd: string
  status: string
}

/**
 * Vencimientos de prestamo vinculados a una venta especifica.
 * Creados automaticamente al cerrar una venta con cargos PRESTAMO.
 */
export function useVencimientosVenta(ventaId: string | null) {
  const { data, isLoading } = useQuery(
    ventaId
      ? `SELECT id, nro_cuota, fecha_vencimiento, monto_original_usd, monto_pagado_usd, saldo_pendiente_usd, status
         FROM vencimientos_cobrar
         WHERE venta_id = ?
         ORDER BY nro_cuota ASC`
      : '',
    ventaId ? [ventaId] : []
  )
  return { vencimientos: (data ?? []) as VencimientoVenta[], isLoading }
}

/**
 * Pagos realizados a una factura
 */
export function usePagosFactura(ventaId: string | null) {
  const { data, isLoading } = useQuery(
    ventaId
      ? `SELECT pg.id, pg.venta_id, pg.metodo_cobro_id, pg.moneda_id, pg.tasa, pg.monto, pg.monto_usd,
           pg.referencia, pg.fecha, pg.created_by,
           pg.is_reversed, pg.reversed_at, pg.reversed_by, pg.reversed_reason, pg.procesado_por_nombre,
           mc.nombre as metodo_nombre,
           CASE WHEN mon.codigo_iso = 'VES' THEN 'BS' ELSE 'USD' END as moneda_label
         FROM pagos pg
         JOIN metodos_cobro mc ON pg.metodo_cobro_id = mc.id
         LEFT JOIN monedas mon ON pg.moneda_id = mon.id
         WHERE pg.venta_id = ?
         ORDER BY pg.fecha ASC`
      : '',
    ventaId ? [ventaId] : []
  )
  return { pagos: (data ?? []) as PagoFacturaCxc[], isLoading }
}

export interface AplicarPagoEnTxParams extends Omit<PagoFacturaParams, 'procesado_por_nombre'> {
  /** Nombre del cajero/usuario — opcional cuando se llama desde crearVenta */
  procesado_por_nombre?: string | null
  /**
   * true cuando se llama desde crearVenta (modo SAF desde POS).
   * El efectivo ya ingresó como parte de la venta original, no se genera
   * un movimiento bancario adicional para evitar doble conteo.
   * Default: false (comportamiento normal de CxC standalone).
   */
  skipBankAndAccounting?: boolean
  /**
   * true cuando el pago es una asignación interna del excedente POS (SAF aplicado
   * a facturas crédito). Marca el registro en pagos con is_pos_saf_allocation = 1
   * y omite el movimiento_metodo_cobro (COBRO) para evitar doble conteo en el
   * cuadre de caja — el efectivo ya fue contabilizado en el pago de la venta original.
   * Default: false.
   */
  isPosAllocation?: boolean
}

/**
 * Aplica un pago a una factura específica DENTRO de una transacción existente.
 * Extrae la lógica core de registrarPagoFactura para permitir su uso desde
 * otros contextos (ej: POS/crearVenta) sin romper la atomicidad.
 *
 * El llamador es responsable de proveer `tx` y `now`.
 * No inicia su propia writeTransaction.
 */
export async function aplicarPagoFacturaEnTx(
  tx: Transaction,
  params: AplicarPagoEnTxParams,
  now: string
): Promise<void> {
  const {
    venta_id, cliente_id, metodo_cobro_id, moneda, tasa, monto,
    fechaPago, referencia, empresa_id, procesado_por,
    procesado_por_nombre = null, sesion_caja_id,
    skipBankAndAccounting = false,
    isPosAllocation = false,
  } = params

  if (!Number.isFinite(tasa) || tasa <= 0) throw new Error('La tasa de cambio debe ser mayor a 0')
  if (!Number.isFinite(monto) || monto <= 0) throw new Error('El monto debe ser mayor a 0')

  const fechaDoc = fechaPago ? `${fechaPago}T00:00:00${VE_OFFSET}` : now

  // 0. Obtener UUID de moneda
  const monedaCode = moneda === 'BS' ? 'VES' : 'USD'
  const monedaResult = await tx.execute(
    'SELECT id FROM monedas WHERE codigo_iso = ? LIMIT 1',
    [monedaCode]
  )
  if (!monedaResult.rows?.length) {
    throw new Error(`No se encontro la moneda ${monedaCode} en el catalogo`)
  }
  const monedaId = (monedaResult.rows.item(0) as { id: string }).id

  // 1. Leer factura
  const ventaResult = await tx.execute(
    'SELECT nro_factura, saldo_pend_usd, tasa FROM ventas WHERE id = ?',
    [venta_id]
  )
  if (!ventaResult.rows || ventaResult.rows.length === 0) {
    throw new Error('Factura no encontrada')
  }
  const venta = ventaResult.rows.item(0) as { nro_factura: string; saldo_pend_usd: string; tasa: string }
  const saldoFactura = new Decimal(venta.saldo_pend_usd || '0')
  const tasaVenta = new Decimal(venta.tasa || '0')
  const tasaD = new Decimal(tasa)
  const montoD = new Decimal(monto)

  // 2. Calcular monto en USD
  const montoUsd = moneda === 'BS' ? bsToUsd(montoD, tasaD) : montoD

  // 3. Validar que no exceda saldo pendiente
  if (montoUsd.gt(saldoFactura.plus(new Decimal('0.01')))) {
    throw new Error(
      `El pago ($${toStorageString(montoUsd)}) excede el saldo pendiente ($${toStorageString(saldoFactura)}) de la factura ${venta.nro_factura}`
    )
  }

  // 4. INSERT pago
  // is_pos_saf_allocation = 1 indica que este pago es una asignación interna del
  // excedente POS — el efectivo ya entró con la venta original y NO debe sumarse
  // al total del método de pago ni al saldo esperado de caja.
  const pagoId = uuidv4()
  await tx.execute(
    `INSERT INTO pagos (id, venta_id, cliente_id, metodo_cobro_id, moneda_id, tasa, monto, monto_usd, referencia, sesion_caja_id, fecha, empresa_id, created_at, created_by, procesado_por_nombre, is_pos_saf_allocation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      pagoId, venta_id, cliente_id, metodo_cobro_id, monedaId,
      toStorageString(tasaD), toStorageString(montoD), toStorageString(montoUsd),
      referencia ?? null, sesion_caja_id ?? null, fechaDoc,
      empresa_id, now, procesado_por, procesado_por_nombre ?? null,
      isPosAllocation ? 1 : 0,
    ]
  )

  // Crear movimiento_metodo_cobro (origen COBRO) solo para cobros CxC standalone.
  // Cuando isPosAllocation=true el efectivo ya ingresó con la venta original;
  // omitir el movimiento evita doble conteo en el cuadre de caja.
  if (montoUsd.gt(0) && !isPosAllocation) {
    await tx.execute(
      `INSERT INTO movimientos_metodo_cobro
         (id, empresa_id, metodo_cobro_id, tipo, origen, monto, saldo_anterior, saldo_nuevo,
          doc_origen_id, doc_origen_ref, concepto, sesion_caja_id, fecha, created_at, created_by)
       VALUES (?, ?, ?, 'INGRESO', 'COBRO', ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(), empresa_id, metodo_cobro_id,
        toStorageString(montoD),    // monto = nativo (Bs para pagos BS, USD para pagos USD)
        venta_id,
        `PAG-${venta.nro_factura}`, `Pago CxC fac. ${venta.nro_factura}`,
        sesion_caja_id ?? null, fechaDoc, now, procesado_por,
      ]
    )
  }

  // 5. Reducir saldo pendiente de factura
  const nuevoSaldoFactura = Decimal.max(new Decimal(0), saldoFactura.minus(montoUsd))
  await tx.execute('UPDATE ventas SET saldo_pend_usd = ? WHERE id = ?', [
    toStorageString(nuevoSaldoFactura), venta_id,
  ])

  // 6. Movimiento de cuenta (tipo PAG) + actualizar saldo cliente
  const clienteResult = await tx.execute('SELECT saldo_actual FROM clientes WHERE id = ?', [cliente_id])
  if (!clienteResult.rows || clienteResult.rows.length === 0) {
    throw new Error('Cliente no encontrado')
  }
  const saldoActual = new Decimal((clienteResult.rows.item(0) as { saldo_actual: string }).saldo_actual || '0')
  // Sin clamp a 0: si el cliente tenia saldo a favor (credito), el pago puede
  // dejarlo con saldo negativo remanente — eso es correcto, no un error.
  // Ver openspec/changes/saldo-a-favor-fix/specs/cxc-pago-factura/spec.md
  const saldoNuevo = calcularSaldoNuevoMovimientoCuenta('PAG', saldoActual, montoUsd)

  const movId = uuidv4()
  await tx.execute(
    `INSERT INTO movimientos_cuenta (id, cliente_id, tipo, referencia, monto, saldo_anterior, saldo_nuevo, observacion, venta_id, fecha, empresa_id, created_at, created_by, moneda_pago, monto_moneda, tasa_pago)
     VALUES (?, ?, 'PAG', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      movId, cliente_id, `PAG-${venta.nro_factura}`,
      toStorageString(montoUsd), toStorageString(saldoActual), toStorageString(saldoNuevo),
      `Pago factura ${venta.nro_factura}`,
      venta_id, fechaDoc, empresa_id, now, procesado_por,
      moneda, toStorageString(montoD), toStorageString(tasaD),
    ]
  )

  // UPDATE directo para reflejar el cambio en SQLite local inmediatamente.
  // En Supabase el trigger actualizar_saldo_cliente lo gestiona automáticamente
  // via el INSERT de movimientos_cuenta; este UPDATE llega como no-op (mismo valor).
  await tx.execute('UPDATE clientes SET saldo_actual = ?, updated_at = ? WHERE id = ?', [
    toStorageString(saldoNuevo), now, cliente_id,
  ])

  // 6b. Si la factura tiene préstamos vinculados, sincronizar vencimientos_cobrar (FIFO)
  // Esto garantiza que el módulo de Préstamos refleje el abono en tiempo real.
  const vencPrestResult = await tx.execute(
    `SELECT id, saldo_pendiente_usd, monto_pagado_usd
     FROM vencimientos_cobrar
     WHERE venta_id = ? AND empresa_id = ? AND status = 'PENDIENTE'
     ORDER BY fecha_vencimiento ASC`,
    [venta_id, empresa_id]
  )
  let montoRestante = montoUsd
  for (let i = 0; i < (vencPrestResult.rows?.length ?? 0) && montoRestante.gt(new Decimal('0.005')); i++) {
    const vc = vencPrestResult.rows!.item(i) as {
      id: string; saldo_pendiente_usd: string; monto_pagado_usd: string
    }
    const saldoVc = new Decimal(vc.saldo_pendiente_usd || '0')
    const pagadoVc = new Decimal(vc.monto_pagado_usd || '0')
    const abonar = Decimal.min(montoRestante, saldoVc)
    const nuevoSaldoVc = Decimal.max(new Decimal(0), saldoVc.minus(abonar))
    const nuevoPagadoVc = pagadoVc.plus(abonar)
    const nuevoStatusVc = nuevoSaldoVc.lte(new Decimal('0.005')) ? 'PAGADO' : 'PENDIENTE'

    await tx.execute(
      `UPDATE vencimientos_cobrar
       SET monto_pagado_usd = ?, saldo_pendiente_usd = ?, status = ?
       WHERE id = ?`,
      [toStorageString(nuevoPagadoVc), toStorageString(nuevoSaldoVc), nuevoStatusVc, vc.id]
    )

    // El historial de Préstamos para facturas vinculadas se construye desde `pagos`
    // (useHistorialPrestamo usa pagos cuando ventaId != null, cubriendo todos los paths de pago)

    montoRestante = montoRestante.minus(abonar)
  }

  // 7. Banco + contabilidad (solo para pagos CxC standalone; el POS los omite
  //    porque el efectivo ya ingresó con la venta original)
  if (!skipBankAndAccounting) {
    try {
      const metodoCxCResult = await tx.execute(
        'SELECT banco_empresa_id, deposito_directo FROM metodos_cobro WHERE id = ? LIMIT 1',
        [metodo_cobro_id]
      )
      const _metodoCxCRow = metodoCxCResult.rows?.item(0) as
        | { banco_empresa_id: string | null; deposito_directo: number | null }
        | undefined
      const bancoCxCId = _metodoCxCRow?.banco_empresa_id ?? null
      const _depositoDirecto = _metodoCxCRow?.deposito_directo ?? 0

      if (bancoCxCId && montoUsd.gt(0) && _depositoDirecto === 1) {
        const _bancoRow = await tx.execute(
          'SELECT saldo_actual, moneda_id FROM bancos_empresa WHERE id = ? LIMIT 1',
          [bancoCxCId]
        )
        const _bancoData = _bancoRow.rows?.item(0) as
          | { saldo_actual: string; moneda_id: string }
          | undefined
        const _monedaRow = await tx.execute(
          'SELECT codigo_iso FROM monedas WHERE id = ? LIMIT 1',
          [_bancoData?.moneda_id ?? '']
        )
        const _bancoMonedaCodigo =
          (_monedaRow.rows?.item(0) as { codigo_iso: string } | undefined)?.codigo_iso ?? 'USD'

        const _esBancoBS = _bancoMonedaCodigo === 'VES'
        const _montoNativo = _esBancoBS
          ? (moneda === 'BS' ? monto : usdToBs(montoUsd, tasaD).toNumber())
          : (moneda === 'BS' ? bsToUsd(monto, tasaD).toNumber() : montoUsd.toNumber())

        const _saldoAnt = parseFloat(_bancoData?.saldo_actual ?? '0')
        const _saldoNuevo = _saldoAnt + _montoNativo

        await tx.execute(
          `INSERT INTO movimientos_bancarios
             (id, empresa_id, banco_empresa_id, tipo, origen, monto, saldo_anterior, saldo_nuevo,
              doc_origen_id, doc_origen_tipo, referencia, validado, observacion, fecha, created_at, created_by)
           VALUES (?, ?, ?, 'INGRESO', 'TRANSFERENCIA_CLIENTE', ?, ?, ?, ?, 'PAGO_CXC', ?, 0, ?, ?, ?, ?)`,
          [
            uuidv4(), empresa_id, bancoCxCId,
            toStorageString(_montoNativo),
            toStorageString(_saldoAnt),
            toStorageString(_saldoNuevo),
            venta_id, referencia ?? null,
            `Cobro CxC fac.${venta.nro_factura}`, now, now, procesado_por,
          ]
        )

        await tx.execute(
          'UPDATE bancos_empresa SET saldo_actual = ?, updated_at = ? WHERE id = ?',
          [toStorageString(_saldoNuevo), now, bancoCxCId]
        )
      }

      const [cuentas, monedaContable] = await Promise.all([
        cargarMapaCuentas(tx, empresa_id),
        leerMonedaContable(tx, empresa_id),
      ])
      await generarAsientosPagoCxC(tx, {
        empresaId: empresa_id,
        pagoId,
        pagoRef: `PAG-${venta.nro_factura}`,
        monto_usd: montoUsd.toNumber(),
        banco_empresa_id: bancoCxCId,
        cuentas,
        usuarioId: procesado_por,
        monedaContable,
        tasaPago: tasa,
        tasaVenta: tasaVenta.toNumber(),
      })
    } catch {
      // Fallo en contabilidad/bancos no bloquea el pago
    }
  }
}

/**
 * Pago a factura especifica.
 * Valida: monto <= saldo_pend_usd de la factura.
 * Crea pago, reduce saldo factura, crea movimiento_cuenta (tipo PAG), actualiza saldo cliente.
 * Acepta params SAF opcionales: cuando aplicarSaf=true, inserta movimiento_cuenta tipo='SAF'
 * con saf_origen_refs y reduce el monto del método de cobro en consecuencia.
 * Todo dentro de una sola writeTransaction atómica.
 */
export async function registrarPagoFactura(params: PagoFacturaParams): Promise<void> {
  if (!Number.isFinite(params.tasa) || params.tasa <= 0) throw new Error('La tasa de cambio debe ser mayor a 0')
  // monto puede ser 0 cuando SAF cubre todo el saldo
  if (!Number.isFinite(params.monto) || params.monto < 0) throw new Error('El monto no puede ser negativo')
  if (params.aplicarSaf && params.monto === 0 && !params.montoSaf) {
    throw new Error('Se requiere montoSaf cuando el pago es cubierto completamente por SAF')
  }
  if (!params.aplicarSaf && params.monto <= 0) throw new Error('El monto debe ser mayor a 0')

  await db.writeTransaction(async (tx) => {
    const now = localNow()
    const { venta_id, cliente_id, empresa_id, procesado_por, tasa } = params
    const fechaDoc = params.fechaPago ? `${params.fechaPago}T00:00:00${VE_OFFSET}` : now
    const tasaD = new Decimal(tasa)

    if (params.aplicarSaf && params.montoSaf && params.montoSaf > 0) {
      const montoSaf = new Decimal(params.montoSaf)
      const safOrigenRefs = params.safOrigenRefs ?? []

      // 1. Validate client has enough SAF credit.
      // saldo_actual sigue siendo la fuente del ledger crudo (para
      // saldo_anterior/saldo_nuevo mas abajo), pero el GATE de validacion usa
      // la fuente confiable SUM(SAFC)-SUM(SAF) — saldo_actual mezcla deuda y
      // credito y puede leer casi-cero con credito real disponible. Ver
      // design.md Decision 1/3.
      const clienteRes = await tx.execute(
        'SELECT saldo_actual FROM clientes WHERE id = ? LIMIT 1',
        [cliente_id]
      )
      if (!clienteRes.rows?.length) throw new Error('Cliente no encontrado')
      const saldoActualSaf = new Decimal((clienteRes.rows.item(0) as { saldo_actual: string }).saldo_actual || '0')

      const creditoSafRes = await tx.execute(
        `SELECT
           COALESCE(SUM(CASE WHEN tipo = 'SAFC' THEN CAST(monto AS REAL) ELSE 0 END), 0) as creado,
           COALESCE(SUM(CASE WHEN tipo = 'SAF' THEN CAST(monto AS REAL) ELSE 0 END), 0) as consumido
         FROM movimientos_cuenta WHERE cliente_id = ? AND empresa_id = ?`,
        [cliente_id, empresa_id]
      )
      const creditoSafRow = creditoSafRes.rows?.item(0) as { creado: number; consumido: number } | undefined
      const creditoSafDisponible = calcularCreditoDisponible(creditoSafRow?.creado ?? 0, creditoSafRow?.consumido ?? 0)

      if (creditoSafDisponible.lte('0.001')) throw new Error('El cliente no tiene saldo a favor disponible')
      if (montoSaf.gt(creditoSafDisponible.plus(new Decimal('0.01')))) {
        throw new Error(`El monto SAF ($${toStorageString(montoSaf)}) excede el saldo disponible ($${toStorageString(creditoSafDisponible)})`)
      }

      // 2. Read factura for validation and nro_factura
      const ventaRes = await tx.execute(
        'SELECT nro_factura, saldo_pend_usd FROM ventas WHERE id = ?',
        [venta_id]
      )
      if (!ventaRes.rows?.length) throw new Error('Factura no encontrada')
      const ventaSaf = ventaRes.rows.item(0) as { nro_factura: string; saldo_pend_usd: string }
      const saldoFacturaSaf = new Decimal(ventaSaf.saldo_pend_usd || '0')

      // Validate SAF does not exceed invoice balance
      if (montoSaf.gt(saldoFacturaSaf.plus(new Decimal('0.01')))) {
        throw new Error(`El monto SAF excede el saldo pendiente de la factura ${ventaSaf.nro_factura}`)
      }

      // 3. INSERT movimiento_cuenta tipo='SAF'
      const saldoAntesSaf = saldoActualSaf
      const saldoDespuesSaf = saldoActualSaf.plus(montoSaf)
      await tx.execute(
        `INSERT INTO movimientos_cuenta
           (id, empresa_id, cliente_id, tipo, referencia, monto, saldo_anterior, saldo_nuevo,
            observacion, venta_id, fecha, created_at, created_by,
            moneda_pago, monto_moneda, tasa_pago, saf_origen_refs)
         VALUES (?, ?, ?, 'SAF', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?)`,
        [
          uuidv4(), empresa_id, cliente_id,
          `SAF-CXC-${ventaSaf.nro_factura}`,
          toStorageString(montoSaf),
          toStorageString(saldoAntesSaf),
          toStorageString(saldoDespuesSaf),
          `Saldo a favor aplicado a factura ${ventaSaf.nro_factura}`,
          venta_id,
          fechaDoc, now, procesado_por,
          toStorageString(montoSaf),
          toStorageString(tasaD),
          safOrigenRefs.length > 0 ? JSON.stringify(safOrigenRefs) : null,
        ]
      )

      // 4. Reduce invoice saldo by SAF amount
      const nuevoSaldoSaf = Decimal.max(new Decimal(0), saldoFacturaSaf.minus(montoSaf))
      await tx.execute('UPDATE ventas SET saldo_pend_usd = ? WHERE id = ?', [
        toStorageString(nuevoSaldoSaf), venta_id,
      ])

      // 5. Update cliente saldo_actual (consume SAF credit)
      await tx.execute('UPDATE clientes SET saldo_actual = ?, updated_at = ? WHERE id = ?', [
        toStorageString(saldoDespuesSaf), now, cliente_id,
      ])
    }

    // Process remaining payment via payment method (if any)
    if (params.monto > 0) {
      await aplicarPagoFacturaEnTx(tx, params, now)
    }
  })
}

/**
 * Abono global FIFO.
 * Distribuye el monto entre facturas pendientes (ORDER BY fecha ASC).
 * Si sobra, crea un pago sin factura (anticipo).
 * Crea UN SOLO movimiento_cuenta (tipo PAG) por el total.
 */
export async function registrarAbonoGlobal(params: AbonoGlobalParams): Promise<{
  facturasAfectadas: number
  montoAplicado: number
}> {
  const { cliente_id, metodo_cobro_id, moneda, tasa, monto, referencia, empresa_id, procesado_por, procesado_por_nombre, sesion_caja_id } = params

  if (!Number.isFinite(tasa) || tasa <= 0) throw new Error('La tasa de cambio debe ser mayor a 0')
  if (!Number.isFinite(monto) || monto < 0) throw new Error('El monto no puede ser negativo')
  if (!params.aplicarSaf && monto <= 0) throw new Error('El monto debe ser mayor a 0')

  let facturasAfectadas = 0
  let montoAplicado = 0

  await db.writeTransaction(async (tx) => {
    const now = localNow()
    const tasaD = new Decimal(tasa)

    // Minimum processable amount: $1e-8 USD.
    // Supports micro-payments like Bs 0.01 at tasa 500 ($0.00002) or even at tasa 100,000 ($1e-7).
    // Old threshold was $0.01, which silently skipped any Bs payment < Bs 5 at tasa 500.
    const FIFO_EPSILON = new Decimal('0.00000001')

    // SAF pre-step: apply SAF credit before FIFO distribution
    if (params.aplicarSaf && params.montoSaf && params.montoSaf > 0) {
      const montoSaf = new Decimal(params.montoSaf)
      const safOrigenRefs = params.safOrigenRefs ?? []

      const clienteSafRes = await tx.execute(
        'SELECT saldo_actual FROM clientes WHERE id = ? LIMIT 1',
        [cliente_id]
      )
      if (!clienteSafRes.rows?.length) throw new Error('Cliente no encontrado')
      const saldoActualSaf = new Decimal(
        (clienteSafRes.rows.item(0) as { saldo_actual: string }).saldo_actual || '0'
      )
      if (saldoActualSaf.gte(new Decimal('-0.001'))) throw new Error('El cliente no tiene saldo a favor disponible')
      if (montoSaf.gt(saldoActualSaf.abs().plus(new Decimal('0.01')))) {
        throw new Error(`El monto SAF excede el saldo disponible ($${toStorageString(saldoActualSaf.abs())})`)
      }

      const saldoAntesSaf = saldoActualSaf
      const saldoDespuesSaf = saldoActualSaf.plus(montoSaf)

      // INSERT movimiento_cuenta tipo='SAF' for the global abono
      await tx.execute(
        `INSERT INTO movimientos_cuenta
           (id, empresa_id, cliente_id, tipo, referencia, monto, saldo_anterior, saldo_nuevo,
            observacion, venta_id, fecha, created_at, created_by,
            moneda_pago, monto_moneda, tasa_pago, saf_origen_refs)
         VALUES (?, ?, ?, 'SAF', ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'USD', ?, ?, ?)`,
        [
          uuidv4(), empresa_id, cliente_id,
          'SAF-ABONO-GLOBAL',
          toStorageString(montoSaf),
          toStorageString(saldoAntesSaf),
          toStorageString(saldoDespuesSaf),
          'Saldo a favor aplicado en abono global',
          now, now, procesado_por,
          toStorageString(montoSaf),
          toStorageString(tasaD),
          safOrigenRefs.length > 0 ? JSON.stringify(safOrigenRefs) : null,
        ]
      )

      // Distribute SAF across pending invoices (FIFO)
      const facturasSafRes = await tx.execute(
        `SELECT id, nro_factura, saldo_pend_usd FROM ventas
         WHERE cliente_id = ? AND CAST(saldo_pend_usd AS REAL) > 0.01
         ORDER BY fecha ASC`,
        [cliente_id]
      )
      let montoSafRestante = montoSaf
      if (facturasSafRes.rows) {
        for (let i = 0; i < facturasSafRes.rows.length && montoSafRestante.gt(FIFO_EPSILON); i++) {
          const fSaf = facturasSafRes.rows.item(i) as { id: string; nro_factura: string; saldo_pend_usd: string }
          const saldoFSaf = new Decimal(fSaf.saldo_pend_usd || '0')
          const aplicarSaf = Decimal.min(saldoFSaf, montoSafRestante)
          const nuevoSaldoFSaf = Decimal.max(new Decimal(0), saldoFSaf.minus(aplicarSaf))
          await tx.execute('UPDATE ventas SET saldo_pend_usd = ? WHERE id = ?', [
            toStorageString(nuevoSaldoFSaf), fSaf.id,
          ])
          montoSafRestante = montoSafRestante.minus(aplicarSaf)
        }
      }

      // Update cliente saldo_actual for SAF consumption
      await tx.execute('UPDATE clientes SET saldo_actual = ?, updated_at = ? WHERE id = ?', [
        toStorageString(saldoDespuesSaf), now, cliente_id,
      ])
    }

    // Proceed with regular payment (monto from payment method) if any
    if (monto <= 0) {
      // SAF covered everything — just return totals from the SAF step
      montoAplicado = params.montoSaf ?? 0
      return
    }

    // 0. Obtener UUID de moneda
    const monedaCode = moneda === 'BS' ? 'VES' : 'USD'
    const monedaResult = await tx.execute(
      'SELECT id FROM monedas WHERE codigo_iso = ? LIMIT 1',
      [monedaCode]
    )
    if (!monedaResult.rows?.length) {
      throw new Error(`No se encontro la moneda ${monedaCode} en el catalogo`)
    }
    const monedaId = (monedaResult.rows.item(0) as { id: string }).id

    // 1. Calcular monto total en USD
    const montoD = new Decimal(monto)
    const montoTotalUsd = moneda === 'BS' ? bsToUsd(montoD, tasaD) : montoD
    let montoRestante = montoTotalUsd

    // 2. Obtener facturas pendientes FIFO (ORDER BY fecha ASC)
    const facturasResult = await tx.execute(
      `SELECT id, nro_factura, saldo_pend_usd FROM ventas
       WHERE cliente_id = ? AND CAST(saldo_pend_usd AS REAL) > 0.01
       ORDER BY fecha ASC`,
      [cliente_id]
    )

    // 3. Cascada FIFO
    if (facturasResult.rows) {
      for (let i = 0; i < facturasResult.rows.length && montoRestante.gt(FIFO_EPSILON); i++) {
        const factura = facturasResult.rows.item(i) as {
          id: string
          nro_factura: string
          saldo_pend_usd: string
        }
        const saldoFactura = new Decimal(factura.saldo_pend_usd || '0')
        const montoAplicar = Decimal.min(saldoFactura, montoRestante)

        // INSERT pago vinculado a esta factura
        const pagoId = uuidv4()
        const montoNativo = moneda === 'BS' ? montoAplicar.times(tasaD) : montoAplicar
        await tx.execute(
          `INSERT INTO pagos (id, venta_id, cliente_id, metodo_cobro_id, moneda_id, tasa, monto, monto_usd, referencia, sesion_caja_id, fecha, empresa_id, created_at, created_by, procesado_por_nombre)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            pagoId,
            factura.id,
            cliente_id,
            metodo_cobro_id,
            monedaId,
            toStorageString(tasaD),
            toStorageString(montoNativo),
            toStorageString(montoAplicar),
            referencia ?? null,
            sesion_caja_id ?? null,
            now,
            empresa_id,
            now,
            procesado_por,
            procesado_por_nombre,
          ]
        )

        // Reducir saldo de esta factura
        const nuevoSaldo = Decimal.max(new Decimal(0), saldoFactura.minus(montoAplicar))
        await tx.execute('UPDATE ventas SET saldo_pend_usd = ? WHERE id = ?', [
          toStorageString(nuevoSaldo),
          factura.id,
        ])

        // Si la factura tiene préstamos vinculados, sincronizar vencimientos_cobrar FIFO
        const vencFifoResult = await tx.execute(
          `SELECT id, saldo_pendiente_usd, monto_pagado_usd
           FROM vencimientos_cobrar
           WHERE venta_id = ? AND empresa_id = ? AND status = 'PENDIENTE'
           ORDER BY fecha_vencimiento ASC`,
          [factura.id, empresa_id]
        )
        let montoRestanteVenc = montoAplicar
        for (let j = 0; j < (vencFifoResult.rows?.length ?? 0) && montoRestanteVenc.gt(FIFO_EPSILON); j++) {
          const vc = vencFifoResult.rows!.item(j) as {
            id: string; saldo_pendiente_usd: string; monto_pagado_usd: string
          }
          const saldoVc = new Decimal(vc.saldo_pendiente_usd || '0')
          const pagadoVc = new Decimal(vc.monto_pagado_usd || '0')
          const abonarVc = Decimal.min(montoRestanteVenc, saldoVc)
          const nuevoSaldoVc = Decimal.max(new Decimal(0), saldoVc.minus(abonarVc))
          const nuevoPagadoVc = pagadoVc.plus(abonarVc)
          const nuevoStatusVc = nuevoSaldoVc.lte(new Decimal('0.005')) ? 'PAGADO' : 'PENDIENTE'
          await tx.execute(
            `UPDATE vencimientos_cobrar
             SET monto_pagado_usd = ?, saldo_pendiente_usd = ?, status = ?
             WHERE id = ?`,
            [toStorageString(nuevoPagadoVc), toStorageString(nuevoSaldoVc), nuevoStatusVc, vc.id]
          )
          montoRestanteVenc = montoRestanteVenc.minus(abonarVc)
        }

        montoRestante = montoRestante.minus(montoAplicar)
        facturasAfectadas++
      }
    }

    // 4. Si sobra monto, crear pago sin factura (anticipo)
    if (montoRestante.gt(new Decimal('0.01'))) {
      const pagoAnticipoId = uuidv4()
      const montoRestanteNativo = moneda === 'BS' ? montoRestante.times(tasaD) : montoRestante
      await tx.execute(
        `INSERT INTO pagos (id, venta_id, cliente_id, metodo_cobro_id, moneda_id, tasa, monto, monto_usd, referencia, sesion_caja_id, fecha, empresa_id, created_at, created_by, procesado_por_nombre)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          pagoAnticipoId,
          null,
          cliente_id,
          metodo_cobro_id,
          monedaId,
          toStorageString(tasaD),
          toStorageString(montoRestanteNativo),
          toStorageString(montoRestante),
          referencia ? `${referencia} (anticipo)` : 'Anticipo',
          sesion_caja_id ?? null,
          now,
          empresa_id,
          now,
          procesado_por,
          procesado_por_nombre,
        ]
      )
    }

    montoAplicado = montoTotalUsd.toNumber()

    // 5. Crear UN SOLO movimiento_cuenta (tipo PAG) por el total
    const clienteResult = await tx.execute('SELECT saldo_actual FROM clientes WHERE id = ?', [
      cliente_id,
    ])
    if (!clienteResult.rows || clienteResult.rows.length === 0) {
      throw new Error('Cliente no encontrado')
    }
    const saldoActual = new Decimal(
      (clienteResult.rows.item(0) as { saldo_actual: string }).saldo_actual || '0'
    )
    const saldoNuevo = Decimal.max(new Decimal(0), saldoActual.minus(montoTotalUsd))

    const movId = uuidv4()
    const anticiPoSuffix = montoRestante.gt(new Decimal('0.01'))
      ? `, anticipo $${toStorageString(montoRestante)}`
      : ''
    await tx.execute(
      `INSERT INTO movimientos_cuenta (id, cliente_id, tipo, referencia, monto, saldo_anterior, saldo_nuevo, observacion, venta_id, fecha, empresa_id, created_at, created_by, moneda_pago, monto_moneda, tasa_pago)
       VALUES (?, ?, 'PAG', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        movId,
        cliente_id,
        `ABONO-GLOBAL`,
        toStorageString(montoTotalUsd),
        toStorageString(saldoActual),
        toStorageString(saldoNuevo),
        `Abono global: ${facturasAfectadas} factura(s) afectada(s)${anticiPoSuffix}`,
        null,
        now,
        empresa_id,
        now,
        procesado_por,
        moneda,
        toStorageString(montoD),
        toStorageString(tasaD),
      ]
    )

    await tx.execute('UPDATE clientes SET saldo_actual = ?, updated_at = ? WHERE id = ?', [
      toStorageString(saldoNuevo),
      now,
      cliente_id,
    ])

    // 6. Crear movimiento_metodo_cobro por el total del abono
    if (montoTotalUsd.gt(0)) {
      const movMetodoAbonoId = uuidv4()
      await tx.execute(
        `INSERT INTO movimientos_metodo_cobro
           (id, empresa_id, metodo_cobro_id, tipo, origen, monto, saldo_anterior, saldo_nuevo,
            doc_origen_id, doc_origen_ref, concepto, sesion_caja_id, fecha, created_at, created_by)
         VALUES (?, ?, ?, 'INGRESO', 'COBRO', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          movMetodoAbonoId,
          empresa_id,
          metodo_cobro_id,
          toStorageString(montoD),         // monto = nativo (Bs 10.300 o $20.60)
          toStorageString(montoTotalUsd),  // saldo_nuevo = USD equivalente (para lookup)
          movId,
          'ABONO-GLOBAL',
          `Abono global cliente (${facturasAfectadas} fac.)`,
          sesion_caja_id ?? null,
          now,
          now,
          procesado_por,
        ]
      )
    }

    // 7. Resolver banco + movimiento bancario + asientos contables (abono global CxC)
    try {
      const metodoAbonoResult = await tx.execute(
        'SELECT banco_empresa_id, deposito_directo FROM metodos_cobro WHERE id = ? LIMIT 1',
        [metodo_cobro_id]
      )
      const _metodoAbonoRow = metodoAbonoResult.rows?.item(0) as
        | { banco_empresa_id: string | null; deposito_directo: number | null }
        | undefined
      const bancoAbonoId = _metodoAbonoRow?.banco_empresa_id ?? null
      const _depositoDirectoAbono = _metodoAbonoRow?.deposito_directo ?? 0

      if (bancoAbonoId && montoTotalUsd.gt(0) && _depositoDirectoAbono === 1) {
        const movBancoAbonoId = uuidv4()

        const _bancoRow = await tx.execute(
          'SELECT saldo_actual, moneda_id FROM bancos_empresa WHERE id = ? LIMIT 1',
          [bancoAbonoId]
        )
        const _bancoData = _bancoRow.rows?.item(0) as
          | { saldo_actual: string; moneda_id: string }
          | undefined
        const _monedaRow = await tx.execute(
          'SELECT codigo_iso FROM monedas WHERE id = ? LIMIT 1',
          [_bancoData?.moneda_id ?? '']
        )
        const _bancoMonedaCodigo =
          (_monedaRow.rows?.item(0) as { codigo_iso: string } | undefined)?.codigo_iso ?? 'USD'

        const _esBancoBS = _bancoMonedaCodigo === 'VES'
        const _montoNativo = _esBancoBS
          ? (moneda === 'BS' ? monto : usdToBs(montoTotalUsd, tasaD).toNumber())
          : (moneda === 'BS' ? bsToUsd(monto, tasaD).toNumber() : montoTotalUsd.toNumber())

        const _saldoAnt = parseFloat(_bancoData?.saldo_actual ?? '0')
        const _saldoNuevo = _saldoAnt + _montoNativo

        await tx.execute(
          `INSERT INTO movimientos_bancarios
             (id, empresa_id, banco_empresa_id, tipo, origen, monto, saldo_anterior, saldo_nuevo,
              doc_origen_id, doc_origen_tipo, referencia, validado, observacion, fecha, created_at, created_by)
           VALUES (?, ?, ?, 'INGRESO', 'TRANSFERENCIA_CLIENTE', ?, ?, ?, ?, 'PAGO_CXC', ?, 0, ?, ?, ?, ?)`,
          [
            movBancoAbonoId, empresa_id, bancoAbonoId,
            toStorageString(_montoNativo),
            toStorageString(_saldoAnt),
            toStorageString(_saldoNuevo),
            movId,
            referencia ?? null,
            `Abono global cliente`,
            now, now, procesado_por,
          ]
        )

        await tx.execute(
          'UPDATE bancos_empresa SET saldo_actual = ?, updated_at = ? WHERE id = ?',
          [toStorageString(_saldoNuevo), now, bancoAbonoId]
        )
      }

      const [cuentas, monedaContable] = await Promise.all([
        cargarMapaCuentas(tx, empresa_id),
        leerMonedaContable(tx, empresa_id),
      ])
      await generarAsientosPagoCxC(tx, {
        empresaId: empresa_id,
        pagoId: movId,
        pagoRef: 'ABONO-GLOBAL',
        monto_usd: montoTotalUsd.toNumber(),
        banco_empresa_id: bancoAbonoId,
        cuentas,
        usuarioId: procesado_por,
        monedaContable,
        tasaPago: tasa,
        // Sin tasaVenta en abono global FIFO: sin diferencial cambiario por simplificacion
      })
    } catch {
      // Fallo en contabilidad/bancos no bloquea el abono
    }
  })

  return { facturasAfectadas, montoAplicado }
}

export interface AbonoPrestamoParams {
  vencimiento_id: string
  metodo_cobro_id: string
  moneda: 'USD' | 'BS'
  tasa: number
  monto: number
  fechaPago?: string
  referencia?: string
  empresa_id: string
  procesado_por: string
  procesado_por_nombre: string
  sesion_caja_id?: string | null
  // SAF (saldo a favor) params — optional manual credit application
  aplicarSaf?: boolean
  montoSaf?: number
  safOrigenRefs?: string[]
}

/**
 * Abono a un préstamo (vencimiento_cobrar).
 * Actualiza monto_pagado_usd, saldo_pendiente_usd y status del vencimiento.
 * NO afecta ventas.saldo_pend_usd ni clientes.saldo_actual —
 * el préstamo es una deuda independiente de la factura.
 */
export async function registrarAbonoPrestamo(params: AbonoPrestamoParams): Promise<void> {
  const {
    vencimiento_id, metodo_cobro_id, moneda, tasa, monto,
    fechaPago, referencia, empresa_id, procesado_por, sesion_caja_id,
    aplicarSaf, montoSaf, safOrigenRefs,
  } = params

  if (!Number.isFinite(tasa) || tasa <= 0) throw new Error('La tasa de cambio debe ser mayor a 0')
  // monto puede ser 0 cuando SAF cubre todo el saldo del préstamo
  if (!aplicarSaf && (!Number.isFinite(monto) || monto <= 0)) throw new Error('El monto debe ser mayor a 0')
  if (aplicarSaf && (!Number.isFinite(monto) || monto < 0)) throw new Error('El monto no puede ser negativo')

  await db.writeTransaction(async (tx) => {
    const now = localNow()
    const fechaDoc = fechaPago ? `${fechaPago}T00:00:00${VE_OFFSET}` : now

    // 1. Leer el vencimiento
    const vencResult = await tx.execute(
      `SELECT id, saldo_pendiente_usd, monto_pagado_usd, status, venta_id, cliente_id
       FROM vencimientos_cobrar WHERE id = ? AND empresa_id = ?`,
      [vencimiento_id, empresa_id]
    )
    if (!vencResult.rows?.length) throw new Error('Préstamo no encontrado')
    const venc = vencResult.rows.item(0) as {
      id: string
      saldo_pendiente_usd: string
      monto_pagado_usd: string
      status: string
      venta_id: string | null
      cliente_id: string
    }
    if (venc.status === 'PAGADO') throw new Error('Este préstamo ya está completamente pagado')

    const saldoActual = new Decimal(venc.saldo_pendiente_usd || '0')
    const pagadoActual = new Decimal(venc.monto_pagado_usd || '0')
    const tasaD = new Decimal(tasa)
    const montoD = new Decimal(monto)

    // 2. Calcular monto en USD (monto del método de cobro)
    const montoUsd = moneda === 'BS' ? bsToUsd(montoD, tasaD) : montoD
    const montoSafNum = (aplicarSaf && montoSaf && montoSaf > 0) ? new Decimal(montoSaf) : new Decimal(0)

    // 3. Validar que el total (método + SAF) no exceda saldo
    if (montoUsd.plus(montoSafNum).gt(saldoActual.plus(new Decimal('0.01')))) {
      throw new Error(
        `El abono (${toStorageString(montoUsd.plus(montoSafNum))}) excede el saldo pendiente del préstamo ($${toStorageString(saldoActual)})`
      )
    }

    // 3a. SAF pre-step: aplicar crédito del cliente al préstamo
    if (montoSafNum.gt(0)) {
      const clienteSafRes = await tx.execute(
        'SELECT saldo_actual FROM clientes WHERE id = ? LIMIT 1',
        [venc.cliente_id]
      )
      if (!clienteSafRes.rows?.length) throw new Error('Cliente no encontrado')
      const saldoClienteSaf = new Decimal(
        (clienteSafRes.rows.item(0) as { saldo_actual: string }).saldo_actual || '0'
      )
      if (saldoClienteSaf.gte(new Decimal('-0.001'))) throw new Error('El cliente no tiene saldo a favor disponible')
      if (montoSafNum.gt(saldoClienteSaf.abs().plus(new Decimal('0.01')))) {
        throw new Error(`El monto SAF excede el saldo disponible ($${toStorageString(saldoClienteSaf.abs())})`)
      }

      const saldoClienteDespuesSaf = saldoClienteSaf.plus(montoSafNum)
      const safRef = `PREST-${vencimiento_id.slice(0, 8).toUpperCase()}`

      await tx.execute(
        `INSERT INTO movimientos_cuenta
           (id, empresa_id, cliente_id, tipo, referencia, monto, saldo_anterior, saldo_nuevo,
            observacion, venta_id, fecha, created_at, created_by,
            moneda_pago, monto_moneda, tasa_pago, saf_origen_refs)
         VALUES (?, ?, ?, 'SAF', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?)`,
        [
          uuidv4(), empresa_id, venc.cliente_id,
          `SAF-${safRef}`,
          toStorageString(montoSafNum),
          toStorageString(saldoClienteSaf),
          toStorageString(saldoClienteDespuesSaf),
          `Saldo a favor aplicado a préstamo ${safRef}`,
          venc.venta_id,
          fechaDoc, now, procesado_por,
          toStorageString(montoSafNum),
          toStorageString(tasaD),
          safOrigenRefs && safOrigenRefs.length > 0
            ? JSON.stringify(safOrigenRefs)
            : JSON.stringify([safRef]),
        ]
      )

      await tx.execute('UPDATE clientes SET saldo_actual = ?, updated_at = ? WHERE id = ?', [
        toStorageString(saldoClienteDespuesSaf), now, venc.cliente_id,
      ])
    }

    // 4. Nuevos valores del vencimiento (SAF + método)
    const aplicadoTotal = montoUsd.plus(montoSafNum)
    const nuevoSaldo = Decimal.max(new Decimal(0), saldoActual.minus(aplicadoTotal))
    const nuevoPagado = pagadoActual.plus(aplicadoTotal)
    const nuevoStatus = nuevoSaldo.lte(new Decimal('0.005')) ? 'PAGADO' : venc.status

    // 5. Actualizar vencimiento
    await tx.execute(
      `UPDATE vencimientos_cobrar
       SET monto_pagado_usd = ?, saldo_pendiente_usd = ?, status = ?
       WHERE id = ?`,
      [toStorageString(nuevoPagado), toStorageString(nuevoSaldo), nuevoStatus, vencimiento_id]
    )

    // 6. Registrar ingreso en metodo_cobro (solo si hay pago por método)
    if (montoUsd.gt(0)) {
      const movId = uuidv4()
      await tx.execute(
        `INSERT INTO movimientos_metodo_cobro
           (id, empresa_id, metodo_cobro_id, tipo, origen, monto, saldo_anterior, saldo_nuevo,
            doc_origen_id, doc_origen_ref, concepto, sesion_caja_id, fecha, created_at, created_by)
         VALUES (?, ?, ?, 'INGRESO', 'COBRO_PRESTAMO', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          movId, empresa_id, metodo_cobro_id,
          toStorageString(montoUsd),
          toStorageString(saldoActual),
          toStorageString(nuevoSaldo),
          vencimiento_id,
          `PREST-${vencimiento_id.slice(0, 8).toUpperCase()}`,
          `Abono préstamo${referencia ? ` - ${referencia}` : ''}`,
          sesion_caja_id ?? null,
          fechaDoc, now, procesado_por,
        ]
      )
    }

    // 7. Si el préstamo está vinculado a una factura, actualizar también la CxC
    if (venc.venta_id) {
      // 7a. Leer UUID de moneda (solo necesario si hay método de cobro)
      let monedaId: string | null = null
      if (montoUsd.gt(0)) {
        const monedaCode = moneda === 'BS' ? 'VES' : 'USD'
        const monedaResult = await tx.execute(
          'SELECT id FROM monedas WHERE codigo_iso = ? LIMIT 1',
          [monedaCode]
        )
        if (!monedaResult.rows?.length) {
          throw new Error(`No se encontró la moneda ${monedaCode} en el catálogo`)
        }
        monedaId = (monedaResult.rows.item(0) as { id: string }).id
      }

      // 7b. Leer saldo actual de la factura
      const ventaResult = await tx.execute(
        'SELECT saldo_pend_usd FROM ventas WHERE id = ?',
        [venc.venta_id]
      )
      if (ventaResult.rows?.length) {
        const saldoFacturaActual = new Decimal(
          (ventaResult.rows.item(0) as { saldo_pend_usd: string }).saldo_pend_usd || '0'
        )
        // Reducir por el total aplicado: método + SAF
        const nuevoSaldoFactura = Decimal.max(new Decimal(0), saldoFacturaActual.minus(aplicadoTotal))

        // 7c. Registrar pago en tabla pagos (solo si hay pago por método)
        if (montoUsd.gt(0) && monedaId) {
          await tx.execute(
            `INSERT INTO pagos
               (id, venta_id, cliente_id, metodo_cobro_id, moneda_id, tasa, monto, monto_usd,
                referencia, sesion_caja_id, fecha, empresa_id, created_at, created_by, procesado_por_nombre)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              uuidv4(), venc.venta_id, venc.cliente_id, metodo_cobro_id,
              monedaId,
              toStorageString(tasaD),
              toStorageString(montoD), toStorageString(montoUsd),
              referencia ?? null, sesion_caja_id ?? null,
              fechaDoc, empresa_id, now, procesado_por,
              params.procesado_por_nombre ?? null,
            ]
          )
        }

        // 7d. Actualizar saldo pendiente de la factura (total: método + SAF)
        await tx.execute(
          'UPDATE ventas SET saldo_pend_usd = ? WHERE id = ?',
          [toStorageString(nuevoSaldoFactura), venc.venta_id]
        )

        // 7e. Registrar movimiento de cuenta PAG y actualizar saldo cliente (solo por método)
        if (montoUsd.gt(0)) {
          const clienteResult = await tx.execute(
            'SELECT saldo_actual FROM clientes WHERE id = ?',
            [venc.cliente_id]
          )
          if (clienteResult.rows?.length) {
            const saldoClienteActual = new Decimal(
              (clienteResult.rows.item(0) as { saldo_actual: string }).saldo_actual || '0'
            )
            const nuevoSaldoCliente = Decimal.max(new Decimal(0), saldoClienteActual.minus(montoUsd))

            await tx.execute(
              `INSERT INTO movimientos_cuenta
                 (id, empresa_id, cliente_id, tipo, referencia, monto, saldo_anterior, saldo_nuevo,
                  observacion, venta_id, fecha, created_at, created_by, moneda_pago, monto_moneda, tasa_pago)
               VALUES (?, ?, ?, 'PAG', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                uuidv4(), empresa_id, venc.cliente_id,
                `PAG-PREST-${vencimiento_id.slice(0, 8).toUpperCase()}`,
                toStorageString(montoUsd),
                toStorageString(saldoClienteActual),
                toStorageString(nuevoSaldoCliente),
                `Pago préstamo${referencia ? ` - ${referencia}` : ''}`,
                venc.venta_id,
                fechaDoc, now, procesado_por,
                moneda, toStorageString(montoD), toStorageString(tasaD),
              ]
            )

            await tx.execute(
              'UPDATE clientes SET saldo_actual = ?, updated_at = ? WHERE id = ?',
              [toStorageString(nuevoSaldoCliente), now, venc.cliente_id]
            )
          }
        }
      }
    }
  })
}

// ─── Tipos para módulo de préstamos ───────────────────────────

export interface VencimientoPrestamo {
  id: string
  venta_id: string | null
  cliente_nombre: string
  cliente_id: string
  nro_factura: string | null
  nro_cuota: number
  fecha_vencimiento: string
  monto_original_usd: string
  monto_pagado_usd: string
  saldo_pendiente_usd: string
  status: string
  origen_fondos_tipo: string
}

export interface AbonoPrestamo {
  id: string
  monto: string
  saldo_anterior: string   // saldo del préstamo antes del abono
  saldo_nuevo: string      // saldo del préstamo después del abono
  concepto: string
  metodo_nombre: string
  fecha: string
  created_by: string | null
  /** Monto en Bs al tipo de cambio del MOMENTO del registro (no la tasa actual).
   *  Para pagos: monto_usd * tasa_pago.
   *  Para mmc (standalone): monto_usd * tasa histórica de la fecha del movimiento.
   *  Nunca revaluar abonos históricos con la tasa vigente. */
  monto_bs_historico: string | null
}

/**
 * Historial de abonos de un préstamo específico.
 *
 * - Si ventaId != null (préstamo vinculado a factura): usa tabla `pagos`.
 *   Cubre todos los caminos: pago desde CxC (FACTURA tab), pago desde Préstamos (PRESTAMO tab),
 *   y pago desde POS. En todos estos paths se escribe un registro en `pagos`.
 *
 * - Si ventaId == null (préstamo standalone): usa `movimientos_metodo_cobro`
 *   con origen = 'COBRO_PRESTAMO', que es el único registro que escribe registrarAbonoPrestamo.
 */
export function useHistorialPrestamo(
  vencimientoId: string | null,
  ventaId?: string | null
) {
  const usePagos = !!ventaId

  const { data, isLoading } = useQuery(
    usePagos
      ? `SELECT p.id, p.monto_usd as monto,
               '' as saldo_anterior, '' as saldo_nuevo,
               COALESCE(p.referencia, 'Pago registrado') as concepto,
               p.fecha, p.created_by,
               mc.nombre as metodo_nombre,
               CAST(CAST(p.monto_usd AS REAL) * CAST(p.tasa AS REAL) AS TEXT) as monto_bs_historico
         FROM pagos p
         JOIN metodos_cobro mc ON p.metodo_cobro_id = mc.id
         WHERE p.venta_id = ? AND (p.is_reversed IS NULL OR p.is_reversed = 0)
         ORDER BY p.fecha ASC`
      : vencimientoId
        ? `SELECT mmc.id, mmc.monto, mmc.saldo_anterior, mmc.saldo_nuevo,
                 mmc.concepto, mmc.fecha, mmc.created_by,
                 mc.nombre as metodo_nombre,
                 CAST(CAST(mmc.monto AS REAL) * COALESCE(
                   (SELECT CAST(tc.valor AS REAL) FROM tasas_cambio tc
                    WHERE DATE(tc.fecha) <= DATE(mmc.fecha)
                    ORDER BY tc.fecha DESC, tc.created_at DESC LIMIT 1),
                   1.0
                 ) AS TEXT) as monto_bs_historico
           FROM movimientos_metodo_cobro mmc
           JOIN metodos_cobro mc ON mmc.metodo_cobro_id = mc.id
           WHERE mmc.doc_origen_id = ? AND mmc.origen = 'COBRO_PRESTAMO'
           ORDER BY mmc.fecha ASC`
        : '',
    usePagos ? [ventaId] : vencimientoId ? [vencimientoId] : []
  )
  return { historial: (data ?? []) as AbonoPrestamo[], isLoading }
}

/**
 * Reverso de un abono/pago.
 * Marca el pago como reversado, restaura el saldo de la factura
 * y del cliente, e inserta un movimiento_cuenta tipo REV.
 */
export async function registrarReversoAbono(params: {
  pago_id: string
  reason: string
  reversed_by: string
  reversed_by_nombre: string
  empresa_id: string
}): Promise<void> {
  const { pago_id, reason, reversed_by, reversed_by_nombre, empresa_id } = params

  if (!reason.trim()) throw new Error('Debe ingresar una razon para el reverso')

  await db.writeTransaction(async (tx) => {
    const now = localNow()

    // 1. Leer el pago original
    const pagoResult = await tx.execute(
      `SELECT id, venta_id, cliente_id, monto_usd, is_reversed, tasa, monto, moneda_id FROM pagos WHERE id = ? AND empresa_id = ?`,
      [pago_id, empresa_id]
    )
    if (!pagoResult.rows || pagoResult.rows.length === 0) {
      throw new Error('Pago no encontrado')
    }
    const pago = pagoResult.rows.item(0) as {
      id: string
      venta_id: string | null
      cliente_id: string
      monto_usd: string
      is_reversed: number
      tasa: string | null
      monto: string | null
      moneda_id: string | null
    }

    if (pago.is_reversed === 1) {
      throw new Error('Este pago ya fue reversado anteriormente')
    }

    const montoUsd = new Decimal(pago.monto_usd || '0')

    // 2. Marcar el pago como reversado
    await tx.execute(
      `UPDATE pagos SET is_reversed = 1, reversed_at = ?, reversed_by = ?, reversed_reason = ? WHERE id = ?`,
      [now, reversed_by, reason.trim(), pago_id]
    )

    // 3. Si tiene factura: restaurar saldo_pend_usd
    let nroFactura = ''
    if (pago.venta_id) {
      const ventaResult = await tx.execute(
        `SELECT nro_factura, saldo_pend_usd, total_usd FROM ventas WHERE id = ?`,
        [pago.venta_id]
      )
      if (ventaResult.rows && ventaResult.rows.length > 0) {
        const venta = ventaResult.rows.item(0) as {
          nro_factura: string
          saldo_pend_usd: string
          total_usd: string
        }
        nroFactura = venta.nro_factura
        const saldoPendActual = new Decimal(venta.saldo_pend_usd || '0')
        const totalFactura = new Decimal(venta.total_usd || '0')
        const nuevoSaldoFactura = Decimal.min(totalFactura, saldoPendActual.plus(montoUsd))
        await tx.execute(`UPDATE ventas SET saldo_pend_usd = ? WHERE id = ?`, [
          toStorageString(nuevoSaldoFactura),
          pago.venta_id,
        ])
      }
    }

    // 4. Restaurar saldo del cliente
    const clienteResult = await tx.execute(
      `SELECT saldo_actual FROM clientes WHERE id = ?`,
      [pago.cliente_id]
    )
    if (!clienteResult.rows || clienteResult.rows.length === 0) {
      throw new Error('Cliente no encontrado')
    }
    const saldoActual = new Decimal(
      (clienteResult.rows.item(0) as { saldo_actual: string }).saldo_actual || '0'
    )
    const saldoNuevo = saldoActual.plus(montoUsd)

    await tx.execute(`UPDATE clientes SET saldo_actual = ?, updated_at = ? WHERE id = ?`, [
      toStorageString(saldoNuevo),
      now,
      pago.cliente_id,
    ])

    // 5. Insertar movimiento_cuenta tipo REV
    // Resolver moneda label desde moneda_id del pago original
    let monedaPagoLabel: string | null = null
    if (pago.moneda_id) {
      const monedaResult = await tx.execute(
        `SELECT codigo FROM monedas WHERE id = ? LIMIT 1`,
        [pago.moneda_id]
      )
      const codigoMoneda = (monedaResult.rows?.item(0) as { codigo: string } | undefined)?.codigo
      if (codigoMoneda === 'VES') {
        monedaPagoLabel = 'BS'
      } else if (codigoMoneda) {
        monedaPagoLabel = codigoMoneda
      }
    }

    const movId = uuidv4()
    const referencia = nroFactura ? `REV-${nroFactura}` : 'REV-ABONO'
    await tx.execute(
      `INSERT INTO movimientos_cuenta (id, cliente_id, tipo, referencia, monto, saldo_anterior, saldo_nuevo, observacion, venta_id, fecha, empresa_id, created_at, created_by, moneda_pago, monto_moneda, tasa_pago)
       VALUES (?, ?, 'REV', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        movId,
        pago.cliente_id,
        referencia,
        toStorageString(montoUsd),
        toStorageString(saldoActual),
        toStorageString(saldoNuevo),
        `Reverso de abono${nroFactura ? ` factura ${nroFactura}` : ''}: ${reason.trim()} (por ${reversed_by_nombre})`,
        pago.venta_id ?? null,
        now,
        empresa_id,
        now,
        reversed_by,
        monedaPagoLabel,
        pago.monto != null ? toStorageString(new Decimal(pago.monto)) : null,
        pago.tasa != null ? toStorageString(new Decimal(pago.tasa)) : null,
      ]
    )

    // 6. Reversar asientos contables del pago original (crea contra-asientos)
    try {
      const asientosResult = await tx.execute(
        `SELECT id FROM libro_contable WHERE empresa_id = ? AND doc_origen_id = ? AND modulo_origen = 'PAGO_CXC' AND estado = 'PENDIENTE'`,
        [empresa_id, pago_id]
      )
      const asientosIds: string[] = []
      if (asientosResult.rows) {
        for (let i = 0; i < asientosResult.rows.length; i++) {
          asientosIds.push((asientosResult.rows.item(i) as { id: string }).id)
        }
      }
      if (asientosIds.length > 0) {
        await reversarAsientos(tx, {
          empresaId: empresa_id,
          asientosIds,
          usuarioId: reversed_by,
        })
      }
    } catch {
      // Fallo en contabilidad no bloquea el reverso
    }
  })
}

// ─── Aplicar Saldo a Favor (SAF) ──────────────────────────────

export interface AplicarSaldoFavorParams {
  clienteId: string
  empresaId: string
  cajeroId: string
  tasa: number
  facturas: Array<{ ventaId: string; nroFactura: string; montoAplicarUsd: number }>
  totalAplicadoUsd: number
}

/**
 * Aplica el saldo a favor de un cliente (saldo_actual negativo) a sus facturas pendientes.
 * Crea un movimiento_cuenta tipo 'SAF' por cada factura afectada.
 * Reduce ventas.saldo_pend_usd y actualiza clientes.saldo_actual.
 * Todo en una sola transacción atómica.
 */
export async function aplicarSaldoFavor(params: AplicarSaldoFavorParams): Promise<void> {
  const { clienteId, empresaId, cajeroId, tasa, facturas, totalAplicadoUsd } = params

  if (!Number.isFinite(totalAplicadoUsd) || totalAplicadoUsd <= 0) throw new Error('El monto a aplicar debe ser mayor a 0')
  if (facturas.length === 0) throw new Error('Debe seleccionar al menos una factura')
  if (!Number.isFinite(tasa) || tasa <= 0) throw new Error('La tasa de cambio debe ser mayor a 0')

  await db.writeTransaction(async (tx) => {
    const now = localNow()

    // 1. Validar que el cliente tenga crédito SAF disponible.
    // saldo_actual sigue siendo la fuente del ledger crudo (para
    // saldo_anterior/saldo_nuevo mas abajo), pero el GATE de validacion usa
    // la fuente confiable SUM(SAFC)-SUM(SAF) — saldo_actual mezcla deuda y
    // credito y puede leer casi-cero con credito real disponible. Ver
    // design.md Decision 1/3.
    const clienteResult = await tx.execute(
      'SELECT saldo_actual FROM clientes WHERE id = ? AND empresa_id = ?',
      [clienteId, empresaId]
    )
    if (!clienteResult.rows?.length) {
      throw new Error('Cliente no encontrado')
    }
    const saldoActualInit = new Decimal(
      (clienteResult.rows.item(0) as { saldo_actual: string }).saldo_actual || '0'
    )
    const tasaD = new Decimal(tasa)
    const totalAplicadoD = new Decimal(totalAplicadoUsd)

    const creditoResult = await tx.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN tipo = 'SAFC' THEN CAST(monto AS REAL) ELSE 0 END), 0) as creado,
         COALESCE(SUM(CASE WHEN tipo = 'SAF' THEN CAST(monto AS REAL) ELSE 0 END), 0) as consumido
       FROM movimientos_cuenta WHERE cliente_id = ? AND empresa_id = ?`,
      [clienteId, empresaId]
    )
    const creditoRow = creditoResult.rows?.item(0) as { creado: number; consumido: number } | undefined
    const creditoDisponible = calcularCreditoDisponible(creditoRow?.creado ?? 0, creditoRow?.consumido ?? 0)

    if (creditoDisponible.lte('0.001')) {
      throw new Error('El cliente no tiene saldo a favor disponible')
    }

    // 2. Validar que el total a aplicar no exceda el crédito disponible
    if (totalAplicadoD.gt(creditoDisponible.plus(new Decimal('0.01')))) {
      throw new Error(
        `El monto a aplicar ($${toStorageString(totalAplicadoD)}) excede el crédito disponible ($${toStorageString(creditoDisponible)})`
      )
    }

    // 3. Procesar cada factura
    let saldoActual = saldoActualInit

    for (const factura of facturas) {
      if (factura.montoAplicarUsd <= 0) continue

      const montoAplicarD = new Decimal(factura.montoAplicarUsd)

      // a. Leer saldo pendiente actual de la factura
      const ventaResult = await tx.execute(
        'SELECT saldo_pend_usd FROM ventas WHERE id = ? AND empresa_id = ?',
        [factura.ventaId, empresaId]
      )
      if (!ventaResult.rows?.length) {
        throw new Error(`Factura #${factura.nroFactura} no encontrada`)
      }
      const saldoPendUsd = new Decimal(
        (ventaResult.rows.item(0) as { saldo_pend_usd: string }).saldo_pend_usd || '0'
      )

      // b. Calcular nuevo pendiente
      const nuevoPendiente = Decimal.max(new Decimal(0), saldoPendUsd.minus(montoAplicarD))

      // c. Reducir saldo pendiente de la factura
      await tx.execute(
        'UPDATE ventas SET saldo_pend_usd = ? WHERE id = ?',
        [toStorageString(nuevoPendiente), factura.ventaId]
      )

      // d. Insertar movimiento_cuenta tipo SAF
      const saldoAntes = saldoActual
      const saldoDespues = saldoActual.plus(montoAplicarD)

      const movId = uuidv4()
      await tx.execute(
        `INSERT INTO movimientos_cuenta (id, cliente_id, tipo, referencia, monto, saldo_anterior, saldo_nuevo, observacion, venta_id, fecha, empresa_id, created_at, created_by, moneda_pago, monto_moneda, tasa_pago)
         VALUES (?, ?, 'SAF', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          movId,
          clienteId,
          `SAF-CXC-${factura.nroFactura}`,
          toStorageString(montoAplicarD),
          toStorageString(saldoAntes),
          toStorageString(saldoDespues),
          `Saldo a favor aplicado a factura ${factura.nroFactura}`,
          factura.ventaId,
          now,
          empresaId,
          now,
          cajeroId,
          'USD',
          toStorageString(montoAplicarD),
          toStorageString(tasaD),
        ]
      )

      saldoActual = saldoDespues
    }

    // 4. Actualizar saldo del cliente
    await tx.execute(
      'UPDATE clientes SET saldo_actual = ?, updated_at = ? WHERE id = ?',
      [toStorageString(saldoActual), now, clienteId]
    )
  })
}

// ─── Préstamo standalone (sin venta) ──────────────────────────

export interface CrearPrestamoStandaloneParams {
  clienteId: string
  empresaId: string
  montoPrestamoUsd: number
  montoPrestamoBs: number
  tasaActual: number
  porcentajeInteres: number
  diasPlazo: number
  concepto: string
  origenFondos: 'CAJA' | 'EFECTIVO_EMPRESA' | 'BANCO'
  sesionCajaId: string | null
  usuarioId: string
}

/**
 * Crea un préstamo sin factura asociada directamente desde el módulo de préstamos.
 * Si origenFondos = 'CAJA': descuenta el efectivo de la sesión activa.
 * Si origenFondos != 'CAJA': registra solo el vencimiento (stub bancario).
 * NO afecta ventas.saldo_pend_usd ni clientes.saldo_actual.
 */
export async function crearPrestamoStandalone(
  params: CrearPrestamoStandaloneParams
): Promise<void> {
  const {
    clienteId, empresaId, montoPrestamoUsd, montoPrestamoBs, tasaActual,
    porcentajeInteres, diasPlazo, concepto, origenFondos, sesionCajaId, usuarioId,
  } = params

  if (montoPrestamoUsd <= 0 && montoPrestamoBs <= 0) {
    throw new Error('Ingresa al menos un monto mayor a 0')
  }
  if (origenFondos === 'CAJA' && !sesionCajaId) {
    throw new Error('No hay sesion de caja activa. Selecciona otro origen de fondos.')
  }

  await db.writeTransaction(async (tx) => {
    const now = localNow()

    const tasaD = new Decimal(tasaActual)
    const montoUsdD = new Decimal(montoPrestamoUsd)
    const montoBsD = new Decimal(montoPrestamoBs)

    // Calcular montos
    const bsEnUsd = tasaD.gt(0) ? bsToUsd(montoBsD, tasaD) : new Decimal(0)
    const principalUsd = montoUsdD.plus(bsEnUsd)
    const interesUsd = principalUsd.times(new Decimal(porcentajeInteres)).dividedBy(100)
    const totalDeudaUsd = principalUsd.plus(interesUsd)

    // Fecha de vencimiento
    const fechaVencimiento = daysFromNow(diasPlazo)

    // Egreso de caja (solo si origen = CAJA)
    if (origenFondos === 'CAJA') {
      if (montoPrestamoUsd > 0) {
        const r = await tx.execute(
          `SELECT mc.id, mc.saldo_actual FROM metodos_cobro mc
           JOIN monedas mo ON mc.moneda_id = mo.id
           WHERE mc.empresa_id = ? AND mc.tipo = 'EFECTIVO' AND mo.codigo_iso = 'USD' AND mc.is_active = 1
           LIMIT 1`,
          [empresaId]
        )
        if (!r.rows?.length) throw new Error('No hay metodo EFECTIVO en USD configurado')
        const m = r.rows.item(0) as { id: string; saldo_actual: string }
        const saldo = new Decimal(m.saldo_actual || '0')
        if (saldo.lt(montoUsdD)) {
          throw new Error(
            `Saldo insuficiente en USD. Disponible: ${toStorageString(saldo)}, Solicitado: ${toStorageString(montoUsdD)}`
          )
        }
        const nuevoSaldo = saldo.minus(montoUsdD)
        await tx.execute(
          `INSERT INTO movimientos_metodo_cobro
             (id, empresa_id, metodo_cobro_id, tipo, origen, monto, saldo_anterior, saldo_nuevo,
              doc_origen_id, doc_origen_ref, concepto, sesion_caja_id, fecha, created_at, created_by)
           VALUES (?, ?, ?, 'EGRESO', 'PRESTAMO', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
          [
            uuidv4(), empresaId, m.id,
            toStorageString(montoUsdD), toStorageString(saldo), toStorageString(nuevoSaldo),
            concepto.trim(), sesionCajaId, now, now, usuarioId,
          ]
        )
        await tx.execute(
          'UPDATE metodos_cobro SET saldo_actual = ?, updated_at = ? WHERE id = ?',
          [toStorageString(nuevoSaldo), now, m.id]
        )
      }

      if (montoPrestamoBs > 0) {
        const r = await tx.execute(
          `SELECT mc.id, mc.saldo_actual FROM metodos_cobro mc
           JOIN monedas mo ON mc.moneda_id = mo.id
           WHERE mc.empresa_id = ? AND mc.tipo = 'EFECTIVO' AND mo.codigo_iso = 'VES' AND mc.is_active = 1
           LIMIT 1`,
          [empresaId]
        )
        if (!r.rows?.length) throw new Error('No hay metodo EFECTIVO en Bs configurado')
        const m = r.rows.item(0) as { id: string; saldo_actual: string }
        const saldo = new Decimal(m.saldo_actual || '0')
        if (saldo.lt(montoBsD)) {
          throw new Error(
            `Saldo insuficiente en Bs. Disponible: ${toStorageString(saldo)}, Solicitado: ${toStorageString(montoBsD)}`
          )
        }
        const nuevoSaldo = saldo.minus(montoBsD)
        await tx.execute(
          `INSERT INTO movimientos_metodo_cobro
             (id, empresa_id, metodo_cobro_id, tipo, origen, monto, saldo_anterior, saldo_nuevo,
              doc_origen_id, doc_origen_ref, concepto, sesion_caja_id, fecha, created_at, created_by)
           VALUES (?, ?, ?, 'EGRESO', 'PRESTAMO', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
          [
            uuidv4(), empresaId, m.id,
            toStorageString(montoBsD), toStorageString(saldo), toStorageString(nuevoSaldo),
            concepto.trim(), sesionCajaId, now, now, usuarioId,
          ]
        )
        await tx.execute(
          'UPDATE metodos_cobro SET saldo_actual = ?, updated_at = ? WHERE id = ?',
          [toStorageString(nuevoSaldo), now, m.id]
        )
      }
    }

    // Crear vencimiento_cobrar (venta_id = NULL = standalone)
    await tx.execute(
      `INSERT INTO vencimientos_cobrar
         (id, empresa_id, venta_id, cliente_id, nro_cuota, fecha_vencimiento,
          monto_original_usd, monto_pagado_usd, saldo_pendiente_usd, status,
          origen_fondos_tipo, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 1, ?, ?, '0.00', ?, 'PENDIENTE', ?, ?, ?)`,
      [
        uuidv4(), empresaId, clienteId,
        fechaVencimiento,
        toStorageString(totalDeudaUsd),
        toStorageString(totalDeudaUsd),
        origenFondos,
        now, now,
      ]
    )
  })
}

// ─── Discrepancia de pago CxC (VUELTO / PROPINA) ──────────────

export interface RegistrarDiscrepanciaCxCParams {
  metodo_cobro_id: string
  tipo: 'VUELTO' | 'PROPINA'
  monto: number        // en moneda original (USD o BS)
  moneda: 'USD' | 'BS'
  tasa: number
  empresa_id: string
  doc_origen_id: string    // venta_id
  doc_origen_ref: string   // nro_factura
  referencia?: string
  procesado_por: string
}

/**
 * Registra el excedente de un pago CxC como VUELTO (EGRESO) o PROPINA (INGRESO)
 * en movimientos_metodo_cobro. Se llama DESPUÉS de registrarPagoFactura con el saldo exacto.
 */
export async function registrarDiscrepanciaCxC(params: RegistrarDiscrepanciaCxCParams): Promise<void> {
  const { metodo_cobro_id, tipo, monto, moneda, tasa, empresa_id, doc_origen_id, doc_origen_ref, procesado_por } = params

  if (!Number.isFinite(monto) || monto <= 0) return   // nada que registrar

  const montoD = new Decimal(monto)
  const tasaD = new Decimal(tasa)
  const montoUsd = moneda === 'BS' ? bsToUsd(montoD, tasaD) : montoD
  const tipoMov = tipo === 'VUELTO' ? 'EGRESO' : 'INGRESO'
  const concepto = tipo === 'VUELTO'
    ? `Vuelto fac. ${doc_origen_ref}`
    : `Propina fac. ${doc_origen_ref}`
  const now = localNow()

  await db.execute(
    `INSERT INTO movimientos_metodo_cobro
       (id, empresa_id, metodo_cobro_id, tipo, origen, monto, saldo_anterior, saldo_nuevo,
        doc_origen_id, doc_origen_ref, concepto, sesion_caja_id, fecha, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, NULL, ?, ?, ?)`,
    [
      uuidv4(), empresa_id, metodo_cobro_id,
      tipoMov, tipo,
      toStorageString(montoUsd),
      doc_origen_id, `PAG-${doc_origen_ref}`,
      concepto,
      now, now, procesado_por,
    ]
  )
}

// ─── SAF desde pago CxC — registra excedente como crédito al cliente ──

export interface RegistrarSafExcedenteParams {
  cliente_id: string
  venta_id: string
  nro_factura: string
  excedenteUsd: number
  tasa: number
  empresa_id: string
  procesado_por: string
  safOrigenRefs?: string[]
}

/**
 * Registra el excedente de un pago CxC como saldo a favor (crédito) en el cliente.
 * Crea un movimiento_cuenta tipo 'SAFC' (creación de crédito) que deja el
 * saldo_actual negativo. Se llama DESPUÉS de registrarPagoFactura con el
 * saldo exacto. Usa 'SAFC' (no 'SAF') para que la lectura derivada
 * SUM(SAFC)-SUM(SAF) en useClientesConDeuda/useSaldoAFavor cuente esto como
 * creación de crédito, no como consumo — ver design.md Decision 1/2.
 */
export async function registrarSafExcedente(params: RegistrarSafExcedenteParams): Promise<void> {
  const { cliente_id, venta_id, nro_factura, excedenteUsd, tasa, empresa_id, procesado_por, safOrigenRefs } = params

  if (!Number.isFinite(excedenteUsd) || excedenteUsd <= 0.001) return

  await db.writeTransaction(async (tx) => {
    const now = localNow()

    // Leer saldo actual del cliente
    const clienteResult = await tx.execute('SELECT saldo_actual FROM clientes WHERE id = ?', [cliente_id])
    if (!clienteResult.rows?.length) throw new Error('Cliente no encontrado')
    const excedenteD = new Decimal(excedenteUsd)
    const tasaD = new Decimal(tasa)
    const saldoActual = new Decimal((clienteResult.rows.item(0) as { saldo_actual: string }).saldo_actual || '0')

    // El excedente que el cliente pagó de más queda como crédito (saldo negativo)
    const saldoNuevo = saldoActual.minus(excedenteD)

    await tx.execute(
      `INSERT INTO movimientos_cuenta
         (id, cliente_id, tipo, referencia, monto, saldo_anterior, saldo_nuevo,
          observacion, venta_id, fecha, empresa_id, created_at, created_by,
          moneda_pago, monto_moneda, tasa_pago, saf_origen_refs)
       VALUES (?, ?, 'SAFC', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?)`,
      [
        uuidv4(), cliente_id,
        `SAF-CXC-${nro_factura}`,
        toStorageString(excedenteD),
        toStorageString(saldoActual), toStorageString(saldoNuevo),
        `Saldo a favor generado en pago de factura ${nro_factura}`,
        venta_id, now, empresa_id, now, procesado_por,
        toStorageString(excedenteD), toStorageString(tasaD),
        safOrigenRefs && safOrigenRefs.length > 0
          ? JSON.stringify(safOrigenRefs)
          : JSON.stringify([nro_factura]),
      ]
    )

    await tx.execute('UPDATE clientes SET saldo_actual = ?, updated_at = ? WHERE id = ?', [
      toStorageString(saldoNuevo), now, cliente_id,
    ])
  })
}

// ─── Diferencial cambiario CxC ───────────────────────────────

export interface DiferencialCxCParams {
  ventaId: string
  clienteId: string
  empresaId: string
  procesadoPor: string
  tasa: number  // para calcular el equivalente en Bs
}

/**
 * Registrar el saldo residual sub-centavo de una factura de venta como
 * diferencial cambiario. Crea un abono de sistema (sin movimiento bancario)
 * que cierra la factura y reduce el saldo del cliente.
 * Solo aplica cuando ventas.saldo_pend_usd > 0 y < $0.01.
 */
export interface ReversoDiferencialCxCParams {
  ventaId: string
  clienteId: string
  nroFactura: string
  empresaId: string
  procesadoPor: string
}

/**
 * Lógica core del reverso de diferencial cambiario — reutilizable dentro de
 * una writeTransaction existente (ej: anulación NCR) o desde la propia función standalone.
 */
export async function reversarDiferencialEnTx(
  tx: Transaction,
  params: ReversoDiferencialCxCParams,
  now: string
): Promise<void> {
  const { ventaId, clienteId, nroFactura, empresaId, procesadoPor } = params
  const refDife = `DIFE-${nroFactura}`
  const refRev  = `REV-DIFE-${nroFactura}`

  // 1. Buscar el movimiento DIFE original
  const difeRes = await tx.execute(
    `SELECT id, monto FROM movimientos_cuenta
     WHERE venta_id = ? AND referencia = ? AND tipo = 'PAG'
     LIMIT 1`,
    [ventaId, refDife]
  )
  if (!difeRes.rows?.length) return  // No hay diferencial para este venta — no es error

  const dife = difeRes.rows.item(0) as { id: string; monto: string }
  const montoUsd = new Decimal(dife.monto || '0')
  if (montoUsd.lte(0)) return

  // 2. Verificar que no esté ya reversado
  const revExistsRes = await tx.execute(
    `SELECT id FROM movimientos_cuenta WHERE venta_id = ? AND referencia = ? LIMIT 1`,
    [ventaId, refRev]
  )
  if (revExistsRes.rows?.length) return  // Ya reversado — silencioso

  // 3. Leer saldo actual del cliente
  const clienteRes = await tx.execute(
    'SELECT saldo_actual FROM clientes WHERE id = ? AND empresa_id = ?',
    [clienteId, empresaId]
  )
  if (!clienteRes.rows?.length) throw new Error('Cliente no encontrado')
  const saldoActual = new Decimal(
    (clienteRes.rows.item(0) as { saldo_actual: string }).saldo_actual || '0'
  )
  const saldoNuevo = saldoActual.plus(montoUsd)

  // 4. Insertar movimiento REV (movimientos_cuenta es inmutable — no se puede editar el original)
  await tx.execute(
    `INSERT INTO movimientos_cuenta
       (id, empresa_id, cliente_id, tipo, referencia, monto, saldo_anterior, saldo_nuevo,
        observacion, venta_id, fecha, created_at, created_by, moneda_pago, monto_moneda, tasa_pago)
     VALUES (?, ?, ?, 'REV', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, '1')`,
    [
      uuidv4(), empresaId, clienteId,
      refRev,
      toStorageString(montoUsd),
      toStorageString(saldoActual),
      toStorageString(saldoNuevo),
      `Reverso diferencial cambiario — Factura ${nroFactura}`,
      ventaId, now, now, procesadoPor,
      toStorageString(montoUsd),
    ]
  )

  // 5. Restaurar saldo_pend_usd en la factura (ventas no tiene updated_at)
  await tx.execute(
    'UPDATE ventas SET saldo_pend_usd = ? WHERE id = ?',
    [toStorageString(montoUsd), ventaId]
  )

  // 6. Actualizar saldo cliente en SQLite local
  await tx.execute(
    'UPDATE clientes SET saldo_actual = ?, updated_at = ? WHERE id = ?',
    [toStorageString(saldoNuevo), now, clienteId]
  )
}

/**
 * Reversa un diferencial cambiario registrado vía registrarDiferencialCxC.
 * Wrapper standalone que abre su propia writeTransaction.
 */
export async function registrarReversoDiferencialCxC(
  params: ReversoDiferencialCxCParams
): Promise<void> {
  await db.writeTransaction(async (tx) => {
    const now = localNow()
    const refDife = `DIFE-${params.nroFactura}`
    // Re-check for existing DIFE before delegating (to give user-facing error)
    const difeRes = await tx.execute(
      `SELECT id FROM movimientos_cuenta WHERE venta_id = ? AND referencia = ? AND tipo = 'PAG' LIMIT 1`,
      [params.ventaId, refDife]
    )
    if (!difeRes.rows?.length) {
      throw new Error(`No se encontró el movimiento diferencial para la factura ${params.nroFactura}`)
    }
    const refRev = `REV-DIFE-${params.nroFactura}`
    const revExists = await tx.execute(
      `SELECT id FROM movimientos_cuenta WHERE venta_id = ? AND referencia = ? LIMIT 1`,
      [params.ventaId, refRev]
    )
    if (revExists.rows?.length) {
      throw new Error('El diferencial cambiario ya fue reversado')
    }
    await reversarDiferencialEnTx(tx, params, now)
  })
}

export async function registrarDiferencialCxC(params: DiferencialCxCParams): Promise<void> {
  const { ventaId, clienteId, empresaId, procesadoPor, tasa } = params

  await db.writeTransaction(async (tx) => {
    const now = localNow()

    // 1. Leer factura
    const ventaResult = await tx.execute(
      'SELECT nro_factura, saldo_pend_usd FROM ventas WHERE id = ? AND empresa_id = ?',
      [ventaId, empresaId]
    )
    if (!ventaResult.rows?.length) throw new Error('Factura no encontrada')
    const venta = ventaResult.rows.item(0) as { nro_factura: string; saldo_pend_usd: string }
    const saldoUsd = new Decimal(venta.saldo_pend_usd || '0')

    if (saldoUsd.lte(0)) {
      // Factura ya saldada en DB — puede ocurrir si un pago exacto disparó un
      // microBalance falso por imprecisión de float en JS; no hay nada que registrar.
      return
    }
    if (saldoUsd.gte(new Decimal('0.01'))) {
      throw new Error('El diferencial cambiario solo aplica para saldos sub-centavo (< $0.01)')
    }

    // 2. Leer saldo actual del cliente
    const clienteResult = await tx.execute(
      'SELECT saldo_actual FROM clientes WHERE id = ? AND empresa_id = ?',
      [clienteId, empresaId]
    )
    if (!clienteResult.rows?.length) throw new Error('Cliente no encontrado')
    const saldoActual = new Decimal(
      (clienteResult.rows.item(0) as { saldo_actual: string }).saldo_actual || '0'
    )
    const saldoNuevo = Decimal.max(new Decimal(0), saldoActual.minus(saldoUsd))

    const dTasa = new Decimal(tasa)
    const saldoBs = saldoUsd.times(dTasa)

    // 3. Movimiento de cuenta (abono de sistema — sin metodo de cobro real)
    await tx.execute(
      `INSERT INTO movimientos_cuenta
         (id, cliente_id, tipo, referencia, monto, saldo_anterior, saldo_nuevo,
          observacion, venta_id, fecha, empresa_id, created_at, created_by,
          moneda_pago, monto_moneda, tasa_pago)
       VALUES (?, ?, 'PAG', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BS', ?, ?)`,
      [
        uuidv4(), clienteId,
        `DIFE-${venta.nro_factura}`,
        toStorageString(saldoUsd),
        toStorageString(saldoActual),
        toStorageString(saldoNuevo),
        `Diferencial cambiario - Factura ${venta.nro_factura}`,
        ventaId, now, empresaId, now, procesadoPor,
        toStorageString(saldoBs),
        toStorageString(dTasa),
      ]
    )

    // 4. Cerrar la factura (ventas no tiene updated_at)
    await tx.execute(
      'UPDATE ventas SET saldo_pend_usd = ? WHERE id = ?',
      [toStorageString(new Decimal(0)), ventaId]
    )

    // 5. Actualizar saldo cliente en SQLite local inmediatamente
    // (En Supabase el trigger actualizar_saldo_cliente lo gestiona via movimientos_cuenta)
    await tx.execute(
      'UPDATE clientes SET saldo_actual = ?, updated_at = ? WHERE id = ?',
      [toStorageString(saldoNuevo), now, clienteId]
    )

    // 6. Registrar gasto de diferencial cambiario en el libro de gastos
    try {
      const monedaUsdRes = await tx.execute(
        `SELECT id FROM monedas WHERE codigo_iso = 'USD' LIMIT 1`
      )
      const monedaUsdId = (monedaUsdRes.rows?.item(0) as { id: string } | undefined)?.id ?? ''

      // Cuenta contable: intentar PERDIDA_DIFERENCIAL_CAMBIARIO, fallback a gastos_generales
      const cuentaDiffRes = await tx.execute(
        `SELECT cuenta_contable_id FROM cuentas_config
         WHERE empresa_id = ? AND clave = 'PERDIDA_DIFERENCIAL_CAMBIARIO' LIMIT 1`,
        [empresaId]
      )
      let cuentaDiffId = (
        cuentaDiffRes.rows?.item(0) as { cuenta_contable_id: string } | undefined
      )?.cuenta_contable_id ?? ''
      if (!cuentaDiffId) {
        const fallbackRes = await tx.execute(
          `SELECT cuenta_contable_id FROM cuentas_config
           WHERE empresa_id = ? AND clave = 'gastos_generales' LIMIT 1`,
          [empresaId]
        )
        cuentaDiffId = (
          fallbackRes.rows?.item(0) as { cuenta_contable_id: string } | undefined
        )?.cuenta_contable_id ?? ''
      }
      if (!cuentaDiffId || !monedaUsdId) throw new Error('sin-cuenta')

      const nroGastoDiff = `CXC-DIFF-${ventaId.slice(0, 8).toUpperCase()}`
      const obsDiff = `Diferencial cambiario CxC. Fac. ${venta.nro_factura}. Procesado por: ${procesadoPor}`

      await tx.execute(
        `INSERT INTO gastos
           (id, empresa_id, nro_gasto, nro_factura, cuenta_id, descripcion, fecha,
            moneda_id, moneda_factura, usa_tasa_paralela, tasa, monto_factura, monto_usd,
            tipo_impuesto, porcentaje_iva, base_imponible_usd, monto_iva_usd,
            saldo_pendiente_usd, observaciones, status, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'DIFERENCIAL_CAMBIARIO_CXC', ?,
                 ?, 'USD', 0, ?, ?, ?,
                 'Exento', '0.00', ?, '0.00',
                 '0.00', ?, 'REGISTRADO', ?, ?, ?)`,
        [
          uuidv4(), empresaId, nroGastoDiff, venta.nro_factura, cuentaDiffId,
          todayStr(), monedaUsdId,
          toStorageString(dTasa),
          toStorageString(saldoUsd),
          toStorageString(saldoUsd),
          toStorageString(saldoUsd),
          obsDiff, now, now, procesadoPor,
        ]
      )
    } catch {
      // El gasto es opcional — no bloquea el diferencial
      console.warn('⚠️ DIFERENCIAL_CXC: fallo al registrar gasto para factura', venta.nro_factura)
    }
  })
}
