/* Shared relationships for the current production modules. */
Object.assign(linkableTypes, {
  supplier: { label: 'Supplier', icon: '&#128230;' },
  kpi: { label: 'KPI', icon: '&#128200;' },
  management_review: { label: 'Management review', icon: '&#128203;' },
  review_output: { label: 'Review decision', icon: '&#9745;' },
  threat: { label: 'Threat', icon: '&#9888;' },
  instance: { label: 'Task execution', icon: '&#9745;' },
  plan_bundle: { label: 'Process group', icon: '&#128194;' },
});
// Include all supported types consistently. Server validation checks both records.
for (const value of Object.values(linkableTypes)) value.canLink = Object.keys(linkableTypes);

const relationshipViews = {
  risk:'risk-identification', task:'tasks', instance:'task-log', action:'actions',
  audit:'audit-plan', checklist:'audit-execute', requirement:'audit-requirements',
  ncr:'audit-ncrs', treatment:'risk-treatment', document:'document-control',
  kpi:'mission-control', management_review:'management-reviews', review_output:'management-reviews',
  threat:'threat-intelligence', supplier:'architecture', plan_bundle:'tasks',
  usecase:'use-cases', ai_usecase:'use-cases', role:'architecture', process:'architecture',
  system:'architecture', asset:'architecture', facility:'architecture', ai_model:'architecture', ai_dataset:'architecture',
};

async function openRelatedRecord(type, id) {
  const view = relationshipViews[type];
  if (!view || !hasPermissionForView(view)) return showToast('You do not have access to this module.', 'error');
  try {
    const dialog = document.getElementById('relationship-inspector');
    if (dialog?.open) dialog.close();
    if (['role','process','system','asset','facility','ai_model','ai_dataset','supplier'].includes(type)) currentArchTab=type;
    await switchView(view);
    const opener = {
      risk:openRiskDossier, task:openTaskDetailModal, instance:openControlTicket, action:openActionModal, audit:openAuditModal,
      ncr:openNcrModal, treatment:openTreatmentModal, requirement:openRequirementModal,
      document:openDocumentDossier, supplier:openSupplierModal, kpi:openKpiModal,
      management_review:openMgmtReviewModal, usecase:openUseCaseModal, ai_usecase:openUseCaseModal,
      role:openArchModal, process:openArchModal, system:openArchModal, asset:openArchModal,
      facility:openArchModal, ai_model:openArchModal, ai_dataset:openArchModal, plan_bundle:openBundleModal,
    }[type];
    if (opener) await opener(Number(id));
    else await inspectRelationships(type,Number(id));
  } catch (error) { showToast('Could not open linked record: '+error.message,'error'); }
}

async function inspectRelationships(type,id) {
  let dialog=document.getElementById('relationship-inspector');
  if(!dialog){dialog=document.createElement('dialog');dialog.id='relationship-inspector';document.body.appendChild(dialog);}
  dialog.innerHTML=`<header><h2 id="relationship-title">${esc(linkableTypes[type]?.label||type)} #${id}</h2><button type="button" aria-label="Close relationships" onclick="this.closest('dialog').close()">×</button></header><div id="relationship-inspector-content" aria-live="polite">Loading relationships…</div>`;
  dialog.setAttribute('aria-labelledby','relationship-title');
  dialog.showModal();
  const record=await api(`/api/linked-record/${type}/${id}`);
  dialog.querySelector('h2').textContent=record.name || `${linkableTypes[type]?.label||type} #${id}`;
  await renderCrossLinks(type,id,'relationship-inspector-content');
}

let returnToRelationshipDialog=false;
const baseOpenRelationshipPicker=openCrossLinkPicker;
openCrossLinkPicker=async function(...args){
  const dialog=document.getElementById('relationship-inspector');
  if(dialog?.open){returnToRelationshipDialog=true;dialog.close();}
  return baseOpenRelationshipPicker(...args);
};
const baseCloseRelationshipPicker=closeCrossLinkPicker;
closeCrossLinkPicker=function(){
  baseCloseRelationshipPicker();
  if(returnToRelationshipDialog){returnToRelationshipDialog=false;document.getElementById('relationship-inspector')?.showModal();}
};

// Add the same relationship panel to existing detail/edit forms. New unsaved
// records cannot be linked yet; clear any panel left from a previous record.
function addRelationshipPanel(open,type,modalId) {
  return async function(id,...args) {
    const modal=document.getElementById(modalId);
    modal?.querySelector('[data-relationships]')?.remove();
    await open(id,...args);
    if(!id||!modal)return;
    const content=modal.querySelector('.modal-content');
    if(!content)return;
    const panel=document.createElement('section');
    panel.dataset.relationships='true';panel.id=modalId+'-relationships';
    content.appendChild(panel);
    const resolvedType=typeof type==='function'?type():type;
    try {await renderCrossLinks(resolvedType,Number(id),panel.id);}
    catch(error){panel.textContent='Relationships could not be loaded: '+error.message;}
  };
}
openActionModal=addRelationshipPanel(openActionModal,'action','action-modal');
openKpiModal=addRelationshipPanel(openKpiModal,'kpi','kpi-modal');
openSupplierModal=addRelationshipPanel(openSupplierModal,'supplier','supplier-modal');
openMgmtReviewModal=addRelationshipPanel(openMgmtReviewModal,'management_review','mgmt-review-modal');
openArchModal=addRelationshipPanel(openArchModal,()=>currentArchTab,'arch-modal');
openDocModal=addRelationshipPanel(openDocModal,'document','doc-modal');
openBundleModal=addRelationshipPanel(openBundleModal,'plan_bundle','bundle-modal');

let attentionData=null;
async function renderAttentionOverview() {
  let section=document.getElementById('attention-overview');
  if(!section){section=document.createElement('section');section.id='attention-overview';document.getElementById('mission-panel-overview').appendChild(section);}
  section.innerHTML='<p role="status">Loading work that needs attention…</p>';
  try {
    attentionData=await api('/api/compliance-overview');
    section.innerHTML=`<div class="attention-heading"><div><p class="attention-eyebrow">YOUR NEXT STEPS</p><h3>Work that needs attention</h3><p>Overdue work, high risks and threats awaiting review.</p></div><span class="attention-count">${attentionData.attention_total}</span></div><div class="attention-filters"><label>Search<input id="attention-search" type="search" placeholder="Title or owner" oninput="filterAttention()"></label><label>Module<select id="attention-module" onchange="filterAttention()"><option value="">All modules</option>${attentionData.modules.filter(m=>m.attention>0).map(m=>`<option value="${m.type}">${esc(m.label)} (${m.attention})</option>`).join('')}</select></label></div><div id="attention-results" aria-live="polite"></div>`;
    filterAttention();
  } catch(error){section.innerHTML=`<p role="alert">Could not load attention overview: ${esc(error.message)}</p><button type="button" class="btn btn-secondary" onclick="renderAttentionOverview()">Retry</button>`;}
}
function filterAttention(){
  const search=document.getElementById('attention-search').value.trim().toLowerCase();
  const type=document.getElementById('attention-module').value;
  const rows=attentionData.attention.filter(r=>(!type||r.type===type)&&(!search||`${r.title} ${r.owner}`.toLowerCase().includes(search)));
  const count=document.querySelector('.attention-count');
  if(count) { count.textContent=rows.length+' shown'; count.title=attentionData.attention_total+' total items need attention'; }
  document.getElementById('attention-results').innerHTML=rows.length
    ? `<ul class="attention-list">${rows.map(r=>`<li><button type="button" onclick="openRelatedRecord('${r.type}',${r.id})"><span><strong>${esc(r.title)}</strong><small>${esc(r.label)}${r.owner?' · '+esc(r.owner):''}</small></span><span class="attention-reason">${esc(r.reason)}${r.due_date?'<small>'+esc(String(r.due_date).slice(0,10))+'</small>':''}</span><span aria-hidden="true">→</span></button></li>`).join('')}</ul><p class="attention-note">Showing ${rows.length} items. Up to ${attentionData.per_module_limit} per module.</p>`
    : '<p class="attention-empty">'+(search||type?'No items match these filters.':'No items currently need attention.')+'</p>';
}
