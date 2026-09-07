# Tasks: notas-credito

Test runner confirmed (sdd-init cache, strict_tdd: true): `yarn test:run` (CI single-run), `yarn type-check:test` (tsc --noEmit --project tsconfig.test.json). Existing precedent: `src/features/ventas/hooks/__tests__/use-notas-credito.test.ts` already has TDD coverage for the current TOTAL-only function — all new behavior is RED→GREEN in that same file or a new sibling test file. All tasks below are TDD test-first where a runner target exists (SQL migrations are the one exception — no automated migration test framework; manual Supabase SQL Editor deploy per `migrations/README.md`).

## Aggregate Review Workload Forecast (top-level)

| Field | Value |
|---|---|
| Total estimated changed lines (10 PRs) | ~2350–2650 |
| Slices exceeding 400 lines alone | None *after* splitting 4 and 5 into a/b (see below) — 4 and 5 WOULD exceed 400 if kept as single PRs |
| Chained PRs recommended | **Yes** |
| Recommended PR sequencing | 1 → 2 → 3 → 4a → 4b → 5a → 5b → 6 → 7 → 8 (dependency order; 6 is safely postponable, see below) |
| Delivery strategy | ask-on-risk |
| Chain strategy | **pending** — not chosen this session. Orchestrator MUST ask the user (stacked-to-main vs feature-branch-chain) before `sdd-apply` starts slice 1 |

```text
Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High
```

**Slice 6 (REFUND_TESORERIA) recommendation**: estimated standalone at ~220–260 lines — comfortably fits the 400-line budget as its own PR (Low-Medium risk). The aggregate risk of this change comes from the *number* of slices (10 PRs), not from slice 6's size. Slice 6 has **zero dependents** (slices 7–8 do not read REFUND_TESORERIA-specific code), so it is the single safest slice to defer to a follow-up change ("al toro") if the chain grows too long to land in one sitting — but on size grounds alone it does NOT need to be split out. **Recommendation: keep in scope, sequence last-but-one (position 8 of 10), and treat it as the first candidate to cut if the user wants to shorten the chain.**

## Slice 1 — Bugfix `created_by` + Schema Foundation (Design §created_by decision, §schema migration 0091)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~110–130 |
| 400-line budget risk | Low |
| Chained PRs | No — single PR |

- [x] 1.1 Create `migrations/0091_notas_credito_schema.sql` (NEW file — never edit 0006). Idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` pattern (see 0078 precedent): `notas_credito` += `created_by uuid`, `sesion_caja_id uuid`, `liquidacion_modalidad text`, `no_desembolso boolean`; `notas_credito_det` += `venta_det_id uuid`, `subtotal_bs text`. [Design §5 schema migration 0091]
- [x] 1.2 Same migration: idempotent `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` on `movimientos_metodo_cobro.origen` CHECK, adding `'NCR'` (mirror 0078 pattern exactly). [Design §4 Regla de Oro condition]
- [x] 1.3 Same migration: `INSERT INTO permisos (modulo, slug, nombre, descripcion)` for `ventas.nota_credito` (mirror 0048/0047 pattern). [Spec notas-credito-pos: doble PIN — permiso determina el PIN]
- [x] 1.4 Update `src/core/db/powersync/schema.ts`: add `created_by`, `sesion_caja_id`, `liquidacion_modalidad`, `no_desembolso` (all `column.text`/`column.integer` per booleans-as-integer convention) to `notas_credito` Table (~L753); add `venta_det_id`, `subtotal_bs` to `notas_credito_det` Table (~L776). **Discovery: `created_by` is referenced by the CURRENT `use-notas-credito.ts` INSERT (line 244) but is missing from BOTH the Postgres schema AND `schema.ts` — this is the actual live bug (local SQLite insert fails silently until this column exists).**
- [x] 1.5 Manual verification: apply 0091 via Supabase SQL Editor in sequence after 0090; confirm no error; confirm `schema.ts` change does not break existing `yarn type-check` / `yarn test:run` (additive-only, zero behavior change expected). Automated portion done: `yarn type-check:test` and `yarn test:run` both green (839/839 tests, 79 files). Manual Supabase SQL Editor apply is a deploy-time action outside this session's scope — documented in migration file's deploy-order comment.

## Slice 2 — `sesion_caja_id` link + conditional egreso (Regla de Oro) + reverse `pagos.is_reversed` (Design §4 Regla de Oro condition)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~190–250 |
| 400-line budget risk | Medium |
| Chained PRs | No — single PR |

- [x] 2.1 RED: `use-notas-credito.test.ts` — add scenarios: POS+EFECTIVO_REAL+sesión activa inserta `movimientos_metodo_cobro` EGRESO origen `'NCR'` con `sesion_caja_id` activo; Tradicional/no-efectivo NO inserta nada; `pagos.is_reversed` se marca solo para NC `tipo='TOTAL'`. [Spec notas-credito-pos: Impacto condicional — Regla de Oro; Spec caja: Consumo de egreso condicional]
- [x] 2.2 GREEN: extend `crearNotaCredito` params with `entryPoint: 'POS' | 'TRADICIONAL'` and `sesionCajaActivaId?: string`; implement condition `entryPoint==='POS' && modalidad==='EFECTIVO_REAL' && venta.sesion_caja_id===sesionCajaActivaId` gating the `movimientos_metodo_cobro` EGRESO insert (reuse `doc_origen_id=ncrId`, no new FK). [Design §4]. **Note**: slice 2 has no `modalidad` param yet (lands in slice 3) — `crearNotaCredito` only supports the TOTAL/implicit-EFECTIVO_REAL flow today, so the condition is implemented as `entryPoint==='POS' && venta.sesion_caja_id===sesionCajaActivaId` (documented in code comment); slice 3 will thread the real `modalidad` value through.
- [x] 2.3 GREEN: loop `pagos` for the venta, `UPDATE pagos SET is_reversed=1 WHERE venta_id=? AND is_reversed=0` — only when NC `tipo='TOTAL'` (PARCIAL never flips this, per Design §3).
- [x] 2.4 Wire `entryPoint`/`sesionCajaActivaId` from `crear-ncr-modal.tsx` call site (pass current session context via `useCurrentUser`/caja store). **Note**: `crear-ncr-modal.tsx`/`notas-credito-page.tsx` IS the Tradicional module (dedicated NC screen, searches ANY factura) — wired `entryPoint: 'TRADICIONAL'` there; no POS-express entry point exists yet (that UI lands in Slice 5a), so `sesionCajaActivaId` wiring for the POS path is deferred to 5a.
- [x] 2.5 Verify: `yarn test:run` + `yarn type-check:test` green; confirm `use-cuadre.ts` is untouched (grep diff — zero lines changed in that file, per Design confirmation).

## Slice 3 — Liquidation modalities (SALDO_FAVOR, AJUSTE_CXC) + no-desembolso gate (Design §Regla de Oro condition, Spec notas-credito-liquidacion)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~260–320 |
| 400-line budget risk | Medium (monitor) |
| Chained PRs | No — single PR, but close to budget; do not add scope |

- [x] 3.1 **Decision task — COMPENSACION_VENTA shape**: implement as design's accepted tradeoff — TWO sequential transactions, NOT one mega-tx. `crearNotaCredito` always emits a SAFC leftover via `registrarSafExcedente` when `modalidad==='COMPENSACION_VENTA'`; the caller (slice 5 UI) makes a SEPARATE `crearVenta()` call that consumes the SAFC via the existing `safEntry` mechanism. Add a code comment at the call site documenting this is intentional (not itself a design flaw) and a test asserting `crearNotaCredito` does NOT internally call `crearVenta`. [Design §3 — open question, resolved here]. **Note**: within this slice, `COMPENSACION_VENTA` behaves IDENTICALLY to `SALDO_FAVOR` inside `crearNotaCredito` (same inlined SAFC write) — the "second transaction" is a caller-level convention deferred to Slice 5 UI, documented in code comments; `crearVenta` is mocked in tests and asserted never called.
- [x] 3.2 RED: tests for modalidad matrix — `SALDO_FAVOR` inserts a SAFC `movimientos_cuenta` traceable to `nota_credito_id` (via `doc_origen_id`), zero caja/banco writes; `AJUSTE_CXC` reduces `clientes.saldo_actual` via `movimientos_cuenta`, zero caja writes; gate (`assertGateAntiFraudeNoDesembolso`) rejects a forced cash-out param (`egresoParams`) when modalidad is non-cash, called directly (function-level, no UI). [Spec notas-credito-liquidacion: Gate anti-fraude de no-desembolso]
- [x] 3.3 GREEN: added `modalidad: 'EFECTIVO_REAL' | 'SALDO_FAVOR' | 'COMPENSACION_VENTA' | 'AJUSTE_CXC' | 'REFUND_TESORERIA'` (matches design.md's full 5-value interface, not the 4-value informal summary — REFUND_TESORERIA validated but throws `not implemented` until slice 6) as required param; implemented the anti-fraude gate as a pure function called BEFORE `db.writeTransaction` even opens (stricter than "before any DB write" — never touches the DB at all): throws if `egresoParams` is set and modalidad is non-cash.
- [x] 3.4 GREEN: implemented `AJUSTE_CXC` branch (Step B) reusing the existing saldo-reduction pattern from Step A (lines ~440–478, tope en 0) adapted to the new modalidad switch; implemented `SALDO_FAVOR`/`COMPENSACION_VENTA` branch INLINE (not calling the standalone `registrarSafExcedente`, which opens its own nested `db.writeTransaction` — would break the single-tx atomicity constraint) reusing its exact SQL pattern, with `doc_origen_id=ncrId`/`doc_origen_tipo='NCR'` added for traceability per spec.
- [x] 3.5 Verify: `yarn test:run` (859/859) + `yarn type-check:test` green.

**Additional slice-3 work (mandatory per obs #2814 + #2812, folded into this slice per orchestrator instructions)**:
- Fixed the latent Regla de Oro hazard: `aplicaReglaDeOro` now requires `modalidad === 'EFECTIVO_REAL'` in addition to `entryPoint`/session-match. Regression test pins this (`REGRESION obs #2814`).
- Removed the unused `pago.moneda_id` dead select in step 5c.
- Reconciled EFECTIVO_REAL wording in `specs/notas-credito-liquidacion/spec.md` (added a clarifying note distinguishing it from the 4 selectable modalities).

## Slice 4a — Pure fiscal-breakdown + double-credit-guard module (Design §2 partial-NC fiscal breakdown)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~260–320 |
| 400-line budget risk | Medium (monitor) |
| Chained PRs | Yes — 4a/4b split (see below) |

- [x] 4a.1 RED: new `src/features/ventas/utils/__tests__/notas-credito-fiscal.test.ts` (pure-module pattern, mirrors `recibo-pagos.ts` precedent) — table-driven cases for `calcularDesgloseLineaNC(linea, ventaTasa)`: Exento line → `totalExentoUsd`; Base+IVA line → `totalBaseUsd`+`totalIvaUsd` (same formula as `use-ventas.ts` lines 398–408); mixed-alícuota multi-line PARCIAL; tasa histórica = `venta.tasa` verbatim regardless of tasa vigente today.
- [x] 4a.2 RED: same file — `validarTopeDobleCredito(ventaDetId, cantidadDevolver, yaAcreditado)` cases: rejects when `SUM(ya acreditado) + cantidadDevolver > cantidad original de la línea`; accepts when within remaining quantity. [Design §2 — "gap real no cubierto por el trigger existente"]. **Note**: implemented signature takes an input object `{ ventaDetId, cantidadOriginalLinea, yaAcreditado, cantidadDevolver }` instead of 3 positional args — `cantidadOriginalLinea` is required for the comparison ("cantidad original de la línea") and wasn't spelled out in the shorthand signature; object-param style matches the module's own established convention (`CalcularCierreVentaConSafInput`, `LineaNcOrigen`). Not an algorithm ambiguity, purely an ergonomic signature clarification.
- [x] 4a.3 GREEN: implemented `src/features/ventas/utils/notas-credito-fiscal.ts` — zero DOM/tx dependencies, pure functions only (Decimal.js), exporting `calcularDesgloseLineaNC`, `validarTopeDobleCredito`, and query-shape helpers `buildSumCantidadYaAcreditadaQuery` + `mapSumCantidadYaAcreditadaRow` (SQL string + row-mapping, tx-agnostic — mirrors `buildStockPorDepositoFragments` precedent). Query additionally scopes by `empresa_id` (multi-tenant defense in depth per CLAUDE.md rule 11), documented `paramsOrder: ['ventaDetId', 'empresaId']` for the 4b caller.
- [x] 4a.4 Verify: `yarn test:run` (880/880, 80 files) + `yarn type-check:test` green. This PR has NO integration wiring — pure module + tests only (same shape as the `recibo-pagos.ts` PR1 precedent). App code: 188 lines (well under 400-line budget).

## Slice 4b — Wire PARCIAL into `crearNotaCredito` atomic tx (Design §3 atomic tx shape, §2 venta_det_id FK)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~260–320 |
| 400-line budget risk | Medium (monitor) |
| Chained PRs | Yes — depends on 4a |

- [x] 4b.1 RED: extend `use-notas-credito.test.ts` — TOTAL regression (still passes unchanged, now also asserts `notas_credito_det` is populated per línea and header desglose columns); PARCIAL happy path with subset+partial-quantity selection; PARCIAL double-credit rejected (reuses 4a guard, zero writes on rejection); PARCIAL Kardex reingresa solo las líneas seleccionadas (no toda la venta); PARCIAL servicio (`tipo='S'`) no genera movimiento por receta cuando esa línea no fue seleccionada. Added 5th test for the generalized Step A/Step B split on a CREDITO factura with partial pending debt.
- [x] 4b.2 GREEN: extended `CrearNotaCreditoParams` with `tipo?: 'TOTAL' | 'PARCIAL'` (default `'TOTAL'` when omitted — preserves byte-identical pre-4b behavior) and `lineas?: { venta_det_id: string; cantidadDevolver: string }[]`; when `tipo==='TOTAL'`, `lineas` is derived from ALL `ventas_det` rows (any passed `lineas` value is ignored for TOTAL, per Design §2 "mismo codigo, sin ramas duplicadas").
- [x] 4b.3 GREEN: per selected línea — `buildSumCantidadYaAcreditadaQuery`/`mapSumCantidadYaAcreditadaRow` (4a) execute a REAL query scoped `venta_det_id + empresa_id`, feed `validarTopeDobleCredito` (4a) BEFORE any write (throws → whole tx aborts, nothing persists); `calcularDesgloseLineaNC` (4a) computes the per-línea fiscal breakdown; `INSERT INTO notas_credito_det` (`venta_det_id`, `subtotal_usd`, `subtotal_bs`, `tipo_impuesto`, `impuesto_pct`, `cantidad`, `afecta_inventario`, `descripcion`, `lote_id`) per línea — previously NEVER written (explore finding #10), now always written for both TOTAL and PARCIAL. The Kardex/receta loop was rewritten to iterate `desglosesPorLinea` (selected líneas + selected quantity) instead of the full `ventas_det` result set.
- [x] 4b.4 GREEN: `notas_credito` header INSERT now writes `total_exento_usd`/`total_base_usd`/`total_iva_usd` (previously always 0) by summing `calcularDesgloseLineaNC` results across selected líneas via `Array.reduce`. **Deviation (documented, not guessed)**: `total_usd`/`total_bs` for `tipo==='TOTAL'` preserve `venta.total_usd`/`venta.total_bs` VERBATIM (byte-identical to pre-4b) rather than re-deriving from the line-sum, because `venta.total_usd` includes cargos especiales and nets out descuento comercial — neither of which live in `ventas_det` — so summing lines would silently diverge from the original invoice total. For `tipo==='PARCIAL'`, `total_usd`/`total_bs` ARE the line-sum (`totalExentoUsd+totalBaseUsd+totalIvaUsd`, `usdToBs(...)`) — the only possible definition, since there is no "whole invoice" reference for a partial credit. `notas_credito.moneda_id` was deliberately left unpopulated — `ventas.moneda_id` itself is never populated by `crearVenta` either (no established source of truth to propagate), and it is not required by this task or by Design §Interfaces.
- [x] 4b.5 Verify: `yarn test:run` (885/885, 80 files) + `yarn type-check:test` green; the existing Postgres trigger (tope acumulado por factura, `validate_nota_credito_insert`) remains untouched and still fires as defense-in-depth alongside the new per-línea guard — not a replacement (Design §3 cross-cutting invariant confirmed, no migration changes in this slice).

**Additional slice-4b work / discoveries (documented, not silently guessed)**:
- Generalized Step A (reduce `ventas.saldo_pend_usd` / `clientes.saldo_actual` for already-pending debt) and Step B (liquidate the already-paid remainder via the chosen modalidad) to a `Decimal.min`/`Decimal.max` clamp against `totalUsdNc` (this NC's own value) instead of the whole-invoice `venta.total_usd`/`venta.saldo_pend_usd`. Proven to be byte-identical to the pre-4b TOTAL formula (`totalUsdNc === venta.total_usd` for TOTAL, and `total_usd >= saldo_pend_usd` is an invariant of `ventas`, so `montoAplicadoAPendiente === saldoPendVenta` always for TOTAL) while correctly scaling down for PARCIAL. Covered by a dedicated CREDITO-factura test (partial pending debt split across Step A + Step B).
- `ventas` status/`saldo_pend_usd` UPDATE now branches: `tipo==='TOTAL'` keeps the exact pre-4b literal (`status='ANULADA'`, `saldo_pend_usd='0.00'`); `tipo==='PARCIAL'` never touches `status` (factura stays `ACTIVA`) and writes the generalized `nuevoSaldoPendVenta`.
- **Known, documented gap (NOT fixed in this slice, out of 4b's task list)**: the Regla de Oro egreso + pagos-reversal block (Step 6c) stays gated by `tipoNc === 'TOTAL'` exactly as pre-4b — Design §3 paso 8 explicitly states pagos are never reversed for PARCIAL. This means `remanenteALiquidar` for a hypothetical `PARCIAL + EFECTIVO_REAL` combination is computed but not consumed (Step B's switch has no `EFECTIVO_REAL` branch, matching pre-4b TOTAL behavior where `EFECTIVO_REAL` liquidation only ever happened via Step 6c). This combination is NOT reachable today: the only caller (`crear-ncr-modal.tsx`) always passes `entryPoint: 'TRADICIONAL'`, and `aplicaReglaDeOro` requires `entryPoint === 'POS'`, which has no UI until Slice 5a. Flagged explicitly for Slice 5a to address when the POS PARCIAL entry point is wired — not a silent omission.
- Review-workload note: `use-notas-credito.ts` diff is 336 insertions / 166 deletions (502 changed lines total; insertions-only stays under the 400-line app-code convention used in slices 3/4a, but the raw additions+deletions total exceeds it). The high deletion count reflects necessary restructuring of already-tightly-coupled existing code (renaming `saldoPend`→`saldoPendVenta`, splitting the single Kardex loop into a guard+desglose pass followed by a det+kardex pass, generalizing Step A/Step B formulas) rather than scope creep — every deleted line corresponds to logic that had to change to support PARCIAL correctly. Flagged for the user/verify phase per `ask-on-risk` rather than silently claimed compliant.

## Slice 5a — Dual PIN + depósito picker wiring (Design invariant, Spec notas-credito-pos + deposito-inactivo-guard delta)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~200–260 |
| 400-line budget risk | Low-Medium |
| Chained PRs | Yes — depends on 4b |

- [x] 5a.1 RED (where testable — PIN gating logic, not the dialog itself): unit tests for "permiso `ventas.nota_credito` presente → sin PIN de emisión" vs "ausente → exige PIN de emisión"; "segundo PIN de supervisor desbloquea selector explícito de depósito" vs "sin segundo PIN → riel automático (origen si activo, principal si no)". **Note**: implemented as `src/features/ventas/utils/notas-credito-pin-gating.ts` — `requierePinEmisionNc`, `puedeElegirDepositoExplicito`, and a third pure bridge `resolverDepositoOverride` (documents the exact `null`-means-"sin override, riel automático" contract that Slice 5a-2 will thread into `CrearNotaCreditoParams.depositoReingresoId`). 7 tests, all pure/no I/O.
- [x] 5a.2 GREEN (ORIGINAL, since corrected below): wired two independent `SupervisorPinDialog` instances in `crear-ncr-modal.tsx` (mirror existing dual-PIN patterns in `cobro-modal.tsx`/`pos-terminal.tsx`) — PIN A (emisión, permission-gated) and PIN B (segundo PIN, depósito override only). PIN A uses `requiredPermission={PERMISSIONS.SALES_NOTA_CREDITO}`; PIN B uses the component's default (`ventas.anular`) — no dedicated slug exists for deposito override. **Discrepancy noted, not silently resolved**: the `notas-credito-pos` spec's "Modelo de doble PIN" requirement text is scoped to the POS domain, and `deposito-inactivo-guard`'s Tradicional-scoped ADDED requirement says explicit choice "sin riel automático" without mentioning a PIN; obs #2802 decision 4 similarly says "Admin siempre puede elegir depósito explícito" (no PIN for the Tradicional/admin module). Despite this, both this task's literal text and the orchestrator's slice-5a brief explicitly and repeatedly require PIN B inside `crear-ncr-modal.tsx` (Tradicional) — implemented as instructed (extra friction, safer default for a fraud-sensitive domain), flagged here for the user/verify phase rather than silently deviating either way.
- [x] 5a.3 GREEN (ORIGINAL, since corrected below): Tradicional module — new depósito selector component reusing `useDepositosVentaActivos` (per deposito-inactivo-guard delta spec, "Reingreso con Elección Explícita"), filtered `empresa_id`, excludes inactive depósitos. Locked by default (shows an informational "automático" message + "Cambiar depósito" link); unlocks into a live `NativeSelect` once PIN B authorizes. **Scope boundary (resolved, not ambiguous — obs #2831 explicit)**: the selected `depositoElegidoId` is captured in local component state only; `CrearNotaCreditoParams.depositoReingresoId` (Design §Interfaces) is NOT added/threaded into `crearNotaCredito` in this slice — obs #2831 explicitly assigns that threading to Slice 5a-2 ("depositoIdOverride threaded en crearNotaCredito tx"), documented inline in `submitAnulacion()`.
- [x] 5a.4 Verify (ORIGINAL): `yarn test:run` (892/892, 81 files) + `yarn type-check:test` green.
- [x] **CORRECTION (obs #2835, definitive PIN rule, follow-up commit on the same branch)**: the discrepancy flagged in 5a.2 is RESOLVED — the Tradicional dedicated screen NEVER requires a PIN (it is already access-gated: only users with permission to reach the route see it). Removed BOTH `SupervisorPinDialog` instances (PIN A emisión, PIN B depósito override) from `crear-ncr-modal.tsx`. The `useDepositosVentaActivos` + `NativeSelect` picker from 5a.3 is KEPT but now UNLOCKED from the start — no lock icon, no "Cambiar depósito" link, no PIN gate — per `deposito-inactivo-guard`'s literal "sin preselección automática silenciosa" wording (no default value is pre-filled either; the correction brief's suggested "default = rails-resolved deposito" was NOT implemented because it would require a new query for `venta.deposito_id`/`is_active` duplicating tx-internal logic AND would contradict the spec's explicit "no silent preselection" — flagged, not silently resolved, resolved in favor of the authoritative spec text). `notas-credito-pin-gating.ts` and its 7 tests are UNCHANGED in logic — only the module/test docblocks were updated to state the module is now reserved for the POS entry point (Slice 5a-2), not consumed by Tradicional anymore. `depositoReingresoId` threading into `crearNotaCredito` remains DEFERRED to Slice 5a-2 (obs #2831, unchanged decision — not reopened by this correction). New RTL test suite added: `crear-ncr-modal.test.tsx` (4 tests, TDD RED confirmed against the pre-correction PIN-wired code, then GREEN after removal). Net diff: -49 lines across `crear-ncr-modal.tsx` (124 changed, mostly deletions) + `notas-credito-pin-gating.ts`/`.test.ts` (docblock-only). Full suite after correction: `yarn test:run` → 896/896 (82 files) + `yarn type-check:test` clean.

## Slice 5a-2a — POS entry point + PIN A + depositoReingresoId threading (obs #2841/#2842 split of Slice 5a-2)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~350–400 (session forecast, obs #2841) |
| Actual changed lines | **802** (193 depositoReingresoId threading + 609 POS entry point) — forecast was significantly undershot |
| 400-line budget risk | **High (realized)** — see note below |
| Chained PRs | Yes — committed as 2 separate work units on `feat/notas-credito-s5a2-pos-entry` (off `slice-5a`, feature-branch-chain), ready to become 2 child PRs |

**Budget note (not silently absorbed)**: this slice's own pre-write forecast (~350–400) turned out to be wrong once TDD tests were written alongside the app code — actual is 802 changed lines across 9 files. Split into 2 commits: (1) `depositoReingresoId` threading, 193 lines, self-contained, fits budget; (2) POS entry point (hook + self-contained modal + wiring), 609 lines, still over budget as a single unit — the modal (272) + its RTL test (194) + the picker hook (44+60) + minimal `pos-terminal.tsx` wiring (39) do not split further without either separating tests from the behavior they verify (against `work-unit-commits` rules) or cutting scope already trimmed to its minimum (no PIN B, no deposito selector, no full line-item detail table, TOTAL-only). Flagged for the user/orchestrator to decide before PR creation: accept `size:exception` for commit 2, or cut it into a further sub-slice.

- [x] 5a-2a.1 RED+GREEN: `depositoReingresoId?: string` added to `CrearNotaCreditoParams`; validated (active + same empresa) inside the tx before any kardex write when provided; falls back to the existing automatic rail (`resolveDepositoReingresoNcr`) when omitted. [Design §Interfaces; obs #2840]
- [x] 5a-2a.2 GREEN: wired the Tradicional selector in `crear-ncr-modal.tsx` (previously local-state only, no-op since Slice 5a) to actually thread `depositoElegidoId` into `crearNotaCredito`. Closes the WARNING left open by Slice 5a verify (obs #2839/#2840).
- [x] 5a-2a.3 RED+GREEN: new `useFacturasSesionActiva` hook (`src/features/ventas/hooks/use-facturas-sesion-activa.ts`) — query-enforced (not UI-hidden) to `empresa_id` + the caller's currently open `sesion_caja_id`; a voided or historical-session invoice can never reach this list. [Spec notas-credito-pos: Alcance limitado a la sesion activa]
- [x] 5a-2a.4 RED+GREEN: new `NotaCreditoPosModal` (`src/features/ventas/components/nota-credito-pos-modal.tsx`) — self-contained (does NOT import/touch `cobro-modal.tsx` state or `facturas-espera-store.ts`). Lists session invoices, modalidad selector (EFECTIVO_REAL/SALDO_FAVOR/AJUSTE_CXC/COMPENSACION_VENTA — `REFUND_TESORERIA` excluded per Design/task 6.3, Tradicional-only), motivo input. PIN A only (`SupervisorPinDialog`, gated by lack of `ventas.nota_credito` — obs #2835 definitive rule); PIN B (deposito override) explicitly deferred to Slice 5a-2b. TOTAL only (`tipo` omitted, defaults inside `crearNotaCredito`) — NC PARCIAL from POS is a separate future slice (obs #2842), not built here.
- [x] 5a-2a.5 GREEN: `pos-terminal.tsx` — button wired desktop (Row 3) + mobile (Row 1), visible whenever a session is open, independent of `canMovManualPos`/`canCloseCajaPos` (PIN A inside the modal is the real authorization gate, not button visibility). Modal rendered as a sibling dialog; `showNotaCreditoModal` added to the `anyModalOpen` keyboard-shortcut guard.
- [x] 5a-2a.6 Verify: `yarn test:run` (909/909, 84 files) + `yarn type-check:test` clean. EFECTIVO_REAL reachable via the real POS caller (component test asserts `crearNotaCredito` called with `entryPoint:'POS'`+`modalidad:'EFECTIVO_REAL'`+matching `sesionCajaActivaId`); the obs #2814 SALDO_FAVOR-no-egreso scenario is now reachable via that same real caller (component test asserts `modalidad:'SALDO_FAVOR'` is correctly passed) — the actual DB-level egreso-fires/no-fires assertions already existed in `use-notas-credito.test.ts` since Slice 2/3; this slice closes the "no real UI caller existed" gap, not the DB-level behavior (already proven).

**Deferred to Slice 5a-2b (next, chained off this branch)**: PIN B — POS deposito override (second `SupervisorPinDialog`, `NativeSelect` bound to `useDepositosVentaActivos`, wiring `resolverDepositoOverride` into the `depositoReingresoId` param this slice already added).

## Slice 5a-2b — PIN B, POS deposito override (FINAL slice of Change 1, obs #2842/#2843 split)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~150–200 |
| Actual changed lines | **215** (204 ins/11 del, single commit `d35b1e1`) — within budget |
| 400-line budget risk | Low (realized) |
| Chained PRs | Yes — chained off `feat/notas-credito-s5a2-pos-entry` (5a-2a) as `feat/notas-credito-s5a2b-pin-deposito` |

- [x] 5a-2b.1 RED+GREEN (Strict TDD): second `SupervisorPinDialog` instance in `NotaCreditoPosModal` (`nota-credito-pos-modal.tsx`) — PIN B, gates the deposito-de-reingreso override. SEPARATE state (`showPinDeposito`/`pinDepositoAutorizado`) from PIN A's (`showPin`), distinct `titulo` ("Cambiar deposito de reingreso" vs "Emision de Nota de Credito"). By default (PIN B not authorized) the deposito section shows "Automatico (riel de deposito principal)" + a "Cambiar deposito" button; no selector rendered. [Spec notas-credito-pos "Modelo de doble PIN"; obs #2835 Opcion B deliberate friction]
- [x] 5a-2b.2 RED+GREEN: once PIN B authorizes, a `NativeSelect` bound to `useDepositosVentaActivos()` (reused unchanged — same hook/component as the Tradicional selector, filtered `empresa_id` + `is_active=1` + `permite_venta=1`) replaces the "Automatico" text. The chosen value flows through `resolverDepositoOverride` (from `notas-credito-pin-gating.ts`, reused unchanged — first real consumer of this pure function since it was written in Slice 5a) into `crearNotaCredito`'s `depositoReingresoId` param (accepted + validated since 5a-2a). No override authorized/chosen → `undefined` → existing rail unchanged.
- [x] 5a-2b.3 RED+GREEN: PIN A and PIN B proven independent via a dedicated test — no emission permission means confirming still requires PIN A even after PIN B already authorized the deposito choice; both PINs can be required in the same emission, sequentially, never merged.
- [x] 5a-2b.4 Verify: `yarn test:run` → **914/914 passing, 84 test files** (909 prior + 5 new, 0 regressions). `yarn type-check:test` → clean.

**TDD Cycle Evidence** (RED confirmed via real failing test output before GREEN):

| Test | RED | GREEN | REFACTOR |
|---|---|---|---|
| Selector locked by default (text + button, no combobox) | Failed — button/text not found | Passes after UI block added | None needed |
| "Cambiar deposito" opens a SEPARATE PIN dialog from PIN A | Failed — button not found | Passes after 2nd `SupervisorPinDialog` wired | None needed |
| PIN B authorized → selector appears → chosen value reaches `depositoReingresoId` | Failed — no selector, no param | Passes after `resolverDepositoOverride` wired into `emitirNc` | None needed |
| PIN B authorized, no choice yet → still `undefined` (rail preserved) | Failed (state didn't exist) | Passes — `resolverDepositoOverride` returns `null` until a choice is made | None needed |
| PIN A and PIN B independent (both required across the same emission) | Failed twice — mock's "Autorizar" button didn't also call `onClose`, leaving a stale dialog open in the assertion; fixed the **test mock**, not the component, to match `SupervisorPinDialog`'s real `onAuthorized` → `onClose` order | Passes after mock fix | None needed |

**Change 1 (`notas-credito`) is now FEATURE-COMPLETE.** Slices 1–5a-2b delivered: fiscal codes/kardex/CxC (1–4b), Tradicional dedicated screen with free deposito selector and no PIN (5a, corrected by obs #2835), `depositoReingresoId` threaded into both callers (5a-2a), POS-express entry point with session-scoped invoice picker + PIN A emission-by-lack-of-permission (5a-2a), and PIN B deposito override with `useDepositosVentaActivos`/`NativeSelect` (5a-2b, this slice). Remaining for Change 2 (separate, not started): printable document (Slice 7), reporting/Z (Slice 8), refund-tesoreria modalidad wiring, plus deferred debts tracked in obs #2812/#2820/#2823/#2845.

## Slice 5b — PARCIAL line-selection UI (POS + Tradicional) (Spec notas-credito-emision)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~180–230 |
| 400-line budget risk | Low |
| Chained PRs | Yes — depends on 5a and 4b |

- [ ] 5b.1 Extend `crear-ncr-modal.tsx` (or split into a Tradicional-specific modal if the TOTAL-only dialog diverges too much): checkbox + qty-input per `ventas_det` línea, disabled beyond remaining-creditable qty (surface 4a's `sumCantidadYaAcreditada` result in the UI as a hint, not just a hard DB error).
- [ ] 5b.2 Wire `entryPoint`/modalidad selector (SALDO_FAVOR/COMPENSACION_VENTA/AJUSTE_CXC, REFUND_TESORERIA hidden until slice 6 lands) into the confirm action, calling the slice 4b `crearNotaCredito` signature.
- [ ] 5b.3 Verify: manual smoke test (TOTAL still default/fastest path in POS) + `yarn type-check` clean.

## Slice 6 — REFUND_TESORERIA (conditional, standalone) (Design §5 "no new schema needed", Spec notas-credito-liquidacion)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~220–260 |
| 400-line budget risk | Low-Medium |
| Chained PRs | No — single PR, safely postponable to a follow-up change if the chain needs to be cut short (zero dependents in slices 7–8) |

- [ ] 6.1 RED: tests — `REFUND_TESORERIA` inserts into `movimientos_bancarios` or `mov_caja_fuerte` (per chosen origen) with `validado=0`; `doc_origen_id`/reference links back to `nota_credito_id`; zero writes to `movimientos_metodo_cobro` of the active POS session (Regla de Oro: `$0.00` impact on active cajón regardless of the NC's originating session).
- [ ] 6.2 GREEN: implement `REFUND_TESORERIA` branch in the modalidad switch from slice 3, gated by the same no-desembolso rule (this IS the one modalidad allowed to move real money outside the POS drawer).
- [ ] 6.3 GREEN: liquidation UI exposes `REFUND_TESORERIA` as an option only in Tradicional (never POS-express, per scope).
- [ ] 6.4 Verify: `yarn test:run` + `yarn type-check:test` green; confirm existing conciliación bancaria screen picks up the `validado=0` row with zero changes to that screen (additive, per Design "no new schema needed").

## Slice 7 — Printable document (Spec notas-credito-emision, precedent: recibo-pagos)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~260–340 |
| 400-line budget risk | Medium (monitor) |
| Chained PRs | No — single PR |

- [ ] 7.1 RED: pure data-prep function tests (mirror `recibo-pagos.ts` precedent) — `construirDatosImpresionNC(nc, det, venta)` producing the printable shape (header, líneas, desglose fiscal, modalidad de liquidación).
- [ ] 7.2 GREEN: implement the pure prep function; extend/reuse `factura-export.ts` jsPDF machinery for an NC layout (or new `nota-credito-export.ts` if the layout diverges enough to avoid entangling with factura printing).
- [ ] 7.3 GREEN: wire a print/export action from the NC detail view and from `crear-ncr-modal.tsx` post-success toast.
- [ ] 7.4 Verify: `yarn test:run` + `yarn type-check:test` green; manual PDF/PNG check per recibo precedent (no automated visual regression exists).

## Slice 8 — Reporting Z + cross-link NC# (Spec caja: Consumo de egreso condicional — display only, formula NOT touched)

### Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~200–280 |
| 400-line budget risk | Low-Medium |
| Chained PRs | No — single PR |

- [ ] 8.1 RED: tests for the cross-link query — egreso detail row resolves `doc_origen_id` → `nro_ncr` when `origen='NCR'`; confirms `empresa_id` isolation.
- [ ] 8.2 GREEN: reporting/detail component join (NOT `use-cuadre.ts` core formula — that file stays untouched per Design confirmation) to display `nro_ncr` next to NC-originated egresos in the Reporte Z breakdown.
- [ ] 8.3 GREEN: NC listing (`useNotasCredito`) — add modalidad/sesión filters for reporting.
- [ ] 8.4 Verify: `yarn test:run` + `yarn type-check:test` green; grep diff on `use-cuadre.ts` to confirm zero lines changed (hard invariant from Design).

## Cross-cutting invariants (apply to every slice above)

- Migration 0091 is a NEW file — never edit 0006 or any applied migration.
- Every NC query filters `empresa_id`.
- Financial immutability: `notas_credito`/`notas_credito_det`/`movimientos_inventario`/`movimientos_cuenta`/`libro_contable` are INSERT-only.
- Regla de Oro egreso only ever targets the ACTIVE session (`sesion_caja_id` match required, not just "any open session").
- `use-cuadre.ts` is NOT modified anywhere in this change (verified additive per Design).
- PowerSync convention: booleans → `column.integer`, decimals → `column.text`.
- Slice 5b's `crear-ncr-modal.tsx` changes replace the OLD `crearNotaCredito` call at line 44 — update that call site and its existing test (`use-notas-credito.test.ts`) together, never leave them out of sync.
