const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase Storage client
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);
const UPLOADS_BUCKET = 'uploads';

// File upload setup - use memory storage; files are sent to Supabase Storage
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Helper: generate a unique storage path for an uploaded file
function storageKey(folder, originalname) {
  const ext = path.extname(originalname);
  const base = path.basename(originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${folder}/${Date.now()}_${base}${ext}`;
}

// Helper: upload a buffer to Supabase Storage; returns the storage path
async function uploadToSupabase(folder, file) {
  const key = storageKey(folder, file.originalname);
  const { error } = await supabase.storage
    .from(UPLOADS_BUCKET)
    .upload(key, file.buffer, { contentType: file.mimetype, upsert: false });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
  return key;
}

// Helper: get a short-lived signed download URL from Supabase Storage
async function getSignedUrl(storagePath, expiresIn = 300) {
  const { data, error } = await supabase.storage
    .from(UPLOADS_BUCKET)
    .createSignedUrl(storagePath, expiresIn);
  if (error) throw new Error(`Supabase signed URL failed: ${error.message}`);
  return data.signedUrl;
}

// Helper: delete a file from Supabase Storage (ignores "not found" errors)
async function deleteFromSupabase(storagePath) {
  await supabase.storage.from(UPLOADS_BUCKET).remove([storagePath]);
}

app.use(express.json());

// Trust proxy for Cloud Run / Vercel (needed for secure cookies behind load balancer)
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Stateless JWT-like token helpers (HMAC-SHA256, no external dependency)
// Tokens are stored in an httpOnly cookie so the frontend doesn't change.
// ---------------------------------------------------------------------------
const TOKEN_SECRET = process.env.SESSION_SECRET || 'lettheframework-secret-key-change-in-production';
const TOKEN_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours in ms

function createToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + TOKEN_MAX_AGE })).toString('base64url');
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  if (!token) return null;
  try {
    const [header, body, signature] = token.split('.');
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(`${header}.${body}`).digest('base64url');
    if (signature !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

// Middleware: parse token from cookie and attach to req
const cookieParser = require('cookie-parser');
app.use(cookieParser());

app.use((req, res, next) => {
  const token = req.cookies?.session_token;
  const payload = verifyToken(token);
  // Attach a session-like object for backward compatibility with existing route code
  req.session = {
    userId: payload?.userId || null,
    userRole: payload?.userRole || null,
    // save() issues a new cookie (called explicitly after login)
    save(cb) {
      const newToken = createToken({ userId: req.session.userId, userRole: req.session.userRole });
      res.cookie('session_token', newToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production' || req.protocol === 'https',
        sameSite: 'lax',
        maxAge: TOKEN_MAX_AGE,
        path: '/',
      });
      if (cb) cb(null);
    },
    // destroy() clears the cookie (called on logout)
    destroy(cb) {
      res.clearCookie('session_token', { path: '/' });
      req.session.userId = null;
      req.session.userRole = null;
      if (cb) cb(null);
    },
  };
  next();
});

// Health check endpoint for Cloud Run (must be before auth middleware)
app.get('/health', async (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Auth middleware for static files - protect everything except login page
app.use((req, res, next) => {
  // Allow login page, health check, and auth endpoints
  if (req.path === '/login' || req.path === '/login.html' || req.path === '/health' || req.path.startsWith('/api/auth/')) {
    return next();
  }
  // Check authentication for all other routes
  if (!req.session.userId) {
    // For API requests, return 401
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    // For page requests, redirect to login
    return res.redirect('/login');
  }
  next();
});

// Serve login page without auth
app.get('/login', async (req, res) => {
  if (req.session.userId) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// --- Database Setup ---
// Database is initialized via db.initDatabase() in startServer() below
// Schema and migrations are handled in db.js and schema.js
// Uses Supabase PostgreSQL – no local file system dependencies

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

// --- Authentication Routes ---

// Check if user is authenticated
app.get('/api/auth/check', async (req, res) => {
  if (req.session.userId) {
    const user = await db.prepare('SELECT id, name, email, role, permissions FROM users WHERE id = ?').get(req.session.userId);
    if (user) {
      return res.json({ authenticated: true, user });
    }
  }
  res.json({ authenticated: false });
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await db.prepare('SELECT * FROM users WHERE email = ? AND status = ?').get(email, 'active');
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.password) {
      return res.status(401).json({ error: 'Account not set up. Please contact administrator.' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last active
    await db.prepare("UPDATE users SET last_active = datetime('now') WHERE id = ?").run(user.id);

    req.session.userId = user.id;
    req.session.userRole = user.role;

    // Explicitly save session to ensure it's persisted before responding
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error('Session save error:', saveErr);
        return res.status(500).json({ error: 'Session could not be saved' });
      }
      res.json({
        success: true,
        user: { id: user.id, name: user.name, email: user.email, role: user.role, permissions: user.permissions }
      });
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout
app.post('/api/auth/logout', async (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true });
  });
});

// --- API Routes ---

// Get all tasks with optional filters
app.get('/api/tasks', async (req, res) => {
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
  const tasks = await db.prepare(sql).all(...params);
  res.json(tasks);
});

// Get dashboard stats
app.get('/api/dashboard', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const stats = {
    totalActive: (await db.prepare('SELECT COUNT(*) as c FROM tasks WHERE is_active = 1').get()).c,
    dueToday: (await db.prepare('SELECT COUNT(*) as c FROM tasks WHERE is_active = 1 AND next_due = ?').get(today)).c,
    overdue: (await db.prepare('SELECT COUNT(*) as c FROM tasks WHERE is_active = 1 AND next_due < ?').get(today)).c,
    completedThisWeek: (await db.prepare(`SELECT COUNT(*) as c FROM completions WHERE completed_at >= date('now', '-7 days')`).get()).c,
    completedThisMonth: (await db.prepare(`SELECT COUNT(*) as c FROM completions WHERE completed_at >= date('now', '-30 days')`).get()).c,
    byCategory: await db.prepare('SELECT category, COUNT(*) as count FROM tasks WHERE is_active = 1 GROUP BY category').all(),
    byPriority: await db.prepare('SELECT priority, COUNT(*) as count FROM tasks WHERE is_active = 1 GROUP BY priority').all(),
    byAssignee: await db.prepare("SELECT assignee, COUNT(*) as count FROM tasks WHERE is_active = 1 AND assignee != '' GROUP BY assignee").all(),
    upcomingTasks: await db.prepare('SELECT * FROM tasks WHERE is_active = 1 AND next_due >= ? ORDER BY next_due ASC LIMIT 10').all(today),
    overdueTasks: await db.prepare('SELECT * FROM tasks WHERE is_active = 1 AND next_due < ? ORDER BY next_due ASC').all(today),
    openActions: (await db.prepare("SELECT COUNT(*) as c FROM actions WHERE status IN ('open','in_progress')").get()).c,
    overdueActions: (await db.prepare("SELECT COUNT(*) as c FROM actions WHERE status IN ('open','in_progress') AND due_date < ? AND due_date IS NOT NULL").get(today)).c,
  };

  // KPI: Actions per check
  const totalCompletions = (await db.prepare('SELECT COUNT(*) as c FROM completions').get()).c;
  const totalActionsAll = (await db.prepare('SELECT COUNT(*) as c FROM actions').get()).c;
  stats.actionsPerCheck = totalCompletions > 0 ? +(totalActionsAll / totalCompletions).toFixed(2) : 0;
  stats.totalCompletions = totalCompletions;
  stats.totalActionsCount = totalActionsAll;

  // Actions per check this month vs last month
  const actionsThisMonth = (await db.prepare("SELECT COUNT(*) as c FROM actions WHERE created_at >= date('now','start of month')").get()).c;
  const completionsThisMonth = (await db.prepare("SELECT COUNT(*) as c FROM completions WHERE completed_at >= date('now','start of month')").get()).c;
  const actionsLastMonth = (await db.prepare("SELECT COUNT(*) as c FROM actions WHERE created_at >= date('now','start of month','-1 month') AND created_at < date('now','start of month')").get()).c;
  const completionsLastMonth = (await db.prepare("SELECT COUNT(*) as c FROM completions WHERE completed_at >= date('now','start of month','-1 month') AND completed_at < date('now','start of month')").get()).c;
  stats.actionsPerCheckThisMonth = completionsThisMonth > 0 ? +(actionsThisMonth / completionsThisMonth).toFixed(2) : 0;
  stats.actionsPerCheckLastMonth = completionsLastMonth > 0 ? +(actionsLastMonth / completionsLastMonth).toFixed(2) : 0;

  // KPI: On-time completion trend (last 30 days vs previous 30 days)
  const allTasks = await db.prepare('SELECT id, recurrence, custom_days FROM tasks').all();
  const taskRecMap = {};
  for (const t of allTasks) taskRecMap[t.id] = t;

  function getIntervalDays(rec, customDays) {
    switch(rec) {
      case 'daily': return 1; case 'weekly': return 7; case 'biweekly': return 14;
      case 'monthly': return 30; case 'quarterly': return 91; case 'yearly': return 365;
      case 'custom': return customDays || 1; default: return 30;
    }
  }

  const recent30 = await db.prepare("SELECT task_id, completed_at FROM completions WHERE completed_at >= date('now','-30 days') ORDER BY completed_at ASC").all();
  const prev30 = await db.prepare("SELECT task_id, completed_at FROM completions WHERE completed_at >= date('now','-60 days') AND completed_at < date('now','-30 days') ORDER BY completed_at ASC").all();

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
app.get('/api/tasks/:id', async (req, res) => {
  const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const completions = await db.prepare('SELECT * FROM completions WHERE task_id = ? ORDER BY completed_at DESC LIMIT 20').all(req.params.id);
  res.json({ ...task, completions });
});

// Create task
app.post('/api/tasks', async (req, res) => {
  const { title, description, assignee, category, priority, recurrence, custom_days, day_of_week, day_of_month, start_date } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const startDt = start_date || new Date().toISOString().split('T')[0];
  const nextDue = startDt;

  const result = await db.prepare(`
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

  const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(task);
});

// Update task
app.put('/api/tasks/:id', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
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

  await db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  res.json(task);
});

// Complete a task (mark done + advance next_due)
app.post('/api/tasks/:id/complete', async (req, res) => {
  const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const completionResult = await db.prepare('INSERT INTO completions (task_id, completed_by, notes) VALUES (?, ?, ?)').run(
    task.id,
    req.body.completed_by || '',
    req.body.notes || ''
  );

  const nextDue = computeNextDue(task.next_due, task.recurrence, task.custom_days, task.day_of_week, task.day_of_month);
  await db.prepare("UPDATE tasks SET next_due = ?, updated_at = datetime('now') WHERE id = ?").run(nextDue, task.id);

  const updated = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
  res.json({ ...updated, completion_id: completionResult.lastInsertRowid });
});

// Delete task
app.delete('/api/tasks/:id', async (req, res) => {
  const result = await db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
  res.json({ success: true });
});

// Get completion history
app.get('/api/completions', async (req, res) => {
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
  res.json(await db.prepare(sql).all(...params));
});

// Get unique assignees and categories for filters
app.get('/api/meta', async (req, res) => {
  const assignees = (await db.prepare("SELECT DISTINCT assignee FROM tasks WHERE assignee != '' ORDER BY assignee").all()).map(r => r.assignee);
  const categories = (await db.prepare('SELECT DISTINCT category FROM tasks ORDER BY category').all()).map(r => r.category);
  res.json({ assignees, categories });
});

// Get yearly plan data (all due dates + completions for a year)
app.get('/api/yearly', async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  // Get all active tasks and project their due dates across the year
  const tasks = await db.prepare('SELECT * FROM tasks WHERE is_active = 1').all();
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
  const completions = await db.prepare(
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
app.get('/api/actions', async (req, res) => {
  const { task_id, completion_id, status } = req.query;
  let sql = `SELECT a.*, t.title as task_title FROM actions a JOIN tasks t ON a.task_id = t.id WHERE 1=1`;
  const params = [];
  if (task_id) { sql += ' AND a.task_id = ?'; params.push(task_id); }
  if (completion_id) { sql += ' AND a.completion_id = ?'; params.push(completion_id); }
  if (status) { sql += ' AND a.status = ?'; params.push(status); }
  sql += ' ORDER BY a.created_at DESC';
  res.json(await db.prepare(sql).all(...params));
});

// Get single action
app.get('/api/actions/:id', async (req, res) => {
  const action = await db.prepare('SELECT a.*, t.title as task_title FROM actions a JOIN tasks t ON a.task_id = t.id WHERE a.id = ?').get(req.params.id);
  if (!action) return res.status(404).json({ error: 'Action not found' });
  res.json(action);
});

// Create action (linked to a completion)
app.post('/api/actions', async (req, res) => {
  const { completion_id, task_id, title, description, assignee, priority, due_date } = req.body;
  if (!title || !completion_id || !task_id) return res.status(400).json({ error: 'title, completion_id, and task_id are required' });

  const result = await db.prepare(`
    INSERT INTO actions (completion_id, task_id, title, description, assignee, priority, due_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(completion_id, task_id, title, description || '', assignee || '', priority || 'Medium', due_date || null);

  const action = await db.prepare('SELECT * FROM actions WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(action);
});

// Update action
app.put('/api/actions/:id', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM actions WHERE id = ?').get(req.params.id);
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

  await db.prepare(`UPDATE actions SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const action = await db.prepare('SELECT * FROM actions WHERE id = ?').get(req.params.id);
  res.json(action);
});

// Delete action
app.delete('/api/actions/:id', async (req, res) => {
  const result = await db.prepare('DELETE FROM actions WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Action not found' });
  res.json({ success: true });
});

// --- Audit API ---

// List audits (returns parent audits with ALL events attached including first instance)
app.get('/api/audits', async (req, res) => {
  const { status, include_children } = req.query;
  let sql = 'SELECT * FROM audits WHERE parent_audit_id IS NULL';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY planned_date DESC, created_at DESC';
  const parentAudits = await db.prepare(sql).all(...params);

  // Helper function to get audit stats
  const getAuditStats = async (auditId) => {
    const checklist_count = (await db.prepare('SELECT COUNT(*) as c FROM audit_checklist WHERE audit_id = ?').get(auditId)).c;
    const assessed_count = (await db.prepare("SELECT COUNT(*) as c FROM audit_checklist WHERE audit_id = ? AND rating != 'not_assessed'").get(auditId)).c;
    const nc_count = (await db.prepare("SELECT COUNT(*) as c FROM audit_checklist WHERE audit_id = ? AND rating IN ('minor_nc','major_nc')").get(auditId)).c;
    const ncr_count = (await db.prepare('SELECT COUNT(*) as c FROM non_conformities WHERE audit_id = ?').get(auditId)).c;
    const open_nc_count = (await db.prepare("SELECT COUNT(*) as c FROM non_conformities WHERE audit_id = ? AND status IN ('open','in_progress')").get(auditId)).c;
    return { checklist_count, assessed_count, nc_count, ncr_count, open_nc_count };
  };

  // Attach counts and ALL events (including parent as event #1) for each parent
  for (const a of parentAudits) {
    const parentStats = await getAuditStats(a.id);
    Object.assign(a, parentStats);

    // Get child events for recurring audits
    const childAudits = await db.prepare('SELECT * FROM audits WHERE parent_audit_id = ? ORDER BY instance_number, planned_date').all(a.id);
    for (const c of childAudits) {
      Object.assign(c, await getAuditStats(c.id));
    }
    a.child_events = childAudits;

    // Create all_events array that includes the parent as event #1 PLUS all children
    // This allows a proper mother-child relationship where all instances are in the events list
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
      ...parentStats
    };
    a.all_events = [parentAsEvent, ...childAudits];
    a.total_instances = a.all_events.length;
  }
  res.json(parentAudits);
});

// Get single audit with checklist and NCs
app.get('/api/audits/:id', async (req, res) => {
  const audit = await db.prepare('SELECT * FROM audits WHERE id = ?').get(req.params.id);
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
app.post('/api/audits', async (req, res) => {
  const { title, standard, standards, scope, lead_auditor, audit_team, auditee, planned_date, requirement_ids, recurrence, recurrence_end_date } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  // Support both single standard (legacy) and multiple standards
  const standardsArray = standards && Array.isArray(standards) ? standards : (standard ? [standard] : ['ISO 9001']);
  const primaryStandard = standardsArray[0] || 'ISO 9001';

  try {
    const audit = await db.transaction(async () => {
      // Create the parent audit (instance 1)
      const result = await db.run(
        `INSERT INTO audits (title, standard, standards, scope, lead_auditor, audit_team, auditee, planned_date, recurrence, recurrence_end_date, parent_audit_id, instance_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        title, primaryStandard, JSON.stringify(standardsArray), scope || '', lead_auditor || '', audit_team || '', auditee || '', planned_date || null, recurrence || 'none', recurrence_end_date || null, null, 1
      );
      const parentAuditId = result.lastInsertRowid;

      // Auto-create checklist items from selected requirements, including the standard
      if (requirement_ids && Array.isArray(requirement_ids) && requirement_ids.length > 0) {
        let order = 1;
        for (const reqId of requirement_ids) {
          const reqRow = await db.get('SELECT * FROM standard_requirements WHERE id = ?', reqId);
          if (reqRow) {
            await db.run('INSERT INTO audit_checklist (audit_id, clause, requirement, standard, sort_order) VALUES (?, ?, ?, ?, ?)',
              parentAuditId, reqRow.clause, reqRow.title, reqRow.standard, order++);
          }
        }
      }

      // Create recurring audit events as child audits if recurrence is set
      if (recurrence && recurrence !== 'none' && planned_date && recurrence_end_date) {
        let nextDate = getNextRecurrenceDate(planned_date, recurrence);
        const endDate = new Date(recurrence_end_date);
        let instanceNum = 2;

        while (nextDate && new Date(nextDate) <= endDate) {
          const recurResult = await db.run(
            `INSERT INTO audits (title, standard, standards, scope, lead_auditor, audit_team, auditee, planned_date, recurrence, recurrence_end_date, parent_audit_id, instance_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            title, primaryStandard, JSON.stringify(standardsArray), scope || '', lead_auditor || '', audit_team || '', auditee || '', nextDate, recurrence, recurrence_end_date, parentAuditId, instanceNum
          );

          // Copy checklist items to recurring audit
          if (requirement_ids && Array.isArray(requirement_ids) && requirement_ids.length > 0) {
            let order = 1;
            for (const reqId of requirement_ids) {
              const reqRow = await db.get('SELECT * FROM standard_requirements WHERE id = ?', reqId);
              if (reqRow) {
                await db.run('INSERT INTO audit_checklist (audit_id, clause, requirement, standard, sort_order) VALUES (?, ?, ?, ?, ?)',
                  recurResult.lastInsertRowid, reqRow.clause, reqRow.title, reqRow.standard, order++);
              }
            }
          }

          nextDate = getNextRecurrenceDate(nextDate, recurrence);
          instanceNum++;
        }
      }

      return await db.get('SELECT * FROM audits WHERE id = ?', parentAuditId);
    });

    res.status(201).json(audit);
  } catch (err) {
    console.error('Error creating audit:', err);
    res.status(500).json({ error: 'Failed to create audit' });
  }
});

// Update audit
app.put('/api/audits/:id', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM audits WHERE id = ?').get(req.params.id);
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
  await db.prepare(`UPDATE audits SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  // Add checklist items from newly selected requirements (skip existing clauses)
  if (req.body.requirement_ids && Array.isArray(req.body.requirement_ids)) {
    const existingClauses = (await db.prepare('SELECT clause FROM audit_checklist WHERE audit_id = ?').all(req.params.id)).map(c => c.clause);
    const insertCl = db.prepare('INSERT INTO audit_checklist (audit_id, clause, requirement, sort_order) VALUES (?, ?, ?, ?)');
    const getReq = db.prepare('SELECT * FROM standard_requirements WHERE id = ?');
    const maxOrder = (await db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM audit_checklist WHERE audit_id = ?').get(req.params.id)).m;
    let order = maxOrder + 1;
    for (const reqId of req.body.requirement_ids) {
      const r = await getReq.get(reqId);
      if (r && !existingClauses.includes(r.clause)) {
        await insertCl.run(req.params.id, r.clause, r.title, order++);
      }
    }
  }

  res.json(await db.prepare('SELECT * FROM audits WHERE id = ?').get(req.params.id));
});

// Delete audit
app.delete('/api/audits/:id', async (req, res) => {
  const result = await db.prepare('DELETE FROM audits WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Audit not found' });
  res.json({ success: true });
});

// --- Audit Checklist API ---

// Add checklist item
app.post('/api/audits/:id/checklist', async (req, res) => {
  const { clause, requirement, sort_order } = req.body;
  if (!clause) return res.status(400).json({ error: 'Clause is required' });
  const maxOrder = (await db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM audit_checklist WHERE audit_id = ?').get(req.params.id)).m;
  const result = await db.prepare('INSERT INTO audit_checklist (audit_id, clause, requirement, sort_order) VALUES (?, ?, ?, ?)').run(
    req.params.id, clause, requirement || '', sort_order ?? maxOrder + 1
  );
  res.status(201).json(await db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(result.lastInsertRowid));
});

// Update checklist item (during execution)
app.put('/api/checklist/:id', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Checklist item not found' });
  const fields = ['clause', 'requirement', 'evidence', 'finding', 'rating', 'notes', 'sort_order', 'evidence_files'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);
  await db.prepare(`UPDATE audit_checklist SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  // Auto-create or remove NCR when rating changes
  if (req.body.rating) {
    const isNc = req.body.rating === 'minor_nc' || req.body.rating === 'major_nc';
    const existingNcr = await db.prepare('SELECT * FROM non_conformities WHERE checklist_item_id = ?').get(req.params.id);

    if (isNc && !existingNcr) {
      // Auto-create NCR with populated fields from checklist item
      const cl = await db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(req.params.id);
      const severity = req.body.rating === 'major_nc' ? 'major' : 'minor';
      const description = cl.finding || `Non-conformity found for clause ${cl.clause}`;
      await db.prepare(`INSERT INTO non_conformities (audit_id, checklist_item_id, clause, description, severity) VALUES (?, ?, ?, ?, ?)`).run(
        existing.audit_id, req.params.id, cl.clause, description, severity
      );
    } else if (isNc && existingNcr) {
      // Update severity if it changed (e.g. minor_nc -> major_nc)
      const severity = req.body.rating === 'major_nc' ? 'major' : 'minor';
      if (existingNcr.severity !== severity) {
        await db.prepare("UPDATE non_conformities SET severity = ?, updated_at = datetime('now') WHERE id = ?").run(severity, existingNcr.id);
      }
    } else if (!isNc && existingNcr && existingNcr.status === 'open') {
      // Remove auto-created NCR if rating changed away from NC and NCR is still open
      await db.prepare('DELETE FROM non_conformities WHERE id = ?').run(existingNcr.id);
    }
  }

  res.json(await db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(req.params.id));
});

// Delete checklist item
app.delete('/api/checklist/:id', async (req, res) => {
  const result = await db.prepare('DELETE FROM audit_checklist WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Item not found' });
  res.json({ success: true });
});

// Upload evidence file to checklist item
app.post('/api/checklist/:id/evidence', upload.single('file'), async (req, res) => {
  const item = await db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });
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

  // Update the checklist item
  await db.prepare('UPDATE audit_checklist SET evidence_files = ? WHERE id = ?').run(JSON.stringify(evidenceFiles), req.params.id);
  res.json(await db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(req.params.id));
});

// Download evidence file from checklist item
app.get('/api/checklist/:id/evidence/:fileId/download', async (req, res) => {
  const item = await db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });

  let evidenceFiles = [];
  try { evidenceFiles = JSON.parse(item.evidence_files || '[]'); } catch(e) {}

  const file = evidenceFiles.find(f => f.id == req.params.fileId);
  if (!file || file.type !== 'file') return res.status(404).json({ error: 'File not found' });

  try {
    const signedUrl = await getSignedUrl(file.path);
    res.redirect(signedUrl);
  } catch (err) {
    res.status(404).json({ error: 'File not found in storage' });
  }
});

// Delete evidence file from checklist item
app.delete('/api/checklist/:id/evidence/:fileId', async (req, res) => {
  const item = await db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(req.params.id);
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
app.post('/api/checklist/:id/evidence-link', async (req, res) => {
  const item = await db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(req.params.id);
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

// --- Non-Conformity API ---

// List NCs (optionally filter by audit)
app.get('/api/ncrs', async (req, res) => {
  const { audit_id, status } = req.query;
  let sql = `SELECT n.*, a.title as audit_title, a.standard as audit_standard,
    COALESCE(cl.standard, a.standard) as ncr_standard
    FROM non_conformities n
    JOIN audits a ON n.audit_id = a.id
    LEFT JOIN audit_checklist cl ON n.checklist_item_id = cl.id
    WHERE 1=1`;
  const params = [];
  if (audit_id) { sql += ' AND n.audit_id = ?'; params.push(audit_id); }
  if (status) { sql += ' AND n.status = ?'; params.push(status); }
  sql += ' ORDER BY n.created_at DESC';
  res.json(await db.prepare(sql).all(...params));
});

// Create NC
app.post('/api/ncrs', async (req, res) => {
  const { audit_id, checklist_item_id, clause, description, severity, root_cause, correction, corrective_action, responsible, due_date } = req.body;
  if (!audit_id || !description) return res.status(400).json({ error: 'audit_id and description are required' });
  const result = await db.prepare(`INSERT INTO non_conformities (audit_id, checklist_item_id, clause, description, severity, root_cause, correction, corrective_action, responsible, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    audit_id, checklist_item_id || null, clause || '', description, severity || 'minor', root_cause || '', correction || '', corrective_action || '', responsible || '', due_date || null
  );
  // If linked to checklist item, update its rating
  if (checklist_item_id) {
    const rating = (severity === 'major') ? 'major_nc' : 'minor_nc';
    await db.prepare('UPDATE audit_checklist SET rating = ? WHERE id = ?').run(rating, checklist_item_id);
  }
  res.status(201).json(await db.prepare('SELECT * FROM non_conformities WHERE id = ?').get(result.lastInsertRowid));
});

// Update NC
app.put('/api/ncrs/:id', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM non_conformities WHERE id = ?').get(req.params.id);
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
  await db.prepare(`UPDATE non_conformities SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(await db.prepare('SELECT * FROM non_conformities WHERE id = ?').get(req.params.id));
});

// Delete NC
app.delete('/api/ncrs/:id', async (req, res) => {
  const result = await db.prepare('DELETE FROM non_conformities WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'NCR not found' });
  res.json({ success: true });
});

// --- Standard Requirements API ---

// List requirements (optionally filter by standard), enriched with audit history
app.get('/api/requirements', async (req, res) => {
  const { standard } = req.query;
  let sql = 'SELECT * FROM standard_requirements WHERE 1=1';
  const params = [];
  if (standard) { sql += ' AND standard = ?'; params.push(standard); }
  sql += ' ORDER BY standard, sort_order, clause';
  const reqs = await db.prepare(sql).all(...params);

  // Enrich each requirement with audit history
  for (const r of reqs) {
    // Find checklist items matching this requirement's clause and standard
    // Check both checklist item's standard field and fallback to audit's standard
    const auditHistory = await db.prepare(`
      SELECT a.id as audit_id, a.title as audit_title, a.planned_date, a.completed_date, a.status as audit_status,
             cl.rating, cl.id as checklist_item_id
      FROM audit_checklist cl
      JOIN audits a ON cl.audit_id = a.id
      WHERE cl.clause = ? AND (cl.standard = ? OR (cl.standard = '' AND a.standard = ?))
      ORDER BY COALESCE(a.completed_date, a.planned_date) DESC
    `).all(r.clause, r.standard, r.standard);

    // Last audited info
    const completedAudits = auditHistory.filter(h => h.audit_status === 'completed');
    r.last_audited = completedAudits.length > 0 ? (completedAudits[0].completed_date || completedAudits[0].planned_date) : null;
    r.last_audit_title = completedAudits.length > 0 ? completedAudits[0].audit_title : null;
    r.last_rating = completedAudits.length > 0 ? completedAudits[0].rating : null;
    r.times_audited = completedAudits.length;

    // NC info for this clause + standard (check checklist item standard or audit standard)
    const ncs = await db.prepare(`
      SELECT n.id, n.status, n.severity
      FROM non_conformities n
      JOIN audits a ON n.audit_id = a.id
      LEFT JOIN audit_checklist cl ON n.checklist_item_id = cl.id
      WHERE n.clause = ? AND (COALESCE(cl.standard, a.standard) = ? OR a.standard = ?)
    `).all(r.clause, r.standard, r.standard);

    r.nc_total = ncs.length;
    r.nc_open = ncs.filter(n => n.status === 'open' || n.status === 'in_progress').length;
    r.nc_closed = ncs.filter(n => n.status === 'closed' || n.status === 'verified').length;
  }

  res.json(reqs);
});

// Get unique standards list
app.get('/api/requirements/standards', async (req, res) => {
  const standards = (await db.prepare('SELECT DISTINCT standard FROM standard_requirements ORDER BY standard').all()).map(r => r.standard);
  res.json(standards);
});

// Create requirement
app.post('/api/requirements', async (req, res) => {
  const { standard, clause, title, description, category, sort_order, owner } = req.body;
  if (!clause) return res.status(400).json({ error: 'Clause is required' });
  const result = await db.prepare(`INSERT INTO standard_requirements (standard, clause, title, description, category, sort_order, owner) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    standard || 'ISO 9001', clause, title || '', description || '', category || '', sort_order ?? 0, owner || ''
  );
  res.status(201).json(await db.prepare('SELECT * FROM standard_requirements WHERE id = ?').get(result.lastInsertRowid));
});

// Bulk import requirements
app.post('/api/requirements/bulk', async (req, res) => {
  const { standard, items } = req.body;
  if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'items array is required' });
  const std = standard || 'ISO 9001';
  const existing = (await db.all('SELECT clause FROM standard_requirements WHERE standard = ?', std)).map(r => r.clause);
  let inserted = 0;
  await db.transaction(async () => {
    for (const item of items) {
      if (existing.includes(item.clause)) continue;
      await db.run('INSERT INTO standard_requirements (standard, clause, title, description, category, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
        std, item.clause, item.title || '', item.description || '', item.category || '', item.sort_order ?? 0);
      inserted++;
    }
  });
  res.status(201).json({ inserted });
});

// Update requirement
app.put('/api/requirements/:id', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM standard_requirements WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Requirement not found' });
  const fields = ['standard', 'clause', 'title', 'description', 'category', 'sort_order', 'owner'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  await db.prepare(`UPDATE standard_requirements SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(await db.prepare('SELECT * FROM standard_requirements WHERE id = ?').get(req.params.id));
});

// Delete all requirements for a standard (retire)
app.delete('/api/requirements/standard/:standard', async (req, res) => {
  const standard = decodeURIComponent(req.params.standard);
  // Clean up SoA entries for requirements of this standard (cascade should handle, but explicit for safety)
  await db.prepare(`DELETE FROM soa_entries WHERE requirement_id IN (SELECT id FROM standard_requirements WHERE standard = ?)`).run(standard);
  const result = await db.prepare('DELETE FROM standard_requirements WHERE standard = ?').run(standard);
  res.json({ success: true, deleted: result.changes });
});

// Delete requirement
app.delete('/api/requirements/:id', async (req, res) => {
  const result = await db.prepare('DELETE FROM standard_requirements WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Requirement not found' });
  res.json({ success: true });
});

// --- Threat Intelligence API ---

// List feeds
app.get('/api/threat-feeds', async (req, res) => {
  const feeds = await db.prepare('SELECT * FROM threat_feeds ORDER BY tier, name').all();
  for (const f of feeds) {
    f.item_count = (await db.prepare('SELECT COUNT(*) as c FROM threat_items WHERE feed_id = ?').get(f.id)).c;
    f.new_count = (await db.prepare("SELECT COUNT(*) as c FROM threat_items WHERE feed_id = ? AND status = 'new'").get(f.id)).c;
  }
  res.json(feeds);
});

// Add feed
app.post('/api/threat-feeds', async (req, res) => {
  const { name, url, tier } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  const result = await db.prepare('INSERT INTO threat_feeds (name, url, tier) VALUES (?, ?, ?)').run(name, url, tier || 1);
  res.status(201).json(await db.prepare('SELECT * FROM threat_feeds WHERE id = ?').get(result.lastInsertRowid));
});

// Update feed
app.put('/api/threat-feeds/:id', async (req, res) => {
  const fields = ['name', 'url', 'tier', 'enabled'];
  const updates = []; const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);
  await db.prepare(`UPDATE threat_feeds SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(await db.prepare('SELECT * FROM threat_feeds WHERE id = ?').get(req.params.id));
});

// Delete feed
app.delete('/api/threat-feeds/:id', async (req, res) => {
  await db.prepare('DELETE FROM threat_feeds WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Fetch/refresh a single feed (server-side RSS proxy)
app.post('/api/threat-feeds/:id/fetch', async (req, res) => {
  const feed = await db.prepare('SELECT * FROM threat_feeds WHERE id = ?').get(req.params.id);
  if (!feed) return res.status(404).json({ error: 'Feed not found' });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(feed.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'LetTheFrameWork/1.0 ThreatIntelFetcher' }
    });
    clearTimeout(timeout);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();

    // Simple XML parser for RSS/Atom - extract items
    const items = [];
    // Try RSS <item> format
    const rssItems = text.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
    for (const raw of rssItems) {
      const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
      const desc = (raw.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] || '';
      const link = (raw.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '';
      const guid = (raw.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i) || [])[1] || link || title;
      const pubDate = (raw.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] || '';
      if (title || desc) items.push({ title: stripTags(title).trim(), description: stripTags(desc).trim().substring(0, 2000), link: stripTags(link).trim(), guid: stripTags(guid).trim(), pub_date: pubDate.trim() });
    }
    // Try Atom <entry> format if no RSS items found
    if (items.length === 0) {
      const atomEntries = text.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
      for (const raw of atomEntries) {
        const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
        const desc = (raw.match(/<(?:summary|content)[^>]*>([\s\S]*?)<\/(?:summary|content)>/i) || [])[1] || '';
        const linkMatch = raw.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
        const link = linkMatch ? linkMatch[1] : '';
        const idTag = (raw.match(/<id[^>]*>([\s\S]*?)<\/id>/i) || [])[1] || link || title;
        const updated = (raw.match(/<(?:updated|published)[^>]*>([\s\S]*?)<\/(?:updated|published)>/i) || [])[1] || '';
        if (title || desc) items.push({ title: stripTags(title).trim(), description: stripTags(desc).trim().substring(0, 2000), link: stripTags(link).trim(), guid: stripTags(idTag).trim(), pub_date: updated.trim() });
      }
    }

    // Upsert items
    await db.transaction(async () => {
      for (const i of items) {
        await db.run(`INSERT INTO threat_items (feed_id, guid, title, description, link, pub_date) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(feed_id, guid) DO UPDATE SET title=excluded.title, description=excluded.description, link=excluded.link, pub_date=excluded.pub_date`,
          feed.id, i.guid || i.title, i.title, i.description, i.link, i.pub_date);
      }
    });

    // Update last_fetched
    await db.prepare("UPDATE threat_feeds SET last_fetched = datetime('now') WHERE id = ?").run(feed.id);

    res.json({ success: true, count: items.length });
  } catch (err) {
    res.json({ success: false, error: err.message, count: 0 });
  }
});

// Get threat items (with filters)
app.get('/api/threat-items', async (req, res) => {
  const { feed_id, tier, status, limit: lim } = req.query;
  let sql = `SELECT ti.*, tf.name as feed_name, tf.tier FROM threat_items ti JOIN threat_feeds tf ON ti.feed_id = tf.id WHERE tf.enabled = 1`;
  const params = [];
  if (feed_id) { sql += ' AND ti.feed_id = ?'; params.push(feed_id); }
  if (tier) { sql += ' AND tf.tier = ?'; params.push(tier); }
  if (status) { sql += ' AND ti.status = ?'; params.push(status); }
  sql += ' ORDER BY ti.fetched_at DESC, ti.pub_date DESC';
  if (lim) { sql += ' LIMIT ?'; params.push(parseInt(lim)); }
  else { sql += ' LIMIT 200'; }
  res.json(await db.prepare(sql).all(...params));
});

// Update threat item status
app.put('/api/threat-items/:id', async (req, res) => {
  const { status, created_risk_id } = req.body;
  const updates = []; const params = [];
  if (status) { updates.push('status = ?'); params.push(status); }
  if (created_risk_id !== undefined) { updates.push('created_risk_id = ?'); params.push(created_risk_id); }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  await db.prepare(`UPDATE threat_items SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(await db.prepare('SELECT * FROM threat_items WHERE id = ?').get(req.params.id));
});

function stripTags(str) {
  if (!str) return '';
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// --- Risk Management API ---

// List risks
app.get('/api/risks', async (req, res) => {
  const { status, category } = req.query;
  let sql = 'SELECT * FROM risks WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  sql += ' ORDER BY inherent_score DESC, created_at DESC';
  const risks = await db.prepare(sql).all(...params);
  // Attach treatment count
  for (const r of risks) {
    r.treatment_count = (await db.prepare('SELECT COUNT(*) as c FROM risk_treatments WHERE risk_id = ?').get(r.id)).c;
    r.open_treatments = (await db.prepare("SELECT COUNT(*) as c FROM risk_treatments WHERE risk_id = ? AND status IN ('planned','in_progress')").get(r.id)).c;
  }
  res.json(risks);
});

// Get single risk with treatments
app.get('/api/risks/:id', async (req, res) => {
  const risk = await db.prepare('SELECT * FROM risks WHERE id = ?').get(req.params.id);
  if (!risk) return res.status(404).json({ error: 'Risk not found' });
  risk.treatments = await db.prepare(`SELECT rt.*, sr.clause, sr.title as requirement_title FROM risk_treatments rt LEFT JOIN standard_requirements sr ON rt.requirement_id = sr.id WHERE rt.risk_id = ? ORDER BY rt.created_at`).all(risk.id);
  res.json(risk);
});

// Create risk
app.post('/api/risks', async (req, res) => {
  const { title, description, category, source, asset, threat, vulnerability, likelihood, impact, risk_owner, status } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const result = await db.prepare(`INSERT INTO risks (title, description, category, source, asset, threat, vulnerability, likelihood, impact, risk_owner, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    title, description || '', category || 'Information Security', source || '', asset || '', threat || '', vulnerability || '', likelihood || 3, impact || 3, risk_owner || '', status || 'identified'
  );
  res.status(201).json(await db.prepare('SELECT * FROM risks WHERE id = ?').get(result.lastInsertRowid));
});

// Update risk
app.put('/api/risks/:id', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM risks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Risk not found' });
  const fields = ['title', 'description', 'category', 'source', 'asset', 'threat', 'vulnerability', 'likelihood', 'impact', 'risk_owner', 'status'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  await db.prepare(`UPDATE risks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(await db.prepare('SELECT * FROM risks WHERE id = ?').get(req.params.id));
});

// Delete risk
app.delete('/api/risks/:id', async (req, res) => {
  const result = await db.prepare('DELETE FROM risks WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Risk not found' });
  res.json({ success: true });
});

// --- Risk Treatments API ---

app.get('/api/treatments', async (req, res) => {
  const { risk_id, status } = req.query;
  let sql = `SELECT rt.*, r.title as risk_title, sr.clause, sr.title as requirement_title FROM risk_treatments rt JOIN risks r ON rt.risk_id = r.id LEFT JOIN standard_requirements sr ON rt.requirement_id = sr.id WHERE 1=1`;
  const params = [];
  if (risk_id) { sql += ' AND rt.risk_id = ?'; params.push(risk_id); }
  if (status) { sql += ' AND rt.status = ?'; params.push(status); }
  sql += ' ORDER BY rt.created_at DESC';
  res.json(await db.prepare(sql).all(...params));
});

app.post('/api/treatments', async (req, res) => {
  const { risk_id, treatment_type, description, control_reference, requirement_id, responsible, due_date, residual_likelihood, residual_impact, notes } = req.body;
  if (!risk_id) return res.status(400).json({ error: 'risk_id is required' });
  const result = await db.prepare(`INSERT INTO risk_treatments (risk_id, treatment_type, description, control_reference, requirement_id, responsible, due_date, residual_likelihood, residual_impact, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    risk_id, treatment_type || 'mitigate', description || '', control_reference || '', requirement_id || null, responsible || '', due_date || null, residual_likelihood || null, residual_impact || null, notes || ''
  );
  res.status(201).json(await db.prepare('SELECT * FROM risk_treatments WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/treatments/:id', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM risk_treatments WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Treatment not found' });
  const fields = ['treatment_type', 'description', 'control_reference', 'requirement_id', 'responsible', 'due_date', 'status', 'residual_likelihood', 'residual_impact', 'notes'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  await db.prepare(`UPDATE risk_treatments SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(await db.prepare('SELECT * FROM risk_treatments WHERE id = ?').get(req.params.id));
});

app.delete('/api/treatments/:id', async (req, res) => {
  const result = await db.prepare('DELETE FROM risk_treatments WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Treatment not found' });
  res.json({ success: true });
});

// --- Statement of Applicability API ---

app.get('/api/soa', async (req, res) => {
  // Get all Annex A requirements with their SoA status
  const reqs = await db.prepare(`SELECT sr.*, soa.id as soa_id, soa.applicable, soa.justification, soa.implementation_status, soa.notes as soa_notes, soa.linked_processes, soa.regulatory
    FROM standard_requirements sr LEFT JOIN soa_entries soa ON sr.id = soa.requirement_id
    WHERE sr.standard = 'ISO 27001 Annex A'
    ORDER BY sr.sort_order, sr.clause`).all();
  // Attach linked risk treatments (via requirement_id OR control_reference)
  const allProcesses = await db.prepare("SELECT id, name FROM org_architecture WHERE arch_type = 'process'").all();
  for (const r of reqs) {
    // Get treatments linked by requirement_id
    const linkedById = await db.prepare(`SELECT rt.id, rt.description, rt.status, ri.title as risk_title FROM risk_treatments rt JOIN risks ri ON rt.risk_id = ri.id WHERE rt.requirement_id = ?`).all(r.id);
    // Get treatments linked by control_reference (matching clause)
    const linkedByRef = await db.prepare(`SELECT rt.id, rt.description, rt.status, ri.title as risk_title FROM risk_treatments rt JOIN risks ri ON rt.risk_id = ri.id WHERE rt.control_reference = ? AND rt.control_reference != ''`).all(r.clause);
    // Combine and dedupe
    const allLinked = [...linkedById];
    for (const t of linkedByRef) {
      if (!allLinked.some(l => l.id === t.id)) allLinked.push(t);
    }
    r.linked_treatments = allLinked;
    try { r.linked_process_ids = JSON.parse(r.linked_processes || '[]'); } catch(e) { r.linked_process_ids = []; }
    r.linked_process_names = r.linked_process_ids.map(pid => { const p = allProcesses.find(x => x.id === pid); return p ? p.name : null; }).filter(Boolean);
  }
  res.json(reqs);
});

app.put('/api/soa/:requirementId', async (req, res) => {
  const reqId = req.params.requirementId;
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
    await db.prepare(`UPDATE soa_entries SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  } else {
    await db.prepare('INSERT INTO soa_entries (requirement_id, applicable, justification, implementation_status, notes, linked_processes, regulatory) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      reqId, applicable !== undefined ? (applicable ? 1 : 0) : 1, justification || '', implementation_status || 'not_implemented', notes || '', JSON.stringify(req.body.linked_processes || []), req.body.regulatory ? 1 : 0
    );
  }
  res.json({ success: true });
});

// --- Organizational Planning API ---

// Mission
app.get('/api/mission', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM org_mission WHERE id = 1').get());
});

app.put('/api/mission', async (req, res) => {
  const { content, vision, values_text } = req.body;
  await db.prepare("UPDATE org_mission SET content = ?, vision = ?, values_text = ?, updated_at = datetime('now') WHERE id = 1").run(content || '', vision || '', values_text || '');
  res.json(await db.prepare('SELECT * FROM org_mission WHERE id = 1').get());
});

// KPIs
app.get('/api/kpis', async (req, res) => {
  const kpis = await db.prepare('SELECT * FROM org_kpis ORDER BY module, name').all();
  for (const k of kpis) {
    k.values = await db.prepare('SELECT * FROM org_kpi_values WHERE kpi_id = ? ORDER BY period DESC LIMIT 12').all(k.id);
  }
  res.json(kpis);
});

// Auto-KPI data
app.get('/api/kpis/auto', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const auto = {
    // Task Management
    tasks_active: (await db.prepare('SELECT COUNT(*) as v FROM tasks WHERE is_active = 1').get()).v,
    tasks_overdue: (await db.prepare('SELECT COUNT(*) as v FROM tasks WHERE is_active = 1 AND next_due < ?').get(today)).v,
    completions_this_month: (await db.prepare("SELECT COUNT(*) as v FROM completions WHERE completed_at >= date('now','start of month')").get()).v,
    // Audits & Compliance
    audits_planned: (await db.prepare("SELECT COUNT(*) as v FROM audits WHERE status = 'planned'").get()).v,
    audits_completed: (await db.prepare("SELECT COUNT(*) as v FROM audits WHERE status = 'completed'").get()).v,
    open_ncrs: (await db.prepare("SELECT COUNT(*) as v FROM non_conformities WHERE status IN ('open','in_progress')").get()).v,
    open_actions: (await db.prepare("SELECT COUNT(*) as v FROM actions WHERE status IN ('open','in_progress')").get()).v,
    standards_count: (await db.prepare('SELECT COUNT(DISTINCT standard) as v FROM standard_requirements').get()).v,
    // Risk Management
    total_risks: (await db.prepare('SELECT COUNT(*) as v FROM risks').get()).v,
    high_risks: (await db.prepare('SELECT COUNT(*) as v FROM risks WHERE inherent_score >= 15').get()).v,
    open_treatments: (await db.prepare("SELECT COUNT(*) as v FROM risk_treatments WHERE status IN ('planned','in_progress')").get()).v,
    // SoA counts from Annex A requirements (applicable by default unless explicitly set to 0)
    soa_applicable: (await db.prepare(`SELECT COUNT(*) as v FROM standard_requirements sr
      LEFT JOIN soa_entries soa ON sr.id = soa.requirement_id
      WHERE sr.standard = 'ISO 27001 Annex A' AND (soa.applicable IS NULL OR soa.applicable = 1)`).get()).v,
    soa_implemented: (await db.prepare(`SELECT COUNT(*) as v FROM standard_requirements sr
      LEFT JOIN soa_entries soa ON sr.id = soa.requirement_id
      WHERE sr.standard = 'ISO 27001 Annex A' AND (soa.applicable IS NULL OR soa.applicable = 1) AND soa.implementation_status = 'implemented'`).get()).v,
    threat_items_new: (await db.prepare("SELECT COUNT(*) as v FROM threat_items WHERE status = 'new'").get()).v,
    // Document Control
    total_documents: (await db.prepare('SELECT COUNT(*) as v FROM documents').get()).v,
    docs_due_review: (await db.prepare('SELECT COUNT(*) as v FROM documents WHERE review_date IS NOT NULL AND review_date <= ?').get(today)).v,
    // Architecture
    arch_processes: (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE arch_type = 'process'").get()).v,
    arch_roles: (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE arch_type = 'role'").get()).v,
    arch_systems: (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE arch_type = 'system'").get()).v,
    arch_facilities: (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE arch_type = 'facility'").get()).v,
  };
  res.json(auto);
});

app.post('/api/kpis', async (req, res) => {
  const { name, description, module, target_value, unit, frequency } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const result = await db.prepare('INSERT INTO org_kpis (name, description, module, target_value, unit, frequency) VALUES (?, ?, ?, ?, ?, ?)').run(
    name, description || '', module || 'custom', target_value || null, unit || '', frequency || 'monthly'
  );
  res.status(201).json(await db.prepare('SELECT * FROM org_kpis WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/kpis/:id', async (req, res) => {
  const fields = ['name', 'description', 'module', 'target_value', 'unit', 'frequency'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);
  await db.prepare(`UPDATE org_kpis SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(await db.prepare('SELECT * FROM org_kpis WHERE id = ?').get(req.params.id));
});

app.delete('/api/kpis/:id', async (req, res) => {
  await db.prepare('DELETE FROM org_kpis WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/kpis/:id/values', async (req, res) => {
  const { value, period } = req.body;
  if (value === undefined || !period) return res.status(400).json({ error: 'value and period are required' });
  // Upsert
  const existing = await db.prepare('SELECT * FROM org_kpi_values WHERE kpi_id = ? AND period = ?').get(req.params.id, period);
  if (existing) {
    await db.prepare("UPDATE org_kpi_values SET value = ?, recorded_at = datetime('now') WHERE id = ?").run(value, existing.id);
  } else {
    await db.prepare('INSERT INTO org_kpi_values (kpi_id, value, period) VALUES (?, ?, ?)').run(req.params.id, value, period);
  }
  res.json({ success: true });
});

// Architecture
app.get('/api/architecture', async (req, res) => {
  const { arch_type } = req.query;
  let sql = 'SELECT * FROM org_architecture WHERE 1=1';
  const params = [];
  if (arch_type) { sql += ' AND arch_type = ?'; params.push(arch_type); }
  sql += ' ORDER BY arch_type, sort_order, name';
  res.json(await db.prepare(sql).all(...params));
});

app.post('/api/architecture', async (req, res) => {
  const { arch_type, name, description, parent_id, owner, status, metadata } = req.body;
  if (!arch_type || !name) return res.status(400).json({ error: 'arch_type and name are required' });
  const result = await db.prepare('INSERT INTO org_architecture (arch_type, name, description, parent_id, owner, status, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    arch_type, name, description || '', parent_id || null, owner || '', status || 'active', metadata || '{}'
  );
  res.status(201).json(await db.prepare('SELECT * FROM org_architecture WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/architecture/:id', async (req, res) => {
  const fields = ['name', 'description', 'parent_id', 'owner', 'status', 'metadata', 'sort_order'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  await db.prepare(`UPDATE org_architecture SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(await db.prepare('SELECT * FROM org_architecture WHERE id = ?').get(req.params.id));
});

app.delete('/api/architecture/:id', async (req, res) => {
  await db.prepare('DELETE FROM org_architecture WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// --- Document Control API ---

app.get('/api/documents', async (req, res) => {
  const { doc_type, status, linked_module, classification } = req.query;
  let sql = 'SELECT * FROM documents WHERE 1=1';
  const params = [];
  if (doc_type) { sql += ' AND doc_type = ?'; params.push(doc_type); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (linked_module) { sql += ' AND linked_module = ?'; params.push(linked_module); }
  if (classification) { sql += ' AND classification = ?'; params.push(classification); }
  sql += ' ORDER BY updated_at DESC';
  res.json(await db.prepare(sql).all(...params));
});

app.post('/api/documents', upload.single('file'), async (req, res) => {
  const { title, description, doc_type, version, owner, status, linked_module, linked_ref_type, linked_ref_id, review_date, classification } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const file = req.file;
  let storagePath = '';
  if (file) {
    try {
      storagePath = await uploadToSupabase('documents', file);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  const result = await db.prepare(`INSERT INTO documents (title, description, doc_type, version, owner, status, file_name, file_path, file_size, mime_type, linked_module, linked_ref_type, linked_ref_id, review_date, classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    title, description || '', doc_type || 'policy', version || '1.0', owner || '', status || 'draft',
    file ? file.originalname : '', storagePath, file ? file.size : 0, file ? file.mimetype : '',
    linked_module || '', linked_ref_type || '', linked_ref_id || null, review_date || null, classification || ''
  );
  res.status(201).json(await db.prepare('SELECT * FROM documents WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/documents/:id', upload.single('file'), async (req, res) => {
  const existing = await db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Document not found' });
  const { title, description, doc_type, version, owner, status, linked_module, linked_ref_type, linked_ref_id, review_date, classification } = req.body;
  const file = req.file;
  let storagePath = file ? '' : existing.file_path;
  if (file) {
    try {
      storagePath = await uploadToSupabase('documents', file);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    // Delete the old file from Supabase Storage
    if (existing.file_path) await deleteFromSupabase(existing.file_path);
  }
  await db.prepare(`UPDATE documents SET title=?, description=?, doc_type=?, version=?, owner=?, status=?, file_name=?, file_path=?, file_size=?, mime_type=?, linked_module=?, linked_ref_type=?, linked_ref_id=?, review_date=?, classification=?, updated_at=datetime('now') WHERE id=?`).run(
    title || existing.title, description !== undefined ? description : existing.description,
    doc_type || existing.doc_type, version || existing.version, owner !== undefined ? owner : existing.owner,
    status || existing.status,
    file ? file.originalname : existing.file_name, storagePath,
    file ? file.size : existing.file_size, file ? file.mimetype : existing.mime_type,
    linked_module !== undefined ? linked_module : existing.linked_module,
    linked_ref_type !== undefined ? linked_ref_type : existing.linked_ref_type,
    linked_ref_id !== undefined ? (linked_ref_id || null) : existing.linked_ref_id,
    review_date !== undefined ? (review_date || null) : existing.review_date,
    classification !== undefined ? classification : (existing.classification || ''),
    req.params.id
  );
  res.json(await db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id));
});

app.delete('/api/documents/:id', async (req, res) => {
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.file_path) await deleteFromSupabase(doc.file_path);
  await db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/documents/:id/download', async (req, res) => {
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc || !doc.file_path) return res.status(404).json({ error: 'File not found' });
  try {
    const signedUrl = await getSignedUrl(doc.file_path);
    res.redirect(signedUrl);
  } catch (err) {
    res.status(404).json({ error: 'File not found in storage' });
  }
});

// --- Universal Cross-Linking API ---

// Entity type resolution helpers
const entityResolvers = {
  risk: async (id) => await db.get('SELECT id, title as name FROM risks WHERE id = ?', id),
  task: async (id) => await db.get('SELECT id, title as name FROM tasks WHERE id = ?', id),
  action: async (id) => await db.get('SELECT id, title as name FROM actions WHERE id = ?', id),
  requirement: async (id) => { const r = await db.get('SELECT id, clause, title, standard FROM standard_requirements WHERE id = ?', id); return r ? { id: r.id, name: `${r.clause} - ${r.title} (${r.standard})` } : null; },
  audit: async (id) => await db.get('SELECT id, title as name FROM audits WHERE id = ?', id),
  ncr: async (id) => { const n = await db.get('SELECT id, clause, description FROM non_conformities WHERE id = ?', id); return n ? { id: n.id, name: `NCR: ${n.clause} - ${n.description.substring(0, 60)}` } : null; },
  role: async (id) => await db.get("SELECT id, name FROM org_architecture WHERE id = ? AND arch_type = 'role'", id),
  process: async (id) => await db.get("SELECT id, name FROM org_architecture WHERE id = ? AND arch_type = 'process'", id),
  system: async (id) => await db.get("SELECT id, name FROM org_architecture WHERE id = ? AND arch_type = 'system'", id),
  asset: async (id) => await db.get("SELECT id, name FROM org_architecture WHERE id = ? AND arch_type = 'asset'", id),
  facility: async (id) => await db.get("SELECT id, name FROM org_architecture WHERE id = ? AND arch_type = 'facility'", id),
  document: async (id) => await db.get('SELECT id, title as name FROM documents WHERE id = ?', id),
  treatment: async (id) => { const t = await db.get('SELECT id, description FROM risk_treatments WHERE id = ?', id); return t ? { id: t.id, name: `Treatment: ${t.description.substring(0, 60)}` } : null; },
};

// Get all cross-links for an entity
app.get('/api/cross-links/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const links = await db.prepare(`
    SELECT * FROM cross_links WHERE (source_type = ? AND source_id = ?) OR (target_type = ? AND target_id = ?)
  `).all(type, id, type, id);

  const resolved = [];
  for (const l of links) {
    const isSource = l.source_type === type && l.source_id === parseInt(id);
    const otherType = isSource ? l.target_type : l.source_type;
    const otherId = isSource ? l.target_id : l.source_id;
    const resolver = entityResolvers[otherType];
    const entity = resolver ? await resolver(otherId) : null;
    const name = entity ? entity.name : `${otherType} #${otherId}`;
    if (name) resolved.push({ link_id: l.id, type: otherType, id: otherId, name });
  }

  res.json(resolved);
});

// Add a cross-link
app.post('/api/cross-links', async (req, res) => {
  const { source_type, source_id, target_type, target_id } = req.body;
  if (!source_type || !source_id || !target_type || !target_id) return res.status(400).json({ error: 'All fields required' });
  // Normalize order to avoid duplicates (alphabetical source_type)
  const [s_type, s_id, t_type, t_id] = source_type < target_type
    ? [source_type, source_id, target_type, target_id]
    : [target_type, target_id, source_type, source_id];
  try {
    await db.prepare('INSERT INTO cross_links (source_type, source_id, target_type, target_id) VALUES (?, ?, ?, ?)').run(s_type, s_id, t_type, t_id);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Link already exists' });
    throw e;
  }
  res.status(201).json({ success: true });
});

// Delete a cross-link
app.delete('/api/cross-links/:id', async (req, res) => {
  await db.prepare('DELETE FROM cross_links WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// List linkable entities by type
app.get('/api/linkable/:type', async (req, res) => {
  const { type } = req.params;
  let items = [];
  if (type === 'risk') items = await db.prepare('SELECT id, title as name FROM risks ORDER BY title').all();
  else if (type === 'task') items = await db.prepare('SELECT id, title as name FROM tasks ORDER BY title').all();
  else if (type === 'requirement') items = await db.prepare("SELECT id, clause || ' - ' || title || ' (' || standard || ')' as name FROM standard_requirements ORDER BY standard, sort_order").all();
  else if (type === 'audit') items = await db.prepare('SELECT id, title as name FROM audits ORDER BY title').all();
  else if (type === 'role') items = await db.prepare("SELECT id, name FROM org_architecture WHERE arch_type = 'role' ORDER BY name").all();
  else if (type === 'process') items = await db.prepare("SELECT id, name FROM org_architecture WHERE arch_type = 'process' ORDER BY name").all();
  else if (type === 'system') items = await db.prepare("SELECT id, name FROM org_architecture WHERE arch_type = 'system' ORDER BY name").all();
  else if (type === 'asset') items = await db.prepare("SELECT id, name FROM org_architecture WHERE arch_type = 'asset' ORDER BY name").all();
  else if (type === 'facility') items = await db.prepare("SELECT id, name FROM org_architecture WHERE arch_type = 'facility' ORDER BY name").all();
  else if (type === 'document') items = await db.prepare('SELECT id, title as name FROM documents ORDER BY title').all();
  else if (type === 'ncr') items = await db.prepare("SELECT id, clause || ' - ' || substr(description, 1, 60) as name FROM non_conformities ORDER BY id DESC").all();
  else if (type === 'treatment') items = await db.prepare("SELECT id, substr(description, 1, 80) as name FROM risk_treatments ORDER BY id DESC").all();
  else if (type === 'action') items = await db.prepare('SELECT id, title as name FROM actions ORDER BY id DESC').all();
  res.json(items);
});

// Cross-linking references endpoint (legacy for document control)
app.get('/api/link-references', async (req, res) => {
  const { module } = req.query;
  const refs = [];
  if (module === 'audits') {
    const reqs = await db.prepare('SELECT id, clause, title, standard FROM standard_requirements ORDER BY standard, sort_order').all();
    reqs.forEach(r => refs.push({ id: r.id, type: 'requirement', label: `${r.clause} - ${r.title} (${r.standard})` }));
  } else if (module === 'risk-management') {
    const risks = await db.prepare('SELECT id, title FROM risks ORDER BY title').all();
    risks.forEach(r => refs.push({ id: r.id, type: 'risk', label: r.title }));
  } else if (module === 'operational-planning') {
    const tasks = await db.prepare('SELECT id, title FROM tasks ORDER BY title').all();
    tasks.forEach(t => refs.push({ id: t.id, type: 'task', label: t.title }));
  }
  res.json(refs);
});

// ===== ADMIN API ENDPOINTS =====

// Admin: System Overview Stats
app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  const stats = {
    // Database stats (Supabase PostgreSQL – size via pg_database_size)
    databaseSize: await (async () => { try { const r = await db.get("SELECT pg_database_size(current_database()) as size"); return r?.size || 0; } catch { return 0; } })(),

    // Module counts
    tasks: (await db.prepare('SELECT COUNT(*) as c FROM tasks').get()).c,
    activeTasks: (await db.prepare('SELECT COUNT(*) as c FROM tasks WHERE is_active = 1').get()).c,
    completions: (await db.prepare('SELECT COUNT(*) as c FROM completions').get()).c,
    actions: (await db.prepare('SELECT COUNT(*) as c FROM actions').get()).c,
    openActions: (await db.prepare("SELECT COUNT(*) as c FROM actions WHERE status IN ('open', 'in_progress')").get()).c,

    risks: (await db.prepare('SELECT COUNT(*) as c FROM risks').get()).c,
    highRisks: (await db.prepare('SELECT COUNT(*) as c FROM risks WHERE (likelihood * impact) >= 15').get()).c,
    treatments: (await db.prepare('SELECT COUNT(*) as c FROM risk_treatments').get()).c,

    audits: (await db.prepare('SELECT COUNT(*) as c FROM audits').get()).c,
    plannedAudits: (await db.prepare("SELECT COUNT(*) as c FROM audits WHERE status = 'planned'").get()).c,
    ncrs: (await db.prepare('SELECT COUNT(*) as c FROM non_conformities').get()).c,
    openNcrs: (await db.prepare("SELECT COUNT(*) as c FROM non_conformities WHERE status IN ('open', 'in_progress')").get()).c,

    requirements: (await db.prepare('SELECT COUNT(*) as c FROM standard_requirements').get()).c,
    documents: (await db.prepare('SELECT COUNT(*) as c FROM documents').get()).c,
    architecture: (await db.prepare('SELECT COUNT(*) as c FROM org_architecture').get()).c,

    users: (await db.prepare('SELECT COUNT(*) as c FROM users').get()).c,
    activeUsers: (await db.prepare("SELECT COUNT(*) as c FROM users WHERE status = 'active'").get()).c,

    // Recent activity
    recentCompletions: await db.prepare(`
      SELECT c.*, t.title as task_title
      FROM completions c JOIN tasks t ON c.task_id = t.id
      ORDER BY c.completed_at DESC LIMIT 10
    `).all(),

    recentAuditLogs: await db.prepare(`
      SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT 20
    `).all(),

    // System health
    lastBackup: await db.prepare("SELECT * FROM backups WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1").get(),
  };

  res.json(stats);
});

// Admin-only middleware
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Authentication required' });
  if (req.session.userRole !== 'admin') return res.status(403).json({ error: 'Administrator access required' });
  next();
}

// Admin: Users CRUD
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const { status, role, search } = req.query;
  let sql = 'SELECT id, name, email, role, department, permissions, status, last_active, expiry_date, notes, created_at, updated_at FROM users WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (role) { sql += ' AND role = ?'; params.push(role); }
  if (search) {
    sql += ' AND (name ILIKE ? OR email ILIKE ? OR department ILIKE ?)';
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern);
  }
  sql += ' ORDER BY name';
  res.json(await db.prepare(sql).all(...params));
});

app.get('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const user = await db.prepare('SELECT id, name, email, role, department, permissions, status, last_active, expiry_date, notes, created_at, updated_at FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { name, email, password, role, department, permissions, status, expiry_date, notes } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email format' });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.prepare(`
      INSERT INTO users (name, email, password, role, department, permissions, status, expiry_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, email.toLowerCase().trim(), hashedPassword, role || 'user', department || '',
           JSON.stringify(permissions || ['org','risk','ops','audit']),
           status || 'active', expiry_date || null, notes || '');

    const admin = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.session.userId);
    await logAuditAction(req.session.userId, admin?.name || 'Admin', 'user_created', 'user', result.lastInsertRowid, name);

    const newUser = await db.prepare('SELECT id, name, email, role, department, permissions, status, last_active, expiry_date, notes, created_at, updated_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(newUser);
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE') || e.message.includes('duplicate')) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }
    console.error('Create user error:', e);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Prevent self-demotion from admin
  if (parseInt(req.params.id) === req.session.userId) {
    if (req.body.role && req.body.role !== 'admin') {
      return res.status(400).json({ error: 'You cannot change your own admin role. Ask another admin.' });
    }
    if (req.body.status && req.body.status !== 'active') {
      return res.status(400).json({ error: 'You cannot deactivate your own account.' });
    }
  }

  if (req.body.email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(req.body.email)) return res.status(400).json({ error: 'Invalid email format' });
    req.body.email = req.body.email.toLowerCase().trim();
  }

  const fields = ['name', 'email', 'role', 'department', 'permissions', 'status', 'expiry_date', 'notes'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(f === 'permissions' ? JSON.stringify(req.body[f]) : req.body[f]);
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);

  try {
    await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    const admin = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.session.userId);
    await logAuditAction(req.session.userId, admin?.name || 'Admin', 'user_updated', 'user', user.id, user.name,
      JSON.stringify(Object.keys(req.body).filter(k => k !== 'password')));
    const updated = await db.prepare('SELECT id, name, email, role, department, permissions, status, last_active, expiry_date, notes, created_at, updated_at FROM users WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE') || e.message.includes('duplicate')) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }
    console.error('Update user error:', e);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Admin: Reset user password
app.put('/api/admin/users/:id/password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const hashedPassword = await bcrypt.hash(password, 10);
  await db.prepare("UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?").run(hashedPassword, req.params.id);

  const admin = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.session.userId);
  await logAuditAction(req.session.userId, admin?.name || 'Admin', 'user_password_reset', 'user', user.id, user.name);
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.session.userId) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  await db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  const admin = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.session.userId);
  await logAuditAction(req.session.userId, admin?.name || 'Admin', 'user_deleted', 'user', user.id, user.name);
  res.json({ success: true });
});

// Admin: Audit Log
app.get('/api/admin/audit-log', requireAdmin, async (req, res) => {
  const { action, entity_type, user_name, limit = 100, offset = 0 } = req.query;
  let sql = 'SELECT * FROM admin_audit_log WHERE 1=1';
  const params = [];
  if (action) { sql += ' AND action LIKE ?'; params.push(`%${action}%`); }
  if (entity_type) { sql += ' AND entity_type = ?'; params.push(entity_type); }
  if (user_name) { sql += ' AND user_name LIKE ?'; params.push(`%${user_name}%`); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const logs = await db.prepare(sql).all(...params);
  const total = (await db.prepare('SELECT COUNT(*) as c FROM admin_audit_log').get()).c;
  res.json({ logs, total, limit: parseInt(limit), offset: parseInt(offset) });
});

// Helper function to log audit actions
async function logAuditAction(userId, userName, action, entityType, entityId, entityName, details = '') {
  await db.run(`
    INSERT INTO admin_audit_log (user_id, user_name, action, entity_type, entity_id, entity_name, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, userId, userName, action, entityType, entityId, entityName, details);
}

// Admin: System Settings
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  const settings = await db.prepare('SELECT * FROM system_settings').all();
  const result = {};
  for (const s of settings) {
    try { result[s.key] = JSON.parse(s.value); }
    catch { result[s.key] = s.value; }
  }
  res.json(result);
});

app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  const settings = req.body;
  const upsert = db.prepare(`
    INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `);

  for (const [key, value] of Object.entries(settings)) {
    await upsert.run(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }

  await logAuditAction(null, 'System', 'settings_updated', 'settings', null, null, JSON.stringify(Object.keys(settings)));
  res.json({ success: true });
});

// Admin: API Keys
app.get('/api/admin/api-keys', requireAdmin, async (req, res) => {
  res.json(await db.prepare("SELECT id, name, key_prefix, permissions, last_used, expires_at, status, created_at FROM api_keys ORDER BY created_at DESC").all());
});

app.post('/api/admin/api-keys', requireAdmin, async (req, res) => {
  const { name, permissions, expires_at } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  // Generate a random API key
  const key = 'ltfw_' + crypto.randomBytes(24).toString('hex');
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  const keyPrefix = key.substring(0, 12) + '...';

  const result = await db.prepare(`
    INSERT INTO api_keys (name, key_hash, key_prefix, permissions, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, keyHash, keyPrefix, JSON.stringify(permissions || ['read']), expires_at || null);

  await logAuditAction(null, 'System', 'api_key_created', 'api_key', result.lastInsertRowid, name);

  // Return the full key only once (won't be stored/retrievable later)
  res.status(201).json({
    id: result.lastInsertRowid,
    name,
    key, // Full key shown only once!
    key_prefix: keyPrefix,
    permissions: permissions || ['read'],
    created_at: new Date().toISOString()
  });
});

app.delete('/api/admin/api-keys/:id', requireAdmin, async (req, res) => {
  const key = await db.prepare('SELECT * FROM api_keys WHERE id = ?').get(req.params.id);
  if (!key) return res.status(404).json({ error: 'API key not found' });

  await db.prepare("UPDATE api_keys SET status = 'revoked' WHERE id = ?").run(req.params.id);
  await logAuditAction(null, 'System', 'api_key_revoked', 'api_key', key.id, key.name);
  res.json({ success: true });
});

// Admin: Webhooks
app.get('/api/admin/webhooks', requireAdmin, async (req, res) => {
  res.json(await db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all());
});

app.post('/api/admin/webhooks', requireAdmin, async (req, res) => {
  const { name, url, events, secret, status } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Name and URL required' });

  const result = await db.prepare(`
    INSERT INTO webhooks (name, url, events, secret, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, url, JSON.stringify(events || []), secret || '', status || 'active');

  await logAuditAction(null, 'System', 'webhook_created', 'webhook', result.lastInsertRowid, name);
  res.status(201).json(await db.prepare('SELECT * FROM webhooks WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/admin/webhooks/:id', requireAdmin, async (req, res) => {
  const webhook = await db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

  const { name, url, events, secret, status } = req.body;
  await db.prepare(`
    UPDATE webhooks SET name = ?, url = ?, events = ?, secret = ?, status = ? WHERE id = ?
  `).run(name || webhook.name, url || webhook.url, JSON.stringify(events || JSON.parse(webhook.events)),
         secret !== undefined ? secret : webhook.secret, status || webhook.status, req.params.id);

  await logAuditAction(null, 'System', 'webhook_updated', 'webhook', webhook.id, webhook.name);
  res.json(await db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id));
});

app.delete('/api/admin/webhooks/:id', requireAdmin, async (req, res) => {
  const webhook = await db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

  await db.prepare('DELETE FROM webhooks WHERE id = ?').run(req.params.id);
  await logAuditAction(null, 'System', 'webhook_deleted', 'webhook', webhook.id, webhook.name);
  res.json({ success: true });
});

// Admin: Data Export
app.get('/api/admin/export', requireAdmin, async (req, res) => {
  const { format = 'json', include } = req.query;
  const includes = include ? include.split(',') : ['tasks', 'risks', 'audits', 'architecture', 'requirements', 'documents'];

  const data = {
    exportedAt: new Date().toISOString(),
    version: '1.0',
  };

  if (includes.includes('tasks')) {
    data.tasks = await db.prepare('SELECT * FROM tasks').all();
    data.completions = await db.prepare('SELECT * FROM completions').all();
    data.actions = await db.prepare('SELECT * FROM actions').all();
  }
  if (includes.includes('risks')) {
    data.risks = await db.prepare('SELECT * FROM risks').all();
    data.treatments = await db.prepare('SELECT * FROM risk_treatments').all();
  }
  if (includes.includes('audits')) {
    data.audits = await db.prepare('SELECT * FROM audits').all();
    data.auditChecklist = await db.prepare('SELECT * FROM audit_checklist').all();
    data.ncrs = await db.prepare('SELECT * FROM non_conformities').all();
  }
  if (includes.includes('architecture')) {
    data.architecture = await db.prepare('SELECT * FROM org_architecture').all();
    data.kpis = await db.prepare('SELECT * FROM org_kpis').all();
  }
  if (includes.includes('requirements')) {
    data.requirements = await db.prepare('SELECT * FROM standard_requirements').all();
    data.soaEntries = await db.prepare('SELECT * FROM soa_entries').all();
  }
  if (includes.includes('documents')) {
    data.documents = await db.prepare('SELECT id, title, description, doc_type, version, owner, status, classification, linked_module, review_date, created_at FROM documents').all();
  }

  // Cross-links
  data.crossLinks = await db.prepare('SELECT * FROM cross_links').all();

  await logAuditAction(null, 'System', 'data_exported', 'system', null, null, `Format: ${format}, Includes: ${includes.join(',')}`);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="ltfw-export-${new Date().toISOString().split('T')[0]}.json"`);
  res.json(data);
});

// Admin: Create Backup
app.post('/api/admin/backups', requireAdmin, async (req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backup-${timestamp}.json`;

  // Get all data
  const data = {
    exportedAt: new Date().toISOString(),
    version: '1.0',
    tasks: await db.prepare('SELECT * FROM tasks').all(),
    completions: await db.prepare('SELECT * FROM completions').all(),
    actions: await db.prepare('SELECT * FROM actions').all(),
    risks: await db.prepare('SELECT * FROM risks').all(),
    treatments: await db.prepare('SELECT * FROM risk_treatments').all(),
    audits: await db.prepare('SELECT * FROM audits').all(),
    auditChecklist: await db.prepare('SELECT * FROM audit_checklist').all(),
    ncrs: await db.prepare('SELECT * FROM non_conformities').all(),
    architecture: await db.prepare('SELECT * FROM org_architecture').all(),
    requirements: await db.prepare('SELECT * FROM standard_requirements').all(),
    soaEntries: await db.prepare('SELECT * FROM soa_entries').all(),
    documents: await db.prepare('SELECT * FROM documents').all(),
    kpis: await db.prepare('SELECT * FROM org_kpis').all(),
    kpiValues: await db.prepare('SELECT * FROM org_kpi_values').all(),
    crossLinks: await db.prepare('SELECT * FROM cross_links').all(),
    threatFeeds: await db.prepare('SELECT * FROM threat_feeds').all(),
    users: await db.prepare('SELECT * FROM users').all(),
    settings: await db.prepare('SELECT * FROM system_settings').all(),
  };

  const content = JSON.stringify(data, null, 2);
  const size = Buffer.byteLength(content, 'utf8');

  // Upload backup to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from(UPLOADS_BUCKET)
    .upload(`backups/${filename}`, Buffer.from(content, 'utf8'), { contentType: 'application/json', upsert: false });
  if (uploadError) return res.status(500).json({ error: `Backup storage failed: ${uploadError.message}` });

  // Save backup record
  const result = await db.prepare(`
    INSERT INTO backups (filename, size, type, status) VALUES (?, ?, ?, 'completed')
  `).run(filename, size, req.body.type || 'manual');

  await logAuditAction(null, 'System', 'backup_created', 'backup', result.lastInsertRowid, filename);
  res.status(201).json(await db.prepare('SELECT * FROM backups WHERE id = ?').get(result.lastInsertRowid));
});

app.get('/api/admin/backups', requireAdmin, async (req, res) => {
  res.json(await db.prepare("SELECT * FROM backups ORDER BY created_at DESC").all());
});

app.get('/api/admin/backups/:id/download', requireAdmin, async (req, res) => {
  const backup = await db.prepare('SELECT * FROM backups WHERE id = ?').get(req.params.id);
  if (!backup) return res.status(404).json({ error: 'Backup not found' });

  try {
    const signedUrl = await getSignedUrl(`backups/${backup.filename}`);
    res.redirect(signedUrl);
  } catch (err) {
    res.status(404).json({ error: 'Backup file not found in storage' });
  }
});

app.delete('/api/admin/backups/:id', requireAdmin, async (req, res) => {
  const backup = await db.prepare('SELECT * FROM backups WHERE id = ?').get(req.params.id);
  if (!backup) return res.status(404).json({ error: 'Backup not found' });

  await deleteFromSupabase(`backups/${backup.filename}`);
  await db.prepare('DELETE FROM backups WHERE id = ?').run(req.params.id);
  await logAuditAction(null, 'System', 'backup_deleted', 'backup', backup.id, backup.filename);
  res.json({ success: true });
});

// Admin: Data Cleanup
app.post('/api/admin/cleanup', requireAdmin, async (req, res) => {
  const { type } = req.body;
  let result = { affected: 0 };

  if (type === 'history') {
    // Delete completions older than 1 year
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const r = await db.prepare("DELETE FROM completions WHERE completed_at < ?").run(oneYearAgo.toISOString());
    result.affected = r.changes;
  } else if (type === 'logs') {
    // Delete audit logs older than 90 days
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const r = await db.prepare("DELETE FROM admin_audit_log WHERE created_at < ?").run(ninetyDaysAgo.toISOString());
    result.affected = r.changes;
  }

  await logAuditAction(null, 'System', 'data_cleanup', 'system', null, null, `Type: ${type}, Affected: ${result.affected}`);
  res.json(result);
});

// Admin: Data Import
app.post('/api/admin/import', requireAdmin, async (req, res) => {
  const data = req.body;
  const result = { imported: {}, errors: [] };

  try {
    // Import tasks
    if (data.tasks && Array.isArray(data.tasks)) {
      let count = 0;
      const insertTask = db.prepare(`
        INSERT OR IGNORE INTO tasks (title, description, assignee, category, priority, recurrence, next_due, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      for (const task of data.tasks) {
        try {
          await insertTask.run(task.title, task.description || '', task.assignee || '', task.category || '',
            task.priority || 'medium', task.recurrence || 'monthly', task.next_due || null, task.is_active !== false ? 1 : 0);
          count++;
        } catch (e) { /* Skip duplicates */ }
      }
      result.imported.tasks = count;
    }

    // Import risks
    if (data.risks && Array.isArray(data.risks)) {
      let count = 0;
      const insertRisk = db.prepare(`
        INSERT OR IGNORE INTO risks (title, description, category, status, risk_owner, threat, vulnerability, asset, likelihood, impact, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      for (const risk of data.risks) {
        try {
          await insertRisk.run(risk.title, risk.description || '', risk.category || '', risk.status || 'identified',
            risk.risk_owner || risk.owner || '', risk.threat || '', risk.vulnerability || '', risk.asset || risk.asset_system || '',
            risk.likelihood || 3, risk.impact || 3);
          count++;
        } catch (e) { /* Skip duplicates */ }
      }
      result.imported.risks = count;
    }

    // Import architecture items
    if (data.architecture && Array.isArray(data.architecture)) {
      let count = 0;
      const insertArch = db.prepare(`
        INSERT OR IGNORE INTO org_architecture (arch_type, name, description, owner, parent_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      for (const item of data.architecture) {
        try {
          await insertArch.run(item.arch_type || 'role', item.name, item.description || '', item.owner || '',
            item.parent_id || null, item.status || 'active');
          count++;
        } catch (e) { /* Skip duplicates */ }
      }
      result.imported.architecture = count;
    }

    // Import requirements
    if (data.requirements && Array.isArray(data.requirements)) {
      let count = 0;
      const insertReq = db.prepare(`
        INSERT OR IGNORE INTO standard_requirements (standard, clause, title, description, category, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `);
      for (const item of data.requirements) {
        try {
          await insertReq.run(item.standard || '', item.clause || '', item.title, item.description || '',
            item.category || '');
          count++;
        } catch (e) { /* Skip duplicates */ }
      }
      result.imported.requirements = count;
    }

    // Import documents
    if (data.documents && Array.isArray(data.documents)) {
      let count = 0;
      const insertDoc = db.prepare(`
        INSERT OR IGNORE INTO documents (title, description, doc_type, version, owner, status, classification, linked_module, review_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      for (const doc of data.documents) {
        try {
          await insertDoc.run(doc.title, doc.description || '', doc.doc_type || 'policy', doc.version || '1.0',
            doc.owner || '', doc.status || 'draft', doc.classification || 'internal',
            doc.linked_module || '', doc.review_date || null);
          count++;
        } catch (e) { /* Skip duplicates */ }
      }
      result.imported.documents = count;
    }

    // Import audits
    if (data.audits && Array.isArray(data.audits)) {
      let count = 0;
      const insertAudit = db.prepare(`
        INSERT OR IGNORE INTO audits (title, standard, lead_auditor, scope, status, planned_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      for (const audit of data.audits) {
        try {
          await insertAudit.run(audit.title, audit.standard || '', audit.lead_auditor || '',
            audit.scope || '', audit.status || 'planned', audit.planned_date || audit.scheduled_date || null);
          count++;
        } catch (e) { /* Skip duplicates */ }
      }
      result.imported.audits = count;
    }

    await logAuditAction(null, 'System', 'data_imported', 'system', null, null, JSON.stringify(result.imported));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Test Webhook
app.post('/api/admin/webhooks/:id/test', requireAdmin, async (req, res) => {
  const webhook = await db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

  const testPayload = {
    event: 'test',
    timestamp: new Date().toISOString(),
    message: 'This is a test webhook from Let The Frame Work',
    webhook_id: webhook.id,
    webhook_name: webhook.name
  };

  try {
    const https = require('https');
    const http = require('http');
    const url = new URL(webhook.url);
    const client = url.protocol === 'https:' ? https : http;

    const payload = JSON.stringify(testPayload);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'LetTheFrameWork/1.0',
        ...(webhook.secret ? { 'X-Webhook-Secret': webhook.secret } : {})
      },
      timeout: 10000
    };

    const result = await new Promise((resolve, reject) => {
      const request = client.request(options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          resolve({ statusCode: response.statusCode, body: data.substring(0, 500) });
        });
      });

      request.on('error', reject);
      request.on('timeout', () => { request.destroy(); reject(new Error('Timeout')); });
      request.write(payload);
      request.end();
    });

    // Update last triggered
    await db.prepare("UPDATE webhooks SET last_triggered = datetime('now') WHERE id = ?").run(webhook.id);

    res.json({ success: true, statusCode: result.statusCode, response: result.body });
  } catch (err) {
    // Increment failure count
    await db.prepare("UPDATE webhooks SET failure_count = failure_count + 1 WHERE id = ?").run(webhook.id);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Reset Webhook Failures
app.post('/api/admin/webhooks/:id/reset-failures', requireAdmin, async (req, res) => {
  const webhook = await db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

  await db.prepare("UPDATE webhooks SET failure_count = 0 WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ===== SAML/SSO ENDPOINTS =====

// SAML config is initialized in db.js seedSQLiteData()/seedPostgresData()

// Get SAML configuration
app.get('/api/admin/saml/config', requireAdmin, async (req, res) => {
  const config = await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();
  // Don't expose the full certificate in the API response
  if (config && config.certificate) {
    config.has_certificate = config.certificate.length > 0;
    config.certificate = config.certificate ? '[CONFIGURED]' : '';
  }
  res.json(config || {});
});

// Update SAML configuration
app.put('/api/admin/saml/config', requireAdmin, async (req, res) => {
  const {
    enabled, entity_id, sso_url, slo_url, certificate,
    name_id_format, attribute_mapping, auto_provision,
    default_role, allowed_domains
  } = req.body;

  const current = await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();

  // Only update certificate if a new one is provided
  const certToStore = certificate && certificate !== '[CONFIGURED]' ? certificate : (current?.certificate || '');

  await db.prepare(`
    UPDATE saml_config SET
      enabled = ?,
      entity_id = ?,
      sso_url = ?,
      slo_url = ?,
      certificate = ?,
      name_id_format = ?,
      attribute_mapping = ?,
      auto_provision = ?,
      default_role = ?,
      allowed_domains = ?,
      updated_at = datetime('now')
    WHERE id = 1
  `).run(
    enabled ? 1 : 0,
    entity_id || '',
    sso_url || '',
    slo_url || '',
    certToStore,
    name_id_format || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    typeof attribute_mapping === 'object' ? JSON.stringify(attribute_mapping) : (attribute_mapping || '{}'),
    auto_provision ? 1 : 0,
    default_role || 'user',
    allowed_domains || ''
  );

  await logAuditAction(null, 'System', 'saml_config_updated', 'saml', 1, null, `Enabled: ${enabled}`);
  res.json({ success: true });
});

// Generate Service Provider metadata
app.get('/saml/metadata', async (req, res) => {
  const config = await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  const metadata = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${baseUrl}/saml/metadata">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>${config?.name_id_format || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'}</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${baseUrl}/saml/callback" index="0" isDefault="true"/>
    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${baseUrl}/saml/logout"/>
  </md:SPSSODescriptor>
  <md:Organization>
    <md:OrganizationName xml:lang="en">Let The Frame Work</md:OrganizationName>
    <md:OrganizationDisplayName xml:lang="en">Let The Frame Work</md:OrganizationDisplayName>
    <md:OrganizationURL xml:lang="en">${baseUrl}</md:OrganizationURL>
  </md:Organization>
</md:EntityDescriptor>`;

  res.set('Content-Type', 'application/xml');
  res.send(metadata);
});

// Initiate SAML login
app.get('/saml/login', async (req, res) => {
  const config = await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();

  if (!config || !config.enabled) {
    return res.status(400).json({ error: 'SAML SSO is not enabled' });
  }

  if (!config.sso_url || !config.entity_id) {
    return res.status(400).json({ error: 'SAML is not properly configured' });
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const requestId = '_' + crypto.randomBytes(16).toString('hex');
  const issueInstant = new Date().toISOString();

  // Create SAML AuthnRequest
  const authnRequest = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
    ID="${requestId}"
    Version="2.0"
    IssueInstant="${issueInstant}"
    Destination="${config.sso_url}"
    AssertionConsumerServiceURL="${baseUrl}/saml/callback"
    ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
  <saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${baseUrl}/saml/metadata</saml:Issuer>
  <samlp:NameIDPolicy Format="${config.name_id_format}" AllowCreate="true"/>
</samlp:AuthnRequest>`;

  // Base64 encode and create redirect URL
  const encodedRequest = Buffer.from(authnRequest).toString('base64');
  const redirectUrl = `${config.sso_url}?SAMLRequest=${encodeURIComponent(encodedRequest)}`;

  res.redirect(redirectUrl);
});

// Handle SAML callback (Assertion Consumer Service)
app.post('/saml/callback', express.urlencoded({ extended: true }), async (req, res) => {
  const config = await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();

  if (!config || !config.enabled) {
    return res.status(400).send('SAML SSO is not enabled');
  }

  try {
    const samlResponse = req.body.SAMLResponse;
    if (!samlResponse) {
      return res.status(400).send('No SAML response received');
    }

    // Decode the SAML response
    const decodedResponse = Buffer.from(samlResponse, 'base64').toString('utf8');

    // Parse attribute mapping
    let attrMap = {};
    try { attrMap = JSON.parse(config.attribute_mapping || '{}'); } catch(e) {}

    // Extract user info from SAML assertion (simplified parsing)
    const emailMatch = decodedResponse.match(/<(?:saml:)?Attribute[^>]*Name="([^"]*email[^"]*)"[^>]*>[\s\S]*?<(?:saml:)?AttributeValue[^>]*>([^<]+)/i) ||
                       decodedResponse.match(/<(?:saml:)?NameID[^>]*>([^<]+)/);
    const nameMatch = decodedResponse.match(/<(?:saml:)?Attribute[^>]*Name="([^"]*(?:displayname|name|givenname)[^"]*)"[^>]*>[\s\S]*?<(?:saml:)?AttributeValue[^>]*>([^<]+)/i);

    let email = emailMatch ? (emailMatch[2] || emailMatch[1]) : null;
    let name = nameMatch ? nameMatch[2] : null;

    if (!email) {
      return res.status(400).send('Could not extract email from SAML response');
    }

    email = email.trim().toLowerCase();
    name = name ? name.trim() : email.split('@')[0];

    // Check allowed domains
    if (config.allowed_domains) {
      const allowedDomains = config.allowed_domains.split(',').map(d => d.trim().toLowerCase());
      const userDomain = email.split('@')[1];
      if (allowedDomains.length > 0 && allowedDomains[0] !== '' && !allowedDomains.includes(userDomain)) {
        return res.status(403).send('Your domain is not allowed to access this application');
      }
    }

    // Find or create user
    let user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user && config.auto_provision) {
      // Create new user
      const result = await db.prepare(`
        INSERT INTO users (name, email, role, permissions, status, sso_provider)
        VALUES (?, ?, ?, ?, 'active', 'saml')
      `).run(name, email, config.default_role || 'user', JSON.stringify(['org', 'risk', 'ops', 'audit']));

      user = await db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
      await logAuditAction(user.id, user.name, 'user_provisioned_saml', 'user', user.id, user.name);
    } else if (!user) {
      return res.status(403).send('User not found and auto-provisioning is disabled');
    } else {
      // Update last login
      await db.prepare("UPDATE users SET last_active = datetime('now') WHERE id = ?").run(user.id);
    }

    // Create session
    const sessionId = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours

    await db.prepare(`
      INSERT INTO saml_sessions (id, user_id, name_id, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, user.id, email, expiresAt);

    await logAuditAction(user.id, user.name, 'saml_login', 'user', user.id, user.name);

    // Redirect to app with session token
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>SSO Login</title></head>
      <body>
        <script>
          localStorage.setItem('saml_session', '${sessionId}');
          localStorage.setItem('saml_user', '${Buffer.from(JSON.stringify({ id: user.id, name: user.name, email: user.email, role: user.role })).toString('base64')}');
          window.location.href = '/';
        </script>
        <p>Logging you in...</p>
      </body>
      </html>
    `);

  } catch (err) {
    console.error('SAML callback error:', err);
    res.status(500).send('Error processing SAML response: ' + err.message);
  }
});

// SAML logout
app.get('/saml/logout', async (req, res) => {
  const sessionId = req.query.session;
  if (sessionId) {
    const session = await db.prepare('SELECT * FROM saml_sessions WHERE id = ?').get(sessionId);
    if (session) {
      await db.prepare('DELETE FROM saml_sessions WHERE id = ?').run(sessionId);
      await logAuditAction(session.user_id, 'User', 'saml_logout', 'user', session.user_id, session.name_id);
    }
  }
  res.redirect('/');
});

// Validate SAML session
app.get('/api/auth/session', async (req, res) => {
  const sessionId = req.headers['x-saml-session'];
  if (!sessionId) {
    return res.json({ authenticated: false });
  }

  const session = await db.prepare(`
    SELECT s.*, u.name, u.email, u.role, u.permissions
    FROM saml_sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).get(sessionId);

  if (!session) {
    return res.json({ authenticated: false });
  }

  res.json({
    authenticated: true,
    user: {
      id: session.user_id,
      name: session.name,
      email: session.email,
      role: session.role,
      permissions: JSON.parse(session.permissions || '[]')
    }
  });
});

// Test SAML configuration
app.post('/api/admin/saml/test', requireAdmin, async (req, res) => {
  const config = await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();

  const issues = [];
  if (!config.entity_id) issues.push('Identity Provider Entity ID is not configured');
  if (!config.sso_url) issues.push('SSO URL is not configured');
  if (!config.certificate) issues.push('IdP Certificate is not configured');

  if (issues.length > 0) {
    return res.json({ success: false, issues });
  }

  // Validate certificate format
  if (!config.certificate.includes('BEGIN CERTIFICATE')) {
    issues.push('Certificate does not appear to be in PEM format');
  }

  // Validate URL format
  try {
    new URL(config.sso_url);
  } catch {
    issues.push('SSO URL is not a valid URL');
  }

  if (issues.length > 0) {
    return res.json({ success: false, issues });
  }

  res.json({
    success: true,
    message: 'SAML configuration appears valid. Test login to verify full functionality.',
    metadata_url: `${req.protocol}://${req.get('host')}/saml/metadata`,
    callback_url: `${req.protocol}://${req.get('host')}/saml/callback`
  });
});

// Database migrations and seeding are handled in db.js

// SPA fallback
app.get('*', async (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler - must be last middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack || err);
  res.status(500).json({ error: 'Internal server error' });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Start server with database initialization
async function startServer() {
  try {
    // Initialize Supabase PostgreSQL database
    await db.initDatabase();
    console.log('Database: Supabase PostgreSQL');

    app.listen(PORT, () => {
      console.log(`Let The Frame Work running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
