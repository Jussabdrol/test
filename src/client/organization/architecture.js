
// --- Organizational Planning: Architecture ---
let currentArchTab = 'role';
const archTypeLabels = { role: 'Roles & Responsibilities', process: 'Processes', system: 'Systems / Data', asset: 'Assets', facility: 'Facilities', supplier: 'Suppliers', ai_model: 'AI Model Inventory', ai_dataset: 'Data Catalog', ai_usecase: 'AI Use Cases' };

function switchArchTab(type) {
  currentArchTab = type;
  document.querySelectorAll('#arch-tabs [role="tab"]').forEach(tab => {
    const selected = tab.id === `architecture-tab-${type}`;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  document.getElementById('architecture-panel').setAttribute('aria-labelledby', `architecture-tab-${type}`);

  // Toggle the Add button label / visibility
  const addBtn = document.querySelector('#view-architecture .view-header button.btn-primary');
  if (addBtn) {
    if (type === 'supplier') {
      addBtn.textContent = '+ Add Supplier';
      addBtn.setAttribute('onclick', 'openSupplierModal()');
    } else if (type === 'ai_usecase') {
      addBtn.textContent = '+ New AI Use Case';
      addBtn.setAttribute('onclick', "switchView('use-cases');setTimeout(()=>openUseCaseModal(),200)");
    } else {
      addBtn.textContent = '+ Add Item';
      addBtn.setAttribute('onclick', 'openArchModal()');
    }
  }

  if (type === 'supplier') {
    // Hide the org-chart / map sections when on suppliers
    const oc = document.getElementById('org-chart-section');
    const fm = document.getElementById('facilities-map-section');
    if (oc) oc.style.display = 'none';
    if (fm) fm.style.display = 'none';
    loadSuppliers();
  } else {
    loadArchitecture();
  }
}

let orgChartZoom = 1;
let _archLoadId = 0;           // counter-based stale-result guard (belt)
let _archAbortCtrl = null;     // AbortController for in-flight requests (suspenders)

async function loadArchitecture() {
  // Cancel any previous in-flight load immediately, freeing browser connection slots.
  // This is the primary fix for slow/corporate networks: old requests no longer
  // hold TCP connections that would queue-block the new tab's requests.
  if (_archAbortCtrl) _archAbortCtrl.abort();
  _archAbortCtrl = new AbortController();
  const signal = _archAbortCtrl.signal;

  const loadId = ++_archLoadId;
  const tabAtStart = currentArchTab;
  const list = document.getElementById('arch-list');

  // Show loading state immediately so users on slow networks get feedback
  if (list) list.innerHTML = `<div class="arch-loading"><span class="arch-loading-spinner"></span>Loading ${archTypeLabels[tabAtStart] || ''}…</div>`;

  try {
  // 1 request for the items list
  const items = await api(`/api/architecture?arch_type=${currentArchTab}`, { signal });
  if (signal.aborted || loadId !== _archLoadId) return;

  // Update Add button label to match current tab
  const archSingular = { role: 'Role', process: 'Process', system: 'System', asset: 'Asset', facility: 'Facility', ai_model: 'AI Model', ai_dataset: 'Dataset', ai_usecase: 'AI Use Case' };
  const addBtn = document.querySelector('#view-architecture .view-header button.btn-primary');
  if (addBtn) addBtn.textContent = '+ Add ' + (archSingular[currentArchTab] || 'Item');

  // Show/hide org chart section based on tab
  const orgChartSection = document.getElementById('org-chart-section');
  const facilitiesMapSection = document.getElementById('facilities-map-section');

  if (currentArchTab === 'role') {
    orgChartSection.style.display = 'block';
    facilitiesMapSection.style.display = 'none';
    renderOrgChart(items);
  } else if (currentArchTab === 'facility') {
    orgChartSection.style.display = 'none';
    facilitiesMapSection.style.display = 'block';
    renderFacilitiesMap(items);
  } else {
    orgChartSection.style.display = 'none';
    facilitiesMapSection.style.display = 'none';
  }

  if (items.length === 0) {
    list.innerHTML = `<div class="empty-state">No ${archTypeLabels[currentArchTab].toLowerCase()} defined yet.</div>`;
    return;
  }

  // 1 bulk request for ALL cross-links (replaces N individual requests).
  // On a 15-item tab this goes from 16 round-trips down to 2.
  const ids = items.map(i => i.id).join(',');
  const allLinksMap = await api(`/api/cross-links/batch/${currentArchTab}?ids=${ids}`, { signal });
  if (signal.aborted || loadId !== _archLoadId) return;

  // Summary stats
  const activeCount = items.filter(i => i.status === 'active').length;
  const plannedCount = items.filter(i => i.status === 'planned').length;
  const retiredCount = items.filter(i => i.status === 'retired').length;

  let html = `
    <div class="stats-grid" style="margin-bottom:20px">
      <div class="stat-card"><div class="stat-value">${items.length}</div><div class="stat-label">Total</div></div>
      <div class="stat-card done"><div class="stat-value">${activeCount}</div><div class="stat-label">Active</div></div>
      <div class="stat-card today"><div class="stat-value">${plannedCount}</div><div class="stat-label">Planned</div></div>
      <div class="stat-card"><div class="stat-value">${retiredCount}</div><div class="stat-label">Retired</div></div>
    </div>`;

  // Build table based on architecture type
  html += '<div class="arch-table">';
  html += buildArchTableHeader(currentArchTab);

  for (const item of items) {
    let meta = {};
    try { meta = JSON.parse(item.metadata || '{}'); } catch(e) {}
    const links = allLinksMap[item.id] || [];
    html += buildArchTableRow(item, meta, links, currentArchTab);
  }

  html += '</div>';
  list.innerHTML = html;
  } catch (err) {
    // AbortError = intentional cancel (tab switch or timeout). Don't show an error
    // state — the new tab's load will replace the content momentarily.
    if (err.name === 'AbortError') return;
    console.error(`[loadArchitecture:${tabAtStart}] Failed:`, err);
    if (list) list.innerHTML = `<div class="empty-state" style="color:var(--danger)">Failed to load ${archTypeLabels[tabAtStart] || 'data'}: ${esc(err.message)}<br><button class="btn btn-secondary btn-sm" style="margin-top:12px" onclick="loadArchitecture()">Retry</button></div>`;
  }
}

// ── Suppliers ─────────────────────────────────────────────────────────────────

const SUPPLIER_COLUMNS = [
  { key: 'name',                 label: 'Supplier',         always: true,  def: true  },
  { key: 'category',             label: 'Category',         always: false, def: true  },
  { key: 'criticality',          label: 'Criticality',      always: false, def: true  },
  { key: 'services_provided',    label: 'Services',         always: false, def: true  },
  { key: 'contract_status',      label: 'Contract',         always: false, def: true  },
  { key: 'dpa_in_place',         label: 'DPA',              always: false, def: true  },
  { key: 'remediation_status',   label: 'Remediation',      always: false, def: true  },
  { key: 'next_review_date',     label: 'Next Review',      always: false, def: true  },
  { key: 'data_classification',  label: 'Data Class.',      always: false, def: false },
  { key: 'contract_expiry_date', label: 'Contract Expiry',  always: false, def: false },
  { key: 'dpa_review_date',      label: 'DPA Review',       always: false, def: false },
  { key: 'gaps_identified',      label: 'Gaps',             always: false, def: false },
  { key: 'quality_rating',       label: 'Quality',          always: false, def: false },
  { key: 'infosec_rating',       label: 'InfoSec',          always: false, def: false },
  { key: 'env_rating',           label: 'Environment',      always: false, def: false },
  { key: 'status',               label: 'Status',           always: false, def: false },
];

function getSupplierVisibleCols() {
  try {
    const saved = JSON.parse(localStorage.getItem('bop_supplier_cols') || 'null');
    if (saved) return saved;
  } catch(e) {}
  return SUPPLIER_COLUMNS.filter(c => c.def).map(c => c.key);
}

function setSupplierVisibleCols(keys) {
  localStorage.setItem('bop_supplier_cols', JSON.stringify(keys));
}

function renderSupplierColumnSelector(suppliers) {
  const visible = getSupplierVisibleCols();
  const opts = SUPPLIER_COLUMNS.filter(c => !c.always).map(c => `
    <label class="sup-col-option">
      <input type="checkbox" value="${c.key}" ${visible.includes(c.key) ? 'checked' : ''}
        onchange="toggleSupplierColumn('${c.key}',this.checked,${JSON.stringify(suppliers).replace(/"/g,'&quot;')})">
      ${c.label}
    </label>`).join('');
  return `<div class="sup-col-selector-wrap">
    <button type="button" class="btn btn-secondary btn-sm sup-col-toggle" onclick="this.nextElementSibling.classList.toggle('hidden')">
      &#9881; Columns
    </button>
    <div class="sup-col-dropdown hidden">${opts}</div>
  </div>`;
}

function toggleSupplierColumn(key, checked, suppliers) {
  const visible = getSupplierVisibleCols();
  const next = checked ? [...visible, key] : visible.filter(k => k !== key);
  setSupplierVisibleCols(next);
  renderSuppliersTable(suppliers);
}

async function loadSuppliers() {
  const list = document.getElementById('arch-list');
  list.innerHTML = '<div class="empty-state">Loading suppliers…</div>';
  try {
    const suppliers = await api('/api/suppliers');
    renderSuppliersTable(suppliers);
  } catch(err) {
    list.innerHTML = `<div class="empty-state" style="color:var(--danger)">Failed to load suppliers: ${esc(err.message)}</div>`;
  }
}

function renderSuppliersTable(suppliers) {
  const list = document.getElementById('arch-list');
  const visible = getSupplierVisibleCols();
  const cols = SUPPLIER_COLUMNS.filter(c => c.always || visible.includes(c.key));

  // Stats
  const total   = suppliers.length;
  const high    = suppliers.filter(s => s.criticality === 'high').length;
  const expired = suppliers.filter(s => s.contract_status === 'expired').length;
  const noDpa   = suppliers.filter(s => s.dpa_in_place === 'no').length;
  const dueReview = suppliers.filter(s => s.next_review_date && s.next_review_date <= new Date().toISOString().split('T')[0]).length;

  // Category badge map
  const catLabel = { data_processor:'Data Processor', saas:'SaaS', msp:'MSP', cloud:'Cloud',
    hardware:'Hardware', professional_services:'Prof. Services', other:'Other' };
  const critBadge = { high:'badge-high', medium:'badge-medium', low:'badge-low' };
  const contractBadge = { current:'badge-success', expired:'badge-danger', under_renegotiation:'badge-warning', pending:'badge-info' };
  const dpaBadge = { yes:'badge-success', no:'badge-danger', na:'badge-secondary' };
  const remBadge = { open:'badge-secondary', in_progress:'badge-warning', closed:'badge-success' };
  const perfBadge = { excellent:'badge-success', good:'badge-low', acceptable:'badge-warning', poor:'badge-danger' };

  // Grid template: name column is wider, others equal
  const gridCols = cols.map(c => c.key === 'name' ? '2fr' : c.key === 'services_provided' || c.key === 'gaps_identified' ? '1.5fr' : '1fr').join(' ') + ' 44px';

  let html = `
    <div class="stats-grid" style="margin-bottom:20px">
      <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">Total</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--danger)">${high}</div><div class="stat-label">High Criticality</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--warning)">${expired}</div><div class="stat-label">Expired Contracts</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--warning)">${noDpa}</div><div class="stat-label">No DPA</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--info)">${dueReview}</div><div class="stat-label">Review Overdue</div></div>
    </div>
    <div class="sup-toolbar">
      ${renderSupplierColumnSelector(suppliers)}
    </div>`;

  if (!suppliers.length) {
    html += '<div class="empty-state" style="margin-top:24px">No suppliers registered yet. Click <strong>+ Add Supplier</strong> to get started.</div>';
    list.innerHTML = html;
    return;
  }

  html += `<div class="arch-table sup-table">
    <div class="arch-table-head" style="grid-template-columns:${gridCols}">
      ${cols.map(c => `<div>${c.label}</div>`).join('')}
      <div></div>
    </div>`;

  for (const s of suppliers) {
    let meta = {};
    try { meta = JSON.parse(s.metadata || '{}'); } catch(e) {}

    const cells = cols.map(c => {
      const v = c.key.startsWith('quality_rating') ? meta.quality_rating
              : c.key === 'infosec_rating' ? meta.infosec_rating
              : c.key === 'env_rating' ? meta.env_rating
              : s[c.key];
      if (c.key === 'name') {
        return `<div class="arch-col-name" style="cursor:pointer" onclick="openSupplierModal(${s.id})">
          <span class="arch-name" style="color:var(--primary)">${esc(s.name)}</span>
          ${s.services_provided ? `<span class="arch-desc">${esc(s.services_provided.substring(0,60))}${s.services_provided.length>60?'…':''}</span>` : ''}
        </div>`;
      }
      if (c.key === 'criticality') return `<div class="arch-col-detail"><span class="badge ${critBadge[v]||'badge-secondary'}">${v||'—'}</span></div>`;
      if (c.key === 'category') return `<div class="arch-col-detail" style="font-size:12px">${catLabel[v]||v||'—'}</div>`;
      if (c.key === 'contract_status') return `<div class="arch-col-detail"><span class="badge ${contractBadge[v]||'badge-secondary'}" style="font-size:11px">${(v||'').replace('_',' ')||'—'}</span></div>`;
      if (c.key === 'dpa_in_place') return `<div class="arch-col-detail"><span class="badge ${dpaBadge[v]||'badge-secondary'}">${v==='na'?'N/A':v||'—'}</span></div>`;
      if (c.key === 'remediation_status') return `<div class="arch-col-detail"><span class="badge ${remBadge[v]||'badge-secondary'}" style="font-size:11px">${(v||'').replace('_',' ')||'—'}</span></div>`;
      if (c.key === 'quality_rating' || c.key === 'infosec_rating' || c.key === 'env_rating') {
        const rv = c.key === 'quality_rating' ? meta.quality_rating : c.key === 'infosec_rating' ? meta.infosec_rating : meta.env_rating;
        return `<div class="arch-col-detail">${rv ? `<span class="badge ${perfBadge[rv]||'badge-secondary'}" style="font-size:11px">${rv}</span>` : '<span style="color:var(--text-muted);font-size:11px">—</span>'}</div>`;
      }
      if (c.key === 'status') return `<div class="arch-col-detail"><span class="badge ${v==='active'?'badge-low':v==='inactive'?'badge-secondary':'badge-danger'}">${v||'—'}</span></div>`;
      if (c.key === 'next_review_date' || c.key === 'contract_expiry_date' || c.key === 'dpa_review_date') {
        const today = new Date().toISOString().split('T')[0];
        const overdue = v && v < today;
        return `<div class="arch-col-detail" style="font-size:12px;${overdue?'color:var(--danger);font-weight:600':''}${v&&!overdue?'color:var(--warning)':''}">${v||'—'}</div>`;
      }
      if (c.key === 'services_provided' || c.key === 'gaps_identified' || c.key === 'data_classification') {
        return `<div class="arch-col-detail" style="font-size:12px">${v?esc(v.substring(0,50))+(v.length>50?'…':''):'<span style="color:var(--text-muted)">—</span>'}</div>`;
      }
      return `<div class="arch-col-detail" style="font-size:12px">${v?esc(String(v)):'<span style="color:var(--text-muted)">—</span>'}</div>`;
    }).join('');

    html += `<div class="arch-table-row-wrap">
      <div class="arch-table-row" style="grid-template-columns:${gridCols}">
        ${cells}
        <div class="arch-col-actions">
          ${actionMenu([
            { label: '&#9998; Edit', onclick: `openSupplierModal(${s.id})` },
            'sep',
            { label: '&#128465; Delete', onclick: `deleteSupplier(${s.id})`, cls: 'danger' },
          ])}
        </div>
      </div>
    </div>`;
  }

  html += '</div>';
  list.innerHTML = html;
}

// ── Supplier modal ─────────────────────────────────────────────────────────────

let _supplierArchLinkCache = []; // arch items for link picker

async function openSupplierModal(id) {
  document.getElementById('supplier-form').reset();
  document.getElementById('supplier-id').value = '';
  document.getElementById('supplier-modal-title').textContent = 'New Supplier';
  _supplierArchLinkCache = [];
  switchSupplierModalTab('general', document.querySelector('.supplier-modal-tab[data-stab="general"]'));

  // Pre-load arch items for link picker
  try {
    const archTypes = ['role','process','system','asset','facility'];
    const all = await Promise.all(archTypes.map(t => api(`/api/architecture?arch_type=${t}`)));
    archTypes.forEach((t, i) => {
      all[i].forEach(a => _supplierArchLinkCache.push({ id: a.id, type: t, name: a.name }));
    });
  } catch(e) {}

  const picker = document.getElementById('sup-arch-link-picker');
  if (picker) {
    const grouped = {};
    for (const a of _supplierArchLinkCache) {
      if (!grouped[a.type]) grouped[a.type] = [];
      grouped[a.type].push(a);
    }
    picker.innerHTML = '<option value="">&#128279; Link to architecture item…</option>'
      + Object.entries(grouped).map(([type, items]) =>
          `<optgroup label="${archTypeLabels[type]||type}">`
          + items.map(a => `<option value="${type}:${a.id}:${esc(a.name)}">${esc(a.name)}</option>`).join('')
          + '</optgroup>'
        ).join('');
  }

  if (id) {
    const s = await api(`/api/suppliers/${id}`);
    document.getElementById('supplier-modal-title').textContent = esc(s.name);
    document.getElementById('supplier-id').value = s.id;
    // General
    document.getElementById('sup-name').value = s.name || '';
    document.getElementById('sup-status').value = s.status || 'active';
    document.getElementById('sup-category').value = s.category || 'other';
    document.getElementById('sup-criticality').value = s.criticality || 'medium';
    document.getElementById('sup-services').value = s.services_provided || '';
    document.getElementById('sup-notes').value = s.notes || '';
    // Contracts & GDPR
    document.getElementById('sup-contract-status').value = s.contract_status || 'current';
    document.getElementById('sup-contract-expiry').value = s.contract_expiry_date || '';
    document.getElementById('sup-dpa').value = s.dpa_in_place || 'no';
    document.getElementById('sup-dpa-review').value = s.dpa_review_date || '';
    document.getElementById('sup-data-classification').value = s.data_classification || '';
    // Review
    document.getElementById('sup-remediation').value = s.remediation_status || 'open';
    document.getElementById('sup-next-review').value = s.next_review_date || '';
    document.getElementById('sup-gaps').value = s.gaps_identified || '';
    // Metadata fields
    let meta = {};
    try { meta = JSON.parse(s.metadata || '{}'); } catch(e) {}
    const setM = (id, key) => { const el = document.getElementById(id); if (el) el.value = meta[key] || ''; };
    setM('sup-country', 'country'); setM('sup-website', 'website');
    setM('sup-contact-name', 'contact_name'); setM('sup-contact-email', 'contact_email');
    setM('sup-data-subjects', 'data_subjects'); setM('sup-legal-basis', 'legal_basis');
    setM('sup-third-country', 'third_country_transfers'); setM('sup-transfer-mechanism', 'transfer_mechanism');
    setM('sup-breach-contact', 'breach_contact');
    setM('sup-quality-rating', 'quality_rating'); setM('sup-quality-score', 'quality_score');
    setM('sup-quality-date', 'quality_date'); setM('sup-quality-cert', 'quality_cert');
    setM('sup-delivery-pct', 'delivery_pct'); setM('sup-quality-notes', 'quality_notes');
    setM('sup-infosec-rating', 'infosec_rating'); setM('sup-infosec-score', 'infosec_score');
    setM('sup-infosec-date', 'infosec_date'); setM('sup-infosec-cert', 'infosec_cert');
    setM('sup-sec-questionnaire', 'sec_questionnaire'); setM('sup-pentest-date', 'pentest_date');
    setM('sup-infosec-findings', 'infosec_findings');
    setM('sup-env-rating', 'env_rating'); setM('sup-env-score', 'env_score');
    setM('sup-env-date', 'env_date'); setM('sup-env-cert', 'env_cert');
    setM('sup-carbon', 'carbon'); setM('sup-env-notes', 'env_notes');
    // Render saved arch links
    renderSupplierLinks(meta.arch_links || []);
  } else {
    renderSupplierLinks([]);
  }

  document.getElementById('supplier-modal').classList.remove('hidden');
}

function closeSupplierModal() {
  document.getElementById('supplier-modal').classList.add('hidden');
}

function switchSupplierModalTab(tab, btn) {
  document.querySelectorAll('.supplier-modal-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.supplier-modal-panel').forEach(p => p.classList.add('hidden'));
  if (btn) btn.classList.add('active');
  const panel = document.getElementById(`stab-${tab}`);
  if (panel) panel.classList.remove('hidden');
}

let _supplierLinks = []; // [{ type, id, name }]

function renderSupplierLinks(links) {
  _supplierLinks = links || [];
  const el = document.getElementById('sup-arch-links-list');
  if (!el) return;
  if (!_supplierLinks.length) { el.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">No linked items</span>'; return; }
  const typeIcons = { role:'&#128100;', process:'&#9881;', system:'&#128187;', asset:'&#128230;', facility:'&#127970;' };
  el.innerHTML = _supplierLinks.map((l, i) => `
    <span class="sup-link-chip">
      ${typeIcons[l.type]||'&#128279;'} ${esc(l.name)}
      <button type="button" onclick="removeSupplierLink(${i})" style="background:none;border:none;cursor:pointer;color:var(--text-muted);padding:0 0 0 4px;font-size:12px">&times;</button>
    </span>`).join('');
}

function addSupplierArchLink(sel) {
  const val = sel.value; if (!val) return;
  const [type, id, name] = val.split(':');
  if (!_supplierLinks.find(l => l.type === type && String(l.id) === id)) {
    _supplierLinks.push({ type, id: parseInt(id), name });
    renderSupplierLinks(_supplierLinks);
  }
  sel.value = '';
}

function removeSupplierLink(idx) {
  _supplierLinks.splice(idx, 1);
  renderSupplierLinks(_supplierLinks);
}

async function saveSupplier(e) {
  e.preventDefault();
  const id = document.getElementById('supplier-id').value;
  const getV = (elId) => { const el = document.getElementById(elId); return el ? el.value : ''; };

  const metadata = {
    country: getV('sup-country'), website: getV('sup-website'),
    contact_name: getV('sup-contact-name'), contact_email: getV('sup-contact-email'),
    data_subjects: getV('sup-data-subjects'), legal_basis: getV('sup-legal-basis'),
    third_country_transfers: getV('sup-third-country'), transfer_mechanism: getV('sup-transfer-mechanism'),
    breach_contact: getV('sup-breach-contact'),
    quality_rating: getV('sup-quality-rating'), quality_score: getV('sup-quality-score'),
    quality_date: getV('sup-quality-date'), quality_cert: getV('sup-quality-cert'),
    delivery_pct: getV('sup-delivery-pct'), quality_notes: getV('sup-quality-notes'),
    infosec_rating: getV('sup-infosec-rating'), infosec_score: getV('sup-infosec-score'),
    infosec_date: getV('sup-infosec-date'), infosec_cert: getV('sup-infosec-cert'),
    sec_questionnaire: getV('sup-sec-questionnaire'), pentest_date: getV('sup-pentest-date'),
    infosec_findings: getV('sup-infosec-findings'),
    env_rating: getV('sup-env-rating'), env_score: getV('sup-env-score'),
    env_date: getV('sup-env-date'), env_cert: getV('sup-env-cert'),
    carbon: getV('sup-carbon'), env_notes: getV('sup-env-notes'),
    arch_links: _supplierLinks,
  };

  const body = {
    name: getV('sup-name'),
    category: getV('sup-category'),
    criticality: getV('sup-criticality'),
    services_provided: getV('sup-services'),
    data_classification: getV('sup-data-classification'),
    contract_status: getV('sup-contract-status'),
    contract_expiry_date: getV('sup-contract-expiry') || null,
    dpa_in_place: getV('sup-dpa'),
    dpa_review_date: getV('sup-dpa-review') || null,
    gaps_identified: getV('sup-gaps'),
    remediation_status: getV('sup-remediation'),
    next_review_date: getV('sup-next-review') || null,
    status: getV('sup-status'),
    notes: getV('sup-notes'),
    metadata: JSON.stringify(metadata),
  };

  try {
    if (id) {
      await api(`/api/suppliers/${id}`, { method: 'PUT', body });
    } else {
      await api('/api/suppliers', { method: 'POST', body });
    }
    closeSupplierModal();
    loadSuppliers();
  } catch(err) {
    alert('Failed to save supplier: ' + err.message);
  }
}

async function deleteSupplier(id) {
  if (!confirm('Delete this supplier? This cannot be undone.')) return;
  await api(`/api/suppliers/${id}`, { method: 'DELETE' });
  loadSuppliers();
}

// --- Organization Chart ---
function renderOrgChart(roles) {
  const chart = document.getElementById('org-chart');

  if (!roles || roles.length === 0) {
    chart.innerHTML = `
      <div class="org-chart-empty">
        <div class="org-chart-empty-icon">&#128101;</div>
        <div class="org-chart-empty-text">No roles defined yet. Add roles to see the organizational hierarchy.</div>
      </div>`;
    return;
  }

  // Build hierarchy tree
  const rolesByName = {};
  const childrenMap = {}; // parent name -> children
  const topLevel = []; // roles with no manager or manager not in list

  // Index roles by name
  for (const r of roles) {
    rolesByName[r.name] = r;
    childrenMap[r.name] = [];
  }

  // Build parent-child relationships using "owner" field (which is now "Reports to")
  for (const r of roles) {
    if (r.owner && rolesByName[r.owner]) {
      childrenMap[r.owner].push(r);
    } else {
      topLevel.push(r);
    }
  }

  // Sort children alphabetically
  for (const name of Object.keys(childrenMap)) {
    childrenMap[name].sort((a, b) => a.name.localeCompare(b.name));
  }
  topLevel.sort((a, b) => a.name.localeCompare(b.name));

  // Render the chart
  let html = '';

  if (topLevel.length === 0) {
    // Circular reference or all roles report to each other
    html = `
      <div class="org-chart-empty">
        <div class="org-chart-empty-icon">&#9888;</div>
        <div class="org-chart-empty-text">Unable to determine hierarchy. Check that "Reports to" relationships are correctly configured.</div>
      </div>`;
  } else {
    // Render each top-level node with its subtree
    html = '<div class="org-level">';
    for (const role of topLevel) {
      html += renderOrgNode(role, childrenMap, true);
    }
    html += '</div>';
  }

  chart.innerHTML = html;
  chart.style.transform = `scale(${orgChartZoom})`;
}

function renderOrgNode(role, childrenMap, isTopLevel = false, depth = 0) {
  let meta = {};
  try { meta = JSON.parse(role.metadata || '{}'); } catch(e) {}

  const children = childrenMap[role.name] || [];
  const directReports = children.length;
  const statusClass = role.status !== 'active' ? ` status-${role.status}` : '';
  const topClass = isTopLevel ? ' top-level' : '';

  // Color variations based on depth
  const depthColors = [
    '', // depth 0 - uses top-level or default
    'background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);', // depth 1 - blue
    'background: linear-gradient(135deg, #10b981 0%, #059669 100%);', // depth 2 - green
    'background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);', // depth 3 - amber
    'background: linear-gradient(135deg, #ec4899 0%, #db2777 100%);', // depth 4 - pink
    'background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);', // depth 5+ - purple
  ];
  const depthStyle = !isTopLevel && depth > 0 ? depthColors[Math.min(depth, 5)] : '';

  let contact = '';
  const displayContactName = meta.assigned_user_name || meta.contact_name || '';
  const isLinkedUser = !!meta.assigned_user_id;
  if (displayContactName || meta.contact_email) {
    const parts = [displayContactName, meta.contact_email].filter(Boolean);
    contact = `<div class="org-node-contact">${isLinkedUser ? '&#128100; ' : ''}${esc(parts.join(' · '))}</div>`;
  }

  let html = `
    <div class="org-node-container">
      <div class="org-node${statusClass}${topClass}" onclick="openArchModal(${role.id})" title="Click to edit"${depthStyle ? ` style="${depthStyle}"` : ''}>
        ${directReports > 0 ? `<span class="org-node-badge">${directReports}</span>` : ''}
        <div class="org-node-name">${esc(role.name)}</div>
        ${role.description ? `<div class="org-node-title">${esc(role.description.substring(0, 50))}${role.description.length > 50 ? '...' : ''}</div>` : ''}
        ${contact}
      </div>`;

  if (children.length > 0) {
    html += '<div class="org-connector-down"></div>';
    html += `<div class="org-children" data-child-count="${children.length}">`;
    for (const child of children) {
      html += renderOrgNode(child, childrenMap, false, depth + 1);
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function toggleOrgChart() {
  const container = document.getElementById('org-chart-container');
  const arrow = document.getElementById('org-chart-arrow');
  if (container.classList.contains('collapsed')) {
    container.classList.remove('collapsed');
    arrow.classList.remove('collapsed');
  } else {
    container.classList.add('collapsed');
    arrow.classList.add('collapsed');
  }
}

function zoomOrgChart(delta) {
  orgChartZoom = Math.max(0.3, Math.min(2, orgChartZoom + delta));
  const chart = document.getElementById('org-chart');
  chart.style.transform = `scale(${orgChartZoom})`;
  document.getElementById('org-chart-zoom-level').textContent = Math.round(orgChartZoom * 100) + '%';
}

function resetOrgChartZoom() {
  orgChartZoom = 1;
  const chart = document.getElementById('org-chart');
  chart.style.transform = `scale(1)`;
  document.getElementById('org-chart-zoom-level').textContent = '100%';
}

// --- Facilities Map ---
let facilitiesMap = null;
let facilitiesMapMarkers = [];
let facilitiesMapCollapsed = false;

function renderFacilitiesMap(facilities) {
  const mapContainer = document.getElementById('facilities-map');
  const emptyState = document.getElementById('facilities-map-empty');
  const mapWrapper = document.getElementById('facilities-map-container');

  // Filter facilities that have coordinates
  const facilitiesWithCoords = facilities.filter(f => {
    let meta = {};
    try { meta = JSON.parse(f.metadata || '{}'); } catch(e) {}
    return meta.latitude && meta.longitude;
  });

  if (facilitiesWithCoords.length === 0) {
    mapWrapper.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }

  mapWrapper.classList.remove('hidden');
  emptyState.classList.add('hidden');

  // Initialize map if not exists
  if (!facilitiesMap) {
    facilitiesMap = L.map('facilities-map', {
      scrollWheelZoom: true,
      zoomControl: true
    }).setView([52.0, 5.0], 6);

    // Add tile layer (OpenStreetMap)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19
    }).addTo(facilitiesMap);
  }

  // Clear existing markers
  facilitiesMapMarkers.forEach(m => facilitiesMap.removeLayer(m));
  facilitiesMapMarkers = [];

  // Add markers for each facility
  const bounds = [];
  facilitiesWithCoords.forEach(facility => {
    let meta = {};
    try { meta = JSON.parse(facility.metadata || '{}'); } catch(e) {}

    const lat = meta.latitude;
    const lng = meta.longitude;
    const status = facility.status || 'active';

    // Custom marker icon based on status
    const markerColor = status === 'active' ? '#10b981' : status === 'planned' ? '#f59e0b' : '#6b7280';
    const markerIcon = L.divIcon({
      className: 'facility-marker',
      html: `<div class="facility-marker-pin" style="background:${markerColor}">
               <span class="facility-marker-icon">&#127970;</span>
             </div>`,
      iconSize: [36, 42],
      iconAnchor: [18, 42],
      popupAnchor: [0, -42]
    });

    const marker = L.marker([lat, lng], { icon: markerIcon })
      .addTo(facilitiesMap)
      .bindPopup(`
        <div class="facility-popup">
          <strong>${esc(facility.name)}</strong>
          <span class="popup-status ${status}">${status}</span>
          ${meta.address ? `<div class="popup-address">${esc(meta.address)}</div>` : ''}
          ${facility.owner ? `<div class="popup-owner">Owner: ${esc(facility.owner)}</div>` : ''}
          <button class="popup-btn" onclick="openArchModal(${facility.id})">&#9998; Edit</button>
        </div>
      `);

    facilitiesMapMarkers.push(marker);
    bounds.push([lat, lng]);
  });

  // Fit map to show all markers
  if (bounds.length > 0) {
    if (bounds.length === 1) {
      facilitiesMap.setView(bounds[0], 14);
    } else {
      facilitiesMap.fitBounds(bounds, { padding: [30, 30] });
    }
  }

  // Invalidate size after a small delay (for proper rendering)
  setTimeout(() => {
    if (facilitiesMap) facilitiesMap.invalidateSize();
  }, 100);
}

function toggleFacilitiesMap() {
  const container = document.getElementById('facilities-map-container');
  const emptyState = document.getElementById('facilities-map-empty');
  const arrow = document.getElementById('facilities-map-arrow');

  facilitiesMapCollapsed = !facilitiesMapCollapsed;

  if (facilitiesMapCollapsed) {
    container.style.display = 'none';
    emptyState.style.display = 'none';
    arrow.innerHTML = '&#9654;';
  } else {
    container.style.display = '';
    emptyState.style.display = '';
    arrow.innerHTML = '&#9660;';
    if (facilitiesMap) {
      setTimeout(() => facilitiesMap.invalidateSize(), 100);
    }
  }
}

function centerMapOnFacilities() {
  if (facilitiesMap && facilitiesMapMarkers.length > 0) {
    const bounds = facilitiesMapMarkers.map(m => m.getLatLng());
    if (bounds.length === 1) {
      facilitiesMap.setView(bounds[0], 14);
    } else {
      facilitiesMap.fitBounds(bounds, { padding: [30, 30] });
    }
  }
}

function refreshFacilitiesMap() {
  loadArchitecture();
}

async function geocodeFacilityAddress() {
  const addressField = document.getElementById('arch-address');
  const latField = document.getElementById('arch-latitude');
  const lngField = document.getElementById('arch-longitude');

  const address = addressField.value.trim();
  if (!address) {
    alert('Please enter an address first.');
    return;
  }

  try {
    // Use Nominatim (OpenStreetMap) geocoding service
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`, {
      headers: { 'User-Agent': 'LetTheFrameWork/1.0' }
    });
    const results = await response.json();

    if (results.length > 0) {
      latField.value = parseFloat(results[0].lat).toFixed(6);
      lngField.value = parseFloat(results[0].lon).toFixed(6);
      alert(`Coordinates found:\nLatitude: ${latField.value}\nLongitude: ${lngField.value}`);
    } else {
      alert('Could not find coordinates for this address. Please enter them manually.');
    }
  } catch (err) {
    alert('Geocoding failed: ' + err.message);
  }
}

function buildArchTableHeader(archType) {
  const headers = {
    role:       ['Name', 'Contact', 'Reports to', 'Status', 'Links', ''],
    process:    ['Name', 'Description', 'Owner', 'Status', 'Links', ''],
    system:     ['Name', 'Criticality', 'Owner', 'Status', 'Links', ''],
    asset:      ['Name', 'Description', 'Owner', 'Status', 'Links', ''],
    facility:   ['Name', 'Address', 'Owner', 'Status', 'Links', ''],
    ai_model:   ['Name', 'Type / Provider', 'Owner', 'Status', 'Links', ''],
    ai_dataset: ['Name', 'Classification', 'Owner', 'Status', 'Links', ''],
    ai_usecase: ['Name', 'Domain / Approach', 'Owner', 'Status', 'Links', ''],
  };
  const cols = headers[archType] || headers.role;
  return `<div class="arch-table-head">
    ${cols.map((c, i) => `<div class="arch-col-${i === 0 ? 'name' : i === cols.length - 1 ? 'actions' : 'detail'}">${c}</div>`).join('')}
  </div>`;
}

function buildArchTableRow(item, meta, links, archType) {
  const stBadge = item.status === 'active' ? 'badge-low' : item.status === 'planned' ? 'badge-medium' : 'badge-inactive';
  const linkCount = links.length;

  let detailCol = '';
  if (archType === 'role') {
    const displayName = meta.assigned_user_name || meta.contact_name || '';
    const displayEmail = meta.contact_email || '';
    const isLinkedUser = !!meta.assigned_user_id;
    const contact = [displayName, displayEmail].filter(Boolean).join(' · ');
    detailCol = contact
      ? `<span style="font-size:12px">${isLinkedUser ? '<span class="arch-user-badge" title="Linked to app user">&#128100;</span> ' : ''}${esc(contact)}</span>`
      : '<span style="color:var(--text-muted);font-size:11px">-</span>';
  } else if (archType === 'system') {
    if (meta.criticality) {
      const critBadge = meta.criticality === 'critical' ? 'badge-critical' : meta.criticality === 'high' ? 'badge-high' : meta.criticality === 'medium' ? 'badge-medium' : 'badge-low';
      detailCol = `<span class="badge ${critBadge}">${meta.criticality}</span>`;
    } else {
      detailCol = '<span style="color:var(--text-muted);font-size:11px">-</span>';
    }
  } else if (archType === 'facility') {
    detailCol = meta.address ? `<span style="font-size:12px">${esc(meta.address.substring(0, 40))}${meta.address.length > 40 ? '...' : ''}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>';
  } else if (archType === 'ai_model') {
    const tierBadge = { Minimal: 'badge-low', Limited: 'badge-medium', High: 'badge-high', Unacceptable: 'badge-critical' }[meta.risk_tier] || '';
    const parts = [meta.model_type, meta.provider].filter(Boolean);
    detailCol = `<span style="font-size:12px">${parts.length ? esc(parts.join(' · ')) : ''}</span>${meta.risk_tier ? ` <span class="badge ${tierBadge}" style="margin-left:4px">${esc(meta.risk_tier)}</span>` : ''}` || '<span style="color:var(--text-muted);font-size:11px">-</span>';
  } else if (archType === 'ai_dataset') {
    const clsBadge = { Public: 'badge-low', Internal: 'badge-medium', Confidential: 'badge-high', Restricted: 'badge-critical' }[meta.classification] || '';
    detailCol = meta.classification
      ? `<span class="badge ${clsBadge}">${esc(meta.classification)}</span>${meta.contains_pii === 'Yes' ? ' <span class="badge badge-high" style="margin-left:4px">PII</span>' : ''}`
      : '<span style="color:var(--text-muted);font-size:11px">-</span>';
  } else if (archType === 'ai_usecase') {
    const tierBadge = { Minimal: 'badge-low', Limited: 'badge-medium', High: 'badge-high', Unacceptable: 'badge-critical' }[meta.risk_tier] || '';
    const parts = [meta.domain, meta.ai_approach].filter(Boolean);
    detailCol = `<span style="font-size:12px">${parts.length ? esc(parts.join(' · ')) : ''}</span>${meta.risk_tier ? ` <span class="badge ${tierBadge}" style="margin-left:4px">${esc(meta.risk_tier)}</span>` : ''}` || '<span style="color:var(--text-muted);font-size:11px">-</span>';
  } else {
    detailCol = item.description ? `<span style="font-size:12px">${esc(item.description.substring(0, 50))}${item.description.length > 50 ? '...' : ''}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>';
  }

  // Build links detail section
  const linksDetailId = `arch-links-${archType}-${item.id}`;
  let linksDetail = '';
  if (linkCount > 0) {
    const typeIcons = { role: '&#128100;', process: '&#9881;', system: '&#128187;', asset: '&#128230;', facility: '&#127970;', document: '&#128196;', risk: '&#9888;', task: '&#9745;', requirement: '&#128203;', ai_model: '&#129302;', ai_dataset: '&#128202;', ai_usecase: '&#127919;' };
    const grouped = {};
    for (const l of links) {
      if (!grouped[l.type]) grouped[l.type] = [];
      grouped[l.type].push(l);
    }
    linksDetail = Object.entries(grouped).map(([type, items]) => `
      <div class="arch-link-group">
        <span class="arch-link-type">${typeIcons[type] || '&#128279;'} ${type}s</span>
        ${items.map(l => `<span class="arch-link-item">${esc(l.name)}</span>`).join('')}
      </div>
    `).join('');
  }

  const isProcess  = archType === 'process';
  const isUseCase  = archType === 'ai_usecase';
  const kpiPanelId = `proc-kpi-panel-${item.id}`;

  // ai_usecase items are managed in the Kanban board; clicking opens the Kanban modal
  const nameClickHandler = isUseCase
    ? `openUseCaseModal(${item.id})`
    : `openArchModal(${item.id})`;

  // Stage badge for ai_usecase items
  const ucStageColors = { new:'#6b7280', assessment:'#f59e0b', approved:'#3b82f6', development:'#8b5cf6', production:'#10b981', retired:'#94a3b8' };
  const ucStageLabels = { new:'New', assessment:'Under Assessment', approved:'Approved', development:'In Development', production:'In Production', retired:'Retired' };
  const statusCell = isUseCase
    ? (() => { const c = ucStageColors[item.status]||'#6b7280'; const l = ucStageLabels[item.status]||item.status; return `<span class="badge" style="background:${c}18;color:${c};border:1px solid ${c}40;font-size:11px">${l}</span>`; })()
    : `<span class="badge ${stBadge}">${item.status}</span>`;

  return `<div class="arch-table-row-wrap">
    <div class="arch-table-row">
      <div class="arch-col-name" onclick="${nameClickHandler}" style="cursor:pointer">
        <span class="arch-name" style="color:var(--primary)">${esc(item.name)}</span>
        ${archType === 'role' && item.description ? `<span class="arch-desc">${esc(item.description)}</span>` : ''}
        ${isProcess ? `<div class="proc-row-toggles" onclick="event.stopPropagation()">
          <span class="arch-link-toggle" onclick="toggleProcessKpiPanel(${item.id})">KPIs &amp; Objectives <span class="arch-link-arrow" id="proc-kpi-arrow-${item.id}">&#9660;</span></span>
          <span class="arch-link-toggle" onclick="toggleProcessFlowchartPanel(${item.id})">Flowchart <span class="arch-link-arrow" id="proc-flowchart-arrow-${item.id}">&#9660;</span></span>
        </div>` : ''}
        ${isUseCase ? `<span style="font-size:10px;color:var(--text-muted)">&#8599; Managed in Kanban</span>` : ''}
      </div>
      <div class="arch-col-detail">${detailCol}</div>
      <div class="arch-col-detail"><span style="font-size:12px">${item.owner ? esc(item.owner) : '-'}</span></div>
      <div class="arch-col-detail">${statusCell}</div>
      <div class="arch-col-detail arch-col-links">
        ${linkCount > 0 ? `<span class="arch-link-toggle" onclick="toggleArchLinks('${linksDetailId}')">${linkCount} link${linkCount !== 1 ? 's' : ''} <span class="arch-link-arrow" id="${linksDetailId}-arrow">&#9660;</span></span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}
      </div>
      <div class="arch-col-actions">
        ${isUseCase ? actionMenu([
          { label: '&#128279; Link Items', onclick: `openCrossLinkPicker('ai_usecase',${item.id},'arch-expand-${item.id}')` },
          { label: '&#127919; Open in Kanban', onclick: `openUseCaseModal(${item.id})` },
          'sep',
          { label: '&#128465; Delete', onclick: `deleteArch(${item.id})`, cls: 'danger' },
        ]) : actionMenu([
          { label: '&#128279; Link Items', onclick: `openCrossLinkPicker('${archType}',${item.id},'arch-expand-${item.id}')` },
          { label: '&#9998; Edit', onclick: `openArchModal(${item.id})` },
          'sep',
          { label: '&#128465; Delete', onclick: `deleteArch(${item.id})`, cls: 'danger' },
        ])}
      </div>
    </div>
    ${linkCount > 0 ? `<div class="arch-links-detail collapsed" id="${linksDetailId}">${linksDetail}</div>` : ''}
    ${isProcess ? `<div class="proc-kpi-panel" id="${kpiPanelId}"></div>` : ''}
    ${isProcess ? `<div class="proc-flowchart-panel" id="proc-flowchart-panel-${item.id}"></div>` : ''}
  </div>`;
}

function toggleArchLinks(detailId) {
  const detail = document.getElementById(detailId);
  const arrow = document.getElementById(detailId + '-arrow');
  if (detail.classList.contains('collapsed')) {
    detail.classList.remove('collapsed');
    arrow.innerHTML = '&#9650;';
  } else {
    detail.classList.add('collapsed');
    arrow.innerHTML = '&#9660;';
  }
}

async function openArchModal(id) {
  document.getElementById('arch-form').reset();
  document.getElementById('arch-id').value = '';
  document.getElementById('arch-modal-title').textContent = 'New Item';
  document.getElementById('arch-type').value = currentArchTab;

  // Update owner label and placeholder based on type
  const isRole = currentArchTab === 'role';
  document.getElementById('arch-owner-label').textContent = isRole ? 'Reports to' : 'Owner';

  // Populate owner dropdown with roles
  const roles = await api('/api/architecture?arch_type=role');
  const ownerSelect = document.getElementById('arch-owner');
  const placeholder = isRole ? '-- Select Manager --' : '-- Select Owner --';
  ownerSelect.innerHTML = `<option value="">${placeholder}</option>` +
    roles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');

  let metadata = {};
  let savedOwner = '';
  if (id) {
    const items = await api(`/api/architecture?arch_type=${currentArchTab}`);
    const item = items.find(x => x.id === id);
    if (item) {
      document.getElementById('arch-modal-title').textContent = 'Edit Item';
      document.getElementById('arch-id').value = item.id;
      document.getElementById('arch-type').value = item.arch_type;
      document.getElementById('arch-name').value = item.name;
      document.getElementById('arch-description').value = item.description;
      savedOwner = item.owner;
      document.getElementById('arch-status').value = item.status;
      try { metadata = JSON.parse(item.metadata || '{}'); } catch(e) { metadata = {}; }
    }
  }
  // Set owner after dropdown is populated
  document.getElementById('arch-owner').value = savedOwner;

  // Render type-specific fields
  const extraFields = document.getElementById('arch-extra-fields');
  const archType = document.getElementById('arch-type').value;
  if (archType === 'role') {
    // Fetch org users for the assigned-user picker
    let orgUsers = [];
    try { orgUsers = await api('/api/org-users'); } catch (e) {}

    const assignedUserId = metadata.assigned_user_id || '';
    const userOptions = orgUsers.map(u =>
      `<option value="${u.id}" data-name="${esc(u.name)}" data-email="${esc(u.email)}" ${String(u.id) === String(assignedUserId) ? 'selected' : ''}>${esc(u.name)}${u.email ? ' — ' + esc(u.email) : ''}</option>`
    ).join('');

    extraFields.innerHTML = `
      <div class="form-group arch-assigned-user-group">
        <label>Assigned User <span class="field-hint" style="font-weight:400">(optional – links this role to an app user)</span></label>
        <select id="arch-assigned-user" onchange="onArchAssignedUserChange()">
          <option value="">— No user assigned —</option>
          ${userOptions}
        </select>
      </div>
      <div class="form-divider"><span>Contact Details</span></div>
      <div class="form-row">
        <div class="form-group"><label>Contact Name</label><input type="text" id="arch-contact-name" value="${esc(metadata.contact_name || '')}" placeholder="Full name of person in this role"></div>
        <div class="form-group"><label>Contact Email</label><input type="email" id="arch-contact-email" value="${esc(metadata.contact_email || '')}" placeholder="Email address"></div>
      </div>
      <div class="form-group"><label>Contact Phone</label><input type="text" id="arch-contact-phone" value="${esc(metadata.contact_phone || '')}" placeholder="Phone number"></div>`;
  } else if (archType === 'system') {
    extraFields.innerHTML = `
      <div class="form-group"><label>Criticality</label>
        <select id="arch-criticality">
          <option value="" ${!metadata.criticality?'selected':''}>-- Select --</option>
          <option value="critical" ${metadata.criticality==='critical'?'selected':''}>Critical</option>
          <option value="high" ${metadata.criticality==='high'?'selected':''}>High</option>
          <option value="medium" ${metadata.criticality==='medium'?'selected':''}>Medium</option>
          <option value="low" ${metadata.criticality==='low'?'selected':''}>Low</option>
        </select>
      </div>`;
  } else if (archType === 'facility') {
    extraFields.innerHTML = `
      <div class="form-group">
        <label>Address</label>
        <textarea id="arch-address" rows="2" placeholder="Street address, city, country">${esc(metadata.address || '')}</textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Latitude</label>
          <input type="number" step="any" id="arch-latitude" value="${metadata.latitude || ''}" placeholder="e.g. 52.3676">
        </div>
        <div class="form-group">
          <label>Longitude</label>
          <input type="number" step="any" id="arch-longitude" value="${metadata.longitude || ''}" placeholder="e.g. 4.9041">
        </div>
      </div>
      <div class="form-group">
        <button type="button" class="btn btn-secondary btn-sm" onclick="geocodeFacilityAddress()" style="margin-top:4px">
          &#128205; Get Coordinates from Address
        </button>
        <span class="field-hint">Enter coordinates manually or click to auto-detect from address</span>
      </div>`;
  } else if (archType === 'ai_model') {
    const regFlags = Array.isArray(metadata.regulatory_flags) ? metadata.regulatory_flags : [];
    extraFields.innerHTML = `
      <div class="form-divider"><span>AI Model Details</span></div>
      <div class="form-row">
        <div class="form-group">
          <label>Provider / Vendor</label>
          <input type="text" id="arch-ai-provider" value="${esc(metadata.provider || '')}" placeholder="e.g. Anthropic, OpenAI, Internal">
        </div>
        <div class="form-group">
          <label>Version</label>
          <input type="text" id="arch-ai-version" value="${esc(metadata.version || '')}" placeholder="e.g. gpt-4o, claude-3-opus">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Model Type</label>
          <select id="arch-ai-model-type">
            <option value="">-- Select --</option>
            ${['LLM','Classification','Regression','Computer Vision','NLP','Recommendation','Multimodal','Other'].map(v => `<option value="${v}" ${metadata.model_type===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Deployment Environment</label>
          <select id="arch-ai-deploy-env">
            <option value="">-- Select --</option>
            ${['SaaS / API','Cloud (self-hosted)','On-premise','Hybrid'].map(v => `<option value="${v}" ${metadata.deployment_env===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-divider"><span>AI Governance &amp; Risk</span></div>
      <div class="form-row">
        <div class="form-group">
          <label>Risk Tier (EU AI Act)</label>
          <select id="arch-ai-risk-tier">
            <option value="">-- Select --</option>
            ${['Minimal','Limited','High','Unacceptable'].map(v => `<option value="${v}" ${metadata.risk_tier===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Explainability</label>
          <select id="arch-ai-explainability">
            <option value="">-- Select --</option>
            ${['Black box','Interpretable','Fully explainable'].map(v => `<option value="${v}" ${metadata.explainability===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Bias Assessment</label>
          <select id="arch-ai-bias">
            <option value="">-- Select --</option>
            ${['Not done','In progress','Passed','Failed'].map(v => `<option value="${v}" ${metadata.bias_assessment===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Last Evaluated</label>
          <input type="date" id="arch-ai-last-evaluated" value="${esc(metadata.last_evaluated || '')}">
        </div>
      </div>
      <div class="form-group">
        <label>Regulatory Frameworks</label>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:6px">
          ${['EU AI Act','NIST AI RMF','ISO 42001'].map(f => `<label style="font-weight:400;display:flex;align-items:center;gap:6px"><input type="checkbox" class="arch-ai-reg-flag" value="${f}" ${regFlags.includes(f)?'checked':''}> ${f}</label>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label>Performance &amp; Notes</label>
        <textarea id="arch-ai-perf-notes" rows="2" placeholder="Accuracy metrics, known limitations, monitoring approach…">${esc(metadata.performance_notes || '')}</textarea>
      </div>`;
  } else if (archType === 'ai_dataset') {
    extraFields.innerHTML = `
      <div class="form-divider"><span>Dataset Details</span></div>
      <div class="form-row">
        <div class="form-group">
          <label>Classification</label>
          <select id="arch-ds-classification">
            <option value="">-- Select --</option>
            ${['Public','Internal','Confidential','Restricted'].map(v => `<option value="${v}" ${metadata.classification===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Data Type</label>
          <select id="arch-ds-data-type">
            <option value="">-- Select --</option>
            ${['Structured','Unstructured','Semi-structured','Time-series','Image','Audio','Video'].map(v => `<option value="${v}" ${metadata.data_type===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Contains Personal Data (PII)</label>
          <select id="arch-ds-pii">
            <option value="">-- Select --</option>
            <option value="No" ${metadata.contains_pii==='No'?'selected':''}>No</option>
            <option value="Yes" ${metadata.contains_pii==='Yes'?'selected':''}>Yes</option>
          </select>
        </div>
        <div class="form-group">
          <label>Special Categories (GDPR Art. 9)</label>
          <input type="text" id="arch-ds-special-cats" value="${esc(metadata.special_categories || '')}" placeholder="e.g. Health, Biometric, Financial">
        </div>
      </div>
      <div class="form-divider"><span>Data Governance</span></div>
      <div class="form-row">
        <div class="form-group">
          <label>Legal Basis for Processing</label>
          <select id="arch-ds-legal-basis">
            <option value="">-- Select --</option>
            ${['Consent','Contract','Legal obligation','Legitimate interest','Vital interests','Not applicable'].map(v => `<option value="${v}" ${metadata.legal_basis===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Jurisdiction</label>
          <input type="text" id="arch-ds-jurisdiction" value="${esc(metadata.jurisdiction || '')}" placeholder="e.g. EU, US, Global">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Retention Period</label>
          <input type="text" id="arch-ds-retention" value="${esc(metadata.retention_period || '')}" placeholder="e.g. 3 years, Until model retirement">
        </div>
        <div class="form-group">
          <label>Access Level</label>
          <select id="arch-ds-access-level">
            <option value="">-- Select --</option>
            ${['Open','Restricted','Need-to-know'].map(v => `<option value="${v}" ${metadata.access_level===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Format</label>
          <input type="text" id="arch-ds-format" value="${esc(metadata.format || '')}" placeholder="e.g. CSV, Parquet, JSON, Unstructured">
        </div>
        <div class="form-group">
          <label>Approximate Volume</label>
          <input type="text" id="arch-ds-volume" value="${esc(metadata.volume_approx || '')}" placeholder="e.g. ~5M rows, 2 TB">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Data Quality Score (1–5)</label>
          <select id="arch-ds-quality">
            <option value="">-- Select --</option>
            ${['1','2','3','4','5'].map(v => `<option value="${v}" ${metadata.data_quality_score===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Last Reviewed</label>
          <input type="date" id="arch-ds-last-reviewed" value="${esc(metadata.last_reviewed || '')}">
        </div>
      </div>`;
  } else if (archType === 'ai_usecase') {
    extraFields.innerHTML = `
      <div class="form-divider"><span>Use Case Details</span></div>
      <div class="form-row">
        <div class="form-group">
          <label>Business Domain</label>
          <select id="arch-uc-domain">
            <option value="">-- Select --</option>
            ${['HR','Finance','Operations','Customer Service','Legal','IT','R&D','Marketing','Other'].map(v => `<option value="${v}" ${metadata.domain===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>AI Approach</label>
          <select id="arch-uc-approach">
            <option value="">-- Select --</option>
            ${['Generative AI','Supervised Learning','Unsupervised Learning','Reinforcement Learning','RPA','Rules-based','Other'].map(v => `<option value="${v}" ${metadata.ai_approach===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-divider"><span>AI Governance &amp; Risk</span></div>
      <div class="form-row">
        <div class="form-group">
          <label>Risk Tier (EU AI Act)</label>
          <select id="arch-uc-risk-tier">
            <option value="">-- Select --</option>
            ${['Minimal','Limited','High','Unacceptable'].map(v => `<option value="${v}" ${metadata.risk_tier===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Human Oversight</label>
          <select id="arch-uc-oversight">
            <option value="">-- Select --</option>
            ${['Required','Optional','None'].map(v => `<option value="${v}" ${metadata.human_oversight===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Governance Approval</label>
          <select id="arch-uc-approval">
            <option value="">-- Select --</option>
            ${['Not started','Pending','Approved','Rejected'].map(v => `<option value="${v}" ${metadata.governance_approval===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Incident Reporting in Place</label>
          <select id="arch-uc-incident">
            <option value="">-- Select --</option>
            <option value="Yes" ${metadata.incident_reporting==='Yes'?'selected':''}>Yes</option>
            <option value="No" ${metadata.incident_reporting==='No'?'selected':''}>No</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Approval Date</label>
          <input type="date" id="arch-uc-approval-date" value="${esc(metadata.approval_date || '')}">
        </div>
        <div class="form-group">
          <label>Next Review Date</label>
          <input type="date" id="arch-uc-review-date" value="${esc(metadata.next_review_date || '')}">
        </div>
      </div>
      <div class="form-group">
        <label>Business Value</label>
        <textarea id="arch-uc-value" rows="2" placeholder="What benefit does this AI use case deliver?">${esc(metadata.business_value || '')}</textarea>
      </div>
      <div class="form-group">
        <label>Success KPIs</label>
        <textarea id="arch-uc-kpis" rows="2" placeholder="How is success measured?">${esc(metadata.success_kpis || '')}</textarea>
      </div>
      <div class="form-group">
        <label>Fallback Process</label>
        <textarea id="arch-uc-fallback" rows="2" placeholder="What happens if the AI system fails or is unavailable?">${esc(metadata.fallback_process || '')}</textarea>
      </div>`;
  } else {
    extraFields.innerHTML = '';
  }

  document.getElementById('arch-modal').classList.remove('hidden');
}
function closeArchModal() { document.getElementById('arch-modal').classList.add('hidden'); }

// Auto-populate contact fields when an org user is selected for a role
function onArchAssignedUserChange() {
  const sel = document.getElementById('arch-assigned-user');
  if (!sel) return;
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) return; // cleared – leave fields as-is
  const name = opt.dataset.name || '';
  const email = opt.dataset.email || '';
  const nameField = document.getElementById('arch-contact-name');
  const emailField = document.getElementById('arch-contact-email');
  // Only auto-fill if fields are currently empty, to avoid overwriting intentional manual entries
  if (nameField && !nameField.value) nameField.value = name;
  if (emailField && !emailField.value) emailField.value = email;
}

function updateArchOwnerLabel() {
  const isRole = document.getElementById('arch-type').value === 'role';
  document.getElementById('arch-owner-label').textContent = isRole ? 'Reports to' : 'Owner';
}

async function saveArch(e) {
  e.preventDefault();
  const id = document.getElementById('arch-id').value;
  const archType = document.getElementById('arch-type').value;
  const metadata = {};
  if (archType === 'role') {
    const cn = document.getElementById('arch-contact-name');
    const ce = document.getElementById('arch-contact-email');
    const cp = document.getElementById('arch-contact-phone');
    if (cn) metadata.contact_name = cn.value;
    if (ce) metadata.contact_email = ce.value;
    if (cp) metadata.contact_phone = cp.value;
  } else if (archType === 'system') {
    const cr = document.getElementById('arch-criticality');
    if (cr) metadata.criticality = cr.value;
  } else if (archType === 'facility') {
    const addr = document.getElementById('arch-address');
    const lat = document.getElementById('arch-latitude');
    const lng = document.getElementById('arch-longitude');
    if (addr) metadata.address = addr.value;
    if (lat && lat.value) metadata.latitude = parseFloat(lat.value);
    if (lng && lng.value) metadata.longitude = parseFloat(lng.value);
  } else if (archType === 'ai_model') {
    const f = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    metadata.provider         = f('arch-ai-provider');
    metadata.version          = f('arch-ai-version');
    metadata.model_type       = f('arch-ai-model-type');
    metadata.deployment_env   = f('arch-ai-deploy-env');
    metadata.risk_tier        = f('arch-ai-risk-tier');
    metadata.explainability   = f('arch-ai-explainability');
    metadata.bias_assessment  = f('arch-ai-bias');
    metadata.last_evaluated   = f('arch-ai-last-evaluated');
    metadata.performance_notes = f('arch-ai-perf-notes');
    metadata.regulatory_flags = Array.from(document.querySelectorAll('.arch-ai-reg-flag:checked')).map(cb => cb.value);
  } else if (archType === 'ai_dataset') {
    const f = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    metadata.classification    = f('arch-ds-classification');
    metadata.data_type         = f('arch-ds-data-type');
    metadata.contains_pii      = f('arch-ds-pii');
    metadata.special_categories = f('arch-ds-special-cats');
    metadata.legal_basis       = f('arch-ds-legal-basis');
    metadata.jurisdiction      = f('arch-ds-jurisdiction');
    metadata.retention_period  = f('arch-ds-retention');
    metadata.access_level      = f('arch-ds-access-level');
    metadata.format            = f('arch-ds-format');
    metadata.volume_approx     = f('arch-ds-volume');
    metadata.data_quality_score = f('arch-ds-quality');
    metadata.last_reviewed     = f('arch-ds-last-reviewed');
  } else if (archType === 'ai_usecase') {
    const f = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    metadata.domain              = f('arch-uc-domain');
    metadata.ai_approach         = f('arch-uc-approach');
    metadata.risk_tier           = f('arch-uc-risk-tier');
    metadata.human_oversight     = f('arch-uc-oversight');
    metadata.governance_approval = f('arch-uc-approval');
    metadata.incident_reporting  = f('arch-uc-incident');
    metadata.approval_date       = f('arch-uc-approval-date');
    metadata.next_review_date    = f('arch-uc-review-date');
    metadata.business_value      = f('arch-uc-value');
    metadata.success_kpis        = f('arch-uc-kpis');
    metadata.fallback_process    = f('arch-uc-fallback');
  }
  const body = {
    arch_type: archType,
    name: document.getElementById('arch-name').value,
    description: document.getElementById('arch-description').value,
    owner: document.getElementById('arch-owner').value,
    status: document.getElementById('arch-status').value,
    metadata: JSON.stringify(metadata),
  };
  // Persist assigned user for roles
  if (archType === 'role') {
    const assignedUserSel = document.getElementById('arch-assigned-user');
    if (assignedUserSel && assignedUserSel.value) {
      const opt = assignedUserSel.options[assignedUserSel.selectedIndex];
      metadata.assigned_user_id = parseInt(assignedUserSel.value, 10);
      metadata.assigned_user_name = opt ? (opt.dataset.name || '') : '';
    } else {
      delete metadata.assigned_user_id;
      delete metadata.assigned_user_name;
    }
    body.metadata = JSON.stringify(metadata);
  }

  if (id) await api(`/api/architecture/${id}`, { method: 'PUT', body });
  else await api('/api/architecture', { method: 'POST', body });
  closeArchModal();
  currentArchTab = body.arch_type;
  loadArchitecture();
}

async function deleteArch(id) {
  if (!confirm('Delete this item?')) return;
  await api(`/api/architecture/${id}`, { method: 'DELETE' });
  loadArchitecture();
}

// ===========================================================================
// PROCESS KPIs & OBJECTIVES
// ===========================================================================

// Toggle the KPI/objectives expand panel for a process row
function toggleProcessKpiPanel(processId) {
  const panel = document.getElementById(`proc-kpi-panel-${processId}`);
  const arrow = document.getElementById(`proc-kpi-arrow-${processId}`);
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  arrow.innerHTML = isOpen ? '&#9650;' : '&#9660;';
  if (isOpen && !panel.dataset.loaded) {
    panel.dataset.loaded = '1';
    loadProcessKpiPanel(processId);
  }
}

async function loadProcessKpiPanel(processId) {
  const panel = document.getElementById(`proc-kpi-panel-${processId}`);
  if (!panel) return;
  const [kpis, archItem] = await Promise.all([
    api(`/api/architecture/${processId}/kpis`),
    api(`/api/architecture?arch_type=process`).then(items => items.find(i => i.id === processId)),
  ]);
  let meta = {};
  try { meta = JSON.parse(archItem?.metadata || '{}'); } catch(e) {}
  const objectives = meta.objectives || [];
  panel.innerHTML = renderProcessKpiPanel(processId, kpis, objectives);
}

function renderProcessKpiPanel(processId, kpis, objectives) {
  // ── KPI cards ────────────────────────────────────────────────
  const kpiCards = kpis.map(k => {
    const vals = k.values || [];
    const latest = vals.length > 0 ? vals[0] : null;
    const prev = vals.length > 1 ? vals[1] : null;
    const latestVal = latest !== null ? latest.value : null;
    const prevVal = prev !== null ? prev.value : null;
    const trend = (latestVal !== null && prevVal !== null) ? latestVal - prevVal : null;
    const trendHtml = trend !== null
      ? `<span class="kpi-trend ${trend > 0 ? 'up' : trend < 0 ? 'down' : 'flat'}">${trend > 0 ? '+' : ''}${Number(trend.toFixed(2))}${k.unit || ''}</span>`
      : '';
    const targetHtml = k.target_value !== null
      ? `<div class="proc-kpi-target">Target: ${k.target_value}${k.unit || ''}</div>`
      : '';
    // Sparkline (up to 12 most recent, reversed for left→right chronological order)
    const sparkVals = vals.slice(0, 12).reverse();
    const maxVal = sparkVals.length > 0 ? Math.max(...sparkVals.map(v => v.value), 1) : 1;
    const sparkHtml = sparkVals.length > 0
      ? `<div class="kpi-spark proc-kpi-spark">${sparkVals.map(v => {
          const h = Math.max(4, (v.value / maxVal) * 28);
          return `<div class="kpi-spark-bar" style="height:${h}px" title="${esc(v.period)}: ${v.value}${k.unit || ''}"></div>`;
        }).join('')}</div>`
      : '<span class="proc-kpi-no-data">No data yet</span>';
    // Trend history table (up to 12 entries)
    const historyRows = vals.slice(0, 12).map((v, i) => {
      const nextVal = vals[i + 1] ? vals[i + 1].value : null;
      const diff = nextVal !== null ? v.value - nextVal : null;
      const diffHtml = diff !== null
        ? `<span class="kpi-trend ${diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat'}" style="font-size:10px">${diff > 0 ? '+' : ''}${Number(diff.toFixed(2))}</span>`
        : '';
      return `<tr>
        <td style="font-size:11px;padding:3px 6px;color:var(--text-muted)">${esc(v.period)}</td>
        <td style="font-size:12px;padding:3px 6px;font-weight:600">${v.value}${k.unit || ''}</td>
        <td style="padding:3px 6px">${diffHtml}</td>
        <td style="padding:3px 6px;text-align:right">
          <span class="proc-kpi-del-val" onclick="deleteProcessKpiValue(${k.id},${v.id},${processId})" title="Remove this entry">&#10005;</span>
        </td>
      </tr>`;
    }).join('');
    const historyHtml = vals.length > 0
      ? `<table class="proc-kpi-history-table"><tbody>${historyRows}</tbody></table>`
      : '';

    return `<div class="proc-kpi-card">
      <div class="proc-kpi-card-header">
        <div>
          <div class="proc-kpi-name">${esc(k.name)}</div>
          ${k.description ? `<div class="proc-kpi-desc">${esc(k.description)}</div>` : ''}
          <div class="proc-kpi-meta">${k.frequency || 'monthly'}</div>
        </div>
        ${actionMenu([
          { label: '&#128200; Record Value', onclick: `openProcKpiValueForm(${k.id},${processId})`, cls: 'primary' },
          { label: '&#9998; Edit', onclick: `openProcKpiForm(${processId},${k.id})` },
          'sep',
          { label: '&#128465; Delete KPI', onclick: `deleteProcessKpi(${k.id},${processId})`, cls: 'danger' },
        ])}
      </div>
      <div style="display:flex;align-items:flex-end;gap:12px;margin-top:6px">
        <div>
          <div class="kpi-value" style="font-size:20px">${latestVal !== null ? latestVal + (k.unit || '') : 'N/A'}</div>
          ${targetHtml}
          <div style="display:flex;gap:6px;align-items:center;margin-top:2px">${trendHtml}${latest ? `<span style="font-size:10px;color:var(--text-muted)">${esc(latest.period)}</span>` : ''}</div>
        </div>
        ${sparkHtml}
      </div>
      ${historyHtml ? `<details class="proc-kpi-history"><summary style="font-size:11px;color:var(--text-muted);cursor:pointer;margin-top:8px">Trend history (${vals.length})</summary>${historyHtml}</details>` : ''}
      <div id="proc-kpi-value-form-${k.id}" class="proc-inline-form hidden"></div>
    </div>`;
  }).join('');

  // ── Add-KPI inline form placeholder ─────────────────────────
  const addKpiForm = `<div id="proc-kpi-add-form-${processId}" class="proc-inline-form hidden"></div>
    <button class="btn btn-secondary btn-sm proc-kpi-add-btn" onclick="openProcKpiForm(${processId})">+ Add KPI</button>`;

  // ── Objective rows ───────────────────────────────────────────
  const statusIcon = { on_track: '&#128994;', at_risk: '&#128308;', achieved: '&#10003;', cancelled: '&#8211;' };
  const statusLabel = { on_track: 'On track', at_risk: 'At risk', achieved: 'Achieved', cancelled: 'Cancelled' };
  const objRows = objectives.map((o, idx) => `
    <div class="proc-obj-row" id="proc-obj-row-${processId}-${idx}">
      <span class="proc-obj-icon">${statusIcon[o.status] || '&#9675;'}</span>
      <span class="proc-obj-text">${esc(o.text)}</span>
      <span class="proc-obj-due">${o.due ? esc(o.due) : ''}</span>
      <span class="badge ${o.status === 'achieved' ? 'badge-low' : o.status === 'at_risk' ? 'badge-critical' : o.status === 'cancelled' ? 'badge-inactive' : 'badge-medium'}" style="font-size:10px">${statusLabel[o.status] || o.status}</span>
      <div style="display:flex;gap:4px;margin-left:auto">
        <button class="btn btn-secondary btn-sm" onclick="openProcObjForm(${processId},${idx})" style="padding:2px 8px;font-size:11px">&#9998;</button>
        <button class="btn btn-secondary btn-sm" onclick="deleteProcessObjective(${processId},${idx})" style="padding:2px 8px;font-size:11px;color:var(--danger)">&#10005;</button>
      </div>
    </div>`).join('');

  const addObjForm = `<div id="proc-obj-add-form-${processId}" class="proc-inline-form hidden"></div>
    <button class="btn btn-secondary btn-sm proc-kpi-add-btn" onclick="openProcObjForm(${processId})">+ Add Objective</button>`;

  return `<div class="proc-kpi-panel-inner">
    <div class="proc-kpi-col">
      <div class="proc-kpi-col-title">KPIs</div>
      ${kpis.length ? kpiCards : '<div class="proc-kpi-empty">No KPIs defined yet.</div>'}
      ${addKpiForm}
    </div>
    <div class="proc-kpi-col">
      <div class="proc-kpi-col-title">Objectives</div>
      ${objectives.length ? objRows : '<div class="proc-kpi-empty">No objectives defined yet.</div>'}
      ${addObjForm}
    </div>
  </div>`;
}

// ── Inline KPI form ──────────────────────────────────────────────────────────
async function openProcKpiForm(processId, kpiId) {
  const formEl = document.getElementById(kpiId ? `proc-kpi-value-form-${kpiId}` : `proc-kpi-add-form-${processId}`);
  if (!formEl) return;
  let kpi = null;
  if (kpiId) {
    const kpis = await api(`/api/architecture/${processId}/kpis`);
    kpi = kpis.find(k => k.id === kpiId);
  }
  formEl.innerHTML = `
    <div class="proc-inline-form-inner">
      <input type="text" id="pkf-name-${processId}" placeholder="KPI name*" value="${esc(kpi?.name || '')}" style="flex:2">
      <input type="text" id="pkf-unit-${processId}" placeholder="Unit (%, days…)" value="${esc(kpi?.unit || '')}" style="width:80px">
      <input type="number" id="pkf-target-${processId}" placeholder="Target" value="${kpi?.target_value ?? ''}" style="width:80px">
      <select id="pkf-freq-${processId}" style="width:110px">
        ${['monthly','quarterly','annual','weekly'].map(f => `<option value="${f}"${(kpi?.frequency || 'monthly') === f ? ' selected' : ''}>${f}</option>`).join('')}
      </select>
      <input type="text" id="pkf-desc-${processId}" placeholder="Description (optional)" value="${esc(kpi?.description || '')}" style="flex:2">
      <div style="display:flex;gap:6px;margin-top:4px">
        <button class="btn btn-primary btn-sm" onclick="saveProcKpi(${processId},${kpiId || 'null'})">Save</button>
        <button class="btn btn-secondary btn-sm" onclick="closeProcInlineForm('${kpiId ? `proc-kpi-value-form-${kpiId}` : `proc-kpi-add-form-${processId}`}')">Cancel</button>
      </div>
    </div>`;
  formEl.classList.remove('hidden');
}

async function saveProcKpi(processId, kpiId) {
  const name = document.getElementById(`pkf-name-${processId}`)?.value?.trim();
  if (!name) { alert('KPI name is required'); return; }
  const body = {
    name,
    unit: document.getElementById(`pkf-unit-${processId}`)?.value || '',
    target_value: document.getElementById(`pkf-target-${processId}`)?.value ? parseFloat(document.getElementById(`pkf-target-${processId}`).value) : null,
    frequency: document.getElementById(`pkf-freq-${processId}`)?.value || 'monthly',
    description: document.getElementById(`pkf-desc-${processId}`)?.value || '',
    process_id: processId,
    module: 'process',
  };
  if (kpiId) await api(`/api/kpis/${kpiId}`, { method: 'PUT', body });
  else await api('/api/kpis', { method: 'POST', body });
  reloadProcessKpiPanel(processId);
}

async function deleteProcessKpi(kpiId, processId) {
  if (!confirm('Delete this KPI and all its recorded values?')) return;
  await api(`/api/kpis/${kpiId}`, { method: 'DELETE' });
  reloadProcessKpiPanel(processId);
}

// ── Inline record-value form ────────────────────────────────────────────────
function openProcKpiValueForm(kpiId, processId) {
  const formEl = document.getElementById(`proc-kpi-value-form-${kpiId}`);
  if (!formEl) return;
  const today = new Date().toISOString().slice(0, 7); // YYYY-MM
  formEl.innerHTML = `
    <div class="proc-inline-form-inner">
      <input type="number" step="any" id="pvf-val-${kpiId}" placeholder="Value*" style="width:100px">
      <input type="month" id="pvf-period-${kpiId}" value="${today}" style="width:140px">
      <div style="display:flex;gap:6px;margin-top:4px">
        <button class="btn btn-primary btn-sm" onclick="saveProcKpiValue(${kpiId},${processId})">Record</button>
        <button class="btn btn-secondary btn-sm" onclick="closeProcInlineForm('proc-kpi-value-form-${kpiId}')">Cancel</button>
      </div>
    </div>`;
  formEl.classList.remove('hidden');
}

async function saveProcKpiValue(kpiId, processId) {
  const val = document.getElementById(`pvf-val-${kpiId}`)?.value;
  const period = document.getElementById(`pvf-period-${kpiId}`)?.value;
  if (!val || !period) { alert('Value and period are required'); return; }
  await api(`/api/kpis/${kpiId}/values`, { method: 'POST', body: { value: parseFloat(val), period } });
  reloadProcessKpiPanel(processId);
}

async function deleteProcessKpiValue(kpiId, valueId, processId) {
  await api(`/api/kpis/${kpiId}/values/${valueId}`, { method: 'DELETE' });
  reloadProcessKpiPanel(processId);
}

// ── Inline objective form ───────────────────────────────────────────────────
async function openProcObjForm(processId, objIdx) {
  const isEdit = objIdx !== undefined;
  const formId = isEdit ? `proc-obj-row-${processId}-${objIdx}` : `proc-obj-add-form-${processId}`;
  const formEl = document.getElementById(formId);
  if (!formEl) return;
  let existing = null;
  if (isEdit) {
    const item = await api(`/api/architecture?arch_type=process`).then(items => items.find(i => i.id === processId));
    let meta = {};
    try { meta = JSON.parse(item?.metadata || '{}'); } catch(e) {}
    existing = (meta.objectives || [])[objIdx] || null;
  }
  const formHtml = `<div class="proc-inline-form-inner">
    <input type="text" id="pof-text-${processId}" placeholder="Objective*" value="${esc(existing?.text || '')}" style="flex:3">
    <input type="text" id="pof-due-${processId}" placeholder="Due (e.g. Q3 2026)" value="${esc(existing?.due || '')}" style="width:110px">
    <select id="pof-status-${processId}" style="width:110px">
      ${['on_track','at_risk','achieved','cancelled'].map(s => `<option value="${s}"${(existing?.status || 'on_track') === s ? ' selected' : ''}>${s.replace('_',' ')}</option>`).join('')}
    </select>
    <div style="display:flex;gap:6px;margin-top:4px">
      <button class="btn btn-primary btn-sm" onclick="saveProcObjective(${processId},${isEdit ? objIdx : 'null'})">Save</button>
      <button class="btn btn-secondary btn-sm" onclick="${isEdit ? `reloadProcessKpiPanel(${processId})` : `closeProcInlineForm('proc-obj-add-form-${processId}')`}">Cancel</button>
    </div>
  </div>`;
  if (isEdit) {
    formEl.innerHTML = formHtml;
  } else {
    formEl.innerHTML = formHtml;
    formEl.classList.remove('hidden');
  }
}

async function saveProcObjective(processId, objIdx) {
  const text = document.getElementById(`pof-text-${processId}`)?.value?.trim();
  if (!text) { alert('Objective text is required'); return; }
  const item = await api(`/api/architecture?arch_type=process`).then(items => items.find(i => i.id === processId));
  let meta = {};
  try { meta = JSON.parse(item?.metadata || '{}'); } catch(e) {}
  const objectives = meta.objectives || [];
  const obj = {
    id: objIdx !== null && objectives[objIdx] ? objectives[objIdx].id : crypto.randomUUID(),
    text,
    due: document.getElementById(`pof-due-${processId}`)?.value || '',
    status: document.getElementById(`pof-status-${processId}`)?.value || 'on_track',
  };
  if (objIdx !== null && objIdx < objectives.length) objectives[objIdx] = obj;
  else objectives.push(obj);
  meta.objectives = objectives;
  await api(`/api/architecture/${processId}`, { method: 'PUT', body: { metadata: JSON.stringify(meta) } });
  reloadProcessKpiPanel(processId);
}

async function deleteProcessObjective(processId, objIdx) {
  if (!confirm('Delete this objective?')) return;
  const item = await api(`/api/architecture?arch_type=process`).then(items => items.find(i => i.id === processId));
  let meta = {};
  try { meta = JSON.parse(item?.metadata || '{}'); } catch(e) {}
  const objectives = meta.objectives || [];
  objectives.splice(objIdx, 1);
  meta.objectives = objectives;
  await api(`/api/architecture/${processId}`, { method: 'PUT', body: { metadata: JSON.stringify(meta) } });
  reloadProcessKpiPanel(processId);
}

function closeProcInlineForm(formId) {
  const el = document.getElementById(formId);
  if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
}

function reloadProcessKpiPanel(processId) {
  const panel = document.getElementById(`proc-kpi-panel-${processId}`);
  if (panel) {
    panel.dataset.loaded = '';
    loadProcessKpiPanel(processId);
  }
}
