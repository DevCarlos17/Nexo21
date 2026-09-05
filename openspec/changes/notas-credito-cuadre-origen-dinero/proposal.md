# Proposal: Notas de Crédito — Origen de Dinero Configurable + Cuadre

Base branch: `develop` @ `11ac472` (predecessor `notas-credito-ruta-administrativa`, PR #83 / `a139ce3`).

## Why

"Devolver dinero" hoy está deshabilitado en ambos módulos de NC (POS y Tradicional) y `REFUND_TESORERIA` lanza error. El owner resolvió (obs #2935) que el usuario debe poder elegir el origen del reintegro — efectivo de sesión, tesorería (caja fuerte) o banco — desde **cualquiera** de los dos puntos de entrada. Esto revierte la reserva previa de `REFUND_TESORERIA` solo-Tradicional (`nota-credito-pos-modal.tsx:53-55`) y exige desacoplar la "regla de oro" que hoy fuerza reintegro únicamente a la sesión de la venta original.

## What Changes

| # | Cambio |
|---|--------|
| 1 | Migración `0092`: columna `entry_point` en `notas_credito` (persiste `entryPoint`, hoy solo en memoria). |
| 2 | Desacoplar "regla de oro" (`use-notas-credito.ts:418-422`): separar *mueve-caja* / *cuenta-destino* / *misma-sesión*. Nuevo parámetro `origenDinero: { tipo: 'SESION_EFECTIVO' \| 'TESORERIA_EFECTIVO' \| 'BANCO', cuentaId }` en `CrearNotaCreditoParams`, reemplazando el hardcode a `sesionCajaActivaId`. |
| 3 | Implementar `REFUND_TESORERIA` (reemplaza throw en `:363-365`): EGRESO en `mov_caja_fuerte`/`movimientos_bancarios`, sin cuenta destino interna, referenciando `notas_credito.id`, con `Decimal.js` (no `parseFloat`). |
| 4 | Selector "Devolver dinero" funcional en POS y Tradicional (cuenta-descriptor de arriba) + guard de sesión cerrada (patrón `use-traspasos.ts:394-402`). |
| 5 | Cuadre (`use-cuadre.ts`): NC total scoped por sesión (hoy `totalNcrUsd` es solo por fecha, `:1137`), reconciliación por método en `usePagosPorMetodo` (hoy sin awareness de `origen='NCR'`), nueva tabla "NC de la sesión". |
| 6 | Badge "vía administración" en listado POS, usando `entry_point`. |

## Capabilities

### Modified Capabilities
- `notas-credito-pos`: "Devolver dinero" pasa de placeholder a funcional; regla de oro deja de exigir misma-sesión-que-la-venta.
- `notas-credito-admin`: "Devolver dinero" pasa de placeholder a funcional; se persiste `entry_point`; badge "vía administración".
- `caja`: cuadre gana NC scoped-por-sesión, refund-by-método y tabla de NC de sesión.

### New Capabilities
None.

## Non-Goals (Future)

- Restringir por método de pago qué puede reintegrarse desde POS (ej. transferencias solo vía tesorería). Declarado fuera de alcance por el owner; el shape de `origenDinero` ya lo habilita a futuro.
- Row de auditoría `traspasos_tesoreria` para el payout (decisión de diseño, ver abajo).

## Delivery Plan

Feature-branch-chain, ~6 slices en el orden de la tabla arriba (schema → decouple regla de oro → REFUND_TESORERIA → selector+guard → cuadre → badge). Razón del orden: decouplear ANTES de implementar el write de REFUND_TESORERIA evita construir sobre un shape que se refactoriza una PR después. **El budget de 400 líneas de review se excederá** (`use-notas-credito.ts` 1044 líneas + test 1000+; `use-cuadre.ts` 1421 líneas, sin tests hoy) — PRs encadenadas son obligatorias, no opcionales.

## Risks

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| Dinero real + kardex + CxC + cuadre en una sola tx atómica | Alto impacto | RED-first TDD obligatorio; extender `use-notas-credito.test.ts` ANTES de tocar `:363-365`. |
| `use-cuadre.ts` y `use-traspasos.ts` sin tests hoy | Alto | Construir harness nuevo (mock `db.writeTransaction`, patrón ya usado en `use-notas-credito.test.ts`) antes de slice 5. |
| Escribir en sesión de OTRO cajero (selector "cualquier sesión activa") | Medio, sin precedente en el código | Guard explícito + decisión de autorización diferida a diseño (ver abajo). |
| Regresión de las ~15 describe blocks que asumen la regla de oro actual | Medio | Reescribir, no solo extender, los tests marcados en `explore.md` sección E antes de mergear slice 2. |

## Decisions Deferred to Design

1. ¿Banco además de caja fuerte en `REFUND_TESORERIA`, o solo caja fuerte por ahora?
2. ¿El payout necesita fila `traspasos_tesoreria` (precedente: `consolidarMetodoATesoreriaEnTx` siempre la usa) o basta el EGRESO simple con `doc_origen_id`?
3. Valores exactos de `entry_point` (`'POS' | 'TRADICIONAL'` vs. algo más granular).
4. Autorización para elegir la sesión activa de OTRO cajero — ¿quién puede hacerlo?

## Rollback Plan

Cada slice es una PR independiente y revertible: slice 1 (migración aditiva, sin `DROP`), slices 2-6 son código de aplicación sin cambios destructivos de schema. Revertir un slice no afecta a los anteriores ya mergeados salvo el 3 (REFUND_TESORERIA) que depende del 2 (shape de `origenDinero`).

## Success Criteria

- [ ] `REFUND_TESORERIA` ya no lanza error; escribe EGRESO correcto en caja fuerte/banco con `Decimal.js`.
- [ ] "Devolver dinero" funcional y seleccionable en POS y Tradicional con los 3 orígenes.
- [ ] NC sobre sesión cerrada no altera cuadre/lista de esa sesión.
- [ ] Cuadre muestra NC scoped por sesión (no por fecha) + refund-by-método + tabla de NC de sesión.
- [ ] Badge "vía administración" visible en POS list para NC con `entry_point='TRADICIONAL'`.
- [ ] Todos los tests RED-first pasan; `yarn test:run`, `yarn type-check`, `yarn type-check:test` en verde por slice.
