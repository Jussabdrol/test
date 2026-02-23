-- =============================================================================
-- Row-Level Security Policies – Multi-tenant / MSP Edition
--
-- Apply these in your Supabase project:
--   Dashboard → SQL Editor → paste and run
--
-- Architecture:
--   • Every request sets a session variable:  SET LOCAL app.org_id = '<id>';
--   • RLS policies use current_setting('app.org_id', true) to filter rows.
--   • The Node.js server enforces org scoping at the query level, so RLS is
--     a defense-in-depth layer rather than the primary isolation mechanism.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Helper function – returns the org_id for the current DB session
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_org_id() RETURNS integer
  LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::integer;
$$;

-- ---------------------------------------------------------------------------
-- 2. Enable RLS on all tenant-scoped tables
-- ---------------------------------------------------------------------------
ALTER TABLE tasks                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE completions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE actions               ENABLE ROW LEVEL SECURITY;
ALTER TABLE audits                ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_checklist       ENABLE ROW LEVEL SECURITY;
ALTER TABLE non_conformities      ENABLE ROW LEVEL SECURITY;
ALTER TABLE standard_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE risks                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_treatments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE soa_entries           ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_mission           ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_kpis              ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_kpi_values        ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_architecture      ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents             ENABLE ROW LEVEL SECURITY;
ALTER TABLE cross_links           ENABLE ROW LEVEL SECURITY;
ALTER TABLE threat_feeds          ENABLE ROW LEVEL SECURITY;
ALTER TABLE threat_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log       ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. Drop existing policies (idempotent)
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'tasks','completions','actions','audits','audit_checklist',
        'non_conformities','standard_requirements','risks','risk_treatments',
        'soa_entries','org_mission','org_kpis','org_kpi_values',
        'org_architecture','documents','cross_links','threat_feeds',
        'threat_items','users','system_settings','admin_audit_log'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
      r.policyname, r.schemaname, r.tablename);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Tenant-isolation policies
--    All policies use current_org_id() so that:
--      • Rows with matching organization_id are visible
--      • Superadmin (app.org_id IS NULL) bypasses the filter
--    The Node.js application layer still scopes all queries independently.
-- ---------------------------------------------------------------------------

-- TASKS
CREATE POLICY tasks_org_isolation ON tasks
  USING (organization_id = current_org_id() OR current_org_id() IS NULL)
  WITH CHECK (organization_id = current_org_id() OR current_org_id() IS NULL);

-- COMPLETIONS
CREATE POLICY completions_org_isolation ON completions
  USING (organization_id = current_org_id() OR current_org_id() IS NULL)
  WITH CHECK (organization_id = current_org_id() OR current_org_id() IS NULL);

-- ACTIONS
CREATE POLICY actions_org_isolation ON actions
  USING (organization_id = current_org_id() OR current_org_id() IS NULL)
  WITH CHECK (organization_id = current_org_id() OR current_org_id() IS NULL);

-- AUDITS
CREATE POLICY audits_org_isolation ON audits
  USING (organization_id = current_org_id() OR current_org_id() IS NULL)
  WITH CHECK (organization_id = current_org_id() OR current_org_id() IS NULL);

-- AUDIT CHECKLIST (inherits via audit; direct filter for safety)
CREATE POLICY audit_checklist_org_isolation ON audit_checklist
  USING (organization_id = current_org_id() OR current_org_id() IS NULL)
  WITH CHECK (organization_id = current_org_id() OR current_org_id() IS NULL);

-- NON-CONFORMITIES
CREATE POLICY non_conformities_org_isolation ON non_conformities
  USING (organization_id = current_org_id() OR current_org_id() IS NULL)
  WITH CHECK (organization_id = current_org_id() OR current_org_id() IS NULL);

-- STANDARD REQUIREMENTS
CREATE POLICY standard_requirements_org_isolation ON standard_requirements
  USING (organization_id = current_org_id() OR current_org_id() IS NULL)
  WITH CHECK (organization_id = current_org_id() OR current_org_id() IS NULL);

-- RISKS
CREATE POLICY risks_org_isolation ON risks
  USING (organization_id = current_org_id() OR current_org_id() IS NULL)
  WITH CHECK (organization_id = current_org_id() OR current_org_id() IS NULL);

-- RISK TREATMENTS (inherits via risks; direct filter for safety)
CREATE POLICY risk_treatments_org_isolation ON risk_treatments
  USING (organization_id = current_org_id() OR current_org_id() IS NULL)
  WITH CHECK (organization_id = current_org_id() OR current_org_id() IS NULL);

-- SOA ENTRIES (inherits via requirements; direct filter for safety)
CREATE POLICY soa_entries_org_isolation ON soa_entries
  USING (organization_id = current_org_id() OR current_org_id() IS NULL)
  WITH CHECK (organization_id = current_org_id() OR current_org_id() IS NULL);

-- ORG MISSION
CREATE POLICY org_mission_org_isolation ON org_mission
  USING (organization_id = current_org_id() OR current_org_id() IS NULL)
  WITH CHECK (organization_id = current_org_id() OR current_org_id() IS NULL);

-- ORG KPIS
CREATE POLICY org_kpis_org_isolation ON org_kpis
  USING (organization_id = current_org_id() OR current_org_id() IS NULL)
  WITH CHECK (organization_id = current_org_id() OR current_org_id() IS NULL);

-- ORG KPI VALUES (inherits via kpis)
CREATE POLICY org_kpi_values_org_isolation ON org_kpi_values
  USING (
    organization_id = current_org_id() OR current_org_id() IS NULL
    OR kpi_id IN (SELECT id FROM org_kpis WHERE organization_id = current_org_id())
  );

-- ORG ARCHITECTURE
CREATE POLICY org_architecture_org_isolation ON org_architecture
  USING (organization_id = current_org_id() OR current_org_id() IS NULL)
  WITH CHECK (organization_id = current_org_id() OR current_org_id() IS NULL);

-- DOCUMENTS
CREATE POLICY documents_org_isolation ON documents
  USING (organization_id = current_org_id() OR current_org_id() IS NULL)
  WITH CHECK (organization_id = current_org_id() OR current_org_id() IS NULL);

-- CROSS LINKS
CREATE POLICY cross_links_org_isolation ON cross_links
  USING (organization_id = current_org_id() OR current_org_id() IS NULL)
  WITH CHECK (organization_id = current_org_id() OR current_org_id() IS NULL);

-- THREAT FEEDS
CREATE POLICY threat_feeds_org_isolation ON threat_feeds
  USING (organization_id = current_org_id() OR current_org_id() IS NULL)
  WITH CHECK (organization_id = current_org_id() OR current_org_id() IS NULL);

-- THREAT ITEMS (inherits via feeds)
CREATE POLICY threat_items_org_isolation ON threat_items
  USING (
    feed_id IN (
      SELECT id FROM threat_feeds
      WHERE organization_id = current_org_id() OR current_org_id() IS NULL
    )
  );

-- USERS (org-scoped; superadmin sees all)
CREATE POLICY users_org_isolation ON users
  USING (organization_id = current_org_id() OR current_org_id() IS NULL OR role = 'superadmin')
  WITH CHECK (organization_id = current_org_id() OR current_org_id() IS NULL);

-- SYSTEM SETTINGS (org-scoped)
CREATE POLICY system_settings_org_isolation ON system_settings
  USING (
    organization_id IS NOT DISTINCT FROM current_org_id()
    OR current_org_id() IS NULL
  )
  WITH CHECK (
    organization_id IS NOT DISTINCT FROM current_org_id()
    OR current_org_id() IS NULL
  );

-- ADMIN AUDIT LOG (org-scoped; superadmin sees all)
CREATE POLICY admin_audit_log_org_isolation ON admin_audit_log
  USING (
    organization_id = current_org_id()
    OR organization_id IS NULL
    OR current_org_id() IS NULL
  );

-- ---------------------------------------------------------------------------
-- 5. Organizations table — superadmin only (no RLS filter needed since the
--    Node.js layer enforces requireSuperAdmin on all /api/msp/* routes)
-- ---------------------------------------------------------------------------
-- NOTE: organizations table does NOT need RLS because:
--   a) All write/read access is through /api/msp/* which requires superadmin
--   b) Regular org users never call these endpoints
-- If you want belt-and-suspenders RLS on it anyway:
--
-- ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY orgs_superadmin_only ON organizations USING (true);

-- ---------------------------------------------------------------------------
-- 6. Grant the service role bypass (Supabase service_role bypasses RLS by
--    default, which is what the Node.js backend uses via pg pooler).
--    No action needed — this is automatic in Supabase.
-- ---------------------------------------------------------------------------

-- =============================================================================
-- Usage Notes:
--
-- The Node.js server connects via the Supabase connection pooler using the
-- DATABASE_URL (which uses the service role implicitly through pooler auth).
-- RLS is bypassed for the service role automatically.
--
-- To ENFORCE RLS for the backend (extra security), you would:
--   1. Create a dedicated PostgreSQL role for the app (not service_role)
--   2. Connect using that role's credentials
--   3. Before each query, run: SET LOCAL app.org_id = '<org_id>';
--   4. After each query, the LOCAL setting auto-resets
--
-- Example wrapper in db.js:
--   async function queryWithOrg(orgId, sql, params) {
--     const client = await pool.connect();
--     try {
--       await client.query(`SET LOCAL app.org_id = '${orgId}'`);
--       return await client.query(sql, params);
--     } finally {
--       client.release();
--     }
--   }
-- =============================================================================
