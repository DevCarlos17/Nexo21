import { formatUsd, formatBs } from '@/lib/currency'
import { construirFilasTotales, type ReciboData } from '../utils/factura-export'
import type { BadgeReverso, ReversoAplicado } from '../utils/notas-credito-ui'

/**
 * Panel de detalle fiscal de la factura seleccionada (Design §Decision 5,
 * openspec/changes/notas-credito-ui-pos). Componente de PRESENTACION puro:
 * recibe `ReciboData` YA CONSTRUIDO por el llamador — NUNCA llama
 * `buildReciboData` ni hace fetch internamente. Reusa `construirFilasTotales`
 * para la seccion de totales (misma fuente que el recibo oficial de la
 * venta, sin recalcular montos de forma independiente).
 *
 * Reuso-ready para POS y el futuro flujo Tradicional (Design §Technical
 * Approach): sin dependencia de contexto POS-especifico.
 */
export interface FacturaDetallePanelProps {
  /** `null` cuando ninguna factura esta seleccionada — el panel permanece vacio. */
  recibo: ReciboData | null
  /**
   * F1 QA fix (Slice 5a): historial de NC(s) ya aplicadas a esta factura
   * (`agruparReversosPorNc`, alimentado por `useReversosFactura`). El
   * detalle ORIGINAL de arriba SIEMPRE se muestra completo — esta seccion
   * es ADITIVA (nunca lo reemplaza): si la factura no tiene ninguna NC
   * aplicada, se omite prop o se pasa vacio y la seccion no se renderiza.
   */
  reversos?: ReversoAplicado[]
  /**
   * BUG E fix (Slice 5g): estado de reverso ACUMULADO de la factura, misma
   * fuente que alimenta el badge de la lista (`badgesPorVenta`, de
   * `useBadgesReversoSesion`/`calcularBadgesReversoPorVenta`). El overlay
   * watermark de abajo DEBE leer este valor — NUNCA derivarlo localmente
   * del tipo crudo de cada registro de `reversos` — porque una factura
   * puede llegar a 100% reversada por ACUMULACION de NCs 'PARCIAL' sin que
   * ninguna sea individualmente 'TOTAL'.
   */
  badgeReverso?: BadgeReverso
}

export function FacturaDetallePanel({ recibo, reversos = [], badgeReverso = null }: FacturaDetallePanelProps) {
  if (!recibo) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        Selecciona una factura del listado para ver su detalle
      </div>
    )
  }

  // BUG E fix (Slice 5g): el watermark SIEMPRE lee `badgeReverso` (estado
  // acumulado), nunca el tipo crudo de `reversos` — una factura llega a
  // 'TOTAL' tanto por una unica NC TOTAL como por PARCIALes acumuladas.
  const estadoReverso = badgeReverso

  return (
    <div className="relative space-y-4 p-4">
      {estadoReverso !== null && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 flex select-none items-center justify-center overflow-hidden"
        >
          <span className="-rotate-12 whitespace-nowrap text-4xl font-black uppercase tracking-widest text-red-600/20">
            {estadoReverso === 'TOTAL' ? 'REVERSADA' : 'REVERSO PARCIAL'}
          </span>
        </div>
      )}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Factura</p>
        <p className="text-lg font-bold">{recibo.nroFactura}</p>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Articulo</th>
              <th className="px-3 py-2 text-right">Cant.</th>
              <th className="px-3 py-2 text-right">P. Unit.</th>
              <th className="px-3 py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {recibo.lineas.map((linea) => (
              <tr key={linea.codigo}>
                <td className="px-3 py-2">
                  {linea.nombre}
                  {linea.esExento && <span className="ml-1 text-xs text-muted-foreground">(E)</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{linea.cantidad}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  <div>{formatUsd(linea.precioUnitarioUsd)}</div>
                  <div className="text-xs text-muted-foreground">{formatBs(linea.precioUnitarioBs)}</div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  <div>{formatUsd(linea.totalUsd)}</div>
                  <div className="text-xs text-muted-foreground">{formatBs(linea.totalBs)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-1 rounded-lg border border-slate-200 p-3 text-sm">
        {construirFilasTotales(recibo.totales, recibo.monedaPresentacion).map((fila) => (
          <div
            key={fila.label}
            className={`flex items-center justify-between ${fila.bold ? 'font-bold' : 'text-muted-foreground'}`}
          >
            <span>{fila.label}</span>
            <div className="text-right tabular-nums">
              <div>{fila.monto}</div>
              {fila.montoBs !== null && <div className="text-xs">{fila.montoBs}</div>}
            </div>
          </div>
        ))}
      </div>

      {/*
        Slice 5d (QA 2.5/2.6, obs #2896/#2897): el desglose de metodos de
        pago y la seccion de "afectacion a cuentas por cobrar" se OCULTAN
        deliberadamente. Cuando el excedente de un pago se abona por FIFO a
        OTRA factura del cliente (flujo SAF desde POS), `crearVenta` reparte
        el pago tendido entre dos `venta_id` distintos sin back-reference
        persistido hacia la venta origen: `usePagosFactura` solo trae el
        monto capeado a esta factura (no el tendido real) y
        `useAfectacionCxc` da 0 aunque el excedente si afecto CxC en la
        factura destino. Mostrar cualquiera de las dos secciones aqui seria
        mostrar datos incorrectos. El fix real requiere persistir ese
        back-reference en `crearVenta`/`aplicarPagoFacturaEnTx` (flujo
        financiero, fuera de alcance de este change) — se retoma en un
        change de CxC futuro que reactivara estas secciones con datos
        confiables.
      */}

      {reversos.length > 0 && (
        <div className="space-y-2 rounded-lg border border-orange-200 bg-orange-50/50 p-3 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-orange-700">
            Notas de credito aplicadas
          </p>
          {reversos.map((nc) => (
            <div key={nc.notaCreditoId} className="rounded-md border border-orange-200 bg-white p-2">
              <div className="flex items-center justify-between text-xs font-medium text-orange-700">
                <span>{nc.nroNcr}</span>
                <span>{nc.tipo === 'TOTAL' ? 'Reverso Total' : 'Reverso Parcial'}</span>
              </div>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {nc.lineas.map((linea, i) => (
                  <li key={`${nc.notaCreditoId}-${i}`} className="flex items-center justify-between">
                    <span>{linea.descripcion}</span>
                    <span className="tabular-nums">{linea.cantidad}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
