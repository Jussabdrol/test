-- =============================================================================
-- Task Log Refactor Migration
-- =============================================================================
-- - Introduces task_instances: one row per scheduled occurrence of a recurring
--   task series (the "Task Log"). Replaces the previous completions model.
-- - Actions (now called "Follow-ups" in the UI) are linked to task_instances
--   via instance_id instead of completion_id.
-- - The completions table and its action FK are removed.
-- =============================================================================

-- 1. Drop the old completions FK on actions (will be replaced by instance_id)
ALTER TABLE actions DROP CONSTRAINT IF EXISTS actions_completion_id_fkey;

-- 2. Create task_instances
CREATE TABLE IF NOT EXISTS task_instances (
  id              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id         INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  scheduled_date  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','completed','skipped')),
  completed_by    TEXT DEFAULT '',
  completed_at    TIMESTAMP DEFAULT NULL,
  notes           TEXT DEFAULT '',
  evidence_files  TEXT DEFAULT '[]',
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE (task_id, scheduled_date)
);

CREATE INDEX IF NOT EXISTS idx_task_instances_org_status ON task_instances (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_task_instances_task       ON task_instances (task_id);
CREATE INDEX IF NOT EXISTS idx_task_instances_scheduled  ON task_instances (organization_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_task_instances_completed  ON task_instances (organization_id, completed_at);

-- 3. Swap actions.completion_id for actions.instance_id
ALTER TABLE actions ADD COLUMN IF NOT EXISTS instance_id INTEGER DEFAULT NULL
  REFERENCES task_instances(id) ON DELETE SET NULL;
ALTER TABLE actions DROP COLUMN IF EXISTS completion_id;
CREATE INDEX IF NOT EXISTS idx_actions_instance_id ON actions (instance_id);
DROP INDEX IF EXISTS idx_actions_completion_id;

-- 4. Remove completions
DROP TABLE IF EXISTS completions CASCADE;

-- 5. RLS policies for task_instances
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
