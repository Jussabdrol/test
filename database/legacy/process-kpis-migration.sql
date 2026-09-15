-- Process KPIs Migration
-- Links org_kpis rows to architecture processes so process KPIs can be
-- managed per-process in Architecture and surfaced in Mission Control.
-- Safe to re-run: uses IF NOT EXISTS / IF EXISTS guards.

ALTER TABLE org_kpis
  ADD COLUMN IF NOT EXISTS process_id INTEGER DEFAULT NULL
  REFERENCES org_architecture(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_org_kpis_process_id ON org_kpis (process_id);
