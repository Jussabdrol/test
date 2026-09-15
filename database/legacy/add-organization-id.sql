-- =============================================================================
-- Migration: Add Multi-Tenant (organization_id) Support to Existing Tables
-- Run this in your Supabase project's SQL Editor (Dashboard → SQL Editor)
--
-- Safe to run multiple times – uses IF NOT EXISTS / IF EXISTS checks throughout.
-- Does NOT drop or recreate any existing tables.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Create the organizations table (if it doesn't exist)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  is_active INTEGER DEFAULT 1
);

-- Insert a default organization so existing rows have somewhere to point.
-- Uses ON CONFLICT to be idempotent.
INSERT INTO organizations (id, name, slug)
VALUES (1, 'Default Organization', 'default')
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Add organization_id to all data tables (NOT NULL with default org = 1)
-- ─────────────────────────────────────────────────────────────────────────────

-- Tasks & completions
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE tasks SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE tasks ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN organization_id SET DEFAULT 1;

ALTER TABLE completions ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE completions SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE completions ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE completions ALTER COLUMN organization_id SET DEFAULT 1;

ALTER TABLE actions ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE actions SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE actions ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE actions ALTER COLUMN organization_id SET DEFAULT 1;

-- Audit management
ALTER TABLE audits ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE audits SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE audits ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE audits ALTER COLUMN organization_id SET DEFAULT 1;

ALTER TABLE audit_checklist ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE audit_checklist SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE audit_checklist ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE audit_checklist ALTER COLUMN organization_id SET DEFAULT 1;

ALTER TABLE non_conformities ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE non_conformities SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE non_conformities ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE non_conformities ALTER COLUMN organization_id SET DEFAULT 1;

-- Standards & requirements
ALTER TABLE standard_requirements ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE standard_requirements SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE standard_requirements ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE standard_requirements ALTER COLUMN organization_id SET DEFAULT 1;

-- Risk management
ALTER TABLE risks ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE risks SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE risks ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE risks ALTER COLUMN organization_id SET DEFAULT 1;

ALTER TABLE risk_treatments ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE risk_treatments SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE risk_treatments ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE risk_treatments ALTER COLUMN organization_id SET DEFAULT 1;

-- Statement of Applicability
ALTER TABLE soa_entries ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE soa_entries SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE soa_entries ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE soa_entries ALTER COLUMN organization_id SET DEFAULT 1;

-- Organizational planning
ALTER TABLE org_mission ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE org_mission SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE org_mission ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE org_mission ALTER COLUMN organization_id SET DEFAULT 1;

ALTER TABLE org_kpis ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE org_kpis SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE org_kpis ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE org_kpis ALTER COLUMN organization_id SET DEFAULT 1;

ALTER TABLE org_kpi_values ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE org_kpi_values SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE org_kpi_values ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE org_kpi_values ALTER COLUMN organization_id SET DEFAULT 1;

ALTER TABLE org_architecture ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE org_architecture SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE org_architecture ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE org_architecture ALTER COLUMN organization_id SET DEFAULT 1;

-- Document control
ALTER TABLE documents ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE documents SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE documents ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE documents ALTER COLUMN organization_id SET DEFAULT 1;

-- Cross-linking
ALTER TABLE cross_links ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE cross_links SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE cross_links ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE cross_links ALTER COLUMN organization_id SET DEFAULT 1;

-- Threat intelligence
ALTER TABLE threat_feeds ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE threat_feeds SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE threat_feeds ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE threat_feeds ALTER COLUMN organization_id SET DEFAULT 1;

ALTER TABLE threat_items ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE threat_items SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE threat_items ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE threat_items ALTER COLUMN organization_id SET DEFAULT 1;

-- API keys
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE api_keys SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE api_keys ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE api_keys ALTER COLUMN organization_id SET DEFAULT 1;

-- Webhooks
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE webhooks SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE webhooks ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE webhooks ALTER COLUMN organization_id SET DEFAULT 1;

-- Backups
ALTER TABLE backups ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE backups SET organization_id = 1 WHERE organization_id IS NULL;
ALTER TABLE backups ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE backups ALTER COLUMN organization_id SET DEFAULT 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Add organization_id to tables where it is NULLABLE
-- ─────────────────────────────────────────────────────────────────────────────

-- Users (nullable – superadmin may not belong to an org)
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id INTEGER;
UPDATE users SET organization_id = 1 WHERE organization_id IS NULL AND role != 'superadmin';

-- System settings (nullable – some settings are global)
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS organization_id INTEGER;

-- Admin audit log (nullable – tracks cross-org actions)
ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS organization_id INTEGER;

-- SAML config (nullable)
ALTER TABLE saml_config ADD COLUMN IF NOT EXISTS organization_id INTEGER;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Add supabase_uid column to users (for Supabase Auth integration)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS supabase_uid TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_provider TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Migrate users.role from old values to new multi-tenant role values
--
--    Old: 'admin', 'user'  (CHECK constraint)
--    New: 'superadmin', 'org_admin', 'org_user'
--
--    Mapping: 'admin' → 'org_admin', 'user' → 'org_user'
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop the old CHECK constraint (name varies by DB, so use a DO block to find it)
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  -- Find any CHECK constraint on users.role
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_attribute att ON att.attnum = ANY(con.conkey) AND att.attrelid = con.conrelid
  WHERE con.conrelid = 'users'::regclass
    AND con.contype = 'c'
    AND att.attname = 'role';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

-- Migrate old role values to new ones
UPDATE users SET role = 'org_admin' WHERE role = 'admin';
UPDATE users SET role = 'org_user' WHERE role = 'user';

-- Set default for any NULL roles
UPDATE users SET role = 'org_user' WHERE role IS NULL;

-- Add new CHECK constraint with the multi-tenant role values
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('superadmin', 'org_admin', 'org_user'));

-- Set the default
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'org_user';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Add foreign key constraints for organization_id
--    (only if they don't already exist)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  tables_not_null TEXT[] := ARRAY[
    'tasks', 'completions', 'actions',
    'audits', 'audit_checklist', 'non_conformities',
    'standard_requirements', 'risks', 'risk_treatments', 'soa_entries',
    'org_mission', 'org_kpis', 'org_kpi_values', 'org_architecture',
    'documents', 'cross_links',
    'threat_feeds', 'threat_items',
    'api_keys', 'webhooks', 'backups'
  ];
  tables_nullable TEXT[] := ARRAY[
    'users', 'system_settings', 'admin_audit_log', 'saml_config'
  ];
  tbl TEXT;
  fk_name TEXT;
  fk_exists BOOLEAN;
BEGIN
  -- NOT NULL tables: ON DELETE CASCADE
  FOREACH tbl IN ARRAY tables_not_null LOOP
    fk_name := tbl || '_organization_id_fkey';
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = fk_name
    ) INTO fk_exists;
    IF NOT fk_exists THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE',
        tbl, fk_name
      );
    END IF;
  END LOOP;

  -- Nullable tables: ON DELETE SET NULL (except system_settings which uses CASCADE)
  FOREACH tbl IN ARRAY tables_nullable LOOP
    fk_name := tbl || '_organization_id_fkey';
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = fk_name
    ) INTO fk_exists;
    IF NOT fk_exists THEN
      IF tbl = 'system_settings' THEN
        EXECUTE format(
          'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE',
          tbl, fk_name
        );
      ELSE
        EXECUTE format(
          'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL',
          tbl, fk_name
        );
      END IF;
    END IF;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Add indexes on organization_id for query performance
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks(organization_id);
CREATE INDEX IF NOT EXISTS idx_completions_org ON completions(organization_id);
CREATE INDEX IF NOT EXISTS idx_actions_org ON actions(organization_id);
CREATE INDEX IF NOT EXISTS idx_audits_org ON audits(organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_checklist_org ON audit_checklist(organization_id);
CREATE INDEX IF NOT EXISTS idx_non_conformities_org ON non_conformities(organization_id);
CREATE INDEX IF NOT EXISTS idx_standard_requirements_org ON standard_requirements(organization_id);
CREATE INDEX IF NOT EXISTS idx_risks_org ON risks(organization_id);
CREATE INDEX IF NOT EXISTS idx_risk_treatments_org ON risk_treatments(organization_id);
CREATE INDEX IF NOT EXISTS idx_soa_entries_org ON soa_entries(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_mission_org ON org_mission(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_kpis_org ON org_kpis(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_kpi_values_org ON org_kpi_values(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_architecture_org ON org_architecture(organization_id);
CREATE INDEX IF NOT EXISTS idx_documents_org ON documents(organization_id);
CREATE INDEX IF NOT EXISTS idx_cross_links_org ON cross_links(organization_id);
CREATE INDEX IF NOT EXISTS idx_threat_feeds_org ON threat_feeds(organization_id);
CREATE INDEX IF NOT EXISTS idx_threat_items_org ON threat_items(organization_id);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys(organization_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks(organization_id);
CREATE INDEX IF NOT EXISTS idx_backups_org ON backups(organization_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_org ON admin_audit_log(organization_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Add unique constraint on cross_links (if not already present)
-- ─────────────────────────────────────────────────────────────────────────────

-- The schema expects a unique constraint on (organization_id, source_type, source_id, target_type, target_id).
-- Drop the old one without org_id if it exists, then create the new one.
DO $$
DECLARE
  old_constraint TEXT;
BEGIN
  -- Check if the new constraint already exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cross_links'::regclass
      AND contype = 'u'
      AND array_length(conkey, 1) = 5
  ) THEN
    -- Drop old unique constraint (without organization_id) if it exists
    SELECT con.conname INTO old_constraint
    FROM pg_constraint con
    WHERE con.conrelid = 'cross_links'::regclass
      AND con.contype = 'u'
      AND array_length(con.conkey, 1) = 4;

    IF old_constraint IS NOT NULL THEN
      EXECUTE format('ALTER TABLE cross_links DROP CONSTRAINT %I', old_constraint);
    END IF;

    -- Add the new unique constraint including organization_id
    ALTER TABLE cross_links ADD CONSTRAINT cross_links_org_unique
      UNIQUE(organization_id, source_type, source_id, target_type, target_id);
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- Migration complete. All existing rows now belong to the "Default Organization"
-- (id = 1). You can rename it or reassign rows to other organizations as needed.
-- =============================================================================
