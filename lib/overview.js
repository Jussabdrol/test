function registerOverview(app, db, requireOrgContext) {
  app.get('/api/compliance-overview', requireOrgContext, async (req, res) => {
    const oid = req.orgId;
    // These are operational attention signals, not a compliance certification score.
    const definitions = [
      ['task', 'Tasks', 'tasks', "is_active = 1 AND NOT EXISTS (SELECT 1 FROM task_instances ti WHERE ti.task_id=tasks.id AND ti.scheduled_date=tasks.next_due AND ti.organization_id=tasks.organization_id)", "next_due < CURRENT_DATE::text", 'title', 'assignee', 'next_due'],
      ['instance', 'Task executions', 'task_instances', "status = 'pending'", "scheduled_date < CURRENT_DATE::text", "'Task execution #' || id", "''", 'scheduled_date'],
      ['usecase', 'AI use cases', 'use_cases', "status = 'production'", "next_review_date < CURRENT_DATE", 'title', "''", 'next_review_date::text'],
      ['action', 'Actions', 'actions', "status IN ('open','in_progress')", "due_date < CURRENT_DATE::text", 'title', 'assignee', 'due_date'],
      ['audit', 'Audits', 'audits', "status IN ('planned','in_progress')", "planned_date < CURRENT_DATE::text", 'title', 'lead_auditor', 'planned_date'],
      ['ncr', 'Non-conformities', 'non_conformities', "status NOT IN ('closed','verified')", "due_date < CURRENT_DATE::text", 'description', 'responsible', 'due_date'],
      ['risk', 'Risks', 'risks', "status NOT IN ('accepted','closed')", 'likelihood * impact >= 15', 'title', 'risk_owner', 'NULL::text'],
      ['treatment', 'Treatments', 'risk_treatments', "status IN ('planned','in_progress')", "due_date < CURRENT_DATE::text", 'description', 'responsible', 'due_date'],
      ['document', 'Documents', 'documents', "status <> 'obsolete'", "review_date < CURRENT_DATE::text", 'title', 'owner', 'review_date'],
      ['supplier', 'Suppliers', 'suppliers', "status = 'active'", '(next_review_date < CURRENT_DATE OR contract_expiry_date < CURRENT_DATE)', 'name', "''", 'COALESCE(LEAST(next_review_date, contract_expiry_date)::text, next_review_date::text)'],
      ['management_review', 'Management reviews', 'management_reviews', "status <> 'completed'", "review_date < CURRENT_DATE::text", 'title', 'chairperson', 'review_date'],
      ['review_output', 'Review decisions', 'management_review_outputs', "status <> 'completed'", "due_date < CURRENT_DATE::text AND linked_action_id IS NULL", 'description', 'assigned_to', 'due_date'],
      ['threat', 'Threat intelligence', 'threat_items', "status = 'new'", 'TRUE', 'title', "''", 'NULL::text'],
    ];
    const modules = []; const attention = [];
    for (const [type,label,table,active,needsAttention,title,owner,date] of definitions) {
      const counts = await db.get(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ${active})::int AS active,
        COUNT(*) FILTER (WHERE (${active}) AND (${needsAttention}))::int AS attention FROM ${table} WHERE organization_id = ?`, oid);
      modules.push({ type, label, ...counts });
      const rows = await db.all(`SELECT id, ${title} AS title, ${owner} AS owner, ${date} AS due_date FROM ${table}
        WHERE organization_id = ? AND (${active}) AND (${needsAttention}) ORDER BY ${date} NULLS LAST, id LIMIT 50`, oid);
      attention.push(...rows.map(row => ({ ...row, type, label, reason: type === 'risk' ? 'High risk' : type === 'threat' ? 'Needs triage' : 'Overdue', priority: type === 'risk' ? 1 : 2 })));
    }
    for (const [type,label,table] of [['requirement','Requirements','standard_requirements'],['kpi','KPIs','org_kpis'],['process','Processes','org_architecture'],['soa','Statement of applicability','soa_entries']]) {
      const filter = type === 'process' ? " AND arch_type = 'process'" : '';
      const counts = await db.get(`SELECT COUNT(*)::int AS total FROM ${table} WHERE organization_id = ?${filter}`, oid);
      modules.push({ type,label,...counts,active: counts.total,attention: 0 });
    }
    attention.sort((a,b) => a.priority-b.priority || (a.due_date || '9999').localeCompare(b.due_date || '9999'));
    res.json({ as_of: new Date().toISOString(), modules, attention, attention_total: modules.reduce((sum,m) => sum+m.attention,0), per_module_limit: 50 });
  });
}
module.exports = { registerOverview };
