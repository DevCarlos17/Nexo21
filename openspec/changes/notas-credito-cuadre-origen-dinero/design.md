# Design: Notas de Crédito — Origen de Dinero Configurable + Cuadre

Base: `develop` @ `11ac472`. Grounds every claim in `explore.md` citations + obs #2935. All 4 deferred decisions are **RESOLVED** below.

## Technical Approach

One new account-descriptor param (`origenDinero`) replaces the implicit `sesionCajaActivaId` reuse inside `crearNotaCredito`'s existing `db.writeTransaction` (`use-notas-credito.ts:370-1044`). No new transaction, no nested writes (PowerSync forbids nesting). `modalidad` keeps deciding **category** (session-drawer vs. treasury); `origenDinero` decides the **specific account** inside that category. Schema-wise: 1 new column (`entry_point`) + 2 CHECK-constraint value additions — `mov_caja_fuerte`/`movimientos_bancarios` already have `doc_origen_id`/`doc_origen_tipo`, so no audit-table redesign is needed.

## Resolved Decisions

### Decision 1 — Bank vs caja fuerte for REFUND_TESORERIA
**Status**: RESOLVED. **Choice**: support both, mirroring `crearTraspaso`'s two-table branch (`use-traspasos.ts:159-217`).
**Alternatives considered**: caja-fuerte-only (rejected — obs #2935 explicitly puts bank in scope).
**Rationale**: `mov_caja_fuerte` and `movimientos_bancarios` are structurally identical for this purpose (`saldo_actual`, `doc_origen_id`, `doc_origen_tipo` on both, `schema.ts:905-975`). Precision: keep `Decimal.js` throughout (crearNotaCredito's existing pattern) — do **not** adopt `parseFloat`/`Number.toFixed` from `use-traspasos.ts:164-196`. Store via `decimalValue.toFixed(4)` (Decimal method, not JS float rounding) — treasury tables are `NUMERIC(18,4)`/`column.text`, 4dp is the pre-existing convention for these two tables specifically (not the general 2dp money rule).

### Decision 2 — `traspasos_tesoreria` audit row
**Status**: RESOLVED. **Choice**: NO `traspasos_tesoreria` row. Reference the NC via the EGRESO row's own `doc_origen_id = ncrId` / `doc_origen_tipo = 'NOTA_CREDITO'` — **columns that already exist** on both `mov_caja_fuerte` and `movimientos_bancarios` (`schema.ts:961-962`, `915-916`; confirmed free-text, no CHECK). **No migration needed for this decision.**
**Alternatives considered**: force a two-sided row like `consolidarMetodoATesoreriaEnTx`/`crearTraspasoTesoreriaASesion` always do (`use-traspasos.ts:944-965`) — rejected. `traspasos_tesoreria.cuenta_destino_tipo`/`id` are `NOT NULL` (`schema.ts:983-984`); a refund payout has no internal destino (money exits to the customer), so this would need a fake sentinel destino type — schema dishonesty.
**Rationale**: precedent for "audit via `doc_origen_id` on the movement row, no `traspasos_tesoreria` row" already exists in THIS SAME feature: EFECTIVO_REAL's cash egress (`movimientos_metodo_cobro`, `:867-885`) does exactly this today with zero `traspasos_tesoreria` involvement. Consistency-with-precedent beats consistency-with-`traspasos_tesoreria`'s two-sided shape.

### Decision 3 — `entry_point` values
**Status**: RESOLVED. **Choice**: `entry_point TEXT NOT NULL DEFAULT 'TRADICIONAL' CHECK (entry_point IN ('POS','TRADICIONAL'))`, persists `params.entryPoint` verbatim at the existing INSERT (`:603-629`).
**Backfill for existing rows**: `sesion_caja_id IS NOT NULL → 'POS'`, else `'TRADICIONAL'`. Justified by code, not guessed: `sesionCajaIdParaNc` (`:401`) is set **only** when `entryPoint==='POS'`, and the POS modal always requires a non-null `sesion` prop before it can call `crearNotaCredito` (`nota-credito-pos-modal.tsx:48-49`) — so every historical POS-issued NC has `sesion_caja_id` set, and every Tradicional-issued NC has it NULL. The backfill is deterministic, not a lossy guess.
**Badge**: "vía administración" = `entry_point = 'TRADICIONAL'`.

### Decision 4 — money-origin authorization, asymmetric by route (RESOLVED per owner, obs #2938)
**Status**: RESOLVED. **Choice**: asymmetric-by-route, grounded in Clara's philosophy (guide toward best admin practices WITHOUT limiting each user's creativity/ways of working). The divergence between issuance-session and money-session is an **intentional feature**, allowed ONLY from the administrative route; the POS is the protected rail.

| Route (`entryPoint`) | Invoices visible | Allowed `origenDinero` |
|---|---|---|
| `POS` | Only the active session's invoices | **Only** the cashier's OWN active session cash. `origenDinero.tipo==='SESION_EFECTIVO'` ⇒ `origenDinero.cuentaId` MUST equal `sesionCajaActivaId`. (TESORERIA/BANCO also allowed as origin, but never another cashier's session.) |
| `TRADICIONAL` | Empresa-wide | ANY session where `status='ABIERTA'` (query pattern `useSesionesActivasDashboard`, `use-sesiones-caja.ts:337-355`), tesorería, or bank. |

**Resulting validation rule** (before opening tx): `if entryPoint==='POS' && origenDinero.tipo==='SESION_EFECTIVO' && origenDinero.cuentaId !== sesionCajaActivaId → throw`. From `TRADICIONAL` this restriction does NOT apply. No new permission/role gate this change (per-role restriction stays future scope, same spirit as the deferred per-payment-method restriction).
**Mandatory guard** (new precedent, no exact prior call site — every existing money-write used the caller's own session): inside the tx, before writing the egress, `SELECT status FROM sesiones_caja WHERE id=? AND empresa_id=?`; throw if missing or `status='CERRADA'` (exact pattern of `use-traspasos.ts:394-402`, but applied at **write** time, not just reversal time).
**Cuadre invariant — traced, holds**: the `movimientos_metodo_cobro` row must store `sesion_caja_id = origenDinero.cuentaId` (the **chosen** session), replacing today's hardcoded `sesionCajaActivaId ?? null` (`:880`). `buildCuadreWhere`/`buildMovsWhere` (`use-cuadre.ts:35-62`) filter strictly `sesion_caja_id IN (filters.sesionCajaIds)` — so viewing session B's cuadre with `sesionCajaIds=[B]` correctly includes the egress, and the caller's own session A correctly excludes it. `useSaldoEfectivoBimonetario` (`:906-919`) and `usePagosPorMetodo`'s manual-movement queries (`:344-347`) key off the same `mmc.sesion_caja_id IN (...)` filter — the invariant holds structurally as long as the write consistently uses `origenDinero.cuentaId`, never the caller's own id.
**Intentional divergence (owner-accepted, obs #2938)**: `notas_credito.sesion_caja_id` keeps recording the **issuance** session (`entryPoint==='POS' ? sesionCajaActivaId : null`, unchanged), which can now legitimately **differ** from the money's session — but ONLY when issued from `TRADICIONAL` (POS is locked to its own session). Concretely: from admin, an operator issues the NC (`notas_credito.sesion_caja_id=NULL`) but picks session B's drawer as `origenDinero` → B's cash total drops (correct); B's cashier sees an `EGRESO`/`origen='NCR'` row. **Traceability seed folded into the cuadre design below**: the refund-by-method query joins `movimientos_metodo_cobro.doc_origen_id → notas_credito.id` (existing column, no schema change) so session B's cuadre displays the originating `nro_ncr`. This same `doc_origen_id` join is the **seed for the NEXT change's cashier alert** ("your cash flow was affected by another session's invoice") — out of scope here, but this change must not foreclose it.

## `origenDinero` Shape and Decoupling (pseudo-logic)

```
origenDinero: { tipo: 'SESION_EFECTIVO' | 'TESORERIA_EFECTIVO' | 'BANCO', cuentaId: string }
// required only when modalidad moves cash (EFECTIVO_REAL | REFUND_TESORERIA)

validate (before opening tx, alongside assertGateAntiFraudeNoDesembolso):
  if modalidad === 'EFECTIVO_REAL'    and origenDinero.tipo !== 'SESION_EFECTIVO'   → throw
  if modalidad === 'REFUND_TESORERIA' and origenDinero.tipo === 'SESION_EFECTIVO'   → throw
  if esModalidadNoDesembolso(modalidad) and origenDinero !== undefined              → throw (gate extension)
  // Decision 4 — POS protected rail (obs #2938): POS may only spend its OWN session cash
  if entryPoint === 'POS' and origenDinero.tipo === 'SESION_EFECTIVO'
     and origenDinero.cuentaId !== sesionCajaActivaId                               → throw
  // from TRADICIONAL this restriction does NOT apply (empresa-wide active session allowed)

inside tx, three independent concerns (was one boolean at :418-422):
  movesCash        = !esModalidadNoDesembolso(modalidad)              // unchanged (:96-105)
  cuentaDestino     = origenDinero                                    // NEW — explicit, not implicit sesionCajaActivaId
  // "same session as the sale" requirement: DROPPED. Replaced by:
  sesionValida      = origenDinero.tipo !== 'SESION_EFECTIVO'
                       || sesionStatus(origenDinero.cuentaId) === 'ABIERTA'   // Decision 4 guard
```

## New Write Branches (same single `db.writeTransaction`)

Replaces the `:363-365` throw and extends `:853-897`:

```
if movesCash and sesionValida:
  if origenDinero.tipo === 'SESION_EFECTIVO':
    // existing loop (:867-885), UNCHANGED shape, one change: sesion_caja_id = origenDinero.cuentaId (not sesionCajaActivaId)
    for each non-reversed pago: INSERT movimientos_metodo_cobro (EGRESO, origen='NCR', doc_origen_id=ncrId, sesion_caja_id=origenDinero.cuentaId)
  else: // TESORERIA_EFECTIVO | BANCO — REFUND_TESORERIA
    tabla = origenDinero.tipo === 'BANCO' ? 'bancos_empresa'/'movimientos_bancarios' : 'caja_fuerte'/'mov_caja_fuerte'
    montoRefundUsd = totalUsdNc                    // Decimal — full NC value, mirrors EFECTIVO_REAL refunding the full pago set
    montoCuenta = cuenta.moneda === 'VES' ? usdToBs(montoRefundUsd, venta.tasa) : montoRefundUsd   // bimonetario rule 1
    saldoAnt = new Decimal(cuenta.saldo_actual); saldoNuevo = saldoAnt.minus(montoCuenta)
    INSERT INTO {mov_table} (tipo='EGRESO', origen='REFUND_NCR', monto=montoCuenta.toFixed(4),
      saldo_anterior=saldoAnt.toFixed(4), saldo_nuevo=saldoNuevo.toFixed(4),
      doc_origen_id=ncrId, doc_origen_tipo='NOTA_CREDITO', validado=1, validado_por=usuario_id, validado_at=now)
    UPDATE {cuenta_table} SET saldo_actual = saldoNuevo.toFixed(4)
// reversa de pagos (:892-896) stays unconditional for tipo='TOTAL', unchanged
```
One consolidated EGRESO row per NC for treasury/bank (not per-pago) — `caja_fuerte`/`bancos_empresa` have no "método" subdivision, unlike a session drawer. `empresa_id` stamped on every INSERT; reads (`SELECT saldo_actual FROM ...`) MUST filter `WHERE id=? AND empresa_id=?` — do **not** replicate the cross-tenant read gap flagged at `use-traspasos.ts:45/161/190` (pre-existing, not to be copied).

## Cuadre Integration (5 effects, real hooks in `use-cuadre.ts`)

| # | Change | Hook | Detail |
|---|--------|------|--------|
| 1 | NC total scoped by session | `useTotalesFiscales` (`:1137-1146`) | Replace the raw `DATE(fecha)=?` WHERE with `buildCuadreWhere(filters, empresaId)` directly on `notas_credito` (already has `sesion_caja_id`+`empresa_id`+`fecha`) — drop-in, no new hook. |
| 2 | Refund-by-método (NCR-aware) | New: `useReintegrosPorMetodo(filters)` | `movimientos_metodo_cobro` JOIN `metodos_cobro` JOIN `notas_credito ON doc_origen_id=notas_credito.id` WHERE `origen='NCR'` AND `buildMovsWhere`-style `sesion_caja_id IN (...)`, GROUP BY método — surfaces `nro_ncr` for cross-session traceability (Decision 4 mitigation). |
| 3 | "NC de la sesión" table | New: `useNotasCreditoDeSesion(filters)` | `notas_credito` scoped by `buildCuadreWhere` (issuance session) JOIN `ventas` for `tipo` (contado/crédito split, per explore.md gap). Lists NCs **issued** from this POS session — separate concern from cash impact (see hazard above). |
| 4 | New component(s) | `src/features/reportes/components/cuadre-notas-credito.tsx` | Renders #2 + #3 as sibling sections under the existing cuadre page. |
| 5 | `usePagosPorMetodo` stays untouched | — | It reads `pagos` only; refund reconciliation lives in the new #2 hook, not bolted onto #5 (keeps its 3-query union simple, per explore.md). |

`useSaldoEfectivoBimonetario` needs **zero code changes** — `'NCR'` is already outside its exclusion list (`:916`, confirmed in explore.md); it nets correctly once the write path stores the correct `sesion_caja_id` (Decision 4).

## Migration `0092_notas_credito_entry_point_refund.sql`

Idempotent, follows `0091`'s template exactly:
1. `ALTER TABLE notas_credito ADD COLUMN IF NOT EXISTS entry_point TEXT;` → backfill (Decision 3 CASE) → `SET NOT NULL` → `SET DEFAULT 'TRADICIONAL'` → `CHECK (entry_point IN ('POS','TRADICIONAL'))`.
2. `mov_caja_fuerte_origen_check`: DROP/ADD, append `'REFUND_NCR'` to the existing 5 values (`0035:39`).
3. `movimientos_bancarios_origen_check`: DROP/ADD, append `'REFUND_NCR'` to the existing 8 values (`0077:24-26`).
4. `schema.ts`: add `entry_point: column.text` to the `notas_credito` Table (`:753-778`).
Rollback: `DROP COLUMN entry_point`; restore both CHECKs to their pre-0092 value lists (documented verbatim in the migration header, per `0091`/`0077` convention).

## Testing Strategy (RED-first per slice)

| Slice | Must FLIP (existing) | New tests | Harness |
|---|---|---|---|
| 3 (REFUND_TESORERIA) | `use-notas-credito.test.ts:699-707` (expects reject) → rewrite to assert the new EGRESO INSERT shape for both `caja_fuerte`/`bancos_empresa` | Decimal precision assertions (`.toFixed(4)`, no `parseFloat`), `doc_origen_id`/`doc_origen_tipo` traceability, currency conversion via `venta.tasa` | Reuse `mockCrearNcrTx` (`:122-139`) — extend `NcrTxFixtures` with `cajaFuerte`/`bancoEmpresa` saldo rows |
| 2 (decouple) | ~15 describe blocks asserting `aplicaReglaDeOro` (per explore.md §E) — rewrite, not extend | `origenDinero` validation errors (mismatched tipo/modalidad), closed-session guard reject | Same mock, add `sesionStatus` fixture |
| 4 (selector+guard) | `crear-ncr-modal.test.tsx:200-207` (disabled button) → flip to functional dispatch | Cross-session selector renders `useSesionesActivasDashboard` rows; closed-session rejected in UI | RTL, existing modal test patterns |
| 5 (cuadre) | none (zero existing tests) | New harness for `use-cuadre.ts` + `use-traspasos.ts` — first tests ever for these files; reuse `db.writeTransaction`/`useQuery` mock pattern from `use-notas-credito.test.ts:118`+ | New `__tests__` dirs |

## Slice/PR Boundaries (feature-branch-chain, budget 400 lines each)

| # | Slice | Scope | Risk |
|---|---|---|---|
| 1 | Schema | Migration 0092 + `schema.ts` column | Low — additive only |
| 2 | Decouple regla de oro | `origenDinero` param, validation, drop same-session check, rewrite ~15 describes | High regression surface, no new money paths yet |
| 3 | REFUND_TESORERIA | New write branch (Decision 1/2), RED-first tests first | Highest — real money + Decimal precision |
| 4 | Selector + guard | UI in both modals, closed-session guard, cross-session query | Medium — new UX, no precedent |
| 5 | Cuadre | 3 new/changed hooks + component | High — zero existing test harness for `use-cuadre.ts` |
| 6 | Badge | `entry_point` badge in POS list | Low — isolated |

Order matches the proposal: 1 → 2 → 3 → 4 → 5 → 6 (decouple before REFUND_TESORERIA so the write logic targets the final `origenDinero` shape, not a shape refactored out from under it).

## Open Questions
- [x] Owner sign-off on Decision 4 — RESOLVED (obs #2938): asymmetric-by-route (POS locked to own session, TRADICIONAL empresa-wide). Divergence accepted as intentional feature, only from admin. `doc_origen_id` join = traceability seed for the NEXT change's cross-session cashier alert.
- [ ] `'REFUND_NCR'` as the new `origen` constant name — open to bikeshedding, not a design blocker (deferred to apply).
