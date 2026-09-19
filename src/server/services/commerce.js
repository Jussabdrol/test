const crypto = require('node:crypto');
const Stripe = require('stripe');
const { HttpError } = require('../shared/errors');
const CATALOG = Object.freeze({ monthly: 14900, yearly: 149000, currency: 'eur', name: 'Bop Complete' });
function config() {
  const env = process.env;
  const validUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } };
  return {
    enabled: env.BOP_CHECKOUT_ENABLED === 'true' && !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET &&
      validUrl(env.BOP_PUBLIC_URL) && validUrl(env.BOP_TERMS_URL) && validUrl(env.BOP_PRIVACY_URL) && !!env.STRIPE_PRODUCT_ID,
    origin: validUrl(env.BOP_PUBLIC_URL) ? new URL(env.BOP_PUBLIC_URL).origin : 'https://go-bop.com',
    termsUrl: env.BOP_TERMS_URL, privacyUrl: env.BOP_PRIVACY_URL,
  };
}
let stripe;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new HttpError(503, 'Online checkout is not available yet.');
  if (!stripe) stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { timeout: 15000, maxNetworkRetries: 1 });
  return stripe;
}
function orderCookie(id) {
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'development-commerce-secret').update(id).digest('hex');
  return `${id}.${sig}`;
}
function readOrderCookie(value) {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(value)) return null;
  const expected = orderCookie(value.split('.')[0]);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(value)) ? value.split('.')[0] : null;
}
function validateCheckout(body) {
  const { organization, name, email, password, interval, accepted } = body || {};
  if (typeof organization !== 'string' || organization.trim().length < 2 || organization.length > 120 ||
      typeof name !== 'string' || !name.trim() || name.length > 100 ||
      typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72 ||
      !['month', 'year'].includes(interval) || accepted !== true) {
    throw new HttpError(400, 'Enter your organization, name, email, a password of 12–72 bytes and accept the license terms.');
  }
  return { organization: organization.trim(), name: name.trim(), email: email.trim().toLowerCase(), password, interval };
}
async function createCheckout(db, bcrypt, input, client = getStripe()) {
  const settings = config();
  if (!settings.enabled) throw new HttpError(503, 'Online checkout is not available yet. Existing users can sign in.');
  const data = validateCheckout(input);
  const hash = await bcrypt.hash(data.password, 12);
  const order = await db.transaction(async () => {
    await db.get('SELECT pg_advisory_xact_lock(hashtext(?))', data.email);
    const existing = await db.get('SELECT * FROM users WHERE email=?', data.email);
    if (existing) {
      const pending = await db.get("SELECT l.*, u.email, o.name AS organization_name FROM bop_licenses l JOIN users u ON u.id=l.owner_id JOIN organizations o ON o.id=l.organization_id WHERE l.owner_id=? AND l.status='pending'", existing.id);
      if (!pending || existing.status !== 'pending' || !existing.password || !await bcrypt.compare(data.password, existing.password)) throw new HttpError(409, 'This email cannot be used for a new checkout. Sign in to your existing account or use another email.');
      if (pending.billing_interval !== data.interval) throw new HttpError(409, `A ${pending.billing_interval === 'year' ? 'yearly' : 'monthly'} checkout already exists. Select that billing period to resume it.`);
      return pending;
    }
    const id = crypto.randomUUID();
    const slug = `${data.organization.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0,60) || 'organization'}-${id.slice(0,8)}`;
    const org = await db.get('INSERT INTO organizations(name,slug,is_active) VALUES (?,?,0) RETURNING id', data.organization, slug);
    const user = await db.get("INSERT INTO users(organization_id,name,email,password,role,status) VALUES (?,?,?,?,'org_admin','pending') RETURNING id", org.id, data.name, data.email, hash);
    await db.run("INSERT INTO org_mission(organization_id,content) VALUES (?,'')", org.id);
    await db.run('INSERT INTO bop_licenses(id,organization_id,owner_id,billing_interval,accepted_terms_url,accepted_privacy_url) VALUES (?,?,?,?,?,?)', id, org.id, user.id, data.interval, settings.termsUrl, settings.privacyUrl);
    return { id, organization_id: org.id, owner_id: user.id, billing_interval: data.interval, email: data.email, organization_name: data.organization, checkout_attempt: 0 };
  });
  // Serialize retries across replicas; Stripe's idempotency key also covers a lost response.
  return db.transaction(async () => {
    const current = await db.get('SELECT * FROM bop_licenses WHERE id=? FOR UPDATE', order.id);
    if (current.status !== 'pending') throw new HttpError(409, 'Your organization is already activated. Please sign in.');
    if (current.stripe_session_id) {
      const previous = await client.checkout.sessions.retrieve(current.stripe_session_id);
      if (previous.status === 'open' && previous.url) return { id: order.id, url: previous.url };
      if (previous.status === 'complete') return { id: order.id, processing: true };
      current.checkout_attempt += 1;
      await db.run('UPDATE bop_licenses SET checkout_attempt=?,stripe_session_id=NULL WHERE id=?', current.checkout_attempt, order.id);
    }
    const session = await client.checkout.sessions.create({
      mode: 'subscription', client_reference_id: order.id, customer_email: order.email, locale: 'en',
      line_items: [{ price_data: { currency: CATALOG.currency, unit_amount: order.billing_interval === 'year' ? CATALOG.yearly : CATALOG.monthly, product: process.env.STRIPE_PRODUCT_ID, recurring: { interval: order.billing_interval }, tax_behavior: 'exclusive' }, quantity: 1 }],
      automatic_tax: { enabled: true }, billing_address_collection: 'required', tax_id_collection: { enabled: true },
      metadata: { bop_license_id: order.id }, subscription_data: { metadata: { bop_license_id: order.id } },
      success_url: `${settings.origin}/welcome`, cancel_url: `${settings.origin}/start?interval=${order.billing_interval}&cancelled=1`,
    }, { idempotencyKey: `bop-checkout-${order.id}-${current.checkout_attempt}` });
    await db.run('UPDATE bop_licenses SET stripe_session_id=?,updated_at=NOW() WHERE id=?', session.id, order.id);
    return { id: order.id, url: session.url };
  });
}
// Re-fetch current Stripe objects inside the row lock: delayed or repeated events
// cannot restore stale entitlements or create a second organization.
async function syncLicense(db, id, client = getStripe()) {
  return db.transaction(async () => {
    const order = await db.get('SELECT * FROM bop_licenses WHERE id=? FOR UPDATE', id);
    if (!order?.stripe_session_id) return;
    const session = await client.checkout.sessions.retrieve(order.stripe_session_id);
    if (session.client_reference_id !== order.id || session.mode !== 'subscription' || !session.subscription) return;
    const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
    const subscription = await client.subscriptions.retrieve(subId, { expand: ['latest_invoice'] });
    if (subscription.metadata?.bop_license_id !== order.id) throw new Error('Subscription/license mismatch');
    const item = subscription.items?.data?.[0];
    const invoice = subscription.latest_invoice;
    const period = item?.current_period_end;
    const paid = session.payment_status === 'paid' && invoice?.status === 'paid' && subscription.status === 'active' && Number.isFinite(period) && period * 1000 > Date.now();
    const terminal = ['canceled', 'unpaid', 'incomplete_expired', 'paused'].includes(subscription.status);
    let until = order.access_until;
    if (paid) until = new Date(period * 1000).toISOString();
    const valid = until && new Date(until).getTime() > Date.now() && !terminal;
    const status = terminal ? 'cancelled' : valid ? 'active' : order.status === 'pending' ? 'pending' : 'expired';
    await db.run('UPDATE bop_licenses SET status=?,access_until=?,stripe_subscription_id=?,stripe_customer_id=?,updated_at=NOW() WHERE id=?', status, until, subId, typeof session.customer === 'string' ? session.customer : session.customer?.id, order.id);
    if (paid && order.status === 'pending') {
      await db.run('UPDATE organizations SET is_active=1 WHERE id=?', order.organization_id);
      await db.run("UPDATE users SET status='active' WHERE id=? AND status='pending'", order.owner_id);
    }
  });
}
async function handleStripeEvent(db, event, client = getStripe()) {
  const object = event.data?.object;
  let id;
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) id = object?.client_reference_id;
  else if (event.type.startsWith('customer.subscription.')) id = object?.metadata?.bop_license_id;
  else if (['invoice.paid', 'invoice.payment_failed'].includes(event.type)) {
    const subscription = object?.parent?.subscription_details?.subscription || object?.subscription;
    if (typeof subscription === 'string') id = (await db.get('SELECT id FROM bop_licenses WHERE stripe_subscription_id=?', subscription))?.id;
  }
  if (typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)) await syncLicense(db, id, client);
}
module.exports = { CATALOG, config, getStripe, orderCookie, readOrderCookie, validateCheckout, createCheckout, syncLicense, handleStripeEvent };
