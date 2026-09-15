
// ============================================================
// Management Reviews (ISO 9.3)
// ============================================================

const MGMT_REVIEW_CATEGORIES = [
  { key: 'previous_actions',           label: 'Status of previous management review actions' },
  { key: 'internal_external_issues',   label: 'Internal and external issues (context of the organisation)' },
  { key: 'customer_feedback',          label: 'Customer feedback and complaints' },
  { key: 'process_performance',        label: 'Process performance and product / service conformity' },
  { key: 'nonconformities',            label: 'Nonconformities and corrective actions' },
  { key: 'audit_results',              label: 'Audit results' },
  { key: 'supplier_performance',       label: 'Supplier and external provider performance' },
  { key: 'risk_opportunities',         label: 'Risks and opportunities (risk register updates)' },
  { key: 'kpi_performance',            label: 'KPI and objective performance' },
  { key: 'resource_adequacy',          label: 'Adequacy of resources' },
  { key: 'improvement_opportunities',  label: 'Opportunities for improvement' },
];

let currentMgmtReviewId = null;
let mgmtReviewInputsCache = {};
let mgmtReviewAttendeesCache = [];
let mgmtReviewRefData = null;       // cached reference data from other modules
let mgmtRoleOptions = [];           // cached role list for pickers

// ── Helpers ──────────────────────────────────────────────────────────────────

async function populateMgmtRoles() {
  if (!mgmtRoleOptions.length) {
    mgmtRoleOptions = await api('/api/architecture?arch_type=role').catch(() => []);
  }
  const options = '<option value="">— Select Role —</option>'
    + mgmtRoleOptions.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');

  const outputSel = document.getElementById('mgmt-output-assigned-to');
  if (outputSel) outputSel.innerHTML = options;

  const chairSel = document.getElementById('mgmt-chairperson');
  if (chairSel) chairSel.innerHTML = options;

  const attendeePicker = document.getElementById('mgmt-attendee-role-picker');
  if (attendeePicker) {
    attendeePicker.innerHTML = '<option value="">&#128100; Add from roles…</option>'
      + mgmtRoleOptions.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
  }
}

// Builds a reference-data HTML block for each input category from live module data
function buildRefPanel(categoryKey) {
  if (!mgmtReviewRefData) return '';
  const { prevOutputs = [], openActions = [], openNcrs = [], allNcrs = [], recentAudits = [],
          kpis = [], openRisks = [], riskTreatments = [], suppliers = [], mission = null, archItems = [] } = mgmtReviewRefData;

  function row(icon, text) { return `<div class="mgmt-ref-row">${icon} ${text}</div>`; }
  function badge(cls, t) { return `<span class="badge ${cls}" style="font-size:10px">${t}</span>`; }

  let rows = [];

  if (categoryKey === 'previous_actions') {
    if (!prevOutputs.length) rows.push(row('&#10003;', '<em>No open outputs from previous reviews.</em>'));
    else rows = prevOutputs.map(o =>
      row('&#128203;', `${esc(o.review_title)} (${o.review_date || '?'}) — ${esc(o.description)} ${badge('badge-medium', o.status)}`));
    rows.push(row('&#9889;', `<strong>${openActions.length}</strong> open action${openActions.length !== 1 ? 's' : ''} in the Actions module`));
  }

  else if (categoryKey === 'internal_external_issues') {
    if (mission) {
      if (mission.content) rows.push(row('&#127919;', `<strong>Mission:</strong> ${esc(mission.content.substring(0, 200))}${mission.content.length > 200 ? '…' : ''}`));
      if (mission.vision) rows.push(row('&#128218;', `<strong>Vision:</strong> ${esc(mission.vision.substring(0, 200))}${mission.vision.length > 200 ? '…' : ''}`));
      if (mission.legal_entities) {
        try {
          const le = JSON.parse(mission.legal_entities);
          if (le.length) rows.push(row('&#127981;', `<strong>Legal entities:</strong> ${le.map(l => esc(l.name || l)).join(', ')}`));
        } catch {}
      }
    }
    if (!rows.length) rows.push(row('&#8505;', '<em>No context data found. Fill in Mission Control.</em>'));
  }

  else if (categoryKey === 'customer_feedback') {
    const cust = openNcrs.filter(n => n.severity === 'major' || (n.clause && n.clause.toLowerCase().includes('customer')));
    if (!cust.length && openNcrs.length) rows.push(row('&#128203;', `${openNcrs.length} open NCR${openNcrs.length !== 1 ? 's' : ''} (none specifically tagged customer-facing)`));
    else if (!openNcrs.length) rows.push(row('&#10003;', '<em>No open non-conformities.</em>'));
    else cust.slice(0, 8).forEach(n => rows.push(row('&#9888;', `${badge('badge-critical', n.severity)} ${esc(n.clause || '')} — ${esc(n.description.substring(0, 120))}${n.description.length > 120 ? '…' : ''}`)));
  }

  else if (categoryKey === 'process_performance') {
    const taskKpis = kpis.filter(k => k.module === 'tasks' || k.module === 'general' || k.module === 'custom');
    if (!taskKpis.length && !openActions.length) rows.push(row('&#8505;', '<em>No KPI data recorded yet.</em>'));
    taskKpis.slice(0, 6).forEach(k => {
      const val = k.latest_value != null ? `${k.latest_value}${k.unit ? ' ' + k.unit : ''}` : 'No data';
      const target = k.target_value != null ? `target: ${k.target_value}${k.unit ? ' ' + k.unit : ''}` : '';
      rows.push(row('&#128200;', `${esc(k.name)}: <strong>${val}</strong>${target ? ` (${target})` : ''} — ${k.latest_period || ''}`));
    });
    rows.push(row('&#9889;', `<strong>${openActions.length}</strong> open follow-up action${openActions.length !== 1 ? 's' : ''}`));
  }

  else if (categoryKey === 'nonconformities') {
    if (!allNcrs.length) rows.push(row('&#10003;', '<em>No non-conformities on record.</em>'));
    else {
      const byStatus = {};
      allNcrs.forEach(n => { byStatus[n.status] = (byStatus[n.status] || 0) + 1; });
      rows.push(row('&#128203;', `<strong>${allNcrs.length}</strong> non-conformit${allNcrs.length !== 1 ? 'ies' : 'y'} total — ` +
        Object.entries(byStatus).map(([s, c]) => `${c} ${s}`).join(', ')));
      allNcrs.slice(0, 12).forEach(n => {
        const icon = n.status === 'closed' || n.status === 'verified' ? '&#10003;' : (n.severity === 'major' ? '&#128308;' : '&#128992;');
        const severityBadge = badge(n.severity === 'major' ? 'badge-critical' : 'badge-medium', n.severity || 'minor');
        const statusBadge = badge(n.status === 'closed' || n.status === 'verified' ? 'badge-low' : 'badge-medium', n.status);
        rows.push(row(icon, `${severityBadge} ${statusBadge} ${esc(n.clause || '')} — ${esc(n.description.substring(0, 100))}${n.description.length > 100 ? '…' : ''}`));
      });
      if (allNcrs.length > 12) rows.push(row('&#8230;', `…and ${allNcrs.length - 12} more`));
    }
  }

  else if (categoryKey === 'audit_results') {
    if (!recentAudits.length) rows.push(row('&#9998;', '<em>No audits recorded yet.</em>'));
    else recentAudits.slice(0, 8).forEach(a => {
      const stBadge = { planned: 'badge-medium', in_progress: 'badge-high', completed: 'badge-low', cancelled: 'badge-inactive' }[a.status] || 'badge-secondary';
      rows.push(row('&#9998;', `${esc(a.title)} — ${badge(stBadge, a.status)} ${a.open_ncr_count > 0 ? badge('badge-critical', a.open_ncr_count + ' open NCR' + (a.open_ncr_count !== 1 ? 's' : '')) : ''} ${a.planned_date ? esc(a.planned_date) : ''}`));
    });
  }

  else if (categoryKey === 'supplier_performance') {
    if (!suppliers.length) {
      rows.push(row('&#128230;', '<em>No suppliers registered. Add them in Architecture → Suppliers.</em>'));
    } else {
      const high = suppliers.filter(s => s.criticality === 'high');
      const expired = suppliers.filter(s => s.contract_status === 'expired');
      const noDpa = suppliers.filter(s => s.dpa_in_place === 'no');
      rows.push(row('&#128230;', `<strong>${suppliers.length}</strong> supplier${suppliers.length !== 1 ? 's' : ''} registered — ${high.length} high criticality${expired.length ? ', ' + expired.length + ' expired contract' + (expired.length !== 1 ? 's' : '') : ''}${noDpa.length ? ', ' + noDpa.length + ' without DPA' : ''}`));
      suppliers.slice(0, 10).forEach(s => {
        const critBadge = badge(s.criticality === 'high' ? 'badge-critical' : s.criticality === 'medium' ? 'badge-medium' : 'badge-low', s.criticality);
        const contractBadge = s.contract_status === 'expired' ? badge('badge-critical', 'expired') : badge('badge-low', s.contract_status);
        rows.push(row('&#128204;', `${critBadge} ${contractBadge} <strong>${esc(s.name)}</strong> (${esc(s.category || 'other')})`));
      });
      if (suppliers.length > 10) rows.push(row('&#8230;', `…and ${suppliers.length - 10} more`));
    }
  }

  else if (categoryKey === 'risk_opportunities') {
    if (!openRisks.length) rows.push(row('&#10003;', '<em>No active risks in the risk register.</em>'));
    else {
      const critical = openRisks.filter(r => r.inherent_score >= 15);
      const high = openRisks.filter(r => r.inherent_score >= 9 && r.inherent_score < 15);
      if (critical.length) rows.push(row('&#128308;', `<strong>${critical.length} critical risk${critical.length !== 1 ? 's' : ''}</strong> (score ≥ 15)`));
      if (high.length) rows.push(row('&#128992;', `<strong>${high.length} high risk${high.length !== 1 ? 's' : ''}</strong> (score 9–14)`));
      openRisks.slice(0, 8).forEach(r => rows.push(row('&#9888;', `${esc(r.title)} — score: <strong>${r.inherent_score}</strong> (L:${r.likelihood}×I:${r.impact}) ${esc(r.category || '')}`)));
    }
    if (riskTreatments.length) {
      const openTreat = riskTreatments.filter(t => t.status === 'planned' || t.status === 'in_progress');
      const doneTreat = riskTreatments.filter(t => t.status === 'completed');
      rows.push(row('&#128736;', `<strong>${riskTreatments.length}</strong> treatment action${riskTreatments.length !== 1 ? 's' : ''} — ${openTreat.length} open, ${doneTreat.length} completed`));
      openTreat.slice(0, 6).forEach(t => {
        const stBadge = badge(t.status === 'in_progress' ? 'badge-medium' : 'badge-info', t.status);
        rows.push(row('&#8618;', `${stBadge} ${esc(t.description.substring(0, 90))}${t.description.length > 90 ? '…' : ''}${t.responsible ? ' · ' + esc(t.responsible) : ''}`));
      });
    }
  }

  else if (categoryKey === 'kpi_performance') {
    if (!kpis.length) rows.push(row('&#128200;', '<em>No KPIs configured. Set them up in Mission Control.</em>'));
    else kpis.forEach(k => {
      const val = k.latest_value != null ? k.latest_value : null;
      const target = k.target_value != null ? k.target_value : null;
      let statusIcon = '&#128200;';
      if (val != null && target != null) statusIcon = val >= target ? '&#128994;' : '&#128308;';
      const valStr = val != null ? `${val}${k.unit ? ' ' + k.unit : ''}` : 'No data';
      const tgtStr = target != null ? ` / target: ${target}${k.unit ? ' ' + k.unit : ''}` : '';
      rows.push(row(statusIcon, `${esc(k.name)}: <strong>${valStr}</strong>${tgtStr}${k.latest_period ? ' (' + k.latest_period + ')' : ''}`));
    });
  }

  else if (categoryKey === 'resource_adequacy') {
    const typeIcons = { role: '&#128100;', process: '&#9881;', system: '&#128187;', asset: '&#128230;', facility: '&#127970;', supplier: '&#128204;' };
    const typeLabels = { role: 'Roles', process: 'Processes', system: 'Systems / Data', asset: 'Assets', facility: 'Facilities', supplier: 'Suppliers (Architecture)' };
    if (!archItems.length) {
      rows.push(row('&#8505;', '<em>No architecture items found.</em>'));
    } else {
      rows.push(row('&#127970;', `<strong>${archItems.length}</strong> total active architecture item${archItems.length !== 1 ? 's' : ''}`));
      const byType = {};
      archItems.forEach(i => { byType[i.arch_type] = (byType[i.arch_type] || 0) + 1; });
      Object.entries(byType).forEach(([type, count]) => {
        rows.push(row(typeIcons[type] || '&#8226;', `<strong>${count}</strong> ${typeLabels[type] || type}`));
      });
    }
  }

  else if (categoryKey === 'improvement_opportunities') {
    const improvements = prevOutputs.filter(o => o.type === 'improvement');
    const openImprove = openActions.filter(a => a.priority === 'High' || a.priority === 'Critical');
    if (improvements.length) {
      rows.push(row('&#128161;', `<strong>${improvements.length}</strong> improvement output${improvements.length !== 1 ? 's' : ''} from previous reviews still open:`));
      improvements.slice(0, 5).forEach(o => rows.push(row('&#8594;', `${esc(o.description.substring(0, 100))}…`)));
    }
    if (openImprove.length) rows.push(row('&#9889;', `<strong>${openImprove.length}</strong> high/critical priority action${openImprove.length !== 1 ? 's' : ''} in the Actions module`));
    if (!rows.length) rows.push(row('&#10003;', '<em>No open improvement items found.</em>'));
  }

  if (!rows.length) return '';
  return rows.join('');
}

// Auto-fill textarea from module reference data
function autoFillMgmtInput(categoryKey) {
  if (!mgmtReviewRefData) return;
  const textarea = document.querySelector(`textarea[data-category="${categoryKey}"]`);
  if (!textarea) return;
  if (textarea.value.trim() && !confirm('This category already has notes. Replace them with auto-filled data?')) return;

  const { prevOutputs = [], openActions = [], openNcrs = [], allNcrs = [], recentAudits = [],
          kpis = [], openRisks = [], riskTreatments = [], suppliers = [], mission = null, archItems = [] } = mgmtReviewRefData;

  let text = '';

  if (categoryKey === 'previous_actions') {
    if (prevOutputs.length) {
      text += `Open outputs from previous reviews (${prevOutputs.length}):\n`;
      prevOutputs.forEach(o => { text += `• [${o.status}] ${o.description} (${o.review_title}, ${o.review_date || ''})\n`; });
    }
    if (openActions.length) text += `\nOpen actions in system: ${openActions.length}`;
  }
  else if (categoryKey === 'internal_external_issues') {
    if (mission) {
      if (mission.content) text += `Mission: ${mission.content}\n`;
      if (mission.vision) text += `Vision: ${mission.vision}\n`;
    }
  }
  else if (categoryKey === 'customer_feedback') {
    if (openNcrs.length) {
      text += `Open non-conformities (${openNcrs.length}):\n`;
      openNcrs.slice(0, 10).forEach(n => { text += `• [${n.severity || 'minor'}] ${n.clause || ''} — ${n.description.substring(0, 120)}\n`; });
    } else { text = 'No open non-conformities at time of review.'; }
  }
  else if (categoryKey === 'process_performance') {
    const kpiData = kpis.filter(k => k.latest_value != null);
    if (kpiData.length) {
      text += `KPI performance:\n`;
      kpiData.forEach(k => { text += `• ${k.name}: ${k.latest_value}${k.unit ? ' ' + k.unit : ''}${k.target_value != null ? ' / target: ' + k.target_value : ''}\n`; });
    }
    text += `\nOpen follow-up actions: ${openActions.length}`;
  }
  else if (categoryKey === 'nonconformities') {
    if (!allNcrs.length) { text = 'No non-conformities on record at time of review.'; }
    else {
      const byStatus = {};
      allNcrs.forEach(n => { byStatus[n.status] = (byStatus[n.status] || 0) + 1; });
      text += `Non-conformities (${allNcrs.length} total — ${Object.entries(byStatus).map(([s, c]) => `${c} ${s}`).join(', ')}):\n`;
      allNcrs.forEach(n => { text += `• [${n.severity || 'minor'}] [${n.status}] ${n.clause || ''} — ${n.description.substring(0, 150)} (responsible: ${n.responsible || 'unassigned'})\n`; });
    }
  }
  else if (categoryKey === 'audit_results') {
    if (!recentAudits.length) { text = 'No audits recorded.'; }
    else {
      text += `Recent audits (${recentAudits.length}):\n`;
      recentAudits.forEach(a => { text += `• ${a.title} — ${a.status}${a.open_ncr_count > 0 ? `, ${a.open_ncr_count} open NCR(s)` : ''} (${a.planned_date || 'no date'})\n`; });
    }
  }
  else if (categoryKey === 'supplier_performance') {
    if (!suppliers.length) { text = 'No suppliers registered. Add suppliers in Architecture → Suppliers.'; }
    else {
      const high = suppliers.filter(s => s.criticality === 'high');
      const expired = suppliers.filter(s => s.contract_status === 'expired');
      const noDpa = suppliers.filter(s => s.dpa_in_place === 'no');
      const openRemediation = suppliers.filter(s => s.remediation_status === 'open' || s.remediation_status === 'in_progress');
      text += `Supplier register (${suppliers.length} active):\n`;
      if (high.length) text += `• High criticality: ${high.length}\n`;
      if (expired.length) text += `• Expired contracts: ${expired.length}\n`;
      if (noDpa.length) text += `• Without DPA: ${noDpa.length}\n`;
      if (openRemediation.length) text += `• Open remediation items: ${openRemediation.length}\n`;
      text += `\nSuppliers:\n`;
      suppliers.forEach(s => { text += `• [${s.criticality}] ${s.name} (${s.category || 'other'}) — contract: ${s.contract_status}, DPA: ${s.dpa_in_place}\n`; });
    }
  }
  else if (categoryKey === 'risk_opportunities') {
    if (!openRisks.length) { text = 'No active risks in register.'; }
    else {
      text += `Active risks (${openRisks.length}):\n`;
      openRisks.forEach(r => { text += `• [${r.status}] ${r.title} — score: ${r.inherent_score} (L:${r.likelihood}×I:${r.impact}) [${r.category || 'general'}]\n`; });
    }
    if (riskTreatments.length) {
      const openTreat = riskTreatments.filter(t => t.status === 'planned' || t.status === 'in_progress');
      const doneTreat = riskTreatments.filter(t => t.status === 'completed');
      text += `\nTreatment actions (${riskTreatments.length} total — ${openTreat.length} open, ${doneTreat.length} completed):\n`;
      riskTreatments.forEach(t => { text += `• [${t.status}] ${t.description.substring(0, 120)} (${t.risk_title})${t.responsible ? ' — ' + t.responsible : ''}\n`; });
    }
  }
  else if (categoryKey === 'kpi_performance') {
    if (!kpis.length) { text = 'No KPIs configured.'; }
    else {
      text += `KPI performance:\n`;
      kpis.forEach(k => {
        const val = k.latest_value != null ? `${k.latest_value}${k.unit ? ' ' + k.unit : ''}` : 'no data';
        const tgt = k.target_value != null ? ` (target: ${k.target_value}${k.unit ? ' ' + k.unit : ''})` : '';
        const period = k.latest_period ? ` — ${k.latest_period}` : '';
        text += `• ${k.name}: ${val}${tgt}${period}\n`;
      });
    }
  }
  else if (categoryKey === 'resource_adequacy') {
    const typeLabels = { role: 'Roles', process: 'Processes', system: 'Systems / Data', asset: 'Assets', facility: 'Facilities', supplier: 'Suppliers (Architecture)' };
    if (!archItems.length) { text = 'No architecture items recorded.'; }
    else {
      const byType = {};
      archItems.forEach(i => { byType[i.arch_type] = (byType[i.arch_type] || 0) + 1; });
      text += `Organisation architecture (${archItems.length} total active items):\n`;
      Object.entries(byType).forEach(([type, count]) => { text += `• ${typeLabels[type] || type}: ${count}\n`; });
    }
  }
  else if (categoryKey === 'improvement_opportunities') {
    const improvements = prevOutputs.filter(o => o.type === 'improvement');
    if (improvements.length) {
      text += `Open improvement outputs from previous reviews:\n`;
      improvements.forEach(o => { text += `• ${o.description} (${o.review_title})\n`; });
    }
    const highPri = openActions.filter(a => a.priority === 'High' || a.priority === 'Critical');
    if (highPri.length) { text += `\nHigh-priority open actions: ${highPri.length}`; }
    if (!text) text = 'No improvement items identified.';
  }

  if (text.trim()) {
    textarea.value = text.trim();
    saveMgmtInput(categoryKey, textarea);
  }
}

// ── List view ────────────────────────────────────────────────────────────────

async function loadManagementReviews() {
  const reviews = await api('/api/management-reviews');
  renderMgmtReviewList(reviews);
  closeMgmtReviewDetail();
}

function renderMgmtReviewList(reviews) {
  const container = document.getElementById('mgmt-reviews-arch-list');
  if (!reviews.length) {
    container.innerHTML = '<div class="empty-state">No management reviews yet. Schedule one to get started.</div>';
    return;
  }
  const stBadgeMap = { scheduled: 'badge-info', in_progress: 'badge-warning', completed: 'badge-success' };
  const cols = '2fr 130px 1fr 120px 130px 44px';
  let html = `<div class="arch-table">
    <div class="arch-table-head" style="grid-template-columns:${cols}">
      <div class="arch-col-name">Title</div>
      <div class="arch-col-detail">Review Date</div>
      <div class="arch-col-detail">Chairperson</div>
      <div class="arch-col-detail">Status</div>
      <div class="arch-col-detail">Next Review</div>
      <div class="arch-col-actions"></div>
    </div>`;
  for (const r of reviews) {
    const atCount = (() => { try { return JSON.parse(r.attendees || '[]').length; } catch { return 0; } })();
    html += `<div class="arch-table-row-wrap">
      <div class="arch-table-row" style="grid-template-columns:${cols};cursor:pointer" onclick="openManagementReview(${r.id})">
        <div class="arch-col-name">
          <span class="arch-name" style="color:var(--primary)">${esc(r.title)}</span>
          ${atCount ? `<span class="arch-desc">&#128100; ${atCount} attendee${atCount !== 1 ? 's' : ''}</span>` : ''}
        </div>
        <div class="arch-col-detail"><span style="font-size:13px">${r.review_date || '—'}</span></div>
        <div class="arch-col-detail"><span style="font-size:13px">${esc(r.chairperson || '—')}</span></div>
        <div class="arch-col-detail"><span class="badge ${stBadgeMap[r.status] || 'badge-secondary'}">${r.status.replace('_', ' ')}</span></div>
        <div class="arch-col-detail"><span style="font-size:13px">${r.next_review_date || '—'}</span></div>
        <div class="arch-col-actions" onclick="event.stopPropagation()">
          ${actionMenu([
            { label: '&#9998; Edit', onclick: `openMgmtReviewModal(${r.id})` },
            'sep',
            { label: '&#128465; Delete', onclick: `deleteMgmtReview(${r.id})`, cls: 'danger' },
          ])}
        </div>
      </div>
    </div>`;
  }
  html += '</div>';
  container.innerHTML = html;
}

// ── Detail view ──────────────────────────────────────────────────────────────

async function openManagementReview(id) {
  currentMgmtReviewId = id;
  document.getElementById('mgmt-reviews-list-panel').classList.add('hidden');
  document.getElementById('mgmt-reviews-detail-panel').classList.remove('hidden');
  await loadMgmtReviewDetail(id);
}

function closeMgmtReviewDetail() {
  currentMgmtReviewId = null;
  mgmtReviewRefData = null;
  document.getElementById('mgmt-reviews-list-panel').classList.remove('hidden');
  document.getElementById('mgmt-reviews-detail-panel').classList.add('hidden');
}

async function loadMgmtReviewDetail(id) {
  // Fetch review data and reference data in parallel
  const [data, refData] = await Promise.all([
    api(`/api/management-reviews/${id}`),
    api(`/api/management-reviews/${id}/reference-data`).catch(() => null),
  ]);
  mgmtReviewRefData = refData;
  const { review, inputs, outputs } = data;

  // Header
  document.getElementById('mgmt-detail-title').textContent = review.title;
  const statusClasses = { scheduled: 'badge-info', in_progress: 'badge-warning', completed: 'badge-success' };
  const badge = document.getElementById('mgmt-detail-status-badge');
  badge.className = `badge ${statusClasses[review.status] || 'badge-secondary'}`;
  badge.textContent = review.status.replace('_', ' ');

  // Meta bar
  document.getElementById('mgmt-detail-meta').innerHTML = `
    <div class="mgmt-meta-grid">
      <div><label>Review Date</label><span>${review.review_date || '—'}</span></div>
      <div><label>Chairperson</label><span>${esc(review.chairperson || '—')}</span></div>
      <div><label>Next Review Date</label><span>${review.next_review_date || '—'}</span></div>
      <div><label>Attendees</label><span>${(JSON.parse(review.attendees || '[]')).length} recorded</span></div>
    </div>`;

  // Cache
  mgmtReviewInputsCache = {};
  for (const inp of inputs) mgmtReviewInputsCache[inp.category] = inp.content || '';
  mgmtReviewAttendeesCache = JSON.parse(review.attendees || '[]');

  // Report button
  document.getElementById('mgmt-download-report-btn').style.display = review.report_html ? '' : 'none';

  renderMgmtInputsAccordion();
  renderMgmtOutputsList(outputs);
  renderMgmtAttendeesTab(review);
  populateMgmtRoles();

  switchMgmtTab('inputs', document.querySelector('.mgmt-tab[data-tab="inputs"]'));
}

function switchMgmtTab(tab, btn) {
  document.querySelectorAll('.mgmt-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.mgmt-tab-panel').forEach(p => p.classList.add('hidden'));
  if (btn) btn.classList.add('active');
  document.getElementById(`mgmt-tab-${tab}`).classList.remove('hidden');
}

// ── Inputs accordion ─────────────────────────────────────────────────────────

function renderMgmtInputsAccordion() {
  const container = document.getElementById('mgmt-inputs-accordion');
  container.innerHTML = MGMT_REVIEW_CATEGORIES.map((cat, i) => {
    const content = mgmtReviewInputsCache[cat.key] || '';
    const hasContent = content.trim().length > 0;
    const refHtml = buildRefPanel(cat.key);
    return `<div class="mgmt-accordion-item">
      <button class="mgmt-accordion-header ${i === 0 ? 'open' : ''}" onclick="toggleMgmtAccordion(this)" type="button">
        <span class="mgmt-accordion-label">${cat.label}</span>
        <span class="mgmt-accordion-indicator ${hasContent ? 'has-content' : ''}">${hasContent ? '&#9679;' : '&#9675;'}</span>
        <span class="mgmt-accordion-chevron">&#9660;</span>
      </button>
      <div class="mgmt-accordion-body ${i === 0 ? '' : 'hidden'}">
        ${refHtml ? `<div class="mgmt-ref-panel">
          <div class="mgmt-ref-header">
            <span class="mgmt-ref-label">&#128270; Module data</span>
            <button type="button" class="mgmt-ref-autofill" onclick="autoFillMgmtInput('${cat.key}')">&#9654; Auto-fill from data</button>
          </div>
          <div class="mgmt-ref-content">${refHtml}</div>
        </div>` : ''}
        <textarea
          class="form-input mgmt-input-textarea"
          data-category="${cat.key}"
          rows="5"
          placeholder="Record findings, data, or notes for this input category…"
          onblur="saveMgmtInput('${cat.key}', this)"
        >${esc(content)}</textarea>
      </div>
    </div>`;
  }).join('');
}

function toggleMgmtAccordion(header) {
  const body = header.nextElementSibling;
  const isOpen = !body.classList.contains('hidden');
  document.getElementById('mgmt-inputs-accordion').querySelectorAll('.mgmt-accordion-body').forEach(b => b.classList.add('hidden'));
  document.getElementById('mgmt-inputs-accordion').querySelectorAll('.mgmt-accordion-header').forEach(h => h.classList.remove('open'));
  if (!isOpen) {
    body.classList.remove('hidden');
    header.classList.add('open');
  }
}

async function saveMgmtInput(category, textarea) {
  if (!currentMgmtReviewId) return;
  const content = textarea.value;
  if (content === (mgmtReviewInputsCache[category] || '')) return;
  try {
    await api(`/api/management-reviews/${currentMgmtReviewId}/inputs/${category}`, {
      method: 'PUT',
      body: { content },
    });
    mgmtReviewInputsCache[category] = content;
    const indicator = textarea.closest('.mgmt-accordion-item').querySelector('.mgmt-accordion-indicator');
    if (indicator) {
      indicator.classList.toggle('has-content', !!content.trim());
      indicator.innerHTML = content.trim() ? '&#9679;' : '&#9675;';
    }
  } catch (e) {
    console.error('Failed to save input:', e);
  }
}

// ── Outputs ───────────────────────────────────────────────────────────────────

function renderMgmtOutputsList(outputs) {
  const container = document.getElementById('mgmt-outputs-list');
  if (!outputs.length) {
    container.innerHTML = '<div class="empty-state" style="padding:32px">No outputs recorded yet. Add decisions and required actions from the review.</div>';
    return;
  }
  const typeLabels = { improvement: 'Improvement', resource: 'Resource Need', change: 'System Change' };
  const statusClasses = { open: 'badge-secondary', in_progress: 'badge-warning', completed: 'badge-success' };
  container.innerHTML = `<div class="arch-table" style="margin-top:8px">
    <div class="arch-table-head" style="grid-template-columns:2.5fr 130px 1fr 110px 120px 110px 44px">
      <div>Description</div><div>Type</div><div>Assigned To</div>
      <div>Due Date</div><div>Status</div><div>Action</div><div></div>
    </div>
    ${outputs.map(o => `<div class="arch-table-row-wrap">
      <div class="arch-table-row" style="grid-template-columns:2.5fr 130px 1fr 110px 120px 110px 44px">
        <div style="font-size:13px;min-width:0">${esc(o.description)}</div>
        <div><span class="badge badge-info" style="font-size:11px">${typeLabels[o.type] || o.type}</span></div>
        <div style="font-size:12px">${esc(o.assigned_to || '—')}</div>
        <div style="font-size:12px">${o.due_date ? esc(o.due_date) : '—'}</div>
        <div><span class="badge ${statusClasses[o.status] || 'badge-secondary'}">${esc(o.status.replace('_', ' '))}</span></div>
        <div>${o.linked_action_id
          ? `<span class="badge badge-success" style="font-size:11px" title="Pushed to Actions">&#10003; #${o.linked_action_id}</span>`
          : `<button class="btn btn-secondary btn-xs" onclick="pushOutputToAction(${o.id})">&#8594; Push to Actions</button>`
        }</div>
        <div class="arch-col-actions">
          ${actionMenu([{ label: '&#9998; Edit', onclick: `openOutputModal(${currentMgmtReviewId},${o.id})` }, 'sep', { label: '&#128465; Delete', onclick: `deleteOutputById(${o.id})`, cls: 'danger' }])}
        </div>
      </div>
    </div>`).join('')}
  </div>`;
}

// ── Attendees & Summary ───────────────────────────────────────────────────────

function renderMgmtAttendeesTab(review) {
  document.getElementById('mgmt-summary-field').value = review.summary || '';
  mgmtReviewAttendeesCache = JSON.parse(review.attendees || '[]');
  renderAttendeesChips();
}

function renderAttendeesChips() {
  const chips = document.getElementById('mgmt-attendees-chips');
  if (!mgmtReviewAttendeesCache.length) {
    chips.innerHTML = '<span style="color:var(--text-muted);font-size:0.9em">No attendees recorded yet</span>';
    return;
  }
  chips.innerHTML = mgmtReviewAttendeesCache.map((a, i) =>
    `<span class="mgmt-attendee-chip">${esc(a)}<button type="button" class="mgmt-attendee-remove" onclick="removeMgmtAttendee(${i})">&#10005;</button></span>`
  ).join('');
}

async function addMgmtAttendee() {
  const input = document.getElementById('mgmt-new-attendee');
  const name = input.value.trim();
  if (!name || !currentMgmtReviewId) return;
  if (!mgmtReviewAttendeesCache.includes(name)) {
    mgmtReviewAttendeesCache.push(name);
    await api(`/api/management-reviews/${currentMgmtReviewId}`, { method: 'PUT', body: { attendees: mgmtReviewAttendeesCache } });
    renderAttendeesChips();
  }
  input.value = '';
}

async function addMgmtAttendeeFromRole(select) {
  const name = select.value;
  select.value = '';
  if (!name || !currentMgmtReviewId) return;
  if (!mgmtReviewAttendeesCache.includes(name)) {
    mgmtReviewAttendeesCache.push(name);
    await api(`/api/management-reviews/${currentMgmtReviewId}`, { method: 'PUT', body: { attendees: mgmtReviewAttendeesCache } });
    renderAttendeesChips();
  }
}

async function removeMgmtAttendee(index) {
  if (!currentMgmtReviewId) return;
  mgmtReviewAttendeesCache.splice(index, 1);
  await api(`/api/management-reviews/${currentMgmtReviewId}`, { method: 'PUT', body: { attendees: mgmtReviewAttendeesCache } });
  renderAttendeesChips();
}

async function saveMgmtSummary() {
  if (!currentMgmtReviewId) return;
  const summary = document.getElementById('mgmt-summary-field').value;
  await api(`/api/management-reviews/${currentMgmtReviewId}`, { method: 'PUT', body: { summary } });
}

// ── Modal: Schedule / Edit Review ────────────────────────────────────────────

let editingMgmtReviewId = null;

async function openMgmtReviewModal(id = null) {
  editingMgmtReviewId = id;
  await populateMgmtRoles();
  const titleEl = document.getElementById('mgmt-review-modal-title');
  const saveBtn = document.getElementById('mgmt-review-save-btn');
  if (id) {
    titleEl.textContent = 'Edit Management Review';
    saveBtn.textContent = 'Save Changes';
    const data = await api(`/api/management-reviews/${id}`);
    const r = data.review;
    document.getElementById('mgmt-title').value = r.title;
    document.getElementById('mgmt-review-date').value = r.review_date;
    document.getElementById('mgmt-status').value = r.status;
    // Set chairperson select value
    const chairSel = document.getElementById('mgmt-chairperson');
    chairSel.value = r.chairperson || '';
    document.getElementById('mgmt-next-review-date').value = r.next_review_date || '';
  } else {
    titleEl.textContent = 'Schedule Management Review';
    saveBtn.textContent = 'Schedule Review';
    document.getElementById('mgmt-review-form').reset();
    document.getElementById('mgmt-review-date').value = new Date().toISOString().split('T')[0];
  }
  document.getElementById('mgmt-review-modal').classList.remove('hidden');
}

function closeMgmtReviewModal() {
  document.getElementById('mgmt-review-modal').classList.add('hidden');
  editingMgmtReviewId = null;
}

async function saveMgmtReview(e) {
  e.preventDefault();
  const body = {
    title: document.getElementById('mgmt-title').value.trim(),
    review_date: document.getElementById('mgmt-review-date').value,
    status: document.getElementById('mgmt-status').value,
    chairperson: document.getElementById('mgmt-chairperson').value,
    next_review_date: document.getElementById('mgmt-next-review-date').value || null,
  };
  if (editingMgmtReviewId) {
    await api(`/api/management-reviews/${editingMgmtReviewId}`, { method: 'PUT', body });
  } else {
    const created = await api('/api/management-reviews', { method: 'POST', body });
    editingMgmtReviewId = created.id;
  }
  closeMgmtReviewModal();
  if (currentMgmtReviewId) await loadMgmtReviewDetail(currentMgmtReviewId);
  await loadManagementReviews();
  if (editingMgmtReviewId && !currentMgmtReviewId) await openManagementReview(editingMgmtReviewId);
}

async function deleteMgmtReview(id) {
  if (!confirm('Delete this management review and all its inputs/outputs? This cannot be undone.')) return;
  await api(`/api/management-reviews/${id}`, { method: 'DELETE' });
  closeMgmtReviewDetail();
  await loadManagementReviews();
}

// ── Modal: Output ─────────────────────────────────────────────────────────────

let editingOutputId = null;

async function openOutputModal(reviewId, outputId = null) {
  editingOutputId = outputId;
  document.getElementById('mgmt-output-review-id').value = reviewId;
  document.getElementById('mgmt-output-modal-title').textContent = outputId ? 'Edit Output' : 'Add Review Output';
  document.getElementById('mgmt-output-save-btn').textContent = outputId ? 'Save Changes' : 'Add Output';
  document.getElementById('mgmt-output-delete-btn').style.display = outputId ? '' : 'none';

  await populateMgmtRoles();

  if (outputId) {
    const outputs = await api(`/api/management-reviews/${reviewId}/outputs`);
    const o = outputs.find(x => x.id === outputId);
    if (o) {
      document.getElementById('mgmt-output-id').value = o.id;
      document.getElementById('mgmt-output-description').value = o.description;
      document.getElementById('mgmt-output-type').value = o.type;
      document.getElementById('mgmt-output-status').value = o.status;
      document.getElementById('mgmt-output-assigned-to').value = o.assigned_to || '';
      document.getElementById('mgmt-output-due-date').value = o.due_date || '';
    }
  } else {
    document.getElementById('mgmt-output-form').reset();
    document.getElementById('mgmt-output-id').value = '';
  }
  document.getElementById('mgmt-output-modal').classList.remove('hidden');
}

function closeMgmtOutputModal() {
  document.getElementById('mgmt-output-modal').classList.add('hidden');
  editingOutputId = null;
}

async function saveOutput(e) {
  e.preventDefault();
  const reviewId = document.getElementById('mgmt-output-review-id').value;
  const body = {
    description: document.getElementById('mgmt-output-description').value.trim(),
    type: document.getElementById('mgmt-output-type').value,
    status: document.getElementById('mgmt-output-status').value,
    assigned_to: document.getElementById('mgmt-output-assigned-to').value,
    due_date: document.getElementById('mgmt-output-due-date').value || null,
  };
  if (editingOutputId) {
    await api(`/api/management-reviews/${reviewId}/outputs/${editingOutputId}`, { method: 'PUT', body });
  } else {
    await api(`/api/management-reviews/${reviewId}/outputs`, { method: 'POST', body });
  }
  closeMgmtOutputModal();
  const data = await api(`/api/management-reviews/${reviewId}`);
  renderMgmtOutputsList(data.outputs);
}

async function deleteOutput() {
  if (!editingOutputId || !currentMgmtReviewId) return;
  if (!confirm('Delete this output?')) return;
  await api(`/api/management-reviews/${currentMgmtReviewId}/outputs/${editingOutputId}`, { method: 'DELETE' });
  closeMgmtOutputModal();
  const data = await api(`/api/management-reviews/${currentMgmtReviewId}`);
  renderMgmtOutputsList(data.outputs);
}

async function deleteOutputById(outputId) {
  if (!currentMgmtReviewId) return;
  if (!confirm('Delete this output?')) return;
  await api(`/api/management-reviews/${currentMgmtReviewId}/outputs/${outputId}`, { method: 'DELETE' });
  const data = await api(`/api/management-reviews/${currentMgmtReviewId}`);
  renderMgmtOutputsList(data.outputs);
}

async function pushOutputToAction(outputId) {
  if (!currentMgmtReviewId) return;
  await api(`/api/management-reviews/${currentMgmtReviewId}/outputs/${outputId}/push-to-actions`, { method: 'POST', body: {} });
  const data = await api(`/api/management-reviews/${currentMgmtReviewId}`);
  renderMgmtOutputsList(data.outputs);
}

// ── Management Review PDF ─────────────────────────────────────────────────────

async function generateMgmtReviewPDF(reviewId) {
  const { jsPDF } = window.jspdf;
  const C = BOP_PDF;
  const data = await api(`/api/management-reviews/${reviewId}`);
  const { review, inputs, outputs } = data;

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const ML = 14, CW = 182;

  // ── Header ──────────────────────────────────────────────────────────────────
  bopDrawMainHeader(doc, 'Management Review',
    review.title, `ISO 9001 Cl. 9.3  ·  ${review.review_date || '—'}`);
  let y = 33;

  // ── Metadata — flat 4-column grid ───────────────────────────────────────────
  const metaFields = [
    ['Status',      (review.status || 'scheduled').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())],
    ['Chairperson', review.chairperson || '—'],
    ['Review Date', review.review_date || '—'],
    ['Next Review', review.next_review_date || '—'],
  ];
  doc.setDrawColor(...C.border); doc.setLineWidth(0.2);
  doc.line(ML, y, ML + CW, y);
  const mColW = CW / 4;
  metaFields.forEach(([label, value], i) => {
    const fx = ML + i * mColW;
    doc.setFontSize(6.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.muted);
    doc.text(label.toUpperCase(), fx, y + 6);
    doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text);
    doc.text(String(value), fx, y + 12);
  });
  y += 19;
  doc.setDrawColor(...C.border); doc.setLineWidth(0.2);
  doc.line(ML, y, ML + CW, y);
  y += 8;

  // ── Attendees as inline chips ────────────────────────────────────────────────
  const attendees = JSON.parse(review.attendees || '[]');
  if (attendees.length) {
    doc.setFillColor(...C.success); doc.rect(ML, y, 2, 6, 'F');
    doc.setFontSize(8.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text);
    doc.text('Attendees', ML + 6, y + 4.5);
    y += 10;
    doc.setFontSize(8); doc.setFont('helvetica', 'normal');
    let ax = ML, chipY = y;
    const chipH = 6, chipPad = 3.5;
    attendees.forEach(a => {
      const tw = doc.getTextWidth(a) + chipPad * 2;
      if (ax + tw > ML + CW) { ax = ML; chipY += chipH + 2; }
      doc.setFillColor(...C.accentBg);
      doc.setDrawColor(...C.border); doc.setLineWidth(0.2);
      doc.roundedRect(ax, chipY, tw, chipH, 1, 1, 'FD');
      doc.setTextColor(...C.primaryMid);
      doc.text(a, ax + chipPad, chipY + 4.3);
      ax += tw + 2;
    });
    y = chipY + chipH + 8;
  }

  // ── Executive summary ────────────────────────────────────────────────────────
  if (review.summary && review.summary.trim()) {
    doc.setFillColor(...C.success); doc.rect(ML, y, 2, 6, 'F');
    doc.setFontSize(8.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text);
    doc.text('Executive Summary', ML + 6, y + 4.5);
    y += 10;
    doc.setFontSize(8.5); doc.setFont('helvetica', 'italic'); doc.setTextColor(...C.primaryMid);
    const sLines = doc.splitTextToSize(review.summary, CW - 4);
    doc.text(sLines, ML + 2, y + 1);
    y += sLines.length * 5 + 8;
  }

  // ── Input categories ─────────────────────────────────────────────────────────
  doc.setFillColor(...C.purple); doc.rect(ML, y, 2, 6, 'F');
  doc.setFontSize(8.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text);
  doc.text('Review Inputs  ·  ISO 9001 Cl. 9.3.2', ML + 6, y + 4.5);
  doc.setDrawColor(...C.border); doc.setLineWidth(0.2);
  doc.line(ML + 6, y + 7, ML + CW, y + 7);
  y += 12;

  const inputMap = {};
  for (const inp of inputs) inputMap[inp.category] = inp.content || '';

  const accentCycle = [C.purple, C.success, C.warning, C.danger];
  for (let ci = 0; ci < MGMT_REVIEW_CATEGORIES.length; ci++) {
    const cat = MGMT_REVIEW_CATEGORIES[ci];
    const content = inputMap[cat.key] || '';
    doc.setFontSize(8); doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(content || '(No data recorded)', CW - 6);
    const blockH = lines.length * 4.5 + 11;

    if (y + blockH > 272) {
      doc.addPage();
      bopDrawContinuationHeader(doc, 'Management Review · Inputs');
      y = 16;
    }

    // Thin left accent bar — colour cycles through accent palette
    doc.setFillColor(...accentCycle[ci % accentCycle.length]);
    doc.rect(ML, y, 1.5, blockH - 1, 'F');

    doc.setFontSize(6.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.muted);
    doc.text(cat.label.toUpperCase(), ML + 5, y + 4.5);
    doc.setFontSize(8); doc.setFont('helvetica', 'normal');
    doc.setTextColor(...(content ? C.text : C.muted));
    doc.text(lines, ML + 5, y + 9.5);

    doc.setDrawColor(...C.border); doc.setLineWidth(0.15);
    doc.line(ML, y + blockH, ML + CW, y + blockH);
    y += blockH + 3;
  }

  // ── Outputs table ────────────────────────────────────────────────────────────
  if (outputs.length) {
    if (y + 25 > 272) {
      doc.addPage();
      bopDrawContinuationHeader(doc, 'Management Review · Outputs');
      y = 16;
    }
    doc.setFillColor(...C.success); doc.rect(ML, y, 2, 6, 'F');
    doc.setFontSize(8.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text);
    doc.text('Review Outputs  ·  ISO 9001 Cl. 9.3.3', ML + 6, y + 4.5);
    doc.setDrawColor(...C.border); doc.setLineWidth(0.2);
    doc.line(ML + 6, y + 7, ML + CW, y + 7);
    y += 12;

    doc.autoTable({
      startY: y,
      margin: { left: ML, right: ML },
      theme: 'plain',
      styles: {
        fontSize: 7.5, cellPadding: { top: 2.5, bottom: 2.5, left: 3, right: 3 },
        textColor: C.text, lineColor: C.border, lineWidth: 0.2,
      },
      headStyles: { fillColor: C.primary, textColor: C.white, fontStyle: 'bold', fontSize: 7.5 },
      alternateRowStyles: { fillColor: C.accentBg },
      head: [['Description', 'Type', 'Assigned To', 'Due Date', 'Status']],
      body: outputs.map(o => [
        o.description,
        o.type.charAt(0).toUpperCase() + o.type.slice(1),
        o.assigned_to || '—',
        o.due_date || '—',
        o.status.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()),
      ]),
      columnStyles: {
        0: { cellWidth: 65 }, 1: { cellWidth: 26 },
        2: { cellWidth: 38 }, 3: { cellWidth: 24 }, 4: { cellWidth: 29 },
      },
      didParseCell(data) {
        if (data.section === 'body') {
          if (data.column.index === 1) {
            const t = outputs[data.row.index]?.type;
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.textColor = t === 'improvement' ? C.success : t === 'resource' ? C.warning : C.purple;
          }
          if (data.column.index === 4) {
            const s = outputs[data.row.index]?.status;
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.textColor = s === 'completed' ? C.success : s === 'in_progress' ? C.warning : C.muted;
          }
        }
      },
      didDrawPage() {
        bopDrawContinuationHeader(doc, 'Management Review · Outputs');
      },
    });
  }

  bopDrawFooters(doc);
  return doc;
}

async function generateMgmtReport(reviewId) {
  const btn = document.getElementById('mgmt-generate-report-btn');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  try {
    const doc = await generateMgmtReviewPDF(reviewId);

    // Upload PDF to server (creates/updates Document Control record)
    const blob = doc.output('blob');
    const form = new FormData();
    form.append('pdf', blob, `management-review-${reviewId}.pdf`);
    const resp = await fetch(`/api/management-reviews/${reviewId}/upload-report`, {
      method: 'POST',
      body: form,
    });
    if (!resp.ok) throw new Error('Upload failed: ' + resp.status);

    // Trigger immediate download
    doc.save(`management-review-${reviewId}.pdf`);

    document.getElementById('mgmt-download-report-btn').style.display = '';
    showToast('Report generated and saved to Document Control!', 'success');
  } catch (e) {
    alert('Failed to generate report: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '&#128196; Generate Report';
  }
}

async function downloadMgmtReport(reviewId) {
  try {
    const doc = await generateMgmtReviewPDF(reviewId);
    doc.save(`management-review-${reviewId}.pdf`);
  } catch (e) {
    alert('Failed to download report: ' + e.message);
  }
}
