const path = require('node:path');
function registerWebsiteRoutes(app) {
  const site = file => path.join(__dirname, '../../../public/website', file);
  app.get('/', (req, res) => res.sendFile(site('index.html')));
  app.get('/start', (req, res) => res.sendFile(site('start.html')));
  app.get('/welcome', (req, res) => res.sendFile(site('welcome.html')));
  app.get('/billing', (req, res) => res.sendFile(site('billing.html')));
  app.get('/console', (req, res) => res.sendFile(path.join(__dirname, '../../../public/index.html')));
  // The merchant account and licensing migration are not activated. Fail closed:
  // this release exposes product information, never checkout or provisioning.
  app.get('/api/commerce/catalog', (req, res) => res.set('Cache-Control', 'no-store').json({
    enabled: false, monthly: 14900, yearly: 149000, currency: 'eur', name: 'Bop Complete',
  }));
  app.get('/api/commerce/status', (req, res) => res.set('Cache-Control', 'no-store').json({ status: 'unavailable' }));
}
module.exports = { registerWebsiteRoutes };
