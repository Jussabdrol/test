const path = require('node:path');
const rateLimit = require('express-rate-limit');
function registerWebsiteRoutes(app) {
  const pageLimit = rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false, message: 'Too many requests. Please try again shortly.' });
  const site = file => path.join(__dirname, '../../../public/website', file);
  app.get('/', pageLimit, (req, res) => res.sendFile(site('index.html')));
  app.get('/start', pageLimit, (req, res) => res.sendFile(site('start.html')));
  app.get('/welcome', pageLimit, (req, res) => res.sendFile(site('welcome.html')));
  app.get('/billing', pageLimit, (req, res) => res.sendFile(site('billing.html')));
  app.get('/console', pageLimit, (req, res) => res.sendFile(path.join(__dirname, '../../../public/index.html')));
}
module.exports = { registerWebsiteRoutes };
