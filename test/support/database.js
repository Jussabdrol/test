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
  return require('../../src/server/database');
}
module.exports = { installTestDatabase, TestPool };
