// Register on the shared app to retain middleware and transaction boundaries.
function registerOrganizationRoutes(app, { db, fireWebhooks, requireOrgContext }) {
  // --- Organizational Planning API ---

  // Mission
  app.get('/api/mission', requireOrgContext, async (req, res) => {
    const mission = await db.prepare('SELECT * FROM org_mission WHERE organization_id = ?').get(req.orgId);
    const org = await db.prepare('SELECT name FROM organizations WHERE id = ?').get(req.orgId);
    res.json({ ...mission, org_name: org?.name || '' });
  });

  app.put('/api/mission', requireOrgContext, async (req, res) => {
    const { content, vision, values_text, legal_entities } = req.body;
    await db.prepare("UPDATE org_mission SET content = ?, vision = ?, values_text = ?, legal_entities = ?, updated_at = datetime('now') WHERE organization_id = ?")
      .run(content || '', vision || '', values_text || '', JSON.stringify(legal_entities || []), req.orgId);
    const mission = await db.prepare('SELECT * FROM org_mission WHERE organization_id = ?').get(req.orgId);
    const org = await db.prepare('SELECT name FROM organizations WHERE id = ?').get(req.orgId);
    res.json({ ...mission, org_name: org?.name || '' });
  });

  // KPIs
  app.get('/api/kpis', requireOrgContext, async (req, res) => {
    const kpis = await db.prepare(
      `SELECT k.*, a.name AS process_name
       FROM org_kpis k
       LEFT JOIN org_architecture a ON k.process_id = a.id
       WHERE k.organization_id = ? ORDER BY a.name NULLS LAST, k.name`
    ).all(req.orgId);
    for (const k of kpis) {
      k.values = await db.prepare('SELECT * FROM org_kpi_values WHERE kpi_id = ? ORDER BY period DESC LIMIT 24').all(k.id);
    }
    res.json(kpis);
  });

  // KPIs for a specific process
  app.get('/api/architecture/:id/kpis', requireOrgContext, async (req, res) => {
    const kpis = await db.prepare(
      'SELECT * FROM org_kpis WHERE organization_id = ? AND process_id = ? ORDER BY name'
    ).all(req.orgId, req.params.id);
    for (const k of kpis) {
      k.values = await db.prepare('SELECT * FROM org_kpi_values WHERE kpi_id = ? ORDER BY period DESC LIMIT 24').all(k.id);
    }
    res.json(kpis);
  });

  // Auto-KPI data
  app.get('/api/kpis/auto', requireOrgContext, async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const oid = req.orgId;
    const auto = {
      // Task Management
      tasks_active: (await db.prepare('SELECT COUNT(*) as v FROM tasks WHERE organization_id = ? AND is_active = 1').get(oid)).v,
      tasks_overdue: (await db.prepare('SELECT COUNT(*) as v FROM tasks WHERE organization_id = ? AND is_active = 1 AND next_due < ?').get(oid, today)).v,
      completions_this_month: (await db.prepare("SELECT COUNT(*) as v FROM task_instances WHERE organization_id = ? AND status = 'completed' AND completed_at >= date('now','start of month')").get(oid)).v,
      // Audits & Compliance
      audits_planned: (await db.prepare("SELECT COUNT(*) as v FROM audits WHERE organization_id = ? AND status = 'planned'").get(oid)).v,
      audits_completed: (await db.prepare("SELECT COUNT(*) as v FROM audits WHERE organization_id = ? AND status = 'completed'").get(oid)).v,
      open_ncrs: (await db.prepare("SELECT COUNT(*) as v FROM non_conformities WHERE organization_id = ? AND status IN ('open','in_progress')").get(oid)).v,
      overdue_ncrs: (await db.prepare("SELECT COUNT(*) as v FROM non_conformities WHERE organization_id = ? AND status IN ('open','in_progress') AND due_date IS NOT NULL AND due_date::date < CURRENT_DATE").get(oid)).v,
      open_actions: (await db.prepare("SELECT COUNT(*) as v FROM actions WHERE organization_id = ? AND status IN ('open','in_progress')").get(oid)).v,
      standards_count: (await db.prepare('SELECT COUNT(DISTINCT standard) as v FROM standard_requirements WHERE organization_id = ?').get(oid)).v,
      // Risk Management
      total_risks: (await db.prepare('SELECT COUNT(*) as v FROM risks WHERE organization_id = ?').get(oid)).v,
      high_risks: (await db.prepare('SELECT COUNT(*) as v FROM risks WHERE organization_id = ? AND inherent_score >= 15').get(oid)).v,
      open_treatments: (await db.prepare("SELECT COUNT(*) as v FROM risk_treatments WHERE organization_id = ? AND status IN ('planned','in_progress')").get(oid)).v,
      // SoA counts from Annex A requirements (applicable by default unless explicitly set to 0)
      soa_applicable: (await db.prepare(`SELECT COUNT(*) as v FROM standard_requirements sr
        LEFT JOIN soa_entries soa ON sr.id = soa.requirement_id
        WHERE sr.organization_id = ? AND sr.standard = 'ISO 27001 Annex A' AND (soa.applicable IS NULL OR soa.applicable = 1)`).get(oid)).v,
      soa_implemented: (await db.prepare(`SELECT COUNT(*) as v FROM standard_requirements sr
        LEFT JOIN soa_entries soa ON sr.id = soa.requirement_id
        WHERE sr.organization_id = ? AND sr.standard = 'ISO 27001 Annex A' AND (soa.applicable IS NULL OR soa.applicable = 1) AND soa.implementation_status = 'implemented'`).get(oid)).v,
      threat_items_new: (await db.prepare("SELECT COUNT(*) as v FROM threat_items WHERE organization_id = ? AND status = 'new'").get(oid)).v,
      // Document Control
      total_documents: (await db.prepare('SELECT COUNT(*) as v FROM documents WHERE organization_id = ?').get(oid)).v,
      docs_due_review: (await db.prepare('SELECT COUNT(*) as v FROM documents WHERE organization_id = ? AND review_date IS NOT NULL AND review_date <= ?').get(oid, today)).v,
      // Architecture
      arch_processes: (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE organization_id = ? AND arch_type = 'process'").get(oid)).v,
      arch_roles: (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE organization_id = ? AND arch_type = 'role'").get(oid)).v,
      arch_systems: (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE organization_id = ? AND arch_type = 'system'").get(oid)).v,
      arch_facilities: (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE organization_id = ? AND arch_type = 'facility'").get(oid)).v,
      // AI Use Cases
      usecases_total: (await db.prepare('SELECT COUNT(*) as v FROM use_cases WHERE organization_id = ?').get(oid)).v,
      usecases_active: (await db.prepare("SELECT COUNT(*) as v FROM use_cases WHERE organization_id = ? AND status = 'production'").get(oid)).v,
      usecases_draft: (await db.prepare("SELECT COUNT(*) as v FROM use_cases WHERE organization_id = ? AND status = 'new'").get(oid)).v,
      usecases_proposed: (await db.prepare("SELECT COUNT(*) as v FROM use_cases WHERE organization_id = ? AND status IN ('assessment','approved')").get(oid)).v,
      usecases_deprecated: (await db.prepare("SELECT COUNT(*) as v FROM use_cases WHERE organization_id = ? AND status = 'retired'").get(oid)).v,
    };
    res.json(auto);
  });

  // Improvement 8: persist auto-calculated KPI values to org_kpi_values for the current period
  app.post('/api/kpis/auto/persist', requireOrgContext, async (req, res) => {
    const oid = req.orgId;
    const today = new Date();
    const monthPeriod = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const quarter = Math.ceil((today.getMonth() + 1) / 3);
    const quarterPeriod = `${today.getFullYear()}-Q${quarter}`;

    const autoKpis = await db.prepare(
      "SELECT * FROM org_kpis WHERE organization_id = ? AND is_auto = 1 AND auto_source != ''"
    ).all(oid);
    if (autoKpis.length === 0) return res.json({ persisted: 0, period: monthPeriod });

    const today_str = today.toISOString().split('T')[0];
    const auto = {
      tasks_active:           (await db.prepare('SELECT COUNT(*) as v FROM tasks WHERE organization_id = ? AND is_active = 1').get(oid)).v,
      tasks_overdue:          (await db.prepare('SELECT COUNT(*) as v FROM tasks WHERE organization_id = ? AND is_active = 1 AND next_due < ?').get(oid, today_str)).v,
      completions_this_month: (await db.prepare("SELECT COUNT(*) as v FROM task_instances WHERE organization_id = ? AND status = 'completed' AND completed_at >= date('now','start of month')").get(oid)).v,
      audits_planned:         (await db.prepare("SELECT COUNT(*) as v FROM audits WHERE organization_id = ? AND status = 'planned'").get(oid)).v,
      audits_completed:       (await db.prepare("SELECT COUNT(*) as v FROM audits WHERE organization_id = ? AND status = 'completed'").get(oid)).v,
      open_ncrs:              (await db.prepare("SELECT COUNT(*) as v FROM non_conformities WHERE organization_id = ? AND status IN ('open','in_progress')").get(oid)).v,
      open_actions:           (await db.prepare("SELECT COUNT(*) as v FROM actions WHERE organization_id = ? AND status IN ('open','in_progress')").get(oid)).v,
      total_risks:            (await db.prepare('SELECT COUNT(*) as v FROM risks WHERE organization_id = ?').get(oid)).v,
      high_risks:             (await db.prepare('SELECT COUNT(*) as v FROM risks WHERE organization_id = ? AND inherent_score >= 15').get(oid)).v,
      open_treatments:        (await db.prepare("SELECT COUNT(*) as v FROM risk_treatments WHERE organization_id = ? AND status IN ('planned','in_progress')").get(oid)).v,
      soa_applicable:         (await db.prepare(`SELECT COUNT(*) as v FROM standard_requirements sr LEFT JOIN soa_entries soa ON sr.id = soa.requirement_id WHERE sr.organization_id = ? AND sr.standard = 'ISO 27001 Annex A' AND (soa.applicable IS NULL OR soa.applicable = 1)`).get(oid)).v,
      soa_implemented:        (await db.prepare(`SELECT COUNT(*) as v FROM standard_requirements sr LEFT JOIN soa_entries soa ON sr.id = soa.requirement_id WHERE sr.organization_id = ? AND sr.standard = 'ISO 27001 Annex A' AND (soa.applicable IS NULL OR soa.applicable = 1) AND soa.implementation_status = 'implemented'`).get(oid)).v,
      threat_items_new:       (await db.prepare("SELECT COUNT(*) as v FROM threat_items WHERE organization_id = ? AND status = 'new'").get(oid)).v,
      total_documents:        (await db.prepare('SELECT COUNT(*) as v FROM documents WHERE organization_id = ?').get(oid)).v,
      docs_due_review:        (await db.prepare('SELECT COUNT(*) as v FROM documents WHERE organization_id = ? AND review_date IS NOT NULL AND review_date <= ?').get(oid, today_str)).v,
      arch_processes:         (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE organization_id = ? AND arch_type = 'process'").get(oid)).v,
      arch_roles:             (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE organization_id = ? AND arch_type = 'role'").get(oid)).v,
      arch_systems:           (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE organization_id = ? AND arch_type = 'system'").get(oid)).v,
      arch_facilities:        (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE organization_id = ? AND arch_type = 'facility'").get(oid)).v,
      usecases_total:         (await db.prepare('SELECT COUNT(*) as v FROM use_cases WHERE organization_id = ?').get(oid)).v,
      usecases_active:        (await db.prepare("SELECT COUNT(*) as v FROM use_cases WHERE organization_id = ? AND status = 'production'").get(oid)).v,
    };
    auto.soa_coverage_pct = auto.soa_applicable > 0 ? Math.round((auto.soa_implemented / auto.soa_applicable) * 100) : 0;
    auto.task_completion_rate = auto.tasks_active > 0 ? Math.round((auto.completions_this_month / auto.tasks_active) * 100) : 0;

    let persisted = 0;
    for (const kpi of autoKpis) {
      const rawValue = auto[kpi.auto_source];
      if (rawValue === undefined) continue;
      const period = (kpi.frequency === 'quarterly') ? quarterPeriod : monthPeriod;
      const existing = await db.prepare(
        'SELECT id FROM org_kpi_values WHERE kpi_id = ? AND period = ? AND organization_id = ?'
      ).get(kpi.id, period, oid);
      if (existing) {
        await db.prepare("UPDATE org_kpi_values SET value = ?, recorded_at = NOW() WHERE id = ? AND organization_id = ?").run(rawValue, existing.id, oid);
      } else {
        await db.prepare('INSERT INTO org_kpi_values (organization_id, kpi_id, value, period) VALUES (?, ?, ?, ?)').run(oid, kpi.id, rawValue, period);
      }
      persisted++;
    }
    res.json({ persisted, period: monthPeriod });
  });

  app.post('/api/kpis', requireOrgContext, async (req, res) => {
    const { name, description, module, process_id, target_value, unit, frequency } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const result = await db.prepare(
      'INSERT INTO org_kpis (organization_id, name, description, module, process_id, target_value, unit, frequency) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(req.orgId, name, description || '', module || 'custom', process_id || null, target_value ?? null, unit || '', frequency || 'monthly');
    res.status(201).json(await db.prepare('SELECT * FROM org_kpis WHERE id = ?').get(result.lastInsertRowid));
  });

  app.put('/api/kpis/:id', requireOrgContext, async (req, res) => {
    const fields = ['name', 'description', 'module', 'process_id', 'target_value', 'unit', 'frequency'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.params.id);
    await db.prepare(`UPDATE org_kpis SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
    res.json(await db.prepare('SELECT * FROM org_kpis WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
  });

  app.delete('/api/kpis/:id', requireOrgContext, async (req, res) => {
    await db.prepare('DELETE FROM org_kpis WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
    res.json({ success: true });
  });

  app.post('/api/kpis/:id/values', requireOrgContext, async (req, res) => {
    const { value, period } = req.body;
    if (value === undefined || !period) return res.status(400).json({ error: 'value and period are required' });
    // Upsert by period
    const existing = await db.prepare('SELECT * FROM org_kpi_values WHERE kpi_id = ? AND period = ? AND organization_id = ?').get(req.params.id, period, req.orgId);
    if (existing) {
      await db.prepare("UPDATE org_kpi_values SET value = ?, recorded_at = datetime('now') WHERE id = ? AND organization_id = ?").run(value, existing.id, req.orgId);
    } else {
      await db.prepare('INSERT INTO org_kpi_values (organization_id, kpi_id, value, period) VALUES (?, ?, ?, ?)').run(req.orgId, req.params.id, value, period);
    }
    res.json({ success: true });
  });

  app.delete('/api/kpis/:id/values/:valueId', requireOrgContext, async (req, res) => {
    await db.prepare(
      'DELETE FROM org_kpi_values WHERE id = ? AND kpi_id = ? AND organization_id = ?'
    ).run(req.params.valueId, req.params.id, req.orgId);
    res.json({ success: true });
  });

  // AI Use Cases – Kanban board management
  const UC_FIELDS = [
    'title','description','category','business_domain','ai_approach','risk_tier','human_oversight',
    'priority','status','business_value','success_kpis','fallback_process','retirement_reason',
    'target_go_live','go_live_date','next_review_date','performance_notes','incident_reporting',
    'owner_id','implementation_owner_id','approved_by_id','approval_date','sort_order'
  ];

  async function fetchUseCaseWithUsers(db, id) {
    return await db.prepare(`
      SELECT uc.*,
        o.name  AS owner_name,  o.email  AS owner_email,
        io.name AS implementation_owner_name, io.email AS implementation_owner_email,
        ab.name AS approved_by_name
      FROM use_cases uc
      LEFT JOIN users o  ON uc.owner_id = o.id
      LEFT JOIN users io ON uc.implementation_owner_id = io.id
      LEFT JOIN users ab ON uc.approved_by_id = ab.id
      WHERE uc.id = ?
    `).get(id);
  }

  app.get('/api/use-cases', requireOrgContext, async (req, res) => {
    const { status, priority, category, domain } = req.query;
    let sql = `
      SELECT uc.*,
        o.name  AS owner_name,
        io.name AS implementation_owner_name,
        ab.name AS approved_by_name
      FROM use_cases uc
      LEFT JOIN users o  ON uc.owner_id = o.id
      LEFT JOIN users io ON uc.implementation_owner_id = io.id
      LEFT JOIN users ab ON uc.approved_by_id = ab.id
      WHERE uc.organization_id = ?`;
    const params = [req.orgId];
    if (status)   { sql += ' AND uc.status = ?';          params.push(status); }
    if (priority) { sql += ' AND uc.priority = ?';        params.push(priority); }
    if (category) { sql += ' AND uc.category = ?';        params.push(category); }
    if (domain)   { sql += ' AND uc.business_domain = ?'; params.push(domain); }
    sql += ' ORDER BY uc.sort_order, uc.created_at DESC';
    res.json(await db.prepare(sql).all(...params));
  });

  app.get('/api/use-cases/:id', requireOrgContext, async (req, res) => {
    const uc = await fetchUseCaseWithUsers(db, req.params.id);
    if (!uc || uc.organization_id !== req.orgId) return res.status(404).json({ error: 'Not found' });
    res.json(uc);
  });

  app.post('/api/use-cases', requireOrgContext, async (req, res) => {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const cols = ['organization_id', 'title'];
    const vals = [req.orgId, title];
    for (const f of UC_FIELDS) {
      if (f !== 'title' && req.body[f] !== undefined) { cols.push(f); vals.push(req.body[f]); }
    }
    const ph = vals.map(() => '?').join(', ');
    const result = await db.prepare(`INSERT INTO use_cases (${cols.join(', ')}) VALUES (${ph})`).run(...vals);
    const createdUc = await fetchUseCaseWithUsers(db, result.lastInsertRowid);
    fireWebhooks(req.orgId, 'usecase_created', {
      id: createdUc.id, title: createdUc.title, category: createdUc.category,
      business_domain: createdUc.business_domain, priority: createdUc.priority,
      owner: createdUc.owner_name || null,
    });
    res.status(201).json(createdUc);
  });

  app.put('/api/use-cases/:id', requireOrgContext, async (req, res) => {
    const existing = await db.prepare('SELECT id FROM use_cases WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const updates = [];
    const params = [];
    for (const f of UC_FIELDS) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f] === '' ? null : req.body[f]); }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    updates.push("updated_at = NOW()");
    params.push(req.params.id, req.orgId);
    await db.prepare(`UPDATE use_cases SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params);
    res.json(await fetchUseCaseWithUsers(db, req.params.id));
  });

  // Stage transition with gate validation
  app.put('/api/use-cases/:id/stage', requireOrgContext, async (req, res) => {
    const { status: targetStage } = req.body;
    const validStages = ['new','assessment','approved','development','production','retired'];
    if (!validStages.includes(targetStage)) return res.status(400).json({ error: 'Invalid stage' });
    const uc = await db.prepare('SELECT * FROM use_cases WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!uc) return res.status(404).json({ error: 'Not found' });
    // Gate checks
    if (targetStage === 'approved') {
      if (!uc.approved_by_id || !uc.approval_date) {
        return res.status(422).json({ error: 'Set Approved By and Approval Date before moving to Approved.' });
      }
    }
    if (targetStage === 'development') {
      if (!uc.implementation_owner_id) {
        return res.status(422).json({ error: 'Assign an Implementation Owner before starting Development.' });
      }
    }
    if (targetStage === 'production') {
      if (!uc.go_live_date) {
        return res.status(422).json({ error: 'Set a Go-Live Date before moving to Production.' });
      }
    }
    await db.prepare("UPDATE use_cases SET status = ?, updated_at = NOW() WHERE id = ? AND organization_id = ?").run(targetStage, req.params.id, req.orgId);
    const movedUc = await fetchUseCaseWithUsers(db, req.params.id);
    fireWebhooks(req.orgId, 'usecase_stage_changed', {
      id: movedUc.id, title: movedUc.title, category: movedUc.category,
      previous_stage: uc.status, new_stage: targetStage,
      business_domain: movedUc.business_domain, priority: movedUc.priority,
      owner: movedUc.owner_name || null,
    });
    res.json(movedUc);
  });

  app.delete('/api/use-cases/:id', requireOrgContext, async (req, res) => {
    await db.prepare('DELETE FROM use_cases WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
    res.json({ success: true });
  });

  // Use case team members
  app.get('/api/use-cases/:id/members', requireOrgContext, async (req, res) => {
    const members = await db.prepare(`
      SELECT ucm.id, ucm.user_id, u.name, u.email, u.department
      FROM use_case_members ucm JOIN users u ON ucm.user_id = u.id
      WHERE ucm.use_case_id = ?
      ORDER BY u.name
    `).all(req.params.id);
    res.json(members);
  });

  app.post('/api/use-cases/:id/members', requireOrgContext, async (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    try {
      await db.prepare('INSERT INTO use_case_members (use_case_id, user_id) VALUES (?, ?)').run(req.params.id, user_id);
    } catch (e) { /* already exists – ignore */ }
    res.json(await db.prepare(`
      SELECT ucm.id, ucm.user_id, u.name, u.email FROM use_case_members ucm JOIN users u ON ucm.user_id = u.id WHERE ucm.use_case_id = ? ORDER BY u.name
    `).all(req.params.id));
  });

  app.delete('/api/use-cases/:id/members/:userId', requireOrgContext, async (req, res) => {
    await db.prepare('DELETE FROM use_case_members WHERE use_case_id = ? AND user_id = ?').run(req.params.id, req.params.userId);
    res.json({ success: true });
  });

  // Use case approval history
  app.get('/api/use-cases/:id/approvals', requireOrgContext, async (req, res) => {
    const approvals = await db.prepare(`
      SELECT ua.*, u.name AS approver_name
      FROM use_case_approvals ua LEFT JOIN users u ON ua.approved_by_id = u.id
      WHERE ua.use_case_id = ? ORDER BY ua.created_at DESC
    `).all(req.params.id);
    res.json(approvals);
  });

  app.post('/api/use-cases/:id/approvals', requireOrgContext, async (req, res) => {
    const { approved_by_id, decision, notes } = req.body;
    if (!decision) return res.status(400).json({ error: 'decision required' });
    const result = await db.prepare(
      'INSERT INTO use_case_approvals (use_case_id, organization_id, approved_by_id, decision, notes) VALUES (?, ?, ?, ?, ?)'
    ).run(req.params.id, req.orgId, approved_by_id || null, decision, notes || '');
    res.status(201).json(await db.prepare('SELECT ua.*, u.name AS approver_name FROM use_case_approvals ua LEFT JOIN users u ON ua.approved_by_id = u.id WHERE ua.id = ?').get(result.lastInsertRowid));
  });

  // Architecture
  // ---------------------------------------------------------------------------
  // Architecture – helpers for ai_usecase single-source-of-truth in use_cases
  // ---------------------------------------------------------------------------
  const UC_STATUS_TO_APPROVAL = { new: 'Not started', assessment: 'Pending', approved: 'Approved', development: 'Approved', production: 'Approved', retired: 'Rejected' };
  const UC_APPROVAL_TO_STATUS = { 'Not started': 'new', 'Pending': 'assessment', 'Approved': 'approved', 'Rejected': 'retired' };

  function mapUcToArch(uc) {
    return {
      id: uc.id,
      organization_id: uc.organization_id,
      arch_type: 'ai_usecase',
      name: uc.title,
      description: uc.description || '',
      owner: uc.owner_name || '',
      status: uc.status,
      metadata: JSON.stringify({
        domain:               uc.business_domain   || '',
        ai_approach:          uc.ai_approach        || '',
        risk_tier:            uc.risk_tier          || '',
        human_oversight:      uc.human_oversight    || '',
        governance_approval:  UC_STATUS_TO_APPROVAL[uc.status] || 'Not started',
        incident_reporting:   uc.incident_reporting ? 'Yes' : 'No',
        approval_date:        uc.approval_date      || '',
        next_review_date:     uc.next_review_date   || '',
        business_value:       uc.business_value     || '',
        success_kpis:         uc.success_kpis       || '',
        fallback_process:     uc.fallback_process   || '',
      }),
      sort_order: uc.sort_order || 0,
      created_at: uc.created_at,
      updated_at: uc.updated_at,
    };
  }

  function mapArchBodyToUcFields(body) {
    const meta = typeof body.metadata === 'string' ? JSON.parse(body.metadata || '{}') : (body.metadata || {});
    const fields = {
      title:            body.name,
      description:      body.description || '',
      business_domain:  meta.domain         || '',
      ai_approach:      meta.ai_approach    || '',
      risk_tier:        meta.risk_tier      || '',
      human_oversight:  meta.human_oversight || '',
      incident_reporting: meta.incident_reporting === 'Yes' ? 1 : 0,
      approval_date:    meta.approval_date    || null,
      next_review_date: meta.next_review_date || null,
      business_value:   meta.business_value   || '',
      success_kpis:     meta.success_kpis     || '',
      fallback_process: meta.fallback_process || '',
    };
    if (meta.governance_approval && UC_APPROVAL_TO_STATUS[meta.governance_approval]) {
      fields.status = UC_APPROVAL_TO_STATUS[meta.governance_approval];
    }
    return fields;
  }

  // ---------------------------------------------------------------------------

  app.get('/api/architecture', requireOrgContext, async (req, res) => {
    const { arch_type } = req.query;

    // ai_usecase items are stored in use_cases (single source of truth)
    if (arch_type === 'ai_usecase') {
      const cases = await db.prepare(`
        SELECT uc.*, u.name AS owner_name
        FROM use_cases uc
        LEFT JOIN users u ON uc.owner_id = u.id
        WHERE uc.organization_id = ?
        ORDER BY uc.sort_order, uc.title
      `).all(req.orgId);
      return res.json(cases.map(mapUcToArch));
    }

    let sql = 'SELECT * FROM org_architecture WHERE organization_id = ?';
    const params = [req.orgId];
    if (arch_type) { sql += ' AND arch_type = ?'; params.push(arch_type); }
    sql += ' ORDER BY arch_type, sort_order, name';
    res.json(await db.prepare(sql).all(...params));
  });

  app.post('/api/architecture', requireOrgContext, async (req, res) => {
    const { arch_type, name, description, parent_id, owner, status, metadata } = req.body;
    if (!arch_type || !name) return res.status(400).json({ error: 'arch_type and name are required' });

    // ai_usecase items are created in use_cases table
    if (arch_type === 'ai_usecase') {
      const fields = mapArchBodyToUcFields(req.body);
      const cols = ['organization_id', ...Object.keys(fields)];
      const vals = [req.orgId, ...Object.values(fields)];
      const ph   = vals.map(() => '?').join(', ');
      const result = await db.prepare(`INSERT INTO use_cases (${cols.join(', ')}) VALUES (${ph})`).run(...vals);
      const uc = await fetchUseCaseWithUsers(db, result.lastInsertRowid);
      return res.status(201).json(mapUcToArch(uc));
    }

    const result = await db.prepare('INSERT INTO org_architecture (organization_id, arch_type, name, description, parent_id, owner, status, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      req.orgId, arch_type, name, description || '', parent_id || null, owner || '', status || 'active', metadata || '{}'
    );
    res.status(201).json(await db.prepare('SELECT * FROM org_architecture WHERE id = ?').get(result.lastInsertRowid));
  });

  app.put('/api/architecture/:id', requireOrgContext, async (req, res) => {
    // ai_usecase items are updated in use_cases table
    if (req.body.arch_type === 'ai_usecase') {
      const uc = await db.prepare('SELECT id FROM use_cases WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
      if (!uc) return res.status(404).json({ error: 'Use case not found' });
      const fields = mapArchBodyToUcFields(req.body);
      const setClauses = Object.keys(fields).map(k => `${k} = ?`).concat('updated_at = NOW()');
      const vals = [...Object.values(fields), req.params.id, req.orgId];
      await db.prepare(`UPDATE use_cases SET ${setClauses.join(', ')} WHERE id = ? AND organization_id = ?`).run(...vals);
      const updated = await fetchUseCaseWithUsers(db, req.params.id);
      return res.json(mapUcToArch(updated));
    }

    // Improvement 2: snapshot current state before overwriting (architecture version history)
    const current = await db.prepare('SELECT * FROM org_architecture WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!current) return res.status(404).json({ error: 'Architecture element not found' });

    const fields = ['name', 'description', 'parent_id', 'owner', 'status', 'metadata', 'sort_order', 'flowchart'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);

    if (current.arch_type === 'process' && req.body.name && req.body.name !== current.name) {
      const ambiguous = await db.get("SELECT id FROM org_architecture WHERE organization_id=? AND arch_type='process' AND id<>? AND name IN (?,?)", req.orgId, current.id, current.name, req.body.name);
      if (ambiguous) return res.status(409).json({ error: 'Process names must be unique before renaming linked planning work.' });
      await db.run('UPDATE tasks SET category=?, updated_at=NOW() WHERE organization_id=? AND category=?', req.body.name, req.orgId, current.name);
    }

    // Determine next version number and save snapshot
    const lastVer = await db.prepare('SELECT MAX(version_number) as v FROM org_architecture_versions WHERE arch_id = ?').get(req.params.id);
    const nextVersion = (lastVer?.v || 0) + 1;
    await db.prepare(`
      INSERT INTO org_architecture_versions
        (arch_id, organization_id, changed_by_user_id, change_reason,
         arch_type, name, description, parent_id, owner, status, metadata, sort_order, version_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      current.id, req.orgId, req.session.userId, req.body.change_reason || '',
      current.arch_type, current.name, current.description, current.parent_id,
      current.owner, current.status, current.metadata, current.sort_order, nextVersion
    );

    await db.prepare(`UPDATE org_architecture SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
    res.json(await db.prepare('SELECT * FROM org_architecture WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
  });

  // Improvement 2: version history for an architecture element
  app.get('/api/architecture/:id/versions', requireOrgContext, async (req, res) => {
    const versions = await db.prepare(`
      SELECT v.*, u.name as changed_by_name
      FROM org_architecture_versions v
      LEFT JOIN users u ON u.id = v.changed_by_user_id
      WHERE v.arch_id = ? AND v.organization_id = ?
      ORDER BY v.version_number DESC
    `).all(req.params.id, req.orgId);
    res.json(versions);
  });

  app.delete('/api/architecture/:id', requireOrgContext, async (req, res) => {
    // Try org_architecture first; if nothing deleted, try use_cases (ai_usecase items live there)
    const archResult = await db.prepare('DELETE FROM org_architecture WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
    if (!archResult.changes) {
      await db.prepare('DELETE FROM use_cases WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
    }
    res.json({ success: true });
  });

  // Org users list – accessible to all authenticated org members (user pickers, role assignment)
  app.get('/api/org-users', requireOrgContext, async (req, res) => {
    const users = await db.prepare(
      "SELECT id, name, email, role, department FROM users WHERE organization_id = ? AND status = 'active' AND role != 'superadmin' ORDER BY name"
    ).all(req.orgId);
    res.json(users);
  });

  // My Tasks – aggregates tasks, actions, and NCRs assigned to the current user
  app.get('/api/my-tasks', requireOrgContext, async (req, res) => {
    const userId = req.session.userId;
    const user = await db.prepare('SELECT name, email FROM users WHERE id = ?').get(userId);
    if (!user) return res.json({ tasks: [], actions: [], ncrs: [], audits: [], treatments: [], assignedRoles: [] });

    // --- Resolve roles assigned to this user ---
    const allRoles = await db.prepare(
      "SELECT name, metadata FROM org_architecture WHERE organization_id = ? AND arch_type = 'role'"
    ).all(req.orgId);

    const assignedRoles = allRoles
      .filter(r => {
        try {
          return String(JSON.parse(r.metadata || '{}').assigned_user_id) === String(userId);
        } catch { return false; }
      })
      .map(r => r.name);

    // Full set of identifiers: user's own name/email + every role they hold
    const matches = [...new Set([user.name, user.email, ...assignedRoles].filter(Boolean))];
    const ph = matches.map(() => '?').join(', '); // reusable placeholders

    // --- Recurring Tasks ---
    const tasks = req.canAccessEntity('task') ? await db.prepare(
      `SELECT * FROM tasks WHERE organization_id = ? AND is_active = 1 AND assignee IN (${ph}) ORDER BY next_due ASC`
    ).all(req.orgId, ...matches) : [];

    // --- Follow-up Actions ---
    const actions = req.canAccessEntity('action') ? await db.prepare(
      `SELECT a.*, COALESCE(t.title, 'Standalone') AS task_title
       FROM actions a LEFT JOIN tasks t ON a.task_id = t.id AND t.organization_id = a.organization_id
       WHERE a.organization_id = ? AND a.assignee IN (${ph}) AND a.status NOT IN ('resolved','closed')
       ORDER BY a.due_date ASC NULLS LAST, a.created_at DESC`
    ).all(req.orgId, ...matches) : [];

    // --- Non-Conformities ---
    const ncrs = req.canAccessEntity('ncr') ? await db.prepare(
      `SELECT n.*, a.title AS audit_title FROM non_conformities n
       JOIN audits a ON n.audit_id = a.id AND a.organization_id = n.organization_id
       WHERE n.organization_id = ? AND n.responsible IN (${ph}) AND n.status NOT IN ('closed','verified')
       ORDER BY n.due_date ASC NULLS LAST, n.created_at DESC`
    ).all(req.orgId, ...matches) : [];

    // --- Audits (as lead auditor or auditee, not yet completed) ---
    const audits = req.canAccessEntity('audit') ? await db.prepare(
      `SELECT * FROM audits
       WHERE organization_id = ? AND status != 'completed'
         AND (lead_auditor IN (${ph}) OR auditee IN (${ph}))
       ORDER BY planned_date ASC NULLS LAST`
    ).all(req.orgId, ...matches, ...matches) : []; // matches twice for both IN clauses

    // --- Risk Treatments (open/in-progress) ---
    const treatments = req.canAccessEntity('treatment') ? await db.prepare(
      `SELECT rt.*, r.title AS risk_title FROM risk_treatments rt
       JOIN risks r ON rt.risk_id = r.id AND r.organization_id = rt.organization_id
       WHERE r.organization_id = ? AND rt.responsible IN (${ph}) AND rt.status IN ('planned','in_progress')
       ORDER BY rt.due_date ASC NULLS LAST, rt.created_at DESC`
    ).all(req.orgId, ...matches) : [];

    // --- Management Review Outputs (open/in-progress, assigned to user or their roles) ---
    const mgmtOutputs = req.canAccessEntity('review_output') ? await db.prepare(
      `SELECT o.*, mr.title AS review_title, mr.review_date
       FROM management_review_outputs o
       JOIN management_reviews mr ON o.review_id = mr.id AND mr.organization_id = o.organization_id
       WHERE o.organization_id = ? AND o.assigned_to IN (${ph}) AND o.status IN ('open','in_progress')
       ORDER BY o.due_date ASC NULLS LAST, o.created_at DESC`
    ).all(req.orgId, ...matches) : [];

    res.json({
      tasks, actions, ncrs, audits, treatments, mgmtOutputs,
      assignedRoles,
      user: { name: user.name, email: user.email }
    });
  });
}

module.exports = { registerOrganizationRoutes };
