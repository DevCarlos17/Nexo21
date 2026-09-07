import { createFileRoute } from '@tanstack/react-router'
import { NotasCreditoPage } from '@/features/ventas/components/notas-credito-page'
import { RequirePermission } from '@/components/shared/require-permission'
import { AccessDeniedPage } from '@/components/shared/access-denied-page'
import { PERMISSIONS } from '@/core/hooks/use-permissions'

export const Route = createFileRoute('/_app/ventas/facturas-emitidas')({
  component: NotasCreditoPageRoute,
})

function NotasCreditoPageRoute() {
  return (
    <RequirePermission permission={PERMISSIONS.SALES_VOID} fallback={<AccessDeniedPage />}>
      <NotasCreditoPage />
    </RequirePermission>
  )
}
