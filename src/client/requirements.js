
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
let reqColWidths = {}; // persists resize state across re-renders

function _getReqGridCols(dynCols) {
  const w = reqColWidths;
  return [
    (w.clause || 80) + 'px',
    (w.title  || 280) + 'px',
    (w.audit  || 100) + 'px',
    (w.nc     || 80)  + 'px',
    ...dynCols.map(t => (w['dyn_' + t] || 130) + 'px'),
    '44px', // actions — always fixed
  ].join(' ');
}

function _initReqResize(dynCols) {
  document.querySelectorAll('.req-resize-handle').forEach(handle => {
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      const colKey = handle.dataset.col;
      const startX = e.clientX;
      const startW = reqColWidths[colKey] || parseInt(handle.dataset.default, 10) || 130;
      handle.classList.add('dragging');

      const onMove = ev => {
        const newW = Math.max(50, startW + ev.clientX - startX);
        reqColWidths[colKey] = newW;
        const cols = _getReqGridCols(dynCols);
        document.querySelectorAll('.req-table-head, .req-table-row').forEach(el => {
          el.style.gridTemplateColumns = cols;
        });
        // Keep the sticky 'Requirement' column's left offset in sync with clause width
        if (colKey === 'clause') {
          document.querySelectorAll('.req-col-title').forEach(el => {
            el.style.left = newW + 'px';
          });
        }
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

async function loadRequirements() {
  try {
  const params = new URLSearchParams();
  if (reqFilters.standard) params.set('standard', reqFilters.standard);
  const reqs = await api(`/api/requirements?${params}`);
  const standards = await api('/api/requirements/standards');

  // Fetch cross-links for all requirements in a single bulk request
  // (previously: N individual requests via batchAll)
  const allLinks = reqs.length
    ? await api(`/api/cross-links/batch/requirement?ids=${reqs.map(r => r.id).join(',')}`)
    : {};

  // Render filter bar
  document.getElementById('req-filters-bar').innerHTML = `
    <select onchange="reqFilters.standard=this.value;loadRequirements()">
      <option value="">All Standards</option>
      ${standards.map(s => `<option value="${esc(s)}" ${reqFilters.standard===s?'selected':''}>${esc(s)}</option>`).join('')}
    </select>
    <span style="font-size:13px;color:var(--text-muted)">${reqs.length} requirement${reqs.length!==1?'s':''}</span>
    ${reqFilters.standard ? `<button class="btn btn-secondary btn-sm" style="margin-left:auto;color:var(--danger);border-color:var(--danger)" onclick="retireStandard(this.closest('.filters').querySelector('select').value)">Retire Standard</button>` : ''}`;

  // Group by category
  const groups = {};
  for (const r of reqs) {
    const cat = r.category || 'Uncategorized';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(r);
  }

  // Derive dynamic columns from which entity types are actually linked
  const AUDIT_COL_TYPES = ['process', 'role', 'document', 'risk', 'treatment', 'task', 'action', 'system', 'asset'];
  const AUDIT_COL_LABELS = { process: 'Processes', role: 'Roles', document: 'Documents', risk: 'Risks', treatment: 'Treatments', task: 'Tasks', action: 'Actions', system: 'Systems', asset: 'Assets' };
  const typeLabels = Object.fromEntries(Object.entries(linkableTypes).map(([k,v]) => [k, v.label]));
  const typeIcons  = Object.fromEntries(Object.entries(linkableTypes).map(([k,v]) => [k, v.icon]));
  const _linkedTypesPresent = new Set();
  for (const ls of Object.values(allLinks)) for (const l of ls) if (AUDIT_COL_TYPES.includes(l.type)) _linkedTypesPresent.add(l.type);
  const dynamicCols = AUDIT_COL_TYPES.filter(t => _linkedTypesPresent.has(t));
  const gridCols = _getReqGridCols(dynamicCols);

  // Evidence coverage: % of requirements with at least one linked document
  const withEvidence = reqs.filter(r => (allLinks[r.id] || []).some(l => l.type === 'document')).length;
  const evPct = reqs.length ? Math.round(withEvidence / reqs.length * 100) : 0;

  // Stats
  const statsEl = document.getElementById('req-stats');
  statsEl.innerHTML = `
    <div class="req-stats-grid">
      <div class="stat-card"><div class="stat-value">${reqs.length}</div><div class="stat-label">Total Requirements</div></div>
      <div class="stat-card"><div class="stat-value">${standards.length}</div><div class="stat-label">Standards</div></div>
      <div class="stat-card"><div class="stat-value">${Object.keys(groups).length}</div><div class="stat-label">Categories</div></div>
      <div class="stat-card" title="${withEvidence} of ${reqs.length} requirements have linked evidence documents"><div class="stat-value" style="color:${evPct>=80?'var(--success)':evPct>=40?'var(--warning)':'var(--danger)'}">${evPct}%</div><div class="stat-label">Evidence Coverage</div></div>
    </div>`;

  // List
  const list = document.getElementById('req-list');
  if (reqs.length === 0) {
    list.innerHTML = '<div class="empty-state">No requirements yet. Add manually or import a standard template.</div>';
    return;
  }

  // Sort categories: HLS chapters numerically (4→10), annex categories (A.x.x) always last
  const _clauseSortKey = clause => {
    if (/^[A-Za-z]/.test(clause)) return 1e9; // annex — always after numbered clauses
    const parts = clause.split('.').map(Number);
    return parts[0] * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0);
  };
  const sortedGroupEntries = Object.entries(groups).sort(([, aItems], [, bItems]) => {
    const aMin = Math.min(...aItems.map(i => _clauseSortKey(i.clause)));
    const bMin = Math.min(...bItems.map(i => _clauseSortKey(i.clause)));
    return aMin - bMin;
  });

  let html = '';
  for (const [cat, items] of sortedGroupEntries) {
    items.sort((a, b) => a.clause.localeCompare(b.clause, undefined, { numeric: true }));
    html += `<div class="req-category-group">
      <div class="req-category-header">${esc(cat)} <span class="req-cat-count">(${items.length})</span></div>
      <div class="req-table-wrap"><div class="req-table">
        <div class="req-table-head" style="grid-template-columns:${gridCols}">
          <div class="req-col-clause">Clause<div class="req-resize-handle" data-col="clause" data-default="80"></div></div>
          <div class="req-col-title">Requirement<div class="req-resize-handle" data-col="title" data-default="280"></div></div>
          <div class="req-col-audit">Last Audit<div class="req-resize-handle" data-col="audit" data-default="100"></div></div>
          <div class="req-col-nc">NCs<div class="req-resize-handle" data-col="nc" data-default="80"></div></div>
          ${dynamicCols.map(t => `<div class="req-col-dynamic">${AUDIT_COL_LABELS[t] || typeLabels[t]}<div class="req-resize-handle" data-col="dyn_${t}" data-default="130"></div></div>`).join('')}
          <div class="req-col-actions"></div>
        </div>`;
    for (const r of items) {
      const lastAuditLabel = r.last_audited
        ? `<span class="req-audit-info" title="Last audited in: ${esc(r.last_audit_title || '')}">${r.last_audited}</span>`
        : '<span class="req-audit-info none">-</span>';

      let ncBadge = '<span style="color:var(--text-muted);font-size:11px">-</span>';
      if (r.nc_total > 0) {
        if (r.nc_open > 0) {
          ncBadge = `<span class="badge badge-high" title="${r.nc_open} open, ${r.nc_closed} treated">${r.nc_open} open</span>`;
        } else {
          ncBadge = `<span class="badge badge-low" title="All ${r.nc_total} NCs treated">${r.nc_total} treated</span>`;
        }
      }

      // Dynamic entity-type columns — one column per linked entity type present across all requirements
      const links = allLinks[r.id] || [];
      const collapseId = `req-cl-${r.id}`;
      const dynColsHtml = dynamicCols.map(t => {
        const tLinks = links.filter(l => l.type === t);
        const addBtn = `<button class="add-link-btn" onclick="openCrossLinkPicker('requirement',${r.id},null,'${t}')" title="Add link">+</button>`;
        if (!tLinks.length) return `<div class="req-col-dynamic"><span class="req-no-link">-</span>${addBtn}</div>`;
        return `<div class="req-col-dynamic">${tLinks.map(l => {
          const nav = getViewForType(l.type, l.id);
          return `<span class="req-linked-chip${nav ? ' clickable' : ''}" title="${esc(l.name)}"><span class="chip-nav"${nav ? ` onclick="${nav}"` : ''}>${esc(l.name)}</span><button class="chip-remove" onclick="event.stopPropagation();removeCrossLink(${l.link_id},'requirement',${r.id},null)" title="Remove link">&times;</button></span>`;
        }).join('')}${addBtn}</div>`;
      }).join('');

      html += `<div class="req-table-row" style="grid-template-columns:${gridCols}">
          <div class="req-col-clause" style="cursor:pointer" onclick="openRequirementModal(${r.id})"><span class="req-clause">${esc(r.clause)}</span></div>
          <div class="req-col-title" style="cursor:pointer" onclick="openRequirementModal(${r.id})">
            <span class="req-title" style="color:var(--primary)">${esc(r.title)}</span>
            ${r.description ? `<span class="req-desc">${esc(r.description)}</span>` : ''}
          </div>
          <div class="req-col-audit">${lastAuditLabel}</div>
          <div class="req-col-nc">${ncBadge}</div>
          ${dynColsHtml}
          <div class="req-col-actions">
            ${actionMenu([
              ...(links.length > 0 ? [{ label: `&#128279; All Links (${links.length})`, onclick: `toggleArchLinks('${collapseId}')` }] : []),
              { label: '&#128279; Link Items', onclick: `openCrossLinkPicker('requirement',${r.id},'req-expand-${r.id}')` },
              { label: '&#9998; Edit', onclick: `openRequirementModal(${r.id})` },
              'sep',
              { label: '&#128465; Delete', onclick: `deleteRequirement(${r.id})`, cls: 'danger' },
            ])}
          </div>
        </div>
        <div id="req-expand-${r.id}" class="req-expand-row">
          <div id="${collapseId}" class="arch-links-detail collapsed">
            ${links.length > 0 ? buildInlineLinksDetail(links, 'requirement', r.id, `req-expand-${r.id}`) : ''}
          </div>
        </div>`;
    }
    html += '</div></div></div>';
  }
  list.innerHTML = html;
  _initReqResize(dynamicCols);
  } catch (err) {
    console.error('[loadRequirements] Failed:', err);
    const list = document.getElementById('req-list');
    if (list) list.innerHTML = `<div class="empty-state" style="color:var(--danger)">Failed to load requirements: ${esc(err.message)}</div>`;
  }
}

// toggleReqLinks removed — links now inline in table

let currentReqLinks = []; // Temporary storage for links being edited in modal

async function openRequirementModal(id) {
  const modal = document.getElementById('requirement-modal');
  document.getElementById('requirement-form').reset();
  document.getElementById('req-id').value = '';
  document.getElementById('req-modal-title').textContent = 'New Requirement';
  currentReqLinks = [];

  // Populate standard datalist from existing
  const standards = await api('/api/requirements/standards');
  document.getElementById('req-standard-list').innerHTML = standards.map(s => `<option value="${esc(s)}">`).join('');
  // Populate category datalist
  const reqs = await api('/api/requirements');
  const cats = [...new Set(reqs.map(r => r.category).filter(Boolean))];
  document.getElementById('req-category-list').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');

  const linksGroup = document.getElementById('req-links-group');

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

      // Load existing links
      const links = await api(`/api/cross-links/requirement/${id}`);
      currentReqLinks = links.map(l => ({ link_id: l.link_id, type: l.type, id: l.id, name: l.name }));
      linksGroup.style.display = 'block';
      renderReqLinksInModal();
    }
  } else {
    // New requirement - hide links until saved
    linksGroup.style.display = 'none';
  }
  modal.classList.remove('hidden');
}

function renderReqLinksInModal() {
  const container = document.getElementById('req-links-container');
  if (currentReqLinks.length === 0) {
    container.innerHTML = '<span style="color:var(--text-muted);font-size:12px">No links yet.</span>';
    return;
  }
  const typeLabels = {};
  for (const [k, v] of Object.entries(linkableTypes)) typeLabels[k] = v.label;

  container.innerHTML = currentReqLinks.map((l, idx) => `
    <div class="req-link-item" style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:#f1f5f9;border-radius:var(--radius);margin-bottom:4px;font-size:12px">
      <span><strong>${typeLabels[l.type] || l.type}:</strong> ${esc(l.name)}</span>
      <button type="button" class="btn btn-secondary btn-sm" style="padding:2px 6px;font-size:10px" onclick="removeReqLinkFromModal(${idx})">&times;</button>
    </div>
  `).join('');
}

function removeReqLinkFromModal(idx) {
  const removed = currentReqLinks.splice(idx, 1)[0];
  // If it has a link_id, delete from server
  if (removed.link_id) {
    api(`/api/cross-links/${removed.link_id}`, { method: 'DELETE' });
  }
  renderReqLinksInModal();
}

async function openReqLinkPicker() {
  const reqId = document.getElementById('req-id').value;
  if (!reqId) {
    alert('Please save the requirement first before adding links.');
    return;
  }

  const allowed = linkableTypes['requirement']?.canLink || [];
  let existing = document.getElementById('req-link-picker-modal');
  if (!existing) {
    existing = document.createElement('div');
    existing.id = 'req-link-picker-modal';
    existing.className = 'modal hidden';
    document.body.appendChild(existing);
  }
  existing.innerHTML = `
    <div class="modal-overlay" onclick="closeReqLinkPicker()"></div>
    <div class="modal-content modal-sm">
      <div class="modal-header">
        <h3>Add Link</h3>
        <button class="modal-close" onclick="closeReqLinkPicker()">&times;</button>
      </div>
      <div class="form-group">
        <label>Type</label>
        <select id="req-link-pick-type" onchange="loadReqLinkOptions()">
          <option value="">-- Select type --</option>
          ${allowed.map(t => `<option value="${t}">${linkableTypes[t]?.label || t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Item</label>
        <select id="req-link-pick-item"><option value="">-- Select type first --</option></select>
      </div>
      <div class="form-actions">
        <button class="btn btn-secondary" onclick="closeReqLinkPicker()">Cancel</button>
        <button class="btn btn-primary" onclick="addReqLinkFromModal()">Add Link</button>
      </div>
    </div>`;
  existing.classList.remove('hidden');
}

function closeReqLinkPicker() {
  const m = document.getElementById('req-link-picker-modal');
  if (m) m.classList.add('hidden');
}

async function loadReqLinkOptions() {
  const type = document.getElementById('req-link-pick-type').value;
  const sel = document.getElementById('req-link-pick-item');
  if (!type) { sel.innerHTML = '<option value="">-- Select type first --</option>'; return; }
  const items = await api(`/api/linkable/${type}`);
  sel.innerHTML = '<option value="">-- Select --</option>' + items.map(i => `<option value="${i.id}" data-name="${esc(i.name)}">${esc(i.name)}</option>`).join('');
}

async function addReqLinkFromModal() {
  const reqId = document.getElementById('req-id').value;
  const targetType = document.getElementById('req-link-pick-type').value;
  const targetIdStr = document.getElementById('req-link-pick-item').value;
  const targetSel = document.getElementById('req-link-pick-item');
  const targetName = targetSel.options[targetSel.selectedIndex]?.dataset.name || '';

  if (!targetType || !targetIdStr) return alert('Please select a type and item');

  // Check if already linked
  if (currentReqLinks.some(l => l.type === targetType && l.id === parseInt(targetIdStr))) {
    alert('This item is already linked.');
    return;
  }

  // Create the link via API
  await api('/api/cross-links', { method: 'POST', body: { source_type: 'requirement', source_id: parseInt(reqId), target_type: targetType, target_id: parseInt(targetIdStr) } });

  // Reload links
  const links = await api(`/api/cross-links/requirement/${reqId}`);
  currentReqLinks = links.map(l => ({ link_id: l.link_id, type: l.type, id: l.id, name: l.name }));

  closeReqLinkPicker();
  renderReqLinksInModal();
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
  let reqId = id;
  if (id) {
    await api(`/api/requirements/${id}`, { method: 'PUT', body });
  } else {
    const result = await api('/api/requirements', { method: 'POST', body });
    reqId = result.id;
  }

  // Show links section for newly created requirement so user can add links
  if (!id && reqId) {
    document.getElementById('req-id').value = reqId;
    document.getElementById('req-links-group').style.display = 'block';
    document.getElementById('req-modal-title').textContent = 'Edit Requirement';
    renderReqLinksInModal();
    // Don't close modal - let user add links
    return;
  }

  closeRequirementModal();
  loadRequirements();
}

async function deleteRequirement(id) {
  if (!confirm('Delete this requirement?')) return;
  await api(`/api/requirements/${id}`, { method: 'DELETE' });
  loadRequirements();
}

async function retireStandard(standard) {
  if (!confirm(`Remove all requirements for "${standard}"? This will also remove related SoA entries. This cannot be undone.`)) return;
  await api(`/api/requirements/standard/${encodeURIComponent(standard)}`, { method: 'DELETE' });
  reqFilters.standard = '';
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
    'ISO 27001 Annex A': [
      { clause: 'A.5.1', title: 'Policies for information security', category: 'Organizational Controls' },
      { clause: 'A.5.2', title: 'Information security roles and responsibilities', category: 'Organizational Controls' },
      { clause: 'A.5.3', title: 'Segregation of duties', category: 'Organizational Controls' },
      { clause: 'A.5.4', title: 'Management responsibilities', category: 'Organizational Controls' },
      { clause: 'A.5.5', title: 'Contact with authorities', category: 'Organizational Controls' },
      { clause: 'A.5.6', title: 'Contact with special interest groups', category: 'Organizational Controls' },
      { clause: 'A.5.7', title: 'Threat intelligence', category: 'Organizational Controls' },
      { clause: 'A.5.8', title: 'Information security in project management', category: 'Organizational Controls' },
      { clause: 'A.5.9', title: 'Inventory of information and other associated assets', category: 'Organizational Controls' },
      { clause: 'A.5.10', title: 'Acceptable use of information and other associated assets', category: 'Organizational Controls' },
      { clause: 'A.5.11', title: 'Return of assets', category: 'Organizational Controls' },
      { clause: 'A.5.12', title: 'Classification of information', category: 'Organizational Controls' },
      { clause: 'A.5.13', title: 'Labelling of information', category: 'Organizational Controls' },
      { clause: 'A.5.14', title: 'Information transfer', category: 'Organizational Controls' },
      { clause: 'A.5.15', title: 'Access control', category: 'Organizational Controls' },
      { clause: 'A.5.16', title: 'Identity management', category: 'Organizational Controls' },
      { clause: 'A.5.17', title: 'Authentication information', category: 'Organizational Controls' },
      { clause: 'A.5.18', title: 'Access rights', category: 'Organizational Controls' },
      { clause: 'A.5.19', title: 'Information security in supplier relationships', category: 'Organizational Controls' },
      { clause: 'A.5.20', title: 'Addressing information security within supplier agreements', category: 'Organizational Controls' },
      { clause: 'A.5.21', title: 'Managing information security in the ICT supply chain', category: 'Organizational Controls' },
      { clause: 'A.5.22', title: 'Monitoring, review and change management of supplier services', category: 'Organizational Controls' },
      { clause: 'A.5.23', title: 'Information security for use of cloud services', category: 'Organizational Controls' },
      { clause: 'A.5.24', title: 'Information security incident management planning and preparation', category: 'Organizational Controls' },
      { clause: 'A.5.25', title: 'Assessment and decision on information security events', category: 'Organizational Controls' },
      { clause: 'A.5.26', title: 'Response to information security incidents', category: 'Organizational Controls' },
      { clause: 'A.5.27', title: 'Learning from information security incidents', category: 'Organizational Controls' },
      { clause: 'A.5.28', title: 'Collection of evidence', category: 'Organizational Controls' },
      { clause: 'A.5.29', title: 'Information security during disruption', category: 'Organizational Controls' },
      { clause: 'A.5.30', title: 'ICT readiness for business continuity', category: 'Organizational Controls' },
      { clause: 'A.5.31', title: 'Legal, statutory, regulatory and contractual requirements', category: 'Organizational Controls' },
      { clause: 'A.5.32', title: 'Intellectual property rights', category: 'Organizational Controls' },
      { clause: 'A.5.33', title: 'Protection of records', category: 'Organizational Controls' },
      { clause: 'A.5.34', title: 'Privacy and protection of PII', category: 'Organizational Controls' },
      { clause: 'A.5.35', title: 'Independent review of information security', category: 'Organizational Controls' },
      { clause: 'A.5.36', title: 'Compliance with policies, rules and standards for information security', category: 'Organizational Controls' },
      { clause: 'A.5.37', title: 'Documented operating procedures', category: 'Organizational Controls' },
      { clause: 'A.6.1', title: 'Screening', category: 'People Controls' },
      { clause: 'A.6.2', title: 'Terms and conditions of employment', category: 'People Controls' },
      { clause: 'A.6.3', title: 'Information security awareness, education and training', category: 'People Controls' },
      { clause: 'A.6.4', title: 'Disciplinary process', category: 'People Controls' },
      { clause: 'A.6.5', title: 'Responsibilities after termination or change of employment', category: 'People Controls' },
      { clause: 'A.6.6', title: 'Confidentiality or non-disclosure agreements', category: 'People Controls' },
      { clause: 'A.6.7', title: 'Remote working', category: 'People Controls' },
      { clause: 'A.6.8', title: 'Information security event reporting', category: 'People Controls' },
      { clause: 'A.7.1', title: 'Physical security perimeters', category: 'Physical Controls' },
      { clause: 'A.7.2', title: 'Physical entry', category: 'Physical Controls' },
      { clause: 'A.7.3', title: 'Securing offices, rooms and facilities', category: 'Physical Controls' },
      { clause: 'A.7.4', title: 'Physical security monitoring', category: 'Physical Controls' },
      { clause: 'A.7.5', title: 'Protecting against physical and environmental threats', category: 'Physical Controls' },
      { clause: 'A.7.6', title: 'Working in secure areas', category: 'Physical Controls' },
      { clause: 'A.7.7', title: 'Clear desk and clear screen', category: 'Physical Controls' },
      { clause: 'A.7.8', title: 'Equipment siting and protection', category: 'Physical Controls' },
      { clause: 'A.7.9', title: 'Security of assets off-premises', category: 'Physical Controls' },
      { clause: 'A.7.10', title: 'Storage media', category: 'Physical Controls' },
      { clause: 'A.7.11', title: 'Supporting utilities', category: 'Physical Controls' },
      { clause: 'A.7.12', title: 'Cabling security', category: 'Physical Controls' },
      { clause: 'A.7.13', title: 'Equipment maintenance', category: 'Physical Controls' },
      { clause: 'A.7.14', title: 'Secure disposal or re-use of equipment', category: 'Physical Controls' },
      { clause: 'A.8.1', title: 'User endpoint devices', category: 'Technological Controls' },
      { clause: 'A.8.2', title: 'Privileged access rights', category: 'Technological Controls' },
      { clause: 'A.8.3', title: 'Information access restriction', category: 'Technological Controls' },
      { clause: 'A.8.4', title: 'Access to source code', category: 'Technological Controls' },
      { clause: 'A.8.5', title: 'Secure authentication', category: 'Technological Controls' },
      { clause: 'A.8.6', title: 'Capacity management', category: 'Technological Controls' },
      { clause: 'A.8.7', title: 'Protection against malware', category: 'Technological Controls' },
      { clause: 'A.8.8', title: 'Management of technical vulnerabilities', category: 'Technological Controls' },
      { clause: 'A.8.9', title: 'Configuration management', category: 'Technological Controls' },
      { clause: 'A.8.10', title: 'Information deletion', category: 'Technological Controls' },
      { clause: 'A.8.11', title: 'Data masking', category: 'Technological Controls' },
      { clause: 'A.8.12', title: 'Data leakage prevention', category: 'Technological Controls' },
      { clause: 'A.8.13', title: 'Information backup', category: 'Technological Controls' },
      { clause: 'A.8.14', title: 'Redundancy of information processing facilities', category: 'Technological Controls' },
      { clause: 'A.8.15', title: 'Logging', category: 'Technological Controls' },
      { clause: 'A.8.16', title: 'Monitoring activities', category: 'Technological Controls' },
      { clause: 'A.8.17', title: 'Clock synchronization', category: 'Technological Controls' },
      { clause: 'A.8.18', title: 'Use of privileged utility programs', category: 'Technological Controls' },
      { clause: 'A.8.19', title: 'Installation of software on operational systems', category: 'Technological Controls' },
      { clause: 'A.8.20', title: 'Networks security', category: 'Technological Controls' },
      { clause: 'A.8.21', title: 'Security of network services', category: 'Technological Controls' },
      { clause: 'A.8.22', title: 'Segregation of networks', category: 'Technological Controls' },
      { clause: 'A.8.23', title: 'Web filtering', category: 'Technological Controls' },
      { clause: 'A.8.24', title: 'Use of cryptography', category: 'Technological Controls' },
      { clause: 'A.8.25', title: 'Secure development life cycle', category: 'Technological Controls' },
      { clause: 'A.8.26', title: 'Application security requirements', category: 'Technological Controls' },
      { clause: 'A.8.27', title: 'Secure system architecture and engineering principles', category: 'Technological Controls' },
      { clause: 'A.8.28', title: 'Secure coding', category: 'Technological Controls' },
      { clause: 'A.8.29', title: 'Security testing in development and acceptance', category: 'Technological Controls' },
      { clause: 'A.8.30', title: 'Outsourced development', category: 'Technological Controls' },
      { clause: 'A.8.31', title: 'Separation of development, test and production environments', category: 'Technological Controls' },
      { clause: 'A.8.32', title: 'Change management', category: 'Technological Controls' },
      { clause: 'A.8.33', title: 'Test information', category: 'Technological Controls' },
      { clause: 'A.8.34', title: 'Protection of information systems during audit testing', category: 'Technological Controls' },
    ],
    'ISO 42001:2023': [
      // 4 Context of the organization
      { clause: '4.1', title: 'Understanding the organization and its context', category: 'Context of the Organization' },
      { clause: '4.2', title: 'Understanding the needs and expectations of interested parties', category: 'Context of the Organization' },
      { clause: '4.3', title: 'Determining the scope of the AI management system', category: 'Context of the Organization' },
      { clause: '4.4', title: 'AI management system', category: 'Context of the Organization' },
      // 5 Leadership
      { clause: '5.1', title: 'Leadership and commitment', category: 'Leadership' },
      { clause: '5.2', title: 'AI policy', category: 'Leadership' },
      { clause: '5.3', title: 'Organizational roles, responsibilities and authorities', category: 'Leadership' },
      // 6 Planning
      { clause: '6.1', title: 'Actions to address risks and opportunities', category: 'Planning' },
      { clause: '6.1.1', title: 'General', category: 'Planning' },
      { clause: '6.1.2', title: 'AI risk assessment', category: 'Planning' },
      { clause: '6.1.3', title: 'AI risk treatment', category: 'Planning' },
      { clause: '6.1.4', title: 'AI system impact assessment', category: 'Planning' },
      { clause: '6.2', title: 'AI objectives and planning to achieve them', category: 'Planning' },
      { clause: '6.3', title: 'Planning of changes', category: 'Planning' },
      // 7 Support
      { clause: '7.1', title: 'Resources', category: 'Support' },
      { clause: '7.2', title: 'Competence', category: 'Support' },
      { clause: '7.3', title: 'Awareness', category: 'Support' },
      { clause: '7.4', title: 'Communication', category: 'Support' },
      { clause: '7.5', title: 'Documented information', category: 'Support' },
      // 8 Operation
      { clause: '8.1', title: 'Operational planning and control', category: 'Operation' },
      { clause: '8.2', title: 'AI risk assessment', category: 'Operation' },
      { clause: '8.3', title: 'AI risk treatment', category: 'Operation' },
      { clause: '8.4', title: 'AI system impact assessment', category: 'Operation' },
      // 9 Performance evaluation
      { clause: '9.1', title: 'Monitoring, measurement, analysis and evaluation', category: 'Performance Evaluation' },
      { clause: '9.2', title: 'Internal audit', category: 'Performance Evaluation' },
      { clause: '9.2.1', title: 'General', category: 'Performance Evaluation' },
      { clause: '9.2.2', title: 'Internal audit programme', category: 'Performance Evaluation' },
      { clause: '9.3', title: 'Management review', category: 'Performance Evaluation' },
      { clause: '9.3.1', title: 'General', category: 'Performance Evaluation' },
      { clause: '9.3.2', title: 'Management review inputs', category: 'Performance Evaluation' },
      { clause: '9.3.3', title: 'Management review results', category: 'Performance Evaluation' },
      // 10 Improvement
      { clause: '10.1', title: 'Continual improvement', category: 'Improvement' },
      { clause: '10.2', title: 'Nonconformity and corrective action', category: 'Improvement' },
    ],
    'ISO 42001:2023 Annex A': [
      { clause: 'A.2', title: 'AI policies', category: 'AI Controls' },
      { clause: 'A.3', title: 'Internal organization for AI', category: 'AI Controls' },
      { clause: 'A.4', title: 'Resources for AI systems', category: 'AI Controls' },
      { clause: 'A.5', title: 'Assessing impacts of AI systems', category: 'AI Controls' },
      { clause: 'A.6', title: 'AI system life cycle', category: 'AI Controls' },
      { clause: 'A.6.1', title: 'AI system life cycle management', category: 'AI Controls' },
      { clause: 'A.6.2', title: 'AI system requirements and design', category: 'AI Controls' },
      { clause: 'A.6.3', title: 'Data for AI systems', category: 'AI Controls' },
      { clause: 'A.6.4', title: 'AI model building and validation', category: 'AI Controls' },
      { clause: 'A.6.5', title: 'AI system verification and validation', category: 'AI Controls' },
      { clause: 'A.6.6', title: 'AI system deployment', category: 'AI Controls' },
      { clause: 'A.6.7', title: 'AI system operation and monitoring', category: 'AI Controls' },
      { clause: 'A.6.8', title: 'AI system retirement', category: 'AI Controls' },
      { clause: 'A.7', title: 'Data management', category: 'AI Controls' },
      { clause: 'A.8', title: 'Technology and AI system monitoring', category: 'AI Controls' },
      { clause: 'A.9', title: 'Third-party and customer relationships', category: 'AI Controls' },
      { clause: 'A.9.1', title: 'Use of AI as third-party or customer', category: 'AI Controls' },
      { clause: 'A.9.2', title: 'Supplying AI to third parties', category: 'AI Controls' },
      { clause: 'A.9.3', title: 'Responsible provision of AI', category: 'AI Controls' },
      { clause: 'A.9.4', title: 'AI system end-user communication', category: 'AI Controls' },
      { clause: 'A.10', title: 'Documentation and record management for AI', category: 'AI Controls' },
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

// --- Action Menu Helper ---
function actionMenu(items) {
  // items: array of { label, onclick, cls? } or 'sep' for separator
  let dd = '';
  for (const item of items) {
    if (item === 'sep') { dd += '<div class="action-menu-sep"></div>'; continue; }
    dd += `<button class="action-menu-item${item.cls ? ' ' + item.cls : ''}" onclick="closeAllMenus();${item.onclick}">${item.label}</button>`;
  }
  return `<div class="action-menu">
    <button class="action-menu-toggle" onclick="event.stopPropagation();toggleMenu(this)">&#9881;</button>
    <div class="action-menu-dropdown">${dd}</div>
  </div>`;
}

function toggleMenu(btn) {
  const menu = btn.closest('.action-menu');
  const wasOpen = menu.classList.contains('open');
  closeAllMenus();
  if (!wasOpen) {
    menu.classList.add('open');
    const dd = menu.querySelector('.action-menu-dropdown');
    const rect = btn.getBoundingClientRect();
    dd.style.top = (rect.bottom + 4) + 'px';
    dd.style.left = 'auto';
    dd.style.right = (window.innerWidth - rect.right) + 'px';
    // If dropdown goes below viewport, show above instead
    requestAnimationFrame(() => {
      const ddRect = dd.getBoundingClientRect();
      if (ddRect.bottom > window.innerHeight) {
        dd.style.top = (rect.top - ddRect.height - 4) + 'px';
      }
    });
  }
}

function closeAllMenus() {
  document.querySelectorAll('.action-menu.open').forEach(m => m.classList.remove('open'));
}

// Close menus on any outside click
document.addEventListener('click', () => closeAllMenus());
