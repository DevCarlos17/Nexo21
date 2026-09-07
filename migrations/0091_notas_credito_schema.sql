-- =============================================================================
-- Migration: 0091_notas_credito_schema.sql
-- Created:   2026-09-02
-- Depends:   0090_add_safc_tipo_movimientos_cuenta.sql
--
-- CONTEXT (openspec/changes/notas-credito/design.md, Decision 1/5 — Slice 1):
--   `crearNotaCredito()` (src/features/ventas/hooks/use-notas-credito.ts) has
--   inserted a `created_by` value into `notas_credito` since it was written,
--   but the column was NEVER added to `0006_ventas.sql` NOR to the PowerSync
--   local schema.ts. The INSERT fails against the real schema (local SQLite
--   AND Supabase Postgres) — this is the live bug this migration fixes.
--
--   Decision 1 (design.md): ADD the column (audit-trail parity with ~40 other
--   financial tables that already have `created_by`), never drop the insert.
--
--   This migration also bundles the REST of the schema additions the whole
--   `notas-credito` change needs (Decision 5), so later slices (2-5b) do not
--   require additional migrations:
--     - notas_credito.sesion_caja_id      (Slice 2 — Regla de Oro scope)
--     - notas_credito.liquidacion_modalidad (Slice 3 — liquidation modality)
--     - notas_credito.no_desembolso       (Slice 3 — anti-fraud gate, persisted)
--     - notas_credito_det.venta_det_id    (Slice 4a/4b — double-credit guard)
--     - notas_credito_det.subtotal_bs     (Slice 4a/4b — bimonetary symmetry)
--     - movimientos_metodo_cobro.origen CHECK += 'NCR' (Slice 2 — Regla de Oro egreso)
--     - permisos += ventas.nota_credito   (Slice 5a — dual PIN gate)
--
-- IDEMPOTENT: safe to re-run. Uses ADD COLUMN IF NOT EXISTS, DROP/ADD
-- CONSTRAINT IF EXISTS (pattern from 0073/0075/0078/0090), and
-- INSERT ... ON CONFLICT DO NOTHING (pattern from 0047/0048).
--
-- DEPLOY ORDER (manual, Supabase SQL Editor): apply BEFORE merging the
-- frontend change to `main` — main triggers auto-deploy to Cloudflare
-- Workers, and the new frontend code assumes these columns already exist.
--
-- ROLLBACK:
--   ALTER TABLE notas_credito DROP COLUMN IF EXISTS created_by;
--   ALTER TABLE notas_credito DROP COLUMN IF EXISTS sesion_caja_id;
--   ALTER TABLE notas_credito DROP COLUMN IF EXISTS liquidacion_modalidad;
--   ALTER TABLE notas_credito DROP COLUMN IF EXISTS no_desembolso;
--   ALTER TABLE notas_credito_det DROP COLUMN IF EXISTS venta_det_id;
--   ALTER TABLE notas_credito_det DROP COLUMN IF EXISTS subtotal_bs;
--   ALTER TABLE movimientos_metodo_cobro DROP CONSTRAINT IF EXISTS movimientos_metodo_cobro_origen_check;
--   ALTER TABLE movimientos_metodo_cobro ADD CONSTRAINT movimientos_metodo_cobro_origen_check
--     CHECK (origen IN ('VENTA','PAGO_CXC','DEPOSITO_BANCO','RETIRO','AJUSTE','APERTURA_CAJA',
--       'CIERRE_CAJA','INGRESO_MANUAL','EGRESO_MANUAL','AVANCE','PRESTAMO','VUELTO',
--       'COBRO_PRESTAMO','PROPINA','COBRO','DIFERENCIAL_CAMBIARIO','PAGO_PROVEEDOR',
--       'INGRESO_TESORERIA','EGRESO_TESORERIA'));
--   DELETE FROM permisos WHERE slug = 'ventas.nota_credito';
-- =============================================================================

-- 1. notas_credito: created_by (Decision 1 — the bugfix), sesion_caja_id,
--    liquidacion_modalidad, no_desembolso (Decision 5)
ALTER TABLE notas_credito
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES usuarios(id);

ALTER TABLE notas_credito
  ADD COLUMN IF NOT EXISTS sesion_caja_id UUID REFERENCES sesiones_caja(id) ON DELETE SET NULL;

ALTER TABLE notas_credito
  ADD COLUMN IF NOT EXISTS liquidacion_modalidad TEXT NOT NULL DEFAULT 'AJUSTE_CXC'
  CHECK (liquidacion_modalidad IN ('SALDO_FAVOR', 'COMPENSACION_VENTA', 'AJUSTE_CXC', 'REFUND_TESORERIA', 'EFECTIVO_REAL'));

ALTER TABLE notas_credito
  ADD COLUMN IF NOT EXISTS no_desembolso BOOLEAN NOT NULL DEFAULT TRUE;

-- 2. notas_credito_det: venta_det_id (double-credit guard FK), subtotal_bs
--    (bimonetary symmetry with ventas_det, which already has it)
ALTER TABLE notas_credito_det
  ADD COLUMN IF NOT EXISTS venta_det_id UUID REFERENCES ventas_det(id) ON DELETE RESTRICT;

ALTER TABLE notas_credito_det
  ADD COLUMN IF NOT EXISTS subtotal_bs NUMERIC(12, 2);

-- 3. movimientos_metodo_cobro.origen CHECK: add 'NCR' (Regla de Oro egreso,
--    Slice 2). Idempotent DROP + ADD pattern, mirrors 0073/0075/0078 exactly
--    — full value list copied from 0078 (the last migration to touch this
--    constraint) plus the new 'NCR' value.
ALTER TABLE movimientos_metodo_cobro
  DROP CONSTRAINT IF EXISTS movimientos_metodo_cobro_origen_check;

ALTER TABLE movimientos_metodo_cobro
  ADD CONSTRAINT movimientos_metodo_cobro_origen_check
  CHECK (origen IN (
    'VENTA',
    'PAGO_CXC',
    'DEPOSITO_BANCO',
    'RETIRO',
    'AJUSTE',
    'APERTURA_CAJA',
    'CIERRE_CAJA',
    'INGRESO_MANUAL',
    'EGRESO_MANUAL',
    'AVANCE',
    'PRESTAMO',
    'VUELTO',
    'COBRO_PRESTAMO',
    'PROPINA',
    'COBRO',
    'DIFERENCIAL_CAMBIARIO',
    'PAGO_PROVEEDOR',
    'INGRESO_TESORERIA',
    'EGRESO_TESORERIA',
    'NCR'                     -- egreso condicional de Notas de Credito (Regla de Oro, Slice 2)
  ));

-- 4. Permiso fino ventas.nota_credito — determina si el cajero necesita PIN
--    de emision para crear una NC (spec notas-credito-pos: doble PIN).
--    Mirror exacto del patron 0048 (ventas.absorber_diferencial).
INSERT INTO permisos (modulo, slug, nombre, descripcion)
VALUES (
  'ventas',
  'ventas.nota_credito',
  'Emitir notas de credito',
  'Permite emitir una nota de credito sin requerir PIN de supervisor'
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO rol_permisos (rol_id, permiso_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permisos p
WHERE r.nombre = 'Supervisor'
  AND r.is_system = FALSE
  AND p.slug = 'ventas.nota_credito'
  AND NOT EXISTS (
    SELECT 1 FROM rol_permisos rp
    WHERE rp.rol_id = r.id AND rp.permiso_id = p.id
  );

INSERT INTO rol_permisos (rol_id, permiso_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permisos p
WHERE r.nombre = 'Administrador'
  AND r.is_system = TRUE
  AND p.slug = 'ventas.nota_credito'
  AND NOT EXISTS (
    SELECT 1 FROM rol_permisos rp
    WHERE rp.rol_id = r.id AND rp.permiso_id = p.id
  );
