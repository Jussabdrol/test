-- =============================================================================
-- Performance indexes for all tables
-- Safe to run multiple times (uses IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)
-- Covers: foreign keys, organization_id tenant columns, status/filter columns,
--         and columns commonly used in WHERE/ORDER BY/GROUP BY clauses.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_organizations_slug
  ON organizations (slug);
CREATE INDEX IF NOT EXISTS idx_organizations_is_active
  ON organizations (is_active);

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_tasks_organization_id
  ON tasks (organization_id);
CREATE INDEX IF NOT EXISTS idx_tasks_org_active
  ON tasks (organization_id, is_active);
CREATE INDEX IF NOT EXISTS idx_tasks_org_active_next_due
  ON tasks (organization_id, is_active, next_due);
CREATE INDEX IF NOT EXISTS idx_tasks_org_active_category
  ON tasks (organization_id, is_active, category);
CREATE INDEX IF NOT EXISTS idx_tasks_org_active_priority
  ON tasks (organization_id, is_active, priority);
CREATE INDEX IF NOT EXISTS idx_tasks_org_active_assignee
  ON tasks (organization_id, is_active, assignee);
CREATE INDEX IF NOT EXISTS idx_tasks_next_due
  ON tasks (next_due);

-- ---------------------------------------------------------------------------
-- completions
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_completions_organization_id
  ON completions (organization_id);
CREATE INDEX IF NOT EXISTS idx_completions_task_id
  ON completions (task_id);
CREATE INDEX IF NOT EXISTS idx_completions_org_completed_at
  ON completions (organization_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_completions_org_task
  ON completions (organization_id, task_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_completions_completed_by
  ON completions (completed_by);

-- ---------------------------------------------------------------------------
-- actions
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_actions_organization_id
  ON actions (organization_id);
CREATE INDEX IF NOT EXISTS idx_actions_completion_id
  ON actions (completion_id);
CREATE INDEX IF NOT EXISTS idx_actions_task_id
  ON actions (task_id);
CREATE INDEX IF NOT EXISTS idx_actions_org_status
  ON actions (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_actions_org_status_due
  ON actions (organization_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_actions_created_at
  ON actions (created_at);

-- ---------------------------------------------------------------------------
-- audits
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audits_organization_id
  ON audits (organization_id);
CREATE INDEX IF NOT EXISTS idx_audits_org_status
  ON audits (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_audits_parent_audit_id
  ON audits (parent_audit_id);
CREATE INDEX IF NOT EXISTS idx_audits_planned_date
  ON audits (planned_date);

-- ---------------------------------------------------------------------------
-- audit_checklist
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audit_checklist_organization_id
  ON audit_checklist (organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_checklist_audit_id
  ON audit_checklist (audit_id);
CREATE INDEX IF NOT EXISTS idx_audit_checklist_audit_sort
  ON audit_checklist (audit_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_audit_checklist_rating
  ON audit_checklist (audit_id, rating);
CREATE INDEX IF NOT EXISTS idx_audit_checklist_clause_standard
  ON audit_checklist (clause, standard);

-- ---------------------------------------------------------------------------
-- non_conformities
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ncrs_organization_id
  ON non_conformities (organization_id);
CREATE INDEX IF NOT EXISTS idx_ncrs_audit_id
  ON non_conformities (audit_id);
CREATE INDEX IF NOT EXISTS idx_ncrs_checklist_item_id
  ON non_conformities (checklist_item_id);
CREATE INDEX IF NOT EXISTS idx_ncrs_org_status
  ON non_conformities (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_ncrs_clause
  ON non_conformities (clause);

-- ---------------------------------------------------------------------------
-- standard_requirements
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_standard_requirements_organization_id
  ON standard_requirements (organization_id);
CREATE INDEX IF NOT EXISTS idx_standard_requirements_org_standard
  ON standard_requirements (organization_id, standard);
CREATE INDEX IF NOT EXISTS idx_standard_requirements_org_standard_sort
  ON standard_requirements (organization_id, standard, sort_order, clause);

-- ---------------------------------------------------------------------------
-- risks
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_risks_organization_id
  ON risks (organization_id);
CREATE INDEX IF NOT EXISTS idx_risks_org_status
  ON risks (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_risks_inherent_score
  ON risks (organization_id, inherent_score);

-- ---------------------------------------------------------------------------
-- risk_treatments
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_risk_treatments_organization_id
  ON risk_treatments (organization_id);
CREATE INDEX IF NOT EXISTS idx_risk_treatments_risk_id
  ON risk_treatments (risk_id);
CREATE INDEX IF NOT EXISTS idx_risk_treatments_requirement_id
  ON risk_treatments (requirement_id);
CREATE INDEX IF NOT EXISTS idx_risk_treatments_org_status
  ON risk_treatments (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_risk_treatments_control_reference
  ON risk_treatments (control_reference);

-- ---------------------------------------------------------------------------
-- soa_entries
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_soa_entries_organization_id
  ON soa_entries (organization_id);
CREATE INDEX IF NOT EXISTS idx_soa_entries_requirement_id
  ON soa_entries (requirement_id);
CREATE INDEX IF NOT EXISTS idx_soa_entries_org_implementation
  ON soa_entries (organization_id, implementation_status);

-- ---------------------------------------------------------------------------
-- org_mission
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_org_mission_organization_id
  ON org_mission (organization_id);

-- ---------------------------------------------------------------------------
-- org_kpis
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_org_kpis_organization_id
  ON org_kpis (organization_id);
CREATE INDEX IF NOT EXISTS idx_org_kpis_org_module
  ON org_kpis (organization_id, module);

-- ---------------------------------------------------------------------------
-- org_kpi_values
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_org_kpi_values_organization_id
  ON org_kpi_values (organization_id);
CREATE INDEX IF NOT EXISTS idx_org_kpi_values_kpi_id
  ON org_kpi_values (kpi_id);
CREATE INDEX IF NOT EXISTS idx_org_kpi_values_kpi_period
  ON org_kpi_values (kpi_id, period);

-- ---------------------------------------------------------------------------
-- org_architecture
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_org_architecture_organization_id
  ON org_architecture (organization_id);
CREATE INDEX IF NOT EXISTS idx_org_architecture_org_type
  ON org_architecture (organization_id, arch_type);
CREATE INDEX IF NOT EXISTS idx_org_architecture_org_type_sort
  ON org_architecture (organization_id, arch_type, sort_order, name);
CREATE INDEX IF NOT EXISTS idx_org_architecture_parent_id
  ON org_architecture (parent_id);

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_documents_organization_id
  ON documents (organization_id);
CREATE INDEX IF NOT EXISTS idx_documents_org_doc_type
  ON documents (organization_id, doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_org_status
  ON documents (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_documents_org_review_date
  ON documents (organization_id, review_date);
CREATE INDEX IF NOT EXISTS idx_documents_linked_ref
  ON documents (linked_ref_type, linked_ref_id);

-- ---------------------------------------------------------------------------
-- cross_links
-- ---------------------------------------------------------------------------
-- (UNIQUE constraint already covers org + source + target composite lookup)
CREATE INDEX IF NOT EXISTS idx_cross_links_organization_id
  ON cross_links (organization_id);
CREATE INDEX IF NOT EXISTS idx_cross_links_source
  ON cross_links (organization_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_cross_links_target
  ON cross_links (organization_id, target_type, target_id);

-- ---------------------------------------------------------------------------
-- threat_feeds
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_threat_feeds_organization_id
  ON threat_feeds (organization_id);
CREATE INDEX IF NOT EXISTS idx_threat_feeds_org_tier
  ON threat_feeds (organization_id, tier);

-- ---------------------------------------------------------------------------
-- threat_items
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_threat_items_organization_id
  ON threat_items (organization_id);
CREATE INDEX IF NOT EXISTS idx_threat_items_feed_id
  ON threat_items (feed_id);
CREATE INDEX IF NOT EXISTS idx_threat_items_org_status
  ON threat_items (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_threat_items_feed_status
  ON threat_items (feed_id, status);
-- (UNIQUE constraint on feed_id, guid already covers that lookup)

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_users_organization_id
  ON users (organization_id);
CREATE INDEX IF NOT EXISTS idx_users_email
  ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_org_role
  ON users (organization_id, role);
CREATE INDEX IF NOT EXISTS idx_users_org_status
  ON users (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_users_supabase_uid
  ON users (supabase_uid);

-- ---------------------------------------------------------------------------
-- system_settings
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_system_settings_organization_id
  ON system_settings (organization_id);

-- ---------------------------------------------------------------------------
-- admin_audit_log
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_organization_id
  ON admin_audit_log (organization_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_org_created_at
  ON admin_audit_log (organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_user_id
  ON admin_audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action
  ON admin_audit_log (action);

-- ---------------------------------------------------------------------------
-- api_keys
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_api_keys_organization_id
  ON api_keys (organization_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash
  ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_org_status
  ON api_keys (organization_id, status);

-- ---------------------------------------------------------------------------
-- webhooks
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_webhooks_organization_id
  ON webhooks (organization_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_org_status
  ON webhooks (organization_id, status);

-- ---------------------------------------------------------------------------
-- backups
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_backups_organization_id
  ON backups (organization_id);
CREATE INDEX IF NOT EXISTS idx_backups_org_status
  ON backups (organization_id, status);

-- ---------------------------------------------------------------------------
-- saml_config
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_saml_config_organization_id
  ON saml_config (organization_id);

-- ---------------------------------------------------------------------------
-- saml_sessions
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_saml_sessions_user_id
  ON saml_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_saml_sessions_expires_at
  ON saml_sessions (expires_at);
