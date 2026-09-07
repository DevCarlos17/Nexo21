import { useState } from 'react'
import { FileX, MagnifyingGlass } from '@phosphor-icons/react'
import { Input } from '@/components/ui/input'
import { formatUsd, formatBs } from '@/lib/currency'
import { formatDateTime } from '@/lib/format'
import { useNotasCredito } from '../hooks/use-notas-credito'
import { rangoMesActual } from '../utils/notas-credito-admin-filters'

/**
 * Pestana secundaria de "Facturas emitidas" (Slice C3b — design.md
 * §Decision 4/7). El buscador de facturas (`useBuscarFacturaParaAnular`) y
 * el modal de C3a se retiran: la pestana "Facturas" (empresa-wide,
 * primaria) es ahora el unico punto de entrada para seleccionar una
 * factura y aplicar una NC (Design §Decision 7 — dead code una vez
 * migrado este consumidor).
 *
 * Slice E.2/E.4 (tester QA feedback): los 3 inputs separados (nro_ncr,
 * cliente, RIF) se reemplazaron por UN SOLO input de busqueda (patron
 * POS); el selector "Tipo" y el boton "Ver todo el historial" se
 * RETIRARON — el rango de fecha (default `rangoMesActual()`) queda como
 * UNICO control de amplitud: no existe ningun escape hatch de historial
 * completo en esta pestaña.
 *
 * Slice E.b (correccion de tester QA sobre E.3): el selector `<select>` de
 * "Estado" (Reverso Total/Reverso Parcial) agregado en E.3 se RETIRA por
 * completo — a diferencia de la pestaña Facturas, el estado de NC NO se
 * folded en la busqueda, simplemente deja de ser un filtro disponible.
 */

interface FiltrosNotasCreditoState {
  fechaDesde: string
  fechaHasta: string
  busqueda: string
}

function filtrosIniciales(): FiltrosNotasCreditoState {
  return { ...rangoMesActual(), busqueda: '' }
}

export function NotasCreditoTab() {
  const [filtros, setFiltros] = useState<FiltrosNotasCreditoState>(filtrosIniciales)

  const { notas, isLoading: loadingNotas } = useNotasCredito({
    fechaDesde: filtros.fechaDesde,
    fechaHasta: filtros.fechaHasta,
    busqueda: filtros.busqueda,
  })

  function set<K extends keyof FiltrosNotasCreditoState>(key: K, value: FiltrosNotasCreditoState[K]) {
    setFiltros((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <div className="space-y-6">
      {/* Filtros */}
      <div className="rounded-2xl bg-card shadow-lg p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="nc-fecha-desde" className="text-xs text-muted-foreground">
              Desde
            </label>
            <input
              id="nc-fecha-desde"
              type="date"
              value={filtros.fechaDesde}
              onChange={(e) => set('fechaDesde', e.target.value)}
              className="rounded-md border border-input px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="nc-fecha-hasta" className="text-xs text-muted-foreground">
              Hasta
            </label>
            <input
              id="nc-fecha-hasta"
              type="date"
              value={filtros.fechaHasta}
              onChange={(e) => set('fechaHasta', e.target.value)}
              className="rounded-md border border-input px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex flex-col gap-1 min-w-[240px] flex-1">
            <label htmlFor="nc-busqueda" className="text-xs text-muted-foreground">
              Buscar
            </label>
            <div className="relative">
              <MagnifyingGlass
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="nc-busqueda"
                value={filtros.busqueda}
                placeholder="NC, cliente o RIF..."
                onChange={(e) => set('busqueda', e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Tabla de NCR existentes */}
      <div className="rounded-2xl bg-card shadow-lg">
        {loadingNotas ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 bg-muted rounded animate-pulse" />
            ))}
          </div>
        ) : notas.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <FileX className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">No hay notas de credito para el periodo o filtros seleccionados</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left px-4 py-3 font-medium">Nro NCR</th>
                  <th className="text-left px-4 py-3 font-medium">Factura</th>
                  <th className="text-left px-4 py-3 font-medium">Cliente</th>
                  <th className="text-right px-4 py-3 font-medium">Monto USD</th>
                  <th className="text-right px-4 py-3 font-medium">Monto Bs</th>
                  <th className="text-left px-4 py-3 font-medium">Fecha</th>
                  <th className="text-left px-4 py-3 font-medium">Motivo</th>
                </tr>
              </thead>
              <tbody>
                {notas.map((n) => (
                  <tr key={n.id} className="border-b border-muted hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 font-mono font-bold text-xs">{n.nro_ncr}</td>
                    <td className="px-4 py-3 font-mono text-xs">#{n.nro_factura}</td>
                    <td className="px-4 py-3 text-sm">{n.cliente_nombre}</td>
                    <td className="px-4 py-3 text-right font-bold">
                      {formatUsd(n.total_usd)}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {formatBs(n.total_bs)}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {formatDateTime(n.fecha)}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground truncate max-w-[200px]">
                      {n.motivo}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
