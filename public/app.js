// --- State ---
let currentView = 'dashboard';
let allTasks = [];
let meta = { assignees: [], categories: [] };
let filters = { active: 'true', assignee: '', category: '', priority: '' };
let actionFilters = { status: 'open' };
let yearlyYear = new Date().getFullYear();
let lastCompletionContext = null; // { completion_id, task_id }
let yearlyData = null; // cached yearly API data

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
          <div class="task-card-actions">
            <button class="btn btn-primary btn-sm" onclick="updateActionStatusAndRefresh(${a.id},'in_progress')">Start</button>
            <button class="btn btn-secondary btn-sm" onclick="openActionModal(${a.id})">Edit</button>
          </div>
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
      <div class="task-card-actions">
        <button class="btn btn-success btn-sm" onclick="openCompleteModal(${task.id})">Done</button>
        <button class="btn btn-secondary btn-sm" onclick="openTaskModal(${task.id})">Edit</button>
      </div>
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
      <td><strong>${esc(t.title)}</strong>${t.description ? '<br><small style="color:var(--text-muted)">' + esc(t.description) + '</small>' : ''}</td>
      <td>${esc(t.assignee || '-')}</td>
      <td>${esc(t.category)}</td>
      <td><span class="badge badge-${t.priority.toLowerCase()}">${t.priority}</span></td>
      <td>${t.recurrence}${t.recurrence === 'custom' ? ' (' + t.custom_days + 'd)' : ''}</td>
      <td>${t.next_due}</td>
      <td><span class="badge badge-${status}">${statusLabel}</span></td>
      <td>
        <button class="btn btn-success btn-sm" onclick="openCompleteModal(${t.id})">Done</button>
        <button class="btn btn-secondary btn-sm" onclick="openTaskModal(${t.id})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteTask(${t.id})">Del</button>
      </td>
    </tr>`;
  }).join('');
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
        <button class="btn btn-secondary btn-sm" onclick="viewCompletionActions(${c.id}, ${c.task_id})">Actions</button>
        <div class="hi-date">${new Date(c.completed_at).toLocaleString()}</div>
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
      <td>
        ${a.status === 'open' ? `<button class="btn btn-primary btn-sm" onclick="updateActionStatus(${a.id},'in_progress')">Start</button>` : ''}
        ${a.status === 'in_progress' ? `<button class="btn btn-success btn-sm" onclick="resolveAction(${a.id})">Resolve</button>` : ''}
        <button class="btn btn-secondary btn-sm" onclick="openActionModal(${a.id})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteAction(${a.id})">Del</button>
      </td>
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

  // Render calendar grid
  let calHtml = '';
  for (let m = 0; m < 12; m++) {
    const firstDay = new Date(yearlyYear, m, 1);
    const daysInMonth = new Date(yearlyYear, m + 1, 0).getDate();
    let startDay = firstDay.getDay() - 1;
    if (startDay < 0) startDay = 6;

    const ms = monthStats[m];
    calHtml += `<div class="month-card">
      <div class="month-header">
        ${MONTH_NAMES[m]}
        <span class="month-count">${ms.completed}/${ms.due} done</span>
      </div>
      <div class="month-body">
        <div class="cal-week-header">${DAY_LABELS.map(d => `<span>${d}</span>`).join('')}</div>
        <div class="cal-grid">`;

    for (let i = 0; i < startDay; i++) {
      calHtml += '<div class="cal-day empty"></div>';
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${yearlyYear}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const dueTasks = data.dueDates[ds] || [];
      const completedTasks = data.completedDates[ds] || [];
      const hasDue = dueTasks.length > 0;
      const hasCompleted = completedTasks.length > 0;
      const isOverdue = hasDue && ds < today;
      const isToday = ds === today;

      let cls = 'cal-day';
      if (isToday) cls += ' today';
      if (hasCompleted && hasDue) cls += ' has-mixed';
      else if (isOverdue) cls += ' has-overdue';
      else if (hasDue) cls += ' has-due';
      else if (hasCompleted) cls += ' has-completed';

      const clickable = hasDue || hasCompleted;
      calHtml += `<div class="${cls}"${clickable ? ` onclick="showDayDetail(event,'${ds}')"` : ''}>${d}`;
      if (hasDue || hasCompleted) {
        calHtml += '<div class="cal-day-dot">';
        if (hasCompleted) calHtml += '<span class="dot-completed"></span>';
        if (hasDue && !isOverdue) calHtml += '<span class="dot-due"></span>';
        if (isOverdue) calHtml += '<span class="dot-overdue"></span>';
        calHtml += '</div>';
      }
      calHtml += '</div>';
    }

    calHtml += '</div></div></div>';
  }
  grid.innerHTML = calHtml;

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
        <div style="display:flex;gap:4px;margin-left:8px;flex-shrink:0">
          <button class="btn btn-success btn-sm" onclick="closeDayDetail();openCompleteModal(${t.task_id})">Done</button>
          <button class="btn btn-secondary btn-sm" onclick="closeDayDetail();openTaskModal(${t.task_id})">Edit</button>
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
        <div style="display:flex;gap:6px">
          ${a.status === 'planned' ? `<button class="btn btn-primary btn-sm" onclick="startAudit(${a.id})">Start</button>` : ''}
          ${a.status === 'in_progress' ? `<button class="btn btn-success btn-sm" onclick="switchToExecute(${a.id})">Execute</button>` : ''}
          <button class="btn btn-secondary btn-sm" onclick="openAuditModal(${a.id})">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteAudit(${a.id})">Del</button>
        </div>
      </div>
    </div>`;
  }).join('');
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
        ${alreadyAdded ? '<span class="badge badge-low" style="font-size:10px;margin-left:auto">already added</span>' : ''}
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
          <button class="btn btn-secondary btn-sm" onclick="openNcrModal(${linkedNcr.id})">Edit NCR</button>
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
          <button class="btn btn-secondary btn-sm" onclick="deleteChecklistItem(${item.id}, ${auditId})">Remove</button>
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
          <button class="btn btn-secondary btn-sm" onclick="openNcrModal(${n.id})">Edit</button>
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
      <td><strong>${esc(n.description.substring(0, 80))}${n.description.length > 80 ? '...' : ''}</strong></td>
      <td>${esc(n.audit_title)}</td>
      <td>${esc(n.clause || '-')}</td>
      <td><span class="badge ${sevBadge}">${n.severity}</span></td>
      <td>${esc(n.responsible || '-')}</td>
      <td>${n.due_date ? (isOverdue ? '<span style="color:var(--danger);font-weight:600">' + n.due_date + '</span>' : n.due_date) : '-'}</td>
      <td><span class="badge ${stBadge}">${n.status}</span></td>
      <td>
        ${n.status === 'open' ? `<button class="btn btn-primary btn-sm" onclick="updateNcrStatus(${n.id},'in_progress')">Start</button>` : ''}
        ${n.status === 'in_progress' ? `<button class="btn btn-success btn-sm" onclick="updateNcrStatus(${n.id},'closed')">Close</button>` : ''}
        ${n.status === 'closed' ? `<button class="btn btn-success btn-sm" onclick="updateNcrStatus(${n.id},'verified')">Verify</button>` : ''}
        <button class="btn btn-secondary btn-sm" onclick="openNcrModal(${n.id})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteNcr(${n.id})">Del</button>
      </td>
    </tr>`;
  }).join('');
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
          <button class="btn btn-secondary btn-sm" onclick="openRequirementModal(${r.id})">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteRequirement(${r.id})">Del</button>
        </div>
      </div>`;
    }
    html += '</div>';
  }
  list.innerHTML = html;
}

async function openRequirementModal(id) {
  const modal = document.getElementById('requirement-modal');
  document.getElementById('requirement-form').reset();
  document.getElementById('req-id').value = '';
  document.getElementById('req-modal-title').textContent = 'New Requirement';

  // Populate standard datalist from existing
  const standards = await api('/api/requirements/standards');
  document.getElementById('req-standard-list').innerHTML = standards.map(s => `<option value="${esc(s)}">`).join('');
  // Populate category datalist
  const reqs = await api('/api/requirements');
  const cats = [...new Set(reqs.map(r => r.category).filter(Boolean))];
  document.getElementById('req-category-list').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');

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
loadDashboard();
