-- =============================================================================
-- Row-Level Security (RLS) Policies – Multi-Tenant Isolation
-- Run this in your Supabase project's SQL Editor AFTER the main migration.
-- IDEMPOTENT: safe to re-run; existing policies are dropped and recreated.
--
-- Prerequisites:
--   1. The schema from schema.js / supabase-migration.sql must already exist
--   2. organization_id columns must be present on all tenant tables
--   3. Supabase Auth must be configured (uses auth.uid() for user lookup)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helper function: resolve the current user's organization_id from JWT
-- Uses the Supabase auth.uid() to look up the user row and return their org.
-- Superadmins (organization_id IS NULL) get NULL – policies handle this.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_user_org_id()
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT organization_id
  FROM users
  WHERE supabase_uid = auth.uid()::TEXT
  LIMIT 1;
$$;

-- Helper: returns TRUE when the authenticated user is a superadmin
CREATE OR REPLACE FUNCTION is_superadmin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM users
    WHERE supabase_uid = auth.uid()::TEXT
      AND role = 'superadmin'
  );
$$;

-- =============================================================================
-- MACRO: Enable RLS + create standard 4-operation policies for a tenant table
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. organizations  (superadmins see all; org members see their own)
-- ---------------------------------------------------------------------------
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_select" ON organizations;
DROP POLICY IF EXISTS "org_insert" ON organizations;
DROP POLICY IF EXISTS "org_update" ON organizations;
DROP POLICY IF EXISTS "org_delete" ON organizations;

CREATE POLICY "org_select" ON organizations
  FOR SELECT USING (
    is_superadmin() OR id = current_user_org_id()
  );

CREATE POLICY "org_insert" ON organizations
  FOR INSERT WITH CHECK (is_superadmin());

CREATE POLICY "org_update" ON organizations
  FOR UPDATE USING (is_superadmin());

CREATE POLICY "org_delete" ON organizations
  FOR DELETE USING (is_superadmin());

-- ---------------------------------------------------------------------------
-- 2. tasks
-- ---------------------------------------------------------------------------
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tasks_select" ON tasks;
DROP POLICY IF EXISTS "tasks_insert" ON tasks;
DROP POLICY IF EXISTS "tasks_update" ON tasks;
DROP POLICY IF EXISTS "tasks_delete" ON tasks;

CREATE POLICY "tasks_select" ON tasks
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "tasks_insert" ON tasks
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "tasks_update" ON tasks
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "tasks_delete" ON tasks
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 3. task_instances (Task Log — scheduled occurrences of recurring task series)
-- ---------------------------------------------------------------------------
ALTER TABLE task_instances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "task_instances_select" ON task_instances;
DROP POLICY IF EXISTS "task_instances_insert" ON task_instances;
DROP POLICY IF EXISTS "task_instances_update" ON task_instances;
DROP POLICY IF EXISTS "task_instances_delete" ON task_instances;

CREATE POLICY "task_instances_select" ON task_instances
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "task_instances_insert" ON task_instances
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "task_instances_update" ON task_instances
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "task_instances_delete" ON task_instances
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 4. actions
-- ---------------------------------------------------------------------------
ALTER TABLE actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "actions_select" ON actions;
DROP POLICY IF EXISTS "actions_insert" ON actions;
DROP POLICY IF EXISTS "actions_update" ON actions;
DROP POLICY IF EXISTS "actions_delete" ON actions;

CREATE POLICY "actions_select" ON actions
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "actions_insert" ON actions
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "actions_update" ON actions
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "actions_delete" ON actions
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 5. audits
-- ---------------------------------------------------------------------------
ALTER TABLE audits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audits_select" ON audits;
DROP POLICY IF EXISTS "audits_insert" ON audits;
DROP POLICY IF EXISTS "audits_update" ON audits;
DROP POLICY IF EXISTS "audits_delete" ON audits;

CREATE POLICY "audits_select" ON audits
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "audits_insert" ON audits
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "audits_update" ON audits
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "audits_delete" ON audits
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 6. audit_checklist
-- ---------------------------------------------------------------------------
ALTER TABLE audit_checklist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_checklist_select" ON audit_checklist;
DROP POLICY IF EXISTS "audit_checklist_insert" ON audit_checklist;
DROP POLICY IF EXISTS "audit_checklist_update" ON audit_checklist;
DROP POLICY IF EXISTS "audit_checklist_delete" ON audit_checklist;

CREATE POLICY "audit_checklist_select" ON audit_checklist
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "audit_checklist_insert" ON audit_checklist
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "audit_checklist_update" ON audit_checklist
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "audit_checklist_delete" ON audit_checklist
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 7. non_conformities
-- ---------------------------------------------------------------------------
ALTER TABLE non_conformities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "non_conformities_select" ON non_conformities;
DROP POLICY IF EXISTS "non_conformities_insert" ON non_conformities;
DROP POLICY IF EXISTS "non_conformities_update" ON non_conformities;
DROP POLICY IF EXISTS "non_conformities_delete" ON non_conformities;

CREATE POLICY "non_conformities_select" ON non_conformities
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "non_conformities_insert" ON non_conformities
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "non_conformities_update" ON non_conformities
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "non_conformities_delete" ON non_conformities
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 8. standard_requirements
-- ---------------------------------------------------------------------------
ALTER TABLE standard_requirements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "standard_requirements_select" ON standard_requirements;
DROP POLICY IF EXISTS "standard_requirements_insert" ON standard_requirements;
DROP POLICY IF EXISTS "standard_requirements_update" ON standard_requirements;
DROP POLICY IF EXISTS "standard_requirements_delete" ON standard_requirements;

CREATE POLICY "standard_requirements_select" ON standard_requirements
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "standard_requirements_insert" ON standard_requirements
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "standard_requirements_update" ON standard_requirements
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "standard_requirements_delete" ON standard_requirements
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 9. risks
-- ---------------------------------------------------------------------------
ALTER TABLE risks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "risks_select" ON risks;
DROP POLICY IF EXISTS "risks_insert" ON risks;
DROP POLICY IF EXISTS "risks_update" ON risks;
DROP POLICY IF EXISTS "risks_delete" ON risks;

CREATE POLICY "risks_select" ON risks
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "risks_insert" ON risks
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "risks_update" ON risks
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "risks_delete" ON risks
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 10. risk_treatments
-- ---------------------------------------------------------------------------
ALTER TABLE risk_treatments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "risk_treatments_select" ON risk_treatments;
DROP POLICY IF EXISTS "risk_treatments_insert" ON risk_treatments;
DROP POLICY IF EXISTS "risk_treatments_update" ON risk_treatments;
DROP POLICY IF EXISTS "risk_treatments_delete" ON risk_treatments;

CREATE POLICY "risk_treatments_select" ON risk_treatments
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "risk_treatments_insert" ON risk_treatments
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "risk_treatments_update" ON risk_treatments
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "risk_treatments_delete" ON risk_treatments
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 11. soa_entries
-- ---------------------------------------------------------------------------
ALTER TABLE soa_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "soa_entries_select" ON soa_entries;
DROP POLICY IF EXISTS "soa_entries_insert" ON soa_entries;
DROP POLICY IF EXISTS "soa_entries_update" ON soa_entries;
DROP POLICY IF EXISTS "soa_entries_delete" ON soa_entries;

CREATE POLICY "soa_entries_select" ON soa_entries
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "soa_entries_insert" ON soa_entries
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "soa_entries_update" ON soa_entries
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "soa_entries_delete" ON soa_entries
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 12. org_mission
-- ---------------------------------------------------------------------------
ALTER TABLE org_mission ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_mission_select" ON org_mission;
DROP POLICY IF EXISTS "org_mission_insert" ON org_mission;
DROP POLICY IF EXISTS "org_mission_update" ON org_mission;
DROP POLICY IF EXISTS "org_mission_delete" ON org_mission;

CREATE POLICY "org_mission_select" ON org_mission
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "org_mission_insert" ON org_mission
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "org_mission_update" ON org_mission
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "org_mission_delete" ON org_mission
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 13. org_kpis
-- ---------------------------------------------------------------------------
ALTER TABLE org_kpis ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_kpis_select" ON org_kpis;
DROP POLICY IF EXISTS "org_kpis_insert" ON org_kpis;
DROP POLICY IF EXISTS "org_kpis_update" ON org_kpis;
DROP POLICY IF EXISTS "org_kpis_delete" ON org_kpis;

CREATE POLICY "org_kpis_select" ON org_kpis
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "org_kpis_insert" ON org_kpis
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "org_kpis_update" ON org_kpis
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "org_kpis_delete" ON org_kpis
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 14. org_kpi_values
-- ---------------------------------------------------------------------------
ALTER TABLE org_kpi_values ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_kpi_values_select" ON org_kpi_values;
DROP POLICY IF EXISTS "org_kpi_values_insert" ON org_kpi_values;
DROP POLICY IF EXISTS "org_kpi_values_update" ON org_kpi_values;
DROP POLICY IF EXISTS "org_kpi_values_delete" ON org_kpi_values;

CREATE POLICY "org_kpi_values_select" ON org_kpi_values
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "org_kpi_values_insert" ON org_kpi_values
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "org_kpi_values_update" ON org_kpi_values
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "org_kpi_values_delete" ON org_kpi_values
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 15. org_architecture
-- ---------------------------------------------------------------------------
ALTER TABLE org_architecture ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_architecture_select" ON org_architecture;
DROP POLICY IF EXISTS "org_architecture_insert" ON org_architecture;
DROP POLICY IF EXISTS "org_architecture_update" ON org_architecture;
DROP POLICY IF EXISTS "org_architecture_delete" ON org_architecture;

CREATE POLICY "org_architecture_select" ON org_architecture
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "org_architecture_insert" ON org_architecture
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "org_architecture_update" ON org_architecture
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "org_architecture_delete" ON org_architecture
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 16. documents
-- ---------------------------------------------------------------------------
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "documents_select" ON documents;
DROP POLICY IF EXISTS "documents_insert" ON documents;
DROP POLICY IF EXISTS "documents_update" ON documents;
DROP POLICY IF EXISTS "documents_delete" ON documents;

CREATE POLICY "documents_select" ON documents
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "documents_insert" ON documents
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "documents_update" ON documents
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "documents_delete" ON documents
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 17. cross_links
-- ---------------------------------------------------------------------------
ALTER TABLE cross_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cross_links_select" ON cross_links;
DROP POLICY IF EXISTS "cross_links_insert" ON cross_links;
DROP POLICY IF EXISTS "cross_links_update" ON cross_links;
DROP POLICY IF EXISTS "cross_links_delete" ON cross_links;

CREATE POLICY "cross_links_select" ON cross_links
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "cross_links_insert" ON cross_links
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "cross_links_update" ON cross_links
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "cross_links_delete" ON cross_links
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 18. threat_feeds
-- ---------------------------------------------------------------------------
ALTER TABLE threat_feeds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "threat_feeds_select" ON threat_feeds;
DROP POLICY IF EXISTS "threat_feeds_insert" ON threat_feeds;
DROP POLICY IF EXISTS "threat_feeds_update" ON threat_feeds;
DROP POLICY IF EXISTS "threat_feeds_delete" ON threat_feeds;

CREATE POLICY "threat_feeds_select" ON threat_feeds
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "threat_feeds_insert" ON threat_feeds
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "threat_feeds_update" ON threat_feeds
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "threat_feeds_delete" ON threat_feeds
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 19. threat_items
-- ---------------------------------------------------------------------------
ALTER TABLE threat_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "threat_items_select" ON threat_items;
DROP POLICY IF EXISTS "threat_items_insert" ON threat_items;
DROP POLICY IF EXISTS "threat_items_update" ON threat_items;
DROP POLICY IF EXISTS "threat_items_delete" ON threat_items;

CREATE POLICY "threat_items_select" ON threat_items
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "threat_items_insert" ON threat_items
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "threat_items_update" ON threat_items
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "threat_items_delete" ON threat_items
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 20. api_keys
-- ---------------------------------------------------------------------------
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "api_keys_select" ON api_keys;
DROP POLICY IF EXISTS "api_keys_insert" ON api_keys;
DROP POLICY IF EXISTS "api_keys_update" ON api_keys;
DROP POLICY IF EXISTS "api_keys_delete" ON api_keys;

CREATE POLICY "api_keys_select" ON api_keys
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "api_keys_insert" ON api_keys
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "api_keys_update" ON api_keys
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "api_keys_delete" ON api_keys
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 21. webhooks
-- ---------------------------------------------------------------------------
ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webhooks_select" ON webhooks;
DROP POLICY IF EXISTS "webhooks_insert" ON webhooks;
DROP POLICY IF EXISTS "webhooks_update" ON webhooks;
DROP POLICY IF EXISTS "webhooks_delete" ON webhooks;

CREATE POLICY "webhooks_select" ON webhooks
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "webhooks_insert" ON webhooks
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "webhooks_update" ON webhooks
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "webhooks_delete" ON webhooks
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 22. backups
-- ---------------------------------------------------------------------------
ALTER TABLE backups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "backups_select" ON backups;
DROP POLICY IF EXISTS "backups_insert" ON backups;
DROP POLICY IF EXISTS "backups_update" ON backups;
DROP POLICY IF EXISTS "backups_delete" ON backups;

CREATE POLICY "backups_select" ON backups
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "backups_insert" ON backups
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "backups_update" ON backups
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "backups_delete" ON backups
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- 23. users  (special: nullable org_id; users can see themselves)
-- ---------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_select" ON users;
DROP POLICY IF EXISTS "users_insert" ON users;
DROP POLICY IF EXISTS "users_update" ON users;
DROP POLICY IF EXISTS "users_delete" ON users;

CREATE POLICY "users_select" ON users
  FOR SELECT USING (
    is_superadmin()
    OR supabase_uid = auth.uid()::TEXT
    OR (organization_id IS NOT NULL AND organization_id = current_user_org_id())
  );

CREATE POLICY "users_insert" ON users
  FOR INSERT WITH CHECK (
    is_superadmin()
    OR (organization_id IS NOT NULL AND organization_id = current_user_org_id())
  );

CREATE POLICY "users_update" ON users
  FOR UPDATE USING (
    is_superadmin()
    OR supabase_uid = auth.uid()::TEXT
    OR (organization_id IS NOT NULL AND organization_id = current_user_org_id())
  );

CREATE POLICY "users_delete" ON users
  FOR DELETE USING (is_superadmin());

-- ---------------------------------------------------------------------------
-- 24. system_settings  (nullable org_id)
-- ---------------------------------------------------------------------------
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "system_settings_select" ON system_settings;
DROP POLICY IF EXISTS "system_settings_insert" ON system_settings;
DROP POLICY IF EXISTS "system_settings_update" ON system_settings;
DROP POLICY IF EXISTS "system_settings_delete" ON system_settings;

CREATE POLICY "system_settings_select" ON system_settings
  FOR SELECT USING (
    is_superadmin()
    OR (organization_id IS NOT NULL AND organization_id = current_user_org_id())
    OR organization_id IS NULL
  );

CREATE POLICY "system_settings_insert" ON system_settings
  FOR INSERT WITH CHECK (
    is_superadmin()
    OR (organization_id IS NOT NULL AND organization_id = current_user_org_id())
  );

CREATE POLICY "system_settings_update" ON system_settings
  FOR UPDATE USING (
    is_superadmin()
    OR (organization_id IS NOT NULL AND organization_id = current_user_org_id())
  );

CREATE POLICY "system_settings_delete" ON system_settings
  FOR DELETE USING (is_superadmin());

-- ---------------------------------------------------------------------------
-- 25. admin_audit_log  (nullable org_id; read-only for org members)
-- ---------------------------------------------------------------------------
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_audit_log_select" ON admin_audit_log;
DROP POLICY IF EXISTS "admin_audit_log_insert" ON admin_audit_log;

CREATE POLICY "admin_audit_log_select" ON admin_audit_log
  FOR SELECT USING (
    is_superadmin()
    OR (organization_id IS NOT NULL AND organization_id = current_user_org_id())
  );

CREATE POLICY "admin_audit_log_insert" ON admin_audit_log
  FOR INSERT WITH CHECK (
    is_superadmin()
    OR (organization_id IS NOT NULL AND organization_id = current_user_org_id())
  );

-- No update/delete for audit logs – immutable by design

-- ---------------------------------------------------------------------------
-- 26. saml_config  (singleton, nullable org_id – superadmin only)
-- ---------------------------------------------------------------------------
ALTER TABLE saml_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "saml_config_select" ON saml_config;
DROP POLICY IF EXISTS "saml_config_update" ON saml_config;

CREATE POLICY "saml_config_select" ON saml_config
  FOR SELECT USING (
    is_superadmin()
    OR (organization_id IS NOT NULL AND organization_id = current_user_org_id())
  );

CREATE POLICY "saml_config_update" ON saml_config
  FOR UPDATE USING (is_superadmin());

-- ---------------------------------------------------------------------------
-- 27. saml_sessions  (scoped via user_id → users.organization_id)
-- ---------------------------------------------------------------------------
ALTER TABLE saml_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "saml_sessions_select" ON saml_sessions;
DROP POLICY IF EXISTS "saml_sessions_insert" ON saml_sessions;
DROP POLICY IF EXISTS "saml_sessions_delete" ON saml_sessions;

CREATE POLICY "saml_sessions_select" ON saml_sessions
  FOR SELECT USING (
    is_superadmin()
    OR user_id IN (
      SELECT id FROM users WHERE supabase_uid = auth.uid()::TEXT
    )
  );

CREATE POLICY "saml_sessions_insert" ON saml_sessions
  FOR INSERT WITH CHECK (
    is_superadmin()
    OR user_id IN (
      SELECT id FROM users WHERE supabase_uid = auth.uid()::TEXT
    )
  );

CREATE POLICY "saml_sessions_delete" ON saml_sessions
  FOR DELETE USING (
    is_superadmin()
    OR user_id IN (
      SELECT id FROM users WHERE supabase_uid = auth.uid()::TEXT
    )
  );

-- =============================================================================
-- Performance indexes for RLS policy evaluation
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_users_supabase_uid ON users(supabase_uid);
CREATE INDEX IF NOT EXISTS idx_users_org_id ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_tasks_org_id ON tasks(organization_id);
CREATE INDEX IF NOT EXISTS idx_task_instances_org_id ON task_instances(organization_id);
CREATE INDEX IF NOT EXISTS idx_actions_org_id ON actions(organization_id);
CREATE INDEX IF NOT EXISTS idx_audits_org_id ON audits(organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_checklist_org_id ON audit_checklist(organization_id);
CREATE INDEX IF NOT EXISTS idx_non_conformities_org_id ON non_conformities(organization_id);
CREATE INDEX IF NOT EXISTS idx_standard_requirements_org_id ON standard_requirements(organization_id);
CREATE INDEX IF NOT EXISTS idx_risks_org_id ON risks(organization_id);
CREATE INDEX IF NOT EXISTS idx_risk_treatments_org_id ON risk_treatments(organization_id);
CREATE INDEX IF NOT EXISTS idx_soa_entries_org_id ON soa_entries(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_mission_org_id ON org_mission(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_kpis_org_id ON org_kpis(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_kpi_values_org_id ON org_kpi_values(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_architecture_org_id ON org_architecture(organization_id);
CREATE INDEX IF NOT EXISTS idx_documents_org_id ON documents(organization_id);
CREATE INDEX IF NOT EXISTS idx_cross_links_org_id ON cross_links(organization_id);
CREATE INDEX IF NOT EXISTS idx_threat_feeds_org_id ON threat_feeds(organization_id);
CREATE INDEX IF NOT EXISTS idx_threat_items_org_id ON threat_items(organization_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_org_id ON api_keys(organization_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_org_id ON webhooks(organization_id);
CREATE INDEX IF NOT EXISTS idx_backups_org_id ON backups(organization_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_org_id ON admin_audit_log(organization_id);
CREATE INDEX IF NOT EXISTS idx_system_settings_org_id ON system_settings(organization_id);

-- =============================================================================
-- Improvement 14: RLS policies for tables added after initial migration
-- These 4 tables had no Row Level Security — a full multi-tenant isolation breach.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- management_reviews
-- ---------------------------------------------------------------------------
ALTER TABLE management_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "management_reviews_select" ON management_reviews;
DROP POLICY IF EXISTS "management_reviews_insert" ON management_reviews;
DROP POLICY IF EXISTS "management_reviews_update" ON management_reviews;
DROP POLICY IF EXISTS "management_reviews_delete" ON management_reviews;

CREATE POLICY "management_reviews_select" ON management_reviews
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "management_reviews_insert" ON management_reviews
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "management_reviews_update" ON management_reviews
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "management_reviews_delete" ON management_reviews
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- management_review_inputs
-- ---------------------------------------------------------------------------
ALTER TABLE management_review_inputs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "management_review_inputs_select" ON management_review_inputs;
DROP POLICY IF EXISTS "management_review_inputs_insert" ON management_review_inputs;
DROP POLICY IF EXISTS "management_review_inputs_update" ON management_review_inputs;
DROP POLICY IF EXISTS "management_review_inputs_delete" ON management_review_inputs;

CREATE POLICY "management_review_inputs_select" ON management_review_inputs
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "management_review_inputs_insert" ON management_review_inputs
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "management_review_inputs_update" ON management_review_inputs
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "management_review_inputs_delete" ON management_review_inputs
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- management_review_outputs
-- ---------------------------------------------------------------------------
ALTER TABLE management_review_outputs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "management_review_outputs_select" ON management_review_outputs;
DROP POLICY IF EXISTS "management_review_outputs_insert" ON management_review_outputs;
DROP POLICY IF EXISTS "management_review_outputs_update" ON management_review_outputs;
DROP POLICY IF EXISTS "management_review_outputs_delete" ON management_review_outputs;

CREATE POLICY "management_review_outputs_select" ON management_review_outputs
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "management_review_outputs_insert" ON management_review_outputs
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "management_review_outputs_update" ON management_review_outputs
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "management_review_outputs_delete" ON management_review_outputs
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- ---------------------------------------------------------------------------
-- suppliers
-- ---------------------------------------------------------------------------
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "suppliers_select" ON suppliers;
DROP POLICY IF EXISTS "suppliers_insert" ON suppliers;
DROP POLICY IF EXISTS "suppliers_update" ON suppliers;
DROP POLICY IF EXISTS "suppliers_delete" ON suppliers;

CREATE POLICY "suppliers_select" ON suppliers
  FOR SELECT USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "suppliers_insert" ON suppliers
  FOR INSERT WITH CHECK (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "suppliers_update" ON suppliers
  FOR UPDATE USING (is_superadmin() OR organization_id = current_user_org_id());

CREATE POLICY "suppliers_delete" ON suppliers
  FOR DELETE USING (is_superadmin() OR organization_id = current_user_org_id());

-- =============================================================================
-- Improvement 1: cross_links UNIQUE constraint update (relationship_type added)
-- The application layer already defaults relationship_type to 'association'.
-- This updates the constraint so the same entity pair can have multiple
-- relationship types (e.g., a role can both ASSIGN to and INFLUENCE a process).
-- =============================================================================
ALTER TABLE cross_links DROP CONSTRAINT IF EXISTS cross_links_organization_id_source_type_source_id_target_type_target_id_key;
ALTER TABLE cross_links ADD CONSTRAINT cross_links_unique
  UNIQUE (organization_id, source_type, source_id, target_type, target_id, relationship_type);
