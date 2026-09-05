# Tasks: Notas de Crédito — Origen de Dinero Configurable + Cuadre

**Test runner cache**: `yarn test:run` (Vitest single-run), `yarn type-check` (app), `yarn type-check:test` (tests). **`yarn` NEVER `npm`.** Strict TDD — every pure function/validation is RED (failing test) → GREEN (implementation) before the component/hook that consumes it. Real money/kardex/CxC/cuadre paths: RED-first is non-negotiable, no exceptions.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1900–2300 total across 6 slices |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | 6 PRs, one per slice, feature-branch-chain |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Per-slice estimate

| Slice | Est. lines | >400 alone? | Depends on |
|---|---|---|---|
| 1 Schema | 60–90 | No | None — base of tracker |
| 2 Decouple regla de oro | 350–450 | Borderline | Slice 1 (`entry_point`) |
| 3 REFUND_TESORERIA | 300–400 | Borderline | Slice 2 (`origenDinero` shape) |
| 4 Selector + guard | 350–450 | Borderline | Slice 2 (shape) + Slice 3 (write path) |
| 5 Cuadre | 400–500 | Yes — new harness | Slice 4 (`sesion_caja_id` write) |
| 6 Badge | 40–70 | No | Slice 1 (`entry_point` column) |

**Overall**: ≈1900–2300 lines total; every mid-chain slice is at/above 400 alone → chained PRs mandatory (matches proposal.md).

### Suggested Work Units (feature-branch-chain)

| Unit | Goal | Branch → Base |
|---|---|---|
| 1 | Migration 0092 + schema.ts + persist at INSERT | `ncr-cuadre-01-schema` → `feat/ncr-cuadre-origen-dinero` (tracker) |
| 2 | `origenDinero` shape, validation, drop same-session rule, rewrite tests | `ncr-cuadre-02-decouple` → `01-schema` |
| 3 | REFUND_TESORERIA write branch | `ncr-cuadre-03-refund-tesoreria` → `02-decouple` |
| 4 | Selector + guard UI, both modals | `ncr-cuadre-04-selector-guard` → `03-refund-tesoreria` |
| 5 | Cuadre hooks + component | `ncr-cuadre-05-cuadre` → `04-selector-guard` |
| 6 | Badge "vía administración" | `ncr-cuadre-06-badge` → `05-cuadre` |

Only the tracker merges to `develop` (opened draft/no-merge from the start). Each PR targets the immediately-previous slice branch (except PR #1 → tracker), keeping every diff focused.

**Delivery note**: tester is on a different PC — push each slice branch to `origin` before requesting QA on it.

---

## Phase 1: Schema (Slice 1 — `entry_point`)

- [x] 1.1 RED: assert (extend `use-notas-credito.test.ts` insert-shape check) that the `notas_credito` INSERT includes `entry_point: params.entryPoint`. Must fail now.
- [x] 1.2 GREEN: `migrations/0092_notas_credito_entry_point_refund.sql` — `ADD COLUMN IF NOT EXISTS entry_point TEXT` → backfill `CASE WHEN sesion_caja_id IS NOT NULL THEN 'POS' ELSE 'TRADICIONAL' END` → `SET NOT NULL` → `SET DEFAULT 'TRADICIONAL'` → `CHECK (entry_point IN ('POS','TRADICIONAL'))`. Idempotent per `0091` template.
- [x] 1.3 Same migration: `mov_caja_fuerte_origen_check` DROP/ADD, append `'REFUND_NCR'` to the 5 existing values (`0035:39`).
- [x] 1.4 Same migration: `movimientos_bancarios_origen_check` DROP/ADD, append `'REFUND_NCR'` to the 8 existing values (`0077:24-26`). Document rollback (restore both CHECKs) in the header.
- [x] 1.5 GREEN: add `entry_point: column.text` to `notas_credito` in `schema.ts` (`:753-778`).
- [x] 1.6 GREEN: persist `entry_point: params.entryPoint` at the existing INSERT (`use-notas-credito.ts:603-629`) — passes 1.1.
- [x] 1.7 Verify green (`type-check`, `type-check:test`, `test:run`). Push `ncr-cuadre-01-schema`, open PR #1 → base tracker (draft).

## Phase 2: Decouple "regla de oro" (Slice 2)

- [x] 2.1 RED: rewrite the describe blocks asserting the old same-session boolean — flip to expect the `origenDinero` shape and dropped same-session rule. Must FAIL until 2.3–2.5.
- [x] 2.2 RED: add validation cases (pure, pre-tx): `EFECTIVO_REAL` + non-`SESION_EFECTIVO` → throw; `REFUND_TESORERIA` + `SESION_EFECTIVO` → throw; no-desembolso + `origenDinero` defined → throw; `entryPoint==='POS'` + `SESION_EFECTIVO` + `cuentaId !== sesionCajaActivaId` → throw (Decision 4).
- [x] 2.3 GREEN: add `origenDinero: { tipo: 'SESION_EFECTIVO'|'TESORERIA_EFECTIVO'|'BANCO', cuentaId: string }` (optional) to `CrearNotaCreditoParams`.
- [x] 2.4 GREEN: implement the pre-tx validation function per design.md lines 45-52 — passes 2.2. (`validarOrigenDinero`, exported, pure.)
- [x] 2.5 GREEN: replace the boolean at `:418-422` with `movesCash` (= `!esModalidadNoDesembolso(modalidad)`). Drop the same-session-as-sale requirement — passes 2.1. (Deviation: `sesionValida`/`sesionStatus(cuentaId)==='ABIERTA'` NOT implemented here — the closed-session DB read is explicitly Slice 4's task 4.4/4.7 "write-time SELECT"; implementing it now would duplicate that slice. Within the tx, `movesCash` is only ever true for `EFECTIVO_REAL` — `REFUND_TESORERIA` already threw before the tx opened — so no `TESORERIA_EFECTIVO`/`BANCO` write can reach here yet.)
- [x] 2.6 GREEN: update the `SESION_EFECTIVO` write loop (`:867-885`) to use `sesion_caja_id: origenDinero?.cuentaId ?? null` (Decision 4 cuadre invariant).
- [x] 2.7 Verify green; zero old-boolean (`aplicaReglaDeOro`) references remain. Committed locally on `feat/ncr-cuadre-02-decouple` (base `feat/ncr-cuadre-01-schema`) — NOT pushed, NOT PR'd (executor scope, orchestrator handles delivery).

## Phase 3: REFUND_TESORERIA (Slice 3)

- [ ] 3.1 RED: rewrite `:699-707` (currently expects reject) to assert the new EGRESO shape for `TESORERIA_EFECTIVO` → `mov_caja_fuerte`/`caja_fuerte`. Must fail against `:363-365` throw.
- [ ] 3.2 RED: mirror for `BANCO` → `movimientos_bancarios`/`bancos_empresa`. Extend `NcrTxFixtures` (`:122-139`) with `cajaFuerte`/`bancoEmpresa` saldo rows.
- [ ] 3.3 RED: Decimal-precision assertions (`saldo_anterior`/`saldo_nuevo`/`monto` via `.toFixed(4)`, never `parseFloat`); `doc_origen_id`/`doc_origen_tipo` traceability; VES conversion via `venta.tasa`.
- [ ] 3.4 RED: cross-tenant safety — target-account read filters `WHERE id=? AND empresa_id=?` (do not replicate `use-traspasos.ts:45/161/190` gap).
- [ ] 3.5 GREEN: replace `:363-365` throw with the write branch (design.md lines 67-81): `BANCO ? bancos_empresa/movimientos_bancarios : caja_fuerte/mov_caja_fuerte`; one EGRESO per NC (`origen='REFUND_NCR'`, `validado=1`, `validado_por`, `validado_at`); `montoRefundUsd = totalUsdNc`; VES via `usdToBs(monto, venta.tasa)`; `UPDATE saldo_actual`; `empresa_id` stamped + filtered.
- [ ] 3.6 Verify green (3.1–3.4 now pass). Push `ncr-cuadre-03-refund-tesoreria`, open PR #3 → base `02-decouple`.

## Phase 4: Selector + guard (Slice 4)

- [ ] 4.1 RED: flip `crear-ncr-modal.test.tsx:200-207` (button disabled) — assert enabled, dispatches `origenDinero`.
- [ ] 4.2 RED: admin modal renders empresa-wide active-session selector (`useSesionesActivasDashboard`, `use-sesiones-caja.ts:337-355`) + tesorería + bank picker.
- [ ] 4.3 RED: POS modal (`nota-credito-pos-modal.tsx`) LOCKS `SESION_EFECTIVO` to `sesion.id` — no cross-session option rendered (Decision 4).
- [ ] 4.4 RED: closed-session guard — `SELECT status FROM sesiones_caja WHERE id=? AND empresa_id=?`; throw if missing/`CERRADA` (pattern `use-traspasos.ts:394-402`, applied at write time).
- [ ] 4.5 GREEN: unfreeze `nota-credito-pos-modal.tsx` (`:53-55`) — origin UI locked to own `sesionCajaActivaId` for `SESION_EFECTIVO`; `TESORERIA_EFECTIVO`/`BANCO` selectable.
- [ ] 4.6 GREEN: flip disabled button in `crear-ncr-modal.tsx:279-286`; wire empresa-wide pickers.
- [ ] 4.7 GREEN: implement closed-session guard in the write tx, before egress write — passes 4.4.
- [ ] 4.8 Verify green. Push `ncr-cuadre-04-selector-guard`, open PR #4 → base `03-refund-tesoreria`.

## Phase 5: Cuadre (Slice 5)

- [ ] 5.1 RED: new test harness for `use-cuadre.ts` (zero existing tests) — reuse the mock pattern from `use-notas-credito.test.ts:118+`. New `__tests__` dir.
- [ ] 5.2 RED: `useTotalesFiscales` NC total moves from date-scoped to session-scoped via `buildCuadreWhere(filters, empresaId)` on `notas_credito`.
- [ ] 5.3 RED: new `useReintegrosPorMetodo(filters)` — `movimientos_metodo_cobro` JOIN `metodos_cobro` JOIN `notas_credito ON doc_origen_id` WHERE `origen='NCR'`, session-scoped, GROUP BY método, surfaces `nro_ncr`.
- [ ] 5.4 RED: new `useNotasCreditoDeSesion(filters)` — `notas_credito` scoped by `buildCuadreWhere` JOIN `ventas` for contado/crédito split.
- [ ] 5.5 GREEN: implement `useTotalesFiscales` change (`:1137-1146`) — passes 5.2.
- [ ] 5.6 GREEN: implement `useReintegrosPorMetodo` — passes 5.3.
- [ ] 5.7 GREEN: implement `useNotasCreditoDeSesion` — passes 5.4.
- [ ] 5.8 GREEN: create `cuadre-notas-credito.tsx` rendering 5.6+5.7 as sibling sections; add RTL rendering test.
- [ ] 5.9 Add regression test proving `useSaldoEfectivoBimonetario` nets correctly once Slice 2's `sesion_caja_id` write lands — no code change needed there. Do NOT touch `usePagosPorMetodo` (stays untouched).
- [ ] 5.10 Verify green. Push `ncr-cuadre-05-cuadre`, open PR #5 → base `04-selector-guard`.

## Phase 6: Badge (Slice 6)

- [ ] 6.1 RED: POS facturas list shows "vía administración" badge when `entry_point==='TRADICIONAL'`, none when `'POS'`.
- [ ] 6.2 GREEN: add the badge, keyed off `entry_point`.
- [ ] 6.3 Verify green. Push `ncr-cuadre-06-badge`, open PR #6 → base `05-cuadre`. Merge tracker → `develop` only after all 6 child PRs are merged in order.
