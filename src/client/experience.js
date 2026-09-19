// Presentation layer only. Existing APIs, forms, permissions and mutations remain authoritative.
const experienceRequests = { risk: 0, document: 0 };
const experienceFocus = { risk: null, document: null };

function experienceIcon(name) {
  const paths = {
    overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    tasks: '<path d="m3 6 2 2 4-4M12 6h9M3 13l2 2 4-4M12 13h9M12 20h9"/>',
    'ai-agent': '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
    'org-planning': '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h1m4 0h1M9 11h1m4 0h1M10 21v-6h4v6"/>',
    'risk-management': '<path d="m12 3 9 4v6c0 4-5 7-9 9-4-2-9-5-9-9V7Z M12 8v5m0 3h.01"/>',
    'operational-planning': '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2"/>',
    audits: '<path d="M8 4H5v17h14V4h-3M9 2h6v4H9zM8 12l2 2 6-6M8 18h8"/>',
    admin: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  };
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.overview}</svg>`;
}

function initializeExperience() {
  document.querySelectorAll('[data-experience-icon]').forEach(el => { el.innerHTML = experienceIcon(el.dataset.experienceIcon); });
  document.querySelectorAll('.module-toggle').forEach(toggle => {
    const icon = toggle.querySelector('.module-icon');
    if (icon) icon.innerHTML = experienceIcon(toggle.dataset.module);
    if (!toggle.dataset.view) toggle.setAttribute('aria-expanded', String(toggle.nextElementSibling?.classList.contains('open')));
    toggle.addEventListener('click', () => {
      if (!toggle.dataset.view) toggle.setAttribute('aria-expanded', String(toggle.nextElementSibling?.classList.contains('open')));
    });
  });
  document.addEventListener('keydown', event => {
    const tab = event.target.closest('[data-experience-tabs] [role="tab"]');
    if (tab && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
      const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')];
      const offset = event.key === 'ArrowLeft' ? -1 : 1;
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(tab) + offset + tabs.length) % tabs.length;
      event.preventDefault(); tabs[index].click(); tabs[index].focus();
    }
    if (event.key === 'Escape' && !event.target.closest('.modal,dialog')) {
      for (const type of ['risk','document']) {
        const panel = document.getElementById(`${type}-dossier`);
        if (panel && !panel.hidden && !panel.closest('.view')?.classList.contains('hidden')) closeExperienceDossier(type);
      }
    }
  });
  updateExperienceChrome();
}

function updateExperienceChrome() {
  const heading = document.querySelector(`#view-${currentView} .view-header h2`);
  const page = document.getElementById('experience-page');
  if (page) page.textContent = heading?.textContent || 'Workspace';
  if (activeOrg?.name) {
    for (const id of ['experience-org','experience-context']) {
      const el = document.getElementById(id); if (el) el.textContent = activeOrg.name;
    }
  }
  document.querySelectorAll('[data-shortcut]').forEach(button => {
    button.hidden = !hasPermissionForView(button.dataset.shortcut);
    if (button.dataset.shortcut === currentView) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('.nav-link').forEach(link => {
    if (link.dataset.view === currentView) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function selectExperienceTab(group, name) {
  document.querySelectorAll(`[data-experience-tabs="${group}"] [role="tab"]`).forEach(button => {
    const selected = button.id === `${group}-tab-${name}`;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    if (panel) panel.hidden = !selected;
  });
}

function experienceStatus(status) {
  const labels = { review:'Under Review', in_progress:'In progress' };
  return labels[status] || String(status || 'Not set').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

function renderMissionExperience(d) {
  const metric = (label, value, note) => `<div class="experience-metric"><span>${esc(label)}</span><strong>${esc(value ?? '—')}</strong><small>${esc(note)}</small></div>`;
  const metrics = [];
  if (hasPermissionForView('tasks')) metrics.push(metric('Overdue tasks', d.tasks_overdue, 'Active series past their due date'));
  if (hasPermissionForView('risk-identification')) metrics.push(metric('High / critical risks', d.high_risks, `of ${d.total_risks} risks · inherent score`));
  if (hasPermissionForView('audit-ncrs')) metrics.push(metric('Open non-conformities', d.open_ncrs, 'Open or in progress'));
  if (hasPermissionForView('document-control')) metrics.push(metric('Documents due review', d.docs_due_review, `of ${d.total_documents} documents · due today or earlier`));
  document.getElementById('experience-mission-metrics').innerHTML = metrics.join('');
  const row = (label, value) => `<div class="experience-stat-row"><span>${esc(label)}</span><strong>${esc(value ?? '—')}</strong></div>`;
  const block = (title, view, rows) => hasPermissionForView(view) ? `<section class="experience-summary"><h3><button type="button" class="experience-text-button" onclick="switchView('${view}')">${esc(title)} <span aria-hidden="true">↗</span></button></h3>${rows.map(([label,value]) => row(label,value)).join('')}</section>` : '';
  document.getElementById('auto-kpi-grid').innerHTML = [
    block('Task Management', 'tasks', [['Active tasks',d.tasks_active],['Overdue',d.tasks_overdue],['Completed this month',d.completions_this_month]]),
    block('Audits & Compliance', 'audit-plan', [['Planned / completed audits',`${d.audits_planned} / ${d.audits_completed}`],['Open non-conformities',d.open_ncrs],['Open follow-ups',d.open_actions],['Standards',d.standards_count]]),
    block('Risk & controls', 'risk-identification', [['Total / high or critical risks',`${d.total_risks} / ${d.high_risks}`],['Open treatments',d.open_treatments],['SoA implemented / applicable',`${d.soa_implemented} / ${d.soa_applicable}`],['New threat items',d.threat_items_new]]),
    block('Document Control', 'document-control', [['Documents',d.total_documents],['Due review',d.docs_due_review]]),
  ].join('');
  document.getElementById('organization-kpi-grid').innerHTML = [
    block('Architecture', 'architecture', [['Processes / roles',`${d.arch_processes} / ${d.arch_roles}`],['Systems / facilities',`${d.arch_systems} / ${d.arch_facilities}`]]),
    block('AI Use Cases', 'use-cases', [['Total / active',`${d.usecases_total} / ${d.usecases_active}`],['Proposed / draft / deprecated',`${d.usecases_proposed} / ${d.usecases_draft} / ${d.usecases_deprecated}`]]),
  ].join('');
}

function experienceFields(fields) {
  return `<dl class="experience-fields">${fields.map(([label,value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value || '—')}</dd></div>`).join('')}</dl>`;
}

function experienceLinkedItems(links, type, id) {
  const rows = links.filter(link => Object.hasOwn(relationshipViews,link.type) && Number.isSafeInteger(Number(link.id))).map(link =>
    `<div class="experience-linked-row"><span>${esc(linkableTypes[link.type]?.label || link.type)}</span><button type="button" class="experience-text-button" onclick="openRelatedRecord('${link.type}',${Number(link.id)})">${esc(link.name || link.title || `#${link.id}`)}</button></div>`);
  return `<div>${rows.join('') || '<p class="empty-state">No linked items yet.</p>'}</div><button type="button" class="btn btn-secondary btn-sm" onclick="inspectRelationships('${type}',${id})">Manage linked items</button>`;
}

function closeExperienceDossier(type, restoreFocus = true) {
  experienceRequests[type]++;
  const panel = document.getElementById(`${type}-dossier`);
  if (panel) { panel.hidden = true; panel.innerHTML = ''; }
  if (restoreFocus && experienceFocus[type]?.isConnected) experienceFocus[type].focus();
}

async function openRiskDossier(id) {
  id = Number(id);
  if (!Number.isSafeInteger(id) || id < 1 || !hasPermissionForView('risk-identification')) return;
  const panel = document.getElementById('risk-dossier');
  const request = ++experienceRequests.risk;
  experienceFocus.risk = document.activeElement;
  panel.hidden = false;
  panel.innerHTML = '<p role="status">Loading risk dossier…</p>';
  try {
    const [risk, links] = await Promise.all([api(`/api/risks/${id}`), api(`/api/cross-links/risk/${id}`)]);
    if (request !== experienceRequests.risk) return;
    if (risk.error) throw Error(risk.error);
    const score = risk.inherent_score;
    panel.innerHTML = `<header class="experience-dossier-heading"><div><p class="experience-eyebrow">Risk dossier / #${id}</p><h3>${esc(risk.title)}</h3><span class="badge risk-score-badge ${riskScoreClass(score)}">${riskScoreLabel(score)} inherent risk · ${esc(score)}</span> <span class="badge experience-neutral">${esc(experienceStatus(risk.status))}</span></div><button type="button" class="btn btn-secondary btn-sm" onclick="closeExperienceDossier('risk')" aria-label="Close risk dossier">Close</button></header>
      <div class="experience-tabs" role="tablist" aria-label="Risk dossier sections" data-experience-tabs="risk">
        <button type="button" id="risk-tab-assessment" role="tab" aria-selected="true" aria-controls="risk-panel-assessment" onclick="selectExperienceTab('risk','assessment')">Assessment</button>
        <button type="button" id="risk-tab-treatments" role="tab" aria-selected="false" tabindex="-1" aria-controls="risk-panel-treatments" onclick="selectExperienceTab('risk','treatments')">Treatments (${(risk.treatments || []).length})</button>
        <button type="button" id="risk-tab-links" role="tab" aria-selected="false" tabindex="-1" aria-controls="risk-panel-links" onclick="selectExperienceTab('risk','links')">Linked items (${links.length})</button>
      </div>
      <div id="risk-panel-assessment" role="tabpanel" aria-labelledby="risk-tab-assessment">${experienceFields([
        ['Description',risk.description],['Risk owner',risk.risk_owner],['Category',risk.category],['Asset',risk.asset],['Likelihood × impact',`${risk.likelihood} × ${risk.impact} = ${score}`],['Status',experienceStatus(risk.status)],['Source',risk.source],['Threat',risk.threat],['Vulnerability',risk.vulnerability],
        ['Process',links.filter(l=>l.type==='process').map(l=>l.name).join(', ')],['Facility',links.filter(l=>l.type==='facility').map(l=>l.name).join(', ')],
      ])}<button type="button" class="btn btn-secondary" onclick="closeExperienceDossier('risk',false);openRiskModal(${id})">Edit risk</button></div>
      <div id="risk-panel-treatments" role="tabpanel" aria-labelledby="risk-tab-treatments" hidden>${(risk.treatments || []).map(t => `<div class="experience-treatment"><div><button type="button" class="experience-text-button" onclick="closeExperienceDossier('risk',false);openTreatmentModal(${Number(t.id)})">${esc(t.description)}</button><p>${esc(t.responsible || 'Unassigned')} · ${esc(t.due_date || 'No due date')}${t.clause ? ' · '+esc(t.clause) : ''}</p></div><span class="badge experience-neutral">${esc(experienceStatus(t.status))}</span></div>`).join('') || '<p class="empty-state">No treatments linked to this risk.</p>'}<button type="button" class="btn btn-primary" onclick="closeExperienceDossier('risk',false);openTreatmentModalForRisk(${id})">Add treatment</button></div>
      <div id="risk-panel-links" role="tabpanel" aria-labelledby="risk-tab-links" hidden>${experienceLinkedItems(links,'risk',id)}</div>`;
    panel.querySelector('#risk-tab-assessment').focus({preventScroll:true});
    panel.scrollIntoView({block:'nearest'});
  } catch (error) {
    if (request !== experienceRequests.risk) return;
    panel.innerHTML = `<p role="alert">Could not load risk: ${esc(error.message)}</p><button type="button" class="btn btn-secondary" onclick="openRiskDossier(${id})">Retry</button><button type="button" class="btn btn-secondary" onclick="closeExperienceDossier('risk')">Close</button>`;
  }
}

async function openDocumentDossier(id) {
  id = Number(id);
  if (!Number.isSafeInteger(id) || id < 1 || !hasPermissionForView('document-control')) return;
  const panel = document.getElementById('document-dossier');
  const request = ++experienceRequests.document;
  experienceFocus.document = document.activeElement;
  panel.hidden = false; panel.innerHTML = '<p role="status">Loading document…</p>';
  try {
    const [documents, links] = await Promise.all([api('/api/documents'), api(`/api/cross-links/document/${id}`)]);
    const doc = documents.find(item => Number(item.id) === id);
    if (request !== experienceRequests.document) return;
    if (!doc) throw Error('Document not found.');
    if (doc.error) throw Error(doc.error);
    const overdue = doc.review_date && doc.review_date.slice(0,10) < new Date().toISOString().slice(0,10);
    panel.innerHTML = `<header class="experience-dossier-heading"><div><p class="experience-eyebrow">Document / #${id}</p><h3>${esc(doc.title)}</h3><span class="badge ${doc.status === 'approved' ? 'experience-approved' : 'experience-neutral'}">${esc(experienceStatus(doc.status))}</span> <span class="badge experience-neutral">Version ${esc(doc.version || '—')}</span>${overdue ? ' <span class="badge experience-overdue">Review overdue</span>' : ''}</div><button type="button" class="btn btn-secondary btn-sm" onclick="closeExperienceDossier('document')" aria-label="Close document dossier">Close</button></header>
      ${experienceFields([['Description',doc.description],['Owner',doc.owner],['Classification',experienceStatus(doc.classification)],['Review date',doc.review_date?.slice(0,10)],['Document type',experienceStatus(doc.doc_type)],['File',doc.file_name]])}
      <div class="experience-dossier-actions"><button type="button" class="btn btn-secondary" onclick="closeExperienceDossier('document',false);openDocModal(${id})">Edit metadata</button>${doc.file_name ? `<button type="button" class="btn btn-secondary" onclick="downloadDoc(${id})">Download</button>` : ''}</div>
      <h4 class="experience-linked-heading">Linked items</h4>${experienceLinkedItems(links,'document',id)}
      ${overdue ? '<p class="experience-subtitle">The recorded approval status and the overdue review date are separate signals.</p>' : ''}`;
    panel.querySelector('button').focus({preventScroll:true}); panel.scrollIntoView({block:'nearest'});
  } catch (error) {
    if (request !== experienceRequests.document) return;
    panel.innerHTML = `<p role="alert">Could not load document: ${esc(error.message)}</p><button type="button" class="btn btn-secondary" onclick="openDocumentDossier(${id})">Retry</button><button type="button" class="btn btn-secondary" onclick="closeExperienceDossier('document')">Close</button>`;
  }
}
