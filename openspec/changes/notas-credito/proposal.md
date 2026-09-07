# Proposal: Notas de Crédito — Ciclo Completo (Parcial, Reembolsos, POS + Cuadre)

## Intent

`crearNotaCredito()` solo anula facturas COMPLETAS, nunca escribe `notas_credito_det`, no maneja reembolsos, no tiene entrada en el POS, y tiene un **bug en producción** (inserta `created_by`, columna inexistente). Tampoco integra la NC al modelo contable del cuadre. Este change construye el ciclo completo (TOTAL + PARCIAL, 3 modalidades de liquidación, emisión POS y Tradicional) integrando la NC al cuadre existente **sin reescribirlo**.

## Scope

### In Scope
- Nueva `crearNotaCredito()` (TOTAL + PARCIAL + `notas_credito_det`, desglose fiscal por alícuota heredando tasa/IVA histórico) que reemplaza y retira la actual, bug incluido.
- `sesion_caja_id` en NC + reversa `pagos.is_reversed`.
- Egreso condicional en `movimientos_metodo_cobro` SOLO bajo la Regla de Oro (POS + efectivo real de esta sesión); `use-cuadre.ts` no se reescribe.
- 3 modalidades de liquidación (SALDO_FAVOR/SAFC, COMPENSACION_VENTA, AJUSTE_CXC) + comprobante de no-desembolso anti-fraude.
- Emisión POS (sesión activa, riel automático) y Tradicional (cualquier factura, depósito explícito) + doble PIN (emisión, override depósito).
- Documento imprimible + cross-link "reversada según NC #".

### In Scope (condicional — sujeto a forecast de `sdd-tasks`)
- Refund por tesorería (transferencia reversada): egreso desde Banco/Tesorería con `validado=0` pendiente de conciliación, `$0.00` sobre el cajón POS activo (Regla de Oro). **Candidato a separarse a un change posterior si el forecast de tamaño lo exige.**

### Out of Scope
- Reescribir `use-cuadre.ts` (solo consumo aditivo). Ledger nuevo de CxP-a-clientes (se reusa CxC/SAFC). Módulo Clínica.

## Capabilities

**New**: `notas-credito-emision`, `notas-credito-liquidacion`, `notas-credito-pos`.
**Modified**: `caja` (consume egreso condicional, sin cambiar fórmula), `deposito-inactivo-guard` (elección explícita en Tradicional).

## Approach

Aditiva: SAFC es el efecto reusable, la NC el documento que lo origina. Regla de Oro decide si el cuadre se toca (solo POS+efectivo-de-esta-sesión); resto es `$0.00` neutro. Función nueva reemplaza la vieja en la misma slice (un solo call site real).

## Slice Breakdown (chained PRs, ~400 líneas c/u)

| # | Slice | Entrega |
|---|-------|---------|
| 1 | Bugfix + schema | Fix `created_by`, `sesion_caja_id`, flags, permiso `ventas.nota_credito` |
| 2 | Sesión + cuadre | Egreso condicional por método (Regla de Oro), reversa `pagos.is_reversed` |
| 3 | Liquidación | SALDO_FAVOR/COMPENSACION/AJUSTE_CXC + gate no-desembolso |
| 4 | NC parcial | `notas_credito_det`, desglose fiscal por alícuota [mayor riesgo] |
| 5 | Entrada POS/admin | UI, doble PIN, selector depósito |
| 6 | Refund tesorería (condicional) | Egreso Banco/Tesorería `validado=0`, `$0.00` cajón POS — separable si el forecast lo exige |
| 7 | Documento | NC PDF/imagen, patrón `factura-export.ts` |
| 8 | Reporting | Cross-link NC#, pulido Z-report |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Desglose fiscal parcial incorrecto (SENIAT) | Med | Slice 4 dedicada, tests de alícuotas mixtas |
| Atomicidad rota entre 5+ módulos | Med | Slices incrementales sobre patrón `crearVenta()` |
| Gate anti-fraude insuficiente | Med | Bloqueo a nivel de función, no solo UI |
| Romper el cuadre existente | Low | Egreso aislado, cero cambio de fórmula |

## Rollback Plan

Cada slice es un PR revertible independiente. Slice 1 es standalone; el resto solo agrega columnas/branches sin alterar comportamiento mergeado. Liquidación fallida se desactiva por permiso sin tocar el fix ni el vínculo de sesión.

## Dependencies

Ninguna externa. Reusa SAFC, `SupervisorPinDialog`, `movimientos_metodo_cobro`, `pagos.is_reversed`.

## Success Criteria

- [ ] `crearNotaCredito()` no falla por `created_by` contra DB real
- [ ] NC parcial escribe `notas_credito_det` con desglose fiscal correcto
- [ ] Cuadre activo solo cambia bajo Regla de Oro; `use-cuadre.ts` sin cambio de fórmula
- [ ] Gate anti-fraude bloquea egreso ficticio en liquidaciones no-efectivo
- [ ] Toda query filtra `empresa_id`; inmutabilidad de sesiones/kardex/movimientos_cuenta/libro_contable respetada
