-- Management Review Migration (ISO 9.3)
-- Run once against the Supabase PostgreSQL database.
-- Safe to re-run: all statements use IF NOT EXISTS / IF EXISTS guards.

-- ============================================================
-- Table: management_reviews
-- ============================================================
CREATE TABLE IF NOT EXISTS management_reviews (
  id                SERIAL PRIMARY KEY,
  organization_id   INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  review_date       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled','in_progress','completed')),
  chairperson       TEXT DEFAULT '',
  attendees         TEXT DEFAULT '[]',
  next_review_date  TEXT DEFAULT NULL,
  summary           TEXT DEFAULT '',
  report_html       TEXT DEFAULT '',
  report_doc_id     INTEGER DEFAULT NULL,
  created_at        TIMESTAMP DEFAULT NOW(),
  updated_at        TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- Table: management_review_inputs  (one row per category per review)
-- ============================================================
CREATE TABLE IF NOT EXISTS management_review_inputs (
  id              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  review_id       INTEGER NOT NULL REFERENCES management_reviews(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  content         TEXT DEFAULT '',
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE (review_id, category)
);

-- ============================================================
-- Table: management_review_outputs
-- ============================================================
CREATE TABLE IF NOT EXISTS management_review_outputs (
  id               SERIAL PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  review_id        INTEGER NOT NULL REFERENCES management_reviews(id) ON DELETE CASCADE,
  type             TEXT NOT NULL DEFAULT 'improvement'
                     CHECK (type IN ('improvement','resource','change')),
  description      TEXT NOT NULL,
  assigned_to      TEXT DEFAULT '',
  due_date         TEXT DEFAULT NULL,
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','in_progress','completed')),
  linked_action_id INTEGER DEFAULT NULL,
  created_at       TIMESTAMP DEFAULT NOW(),
  updated_at       TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_mgmt_reviews_org_id
  ON management_reviews (organization_id);

CREATE INDEX IF NOT EXISTS idx_mgmt_reviews_review_date
  ON management_reviews (review_date);

CREATE INDEX IF NOT EXISTS idx_mgmt_reviews_status
  ON management_reviews (status);

CREATE INDEX IF NOT EXISTS idx_mgmt_review_inputs_review_id
  ON management_review_inputs (review_id);

CREATE INDEX IF NOT EXISTS idx_mgmt_review_inputs_org_id
  ON management_review_inputs (organization_id);

CREATE INDEX IF NOT EXISTS idx_mgmt_review_outputs_review_id
  ON management_review_outputs (review_id);

CREATE INDEX IF NOT EXISTS idx_mgmt_review_outputs_org_id
  ON management_review_outputs (organization_id);
