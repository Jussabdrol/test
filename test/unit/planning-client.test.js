const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

// Use the actual page's element IDs. A fixture that invented IDs would miss a
// broken modal even though all HTTP workflows passed.
function pageContext() {
  const ids = [...fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  const elements = new Map(ids.map(id => [id, {
    value: '', textContent: '', innerHTML: '', dataset: {}, style: {},
    classList: { remove() {}, add() {} },
  }]));
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id) || null },
    currentUser: { name: 'Tester' }, esc: String,
    lastInstanceContext: null,
    api: async url => url.includes('/task-instances/')
      ? { id: 42, task_id: 5, task_title: 'Access review', scheduled_date: '2026-04-30', notes: 'Retain existing work' }
      : [],
  });
  return { context, elements };
}

test('opening an execution from the plan uses real page controls and preserves its date and notes', async () => {
  const { context, elements } = pageContext();
  vm.runInContext(fs.readFileSync(path.join(root, 'src/client/operations/tasks.js'), 'utf8'), context);
  await vm.runInContext('openInstanceCompleteModal(42)', context);
  assert.equal(elements.get('complete-form').dataset.instanceId, 42);
  assert.match(elements.get('complete-modal-title').textContent, /Access review.*2026-04-30/);
  assert.equal(elements.get('complete-notes').value, 'Retain existing work');
});

test('a stale date selection never falls back to completing a different occurrence', async () => {
  const { context } = pageContext();
  let fallback = false, refreshed = false;
  Object.assign(context, {
    api: async () => [], showToast() {},
    openCompleteModal: () => { fallback = true; },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/client/operations/yearly-plan.js'), 'utf8'), context);
  context.loadYearlyPlan = () => { refreshed = true; };
  await vm.runInContext("quickComplete(5, '2026-04-30')", context);
  assert.equal(fallback, false);
  assert.equal(refreshed, true);
});
