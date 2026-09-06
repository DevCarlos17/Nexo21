import { formatUsd, formatBs } from '@/lib/currency'
import {
  useReintegrosPorMetodo,
  useNotasCreditoDeSesion,
  type CuadreFilters,
} from '../hooks/use-cuadre'

interface CuadreNotasCreditoProps {
  filters: CuadreFilters
}

function LoadingSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-8 bg-muted rounded animate-pulse" />
      ))}
    </div>
  )
}

function TipoVentaBadge({ tipoVenta }: { tipoVenta: string }) {
  const esCredito = tipoVenta === 'CREDITO'
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${
        esCredito
          ? 'bg-red-50 text-red-700 ring-red-600/20'
          : 'bg-green-50 text-green-700 ring-green-600/20'
      }`}
    >
      {tipoVenta}
    </span>
  )
}

export function CuadreNotasCredito({ filters }: CuadreNotasCreditoProps) {
  const { reintegros, isLoading: loadingReintegros } = useReintegrosPorMetodo(filters)
  const { notas, isLoading: loadingNotas } = useNotasCreditoDeSesion(filters)

  const totalReintegrosUsd = reintegros.reduce((s, r) => s + r.totalUsd, 0)

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* Reintegros de NC por metodo — efecto #2 del design (session-cash) */}
      <div className="rounded-2xl bg-card shadow-lg overflow-hidden">
        <div className="px-5 py-4 flex items-center gap-2 border-b">
          <span className="text-sm font-semibold">Reintegros de Notas de Credito por Metodo</span>
          {reintegros.length > 0 && (
            <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
              {reintegros.length}
            </span>
          )}
        </div>
        <div className="p-5">
          {loadingReintegros ? (
            <LoadingSkeleton />
          ) : reintegros.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              Sin reintegros de notas de credito en este periodo
            </p>
          ) : (
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/80">
                  <tr className="border-b">
                    <th className="text-left px-2 py-2 font-medium text-xs">NCR</th>
                    <th className="text-left px-2 py-2 font-medium text-xs">Metodo</th>
                    <th className="text-right px-2 py-2 font-medium text-xs">Monto</th>
                    <th className="text-right px-2 py-2 font-medium text-xs">USD</th>
                  </tr>
                </thead>
                <tbody>
                  {reintegros.map((r, i) => (
                    <tr key={`${r.metodoCobroId}-${r.nroNcr}-${i}`} className="border-b border-muted/50 last:border-0">
                      <td className="px-2 py-2 font-mono text-xs">{r.nroNcr}</td>
                      <td className="px-2 py-2 text-xs">{r.metodoNombre}</td>
                      <td className="px-2 py-2 text-right text-xs tabular-nums text-muted-foreground">
                        {r.moneda === 'BS' ? formatBs(r.totalOriginal) : formatUsd(r.totalOriginal)}
                      </td>
                      <td className="px-2 py-2 text-right text-xs font-semibold tabular-nums">
                        {formatUsd(r.totalUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/30 border-t">
                    <td colSpan={3} className="px-2 py-2 text-xs font-semibold text-right">Total</td>
                    <td className="px-2 py-2 text-right text-xs font-bold tabular-nums">
                      {formatUsd(totalReintegrosUsd)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Notas de credito de la sesion — efecto #3 del design (contado/credito split) */}
      <div className="rounded-2xl bg-card shadow-lg overflow-hidden">
        <div className="px-5 py-4 flex items-center gap-2 border-b">
          <span className="text-sm font-semibold">Notas de Credito de la Sesion</span>
          {notas.length > 0 && (
            <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
              {notas.length}
            </span>
          )}
        </div>
        <div className="p-5">
          {loadingNotas ? (
            <LoadingSkeleton />
          ) : notas.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              Sin notas de credito en este periodo
            </p>
          ) : (
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/80">
                  <tr className="border-b">
                    <th className="text-left px-2 py-2 font-medium text-xs">NCR</th>
                    <th className="text-left px-2 py-2 font-medium text-xs">Factura</th>
                    <th className="text-left px-2 py-2 font-medium text-xs">Cliente</th>
                    <th className="text-left px-2 py-2 font-medium text-xs">Tipo</th>
                    <th className="text-right px-2 py-2 font-medium text-xs">USD</th>
                  </tr>
                </thead>
                <tbody>
                  {notas.map((n) => (
                    <tr key={n.id} className="border-b border-muted/50 last:border-0">
                      <td className="px-2 py-2 font-mono text-xs">{n.nroNcr}</td>
                      <td className="px-2 py-2 text-xs">#{n.nroFactura}</td>
                      <td className="px-2 py-2 text-xs truncate max-w-[120px]">{n.clienteNombre}</td>
                      <td className="px-2 py-2">
                        <TipoVentaBadge tipoVenta={n.tipoVenta} />
                      </td>
                      <td className="px-2 py-2 text-right text-xs font-semibold tabular-nums">
                        {formatUsd(n.totalUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/30 border-t">
                    <td colSpan={4} className="px-2 py-2 text-xs font-semibold text-right">Total</td>
                    <td className="px-2 py-2 text-right text-xs font-bold tabular-nums">
                      {formatUsd(notas.reduce((s, n) => s + n.totalUsd, 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
