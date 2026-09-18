function configureSecurity(app, { crypto, db, express, helmet, rateLimit }) {
  app.use(express.json());

  // Trust proxy (needed for secure cookies behind Railway / load balancer)
  app.set('trust proxy', 1);

  // Security headers (Helmet)
  // Baseline CSP. Keeps 'unsafe-inline' for scripts/styles because the SPA still
  // relies on inline onclick handlers and style attributes — tightening this
  // further requires a nonce/hash refactor. object-src/frame-ancestors/base-uri
  // are locked down regardless to block the common XSS escalation paths.
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-eval'", // required by jsPDF
          'https://cdnjs.cloudflare.com',
          'https://unpkg.com',
        ],
        // helmet's default is 'none', which blocks every inline onclick
        // handler in the SPA. Keep this permissive until we migrate to
        // delegated listeners.
        'script-src-attr': ["'unsafe-inline'"],
        'style-src': [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com',
          'https://unpkg.com',
        ],
        'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
        'img-src': [
          "'self'",
          'data:',
          'blob:',
          'https://*.tile.openstreetmap.org',
          'https://unpkg.com',
        ],
        'connect-src': ["'self'", 'https://*.supabase.co'],
        'frame-ancestors': ["'none'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'upgrade-insecure-requests': [],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }));

  // Rate limiting – brute force protection for auth endpoints
  const authRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15-minute window
    max: 20,                    // max 20 attempts per IP per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
    skipSuccessfulRequests: true, // only count failed attempts toward the limit
  });

  // ---------------------------------------------------------------------------
  // Stateless JWT-like token helpers (HMAC-SHA256, no external dependency)
  // Tokens are stored in an httpOnly cookie so the frontend doesn't change.
  // Token now carries: userId, userRole, organizationId, activeOrgId
  //   - organizationId = the user's home org (null for superadmins)
  //   - activeOrgId    = the org context they're currently viewing
  //                      (set when superadmin clicks "Open" on an org)
  // ---------------------------------------------------------------------------
  // Fail-closed: production must ship with a strong SESSION_SECRET.
  // Dev keeps a stable (but clearly-marked) fallback so local runs don't break.
  const IS_PRODUCTION = process.env.NODE_ENV === 'production';
  if (IS_PRODUCTION) {
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
      throw new Error('SESSION_SECRET environment variable must be set to at least 32 characters in production.');
    }
  }
  const TOKEN_SECRET = process.env.SESSION_SECRET || 'dev-only-insecure-session-secret-do-not-use-in-production';
  const TOKEN_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours in ms

  function createToken(payload) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + TOKEN_MAX_AGE })).toString('base64url');
    const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${signature}`;
  }

  function verifyToken(token) {
    if (!token) return null;
    try {
      const [header, body, signature] = token.split('.');
      const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(`${header}.${body}`).digest('base64url');
      if (typeof signature !== 'string' || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
      return payload;
    } catch { return null; }
  }

  // Middleware: parse token from cookie and attach to req
  const cookieParser = require('cookie-parser');
  app.use(cookieParser());

  // ---------------------------------------------------------------------------
  // CSRF protection: signed double-submit tokens bound to the session.
  // ---------------------------------------------------------------------------
  const { doubleCsrf } = require('csrf-csrf');
  const CSRF_COOKIE = 'csrf_token';
  const CSRF_SESSION_COOKIE = IS_PRODUCTION ? '__Host-bop_csrf_session' : 'bop_csrf_session';
  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  const csrfCookieOptions = {
    httpOnly: false, secure: IS_PRODUCTION, sameSite: 'lax', path: '/', maxAge: TOKEN_MAX_AGE,
  };
  const { generateCsrfToken, doubleCsrfProtection } = doubleCsrf({
    getSecret: () => TOKEN_SECRET,
    getSessionIdentifier: req => req.cookies.session_token || req.cookies[CSRF_SESSION_COOKIE] || '',
    cookieName: CSRF_COOKIE,
    cookieOptions: csrfCookieOptions,
    getCsrfTokenFromRequest: req => req.headers['x-csrf-token'],
    // The external IdP posts the SAML response; the SAML handler verifies it.
    skipCsrfProtection: () => false,
  });
  app.use((req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      if (!req.cookies.session_token && !req.cookies[CSRF_SESSION_COOKIE]) {
        const anonymousSession = crypto.randomBytes(32).toString('base64url');
        res.cookie(CSRF_SESSION_COOKIE, anonymousSession, { ...csrfCookieOptions, httpOnly: true });
        req.cookies[CSRF_SESSION_COOKIE] = anonymousSession;
      }
      // GET also refreshes legacy tokens and tokens from the previous login.
      req.cookies.csrf_token = generateCsrfToken(req, res);
    }
    next();
  });
  app.use(doubleCsrfProtection);

  app.use((req, res, next) => {
    const token = req.cookies?.session_token;
    const payload = verifyToken(token);
    req.session = {
      userId: payload?.userId || null,
      userRole: payload?.userRole || null,
      organizationId: payload?.organizationId || null,  // user's home org
      activeOrgId: payload?.activeOrgId || null,         // superadmin's current org context
      sv: payload?.sv ?? 0,                              // session_version — must match users.session_version
      save(cb) {
        const newToken = createToken({
          userId: req.session.userId,
          userRole: req.session.userRole,
          organizationId: req.session.organizationId,
          activeOrgId: req.session.activeOrgId,
          sv: req.session.sv ?? 0,
        });
        res.cookie('session_token', newToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production' || req.protocol === 'https',
          sameSite: 'lax',
          maxAge: TOKEN_MAX_AGE,
          path: '/',
        });
        req.cookies.session_token = newToken;
        req.cookies.csrf_token = generateCsrfToken(req, res);
        if (cb) cb(null);
      },
      destroy(cb) {
        res.clearCookie('session_token', { path: '/' });
        req.session.userId = null;
        req.session.userRole = null;
        req.session.organizationId = null;
        req.session.activeOrgId = null;
        req.session.sv = 0;
        if (cb) cb(null);
      },
    };
    next();
  });

  // Session revocation: each user has a session_version; bumping it invalidates
  // all outstanding tokens for that user (logout-all, password reset, suspend).
  function invalidateSessionVersionCache() {} // Sessions are checked against the database on every request.

  async function bumpUserSessionVersion(userId) {
    await db.prepare(
      "UPDATE users SET session_version = COALESCE(session_version, 0) + 1, updated_at = datetime('now') WHERE id = ?"
    ).run(userId);
    invalidateSessionVersionCache(userId);
  }

  // ---------------------------------------------------------------------------
  // Multi-tenant helpers
  // ---------------------------------------------------------------------------

  // Returns the effective organization_id for the current request.
  // - Superadmins: uses activeOrgId (set when they enter an org)
  // - Org users/admins: uses their own organizationId
  // Returns null if no org context is set (superadmin at MSP dashboard level).
  function getOrgId(req) {
    if (req.session.userRole === 'superadmin') {
      return req.session.activeOrgId || null;
    }
    return req.session.organizationId || null;
  }

  // Middleware: require that an org context is active (rejects if no org selected)
  function requireOrgContext(req, res, next) {
    const orgId = getOrgId(req);
    if (!orgId) {
      return res.status(400).json({ error: 'No organization context. Select an organization first.' });
    }
    req.orgId = orgId;
    next();
  }

  // Middleware factory: require one of the given module permissions ('org',
  // 'risk', 'ops', 'audit'). Mirrors the rules already used by the AI agent and
  // import endpoints: administrator roles pass; everyone else needs one listed
  // module permissions in users.permissions (JSON array).
  function requireModulePermission(...allowed) {
    return async (req, res, next) => {
      try {
        if (req.session.userRole === 'superadmin') return next();
        const user = await db.prepare('SELECT role, permissions FROM users WHERE id = ?').get(req.session.userId);
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        let perms = [];
        try { perms = JSON.parse(user.permissions || '[]'); } catch (_) { perms = []; }
        if (user.role === 'org_admin' || user.role === 'admin') return next();
        if (allowed.some(p => perms.includes(p))) return next();
        return res.status(403).json({ error: `Access denied: requires the ${allowed.join(' or ')} module permission` });
      } catch (err) {
        console.error('[auth] module permission check failed:', err.message);
        return res.status(500).json({ error: 'Permission check failed' });
      }
    };
  }

  // Operational Planning endpoints: accessible to users with the Operational
  // Planning ('ops') module, plus 'org' because the Org Planning dashboard /
  // Mission Control surfaces tasks and follow-up actions.
  const requireOpsAccess = requireModulePermission('ops', 'org');

  // Middleware: require superadmin role
  function requireSuperadmin(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: 'Authentication required' });
    if (req.session.userRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required' });
    next();
  }

  // Health check endpoint for Cloud Run (must be before auth middleware)
  app.get('/health', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await db.get('SELECT 1 AS ready');
      res.status(200).json({ status: 'healthy', database: 'ready', timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'unavailable', database: 'unavailable' });
    }
  });

  // Auth middleware for static files - protect everything except login page
  app.use(async (req, res, next) => {
    const publicPath = ['/login', '/login.html', '/health', '/api/auth/login', '/api/auth/check'].includes(req.path);
    if (req.session.userId) {
      const user = await db.get('SELECT id, role, status, organization_id, permissions, session_version, expiry_date FROM users WHERE id=?', req.session.userId);
      const expired = user?.expiry_date && String(user.expiry_date).slice(0,10) < new Date().toISOString().slice(0,10);
      const valid = user && user.status === 'active' && !expired &&
        (user.session_version ?? 0) === req.session.sv && user.role === req.session.userRole &&
        (user.organization_id || null) === req.session.organizationId;
      const org = valid && user.role !== 'superadmin' && user.organization_id
        ? await db.get('SELECT is_active FROM organizations WHERE id=?', user.organization_id) : null;
      if (!valid || (user.role !== 'superadmin' && (!org || !org.is_active))) req.session.destroy();
      else req.authUser = user;
    }
    if (!publicPath && !req.authUser) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentication required or session revoked' });
      return res.redirect('/login');
    }
    next();
  });

  function requireAdmin(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: 'Authentication required' });
    if (!['superadmin', 'org_admin', 'admin'].includes(req.session.userRole)) {
      return res.status(403).json({ error: 'Administrator access required' });
    }
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization context. Select an organization first.' });
    req.orgId = orgId;
    next();
  }

  return { getOrgId, requireOrgContext, requireOpsAccess, requireSuperadmin, requireAdmin, bumpUserSessionVersion, authRateLimiter };
}

module.exports = { configureSecurity };
