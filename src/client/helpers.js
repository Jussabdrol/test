
// --- Helpers ---
// ─── Op-Plan Process Context Bar ─────────────────────────────────────────────

const BUNDLE_COLORS = ['#6366f1','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6'];

async function loadOpPlanContextData() {
  try {
    const [procs, bundles] = await Promise.all([
      api('/api/architecture?arch_type=process'),
      api('/api/plan-bundles'),
    ]);
    opPlanProcesses = procs;
    opPlanBundles = bundles;
  } catch(e) { /* silently ignore */ }
}

function getOpPlanContextNames() {
  // Returns array of process names matching current context, or null for 'all'
  if (opPlanContext.type === 'all') return null;
  if (opPlanContext.type === 'process') {
    const p = opPlanProcesses.find(p => p.id === opPlanContext.id);
    return p ? [p.name] : null;
  }
  if (opPlanContext.type === 'bundle') {
    const bundle = opPlanBundles.find(b => b.id === opPlanContext.id);
    if (!bundle) return null;
    const ids = JSON.parse(bundle.process_ids || '[]');
    return opPlanProcesses.filter(p => ids.includes(p.id)).map(p => p.name);
  }
  return null;
}

function renderOpPlanContextBar() {
  const bar = document.getElementById('op-plan-context-bar');
  if (!bar) return;

  const allPill = `<button class="op-ctx-pill${opPlanContext.type==='all'?' active':''}" onclick="setOpPlanContext('all',null)">All Processes</button>`;

  const procPills = opPlanProcesses.map(p =>
    `<button class="op-ctx-pill${opPlanContext.type==='process'&&opPlanContext.id===p.id?' active':''}"
      onclick="setOpPlanContext('process',${p.id})">${esc(p.name)}</button>`
  ).join('');

  const bundlePills = opPlanBundles.map(b => {
    const active = opPlanContext.type === 'bundle' && opPlanContext.id === b.id;
    return `<button class="op-ctx-bundle-pill${active?' active':''}" style="--bundle-color:${esc(b.color||'#6366f1')}"
      onclick="setOpPlanContext('bundle',${b.id})"
      title="Edit bundle" ondblclick="openBundleModal(${b.id})">&#128230; ${esc(b.name)}</button>`;
  }).join('');

  bar.innerHTML = `
    <div class="op-plan-ctx-bar">
      <div class="op-ctx-pills">
        ${allPill}
        ${procPills}
        ${opPlanBundles.length > 0 ? '<span class="op-ctx-sep"></span>' : ''}
        ${bundlePills}
        <button class="op-ctx-add-btn" onclick="openBundleModal()" title="Create bundle">&#43; Bundle</button>
      </div>
    </div>`;
}

async function setOpPlanContext(type, id) {
  opPlanContext = { type, id };
  // For single-process context, mirror into task category filter (server-side)
  if (type === 'process') {
    const p = opPlanProcesses.find(p => p.id === id);
    filters.category = p ? p.name : '';
  } else {
    filters.category = '';
  }
  renderOpPlanContextBar();
  // Reload the current view with the new context applied
  if (currentView === 'tasks') loadTasks();
  else if (currentView === 'yearly') loadYearlyPlan();
  else if (currentView === 'actions') loadActions();
  else if (currentView === 'task-log') loadTaskLog();
}

// ─── Bundle modal ─────────────────────────────────────────────────────────────

async function openBundleModal(id) {
  await loadOpPlanContextData();
  const modal = document.getElementById('bundle-modal');
  document.getElementById('bundle-id').value = id || '';
  document.getElementById('bundle-modal-title').textContent = id ? 'Edit Bundle' : 'New Process Bundle';

  let selectedColor = '#6366f1';
  let selectedIds = [];

  if (id) {
    const bundle = opPlanBundles.find(b => b.id === id);
    if (bundle) {
      document.getElementById('bundle-name').value = bundle.name;
      selectedColor = bundle.color || '#6366f1';
      try { selectedIds = JSON.parse(bundle.process_ids || '[]'); } catch(e) {}
    }
  } else {
    document.getElementById('bundle-name').value = '';
  }

  // Colour swatches
  const swatchEl = document.getElementById('bundle-color-swatches');
  swatchEl.innerHTML = BUNDLE_COLORS.map(c =>
    `<span class="bundle-color-swatch${c===selectedColor?' selected':''}" style="background:${c}" data-color="${c}" onclick="selectBundleColor('${c}')"></span>`
  ).join('');

  // Process checklist
  const listEl = document.getElementById('bundle-process-checklist');
  if (opPlanProcesses.length === 0) {
    listEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No processes defined in Architecture yet.</div>';
  } else {
    listEl.innerHTML = opPlanProcesses.map(p =>
      `<label class="bundle-proc-item">
        <input type="checkbox" value="${p.id}" ${selectedIds.includes(p.id)?'checked':''}>
        ${esc(p.name)}
      </label>`
    ).join('');
  }

  // Delete button (edit mode only)
  const existing = document.getElementById('bundle-delete-btn');
  if (existing) existing.remove();
  if (id) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'bundle-delete-btn';
    btn.className = 'btn btn-danger';
    btn.textContent = 'Delete Bundle';
    btn.onclick = () => deletePlanBundle(id);
    document.querySelector('#bundle-form .form-actions').prepend(btn);
  }

  modal.classList.remove('hidden');
}

function selectBundleColor(color) {
  document.querySelectorAll('.bundle-color-swatch').forEach(s => s.classList.toggle('selected', s.dataset.color === color));
}

function closeBundleModal() {
  document.getElementById('bundle-modal').classList.add('hidden');
}

async function saveBundleModal(e) {
  e.preventDefault();
  const id = document.getElementById('bundle-id').value;
  const name = document.getElementById('bundle-name').value.trim();
  const color = document.querySelector('.bundle-color-swatch.selected')?.dataset.color || '#6366f1';
  const process_ids = [...document.querySelectorAll('#bundle-process-checklist input:checked')].map(cb => parseInt(cb.value));

  if (!name) return;
  if (id) {
    await api(`/api/plan-bundles/${id}`, { method: 'PUT', body: { name, color, process_ids } });
  } else {
    await api('/api/plan-bundles', { method: 'POST', body: { name, color, process_ids } });
  }
  closeBundleModal();
  await loadOpPlanContextData();
  renderOpPlanContextBar();
}

async function deletePlanBundle(id) {
  if (!confirm('Delete this bundle?')) return;
  await api(`/api/plan-bundles/${id}`, { method: 'DELETE' });
  if (opPlanContext.type === 'bundle' && opPlanContext.id === id) {
    opPlanContext = { type: 'all', id: null };
    filters.category = '';
  }
  closeBundleModal();
  await loadOpPlanContextData();
  renderOpPlanContextBar();
}

// ─── End context bar ──────────────────────────────────────────────────────────

function refreshCurrentView() {
  switchView(currentView);
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
