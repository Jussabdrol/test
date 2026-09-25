
// --- Organizational Planning: Mission Control ---
async function loadMissionControl() {
  if (document.getElementById('mission-tab-sphere')?.getAttribute('aria-selected') === 'true') return loadSphere();
  await renderAttentionOverview();
  const mission = await api('/api/mission');
  const missionSection = document.getElementById('mission-section');

  let entities = [];
  try { entities = JSON.parse(mission.legal_entities || '[]'); } catch (e) {}

  const entitiesDisplayHtml = entities.length > 0
    ? `<div class="mission-entities-list">${entities.map(e =>
        `<div class="mission-entity-row"><span class="mission-entity-name">${esc(e.name)}</span><span class="mission-entity-country">${esc(e.country)}</span></div>`
      ).join('')}</div>`
    : '<span style="color:var(--text-muted);font-style:italic">No legal entities defined yet.</span>';

  const entitiesEditRows = entities.length > 0
    ? entities.map((e, i) =>
        `<div class="mission-entity-edit-row" data-idx="${i}">
          <input type="text" class="le-name" value="${esc(e.name)}" placeholder="Entity name">
          <input type="text" class="le-country" value="${esc(e.country)}" placeholder="Country">
          <button type="button" class="btn btn-secondary btn-sm" onclick="this.closest('.mission-entity-edit-row').remove()" title="Remove">&times;</button>
        </div>`
      ).join('')
    : '';

  missionSection.innerHTML = `
    <div class="mission-card">
      <div class="mission-card-header">
        <h3>${mission.org_name ? esc(mission.org_name) : 'Organization Mission'}</h3>
        <button class="btn btn-secondary btn-sm" onclick="toggleMissionEdit()">Edit</button>
      </div>
      <div id="mission-display">
        <div class="mission-block-grid">
          <div class="mission-block">
            <h4>Mission</h4>
            <p>${mission.content ? esc(mission.content) : '<span style="color:var(--text-muted);font-style:italic">No mission statement defined yet.</span>'}</p>
          </div>
          <div class="mission-block">
            <h4>Vision</h4>
            <p>${mission.vision ? esc(mission.vision) : '<span style="color:var(--text-muted);font-style:italic">No vision defined yet.</span>'}</p>
          </div>
        </div>
        <div class="mission-block">
          <h4>Values</h4>
          <p>${mission.values_text ? esc(mission.values_text) : '<span style="color:var(--text-muted);font-style:italic">No values defined yet.</span>'}</p>
        </div>
        <div class="mission-block">
          <h4>Legal Entities</h4>
          ${entitiesDisplayHtml}
        </div>
      </div>
      <div id="mission-edit" class="hidden">
        <div class="form-group">
          <label>Mission Statement</label>
          <textarea id="mission-content" rows="3" placeholder="What is your organization's mission?">${esc(mission.content || '')}</textarea>
        </div>
        <div class="form-group">
          <label>Vision</label>
          <textarea id="mission-vision" rows="3" placeholder="What is your organization's vision?">${esc(mission.vision || '')}</textarea>
        </div>
        <div class="form-group">
          <label>Values</label>
          <textarea id="mission-values" rows="3" placeholder="What are your organization's core values?">${esc(mission.values_text || '')}</textarea>
        </div>
        <div class="form-group">
          <label>Legal Entities</label>
          <div id="legal-entities-edit">
            ${entitiesEditRows}
          </div>
          <button type="button" class="btn btn-secondary btn-sm" style="margin-top:8px" onclick="addLegalEntityRow()">+ Add Entity</button>
        </div>
        <div class="form-actions">
          <button class="btn btn-secondary" onclick="toggleMissionEdit()">Cancel</button>
          <button class="btn btn-primary" onclick="saveMission()">Save</button>
        </div>
      </div>
    </div>`;

  // Auto KPIs
  let modulePermissions=[];
  try { modulePermissions=JSON.parse(currentUser?.permissions || '[]'); } catch {}
  const canReadAllMetrics=isSuperadmin||['admin','org_admin'].includes(currentUser?.role)||['org','ops','risk','audit'].every(module=>modulePermissions.includes(module));
  if(canReadAllMetrics){
    const d=await api('/api/kpis/auto');
    renderMissionExperience(d);
  }else{
    document.getElementById('experience-mission-metrics').replaceChildren();
    document.getElementById('organization-kpi-grid').replaceChildren();
    document.getElementById('auto-kpi-grid').innerHTML='<p class="empty-state">Cross-module metrics require access to all modules.</p>';
  }

  // Process KPIs (grouped by process)
  const kpis = await api('/api/kpis');
  const processKpiList = document.getElementById('custom-kpi-list');
  const processKpis = kpis.filter(k => k.process_id);

  if (processKpis.length === 0) {
    processKpiList.innerHTML = '<div class="empty-state" style="padding:20px">No process KPIs defined yet. Open a process in Architecture and add KPIs from there.</div>';
    return;
  }

  // Group by process
  const byProcess = {};
  for (const k of processKpis) {
    const pid = k.process_id;
    if (!byProcess[pid]) byProcess[pid] = { name: k.process_name || `Process ${pid}`, id: pid, kpis: [] };
    byProcess[pid].kpis.push(k);
  }

  processKpiList.innerHTML = Object.values(byProcess).map(proc => {
    const cards = proc.kpis.map(k => {
      const vals = k.values || [];
      const latestEntry = vals.length > 0 ? vals[0] : null;
      const latest = latestEntry ? latestEntry.value : null;
      const prev = vals.length > 1 ? vals[1].value : null;
      const trend = (latest !== null && prev !== null) ? latest - prev : null;
      const trendHtml = trend !== null ? `<span class="kpi-trend ${trend > 0 ? 'up' : trend < 0 ? 'down' : 'flat'}">${trend > 0 ? '+' : ''}${Number(trend.toFixed(2))}${k.unit || ''}</span>` : '';
      const targetHtml = k.target_value !== null ? `<div style="font-size:12px;color:var(--text-muted)">Target: ${k.target_value}${k.unit || ''}</div>` : '';
      const sparkVals = vals.slice(0, 8).reverse();
      const maxV = sparkVals.length > 0 ? Math.max(...sparkVals.map(v => v.value), 1) : 1;
      const sparkHtml = sparkVals.length > 0 ? `<div class="kpi-spark">${sparkVals.map(v => {
        const h = Math.max(4, (v.value / maxV) * 28);
        return `<div class="kpi-spark-bar" style="height:${h}px" title="${esc(v.period)}: ${v.value}${k.unit || ''}"></div>`;
      }).join('')}</div>` : '';
      return `<div class="kpi-card-custom">
        <div class="kpi-card-custom-header">
          <div>
            <div class="kpi-header" style="color:var(--primary)">${esc(k.name)}</div>
            ${k.description ? `<div style="font-size:12px;color:var(--text-muted)">${esc(k.description)}</div>` : ''}
            <div style="font-size:10px;color:var(--text-muted);margin-top:2px">${k.frequency || 'monthly'}</div>
          </div>
        </div>
        <div style="display:flex;align-items:flex-end;gap:16px;margin-top:6px">
          <div>
            <div class="kpi-value">${latest !== null ? latest + (k.unit || '') : 'N/A'}</div>
            ${targetHtml}
            <div style="display:flex;gap:6px;align-items:center;margin-top:2px">${trendHtml}${latestEntry ? `<span style="font-size:10px;color:var(--text-muted)">${esc(latestEntry.period)}</span>` : ''}</div>
          </div>
          ${sparkHtml}
        </div>
      </div>`;
    }).join('');

    return `<div class="proc-mc-group">
      <div class="proc-mc-group-header">
        <span class="proc-mc-group-name">&#9881; ${esc(proc.name)}</span>
        <button class="btn btn-secondary btn-sm" onclick="switchView('architecture');setTimeout(()=>switchArchTab('process'),100)" style="font-size:11px">Open in Architecture &#8599;</button>
      </div>
      <div class="proc-mc-cards">${cards}</div>
    </div>`;
  }).join('');
}

function toggleMissionEdit() {
  document.getElementById('mission-display').classList.toggle('hidden');
  document.getElementById('mission-edit').classList.toggle('hidden');
}

function addLegalEntityRow() {
  const container = document.getElementById('legal-entities-edit');
  const row = document.createElement('div');
  row.className = 'mission-entity-edit-row';
  row.innerHTML = `
    <input type="text" class="le-name" placeholder="Entity name">
    <input type="text" class="le-country" placeholder="Country">
    <button type="button" class="btn btn-secondary btn-sm" onclick="this.closest('.mission-entity-edit-row').remove()" title="Remove">&times;</button>`;
  container.appendChild(row);
}

async function saveMission() {
  const entityRows = document.querySelectorAll('#legal-entities-edit .mission-entity-edit-row');
  const legal_entities = [];
  entityRows.forEach(row => {
    const name = row.querySelector('.le-name').value.trim();
    const country = row.querySelector('.le-country').value.trim();
    if (name) legal_entities.push({ name, country });
  });
  await api('/api/mission', { method: 'PUT', body: {
    content: document.getElementById('mission-content').value,
    vision: document.getElementById('mission-vision').value,
    values_text: document.getElementById('mission-values').value,
    legal_entities,
  }});
  loadMissionControl();
}

async function openKpiModal(id) {
  document.getElementById('kpi-form').reset();
  document.getElementById('kpi-id').value = '';
  document.getElementById('kpi-modal-title').textContent = 'New KPI';
  if (id) {
    const kpis = await api('/api/kpis');
    const k = kpis.find(x => x.id === id);
    if (k) {
      document.getElementById('kpi-modal-title').textContent = 'Edit KPI';
      document.getElementById('kpi-id').value = k.id;
      document.getElementById('kpi-name').value = k.name;
      document.getElementById('kpi-description').value = k.description;
      document.getElementById('kpi-target').value = k.target_value ?? '';
      document.getElementById('kpi-unit').value = k.unit;
      document.getElementById('kpi-frequency').value = k.frequency;
    }
  }
  document.getElementById('kpi-modal').classList.remove('hidden');
}
function closeKpiModal() { document.getElementById('kpi-modal').classList.add('hidden'); }

async function saveKpi(e) {
  e.preventDefault();
  const id = document.getElementById('kpi-id').value;
  const body = {
    name: document.getElementById('kpi-name').value,
    description: document.getElementById('kpi-description').value,
    target_value: document.getElementById('kpi-target').value ? parseFloat(document.getElementById('kpi-target').value) : null,
    unit: document.getElementById('kpi-unit').value,
    frequency: document.getElementById('kpi-frequency').value,
  };
  if (id) await api(`/api/kpis/${id}`, { method: 'PUT', body });
  else await api('/api/kpis', { method: 'POST', body });
  closeKpiModal();
  loadMissionControl();
}

async function deleteKpi(id) {
  if (!confirm('Delete this KPI and all its values?')) return;
  await api(`/api/kpis/${id}`, { method: 'DELETE' });
  loadMissionControl();
}

function openKpiValueModal(kpiId) {
  document.getElementById('kpi-value-form').reset();
  document.getElementById('kpi-value-kpi-id').value = kpiId;
  document.getElementById('kpi-value-period').value = new Date().toISOString().slice(0, 7);
  document.getElementById('kpi-value-modal').classList.remove('hidden');
}
function closeKpiValueModal() { document.getElementById('kpi-value-modal').classList.add('hidden'); }

async function saveKpiValue(e) {
  e.preventDefault();
  const kpiId = document.getElementById('kpi-value-kpi-id').value;
  await api(`/api/kpis/${kpiId}/values`, { method: 'POST', body: {
    value: parseFloat(document.getElementById('kpi-value-val').value),
    period: document.getElementById('kpi-value-period').value,
  }});
  closeKpiValueModal();
  loadMissionControl();
}
