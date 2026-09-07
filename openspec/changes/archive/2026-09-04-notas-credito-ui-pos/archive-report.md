# Archive Report: notas-credito-ui-pos

_Change: notas-credito-ui-pos | Archived: 2026-09-04 | Model: anthropic/claude-sonnet-5_

---

## Status: ARCHIVED — DONE, PASS, MERGED

## Executive Summary

Rediseñó la entrada POS de Notas de Crédito: listado completo de la sesión activa (reversadas incluidas) con buscador y badges de estado de pago/reverso, panel de detalle fiscal bimonetario (reuso estricto de `buildReciboData`/`construirFilasTotales`), selección TOTAL o PARCIAL por línea (respetando `es_decimal`), placeholder gated de "Editar métodos de pago", y 7 ajustes de QA post-implementación (reverso acumulado, gating de acción, PIN efímero, depósito obligatorio, watermark, badges de color, causa NCR en kardex, tope de 3 decimales, UX de sobre-cantidad, modal-permanece-abierto). `crearNotaCredito`, `crearVenta` y `SupervisorPinDialog` quedaron **FROZEN** — cero líneas cambiadas en todo el chain.

**Verification result**: PASS. 78/78 tasks, 1052/1052 tests (88 files), `type-check:test` limpio. FROZEN confirmado. 0 CRITICAL, 2 WARNING (pre-existentes/documentales, no bloqueantes), 1 SUGGESTION. Ver `verify-report.md` (filesystem copy de Engram `sdd/notas-credito-ui-pos/verify-combined-final-s5g`, obs #2913).

**Merge**: PR #82, merge commit `15a4ef6` a `develop` (2026-09-04), estrategia A (chain colapsado s1→s5g, 52 commits, 23 archivos, +4795/-185). PRs intermedios #70-#81 cerrados tras el colapso.

---

## Specs Synced

| Domain | Action | Details |
|--------|--------|---------|
| `openspec/specs/notas-credito-pos/spec.md` | **Created** (canonical location did not exist yet) | Merged from two sources: (1) base spec from the still-unarchived Change 1 (`openspec/changes/notas-credito/specs/notas-credito-pos/spec.md`) and (2) this change's delta. 2 Requirements MODIFIED in place ("Alcance limitado a la sesión activa", "Modelo de doble PIN"), 3 Requirements preserved untouched from Change 1 ("Resolución de depósito por rieles", "Impacto condicional en cuadre — Regla de Oro", "Aislamiento multi-tenant"), 6 Requirements ADDED (Badges, Panel de detalle fiscal, Selección TOTAL/PARCIAL, Invariante de tasa histórica, Placeholder "Editar métodos de pago", Renombrar botón). Total: 11 Requirements, ~50 scenarios. |

**Note on merge source**: `openspec/specs/notas-credito-pos/spec.md` did not exist at the canonical location because Change 1 (`notas-credito`) — whose delta this change's MODIFIED requirements target — was merged to `develop` but **never archived** (its folder still sits at `openspec/changes/notas-credito/`, active). Copying only this change's delta verbatim would have produced an incoherent spec (MODIFIED headers with no prior text, and silently dropping 3 untouched requirements: deposit-rail resolution, cuadre impact rule, multi-tenant isolation). Instead, the base text was sourced directly from Change 1's own delta spec (verified exact requirement-name match on both MODIFIED targets) and merged correctly. **No content was invented** — every requirement text in the resulting main spec comes verbatim from either Change 1's or Change 2's own delta files. Change 1 (`notas-credito`) itself remains un-archived and is out of scope for this archive pass — flagged as follow-up debt below.

---

## Archive Contents

- `proposal.md` — ✅
- `specs/notas-credito-pos/spec.md` — ✅ (delta, preserved as-authored)
- `design.md` — ✅
- `tasks.md` — ✅ (78/78 tasks `[x]`)
- `verify-report.md` — ✅ (filesystem copy of Engram obs #2913, created during this archive pass)

---

## Follow-up Debt (recorded, NOT fixed in this archive pass)

1. **`notas-credito` (Change 1) is un-archived.** Merged to `develop` prior to this change's chain but its folder still lives under `openspec/changes/notas-credito/` (active, not `archive/`). This archive pass only merged the specific requirement text needed to correctly sync `notas-credito-ui-pos`'s spec deltas (sourced directly from Change 1's own delta file) — it did NOT perform Change 1's own archive (no dated archive folder created for it, no verification of its own completion state). A future SDD session should run `sdd-archive` for `notas-credito` explicitly.
2. **spec.md prose imprecise after BUG D (5g.3).** `openspec/specs/notas-credito-pos/spec.md`, Requirement "Badges de estado de pago y reverso": the general sentence "pudiendo coexistir con el badge de estado de pago" is no longer universally true — Reverso TOTAL now suppresses the payment-method badge (`resolverBadgesFactura`, Slice 5g.3). No scenario contradicts this (no scenario requires Contado+Reverso-Total coexistence), so it is not a functional gap, but the prose should be tightened with an explicit scenario ("Factura con Reverso Total NO muestra badge de estado de pago") in a future doc pass. Marked inline in the merged spec with a dated note.
3. **`useDetalleFactura` (`src/features/cxc/hooks/use-cxc.ts`) lacks an `empresa_id` filter.** PRE-EXISTING gap, NOT introduced by this change (confirmed across every verify pass in this chain, including the final combined re-verify). Only filters `WHERE vd.venta_id = ?`. Practical risk is low because `venta_id` always originates from an already `empresa_id`-scoped list upstream, but it is a multi-tenant isolation gap per CLARAPOS rule #11 and should be closed in a future change (adding an `empresa_id` join/filter to this shared CxC hook, touching multiple consumers — out of scope here).
4. **Standing caution**: `SeleccionLineasNc`'s internal quantity state is uncontrolled (`useState`), protected only by a `key`-remount defense (Slice 5g.5) against double-submit after the modal-stays-open behavior change. Any future modification to that component that adds more uncontrolled internal state must extend the same remount defense or add its own explicit reset — flagged as a residual risk in `tasks.md` 5g.5.3 and repeated here for visibility.

---

## Verification Evidence

- **Combined final verify** (Engram obs #2913, `sdd/notas-credito-ui-pos/verify-combined-final-s5g`, fresh context, adversarial, branch `feat/notas-credito-ui-pos-s5g` vs `origin/develop`): PASS. 78/78 tasks, 1052/1052 tests (88 files), `type-check:test` clean. FROZEN files (`use-ventas.ts`, `supervisor-pin-dialog.tsx`, `crearNotaCredito`/`crearVenta` inside `use-notas-credito.ts`) confirmed 0 lines changed. 0 CRITICAL (1 prior CRITICAL from the 1-5e combined verify, obs #2904, confirmed fixed in batch 5f). 2 WARNING (both recorded as follow-up debt items 2 and 3 above). 1 SUGGESTION (follow-up debt item 4 above).
- **Diff scope**: `git diff origin/develop...HEAD --stat` — 23 files, +4795/-185, all legitimate (NC POS flow + 2 minor cross-feature additive touchpoints: `use-cxc.ts`, `kardex-list.tsx`, both covered by their own tests).
- **QA cycle**: 7 fixes across Slices 5a-5g (reverso acumulado, PIN efímero, depósito obligatorio, colores de badge, causa NCR en kardex, tope de 3 decimales, UX de sobre-cantidad) plus 4 post-merge-ready bugfixes (BUG3, BUG D, BUG E, Behavior F) found by QA after the chain was first marked "ready" — all closed, all independently tested, all traced directly in source during the final combined verify (not just trusted from prior reports).
- **Merge**: PR #82, merge commit `15a4ef6617b5080e22bd43c4936663c6875bdf74` on `develop`, 2026-09-04. Chain collapse strategy A (s1→s5g squashed into one PR against `develop`). Intermediate chain PRs #70-#81 closed.

---

## SDD Cycle Summary

| Phase | Status |
|-------|--------|
| Proposal | Complete (`proposal.md`) |
| Spec | Complete (`specs/notas-credito-pos/spec.md`, delta) |
| Design | Complete (`design.md`, 315 lines — deliberately exceeds the 800-word guide, documented inline) |
| Tasks | Complete (`tasks.md`, 383 lines, 78/78 items `[x]` across 4 slices + 7 QA batches) |
| Apply | Complete — chain s1→s5g, 52 commits |
| QA (manual, post-implementation) | Complete — 7 fixes (5a-5c) + display-only fix (5d) + 3 fixes (5e) + consistency fix (5f) + 4 post-ready bugfixes (5g) |
| Verify — combined final | PASS (Engram obs #2913 / `verify-report.md`, filesystem copy created during this archive pass) |
| Merge | Complete — PR #82, commit `15a4ef6`, `develop` |
| Archive | Complete — this report |

The SDD cycle for `notas-credito-ui-pos` is fully complete: merged to `develop`, 1052/1052 tests green, `type-check:test` clean, no CRITICAL/blocking issues, 4 follow-up debt items recorded above for future work. This archive pass performed a spec-merge sourced partly from the still-active `notas-credito` (Change 1) folder — see follow-up debt item 1. No source code under `src/` was touched by this archive pass. Commit is left for the orchestrator/maintainer to push.
