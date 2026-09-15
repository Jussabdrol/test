// Register on the shared app to retain middleware and transaction boundaries.
function registerNonConformitiesRoutes(app, { db, emitEvent, fireWebhooks, requireOrgContext }) {
  // --- Non-Conformity API ---

  // List NCs (optionally filter by audit)
  app.get('/api/ncrs', requireOrgContext, async (req, res) => {
    const { audit_id, status } = req.query;
    let sql = `SELECT n.*, a.title as audit_title, a.standard as audit_standard,
      COALESCE(cl.standard, a.standard) as ncr_standard
      FROM non_conformities n
      JOIN audits a ON n.audit_id = a.id
      LEFT JOIN audit_checklist cl ON n.checklist_item_id = cl.id
      WHERE n.organization_id = ?`;
    const params = [req.orgId];
    if (audit_id) { sql += ' AND n.audit_id = ?'; params.push(audit_id); }
    if (status) { sql += ' AND n.status = ?'; params.push(status); }
    if (req.query.overdue === 'true') {
      sql += " AND n.due_date IS NOT NULL AND n.due_date < CURRENT_DATE::text AND n.status IN ('open','in_progress')";
    }
    sql += ' ORDER BY n.created_at DESC';
    res.json(await db.prepare(sql).all(...params));
  });

  // Create NC
  app.post('/api/ncrs', requireOrgContext, async (req, res) => {
    const { audit_id, checklist_item_id, clause, description, severity, root_cause, correction, corrective_action, responsible, due_date } = req.body;
    if (!audit_id || !description) return res.status(400).json({ error: 'audit_id and description are required' });
    const result = await db.prepare(`INSERT INTO non_conformities (organization_id, audit_id, checklist_item_id, clause, description, severity, root_cause, correction, corrective_action, responsible, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.orgId, audit_id, checklist_item_id || null, clause || '', description, severity || 'minor', root_cause || '', correction || '', corrective_action || '', responsible || '', due_date || null
    );
    // If linked to checklist item, update its rating
    if (checklist_item_id) {
      const rating = (severity === 'major') ? 'major_nc' : 'minor_nc';
      await db.prepare('UPDATE audit_checklist SET rating = ? WHERE id = ? AND organization_id = ?').run(rating, checklist_item_id, req.orgId);
    }
    const newNcr = await db.prepare('SELECT * FROM non_conformities WHERE id = ?').get(result.lastInsertRowid);
    fireWebhooks(req.orgId, 'ncr_created', {
      id: newNcr.id, clause: newNcr.clause, description: newNcr.description,
      severity: newNcr.severity, audit_id: newNcr.audit_id,
    });
    res.status(201).json(newNcr);
  });

  // Update NC
  app.put('/api/ncrs/:id', requireOrgContext, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM non_conformities WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!existing) return res.status(404).json({ error: 'NCR not found' });
    const fields = ['clause', 'description', 'severity', 'root_cause', 'correction', 'corrective_action', 'responsible', 'due_date', 'status', 'verification_notes'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }
    if (req.body.status === 'closed' || req.body.status === 'verified') {
      updates.push("closed_date = COALESCE(closed_date, CURRENT_DATE::text)");
    } else if (req.body.status !== undefined) {
      updates.push("closed_date = NULL");
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);
    await db.prepare(`UPDATE non_conformities SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
    const updatedNc = await db.prepare('SELECT * FROM non_conformities WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);

    // Improvement 7: emit process event when NC status changes
    if (req.body.status && req.body.status !== existing.status) {
      const activityMap = { in_progress: 'nc_in_progress', closed: 'nc_closed', verified: 'nc_verified' };
      const activity = activityMap[req.body.status] || `nc_status_${req.body.status}`;
      const openedAt = existing.created_at ? new Date(existing.created_at).getTime() : null;
      emitEvent(req.orgId, `nc-${req.params.id}`, 'nc_resolution', activity,
        req.body.responsible || existing.responsible || '',
        { severity: updatedNc.severity, clause: updatedNc.clause, audit_id: updatedNc.audit_id,
          duration_ms: openedAt ? Date.now() - openedAt : null });
    }

    res.json(updatedNc);
  });

  // Overdue NCs — open/in-progress NCs past their due date (improvement 4)
  app.get('/api/ncrs/overdue', requireOrgContext, async (req, res) => {
    const rows = await db.prepare(`
      SELECT n.*,
             a.title AS audit_title,
             a.standard AS audit_standard,
             COALESCE(cl.standard, a.standard) AS ncr_standard,
             EXTRACT(DAY FROM (CURRENT_DATE - n.due_date::date))::INTEGER AS days_overdue
      FROM non_conformities n
      JOIN audits a ON n.audit_id = a.id
      LEFT JOIN audit_checklist cl ON n.checklist_item_id = cl.id
      WHERE n.organization_id = ?
        AND n.status IN ('open','in_progress')
        AND n.due_date IS NOT NULL
        AND n.due_date::date < CURRENT_DATE
      ORDER BY n.due_date ASC
    `).all(req.orgId);
    res.json(rows);
  });

  // Delete NC
  app.delete('/api/ncrs/:id', requireOrgContext, async (req, res) => {
    const result = await db.prepare('DELETE FROM non_conformities WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
    if (result.changes === 0) return res.status(404).json({ error: 'NCR not found' });
    res.json({ success: true });
  });
}

module.exports = { registerNonConformitiesRoutes };
