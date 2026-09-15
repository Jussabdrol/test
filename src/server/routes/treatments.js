// Register on the shared app to retain middleware and transaction boundaries.
function registerTreatmentsRoutes(app, { db, requireOrgContext }) {
  // --- Risk Treatments API ---

  app.get('/api/treatments', requireOrgContext, async (req, res) => {
    const { risk_id, status } = req.query;
    let sql = `SELECT rt.*, r.title as risk_title, sr.clause, sr.title as requirement_title FROM risk_treatments rt JOIN risks r ON rt.risk_id = r.id LEFT JOIN standard_requirements sr ON rt.requirement_id = sr.id WHERE r.organization_id = ?`;
    const params = [req.orgId];
    if (risk_id) { sql += ' AND rt.risk_id = ?'; params.push(risk_id); }
    if (status) { sql += ' AND rt.status = ?'; params.push(status); }
    sql += ' ORDER BY rt.created_at DESC';
    res.json(await db.prepare(sql).all(...params));
  });

  app.post('/api/treatments', requireOrgContext, async (req, res) => {
    const { risk_id, treatment_type, description, control_reference, requirement_id, responsible, due_date, residual_likelihood, residual_impact, notes } = req.body;
    if (!risk_id) return res.status(400).json({ error: 'risk_id is required' });
    // Verify the risk belongs to this org
    const risk = await db.prepare('SELECT id FROM risks WHERE id = ? AND organization_id = ?').get(risk_id, req.orgId);
    if (!risk) return res.status(404).json({ error: 'Risk not found' });
    const rl = residual_likelihood ? parseInt(residual_likelihood) : null;
    const ri = residual_impact ? parseInt(residual_impact) : null;
    const residual_score = (rl && ri) ? rl * ri : null;
    const result = await db.prepare(`INSERT INTO risk_treatments (organization_id, risk_id, treatment_type, description, control_reference, requirement_id, responsible, due_date, residual_likelihood, residual_impact, residual_score, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.orgId, risk_id, treatment_type || 'mitigate', description || '', control_reference || '', requirement_id || null, responsible || '', due_date || null, rl, ri, residual_score, notes || ''
    );
    res.status(201).json(await db.prepare('SELECT * FROM risk_treatments WHERE id = ?').get(result.lastInsertRowid));
  });

  app.put('/api/treatments/:id', requireOrgContext, async (req, res) => {
    const existing = await db.prepare('SELECT rt.* FROM risk_treatments rt JOIN risks r ON rt.risk_id = r.id WHERE rt.id = ? AND r.organization_id = ?').get(req.params.id, req.orgId);
    if (!existing) return res.status(404).json({ error: 'Treatment not found' });
    const fields = ['treatment_type', 'description', 'control_reference', 'requirement_id', 'responsible', 'due_date', 'status', 'residual_likelihood', 'residual_impact', 'notes'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }
    // Improvement 5: recalculate residual_score when likelihood/impact change
    if (req.body.residual_likelihood !== undefined || req.body.residual_impact !== undefined) {
      const newRL = req.body.residual_likelihood !== undefined ? parseInt(req.body.residual_likelihood) : existing.residual_likelihood;
      const newRI = req.body.residual_impact !== undefined ? parseInt(req.body.residual_impact) : existing.residual_impact;
      updates.push('residual_score = ?');
      params.push((newRL && newRI) ? newRL * newRI : null);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);
    await db.prepare(`UPDATE risk_treatments SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json(await db.prepare('SELECT * FROM risk_treatments WHERE id = ?').get(req.params.id));
  });

  app.delete('/api/treatments/:id', requireOrgContext, async (req, res) => {
    // Verify the treatment belongs to a risk in this org before deleting
    const existing = await db.prepare('SELECT rt.id FROM risk_treatments rt JOIN risks r ON rt.risk_id = r.id WHERE rt.id = ? AND r.organization_id = ?').get(req.params.id, req.orgId);
    if (!existing) return res.status(404).json({ error: 'Treatment not found' });
    await db.prepare('DELETE FROM risk_treatments WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });
}

module.exports = { registerTreatmentsRoutes };
