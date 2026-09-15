-- Migration: add process_id to actions + plan_bundles table
-- Run this in the Supabase SQL editor.
-- All statements are idempotent (safe to re-run).

BEGIN;

-- ─── 1. Add process_id to actions ────────────────────────────────────────────
-- Links an action directly to a process in org_architecture.
-- NULL = standalone action not tied to a specific process.

ALTER TABLE actions
  ADD COLUMN IF NOT EXISTS process_id INTEGER DEFAULT NULL;

-- Foreign key: if the process is deleted, set process_id to NULL.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_actions_process'
      AND table_name = 'actions'
  ) THEN
    ALTER TABLE actions
      ADD CONSTRAINT fk_actions_process
      FOREIGN KEY (process_id)
      REFERENCES org_architecture(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_actions_process_id ON actions(process_id);

-- ─── 2. plan_bundles – named groups of processes per organisation ──────────────
-- Allows users to create custom "bundles" (e.g. "Core Ops", "HR Suite")
-- that aggregate multiple processes into a single context-bar tab.
-- process_ids stores a JSON array of org_architecture IDs, e.g. [1, 4, 7]

CREATE TABLE IF NOT EXISTS plan_bundles (
  id              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  process_ids     TEXT    NOT NULL DEFAULT '[]',   -- JSON array of org_architecture IDs
  color           TEXT    NOT NULL DEFAULT '#6366f1',
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_bundles_org ON plan_bundles(organization_id);

-- ─── 3. RLS for plan_bundles (mirrors pattern from existing tables) ───────────
-- Enable row-level security so each org only sees its own bundles.

ALTER TABLE plan_bundles ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Drop and recreate so the migration is re-runnable
  DROP POLICY IF EXISTS plan_bundles_org_isolation ON plan_bundles;
  CREATE POLICY plan_bundles_org_isolation ON plan_bundles
    USING (organization_id = current_setting('app.organization_id', TRUE)::INTEGER);
EXCEPTION WHEN others THEN
  -- If RLS / current_setting isn't available in this Supabase setup, skip silently
  NULL;
END $$;

COMMIT;
