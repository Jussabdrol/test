const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerAuthRoutes } = require('../../src/server/routes/auth');

test('a stale provider password cannot bypass the current local password', async () => {
  let login, providerCalls = 0;
  const user = { id: 1, email: 'admin@example.invalid', role: 'superadmin', password: 'current-hash', supabase_uid: 'expected-uid' };
  registerAuthRoutes({
    get() {}, put() {}, post(path, ...handlers) { if (path === '/api/auth/login') login = handlers.at(-1); },
  }, {
    db: { prepare: () => ({ get: async () => user, run: async () => ({}) }) },
    bcrypt: { compare: async password => password === 'current-password' },
    supabase: { auth: { signInWithPassword: async () => { providerCalls++; return { data: { user: { id: 'expected-uid' } } }; } } },
  });
  const run = async password => {
    const req = { body: { email: user.email, password }, session: { save: cb => cb() } };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await login(req, res); return res;
  };
  assert.equal((await run('old-provider-password')).code, 401);
  assert.equal((await run('current-password')).code, 200);
  assert.equal(providerCalls, 0);
  user.password = null;
  assert.equal((await run('provider-only-password')).code, 200);
  user.supabase_uid = 'different-uid';
  assert.equal((await run('provider-only-password')).code, 401);
});
