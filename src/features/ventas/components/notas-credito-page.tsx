import { PageHeader } from '@/components/layout/page-header'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { FacturasEmpresaTab } from './facturas-empresa-tab'
import { NotasCreditoTab } from './notas-credito-tab'

/**
 * Ruta "Facturas emitidas" (design.md §Decision 1, mismo patron que
 * `traspasos.tsx`/`gastos-dashboard.tsx`/`horarios-staff-page.tsx`: `Tabs`
 * shadcn sin rutas anidadas ni search param). Pestana "Facturas" primaria y
 * activa por defecto; "Notas de credito" secundaria conserva el
 * comportamiento existente sin cambios (Slice C3a — estructura + contenido
 * movido; filtros nuevos llegan en Slice C3b).
 */
export function NotasCreditoPage() {
  return (
    <div className="space-y-6">
      <PageHeader titulo="Facturas emitidas" descripcion="Consulta de facturas y notas de credito" />

      <Tabs defaultValue="facturas" className="gap-4">
        <TabsList>
          <TabsTrigger value="facturas">Facturas</TabsTrigger>
          <TabsTrigger value="notas-credito">Notas de credito</TabsTrigger>
        </TabsList>

        <TabsContent value="facturas">
          <FacturasEmpresaTab />
        </TabsContent>

        <TabsContent value="notas-credito">
          <NotasCreditoTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
