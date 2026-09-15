const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerAgentRoutes } = require('../../src/server/routes/agent');

test('AI chat loads field options for the request organization before calling the model', async () => {
  let handler, payload, response;
  const organizations = [];
  const db = {
    prepare(sql) {
      return {
        async get() { return { permissions: '["org"]' }; },
        async all(orgId) {
          organizations.push(orgId);
          if (sql.includes('FROM risks')) return [{ category: 'Risk category 42' }];
          if (sql.includes('FROM tasks')) return [{ category: 'Task category 42' }];
          return [{ name: 'Member 42' }];
        },
      };
    },
  };
  registerAgentRoutes({ post(path, ...handlers) { handler = handlers.at(-1); } }, {
    db,
    requireOrgContext() {},
    getOpenAI: () => ({ chat: { completions: { async create(value) {
      payload = value;
      return { choices: [{ message: { content: 'Ready' } }] };
    } } } }),
  });
  const res = { status(code) { assert.fail(`Unexpected HTTP ${code}`); }, json(value) { response = value; } };
  await handler({ orgId: 42, session: { userId: 7, userRole: 'member' }, body: { message: 'Show my options' } }, res);
  assert.deepEqual(organizations, [42, 42, 42]);
  assert.match(payload.messages[0].content, /Risk category 42/);
  assert.match(payload.messages[0].content, /Task category 42/);
  assert.match(payload.messages[0].content, /Member 42/);
  assert.deepEqual(response, { reply: 'Ready' });
});
