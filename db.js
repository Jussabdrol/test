/**
 * Database Layer – Supabase PostgreSQL
 *
 * Connects directly to the Supabase PostgreSQL database using the 'pg' library.
 * All SQLite / better-sqlite3 code has been removed.
 *
 * Required env vars:
 *   SUPABASE_DB_URL   – full postgres connection string (pooler or direct)
 *                        e.g. postgresql://postgres.[ref]:[password]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres
 *   OR the individual pieces:
 *     SUPABASE_DB_HOST, SUPABASE_DB_PORT, SUPABASE_DB_USER, SUPABASE_DB_PASSWORD, SUPABASE_DB_NAME
 *
 * The module exposes the same async API the rest of the app already uses:
 *   all, get, run, exec, transaction, prepare, isPostgreSQL, getConnection, close
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

  // Build connection config from env vars
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

  // Serverless-friendly pool settings
  connectionConfig.max = parseInt(process.env.DB_POOL_MAX || '10');
  connectionConfig.idleTimeoutMillis = 30000;
  connectionConfig.connectionTimeoutMillis = 10000;

  pool = new Pool(connectionConfig);

  // Test connection
  try {
    await pool.query('SELECT 1');
    console.log('Connected to Supabase PostgreSQL database');
  } catch (err) {
    console.error('Supabase PostgreSQL connection error:', err.message);
    throw err;
  }

  // Initialise schema & seed data
  await initSchema();

  initialized = true;
  return pool;
}

async function initSchema() {
  try {
    const statements = POSTGRES_SCHEMA_SQL.split(';').filter(s => s.trim());
    for (const stmt of statements) {
      if (stmt.trim()) {
        try {
          await pool.query(stmt);
        } catch (err) {
          if (!err.message.includes('already exists')) {
            console.error('Schema statement error:', err.message);
          }
        }
      }
    }
    await seedData();
    console.log('PostgreSQL schema initialized');
  } catch (err) {
    console.error('Schema initialization error:', err);
    throw err;
  }
}

async function seedData() {
  const bcrypt = require('bcryptjs');

  // Admin user
  const userResult = await pool.query('SELECT COUNT(*) as c FROM users WHERE password IS NOT NULL');
  if (parseInt(userResult.rows[0].c) === 0) {
    const hashedPassword = bcrypt.hashSync('Hey!', 10);
    try {
      await pool.query(
        "INSERT INTO users (name, email, password, role, status) VALUES ($1, $2, $3, 'admin', 'active')",
        ['Henk', 'admin@lettheframework.local', hashedPassword]
      );
      console.log('Default admin user created: admin@lettheframework.local');
    } catch (e) { /* already exists */ }
  }

  // Threat feeds
  const feedResult = await pool.query('SELECT COUNT(*) as c FROM threat_feeds');
  if (parseInt(feedResult.rows[0].c) === 0) {
    for (const f of DEFAULT_THREAT_FEEDS) {
      await pool.query('INSERT INTO threat_feeds (name, url, tier) VALUES ($1, $2, $3)', [f.name, f.url, f.tier]);
    }
    console.log('Default threat feeds seeded');
  }

  // Mission row
  const missionResult = await pool.query('SELECT COUNT(*) as c FROM org_mission');
  if (parseInt(missionResult.rows[0].c) === 0) {
    await pool.query("INSERT INTO org_mission (content) VALUES ('')");
  }

  // SAML config singleton
  const samlResult = await pool.query('SELECT COUNT(*) as c FROM saml_config');
  if (parseInt(samlResult.rows[0].c) === 0) {
    try {
      await pool.query('INSERT INTO saml_config (id, enabled) VALUES (1, 0)');
    } catch (e) { /* already exists */ }
  }
}

// ---------------------------------------------------------------------------
// SQL helpers – convert SQLite-isms that still appear in server.js queries
// ---------------------------------------------------------------------------

function convertSQL(sql) {
  let converted = sql;

  // Replace ? placeholders with $1, $2, …
  let paramIndex = 0;
  converted = converted.replace(/\?/g, () => `$${++paramIndex}`);

  // datetime('now') → NOW()
  converted = converted.replace(/datetime\('now'\)/gi, 'NOW()');
  converted = converted.replace(/datetime\('now',\s*'localtime'\)/gi, 'NOW()');

  // date('now') → CURRENT_DATE
  converted = converted.replace(/date\('now'\)/gi, 'CURRENT_DATE');
  converted = converted.replace(/date\("now"\)/gi, 'CURRENT_DATE');

  // date('now', 'start of month', '-1 month') etc.
  converted = converted.replace(/date\('now',\s*'start of month',\s*'([^']+)'\)/gi, (_, mod) => {
    return `DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '${mod}'`;
  });
  converted = converted.replace(/date\('now',\s*'start of month'\)/gi, "DATE_TRUNC('month', CURRENT_DATE)");

  // date('now', '-N days') etc.
  converted = converted.replace(/date\('now',\s*'([^']+)'\)/gi, (_, mod) => {
    return `CURRENT_DATE + INTERVAL '${mod}'`;
  });

  // INSERT OR IGNORE → INSERT … ON CONFLICT DO NOTHING
  if (/INSERT\s+OR\s+IGNORE/i.test(converted)) {
    converted = converted.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
    if (!converted.toUpperCase().includes('ON CONFLICT')) {
      converted = converted.replace(/(\)\s*)$/i, ') ON CONFLICT DO NOTHING');
    }
  }

  // ON CONFLICT … DO UPDATE (SQLite upsert) – keep as-is, valid PG syntax
  // substr() → substring() (PG alias also accepts substr, but be safe)
  // Actually PG supports substr natively so no change needed.

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

  // For INSERTs, add RETURNING id so we can get lastInsertRowid
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

// ---------------------------------------------------------------------------
// Compatibility shim – db.prepare(sql).get / .all / .run
// Returns an object whose methods are async (returns Promises).
// Every call-site in server.js already uses `await`, so this works.
// ---------------------------------------------------------------------------

function prepare(sql) {
  return {
    get: (...params) => get(sql, ...params),
    all: (...params) => all(sql, ...params),
    run: (...params) => run(sql, ...params),
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isPostgreSQL() {
  return true; // Always PostgreSQL now
}

function getConnection() {
  return pool;
}

async function close() {
  if (pool) await pool.end();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

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
