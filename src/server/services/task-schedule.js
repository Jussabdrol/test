const { computeNextDue } = require('./recurrence');
const { HttpError } = require('../shared/errors');

function nextScheduledDate(task, date) {
  return computeNextDue(date, task.recurrence, task.custom_days, task.day_of_week,
    task.day_of_month ?? Number(task.start_date.slice(8, 10)));
}

// One calendar calculation for the projection and persisted executions. A future
// outcome must never prevent earlier missing occurrences from being generated.
function occurrenceDates(task, through, from = task.start_date) {
  const dates = [];
  let date = task.start_date;
  let count = 0;
  while (date <= through) {
    if (++count > 20000) throw new HttpError(400, 'Schedule exceeds 20,000 occurrences; adjust the start date.');
    if (date >= from) dates.push(date);
    date = nextScheduledDate(task, date);
  }
  return dates;
}

// Run inside the caller's organization transaction. Keep the series pointer on
// its earliest outstanding occurrence, including reopened historical work.
async function syncNextDue(db, orgId, taskId) {
  const task = await db.get('SELECT * FROM tasks WHERE id=? AND organization_id=?', taskId, orgId);
  const rows = await db.all('SELECT scheduled_date, status FROM task_instances WHERE task_id=? AND organization_id=?', taskId, orgId);
  const terminal = new Set(rows.filter(row => row.status !== 'pending').map(row => row.scheduled_date));
  let date = task.next_due;
  for (const row of rows) if (row.status === 'pending' && row.scheduled_date < date) date = row.scheduled_date;
  let count = 0;
  while (terminal.has(date)) {
    if (++count > 20000) throw new HttpError(400, 'Too many completed occurrences in this series.');
    date = nextScheduledDate(task, date);
  }
  await db.run('UPDATE tasks SET next_due=?, updated_at=NOW() WHERE id=? AND organization_id=?', date, taskId, orgId);
  return date;
}
module.exports = { occurrenceDates, nextScheduledDate, syncNextDue };
