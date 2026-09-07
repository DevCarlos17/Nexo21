# Archive Report: notas-credito-ruta-administrativa

_Change: notas-credito-ruta-administrativa | Archived: 2026-09-05 | Model: anthropic/claude-sonnet-5_

---

## Status: ARCHIVED — DONE, PASS WITH WARNINGS, MERGED

## Executive Summary

Entregó la ruta administrativa "Facturas emitidas" (`/ventas/facturas-emitidas`, renombrada desde `/ventas/notas-credito`): consulta empresa-wide de facturas (sin depender de sesión de caja activa) en una pestaña primaria "Facturas" + la pestaña existente "Notas de crédito" con filtros ampliados, más un modal admin delgado que reutiliza el motor `crearNotaCredito` (`entryPoint: 'TRADICIONAL'`, `modalidad: 'AJUSTE_CXC'`) sin PIN. Reutilizó estrictamente los componentes puros de `notas-credito-ui-pos` (`FacturaDetallePanel`, `SeleccionLineasNc`, `derivarEstadoPago`, gating de reverso acumulado) sin tocarlos. `crearNotaCredito`, `crearVenta`, `nota-credito-pos-modal.tsx` y `SupervisorPinDialog` quedaron **FROZEN** — cero líneas cambiadas en todo el chain (A→B→C3a→C3b→D→E→E.b).

Dos rondas de refinamiento de QA del tester post-implementación (Slices E y E.b) reemplazaron los filtros separados originalmente propuestos por un buscador único por pestaña, con el estado de Facturas "foldeado" como palabra clave dentro de ese buscador (incluyendo el nuevo estado `ABONADA`), y retiraron por completo el filtro de estado/tipo y el botón "Ver todo el historial" de la pestaña Notas de crédito.

**Verification result**: PASS WITH WARNINGS. 1136/1136 tests (93 files), `type-check:test` limpio, `type-check` (app) sin errores nuevos fuera de los pre-existentes de globals de Vitest. FROZEN confirmado en todo el chain. 0 CRITICAL, 3 WARNING (2 de deuda documental spec/design — **resueltas en este archive pass**, ver §Spec Reconciliation — y 1 de ruido de working tree no comprometido). Ver `verify-report.md` (filesystem copy de Engram `sdd/notas-credito-ruta-administrativa/verify-combined-final-eb`, obs #2931; verify previo de la cadena A→D en obs #2929).

**Merge**: PR #83, merge commit `a139ce3c604157432fef304b2cb149f75b0b0921` a `develop` (2026-09-05), estrategia A (chain colapsado A→B→C3a→C3b→D→E→E.b, 24 archivos, +2993/-453).

---

## Spec Reconciliation (performed in this archive pass)

`verify-combined-final-eb` (obs #2931) flagged that `spec.md`/`design.md` were never amended after Slices E and E.b changed the shipped UX away from the original proposal. The delta spec (`specs/notas-credito-admin/spec.md`, both in the archived change folder and the new living spec) was rewritten to match the ACTUAL shipped behavior, verified directly against source (`facturas-empresa-tab.tsx`, `notas-credito-tab.tsx`, `notas-credito-admin-filters.ts`, `notas-credito-ui.ts`):

| # | Stale text (proposal/original spec) | Reconciled text (this pass) |
|---|---|---|
| 1 | Route `/ventas/notas-credito` | Route `/ventas/facturas-emitidas` (Slice E.1 rename) — Requirement 1 updated |
| 2 | 3 separate filter fields per tab (`nro_factura`/cliente/RIF in Facturas; `nro`/cliente/RIF/`tipo` in NC) | ONE unified search input per tab (Slice E.2) — Requirements 2 and 4 rewritten |
| 3 | No estado filter described in proposal for Facturas | Estado detected as an exact keyword folded into the Facturas search bar (`contado`, `credito`, `abonada`, `reverso parcial`, `reverso total`), accent/case-insensitive, additive OR, never substring-matched — new `ABONADA` state added (Slice E.3/E.b) — new Requirement 2 scenarios added |
| 4 | Requirement 3 proposed a `tipo` (TOTAL/PARCIAL) select for NC | Removed entirely, no fold, no replacement (Slice E.b) — Requirement 4 rewritten |
| 5 | Scenario "Buscador existente sigue funcionando" (assumed `useBuscarFacturaParaAnular` survives) | Contradicted by shipped code — that search was REMOVED (Design §Decision 7); scenario replaced with explicit statement that Facturas tab is now the only entry point to select-and-reverse | 
| 6 | No "Ver todo el historial" removal documented | Explicitly documented as removed with no escape hatch (Slice E.4) — new scenario added |
| 7 | No dimmed-row behavior in proposal | New Requirement "Fila atenuada para facturas con reverso total" added (Slice E.5) |

No behavior was invented — every clause added to the spec was traced directly to shipped source code and its corresponding test file (`notas-credito-admin-filters.test.ts`, `facturas-empresa-tab.test.tsx`, `notas-credito-tab.test.tsx`), matching the verify report's own empirical evidence (RED/GREEN mutation on the ABONADA epsilon clause, grep-confirmed absence of the old select/button/hook).

---

## Specs Synced

| Domain | Action | Details |
|--------|--------|---------|
| `openspec/specs/notas-credito-admin/spec.md` | **Created** (canonical location did not exist yet) | Copied verbatim from this change's reconciled delta spec (see §Spec Reconciliation above) — 7 Requirements, 30 scenarios. No merge with a prior main spec was needed; this is a brand-new capability domain, distinct from `notas-credito-pos` (POS entry, session-scoped) which is untouched. |

---

## Archive Contents

- `proposal.md` — ✅
- `specs/notas-credito-admin/spec.md` — ✅ (delta, reconciled to shipped behavior — see §Spec Reconciliation)
- `design.md` — ✅
- `tasks.md` — ✅ (all tasks `[x]` across Slices A, B, C3a, C3b, D, E, E.b)
- `verify-report.md` — ✅ (filesystem copy of Engram obs #2931, created during this archive pass)

---

## Follow-up Debt (recorded, NOT fixed in this archive pass)

1. **Deferred scope (explicit, per proposal + design "Costuras para el proximo change")** — the following is the NEXT change(s), not a gap in this one:
   - Cuadre de caja integration (5 effects: NC del día, ventas netas, métodos de pago en devoluciones, contado/crédito, tabla de NC de sesión).
   - Real "Devolver dinero" behavior (session or treasury money-origin) and its cuadre impact.
   - `REFUND_TESORERIA` implementation (`crearNotaCredito` already validates the type and throws `'no implementado — Slice 6'` — the seam exists, only the branch needs adding).
   - "Vía administración" badge with real cuadre behavior, plus the deferred `entry_point`/`via_administracion` schema flag (`FacturaParaAnular.status` is already optional — additive column, no migration blocker).
   - Print (thermal) and Share NC buttons — `factura-export.ts` engine already exists and is reusable, wiring deferred.
   - Detail-consultation modal (view a factura without opening "Aplicar nota de crédito"; enriched reversal texts "reversada con NC XX" / "reversa factura XX") — explicitly deferred in `tasks.md` §Deferred.
2. **`DataTable` generic component (`src/components/data-table/data-table.tsx`) has dormant filtering/pagination.** It registers `useReactTable` with only `getCoreRowModel()` — no `getFilteredRowModel`/`getPaginationRowModel`. In this change it is harmless because `FacturasEmpresaTable` explicitly passes `showToolbar={false} showPagination={false}` (all filtering is server-side via the SQL builders). Pre-existing repo-wide debt, not introduced here — future fix needed only if a consumer actually needs the built-in toolbar/pagination to work.
3. **`notas-credito` (Change 1) remains un-archived.** Already flagged as follow-up debt in the prior archive (`archive/2026-09-04-notas-credito-ui-pos/archive-report.md`, item 1) — confirmed STILL true at this archive pass: `openspec/changes/notas-credito/` still exists as an active (non-archived) folder, even though it was merged to `develop` well before this change. A future SDD session should run `sdd-archive` for `notas-credito` explicitly; its delta spec content for `notas-credito-pos` was already partially consumed by the prior archive pass to reconstruct the canonical `openspec/specs/notas-credito-pos/spec.md`.
4. **`useDetalleFactura` (`src/features/cxc/hooks/use-cxc.ts`) still lacks an `empresa_id` filter.** Carried over from the `notas-credito-ui-pos` archive (item 3 there) — NOT touched by this change either (this change's admin modal reuses the same hook via `FacturaDetallePanel`). Still a multi-tenant isolation gap per CLARAPOS rule #11, low practical risk (venta_id always originates from an already-scoped list), out of scope here.
5. **Working tree noise** — `.atl/.skill-registry.cache.json`, `.atl/skill-registry.md` (modified locally) and `openspec/changes/powersync-offline-facturacion-only/` (untracked) are present in the working tree but not part of this change's history and were NOT staged by this archive pass, per explicit instruction.

---

## Verification Evidence

- **Combined final verify** (Engram obs #2931, `sdd/notas-credito-ruta-administrativa/verify-combined-final-eb`, fresh context, adversarial, branch `feat/notas-credito-admin-s5b` vs `origin/develop`): PASS WITH WARNINGS. 93 files / 1136 tests all green, `type-check:test` clean. FROZEN files (`crearNotaCredito`, `nota-credito-pos-modal.tsx`, `supervisor-pin-dialog.tsx`, `use-ventas.ts`, and `crear-ncr-modal.tsx` since Slice D) confirmed 0 lines changed. Multi-tenant isolation proven including the new estado-in-search sub-clause, verified empirically via a live RED/GREEN mutation on the ABONADA epsilon.
- **Earlier combined verify** (Engram obs #2929, chain A→D only, pre-Slice E): PASS WITH WARNINGS, 1118/1118 tests. First flagged the spec/design staleness resolved in this archive pass.
- **Diff scope**: `git diff origin/develop...HEAD --stat` (at merge) — 24 files, +2993/-453, all legitimate (admin NC route + shared filter/hook layer + 2 minor shared-component touchpoints: `data-table.tsx` rowClassName/rowProps extension, `notas-credito-ui.ts` new `filaFacturaAtenuada` helper — both additive, non-breaking).
- **QA cycle**: Slices E (5 refinements: route rename, unified search, estado filter, NC tab cleanup, dimmed rows) and E.b (1 correction: fold estado into search for Facturas instead of a separate select, remove estado entirely for NC) — both closed, both independently tested, both traced directly in source during the final combined verify (not just trusted from prior reports).
- **Merge**: PR #83, merge commit `a139ce3c604157432fef304b2cb149f75b0b0921` on `develop`, 2026-09-05. Chain collapse strategy A (A→B→C3a→C3b→D→E→E.b squashed into one PR against `develop`).

---

## SDD Cycle Summary

| Phase | Status |
|-------|--------|
| Proposal | Complete (`proposal.md`) |
| Spec | Complete, then **reconciled during archive** (`specs/notas-credito-admin/spec.md`, delta — original proposal text superseded by shipped-behavior reconciliation) |
| Design | Complete (`design.md`, 196 lines, 7 architecture decisions) |
| Tasks | Complete (`tasks.md`, 420 lines, all items `[x]` across Slices A, B, C3a, C3b, D, E, E.b) |
| Apply | Complete — chain A→B→C3a→C3b→D→E→E.b |
| QA (manual, post-implementation) | Complete — Slice E (5 refinements) + Slice E.b (1 correction) |
| Verify — combined final | PASS WITH WARNINGS (Engram obs #2931 / `verify-report.md`, filesystem copy created during this archive pass) |
| Merge | Complete — PR #83, commit `a139ce3`, `develop` |
| Archive | Complete — this report |

The SDD cycle for `notas-credito-ruta-administrativa` is fully complete: merged to `develop`, 1136/1136 tests green, `type-check:test` clean, no CRITICAL/blocking issues, spec reconciled to match shipped behavior, 5 follow-up debt items recorded above for future work. No source code under `src/` was touched by this archive pass. Commit is left for the orchestrator/maintainer to push.
