const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const TOPICS = ['product', 'technical', 'account', 'privacy', 'feedback'];
const STATUSES = ['open', 'in_progress', 'resolved'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function registerSupportRoutes(app, { db, requireSuperadmin }) {
  const limit = rateLimit({ windowMs: 60*60*1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many messages. Please wait an hour before sending another.' } });
  const noStore = (req, res, next) => {res.set('Cache-Control', 'no-store');next();};
  app.post('/api/support/tickets', noStore, limit, async (req, res) => {
    const input = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return res.status(400).json({ error: 'Invalid message.' });
    if (input.website) return res.status(400).json({ error: 'Your message could not be accepted.' });
    const data = {};
    for (const [key, min, max] of [['name',0,100],['email',3,254],['organization',0,150],['subject',5,160],['message',20,5000]]) {
      if (input[key] !== undefined && typeof input[key] !== 'string') return res.status(400).json({ error: `Invalid ${key}.` });
      const value = (input[key] || '').trim();
      if (value.length < min || value.length > max || value.includes('\0')) return res.status(400).json({ error: `Please check ${key} (${min}–${max} characters).` });
      data[key] = value;
    }
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(data.email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!TOPICS.includes(input.topic) || typeof input.submission_id !== 'string' || !UUID.test(input.submission_id)) return res.status(400).json({ error: 'Invalid topic or submission. Reload the page and try again.' });
    data.topic = input.topic;
    const hash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
    try {
      const created = await db.get(`INSERT INTO support_tickets (reference, submission_id, payload_hash, name, email, organization, topic, subject, message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (submission_id) DO NOTHING RETURNING reference`,
      crypto.randomUUID(), input.submission_id, hash, data.name, data.email, data.organization, data.topic, data.subject, data.message);
      const ticket = created || await db.get('SELECT reference, payload_hash FROM support_tickets WHERE submission_id=?', input.submission_id);
      if (!created && ticket?.payload_hash !== hash) return res.status(409).json({ error: 'This submission was already used for another message. Reload before sending a new message.' });
      return res.status(created ? 201 : 200).json({ reference: 'BOP-' + ticket.reference });
    } catch (error) {
      // Avoid logging message contents, email addresses or SQL parameters.
      console.error('Support submission failed:', /^[0-9A-Z]{5}$/.test(error.code || '') ? error.code : 'database error');
      return res.status(503).json({ error: 'The support queue is temporarily unavailable. Your message has not been confirmed. Please try again later.' });
    }
  });
  app.get('/api/msp/support-tickets', requireSuperadmin, noStore, async (req, res) => {
    const status = req.query.status || 'open';
    const before = req.query.before;
    if (status !== 'all' && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    if (before !== undefined && (typeof before !== 'string' || !/^[1-9]\d{0,9}$/.test(before) || Number(before)>2147483647)) return res.status(400).json({ error: 'Invalid page.' });
    const clauses = [], params = [];
    if (status !== 'all') {clauses.push('status=?');params.push(status);}
    if (before) {clauses.push('id<?');params.push(Number(before));}
    const rows = await db.all(`SELECT id, reference, name, email, organization, topic, subject, message, status, internal_notes, revision, created_at, updated_at FROM support_tickets ${clauses.length ? 'WHERE '+clauses.join(' AND ') : ''} ORDER BY id DESC LIMIT 31`, ...params);
    const counts = await db.all('SELECT status, count(*)::int AS count FROM support_tickets GROUP BY status');
    res.json({ tickets: rows.slice(0,30), next: rows.length>30 ? rows[29].id : null, counts });
  });
  app.patch('/api/msp/support-tickets/:id', requireSuperadmin, noStore, async (req, res) => {
    const { status, internal_notes, revision } = req.body || {};
    if (!/^[1-9]\d{0,9}$/.test(req.params.id) || Number(req.params.id)>2147483647 || !STATUSES.includes(status) || typeof internal_notes !== 'string' || internal_notes.length>10000 || internal_notes.includes('\0') || !Number.isInteger(revision) || revision<1) return res.status(400).json({ error: 'Invalid ticket update.' });
    const row = await db.get('UPDATE support_tickets SET status=?, internal_notes=?, revision=revision+1, updated_at=now() WHERE id=? AND revision=? RETURNING id, revision',status,internal_notes,Number(req.params.id),revision);
    if (!row) return res.status(409).json({ error: 'This ticket changed or no longer exists. Refresh before saving.' });
    res.json(row);
  });
}
module.exports = { registerSupportRoutes };
