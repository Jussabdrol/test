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

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Recurring Task Manager running at http://localhost:${PORT}`);
});
