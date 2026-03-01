/**
 * Database Schema Definitions – Supabase PostgreSQL
 * Multi-tenant MSP Portal Schema
 */

const POSTGRES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS organizations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    assignee TEXT DEFAULT '',
    category TEXT DEFAULT 'General',
    priority TEXT DEFAULT 'Medium' CHECK(priority IN ('Low','Medium','High','Critical')),
    recurrence TEXT NOT NULL DEFAULT 'daily' CHECK(recurrence IN ('daily','weekly','biweekly','monthly','quarterly','yearly','custom')),
    custom_days INTEGER DEFAULT NULL,
    day_of_week INTEGER DEFAULT NULL,
    day_of_month INTEGER DEFAULT NULL,
    start_date TEXT NOT NULL,
    next_due TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS completions (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL,
    completed_by TEXT DEFAULT '',
    completed_at TIMESTAMP DEFAULT NOW(),
    notes TEXT DEFAULT '',
    evidence_files TEXT DEFAULT '[]',
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS actions (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    completion_id INTEGER DEFAULT NULL,
    task_id INTEGER DEFAULT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    assignee TEXT DEFAULT '',
    priority TEXT DEFAULT 'Medium' CHECK(priority IN ('Low','Medium','High','Critical')),
    status TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','closed')),
    due_date TEXT DEFAULT NULL,
    resolved_by TEXT DEFAULT '',
    resolved_at TIMESTAMP DEFAULT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (completion_id) REFERENCES completions(id) ON DELETE SET NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS audits (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    standard TEXT DEFAULT 'ISO 9001',
    scope TEXT DEFAULT '',
    lead_auditor TEXT DEFAULT '',
    audit_team TEXT DEFAULT '',
    auditee TEXT DEFAULT '',
    status TEXT DEFAULT 'planned' CHECK(status IN ('planned','in_progress','completed','cancelled')),
    planned_date TEXT DEFAULT NULL,
    completed_date TEXT DEFAULT NULL,
    summary TEXT DEFAULT '',
    recurrence TEXT DEFAULT 'none',
    recurrence_end_date TEXT DEFAULT NULL,
    parent_audit_id INTEGER DEFAULT NULL,
    instance_number INTEGER DEFAULT 1,
    standards TEXT DEFAULT '[]',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS audit_checklist (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    audit_id INTEGER NOT NULL,
    clause TEXT NOT NULL,
    requirement TEXT DEFAULT '',
    evidence TEXT DEFAULT '',
    finding TEXT DEFAULT '',
    rating TEXT DEFAULT 'not_assessed' CHECK(rating IN ('not_assessed','conforming','observation','minor_nc','major_nc')),
    notes TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    standard TEXT DEFAULT '',
    evidence_files TEXT DEFAULT '[]',
    FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS non_conformities (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    audit_id INTEGER NOT NULL,
    checklist_item_id INTEGER DEFAULT NULL,
    clause TEXT DEFAULT '',
    description TEXT NOT NULL,
    severity TEXT DEFAULT 'minor' CHECK(severity IN ('minor','major')),
    root_cause TEXT DEFAULT '',
    correction TEXT DEFAULT '',
    corrective_action TEXT DEFAULT '',
    responsible TEXT DEFAULT '',
    due_date TEXT DEFAULT NULL,
    status TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','closed','verified')),
    closed_date TEXT DEFAULT NULL,
    verification_notes TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE,
    FOREIGN KEY (checklist_item_id) REFERENCES audit_checklist(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS standard_requirements (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    standard TEXT NOT NULL DEFAULT 'ISO 9001',
    clause TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT DEFAULT '',
    category TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    owner TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS risks (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    category TEXT DEFAULT 'Information Security',
    source TEXT DEFAULT '',
    asset TEXT DEFAULT '',
    threat TEXT DEFAULT '',
    vulnerability TEXT DEFAULT '',
    likelihood INTEGER DEFAULT 3 CHECK(likelihood BETWEEN 1 AND 5),
    impact INTEGER DEFAULT 3 CHECK(impact BETWEEN 1 AND 5),
    inherent_score INTEGER DEFAULT 9,
    risk_owner TEXT DEFAULT '',
    status TEXT DEFAULT 'identified' CHECK(status IN ('identified','analyzing','treating','accepted','closed')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS risk_treatments (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    risk_id INTEGER NOT NULL,
    treatment_type TEXT DEFAULT 'mitigate' CHECK(treatment_type IN ('mitigate','accept','transfer','avoid')),
    description TEXT DEFAULT '',
    control_reference TEXT DEFAULT '',
    requirement_id INTEGER DEFAULT NULL,
    responsible TEXT DEFAULT '',
    due_date TEXT DEFAULT NULL,
    status TEXT DEFAULT 'planned' CHECK(status IN ('planned','in_progress','implemented','verified')),
    residual_likelihood INTEGER DEFAULT NULL,
    residual_impact INTEGER DEFAULT NULL,
    notes TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (risk_id) REFERENCES risks(id) ON DELETE CASCADE,
    FOREIGN KEY (requirement_id) REFERENCES standard_requirements(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS soa_entries (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    requirement_id INTEGER NOT NULL,
    applicable INTEGER DEFAULT 1,
    justification TEXT DEFAULT '',
    implementation_status TEXT DEFAULT 'not_implemented' CHECK(implementation_status IN ('not_implemented','partial','implemented')),
    notes TEXT DEFAULT '',
    linked_processes TEXT DEFAULT '[]',
    regulatory INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (requirement_id) REFERENCES standard_requirements(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS org_mission (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    content TEXT DEFAULT '',
    vision TEXT DEFAULT '',
    values_text TEXT DEFAULT '',
    updated_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS org_kpis (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    module TEXT DEFAULT 'custom',
    target_value REAL DEFAULT NULL,
    unit TEXT DEFAULT '',
    frequency TEXT DEFAULT 'monthly',
    is_auto INTEGER DEFAULT 0,
    auto_source TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS org_kpi_values (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kpi_id INTEGER NOT NULL,
    value REAL NOT NULL,
    period TEXT NOT NULL,
    recorded_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (kpi_id) REFERENCES org_kpis(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS org_architecture (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    arch_type TEXT NOT NULL CHECK(arch_type IN ('role','process','system','asset','facility')),
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    parent_id INTEGER DEFAULT NULL,
    owner TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    metadata TEXT DEFAULT '{}',
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    doc_type TEXT DEFAULT 'policy' CHECK(doc_type IN ('policy','procedure','work_instruction','record','form','report','evidence','other')),
    version TEXT DEFAULT '1.0',
    owner TEXT DEFAULT '',
    status TEXT DEFAULT 'draft' CHECK(status IN ('draft','review','approved','obsolete')),
    file_name TEXT DEFAULT '',
    file_path TEXT DEFAULT '',
    file_size INTEGER DEFAULT 0,
    mime_type TEXT DEFAULT '',
    linked_module TEXT DEFAULT '',
    linked_ref_type TEXT DEFAULT '',
    linked_ref_id INTEGER DEFAULT NULL,
    review_date TEXT DEFAULT NULL,
    classification TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS cross_links (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(organization_id, source_type, source_id, target_type, target_id)
  );

  CREATE TABLE IF NOT EXISTS threat_feeds (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    tier INTEGER DEFAULT 1 CHECK(tier BETWEEN 1 AND 4),
    enabled INTEGER DEFAULT 1,
    last_fetched TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS threat_items (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    feed_id INTEGER NOT NULL,
    guid TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    link TEXT DEFAULT '',
    pub_date TEXT DEFAULT '',
    status TEXT DEFAULT 'new' CHECK(status IN ('new','reviewed','dismissed','risk_created')),
    created_risk_id INTEGER DEFAULT NULL,
    fetched_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (feed_id) REFERENCES threat_feeds(id) ON DELETE CASCADE,
    UNIQUE(feed_id, guid)
  );

  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT DEFAULT NULL,
    role TEXT DEFAULT 'org_user' CHECK(role IN ('superadmin','org_admin','org_user')),
    department TEXT DEFAULT '',
    permissions TEXT DEFAULT '["org","risk","ops","audit"]',
    status TEXT DEFAULT 'active' CHECK(status IN ('active','pending','suspended','inactive')),
    last_active TEXT DEFAULT NULL,
    expiry_date TEXT DEFAULT NULL,
    notes TEXT DEFAULT '',
    sso_provider TEXT DEFAULT NULL,
    supabase_uid TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    user_id INTEGER DEFAULT NULL,
    user_name TEXT DEFAULT 'System',
    action TEXT NOT NULL,
    entity_type TEXT DEFAULT NULL,
    entity_id INTEGER DEFAULT NULL,
    entity_name TEXT DEFAULT NULL,
    details TEXT DEFAULT '',
    ip_address TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    permissions TEXT DEFAULT '["read"]',
    last_used TEXT DEFAULT NULL,
    expires_at TEXT DEFAULT NULL,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','revoked')),
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS webhooks (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    events TEXT DEFAULT '[]',
    secret TEXT DEFAULT '',
    status TEXT DEFAULT 'active' CHECK(status IN ('active','paused')),
    last_triggered TEXT DEFAULT NULL,
    failure_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS backups (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    type TEXT DEFAULT 'manual' CHECK(type IN ('manual','scheduled')),
    status TEXT DEFAULT 'completed' CHECK(status IN ('in_progress','completed','failed')),
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS saml_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    enabled INTEGER DEFAULT 0,
    entity_id TEXT DEFAULT '',
    sso_url TEXT DEFAULT '',
    slo_url TEXT DEFAULT '',
    certificate TEXT DEFAULT '',
    name_id_format TEXT DEFAULT 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    attribute_mapping TEXT DEFAULT '{"email":"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress","name":"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/displayname","groups":"http://schemas.microsoft.com/ws/2008/06/identity/claims/groups"}',
    auto_provision INTEGER DEFAULT 1,
    default_role TEXT DEFAULT 'org_user',
    allowed_domains TEXT DEFAULT '',
    updated_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS saml_sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name_id TEXT NOT NULL,
    session_index TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Migrations: add legal_entities to org_mission
  ALTER TABLE org_mission ADD COLUMN IF NOT EXISTS legal_entities TEXT DEFAULT '[]';

  -- Migrations: add evidence_files to completions
  ALTER TABLE completions ADD COLUMN IF NOT EXISTS evidence_files TEXT DEFAULT '[]';

  -- Migrations: backfill NULL organization_id on audit_checklist from parent audit
  UPDATE audit_checklist SET organization_id = (
    SELECT a.organization_id FROM audits a WHERE a.id = audit_checklist.audit_id
  ) WHERE organization_id IS NULL;

  -- Migrations: allow 'evidence' doc_type in documents table
  DO $$ BEGIN
    ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_doc_type_check;
    ALTER TABLE documents ADD CONSTRAINT documents_doc_type_check
      CHECK (doc_type IN ('policy','procedure','work_instruction','record','form','report','evidence','other'));
  END $$;
`;

// Default threat feeds to seed per organization
const DEFAULT_THREAT_FEEDS = [
  { name: 'NCSC-NL Advisories', url: 'https://advisories.ncsc.nl/rss/advisories', tier: 1 },
  { name: 'NCSC-NL Nieuwsberichten', url: 'https://feeds.ncsc.nl/nieuws.rss', tier: 1 },
  { name: 'NCSC-UK Advisories', url: 'https://www.ncsc.gov.uk/api/1/services/v1/report-rss-feed.xml', tier: 1 },
  { name: 'ENISA News', url: 'https://www.enisa.europa.eu/rss.xml', tier: 1 },
  { name: 'CISA Advisories', url: 'https://www.cisa.gov/cybersecurity-advisories/all.xml', tier: 2 },
  { name: 'US-CERT Alerts', url: 'https://www.us-cert.gov/ncas/alerts.xml', tier: 2 },
  { name: 'SANS ISC', url: 'https://isc.sans.edu/rssfeed_full.xml', tier: 3 },
  { name: 'NOS Nieuws Tech', url: 'https://feeds.nos.nl/nosnieuwstech', tier: 3 },
  { name: 'Schneier on Security', url: 'https://www.schneier.com/feed/atom/', tier: 3 },
  { name: 'Krebs on Security', url: 'https://krebsonsecurity.com/feed/', tier: 3 },
  { name: 'NVD CVE Feed', url: 'https://nvd.nist.gov/feeds/xml/cve/misc/nvd-rss.xml', tier: 4 },
  { name: 'Exploit-DB', url: 'https://www.exploit-db.com/rss.xml', tier: 4 },
];

module.exports = {
  POSTGRES_SCHEMA_SQL,
  DEFAULT_THREAT_FEEDS,
};
