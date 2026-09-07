import { useState } from 'react'
import { type ColumnDef } from '@tanstack/react-table'
import { MagnifyingGlass } from '@phosphor-icons/react'
import { DataTable } from '@/components/data-table/data-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { formatUsd, formatBs } from '@/lib/currency'
import { formatDate } from '@/lib/format'
import { rangoMesActual } from '../utils/notas-credito-admin-filters'
import {
  derivarEstadoPago,
  resolverBadgesFactura,
  filaFacturaAtenuada,
  ESTADO_PAGO_LABEL,
  type EstadoPago,
  type BadgeReverso,
} from '../utils/notas-credito-ui'
import { useFacturasEmpresa } from '../hooks/use-facturas-empresa'
import type { FacturaParaAnular } from '../hooks/use-notas-credito'
import { CrearNcrModal } from './crear-ncr-modal'

/**
 * Slice C3b (notas-credito-ruta-administrativa, Design §Decision 3/File
 * Changes): reemplaza el placeholder de C3a por el listado empresa-wide
 * real sobre `useFacturasEmpresa(filtros)` + accion "Aplicar nota de
 * credito" por fila. El wiring del modal real es Slice D (`onAplicarNc` es
 * un callback prop que hoy no tiene consumidor por defecto — stub
 * inofensivo).
 *
 * Slice E.2 (tester QA feedback): los 3 inputs separados (nro_factura,
 * cliente, RIF) se reemplazaron por UN SOLO input de busqueda (patron POS —
 * ver `producto-buscador.tsx`).
 *
 * Slice E.b (correccion de tester QA sobre E.3): el selector `<select>` de
 * "Estado" agregado en E.3 se RETIRA por completo — el estado se detecta
 * ahora como palabra clave DENTRO del mismo input de busqueda (ver
 * `detectarEstadoFacturaEnBusqueda` en `notas-credito-admin-filters.ts`).
 * Escribir "contado", "credito", "abonada", "reverso parcial" o "reverso
 * total" agrega la clausula de estado correspondiente ADEMAS del match por
 * nro/cliente/RIF — nunca en su lugar.
 *
 * `showToolbar`/`showPagination` del `DataTable` generico se dejan en
 * `false`: ese componente registra el `useReactTable` solo con
 * `getCoreRowModel` (sin `getFilteredRowModel`/`getPaginationRowModel`), por
 * lo que su buscador/paginacion interna caen al fallback de TanStack Table
 * (siempre el listado completo sin truncar) — cosmeticamente presentes pero
 * no funcionales. Filtrado real se hace aqui, contra el SQL empresa-wide via
 * el hook, no client-side. Ver residual risk en el reporte de esta entrega.
 */
const ESTADO_PAGO_BADGE_CLASS: Record<EstadoPago, string> = {
  CONTADO: 'border-green-200 bg-green-50 text-green-700',
  CREDITO: 'border-blue-200 bg-blue-50 text-blue-700',
  ABONADA: 'border-amber-200 bg-amber-50 text-amber-700',
}

interface FiltrosFacturasEmpresaState {
  fechaDesde: string
  fechaHasta: string
  busqueda: string
}

function filtrosIniciales(): FiltrosFacturasEmpresaState {
  return { ...rangoMesActual(), busqueda: '' }
}

interface FacturasEmpresaFiltrosProps {
  filtros: FiltrosFacturasEmpresaState
  onChange: (filtros: FiltrosFacturasEmpresaState) => void
}

/** Presentacional: solo renderiza inputs, delega el estado al contenedor (`FacturasEmpresaTab`). */
function FacturasEmpresaFiltros({ filtros, onChange }: FacturasEmpresaFiltrosProps) {
  function set<K extends keyof FiltrosFacturasEmpresaState>(key: K, value: FiltrosFacturasEmpresaState[K]) {
    onChange({ ...filtros, [key]: value })
  }

  return (
    <div className="rounded-2xl bg-card shadow-lg p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="facturas-fecha-desde" className="text-xs text-muted-foreground">
            Desde
          </label>
          <input
            id="facturas-fecha-desde"
            type="date"
            value={filtros.fechaDesde}
            onChange={(e) => set('fechaDesde', e.target.value)}
            className="rounded-md border border-input px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="facturas-fecha-hasta" className="text-xs text-muted-foreground">
            Hasta
          </label>
          <input
            id="facturas-fecha-hasta"
            type="date"
            value={filtros.fechaHasta}
            onChange={(e) => set('fechaHasta', e.target.value)}
            className="rounded-md border border-input px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex flex-col gap-1 min-w-[240px] flex-1">
          <label htmlFor="facturas-busqueda" className="text-xs text-muted-foreground">
            Buscar
          </label>
          <div className="relative">
            <MagnifyingGlass
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="facturas-busqueda"
              value={filtros.busqueda}
              placeholder="Factura, cliente, RIF o estado (contado, crédito, abonada, reverso total/parcial)..."
              onChange={(e) => set('busqueda', e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export interface FacturasEmpresaTableProps {
  facturas: FacturaParaAnular[]
  isLoading: boolean
  onAplicarNc?: (factura: FacturaParaAnular) => void
}

/** Presentacional: recibe data via props, sin conocer el hook ni el estado de filtros. */
export function FacturasEmpresaTable({ facturas, isLoading, onAplicarNc }: FacturasEmpresaTableProps) {
  const columns: ColumnDef<FacturaParaAnular>[] = [
    {
      accessorKey: 'nro_factura',
      header: 'Factura',
      cell: ({ row }) => (
        <span className="font-mono font-bold text-xs">#{row.original.nro_factura}</span>
      ),
    },
    {
      accessorKey: 'fecha',
      header: 'Fecha',
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">{formatDate(row.original.fecha)}</span>
      ),
    },
    {
      id: 'cliente',
      header: 'Cliente',
      cell: ({ row }) => (
        <div>
          <p className="text-sm font-medium">{row.original.cliente_nombre}</p>
          <p className="text-xs text-muted-foreground">{row.original.cliente_identificacion}</p>
        </div>
      ),
    },
    {
      accessorKey: 'total_usd',
      header: 'Total USD',
      cell: ({ row }) => <span className="font-bold">{formatUsd(row.original.total_usd)}</span>,
    },
    {
      accessorKey: 'total_bs',
      header: 'Total Bs',
      cell: ({ row }) => (
        <span className="text-muted-foreground">{formatBs(row.original.total_bs)}</span>
      ),
    },
    {
      id: 'estado',
      header: 'Estado',
      cell: ({ row }) => {
        const f = row.original
        // Reuso parcial de la capa pura de `notas-credito-ui-pos` (Design
        // §Testing Strategy: "reuso sin tests nuevos"): a diferencia de
        // `useBadgesReversoSesion`/`calcularBadgesReversoPorVenta` (que
        // acumulan facturado-vs-reversado linea por linea via una query
        // adicional de `ventas_det`/`notas_credito_det`), aqui se deriva el
        // badge directo de los flags `tiene_reverso_total`/
        // `tiene_reverso_parcial` YA presentes en la fila (Slice A, EXISTS
        // sobre `notas_credito.tipo`) — evita una query extra empresa-wide
        // no exigida por design.md para esta pestana.
        const badgeReverso: BadgeReverso =
          f.tiene_reverso_total === 1 ? 'TOTAL' : f.tiene_reverso_parcial === 1 ? 'PARCIAL' : null
        const badges = resolverBadgesFactura(derivarEstadoPago(f), badgeReverso)
        return (
          <div className="flex flex-wrap items-center gap-1">
            {badges.estadoPago && (
              <Badge variant="outline" className={ESTADO_PAGO_BADGE_CLASS[badges.estadoPago]}>
                {ESTADO_PAGO_LABEL[badges.estadoPago]}
              </Badge>
            )}
            {badges.reverso === 'TOTAL' && (
              <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700">
                Reverso Total
              </Badge>
            )}
            {badges.reverso === 'PARCIAL' && (
              <Badge variant="outline" className="border-orange-200 bg-orange-50 text-orange-700">
                Reverso Parcial
              </Badge>
            )}
          </div>
        )
      },
    },
    {
      id: 'acciones',
      header: '',
      cell: ({ row }) => {
        const f = row.original
        return (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={f.tiene_reverso_total === 1}
            onClick={() => onAplicarNc?.(f)}
          >
            Aplicar nota de credito
          </Button>
        )
      },
    },
  ]

  return (
    <DataTable
      columns={columns}
      data={facturas}
      isLoading={isLoading}
      emptyMessage="No hay facturas para el periodo o filtros seleccionados."
      showToolbar={false}
      showPagination={false}
      rowClassName={(f) => (filaFacturaAtenuada(f) ? 'text-muted-foreground/70' : undefined)}
      rowProps={(f): Record<string, string> => (filaFacturaAtenuada(f) ? { 'data-atenuada': 'true' } : {})}
    />
  )
}

export interface FacturasEmpresaTabProps {
  /** Costura de extensibilidad opcional (tests, futuros consumidores) — se invoca ADEMAS de abrir `CrearNcrModal`, nunca en su lugar. */
  onAplicarNc?: (factura: FacturaParaAnular) => void
}

/**
 * Contenedor: mantiene el estado de filtros + el hook + la factura
 * seleccionada para NC, delega el render a los componentes presentacionales
 * de arriba. Slice D (Design §Decision 2): monta `CrearNcrModal` real —
 * el modal admin delgado que reversa CUALQUIER factura de la empresa sin PIN.
 */
export function FacturasEmpresaTab({ onAplicarNc }: FacturasEmpresaTabProps = {}) {
  const [filtros, setFiltros] = useState<FiltrosFacturasEmpresaState>(filtrosIniciales)
  const { facturas, isLoading } = useFacturasEmpresa({
    fechaDesde: filtros.fechaDesde,
    fechaHasta: filtros.fechaHasta,
    busqueda: filtros.busqueda,
  })
  const [facturaSeleccionada, setFacturaSeleccionada] = useState<FacturaParaAnular | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  function handleAplicarNc(f: FacturaParaAnular) {
    onAplicarNc?.(f)
    setFacturaSeleccionada(f)
    setModalOpen(true)
  }

  return (
    <div className="space-y-4">
      <FacturasEmpresaFiltros filtros={filtros} onChange={setFiltros} />
      <FacturasEmpresaTable facturas={facturas} isLoading={isLoading} onAplicarNc={handleAplicarNc} />
      <CrearNcrModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        factura={facturaSeleccionada}
      />
    </div>
  )
}
