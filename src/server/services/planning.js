const db = require('../database');
const { computeNextDue } = require('./recurrence');

// Generate missing task_instances rows for all active task series in an org,
// from the latest scheduled_date (or the series' start_date) up to a target horizon.
// Idempotent thanks to UNIQUE(task_id, scheduled_date); safe to call on every Task Log load.
async function ensureTaskInstances(orgId, horizonDays = 14) {
  const today = new Date();
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + horizonDays);
  const horizonStr = horizon.toISOString().split('T')[0];

  const tasks = await db.prepare('SELECT * FROM tasks WHERE organization_id = ? AND is_active = 1').all(orgId);
  if (tasks.length === 0) return;

  // One grouped query for the latest scheduled date of every series in the org
  const lastRows = await db.prepare(
    'SELECT task_id, MAX(scheduled_date) AS d FROM task_instances WHERE organization_id = ? GROUP BY task_id'
  ).all(orgId);
  const lastByTask = new Map(lastRows.map(r => [r.task_id, r.d]));

  const rows = []; // [task_id, scheduled_date] pairs to insert
  for (const task of tasks) {
    const last = lastByTask.get(task.id);
    let cursor = last
      ? computeNextDue(last, task.recurrence, task.custom_days, task.day_of_week, task.day_of_month ?? Number(task.start_date.slice(8,10)))
      : task.start_date;
    let safety = 0;
    while (cursor <= horizonStr && safety < 400) {
      rows.push([task.id, cursor]);
      const next = computeNextDue(cursor, task.recurrence, task.custom_days, task.day_of_week, task.day_of_month ?? Number(task.start_date.slice(8,10)));
      if (next <= cursor) break; // schedule not advancing — misconfigured series
      cursor = next;
      safety++;
    }
  }

  // Batched insert; UNIQUE(task_id, scheduled_date) keeps this idempotent
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk.map(() => '(?, ?, ?)').join(', ');
    const params = chunk.flatMap(([taskId, date]) => [orgId, taskId, date]);
    await db.prepare(
      `INSERT INTO task_instances (organization_id, task_id, scheduled_date)
       VALUES ${values} ON CONFLICT (task_id, scheduled_date) DO NOTHING`
    ).run(...params);
  }
}

// --- Utility helpers ---

// Improvement 10: safe integer param parser — prevents NaN from reaching the DB driver
function parseIntParam(value, defaultVal, { min = 0, max = Infinity } = {}) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return defaultVal;
  return Math.min(Math.max(n, min), max);
}

// Strict YYYY-MM-DD validator. Rejects anything that could smuggle markup
// or invalid calendar dates into scheduled_date/start_date/next_due fields.
function isValidDateStr(v) {
  if (typeof v !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().startsWith(v);
}

// Valid recurrence configuration for task series. Guards both the DB CHECK
// constraint and computeNextDue(): a non-positive custom_days would make the
// schedule stand still or run backwards, which the yearly-plan projection and
// instance-generation loops cannot terminate on.
const VALID_RECURRENCES = new Set(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly', 'custom']);

function validateRecurrenceFields(body) {
  const { recurrence, custom_days, day_of_week, day_of_month } = body;
  if (recurrence !== undefined && recurrence !== null && recurrence !== '' && !VALID_RECURRENCES.has(recurrence)) {
    return `recurrence must be one of: ${[...VALID_RECURRENCES].join(', ')}`;
  }
  const ranges = [['custom_days', custom_days, 1, 3650], ['day_of_week', day_of_week, 0, 6], ['day_of_month', day_of_month, 1, 31]];
  for (const [name, value, min, max] of ranges) {
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
      return `${name} must be an integer between ${min} and ${max}`;
    }
  }
  return null;
}

// Improvement 7: fire-and-forget process event emitter (never throws into caller)
async function emitEvent(orgId, caseId, caseType, activity, actor = '', attrs = {}, processId = null) {
  if (db.deferUntilCommit(() => emitEvent(orgId, caseId, caseType, activity, actor, attrs, processId))) return;
  try {
    await db.prepare(
      `INSERT INTO process_events
         (organization_id, case_id, case_type, activity, actor, process_id, attributes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(orgId, caseId, caseType, activity, actor, processId || null, JSON.stringify(attrs));
  } catch (err) {
    console.error('[process_events] emit failed:', err.message);
  }
}

module.exports = { ensureTaskInstances, parseIntParam, isValidDateStr, validateRecurrenceFields, emitEvent };
