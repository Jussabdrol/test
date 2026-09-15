// Register on the shared app to retain middleware and transaction boundaries.
function registerSoaRoutes(app, { db, requireOrgContext, uploadPdf, uploadToSupabase }) {
  // --- Statement of Applicability API ---

  app.get('/api/soa', requireOrgContext, async (req, res) => {
    // SoA is Annex A controls only — HLS clauses (4-10) are requirements, not SoA items.
    // Optionally filter to a specific Annex A standard via ?standard= param.
    const { standard } = req.query;
    let soaSql = `
      SELECT sr.*, soa.id as soa_id, soa.applicable, soa.justification,
             soa.implementation_status, soa.notes as soa_notes, soa.linked_processes, soa.regulatory
      FROM standard_requirements sr
      LEFT JOIN soa_entries soa ON sr.id = soa.requirement_id
      WHERE sr.organization_id = ? AND sr.standard LIKE '%Annex A%'`;
    const soaParams = [req.orgId];
    if (standard && standard.includes('Annex A')) {
      soaSql += ' AND sr.standard = ?';
      soaParams.push(standard);
    }
    soaSql += ' ORDER BY sr.standard, sr.sort_order, sr.clause';
    const reqs = await db.prepare(soaSql).all(...soaParams);

    if (reqs.length === 0) return res.json([]);

    const allProcesses = await db.prepare(
      "SELECT id, name FROM org_architecture WHERE arch_type = 'process' AND organization_id = ?"
    ).all(req.orgId);

    // Previously: 2 queries per requirement (2N total). Now: 2 bulk queries regardless of N.
    const reqIds = reqs.map(r => r.id);
    const clauses = [...new Set(reqs.map(r => r.clause).filter(Boolean))];
    const idPh = reqIds.map(() => '?').join(',');
    const clausePh = clauses.map(() => '?').join(',');

    // Bulk fetch treatments linked by requirement_id
    const treatsByReqId = await db.prepare(`
      SELECT rt.id, rt.description, rt.status, ri.title as risk_title, rt.requirement_id
      FROM risk_treatments rt JOIN risks ri ON rt.risk_id = ri.id
      WHERE rt.requirement_id IN (${idPh}) AND ri.organization_id = ?
    `).all(...reqIds, req.orgId);

    // Bulk fetch treatments linked by control_reference (clause match)
    const treatsByRef = clauses.length ? await db.prepare(`
      SELECT rt.id, rt.description, rt.status, ri.title as risk_title, rt.control_reference
      FROM risk_treatments rt JOIN risks ri ON rt.risk_id = ri.id
      WHERE rt.control_reference IN (${clausePh}) AND rt.control_reference != '' AND ri.organization_id = ?
    `).all(...clauses, req.orgId) : [];

    // Build lookup maps
    const byIdMap = {};
    for (const t of treatsByReqId) {
      if (!byIdMap[t.requirement_id]) byIdMap[t.requirement_id] = [];
      byIdMap[t.requirement_id].push(t);
    }
    const byRefMap = {};
    for (const t of treatsByRef) {
      if (!byRefMap[t.control_reference]) byRefMap[t.control_reference] = [];
      byRefMap[t.control_reference].push(t);
    }

    // Assemble per-requirement data entirely in JS (no more per-row queries)
    for (const r of reqs) {
      const byId = byIdMap[r.id] || [];
      const byRef = byRefMap[r.clause] || [];
      const allLinked = [...byId];
      for (const t of byRef) {
        if (!allLinked.some(l => l.id === t.id)) allLinked.push(t);
      }
      r.linked_treatments = allLinked;
      try { r.linked_process_ids = JSON.parse(r.linked_processes || '[]'); } catch(e) { r.linked_process_ids = []; }
      r.linked_process_names = r.linked_process_ids
        .map(pid => { const p = allProcesses.find(x => x.id === pid); return p ? p.name : null; })
        .filter(Boolean);
    }
    res.json(reqs);
  });

  app.put('/api/soa/:requirementId', requireOrgContext, async (req, res) => {
    const reqId = req.params.requirementId;
    // Verify the requirement belongs to this org
    const reqRow = await db.prepare('SELECT id FROM standard_requirements WHERE id = ? AND organization_id = ?').get(reqId, req.orgId);
    if (!reqRow) return res.status(404).json({ error: 'Requirement not found' });
    const { applicable, justification, implementation_status, notes } = req.body;
    const existing = await db.prepare('SELECT * FROM soa_entries WHERE requirement_id = ?').get(reqId);
    if (existing) {
      const fields = [];
      const params = [];
      if (applicable !== undefined) { fields.push('applicable = ?'); params.push(applicable ? 1 : 0); }
      if (justification !== undefined) { fields.push('justification = ?'); params.push(justification); }
      if (implementation_status !== undefined) { fields.push('implementation_status = ?'); params.push(implementation_status); }
      if (notes !== undefined) { fields.push('notes = ?'); params.push(notes); }
      if (req.body.linked_processes !== undefined) { fields.push('linked_processes = ?'); params.push(JSON.stringify(req.body.linked_processes)); }
      if (req.body.regulatory !== undefined) { fields.push('regulatory = ?'); params.push(req.body.regulatory ? 1 : 0); }
      fields.push("updated_at = datetime('now')");
      params.push(existing.id);
      await db.prepare(`UPDATE soa_entries SET ${fields.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
    } else {
      await db.prepare('INSERT INTO soa_entries (organization_id, requirement_id, applicable, justification, implementation_status, notes, linked_processes, regulatory) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.orgId,
        reqId, applicable !== undefined ? (applicable ? 1 : 0) : 1, justification || '', implementation_status || 'not_implemented', notes || '', JSON.stringify(req.body.linked_processes || []), req.body.regulatory ? 1 : 0
      );
    }
    res.json({ success: true });
  });

  // Upload SoA PDF and save to Document Control
  app.post('/api/soa/upload-report', requireOrgContext, uploadPdf.single('pdf'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No PDF file provided' });

    const org = await db.prepare('SELECT name FROM organizations WHERE id = ?').get(req.orgId);
    const orgName = org?.name || 'Organisation';
    const today = new Date().toISOString().split('T')[0];

    let filePath = '';
    const fileSize = req.file.size;
    try {
      filePath = await uploadToSupabase('reports', {
        originalname: `soa-${req.orgId}-${today}.pdf`,
        buffer: req.file.buffer,
        mimetype: 'application/pdf',
      });
    } catch (uploadErr) {
      console.warn('[SoA Report] Supabase upload failed, storing reference only:', uploadErr.message);
    }

    // Find or create the Document Control record for this org's SoA
    const existingDoc = await db.prepare(
      "SELECT * FROM documents WHERE linked_ref_type = 'soa' AND organization_id = ? LIMIT 1"
    ).get(req.orgId);

    let docId;
    if (!existingDoc) {
      const result = await db.prepare(`
        INSERT INTO documents (organization_id, title, description, doc_type, version, owner, status,
          file_name, file_path, file_size, mime_type, linked_module, linked_ref_type, linked_ref_id,
          review_date, classification)
        VALUES (?, ?, ?, 'report', '1.0', '', 'approved', ?, ?, ?, 'application/pdf',
                'risk', 'soa', NULL, NULL, 'Confidential')
      `).run(
        req.orgId,
        `Statement of Applicability – ${orgName}`,
        `ISO/IEC 27001:2022 Annex A Statement of Applicability for ${orgName}`,
        `soa-${req.orgId}-${today}.pdf`,
        filePath,
        fileSize
      );
      docId = result.lastInsertRowid;
    } else {
      await db.prepare(
        "UPDATE documents SET file_path = ?, file_size = ?, file_name = ?, version = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(filePath, fileSize, `soa-${req.orgId}-${today}.pdf`, '1.0', existingDoc.id);
      docId = existingDoc.id;
    }

    res.json({ success: true, doc_id: docId });
  });
}

module.exports = { registerSoaRoutes };
