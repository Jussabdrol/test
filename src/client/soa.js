
// --- Statement of Applicability ---
let soaProcesses = [];

// Parse "A.5.10" → [5, 10] for correct numeric sorting
function soaClauseSort(clause) {
  const m = (clause || '').match(/[A-Z]\.(\d+)\.(\d+)/);
  return m ? [parseInt(m[1]), parseInt(m[2])] : [999, 999];
}

const SOA_CATEGORY_ORDER = ['Organizational Controls', 'People Controls', 'Physical Controls', 'Technological Controls'];

async function loadSoA() {
  const data = await api('/api/soa');
  soaProcesses = await api('/api/architecture?arch_type=process');
  const summary = document.getElementById('soa-summary');
  const list = document.getElementById('soa-list');

  if (data.length === 0) {
    summary.innerHTML = '';
    list.innerHTML = '<div class="empty-state">No Annex A controls found. Import the ISO 27001 Annex A template in the Requirements view first.</div>';
    return;
  }

  // Sort numerically by clause (A.5.2 before A.5.10)
  data.sort((a, b) => {
    const [a1, a2] = soaClauseSort(a.clause);
    const [b1, b2] = soaClauseSort(b.clause);
    return a1 !== b1 ? a1 - b1 : a2 - b2;
  });

  const applicable = data.filter(d => d.applicable !== 0);
  const notApplicable = data.filter(d => d.applicable === 0);
  const implemented = data.filter(d => d.implementation_status === 'implemented');
  const partial = data.filter(d => d.implementation_status === 'partial');

  summary.innerHTML = `
    <div class="stats-grid" style="margin-bottom:20px">
      <div class="stat-card"><div class="stat-value">${data.length}</div><div class="stat-label">Total Controls</div></div>
      <div class="stat-card done"><div class="stat-value">${applicable.length}</div><div class="stat-label">Applicable</div></div>
      <div class="stat-card"><div class="stat-value">${notApplicable.length}</div><div class="stat-label">Not Applicable</div></div>
      <div class="stat-card done"><div class="stat-value">${implemented.length}</div><div class="stat-label">Implemented</div></div>
      <div class="stat-card today"><div class="stat-value">${partial.length}</div><div class="stat-label">Partial</div></div>
    </div>`;

  // Group by category, preserving the canonical ISO 27001 Annex A order
  const groups = {};
  for (const d of data) {
    const cat = d.category || 'Uncategorized';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(d);
  }
  const orderedCats = [
    ...SOA_CATEGORY_ORDER.filter(c => groups[c]),
    ...Object.keys(groups).filter(c => !SOA_CATEGORY_ORDER.includes(c)),
  ];

  let html = '';
  for (const cat of orderedCats) {
    const items = groups[cat];
    html += `<div class="soa-category">
      <div class="soa-category-header">${esc(cat)} <span class="req-cat-count">(${items.length})</span></div>
      <div class="soa-table">
        <div class="soa-table-head">
          <div class="soa-col-control">Control</div>
          <div class="soa-col-check">Applicable</div>
          <div class="soa-col-check">Risk</div>
          <div class="soa-col-check">Regulatory</div>
          <div class="soa-col-impl">Implemented</div>
          <div class="soa-col-process">Process</div>
        </div>`;
    for (const item of items) {
      const isApplicable = item.applicable !== 0;
      const implStatus = item.implementation_status || 'not_implemented';
      const hasRisk = item.linked_treatments && item.linked_treatments.length > 0;
      const isRegulatory = item.regulatory === 1;
      const processIds = item.linked_process_ids || [];
      const processNames = item.linked_process_names || [];
      html += `<div class="soa-table-row${!isApplicable ? ' soa-na' : ''}">
          <div class="soa-col-control">
            <span class="req-clause">${esc(item.clause)}</span>
            <span class="soa-title">${esc(item.title)}</span>
          </div>
          <div class="soa-col-check">
            <input type="checkbox" ${isApplicable ? 'checked' : ''} onchange="updateSoA(${item.id}, 'applicable', this.checked)" title="Applicable">
          </div>
          <div class="soa-col-check">
            <input type="checkbox" ${hasRisk ? 'checked' : ''} disabled title="Risk linked (auto)">
          </div>
          <div class="soa-col-check">
            <input type="checkbox" ${isRegulatory ? 'checked' : ''} onchange="updateSoA(${item.id}, 'regulatory', this.checked)" title="Regulatory/contractual">
          </div>
          <div class="soa-col-impl">
            ${isApplicable ? `<select class="soa-impl-select" onchange="updateSoA(${item.id}, 'implementation_status', this.value)">
              <option value="not_implemented" ${implStatus==='not_implemented'?'selected':''}>No</option>
              <option value="partial" ${implStatus==='partial'?'selected':''}>Partial</option>
              <option value="implemented" ${implStatus==='implemented'?'selected':''}>Yes</option>
            </select>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}
          </div>
          <div class="soa-col-process">
            ${isApplicable ? `<button class="btn btn-secondary btn-sm" style="font-size:11px;padding:2px 8px" onclick="openSoAProcessPicker(${item.id}, [${processIds.join(',')}])">${processNames.length > 0 ? esc(processNames.join(', ')) : 'Link'}</button>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}
          </div>
        </div>`;
    }
    html += '</div></div>';
  }
  list.innerHTML = html;
}

function openSoAProcessPicker(requirementId, currentIds) {
  let modal = document.getElementById('soa-process-picker-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'soa-process-picker-modal';
    modal.className = 'modal hidden';
    document.body.appendChild(modal);
  }
  const processCheckboxes = soaProcesses.map(p =>
    `<label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px">
      <input type="checkbox" name="soa-proc" value="${p.id}" ${currentIds.includes(p.id) ? 'checked' : ''}>
      ${esc(p.name)}${p.owner ? ' <span style="color:var(--text-muted);font-size:11px">(' + esc(p.owner) + ')</span>' : ''}
    </label>`
  ).join('');
  modal.innerHTML = `
    <div class="modal-overlay" onclick="closeSoAProcessPicker()"></div>
    <div class="modal-content modal-sm">
      <div class="modal-header">
        <h3>Link Processes</h3>
        <button class="modal-close" onclick="closeSoAProcessPicker()">&times;</button>
      </div>
      <div style="max-height:300px;overflow-y:auto;padding:8px 0">
        ${soaProcesses.length === 0 ? '<div class="empty-state">No processes defined. Add processes in the Architecture view first.</div>' : processCheckboxes}
      </div>
      <div class="form-actions">
        <button class="btn btn-secondary" onclick="closeSoAProcessPicker()">Cancel</button>
        <button class="btn btn-primary" onclick="saveSoAProcesses(${requirementId})">Save</button>
      </div>
    </div>`;
  modal.classList.remove('hidden');
}

function closeSoAProcessPicker() {
  const m = document.getElementById('soa-process-picker-modal');
  if (m) m.classList.add('hidden');
}

async function saveSoAProcesses(requirementId) {
  const ids = [...document.querySelectorAll('#soa-process-picker-modal input[name="soa-proc"]:checked')].map(cb => parseInt(cb.value));
  await api(`/api/soa/${requirementId}`, { method: 'PUT', body: { linked_processes: ids } });
  closeSoAProcessPicker();
  loadSoA();
}

async function updateSoA(requirementId, field, value) {
  const body = {};
  body[field] = value;
  await api(`/api/soa/${requirementId}`, { method: 'PUT', body });
  loadSoA();
}

// --- SoA PDF Export ---
async function exportSoAPDF() {
  const [data, mission] = await Promise.all([
    api('/api/soa'),
    api('/api/mission'),
  ]);
  if (!data.length) { alert('No controls to export.'); return; }

  // Sort numerically
  data.sort((a, b) => {
    const [a1, a2] = soaClauseSort(a.clause);
    const [b1, b2] = soaClauseSort(b.clause);
    return a1 !== b1 ? a1 - b1 : a2 - b2;
  });

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const C = BOP_PDF;
  const ML = 14, CW = 182, PW = 210;
  const orgName = mission.org_name || 'Organisation';
  const today = new Date().toISOString().split('T')[0];

  // ── Cover page ────────────────────────────────────────────────────────────
  doc.setFillColor(...C.primary);
  doc.rect(0, 0, PW, 60, 'F');
  doc.setFontSize(22); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.white);
  doc.text('Statement of Applicability', PW / 2, 28, { align: 'center' });
  doc.setFontSize(13); doc.setFont('helvetica', 'normal');
  doc.text('ISO/IEC 27001:2022 — Annex A Controls', PW / 2, 38, { align: 'center' });
  doc.setFontSize(11);
  doc.text(orgName, PW / 2, 50, { align: 'center' });

  // Meta block below cover band
  let y = 72;
  const metaItems = [
    ['Organisation', orgName],
    ['Document Title', 'Statement of Applicability'],
    ['Standard', 'ISO/IEC 27001:2022'],
    ['Date', today],
    ['Version', '1.0'],
    ['Classification', 'Confidential'],
  ];
  const mColW = CW / 2;
  doc.setDrawColor(...C.border); doc.setLineWidth(0.2);
  doc.rect(ML, y - 4, CW, metaItems.length * 9 + 6, 'S');
  metaItems.forEach(([label, val], i) => {
    const fy = y + i * 9;
    if (i % 2 === 0) { doc.setFillColor(...C.accentBg); doc.rect(ML, fy - 4, CW, 9, 'F'); }
    doc.setFontSize(7.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.muted);
    doc.text(label.toUpperCase(), ML + 4, fy + 1.5);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.text);
    doc.text(String(val), ML + 4 + mColW, fy + 1.5);
  });
  y += metaItems.length * 9 + 14;

  // Purpose & scope intro
  doc.setFillColor(...C.successBg); doc.rect(ML, y, 2, 7, 'F');
  doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text);
  doc.text('Purpose & Scope', ML + 6, y + 5);
  y += 10;
  doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.text);
  const purposeLines = doc.splitTextToSize(
    'This Statement of Applicability (SoA) identifies all Annex A controls from ISO/IEC 27001:2022, ' +
    'declares whether each control is applicable to the organisation\'s Information Security Management System (ISMS), ' +
    'and documents the implementation status and justification for inclusion or exclusion.',
    CW
  );
  doc.text(purposeLines, ML, y);
  y += purposeLines.length * 5 + 6;

  // Organisation info
  if (mission.content || mission.vision) {
    doc.setFillColor(...C.successBg); doc.rect(ML, y, 2, 7, 'F');
    doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text);
    doc.text('Organisation', ML + 6, y + 5);
    y += 10;
    if (mission.content) {
      doc.setFontSize(7.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.muted);
      doc.text('MISSION', ML, y); y += 4;
      doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.text);
      const mLines = doc.splitTextToSize(mission.content, CW);
      doc.text(mLines.slice(0, 4), ML, y);
      y += Math.min(mLines.length, 4) * 5 + 4;
    }
    if (mission.vision) {
      doc.setFontSize(7.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.muted);
      doc.text('VISION', ML, y); y += 4;
      doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.text);
      const vLines = doc.splitTextToSize(mission.vision, CW);
      doc.text(vLines.slice(0, 4), ML, y);
      y += Math.min(vLines.length, 4) * 5 + 4;
    }
    y += 4;
  }

  // ── Summary scorecard ─────────────────────────────────────────────────────
  if (y > 230) { doc.addPage(); y = 16; }
  const applicable   = data.filter(d => d.applicable !== 0).length;
  const notAppl      = data.filter(d => d.applicable === 0).length;
  const implemented  = data.filter(d => d.implementation_status === 'implemented').length;
  const partial      = data.filter(d => d.implementation_status === 'partial').length;
  const notImpl      = data.filter(d => d.applicable !== 0 && d.implementation_status === 'not_implemented').length;

  doc.setFillColor(...C.successBg); doc.rect(ML, y, 2, 7, 'F');
  doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text);
  doc.text('Control Summary', ML + 6, y + 5);
  y += 12;

  const statDefs = [
    { n: data.length,  label: 'Total',       bg: C.accentBg,  col: C.primaryMid },
    { n: applicable,   label: 'Applicable',  bg: C.successBg, col: C.success    },
    { n: notAppl,      label: 'Excluded',    bg: C.dangerBg,  col: C.danger     },
    { n: implemented,  label: 'Implemented', bg: C.successBg, col: C.success    },
    { n: partial,      label: 'Partial',     bg: C.warningBg, col: C.warning    },
    { n: notImpl,      label: 'Not Impl.',   bg: C.dangerBg,  col: C.danger     },
  ];
  const bW = 27, bH = 18, bGap = 3;
  const bX0 = ML + (CW - (statDefs.length * bW + (statDefs.length - 1) * bGap)) / 2;
  statDefs.forEach(({ n, label, bg, col }, i) => {
    const sx = bX0 + i * (bW + bGap);
    doc.setFillColor(...bg);
    doc.roundedRect(sx, y, bW, bH, 1.5, 1.5, 'F');
    doc.setFillColor(...col); doc.rect(sx, y, bW, 1.5, 'F');
    doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.setTextColor(...col);
    doc.text(String(n), sx + bW / 2, y + 12, { align: 'center' });
    doc.setFontSize(5.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.muted);
    doc.text(label.toUpperCase(), sx + bW / 2, y + 16.5, { align: 'center' });
  });
  y += bH + 10;

  // ── Controls table per category ───────────────────────────────────────────
  const groups = {};
  for (const d of data) {
    const cat = d.category || 'Uncategorized';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(d);
  }
  const orderedCats = [
    ...SOA_CATEGORY_ORDER.filter(c => groups[c]),
    ...Object.keys(groups).filter(c => !SOA_CATEGORY_ORDER.includes(c)),
  ];

  const implLabel = { implemented: 'Yes', partial: 'Partial', not_implemented: 'No' };
  const implColor = { implemented: C.success, partial: C.warning, not_implemented: C.danger };

  for (const cat of orderedCats) {
    const items = groups[cat];
    if (y > 240) { doc.addPage(); bopDrawContinuationHeader(doc, 'Statement of Applicability'); y = 16; }

    doc.setFillColor(...C.successBg); doc.rect(ML, y, 2, 7, 'F');
    doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text);
    doc.text(`${cat} (${items.length} controls)`, ML + 6, y + 5);
    doc.setDrawColor(...C.border); doc.setLineWidth(0.2);
    doc.line(ML + 6, y + 7.5, ML + CW, y + 7.5);
    y += 12;

    doc.autoTable({
      startY: y,
      margin: { left: ML, right: ML },
      head: [['Control', 'Title', 'Appl.', 'Risk', 'Reg.', 'Implemented', 'Justification / Notes']],
      body: items.map(item => {
        const isAppl = item.applicable !== 0;
        const status = item.implementation_status || 'not_implemented';
        const justification = [item.justification, item.soa_notes].filter(Boolean).join(' — ') || (isAppl ? '' : 'Out of scope');
        return [
          item.clause,
          (item.title || '').substring(0, 40) + ((item.title || '').length > 40 ? '…' : ''),
          isAppl ? '✓' : '✗',
          item.linked_treatments?.length > 0 ? '✓' : '',
          item.regulatory === 1 ? '✓' : '',
          isAppl ? (implLabel[status] || status) : '—',
          justification.substring(0, 55) + (justification.length > 55 ? '…' : ''),
        ];
      }),
      theme: 'plain',
      styles: {
        fontSize: 7, cellPadding: { top: 2, bottom: 2, left: 2.5, right: 2.5 },
        textColor: C.text, lineColor: C.border, lineWidth: 0.15, overflow: 'linebreak',
      },
      headStyles: { fillColor: C.primary, textColor: C.white, fontStyle: 'bold', fontSize: 7,
        cellPadding: { top: 2.5, bottom: 2.5, left: 2.5, right: 2.5 } },
      columnStyles: {
        0: { cellWidth: 12 },
        1: { cellWidth: 46 },
        2: { cellWidth: 10, halign: 'center' },
        3: { cellWidth: 9,  halign: 'center' },
        4: { cellWidth: 9,  halign: 'center' },
        5: { cellWidth: 18, halign: 'center' },
        6: { cellWidth: 78 },
      },
      alternateRowStyles: { fillColor: C.accentBg },
      didParseCell(data) {
        if (data.section === 'body') {
          const item = items[data.row.index];
          const isAppl = item?.applicable !== 0;
          const status = item?.implementation_status || 'not_implemented';
          if (data.column.index === 2) {
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.textColor = isAppl ? C.success : C.danger;
          }
          if (data.column.index === 5 && isAppl) {
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.textColor = implColor[status] || C.muted;
          }
          if (!isAppl) data.cell.styles.textColor = C.muted;
        }
      },
      didDrawPage(d) {
        if (d.pageNumber > 1) bopDrawContinuationHeader(doc, 'Statement of Applicability');
      },
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  // ── Exclusions summary ────────────────────────────────────────────────────
  const excluded = data.filter(d => d.applicable === 0);
  if (excluded.length) {
    if (y > 240) { doc.addPage(); bopDrawContinuationHeader(doc, 'Statement of Applicability'); y = 16; }
    doc.setFillColor(...C.dangerBg); doc.rect(ML, y, 2, 7, 'F');
    doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text);
    doc.text(`Excluded Controls (${excluded.length})`, ML + 6, y + 5);
    doc.setDrawColor(...C.border); doc.line(ML + 6, y + 7.5, ML + CW, y + 7.5);
    y += 12;
    doc.autoTable({
      startY: y,
      margin: { left: ML, right: ML },
      head: [['Control', 'Title', 'Justification for Exclusion']],
      body: excluded.map(item => [
        item.clause,
        item.title || '',
        item.justification || item.soa_notes || 'Not applicable to scope',
      ]),
      theme: 'plain',
      styles: { fontSize: 7.5, cellPadding: { top: 2.5, bottom: 2.5, left: 3, right: 3 },
        textColor: C.muted, lineColor: C.border, lineWidth: 0.15 },
      headStyles: { fillColor: C.danger, textColor: C.white, fontStyle: 'bold', fontSize: 7.5 },
      columnStyles: { 0: { cellWidth: 16 }, 1: { cellWidth: 52 }, 2: { cellWidth: 114 } },
      didDrawPage(d) { if (d.pageNumber > 1) bopDrawContinuationHeader(doc, 'Statement of Applicability'); },
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  // ── Approval block ────────────────────────────────────────────────────────
  if (y > 245) { doc.addPage(); bopDrawContinuationHeader(doc, 'Statement of Applicability'); y = 16; }
  doc.setFillColor(...C.successBg); doc.rect(ML, y, 2, 7, 'F');
  doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text);
  doc.text('Approval', ML + 6, y + 5);
  y += 12;
  const approvalCols = ['Role', 'Name', 'Signature', 'Date'];
  const approvalRows = [['Prepared by', '', '', ''], ['Reviewed by', '', '', ''], ['Approved by', '', '', '']];
  doc.autoTable({
    startY: y, margin: { left: ML, right: ML },
    head: [approvalCols], body: approvalRows,
    theme: 'plain',
    styles: { fontSize: 8.5, cellPadding: { top: 6, bottom: 6, left: 4, right: 4 },
      lineColor: C.border, lineWidth: 0.2 },
    headStyles: { fillColor: C.primary, textColor: C.white, fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 36 }, 1: { cellWidth: 52 }, 2: { cellWidth: 52 }, 3: { cellWidth: 42 } },
  });

  bopDrawFooters(doc);

  const filename = `SoA_${orgName.replace(/[^a-z0-9]/gi, '_')}_${today}.pdf`;
  const blob = doc.output('blob');

  // Ask about Document Control before saving
  showSoADocControlDialog(doc, blob, filename);
}

function showSoADocControlDialog(doc, blob, filename) {
  const existing = document.getElementById('soa-doccontrol-dialog');
  if (existing) existing.remove();

  const dialog = document.createElement('div');
  dialog.id = 'soa-doccontrol-dialog';
  dialog.className = 'modal';
  dialog.innerHTML = `
    <div class="modal-overlay"></div>
    <div class="modal-content modal-sm" style="text-align:center;padding:28px 24px">
      <div style="font-size:36px;margin-bottom:12px">&#128196;</div>
      <h3 style="margin:0 0 8px">Statement of Applicability</h3>
      <p style="color:var(--text-muted);font-size:13px;margin:0 0 20px">Your SoA PDF is ready.<br><br>Would you like to save it to <strong>Document Control</strong>?</p>
      <div style="display:flex;gap:10px;justify-content:center">
        <button class="btn btn-secondary" id="soa-download-only">Download only</button>
        <button class="btn btn-primary" id="soa-save-and-download">&#128229; Save to Document Control</button>
      </div>
    </div>`;
  document.body.appendChild(dialog);

  document.getElementById('soa-download-only').onclick = () => {
    doc.save(filename);
    dialog.remove();
  };
  document.getElementById('soa-save-and-download').onclick = async () => {
    dialog.remove();
    doc.save(filename);
    try {
      const form = new FormData();
      form.append('pdf', blob, filename);
      const resp = await fetch('/api/soa/upload-report', { method: 'POST', body: form });
      if (!resp.ok) throw new Error('Upload failed: ' + resp.status);
      showToast('SoA saved to Document Control!', 'success');
    } catch (e) {
      alert('Download succeeded but saving to Document Control failed: ' + e.message);
    }
  };
}
