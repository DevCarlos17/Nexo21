# Proposal: Ruta Administrativa de Facturas Emitidas y Notas de Crédito

## Intent

El flujo POS de NC ya existe (change `notas-credito-ui-pos`): reversa facturas de la sesión activa. Falta la vía administrativa que permita reversar **cualquier factura de la empresa**, sin depender de una sesión de caja abierta. Este change entrega la base de consulta + generación reutilizando el motor y componentes ya construidos; el cableado del impacto en cuadre de caja queda para un change futuro.

## Scope

### In Scope
- Renombrar sección sidebar "Nota de Credito" (gated por `SALES_VOID`) → **"Facturas emitidas"**, reestructurada en 2 tabs:
  - **Facturas** (nueva, primaria): tabla empresa-wide de facturas. Filtros: rango de fecha, nro_factura, cliente, RIF. Carga default = mes actual. Botón "Aplicar nota de crédito" por fila abre el modal compartido.
  - **Notas de crédito** (existente, secundaria): mantiene tabla/buscador de `notas-credito-page.tsx` + filtros nuevos (fecha, nro NC, TOTAL/PARCIAL, cliente, RIF). Default mes actual.
- Nuevo hook de consulta empresa-wide (filtra `empresa_id` + rango de fecha) — no reutiliza `useFacturasSesionActiva` (hard-filtra por sesión).
- Modal admin de NC reutiliza `FacturaDetallePanel` y `SeleccionLineasNc` (puros, ya reusables), con `entryPoint: 'TRADICIONAL'` y modalidad `AJUSTE_CXC` (único camino funcional hoy, sin impacto de caja). Sin PIN — acceso a la ruta (`SALES_VOID`) es suficiente, igual que el modal admin actual (`crear-ncr-modal.tsx`).
- Placeholder visual (deshabilitado) del selector de origen de reverso: "Devolver dinero" vs "Crédito a favor". Solo "Crédito a favor" genera NC hoy.

### Out of Scope
- Cuadre de caja: los 5 efectos (NC del día, ventas netas, métodos de pago en devoluciones, contado/crédito, tabla de NC de sesión).
- Comportamiento real de "Devolver dinero" (sesión activa o tesorería) y su efecto en cuadre.
- Implementar `REFUND_TESORERIA` (hoy lanza `'no implementado — Slice 6'`).
- Badge "vía administración" con comportamiento de caja real (solo aplica cuando el change de cuadre lo cablee).
- Botones Imprimir NC (térmico) y Compartir NC — el motor (`factura-export.ts`) ya existe y es reusable, pero el cableado se difiere.

## Capabilities

### New Capabilities
- `notas-credito-admin`: consulta empresa-wide de facturas (tab Facturas) + generación de NC vía TRADICIONAL/AJUSTE_CXC reutilizando componentes puros existentes, sin PIN ni dependencia de sesión de caja.

### Modified Capabilities
- Ninguna. `notas-credito-pos` no cambia: este change no toca el flujo ni los requirements del POS.

## Approach

Reusar el motor `crearNotaCredito` (ya soporta `entryPoint: 'TRADICIONAL'` + `AJUSTE_CXC` sin cambios) y los componentes puros `FacturaDetallePanel`/`SeleccionLineasNc`. Construir un nuevo hook de facturas empresa-wide (mismo shape que `FacturaParaAnular`, sin el filtro de sesión) para alimentar el tab Facturas. Restructurar la página actual `notas-credito-page.tsx` en un layout con 2 tabs (Radix Tabs / shadcn), agregando filtros de fecha/nro/cliente/RIF a ambas tablas. El selector "Devolver dinero / Crédito a favor" se agrega como control deshabilitado (visual shell) dentro del modal admin, sin lógica condicional nueva.

## Decisiones Abiertas

| Decisión | Opciones | Recomendación |
|----------|----------|---------------|
| ¿Persistir ya el flag `entry_point`/`via_administracion` en schema? | (a) Ahora, para que el badge exista cuando llegue el change de cuadre; (b) Diferir hasta ese change | Diferir — el tab Facturas no necesita mostrar el badge en este change; evita migración especulativa |
| ¿El modal admin además valida `SALES_NOTA_CREDITO`? | (a) Sí, doble permiso como en POS; (b) No, `SALES_VOID` (acceso a la ruta) basta | No — mantiene la postura actual del admin route (mirrors `crear-ncr-modal.tsx`, sin PIN) |
| ¿Egreso por método de pago vs genérico en "Devolver dinero"? | — | Diferido por completo al change de cuadre; no se decide aquí |

## Affected Areas

| Area | Impacto | Descripción |
|------|---------|-------------|
| `src/components/layout/sidebar.tsx:85` | Modificado | Rename "Nota de Credito" → "Facturas emitidas" |
| `src/routes/_app/ventas/notas-credito.tsx` | Modificado | Layout con 2 tabs |
| `src/features/ventas/components/notas-credito-page.tsx` | Modificado | Split en tab Facturas + tab NC, filtros nuevos |
| Nuevo hook facturas empresa-wide | Nuevo | Reemplaza `useFacturasSesionActiva` para este contexto |
| `crear-ncr-modal.tsx` | Modificado | Reusa `FacturaDetallePanel`/`SeleccionLineasNc`, agrega placeholder de origen de reverso |
| `use-notas-credito.ts` | Sin cambios | Motor ya soporta el camino usado |

## Riesgos

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Query empresa-wide sin límite de sesión escala mal en empresas con muchas facturas | Med | Default mes actual + filtros server-side antes de traer datos |
| Placeholder de "Devolver dinero" genera expectativa de funcionalidad real | Low | Deshabilitado explícitamente + tooltip "próximamente" |
| Reuso de `FacturaDetallePanel`/`SeleccionLineasNc` acopla ambos flujos (POS y admin) a cambios futuros | Med | Son puros y sin estado de sesión; cualquier cambio se valida contra ambos consumidores |
| Decisión diferida de `entry_point` puede forzar migración tardía cuando llegue cuadre | Low | Aceptado — se documenta como decisión abierta, no bloquea este change |

## Rollback Plan

Cada slice (rename+tabs, hook empresa-wide, modal admin, placeholder) es un PR revertible. El modal admin actual (`crear-ncr-modal.tsx`, TOTAL-only) sigue funcional hasta mergear el reemplazo; no se toca `crearNotaCredito`.

## Dependencies

- Change `notas-credito-ui-pos` (merged) — provee `FacturaDetallePanel`, `SeleccionLineasNc`, `derivarEstadoPago`.

## Success Criteria

- [ ] Tab Facturas lista cualquier factura de la empresa (no solo de sesión), filtrable por fecha/nro/cliente/RIF, default mes actual
- [ ] Tab Notas de crédito mantiene funcionalidad actual + filtros nuevos
- [ ] Modal admin genera NC vía TRADICIONAL/AJUSTE_CXC sin PIN, reusando componentes puros existentes
- [ ] Placeholder "Devolver dinero" visible pero deshabilitado, no genera NC
- [ ] Toda query nueva filtra `empresa_id`
