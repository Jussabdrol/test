-- Suppliers Migration
-- Run once against the Supabase PostgreSQL database.
-- Safe to re-run: all statements use IF NOT EXISTS guards.

-- ============================================================
-- Table: suppliers
-- ============================================================
CREATE TABLE IF NOT EXISTS suppliers (
  id                    SERIAL PRIMARY KEY,
  organization_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Core identification
  name                  TEXT NOT NULL,
  category              TEXT NOT NULL DEFAULT 'other'
                          CHECK (category IN ('data_processor','saas','msp','cloud','hardware','professional_services','other')),
  criticality           TEXT NOT NULL DEFAULT 'medium'
                          CHECK (criticality IN ('high','medium','low')),
  services_provided     TEXT NOT NULL DEFAULT '',

  -- GDPR / data processing
  data_classification   TEXT NOT NULL DEFAULT '',

  -- Contracts
  contract_status       TEXT NOT NULL DEFAULT 'current'
                          CHECK (contract_status IN ('current','expired','under_renegotiation','pending')),
  contract_expiry_date  DATE DEFAULT NULL,

  -- Data Processing Agreement
  dpa_in_place          TEXT NOT NULL DEFAULT 'no'
                          CHECK (dpa_in_place IN ('yes','no','na')),
  dpa_review_date       DATE DEFAULT NULL,   -- Phase 2 analysis date

  -- Review & risk
  gaps_identified       TEXT NOT NULL DEFAULT '',
  remediation_status    TEXT NOT NULL DEFAULT 'open'
                          CHECK (remediation_status IN ('open','in_progress','closed')),
  next_review_date      DATE DEFAULT NULL,

  -- General
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','inactive','offboarded')),
  notes                 TEXT NOT NULL DEFAULT '',

  -- Extended fields stored as JSON:
  --   contact_name, contact_email, country, website
  --   data_subjects, legal_basis, third_country_transfers,
  --   transfer_mechanism, breach_contact
  --   quality_rating, quality_score, quality_date, quality_cert,
  --   delivery_pct, quality_notes
  --   infosec_rating, infosec_score, infosec_date, infosec_cert,
  --   sec_questionnaire, pentest_date, infosec_findings
  --   env_rating, env_score, env_date, env_cert, carbon, env_notes
  --   arch_links  (array of { type, id, name })
  metadata              TEXT NOT NULL DEFAULT '{}',

  created_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_suppliers_org_id
  ON suppliers (organization_id);

CREATE INDEX IF NOT EXISTS idx_suppliers_criticality
  ON suppliers (criticality);

CREATE INDEX IF NOT EXISTS idx_suppliers_contract_status
  ON suppliers (contract_status);

CREATE INDEX IF NOT EXISTS idx_suppliers_next_review_date
  ON suppliers (next_review_date);

-- ============================================================
-- Auto-update updated_at via trigger
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS suppliers_set_updated_at ON suppliers;
CREATE TRIGGER suppliers_set_updated_at
  BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- Row Level Security (mirror the pattern used across Bop tables)
-- ============================================================
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;

-- Drop existing policies first so the script is re-runnable
DROP POLICY IF EXISTS "suppliers_org_isolation" ON suppliers;

-- Users can only see / modify rows that belong to their organisation.
-- Bop sets the GUC "app.current_org_id" on every connection via the
-- requireOrgContext middleware, so we read it here.
CREATE POLICY "suppliers_org_isolation" ON suppliers
  USING (organization_id = current_setting('app.current_org_id', true)::INTEGER)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::INTEGER);
