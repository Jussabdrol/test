
// --- Actions View ---
function renderActionTable(actions) {
  const tbody = document.getElementById('action-table-body');
  const today = new Date().toISOString().split('T')[0];
  if (actions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No follow-up actions match this selection.<br>
      Follow-ups track corrective work coming out of your recurring checks.<br><br>
      <button class="btn btn-primary btn-sm" onclick="newWorkspaceAction()">+ New Follow-up</button></td></tr>`;
    return;
  }
  tbody.innerHTML = actions.map(a => {
    const isOverdue = a.due_date && a.due_date < today && (a.status === 'open' || a.status === 'in_progress');
    const statusClass = a.status === 'open' ? 'badge-high' : a.status === 'in_progress' ? 'badge-medium' : 'badge-low';
    const statusLabel = a.status.replace('_', ' ');
    return `<tr>
      <td><button type="button" class="experience-text-button" onclick="openActionModal(${a.id})">${esc(a.title)}</button>${a.description ? '<br><small style="color:var(--text-muted);cursor:pointer" onclick="openActionModal(' + a.id + ')">' + esc(a.description) + '</small>' : ''}</td>
      <td>${a.process_name ? `<span class="op-ctx-process-tag">${esc(a.process_name)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>${a.instance_id ? `<button type="button" class="experience-text-button" onclick="openControlTicket(${a.instance_id})">${esc(a.task_title)}</button><div class="work-ticket-reference">Ticket #${a.instance_id} · ${esc(a.instance_scheduled_date || '')}</div>` : a.task_id ? `<button type="button" class="experience-text-button" onclick="openTaskDetailModal(${a.task_id})">${esc(a.task_title)}</button><div class="work-ticket-reference">Series-level action</div>` : '<span class="work-ticket-reference">Standalone action</span>'}</td>
      <td>${esc(a.assignee || '-')}</td>
      <td><span class="badge badge-${a.priority.toLowerCase()}">${a.priority}</span></td>
      <td>${a.due_date ? (isOverdue ? '<span style="color:var(--danger);font-weight:600">' + esc(a.due_date) + '</span>' : esc(a.due_date)) : '-'}</td>
      <td><span class="badge ${statusClass}">${statusLabel}</span></td>
      <td><div class="work-inline-actions">${a.status === 'open' ? `<button type="button" class="btn btn-secondary btn-sm" onclick="updateActionStatus(${a.id},'in_progress')">Start</button>` : a.status === 'in_progress' ? `<button type="button" class="btn btn-secondary btn-sm" onclick="resolveAction(${a.id})">Resolve</button>` : ''}${actionMenu([
        ...(a.status === 'open' ? [{ label: '&#9654; Start', onclick: `updateActionStatus(${a.id},'in_progress')`, cls: 'primary' }] : []),
        ...(a.status === 'in_progress' ? [{ label: '&#10003; Resolve', onclick: `resolveAction(${a.id})`, cls: 'success' }] : []),
        { label: '&#9998; Edit', onclick: `openActionModal(${a.id})` },
        'sep',
        { label: '&#128465; Delete', onclick: `deleteAction(${a.id})`, cls: 'danger' },
      ])}</div></td>
    </tr>`;
  }).join('');
}

async function updateActionStatus(id, status) {
  try {
    await api(`/api/actions/${id}`, { method: 'PUT', body: { status } });
    showToast(status === 'in_progress' ? 'Follow-up started' : 'Follow-up updated');
  } catch (err) {
    showToast('Could not update follow-up: ' + err.message, 'error');
  }
  refreshCurrentView();
}

async function updateActionStatusAndRefresh(id, status) {
  return updateActionStatus(id, status);
}

async function resolveAction(id) {
  const resolvedBy = prompt('Resolved by:', currentUser?.name || '');
  if (resolvedBy === null) return;
  try {
    await api(`/api/actions/${id}`, { method: 'PUT', body: { status: 'resolved', resolved_by: resolvedBy } });
    showToast('Follow-up resolved');
  } catch (err) {
    showToast('Could not resolve follow-up: ' + err.message, 'error');
  }
  refreshCurrentView();
}

async function deleteAction(id) {
  if (!confirm('Delete this action?')) return;
  try {
    await api(`/api/actions/${id}`, { method: 'DELETE' });
    showToast('Follow-up deleted');
  } catch (err) {
    showToast('Could not delete follow-up: ' + err.message, 'error');
  }
  refreshCurrentView();
}

// --- Action Modal (edit) ---
let actionStatusHandler = null;

async function openActionModal(id) {
  const modal = document.getElementById('action-modal');
  const form = document.getElementById('action-form');
  form.reset();
  document.getElementById('action-source-ticket').hidden = true;
  document.getElementById('action-id').value = '';
  document.getElementById('action-instance-id').value = '';
  document.getElementById('action-task-id').value = '';
  document.getElementById('action-modal-title').textContent = 'New Follow-up';
  document.getElementById('action-resolved-by-group').classList.add('hidden');

  // Populate Role + Process dropdowns from Architecture
  const [roles, processes] = await Promise.all([
    api('/api/architecture?arch_type=role'),
    opPlanProcesses.length ? Promise.resolve(opPlanProcesses) : api('/api/architecture?arch_type=process'),
  ]);
  const assigneeSelect = document.getElementById('action-assignee');
  assigneeSelect.innerHTML = '<option value="">-- Select Role --</option>' +
    roles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
  const processSelect = document.getElementById('action-process-id');
  processSelect.innerHTML = '<option value="">— Not linked to a process —</option>' +
    processes.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');

  // Pre-select process from context bar if creating new action
  if (!id && opPlanContext.type === 'process' && opPlanContext.id) {
    processSelect.value = opPlanContext.id;
  }

  if (id) {
    const action = await api(`/api/actions/${id}`);
    document.getElementById('action-modal-title').textContent = 'Edit Follow-up';
    document.getElementById('action-id').value = action.id;
    document.getElementById('action-instance-id').value = action.instance_id || '';
    document.getElementById('action-task-id').value = action.task_id;
    if (action.instance_id) {
      const source = document.getElementById('action-source-ticket');
      source.textContent = `Linked to control ticket #${action.instance_id} · ${action.task_title || ''}`;
      source.hidden = false;
    }
    document.getElementById('action-title').value = action.title;
    document.getElementById('action-description').value = action.description;
    document.getElementById('action-assignee').value = action.assignee;
    document.getElementById('action-priority').value = action.priority;
    document.getElementById('action-due-date').value = action.due_date || '';
    document.getElementById('action-status').value = action.status;
    document.getElementById('action-resolved-by').value = action.resolved_by || '';
    processSelect.value = action.process_id || '';
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
  const assigneeName = document.getElementById('action-assignee').value;
  const processIdVal = document.getElementById('action-process-id').value;
  const body = {
    title: document.getElementById('action-title').value,
    description: document.getElementById('action-description').value,
    assignee: assigneeName,
    priority: document.getElementById('action-priority').value,
    due_date: document.getElementById('action-due-date').value || null,
    status: document.getElementById('action-status').value,
    resolved_by: document.getElementById('action-resolved-by').value,
    process_id: processIdVal ? parseInt(processIdVal) : null,
  };

  let actionId = id;
  let taskId = null;
  try {
    if (id) {
      await api(`/api/actions/${id}`, { method: 'PUT', body });
    } else {
      const instVal = document.getElementById('action-instance-id').value;
      body.instance_id = instVal ? parseInt(instVal) : null;
      taskId = document.getElementById('action-task-id').value;
      body.task_id = taskId;
      const result = await api('/api/actions', { method: 'POST', body });
      actionId = result.id;
    }
  } catch (err) {
    showToast('Could not save follow-up: ' + err.message, 'error');
    return; // keep the modal open so the user can correct the input
  }

  // Create cross-links for role and source task
  if (actionId) {
    // Get existing links to avoid duplicates
    const existingLinks = await api(`/api/cross-links/action/${actionId}`);
    const existingTargets = new Set(existingLinks.map(l => `${l.type}:${l.id}`));

    // Link assignee (role) by name lookup
    if (assigneeName) {
      const roles = await api('/api/architecture?arch_type=role');
      const role = roles.find(r => r.name === assigneeName);
      if (role && !existingTargets.has(`role:${role.id}`)) {
        await api('/api/cross-links', { method: 'POST', body: { source_type: 'action', source_id: parseInt(actionId), target_type: 'role', target_id: role.id } });
      }
    }
    // Link source task (only for new actions)
    if (taskId && !existingTargets.has(`task:${taskId}`)) {
      await api('/api/cross-links', { method: 'POST', body: { source_type: 'action', source_id: parseInt(actionId), target_type: 'task', target_id: parseInt(taskId) } });
    }
  }

  closeActionModal();
  showToast(id ? 'Follow-up updated' : 'Follow-up created');
  refreshCurrentView();
}
