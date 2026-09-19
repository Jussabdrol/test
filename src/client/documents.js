
// --- Document Control ---
let docFilters = { doc_type: '', status: '', classification: '', process: '', owner: '', search: '' };
let docListRequest = 0;
let docSearchTimer;
function scheduleDocumentSearch() {
  clearTimeout(docSearchTimer);
  // Keep the input node stable during a typing burst; discard older list responses.
  docListRequest++;
  docSearchTimer = setTimeout(() => loadDocumentControl(), 250);
}

// Column visibility — persisted in localStorage
const DOC_COL_STORAGE_KEY = 'docColumnVisibility';
const DOC_COLUMNS = [
  { key: 'type',           label: 'Type',           default: true },
  { key: 'classification', label: 'Classification', default: true },
  { key: 'status',         label: 'Status',         default: true },
  { key: 'version',        label: 'Version',        default: true },
  { key: 'owner',          label: 'Owner',          default: true },
  { key: 'review',         label: 'Review Date',    default: true },
  { key: 'links',          label: 'Linked Items',   default: true },
];

function getDocColumnVisibility() {
  try {
    const stored = JSON.parse(localStorage.getItem(DOC_COL_STORAGE_KEY));
    if (stored && typeof stored === 'object') return stored;
  } catch (e) {}
  const defaults = {};
  DOC_COLUMNS.forEach(c => defaults[c.key] = c.default);
  return defaults;
}

function setDocColumnVisibility(vis) {
  localStorage.setItem(DOC_COL_STORAGE_KEY, JSON.stringify(vis));
}

function toggleDocColumn(key) {
  const vis = getDocColumnVisibility();
  vis[key] = !vis[key];
  setDocColumnVisibility(vis);
  loadDocumentControl();
}

function buildDocGridCols(vis) {
  // Title column (always visible) + dynamic columns + actions (always visible)
  let cols = 'minmax(160px, 2fr)';
  if (vis.type) cols += ' minmax(65px, .8fr)';
  if (vis.classification) cols += ' minmax(85px, 1fr)';
  if (vis.status) cols += ' minmax(90px, 1fr)';
  if (vis.version) cols += ' 40px';
  if (vis.owner) cols += ' minmax(75px, 1fr)';
  if (vis.review) cols += ' minmax(110px, 1fr)';
  if (vis.links) cols += ' minmax(65px, .8fr)';
  cols += ' 36px';
  return cols;
}

async function loadDocumentControl() {
  clearTimeout(docSearchTimer);
  const request = ++docListRequest;
  closeExperienceDossier('document', false);
  const params = new URLSearchParams();
  if (docFilters.doc_type) params.set('doc_type', docFilters.doc_type);
  if (docFilters.status) params.set('status', docFilters.status);
  if (docFilters.classification) params.set('classification', docFilters.classification);
  let docs = await api(`/api/documents?${params}`);

  // Prefetch all cross-links for documents
  const allLinks = {};
  await batchAll(docs, async d => {
    allLinks[d.id] = await api(`/api/cross-links/document/${d.id}`);
  });

  // Fetch processes for filter dropdown
  const processes = await api('/api/architecture?arch_type=process');

  if (request !== docListRequest) return;

  // Collect unique owners for filter dropdown
  const uniqueOwners = [...new Set(docs.filter(d => d.owner).map(d => d.owner))].sort();

  // Apply client-side filters for linked items
  if (docFilters.process) {
    docs = docs.filter(d => {
      const links = allLinks[d.id] || [];
      return links.some(l => l.type === 'process' && l.name === docFilters.process);
    });
  }
  if (docFilters.owner) {
    docs = docs.filter(d => d.owner === docFilters.owner);
  }
  if (docFilters.search) {
    const searchLower = docFilters.search.toLowerCase();
    docs = docs.filter(d =>
      d.title.toLowerCase().includes(searchLower) ||
      (d.description && d.description.toLowerCase().includes(searchLower)) ||
      (d.file_name && d.file_name.toLowerCase().includes(searchLower))
    );
  }

  const vis = getDocColumnVisibility();

  const searchInput = document.getElementById('doc-search');
  const restoreSearch = searchInput && document.activeElement === searchInput;
  const selection = restoreSearch ? searchInput.selectionStart : null;
  document.getElementById('doc-filters-bar').innerHTML = `
    <div class="filter-row" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px">
      <label class="experience-filter">Search<input id="doc-search" type="search" placeholder="Search documents…" value="${esc(docFilters.search || '')}"
        style="padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius);font-size:13px;min-width:200px"
        oninput="docFilters.search=this.value;scheduleDocumentSearch()"></label>
      <label class="experience-filter">Type<select onchange="docFilters.doc_type=this.value;loadDocumentControl()">
        <option value="">All Types</option>
        <option value="policy" ${docFilters.doc_type==='policy'?'selected':''}>Policy</option>
        <option value="procedure" ${docFilters.doc_type==='procedure'?'selected':''}>Procedure</option>
        <option value="work_instruction" ${docFilters.doc_type==='work_instruction'?'selected':''}>Work Instruction</option>
        <option value="record" ${docFilters.doc_type==='record'?'selected':''}>Record</option>
        <option value="form" ${docFilters.doc_type==='form'?'selected':''}>Form / Template</option>
        <option value="report" ${docFilters.doc_type==='report'?'selected':''}>Report</option>
        <option value="evidence" ${docFilters.doc_type==='evidence'?'selected':''}>Evidence</option>
        <option value="other" ${docFilters.doc_type==='other'?'selected':''}>Other</option>
      </select></label>
      <label class="experience-filter">Status<select onchange="docFilters.status=this.value;loadDocumentControl()">
        <option value="">All Status</option>
        <option value="draft" ${docFilters.status==='draft'?'selected':''}>Draft</option>
        <option value="review" ${docFilters.status==='review'?'selected':''}>Under Review</option>
        <option value="approved" ${docFilters.status==='approved'?'selected':''}>Approved</option>
        <option value="obsolete" ${docFilters.status==='obsolete'?'selected':''}>Obsolete</option>
      </select></label>
      <label class="experience-filter">Classification<select onchange="docFilters.classification=this.value;loadDocumentControl()">
        <option value="">All Classifications</option>
        <option value="public" ${docFilters.classification==='public'?'selected':''}>Public</option>
        <option value="internal" ${docFilters.classification==='internal'?'selected':''}>Internal</option>
        <option value="confidential" ${docFilters.classification==='confidential'?'selected':''}>Confidential</option>
        <option value="restricted" ${docFilters.classification==='restricted'?'selected':''}>Restricted</option>
      </select></label>
      <label class="experience-filter">Process<select onchange="docFilters.process=this.value;loadDocumentControl()">
        <option value="">All Processes</option>
        ${processes.map(p => `<option value="${esc(p.name)}" ${docFilters.process===p.name?'selected':''}>${esc(p.name)}</option>`).join('')}
      </select></label>
      <label class="experience-filter">Owner<select onchange="docFilters.owner=this.value;loadDocumentControl()">
        <option value="">All Owners</option>
        ${uniqueOwners.map(o => `<option value="${esc(o)}" ${docFilters.owner===o?'selected':''}>${esc(o)}</option>`).join('')}
      </select></label>
      ${(docFilters.doc_type || docFilters.status || docFilters.classification || docFilters.process || docFilters.owner || docFilters.search) ?
        `<button class="btn btn-secondary btn-sm" onclick="docFilters={doc_type:'',status:'',classification:'',process:'',owner:'',search:''};loadDocumentControl()">Clear Filters</button>` : ''}
      <div class="doc-col-toggle" style="margin-left:auto">
        <button class="doc-col-toggle-btn" onclick="this.nextElementSibling.classList.toggle('open')" type="button">&#9881; Columns</button>
        <div class="doc-col-dropdown">
          ${DOC_COLUMNS.map(c => `<label><input type="checkbox" ${vis[c.key] ? 'checked' : ''} onchange="toggleDocColumn('${c.key}')"> ${esc(c.label)}</label>`).join('')}
        </div>
      </div>
    </div>
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px">${docs.length} document${docs.length!==1?'s':''} found</div>`;

  if (restoreSearch) {
    const input = document.getElementById('doc-search'); input.focus({preventScroll:true}); input.setSelectionRange(selection,selection);
  }

  // Close column dropdown when clicking outside
  document.addEventListener('click', function _closeDocColDrop(e) {
    if (!e.target.closest('.doc-col-toggle')) {
      const dd = document.querySelector('.doc-col-dropdown.open');
      if (dd) dd.classList.remove('open');
    }
  }, { once: true });

  const list = document.getElementById('doc-list');
  if (docs.length === 0) {
    list.innerHTML = `<div class="empty-state">${Object.values(docFilters).some(Boolean) ? 'No documents match these filters.' : 'No documents yet. Upload one to get started.'}</div>`;
    return;
  }

  const docTypeLabels = { policy: 'Policy', procedure: 'Procedure', work_instruction: 'Work Instruction', record: 'Record', form: 'Form', report: 'Report', evidence: 'Evidence', other: 'Other' };
  const docTypeBadge = () => 'experience-neutral';
  const statusBadge = s => s === 'approved' ? 'experience-approved' : 'experience-neutral';
  const classificationBadge = () => 'experience-neutral';
  const today = new Date().toISOString().split('T')[0];
  const gridCols = buildDocGridCols(vis);

  let html = `<div class="doc-table">
    <div class="doc-table-head" style="grid-template-columns:${gridCols}">
      <div class="doc-col-title">Document</div>
      ${vis.type ? '<div class="doc-col-type">Type</div>' : ''}
      ${vis.classification ? '<div class="doc-col-class">Classification</div>' : ''}
      ${vis.status ? '<div class="doc-col-status">Status</div>' : ''}
      ${vis.version ? '<div class="doc-col-ver">Version</div>' : ''}
      ${vis.owner ? '<div class="doc-col-owner">Owner</div>' : ''}
      ${vis.review ? '<div class="doc-col-review">Review</div>' : ''}
      ${vis.links ? '<div class="doc-col-links">Linked Items</div>' : ''}
      <div class="doc-col-actions"></div>
    </div>`;

  for (const d of docs) {
    const reviewOverdue = d.review_date && d.review_date < today;
    const links = allLinks[d.id] || [];
    const processLinks = links.filter(l => l.type === 'process');
    const reqLinks = links.filter(l => l.type === 'requirement');
    const otherLinks = links.filter(l => l.type !== 'process' && l.type !== 'requirement');
    const linkParts = [];
    if (reqLinks.length > 0) linkParts.push(reqLinks.length + ' standard' + (reqLinks.length !== 1 ? 's' : ''));
    if (processLinks.length > 0) linkParts.push(processLinks.length + ' process' + (processLinks.length !== 1 ? 'es' : ''));
    if (otherLinks.length > 0) linkParts.push(otherLinks.length + ' other');
    const linkSummary = linkParts.length > 0 ? linkParts.join(', ') : '-';
    const collapseId = `doc-cl-${d.id}`;
    const typeLabel = docTypeLabels[d.doc_type] || d.doc_type || 'Other';

    html += `<div class="doc-table-row${d.status === 'obsolete' ? ' doc-obsolete' : ''}" style="grid-template-columns:${gridCols}">
        <div class="doc-col-title">
          <button type="button" class="doc-row-title experience-text-button" onclick="openDocumentDossier(${d.id})">${esc(d.title)}</button>
          ${d.file_name ? `<span class="doc-row-file">${esc(d.file_name)}</span>` : ''}
        </div>
        ${vis.type ? `<div class="doc-col-type" data-label="Type"><span class="badge ${docTypeBadge(d.doc_type)}">${esc(typeLabel)}</span></div>` : ''}
        ${vis.classification ? `<div class="doc-col-class" data-label="Classification">
          ${d.classification ? `<span class="badge ${classificationBadge(d.classification)}">${esc(d.classification)}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}
        </div>` : ''}
        ${vis.status ? `<div class="doc-col-status" data-label="Status"><span class="badge ${statusBadge(d.status)}">${esc(experienceStatus(d.status))}</span></div>` : ''}
        ${vis.version ? `<div class="doc-col-ver" data-label="Version">v${esc(d.version)}</div>` : ''}
        ${vis.owner ? `<div class="doc-col-owner" data-label="Owner">${d.owner ? `<span style="font-size:12px">${esc(d.owner)}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}</div>` : ''}
        ${vis.review ? `<div class="doc-col-review" data-label="Review date">${d.review_date ? `<span style="font-size:12px;${reviewOverdue ? 'color:var(--danger);font-weight:600' : ''}">${esc(d.review_date)}${reviewOverdue ? '<span class="badge experience-overdue">Review overdue</span>' : ''}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}</div>` : ''}
        ${vis.links ? `<div class="doc-col-links" data-label="Linked items">
          <span class="doc-link-summary" style="cursor:pointer;font-size:12px" onclick="document.getElementById('${collapseId}').classList.toggle('collapsed');this.querySelector('.cl-toggle-icon').textContent=document.getElementById('${collapseId}').classList.contains('collapsed')?'+':'−'">${linkSummary} <span class="cl-toggle-icon">${links.length > 0 ? '+' : ''}</span></span>
        </div>` : ''}
        <div class="doc-col-actions">
          ${actionMenu([
            ...(d.file_name ? [{ label: '&#128229; Download', onclick: `downloadDoc(${d.id})` }] : []),
            ...(/\.(docx?|xlsx?)$/i.test(d.file_name || '') ? [{ label: '&#9998;&#65039; Edit in Browser', onclick: `openDocEditor(${d.id},${JSON.stringify(d.title)})` }] : []),
            { label: '&#128279; Link Items', onclick: `openCrossLinkPicker('document',${d.id},'doc-expand-${d.id}')` },
            { label: '&#9998; Edit Metadata', onclick: `openDocModal(${d.id})` },
            'sep',
            { label: '&#128465; Delete', onclick: `deleteDoc(${d.id})`, cls: 'danger' },
          ])}
        </div>
      </div>
      <div id="doc-expand-${d.id}" class="doc-expand-row">
        <div id="${collapseId}" class="doc-links-detail collapsed">
          ${links.length === 0 ? '<span style="font-size:12px;color:var(--text-muted);font-style:italic">No linked items. Use the action menu to link items.</span>' : buildDocLinksDetail(links, d.id)}
        </div>
      </div>`;
  }
  html += '</div>';
  list.innerHTML = html;
}

function buildDocLinksDetail(links, docId) {
  const typeIcons = {};
  const typeLabels = {};
  for (const [k, v] of Object.entries(linkableTypes)) { typeIcons[k] = v.icon; typeLabels[k] = v.label; }
  const grouped = {};
  for (const l of links) {
    if (!grouped[l.type]) grouped[l.type] = [];
    grouped[l.type].push(l);
  }
  let html = '';
  for (const [type, items] of Object.entries(grouped)) {
    html += `<div class="cross-link-group"><span class="cross-link-group-label">${typeIcons[type] || ''} ${typeLabels[type] || type}</span>`;
    for (const item of items) {
      const viewTarget = getViewForType(item.type, item.id);
      html += `<div class="cross-link-item">
        <span class="cross-link-name"${viewTarget ? ` onclick="${viewTarget}" style="cursor:pointer;text-decoration:underline"` : ''}>${esc(item.name)}</span>
        <button class="cross-link-remove" onclick="removeCrossLink(${item.link_id},'document',${docId},'doc-expand-${docId}');setTimeout(loadDocumentControl,300)" title="Remove link">&times;</button>
      </div>`;
    }
    html += '</div>';
  }
  return html;
}

async function openDocModal(id) {
  document.getElementById('doc-form').reset();
  document.getElementById('doc-id').value = '';
  document.getElementById('doc-modal-title').textContent = 'Upload Document';
  document.getElementById('doc-linked-ref').innerHTML = '<option value="">-- Select module first --</option>';

  // Populate owner dropdown from architecture roles + org users
  await populateDocOwners();

  if (id) {
    const docs = await api('/api/documents');
    const d = docs.find(x => x.id === id);
    if (!d) return;
    document.getElementById('doc-modal-title').textContent = 'Edit Document';
    document.getElementById('doc-id').value = d.id;
    document.getElementById('doc-title').value = d.title;
    document.getElementById('doc-type').value = d.doc_type;
    document.getElementById('doc-version').value = d.version;
    document.getElementById('doc-owner').value = d.owner || '';
    document.getElementById('doc-status').value = d.status;
    document.getElementById('doc-description').value = d.description;
    document.getElementById('doc-linked-module').value = d.linked_module;
    document.getElementById('doc-review-date').value = d.review_date || '';
    document.getElementById('doc-classification').value = d.classification || '';
    if (d.linked_module) {
      await populateDocRefs(d.linked_module);
      if (d.linked_ref_id) document.getElementById('doc-linked-ref').value = `${d.linked_ref_type}:${d.linked_ref_id}`;
    }
  }
  document.getElementById('doc-modal').classList.remove('hidden');
}

async function populateDocOwners() {
  const sel = document.getElementById('doc-owner');
  sel.innerHTML = '<option value="">-- Select Owner --</option>';
  try {
    const [roles, users] = await Promise.all([
      api('/api/architecture?arch_type=role'),
      api('/api/admin/users').catch(() => []),
    ]);
    const seen = new Set();
    if (Array.isArray(roles) && roles.length > 0) {
      sel.innerHTML += '<optgroup label="Roles">' +
        roles.map(r => { seen.add(r.name); return `<option value="${esc(r.name)}">${esc(r.name)}</option>`; }).join('') +
        '</optgroup>';
    }
    if (Array.isArray(users) && users.length > 0) {
      const userOpts = users.filter(u => !seen.has(u.name)).map(u =>
        `<option value="${esc(u.name)}">${esc(u.name)}${u.department ? ' (' + esc(u.department) + ')' : ''}</option>`
      ).join('');
      if (userOpts) sel.innerHTML += '<optgroup label="Users">' + userOpts + '</optgroup>';
    }
  } catch (e) { /* dropdowns stay with just the default option */ }
}

function closeDocModal() { document.getElementById('doc-modal').classList.add('hidden'); }

// Populate linked references based on selected module
document.addEventListener('change', function(e) {
  if (e.target && e.target.id === 'doc-linked-module') {
    const mod = e.target.value;
    if (mod) populateDocRefs(mod);
    else document.getElementById('doc-linked-ref').innerHTML = '<option value="">-- None --</option>';
  }
});

async function populateDocRefs(module) {
  const refs = await api(`/api/link-references?module=${module}`);
  const sel = document.getElementById('doc-linked-ref');
  if (!refs || refs.length === 0) {
    sel.innerHTML = '<option value="">-- No items in this module --</option>';
    return;
  }
  // Group by type for cleaner display
  const grouped = {};
  for (const r of refs) {
    const typeLabel = r.type.charAt(0).toUpperCase() + r.type.slice(1) + 's';
    if (!grouped[typeLabel]) grouped[typeLabel] = [];
    grouped[typeLabel].push(r);
  }
  let html = '<option value="">-- None --</option>';
  for (const [label, items] of Object.entries(grouped)) {
    html += `<optgroup label="${esc(label)}">` +
      items.map(r => `<option value="${r.type}:${r.id}">${esc(r.label)}</option>`).join('') +
      '</optgroup>';
  }
  sel.innerHTML = html;
}

async function saveDocument(e) {
  e.preventDefault();
  const id = document.getElementById('doc-id').value;
  const formData = new FormData();
  formData.append('title', document.getElementById('doc-title').value);
  formData.append('doc_type', document.getElementById('doc-type').value);
  formData.append('version', document.getElementById('doc-version').value);
  formData.append('owner', document.getElementById('doc-owner').value);
  formData.append('status', document.getElementById('doc-status').value);
  formData.append('description', document.getElementById('doc-description').value);
  formData.append('linked_module', document.getElementById('doc-linked-module').value);
  formData.append('review_date', document.getElementById('doc-review-date').value);
  formData.append('classification', document.getElementById('doc-classification').value);

  const refVal = document.getElementById('doc-linked-ref').value;
  let refType = '', refId = '';
  if (refVal) {
    [refType, refId] = refVal.split(':');
    formData.append('linked_ref_type', refType);
    formData.append('linked_ref_id', refId);
  }

  const fileInput = document.getElementById('doc-file');
  if (fileInput.files.length > 0) {
    formData.append('file', fileInput.files[0]);
  }

  const url = id ? `/api/documents/${id}` : '/api/documents';
  const method = id ? 'PUT' : 'POST';
  const res = await fetch(url, { method, body: formData });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Upload failed' }));
    alert(err.error || 'Failed to save document');
    return;
  }

  // Auto-create cross-link when a linked item is selected
  if (refType && refId) {
    const savedDoc = await res.json().catch(() => null);
    const docId = savedDoc ? savedDoc.id : (id ? parseInt(id) : null);
    if (docId) {
      // Check for existing link to avoid duplicates
      const existingLinks = await api(`/api/cross-links/document/${docId}`);
      const alreadyLinked = existingLinks.some(l => l.type === refType && l.id === parseInt(refId));
      if (!alreadyLinked) {
        await api('/api/cross-links', {
          method: 'POST',
          body: { source_type: 'document', source_id: docId, target_type: refType, target_id: parseInt(refId) }
        }).catch(() => {});
      }
    }
  }

  closeDocModal();
  loadDocumentControl();
}

async function deleteDoc(id) {
  if (!confirm('Delete this document and its file?')) return;
  await api(`/api/documents/${id}`, { method: 'DELETE' });
  loadDocumentControl();
}

function downloadDoc(id) {
  window.open(`/api/documents/${id}/download`, '_blank');
}

// --- Document In-Browser Editor ---
let _docEditorId = null;
let _docEditorType = null;
let _docEditorSheets = null;
let _docEditorSheetNames = null;
let _docEditorActiveSheet = null;

async function openDocEditor(id, title) {
  _docEditorId = id;
  const body = document.getElementById('doc-editor-body');
  document.getElementById('doc-editor-title').textContent = `Edit: ${title || 'Document'}`;
  body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">Loading document\u2026</div>';
  document.getElementById('doc-editor-modal').classList.remove('hidden');

  let data;
  try {
    data = await api(`/api/documents/${id}/edit-content`);
  } catch (e) {
    body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--danger)">Failed to load: ${esc(e.message)}</div>`;
    return;
  }

  _docEditorType = data.type;
  if (data.type === 'excel') {
    _docEditorSheets = JSON.parse(JSON.stringify(data.sheets));
    _docEditorSheetNames = data.sheetNames;
    _docEditorActiveSheet = data.sheetNames[0];
    _renderExcelEditor(body);
  } else {
    _renderWordEditor(body, data.html);
  }
}

function _renderExcelEditor(container) {
  const tabs = _docEditorSheetNames.map(n =>
    `<button class="doc-sheet-tab${n === _docEditorActiveSheet ? ' active' : ''}" onclick="_switchDocSheet('${n.replace(/'/g,"\\'")}');event.preventDefault()">${esc(n)}</button>`
  ).join('');

  const rows = (_docEditorSheets[_docEditorActiveSheet] || []);
  const maxCols = Math.max(10, rows.reduce((m, r) => Math.max(m, (r || []).length), 0));

  let tHead = '<thead><tr><th></th>';
  for (let c = 0; c < maxCols + 1; c++) {
    tHead += `<th>${String.fromCharCode(65 + (c % 26))}</th>`;
  }
  tHead += '</tr></thead>';

  let tBody = '<tbody>';
  const displayRows = Math.max(rows.length + 3, 20);
  for (let r = 0; r < displayRows; r++) {
    tBody += `<tr><th>${r + 1}</th>`;
    for (let c = 0; c < maxCols + 1; c++) {
      const val = rows[r] ? (rows[r][c] !== undefined ? rows[r][c] : '') : '';
      tBody += `<td contenteditable="true" spellcheck="false" data-row="${r}" data-col="${c}" onblur="_updateDocCell(this)" onkeydown="_docCellKeydown(event,${r},${c})">${esc(String(val))}</td>`;
    }
    tBody += '</tr>';
  }
  tBody += '</tbody>';

  container.innerHTML = `
    <div class="doc-sheet-tabs">${tabs}</div>
    <div class="doc-excel-wrapper">
      <table class="doc-excel-table">${tHead}${tBody}</table>
    </div>
    <p class="doc-editor-hint">Click any cell to edit. Tab / Enter to navigate.</p>`;
}

function _switchDocSheet(name) {
  _docEditorActiveSheet = name;
  _renderExcelEditor(document.getElementById('doc-editor-body'));
}

function _updateDocCell(td) {
  const r = parseInt(td.dataset.row), c = parseInt(td.dataset.col);
  const val = td.textContent;
  const sheet = _docEditorSheets[_docEditorActiveSheet];
  while (sheet.length <= r) sheet.push([]);
  while (sheet[r].length <= c) sheet[r].push('');
  sheet[r][c] = val;
}

function _docCellKeydown(e, r, c) {
  if (e.key === 'Tab') {
    e.preventDefault();
    const next = document.querySelector(`[data-row="${r}"][data-col="${c + 1}"]`);
    if (next) next.focus();
  } else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const next = document.querySelector(`[data-row="${r + 1}"][data-col="${c}"]`);
    if (next) next.focus();
  }
}

function _renderWordEditor(container, html) {
  container.innerHTML = `
    <div class="doc-word-toolbar">
      <button type="button" class="doc-tb-btn" onclick="document.execCommand('bold')" title="Bold"><strong>B</strong></button>
      <button type="button" class="doc-tb-btn" onclick="document.execCommand('italic')" title="Italic"><em>I</em></button>
      <button type="button" class="doc-tb-btn" onclick="document.execCommand('underline')" title="Underline"><u>U</u></button>
      <span class="doc-tb-sep"></span>
      <button type="button" class="doc-tb-btn" onclick="document.execCommand('insertUnorderedList')" title="Bullet list">&bull;</button>
      <button type="button" class="doc-tb-btn" onclick="document.execCommand('insertOrderedList')" title="Numbered list">1.</button>
      <span class="doc-tb-sep"></span>
      <select class="doc-tb-select" onchange="document.execCommand('formatBlock',false,this.value);this.value='';document.getElementById('doc-word-content').focus()">
        <option value="">Paragraph style</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
        <option value="p">Paragraph</option>
      </select>
      <span class="doc-tb-sep"></span>
      <button type="button" class="doc-tb-btn" onclick="document.execCommand('justifyLeft')" title="Align left">&#8676;</button>
      <button type="button" class="doc-tb-btn" onclick="document.execCommand('justifyCenter')" title="Center">&#8596;</button>
      <button type="button" class="doc-tb-btn" onclick="document.execCommand('justifyRight')" title="Align right">&#8677;</button>
    </div>
    <div id="doc-word-content" class="doc-word-content" contenteditable="true">${html}</div>
    <p class="doc-editor-hint">Formatting is approximate — complex Word styles may simplify on save.</p>`;
  document.getElementById('doc-word-content').focus();
}

function closeDocEditor() {
  document.getElementById('doc-editor-modal').classList.add('hidden');
  _docEditorId = null; _docEditorType = null;
  _docEditorSheets = null; _docEditorSheetNames = null;
}

async function saveDocContent() {
  const btn = document.getElementById('doc-editor-save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving\u2026';
  try {
    let payload;
    if (_docEditorType === 'excel') {
      // Sync any active cell before saving
      const activeCells = document.querySelectorAll('#doc-editor-body [contenteditable]');
      activeCells.forEach(td => _updateDocCell(td));
      payload = { type: 'excel', content: { sheets: _docEditorSheets } };
    } else {
      payload = { type: 'word', content: { html: document.getElementById('doc-word-content').innerHTML } };
    }
    await api(`/api/documents/${_docEditorId}/save-content`, { method: 'PUT', body: payload });
    showToast('Document saved successfully', 'success');
    closeDocEditor();
  } catch (e) {
    showToast('Save failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
}
