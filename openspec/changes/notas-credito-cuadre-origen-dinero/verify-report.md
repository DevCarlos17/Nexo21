# Verification Report

**Change**: `notas-credito-cuadre-origen-dinero`
**Scope**: Fresh-context adversarial review of the FULL chain, `git diff develop...feat/ncr-cuadre-06-badge` (25 files, +4225/-195), all 6 slices as ONE body of work.
**Mode**: Strict TDD (active) + money-critical adversarial audit.
**Reviewer stance**: independent, no prior context, source-read every write path myself — did not trust `apply-progress`/design summaries at face value.

## Status: **PASS WITH WARNINGS**

---

## Executive Summary

The full 6-slice chain (schema → decouple → two-pass write core → guards/SAFC → multi-origin UI → cuadre → badge) implements the multi-source `origenDinero[]` refund model correctly and atomically. I read the entire write core (`use-notas-credito.ts` lines 484–1388) line-by-line, the cuadre hooks (`use-cuadre.ts`), the picker (`origen-dinero-picker.ts/.tsx`), both modals' dispatch logic, and the underlying Postgres migrations/triggers for every ledger table touched. The sum-invariant, cash hard-cap/bank soft-cap asymmetry, POS/TRADICIONAL route asymmetry, decoupling from `pagos`, and leftover→SAFC routing all match the design contract and are covered by real, non-trivial, triangulated tests. Full suite (97 files / 1252 tests) passes; `yarn type-check` is clean on every non-test file (all 4817 errors are the known pre-existing vitest-globals noise on `*.test.ts(x)` files, repo-wide, unrelated to this change — confirmed by filtering the output myself). No money-fabrication, no double-credit, no cross-tenant read gap found.

Two real gaps found, both WARNING-level (not CRITICAL): (1) a precision-convention mismatch — the write core uses `toStorageString` (8-decimal) uniformly for treasury/bank/method balance writes where `design.md`'s own Decision 1 calls for `.toFixed(4)` matching `use-traspasos.ts`'s established convention; harmless to correctness (Postgres `NUMERIC(p,s)` re-rounds on cast) but an audit-trail inconsistency across ledger rows written by different features. (2) A latent, function-level gap for `tipoNc==='PARCIAL'` combined with a desembolso modalidad (`EFECTIVO_REAL`/`REFUND_TESORERIA`): the write core silently reroutes 100% of the remanente to SAFC credit instead of throwing, even if the caller supplied `origenDinero`. Both existing UI callers correctly block this combination (verified in both modals), and the gap is explicitly documented in `tasks.md` as a deliberate, deferred scope boundary — but the money-critical function itself has no guard against a future caller bypassing the UI, which cuts against the codebase's own stated "gate at function level, not UI level" philosophy (the anti-fraud gate a few lines above does exactly this correctly).

**Safe to push for tester QA**: **YES**, with the two WARNINGs noted for the human maintainer's awareness (neither blocks correct operation of the flows the UI actually exposes). Remember the operational note: migration `0092` must be applied to Supabase (SQL Editor) before merging to `main`, per the migration file's own header — nothing has been pushed yet, so this is just a reminder for the eventual deploy step.

---

## Test Results (executed by me, this session)

```
yarn test:run
 Test Files  97 passed (97)
      Tests  1252 passed (1252)
   Duration  43.98s
```
Zero failures, zero skips. Matches the number reported in the apply-progress history (obs #2940) — I did not just trust that report, I re-ran the suite myself from a clean `feat/ncr-cuadre-06-badge` checkout (`git status` confirmed a clean tree save for unrelated `.atl/` cache files).

```
yarn type-check         → exits 2, 4817 `error TS` lines
yarn type-check:test    → clean, 0 errors, 41.9s
```
I filtered the `type-check` output myself: `grep "error TS" | grep -v "\.test\.ts" | grep -v "__tests__"` → **0 matches**. All 4817 errors are on `*.test.ts(x)` files (missing vitest globals under the app tsconfig) — confirmed pre-existing, repo-wide noise per session config, not a regression introduced by this change. Every non-test file this change touches (`use-notas-credito.ts`, `use-cuadre.ts`, `origen-dinero-picker.ts/.tsx`, both modals, `notas-credito-ui.ts`, `use-facturas-sesion-activa.ts`, `cuadre-notas-credito.tsx`) type-checks clean.

`yarn lint`: not runnable in this environment (`'eslint' is not recognized` — binary not resolvable via yarn on this shell). Not attributable to this change; reported as unavailable, not a failure.

---

## Adversarial Checks — Findings

### 1. Atomicity — ✅ PASS
Single `db.writeTransaction` wraps the entire function (`use-notas-credito.ts:515–1385`), no nested `writeTransaction` anywhere in the diff. Pass-1 (resolve + accumulate + sum-invariant + cash-hard-cap, lines 1050–1118) performs ONLY reads before the sum-invariant throw at line 1114 — Pass-2 (the actual `INSERT`/`UPDATE` writes, lines 1120–1212) never starts until Pass-1 fully validates. Any throw anywhere in the tx (Pass-1, cash-cap, sum-invariant, closed-session guard) rolls back the WHOLE transaction, including the header/det/kardex/Step-A writes that happened earlier in the same call — verified this is a single PowerSync `writeTransaction`, not per-statement commits.

### 2. Sum-invariant — ✅ PASS
`montoADevolverUsd = Σ(assignment→USD via venta.tasa, Decimal)`, checked at line 1114: `if (montoADevolverUsd.gt(remanenteALiquidar.plus(EPSILON))) throw`. `remanenteALiquidar = Decimal.max(0, totalUsdNc − montoAplicadoAPendiente)` (line 949, matches obs #2945 exactly). Tests pin the EXACT epsilon boundary: 30.005 (remanente+EPSILON) **accepts**, 30.01 **rejects** (`use-notas-credito.test.ts:941,958`) — real boundary tests, not approximations. No double-credit: `SALDO_FAVOR`/`COMPENSACION_VENTA` never enter the 6c block (`movesCash=false` for those modalidades, `montoADevolverUsd` stays `Decimal(0)`), so Step B's leftover branch (line 1287) always uses the FULL `remanenteALiquidar` for those — verified structurally impossible for both a cash-egreso AND a full-SAFC to fire for the same slice of money (if/else-if in Step B, line 1245 vs 1286, never both).

### 3. Cash hard-cap vs bank soft-cap — ✅ PASS
Lines 1093–1100: `if ((tipo===SESION_EFECTIVO || tipo===TESORERIA_EFECTIVO) && montoNativo.gt(saldoActualCuenta)) throw`. `BANCO` has no such check anywhere in the loop — confirmed by reading the full Pass-1 loop, the guard is scoped to exactly 2 of 3 types. Every account read is `WHERE t.id = ? AND t.empresa_id = ?` (line 1074, uniform across all 3 `TABLA_POR_TIPO` targets) — **no cross-tenant read gap**, unlike the `use-traspasos.ts:45` precedent the design explicitly warned against. Tests pin both sides: `SESION_EFECTIVO`/`TESORERIA_EFECTIVO` over-limit rejects, `BANCO` over-limit **does not** reject (`use-notas-credito.test.ts:1138,1159,1179`).

### 4. Bimonetary — ✅ PASS, with 1 WARNING (precision convention)
No float arithmetic anywhere in the write core — every calculation uses `Decimal` (`decimal.js`). `montoUsd = moneda_codigo==='VES' ? bsToUsd(montoNativo, venta.tasa) : montoNativo` (line 1102) — correct, uses the venta's frozen tasa (bimonetary "photograph" rule). Confirmed money-movement tables (`movimientos_metodo_cobro`, `mov_caja_fuerte`, `movimientos_bancarios`) have NO `monto_usd`/`tasa` columns (obs #2949's self-correction is accurate — verified against `migrations/0005_caja_tesoreria.sql` and `migrations/0035_conciliacion_tesoreria.sql` directly) — only native `monto` is persisted, USD is computed in-memory for the invariant only. **WARNING** (see below): the actual precision helper used for treasury/bank/method writes diverges from what `design.md` Decision 1 specifies.

### 5. Route asymmetry (POS vs TRADICIONAL) — ✅ PASS
`sesionDestino = entryPoint==='POS' ? sesionCajaActivaId : sesionDestinoId` (line 1032), resolved and guarded ONCE per NC (not per assignment) at lines 1030–1048, before Pass-1's loop even starts — matches design exactly ("simplificacion deliberada"). Closed-session guard: `SELECT status ... throw if missing or status==='CERRADA'` (lines 1037–1047) — evaluated before any Pass-1 account resolution. Test pins this exact ordering (`use-notas-credito.test.ts:1072`, "sesion destino CERRADA: rechaza ANTES de escribir cualquier egreso").

### 6. Decoupling from `pagos` — ✅ PASS
Confirmed: `crearNotaCredito` never `SELECT`s from `pagos` to decide origin/amount of the refund — the ONLY `pagos` touch is the axis-2 `UPDATE pagos SET is_reversed=1 ... WHERE venta_id=? AND is_reversed=0` (line 1221), unconditional on `tipoNc==='TOTAL'`, completely independent of the `origenDinero` write core (axis 3). Test explicitly proves decoupling: 2 original payments of different métodos → exactly 1 egreso (== size of `origenDinero`, not size of `pagos`) (`use-notas-credito.test.ts:823`). `capearEgresosPorRemanente`/`PagoParaReversaEfectivo`/`EgresoReversaCapeado` confirmed absent from the entire diff (grepped the full file, zero references) — FIFO-over-pagos model fully removed, matching obs #2948.

### 7. `entry_point` (Slice 1) — ✅ PASS
Migration `0092` is idempotent (`ADD COLUMN IF NOT EXISTS`, `DROP/ADD CONSTRAINT IF EXISTS`), backfill is deterministic (`sesion_caja_id IS NOT NULL → 'POS' ELSE 'TRADICIONAL'`, matches the invariant that only POS-issued NCs ever set `sesion_caja_id`), CHECK constraint present. `REFUND_NCR` correctly appended to BOTH `mov_caja_fuerte_origen_check` and `movimientos_bancarios_origen_check` (migration lines 86–117) — verified against the EXACT prior value lists cited in the migration's own header, cross-checked against `migrations/0035_conciliacion_tesoreria.sql` and `migrations/0005_caja_tesoreria.sql` directly (not trusted blindly). `origen='NCR'` on `movimientos_metodo_cobro` was already valid via migration `0091` (verified) — no new CHECK needed there, as claimed.

### 8. Cuadre BASE (Slice 5) — ✅ PASS
`useTotalesFiscales`'s NCR total now uses `buildCuadreWhere` (session-scoped) instead of date-only (`use-cuadre.ts:1211–1225`). `useReintegrosPorMetodo` correctly scopes to `origen='NCR'` (session-cash only, by design), joins `notas_credito` via `doc_origen_id` to surface `nro_ncr`, `GROUP BY mc.id, nc.nro_ncr` — correctly produces >1 row for one NC when 2 different `metodos_cobro` targets are used (verified the GROUP BY clause directly, matches task 5.10's claim). `useNotasCreditoDeSesion` joins `ventas` for the contado/crédito split. `usePagosPorMetodo` — confirmed BYTE-IDENTICAL, no `NCR`/`origenDinero` reference added anywhere in its query. `useSaldoEfectivoBimonetario`'s manual-movement query excludes `origen NOT IN ('VENTA','COBRO','PROPINA')` — `'NCR'` egresos are NOT excluded, so they correctly net out of the expected cash balance (confirmed this nets correctly without any code change, as obs #2956 claims). The fine-grained cross-session matrix is genuinely NOT implemented (no code attempts it) — cleanly deferred, not half-built.

### 9. Multi-tenant (`empresa_id`) — ✅ PASS
Every new/modified query in the write core and cuadre hooks filters `empresa_id` — spot-checked all: the venta account read (line 1074, all 3 `TABLA_POR_TIPO` targets), the session check (line 1034), `useReintegrosPorMetodo` (`nc.empresa_id = ?` + `buildMovsWhere`'s `mmc.empresa_id=?`), and the pre-existing hooks feeding the picker's account options (`useCuentasTesoreria`, confirmed `WHERE empresa_id = ?` on both `bancos_empresa` and `caja_fuerte` reads). No gap found.

### 10. Immutability — ✅ PASS
No UI touches `stock`/`saldo_actual`/`clientes.saldo_actual` directly outside of the `movimientos_*`-driven update pattern already established elsewhere in the codebase (this change follows the SAME pattern, not a new one). No edit/delete UI added for any immutable record.

### 11. Cross-slice drift (Slice 2 validate → 3a/3b write → 4 UI → 5 read) — ✅ PASS
Traced the array shape end-to-end: `OrigenDinero{tipo,cuentaId,monto}` (hook interface) → `validarOrigenDinero` (Slice 2, pure, pre-tx) → Pass-1/Pass-2 two-pass write (Slice 3a/3b) → `OrigenDineroPicker`/`origen-dinero-picker.ts` (Slice 4, mirrors the SAME bimonetary/hard-cap/epsilon rules client-side as a UX pre-check, explicitly documented as non-authoritative) → `useReintegrosPorMetodo` (Slice 5, reads `movimientos_metodo_cobro` rows the write core produces). No shape drift found anywhere in this chain — the picker's pure helpers (`montoFilaEnUsd`, `calcularTotalCubiertoUsd`, `filaExcedeDisponible`) independently re-derive the exact same USD-conversion and hard-cap logic as the backend, which is the highest-risk point for silent drift and it checks out.

### 12. Test integrity — ✅ PASS (spot-checked)
- The `REFUND_TESORERIA` phantom-throw fix (obs #2954): confirmed the old throw is GONE from the source (searched `use-notas-credito.ts` for the literal string, zero matches), and the test at `use-notas-credito.test.ts:1433` now asserts an END-TO-END SUCCESS (bank egreso written), not a rejection — this is a real flip, not a weakened assertion.
- The `crear-ncr-modal.tsx` "Devolver dinero" disabled-button test flip (task 4.1): confirmed the button is genuinely wired to dispatch `REFUND_TESORERIA` + `origenDinero` + `sesionDestinoId` (`crear-ncr-modal.tsx:278–282`), not a stub.
- Spot-read of the sum-invariant/epsilon/cash-cap/mixed-type test bodies (not just titles) confirms real `crearNotaCredito()` calls against realistic fixtures with `await expect(...).resolves/rejects.toThrow(...)` — no tautologies, no smoke-tests-only, no ghost loops found in the sampled tests.
- Did not exhaustively read all ~2100 lines of `use-notas-credito.test.ts` line-by-line (93 `it`/`describe` blocks in that file alone across the full suite's 1252 tests) — sampled the money-critical describe blocks (sum-invariant, cash-cap, mixed-type, leftover→SAFC, decoupling-from-pagos) which is where a weakened assertion would be most dangerous; all sampled tests exercise real production code paths.

---

## Issues Found

### CRITICAL
None.

### WARNING

**W1 — Precision convention diverges from `design.md` Decision 1 (not money-breaking, audit-trail inconsistency)**
`use-notas-credito.ts:1138,1140,1151,1164,1166,1179,1192-1194,1207` all use `toStorageString()` (8-decimal calc precision, per `src/lib/currency.ts`) for `mov_caja_fuerte`, `caja_fuerte.saldo_actual`, `movimientos_bancarios`, `bancos_empresa.saldo_actual`, AND `metodos_cobro.saldo_actual`. `design.md` Decision 1 explicitly says these should use `.toFixed(4)` "matching `use-traspasos.ts:938`'s existing convention for that exact column" — confirmed `use-traspasos.ts` DOES use `.toFixed(4)` uniformly for all 3 account types when writing the identical columns (grepped 15+ call sites). Impact: low — Postgres `NUMERIC(18,4)`/`NUMERIC(12,2)` columns auto-round on cast, so the STORED value converges regardless of which JS helper formatted it. But locally (SQLite, pre-sync) and in any diagnostic/audit view that reads raw values, NCR-refund ledger rows will show 8-decimal strings ("500.00000000") next to sibling traspasos-tesoreria rows in the SAME table showing 4-decimal strings ("500.0000") — a cosmetic inconsistency the design explicitly tried to avoid. **Fix**: swap `toStorageString(r.monto)`/`toStorageString(saldoNuevo)` for `.toFixed(4)` on the 3 treasury/bank/`metodos_cobro`-balance writes (keep `toStorageString` for `movimientos_metodo_cobro`'s own ledger row — that one IS per design/`use-ventas.ts:825`'s convention).

**W2 — `tipoNc==='PARCIAL'` + desembolso modalidad silently reroutes requested cash to SAFC credit, no function-level guard**
`use-notas-credito.ts:1021`: the two-pass write core only runs `if (tipoNc === 'TOTAL' && movesCash)`. For `PARCIAL` + `EFECTIVO_REAL`/`REFUND_TESORERIA`, `movesCash` is true but the block never executes, so `montoADevolverUsd` stays `Decimal(0)`; Step B (line 1286) then writes the ENTIRE `remanenteALiquidar` as SAFC credit — even if the caller supplied a populated `origenDinero` array requesting real cash. This is explicitly documented in `tasks.md` ("Deviation 2") as a deliberate, deferred gap, and BOTH modals correctly hide/disable the cash-desembolso option whenever `tipoNc==='PARCIAL'` (verified in both `crear-ncr-modal.tsx` and `nota-credito-pos-modal.tsx`). However: the anti-fraud gate two lines above (`assertGateAntiFraudeNoDesembolso`) is explicitly designed to reject bad combinations "at function level, not UI level" — this specific bad combination (PARCIAL + desembolso + non-empty `origenDinero`) has NO equivalent function-level rejection, and no test pins/proves the current silent-reroute behavior is intentional. Today it's unreachable (no in-repo caller can trigger it), but the money-critical function itself is not self-defending against it. **Recommend**: either add an explicit throw (`if (tipoNc==='PARCIAL' && movesCash) throw ...`) as a function-level defense-in-depth, or add a regression test that pins the current silent-reroute as intentional so a future refactor can't accidentally change it unnoticed.

**W3 — Migration `0092` deploy-order dependency (operational, not code)**
The migration's own header states it must be applied to Supabase (SQL Editor) BEFORE this chain merges to `main` (auto-deploys to Cloudflare Workers). Nothing has been pushed yet (confirmed local-only, matches executor scope) — flagging so the human doing the eventual push/merge doesn't skip this step.

### SUGGESTION

**S1** — `design.md` Decision 1 states `bancos_empresa` is `NUMERIC(18,4)`; it's actually `NUMERIC(12,2)` per `migrations/0005_caja_tesoreria.sql:19` (only `caja_fuerte`/`mov_caja_fuerte` are `NUMERIC(18,4)`). Doesn't change any code-correctness conclusion above, but worth correcting in the design doc.

**S2** — The Postgres `BEFORE INSERT` triggers on `mov_caja_fuerte`/`movimientos_bancarios`/`movimientos_metodo_cobro` (`trg_actualizar_saldo_*`) independently recompute `saldo_anterior`/`saldo_nuevo` server-side AND update the parent account's `saldo_actual` themselves — the app's own subsequent `UPDATE ... SET saldo_actual = ?` is therefore redundant. This is safe today because both writes converge on the same absolute value (assuming in-order sync of one transaction's operations, which is the existing, already-relied-upon assumption across the whole codebase, e.g. `use-traspasos.ts`) — not a defect introduced by this PR, just worth knowing if PowerSync's upload ordering guarantees are ever revisited.

**S3** — `yarn lint` is not runnable in this shell environment; quality metrics for this review are limited to `type-check`/`type-check:test` + manual code read. Not a defect of the change.

---

## Verdict

**PASS WITH WARNINGS.** Zero CRITICAL findings. The money engine (atomicity, sum-invariant, cash hard-cap/bank soft-cap, route asymmetry, decoupling, multi-tenant isolation) is correct and well-tested by real, non-trivial, boundary-precise tests (1252/1252 passing, confirmed by me from a clean checkout). The two WARNINGs are a cosmetic precision-convention drift and a documented-but-unguarded edge case that is unreachable through either shipped UI today. **Safe to push and hand to tester QA.**

## Next Recommended
`sdd-archive` (after tester sign-off) — or, if the maintainer wants W1/W2 addressed first, a small follow-up commit on `feat/ncr-cuadre-06-badge` (or a new slice) before opening PRs, since nothing has been pushed yet and history on this chain has already used "new commit, never amend" as its convention.

---

## Addendum: W1/W2 addressed (Phase 7 hardening, post-verify)

Both WARNINGs were fixed in a follow-up commit on this same branch (`feat/ncr-cuadre-06-badge`), per this report's own "Next Recommended" suggestion. See `tasks.md` Phase 7 and apply-progress (topic_key `sdd/notas-credito-cuadre-origen-dinero/apply-progress`) for full detail.

- **W1**: `.toFixed(4)` now used for `mov_caja_fuerte`/`caja_fuerte.saldo_actual`/`movimientos_bancarios`/`bancos_empresa.saldo_actual`/`metodos_cobro.saldo_actual` — matches `use-traspasos.ts:938`'s convention as design.md Decision 1 specified. `movimientos_metodo_cobro`'s own ledger row correctly kept `toStorageString` (per `use-ventas.ts:825`'s convention for that table).
- **W2**: pre-tx throw added for `tipoNc==='PARCIAL' && movesCash`, closing the function-level gap this report identified. 3 new RED→GREEN tests pin the guard's exact scope (throws for both desembolso modalidades, does not regress the AJUSTE_CXC path).
- Full suite: 97 files / 1255 tests passing (was 1252/1252 at verify time, +3 net from the new W2 tests). `yarn type-check`/`yarn type-check:test` clean on all non-test files.
- Still NOT pushed — remains executor scope, local-only. W3 (migration `0092` deploy-order) is operational, unchanged, still applies at the eventual push/merge step.

## Skill Resolution
`paths-injected` — 4 skills loaded from the exact paths provided in the launch prompt: `supabase-postgres-best-practices`, `supabase`, `vercel-react-best-practices`, `judgment-day` (informed the adversarial discipline of this solo review; no dual-judge delegation was used per this task's explicit "do not delegate" instruction, which supersedes that skill's normal parallel-judge workflow).
