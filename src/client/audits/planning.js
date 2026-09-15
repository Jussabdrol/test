
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
    const recurrenceLabel = { monthly: 'Monthly', quarterly: 'Quarterly', 'semi-annual': 'Semi-Annual', annual: 'Annual' };
    const hasEvents = a.all_events && a.all_events.length > 0;
    const isRecurring = a.recurrence && a.recurrence !== 'none';

    // Calculate aggregate stats across all events
    const totalAssessed = a.all_events ? a.all_events.reduce((sum, e) => sum + (e.assessed_count || 0), 0) : a.assessed_count;
    const totalChecklist = a.all_events ? a.all_events.reduce((sum, e) => sum + (e.checklist_count || 0), 0) : a.checklist_count;
    const totalNc = a.all_events ? a.all_events.reduce((sum, e) => sum + (e.nc_count || 0), 0) : a.nc_count;
    const totalOpenNc = a.all_events ? a.all_events.reduce((sum, e) => sum + (e.open_nc_count || 0), 0) : a.open_nc_count;
    const completedEvents = a.all_events ? a.all_events.filter(e => e.status === 'completed').length : 0;
    const inProgressEvents = a.all_events ? a.all_events.filter(e => e.status === 'in_progress').length : 0;

    // Build ALL events section (including event #1 - the parent)
    let eventsHtml = '';
    if (hasEvents) {
      eventsHtml = `<div class="audit-children collapsed" id="audit-children-${a.id}">
        ${a.all_events.map(ev => {
          const evStatusCls = ev.status === 'completed' ? 'badge-low' : ev.status === 'in_progress' ? 'badge-medium' : ev.status === 'cancelled' ? 'badge-inactive' : 'badge-upcoming';
          return `<div class="audit-child-event">
            <div class="audit-child-main">
              <span class="audit-child-date">${ev.planned_date ? esc(ev.planned_date) : 'No date'}</span>
              <span class="audit-child-instance">Event #${ev.instance_number || 1}</span>
              <span class="badge ${evStatusCls}">${esc(ev.status.replace('_', ' '))}</span>
              <span class="audit-child-stats">${ev.assessed_count || 0}/${ev.checklist_count || 0} assessed</span>
            </div>
            <div class="audit-child-actions">
              ${ev.status === 'planned' ? `<button class="btn btn-secondary btn-sm" onclick="startAudit(${ev.id})">Start</button>` : ''}
              ${ev.status === 'in_progress' ? `<button class="btn btn-primary btn-sm" onclick="switchToExecute(${ev.id})">Execute</button>` : ''}
              ${ev.status === 'completed' ? `<button class="btn btn-secondary btn-sm" onclick="switchToExecute(${ev.id})">View</button>` : ''}
              <button class="btn btn-secondary btn-sm" onclick="openAuditModal(${ev.id})">Edit</button>
            </div>
          </div>`;
        }).join('')}
      </div>`;
    }

    return `<div class="audit-card${isRecurring ? ' audit-recurring' : ''}">
      <div class="audit-card-header">
        <div>
          <h3>${esc(a.title)}</h3>
          <div class="audit-meta">
            ${esc(a.standard)} &middot; Lead: ${esc(a.lead_auditor || 'Unassigned')}
            ${isRecurring ? ` &middot; <span class="audit-recurrence-badge">${recurrenceLabel[a.recurrence] || a.recurrence}</span>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${hasEvents ? `<button class="btn btn-secondary btn-sm" onclick="toggleAuditChildren(${a.id})"><span id="audit-toggle-${a.id}">&#9660;</span> ${a.total_instances} Event${a.total_instances !== 1 ? 's' : ''}</button>` : ''}
        </div>
      </div>
      ${a.scope ? `<div class="audit-scope">${esc(a.scope)}</div>` : ''}
      <div class="audit-card-footer">
        <div class="audit-stats">
          <span>${completedEvents}/${a.total_instances} completed</span>
          <span>${inProgressEvents} in progress</span>
          <span>${totalNc} NC${totalNc !== 1 ? 's' : ''}${totalOpenNc > 0 ? ` (${totalOpenNc} open)` : ''}</span>
        </div>
        ${actionMenu([
          { label: '&#128279; Links', onclick: `toggleAuditLinks(${a.id})` },
          { label: '&#9998; Edit Config', onclick: `openAuditModal(${a.id})` },
          'sep',
          { label: '&#128465; Delete All', onclick: `deleteAudit(${a.id})`, cls: 'danger' },
        ])}
      </div>
      ${eventsHtml}
      <div id="audit-links-${a.id}"></div>
    </div>`;
  }).join('');
}

function toggleAuditLinks(id) {
  const el = document.getElementById(`audit-links-${id}`);
  if (el.innerHTML) { el.innerHTML = ''; return; }
  renderCrossLinks('audit', id, `audit-links-${id}`);
}

function toggleAuditChildren(id) {
  const el = document.getElementById(`audit-children-${id}`);
  const toggle = document.getElementById(`audit-toggle-${id}`);
  if (el.classList.contains('collapsed')) {
    el.classList.remove('collapsed');
    toggle.innerHTML = '&#9650;';
  } else {
    el.classList.add('collapsed');
    toggle.innerHTML = '&#9660;';
  }
}

function renderAuditGantt(audits) {
  const wrap = document.getElementById('audit-gantt-wrap');
  const today = new Date().toISOString().split('T')[0];
  const todayDate = new Date(today + 'T12:00:00');
  const todayMonth = todayDate.getFullYear() === auditYear ? todayDate.getMonth() : -1;
  const todayDayOfMonth = todayDate.getDate();
  const shortMonths = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Flatten all audit events for the timeline (including all instances)
  const allEvents = [];
  for (const a of audits) {
    if (a.all_events && a.all_events.length > 0) {
      for (const ev of a.all_events) {
        allEvents.push({
          ...ev,
          parent_title: a.title,
          display_title: a.total_instances > 1 ? `${a.title} #${ev.instance_number || 1}` : a.title
        });
      }
    } else {
      allEvents.push({
        ...a,
        parent_title: a.title,
        display_title: a.title
      });
    }
  }

  // Filter events that fall within the selected year
  const yearEvents = allEvents.filter(ev => {
    const d = ev.planned_date || ev.created_at?.split(' ')[0];
    if (!d) return false;
    return d.startsWith(String(auditYear));
  });

  if (yearEvents.length === 0) {
    wrap.innerHTML = `<div class="empty-state" style="padding:20px">No audit events planned for ${auditYear}</div>`;
    return;
  }

  // Sort events by planned date
  yearEvents.sort((a, b) => (a.planned_date || '').localeCompare(b.planned_date || ''));

  let html = '<table class="gantt-table"><thead><tr><th>Audit Event</th>';
  for (let m = 0; m < 12; m++) html += `<th>${shortMonths[m]}</th>`;
  html += '</tr></thead><tbody>';

  for (const ev of yearEvents) {
    const plannedDate = ev.planned_date || ev.created_at?.split(' ')[0];
    const plannedMonth = plannedDate ? parseInt(plannedDate.split('-')[1]) - 1 : -1;
    const completedDate = ev.completed_date;
    const completedMonth = completedDate ? parseInt(completedDate.split('-')[1]) - 1 : -1;

    const statusColor = ev.status === 'completed' ? 'completed' : ev.status === 'in_progress' ? 'due' : ev.status === 'cancelled' ? '' : (plannedDate && plannedDate < today ? 'overdue' : 'due');

    html += `<tr><td title="${esc(ev.display_title)}">${esc(ev.display_title)}</td>`;
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
  document.getElementById('audit-recurrence-end-group').classList.add('hidden');

  // Dynamically populate standards and other dropdowns
  const [activeStandards, archRoles, archProcesses] = await Promise.all([
    api('/api/requirements/standards'),
    api('/api/architecture?arch_type=role'),
    api('/api/architecture?arch_type=process'),
  ]);
  let editStandards = [];

  // Populate standards picker with checkboxes
  const stdPicker = document.getElementById('audit-standards-picker');
  stdPicker.innerHTML = activeStandards.length === 0
    ? '<span style="font-size:12px;color:var(--text-muted)">No standards imported. Import templates in Requirements view first.</span>'
    : activeStandards.map(s => `<label class="arch-picker-item"><input type="checkbox" name="audit-std" value="${esc(s)}" onchange="onAuditStandardsChange()"> ${esc(s)}</label>`).join('');

  // Populate lead auditor dropdown from roles
  const leadSel = document.getElementById('audit-lead');
  leadSel.innerHTML = '<option value="">-- Select Role --</option>' + archRoles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');

  // Populate scope processes as checkboxes with auto-select handler
  const scopeWrap = document.getElementById('audit-scope-processes');
  scopeWrap.innerHTML = archProcesses.length === 0
    ? '<span style="font-size:12px;color:var(--text-muted)">No processes defined in Architecture.</span>'
    : archProcesses.map(p => `<label class="arch-picker-item"><input type="checkbox" name="audit-scope-proc" value="${p.id}" data-name="${esc(p.name)}" onchange="onAuditProcessChange(this)"> ${esc(p.name)}</label>`).join('');

  // Populate auditee dropdown from roles
  const auditeeSel = document.getElementById('audit-auditee');
  auditeeSel.innerHTML = '<option value="">-- Select Role --</option>' + archRoles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');

  if (id) {
    const a = await api(`/api/audits/${id}`);
    try { editStandards = JSON.parse(a.standards || '[]'); } catch(e) { editStandards = a.standard ? [a.standard] : []; }
    document.getElementById('audit-modal-title').textContent = 'Edit Audit';
    document.getElementById('audit-id').value = a.id;
    document.getElementById('audit-title').value = a.title;
    leadSel.value = a.lead_auditor || '';
    auditeeSel.value = a.auditee || '';

    // Check standards
    editStandards.forEach(s => {
      const cb = stdPicker.querySelector(`input[value="${s}"]`);
      if (cb) cb.checked = true;
    });

    // Check scope processes from cross-links
    const auditLinks = await api(`/api/cross-links/audit/${id}`);
    auditLinks.filter(l => l.type === 'process').forEach(l => {
      const cb = scopeWrap.querySelector(`input[value="${l.id}"]`);
      if (cb) cb.checked = true;
    });
    document.getElementById('audit-planned-date').value = a.planned_date || '';
    document.getElementById('audit-recurrence').value = a.recurrence || 'none';
    if (a.recurrence && a.recurrence !== 'none') {
      document.getElementById('audit-recurrence-end-group').classList.remove('hidden');
      document.getElementById('audit-recurrence-end').value = a.recurrence_end_date || '';
    }
    document.getElementById('audit-status-field').value = a.status;
    document.getElementById('audit-summary').value = a.summary || '';
    document.getElementById('audit-status-group').classList.remove('hidden');
    document.getElementById('audit-summary-group').classList.remove('hidden');
  } else if (activeStandards.length > 0) {
    // Default to first standard for new audits
    const firstCb = stdPicker.querySelector('input[name="audit-std"]');
    if (firstCb) firstCb.checked = true;
  }

  // Load requirements picker based on selected standards
  await populateAuditReqPicker(id);

  modal.classList.remove('hidden');
}

function toggleAuditRecurrenceEnd() {
  const recurrence = document.getElementById('audit-recurrence').value;
  if (recurrence === 'none') {
    document.getElementById('audit-recurrence-end-group').classList.add('hidden');
  } else {
    document.getElementById('audit-recurrence-end-group').classList.remove('hidden');
  }
}

function onAuditStandardsChange() {
  const auditId = document.getElementById('audit-id').value;
  populateAuditReqPicker(auditId || null);
}

async function populateAuditReqPicker(auditId) {
  // Get all selected standards
  const selectedStandards = [...document.querySelectorAll('#audit-standards-picker input[name="audit-std"]:checked')].map(cb => cb.value);
  if (selectedStandards.length === 0) {
    document.getElementById('audit-req-checklist').innerHTML = '<div class="empty-state" style="padding:12px;font-size:13px">Select at least one standard to see requirements.</div>';
    document.getElementById('audit-req-count').textContent = '';
    auditReqProcessMap = {};
    return;
  }

  // Fetch requirements for all selected standards
  const allReqs = await api('/api/requirements');
  const reqs = allReqs.filter(r => selectedStandards.includes(r.standard));
  const container = document.getElementById('audit-req-checklist');

  // If editing, find which clauses already have checklist items
  let existingClauses = [];
  let existingStandards = [];
  if (auditId) {
    const audit = await api(`/api/audits/${auditId}`);
    existingClauses = audit.checklist.map(c => c.clause);
    existingStandards = audit.checklist.map(c => c.standard);
  }

  if (reqs.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:12px;font-size:13px">No requirements found for this standard. Import a template in the Requirements view first.</div>';
    document.getElementById('audit-req-count').textContent = '';
    auditReqProcessMap = {};
    return;
  }

  // Fetch cross-links for all requirements to build process mapping
  auditReqProcessMap = {};
  const linkPromises = reqs.map(async r => {
    const links = await api(`/api/cross-links/requirement/${r.id}`);
    const processIds = links.filter(l => l.type === 'process').map(l => l.id);
    if (processIds.length > 0) {
      auditReqProcessMap[r.id] = processIds;
    }
  });
  await Promise.all(linkPromises);

  // Group by standard first, then by category
  const standardGroups = {};
  for (const r of reqs) {
    if (!standardGroups[r.standard]) standardGroups[r.standard] = {};
    const cat = r.category || 'Uncategorized';
    if (!standardGroups[r.standard][cat]) standardGroups[r.standard][cat] = [];
    standardGroups[r.standard][cat].push(r);
  }

  let html = '';
  for (const [std, catGroups] of Object.entries(standardGroups)) {
    // Add standard header if multiple standards selected
    if (selectedStandards.length > 1) {
      html += `<div class="req-picker-standard" style="font-size:12px;font-weight:700;padding:8px 12px;background:var(--primary);color:#fff;position:sticky;top:0;z-index:2">${esc(std)}</div>`;
    }
    for (const [cat, items] of Object.entries(catGroups)) {
      html += `<div class="req-picker-category">${esc(cat)}</div>`;
      for (const r of items) {
        const alreadyAdded = existingClauses.includes(r.clause) && existingStandards.includes(r.standard);
        const linkedProcesses = auditReqProcessMap[r.id] || [];
        const processHint = linkedProcesses.length > 0 ? ` data-processes="${linkedProcesses.join(',')}"` : '';
        html += `<label class="req-picker-item${alreadyAdded ? ' already-added' : ''}"${processHint} data-standard="${esc(r.standard)}">
          <input type="checkbox" name="audit_req_ids" value="${r.id}" ${alreadyAdded ? 'disabled checked' : ''} onchange="updateAuditReqCount()">
          <span class="req-picker-clause">${esc(r.clause)}</span>
          <span class="req-picker-title">${esc(r.title)}</span>
          ${selectedStandards.length > 1 ? `<span style="font-size:9px;color:var(--text-muted);flex-shrink:0">[${esc(r.standard.replace('ISO ',''))}]</span>` : ''}
          ${linkedProcesses.length > 0 ? `<span style="font-size:10px;color:var(--primary);flex-shrink:0" title="Linked to process(es)">&#128260;</span>` : ''}
          ${alreadyAdded ? '<span class="badge badge-low" style="font-size:10px;flex-shrink:0">already added</span>' : ''}
        </label>`;
      }
    }
  }
  container.innerHTML = html;
  updateAuditReqCount();

  // Auto-select requirements for already checked processes
  document.querySelectorAll('#audit-scope-processes input[name="audit-scope-proc"]:checked').forEach(cb => {
    onAuditProcessChange(cb);
  });
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


// Store requirement-to-process mapping for auto-selection
let auditReqProcessMap = {}; // { reqId: [processId, ...] }

async function onAuditProcessChange(checkbox) {
  const processId = parseInt(checkbox.value);
  const isChecked = checkbox.checked;

  // Find all requirements linked to this process and auto-select/deselect them
  for (const [reqIdStr, processIds] of Object.entries(auditReqProcessMap)) {
    if (processIds.includes(processId)) {
      const reqCheckbox = document.querySelector(`#audit-req-checklist input[name="audit_req_ids"][value="${reqIdStr}"]:not(:disabled)`);
      if (reqCheckbox) {
        if (isChecked) {
          reqCheckbox.checked = true;
        }
        // Note: We don't auto-uncheck when process is deselected, as user may have manually selected it
      }
    }
  }
  updateAuditReqCount();
}

function closeAuditModal() {
  document.getElementById('audit-modal').classList.add('hidden');
}

async function saveAudit(e) {
  e.preventDefault();
  const id = document.getElementById('audit-id').value;
  const selectedStandards = [...document.querySelectorAll('#audit-standards-picker input[name="audit-std"]:checked')].map(cb => cb.value);
  if (selectedStandards.length === 0) {
    alert('Please select at least one standard.');
    return;
  }
  const body = {
    title: document.getElementById('audit-title').value,
    standards: selectedStandards,
    standard: selectedStandards[0], // Primary standard for backwards compatibility
    lead_auditor: document.getElementById('audit-lead').value,
    auditee: document.getElementById('audit-auditee').value,
    planned_date: document.getElementById('audit-planned-date').value || null,
    recurrence: document.getElementById('audit-recurrence').value,
    recurrence_end_date: document.getElementById('audit-recurrence-end').value || null,
  };

  // Collect selected requirement IDs (only non-disabled = new selections)
  const selectedReqIds = [...document.querySelectorAll('#audit-req-checklist input[name="audit_req_ids"]:checked:not(:disabled)')].map(cb => parseInt(cb.value));
  if (selectedReqIds.length > 0) {
    body.requirement_ids = selectedReqIds;
  }

  let auditId = id;
  if (id) {
    body.status = document.getElementById('audit-status-field').value;
    body.summary = document.getElementById('audit-summary').value;
    await api(`/api/audits/${id}`, { method: 'PUT', body });
  } else {
    const result = await api('/api/audits', { method: 'POST', body });
    auditId = result.id;
  }
  // Auto-link selected scope processes
  if (auditId) {
    const selectedProcs = [...document.querySelectorAll('#audit-scope-processes input[name="audit-scope-proc"]:checked')].map(cb => parseInt(cb.value));
    for (const procId of selectedProcs) {
      await api('/api/cross-links', { method: 'POST', body: { source_type: 'audit', source_id: parseInt(auditId), target_type: 'process', target_id: procId } });
    }
  }
  closeAuditModal();
  refreshCurrentView();
}
