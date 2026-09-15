// Register on the shared app to retain middleware and transaction boundaries.
function registerRisksRoutes(app, { db, fireWebhooks, requireOrgContext }) {
  // --- Risk Management API ---

  // List risks
  app.get('/api/risks', requireOrgContext, async (req, res) => {
    const { status, category } = req.query;
    let sql = 'SELECT * FROM risks WHERE organization_id = ?';
    const params = [req.orgId];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (category) { sql += ' AND category = ?'; params.push(category); }
    sql += ' ORDER BY inherent_score DESC, created_at DESC';
    const risks = await db.prepare(sql).all(...params);
    // Attach treatment counts via single aggregate query (avoids N+1)
    if (risks.length > 0) {
      const riskIds = risks.map(r => r.id);
      const treatmentCounts = await db.getConnection().query(
        `SELECT risk_id,
                COUNT(*) AS treatment_count,
                COUNT(*) FILTER (WHERE status IN ('planned','in_progress')) AS open_treatments
         FROM risk_treatments
         WHERE risk_id = ANY($1)
         GROUP BY risk_id`,
        [riskIds]
      );
      const countMap = {};
      for (const row of treatmentCounts.rows) {
        countMap[row.risk_id] = row;
      }
      for (const r of risks) {
        const c = countMap[r.id] || {};
        r.treatment_count = parseInt(c.treatment_count) || 0;
        r.open_treatments = parseInt(c.open_treatments) || 0;
      }
    }
    res.json(risks);
  });

  // Get single risk with treatments
  app.get('/api/risks/:id', requireOrgContext, async (req, res) => {
    const risk = await db.prepare('SELECT * FROM risks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!risk) return res.status(404).json({ error: 'Risk not found' });
    risk.treatments = await db.prepare(`SELECT rt.*, sr.clause, sr.title as requirement_title FROM risk_treatments rt LEFT JOIN standard_requirements sr ON rt.requirement_id = sr.id WHERE rt.risk_id = ? ORDER BY rt.created_at`).all(risk.id);
    res.json(risk);
  });

  // Create risk
  app.post('/api/risks', requireOrgContext, async (req, res) => {
    const { title, description, category, source, asset, threat, vulnerability, likelihood, impact, risk_owner, status } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const l = parseInt(likelihood) || 3;
    const i = parseInt(impact) || 3;
    const inherent_score = l * i;
    const result = await db.prepare(`INSERT INTO risks (title, description, category, source, asset, threat, vulnerability, likelihood, impact, inherent_score, risk_owner, status, organization_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      title, description || '', category || 'Information Security', source || '', asset || '', threat || '', vulnerability || '', l, i, inherent_score, risk_owner || '', status || 'identified', req.orgId
    );
    const newRisk = await db.prepare('SELECT * FROM risks WHERE id = ?').get(result.lastInsertRowid);
    if (inherent_score >= 15) {
      fireWebhooks(req.orgId, 'risk_high', {
        id: newRisk.id, title: newRisk.title, category: newRisk.category,
        inherent_score, likelihood: l, impact: i, risk_owner: newRisk.risk_owner,
      });
    }
    res.status(201).json(newRisk);
  });

  // Update risk
  app.put('/api/risks/:id', requireOrgContext, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM risks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!existing) return res.status(404).json({ error: 'Risk not found' });
    const fields = ['title', 'description', 'category', 'source', 'asset', 'threat', 'vulnerability', 'likelihood', 'impact', 'risk_owner', 'status'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }
    // Auto-recalculate inherent_score whenever likelihood or impact changes
    if (req.body.likelihood !== undefined || req.body.impact !== undefined) {
      const newL = parseInt(req.body.likelihood !== undefined ? req.body.likelihood : existing.likelihood) || 1;
      const newI = parseInt(req.body.impact !== undefined ? req.body.impact : existing.impact) || 1;
      updates.push('inherent_score = ?');
      params.push(newL * newI);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);
    await db.prepare(`UPDATE risks SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
    const updatedRisk = await db.prepare('SELECT * FROM risks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    // Fire when score just crossed into high territory (was below 15, now ≥ 15)
    if (updatedRisk.inherent_score >= 15 && existing.inherent_score < 15) {
      fireWebhooks(req.orgId, 'risk_high', {
        id: updatedRisk.id, title: updatedRisk.title, category: updatedRisk.category,
        inherent_score: updatedRisk.inherent_score, likelihood: updatedRisk.likelihood,
        impact: updatedRisk.impact, risk_owner: updatedRisk.risk_owner,
      });
    }
    res.json(updatedRisk);
  });

  // Delete risk
  app.delete('/api/risks/:id', requireOrgContext, async (req, res) => {
    const result = await db.prepare('DELETE FROM risks WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
    if (result.changes === 0) return res.status(404).json({ error: 'Risk not found' });
    res.json({ success: true });
  });
}

module.exports = { registerRisksRoutes };
