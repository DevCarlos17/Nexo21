# Exploration: notas-credito-cuadre-origen-dinero

Base branch: `develop` @ `11ac472` (predecessor `notas-credito-ruta-administrativa` merged via PR #83 / `a139ce3`, archived at `openspec/changes/archive/2026-09-05-notas-credito-ruta-administrativa/`).

## Current State

### A. Cuadre de caja — how it reads movements today

File: `src/features/reportes/hooks/use-cuadre.ts` (1421 lines). Route: `src/routes/_app/ventas/cuadre-de-caja.tsx` → `cuadre-page.tsx` + `cuadre-*.tsx` components.

All hooks take a shared `CuadreFilters { fecha, cajaId, sesionCajaIds[] }` and build WHERE clauses via two builders:
- `buildCuadreWhere` (`use-cuadre.ts:35-62`) — for tables with `sesion_caja_id` (ventas, pagos, movimientos_metodo_cobro). When `sesionCajaIds` is non-empty it filters `sesion_caja_id IN (...)` (no date filter needed); otherwise falls back to `DATE(fecha,'localtime') = ?` (+ optional `cajaId` sub-select).
- `buildCuadreWhereViaVenta` (`:68-94`) — same logic but via JOIN through `ventas` for tables without `sesion_caja_id` (`ventas_det`).

Key hooks and what they read:
- `useVentasDelDia` (`:184-214`) — `SUM` on `ventas` (total_usd/bs), scoped by the builder above.
- `useGananciaEstimada` (`:216-238`) — `ventas_det` JOIN `productos`.
- `useCxcDelDia` (`:240-265`) — `ventas` where `tipo='CREDITO' AND saldo_pend_usd>0`.
- `usePagosPorMetodo` (`:333-474`) — 3 queries unioned: (1) `pagos` JOIN `metodos_cobro` where `pg.venta_id IS NOT NULL`, (2) EFECTIVO methods with manual `movimientos_metodo_cobro` but no venta payments, (3) EFECTIVO methods with only apertura. **NC cash refunds routed through `movimientos_metodo_cobro` (origen='NCR') are NOT summed anywhere in this hook** — it only reads `pagos`, never `movimientos_metodo_cobro` amounts directly (the manual-movements queries force `total_usd=0`/`total_original=0` literals, they only exist to surface the method row).
- `useSaldoEfectivoBimonetario` (`:859-958`) — computes expected cash per currency: `apertura + pagos_efectivo + ingresos_manuales - egresos_manuales`, reading `movimientos_metodo_cobro` with `origen NOT IN ('VENTA','COBRO','PROPINA')`. Since `'NCR'` is **not** in that exclusion list, an `EFECTIVO_REAL` NC refund (which inserts an `EGRESO`/`origen='NCR'` row into `movimientos_metodo_cobro`, `use-notas-credito.ts:867-887`) **is already netted into the expected-cash total** — this path is correctly wired today.
- `useTotalesFiscales` (`:1062-1173`) — reads `ventas` for fiscal aggregates, then a **separate** query against `notas_credito` (`:1137-1146`):
  ```sql
  SELECT SUM(total_usd), SUM(total_bs) FROM notas_credito
  WHERE empresa_id = ? AND DATE(fecha,'localtime') = ?
  ```
  **This is scoped by DATE ONLY, never by `sesion_caja_id`.** It ignores `filters.sesionCajaIds` entirely. Rendered as `totalNcrUsd`/`totalNcrBs` in `cuadre-imprimir.tsx:259-263` (fiscal breakdown, not cash reconciliation).
- `useMovimientosManualesDia` (`:785-825`) — lists `movimientos_metodo_cobro` grouped by método+tipo+origen for a session; would show 'NCR' origin rows if any exist, but there is **no dedicated NC table/section** in the cuadre UI — no component queries `notas_credito` joined to session detail.
- No hook anywhere joins `notas_credito.sesion_caja_id` to session filters. `useNotasCredito` (`use-notas-credito.ts:239-274`) is the admin list hook — it is never imported by any file under `src/features/reportes/`.

**Gap confirmed for scope item 4**: there is currently no "table of the session's NCs" component. `totalNcrUsd` exists but is date-scoped, not session-scoped — a multi-session day would double count NC amounts from other sessions in a single-session cuadre view, or a single-session view could omit its own NCs if computed at a different point during the day and included ones from co-open sessions. Also: `usePagosPorMetodo` (used for "payment methods in refunds") has **zero NCR awareness** — it would need a new query reading `movimientos_metodo_cobro` (`origen='NCR'`) to surface refund-by-method, and/or reading `notas_credito` joined by `sesion_caja_id` for the per-session NC table + contado/crédito split (need `ventas.tipo` via `notas_credito.venta_id` join).

### B. Tesorería egresos — `crearTraspaso` pattern

Two files are both named `crearTraspaso` — the relevant one per the prompt (treasury/PowerSync writes, not stock) is `src/features/tesoreria/hooks/use-traspasos.ts:140-310`. There is a second, unrelated `crearTraspaso` for warehouse stock transfers in `src/features/inventario/hooks/use-traspasos.ts:98` — not relevant here.

`crearTraspaso` (tesorería, `:140-310`) atomic shape inside one `db.writeTransaction`:
1. EGRESO movement in origin account: `movimientos_bancarios` (if `BANCO`) or `mov_caja_fuerte` (if `CAJA_FUERTE`) — snapshots `saldo_anterior`/`saldo_nuevo` via `parseFloat` + `.toFixed(4)` (4-decimal precision, matches project convention for tasas/rates but NOT the "2 decimals for money" rule — treasury tables consistently use 4).
2. `UPDATE {tabla} SET saldo_actual = ...` on the origin account.
3. INGRESO movement in destination account (same two-table branch).
4. `UPDATE` destino saldo_actual.
5. Single `INSERT INTO traspasos_tesoreria` row linking both movement ids (`mov_origen_id`, `mov_destino_id`), `cuenta_origen_tipo/id`, `cuenta_destino_tipo/id`, `tasa_cambio`, `reversado=0`.

All amounts use `parseFloat` (not `Decimal.js`, unlike `crearNotaCredito` which uses `Decimal` throughout) — this is a **precision-handling difference** to be aware of when implementing REFUND_TESORERIA: `crearNotaCredito` should keep using `Decimal` (its existing pattern), not adopt `parseFloat` from this file.

**`empresa_id` filtering**: writes always stamp `empresa_id` on inserts, but reads inside `crearTraspaso` (`SELECT saldo_actual FROM bancos_empresa WHERE id = ?` / `caja_fuerte WHERE id = ?`) do **not** filter by `empresa_id` — cross-tenant risk exists already in this pattern (pre-existing, not introduced by this change, but worth noting if REFUND_TESORERIA copies this exact snippet verbatim).

More directly relevant to REFUND_TESORERIA is **`consolidarMetodoATesoreriaEnTx`** (`:618-799`) — a variant that runs **inside a caller-provided transaction** (no nested `writeTransaction`, PowerSync does not support nesting) and moves money **from a `metodos_cobro` balance in a session TO caja_fuerte/banco** (`SESION_CAJA → TESORERIA` direction). Its inverse, **`crearTraspasoTesoreriaASesion`** (`:840-967`), moves **FROM `caja_fuerte` TO a session's `metodos_cobro`** (`TESORERIA → SESION_CAJA` direction, already `validado=1` immediately, no pending state).

REFUND_TESORERIA is conceptually the payout side: money leaves treasury (caja_fuerte, and only caja_fuerte — no destination "sesión" needed since money exits to the customer, not into POS). The closest existing shape is the **EGRESO half of `crearTraspasoTesoreriaASesion`** (`:886-913`, insert `mov_caja_fuerte` EGRESO `validado=1` + saldo update) **without the corresponding INGRESO half** (there is no destination account — the money leaves the business entirely, unlike a traspaso which always has two internal accounts). No existing function models a treasury egress with no internal destination; `crearTraspaso`/`consolidarMetodoATesoreriaEnTx` always write both sides. **REFUND_TESORERIA needs a NEW write shape**: one `mov_caja_fuerte` (or `movimientos_bancarios`) EGRESO row, `saldo_actual` update, and a reference back to `notas_credito.id` (there is no `traspasos_tesoreria` row needed unless the design wants an audit trail there too — open question, see below).

### C. `crearNotaCredito` — end-to-end read (`src/features/ventas/hooks/use-notas-credito.ts`, 1044 lines)

**(a) Exact "regla de oro" conditional** — `:418-422`:
```ts
const aplicaReglaDeOro =
  entryPoint === 'POS' &&
  modalidad === 'EFECTIVO_REAL' &&
  !!sesionCajaActivaId &&
  venta.sesion_caja_id === sesionCajaActivaId
```
This is the ONLY gate deciding whether a cash egress row (`movimientos_metodo_cobro`, origen='NCR') is written (`:853-897`, only executes for `tipo==='TOTAL'`). It conflates THREE independent concerns into one boolean:
1. **Money origin** — should this NC produce a real cash movement at all? (today: only if `modalidad==='EFECTIVO_REAL'`)
2. **Which account absorbs it** — today always `sesionCajaActivaId` (hardcoded to the CALLER's own active session via `sesionCajaActivaId ?? null` at line `:880`, the SAME variable used in the gate condition)
3. **Same-session-as-original-sale requirement** — `venta.sesion_caja_id === sesionCajaActivaId`, i.e. you can ONLY refund cash into the session if it's literally the same session the sale was made in

Decoupling (conceptual, no code written): the boolean needs to split into (1) "does this modality produce a cash movement" (already isolated via `esModalidadNoDesembolso`/`MODALIDADES_NO_DESEMBOLSO`, `:96-105` — `EFECTIVO_REAL` and `REFUND_TESORERIA` are the two modalities that DO move cash) and (2) "where does the cash come from" — a new explicit parameter (e.g. `origenDinero: { tipo: 'SESION'; sesionId: string } | { tipo: 'TESORERIA'; cajaFuerteId: string }`) instead of implicitly reusing `sesionCajaActivaId`/`venta.sesion_caja_id === sesionCajaActivaId`. The "same session as the sale" constraint would need to be DROPPED as a hard requirement and replaced by "any ACTIVE session" (rule 6 in the brief) — meaning the egress write target becomes a caller-chosen session id, validated as `status='ABIERTA'` inside the tx, not necessarily equal to `venta.sesion_caja_id`.

**(b) REFUND_TESORERIA throw** — `:363-365`:
```ts
if (modalidad === 'REFUND_TESORERIA') {
  throw new Error('REFUND_TESORERIA aun no esta implementado (ver Slice 6)')
}
```
This throws BEFORE `db.writeTransaction` opens (same pattern as the anti-fraud gate at `:358`) — good, no dangling tx. `LiquidacionModalidad` type (`:89-94`) already lists `REFUND_TESORERIA` as a valid value; the CHECK constraint in `migrations/0091_notas_credito_schema.sql:60-61` already allows it in the DB. So the type/schema plumbing for the modality itself is DONE — only the write logic is missing.

**(c) AJUSTE_CXC / crédito-a-favor path (working today)** — `:965-1004`, inside the `remanenteALiquidar` switch (`:909-1004`, only entered when `remanenteALiquidar.gt('0.01')`, i.e. only for the portion NOT already applied to the invoice's own pending balance in Step A `:779-827`). AJUSTE_CXC re-reads `clientes.saldo_actual`, subtracts `remanenteALiquidar` (floored at 0 via `Decimal.max`), writes ONE `movimientos_cuenta` row (`tipo='NCR'`, referencia=`{nroNcr}-AJUSTE`) and updates `clientes.saldo_actual`. **It writes NOTHING to `caja`/`tesoreria`/kardex beyond the stock reingreso already done in step 5 for ALL modalities** — it purely cancels existing CxC debt, never touches cash accounts. `SALDO_FAVOR`/`COMPENSACION_VENTA` (`:909-964`) are siblings that instead grow `movimientos_cuenta` type `'SAFC'` (saldo a favor, tracked back to `nota_credito_id` via `doc_origen_id`/`doc_origen_tipo`).

**(d) `entryPoint`/`modalidad` param shape** — `CrearNotaCreditoParams` (`:141-197`). `entryPoint: 'POS' | 'TRADICIONAL'` decides ONLY whether `sesion_caja_id` gets stamped on the `notas_credito` row (`:401`, `sesionCajaIdParaNc`) — it is a pure "where was this button clicked" audit field, separate from the money-origin question. `modalidad: LiquidacionModalidad` (5 values, `:89-94`) decides the liquidation branch. Today's UI callers hardcode combinations: `nota-credito-pos-modal.tsx` always passes `entryPoint:'POS'` + `sesionCajaActivaId: sesion.id` (`:336-337`) with `modalidad` chosen from `MODALIDADES_POS` (`:57-62`, 4 options, **REFUND_TESORERIA deliberately excluded** — comment at `:53-55` says "Design/tasks (Slice 6, task 6.3) la reserva SOLO al modulo Tradicional, nunca al POS"). `crear-ncr-modal.tsx` always passes `entryPoint:'TRADICIONAL'` + `modalidad:'AJUSTE_CXC'` hardcoded (`:182-186`), with a disabled "Devolver dinero" button (`:279-286`) that never changes `modalidad`.

**Contradiction to flag for proposal**: the brief says "Devolver dinero" must work in BOTH POS and admin route, but the archived design decision for the POS modal (comment in `nota-credito-pos-modal.tsx:53-55`) explicitly reserved `REFUND_TESORERIA` for Tradicional ONLY. This exploration does not resolve that tension — it is an open question for `sdd-propose`/`sdd-design` (see below).

### D. Schema flag `entry_point`

Confirmed via `src/core/db/powersync/schema.ts:753-778` (the `notas_credito` Table definition) and `migrations/0091_notas_credito_schema.sql`: **no `entry_point` (or similarly named) column exists** on `notas_credito`. The `entryPoint` TypeScript param is NEVER persisted — only `sesion_caja_id` (nullable, only set for POS) is written. There is currently no way to distinguish "this NC came from the admin route on a NULL-session TRADICIONAL flow" from any other TRADICIONAL-origin NC after the fact by querying the DB (the POS-vs-admin badge in scope item 5 needs a NEW persisted column, `sesion_caja_id IS NULL` alone is not a reliable proxy since Tradicional always leaves it NULL regardless of whether the invoice happened to belong to a still-open session).

Migrations: last applied is `0091_notas_credito_schema.sql`. **Next migration number is `0092`.** Naming convention observed (see `migrations/README.md` conventions, not read in full here but inferred from filenames): `NNNN_snake_case_description.sql`, sequential, idempotent (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` + re-`ADD`), header comment block with Migration/Created/Depends/CONTEXT/ROLLBACK sections (see `0091` as the template to copy). PowerSync convention (per project CLAUDE.md and confirmed by `0091`'s own boolean/text columns): new boolean flag → `column.integer` in `schema.ts` + `BOOLEAN` in Postgres; new enum-like flag → `column.text` + `CHECK (... IN (...))` in Postgres, following the exact pattern used for `liquidacion_modalidad` (`0091:59-61`).

### E. Existing tests (RED-first surface / regression risk)

Files touching the functions this change modifies:
- `src/features/ventas/hooks/__tests__/use-notas-credito.test.ts` — the big one. Covers Slice 2 (regla de oro + sesion_caja_id link), Slice 3 (modalidades + anti-fraud gate), Slice 4b (PARCIAL wiring), Slice 5a-2a (deposito override). Line 699-706 already has the exact assertion this change must FLIP: `it('crearNotaCredito: REFUND_TESORERIA rechaza como "no implementado" (Slice 6)...')` expects a REJECT — this test must be rewritten (not just extended) once REFUND_TESORERIA is implemented.
- `src/features/ventas/components/__tests__/crear-ncr-modal.test.tsx` — line 200: `it('"Devolver dinero" esta deshabilitada... nunca dispara crearNotaCredito')` — must also flip once the selector becomes functional.
- `src/features/ventas/components/__tests__/nota-credito-pos-modal.test.tsx` — covers `EFECTIVO_REAL`/`SALDO_FAVOR` dispatch from the POS modal; will need new cases for whatever UI represents "Tesorería" as a money-origin choice, if scope item 1 adds it here too.
- `src/features/ventas/utils/__tests__/notas-credito-ui.test.ts`, `notas-credito-pin-gating.test.ts` — pure-function tests, likely untouched unless the money-origin selector needs its own pure gating helper.

**No test files exist** for `src/features/reportes/hooks/use-cuadre.ts` (confirmed: no `__tests__` directory under `src/features/reportes/hooks/`) nor for `src/features/tesoreria/hooks/use-traspasos.ts` (confirmed: no `__tests__` directory under `src/features/tesoreria/hooks/`). Both are currently **untested despite handling real money** — this change is the first to touch cuadre logic and will need to build its test harness from scratch (no existing PowerSync-mock pattern to copy for these two files specifically; `use-notas-credito.test.ts` line 118 area has the `db.writeTransaction` mock pattern to reuse for any new tesorería-adjacent test).

## Money-flow map

```
NC liquidacion_modalidad → does it move cash? → where does the cash come from?
├── SALDO_FAVOR         → NO (esModalidadNoDesembolso) → movimientos_cuenta (SAFC), clientes.saldo_actual↓
├── COMPENSACION_VENTA  → NO                            → same as SALDO_FAVOR (SAFC), consumed by a separate crearVenta() later
├── AJUSTE_CXC          → NO                            → movimientos_cuenta (NCR-AJUSTE), clientes.saldo_actual↓ (never below 0)
├── EFECTIVO_REAL       → YES, conditionally            → movimientos_metodo_cobro EGRESO/'NCR', ONLY IF
│                                                            entryPoint==='POS' && sesionCajaActivaId && venta.sesion_caja_id===sesionCajaActivaId
│                                                            (today's "regla de oro" — same-session hard requirement)
└── REFUND_TESORERIA    → THROWS (not implemented)       → intended target per this change: mov_caja_fuerte (or
                                                             movimientos_bancarios) EGRESO, no internal destination account
                                                             (money exits the business — closest existing shape is the
                                                             EGRESO half of crearTraspasoTesoreriaASesion, minus the INGRESO half)
```

All modalities ALWAYS reingresa stock (step 5, `:631-777`) and ALWAYS reverse the original `pagos` rows for `tipo==='TOTAL'` (`:889-896`) — those two effects are modality-independent and out of scope for this change.

## Open questions for proposal

1. **POS ↔ Tesorería tension**: the brief requires "Devolver dinero" functional in BOTH POS and admin route, but the existing (already-merged) design comment in `nota-credito-pos-modal.tsx:53-55` explicitly reserves `REFUND_TESORERIA` for Tradicional only ("Slice 6, task 6.3"). Does this change REVERSE that prior decision (add REFUND_TESORERIA to `MODALIDADES_POS`), or does "functional in POS" mean something narrower (e.g. POS can only refund from its OWN active session's cash, never treasury, and REFUND_TESORERIA stays Tradicional-only)? This determines whether `nota-credito-pos-modal.tsx` needs modification at all (currently FROZEN per its own docstring, `:114-131`).
2. **"Any active session" mechanics**: rule 6 says money may come from ANY active session, not just the one from the original sale. `useSesionesActivasDashboard` (`src/features/caja/hooks/use-sesiones-caja.ts:337+`) already lists all empresa-wide open sessions with cashier names — reusable for a selector. But writing an EGRESO into a session that is NOT the caller's own currently-open session (e.g. supervisor in Tradicional picks "cashier B's open session") is a NEW capability with no precedent in the codebase (every existing money-write into `metodos_cobro`/session scope uses the CALLER's own active session). Needs an explicit decision on authorization (who can pick another cashier's session) and on how `useSaldoEfectivoBimonetario`/`usePagosPorMetodo` in `use-cuadre.ts` react when viewing session B's cuadre and finding an egress caused by an NC created while viewing session A.
3. **Closed-session invariant**: rule 6 also says an NC over a CLOSED session must not touch that session's cuadre/list. Today `venta.sesion_caja_id` can point to a CLOSED session (the sale happened, session closed, NC created later from Tradicional). Since `sesionCajaIdParaNc` (`:401`) is only ever set for `entryPoint==='POS'`, and POS by definition works against `useSesionActiva()` (an OPEN session), this invariant is likely already implicit for `entryPoint==='POS'` — but needs an explicit guard for `REFUND_TESORERIA` called from Tradicional against a sale whose original session is closed (must NOT try to write into it) and for the "any active session" selector (must reject picking a closed one — `reversarTraspaso` already has this exact guard pattern to copy, `use-traspasos.ts:394-402`: `SELECT status FROM sesiones_caja WHERE id=?` then throw if `'CERRADA'`).
4. **`traspasos_tesoreria` row for REFUND_TESORERIA?** Should a refund-to-treasury-payout also insert a `traspasos_tesoreria` audit row (like every other treasury movement), or is a plain `mov_caja_fuerte`/`movimientos_bancarios` EGRESO with `doc_origen_id = ncrId` sufficient? Precedent `consolidarMetodoATesoreriaEnTx` always pairs with a `traspasos_tesoreria` row even inside a shared tx — likely should follow that precedent for consistency of the tesorería audit trail, but there's no "external payout" concept in `traspasos_tesoreria`'s two-sided schema (`cuenta_origen_tipo`/`cuenta_destino_tipo` both NOT NULL) — may need a sentinel destino type or the table may simply not apply here (open decision for design phase).
5. **Bank vs caja fuerte for REFUND_TESORERIA**: `crearTraspasoTesoreriaASesion` only supports `caja_fuerte` as source; `crearTraspaso`(generic) supports both `BANCO` and `CAJA_FUERTE`. Should REFUND_TESORERIA support paying from a bank account too (e.g. bank transfer refund), or only physical caja fuerte cash? Money-origin selector UI in scope item 1 needs to know this before it can be designed.
6. **entry_point values**: what exact string values does the new column need? At minimum `'POS' | 'TRADICIONAL'` mirroring the existing in-memory `entryPoint` param — but scope item 5 talks about a badge "vía administración" specifically, implying the column may need to just persist the existing `entryPoint` param verbatim (trivial addition: pass `entry_point: params.entryPoint` into the existing INSERT at `:603-629`) rather than model anything new.

## Rough slice / PR forecast

This is explicitly flagged upstream as a "change grande." Based on the surface area touched:

1. **Schema slice** — migration `0092_notas_credito_entry_point.sql` (or similar) + `schema.ts` column. Small, isolated, safe first PR.
2. **REFUND_TESORERIA write logic** — new branch inside `crearNotaCredito`'s existing `db.writeTransaction`, replacing the `:363-365` throw. Touches the highest-risk file in the repo (real money + kardex + CxC + cuadre in one atomic tx) — needs RED-first tests added to the existing 1000+ line `use-notas-credito.test.ts` BEFORE implementation, per Strict TDD.
3. **"Regla de oro" decoupling** — refactor of `:418-422` + `:401` (money-origin param threading) — touches BOTH the POS and Tradicional callers' contracts (`CrearNotaCreditoParams` shape change), high regression risk against the ~15 existing describe blocks in `use-notas-credito.test.ts` that assert on `aplicaReglaDeOro` behavior.
4. **"Any active session" selector + closed-session guard** — new UI (money-origin picker) in both modals, new query (`useSesionesActivasDashboard`-adjacent), new guard logic.
5. **Cuadre integration** — new hook(s) in `use-cuadre.ts` (session-scoped NC total replacing/supplementing the date-scoped `totalNcrUsd`, a "session's NCs" table hook, NCR-aware `usePagosPorMetodo` reconciliation) + new component(s) under `src/features/reportes/components/cuadre-*.tsx`. Zero existing tests to extend from — full new test file needed.
6. **`entry_point` badge in POS list** — small, isolated (`use-facturas-sesion-activa.ts` query + a badge in the list component).

Given `use-notas-credito.ts` alone is 1044 lines and its test file is 1000+ lines, and `use-cuadre.ts` is 1421 lines with zero tests today, **the 400-line review budget will almost certainly be exceeded** even by slice 2 or 3 alone. `feature-branch-chain` (already the cached delivery strategy) is the right call — recommend ordering slices 1 → 3 → 2 → 4 → 5 → 6 (schema first so later slices don't block on it; decouple the golden rule before implementing REFUND_TESORERIA so the new write logic is built against the FINAL param shape, not a shape that gets refactored out from under it one PR later).

## Constraints recorded (not acted on here)

- Tester works on a different PC — branches must be pushed to `origin` before QA. (Delivery note only — no action taken in this phase.)
- `crearNotaCredito` stops being frozen for this change but remains extremely high-risk (real money, kardex, CxC, cuadre) — RED-first TDD is mandatory for every new branch inside it.
