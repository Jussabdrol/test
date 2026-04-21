// Patch Express to forward async errors to the error handler automatically (must be first)
require('express-async-errors');
const mammoth = require('mammoth');
const HTMLtoDOCX = require('html-to-docx');

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const deflateRaw = promisify(zlib.deflateRaw);
const XLSX = require('xlsx');
const db = require('./db');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase client – used for Storage AND Auth
const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  : null;

// Supabase service-role client – for admin auth operations (user creation, metadata updates)
const supabaseAdmin = process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const UPLOADS_BUCKET = 'uploads';

// Allowed MIME types for general evidence/document uploads. SVG is intentionally
// excluded because it can carry inline scripts. HTML-ish types are rejected to
// stop stored-XSS via uploaded files that a browser might render.
const ALLOWED_UPLOAD_MIMES = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp',
  'text/plain', 'text/csv',
  'application/json', 'application/xml', 'text/xml',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip', 'application/x-zip-compressed',
  'application/octet-stream', // generic binary — still forced to download by storage headers
]);
const BLOCKED_UPLOAD_EXTENSIONS = new Set([
  '.html', '.htm', '.xhtml', '.svg', '.xml', '.js', '.mjs', '.cjs', '.php',
  '.phtml', '.phar', '.jsp', '.asp', '.aspx', '.cgi', '.pl', '.py', '.rb',
  '.sh', '.bat', '.cmd', '.ps1', '.exe', '.dll', '.so', '.msi',
]);

function uploadFileFilter(allowed) {
  return (req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase();
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (BLOCKED_UPLOAD_EXTENSIONS.has(ext)) {
      return cb(new Error(`File type not allowed: ${ext}`));
    }
    if (!allowed.has(mime)) {
      return cb(new Error(`MIME type not allowed: ${mime || 'unknown'}`));
    }
    cb(null, true);
  };
}

// File upload setup - use memory storage; files are sent to Supabase Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: uploadFileFilter(ALLOWED_UPLOAD_MIMES),
});
// PDF-only uploads for report endpoints
const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: uploadFileFilter(new Set(['application/pdf'])),
});

// Helper: generate a unique storage path for an uploaded file
function storageKey(folder, originalname) {
  const ext = path.extname(originalname);
  const base = path.basename(originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${folder}/${Date.now()}_${base}${ext}`;
}

// Helper: upload a buffer to Supabase Storage; returns the storage path
// Use the service-role client for server-side storage operations (bypasses RLS)
const storageClient = supabaseAdmin || supabase;

async function uploadToSupabase(folder, file) {
  if (!storageClient) throw new Error('Supabase is not configured (missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY)');
  const key = storageKey(folder, file.originalname);
  const { error } = await storageClient.storage
    .from(UPLOADS_BUCKET)
    .upload(key, file.buffer, { contentType: file.mimetype, upsert: false });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
  return key;
}

// Helper: get a short-lived signed download URL from Supabase Storage.
// Forces Content-Disposition: attachment so the browser never renders
// user-uploaded files inline (defense against HTML/SVG/PDF-hosted XSS).
async function getSignedUrl(storagePath, expiresIn = 300, downloadName = true) {
  if (!storageClient) throw new Error('Supabase is not configured (missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY)');
  const { data, error } = await storageClient.storage
    .from(UPLOADS_BUCKET)
    .createSignedUrl(storagePath, expiresIn, { download: downloadName });
  if (error) throw new Error(`Supabase signed URL failed: ${error.message}`);
  return data.signedUrl;
}

// Helper: delete a file from Supabase Storage (ignores "not found" errors)
async function deleteFromSupabase(storagePath) {
  if (!storageClient) return;
  await storageClient.storage.from(UPLOADS_BUCKET).remove([storagePath]);
}

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
    if (signature !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

// Middleware: parse token from cookie and attach to req
const cookieParser = require('cookie-parser');
app.use(cookieParser());

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
// Cached briefly so we don't hit the DB on every request during bursty traffic.
const SV_CACHE_TTL_MS = 30 * 1000;
const sessionVersionCache = new Map(); // userId -> { sv, expires }

async function getUserSessionVersion(userId) {
  const now = Date.now();
  const cached = sessionVersionCache.get(userId);
  if (cached && cached.expires > now) return cached.sv;
  const row = await db.prepare('SELECT session_version FROM users WHERE id = ?').get(userId);
  const sv = row ? (row.session_version ?? 0) : null; // null => user no longer exists
  sessionVersionCache.set(userId, { sv, expires: now + SV_CACHE_TTL_MS });
  return sv;
}

function invalidateSessionVersionCache(userId) {
  sessionVersionCache.delete(userId);
}

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

// Middleware: require superadmin role
function requireSuperadmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Authentication required' });
  if (req.session.userRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required' });
  next();
}

// Health check endpoint for Cloud Run (must be before auth middleware)
app.get('/health', async (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Auth middleware for static files - protect everything except login page
app.use(async (req, res, next) => {
  // Allow login page, health check, auth endpoints, and SAML SSO flow
  // (/saml/callback is called directly by the IdP with no session cookie)
  if (req.path === '/login' || req.path === '/login.html' || req.path === '/health' ||
      req.path.startsWith('/api/auth/') || req.path.startsWith('/saml/')) {
    return next();
  }
  // Check authentication for all other routes
  if (!req.session.userId) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.redirect('/login');
  }
  // Revocation check: token must carry the current session_version for the user.
  // This lets admins force-logout a user (password reset, suspend, logout-all)
  // by bumping users.session_version.
  try {
    const currentSv = await getUserSessionVersion(req.session.userId);
    if (currentSv === null || (req.session.sv ?? 0) !== currentSv) {
      req.session.destroy();
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Session has been revoked. Please sign in again.' });
      }
      return res.redirect('/login');
    }
  } catch (err) {
    console.error('[auth] session_version lookup failed:', err.message);
    return res.status(500).json({ error: 'Authentication check failed' });
  }
  next();
});

// Serve login page without auth
app.get('/login', async (req, res) => {
  if (req.session.userId) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// --- Database Setup ---
// Database is initialized via db.initDatabase() in startServer() below
// Schema and migrations are handled in db.js and schema.js
// Uses Supabase PostgreSQL – no local file system dependencies

// --- Helper: compute next due date ---
function computeNextDue(fromDate, recurrence, customDays, dayOfWeek, dayOfMonth) {
  const d = new Date(fromDate);
  switch (recurrence) {
    case 'daily':
      d.setDate(d.getDate() + 1);
      break;
    case 'weekly':
      d.setDate(d.getDate() + 7);
      // Snap to target day of week if specified (0=Sun, 1=Mon, ..., 6=Sat)
      if (dayOfWeek != null && dayOfWeek !== '' && !isNaN(dayOfWeek)) {
        const target = parseInt(dayOfWeek);
        const current = d.getDay();
        const diff = (target - current + 7) % 7;
        if (diff !== 0) d.setDate(d.getDate() + diff);
      }
      break;
    case 'biweekly':
      d.setDate(d.getDate() + 14);
      break;
    case 'monthly':
      d.setMonth(d.getMonth() + 1);
      if (dayOfMonth) d.setDate(Math.min(dayOfMonth, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
      break;
    case 'quarterly':
      d.setMonth(d.getMonth() + 3);
      break;
    case 'yearly':
      d.setFullYear(d.getFullYear() + 1);
      break;
    case 'custom':
      d.setDate(d.getDate() + (customDays || 1));
      break;
  }
  return d.toISOString().split('T')[0];
}

// Generate missing task_instances rows for all active task series in an org,
// from the latest scheduled_date (or the series' start_date) up to a target horizon.
// Idempotent thanks to UNIQUE(task_id, scheduled_date); safe to call on every Task Log load.
async function ensureTaskInstances(orgId, horizonDays = 14) {
  const today = new Date();
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + horizonDays);
  const horizonStr = horizon.toISOString().split('T')[0];

  const tasks = await db.prepare('SELECT * FROM tasks WHERE organization_id = ? AND is_active = 1').all(orgId);
  for (const task of tasks) {
    const last = await db.prepare(
      'SELECT MAX(scheduled_date) AS d FROM task_instances WHERE task_id = ? AND organization_id = ?'
    ).get(task.id, orgId);
    let cursor = last && last.d
      ? computeNextDue(last.d, task.recurrence, task.custom_days, task.day_of_week, task.day_of_month)
      : task.start_date;
    let safety = 0;
    while (cursor <= horizonStr && safety < 400) {
      await db.prepare(
        `INSERT INTO task_instances (organization_id, task_id, scheduled_date)
         VALUES (?, ?, ?) ON CONFLICT (task_id, scheduled_date) DO NOTHING`
      ).run(orgId, task.id, cursor);
      cursor = computeNextDue(cursor, task.recurrence, task.custom_days, task.day_of_week, task.day_of_month);
      safety++;
    }
  }
}

// --- Utility helpers ---

// Improvement 10: safe integer param parser — prevents NaN from reaching the DB driver
function parseIntParam(value, defaultVal, { min = 0, max = Infinity } = {}) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return defaultVal;
  return Math.min(Math.max(n, min), max);
}

// Strict YYYY-MM-DD validator. Rejects anything that could smuggle markup
// or invalid calendar dates into scheduled_date/start_date/next_due fields.
function isValidDateStr(v) {
  if (typeof v !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().startsWith(v);
}

// Improvement 13: allowed entity types for cross-link operations
const ALLOWED_ENTITY_TYPES = new Set([
  'risk', 'task', 'action', 'requirement', 'audit', 'ncr',
  'role', 'process', 'system', 'asset', 'facility',
  'document', 'treatment', 'usecase',
  'ai_model', 'ai_dataset', 'ai_usecase',
]);

// Improvement 7: fire-and-forget process event emitter (never throws into caller)
async function emitEvent(orgId, caseId, caseType, activity, actor = '', attrs = {}, processId = null) {
  try {
    await db.prepare(
      `INSERT INTO process_events
         (organization_id, case_id, case_type, activity, actor, process_id, attributes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(orgId, caseId, caseType, activity, actor, processId || null, JSON.stringify(attrs));
  } catch (err) {
    console.error('[process_events] emit failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// SSRF protection for webhook delivery
// - Rejects non-http(s) schemes
// - Rejects localhost / metadata hostnames by name
// - Resolves DNS and rejects any private / loopback / link-local / multicast IP
// - Connects to the resolved IP directly (with Host header) to mitigate
//   DNS rebinding between the lookup and the request
// ---------------------------------------------------------------------------
const dns = require('dns').promises;
const net = require('net');

function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0) return true;                            // 0.0.0.0/8
    if (a === 10) return true;                           // 10.0.0.0/8 (RFC1918)
    if (a === 127) return true;                          // loopback
    if (a === 169 && b === 254) return true;             // link-local incl. AWS metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12 (RFC1918)
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16 (RFC1918)
    if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 (CGNAT)
    if (a >= 224) return true;                           // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
    if (lower.startsWith('fe80')) return true;                          // link-local
    if (lower.startsWith('ff')) return true;                            // multicast
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    return false;
  }
  return true; // unknown family: block
}

const BLOCKED_WEBHOOK_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
]);

async function validateWebhookUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch { throw new Error('Invalid webhook URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Webhook URL must use http or https');
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_WEBHOOK_HOSTS.has(host) || host.endsWith('.localhost')) {
    throw new Error('Webhook host is not allowed');
  }
  // If the hostname is already an IP literal, validate it directly
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error('Webhook URL resolves to a blocked address');
    return { url, addrs: [{ address: host, family: net.isIPv6(host) ? 6 : 4 }] };
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { throw new Error('Webhook host could not be resolved'); }
  if (!addrs.length) throw new Error('Webhook host could not be resolved');
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error('Webhook URL resolves to a blocked address');
  }
  return { url, addrs };
}

// Dispatch a webhook request to an already-validated URL, connecting to the
// resolved IP directly (mitigates DNS rebinding). Returns { statusCode, body }.
function sendValidatedWebhook({ url, addrs }, payloadStr, headers, timeoutMs = 10000) {
  const https = require('https');
  const http = require('http');
  const client = url.protocol === 'https:' ? https : http;
  const ip = addrs[0].address;
  const options = {
    host: ip,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: { ...headers, Host: url.host },
    timeout: timeoutMs,
  };
  if (url.protocol === 'https:') {
    options.servername = url.hostname; // TLS SNI + cert validation against the real hostname
  }
  return new Promise((resolve, reject) => {
    const req = client.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: body.substring(0, 500) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payloadStr);
    req.end();
  });
}

// Webhook delivery – fire-and-forget, never throws into caller
function fireWebhooks(orgId, event, data) {
  (async () => {
    try {
      const webhooks = await db.prepare(
        "SELECT * FROM webhooks WHERE organization_id = ? AND status = 'active'"
      ).all(orgId);

      const matching = webhooks.filter(w => {
        try { return JSON.parse(w.events || '[]').includes(event); } catch { return false; }
      });
      if (!matching.length) return;

      const https = require('https');
      const http  = require('http');
      const payloadStr = JSON.stringify({ event, timestamp: new Date().toISOString(), organization_id: orgId, data });

      for (const webhook of matching) {
        (async () => {
          try {
            const validated = await validateWebhookUrl(webhook.url);
            const headers = {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payloadStr),
              'User-Agent': 'LetTheFrameWork/1.0',
            };
            if (webhook.secret) {
              headers['X-Webhook-Signature'] = 'sha256=' + crypto.createHmac('sha256', webhook.secret).update(payloadStr).digest('hex');
            }
            await sendValidatedWebhook(validated, payloadStr, headers);
            await db.prepare("UPDATE webhooks SET last_triggered = NOW() WHERE id = ?").run(webhook.id);
          } catch (err) {
            await db.prepare('UPDATE webhooks SET failure_count = failure_count + 1 WHERE id = ?').run(webhook.id);
            console.warn(`[webhook] delivery failed for "${webhook.name}" (${event}):`, err.message);
          }
        })().catch(() => {});
      }
    } catch (err) {
      console.warn('[webhook] fireWebhooks error:', err.message);
    }
  })();
}

// --- Authentication Routes ---

// Check if user is authenticated
app.get('/api/auth/check', async (req, res) => {
  if (req.session.userId) {
    const user = await db.prepare('SELECT id, name, email, role, permissions, organization_id FROM users WHERE id = ?').get(req.session.userId);
    if (user) {
      const orgId = getOrgId(req);
      let activeOrg = null;
      if (orgId) {
        activeOrg = await db.prepare('SELECT id, name, slug FROM organizations WHERE id = ?').get(orgId);
      }
      return res.json({
        authenticated: true,
        user,
        activeOrg,
        isSuperadmin: user.role === 'superadmin',
      });
    }
  }
  res.json({ authenticated: false });
});

// Login – authenticates via Supabase Auth first (if available), falls back to local bcrypt
app.post('/api/auth/login', authRateLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // --- Try Supabase Auth first ---
    let supabaseUser = null;
    if (supabase) {
      try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (!error && data?.user) {
          supabaseUser = data.user;
        }
      } catch (_) { /* Supabase Auth unavailable – fall through to local auth */ }
    }

    // --- Look up the user in our database ---
    const user = await db.prepare('SELECT * FROM users WHERE email = ? AND status = ?').get(email.toLowerCase().trim(), 'active');
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // --- If Supabase Auth didn't authenticate, try local bcrypt ---
    if (!supabaseUser) {
      if (!user.password) {
        return res.status(401).json({ error: 'Account not set up. Please contact administrator.' });
      }
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
    }

    // --- Check org is active (for non-superadmins) ---
    if (user.role !== 'superadmin' && user.organization_id) {
      const org = await db.prepare('SELECT is_active FROM organizations WHERE id = ?').get(user.organization_id);
      if (!org || !org.is_active) {
        return res.status(403).json({ error: 'Your organization has been deactivated. Contact your MSP administrator.' });
      }
    }

    // Update last active
    await db.prepare("UPDATE users SET last_active = datetime('now') WHERE id = ?").run(user.id);

    // Sync Supabase Auth metadata (org_id, role) if admin client available
    if (supabaseAdmin && (supabaseUser || user.supabase_uid)) {
      const uid = supabaseUser?.id || user.supabase_uid;
      try {
        await supabaseAdmin.auth.admin.updateUserById(uid, {
          app_metadata: { organization_id: user.organization_id, role: user.role },
          user_metadata: { name: user.name, department: user.department || '' },
        });
        // Store supabase_uid if not already stored
        if (!user.supabase_uid && supabaseUser?.id) {
          await db.prepare('UPDATE users SET supabase_uid = ? WHERE id = ?').run(supabaseUser.id, user.id);
        }
      } catch (_) { /* Non-critical – continue login */ }
    }

    req.session.userId = user.id;
    req.session.userRole = user.role;
    req.session.organizationId = user.organization_id || null;
    // For non-superadmin users, activeOrgId is always their own org
    req.session.activeOrgId = user.role === 'superadmin' ? null : (user.organization_id || null);
    req.session.sv = user.session_version ?? 0;

    req.session.save((saveErr) => {
      if (saveErr) {
        console.error('Session save error:', saveErr);
        return res.status(500).json({ error: 'Session could not be saved' });
      }
      res.json({
        success: true,
        user: {
          id: user.id, name: user.name, email: user.email, role: user.role,
          permissions: user.permissions, organization_id: user.organization_id,
        },
        isSuperadmin: user.role === 'superadmin',
      });
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout — clears only the current cookie
app.post('/api/auth/logout', async (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true });
  });
});

// Logout everywhere — bump session_version to invalidate all outstanding tokens
app.post('/api/auth/logout-all', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  try {
    await bumpUserSessionVersion(req.session.userId);
  } catch (err) {
    console.error('[logout-all] bump failed:', err.message);
    return res.status(500).json({ error: 'Logout failed' });
  }
  req.session.destroy(() => res.json({ success: true }));
});

// ===========================================================================
// MSP PORTAL API (superadmin-only)
// ===========================================================================

// List all organizations with user counts
app.get('/api/msp/organizations', requireSuperadmin, async (req, res) => {
  const orgs = await db.prepare(`
    SELECT o.*, COUNT(u.id) as user_count
    FROM organizations o
    LEFT JOIN users u ON u.organization_id = o.id AND u.role != 'superadmin'
    GROUP BY o.id
    ORDER BY o.created_at DESC
  `).all();
  res.json(orgs);
});

// Get single organization
app.get('/api/msp/organizations/:id', requireSuperadmin, async (req, res) => {
  const org = await db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  const users = await db.prepare("SELECT id, name, email, role, status FROM users WHERE organization_id = ? AND role != 'superadmin'").all(org.id);
  org.users = users;
  res.json(org);
});

// Create organization
app.post('/api/msp/organizations', requireSuperadmin, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Organization name is required' });

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const existing = await db.prepare('SELECT id FROM organizations WHERE slug = ?').get(slug);
  if (existing) return res.status(409).json({ error: 'An organization with this name already exists' });

  const result = await db.prepare('INSERT INTO organizations (name, slug, is_active) VALUES (?, ?, 1)').run(name, slug);
  const orgId = result.lastInsertRowid;

  // Seed essential data for the new organization
  await db.prepare("INSERT INTO org_mission (organization_id, content) VALUES (?, '')").run(orgId);
  for (const f of require('./schema').DEFAULT_THREAT_FEEDS) {
    await db.prepare('INSERT INTO threat_feeds (organization_id, name, url, tier) VALUES (?, ?, ?, ?)').run(orgId, f.name, f.url, f.tier);
  }

  res.status(201).json(await db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId));
});

// Activate / deactivate organization
app.put('/api/msp/organizations/:id', requireSuperadmin, async (req, res) => {
  const org = await db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const { name, is_active } = req.body;
  const updates = [];
  const params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  await db.prepare(`UPDATE organizations SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(await db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id));
});

// Superadmin: enter an organization's environment
app.post('/api/msp/switch-org', requireSuperadmin, async (req, res) => {
  const { organization_id } = req.body;
  if (!organization_id) {
    // Clear org context – return to MSP dashboard
    req.session.activeOrgId = null;
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Failed to update session' });
      res.json({ success: true, activeOrg: null });
    });
    return;
  }
  const org = await db.prepare('SELECT * FROM organizations WHERE id = ?').get(organization_id);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  req.session.activeOrgId = org.id;
  req.session.save((err) => {
    if (err) return res.status(500).json({ error: 'Failed to update session' });
    res.json({ success: true, activeOrg: { id: org.id, name: org.name, slug: org.slug } });
  });
});

// MSP Dashboard stats
app.get('/api/msp/dashboard', requireSuperadmin, async (req, res) => {
  const totalOrgs = (await db.prepare('SELECT COUNT(*) as c FROM organizations').get()).c;
  const activeOrgs = (await db.prepare('SELECT COUNT(*) as c FROM organizations WHERE is_active = 1').get()).c;
  const totalUsers = (await db.prepare("SELECT COUNT(*) as c FROM users WHERE role != 'superadmin'").get()).c;
  res.json({ totalOrgs, activeOrgs, totalUsers });
});

// ===========================================================================
// ORG-SCOPED API ROUTES
// All routes below require an active org context via requireOrgContext
// ===========================================================================

// --- API Routes ---

// Get all tasks with optional filters
app.get('/api/tasks', requireOrgContext, async (req, res) => {
  const { active, assignee, category, priority, overdue } = req.query;
  let sql = 'SELECT * FROM tasks WHERE organization_id = ?';
  const params = [req.orgId];

  if (active !== undefined) {
    sql += ' AND is_active = ?';
    params.push(active === 'true' ? 1 : 0);
  }
  if (assignee) {
    sql += ' AND assignee = ?';
    params.push(assignee);
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (priority) {
    sql += ' AND priority = ?';
    params.push(priority);
  }
  if (overdue === 'true') {
    sql += ' AND next_due < date("now")';
  }

  sql += ' ORDER BY next_due ASC';
  const tasks = await db.prepare(sql).all(...params);
  res.json(tasks);
});

// Get dashboard stats
app.get('/api/dashboard', requireOrgContext, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const oid = req.orgId;
  const stats = {
    totalActive: (await db.prepare('SELECT COUNT(*) as c FROM tasks WHERE organization_id = ? AND is_active = 1').get(oid)).c,
    dueToday: (await db.prepare('SELECT COUNT(*) as c FROM tasks WHERE organization_id = ? AND is_active = 1 AND next_due = ?').get(oid, today)).c,
    overdue: (await db.prepare('SELECT COUNT(*) as c FROM tasks WHERE organization_id = ? AND is_active = 1 AND next_due < ?').get(oid, today)).c,
    completedThisWeek: (await db.prepare(`SELECT COUNT(*) as c FROM task_instances WHERE organization_id = ? AND status = 'completed' AND completed_at >= date('now', '-7 days')`).get(oid)).c,
    completedThisMonth: (await db.prepare(`SELECT COUNT(*) as c FROM task_instances WHERE organization_id = ? AND status = 'completed' AND completed_at >= date('now', '-30 days')`).get(oid)).c,
    byCategory: await db.prepare('SELECT category, COUNT(*) as count FROM tasks WHERE organization_id = ? AND is_active = 1 GROUP BY category').all(oid),
    byPriority: await db.prepare('SELECT priority, COUNT(*) as count FROM tasks WHERE organization_id = ? AND is_active = 1 GROUP BY priority').all(oid),
    byAssignee: await db.prepare("SELECT assignee, COUNT(*) as count FROM tasks WHERE organization_id = ? AND is_active = 1 AND assignee != '' GROUP BY assignee").all(oid),
    upcomingTasks: await db.prepare('SELECT * FROM tasks WHERE organization_id = ? AND is_active = 1 AND next_due >= ? ORDER BY next_due ASC LIMIT 10').all(oid, today),
    overdueTasks: await db.prepare('SELECT * FROM tasks WHERE organization_id = ? AND is_active = 1 AND next_due < ? ORDER BY next_due ASC').all(oid, today),
    openActions: (await db.prepare("SELECT COUNT(*) as c FROM actions WHERE organization_id = ? AND status IN ('open','in_progress')").get(oid)).c,
    overdueActions: (await db.prepare("SELECT COUNT(*) as c FROM actions WHERE organization_id = ? AND status IN ('open','in_progress') AND due_date < ? AND due_date IS NOT NULL").get(oid, today)).c,
  };

  // KPI: Actions per check
  const totalCompletions = (await db.prepare("SELECT COUNT(*) as c FROM task_instances WHERE organization_id = ? AND status = 'completed'").get(oid)).c;
  const totalActionsAll = (await db.prepare('SELECT COUNT(*) as c FROM actions WHERE organization_id = ?').get(oid)).c;
  stats.actionsPerCheck = totalCompletions > 0 ? +(totalActionsAll / totalCompletions).toFixed(2) : 0;
  stats.totalCompletions = totalCompletions;
  stats.totalActionsCount = totalActionsAll;

  // Actions per check this month vs last month
  const actionsThisMonth = (await db.prepare("SELECT COUNT(*) as c FROM actions WHERE organization_id = ? AND created_at >= date('now','start of month')").get(oid)).c;
  const completionsThisMonth = (await db.prepare("SELECT COUNT(*) as c FROM task_instances WHERE organization_id = ? AND status = 'completed' AND completed_at >= date('now','start of month')").get(oid)).c;
  const actionsLastMonth = (await db.prepare("SELECT COUNT(*) as c FROM actions WHERE organization_id = ? AND created_at >= date('now','start of month','-1 month') AND created_at < date('now','start of month')").get(oid)).c;
  const completionsLastMonth = (await db.prepare("SELECT COUNT(*) as c FROM task_instances WHERE organization_id = ? AND status = 'completed' AND completed_at >= date('now','start of month','-1 month') AND completed_at < date('now','start of month')").get(oid)).c;
  stats.actionsPerCheckThisMonth = completionsThisMonth > 0 ? +(actionsThisMonth / completionsThisMonth).toFixed(2) : 0;
  stats.actionsPerCheckLastMonth = completionsLastMonth > 0 ? +(actionsLastMonth / completionsLastMonth).toFixed(2) : 0;

  // KPI: On-time completion trend (last 30 days vs previous 30 days)
  const allTasks = await db.prepare('SELECT id, recurrence, custom_days FROM tasks WHERE organization_id = ?').all(oid);
  const taskRecMap = {};
  for (const t of allTasks) taskRecMap[t.id] = t;

  function getIntervalDays(rec, customDays) {
    switch(rec) {
      case 'daily': return 1; case 'weekly': return 7; case 'biweekly': return 14;
      case 'monthly': return 30; case 'quarterly': return 91; case 'yearly': return 365;
      case 'custom': return customDays || 1; default: return 30;
    }
  }

  const recent30 = await db.prepare("SELECT task_id, completed_at FROM task_instances WHERE organization_id = ? AND status = 'completed' AND completed_at >= date('now','-30 days') ORDER BY completed_at ASC").all(oid);
  const prev30 = await db.prepare("SELECT task_id, completed_at FROM task_instances WHERE organization_id = ? AND status = 'completed' AND completed_at >= date('now','-60 days') AND completed_at < date('now','-30 days') ORDER BY completed_at ASC").all(oid);

  function calcOnTimeRate(completions) {
    if (completions.length === 0) return null;
    let onTime = 0, total = 0;
    const byTask = {};
    for (const c of completions) {
      if (!byTask[c.task_id]) byTask[c.task_id] = [];
      byTask[c.task_id].push((c.completed_at instanceof Date ? c.completed_at.toISOString() : String(c.completed_at)).split('T')[0]);
    }
    for (const [taskId, dates] of Object.entries(byTask)) {
      const rec = taskRecMap[taskId];
      if (!rec) continue;
      const interval = getIntervalDays(rec.recurrence, rec.custom_days);
      dates.sort();
      for (let i = 0; i < dates.length; i++) {
        total++;
        if (i === 0) { onTime++; continue; }
        const gap = (new Date(dates[i]) - new Date(dates[i-1])) / (86400000);
        if (gap <= interval * 1.5) onTime++;
      }
    }
    return total > 0 ? Math.round((onTime / total) * 100) : null;
  }

  stats.onTimeRateCurrent = calcOnTimeRate(recent30);
  stats.onTimeRatePrevious = calcOnTimeRate(prev30);

  res.json(stats);
});

// Get single task series with recent instance history
app.get('/api/tasks/:id', requireOrgContext, async (req, res) => {
  const task = await db.prepare('SELECT * FROM tasks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const instances = await db.prepare(
    `SELECT * FROM task_instances
     WHERE task_id = ? AND organization_id = ? AND status = 'completed'
     ORDER BY completed_at DESC LIMIT 20`
  ).all(req.params.id, req.orgId);
  res.json({ ...task, completions: instances });
});

// Create task
app.post('/api/tasks', requireOrgContext, async (req, res) => {
  const { title, description, assignee, category, priority, recurrence, custom_days, day_of_week, day_of_month, start_date } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (start_date !== undefined && start_date !== null && start_date !== '' && !isValidDateStr(start_date)) {
    return res.status(400).json({ error: 'start_date must be in YYYY-MM-DD format' });
  }

  const startDt = (start_date && isValidDateStr(start_date))
    ? start_date
    : new Date().toISOString().split('T')[0];
  const nextDue = startDt;

  const result = await db.prepare(`
    INSERT INTO tasks (organization_id, title, description, assignee, category, priority, recurrence, custom_days, day_of_week, day_of_month, start_date, next_due)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.orgId,
    title,
    description || '',
    assignee || '',
    category || 'General',
    priority || 'Medium',
    recurrence || 'daily',
    custom_days || null,
    day_of_week || null,
    day_of_month || null,
    startDt,
    nextDue
  );

  const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(task);
});

// Update task
app.put('/api/tasks/:id', requireOrgContext, async (req, res) => {
  const existing = await db.prepare('SELECT * FROM tasks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Task not found' });

  for (const dateField of ['start_date', 'next_due']) {
    const v = req.body[dateField];
    if (v !== undefined && v !== null && v !== '' && !isValidDateStr(v)) {
      return res.status(400).json({ error: `${dateField} must be in YYYY-MM-DD format` });
    }
  }

  const fields = ['title', 'description', 'assignee', 'category', 'priority', 'recurrence', 'custom_days', 'day_of_week', 'day_of_month', 'start_date', 'next_due', 'is_active'];
  const updates = [];
  const params = [];

  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);

  await db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
  const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  res.json(task);
});

// Complete a task series (upsert the instance for next_due, mark completed, advance next_due)
app.post('/api/tasks/:id/complete', requireOrgContext, async (req, res) => {
  const task = await db.prepare('SELECT * FROM tasks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const scheduled = task.next_due;
  await db.prepare(
    `INSERT INTO task_instances (organization_id, task_id, scheduled_date, status, completed_by, completed_at, notes)
     VALUES (?, ?, ?, 'completed', ?, NOW(), ?)
     ON CONFLICT (task_id, scheduled_date) DO UPDATE
       SET status = 'completed',
           completed_by = EXCLUDED.completed_by,
           completed_at = NOW(),
           notes = EXCLUDED.notes,
           updated_at = NOW()`
  ).run(req.orgId, task.id, scheduled, req.body.completed_by || '', req.body.notes || '');

  const instance = await db.prepare(
    'SELECT * FROM task_instances WHERE task_id = ? AND scheduled_date = ? AND organization_id = ?'
  ).get(task.id, scheduled, req.orgId);

  const nextDue = computeNextDue(task.next_due, task.recurrence, task.custom_days, task.day_of_week, task.day_of_month);
  await db.prepare("UPDATE tasks SET next_due = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?").run(nextDue, task.id, req.orgId);

  // Improvement 7: fire-and-forget process event
  emitEvent(req.orgId, `task-${task.id}-${task.next_due}`, 'task_cycle', 'task_completed',
    req.body.completed_by || '',
    { task_title: task.title, category: task.category, priority: task.priority,
      instance_id: instance.id });

  fireWebhooks(req.orgId, 'task_complete', {
    id: task.id, title: task.title, category: task.category,
    priority: task.priority, completed_by: req.body.completed_by || '', next_due: nextDue,
  });

  const updated = await db.prepare('SELECT * FROM tasks WHERE id = ? AND organization_id = ?').get(task.id, req.orgId);
  res.json({ ...updated, instance_id: instance.id });
});

// Delete task
app.delete('/api/tasks/:id', requireOrgContext, async (req, res) => {
  const result = await db.prepare('DELETE FROM tasks WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
  res.json({ success: true });
});

// --- Task Log (task_instances) API ---

// List task instances (auto-generates missing pending rows for active series up to today+14d)
app.get('/api/task-instances', requireOrgContext, async (req, res) => {
  const { status, task_id, from, to, completed_by, limit } = req.query;

  // Ensure pending instances exist up to the horizon before querying (idempotent)
  if (!from && !to) {
    try { await ensureTaskInstances(req.orgId, 14); }
    catch (err) { console.error('[task-instances] ensure failed:', err.message); }
  }

  let sql = `SELECT ti.*, t.title AS task_title, t.category AS task_category,
    t.assignee AS task_assignee, t.priority AS task_priority, t.recurrence AS task_recurrence,
    (SELECT COUNT(*) FROM actions a WHERE a.instance_id = ti.id) AS action_count,
    (SELECT COUNT(*) FROM actions a WHERE a.instance_id = ti.id AND a.status IN ('open','in_progress')) AS open_action_count
    FROM task_instances ti JOIN tasks t ON ti.task_id = t.id
    WHERE ti.organization_id = ?`;
  const params = [req.orgId];
  if (status) { sql += ' AND ti.status = ?'; params.push(status); }
  if (task_id) { sql += ' AND ti.task_id = ?'; params.push(task_id); }
  if (completed_by) { sql += ' AND ti.completed_by = ?'; params.push(completed_by); }
  if (from) { sql += ' AND ti.scheduled_date >= ?'; params.push(from); }
  if (to)   { sql += ' AND ti.scheduled_date <= ?'; params.push(to); }
  sql += ` ORDER BY CASE WHEN ti.status = 'pending' THEN ti.scheduled_date END ASC,
                    ti.completed_at DESC NULLS LAST,
                    ti.scheduled_date DESC
           LIMIT ?`;
  params.push(parseIntParam(limit, 500, { min: 1, max: 2000 }));
  res.json(await db.prepare(sql).all(...params));
});

// Get single instance
app.get('/api/task-instances/:id', requireOrgContext, async (req, res) => {
  const row = await db.prepare(
    `SELECT ti.*, t.title AS task_title, t.category AS task_category, t.assignee AS task_assignee
     FROM task_instances ti JOIN tasks t ON ti.task_id = t.id
     WHERE ti.id = ? AND ti.organization_id = ?`
  ).get(req.params.id, req.orgId);
  if (!row) return res.status(404).json({ error: 'Instance not found' });
  res.json(row);
});

// Complete an instance
app.post('/api/task-instances/:id/complete', requireOrgContext, async (req, res) => {
  const item = await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!item) return res.status(404).json({ error: 'Instance not found' });

  await db.prepare(
    `UPDATE task_instances
     SET status = 'completed', completed_by = ?, completed_at = NOW(), notes = ?, updated_at = NOW()
     WHERE id = ? AND organization_id = ?`
  ).run(req.body.completed_by || '', req.body.notes || item.notes || '', req.params.id, req.orgId);

  // If the completed instance matches the task's current next_due, advance next_due
  const task = await db.prepare('SELECT * FROM tasks WHERE id = ? AND organization_id = ?').get(item.task_id, req.orgId);
  if (task && task.next_due === item.scheduled_date) {
    const nextDue = computeNextDue(task.next_due, task.recurrence, task.custom_days, task.day_of_week, task.day_of_month);
    await db.prepare("UPDATE tasks SET next_due = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?").run(nextDue, task.id, req.orgId);
  }

  emitEvent(req.orgId, `task-${item.task_id}-${item.scheduled_date}`, 'task_cycle', 'task_completed',
    req.body.completed_by || '',
    { task_title: task ? task.title : '', category: task ? task.category : '', priority: task ? task.priority : '',
      instance_id: item.id });

  fireWebhooks(req.orgId, 'task_complete', {
    id: item.task_id, title: task ? task.title : '',
    category: task ? task.category : '', priority: task ? task.priority : '',
    completed_by: req.body.completed_by || '', scheduled_date: item.scheduled_date,
  });

  res.json(await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
});

// Skip an instance
app.post('/api/task-instances/:id/skip', requireOrgContext, async (req, res) => {
  const item = await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!item) return res.status(404).json({ error: 'Instance not found' });
  await db.prepare(
    `UPDATE task_instances SET status = 'skipped', notes = ?, updated_at = NOW()
     WHERE id = ? AND organization_id = ?`
  ).run(req.body.notes || item.notes || '', req.params.id, req.orgId);

  const task = await db.prepare('SELECT * FROM tasks WHERE id = ? AND organization_id = ?').get(item.task_id, req.orgId);
  if (task && task.next_due === item.scheduled_date) {
    const nextDue = computeNextDue(task.next_due, task.recurrence, task.custom_days, task.day_of_week, task.day_of_month);
    await db.prepare("UPDATE tasks SET next_due = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?").run(nextDue, task.id, req.orgId);
  }

  res.json(await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
});

// Reopen an instance (back to pending)
app.post('/api/task-instances/:id/reopen', requireOrgContext, async (req, res) => {
  const item = await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!item) return res.status(404).json({ error: 'Instance not found' });
  await db.prepare(
    `UPDATE task_instances
     SET status = 'pending', completed_by = '', completed_at = NULL, updated_at = NOW()
     WHERE id = ? AND organization_id = ?`
  ).run(req.params.id, req.orgId);
  res.json(await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
});

// Upload evidence to an instance
app.post('/api/task-instances/:id/evidence', requireOrgContext, upload.single('file'), async (req, res) => {
  const item = await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!item) return res.status(404).json({ error: 'Instance not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let storagePath;
  try {
    storagePath = await uploadToSupabase('task-instance-evidence', req.file);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  let evidenceFiles = [];
  try { evidenceFiles = JSON.parse(item.evidence_files || '[]'); } catch(e) {}
  evidenceFiles.push({
    id: Date.now(),
    type: 'file',
    name: req.file.originalname,
    path: storagePath,
    size: req.file.size,
    mime: req.file.mimetype,
    uploaded_at: new Date().toISOString()
  });

  await db.prepare('UPDATE task_instances SET evidence_files = ?, updated_at = NOW() WHERE id = ? AND organization_id = ?').run(JSON.stringify(evidenceFiles), req.params.id, req.orgId);

  // Also create a Document Control entry for this evidence and auto-cross-link to the task
  try {
    const task = await db.prepare('SELECT title FROM tasks WHERE id = ?').get(item.task_id);
    const docTitle = `Evidence: ${req.file.originalname}`;
    const docDesc = `Evidence uploaded for task "${task ? task.title : 'Unknown'}" (instance #${req.params.id}, ${item.scheduled_date})`;
    const docResult = await db.prepare(`INSERT INTO documents (organization_id, title, description, doc_type, version, owner, status, file_name, file_path, file_size, mime_type, linked_module, linked_ref_type, linked_ref_id, classification) VALUES (?, ?, ?, 'evidence', '1.0', '', 'approved', ?, ?, ?, ?, 'operational-planning', 'task', ?, 'confidential')`).run(
      req.orgId, docTitle, docDesc, req.file.originalname, storagePath, req.file.size, req.file.mimetype, item.task_id
    );
    if (docResult.lastInsertRowid && item.task_id) {
      const [s_type, s_id, t_type, t_id] = 'document' < 'task'
        ? ['document', docResult.lastInsertRowid, 'task', item.task_id]
        : ['task', item.task_id, 'document', docResult.lastInsertRowid];
      await db.prepare('INSERT OR IGNORE INTO cross_links (organization_id, source_type, source_id, target_type, target_id) VALUES (?, ?, ?, ?, ?)').run(req.orgId, s_type, s_id, t_type, t_id);
    }
  } catch (docErr) {
    console.error('Failed to create Document Control entry for instance evidence:', docErr.message);
  }

  res.json(await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
});

// Download instance evidence file
app.get('/api/task-instances/:id/evidence/:fileId/download', requireOrgContext, async (req, res) => {
  const item = await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!item) return res.status(404).json({ error: 'Instance not found' });
  let evidenceFiles = [];
  try { evidenceFiles = JSON.parse(item.evidence_files || '[]'); } catch(e) {}
  const file = evidenceFiles.find(f => String(f.id) === String(req.params.fileId));
  if (!file || file.type !== 'file') return res.status(404).json({ error: 'File not found' });
  try {
    const url = await getSignedUrl(file.path, 300, file.name || true);
    res.redirect(url);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete instance evidence file
app.delete('/api/task-instances/:id/evidence/:fileId', requireOrgContext, async (req, res) => {
  const item = await db.prepare('SELECT * FROM task_instances WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!item) return res.status(404).json({ error: 'Instance not found' });
  let evidenceFiles = [];
  try { evidenceFiles = JSON.parse(item.evidence_files || '[]'); } catch(e) {}
  const file = evidenceFiles.find(f => String(f.id) === String(req.params.fileId));
  if (file && file.type === 'file' && file.path) {
    await deleteFromSupabase(file.path);
  }
  evidenceFiles = evidenceFiles.filter(f => String(f.id) !== String(req.params.fileId));
  await db.prepare('UPDATE task_instances SET evidence_files = ?, updated_at = NOW() WHERE id = ? AND organization_id = ?').run(JSON.stringify(evidenceFiles), req.params.id, req.orgId);
  res.json({ success: true });
});

// Get unique assignees and categories for filters
app.get('/api/meta', requireOrgContext, async (req, res) => {
  const assignees = (await db.prepare("SELECT DISTINCT assignee FROM tasks WHERE organization_id = ? AND assignee != '' ORDER BY assignee").all(req.orgId)).map(r => r.assignee);
  const categories = (await db.prepare('SELECT DISTINCT category FROM tasks WHERE organization_id = ? ORDER BY category').all(req.orgId)).map(r => r.category);
  res.json({ assignees, categories });
});

// Get yearly plan data (all due dates + completions for a year)
app.get('/api/yearly', requireOrgContext, async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  // Get all active tasks and project their due dates across the year
  const tasks = await db.prepare('SELECT * FROM tasks WHERE organization_id = ? AND is_active = 1').all(req.orgId);
  const dueDates = {}; // { "2026-03-15": [{ task_id, title, ... }] }

  for (const task of tasks) {
    let d = new Date(task.start_date);
    // If task started before this year, advance to first occurrence in this year
    const yearStart = new Date(startDate);
    while (d < yearStart) {
      d = new Date(computeNextDue(d.toISOString().split('T')[0], task.recurrence, task.custom_days, task.day_of_week, task.day_of_month));
    }
    // Generate all occurrences within the year
    const yearEnd = new Date(endDate);
    let safety = 0;
    while (d <= yearEnd && safety < 400) {
      const ds = d.toISOString().split('T')[0];
      if (!dueDates[ds]) dueDates[ds] = [];
      dueDates[ds].push({
        task_id: task.id,
        title: task.title,
        assignee: task.assignee,
        category: task.category,
        priority: task.priority,
        recurrence: task.recurrence,
        type: 'due',
      });
      d = new Date(computeNextDue(ds, task.recurrence, task.custom_days, task.day_of_week, task.day_of_month));
      safety++;
    }
  }

  // Get completed task instances for this year
  const completions = await db.prepare(
    `SELECT ti.*, t.title, t.assignee, t.category, t.priority, t.recurrence
     FROM task_instances ti JOIN tasks t ON ti.task_id = t.id
     WHERE ti.organization_id = ? AND ti.status = 'completed'
       AND ti.completed_at >= ? AND ti.completed_at <= ?`
  ).all(req.orgId, startDate, endDate + ' 23:59:59');

  const completedDates = {};
  for (const c of completions) {
    const ds = (c.completed_at instanceof Date ? c.completed_at.toISOString() : String(c.completed_at)).split('T')[0];
    if (!completedDates[ds]) completedDates[ds] = [];
    completedDates[ds].push({
      task_id: c.task_id,
      title: c.title,
      assignee: c.assignee,
      category: c.category,
      priority: c.priority,
      recurrence: c.recurrence,
      completed_by: c.completed_by,
      type: 'completed',
    });
  }

  res.json({ year, dueDates, completedDates });
});

// --- Follow-up Actions API ---

// Get all follow-ups (actions) with optional filters
app.get('/api/actions', requireOrgContext, async (req, res) => {
  const { task_id, instance_id, status, process_id } = req.query;
  let sql = `SELECT a.*, COALESCE(t.title, 'Standalone') as task_title, p.name as process_name,
    ti.scheduled_date AS instance_scheduled_date
    FROM actions a
    LEFT JOIN tasks t ON a.task_id = t.id
    LEFT JOIN task_instances ti ON a.instance_id = ti.id
    LEFT JOIN org_architecture p ON a.process_id = p.id
    WHERE a.organization_id = ?`;
  const params = [req.orgId];
  if (task_id) { sql += ' AND a.task_id = ?'; params.push(task_id); }
  if (instance_id) { sql += ' AND a.instance_id = ?'; params.push(instance_id); }
  if (status) { sql += ' AND a.status = ?'; params.push(status); }
  if (process_id) { sql += ' AND a.process_id = ?'; params.push(process_id); }
  sql += ' ORDER BY a.created_at DESC';
  res.json(await db.prepare(sql).all(...params));
});

// Get single action
app.get('/api/actions/:id', requireOrgContext, async (req, res) => {
  const action = await db.prepare(`SELECT a.*, t.title as task_title, p.name as process_name
    FROM actions a
    LEFT JOIN tasks t ON a.task_id = t.id
    LEFT JOIN org_architecture p ON a.process_id = p.id
    WHERE a.id = ? AND a.organization_id = ?`).get(req.params.id, req.orgId);
  if (!action) return res.status(404).json({ error: 'Action not found' });
  res.json(action);
});

// Create follow-up (optionally linked to an instance/task/process, or standalone)
app.post('/api/actions', requireOrgContext, async (req, res) => {
  const { instance_id, task_id, process_id, title, description, assignee, priority, due_date } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  // If linked to an instance, inherit task_id from the instance when not explicitly provided.
  let resolvedTaskId = task_id || null;
  if (instance_id && !resolvedTaskId) {
    const inst = await db.prepare('SELECT task_id FROM task_instances WHERE id = ? AND organization_id = ?').get(instance_id, req.orgId);
    if (inst) resolvedTaskId = inst.task_id;
  }

  const result = await db.prepare(`
    INSERT INTO actions (organization_id, instance_id, task_id, process_id, title, description, assignee, priority, due_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.orgId, instance_id || null, resolvedTaskId, process_id || null, title, description || '', assignee || '', priority || 'Medium', due_date || null);

  const action = await db.prepare('SELECT * FROM actions WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(action);
});

// Update action
app.put('/api/actions/:id', requireOrgContext, async (req, res) => {
  const existing = await db.prepare('SELECT * FROM actions WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Action not found' });

  const fields = ['title', 'description', 'assignee', 'priority', 'status', 'due_date', 'resolved_by', 'process_id'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  // Auto-set resolved_at when status changes to resolved/closed
  if (req.body.status === 'resolved' || req.body.status === 'closed') {
    updates.push("resolved_at = datetime('now')");
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);

  await db.prepare(`UPDATE actions SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
  const action = await db.prepare('SELECT * FROM actions WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  res.json(action);
});

// Delete action
app.delete('/api/actions/:id', requireOrgContext, async (req, res) => {
  const result = await db.prepare('DELETE FROM actions WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  if (result.changes === 0) return res.status(404).json({ error: 'Action not found' });
  res.json({ success: true });
});

// --- Plan Bundles API ---

app.get('/api/plan-bundles', requireOrgContext, async (req, res) => {
  res.json(await db.prepare('SELECT * FROM plan_bundles WHERE organization_id = ? ORDER BY sort_order, name').all(req.orgId));
});

app.post('/api/plan-bundles', requireOrgContext, async (req, res) => {
  const { name, process_ids, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const result = await db.prepare(
    'INSERT INTO plan_bundles (organization_id, name, process_ids, color) VALUES (?, ?, ?, ?)'
  ).run(req.orgId, name, JSON.stringify(process_ids || []), color || '#6366f1');
  res.status(201).json(await db.prepare('SELECT * FROM plan_bundles WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/plan-bundles/:id', requireOrgContext, async (req, res) => {
  const existing = await db.prepare('SELECT * FROM plan_bundles WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Bundle not found' });
  const { name, process_ids, color, sort_order } = req.body;
  await db.prepare(
    `UPDATE plan_bundles SET name = ?, process_ids = ?, color = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?`
  ).run(
    name ?? existing.name,
    process_ids !== undefined ? JSON.stringify(process_ids) : existing.process_ids,
    color ?? existing.color,
    sort_order ?? existing.sort_order,
    req.params.id, req.orgId
  );
  res.json(await db.prepare('SELECT * FROM plan_bundles WHERE id = ?').get(req.params.id));
});

app.delete('/api/plan-bundles/:id', requireOrgContext, async (req, res) => {
  const result = await db.prepare('DELETE FROM plan_bundles WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  if (result.changes === 0) return res.status(404).json({ error: 'Bundle not found' });
  res.json({ success: true });
});

// --- Audit API ---

// List audits (returns parent audits with ALL events attached including first instance)
app.get('/api/audits', requireOrgContext, async (req, res) => {
  const { status, include_children } = req.query;
  let sql = 'SELECT * FROM audits WHERE organization_id = ? AND parent_audit_id IS NULL';
  const params = [req.orgId];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY planned_date DESC, created_at DESC';
  const parentAudits = await db.prepare(sql).all(...params);

  // Fetch all child audits for the returned parents in one query
  const parentIds = parentAudits.map(a => a.id);
  let allChildAudits = [];
  if (parentIds.length > 0) {
    const childRows = await db.getConnection().query(
      'SELECT * FROM audits WHERE parent_audit_id = ANY($1) ORDER BY instance_number, planned_date',
      [parentIds]
    );
    allChildAudits = childRows.rows;
  }

  // Collect every audit ID (parents + children) and fetch stats in 2 aggregate queries
  const allAuditIds = [...parentIds, ...allChildAudits.map(c => c.id)];
  let checklistStats = {};
  let ncStats = {};
  if (allAuditIds.length > 0) {
    const clRows = await db.getConnection().query(
      `SELECT audit_id,
              COUNT(*) AS checklist_count,
              COUNT(*) FILTER (WHERE rating != 'not_assessed') AS assessed_count,
              COUNT(*) FILTER (WHERE rating IN ('minor_nc','major_nc')) AS nc_count
       FROM audit_checklist WHERE audit_id = ANY($1) GROUP BY audit_id`,
      [allAuditIds]
    );
    for (const r of clRows.rows) checklistStats[r.audit_id] = r;

    const ncRows = await db.getConnection().query(
      `SELECT audit_id,
              COUNT(*) AS ncr_count,
              COUNT(*) FILTER (WHERE status IN ('open','in_progress')) AS open_nc_count
       FROM non_conformities WHERE audit_id = ANY($1) GROUP BY audit_id`,
      [allAuditIds]
    );
    for (const r of ncRows.rows) ncStats[r.audit_id] = r;
  }

  function getStats(auditId) {
    const cl = checklistStats[auditId] || {};
    const nc = ncStats[auditId] || {};
    return {
      checklist_count: parseInt(cl.checklist_count) || 0,
      assessed_count: parseInt(cl.assessed_count) || 0,
      nc_count: parseInt(cl.nc_count) || 0,
      ncr_count: parseInt(nc.ncr_count) || 0,
      open_nc_count: parseInt(nc.open_nc_count) || 0,
    };
  }

  // Group children by parent_id
  const childrenByParent = {};
  for (const c of allChildAudits) {
    if (!childrenByParent[c.parent_audit_id]) childrenByParent[c.parent_audit_id] = [];
    childrenByParent[c.parent_audit_id].push(c);
  }

  // Assemble response
  for (const a of parentAudits) {
    const parentStats = getStats(a.id);
    Object.assign(a, parentStats);

    const childAudits = childrenByParent[a.id] || [];
    for (const c of childAudits) Object.assign(c, getStats(c.id));
    a.child_events = childAudits;

    const parentAsEvent = {
      id: a.id,
      title: a.title,
      standard: a.standard,
      standards: a.standards,
      planned_date: a.planned_date,
      status: a.status,
      instance_number: a.instance_number || 1,
      lead_auditor: a.lead_auditor,
      auditee: a.auditee,
      ...parentStats,
    };
    a.all_events = [parentAsEvent, ...childAudits];
    a.total_instances = a.all_events.length;
  }
  res.json(parentAudits);
});

// Get single audit with checklist and NCs
app.get('/api/audits/:id', requireOrgContext, async (req, res) => {
  const audit = await db.prepare('SELECT * FROM audits WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  audit.checklist = await db.prepare('SELECT * FROM audit_checklist WHERE audit_id = ? ORDER BY sort_order, id').all(audit.id);
  audit.non_conformities = await db.prepare('SELECT * FROM non_conformities WHERE audit_id = ? ORDER BY created_at DESC').all(audit.id);
  res.json(audit);
});

// Helper function to calculate next recurrence date
function getNextRecurrenceDate(dateStr, recurrenceType) {
  const date = new Date(dateStr);
  switch (recurrenceType) {
    case 'monthly': date.setMonth(date.getMonth() + 1); break;
    case 'quarterly': date.setMonth(date.getMonth() + 3); break;
    case 'semi-annual': date.setMonth(date.getMonth() + 6); break;
    case 'annual': date.setFullYear(date.getFullYear() + 1); break;
    default: return null;
  }
  return date.toISOString().split('T')[0];
}

// Create audit
app.post('/api/audits', requireOrgContext, async (req, res) => {
  const { title, standard, standards, scope, lead_auditor, audit_team, auditee, planned_date, requirement_ids, recurrence, recurrence_end_date } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  // Support both single standard (legacy) and multiple standards
  const standardsArray = standards && Array.isArray(standards) ? standards : (standard ? [standard] : ['ISO 9001']);
  const primaryStandard = standardsArray[0] || 'ISO 9001';

  try {
    const audit = await db.transaction(async (txDB) => {
      // Create the parent audit (instance 1)
      const result = await txDB.run(
        `INSERT INTO audits (organization_id, title, standard, standards, scope, lead_auditor, audit_team, auditee, planned_date, recurrence, recurrence_end_date, parent_audit_id, instance_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        req.orgId, title, primaryStandard, JSON.stringify(standardsArray), scope || '', lead_auditor || '', audit_team || '', auditee || '', planned_date || null, recurrence || 'none', recurrence_end_date || null, null, 1
      );
      const parentAuditId = result.lastInsertRowid;

      // Auto-create checklist items from selected requirements, including the standard
      if (requirement_ids && Array.isArray(requirement_ids) && requirement_ids.length > 0) {
        let order = 1;
        for (const reqId of requirement_ids) {
          const reqRow = await txDB.get('SELECT * FROM standard_requirements WHERE id = ?', reqId);
          if (reqRow) {
            await txDB.run('INSERT INTO audit_checklist (organization_id, audit_id, clause, requirement, standard, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
              req.orgId, parentAuditId, reqRow.clause, reqRow.title, reqRow.standard, order++);
          }
        }
      }

      // Create recurring audit events as child audits if recurrence is set
      if (recurrence && recurrence !== 'none' && planned_date && recurrence_end_date) {
        let nextDate = getNextRecurrenceDate(planned_date, recurrence);
        const endDate = new Date(recurrence_end_date);
        let instanceNum = 2;

        while (nextDate && new Date(nextDate) <= endDate) {
          const recurResult = await txDB.run(
            `INSERT INTO audits (organization_id, title, standard, standards, scope, lead_auditor, audit_team, auditee, planned_date, recurrence, recurrence_end_date, parent_audit_id, instance_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            req.orgId, title, primaryStandard, JSON.stringify(standardsArray), scope || '', lead_auditor || '', audit_team || '', auditee || '', nextDate, recurrence, recurrence_end_date, parentAuditId, instanceNum
          );

          // Copy checklist items to recurring audit
          if (requirement_ids && Array.isArray(requirement_ids) && requirement_ids.length > 0) {
            let order = 1;
            for (const reqId of requirement_ids) {
              const reqRow = await txDB.get('SELECT * FROM standard_requirements WHERE id = ?', reqId);
              if (reqRow) {
                await txDB.run('INSERT INTO audit_checklist (organization_id, audit_id, clause, requirement, standard, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
                  req.orgId, recurResult.lastInsertRowid, reqRow.clause, reqRow.title, reqRow.standard, order++);
              }
            }
          }

          nextDate = getNextRecurrenceDate(nextDate, recurrence);
          instanceNum++;
        }
      }

      return await txDB.get('SELECT * FROM audits WHERE id = ?', parentAuditId);
    });

    res.status(201).json(audit);
  } catch (err) {
    console.error('Error creating audit:', err);
    res.status(500).json({ error: 'Failed to create audit' });
  }
});

// Update audit
app.put('/api/audits/:id', requireOrgContext, async (req, res) => {
  const existing = await db.prepare('SELECT * FROM audits WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Audit not found' });
  const fields = ['title', 'standard', 'scope', 'lead_auditor', 'audit_team', 'auditee', 'status', 'planned_date', 'completed_date', 'summary', 'recurrence', 'recurrence_end_date'];

  // Handle standards array
  if (req.body.standards && Array.isArray(req.body.standards)) {
    req.body.standards = JSON.stringify(req.body.standards);
    req.body.standard = req.body.standards[0] || existing.standard;
    fields.push('standards');
  }
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  await db.prepare(`UPDATE audits SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);

  if (req.body.status === 'completed' && existing.status !== 'completed') {
    const completedAudit = await db.prepare('SELECT * FROM audits WHERE id = ?').get(req.params.id);
    fireWebhooks(req.orgId, 'audit_complete', {
      id: completedAudit.id, title: completedAudit.title, standard: completedAudit.standard,
      lead_auditor: completedAudit.lead_auditor, completed_date: completedAudit.completed_date,
    });
  }

  // Add checklist items from newly selected requirements (skip existing clauses)
  if (req.body.requirement_ids && Array.isArray(req.body.requirement_ids)) {
    const existingClauses = (await db.prepare('SELECT clause FROM audit_checklist WHERE audit_id = ?').all(req.params.id)).map(c => c.clause);
    const insertCl = db.prepare('INSERT INTO audit_checklist (organization_id, audit_id, clause, requirement, sort_order) VALUES (?, ?, ?, ?, ?)');
    const getReq = db.prepare('SELECT * FROM standard_requirements WHERE id = ?');
    const maxOrder = (await db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM audit_checklist WHERE audit_id = ?').get(req.params.id)).m;
    let order = maxOrder + 1;
    for (const reqId of req.body.requirement_ids) {
      const r = await getReq.get(reqId);
      if (r && !existingClauses.includes(r.clause)) {
        await insertCl.run(req.orgId, req.params.id, r.clause, r.title, order++);
      }
    }
  }

  res.json(await db.prepare('SELECT * FROM audits WHERE id = ?').get(req.params.id));
});

// Delete audit
app.delete('/api/audits/:id', requireOrgContext, async (req, res) => {
  const result = await db.prepare('DELETE FROM audits WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  if (result.changes === 0) return res.status(404).json({ error: 'Audit not found' });
  res.json({ success: true });
});

// Upload client-generated audit report PDF and save to Document Control
app.post('/api/audits/:id/upload-report', requireOrgContext, uploadPdf.single('pdf'), async (req, res) => {
  const audit = await db.prepare('SELECT * FROM audits WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  if (!req.file) return res.status(400).json({ error: 'No PDF file provided' });

  let filePath = '';
  const fileSize = req.file.size;
  try {
    filePath = await uploadToSupabase('reports', {
      originalname: `audit-report-${audit.id}.pdf`,
      buffer: req.file.buffer,
      mimetype: 'application/pdf',
    });
  } catch (uploadErr) {
    console.warn('[Audit Report] Supabase upload failed, storing reference only:', uploadErr.message);
  }

  // Find or create document control record for this audit's report
  let existingDoc = await db.prepare(
    "SELECT * FROM documents WHERE linked_ref_type = 'audit' AND linked_ref_id = ? AND organization_id = ?"
  ).get(audit.id, req.orgId);

  let docId;
  if (!existingDoc) {
    const result = await db.prepare(`
      INSERT INTO documents (organization_id, title, description, doc_type, version, owner, status,
        file_name, file_path, file_size, mime_type, linked_module, linked_ref_type, linked_ref_id,
        review_date, classification)
      VALUES (?, ?, ?, 'report', '1.0', ?, 'approved', ?, ?, ?, 'application/pdf', 'audit', 'audit', ?, NULL, '')
    `).run(
      req.orgId,
      `Audit Report – ${audit.title}`,
      `Auto-generated report for audit: ${audit.title}`,
      audit.lead_auditor || '',
      `audit-report-${audit.id}.pdf`,
      filePath,
      fileSize,
      audit.id
    );
    docId = result.lastInsertRowid;
  } else {
    await db.prepare(
      "UPDATE documents SET file_path = ?, file_size = ?, file_name = ?, mime_type = 'application/pdf', updated_at = datetime('now') WHERE id = ?"
    ).run(filePath, fileSize, `audit-report-${audit.id}.pdf`, existingDoc.id);
    docId = existingDoc.id;
  }

  // Auto-cross-link: 'audit' < 'document' alphabetically → audit is source
  await db.prepare(
    'INSERT OR IGNORE INTO cross_links (organization_id, source_type, source_id, target_type, target_id) VALUES (?, ?, ?, ?, ?)'
  ).run(req.orgId, 'audit', audit.id, 'document', docId);

  await logAuditAction(req.session.userId, req.session.userName || 'User', 'data_exported', 'audit', audit.id, audit.title, 'Report generated', req.orgId);
  res.json({ success: true, doc_id: docId });
});

// --- Audit Checklist API ---

// Add checklist item
app.post('/api/audits/:id/checklist', requireOrgContext, async (req, res) => {
  const { clause, requirement, sort_order } = req.body;
  if (!clause) return res.status(400).json({ error: 'Clause is required' });
  const maxOrder = (await db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM audit_checklist WHERE audit_id = ? AND organization_id = ?').get(req.params.id, req.orgId)).m;
  const result = await db.prepare('INSERT INTO audit_checklist (organization_id, audit_id, clause, requirement, sort_order) VALUES (?, ?, ?, ?, ?)').run(
    req.orgId, req.params.id, clause, requirement || '', sort_order ?? maxOrder + 1
  );
  res.status(201).json(await db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(result.lastInsertRowid));
});

// Update checklist item (during execution)
app.put('/api/checklist/:id', requireOrgContext, async (req, res) => {
  const existing = await getChecklistItemWithOrgCheck(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Checklist item not found' });
  const fields = ['clause', 'requirement', 'evidence', 'finding', 'rating', 'notes', 'sort_order', 'evidence_files'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);
  await db.prepare(`UPDATE audit_checklist SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  // Auto-create or remove NCR when rating changes
  if (req.body.rating) {
    const isNc = req.body.rating === 'minor_nc' || req.body.rating === 'major_nc';
    const existingNcr = await db.prepare('SELECT * FROM non_conformities WHERE checklist_item_id = ? AND organization_id = ?').get(req.params.id, req.orgId);

    if (isNc && !existingNcr) {
      // Auto-create NCR with populated fields from checklist item
      const cl = await db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(req.params.id);
      const severity = req.body.rating === 'major_nc' ? 'major' : 'minor';
      const description = cl.finding || `Non-conformity found for clause ${cl.clause}`;
      await db.prepare(`INSERT INTO non_conformities (organization_id, audit_id, checklist_item_id, clause, description, severity) VALUES (?, ?, ?, ?, ?, ?)`).run(
        req.orgId, existing.audit_id, req.params.id, cl.clause, description, severity
      );
    } else if (isNc && existingNcr) {
      // Update severity if it changed (e.g. minor_nc -> major_nc)
      const severity = req.body.rating === 'major_nc' ? 'major' : 'minor';
      if (existingNcr.severity !== severity) {
        await db.prepare("UPDATE non_conformities SET severity = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?").run(severity, existingNcr.id, req.orgId);
      }
    } else if (!isNc && existingNcr && existingNcr.status === 'open') {
      // Remove auto-created NCR if rating changed away from NC and NCR is still open
      await db.prepare('DELETE FROM non_conformities WHERE id = ? AND organization_id = ?').run(existingNcr.id, req.orgId);
    }
  }

  // Auto-update audit status when rating changes
  let auditStatusChanged = null;
  if (req.body.rating !== undefined) {
    const audit = await db.prepare('SELECT * FROM audits WHERE id = ? AND organization_id = ?').get(existing.audit_id, req.orgId);
    if (audit && audit.status !== 'completed' && audit.status !== 'cancelled') {
      const allItems = await db.prepare('SELECT rating FROM audit_checklist WHERE audit_id = ?').all(existing.audit_id);
      const allAssessed = allItems.length > 0 && allItems.every(i => i.rating !== 'not_assessed');
      const anyAssessed = allItems.some(i => i.rating !== 'not_assessed');
      if (allAssessed) {
        await db.prepare("UPDATE audits SET status = 'completed', completed_date = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?")
          .run(new Date().toISOString().split('T')[0], existing.audit_id, req.orgId);
        auditStatusChanged = 'completed';
      } else if (anyAssessed && audit.status === 'planned') {
        await db.prepare("UPDATE audits SET status = 'in_progress', updated_at = datetime('now') WHERE id = ? AND organization_id = ?")
          .run(existing.audit_id, req.orgId);
        auditStatusChanged = 'in_progress';
      }
    }
  }

  const updatedItem = await db.prepare('SELECT * FROM audit_checklist WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  res.json({ ...updatedItem, _auditStatus: auditStatusChanged });
});

// Delete checklist item
app.delete('/api/checklist/:id', requireOrgContext, async (req, res) => {
  const existing = await getChecklistItemWithOrgCheck(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Item not found' });
  await db.prepare('DELETE FROM audit_checklist WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Upload evidence file to checklist item
app.post('/api/checklist/:id/evidence', requireOrgContext, upload.single('file'), async (req, res) => {
  try {
    // Look up item by id, then verify org ownership through the parent audit
    const item = await db.prepare('SELECT cl.*, a.organization_id as audit_org_id FROM audit_checklist cl JOIN audits a ON a.id = cl.audit_id WHERE cl.id = ?').get(req.params.id);
    if (!item || item.audit_org_id !== req.orgId) return res.status(404).json({ error: 'Checklist item not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let storagePath;
    try {
      storagePath = await uploadToSupabase('evidence', req.file);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

    // Parse existing evidence_files array
    let evidenceFiles = [];
    try { evidenceFiles = JSON.parse(item.evidence_files || '[]'); } catch(e) {}

    // Add new file to array
    evidenceFiles.push({
      id: Date.now(),
      type: 'file',
      name: req.file.originalname,
      path: storagePath,
      size: req.file.size,
      mime: req.file.mimetype,
      uploaded_at: new Date().toISOString()
    });

    // Update the checklist item (use id only — org ownership already verified via audit)
    await db.prepare('UPDATE audit_checklist SET evidence_files = ? WHERE id = ?').run(JSON.stringify(evidenceFiles), req.params.id);

    // Backfill organization_id if it was NULL
    if (item.organization_id == null) {
      await db.prepare('UPDATE audit_checklist SET organization_id = ? WHERE id = ? AND organization_id IS NULL').run(req.orgId, req.params.id);
    }

    // Also create a Document Control entry for this evidence and auto-cross-link to the audit
    try {
      const audit = await db.prepare('SELECT title FROM audits WHERE id = ?').get(item.audit_id);
      const docTitle = `Evidence: ${req.file.originalname}`;
      const docDesc = `Evidence uploaded for audit "${audit ? audit.title : 'Unknown'}" — checklist item: ${item.clause || item.title || '#' + req.params.id}`;
      const docResult = await db.prepare(`INSERT INTO documents (organization_id, title, description, doc_type, version, owner, status, file_name, file_path, file_size, mime_type, linked_module, linked_ref_type, linked_ref_id, classification) VALUES (?, ?, ?, 'evidence', '1.0', '', 'approved', ?, ?, ?, ?, 'audits', 'audit', ?, 'confidential')`).run(
        req.orgId, docTitle, docDesc, req.file.originalname, storagePath, req.file.size, req.file.mimetype, item.audit_id
      );
      // Auto-create cross-link between the new document and the source audit
      if (docResult.lastInsertRowid && item.audit_id) {
        const [s_type, s_id, t_type, t_id] = 'audit' < 'document'
          ? ['audit', item.audit_id, 'document', docResult.lastInsertRowid]
          : ['document', docResult.lastInsertRowid, 'audit', item.audit_id];
        await db.prepare('INSERT OR IGNORE INTO cross_links (organization_id, source_type, source_id, target_type, target_id) VALUES (?, ?, ?, ?, ?)').run(req.orgId, s_type, s_id, t_type, t_id);
      }
    } catch (docErr) {
      console.error('Failed to create Document Control entry for checklist evidence:', docErr.message);
    }

    res.json(await db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(req.params.id));
  } catch (err) {
    console.error('Evidence upload error:', err);
    res.status(500).json({ error: 'Evidence upload failed' });
  }
});

// Helper: look up checklist item by id and verify org ownership through parent audit
async function getChecklistItemWithOrgCheck(itemId, orgId) {
  const item = await db.prepare('SELECT cl.*, a.organization_id as audit_org_id FROM audit_checklist cl JOIN audits a ON a.id = cl.audit_id WHERE cl.id = ?').get(itemId);
  if (!item || item.audit_org_id !== orgId) return null;
  return item;
}

// Download evidence file from checklist item
app.get('/api/checklist/:id/evidence/:fileId/download', requireOrgContext, async (req, res) => {
  const item = await getChecklistItemWithOrgCheck(req.params.id, req.orgId);
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });

  let evidenceFiles = [];
  try { evidenceFiles = JSON.parse(item.evidence_files || '[]'); } catch(e) {}

  const file = evidenceFiles.find(f => f.id == req.params.fileId);
  if (!file || file.type !== 'file') return res.status(404).json({ error: 'File not found' });

  try {
    const signedUrl = await getSignedUrl(file.path, 300, file.name || true);
    res.redirect(signedUrl);
  } catch (err) {
    res.status(404).json({ error: 'File not found in storage' });
  }
});

// Delete evidence file from checklist item
app.delete('/api/checklist/:id/evidence/:fileId', requireOrgContext, async (req, res) => {
  const item = await getChecklistItemWithOrgCheck(req.params.id, req.orgId);
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });

  let evidenceFiles = [];
  try { evidenceFiles = JSON.parse(item.evidence_files || '[]'); } catch(e) {}

  const fileIndex = evidenceFiles.findIndex(f => f.id == req.params.fileId);
  if (fileIndex === -1) return res.status(404).json({ error: 'Evidence item not found' });

  const file = evidenceFiles[fileIndex];
  // Delete actual file from Supabase Storage if it's a file type
  if (file.type === 'file' && file.path) {
    await deleteFromSupabase(file.path);
  }

  // Remove from array
  evidenceFiles.splice(fileIndex, 1);
  await db.prepare('UPDATE audit_checklist SET evidence_files = ? WHERE id = ?').run(JSON.stringify(evidenceFiles), req.params.id);
  res.json({ success: true });
});

// Add link evidence to checklist item
app.post('/api/checklist/:id/evidence-link', requireOrgContext, async (req, res) => {
  const item = await getChecklistItemWithOrgCheck(req.params.id, req.orgId);
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });
  const { link_type, link_id, link_name } = req.body;
  if (!link_type || !link_id) return res.status(400).json({ error: 'Link type and id required' });

  // Parse existing evidence_files array
  let evidenceFiles = [];
  try { evidenceFiles = JSON.parse(item.evidence_files || '[]'); } catch(e) {}

  // Add new link to array
  evidenceFiles.push({
    id: Date.now(),
    type: 'link',
    link_type,
    link_id,
    link_name: link_name || `${link_type} #${link_id}`,
    added_at: new Date().toISOString()
  });

  // Update the checklist item
  await db.prepare('UPDATE audit_checklist SET evidence_files = ? WHERE id = ?').run(JSON.stringify(evidenceFiles), req.params.id);
  res.json(await db.prepare('SELECT * FROM audit_checklist WHERE id = ?').get(req.params.id));
});

// --- Non-Conformity API ---

// List NCs (optionally filter by audit)
app.get('/api/ncrs', requireOrgContext, async (req, res) => {
  const { audit_id, status } = req.query;
  let sql = `SELECT n.*, a.title as audit_title, a.standard as audit_standard,
    COALESCE(cl.standard, a.standard) as ncr_standard
    FROM non_conformities n
    JOIN audits a ON n.audit_id = a.id
    LEFT JOIN audit_checklist cl ON n.checklist_item_id = cl.id
    WHERE n.organization_id = ?`;
  const params = [req.orgId];
  if (audit_id) { sql += ' AND n.audit_id = ?'; params.push(audit_id); }
  if (status) { sql += ' AND n.status = ?'; params.push(status); }
  if (req.query.overdue === 'true') {
    sql += " AND n.due_date IS NOT NULL AND n.due_date < CURRENT_DATE AND n.status IN ('open','in_progress')";
  }
  sql += ' ORDER BY n.created_at DESC';
  res.json(await db.prepare(sql).all(...params));
});

// Create NC
app.post('/api/ncrs', requireOrgContext, async (req, res) => {
  const { audit_id, checklist_item_id, clause, description, severity, root_cause, correction, corrective_action, responsible, due_date } = req.body;
  if (!audit_id || !description) return res.status(400).json({ error: 'audit_id and description are required' });
  const result = await db.prepare(`INSERT INTO non_conformities (organization_id, audit_id, checklist_item_id, clause, description, severity, root_cause, correction, corrective_action, responsible, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.orgId, audit_id, checklist_item_id || null, clause || '', description, severity || 'minor', root_cause || '', correction || '', corrective_action || '', responsible || '', due_date || null
  );
  // If linked to checklist item, update its rating
  if (checklist_item_id) {
    const rating = (severity === 'major') ? 'major_nc' : 'minor_nc';
    await db.prepare('UPDATE audit_checklist SET rating = ? WHERE id = ? AND organization_id = ?').run(rating, checklist_item_id, req.orgId);
  }
  const newNcr = await db.prepare('SELECT * FROM non_conformities WHERE id = ?').get(result.lastInsertRowid);
  fireWebhooks(req.orgId, 'ncr_created', {
    id: newNcr.id, clause: newNcr.clause, description: newNcr.description,
    severity: newNcr.severity, audit_id: newNcr.audit_id,
  });
  res.status(201).json(newNcr);
});

// Update NC
app.put('/api/ncrs/:id', requireOrgContext, async (req, res) => {
  const existing = await db.prepare('SELECT * FROM non_conformities WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'NCR not found' });
  const fields = ['clause', 'description', 'severity', 'root_cause', 'correction', 'corrective_action', 'responsible', 'due_date', 'status', 'verification_notes'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (req.body.status === 'closed' || req.body.status === 'verified') {
    updates.push("closed_date = date('now')");
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  await db.prepare(`UPDATE non_conformities SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
  const updatedNc = await db.prepare('SELECT * FROM non_conformities WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);

  // Improvement 7: emit process event when NC status changes
  if (req.body.status && req.body.status !== existing.status) {
    const activityMap = { in_progress: 'nc_in_progress', closed: 'nc_closed', verified: 'nc_verified' };
    const activity = activityMap[req.body.status] || `nc_status_${req.body.status}`;
    const openedAt = existing.created_at ? new Date(existing.created_at).getTime() : null;
    emitEvent(req.orgId, `nc-${req.params.id}`, 'nc_resolution', activity,
      req.body.responsible || existing.responsible || '',
      { severity: updatedNc.severity, clause: updatedNc.clause, audit_id: updatedNc.audit_id,
        duration_ms: openedAt ? Date.now() - openedAt : null });
  }

  res.json(updatedNc);
});

// Overdue NCs — open/in-progress NCs past their due date (improvement 4)
app.get('/api/ncrs/overdue', requireOrgContext, async (req, res) => {
  const rows = await db.prepare(`
    SELECT n.*,
           a.title AS audit_title,
           a.standard AS audit_standard,
           COALESCE(cl.standard, a.standard) AS ncr_standard,
           EXTRACT(DAY FROM (CURRENT_DATE - n.due_date::date))::INTEGER AS days_overdue
    FROM non_conformities n
    JOIN audits a ON n.audit_id = a.id
    LEFT JOIN audit_checklist cl ON n.checklist_item_id = cl.id
    WHERE n.organization_id = ?
      AND n.status IN ('open','in_progress')
      AND n.due_date IS NOT NULL
      AND n.due_date::date < CURRENT_DATE
    ORDER BY n.due_date ASC
  `).all(req.orgId);
  res.json(rows);
});

// Delete NC
app.delete('/api/ncrs/:id', requireOrgContext, async (req, res) => {
  const result = await db.prepare('DELETE FROM non_conformities WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  if (result.changes === 0) return res.status(404).json({ error: 'NCR not found' });
  res.json({ success: true });
});

// --- Standard Requirements API ---

// List requirements (optionally filter by standard), enriched with audit history
app.get('/api/requirements', requireOrgContext, async (req, res) => {
  const { standard } = req.query;
  let sql = 'SELECT * FROM standard_requirements WHERE organization_id = ?';
  const params = [req.orgId];
  if (standard) { sql += ' AND standard = ?'; params.push(standard); }
  sql += ' ORDER BY standard, sort_order, clause';
  const reqs = await db.prepare(sql).all(...params);

  if (reqs.length === 0) return res.json([]);

  // Previously: 2 queries per requirement (2N total for audit history + NCs).
  // Now: 2 bulk queries for the entire result set, matched in JS by clause+standard.
  const clauses   = [...new Set(reqs.map(r => r.clause))];
  const standards = [...new Set(reqs.map(r => r.standard))];
  const cPh = clauses.map(() => '?').join(',');
  const sPh = standards.map(() => '?').join(',');

  // Bulk audit history: one row per checklist item across all matching clauses/standards
  const auditHistory = await db.prepare(`
    SELECT a.id as audit_id, a.title as audit_title, a.planned_date, a.completed_date,
           a.status as audit_status, a.standard as audit_standard,
           cl.rating, cl.clause, cl.standard as cl_standard
    FROM audit_checklist cl
    JOIN audits a ON cl.audit_id = a.id
    WHERE cl.clause IN (${cPh})
      AND (cl.standard IN (${sPh}) OR (cl.standard = '' AND a.standard IN (${sPh})))
      AND a.organization_id = ?
    ORDER BY COALESCE(a.completed_date, a.planned_date) DESC
  `).all(...clauses, ...standards, ...standards, req.orgId);

  // Bulk NCs: one row per NC across all matching clauses/standards
  const allNcs = await db.prepare(`
    SELECT n.id, n.status, n.severity, n.clause,
           COALESCE(cl.standard, a.standard) as nc_standard
    FROM non_conformities n
    JOIN audits a ON n.audit_id = a.id
    LEFT JOIN audit_checklist cl ON n.checklist_item_id = cl.id
    WHERE n.clause IN (${cPh})
      AND (COALESCE(cl.standard, a.standard) IN (${sPh}) OR a.standard IN (${sPh}))
      AND a.organization_id = ?
  `).all(...clauses, ...standards, ...standards, req.orgId);

  // Build lookup maps keyed by "clause|||standard"
  const auditMap = {};
  for (const h of auditHistory) {
    const effectiveStd = h.cl_standard || h.audit_standard;
    const key = `${h.clause}|||${effectiveStd}`;
    if (!auditMap[key]) auditMap[key] = [];
    auditMap[key].push(h);
  }
  const ncMap = {};
  for (const n of allNcs) {
    const key = `${n.clause}|||${n.nc_standard}`;
    if (!ncMap[key]) ncMap[key] = [];
    ncMap[key].push(n);
  }

  // Assemble per-requirement data in JS (no more per-row DB queries)
  for (const r of reqs) {
    const key = `${r.clause}|||${r.standard}`;
    const history = auditMap[key] || [];
    const completedAudits = history.filter(h => h.audit_status === 'completed');
    r.last_audited    = completedAudits[0]?.completed_date || completedAudits[0]?.planned_date || null;
    r.last_audit_title = completedAudits[0]?.audit_title || null;
    r.last_rating     = completedAudits[0]?.rating || null;
    r.times_audited   = completedAudits.length;

    const ncs = ncMap[key] || [];
    r.nc_total  = ncs.length;
    r.nc_open   = ncs.filter(n => n.status === 'open' || n.status === 'in_progress').length;
    r.nc_closed = ncs.filter(n => n.status === 'closed' || n.status === 'verified').length;
  }

  res.json(reqs);
});

// Get unique standards list
app.get('/api/requirements/standards', requireOrgContext, async (req, res) => {
  const standards = (await db.prepare('SELECT DISTINCT standard FROM standard_requirements WHERE organization_id = ? ORDER BY standard').all(req.orgId)).map(r => r.standard);
  res.json(standards);
});

// Create requirement
app.post('/api/requirements', requireOrgContext, async (req, res) => {
  const { standard, clause, title, description, category, sort_order, owner } = req.body;
  if (!clause) return res.status(400).json({ error: 'Clause is required' });
  const result = await db.prepare(`INSERT INTO standard_requirements (standard, clause, title, description, category, sort_order, owner, organization_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    standard || 'ISO 9001', clause, title || '', description || '', category || '', sort_order ?? 0, owner || '', req.orgId
  );
  res.status(201).json(await db.prepare('SELECT * FROM standard_requirements WHERE id = ?').get(result.lastInsertRowid));
});

// Bulk import requirements
app.post('/api/requirements/bulk', requireOrgContext, async (req, res) => {
  const { standard, items } = req.body;
  if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'items array is required' });
  const std = standard || 'ISO 9001';
  const existing = (await db.all('SELECT clause FROM standard_requirements WHERE standard = ? AND organization_id = ?', std, req.orgId)).map(r => r.clause);
  let inserted = 0;
  await db.transaction(async (txDB) => {
    for (const item of items) {
      if (existing.includes(item.clause)) continue;
      await txDB.run('INSERT INTO standard_requirements (standard, clause, title, description, category, sort_order, organization_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        std, item.clause, item.title || '', item.description || '', item.category || '', item.sort_order ?? 0, req.orgId);
      inserted++;
    }
  });
  res.status(201).json({ inserted });
});

// Update requirement
app.put('/api/requirements/:id', requireOrgContext, async (req, res) => {
  const existing = await db.prepare('SELECT * FROM standard_requirements WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Requirement not found' });
  const fields = ['standard', 'clause', 'title', 'description', 'category', 'sort_order', 'owner'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  await db.prepare(`UPDATE standard_requirements SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
  res.json(await db.prepare('SELECT * FROM standard_requirements WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
});

// Delete all requirements for a standard (retire)
app.delete('/api/requirements/standard/:standard', requireOrgContext, async (req, res) => {
  const standard = decodeURIComponent(req.params.standard);
  // Clean up SoA entries for requirements of this standard (cascade should handle, but explicit for safety)
  await db.prepare(`DELETE FROM soa_entries WHERE requirement_id IN (SELECT id FROM standard_requirements WHERE standard = ? AND organization_id = ?)`).run(standard, req.orgId);
  const result = await db.prepare('DELETE FROM standard_requirements WHERE standard = ? AND organization_id = ?').run(standard, req.orgId);
  res.json({ success: true, deleted: result.changes });
});

// Delete requirement
app.delete('/api/requirements/:id', requireOrgContext, async (req, res) => {
  const result = await db.prepare('DELETE FROM standard_requirements WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  if (result.changes === 0) return res.status(404).json({ error: 'Requirement not found' });
  res.json({ success: true });
});

// --- Threat Intelligence API ---

// List feeds
app.get('/api/threat-feeds', requireOrgContext, async (req, res) => {
  const feeds = await db.prepare('SELECT * FROM threat_feeds WHERE organization_id = ? ORDER BY tier, name').all(req.orgId);
  for (const f of feeds) {
    f.item_count = (await db.prepare('SELECT COUNT(*) as c FROM threat_items WHERE feed_id = ?').get(f.id)).c;
    f.new_count = (await db.prepare("SELECT COUNT(*) as c FROM threat_items WHERE feed_id = ? AND status = 'new'").get(f.id)).c;
  }
  res.json(feeds);
});

// Add feed
app.post('/api/threat-feeds', requireOrgContext, async (req, res) => {
  const { name, url, tier } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  const result = await db.prepare('INSERT INTO threat_feeds (organization_id, name, url, tier) VALUES (?, ?, ?, ?)').run(req.orgId, name, url, tier || 1);
  res.status(201).json(await db.prepare('SELECT * FROM threat_feeds WHERE id = ?').get(result.lastInsertRowid));
});

// Update feed
app.put('/api/threat-feeds/:id', requireOrgContext, async (req, res) => {
  const existing = await db.prepare('SELECT * FROM threat_feeds WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Feed not found' });
  const fields = ['name', 'url', 'tier', 'enabled'];
  const updates = []; const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);
  await db.prepare(`UPDATE threat_feeds SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
  res.json(await db.prepare('SELECT * FROM threat_feeds WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
});

// Delete feed
app.delete('/api/threat-feeds/:id', requireOrgContext, async (req, res) => {
  await db.prepare('DELETE FROM threat_feeds WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  res.json({ success: true });
});

// Fetch/refresh a single feed (server-side RSS proxy)
app.post('/api/threat-feeds/:id/fetch', requireOrgContext, async (req, res) => {
  const feed = await db.prepare('SELECT * FROM threat_feeds WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!feed) return res.status(404).json({ error: 'Feed not found' });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(feed.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'LetTheFrameWork/1.0 ThreatIntelFetcher' }
    });
    clearTimeout(timeout);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();

    // Simple XML parser for RSS/Atom - extract items
    const items = [];
    // Try RSS <item> format
    const rssItems = text.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
    for (const raw of rssItems) {
      const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
      const desc = (raw.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] || '';
      const link = (raw.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '';
      const guid = (raw.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i) || [])[1] || link || title;
      const pubDate = (raw.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] || '';
      if (title || desc) items.push({ title: stripTags(title).trim(), description: stripTags(desc).trim().substring(0, 2000), link: stripTags(link).trim(), guid: stripTags(guid).trim(), pub_date: pubDate.trim() });
    }
    // Try Atom <entry> format if no RSS items found
    if (items.length === 0) {
      const atomEntries = text.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
      for (const raw of atomEntries) {
        const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
        const desc = (raw.match(/<(?:summary|content)[^>]*>([\s\S]*?)<\/(?:summary|content)>/i) || [])[1] || '';
        const linkMatch = raw.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
        const link = linkMatch ? linkMatch[1] : '';
        const idTag = (raw.match(/<id[^>]*>([\s\S]*?)<\/id>/i) || [])[1] || link || title;
        const updated = (raw.match(/<(?:updated|published)[^>]*>([\s\S]*?)<\/(?:updated|published)>/i) || [])[1] || '';
        if (title || desc) items.push({ title: stripTags(title).trim(), description: stripTags(desc).trim().substring(0, 2000), link: stripTags(link).trim(), guid: stripTags(idTag).trim(), pub_date: updated.trim() });
      }
    }

    // Upsert items (improvement 9: proper transaction with txDB)
    await db.transaction(async (txDB) => {
      for (const i of items) {
        await txDB.run(`INSERT INTO threat_items (organization_id, feed_id, guid, title, description, link, pub_date) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(feed_id, guid) DO UPDATE SET title=excluded.title, description=excluded.description, link=excluded.link, pub_date=excluded.pub_date`,
          req.orgId, feed.id, i.guid || i.title, i.title, i.description, i.link, i.pub_date);
      }
    });

    // Improvement 6: update feed health on success
    await db.prepare(
      "UPDATE threat_feeds SET last_fetched = datetime('now'), last_success = datetime('now'), consecutive_failures = 0, last_error = NULL WHERE id = ? AND organization_id = ?"
    ).run(feed.id, req.orgId);

    res.json({ success: true, count: items.length });
  } catch (err) {
    // Improvement 6: track failure count and last error
    await db.prepare(
      "UPDATE threat_feeds SET last_fetched = datetime('now'), consecutive_failures = consecutive_failures + 1, last_error = ? WHERE id = ? AND organization_id = ?"
    ).run(err.message.substring(0, 500), feed.id, req.orgId).catch(() => {});
    res.json({ success: false, error: err.message, count: 0 });
  }
});

// Get threat items (with filters)
app.get('/api/threat-items', requireOrgContext, async (req, res) => {
  const { feed_id, tier, status, limit: lim } = req.query;
  let sql = `SELECT ti.*, tf.name as feed_name, tf.tier FROM threat_items ti JOIN threat_feeds tf ON ti.feed_id = tf.id WHERE ti.organization_id = ? AND tf.enabled = 1`;
  const params = [req.orgId];
  if (feed_id) { sql += ' AND ti.feed_id = ?'; params.push(feed_id); }
  if (tier) { sql += ' AND tf.tier = ?'; params.push(tier); }
  if (status) { sql += ' AND ti.status = ?'; params.push(status); }
  sql += ' ORDER BY ti.fetched_at DESC, ti.pub_date DESC';
  if (lim) { sql += ' LIMIT ?'; params.push(parseInt(lim)); }
  else { sql += ' LIMIT 200'; }
  res.json(await db.prepare(sql).all(...params));
});

// Update threat item status
app.put('/api/threat-items/:id', requireOrgContext, async (req, res) => {
  const existing = await db.prepare('SELECT * FROM threat_items WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Threat item not found' });
  const { status, created_risk_id } = req.body;
  const updates = []; const params = [];
  if (status) { updates.push('status = ?'); params.push(status); }
  if (created_risk_id !== undefined) { updates.push('created_risk_id = ?'); params.push(created_risk_id); }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  await db.prepare(`UPDATE threat_items SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
  res.json(await db.prepare('SELECT * FROM threat_items WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
});

function stripTags(str) {
  if (!str) return '';
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// --- Risk Management API ---

// List risks
app.get('/api/risks', requireOrgContext, async (req, res) => {
  const { status, category } = req.query;
  let sql = 'SELECT * FROM risks WHERE organization_id = ?';
  const params = [req.orgId];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  sql += ' ORDER BY inherent_score DESC, created_at DESC';
  const risks = await db.prepare(sql).all(...params);
  // Attach treatment counts via single aggregate query (avoids N+1)
  if (risks.length > 0) {
    const riskIds = risks.map(r => r.id);
    const treatmentCounts = await db.getConnection().query(
      `SELECT risk_id,
              COUNT(*) AS treatment_count,
              COUNT(*) FILTER (WHERE status IN ('planned','in_progress')) AS open_treatments
       FROM risk_treatments
       WHERE risk_id = ANY($1)
       GROUP BY risk_id`,
      [riskIds]
    );
    const countMap = {};
    for (const row of treatmentCounts.rows) {
      countMap[row.risk_id] = row;
    }
    for (const r of risks) {
      const c = countMap[r.id] || {};
      r.treatment_count = parseInt(c.treatment_count) || 0;
      r.open_treatments = parseInt(c.open_treatments) || 0;
    }
  }
  res.json(risks);
});

// Get single risk with treatments
app.get('/api/risks/:id', requireOrgContext, async (req, res) => {
  const risk = await db.prepare('SELECT * FROM risks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!risk) return res.status(404).json({ error: 'Risk not found' });
  risk.treatments = await db.prepare(`SELECT rt.*, sr.clause, sr.title as requirement_title FROM risk_treatments rt LEFT JOIN standard_requirements sr ON rt.requirement_id = sr.id WHERE rt.risk_id = ? ORDER BY rt.created_at`).all(risk.id);
  res.json(risk);
});

// Create risk
app.post('/api/risks', requireOrgContext, async (req, res) => {
  const { title, description, category, source, asset, threat, vulnerability, likelihood, impact, risk_owner, status } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const l = parseInt(likelihood) || 3;
  const i = parseInt(impact) || 3;
  const inherent_score = l * i;
  const result = await db.prepare(`INSERT INTO risks (title, description, category, source, asset, threat, vulnerability, likelihood, impact, inherent_score, risk_owner, status, organization_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    title, description || '', category || 'Information Security', source || '', asset || '', threat || '', vulnerability || '', l, i, inherent_score, risk_owner || '', status || 'identified', req.orgId
  );
  const newRisk = await db.prepare('SELECT * FROM risks WHERE id = ?').get(result.lastInsertRowid);
  if (inherent_score >= 15) {
    fireWebhooks(req.orgId, 'risk_high', {
      id: newRisk.id, title: newRisk.title, category: newRisk.category,
      inherent_score, likelihood: l, impact: i, risk_owner: newRisk.risk_owner,
    });
  }
  res.status(201).json(newRisk);
});

// Update risk
app.put('/api/risks/:id', requireOrgContext, async (req, res) => {
  const existing = await db.prepare('SELECT * FROM risks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Risk not found' });
  const fields = ['title', 'description', 'category', 'source', 'asset', 'threat', 'vulnerability', 'likelihood', 'impact', 'risk_owner', 'status'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  // Auto-recalculate inherent_score whenever likelihood or impact changes
  if (req.body.likelihood !== undefined || req.body.impact !== undefined) {
    const newL = parseInt(req.body.likelihood !== undefined ? req.body.likelihood : existing.likelihood) || 1;
    const newI = parseInt(req.body.impact !== undefined ? req.body.impact : existing.impact) || 1;
    updates.push('inherent_score = ?');
    params.push(newL * newI);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  await db.prepare(`UPDATE risks SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
  const updatedRisk = await db.prepare('SELECT * FROM risks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  // Fire when score just crossed into high territory (was below 15, now ≥ 15)
  if (updatedRisk.inherent_score >= 15 && existing.inherent_score < 15) {
    fireWebhooks(req.orgId, 'risk_high', {
      id: updatedRisk.id, title: updatedRisk.title, category: updatedRisk.category,
      inherent_score: updatedRisk.inherent_score, likelihood: updatedRisk.likelihood,
      impact: updatedRisk.impact, risk_owner: updatedRisk.risk_owner,
    });
  }
  res.json(updatedRisk);
});

// Delete risk
app.delete('/api/risks/:id', requireOrgContext, async (req, res) => {
  const result = await db.prepare('DELETE FROM risks WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  if (result.changes === 0) return res.status(404).json({ error: 'Risk not found' });
  res.json({ success: true });
});

// --- Risk Treatments API ---

app.get('/api/treatments', requireOrgContext, async (req, res) => {
  const { risk_id, status } = req.query;
  let sql = `SELECT rt.*, r.title as risk_title, sr.clause, sr.title as requirement_title FROM risk_treatments rt JOIN risks r ON rt.risk_id = r.id LEFT JOIN standard_requirements sr ON rt.requirement_id = sr.id WHERE r.organization_id = ?`;
  const params = [req.orgId];
  if (risk_id) { sql += ' AND rt.risk_id = ?'; params.push(risk_id); }
  if (status) { sql += ' AND rt.status = ?'; params.push(status); }
  sql += ' ORDER BY rt.created_at DESC';
  res.json(await db.prepare(sql).all(...params));
});

app.post('/api/treatments', requireOrgContext, async (req, res) => {
  const { risk_id, treatment_type, description, control_reference, requirement_id, responsible, due_date, residual_likelihood, residual_impact, notes } = req.body;
  if (!risk_id) return res.status(400).json({ error: 'risk_id is required' });
  // Verify the risk belongs to this org
  const risk = await db.prepare('SELECT id FROM risks WHERE id = ? AND organization_id = ?').get(risk_id, req.orgId);
  if (!risk) return res.status(404).json({ error: 'Risk not found' });
  const rl = residual_likelihood ? parseInt(residual_likelihood) : null;
  const ri = residual_impact ? parseInt(residual_impact) : null;
  const residual_score = (rl && ri) ? rl * ri : null;
  const result = await db.prepare(`INSERT INTO risk_treatments (organization_id, risk_id, treatment_type, description, control_reference, requirement_id, responsible, due_date, residual_likelihood, residual_impact, residual_score, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.orgId, risk_id, treatment_type || 'mitigate', description || '', control_reference || '', requirement_id || null, responsible || '', due_date || null, rl, ri, residual_score, notes || ''
  );
  res.status(201).json(await db.prepare('SELECT * FROM risk_treatments WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/treatments/:id', requireOrgContext, async (req, res) => {
  const existing = await db.prepare('SELECT rt.* FROM risk_treatments rt JOIN risks r ON rt.risk_id = r.id WHERE rt.id = ? AND r.organization_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Treatment not found' });
  const fields = ['treatment_type', 'description', 'control_reference', 'requirement_id', 'responsible', 'due_date', 'status', 'residual_likelihood', 'residual_impact', 'notes'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  // Improvement 5: recalculate residual_score when likelihood/impact change
  if (req.body.residual_likelihood !== undefined || req.body.residual_impact !== undefined) {
    const newRL = req.body.residual_likelihood !== undefined ? parseInt(req.body.residual_likelihood) : existing.residual_likelihood;
    const newRI = req.body.residual_impact !== undefined ? parseInt(req.body.residual_impact) : existing.residual_impact;
    updates.push('residual_score = ?');
    params.push((newRL && newRI) ? newRL * newRI : null);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  await db.prepare(`UPDATE risk_treatments SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(await db.prepare('SELECT * FROM risk_treatments WHERE id = ?').get(req.params.id));
});

app.delete('/api/treatments/:id', requireOrgContext, async (req, res) => {
  // Verify the treatment belongs to a risk in this org before deleting
  const existing = await db.prepare('SELECT rt.id FROM risk_treatments rt JOIN risks r ON rt.risk_id = r.id WHERE rt.id = ? AND r.organization_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Treatment not found' });
  await db.prepare('DELETE FROM risk_treatments WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// --- Statement of Applicability API ---

app.get('/api/soa', requireOrgContext, async (req, res) => {
  // SoA is Annex A controls only — HLS clauses (4-10) are requirements, not SoA items.
  // Optionally filter to a specific Annex A standard via ?standard= param.
  const { standard } = req.query;
  let soaSql = `
    SELECT sr.*, soa.id as soa_id, soa.applicable, soa.justification,
           soa.implementation_status, soa.notes as soa_notes, soa.linked_processes, soa.regulatory
    FROM standard_requirements sr
    LEFT JOIN soa_entries soa ON sr.id = soa.requirement_id
    WHERE sr.organization_id = ? AND sr.standard LIKE '%Annex A%'`;
  const soaParams = [req.orgId];
  if (standard && standard.includes('Annex A')) {
    soaSql += ' AND sr.standard = ?';
    soaParams.push(standard);
  }
  soaSql += ' ORDER BY sr.standard, sr.sort_order, sr.clause';
  const reqs = await db.prepare(soaSql).all(...soaParams);

  if (reqs.length === 0) return res.json([]);

  const allProcesses = await db.prepare(
    "SELECT id, name FROM org_architecture WHERE arch_type = 'process' AND organization_id = ?"
  ).all(req.orgId);

  // Previously: 2 queries per requirement (2N total). Now: 2 bulk queries regardless of N.
  const reqIds = reqs.map(r => r.id);
  const clauses = [...new Set(reqs.map(r => r.clause).filter(Boolean))];
  const idPh = reqIds.map(() => '?').join(',');
  const clausePh = clauses.map(() => '?').join(',');

  // Bulk fetch treatments linked by requirement_id
  const treatsByReqId = await db.prepare(`
    SELECT rt.id, rt.description, rt.status, ri.title as risk_title, rt.requirement_id
    FROM risk_treatments rt JOIN risks ri ON rt.risk_id = ri.id
    WHERE rt.requirement_id IN (${idPh}) AND ri.organization_id = ?
  `).all(...reqIds, req.orgId);

  // Bulk fetch treatments linked by control_reference (clause match)
  const treatsByRef = clauses.length ? await db.prepare(`
    SELECT rt.id, rt.description, rt.status, ri.title as risk_title, rt.control_reference
    FROM risk_treatments rt JOIN risks ri ON rt.risk_id = ri.id
    WHERE rt.control_reference IN (${clausePh}) AND rt.control_reference != '' AND ri.organization_id = ?
  `).all(...clauses, req.orgId) : [];

  // Build lookup maps
  const byIdMap = {};
  for (const t of treatsByReqId) {
    if (!byIdMap[t.requirement_id]) byIdMap[t.requirement_id] = [];
    byIdMap[t.requirement_id].push(t);
  }
  const byRefMap = {};
  for (const t of treatsByRef) {
    if (!byRefMap[t.control_reference]) byRefMap[t.control_reference] = [];
    byRefMap[t.control_reference].push(t);
  }

  // Assemble per-requirement data entirely in JS (no more per-row queries)
  for (const r of reqs) {
    const byId = byIdMap[r.id] || [];
    const byRef = byRefMap[r.clause] || [];
    const allLinked = [...byId];
    for (const t of byRef) {
      if (!allLinked.some(l => l.id === t.id)) allLinked.push(t);
    }
    r.linked_treatments = allLinked;
    try { r.linked_process_ids = JSON.parse(r.linked_processes || '[]'); } catch(e) { r.linked_process_ids = []; }
    r.linked_process_names = r.linked_process_ids
      .map(pid => { const p = allProcesses.find(x => x.id === pid); return p ? p.name : null; })
      .filter(Boolean);
  }
  res.json(reqs);
});

app.put('/api/soa/:requirementId', requireOrgContext, async (req, res) => {
  const reqId = req.params.requirementId;
  // Verify the requirement belongs to this org
  const reqRow = await db.prepare('SELECT id FROM standard_requirements WHERE id = ? AND organization_id = ?').get(reqId, req.orgId);
  if (!reqRow) return res.status(404).json({ error: 'Requirement not found' });
  const { applicable, justification, implementation_status, notes } = req.body;
  const existing = await db.prepare('SELECT * FROM soa_entries WHERE requirement_id = ?').get(reqId);
  if (existing) {
    const fields = [];
    const params = [];
    if (applicable !== undefined) { fields.push('applicable = ?'); params.push(applicable ? 1 : 0); }
    if (justification !== undefined) { fields.push('justification = ?'); params.push(justification); }
    if (implementation_status !== undefined) { fields.push('implementation_status = ?'); params.push(implementation_status); }
    if (notes !== undefined) { fields.push('notes = ?'); params.push(notes); }
    if (req.body.linked_processes !== undefined) { fields.push('linked_processes = ?'); params.push(JSON.stringify(req.body.linked_processes)); }
    if (req.body.regulatory !== undefined) { fields.push('regulatory = ?'); params.push(req.body.regulatory ? 1 : 0); }
    fields.push("updated_at = datetime('now')");
    params.push(existing.id);
    await db.prepare(`UPDATE soa_entries SET ${fields.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
  } else {
    await db.prepare('INSERT INTO soa_entries (organization_id, requirement_id, applicable, justification, implementation_status, notes, linked_processes, regulatory) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.orgId,
      reqId, applicable !== undefined ? (applicable ? 1 : 0) : 1, justification || '', implementation_status || 'not_implemented', notes || '', JSON.stringify(req.body.linked_processes || []), req.body.regulatory ? 1 : 0
    );
  }
  res.json({ success: true });
});

// Upload SoA PDF and save to Document Control
app.post('/api/soa/upload-report', requireOrgContext, uploadPdf.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file provided' });

  const org = await db.prepare('SELECT name FROM organizations WHERE id = ?').get(req.orgId);
  const orgName = org?.name || 'Organisation';
  const today = new Date().toISOString().split('T')[0];

  let filePath = '';
  const fileSize = req.file.size;
  try {
    filePath = await uploadToSupabase('reports', {
      originalname: `soa-${req.orgId}-${today}.pdf`,
      buffer: req.file.buffer,
      mimetype: 'application/pdf',
    });
  } catch (uploadErr) {
    console.warn('[SoA Report] Supabase upload failed, storing reference only:', uploadErr.message);
  }

  // Find or create the Document Control record for this org's SoA
  const existingDoc = await db.prepare(
    "SELECT * FROM documents WHERE linked_ref_type = 'soa' AND organization_id = ? LIMIT 1"
  ).get(req.orgId);

  let docId;
  if (!existingDoc) {
    const result = await db.prepare(`
      INSERT INTO documents (organization_id, title, description, doc_type, version, owner, status,
        file_name, file_path, file_size, mime_type, linked_module, linked_ref_type, linked_ref_id,
        review_date, classification)
      VALUES (?, ?, ?, 'report', '1.0', '', 'approved', ?, ?, ?, 'application/pdf',
              'risk', 'soa', NULL, NULL, 'Confidential')
    `).run(
      req.orgId,
      `Statement of Applicability – ${orgName}`,
      `ISO/IEC 27001:2022 Annex A Statement of Applicability for ${orgName}`,
      `soa-${req.orgId}-${today}.pdf`,
      filePath,
      fileSize
    );
    docId = result.lastInsertRowid;
  } else {
    await db.prepare(
      "UPDATE documents SET file_path = ?, file_size = ?, file_name = ?, version = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(filePath, fileSize, `soa-${req.orgId}-${today}.pdf`, '1.0', existingDoc.id);
    docId = existingDoc.id;
  }

  res.json({ success: true, doc_id: docId });
});

// --- Organizational Planning API ---

// Mission
app.get('/api/mission', requireOrgContext, async (req, res) => {
  const mission = await db.prepare('SELECT * FROM org_mission WHERE organization_id = ?').get(req.orgId);
  const org = await db.prepare('SELECT name FROM organizations WHERE id = ?').get(req.orgId);
  res.json({ ...mission, org_name: org?.name || '' });
});

app.put('/api/mission', requireOrgContext, async (req, res) => {
  const { content, vision, values_text, legal_entities } = req.body;
  await db.prepare("UPDATE org_mission SET content = ?, vision = ?, values_text = ?, legal_entities = ?, updated_at = datetime('now') WHERE organization_id = ?")
    .run(content || '', vision || '', values_text || '', JSON.stringify(legal_entities || []), req.orgId);
  const mission = await db.prepare('SELECT * FROM org_mission WHERE organization_id = ?').get(req.orgId);
  const org = await db.prepare('SELECT name FROM organizations WHERE id = ?').get(req.orgId);
  res.json({ ...mission, org_name: org?.name || '' });
});

// KPIs
app.get('/api/kpis', requireOrgContext, async (req, res) => {
  const kpis = await db.prepare(
    `SELECT k.*, a.name AS process_name
     FROM org_kpis k
     LEFT JOIN org_architecture a ON k.process_id = a.id
     WHERE k.organization_id = ? ORDER BY a.name NULLS LAST, k.name`
  ).all(req.orgId);
  for (const k of kpis) {
    k.values = await db.prepare('SELECT * FROM org_kpi_values WHERE kpi_id = ? ORDER BY period DESC LIMIT 24').all(k.id);
  }
  res.json(kpis);
});

// KPIs for a specific process
app.get('/api/architecture/:id/kpis', requireOrgContext, async (req, res) => {
  const kpis = await db.prepare(
    'SELECT * FROM org_kpis WHERE organization_id = ? AND process_id = ? ORDER BY name'
  ).all(req.orgId, req.params.id);
  for (const k of kpis) {
    k.values = await db.prepare('SELECT * FROM org_kpi_values WHERE kpi_id = ? ORDER BY period DESC LIMIT 24').all(k.id);
  }
  res.json(kpis);
});

// Auto-KPI data
app.get('/api/kpis/auto', requireOrgContext, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const oid = req.orgId;
  const auto = {
    // Task Management
    tasks_active: (await db.prepare('SELECT COUNT(*) as v FROM tasks WHERE organization_id = ? AND is_active = 1').get(oid)).v,
    tasks_overdue: (await db.prepare('SELECT COUNT(*) as v FROM tasks WHERE organization_id = ? AND is_active = 1 AND next_due < ?').get(oid, today)).v,
    completions_this_month: (await db.prepare("SELECT COUNT(*) as v FROM task_instances WHERE organization_id = ? AND status = 'completed' AND completed_at >= date('now','start of month')").get(oid)).v,
    // Audits & Compliance
    audits_planned: (await db.prepare("SELECT COUNT(*) as v FROM audits WHERE organization_id = ? AND status = 'planned'").get(oid)).v,
    audits_completed: (await db.prepare("SELECT COUNT(*) as v FROM audits WHERE organization_id = ? AND status = 'completed'").get(oid)).v,
    open_ncrs: (await db.prepare("SELECT COUNT(*) as v FROM non_conformities WHERE organization_id = ? AND status IN ('open','in_progress')").get(oid)).v,
    overdue_ncrs: (await db.prepare("SELECT COUNT(*) as v FROM non_conformities WHERE organization_id = ? AND status IN ('open','in_progress') AND due_date IS NOT NULL AND due_date::date < CURRENT_DATE").get(oid)).v,
    open_actions: (await db.prepare("SELECT COUNT(*) as v FROM actions WHERE organization_id = ? AND status IN ('open','in_progress')").get(oid)).v,
    standards_count: (await db.prepare('SELECT COUNT(DISTINCT standard) as v FROM standard_requirements WHERE organization_id = ?').get(oid)).v,
    // Risk Management
    total_risks: (await db.prepare('SELECT COUNT(*) as v FROM risks WHERE organization_id = ?').get(oid)).v,
    high_risks: (await db.prepare('SELECT COUNT(*) as v FROM risks WHERE organization_id = ? AND inherent_score >= 15').get(oid)).v,
    open_treatments: (await db.prepare("SELECT COUNT(*) as v FROM risk_treatments WHERE organization_id = ? AND status IN ('planned','in_progress')").get(oid)).v,
    // SoA counts from Annex A requirements (applicable by default unless explicitly set to 0)
    soa_applicable: (await db.prepare(`SELECT COUNT(*) as v FROM standard_requirements sr
      LEFT JOIN soa_entries soa ON sr.id = soa.requirement_id
      WHERE sr.organization_id = ? AND sr.standard = 'ISO 27001 Annex A' AND (soa.applicable IS NULL OR soa.applicable = 1)`).get(oid)).v,
    soa_implemented: (await db.prepare(`SELECT COUNT(*) as v FROM standard_requirements sr
      LEFT JOIN soa_entries soa ON sr.id = soa.requirement_id
      WHERE sr.organization_id = ? AND sr.standard = 'ISO 27001 Annex A' AND (soa.applicable IS NULL OR soa.applicable = 1) AND soa.implementation_status = 'implemented'`).get(oid)).v,
    threat_items_new: (await db.prepare("SELECT COUNT(*) as v FROM threat_items WHERE organization_id = ? AND status = 'new'").get(oid)).v,
    // Document Control
    total_documents: (await db.prepare('SELECT COUNT(*) as v FROM documents WHERE organization_id = ?').get(oid)).v,
    docs_due_review: (await db.prepare('SELECT COUNT(*) as v FROM documents WHERE organization_id = ? AND review_date IS NOT NULL AND review_date <= ?').get(oid, today)).v,
    // Architecture
    arch_processes: (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE organization_id = ? AND arch_type = 'process'").get(oid)).v,
    arch_roles: (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE organization_id = ? AND arch_type = 'role'").get(oid)).v,
    arch_systems: (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE organization_id = ? AND arch_type = 'system'").get(oid)).v,
    arch_facilities: (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE organization_id = ? AND arch_type = 'facility'").get(oid)).v,
    // AI Use Cases
    usecases_total: (await db.prepare('SELECT COUNT(*) as v FROM use_cases WHERE organization_id = ?').get(oid)).v,
    usecases_active: (await db.prepare("SELECT COUNT(*) as v FROM use_cases WHERE organization_id = ? AND status = 'production'").get(oid)).v,
    usecases_draft: (await db.prepare("SELECT COUNT(*) as v FROM use_cases WHERE organization_id = ? AND status = 'new'").get(oid)).v,
    usecases_proposed: (await db.prepare("SELECT COUNT(*) as v FROM use_cases WHERE organization_id = ? AND status IN ('assessment','approved')").get(oid)).v,
    usecases_deprecated: (await db.prepare("SELECT COUNT(*) as v FROM use_cases WHERE organization_id = ? AND status = 'retired'").get(oid)).v,
  };
  res.json(auto);
});

// Improvement 8: persist auto-calculated KPI values to org_kpi_values for the current period
app.post('/api/kpis/auto/persist', requireOrgContext, async (req, res) => {
  const oid = req.orgId;
  const today = new Date();
  const monthPeriod = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const quarter = Math.ceil((today.getMonth() + 1) / 3);
  const quarterPeriod = `${today.getFullYear()}-Q${quarter}`;

  const autoKpis = await db.prepare(
    "SELECT * FROM org_kpis WHERE organization_id = ? AND is_auto = 1 AND auto_source != ''"
  ).all(oid);
  if (autoKpis.length === 0) return res.json({ persisted: 0, period: monthPeriod });

  const today_str = today.toISOString().split('T')[0];
  const auto = {
    tasks_active:           (await db.prepare('SELECT COUNT(*) as v FROM tasks WHERE organization_id = ? AND is_active = 1').get(oid)).v,
    tasks_overdue:          (await db.prepare('SELECT COUNT(*) as v FROM tasks WHERE organization_id = ? AND is_active = 1 AND next_due < ?').get(oid, today_str)).v,
    completions_this_month: (await db.prepare("SELECT COUNT(*) as v FROM task_instances WHERE organization_id = ? AND status = 'completed' AND completed_at >= date('now','start of month')").get(oid)).v,
    audits_planned:         (await db.prepare("SELECT COUNT(*) as v FROM audits WHERE organization_id = ? AND status = 'planned'").get(oid)).v,
    audits_completed:       (await db.prepare("SELECT COUNT(*) as v FROM audits WHERE organization_id = ? AND status = 'completed'").get(oid)).v,
    open_ncrs:              (await db.prepare("SELECT COUNT(*) as v FROM non_conformities WHERE organization_id = ? AND status IN ('open','in_progress')").get(oid)).v,
    open_actions:           (await db.prepare("SELECT COUNT(*) as v FROM actions WHERE organization_id = ? AND status IN ('open','in_progress')").get(oid)).v,
    total_risks:            (await db.prepare('SELECT COUNT(*) as v FROM risks WHERE organization_id = ?').get(oid)).v,
    high_risks:             (await db.prepare('SELECT COUNT(*) as v FROM risks WHERE organization_id = ? AND inherent_score >= 15').get(oid)).v,
    open_treatments:        (await db.prepare("SELECT COUNT(*) as v FROM risk_treatments WHERE organization_id = ? AND status IN ('planned','in_progress')").get(oid)).v,
    soa_applicable:         (await db.prepare(`SELECT COUNT(*) as v FROM standard_requirements sr LEFT JOIN soa_entries soa ON sr.id = soa.requirement_id WHERE sr.organization_id = ? AND sr.standard = 'ISO 27001 Annex A' AND (soa.applicable IS NULL OR soa.applicable = 1)`).get(oid)).v,
    soa_implemented:        (await db.prepare(`SELECT COUNT(*) as v FROM standard_requirements sr LEFT JOIN soa_entries soa ON sr.id = soa.requirement_id WHERE sr.organization_id = ? AND sr.standard = 'ISO 27001 Annex A' AND (soa.applicable IS NULL OR soa.applicable = 1) AND soa.implementation_status = 'implemented'`).get(oid)).v,
    threat_items_new:       (await db.prepare("SELECT COUNT(*) as v FROM threat_items WHERE organization_id = ? AND status = 'new'").get(oid)).v,
    total_documents:        (await db.prepare('SELECT COUNT(*) as v FROM documents WHERE organization_id = ?').get(oid)).v,
    docs_due_review:        (await db.prepare('SELECT COUNT(*) as v FROM documents WHERE organization_id = ? AND review_date IS NOT NULL AND review_date <= ?').get(oid, today_str)).v,
    arch_processes:         (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE organization_id = ? AND arch_type = 'process'").get(oid)).v,
    arch_roles:             (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE organization_id = ? AND arch_type = 'role'").get(oid)).v,
    arch_systems:           (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE organization_id = ? AND arch_type = 'system'").get(oid)).v,
    arch_facilities:        (await db.prepare("SELECT COUNT(*) as v FROM org_architecture WHERE organization_id = ? AND arch_type = 'facility'").get(oid)).v,
    usecases_total:         (await db.prepare('SELECT COUNT(*) as v FROM use_cases WHERE organization_id = ?').get(oid)).v,
    usecases_active:        (await db.prepare("SELECT COUNT(*) as v FROM use_cases WHERE organization_id = ? AND status = 'production'").get(oid)).v,
  };
  auto.soa_coverage_pct = auto.soa_applicable > 0 ? Math.round((auto.soa_implemented / auto.soa_applicable) * 100) : 0;
  auto.task_completion_rate = auto.tasks_active > 0 ? Math.round((auto.completions_this_month / auto.tasks_active) * 100) : 0;

  let persisted = 0;
  for (const kpi of autoKpis) {
    const rawValue = auto[kpi.auto_source];
    if (rawValue === undefined) continue;
    const period = (kpi.frequency === 'quarterly') ? quarterPeriod : monthPeriod;
    const existing = await db.prepare(
      'SELECT id FROM org_kpi_values WHERE kpi_id = ? AND period = ? AND organization_id = ?'
    ).get(kpi.id, period, oid);
    if (existing) {
      await db.prepare("UPDATE org_kpi_values SET value = ?, recorded_at = NOW() WHERE id = ? AND organization_id = ?").run(rawValue, existing.id, oid);
    } else {
      await db.prepare('INSERT INTO org_kpi_values (organization_id, kpi_id, value, period) VALUES (?, ?, ?, ?)').run(oid, kpi.id, rawValue, period);
    }
    persisted++;
  }
  res.json({ persisted, period: monthPeriod });
});

app.post('/api/kpis', requireOrgContext, async (req, res) => {
  const { name, description, module, process_id, target_value, unit, frequency } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const result = await db.prepare(
    'INSERT INTO org_kpis (organization_id, name, description, module, process_id, target_value, unit, frequency) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.orgId, name, description || '', module || 'custom', process_id || null, target_value || null, unit || '', frequency || 'monthly');
  res.status(201).json(await db.prepare('SELECT * FROM org_kpis WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/kpis/:id', requireOrgContext, async (req, res) => {
  const fields = ['name', 'description', 'module', 'process_id', 'target_value', 'unit', 'frequency'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);
  await db.prepare(`UPDATE org_kpis SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
  res.json(await db.prepare('SELECT * FROM org_kpis WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
});

app.delete('/api/kpis/:id', requireOrgContext, async (req, res) => {
  await db.prepare('DELETE FROM org_kpis WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  res.json({ success: true });
});

app.post('/api/kpis/:id/values', requireOrgContext, async (req, res) => {
  const { value, period } = req.body;
  if (value === undefined || !period) return res.status(400).json({ error: 'value and period are required' });
  // Upsert by period
  const existing = await db.prepare('SELECT * FROM org_kpi_values WHERE kpi_id = ? AND period = ? AND organization_id = ?').get(req.params.id, period, req.orgId);
  if (existing) {
    await db.prepare("UPDATE org_kpi_values SET value = ?, recorded_at = datetime('now') WHERE id = ? AND organization_id = ?").run(value, existing.id, req.orgId);
  } else {
    await db.prepare('INSERT INTO org_kpi_values (organization_id, kpi_id, value, period) VALUES (?, ?, ?, ?)').run(req.orgId, req.params.id, value, period);
  }
  res.json({ success: true });
});

app.delete('/api/kpis/:id/values/:valueId', requireOrgContext, async (req, res) => {
  await db.prepare(
    'DELETE FROM org_kpi_values WHERE id = ? AND kpi_id = ? AND organization_id = ?'
  ).run(req.params.valueId, req.params.id, req.orgId);
  res.json({ success: true });
});

// AI Use Cases – Kanban board management
const UC_FIELDS = [
  'title','description','category','business_domain','ai_approach','risk_tier','human_oversight',
  'priority','status','business_value','success_kpis','fallback_process','retirement_reason',
  'target_go_live','go_live_date','next_review_date','performance_notes','incident_reporting',
  'owner_id','implementation_owner_id','approved_by_id','approval_date','sort_order'
];

async function fetchUseCaseWithUsers(db, id) {
  return await db.prepare(`
    SELECT uc.*,
      o.name  AS owner_name,  o.email  AS owner_email,
      io.name AS implementation_owner_name, io.email AS implementation_owner_email,
      ab.name AS approved_by_name
    FROM use_cases uc
    LEFT JOIN users o  ON uc.owner_id = o.id
    LEFT JOIN users io ON uc.implementation_owner_id = io.id
    LEFT JOIN users ab ON uc.approved_by_id = ab.id
    WHERE uc.id = ?
  `).get(id);
}

app.get('/api/use-cases', requireOrgContext, async (req, res) => {
  const { status, priority, category, domain } = req.query;
  let sql = `
    SELECT uc.*,
      o.name  AS owner_name,
      io.name AS implementation_owner_name,
      ab.name AS approved_by_name
    FROM use_cases uc
    LEFT JOIN users o  ON uc.owner_id = o.id
    LEFT JOIN users io ON uc.implementation_owner_id = io.id
    LEFT JOIN users ab ON uc.approved_by_id = ab.id
    WHERE uc.organization_id = ?`;
  const params = [req.orgId];
  if (status)   { sql += ' AND uc.status = ?';          params.push(status); }
  if (priority) { sql += ' AND uc.priority = ?';        params.push(priority); }
  if (category) { sql += ' AND uc.category = ?';        params.push(category); }
  if (domain)   { sql += ' AND uc.business_domain = ?'; params.push(domain); }
  sql += ' ORDER BY uc.sort_order, uc.created_at DESC';
  res.json(await db.prepare(sql).all(...params));
});

app.get('/api/use-cases/:id', requireOrgContext, async (req, res) => {
  const uc = await fetchUseCaseWithUsers(db, req.params.id);
  if (!uc || uc.organization_id !== req.orgId) return res.status(404).json({ error: 'Not found' });
  res.json(uc);
});

app.post('/api/use-cases', requireOrgContext, async (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const cols = ['organization_id', 'title'];
  const vals = [req.orgId, title];
  for (const f of UC_FIELDS) {
    if (f !== 'title' && req.body[f] !== undefined) { cols.push(f); vals.push(req.body[f]); }
  }
  const ph = vals.map(() => '?').join(', ');
  const result = await db.prepare(`INSERT INTO use_cases (${cols.join(', ')}) VALUES (${ph})`).run(...vals);
  const createdUc = await fetchUseCaseWithUsers(db, result.lastInsertRowid);
  fireWebhooks(req.orgId, 'usecase_created', {
    id: createdUc.id, title: createdUc.title, category: createdUc.category,
    business_domain: createdUc.business_domain, priority: createdUc.priority,
    owner: createdUc.owner_name || null,
  });
  res.status(201).json(createdUc);
});

app.put('/api/use-cases/:id', requireOrgContext, async (req, res) => {
  const existing = await db.prepare('SELECT id FROM use_cases WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const updates = [];
  const params = [];
  for (const f of UC_FIELDS) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f] === '' ? null : req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = NOW()");
  params.push(req.params.id, req.orgId);
  await db.prepare(`UPDATE use_cases SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params);
  res.json(await fetchUseCaseWithUsers(db, req.params.id));
});

// Stage transition with gate validation
app.put('/api/use-cases/:id/stage', requireOrgContext, async (req, res) => {
  const { status: targetStage } = req.body;
  const validStages = ['new','assessment','approved','development','production','retired'];
  if (!validStages.includes(targetStage)) return res.status(400).json({ error: 'Invalid stage' });
  const uc = await db.prepare('SELECT * FROM use_cases WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!uc) return res.status(404).json({ error: 'Not found' });
  // Gate checks
  if (targetStage === 'approved') {
    if (!uc.approved_by_id || !uc.approval_date) {
      return res.status(422).json({ error: 'Set Approved By and Approval Date before moving to Approved.' });
    }
  }
  if (targetStage === 'development') {
    if (!uc.implementation_owner_id) {
      return res.status(422).json({ error: 'Assign an Implementation Owner before starting Development.' });
    }
  }
  if (targetStage === 'production') {
    if (!uc.go_live_date) {
      return res.status(422).json({ error: 'Set a Go-Live Date before moving to Production.' });
    }
  }
  await db.prepare("UPDATE use_cases SET status = ?, updated_at = NOW() WHERE id = ? AND organization_id = ?").run(targetStage, req.params.id, req.orgId);
  const movedUc = await fetchUseCaseWithUsers(db, req.params.id);
  fireWebhooks(req.orgId, 'usecase_stage_changed', {
    id: movedUc.id, title: movedUc.title, category: movedUc.category,
    previous_stage: uc.status, new_stage: targetStage,
    business_domain: movedUc.business_domain, priority: movedUc.priority,
    owner: movedUc.owner_name || null,
  });
  res.json(movedUc);
});

app.delete('/api/use-cases/:id', requireOrgContext, async (req, res) => {
  await db.prepare('DELETE FROM use_cases WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  res.json({ success: true });
});

// Use case team members
app.get('/api/use-cases/:id/members', requireOrgContext, async (req, res) => {
  const members = await db.prepare(`
    SELECT ucm.id, ucm.user_id, u.name, u.email, u.department
    FROM use_case_members ucm JOIN users u ON ucm.user_id = u.id
    WHERE ucm.use_case_id = ?
    ORDER BY u.name
  `).all(req.params.id);
  res.json(members);
});

app.post('/api/use-cases/:id/members', requireOrgContext, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  try {
    await db.prepare('INSERT INTO use_case_members (use_case_id, user_id) VALUES (?, ?)').run(req.params.id, user_id);
  } catch (e) { /* already exists – ignore */ }
  res.json(await db.prepare(`
    SELECT ucm.id, ucm.user_id, u.name, u.email FROM use_case_members ucm JOIN users u ON ucm.user_id = u.id WHERE ucm.use_case_id = ? ORDER BY u.name
  `).all(req.params.id));
});

app.delete('/api/use-cases/:id/members/:userId', requireOrgContext, async (req, res) => {
  await db.prepare('DELETE FROM use_case_members WHERE use_case_id = ? AND user_id = ?').run(req.params.id, req.params.userId);
  res.json({ success: true });
});

// Use case approval history
app.get('/api/use-cases/:id/approvals', requireOrgContext, async (req, res) => {
  const approvals = await db.prepare(`
    SELECT ua.*, u.name AS approver_name
    FROM use_case_approvals ua LEFT JOIN users u ON ua.approved_by_id = u.id
    WHERE ua.use_case_id = ? ORDER BY ua.created_at DESC
  `).all(req.params.id);
  res.json(approvals);
});

app.post('/api/use-cases/:id/approvals', requireOrgContext, async (req, res) => {
  const { approved_by_id, decision, notes } = req.body;
  if (!decision) return res.status(400).json({ error: 'decision required' });
  const result = await db.prepare(
    'INSERT INTO use_case_approvals (use_case_id, organization_id, approved_by_id, decision, notes) VALUES (?, ?, ?, ?, ?)'
  ).run(req.params.id, req.orgId, approved_by_id || null, decision, notes || '');
  res.status(201).json(await db.prepare('SELECT ua.*, u.name AS approver_name FROM use_case_approvals ua LEFT JOIN users u ON ua.approved_by_id = u.id WHERE ua.id = ?').get(result.lastInsertRowid));
});

// Architecture
// ---------------------------------------------------------------------------
// Architecture – helpers for ai_usecase single-source-of-truth in use_cases
// ---------------------------------------------------------------------------
const UC_STATUS_TO_APPROVAL = { new: 'Not started', assessment: 'Pending', approved: 'Approved', development: 'Approved', production: 'Approved', retired: 'Rejected' };
const UC_APPROVAL_TO_STATUS = { 'Not started': 'new', 'Pending': 'assessment', 'Approved': 'approved', 'Rejected': 'retired' };

function mapUcToArch(uc) {
  return {
    id: uc.id,
    organization_id: uc.organization_id,
    arch_type: 'ai_usecase',
    name: uc.title,
    description: uc.description || '',
    owner: uc.owner_name || '',
    status: uc.status,
    metadata: JSON.stringify({
      domain:               uc.business_domain   || '',
      ai_approach:          uc.ai_approach        || '',
      risk_tier:            uc.risk_tier          || '',
      human_oversight:      uc.human_oversight    || '',
      governance_approval:  UC_STATUS_TO_APPROVAL[uc.status] || 'Not started',
      incident_reporting:   uc.incident_reporting ? 'Yes' : 'No',
      approval_date:        uc.approval_date      || '',
      next_review_date:     uc.next_review_date   || '',
      business_value:       uc.business_value     || '',
      success_kpis:         uc.success_kpis       || '',
      fallback_process:     uc.fallback_process   || '',
    }),
    sort_order: uc.sort_order || 0,
    created_at: uc.created_at,
    updated_at: uc.updated_at,
  };
}

function mapArchBodyToUcFields(body) {
  const meta = typeof body.metadata === 'string' ? JSON.parse(body.metadata || '{}') : (body.metadata || {});
  const fields = {
    title:            body.name,
    description:      body.description || '',
    business_domain:  meta.domain         || '',
    ai_approach:      meta.ai_approach    || '',
    risk_tier:        meta.risk_tier      || '',
    human_oversight:  meta.human_oversight || '',
    incident_reporting: meta.incident_reporting === 'Yes' ? 1 : 0,
    approval_date:    meta.approval_date    || null,
    next_review_date: meta.next_review_date || null,
    business_value:   meta.business_value   || '',
    success_kpis:     meta.success_kpis     || '',
    fallback_process: meta.fallback_process || '',
  };
  if (meta.governance_approval && UC_APPROVAL_TO_STATUS[meta.governance_approval]) {
    fields.status = UC_APPROVAL_TO_STATUS[meta.governance_approval];
  }
  return fields;
}

// ---------------------------------------------------------------------------

app.get('/api/architecture', requireOrgContext, async (req, res) => {
  const { arch_type } = req.query;

  // ai_usecase items are stored in use_cases (single source of truth)
  if (arch_type === 'ai_usecase') {
    const cases = await db.prepare(`
      SELECT uc.*, u.name AS owner_name
      FROM use_cases uc
      LEFT JOIN users u ON uc.owner_id = u.id
      WHERE uc.organization_id = ?
      ORDER BY uc.sort_order, uc.title
    `).all(req.orgId);
    return res.json(cases.map(mapUcToArch));
  }

  let sql = 'SELECT * FROM org_architecture WHERE organization_id = ?';
  const params = [req.orgId];
  if (arch_type) { sql += ' AND arch_type = ?'; params.push(arch_type); }
  sql += ' ORDER BY arch_type, sort_order, name';
  res.json(await db.prepare(sql).all(...params));
});

app.post('/api/architecture', requireOrgContext, async (req, res) => {
  const { arch_type, name, description, parent_id, owner, status, metadata } = req.body;
  if (!arch_type || !name) return res.status(400).json({ error: 'arch_type and name are required' });

  // ai_usecase items are created in use_cases table
  if (arch_type === 'ai_usecase') {
    const fields = mapArchBodyToUcFields(req.body);
    const cols = ['organization_id', ...Object.keys(fields)];
    const vals = [req.orgId, ...Object.values(fields)];
    const ph   = vals.map(() => '?').join(', ');
    const result = await db.prepare(`INSERT INTO use_cases (${cols.join(', ')}) VALUES (${ph})`).run(...vals);
    const uc = await fetchUseCaseWithUsers(db, result.lastInsertRowid);
    return res.status(201).json(mapUcToArch(uc));
  }

  const result = await db.prepare('INSERT INTO org_architecture (organization_id, arch_type, name, description, parent_id, owner, status, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    req.orgId, arch_type, name, description || '', parent_id || null, owner || '', status || 'active', metadata || '{}'
  );
  res.status(201).json(await db.prepare('SELECT * FROM org_architecture WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/architecture/:id', requireOrgContext, async (req, res) => {
  // ai_usecase items are updated in use_cases table
  if (req.body.arch_type === 'ai_usecase') {
    const uc = await db.prepare('SELECT id FROM use_cases WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!uc) return res.status(404).json({ error: 'Use case not found' });
    const fields = mapArchBodyToUcFields(req.body);
    const setClauses = Object.keys(fields).map(k => `${k} = ?`).concat('updated_at = NOW()');
    const vals = [...Object.values(fields), req.params.id, req.orgId];
    await db.prepare(`UPDATE use_cases SET ${setClauses.join(', ')} WHERE id = ? AND organization_id = ?`).run(...vals);
    const updated = await fetchUseCaseWithUsers(db, req.params.id);
    return res.json(mapUcToArch(updated));
  }

  // Improvement 2: snapshot current state before overwriting (architecture version history)
  const current = await db.prepare('SELECT * FROM org_architecture WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!current) return res.status(404).json({ error: 'Architecture element not found' });

  const fields = ['name', 'description', 'parent_id', 'owner', 'status', 'metadata', 'sort_order', 'flowchart'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);

  // Determine next version number and save snapshot
  const lastVer = await db.prepare('SELECT MAX(version_number) as v FROM org_architecture_versions WHERE arch_id = ?').get(req.params.id);
  const nextVersion = (lastVer?.v || 0) + 1;
  await db.prepare(`
    INSERT INTO org_architecture_versions
      (arch_id, organization_id, changed_by_user_id, change_reason,
       arch_type, name, description, parent_id, owner, status, metadata, sort_order, version_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    current.id, req.orgId, req.session.userId, req.body.change_reason || '',
    current.arch_type, current.name, current.description, current.parent_id,
    current.owner, current.status, current.metadata, current.sort_order, nextVersion
  );

  await db.prepare(`UPDATE org_architecture SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
  res.json(await db.prepare('SELECT * FROM org_architecture WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
});

// Improvement 2: version history for an architecture element
app.get('/api/architecture/:id/versions', requireOrgContext, async (req, res) => {
  const versions = await db.prepare(`
    SELECT v.*, u.name as changed_by_name
    FROM org_architecture_versions v
    LEFT JOIN users u ON u.id = v.changed_by_user_id
    WHERE v.arch_id = ? AND v.organization_id = ?
    ORDER BY v.version_number DESC
  `).all(req.params.id, req.orgId);
  res.json(versions);
});

app.delete('/api/architecture/:id', requireOrgContext, async (req, res) => {
  // Try org_architecture first; if nothing deleted, try use_cases (ai_usecase items live there)
  const archResult = await db.prepare('DELETE FROM org_architecture WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  if (!archResult.changes) {
    await db.prepare('DELETE FROM use_cases WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  }
  res.json({ success: true });
});

// Org users list – accessible to all authenticated org members (user pickers, role assignment)
app.get('/api/org-users', requireOrgContext, async (req, res) => {
  const users = await db.prepare(
    "SELECT id, name, email, role, department FROM users WHERE organization_id = ? AND status = 'active' AND role != 'superadmin' ORDER BY name"
  ).all(req.orgId);
  res.json(users);
});

// My Tasks – aggregates tasks, actions, and NCRs assigned to the current user
app.get('/api/my-tasks', requireOrgContext, async (req, res) => {
  const userId = req.session.userId;
  const user = await db.prepare('SELECT name, email FROM users WHERE id = ?').get(userId);
  if (!user) return res.json({ tasks: [], actions: [], ncrs: [], audits: [], treatments: [], assignedRoles: [] });

  // --- Resolve roles assigned to this user ---
  const allRoles = await db.prepare(
    "SELECT name, metadata FROM org_architecture WHERE organization_id = ? AND arch_type = 'role'"
  ).all(req.orgId);

  const assignedRoles = allRoles
    .filter(r => {
      try {
        return String(JSON.parse(r.metadata || '{}').assigned_user_id) === String(userId);
      } catch { return false; }
    })
    .map(r => r.name);

  // Full set of identifiers: user's own name/email + every role they hold
  const matches = [...new Set([user.name, user.email, ...assignedRoles].filter(Boolean))];
  const ph = matches.map(() => '?').join(', '); // reusable placeholders

  // --- Recurring Tasks ---
  const tasks = await db.prepare(
    `SELECT * FROM tasks WHERE organization_id = ? AND is_active = 1 AND assignee IN (${ph}) ORDER BY next_due ASC`
  ).all(req.orgId, ...matches);

  // --- Follow-up Actions ---
  const actions = await db.prepare(
    `SELECT a.*, COALESCE(t.title, 'Standalone') AS task_title
     FROM actions a LEFT JOIN tasks t ON a.task_id = t.id
     WHERE a.organization_id = ? AND a.assignee IN (${ph}) AND a.status NOT IN ('resolved','closed')
     ORDER BY a.due_date ASC NULLS LAST, a.created_at DESC`
  ).all(req.orgId, ...matches);

  // --- Non-Conformities ---
  const ncrs = await db.prepare(
    `SELECT n.*, a.title AS audit_title FROM non_conformities n
     JOIN audits a ON n.audit_id = a.id
     WHERE n.organization_id = ? AND n.responsible IN (${ph}) AND n.status NOT IN ('closed','verified')
     ORDER BY n.due_date ASC NULLS LAST, n.created_at DESC`
  ).all(req.orgId, ...matches);

  // --- Audits (as lead auditor or auditee, not yet completed) ---
  const audits = await db.prepare(
    `SELECT * FROM audits
     WHERE organization_id = ? AND status != 'completed'
       AND (lead_auditor IN (${ph}) OR auditee IN (${ph}))
     ORDER BY planned_date ASC NULLS LAST`
  ).all(req.orgId, ...matches, ...matches); // matches twice for both IN clauses

  // --- Risk Treatments (open/in-progress) ---
  const treatments = await db.prepare(
    `SELECT rt.*, r.title AS risk_title FROM risk_treatments rt
     JOIN risks r ON rt.risk_id = r.id
     WHERE r.organization_id = ? AND rt.responsible IN (${ph}) AND rt.status IN ('planned','in_progress')
     ORDER BY rt.due_date ASC NULLS LAST, rt.created_at DESC`
  ).all(req.orgId, ...matches);

  // --- Management Review Outputs (open/in-progress, assigned to user or their roles) ---
  const mgmtOutputs = await db.prepare(
    `SELECT o.*, mr.title AS review_title, mr.review_date
     FROM management_review_outputs o
     JOIN management_reviews mr ON o.review_id = mr.id
     WHERE o.organization_id = ? AND o.assigned_to IN (${ph}) AND o.status IN ('open','in_progress')
     ORDER BY o.due_date ASC NULLS LAST, o.created_at DESC`
  ).all(req.orgId, ...matches);

  res.json({
    tasks, actions, ncrs, audits, treatments, mgmtOutputs,
    assignedRoles,
    user: { name: user.name, email: user.email }
  });
});

// --- Document Control API ---

app.get('/api/documents', requireOrgContext, async (req, res) => {
  const { doc_type, status, linked_module, classification } = req.query;
  let sql = 'SELECT * FROM documents WHERE organization_id = ?';
  const params = [req.orgId];
  if (doc_type) { sql += ' AND doc_type = ?'; params.push(doc_type); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (linked_module) { sql += ' AND linked_module = ?'; params.push(linked_module); }
  if (classification) { sql += ' AND classification = ?'; params.push(classification); }
  sql += ' ORDER BY updated_at DESC';
  res.json(await db.prepare(sql).all(...params));
});

app.post('/api/documents', requireOrgContext, upload.single('file'), async (req, res) => {
  const { title, description, doc_type, version, owner, status, linked_module, linked_ref_type, linked_ref_id, review_date, classification } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const file = req.file;
  let storagePath = '';
  if (file) {
    try {
      storagePath = await uploadToSupabase('documents', file);
    } catch (err) {
      // Storage unavailable — continue without file storage; record the metadata
      console.warn('File upload skipped (storage unavailable):', err.message);
    }
  }
  const result = await db.prepare(`INSERT INTO documents (organization_id, title, description, doc_type, version, owner, status, file_name, file_path, file_size, mime_type, linked_module, linked_ref_type, linked_ref_id, review_date, classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.orgId,
    title, description || '', doc_type || 'policy', version || '1.0', owner || '', status || 'draft',
    file ? file.originalname : '', storagePath, file ? file.size : 0, file ? file.mimetype : '',
    linked_module || '', linked_ref_type || '', linked_ref_id || null, review_date || null, classification || ''
  );
  res.status(201).json(await db.prepare('SELECT * FROM documents WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/documents/:id', requireOrgContext, upload.single('file'), async (req, res) => {
  const existing = await db.prepare('SELECT * FROM documents WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Document not found' });
  const { title, description, doc_type, version, owner, status, linked_module, linked_ref_type, linked_ref_id, review_date, classification } = req.body;
  const file = req.file;
  let storagePath = file ? '' : existing.file_path;
  if (file) {
    try {
      storagePath = await uploadToSupabase('documents', file);
      // Delete the old file from Supabase Storage
      if (existing.file_path) await deleteFromSupabase(existing.file_path);
    } catch (err) {
      // Storage unavailable — keep existing path, update metadata only
      storagePath = existing.file_path;
      console.warn('File upload skipped (storage unavailable):', err.message);
    }
  }
  await db.prepare(`UPDATE documents SET title=?, description=?, doc_type=?, version=?, owner=?, status=?, file_name=?, file_path=?, file_size=?, mime_type=?, linked_module=?, linked_ref_type=?, linked_ref_id=?, review_date=?, classification=?, updated_at=datetime('now') WHERE id=?`).run(
    title || existing.title, description !== undefined ? description : existing.description,
    doc_type || existing.doc_type, version || existing.version, owner !== undefined ? owner : existing.owner,
    status || existing.status,
    file ? file.originalname : existing.file_name, storagePath,
    file ? file.size : existing.file_size, file ? file.mimetype : existing.mime_type,
    linked_module !== undefined ? linked_module : existing.linked_module,
    linked_ref_type !== undefined ? linked_ref_type : existing.linked_ref_type,
    linked_ref_id !== undefined ? (linked_ref_id || null) : existing.linked_ref_id,
    review_date !== undefined ? (review_date || null) : existing.review_date,
    classification !== undefined ? classification : (existing.classification || ''),
    req.params.id
  );
  const updatedDoc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (status === 'approved' && existing.status !== 'approved') {
    fireWebhooks(req.orgId, 'doc_approved', {
      id: updatedDoc.id, title: updatedDoc.title, doc_type: updatedDoc.doc_type,
      version: updatedDoc.version, owner: updatedDoc.owner,
    });
  }
  res.json(updatedDoc);
});

app.delete('/api/documents/:id', requireOrgContext, async (req, res) => {
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.file_path) await deleteFromSupabase(doc.file_path);
  await db.prepare('DELETE FROM documents WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  res.json({ success: true });
});

app.get('/api/documents/:id/download', requireOrgContext, async (req, res) => {
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!doc) return res.status(404).json({ error: 'File not found' });

  // Special case: management review reports are stored as HTML in the reviews table
  if (doc.linked_ref_type === 'management_review' && doc.doc_type === 'report' && (!doc.file_path || doc.file_path === '')) {
    const review = await db.prepare(
      'SELECT report_html, title FROM management_reviews WHERE id = ? AND organization_id = ?'
    ).get(doc.linked_ref_id, req.orgId);
    if (!review || !review.report_html) return res.status(404).json({ error: 'Report not generated yet' });
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="management-review-${doc.linked_ref_id}.html"`);
    return res.send(review.report_html);
  }

  if (!doc.file_path) return res.status(404).json({ error: 'File not found' });
  try {
    const signedUrl = await getSignedUrl(doc.file_path, 300, doc.file_name || doc.title || true);
    res.redirect(signedUrl);
  } catch (err) {
    res.status(404).json({ error: 'File not found in storage' });
  }
});

// GET /api/documents/:id/edit-content — download file from storage and return editable content
app.get('/api/documents/:id/edit-content', requireOrgContext, async (req, res) => {
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (!doc.file_path) return res.status(400).json({ error: 'No file attached to this document' });

  const ext = (doc.file_name || '').split('.').pop().toLowerCase();
  if (!['docx', 'doc', 'xlsx', 'xls'].includes(ext)) {
    return res.status(400).json({ error: 'Only Word (.docx) and Excel (.xlsx) files can be edited in the browser' });
  }

  if (!storageClient) return res.status(503).json({ error: 'Storage not configured' });
  const { data: blob, error: dlErr } = await storageClient.storage.from(UPLOADS_BUCKET).download(doc.file_path);
  if (dlErr) return res.status(500).json({ error: 'Failed to retrieve file from storage' });

  const buffer = Buffer.from(await blob.arrayBuffer());

  if (['xlsx', 'xls'].includes(ext)) {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheets = {};
    for (const name of wb.SheetNames) {
      sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
    }
    return res.json({ type: 'excel', sheetNames: wb.SheetNames, sheets });
  }

  // Word
  const { value: html } = await mammoth.convertToHtml({ buffer });
  res.json({ type: 'word', html });
});

// PUT /api/documents/:id/save-content — save edited content back to storage
app.put('/api/documents/:id/save-content', requireOrgContext, async (req, res) => {
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (!doc.file_path) return res.status(400).json({ error: 'No file path on record' });

  const { type, content } = req.body;
  if (!type || !content) return res.status(400).json({ error: 'Missing type or content' });

  let fileBuffer, mimeType;

  if (type === 'excel') {
    const wb = XLSX.utils.book_new();
    for (const [name, rows] of Object.entries(content.sheets || {})) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
    }
    fileBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else if (type === 'word') {
    const docxBuffer = await HTMLtoDOCX(content.html || '', null, { table: { row: { cantSplit: true } } });
    fileBuffer = Buffer.isBuffer(docxBuffer) ? docxBuffer : Buffer.from(docxBuffer);
    mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  } else {
    return res.status(400).json({ error: 'Unsupported content type' });
  }

  if (!storageClient) return res.status(503).json({ error: 'Storage not configured' });
  const { error: upErr } = await storageClient.storage
    .from(UPLOADS_BUCKET)
    .update(doc.file_path, fileBuffer, { contentType: mimeType, upsert: true });
  if (upErr) return res.status(500).json({ error: 'Failed to save file: ' + upErr.message });

  await db.prepare("UPDATE documents SET file_size=?, mime_type=?, updated_at=datetime('now') WHERE id=?").run(fileBuffer.length, mimeType, req.params.id);
  res.json({ success: true });
});

// --- Universal Cross-Linking API ---

// Entity type resolution helpers
const entityResolvers = {
  risk: async (id) => await db.get('SELECT id, title as name FROM risks WHERE id = ?', id),
  task: async (id) => await db.get('SELECT id, title as name FROM tasks WHERE id = ?', id),
  action: async (id) => await db.get('SELECT id, title as name FROM actions WHERE id = ?', id),
  requirement: async (id) => { const r = await db.get('SELECT id, clause, title, standard FROM standard_requirements WHERE id = ?', id); return r ? { id: r.id, name: `${r.clause} - ${r.title} (${r.standard})` } : null; },
  audit: async (id) => await db.get('SELECT id, title as name FROM audits WHERE id = ?', id),
  ncr: async (id) => { const n = await db.get('SELECT id, clause, description FROM non_conformities WHERE id = ?', id); return n ? { id: n.id, name: `NCR: ${n.clause} - ${n.description.substring(0, 60)}` } : null; },
  role: async (id) => await db.get("SELECT id, name FROM org_architecture WHERE id = ? AND arch_type = 'role'", id),
  process: async (id) => await db.get("SELECT id, name FROM org_architecture WHERE id = ? AND arch_type = 'process'", id),
  system: async (id) => await db.get("SELECT id, name FROM org_architecture WHERE id = ? AND arch_type = 'system'", id),
  asset: async (id) => await db.get("SELECT id, name FROM org_architecture WHERE id = ? AND arch_type = 'asset'", id),
  facility: async (id) => await db.get("SELECT id, name FROM org_architecture WHERE id = ? AND arch_type = 'facility'", id),
  document: async (id) => await db.get('SELECT id, title as name FROM documents WHERE id = ?', id),
  treatment: async (id) => { const t = await db.get('SELECT id, description FROM risk_treatments WHERE id = ?', id); return t ? { id: t.id, name: `Treatment: ${t.description.substring(0, 60)}` } : null; },
  usecase: async (id) => await db.get('SELECT id, title as name FROM use_cases WHERE id = ?', id),
  ai_model:   async (id) => await db.get("SELECT id, name FROM org_architecture WHERE id = ? AND arch_type = 'ai_model'", id),
  ai_dataset: async (id) => await db.get("SELECT id, name FROM org_architecture WHERE id = ? AND arch_type = 'ai_dataset'", id),
  ai_usecase: async (id) => await db.get('SELECT id, title as name FROM use_cases WHERE id = ?', id),
};

// Bulk cross-links: fetch all cross-links for multiple items of the same type in one shot.
// Reduces N+1 requests to 2 (one for all links, one per distinct linked entity type).
// Usage: GET /api/cross-links/batch/:type?ids=1,2,3
app.get('/api/cross-links/batch/:type', requireOrgContext, async (req, res) => {
  const { type } = req.params;
  // Improvement 13: reject unknown entity types before they reach any query
  if (!ALLOWED_ENTITY_TYPES.has(type)) return res.status(400).json({ error: 'Invalid entity type' });
  const ids = (req.query.ids || '').split(',').map(Number).filter(Boolean);
  if (!ids.length) return res.json({});

  const ph = ids.map(() => '?').join(',');
  const rawLinks = await db.prepare(`
    SELECT * FROM cross_links
    WHERE organization_id = ?
    AND ((source_type = ? AND source_id IN (${ph})) OR (target_type = ? AND target_id IN (${ph})))
  `).all(req.orgId, type, ...ids, type, ...ids);

  // Map raw links -> { itemId -> [{link_id, otherType, otherId}] }
  const linksByItem = {};
  const needed = {}; // otherType -> Set<id>
  for (const l of rawLinks) {
    const isSource = l.source_type === type && ids.includes(l.source_id);
    const isTarget = l.target_type === type && ids.includes(l.target_id);
    const itemId = isSource ? l.source_id : isTarget ? l.target_id : null;
    if (!itemId) continue;
    const otherType = isSource ? l.target_type : l.source_type;
    const otherId   = isSource ? l.target_id   : l.source_id;
    if (!linksByItem[itemId]) linksByItem[itemId] = [];
    linksByItem[itemId].push({ link_id: l.id, otherType, otherId, relationship_type: l.relationship_type || 'association' });
    if (!needed[otherType]) needed[otherType] = new Set();
    needed[otherType].add(otherId);
  }

  // Resolve names in bulk — one query per distinct linked entity type
  const nameCache = {}; // `${type}:${id}` -> name
  for (const [eType, eIds] of Object.entries(needed)) {
    if (!ALLOWED_ENTITY_TYPES.has(eType)) continue; // Improvement 13: skip unknown types
    const idArr = [...eIds];
    const eph = idArr.map(() => '?').join(',');
    let rows = [];
    if (eType === 'risk') rows = await db.prepare(`SELECT id, title as name FROM risks WHERE id IN (${eph})`).all(...idArr);
    else if (eType === 'task') rows = await db.prepare(`SELECT id, title as name FROM tasks WHERE id IN (${eph})`).all(...idArr);
    else if (eType === 'action') rows = await db.prepare(`SELECT id, title as name FROM actions WHERE id IN (${eph})`).all(...idArr);
    else if (eType === 'audit') rows = await db.prepare(`SELECT id, title as name FROM audits WHERE id IN (${eph})`).all(...idArr);
    else if (eType === 'document') rows = await db.prepare(`SELECT id, title as name FROM documents WHERE id IN (${eph})`).all(...idArr);
    else if (eType === 'requirement') rows = (await db.prepare(`SELECT id, clause, title, standard FROM standard_requirements WHERE id IN (${eph})`).all(...idArr))
      .map(r => ({ id: r.id, name: `${r.clause} - ${r.title} (${r.standard})` }));
    else if (eType === 'ncr') rows = (await db.prepare(`SELECT id, clause, description FROM non_conformities WHERE id IN (${eph})`).all(...idArr))
      .map(n => ({ id: n.id, name: `NCR: ${n.clause} - ${n.description.substring(0, 60)}` }));
    else if (eType === 'treatment') rows = (await db.prepare(`SELECT id, description FROM risk_treatments WHERE id IN (${eph})`).all(...idArr))
      .map(t => ({ id: t.id, name: `Treatment: ${t.description.substring(0, 60)}` }));
    else if (['role','process','system','asset','facility','ai_model','ai_dataset'].includes(eType))
      rows = await db.prepare(`SELECT id, name FROM org_architecture WHERE arch_type = ? AND id IN (${eph})`).all(eType, ...idArr);
    else if (eType === 'ai_usecase') rows = await db.prepare(`SELECT id, title as name FROM use_cases WHERE id IN (${eph})`).all(...idArr);
    else if (eType === 'usecase') rows = await db.prepare(`SELECT id, title as name FROM use_cases WHERE id IN (${eph})`).all(...idArr);
    for (const r of rows) nameCache[`${eType}:${r.id}`] = r.name;
  }

  // Build final result keyed by item id
  const result = {};
  for (const [itemId, entries] of Object.entries(linksByItem)) {
    result[itemId] = entries.map(({ link_id, otherType, otherId, relationship_type }) => ({
      link_id,
      type: otherType,
      id: otherId,
      name: nameCache[`${otherType}:${otherId}`] || `${otherType} #${otherId}`,
      relationship_type,
    }));
  }
  res.json(result);
});

// Get all cross-links for an entity
app.get('/api/cross-links/:type/:id', requireOrgContext, async (req, res) => {
  const { type, id } = req.params;
  const links = await db.prepare(`
    SELECT * FROM cross_links WHERE organization_id = ? AND ((source_type = ? AND source_id = ?) OR (target_type = ? AND target_id = ?))
  `).all(req.orgId, type, id, type, id);

  const resolved = [];
  for (const l of links) {
    const isSource = l.source_type === type && l.source_id === parseInt(id);
    const otherType = isSource ? l.target_type : l.source_type;
    const otherId = isSource ? l.target_id : l.source_id;
    const resolver = entityResolvers[otherType];
    const entity = resolver ? await resolver(otherId) : null;
    const name = entity ? entity.name : `${otherType} #${otherId}`;
    if (name) resolved.push({ link_id: l.id, type: otherType, id: otherId, name });
  }

  res.json(resolved);
});

// Add a cross-link
app.post('/api/cross-links', requireOrgContext, async (req, res) => {
  const { source_type, source_id, target_type, target_id, relationship_type = 'association', notes = '' } = req.body;
  if (!source_type || !source_id || !target_type || !target_id) return res.status(400).json({ error: 'All fields required' });
  // Improvement 1: validate relationship_type against ArchiMate allow-list
  if (!ALLOWED_ENTITY_TYPES.has(source_type) || !ALLOWED_ENTITY_TYPES.has(target_type)) {
    return res.status(400).json({ error: 'Invalid entity type' });
  }
  const VALID_REL_TYPES = ['association','composition','aggregation','assignment','realization','serving','triggering','flow','influence','access'];
  if (!VALID_REL_TYPES.includes(relationship_type)) {
    return res.status(400).json({ error: `Invalid relationship_type. Must be one of: ${VALID_REL_TYPES.join(', ')}` });
  }
  // Normalize order to avoid duplicates (alphabetical source_type)
  const [s_type, s_id, t_type, t_id] = source_type < target_type
    ? [source_type, source_id, target_type, target_id]
    : [target_type, target_id, source_type, source_id];
  try {
    const result = await db.prepare('INSERT INTO cross_links (organization_id, source_type, source_id, target_type, target_id, relationship_type, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.orgId, s_type, s_id, t_type, t_id, relationship_type, notes);
    res.status(201).json({ success: true, id: result.lastInsertRowid, relationship_type });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Link with this relationship type already exists' });
    throw e;
  }
});

// Delete a cross-link
app.delete('/api/cross-links/:id', requireOrgContext, async (req, res) => {
  await db.prepare('DELETE FROM cross_links WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  res.json({ success: true });
});

// List linkable entities by type
app.get('/api/linkable/:type', requireOrgContext, async (req, res) => {
  const { type } = req.params;
  const oid = req.orgId;
  let items = [];
  if (type === 'risk') items = await db.prepare('SELECT id, title as name FROM risks WHERE organization_id = ? ORDER BY title').all(oid);
  else if (type === 'task') items = await db.prepare('SELECT id, title as name FROM tasks WHERE organization_id = ? ORDER BY title').all(oid);
  else if (type === 'requirement') items = await db.prepare("SELECT id, clause || ' - ' || title || ' (' || standard || ')' as name FROM standard_requirements WHERE organization_id = ? ORDER BY standard, sort_order").all(oid);
  else if (type === 'audit') items = await db.prepare('SELECT id, title as name FROM audits WHERE organization_id = ? ORDER BY title').all(oid);
  else if (type === 'role') items = await db.prepare("SELECT id, name FROM org_architecture WHERE organization_id = ? AND arch_type = 'role' ORDER BY name").all(oid);
  else if (type === 'process') items = await db.prepare("SELECT id, name FROM org_architecture WHERE organization_id = ? AND arch_type = 'process' ORDER BY name").all(oid);
  else if (type === 'system') items = await db.prepare("SELECT id, name FROM org_architecture WHERE organization_id = ? AND arch_type = 'system' ORDER BY name").all(oid);
  else if (type === 'asset') items = await db.prepare("SELECT id, name FROM org_architecture WHERE organization_id = ? AND arch_type = 'asset' ORDER BY name").all(oid);
  else if (type === 'facility') items = await db.prepare("SELECT id, name FROM org_architecture WHERE organization_id = ? AND arch_type = 'facility' ORDER BY name").all(oid);
  else if (type === 'document') items = await db.prepare('SELECT id, title as name FROM documents WHERE organization_id = ? ORDER BY title').all(oid);
  else if (type === 'ncr') items = await db.prepare("SELECT id, clause || ' - ' || substr(description, 1, 60) as name FROM non_conformities WHERE organization_id = ? ORDER BY id DESC").all(oid);
  else if (type === 'treatment') items = await db.prepare("SELECT id, substr(description, 1, 80) as name FROM risk_treatments WHERE organization_id = ? ORDER BY id DESC").all(oid);
  else if (type === 'action') items = await db.prepare('SELECT id, title as name FROM actions WHERE organization_id = ? ORDER BY id DESC').all(oid);
  else if (type === 'usecase') items = await db.prepare('SELECT id, title as name FROM use_cases WHERE organization_id = ? ORDER BY title').all(oid);
  else if (type === 'ai_model')   items = await db.prepare("SELECT id, name FROM org_architecture WHERE organization_id = ? AND arch_type = 'ai_model' ORDER BY name").all(oid);
  else if (type === 'ai_dataset') items = await db.prepare("SELECT id, name FROM org_architecture WHERE organization_id = ? AND arch_type = 'ai_dataset' ORDER BY name").all(oid);
  else if (type === 'ai_usecase') items = await db.prepare('SELECT id, title as name FROM use_cases WHERE organization_id = ? ORDER BY title').all(oid);
  res.json(items);
});

// Cross-linking references endpoint (legacy for document control)
app.get('/api/link-references', requireOrgContext, async (req, res) => {
  const { module } = req.query;
  const refs = [];
  if (module === 'audits') {
    const reqs = await db.prepare('SELECT id, clause, title, standard FROM standard_requirements WHERE organization_id = ? ORDER BY standard, sort_order').all(req.orgId);
    reqs.forEach(r => refs.push({ id: r.id, type: 'requirement', label: `${r.clause} - ${r.title} (${r.standard})` }));
  } else if (module === 'risk-management') {
    const risks = await db.prepare('SELECT id, title FROM risks WHERE organization_id = ? ORDER BY title').all(req.orgId);
    risks.forEach(r => refs.push({ id: r.id, type: 'risk', label: r.title }));
  } else if (module === 'operational-planning') {
    const tasks = await db.prepare('SELECT id, title FROM tasks WHERE organization_id = ? ORDER BY title').all(req.orgId);
    tasks.forEach(t => refs.push({ id: t.id, type: 'task', label: t.title }));
    const actions = await db.prepare('SELECT id, title FROM actions WHERE organization_id = ? ORDER BY title').all(req.orgId);
    actions.forEach(a => refs.push({ id: a.id, type: 'action', label: a.title }));
  } else if (module === 'org-planning') {
    const arch = await db.prepare('SELECT id, name, arch_type FROM org_architecture WHERE organization_id = ? ORDER BY arch_type, name').all(req.orgId);
    arch.forEach(a => refs.push({ id: a.id, type: a.arch_type, label: `${a.name} (${a.arch_type})` }));
  }
  res.json(refs);
});

// ===== ADMIN API ENDPOINTS =====

// Admin: System Overview Stats
// Admin-only middleware (org_admin or superadmin with active org context)
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

// Admin: Users CRUD
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const { status, role, search } = req.query;
  let sql = "SELECT id, name, email, role, department, permissions, status, last_active, expiry_date, notes, created_at, updated_at FROM users WHERE organization_id = ? AND role != 'superadmin'";
  const params = [req.orgId];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (role) { sql += ' AND role = ?'; params.push(role); }
  if (search) {
    sql += ' AND (name ILIKE ? OR email ILIKE ? OR department ILIKE ?)';
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern);
  }
  sql += ' ORDER BY name';
  res.json(await db.prepare(sql).all(...params));
});

app.get('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const user = await db.prepare('SELECT id, name, email, role, department, permissions, status, last_active, expiry_date, notes, created_at, updated_at FROM users WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { name, email, password, role, department, permissions, status, expiry_date, notes } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email format' });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const userRole = role || 'org_user';
    if (userRole === 'superadmin') return res.status(400).json({ error: 'Cannot create superadmin users from org admin' });
    const normalizedEmail = email.toLowerCase().trim();

    // Create user in Supabase Auth if admin client is available
    let supabaseUid = null;
    if (supabaseAdmin) {
      try {
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
          email: normalizedEmail,
          password,
          email_confirm: true,
          app_metadata: { organization_id: req.orgId, role: userRole },
          user_metadata: { name, department: department || '' },
        });
        if (!authError && authData?.user) {
          supabaseUid = authData.user.id;
        }
      } catch (_) { /* Supabase Auth unavailable – continue with local auth */ }
    }

    const result = await db.prepare(`
      INSERT INTO users (organization_id, name, email, password, role, department, permissions, status, expiry_date, notes, supabase_uid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.orgId, name, normalizedEmail, hashedPassword, userRole, department || '',
           JSON.stringify(permissions || ['org','risk','ops','audit']),
           status || 'active', expiry_date || null, notes || '', supabaseUid);

    const admin = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.session.userId);
    await logAuditAction(req.session.userId, admin?.name || 'Admin', 'user_created', 'user', result.lastInsertRowid, name, '', req.orgId);

    const newUser = await db.prepare('SELECT id, name, email, role, department, permissions, status, last_active, expiry_date, notes, created_at, updated_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(newUser);
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE') || e.message.includes('duplicate')) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }
    console.error('Create user error:', e);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Prevent self-demotion from admin
  if (parseInt(req.params.id) === req.session.userId) {
    if (req.body.role && req.body.role !== 'admin') {
      return res.status(400).json({ error: 'You cannot change your own admin role. Ask another admin.' });
    }
    if (req.body.status && req.body.status !== 'active') {
      return res.status(400).json({ error: 'You cannot deactivate your own account.' });
    }
  }

  if (req.body.email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(req.body.email)) return res.status(400).json({ error: 'Invalid email format' });
    req.body.email = req.body.email.toLowerCase().trim();
  }

  const fields = ['name', 'email', 'role', 'department', 'permissions', 'status', 'expiry_date', 'notes'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(f === 'permissions' ? JSON.stringify(req.body[f]) : req.body[f]);
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);

  try {
    await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);

    // Revoke outstanding sessions when an admin suspends/deactivates a user or
    // strips superadmin/org_admin privileges.
    const statusNowRestricted = req.body.status && req.body.status !== 'active';
    const roleDowngraded = req.body.role && req.body.role !== user.role &&
      (user.role === 'superadmin' || user.role === 'org_admin') && req.body.role === 'org_user';
    if (statusNowRestricted || roleDowngraded) {
      await bumpUserSessionVersion(user.id);
    }

    const admin = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.session.userId);
    await logAuditAction(req.session.userId, admin?.name || 'Admin', 'user_updated', 'user', user.id, user.name,
      JSON.stringify(Object.keys(req.body).filter(k => k !== 'password')), req.orgId);
    const updated = await db.prepare('SELECT id, name, email, role, department, permissions, status, last_active, expiry_date, notes, created_at, updated_at FROM users WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    res.json(updated);
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE') || e.message.includes('duplicate')) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }
    console.error('Update user error:', e);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Admin: Reset user password
app.put('/api/admin/users/:id/password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const user = await db.prepare('SELECT * FROM users WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const hashedPassword = await bcrypt.hash(password, 10);
  await db.prepare("UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?").run(hashedPassword, req.params.id, req.orgId);

  // Sync password to Supabase Auth if available
  if (supabaseAdmin && user.supabase_uid) {
    try {
      await supabaseAdmin.auth.admin.updateUserById(user.supabase_uid, { password });
    } catch (_) { /* Non-critical */ }
  }

  // Password reset invalidates any outstanding sessions for this user
  await bumpUserSessionVersion(user.id);

  const admin = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.session.userId);
  await logAuditAction(req.session.userId, admin?.name || 'Admin', 'user_password_reset', 'user', user.id, user.name, '', req.orgId);
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.session.userId) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }

  const user = await db.prepare('SELECT * FROM users WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Remove from Supabase Auth if available
  if (supabaseAdmin && user.supabase_uid) {
    try {
      await supabaseAdmin.auth.admin.deleteUser(user.supabase_uid);
    } catch (_) { /* Non-critical */ }
  }

  await db.prepare('DELETE FROM users WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  const admin = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.session.userId);
  await logAuditAction(req.session.userId, admin?.name || 'Admin', 'user_deleted', 'user', user.id, user.name, '', req.orgId);
  res.json({ success: true });
});

// Admin: Audit Log
app.get('/api/admin/audit-log', requireAdmin, async (req, res) => {
  const { action, entity_type, user_name, limit = 100, offset = 0 } = req.query;
  let sql = 'SELECT * FROM admin_audit_log WHERE organization_id = ?';
  const params = [req.orgId];
  if (action) { sql += ' AND action LIKE ?'; params.push(`%${action}%`); }
  if (entity_type) { sql += ' AND entity_type = ?'; params.push(entity_type); }
  if (user_name) { sql += ' AND user_name LIKE ?'; params.push(`%${user_name}%`); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  const safeLimit = parseIntParam(limit, 100, { min: 1, max: 500 });
  const safeOffset = parseIntParam(offset, 0, { min: 0, max: 100_000 });
  params.push(safeLimit, safeOffset);

  const logs = await db.prepare(sql).all(...params);
  const total = (await db.prepare('SELECT COUNT(*) as c FROM admin_audit_log WHERE organization_id = ?').get(req.orgId)).c;
  res.json({ logs, total, limit: safeLimit, offset: safeOffset });
});

// Helper function to log audit actions
async function logAuditAction(userId, userName, action, entityType, entityId, entityName, details = '', orgId = null) {
  await db.run(`
    INSERT INTO admin_audit_log (organization_id, user_id, user_name, action, entity_type, entity_id, entity_name, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, orgId, userId, userName, action, entityType, entityId, entityName, details);
}

// Admin: System Settings
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  const settings = await db.prepare('SELECT * FROM system_settings WHERE organization_id = ?').all(req.orgId);
  const result = {};
  for (const s of settings) {
    try { result[s.key] = JSON.parse(s.value); }
    catch { result[s.key] = s.value; }
  }
  res.json(result);
});

app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  const settings = req.body;
  const upsert = db.prepare(`
    INSERT INTO system_settings (key, value, organization_id, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `);

  for (const [key, value] of Object.entries(settings)) {
    await upsert.run(key, typeof value === 'object' ? JSON.stringify(value) : String(value), req.orgId);
  }

  await logAuditAction(null, 'System', 'settings_updated', 'settings', null, null, JSON.stringify(Object.keys(settings)), req.orgId);
  res.json({ success: true });
});

// Admin: API Keys
app.get('/api/admin/api-keys', requireAdmin, async (req, res) => {
  res.json(await db.prepare("SELECT id, name, key_prefix, permissions, last_used, expires_at, status, created_at FROM api_keys WHERE organization_id = ? ORDER BY created_at DESC").all(req.orgId));
});

app.post('/api/admin/api-keys', requireAdmin, async (req, res) => {
  const { name, permissions, expires_at } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  // Generate a random API key
  const key = 'ltfw_' + crypto.randomBytes(24).toString('hex');
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  const keyPrefix = key.substring(0, 12) + '...';

  const result = await db.prepare(`
    INSERT INTO api_keys (organization_id, name, key_hash, key_prefix, permissions, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.orgId, name, keyHash, keyPrefix, JSON.stringify(permissions || ['read']), expires_at || null);

  await logAuditAction(null, 'System', 'api_key_created', 'api_key', result.lastInsertRowid, name, '', req.orgId);

  // Return the full key only once (won't be stored/retrievable later)
  res.status(201).json({
    id: result.lastInsertRowid,
    name,
    key, // Full key shown only once!
    key_prefix: keyPrefix,
    permissions: permissions || ['read'],
    created_at: new Date().toISOString()
  });
});

app.delete('/api/admin/api-keys/:id', requireAdmin, async (req, res) => {
  const key = await db.prepare('SELECT * FROM api_keys WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!key) return res.status(404).json({ error: 'API key not found' });

  await db.prepare("UPDATE api_keys SET status = 'revoked' WHERE id = ? AND organization_id = ?").run(req.params.id, req.orgId);
  await logAuditAction(null, 'System', 'api_key_revoked', 'api_key', key.id, key.name, '', req.orgId);
  res.json({ success: true });
});

// Admin: Webhooks
app.get('/api/admin/webhooks', requireAdmin, async (req, res) => {
  res.json(await db.prepare('SELECT * FROM webhooks WHERE organization_id = ? ORDER BY created_at DESC').all(req.orgId));
});

app.post('/api/admin/webhooks', requireAdmin, async (req, res) => {
  const { name, url, events, secret, status } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Name and URL required' });

  try { await validateWebhookUrl(url); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const result = await db.prepare(`
    INSERT INTO webhooks (organization_id, name, url, events, secret, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.orgId, name, url, JSON.stringify(events || []), secret || '', status || 'active');

  await logAuditAction(null, 'System', 'webhook_created', 'webhook', result.lastInsertRowid, name, '', req.orgId);
  res.status(201).json(await db.prepare('SELECT * FROM webhooks WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/admin/webhooks/:id', requireAdmin, async (req, res) => {
  const webhook = await db.prepare('SELECT * FROM webhooks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

  const { name, url, events, secret, status } = req.body;
  if (url && url !== webhook.url) {
    try { await validateWebhookUrl(url); }
    catch (err) { return res.status(400).json({ error: err.message }); }
  }
  await db.prepare(`
    UPDATE webhooks SET name = ?, url = ?, events = ?, secret = ?, status = ? WHERE id = ? AND organization_id = ?
  `).run(name || webhook.name, url || webhook.url, JSON.stringify(events || JSON.parse(webhook.events)),
         secret !== undefined ? secret : webhook.secret, status || webhook.status, req.params.id, req.orgId);

  await logAuditAction(null, 'System', 'webhook_updated', 'webhook', webhook.id, webhook.name, '', req.orgId);
  res.json(await db.prepare('SELECT * FROM webhooks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
});

app.delete('/api/admin/webhooks/:id', requireAdmin, async (req, res) => {
  const webhook = await db.prepare('SELECT * FROM webhooks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

  await db.prepare('DELETE FROM webhooks WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  await logAuditAction(null, 'System', 'webhook_deleted', 'webhook', webhook.id, webhook.name, '', req.orgId);
  res.json({ success: true });
});

// Admin: Data Export
app.get('/api/admin/export', requireAdmin, async (req, res) => {
  const { format = 'json', include } = req.query;
  const includes = include ? include.split(',') : ['tasks', 'risks', 'audits', 'architecture', 'requirements', 'documents'];

  const data = {
    exportedAt: new Date().toISOString(),
    version: '1.0',
  };

  if (includes.includes('tasks')) {
    data.tasks = await db.prepare('SELECT * FROM tasks WHERE organization_id = ?').all(req.orgId);
    data.taskInstances = await db.prepare('SELECT * FROM task_instances WHERE organization_id = ?').all(req.orgId);
    data.actions = await db.prepare('SELECT * FROM actions WHERE organization_id = ?').all(req.orgId);
  }
  if (includes.includes('risks')) {
    data.risks = await db.prepare('SELECT * FROM risks WHERE organization_id = ?').all(req.orgId);
    data.treatments = await db.prepare('SELECT * FROM risk_treatments WHERE organization_id = ?').all(req.orgId);
  }
  if (includes.includes('audits')) {
    data.audits = await db.prepare('SELECT * FROM audits WHERE organization_id = ?').all(req.orgId);
    data.auditChecklist = await db.prepare('SELECT * FROM audit_checklist WHERE organization_id = ?').all(req.orgId);
    data.ncrs = await db.prepare('SELECT * FROM non_conformities WHERE organization_id = ?').all(req.orgId);
  }
  if (includes.includes('architecture')) {
    data.architecture = await db.prepare('SELECT * FROM org_architecture WHERE organization_id = ?').all(req.orgId);
    data.kpis = await db.prepare('SELECT * FROM org_kpis WHERE organization_id = ?').all(req.orgId);
  }
  if (includes.includes('requirements')) {
    data.requirements = await db.prepare('SELECT * FROM standard_requirements WHERE organization_id = ?').all(req.orgId);
    data.soaEntries = await db.prepare('SELECT * FROM soa_entries WHERE organization_id = ?').all(req.orgId);
  }
  if (includes.includes('documents')) {
    data.documents = await db.prepare('SELECT id, title, description, doc_type, version, owner, status, classification, linked_module, review_date, created_at FROM documents WHERE organization_id = ?').all(req.orgId);
  }

  // Cross-links
  data.crossLinks = await db.prepare('SELECT * FROM cross_links WHERE organization_id = ?').all(req.orgId);

  await logAuditAction(null, 'System', 'data_exported', 'system', null, null, `Format: ${format}, Includes: ${includes.join(',')}`, req.orgId);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="ltfw-export-${new Date().toISOString().split('T')[0]}.json"`);
  res.json(data);
});

// Admin: Create Backup
app.post('/api/admin/backups', requireAdmin, async (req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backup-${timestamp}.json`;

  // Get all data
  const data = {
    exportedAt: new Date().toISOString(),
    version: '1.0',
    tasks: await db.prepare('SELECT * FROM tasks WHERE organization_id = ?').all(req.orgId),
    taskInstances: await db.prepare('SELECT * FROM task_instances WHERE organization_id = ?').all(req.orgId),
    actions: await db.prepare('SELECT * FROM actions WHERE organization_id = ?').all(req.orgId),
    risks: await db.prepare('SELECT * FROM risks WHERE organization_id = ?').all(req.orgId),
    treatments: await db.prepare('SELECT * FROM risk_treatments WHERE organization_id = ?').all(req.orgId),
    audits: await db.prepare('SELECT * FROM audits WHERE organization_id = ?').all(req.orgId),
    auditChecklist: await db.prepare('SELECT * FROM audit_checklist WHERE organization_id = ?').all(req.orgId),
    ncrs: await db.prepare('SELECT * FROM non_conformities WHERE organization_id = ?').all(req.orgId),
    architecture: await db.prepare('SELECT * FROM org_architecture WHERE organization_id = ?').all(req.orgId),
    requirements: await db.prepare('SELECT * FROM standard_requirements WHERE organization_id = ?').all(req.orgId),
    soaEntries: await db.prepare('SELECT * FROM soa_entries WHERE organization_id = ?').all(req.orgId),
    documents: await db.prepare('SELECT * FROM documents WHERE organization_id = ?').all(req.orgId),
    kpis: await db.prepare('SELECT * FROM org_kpis WHERE organization_id = ?').all(req.orgId),
    kpiValues: await db.prepare('SELECT * FROM org_kpi_values WHERE organization_id = ?').all(req.orgId),
    crossLinks: await db.prepare('SELECT * FROM cross_links WHERE organization_id = ?').all(req.orgId),
    threatFeeds: await db.prepare('SELECT * FROM threat_feeds WHERE organization_id = ?').all(req.orgId),
    users: await db.prepare('SELECT id, name, email, role, department, permissions, status FROM users WHERE organization_id = ?').all(req.orgId),
    settings: await db.prepare('SELECT * FROM system_settings WHERE organization_id = ?').all(req.orgId),
  };

  const content = JSON.stringify(data, null, 2);
  const size = Buffer.byteLength(content, 'utf8');

  // Upload backup to Supabase Storage
  if (!storageClient) return res.status(500).json({ error: 'Supabase is not configured (missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY)' });
  const { error: uploadError } = await storageClient.storage
    .from(UPLOADS_BUCKET)
    .upload(`backups/${filename}`, Buffer.from(content, 'utf8'), { contentType: 'application/json', upsert: false });
  if (uploadError) return res.status(500).json({ error: `Backup storage failed: ${uploadError.message}` });

  // Save backup record
  const result = await db.prepare(`
    INSERT INTO backups (organization_id, filename, size, type, status) VALUES (?, ?, ?, ?, 'completed')
  `).run(req.orgId, filename, size, req.body.type || 'manual');

  await logAuditAction(null, 'System', 'backup_created', 'backup', result.lastInsertRowid, filename, '', req.orgId);
  res.status(201).json(await db.prepare('SELECT * FROM backups WHERE id = ?').get(result.lastInsertRowid));
});

app.get('/api/admin/backups', requireAdmin, async (req, res) => {
  res.json(await db.prepare("SELECT * FROM backups WHERE organization_id = ? ORDER BY created_at DESC").all(req.orgId));
});

app.get('/api/admin/backups/:id/download', requireAdmin, async (req, res) => {
  const backup = await db.prepare('SELECT * FROM backups WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!backup) return res.status(404).json({ error: 'Backup not found' });

  try {
    const signedUrl = await getSignedUrl(`backups/${backup.filename}`, 300, backup.filename || true);
    res.redirect(signedUrl);
  } catch (err) {
    res.status(404).json({ error: 'Backup file not found in storage' });
  }
});

app.delete('/api/admin/backups/:id', requireAdmin, async (req, res) => {
  const backup = await db.prepare('SELECT * FROM backups WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!backup) return res.status(404).json({ error: 'Backup not found' });

  await deleteFromSupabase(`backups/${backup.filename}`);
  await db.prepare('DELETE FROM backups WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  await logAuditAction(null, 'System', 'backup_deleted', 'backup', backup.id, backup.filename, '', req.orgId);
  res.json({ success: true });
});

// Admin: Data Cleanup
app.post('/api/admin/cleanup', requireAdmin, async (req, res) => {
  const { type } = req.body;
  let result = { affected: 0 };

  if (type === 'history') {
    // Delete completed/skipped task instances older than 1 year (scoped to current org)
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const r = await db.prepare(
      "DELETE FROM task_instances WHERE status IN ('completed','skipped') AND scheduled_date < ? AND organization_id = ?"
    ).run(oneYearAgo.toISOString().split('T')[0], req.orgId);
    result.affected = r.changes;
  } else if (type === 'logs') {
    // Delete audit logs older than 90 days (scoped to current org)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const r = await db.prepare("DELETE FROM admin_audit_log WHERE created_at < ? AND organization_id = ?").run(ninetyDaysAgo.toISOString(), req.orgId);
    result.affected = r.changes;
  }

  await logAuditAction(null, 'System', 'data_cleanup', 'system', null, null, `Type: ${type}, Affected: ${result.affected}`, req.orgId);
  res.json(result);
});

// Admin: Data Import
app.post('/api/admin/import', requireAdmin, async (req, res) => {
  const data = req.body;
  const result = { imported: {}, errors: [] };

  try {
    // Import tasks
    if (data.tasks && Array.isArray(data.tasks)) {
      let count = 0;
      const insertTask = db.prepare(`
        INSERT OR IGNORE INTO tasks (organization_id, title, description, assignee, category, priority, recurrence, next_due, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      for (const task of data.tasks) {
        try {
          await insertTask.run(req.orgId, task.title, task.description || '', task.assignee || '', task.category || '',
            task.priority || 'medium', task.recurrence || 'monthly', task.next_due || null, task.is_active !== false ? 1 : 0);
          count++;
        } catch (e) { /* Skip duplicates */ }
      }
      result.imported.tasks = count;
    }

    // Import risks
    if (data.risks && Array.isArray(data.risks)) {
      let count = 0;
      const insertRisk = db.prepare(`
        INSERT OR IGNORE INTO risks (organization_id, title, description, category, status, risk_owner, threat, vulnerability, asset, likelihood, impact, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      for (const risk of data.risks) {
        try {
          await insertRisk.run(req.orgId, risk.title, risk.description || '', risk.category || '', risk.status || 'identified',
            risk.risk_owner || risk.owner || '', risk.threat || '', risk.vulnerability || '', risk.asset || risk.asset_system || '',
            risk.likelihood || 3, risk.impact || 3);
          count++;
        } catch (e) { /* Skip duplicates */ }
      }
      result.imported.risks = count;
    }

    // Import architecture items
    if (data.architecture && Array.isArray(data.architecture)) {
      let count = 0;
      const insertArch = db.prepare(`
        INSERT OR IGNORE INTO org_architecture (organization_id, arch_type, name, description, owner, parent_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      for (const item of data.architecture) {
        try {
          await insertArch.run(req.orgId, item.arch_type || 'role', item.name, item.description || '', item.owner || '',
            item.parent_id || null, item.status || 'active');
          count++;
        } catch (e) { /* Skip duplicates */ }
      }
      result.imported.architecture = count;
    }

    // Import requirements
    if (data.requirements && Array.isArray(data.requirements)) {
      let count = 0;
      const insertReq = db.prepare(`
        INSERT OR IGNORE INTO standard_requirements (organization_id, standard, clause, title, description, category, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      for (const item of data.requirements) {
        try {
          await insertReq.run(req.orgId, item.standard || '', item.clause || '', item.title, item.description || '',
            item.category || '');
          count++;
        } catch (e) { /* Skip duplicates */ }
      }
      result.imported.requirements = count;
    }

    // Import documents
    if (data.documents && Array.isArray(data.documents)) {
      let count = 0;
      const insertDoc = db.prepare(`
        INSERT OR IGNORE INTO documents (organization_id, title, description, doc_type, version, owner, status, classification, linked_module, review_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      for (const doc of data.documents) {
        try {
          await insertDoc.run(req.orgId, doc.title, doc.description || '', doc.doc_type || 'policy', doc.version || '1.0',
            doc.owner || '', doc.status || 'draft', doc.classification || 'internal',
            doc.linked_module || '', doc.review_date || null);
          count++;
        } catch (e) { /* Skip duplicates */ }
      }
      result.imported.documents = count;
    }

    // Import audits
    if (data.audits && Array.isArray(data.audits)) {
      let count = 0;
      const insertAudit = db.prepare(`
        INSERT OR IGNORE INTO audits (organization_id, title, standard, lead_auditor, scope, status, planned_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      for (const audit of data.audits) {
        try {
          await insertAudit.run(req.orgId, audit.title, audit.standard || '', audit.lead_auditor || '',
            audit.scope || '', audit.status || 'planned', audit.planned_date || audit.scheduled_date || null);
          count++;
        } catch (e) { /* Skip duplicates */ }
      }
      result.imported.audits = count;
    }

    await logAuditAction(null, 'System', 'data_imported', 'system', null, null, JSON.stringify(result.imported), req.orgId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Test Webhook
app.post('/api/admin/webhooks/:id/test', requireAdmin, async (req, res) => {
  const webhook = await db.prepare('SELECT * FROM webhooks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

  const testPayload = {
    event: 'test',
    timestamp: new Date().toISOString(),
    organization_id: req.orgId,
    data: {
      message: 'This is a test webhook from Let The Frame Work',
      webhook_id: webhook.id,
      webhook_name: webhook.name,
      configured_events: (() => { try { return JSON.parse(webhook.events || '[]'); } catch { return []; } })(),
    },
  };

  try {
    const payload = JSON.stringify(testPayload);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent': 'LetTheFrameWork/1.0',
    };
    if (webhook.secret) {
      headers['X-Webhook-Signature'] = 'sha256=' + crypto.createHmac('sha256', webhook.secret).update(payload).digest('hex');
    }

    const validated = await validateWebhookUrl(webhook.url);
    const result = await sendValidatedWebhook(validated, payload, headers);

    // Update last triggered
    await db.prepare("UPDATE webhooks SET last_triggered = datetime('now') WHERE id = ? AND organization_id = ?").run(webhook.id, req.orgId);

    res.json({ success: true, statusCode: result.statusCode, response: result.body });
  } catch (err) {
    // Increment failure count
    await db.prepare("UPDATE webhooks SET failure_count = failure_count + 1 WHERE id = ? AND organization_id = ?").run(webhook.id, req.orgId);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Reset Webhook Failures
app.post('/api/admin/webhooks/:id/reset-failures', requireAdmin, async (req, res) => {
  const webhook = await db.prepare('SELECT * FROM webhooks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

  await db.prepare("UPDATE webhooks SET failure_count = 0 WHERE id = ? AND organization_id = ?").run(req.params.id, req.orgId);
  res.json({ success: true });
});

// ===== SAML/SSO ENDPOINTS =====

// ---------------------------------------------------------------------------
// SAML signature verification
// Verifies the ds:Signature inside a decoded SAMLResponse XML using the
// configured IdP certificate (PEM). Supports RSA-SHA256 and RSA-SHA1.
//
// Note: canonicalization (C14N) is not implemented here. This works for
// well-formed responses from major IdPs (Entra ID, Okta, Google Workspace)
// that produce canonical SignedInfo bytes before signing. For strict
// production compliance, consider 'saml2-js' or 'passport-saml'.
// ---------------------------------------------------------------------------
function verifySamlSignature(decodedXml, certPem) {
  // Extract <ds:SignatureValue>
  const sigValueMatch = decodedXml.match(
    /<(?:[^:>\s]+:)?SignatureValue[^>]*>\s*([\s\S]+?)\s*<\/(?:[^:>\s]+:)?SignatureValue>/
  );
  if (!sigValueMatch) return { valid: false, reason: 'No SignatureValue found' };
  const sigBytes = Buffer.from(sigValueMatch[1].replace(/\s+/g, ''), 'base64');

  // Extract <ds:SignedInfo>
  const signedInfoMatch = decodedXml.match(
    /(<(?:[^:>\s]+:)?SignedInfo[\s\S]+?<\/(?:[^:>\s]+:)?SignedInfo>)/
  );
  if (!signedInfoMatch) return { valid: false, reason: 'No SignedInfo element found' };
  const signedInfo = signedInfoMatch[1];

  // Normalise PEM format
  let pem = certPem.trim();
  if (!pem.startsWith('-----BEGIN')) {
    pem = `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----`;
  }

  // Determine hash algorithm from the <ds:SignatureMethod> URI
  const algoMatch = signedInfo.match(/Algorithm="([^"]+)"/);
  const algoUri = algoMatch?.[1] || '';
  const hashAlgo = algoUri.includes('sha512') ? 'SHA512'
    : algoUri.includes('sha1') || algoUri.includes('SHA1') ? 'SHA1'
    : 'SHA256'; // default to SHA256

  // Attempt verification; try both raw bytes and CRLF-normalised form
  for (const candidate of [signedInfo, signedInfo.replace(/\r\n|\r/g, '\n')]) {
    try {
      const verify = crypto.createVerify(`RSA-${hashAlgo}`);
      verify.update(candidate, 'utf8');
      if (verify.verify(pem, sigBytes)) return { valid: true };
    } catch (_) { /* try next */ }
  }

  return { valid: false, reason: `RSA-${hashAlgo} signature did not match configured certificate` };
}

// SAML config is initialized in db.js seedSQLiteData()/seedPostgresData()

// Get SAML configuration (org-scoped: admins only see their own org's config)
app.get('/api/admin/saml/config', requireAdmin, async (req, res) => {
  const config = await db.prepare(
    'SELECT * FROM saml_config WHERE organization_id = $1'
  ).get(req.orgId)
    ?? await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();

  if (config) {
    config.has_certificate = !!(config.certificate);
    config.certificate = config.certificate ? '[CONFIGURED]' : '';
  }
  res.json(config || {});
});

// Update SAML configuration (org-scoped UPSERT)
app.put('/api/admin/saml/config', requireAdmin, async (req, res) => {
  const {
    enabled, entity_id, sso_url, slo_url, certificate,
    name_id_format, attribute_mapping, auto_provision,
    default_role, allowed_domains
  } = req.body;

  const current = await db.prepare(
    'SELECT * FROM saml_config WHERE organization_id = $1'
  ).get(req.orgId)
    ?? await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();

  const certToStore = certificate && certificate !== '[CONFIGURED]'
    ? certificate
    : (current?.certificate || '');

  const attrMappingJson = typeof attribute_mapping === 'object'
    ? JSON.stringify(attribute_mapping)
    : (attribute_mapping || '{}');

  if (current && current.organization_id === req.orgId) {
    // Update the existing org-specific row
    await db.prepare(`
      UPDATE saml_config SET
        enabled = $1, entity_id = $2, sso_url = $3, slo_url = $4, certificate = $5,
        name_id_format = $6, attribute_mapping = $7, auto_provision = $8,
        default_role = $9, allowed_domains = $10, updated_at = NOW()
      WHERE organization_id = $11
    `).run(
      enabled ? 1 : 0, entity_id || '', sso_url || '', slo_url || '', certToStore,
      name_id_format || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      attrMappingJson, auto_provision ? 1 : 0,
      default_role || 'org_user', allowed_domains || '', req.orgId
    );
  } else {
    // Associate the singleton row with this org (or insert a new org-specific row)
    await db.prepare(`
      UPDATE saml_config SET
        organization_id = $1, enabled = $2, entity_id = $3, sso_url = $4,
        slo_url = $5, certificate = $6, name_id_format = $7, attribute_mapping = $8,
        auto_provision = $9, default_role = $10, allowed_domains = $11, updated_at = NOW()
      WHERE id = 1
    `).run(
      req.orgId, enabled ? 1 : 0, entity_id || '', sso_url || '', slo_url || '', certToStore,
      name_id_format || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      attrMappingJson, auto_provision ? 1 : 0,
      default_role || 'org_user', allowed_domains || ''
    );
  }

  await logAuditAction(req.session.userId, 'Admin', 'saml_config_updated', 'saml', 1, null, `Enabled: ${enabled}`, req.orgId);
  res.json({ success: true });
});

// Generate Service Provider metadata
app.get('/saml/metadata', async (req, res) => {
  const config = await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  const metadata = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${baseUrl}/saml/metadata">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>${config?.name_id_format || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'}</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${baseUrl}/saml/callback" index="0" isDefault="true"/>
    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${baseUrl}/saml/logout"/>
  </md:SPSSODescriptor>
  <md:Organization>
    <md:OrganizationName xml:lang="en">Let The Frame Work</md:OrganizationName>
    <md:OrganizationDisplayName xml:lang="en">Let The Frame Work</md:OrganizationDisplayName>
    <md:OrganizationURL xml:lang="en">${baseUrl}</md:OrganizationURL>
  </md:Organization>
</md:EntityDescriptor>`;

  res.set('Content-Type', 'application/xml');
  res.send(metadata);
});

// Initiate SAML login
// Accepts ?org=<orgId> to select the right SAML configuration in multi-org setups.
// The orgId is forwarded as RelayState so the callback can look up the same config.
app.get('/saml/login', async (req, res) => {
  const orgId = req.query.org ? parseInt(req.query.org, 10) : null;

  // Look up config: prefer org-specific row, fall back to the singleton (id = 1)
  const config = orgId
    ? await db.prepare('SELECT * FROM saml_config WHERE organization_id = $1 AND enabled = 1').get(orgId)
      ?? await db.prepare('SELECT * FROM saml_config WHERE id = 1').get()
    : await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();

  if (!config || !config.enabled) {
    return res.status(400).send('SAML SSO is not enabled for this organisation');
  }
  if (!config.sso_url || !config.entity_id) {
    return res.status(400).send('SAML is not properly configured (missing SSO URL or Entity ID)');
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const requestId = '_' + crypto.randomBytes(16).toString('hex');
  const issueInstant = new Date().toISOString();
  const relayState = String(orgId || config.organization_id || '');

  const authnRequest = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
    ID="${requestId}"
    Version="2.0"
    IssueInstant="${issueInstant}"
    Destination="${config.sso_url}"
    AssertionConsumerServiceURL="${baseUrl}/saml/callback"
    ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
  <saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${baseUrl}/saml/metadata</saml:Issuer>
  <samlp:NameIDPolicy Format="${config.name_id_format}" AllowCreate="true"/>
</samlp:AuthnRequest>`;

  // SAML HTTP-Redirect binding requires deflateRaw + base64 (NOT plain base64)
  const deflated = await deflateRaw(Buffer.from(authnRequest, 'utf8'));
  const encodedRequest = deflated.toString('base64');

  const redirectUrl = new URL(config.sso_url);
  redirectUrl.searchParams.set('SAMLRequest', encodedRequest);
  if (relayState) redirectUrl.searchParams.set('RelayState', relayState);

  res.redirect(redirectUrl.toString());
});

// Handle SAML callback (Assertion Consumer Service)
app.post('/saml/callback', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const samlResponse = req.body.SAMLResponse;
    const relayState   = req.body.RelayState || '';

    if (!samlResponse) {
      return res.status(400).send('No SAML response received');
    }

    // Resolve the correct SAML config: prefer org from RelayState, fall back to singleton
    const relayOrgId = parseInt(relayState, 10) || null;
    const config = (relayOrgId
      ? await db.prepare('SELECT * FROM saml_config WHERE organization_id = $1').get(relayOrgId)
      : null)
      ?? await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();

    if (!config || !config.enabled) {
      return res.status(400).send('SAML SSO is not enabled for this organisation');
    }

    // Decode the SAMLResponse (POST binding = plain base64, no deflate)
    const decodedResponse = Buffer.from(samlResponse, 'base64').toString('utf8');

    // --- Signature validation ---
    if (config.certificate) {
      const sigResult = verifySamlSignature(decodedResponse, config.certificate);
      if (!sigResult.valid) {
        console.error('[SAML] Signature verification failed:', sigResult.reason);
        return res.status(403).send(`SAML signature verification failed: ${sigResult.reason}`);
      }
    } else {
      console.warn('[SAML] No certificate configured – skipping signature verification');
    }

    // --- Extract user attributes via attribute-name patterns ---
    const emailMatch =
      decodedResponse.match(/<(?:[^:>\s]+:)?Attribute[^>]+Name="[^"]*email[^"]*"[^>]*>[\s\S]*?<(?:[^:>\s]+:)?AttributeValue[^>]*>([^<]+)/i) ||
      decodedResponse.match(/<(?:[^:>\s]+:)?NameID[^>]*>([^<]+)/);
    const nameMatch =
      decodedResponse.match(/<(?:[^:>\s]+:)?Attribute[^>]+Name="[^"]*(?:displayname|name|givenname)[^"]*"[^>]*>[\s\S]*?<(?:[^:>\s]+:)?AttributeValue[^>]*>([^<]+)/i);

    let email = emailMatch?.[2] ?? emailMatch?.[1] ?? null;
    let name  = nameMatch?.[1] ?? null;

    if (!email) return res.status(400).send('Could not extract email from SAML assertion');

    email = email.trim().toLowerCase();
    name  = name ? name.trim() : email.split('@')[0];

    // --- Domain allowlist ---
    if (config.allowed_domains) {
      const allowed = config.allowed_domains.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
      const domain  = email.split('@')[1];
      if (allowed.length > 0 && !allowed.includes(domain)) {
        return res.status(403).send('Your email domain is not permitted to access this application');
      }
    }

    const orgId = config.organization_id;

    // --- Find or auto-provision user ---
    let user = await db.prepare('SELECT * FROM users WHERE email = $1').get(email);

    if (!user && config.auto_provision) {
      // Create user linked to the org that owns this SAML config
      const result = await db.prepare(`
        INSERT INTO users (name, email, role, permissions, status, sso_provider, organization_id)
        VALUES ($1, $2, $3, $4, 'active', 'saml', $5)
      `).run(name, email, config.default_role || 'org_user',
             JSON.stringify(['org', 'risk', 'ops', 'audit']), orgId);

      user = await db.prepare('SELECT * FROM users WHERE id = $1').get(result.lastInsertRowid);
      await logAuditAction(user.id, user.name, 'user_provisioned_saml', 'user', user.id, user.name, '', orgId);
    } else if (!user) {
      return res.status(403).send('User not found and auto-provisioning is disabled');
    } else {
      await db.prepare("UPDATE users SET last_active = NOW() WHERE id = $1").run(user.id);
    }

    // --- Record SAML session (for SLO / audit trail) ---
    const samlSessionId = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await db.prepare(`
      INSERT INTO saml_sessions (id, user_id, name_id, expires_at)
      VALUES ($1, $2, $3, $4)
    `).run(samlSessionId, user.id, email, expiresAt);

    await logAuditAction(user.id, user.name, 'saml_login', 'user', user.id, user.name, '', orgId);

    // --- Establish a standard cookie-JWT session ---
    // This integrates with the existing requireOrgContext / requireAdmin middleware
    // so no special handling is needed anywhere else in the app.
    req.session.userId         = user.id;
    req.session.userRole       = user.role;
    req.session.organizationId = user.organization_id || orgId;
    req.session.activeOrgId    = user.organization_id || orgId;
    req.session.save();

    res.redirect('/');

  } catch (err) {
    console.error('[SAML] Callback error:', err);
    res.status(500).send('Error processing SAML response. Please contact your administrator.');
  }
});

// SAML logout – clears both the cookie-JWT session and the saml_sessions record
app.get('/saml/logout', async (req, res) => {
  // Clear the standard session cookie so requireOrgContext stops accepting the user
  req.session.destroy();

  // Also clean up the saml_sessions record if a session id was provided
  // (used when the IdP initiates SLO and passes the session back via query param)
  const samlSessionId = req.query.session || req.query.sid;
  if (samlSessionId) {
    const samlSess = await db.prepare('SELECT * FROM saml_sessions WHERE id = $1').get(samlSessionId);
    if (samlSess) {
      await db.prepare('DELETE FROM saml_sessions WHERE id = $1').run(samlSessionId);
      const u = await db.prepare('SELECT organization_id FROM users WHERE id = $1').get(samlSess.user_id);
      await logAuditAction(samlSess.user_id, 'User', 'saml_logout', 'user', samlSess.user_id, samlSess.name_id, '', u?.organization_id ?? null);
    }
  }

  res.redirect('/login');
});

// Validate SAML session
app.get('/api/auth/session', async (req, res) => {
  const sessionId = req.headers['x-saml-session'];
  if (!sessionId) {
    return res.json({ authenticated: false });
  }

  const session = await db.prepare(`
    SELECT s.*, u.name, u.email, u.role, u.permissions
    FROM saml_sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).get(sessionId);

  if (!session) {
    return res.json({ authenticated: false });
  }

  res.json({
    authenticated: true,
    user: {
      id: session.user_id,
      name: session.name,
      email: session.email,
      role: session.role,
      permissions: JSON.parse(session.permissions || '[]')
    }
  });
});

// Test SAML configuration
app.post('/api/admin/saml/test', requireAdmin, async (req, res) => {
  const config = await db.prepare('SELECT * FROM saml_config WHERE organization_id = $1').get(req.orgId)
    ?? await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();

  const issues = [];
  if (!config.entity_id) issues.push('Identity Provider Entity ID is not configured');
  if (!config.sso_url) issues.push('SSO URL is not configured');
  if (!config.certificate) issues.push('IdP Certificate is not configured');

  if (issues.length > 0) {
    return res.json({ success: false, issues });
  }

  // Validate certificate format
  if (!config.certificate.includes('BEGIN CERTIFICATE')) {
    issues.push('Certificate does not appear to be in PEM format');
  }

  // Validate URL format
  try {
    new URL(config.sso_url);
  } catch {
    issues.push('SSO URL is not a valid URL');
  }

  if (issues.length > 0) {
    return res.json({ success: false, issues });
  }

  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    success: true,
    message: 'SAML configuration appears valid. Test login to verify full functionality.',
    metadata_url: `${base}/saml/metadata`,
    callback_url: `${base}/saml/callback`,
    login_url: `${base}/saml/login?org=${req.orgId}`,
  });
});

// ============================================================
// Management Reviews (ISO 9.3)
// ============================================================

function generateMgmtReviewHtml(review, inputs, outputs) {
  const inputsByCategory = {};
  for (const inp of inputs) inputsByCategory[inp.category] = inp.content || '';

  const categories = [
    'previous_actions', 'internal_external_issues', 'customer_feedback',
    'process_performance', 'nonconformities', 'audit_results',
    'supplier_performance', 'risk_opportunities', 'kpi_performance',
    'resource_adequacy', 'improvement_opportunities',
  ];
  const categoryLabels = {
    previous_actions: 'Status of previous management review actions',
    internal_external_issues: 'Internal and external issues relevant to the management system',
    customer_feedback: 'Customer feedback and complaints',
    process_performance: 'Process performance and product/service conformity',
    nonconformities: 'Nonconformities and corrective actions',
    audit_results: 'Audit results',
    supplier_performance: 'Supplier and external provider performance',
    risk_opportunities: 'Risks and opportunities (risk register updates)',
    kpi_performance: 'KPI and objective performance',
    resource_adequacy: 'Adequacy of resources',
    improvement_opportunities: 'Opportunities for improvement',
  };

  let attendeesHtml = '';
  try {
    const atts = JSON.parse(review.attendees || '[]');
    attendeesHtml = atts.map(a => `<li>${a}</li>`).join('');
  } catch {}

  let outputsHtml = '';
  if (outputs.length) {
    outputsHtml = `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">
      <thead><tr><th>Type</th><th>Description</th><th>Assigned To</th><th>Due Date</th><th>Status</th></tr></thead>
      <tbody>${outputs.map(o => `<tr>
        <td>${o.type}</td>
        <td>${o.description || ''}</td>
        <td>${o.assigned_to || ''}</td>
        <td>${o.due_date || ''}</td>
        <td>${o.status}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  } else {
    outputsHtml = '<p><em>No outputs recorded.</em></p>';
  }

  let inputsSections = categories.map(cat => `
    <h3>${categoryLabels[cat]}</h3>
    <div style="white-space:pre-wrap;background:#f9f9f9;padding:10px;border-radius:4px">${inputsByCategory[cat] || '<em>Not recorded</em>'}</div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Management Review Report – ${review.title || ''}</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 900px; margin: 40px auto; color: #222; }
    h1 { color: #1a56db; border-bottom: 2px solid #1a56db; padding-bottom: 8px; }
    h2 { margin-top: 32px; color: #374151; }
    h3 { margin-top: 20px; color: #555; font-size: 1em; }
    table { border-collapse: collapse; width: 100%; }
    th { background: #f3f4f6; }
    .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; margin: 16px 0; }
    .meta-item label { font-weight: bold; font-size: 0.85em; color: #666; }
    .meta-item p { margin: 2px 0; }
  </style>
</head>
<body>
  <h1>Management Review Report</h1>
  <div class="meta-grid">
    <div class="meta-item"><label>Title</label><p>${review.title || ''}</p></div>
    <div class="meta-item"><label>Review Date</label><p>${review.review_date || ''}</p></div>
    <div class="meta-item"><label>Chairperson</label><p>${review.chairperson || ''}</p></div>
    <div class="meta-item"><label>Status</label><p>${review.status}</p></div>
    <div class="meta-item"><label>Next Review Date</label><p>${review.next_review_date || '—'}</p></div>
    <div class="meta-item"><label>Generated</label><p>${new Date().toISOString().split('T')[0]}</p></div>
  </div>
  <h2>Attendees</h2>
  <ul>${attendeesHtml || '<li><em>None recorded</em></li>'}</ul>
  <h2>Summary</h2>
  <div style="white-space:pre-wrap">${review.summary || '<em>No summary provided.</em>'}</div>
  <h2>Review Inputs (ISO 9.3.2)</h2>
  ${inputsSections}
  <h2>Review Outputs (ISO 9.3.3)</h2>
  ${outputsHtml}
  <hr style="margin-top:40px">
  <p style="font-size:0.8em;color:#888">Generated by Let The Frame Work · ${new Date().toISOString()}</p>
</body>
</html>`;
}

// List management reviews
app.get('/api/management-reviews', requireOrgContext, async (req, res) => {
  const rows = await db.prepare(
    'SELECT * FROM management_reviews WHERE organization_id = ? ORDER BY review_date DESC, created_at DESC'
  ).all(req.orgId);
  res.json(rows);
});

// Get single review (with inputs and outputs)
app.get('/api/management-reviews/:id', requireOrgContext, async (req, res) => {
  const review = await db.prepare(
    'SELECT * FROM management_reviews WHERE id = ? AND organization_id = ?'
  ).get(req.params.id, req.orgId);
  if (!review) return res.status(404).json({ error: 'Not found' });

  const inputs = await db.prepare(
    'SELECT * FROM management_review_inputs WHERE review_id = ? AND organization_id = ? ORDER BY category'
  ).all(req.params.id, req.orgId);

  const outputs = await db.prepare(
    'SELECT * FROM management_review_outputs WHERE review_id = ? AND organization_id = ? ORDER BY created_at'
  ).all(req.params.id, req.orgId);

  res.json({ review, inputs, outputs });
});

// Create management review
app.post('/api/management-reviews', requireOrgContext, async (req, res) => {
  const { title, review_date, status, chairperson, attendees, next_review_date, summary } = req.body;
  if (!title || !review_date) return res.status(400).json({ error: 'title and review_date are required' });
  const result = await db.prepare(
    `INSERT INTO management_reviews (organization_id, title, review_date, status, chairperson, attendees, next_review_date, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.orgId, title, review_date, status || 'scheduled', chairperson || '', JSON.stringify(attendees || []), next_review_date || null, summary || '');
  const created = await db.prepare('SELECT * FROM management_reviews WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(created);
});

// Update management review
app.put('/api/management-reviews/:id', requireOrgContext, async (req, res) => {
  const existing = await db.prepare(
    'SELECT * FROM management_reviews WHERE id = ? AND organization_id = ?'
  ).get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const fields = ['title', 'review_date', 'status', 'chairperson', 'next_review_date', 'summary'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (req.body.attendees !== undefined) { updates.push('attendees = ?'); params.push(JSON.stringify(req.body.attendees)); }
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id, req.orgId);
  await db.prepare(`UPDATE management_reviews SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params);
  const updated = await db.prepare('SELECT * FROM management_reviews WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Delete management review
app.delete('/api/management-reviews/:id', requireOrgContext, async (req, res) => {
  const existing = await db.prepare(
    'SELECT * FROM management_reviews WHERE id = ? AND organization_id = ?'
  ).get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM management_reviews WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
  res.json({ success: true });
});

// Upsert input for a category
app.put('/api/management-reviews/:id/inputs/:category', requireOrgContext, async (req, res) => {
  const { id, category } = req.params;
  const review = await db.prepare(
    'SELECT id FROM management_reviews WHERE id = ? AND organization_id = ?'
  ).get(id, req.orgId);
  if (!review) return res.status(404).json({ error: 'Review not found' });

  const { content } = req.body;
  const existing = await db.prepare(
    'SELECT id FROM management_review_inputs WHERE review_id = ? AND category = ?'
  ).get(id, category);

  if (existing) {
    await db.prepare(
      "UPDATE management_review_inputs SET content = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(content || '', existing.id);
  } else {
    await db.prepare(
      'INSERT INTO management_review_inputs (organization_id, review_id, category, content) VALUES (?, ?, ?, ?)'
    ).run(req.orgId, id, category, content || '');
  }
  const row = await db.prepare(
    'SELECT * FROM management_review_inputs WHERE review_id = ? AND category = ?'
  ).get(id, category);
  res.json(row);
});

// List outputs for a review
app.get('/api/management-reviews/:id/outputs', requireOrgContext, async (req, res) => {
  const review = await db.prepare(
    'SELECT id FROM management_reviews WHERE id = ? AND organization_id = ?'
  ).get(req.params.id, req.orgId);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  const outputs = await db.prepare(
    'SELECT * FROM management_review_outputs WHERE review_id = ? AND organization_id = ? ORDER BY created_at'
  ).all(req.params.id, req.orgId);
  res.json(outputs);
});

// Create output
app.post('/api/management-reviews/:id/outputs', requireOrgContext, async (req, res) => {
  const review = await db.prepare(
    'SELECT id FROM management_reviews WHERE id = ? AND organization_id = ?'
  ).get(req.params.id, req.orgId);
  if (!review) return res.status(404).json({ error: 'Review not found' });

  const { type, description, assigned_to, due_date, status } = req.body;
  if (!description) return res.status(400).json({ error: 'description is required' });
  const result = await db.prepare(
    'INSERT INTO management_review_outputs (organization_id, review_id, type, description, assigned_to, due_date, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.orgId, req.params.id, type || 'improvement', description, assigned_to || '', due_date || null, status || 'open');
  const created = await db.prepare('SELECT * FROM management_review_outputs WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(created);
});

// Update output
app.put('/api/management-reviews/:id/outputs/:outputId', requireOrgContext, async (req, res) => {
  const existing = await db.prepare(
    'SELECT * FROM management_review_outputs WHERE id = ? AND review_id = ? AND organization_id = ?'
  ).get(req.params.outputId, req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Output not found' });

  const fields = ['type', 'description', 'assigned_to', 'due_date', 'status', 'linked_action_id'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  updates.push("updated_at = datetime('now')");
  params.push(req.params.outputId, req.orgId);
  await db.prepare(`UPDATE management_review_outputs SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params);
  const updated = await db.prepare('SELECT * FROM management_review_outputs WHERE id = ?').get(req.params.outputId);
  res.json(updated);
});

// Delete output
app.delete('/api/management-reviews/:id/outputs/:outputId', requireOrgContext, async (req, res) => {
  const existing = await db.prepare(
    'SELECT * FROM management_review_outputs WHERE id = ? AND review_id = ? AND organization_id = ?'
  ).get(req.params.outputId, req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Output not found' });
  await db.prepare('DELETE FROM management_review_outputs WHERE id = ? AND organization_id = ?').run(req.params.outputId, req.orgId);
  res.json({ success: true });
});

// Push output to Actions module
app.post('/api/management-reviews/:id/outputs/:outputId/push-to-actions', requireOrgContext, async (req, res) => {
  const output = await db.prepare(
    'SELECT * FROM management_review_outputs WHERE id = ? AND review_id = ? AND organization_id = ?'
  ).get(req.params.outputId, req.params.id, req.orgId);
  if (!output) return res.status(404).json({ error: 'Output not found' });

  const review = await db.prepare('SELECT title FROM management_reviews WHERE id = ?').get(req.params.id);

  const actionResult = await db.prepare(
    `INSERT INTO actions (organization_id, title, description, assignee, priority, status, due_date)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`
  ).run(
    req.orgId,
    output.description,
    `Output from Management Review: ${review ? review.title : ''}`,
    output.assigned_to || '',
    'Medium',
    output.due_date || null
  );

  await db.prepare(
    "UPDATE management_review_outputs SET linked_action_id = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(actionResult.lastInsertRowid, output.id);

  const updated = await db.prepare('SELECT * FROM management_review_outputs WHERE id = ?').get(output.id);
  res.json({ success: true, action_id: actionResult.lastInsertRowid, output: updated });
});

// Generate report
app.post('/api/management-reviews/:id/generate-report', requireOrgContext, async (req, res) => {
  const review = await db.prepare(
    'SELECT * FROM management_reviews WHERE id = ? AND organization_id = ?'
  ).get(req.params.id, req.orgId);
  if (!review) return res.status(404).json({ error: 'Review not found' });

  const inputs = await db.prepare(
    'SELECT * FROM management_review_inputs WHERE review_id = ? AND organization_id = ?'
  ).all(req.params.id, req.orgId);
  const outputs = await db.prepare(
    'SELECT * FROM management_review_outputs WHERE review_id = ? AND organization_id = ?'
  ).all(req.params.id, req.orgId);

  const reportHtml = generateMgmtReviewHtml(review, inputs, outputs);

  await db.prepare(
    "UPDATE management_reviews SET report_html = ?, status = 'completed', updated_at = datetime('now') WHERE id = ?"
  ).run(reportHtml, review.id);

  // Create or update document record
  let docId = review.report_doc_id;
  if (!docId) {
    const docResult = await db.prepare(
      `INSERT INTO documents (organization_id, title, description, doc_type, version, owner, status, file_name, file_path, file_size, mime_type, linked_module, linked_ref_type, linked_ref_id, review_date, classification)
       VALUES (?, ?, ?, 'report', '1.0', ?, 'approved', '', '', 0, 'text/html', 'management_review', 'management_review', ?, NULL, '')`
    ).run(
      req.orgId,
      `Management Review Report – ${review.title}`,
      `Auto-generated report for management review: ${review.title}`,
      review.chairperson || '',
      review.id
    );
    docId = docResult.lastInsertRowid;
    await db.prepare("UPDATE management_reviews SET report_doc_id = ?, updated_at = datetime('now') WHERE id = ?").run(docId, review.id);
  } else {
    await db.prepare("UPDATE documents SET updated_at = datetime('now') WHERE id = ?").run(docId);
  }

  res.json({ success: true, doc_id: docId, report_html: reportHtml });
});

// Upload a client-generated PDF report for a management review and attach it to Document Control
app.post('/api/management-reviews/:id/upload-report', requireOrgContext, uploadPdf.single('pdf'), async (req, res) => {
  const review = await db.prepare(
    'SELECT * FROM management_reviews WHERE id = ? AND organization_id = ?'
  ).get(req.params.id, req.orgId);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  if (!req.file) return res.status(400).json({ error: 'No PDF file provided' });

  let filePath = '';
  let fileSize = req.file.size;
  try {
    const fileObj = {
      originalname: `management-review-${review.id}.pdf`,
      buffer: req.file.buffer,
      mimetype: 'application/pdf',
    };
    filePath = await uploadToSupabase('reports', fileObj);
  } catch (uploadErr) {
    console.warn('Supabase upload failed, storing reference only:', uploadErr.message);
    // Continue without Supabase – document record still created
  }

  // Mark review complete and save a plain-text marker in report_html
  await db.prepare(
    "UPDATE management_reviews SET status = 'completed', report_html = '[PDF]', updated_at = datetime('now') WHERE id = ?"
  ).run(review.id);

  // Create or update document record
  let docId = review.report_doc_id;
  const docTitle = `Management Review Report – ${review.title}`;
  if (!docId) {
    const docResult = await db.prepare(
      `INSERT INTO documents (organization_id, title, description, doc_type, version, owner, status,
        file_name, file_path, file_size, mime_type, linked_module, linked_ref_type, linked_ref_id,
        review_date, classification)
       VALUES (?, ?, ?, 'report', '1.0', ?, 'approved', ?, ?, ?, 'application/pdf',
               'management_review', 'management_review', ?, NULL, '')`
    ).run(
      req.orgId,
      docTitle,
      `Auto-generated PDF report for management review: ${review.title}`,
      review.chairperson || '',
      `management-review-${review.id}.pdf`,
      filePath,
      fileSize,
      review.id
    );
    docId = docResult.lastInsertRowid;
    await db.prepare(
      "UPDATE management_reviews SET report_doc_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(docId, review.id);
  } else {
    await db.prepare(
      "UPDATE documents SET file_path = ?, file_size = ?, file_name = ?, mime_type = 'application/pdf', updated_at = datetime('now') WHERE id = ?"
    ).run(filePath, fileSize, `management-review-${review.id}.pdf`, docId);
  }

  // Auto-cross-link: 'document' < 'management_review' alphabetically → document is source
  await db.prepare(
    'INSERT OR IGNORE INTO cross_links (organization_id, source_type, source_id, target_type, target_id) VALUES (?, ?, ?, ?, ?)'
  ).run(req.orgId, 'document', docId, 'management_review', review.id);

  res.json({ success: true, doc_id: docId });
});

// Reference data for auto-populating management review input categories
app.get('/api/management-reviews/:id/reference-data', requireOrgContext, async (req, res) => {
  const review = await db.prepare(
    'SELECT id, review_date FROM management_reviews WHERE id = ? AND organization_id = ?'
  ).get(req.params.id, req.orgId);
  if (!review) return res.status(404).json({ error: 'Review not found' });

  // Previous review outputs still open (from all OTHER reviews in the org)
  const prevOutputs = await db.prepare(
    `SELECT o.*, mr.title AS review_title, mr.review_date
     FROM management_review_outputs o
     JOIN management_reviews mr ON o.review_id = mr.id
     WHERE o.organization_id = ? AND o.review_id != ? AND o.status IN ('open','in_progress')
     ORDER BY mr.review_date DESC, o.created_at DESC LIMIT 20`
  ).all(req.orgId, req.params.id);

  const openActions = await db.prepare(
    `SELECT id, title, assignee, priority, status, due_date
     FROM actions WHERE organization_id = ? AND status NOT IN ('resolved','closed')
     ORDER BY due_date ASC NULLS LAST LIMIT 30`
  ).all(req.orgId);

  const openNcrs = await db.prepare(
    `SELECT n.id, n.clause, n.description, n.severity, n.responsible, n.status, n.due_date,
            a.title AS audit_title
     FROM non_conformities n JOIN audits a ON n.audit_id = a.id
     WHERE n.organization_id = ? AND n.status NOT IN ('closed','verified')
     ORDER BY n.due_date ASC NULLS LAST LIMIT 25`
  ).all(req.orgId);

  const allNcrs = await db.prepare(
    `SELECT n.id, n.clause, n.description, n.severity, n.responsible, n.status, n.due_date,
            a.title AS audit_title
     FROM non_conformities n JOIN audits a ON n.audit_id = a.id
     WHERE n.organization_id = ?
     ORDER BY n.due_date ASC NULLS LAST LIMIT 50`
  ).all(req.orgId);

  const recentAudits = await db.prepare(
    `SELECT id, title, standard, status, lead_auditor, planned_date, completed_date,
            (SELECT COUNT(*) FROM non_conformities nc WHERE nc.audit_id = audits.id AND nc.status NOT IN ('closed','verified')) AS open_ncr_count
     FROM audits WHERE organization_id = ? ORDER BY planned_date DESC NULLS LAST LIMIT 10`
  ).all(req.orgId);

  const kpis = await db.prepare(
    `SELECT k.id, k.name, k.description, k.target_value, k.unit, k.frequency,
            (SELECT value FROM org_kpi_values WHERE kpi_id = k.id ORDER BY recorded_at DESC LIMIT 1) AS latest_value,
            (SELECT period FROM org_kpi_values WHERE kpi_id = k.id ORDER BY recorded_at DESC LIMIT 1) AS latest_period
     FROM org_kpis k WHERE k.organization_id = ? ORDER BY k.name`
  ).all(req.orgId);

  const openRisks = await db.prepare(
    `SELECT id, title, category, likelihood, impact, inherent_score, risk_owner, status
     FROM risks WHERE organization_id = ? AND status NOT IN ('accepted','closed')
     ORDER BY inherent_score DESC LIMIT 20`
  ).all(req.orgId);

  const riskTreatments = await db.prepare(
    `SELECT rt.id, rt.description, rt.treatment_type, rt.status, rt.responsible, rt.due_date,
            r.title AS risk_title, r.inherent_score
     FROM risk_treatments rt JOIN risks r ON rt.risk_id = r.id
     WHERE r.organization_id = ? AND r.status NOT IN ('accepted','closed')
     ORDER BY r.inherent_score DESC, rt.created_at ASC LIMIT 40`
  ).all(req.orgId);

  const suppliers = await db.prepare(
    `SELECT id, name, category, criticality, contract_status, dpa_in_place,
            remediation_status, next_review_date, status
     FROM suppliers WHERE organization_id = ? AND status != 'offboarded'
     ORDER BY criticality DESC, name ASC LIMIT 50`
  ).all(req.orgId);

  const mission = await db.prepare(
    'SELECT content, vision, values_text, legal_entities FROM org_mission WHERE organization_id = ? LIMIT 1'
  ).get(req.orgId);

  const archItems = await db.prepare(
    `SELECT id, name, arch_type, owner, status, description, metadata
     FROM org_architecture WHERE organization_id = ? AND status = 'active'`
  ).all(req.orgId);

  res.json({ prevOutputs, openActions, openNcrs, allNcrs, recentAudits, kpis, openRisks, riskTreatments, suppliers, mission, archItems });
});

// Download management review report (served as HTML)
app.get('/api/management-reviews/:id/report', requireOrgContext, async (req, res) => {
  const review = await db.prepare(
    'SELECT * FROM management_reviews WHERE id = ? AND organization_id = ?'
  ).get(req.params.id, req.orgId);
  if (!review || !review.report_html) return res.status(404).json({ error: 'Report not generated yet' });
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename="management-review-${review.id}.html"`);
  res.send(review.report_html);
});

// ── Suppliers ──────────────────────────────────────────────────────────────────

app.get('/api/suppliers', requireOrgContext, async (req, res) => {
  const rows = await db.prepare(
    'SELECT * FROM suppliers WHERE organization_id = ? ORDER BY name ASC'
  ).all(req.orgId);
  res.json(rows);
});

app.get('/api/suppliers/:id', requireOrgContext, async (req, res) => {
  const row = await db.prepare(
    'SELECT * FROM suppliers WHERE id = ? AND organization_id = ?'
  ).get(req.params.id, req.orgId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/suppliers', requireOrgContext, async (req, res) => {
  const {
    name, category = 'other', criticality = 'medium', services_provided = '',
    data_classification = '', contract_status = 'current', contract_expiry_date = null,
    dpa_in_place = 'no', dpa_review_date = null, gaps_identified = '',
    remediation_status = 'open', next_review_date = null, status = 'active',
    notes = '', metadata = '{}'
  } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const result = await db.prepare(`
    INSERT INTO suppliers
      (organization_id, name, category, criticality, services_provided, data_classification,
       contract_status, contract_expiry_date, dpa_in_place, dpa_review_date, gaps_identified,
       remediation_status, next_review_date, status, notes, metadata)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(req.orgId, name, category, criticality, services_provided, data_classification,
         contract_status, contract_expiry_date, dpa_in_place, dpa_review_date, gaps_identified,
         remediation_status, next_review_date, status, notes,
         typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
  const newRow = await db.prepare('SELECT * FROM suppliers WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(newRow);
});

app.put('/api/suppliers/:id', requireOrgContext, async (req, res) => {
  const existing = await db.prepare(
    'SELECT id FROM suppliers WHERE id = ? AND organization_id = ?'
  ).get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const fields = ['name','category','criticality','services_provided','data_classification',
    'contract_status','contract_expiry_date','dpa_in_place','dpa_review_date','gaps_identified',
    'remediation_status','next_review_date','status','notes','metadata'];
  const updates = [], params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(f === 'metadata' && typeof req.body[f] !== 'string'
        ? JSON.stringify(req.body[f]) : req.body[f]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = NOW()");
  await db.prepare(`UPDATE suppliers SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`)
    .run(...params, req.params.id, req.orgId);
  res.json(await db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id));
});

app.delete('/api/suppliers/:id', requireOrgContext, async (req, res) => {
  await db.prepare('DELETE FROM suppliers WHERE id = ? AND organization_id = ?')
    .run(req.params.id, req.orgId);
  res.json({ success: true });
});

// Database migrations and seeding are handled in db.js

// ===== AI AGENT =====
// Lazy-load the OpenAI client so the server starts fine without the API key.
let _openaiClient = null;
function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (_openaiClient) return _openaiClient;
  try {
    const { OpenAI } = require('openai');
    _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _openaiClient;
  } catch { return null; }
}

const AGENT_SYSTEM_PROMPT =
  'You are an AI assistant for BOP (Business Orchestration Platform), an ISO and compliance ' +
  'management system. You help users manage their compliance activities. You have full access to ' +
  "the organization's data and can read AND write records on behalf of the user. " +
  'You can: create and update risks, add risk treatments, create and close non-conformities, ' +
  'complete and update tasks, create and resolve actions, create and update audits, rate audit ' +
  'checklist items, and register documents. ' +
  'Always use the available tools to take real action — do not just describe what you would do. ' +
  'After taking an action, confirm what you did with a brief summary. ' +
  'Be professional, concise and compliance-focused. When unsure of an ID, first use a get_ tool to look it up.';

// Maps each agent tool to the permission string required to use it.
// Permission values mirror the users.permissions column: 'org', 'risk', 'ops', 'audit', 'admin'
const AGENT_TOOL_PERMISSIONS = {
  get_dashboard_summary:    'org',
  get_documents:            'org',
  create_document:          'org',
  get_open_actions:         'org',
  create_action:            'org',
  update_action:            'org',
  get_tasks:                'ops',
  create_task:              'ops',
  complete_task:            'ops',
  update_task:              'ops',
  get_risks:                'risk',
  create_risk:              'risk',
  update_risk:              'risk',
  create_treatment:         'risk',
  update_treatment:         'risk',
  get_nonconformities:      'audit',
  create_nonconformity:     'audit',
  update_nonconformity:     'audit',
  get_audits:                  'audit',
  create_audit:                'audit',
  update_audit:                'audit',
  rate_checklist_item:         'audit',
  get_management_reviews:      'org',
  create_management_review:    'org',
  get_mission:                 'org',
  update_mission:              'org',
  get_architecture:            'org',
  create_architecture_item:    'org',
  update_architecture_item:    'org',
  delete_architecture_item:    'org',
};

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_dashboard_summary',
      description: 'Fetches KPI counts: open risks, open non-conformities, overdue tasks, upcoming audits (next 30 days), total documents.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_risks',
      description: 'Fetches the risk register. Optionally filter by status.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'identified | analyzing | treating | accepted | closed', enum: ['identified', 'analyzing', 'treating', 'accepted', 'closed'] },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_risk',
      description: 'Creates a new risk in the risk register.',
      parameters: {
        type: 'object',
        properties: {
          title:       { type: 'string', description: 'Short descriptive title' },
          description: { type: 'string', description: 'Full description' },
          likelihood:  { type: 'number', description: 'Likelihood 1–5' },
          impact:      { type: 'number', description: 'Impact 1–5' },
          category:    { type: 'string', description: 'Must be an existing risk category from the system (see available options in context). Leave blank if none match.' },
          owner:       { type: 'string', description: 'Must be an active user from the system (see available users in context). Leave blank if not found.' },
        },
        required: ['title', 'likelihood', 'impact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_nonconformities',
      description: 'Fetches non-conformities. Optionally filter by status.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'open | in_progress | closed | verified', enum: ['open', 'in_progress', 'closed', 'verified'] },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_nonconformity',
      description: 'Creates a new non-conformity attached to the most recent audit.',
      parameters: {
        type: 'object',
        properties: {
          title:       { type: 'string', description: 'Short title' },
          description: { type: 'string', description: 'Description' },
          severity:    { type: 'string', description: 'minor | major', enum: ['minor', 'major'] },
          clause:      { type: 'string', description: 'Related ISO clause e.g. 6.1.2' },
          assigned_to: { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
        },
        required: ['title', 'severity'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tasks',
      description: 'Fetches recurring compliance tasks. Optionally filter by status or assignee.',
      parameters: {
        type: 'object',
        properties: {
          status:   { type: 'string', description: 'active | inactive' },
          assignee: { type: 'string', description: 'Filter by assignee name (partial match)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Creates a new recurring compliance task.',
      parameters: {
        type: 'object',
        properties: {
          title:       { type: 'string', description: 'Task title' },
          description: { type: 'string', description: 'What needs to be done' },
          assignee:    { type: 'string', description: 'Must be an active user from the system (see available users in context). Leave blank if not found.' },
          recurrence:  { type: 'string', description: 'daily | weekly | biweekly | monthly | quarterly | yearly', enum: ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] },
          category:    { type: 'string', description: 'Must be an existing task category from the system (see available options in context). Leave blank if none match.' },
          priority:    { type: 'string', description: 'Low | Medium | High | Critical', enum: ['Low', 'Medium', 'High', 'Critical'] },
        },
        required: ['title', 'recurrence'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_audits',
      description: 'Fetches audits from the audit plan.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'planned | in_progress | completed', enum: ['planned', 'in_progress', 'completed'] },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_documents',
      description: 'Fetches the document register.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_open_actions',
      description: 'Fetches all open follow-up actions.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_task',
      description: 'Marks a recurring compliance task as completed for this cycle, advancing its next due date.',
      parameters: {
        type: 'object',
        properties: {
          task_id:      { type: 'number', description: 'ID of the task to complete' },
          completed_by: { type: 'string', description: 'Name of person completing the task' },
          notes:        { type: 'string', description: 'Completion notes' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description: 'Updates fields of an existing compliance task (title, assignee, priority, recurrence, status, etc.).',
      parameters: {
        type: 'object',
        properties: {
          task_id:    { type: 'number', description: 'ID of the task' },
          title:      { type: 'string' },
          description:{ type: 'string' },
          assignee:   { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
          priority:   { type: 'string', enum: ['Low', 'Medium', 'High', 'Critical'] },
          recurrence: { type: 'string', enum: ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] },
          category:   { type: 'string', description: 'Must be an existing task category from the system (see context). Leave blank if none match.' },
          status:     { type: 'string', enum: ['active', 'inactive'] },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_risk',
      description: 'Updates an existing risk (status, likelihood, impact, owner, description, etc.).',
      parameters: {
        type: 'object',
        properties: {
          risk_id:       { type: 'number', description: 'ID of the risk' },
          title:         { type: 'string' },
          description:   { type: 'string' },
          likelihood:    { type: 'number', description: '1–5' },
          impact:        { type: 'number', description: '1–5' },
          category:      { type: 'string', description: 'Must be an existing risk category from the system (see context). Leave blank if none match.' },
          status:        { type: 'string', enum: ['identified', 'analyzing', 'treating', 'accepted', 'closed'] },
          risk_owner:    { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
          source:        { type: 'string' },
          asset:         { type: 'string' },
          threat:        { type: 'string' },
          vulnerability: { type: 'string' },
        },
        required: ['risk_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_nonconformity',
      description: 'Updates a non-conformity: set status, add root cause, correction, corrective action, assign responsible, set due date.',
      parameters: {
        type: 'object',
        properties: {
          nc_id:              { type: 'number', description: 'ID of the non-conformity' },
          status:             { type: 'string', enum: ['open', 'in_progress', 'closed', 'verified'] },
          root_cause:         { type: 'string' },
          correction:         { type: 'string' },
          corrective_action:  { type: 'string' },
          responsible:        { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
          due_date:           { type: 'string', description: 'ISO date YYYY-MM-DD' },
          verification_notes: { type: 'string' },
          severity:           { type: 'string', enum: ['minor', 'major'] },
        },
        required: ['nc_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_action',
      description: 'Creates a new follow-up action item.',
      parameters: {
        type: 'object',
        properties: {
          title:       { type: 'string', description: 'Short action title' },
          description: { type: 'string' },
          assignee:    { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
          priority:    { type: 'string', enum: ['Low', 'Medium', 'High', 'Critical'] },
          due_date:    { type: 'string', description: 'ISO date YYYY-MM-DD' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_action',
      description: 'Updates a follow-up action: close/resolve it, change assignee, priority, or due date.',
      parameters: {
        type: 'object',
        properties: {
          action_id:   { type: 'number', description: 'ID of the action' },
          title:       { type: 'string' },
          description: { type: 'string' },
          assignee:    { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
          priority:    { type: 'string', enum: ['Low', 'Medium', 'High', 'Critical'] },
          status:      { type: 'string', enum: ['open', 'in_progress', 'resolved', 'closed'] },
          due_date:    { type: 'string', description: 'ISO date YYYY-MM-DD' },
          resolved_by: { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
        },
        required: ['action_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_audit',
      description: 'Creates a new audit in the audit plan.',
      parameters: {
        type: 'object',
        properties: {
          title:         { type: 'string', description: 'Audit title' },
          standard:      { type: 'string', description: 'e.g. ISO 27001, ISO 9001' },
          planned_date:  { type: 'string', description: 'ISO date YYYY-MM-DD' },
          lead_auditor:  { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
          scope:         { type: 'string' },
        },
        required: ['title', 'planned_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_audit',
      description: 'Updates an audit: change status (planned → in_progress → completed), update planned date, lead auditor, etc.',
      parameters: {
        type: 'object',
        properties: {
          audit_id:       { type: 'number', description: 'ID of the audit' },
          status:         { type: 'string', enum: ['planned', 'in_progress', 'completed'] },
          planned_date:   { type: 'string', description: 'ISO date YYYY-MM-DD' },
          completed_date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
          lead_auditor:   { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
          title:          { type: 'string' },
          scope:          { type: 'string' },
        },
        required: ['audit_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_treatment',
      description: 'Adds a risk treatment to an existing risk.',
      parameters: {
        type: 'object',
        properties: {
          risk_id:     { type: 'number', description: 'ID of the risk' },
          description: { type: 'string', description: 'What will be done to treat the risk' },
          status:      { type: 'string', enum: ['planned', 'in_progress', 'implemented', 'verified'], description: 'Default: planned' },
          due_date:    { type: 'string', description: 'ISO date YYYY-MM-DD' },
          owner:       { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
        },
        required: ['risk_id', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_treatment',
      description: 'Updates a risk treatment status or description.',
      parameters: {
        type: 'object',
        properties: {
          treatment_id: { type: 'number', description: 'ID of the treatment' },
          description:  { type: 'string' },
          status:       { type: 'string', enum: ['planned', 'in_progress', 'implemented', 'verified'] },
          due_date:     { type: 'string', description: 'ISO date YYYY-MM-DD' },
          responsible:  { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
        },
        required: ['treatment_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_management_reviews',
      description: 'Fetches management reviews (ISO management review meetings). Optionally filter by status.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'scheduled | in_progress | completed', enum: ['scheduled', 'in_progress', 'completed'] },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_management_review',
      description: 'Plans (creates) a new management review meeting.',
      parameters: {
        type: 'object',
        properties: {
          title:            { type: 'string', description: 'Title of the management review' },
          review_date:      { type: 'string', description: 'ISO date YYYY-MM-DD when the review is planned' },
          chairperson:      { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
          attendees:        { type: 'string', description: 'Comma-separated list of attendees (use names from available users in context)' },
          next_review_date: { type: 'string', description: 'ISO date YYYY-MM-DD for the next review' },
        },
        required: ['title', 'review_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_mission',
      description: "Fetches the organization's mission statement, vision, and values.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_mission',
      description: "Updates the organization's mission statement, vision, and/or values. Only provided fields are updated.",
      parameters: {
        type: 'object',
        properties: {
          content:     { type: 'string', description: 'Mission statement text' },
          vision:      { type: 'string', description: 'Vision statement text' },
          values_text: { type: 'string', description: 'Values text' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_architecture',
      description: 'Fetches architecture items (roles, processes, systems, assets, facilities). Optionally filter by type.',
      parameters: {
        type: 'object',
        properties: {
          arch_type: { type: 'string', description: 'Filter by type', enum: ['role', 'process', 'system', 'asset', 'facility'] },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_architecture_item',
      description: 'Creates a new architecture item such as a role, process, system, asset, or facility.',
      parameters: {
        type: 'object',
        properties: {
          arch_type:   { type: 'string', description: 'Type of item', enum: ['role', 'process', 'system', 'asset', 'facility'] },
          name:        { type: 'string', description: 'Name of the item' },
          description: { type: 'string', description: 'Description' },
          owner:       { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
          status:      { type: 'string', description: 'active | inactive', enum: ['active', 'inactive'] },
          parent_id:   { type: 'number', description: 'ID of parent architecture item (for hierarchy)' },
        },
        required: ['arch_type', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_architecture_item',
      description: 'Updates an existing architecture item (role, process, system, asset, or facility).',
      parameters: {
        type: 'object',
        properties: {
          item_id:     { type: 'number', description: 'ID of the architecture item' },
          name:        { type: 'string' },
          description: { type: 'string' },
          owner:       { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
          status:      { type: 'string', enum: ['active', 'inactive'] },
          parent_id:   { type: 'number', description: 'ID of parent item (set to 0 to remove parent)' },
        },
        required: ['item_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_architecture_item',
      description: 'Deletes an architecture item. Use with caution — this is permanent.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'number', description: 'ID of the architecture item to delete' },
        },
        required: ['item_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_document',
      description: 'Registers a document in the document register (metadata only, no file upload).',
      parameters: {
        type: 'object',
        properties: {
          title:       { type: 'string', description: 'Document title' },
          doc_type:    { type: 'string', description: 'e.g. Policy, Procedure, Record, Manual' },
          version:     { type: 'string', description: 'e.g. 1.0' },
          owner:       { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
          status:      { type: 'string', enum: ['draft', 'review', 'approved', 'obsolete'] },
          review_date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rate_checklist_item',
      description: 'Rates an audit checklist item during audit execution (conformant, non_conformant, not_applicable, open).',
      parameters: {
        type: 'object',
        properties: {
          checklist_id: { type: 'number', description: 'ID of the checklist item' },
          rating:       { type: 'string', enum: ['open', 'conformant', 'non_conformant', 'not_applicable'], description: 'Assessment result' },
          notes:        { type: 'string', description: 'Optional auditor notes' },
        },
        required: ['checklist_id', 'rating'],
      },
    },
  },
];

// Resolves a value against a list of available options (case-insensitive).
// Returns the matched option with correct casing, '' if the value is empty,
// or null if the value is non-empty but not found in the available list.
function resolveFieldOption(value, available) {
  if (!value) return '';
  if (!available || !available.length) return null;
  const lower = String(value).toLowerCase();
  return available.find(opt => String(opt).toLowerCase() === lower) ?? null;
}

async function executeAgentTool(toolName, args, orgId, meta = {}) {
  switch (toolName) {
    case 'get_dashboard_summary': {
      const openRisks      = (await db.prepare("SELECT COUNT(*) as c FROM risks WHERE organization_id = $1 AND status NOT IN ('accepted','closed')").get(orgId))?.c ?? 0;
      const openNCs        = (await db.prepare("SELECT COUNT(*) as c FROM non_conformities n JOIN audits a ON n.audit_id = a.id WHERE a.organization_id = $1 AND n.status IN ('open','in_progress')").get(orgId))?.c ?? 0;
      const overdueTasks   = (await db.prepare("SELECT COUNT(*) as c FROM tasks WHERE organization_id = $1 AND status = 'active' AND next_due < CURRENT_DATE").get(orgId))?.c ?? 0;
      const upcomingAudits = (await db.prepare("SELECT COUNT(*) as c FROM audits WHERE organization_id = $1 AND status = 'planned' AND planned_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '30 days')").get(orgId))?.c ?? 0;
      const docCount       = (await db.prepare("SELECT COUNT(*) as c FROM documents WHERE organization_id = $1").get(orgId))?.c ?? 0;
      return { open_risks: openRisks, open_nonconformities: openNCs, overdue_tasks: overdueTasks, upcoming_audits_30d: upcomingAudits, total_documents: docCount };
    }
    case 'get_risks': {
      const params = [orgId];
      let sql = 'SELECT id, title, description, likelihood, impact, inherent_score, status, category, risk_owner, created_at FROM risks WHERE organization_id = $1';
      if (args.status) { sql += ' AND status = $2'; params.push(args.status); }
      sql += ' ORDER BY inherent_score DESC NULLS LAST LIMIT 50';
      const risks = await db.prepare(sql).all(...params);
      return { risks, count: risks.length };
    }
    case 'create_risk': {
      const { title, description = '', likelihood, impact } = args;
      const category = resolveFieldOption(args.category, meta.riskCategories) ?? '';
      const owner = resolveFieldOption(args.owner, meta.userNames) ?? '';
      const score = Math.round((likelihood ?? 1) * (impact ?? 1));
      const result = await db.prepare(`
        INSERT INTO risks (organization_id, title, description, likelihood, impact, inherent_score, category, risk_owner, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'identified')
      `).run(orgId, title, description, likelihood, impact, score, category, owner);
      return { success: true, id: result.lastInsertRowid, title, inherent_score: score };
    }
    case 'get_nonconformities': {
      const params = [orgId];
      let sql = `SELECT n.id, n.description, n.severity, n.status, n.clause, n.responsible, n.created_at
                 FROM non_conformities n JOIN audits a ON n.audit_id = a.id WHERE a.organization_id = $1`;
      if (args.status) { sql += ' AND n.status = $2'; params.push(args.status); }
      sql += ' ORDER BY n.created_at DESC LIMIT 50';
      const ncs = await db.prepare(sql).all(...params);
      return { nonconformities: ncs, count: ncs.length };
    }
    case 'create_nonconformity': {
      const latest = await db.prepare('SELECT id FROM audits WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1').get(orgId);
      if (!latest) return { error: 'No audit found. Please create an audit first before adding a non-conformity.' };
      const { title = '', description = '', severity = 'minor', clause = '' } = args;
      const assigned_to = resolveFieldOption(args.assigned_to, meta.userNames) ?? '';
      // non_conformities has no title column — combine title+description into description
      const fullDescription = title ? (description ? `${title}: ${description}` : title) : description;
      const result = await db.prepare(`
        INSERT INTO non_conformities (organization_id, audit_id, description, severity, status, clause, responsible)
        VALUES ($1, $2, $3, $4, 'open', $5, $6)
      `).run(orgId, latest.id, fullDescription, severity, clause, assigned_to);
      return { success: true, id: result.lastInsertRowid, description: fullDescription, severity, audit_id: latest.id };
    }
    case 'get_tasks': {
      const params = [orgId];
      let sql = 'SELECT id, title, description, assignee, recurrence, category, priority, is_active, next_due FROM tasks WHERE organization_id = $1';
      if (args.status === 'active')   { sql += ` AND is_active = 1`; }
      if (args.status === 'inactive') { sql += ` AND is_active = 0`; }
      if (args.assignee) { sql += ` AND assignee ILIKE $${params.length + 1}`; params.push(`%${args.assignee}%`); }
      sql += ' ORDER BY next_due ASC NULLS LAST LIMIT 50';
      const tasks = await db.prepare(sql).all(...params);
      return { tasks, count: tasks.length };
    }
    case 'create_task': {
      const { title, description = '', recurrence, priority = 'Medium' } = args;
      const category = resolveFieldOption(args.category, meta.taskCategories) ?? '';
      const assignee = resolveFieldOption(args.assignee, meta.userNames) ?? '';
      // Normalize priority to title-case to match schema CHECK constraint
      const normPriority = priority.charAt(0).toUpperCase() + priority.slice(1).toLowerCase();
      // Normalize recurrence: agent may send 'annually' but schema uses 'yearly'
      const normRecurrence = recurrence === 'annually' ? 'yearly' : recurrence;
      const result = await db.prepare(`
        INSERT INTO tasks (organization_id, title, description, assignee, recurrence, category, priority, start_date, next_due)
        VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, CURRENT_DATE)
      `).run(orgId, title, description, assignee, normRecurrence, category, normPriority);
      return { success: true, id: result.lastInsertRowid, title, recurrence: normRecurrence };
    }
    case 'get_audits': {
      const params = [orgId];
      let sql = 'SELECT id, title, standard, status, planned_date, completed_date, lead_auditor FROM audits WHERE organization_id = $1';
      if (args.status) { sql += ' AND status = $2'; params.push(args.status); }
      sql += ' ORDER BY planned_date DESC LIMIT 30';
      const audits = await db.prepare(sql).all(...params);
      return { audits, count: audits.length };
    }
    case 'get_documents': {
      const docs = await db.prepare(`
        SELECT id, title, doc_type, version, status, owner, review_date
        FROM documents WHERE organization_id = $1 ORDER BY updated_at DESC LIMIT 50
      `).all(orgId);
      return { documents: docs, count: docs.length };
    }
    case 'get_open_actions': {
      const actions = await db.prepare(`
        SELECT id, title, description, assignee, due_date, status, priority
        FROM actions WHERE organization_id = $1 AND status = 'open' ORDER BY due_date ASC NULLS LAST LIMIT 50
      `).all(orgId);
      return { actions, count: actions.length };
    }
    case 'complete_task': {
      const { task_id, completed_by = '', notes = '' } = args;
      // Verify task belongs to org
      const task = await db.prepare('SELECT * FROM tasks WHERE id = $1 AND organization_id = $2').get(task_id, orgId);
      if (!task) return { error: `Task ${task_id} not found.` };
      // Upsert the next_due instance as completed
      await db.prepare(
        `INSERT INTO task_instances (organization_id, task_id, scheduled_date, status, completed_by, completed_at, notes)
         VALUES ($1, $2, $3, 'completed', $4, NOW(), $5)
         ON CONFLICT (task_id, scheduled_date) DO UPDATE
           SET status = 'completed', completed_by = EXCLUDED.completed_by,
               completed_at = NOW(), notes = EXCLUDED.notes, updated_at = NOW()`
      ).run(orgId, task_id, task.next_due, completed_by, notes);
      // Advance next_due based on recurrence
      const recurrenceMap = { daily: '1 day', weekly: '1 week', biweekly: '2 weeks', monthly: '1 month', quarterly: '3 months', yearly: '1 year' };
      const interval = recurrenceMap[task.recurrence];
      if (interval) {
        await db.prepare(
          `UPDATE tasks SET next_due = COALESCE(next_due, CURRENT_DATE) + INTERVAL '${interval}' WHERE id = $1`
        ).run(task_id);
      }
      return { success: true, task_id, task_title: task.title, message: 'Task marked as completed.' };
    }
    case 'update_task': {
      const { task_id, ...fields } = args;
      const allowed = ['title', 'description', 'assignee', 'priority', 'recurrence', 'category'];
      let updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
      // Normalize priority casing and validate option-constrained fields
      updates = updates.map(([k, v]) => {
        if (k === 'priority') return [k, v.charAt(0).toUpperCase() + v.slice(1).toLowerCase()];
        if (k === 'recurrence') return [k, v === 'annually' ? 'yearly' : v];
        if (k === 'category') { const r = resolveFieldOption(v, meta.taskCategories); return r !== null ? [k, r] : null; }
        if (k === 'assignee') { const r = resolveFieldOption(v, meta.userNames); return r !== null ? [k, r] : null; }
        return [k, v];
      }).filter(Boolean);
      if (!updates.length) return { error: 'No valid fields to update.' };
      const verify = await db.prepare('SELECT id FROM tasks WHERE id = $1 AND organization_id = $2').get(task_id, orgId);
      if (!verify) return { error: `Task ${task_id} not found.` };
      const setClauses = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
      await db.prepare(`UPDATE tasks SET ${setClauses}, updated_at = NOW() WHERE id = $1`)
        .run(task_id, ...updates.map(([, v]) => v));
      return { success: true, task_id, updated_fields: updates.map(([k]) => k) };
    }
    case 'update_risk': {
      const { risk_id, ...fields } = args;
      const allowed = ['title', 'description', 'category', 'source', 'asset', 'threat', 'vulnerability', 'likelihood', 'impact', 'risk_owner', 'status'];
      let updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
      // Validate option-constrained fields; drop fields where no valid match exists in the system
      updates = updates.map(([k, v]) => {
        if (k === 'category') { const r = resolveFieldOption(v, meta.riskCategories); return r !== null ? [k, r] : null; }
        if (k === 'risk_owner') { const r = resolveFieldOption(v, meta.userNames); return r !== null ? [k, r] : null; }
        return [k, v];
      }).filter(Boolean);
      if (!updates.length) return { error: 'No valid fields to update.' };
      const verify = await db.prepare('SELECT id, likelihood, impact FROM risks WHERE id = $1 AND organization_id = $2').get(risk_id, orgId);
      if (!verify) return { error: `Risk ${risk_id} not found.` };
      // Recalculate score if likelihood/impact changed
      const newLikelihood = fields.likelihood ?? verify.likelihood;
      const newImpact = fields.impact ?? verify.impact;
      const scoreUpdate = (fields.likelihood || fields.impact) ? `, inherent_score = ${Math.round(newLikelihood * newImpact)}` : '';
      const setClauses = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
      await db.prepare(`UPDATE risks SET ${setClauses}${scoreUpdate}, updated_at = NOW() WHERE id = $1`)
        .run(risk_id, ...updates.map(([, v]) => v));
      return { success: true, risk_id, updated_fields: updates.map(([k]) => k) };
    }
    case 'update_nonconformity': {
      const { nc_id, ...fields } = args;
      const allowed = ['clause', 'description', 'severity', 'root_cause', 'correction', 'corrective_action', 'responsible', 'due_date', 'status', 'verification_notes'];
      let updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
      updates = updates.map(([k, v]) => {
        if (k === 'responsible') { const r = resolveFieldOption(v, meta.userNames); return r !== null ? [k, r] : null; }
        return [k, v];
      }).filter(Boolean);
      if (!updates.length) return { error: 'No valid fields to update.' };
      // Verify belongs to org via audit join
      const verify = await db.prepare(
        `SELECT n.id FROM non_conformities n JOIN audits a ON n.audit_id = a.id WHERE n.id = $1 AND a.organization_id = $2`
      ).get(nc_id, orgId);
      if (!verify) return { error: `Non-conformity ${nc_id} not found.` };
      // Auto-set closed_date when closing
      const closedDateClause = (fields.status === 'closed' || fields.status === 'verified') ? ', closed_date = CURRENT_DATE' : '';
      const setClauses = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
      await db.prepare(`UPDATE non_conformities SET ${setClauses}${closedDateClause} WHERE id = $1`)
        .run(nc_id, ...updates.map(([, v]) => v));
      return { success: true, nc_id, updated_fields: updates.map(([k]) => k) };
    }
    case 'create_action': {
      const { title, description = '', priority = 'Medium', due_date = null } = args;
      const assignee = resolveFieldOption(args.assignee, meta.userNames) ?? '';
      const normPriority = priority.charAt(0).toUpperCase() + priority.slice(1).toLowerCase();
      const result = await db.prepare(
        `INSERT INTO actions (organization_id, title, description, assignee, priority, status, due_date)
         VALUES ($1, $2, $3, $4, $5, 'open', $6)`
      ).run(orgId, title, description, assignee, normPriority, due_date);
      return { success: true, id: result.lastInsertRowid, title, priority };
    }
    case 'update_action': {
      const { action_id, ...fields } = args;
      const allowed = ['title', 'description', 'assignee', 'priority', 'status', 'due_date', 'resolved_by'];
      let updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
      // Normalize priority and validate option-constrained fields
      updates = updates.map(([k, v]) => {
        if (k === 'priority') return [k, v.charAt(0).toUpperCase() + v.slice(1).toLowerCase()];
        if (k === 'assignee') { const r = resolveFieldOption(v, meta.userNames); return r !== null ? [k, r] : null; }
        if (k === 'resolved_by') { const r = resolveFieldOption(v, meta.userNames); return r !== null ? [k, r] : null; }
        return [k, v];
      }).filter(Boolean);
      if (!updates.length) return { error: 'No valid fields to update.' };
      const verify = await db.prepare('SELECT id FROM actions WHERE id = $1 AND organization_id = $2').get(action_id, orgId);
      if (!verify) return { error: `Action ${action_id} not found.` };
      const resolvedClause = (fields.status === 'resolved' || fields.status === 'closed') ? ', resolved_at = NOW()' : '';
      const setClauses = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
      await db.prepare(`UPDATE actions SET ${setClauses}${resolvedClause} WHERE id = $1`)
        .run(action_id, ...updates.map(([, v]) => v));
      return { success: true, action_id, updated_fields: updates.map(([k]) => k) };
    }
    case 'create_audit': {
      const { title, standard = '', planned_date, scope = '' } = args;
      const lead_auditor = resolveFieldOption(args.lead_auditor, meta.userNames) ?? '';
      const result = await db.prepare(
        `INSERT INTO audits (organization_id, title, standard, status, planned_date, lead_auditor, scope)
         VALUES ($1, $2, $3, 'planned', $4, $5, $6)`
      ).run(orgId, title, standard, planned_date, lead_auditor, scope);
      return { success: true, id: result.lastInsertRowid, title, planned_date };
    }
    case 'update_audit': {
      const { audit_id, ...fields } = args;
      const allowed = ['title', 'standard', 'status', 'planned_date', 'completed_date', 'lead_auditor', 'scope'];
      let updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
      updates = updates.map(([k, v]) => {
        if (k === 'lead_auditor') { const r = resolveFieldOption(v, meta.userNames); return r !== null ? [k, r] : null; }
        return [k, v];
      }).filter(Boolean);
      if (!updates.length) return { error: 'No valid fields to update.' };
      const verify = await db.prepare('SELECT id FROM audits WHERE id = $1 AND organization_id = $2').get(audit_id, orgId);
      if (!verify) return { error: `Audit ${audit_id} not found.` };
      const setClauses = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
      await db.prepare(`UPDATE audits SET ${setClauses} WHERE id = $1`)
        .run(audit_id, ...updates.map(([, v]) => v));
      return { success: true, audit_id, updated_fields: updates.map(([k]) => k) };
    }
    case 'create_treatment': {
      const { risk_id, description, status = 'planned', due_date = null } = args;
      const owner = resolveFieldOption(args.owner, meta.userNames) ?? '';
      const verify = await db.prepare('SELECT id FROM risks WHERE id = $1 AND organization_id = $2').get(risk_id, orgId);
      if (!verify) return { error: `Risk ${risk_id} not found.` };
      const result = await db.prepare(
        `INSERT INTO risk_treatments (organization_id, risk_id, description, status, due_date, responsible)
         VALUES ($1, $2, $3, $4, $5, $6)`
      ).run(orgId, risk_id, description, status, due_date, owner);
      return { success: true, id: result.lastInsertRowid, risk_id, description };
    }
    case 'update_treatment': {
      const { treatment_id, ...fields } = args;
      const allowed = ['description', 'status', 'due_date', 'responsible'];
      let updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
      updates = updates.map(([k, v]) => {
        if (k === 'responsible') { const r = resolveFieldOption(v, meta.userNames); return r !== null ? [k, r] : null; }
        return [k, v];
      }).filter(Boolean);
      if (!updates.length) return { error: 'No valid fields to update.' };
      // Verify ownership via risk join
      const verify = await db.prepare(
        `SELECT rt.id FROM risk_treatments rt JOIN risks r ON rt.risk_id = r.id WHERE rt.id = $1 AND r.organization_id = $2`
      ).get(treatment_id, orgId);
      if (!verify) return { error: `Treatment ${treatment_id} not found.` };
      const setClauses = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
      await db.prepare(`UPDATE risk_treatments SET ${setClauses} WHERE id = $1`)
        .run(treatment_id, ...updates.map(([, v]) => v));
      return { success: true, treatment_id, updated_fields: updates.map(([k]) => k) };
    }
    case 'create_document': {
      const { title, doc_type = 'Policy', version = '1.0', status = 'draft', review_date = null } = args;
      const owner = resolveFieldOption(args.owner, meta.userNames) ?? '';
      const result = await db.prepare(
        `INSERT INTO documents (organization_id, title, doc_type, version, owner, status, review_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`
      ).run(orgId, title, doc_type, version, owner, status, review_date);
      return { success: true, id: result.lastInsertRowid, title, doc_type, status };
    }
    case 'rate_checklist_item': {
      const { checklist_id, rating, notes = '' } = args;
      // Verify item belongs to org via audit join
      const item = await db.prepare(
        `SELECT cl.id, cl.audit_id FROM audit_checklist cl JOIN audits a ON cl.audit_id = a.id WHERE cl.id = $1 AND a.organization_id = $2`
      ).get(checklist_id, orgId);
      if (!item) return { error: `Checklist item ${checklist_id} not found.` };
      await db.prepare(
        `UPDATE audit_checklist SET rating = $1, notes = $2, updated_at = NOW() WHERE id = $3`
      ).run(rating, notes, checklist_id);
      return { success: true, checklist_id, rating, message: `Item rated as ${rating}.` };
    }
    case 'get_mission': {
      const mission = await db.prepare('SELECT content, vision, values_text FROM org_mission WHERE organization_id = $1').get(orgId);
      const org = await db.prepare('SELECT name FROM organizations WHERE id = $1').get(orgId);
      return { org_name: org?.name || '', ...mission };
    }
    case 'update_mission': {
      const { content, vision, values_text } = args;
      const existing = await db.prepare('SELECT content, vision, values_text FROM org_mission WHERE organization_id = $1').get(orgId);
      if (!existing) return { error: 'Mission record not found for this organization.' };
      await db.prepare(`
        UPDATE org_mission SET
          content = $1, vision = $2, values_text = $3, updated_at = NOW()
        WHERE organization_id = $4
      `).run(
        content     !== undefined ? content     : existing.content,
        vision      !== undefined ? vision      : existing.vision,
        values_text !== undefined ? values_text : existing.values_text,
        orgId
      );
      const updated = await db.prepare('SELECT content, vision, values_text FROM org_mission WHERE organization_id = $1').get(orgId);
      return { success: true, ...updated };
    }
    case 'get_architecture': {
      const params = [orgId];
      let sql = 'SELECT id, arch_type, name, description, owner, status, parent_id, sort_order FROM org_architecture WHERE organization_id = $1';
      if (args.arch_type) { sql += ' AND arch_type = $2'; params.push(args.arch_type); }
      sql += ' ORDER BY arch_type, sort_order, name';
      const items = await db.prepare(sql).all(...params);
      return { items, count: items.length };
    }
    case 'create_architecture_item': {
      const { arch_type, name, description = '', status = 'active', parent_id = null } = args;
      const owner = resolveFieldOption(args.owner, meta.userNames) ?? '';
      const result = await db.prepare(`
        INSERT INTO org_architecture (organization_id, arch_type, name, description, owner, status, parent_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `).run(orgId, arch_type, name, description, owner, status, parent_id || null);
      return { success: true, id: result.lastInsertRowid, arch_type, name };
    }
    case 'update_architecture_item': {
      const { item_id, ...fields } = args;
      const verify = await db.prepare('SELECT id FROM org_architecture WHERE id = $1 AND organization_id = $2').get(item_id, orgId);
      if (!verify) return { error: `Architecture item ${item_id} not found.` };
      const allowed = ['name', 'description', 'owner', 'status', 'parent_id'];
      let updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
      updates = updates.map(([k, v]) => {
        if (k === 'owner') { const r = resolveFieldOption(v, meta.userNames); return r !== null ? [k, r] : null; }
        return [k, v];
      }).filter(Boolean);
      if (!updates.length) return { error: 'No valid fields to update.' };
      // Allow parent_id = 0 to mean "remove parent" → set to NULL
      updates = updates.map(([k, v]) => [k, k === 'parent_id' && v === 0 ? null : v]);
      const setClauses = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
      await db.prepare(`UPDATE org_architecture SET ${setClauses}, updated_at = NOW() WHERE id = $1`)
        .run(item_id, ...updates.map(([, v]) => v));
      return { success: true, item_id, updated_fields: updates.map(([k]) => k) };
    }
    case 'delete_architecture_item': {
      const { item_id } = args;
      const verify = await db.prepare('SELECT id, name, arch_type FROM org_architecture WHERE id = $1 AND organization_id = $2').get(item_id, orgId);
      if (!verify) return { error: `Architecture item ${item_id} not found.` };
      await db.prepare('DELETE FROM org_architecture WHERE id = $1 AND organization_id = $2').run(item_id, orgId);
      return { success: true, item_id, deleted: verify.name, arch_type: verify.arch_type };
    }
    case 'get_management_reviews': {
      const params = [orgId];
      let sql = 'SELECT id, title, review_date, status, chairperson, next_review_date, summary FROM management_reviews WHERE organization_id = $1';
      if (args.status) { sql += ' AND status = $2'; params.push(args.status); }
      sql += ' ORDER BY review_date DESC LIMIT 20';
      const reviews = await db.prepare(sql).all(...params);
      return { management_reviews: reviews, count: reviews.length };
    }
    case 'create_management_review': {
      const { title, review_date, attendees = '', next_review_date = null } = args;
      const chairperson = resolveFieldOption(args.chairperson, meta.userNames) ?? '';
      // Store attendees as JSON array if passed as comma-separated string
      const attendeesJson = Array.isArray(attendees)
        ? JSON.stringify(attendees)
        : JSON.stringify(attendees.split(',').map(a => a.trim()).filter(Boolean));
      const result = await db.prepare(`
        INSERT INTO management_reviews (organization_id, title, review_date, status, chairperson, attendees, next_review_date)
        VALUES ($1, $2, $3, 'scheduled', $4, $5, $6)
      `).run(orgId, title, review_date, chairperson, attendeesJson, next_review_date);
      return { success: true, id: result.lastInsertRowid, title, review_date, status: 'scheduled' };
    }
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

app.post('/api/agent', requireOrgContext, async (req, res) => {
  console.log('[Agent] Request received — userId:', req.session.userId, 'orgId:', req.orgId);

  const openai = getOpenAI();
  if (!openai) {
    console.error('[Agent] No OpenAI client — OPENAI_API_KEY missing or openai package failed to load');
    return res.status(503).json({ error: 'AI Agent is not configured. Ask your administrator to set the OPENAI_API_KEY environment variable.' });
  }
  console.log('[Agent] OpenAI client obtained successfully');

  const { message, history = [] } = req.body;
  console.log('[Agent] Message:', JSON.stringify(message), '| History length:', history.length);
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

  // Load the current user's permissions from the database
  let userRecord;
  try {
    userRecord = await db.prepare('SELECT permissions FROM users WHERE id = $1').get(req.session.userId);
    console.log('[Agent] User permissions raw:', userRecord?.permissions);
  } catch (dbErr) {
    console.error('[Agent] DB error loading user permissions:', dbErr.stack || dbErr);
    return res.status(500).json({ error: 'Failed to load user permissions: ' + dbErr.message });
  }

  let userPerms = [];
  try {
    userPerms = JSON.parse(userRecord?.permissions || '[]');
  } catch (_) { userPerms = []; }
  // Superadmins and org admins get all permissions
  if (req.session.userRole === 'superadmin' || userPerms.includes('admin')) {
    userPerms = Object.values(AGENT_TOOL_PERMISSIONS);
  }
  console.log('[Agent] Resolved user permissions:', userPerms);

  // Fetch available field options so the agent can only assign values that exist in the system
  let agentMeta = { riskCategories: [], taskCategories: [], userNames: [] };
  try {
    const [riskCats, taskCats, orgUsers] = await Promise.all([
      db.prepare("SELECT DISTINCT category FROM risks WHERE organization_id = $1 AND category IS NOT NULL AND category != '' ORDER BY category").all(orgId),
      db.prepare("SELECT DISTINCT category FROM tasks WHERE organization_id = $1 AND category IS NOT NULL AND category != '' ORDER BY category").all(orgId),
      db.prepare("SELECT name FROM users WHERE organization_id = $1 AND status = 'active' AND role != 'superadmin' ORDER BY name").all(orgId),
    ]);
    agentMeta = {
      riskCategories: riskCats.map(r => r.category),
      taskCategories: taskCats.map(r => r.category),
      userNames: orgUsers.map(r => r.name),
    };
    console.log('[Agent] Meta — riskCategories:', agentMeta.riskCategories.length, '| taskCategories:', agentMeta.taskCategories.length, '| users:', agentMeta.userNames.length);
  } catch (metaErr) {
    console.warn('[Agent] Could not load field metadata:', metaErr.message);
  }

  // Build a context block listing available options so the agent behaves like a normal user
  const contextParts = [
    'FIELD OPTIONS — you MUST only use values from these lists when filling in category, owner, assignee, responsible, lead_auditor, or chairperson fields.',
    'If no suitable match exists in the list, leave the field blank (empty string). Do NOT invent or guess values.',
  ];
  if (agentMeta.riskCategories.length) {
    contextParts.push(`Available risk categories: ${agentMeta.riskCategories.join(', ')}`);
  } else {
    contextParts.push('Available risk categories: (none defined — leave category blank)');
  }
  if (agentMeta.taskCategories.length) {
    contextParts.push(`Available task categories: ${agentMeta.taskCategories.join(', ')}`);
  } else {
    contextParts.push('Available task categories: (none defined — leave category blank)');
  }
  if (agentMeta.userNames.length) {
    contextParts.push(`Available users (for owner/assignee/responsible/lead_auditor/chairperson fields): ${agentMeta.userNames.join(', ')}`);
  } else {
    contextParts.push('Available users: (none — leave all owner/assignee/responsible fields blank)');
  }
  const agentFieldContext = contextParts.join('\n');

  // Filter tools to only those the user has permission to use
  const allowedTools = AGENT_TOOLS.filter(t => {
    const required = AGENT_TOOL_PERMISSIONS[t.function.name];
    return !required || userPerms.includes(required);
  });
  console.log('[Agent] Allowed tools:', allowedTools.map(t => t.function.name));

  // System + last 20 history messages + new user turn
  const messages = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT + '\n\n' + agentFieldContext },
    ...history.slice(-20),
    { role: 'user', content: message.trim() },
  ];

  const openaiPayload = {
    model: 'gpt-4o-mini',
    messages,
    tools: allowedTools,
    tool_choice: 'auto',
    max_tokens: 1024,
  };
  console.log('[Agent] Sending request to OpenAI — model:', openaiPayload.model,
    '| messages:', openaiPayload.messages.length,
    '| tools:', openaiPayload.tools.length);

  try {
    let response = await openai.chat.completions.create(openaiPayload);
    console.log('[Agent] OpenAI responded — finish_reason:', response.choices[0]?.finish_reason,
      '| tool_calls:', response.choices[0]?.message?.tool_calls?.length ?? 0);

    let assistantMsg = response.choices[0].message;

    // Agentic loop: resolve all tool calls before returning to the user
    const MAX_ROUNDS = 5;
    let rounds = 0;
    while (assistantMsg.tool_calls?.length && rounds < MAX_ROUNDS) {
      rounds++;
      console.log('[Agent] Agentic loop round', rounds, '— tool calls:', assistantMsg.tool_calls.map(tc => tc.function.name));
      messages.push(assistantMsg);

      const toolResults = await Promise.all(
        assistantMsg.tool_calls.map(async tc => {
          let result;
          try {
            // Defense-in-depth: verify permission even if tool slipped through
            const required = AGENT_TOOL_PERMISSIONS[tc.function.name];
            if (required && !userPerms.includes(required)) {
              console.warn('[Agent] Permission denied for tool', tc.function.name, '— required:', required);
              result = { error: `Permission denied. You do not have access to the '${required}' module.` };
            } else {
              const toolArgs = JSON.parse(tc.function.arguments || '{}');
              console.log('[Agent] Executing tool:', tc.function.name, '| args:', JSON.stringify(toolArgs));
              result = await executeAgentTool(tc.function.name, toolArgs, req.orgId, agentMeta);
              console.log('[Agent] Tool result for', tc.function.name, ':', JSON.stringify(result).slice(0, 200));
            }
          } catch (err) {
            console.error('[Agent] Tool execution error for', tc.function.name, ':', err.stack || err);
            result = { error: `Tool failed: ${err.message}` };
          }
          return { role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) };
        })
      );

      messages.push(...toolResults);

      console.log('[Agent] Sending follow-up request to OpenAI after tool results (round', rounds, ')');
      response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        tools: allowedTools,
        tool_choice: 'auto',
        max_tokens: 1024,
      });
      console.log('[Agent] OpenAI round', rounds, 'response — finish_reason:', response.choices[0]?.finish_reason,
        '| tool_calls:', response.choices[0]?.message?.tool_calls?.length ?? 0);
      assistantMsg = response.choices[0].message;
    }

    console.log('[Agent] Final reply length:', (assistantMsg.content || '').length);
    res.json({ reply: assistantMsg.content || '_(no response)_' });
  } catch (err) {
    console.error('[Agent] OpenAI error — status:', err.status, '| message:', err.message);
    console.error('[Agent] Full error:', err.stack || err);
    if (err.status === 429) return res.status(429).json({ error: 'Rate limit reached. Please wait a moment and try again.' });
    if (err.status === 401) return res.status(503).json({ error: 'Invalid OpenAI API key. Please check your server configuration.' });
    if (err.status === 400) return res.status(400).json({ error: 'Bad request to OpenAI: ' + (err.message || 'unknown error') });
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      return res.status(503).json({ error: 'Cannot reach OpenAI API. Check network connectivity: ' + err.message });
    }
    res.status(500).json({ error: 'AI agent error: ' + (err.message || 'unknown error') });
  }
});

// ---------------------------------------------------------------------------
// Agent Import endpoint – file-based bulk population
// POST /api/agent/import
// Accepts an Excel/CSV file, uses OpenAI to map columns → app schema fields,
// then bulk-inserts records respecting the user's module permissions.
// ---------------------------------------------------------------------------

// Schema context sent to OpenAI so it knows what fields are available per type.
const IMPORT_SCHEMAS = {
  risks: {
    description: 'Risk register entries',
    fields: {
      title:       'string (required) – short risk name',
      description: 'string – full description',
      category:    'string – e.g. Operational, Compliance, Financial, Information Security',
      likelihood:  'integer 1–5',
      impact:      'integer 1–5',
      risk_owner:  'string – responsible person',
      status:      'string – one of: identified, analyzing, treating, accepted, closed',
    },
  },
  risk_treatments: {
    description: 'Risk treatment / control entries (linked to risks by title)',
    fields: {
      risk_title:   'string (required) – title of the parent risk to link to',
      description:  'string (required) – what the treatment does',
      status:       'string – one of: planned, in_progress, implemented, verified',
      due_date:     'string YYYY-MM-DD',
      responsible:  'string – person responsible',
    },
  },
  architecture: {
    description: 'Organizational architecture items: roles, processes, systems, assets, facilities',
    fields: {
      arch_type:   'string (required) – one of: role, process, system, asset, facility',
      name:        'string (required)',
      description: 'string',
      owner:       'string',
      status:      'string – active or inactive',
      parent_name: 'string – name of parent architecture item (optional)',
    },
  },
  requirements: {
    description: 'Standard requirements / clauses, optionally linked to processes',
    fields: {
      standard:     'string – e.g. ISO 27001, ISO 9001 (default: ISO 27001)',
      clause:       'string (required) – e.g. 4.1, 6.1.2',
      title:        'string (required) – requirement title',
      description:  'string',
      category:     'string',
      process_name: 'string – name of architecture process to cross-link to (optional)',
    },
  },
  tasks: {
    description: 'Recurring compliance tasks',
    fields: {
      title:       'string (required)',
      description: 'string',
      assignee:    'string',
      recurrence:  'string – one of: daily, weekly, biweekly, monthly, quarterly, yearly',
      category:    'string',
      priority:    'string – one of: Low, Medium, High, Critical',
    },
  },
  actions: {
    description: 'Follow-up action items',
    fields: {
      title:       'string (required)',
      description: 'string',
      assignee:    'string',
      priority:    'string – one of: Low, Medium, High, Critical',
      due_date:    'string YYYY-MM-DD',
    },
  },
  nonconformities: {
    description: 'Non-conformities (attached to most recent audit)',
    fields: {
      description: 'string (required) – description of the NC',
      severity:    'string – minor or major',
      clause:      'string – related ISO clause',
      responsible: 'string',
      status:      'string – one of: open, in_progress, closed, verified',
    },
  },
  documents: {
    description: 'Document register entries',
    fields: {
      title:       'string (required)',
      doc_type:    'string – one of: policy, procedure, work_instruction, record, form, report, evidence, other',
      version:     'string – e.g. 1.0',
      owner:       'string',
      status:      'string – one of: draft, review, approved, obsolete',
      review_date: 'string YYYY-MM-DD',
    },
  },
};

// Permission required per import type (mirrors AGENT_TOOL_PERMISSIONS)
const IMPORT_TYPE_PERMISSIONS = {
  risks:            'risk',
  risk_treatments:  'risk',
  architecture:     'org',
  requirements:     'org',
  tasks:            'ops',
  actions:          'org',
  nonconformities:  'audit',
  documents:        'org',
};

// Maps template tab names → import data types (case-insensitive)
const SHEET_NAME_TO_TYPE = {
  risks:             'risks',
  risk_treatments:   'risk_treatments',
  'risk treatments': 'risk_treatments',
  architecture:      'architecture',
  requirements:      'requirements',
  tasks:             'tasks',
  actions:           'actions',
  nonconformities:   'nonconformities',
  documents:         'documents',
};

function parseImportFile(buffer, originalname) {
  const ext = (originalname || '').split('.').pop().toLowerCase();
  const workbook = XLSX.read(buffer, { type: 'buffer', raw: ext === 'csv' });

  const sheets = [];
  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (rows.length === 0) continue; // skip empty / instructions tabs
    const headers = Object.keys(rows[0]);
    // Skip the Instructions sheet (its first column is the long intro text)
    if (sheetName.toLowerCase() === 'instructions') continue;
    sheets.push({ sheetName, headers, rows });
  }
  return sheets; // array of { sheetName, headers, rows }
}

async function detectAndMap(openai, headers, sampleRows, dataTypeHint, userMessage) {
  const schemaBlock = dataTypeHint && IMPORT_SCHEMAS[dataTypeHint]
    ? JSON.stringify({ [dataTypeHint]: IMPORT_SCHEMAS[dataTypeHint] }, null, 2)
    : JSON.stringify(IMPORT_SCHEMAS, null, 2);

  const prompt = `You are a data-import assistant. A user is uploading a spreadsheet to import into a compliance management system.

Available import types and their target fields:
${schemaBlock}

The spreadsheet has these column headers:
${JSON.stringify(headers)}

Sample rows (up to 3):
${JSON.stringify(sampleRows.slice(0, 3), null, 2)}

${userMessage ? `User note: "${userMessage}"` : ''}

Respond with ONLY valid JSON in this exact format (no markdown, no extra text):
{
  "data_type": "<one of the import type keys above>",
  "mapping": {
    "<target_field>": "<source_column_name_or_null>"
  }
}

Rules:
- Pick the best matching data_type based on the column names and sample data.
- For each target field, set the value to the matching source column name (exact header), or null if no match.
- Required fields must map to a column. If you cannot find a match for a required field, still include it with null.
- Do not invent column names. Only use headers from the list above.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 512,
    temperature: 0,
  });

  const text = response.choices[0].message.content.trim();
  return JSON.parse(text);
}

function applyMapping(rows, mapping) {
  return rows.map(row => {
    const out = {};
    for (const [field, col] of Object.entries(mapping)) {
      if (col && row[col] !== undefined) {
        const val = String(row[col]).trim();
        out[field] = val === '' ? null : val;
      } else {
        out[field] = null;
      }
    }
    return out;
  });
}

async function bulkInsert(dataType, mappedRows, orgId) {
  const results = { imported: 0, skipped: 0, errors: [] };

  for (let i = 0; i < mappedRows.length; i++) {
    const row = mappedRows[i];
    const rowNum = i + 2; // 1-indexed + header row
    try {
      if (dataType === 'risks') {
        if (!row.title) { results.skipped++; results.errors.push(`Row ${rowNum}: missing title`); continue; }
        const likelihood = Math.min(5, Math.max(1, parseInt(row.likelihood) || 3));
        const impact     = Math.min(5, Math.max(1, parseInt(row.impact)     || 3));
        const validStatuses = ['identified','analyzing','treating','accepted','closed'];
        const status = validStatuses.includes(row.status) ? row.status : 'identified';
        await db.prepare(`
          INSERT INTO risks (organization_id, title, description, category, likelihood, impact, inherent_score, risk_owner, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `).run(orgId, row.title, row.description||'', row.category||'General',
               likelihood, impact, likelihood*impact, row.risk_owner||'', status);
        results.imported++;

      } else if (dataType === 'risk_treatments') {
        if (!row.risk_title || !row.description) { results.skipped++; results.errors.push(`Row ${rowNum}: missing risk_title or description`); continue; }
        const risk = await db.prepare('SELECT id FROM risks WHERE organization_id = $1 AND LOWER(title) = LOWER($2) LIMIT 1').get(orgId, row.risk_title);
        if (!risk) { results.skipped++; results.errors.push(`Row ${rowNum}: risk not found: "${row.risk_title}"`); continue; }
        const validStatuses = ['planned','in_progress','implemented','verified'];
        const status = validStatuses.includes(row.status) ? row.status : 'planned';
        await db.prepare(`
          INSERT INTO risk_treatments (organization_id, risk_id, description, status, due_date, responsible)
          VALUES ($1,$2,$3,$4,$5,$6)
        `).run(orgId, risk.id, row.description, status, row.due_date||null, row.responsible||'');
        results.imported++;

      } else if (dataType === 'architecture') {
        const validTypes = ['role','process','system','asset','facility'];
        if (!row.name) { results.skipped++; results.errors.push(`Row ${rowNum}: missing name`); continue; }
        const archType = validTypes.includes(row.arch_type) ? row.arch_type : 'process';
        let parentId = null;
        if (row.parent_name) {
          const parent = await db.prepare('SELECT id FROM org_architecture WHERE organization_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1').get(orgId, row.parent_name);
          if (parent) parentId = parent.id;
        }
        const status = row.status === 'inactive' ? 'inactive' : 'active';
        // Upsert: update if name+type already exists, otherwise insert
        const existing = await db.prepare('SELECT id FROM org_architecture WHERE organization_id = $1 AND arch_type = $2 AND LOWER(name) = LOWER($3) LIMIT 1').get(orgId, archType, row.name);
        if (existing) {
          await db.prepare(`UPDATE org_architecture SET description=$1, owner=$2, status=$3, parent_id=$4, updated_at=NOW() WHERE id=$5`)
            .run(row.description||'', row.owner||'', status, parentId, existing.id);
        } else {
          await db.prepare(`INSERT INTO org_architecture (organization_id, arch_type, name, description, owner, status, parent_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`)
            .run(orgId, archType, row.name, row.description||'', row.owner||'', status, parentId);
        }
        results.imported++;

      } else if (dataType === 'requirements') {
        if (!row.clause || !row.title) { results.skipped++; results.errors.push(`Row ${rowNum}: missing clause or title`); continue; }
        const standard = row.standard || 'ISO 27001';
        // Upsert requirement
        let req = await db.prepare('SELECT id FROM standard_requirements WHERE organization_id = $1 AND standard = $2 AND clause = $3 LIMIT 1').get(orgId, standard, row.clause);
        if (req) {
          await db.prepare(`UPDATE standard_requirements SET title=$1, description=$2, category=$3, updated_at=NOW() WHERE id=$4`)
            .run(row.title, row.description||'', row.category||'', req.id);
        } else {
          const ins = await db.prepare(`INSERT INTO standard_requirements (organization_id, standard, clause, title, description, category) VALUES ($1,$2,$3,$4,$5,$6)`)
            .run(orgId, standard, row.clause, row.title, row.description||'', row.category||'');
          req = { id: ins.lastInsertRowid };
        }
        // Cross-link to architecture process if provided
        if (row.process_name) {
          const arch = await db.prepare('SELECT id FROM org_architecture WHERE organization_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1').get(orgId, row.process_name);
          if (arch) {
            await db.prepare(`
              INSERT INTO cross_links (organization_id, source_type, source_id, target_type, target_id)
              VALUES ($1,'requirement',$2,'process',$3)
              ON CONFLICT DO NOTHING
            `).run(orgId, req.id, arch.id);
          }
        }
        results.imported++;

      } else if (dataType === 'tasks') {
        if (!row.title) { results.skipped++; results.errors.push(`Row ${rowNum}: missing title`); continue; }
        const validRec = ['daily','weekly','biweekly','monthly','quarterly','yearly'];
        const recurrence = validRec.includes(row.recurrence) ? row.recurrence : 'monthly';
        const priority = row.priority ? row.priority.charAt(0).toUpperCase() + row.priority.slice(1).toLowerCase() : 'Medium';
        await db.prepare(`
          INSERT INTO tasks (organization_id, title, description, assignee, recurrence, category, priority, start_date, next_due)
          VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE,CURRENT_DATE)
        `).run(orgId, row.title, row.description||'', row.assignee||'', recurrence, row.category||'General', priority);
        results.imported++;

      } else if (dataType === 'actions') {
        if (!row.title) { results.skipped++; results.errors.push(`Row ${rowNum}: missing title`); continue; }
        const priority = row.priority ? row.priority.charAt(0).toUpperCase() + row.priority.slice(1).toLowerCase() : 'Medium';
        await db.prepare(`
          INSERT INTO actions (organization_id, title, description, assignee, priority, status, due_date)
          VALUES ($1,$2,$3,$4,$5,'open',$6)
        `).run(orgId, row.title, row.description||'', row.assignee||'', priority, row.due_date||null);
        results.imported++;

      } else if (dataType === 'nonconformities') {
        if (!row.description) { results.skipped++; results.errors.push(`Row ${rowNum}: missing description`); continue; }
        const audit = await db.prepare('SELECT id FROM audits WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1').get(orgId);
        if (!audit) { results.skipped++; results.errors.push(`Row ${rowNum}: no audit found – create an audit first`); continue; }
        const validSev = ['minor','major'];
        const severity = validSev.includes(row.severity) ? row.severity : 'minor';
        const validStat = ['open','in_progress','closed','verified'];
        const status = validStat.includes(row.status) ? row.status : 'open';
        await db.prepare(`
          INSERT INTO non_conformities (organization_id, audit_id, description, severity, clause, responsible, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
        `).run(orgId, audit.id, row.description, severity, row.clause||'', row.responsible||'', status);
        results.imported++;

      } else if (dataType === 'documents') {
        if (!row.title) { results.skipped++; results.errors.push(`Row ${rowNum}: missing title`); continue; }
        const validTypes = ['policy','procedure','work_instruction','record','form','report','evidence','other'];
        const docType = validTypes.includes(row.doc_type) ? row.doc_type : 'policy';
        const validStat = ['draft','review','approved','obsolete'];
        const status = validStat.includes(row.status) ? row.status : 'draft';
        await db.prepare(`
          INSERT INTO documents (organization_id, title, doc_type, version, owner, status, review_date)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
        `).run(orgId, row.title, docType, row.version||'1.0', row.owner||'', status, row.review_date||null);
        results.imported++;
      }
    } catch (err) {
      results.errors.push(`Row ${rowNum}: ${err.message}`);
      results.skipped++;
    }
  }
  return results;
}

function buildImportTemplate() {
  const wb = XLSX.utils.book_new();

  // Shared style helpers (xlsx CE supports limited cell styling via !cols / !rows)
  const col = w => ({ wch: w });

  // ── Sheet definitions ────────────────────────────────────────────────────
  const sheets = [
    {
      name: 'Instructions',
      headerColor: null,
      colWidths: [28, 60],
      rows: [
        ['BOP Compliance Platform – Master Import Template', ''],
        ['', ''],
        ['How to use this file:', ''],
        ['1. Fill in the relevant sheet(s) for the data you want to import.', ''],
        ['2. Do NOT rename the column headers – the AI uses them to map your data.', ''],
        ['3. Delete the example rows before importing (rows starting with "EXAMPLE").', ''],
        ['4. Upload the file via the Agent → Import button in the app.', ''],
        ['5. You can upload one sheet at a time or all sheets in one file – the agent detects the type automatically.', ''],
        ['', ''],
        ['Sheet', 'What it imports'],
        ['Risks', 'Risk register entries'],
        ['Risk_Treatments', 'Treatment / control actions linked to a risk (by title)'],
        ['Architecture', 'Roles, processes, systems, assets, facilities'],
        ['Requirements', 'Standard clauses (ISO 27001, ISO 9001 etc.) + optional link to a process'],
        ['Tasks', 'Recurring compliance tasks'],
        ['Actions', 'One-off follow-up action items'],
        ['Nonconformities', 'Non-conformities (attached to the most recent audit)'],
        ['Documents', 'Document register entries (metadata only, no file)'],
        ['', ''],
        ['Notes:', ''],
        ['• likelihood / impact: integers 1 (very low) to 5 (very high)', ''],
        ['• Dates: use YYYY-MM-DD format (e.g. 2025-12-31)', ''],
        ['• arch_type must be exactly: role | process | system | asset | facility', ''],
        ['• risk_title in Risk_Treatments must exactly match a title in the Risks sheet (or an existing risk in the app)', ''],
        ['• process_name in Requirements links to an architecture item by name (fuzzy match is case-insensitive)', ''],
        ['• Priority values: Low | Medium | High | Critical', ''],
        ['• Recurrence values: daily | weekly | biweekly | monthly | quarterly | yearly', ''],
      ],
    },
    {
      name: 'Risks',
      colWidths: [30, 50, 25, 12, 10, 25, 20],
      headers: ['title','description','category','likelihood','impact','risk_owner','status'],
      notes:   ['Required. Short name','Full description','e.g. Operational, Compliance, Financial, Information Security','1–5 (1=very low)','1–5 (1=very low)','Responsible person','identified | analyzing | treating | accepted | closed'],
      examples: [
        ['Unauthorised access to customer data','A breach of the customer database by an external attacker','Information Security',4,4,'John Smith','identified'],
        ['GDPR non-compliance','Failure to maintain adequate records of processing activities','Compliance',3,5,'Jane Doe','analyzing'],
        ['Key supplier failure','Single-source supplier goes out of business','Operational',2,4,'Operations Manager','treating'],
      ],
    },
    {
      name: 'Risk_Treatments',
      colWidths: [32, 50, 20, 15, 25],
      headers: ['risk_title','description','status','due_date','responsible'],
      notes:   ['Required. Must match a risk title exactly','What will be done','planned | in_progress | implemented | verified','YYYY-MM-DD','Person responsible'],
      examples: [
        ['Unauthorised access to customer data','Implement multi-factor authentication for all admin accounts','planned','2025-06-30','IT Security Lead'],
        ['Unauthorised access to customer data','Conduct penetration test of customer portal','in_progress','2025-04-15','IT Manager'],
        ['GDPR non-compliance','Appoint a Data Protection Officer and document all processing activities','planned','2025-07-31','Legal Counsel'],
      ],
    },
    {
      name: 'Architecture',
      colWidths: [15, 30, 45, 22, 12, 28],
      headers: ['arch_type','name','description','owner','status','parent_name'],
      notes:   ['Required: role | process | system | asset | facility','Required. Item name','What this item does / is','Owner / manager','active | inactive','Name of parent item (leave blank if none)'],
      examples: [
        ['process','Customer Onboarding','End-to-end process for onboarding new customers','Sales Director','active',''],
        ['role','Data Protection Officer','Responsible for GDPR compliance and data governance','Jane Doe','active',''],
        ['system','CRM Platform','Customer relationship management system (Salesforce)','IT Manager','active',''],
        ['asset','Customer Database','Primary PostgreSQL database containing customer PII','IT Manager','active','CRM Platform'],
        ['facility','Head Office','Main office location in Amsterdam','Facilities Manager','active',''],
      ],
    },
    {
      name: 'Requirements',
      colWidths: [18, 12, 40, 50, 22, 28],
      headers: ['standard','clause','title','description','category','process_name'],
      notes:   ['e.g. ISO 27001, ISO 9001','Required: e.g. 4.1','Required. Requirement title','Full requirement text','Category / theme','Architecture process to cross-link (leave blank if none)'],
      examples: [
        ['ISO 27001','4.1','Understanding the organisation','Determine external and internal issues relevant to the ISMS','Context','Strategic Planning'],
        ['ISO 27001','6.1.2','Information security risk assessment','Establish and apply a risk assessment process','Risk','Risk Management Process'],
        ['ISO 9001','8.1','Operational planning and control','Plan, implement, control, monitor and review processes','Operations','Customer Onboarding'],
      ],
    },
    {
      name: 'Tasks',
      colWidths: [32, 45, 22, 15, 20, 12],
      headers: ['title','description','assignee','recurrence','category','priority'],
      notes:   ['Required','What needs to be done','Person responsible','daily | weekly | biweekly | monthly | quarterly | yearly','Task category','Low | Medium | High | Critical'],
      examples: [
        ['Monthly backup verification','Verify that all system backups completed successfully and are restorable','IT Manager','monthly','IT Operations','High'],
        ['Quarterly security awareness training','Deliver security awareness training session to all staff','HR Manager','quarterly','Training','Medium'],
        ['Annual penetration test','Commission and complete external penetration test of production systems','IT Security Lead','yearly','Security','High'],
      ],
    },
    {
      name: 'Actions',
      colWidths: [32, 45, 22, 12, 15],
      headers: ['title','description','assignee','priority','due_date'],
      notes:   ['Required','Details','Person responsible','Low | Medium | High | Critical','YYYY-MM-DD'],
      examples: [
        ['Update privacy notice on website','Review and update the public privacy notice to reflect new processing activities','Legal Counsel','High','2025-05-31'],
        ['Remediate open firewall ports','Close unnecessary open ports identified in last vulnerability scan','IT Security Lead','Critical','2025-04-01'],
        ['Complete DPA with new processor','Execute a Data Processing Agreement with the new payroll provider','Legal Counsel','Medium','2025-06-15'],
      ],
    },
    {
      name: 'Nonconformities',
      colWidths: [55, 10, 12, 22, 15],
      headers: ['description','severity','clause','responsible','status'],
      notes:   ['Required. Full description of the non-conformity','minor | major','Related ISO clause e.g. 8.1','Responsible person','open | in_progress | closed | verified'],
      examples: [
        ['Backup restore procedure has not been tested in the last 12 months as required by the backup policy','minor','A.12.3','IT Manager','open'],
        ['No evidence of management review meeting held in current calendar year','major','9.3','Quality Manager','in_progress'],
        ['Third-party supplier risk assessment overdue by 6 months','minor','A.15.2','Procurement Manager','open'],
      ],
    },
    {
      name: 'Documents',
      colWidths: [35, 20, 10, 22, 12, 15],
      headers: ['title','doc_type','version','owner','status','review_date'],
      notes:   ['Required','policy | procedure | work_instruction | record | form | report | evidence | other','e.g. 1.0','Document owner','draft | review | approved | obsolete','YYYY-MM-DD'],
      examples: [
        ['Information Security Policy','policy','3.1','CISO','approved','2026-01-01'],
        ['Incident Response Procedure','procedure','2.0','IT Security Lead','approved','2025-12-01'],
        ['Risk Assessment Record – 2024','record','1.0','Risk Manager','approved',''],
        ['Access Control Work Instruction','work_instruction','1.2','IT Manager','review','2025-09-01'],
      ],
    },
  ];

  // ── Build each sheet ─────────────────────────────────────────────────────
  for (const def of sheets) {
    const wsData = [];

    if (def.name === 'Instructions') {
      wsData.push(...def.rows);
    } else {
      // Row 1: Notes / valid values
      wsData.push(def.notes);
      // Row 2: Bold column headers
      wsData.push(def.headers);
      // Example rows
      for (const ex of def.examples) {
        wsData.push(ex);
      }
    }

    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Column widths
    ws['!cols'] = def.colWidths.map(col);

    // Freeze the header row (row 2 for data sheets, row 1 for Instructions)
    if (def.name !== 'Instructions') {
      ws['!freeze'] = { xSplit: 0, ySplit: 2 };
    }

    XLSX.utils.book_append_sheet(wb, ws, def.name);
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

app.get('/api/agent/import/template', requireOrgContext, (req, res) => {
  try {
    const buf = buildImportTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="BOP_Import_Template.xlsx"');
    res.send(buf);
  } catch (err) {
    console.error('[Import Template] error:', err);
    res.status(500).json({ error: 'Failed to generate template.' });
  }
});

app.post('/api/agent/import', requireOrgContext, upload.single('file'), async (req, res) => {
  const openai = getOpenAI();
  if (!openai) return res.status(503).json({ error: 'AI Agent is not configured (missing OPENAI_API_KEY).' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  // Load user permissions
  const userRecord = await db.prepare('SELECT permissions FROM users WHERE id = $1').get(req.session.userId);
  let userPerms = [];
  try { userPerms = JSON.parse(userRecord?.permissions || '[]'); } catch (_) {}
  if (req.session.userRole === 'superadmin' || userPerms.includes('admin')) {
    userPerms = ['org', 'risk', 'ops', 'audit'];
  }

  const { data_type: hintedType, message } = req.body;
  console.log('[Import] file:', req.file.originalname, 'size:', req.file.size);

  // 1. Parse all sheets from the file
  let sheets;
  try {
    sheets = parseImportFile(req.file.buffer, req.file.originalname);
  } catch (err) {
    console.error('[Import] parse error:', err.message);
    return res.status(400).json({ error: `Could not parse file: ${err.message}` });
  }
  if (sheets.length === 0) return res.status(400).json({ error: 'File is empty or contains no importable data.' });

  const MAX_ROWS = 500;
  const sheetResults = [];
  let totalImported = 0;
  let totalSkipped = 0;

  for (const { sheetName, headers, rows } of sheets) {
    // Resolve data type: tab name takes priority, then caller hint, then OpenAI detection
    const nameKey = sheetName.toLowerCase().trim();
    let dataType = SHEET_NAME_TO_TYPE[nameKey] || (sheets.length === 1 ? hintedType : null);

    const workingRows = rows.slice(0, MAX_ROWS);
    const truncated = rows.length > MAX_ROWS;

    // Skip rows that look like the template's notes row (first cell matches a known notes phrase)
    const dataRows = workingRows.filter(r => {
      const firstVal = String(Object.values(r)[0] || '').trim();
      return firstVal !== '' && !firstVal.startsWith('Required') && !firstVal.startsWith('e.g.');
    });

    if (dataRows.length === 0) {
      console.log(`[Import] sheet "${sheetName}" skipped — no data rows after filtering notes`);
      continue;
    }

    // If type still unknown, ask OpenAI
    if (!dataType || !IMPORT_SCHEMAS[dataType]) {
      try {
        ({ data_type: dataType } = await detectAndMap(openai, headers, dataRows, hintedType, message));
        console.log(`[Import] sheet "${sheetName}" — OpenAI detected type: ${dataType}`);
      } catch (err) {
        sheetResults.push({ sheet: sheetName, error: `Type detection failed: ${err.message}` });
        continue;
      }
    }

    if (!IMPORT_SCHEMAS[dataType]) {
      sheetResults.push({ sheet: sheetName, error: `Unrecognised data type: "${dataType}"` });
      continue;
    }

    // Permission check
    const requiredPerm = IMPORT_TYPE_PERMISSIONS[dataType];
    if (!userPerms.includes(requiredPerm)) {
      sheetResults.push({ sheet: sheetName, data_type: dataType, error: `Permission denied (requires '${requiredPerm}' module access)` });
      continue;
    }

    // Get column mapping (use cached type-based mapping for named sheets, OpenAI otherwise)
    let mapping;
    try {
      ({ mapping } = await detectAndMap(openai, headers, dataRows, dataType, message));
    } catch (err) {
      sheetResults.push({ sheet: sheetName, data_type: dataType, error: `Column mapping failed: ${err.message}` });
      continue;
    }

    console.log(`[Import] sheet "${sheetName}" type=${dataType} rows=${dataRows.length} mapping=`, mapping);

    const mappedRows = applyMapping(dataRows, mapping);
    const results = await bulkInsert(dataType, mappedRows, req.orgId);

    totalImported += results.imported;
    totalSkipped  += results.skipped;
    sheetResults.push({
      sheet:     sheetName,
      data_type: dataType,
      rows:      dataRows.length,
      imported:  results.imported,
      skipped:   results.skipped,
      truncated,
      errors:    results.errors,
    });
  }

  // Build human-readable summary
  const summaryLines = [`**Import complete** — ${totalImported} record(s) imported across ${sheetResults.filter(s => !s.error).length} sheet(s).`];
  for (const s of sheetResults) {
    if (s.error) {
      summaryLines.push(`• ${s.sheet}: ⚠ ${s.error}`);
    } else {
      const line = [`• ${s.sheet} (${s.data_type}): ✓ ${s.imported} imported`];
      if (s.skipped)   line.push(`⚠ ${s.skipped} skipped`);
      if (s.truncated) line.push(`(capped at ${MAX_ROWS} rows)`);
      summaryLines.push(line.join(', '));
      if (s.errors?.length) {
        summaryLines.push(...s.errors.slice(0, 5).map(e => `  – ${e}`));
        if (s.errors.length > 5) summaryLines.push(`  – …and ${s.errors.length - 5} more`);
      }
    }
  }

  console.log('[Import] done — total imported:', totalImported, 'skipped:', totalSkipped);
  res.json({ sheets: sheetResults, imported: totalImported, skipped: totalSkipped, summary: summaryLines.join('\n') });
});

// SPA fallback
app.get('*', async (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler - must be last middleware
app.use((err, req, res, next) => {
  // Surface upload validation failures as 400 so the UI can show a helpful message
  if (err && (err instanceof multer.MulterError ||
      (typeof err.message === 'string' &&
       (err.message.startsWith('MIME type not allowed') ||
        err.message.startsWith('File type not allowed'))))) {
    return res.status(400).json({ error: err.message });
  }
  console.error('Unhandled error:', err.stack || err);
  res.status(500).json({ error: 'Internal server error' });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Start server with database initialization
let server;
async function startServer() {
  try {
    // Initialize Supabase PostgreSQL database
    await db.initDatabase();
    console.log('Database: Supabase PostgreSQL');

    server = app.listen(PORT, () => {
      console.log(`Let The Frame Work running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Graceful shutdown – Railway sends SIGTERM on deploys/restarts
function gracefulShutdown(signal) {
  console.log(`${signal} received – shutting down gracefully…`);
  if (server) {
    server.close(async () => {
      console.log('HTTP server closed');
      await db.close();
      console.log('Database pool closed');
      process.exit(0);
    });
    // Force exit after 10s if connections don't drain
    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startServer();
