// Register on the shared app to retain middleware and transaction boundaries.
function registerActionsRoutes(app, { HttpError, db, requireOpsAccess, requireOrgContext }) {
  // --- Follow-up Actions API ---

  // Get all follow-ups (actions) with optional filters
  app.get('/api/actions', requireOrgContext, requireOpsAccess, async (req, res) => {
    const { task_id, instance_id, status, process_id, process_ids } = req.query;
    let sql = `SELECT a.*, COALESCE(t.title, 'Standalone') as task_title, p.name as process_name,
      ti.scheduled_date AS instance_scheduled_date
      FROM actions a
      LEFT JOIN tasks t ON a.task_id = t.id
      LEFT JOIN task_instances ti ON a.instance_id = ti.id
      LEFT JOIN org_architecture p ON a.process_id = p.id
      WHERE a.organization_id = ?`;
    const params = [req.orgId];
    if (task_id) { sql += ' AND a.task_id = ?'; params.push(task_id); }
    if (instance_id) { sql += ' AND a.instance_id = ?'; params.push(instance_id); }
    if (status) { sql += ' AND a.status = ?'; params.push(status); }
    if (process_id) { sql += ' AND a.process_id = ?'; params.push(process_id); }
    // Bundle-context filter: comma-separated list of process ids
    if (process_ids) {
      const ids = String(process_ids).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger).slice(0, 100);
      if (ids.length) {
        sql += ` AND a.process_id IN (${ids.map(() => '?').join(',')})`;
        params.push(...ids);
      }
    }
    sql += ' ORDER BY a.created_at DESC';
    res.json(await db.prepare(sql).all(...params));
  });

  // Get single action
  app.get('/api/actions/:id', requireOrgContext, requireOpsAccess, async (req, res) => {
    const action = await db.prepare(`SELECT a.*, t.title as task_title, p.name as process_name
      FROM actions a
      LEFT JOIN tasks t ON a.task_id = t.id
      LEFT JOIN org_architecture p ON a.process_id = p.id
      WHERE a.id = ? AND a.organization_id = ?`).get(req.params.id, req.orgId);
    if (!action) return res.status(404).json({ error: 'Action not found' });
    res.json(action);
  });

  // Create follow-up (optionally linked to an instance/task/process, or standalone)
  app.post('/api/actions', requireOrgContext, requireOpsAccess, async (req, res) => {
    const { instance_id, task_id, process_id, title, description, assignee, priority, due_date } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    // If linked to an instance, inherit task_id from the instance when not explicitly provided.
    let resolvedTaskId = task_id || null;
    if (instance_id && !resolvedTaskId) {
      const inst = await db.prepare('SELECT task_id FROM task_instances WHERE id = ? AND organization_id = ?').get(instance_id, req.orgId);
      if (inst) resolvedTaskId = inst.task_id;
    }

    const sourceTask = resolvedTaskId
      ? await db.get('SELECT category, assignee FROM tasks WHERE id=? AND organization_id=?', resolvedTaskId, req.orgId) : null;
    const processes = sourceTask ? await db.all("SELECT id FROM org_architecture WHERE organization_id=? AND arch_type='process' AND name=?", req.orgId, sourceTask.category) : [];
    const resolvedProcessId = process_id || (processes.length === 1 ? processes[0].id : null);
    const resolvedAssignee = assignee || sourceTask?.assignee || '';

    const result = await db.prepare(`
      INSERT INTO actions (organization_id, instance_id, task_id, process_id, title, description, assignee, priority, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.orgId, instance_id || null, resolvedTaskId, resolvedProcessId, title, description || '', resolvedAssignee, priority || 'Medium', due_date || null);

    const action = await db.prepare('SELECT * FROM actions WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(action);
  });

  // Update action
  async function updateFollowup(orgId,id,body) {
    const req={orgId,params:{id},body,method:'PUT',path:'/api/actions/:id'.replace(':id',id)};
    return db.transaction(async()=>{
      await db.get('SELECT pg_advisory_xact_lock(?)',orgId);
      await require('../middleware/route-handling').validateRequest(req,db);
    const existing = await db.prepare('SELECT * FROM actions WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!existing) throw new HttpError(404, 'Action not found');

    const fields = ['title', 'description', 'assignee', 'priority', 'status', 'due_date', 'resolved_by', 'process_id'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        params.push(req.body[f]);
      }
    }
    // Auto-set resolved_at when status changes to resolved/closed
    if (req.body.status === 'resolved' || req.body.status === 'closed') {
      updates.push("resolved_at = COALESCE(resolved_at, NOW())");
    } else if (req.body.status !== undefined) {
      updates.push("resolved_at = NULL", "resolved_by = ''");
    }
    if (updates.length === 0) throw new HttpError(400, 'No fields to update');
    params.push(req.params.id);

    await db.prepare(`UPDATE actions SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
    const action = await db.prepare('SELECT * FROM actions WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    await db.run("UPDATE management_review_outputs SET status = CASE WHEN ? IN ('resolved','closed') THEN 'completed' WHEN ? = 'in_progress' THEN 'in_progress' ELSE 'open' END, updated_at=NOW() WHERE linked_action_id=? AND organization_id=?",action.status,action.status,action.id,req.orgId);
    return (action);
    });
  }

  app.put('/api/actions/:id', requireOrgContext, requireOpsAccess, async (req, res) => {
    res.json(await updateFollowup(req.orgId,req.params.id,req.body));
  });

  // Delete action
  app.delete('/api/actions/:id', requireOrgContext, requireOpsAccess, async (req, res) => {
    await db.run("UPDATE management_review_outputs SET status='open', linked_action_id=NULL, updated_at=NOW() WHERE linked_action_id=? AND organization_id=?",req.params.id,req.orgId);
    const result = await db.prepare('DELETE FROM actions WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
    if (result.changes === 0) return res.status(404).json({ error: 'Action not found' });
    res.json({ success: true });
  });

  return { updateFollowup };
}

module.exports = { registerActionsRoutes };
