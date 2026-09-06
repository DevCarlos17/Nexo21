# Tasks: Notas de Crédito — Origen de Dinero Configurable + Cuadre

**Test runner cache**: `yarn test:run` (Vitest single-run), `yarn type-check` (app), `yarn type-check:test` (tests). **`yarn` NEVER `npm`.** Strict TDD — every pure function/validation is RED (failing test) → GREEN (implementation) before the component/hook that consumes it. Real money/kardex/CxC/cuadre paths: RED-first is non-negotiable, no exceptions.

**REWORK NOTICE (this revision)**: the money model changed mid-implementation from single-account `origenDinero:{tipo,cuentaId}` to multi-source `origenDinero: Array<{tipo,cuentaId,monto}>` (obs #2948/#2949/#2938/#2945/#2950; `design.md` is the plan of record). Slice 1 is DONE and unaffected. Slices 2 and 3 are **committed on the old model and are REWORKED below** (new commits stacked on their existing chain branches — mirrors the precedent already set by the 3.7 remanente amendment: a new commit, never `git commit --amend`, so the chain's history stays intact). Slice 4 is net-new UI work. Slices 5/6 keep their original scope with one added regression task each where the multi-source model touches them.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~2250–2900 total across 6 slices (was ~1900–2300 pre-rework) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | 7 PRs, feature-branch-chain. Slice 3 SPLIT INTO 3a/3b (owner-confirmed) — see below |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Per-slice estimate (honest re-forecast)

| Slice | Est. lines | Actual so far | Note |
|---|---|---|---|
| 1 Schema | 60–90 | ~156 (39 code/test + 117 migration SQL) | DONE — kept as-is, not re-planned |
| 2 Decouple (REWORK) | 500–650 | 283 (old model, `bfa7dd9`) | Array type + two-pass pure validation + rewrite ~15 describes + 6 new rule cases inflate this past the original single-account commit |
| 3 Multi-source write (REWORK) | 750–950 | 758 (`782558e`+`9c6f576` combined — **already over budget on the OLD single-account model**) | Highest risk: delete FIFO code, uniform two-pass write across 3 account types incl. real `metodos_cobro` balance tracking (was a placeholder), cash-availability guard, leftover→SAFC generalization, mixed-type integration tests |
| 4 Multi-origin picker UI | 500–650 | — (new) | Up from original 350–450: multi-row add/remove, live running total, per-row native-currency input, once-per-NC session selector |
| 5 Cuadre | 400–500 | — (new) | Unchanged scope from original design (no production code change per design.md — GROUP BY already handles multi-row); risk stays High only because there is zero existing test harness for `use-cuadre.ts` |
| 6 Badge | 40–70 | — (new) | Unchanged |

**Slice 3 split — DECIDED (owner-confirmed via ask-on-risk gate)**: Slice 3's OLD model already landed at 758 lines — over budget before rework. It is SPLIT into two chained child PRs so each stays reviewable and separates the mechanical write-core from the money business-rules:
- **3a** (tasks 3.8–3.10, 3.14–3.16): delete FIFO/`capearEgresosPorRemanente`, implement the two-pass resolve + uniform 3-type write core. Branch `ncr-cuadre-03a-write-core` → base `9c6f576` on `feat/ncr-cuadre-03-refund-tesoreria`.
- **3b** (tasks 3.11–3.13, 3.17–3.18): cash-availability HARD-cap guard (obs #2950), leftover→SAFC generalization, `metodos_cobro.saldo_actual` real tracking, mixed-type + closed-session-once integration tests. Branch `ncr-cuadre-03b-guards-safc` → base 3a.
Also RESOLVED: Decision 5 (`SESION_EFECTIVO.cuentaId` = `metodos_cobro.id`, not session id) — owner-confirmed, rework proceeds on this mapping.

### Suggested Work Units (feature-branch-chain)

| Unit | Goal | Branch → Base | Mode |
|---|---|---|---|
| 1 | Migration 0092 + schema.ts + persist at INSERT | `ncr-cuadre-01-schema` → tracker | DONE |
| 2 | Array `origenDinero`, two-pass pure validation, `sesionDestinoId`, rewrite old tests | `ncr-cuadre-02-decouple` (new commit on existing branch, base `bfa7dd9`) | REWORK |
| 3a | Delete FIFO + two-pass resolve + uniform 3-type write core | `ncr-cuadre-03a-write-core` → base `9c6f576` on `03-refund-tesoreria` | REWORK |
| 3b | Cash-availability guard + leftover→SAFC + real `metodos_cobro` tracking + mixed-type tests | `ncr-cuadre-03b-guards-safc` → `03a-write-core` | REWORK |
| 4 | Multi-origin picker UI, both modals | `ncr-cuadre-04-selector-guard` → `03b-guards-safc` | NEW |
| 5 | Cuadre hooks + component | `ncr-cuadre-05-cuadre` → `04-selector-guard` | Unchanged |
| 6 | Badge "vía administración" | `ncr-cuadre-06-badge` → `05-cuadre` | Unchanged |

Only the tracker merges to `develop` (opened draft/no-merge from the start). Each PR targets the immediately-previous slice branch (except PR #1 → tracker), keeping every diff focused.

**Delivery note**: tester is on a different PC — push each slice branch to `origin` before requesting QA on it. Slices 2/3 rework must be pushed together (or in dependency order) since PR #3 rebuilds on PR #2's new shape.

---

## Phase 1: Schema (Slice 1 — `entry_point`) — DONE, unchanged

- [x] 1.1–1.7 Migration `0092`, `schema.ts` column, INSERT persistence, verified green. Commit `365c3b2` on `feat/ncr-cuadre-01-schema`. Valid under the new model — no rework needed.

## Phase 2: Decouple "regla de oro" — REWORK (Slice 2, array model) — DONE

- [x] 2.8 RED: `OrigenDinero` type → `Array<{ tipo, cuentaId, monto }>` (`design.md` Decision 5 contract) — flip type-level fixtures/casts that assumed a single object.
- [x] 2.9 RED: rewrite the ~15 existing describe blocks in `use-notas-credito.test.ts` that assert the OLD single-account shape and the dropped Rules 1/2 (`EFECTIVO_REAL` locked to `SESION_EFECTIVO` only; `REFUND_TESORERIA` locked to treasury/bank only) — must FAIL until 2.12.
- [x] 2.10 RED: new pure `validarOrigenDinero` cases (design.md lines 59–65): non-empty array iff `!esModalidadNoDesembolso(modalidad)`; `AJUSTE_CXC`/no-desembolso ⇒ array empty/undefined; per-assignment `monto > 0`; no duplicate `(tipo, cuentaId)` pairs; `entryPoint==='POS'` + array contains `SESION_EFECTIVO` ⇒ resolved session is always `sesionCajaActivaId` (no per-assignment choice); `entryPoint==='TRADICIONAL'` + array contains `SESION_EFECTIVO` ⇒ `sesionDestinoId` required.
- [x] 2.11 GREEN: `CrearNotaCreditoParams.origenDinero` → `OrigenDinero[]`; add `sesionDestinoId?: string`.
- [x] 2.12 GREEN: rewrite `validarOrigenDinero` — DROP the old Rules 1/2 (type-per-modalidad restriction) entirely, implement the 6 rules above — passes 2.9/2.10.
- [x] 2.13 Verify green (`type-check`, `type-check:test`, `test:run`). New commit on `feat/ncr-cuadre-02-decouple` (base `bfa7dd9`) — same precedent as the 3.7 amendment (new commit, never `--amend`). NOT pushed yet (push with 3.19).

## Phase 3: Multi-source write — REWORK (Slice 3, two-pass over the array)

### Slice 3a — write core (DONE, fresh on `feat/ncr-cuadre-03a-write-core`, base `21aa4e5` on `feat/ncr-cuadre-02-decouple`)

- [x] 3.8 RED: assert `capearEgresosPorRemanente`/`PagoParaReversaEfectivo`/`EgresoReversaCapeado` are gone (compile-time absence + no references) — proves the FIFO-over-`pagos` model is fully removed, not just unused. **Note**: these identifiers never existed on the `feat/ncr-cuadre-02-decouple` chain (only on the abandoned `feat/ncr-cuadre-03-refund-tesoreria` branch) — the old paso 6c write branch used a simpler per-pago loop instead, which this slice replaced with the two-pass core. Absence test added anyway per this task.
- [x] 3.9 RED: Pass-1 sum-invariant — `Σ(assignment→USD via venta.tasa) ≤ remanenteALiquidar + epsilon(0.005)` accepted; over-limit rejected; unknown/cross-empresa `cuentaId` rejected (design.md lines 69-87).
- [x] 3.10 RED: multi-assignment mixed-type integration test (owner's canonical example: Bs500 `SESION_EFECTIVO` + Bs500 `BANCO` in ONE NC) — writes to BOTH `movimientos_metodo_cobro` and `movimientos_bancarios`; closed-session guard evaluated ONCE for the resolved session, not per-assignment.
- [x] 3.14 GREEN: DELETE the old paso 6c per-pago write loop (the `SELECT id, metodo_cobro_id, monto FROM pagos` that fed it, and the "first SESION_EFECTIVO assignment" placeholder) — passes 3.8.
- [x] 3.15 GREEN: implement Pass 1 (resolve + accumulate, no writes) per design.md lines 69-87 — passes 3.9. `remanenteALiquidar` hoisted from Step B to right after Step A so Pass 1 can consume it as input.
- [x] 3.16 GREEN: implement Pass 2 (uniform write loop over `resolved`) per design.md lines 89-106 — one loop across all three types (`SESION_EFECTIVO`→`movimientos_metodo_cobro`, `TESORERIA_EFECTIVO`→`mov_caja_fuerte`, `BANCO`→`movimientos_bancarios`) — passes 3.10. **Scope note**: also includes real `saldo_actual` tracking for all 3 account tables (nominally task 3.13/Slice 3b) since Pass 1 already reads `saldo_actual` for the sum-invariant — Pass 2's uniform loop trivially reuses it; see apply-progress deviations for the schema-level correction (no `monto_usd`/`tasa` columns exist on these 3 ledger tables, only `monto` native — obs #2949 overstated this).
- [x] 3.18 (partial — write-core scope only) Verify green; confirmed `pagos.is_reversed=1` UPDATE stays byte-identical (independent axis, obs #2948) — now unconditional on `movesCash`/pagos existing (decoupling proven by test). Full 3.18 (incl. 3.17's leftover routing) still pending 3b.

### Slice 3b — guards + leftover + tracking (DONE, `feat/ncr-cuadre-03b-guards-safc`, base `54c61a3` on `feat/ncr-cuadre-03a-write-core`)

- [x] 3.11 RED: cash-availability guard (obs #2950) — `SESION_EFECTIVO`/`TESORERIA_EFECTIVO` assignment with `monto > saldo_actual` throws (HARD cap, read inside tx before write); `BANCO` assignment allows `saldo_actual` to go negative (soft cap, no throw).
- [x] 3.12 RED: leftover routing (design.md lines 108-123) — array covers less than `remanenteALiquidar` + `modalidad !== 'AJUSTE_CXC'` ⇒ SAFC write for `leftoverUsd` when `> epsilon`; `AJUSTE_CXC` keeps forcing an empty array (Rule 2) and uses the full `remanenteALiquidar`.
- [x] 3.13 Superseded — real `metodos_cobro.saldo_actual` tracking already implemented in 3a's Pass 2 (see note above). Remaining 3b work: none for this specific task.
- [x] 3.17 GREEN: generalize Step B leftover routing per design.md lines 108-123 — passes 3.12.
- [x] 3.18 (remainder) Verify green with 3.17 included. Commit on new `feat/ncr-cuadre-03b-guards-safc` branch (base `54c61a3`) — NOT pushed yet.
- [ ] 3.19 Push `ncr-cuadre-02-decouple` and `ncr-cuadre-03a-write-core`/`ncr-cuadre-03b-guards-safc` to `origin`; open/update PR #2 → tracker, PR #3a/3b in chain.

## Phase 4: Multi-origin picker UI — NEW (Slice 4) — DONE (`feat/ncr-cuadre-04-selector-guard`, base `feat/ncr-cuadre-03b-guards-safc` @ `d70e618`)

- [x] 4.1 RED→GREEN: flipped `crear-ncr-modal.test.tsx` "Devolver dinero" test (was: disabled/Proximamente) — now asserts enabled, dispatches `modalidad: 'EFECTIVO_REAL'` + `origenDinero: OrigenDinero[]` + `sesionDestinoId` on confirm.
- [x] 4.2 RED→GREEN: admin modal (`crear-ncr-modal.tsx`) renders the shared `OrigenDineroPicker` — add/remove assignment rows (tipo + cuenta selector + native-currency amount input); the empresa-wide session selector for `SESION_EFECTIVO` rows appears ONCE (`sesionDestinoId` via `mostrarSelectorSesion=true`), not per-row — sourced from `useSesionesActivasDashboard` (already `status='ABIERTA'`-filtered).
- [x] 4.3 RED→GREEN: POS modal (`nota-credito-pos-modal.tsx`) LOCKS any `SESION_EFECTIVO` row's account to the empresa's cash `metodos_cobro` (via `useMetodosPagoActivos`, filtered `tipo==='EFECTIVO'`) — `mostrarSelectorSesion={false}`, no session selector rendered ever (Decision 4); `sesionCajaActivaId` still passed directly as a prop, not through the picker.
- [x] 4.4 RED→GREEN: live running total in pure helpers (`origen-dinero-picker.ts`: `calcularTotalCubiertoUsd`, `calcularCreditoAFavorUsd`, `calcularExcedenteUsd`) — component shows "Cubierto: $X de $Y" and "Se dejara $X como credito a favor" hint when under; submit blocked (`validarFilasParaSubmit`) when over `remanenteUsd + epsilon(0.005)`.
- [x] 4.5 RED→GREEN: closed-session UX pre-check satisfied BY CONSTRUCTION — `useSesionesActivasDashboard` already filters `WHERE status='ABIERTA'`, so a `CERRADA` session can never appear in `sesionesDisponibles`; the write-time guard in `use-notas-credito.ts` (3a/3b) stays the authoritative source of truth. No separate hide/disable logic needed.
- [x] 4.6 GREEN: unfrozen `nota-credito-pos-modal.tsx` — both Slice-2-rework stubs (`cuentaId=sesion.id`, unused `monto`) replaced with `OrigenDineroPicker` wired to real `metodos_cobro.id`/`caja_fuerte.id`/`bancos_empresa.id`.
- [x] 4.7 GREEN: flipped disabled button + wired `OrigenDineroPicker` in `crear-ncr-modal.tsx` — passes 4.1/4.2. "Credito a favor" stays the default, byte-identical `AJUSTE_CXC` behavior when selected.
- [x] 4.8 GREEN: running total + credito-a-favor hint + per-row cash-availability pre-warning (`filaExcedeDisponible`) — passes 4.4/4.5.
- [x] 4.9 Verify green: `yarn test:run` full suite 95 files / 1230 tests pass (was 1175 before this slice, +55 net). `yarn type-check` clean (app code; only pre-existing `*.test.ts` vitest-globals noise). `yarn type-check:test` clean. NOT pushed — executor scope is local-only, no push/PR/merge per instructions.

**Deviation (documented, not a stop)**: admin "Devolver dinero" dispatches `modalidad: 'EFECTIVO_REAL'`, NOT `'REFUND_TESORERIA'` — `crearNotaCredito` still has a stale guard (`use-notas-credito.ts` ~line 506) throwing `"REFUND_TESORERIA aun no esta implementado"`, with a DEDICATED passing test (`use-notas-credito.test.ts` ~line 1433) asserting that throw. Design.md's Decision 5 amendment states both modalidades are functionally IDENTICAL at write-time (only the audit value differs) — the guard is leftover from before Slice 3a/3b's unified write core landed and was never retired. Removing it is OUT OF SCOPE for Slice 4 (touches Slice 3's write-core file + its dedicated test, not a UI file). Recommended follow-up: a small future task to retire the guard + flip that one test, then switch admin's "Devolver dinero" to `REFUND_TESORERIA` for correct audit semantics (POS keeps `EFECTIVO_REAL`, admin gets `REFUND_TESORERIA` — matches the pre-existing intent documented in `nota-credito-pos-modal.tsx`'s own comment reserving `REFUND_TESORERIA` for the Tradicional module).

**Deviation 2 (documented)**: PARCIAL + desembolso (`EFECTIVO_REAL`) is NOT wired in either modal — the write-core (`use-notas-credito.ts` paso 6c) only fires for `tipoNc==='TOTAL'`; offering the picker for PARCIAL would let a user pick cash accounts whose money the backend would silently reroute entirely to SAFC (a "phantom refund"). Both modals now hide/disable the cash-desembolso option when `tipoNc==='PARCIAL'` (POS: `EFECTIVO_REAL` removed from `MODALIDADES_POS` for PARCIAL; admin: "Devolver dinero" button disabled for PARCIAL, auto-resets to "Credito a favor"). This is a UX correction beyond the literal task list, motivated by the pre-existing gap already documented in obs #2940/design.md as deferred to a future Slice 5a — not a new gap introduced by this slice.

## Phase 5: Cuadre (Slice 5) — unchanged scope, one added regression task

- [ ] 5.1 RED: new test harness for `use-cuadre.ts` (zero existing tests) — reuse the mock pattern from `use-notas-credito.test.ts:118+`. New `__tests__` dir.
- [ ] 5.2 RED: `useTotalesFiscales` NC total moves from date-scoped to session-scoped via `buildCuadreWhere(filters, empresaId)` on `notas_credito`.
- [ ] 5.3 RED: `useReintegrosPorMetodo(filters)` — `movimientos_metodo_cobro` JOIN `metodos_cobro` JOIN `notas_credito ON doc_origen_id` WHERE `origen='NCR'`, session-scoped, GROUP BY método, surfaces `nro_ncr`.
- [ ] 5.4 RED: `useNotasCreditoDeSesion(filters)` — `notas_credito` scoped by `buildCuadreWhere` JOIN `ventas` for contado/crédito split.
- [ ] 5.5 GREEN: implement `useTotalesFiscales` change — passes 5.2.
- [ ] 5.6 GREEN: implement `useReintegrosPorMetodo` — passes 5.3.
- [ ] 5.7 GREEN: implement `useNotasCreditoDeSesion` — passes 5.4.
- [ ] 5.8 GREEN: create `cuadre-notas-credito.tsx` rendering 5.6+5.7 as sibling sections; add RTL rendering test.
- [ ] 5.9 Regression test: `useSaldoEfectivoBimonetario` nets correctly once Slice 3's real `sesion_caja_id`/`metodos_cobro.saldo_actual` writes land — no code change needed there. Do NOT touch `usePagosPorMetodo` (stays untouched).
- [ ] 5.10 NEW — multi-source regression: one NC's array mixing `SESION_EFECTIVO`+`BANCO` produces >1 row in `useReintegrosPorMetodo` output, both sharing the same `nro_ncr` via `doc_origen_id` — assert GROUP BY already handles it (design.md's "no code change needed" claim), coverage only.
- [ ] 5.11 Verify green. Push `ncr-cuadre-05-cuadre`, open PR #5 → base `04-selector-guard`.

## Phase 6: Badge (Slice 6) — unchanged

- [ ] 6.1 RED: POS facturas list shows "vía administración" badge when `entry_point==='TRADICIONAL'`, none when `'POS'`.
- [ ] 6.2 GREEN: add the badge, keyed off `entry_point`.
- [ ] 6.3 Verify green. Push `ncr-cuadre-06-badge`, open PR #6 → base `05-cuadre`. Merge tracker → `develop` only after all 6 child PRs are merged in order.
