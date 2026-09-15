// Register on the shared app to retain middleware and transaction boundaries.
function registerChecklistRoutes(app, { HttpError, db, deleteFromSupabase, getSignedUrl, requireOrgContext, upload, uploadToSupabase }) {
  // --- Audit Checklist API ---

  // Add checklist item
  app.post('/api/audits/:id/checklist', requireOrgContext, async (req, res) => {
    const { clause, requirement, sort_order } = req.body;
    if (!clause) return res.status(400).json({ error: 'Clause is required' });
    const maxOrder = (await db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM audit_checklist WHERE audit_id = ? AND organization_id = ?').get(req.params.id, req.orgId)).m;
    const result = await db.prepare('INSERT INTO audit_checklist (organization_id, audit_id, clause, requirement, sort_order) VALUES (?, ?, ?, ?, ?)').run(
      req.orgId, req.params.id, clause, requirement || '', sort_order ?? maxOrder + 1
    );
    res.status(201).json(await db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(result.lastInsertRowid));
  });

  // Update checklist item (during execution)
  async function updateChecklistItem(orgId,id,body) {
    const req={orgId,params:{id},body,method:'PUT',path:'/api/checklist/:id'.replace(':id',id)};
    return db.transaction(async()=>{
      await db.get('SELECT pg_advisory_xact_lock(?)',orgId);
      await require('../middleware/route-handling').validateRequest(req,db);
    const existing = await getChecklistItemWithOrgCheck(req.params.id, req.orgId);
    if (!existing) throw new HttpError(404, 'Checklist item not found');
    const fields = ['clause', 'requirement', 'evidence', 'finding', 'rating', 'notes', 'sort_order', 'evidence_files'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }
    if (updates.length === 0) throw new HttpError(400, 'No fields to update');
    params.push(req.params.id);
    await db.prepare(`UPDATE audit_checklist SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    // Auto-create or remove NCR when rating changes
    if (req.body.rating) {
      const isNc = req.body.rating === 'minor_nc' || req.body.rating === 'major_nc';
      const existingNcr = await db.prepare('SELECT * FROM non_conformities WHERE checklist_item_id = ? AND organization_id = ?').get(req.params.id, req.orgId);

      if (isNc && !existingNcr) {
        // Auto-create NCR with populated fields from checklist item
        const cl = await db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(req.params.id);
        const severity = req.body.rating === 'major_nc' ? 'major' : 'minor';
        const description = cl.finding || `Non-conformity found for clause ${cl.clause}`;
        await db.prepare(`INSERT INTO non_conformities (organization_id, audit_id, checklist_item_id, clause, description, severity) VALUES (?, ?, ?, ?, ?, ?)`).run(
          req.orgId, existing.audit_id, req.params.id, cl.clause, description, severity
        );
      } else if (isNc && existingNcr) {
        // Update severity if it changed (e.g. minor_nc -> major_nc)
        const severity = req.body.rating === 'major_nc' ? 'major' : 'minor';
        if (existingNcr.severity !== severity) {
          await db.prepare("UPDATE non_conformities SET severity = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?").run(severity, existingNcr.id, req.orgId);
        }
      }
    }

    // Auto-update audit status when rating changes
    let auditStatusChanged = null;
    if (req.body.rating !== undefined) {
      const audit = await db.prepare('SELECT * FROM audits WHERE id = ? AND organization_id = ?').get(existing.audit_id, req.orgId);
      if (audit && audit.status !== 'completed' && audit.status !== 'cancelled') {
        const allItems = await db.prepare('SELECT rating FROM audit_checklist WHERE audit_id = ?').all(existing.audit_id);
        const allAssessed = allItems.length > 0 && allItems.every(i => i.rating !== 'not_assessed');
        const anyAssessed = allItems.some(i => i.rating !== 'not_assessed');
        if (allAssessed) {
          await db.prepare("UPDATE audits SET status = 'completed', completed_date = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?")
            .run(new Date().toISOString().split('T')[0], existing.audit_id, req.orgId);
          auditStatusChanged = 'completed';
        } else if (anyAssessed && audit.status === 'planned') {
          await db.prepare("UPDATE audits SET status = 'in_progress', updated_at = datetime('now') WHERE id = ? AND organization_id = ?")
            .run(existing.audit_id, req.orgId);
          auditStatusChanged = 'in_progress';
        }
      }
    }

    const updatedItem = await db.prepare('SELECT * FROM audit_checklist WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    return ({ ...updatedItem, _auditStatus: auditStatusChanged });
    });
  }

  app.put('/api/checklist/:id', requireOrgContext, async (req, res) => {
    res.json(await updateChecklistItem(req.orgId,req.params.id,req.body));
  });

  // Delete checklist item
  app.delete('/api/checklist/:id', requireOrgContext, async (req, res) => {
    const existing = await getChecklistItemWithOrgCheck(req.params.id, req.orgId);
    if (!existing) return res.status(404).json({ error: 'Item not found' });
    await db.prepare('DELETE FROM audit_checklist WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // Upload evidence file to checklist item
  app.post('/api/checklist/:id/evidence', requireOrgContext, upload.single('file'), async (req, res) => {
    try {
      // Look up item by id, then verify org ownership through the parent audit
      const item = await db.prepare('SELECT cl.*, a.organization_id as audit_org_id FROM audit_checklist cl JOIN audits a ON a.id = cl.audit_id WHERE cl.id = ?').get(req.params.id);
      if (!item || item.audit_org_id !== req.orgId) return res.status(404).json({ error: 'Checklist item not found' });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      let storagePath;
      try {
        storagePath = await uploadToSupabase('evidence', req.file);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }

      // Parse existing evidence_files array
      let evidenceFiles = [];
      try { evidenceFiles = JSON.parse(item.evidence_files || '[]'); } catch(e) {}

      // Add new file to array
      evidenceFiles.push({
        id: Date.now(),
        type: 'file',
        name: req.file.originalname,
        path: storagePath,
        size: req.file.size,
        mime: req.file.mimetype,
        uploaded_at: new Date().toISOString()
      });

      // Update the checklist item (use id only — org ownership already verified via audit)
      await db.prepare('UPDATE audit_checklist SET evidence_files = ? WHERE id = ?').run(JSON.stringify(evidenceFiles), req.params.id);

      // Backfill organization_id if it was NULL
      if (item.organization_id == null) {
        await db.prepare('UPDATE audit_checklist SET organization_id = ? WHERE id = ? AND organization_id IS NULL').run(req.orgId, req.params.id);
      }

      // Also create a Document Control entry for this evidence and auto-cross-link to the audit
      try {
        const audit = await db.prepare('SELECT title FROM audits WHERE id = ?').get(item.audit_id);
        const docTitle = `Evidence: ${req.file.originalname}`;
        const docDesc = `Evidence uploaded for audit "${audit ? audit.title : 'Unknown'}" — checklist item: ${item.clause || item.title || '#' + req.params.id}`;
        const docResult = await db.prepare(`INSERT INTO documents (organization_id, title, description, doc_type, version, owner, status, file_name, file_path, file_size, mime_type, linked_module, linked_ref_type, linked_ref_id, classification) VALUES (?, ?, ?, 'evidence', '1.0', '', 'approved', ?, ?, ?, ?, 'audits', 'audit', ?, 'confidential')`).run(
          req.orgId, docTitle, docDesc, req.file.originalname, storagePath, req.file.size, req.file.mimetype, item.audit_id
        );
        // Auto-create cross-link between the new document and the source audit
        if (docResult.lastInsertRowid && item.audit_id) {
          const [s_type, s_id, t_type, t_id] = 'audit' < 'document'
            ? ['audit', item.audit_id, 'document', docResult.lastInsertRowid]
            : ['document', docResult.lastInsertRowid, 'audit', item.audit_id];
          await db.prepare('INSERT OR IGNORE INTO cross_links (organization_id, source_type, source_id, target_type, target_id) VALUES (?, ?, ?, ?, ?)').run(req.orgId, s_type, s_id, t_type, t_id);
        }
      } catch (docErr) {
        console.error('Failed to create Document Control entry for checklist evidence:', docErr.message);
      }

      res.json(await db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(req.params.id));
    } catch (err) {
      console.error('Evidence upload error:', err);
      res.status(500).json({ error: 'Evidence upload failed' });
    }
  });

  // Helper: look up checklist item by id and verify org ownership through parent audit
  async function getChecklistItemWithOrgCheck(itemId, orgId) {
    const item = await db.prepare('SELECT cl.*, a.organization_id as audit_org_id FROM audit_checklist cl JOIN audits a ON a.id = cl.audit_id WHERE cl.id = ?').get(itemId);
    if (!item || item.audit_org_id !== orgId) return null;
    return item;
  }

  // Download evidence file from checklist item
  app.get('/api/checklist/:id/evidence/:fileId/download', requireOrgContext, async (req, res) => {
    const item = await getChecklistItemWithOrgCheck(req.params.id, req.orgId);
    if (!item) return res.status(404).json({ error: 'Checklist item not found' });

    let evidenceFiles = [];
    try { evidenceFiles = JSON.parse(item.evidence_files || '[]'); } catch(e) {}

    const file = evidenceFiles.find(f => f.id == req.params.fileId);
    if (!file || file.type !== 'file') return res.status(404).json({ error: 'File not found' });

    try {
      const signedUrl = await getSignedUrl(file.path, 300, file.name || true);
      res.redirect(signedUrl);
    } catch (err) {
      res.status(404).json({ error: 'File not found in storage' });
    }
  });

  // Delete evidence file from checklist item
  app.delete('/api/checklist/:id/evidence/:fileId', requireOrgContext, async (req, res) => {
    const item = await getChecklistItemWithOrgCheck(req.params.id, req.orgId);
    if (!item) return res.status(404).json({ error: 'Checklist item not found' });

    let evidenceFiles = [];
    try { evidenceFiles = JSON.parse(item.evidence_files || '[]'); } catch(e) {}

    const fileIndex = evidenceFiles.findIndex(f => f.id == req.params.fileId);
    if (fileIndex === -1) return res.status(404).json({ error: 'Evidence item not found' });

    const file = evidenceFiles[fileIndex];
    // Delete actual file from Supabase Storage if it's a file type
    if (file.type === 'file' && file.path) {
      await deleteFromSupabase(file.path);
    }

    // Remove from array
    evidenceFiles.splice(fileIndex, 1);
    await db.prepare('UPDATE audit_checklist SET evidence_files = ? WHERE id = ?').run(JSON.stringify(evidenceFiles), req.params.id);
    res.json({ success: true });
  });

  // Add link evidence to checklist item
  app.post('/api/checklist/:id/evidence-link', requireOrgContext, async (req, res) => {
    const item = await getChecklistItemWithOrgCheck(req.params.id, req.orgId);
    if (!item) return res.status(404).json({ error: 'Checklist item not found' });
    const { link_type, link_id, link_name } = req.body;
    if (!link_type || !link_id) return res.status(400).json({ error: 'Link type and id required' });

    // Parse existing evidence_files array
    let evidenceFiles = [];
    try { evidenceFiles = JSON.parse(item.evidence_files || '[]'); } catch(e) {}

    // Add new link to array
    evidenceFiles.push({
      id: Date.now(),
      type: 'link',
      link_type,
      link_id,
      link_name: link_name || `${link_type} #${link_id}`,
      added_at: new Date().toISOString()
    });

    // Update the checklist item
    await db.prepare('UPDATE audit_checklist SET evidence_files = ? WHERE id = ?').run(JSON.stringify(evidenceFiles), req.params.id);
    res.json(await db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(req.params.id));
  });

  return { updateChecklistItem };
}

module.exports = { registerChecklistRoutes };
