// Register on the shared app to retain middleware and transaction boundaries.
function registerPlanBundlesRoutes(app, { db, requireOpsAccess, requireOrgContext }) {
  // --- Plan Bundles API ---

  app.get('/api/plan-bundles', requireOrgContext, requireOpsAccess, async (req, res) => {
    res.json(await db.prepare('SELECT * FROM plan_bundles WHERE organization_id = ? ORDER BY sort_order, name').all(req.orgId));
  });

  app.post('/api/plan-bundles', requireOrgContext, requireOpsAccess, async (req, res) => {
    const { name, process_ids, color } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const result = await db.prepare(
      'INSERT INTO plan_bundles (organization_id, name, process_ids, color) VALUES (?, ?, ?, ?)'
    ).run(req.orgId, name, JSON.stringify(process_ids || []), color || '#6366f1');
    res.status(201).json(await db.prepare('SELECT * FROM plan_bundles WHERE id = ?').get(result.lastInsertRowid));
  });

  app.put('/api/plan-bundles/:id', requireOrgContext, requireOpsAccess, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM plan_bundles WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!existing) return res.status(404).json({ error: 'Bundle not found' });
    const { name, process_ids, color, sort_order } = req.body;
    await db.prepare(
      `UPDATE plan_bundles SET name = ?, process_ids = ?, color = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?`
    ).run(
      name ?? existing.name,
      process_ids !== undefined ? JSON.stringify(process_ids) : existing.process_ids,
      color ?? existing.color,
      sort_order ?? existing.sort_order,
      req.params.id, req.orgId
    );
    res.json(await db.prepare('SELECT * FROM plan_bundles WHERE id = ?').get(req.params.id));
  });

  app.delete('/api/plan-bundles/:id', requireOrgContext, requireOpsAccess, async (req, res) => {
    const result = await db.prepare('DELETE FROM plan_bundles WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
    if (result.changes === 0) return res.status(404).json({ error: 'Bundle not found' });
    res.json({ success: true });
  });
}

module.exports = { registerPlanBundlesRoutes };
