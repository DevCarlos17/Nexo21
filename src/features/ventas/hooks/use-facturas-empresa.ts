import { useQuery } from '@powersync/react'
import { useCurrentUser } from '@/core/hooks/use-current-user'
import type { FacturaParaAnular } from './use-notas-credito'
import { buildFacturasEmpresaFiltro, rangoMesActual } from '../utils/notas-credito-admin-filters'

/**
 * Filtros del hook (Slice B, notas-credito-ruta-administrativa, Design
 * §Decision 3). `fechaDesde`/`fechaHasta` son OPCIONALES a este nivel — a
 * diferencia de `FiltroFacturasEmpresa` (el builder puro de Slice A, donde
 * son obligatorios): cuando el llamador los omite, el hook aplica
 * `rangoMesActual()` (Spec: "Carga por defecto limitada al mes en curso").
 * Pasar un rango explicito (por ejemplo, una fecha muy antigua) es el
 * mecanismo de escape para "ver todo el historial" — no existe un flag
 * separado, el propio rango explicito bypasea el default.
 *
 * Slice E.2 (tester QA feedback): `busqueda` reemplaza los campos
 * separados `nroFactura`/`clienteNombre`/`clienteIdentificacion` (retirados,
 * la UI ya no los expone por separado — un solo input de busqueda, patron
 * POS). Slice E.b (correccion sobre E.3): ya NO existe un campo `estado`
 * separado — `buildFacturasEmpresaFiltro` detecta palabras clave de estado
 * DENTRO de `busqueda` (ver `notas-credito-admin-filters.ts`).
 */
export interface FiltroFacturasEmpresaHook {
  fechaDesde?: string
  fechaHasta?: string
  busqueda?: string
}

/**
 * Listado empresa-wide de facturas (Spec: "Pestaña Facturas — listado
 * empresa-wide"), hermano de `useFacturasSesionActiva` pero SIN filtrar por
 * `sesion_caja_id` (Design §Decision 3: "NO reutiliza
 * `useFacturasSesionActiva`"). Delega la construccion del SQL a
 * `buildFacturasEmpresaFiltro` (Slice A, funcion pura) — este hook solo
 * resuelve `empresaId` (via `useCurrentUser()`) y el default de rango de
 * fecha antes de ejecutar la query reactiva de PowerSync.
 */
export function useFacturasEmpresa(filtros?: FiltroFacturasEmpresaHook) {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''

  const fechaDesde = filtros?.fechaDesde ?? rangoMesActual().fechaDesde
  const fechaHasta = filtros?.fechaHasta ?? rangoMesActual().fechaHasta

  const { sql, params } = buildFacturasEmpresaFiltro({
    empresaId,
    fechaDesde,
    fechaHasta,
    busqueda: filtros?.busqueda,
  })

  const { data, isLoading } = useQuery(sql, params)

  return {
    facturas: (data ?? []) as FacturaParaAnular[],
    isLoading,
  }
}
