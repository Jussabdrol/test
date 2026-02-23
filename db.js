/**
 * Database Layer – Supabase PostgreSQL
 * Multi-tenant / MSP edition
 *
 * Required env vars:
 *   SUPABASE_DB_URL   – full postgres connection string
 *   OR: SUPABASE_DB_HOST / SUPABASE_DB_PORT / SUPABASE_DB_USER / SUPABASE_DB_PASSWORD / SUPABASE_DB_NAME
 *
 *   SUPERADMIN_EMAIL    – email for the built-in superadmin (default: superadmin@bop.local)
 *   SUPERADMIN_PASSWORD – password for the built-in superadmin (default: ChangeMe!123)
 */

const { Pool } = require('pg');
const { POSTGRES_SCHEMA_SQL, DEFAULT_THREAT_FEEDS } = require('./schema');

let pool;
let initialized = false;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

async function initDatabase() {
  if (initialized) return pool;

  const connectionConfig = process.env.SUPABASE_DB_URL
    ? { connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } }
    : {
        host: process.env.SUPABASE_DB_HOST || 'localhost',
        port: parseInt(process.env.SUPABASE_DB_PORT || '6543'),
        user: process.env.SUPABASE_DB_USER || 'postgres',
        password: process.env.SUPABASE_DB_PASSWORD || '',
        database: process.env.SUPABASE_DB_NAME || 'postgres',
        ssl: { rejectUnauthorized: false },
      };

  connectionConfig.max = parseInt(process.env.DB_POOL_MAX || '10');
  connectionConfig.idleTimeoutMillis = 30000;
  connectionConfig.connectionTimeoutMillis = 10000;

  pool = new Pool(connectionConfig);

  try {
    await pool.query('SELECT 1');
    console.log('Connected to Supabase PostgreSQL database');
  } catch (err) {
    console.error('Supabase PostgreSQL connection error:', err.message);
    throw err;
  }

  await initSchema();
  initialized = true;
  return pool;
}

async function initSchema() {
  try {
    // Run schema SQL — split on ; but skip empty statements
    const statements = POSTGRES_SCHEMA_SQL.split(';').filter(s => s.trim());
    for (const stmt of statements) {
      if (stmt.trim()) {
        try {
          await pool.query(stmt);
        } catch (err) {
          // Silently skip "already exists" and benign migration errors
          const msg = err.message.toLowerCase();
          if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
            console.error('Schema statement error:', err.message.substring(0, 120));
          }
        }
      }
    }

    // Post-schema migrations that can't be expressed as simple SQL strings
    await runMigrations();
    await seedData();
    console.log('PostgreSQL schema initialized (multi-tenant)');
  } catch (err) {
    console.error('Schema initialization error:', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Post-schema migrations
// ---------------------------------------------------------------------------

async function runMigrations() {
  // 1. Update users.role constraint to include MSP roles.
  //    We drop the old constraint (if any) and add the expanded one.
  try {
    await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
  } catch (e) { /* ignore */ }
  try {
    await pool.query(`
      ALTER TABLE users ADD CONSTRAINT users_role_check
        CHECK (role IN ('viewer','user','manager','admin','superadmin','org_admin','org_user'))
    `);
  } catch (e) { /* constraint may already exist with the right definition */ }

  // 2. Assign all existing orphaned data to the default organisation (id = 1).
  //    This is a no-op when org_id is already populated.
  const tables = [
    'tasks','completions','actions','audits','audit_checklist','non_conformities',
    'standard_requirements','risks','risk_treatments','soa_entries','org_mission',
    'org_kpis','org_architecture','documents','cross_links','threat_feeds',
  ];
  for (const t of tables) {
    try {
      await pool.query(
        `UPDATE ${t} SET organization_id = 1 WHERE organization_id IS NULL`
      );
    } catch (e) { /* column may not exist yet on very first boot – that's fine */ }
  }

  // 3. Ensure existing users without an org belong to the default org (unless superadmin)
  try {
    await pool.query(`
      UPDATE users SET organization_id = 1
      WHERE organization_id IS NULL AND role != 'superadmin'
    `);
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

async function seedData() {
  const bcrypt = require('bcryptjs');

  // ── 1. Default organisation ──────────────────────────────────────────────
  const orgCount = await pool.query('SELECT COUNT(*) as c FROM organizations');
  if (parseInt(orgCount.rows[0].c) === 0) {
    await pool.query(
      `INSERT INTO organizations (id, name, slug, is_active, plan) VALUES (1, 'Default Organization', 'default', 1, 'standard')
       ON CONFLICT DO NOTHING`
    );
    // Reset sequence so next org starts at 2
    try { await pool.query(`SELECT setval('organizations_id_seq', 1, true)`); } catch (e) {}
    console.log('Default organisation created');
  }

  // ── 2. Superadmin user ───────────────────────────────────────────────────
  const superadminEmail = process.env.SUPERADMIN_EMAIL || 'superadmin@bop.local';
  const existingSA = await pool.query('SELECT id FROM users WHERE role = $1', ['superadmin']);
  if (parseInt(existingSA.rowCount) === 0) {
    const saPassword = process.env.SUPERADMIN_PASSWORD || 'ChangeMe!123';
    const hashedSA = bcrypt.hashSync(saPassword, 10);
    try {
      await pool.query(
        `INSERT INTO users (name, email, password, role, organization_id, status)
         VALUES ($1, $2, $3, 'superadmin', NULL, 'active')`,
        ['Super Admin', superadminEmail, hashedSA]
      );
      console.log(`Superadmin created: ${superadminEmail} / ${saPassword}`);
      console.log('⚠️  CHANGE THE SUPERADMIN PASSWORD BEFORE GOING TO PRODUCTION!');
    } catch (e) { /* already exists */ }
  }

  // ── 3. Legacy admin user (for backwards compat on existing installs) ─────
  const userCount = await pool.query(`SELECT COUNT(*) as c FROM users WHERE password IS NOT NULL AND role != 'superadmin'`);
  if (parseInt(userCount.rows[0].c) === 0) {
    const hashedPassword = bcrypt.hashSync('Hey!', 10);
    try {
      await pool.query(
        `INSERT INTO users (name, email, password, role, organization_id, status)
         VALUES ($1, $2, $3, 'org_admin', 1, 'active')`,
        ['Henk', 'admin@bop.local', hashedPassword]
      );
      console.log('Default org admin created: admin@bop.local');
    } catch (e) { /* already exists */ }
  }

  // ── 4. Threat feeds for the default org ──────────────────────────────────
  const feedCount = await pool.query('SELECT COUNT(*) as c FROM threat_feeds WHERE organization_id = 1');
  if (parseInt(feedCount.rows[0].c) === 0) {
    for (const f of DEFAULT_THREAT_FEEDS) {
      await pool.query(
        'INSERT INTO threat_feeds (name, url, tier, organization_id) VALUES ($1, $2, $3, 1)',
        [f.name, f.url, f.tier]
      );
    }
    console.log('Default threat feeds seeded for org 1');
  }

  // ── 5. Mission singleton for default org ─────────────────────────────────
  const missionCount = await pool.query('SELECT COUNT(*) as c FROM org_mission WHERE organization_id = 1');
  if (parseInt(missionCount.rows[0].c) === 0) {
    await pool.query(`INSERT INTO org_mission (content, organization_id) VALUES ('', 1)`);
  }

  // ── 6. SAML config singleton ──────────────────────────────────────────────
  const samlCount = await pool.query('SELECT COUNT(*) as c FROM saml_config');
  if (parseInt(samlCount.rows[0].c) === 0) {
    try {
      await pool.query('INSERT INTO saml_config (id, enabled) VALUES (1, 0)');
    } catch (e) { /* already exists */ }
  }
}

// ---------------------------------------------------------------------------
// SQL helpers – convert SQLite-isms to PostgreSQL
// ---------------------------------------------------------------------------

function convertSQL(sql) {
  let converted = sql;

  // Replace ? placeholders with $1, $2, …
  let paramIndex = 0;
  converted = converted.replace(/\?/g, () => `$${++paramIndex}`);

  converted = converted.replace(/datetime\('now'\)/gi, 'NOW()');
  converted = converted.replace(/datetime\('now',\s*'localtime'\)/gi, 'NOW()');
  converted = converted.replace(/date\('now'\)/gi, 'CURRENT_DATE');
  converted = converted.replace(/date\("now"\)/gi, 'CURRENT_DATE');

  converted = converted.replace(/date\('now',\s*'start of month',\s*'([^']+)'\)/gi, (_, mod) =>
    `DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '${mod}'`
  );
  converted = converted.replace(/date\('now',\s*'start of month'\)/gi, "DATE_TRUNC('month', CURRENT_DATE)");
  converted = converted.replace(/date\('now',\s*'([^']+)'\)/gi, (_, mod) =>
    `CURRENT_DATE + INTERVAL '${mod}'`
  );

  if (/INSERT\s+OR\s+IGNORE/i.test(converted)) {
    converted = converted.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
    if (!converted.toUpperCase().includes('ON CONFLICT')) {
      converted = converted.replace(/(\)\s*)$/i, ') ON CONFLICT DO NOTHING');
    }
  }

  return converted;
}

// ---------------------------------------------------------------------------
// Async query API
// ---------------------------------------------------------------------------

async function all(sql, ...params) {
  const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  const pgSql = convertSQL(sql);
  const result = await pool.query(pgSql, flatParams);
  return result.rows;
}

async function get(sql, ...params) {
  const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  const pgSql = convertSQL(sql);
  const result = await pool.query(pgSql, flatParams);
  return result.rows[0];
}

async function run(sql, ...params) {
  const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  let pgSql = convertSQL(sql);

  const isInsert = pgSql.trim().toUpperCase().startsWith('INSERT');
  if (isInsert && !pgSql.toUpperCase().includes('RETURNING')) {
    pgSql = pgSql.replace(/;?\s*$/, ' RETURNING id;');
  }

  const result = await pool.query(pgSql, flatParams);
  return {
    lastInsertRowid: result.rows[0]?.id || 0,
    changes: result.rowCount,
  };
}

async function exec(sql) {
  const pgSql = convertSQL(sql);
  await pool.query(pgSql);
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function prepare(sql) {
  return {
    get: (...params) => get(sql, ...params),
    all: (...params) => all(sql, ...params),
    run: (...params) => run(sql, ...params),
  };
}

function isPostgreSQL() { return true; }
function getConnection() { return pool; }
async function close() { if (pool) await pool.end(); }

module.exports = {
  initDatabase,
  all,
  get,
  run,
  exec,
  transaction,
  prepare,
  isPostgreSQL,
  getConnection,
  close,
};
