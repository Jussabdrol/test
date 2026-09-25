// Individual executions and follow-up actions share one workspace and filter state.
let workTab = 'tickets';
let workFilters = { search: '', assignee: '', priority: '', series: '' };
let workTicketStatus = 'pending';
let workActionStatus = 'active';
let workDates = { from: '', to: '' };
let workCompletedBy = '';
let workActionSource = null;
let workSeries = [];
let workRoles = [];
let workTickets = null;
let workActions = null;
let workspaceRequest = 0;
let workPanelRequest = 0;
let ticketDetailRequest = 0;
let workSourceRequest = 0;
const WORK_TICKET_LIMIT = 2000;

async function loadOperationalTasks() {
  const request = ++workspaceRequest;
  workPanelRequest++;
  workTickets = workActions = null;
  renderWorkChrome();
  workLoading();
  try {
    const [series, roles] = await Promise.all([api('/api/tasks'), api('/api/architecture?arch_type=role')]);
    if (request !== workspaceRequest || currentView !== 'operational-tasks') return;
    workSeries = series;
    workRoles = roles;
    renderWorkFilters();
    await reloadWorkPanel();
  } catch (error) {
    if (request === workspaceRequest && currentView === 'operational-tasks') workError(error);
  }
}

function renderWorkChrome() {
  selectExperienceTab('work', workTab);
  const focused = workTab === 'followups' && workActionSource;
  document.getElementById('work-filter-panel').hidden = Boolean(focused);
  document.getElementById('work-new-action').hidden = workTab !== 'followups';
  document.getElementById('work-ticket-status').value = workTicketStatus;
  document.getElementById('work-from').value = workDates.from;
  document.getElementById('work-to').value = workDates.to;
  document.getElementById('work-completer-field').hidden = workTicketStatus !== 'completed';
  document.getElementById('work-completer').value = workCompletedBy;
  const status = document.getElementById('work-action-status');
  status.value = focused ? '' : workActionStatus;
  status.disabled = Boolean(focused);
  const banner = document.getElementById('work-source-banner');
  banner.hidden = !focused;
  banner.innerHTML = focused ? `<div><strong>Follow-ups for control ticket #${workActionSource.id}</strong>
    <p>${esc(workActionSource.task_title)} · Scheduled ${esc(workActionSource.scheduled_date)}</p>
    <small>All actions for this ticket. Your workspace filters are preserved.</small></div>
    <div class="work-inline-actions"><button type="button" class="btn btn-secondary btn-sm" onclick="openControlTicket(${workActionSource.id})">View control ticket</button>
    <button type="button" class="btn btn-secondary btn-sm" onclick="clearWorkSource()">Back to all follow-ups</button></div>` : '';
}

function renderWorkFilters() {
  const roles = [...new Set([...workRoles.map(r => r.name), ...workSeries.map(t => t.assignee), workFilters.assignee].filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  document.getElementById('work-filters').innerHTML = `
    <label class="planning-field planning-search">Search<input type="search" placeholder="Search tickets or actions…" value="${esc(workFilters.search)}" oninput="workFilters.search=this.value;renderWorkPanel()"></label>
    <label class="planning-field">Series<select onchange="workFilters.series=this.value;reloadWorkPanel()"><option value="">All series</option>${workSeries.map(t=>`<option value="${t.id}" ${String(t.id)===workFilters.series?'selected':''}>${esc(t.title)}${t.is_active?'':' (inactive)'}</option>`).join('')}</select></label>
    <label class="planning-field">Role<select onchange="workFilters.assignee=this.value;renderWorkPanel()"><option value="">All roles</option>${roles.map(name=>`<option value="${esc(name)}" ${name===workFilters.assignee?'selected':''}>${esc(name)}</option>`).join('')}</select></label>
    <label class="planning-field">Priority<select onchange="workFilters.priority=this.value;renderWorkPanel()"><option value="">All priorities</option>${['Low','Medium','High','Critical'].map(p=>`<option ${p===workFilters.priority?'selected':''}>${p}</option>`).join('')}</select></label>
    <button type="button" class="btn btn-secondary" onclick="resetWorkFilters()">Reset filters</button>`;
}

async function selectWorkTab(tab) {
  if (!['tickets','followups'].includes(tab)) return;
  workSourceRequest++;
  workTab = tab;
  renderWorkChrome();
  await reloadWorkPanel();
}

function reloadWorkPanel() {
  renderWorkChrome();
  return workTab === 'tickets' ? loadWorkTickets() : loadWorkActions();
}

function renderWorkPanel() {
  if (workTab === 'tickets') renderWorkTickets();
  else renderWorkActions();
}

async function resetWorkFilters() {
  workFilters = { search:'', assignee:'', priority:'', series:'' };
  workDates = { from:'', to:'' };
  workTicketStatus = 'pending';
  workActionStatus = 'active';
  workCompletedBy = '';
  workActionSource = null;
  opPlanContext = { type:'all', id:null };
  renderOpPlanContextBar();
  renderWorkFilters();
  await reloadWorkPanel();
}

function matchesWorkFilters(record, ticket) {
  const role = ticket ? record.task_assignee : record.assignee;
  const priority = ticket ? record.task_priority : record.priority;
  if (workFilters.assignee && role !== workFilters.assignee) return false;
  if (workFilters.priority && priority !== workFilters.priority) return false;
  if (workFilters.series && String(record.task_id) !== workFilters.series) return false;
  const query = workFilters.search.trim().toLowerCase();
  const text = ticket ? [record.id, record.task_title, record.task_category, role, record.notes, record.completed_by, record.scheduled_date]
    : [record.id, record.title, record.description, record.task_title, record.process_name, role, record.instance_scheduled_date];
  return !query || text.some(value => String(value || '').toLowerCase().includes(query));
}

function workLoading() {
  const tickets = workTab === 'tickets';
  document.getElementById(tickets ? 'task-log-summary' : 'work-action-summary').textContent = '';
  document.getElementById(tickets ? 'task-log-table-body' : 'action-table-body').innerHTML =
    `<tr><td colspan="${tickets?7:8}" class="empty-state" role="status">Loading ${tickets?'control tickets':'follow-up actions'}…</td></tr>`;
  if (tickets) document.getElementById('work-ticket-notice').hidden = true;
}

function workError(error) {
  const tickets = workTab === 'tickets';
  document.getElementById(tickets ? 'task-log-summary' : 'work-action-summary').textContent = '';
  document.getElementById(tickets ? 'task-log-table-body' : 'action-table-body').innerHTML =
    `<tr><td colspan="${tickets?7:8}" class="empty-state" role="alert">${esc(error.message)} <button type="button" class="btn btn-secondary btn-sm" onclick="loadOperationalTasks()">Retry</button></td></tr>`;
}

async function loadWorkTickets() {
  const request = ++workPanelRequest;
  workTickets = null;
  renderWorkChrome();
  workLoading();
  const params = new URLSearchParams({limit:String(WORK_TICKET_LIMIT)});
  const status = ['overdue','today','upcoming'].includes(workTicketStatus) ? 'pending' : workTicketStatus;
  if (status) params.set('status',status);
  if (workFilters.series) params.set('task_id',workFilters.series);
  const names = getOpPlanContextNames();
  if (names?.length && names.every(name=>!name.includes(','))) params.set('categories',names.join(','));
  if (workDates.from) params.set('from',workDates.from);
  if (workDates.to) params.set('to',workDates.to);
  try {
    if (workDates.from && workDates.to && workDates.from > workDates.to) throw new Error('Choose an end date on or after the start date.');
    const rows = names && !names.length ? [] : await api(`/api/task-instances?${params}`);
    if (request !== workPanelRequest || currentView !== 'operational-tasks' || workTab !== 'tickets') return;
    const notice = document.getElementById('work-ticket-notice');
    notice.hidden = rows.length < WORK_TICKET_LIMIT;
    notice.textContent = 'The first 2,000 tickets are loaded. Choose a series or narrower scheduled dates to find further tickets; counts and search below cover the loaded tickets.';
    workTickets = names ? rows.filter(i=>names.includes(i.task_category)) : rows;
    renderWorkTickets();
  } catch (error) {
    if (request === workPanelRequest && currentView === 'operational-tasks' && workTab === 'tickets') workError(error);
  }
}

function renderWorkTickets() {
  if (!workTickets) return;
  const today = new Date().toISOString().slice(0,10);
  const rows = workTickets.filter(i=>matchesWorkFilters(i,true) &&
    (workTicketStatus !== 'overdue' || i.scheduled_date < today) &&
    (workTicketStatus !== 'today' || i.scheduled_date === today) &&
    (workTicketStatus !== 'upcoming' || i.scheduled_date > today) &&
    (workTicketStatus !== 'completed' || !workCompletedBy.trim() || (i.completed_by || '').toLowerCase().includes(workCompletedBy.trim().toLowerCase())));
  const open = rows.filter(i=>i.status==='pending');
  document.getElementById('task-log-summary').innerHTML = `<div class="task-log-summary-chips">
    <span class="tl-chip">${rows.length} tickets shown</span>
    <span class="tl-chip tl-chip-overdue">${open.filter(i=>i.scheduled_date<today).length} overdue</span>
    <span class="tl-chip">${open.filter(i=>i.scheduled_date===today).length} due today</span>
    <span class="tl-chip">${rows.filter(i=>i.status==='completed').length} completed</span>
  </div>`;
  renderTaskLogTable(rows);
}

async function loadWorkActions() {
  const request = ++workPanelRequest;
  workActions = null;
  workLoading();
  const params = new URLSearchParams();
  let bundleIds = null;
  if (workActionSource) params.set('instance_id',workActionSource.id);
  else {
    if (workFilters.series) params.set('task_id',workFilters.series);
    if (opPlanContext.type === 'process') params.set('process_id',opPlanContext.id);
    if (opPlanContext.type === 'bundle') {
      const bundle = opPlanBundles.find(b=>b.id===opPlanContext.id);
      bundleIds = bundle ? JSON.parse(bundle.process_ids || '[]') : [];
      if (bundleIds.length) params.set('process_ids',bundleIds.join(','));
    }
  }
  try {
    const rows = bundleIds && !bundleIds.length ? [] : await api(`/api/actions?${params}`);
    if (request !== workPanelRequest || currentView !== 'operational-tasks' || workTab !== 'followups') return;
    workActions = rows;
    renderWorkActions();
  } catch (error) {
    if (request === workPanelRequest && currentView === 'operational-tasks' && workTab === 'followups') workError(error);
  }
}

function renderWorkActions() {
  if (!workActions) return;
  const active = action=>['open','in_progress'].includes(action.status);
  const rows = workActions.filter(a=>workActionSource || (matchesWorkFilters(a,false) &&
    (!workActionStatus || (workActionStatus==='active' ? active(a) : a.status===workActionStatus))));
  const today = new Date().toISOString().slice(0,10);
  rows.sort((a,b)=>Number(active(b))-Number(active(a)) || (a.due_date || '9999').localeCompare(b.due_date || '9999') || b.id-a.id);
  document.getElementById('work-action-summary').textContent = `${rows.length} actions shown · ${rows.filter(active).length} open / in progress · ${rows.filter(a=>active(a)&&a.due_date&&a.due_date<today).length} overdue`;
  renderActionTable(rows);
}

async function viewInstanceActions(instanceId) {
  const request = ++workSourceRequest;
  try {
    const instance = await api(`/api/task-instances/${Number(instanceId)}`);
    if (request !== workSourceRequest) return;
    closeControlTicket();
    workActionSource = instance;
    workTab = 'followups';
    await switchView('operational-tasks');
  } catch (error) { showToast('Could not open follow-ups: '+error.message,'error'); }
}

async function clearWorkSource() {
  workSourceRequest++;
  workActionSource = null;
  renderWorkChrome();
  await loadWorkActions();
}

function newWorkspaceAction() {
  return workActionSource ? createFollowUpForInstance(workActionSource.id,workActionSource.task_id) : openActionModal();
}

function viewCompletedTicketActions() {
  const id = lastInstanceContext?.instance_id;
  if (!id) return;
  closePostCompleteModal();
  return viewInstanceActions(id);
}

function closeControlTicket() {
  ticketDetailRequest++;
  const dialog = document.getElementById('control-ticket-dialog');
  if (dialog?.open) dialog.close();
}

async function openControlTicket(id) {
  if (!Number.isSafeInteger(Number(id)) || Number(id)<1 || !hasPermissionForView('operational-tasks')) return;
  const request = ++ticketDetailRequest;
  const dialog = document.getElementById('control-ticket-dialog');
  const content = document.getElementById('control-ticket-content');
  document.getElementById('control-ticket-title').textContent = `Control ticket #${id}`;
  content.innerHTML = '<p role="status">Loading control ticket…</p>';
  if (!dialog.open) dialog.showModal();
  try {
    const [ticket, actions] = await Promise.all([api(`/api/task-instances/${id}`),api(`/api/actions?instance_id=${id}`)]);
    if (request !== ticketDetailRequest || !dialog.open) return;
    let evidence = [];
    try { evidence = JSON.parse(ticket.evidence_files || '[]'); } catch (_error) { /* retain ticket without invalid evidence metadata */ }
    content.innerHTML = `<h3>${esc(ticket.task_title)}</h3>
      <dl class="work-ticket-facts"><div><dt>Scheduled</dt><dd>${esc(ticket.scheduled_date)}</dd></div><div><dt>Status</dt><dd>${esc({pending:'Open',completed:'Completed',skipped:'Skipped'}[ticket.status] || ticket.status)}</dd></div>
      <div><dt>Role</dt><dd>${esc(ticket.task_assignee || 'Unassigned')}</dd></div><div><dt>Process</dt><dd>${esc(ticket.task_category || 'General')}</dd></div>
      ${ticket.completed_at?`<div><dt>Completed</dt><dd>${esc(String(ticket.completed_at).slice(0,10))}${ticket.completed_by?' · '+esc(ticket.completed_by):''}</dd></div>`:''}</dl>
      <h4>Notes</h4><p class="work-ticket-notes">${esc(ticket.notes || 'No notes recorded yet.')}</p>
      <h4>Evidence (${evidence.length})</h4><div class="work-evidence">${evidence.length ? evidence.map(file=>`<a href="/api/task-instances/${ticket.id}/evidence/${Number(file.id)}/download" target="_blank" rel="noopener">${esc(file.name)}</a>`).join('') : '<p>No evidence attached yet.</p>'}</div>
      <h4>Follow-up actions</h4><p>${actions.length} total · ${actions.filter(a=>['open','in_progress'].includes(a.status)).length} open / in progress</p>
      <div class="work-inline-actions">
        ${ticket.status==='pending' ? `<button type="button" class="btn btn-primary" onclick="closeControlTicket();openInstanceCompleteModal(${ticket.id})">Complete control</button><button type="button" class="btn btn-secondary" onclick="skipInstance(${ticket.id})">Skip</button>` : `<button type="button" class="btn btn-secondary" onclick="reopenInstance(${ticket.id})">Reopen</button>`}
        <button type="button" class="btn btn-secondary" onclick="closeControlTicket();createFollowUpForInstance(${ticket.id},${ticket.task_id})">+ New follow-up</button>
        <button type="button" class="btn btn-secondary" onclick="viewInstanceActions(${ticket.id})">View follow-ups</button>
        <button type="button" class="btn btn-secondary" onclick="closeControlTicket();openTaskDetailModal(${ticket.task_id})">View series</button>
      </div>`;
  } catch (error) {
    if (request===ticketDetailRequest && dialog.open) content.innerHTML=`<p role="alert">Could not load ticket: ${esc(error.message)}</p><button type="button" class="btn btn-secondary" onclick="openControlTicket(${Number(id)})">Retry</button>`;
  }
}
