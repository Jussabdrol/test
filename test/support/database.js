const { PGlite } = require('@electric-sql/pglite');
// Actual PostgreSQL engine, isolated from Railway/Supabase. Pool scheduling is
// simulated because PGlite has one connection; separate unit tests cover routing.
class TestPool {
  constructor() { this.engine = new PGlite(); this.tail = Promise.resolve(); TestPool.instance = this; }
  on() {}
  async acquire() {
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    return release;
  }
  async execute(sql, params) {
    const result = params?.length ? await this.engine.query(sql, params) : (await this.engine.exec(sql)).at(-1);
    return { rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  }
  async query(sql, params) { const release = await this.acquire(); try { return await this.execute(sql, params); } finally { release(); } }
  async connect() { const release = await this.acquire(); return { query: this.execute.bind(this), release }; }
  async end() { await this.engine.close(); }
}
function installTestDatabase() {
  require('pg').Pool = TestPool;
  const db = require('../../src/server/database');
  const init = db.initDatabase;
  db.initDatabase = async (...args) => {
    await init(...args);
    await db.exec("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END $$;");
    await db.exec(require('node:fs').readFileSync(require('node:path').join(__dirname, '../../supabase/migrations/20260919111330_commerce_licensing.sql'), 'utf8'));
  };
  return db;
}
module.exports = { installTestDatabase, TestPool };
