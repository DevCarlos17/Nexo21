# Proposal: Rediseño UI de Notas de Crédito en POS

## Intent

El modal POS de NC solo anula facturas COMPLETAS; no expone la selección PARCIAL que `crearNotaCredito()` ya soporta (Change 1), ni detalle fiscal/pagos ni badge de estado antes de reversar. Cierra segmentos [1]-[3] del ring: listar → examinar detalle → elegir tipo/líneas de NC.

## Scope

### In Scope
- Renombrar botón POS ("Nota de Credito" → corto, ej. "Facturas de caja").
- Modal: lista COMPLETA de la SESIÓN ACTIVA (`useFacturasSesionActiva`) + buscador (nro/cliente/estado).
- Badges puros (`derivarEstadoPago`): Contado, Crédito, Abonada (pago parcial) + Reverso Total/Parcial.
- Panel de detalle: líneas (qty, USD/Bs), subtotal, exento, base imponible, IVAs, total, IGTF, desglose de pagos, afectación CxC — reutiliza `buildReciboData`/`construirFilasTotales` (puras).
- "Nota de crédito": TOTAL (`crearNotaCredito` sin cambios) o PARCIAL (qty por línea, respeta `es_decimal`, patrón `linea-items.tsx`).
- "Editar métodos de pago": placeholder sin lógica, gated por PIN.
- `SupervisorPinDialog` + `PERMISSIONS.SALES_NOTA_CREDITO` (doble PIN existente).

### Out of Scope
Módulo Tradicional (solo diseño reusable de `FacturaDetallePanel`/`SeleccionLineasNc`/`derivarEstadoPago`). Modificar `crearNotaCredito`. Cuadre de caja. REFUND_TESORERIA. Verificación end-to-end.

**Reconciliación**: absorbe Slices 5b/7 de `notas-credito` (acotados a POS); 6/8 quedan allí.

## Capabilities

- **New**: Ninguna.
- **Modified**: `notas-credito-pos` — listado completo, badges, panel fiscal, selección PARCIAL en POS.

## Approach

Componentes puros compartidos (no un hook que mezcle scopes de query): `FacturaDetallePanel`, `SeleccionLineasNc`, `derivarEstadoPago` — patrón de `notas-credito-fiscal.ts`/`recibo-pagos.ts`. El modal orquesta `useFacturasSesionActiva` extendida y `crearNotaCredito` sin tocarlo.

**Invariante crítica**: NC usa `venta.total_bs` (TOTAL) o `usdToBs(totalUsdNc, venta.tasa)` con tasa HISTÓRICA (PARCIAL) — nunca la vigente. Ya cumplido en backend; la UI NO debe re-derivar montos con la tasa actual.

## Affected Areas

| Area | Impacto |
|------|---------|
| `nota-credito-pos-modal.tsx` | Rediseño mayor |
| `use-notas-credito.ts` | Extender query |
| `use-cxc.ts::useDetalleFactura` | + `precio_unitario_bs`, `es_decimal` |
| `factura-export.ts`, `linea-items.tsx` | Reuso sin cambios |
| Componentes puros nuevos | `FacturaDetallePanel`, `SeleccionLineasNc`, `derivarEstadoPago` |

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Re-derivar montos con tasa vigente | Med | Escenario de spec con tasa distinta |
| `useDetalleFactura` rompe CxC | Med | Solo agregar campos + smoke test |
| "Afectación CxC" incompleta | Low | Design verifica cobertura antes |
| Tamaño grande | High | Chained PRs, 400 líneas c/u |

**Troceo**: (1) panel+queries; (2) lista+badges+rename; (3) PARCIAL→`crearNotaCredito`; (4) placeholder+PIN.

## Rollback Plan

Cada slice es un PR revertible; el modal actual (solo TOTAL) sigue funcional hasta mergear cada uno. No afecta `crearNotaCredito`.

## Dependencies

Change 1 `notas-credito` (merged).

## Success Criteria

- [ ] Badges correctos (Contado/Crédito/Abonada + Reverso Total/Parcial)
- [ ] Panel idéntico al recibo, sin duplicar lógica fiscal
- [ ] PARCIAL respeta `es_decimal`, no modifica `crearNotaCredito`
- [ ] NC usa tasa histórica, nunca la vigente; toda query filtra `empresa_id`
