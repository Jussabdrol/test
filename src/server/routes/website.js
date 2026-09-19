const path = require('node:path');
const rateLimit = require('express-rate-limit');
function registerWebsiteRoutes(app) {
  const pageLimit = rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false, message: 'Too many requests. Please try again shortly.' });
  const site = file => path.join(__dirname, '../../../public/website', file);
  app.get('/', pageLimit, (req, res) => res.sendFile(site('index.html')));
  for (const page of ['tour', 'guides', 'security', 'contact']) app.get('/' + page, pageLimit, (req, res) => res.sendFile(site(page + '.html')));
  app.get('/start', pageLimit, (req, res) => res.sendFile(site('start.html')));
  app.get('/welcome', pageLimit, (req, res) => res.sendFile(site('welcome.html')));
  app.get('/billing', pageLimit, (req, res) => res.sendFile(site('billing.html')));
  app.get('/console', pageLimit, (req, res) => res.sendFile(path.join(__dirname, '../../../public/index.html')));
  // The merchant account and licensing migration are not activated. Fail closed:
  // this release exposes product information, never checkout or provisioning.
  app.get('/api/commerce/catalog', (req, res) => res.set('Cache-Control', 'no-store').json({
    enabled: false, monthly: 14900, yearly: 149000, currency: 'eur', name: 'Bop Complete',
  }));
  app.get('/api/commerce/status', (req, res) => res.set('Cache-Control', 'no-store').json({ status: 'unavailable' }));
}
module.exports = { registerWebsiteRoutes };
