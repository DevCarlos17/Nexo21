# Design: Notas de Crédito (ciclo completo)

> Nota de tamaño: la guía de la skill pide <800 palabras. Este diseño la excede
> deliberadamente — igual que la propuesta y los specs — porque el orquestador
> pidió resolver 5 decisiones abiertas con algoritmo exacto (desglose fiscal
> parcial, forma de la transacción atómica, condición Regla de Oro) sobre un
> dominio fiscal/anti-fraude donde la ambigüedad es el riesgo principal.

## Technical Approach

`crearNotaCredito()` se **reemplaza por completo** (decisión ya cerrada, obs
#2802 pt.5) por una función nueva en `use-notas-credito.ts` que cubre
TOTAL+PARCIAL, 3 modalidades de liquidación sin efectivo + 1 condicional con
efectivo/tesorería, y el egreso condicional de caja (Regla de Oro). Sigue el
mismo esqueleto probado de `crearVenta()` (`use-ventas.ts`): un único
`db.writeTransaction()`, guards ANTES de escribir, `Decimal` + `toStorageString`
en todo monto, montos nativos NUMERIC(12,2)/tasas NUMERIC(12,4)/stock
NUMERIC(12,3). El cuadre (`use-cuadre.ts`) **no se toca** — consume aditivamente
lo que esta función escribe (obs #2803/#2804).

## Architecture Decisions

### Decision 1 — bug `created_by`: AGREGAR la columna (no eliminar el insert)

| Opción | Tradeoff |
|---|---|
| (a) ADD `created_by` (elegida) | +1 migración, +1 columna PowerSync. Consistente con las ~40 tablas financieras que ya la tienen (`grep created_by` → 1127 hits en `migrations/*.sql`; confirmado en `ventas`, `pagos`, `movimientos_cuenta`, `movimientos_metodo_cobro`, `tasas_cambio`). Sin esto, NC —el documento fiscal más sensible a auditoría SENIAT (quién autorizó la anulación)— queda como la única tabla financiera sin trazabilidad de autor. |
| (b) DROP el insert | Cero migración, pero introduce una asimetría de auditoría injustificada solo por conveniencia. |

**Elegida: (a)**. Va en la misma migración nueva `migrations/0091_notas_credito_schema.sql`
(nunca se edita `0006_ventas.sql`, ya aplicada en prod). Secuencia de deploy
obligatoria: aplicar `0091` en el SQL Editor de Supabase **antes** de mergear a
`main` (el merge dispara auto-deploy del frontend a Cloudflare Workers vía
GitHub — si el frontend nuevo intenta insertar `created_by`/`sesion_caja_id`
antes de que la columna exista en Postgres, el upload de PowerSync falla igual
que el bug original).

### Decision 2 — Algoritmo de desglose fiscal PARCIAL (pieza de mayor riesgo)

Dato clave del schema: `ventas.tasa` es **una sola tasa por factura** (no hay
tasa por línea) — así que "heredar la tasa histórica" es trivial: `tasa_historica`
de la NC = `venta.tasa` (snapshot íntegro), y cada línea de `ventas_det` ya trae
su propio `tipo_impuesto`/`impuesto_pct` (así es como hoy se soportan alícuotas
mixtas dentro de una misma factura — sin cambios, se hereda verbatim).

**Input**: lista de `{ venta_det_id, cantidadDevolver }` elegidas por el usuario
(TOTAL = todas las líneas con su cantidad remanente completa; PARCIAL = subconjunto
y/o cantidad parcial por línea — mismo código, sin ramas duplicadas).

**Guard de doble-crédito** (gap no cubierto por el trigger `validate_nota_credito_insert`,
que solo topea el `total_usd` acumulado contra `venta.total_usd`, no la cantidad
por línea): se agrega `notas_credito_det.venta_det_id` (nuevo FK, Decisión 5) y,
por cada línea, `cantidadDevolver + SUM(cantidad ya acreditada para ese venta_det_id) <= ventas_det.cantidad`,
si no se lanza error ANTES de cualquier escritura.

**Por línea** (idéntico a la fórmula de `crearVenta`, líneas 398-408 de `use-ventas.ts`,
para paridad auditable):
```
subtotalLineaUsd = cantidadDevolver × ventas_det.precio_unitario_usd   // Decimal, 2dp
si tipo_impuesto == 'Exento':  totalExentoUsd += subtotalLineaUsd
si no:                          totalBaseUsd  += subtotalLineaUsd
                                 totalIvaUsd   += subtotalLineaUsd × impuesto_pct / 100
```
**Header**: `total_usd = totalExentoUsd + totalBaseUsd + totalIvaUsd`;
`total_bs = usdToBs(total_usd, venta.tasa)` (tasa ORIGINAL, no la vigente).
**Línea NC**: `notas_credito_det` guarda `cantidad`, `precio_unitario_usd`,
`tipo_impuesto`, `impuesto_pct` heredados verbatim, `subtotal_usd` calculado,
`subtotal_bs` nuevo (Decisión 5), `venta_det_id`, `producto_id`, `lote_id`
heredado, `deposito_id` = depósito de REINGRESO resuelto (puede diferir del
depósito original de la línea).

### Decision 3 — Forma de la transacción atómica

Un único `db.writeTransaction()`, orden calcado de `crearVenta()`:

| # | Paso | Nota |
|---|---|---|
| 0 | Resolver depósito de reingreso (riel POS `resolveDepositoReingresoNcr` / elección explícita Tradicional con 2do PIN) | Antes de cualquier INSERT de kardex |
| 0b | **Gate anti-fraude** (Decisión de spec `notas-credito-liquidacion` req. gate) | A nivel de función: si `modalidad ∈ {SALDO_FAVOR,COMPENSACION_VENTA,AJUSTE_CXC}` y viene un `egresoParams` no vacío → `throw` inmediato, sin tocar la DB |
| 1 | Leer `venta` (empresa-scoped), guard `status != 'ANULADA'` | |
| 2 | Generar `nro_ncr` (`COUNT` por `empresa_id`) | igual patrón que hoy |
| 3 | Calcular desglose fiscal (Decisión 2) + guard doble-crédito | |
| 4 | INSERT `notas_credito` (header, incl. `created_by`, `sesion_caja_id`, `liquidacion_modalidad`, `no_desembolso`) | |
| 5 | INSERT `notas_credito_det` (1 fila por línea seleccionada) | |
| 6 | Kardex reingreso — solo líneas/cantidades seleccionadas (P directo, S vía receta) | mismo loop que hoy, ahora escopeado a la selección parcial, no a toda la factura |
| 7 | **Step A** — `UPDATE ventas.saldo_pend_usd` (`Decimal.max(0, saldoPend - montoNC)`), y `status → ANULADA` solo si `tipo == 'TOTAL'` | reduce deuda YA pendiente de esta factura — no requiere modalidad, no es un reembolso |
| 8 | `UPDATE pagos SET is_reversed = 1 ...` — **solo si `tipo == 'TOTAL'`** | usa el trigger `allow_pago_reversal` ya existente (migración 0015); PARCIAL nunca reversa pagos, siguen siendo válidos por el saldo remanente |
| 9 | **Step B** — liquidar el REMANENTE (monto NC − lo aplicado en Step A, i.e. la porción ya cobrada) según `modalidad` (Decisión 4 detalla el caso `EFECTIVO_REAL`) | rama `SALDO_FAVOR`→SAFC, `AJUSTE_CXC`→NCR sobre `saldo_actual`, `COMPENSACION_VENTA`/`REFUND_TESORERIA` ver notas abajo |
| 10 | Egreso condicional Regla de Oro (Decisión 4) | |
| 11 | `reversarDiferencialEnTx` (TOTAL, best-effort try/catch, sin cambios) | |
| 12 | `generarAsientosNCR` (best-effort try/catch, sin cambios, params extendidos con modalidad) | |

`COMPENSACION_VENTA` compone con una venta nueva simultánea — se recomienda
**dos transacciones secuenciales** (no una mega-tx): `crearNotaCredito()` deja
el remanente como `movimientos_cuenta` tipo `SAFC` trazable, y `crearVenta()`
lo consume como `safEntry` (mecanismo YA existente, `use-ventas.ts` líneas
886-900/989-1031). Se documenta como *tradeoff aceptado* de "todo en una tx" solo
para esta modalidad — evita fusionar dos funciones ya complejas en una.

### Decision 4 — Condición exacta del egreso condicional (Regla de Oro)

```
shouldWriteEgreso =
  entryPoint === 'POS' &&
  modalidad === 'EFECTIVO_REAL' &&                 // única modalidad que mueve caja del cajón activo
  venta.sesion_caja_id === sesionCajaActivaId       // factura pertenece a LA sesión activa
```
Si es verdadero: `INSERT movimientos_metodo_cobro (tipo='EGRESO', origen='NCR',
doc_origen_id=ncrId, doc_origen_ref='NCR-'+nroNcr, sesion_caja_id=venta.sesion_caja_id, monto=remanente en moneda nativa del método)`.
`movimientos_metodo_cobro.doc_origen_id` ya es `UUID` genérico — **no se
necesita** una columna `nota_credito_id` nueva (confirmado, obs #2803/#2804).
`use-cuadre.ts` **no cambia**: su filtro existente
`mmc.origen NOT IN ('VENTA','COBRO','PROPINA') AND mmc.sesion_caja_id IN (...)`
(líneas 906-937) ya incluye cualquier `origen='NCR'` nuevo — consumo
100% aditivo. `REFUND_TESORERIA` (slice 6, condicional) nunca cumple esta
condición (no es `EFECTIVO_REAL` de la sesión activa) → impacto `$0.00` en el
cajón, tal como exige el spec.

### Decision 5 — Adiciones de schema (una migración: `0091_notas_credito_schema.sql`)

| Tabla | Cambio | Motivo |
|---|---|---|
| `notas_credito` | `ADD created_by UUID REFERENCES usuarios(id)` | Decisión 1 |
| `notas_credito` | `ADD sesion_caja_id UUID REFERENCES sesiones_caja(id) ON DELETE SET NULL` | gap #1 obs #2803 — atribución de sesión para cuadre/scope POS |
| `notas_credito` | `ADD liquidacion_modalidad TEXT NOT NULL DEFAULT 'AJUSTE_CXC' CHECK (IN ('SALDO_FAVOR','COMPENSACION_VENTA','AJUSTE_CXC','REFUND_TESORERIA','EFECTIVO_REAL'))` | modalidad obligatoria (spec `notas-credito-liquidacion`) |
| `notas_credito` | `ADD no_desembolso BOOLEAN NOT NULL DEFAULT TRUE` | persiste la decisión del gate anti-fraude (no solo runtime) |
| `notas_credito_det` | `ADD venta_det_id UUID REFERENCES ventas_det(id) ON DELETE RESTRICT` | guard doble-crédito por línea (Decisión 2) |
| `notas_credito_det` | `ADD subtotal_bs NUMERIC(12,2)` | simetría bimonetaria con `ventas_det` (que ya la tiene) |
| `movimientos_metodo_cobro` | `ALTER` CHECK `origen` → agregar `'NCR'` | Decisión 4 — mismo patrón idempotente `DROP/ADD CONSTRAINT` de 0073/0075/0078 |
| `permisos` | `INSERT ventas.nota_credito` (si no existe) | permiso fino para bypass de PIN de emisión (obs #2802 pt.3) |

PowerSync `schema.ts`: agregar las mismas columnas a `notas_credito`/`notas_credito_det`
(`column.integer` para `afecta_inventario`/`no_desembolso`, `column.text` para
el resto — decimales como texto para preservar precisión, regla ya establecida).
`REFUND_TESORERIA` (slice 6) **no requiere schema nuevo**: `movimientos_bancarios`/
`mov_caja_fuerte` ya tienen `validado`/`validado_por`/`reversado` (confirmado,
obs #2705 hallazgo 6).

## Data Flow

```
POS/Tradicional entry ─┬─ SupervisorPinDialog (emisión, slug ventas.nota_credito)
                        ├─ [2do PIN] selector explícito de depósito (Tradicional/override)
                        ▼
                 crearNotaCredito()  ── single db.writeTransaction ──┐
                        │                                            │
        ┌───────────────┼───────────────┬───────────────┐           │
        ▼               ▼               ▼               ▼           │
  notas_credito   notas_credito_det   Kardex (E)    pagos.is_reversed│
        │                                  │         (solo TOTAL)    │
        ▼                                  ▼                         │
  saldo_pend_usd            inventario_stock / lotes                 │
  (Step A)                                                           │
        │                                                            │
        ▼                                                            │
  Liquidación remanente (Step B) ── SAFC | AJUSTE_CXC | COMPENSACION |
        │                                                            │
        ▼                                                            │
  Regla de Oro: movimientos_metodo_cobro EGRESO (condicional) ───────┘
        │
        ▼
  use-cuadre.ts (SIN CAMBIOS — consume por filtro existente)
```

## File Changes

| File | Action | Slice |
|---|---|---|
| `migrations/0091_notas_credito_schema.sql` | Create | 1 |
| `src/core/db/powersync/schema.ts` | Modify (`notas_credito`, `notas_credito_det`) | 1 |
| `src/core/hooks/use-permissions.ts` | Modify — `PERMISSIONS.NOTA_CREDITO = 'ventas.nota_credito'` | 1 |
| `src/features/ventas/hooks/use-notas-credito.ts` | Modify — reemplazo total de `crearNotaCredito`, tipos nuevos | 1,2,3,4 |
| `src/features/inventario/lib/deposito-inactivo.ts` | Modify — variante de elección explícita (Tradicional) además del riel existente | 5 |
| `src/features/ventas/components/crear-ncr-modal.tsx` | Modify — nueva firma, selector de líneas/cantidades | 4,5 |
| POS terminal (`pos-terminal.tsx`/`cobro-modal.tsx`) | Modify — nuevo entry point | 5 |
| `src/features/contabilidad/lib/generar-asientos.ts` | Modify — `generarAsientosNCR` params extendidos con modalidad | 3 |
| `src/features/ventas/utils/factura-export.ts` | Modify/extend — documento imprimible NC (reusa `buildReciboData`/`buildReciboPdfBlob`) | 7 |
| `src/features/reportes/hooks/use-cuadre.ts` | **No modificar** — consumo aditivo confirmado | — |
| (condicional) writer refund-tesorería | Create — TBD en tasks | 6 |

## Interfaces / Contracts

```ts
export interface CrearNotaCreditoParams {
  venta_id: string
  motivo: string
  usuario_id: string
  empresa_id: string
  tipo: 'TOTAL' | 'PARCIAL'
  entryPoint: 'POS' | 'TRADICIONAL'
  sesionCajaActivaId: string | null   // requerido si entryPoint==='POS'
  lineas: Array<{ ventaDetId: string; cantidadDevolver: number }>
  liquidacion: {
    modalidad: 'SALDO_FAVOR' | 'COMPENSACION_VENTA' | 'AJUSTE_CXC' | 'REFUND_TESORERIA' | 'EFECTIVO_REAL'
    nuevaVentaId?: string        // COMPENSACION_VENTA
    egresoParams?: { metodoCobroId: string; monto: number }  // solo EFECTIVO_REAL/REFUND_TESORERIA
  }
  depositoReingresoId?: string   // solo si 2do PIN habilitó elección explícita
}
```

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | Desglose fiscal (Decisión 2), guard doble-crédito, gate anti-fraude (Decisión 3 paso 0b) | funciones puras extraídas, sin I/O — mismo patrón que `deposito-inactivo.ts`/`calcular-cierre-venta-saf.ts` |
| Unit | Condición Regla de Oro (Decisión 4) | tabla de verdad completa (POS/Tradicional × modalidad × sesión activa/histórica) |
| Integration | `writeTransaction` contra DB real (no mockeada) — específicamente el bug `created_by` original NO se detectó por tx mockeada (obs #2705) | correr contra Postgres real o emulación fiel del schema |
| Integration | Cuadre no-invasivo | insertar NC con `EFECTIVO_REAL` y verificar `use-cuadre.ts` sin tocar su código |

## Migration / Rollout

1. Aplicar `0091_notas_credito_schema.sql` en el SQL Editor de Supabase (producción) — idempotente, `IF NOT EXISTS`/`DROP CONSTRAINT IF EXISTS` + `ADD`.
2. Mergear a `main` → auto-deploy frontend a Cloudflare Workers.
3. Retirar la función vieja `crearNotaCredito` (single call site, `crear-ncr-modal.tsx:44`) en el mismo commit que la nueva — sin flag de feature, sin doble mantenimiento (decisión ya cerrada obs #2802 pt.5).

## Open Questions

- [ ] Firma exacta de composición `COMPENSACION_VENTA` ↔ `crearVenta()` (dos tx secuenciales, propuesto arriba) — confirmar en tasks.
- [ ] Slice 6 (`REFUND_TESORERIA`) — permanece condicional/separable; su inclusión depende del forecast de tamaño en `sdd-tasks` (decisión ya diferida por el usuario, obs #2805).
