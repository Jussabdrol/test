
// --- Risk Management Module ---
let riskFilters = { status: '', category: '' };
let riskListRequest = 0;

// Standard to risk category mapping
const standardToCategoryMap = {
  'ISO 9001': 'Quality',
  'ISO 14001': 'Environment',
  'ISO 45001': 'Health & Safety',
  'ISO 27001': 'Information Security',
  'ISO 27001 Annex A': 'Information Security',
  'ISO 22000': 'Food Safety',
  'ISO 42001': 'AI',
  'ISO 42001:2023': 'AI',
  'ISO 42001:2023 Annex A': 'AI',
};

async function getRiskCategoriesFromStandards() {
  const standards = await api('/api/requirements/standards');
  const categories = new Set();
  for (const std of standards) {
    const cat = standardToCategoryMap[std];
    if (cat) categories.add(cat);
  }
  // Always include some defaults if no standards selected
  if (categories.size === 0) {
    categories.add('Information Security');
    categories.add('Operational');
  }
  return [...categories].sort();
}

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
  const request = ++riskListRequest;
  closeExperienceDossier('risk', false);
  const allRisks = await api('/api/risks');
  const risks = allRisks.filter(r => (!riskFilters.status || r.status === riskFilters.status) && (!riskFilters.category || r.category === riskFilters.category));

  // Prefetch cross-links
  const allLinks = {};
  await batchAll(risks, async r => { allLinks[r.id] = await api(`/api/cross-links/risk/${r.id}`); });

  if (request !== riskListRequest) return;

  // Filters
  const categories = [...new Set(allRisks.map(r => r.category).filter(Boolean))];
  document.getElementById('risk-filters-bar').innerHTML = `
    <label class="experience-filter">Status<select onchange="riskFilters.status=this.value;loadRiskIdentification()">
      <option value="">All Status</option>
      <option value="identified" ${riskFilters.status==='identified'?'selected':''}>Identified</option>
      <option value="analyzing" ${riskFilters.status==='analyzing'?'selected':''}>Analyzing</option>
      <option value="treating" ${riskFilters.status==='treating'?'selected':''}>Treating</option>
      <option value="accepted" ${riskFilters.status==='accepted'?'selected':''}>Accepted</option>
      <option value="closed" ${riskFilters.status==='closed'?'selected':''}>Closed</option>
    </select></label>
    <label class="experience-filter">Category<select onchange="riskFilters.category=this.value;loadRiskIdentification()">
      <option value="">All Categories</option>
      ${categories.map(c => `<option value="${esc(c)}" ${riskFilters.category===c?'selected':''}>${esc(c)}</option>`).join('')}
    </select></label>
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

  // Risk Register table
  const list = document.getElementById('risk-list');
  if (risks.length === 0) {
    list.innerHTML = `<div class="empty-state">${riskFilters.status || riskFilters.category ? 'No risks match these filters.' : 'No risks identified yet. Add one to get started.'}</div>`;
    return;
  }

  let html = '<h3 class="section-title" style="margin-top:20px">Risk Register</h3>';
  html += `<div class="risk-table">
    <div class="risk-table-head">
      <div class="risk-col-title">Risk</div>
      <div class="risk-col-cat">Category</div>
      <div class="risk-col-owner">Owner</div>
      <div class="risk-col-score">Inherent risk</div>
      <div class="risk-col-status">Status</div>
      <div class="risk-col-treat">Treatments</div>
      <div class="risk-col-links">Links</div>
      <div class="risk-col-actions"></div>
    </div>`;

  for (const r of risks) {
    const cls = riskScoreClass(r.inherent_score);
    const stBadge = 'experience-neutral';
    const links = allLinks[r.id] || [];
    const linkCount = links.length;
    const collapseId = `risk-cl-${r.id}`;

    html += `<div class="risk-table-row">
        <div class="risk-col-title">
          <button type="button" class="risk-row-title experience-text-button" onclick="openRiskDossier(${r.id})">${esc(r.title)}</button>
          ${r.asset ? `<span class="risk-row-sub">Asset: ${esc(r.asset)}</span>` : ''}
        </div>
        <div class="risk-col-cat" data-label="Category"><span style="font-size:12px">${esc(r.category || '-')}</span></div>
        <div class="risk-col-owner" data-label="Owner"><span style="font-size:12px">${esc(r.risk_owner || '-')}</span></div>
        <div class="risk-col-score" data-label="Inherent risk"><span class="badge risk-score-badge ${cls}">${riskScoreLabel(r.inherent_score)} · ${r.inherent_score}</span></div>
        <div class="risk-col-status" data-label="Status"><span class="badge ${stBadge}">${r.status.charAt(0).toUpperCase() + r.status.slice(1)}</span></div>
        <div class="risk-col-treat" data-label="Treatments">${r.treatment_count > 0 ? `<span style="font-size:12px">${r.treatment_count}${r.open_treatments > 0 ? ` (${r.open_treatments} open)` : ''}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}</div>
        <div class="risk-col-links" data-label="Links">
          ${linkCount > 0 ? `<span style="cursor:pointer;font-size:12px" onclick="document.getElementById('${collapseId}').classList.toggle('collapsed');this.querySelector('.cl-toggle-icon').textContent=document.getElementById('${collapseId}').classList.contains('collapsed')?'+':'−'">${linkCount} linked <span class="cl-toggle-icon">+</span></span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}
        </div>
        <div class="risk-col-actions">
          ${actionMenu([
            { label: '&#128736; Add Treatment', onclick: `openTreatmentModalForRisk(${r.id})` },
            { label: '&#128279; Link Items', onclick: `openCrossLinkPicker('risk',${r.id},'risk-expand-${r.id}')` },
            { label: '&#9998; Edit', onclick: `openRiskModal(${r.id})` },
            'sep',
            { label: '&#128465; Delete', onclick: `deleteRisk(${r.id})`, cls: 'danger' },
          ])}
        </div>
      </div>
      <div id="risk-expand-${r.id}" class="risk-expand-row">
        <div id="${collapseId}" class="risk-links-detail collapsed">
          ${linkCount === 0 ? '' : buildInlineLinksDetail(links, 'risk', r.id, `risk-expand-${r.id}`)}
        </div>
      </div>`;
  }
  html += '</div>';
  list.innerHTML = html;
}

function buildInlineLinksDetail(links, entityType, entityId, containerId) {
  const typeIcons = {};
  const typeLabels = {};
  for (const [k, v] of Object.entries(linkableTypes)) { typeIcons[k] = v.icon; typeLabels[k] = v.label; }
  const grouped = {};
  for (const l of links) { if (!grouped[l.type]) grouped[l.type] = []; grouped[l.type].push(l); }
  let html = '';
  for (const [type, items] of Object.entries(grouped)) {
    html += `<div class="cross-link-group"><span class="cross-link-group-label">${typeIcons[type] || ''} ${typeLabels[type] || type}</span>`;
    for (const item of items) {
      const viewTarget = getViewForType(item.type, item.id);
      html += `<div class="cross-link-item">
        <span class="cross-link-name"${viewTarget ? ` onclick="${viewTarget}" style="cursor:pointer;text-decoration:underline"` : ''}>${esc(item.name)}</span>
        <button class="cross-link-remove" onclick="removeCrossLink(${item.link_id},'${entityType}',${entityId},'${containerId}');setTimeout(()=>refreshCurrentView(),300)" title="Remove link">&times;</button>
      </div>`;
    }
    html += '</div>';
  }
  return html;
}

async function openRiskModal(id) {
  const modal = document.getElementById('risk-modal');
  document.getElementById('risk-form').reset();
  document.getElementById('risk-id').value = '';
  document.getElementById('risk-modal-title').textContent = 'New Risk';
  document.getElementById('risk-status-group').classList.add('hidden');

  // Populate architecture dropdowns and category from standards
  const [roles, systems, assets, processes, facilities, riskCategories] = await Promise.all([
    api('/api/architecture?arch_type=role'),
    api('/api/architecture?arch_type=system'),
    api('/api/architecture?arch_type=asset'),
    api('/api/architecture?arch_type=process'),
    api('/api/architecture?arch_type=facility'),
    getRiskCategoriesFromStandards(),
  ]);

  // Populate category dropdown from standards
  const catSel = document.getElementById('risk-category');
  catSel.innerHTML = '<option value="">-- Select --</option>' + riskCategories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (riskCategories.length > 0) catSel.value = riskCategories[0]; // Default to first category

  const ownerSel = document.getElementById('risk-owner');
  ownerSel.innerHTML = '<option value="">-- Select Role --</option>' + roles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
  const assetSel = document.getElementById('risk-asset');
  assetSel.innerHTML = '<option value="">-- Select --</option>'
    + (systems.length > 0 ? `<optgroup label="Systems">${systems.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('')}</optgroup>` : '')
    + (assets.length > 0 ? `<optgroup label="Assets">${assets.map(a => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join('')}</optgroup>` : '');
  const procSel = document.getElementById('risk-process');
  procSel.innerHTML = '<option value="">-- None --</option>' + processes.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const facSel = document.getElementById('risk-facility');
  facSel.innerHTML = '<option value="">-- None --</option>' + facilities.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');

  if (id) {
    const r = await api(`/api/risks/${id}`);
    document.getElementById('risk-modal-title').textContent = 'Edit Risk';
    document.getElementById('risk-id').value = r.id;
    document.getElementById('risk-title').value = r.title;
    document.getElementById('risk-description').value = r.description;
    document.getElementById('risk-category').value = r.category;
    ownerSel.value = r.risk_owner || '';
    assetSel.value = r.asset || '';
    document.getElementById('risk-source').value = r.source;
    document.getElementById('risk-threat').value = r.threat;
    document.getElementById('risk-vulnerability').value = r.vulnerability;
    document.getElementById('risk-likelihood').value = r.likelihood;
    document.getElementById('risk-impact').value = r.impact;
    document.getElementById('risk-status-field').value = r.status;
    document.getElementById('risk-status-group').classList.remove('hidden');

    // Pre-select linked process/facility from cross-links
    const links = await api(`/api/cross-links/risk/${id}`);
    const procLink = links.find(l => l.type === 'process');
    const facLink = links.find(l => l.type === 'facility');
    if (procLink) procSel.value = procLink.id;
    if (facLink) facSel.value = facLink.id;
  }
  modal.classList.remove('hidden');
}

function closeRiskModal() { document.getElementById('risk-modal').classList.add('hidden'); }

async function saveRisk(e) {
  e.preventDefault();
  const id = document.getElementById('risk-id').value;
  const ownerName = document.getElementById('risk-owner').value;
  const assetName = document.getElementById('risk-asset').value;
  const body = {
    title: document.getElementById('risk-title').value,
    description: document.getElementById('risk-description').value,
    category: document.getElementById('risk-category').value,
    risk_owner: ownerName,
    asset: assetName,
    source: document.getElementById('risk-source').value,
    threat: document.getElementById('risk-threat').value,
    vulnerability: document.getElementById('risk-vulnerability').value,
    likelihood: parseInt(document.getElementById('risk-likelihood').value),
    impact: parseInt(document.getElementById('risk-impact').value),
  };
  let riskId = id;
  if (id) {
    body.status = document.getElementById('risk-status-field').value;
    await api(`/api/risks/${id}`, { method: 'PUT', body });
  } else {
    const result = await api('/api/risks', { method: 'POST', body });
    riskId = result.id;
  }
  // Auto-link selected architecture elements
  if (riskId) {
    const procId = document.getElementById('risk-process').value;
    const facId = document.getElementById('risk-facility').value;

    // Get existing links to avoid duplicates
    const existingLinks = await api(`/api/cross-links/risk/${riskId}`);
    const existingTargets = new Set(existingLinks.map(l => `${l.type}:${l.id}`));

    // Link process
    if (procId && !existingTargets.has(`process:${procId}`)) {
      await api('/api/cross-links', { method: 'POST', body: { source_type: 'risk', source_id: parseInt(riskId), target_type: 'process', target_id: parseInt(procId) } });
    }
    // Link facility
    if (facId && !existingTargets.has(`facility:${facId}`)) {
      await api('/api/cross-links', { method: 'POST', body: { source_type: 'risk', source_id: parseInt(riskId), target_type: 'facility', target_id: parseInt(facId) } });
    }
    // Link owner (role) by name lookup
    if (ownerName) {
      const roles = await api('/api/architecture?arch_type=role');
      const role = roles.find(r => r.name === ownerName);
      if (role && !existingTargets.has(`role:${role.id}`)) {
        await api('/api/cross-links', { method: 'POST', body: { source_type: 'risk', source_id: parseInt(riskId), target_type: 'role', target_id: role.id } });
      }
    }
    // Link asset/system by name lookup
    if (assetName) {
      const [systems, assets] = await Promise.all([
        api('/api/architecture?arch_type=system'),
        api('/api/architecture?arch_type=asset')
      ]);
      let arch = systems.find(s => s.name === assetName);
      let archType = 'system';
      if (!arch) {
        arch = assets.find(a => a.name === assetName);
        archType = 'asset';
      }
      if (arch && !existingTargets.has(`${archType}:${arch.id}`)) {
        await api('/api/cross-links', { method: 'POST', body: { source_type: 'risk', source_id: parseInt(riskId), target_type: archType, target_id: arch.id } });
      }
    }
  }
  closeRiskModal();
  refreshCurrentView();
}

async function deleteRisk(id) {
  if (!confirm('Delete this risk and all its treatments?')) return;
  await api(`/api/risks/${id}`, { method: 'DELETE' });
  refreshCurrentView();
}
