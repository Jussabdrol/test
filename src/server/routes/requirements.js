// Register on the shared app to retain middleware and transaction boundaries.
function registerRequirementsRoutes(app, { db, requireOrgContext }) {
  // --- Standard Requirements API ---

  // List requirements (optionally filter by standard), enriched with audit history
  app.get('/api/requirements', requireOrgContext, async (req, res) => {
    const { standard } = req.query;
    let sql = 'SELECT * FROM standard_requirements WHERE organization_id = ?';
    const params = [req.orgId];
    if (standard) { sql += ' AND standard = ?'; params.push(standard); }
    sql += ' ORDER BY standard, sort_order, clause';
    const reqs = await db.prepare(sql).all(...params);

    if (reqs.length === 0) return res.json([]);

    // Previously: 2 queries per requirement (2N total for audit history + NCs).
    // Now: 2 bulk queries for the entire result set, matched in JS by clause+standard.
    const clauses   = [...new Set(reqs.map(r => r.clause))];
    const standards = [...new Set(reqs.map(r => r.standard))];
    const cPh = clauses.map(() => '?').join(',');
    const sPh = standards.map(() => '?').join(',');

    // Bulk audit history: one row per checklist item across all matching clauses/standards
    const auditHistory = await db.prepare(`
      SELECT a.id as audit_id, a.title as audit_title, a.planned_date, a.completed_date,
             a.status as audit_status, a.standard as audit_standard,
             cl.rating, cl.clause, cl.standard as cl_standard
      FROM audit_checklist cl
      JOIN audits a ON cl.audit_id = a.id
      WHERE cl.clause IN (${cPh})
        AND (cl.standard IN (${sPh}) OR (cl.standard = '' AND a.standard IN (${sPh})))
        AND a.organization_id = ?
      ORDER BY COALESCE(a.completed_date, a.planned_date) DESC
    `).all(...clauses, ...standards, ...standards, req.orgId);

    // Bulk NCs: one row per NC across all matching clauses/standards
    const allNcs = await db.prepare(`
      SELECT n.id, n.status, n.severity, n.clause,
             COALESCE(cl.standard, a.standard) as nc_standard
      FROM non_conformities n
      JOIN audits a ON n.audit_id = a.id
      LEFT JOIN audit_checklist cl ON n.checklist_item_id = cl.id
      WHERE n.clause IN (${cPh})
        AND (COALESCE(cl.standard, a.standard) IN (${sPh}) OR a.standard IN (${sPh}))
        AND a.organization_id = ?
    `).all(...clauses, ...standards, ...standards, req.orgId);

    // Build lookup maps keyed by "clause|||standard"
    const auditMap = {};
    for (const h of auditHistory) {
      const effectiveStd = h.cl_standard || h.audit_standard;
      const key = `${h.clause}|||${effectiveStd}`;
      if (!auditMap[key]) auditMap[key] = [];
      auditMap[key].push(h);
    }
    const ncMap = {};
    for (const n of allNcs) {
      const key = `${n.clause}|||${n.nc_standard}`;
      if (!ncMap[key]) ncMap[key] = [];
      ncMap[key].push(n);
    }

    // Assemble per-requirement data in JS (no more per-row DB queries)
    for (const r of reqs) {
      const key = `${r.clause}|||${r.standard}`;
      const history = auditMap[key] || [];
      const completedAudits = history.filter(h => h.audit_status === 'completed');
      r.last_audited    = completedAudits[0]?.completed_date || completedAudits[0]?.planned_date || null;
      r.last_audit_title = completedAudits[0]?.audit_title || null;
      r.last_rating     = completedAudits[0]?.rating || null;
      r.times_audited   = completedAudits.length;

      const ncs = ncMap[key] || [];
      r.nc_total  = ncs.length;
      r.nc_open   = ncs.filter(n => n.status === 'open' || n.status === 'in_progress').length;
      r.nc_closed = ncs.filter(n => n.status === 'closed' || n.status === 'verified').length;
    }

    res.json(reqs);
  });

  // Get unique standards list
  app.get('/api/requirements/standards', requireOrgContext, async (req, res) => {
    const standards = (await db.prepare('SELECT DISTINCT standard FROM standard_requirements WHERE organization_id = ? ORDER BY standard').all(req.orgId)).map(r => r.standard);
    res.json(standards);
  });

  // Create requirement
  app.post('/api/requirements', requireOrgContext, async (req, res) => {
    const { standard, clause, title, description, category, sort_order, owner } = req.body;
    if (!clause) return res.status(400).json({ error: 'Clause is required' });
    const result = await db.prepare(`INSERT INTO standard_requirements (standard, clause, title, description, category, sort_order, owner, organization_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      standard || 'ISO 9001', clause, title || '', description || '', category || '', sort_order ?? 0, owner || '', req.orgId
    );
    res.status(201).json(await db.prepare('SELECT * FROM standard_requirements WHERE id = ?').get(result.lastInsertRowid));
  });

  // Bulk import requirements
  app.post('/api/requirements/bulk', requireOrgContext, async (req, res) => {
    const { standard, items } = req.body;
    if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'items array is required' });
    const std = standard || 'ISO 9001';
    const existing = (await db.all('SELECT clause FROM standard_requirements WHERE standard = ? AND organization_id = ?', std, req.orgId)).map(r => r.clause);
    let inserted = 0;
    await db.transaction(async (txDB) => {
      for (const item of items) {
        if (existing.includes(item.clause)) continue;
        await txDB.run('INSERT INTO standard_requirements (standard, clause, title, description, category, sort_order, organization_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          std, item.clause, item.title || '', item.description || '', item.category || '', item.sort_order ?? 0, req.orgId);
        inserted++;
      }
    });
    res.status(201).json({ inserted });
  });

  // Update requirement
  app.put('/api/requirements/:id', requireOrgContext, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM standard_requirements WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!existing) return res.status(404).json({ error: 'Requirement not found' });
    const fields = ['standard', 'clause', 'title', 'description', 'category', 'sort_order', 'owner'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);
    await db.prepare(`UPDATE standard_requirements SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
    res.json(await db.prepare('SELECT * FROM standard_requirements WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
  });

  // Delete all requirements for a standard (retire)
  app.delete('/api/requirements/standard/:standard', requireOrgContext, async (req, res) => {
    const standard = decodeURIComponent(req.params.standard);
    // Clean up SoA entries for requirements of this standard (cascade should handle, but explicit for safety)
    await db.prepare(`DELETE FROM soa_entries WHERE requirement_id IN (SELECT id FROM standard_requirements WHERE standard = ? AND organization_id = ?)`).run(standard, req.orgId);
    const result = await db.prepare('DELETE FROM standard_requirements WHERE standard = ? AND organization_id = ?').run(standard, req.orgId);
    res.json({ success: true, deleted: result.changes });
  });

  // Delete requirement
  app.delete('/api/requirements/:id', requireOrgContext, async (req, res) => {
    const result = await db.prepare('DELETE FROM standard_requirements WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
    if (result.changes === 0) return res.status(404).json({ error: 'Requirement not found' });
    res.json({ success: true });
  });
}

module.exports = { registerRequirementsRoutes };
