# Delta for Caja

> Adds a new capability (CAP-5) consuming the conditional NC outflow. `use-cuadre.ts`'s existing formula (egresosUsd sums EGRESO-type `movimientos_metodo_cobro`) is NOT rewritten — this is purely additive consumption, per the Regla de Oro (see `notas-credito-pos` spec, `#2804`).

## ADDED Requirements

### Requirement: Consumo de egreso condicional por Notas de Crédito

El cuadre de la sesión activa MUST incluir en su total de egresos por método (`egresosUsd`/`egresosBs`) cualquier `movimientos_metodo_cobro` tipo EGRESO cuyo `doc_origen_id` referencie una NC, siempre que ese registro tenga `sesion_caja_id` = sesión activa. El sistema MUST NOT requerir cambios en la fórmula de `use-cuadre.ts` — el egreso de NC entra por el mismo mecanismo que `EGRESO_MANUAL` ya usa.

#### Scenario: Egreso de NC suma al total de egresos de la sesión

- GIVEN una sesión activa con un egreso de NC insertado (POS + efectivo real, ver Regla de Oro)
- WHEN se calcula el cuadre
- THEN el monto aparece sumado en `egresosUsd`/`egresosBs` del método correspondiente, sin cambio de fórmula

#### Scenario: NC sin egreso no aparece en el cuadre activo

- GIVEN una NC liquidada como SALDO_FAVOR, COMPENSACION_VENTA o AJUSTE_CXC (sin `movimientos_metodo_cobro` generado)
- WHEN se calcula el cuadre de la sesión activa
- THEN no hay ningún registro adicional que sumar; el total de egresos no cambia por esa NC

#### Scenario: NC de sesión histórica no contamina la sesión activa

- GIVEN una NC del módulo Tradicional contra una factura de una sesión ya cerrada
- WHEN se calcula el cuadre de la sesión ACTUALMENTE activa
- THEN ningún registro de esa NC aparece, porque su `sesion_caja_id` (si existe) no coincide con la sesión activa

#### Scenario: Cross-link NC visible en el detalle del cuadre

- GIVEN un egreso de NC sumado al cuadre
- WHEN el cajero abre el detalle de egresos
- THEN el registro muestra el número de NC (`nro_ncr`) vía `doc_origen_id`, permitiendo trazar el egreso hasta el documento

#### Scenario: Aislamiento multi-tenant

- GIVEN dos empresas con sesiones activas simultáneas
- WHEN se calcula el cuadre de la empresa A
- THEN solo se consumen egresos de NC de `empresa_id` A
</content>
