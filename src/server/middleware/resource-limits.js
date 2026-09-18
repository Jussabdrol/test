const { rateLimit } = require('express-rate-limit');
function installResourceLimits(app) {
  const key = req => String(req.authUser?.organization_id || req.session?.activeOrgId || 'platform') + ':' + String(req.authUser?.id || 'anonymous');
  const api = rateLimit({ windowMs: 60000, limit: 300, keyGenerator: key, standardHeaders: true, legacyHeaders: false });
  const ai = rateLimit({ windowMs: 15 * 60000, limit: 20, keyGenerator: key, standardHeaders: true, legacyHeaders: false });
  const tenantAi = rateLimit({ windowMs: 86400000, limit: 100, keyGenerator: req => String(req.authUser?.organization_id || req.session?.activeOrgId || 'platform'), standardHeaders: true, legacyHeaders: false });
  const concurrent = new Map();
  app.use('/api', (req, res, next) => req.authUser ? api(req, res, next) : next());
  app.use('/api/agent', (req, res, next) => req.method === 'POST' ? ai(req, res, err => err ? next(err) : tenantAi(req, res, next)) : next());
  app.use('/api', (req, res, next) => {
    if (!req.authUser || req.method === 'GET' || (!req.is('multipart/form-data') && !req.originalUrl.startsWith('/api/agent'))) return next();
    const tenant = String(req.authUser.organization_id || req.session.activeOrgId || 'platform');
    if ((concurrent.get(tenant) || 0) >= 2) return res.status(429).json({ error: 'Too many concurrent uploads or AI requests. Retry shortly.' });
    concurrent.set(tenant, (concurrent.get(tenant) || 0) + 1);
    let released = false;
    const release = () => { if (released) return; released = true; const count = concurrent.get(tenant) - 1; if (count) concurrent.set(tenant, count); else concurrent.delete(tenant); };
    res.once('finish', release); res.once('close', release);
    next();
  });
}
module.exports = { installResourceLimits };
