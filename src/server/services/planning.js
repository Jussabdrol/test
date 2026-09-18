const db = require('../database');
const { occurrenceDates } = require('./task-schedule');

// Generate missing task_instances rows for all active task series in an org,
// from the series start up to a target horizon, filling gaps in existing schedules.
// Idempotent thanks to UNIQUE(task_id, scheduled_date); safe to call on every Task Log load.
async function ensureTaskInstances(orgId, horizonDays = 14, { through, taskId } = {}) {
  const horizon = new Date();
  horizon.setUTCDate(horizon.getUTCDate() + horizonDays);
  const horizonStr = through || horizon.toISOString().slice(0, 10);
  await db.transaction(async () => {
    await db.get('SELECT pg_advisory_xact_lock(?)', orgId);
    const tasks = await db.all('SELECT * FROM tasks WHERE organization_id=? AND is_active=1' + (taskId ? ' AND id=?' : ''),
      ...[orgId, ...(taskId ? [taskId] : [])]);
    const saved = await db.all('SELECT task_id,scheduled_date FROM task_instances WHERE organization_id=? AND scheduled_date<=?' + (taskId ? ' AND task_id=?' : ''),
      orgId, horizonStr, ...(taskId ? [taskId] : []));
    const byTask = new Map();
    for (const row of saved) {
      if (!byTask.has(row.task_id)) byTask.set(row.task_id, new Set());
      byTask.get(row.task_id).add(row.scheduled_date);
    }
    for (const task of tasks) {
      const existing = byTask.get(task.id) || new Set();
      const dates = occurrenceDates(task, horizonStr).filter(date => !existing.has(date));
      for (let i = 0; i < dates.length; i += 500) {
        const chunk = dates.slice(i, i + 500);
        await db.run(`INSERT INTO task_instances (organization_id,task_id,scheduled_date)
          VALUES ${chunk.map(() => '(?,?,?)').join(',')}
          ON CONFLICT (task_id,scheduled_date) DO NOTHING`,
        ...chunk.flatMap(date => [orgId, task.id, date]));
      }
    }
  });
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
