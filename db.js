/**
 * Database Abstraction Layer
 * Supports both SQLite (local development) and PostgreSQL (production/Cloud Run)
 *
 * Usage:
 *   - Set DB_TYPE=postgresql and provide DB_* env vars for PostgreSQL
 *   - Default: SQLite for local development
 *
 * For SQLite: Uses synchronous better-sqlite3 API (existing code compatible)
 * For PostgreSQL: Uses async pg API (requires async/await)
 */

const path = require('path');
const { SCHEMA_SQL, POSTGRES_SCHEMA_SQL, DEFAULT_THREAT_FEEDS } = require('./schema');

// Determine database type from environment
const DB_TYPE = process.env.DB_TYPE || 'sqlite';

let db;
let isPostgres = false;
let initialized = false;

/**
 * Initialize the database connection
 */
async function initDatabase() {
  if (initialized) return db;

  if (DB_TYPE === 'postgresql' || DB_TYPE === 'postgres') {
    isPostgres = true;
    const { Pool } = require('pg');

    // Cloud Run connects via Unix socket, local dev uses TCP
    const connectionConfig = {
      user: process.env.DB_USER || 'appuser',
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'lettheframework',
    };

    // Check if we're connecting via Cloud SQL socket or TCP
    if (process.env.CLOUD_SQL_CONNECTION_NAME) {
      connectionConfig.host = `/cloudsql/${process.env.CLOUD_SQL_CONNECTION_NAME}`;
    } else {
      connectionConfig.host = process.env.DB_HOST || 'localhost';
      connectionConfig.port = parseInt(process.env.DB_PORT || '5432');
    }

    db = new Pool(connectionConfig);

    // Test connection
    try {
      await db.query('SELECT 1');
      console.log('Connected to PostgreSQL database');
    } catch (err) {
      console.error('PostgreSQL connection error:', err.message);
      throw err;
    }

    // Initialize schema for PostgreSQL
    await initPostgresSchema();
  } else {
    // SQLite for local development
    isPostgres = false;
    const Database = require('better-sqlite3');
    db = new Database(path.join(__dirname, 'tasks.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    console.log('Connected to SQLite database');

    // Initialize schema for SQLite (synchronous)
    initSQLiteSchema();
  }

  initialized = true;
  return db;
}

/**
 * Initialize SQLite schema (synchronous)
 */
function initSQLiteSchema() {
  try {
    db.exec(SCHEMA_SQL);

    // Run migrations
    const migrations = [
      "ALTER TABLE users ADD COLUMN password TEXT DEFAULT NULL",
      "ALTER TABLE standard_requirements ADD COLUMN owner TEXT DEFAULT ''",
      "ALTER TABLE documents ADD COLUMN classification TEXT DEFAULT ''",
      "ALTER TABLE soa_entries ADD COLUMN linked_processes TEXT DEFAULT '[]'",
      "ALTER TABLE audits ADD COLUMN auditee TEXT DEFAULT ''",
      "ALTER TABLE audits ADD COLUMN recurrence TEXT DEFAULT 'none'",
      "ALTER TABLE audits ADD COLUMN recurrence_end_date TEXT DEFAULT NULL",
      "ALTER TABLE audits ADD COLUMN parent_audit_id INTEGER DEFAULT NULL",
      "ALTER TABLE audits ADD COLUMN instance_number INTEGER DEFAULT 1",
      "ALTER TABLE audits ADD COLUMN standards TEXT DEFAULT '[]'",
      "ALTER TABLE audit_checklist ADD COLUMN standard TEXT DEFAULT ''",
      "ALTER TABLE audit_checklist ADD COLUMN evidence_files TEXT DEFAULT '[]'",
      "ALTER TABLE soa_entries ADD COLUMN regulatory INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN sso_provider TEXT DEFAULT NULL",
    ];

    for (const sql of migrations) {
      try { db.exec(sql); } catch (e) { /* column already exists */ }
    }

    // Seed default data
    seedSQLiteData();
    console.log('SQLite schema initialized');
  } catch (err) {
    console.error('SQLite schema initialization error:', err);
    throw err;
  }
}

/**
 * Seed default data for SQLite
 */
function seedSQLiteData() {
  const bcrypt = require('bcryptjs');

  // Check if admin user exists
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users WHERE password IS NOT NULL').get();
  if (userCount.c === 0) {
    const hashedPassword = bcrypt.hashSync('Hey!', 10);
    try {
      db.prepare(
        "INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, 'admin', 'active')"
      ).run('Henk', 'admin@lettheframework.local', hashedPassword);
      console.log('Default admin user created: admin@lettheframework.local');
    } catch (e) {
      // User might already exist
    }
  }

  // Seed threat feeds if none exist
  const feedCount = db.prepare('SELECT COUNT(*) as c FROM threat_feeds').get();
  if (feedCount.c === 0) {
    const stmt = db.prepare('INSERT INTO threat_feeds (name, url, tier) VALUES (?, ?, ?)');
    for (const f of DEFAULT_THREAT_FEEDS) {
      stmt.run(f.name, f.url, f.tier);
    }
    console.log('Default threat feeds seeded');
  }

  // Ensure org_mission has at least one row
  const missionRow = db.prepare('SELECT COUNT(*) as c FROM org_mission').get();
  if (missionRow.c === 0) {
    db.prepare("INSERT INTO org_mission (content) VALUES ('')").run();
  }

  // Initialize SAML config if not exists
  const samlConfig = db.prepare('SELECT COUNT(*) as c FROM saml_config').get();
  if (samlConfig.c === 0) {
    try {
      db.prepare('INSERT INTO saml_config (id, enabled) VALUES (1, 0)').run();
    } catch (e) {
      // Already exists
    }
  }
}

/**
 * Initialize PostgreSQL schema (async)
 */
async function initPostgresSchema() {
  try {
    // Execute each CREATE TABLE statement separately
    const statements = POSTGRES_SCHEMA_SQL.split(';').filter(s => s.trim());
    for (const stmt of statements) {
      if (stmt.trim()) {
        try {
          await db.query(stmt);
        } catch (err) {
          // Ignore "already exists" errors
          if (!err.message.includes('already exists')) {
            console.error('Schema statement error:', err.message);
          }
        }
      }
    }

    // Seed default data
    await seedPostgresData();
    console.log('PostgreSQL schema initialized');
  } catch (err) {
    console.error('PostgreSQL schema initialization error:', err);
    throw err;
  }
}

/**
 * Seed default data for PostgreSQL
 */
async function seedPostgresData() {
  const bcrypt = require('bcryptjs');

  // Check if admin user exists
  const userResult = await db.query('SELECT COUNT(*) as c FROM users WHERE password IS NOT NULL');
  if (parseInt(userResult.rows[0].c) === 0) {
    const hashedPassword = bcrypt.hashSync('Hey!', 10);
    try {
      await db.query(
        "INSERT INTO users (name, email, password, role, status) VALUES ($1, $2, $3, 'admin', 'active')",
        ['Henk', 'admin@lettheframework.local', hashedPassword]
      );
      console.log('Default admin user created: admin@lettheframework.local');
    } catch (e) {
      // User might already exist
    }
  }

  // Seed threat feeds if none exist
  const feedResult = await db.query('SELECT COUNT(*) as c FROM threat_feeds');
  if (parseInt(feedResult.rows[0].c) === 0) {
    for (const f of DEFAULT_THREAT_FEEDS) {
      await db.query('INSERT INTO threat_feeds (name, url, tier) VALUES ($1, $2, $3)', [f.name, f.url, f.tier]);
    }
    console.log('Default threat feeds seeded');
  }

  // Ensure org_mission has at least one row
  const missionResult = await db.query('SELECT COUNT(*) as c FROM org_mission');
  if (parseInt(missionResult.rows[0].c) === 0) {
    await db.query("INSERT INTO org_mission (content) VALUES ('')");
  }

  // Initialize SAML config if not exists
  const samlResult = await db.query('SELECT COUNT(*) as c FROM saml_config');
  if (parseInt(samlResult.rows[0].c) === 0) {
    try {
      await db.query('INSERT INTO saml_config (id, enabled) VALUES (1, 0)');
    } catch (e) {
      // Already exists
    }
  }
}

/**
 * Convert SQLite SQL to PostgreSQL SQL
 */
function convertToPostgres(sql) {
  let converted = sql;

  // Replace ? placeholders with $1, $2, etc.
  let paramIndex = 0;
  converted = converted.replace(/\?/g, () => `$${++paramIndex}`);

  // Replace datetime('now') with NOW()
  converted = converted.replace(/datetime\('now'\)/gi, 'NOW()');
  converted = converted.replace(/datetime\('now', 'localtime'\)/gi, 'NOW()');

  // Replace date('now') with CURRENT_DATE
  converted = converted.replace(/date\('now'\)/gi, 'CURRENT_DATE');
  converted = converted.replace(/date\("now"\)/gi, 'CURRENT_DATE');

  // Replace SQLite date functions with PostgreSQL equivalents
  converted = converted.replace(/date\('now',\s*'([^']+)'\)/gi, (match, modifier) => {
    // Convert SQLite date modifiers to PostgreSQL
    if (modifier.startsWith('-')) {
      return `CURRENT_DATE + INTERVAL '${modifier}'`;
    } else if (modifier.startsWith('+')) {
      return `CURRENT_DATE + INTERVAL '${modifier}'`;
    } else if (modifier === 'start of month') {
      return `DATE_TRUNC('month', CURRENT_DATE)`;
    }
    return 'CURRENT_DATE';
  });

  // Handle more complex date expressions
  converted = converted.replace(/date\('now',\s*'start of month'\)/gi, "DATE_TRUNC('month', CURRENT_DATE)");
  converted = converted.replace(/date\('now',\s*'start of month',\s*'([^']+)'\)/gi, (match, modifier) => {
    return `DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '${modifier}'`;
  });

  return converted;
}

// ============================================================================
// ASYNC API (for PostgreSQL, also works with SQLite via promises)
// ============================================================================

/**
 * Execute a query that returns rows (SELECT) - ASYNC
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Array>} - Array of rows
 */
async function all(sql, ...params) {
  const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;

  if (isPostgres) {
    const pgSql = convertToPostgres(sql);
    const result = await db.query(pgSql, flatParams);
    return result.rows;
  } else {
    return db.prepare(sql).all(...flatParams);
  }
}

/**
 * Execute a query that returns a single row - ASYNC
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Object|undefined>} - Single row or undefined
 */
async function get(sql, ...params) {
  const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;

  if (isPostgres) {
    const pgSql = convertToPostgres(sql);
    const result = await db.query(pgSql, flatParams);
    return result.rows[0];
  } else {
    return db.prepare(sql).get(...flatParams);
  }
}

/**
 * Execute a query that modifies data (INSERT, UPDATE, DELETE) - ASYNC
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<{lastInsertRowid: number, changes: number}>}
 */
async function run(sql, ...params) {
  const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;

  if (isPostgres) {
    let pgSql = convertToPostgres(sql);

    // Handle INSERT OR IGNORE
    if (sql.toUpperCase().includes('INSERT OR IGNORE')) {
      pgSql = pgSql.replace(/INSERT INTO/i, 'INSERT INTO');
      // Add ON CONFLICT DO NOTHING after VALUES clause
      if (!pgSql.toUpperCase().includes('ON CONFLICT')) {
        pgSql = pgSql.replace(/(\)\s*)$/i, ') ON CONFLICT DO NOTHING');
      }
    }

    // For INSERT, add RETURNING id to get the inserted ID
    const isInsert = pgSql.trim().toUpperCase().startsWith('INSERT');
    if (isInsert && !pgSql.toUpperCase().includes('RETURNING')) {
      pgSql = pgSql.replace(/;?\s*$/, ' RETURNING id;');
    }

    const result = await db.query(pgSql, flatParams);
    return {
      lastInsertRowid: result.rows[0]?.id || 0,
      changes: result.rowCount
    };
  } else {
    const result = db.prepare(sql).run(...flatParams);
    return {
      lastInsertRowid: result.lastInsertRowid,
      changes: result.changes
    };
  }
}

/**
 * Execute raw SQL (for schema creation, etc.) - ASYNC
 * @param {string} sql - SQL to execute
 */
async function exec(sql) {
  if (isPostgres) {
    let pgSql = convertToPostgres(sql);
    await db.query(pgSql);
  } else {
    db.exec(sql);
  }
}

// ============================================================================
// SYNC API (for SQLite backward compatibility in existing server.js code)
// ============================================================================

/**
 * Get a prepared statement interface for SQLite compatibility
 * For PostgreSQL, this returns a wrapper that queues operations
 */
function prepare(sql) {
  if (isPostgres) {
    // Return a wrapper for PostgreSQL that mimics better-sqlite3 interface
    // Note: These are still async under the hood, used with .then() in routes
    return {
      get: (...params) => get(sql, ...params),
      all: (...params) => all(sql, ...params),
      run: (...params) => run(sql, ...params),
    };
  } else {
    // Direct SQLite prepared statement
    return db.prepare(sql);
  }
}

/**
 * Check if using PostgreSQL
 */
function isPostgreSQL() {
  return isPostgres;
}

/**
 * Get the raw database connection (for advanced use)
 */
function getConnection() {
  return db;
}

/**
 * Close the database connection
 */
async function close() {
  if (isPostgres) {
    await db.end();
  } else {
    db.close();
  }
}

/**
 * Execute a function within a transaction - ASYNC
 * @param {Function} fn - Async function to execute within transaction
 * @returns {Promise<any>} - Result of the function
 */
async function transaction(fn) {
  if (isPostgres) {
    const client = await db.connect();
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
  } else {
    // For SQLite with async functions, manually handle BEGIN/COMMIT
    // Since SQLite operations are synchronous under the hood, the async
    // function executes synchronously and we can wrap it properly
    db.exec('BEGIN');
    try {
      const result = await fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

module.exports = {
  // Initialization
  initDatabase,

  // Async API (recommended for new code)
  all,
  get,
  run,
  exec,
  transaction,

  // Sync-compatible API (for existing server.js code)
  prepare,

  // Utilities
  isPostgreSQL,
  getConnection,
  close,
};
