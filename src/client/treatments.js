
// --- Risk Treatment View ---
async function loadRiskTreatmentView() {
  const risks = await api('/api/risks');
  // Fetch all treatment details
  const details = {};
  await batchAll(risks, async r => { details[r.id] = await api(`/api/risks/${r.id}`); });

  // Fetch treatment links
  const treatmentLinks = {};
  const allTreatments = Object.values(details).flatMap(d => d.treatments || []);
  await batchAll(allTreatments, async t => {
    treatmentLinks[t.id] = await api(`/api/cross-links/treatment/${t.id}`);
  });

  const totalTreatments = Object.values(details).reduce((s, d) => s + (d.treatments || []).length, 0);
  const openTreatments = Object.values(details).reduce((s, d) => s + (d.treatments || []).filter(t => t.status === 'planned' || t.status === 'in_progress').length, 0);

  document.getElementById('treatment-filters-bar').innerHTML = `<span style="font-size:13px;color:var(--text-muted)">${risks.length} risk${risks.length !== 1 ? 's' : ''}, ${totalTreatments} treatment${totalTreatments !== 1 ? 's' : ''}, ${openTreatments} open</span>`;

  if (risks.length === 0) {
    document.getElementById('treatment-list').innerHTML = '<div class="empty-state">No risks identified yet. Go to Risk Identification first.</div>';
    return;
  }

  let html = `<div class="treat-table">
    <div class="treat-table-head">
      <div class="treat-col-risk">Risk</div>
      <div class="treat-col-score">Inherent</div>
      <div class="treat-col-score">Residual</div>
      <div class="treat-col-count">Actions</div>
      <div class="treat-col-status">Progress</div>
      <div class="treat-col-actions"></div>
    </div>`;

  for (const r of risks) {
    const detail = details[r.id];
    const treatments = detail.treatments || [];
    const cls = riskScoreClass(r.inherent_score);

    // Calculate residual score as average of all treatments with residual values
    let residualScore = r.inherent_score;
    const treatmentsWithResidual = treatments.filter(t => t.residual_likelihood && t.residual_impact);
    if (treatmentsWithResidual.length > 0) {
      const totalResidual = treatmentsWithResidual.reduce((sum, t) => sum + (t.residual_likelihood * t.residual_impact), 0);
      residualScore = Math.round(totalResidual / treatmentsWithResidual.length);
    }
    const resCls = riskScoreClass(residualScore);
    const done = treatments.filter(t => t.status === 'implemented' || t.status === 'verified').length;
    const pct = treatments.length > 0 ? Math.round((done / treatments.length) * 100) : 0;
    const collapseId = `treat-expand-${r.id}`;

    html += `<div class="treat-table-row">
        <div class="treat-col-risk" style="cursor:pointer" onclick="openRiskModal(${r.id})">
          <span class="risk-row-title" style="color:var(--primary)">${esc(r.title)}</span>
          <span class="risk-row-sub">${esc(r.category || '')}${r.risk_owner ? ' · ' + esc(r.risk_owner) : ''}</span>
        </div>
        <div class="treat-col-score"><span class="badge risk-score-badge ${cls}">${r.inherent_score}</span></div>
        <div class="treat-col-score">${residualScore !== r.inherent_score ? `<span class="badge risk-score-badge ${resCls}">${residualScore}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}</div>
        <div class="treat-col-count">
          ${treatments.length > 0 ? `<span style="cursor:pointer;font-size:12px" onclick="document.getElementById('${collapseId}').classList.toggle('collapsed');this.querySelector('.cl-toggle-icon').textContent=document.getElementById('${collapseId}').classList.contains('collapsed')?'+':'−'">${treatments.length} action${treatments.length !== 1 ? 's' : ''} <span class="cl-toggle-icon">+</span></span>` : '<span style="color:var(--text-muted);font-size:11px">none</span>'}
        </div>
        <div class="treat-col-status">
          ${treatments.length > 0 ? `<div class="treat-progress-bar"><div class="treat-progress-fill" style="width:${pct}%"></div></div><span style="font-size:11px;color:var(--text-muted)">${pct}%</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}
        </div>
        <div class="treat-col-actions">
          ${actionMenu([
            { label: '+ Add Treatment', onclick: `openTreatmentModalForRisk(${r.id})` },
          ])}
        </div>
      </div>
      <div class="treat-expand-row">
        <div id="${collapseId}" class="treat-detail collapsed">
          ${treatments.length === 0 ? '' : buildTreatmentDetail(treatments, treatmentLinks)}
        </div>
      </div>`;
  }
  html += '</div>';
  document.getElementById('treatment-list').innerHTML = html;
}

function buildTreatmentDetail(treatments, treatmentLinks) {
  let html = '<div class="treat-sub-table">';
  for (const t of treatments) {
    const stBadge = t.status === 'verified' ? 'badge-low' : t.status === 'implemented' ? 'badge-low' : t.status === 'in_progress' ? 'badge-medium' : 'badge-high';
    const links = treatmentLinks[t.id] || [];
    const linkCount = links.length;
    html += `<div class="treat-sub-row">
      <div class="treat-sub-type"><span class="badge badge-inactive">${t.treatment_type}</span></div>
      <div class="treat-sub-desc" style="cursor:pointer" onclick="openTreatmentModal(${t.id})">
        <span style="font-size:12px;color:var(--primary)">${esc(t.description)}</span>
      </div>
      <div class="treat-sub-ref"><span style="font-size:12px;color:var(--primary)">${linkCount > 0 ? `${linkCount} link${linkCount !== 1 ? 's' : ''}` : '-'}</span></div>
      <div class="treat-sub-resp"><span style="font-size:12px">${t.responsible ? esc(t.responsible) : '-'}</span></div>
      <div class="treat-sub-due"><span style="font-size:12px">${t.due_date ? esc(t.due_date) : '-'}</span></div>
      <div class="treat-sub-st"><span class="badge ${stBadge}">${esc(t.status.replace(/_/g, ' '))}</span></div>
      <div class="treat-sub-act">
        ${actionMenu([
          ...(t.status === 'planned' ? [{ label: '&#9654; Start', onclick: `updateTreatmentStatus(${t.id},'in_progress')` }] : []),
          ...(t.status === 'in_progress' ? [{ label: '&#10003; Implement', onclick: `updateTreatmentStatus(${t.id},'implemented')` }] : []),
          ...(t.status === 'implemented' ? [{ label: '&#10003; Verify', onclick: `updateTreatmentStatus(${t.id},'verified')` }] : []),
          { label: '&#9998; Edit', onclick: `openTreatmentModal(${t.id})` },
          'sep',
          { label: '&#128465; Delete', onclick: `deleteTreatment(${t.id})`, cls: 'danger' },
        ])}
      </div>
    </div>`;
  }
  html += '</div>';
  return html;
}

async function populateTreatmentRoles() {
  const roles = await api('/api/architecture?arch_type=role');
  const sel = document.getElementById('treatment-responsible');
  sel.innerHTML = '<option value="">-- Select Role --</option>' + roles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
}

async function populateTreatmentControls() {
  const soaData = await api('/api/soa');
  const select = document.getElementById('treatment-control-ref');
  select.innerHTML = '<option value="">-- Select Control (optional) --</option>' +
    soaData.map(c => `<option value="${esc(c.clause)}">${esc(c.clause)} - ${esc(c.title)}</option>`).join('');
}

async function openTreatmentModalForRisk(riskId) {
  document.getElementById('treatment-form').reset();
  document.getElementById('treatment-id').value = '';
  document.getElementById('treatment-risk-id').value = riskId;
  document.getElementById('treatment-modal-title').textContent = 'New Treatment';
  document.getElementById('treatment-status-group').classList.add('hidden');
  document.getElementById('treatment-crosslinks').classList.add('hidden');
  document.getElementById('treatment-crosslinks').innerHTML = '';
  await Promise.all([populateTreatmentRoles(), populateTreatmentControls()]);
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
  document.getElementById('treatment-due-date').value = t.due_date || '';
  document.getElementById('treatment-res-likelihood').value = t.residual_likelihood || '';
  document.getElementById('treatment-res-impact').value = t.residual_impact || '';
  document.getElementById('treatment-notes').value = t.notes || '';
  document.getElementById('treatment-status-field').value = t.status;
  document.getElementById('treatment-status-group').classList.remove('hidden');
  await Promise.all([populateTreatmentRoles(), populateTreatmentControls()]);
  document.getElementById('treatment-responsible').value = t.responsible || '';
  document.getElementById('treatment-control-ref').value = t.control_reference || '';
  // Show cross-links section for existing treatments
  const clContainer = document.getElementById('treatment-crosslinks');
  clContainer.classList.remove('hidden');
  renderCrossLinks('treatment', id, 'treatment-crosslinks');
  document.getElementById('treatment-modal').classList.remove('hidden');
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
