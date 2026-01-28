// --- State ---
let currentView = 'dashboard';
let allTasks = [];
let meta = { assignees: [], categories: [] };
let filters = { active: 'true', assignee: '', category: '', priority: '' };
let actionFilters = { status: 'open' };
let yearlyYear = new Date().getFullYear();
let lastCompletionContext = null; // { completion_id, task_id }

// --- Navigation ---
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const view = link.dataset.view;
    switchView(view);
  });
});

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(`view-${view}`).classList.remove('hidden');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.querySelector(`[data-view="${view}"]`).classList.add('active');

  if (view === 'dashboard') loadDashboard();
  else if (view === 'tasks') loadTasks();
  else if (view === 'yearly') loadYearlyPlan();
  else if (view === 'actions') loadActions();
  else if (view === 'history') loadHistory();
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

// --- Dashboard ---
async function loadDashboard() {
  const stats = await api('/api/dashboard');
  const grid = document.getElementById('stats-grid');
  grid.innerHTML = `
    <div class="stat-card"><div class="stat-value">${stats.totalActive}</div><div class="stat-label">Active Tasks</div></div>
    <div class="stat-card today"><div class="stat-value">${stats.dueToday}</div><div class="stat-label">Due Today</div></div>
    <div class="stat-card overdue"><div class="stat-value">${stats.overdue}</div><div class="stat-label">Overdue</div></div>
    <div class="stat-card done"><div class="stat-value">${stats.completedThisWeek}</div><div class="stat-label">Done This Week</div></div>
    <div class="stat-card done"><div class="stat-value">${stats.completedThisMonth}</div><div class="stat-label">Done This Month</div></div>
    <div class="stat-card${stats.openActions > 0 ? ' overdue' : ''}"><div class="stat-value">${stats.openActions}</div><div class="stat-label">Open Actions</div></div>
  `;

  const overdueList = document.getElementById('overdue-list');
  if (stats.overdueTasks.length === 0) {
    overdueList.innerHTML = '<div class="empty-state">No overdue tasks</div>';
  } else {
    overdueList.innerHTML = stats.overdueTasks.map(t => taskCard(t, true)).join('');
  }

  const upcomingList = document.getElementById('upcoming-list');
  if (stats.upcomingTasks.length === 0) {
    upcomingList.innerHTML = '<div class="empty-state">No upcoming tasks</div>';
  } else {
    upcomingList.innerHTML = stats.upcomingTasks.map(t => taskCard(t, false)).join('');
  }
}

function taskCard(task, isOverdue) {
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
  const modal = document.getElementById('task-modal');
  const form = document.getElementById('task-form');
  form.reset();
  document.getElementById('task-id').value = '';
  document.getElementById('task-start').value = new Date().toISOString().split('T')[0];
  document.getElementById('modal-title').textContent = 'New Task';

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
  refreshCurrentView();
}

// --- Complete Modal ---
function openCompleteModal(taskId) {
  document.getElementById('complete-task-id').value = taskId;
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
  // Show post-completion action prompt
  lastCompletionContext = { completion_id: result.completion_id, task_id: parseInt(taskId) };
  openPostCompleteModal();
}

// --- Delete ---
async function deleteTask(id) {
  if (!confirm('Delete this task and all its history?')) return;
  await api(`/api/tasks/${id}`, { method: 'DELETE' });
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

  // Add to the list
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
  loadActions();
}

async function resolveAction(id) {
  const resolvedBy = prompt('Resolved by (your name):');
  if (resolvedBy === null) return;
  await api(`/api/actions/${id}`, { method: 'PUT', body: { status: 'resolved', resolved_by: resolvedBy } });
  loadActions();
}

async function deleteAction(id) {
  if (!confirm('Delete this action?')) return;
  await api(`/api/actions/${id}`, { method: 'DELETE' });
  loadActions();
}

// --- Action Modal (edit) ---
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

  document.getElementById('action-status').addEventListener('change', function() {
    document.getElementById('action-resolved-by-group').classList.toggle('hidden',
      this.value !== 'resolved' && this.value !== 'closed');
  });

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
  loadYearlyPlan();
}

async function loadYearlyPlan() {
  document.getElementById('yearly-title').textContent = `Yearly Plan ${yearlyYear}`;
  const data = await api(`/api/yearly?year=${yearlyYear}`);
  const grid = document.getElementById('yearly-grid');
  const today = new Date().toISOString().split('T')[0];

  let html = '';
  for (let m = 0; m < 12; m++) {
    const firstDay = new Date(yearlyYear, m, 1);
    const daysInMonth = new Date(yearlyYear, m + 1, 0).getDate();
    // Monday=0 start
    let startDay = firstDay.getDay() - 1;
    if (startDay < 0) startDay = 6;

    // Count tasks this month
    let monthDueCount = 0;
    let monthCompletedCount = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${yearlyYear}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      if (data.dueDates[ds]) monthDueCount += data.dueDates[ds].length;
      if (data.completedDates[ds]) monthCompletedCount += data.completedDates[ds].length;
    }

    html += `<div class="month-card">
      <div class="month-header">
        ${MONTH_NAMES[m]}
        <span class="month-count">${monthCompletedCount}/${monthDueCount} done</span>
      </div>
      <div class="month-body">
        <div class="cal-week-header">${DAY_LABELS.map(d => `<span>${d}</span>`).join('')}</div>
        <div class="cal-grid">`;

    // Empty cells before first day
    for (let i = 0; i < startDay; i++) {
      html += '<div class="cal-day empty"></div>';
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${yearlyYear}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const due = data.dueDates[ds] || [];
      const completed = data.completedDates[ds] || [];
      const hasDue = due.length > 0;
      const hasCompleted = completed.length > 0;
      const isOverdue = hasDue && ds < today;
      const isToday = ds === today;

      let cls = 'cal-day';
      if (isToday) cls += ' today';
      if (hasCompleted && hasDue) cls += ' has-mixed';
      else if (isOverdue) cls += ' has-overdue';
      else if (hasDue) cls += ' has-due';
      else if (hasCompleted) cls += ' has-completed';

      const clickable = hasDue || hasCompleted;
      html += `<div class="${cls}"${clickable ? ` onclick="showDayDetail(event,'${ds}')"` : ''}>${d}`;
      if (hasDue || hasCompleted) {
        html += '<div class="cal-day-dot">';
        if (hasCompleted) html += '<span class="dot-completed"></span>';
        if (hasDue && !isOverdue) html += '<span class="dot-due"></span>';
        if (isOverdue) html += '<span class="dot-overdue"></span>';
        html += '</div>';
      }
      html += '</div>';
    }

    html += '</div></div></div>';
  }

  grid.innerHTML = html;
}

let activePopover = null;
function showDayDetail(event, dateStr) {
  closeDayDetail();
  const data = window._yearlyData;
  if (!data) { loadYearlyPlanAndShow(event, dateStr); return; }
  renderDayPopover(event, dateStr, data);
}

async function loadYearlyPlanAndShow(event, dateStr) {
  const data = await api(`/api/yearly?year=${yearlyYear}`);
  window._yearlyData = data;
  renderDayPopover(event, dateStr, data);
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
      <strong>${esc(t.title)}</strong> <span class="badge badge-${t.priority.toLowerCase()}">${t.priority}</span>
      <div class="dpi-meta">${label} &middot; ${esc(t.recurrence)} &middot; ${esc(t.assignee || 'Unassigned')}</div>
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

// Cache yearly data when loading
const _origLoadYearly = loadYearlyPlan;
loadYearlyPlan = async function() {
  await _origLoadYearly();
  const data = await api(`/api/yearly?year=${yearlyYear}`);
  window._yearlyData = data;
};

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
