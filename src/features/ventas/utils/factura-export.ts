import Decimal from 'decimal.js'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { applyImpuesto, formatBs, formatUsd, usdToBs, type DecimalInput } from '@/lib/currency'
import { formatDateTime } from '@/lib/format'
import {
  agruparPagosPorMetodo,
  construirCierreRecibo,
  formatearFacturasAplicadas,
  wrapCanvasText,
  type ReciboPagoInput,
  type ReciboPagoLinea,
  type ReciboCierre,
  type ReciboDiscrepancyInput,
} from './recibo-pagos'

// =============================================
// TYPES
// =============================================

export type TipoImpuestoLinea = 'Gravable' | 'Exento' | 'Exonerado'

/** Moneda en la que se presentan primero los montos del recibo (config por empresa). */
export type MonedaPresentacion = 'USD' | 'BS'

export interface ReciboLinea {
  codigo: string
  nombre: string
  esExento: boolean
  cantidad: number
  precioUnitarioUsd: number
  precioUnitarioBs: number
  totalUsd: number
  totalBs: number
}

export interface ReciboAlicuota {
  pct: number
  baseUsd: number
  ivaUsd: number
  ivaBs: number
}

export interface ReciboTotales {
  montoExentoUsd: number
  montoExentoBs: number
  baseImponibleUsd: number
  baseImponibleBs: number
  alicuotas: ReciboAlicuota[]
  igtfUsd: number | null
  igtfBs: number | null
  /** Subtotal de factura SIN IGTF (exento + base imponible + iva total). */
  totalFacturaUsd: number
  totalFacturaBs: number
  totalGeneralUsd: number
  totalGeneralBs: number
}

export interface ReciboParte {
  nombre: string
  rif: string | null
  direccion: string | null
}

export interface ReciboCliente {
  nombre: string
  identificacion: string
  direccion: string | null
}

export interface ReciboData {
  nroFactura: string
  fecha: string
  emisor: ReciboParte
  cliente: ReciboCliente
  lineas: ReciboLinea[]
  totales: ReciboTotales
  pagos: ReciboPagoLinea[]
  cierre: ReciboCierre | null
  monedaPresentacion: MonedaPresentacion
}

export interface ReciboLineaInput {
  codigo: string
  nombre: string
  cantidad: DecimalInput
  precioUnitarioUsd: DecimalInput
  tipoImpuesto: TipoImpuestoLinea
  impuestoPct: DecimalInput
}

export interface BuildReciboDataInput {
  nroFactura: string
  fecha: string
  emisor: ReciboParte
  cliente: ReciboCliente
  lineas: ReciboLineaInput[]
  tasa: DecimalInput
  igtfUsd: number | null
  pagos: ReciboPagoInput[]
  discrepancy: ReciboDiscrepancyInput | null
  saldoPendUsd: number
  monedaPresentacion?: MonedaPresentacion
}

// =============================================
// INTERNAL HELPER
// =============================================

/** Safe converter — never throws. Returns Decimal(0) on empty/invalid input. */
function toD(val: DecimalInput): Decimal {
  if (val instanceof Decimal) return val
  if (typeof val === 'string' && val.trim() === '') return new Decimal(0)
  try {
    return new Decimal(val)
  } catch {
    return new Decimal(0)
  }
}

function esExentoTipo(tipo: TipoImpuestoLinea): boolean {
  return tipo === 'Exento' || tipo === 'Exonerado'
}

// =============================================
// CURRENCY MAPPING SEAM
// La UNICA funcion que decide cual moneda va primero. Futuras monedas de
// presentacion solo tocan este mapa — el resto del archivo formatea, no convierte.
// =============================================

type ParPrimarioContraparte = { primario: string; contraparte: string }

/** Dado un par usd/bs ya calculado, retorna { primario, contraparte } segun la moneda elegida. */
export function formatParPrimarioContraparte(
  usd: number,
  bs: number,
  monedaPrimaria: MonedaPresentacion
): ParPrimarioContraparte {
  return monedaPrimaria === 'BS'
    ? { primario: formatBs(bs), contraparte: formatUsd(usd) }
    : { primario: formatUsd(usd), contraparte: formatBs(bs) }
}

/** Formato compacto `primario (contraparte)`, usado SOLO en las 2 filas finales bold (TOTAL FACTURA / TOTAL + IGTF) y en pagos cuya moneda nativa no coincide con `monedaPresentacion`. */
export function formatMontoBimonetario(usd: number, bs: number, monedaPrimaria: MonedaPresentacion): string {
  const { primario, contraparte } = formatParPrimarioContraparte(usd, bs, monedaPrimaria)
  return `${primario} (${contraparte})`
}

/** Formato de una sola moneda (sin contraparte), usado en lineas de articulo y totales intermedios. */
export function formatMontoPrimario(usd: number, bs: number, monedaPrimaria: MonedaPresentacion): string {
  return formatParPrimarioContraparte(usd, bs, monedaPrimaria).primario
}

// Caracteres invalidos en nombres de archivo (Windows + POSIX): / \ : * ? " < > |
const CARACTERES_INVALIDOS_ARCHIVO_RE = /[/\\:*?"<>|]/g
const GUIONES_REPETIDOS_RE = /-+/g
const DIACRITICOS_RE = /[\u0300-\u036f]/g

function sanitizarNombreCliente(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(DIACRITICOS_RE, '')
    .toUpperCase()
    .replace(CARACTERES_INVALIDOS_ARCHIVO_RE, '')
    .replace(/\s+/g, '-')
    .replace(GUIONES_REPETIDOS_RE, '-')
    .replace(/^-+|-+$/g, '')
}

/** Nombre de archivo dinamico y sanitizado: RECIBO_{nro}_{CLIENTE-SANITIZADO}.{ext} */
export function nombreArchivoRecibo(recibo: ReciboData, ext: 'pdf' | 'png'): string {
  const clienteSanitizado = sanitizarNombreCliente(recibo.cliente.nombre)
  const base = clienteSanitizado
    ? `RECIBO_${recibo.nroFactura}_${clienteSanitizado}`
    : `RECIBO_${recibo.nroFactura}`
  return `${base}.${ext}`
}

// =============================================
// buildReciboData — Totals-by-Alicuota Algorithm
// =============================================

export function buildReciboData(input: BuildReciboDataInput): ReciboData {
  let montoExentoUsd = new Decimal(0)
  let baseImponibleUsd = new Decimal(0)
  const alicuotaMap = new Map<number, { base: Decimal; iva: Decimal }>()
  const lineas: ReciboLinea[] = []

  for (const linea of input.lineas) {
    const cantidad = toD(linea.cantidad)
    const precioUnitarioUsd = toD(linea.precioUnitarioUsd)
    const totalUsd = cantidad.times(precioUnitarioUsd)
    const esExento = esExentoTipo(linea.tipoImpuesto)

    if (esExento) {
      montoExentoUsd = montoExentoUsd.plus(totalUsd)
    } else {
      baseImponibleUsd = baseImponibleUsd.plus(totalUsd)
      const pct = toD(linea.impuestoPct).toNumber()
      const ivaLinea = applyImpuesto(totalUsd, pct)
      const bucket = alicuotaMap.get(pct) ?? { base: new Decimal(0), iva: new Decimal(0) }
      alicuotaMap.set(pct, {
        base: bucket.base.plus(totalUsd),
        iva: bucket.iva.plus(ivaLinea),
      })
    }

    lineas.push({
      codigo: linea.codigo,
      nombre: linea.nombre,
      esExento,
      cantidad: cantidad.toNumber(),
      precioUnitarioUsd: precioUnitarioUsd.toNumber(),
      precioUnitarioBs: usdToBs(precioUnitarioUsd, input.tasa).toNumber(),
      totalUsd: totalUsd.toNumber(),
      totalBs: usdToBs(totalUsd, input.tasa).toNumber(),
    })
  }

  const alicuotas: ReciboAlicuota[] = Array.from(alicuotaMap.entries())
    .sort(([pctA], [pctB]) => pctA - pctB)
    .map(([pct, bucket]) => ({
      pct,
      baseUsd: bucket.base.toNumber(),
      ivaUsd: bucket.iva.toNumber(),
      ivaBs: usdToBs(bucket.iva, input.tasa).toNumber(),
    }))

  const ivaTotal = alicuotas.reduce((sum, a) => sum.plus(a.ivaUsd), new Decimal(0))
  const igtf = input.igtfUsd ?? 0
  const totalFacturaUsd = montoExentoUsd.plus(baseImponibleUsd).plus(ivaTotal)
  const totalFacturaBs = usdToBs(totalFacturaUsd, input.tasa)
  const totalGeneralUsd = totalFacturaUsd.plus(igtf)
  const totalGeneralBs = usdToBs(totalGeneralUsd, input.tasa)

  const pagos = agruparPagosPorMetodo(input.pagos, input.tasa)
  const cierre = construirCierreRecibo(input.discrepancy, input.saldoPendUsd, input.tasa)

  return {
    nroFactura: input.nroFactura,
    fecha: input.fecha,
    emisor: input.emisor,
    cliente: input.cliente,
    lineas,
    totales: {
      montoExentoUsd: montoExentoUsd.toNumber(),
      montoExentoBs: usdToBs(montoExentoUsd, input.tasa).toNumber(),
      baseImponibleUsd: baseImponibleUsd.toNumber(),
      baseImponibleBs: usdToBs(baseImponibleUsd, input.tasa).toNumber(),
      alicuotas,
      igtfUsd: input.igtfUsd,
      igtfBs: input.igtfUsd != null ? usdToBs(input.igtfUsd, input.tasa).toNumber() : null,
      totalFacturaUsd: totalFacturaUsd.toNumber(),
      totalFacturaBs: totalFacturaBs.toNumber(),
      totalGeneralUsd: totalGeneralUsd.toNumber(),
      totalGeneralBs: totalGeneralBs.toNumber(),
    },
    pagos,
    cierre,
    monedaPresentacion: input.monedaPresentacion ?? 'USD',
  }
}

// =============================================
// construirLineasRecibo — modelo de lineas compartido por
// buildReciboTextoPlano (texto) y buildReciboImagenBlob (canvas)
// =============================================

interface LineaRecibo {
  text: string
  bold?: boolean
}

/** Ancho canonico del recibo en caracteres (58mm termico, fuente ESC/POS Font A). */
export const RECIBO_ANCHO_CHARS = 32

/** Genera un separador de `chars` guiones (default: RECIBO_ANCHO_CHARS). Funcion pura. */
export function generarSeparador(chars: number = RECIBO_ANCHO_CHARS): string {
  return '-'.repeat(chars)
}

const SEPARADOR = generarSeparador()

/**
 * Monto de una linea de pago. Si la moneda nativa del pago coincide con `monedaPresentacion`
 * (M), se muestra SOLO esa moneda (sin equivalente). Si no coincide, la moneda nativa del
 * pago se mantiene como primaria y se agrega el equivalente de la otra moneda entre
 * parentesis (comportamiento historico para el caso de no-coincidencia).
 */
export function formatMontoPago(linea: ReciboPagoLinea, monedaPresentacion: MonedaPresentacion): string {
  if (linea.moneda === monedaPresentacion) {
    return linea.moneda === 'USD' ? formatUsd(linea.montoUsd) : formatBs(linea.montoBs)
  }
  return linea.moneda === 'USD'
    ? `${formatUsd(linea.montoUsd)} (${formatBs(linea.montoBs)})`
    : `${formatBs(linea.montoBs)} (${formatUsd(linea.montoUsd)})`
}

/**
 * Suma el total de TODOS los pagos (todas las lineas de `ReciboPagoLinea`), en USD y en Bs
 * de forma independiente (cada lado se acumula desde el valor ya calculado por linea, sin
 * derivar uno del otro, para quedar consistente con como se computo cada linea individual).
 * Funcion pura, compartida por construirLineasRecibo (texto/PNG) y buildReciboPdfBlob (PDF)
 * para que ambas rutas de render sean estructuralmente imposibles de divergir.
 */
export function sumarAbonos(pagos: ReciboPagoLinea[]): { usd: number; bs: number } {
  const totalUsd = pagos.reduce((acc, pago) => acc.plus(pago.montoUsd), new Decimal(0))
  const totalBs = pagos.reduce((acc, pago) => acc.plus(pago.montoBs), new Decimal(0))
  return { usd: totalUsd.toNumber(), bs: totalBs.toNumber() }
}

/** Fila de la seccion de totales, ya formateada (bimonetaria o formato fijo, ver construirFilasTotales). */
export interface FilaTotal {
  label: string
  monto: string
  /**
   * Monto en Bs formateado (`formatBs`), SOLO cuando `monto` no lo incluye ya.
   * `null` en filas finales (`formatMontoBimonetario`, ya bimonetario) o
   * cuando `monedaPresentacion='BS'` (Bs ya es la moneda primaria de `monto`).
   * F3 QA fix (Slice 5b): `FacturaDetallePanel` (pantalla, sin restriccion de
   * ancho) SIEMPRE muestra Bs junto a cada concepto fiscal usando este campo;
   * el recibo impreso (thermal 32 chars) sigue usando solo `monto`.
   */
  montoBs: string | null
  bold: boolean
}

/** Bs secundario para filas intermedias: solo aporta info nueva cuando el primario es USD. */
function montoBsSecundario(bs: number, monedaPresentacion: MonedaPresentacion): string | null {
  return monedaPresentacion === 'USD' ? formatBs(bs) : null
}

/**
 * Orden fiscal de totales (spec): Exento -> Base Imponible -> alicuotas de IVA ->
 * TOTAL FACTURA (subtotal sin IGTF) -> IGTF (si aplica) -> TOTAL + IGTF (final).
 * Sin IGTF, TOTAL FACTURA es la fila final (bold), sin fila de IGTF ni sufijo "+ IGTF".
 * Las filas intermedias (Monto Exento, Base Imponible, IVA %, IGTF) muestran SOLO la
 * moneda de presentacion (`formatMontoPrimario`), sin contraparte. Las 2 filas finales
 * (TOTAL FACTURA sin IGTF / TOTAL + IGTF) muestran la moneda de presentacion como
 * primaria MAS el equivalente de la otra moneda entre parentesis (`formatMontoBimonetario`,
 * toggle-aware). Funcion pura, compartida por construirLineasRecibo (PNG/texto) y
 * buildReciboPdfBlob (PDF) para que ambas rutas de render sean estructuralmente
 * imposibles de divergir (motivo del bug original de orden inconsistente).
 */
export function construirFilasTotales(totales: ReciboTotales, monedaPresentacion: MonedaPresentacion): FilaTotal[] {
  const filas: FilaTotal[] = []

  if (totales.montoExentoUsd > 0) {
    filas.push({
      label: 'Monto Exento',
      monto: formatMontoPrimario(totales.montoExentoUsd, totales.montoExentoBs, monedaPresentacion),
      montoBs: montoBsSecundario(totales.montoExentoBs, monedaPresentacion),
      bold: false,
    })
  }
  if (totales.baseImponibleUsd > 0) {
    filas.push({
      label: 'Base Imponible',
      monto: formatMontoPrimario(totales.baseImponibleUsd, totales.baseImponibleBs, monedaPresentacion),
      montoBs: montoBsSecundario(totales.baseImponibleBs, monedaPresentacion),
      bold: false,
    })
  }
  for (const alicuota of totales.alicuotas) {
    filas.push({
      label: `IVA ${alicuota.pct}%`,
      monto: formatMontoPrimario(alicuota.ivaUsd, alicuota.ivaBs, monedaPresentacion),
      montoBs: montoBsSecundario(alicuota.ivaBs, monedaPresentacion),
      bold: false,
    })
  }

  const igtf = totales.igtfUsd ?? 0
  if (igtf > 0) {
    filas.push({
      label: 'TOTAL FACTURA',
      monto: formatMontoBimonetario(totales.totalFacturaUsd, totales.totalFacturaBs, monedaPresentacion),
      montoBs: null,
      bold: false,
    })
    filas.push({
      label: 'IGTF',
      monto: formatMontoPrimario(igtf, totales.igtfBs ?? 0, monedaPresentacion),
      montoBs: montoBsSecundario(totales.igtfBs ?? 0, monedaPresentacion),
      bold: false,
    })
    filas.push({
      label: 'TOTAL + IGTF',
      monto: formatMontoBimonetario(totales.totalGeneralUsd, totales.totalGeneralBs, monedaPresentacion),
      montoBs: null,
      bold: true,
    })
  } else {
    filas.push({
      label: 'TOTAL FACTURA',
      monto: formatMontoBimonetario(totales.totalFacturaUsd, totales.totalFacturaBs, monedaPresentacion),
      montoBs: null,
      bold: true,
    })
  }

  return filas
}

/** Texto de cierre del recibo (excedente o saldo a credito). Sin acentos, consistente con el resto del archivo. */
function formatearCierre(cierre: ReciboCierre): string {
  const monto = `${formatBs(cierre.montoBs)} (${formatUsd(cierre.montoUsd)})`
  switch (cierre.tipo) {
    case 'VUELTO':
      return `Vuelto entregado: ${monto}`
    case 'SAF':
      return cierre.facturasAplicadas?.length
        ? `Abono aplicado a factura(s) ${formatearFacturasAplicadas(cierre.facturasAplicadas)}`
        : `Saldo a favor del cliente: ${monto}`
    case 'PROPINA':
      return `Propina: ${monto}`
    case 'DIFERENCIAL_SOBRANTE':
      return `Diferencial cambiario (sobrante): ${monto}`
    case 'CREDITO':
      return `Quedo a credito: ${monto}`
  }
}

// Orden de secciones (spec): emisor -> nro/fecha -> cliente -> articulos -> totales -> desglose de pagos.
function construirLineasRecibo(recibo: ReciboData): LineaRecibo[] {
  const lines: LineaRecibo[] = []

  lines.push({ text: recibo.emisor.nombre, bold: true })
  if (recibo.emisor.rif) lines.push({ text: `RIF: ${recibo.emisor.rif}` })
  if (recibo.emisor.direccion) lines.push({ text: recibo.emisor.direccion })
  lines.push({ text: '' })
  lines.push({ text: 'RECIBO', bold: true })
  lines.push({ text: `Nro: ${recibo.nroFactura}` })
  lines.push({ text: `Fecha: ${formatDateTime(recibo.fecha)}` })
  lines.push({ text: '' })
  lines.push({ text: `Cliente: ${recibo.cliente.nombre}` })
  lines.push({ text: `Identificacion: ${recibo.cliente.identificacion}` })
  if (recibo.cliente.direccion) lines.push({ text: `Direccion: ${recibo.cliente.direccion}` })
  lines.push({ text: '' })
  lines.push({ text: 'Articulos', bold: true })
  lines.push({ text: SEPARADOR })
  for (const linea of recibo.lineas) {
    const marca = linea.esExento ? ' (E)' : ''
    lines.push({ text: `${linea.codigo} ${linea.nombre}${marca}` })
    const precioUnitario = formatMontoPrimario(
      linea.precioUnitarioUsd,
      linea.precioUnitarioBs,
      recibo.monedaPresentacion
    )
    const total = formatMontoPrimario(linea.totalUsd, linea.totalBs, recibo.monedaPresentacion)
    lines.push({ text: `  ${linea.cantidad} x ${precioUnitario} = ${total}` })
  }
  lines.push({ text: SEPARADOR })

  for (const fila of construirFilasTotales(recibo.totales, recibo.monedaPresentacion)) {
    lines.push({
      text: `${fila.label}: ${fila.monto}`,
      bold: fila.bold,
    })
  }

  if (recibo.pagos.length > 0) {
    lines.push({ text: '' })
    lines.push({ text: 'Metodos de pago', bold: true })
    lines.push({ text: SEPARADOR })
    for (const pago of recibo.pagos) {
      lines.push({ text: `${pago.metodoNombre}: ${formatMontoPago(pago, recibo.monedaPresentacion)}` })
    }
    const totalAbonos = sumarAbonos(recibo.pagos)
    lines.push({
      text: `Total abonos: ${formatMontoBimonetario(totalAbonos.usd, totalAbonos.bs, recibo.monedaPresentacion)}`,
      bold: true,
    })
    lines.push({ text: SEPARADOR })
  }

  if (recibo.cierre) {
    lines.push({ text: '' })
    lines.push({ text: formatearCierre(recibo.cierre), bold: true })
  }

  return lines
}

// =============================================
// buildReciboTextoPlano — texto monoespaciado
// =============================================

export function buildReciboTextoPlano(recibo: ReciboData): string {
  return construirLineasRecibo(recibo)
    .map((linea) => linea.text)
    .join('\n')
}

// =============================================
// buildReciboPdfBlob — jsPDF + autoTable
// =============================================

interface AutoTableDoc extends jsPDF {
  lastAutoTable: { finalY: number }
}

/** Ajusta texto largo a `maxWidth` mm usando el medidor real de jsPDF (evita desbordar el documento). */
function wrapPdfText(doc: jsPDF, text: string, maxWidth: number): string[] {
  return doc.splitTextToSize(text, maxWidth) as string[]
}

export function buildReciboPdfBlob(recibo: ReciboData): Blob {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const anchoEmisor = pageWidth - 30
  let y = 15

  doc.setFontSize(14)
  doc.setFont('helvetica', 'bold')
  for (const linea of wrapPdfText(doc, recibo.emisor.nombre, anchoEmisor)) {
    doc.text(linea, pageWidth / 2, y, { align: 'center' })
    y += 5
  }
  if (recibo.emisor.rif) {
    doc.setFontSize(9)
    doc.setFont('helvetica', 'normal')
    doc.text(`RIF: ${recibo.emisor.rif}`, pageWidth / 2, y, { align: 'center' })
    y += 4
  }
  if (recibo.emisor.direccion) {
    doc.setFontSize(8)
    doc.setFont('helvetica', 'normal')
    for (const linea of wrapPdfText(doc, recibo.emisor.direccion, anchoEmisor)) {
      doc.text(linea, pageWidth / 2, y, { align: 'center' })
      y += 4
    }
  }

  y += 3
  doc.setDrawColor(59, 130, 246)
  doc.setLineWidth(0.5)
  doc.line(15, y, pageWidth - 15, y)
  y += 7

  doc.setFontSize(12)
  doc.setFont('helvetica', 'bold')
  doc.text(`RECIBO Nro: ${recibo.nroFactura}`, pageWidth / 2, y, { align: 'center' })
  y += 8

  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  const anchoCliente = pageWidth / 2 - 20
  const infoLeft = [
    ...wrapPdfText(doc, `Cliente: ${recibo.cliente.nombre}`, anchoCliente),
    `Identificacion: ${recibo.cliente.identificacion}`,
    ...(recibo.cliente.direccion
      ? wrapPdfText(doc, `Direccion: ${recibo.cliente.direccion}`, anchoCliente)
      : []),
  ]
  const infoRight = [`Fecha: ${formatDateTime(recibo.fecha)}`]
  const yInfoTop = y
  infoLeft.forEach((txt, i) => doc.text(txt, 15, yInfoTop + i * 5))
  infoRight.forEach((txt, i) => doc.text(txt, pageWidth / 2 + 10, yInfoTop + i * 5))
  y = yInfoTop + Math.max(infoLeft.length, infoRight.length) * 5 + 5

  doc.setFontSize(10)
  doc.setFont('helvetica', 'bold')
  doc.text('Articulos', 15, y)
  y += 4

  const artBody = recibo.lineas.map((linea) => [
    linea.codigo,
    `${linea.nombre}${linea.esExento ? ' (E)' : ''}`,
    String(linea.cantidad),
    formatMontoPrimario(linea.precioUnitarioUsd, linea.precioUnitarioBs, recibo.monedaPresentacion),
    formatMontoPrimario(linea.totalUsd, linea.totalBs, recibo.monedaPresentacion),
  ])

  autoTable(doc, {
    startY: y,
    head: [['Codigo', 'Producto', 'Cant.', 'P.Unit', 'Subtotal']],
    body: artBody,
    theme: 'grid',
    headStyles: { fillColor: [59, 130, 246], textColor: 255, fontStyle: 'bold', fontSize: 8 },
    bodyStyles: { fontSize: 8 },
    columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
    margin: { left: 15, right: 15 },
  })

  y = (doc as AutoTableDoc).lastAutoTable.finalY + 6

  const totalesBody: string[][] = construirFilasTotales(recibo.totales, recibo.monedaPresentacion).map((fila) => [
    fila.label,
    fila.monto,
  ])

  autoTable(doc, {
    startY: y,
    head: [['', '']],
    body: totalesBody,
    theme: 'plain',
    headStyles: { fillColor: [255, 255, 255], textColor: [255, 255, 255], fontSize: 1 },
    bodyStyles: { fontSize: 9 },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 40 }, 1: { halign: 'right' } },
    margin: { left: pageWidth - 80, right: 15 },
    tableWidth: 65,
  })

  y = (doc as AutoTableDoc).lastAutoTable.finalY + 6

  if (recibo.pagos.length > 0) {
    doc.setFontSize(10)
    doc.setFont('helvetica', 'bold')
    doc.text('Metodos de pago', 15, y)
    y += 4

    const pagosBody = recibo.pagos.map((pago) => [
      pago.metodoNombre,
      formatMontoPago(pago, recibo.monedaPresentacion),
    ])
    const totalAbonos = sumarAbonos(recibo.pagos)
    pagosBody.push(['Total abonos', formatMontoBimonetario(totalAbonos.usd, totalAbonos.bs, recibo.monedaPresentacion)])

    autoTable(doc, {
      startY: y,
      head: [['Metodo', 'Monto']],
      body: pagosBody,
      theme: 'grid',
      headStyles: { fillColor: [59, 130, 246], textColor: 255, fontStyle: 'bold', fontSize: 8 },
      bodyStyles: { fontSize: 8 },
      columnStyles: { 1: { halign: 'right' } },
      margin: { left: 15, right: 15 },
    })

    y = (doc as AutoTableDoc).lastAutoTable.finalY + 6
  }

  if (recibo.cierre) {
    doc.setFontSize(9)
    doc.setFont('helvetica', 'bold')
    for (const linea of wrapPdfText(doc, formatearCierre(recibo.cierre), pageWidth - 30)) {
      doc.text(linea, 15, y)
      y += 5
    }
  }

  return doc.output('blob')
}

// =============================================
// buildReciboImagenBlob — dibujo manual en Canvas 2D
// =============================================

const PNG_PADDING = 24
const PNG_LINE_HEIGHT = 20
// devicePixelRatio-style scaling fijo para que el PNG se vea nitido al compartirse
// (no dependemos de window.devicePixelRatio porque el canvas es offscreen/oculto).
const PNG_ESCALA = 2

/**
 * Mide el ancho en px que ocupa el separador canonico + padding a cada lado.
 * Funcion pura e inyectable: recibe el `ctx` para poder testearse sin canvas real
 * (happy-dom no implementa `getContext('2d')`, ver DEUDA-3).
 */
export function medirAnchoPngDesdeSeparador(
  ctx: CanvasRenderingContext2D,
  separador: string,
  padding: number
): number {
  return ctx.measureText(separador).width + padding * 2
}

/**
 * Espera a que la fuente monospace (normal y bold, ambas usadas en el recibo)
 * este lista antes de medir/dibujar texto en canvas. Usa la CSS Font Loading
 * API (`document.fonts`), Baseline widely available.
 *
 * Bug que soluciona: en el primer render del canvas, si la fuente monospace
 * todavia no cargo, `ctx.measureText()` mide con la fuente fallback del
 * navegador (de ancho distinto), lo que rompe el wrapping y hace que se
 * pierdan lineas de detalle en el PNG. En el segundo intento la fuente ya
 * esta cacheada y el bug "desaparece" — clasica race condition de fuentes
 * en canvas.
 *
 * `fonts` es inyectable (default: `document.fonts`) para poder testearse sin
 * un DOM real con CSS Font Loading API. Si `fonts` es `undefined` (entorno
 * sin soporte, ej. navegadores viejos o happy-dom), es un no-op — se degrada
 * de forma elegante en vez de lanzar.
 */
export async function esperarFuentesRecibo(fonts?: FontFaceSet): Promise<void> {
  if (!fonts) return
  await Promise.all([fonts.load('13px monospace'), fonts.load('bold 13px monospace')])
}

/**
 * Dibuja el recibo completo (mismo contenido fiscal que buildReciboTextoPlano)
 * sobre un canvas 2D y lo exporta como PNG. 100% local, sin dependencias nuevas.
 */
export async function buildReciboImagenBlob(recibo: ReciboData): Promise<Blob> {
  if (typeof document !== 'undefined' && document.fonts) {
    await esperarFuentesRecibo(document.fonts)
  }

  const lineas = construirLineasRecibo(recibo)

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return Promise.reject(new Error('No se pudo obtener el contexto 2D del canvas'))
  }

  // Ajuste de texto (wrap) ANTES de fijar canvas.width/height: setear esas
  // propiedades resetea el estado del contexto 2D, asi que medimos primero.
  // El ancho del PNG se DERIVA midiendo el separador canonico (mismo font que el
  // resto del recibo), en vez de hardcodearse — asi separadores y texto envuelto
  // comparten exactamente el mismo ancho (spec: recibo-ancho-termico-58mm).
  ctx.font = '13px monospace'
  const pngAncho = medirAnchoPngDesdeSeparador(ctx, SEPARADOR, PNG_PADDING)
  const maxWidthPx = pngAncho - PNG_PADDING * 2
  const lineasAjustadas: LineaRecibo[] = []
  for (const linea of lineas) {
    ctx.font = linea.bold ? 'bold 13px monospace' : '13px monospace'
    const wrapped = wrapCanvasText(ctx, linea.text, maxWidthPx)
    if (wrapped.length === 0) {
      // Linea en blanco (espaciador entre secciones): se preserva tal cual.
      lineasAjustadas.push(linea)
    } else {
      for (const texto of wrapped) {
        lineasAjustadas.push({ text: texto, bold: linea.bold })
      }
    }
  }

  const alto = PNG_PADDING * 2 + lineasAjustadas.length * PNG_LINE_HEIGHT
  canvas.width = pngAncho * PNG_ESCALA
  canvas.height = alto * PNG_ESCALA

  ctx.scale(PNG_ESCALA, PNG_ESCALA)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, pngAncho, alto)
  ctx.fillStyle = '#111111'
  ctx.textBaseline = 'top'

  let y = PNG_PADDING
  for (const linea of lineasAjustadas) {
    ctx.font = linea.bold ? 'bold 13px monospace' : '13px monospace'
    ctx.fillText(linea.text, PNG_PADDING, y)
    y += PNG_LINE_HEIGHT
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('No se pudo generar la imagen del recibo'))
    }, 'image/png')
  })
}

// =============================================
// descargarReciboPdf / compartirReciboImagen — feature-detection
// =============================================

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === 'AbortError'
  if (err instanceof Error) return err.name === 'AbortError'
  return false
}

function descargarBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** Boton "Descargar": genera el PDF y dispara la descarga con el nombre sanitizado. */
export function descargarReciboPdf(recibo: ReciboData): void {
  const blob = buildReciboPdfBlob(recibo)
  descargarBlob(blob, nombreArchivoRecibo(recibo, 'pdf'))
}

/**
 * Boton "Compartir": comparte una IMAGEN PNG del recibo via Web Share API Level 2.
 * Cadena de fallback:
 *   1. navigator.canShare({ files }) true  -> navigator.share({ files })
 *   2. imagen no se pudo generar/compartir -> navigator.share({ text }) (texto plano)
 *   3. navigator.share no existe en absoluto -> rechaza (el boton debe estar OCULTO
 *      en la UI en ese caso — decision de UX: no tiene sentido mostrar "Compartir"
 *      si el dispositivo no soporta Web Share API; ver venta-exitosa-modal.tsx).
 * AbortError (usuario cancelo el share sheet) se traga en silencio.
 *
 * `construirImagen` es inyectable (default: buildReciboImagenBlob) para permitir
 * testear la cadena de fallback sin depender de renderizado real de Canvas 2D.
 */
export async function compartirReciboImagen(
  recibo: ReciboData,
  construirImagen: (recibo: ReciboData) => Promise<Blob> = buildReciboImagenBlob
): Promise<void> {
  if (typeof navigator.share !== 'function') {
    throw new Error('Compartir no esta disponible en este dispositivo')
  }

  const archivo = await construirImagen(recibo)
    .then((blob) => new File([blob], nombreArchivoRecibo(recibo, 'png'), { type: 'image/png' }))
    .catch(() => null)

  const titulo = `RECIBO ${recibo.nroFactura}`

  if (archivo && typeof navigator.canShare === 'function' && navigator.canShare({ files: [archivo] })) {
    try {
      await navigator.share({ files: [archivo], title: titulo })
    } catch (err) {
      if (isAbortError(err)) return
      throw err
    }
    return
  }

  try {
    await navigator.share({ title: titulo, text: buildReciboTextoPlano(recibo) })
  } catch (err) {
    if (isAbortError(err)) return
    throw err
  }
}
