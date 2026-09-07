# Exploration: Notas de Crédito (Credit Notes) — Reconnaissance

## Executive Summary

A **partial, "anulación total únicamente" credit-note flow already exists and is wired end-to-end** (route → page → modal → atomic hook → schema), but it only covers ONE of the many scenarios the user described: full-invoice voiding with automatic stock reversal and automatic saldo-pendiente cancellation. It does **not** handle partial credit notes, does **not** touch money/refunds at all (no tesorería, no CxP, no multi-currency), has **no PIN gating**, and has **no POS entry point**. Critically, the existing `crearNotaCredito()` write path has a **live bug**: it inserts a `created_by` value into `notas_credito`, a column that does not exist in either the Postgres table or the PowerSync schema — this will throw at runtime the first time a real (non-mocked) transaction executes it. On the positive side, the DB schema (`notas_credito`/`notas_credito_det`, Postgres CHECK `tipo IN ('TOTAL','PARCIAL')`, a trigger that caps cumulative NC totals against the invoice) was clearly designed for partial NCs from day one, and several major pieces of cross-module infrastructure the user described as "probably missing" **already exist and are directly reusable**: a pending/unvalidated tesorería-movement concept (`validado`/`validado_por`/`reversado` on both `movimientos_bancarios` and `mov_caja_fuerte`, with a full conciliación UI), a saldo-a-favor (credit-to-client) pattern via negative `clientes.saldo_actual`, a `SupervisorPinDialog` component with permission-slug bypass logic, and a NC total already surfaced in the cuadre de caja report. The bimonetary Decimal-leak "gotcha" flagged by the orchestrator does **not** reproduce in current code — `usdToBs`/`bsToUsd` intentionally return `Decimal` by design, with separate `format*`/`toStorageString` functions for display/storage; this is a deliberate, consistently-used architecture, not a bug.

## Current State — Findings by Area

### 1. Sales invoice (`ventas`) creation — the atomic-write template

- Feature folder: `src/features/ventas/`. Core write function: `crearVenta()` in `src/features/ventas/hooks/use-ventas.ts` (1660 lines).
- Single `db.writeTransaction()` (starts line 301) that: resolves the egress `deposito_id` from the active caja's session (with a documented `is_active` hard-block guard, NOT a silent fallback, per "decision de producto #2, obs #2228"), generates `nro_factura` (COUNT-per-empresa), inserts `ventas` header, `ventas_det` lines, `movimientos_inventario` (kardex salida, product or recipe explosion for services), `pagos` rows per payment method/currency, `movimientos_metodo_cobro`, updates `clientes.saldo_actual` via `movimientos_cuenta`, and (best-effort, non-blocking) generates accounting entries.
- Deposit/stock validation happens through `inventario_stock` scoped by the caja's own deposito (see area 3).
- This is the correct template to model a credit note's atomic write against — same `db.writeTransaction()` idiom, same "financial writes never throw silently, accounting failures are swallowed" convention.

### 2. Sales invoice DOCUMENT (the printable/PDF template for the NC document)

- `src/features/ventas/utils/factura-export.ts` (805 lines) is the canonical, fully reusable document-building module. It is **not tied to any UI component** — it's a pure data/render layer consumed by `venta-exitosa-modal.tsx`.
- `buildReciboData(input)` — pure function producing a `ReciboData` object: emisor (empresa fiscal header), cliente, `lineas` (articles), `totales` (montoExento, baseImponible, `alicuotas[]` IVA-by-percentage, IGTF, totalFactura, totalGeneral), `pagos`, `cierre` (VUELTO/SAF/PROPINA/DIFERENCIAL_SOBRANTE/CREDITO), and `monedaPresentacion: 'USD'|'BS'`.
- `construirFilasTotales()` — single source of truth for the fiscal row order: Exento → Base Imponible → IVA % (per alícuota) → TOTAL FACTURA (subtotal sin IGTF) → IGTF → TOTAL + IGTF. Shared by all 3 render targets (PDF, PNG, plain text) so they can never diverge.
- Render targets: `buildReciboPdfBlob()` (jsPDF + jspdf-autotable, letter format), `buildReciboImagenBlob()` (Canvas 2D → PNG, 58mm-thermal-width-derived), `buildReciboTextoPlano()` (monospace text, shared by Web Share API fallback).
- "Moneda select" is **not a user-facing UI control on the document** — it's the `monedaPresentacion` config field (business setting, USD or BS primary), consumed by `formatMontoPrimario`/`formatMontoBimonetario` in `@/lib/currency`.
- Decimal library wiring: `decimal.js` imported directly in this file; all totals accumulate as `Decimal`, converted to `number` only at the `ReciboData` boundary via `.toNumber()`.
- A near-identical document builder for a credit note can be built by composing `construirFilasTotales`/`formatMontoPrimario` against the NC's own line/tax breakdown — this is the single most reusable asset for area 2 of the request.

### 3. Kardex / inventario movement + deposito-inactivo handling

- `movimientos_inventario` rows are inserted directly at each mutation site (ventas, compras, ajustes, NC) with `stock_anterior`/`stock_nuevo` snapshots; `origen` discriminates the source doc (`'VTA'`, `'NCR'`, `'TRA'`, etc.).
- **`inventario_stock` is the authoritative per-deposito counter**, maintained via `upsertStockDeposito(tx, params)` in `src/features/inventario/lib/stock-deposito.ts` — invoked from every mutating write path in the same `writeTransaction` as the kardex insert (this was itself a completed SDD change, `inventario-multideposito`, per Engram `#2017`/`#2023`).
- **The "deposito desactivado" case is ALREADY HANDLED** — the user's belief that a note exists is correct. `src/features/inventario/lib/deposito-inactivo.ts` exports `resolveDepositoReingresoNcr(origenDepositoId, origenIsActive, principalDepositoId)`: if the sale's origin deposito is still active, stock returns there (unchanged pre-existing behavior); if it was deactivated since the sale, it falls back to the company's CURRENT `es_principal` deposito automatically — **the cashier never chooses** (documented as "flujo POS-express, reversar factura del dia" / "decision de producto #3, obs #2228"). If no active principal exists either, `crearNotaCredito()` throws rather than writing a `movimientos_inventario` row with a null `deposito_id` (NOT NULL constraint since `0006_ventas.sql`). This function is ALREADY wired into `use-notas-credito.ts` (lines 202-232).
- Note: this function is explicitly scoped to the "NCR POS-express" (auto-reversal, no user choice) flow. A future "NCR administrativo" flow (explicit deposito choice) is called out in the code comment as "todavia no existe" — i.e., an explicit-destination variant is NOT built and was anticipated as future scope.

### 4. CxC — `movimientos_cuenta`, `vencimientos_cobrar`, abono/SAF flow

- `src/features/cxc/hooks/use-cxc.ts` (2172 lines) is the canonical CxC module. Key exported atomic functions: `aplicarPagoFacturaEnTx` (in-tx primitive), `registrarPagoFactura`, `registrarAbonoGlobal` (global FIFO abono — distributes across a client's pending invoices oldest-first), `aplicarSaldoFavor`, `registrarSafExcedente`, `registrarReversoAbono`, `registrarDiferencialCxC`/`reversarDiferencialEnTx`.
- Pattern: every mutation inserts a `movimientos_cuenta` row (`tipo` discriminator: `'PAG'`, `'SAF'`, `'NCR'`, `'DIFE'`, etc., with `saldo_anterior`/`saldo_nuevo` snapshot) and then an explicit `UPDATE clientes SET saldo_actual = ?` in the SAME local tx (comment clarifies: Supabase's `actualizar_saldo_cliente` trigger handles it server-side; the local UPDATE is for immediate SQLite reflection and arrives as a no-op once synced).
- **`clientes.saldo_actual` is bidirectional**: positive = client owes company; **negative = company owes client (saldo a favor)**. `registrarSafExcedente()` (line 1872) is the exact existing pattern for "generate credit for the client": `saldoNuevo = saldoActual.minus(excedenteD)` — this is directly reusable for the NC "leave saldo a favor" refund option.
- The existing `crearNotaCredito()` only ever *reduces debt toward zero* (`Decimal.max(0, saldoActual.minus(saldoPend))`) — it never goes negative, so it currently cannot represent "the client already paid, void the invoice, and give them credit" — that code path does not exist yet.

### 5. CxP — payable module, and whether it can represent a debt to a CLIENT

- `src/features/compras/hooks/use-cxp.ts`: `registrarPagoCxP`, `reversarAbonoCxP`, `registrarDiferencialCxP`.
- Schema tables `movimientos_cuenta_proveedor` and `vencimientos_pagar` (`src/core/db/powersync/schema.ts` lines 1242-1281) are both hard-modeled around `proveedor_id` (+ `factura_compra_id` on `vencimientos_pagar`) — **there is no `cliente_id` column anywhere in the CxP schema**.
- **Confirmed gap**: the current CxP model CANNOT represent "the company owes a refund TO a client." This is not a proveedor-side concept and cannot be shoehorned into it. The user's "create a cuenta por pagar" refund option needs either (a) reuse of the CxC `saldo_actual` negative-balance pattern (area 4) rather than literal CxP tables, or (b) a net-new "cuentas por pagar a clientes" concept if the business genuinely wants it to appear in a payables-style aging report distinct from client-credit. This decision should be surfaced to the user before design.

### 6. Tesorería — bank/caja-fuerte movements and pending-validation concept

- **NOT net-new**: `movimientos_bancarios` and `mov_caja_fuerte` (`schema.ts` lines 899-968) both already have `validado: integer`, `validado_por: text`, `validado_at: text`, `reversado: integer`, `reverso_de: text`.
- Full conciliación UI already exists: `src/features/bancos/components/conciliacion-bancaria.tsx` and `src/features/tesoreria/components/conciliacion-tesoreria.tsx`/`movimientos-table.tsx` render Pendiente/Conciliado/Reversado badges (`EstadoBadge`) and let a user validate a pending movement (`use-conciliacion-tesoreria.ts`: `validarMovimientoBancario`, `validarMovimientoCajaFuerte` — both guard against double-validation).
- The pattern is already used for cross-module pending flows: `use-traspasos.ts` inserts INGRESO rows with `validado=0` at the destination when a traspaso needs confirmation, then a later step flips `validado=1`.
- A NC bank/caja-fuerte refund egress can follow the exact same insert-with-`validado=0`-then-conciliar pattern — this is a major, directly reusable asset, contradicting the orchestrator's working assumption that this is net-new.

### 7. Sesión de caja, cuadre de caja, and PIN/permission gating

- `useSesionActiva()` (`src/features/caja/hooks/use-sesiones-caja.ts` line 173) resolves the current user's open `sesiones_caja` row (status='ABIERTA', scoped to `usuario_apertura_id`).
- Cuadre de caja (`src/features/reportes/hooks/use-cuadre.ts`) **already aggregates NC totals separately from sale totals**: `useTotalesFiscales`-style query sums `notas_credito` by `empresa_id` + same-day `fecha` (not by `sesion_caja_id` — NC rows have no session FK, so cross-session-boundary edge cases around midnight/multi-session days are a minor open question) and exposes `totalNcrUsd`/`totalNcrBs` alongside `totalFacturadoUsd`. `ventasAudit` queries include `v.status` and multiple UI surfaces (`cuadre-imprimir.tsx`, `cuadre-detalle-facturas.tsx`, `audit-modal.tsx`) already render a strikethrough/"ANULADA" badge for voided invoices — but **none of them cross-link to the specific NC number that voided it** ("reversada según NC #X" is not currently rendered anywhere, only a generic ANULADA tag).
- **`SupervisorPinDialog`** (`src/components/ui/supervisor-pin-dialog.tsx`) is a fully built, reusable component: takes a `requiredPermission` slug, verifies the entered PIN against `usuarios.pin_supervisor_hash` (SQLite-first, Supabase fallback for sync-lag), auto-authorizes level-1 (Propietario) regardless of permission, otherwise checks the PIN-holder's role has the named permission via `rol_permisos`. Already used in `pos-terminal.tsx` (closing a session without direct permission) and `cobro-modal.tsx` (authorizing a business-absorbed cash discrepancy). This is the exact mechanism the user described for POS-entry-point NC gating, and the "bypass when the CURRENT user already has sufficient permission" logic is the CALLER's responsibility (check `usePermissions()` before opening the dialog) — not built into the dialog itself, and not currently wired anywhere for NC.
- The existing NC sidebar route (`/_app/ventas/notas-credito`) is gated at the ROUTE level by `RequirePermission permission={PERMISSIONS.SALES_VOID}` (`'ventas.anular'`) — a coarse, page-load-time gate, not a per-action PIN prompt. There is currently **no PIN step inside `crear-ncr-modal.tsx`** at all.
- There is currently **no POS entry point** for credit notes anywhere in `pos-terminal.tsx` or `cobro-modal.tsx` — entry point (A) from the user's spec does not exist.

### 8. Bimonetary / decimal infrastructure

- `src/lib/currency.ts`: `usdToBs()`/`bsToUsd()` intentionally return `Decimal` (documented under `// CALCULATIONS — return Decimal`), NOT `number`. Separate, clearly-separated helper groups exist: `formatUsd()`/`formatBs()`/`formatTasa()` (display, return formatted strings) and `toStorageString()` (fixed 8-decimal string for DB writes). **The orchestrator's flagged "Decimal-leak bug" does not reproduce** — this is a deliberate, consistently-applied architecture (confirmed by its use across `use-notas-credito.ts`, `use-cxc.ts`, `factura-export.ts`, all of which correctly call `.toStorageString()`/`.toNumber()`/`format*()` at the appropriate boundary). No further action needed here; the orchestrator's gotcha note should be considered resolved/inaccurate for the current codebase state.
- Historical BCV rate snapshot: `ventas.tasa` is captured at sale time (immutable per business rule #1) and is exactly what the existing `crearNotaCredito()` already copies verbatim into `notas_credito.tasa_historica` (`venta.tasa`) — the Fiscal Golden Rule (inherit the ORIGINAL rate, never recalculate) is already correctly implemented for the one flow (full anulación) that exists today.
- `initCurrencyConfig()` sets calc/view precision + rounding mode once at app startup from empresa config; `Decimal.set({ precision, rounding })` is global module state.

### 9. Existing NC scaffolding — the biggest finding

The sidebar screen the user mentioned is real and functional, but is a **narrow "anulación total de factura" feature, not a general credit-note module**:

- Route: `src/routes/_app/ventas/notas-credito.tsx` — gated by `PERMISSIONS.SALES_VOID`.
- Page: `src/features/ventas/components/notas-credito-page.tsx` — search-a-factura-by-nro + list of existing NCs.
- Modal: `src/features/ventas/components/crear-ncr-modal.tsx` — read-only confirmation view (factura info, líneas, pagos, saldo pendiente warning) + single "motivo" text field + "Confirmar Anulación" button. **No line-item selection UI (no partial-quantity input), no refund-method selection UI, no PIN step.**
- Hook: `src/features/ventas/hooks/use-notas-credito.ts` — `crearNotaCredito()` is a single `db.writeTransaction()` that: reads the venta, resolves reingreso deposito (area 3), generates `nro_ncr` (COUNT-per-empresa), **INSERTs `notas_credito` with `tipo: 'TOTAL'` HARDCODED**, reverses ALL `ventas_det` lines' stock (product direct or recipe-explosion for services), restores lote quantities, floors `clientes.saldo_actual` toward zero for any pending debt, best-effort reverses any diferencial cambiario, marks `ventas.status = 'ANULADA'`, and best-effort generates accounting entries (`generarAsientosNCR`).
- **No refund handling whatsoever** — if the invoice was already paid in cash/bank, the money is not returned via any tesorería, CxC, or CxP mechanism; the function only ever reduces `saldo_pend_usd`/`saldo_actual` (i.e., it only handles the "invoice was unpaid/partially paid" case correctly; a fully-paid invoice being voided currently has NO money-return path in code at all).
- **No `notas_credito_det` rows are ever inserted** — despite the table existing with a full fiscal-breakdown shape (`cantidad`, `precio_unitario_usd`, `tipo_impuesto`, `impuesto_pct`, `subtotal_usd`, `afecta_inventario`, `descripcion`, `lote_id`).
- **The `notas_credito` header INSERT also never populates `moneda_id`, `total_exento_usd`, `total_base_usd`, `total_iva_usd`** — despite these columns existing in both the Postgres table (`migrations/0006_ventas.sql` lines 304-327) and PowerSync `schema.ts` (lines 753-774) with fiscal-breakdown semantics matching exactly the `ReciboTotales` shape already built for the sales document (area 2).
- **CONFIRMED LIVE BUG**: the INSERT statement in `crearNotaCredito()` (`use-notas-credito.ts` line 243-263) supplies a `created_by` value, but `notas_credito` has **no `created_by` column** in either `migrations/0006_ventas.sql` or `schema.ts` (compare: 39 other tables in the same schema file DO declare `created_by`; `notas_credito` is not one of them). PowerSync generates its local SQLite schema strictly from the declared `Table()` columns, so this INSERT will throw `no such column: created_by` (or be silently dropped depending on the local SQLite binding, but neither is safe) the first time it runs against a real (non-mocked) PowerSync database — the current unit test (`use-notas-credito.test.ts`, 7 passing tests) does not catch this because `db.writeTransaction`/`tx.execute` are mocked.
- Postgres already anticipates partial NCs at the schema level: `CHECK (tipo IN ('TOTAL','PARCIAL'))` and a `trg_validate_nota_credito_insert` trigger that sums existing NCs for a venta and rejects any INSERT that would push the cumulative NC total past `ventas.total_usd` — i.e., the database is ALREADY guarding against over-crediting on partial NCs, even though no code path produces `tipo='PARCIAL'` yet.

## Reusable Assets (what a credit-note build can lean on)

| Asset | Location | Reuse for |
|---|---|---|
| `crearVenta()` atomic-write pattern | `use-ventas.ts` | Template for a properly-scoped, multi-step `writeTransaction` |
| `buildReciboData`/`construirFilasTotales`/`buildReciboPdfBlob` | `factura-export.ts` | NC printable document — same fiscal-row-order engine |
| `upsertStockDeposito`, `resolveDepositoReingresoNcr` | `stock-deposito.ts`, `deposito-inactivo.ts` | Kardex ingreso + already-solved deposito-inactivo fallback |
| `registrarAbonoGlobal`, `aplicarPagoFacturaEnTx` FIFO pattern | `use-cxc.ts` | "Apply NC against receivable like an abono" |
| `registrarSafExcedente` (negative `saldo_actual`) | `use-cxc.ts` | "Leave saldo a favor" refund option |
| `validado`/`validado_por`/`reversado` + conciliación UI | `schema.ts`, `use-conciliacion-tesoreria.ts`, `conciliacion-tesoreria.tsx` | "Tesorería egress pending validation" — NOT net-new |
| `SupervisorPinDialog` + `pin_supervisor_hash` | `supervisor-pin-dialog.tsx` | POS-entry-point PIN gating |
| `notas_credito`/`notas_credito_det` schema + Postgres partial-NC guard trigger | `migrations/0006_ventas.sql`, `schema.ts` | Already modeled for partial NCs — no migration needed for the base shape |
| Existing full-anulación flow (`crearNotaCredito`, route, page, modal) | `use-notas-credito.ts` + 3 components | Starting skeleton to extend, NOT throwaway — but needs the `created_by` bug fixed regardless of scope |

## Gaps / Net-New Infrastructure

1. **Partial credit notes** — no line-item selection UI, no `notas_credito_det` writes, no partial-quantity kardex/stock logic, no partial fiscal-breakdown (`total_exento_usd`/`total_base_usd`/`total_iva_usd`) computation. `tipo: 'TOTAL'` is hardcoded.
2. **All refund handling** — none of the 4 refund options (return money, leave saldo a favor, create payable, apply to receivable) are implemented for a PAID invoice. Only the "reduce pending debt" case is handled.
3. **Debt-to-client concept** — current CxP tables are proveedor-only; either reuse negative `saldo_actual` or design a net-new concept (needs a user decision, see Open Questions).
4. **POS entry point (A)** — does not exist at all; no NC affordance inside `pos-terminal.tsx`/`cobro-modal.tsx`, no "only invoices of the active session" filter, no PIN step.
5. **Multi-amount/multi-currency refund UI + write logic** — no code exists for splitting a refund across cash/bank/caja-fuerte in mixed USD/Bs amounts.
6. **NC printable document** — the sales-invoice document builder is reusable as a pattern but a dedicated NC version does not exist (current UI is a confirmation modal, not a printable/downloadable document).
7. **"Reversada según NC #" cross-link in reports** — the ANULADA badge exists but doesn't reference which NC caused it.
8. **`crearNotaCredito()`'s `created_by` column bug** — must be fixed regardless of scope decisions (blocks even the existing full-anulación flow from working against a real database).

## Risk Hotspots (ranked)

1. **Fiscal correctness of the partial-NC fiscal breakdown** — computing `total_exento_usd`/`total_base_usd`/`total_iva_usd` per NC-line and per-alícuota, while strictly inheriting the historical `tasa`/IVA of the ORIGINAL invoice line (never recalculating), is the highest-stakes area since it's SENIAT-auditable. The `buildReciboData` alícuota-bucketing algorithm in `factura-export.ts` is the right pattern to mirror, but it was built for a NEW sale computing fresh IVA — for a NC it must instead trace back to the SPECIFIC original `ventas_det` line's `tipo_impuesto`/`impuesto_pct`, which requires careful line-matching logic (partial-quantity of a line that itself might have mixed exento/gravable siblings).
2. **Atomicity across 5+ modules in one refund** — a single NC-with-refund can touch `notas_credito(_det)`, `movimientos_inventario`+`inventario_stock`, `movimientos_cuenta`(+`vencimientos_cobrar`), `movimientos_bancarios`/`mov_caja_fuerte` (pending), and accounting entries, ALL inside one `db.writeTransaction()`. `crearVenta()` proves this pattern works, but NC's branching refund-method logic (4 mutually-exclusive+combinable options, multi-currency) is more branchy than any existing single-tx function in the codebase.
3. **Deactivated-deposito for the ADMIN NC entry point (B)** — `resolveDepositoReingresoNcr` is explicitly scoped to the "POS-express, no user choice" flow. Entry point B (sidebar, all invoices, searchable) is exactly the "NCR administrativo" case the code comment flags as NOT YET BUILT — needs its own deposito-choice UX and reuses only part of the existing logic.
4. **`created_by` schema bug is a landmine for the whole NC surface** — any change here has to fix a currently-broken write path first, and that fix needs to be verified against a REAL PowerSync-synced database, not just unit tests (which mock `writeTransaction` and would pass either way).
5. **Cuadre-de-caja NC attribution by `fecha` not `sesion_caja_id`** — the existing `useTotalesFiscales`-style NC aggregation sums by same-day `fecha`, not by session; NCs created from the sidebar (entry point B, no session concept) vs POS (entry point A, session-scoped) will need a clear, tested rule for which cuadre/session a refund's tesorería-pending-movement and NC total attach to, especially across midnight or multi-session days.
6. **Multi-currency refund math** — splitting one refund across cash (USD/Bs) + bank (possibly a different currency than the bank's native currency, see the `_esBancoBS` conversion branch already present in `aplicarPagoFacturaEnTx`) needs the same care as that existing function, replicated across potentially several destination accounts in one NC.

## Open Questions for the User

1. **Debt-to-client representation**: should "create a cuenta por pagar" for an NC refund reuse the existing CxC `saldo_actual`-negative pattern (same table, same reports, zero new schema) or does the business need a genuinely separate "cuentas por pagar a clientes" ledger/report distinct from saldo-a-favor (e.g. for aging/collections purposes)? This materially changes scope.
2. **Cuadre/session attribution for entry-point-B NCs**: when a credit note is created from the ADMIN sidebar screen (not tied to any active session) against an invoice from a PAST session/day, which cuadre de caja does its tesorería-pending-movement and NC total attach to — the day it's ISSUED, or the day/session of the ORIGINAL invoice?
3. **PIN bypass threshold**: what specific permission slug should gate the "supervisor PIN not required" bypass for POS-entry-point NCs — reuse `PERMISSIONS.SALES_VOID` (`'ventas.anular'`, already used to gate the whole sidebar route), or a distinct finer-grained permission?
4. **Scope of "administrativo" (entry point B) deposito handling**: should entry-point-B NCs get an explicit deposito-choice UI (as hinted by the existing code comment "el modulo NCR administrativo... todavia no existe"), or should they also auto-resolve like the POS-express flow, just without the session-scoping filter?
5. **Existing full-anulación flow disposition**: extend `crearNotaCredito()` in place to add a `tipo='PARCIAL'` branch and refund logic, or treat it as a reference implementation and build a new, more general function alongside it (keeping `crearNotaCredito` as the fast "anulación total, no refund needed" shortcut it already is)?

## Rough Complexity Read

This is a **large, multi-slice change**, not a single PR. Natural cross-module slices, roughly in dependency order:

1. **Bugfix + schema completion** (small, should ship first regardless of the rest): fix the `created_by` column bug; decide whether to populate `moneda_id`/`total_exento_usd`/`total_base_usd`/`total_iva_usd` on the existing TOTAL path even before partial NCs exist.
2. **Partial NC core** (fiscal breakdown + `notas_credito_det` + partial kardex/stock reversal) — highest fiscal-correctness risk, should be its own tightly-reviewed slice, mirroring how `inventario-multideposito` isolated its ventas slice.
3. **Refund handling** (4 options) — likely splits further into: (3a) apply-to-receivable / saldo-a-favor (cheapest, reuses `use-cxc.ts` patterns almost directly), (3b) tesorería cash/bank/caja-fuerte refund with pending-validation (reuses `validado=0` pattern), (3c) debt-to-client / payable (blocked on Open Question 1).
4. **POS entry point (A)** — UI + session-scoped invoice search + PIN gating wiring into `pos-terminal.tsx`.
5. **Admin entry point (B) upgrades** — extend `crear-ncr-modal.tsx` (or a new modal) for partial line selection + deposito choice + refund-method selection.
6. **NC printable document** — new module mirroring `factura-export.ts`.
7. **Reporting polish** — "reversada según NC #" cross-link in cuadre/audit views.

## Ready for Proposal

Yes, with the 5 open questions above resolved first — particularly Q1 (debt-to-client model) and Q3 (PIN bypass permission), since they affect schema/permission decisions that later slices depend on.
