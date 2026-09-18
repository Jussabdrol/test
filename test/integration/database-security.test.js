const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { POSTGRES_SCHEMA_SQL } = require('../../src/server/database/schema');
test('Data API roles cannot access tenant tables or security fields after migration', async () => {
  const pg = new PGlite();
  try {
    await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
    await pg.exec(POSTGRES_SCHEMA_SQL);
    await pg.exec("INSERT INTO organizations(name,slug) VALUES ('Synthetic','synthetic'); INSERT INTO users(name,email,role,organization_id) VALUES ('Member','test@example.invalid','org_user',1);");
    await pg.exec('GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;');
    const migration = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20260918145726_restrict_bop_data_api.sql'), 'utf8');
    await pg.exec(migration);
    await pg.exec(migration); // safe retry
    for (const role of ['anon','authenticated']) {
      await pg.exec(`SET ROLE ${role}`);
      for (const sql of ['SELECT role,password FROM public.users', "UPDATE public.users SET role='superadmin' WHERE id=1", 'SELECT * FROM public.use_cases', "INSERT INTO public.use_cases(organization_id,title) VALUES (1,'Blocked')"]) {
        await assert.rejects(pg.query(sql), /permission denied/);
      }
      await pg.exec('RESET ROLE');
    }
    await pg.exec('SET ROLE service_role');
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM public.users')).rows[0].n,1);
    await pg.exec('RESET ROLE');
    assert.equal((await pg.query("SELECT role FROM users WHERE id=1")).rows[0].role,'org_user');
    await pg.exec('CREATE TABLE public.future_private_table(id int)');
    assert.equal((await pg.query("SELECT has_table_privilege('anon','public.future_private_table','SELECT') AS allowed")).rows[0].allowed,false);
  } finally { await pg.close(); }
});
