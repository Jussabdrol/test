// Legacy hand-written SAML validation is retired. No assertion is trusted until
// an audited IdP integration with request binding and replay protection exists.
const unavailable = (req, res) => res.status(503).json({ error: 'SSO is temporarily unavailable. Use password sign-in.' });
function registerSamlRoutes(app, { requireAdmin }) {
  app.get('/api/admin/saml/config', requireAdmin, (req, res) => res.json({ enabled: 0, has_certificate: false, unavailable: true }));
  app.put('/api/admin/saml/config', requireAdmin, unavailable);
  app.post('/api/admin/saml/test', requireAdmin, unavailable);
  app.get('/saml/metadata', unavailable);
  app.get('/saml/login', unavailable);
  app.post('/saml/callback', unavailable);
  app.get('/saml/logout', unavailable);
  app.get('/api/auth/session', (req, res) => res.json({ authenticated: false }));
}
module.exports = { registerSamlRoutes };
