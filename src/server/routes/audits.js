// Register on the shared app to retain middleware and transaction boundaries.
function registerAuditsRoutes(app, { db, fireWebhooks, logAuditAction, requireOrgContext, uploadPdf, uploadToSupabase }) {
  // --- Audit API ---

  // List audits (returns parent audits with ALL events attached including first instance)
  app.get('/api/audits', requireOrgContext, async (req, res) => {
    const { status, include_children } = req.query;
    let sql = 'SELECT * FROM audits WHERE organization_id = ? AND parent_audit_id IS NULL';
    const params = [req.orgId];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY planned_date DESC, created_at DESC';
    const parentAudits = await db.prepare(sql).all(...params);

    // Fetch all child audits for the returned parents in one query
    const parentIds = parentAudits.map(a => a.id);
    let allChildAudits = [];
    if (parentIds.length > 0) {
      const childRows = await db.getConnection().query(
        'SELECT * FROM audits WHERE parent_audit_id = ANY($1) ORDER BY instance_number, planned_date',
        [parentIds]
      );
      allChildAudits = childRows.rows;
    }

    // Collect every audit ID (parents + children) and fetch stats in 2 aggregate queries
    const allAuditIds = [...parentIds, ...allChildAudits.map(c => c.id)];
    let checklistStats = {};
    let ncStats = {};
    if (allAuditIds.length > 0) {
      const clRows = await db.getConnection().query(
        `SELECT audit_id,
                COUNT(*) AS checklist_count,
                COUNT(*) FILTER (WHERE rating != 'not_assessed') AS assessed_count,
                COUNT(*) FILTER (WHERE rating IN ('minor_nc','major_nc')) AS nc_count
         FROM audit_checklist WHERE audit_id = ANY($1) GROUP BY audit_id`,
        [allAuditIds]
      );
      for (const r of clRows.rows) checklistStats[r.audit_id] = r;

      const ncRows = await db.getConnection().query(
        `SELECT audit_id,
                COUNT(*) AS ncr_count,
                COUNT(*) FILTER (WHERE status IN ('open','in_progress')) AS open_nc_count
         FROM non_conformities WHERE audit_id = ANY($1) GROUP BY audit_id`,
        [allAuditIds]
      );
      for (const r of ncRows.rows) ncStats[r.audit_id] = r;
    }

    function getStats(auditId) {
      const cl = checklistStats[auditId] || {};
      const nc = ncStats[auditId] || {};
      return {
        checklist_count: parseInt(cl.checklist_count) || 0,
        assessed_count: parseInt(cl.assessed_count) || 0,
        nc_count: parseInt(cl.nc_count) || 0,
        ncr_count: parseInt(nc.ncr_count) || 0,
        open_nc_count: parseInt(nc.open_nc_count) || 0,
      };
    }

    // Group children by parent_id
    const childrenByParent = {};
    for (const c of allChildAudits) {
      if (!childrenByParent[c.parent_audit_id]) childrenByParent[c.parent_audit_id] = [];
      childrenByParent[c.parent_audit_id].push(c);
    }

    // Assemble response
    for (const a of parentAudits) {
      const parentStats = getStats(a.id);
      Object.assign(a, parentStats);

      const childAudits = childrenByParent[a.id] || [];
      for (const c of childAudits) Object.assign(c, getStats(c.id));
      a.child_events = childAudits;

      const parentAsEvent = {
        id: a.id,
        title: a.title,
        standard: a.standard,
        standards: a.standards,
        planned_date: a.planned_date,
        status: a.status,
        instance_number: a.instance_number || 1,
        lead_auditor: a.lead_auditor,
        auditee: a.auditee,
        ...parentStats,
      };
      a.all_events = [parentAsEvent, ...childAudits];
      a.total_instances = a.all_events.length;
    }
    res.json(parentAudits);
  });

  // Get single audit with checklist and NCs
  app.get('/api/audits/:id', requireOrgContext, async (req, res) => {
    const audit = await db.prepare('SELECT * FROM audits WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!audit) return res.status(404).json({ error: 'Audit not found' });
    audit.checklist = await db.prepare('SELECT * FROM audit_checklist WHERE audit_id = ? ORDER BY sort_order, id').all(audit.id);
    audit.non_conformities = await db.prepare('SELECT * FROM non_conformities WHERE audit_id = ? ORDER BY created_at DESC').all(audit.id);
    res.json(audit);
  });

  // Helper function to calculate next recurrence date
  function getNextRecurrenceDate(dateStr, recurrenceType) {
    const date = new Date(dateStr);
    switch (recurrenceType) {
      case 'monthly': date.setMonth(date.getMonth() + 1); break;
      case 'quarterly': date.setMonth(date.getMonth() + 3); break;
      case 'semi-annual': date.setMonth(date.getMonth() + 6); break;
      case 'annual': date.setFullYear(date.getFullYear() + 1); break;
      default: return null;
    }
    return date.toISOString().split('T')[0];
  }

  // Create audit
  app.post('/api/audits', requireOrgContext, async (req, res) => {
    const { title, standard, standards, scope, lead_auditor, audit_team, auditee, planned_date, requirement_ids, recurrence, recurrence_end_date } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    // Support both single standard (legacy) and multiple standards
    const standardsArray = standards && Array.isArray(standards) ? standards : (standard ? [standard] : ['ISO 9001']);
    const primaryStandard = standardsArray[0] || 'ISO 9001';

    try {
      const audit = await db.transaction(async (txDB) => {
        // Create the parent audit (instance 1)
        const result = await txDB.run(
          `INSERT INTO audits (organization_id, title, standard, standards, scope, lead_auditor, audit_team, auditee, planned_date, recurrence, recurrence_end_date, parent_audit_id, instance_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          req.orgId, title, primaryStandard, JSON.stringify(standardsArray), scope || '', lead_auditor || '', audit_team || '', auditee || '', planned_date || null, recurrence || 'none', recurrence_end_date || null, null, 1
        );
        const parentAuditId = result.lastInsertRowid;

        // Auto-create checklist items from selected requirements, including the standard
        if (requirement_ids && Array.isArray(requirement_ids) && requirement_ids.length > 0) {
          let order = 1;
          for (const reqId of requirement_ids) {
            const reqRow = await txDB.get('SELECT * FROM standard_requirements WHERE id = ?', reqId);
            if (reqRow) {
              await txDB.run('INSERT INTO audit_checklist (organization_id, audit_id, clause, requirement, standard, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
                req.orgId, parentAuditId, reqRow.clause, reqRow.title, reqRow.standard, order++);
            }
          }
        }

        // Create recurring audit events as child audits if recurrence is set
        if (recurrence && recurrence !== 'none' && planned_date && recurrence_end_date) {
          let nextDate = getNextRecurrenceDate(planned_date, recurrence);
          const endDate = new Date(recurrence_end_date);
          let instanceNum = 2;

          while (nextDate && new Date(nextDate) <= endDate) {
            const recurResult = await txDB.run(
              `INSERT INTO audits (organization_id, title, standard, standards, scope, lead_auditor, audit_team, auditee, planned_date, recurrence, recurrence_end_date, parent_audit_id, instance_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              req.orgId, title, primaryStandard, JSON.stringify(standardsArray), scope || '', lead_auditor || '', audit_team || '', auditee || '', nextDate, recurrence, recurrence_end_date, parentAuditId, instanceNum
            );

            // Copy checklist items to recurring audit
            if (requirement_ids && Array.isArray(requirement_ids) && requirement_ids.length > 0) {
              let order = 1;
              for (const reqId of requirement_ids) {
                const reqRow = await txDB.get('SELECT * FROM standard_requirements WHERE id = ?', reqId);
                if (reqRow) {
                  await txDB.run('INSERT INTO audit_checklist (organization_id, audit_id, clause, requirement, standard, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
                    req.orgId, recurResult.lastInsertRowid, reqRow.clause, reqRow.title, reqRow.standard, order++);
                }
              }
            }

            nextDate = getNextRecurrenceDate(nextDate, recurrence);
            instanceNum++;
          }
        }

        return await txDB.get('SELECT * FROM audits WHERE id = ?', parentAuditId);
      });

      res.status(201).json(audit);
    } catch (err) {
      console.error('Error creating audit:', err);
      res.status(500).json({ error: 'Failed to create audit' });
    }
  });

  // Update audit
  app.put('/api/audits/:id', requireOrgContext, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM audits WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!existing) return res.status(404).json({ error: 'Audit not found' });
    const fields = ['title', 'standard', 'scope', 'lead_auditor', 'audit_team', 'auditee', 'status', 'planned_date', 'completed_date', 'summary', 'recurrence', 'recurrence_end_date'];

    // Handle standards array
    if (req.body.standards && Array.isArray(req.body.standards)) {
      req.body.standards = JSON.stringify(req.body.standards);
      req.body.standard = req.body.standards[0] || existing.standard;
      fields.push('standards');
    }
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);
    await db.prepare(`UPDATE audits SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);

    if (req.body.status === 'completed' && existing.status !== 'completed') {
      const completedAudit = await db.prepare('SELECT * FROM audits WHERE id = ?').get(req.params.id);
      fireWebhooks(req.orgId, 'audit_complete', {
        id: completedAudit.id, title: completedAudit.title, standard: completedAudit.standard,
        lead_auditor: completedAudit.lead_auditor, completed_date: completedAudit.completed_date,
      });
    }

    // Add checklist items from newly selected requirements (skip existing clauses)
    if (req.body.requirement_ids && Array.isArray(req.body.requirement_ids)) {
      const existingClauses = (await db.prepare('SELECT clause FROM audit_checklist WHERE audit_id = ?').all(req.params.id)).map(c => c.clause);
      const insertCl = db.prepare('INSERT INTO audit_checklist (organization_id, audit_id, clause, requirement, sort_order) VALUES (?, ?, ?, ?, ?)');
      const getReq = db.prepare('SELECT * FROM standard_requirements WHERE id = ?');
      const maxOrder = (await db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM audit_checklist WHERE audit_id = ?').get(req.params.id)).m;
      let order = maxOrder + 1;
      for (const reqId of req.body.requirement_ids) {
        const r = await getReq.get(reqId);
        if (r && !existingClauses.includes(r.clause)) {
          await insertCl.run(req.orgId, req.params.id, r.clause, r.title, order++);
        }
      }
    }

    res.json(await db.prepare('SELECT * FROM audits WHERE id = ?').get(req.params.id));
  });

  // Delete audit
  app.delete('/api/audits/:id', requireOrgContext, async (req, res) => {
    const result = await db.prepare('DELETE FROM audits WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
    if (result.changes === 0) return res.status(404).json({ error: 'Audit not found' });
    res.json({ success: true });
  });

  // Upload client-generated audit report PDF and save to Document Control
  app.post('/api/audits/:id/upload-report', requireOrgContext, uploadPdf.single('pdf'), async (req, res) => {
    const audit = await db.prepare('SELECT * FROM audits WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!audit) return res.status(404).json({ error: 'Audit not found' });
    if (!req.file) return res.status(400).json({ error: 'No PDF file provided' });

    let filePath = '';
    const fileSize = req.file.size;
    try {
      filePath = await uploadToSupabase('reports', {
        originalname: `audit-report-${audit.id}.pdf`,
        buffer: req.file.buffer,
        mimetype: 'application/pdf',
      });
    } catch (uploadErr) {
      console.warn('[Audit Report] Supabase upload failed, storing reference only:', uploadErr.message);
    }

    // Find or create document control record for this audit's report
    let existingDoc = await db.prepare(
      "SELECT * FROM documents WHERE linked_ref_type = 'audit' AND linked_ref_id = ? AND organization_id = ?"
    ).get(audit.id, req.orgId);

    let docId;
    if (!existingDoc) {
      const result = await db.prepare(`
        INSERT INTO documents (organization_id, title, description, doc_type, version, owner, status,
          file_name, file_path, file_size, mime_type, linked_module, linked_ref_type, linked_ref_id,
          review_date, classification)
        VALUES (?, ?, ?, 'report', '1.0', ?, 'approved', ?, ?, ?, 'application/pdf', 'audit', 'audit', ?, NULL, '')
      `).run(
        req.orgId,
        `Audit Report – ${audit.title}`,
        `Auto-generated report for audit: ${audit.title}`,
        audit.lead_auditor || '',
        `audit-report-${audit.id}.pdf`,
        filePath,
        fileSize,
        audit.id
      );
      docId = result.lastInsertRowid;
    } else {
      await db.prepare(
        "UPDATE documents SET file_path = ?, file_size = ?, file_name = ?, mime_type = 'application/pdf', updated_at = datetime('now') WHERE id = ?"
      ).run(filePath, fileSize, `audit-report-${audit.id}.pdf`, existingDoc.id);
      docId = existingDoc.id;
    }

    // Auto-cross-link: 'audit' < 'document' alphabetically → audit is source
    await db.prepare(
      'INSERT OR IGNORE INTO cross_links (organization_id, source_type, source_id, target_type, target_id) VALUES (?, ?, ?, ?, ?)'
    ).run(req.orgId, 'audit', audit.id, 'document', docId);

    await logAuditAction(req.session.userId, req.session.userName || 'User', 'data_exported', 'audit', audit.id, audit.title, 'Report generated', req.orgId);
    res.json({ success: true, doc_id: docId });
  });
}

module.exports = { registerAuditsRoutes };
