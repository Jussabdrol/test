
// --- Threat Intelligence Module ---
const tierLabels = { 1: 'Authority', 2: 'Early Warning', 3: 'Context', 4: 'Technical' };
const tierColors = { 1: 'badge-critical', 2: 'badge-high', 3: 'badge-medium', 4: 'badge-low' };
let tiFilters = { tier: '', status: '', feed_id: '' };

async function loadThreatIntelligence() {
  const feeds = await api('/api/threat-feeds');
  const params = new URLSearchParams();
  if (tiFilters.tier) params.set('tier', tiFilters.tier);
  if (tiFilters.status) params.set('status', tiFilters.status);
  if (tiFilters.feed_id) params.set('feed_id', tiFilters.feed_id);
  const items = await api(`/api/threat-items?${params}`);

  // Stats — only count enabled feeds (items list filters by enabled=1)
  const enabledFeeds = feeds.filter(f => f.enabled);
  const totalNew = enabledFeeds.reduce((s, f) => s + Number(f.new_count || 0), 0);
  const totalItems = enabledFeeds.reduce((s, f) => s + Number(f.item_count || 0), 0);
  document.getElementById('ti-stats').innerHTML = `
    <div class="stats-grid" style="margin-bottom:20px">
      <div class="stat-card"><div class="stat-value">${enabledFeeds.length}</div><div class="stat-label">Active Feeds</div></div>
      <div class="stat-card${totalNew > 0 ? ' overdue' : ''}"><div class="stat-value">${totalNew}</div><div class="stat-label">New Threats</div></div>
      <div class="stat-card"><div class="stat-value">${totalItems}</div><div class="stat-label">Total Items</div></div>
      <div class="stat-card"><div class="stat-value">${enabledFeeds.filter(f => f.tier === 1).length}</div><div class="stat-label">Tier 1 Feeds</div></div>
    </div>`;

  // Filters
  document.getElementById('ti-filters-bar').innerHTML = `
    <select onchange="tiFilters.tier=this.value;loadThreatIntelligence()">
      <option value="">All Tiers</option>
      <option value="1" ${tiFilters.tier==='1'?'selected':''}>Tier 1 - Authority</option>
      <option value="2" ${tiFilters.tier==='2'?'selected':''}>Tier 2 - Early Warning</option>
      <option value="3" ${tiFilters.tier==='3'?'selected':''}>Tier 3 - Context</option>
      <option value="4" ${tiFilters.tier==='4'?'selected':''}>Tier 4 - Technical</option>
    </select>
    <select onchange="tiFilters.status=this.value;loadThreatIntelligence()">
      <option value="">All Status</option>
      <option value="new" ${tiFilters.status==='new'?'selected':''}>New</option>
      <option value="reviewed" ${tiFilters.status==='reviewed'?'selected':''}>Reviewed</option>
      <option value="dismissed" ${tiFilters.status==='dismissed'?'selected':''}>Dismissed</option>
      <option value="risk_created" ${tiFilters.status==='risk_created'?'selected':''}>Risk Created</option>
    </select>
    <select onchange="tiFilters.feed_id=this.value;loadThreatIntelligence()">
      <option value="">All Feeds</option>
      ${feeds.map(f => `<option value="${f.id}" ${tiFilters.feed_id==f.id?'selected':''}>${esc(f.name)}</option>`).join('')}
    </select>
    <span style="font-size:13px;color:var(--text-muted)">${items.length} item${items.length!==1?'s':''}</span>`;

  // Group items by tier
  const list = document.getElementById('ti-feed-list');
  if (items.length === 0) {
    list.innerHTML = '<div class="empty-state">No threat items yet. Click "Refresh Feeds" to fetch the latest threat intelligence.</div>';
    return;
  }

  const grouped = {};
  for (const item of items) {
    const tier = item.tier;
    if (!grouped[tier]) grouped[tier] = [];
    grouped[tier].push(item);
  }

  let html = '';
  for (const tier of [1, 2, 3, 4]) {
    const tierItems = grouped[tier];
    if (!tierItems || tierItems.length === 0) continue;
    html += `<div class="ti-tier-group">
      <div class="ti-tier-header">
        <span class="badge ${tierColors[tier]}">Tier ${tier}</span>
        <span class="ti-tier-label">${tierLabels[tier]}</span>
        <span style="font-size:12px;color:var(--text-muted)">${tierItems.length} items</span>
      </div>
      <div class="ti-items">`;
    for (const item of tierItems) {
      const stBadge = item.status === 'new' ? 'badge-high' : item.status === 'reviewed' ? 'badge-medium' : item.status === 'risk_created' ? 'badge-low' : 'badge-inactive';
      const pubDate = item.pub_date ? formatTiDate(item.pub_date) : '';
      html += `<div class="ti-item${item.status === 'dismissed' ? ' ti-dismissed' : ''}">
        <div class="ti-item-main">
          <div class="ti-item-header">
            <span class="badge ${stBadge}">${item.status === 'risk_created' ? 'risk created' : item.status}</span>
            <span class="ti-feed-tag">${esc(item.feed_name)}</span>
            ${pubDate ? `<span class="ti-date">${pubDate}</span>` : ''}
          </div>
          <h4 class="ti-item-title">${item.link ? `<a href="${esc(item.link)}" target="_blank" rel="noopener">${esc(item.title)}</a>` : esc(item.title)}</h4>
          ${item.description ? `<p class="ti-item-desc">${esc(item.description.substring(0, 300))}${item.description.length > 300 ? '...' : ''}</p>` : ''}
        </div>
        <div class="ti-item-actions">
          ${item.status === 'new' ? `<button class="btn btn-secondary btn-sm" onclick="updateTiItem(${item.id},'reviewed')">Mark Reviewed</button>` : ''}
          ${item.status !== 'risk_created' && item.status !== 'dismissed' ? `<button class="btn btn-primary btn-sm" onclick="openTiRiskModal(${item.id})">+ Create Risk</button>` : ''}
          ${item.status !== 'dismissed' && item.status !== 'risk_created' ? `<button class="btn btn-secondary btn-sm" style="font-size:11px" onclick="updateTiItem(${item.id},'dismissed')">Dismiss</button>` : ''}
          ${item.status === 'risk_created' && item.created_risk_id ? `<button class="btn btn-secondary btn-sm" style="font-size:11px" onclick="switchView('risk-identification')">View Risk</button>` : ''}
        </div>
      </div>`;
    }
    html += '</div></div>';
  }
  list.innerHTML = html;
}

function formatTiDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr.substring(0, 16);
    return d.toISOString().split('T')[0];
  } catch(e) { return dateStr.substring(0, 16); }
}

async function refreshAllFeeds() {
  const feeds = await api('/api/threat-feeds');
  const enabled = feeds.filter(f => f.enabled);
  if (enabled.length === 0) { alert('No enabled feeds to refresh.'); return; }

  const statusEl = document.getElementById('ti-stats');
  const origHtml = statusEl.innerHTML;
  statusEl.innerHTML = '<div class="ti-refresh-status">Fetching feeds... <span id="ti-refresh-progress">0</span> / ' + enabled.length + '</div>';

  let done = 0;
  let totalItems = 0;
  let errors = [];

  for (const feed of enabled) {
    try {
      const result = await api(`/api/threat-feeds/${feed.id}/fetch`, { method: 'POST' });
      if (result.success) totalItems += result.count;
      else errors.push(`${feed.name}: ${result.error}`);
    } catch(e) {
      errors.push(`${feed.name}: ${e.message}`);
    }
    done++;
    const prog = document.getElementById('ti-refresh-progress');
    if (prog) prog.textContent = done;
  }

  if (errors.length > 0) {
    alert(`Fetched ${totalItems} items. ${errors.length} feed(s) had errors:\n${errors.join('\n')}`);
  }
  loadThreatIntelligence();
}

async function updateTiItem(id, status) {
  await api(`/api/threat-items/${id}`, { method: 'PUT', body: { status } });
  loadThreatIntelligence();
}

// Manage Feeds Modal
async function openManageFeedsModal() {
  const feeds = await api('/api/threat-feeds');
  const listEl = document.getElementById('ti-feeds-list-manage');
  if (feeds.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No feeds configured.</div>';
  } else {
    listEl.innerHTML = `<div class="ti-manage-feeds">${feeds.map(f => `
      <div class="ti-manage-feed-item">
        <div>
          <strong>${esc(f.name)}</strong>
          <span class="badge ${tierColors[f.tier]}">Tier ${f.tier} - ${tierLabels[f.tier]}</span>
          ${!f.enabled ? '<span class="badge badge-inactive">Disabled</span>' : ''}
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${esc(f.url)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${f.last_fetched ? 'Last fetched: ' + f.last_fetched : 'Never fetched'} &middot; ${f.item_count} items</div>
        </div>
        <div style="display:flex;gap:4px;align-items:center">
          <button class="btn btn-secondary btn-sm" onclick="toggleFeedEnabled(${f.id},${f.enabled ? 0 : 1})">${f.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-secondary btn-sm" style="color:var(--danger)" onclick="deleteFeed(${f.id})">Delete</button>
        </div>
      </div>`).join('')}</div>`;
  }
  document.getElementById('ti-feed-form').reset();
  document.getElementById('ti-feed-id').value = '';
  document.getElementById('ti-feeds-modal').classList.remove('hidden');
}

function closeManageFeedsModal() {
  document.getElementById('ti-feeds-modal').classList.add('hidden');
}

async function saveTiFeed(e) {
  e.preventDefault();
  const id = document.getElementById('ti-feed-id').value;
  const body = {
    name: document.getElementById('ti-feed-name').value,
    url: document.getElementById('ti-feed-url').value,
    tier: parseInt(document.getElementById('ti-feed-tier').value),
  };
  if (id) await api(`/api/threat-feeds/${id}`, { method: 'PUT', body });
  else await api('/api/threat-feeds', { method: 'POST', body });
  openManageFeedsModal(); // refresh list
}

async function toggleFeedEnabled(id, enabled) {
  await api(`/api/threat-feeds/${id}`, { method: 'PUT', body: { enabled } });
  openManageFeedsModal();
}

async function deleteFeed(id) {
  if (!confirm('Delete this feed and all its items?')) return;
  await api(`/api/threat-feeds/${id}`, { method: 'DELETE' });
  openManageFeedsModal();
}

// Create risk from threat item
async function openTiRiskModal(itemId) {
  const [items, riskCategories] = await Promise.all([
    api(`/api/threat-items?limit=1000`),
    getRiskCategoriesFromStandards(),
  ]);
  const item = items.find(i => i.id === itemId);
  if (!item) { alert('Could not find threat item. It may belong to a disabled feed.'); return; }

  // Populate category dropdown
  const catSel = document.getElementById('ti-risk-category');
  catSel.innerHTML = '<option value="">-- Select --</option>' + riskCategories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  // Default to Information Security for TI items (if available)
  const defaultCat = riskCategories.includes('Information Security') ? 'Information Security' : (riskCategories[0] || '');
  catSel.value = defaultCat;

  const form = document.getElementById('ti-risk-form');
  form.reset();
  form.dataset.itemId = itemId;
  document.getElementById('ti-risk-title').value = item.title || '';
  document.getElementById('ti-risk-description').value = (item.description || '') + (item.link ? '\n\nSource: ' + item.link : '');
  document.getElementById('ti-risk-category').value = defaultCat;
  document.getElementById('ti-risk-source').value = (item.feed_name || '') + ' (Tier ' + (item.tier || '?') + ')';
  document.getElementById('ti-risk-threat').value = item.title || '';
  document.getElementById('ti-risk-modal').classList.remove('hidden');
}

function closeTiRiskModal() {
  document.getElementById('ti-risk-modal').classList.add('hidden');
}

async function saveTiRisk(e) {
  e.preventDefault();
  const itemId = document.getElementById('ti-risk-form').dataset.itemId;
  const title = document.getElementById('ti-risk-title').value.trim();
  if (!title) { alert('Risk title is required.'); return; }
  const body = {
    title,
    description: document.getElementById('ti-risk-description').value,
    category: document.getElementById('ti-risk-category').value,
    source: document.getElementById('ti-risk-source').value,
    threat: document.getElementById('ti-risk-threat').value,
    vulnerability: document.getElementById('ti-risk-vulnerability').value,
    likelihood: parseInt(document.getElementById('ti-risk-likelihood').value) || 3,
    impact: parseInt(document.getElementById('ti-risk-impact').value) || 3,
  };
  const risk = await api('/api/risks', { method: 'POST', body });
  if (!risk || risk.error || !risk.id) {
    alert('Failed to create risk: ' + (risk.error || 'Unknown error'));
    return;
  }
  // Update threat item to mark as risk_created
  if (itemId) {
    await api(`/api/threat-items/${itemId}`, { method: 'PUT', body: { status: 'risk_created', created_risk_id: risk.id } });
  }
  closeTiRiskModal();
  loadThreatIntelligence();
}
