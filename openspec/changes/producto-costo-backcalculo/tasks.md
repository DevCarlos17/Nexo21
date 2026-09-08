# Tasks: Back-calcular Costo desde Margen y Precio

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~300-380 (lib ~55, lib tests ~140, form.tsx ~115) |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Suggested split | Single PR, 2 work-unit commits |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Pure Decimal back-calc lib + tests (RED→GREEN) | PR 1 (commit 1) | Zero UI risk; mirrors `compra-precio-gating.ts` style |
| 2 | Form wiring: refs, clamp, blur orchestrator, inline notices | PR 1 (commit 2) | Depends on Unit 1; if diff nears 400 lines during apply, split into its own PR |

If actual diff exceeds 400 lines while applying, split at the commit boundary above (Unit 1 already merges cleanly alone).

## Phase 1: Pure Lib — Tests First (RED)

- [ ] 1.1 In `src/features/inventario/lib/__tests__/producto-precio-gating.test.ts`, add failing tests for `debeBackCalcularCosto`: all 4 trigger conditions (costo vacío vs `'0'`, margen ausente, PVP/final ausente, combo). Verify: `yarn test:run` fails (RED).
- [ ] 1.2 Same file, add failing tests for `backcalcularCostoYCascada`: canonical example (pvp150/margen50→100; mayor125; especial100.01), IVA-final (174→150→100), tasa=0 guard, margen 0%, cascade preserves manual `precio` fuente. Verify: RED.

## Phase 2: Pure Lib — Implementation (GREEN)

- [ ] 2.1 In `src/features/inventario/lib/producto-precio-gating.ts`, add `FuentePrecio` type + `debeBackCalcularCosto(p)`. Verify: 1.1 passes.
- [ ] 2.2 Same file, add `backcalcularCostoYCascada(input)` using `decimal.js`; no internal rounding. Verify: 1.2 passes; `yarn type-check` clean.

**Commit 1**: `producto-precio-gating.ts` + `producto-precio-gating.test.ts` (~195 lines).

## Phase 3: Form — State & Refs

- [x] 3.1 In `producto-form.tsx` (~L358, near `proyeccion*` state), add `ultimaFuenteMayorRef`/`ultimaFuenteEspecialRef` (`useRef<FuentePrecio>`), `costoBackCalculado` state, `avisoMargenNegativo` state (`'detal'|'mayor'|'especial'|null`).
- [x] 3.2 In the reset `useEffect` (~L413-490), set both refs to `'margen'` in the create branch and `null` in the edit branch.
- [x] 3.3 Set `.current = 'margen'` in `handleMargenMayorChange`/`handleMargenEspecialChange`; `.current = 'precio'` in `handlePrecioMayorUsdChange/BsChange`, `handlePrecioEspecialUsdChange/BsChange`, `handlePrecioFinalMayorUsdChange/BsChange`, `handlePrecioFinalEspecialUsdChange/BsChange` (~L695-861).

## Phase 4: Form — Negative Margin Clamp

- [x] 4.1 In `handleMargenChange`/`handleMargenMayorChange`/`handleMargenEspecialChange` (~L682-718), clamp `parseFloat(val) < 0` to `'0'` for state + downstream math, set `avisoMargenNegativo` to that level. Verify: existing PVP math for `margen >= 0` unchanged (regression via 7.1).

## Phase 5: Form — Blur Orchestrator & Wiring

- [x] 5.1 Add `ejecutarBackCalcSiAplica(pvpOverrideUsd?: number)`: calls `debeBackCalcularCosto`, short-circuits if false; else calls `backcalcularCostoYCascada`, writes `costoUsd`/`costoBs` (tasa guard), cascades `mayor`/`especial` (skip if ref !== `'margen'`), sets `costoBackCalculado(true)`, clears touched `proyeccion*`.
- [x] 5.2 Add `onBlur={() => ejecutarBackCalcSiAplica()}` on margen Detal, PVP Detal USD, PVP Detal Bs inputs (~L1584-1621).
- [x] 5.3 Append `ejecutarBackCalcSiAplica(baseUsd)` at the end of `handlePrecioFinalDetalUsdChange`/`handlePrecioFinalDetalBsChange` (~L777-803).
- [x] 5.4 Clear `costoBackCalculado(false)` in `handleCostoUsdChange`/`handleCostoBsChange` (~L635-650).

## Phase 6: Form — Inline Notices

- [x] 6.1 Add inline "costo recalculado por el sistema" text near Costo USD input (~L1516-1521), gated on `costoBackCalculado`, styled like the existing `esComboLocal` hint.
- [x] 6.2 Add inline "margen ajustado a 0%" text under each margen cell (detal/mayor/especial), gated on `avisoMargenNegativo === nivel`.

**Commit 2**: `producto-form.tsx` only (~115 lines). Actual: +123/-9 (net +114).

## Phase 7: Verification

- [x] 7.1 Run `yarn test:run` — full suite green; confirm combo/servicio (`esComboLocal`) and existing `calcularPrecioPreservandoMargen`/`calcularViolacionCostoPvp` tests unaffected. (93 files / 1148 tests, unchanged from baseline.)
- [x] 7.2 Run `yarn type-check` + `yarn type-check:test` — no new errors. (Pre-existing noise only, verified via git stash against clean tree.)
- [ ] 7.3 Manual smoke: canonical example (proposal.md) end-to-end in the form; edit-mode default (`null` fuente) does not overwrite loaded prices on stray blur. **Not performed this session — no dev server available. Pending for sdd-verify or manual QA.**
