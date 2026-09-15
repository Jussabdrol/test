
// --- Audit Execution ---
async function loadAuditExecuteView() {
  const audits = await api('/api/audits');
  const sel = document.getElementById('audit-exec-select');
  const currentVal = sel.value;

  // Flatten all events for selection (including all instances from recurring audits)
  const allExecutableEvents = [];
  for (const a of audits) {
    if (a.all_events && a.all_events.length > 0) {
      for (const ev of a.all_events) {
        if (ev.status !== 'cancelled') {
          allExecutableEvents.push({
            id: ev.id,
            title: a.total_instances > 1 ? `${a.title} - Event #${ev.instance_number || 1} (${ev.planned_date || 'No date'})` : a.title,
            status: ev.status,
            planned_date: ev.planned_date
          });
        }
      }
    } else if (a.status !== 'cancelled') {
      allExecutableEvents.push({
        id: a.id,
        title: a.title,
        status: a.status,
        planned_date: a.planned_date
      });
    }
  }

  // Sort by planned date
  allExecutableEvents.sort((a, b) => (b.planned_date || '').localeCompare(a.planned_date || ''));

  sel.innerHTML = '<option value="">Select an audit event...</option>' +
    allExecutableEvents.map(ev =>
      `<option value="${ev.id}" ${String(ev.id) === currentVal ? 'selected' : ''}>${esc(ev.title)} (${ev.status.replace('_',' ')})</option>`
    ).join('');
  if (currentVal) loadAuditExecution(currentVal);
  else document.getElementById('audit-exec-content').innerHTML = '<div class="empty-state">Select an audit event to begin execution.</div>';
}

async function loadAuditExecution(auditId) {
  if (!auditId) {
    document.getElementById('audit-exec-content').innerHTML = '<div class="empty-state">Select an audit to begin execution.</div>';
    return;
  }
  currentAuditId = auditId;
  const audit = await api(`/api/audits/${auditId}`);
  const content = document.getElementById('audit-exec-content');

  // Summary bar
  const totalItems = audit.checklist.length;
  const assessed = audit.checklist.filter(c => c.rating !== 'not_assessed').length;
  const conforming = audit.checklist.filter(c => c.rating === 'conforming').length;
  const observations = audit.checklist.filter(c => c.rating === 'observation').length;
  const minorNc = audit.checklist.filter(c => c.rating === 'minor_nc').length;
  const majorNc = audit.checklist.filter(c => c.rating === 'major_nc').length;

  let auditStandards = [];
  try { auditStandards = JSON.parse(audit.standards || '[]'); } catch(e) { auditStandards = audit.standard ? [audit.standard] : []; }
  if (auditStandards.length === 0 && audit.standard) auditStandards = [audit.standard];

  let html = `
    <div class="audit-exec-info">
      <div><strong>Standard${auditStandards.length > 1 ? 's' : ''}:</strong> ${auditStandards.map(s => esc(s)).join(', ')}</div>
      <div><strong>Lead:</strong> ${esc(audit.lead_auditor || 'Unassigned')}</div>
      <div><strong>Auditee:</strong> ${esc(audit.auditee || 'Unassigned')}</div>
      <div><strong>Status:</strong> <span class="badge ${audit.status === 'completed' ? 'badge-low' : 'badge-medium'}">${audit.status.replace('_',' ')}</span></div>
    </div>
    <div class="audit-exec-stats">
      <div class="stat-card"><div class="stat-value">${totalItems}</div><div class="stat-label">Total Items</div></div>
      <div class="stat-card done"><div class="stat-value">${assessed}</div><div class="stat-label">Assessed</div></div>
      <div class="stat-card"><div class="stat-value">${conforming}</div><div class="stat-label">Conforming</div></div>
      <div class="stat-card today"><div class="stat-value">${observations}</div><div class="stat-label">Observations</div></div>
      <div class="stat-card overdue"><div class="stat-value">${minorNc + majorNc}</div><div class="stat-label">NC</div></div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin:16px 0">
      <h3 class="section-title" style="margin:0;border:none;padding:0">Audit Checklist</h3>
      <div style="display:flex;gap:6px">
        <button class="btn btn-secondary btn-sm" onclick="exportAuditPDF(${auditId})">&#128196; Export PDF</button>
        <button class="btn btn-primary btn-sm" onclick="openChecklistModal(${auditId})">+ Add Item</button>
        ${audit.status === 'in_progress' ? `<button class="btn btn-success btn-sm" onclick="completeAudit(${auditId})">Complete Audit</button>` : ''}
      </div>
    </div>`;

  if (audit.checklist.length === 0) {
    html += '<div class="empty-state">No checklist items yet. Add clauses to audit against.</div>';
  } else {
    // Build map of checklist item id -> NCR for linking
    const ncrByChecklist = {};
    for (const nc of audit.non_conformities) {
      if (nc.checklist_item_id) ncrByChecklist[nc.checklist_item_id] = nc;
    }

    const ratingColors = {
      not_assessed: 'badge-inactive',
      conforming: 'badge-low',
      observation: 'badge-medium',
      minor_nc: 'badge-high',
      major_nc: 'badge-critical'
    };
    const ratingLabels = {
      not_assessed: 'Not Assessed',
      conforming: 'Conforming',
      observation: 'Observation',
      minor_nc: 'Minor NC',
      major_nc: 'Major NC'
    };

    // Separate assessed and unassessed items
    const assessedItems = audit.checklist.filter(i => i.rating && i.rating !== 'not_assessed');
    const unassessedItems = audit.checklist.filter(i => !i.rating || i.rating === 'not_assessed');

    // Render assessed items summary (collapsible)
    if (assessedItems.length > 0) {
      const conforming = assessedItems.filter(i => i.rating === 'conforming').length;
      const observations = assessedItems.filter(i => i.rating === 'observation').length;
      const minorNcs = assessedItems.filter(i => i.rating === 'minor_nc').length;
      const majorNcs = assessedItems.filter(i => i.rating === 'major_nc').length;

      html += `<div class="cl-assessed-section">
        <div class="cl-assessed-header" onclick="toggleAssessedItems()">
          <div class="cl-assessed-summary">
            <strong>&#9745; Assessed Items (${assessedItems.length})</strong>
            <div class="cl-assessed-badges">
              ${conforming > 0 ? `<span class="badge badge-low">${conforming} Conforming</span>` : ''}
              ${observations > 0 ? `<span class="badge badge-medium">${observations} Observations</span>` : ''}
              ${minorNcs > 0 ? `<span class="badge badge-high">${minorNcs} Minor NC</span>` : ''}
              ${majorNcs > 0 ? `<span class="badge badge-critical">${majorNcs} Major NC</span>` : ''}
            </div>
          </div>
          <span class="cl-assessed-toggle" id="assessed-toggle-icon">&#9660;</span>
        </div>
        <div class="cl-assessed-body collapsed" id="assessed-items-body">`;

      for (const item of assessedItems) {
        const linkedNcr = ncrByChecklist[item.id];
        const isNc = item.rating === 'minor_nc' || item.rating === 'major_nc';
        let ncrIndicator = '';
        if (isNc && linkedNcr) {
          const ncrStBadge = linkedNcr.status === 'open' ? 'badge-high' : linkedNcr.status === 'in_progress' ? 'badge-medium' : 'badge-low';
          ncrIndicator = `<div class="cl-ncr-link">
            <span class="badge ${ncrStBadge}">NCR: ${linkedNcr.status}</span>
            <span style="cursor:pointer;color:var(--primary);font-weight:500;font-size:12px" onclick="openNcrModal(${linkedNcr.id})">Edit NCR &rarr;</span>
          </div>`;
        }

        html += `<div class="checklist-item checklist-assessed${isNc ? ' checklist-nc' : ''}" id="cl-item-${item.id}">
          <div class="cl-header" style="cursor:pointer" onclick="toggleChecklistItemExpand(${item.id})">
            <div class="cl-clause">
              <strong>${esc(item.clause)}</strong>
              ${item.standard ? `<span class="badge badge-inactive" style="font-size:9px;margin-left:6px">${esc(item.standard.replace('ISO ',''))}</span>` : ''}
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <span class="badge ${ratingColors[item.rating]}">${ratingLabels[item.rating]}</span>
              <span class="cl-item-toggle" id="cl-toggle-${item.id}">&#9660;</span>
            </div>
          </div>
          ${item.requirement ? `<div class="cl-requirement">${esc(item.requirement)}</div>` : ''}
          <div class="cl-assessed-detail" id="cl-summary-${item.id}">
            ${item.evidence ? `<div class="cl-detail-row"><span class="cl-detail-label">Evidence:</span> ${esc(item.evidence.substring(0, 100))}${item.evidence.length > 100 ? '...' : ''}</div>` : ''}
            ${item.finding ? `<div class="cl-detail-row"><span class="cl-detail-label">Finding:</span> ${esc(item.finding.substring(0, 100))}${item.finding.length > 100 ? '...' : ''}</div>` : ''}
          </div>
          <div class="cl-fields collapsed" id="cl-fields-${item.id}">
            <div class="form-group" style="margin-bottom:8px">
              <label>Evidence Notes</label>
              <textarea rows="2" onchange="updateChecklistField(${item.id},'evidence',this.value)" placeholder="Evidence observed">${esc(item.evidence)}</textarea>
            </div>
            <div class="form-group" style="margin-bottom:8px">
              <label>Evidence Files & Links</label>
              <div class="cl-evidence-container">${renderChecklistEvidence(item, auditId)}</div>
              <div style="display:flex;gap:6px;margin-top:6px">
                <input type="file" id="cl-evidence-file-a-${item.id}" style="display:none" onchange="uploadChecklistEvidence(${item.id}, ${auditId})">
                <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('cl-evidence-file-a-${item.id}').click()">Upload File</button>
                <button type="button" class="btn btn-secondary btn-sm" onclick="openChecklistLinkPicker(${item.id}, ${auditId})">Link Item</button>
              </div>
            </div>
            <div class="form-group" style="margin-bottom:8px">
              <label>Finding</label>
              <textarea rows="2" onchange="updateChecklistField(${item.id},'finding',this.value)" placeholder="Audit finding">${esc(item.finding)}</textarea>
            </div>
            <div class="form-row">
              <div class="form-group" style="margin-bottom:8px">
                <label>Rating</label>
                <select onchange="updateChecklistField(${item.id},'rating',this.value)">
                  <option value="not_assessed" ${item.rating==='not_assessed'?'selected':''}>Not Assessed</option>
                  <option value="conforming" ${item.rating==='conforming'?'selected':''}>Conforming</option>
                  <option value="observation" ${item.rating==='observation'?'selected':''}>Observation</option>
                  <option value="minor_nc" ${item.rating==='minor_nc'?'selected':''}>Minor NC</option>
                  <option value="major_nc" ${item.rating==='major_nc'?'selected':''}>Major NC</option>
                </select>
              </div>
              <div class="form-group" style="margin-bottom:8px">
                <label>Notes</label>
                <input type="text" onchange="updateChecklistField(${item.id},'notes',this.value)" value="${esc(item.notes)}" placeholder="Additional notes">
              </div>
            </div>
          </div>
          ${ncrIndicator}
          <div class="cl-actions">
            ${actionMenu([
              { label: '&#8635; Reset to Unassessed', onclick: `resetChecklistRating(${item.id}, ${auditId})` },
              { label: '&#128465; Remove Item', onclick: `deleteChecklistItem(${item.id}, ${auditId})`, cls: 'danger' },
            ])}
          </div>
        </div>`;
      }
      html += '</div></div>';
    }

    // Render unassessed items (full form)
    if (unassessedItems.length > 0) {
      html += `<h4 class="cl-section-title" style="margin:16px 0 8px">&#9744; Items to Assess (${unassessedItems.length})</h4>`;
      html += '<div class="checklist-list">';
      for (const item of unassessedItems) {
        const linkedNcr = ncrByChecklist[item.id];
        const isNc = item.rating === 'minor_nc' || item.rating === 'major_nc';
        let ncrIndicator = '';
        if (isNc && linkedNcr) {
          const ncrStBadge = linkedNcr.status === 'open' ? 'badge-high' : linkedNcr.status === 'in_progress' ? 'badge-medium' : 'badge-low';
          ncrIndicator = `<div class="cl-ncr-link">
            <span class="badge ${ncrStBadge}">NCR: ${linkedNcr.status}</span>
            <span style="cursor:pointer;color:var(--primary);font-weight:500;font-size:12px" onclick="openNcrModal(${linkedNcr.id})">Edit NCR &rarr;</span>
          </div>`;
        }

        html += `<div class="checklist-item${isNc ? ' checklist-nc' : ''}" id="cl-item-${item.id}">
          <div class="cl-header">
            <div class="cl-clause">
              <strong>${esc(item.clause)}</strong>
              ${item.standard ? `<span class="badge badge-inactive" style="font-size:9px;margin-left:6px">${esc(item.standard.replace('ISO ',''))}</span>` : ''}
            </div>
            <span class="badge ${ratingColors[item.rating]}">${ratingLabels[item.rating]}</span>
          </div>
          ${item.requirement ? `<div class="cl-requirement">${esc(item.requirement)}</div>` : ''}
          <div class="cl-fields">
            <div class="form-group" style="margin-bottom:8px">
              <label>Evidence Notes</label>
              <textarea rows="2" onchange="updateChecklistField(${item.id},'evidence',this.value)" placeholder="Evidence observed">${esc(item.evidence)}</textarea>
            </div>
            <div class="form-group" style="margin-bottom:8px">
              <label>Evidence Files & Links</label>
              <div id="cl-evidence-${item.id}" class="cl-evidence-container">${renderChecklistEvidence(item, auditId)}</div>
              <div style="display:flex;gap:6px;margin-top:6px">
                <input type="file" id="cl-evidence-file-${item.id}" style="display:none" onchange="uploadChecklistEvidence(${item.id}, ${auditId})">
                <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('cl-evidence-file-${item.id}').click()">Upload File</button>
                <button type="button" class="btn btn-secondary btn-sm" onclick="openChecklistLinkPicker(${item.id}, ${auditId})">Link Item</button>
              </div>
            </div>
            <div class="form-group" style="margin-bottom:8px">
              <label>Finding</label>
              <textarea rows="2" onchange="updateChecklistField(${item.id},'finding',this.value)" placeholder="Audit finding">${esc(item.finding)}</textarea>
            </div>
            <div class="form-row">
              <div class="form-group" style="margin-bottom:8px">
                <label>Rating</label>
                <select onchange="updateChecklistField(${item.id},'rating',this.value)">
                  <option value="not_assessed" ${item.rating==='not_assessed'?'selected':''}>Not Assessed</option>
                  <option value="conforming" ${item.rating==='conforming'?'selected':''}>Conforming</option>
                  <option value="observation" ${item.rating==='observation'?'selected':''}>Observation</option>
                  <option value="minor_nc" ${item.rating==='minor_nc'?'selected':''}>Minor NC</option>
                  <option value="major_nc" ${item.rating==='major_nc'?'selected':''}>Major NC</option>
                </select>
              </div>
              <div class="form-group" style="margin-bottom:8px">
                <label>Notes</label>
                <input type="text" onchange="updateChecklistField(${item.id},'notes',this.value)" value="${esc(item.notes)}" placeholder="Additional notes">
              </div>
            </div>
          </div>
          ${ncrIndicator}
          <div class="cl-actions">
            ${actionMenu([
              { label: '&#128465; Remove Item', onclick: `deleteChecklistItem(${item.id}, ${auditId})`, cls: 'danger' },
            ])}
          </div>
        </div>`;
      }
      html += '</div>';
    }
  }

  content.innerHTML = html;
}

async function updateChecklistField(itemId, field, value) {
  const result = await api(`/api/checklist/${itemId}`, { method: 'PUT', body: { [field]: value } });
  // Re-render on rating change so badge and Raise NCR button update
  if (field === 'rating' && currentAuditId) {
    await loadAuditExecution(currentAuditId);
    if (result?._auditStatus === 'completed') {
      showAuditCompletedDialog(currentAuditId);
    }
  }
}

function showAuditCompletedDialog(auditId) {
  // Use a styled modal-style dialog instead of browser confirm
  const existing = document.getElementById('audit-complete-dialog');
  if (existing) existing.remove();

  const dialog = document.createElement('div');
  dialog.id = 'audit-complete-dialog';
  dialog.className = 'modal';
  dialog.innerHTML = `
    <div class="modal-overlay"></div>
    <div class="modal-content modal-sm" style="text-align:center;padding:28px 24px">
      <div style="font-size:36px;margin-bottom:12px">&#9989;</div>
      <h3 style="margin:0 0 8px">Audit Completed</h3>
      <p style="color:var(--text-muted);font-size:13px;margin:0 0 20px">All items have been assessed. The audit has been marked as <strong>completed</strong>.<br><br>Would you like to generate an audit report and save it to Document Control?</p>
      <div style="display:flex;gap:10px;justify-content:center">
        <button class="btn btn-secondary" onclick="document.getElementById('audit-complete-dialog').remove()">Not now</button>
        <button class="btn btn-primary" onclick="document.getElementById('audit-complete-dialog').remove();generateAuditReport(${auditId})">&#128196; Generate Report</button>
      </div>
    </div>`;
  document.body.appendChild(dialog);
}

// PDF Export for Audit Report
// ── Shared BOP PDF design tokens ──────────────────────────────────────────────
const BOP_PDF = {
  primary:    [17,  24,  39],
  primaryMid: [55,  65,  81],
  accentBg:   [243, 244, 246],
  success:    [16,  185, 129],
  successBg:  [209, 250, 229],
  warning:    [245, 158, 11],
  warningBg:  [254, 243, 199],
  danger:     [239, 68,  68],
  dangerBg:   [254, 226, 226],
  purple:     [139, 92,  246],
  purpleBg:   [237, 233, 254],
  text:       [17,  24,  39],
  muted:      [107, 114, 128],
  border:     [229, 231, 235],
  white:      [255, 255, 255],
};

// Renders 'Bop' in Dancing Script (the platform brand font) via canvas → PNG data URL
function bopLogoUrl(hexColor, sizePx) {
  const s = 3; // supersample for sharpness
  const w = 90, h = 44;
  const canvas = document.createElement('canvas');
  canvas.width = w * s; canvas.height = h * s;
  const ctx = canvas.getContext('2d');
  ctx.scale(s, s);
  ctx.fillStyle = hexColor;
  ctx.font = `700 ${sizePx}px 'Dancing Script', cursive`;
  ctx.textBaseline = 'middle';
  ctx.fillText('Bop', 2, h / 2);
  return canvas.toDataURL('image/png');
}

// Slim first-page header (26 mm tall)
function bopDrawMainHeader(doc, reportType, line1, line2) {
  const C = BOP_PDF;
  doc.setFillColor(...C.primary);
  doc.rect(0, 0, 210, 26, 'F');
  doc.setFillColor(...C.success);
  doc.rect(0, 0, 3, 26, 'F');
  // Dancing Script 'Bop' logo
  doc.addImage(bopLogoUrl('#ffffff', 34), 'PNG', 9, 3, 27, 13);
  doc.setFontSize(6); doc.setFont('helvetica', 'normal');
  doc.setTextColor(107, 114, 128);
  doc.text('Business Orchestration Platform', 9, 22);
  // Report type + title on right
  doc.setFontSize(9.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.white);
  doc.text(reportType, 201, 10, { align: 'right' });
  if (line1) {
    doc.setFontSize(7.5); doc.setFont('helvetica', 'normal');
    doc.setTextColor(209, 213, 219);
    doc.text(String(line1).substring(0, 58), 201, 17, { align: 'right' });
  }
  if (line2) {
    doc.setFontSize(6.5); doc.setTextColor(107, 114, 128);
    doc.text(String(line2), 201, 23, { align: 'right' });
  }
}

// Thin continuation header (8 mm tall)
function bopDrawContinuationHeader(doc, title) {
  const C = BOP_PDF;
  doc.setFillColor(...C.primary);
  doc.rect(0, 0, 210, 8, 'F');
  doc.setFillColor(...C.success);
  doc.rect(0, 0, 3, 8, 'F');
  doc.addImage(bopLogoUrl('#ffffff', 18), 'PNG', 8, 0.5, 13, 7);
  doc.setFontSize(6.5); doc.setFont('helvetica', 'normal');
  doc.setTextColor(156, 163, 175);
  doc.text('· ' + String(title).substring(0, 66), 23, 5.5);
}

// Footer on all pages
function bopDrawFooters(doc) {
  const C = BOP_PDF;
  const n = doc.internal.getNumberOfPages();
  const logoFooter = bopLogoUrl('#9ca3af', 18);
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setDrawColor(...C.border);
    doc.setLineWidth(0.2);
    doc.line(10, 283, 200, 283);
    doc.addImage(logoFooter, 'PNG', 9, 284.5, 10, 4.5);
    doc.setFontSize(6.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.muted);
    doc.text('Business Orchestration Platform', 21, 288.5);
    doc.text(`Page ${i} of ${n}`, 105, 288.5, { align: 'center' });
    doc.text(new Date().toISOString().split('T')[0], 201, 288.5, { align: 'right' });
  }
}

// Build the audit PDF doc object (shared between export and report-save flows)
async function buildAuditPDF(auditId) {
  const audit = await api(`/api/audits/${auditId}`);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const C = BOP_PDF;
  const ML = 14, CW = 182;

  let auditStandards = [];
  try { auditStandards = JSON.parse(audit.standards || '[]'); } catch(e) {}
  if (!auditStandards.length && audit.standard) auditStandards = [audit.standard];

  const checklist    = audit.checklist || [];
  const totalItems   = checklist.length;
  const conforming   = checklist.filter(c => c.rating === 'conforming').length;
  const observations = checklist.filter(c => c.rating === 'observation').length;
  const minorNc      = checklist.filter(c => c.rating === 'minor_nc').length;
  const majorNc      = checklist.filter(c => c.rating === 'major_nc').length;

  // ── Header ──────────────────────────────────────────────────────────────────
  bopDrawMainHeader(doc, 'Audit Report', audit.title, auditStandards.join(', '));
  let y = 33;

  // ── Metadata — flat 4-column grid, no card background ───────────────────────
  const metaFields = [
    ['Standard', auditStandards.join(', ') || '—'],
    ['Lead Auditor', audit.lead_auditor || 'Unassigned'],
    ['Auditee', audit.auditee || 'Unassigned'],
    ['Status', (audit.status || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())],
    ['Planned Date', audit.planned_date || '—'],
    ['Completed Date', audit.completed_date || '—'],
  ];
  doc.setDrawColor(...C.border); doc.setLineWidth(0.2);
  doc.line(ML, y, ML + CW, y);
  const mColW = CW / 4;
  for (let i = 0; i < metaFields.length; i++) {
    const col = i % 4, row = Math.floor(i / 4);
    const fx = ML + col * mColW, fy = y + 6 + row * 14;
    doc.setFontSize(6.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.muted);
    doc.text(metaFields[i][0].toUpperCase(), fx, fy);
    doc.setFontSize(8.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text);
    doc.text(String(metaFields[i][1]).substring(0, 24), fx, fy + 5.5);
  }
  y += 6 + Math.ceil(metaFields.length / 4) * 14 + 2;
  doc.setDrawColor(...C.border); doc.setLineWidth(0.2);
  doc.line(ML, y, ML + CW, y);
  y += 8;

  // ── Stat scorecard ──────────────────────────────────────────────────────────
  const statDefs = [
    { n: totalItems,   label: 'Total',    bg: C.accentBg,  col: C.primaryMid },
    { n: conforming,   label: 'Conform',  bg: C.successBg, col: C.success    },
    { n: observations, label: 'Obs',      bg: C.warningBg, col: C.warning    },
    { n: minorNc,      label: 'Minor NC', bg: C.dangerBg,  col: C.danger     },
    { n: majorNc,      label: 'Major NC', bg: C.purpleBg,  col: C.purple     },
  ];
  const bW = 32, bH = 18, bGap = 3.5;
  const bX0 = ML + (CW - (statDefs.length * bW + (statDefs.length - 1) * bGap)) / 2;
  statDefs.forEach(({ n, label, bg, col }, i) => {
    const sx = bX0 + i * (bW + bGap);
    doc.setFillColor(...bg);
    doc.roundedRect(sx, y, bW, bH, 1.5, 1.5, 'F');
    doc.setFillColor(...col);
    doc.rect(sx, y, bW, 1.5, 'F'); // top accent line
    doc.setFontSize(17); doc.setFont('helvetica', 'bold'); doc.setTextColor(...col);
    doc.text(String(n), sx + bW / 2, y + 12, { align: 'center' });
    doc.setFontSize(5.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.muted);
    doc.text(label.toUpperCase(), sx + bW / 2, y + 16.5, { align: 'center' });
  });
  y += bH + 10;

  // ── Findings table ──────────────────────────────────────────────────────────
  doc.setFillColor(...C.success); doc.rect(ML, y, 2, 7, 'F');
  doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text);
  doc.text('Audit Findings', ML + 6, y + 5);
  doc.setDrawColor(...C.border); doc.setLineWidth(0.2);
  doc.line(ML + 6, y + 7.5, ML + CW, y + 7.5);
  y += 12;

  const ratingLabels = {
    not_assessed: 'Not Assessed', conforming: 'Conforming',
    observation: 'Observation',   minor_nc: 'Minor NC', major_nc: 'Major NC',
  };
  doc.autoTable({
    startY: y,
    margin: { left: ML, right: ML },
    head: [['Clause', 'Standard', 'Requirement', 'Rating', 'Finding']],
    body: checklist.map(item => [
      item.clause,
      item.standard || audit.standard,
      (item.requirement || '').substring(0, 44) + ((item.requirement || '').length > 44 ? '…' : ''),
      ratingLabels[item.rating] || item.rating,
      (item.finding || '—').substring(0, 58) + ((item.finding || '').length > 58 ? '…' : ''),
    ]),
    theme: 'plain',
    styles: {
      fontSize: 7.5, cellPadding: { top: 2.5, bottom: 2.5, left: 3, right: 3 },
      textColor: C.text, lineColor: C.border, lineWidth: 0.2, overflow: 'linebreak',
    },
    headStyles: { fillColor: C.primary, textColor: C.white, fontStyle: 'bold', fontSize: 7.5,
      cellPadding: { top: 3, bottom: 3, left: 3, right: 3 } },
    columnStyles: {
      0: { cellWidth: 16 }, 1: { cellWidth: 22 },
      2: { cellWidth: 52 }, 3: { cellWidth: 24 }, 4: { cellWidth: 68 },
    },
    alternateRowStyles: { fillColor: C.accentBg },
    didParseCell(data) {
      if (data.column.index === 3 && data.section === 'body') {
        const r = checklist[data.row.index]?.rating;
        data.cell.styles.fontStyle = 'bold';
        if      (r === 'conforming')  data.cell.styles.textColor = C.success;
        else if (r === 'observation') data.cell.styles.textColor = C.warning;
        else if (r === 'minor_nc')    data.cell.styles.textColor = C.danger;
        else if (r === 'major_nc')    data.cell.styles.textColor = C.purple;
        else                          data.cell.styles.textColor = C.muted;
      }
    },
    didDrawPage(data) {
      if (data.pageNumber > 1) bopDrawContinuationHeader(doc, `Audit Report – ${audit.title}`);
    },
  });

  // ── NCR table ───────────────────────────────────────────────────────────────
  if (audit.non_conformities && audit.non_conformities.length) {
    y = doc.lastAutoTable.finalY + 10;
    if (y > 255) { doc.addPage(); bopDrawContinuationHeader(doc, `Audit Report – ${audit.title}`); y = 16; }

    doc.setFillColor(...C.danger); doc.rect(ML, y, 2, 7, 'F');
    doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text);
    doc.text('Non-Conformity Reports', ML + 6, y + 5);
    doc.setDrawColor(...C.border); doc.setLineWidth(0.2);
    doc.line(ML + 6, y + 7.5, ML + CW, y + 7.5);
    y += 12;

    doc.autoTable({
      startY: y,
      margin: { left: ML, right: ML },
      head: [['Clause', 'Severity', 'Description', 'Root Cause', 'Responsible', 'Status']],
      body: audit.non_conformities.map(nc => [
        nc.clause || '—',
        (nc.severity || 'minor').toUpperCase(),
        (nc.description || '—').substring(0, 55) + ((nc.description || '').length > 55 ? '…' : ''),
        (nc.root_cause || '—').substring(0, 38) + ((nc.root_cause || '').length > 38 ? '…' : ''),
        nc.responsible || '—',
        (nc.status || 'open').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      ]),
      theme: 'plain',
      styles: {
        fontSize: 7, cellPadding: { top: 2.5, bottom: 2.5, left: 3, right: 3 },
        textColor: C.text, lineColor: C.border, lineWidth: 0.2, overflow: 'linebreak',
      },
      headStyles: { fillColor: C.danger, textColor: C.white, fontStyle: 'bold', fontSize: 7 },
      columnStyles: {
        0: { cellWidth: 13 }, 1: { cellWidth: 15 }, 2: { cellWidth: 55 },
        3: { cellWidth: 44 }, 4: { cellWidth: 30 }, 5: { cellWidth: 25 },
      },
      alternateRowStyles: { fillColor: C.dangerBg },
      didParseCell(data) {
        if (data.column.index === 1 && data.section === 'body') {
          const sev = (audit.non_conformities[data.row.index]?.severity || '').toLowerCase();
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.textColor = sev === 'major' ? C.danger : C.warning;
        }
      },
      didDrawPage(data) {
        if (data.pageNumber > 1) bopDrawContinuationHeader(doc, `Audit Report – ${audit.title}`);
      },
    });
  }

  bopDrawFooters(doc);
  return { doc, audit };
}

async function exportAuditPDF(auditId) {
  const { doc, audit } = await buildAuditPDF(auditId);
  const filename = `Audit_Report_${(audit.title || 'report').replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.pdf`;
  doc.save(filename);
}

async function generateAuditReport(auditId) {
  try {
    const { doc, audit } = await buildAuditPDF(auditId);

    // Upload PDF to server → creates Document Control record
    const blob = doc.output('blob');
    const form = new FormData();
    form.append('pdf', blob, `audit-report-${auditId}.pdf`);
    const resp = await fetch(`/api/audits/${auditId}/upload-report`, { method: 'POST', body: form });
    if (!resp.ok) throw new Error('Upload failed: ' + resp.status);

    // Also trigger local download
    const filename = `Audit_Report_${(audit.title || 'report').replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.pdf`;
    doc.save(filename);

    showToast('Audit report generated and saved to Document Control!', 'success');
    loadAuditExecution(auditId);
  } catch (e) {
    alert('Failed to generate report: ' + e.message);
  }
}

async function completeAudit(auditId) {
  if (!confirm('Mark this audit as completed?')) return;
  await api(`/api/audits/${auditId}`, { method: 'PUT', body: { status: 'completed', completed_date: new Date().toISOString().split('T')[0] } });
  loadAuditExecution(auditId);
}

async function openChecklistModal(auditId) {
  document.getElementById('checklist-form').reset();
  document.getElementById('checklist-item-id').value = '';
  document.getElementById('checklist-audit-id').value = auditId;

  // Populate requirements dropdown based on audit's standard
  const audit = await api(`/api/audits/${auditId}`);
  const reqs = await api(`/api/requirements?standard=${encodeURIComponent(audit.standard)}`);
  const sel = document.getElementById('checklist-from-req');
  sel.innerHTML = '<option value="">-- Manual entry --</option>' +
    reqs.map(r => `<option value="${r.id}" data-clause="${esc(r.clause)}" data-title="${esc(r.title)}">${esc(r.clause)} - ${esc(r.title)}</option>`).join('');

  document.getElementById('checklist-modal').classList.remove('hidden');
}

function closeChecklistModal() {
  document.getElementById('checklist-modal').classList.add('hidden');
}

async function saveChecklistItem(e) {
  e.preventDefault();
  const auditId = document.getElementById('checklist-audit-id').value;
  await api(`/api/audits/${auditId}/checklist`, {
    method: 'POST',
    body: {
      clause: document.getElementById('checklist-clause').value,
      requirement: document.getElementById('checklist-requirement').value,
    }
  });
  closeChecklistModal();
  loadAuditExecution(auditId);
}

async function deleteChecklistItem(itemId, auditId) {
  if (!confirm('Remove this checklist item?')) return;
  await api(`/api/checklist/${itemId}`, { method: 'DELETE' });
  loadAuditExecution(auditId);
}

async function raiseNcrFromChecklist(auditId, checklistItemId, clause, severity) {
  await openNcrModal();
  document.getElementById('ncr-audit-id').value = String(auditId);
  document.getElementById('ncr-checklist-item-id').value = checklistItemId;
  document.getElementById('ncr-clause').value = clause;
  document.getElementById('ncr-severity').value = severity;
}

// --- Checklist Evidence Upload & Links ---
async function uploadChecklistEvidence(itemId, auditId) {
  // Two file inputs may exist for the same item (assessed "-a-" vs unassessed)
  const inputA = document.getElementById(`cl-evidence-file-a-${itemId}`);
  const inputB = document.getElementById(`cl-evidence-file-${itemId}`);
  const fileInput = (inputA && inputA.files.length) ? inputA : (inputB && inputB.files.length) ? inputB : null;
  if (!fileInput) return;

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);

  try {
    const res = await fetch(`/api/checklist/${itemId}/evidence`, { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Upload failed' }));
      alert(err.error || 'Evidence upload failed');
      return;
    }
  } catch (e) {
    alert('Evidence upload failed: network error');
    return;
  }
  fileInput.value = '';
  loadAuditExecution(auditId);
}

let checklistLinkPickerItemId = null;
let checklistLinkPickerAuditId = null;

async function openChecklistLinkPicker(itemId, auditId) {
  checklistLinkPickerItemId = itemId;
  checklistLinkPickerAuditId = auditId;
  document.getElementById('checklist-link-picker').classList.remove('hidden');
  await loadChecklistLinkOptions();
}

function closeChecklistLinkPicker() {
  document.getElementById('checklist-link-picker').classList.add('hidden');
  checklistLinkPickerItemId = null;
  checklistLinkPickerAuditId = null;
}

async function loadChecklistLinkOptions() {
  const typeSelect = document.getElementById('checklist-link-type');
  const optionsContainer = document.getElementById('checklist-link-options');
  const selectedType = typeSelect.value;

  const items = await api(`/api/linkable/${selectedType}`);
  optionsContainer.innerHTML = items.length === 0
    ? '<div style="color:var(--text-muted);font-style:italic">No items available</div>'
    : items.map(item => `
      <div class="link-option" onclick="addChecklistEvidenceLink('${selectedType}', ${item.id}, '${esc(item.name).replace(/'/g, "\\'")}')">
        ${esc(item.name)}
      </div>
    `).join('');
}

async function addChecklistEvidenceLink(linkType, linkId, linkName) {
  await api(`/api/checklist/${checklistLinkPickerItemId}/evidence-link`, {
    method: 'POST',
    body: { link_type: linkType, link_id: linkId, link_name: linkName }
  });
  closeChecklistLinkPicker();
  loadAuditExecution(checklistLinkPickerAuditId);
}

async function removeChecklistEvidence(itemId, evidenceId, auditId) {
  if (!confirm('Remove this evidence?')) return;
  await api(`/api/checklist/${itemId}/evidence/${evidenceId}`, { method: 'DELETE' });
  loadAuditExecution(auditId);
}

function downloadChecklistEvidence(itemId, evidenceId) {
  window.open(`/api/checklist/${itemId}/evidence/${evidenceId}/download`, '_blank');
}

function renderChecklistEvidence(item, auditId) {
  let evidenceFiles = [];
  try { evidenceFiles = JSON.parse(item.evidence_files || '[]'); } catch(e) {}

  if (evidenceFiles.length === 0) {
    return '<div style="color:var(--text-muted);font-size:12px;font-style:italic">No evidence attached</div>';
  }

  const typeIcons = { document: '&#128196;', process: '&#9881;', system: '&#128187;', asset: '&#128230;' };

  return evidenceFiles.map(ef => {
    if (ef.type === 'file') {
      return `<div class="evidence-item evidence-file">
        <span class="evidence-icon">&#128206;</span>
        <span class="evidence-name" onclick="downloadChecklistEvidence(${item.id}, ${ef.id})" style="cursor:pointer;text-decoration:underline">${esc(ef.name)}</span>
        <button class="evidence-remove" onclick="removeChecklistEvidence(${item.id}, ${ef.id}, ${auditId})" title="Remove">&times;</button>
      </div>`;
    } else if (ef.type === 'link') {
      const icon = typeIcons[ef.link_type] || '&#128279;';
      const viewTarget = getViewForType(ef.link_type, ef.link_id);
      return `<div class="evidence-item evidence-link">
        <span class="evidence-icon">${icon}</span>
        <span class="evidence-name"${viewTarget ? ` onclick="${viewTarget}" style="cursor:pointer;text-decoration:underline"` : ''}>${esc(ef.link_name)}</span>
        <button class="evidence-remove" onclick="removeChecklistEvidence(${item.id}, ${ef.id}, ${auditId})" title="Remove">&times;</button>
      </div>`;
    }
    return '';
  }).join('');
}

// Toggle assessed items visibility
function toggleAssessedItems() {
  const body = document.getElementById('assessed-items-body');
  const icon = document.getElementById('assessed-toggle-icon');
  if (body.classList.contains('collapsed')) {
    body.classList.remove('collapsed');
    icon.innerHTML = '&#9650;';
  } else {
    body.classList.add('collapsed');
    icon.innerHTML = '&#9660;';
  }
}

// Toggle individual checklist item expansion (for inline editing)
function toggleChecklistItemExpand(itemId) {
  const fields = document.getElementById(`cl-fields-${itemId}`);
  const summary = document.getElementById(`cl-summary-${itemId}`);
  const toggle = document.getElementById(`cl-toggle-${itemId}`);
  if (fields.classList.contains('collapsed')) {
    fields.classList.remove('collapsed');
    summary.classList.add('collapsed');
    toggle.innerHTML = '&#9650;';
  } else {
    fields.classList.add('collapsed');
    summary.classList.remove('collapsed');
    toggle.innerHTML = '&#9660;';
  }
}

// Reset checklist item rating to unassessed
async function resetChecklistRating(itemId, auditId) {
  await api(`/api/checklist/${itemId}`, { method: 'PUT', body: { rating: 'not_assessed' } });
  loadAuditExecution(auditId);
}

// Expand a checklist item for editing (opens full form in modal)
let expandedChecklistItem = null;

async function expandChecklistItem(itemId, auditId) {
  const audit = await api(`/api/audits/${auditId}`);
  const item = audit.checklist.find(i => i.id === itemId);
  if (!item) return;

  expandedChecklistItem = { itemId, auditId };

  // Show edit modal
  document.getElementById('checklist-edit-modal').classList.remove('hidden');
  document.getElementById('checklist-edit-clause').textContent = item.clause;
  document.getElementById('checklist-edit-requirement').textContent = item.requirement || '';
  document.getElementById('checklist-edit-evidence').value = item.evidence || '';
  document.getElementById('checklist-edit-finding').value = item.finding || '';
  document.getElementById('checklist-edit-rating').value = item.rating || 'not_assessed';
  document.getElementById('checklist-edit-notes').value = item.notes || '';
}

function closeChecklistEditModal() {
  document.getElementById('checklist-edit-modal').classList.add('hidden');
  expandedChecklistItem = null;
}

async function saveChecklistEdit() {
  if (!expandedChecklistItem) return;
  const { itemId, auditId } = expandedChecklistItem;

  await api(`/api/checklist/${itemId}`, {
    method: 'PUT',
    body: {
      evidence: document.getElementById('checklist-edit-evidence').value,
      finding: document.getElementById('checklist-edit-finding').value,
      rating: document.getElementById('checklist-edit-rating').value,
      notes: document.getElementById('checklist-edit-notes').value
    }
  });

  closeChecklistEditModal();
  loadAuditExecution(auditId);
}
