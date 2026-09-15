const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

test('test preload blocks real PostgreSQL clients and external network connections', async () => {
  assert.throws(() => new (require('pg').Pool)(), /Real PostgreSQL connections are disabled/);
  assert.throws(() => net.connect({ host: 'example.invalid', port: 443 }), /External network/);
  assert.throws(() => new net.Socket().connect(443, 'example.invalid'), /External network/);
  await assert.rejects(fetch('https://example.invalid'), /fetch failed|External network/);
  assert.equal(process.env.SUPABASE_DB_URL, undefined);
  assert.equal(process.env.OPENAI_API_KEY, undefined);
});
