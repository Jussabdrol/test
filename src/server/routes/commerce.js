const commerce = require('../services/commerce');
function registerStripeWebhook(app, { express, db, rateLimit }) {
  // Exact isolated endpoint before JSON parsing and browser CSRF. Stripe's signed
  // raw-body verification replaces CSRF here; browser endpoints keep normal CSRF.
  app.post('/api/commerce/webhook', rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false }), express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    if (!process.env.STRIPE_WEBHOOK_SECRET || !process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Billing is not configured' });
    let event;
    try { event = commerce.getStripe().webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
    catch { return res.status(400).json({ error: 'Invalid webhook signature' }); }
    await commerce.handleStripeEvent(db, event);
    res.json({ received: true });
  });
}
function registerCommerceRoutes(app, { db, bcrypt, rateLimit }) {
  const checkoutLimit = rateLimit({ windowMs: 15 * 60000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many checkout attempts. Please try again later.' } });
  app.get('/api/commerce/catalog', (req, res) => {
    const settings = commerce.config();
    res.set('Cache-Control', 'no-store').json({ ...commerce.CATALOG, enabled: !!settings.enabled, termsUrl: settings.enabled ? settings.termsUrl : null, privacyUrl: settings.enabled ? settings.privacyUrl : null });
  });
  app.post('/api/commerce/checkout', checkoutLimit, async (req, res) => {
    if (!commerce.config().enabled) return res.status(503).json({ error: 'Online checkout is not available yet. Existing users can sign in.' });
    if (req.session.userId) return res.status(409).json({ error: 'Use your organization console to manage an existing subscription.' });
    const result = await commerce.createCheckout(db, bcrypt, req.body);
    res.cookie('bop_order', commerce.orderCookie(result.id), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 7 * 86400000 });
    res.set('Cache-Control', 'no-store').json({ url: result.url, processing: result.processing || false });
  });
  app.get('/api/commerce/status', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = commerce.readOrderCookie(req.cookies.bop_order);
    if (!id) return res.json({ status: 'unavailable' });
    const license = await db.get('SELECT status FROM bop_licenses WHERE id=?', id);
    res.json({ status: license?.status || 'unavailable' });
  });
  app.post('/api/commerce/portal', async (req, res) => {
    if (!req.authUser || !['admin','org_admin'].includes(req.authUser.role)) return res.status(403).json({ error: 'Organization administrator access required' });
    const license = await db.get('SELECT stripe_customer_id FROM bop_licenses WHERE organization_id=?', req.authUser.organization_id);
    if (!license?.stripe_customer_id) return res.status(409).json({ error: 'Your organization does not have an online subscription. Contact your administrator.' });
    const portal = await commerce.getStripe().billingPortal.sessions.create({ customer: license.stripe_customer_id, return_url: `${commerce.config().origin}/console` });
    res.json({ url: portal.url });
  });
}
module.exports = { registerCommerceRoutes, registerStripeWebhook };
