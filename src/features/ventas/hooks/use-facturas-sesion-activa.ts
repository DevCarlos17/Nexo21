import { useMemo } from 'react'
import { useQuery } from '@powersync/react'
import { useCurrentUser } from '@/core/hooks/use-current-user'
import { useSesionActiva } from '@/features/caja/hooks/use-sesiones-caja'
import type { FacturaParaAnular } from './use-notas-credito'
import {
  calcularBadgesReversoPorVenta,
  type BadgeReverso,
  type LineaFacturaReversoRow,
  type NotaCreditoDetParaReverso,
} from '../utils/notas-credito-ui'

/**
 * Facturas disponibles para emitir NC desde el POS-express (Slice 5a-2a,
 * Spec notas-credito-pos: "Alcance limitado a la sesion activa"). A
 * diferencia de `useBuscarFacturaParaAnular` (modulo Tradicional, CUALQUIER
 * factura de la empresa via busqueda libre), este hook filtra por QUERY
 * — no solo UI — a la `sesion_caja_id` de la sesion actualmente abierta del
 * cajero: una factura de una sesion ya cerrada nunca llega a la lista, sin
 * importar lo que haga el componente que lo consuma.
 *
 * Sin sesion activa (usuario aun no abrio caja), retorna lista vacia sin
 * ejecutar query — el POS ya bloquea toda operacion sin sesion via
 * `AperturaSesionPosModal`, este hook solo refleja ese mismo estado.
 */
export function useFacturasSesionActiva() {
  const { user } = useCurrentUser()
  const empresaId = user?.empresa_id ?? ''
  const { sesion, isLoading: sesionLoading } = useSesionActiva()
  const sesionId = sesion?.id ?? ''

  const { data, isLoading } = useQuery(
    sesionId
      ? `SELECT
           v.id, v.nro_factura, v.cliente_id, v.tasa, v.total_usd, v.total_bs,
           v.saldo_pend_usd, v.tipo, v.status, v.fecha, v.total_igtf_usd,
           c.nombre as cliente_nombre,
           c.identificacion as cliente_identificacion,
           EXISTS(SELECT 1 FROM notas_credito nc WHERE nc.venta_id = v.id AND nc.tipo = 'TOTAL')   as tiene_reverso_total,
           EXISTS(SELECT 1 FROM notas_credito nc WHERE nc.venta_id = v.id AND nc.tipo = 'PARCIAL') as tiene_reverso_parcial
         FROM ventas v
         JOIN clientes c ON v.cliente_id = c.id
         WHERE v.empresa_id = ? AND v.sesion_caja_id = ?
         ORDER BY v.fecha DESC`
      : '',
    sesionId ? [empresaId, sesionId] : []
  )

  return {
    facturas: (data ?? []) as FacturaParaAnular[],
    isLoading: sesionLoading || isLoading,
  }
}

/**
 * QA fix 3.5 (Slice 5e): badge de reverso ACUMULADO por `venta_id`, para
 * TODAS las facturas de la sesion activa a la vez — a diferencia de
 * `useReversosFactura` (escopeado a UNA sola venta seleccionada), este hook
 * trae en dos queries planas (a) `ventas_det` de cada factura de la sesion
 * y (b) `notas_credito_det` de las NCs ya aplicadas a esas facturas, y
 * delega el criterio de acumulacion 100% a `calcularBadgesReversoPorVenta`
 * (mismo criterio que `calcularReversoPorLinea`, F1) — NUNCA lee
 * `notas_credito.tipo` para decidir el badge.
 */
export function useBadgesReversoSesion(empresaId: string, sesionId: string) {
  const { data: lineas, isLoading: isLoadingLineas } = useQuery(
    sesionId
      ? `SELECT vd.venta_id, vd.id as venta_det_id, vd.cantidad as cantidad_facturada
         FROM ventas_det vd
         JOIN ventas v ON v.id = vd.venta_id
         WHERE v.empresa_id = ? AND v.sesion_caja_id = ?`
      : '',
    sesionId ? [empresaId, sesionId] : []
  )

  const { data: notasCreditoDet, isLoading: isLoadingNotas } = useQuery(
    sesionId
      ? `SELECT ncd.venta_det_id, ncd.cantidad
         FROM notas_credito_det ncd
         JOIN notas_credito nc ON nc.id = ncd.nota_credito_id
         JOIN ventas v ON v.id = nc.venta_id
         WHERE v.empresa_id = ? AND v.sesion_caja_id = ?`
      : '',
    sesionId ? [empresaId, sesionId] : []
  )

  const badgesPorVenta: Record<string, BadgeReverso> = useMemo(
    () =>
      calcularBadgesReversoPorVenta(
        (lineas ?? []) as LineaFacturaReversoRow[],
        (notasCreditoDet ?? []) as NotaCreditoDetParaReverso[]
      ),
    [lineas, notasCreditoDet]
  )

  return { badgesPorVenta, isLoading: isLoadingLineas || isLoadingNotas }
}
