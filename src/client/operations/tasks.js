
// --- Tasks View ---
let seriesLoadRequest = 0;
async function loadTasks() {
  const request = ++seriesLoadRequest;
  document.getElementById('task-table-body').innerHTML = '<div class="empty-state" role="status">Loading series…</div>';
  document.getElementById('yearly-series-count').textContent = '';
  try {
    const tasks = await api('/api/tasks');
    if (request !== seriesLoadRequest) return;
    allTasks = tasks;
    renderTaskTable();
  } catch (err) {
    if (request !== seriesLoadRequest) return;
    allTasks = [];
    document.getElementById('task-table-body').innerHTML =
      `<div class="empty-state" style="color:var(--danger)">Failed to load series: ${esc(err.message)} <button class="btn btn-secondary btn-sm" onclick="loadTasks()">Retry</button></div>`;
  }
}

function renderTaskTable() {
  const container = document.getElementById('task-table-body');
  const today = new Date().toISOString().split('T')[0];
  const tasks = allTasks.filter(t => matchesPlanningFilters(t) &&
    (filters.active === '' || Boolean(t.is_active) === (filters.active === 'true')));
  document.getElementById('yearly-series-count').textContent = `${tasks.length} of ${allTasks.length} series · all years`;
  if (tasks.length === 0) {
    container.innerHTML = allTasks.length === 0
      ? `<div class="empty-state">No recurring task series yet.<br>Series define the recurring checks and controls your team executes.<br><br>
          <button class="btn btn-primary" onclick="openTaskModal()">+ Create your first series</button></div>`
      : '<div class="empty-state">No series match these filters. <button class="btn btn-secondary btn-sm" onclick="resetPlanningFilters()">Reset filters</button></div>';
    return;
  }
  const recurrenceLabel = r => ({ daily:'Daily', weekly:'Weekly', biweekly:'Biweekly', monthly:'Monthly', quarterly:'Quarterly', yearly:'Yearly', custom:'Custom' }[r] || r);
  let html = `<div class="task-list-table">
    <div class="task-list-head">
      <div>Title</div>
      <div>Assignee · Category</div>
      <div>Priority</div>
      <div>Status</div>
      <div>Due Date</div>
      <div>Recurrence</div>
      <div></div>
    </div>`;
  html += tasks.map(t => {
    const status = !t.is_active ? 'inactive' : t.next_due < today ? 'overdue' : t.next_due === today ? 'due-today' : 'upcoming';
    const statusLabel = { inactive:'Inactive', overdue:'Overdue', 'due-today':'Due Today', upcoming:'Upcoming' }[status];
    const statusBadge = { inactive:'badge-inactive', overdue:'badge-overdue', 'due-today':'badge-due-today', upcoming:'badge-upcoming' }[status];
    const recLabel = t.recurrence === 'custom' ? `Every ${t.custom_days}d` : t.day_of_week != null && t.recurrence === 'weekly' ? `${recurrenceLabel(t.recurrence)} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][t.day_of_week]})` : t.day_of_month != null && t.recurrence === 'monthly' ? `Monthly (${t.day_of_month}th)` : recurrenceLabel(t.recurrence);
    const assigneeParts = [t.assignee ? esc(t.assignee) : null, t.category && t.category !== 'General' ? esc(t.category) : null].filter(Boolean);
    return `<div class="task-list-row-wrap status-${status}${!t.is_active ? ' task-inactive' : ''}">
      <div class="task-list-row">
        <div class="task-list-col-title">
          <span class="task-list-title" onclick="openTaskDetailModal(${t.id})">${esc(t.title)}</span>
          ${t.description ? `<span class="task-list-desc">${esc(t.description)}</span>` : ''}
        </div>
        <div class="task-list-col">${assigneeParts.length ? `<span style="font-size:12px;color:var(--text-muted)">${assigneeParts.join(' · ')}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}</div>
        <div class="task-list-col"><span class="badge badge-${t.priority.toLowerCase()}">${t.priority}</span></div>
        <div class="task-list-col"><span class="badge ${statusBadge}">${statusLabel}</span></div>
        <div class="task-list-col"><span style="font-size:12px">${esc(t.next_due)}</span></div>
        <div class="task-list-col"><span class="task-recurrence-badge">&#8635; ${recLabel}</span></div>
        <div class="task-list-col-actions">
          ${t.is_active ? `<button class="btn btn-primary btn-sm" style="font-size:11px" onclick="openCompleteModal(${t.id})">&#10003;</button>` : ''}
          ${actionMenu([
            { label: '&#10003; Complete', onclick: `openCompleteModal(${t.id})`, cls: 'success' },
            { label: '&#128279; Links', onclick: `toggleTaskLinks(${t.id})` },
            { label: '&#9998; Edit', onclick: `openTaskModal(${t.id})` },
            'sep',
            { label: '&#128465; Delete', onclick: `deleteTask(${t.id})`, cls: 'danger' },
          ])}
        </div>
      </div>
      <div id="task-links-${t.id}" class="task-inline-links"></div>
    </div>`;
  }).join('');
  html += '</div>';
  container.innerHTML = html;
}

function toggleTaskLinks(taskId) {
  const el = document.getElementById(`task-links-${taskId}`);
  if (el.innerHTML) { el.innerHTML = ''; return; }
  renderCrossLinks('task', taskId, `task-links-${taskId}`);
}

// --- Individual control tickets ---
function renderTaskLogTable(instances) {
  const tbody = document.getElementById('task-log-table-body');
  if (instances.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No control tickets match this selection.<br>Try another status, series or date range.<br><br><button type="button" class="btn btn-secondary btn-sm" onclick="resetWorkFilters()">Reset filters</button></td></tr>';
    return;
  }
  const today = new Date().toISOString().split('T')[0];
  tbody.innerHTML = instances.map(i => {
    const overdue = i.status === 'pending' && i.scheduled_date < today;
    const scheduledCell = overdue
      ? `<span style="color:var(--danger);font-weight:600">${esc(i.scheduled_date || '')}</span>`
      : esc(i.scheduled_date || '');
    let statusCell = '';
    if (i.status === 'pending') {
      statusCell = overdue
        ? '<span class="badge badge-overdue">Overdue</span>'
        : (i.scheduled_date === today ? '<span class="badge badge-due-today">Due Today</span>' : '<span class="badge badge-upcoming">Upcoming</span>');
    } else if (i.status === 'completed') {
      const who = i.completed_by ? ` by ${esc(i.completed_by)}` : '';
      statusCell = `<span class="badge badge-low">Completed</span><br>${i.completed_at ? new Date(i.completed_at).toLocaleDateString() : ''}${who}`;
    } else {
      statusCell = '<span class="badge badge-inactive">Skipped</span>' + (i.notes ? `<br><small>${esc(i.notes)}</small>` : '');
    }
    const menuItems = [];
    if (i.status === 'pending') {
      menuItems.push({ label: '&#10003; Complete', onclick: `openInstanceCompleteModal(${i.id})`, cls: 'success' });
      menuItems.push({ label: '&#8856; Skip', onclick: `skipInstance(${i.id})` });
    } else {
      menuItems.push({ label: '&#8635; Reopen', onclick: `reopenInstance(${i.id})` });
    }
    menuItems.push({ label: '&#10133; Follow-up', onclick: `createFollowUpForInstance(${i.id},${i.task_id})` });
    menuItems.push('sep');
    menuItems.push({ label: '&#128203; View series', onclick: `openTaskDetailModal(${i.task_id})` });
    // Follow-up + evidence indicators (the API already returns these counts)
    let evidenceFiles = [];
    try { evidenceFiles = JSON.parse(i.evidence_files || '[]'); } catch (e) {}
    const indicators = [];
    if (i.action_count > 0) {
      const openCount = i.open_action_count || 0;
      indicators.push(`<button type="button" class="ti-indicator${openCount > 0 ? ' ti-indicator-open' : ''}"
        title="${openCount} open of ${i.action_count} follow-up${i.action_count > 1 ? 's' : ''} — click to view"
        onclick="event.stopPropagation();viewInstanceActions(${i.id},${i.task_id})">&#9889; ${openCount > 0 ? openCount + ' open' : i.action_count} follow-ups</button>`);
    }
    if (evidenceFiles.length > 0) {
      indicators.push(`<button type="button" class="ti-indicator" onclick="openControlTicket(${i.id})" title="View evidence">&#128206; ${evidenceFiles.length} files</button>`);
    }
    return `<tr>
      <td><button type="button" class="experience-text-button" onclick="openControlTicket(${i.id})">${esc(i.task_title)}</button><div class="work-ticket-reference">Ticket #${i.id}</div>${indicators.length ? `<span class="ti-indicators">${indicators.join('')}</span>` : ''}</td>
      <td>${i.task_category && i.task_category !== 'General' ? `<span class="op-ctx-process-tag">${esc(i.task_category)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>${esc(i.task_assignee || '-')}</td>
      <td><span class="badge badge-${(i.task_priority || 'Medium').toLowerCase()}">${esc(i.task_priority || 'Medium')}</span></td>
      <td>${scheduledCell}</td>
      <td>${statusCell}</td>
      <td><div class="work-inline-actions">${i.status === 'pending' ? `<button type="button" class="btn btn-primary btn-sm" onclick="openInstanceCompleteModal(${i.id})">Complete</button>` : ''}${actionMenu(menuItems)}</div></td>
    </tr>`;
  }).join('');
}

async function openInstanceCompleteModal(instanceId) {
  const inst = await api(`/api/task-instances/${instanceId}`);
  document.getElementById('complete-task-id').value = inst.task_id;
  // Populate the dropdown here too — without this the "Completed By" select is
  // empty when the modal is opened from the Task Log before any series modal.
  await populateCompletedByOptions(document.getElementById('complete-by'));
  document.getElementById('complete-notes').value = inst.notes || '';
  document.getElementById('complete-evidence-upload').style.display = 'none';
  document.getElementById('complete-evidence-list').innerHTML = '';
  document.getElementById('complete-modal-title').textContent = `${inst.task_title} — scheduled ${inst.scheduled_date}`;
  // Override submit behaviour for instance-direct completion
  lastInstanceContext = { instance_id: instanceId, task_id: inst.task_id, scheduled_date: inst.scheduled_date };
  delete document.getElementById('complete-form').dataset.expectedDue;
  document.getElementById('complete-form').dataset.instanceId = instanceId;
  document.getElementById('complete-modal').classList.remove('hidden');
}

async function skipInstance(instanceId) {
  const notes = prompt('Reason for skipping (optional):');
  if (notes === null) return; // cancelled
  try {
    await api(`/api/task-instances/${instanceId}/skip`, { method: 'POST', body: { notes } });
    showToast('Occurrence skipped');
  } catch (err) {
    showToast('Could not skip: ' + err.message, 'error');
  }
  invalidateYearlyCache();
  closeControlTicket();
  refreshCurrentView();
}

async function reopenInstance(instanceId) {
  if (!confirm('Reopen this task instance?')) return;
  try {
    await api(`/api/task-instances/${instanceId}/reopen`, { method: 'POST', body: {} });
    showToast('Occurrence reopened');
  } catch (err) {
    showToast('Could not reopen: ' + err.message, 'error');
  }
  invalidateYearlyCache();
  closeControlTicket();
  refreshCurrentView();
}

async function createFollowUpForInstance(instanceId) {
  try {
    const instance = await api(`/api/task-instances/${instanceId}`);
    await openActionModal();
    document.getElementById('action-instance-id').value = instance.id;
    document.getElementById('action-task-id').value = instance.task_id;
    const source = document.getElementById('action-source-ticket');
    source.hidden = false;
    source.textContent = `Control ticket #${instance.id} · ${instance.task_title} · Scheduled ${instance.scheduled_date}`;
    const process = opPlanProcesses.find(p => p.name === instance.task_category);
    document.getElementById('action-process-id').value = process ? process.id : '';
    document.getElementById('action-assignee').value = instance.task_assignee || '';
  } catch (error) { showToast('Could not prepare follow-up: '+error.message,'error'); }
}

// --- Task Detail Modal (read-only timeline view) ---
async function openTaskDetailModal(taskId) {
  const modal = document.getElementById('task-detail-modal');
  const body = document.getElementById('task-detail-body');
  body.innerHTML = '<div class="empty-state">Loading...</div>';
  modal.classList.remove('hidden');

  const task = await api(`/api/tasks/${taskId}`);
  const completions = task.completions || [];
  document.getElementById('task-detail-title').textContent = task.title;
  document.getElementById('task-detail-edit-btn').onclick = () => { closeTaskDetailModal(); openTaskModal(taskId); };
  document.getElementById('task-detail-complete-btn').onclick = () => { closeTaskDetailModal(); openCompleteModal(taskId); };

  const recLabel = { daily:'Daily', weekly:'Weekly', biweekly:'Biweekly', monthly:'Monthly', quarterly:'Quarterly', yearly:'Yearly', custom:'Custom' }[task.recurrence] || task.recurrence;
  const today = new Date().toISOString().split('T')[0];
  const statusLabel = !task.is_active ? 'Inactive' : task.next_due < today ? 'Overdue' : task.next_due === today ? 'Due Today' : 'Upcoming';
  const statusBadge = !task.is_active ? 'badge-inactive' : task.next_due < today ? 'badge-overdue' : task.next_due === today ? 'badge-due-today' : 'badge-upcoming';

  let html = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
    <span class="badge badge-${task.priority.toLowerCase()}">${task.priority}</span>
    <span class="badge ${statusBadge}">${statusLabel}</span>
    <span class="task-recurrence-badge">&#8635; ${recLabel}</span>
  </div>`;
  if (task.description) html += `<p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">${esc(task.description)}</p>`;
  html += `<div style="display:flex;gap:16px;font-size:13px;color:var(--text-muted);margin-bottom:16px;flex-wrap:wrap">
    ${task.assignee ? `<span>&#128100; ${esc(task.assignee)}</span>` : ''}
    ${task.category && task.category !== 'General' ? `<span>&#128260; ${esc(task.category)}</span>` : ''}
    <span>Next due: <strong>${esc(task.next_due || '')}</strong></span>
    <span>Start: ${esc(task.start_date || '')}</span>
  </div>`;

  // Completion timeline
  html += `<h4 style="font-size:13px;font-weight:600;text-transform:uppercase;color:var(--text-muted);letter-spacing:.5px;margin-bottom:12px;padding-top:12px;border-top:1px solid var(--border)">Completion History (${completions.length})</h4>`;
  if (completions.length === 0) {
    html += '<div class="empty-state" style="padding:16px 0">No completions yet</div>';
  } else {
    for (const c of completions) {
      let evidenceFiles = [];
      try { evidenceFiles = JSON.parse(c.evidence_files || '[]'); } catch(e) {}
      const actions = await api(`/api/actions?instance_id=${c.id}`);
      html += `<div style="border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;margin-bottom:10px;background:#fafbfc">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span style="font-size:13px;font-weight:600">${new Date(c.completed_at).toLocaleDateString()}</span>
          <span style="font-size:12px;color:var(--text-muted)">${c.completed_by ? 'by ' + esc(c.completed_by) : ''}</span>
        </div>
        ${c.notes ? `<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">${esc(c.notes)}</div>` : ''}
        ${evidenceFiles.length > 0 ? `<div style="margin-bottom:6px">${evidenceFiles.map(ef => `<span style="font-size:12px;cursor:pointer;text-decoration:underline;margin-right:10px" onclick="window.open('/api/task-instances/${c.id}/evidence/${ef.id}/download','_blank')">&#128206; ${esc(ef.name)}</span>`).join('')}</div>` : ''}
        ${actions.length > 0 ? `<div style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--border)">${actions.map(a => {
          const cls = a.status === 'open' ? 'badge-high' : a.status === 'in_progress' ? 'badge-medium' : 'badge-low';
          return `<div style="display:flex;align-items:center;gap:6px;font-size:12px;padding:2px 0">
            <span class="badge ${cls}" style="font-size:10px;padding:1px 6px">${a.status.replace('_',' ')}</span>
            <span>${esc(a.title)}</span>
            ${a.assignee ? `<span style="color:var(--text-muted)">— ${esc(a.assignee)}</span>` : ''}
          </div>`;
        }).join('')}</div>` : ''}
      </div>`;
    }
  }

  body.innerHTML = html;
}

function closeTaskDetailModal() {
  document.getElementById('task-detail-modal').classList.add('hidden');
}

// --- Task Modal ---
async function openTaskModal(id) {
  await ensureMeta();
  const modal = document.getElementById('task-modal');
  const form = document.getElementById('task-form');
  form.reset();
  document.getElementById('task-id').value = '';
  document.getElementById('task-start').value = new Date().toISOString().split('T')[0];
  document.getElementById('modal-title').textContent = 'New Series';
  toggleRecurrenceFields();

  // Populate Role dropdown from Architecture roles
  const roles = await api('/api/architecture?arch_type=role');
  const assigneeSelect = document.getElementById('task-assignee');
  assigneeSelect.innerHTML = '<option value="">-- Select Role --</option>' +
    roles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');

  // Populate Process dropdown from Architecture processes
  const processes = await api('/api/architecture?arch_type=process');
  const categorySelect = document.getElementById('task-category');
  categorySelect.innerHTML = '<option value="">-- Select Process --</option>' +
    processes.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');

  if (id) {
    const task = await api(`/api/tasks/${id}`);
    document.getElementById('modal-title').textContent = 'Edit Series';
    document.getElementById('task-id').value = task.id;
    document.getElementById('task-title').value = task.title;
    document.getElementById('task-desc').value = task.description;
    document.getElementById('task-assignee').value = task.assignee;
    document.getElementById('task-category').value = task.category;
    document.getElementById('task-priority').value = task.priority;
    document.getElementById('task-recurrence').value = task.recurrence;
    document.getElementById('task-custom-days').value = task.custom_days || 1;
    if (task.day_of_week != null) document.getElementById('task-day-of-week').value = task.day_of_week;
    if (task.day_of_month != null) document.getElementById('task-day-of-month').value = task.day_of_month;
    document.getElementById('task-start').value = task.start_date;
    toggleRecurrenceFields();
  }

  modal.classList.remove('hidden');
}

function closeTaskModal() {
  document.getElementById('task-modal').classList.add('hidden');
}

function toggleCustomDays() { toggleRecurrenceFields(); } // backwards compat alias
function toggleRecurrenceFields() {
  const sel = document.getElementById('task-recurrence').value;
  document.getElementById('custom-days-group').classList.toggle('hidden', sel !== 'custom');
  document.getElementById('task-day-of-week-group').classList.toggle('hidden', sel !== 'weekly');
  document.getElementById('task-day-of-month-group').classList.toggle('hidden', sel !== 'monthly');
}

async function saveTask(e) {
  e.preventDefault();
  const id = document.getElementById('task-id').value;
  const assigneeName = document.getElementById('task-assignee').value;
  const categoryName = document.getElementById('task-category').value || 'General';
  const recurrence = document.getElementById('task-recurrence').value;
  const body = {
    title: document.getElementById('task-title').value,
    description: document.getElementById('task-desc').value,
    assignee: assigneeName,
    category: categoryName,
    priority: document.getElementById('task-priority').value,
    recurrence,
    custom_days: recurrence === 'custom' ? (parseInt(document.getElementById('task-custom-days').value) || null) : null,
    day_of_week: recurrence === 'weekly' ? parseInt(document.getElementById('task-day-of-week').value) : null,
    day_of_month: recurrence === 'monthly' ? parseInt(document.getElementById('task-day-of-month').value) : null,
    start_date: document.getElementById('task-start').value,
  };

  let taskId = id;
  try {
    if (id) {
      await api(`/api/tasks/${id}`, { method: 'PUT', body });
    } else {
      const result = await api('/api/tasks', { method: 'POST', body });
      taskId = result.id;
    }
  } catch (err) {
    showToast('Could not save series: ' + err.message, 'error');
    return; // keep the modal open so the user can correct the input
  }

  // Create cross-links for role and process
  if (taskId) {
    // Get existing links to avoid duplicates
    const existingLinks = await api(`/api/cross-links/task/${taskId}`);
    const existingTargets = new Set(existingLinks.map(l => `${l.type}:${l.id}`));

    // Link assignee (role) by name lookup
    if (assigneeName) {
      const roles = await api('/api/architecture?arch_type=role');
      const role = roles.find(r => r.name === assigneeName);
      if (role && !existingTargets.has(`role:${role.id}`)) {
        await api('/api/cross-links', { method: 'POST', body: { source_type: 'task', source_id: parseInt(taskId), target_type: 'role', target_id: role.id } });
      }
    }
    // Link category (process) by name lookup
    if (categoryName && categoryName !== 'General') {
      const processes = await api('/api/architecture?arch_type=process');
      const proc = processes.find(p => p.name === categoryName);
      if (proc && !existingTargets.has(`process:${proc.id}`)) {
        await api('/api/cross-links', { method: 'POST', body: { source_type: 'task', source_id: parseInt(taskId), target_type: 'process', target_id: proc.id } });
      }
    }
  }

  closeTaskModal();
  invalidateYearlyCache();
  showToast(id ? 'Series updated' : 'Series created');
  meta = await api('/api/meta'); // refresh meta after adding new assignees/categories
  refreshCurrentView();
}

// --- Complete Modal ---
let activeInstanceId = null; // set after first save so evidence can be uploaded

// Populate the "Completed By" dropdown with the org roles plus the logged-in
// user, preselecting the current user so completing a check is one click.
async function populateCompletedByOptions(sel) {
  let roles = [];
  try { roles = await api('/api/architecture?arch_type=role'); } catch (e) { /* keep dropdown usable without roles */ }
  const userName = currentUser?.name || '';
  let options = '<option value="">-- Select --</option>';
  if (userName && !roles.some(r => r.name === userName)) {
    options += `<option value="${esc(userName)}">${esc(userName)} (me)</option>`;
  }
  options += roles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
  sel.innerHTML = options;
  if (userName) sel.value = userName;
}

async function openCompleteModal(taskId) {
  const form = document.getElementById('complete-form');
  form.reset();
  // Clear any instance targeting left over from a cancelled Task Log completion,
  // otherwise this series-level completion would complete that old instance.
  delete form.dataset.instanceId;
  const currentTask = await api(`/api/tasks/${taskId}`);
  form.dataset.expectedDue = currentTask.next_due;
  document.getElementById('complete-task-id').value = taskId;
  activeInstanceId = null;
  document.getElementById('complete-evidence-list').innerHTML = '';
  document.getElementById('complete-evidence-upload').style.display = 'none';
  document.getElementById('complete-modal-title').textContent = 'Mark Complete';

  await populateCompletedByOptions(document.getElementById('complete-by'));

  document.getElementById('complete-modal').classList.remove('hidden');
}

function closeCompleteModal() {
  document.getElementById('complete-modal').classList.add('hidden');
  activeInstanceId = null;
}

async function submitComplete(e) {
  e.preventDefault();
  const form = document.getElementById('complete-form');
  if (form.dataset.submitting === 'true') return;
  form.dataset.submitting = 'true';
  const submitButton = form.querySelector('[type=submit]');
  if (submitButton) submitButton.disabled = true;
  const instanceId = form.dataset.instanceId;
  const taskId = document.getElementById('complete-task-id').value;
  const completedBy = document.getElementById('complete-by').value;
  const notes = document.getElementById('complete-notes').value;

  let result;
  let scheduled = null;
  try {
    if (instanceId) {
      result = await api(`/api/task-instances/${instanceId}/complete`, {
        method: 'POST',
        body: { completed_by: completedBy, notes, expected_due: form.dataset.expectedDue },
      });
      activeInstanceId = parseInt(instanceId);
      scheduled = result.scheduled_date || null;
      delete form.dataset.instanceId;
    } else {
      result = await api(`/api/tasks/${taskId}/complete`, {
        method: 'POST',
        body: { completed_by: completedBy, notes, expected_due: form.dataset.expectedDue },
      });
      activeInstanceId = result.instance_id;
    }
  } catch (err) {
    showToast('Could not complete task: ' + err.message, 'error');
    return;
  } finally {
    delete form.dataset.submitting;
    if (submitButton) submitButton.disabled = false;
  }

  document.getElementById('complete-evidence-upload').style.display = 'block';
  document.getElementById('complete-modal-title').textContent = 'Completed — Attach Evidence';
  const savedInstanceId = activeInstanceId; // preserve before closeCompleteModal nullifies it
  closeCompleteModal();
  invalidateYearlyCache();
  showToast('Task marked complete');
  lastInstanceContext = { instance_id: savedInstanceId, task_id: parseInt(taskId), scheduled_date: scheduled };
  await openPostCompleteModal();
}

async function uploadInstanceEvidence() {
  if (!activeInstanceId) return;
  const fileInput = document.getElementById('complete-evidence-file');
  if (!fileInput.files.length) return;
  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  try {
    const res = await fetch(`/api/task-instances/${activeInstanceId}/evidence`, { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Upload failed' }));
      alert(err.error || 'Evidence upload failed');
      return;
    }
  } catch (e) {
    alert('Evidence upload failed: network error');
    return;
  }
  fileInput.value = '';
  showToast('Evidence uploaded');
  await refreshInstanceEvidence(activeInstanceId, 'complete-evidence-list');
}

async function refreshInstanceEvidence(instanceId, containerId) {
  if (!instanceId) return;
  const inst = await api(`/api/task-instances/${instanceId}`);
  let evidenceFiles = [];
  try { evidenceFiles = JSON.parse(inst?.evidence_files || '[]'); } catch(e) {}
  // Both evidence lists are always in the DOM, so target the one in the modal
  // that is actually open (the old "first match" approach always picked the
  // hidden complete-modal list, leaving the post-complete list empty).
  let container = containerId ? document.getElementById(containerId) : null;
  if (!container) {
    const postModal = document.getElementById('post-complete-modal');
    const postModalOpen = postModal && !postModal.classList.contains('hidden');
    container = document.getElementById(postModalOpen ? 'post-complete-evidence-list' : 'complete-evidence-list');
  }
  if (!container) return;
  if (evidenceFiles.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;font-style:italic">No evidence attached</div>';
    return;
  }
  container.innerHTML = evidenceFiles.map(ef => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px">
    <span>&#128206;</span>
    <span style="cursor:pointer;text-decoration:underline;flex:1" onclick="window.open('/api/task-instances/${instanceId}/evidence/${ef.id}/download','_blank')">${esc(ef.name)}</span>
    <span style="color:var(--text-muted);font-size:11px">${ef.size ? (ef.size / 1024).toFixed(1) + ' KB' : ''}</span>
    <button class="btn btn-secondary btn-sm" style="font-size:10px;padding:1px 6px" onclick="removeInstanceEvidence(${instanceId},${ef.id},'${container.id}')">&times;</button>
  </div>`).join('');
}

async function removeInstanceEvidence(instanceId, fileId, containerId) {
  if (!confirm('Remove this evidence file?')) return;
  try {
    await api(`/api/task-instances/${instanceId}/evidence/${fileId}`, { method: 'DELETE' });
    showToast('Evidence removed');
  } catch (err) {
    showToast('Could not remove evidence: ' + err.message, 'error');
  }
  await refreshInstanceEvidence(instanceId, containerId);
}

async function uploadPostCompleteEvidence() {
  if (!lastInstanceContext) return;
  const fileInput = document.getElementById('post-complete-evidence-file');
  if (!fileInput.files.length) return;
  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  try {
    const res = await fetch(`/api/task-instances/${lastInstanceContext.instance_id}/evidence`, { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Upload failed' }));
      showToast(err.error || 'Evidence upload failed', 'error');
      return;
    }
    showToast('Evidence uploaded');
  } catch (e) {
    showToast('Evidence upload failed: network error', 'error');
    return;
  }
  fileInput.value = '';
  await refreshInstanceEvidence(lastInstanceContext.instance_id, 'post-complete-evidence-list');
}


// --- Delete (soft-delete: deactivates task, preserves history) ---
async function deleteTask(id) {
  if (!confirm('Deactivate this task? Its completion history will be preserved.')) return;
  try {
    await api(`/api/tasks/${id}`, { method: 'PUT', body: { is_active: 0 } });
    showToast('Series deactivated — history preserved');
  } catch (err) {
    showToast('Could not deactivate series: ' + err.message, 'error');
  }
  invalidateYearlyCache();
  refreshCurrentView();
}

// --- Post-completion Actions ---
async function openPostCompleteModal() {
  const titleEl = document.getElementById('post-complete-title');
  if (titleEl) titleEl.textContent = 'Task Completed';
  document.getElementById('post-complete-actions-list').innerHTML = '';
  document.getElementById('quick-action-title').value = '';
  document.getElementById('quick-action-priority').value = 'Medium';
  document.getElementById('quick-action-due').value = '';

  // Populate Role dropdown from Architecture
  const roles = await api('/api/architecture?arch_type=role');
  const assigneeSelect = document.getElementById('quick-action-assignee');
  assigneeSelect.innerHTML = '<option value="">-- Select Role --</option>' +
    roles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');

  // Show evidence section for this completion
  const evidenceWrap = document.getElementById('post-complete-evidence-wrap');
  if (evidenceWrap && lastInstanceContext) {
    evidenceWrap.style.display = 'block';
    activeInstanceId = lastInstanceContext.instance_id;
    await refreshInstanceEvidence(lastInstanceContext.instance_id, 'post-complete-evidence-list');
  }

  document.getElementById('post-complete-modal').classList.remove('hidden');
}

function closePostCompleteModal() {
  document.getElementById('post-complete-modal').classList.add('hidden');
  lastInstanceContext = null;
  activeInstanceId = null;
  refreshCurrentView();
}

async function linkInstanceToAudit() {
  if (!lastInstanceContext) return;
  // Fetch active audits with checklist items
  const audits = await api('/api/audits?status=in_progress');
  if (audits.length === 0) return alert('No in-progress audits found. Start an audit first.');
  const auditOptions = audits.map(a => `${a.id}: ${a.title}`).join('\n');
  const auditChoice = prompt(`Select an audit ID to link to:\n\n${auditOptions}`);
  if (!auditChoice) return;
  const auditId = parseInt(auditChoice);
  if (isNaN(auditId)) return;
  // Create cross-link: task → audit
  await api('/api/cross-links', {
    method: 'POST',
    body: { source_type: 'task', source_id: lastInstanceContext.task_id, target_type: 'audit', target_id: auditId }
  });
  const container = document.getElementById('post-complete-crosslinks');
  const audit = audits.find(a => a.id === auditId);
  container.innerHTML += `<div style="font-size:12px;padding:4px 0">&#9745; Linked to audit: <strong>${esc(audit?.title || 'Audit #' + auditId)}</strong></div>`;
}

async function createNcrFromInstance() {
  if (!lastInstanceContext) return;
  const title = prompt('NCR title (describe the nonconformity):');
  if (!title) return;
  // Create a new action flagged as NCR-type
  const action = await api('/api/actions', {
    method: 'POST',
    body: {
      instance_id: lastInstanceContext.instance_id,
      task_id: lastInstanceContext.task_id,
      title: '[NCR] ' + title,
      description: 'Nonconformity raised from task completion',
      priority: 'High',
    },
  });
  // Also try to create as a real NCR if the endpoint exists
  try {
    const ncr = await api('/api/ncrs', {
      method: 'POST',
      body: { title, source: 'task_completion', source_id: lastInstanceContext.task_id, severity: 'major' }
    });
    if (ncr && ncr.id) {
      await api('/api/cross-links', {
        method: 'POST',
        body: { source_type: 'action', source_id: action.id, target_type: 'ncr', target_id: ncr.id }
      });
    }
  } catch (e) { /* NCR module may not exist, the action is the fallback */ }
  const container = document.getElementById('post-complete-crosslinks');
  container.innerHTML += `<div style="font-size:12px;padding:4px 0">&#9888; NCR raised: <strong>${esc(title)}</strong></div>`;
  // Also add to actions list visually
  const list = document.getElementById('post-complete-actions-list');
  list.innerHTML += `<div class="task-card" style="margin-bottom:8px">
    <div class="task-card-info"><h4>[NCR] ${esc(title)}</h4><div class="meta">High priority</div></div>
  </div>`;
}

async function addQuickAction() {
  const title = document.getElementById('quick-action-title').value.trim();
  if (!title) return alert('Action title is required');

  const assigneeName = document.getElementById('quick-action-assignee').value;
  const taskId = lastInstanceContext.task_id;

  let action;
  try {
    action = await api('/api/actions', {
      method: 'POST',
      body: {
        instance_id: lastInstanceContext.instance_id,
        task_id: taskId,
        title,
        assignee: assigneeName,
        priority: document.getElementById('quick-action-priority').value,
        due_date: document.getElementById('quick-action-due').value || null,
      },
    });
    showToast('Follow-up created');
  } catch (err) {
    showToast('Could not create follow-up: ' + err.message, 'error');
    return;
  }

  // Create cross-links for role and source task
  if (action.id) {
    // Link assignee (role) by name lookup
    if (assigneeName) {
      const roles = await api('/api/architecture?arch_type=role');
      const role = roles.find(r => r.name === assigneeName);
      if (role) {
        await api('/api/cross-links', { method: 'POST', body: { source_type: 'action', source_id: action.id, target_type: 'role', target_id: role.id } });
      }
    }
    // Link source task
    if (taskId) {
      await api('/api/cross-links', { method: 'POST', body: { source_type: 'action', source_id: action.id, target_type: 'task', target_id: parseInt(taskId) } });
    }
  }

  // Add to the visible list
  const list = document.getElementById('post-complete-actions-list');
  list.innerHTML += `<div class="task-card" style="margin-bottom:8px">
    <div class="task-card-info">
      <h4>${esc(action.title)}</h4>
      <div class="meta">${esc(action.assignee || 'Unassigned')} &middot; <span class="badge badge-${action.priority.toLowerCase()}">${esc(action.priority)}</span>${action.due_date ? ' &middot; Due: ' + esc(action.due_date) : ''}</div>
    </div>
  </div>`;

  // Reset inputs
  document.getElementById('quick-action-title').value = '';
  document.getElementById('quick-action-assignee').value = '';
  document.getElementById('quick-action-priority').value = 'Medium';
  document.getElementById('quick-action-due').value = '';
}
