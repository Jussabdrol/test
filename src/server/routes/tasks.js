const { syncNextDue } = require('../services/task-schedule');
// Register on the shared app to retain middleware and transaction boundaries.
function registerTasksRoutes(app, { HttpError, db, emitEvent, fireWebhooks, isValidDateStr, requireOpsAccess, requireOrgContext, validateRecurrenceFields }) {
  // --- API Routes ---

  // Get all tasks with optional filters
  app.get('/api/tasks', requireOrgContext, requireOpsAccess, async (req, res) => {
    const { active, assignee, category, categories, priority, overdue } = req.query;
    let sql = 'SELECT * FROM tasks WHERE organization_id = ?';
    const params = [req.orgId];

    if (active !== undefined) {
      sql += ' AND is_active = ?';
      params.push(active === 'true' ? 1 : 0);
    }
    if (assignee) {
      sql += ' AND assignee = ?';
      params.push(assignee);
    }
    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    // Process-context filter: comma-separated list of categories (bundle support)
    if (categories) {
      const list = String(categories).split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
      if (list.length) {
        sql += ` AND category IN (${list.map(() => '?').join(',')})`;
        params.push(...list);
      }
    }
    if (priority) {
      sql += ' AND priority = ?';
      params.push(priority);
    }
    if (overdue === 'true') {
      sql += ' AND next_due < date("now")';
    }

    sql += ' ORDER BY next_due ASC';
    const tasks = await db.prepare(sql).all(...params);
    res.json(tasks);
  });

  // Get dashboard stats
  app.get('/api/dashboard', requireOrgContext, requireOpsAccess, async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const oid = req.orgId;
    const stats = {
      totalActive: (await db.prepare('SELECT COUNT(*) as c FROM tasks WHERE organization_id = ? AND is_active = 1').get(oid)).c,
      dueToday: (await db.prepare('SELECT COUNT(*) as c FROM tasks WHERE organization_id = ? AND is_active = 1 AND next_due = ?').get(oid, today)).c,
      overdue: (await db.prepare('SELECT COUNT(*) as c FROM tasks WHERE organization_id = ? AND is_active = 1 AND next_due < ?').get(oid, today)).c,
      completedThisWeek: (await db.prepare(`SELECT COUNT(*) as c FROM task_instances WHERE organization_id = ? AND status = 'completed' AND completed_at >= date('now', '-7 days')`).get(oid)).c,
      completedThisMonth: (await db.prepare(`SELECT COUNT(*) as c FROM task_instances WHERE organization_id = ? AND status = 'completed' AND completed_at >= date('now', '-30 days')`).get(oid)).c,
      byCategory: await db.prepare('SELECT category, COUNT(*) as count FROM tasks WHERE organization_id = ? AND is_active = 1 GROUP BY category').all(oid),
      byPriority: await db.prepare('SELECT priority, COUNT(*) as count FROM tasks WHERE organization_id = ? AND is_active = 1 GROUP BY priority').all(oid),
      byAssignee: await db.prepare("SELECT assignee, COUNT(*) as count FROM tasks WHERE organization_id = ? AND is_active = 1 AND assignee != '' GROUP BY assignee").all(oid),
      upcomingTasks: await db.prepare('SELECT * FROM tasks WHERE organization_id = ? AND is_active = 1 AND next_due >= ? ORDER BY next_due ASC LIMIT 10').all(oid, today),
      overdueTasks: await db.prepare('SELECT * FROM tasks WHERE organization_id = ? AND is_active = 1 AND next_due < ? ORDER BY next_due ASC').all(oid, today),
      openActions: (await db.prepare("SELECT COUNT(*) as c FROM actions WHERE organization_id = ? AND status IN ('open','in_progress')").get(oid)).c,
      overdueActions: (await db.prepare("SELECT COUNT(*) as c FROM actions WHERE organization_id = ? AND status IN ('open','in_progress') AND due_date < ? AND due_date IS NOT NULL").get(oid, today)).c,
    };

    // KPI: Actions per check
    const totalCompletions = (await db.prepare("SELECT COUNT(*) as c FROM task_instances WHERE organization_id = ? AND status = 'completed'").get(oid)).c;
    const totalActionsAll = (await db.prepare('SELECT COUNT(*) as c FROM actions WHERE organization_id = ?').get(oid)).c;
    stats.actionsPerCheck = totalCompletions > 0 ? +(totalActionsAll / totalCompletions).toFixed(2) : 0;
    stats.totalCompletions = totalCompletions;
    stats.totalActionsCount = totalActionsAll;

    // Actions per check this month vs last month
    const actionsThisMonth = (await db.prepare("SELECT COUNT(*) as c FROM actions WHERE organization_id = ? AND created_at >= date('now','start of month')").get(oid)).c;
    const completionsThisMonth = (await db.prepare("SELECT COUNT(*) as c FROM task_instances WHERE organization_id = ? AND status = 'completed' AND completed_at >= date('now','start of month')").get(oid)).c;
    const actionsLastMonth = (await db.prepare("SELECT COUNT(*) as c FROM actions WHERE organization_id = ? AND created_at >= date('now','start of month','-1 month') AND created_at < date('now','start of month')").get(oid)).c;
    const completionsLastMonth = (await db.prepare("SELECT COUNT(*) as c FROM task_instances WHERE organization_id = ? AND status = 'completed' AND completed_at >= date('now','start of month','-1 month') AND completed_at < date('now','start of month')").get(oid)).c;
    stats.actionsPerCheckThisMonth = completionsThisMonth > 0 ? +(actionsThisMonth / completionsThisMonth).toFixed(2) : 0;
    stats.actionsPerCheckLastMonth = completionsLastMonth > 0 ? +(actionsLastMonth / completionsLastMonth).toFixed(2) : 0;

    // Compare the actual completion date with the occurrence's due date.
    // Recurrence gaps are not evidence that an individual control was on time.
    const rates = await db.get(`SELECT
      ROUND(100.0 * COUNT(*) FILTER (WHERE completed_at >= CURRENT_DATE - INTERVAL '30 days'
        AND completed_at::date <= scheduled_date::date)
        / NULLIF(COUNT(*) FILTER (WHERE completed_at >= CURRENT_DATE - INTERVAL '30 days'), 0)) AS current_rate,
      ROUND(100.0 * COUNT(*) FILTER (WHERE completed_at < CURRENT_DATE - INTERVAL '30 days'
        AND completed_at::date <= scheduled_date::date)
        / NULLIF(COUNT(*) FILTER (WHERE completed_at < CURRENT_DATE - INTERVAL '30 days'), 0)) AS previous_rate
      FROM task_instances WHERE organization_id=? AND status='completed'
        AND completed_at >= CURRENT_DATE - INTERVAL '60 days'`, oid);
    stats.onTimeRateCurrent = rates.current_rate == null ? null : Number(rates.current_rate);
    stats.onTimeRatePrevious = rates.previous_rate == null ? null : Number(rates.previous_rate);

    res.json(stats);
  });

  // Get single task series with recent instance history
  app.get('/api/tasks/:id', requireOrgContext, requireOpsAccess, async (req, res) => {
    const task = await db.prepare('SELECT * FROM tasks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const instances = await db.prepare(
      `SELECT * FROM task_instances
       WHERE task_id = ? AND organization_id = ? AND status = 'completed'
       ORDER BY completed_at DESC LIMIT 20`
    ).all(req.params.id, req.orgId);
    res.json({ ...task, completions: instances });
  });

  // Create task
  app.post('/api/tasks', requireOrgContext, requireOpsAccess, async (req, res) => {
    const { title, description, assignee, category, priority, recurrence, custom_days, day_of_week, day_of_month, start_date } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    if (start_date !== undefined && start_date !== null && start_date !== '' && !isValidDateStr(start_date)) {
      return res.status(400).json({ error: 'start_date must be in YYYY-MM-DD format' });
    }
    const recurrenceError = validateRecurrenceFields(req.body);
    if (recurrenceError) return res.status(400).json({ error: recurrenceError });

    const startDt = (start_date && isValidDateStr(start_date))
      ? start_date
      : new Date().toISOString().split('T')[0];
    const nextDue = startDt;

    const result = await db.prepare(`
      INSERT INTO tasks (organization_id, title, description, assignee, category, priority, recurrence, custom_days, day_of_week, day_of_month, start_date, next_due)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.orgId,
      title,
      description || '',
      assignee || '',
      category || 'General',
      priority || 'Medium',
      recurrence || 'daily',
      custom_days || null,
      day_of_week ?? null,
      day_of_month || null,
      startDt,
      nextDue
    );

    const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(task);
  });

  // Update task
  app.put('/api/tasks/:id', requireOrgContext, requireOpsAccess, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM tasks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    for (const dateField of ['start_date', 'next_due']) {
      const v = req.body[dateField];
      if (v !== undefined && v !== null && v !== '' && !isValidDateStr(v)) {
        return res.status(400).json({ error: `${dateField} must be in YYYY-MM-DD format` });
      }
    }
    const recurrenceError = validateRecurrenceFields(req.body);
    if (recurrenceError) return res.status(400).json({ error: recurrenceError });

    const fields = ['title', 'description', 'assignee', 'category', 'priority', 'recurrence', 'custom_days', 'day_of_week', 'day_of_month', 'start_date', 'next_due', 'is_active'];
    const updates = [];
    const params = [];

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        params.push(req.body[f]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);

    await db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
    const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    res.json(task);
  });

  // Complete a task series (upsert the instance for next_due, mark completed, advance next_due)
  async function completeTaskSeries(orgId,id,body) {
    const req={orgId,params:{id},body,method:'POST',path:'/api/tasks/:id/complete'.replace(':id',id)};
    return db.transaction(async()=>{
      await db.get('SELECT pg_advisory_xact_lock(?)',orgId);
      await require('../middleware/route-handling').validateRequest(req,db);
    const task = await db.prepare('SELECT * FROM tasks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!task) throw new HttpError(404, 'Task not found');

    if (!task.is_active) throw new HttpError(409, 'This task is inactive');
    if (req.body.expected_due && req.body.expected_due !== task.next_due) throw new HttpError(409, 'This task has already advanced. Refresh before completing another occurrence.');
    const existingOutcome = await db.get('SELECT status FROM task_instances WHERE organization_id=? AND task_id=? AND scheduled_date=?', req.orgId, task.id, task.next_due);
    if (existingOutcome && existingOutcome.status !== 'pending') throw new HttpError(409, 'This occurrence is already completed or skipped. Refresh or reopen it first.');
    const scheduled = task.next_due;
    await db.prepare(
      `INSERT INTO task_instances (organization_id, task_id, scheduled_date, status, completed_by, completed_at, notes)
       VALUES (?, ?, ?, 'completed', ?, NOW(), ?)
       ON CONFLICT (task_id, scheduled_date) DO UPDATE
         SET status = 'completed',
             completed_by = EXCLUDED.completed_by,
             completed_at = NOW(),
             notes = EXCLUDED.notes,
             updated_at = NOW()`
    ).run(req.orgId, task.id, scheduled, req.body.completed_by || '', req.body.notes || '');

    const instance = await db.prepare(
      'SELECT * FROM task_instances WHERE task_id = ? AND scheduled_date = ? AND organization_id = ?'
    ).get(task.id, scheduled, req.orgId);

    const nextDue = await syncNextDue(db, req.orgId, task.id);

    // Improvement 7: fire-and-forget process event
    emitEvent(req.orgId, `task-${task.id}-${task.next_due}`, 'task_cycle', 'task_completed',
      req.body.completed_by || '',
      { task_title: task.title, category: task.category, priority: task.priority,
        instance_id: instance.id });

    fireWebhooks(req.orgId, 'task_complete', {
      id: task.id, title: task.title, category: task.category,
      priority: task.priority, completed_by: req.body.completed_by || '', next_due: nextDue,
    });

    const updated = await db.prepare('SELECT * FROM tasks WHERE id = ? AND organization_id = ?').get(task.id, req.orgId);
    return ({ ...updated, instance_id: instance.id });
    });
  }

  app.post('/api/tasks/:id/complete', requireOrgContext, requireOpsAccess, async (req, res) => {
    res.json(await completeTaskSeries(req.orgId,req.params.id,req.body));
  });

  // Delete task
  app.delete('/api/tasks/:id', requireOrgContext, requireOpsAccess, async (req, res) => {
    const result = await db.prepare('DELETE FROM tasks WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
    if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true });
  });

  return { completeTaskSeries };
}

module.exports = { registerTasksRoutes };
