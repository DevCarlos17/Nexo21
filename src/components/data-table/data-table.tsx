import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type Table as TableType,
} from '@tanstack/react-table'

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { DataTableToolbar } from './toolbar'
import { DataTablePagination } from './pagination'

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  table?: TableType<TData>
  isLoading?: boolean
  onRowClick?: (row: TData) => void
  emptyMessage?: string
  rowClassName?: string | ((row: TData) => string | undefined)
  /** Atributos HTML extra por fila (p.ej. `data-*` para marcadores semanticos no acoplados a CSS). */
  rowProps?: (row: TData) => Record<string, string>
  containerClassName?: string
  searchKey?: string
  searchPlaceholder?: string
  filters?: {
    columnId: string
    title: string
    options: {
      label: string
      value: string
      icon?: React.ComponentType<{ className?: string }>
    }[]
  }[]
  showToolbar?: boolean
  showPagination?: boolean
}

export function DataTable<TData, TValue>({
  columns,
  data,
  table: externalTable,
  isLoading,
  onRowClick,
  emptyMessage = 'No se encontraron resultados.',
  rowClassName,
  rowProps,
  containerClassName,
  searchKey,
  searchPlaceholder,
  filters,
  showToolbar = true,
  showPagination = true,
}: DataTableProps<TData, TValue>) {
  const internalTable = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  const table = externalTable || internalTable

  return (
    <div className={cn(
      'flex flex-1 flex-col rounded-2xl bg-background border overflow-hidden',
      containerClassName
    )}>
      {showToolbar && (
        <div className="p-4 border-b">
          <DataTableToolbar
            table={table}
            searchKey={searchKey}
            searchPlaceholder={searchPlaceholder}
            filters={filters}
          />
        </div>
      )}

      <div className="overflow-hidden w-full flex-1">
        <Table>
          <TableHeader className="bg-muted/30 border-b">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={cn(
                      'h-11 text-[11px] font-bold uppercase tracking-widest text-muted-foreground/70 py-0',
                      (header.column.columnDef.meta as Record<string, string> | undefined)?.className
                    )}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, index) => (
                <TableRow key={index}>
                  {columns.map((_, colIndex) => (
                    <TableCell key={colIndex} className="py-4 px-4">
                      <Skeleton className="h-4 w-full opacity-50" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && 'selected'}
                  className={cn(
                    'cursor-pointer transition-colors hover:bg-muted/40',
                    typeof rowClassName === 'function' ? rowClassName(row.original) : rowClassName
                  )}
                  onClick={() => onRowClick?.(row.original)}
                  {...rowProps?.(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        'py-3.5 px-4',
                        (cell.column.columnDef.meta as Record<string, string> | undefined)?.className
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground/60 italic font-medium"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {showPagination && (
        <div className="p-4 border-t">
          <DataTablePagination table={table} />
        </div>
      )}
    </div>
  )
}
