const { occurrenceDates, syncNextDue } = require('../services/task-schedule');
const { isValidDateStr } = require('../services/planning');
const { positiveId } = require('../services/entities');
// Register on the shared app to retain middleware and transaction boundaries.
function registerTaskInstancesRoutes(app, { HttpError, db, deleteFromSupabase, emitEvent, ensureTaskInstances, fireWebhooks, getSignedUrl, parseIntParam, requireOpsAccess, requireOrgContext, upload, uploadToSupabase }) {
  // --- Task Log (task_instances) API ---

  // List task instances (auto-generates missing pending rows for active series up to today+14d)
  app.get('/api/task-instances', requireOrgContext, requireOpsAccess, async (req, res) => {
    const { status, task_id, from, to, completed_by, categories, limit } = req.query;

    // Express query parameters can also be arrays or objects. Narrow each date
    // directly before comparisons, slicing or passing the generation horizon.
    if (from !== undefined && (typeof from !== 'string' || !isValidDateStr(from))) throw new HttpError(400, 'Dates must use YYYY-MM-DD.');
    if (to !== undefined && (typeof to !== 'string' || !isValidDateStr(to))) throw new HttpError(400, 'Dates must use YYYY-MM-DD.');
    if (from && to && from > to) throw new HttpError(400, 'Start date must not be after end date.');
    if (task_id) positiveId(task_id);
    if (status && !['pending','completed','skipped'].includes(status)) throw new HttpError(400, 'Invalid execution status.');
    const defaultHorizon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const through = to || (from && from > defaultHorizon ? from : undefined);
    if (through && Number(through.slice(0, 4)) > new Date().getUTCFullYear() + 10) throw new HttpError(400, 'Choose a date within the next ten years.');
    await ensureTaskInstances(req.orgId, 14, { through, taskId: task_id });

    let sql = `SELECT ti.*, t.title AS task_title, t.category AS task_category,
      t.assignee AS task_assignee, t.priority AS task_priority, t.recurrence AS task_recurrence,
      COALESCE(ac.action_count, 0)::int AS action_count,
      COALESCE(ac.open_action_count, 0)::int AS open_action_count
      FROM task_instances ti JOIN tasks t ON ti.task_id = t.id
      LEFT JOIN (
        SELECT instance_id,
               COUNT(*) AS action_count,
               COUNT(*) FILTER (WHERE status IN ('open','in_progress')) AS open_action_count
        FROM actions
        WHERE organization_id = ? AND instance_id IS NOT NULL
        GROUP BY instance_id
      ) ac ON ac.instance_id = ti.id
      WHERE ti.organization_id = ?`;
    const params = [req.orgId, req.orgId];
    if (status) { sql += ' AND ti.status = ?'; params.push(status); }
    sql += " AND (ti.status <> 'pending' OR t.is_active = 1)";
    if (task_id) { sql += ' AND ti.task_id = ?'; params.push(task_id); }
    if (completed_by) { sql += ' AND ti.completed_by = ?'; params.push(completed_by); }
    // Process-context filter: comma-separated list of task categories (process names)
    if (categories) {
      const list = String(categories).split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
      if (list.length) {
        sql += ` AND t.category IN (${list.map(() => '?').join(',')})`;
        params.push(...list);
      }
    }
    if (from) { sql += ' AND ti.scheduled_date >= ?'; params.push(from); }
    if (to)   { sql += ' AND ti.scheduled_date <= ?'; params.push(to); }
    sql += ` ORDER BY CASE WHEN ti.status = 'pending' THEN ti.scheduled_date END ASC,
                      ti.completed_at DESC NULLS LAST,
                      ti.scheduled_date DESC
             LIMIT ?`;
    params.push(parseIntParam(limit, 500, { min: 1, max: 2000 }));
    res.json(await db.prepare(sql).all(...params));
  });

  // Get single instance
  app.get('/api/task-instances/:id', requireOrgContext, requireOpsAccess, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await db.prepare(
      `SELECT ti.*, t.title AS task_title, t.category AS task_category, t.assignee AS task_assignee
       FROM task_instances ti JOIN tasks t ON ti.task_id = t.id
       WHERE ti.id = ? AND ti.organization_id = ?`
    ).get(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Instance not found' });
    res.json(row);
  });

  // Complete an instance
  app.post('/api/task-instances/:id/complete', requireOrgContext, requireOpsAccess, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const item = await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!item) return res.status(404).json({ error: 'Instance not found' });
    if (item.status !== 'pending') throw new HttpError(409, 'This execution is already completed or skipped. Reopen it before changing its outcome.');

    await db.prepare(
      `UPDATE task_instances
       SET status = 'completed', completed_by = ?, completed_at = NOW(), notes = ?, updated_at = NOW()
       WHERE id = ? AND organization_id = ?`
    ).run(req.body.completed_by || '', req.body.notes || item.notes || '', req.params.id, req.orgId);

    // Keep next_due on outstanding work, skipping any already resolved later dates.
    const task = await db.prepare('SELECT * FROM tasks WHERE id = ? AND organization_id = ?').get(item.task_id, req.orgId);
    await syncNextDue(db, req.orgId, item.task_id);

    emitEvent(req.orgId, `task-${item.task_id}-${item.scheduled_date}`, 'task_cycle', 'task_completed',
      req.body.completed_by || '',
      { task_title: task ? task.title : '', category: task ? task.category : '', priority: task ? task.priority : '',
        instance_id: item.id });

    fireWebhooks(req.orgId, 'task_complete', {
      id: item.task_id, title: task ? task.title : '',
      category: task ? task.category : '', priority: task ? task.priority : '',
      completed_by: req.body.completed_by || '', scheduled_date: item.scheduled_date,
    });

    res.json(await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
  });

  // Skip an instance
  app.post('/api/task-instances/:id/skip', requireOrgContext, requireOpsAccess, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const item = await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!item) return res.status(404).json({ error: 'Instance not found' });
    if (item.status !== 'pending') throw new HttpError(409, 'This execution is already completed or skipped. Reopen it before changing its outcome.');
    await db.prepare(
      `UPDATE task_instances SET status = 'skipped', notes = ?, updated_at = NOW()
       WHERE id = ? AND organization_id = ?`
    ).run(req.body.notes || item.notes || '', req.params.id, req.orgId);

    await syncNextDue(db, req.orgId, item.task_id);

    res.json(await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
  });

  // Reopen an instance (back to pending)
  app.post('/api/task-instances/:id/reopen', requireOrgContext, requireOpsAccess, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const item = await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!item) return res.status(404).json({ error: 'Instance not found' });
    await db.prepare(
      `UPDATE task_instances
       SET status = 'pending', completed_by = '', completed_at = NULL, updated_at = NOW()
       WHERE id = ? AND organization_id = ?`
    ).run(req.params.id, req.orgId);
    await syncNextDue(db, req.orgId, item.task_id);
    res.json(await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
  });

  // Upload evidence to an instance
  app.post('/api/task-instances/:id/evidence', requireOrgContext, requireOpsAccess, upload.single('file'), async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const item = await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!item) return res.status(404).json({ error: 'Instance not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let storagePath;
    try {
      storagePath = await uploadToSupabase('task-instance-evidence', req.file);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

    let evidenceFiles = [];
    try { evidenceFiles = JSON.parse(item.evidence_files || '[]'); } catch(e) {}
    evidenceFiles.push({
      id: Date.now(),
      type: 'file',
      name: req.file.originalname,
      path: storagePath,
      size: req.file.size,
      mime: req.file.mimetype,
      uploaded_at: new Date().toISOString()
    });

    await db.prepare('UPDATE task_instances SET evidence_files = ?, updated_at = NOW() WHERE id = ? AND organization_id = ?').run(JSON.stringify(evidenceFiles), req.params.id, req.orgId);

    // Also create a Document Control entry for this evidence and auto-cross-link to the task
    try {
      const task = await db.prepare('SELECT title FROM tasks WHERE id = ?').get(item.task_id);
      const docTitle = `Evidence: ${req.file.originalname}`;
      const docDesc = `Evidence uploaded for task "${task ? task.title : 'Unknown'}" (instance #${req.params.id}, ${item.scheduled_date})`;
      const docResult = await db.prepare(`INSERT INTO documents (organization_id, title, description, doc_type, version, owner, status, file_name, file_path, file_size, mime_type, linked_module, linked_ref_type, linked_ref_id, classification) VALUES (?, ?, ?, 'evidence', '1.0', '', 'approved', ?, ?, ?, ?, 'operational-planning', 'task', ?, 'confidential')`).run(
        req.orgId, docTitle, docDesc, req.file.originalname, storagePath, req.file.size, req.file.mimetype, item.task_id
      );
      if (docResult.lastInsertRowid && item.task_id) {
        const [s_type, s_id, t_type, t_id] = 'document' < 'task'
          ? ['document', docResult.lastInsertRowid, 'task', item.task_id]
          : ['task', item.task_id, 'document', docResult.lastInsertRowid];
        await db.prepare('INSERT OR IGNORE INTO cross_links (organization_id, source_type, source_id, target_type, target_id) VALUES (?, ?, ?, ?, ?)').run(req.orgId, s_type, s_id, t_type, t_id);
      }
    } catch (docErr) {
      console.error('Failed to create Document Control entry for instance evidence:', docErr.message);
    }

    res.json(await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
  });

  // Download instance evidence file
  app.get('/api/task-instances/:id/evidence/:fileId/download', requireOrgContext, requireOpsAccess, async (req, res) => {
    const item = await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!item) return res.status(404).json({ error: 'Instance not found' });
    let evidenceFiles = [];
    try { evidenceFiles = JSON.parse(item.evidence_files || '[]'); } catch(e) {}
    const file = evidenceFiles.find(f => String(f.id) === String(req.params.fileId));
    if (!file || file.type !== 'file') return res.status(404).json({ error: 'File not found' });
    try {
      const url = await getSignedUrl(file.path, 300, file.name || true);
      res.redirect(url);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete instance evidence file
  app.delete('/api/task-instances/:id/evidence/:fileId', requireOrgContext, requireOpsAccess, async (req, res) => {
    const item = await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!item) return res.status(404).json({ error: 'Instance not found' });
    let evidenceFiles = [];
    try { evidenceFiles = JSON.parse(item.evidence_files || '[]'); } catch(e) {}
    const file = evidenceFiles.find(f => String(f.id) === String(req.params.fileId));
    if (file && file.type === 'file' && file.path) {
      await deleteFromSupabase(file.path);
    }
    evidenceFiles = evidenceFiles.filter(f => String(f.id) !== String(req.params.fileId));
    await db.prepare('UPDATE task_instances SET evidence_files = ?, updated_at = NOW() WHERE id = ? AND organization_id = ?').run(JSON.stringify(evidenceFiles), req.params.id, req.orgId);
    res.json({ success: true });
  });

  // Get unique assignees and categories for filters
  app.get('/api/meta', requireOrgContext, requireOpsAccess, async (req, res) => {
    const assignees = (await db.prepare("SELECT DISTINCT assignee FROM tasks WHERE organization_id = ? AND assignee != '' ORDER BY assignee").all(req.orgId)).map(r => r.assignee);
    const categories = (await db.prepare('SELECT DISTINCT category FROM tasks WHERE organization_id = ? ORDER BY category').all(req.orgId)).map(r => r.category);
    res.json({ assignees, categories });
  });

  // Get yearly plan data (all due dates + completions for a year)
  app.get('/api/yearly', requireOrgContext, requireOpsAccess, async (req, res) => {
    const currentYear = new Date().getFullYear();
    const year = parseIntParam(req.query.year, currentYear, { min: 2000, max: currentYear + 10 });
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const tasks = await db.all('SELECT * FROM tasks WHERE organization_id=?', req.orgId);
    const instances = await db.all(`SELECT * FROM task_instances WHERE organization_id=?
      AND scheduled_date >= ? AND scheduled_date <= ?`, req.orgId, startDate, endDate);
    const byTask = new Map();
    for (const instance of instances) {
      if (!byTask.has(instance.task_id)) byTask.set(instance.task_id, new Map());
      byTask.get(instance.task_id).set(instance.scheduled_date, instance);
    }
    const dueDates = {}, completedDates = {};
    for (const task of tasks) {
      const saved = byTask.get(task.id) || new Map();
      const dates = new Set(task.is_active ? occurrenceDates(task, endDate, startDate) : []);
      // Preserve actual history even when a series is deactivated or edited.
      for (const [date, instance] of saved) {
        if (task.is_active || instance.status !== 'pending') dates.add(date);
      }
      for (const date of [...dates].sort()) {
        const instance = saved.get(date);
        const entry = {
          task_id: task.id, title: task.title, assignee: task.assignee,
          category: task.category, priority: task.priority, recurrence: task.recurrence,
          scheduled_date: date, instance_id: instance?.id || null,
          status: instance?.status || 'pending', completed_at: instance?.completed_at || null,
          completed_by: instance?.completed_by || '', notes: instance?.notes || '', type: 'due',
        };
        (dueDates[date] ||= []).push(entry);
        if (entry.status === 'completed') (completedDates[date] ||= []).push({ ...entry, type: 'completed' });
      }
    }

    res.json({ year, dueDates, completedDates });
  });
}

module.exports = { registerTaskInstancesRoutes };
