-- =============================================================================
-- Migration: 0092_notas_credito_entry_point_refund.sql
-- Created:   2026-09-05
-- Depends:   0091_notas_credito_schema.sql
--
-- CONTEXT (openspec/changes/notas-credito-cuadre-origen-dinero/design.md,
--   Migration 0092 section; Decision 3 / Decision 1):
--   This is Slice 1 (schema-only, additive, low risk) of the
--   `notas-credito-cuadre-origen-dinero` change. It lays the schema
--   foundation for two later slices without implementing their logic yet:
--
--   1. `notas_credito.entry_point` (Decision 3): records WHERE the NC was
--      issued from — 'POS' (cashier, own active session) or 'TRADICIONAL'
--      (admin module, empresa-wide). Badge "vía administración" =
--      entry_point='TRADICIONAL'. Backfill is deterministic, not a guess:
--      `sesionCajaIdParaNc` (use-notas-credito.ts) is set ONLY when
--      entryPoint==='POS', and the POS modal always requires a non-null
--      `sesion` prop before calling `crearNotaCredito` — so every
--      historical POS-issued NC has `sesion_caja_id` set, and every
--      Tradicional-issued NC has it NULL.
--
--   2. `'REFUND_NCR'` appended to the `origen` CHECK of both
--      `mov_caja_fuerte` and `movimientos_bancarios` (Decision 1): Slice 3
--      of this change will write one consolidated EGRESO row per NC when
--      `liquidacion_modalidad='REFUND_TESORERIA'` refunds a customer via
--      caja fuerte or bank account. This migration ONLY widens the CHECK
--      constraints — no write path exists yet (Slice 1 is additive-only).
--
-- EXACT CURRENT VALUE LISTS (verified against the migrations that define
-- them, not guessed):
--   - mov_caja_fuerte_origen_check: defined in 0035_conciliacion_tesoreria.sql
--     line 39, NEVER touched again. Current 5 values: 'DEPOSITO_CIERRE',
--     'GASTO', 'TRASPASO', 'MANUAL', 'REVERSO'.
--   - movimientos_bancarios_origen_check: defined in
--     0035_conciliacion_tesoreria.sql line 154, last touched in
--     0077_cierre_consolidacion_tesoreria.sql lines 24-26. Current 8 values:
--     'DEPOSITO_CAJA', 'TRANSFERENCIA_CLIENTE', 'PAGO_PROVEEDOR', 'GASTO',
--     'MANUAL', 'TRASPASO', 'REVERSO', 'CIERRE_CONSOLIDACION'.
--
-- IDEMPOTENT: safe to re-run. Uses ADD COLUMN IF NOT EXISTS, DROP/ADD
-- CONSTRAINT IF EXISTS (pattern from 0073/0075/0078/0090/0091).
--
-- ORDER MATTERS: the column is added nullable first, backfilled, THEN
-- constrained NOT NULL + DEFAULT + CHECK — adding NOT NULL before backfill
-- would fail on any existing row.
--
-- DEPLOY ORDER (manual, Supabase SQL Editor): apply BEFORE merging the
-- frontend change to `main` — main triggers auto-deploy to Cloudflare
-- Workers, and the new frontend code (Slice 1's INSERT) assumes the
-- `entry_point` column already exists.
--
-- ROLLBACK:
--   ALTER TABLE notas_credito DROP COLUMN IF EXISTS entry_point;
--
--   ALTER TABLE mov_caja_fuerte DROP CONSTRAINT IF EXISTS mov_caja_fuerte_origen_check;
--   ALTER TABLE mov_caja_fuerte ADD CONSTRAINT mov_caja_fuerte_origen_check
--     CHECK (origen IN ('DEPOSITO_CIERRE','GASTO','TRASPASO','MANUAL','REVERSO'));
--
--   ALTER TABLE movimientos_bancarios DROP CONSTRAINT IF EXISTS movimientos_bancarios_origen_check;
--   ALTER TABLE movimientos_bancarios ADD CONSTRAINT movimientos_bancarios_origen_check
--     CHECK (origen IN ('DEPOSITO_CAJA','TRANSFERENCIA_CLIENTE','PAGO_PROVEEDOR','GASTO',
--                        'MANUAL','TRASPASO','REVERSO','CIERRE_CONSOLIDACION'));
-- =============================================================================

-- 1. notas_credito.entry_point (Decision 3): nullable add -> backfill -> constrain
ALTER TABLE notas_credito
  ADD COLUMN IF NOT EXISTS entry_point TEXT;

UPDATE notas_credito
  SET entry_point = CASE WHEN sesion_caja_id IS NOT NULL THEN 'POS' ELSE 'TRADICIONAL' END
  WHERE entry_point IS NULL;

ALTER TABLE notas_credito
  ALTER COLUMN entry_point SET DEFAULT 'TRADICIONAL';

ALTER TABLE notas_credito
  ALTER COLUMN entry_point SET NOT NULL;

ALTER TABLE notas_credito
  DROP CONSTRAINT IF EXISTS notas_credito_entry_point_check;

ALTER TABLE notas_credito
  ADD CONSTRAINT notas_credito_entry_point_check
  CHECK (entry_point IN ('POS', 'TRADICIONAL'));

-- 2. mov_caja_fuerte.origen CHECK += 'REFUND_NCR' (Decision 1, Slice 3 prep)
ALTER TABLE mov_caja_fuerte
  DROP CONSTRAINT IF EXISTS mov_caja_fuerte_origen_check;

ALTER TABLE mov_caja_fuerte
  ADD CONSTRAINT mov_caja_fuerte_origen_check
  CHECK (origen IN (
    'DEPOSITO_CIERRE',
    'GASTO',
    'TRASPASO',
    'MANUAL',
    'REVERSO',
    'REFUND_NCR'              -- egreso de reintegro de Nota de Credito via caja fuerte (Slice 3)
  ));

-- 3. movimientos_bancarios.origen CHECK += 'REFUND_NCR' (Decision 1, Slice 3 prep)
ALTER TABLE movimientos_bancarios
  DROP CONSTRAINT IF EXISTS movimientos_bancarios_origen_check;

ALTER TABLE movimientos_bancarios
  ADD CONSTRAINT movimientos_bancarios_origen_check
  CHECK (origen IN (
    'DEPOSITO_CAJA',
    'TRANSFERENCIA_CLIENTE',
    'PAGO_PROVEEDOR',
    'GASTO',
    'MANUAL',
    'TRASPASO',
    'REVERSO',
    'CIERRE_CONSOLIDACION',
    'REFUND_NCR'              -- egreso de reintegro de Nota de Credito via banco (Slice 3)
  ));
