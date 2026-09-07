# Verification Report — notas-credito-ruta-administrativa (COMBINED FINAL, chain A→B→C3a→C3b→D→E→E.b, pre-merge into develop)

_Filesystem copy of Engram observation #2931 (`sdd/notas-credito-ruta-administrativa/verify-combined-final-eb`), created during `sdd-archive`. Earlier combined verify (chain A→D, pre-Slice E) is Engram obs #2929 (`sdd/notas-credito-ruta-administrativa/verify-combined-final`) — superseded by this one, kept for traceability in the archive report._

**Branch**: feat/notas-credito-admin-s5b (tip) vs origin/develop
**Mode**: Standard (fresh-context adversarial final gate; Strict TDD cached true but this is not a per-slice apply verify)
**Status**: PASS WITH WARNINGS

## Executive Summary

The full chain (A, B, C3a, C3b, D, E, E.b) is functionally complete, well-tested, and safe to collapse into develop. All FROZEN code (crearNotaCredito body, nota-credito-pos-modal.tsx, supervisor-pin-dialog.tsx, crearVenta/use-ventas.ts, and crear-ncr-modal.tsx itself — untouched since Slice D/prior verify) is byte-identical to develop or unchanged since the last verify. Slices E/E.b (tester QA refinements: unified search bar, estado-in-search folding for Facturas, estado removal for NC, dimmed rows) are correctly implemented, empirically verified via a live RED/GREEN mutation on the ABONADA epsilon clause, and introduce no regressions. Multi-tenant isolation holds for every new/modified query including the new estado sub-clause. No CRITICAL issues. Two pre-existing WARNINGs (spec/design not updated for E/E.b behavior; stale "buscador" spec scenario) carry over from the prior verify (obs #2929) and remain open, to be resolved in sdd-archive.

## Real Command Evidence

- `yarn test:run`: **93 files / 1136 tests, ALL PASSED** (103s). Matches tasks.md's own E.b verify claim exactly.
- `yarn type-check:test`: clean, 0 errors (26s).
- `yarn type-check` (app tsconfig): 4437 total errors, but filtering `grep "error TS" | grep -v "\.test\.ts"` → **0 non-test errors**. Confirmed pre-existing vitest-globals pattern on `*.test.ts(x)` files repo-wide — no new app-code type errors from this change.
- `git diff origin/develop...HEAD --stat`: 24 files, 2993 insertions / 453 deletions. All files belong to this change (proposal/spec/design/tasks.md, sidebar.tsx, data-table.tsx, crear-ncr-modal + test, facturas-empresa-tab + test, notas-credito-page + test, notas-credito-tab + test, use-facturas-empresa + test, use-notas-credito + test, notas-credito-admin-filters + test, notas-credito-ui.ts + test, routeTree.gen.ts, route rename notas-credito.tsx→facturas-emitidas.tsx).
- `git diff feat/notas-credito-admin-s4...HEAD --stat`: isolates Slice E/E.b changes — 17 files, 748 insertions/383 deletions. Confirms E/E.b scope is exactly search/filter/estado layer (admin-filters.ts, notas-credito-tab.tsx, facturas-empresa-tab.tsx, use-facturas-empresa.ts, use-notas-credito.ts signature-only, data-table.tsx, sidebar.tsx label, routeTree, route rename). `crear-ncr-modal.tsx` and its test have **zero diff** since s4 — the admin NC modal core logic was NOT touched by E/E.b (previously verified in detail by obs #2929, still valid).
- `git log origin/develop..HEAD --stat | grep -E "skill-registry|powersync-offline-facturacion-only"` → **empty** — noise files confirmed NOT committed anywhere in this branch's history (only uncommitted local working-tree noise, per `git status`).
- FROZEN integrity: `git diff origin/develop...HEAD -- nota-credito-pos-modal.tsx supervisor-pin-dialog.tsx use-ventas.ts` → **0 lines** (all three empty). `use-notas-credito.ts` diff since develop confined to `FiltroNotasCreditoHook`/`useNotasCredito()` filtros-branch (lines ~208-274); `crearNotaCredito` function body (line 339-1044, read in full) contains zero E/E.b-related changes — confirmed by direct read, not just diff absence.
- Route consistency: `grep -rn "ventas/notas-credito" src` → 0 matches (only historical comment references to the removed `EstadoFiltroNotaCredito` *type name*, not the route). `routeTree.gen.ts` correctly regenerated with `/ventas/facturas-emitidas` in all required sections (imports, route map, path unions).
- **Empirical RED evidence (E.b-specific)**: temporarily changed the ABONADA clause epsilon from `0.005` to `0.01` in `clausulaEstadoFactura()` (notas-credito-admin-filters.ts) — breaking parity with `derivarEstadoPago`'s epsilon. Ran `yarn vitest run notas-credito-admin-filters.test.ts -t "abonada"` → test FAILED as expected (`AssertionError: expected ... to contain 'CAST(v.saldo_pend_usd AS REAL) > 0.005'`). Restored the line; `git diff --stat -- notas-credito-admin-filters.ts` → empty (tree clean).

## Spec Compliance Matrix (6 requirements / 23 scenarios, base spec unchanged since obs #2929)

Same 22/23 compliant, 1 contradicted result as the prior verify — E/E.b did not regress any scenario (search/estado refinements are additive UX layer on top of already-compliant requirements 2 and 3). See WARNING 1 below for the carried-over gap.

## E.b Correctness — Estado-in-Search (Facturas tab)

- **Additive, never destructive**: `buildFacturasEmpresaFiltro` always emits `(v.nro_factura LIKE ? OR c.nombre LIKE ? OR c.identificacion LIKE ? [OR <estado-clause>])` — the base 3-way OR is unconditional; the estado branch is appended, never substituted. Traced in `notas-credito-admin-filters.ts:158-168`. Test `busqueda="Maria"` proves a normal name search never touches the estado path; test `busqueda="reverso"` (substring, not exact keyword) proves it does NOT trigger the EXISTS clause, preserving a hypothetical client literally named "Reverso".
- **Accent/case-insensitive**: `normalizarPalabraClaveEstado()` (line 57-63) does `.trim().toLowerCase().normalize('NFD').replace(diacritics)`. Tests confirm `"Crédito"` and `"REVERSO TOTAL"` both match.
- **Exact-keyword match only** (not substring): `detectarEstadoFacturaEnBusqueda` does an object-key lookup after normalization, not a `.includes()` — a keyword must match the ENTIRE normalized search term. Confirmed correct design choice (prevents accidental over-matching).
- **"abonada" parity with `derivarEstadoPago`**: SQL clause `(saldo_pend_usd > 0.005 AND saldo_pend_usd < (total_usd - 0.005))` (admin-filters.ts:102) vs `derivarEstadoPago` in `notas-credito-ui.ts:24-29` `if (saldo.lte(0.005)) CONTADO; if (saldo.gte(total-0.005)) CREDITO; else ABONADA` — same epsilon (0.005), same fields, same boundary semantics (both exclude the CONTADO/CREDITO edges). Verified structurally identical, then empirically confirmed via the RED/GREEN mutation above.
- **Parameterized / injection-safe**: `params.push(like, like, like)` uses only the user's LIKE-wrapped term; the estado clause itself is a fixed string literal chosen from a closed enum (`EstadoFiltroFactura`) — the user's raw text never reaches the estado SQL fragment, only the keyword-lookup key. SQL-injection test (`'; DROP TABLE ventas; --'`) confirms no `DROP TABLE` leaks into the built SQL.
- **empresa_id always first**: confirmed for the estado-triggering path too — `params[0]` is always `f.empresaId` regardless of whether `busqueda` triggers the estado branch (test "empresa_id SIEMPRE presente incluso cuando la busqueda dispara la clausula de estado").

## NC Estado Removal — Verified Complete

- `EstadoFiltroNotaCredito` type: zero live references (grep only finds historical JSDoc comments explaining *why* it was removed, in `use-notas-credito.ts` and `notas-credito-admin-filters.ts` — not the type itself).
- `buildNotasCreditoFiltro` never emits `nc.tipo = ?` (confirmed by direct read + dedicated test).
- `notas-credito-tab.tsx`: no `<select>`, only date-range + single search input; no "Tipo" filter, no "Ver todo el historial" button — confirmed by component read and by 3 dedicated absence-tests (`E.4: tipo YA NO existe`, `E.b: estado YA NO existe`, `E.4: Ver todo el historial YA NO existe`).
- No dead `NativeSelect` imports in either tab file (grep empty).

## Admin NC Flow — Re-confirmed Post-Refinements (unchanged since Slice D)

- No `SupervisorPinDialog` import/render in `crear-ncr-modal.tsx` (grep empty).
- `entryPoint: 'TRADICIONAL'`, `modalidad: 'AJUSTE_CXC'` hardcoded at the `crearNotaCredito` call site; `origenReverso` (the "Devolver dinero"/"Crédito a favor" selector state) is read nowhere near that call — confirmed by code read + comment trail.
- "Devolver dinero" button: `disabled` attribute + `title="Proximamente"` + `opacity-50 cursor-not-allowed` styling (crear-ncr-modal.tsx:279-286) — matches spec's placeholder requirement exactly.
- TOTAL/PARCIAL and over-reversal gating unchanged (reuses `puedeEmitirNcAdicional`/`puedeElegirTipoTotal` from `notas-credito-ui.ts`, not modified by E/E.b).

## Multi-Tenant Isolation

Both builders place `empresaId`/`nc.empresa_id`/`v.empresa_id` unconditionally as the first WHERE clause and first param — including when the busqueda-triggered estado sub-clause is active. `useFacturasEmpresa`/`useNotasCredito(filtros?)` resolve `empresaId` via `useCurrentUser()` before building SQL. No bypass path found.

## Regression Check

- POS NC flow (`nota-credito-pos-modal.tsx`): 0-line diff vs develop — untouched.
- `useNotasCredito()` no-arg path: the `else` branch (lines 257-269, byte-identical historical query) is untouched by the `filtros`-branch changes — backward compatible.
- Dimmed-row rule (`filaFacturaAtenuada`, Slice E.5): unchanged by E.b; test "factura sin reverso total: la fila NO queda marcada" confirms normal rows are unaffected (`data-atenuada` attribute absent, not `false`).

## Business Rules

- Bimonetary/decimal precision: E/E.b touches only search/filter SQL — no monetary calculation code changed. The `CAST(... AS REAL)` in estado clauses is confirmed used ONLY inside SQL `WHERE` comparisons for filtering (ephemeral, in-query) — the SELECT-list still returns raw string columns (`v.saldo_pend_usd`, `v.total_usd`) for display/storage, never the CAST'd REAL value. No violation of the decimal-precision rule.
- Immutability: read-only tables in both tabs, no new UPDATE/DELETE paths.

## Issues Found

**CRITICAL**: None.

**WARNING** (carried over from obs #2929, still open, not introduced or worsened by E/E.b):

1. **Spec/design not updated for post-obs#2929 refinements** — `spec.md`/`design.md` describe the base capability (Requirement 3: "Pestaña Notas de crédito — filtros ampliados" originally proposed `tipo` filter and a "buscador existente" scenario) but were never amended to reflect: (a) the unified single-search-bar UX (Slice E.2), (b) estado-folded-into-search for Facturas with the new ABONADA state (Slice E.3/E.b), (c) estado filter fully removed from NC (Slice E.b), (d) route rename to `/ventas/facturas-emitidas` (Slice E.1). Only `tasks.md` documents these — living spec text is stale relative to shipped behavior. Low risk (documentation debt only); must be folded into `spec.md` during `sdd-archive`. **RESOLVED in this archive pass** — see Archive Report §Spec Reconciliation.
2. **Stale "buscador existente sigue funcionando" scenario** (Req 3) — already flagged in obs #2929: assumes the old `useBuscarFacturaParaAnular` search survives, but it was deliberately removed (Design §Decision 7). E/E.b did not touch this; the contradiction is unchanged from the prior verify. **RESOLVED in this archive pass** — scenario rewritten to state the search was retired, not preserved.
3. **Working tree noise unrelated to this change** — `.atl/.skill-registry.cache.json`, `.atl/skill-registry.md` (modified) and `openspec/changes/powersync-offline-facturacion-only/` (untracked) present locally but not committed anywhere in this branch's history (confirmed via `git log` grep). Not a merge risk; flag before further commits on this branch.

**SUGGESTION**: None new. (Prior suggestions from obs #2929 — route-level permission smoke test, two-tenant integration fixture — still stand as low-priority, non-blocking.)

## Merge-Readiness Verdict

**PASS WITH WARNINGS** — safe to collapse the full chain (A→B→C3a→C3b→D→E→E.b) into `develop`. No CRITICAL issues, no FROZEN-code violations (crearNotaCredito, nota-credito-pos-modal.tsx, supervisor-pin-dialog.tsx, use-ventas.ts, and crear-ncr-modal.tsx all confirmed unchanged/frozen since their respective checkpoints), full test suite green (1136/1136), multi-tenant isolation proven including the new estado sub-clause, E.b estado-in-search correctness empirically verified via RED/GREEN mutation. The three WARNINGs are documentation debt and pre-existing noise, not code defects — resolved during `sdd-archive` (this pass), not a merge blocker.

## Next Recommended

`sdd-archive` — sync delta specs into `openspec/specs/notas-credito-admin/spec.md` reflecting the actual E/E.b shipped behavior (unified search, estado-in-search for Facturas with ABONADA, estado fully removed for NC, route rename), and correct/remove the stale "buscador existente sigue funcionando" scenario. **Done in this archive pass.**

## Risks

- Low: stale spec text (documentation debt, not code debt) — two related WARNINGs, both scoped to spec.md/design.md reconciliation. **Resolved during this archive.**
- Low: unrelated local working-tree noise (not committed, easy to discard before further work).
- None functional/financial: bimonetary, immutability, multi-tenant, admin-NC-flow, and Regla de Oro invariants all hold; all FROZEN code untouched.

## Skill Resolution

paths-injected — 3 skills loaded (vercel-react-best-practices, modern-web-guidance, judgment-day) plus sdd-verify + shared SDD protocol. judgment-day's parallel-blind-judges step was intentionally NOT executed per explicit executor-boundary instruction (no delegation/sub-agents in this run) — performed as a single fresh-context adversarial pass instead, per the prior verify's precedent (obs #2929).

---

_Engram observation: #2931, topic `sdd/notas-credito-ruta-administrativa/verify-combined-final-eb`, created 2026-09-05 16:35:27. Prior combined verify (chain A→D): obs #2929, topic `sdd/notas-credito-ruta-administrativa/verify-combined-final`, created 2026-09-05 04:30:06._
