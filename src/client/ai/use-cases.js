
// --- Use Cases ---
// ===== AI Use Cases – Kanban Board =====

const UC_STAGES = [
  { id: 'new',         label: 'New',             color: '#6b7280' },
  { id: 'assessment',  label: 'Under Assessment', color: '#f59e0b' },
  { id: 'approved',    label: 'Approved',         color: '#3b82f6' },
  { id: 'development', label: 'In Development',   color: '#8b5cf6' },
  { id: 'production',  label: 'In Production',    color: '#10b981' },
  { id: 'retired',     label: 'Retired',          color: '#94a3b8' },
];

const UC_RISK_BADGE = { 'Minimal': 'badge-low', 'Limited': 'badge-medium', 'High': 'badge-high', 'Unacceptable': 'badge-critical' };
const UC_PRIORITY_DOT = { low: '#22c55e', medium: '#f59e0b', high: '#ef4444', critical: '#7c3aed' };
const UC_DOMAINS = ['HR','Finance','Operations','Customer Service','Legal','IT','R&D','Marketing'];
const UC_APPROACHES = ['Generative AI','Supervised Learning','Unsupervised Learning','Reinforcement Learning','RPA','Rules-based'];
const UC_RISK_TIERS = ['Minimal','Limited','High','Unacceptable'];
const UC_OVERSIGHT = ['Required','Optional','None'];
const UC_CATEGORIES = ['AI','Process Automation','Analytics','Integration','Other'];

let ucAllUsecases = [];
let ucUsersCache = null;
let ucDragId = null;

function ucApplyFilter() { renderUseCaseBoard(); }

async function loadUseCases() {
  const [cases, users] = await Promise.all([
    api('/api/use-cases'),
    ucUsersCache ? Promise.resolve(ucUsersCache) : api('/api/org-users'),
  ]);
  ucAllUsecases = cases;
  ucUsersCache = users;
  renderUseCaseBoard();
}

function ucFilteredCases() {
  const domain   = document.getElementById('uc-filter-domain')?.value   || '';
  const category = document.getElementById('uc-filter-category')?.value || '';
  const priority = document.getElementById('uc-filter-priority')?.value || '';
  return ucAllUsecases.filter(uc =>
    (!domain   || uc.business_domain === domain) &&
    (!category || uc.category === category) &&
    (!priority || uc.priority === priority)
  );
}

function renderUseCaseBoard() {
  const board = document.getElementById('uc-kanban-board');
  if (!board) return;
  const cases = ucFilteredCases();

  // Stats bar
  const statsBar = document.getElementById('uc-stats-bar');
  if (statsBar) {
    statsBar.innerHTML = UC_STAGES.map(s => {
      const count = ucAllUsecases.filter(uc => uc.status === s.id).length;
      return `<div class="uc-stat-item">
        <span class="uc-stat-count" style="color:${s.color}">${count}</span>
        <span class="uc-stat-label">${s.label}</span>
      </div>`;
    }).join('');
  }

  // Columns
  board.innerHTML = UC_STAGES.map(stage => {
    const stageCases = cases.filter(uc => uc.status === stage.id);
    return `<div class="kanban-column"
        ondragover="event.preventDefault();this.classList.add('kanban-drag-over')"
        ondragleave="this.classList.remove('kanban-drag-over')"
        ondrop="ucDropCard(event,'${stage.id}');this.classList.remove('kanban-drag-over')"
        data-stage="${stage.id}">
      <div class="kanban-col-header" style="border-top:3px solid ${stage.color}">
        <span class="kanban-col-title">${stage.label}</span>
        <span class="kanban-col-count" style="background:${stage.color}18;color:${stage.color}">${stageCases.length}</span>
      </div>
      <div class="kanban-col-body">
        ${stageCases.map(uc => ucRenderCard(uc)).join('')}
        ${stage.id === 'new' ? `<button class="kanban-add-btn" onclick="openUseCaseModal()">+ New Use Case</button>` : ''}
        ${stageCases.length === 0 && stage.id !== 'new' ? `<div class="kanban-empty">Drop here</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function ucRenderCard(uc) {
  const riskBadge = uc.risk_tier
    ? `<span class="badge ${UC_RISK_BADGE[uc.risk_tier]||'badge-inactive'}" style="font-size:10px;padding:1px 5px">${esc(uc.risk_tier)}</span>`
    : '';
  const catStyle  = uc.category === 'AI' ? 'background:#ede9fe;color:#5b21b6' : 'background:#f1f5f9;color:#475569';
  const catBadge  = uc.category
    ? `<span class="badge" style="${catStyle};font-size:10px;padding:1px 5px">${esc(uc.category)}</span>`
    : '';
  const domBadge  = uc.business_domain
    ? `<span class="badge badge-inactive" style="font-size:10px;padding:1px 5px">${esc(uc.business_domain)}</span>`
    : '';
  const dot = `<span style="width:8px;height:8px;border-radius:50%;background:${UC_PRIORITY_DOT[uc.priority]||'#6b7280'};display:inline-block;flex-shrink:0;margin-top:4px" title="Priority: ${uc.priority}"></span>`;
  const owner = uc.owner_name
    ? `<div style="font-size:11px;color:var(--text-muted);margin-top:5px">&#128100; ${esc(uc.owner_name)}</div>`
    : '';
  const desc = uc.description
    ? `<p style="font-size:11px;color:var(--text-muted);margin:4px 0 5px;line-height:1.4">${esc(uc.description.substring(0,90))}${uc.description.length>90?'…':''}</p>`
    : '';
  return `<div class="kanban-card"
      draggable="true"
      ondragstart="ucDragStart(event,${uc.id})"
      ondragend="ucDragEnd(event)"
      onclick="openUseCaseModal(${uc.id})"
      data-id="${uc.id}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px">
      <span style="font-weight:600;font-size:13px;line-height:1.35;flex:1">${esc(uc.title)}</span>
      ${dot}
    </div>
    ${desc}
    <div style="display:flex;flex-wrap:wrap;gap:3px">${catBadge}${riskBadge}${domBadge}</div>
    ${owner}
  </div>`;
}

function ucDragStart(event, id) {
  ucDragId = id;
  event.dataTransfer.effectAllowed = 'move';
  event.currentTarget.classList.add('kanban-card-dragging');
}

function ucDragEnd(event) {
  event.currentTarget.classList.remove('kanban-card-dragging');
  document.querySelectorAll('.kanban-column').forEach(c => c.classList.remove('kanban-drag-over'));
}

async function ucDropCard(event, targetStage) {
  event.preventDefault();
  if (!ucDragId) return;
  const card = ucAllUsecases.find(uc => uc.id === ucDragId);
  ucDragId = null;
  if (!card || card.status === targetStage) return;
  try {
    const updated = await api(`/api/use-cases/${card.id}/stage`, { method: 'PUT', body: { status: targetStage } });
    const idx = ucAllUsecases.findIndex(uc => uc.id === updated.id);
    if (idx !== -1) ucAllUsecases[idx] = updated;
    renderUseCaseBoard();
  } catch (err) {
    alert(err.message || 'Cannot move to this stage. Check required fields first.');
    renderUseCaseBoard();
  }
}

// ---- Modal ----

let ucModalData = null; // current use case being edited

async function openUseCaseModal(id) {
  if (!ucUsersCache) ucUsersCache = await api('/api/org-users');
  ucModalData = id ? await api(`/api/use-cases/${id}`) : null;
  const members = id ? await api(`/api/use-cases/${id}/members`) : [];
  const approvals = id ? await api(`/api/use-cases/${id}/approvals`) : [];
  ucRenderModal(ucModalData, members, approvals);
  document.getElementById('usecase-modal').classList.remove('hidden');
}

function closeUseCaseModal() {
  document.getElementById('usecase-modal').classList.add('hidden');
  ucModalData = null;
}

function ucUserOptions(selectedId) {
  const opts = (ucUsersCache || []).map(u =>
    `<option value="${u.id}" ${u.id == selectedId ? 'selected' : ''}>${esc(u.name)}${u.department ? ` (${esc(u.department)})` : ''}</option>`
  ).join('');
  return `<option value="">— None —</option>${opts}`;
}

function ucRenderModal(uc, members, approvals) {
  const isNew = !uc;
  const stage = uc?.status || 'new';
  const stageObj = UC_STAGES.find(s => s.id === stage) || UC_STAGES[0];
  const stageBadge = `<span class="badge" style="background:${stageObj.color}18;color:${stageObj.color};border:1px solid ${stageObj.color}40">${stageObj.label}</span>`;

  // Next stage button (not shown for retired or production-without-next)
  const stageIdx = UC_STAGES.findIndex(s => s.id === stage);
  const nextStage = stageIdx < UC_STAGES.length - 1 ? UC_STAGES[stageIdx + 1] : null;
  const nextBtn = (!isNew && nextStage)
    ? `<button type="button" class="btn btn-primary" onclick="ucMoveStage('${nextStage.id}')" style="background:${nextStage.color}">&#8594; Move to ${nextStage.label}</button>`
    : '';

  const membersHtml = members.map(m =>
    `<span class="uc-member-chip">&#128100; ${esc(m.name)}<button type="button" onclick="ucRemoveMember(${uc?.id},${m.user_id})" title="Remove">&times;</button></span>`
  ).join('') || '<span style="color:var(--text-muted);font-size:12px">No members yet</span>';

  const approvalsHtml = approvals.length ? `
    <div class="uc-approvals-list">
      ${approvals.map(a => `
        <div class="uc-approval-item">
          <span class="badge ${a.decision==='approved'?'badge-active':a.decision==='rejected'?'badge-high':'badge-medium'}">${a.decision}</span>
          <span style="font-size:12px;margin-left:6px"><strong>${esc(a.approver_name||'Unknown')}</strong></span>
          ${a.notes ? `<span style="font-size:12px;color:var(--text-muted);margin-left:6px">${esc(a.notes)}</span>` : ''}
          <span style="font-size:11px;color:var(--text-muted);margin-left:auto">${a.created_at ? new Date(a.created_at).toLocaleDateString() : ''}</span>
        </div>`).join('')}
    </div>` : '';

  document.getElementById('usecase-modal-content').innerHTML = `
    <div class="modal-header" style="align-items:flex-start;gap:12px">
      <div style="flex:1">
        <input type="text" id="uc-title" value="${isNew?'':esc(uc.title)}" placeholder="Use case title *" required
          style="font-size:18px;font-weight:700;border:none;border-bottom:2px solid var(--border);border-radius:0;width:100%;padding:4px 0;background:transparent;outline:none">
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
        ${isNew?'':stageBadge}
        <button class="modal-close" onclick="closeUseCaseModal()">&times;</button>
      </div>
    </div>

    <div class="modal-body" style="overflow-y:auto;max-height:70vh;padding:0 24px 8px">

      <!-- OVERVIEW -->
      <div class="uc-section">
        <div class="uc-section-title">Overview</div>
        <div class="form-group">
          <label>Description</label>
          <textarea id="uc-description" rows="2" placeholder="What problem does this solve?">${isNew?'':esc(uc.description||'')}</textarea>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Category</label>
            <select id="uc-category">
              ${UC_CATEGORIES.map(c=>`<option value="${c}" ${uc?.category===c?'selected':''}>${c}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Business Domain</label>
            <select id="uc-domain">
              <option value="">— None —</option>
              ${UC_DOMAINS.map(d=>`<option value="${d}" ${uc?.business_domain===d?'selected':''}>${d}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>AI Approach</label>
            <select id="uc-approach">
              <option value="">— None —</option>
              ${UC_APPROACHES.map(a=>`<option value="${a}" ${uc?.ai_approach===a?'selected':''}>${a}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Priority</label>
            <select id="uc-priority">
              <option value="low"      ${uc?.priority==='low'      ?'selected':''}>Low</option>
              <option value="medium"   ${(!uc||uc.priority==='medium')?'selected':''}>Medium</option>
              <option value="high"     ${uc?.priority==='high'     ?'selected':''}>High</option>
              <option value="critical" ${uc?.priority==='critical' ?'selected':''}>Critical</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Business Value</label>
          <textarea id="uc-business-value" rows="2" placeholder="Expected business value or outcomes">${isNew?'':esc(uc.business_value||'')}</textarea>
        </div>
      </div>

      <!-- PEOPLE -->
      <div class="uc-section">
        <div class="uc-section-title">People &amp; Ownership</div>
        <div class="form-row">
          <div class="form-group">
            <label>Business Owner / Sponsor</label>
            <select id="uc-owner">${ucUserOptions(uc?.owner_id)}</select>
          </div>
          <div class="form-group">
            <label>Implementation Owner</label>
            <select id="uc-impl-owner">${ucUserOptions(uc?.implementation_owner_id)}</select>
          </div>
        </div>
        ${!isNew ? `
        <div class="form-group">
          <label>Team Members</label>
          <div id="uc-members-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">${membersHtml}</div>
          <div style="display:flex;gap:8px">
            <select id="uc-add-member-sel" style="flex:1">
              <option value="">Add member…</option>
              ${(ucUsersCache||[]).filter(u=>!members.find(m=>m.user_id===u.id)).map(u=>`<option value="${u.id}">${esc(u.name)}</option>`).join('')}
            </select>
            <button type="button" class="btn btn-secondary btn-sm" onclick="ucAddMember(${uc?.id})">Add</button>
          </div>
        </div>` : ''}
      </div>

      <!-- ASSESSMENT -->
      <div class="uc-section">
        <div class="uc-section-title">Risk &amp; Assessment</div>
        <div class="form-row">
          <div class="form-group">
            <label>Risk Tier (EU AI Act)</label>
            <select id="uc-risk-tier">
              <option value="">— Not assessed —</option>
              ${UC_RISK_TIERS.map(t=>`<option value="${t}" ${uc?.risk_tier===t?'selected':''}>${t}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Human Oversight</label>
            <select id="uc-oversight">
              <option value="">— Not set —</option>
              ${UC_OVERSIGHT.map(o=>`<option value="${o}" ${uc?.human_oversight===o?'selected':''}>${o}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Fallback Process (if use case fails)</label>
          <textarea id="uc-fallback" rows="2" placeholder="What happens if this use case is unavailable?">${isNew?'':esc(uc.fallback_process||'')}</textarea>
        </div>
        <div class="form-group">
          <label>Success KPIs</label>
          <textarea id="uc-kpis" rows="2" placeholder="How will success be measured?">${isNew?'':esc(uc.success_kpis||'')}</textarea>
        </div>
      </div>

      <!-- GOVERNANCE -->
      <div class="uc-section">
        <div class="uc-section-title">Governance &amp; Approval</div>
        <div class="form-row">
          <div class="form-group">
            <label>Approved By</label>
            <select id="uc-approved-by">${ucUserOptions(uc?.approved_by_id)}</select>
          </div>
          <div class="form-group">
            <label>Approval Date</label>
            <input type="date" id="uc-approval-date" value="${uc?.approval_date||''}">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Target Go-Live</label>
            <input type="date" id="uc-target-live" value="${uc?.target_go_live||''}">
          </div>
          <div class="form-group">
            <label>Next Review Date</label>
            <input type="date" id="uc-review-date" value="${uc?.next_review_date||''}">
          </div>
        </div>
        ${!isNew ? `
        <details style="margin-top:8px">
          <summary style="cursor:pointer;font-size:12px;color:var(--text-muted);user-select:none">Approval History (${approvals.length})</summary>
          ${approvalsHtml || '<p style="font-size:12px;color:var(--text-muted);margin:8px 0 0">No approval records yet.</p>'}
          <div style="display:flex;gap:8px;margin-top:8px">
            <select id="uc-approval-user" style="flex:1">${ucUserOptions(null)}</select>
            <select id="uc-approval-decision" style="width:110px">
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
            <input type="text" id="uc-approval-notes" placeholder="Notes" style="flex:2;min-width:0">
            <button type="button" class="btn btn-secondary btn-sm" onclick="ucRecordApproval(${uc?.id})">Record</button>
          </div>
        </details>` : ''}
      </div>

      <!-- PRODUCTION -->
      <div class="uc-section">
        <div class="uc-section-title">Production &amp; Monitoring</div>
        <div class="form-row">
          <div class="form-group">
            <label>Go-Live Date</label>
            <input type="date" id="uc-go-live" value="${uc?.go_live_date||''}">
          </div>
          <div class="form-group">
            <label>Incident Reporting Active</label>
            <select id="uc-incident">
              <option value="0" ${!uc?.incident_reporting?'selected':''}>No</option>
              <option value="1" ${uc?.incident_reporting?'selected':''}>Yes</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Performance Notes</label>
          <textarea id="uc-perf-notes" rows="2" placeholder="Observations, metrics, issues in production">${isNew?'':esc(uc.performance_notes||'')}</textarea>
        </div>
        ${!isNew && stage === 'retired' ? `
        <div class="form-group">
          <label>Retirement Reason</label>
          <textarea id="uc-retire-reason" rows="2">${esc(uc.retirement_reason||'')}</textarea>
        </div>` : ''}
      </div>

      <!-- LINKED ITEMS -->
      ${!isNew ? `
      <div class="uc-section">
        <div class="uc-section-title">Linked Architectural Items</div>
        <div id="uc-crosslinks-${uc.id}"></div>
      </div>` : ''}

    </div><!-- end modal-body -->

    <div class="modal-footer" style="display:flex;justify-content:space-between;align-items:center;padding:12px 24px;border-top:1px solid var(--border);flex-wrap:wrap;gap:8px">
      <div style="display:flex;gap:8px">
        ${!isNew ? `<button type="button" class="btn btn-secondary" style="color:var(--danger)" onclick="ucDelete(${uc.id})">Delete</button>` : ''}
      </div>
      <div style="display:flex;gap:8px">
        <button type="button" class="btn btn-secondary" onclick="closeUseCaseModal()">Cancel</button>
        <button type="button" class="btn btn-primary" onclick="ucSave(${isNew?'null':uc.id})">Save</button>
        ${nextBtn}
      </div>
    </div>`;

  // Load cross-links after render
  if (!isNew) {
    setTimeout(() => renderCrossLinks('usecase', uc.id, `uc-crosslinks-${uc.id}`), 0);
  }
}

async function ucSave(id) {
  const title = document.getElementById('uc-title').value.trim();
  if (!title) { alert('Title is required'); return; }
  const body = {
    title,
    description:             document.getElementById('uc-description').value.trim(),
    category:                document.getElementById('uc-category').value,
    business_domain:         document.getElementById('uc-domain').value,
    ai_approach:             document.getElementById('uc-approach').value,
    priority:                document.getElementById('uc-priority').value,
    business_value:          document.getElementById('uc-business-value').value.trim(),
    owner_id:                document.getElementById('uc-owner').value || null,
    implementation_owner_id: document.getElementById('uc-impl-owner').value || null,
    risk_tier:               document.getElementById('uc-risk-tier').value,
    human_oversight:         document.getElementById('uc-oversight').value,
    fallback_process:        document.getElementById('uc-fallback').value.trim(),
    success_kpis:            document.getElementById('uc-kpis').value.trim(),
    approved_by_id:          document.getElementById('uc-approved-by').value || null,
    approval_date:           document.getElementById('uc-approval-date').value || null,
    target_go_live:          document.getElementById('uc-target-live').value || null,
    next_review_date:        document.getElementById('uc-review-date').value || null,
    go_live_date:            document.getElementById('uc-go-live').value || null,
    incident_reporting:      document.getElementById('uc-incident').value,
    performance_notes:       document.getElementById('uc-perf-notes').value.trim(),
  };
  const retireEl = document.getElementById('uc-retire-reason');
  if (retireEl) body.retirement_reason = retireEl.value.trim();

  try {
    let updated;
    if (id) {
      updated = await api(`/api/use-cases/${id}`, { method: 'PUT', body });
      const idx = ucAllUsecases.findIndex(uc => uc.id === updated.id);
      if (idx !== -1) ucAllUsecases[idx] = updated;
    } else {
      updated = await api('/api/use-cases', { method: 'POST', body });
      ucAllUsecases.push(updated);
    }
    closeUseCaseModal();
    renderUseCaseBoard();
  } catch (err) {
    alert(err.message || 'Failed to save');
  }
}

async function ucMoveStage(targetStage) {
  if (!ucModalData) return;
  // Save current edits first
  await ucSave(ucModalData.id);
  try {
    const updated = await api(`/api/use-cases/${ucModalData.id}/stage`, { method: 'PUT', body: { status: targetStage } });
    const idx = ucAllUsecases.findIndex(uc => uc.id === updated.id);
    if (idx !== -1) ucAllUsecases[idx] = updated;
    closeUseCaseModal();
    renderUseCaseBoard();
  } catch (err) {
    alert(err.message || 'Cannot advance stage. Check required fields.');
  }
}

async function ucDelete(id) {
  if (!confirm('Delete this use case? This cannot be undone.')) return;
  await api(`/api/use-cases/${id}`, { method: 'DELETE' });
  ucAllUsecases = ucAllUsecases.filter(uc => uc.id !== id);
  closeUseCaseModal();
  renderUseCaseBoard();
}

async function ucAddMember(useCaseId) {
  const sel = document.getElementById('uc-add-member-sel');
  const userId = sel?.value;
  if (!userId) return;
  const members = await api(`/api/use-cases/${useCaseId}/members`, { method: 'POST', body: { user_id: parseInt(userId) } });
  const chipsEl = document.getElementById('uc-members-chips');
  if (chipsEl) {
    chipsEl.innerHTML = members.map(m =>
      `<span class="uc-member-chip">&#128100; ${esc(m.name)}<button type="button" onclick="ucRemoveMember(${useCaseId},${m.user_id})" title="Remove">&times;</button></span>`
    ).join('') || '<span style="color:var(--text-muted);font-size:12px">No members yet</span>';
  }
  // Remove the added user from the dropdown
  const opt = sel.querySelector(`option[value="${userId}"]`);
  if (opt) opt.remove();
  sel.value = '';
}

async function ucRemoveMember(useCaseId, userId) {
  await api(`/api/use-cases/${useCaseId}/members/${userId}`, { method: 'DELETE' });
  const members = await api(`/api/use-cases/${useCaseId}/members`);
  const chipsEl = document.getElementById('uc-members-chips');
  if (chipsEl) {
    chipsEl.innerHTML = members.map(m =>
      `<span class="uc-member-chip">&#128100; ${esc(m.name)}<button type="button" onclick="ucRemoveMember(${useCaseId},${m.user_id})" title="Remove">&times;</button></span>`
    ).join('') || '<span style="color:var(--text-muted);font-size:12px">No members yet</span>';
    // Re-add user to add-member select
    const sel = document.getElementById('uc-add-member-sel');
    const user = (ucUsersCache||[]).find(u => u.id === userId);
    if (sel && user) {
      const opt = document.createElement('option');
      opt.value = user.id;
      opt.textContent = user.name;
      sel.appendChild(opt);
    }
  }
}

async function ucRecordApproval(useCaseId) {
  const approved_by_id = document.getElementById('uc-approval-user')?.value || null;
  const decision       = document.getElementById('uc-approval-decision')?.value;
  const notes          = document.getElementById('uc-approval-notes')?.value.trim() || '';
  if (!decision) return;
  await api(`/api/use-cases/${useCaseId}/approvals`, { method: 'POST', body: { approved_by_id, decision, notes } });
  // Refresh modal to show new approval
  const members  = await api(`/api/use-cases/${useCaseId}/members`);
  const approvals = await api(`/api/use-cases/${useCaseId}/approvals`);
  ucModalData = await api(`/api/use-cases/${useCaseId}`);
  ucRenderModal(ucModalData, members, approvals);
}
