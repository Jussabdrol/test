const { HttpError } = require('./errors');
function computeNextDue(fromDate, recurrence, customDays, dayOfWeek, dayOfMonth) {
  const d = new Date(`${fromDate}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== fromDate) throw new HttpError(400, 'Invalid due date');
  const months = { monthly: 1, quarterly: 3, yearly: 12 };
  if (months[recurrence]) {
    const desiredDay = Number(dayOfMonth) || d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months[recurrence]);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(desiredDay, lastDay));
  } else {
    const days = { daily: 1, weekly: 7, biweekly: 14, custom: Number(customDays) || 1 }[recurrence];
    if (!Number.isInteger(days) || days < 1) throw new HttpError(400, 'Invalid recurrence');
    d.setUTCDate(d.getUTCDate() + days);
    if (['weekly', 'biweekly'].includes(recurrence) && dayOfWeek != null && dayOfWeek !== '') {
      const target = Number(dayOfWeek);
      if (!Number.isInteger(target) || target < 0 || target > 6) throw new HttpError(400, 'Invalid day of week');
      d.setUTCDate(d.getUTCDate() + (target - d.getUTCDay() + 7) % 7);
    }
  }
  return d.toISOString().slice(0, 10);
}
module.exports = { computeNextDue };
