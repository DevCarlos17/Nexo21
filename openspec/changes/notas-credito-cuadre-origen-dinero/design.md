# Design: Notas de Crédito — Origen de Dinero Configurable + Cuadre

Base: `develop` @ `11ac472`. Grounds every claim in `explore.md` citations + obs #2935.

**AMENDMENT (this revision)**: Slices 2 and 3 shipped with a single-account `origenDinero: {tipo,cuentaId}` model that FIFO'd the refund over the venta's ORIGINAL `pagos`. The owner corrected this as structurally wrong (obs #2948): a NC has **three independent axes** — reversar artículos (always), anular pagos/venta (contable, independent), y destino del dinero (elección del usuario: uno o varios orígenes, o crédito a favor, o combinación). This revision replaces `origenDinero` with a **multi-source array**, decoupled entirely from `pagos`. All decisions below marked "RESOLVED (pre-amendment)" are UNCHANGED; new/amended material is marked accordingly.

## Technical Approach

`origenDinero` is now an ARRAY of account assignments, still passed into the SAME single `db.writeTransaction` (`use-notas-credito.ts:370-1044`, no nested writes — PowerSync forbids nesting). `modalidad` keeps its role as the desembolso/no-desembolso GATE (`esModalidadNoDesembolso`); it no longer restricts WHICH account types the array may contain — that restriction (`EFECTIVO_REAL`⇒only-session, `REFUND_TESORERIA`⇒only-treasury) is **removed**, because a single NC can now mix session cash + treasury + bank in one refund (owner's canonical example: Bs500 session cash + Bs500 via bank transfer, ONE NC). The refund amount is **derived**, never a separate input: `montoADevolverUsd = Σ(assignments converted to USD)` — no duplicate source of truth to desync.

## Resolved Decisions (pre-amendment, unchanged)

### Decision 1 — Bank vs caja fuerte for treasury refunds
**Status**: RESOLVED. **Choice**: support both, mirroring `crearTraspaso`'s two-table branch (`use-traspasos.ts:159-217`). Precision: `Decimal.js` throughout, `.toFixed(4)` for `caja_fuerte`/`bancos_empresa` (`NUMERIC(18,4)`, their own convention). **Extended by this amendment**: the SAME real-balance pattern now also applies to `metodos_cobro` for `SESION_EFECTIVO` assignments (see Decision 5) — `metodos_cobro.saldo_actual` is updated via `.toFixed(4)` (matches `use-traspasos.ts:938`'s existing convention for that exact column), while `movimientos_metodo_cobro.monto`/`saldo_anterior`/`saldo_nuevo` use `toStorageString` (matches `use-ventas.ts:825`'s existing convention for that exact table).

### Decision 2 — `traspasos_tesoreria` audit row
**Status**: RESOLVED. **Choice**: NO `traspasos_tesoreria` row for any assignment. Reference the NC via the EGRESO row's own `doc_origen_id = ncrId` / `doc_origen_tipo = 'NOTA_CREDITO'` (existing free-text columns, `schema.ts:961-962`, `915-916`). Unchanged by this amendment — now applies uniformly per assignment, not once per NC.

### Decision 3 — `entry_point` values
**Status**: RESOLVED, unchanged. `entry_point TEXT NOT NULL DEFAULT 'TRADICIONAL' CHECK (entry_point IN ('POS','TRADICIONAL'))`, migration `0092` (below).

### Decision 4 — money-origin authorization, asymmetric by route (obs #2938)
**Status**: RESOLVED, unchanged in substance; **field mapping amended** by Decision 5 (the guard now targets a single `sesionDestino` value per NC, not a per-assignment `cuentaId`).

| Route (`entryPoint`) | Invoices visible | Allowed session for `SESION_EFECTIVO` assignments |
|---|---|---|
| `POS` | Only the active session's invoices | **Only** the cashier's OWN active session — `sesionCajaActivaId`, fixed, not chosen. |
| `TRADICIONAL` | Empresa-wide | ANY session where `status='ABIERTA'`, chosen ONCE per NC via the new `sesionDestinoId` param (Decision 5). |

**Guard** (in-tx, before any write): `SELECT status FROM sesiones_caja WHERE id=? AND empresa_id=?` on the resolved session id; throw if missing or `status='CERRADA'` — evaluated ONCE per NC (not per assignment), since all `SESION_EFECTIVO` assignments in one NC now target the same session (Decision 5 simplification).
**Cuadre invariant — still holds**: every `movimientos_metodo_cobro` row from this refund stores `sesion_caja_id = sesionDestino` (the chosen session, POS's own or TRADICIONAL's pick) — `buildCuadreWhere`/`buildMovsWhere` (`use-cuadre.ts:35-62`) filter strictly on this column, so the invariant traced in the original design holds unchanged.
**Intentional divergence (owner-accepted)**: `notas_credito.sesion_caja_id` (issuance) can still legitimately differ from `sesionDestino` (money) — only from `TRADICIONAL`. Traceability seed unchanged: `doc_origen_id → notas_credito.id` join surfaces `nro_ncr` in the affected session's cuadre.

## Decision 5 (NEW) — `origenDinero` becomes a multi-source array (obs #2948, #2949)

**Contract**:
```ts
origenDinero?: Array<{
  tipo: 'SESION_EFECTIVO' | 'TESORERIA_EFECTIVO' | 'BANCO'
  cuentaId: string   // the row whose fixed currency the `monto` is denominated in
  monto: string      // NATIVE currency of that row — never pre-converted
}>
```
Exactly 3 fields, matching the POS payment pattern (`use-ventas.ts:771-807`: native `monto` + fixed currency, no separate currency selector — **the account IS the currency**).

**Account resolution per `tipo`** (each is a real row with its OWN `saldo_actual` + fixed `moneda_id` — confirmed for all three: `caja_fuerte`, `bancos_empresa`, and `metodos_cobro` all carry `saldo_actual`+`moneda_id`, and are all read/updated this way elsewhere, e.g. `use-traspasos.ts:938`, `use-cxc.ts:1837`):

| `tipo` | `cuentaId` points to | Currency source |
|---|---|---|
| `TESORERIA_EFECTIVO` | `caja_fuerte.id` | `caja_fuerte` has separate Bs/USD rows (owner-confirmed, obs #2949) |
| `BANCO` | `bancos_empresa.id` | fixed at bank creation, immutable |
| `SESION_EFECTIVO` | `metodos_cobro.id` of a cash-type método (empresa's "Efectivo USD" / "Efectivo Bs", same rows auto-resolved today by `ingreso-retiro-modal.tsx:62`, `avance-modal.tsx:243-244`, `prestamo-modal.tsx:279-280`) | `metodos_cobro.moneda_id`, fixed |

**Amendment to Decision 4's field mapping**: `SESION_EFECTIVO.cuentaId` is now a **método** id, not a session id — a session's cash spans TWO currencies (two métodos), so it cannot itself be "the account" under the "account IS the currency" rule. The **session** that receives the write is a single value **per NC, not per assignment**: `sesionCajaActivaId` (POS, fixed) or a new top-level param `sesionDestinoId` (`TRADICIONAL`, required iff the array has ≥1 `SESION_EFECTIVO` assignment). This is a deliberate simplification — one NC's session-cash refund always lands in ONE till, matching how a cashier physically operates; nothing in obs #2948's canonical example needed more than one session.
**Alternative considered**: add a 4th field (`metodoCobroId`) to the assignment and keep `cuentaId`=session id. **Rejected**: contradicts the explicit 3-field, no-extra-selector contract, and would allow scattering one refund across N different sessions with no real use case.

### Validation rules (replaces the old Rules 1/2 — type-per-modalidad restriction is DROPPED)

**Pre-tx, pure (`validarOrigenDinero`, no DB)**:
1. `!esModalidadNoDesembolso(modalidad)` (desembolso) ⇒ `origenDinero` must be a non-empty array (≥1 assignment) — you cannot pick a desembolso modalidad and refund nothing.
2. `esModalidadNoDesembolso(modalidad)` ⇒ `origenDinero` must be empty/undefined (gate extension, unchanged spirit).
3. Every assignment: `monto > 0` (Decimal), else throw.
4. No duplicate `(tipo, cuentaId)` pairs in the array (defensive — prevents double-counting one account).
5. `entryPoint==='POS'` ⇒ the array may only contain `SESION_EFECTIVO`/`TESORERIA_EFECTIVO`/`BANCO` freely, BUT if it contains `SESION_EFECTIVO`, the resolved session is always `sesionCajaActivaId` (no per-assignment choice — see Decision 5).
6. `entryPoint==='TRADICIONAL'` and array contains `SESION_EFECTIVO` ⇒ `sesionDestinoId` is required.

**In-tx, DB-dependent, TWO-PASS (validate fully before any write — preserves atomicity, business rule #9)**:

*Pass 1 — resolve + accumulate, no writes yet:*
```
sesionDestino = entryPoint === 'POS' ? sesionCajaActivaId : params.sesionDestinoId
if origenDinero has SESION_EFECTIVO items:
  SELECT status FROM sesiones_caja WHERE id=sesionDestino AND empresa_id=? → throw if missing/CERRADA

montoADevolverUsd = Decimal(0)
resolved = []
for each a of origenDinero:
  tabla = { SESION_EFECTIVO: 'metodos_cobro', TESORERIA_EFECTIVO: 'caja_fuerte', BANCO: 'bancos_empresa' }[a.tipo]
  SELECT saldo_actual, m.codigo_iso AS moneda_codigo FROM {tabla} t JOIN monedas m ON m.id=t.moneda_id
    WHERE t.id=a.cuentaId AND t.empresa_id=?  → throw "cuenta no encontrada / no pertenece a la empresa" if missing
  montoUsd = moneda_codigo === 'VES' ? bsToUsd(a.monto, venta.tasa) : Decimal(a.monto)
  montoADevolverUsd += montoUsd
  resolved.push({ ...a, saldo_actual, moneda_codigo, montoUsd })

EPSILON = Decimal('0.005')   // obs #2945/#2948/#2949 convention
if montoADevolverUsd.gt(remanenteALiquidar.plus(EPSILON)) → throw "el monto a devolver excede el remanente disponible"
```

*Pass 2 — write, only after Pass 1 fully validates:*
```
for each r of resolved:
  saldoAnt = Decimal(r.saldo_actual); saldoNuevo = saldoAnt.minus(r.monto)
  fk_col   = { SESION_EFECTIVO: 'metodo_cobro_id', TESORERIA_EFECTIVO: 'caja_fuerte_id', BANCO: 'banco_empresa_id' }[r.tipo]
  mov_tbl  = { SESION_EFECTIVO: 'movimientos_metodo_cobro', TESORERIA_EFECTIVO: 'mov_caja_fuerte', BANCO: 'movimientos_bancarios' }[r.tipo]
  cta_tbl  = { SESION_EFECTIVO: 'metodos_cobro', TESORERIA_EFECTIVO: 'caja_fuerte', BANCO: 'bancos_empresa' }[r.tipo]

  INSERT INTO {mov_tbl} (..., {fk_col}=r.cuentaId, tipo='EGRESO', origen = r.tipo==='SESION_EFECTIVO' ? 'NCR' : 'REFUND_NCR',
    monto=r.monto, saldo_anterior=saldoAnt, saldo_nuevo=saldoNuevo,
    doc_origen_id=ncrId, doc_origen_tipo='NOTA_CREDITO',
    sesion_caja_id = r.tipo==='SESION_EFECTIVO' ? sesionDestino : NULL, ...)
  UPDATE {cta_tbl} SET saldo_actual = saldoNuevo WHERE id=r.cuentaId AND empresa_id=?

leftoverUsd = remanenteALiquidar.minus(montoADevolverUsd)
// see "Leftover routing" below
```
`origen='NCR'` preserved for `SESION_EFECTIVO` (matches pre-amendment convention for session-cash egresos); `origen='REFUND_NCR'` preserved for treasury/bank (Decision 1, unchanged). `empresa_id` stamped on every INSERT; every read/update filters `WHERE id=? AND empresa_id=?` — never replicate the cross-tenant read gap flagged at `use-traspasos.ts:45/161/190`.

### Leftover routing — combination is the DEFAULT, not disallowed (resolves obs #2948's "combinación posible")

`montoADevolverUsd` (derived, Σ of the array in USD) can be **less than** `remanenteALiquidar` — the array only has to cover what the customer actually gets in cash; the rest is never lost:

```
leftoverUsd = remanenteALiquidar.minus(montoADevolverUsd)
if modalidad === 'AJUSTE_CXC':
    // unchanged existing branch: reduces the client's BROADER outstanding debt (capped at 0), never creates credit
    write AJUSTE_CXC movimientos_cuenta using remanenteALiquidar   // origenDinero forced empty by Rule 2, so leftoverUsd === remanenteALiquidar here
else if leftoverUsd.gt(EPSILON):
    // SAFC branch (today's SALDO_FAVOR/COMPENSACION_VENTA write, unchanged shape) now fires for ANY modalidad
    // whenever the array didn't cover the full remanente — this IS the "combination" case (obs #2948)
    write SAFC movimientos_cuenta using leftoverUsd, doc_origen_id=ncrId, doc_origen_tipo='NOTA_CREDITO'
```
**Why SAFC and not disallowed**: obs #2948 explicitly lists "combinación posible" as a valid outcome and pairs "crédito a favor" with the SAFC/AJUSTE_CXC pair already in the code — SAFC is the trazable, re-consumable form (the canonical "cambio de artículo" flow re-invoices against it), so it is the correct default for an UNPLANNED leftover from a partial cash refund. `AJUSTE_CXC` stays a deliberate, explicit, no-desembolso choice (its own semantics: reduce unrelated debt, never create credit) and is the ONLY modalidad where the array is forced empty (100% of the remanente takes that path).
**Consequence**: `EFECTIVO_REAL` and `REFUND_TESORERIA` are now functionally IDENTICAL at write-time (both just mean "desembolso, read the array"); which one a caller passes only affects the stored `liquidacion_modalidad` audit value. No migration needed (`0092`'s CHECK already lists both) — this is a behavioral simplification, not a schema change.

## Remanente reintegrable (obs #2945, unchanged formula)

`remanenteALiquidar = Decimal.max(0, totalUsdNc − montoAplicadoAPendiente)`, hoisted once (Step A, `:984`), shared by the refund array (via `montoADevolverUsd ≤ remanenteALiquidar`) and the leftover routing above. The FIFO-over-`pagos` allocation (`capearEgresosPorRemanente`) that previously enforced this cap is **removed entirely** — the cap is now enforced directly on `montoADevolverUsd` (Pass 1), with no dependency on how the customer originally paid.

## Cuadre Integration (5 effects, unchanged from original design + 1 note)

| # | Change | Hook | Detail |
|---|--------|------|--------|
| 1 | NC total scoped by session | `useTotalesFiscales` | unchanged |
| 2 | Refund-by-método (NCR-aware) | `useReintegrosPorMetodo(filters)` | unchanged shape — now may return >1 row for the SAME NC when the array mixes types/multiple treasury+bank targets; already GROUPs by método, no code change needed |
| 3 | "NC de la sesión" table | `useNotasCreditoDeSesion(filters)` | unchanged — keyed on issuance session, not affected by the array |
| 4 | New component(s) | `cuadre-notas-credito.tsx` | unchanged |
| 5 | `usePagosPorMetodo` untouched | — | unchanged — never touches the refund |

**New note (multi-source impact)**: a single NC can now generate EGRESO rows in `mov_caja_fuerte`/`movimientos_bancarios`/`movimientos_metodo_cobro` simultaneously (owner's canonical example: one NC → session cash egreso + bank egreso). Each row is independently scoped (`sesion_caja_id` only on the session row) so each account's own cuadre picks up exactly its slice via existing filters — no new hook needed, the `doc_origen_id→notas_credito.id` join already surfaces the shared `nro_ncr` across all of them.

## Migration `0092_notas_credito_entry_point_refund.sql`

**No changes from the original design** — this amendment is a parameter/logic change (`origenDinero` shape, write iteration), not a schema change. The migration (entry_point column + `REFUND_NCR` CHECK additions on `mov_caja_fuerte`/`movimientos_bancarios`) stays exactly as originally designed and already applied. `origen='NCR'` on `movimientos_metodo_cobro` for session-cash egresos was already a valid value pre-existing (used by the old Regla de Oro) — no CHECK change needed there either.

## Rework Required (Slices 2 & 3 already committed on the OLD model; Slice 4 not yet built)

**Slice 2 (`origenDinero` validation)**:
- `OrigenDinero` type: single object → `OrigenDinero[]`.
- Remove Rules 1/2 (type-per-modalidad restriction) from `validarOrigenDinero`; add: non-empty-iff-desembolso, per-assignment `monto>0`, no-duplicate-account guard, `sesionDestinoId` requirement for `TRADICIONAL` + `SESION_EFECTIVO`.
- `CrearNotaCreditoParams`: add `sesionDestinoId?: string`.
- Rewrite the ~15 describe blocks asserting the old single-object shape and old Rules 1/2.

**Slice 3 (write branch)**:
- DELETE `capearEgresosPorRemanente`, `PagoParaReversaEfectivo`, `EgresoReversaCapeado`, and the now-dead `SELECT ... FROM pagos` used only to feed it (`:1049-1053`).
- Replace the `if(SESION_EFECTIVO)/else if(TESORERIA|BANCO)` branch with the unified two-pass loop over the array (Decision 5).
- `metodos_cobro` joins the read/update pattern already used for `caja_fuerte`/`bancos_empresa` (real `saldo_actual` tracking, replacing the old hardcoded `saldo_anterior=0, saldo_nuevo=0` placeholder for session-cash egresos).
- Generalize Step B: `if (modalidad==='AJUSTE_CXC') {...unchanged...} else if (leftoverUsd.gt(EPSILON)) {...SAFC using leftoverUsd...}` (was gated on `remanenteALiquidar.gt('0.01')` and 3 modalidad values only).
- New tests: sum-invariant rejection (over-limit, epsilon boundary), multi-assignment mixed-type (session+bank in one NC, owner's canonical example), partial-cash-plus-SAFC-leftover, `metodos_cobro.saldo_actual` update assertions.
- `pagos.is_reversed=1` UPDATE (`:1190-1194`) stays byte-identical — confirmed independent of all the above (axis 2 vs axis 3, obs #2948).

**Slice 4 (UI, not yet built)**:
- Both `nota-credito-pos-modal.tsx` and `crear-ncr-modal.tsx` need a multi-origin picker: add/remove assignment rows (tipo + cuenta selector + native-currency amount input), live USD-converted running total against `remanenteALiquidar`, and a visible "se dejará $X como crédito a favor" hint when the running total is under the ceiling.
- `TRADICIONAL`'s picker must resolve `sesionDestinoId` once (a single session selector shown only when ≥1 `SESION_EFECTIVO` row exists), not per-row.
- Both pickers resolve `SESION_EFECTIVO` account options to the empresa's cash-type `metodos_cobro` rows (reuse `ingreso-retiro-modal.tsx`'s existing "Efectivo USD"/"Efectivo Bs" lookup), not to session ids.

## Testing Strategy (RED-first per slice)

| Slice | Must FLIP (existing) | New tests |
|---|---|---|
| 2 | ~15 describes on old single-object shape / old Rules 1-2 | array validation (T1-T6 above) |
| 3 | Decimal/`doc_origen_id` tests (still valid, adapt to loop) + all `capearEgresosPorRemanente` tests (function removed) | two-pass sum invariant, multi-assignment mixed-type, leftover→SAFC combination, `metodos_cobro` saldo tracking |
| 4 | `crear-ncr-modal.test.tsx:200-207` disabled-button test | multi-row picker, running-total-vs-remanente, session-selector-once |
| 5 | none | unchanged from original design |

## Slice/PR Boundaries (feature-branch-chain, budget 400 lines each)

| # | Slice | Scope | Risk |
|---|---|---|---|
| 1 | Schema | Migration 0092 + `schema.ts` column | Low — done, unaffected |
| 2 | Decouple + array validation | `origenDinero[]`, `sesionDestinoId`, drop Rules 1/2, rewrite ~15 describes | High — full rework of a shipped slice |
| 3 | Multi-source write | Two-pass loop, delete FIFO code, generalize Step B | Highest — real money, full rework of a shipped slice |
| 4 | Multi-origin picker + guard | UI in both modals, not yet built | Medium — new UX, no precedent |
| 5 | Cuadre | unchanged from original design | High — zero existing test harness for `use-cuadre.ts` |
| 6 | Badge | unchanged | Low |

## Open Questions
- [x] Owner sign-off on Decision 4 asymmetric-by-route — RESOLVED (obs #2938).
- [x] Owner sign-off on the three-axes model + array — RESOLVED (obs #2948, #2949).
- [x] **Decision 5's `SESION_EFECTIVO`→`metodos_cobro` reinterpretation** — RESOLVED (owner confirmed): `cuentaId` for `SESION_EFECTIVO` is a `metodos_cobro.id` (the specific cash método, Bs or USD), NOT a session id. Session that receives the write is one value per NC (`sesionCajaActivaId` for POS, `sesionDestinoId` for TRADICIONAL). Owner: "el efectivo disponible apunta al efectivo específico". Slice 2/3 rework proceeds on this mapping.
- [ ] `'REFUND_NCR'` vs `'NCR'` naming for treasury/bank origin — open to bikeshedding, not a design blocker.
