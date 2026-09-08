# Design: Back-calcular Costo desde Margen y Precio

## Technical Approach

New pure Decimal-based back-calc math lives in `producto-precio-gating.ts` (mirrors `compra-precio-gating.ts` style). `producto-form.tsx` wires it via `onBlur` on 3 DETAL inputs (margen, PVP USD, PVP Bs) plus the two existing `onBlur` precio-final handlers. It bypasses `applyPricesFromCosto` entirely — the two flows never touch the same code path, so no double-recalculation is possible.

## Central Design Problem: "Last Source" State Model

| Option | Tradeoff | Verdict |
|---|---|---|
| (a) 3 flags via `useState` | Correct shape, but triggers re-render on every margin/price keystroke for a value read only once, at blur | Rejected — needless renders |
| (b) 1 object via `useState` | Same render cost as (a), extra indirection | Rejected |
| (a) 3 flags via `useRef` | Read-only-at-blur, zero render cost, matches `rerender-use-ref-transient-values` guidance | **Chosen** |

**Chosen**: two refs, `ultimaFuenteMayorRef` and `ultimaFuenteEspecialRef`, typed `FuentePrecio = 'margen' | 'precio' | null`. No ref needed for DETAL — it's the calculation's *input*, never overwritten by cascade, so nothing to track.

**Setters**: `handleMargenMayorChange` → `.current = 'margen'`; `handlePrecioMayorUsdChange`, `handlePrecioMayorBsChange`, `handlePrecioFinalMayorUsdChange/BsChange` → `.current = 'precio'`. Mirror for especial.

**Default on form open** (in the existing reset `useEffect`):
- **Create mode**: `'margen'` for both. Prices are empty and margins are pre-filled from `niveles_precio` defaults — nothing hand-typed exists to protect, so cascading is safe and expected.
- **Edit mode**: `null` for both, treated as "not margin" (cascade skipped). Loaded DB prices must never be silently overwritten by a stray blur until the user actively re-touches a margin field this session.

## New Pure Function (`producto-precio-gating.ts`)

```ts
export type FuentePrecio = 'margen' | 'precio' | null

export function debeBackCalcularCosto(p: {
  costoUsd: string; esCombo: boolean; margenDetalPct: string; pvpDetalUsd: number
}): boolean

export function backcalcularCostoYCascada(input: {
  pvpDetalUsd: Decimal; margenDetalPct: Decimal
  margenMayorPct: Decimal; margenEspecialPct: Decimal
  ultimaFuenteMayor: FuentePrecio; ultimaFuenteEspecial: FuentePrecio
}): { costoUsd: Decimal; mayorUsd: Decimal | null; especialUsd: Decimal | null }
```

`debeBackCalcularCosto` is the **single centralized predicate** — the 4 trigger conditions live in one place, called from every blur site. `backcalcularCostoYCascada` does `costo = pvp / (1 + margen/100)`, then per level: `ultimaFuente !== 'margen' → null` (preserve), else `costo * (1 + margenNivel/100)` (defensively `Decimal.max(0, margen)`). No rounding inside; caller does `.toFixed(2)` once at the state-write boundary.

## Blur Wiring

| Input | Existing handler | Change |
|---|---|---|
| Margen Detal | `onChange` only | Add `onBlur={() => ejecutarBackCalcSiAplica()}` |
| PVP Detal USD/Bs | `onChange` only | Add same `onBlur` (Bs included for parity — both feed the same DETAL PVP) |
| Precio Final Detal USD/Bs | Already `onBlur` | Append `ejecutarBackCalcSiAplica(baseUsd)` after existing logic, passing the **freshly computed** `baseUsd` local var (state hasn't flushed yet) |

`ejecutarBackCalcSiAplica(pvpOverrideUsd?)` (component-level, has side effects): reads live `margen`/`precioVentaUsd`/`costoUsd`, calls `debeBackCalcularCosto`, short-circuits if false. If true: calls `backcalcularCostoYCascada`, writes `costoUsd`/`costoBs` (tasa guard: skip Bs if `tasaValor <= 0`), and for each non-null cascade result, directly `setPrecioMayorUsd`/`setPrecioEspecialUsd` (+ Bs) and clears that level's `proyeccion*` — no `applyPricesFromCosto` call.

## `applyPricesFromCosto` Interaction (regression-risk zone)

Back-calc and `applyPricesFromCosto` (L554-606) are **mutually exclusive by construction**: back-calc only fires when `costoUsd` is blank; once it sets a value, `debeBackCalcularCosto` returns `false` on any later blur (condition 1 fails) — no loop. `applyPricesFromCosto` is reached only via `handleCostoUsdChange`/`handleCostoBsChange`, which back-calc never calls (it writes `setCostoUsd` directly). Net effect: back-calc auto-applies cascade; the existing proyección-then-"Aplicar" flow is untouched for every other path.

## Notice UX: Inline, Not Toast

| Notice | Mechanism | Rationale |
|---|---|---|
| "Costo recalculado por el sistema" | Inline text near Costo USD field (`costoBackCalculado` boolean state) | Matches existing `ProyeccionPvpHint`/"Se calcula desde ingredientes" pattern; toast is disruptive for a convenience fill |
| Margen negativo clampado | Inline text under the offending margen cell (`avisoMargenNegativo: 'detal'\|'mayor'\|'especial'\|null`) | A toast would fire per keystroke while typing `-100` (spam); inline text coalesces naturally |

`costoBackCalculado` clears in `handleCostoUsdChange`/`handleCostoBsChange` (user-driven paths only — back-calc bypasses them), satisfying "corrección manual limpia el aviso".

## Tasa Guard

Every Bs write (`costoBs`, `precioMayorBs`, `precioEspecialBs`) is gated `tasaValor > 0`, identical to existing pattern elsewhere in the file. USD math is unaffected — tasa never divides.

## Negative Margin Clamp

Added at the top of `handleMargenChange`/`handleMargenMayorChange`/`handleMargenEspecialChange`: if `parseFloat(val) < 0`, use `'0'` as the effective value for both `setMargen*` and downstream PVP math, set `avisoMargenNegativo` to that level. Existing math/guards (`esComboLocal`, `costoN > 0`) unchanged otherwise.

## Files Touched

| File | Nature |
|---|---|
| `producto-precio-gating.ts` | Modify — add `FuentePrecio`, `debeBackCalcularCosto`, `backcalcularCostoYCascada` |
| `producto-precio-gating.test.ts` | Create — unit tests (canonical example, guards, clamp) |
| `producto-form.tsx` | Modify — 2 refs, 2 state flags, 1 orchestrator fn, 3 handler edits (clamp), ~6 fuente-ref writes, 3 `onBlur` additions, 2 inline hints |

No schema/migration changes — `margen >= 0` already guarantees `precio_venta_usd >= costo_usd` by construction, so `productoSchema` stays untouched (no scope expansion).

## Testing Strategy

| Layer | What | How |
|---|---|---|
| Unit | `debeBackCalcularCosto`, `backcalcularCostoYCascada`, cascade preserve/overwrite, canonical example, tasa=0 | Vitest, pure functions, no DOM |
| Component (manual/E2E later) | Blur wiring, inline hints, edit-mode default preserves loaded prices | Out of scope for this design; flagged for `sdd-tasks` |

## Migration / Rollout

No migration required — isolated to one component and one lib module.

## Open Questions

None blocking.
