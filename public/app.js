// --- State ---
let currentView = 'mission-control';
let allTasks = [];
let meta = { assignees: [], categories: [] };
let filters = { active: 'true', assignee: '', category: '', priority: '' };
let actionFilters = { status: 'open' };
let yearlyYear = new Date().getFullYear();
let lastCompletionContext = null; // { completion_id, task_id }
let yearlyData = null; // cached yearly API data

// --- Sidebar Toggle ---
function toggleSidebar() {
  const sb = document.querySelector('.sidebar');
  sb.classList.toggle('collapsed');
  localStorage.setItem('sidebarCollapsed', sb.classList.contains('collapsed'));
}
if (localStorage.getItem('sidebarCollapsed') === 'true') {
  document.querySelector('.sidebar').classList.add('collapsed');
}

// --- Navigation ---
// Module toggles (expand/collapse)
document.querySelectorAll('.module-toggle').forEach(toggle => {
  toggle.addEventListener('click', e => {
    e.preventDefault();
    const submenu = toggle.nextElementSibling;
    submenu.classList.toggle('open');
    toggle.classList.toggle('collapsed');
  });
});

// Sub-view links
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    switchView(link.dataset.view);
  });
});

function switchView(view) {
  currentView = view;
  closeDayDetail();
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(`view-${view}`).classList.remove('hidden');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const activeLink = document.querySelector(`[data-view="${view}"]`);
  if (activeLink) activeLink.classList.add('active');
  // Ensure parent module is expanded
  const parentSubmenu = activeLink?.closest('.module-submenu');
  if (parentSubmenu && !parentSubmenu.classList.contains('open')) {
    parentSubmenu.classList.add('open');
    parentSubmenu.previousElementSibling?.classList.remove('collapsed');
  }

  if (view === 'dashboard') loadDashboard();
  else if (view === 'tasks') loadTasks();
  else if (view === 'yearly') loadYearlyPlan();
  else if (view === 'actions') loadActions();
  else if (view === 'history') loadHistory();
  else if (view === 'audit-plan') loadAuditPlan();
  else if (view === 'audit-execute') loadAuditExecuteView();
  else if (view === 'audit-ncrs') loadNcrs();
  else if (view === 'audit-requirements') loadRequirements();
  else if (view === 'risk-identification') loadRiskIdentification();
  else if (view === 'risk-treatment') loadRiskTreatmentView();
  else if (view === 'risk-soa') loadSoA();
  else if (view === 'mission-control') loadMissionControl();
  else if (view === 'architecture') loadArchitecture();
  else if (view === 'document-control') loadDocumentControl();
}

// --- API helpers ---
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return res.json();
}

// --- Cross-Link System ---
const linkableTypes = {
  risk: { label: 'Risk', icon: '&#9888;', canLink: ['role','process','system','asset','facility','requirement','document','task'] },
  task: { label: 'Task', icon: '&#9881;', canLink: ['role','process','asset','facility','risk','document','requirement'] },
  audit: { label: 'Audit', icon: '&#9998;', canLink: ['role','process','requirement','risk','document'] },
  requirement: { label: 'Requirement', icon: '&#128220;', canLink: ['risk','task','audit','document','role','process'] },
  role: { label: 'Role', icon: '&#128100;', canLink: ['risk','task','audit','process','system','document'] },
  process: { label: 'Process', icon: '&#128260;', canLink: ['risk','task','audit','role','system','asset','document'] },
  system: { label: 'System', icon: '&#128187;', canLink: ['risk','process','role','asset','document'] },
  asset: { label: 'Asset', icon: '&#128230;', canLink: ['risk','task','process','facility','document'] },
  facility: { label: 'Facility', icon: '&#127970;', canLink: ['risk','task','asset','document'] },
  document: { label: 'Document', icon: '&#128196;', canLink: ['risk','task','audit','requirement','role','process','system','asset','facility'] },
  ncr: { label: 'NCR', icon: '&#9888;', canLink: ['risk','requirement','document','role'] },
};

async function renderCrossLinks(entityType, entityId, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const links = await api(`/api/cross-links/${entityType}/${entityId}`);
  const allowed = linkableTypes[entityType]?.canLink || [];

  const typeIcons = {};
  for (const [k, v] of Object.entries(linkableTypes)) typeIcons[k] = v.icon;
  const typeLabels = {};
  for (const [k, v] of Object.entries(linkableTypes)) typeLabels[k] = v.label;

  // Group links by type
  const grouped = {};
  for (const l of links) {
    if (!grouped[l.type]) grouped[l.type] = [];
    grouped[l.type].push(l);
  }

  let html = '<div class="cross-links">';
  html += '<div class="cross-links-header"><span class="cross-links-title">&#128279; Linked Items</span>';
  html += `<button class="btn btn-secondary btn-sm" onclick="openCrossLinkPicker('${entityType}',${entityId},'${containerId}')">+ Link</button>`;
  html += '</div>';

  if (links.length === 0) {
    html += '<div class="cross-links-empty">No linked items yet.</div>';
  } else {
    for (const [type, items] of Object.entries(grouped)) {
      html += `<div class="cross-link-group"><span class="cross-link-group-label">${typeIcons[type] || ''} ${typeLabels[type] || type}s</span>`;
      for (const item of items) {
        const viewTarget = getViewForType(item.type, item.id);
        html += `<div class="cross-link-item">
          <span class="cross-link-name"${viewTarget ? ` onclick="${viewTarget}" style="cursor:pointer;text-decoration:underline"` : ''}>${esc(item.name)}</span>
          <button class="cross-link-remove" onclick="removeCrossLink(${item.link_id},'${entityType}',${entityId},'${containerId}')" title="Remove link">&times;</button>
        </div>`;
      }
      html += '</div>';
    }
  }
  html += '</div>';
  container.innerHTML = html;
}

function getViewForType(type, id) {
  const viewMap = {
    risk: 'risk-identification', task: 'tasks', audit: 'audit-plan',
    requirement: 'audit-requirements', role: 'architecture', process: 'architecture',
    system: 'architecture', asset: 'architecture', facility: 'architecture',
    document: 'document-control', ncr: 'audit-ncrs',
  };
  const view = viewMap[type];
  return view ? `switchView('${view}')` : null;
}

async function openCrossLinkPicker(entityType, entityId, containerId) {
  const allowed = linkableTypes[entityType]?.canLink || [];
  // Build a modal dynamically
  let existing = document.getElementById('cross-link-picker-modal');
  if (!existing) {
    existing = document.createElement('div');
    existing.id = 'cross-link-picker-modal';
    existing.className = 'modal hidden';
    document.body.appendChild(existing);
  }
  existing.innerHTML = `
    <div class="modal-overlay" onclick="closeCrossLinkPicker()"></div>
    <div class="modal-content modal-sm">
      <div class="modal-header">
        <h3>Link to...</h3>
        <button class="modal-close" onclick="closeCrossLinkPicker()">&times;</button>
      </div>
      <div class="form-group">
        <label>Type</label>
        <select id="cl-pick-type" onchange="loadCrossLinkOptions()">
          <option value="">-- Select type --</option>
          ${allowed.map(t => `<option value="${t}">${linkableTypes[t]?.label || t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Item</label>
        <select id="cl-pick-item"><option value="">-- Select type first --</option></select>
      </div>
      <div class="form-actions">
        <button class="btn btn-secondary" onclick="closeCrossLinkPicker()">Cancel</button>
        <button class="btn btn-primary" onclick="addCrossLink('${entityType}',${entityId},'${containerId}')">Link</button>
      </div>
    </div>`;
  existing.classList.remove('hidden');
}

function closeCrossLinkPicker() {
  const m = document.getElementById('cross-link-picker-modal');
  if (m) m.classList.add('hidden');
}

async function loadCrossLinkOptions() {
  const type = document.getElementById('cl-pick-type').value;
  const sel = document.getElementById('cl-pick-item');
  if (!type) { sel.innerHTML = '<option value="">-- Select type first --</option>'; return; }
  const items = await api(`/api/linkable/${type}`);
  sel.innerHTML = '<option value="">-- Select --</option>' + items.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('');
}

async function addCrossLink(sourceType, sourceId, containerId) {
  const targetType = document.getElementById('cl-pick-type').value;
  const targetId = document.getElementById('cl-pick-item').value;
  if (!targetType || !targetId) return alert('Please select a type and item');
  await api('/api/cross-links', { method: 'POST', body: { source_type: sourceType, source_id: sourceId, target_type: targetType, target_id: parseInt(targetId) } });
  closeCrossLinkPicker();
  renderCrossLinks(sourceType, sourceId, containerId);
}

async function removeCrossLink(linkId, entityType, entityId, containerId) {
  await api(`/api/cross-links/${linkId}`, { method: 'DELETE' });
  renderCrossLinks(entityType, entityId, containerId);
}

async function ensureMeta() {
  if (meta.assignees.length === 0 && meta.categories.length === 0) {
    meta = await api('/api/meta');
  }
}

// --- Dashboard ---
async function loadDashboard() {
  const stats = await api('/api/dashboard');
  const grid = document.getElementById('stats-grid');
  grid.innerHTML = `
    <div class="stat-card"><div class="stat-value">${stats.totalActive}</div><div class="stat-label">Active Tasks</div></div>
    <div class="stat-card today clickable" onclick="switchView('tasks')"><div class="stat-value">${stats.dueToday}</div><div class="stat-label">Due Today</div></div>
    <div class="stat-card overdue clickable" onclick="switchView('tasks')"><div class="stat-value">${stats.overdue}</div><div class="stat-label">Overdue</div></div>
    <div class="stat-card done"><div class="stat-value">${stats.completedThisWeek}</div><div class="stat-label">Done This Week</div></div>
    <div class="stat-card done clickable" onclick="switchView('yearly')"><div class="stat-value">${stats.completedThisMonth}</div><div class="stat-label">Done This Month</div></div>
    <div class="stat-card${stats.openActions > 0 ? ' overdue' : ''} clickable" onclick="switchView('actions')"><div class="stat-value">${stats.openActions}</div><div class="stat-label">Open Actions</div></div>
  `;

  // KPI cards
  const kpiGrid = document.getElementById('kpi-grid');
  const apc = stats.actionsPerCheck ?? 0;
  const apcTotal = stats.totalActionsCount ?? 0;
  const apcChecks = stats.totalCompletions ?? 0;
  const apcThisMonth = stats.actionsPerCheckThisMonth ?? 0;
  const apcLastMonth = stats.actionsPerCheckLastMonth ?? 0;
  const apcTrend = apcLastMonth > 0
    ? Number(((apcThisMonth - apcLastMonth) / apcLastMonth * 100).toFixed(0))
    : null;
  const apcArrow = apcTrend === null ? '' : (apcTrend > 0 ? `<span class="kpi-trend up">&uarr; ${apcTrend}%</span>` : apcTrend < 0 ? `<span class="kpi-trend down">&darr; ${Math.abs(apcTrend)}%</span>` : `<span class="kpi-trend flat">&rarr; 0%</span>`);
  const apcColor = apcTrend === null ? '' : (apcTrend > 0 ? 'trend-bad' : apcTrend < 0 ? 'trend-good' : '');

  const otCurrent = stats.onTimeRateCurrent;
  const otPrevious = stats.onTimeRatePrevious;
  const otDelta = (otCurrent != null && otPrevious != null) ? otCurrent - otPrevious : null;
  const otArrow = otDelta === null ? '' : (otDelta > 0 ? `<span class="kpi-trend down">&uarr; +${otDelta}pp</span>` : otDelta < 0 ? `<span class="kpi-trend up">&darr; ${otDelta}pp</span>` : `<span class="kpi-trend flat">&rarr; 0pp</span>`);
  const otColor = otDelta === null ? '' : (otDelta > 0 ? 'trend-good' : otDelta < 0 ? 'trend-bad' : '');

  kpiGrid.innerHTML = `
    <div class="kpi-card ${apcColor}">
      <div class="kpi-header">Actions per Check</div>
      <div class="kpi-value">${apc}</div>
      <div class="kpi-detail">${apcTotal} action${apcTotal !== 1 ? 's' : ''} from ${apcChecks} check${apcChecks !== 1 ? 's' : ''}</div>
      <div class="kpi-footer">This month: ${apcThisMonth} ${apcArrow}</div>
    </div>
    <div class="kpi-card ${otColor}">
      <div class="kpi-header">On-Time Completion</div>
      <div class="kpi-value">${otCurrent != null ? otCurrent + '%' : 'N/A'}</div>
      <div class="kpi-detail">${otCurrent != null ? 'Last 30 days' : 'No completions yet'}</div>
      <div class="kpi-footer">Previous 30d: ${otPrevious != null ? otPrevious + '%' : 'N/A'} ${otArrow}</div>
    </div>
  `;

  // Overdue tasks
  const overdueList = document.getElementById('overdue-list');
  if (stats.overdueTasks.length === 0) {
    overdueList.innerHTML = '<div class="empty-state">No overdue tasks</div>';
  } else {
    overdueList.innerHTML = stats.overdueTasks.map(t => taskCard(t)).join('');
  }

  // Overdue actions
  const overdueActionsList = document.getElementById('overdue-actions-list');
  if (stats.overdueActions > 0) {
    const actions = await api('/api/actions?status=open');
    const today = new Date().toISOString().split('T')[0];
    const overdueActions = actions.filter(a => a.due_date && a.due_date < today);
    if (overdueActions.length > 0) {
      overdueActionsList.innerHTML = overdueActions.map(a => `
        <div class="task-card">
          <div class="task-card-info">
            <h4>${esc(a.title)}</h4>
            <div class="meta">From: ${esc(a.task_title)} &middot; ${esc(a.assignee || 'Unassigned')} &middot; Due: ${a.due_date}</div>
          </div>
          ${actionMenu([
            { label: '&#9654; Start', onclick: `updateActionStatusAndRefresh(${a.id},'in_progress')`, cls: 'primary' },
            { label: '&#9998; Edit', onclick: `openActionModal(${a.id})` },
          ])}
        </div>`).join('');
    } else {
      overdueActionsList.innerHTML = '<div class="empty-state">No overdue actions</div>';
    }
  } else {
    overdueActionsList.innerHTML = '<div class="empty-state">No overdue actions</div>';
  }

  // Upcoming tasks
  const upcomingList = document.getElementById('upcoming-list');
  if (stats.upcomingTasks.length === 0) {
    upcomingList.innerHTML = '<div class="empty-state">No upcoming tasks</div>';
  } else {
    upcomingList.innerHTML = stats.upcomingTasks.map(t => taskCard(t)).join('');
  }
}

function taskCard(task) {
  return `
    <div class="task-card">
      <div class="task-card-info">
        <h4>${esc(task.title)}</h4>
        <div class="meta">${esc(task.assignee || 'Unassigned')} &middot; ${task.recurrence} &middot; Due: ${task.next_due}</div>
      </div>
      ${actionMenu([
        { label: '&#10003; Mark Done', onclick: `openCompleteModal(${task.id})`, cls: 'success' },
        { label: '&#9998; Edit', onclick: `openTaskModal(${task.id})` },
      ])}
    </div>`;
}

// --- Tasks View ---
async function loadTasks() {
  meta = await api('/api/meta');
  renderFilters();

  const params = new URLSearchParams();
  if (filters.active) params.set('active', filters.active);
  if (filters.assignee) params.set('assignee', filters.assignee);
  if (filters.category) params.set('category', filters.category);
  if (filters.priority) params.set('priority', filters.priority);

  allTasks = await api(`/api/tasks?${params}`);
  renderTaskTable();
}

function renderFilters() {
  const bar = document.getElementById('filters-bar');
  bar.innerHTML = `
    <select onchange="filters.active=this.value;loadTasks()">
      <option value="true" ${filters.active==='true'?'selected':''}>Active</option>
      <option value="false" ${filters.active==='false'?'selected':''}>Inactive</option>
      <option value="" ${filters.active===''?'selected':''}>All</option>
    </select>
    <select onchange="filters.priority=this.value;loadTasks()">
      <option value="">All Priorities</option>
      <option value="Low" ${filters.priority==='Low'?'selected':''}>Low</option>
      <option value="Medium" ${filters.priority==='Medium'?'selected':''}>Medium</option>
      <option value="High" ${filters.priority==='High'?'selected':''}>High</option>
      <option value="Critical" ${filters.priority==='Critical'?'selected':''}>Critical</option>
    </select>
    <select onchange="filters.assignee=this.value;loadTasks()">
      <option value="">All Assignees</option>
      ${meta.assignees.map(a => `<option value="${esc(a)}" ${filters.assignee===a?'selected':''}>${esc(a)}</option>`).join('')}
    </select>
    <select onchange="filters.category=this.value;loadTasks()">
      <option value="">All Categories</option>
      ${meta.categories.map(c => `<option value="${esc(c)}" ${filters.category===c?'selected':''}>${esc(c)}</option>`).join('')}
    </select>
  `;
}

function renderTaskTable() {
  const tbody = document.getElementById('task-table-body');
  const today = new Date().toISOString().split('T')[0];
  if (allTasks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No tasks found</td></tr>';
    return;
  }
  tbody.innerHTML = allTasks.map(t => {
    const status = t.next_due < today ? 'overdue' : t.next_due === today ? 'due-today' : 'upcoming';
    const statusLabel = status === 'overdue' ? 'Overdue' : status === 'due-today' ? 'Due Today' : 'Upcoming';
    return `<tr>
      <td><strong>${esc(t.title)}</strong>${t.description ? '<br><small style="color:var(--text-muted)">' + esc(t.description) + '</small>' : ''}
        <div id="task-links-${t.id}" class="task-inline-links"></div>
      </td>
      <td>${esc(t.assignee || '-')}</td>
      <td>${esc(t.category)}</td>
      <td><span class="badge badge-${t.priority.toLowerCase()}">${t.priority}</span></td>
      <td>${t.recurrence}${t.recurrence === 'custom' ? ' (' + t.custom_days + 'd)' : ''}</td>
      <td>${t.next_due}</td>
      <td><span class="badge badge-${status}">${statusLabel}</span></td>
      <td>${actionMenu([
        { label: '&#10003; Mark Done', onclick: `openCompleteModal(${t.id})`, cls: 'success' },
        { label: '&#128279; Links', onclick: `toggleTaskLinks(${t.id})` },
        { label: '&#9998; Edit', onclick: `openTaskModal(${t.id})` },
        'sep',
        { label: '&#128465; Delete', onclick: `deleteTask(${t.id})`, cls: 'danger' },
      ])}</td>
    </tr>`;
  }).join('');
}

function toggleTaskLinks(taskId) {
  const el = document.getElementById(`task-links-${taskId}`);
  if (el.innerHTML) { el.innerHTML = ''; return; }
  renderCrossLinks('task', taskId, `task-links-${taskId}`);
}

// --- History ---
async function loadHistory() {
  const completions = await api('/api/completions?limit=100');
  const list = document.getElementById('history-list');
  if (completions.length === 0) {
    list.innerHTML = '<div class="empty-state">No completions yet</div>';
    return;
  }
  list.innerHTML = completions.map(c => `
    <div class="history-item">
      <div class="hi-info">
        <strong>${esc(c.task_title)}</strong>
        <div class="hi-meta">${c.completed_by ? 'by ' + esc(c.completed_by) : ''}${c.notes ? ' — ' + esc(c.notes) : ''}</div>
        ${c.action_count > 0 ? `<div class="hi-meta"><span class="badge badge-${c.open_action_count > 0 ? 'high' : 'low'}">${c.open_action_count} open / ${c.action_count} actions</span></div>` : ''}
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <div class="hi-date">${new Date(c.completed_at).toLocaleString()}</div>
        ${actionMenu([
          { label: '&#128203; View Actions', onclick: `viewCompletionActions(${c.id}, ${c.task_id})` },
        ])}
      </div>
    </div>
  `).join('');
}

// --- Task Modal ---
async function openTaskModal(id) {
  await ensureMeta();
  const modal = document.getElementById('task-modal');
  const form = document.getElementById('task-form');
  form.reset();
  document.getElementById('task-id').value = '';
  document.getElementById('task-start').value = new Date().toISOString().split('T')[0];
  document.getElementById('modal-title').textContent = 'New Task';
  document.getElementById('custom-days-group').classList.add('hidden');

  // populate category datalist
  const catList = document.getElementById('category-list');
  catList.innerHTML = meta.categories.map(c => `<option value="${esc(c)}">`).join('');

  if (id) {
    const task = await api(`/api/tasks/${id}`);
    document.getElementById('modal-title').textContent = 'Edit Task';
    document.getElementById('task-id').value = task.id;
    document.getElementById('task-title').value = task.title;
    document.getElementById('task-desc').value = task.description;
    document.getElementById('task-assignee').value = task.assignee;
    document.getElementById('task-category').value = task.category;
    document.getElementById('task-priority').value = task.priority;
    document.getElementById('task-recurrence').value = task.recurrence;
    document.getElementById('task-custom-days').value = task.custom_days || 1;
    document.getElementById('task-start').value = task.start_date;
    toggleCustomDays();
  }

  modal.classList.remove('hidden');
}

function closeTaskModal() {
  document.getElementById('task-modal').classList.add('hidden');
}

function toggleCustomDays() {
  const sel = document.getElementById('task-recurrence').value;
  document.getElementById('custom-days-group').classList.toggle('hidden', sel !== 'custom');
}

async function saveTask(e) {
  e.preventDefault();
  const id = document.getElementById('task-id').value;
  const body = {
    title: document.getElementById('task-title').value,
    description: document.getElementById('task-desc').value,
    assignee: document.getElementById('task-assignee').value,
    category: document.getElementById('task-category').value || 'General',
    priority: document.getElementById('task-priority').value,
    recurrence: document.getElementById('task-recurrence').value,
    custom_days: parseInt(document.getElementById('task-custom-days').value) || null,
    start_date: document.getElementById('task-start').value,
  };

  if (id) {
    await api(`/api/tasks/${id}`, { method: 'PUT', body });
  } else {
    await api('/api/tasks', { method: 'POST', body });
  }

  closeTaskModal();
  invalidateYearlyCache();
  meta = await api('/api/meta'); // refresh meta after adding new assignees/categories
  refreshCurrentView();
}

// --- Complete Modal ---
function openCompleteModal(taskId) {
  document.getElementById('complete-form').reset();
  document.getElementById('complete-task-id').value = taskId;
  document.getElementById('complete-modal').classList.remove('hidden');
}

function closeCompleteModal() {
  document.getElementById('complete-modal').classList.add('hidden');
}

async function submitComplete(e) {
  e.preventDefault();
  const taskId = document.getElementById('complete-task-id').value;
  const result = await api(`/api/tasks/${taskId}/complete`, {
    method: 'POST',
    body: {
      completed_by: document.getElementById('complete-by').value,
      notes: document.getElementById('complete-notes').value,
    },
  });
  closeCompleteModal();
  invalidateYearlyCache();
  // Show post-completion action prompt
  lastCompletionContext = { completion_id: result.completion_id, task_id: parseInt(taskId) };
  openPostCompleteModal();
}

// --- Delete ---
async function deleteTask(id) {
  if (!confirm('Delete this task and all its history?')) return;
  await api(`/api/tasks/${id}`, { method: 'DELETE' });
  invalidateYearlyCache();
  refreshCurrentView();
}

// --- Post-completion Actions ---
function openPostCompleteModal() {
  document.getElementById('post-complete-actions-list').innerHTML = '';
  document.getElementById('quick-action-title').value = '';
  document.getElementById('quick-action-assignee').value = '';
  document.getElementById('quick-action-priority').value = 'Medium';
  document.getElementById('quick-action-due').value = '';
  document.getElementById('post-complete-modal').classList.remove('hidden');
}

function closePostCompleteModal() {
  document.getElementById('post-complete-modal').classList.add('hidden');
  lastCompletionContext = null;
  refreshCurrentView();
}

async function addQuickAction() {
  const title = document.getElementById('quick-action-title').value.trim();
  if (!title) return alert('Action title is required');

  const action = await api('/api/actions', {
    method: 'POST',
    body: {
      completion_id: lastCompletionContext.completion_id,
      task_id: lastCompletionContext.task_id,
      title,
      assignee: document.getElementById('quick-action-assignee').value,
      priority: document.getElementById('quick-action-priority').value,
      due_date: document.getElementById('quick-action-due').value || null,
    },
  });

  // Add to the visible list
  const list = document.getElementById('post-complete-actions-list');
  list.innerHTML += `<div class="task-card" style="margin-bottom:8px">
    <div class="task-card-info">
      <h4>${esc(action.title)}</h4>
      <div class="meta">${esc(action.assignee || 'Unassigned')} &middot; <span class="badge badge-${action.priority.toLowerCase()}">${action.priority}</span>${action.due_date ? ' &middot; Due: ' + action.due_date : ''}</div>
    </div>
  </div>`;

  // Reset inputs
  document.getElementById('quick-action-title').value = '';
  document.getElementById('quick-action-assignee').value = '';
  document.getElementById('quick-action-priority').value = 'Medium';
  document.getElementById('quick-action-due').value = '';
}

// --- Actions View ---
async function loadActions() {
  const params = new URLSearchParams();
  if (actionFilters.status) params.set('status', actionFilters.status);

  const actions = await api(`/api/actions?${params}`);
  renderActionFilters();
  renderActionTable(actions);
}

function renderActionFilters() {
  const bar = document.getElementById('action-filters-bar');
  bar.innerHTML = `
    <select onchange="actionFilters.status=this.value;loadActions()">
      <option value="open" ${actionFilters.status==='open'?'selected':''}>Open</option>
      <option value="in_progress" ${actionFilters.status==='in_progress'?'selected':''}>In Progress</option>
      <option value="resolved" ${actionFilters.status==='resolved'?'selected':''}>Resolved</option>
      <option value="closed" ${actionFilters.status==='closed'?'selected':''}>Closed</option>
      <option value="" ${actionFilters.status===''?'selected':''}>All</option>
    </select>
  `;
}

function renderActionTable(actions) {
  const tbody = document.getElementById('action-table-body');
  const today = new Date().toISOString().split('T')[0];
  if (actions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No actions found</td></tr>';
    return;
  }
  tbody.innerHTML = actions.map(a => {
    const isOverdue = a.due_date && a.due_date < today && (a.status === 'open' || a.status === 'in_progress');
    const statusClass = a.status === 'open' ? 'badge-high' : a.status === 'in_progress' ? 'badge-medium' : 'badge-low';
    const statusLabel = a.status.replace('_', ' ');
    return `<tr>
      <td><strong>${esc(a.title)}</strong>${a.description ? '<br><small style="color:var(--text-muted)">' + esc(a.description) + '</small>' : ''}</td>
      <td>${esc(a.task_title)}</td>
      <td>${esc(a.assignee || '-')}</td>
      <td><span class="badge badge-${a.priority.toLowerCase()}">${a.priority}</span></td>
      <td>${a.due_date ? (isOverdue ? '<span style="color:var(--danger);font-weight:600">' + a.due_date + '</span>' : a.due_date) : '-'}</td>
      <td><span class="badge ${statusClass}">${statusLabel}</span></td>
      <td>${actionMenu([
        ...(a.status === 'open' ? [{ label: '&#9654; Start', onclick: `updateActionStatus(${a.id},'in_progress')`, cls: 'primary' }] : []),
        ...(a.status === 'in_progress' ? [{ label: '&#10003; Resolve', onclick: `resolveAction(${a.id})`, cls: 'success' }] : []),
        { label: '&#9998; Edit', onclick: `openActionModal(${a.id})` },
        'sep',
        { label: '&#128465; Delete', onclick: `deleteAction(${a.id})`, cls: 'danger' },
      ])}</td>
    </tr>`;
  }).join('');
}

async function updateActionStatus(id, status) {
  await api(`/api/actions/${id}`, { method: 'PUT', body: { status } });
  refreshCurrentView();
}

async function updateActionStatusAndRefresh(id, status) {
  await api(`/api/actions/${id}`, { method: 'PUT', body: { status } });
  loadDashboard();
}

async function resolveAction(id) {
  const resolvedBy = prompt('Resolved by (your name):');
  if (resolvedBy === null) return;
  await api(`/api/actions/${id}`, { method: 'PUT', body: { status: 'resolved', resolved_by: resolvedBy } });
  refreshCurrentView();
}

async function deleteAction(id) {
  if (!confirm('Delete this action?')) return;
  await api(`/api/actions/${id}`, { method: 'DELETE' });
  refreshCurrentView();
}

// --- Action Modal (edit) ---
let actionStatusHandler = null;

async function openActionModal(id) {
  const modal = document.getElementById('action-modal');
  const form = document.getElementById('action-form');
  form.reset();
  document.getElementById('action-id').value = '';
  document.getElementById('action-modal-title').textContent = 'New Follow-up Action';
  document.getElementById('action-resolved-by-group').classList.add('hidden');

  if (id) {
    const action = await api(`/api/actions/${id}`);
    document.getElementById('action-modal-title').textContent = 'Edit Action';
    document.getElementById('action-id').value = action.id;
    document.getElementById('action-completion-id').value = action.completion_id;
    document.getElementById('action-task-id').value = action.task_id;
    document.getElementById('action-title').value = action.title;
    document.getElementById('action-description').value = action.description;
    document.getElementById('action-assignee').value = action.assignee;
    document.getElementById('action-priority').value = action.priority;
    document.getElementById('action-due-date').value = action.due_date || '';
    document.getElementById('action-status').value = action.status;
    document.getElementById('action-resolved-by').value = action.resolved_by || '';
    if (action.status === 'resolved' || action.status === 'closed') {
      document.getElementById('action-resolved-by-group').classList.remove('hidden');
    }
  }

  // Remove old listener before adding new one
  const statusEl = document.getElementById('action-status');
  if (actionStatusHandler) statusEl.removeEventListener('change', actionStatusHandler);
  actionStatusHandler = function() {
    document.getElementById('action-resolved-by-group').classList.toggle('hidden',
      this.value !== 'resolved' && this.value !== 'closed');
  };
  statusEl.addEventListener('change', actionStatusHandler);

  modal.classList.remove('hidden');
}

function closeActionModal() {
  document.getElementById('action-modal').classList.add('hidden');
}

async function saveAction(e) {
  e.preventDefault();
  const id = document.getElementById('action-id').value;
  const body = {
    title: document.getElementById('action-title').value,
    description: document.getElementById('action-description').value,
    assignee: document.getElementById('action-assignee').value,
    priority: document.getElementById('action-priority').value,
    due_date: document.getElementById('action-due-date').value || null,
    status: document.getElementById('action-status').value,
    resolved_by: document.getElementById('action-resolved-by').value,
  };

  if (id) {
    await api(`/api/actions/${id}`, { method: 'PUT', body });
  } else {
    body.completion_id = document.getElementById('action-completion-id').value;
    body.task_id = document.getElementById('action-task-id').value;
    await api('/api/actions', { method: 'POST', body });
  }

  closeActionModal();
  refreshCurrentView();
}

// View actions for a specific completion (from history)
async function viewCompletionActions(completionId, taskId) {
  lastCompletionContext = { completion_id: completionId, task_id: taskId };
  const actions = await api(`/api/actions?completion_id=${completionId}`);

  const list = document.getElementById('post-complete-actions-list');
  list.innerHTML = actions.map(a => {
    const statusClass = a.status === 'open' ? 'badge-high' : a.status === 'in_progress' ? 'badge-medium' : 'badge-low';
    return `<div class="task-card" style="margin-bottom:8px">
      <div class="task-card-info">
        <h4>${esc(a.title)}</h4>
        <div class="meta">${esc(a.assignee || 'Unassigned')} &middot; <span class="badge badge-${a.priority.toLowerCase()}">${a.priority}</span> &middot; <span class="badge ${statusClass}">${a.status.replace('_',' ')}</span>${a.due_date ? ' &middot; Due: ' + a.due_date : ''}</div>
      </div>
    </div>`;
  }).join('');

  document.getElementById('quick-action-title').value = '';
  document.getElementById('quick-action-assignee').value = '';
  document.getElementById('quick-action-priority').value = 'Medium';
  document.getElementById('quick-action-due').value = '';
  document.getElementById('post-complete-modal').classList.remove('hidden');
}

// --- Yearly Plan ---
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAY_LABELS = ['Mo','Tu','We','Th','Fr','Sa','Su'];

function changeYear(delta) {
  if (delta === 0) yearlyYear = new Date().getFullYear();
  else yearlyYear += delta;
  invalidateYearlyCache();
  loadYearlyPlan();
}

function invalidateYearlyCache() {
  yearlyData = null;
}

async function loadYearlyPlan() {
  document.getElementById('yearly-title').textContent = `Yearly Plan ${yearlyYear}`;
  const data = await api(`/api/yearly?year=${yearlyYear}`);
  yearlyData = data;
  const grid = document.getElementById('yearly-grid');
  const today = new Date().toISOString().split('T')[0];

  // Compute per-month stats
  const monthStats = [];
  let totalDue = 0, totalCompleted = 0, totalOverdue = 0;
  for (let m = 0; m < 12; m++) {
    const daysInMonth = new Date(yearlyYear, m + 1, 0).getDate();
    let due = 0, completed = 0, overdue = 0;
    const taskDates = {}; // { task_id: { title, assignee, priority, recurrence, dates: [{date, type}] } }

    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${yearlyYear}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      if (data.dueDates[ds]) {
        due += data.dueDates[ds].length;
        if (ds < today) overdue += data.dueDates[ds].length;
        for (const t of data.dueDates[ds]) {
          if (!taskDates[t.task_id]) taskDates[t.task_id] = { ...t, dates: [] };
          taskDates[t.task_id].dates.push({ date: ds, type: ds < today ? 'overdue' : 'due' });
        }
      }
      if (data.completedDates[ds]) {
        completed += data.completedDates[ds].length;
        for (const t of data.completedDates[ds]) {
          if (!taskDates[t.task_id]) taskDates[t.task_id] = { ...t, dates: [] };
          taskDates[t.task_id].dates.push({ date: ds, type: 'completed' });
        }
      }
    }
    monthStats.push({ due, completed, overdue, taskDates });
    totalDue += due;
    totalCompleted += completed;
    totalOverdue += overdue;
  }

  // Render yearly summary stats
  const summaryEl = document.getElementById('yearly-summary');
  const pct = totalDue > 0 ? Math.round((totalCompleted / totalDue) * 100) : 0;
  summaryEl.innerHTML = `
    <div class="stat-card"><div class="stat-value">${totalDue}</div><div class="stat-label">Total Scheduled (${yearlyYear})</div></div>
    <div class="stat-card done"><div class="stat-value">${totalCompleted}</div><div class="stat-label">Completed</div></div>
    <div class="stat-card${totalOverdue > 0 ? ' overdue' : ''}"><div class="stat-value">${totalOverdue}</div><div class="stat-label">Overdue</div></div>
    <div class="stat-card"><div class="stat-value">${pct}%</div><div class="stat-label">Completion Rate</div></div>
  `;

  // Render Gantt chart
  renderGanttChart(data, monthStats, today);

  // Render monthly breakdown
  const breakdownEl = document.getElementById('yearly-breakdown');
  if (totalDue === 0 && totalCompleted === 0) {
    breakdownEl.innerHTML = '<div class="empty-state">No recurring tasks yet. Create a task to see your yearly plan.</div>';
    document.getElementById('yearly-breakdown-title').style.display = 'none';
    return;
  }
  document.getElementById('yearly-breakdown-title').style.display = '';

  let breakdownHtml = '';
  for (let m = 0; m < 12; m++) {
    const ms = monthStats[m];
    const tasks = Object.values(ms.taskDates);
    const isCurrentMonth = yearlyYear === new Date().getFullYear() && m === new Date().getMonth();
    const collapsed = !isCurrentMonth && tasks.length > 0;

    breakdownHtml += `<div class="yearly-month-section">
      <div class="yearly-month-header" onclick="this.nextElementSibling.classList.toggle('collapsed')">
        <h4>${MONTH_NAMES[m]} ${yearlyYear}</h4>
        <div class="month-stats">
          <span>${ms.due} scheduled</span>
          <span class="badge badge-low">${ms.completed} done</span>
          ${ms.overdue > 0 ? `<span class="badge badge-high">${ms.overdue} overdue</span>` : ''}
          <span style="font-size:16px">${collapsed ? '+' : '−'}</span>
        </div>
      </div>
      <div class="yearly-month-body${collapsed ? ' collapsed' : ''}">`;

    if (tasks.length === 0) {
      breakdownHtml += '<div class="yearly-empty-month">No tasks scheduled this month</div>';
    } else {
      // Sort: tasks with overdue dates first, then by title
      tasks.sort((a, b) => {
        const aOverdue = a.dates.some(d => d.type === 'overdue');
        const bOverdue = b.dates.some(d => d.type === 'overdue');
        if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
        return a.title.localeCompare(b.title);
      });

      for (const task of tasks) {
        breakdownHtml += `<div class="yearly-task-row">
          <div class="yearly-task-info">
            <strong>${esc(task.title)}</strong>
            <span class="badge badge-${task.priority.toLowerCase()}">${task.priority}</span>
            <div class="ytr-meta">${esc(task.assignee || 'Unassigned')} &middot; ${esc(task.recurrence)} &middot; ${task.category ? esc(task.category) : ''}</div>
          </div>
          <div class="yearly-task-dates">
            ${task.dates.map(d => {
              const day = parseInt(d.date.split('-')[2]);
              return `<span class="yearly-date-chip ${d.type}">${day}</span>`;
            }).join('')}
          </div>
        </div>`;
      }
    }

    breakdownHtml += '</div></div>';
  }
  breakdownEl.innerHTML = breakdownHtml;
}

let activePopover = null;

function showDayDetail(event, dateStr) {
  event.stopPropagation();
  closeDayDetail();
  if (!yearlyData) return;
  renderDayPopover(event, dateStr, yearlyData);
}

function renderDayPopover(event, dateStr, data) {
  const due = data.dueDates[dateStr] || [];
  const completed = data.completedDates[dateStr] || [];
  const today = new Date().toISOString().split('T')[0];

  const pop = document.createElement('div');
  pop.className = 'day-popover';

  let items = '';
  for (const t of completed) {
    items += `<div class="day-popover-item" style="border-left:3px solid var(--success)">
      <strong>${esc(t.title)}</strong>
      <div class="dpi-meta">Completed${t.completed_by ? ' by ' + esc(t.completed_by) : ''} &middot; ${esc(t.recurrence)} &middot; ${esc(t.assignee || 'Unassigned')}</div>
    </div>`;
  }
  for (const t of due) {
    const isOverdue = dateStr < today;
    const color = isOverdue ? 'var(--danger)' : 'var(--primary)';
    const label = isOverdue ? 'Overdue' : 'Scheduled';
    items += `<div class="day-popover-item" style="border-left:3px solid ${color}">
      <div style="display:flex;justify-content:space-between;align-items:start">
        <div>
          <strong>${esc(t.title)}</strong> <span class="badge badge-${t.priority.toLowerCase()}">${t.priority}</span>
          <div class="dpi-meta">${label} &middot; ${esc(t.recurrence)} &middot; ${esc(t.assignee || 'Unassigned')}</div>
        </div>
        <div style="margin-left:8px;flex-shrink:0">
          ${actionMenu([
            { label: '&#10003; Mark Done', onclick: `closeDayDetail();openCompleteModal(${t.task_id})`, cls: 'success' },
            { label: '&#9998; Edit', onclick: `closeDayDetail();openTaskModal(${t.task_id})` },
          ])}
        </div>
      </div>
    </div>`;
  }

  if (!items) items = '<div class="empty-state" style="padding:16px">No tasks on this date</div>';

  const formattedDate = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  pop.innerHTML = `
    <div class="day-popover-header">
      <h4>${formattedDate}</h4>
      <button class="modal-close" onclick="closeDayDetail()">&times;</button>
    </div>
    ${items}
  `;

  document.body.appendChild(pop);
  activePopover = pop;

  // Position near click
  const rect = event.target.getBoundingClientRect();
  let left = rect.right + 8;
  let top = rect.top;
  if (left + 330 > window.innerWidth) left = rect.left - 330;
  if (top + 400 > window.innerHeight) top = window.innerHeight - 410;
  if (top < 10) top = 10;
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', closeDayDetailOutside);
  }, 10);
}

function closeDayDetail() {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
  document.removeEventListener('click', closeDayDetailOutside);
}

function closeDayDetailOutside(e) {
  if (activePopover && !activePopover.contains(e.target)) {
    closeDayDetail();
  }
}

// --- Audit Module ---
let auditFilters = { status: '' };
let auditYear = new Date().getFullYear();

function changeAuditYear(delta) {
  if (delta === 0) auditYear = new Date().getFullYear();
  else auditYear += delta;
  loadAuditPlan();
}
let ncrFilters = { status: '', audit_id: '' };
let currentAuditId = null;

async function loadAuditPlan() {
  const params = new URLSearchParams();
  if (auditFilters.status) params.set('status', auditFilters.status);
  const audits = await api(`/api/audits?${params}`);
  renderAuditFilters();
  const list = document.getElementById('audit-list');
  if (audits.length === 0) {
    list.innerHTML = '<div class="empty-state">No audits planned yet. Create one to get started.</div>';
    return;
  }
  // Render audit timeline Gantt
  renderAuditGantt(audits);

  list.innerHTML = audits.map(a => {
    const statusCls = a.status === 'completed' ? 'badge-low' : a.status === 'in_progress' ? 'badge-medium' : a.status === 'cancelled' ? 'badge-inactive' : 'badge-upcoming';
    return `<div class="audit-card">
      <div class="audit-card-header">
        <div>
          <h3>${esc(a.title)}</h3>
          <div class="audit-meta">${esc(a.standard)} &middot; ${a.planned_date || 'No date'} &middot; Lead: ${esc(a.lead_auditor || 'Unassigned')}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="badge ${statusCls}">${a.status.replace('_', ' ')}</span>
        </div>
      </div>
      ${a.scope ? `<div class="audit-scope">${esc(a.scope)}</div>` : ''}
      <div class="audit-card-footer">
        <div class="audit-stats">
          <span>${a.assessed_count}/${a.checklist_count} assessed</span>
          <span>${a.nc_count} NC${a.nc_count !== 1 ? 's' : ''}${a.open_nc_count > 0 ? ` (${a.open_nc_count} open)` : ''}</span>
        </div>
        ${actionMenu([
          ...(a.status === 'planned' ? [{ label: '&#9654; Start Audit', onclick: `startAudit(${a.id})`, cls: 'primary' }] : []),
          ...(a.status === 'in_progress' ? [{ label: '&#9654; Execute', onclick: `switchToExecute(${a.id})`, cls: 'success' }] : []),
          { label: '&#128279; Links', onclick: `toggleAuditLinks(${a.id})` },
          { label: '&#9998; Edit', onclick: `openAuditModal(${a.id})` },
          'sep',
          { label: '&#128465; Delete', onclick: `deleteAudit(${a.id})`, cls: 'danger' },
        ])}
      </div>
      <div id="audit-links-${a.id}"></div>
    </div>`;
  }).join('');
}

function toggleAuditLinks(id) {
  const el = document.getElementById(`audit-links-${id}`);
  if (el.innerHTML) { el.innerHTML = ''; return; }
  renderCrossLinks('audit', id, `audit-links-${id}`);
}

function renderAuditGantt(audits) {
  const wrap = document.getElementById('audit-gantt-wrap');
  const today = new Date().toISOString().split('T')[0];
  const todayDate = new Date(today + 'T12:00:00');
  const todayMonth = todayDate.getFullYear() === auditYear ? todayDate.getMonth() : -1;
  const todayDayOfMonth = todayDate.getDate();
  const shortMonths = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Filter audits that fall within the selected year
  const yearAudits = audits.filter(a => {
    const d = a.planned_date || a.created_at?.split(' ')[0];
    if (!d) return false;
    return d.startsWith(String(auditYear));
  });

  if (yearAudits.length === 0) {
    wrap.innerHTML = `<div class="empty-state" style="padding:20px">No audits planned for ${auditYear}</div>`;
    return;
  }

  let html = '<table class="gantt-table"><thead><tr><th>Audit</th>';
  for (let m = 0; m < 12; m++) html += `<th>${shortMonths[m]}</th>`;
  html += '</tr></thead><tbody>';

  for (const a of yearAudits) {
    const plannedDate = a.planned_date || a.created_at?.split(' ')[0];
    const plannedMonth = plannedDate ? parseInt(plannedDate.split('-')[1]) - 1 : -1;
    const completedDate = a.completed_date;
    const completedMonth = completedDate ? parseInt(completedDate.split('-')[1]) - 1 : -1;

    const statusColor = a.status === 'completed' ? 'completed' : a.status === 'in_progress' ? 'due' : a.status === 'cancelled' ? '' : (plannedDate && plannedDate < today ? 'overdue' : 'due');

    html += `<tr><td title="${esc(a.title)}">${esc(a.title)}</td>`;
    for (let m = 0; m < 12; m++) {
      const daysInMonth = new Date(auditYear, m + 1, 0).getDate();
      html += '<td class="gantt-cell"><div class="gantt-bar">';
      if (m === todayMonth) {
        const pct = ((todayDayOfMonth - 0.5) / daysInMonth) * 100;
        html += `<div class="gantt-today-line" style="left:${pct}%"></div>`;
      }
      if (m === plannedMonth) {
        html += `<span class="gantt-dot ${statusColor}" title="Planned: ${plannedDate}"></span>`;
      }
      if (m === completedMonth && completedMonth !== plannedMonth) {
        html += `<span class="gantt-dot completed" title="Completed: ${completedDate}"></span>`;
      }
      html += '</div></td>';
    }
    html += '</tr>';
  }

  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function renderAuditFilters() {
  document.getElementById('audit-filters-bar').innerHTML = `
    <select onchange="auditFilters.status=this.value;loadAuditPlan()">
      <option value="" ${auditFilters.status===''?'selected':''}>All Status</option>
      <option value="planned" ${auditFilters.status==='planned'?'selected':''}>Planned</option>
      <option value="in_progress" ${auditFilters.status==='in_progress'?'selected':''}>In Progress</option>
      <option value="completed" ${auditFilters.status==='completed'?'selected':''}>Completed</option>
      <option value="cancelled" ${auditFilters.status==='cancelled'?'selected':''}>Cancelled</option>
    </select>`;
}

async function startAudit(id) {
  await api(`/api/audits/${id}`, { method: 'PUT', body: { status: 'in_progress' } });
  loadAuditPlan();
}

async function deleteAudit(id) {
  if (!confirm('Delete this audit and all its data?')) return;
  await api(`/api/audits/${id}`, { method: 'DELETE' });
  loadAuditPlan();
}

async function switchToExecute(id) {
  currentView = 'audit-execute';
  closeDayDetail();
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById('view-audit-execute').classList.remove('hidden');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const activeLink = document.querySelector('[data-view="audit-execute"]');
  if (activeLink) activeLink.classList.add('active');
  const parentSubmenu = activeLink?.closest('.module-submenu');
  if (parentSubmenu && !parentSubmenu.classList.contains('open')) {
    parentSubmenu.classList.add('open');
    parentSubmenu.previousElementSibling?.classList.remove('collapsed');
  }
  await loadAuditExecuteView();
  document.getElementById('audit-exec-select').value = String(id);
  loadAuditExecution(id);
}

async function openAuditModal(id) {
  const modal = document.getElementById('audit-modal');
  document.getElementById('audit-form').reset();
  document.getElementById('audit-id').value = '';
  document.getElementById('audit-modal-title').textContent = 'New Audit';
  document.getElementById('audit-status-group').classList.add('hidden');
  document.getElementById('audit-summary-group').classList.add('hidden');

  if (id) {
    const a = await api(`/api/audits/${id}`);
    document.getElementById('audit-modal-title').textContent = 'Edit Audit';
    document.getElementById('audit-id').value = a.id;
    document.getElementById('audit-title').value = a.title;
    document.getElementById('audit-standard').value = a.standard;
    document.getElementById('audit-scope').value = a.scope;
    document.getElementById('audit-lead').value = a.lead_auditor;
    document.getElementById('audit-team').value = a.audit_team;
    document.getElementById('audit-planned-date').value = a.planned_date || '';
    document.getElementById('audit-status-field').value = a.status;
    document.getElementById('audit-summary').value = a.summary || '';
    document.getElementById('audit-status-group').classList.remove('hidden');
    document.getElementById('audit-summary-group').classList.remove('hidden');
  }

  // Load requirements picker based on selected standard
  await populateAuditReqPicker(id);

  modal.classList.remove('hidden');
}

async function populateAuditReqPicker(auditId) {
  const standard = document.getElementById('audit-standard').value;
  const reqs = await api(`/api/requirements?standard=${encodeURIComponent(standard)}`);
  const container = document.getElementById('audit-req-checklist');

  // If editing, find which clauses already have checklist items
  let existingClauses = [];
  if (auditId) {
    const audit = await api(`/api/audits/${auditId}`);
    existingClauses = audit.checklist.map(c => c.clause);
  }

  if (reqs.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:12px;font-size:13px">No requirements found for this standard. Import a template in the Requirements view first.</div>';
    document.getElementById('audit-req-count').textContent = '';
    return;
  }

  // Group by category
  const groups = {};
  for (const r of reqs) {
    const cat = r.category || 'Uncategorized';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(r);
  }

  let html = '';
  for (const [cat, items] of Object.entries(groups)) {
    html += `<div class="req-picker-category">${esc(cat)}</div>`;
    for (const r of items) {
      const alreadyAdded = existingClauses.includes(r.clause);
      html += `<label class="req-picker-item${alreadyAdded ? ' already-added' : ''}">
        <input type="checkbox" name="audit_req_ids" value="${r.id}" ${alreadyAdded ? 'disabled checked' : ''} onchange="updateAuditReqCount()">
        <span class="req-picker-clause">${esc(r.clause)}</span>
        <span class="req-picker-title">${esc(r.title)}</span>
        ${r.owner ? `<span style="font-size:11px;color:var(--text-muted);flex-shrink:0">${esc(r.owner)}</span>` : ''}
        ${alreadyAdded ? '<span class="badge badge-low" style="font-size:10px;flex-shrink:0">already added</span>' : ''}
      </label>`;
    }
  }
  container.innerHTML = html;
  updateAuditReqCount();
}

function updateAuditReqCount() {
  const checked = document.querySelectorAll('#audit-req-checklist input[name="audit_req_ids"]:checked:not(:disabled)').length;
  const total = document.querySelectorAll('#audit-req-checklist input[name="audit_req_ids"]:not(:disabled)').length;
  document.getElementById('audit-req-count').textContent = `${checked} of ${total} selected`;
}

function auditReqSelectAll(select) {
  document.querySelectorAll('#audit-req-checklist input[name="audit_req_ids"]:not(:disabled)').forEach(cb => {
    cb.checked = select;
  });
  updateAuditReqCount();
}

// Re-populate requirements when standard changes
document.getElementById('audit-standard').addEventListener('change', () => {
  const auditId = document.getElementById('audit-id').value;
  populateAuditReqPicker(auditId || null);
});

function closeAuditModal() {
  document.getElementById('audit-modal').classList.add('hidden');
}

async function saveAudit(e) {
  e.preventDefault();
  const id = document.getElementById('audit-id').value;
  const body = {
    title: document.getElementById('audit-title').value,
    standard: document.getElementById('audit-standard').value,
    scope: document.getElementById('audit-scope').value,
    lead_auditor: document.getElementById('audit-lead').value,
    audit_team: document.getElementById('audit-team').value,
    planned_date: document.getElementById('audit-planned-date').value || null,
  };

  // Collect selected requirement IDs (only non-disabled = new selections)
  const selectedReqIds = [...document.querySelectorAll('#audit-req-checklist input[name="audit_req_ids"]:checked:not(:disabled)')].map(cb => parseInt(cb.value));
  if (selectedReqIds.length > 0) {
    body.requirement_ids = selectedReqIds;
  }

  if (id) {
    body.status = document.getElementById('audit-status-field').value;
    body.summary = document.getElementById('audit-summary').value;
    await api(`/api/audits/${id}`, { method: 'PUT', body });
  } else {
    await api('/api/audits', { method: 'POST', body });
  }
  closeAuditModal();
  refreshCurrentView();
}

// --- Audit Execution ---
async function loadAuditExecuteView() {
  const audits = await api('/api/audits');
  const sel = document.getElementById('audit-exec-select');
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">Select an audit...</option>' +
    audits.filter(a => a.status !== 'cancelled').map(a =>
      `<option value="${a.id}" ${String(a.id) === currentVal ? 'selected' : ''}>${esc(a.title)} (${a.status.replace('_',' ')})</option>`
    ).join('');
  if (currentVal) loadAuditExecution(currentVal);
  else document.getElementById('audit-exec-content').innerHTML = '<div class="empty-state">Select an audit to begin execution.</div>';
}

async function loadAuditExecution(auditId) {
  if (!auditId) {
    document.getElementById('audit-exec-content').innerHTML = '<div class="empty-state">Select an audit to begin execution.</div>';
    return;
  }
  currentAuditId = auditId;
  const audit = await api(`/api/audits/${auditId}`);
  const content = document.getElementById('audit-exec-content');

  // Summary bar
  const totalItems = audit.checklist.length;
  const assessed = audit.checklist.filter(c => c.rating !== 'not_assessed').length;
  const conforming = audit.checklist.filter(c => c.rating === 'conforming').length;
  const observations = audit.checklist.filter(c => c.rating === 'observation').length;
  const minorNc = audit.checklist.filter(c => c.rating === 'minor_nc').length;
  const majorNc = audit.checklist.filter(c => c.rating === 'major_nc').length;

  let html = `
    <div class="audit-exec-info">
      <div><strong>Standard:</strong> ${esc(audit.standard)}</div>
      <div><strong>Lead:</strong> ${esc(audit.lead_auditor || 'Unassigned')}</div>
      <div><strong>Status:</strong> <span class="badge ${audit.status === 'completed' ? 'badge-low' : 'badge-medium'}">${audit.status.replace('_',' ')}</span></div>
      ${audit.scope ? `<div><strong>Scope:</strong> ${esc(audit.scope)}</div>` : ''}
    </div>
    <div class="audit-exec-stats">
      <div class="stat-card"><div class="stat-value">${totalItems}</div><div class="stat-label">Total Items</div></div>
      <div class="stat-card done"><div class="stat-value">${assessed}</div><div class="stat-label">Assessed</div></div>
      <div class="stat-card"><div class="stat-value">${conforming}</div><div class="stat-label">Conforming</div></div>
      <div class="stat-card today"><div class="stat-value">${observations}</div><div class="stat-label">Observations</div></div>
      <div class="stat-card overdue"><div class="stat-value">${minorNc + majorNc}</div><div class="stat-label">NC</div></div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin:16px 0">
      <h3 class="section-title" style="margin:0;border:none;padding:0">Audit Checklist</h3>
      <div style="display:flex;gap:6px">
        <button class="btn btn-primary btn-sm" onclick="openChecklistModal(${auditId})">+ Add Item</button>
        ${audit.status === 'in_progress' ? `<button class="btn btn-success btn-sm" onclick="completeAudit(${auditId})">Complete Audit</button>` : ''}
      </div>
    </div>`;

  if (audit.checklist.length === 0) {
    html += '<div class="empty-state">No checklist items yet. Add clauses to audit against.</div>';
  } else {
    // Build map of checklist item id -> NCR for linking
    const ncrByChecklist = {};
    for (const nc of audit.non_conformities) {
      if (nc.checklist_item_id) ncrByChecklist[nc.checklist_item_id] = nc;
    }

    html += '<div class="checklist-list">';
    for (const item of audit.checklist) {
      const ratingColors = {
        not_assessed: 'badge-inactive',
        conforming: 'badge-low',
        observation: 'badge-medium',
        minor_nc: 'badge-high',
        major_nc: 'badge-critical'
      };
      const ratingLabels = {
        not_assessed: 'Not Assessed',
        conforming: 'Conforming',
        observation: 'Observation',
        minor_nc: 'Minor NC',
        major_nc: 'Major NC'
      };
      const linkedNcr = ncrByChecklist[item.id];
      const isNc = item.rating === 'minor_nc' || item.rating === 'major_nc';

      // NCR status indicator for NC-rated items
      let ncrIndicator = '';
      if (isNc && linkedNcr) {
        const ncrStBadge = linkedNcr.status === 'open' ? 'badge-high' : linkedNcr.status === 'in_progress' ? 'badge-medium' : 'badge-low';
        ncrIndicator = `<div class="cl-ncr-link">
          <span class="badge ${ncrStBadge}">NCR: ${linkedNcr.status}</span>
          <span style="cursor:pointer;color:var(--primary);font-weight:500;font-size:12px" onclick="openNcrModal(${linkedNcr.id})">Edit NCR &rarr;</span>
        </div>`;
      }

      html += `<div class="checklist-item${isNc ? ' checklist-nc' : ''}" id="cl-item-${item.id}">
        <div class="cl-header">
          <div class="cl-clause"><strong>${esc(item.clause)}</strong></div>
          <span class="badge ${ratingColors[item.rating]}">${ratingLabels[item.rating]}</span>
        </div>
        ${item.requirement ? `<div class="cl-requirement">${esc(item.requirement)}</div>` : ''}
        <div class="cl-fields">
          <div class="form-group" style="margin-bottom:8px">
            <label>Evidence</label>
            <textarea rows="2" onchange="updateChecklistField(${item.id},'evidence',this.value)" placeholder="Evidence observed">${esc(item.evidence)}</textarea>
          </div>
          <div class="form-group" style="margin-bottom:8px">
            <label>Finding</label>
            <textarea rows="2" onchange="updateChecklistField(${item.id},'finding',this.value)" placeholder="Audit finding">${esc(item.finding)}</textarea>
          </div>
          <div class="form-row">
            <div class="form-group" style="margin-bottom:8px">
              <label>Rating</label>
              <select onchange="updateChecklistField(${item.id},'rating',this.value)">
                <option value="not_assessed" ${item.rating==='not_assessed'?'selected':''}>Not Assessed</option>
                <option value="conforming" ${item.rating==='conforming'?'selected':''}>Conforming</option>
                <option value="observation" ${item.rating==='observation'?'selected':''}>Observation</option>
                <option value="minor_nc" ${item.rating==='minor_nc'?'selected':''}>Minor NC</option>
                <option value="major_nc" ${item.rating==='major_nc'?'selected':''}>Major NC</option>
              </select>
            </div>
            <div class="form-group" style="margin-bottom:8px">
              <label>Notes</label>
              <input type="text" onchange="updateChecklistField(${item.id},'notes',this.value)" value="${esc(item.notes)}" placeholder="Additional notes">
            </div>
          </div>
        </div>
        ${ncrIndicator}
        <div class="cl-actions">
          ${actionMenu([
            { label: '&#128465; Remove Item', onclick: `deleteChecklistItem(${item.id}, ${auditId})`, cls: 'danger' },
          ])}
        </div>
      </div>`;
    }
    html += '</div>';
  }

  // Show NCs for this audit
  if (audit.non_conformities.length > 0) {
    html += '<h3 class="section-title" style="margin-top:20px">Non-Conformities for this Audit</h3>';
    html += audit.non_conformities.map(n => {
      const sevBadge = n.severity === 'major' ? 'badge-critical' : 'badge-high';
      const stBadge = n.status === 'open' ? 'badge-high' : n.status === 'in_progress' ? 'badge-medium' : 'badge-low';
      return `<div class="ncr-card">
        <div style="display:flex;justify-content:space-between;align-items:start">
          <div>
            <span class="badge ${sevBadge}">${n.severity}</span>
            ${n.clause ? `<strong>Clause ${esc(n.clause)}</strong>` : ''}
            <span class="badge ${stBadge}">${n.status}</span>
          </div>
          ${actionMenu([
            { label: '&#9998; Edit NCR', onclick: `openNcrModal(${n.id})` },
          ])}
        </div>
        <p style="margin:8px 0;font-size:13px">${esc(n.description)}</p>
        ${n.responsible ? `<div class="ncr-meta">Responsible: ${esc(n.responsible)}${n.due_date ? ' | Due: ' + n.due_date : ''}</div>` : ''}
      </div>`;
    }).join('');
  }

  content.innerHTML = html;
}

async function updateChecklistField(itemId, field, value) {
  await api(`/api/checklist/${itemId}`, { method: 'PUT', body: { [field]: value } });
  // Re-render on rating change so badge and Raise NCR button update
  if (field === 'rating' && currentAuditId) {
    loadAuditExecution(currentAuditId);
  }
}

async function completeAudit(auditId) {
  if (!confirm('Mark this audit as completed?')) return;
  await api(`/api/audits/${auditId}`, { method: 'PUT', body: { status: 'completed', completed_date: new Date().toISOString().split('T')[0] } });
  loadAuditExecution(auditId);
}

async function openChecklistModal(auditId) {
  document.getElementById('checklist-form').reset();
  document.getElementById('checklist-item-id').value = '';
  document.getElementById('checklist-audit-id').value = auditId;

  // Populate requirements dropdown based on audit's standard
  const audit = await api(`/api/audits/${auditId}`);
  const reqs = await api(`/api/requirements?standard=${encodeURIComponent(audit.standard)}`);
  const sel = document.getElementById('checklist-from-req');
  sel.innerHTML = '<option value="">-- Manual entry --</option>' +
    reqs.map(r => `<option value="${r.id}" data-clause="${esc(r.clause)}" data-title="${esc(r.title)}">${esc(r.clause)} - ${esc(r.title)}</option>`).join('');

  document.getElementById('checklist-modal').classList.remove('hidden');
}

function closeChecklistModal() {
  document.getElementById('checklist-modal').classList.add('hidden');
}

async function saveChecklistItem(e) {
  e.preventDefault();
  const auditId = document.getElementById('checklist-audit-id').value;
  await api(`/api/audits/${auditId}/checklist`, {
    method: 'POST',
    body: {
      clause: document.getElementById('checklist-clause').value,
      requirement: document.getElementById('checklist-requirement').value,
    }
  });
  closeChecklistModal();
  loadAuditExecution(auditId);
}

async function deleteChecklistItem(itemId, auditId) {
  if (!confirm('Remove this checklist item?')) return;
  await api(`/api/checklist/${itemId}`, { method: 'DELETE' });
  loadAuditExecution(auditId);
}

async function raiseNcrFromChecklist(auditId, checklistItemId, clause, severity) {
  await openNcrModal();
  document.getElementById('ncr-audit-id').value = String(auditId);
  document.getElementById('ncr-checklist-item-id').value = checklistItemId;
  document.getElementById('ncr-clause').value = clause;
  document.getElementById('ncr-severity').value = severity;
}

// --- Non-Conformities View ---
async function loadNcrs() {
  const params = new URLSearchParams();
  if (ncrFilters.status) params.set('status', ncrFilters.status);
  if (ncrFilters.audit_id) params.set('audit_id', ncrFilters.audit_id);
  const ncrs = await api(`/api/ncrs?${params}`);
  await renderNcrFilters();
  renderNcrTable(ncrs);
}

async function renderNcrFilters() {
  const audits = await api('/api/audits');
  document.getElementById('ncr-filters-bar').innerHTML = `
    <select onchange="ncrFilters.status=this.value;loadNcrs()">
      <option value="" ${ncrFilters.status===''?'selected':''}>All Status</option>
      <option value="open" ${ncrFilters.status==='open'?'selected':''}>Open</option>
      <option value="in_progress" ${ncrFilters.status==='in_progress'?'selected':''}>In Progress</option>
      <option value="closed" ${ncrFilters.status==='closed'?'selected':''}>Closed</option>
      <option value="verified" ${ncrFilters.status==='verified'?'selected':''}>Verified</option>
    </select>
    <select onchange="ncrFilters.audit_id=this.value;loadNcrs()">
      <option value="">All Audits</option>
      ${audits.map(a => `<option value="${a.id}" ${ncrFilters.audit_id==a.id?'selected':''}>${esc(a.title)}</option>`).join('')}
    </select>`;
}

function renderNcrTable(ncrs) {
  const tbody = document.getElementById('ncr-table-body');
  const today = new Date().toISOString().split('T')[0];
  if (ncrs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No non-conformities found</td></tr>';
    return;
  }
  tbody.innerHTML = ncrs.map(n => {
    const sevBadge = n.severity === 'major' ? 'badge-critical' : 'badge-high';
    const stBadge = n.status === 'open' ? 'badge-high' : n.status === 'in_progress' ? 'badge-medium' : 'badge-low';
    const isOverdue = n.due_date && n.due_date < today && (n.status === 'open' || n.status === 'in_progress');
    return `<tr>
      <td><strong>${esc(n.description.substring(0, 80))}${n.description.length > 80 ? '...' : ''}</strong>
        <div id="ncr-links-${n.id}"></div>
      </td>
      <td>${esc(n.audit_title)}</td>
      <td>${esc(n.clause || '-')}</td>
      <td><span class="badge ${sevBadge}">${n.severity}</span></td>
      <td>${esc(n.responsible || '-')}</td>
      <td>${n.due_date ? (isOverdue ? '<span style="color:var(--danger);font-weight:600">' + n.due_date + '</span>' : n.due_date) : '-'}</td>
      <td><span class="badge ${stBadge}">${n.status}</span></td>
      <td>${actionMenu([
        ...(n.status === 'open' ? [{ label: '&#9654; Start', onclick: `updateNcrStatus(${n.id},'in_progress')`, cls: 'primary' }] : []),
        ...(n.status === 'in_progress' ? [{ label: '&#10003; Close', onclick: `updateNcrStatus(${n.id},'closed')`, cls: 'success' }] : []),
        ...(n.status === 'closed' ? [{ label: '&#10003; Verify', onclick: `updateNcrStatus(${n.id},'verified')`, cls: 'success' }] : []),
        { label: '&#128279; Links', onclick: `toggleNcrLinks(${n.id})` },
        { label: '&#9998; Edit', onclick: `openNcrModal(${n.id})` },
        'sep',
        { label: '&#128465; Delete', onclick: `deleteNcr(${n.id})`, cls: 'danger' },
      ])}</td>
    </tr>`;
  }).join('');
}

function toggleNcrLinks(id) {
  const el = document.getElementById(`ncr-links-${id}`);
  if (el.innerHTML) { el.innerHTML = ''; return; }
  renderCrossLinks('ncr', id, `ncr-links-${id}`);
}

async function updateNcrStatus(id, status) {
  await api(`/api/ncrs/${id}`, { method: 'PUT', body: { status } });
  refreshCurrentView();
}

async function deleteNcr(id) {
  if (!confirm('Delete this non-conformity?')) return;
  await api(`/api/ncrs/${id}`, { method: 'DELETE' });
  refreshCurrentView();
}

async function openNcrModal(id) {
  const modal = document.getElementById('ncr-modal');
  document.getElementById('ncr-form').reset();
  document.getElementById('ncr-id').value = '';
  document.getElementById('ncr-checklist-item-id').value = '';
  document.getElementById('ncr-modal-title').textContent = 'New Non-Conformity';
  document.getElementById('ncr-status-row').classList.add('hidden');

  // Populate audit dropdown
  const audits = await api('/api/audits');
  document.getElementById('ncr-audit-id').innerHTML = audits.map(a =>
    `<option value="${a.id}">${esc(a.title)}</option>`
  ).join('');

  // Populate clause datalist from requirements
  const allReqs = await api('/api/requirements');
  document.getElementById('ncr-clause-list').innerHTML = allReqs.map(r =>
    `<option value="${esc(r.clause)} - ${esc(r.title)}">`
  ).join('');

  if (id) {
    const allNcrs = await api('/api/ncrs');
    const ncrData = allNcrs.find(x => x.id === id);
    if (ncrData) {
      document.getElementById('ncr-modal-title').textContent = 'Edit Non-Conformity';
      document.getElementById('ncr-id').value = ncrData.id;
      document.getElementById('ncr-audit-id').value = ncrData.audit_id;
      document.getElementById('ncr-clause').value = ncrData.clause || '';
      document.getElementById('ncr-severity').value = ncrData.severity;
      document.getElementById('ncr-description').value = ncrData.description;
      document.getElementById('ncr-root-cause').value = ncrData.root_cause || '';
      document.getElementById('ncr-correction').value = ncrData.correction || '';
      document.getElementById('ncr-corrective-action').value = ncrData.corrective_action || '';
      document.getElementById('ncr-responsible').value = ncrData.responsible || '';
      document.getElementById('ncr-due-date').value = ncrData.due_date || '';
      document.getElementById('ncr-status-field').value = ncrData.status;
      document.getElementById('ncr-verification-notes').value = ncrData.verification_notes || '';
      document.getElementById('ncr-status-row').classList.remove('hidden');
    }
  }
  modal.classList.remove('hidden');
}

function closeNcrModal() {
  document.getElementById('ncr-modal').classList.add('hidden');
}

async function saveNcr(e) {
  e.preventDefault();
  const id = document.getElementById('ncr-id').value;
  const body = {
    audit_id: parseInt(document.getElementById('ncr-audit-id').value),
    clause: document.getElementById('ncr-clause').value,
    description: document.getElementById('ncr-description').value,
    severity: document.getElementById('ncr-severity').value,
    root_cause: document.getElementById('ncr-root-cause').value,
    correction: document.getElementById('ncr-correction').value,
    corrective_action: document.getElementById('ncr-corrective-action').value,
    responsible: document.getElementById('ncr-responsible').value,
    due_date: document.getElementById('ncr-due-date').value || null,
  };
  if (id) {
    body.status = document.getElementById('ncr-status-field').value;
    body.verification_notes = document.getElementById('ncr-verification-notes').value;
    await api(`/api/ncrs/${id}`, { method: 'PUT', body });
  } else {
    body.checklist_item_id = document.getElementById('ncr-checklist-item-id').value || null;
    await api('/api/ncrs', { method: 'POST', body });
  }
  closeNcrModal();
  refreshCurrentView();
}

// --- Gantt Chart ---
function renderGanttChart(data, monthStats, today) {
  const wrap = document.getElementById('gantt-wrap');
  // Collect all unique tasks across the year
  const taskMap = {};
  for (let m = 0; m < 12; m++) {
    for (const t of Object.values(monthStats[m].taskDates)) {
      if (!taskMap[t.task_id]) {
        taskMap[t.task_id] = { task_id: t.task_id, title: t.title, priority: t.priority, assignee: t.assignee, recurrence: t.recurrence, months: {} };
      }
      if (!taskMap[t.task_id].months[m]) taskMap[t.task_id].months[m] = [];
      for (const d of t.dates) {
        taskMap[t.task_id].months[m].push(d);
      }
    }
  }

  const tasks = Object.values(taskMap);
  if (tasks.length === 0) {
    wrap.innerHTML = '<div class="empty-state" style="padding:20px">No tasks to display in timeline</div>';
    return;
  }

  // Sort by title
  tasks.sort((a, b) => a.title.localeCompare(b.title));

  // Determine today position for the marker
  const todayDate = new Date(today + 'T12:00:00');
  const todayMonth = todayDate.getFullYear() === yearlyYear ? todayDate.getMonth() : -1;
  const todayDayOfMonth = todayDate.getDate();

  // Build table
  let html = '<table class="gantt-table"><thead><tr><th>Task</th>';
  const shortMonths = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  for (let m = 0; m < 12; m++) {
    html += `<th>${shortMonths[m]}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (const task of tasks) {
    html += `<tr><td title="${esc(task.title)}">${esc(task.title)}</td>`;
    for (let m = 0; m < 12; m++) {
      const daysInMonth = new Date(yearlyYear, m + 1, 0).getDate();
      const dates = task.months[m] || [];
      html += '<td class="gantt-cell"><div class="gantt-bar">';
      // Today marker
      if (m === todayMonth) {
        const pct = ((todayDayOfMonth - 0.5) / daysInMonth) * 100;
        html += `<div class="gantt-today-line" style="left:${pct}%"></div>`;
      }
      for (const d of dates) {
        html += `<span class="gantt-dot ${d.type}" title="${d.date}"></span>`;
      }
      html += '</div></td>';
    }
    html += '</tr>';
  }

  html += '</tbody></table>';
  wrap.innerHTML = html;
}

// --- Requirements Module ---
function ratingBadgeClass(rating) {
  const map = { not_assessed: 'badge-inactive', conforming: 'badge-low', observation: 'badge-medium', minor_nc: 'badge-high', major_nc: 'badge-critical' };
  return map[rating] || 'badge-inactive';
}
function ratingLabel(rating) {
  const map = { not_assessed: 'Not Assessed', conforming: 'Conforming', observation: 'Observation', minor_nc: 'Minor NC', major_nc: 'Major NC' };
  return map[rating] || rating;
}

let reqFilters = { standard: '' };

async function loadRequirements() {
  const params = new URLSearchParams();
  if (reqFilters.standard) params.set('standard', reqFilters.standard);
  const reqs = await api(`/api/requirements?${params}`);
  const standards = await api('/api/requirements/standards');

  // Render filter bar
  document.getElementById('req-filters-bar').innerHTML = `
    <select onchange="reqFilters.standard=this.value;loadRequirements()">
      <option value="">All Standards</option>
      ${standards.map(s => `<option value="${esc(s)}" ${reqFilters.standard===s?'selected':''}>${esc(s)}</option>`).join('')}
    </select>
    <span style="font-size:13px;color:var(--text-muted)">${reqs.length} requirement${reqs.length!==1?'s':''}</span>`;

  // Group by category
  const groups = {};
  for (const r of reqs) {
    const cat = r.category || 'Uncategorized';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(r);
  }

  // Stats
  const statsEl = document.getElementById('req-stats');
  statsEl.innerHTML = `
    <div class="req-stats-grid">
      <div class="stat-card"><div class="stat-value">${reqs.length}</div><div class="stat-label">Total Requirements</div></div>
      <div class="stat-card"><div class="stat-value">${standards.length}</div><div class="stat-label">Standards</div></div>
      <div class="stat-card"><div class="stat-value">${Object.keys(groups).length}</div><div class="stat-label">Categories</div></div>
    </div>`;

  // List
  const list = document.getElementById('req-list');
  if (reqs.length === 0) {
    list.innerHTML = '<div class="empty-state">No requirements yet. Add manually or import a standard template.</div>';
    return;
  }

  let html = '';
  for (const [cat, items] of Object.entries(groups)) {
    items.sort((a, b) => a.clause.localeCompare(b.clause, undefined, { numeric: true }));
    html += `<div class="req-category-group">
      <div class="req-category-header">${esc(cat)} <span class="req-cat-count">(${items.length})</span></div>`;
    for (const r of items) {
      // Audit history badges
      const lastAuditBadge = r.last_audited
        ? `<span class="req-audit-info" title="Last audited in: ${esc(r.last_audit_title || '')}">${r.last_audited}</span>`
        : '<span class="req-audit-info none">Never audited</span>';

      const ratingBadge = r.last_rating
        ? `<span class="badge ${ratingBadgeClass(r.last_rating)}">${ratingLabel(r.last_rating)}</span>`
        : '';

      let ncBadge = '';
      if (r.nc_total > 0) {
        if (r.nc_open > 0) {
          ncBadge = `<span class="badge badge-high" title="${r.nc_open} open, ${r.nc_closed} treated">${r.nc_open} open NC</span>`;
        } else {
          ncBadge = `<span class="badge badge-low" title="All ${r.nc_total} NCs treated">${r.nc_total} NC (all treated)</span>`;
        }
      }

      html += `<div class="req-item">
        <div class="req-item-main">
          <div class="req-clause">${esc(r.clause)}</div>
          <div class="req-title">${esc(r.title)}</div>
          ${r.description ? `<div class="req-desc">${esc(r.description)}</div>` : ''}
        </div>
        <div class="req-item-audit-history">
          ${lastAuditBadge}
          ${ratingBadge}
          ${ncBadge}
        </div>
        <div class="req-item-meta">
          <span class="badge badge-low">${esc(r.standard)}</span>
          ${r.owner ? `<span class="req-audit-info">${esc(r.owner)}</span>` : ''}
          ${actionMenu([
            { label: '&#128279; Links', onclick: `toggleReqLinks(${r.id})` },
            { label: '&#9998; Edit', onclick: `openRequirementModal(${r.id})` },
            'sep',
            { label: '&#128465; Delete', onclick: `deleteRequirement(${r.id})`, cls: 'danger' },
          ])}
        </div>
        <div id="req-links-${r.id}"></div>
      </div>`;
    }
    html += '</div>';
  }
  list.innerHTML = html;
}

function toggleReqLinks(id) {
  const el = document.getElementById(`req-links-${id}`);
  if (el.innerHTML) { el.innerHTML = ''; return; }
  renderCrossLinks('requirement', id, `req-links-${id}`);
}

async function openRequirementModal(id) {
  const modal = document.getElementById('requirement-modal');
  document.getElementById('requirement-form').reset();
  document.getElementById('req-id').value = '';
  document.getElementById('req-modal-title').textContent = 'New Requirement';

  // Populate standard datalist from existing
  const standards = await api('/api/requirements/standards');
  document.getElementById('req-standard-list').innerHTML = standards.map(s => `<option value="${esc(s)}">`).join('');
  // Populate category and owner datalists
  const reqs = await api('/api/requirements');
  const cats = [...new Set(reqs.map(r => r.category).filter(Boolean))];
  document.getElementById('req-category-list').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');
  const owners = [...new Set(reqs.map(r => r.owner).filter(Boolean))];
  document.getElementById('req-owner-list').innerHTML = owners.map(o => `<option value="${esc(o)}">`).join('');

  if (id) {
    const r = reqs.find(x => x.id === id);
    if (r) {
      document.getElementById('req-modal-title').textContent = 'Edit Requirement';
      document.getElementById('req-id').value = r.id;
      document.getElementById('req-standard').value = r.standard;
      document.getElementById('req-clause').value = r.clause;
      document.getElementById('req-title-field').value = r.title;
      document.getElementById('req-description').value = r.description || '';
      document.getElementById('req-category-field').value = r.category || '';
      document.getElementById('req-owner').value = r.owner || '';
    }
  }
  modal.classList.remove('hidden');
}

function closeRequirementModal() {
  document.getElementById('requirement-modal').classList.add('hidden');
}

async function saveRequirement(e) {
  e.preventDefault();
  const id = document.getElementById('req-id').value;
  const body = {
    standard: document.getElementById('req-standard').value,
    clause: document.getElementById('req-clause').value,
    title: document.getElementById('req-title-field').value,
    description: document.getElementById('req-description').value,
    category: document.getElementById('req-category-field').value,
    owner: document.getElementById('req-owner').value,
  };
  if (id) {
    await api(`/api/requirements/${id}`, { method: 'PUT', body });
  } else {
    await api('/api/requirements', { method: 'POST', body });
  }
  closeRequirementModal();
  loadRequirements();
}

async function deleteRequirement(id) {
  if (!confirm('Delete this requirement?')) return;
  await api(`/api/requirements/${id}`, { method: 'DELETE' });
  loadRequirements();
}

function openImportRequirementsModal() {
  document.getElementById('import-req-modal').classList.remove('hidden');
}

function closeImportRequirementsModal() {
  document.getElementById('import-req-modal').classList.add('hidden');
}

async function importStandardTemplate(standard) {
  const templates = {
    'ISO 9001': [
      { clause: '4.1', title: 'Understanding the organization and its context', category: 'Context of the Organization' },
      { clause: '4.2', title: 'Understanding the needs and expectations of interested parties', category: 'Context of the Organization' },
      { clause: '4.3', title: 'Determining the scope of the QMS', category: 'Context of the Organization' },
      { clause: '4.4', title: 'Quality management system and its processes', category: 'Context of the Organization' },
      { clause: '5.1', title: 'Leadership and commitment', category: 'Leadership' },
      { clause: '5.2', title: 'Policy', category: 'Leadership' },
      { clause: '5.3', title: 'Organizational roles, responsibilities and authorities', category: 'Leadership' },
      { clause: '6.1', title: 'Actions to address risks and opportunities', category: 'Planning' },
      { clause: '6.2', title: 'Quality objectives and planning to achieve them', category: 'Planning' },
      { clause: '6.3', title: 'Planning of changes', category: 'Planning' },
      { clause: '7.1', title: 'Resources', category: 'Support' },
      { clause: '7.2', title: 'Competence', category: 'Support' },
      { clause: '7.3', title: 'Awareness', category: 'Support' },
      { clause: '7.4', title: 'Communication', category: 'Support' },
      { clause: '7.5', title: 'Documented information', category: 'Support' },
      { clause: '8.1', title: 'Operational planning and control', category: 'Operation' },
      { clause: '8.2', title: 'Requirements for products and services', category: 'Operation' },
      { clause: '8.3', title: 'Design and development of products and services', category: 'Operation' },
      { clause: '8.4', title: 'Control of externally provided processes, products and services', category: 'Operation' },
      { clause: '8.5', title: 'Production and service provision', category: 'Operation' },
      { clause: '8.6', title: 'Release of products and services', category: 'Operation' },
      { clause: '8.7', title: 'Control of nonconforming outputs', category: 'Operation' },
      { clause: '9.1', title: 'Monitoring, measurement, analysis and evaluation', category: 'Performance Evaluation' },
      { clause: '9.2', title: 'Internal audit', category: 'Performance Evaluation' },
      { clause: '9.3', title: 'Management review', category: 'Performance Evaluation' },
      { clause: '10.1', title: 'General', category: 'Improvement' },
      { clause: '10.2', title: 'Nonconformity and corrective action', category: 'Improvement' },
      { clause: '10.3', title: 'Continual improvement', category: 'Improvement' },
    ],
    'ISO 14001': [
      { clause: '4.1', title: 'Understanding the organization and its context', category: 'Context of the Organization' },
      { clause: '4.2', title: 'Understanding the needs and expectations of interested parties', category: 'Context of the Organization' },
      { clause: '4.3', title: 'Determining the scope of the EMS', category: 'Context of the Organization' },
      { clause: '4.4', title: 'Environmental management system', category: 'Context of the Organization' },
      { clause: '5.1', title: 'Leadership and commitment', category: 'Leadership' },
      { clause: '5.2', title: 'Environmental policy', category: 'Leadership' },
      { clause: '5.3', title: 'Organizational roles, responsibilities and authorities', category: 'Leadership' },
      { clause: '6.1', title: 'Actions to address risks and opportunities', category: 'Planning' },
      { clause: '6.2', title: 'Environmental objectives and planning to achieve them', category: 'Planning' },
      { clause: '7.1', title: 'Resources', category: 'Support' },
      { clause: '7.2', title: 'Competence', category: 'Support' },
      { clause: '7.3', title: 'Awareness', category: 'Support' },
      { clause: '7.4', title: 'Communication', category: 'Support' },
      { clause: '7.5', title: 'Documented information', category: 'Support' },
      { clause: '8.1', title: 'Operational planning and control', category: 'Operation' },
      { clause: '8.2', title: 'Emergency preparedness and response', category: 'Operation' },
      { clause: '9.1', title: 'Monitoring, measurement, analysis and evaluation', category: 'Performance Evaluation' },
      { clause: '9.2', title: 'Internal audit', category: 'Performance Evaluation' },
      { clause: '9.3', title: 'Management review', category: 'Performance Evaluation' },
      { clause: '10.1', title: 'General', category: 'Improvement' },
      { clause: '10.2', title: 'Nonconformity and corrective action', category: 'Improvement' },
      { clause: '10.3', title: 'Continual improvement', category: 'Improvement' },
    ],
    'ISO 45001': [
      { clause: '4.1', title: 'Understanding the organization and its context', category: 'Context of the Organization' },
      { clause: '4.2', title: 'Understanding the needs and expectations of workers and other interested parties', category: 'Context of the Organization' },
      { clause: '4.3', title: 'Determining the scope of the OH&S management system', category: 'Context of the Organization' },
      { clause: '4.4', title: 'OH&S management system', category: 'Context of the Organization' },
      { clause: '5.1', title: 'Leadership and commitment', category: 'Leadership' },
      { clause: '5.2', title: 'OH&S policy', category: 'Leadership' },
      { clause: '5.3', title: 'Organizational roles, responsibilities and authorities', category: 'Leadership' },
      { clause: '5.4', title: 'Consultation and participation of workers', category: 'Leadership' },
      { clause: '6.1', title: 'Actions to address risks and opportunities', category: 'Planning' },
      { clause: '6.2', title: 'OH&S objectives and planning to achieve them', category: 'Planning' },
      { clause: '7.1', title: 'Resources', category: 'Support' },
      { clause: '7.2', title: 'Competence', category: 'Support' },
      { clause: '7.3', title: 'Awareness', category: 'Support' },
      { clause: '7.4', title: 'Communication', category: 'Support' },
      { clause: '7.5', title: 'Documented information', category: 'Support' },
      { clause: '8.1', title: 'Operational planning and control', category: 'Operation' },
      { clause: '8.2', title: 'Emergency preparedness and response', category: 'Operation' },
      { clause: '9.1', title: 'Monitoring, measurement, analysis and evaluation', category: 'Performance Evaluation' },
      { clause: '9.2', title: 'Internal audit', category: 'Performance Evaluation' },
      { clause: '9.3', title: 'Management review', category: 'Performance Evaluation' },
      { clause: '10.1', title: 'General', category: 'Improvement' },
      { clause: '10.2', title: 'Incident, nonconformity and corrective action', category: 'Improvement' },
      { clause: '10.3', title: 'Continual improvement', category: 'Improvement' },
    ],
    'ISO 27001': [
      { clause: '4.1', title: 'Understanding the organization and its context', category: 'Context of the Organization' },
      { clause: '4.2', title: 'Understanding the needs and expectations of interested parties', category: 'Context of the Organization' },
      { clause: '4.3', title: 'Determining the scope of the ISMS', category: 'Context of the Organization' },
      { clause: '4.4', title: 'Information security management system', category: 'Context of the Organization' },
      { clause: '5.1', title: 'Leadership and commitment', category: 'Leadership' },
      { clause: '5.2', title: 'Policy', category: 'Leadership' },
      { clause: '5.3', title: 'Organizational roles, responsibilities and authorities', category: 'Leadership' },
      { clause: '6.1', title: 'Actions to address risks and opportunities', category: 'Planning' },
      { clause: '6.2', title: 'Information security objectives and planning to achieve them', category: 'Planning' },
      { clause: '6.3', title: 'Planning of changes', category: 'Planning' },
      { clause: '7.1', title: 'Resources', category: 'Support' },
      { clause: '7.2', title: 'Competence', category: 'Support' },
      { clause: '7.3', title: 'Awareness', category: 'Support' },
      { clause: '7.4', title: 'Communication', category: 'Support' },
      { clause: '7.5', title: 'Documented information', category: 'Support' },
      { clause: '8.1', title: 'Operational planning and control', category: 'Operation' },
      { clause: '8.2', title: 'Information security risk assessment', category: 'Operation' },
      { clause: '8.3', title: 'Information security risk treatment', category: 'Operation' },
      { clause: '9.1', title: 'Monitoring, measurement, analysis and evaluation', category: 'Performance Evaluation' },
      { clause: '9.2', title: 'Internal audit', category: 'Performance Evaluation' },
      { clause: '9.3', title: 'Management review', category: 'Performance Evaluation' },
      { clause: '10.1', title: 'Continual improvement', category: 'Improvement' },
      { clause: '10.2', title: 'Nonconformity and corrective action', category: 'Improvement' },
    ],
    'ISO 27001 Annex A': [
      { clause: 'A.5.1', title: 'Policies for information security', category: 'Organizational Controls' },
      { clause: 'A.5.2', title: 'Information security roles and responsibilities', category: 'Organizational Controls' },
      { clause: 'A.5.3', title: 'Segregation of duties', category: 'Organizational Controls' },
      { clause: 'A.5.4', title: 'Management responsibilities', category: 'Organizational Controls' },
      { clause: 'A.5.5', title: 'Contact with authorities', category: 'Organizational Controls' },
      { clause: 'A.5.6', title: 'Contact with special interest groups', category: 'Organizational Controls' },
      { clause: 'A.5.7', title: 'Threat intelligence', category: 'Organizational Controls' },
      { clause: 'A.5.8', title: 'Information security in project management', category: 'Organizational Controls' },
      { clause: 'A.5.9', title: 'Inventory of information and other associated assets', category: 'Organizational Controls' },
      { clause: 'A.5.10', title: 'Acceptable use of information and other associated assets', category: 'Organizational Controls' },
      { clause: 'A.5.11', title: 'Return of assets', category: 'Organizational Controls' },
      { clause: 'A.5.12', title: 'Classification of information', category: 'Organizational Controls' },
      { clause: 'A.5.13', title: 'Labelling of information', category: 'Organizational Controls' },
      { clause: 'A.5.14', title: 'Information transfer', category: 'Organizational Controls' },
      { clause: 'A.5.15', title: 'Access control', category: 'Organizational Controls' },
      { clause: 'A.5.16', title: 'Identity management', category: 'Organizational Controls' },
      { clause: 'A.5.17', title: 'Authentication information', category: 'Organizational Controls' },
      { clause: 'A.5.18', title: 'Access rights', category: 'Organizational Controls' },
      { clause: 'A.5.19', title: 'Information security in supplier relationships', category: 'Organizational Controls' },
      { clause: 'A.5.20', title: 'Addressing information security within supplier agreements', category: 'Organizational Controls' },
      { clause: 'A.5.21', title: 'Managing information security in the ICT supply chain', category: 'Organizational Controls' },
      { clause: 'A.5.22', title: 'Monitoring, review and change management of supplier services', category: 'Organizational Controls' },
      { clause: 'A.5.23', title: 'Information security for use of cloud services', category: 'Organizational Controls' },
      { clause: 'A.5.24', title: 'Information security incident management planning and preparation', category: 'Organizational Controls' },
      { clause: 'A.5.25', title: 'Assessment and decision on information security events', category: 'Organizational Controls' },
      { clause: 'A.5.26', title: 'Response to information security incidents', category: 'Organizational Controls' },
      { clause: 'A.5.27', title: 'Learning from information security incidents', category: 'Organizational Controls' },
      { clause: 'A.5.28', title: 'Collection of evidence', category: 'Organizational Controls' },
      { clause: 'A.5.29', title: 'Information security during disruption', category: 'Organizational Controls' },
      { clause: 'A.5.30', title: 'ICT readiness for business continuity', category: 'Organizational Controls' },
      { clause: 'A.5.31', title: 'Legal, statutory, regulatory and contractual requirements', category: 'Organizational Controls' },
      { clause: 'A.5.32', title: 'Intellectual property rights', category: 'Organizational Controls' },
      { clause: 'A.5.33', title: 'Protection of records', category: 'Organizational Controls' },
      { clause: 'A.5.34', title: 'Privacy and protection of PII', category: 'Organizational Controls' },
      { clause: 'A.5.35', title: 'Independent review of information security', category: 'Organizational Controls' },
      { clause: 'A.5.36', title: 'Compliance with policies, rules and standards for information security', category: 'Organizational Controls' },
      { clause: 'A.5.37', title: 'Documented operating procedures', category: 'Organizational Controls' },
      { clause: 'A.6.1', title: 'Screening', category: 'People Controls' },
      { clause: 'A.6.2', title: 'Terms and conditions of employment', category: 'People Controls' },
      { clause: 'A.6.3', title: 'Information security awareness, education and training', category: 'People Controls' },
      { clause: 'A.6.4', title: 'Disciplinary process', category: 'People Controls' },
      { clause: 'A.6.5', title: 'Responsibilities after termination or change of employment', category: 'People Controls' },
      { clause: 'A.6.6', title: 'Confidentiality or non-disclosure agreements', category: 'People Controls' },
      { clause: 'A.6.7', title: 'Remote working', category: 'People Controls' },
      { clause: 'A.6.8', title: 'Information security event reporting', category: 'People Controls' },
      { clause: 'A.7.1', title: 'Physical security perimeters', category: 'Physical Controls' },
      { clause: 'A.7.2', title: 'Physical entry', category: 'Physical Controls' },
      { clause: 'A.7.3', title: 'Securing offices, rooms and facilities', category: 'Physical Controls' },
      { clause: 'A.7.4', title: 'Physical security monitoring', category: 'Physical Controls' },
      { clause: 'A.7.5', title: 'Protecting against physical and environmental threats', category: 'Physical Controls' },
      { clause: 'A.7.6', title: 'Working in secure areas', category: 'Physical Controls' },
      { clause: 'A.7.7', title: 'Clear desk and clear screen', category: 'Physical Controls' },
      { clause: 'A.7.8', title: 'Equipment siting and protection', category: 'Physical Controls' },
      { clause: 'A.7.9', title: 'Security of assets off-premises', category: 'Physical Controls' },
      { clause: 'A.7.10', title: 'Storage media', category: 'Physical Controls' },
      { clause: 'A.7.11', title: 'Supporting utilities', category: 'Physical Controls' },
      { clause: 'A.7.12', title: 'Cabling security', category: 'Physical Controls' },
      { clause: 'A.7.13', title: 'Equipment maintenance', category: 'Physical Controls' },
      { clause: 'A.7.14', title: 'Secure disposal or re-use of equipment', category: 'Physical Controls' },
      { clause: 'A.8.1', title: 'User endpoint devices', category: 'Technological Controls' },
      { clause: 'A.8.2', title: 'Privileged access rights', category: 'Technological Controls' },
      { clause: 'A.8.3', title: 'Information access restriction', category: 'Technological Controls' },
      { clause: 'A.8.4', title: 'Access to source code', category: 'Technological Controls' },
      { clause: 'A.8.5', title: 'Secure authentication', category: 'Technological Controls' },
      { clause: 'A.8.6', title: 'Capacity management', category: 'Technological Controls' },
      { clause: 'A.8.7', title: 'Protection against malware', category: 'Technological Controls' },
      { clause: 'A.8.8', title: 'Management of technical vulnerabilities', category: 'Technological Controls' },
      { clause: 'A.8.9', title: 'Configuration management', category: 'Technological Controls' },
      { clause: 'A.8.10', title: 'Information deletion', category: 'Technological Controls' },
      { clause: 'A.8.11', title: 'Data masking', category: 'Technological Controls' },
      { clause: 'A.8.12', title: 'Data leakage prevention', category: 'Technological Controls' },
      { clause: 'A.8.13', title: 'Information backup', category: 'Technological Controls' },
      { clause: 'A.8.14', title: 'Redundancy of information processing facilities', category: 'Technological Controls' },
      { clause: 'A.8.15', title: 'Logging', category: 'Technological Controls' },
      { clause: 'A.8.16', title: 'Monitoring activities', category: 'Technological Controls' },
      { clause: 'A.8.17', title: 'Clock synchronization', category: 'Technological Controls' },
      { clause: 'A.8.18', title: 'Use of privileged utility programs', category: 'Technological Controls' },
      { clause: 'A.8.19', title: 'Installation of software on operational systems', category: 'Technological Controls' },
      { clause: 'A.8.20', title: 'Networks security', category: 'Technological Controls' },
      { clause: 'A.8.21', title: 'Security of network services', category: 'Technological Controls' },
      { clause: 'A.8.22', title: 'Segregation of networks', category: 'Technological Controls' },
      { clause: 'A.8.23', title: 'Web filtering', category: 'Technological Controls' },
      { clause: 'A.8.24', title: 'Use of cryptography', category: 'Technological Controls' },
      { clause: 'A.8.25', title: 'Secure development life cycle', category: 'Technological Controls' },
      { clause: 'A.8.26', title: 'Application security requirements', category: 'Technological Controls' },
      { clause: 'A.8.27', title: 'Secure system architecture and engineering principles', category: 'Technological Controls' },
      { clause: 'A.8.28', title: 'Secure coding', category: 'Technological Controls' },
      { clause: 'A.8.29', title: 'Security testing in development and acceptance', category: 'Technological Controls' },
      { clause: 'A.8.30', title: 'Outsourced development', category: 'Technological Controls' },
      { clause: 'A.8.31', title: 'Separation of development, test and production environments', category: 'Technological Controls' },
      { clause: 'A.8.32', title: 'Change management', category: 'Technological Controls' },
      { clause: 'A.8.33', title: 'Test information', category: 'Technological Controls' },
      { clause: 'A.8.34', title: 'Protection of information systems during audit testing', category: 'Technological Controls' },
    ],
    'ISO 42001:2023': [
      // 4 Context of the organization
      { clause: '4.1', title: 'Understanding the organization and its context', category: 'Context of the Organization' },
      { clause: '4.2', title: 'Understanding the needs and expectations of interested parties', category: 'Context of the Organization' },
      { clause: '4.3', title: 'Determining the scope of the AI management system', category: 'Context of the Organization' },
      { clause: '4.4', title: 'AI management system', category: 'Context of the Organization' },
      // 5 Leadership
      { clause: '5.1', title: 'Leadership and commitment', category: 'Leadership' },
      { clause: '5.2', title: 'AI policy', category: 'Leadership' },
      { clause: '5.3', title: 'Organizational roles, responsibilities and authorities', category: 'Leadership' },
      // 6 Planning
      { clause: '6.1', title: 'Actions to address risks and opportunities', category: 'Planning' },
      { clause: '6.1.1', title: 'General', category: 'Planning' },
      { clause: '6.1.2', title: 'AI risk assessment', category: 'Planning' },
      { clause: '6.1.3', title: 'AI risk treatment', category: 'Planning' },
      { clause: '6.1.4', title: 'AI system impact assessment', category: 'Planning' },
      { clause: '6.2', title: 'AI objectives and planning to achieve them', category: 'Planning' },
      { clause: '6.3', title: 'Planning of changes', category: 'Planning' },
      // 7 Support
      { clause: '7.1', title: 'Resources', category: 'Support' },
      { clause: '7.2', title: 'Competence', category: 'Support' },
      { clause: '7.3', title: 'Awareness', category: 'Support' },
      { clause: '7.4', title: 'Communication', category: 'Support' },
      { clause: '7.5', title: 'Documented information', category: 'Support' },
      // 8 Operation
      { clause: '8.1', title: 'Operational planning and control', category: 'Operation' },
      { clause: '8.2', title: 'AI risk assessment', category: 'Operation' },
      { clause: '8.3', title: 'AI risk treatment', category: 'Operation' },
      { clause: '8.4', title: 'AI system impact assessment', category: 'Operation' },
      // 9 Performance evaluation
      { clause: '9.1', title: 'Monitoring, measurement, analysis and evaluation', category: 'Performance Evaluation' },
      { clause: '9.2', title: 'Internal audit', category: 'Performance Evaluation' },
      { clause: '9.2.1', title: 'General', category: 'Performance Evaluation' },
      { clause: '9.2.2', title: 'Internal audit programme', category: 'Performance Evaluation' },
      { clause: '9.3', title: 'Management review', category: 'Performance Evaluation' },
      { clause: '9.3.1', title: 'General', category: 'Performance Evaluation' },
      { clause: '9.3.2', title: 'Management review inputs', category: 'Performance Evaluation' },
      { clause: '9.3.3', title: 'Management review results', category: 'Performance Evaluation' },
      // 10 Improvement
      { clause: '10.1', title: 'Continual improvement', category: 'Improvement' },
      { clause: '10.2', title: 'Nonconformity and corrective action', category: 'Improvement' },
      // Annex A - AI Controls
      { clause: 'A.2', title: 'AI policies', category: 'Annex A - AI Controls' },
      { clause: 'A.3', title: 'Internal organization for AI', category: 'Annex A - AI Controls' },
      { clause: 'A.4', title: 'Resources for AI systems', category: 'Annex A - AI Controls' },
      { clause: 'A.5', title: 'Assessing impacts of AI systems', category: 'Annex A - AI Controls' },
      { clause: 'A.6', title: 'AI system life cycle', category: 'Annex A - AI Controls' },
      { clause: 'A.6.1', title: 'AI system life cycle management', category: 'Annex A - AI Controls' },
      { clause: 'A.6.2', title: 'AI system requirements and design', category: 'Annex A - AI Controls' },
      { clause: 'A.6.3', title: 'Data for AI systems', category: 'Annex A - AI Controls' },
      { clause: 'A.6.4', title: 'AI model building and validation', category: 'Annex A - AI Controls' },
      { clause: 'A.6.5', title: 'AI system verification and validation', category: 'Annex A - AI Controls' },
      { clause: 'A.6.6', title: 'AI system deployment', category: 'Annex A - AI Controls' },
      { clause: 'A.6.7', title: 'AI system operation and monitoring', category: 'Annex A - AI Controls' },
      { clause: 'A.6.8', title: 'AI system retirement', category: 'Annex A - AI Controls' },
      { clause: 'A.7', title: 'Data management', category: 'Annex A - AI Controls' },
      { clause: 'A.8', title: 'Technology and AI system monitoring', category: 'Annex A - AI Controls' },
      { clause: 'A.9', title: 'Third-party and customer relationships', category: 'Annex A - AI Controls' },
      { clause: 'A.9.1', title: 'Use of AI as third-party or customer', category: 'Annex A - AI Controls' },
      { clause: 'A.9.2', title: 'Supplying AI to third parties', category: 'Annex A - AI Controls' },
      { clause: 'A.9.3', title: 'Responsible provision of AI', category: 'Annex A - AI Controls' },
      { clause: 'A.9.4', title: 'AI system end-user communication', category: 'Annex A - AI Controls' },
      { clause: 'A.10', title: 'Documentation and record management for AI', category: 'Annex A - AI Controls' },
      // Annex B - AI implementation guidance
      { clause: 'B.2', title: 'AI policy objectives', category: 'Annex B - Implementation Guidance' },
      { clause: 'B.3', title: 'Roles and responsibilities for AI', category: 'Annex B - Implementation Guidance' },
      { clause: 'B.4', title: 'AI resources and competence', category: 'Annex B - Implementation Guidance' },
      { clause: 'B.5', title: 'Impact assessment process', category: 'Annex B - Implementation Guidance' },
      { clause: 'B.6', title: 'AI system life cycle processes', category: 'Annex B - Implementation Guidance' },
      { clause: 'B.7', title: 'Data for AI systems guidance', category: 'Annex B - Implementation Guidance' },
      { clause: 'B.8', title: 'Monitoring and measurement of AI systems', category: 'Annex B - Implementation Guidance' },
      { clause: 'B.9', title: 'Third-party relationship management', category: 'Annex B - Implementation Guidance' },
      { clause: 'B.10', title: 'AI documentation and information management', category: 'Annex B - Implementation Guidance' },
    ],
  };

  const items = templates[standard];
  if (!items) { alert('Template not found'); return; }

  if (!confirm(`Import ${items.length} clauses for ${standard}? Existing entries for this standard will not be duplicated.`)) return;

  await api('/api/requirements/bulk', {
    method: 'POST',
    body: { standard, items }
  });

  closeImportRequirementsModal();
  loadRequirements();
}

// Fill checklist item from requirements library
function fillChecklistFromReq(reqId) {
  if (!reqId) return;
  const sel = document.getElementById('checklist-from-req');
  const opt = sel.querySelector(`option[value="${reqId}"]`);
  if (opt) {
    document.getElementById('checklist-clause').value = opt.dataset.clause || '';
    document.getElementById('checklist-requirement').value = opt.dataset.title || '';
  }
}

// --- Action Menu Helper ---
function actionMenu(items) {
  // items: array of { label, onclick, cls? } or 'sep' for separator
  let dd = '';
  for (const item of items) {
    if (item === 'sep') { dd += '<div class="action-menu-sep"></div>'; continue; }
    dd += `<button class="action-menu-item${item.cls ? ' ' + item.cls : ''}" onclick="closeAllMenus();${item.onclick}">${item.label}</button>`;
  }
  return `<div class="action-menu">
    <button class="action-menu-toggle" onclick="event.stopPropagation();toggleMenu(this)">&#9881;</button>
    <div class="action-menu-dropdown">${dd}</div>
  </div>`;
}

function toggleMenu(btn) {
  const menu = btn.closest('.action-menu');
  const wasOpen = menu.classList.contains('open');
  closeAllMenus();
  if (!wasOpen) menu.classList.add('open');
}

function closeAllMenus() {
  document.querySelectorAll('.action-menu.open').forEach(m => m.classList.remove('open'));
}

// Close menus on any outside click
document.addEventListener('click', () => closeAllMenus());

// --- Risk Management Module ---
let riskFilters = { status: '', category: '' };

function riskScoreClass(score) {
  if (score >= 20) return 'risk-critical';
  if (score >= 15) return 'risk-high';
  if (score >= 8) return 'risk-medium';
  return 'risk-low';
}
function riskScoreLabel(score) {
  if (score >= 20) return 'Critical';
  if (score >= 15) return 'High';
  if (score >= 8) return 'Medium';
  return 'Low';
}

async function loadRiskIdentification() {
  const params = new URLSearchParams();
  if (riskFilters.status) params.set('status', riskFilters.status);
  if (riskFilters.category) params.set('category', riskFilters.category);
  const risks = await api(`/api/risks?${params}`);

  // Filters
  document.getElementById('risk-filters-bar').innerHTML = `
    <select onchange="riskFilters.status=this.value;loadRiskIdentification()">
      <option value="">All Status</option>
      <option value="identified" ${riskFilters.status==='identified'?'selected':''}>Identified</option>
      <option value="analyzing" ${riskFilters.status==='analyzing'?'selected':''}>Analyzing</option>
      <option value="treating" ${riskFilters.status==='treating'?'selected':''}>Treating</option>
      <option value="accepted" ${riskFilters.status==='accepted'?'selected':''}>Accepted</option>
      <option value="closed" ${riskFilters.status==='closed'?'selected':''}>Closed</option>
    </select>
    <span style="font-size:13px;color:var(--text-muted)">${risks.length} risk${risks.length!==1?'s':''}</span>`;

  // Risk matrix (5x5 heat map)
  let matrix = '<h3 class="section-title" style="margin-bottom:8px">Risk Heat Map</h3>';
  matrix += '<table class="risk-matrix"><thead><tr><th></th>';
  for (let i = 1; i <= 5; i++) matrix += `<th>Impact ${i}</th>`;
  matrix += '</tr></thead><tbody>';
  for (let l = 5; l >= 1; l--) {
    matrix += `<tr><td class="rm-label">Likelihood ${l}</td>`;
    for (let i = 1; i <= 5; i++) {
      const score = l * i;
      const cls = riskScoreClass(score);
      const count = risks.filter(r => r.likelihood === l && r.impact === i).length;
      matrix += `<td class="rm-cell ${cls}">${count > 0 ? count : ''}</td>`;
    }
    matrix += '</tr>';
  }
  matrix += '</tbody></table>';
  document.getElementById('risk-matrix-wrap').innerHTML = matrix;

  // Risk list
  const list = document.getElementById('risk-list');
  if (risks.length === 0) {
    list.innerHTML = '<div class="empty-state">No risks identified yet. Add one to get started.</div>';
    return;
  }
  list.innerHTML = '<h3 class="section-title" style="margin-top:20px">Risk Register</h3>' + risks.map(r => {
    const cls = riskScoreClass(r.inherent_score);
    const stBadge = r.status === 'closed' ? 'badge-low' : r.status === 'accepted' ? 'badge-medium' : r.status === 'treating' ? 'badge-medium' : 'badge-high';
    return `<div class="risk-card ${cls}">
      <div class="risk-card-header">
        <div>
          <h4>${esc(r.title)}</h4>
          <div class="risk-meta">${esc(r.category)} &middot; Owner: ${esc(r.risk_owner || 'Unassigned')}${r.asset ? ' &middot; Asset: ' + esc(r.asset) : ''}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="badge risk-score-badge ${cls}">${r.inherent_score} (${riskScoreLabel(r.inherent_score)})</span>
          <span class="badge ${stBadge}">${r.status}</span>
        </div>
      </div>
      ${r.description ? `<p style="font-size:13px;color:var(--text-muted);margin:6px 0">${esc(r.description)}</p>` : ''}
      <div class="risk-card-footer">
        <div class="risk-detail">
          <span>L:${r.likelihood} x I:${r.impact} = ${r.inherent_score}</span>
          ${r.treatment_count > 0 ? `<span>&middot; ${r.treatment_count} treatment${r.treatment_count !== 1 ? 's' : ''}${r.open_treatments > 0 ? ` (${r.open_treatments} open)` : ''}</span>` : ''}
        </div>
        ${actionMenu([
          { label: '&#128736; Add Treatment', onclick: `openTreatmentModalForRisk(${r.id})`, cls: 'primary' },
          { label: '&#9998; Edit', onclick: `openRiskModal(${r.id})` },
          'sep',
          { label: '&#128465; Delete', onclick: `deleteRisk(${r.id})`, cls: 'danger' },
        ])}
      </div>
      <div id="risk-links-${r.id}"></div>
    </div>`;
  }).join('');
  // Load cross-links for each risk
  for (const r of risks) renderCrossLinks('risk', r.id, `risk-links-${r.id}`);
}

async function openRiskModal(id) {
  const modal = document.getElementById('risk-modal');
  document.getElementById('risk-form').reset();
  document.getElementById('risk-id').value = '';
  document.getElementById('risk-modal-title').textContent = 'New Risk';
  document.getElementById('risk-status-group').classList.add('hidden');

  if (id) {
    const r = await api(`/api/risks/${id}`);
    document.getElementById('risk-modal-title').textContent = 'Edit Risk';
    document.getElementById('risk-id').value = r.id;
    document.getElementById('risk-title').value = r.title;
    document.getElementById('risk-description').value = r.description;
    document.getElementById('risk-category').value = r.category;
    document.getElementById('risk-owner').value = r.risk_owner;
    document.getElementById('risk-asset').value = r.asset;
    document.getElementById('risk-source').value = r.source;
    document.getElementById('risk-threat').value = r.threat;
    document.getElementById('risk-vulnerability').value = r.vulnerability;
    document.getElementById('risk-likelihood').value = r.likelihood;
    document.getElementById('risk-impact').value = r.impact;
    document.getElementById('risk-status-field').value = r.status;
    document.getElementById('risk-status-group').classList.remove('hidden');
  }
  modal.classList.remove('hidden');
}

function closeRiskModal() { document.getElementById('risk-modal').classList.add('hidden'); }

async function saveRisk(e) {
  e.preventDefault();
  const id = document.getElementById('risk-id').value;
  const body = {
    title: document.getElementById('risk-title').value,
    description: document.getElementById('risk-description').value,
    category: document.getElementById('risk-category').value,
    risk_owner: document.getElementById('risk-owner').value,
    asset: document.getElementById('risk-asset').value,
    source: document.getElementById('risk-source').value,
    threat: document.getElementById('risk-threat').value,
    vulnerability: document.getElementById('risk-vulnerability').value,
    likelihood: parseInt(document.getElementById('risk-likelihood').value),
    impact: parseInt(document.getElementById('risk-impact').value),
  };
  if (id) {
    body.status = document.getElementById('risk-status-field').value;
    await api(`/api/risks/${id}`, { method: 'PUT', body });
  } else {
    await api('/api/risks', { method: 'POST', body });
  }
  closeRiskModal();
  refreshCurrentView();
}

async function deleteRisk(id) {
  if (!confirm('Delete this risk and all its treatments?')) return;
  await api(`/api/risks/${id}`, { method: 'DELETE' });
  refreshCurrentView();
}

// --- Risk Treatment View ---
async function loadRiskTreatmentView() {
  const risks = await api('/api/risks');
  let html = '';

  document.getElementById('treatment-filters-bar').innerHTML = `<span style="font-size:13px;color:var(--text-muted)">${risks.length} risk${risks.length !== 1 ? 's' : ''} in register</span>`;

  if (risks.length === 0) {
    document.getElementById('treatment-list').innerHTML = '<div class="empty-state">No risks identified yet. Go to Risk Identification first.</div>';
    return;
  }

  for (const r of risks) {
    const detail = await api(`/api/risks/${r.id}`);
    const cls = riskScoreClass(r.inherent_score);
    const treatments = detail.treatments || [];

    // Compute residual score
    let residualScore = r.inherent_score;
    const implemented = treatments.filter(t => t.status === 'implemented' || t.status === 'verified');
    if (implemented.length > 0) {
      const last = implemented[implemented.length - 1];
      if (last.residual_likelihood && last.residual_impact) {
        residualScore = last.residual_likelihood * last.residual_impact;
      }
    }

    html += `<div class="treatment-risk-group">
      <div class="treatment-risk-header ${cls}">
        <div>
          <strong>${esc(r.title)}</strong>
          <span class="badge risk-score-badge ${cls}">${r.inherent_score}</span>
          ${residualScore !== r.inherent_score ? `<span>&rarr;</span><span class="badge risk-score-badge ${riskScoreClass(residualScore)}">${residualScore} residual</span>` : ''}
        </div>
        <button class="btn btn-primary btn-sm" onclick="openTreatmentModalForRisk(${r.id})">+ Add Treatment</button>
      </div>`;

    if (treatments.length === 0) {
      html += '<div class="empty-state" style="padding:16px;font-size:13px">No treatments planned yet.</div>';
    } else {
      html += '<div class="treatment-items">';
      for (const t of treatments) {
        const stBadge = t.status === 'verified' ? 'badge-low' : t.status === 'implemented' ? 'badge-low' : t.status === 'in_progress' ? 'badge-medium' : 'badge-high';
        html += `<div class="treatment-item">
          <div class="treatment-item-main">
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              <span class="badge badge-inactive">${t.treatment_type}</span>
              <span class="badge ${stBadge}">${t.status}</span>
              ${t.control_reference ? `<span style="font-size:12px;color:var(--primary);font-weight:600">${esc(t.control_reference)}</span>` : ''}
              ${t.requirement_title ? `<span style="font-size:11px;color:var(--text-muted)">Linked: ${esc(t.clause)} - ${esc(t.requirement_title)}</span>` : ''}
            </div>
            <p style="font-size:13px;margin:4px 0">${esc(t.description)}</p>
            <div style="font-size:12px;color:var(--text-muted)">${t.responsible ? 'Responsible: ' + esc(t.responsible) : ''}${t.due_date ? ' | Due: ' + t.due_date : ''}</div>
          </div>
          ${actionMenu([
            ...(t.status === 'planned' ? [{ label: '&#9654; Start', onclick: `updateTreatmentStatus(${t.id},'in_progress')`, cls: 'primary' }] : []),
            ...(t.status === 'in_progress' ? [{ label: '&#10003; Implement', onclick: `updateTreatmentStatus(${t.id},'implemented')`, cls: 'success' }] : []),
            ...(t.status === 'implemented' ? [{ label: '&#10003; Verify', onclick: `updateTreatmentStatus(${t.id},'verified')`, cls: 'success' }] : []),
            { label: '&#9998; Edit', onclick: `openTreatmentModal(${t.id})` },
            'sep',
            { label: '&#128465; Delete', onclick: `deleteTreatment(${t.id})`, cls: 'danger' },
          ])}
        </div>`;
      }
      html += '</div>';
    }
    html += '</div>';
  }
  document.getElementById('treatment-list').innerHTML = html;
}

async function openTreatmentModalForRisk(riskId) {
  document.getElementById('treatment-form').reset();
  document.getElementById('treatment-id').value = '';
  document.getElementById('treatment-risk-id').value = riskId;
  document.getElementById('treatment-modal-title').textContent = 'New Treatment';
  document.getElementById('treatment-status-group').classList.add('hidden');
  await populateTreatmentReqDropdown();
  document.getElementById('treatment-modal').classList.remove('hidden');
}

async function openTreatmentModal(id) {
  const treatments = await api('/api/treatments');
  const t = treatments.find(x => x.id === id);
  if (!t) return;
  document.getElementById('treatment-form').reset();
  document.getElementById('treatment-id').value = t.id;
  document.getElementById('treatment-risk-id').value = t.risk_id;
  document.getElementById('treatment-modal-title').textContent = 'Edit Treatment';
  document.getElementById('treatment-type').value = t.treatment_type;
  document.getElementById('treatment-description').value = t.description;
  document.getElementById('treatment-control-ref').value = t.control_reference || '';
  document.getElementById('treatment-responsible').value = t.responsible || '';
  document.getElementById('treatment-due-date').value = t.due_date || '';
  document.getElementById('treatment-res-likelihood').value = t.residual_likelihood || '';
  document.getElementById('treatment-res-impact').value = t.residual_impact || '';
  document.getElementById('treatment-notes').value = t.notes || '';
  document.getElementById('treatment-status-field').value = t.status;
  document.getElementById('treatment-status-group').classList.remove('hidden');
  await populateTreatmentReqDropdown();
  document.getElementById('treatment-requirement').value = t.requirement_id || '';
  document.getElementById('treatment-modal').classList.remove('hidden');
}

async function populateTreatmentReqDropdown() {
  const reqs = await api('/api/requirements');
  const sel = document.getElementById('treatment-requirement');
  sel.innerHTML = '<option value="">-- None --</option>' + reqs.map(r => `<option value="${r.id}">${esc(r.clause)} - ${esc(r.title)} (${esc(r.standard)})</option>`).join('');
}

function closeTreatmentModal() { document.getElementById('treatment-modal').classList.add('hidden'); }

async function saveTreatment(e) {
  e.preventDefault();
  const id = document.getElementById('treatment-id').value;
  const body = {
    risk_id: parseInt(document.getElementById('treatment-risk-id').value),
    treatment_type: document.getElementById('treatment-type').value,
    description: document.getElementById('treatment-description').value,
    control_reference: document.getElementById('treatment-control-ref').value,
    requirement_id: document.getElementById('treatment-requirement').value || null,
    responsible: document.getElementById('treatment-responsible').value,
    due_date: document.getElementById('treatment-due-date').value || null,
    residual_likelihood: document.getElementById('treatment-res-likelihood').value ? parseInt(document.getElementById('treatment-res-likelihood').value) : null,
    residual_impact: document.getElementById('treatment-res-impact').value ? parseInt(document.getElementById('treatment-res-impact').value) : null,
    notes: document.getElementById('treatment-notes').value,
  };
  if (id) {
    body.status = document.getElementById('treatment-status-field').value;
    await api(`/api/treatments/${id}`, { method: 'PUT', body });
  } else {
    await api('/api/treatments', { method: 'POST', body });
  }
  closeTreatmentModal();
  refreshCurrentView();
}

async function updateTreatmentStatus(id, status) {
  await api(`/api/treatments/${id}`, { method: 'PUT', body: { status } });
  refreshCurrentView();
}

async function deleteTreatment(id) {
  if (!confirm('Delete this treatment?')) return;
  await api(`/api/treatments/${id}`, { method: 'DELETE' });
  refreshCurrentView();
}

// --- Statement of Applicability ---
async function loadSoA() {
  const data = await api('/api/soa');
  const summary = document.getElementById('soa-summary');
  const list = document.getElementById('soa-list');

  if (data.length === 0) {
    summary.innerHTML = '';
    list.innerHTML = '<div class="empty-state">No Annex A controls found. Import the ISO 27001 Annex A template in the Requirements view first.</div>';
    return;
  }

  const applicable = data.filter(d => d.applicable !== 0);
  const notApplicable = data.filter(d => d.applicable === 0);
  const implemented = data.filter(d => d.implementation_status === 'implemented');
  const partial = data.filter(d => d.implementation_status === 'partial');

  summary.innerHTML = `
    <div class="stats-grid" style="margin-bottom:20px">
      <div class="stat-card"><div class="stat-value">${data.length}</div><div class="stat-label">Total Controls</div></div>
      <div class="stat-card done"><div class="stat-value">${applicable.length}</div><div class="stat-label">Applicable</div></div>
      <div class="stat-card"><div class="stat-value">${notApplicable.length}</div><div class="stat-label">Not Applicable</div></div>
      <div class="stat-card done"><div class="stat-value">${implemented.length}</div><div class="stat-label">Implemented</div></div>
      <div class="stat-card today"><div class="stat-value">${partial.length}</div><div class="stat-label">Partial</div></div>
    </div>`;

  // Group by category
  const groups = {};
  for (const d of data) {
    const cat = d.category || 'Uncategorized';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(d);
  }

  let html = '';
  for (const [cat, items] of Object.entries(groups)) {
    html += `<div class="soa-category">
      <div class="soa-category-header">${esc(cat)} <span class="req-cat-count">(${items.length})</span></div>`;
    for (const item of items) {
      const isApplicable = item.applicable !== 0;
      const implStatus = item.implementation_status || 'not_implemented';
      const implBadge = implStatus === 'implemented' ? 'badge-low' : implStatus === 'partial' ? 'badge-medium' : 'badge-high';
      html += `<div class="soa-item${!isApplicable ? ' soa-na' : ''}">
        <div class="soa-item-main">
          <span class="req-clause">${esc(item.clause)}</span>
          <span class="soa-title">${esc(item.title)}</span>
        </div>
        <div class="soa-item-controls">
          <label class="soa-toggle">
            <input type="checkbox" ${isApplicable ? 'checked' : ''} onchange="updateSoA(${item.id}, 'applicable', this.checked)">
            <span class="soa-toggle-label">${isApplicable ? 'Applicable' : 'N/A'}</span>
          </label>
          ${isApplicable ? `<select class="soa-impl-select" onchange="updateSoA(${item.id}, 'implementation_status', this.value)">
            <option value="not_implemented" ${implStatus==='not_implemented'?'selected':''}>Not Implemented</option>
            <option value="partial" ${implStatus==='partial'?'selected':''}>Partial</option>
            <option value="implemented" ${implStatus==='implemented'?'selected':''}>Implemented</option>
          </select>` : ''}
          ${item.linked_treatments.length > 0 ? `<span class="badge badge-low" style="font-size:10px">${item.linked_treatments.length} treatment${item.linked_treatments.length !== 1 ? 's' : ''}</span>` : ''}
        </div>
      </div>`;
    }
    html += '</div>';
  }
  list.innerHTML = html;
}

async function updateSoA(requirementId, field, value) {
  const body = {};
  body[field] = value;
  await api(`/api/soa/${requirementId}`, { method: 'PUT', body });
  loadSoA();
}

// --- Organizational Planning: Mission Control ---
async function loadMissionControl() {
  const mission = await api('/api/mission');
  const missionSection = document.getElementById('mission-section');

  missionSection.innerHTML = `
    <div class="mission-card">
      <div class="mission-card-header">
        <h3>Organization Mission</h3>
        <button class="btn btn-secondary btn-sm" onclick="toggleMissionEdit()">Edit</button>
      </div>
      <div id="mission-display">
        <div class="mission-block">
          <h4>Mission</h4>
          <p>${mission.content ? esc(mission.content) : '<span style="color:var(--text-muted);font-style:italic">No mission statement defined yet.</span>'}</p>
        </div>
        <div class="mission-block">
          <h4>Vision</h4>
          <p>${mission.vision ? esc(mission.vision) : '<span style="color:var(--text-muted);font-style:italic">No vision defined yet.</span>'}</p>
        </div>
        <div class="mission-block">
          <h4>Values</h4>
          <p>${mission.values_text ? esc(mission.values_text) : '<span style="color:var(--text-muted);font-style:italic">No values defined yet.</span>'}</p>
        </div>
      </div>
      <div id="mission-edit" class="hidden">
        <div class="form-group">
          <label>Mission Statement</label>
          <textarea id="mission-content" rows="3" placeholder="What is your organization's mission?">${esc(mission.content || '')}</textarea>
        </div>
        <div class="form-group">
          <label>Vision</label>
          <textarea id="mission-vision" rows="3" placeholder="What is your organization's vision?">${esc(mission.vision || '')}</textarea>
        </div>
        <div class="form-group">
          <label>Values</label>
          <textarea id="mission-values" rows="3" placeholder="What are your organization's core values?">${esc(mission.values_text || '')}</textarea>
        </div>
        <div class="form-actions">
          <button class="btn btn-secondary" onclick="toggleMissionEdit()">Cancel</button>
          <button class="btn btn-primary" onclick="saveMission()">Save</button>
        </div>
      </div>
    </div>`;

  // Auto KPIs
  const autoData = await api('/api/kpis/auto');
  document.getElementById('auto-kpi-grid').innerHTML = `
    <div class="stats-grid" style="margin-bottom:0">
      <div class="stat-card"><div class="stat-value">${autoData.tasks_active}</div><div class="stat-label">Active Tasks</div></div>
      <div class="stat-card${autoData.tasks_overdue > 0 ? ' overdue' : ''}"><div class="stat-value">${autoData.tasks_overdue}</div><div class="stat-label">Overdue Tasks</div></div>
      <div class="stat-card done"><div class="stat-value">${autoData.completions_this_month}</div><div class="stat-label">Completions (Month)</div></div>
      <div class="stat-card${autoData.open_actions > 0 ? ' overdue' : ''}"><div class="stat-value">${autoData.open_actions}</div><div class="stat-label">Open Actions</div></div>
      <div class="stat-card done"><div class="stat-value">${autoData.audits_completed}</div><div class="stat-label">Audits Completed</div></div>
      <div class="stat-card${autoData.open_ncrs > 0 ? ' overdue' : ''}"><div class="stat-value">${autoData.open_ncrs}</div><div class="stat-label">Open NCRs</div></div>
      <div class="stat-card"><div class="stat-value">${autoData.total_risks}</div><div class="stat-label">Total Risks</div></div>
      <div class="stat-card${autoData.high_risks > 0 ? ' overdue' : ''}"><div class="stat-value">${autoData.high_risks}</div><div class="stat-label">High Risks</div></div>
      <div class="stat-card"><div class="stat-value">${autoData.open_treatments}</div><div class="stat-label">Open Treatments</div></div>
    </div>`;

  // Custom KPIs
  const kpis = await api('/api/kpis');
  const customList = document.getElementById('custom-kpi-list');
  if (kpis.length === 0) {
    customList.innerHTML = '<div class="empty-state" style="padding:20px">No custom KPIs yet. Create one to track organizational metrics.</div>';
    return;
  }
  customList.innerHTML = kpis.map(k => {
    const vals = k.values || [];
    const latest = vals.length > 0 ? vals[0].value : null;
    const prev = vals.length > 1 ? vals[1].value : null;
    const trend = (latest !== null && prev !== null) ? latest - prev : null;
    const trendHtml = trend !== null ? `<span class="kpi-trend ${trend > 0 ? 'up' : trend < 0 ? 'down' : 'flat'}">${trend > 0 ? '+' : ''}${Number(trend.toFixed(2))}${k.unit}</span>` : '';
    const targetHtml = k.target_value !== null ? `<div style="font-size:12px;color:var(--text-muted)">Target: ${k.target_value}${k.unit}</div>` : '';
    // Mini sparkline using bars
    const sparkVals = vals.slice(0, 6).reverse();
    const max = sparkVals.length > 0 ? Math.max(...sparkVals.map(v => v.value), 1) : 1;
    const sparkHtml = sparkVals.length > 0 ? `<div class="kpi-spark">${sparkVals.map(v => {
      const h = Math.max(4, (v.value / max) * 28);
      return `<div class="kpi-spark-bar" style="height:${h}px" title="${v.period}: ${v.value}${k.unit}"></div>`;
    }).join('')}</div>` : '';
    return `<div class="kpi-card-custom">
      <div class="kpi-card-custom-header">
        <div>
          <div class="kpi-header">${esc(k.name)}</div>
          ${k.description ? `<div style="font-size:12px;color:var(--text-muted)">${esc(k.description)}</div>` : ''}
        </div>
        ${actionMenu([
          { label: '&#128200; Record Value', onclick: `openKpiValueModal(${k.id})`, cls: 'primary' },
          { label: '&#9998; Edit', onclick: `openKpiModal(${k.id})` },
          'sep',
          { label: '&#128465; Delete', onclick: `deleteKpi(${k.id})`, cls: 'danger' },
        ])}
      </div>
      <div style="display:flex;align-items:end;gap:16px">
        <div>
          <div class="kpi-value">${latest !== null ? latest + (k.unit || '') : 'N/A'}</div>
          ${targetHtml}
          <div style="display:flex;gap:6px;align-items:center">${trendHtml}</div>
        </div>
        ${sparkHtml}
      </div>
    </div>`;
  }).join('');
}

function toggleMissionEdit() {
  document.getElementById('mission-display').classList.toggle('hidden');
  document.getElementById('mission-edit').classList.toggle('hidden');
}

async function saveMission() {
  await api('/api/mission', { method: 'PUT', body: {
    content: document.getElementById('mission-content').value,
    vision: document.getElementById('mission-vision').value,
    values_text: document.getElementById('mission-values').value,
  }});
  loadMissionControl();
}

async function openKpiModal(id) {
  document.getElementById('kpi-form').reset();
  document.getElementById('kpi-id').value = '';
  document.getElementById('kpi-modal-title').textContent = 'New KPI';
  if (id) {
    const kpis = await api('/api/kpis');
    const k = kpis.find(x => x.id === id);
    if (k) {
      document.getElementById('kpi-modal-title').textContent = 'Edit KPI';
      document.getElementById('kpi-id').value = k.id;
      document.getElementById('kpi-name').value = k.name;
      document.getElementById('kpi-description').value = k.description;
      document.getElementById('kpi-target').value = k.target_value || '';
      document.getElementById('kpi-unit').value = k.unit;
      document.getElementById('kpi-frequency').value = k.frequency;
    }
  }
  document.getElementById('kpi-modal').classList.remove('hidden');
}
function closeKpiModal() { document.getElementById('kpi-modal').classList.add('hidden'); }

async function saveKpi(e) {
  e.preventDefault();
  const id = document.getElementById('kpi-id').value;
  const body = {
    name: document.getElementById('kpi-name').value,
    description: document.getElementById('kpi-description').value,
    target_value: document.getElementById('kpi-target').value ? parseFloat(document.getElementById('kpi-target').value) : null,
    unit: document.getElementById('kpi-unit').value,
    frequency: document.getElementById('kpi-frequency').value,
  };
  if (id) await api(`/api/kpis/${id}`, { method: 'PUT', body });
  else await api('/api/kpis', { method: 'POST', body });
  closeKpiModal();
  loadMissionControl();
}

async function deleteKpi(id) {
  if (!confirm('Delete this KPI and all its values?')) return;
  await api(`/api/kpis/${id}`, { method: 'DELETE' });
  loadMissionControl();
}

function openKpiValueModal(kpiId) {
  document.getElementById('kpi-value-form').reset();
  document.getElementById('kpi-value-kpi-id').value = kpiId;
  document.getElementById('kpi-value-period').value = new Date().toISOString().slice(0, 7);
  document.getElementById('kpi-value-modal').classList.remove('hidden');
}
function closeKpiValueModal() { document.getElementById('kpi-value-modal').classList.add('hidden'); }

async function saveKpiValue(e) {
  e.preventDefault();
  const kpiId = document.getElementById('kpi-value-kpi-id').value;
  await api(`/api/kpis/${kpiId}/values`, { method: 'POST', body: {
    value: parseFloat(document.getElementById('kpi-value-val').value),
    period: document.getElementById('kpi-value-period').value,
  }});
  closeKpiValueModal();
  loadMissionControl();
}

// --- Organizational Planning: Architecture ---
let currentArchTab = 'role';
const archTypeLabels = { role: 'Roles & Responsibilities', process: 'Processes', system: 'Systems / Data', asset: 'Assets', facility: 'Facilities' };

function switchArchTab(type) {
  currentArchTab = type;
  document.querySelectorAll('.arch-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.arch-tab[onclick="switchArchTab('${type}')"]`).classList.add('active');
  loadArchitecture();
}

async function loadArchitecture() {
  const items = await api(`/api/architecture?arch_type=${currentArchTab}`);
  const list = document.getElementById('arch-list');
  if (items.length === 0) {
    list.innerHTML = `<div class="empty-state">No ${archTypeLabels[currentArchTab].toLowerCase()} defined yet.</div>`;
    return;
  }
  list.innerHTML = `<div class="arch-items">${items.map(item => {
    const stBadge = item.status === 'active' ? 'badge-low' : item.status === 'planned' ? 'badge-medium' : 'badge-inactive';
    return `<div class="arch-item">
      <div class="arch-item-main">
        <h4>${esc(item.name)}</h4>
        ${item.description ? `<p style="font-size:13px;color:var(--text-muted);margin:4px 0">${esc(item.description)}</p>` : ''}
        <div style="display:flex;gap:8px;align-items:center;font-size:12px;color:var(--text-muted)">
          ${item.owner ? `<span>Owner: ${esc(item.owner)}</span>` : ''}
          <span class="badge ${stBadge}">${item.status}</span>
        </div>
      </div>
      ${actionMenu([
        { label: '&#9998; Edit', onclick: `openArchModal(${item.id})` },
        'sep',
        { label: '&#128465; Delete', onclick: `deleteArch(${item.id})`, cls: 'danger' },
      ])}
      <div id="arch-links-${item.id}"></div>
    </div>`;
  }).join('')}</div>`;
  for (const item of items) renderCrossLinks(currentArchTab, item.id, `arch-links-${item.id}`);
}

async function openArchModal(id) {
  document.getElementById('arch-form').reset();
  document.getElementById('arch-id').value = '';
  document.getElementById('arch-modal-title').textContent = 'New Item';
  document.getElementById('arch-type').value = currentArchTab;

  if (id) {
    const items = await api(`/api/architecture?arch_type=${currentArchTab}`);
    const item = items.find(x => x.id === id);
    if (item) {
      document.getElementById('arch-modal-title').textContent = 'Edit Item';
      document.getElementById('arch-id').value = item.id;
      document.getElementById('arch-type').value = item.arch_type;
      document.getElementById('arch-name').value = item.name;
      document.getElementById('arch-description').value = item.description;
      document.getElementById('arch-owner').value = item.owner;
      document.getElementById('arch-status').value = item.status;
    }
  }
  document.getElementById('arch-modal').classList.remove('hidden');
}
function closeArchModal() { document.getElementById('arch-modal').classList.add('hidden'); }

async function saveArch(e) {
  e.preventDefault();
  const id = document.getElementById('arch-id').value;
  const body = {
    arch_type: document.getElementById('arch-type').value,
    name: document.getElementById('arch-name').value,
    description: document.getElementById('arch-description').value,
    owner: document.getElementById('arch-owner').value,
    status: document.getElementById('arch-status').value,
  };
  if (id) await api(`/api/architecture/${id}`, { method: 'PUT', body });
  else await api('/api/architecture', { method: 'POST', body });
  closeArchModal();
  currentArchTab = body.arch_type;
  loadArchitecture();
}

async function deleteArch(id) {
  if (!confirm('Delete this item?')) return;
  await api(`/api/architecture/${id}`, { method: 'DELETE' });
  loadArchitecture();
}

// --- Document Control ---
let docFilters = { doc_type: '', status: '' };

async function loadDocumentControl() {
  const params = new URLSearchParams();
  if (docFilters.doc_type) params.set('doc_type', docFilters.doc_type);
  if (docFilters.status) params.set('status', docFilters.status);
  const docs = await api(`/api/documents?${params}`);

  document.getElementById('doc-filters-bar').innerHTML = `
    <select onchange="docFilters.doc_type=this.value;loadDocumentControl()">
      <option value="">All Types</option>
      <option value="policy" ${docFilters.doc_type==='policy'?'selected':''}>Policy</option>
      <option value="procedure" ${docFilters.doc_type==='procedure'?'selected':''}>Procedure</option>
      <option value="work_instruction" ${docFilters.doc_type==='work_instruction'?'selected':''}>Work Instruction</option>
      <option value="record" ${docFilters.doc_type==='record'?'selected':''}>Record</option>
      <option value="form" ${docFilters.doc_type==='form'?'selected':''}>Form / Template</option>
      <option value="report" ${docFilters.doc_type==='report'?'selected':''}>Report</option>
      <option value="other" ${docFilters.doc_type==='other'?'selected':''}>Other</option>
    </select>
    <select onchange="docFilters.status=this.value;loadDocumentControl()">
      <option value="">All Status</option>
      <option value="draft" ${docFilters.status==='draft'?'selected':''}>Draft</option>
      <option value="review" ${docFilters.status==='review'?'selected':''}>Under Review</option>
      <option value="approved" ${docFilters.status==='approved'?'selected':''}>Approved</option>
      <option value="obsolete" ${docFilters.status==='obsolete'?'selected':''}>Obsolete</option>
    </select>
    <span style="font-size:13px;color:var(--text-muted)">${docs.length} document${docs.length!==1?'s':''}</span>`;

  const list = document.getElementById('doc-list');
  if (docs.length === 0) {
    list.innerHTML = '<div class="empty-state">No documents yet. Upload one to get started.</div>';
    return;
  }

  const docTypeLabels = { policy: 'Policy', procedure: 'Procedure', work_instruction: 'Work Instruction', record: 'Record', form: 'Form', report: 'Report', other: 'Other' };
  const statusBadge = s => s === 'approved' ? 'badge-low' : s === 'review' ? 'badge-medium' : s === 'obsolete' ? 'badge-inactive' : 'badge-high';
  const moduleLabels = { 'org-planning': 'Org Planning', 'risk-management': 'Risk Mgmt', 'operational-planning': 'Operational', 'audits': 'Audits' };
  const fileIcon = mime => {
    if (mime.includes('pdf')) return '&#128196;';
    if (mime.includes('word') || mime.includes('document')) return '&#128195;';
    if (mime.includes('sheet') || mime.includes('excel')) return '&#128202;';
    if (mime.includes('presentation') || mime.includes('powerpoint')) return '&#128203;';
    if (mime.includes('image')) return '&#128247;';
    return '&#128193;';
  };

  list.innerHTML = `<div class="doc-grid">${docs.map(d => {
    const size = d.file_size > 0 ? (d.file_size > 1048576 ? (d.file_size / 1048576).toFixed(1) + ' MB' : (d.file_size / 1024).toFixed(0) + ' KB') : '';
    const reviewWarning = d.review_date && d.review_date < new Date().toISOString().split('T')[0];
    return `<div class="doc-card${d.status === 'obsolete' ? ' doc-obsolete' : ''}">
      <div class="doc-card-header">
        <div class="doc-icon">${d.file_name ? fileIcon(d.mime_type) : '&#128196;'}</div>
        <div class="doc-card-info">
          <h4>${esc(d.title)}</h4>
          <div class="doc-meta">
            <span class="badge ${statusBadge(d.status)}">${d.status}</span>
            <span class="badge badge-inactive">${docTypeLabels[d.doc_type] || d.doc_type}</span>
            <span>v${esc(d.version)}</span>
            ${d.owner ? `<span>Owner: ${esc(d.owner)}</span>` : ''}
          </div>
        </div>
        ${actionMenu([
          ...(d.file_name ? [{ label: '&#128229; Download', onclick: `downloadDoc(${d.id})`, cls: 'primary' }] : []),
          { label: '&#9998; Edit', onclick: `openDocModal(${d.id})` },
          'sep',
          { label: '&#128465; Delete', onclick: `deleteDoc(${d.id})`, cls: 'danger' },
        ])}
      </div>
      ${d.description ? `<p class="doc-desc">${esc(d.description)}</p>` : ''}
      <div class="doc-card-footer">
        ${d.linked_module ? `<span class="badge badge-low">${moduleLabels[d.linked_module] || d.linked_module}</span>` : ''}
        ${d.file_name ? `<span class="doc-file-info">${esc(d.file_name)} (${size})</span>` : '<span class="doc-file-info" style="color:var(--text-muted)">No file attached</span>'}
        ${d.review_date ? `<span class="doc-review${reviewWarning ? ' overdue' : ''}">Review: ${d.review_date}</span>` : ''}
        <span class="doc-date">Updated: ${d.updated_at.split(' ')[0]}</span>
      </div>
      <div id="doc-links-${d.id}"></div>
    </div>`;
  }).join('')}</div>`;
  for (const d of docs) renderCrossLinks('document', d.id, `doc-links-${d.id}`);
}

function openDocModal(id) {
  document.getElementById('doc-form').reset();
  document.getElementById('doc-id').value = '';
  document.getElementById('doc-modal-title').textContent = 'Upload Document';
  document.getElementById('doc-linked-ref').innerHTML = '<option value="">-- None --</option>';

  if (id) {
    api('/api/documents').then(docs => {
      const d = docs.find(x => x.id === id);
      if (!d) return;
      document.getElementById('doc-modal-title').textContent = 'Edit Document';
      document.getElementById('doc-id').value = d.id;
      document.getElementById('doc-title').value = d.title;
      document.getElementById('doc-type').value = d.doc_type;
      document.getElementById('doc-version').value = d.version;
      document.getElementById('doc-owner').value = d.owner;
      document.getElementById('doc-status').value = d.status;
      document.getElementById('doc-description').value = d.description;
      document.getElementById('doc-linked-module').value = d.linked_module;
      document.getElementById('doc-review-date').value = d.review_date || '';
      if (d.linked_module) {
        populateDocRefs(d.linked_module).then(() => {
          if (d.linked_ref_id) document.getElementById('doc-linked-ref').value = `${d.linked_ref_type}:${d.linked_ref_id}`;
        });
      }
      document.getElementById('doc-modal').classList.remove('hidden');
    });
    return;
  }
  document.getElementById('doc-modal').classList.remove('hidden');
}

function closeDocModal() { document.getElementById('doc-modal').classList.add('hidden'); }

// Populate linked references based on selected module
document.addEventListener('change', function(e) {
  if (e.target && e.target.id === 'doc-linked-module') {
    const mod = e.target.value;
    if (mod) populateDocRefs(mod);
    else document.getElementById('doc-linked-ref').innerHTML = '<option value="">-- None --</option>';
  }
});

async function populateDocRefs(module) {
  const refs = await api(`/api/link-references?module=${module}`);
  const sel = document.getElementById('doc-linked-ref');
  sel.innerHTML = '<option value="">-- None --</option>' + refs.map(r =>
    `<option value="${r.type}:${r.id}">${esc(r.label)}</option>`
  ).join('');
}

async function saveDocument(e) {
  e.preventDefault();
  const id = document.getElementById('doc-id').value;
  const formData = new FormData();
  formData.append('title', document.getElementById('doc-title').value);
  formData.append('doc_type', document.getElementById('doc-type').value);
  formData.append('version', document.getElementById('doc-version').value);
  formData.append('owner', document.getElementById('doc-owner').value);
  formData.append('status', document.getElementById('doc-status').value);
  formData.append('description', document.getElementById('doc-description').value);
  formData.append('linked_module', document.getElementById('doc-linked-module').value);
  formData.append('review_date', document.getElementById('doc-review-date').value);

  const refVal = document.getElementById('doc-linked-ref').value;
  if (refVal) {
    const [refType, refId] = refVal.split(':');
    formData.append('linked_ref_type', refType);
    formData.append('linked_ref_id', refId);
  }

  const fileInput = document.getElementById('doc-file');
  if (fileInput.files.length > 0) {
    formData.append('file', fileInput.files[0]);
  }

  const url = id ? `/api/documents/${id}` : '/api/documents';
  const method = id ? 'PUT' : 'POST';
  await fetch(url, { method, body: formData });
  closeDocModal();
  loadDocumentControl();
}

async function deleteDoc(id) {
  if (!confirm('Delete this document and its file?')) return;
  await api(`/api/documents/${id}`, { method: 'DELETE' });
  loadDocumentControl();
}

function downloadDoc(id) {
  window.open(`/api/documents/${id}/download`, '_blank');
}

// --- Helpers ---
function refreshCurrentView() {
  switchView(currentView);
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// --- Init ---
loadMissionControl();
