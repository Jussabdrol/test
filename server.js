const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Database Setup ---
const db = new Database(path.join(__dirname, 'tasks.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    assignee TEXT DEFAULT '',
    category TEXT DEFAULT 'General',
    priority TEXT DEFAULT 'Medium' CHECK(priority IN ('Low','Medium','High','Critical')),
    recurrence TEXT NOT NULL DEFAULT 'daily' CHECK(recurrence IN ('daily','weekly','biweekly','monthly','quarterly','yearly','custom')),
    custom_days INTEGER DEFAULT NULL,
    day_of_week INTEGER DEFAULT NULL,
    day_of_month INTEGER DEFAULT NULL,
    start_date TEXT NOT NULL,
    next_due TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    completed_by TEXT DEFAULT '',
    completed_at TEXT DEFAULT (datetime('now')),
    notes TEXT DEFAULT '',
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    completion_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    assignee TEXT DEFAULT '',
    priority TEXT DEFAULT 'Medium' CHECK(priority IN ('Low','Medium','High','Critical')),
    status TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','closed')),
    due_date TEXT DEFAULT NULL,
    resolved_by TEXT DEFAULT '',
    resolved_at TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (completion_id) REFERENCES completions(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    standard TEXT DEFAULT 'ISO 9001',
    scope TEXT DEFAULT '',
    lead_auditor TEXT DEFAULT '',
    audit_team TEXT DEFAULT '',
    status TEXT DEFAULT 'planned' CHECK(status IN ('planned','in_progress','completed','cancelled')),
    planned_date TEXT DEFAULT NULL,
    completed_date TEXT DEFAULT NULL,
    summary TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_checklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_id INTEGER NOT NULL,
    clause TEXT NOT NULL,
    requirement TEXT DEFAULT '',
    evidence TEXT DEFAULT '',
    finding TEXT DEFAULT '',
    rating TEXT DEFAULT 'not_assessed' CHECK(rating IN ('not_assessed','conforming','observation','minor_nc','major_nc')),
    notes TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS non_conformities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_id INTEGER NOT NULL,
    checklist_item_id INTEGER DEFAULT NULL,
    clause TEXT DEFAULT '',
    description TEXT NOT NULL,
    severity TEXT DEFAULT 'minor' CHECK(severity IN ('minor','major')),
    root_cause TEXT DEFAULT '',
    correction TEXT DEFAULT '',
    corrective_action TEXT DEFAULT '',
    responsible TEXT DEFAULT '',
    due_date TEXT DEFAULT NULL,
    status TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','closed','verified')),
    closed_date TEXT DEFAULT NULL,
    verification_notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE,
    FOREIGN KEY (checklist_item_id) REFERENCES audit_checklist(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS standard_requirements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    standard TEXT NOT NULL DEFAULT 'ISO 9001',
    clause TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT DEFAULT '',
    category TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// --- Helper: compute next due date ---
function computeNextDue(fromDate, recurrence, customDays, dayOfWeek, dayOfMonth) {
  const d = new Date(fromDate);
  switch (recurrence) {
    case 'daily':
      d.setDate(d.getDate() + 1);
      break;
    case 'weekly':
      d.setDate(d.getDate() + 7);
      break;
    case 'biweekly':
      d.setDate(d.getDate() + 14);
      break;
    case 'monthly':
      d.setMonth(d.getMonth() + 1);
      if (dayOfMonth) d.setDate(Math.min(dayOfMonth, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
      break;
    case 'quarterly':
      d.setMonth(d.getMonth() + 3);
      break;
    case 'yearly':
      d.setFullYear(d.getFullYear() + 1);
      break;
    case 'custom':
      d.setDate(d.getDate() + (customDays || 1));
      break;
  }
  return d.toISOString().split('T')[0];
}

// --- API Routes ---

// Get all tasks with optional filters
app.get('/api/tasks', (req, res) => {
  const { active, assignee, category, priority, overdue } = req.query;
  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];

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
  if (priority) {
    sql += ' AND priority = ?';
    params.push(priority);
  }
  if (overdue === 'true') {
    sql += ' AND next_due < date("now")';
  }

  sql += ' ORDER BY next_due ASC';
  const tasks = db.prepare(sql).all(...params);
  res.json(tasks);
});

// Get dashboard stats
app.get('/api/dashboard', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const stats = {
    totalActive: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE is_active = 1').get().c,
    dueToday: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE is_active = 1 AND next_due = ?').get(today).c,
    overdue: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE is_active = 1 AND next_due < ?').get(today).c,
    completedThisWeek: db.prepare(`SELECT COUNT(*) as c FROM completions WHERE completed_at >= date('now', '-7 days')`).get().c,
    completedThisMonth: db.prepare(`SELECT COUNT(*) as c FROM completions WHERE completed_at >= date('now', '-30 days')`).get().c,
    byCategory: db.prepare('SELECT category, COUNT(*) as count FROM tasks WHERE is_active = 1 GROUP BY category').all(),
    byPriority: db.prepare('SELECT priority, COUNT(*) as count FROM tasks WHERE is_active = 1 GROUP BY priority').all(),
    byAssignee: db.prepare("SELECT assignee, COUNT(*) as count FROM tasks WHERE is_active = 1 AND assignee != '' GROUP BY assignee").all(),
    upcomingTasks: db.prepare('SELECT * FROM tasks WHERE is_active = 1 AND next_due >= ? ORDER BY next_due ASC LIMIT 10').all(today),
    overdueTasks: db.prepare('SELECT * FROM tasks WHERE is_active = 1 AND next_due < ? ORDER BY next_due ASC').all(today),
    openActions: db.prepare("SELECT COUNT(*) as c FROM actions WHERE status IN ('open','in_progress')").get().c,
    overdueActions: db.prepare("SELECT COUNT(*) as c FROM actions WHERE status IN ('open','in_progress') AND due_date < ? AND due_date IS NOT NULL").get(today).c,
  };

  // KPI: Actions per check
  const totalCompletions = db.prepare('SELECT COUNT(*) as c FROM completions').get().c;
  const totalActionsAll = db.prepare('SELECT COUNT(*) as c FROM actions').get().c;
  stats.actionsPerCheck = totalCompletions > 0 ? +(totalActionsAll / totalCompletions).toFixed(2) : 0;
  stats.totalCompletions = totalCompletions;
  stats.totalActionsCount = totalActionsAll;

  // Actions per check this month vs last month
  const actionsThisMonth = db.prepare("SELECT COUNT(*) as c FROM actions WHERE created_at >= date('now','start of month')").get().c;
  const completionsThisMonth = db.prepare("SELECT COUNT(*) as c FROM completions WHERE completed_at >= date('now','start of month')").get().c;
  const actionsLastMonth = db.prepare("SELECT COUNT(*) as c FROM actions WHERE created_at >= date('now','start of month','-1 month') AND created_at < date('now','start of month')").get().c;
  const completionsLastMonth = db.prepare("SELECT COUNT(*) as c FROM completions WHERE completed_at >= date('now','start of month','-1 month') AND completed_at < date('now','start of month')").get().c;
  stats.actionsPerCheckThisMonth = completionsThisMonth > 0 ? +(actionsThisMonth / completionsThisMonth).toFixed(2) : 0;
  stats.actionsPerCheckLastMonth = completionsLastMonth > 0 ? +(actionsLastMonth / completionsLastMonth).toFixed(2) : 0;

  // KPI: On-time completion trend (last 30 days vs previous 30 days)
  const allTasks = db.prepare('SELECT id, recurrence, custom_days FROM tasks').all();
  const taskRecMap = {};
  for (const t of allTasks) taskRecMap[t.id] = t;

  function getIntervalDays(rec, customDays) {
    switch(rec) {
      case 'daily': return 1; case 'weekly': return 7; case 'biweekly': return 14;
      case 'monthly': return 30; case 'quarterly': return 91; case 'yearly': return 365;
      case 'custom': return customDays || 1; default: return 30;
    }
  }

  const recent30 = db.prepare("SELECT task_id, completed_at FROM completions WHERE completed_at >= date('now','-30 days') ORDER BY completed_at ASC").all();
  const prev30 = db.prepare("SELECT task_id, completed_at FROM completions WHERE completed_at >= date('now','-60 days') AND completed_at < date('now','-30 days') ORDER BY completed_at ASC").all();

  function calcOnTimeRate(completions) {
    if (completions.length === 0) return null;
    let onTime = 0, total = 0;
    const byTask = {};
    for (const c of completions) {
      if (!byTask[c.task_id]) byTask[c.task_id] = [];
      byTask[c.task_id].push(c.completed_at.split(' ')[0]);
    }
    for (const [taskId, dates] of Object.entries(byTask)) {
      const rec = taskRecMap[taskId];
      if (!rec) continue;
      const interval = getIntervalDays(rec.recurrence, rec.custom_days);
      dates.sort();
      for (let i = 0; i < dates.length; i++) {
        total++;
        if (i === 0) { onTime++; continue; }
        const gap = (new Date(dates[i]) - new Date(dates[i-1])) / (86400000);
        if (gap <= interval * 1.5) onTime++;
      }
    }
    return total > 0 ? Math.round((onTime / total) * 100) : null;
  }

  stats.onTimeRateCurrent = calcOnTimeRate(recent30);
  stats.onTimeRatePrevious = calcOnTimeRate(prev30);

  res.json(stats);
});

// Get single task with completion history
app.get('/api/tasks/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const completions = db.prepare('SELECT * FROM completions WHERE task_id = ? ORDER BY completed_at DESC LIMIT 20').all(req.params.id);
  res.json({ ...task, completions });
});

// Create task
app.post('/api/tasks', (req, res) => {
  const { title, description, assignee, category, priority, recurrence, custom_days, day_of_week, day_of_month, start_date } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const startDt = start_date || new Date().toISOString().split('T')[0];
  const nextDue = startDt;

  const result = db.prepare(`
    INSERT INTO tasks (title, description, assignee, category, priority, recurrence, custom_days, day_of_week, day_of_month, start_date, next_due)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    title,
    description || '',
    assignee || '',
    category || 'General',
    priority || 'Medium',
    recurrence || 'daily',
    custom_days || null,
    day_of_week || null,
    day_of_month || null,
    startDt,
    nextDue
  );

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(task);
});

// Update task
app.put('/api/tasks/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });

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

  db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  res.json(task);
});

// Complete a task (mark done + advance next_due)
app.post('/api/tasks/:id/complete', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const completionResult = db.prepare('INSERT INTO completions (task_id, completed_by, notes) VALUES (?, ?, ?)').run(
    task.id,
    req.body.completed_by || '',
    req.body.notes || ''
  );

  const nextDue = computeNextDue(task.next_due, task.recurrence, task.custom_days, task.day_of_week, task.day_of_month);
  db.prepare("UPDATE tasks SET next_due = ?, updated_at = datetime('now') WHERE id = ?").run(nextDue, task.id);

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
  res.json({ ...updated, completion_id: completionResult.lastInsertRowid });
});

// Delete task
app.delete('/api/tasks/:id', (req, res) => {
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
  res.json({ success: true });
});

// Get completion history
app.get('/api/completions', (req, res) => {
  const { task_id, limit } = req.query;
  let sql = `SELECT c.*, t.title as task_title,
    (SELECT COUNT(*) FROM actions a WHERE a.completion_id = c.id) as action_count,
    (SELECT COUNT(*) FROM actions a WHERE a.completion_id = c.id AND a.status IN ('open','in_progress')) as open_action_count
    FROM completions c JOIN tasks t ON c.task_id = t.id`;
  const params = [];
  if (task_id) {
    sql += ' WHERE c.task_id = ?';
    params.push(task_id);
  }
  sql += ' ORDER BY c.completed_at DESC LIMIT ?';
  params.push(parseInt(limit) || 50);
  res.json(db.prepare(sql).all(...params));
});

// Get unique assignees and categories for filters
app.get('/api/meta', (req, res) => {
  const assignees = db.prepare("SELECT DISTINCT assignee FROM tasks WHERE assignee != '' ORDER BY assignee").all().map(r => r.assignee);
  const categories = db.prepare('SELECT DISTINCT category FROM tasks ORDER BY category').all().map(r => r.category);
  res.json({ assignees, categories });
});

// Get yearly plan data (all due dates + completions for a year)
app.get('/api/yearly', (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  // Get all active tasks and project their due dates across the year
  const tasks = db.prepare('SELECT * FROM tasks WHERE is_active = 1').all();
  const dueDates = {}; // { "2026-03-15": [{ task_id, title, ... }] }

  for (const task of tasks) {
    let d = new Date(task.start_date);
    // If task started before this year, advance to first occurrence in this year
    const yearStart = new Date(startDate);
    while (d < yearStart) {
      d = new Date(computeNextDue(d.toISOString().split('T')[0], task.recurrence, task.custom_days, task.day_of_week, task.day_of_month));
    }
    // Generate all occurrences within the year
    const yearEnd = new Date(endDate);
    let safety = 0;
    while (d <= yearEnd && safety < 400) {
      const ds = d.toISOString().split('T')[0];
      if (!dueDates[ds]) dueDates[ds] = [];
      dueDates[ds].push({
        task_id: task.id,
        title: task.title,
        assignee: task.assignee,
        category: task.category,
        priority: task.priority,
        recurrence: task.recurrence,
        type: 'due',
      });
      d = new Date(computeNextDue(ds, task.recurrence, task.custom_days, task.day_of_week, task.day_of_month));
      safety++;
    }
  }

  // Get completions for this year
  const completions = db.prepare(
    `SELECT c.*, t.title, t.assignee, t.category, t.priority, t.recurrence
     FROM completions c JOIN tasks t ON c.task_id = t.id
     WHERE c.completed_at >= ? AND c.completed_at <= ?`
  ).all(startDate, endDate + ' 23:59:59');

  const completedDates = {};
  for (const c of completions) {
    const ds = c.completed_at.split(' ')[0];
    if (!completedDates[ds]) completedDates[ds] = [];
    completedDates[ds].push({
      task_id: c.task_id,
      title: c.title,
      assignee: c.assignee,
      category: c.category,
      priority: c.priority,
      recurrence: c.recurrence,
      completed_by: c.completed_by,
      type: 'completed',
    });
  }

  res.json({ year, dueDates, completedDates });
});

// --- Follow-up Actions API ---

// Get all actions with optional filters
app.get('/api/actions', (req, res) => {
  const { task_id, completion_id, status } = req.query;
  let sql = `SELECT a.*, t.title as task_title FROM actions a JOIN tasks t ON a.task_id = t.id WHERE 1=1`;
  const params = [];
  if (task_id) { sql += ' AND a.task_id = ?'; params.push(task_id); }
  if (completion_id) { sql += ' AND a.completion_id = ?'; params.push(completion_id); }
  if (status) { sql += ' AND a.status = ?'; params.push(status); }
  sql += ' ORDER BY a.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// Get single action
app.get('/api/actions/:id', (req, res) => {
  const action = db.prepare('SELECT a.*, t.title as task_title FROM actions a JOIN tasks t ON a.task_id = t.id WHERE a.id = ?').get(req.params.id);
  if (!action) return res.status(404).json({ error: 'Action not found' });
  res.json(action);
});

// Create action (linked to a completion)
app.post('/api/actions', (req, res) => {
  const { completion_id, task_id, title, description, assignee, priority, due_date } = req.body;
  if (!title || !completion_id || !task_id) return res.status(400).json({ error: 'title, completion_id, and task_id are required' });

  const result = db.prepare(`
    INSERT INTO actions (completion_id, task_id, title, description, assignee, priority, due_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(completion_id, task_id, title, description || '', assignee || '', priority || 'Medium', due_date || null);

  const action = db.prepare('SELECT * FROM actions WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(action);
});

// Update action
app.put('/api/actions/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM actions WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Action not found' });

  const fields = ['title', 'description', 'assignee', 'priority', 'status', 'due_date', 'resolved_by'];
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
    updates.push("resolved_at = datetime('now')");
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);

  db.prepare(`UPDATE actions SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const action = db.prepare('SELECT * FROM actions WHERE id = ?').get(req.params.id);
  res.json(action);
});

// Delete action
app.delete('/api/actions/:id', (req, res) => {
  const result = db.prepare('DELETE FROM actions WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Action not found' });
  res.json({ success: true });
});

// --- Audit API ---

// List audits
app.get('/api/audits', (req, res) => {
  const { status } = req.query;
  let sql = 'SELECT * FROM audits WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY planned_date DESC, created_at DESC';
  const audits = db.prepare(sql).all(...params);
  // Attach counts
  for (const a of audits) {
    a.checklist_count = db.prepare('SELECT COUNT(*) as c FROM audit_checklist WHERE audit_id = ?').get(a.id).c;
    a.assessed_count = db.prepare("SELECT COUNT(*) as c FROM audit_checklist WHERE audit_id = ? AND rating != 'not_assessed'").get(a.id).c;
    a.nc_count = db.prepare("SELECT COUNT(*) as c FROM audit_checklist WHERE audit_id = ? AND rating IN ('minor_nc','major_nc')").get(a.id).c;
    a.ncr_count = db.prepare('SELECT COUNT(*) as c FROM non_conformities WHERE audit_id = ?').get(a.id).c;
    a.open_nc_count = db.prepare("SELECT COUNT(*) as c FROM non_conformities WHERE audit_id = ? AND status IN ('open','in_progress')").get(a.id).c;
  }
  res.json(audits);
});

// Get single audit with checklist and NCs
app.get('/api/audits/:id', (req, res) => {
  const audit = db.prepare('SELECT * FROM audits WHERE id = ?').get(req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  audit.checklist = db.prepare('SELECT * FROM audit_checklist WHERE audit_id = ? ORDER BY sort_order, id').all(audit.id);
  audit.non_conformities = db.prepare('SELECT * FROM non_conformities WHERE audit_id = ? ORDER BY created_at DESC').all(audit.id);
  res.json(audit);
});

// Create audit
app.post('/api/audits', (req, res) => {
  const { title, standard, scope, lead_auditor, audit_team, planned_date, requirement_ids } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const createAudit = db.transaction(() => {
    const result = db.prepare(`INSERT INTO audits (title, standard, scope, lead_auditor, audit_team, planned_date) VALUES (?, ?, ?, ?, ?, ?)`).run(
      title, standard || 'ISO 9001', scope || '', lead_auditor || '', audit_team || '', planned_date || null
    );
    const auditId = result.lastInsertRowid;

    // Auto-create checklist items from selected requirements
    if (requirement_ids && Array.isArray(requirement_ids) && requirement_ids.length > 0) {
      const insertCl = db.prepare('INSERT INTO audit_checklist (audit_id, clause, requirement, sort_order) VALUES (?, ?, ?, ?)');
      const getReq = db.prepare('SELECT * FROM standard_requirements WHERE id = ?');
      let order = 1;
      for (const reqId of requirement_ids) {
        const req = getReq.get(reqId);
        if (req) {
          insertCl.run(auditId, req.clause, req.title, order++);
        }
      }
    }

    return db.prepare('SELECT * FROM audits WHERE id = ?').get(auditId);
  });

  const audit = createAudit();
  res.status(201).json(audit);
});

// Update audit
app.put('/api/audits/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM audits WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Audit not found' });
  const fields = ['title', 'standard', 'scope', 'lead_auditor', 'audit_team', 'status', 'planned_date', 'completed_date', 'summary'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE audits SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  // Add checklist items from newly selected requirements (skip existing clauses)
  if (req.body.requirement_ids && Array.isArray(req.body.requirement_ids)) {
    const existingClauses = db.prepare('SELECT clause FROM audit_checklist WHERE audit_id = ?').all(req.params.id).map(c => c.clause);
    const insertCl = db.prepare('INSERT INTO audit_checklist (audit_id, clause, requirement, sort_order) VALUES (?, ?, ?, ?)');
    const getReq = db.prepare('SELECT * FROM standard_requirements WHERE id = ?');
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM audit_checklist WHERE audit_id = ?').get(req.params.id).m;
    let order = maxOrder + 1;
    for (const reqId of req.body.requirement_ids) {
      const r = getReq.get(reqId);
      if (r && !existingClauses.includes(r.clause)) {
        insertCl.run(req.params.id, r.clause, r.title, order++);
      }
    }
  }

  res.json(db.prepare('SELECT * FROM audits WHERE id = ?').get(req.params.id));
});

// Delete audit
app.delete('/api/audits/:id', (req, res) => {
  const result = db.prepare('DELETE FROM audits WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Audit not found' });
  res.json({ success: true });
});

// --- Audit Checklist API ---

// Add checklist item
app.post('/api/audits/:id/checklist', (req, res) => {
  const { clause, requirement, sort_order } = req.body;
  if (!clause) return res.status(400).json({ error: 'Clause is required' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM audit_checklist WHERE audit_id = ?').get(req.params.id).m;
  const result = db.prepare('INSERT INTO audit_checklist (audit_id, clause, requirement, sort_order) VALUES (?, ?, ?, ?)').run(
    req.params.id, clause, requirement || '', sort_order ?? maxOrder + 1
  );
  res.status(201).json(db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(result.lastInsertRowid));
});

// Update checklist item (during execution)
app.put('/api/checklist/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Checklist item not found' });
  const fields = ['clause', 'requirement', 'evidence', 'finding', 'rating', 'notes', 'sort_order'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE audit_checklist SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  // Auto-create or remove NCR when rating changes
  if (req.body.rating) {
    const isNc = req.body.rating === 'minor_nc' || req.body.rating === 'major_nc';
    const existingNcr = db.prepare('SELECT * FROM non_conformities WHERE checklist_item_id = ?').get(req.params.id);

    if (isNc && !existingNcr) {
      // Auto-create NCR with populated fields from checklist item
      const cl = db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(req.params.id);
      const severity = req.body.rating === 'major_nc' ? 'major' : 'minor';
      const description = cl.finding || `Non-conformity found for clause ${cl.clause}`;
      db.prepare(`INSERT INTO non_conformities (audit_id, checklist_item_id, clause, description, severity) VALUES (?, ?, ?, ?, ?)`).run(
        existing.audit_id, req.params.id, cl.clause, description, severity
      );
    } else if (isNc && existingNcr) {
      // Update severity if it changed (e.g. minor_nc -> major_nc)
      const severity = req.body.rating === 'major_nc' ? 'major' : 'minor';
      if (existingNcr.severity !== severity) {
        db.prepare("UPDATE non_conformities SET severity = ?, updated_at = datetime('now') WHERE id = ?").run(severity, existingNcr.id);
      }
    } else if (!isNc && existingNcr && existingNcr.status === 'open') {
      // Remove auto-created NCR if rating changed away from NC and NCR is still open
      db.prepare('DELETE FROM non_conformities WHERE id = ?').run(existingNcr.id);
    }
  }

  res.json(db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(req.params.id));
});

// Delete checklist item
app.delete('/api/checklist/:id', (req, res) => {
  const result = db.prepare('DELETE FROM audit_checklist WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Item not found' });
  res.json({ success: true });
});

// --- Non-Conformity API ---

// List NCs (optionally filter by audit)
app.get('/api/ncrs', (req, res) => {
  const { audit_id, status } = req.query;
  let sql = `SELECT n.*, a.title as audit_title FROM non_conformities n JOIN audits a ON n.audit_id = a.id WHERE 1=1`;
  const params = [];
  if (audit_id) { sql += ' AND n.audit_id = ?'; params.push(audit_id); }
  if (status) { sql += ' AND n.status = ?'; params.push(status); }
  sql += ' ORDER BY n.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// Create NC
app.post('/api/ncrs', (req, res) => {
  const { audit_id, checklist_item_id, clause, description, severity, root_cause, correction, corrective_action, responsible, due_date } = req.body;
  if (!audit_id || !description) return res.status(400).json({ error: 'audit_id and description are required' });
  const result = db.prepare(`INSERT INTO non_conformities (audit_id, checklist_item_id, clause, description, severity, root_cause, correction, corrective_action, responsible, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    audit_id, checklist_item_id || null, clause || '', description, severity || 'minor', root_cause || '', correction || '', corrective_action || '', responsible || '', due_date || null
  );
  // If linked to checklist item, update its rating
  if (checklist_item_id) {
    const rating = (severity === 'major') ? 'major_nc' : 'minor_nc';
    db.prepare('UPDATE audit_checklist SET rating = ? WHERE id = ?').run(rating, checklist_item_id);
  }
  res.status(201).json(db.prepare('SELECT * FROM non_conformities WHERE id = ?').get(result.lastInsertRowid));
});

// Update NC
app.put('/api/ncrs/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM non_conformities WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'NCR not found' });
  const fields = ['clause', 'description', 'severity', 'root_cause', 'correction', 'corrective_action', 'responsible', 'due_date', 'status', 'verification_notes'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (req.body.status === 'closed' || req.body.status === 'verified') {
    updates.push("closed_date = date('now')");
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE non_conformities SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM non_conformities WHERE id = ?').get(req.params.id));
});

// Delete NC
app.delete('/api/ncrs/:id', (req, res) => {
  const result = db.prepare('DELETE FROM non_conformities WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'NCR not found' });
  res.json({ success: true });
});

// --- Standard Requirements API ---

// List requirements (optionally filter by standard), enriched with audit history
app.get('/api/requirements', (req, res) => {
  const { standard } = req.query;
  let sql = 'SELECT * FROM standard_requirements WHERE 1=1';
  const params = [];
  if (standard) { sql += ' AND standard = ?'; params.push(standard); }
  sql += ' ORDER BY standard, sort_order, clause';
  const reqs = db.prepare(sql).all(...params);

  // Enrich each requirement with audit history
  for (const r of reqs) {
    // Find checklist items matching this requirement's clause and standard
    const auditHistory = db.prepare(`
      SELECT a.id as audit_id, a.title as audit_title, a.planned_date, a.completed_date, a.status as audit_status,
             cl.rating, cl.id as checklist_item_id
      FROM audit_checklist cl
      JOIN audits a ON cl.audit_id = a.id
      WHERE cl.clause = ? AND a.standard = ?
      ORDER BY COALESCE(a.completed_date, a.planned_date) DESC
    `).all(r.clause, r.standard);

    // Last audited info
    const completedAudits = auditHistory.filter(h => h.audit_status === 'completed');
    r.last_audited = completedAudits.length > 0 ? (completedAudits[0].completed_date || completedAudits[0].planned_date) : null;
    r.last_audit_title = completedAudits.length > 0 ? completedAudits[0].audit_title : null;
    r.last_rating = completedAudits.length > 0 ? completedAudits[0].rating : null;
    r.times_audited = completedAudits.length;

    // NC info for this clause + standard
    const ncs = db.prepare(`
      SELECT n.id, n.status, n.severity
      FROM non_conformities n
      JOIN audits a ON n.audit_id = a.id
      WHERE n.clause = ? AND a.standard = ?
    `).all(r.clause, r.standard);

    r.nc_total = ncs.length;
    r.nc_open = ncs.filter(n => n.status === 'open' || n.status === 'in_progress').length;
    r.nc_closed = ncs.filter(n => n.status === 'closed' || n.status === 'verified').length;
  }

  res.json(reqs);
});

// Get unique standards list
app.get('/api/requirements/standards', (req, res) => {
  const standards = db.prepare('SELECT DISTINCT standard FROM standard_requirements ORDER BY standard').all().map(r => r.standard);
  res.json(standards);
});

// Create requirement
app.post('/api/requirements', (req, res) => {
  const { standard, clause, title, description, category, sort_order } = req.body;
  if (!clause) return res.status(400).json({ error: 'Clause is required' });
  const result = db.prepare(`INSERT INTO standard_requirements (standard, clause, title, description, category, sort_order) VALUES (?, ?, ?, ?, ?, ?)`).run(
    standard || 'ISO 9001', clause, title || '', description || '', category || '', sort_order ?? 0
  );
  res.status(201).json(db.prepare('SELECT * FROM standard_requirements WHERE id = ?').get(result.lastInsertRowid));
});

// Bulk import requirements
app.post('/api/requirements/bulk', (req, res) => {
  const { standard, items } = req.body;
  if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'items array is required' });
  const std = standard || 'ISO 9001';
  const existing = db.prepare('SELECT clause FROM standard_requirements WHERE standard = ?').all(std).map(r => r.clause);
  const insert = db.prepare('INSERT INTO standard_requirements (standard, clause, title, description, category, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  let inserted = 0;
  const bulkInsert = db.transaction((items) => {
    for (const item of items) {
      if (existing.includes(item.clause)) continue;
      insert.run(std, item.clause, item.title || '', item.description || '', item.category || '', item.sort_order ?? 0);
      inserted++;
    }
  });
  bulkInsert(items);
  res.status(201).json({ inserted });
});

// Update requirement
app.put('/api/requirements/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM standard_requirements WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Requirement not found' });
  const fields = ['standard', 'clause', 'title', 'description', 'category', 'sort_order'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE standard_requirements SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM standard_requirements WHERE id = ?').get(req.params.id));
});

// Delete requirement
app.delete('/api/requirements/:id', (req, res) => {
  const result = db.prepare('DELETE FROM standard_requirements WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Requirement not found' });
  res.json({ success: true });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Recurring Task Manager running at http://localhost:${PORT}`);
});
