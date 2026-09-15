
// --- User Widget Dropdown ---
function toggleUserDropdown(e) {
  e.stopPropagation();
  const dropdown = document.getElementById('user-widget-dropdown');
  const trigger = document.getElementById('user-widget-trigger');
  const isOpen = dropdown.classList.contains('open');
  if (isOpen) {
    dropdown.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
  } else {
    dropdown.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
  }
}

function closeUserDropdown() {
  const dropdown = document.getElementById('user-widget-dropdown');
  const trigger = document.getElementById('user-widget-trigger');
  if (dropdown) dropdown.classList.remove('open');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  const widget = document.getElementById('user-widget');
  if (widget && !widget.contains(e.target)) closeUserDropdown();
});

// --- My Tasks View ---
async function loadMyTasks() {
  const container = document.getElementById('my-tasks-content');
  if (!container) return;
  container.innerHTML = '<div class="empty-state">Loading your tasks…</div>';
  try {
    const data = await api('/api/my-tasks');
    container.innerHTML = renderMyTasksContent(data);
  } catch (err) {
    container.innerHTML = `<div class="empty-state" style="color:var(--danger)">Failed to load tasks: ${esc(err.message)}</div>`;
  }
}

// Quick status changes on follow-ups straight from the My Tasks inbox
async function myTasksUpdateAction(id, status) {
  try {
    await api(`/api/actions/${id}`, { method: 'PUT', body: { status } });
    showToast(status === 'in_progress' ? 'Follow-up started' : 'Follow-up updated');
  } catch (err) {
    showToast('Could not update follow-up: ' + err.message, 'error');
  }
  loadMyTasks();
}

async function myTasksResolveAction(id) {
  const resolvedBy = prompt('Resolved by:', currentUser?.name || '');
  if (resolvedBy === null) return;
  try {
    await api(`/api/actions/${id}`, { method: 'PUT', body: { status: 'resolved', resolved_by: resolvedBy } });
    showToast('Follow-up resolved');
  } catch (err) {
    showToast('Could not resolve follow-up: ' + err.message, 'error');
  }
  loadMyTasks();
}

function renderMyTasksContent(data) {
  const { tasks = [], actions = [], ncrs = [], audits = [], treatments = [], mgmtOutputs = [], assignedRoles = [] } = data;
  const today = new Date().toISOString().split('T')[0];
  const roleSet = new Set(assignedRoles);

  // ── Shared helpers ─────────────────────────────────────────────────────────

  function priorityBadge(p) {
    const map = { Critical: 'badge-critical', High: 'badge-high', Medium: 'badge-medium', Low: 'badge-low' };
    return `<span class="badge ${map[p] || 'badge-low'}">${p || 'Medium'}</span>`;
  }

  function statusBadge(s, statusMap) {
    const map = statusMap || { open: 'badge-medium', in_progress: 'badge-high', resolved: 'badge-low', closed: 'badge-inactive' };
    return `<span class="badge ${map[s] || 'badge-medium'}">${(s || '').replace(/_/g, ' ')}</span>`;
  }

  function dueDateLabel(dateStr) {
    if (!dateStr) return '<span class="my-tasks-due">—</span>';
    const isOverdue = dateStr < today;
    const isToday = dateStr === today;
    const cls = isOverdue ? 'my-tasks-overdue' : isToday ? 'my-tasks-today' : '';
    const label = isOverdue ? '⚠ Overdue · ' : isToday ? '● Due Today · ' : '';
    return `<span class="my-tasks-due ${cls}">${label}${esc(dateStr)}</span>`;
  }

  // Returns a "via Role" chip when the assignee field is a role name (not the user directly)
  function roleTag(assigneeField) {
    if (assigneeField && roleSet.has(assigneeField)) {
      return `<span class="my-tasks-role-tag" title="Assigned via role">&#128100; ${esc(assigneeField)}</span>`;
    }
    return '';
  }

  // ── Section builder ────────────────────────────────────────────────────────

  function section(icon, title, count, body) {
    return `
      <div class="my-tasks-section">
        <div class="my-tasks-section-header">
          <span class="my-tasks-section-icon">${icon}</span>
          <h3>${title} <span class="my-tasks-count">${count}</span></h3>
        </div>
        ${body}
      </div>`;
  }

  function emptyMsg(msg) {
    return `<div class="my-tasks-empty">${msg}</div>`;
  }

  function itemRowCls(dateStr) {
    if (!dateStr) return 'my-tasks-item';
    return dateStr < today ? 'my-tasks-item overdue' : dateStr === today ? 'my-tasks-item today' : 'my-tasks-item';
  }

  // ── Assigned-roles header ──────────────────────────────────────────────────
  let headerHtml = '';
  if (assignedRoles.length > 0) {
    headerHtml = `
      <div class="my-tasks-roles-bar">
        <span class="my-tasks-roles-label">&#128100; Your roles:</span>
        ${assignedRoles.map(r => `<span class="my-tasks-role-chip">${esc(r)}</span>`).join('')}
      </div>`;
  }

  // ── Recurring Tasks ────────────────────────────────────────────────────────
  // Quick actions are only shown when the user can reach the underlying module
  const canCompleteTasks = hasPermissionForView('tasks');
  const canActOnActions = hasPermissionForView('actions');

  let tasksBody = '';
  if (tasks.length === 0) {
    tasksBody = emptyMsg('No recurring tasks assigned to you or your roles.');
  } else {
    tasksBody = '<div class="my-tasks-list">';
    for (const t of tasks) {
      tasksBody += `
        <div class="${itemRowCls(t.next_due)}" onclick="switchView('tasks')">
          <div class="my-tasks-item-main">
            <div class="my-tasks-item-title">${esc(t.title)}</div>
            <div class="my-tasks-item-sub">
              ${t.category ? `<span class="my-tasks-cat">${esc(t.category)}</span>` : ''}
              ${roleTag(t.assignee)}
            </div>
          </div>
          <div class="my-tasks-item-meta">
            ${priorityBadge(t.priority)}
            <span class="my-tasks-recurrence">&#8635; ${t.recurrence}</span>
            ${dueDateLabel(t.next_due)}
            ${canCompleteTasks ? `<button class="btn btn-primary btn-sm" style="font-size:11px" title="Mark this check as done" onclick="event.stopPropagation();openCompleteModal(${t.id})">&#10003; Complete</button>` : ''}
          </div>
        </div>`;
    }
    tasksBody += '</div>';
  }

  // ── Follow-up Actions ──────────────────────────────────────────────────────
  let actionsBody = '';
  const actionStatusMap = { open: 'badge-medium', in_progress: 'badge-high', resolved: 'badge-low', closed: 'badge-inactive' };
  if (actions.length === 0) {
    actionsBody = emptyMsg('No open actions assigned to you or your roles.');
  } else {
    actionsBody = '<div class="my-tasks-list">';
    for (const a of actions) {
      const quickBtn = !canActOnActions ? '' :
        a.status === 'open' ? `<button class="btn btn-secondary btn-sm" style="font-size:11px" onclick="event.stopPropagation();myTasksUpdateAction(${a.id},'in_progress')">&#9654; Start</button>` :
        a.status === 'in_progress' ? `<button class="btn btn-primary btn-sm" style="font-size:11px" onclick="event.stopPropagation();myTasksResolveAction(${a.id})">&#10003; Resolve</button>` : '';
      actionsBody += `
        <div class="${itemRowCls(a.due_date)}" onclick="switchView('actions')">
          <div class="my-tasks-item-main">
            <div class="my-tasks-item-title">${esc(a.title)}</div>
            <div class="my-tasks-item-sub">
              ${a.task_title ? `<span class="my-tasks-cat">&#128279; ${esc(a.task_title)}</span>` : ''}
              ${roleTag(a.assignee)}
            </div>
          </div>
          <div class="my-tasks-item-meta">
            ${priorityBadge(a.priority)}
            ${statusBadge(a.status, actionStatusMap)}
            ${dueDateLabel(a.due_date)}
            ${quickBtn}
          </div>
        </div>`;
    }
    actionsBody += '</div>';
  }

  // ── Audits ─────────────────────────────────────────────────────────────────
  let auditsBody = '';
  const auditStatusMap = { planned: 'badge-medium', in_progress: 'badge-high', completed: 'badge-low' };
  if (audits.length === 0) {
    auditsBody = emptyMsg('No upcoming audits assigned to you or your roles.');
  } else {
    auditsBody = '<div class="my-tasks-list">';
    for (const a of audits) {
      // Determine whether user is lead auditor, auditee, or both (via direct match or role)
      const roles = [];
      if (a.lead_auditor) roles.push({ field: a.lead_auditor, label: 'Lead Auditor' });
      if (a.auditee) roles.push({ field: a.auditee, label: 'Auditee' });
      const roleChips = roles.map(r =>
        `<span class="my-tasks-cat">${r.label}: ${esc(r.field)}${roleSet.has(r.field) ? ' <span class="my-tasks-role-tag" title="Via role">&#128100;</span>' : ''}</span>`
      ).join('');
      auditsBody += `
        <div class="${itemRowCls(a.planned_date)}" onclick="switchView('audit-plan')">
          <div class="my-tasks-item-main">
            <div class="my-tasks-item-title">${esc(a.title)}</div>
            <div class="my-tasks-item-sub">${roleChips}</div>
          </div>
          <div class="my-tasks-item-meta">
            ${statusBadge(a.status, auditStatusMap)}
            ${dueDateLabel(a.planned_date)}
          </div>
        </div>`;
    }
    auditsBody += '</div>';
  }

  // ── Risk Treatments ────────────────────────────────────────────────────────
  let treatmentsBody = '';
  const treatmentStatusMap = { planned: 'badge-medium', in_progress: 'badge-high', completed: 'badge-low', accepted: 'badge-inactive' };
  if (treatments.length === 0) {
    treatmentsBody = emptyMsg('No open risk treatments assigned to you or your roles.');
  } else {
    treatmentsBody = '<div class="my-tasks-list">';
    for (const t of treatments) {
      const desc = t.description ? (t.description.length > 90 ? t.description.substring(0, 90) + '…' : t.description) : '—';
      treatmentsBody += `
        <div class="${itemRowCls(t.due_date)}" onclick="switchView('risk-treatment')">
          <div class="my-tasks-item-main">
            <div class="my-tasks-item-title">${esc(desc)}</div>
            <div class="my-tasks-item-sub">
              ${t.risk_title ? `<span class="my-tasks-cat">&#9888; ${esc(t.risk_title)}</span>` : ''}
              ${roleTag(t.responsible)}
            </div>
          </div>
          <div class="my-tasks-item-meta">
            ${t.treatment_type ? `<span class="my-tasks-recurrence">${esc(t.treatment_type)}</span>` : ''}
            ${statusBadge(t.status, treatmentStatusMap)}
            ${dueDateLabel(t.due_date)}
          </div>
        </div>`;
    }
    treatmentsBody += '</div>';
  }

  // ── Non-Conformities ───────────────────────────────────────────────────────
  let ncrsBody = '';
  const ncrStatusMap = { open: 'badge-medium', in_progress: 'badge-high', closed: 'badge-low', verified: 'badge-inactive' };
  if (ncrs.length === 0) {
    ncrsBody = emptyMsg('No open non-conformities assigned to you or your roles.');
  } else {
    ncrsBody = '<div class="my-tasks-list">';
    for (const n of ncrs) {
      const desc = n.description.length > 100 ? n.description.substring(0, 100) + '…' : n.description;
      ncrsBody += `
        <div class="${itemRowCls(n.due_date)}" onclick="switchView('audit-ncrs')">
          <div class="my-tasks-item-main">
            <div class="my-tasks-item-title">${esc(desc)}</div>
            <div class="my-tasks-item-sub">
              ${n.audit_title ? `<span class="my-tasks-cat">&#9998; ${esc(n.audit_title)}</span>` : ''}
              ${roleTag(n.responsible)}
            </div>
          </div>
          <div class="my-tasks-item-meta">
            <span class="badge ${n.severity === 'major' ? 'badge-critical' : 'badge-medium'}">${n.severity || 'minor'}</span>
            ${statusBadge(n.status, ncrStatusMap)}
            ${dueDateLabel(n.due_date)}
          </div>
        </div>`;
    }
    ncrsBody += '</div>';
  }

  // ── Management Review Outputs ──────────────────────────────────────────────
  let mgmtOutputsBody = '';
  const mgmtStatusMap = { open: 'badge-medium', in_progress: 'badge-high', completed: 'badge-low' };
  const mgmtTypeLabels = { improvement: 'Improvement', resource: 'Resource Need', change: 'System Change' };
  if (mgmtOutputs.length === 0) {
    mgmtOutputsBody = emptyMsg('No open management review outputs assigned to you or your roles.');
  } else {
    mgmtOutputsBody = '<div class="my-tasks-list">';
    for (const o of mgmtOutputs) {
      const desc = o.description.length > 100 ? o.description.substring(0, 100) + '…' : o.description;
      mgmtOutputsBody += `
        <div class="${itemRowCls(o.due_date)}" onclick="switchView('management-reviews')">
          <div class="my-tasks-item-main">
            <div class="my-tasks-item-title">${esc(desc)}</div>
            <div class="my-tasks-item-sub">
              ${o.review_title ? `<span class="my-tasks-cat">&#128203; ${esc(o.review_title)}</span>` : ''}
              ${o.type ? `<span class="my-tasks-cat">${mgmtTypeLabels[o.type] || o.type}</span>` : ''}
              ${roleTag(o.assigned_to)}
            </div>
          </div>
          <div class="my-tasks-item-meta">
            ${statusBadge(o.status, mgmtStatusMap)}
            ${dueDateLabel(o.due_date)}
          </div>
        </div>`;
    }
    mgmtOutputsBody += '</div>';
  }

  // ── All-done state ─────────────────────────────────────────────────────────
  const totalCount = tasks.length + actions.length + ncrs.length + audits.length + treatments.length + mgmtOutputs.length;
  if (totalCount === 0) {
    return `${headerHtml}
      <div class="my-tasks-all-done">
        <div class="my-tasks-all-done-icon">&#10003;</div>
        <div class="my-tasks-all-done-text">You're all caught up! Nothing is currently assigned to you${assignedRoles.length ? ' or your roles' : ''}.</div>
      </div>`;
  }

  return headerHtml
    + section('&#9745;', 'Recurring Tasks', tasks.length, tasksBody)
    + section('&#9889;', 'Follow-up Actions', actions.length, actionsBody)
    + section('&#9998;', 'Audits', audits.length, auditsBody)
    + section('&#128737;', 'Risk Treatments', treatments.length, treatmentsBody)
    + section('&#9888;', 'Non-Conformities', ncrs.length, ncrsBody)
    + section('&#128203;', 'Management Review Actions', mgmtOutputs.length, mgmtOutputsBody);
}
