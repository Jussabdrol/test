// Register on the shared app to retain middleware and transaction boundaries.
function registerSuppliersRoutes(app, { db, requireOrgContext }) {
  // ── Suppliers ──────────────────────────────────────────────────────────────────

  app.get('/api/suppliers', requireOrgContext, async (req, res) => {
    const rows = await db.prepare(
      'SELECT * FROM suppliers WHERE organization_id = ? ORDER BY name ASC'
    ).all(req.orgId);
    res.json(rows);
  });

  app.get('/api/suppliers/:id', requireOrgContext, async (req, res) => {
    const row = await db.prepare(
      'SELECT * FROM suppliers WHERE id = ? AND organization_id = ?'
    ).get(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });

  app.post('/api/suppliers', requireOrgContext, async (req, res) => {
    const {
      name, category = 'other', criticality = 'medium', services_provided = '',
      data_classification = '', contract_status = 'current', contract_expiry_date = null,
      dpa_in_place = 'no', dpa_review_date = null, gaps_identified = '',
      remediation_status = 'open', next_review_date = null, status = 'active',
      notes = '', metadata = '{}'
    } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const result = await db.prepare(`
      INSERT INTO suppliers
        (organization_id, name, category, criticality, services_provided, data_classification,
         contract_status, contract_expiry_date, dpa_in_place, dpa_review_date, gaps_identified,
         remediation_status, next_review_date, status, notes, metadata)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(req.orgId, name, category, criticality, services_provided, data_classification,
           contract_status, contract_expiry_date, dpa_in_place, dpa_review_date, gaps_identified,
           remediation_status, next_review_date, status, notes,
           typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
    const newRow = await db.prepare('SELECT * FROM suppliers WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(newRow);
  });

  app.put('/api/suppliers/:id', requireOrgContext, async (req, res) => {
    const existing = await db.prepare(
      'SELECT id FROM suppliers WHERE id = ? AND organization_id = ?'
    ).get(req.params.id, req.orgId);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const fields = ['name','category','criticality','services_provided','data_classification',
      'contract_status','contract_expiry_date','dpa_in_place','dpa_review_date','gaps_identified',
      'remediation_status','next_review_date','status','notes','metadata'];
    const updates = [], params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        params.push(f === 'metadata' && typeof req.body[f] !== 'string'
          ? JSON.stringify(req.body[f]) : req.body[f]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    updates.push("updated_at = NOW()");
    await db.prepare(`UPDATE suppliers SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`)
      .run(...params, req.params.id, req.orgId);
    res.json(await db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id));
  });

  app.delete('/api/suppliers/:id', requireOrgContext, async (req, res) => {
    await db.prepare('DELETE FROM suppliers WHERE id = ? AND organization_id = ?')
      .run(req.params.id, req.orgId);
    res.json({ success: true });
  });

  // Database migrations and seeding are handled in db.js
}

module.exports = { registerSuppliersRoutes };
