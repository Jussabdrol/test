// --- State ---
let currentView = 'mission-control';
let allTasks = [];
let meta = { assignees: [], categories: [] };
let filters = { active: 'true', assignee: '', category: '', priority: '' };
let actionFilters = { status: 'open' };
let yearlyYear = new Date().getFullYear();
let lastCompletionContext = null; // { completion_id, task_id }
let yearlyData = null; // cached yearly API data
let currentUser = null;
let isSuperadmin = false;
let activeOrg = null; // { id, name, slug } when superadmin is inside an org

// --- Authentication ---
async function loadCurrentUser() {
  try {
    const res = await fetch('/api/auth/check');
    const data = await res.json();
    if (data.authenticated && data.user) {
      currentUser = data.user;
      isSuperadmin = data.isSuperadmin || false;
      activeOrg = data.activeOrg || null;
      const nameEl = document.getElementById('current-user-name');
      if (nameEl) nameEl.textContent = data.user.name;

      // Show MSP portal for superadmins without active org context
      if (isSuperadmin && !activeOrg) {
        showMSPDashboard();
        return true; // signals: MSP portal shown, skip normal dashboard load
      }

      // Show org banner for superadmins inside an org
      renderOrgBanner();

      // Apply module permissions to sidebar (superadmins see everything)
      if (!isSuperadmin) {
        applyModulePermissions();
      }
    }
  } catch (err) {
    console.error('Failed to load user info:', err);
  }
  return false;
}

// Maps permission keys to sidebar data-module attribute values
const PERM_TO_MODULE = {
  org: 'org-planning',
  risk: 'risk-management',
  ops: 'operational-planning',
  audit: 'audits',
  admin: 'admin',
};

function applyModulePermissions() {
  let perms = [];
  try { perms = JSON.parse(currentUser.permissions || '[]'); } catch (e) {}

  // Admin role always gets admin module access
  if (currentUser.role === 'admin' && !perms.includes('admin')) {
    perms.push('admin');
  }

  const allowedModules = new Set(perms.map(p => PERM_TO_MODULE[p]).filter(Boolean));

  document.querySelectorAll('.nav-module').forEach(moduleEl => {
    const toggle = moduleEl.querySelector('.module-toggle');
    if (!toggle) return;
    const moduleId = toggle.dataset.module;
    if (!allowedModules.has(moduleId)) {
      moduleEl.style.display = 'none';
    }
  });

  // If the current default view (mission-control) is not accessible,
  // navigate to the first available view
  const currentDefault = 'mission-control';
  const defaultModuleAllowed = allowedModules.has('org-planning');
  if (!defaultModuleAllowed) {
    const firstVisibleLink = document.querySelector('.nav-module:not([style*="display: none"]) .nav-link');
    if (firstVisibleLink) {
      switchView(firstVisibleLink.dataset.view);
    }
  }
}

async function logout() {
  try {
    const res = await fetch('/api/auth/logout', { method: 'POST' });
    if (res.ok) {
      window.location.href = '/login';
    }
  } catch (err) {
    console.error('Logout failed:', err);
    window.location.href = '/login';
  }
}

// ===========================================================================
// MSP PORTAL DASHBOARD (superadmin only)
// ===========================================================================

async function showMSPDashboard() {
  // Hide sidebar, replace main content area with MSP dashboard
  const sidebar = document.querySelector('.sidebar');
  const mainContent = document.querySelector('.content');
  if (sidebar) sidebar.style.display = 'none';
  if (mainContent) mainContent.innerHTML = renderMSPPortalHTML();

  // Load organizations
  await loadMSPOrganizations();
}

function renderMSPPortalHTML() {
  return `
    <div id="msp-portal" style="padding: 32px; max-width: 1200px; margin: 0 auto;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 32px;">
        <div>
          <h1 style="font-size: 28px; font-weight: 700; color: #111827; margin-bottom: 4px;">MSP Portal</h1>
          <p style="color: #6b7280; font-size: 14px;">Manage all organizations from a single dashboard</p>
        </div>
        <div style="display: flex; gap: 12px; align-items: center;">
          <span style="color: #6b7280; font-size: 13px;">Logged in as <strong>${currentUser?.name || 'Superadmin'}</strong></span>
          <button onclick="logout()" style="padding: 8px 16px; background: #dc2626; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 13px;">Logout</button>
        </div>
      </div>

      <div id="msp-stats" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 32px;"></div>

      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
        <h2 style="font-size: 18px; font-weight: 600; color: #111827;">Organizations</h2>
        <button onclick="showCreateOrgModal()" style="padding: 8px 20px; background: #111827; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;">+ New Organization</button>
      </div>

      <div id="msp-org-list" style="background: #fff; border-radius: 8px; border: 1px solid #e5e7eb; overflow: hidden;">
        <div style="padding: 40px; text-align: center; color: #9ca3af;">Loading organizations...</div>
      </div>
    </div>

    <div id="create-org-modal" style="display: none; position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.5); align-items: center; justify-content: center;">
      <div style="background: #fff; border-radius: 12px; padding: 24px; width: 100%; max-width: 420px; box-shadow: 0 20px 60px rgba(0,0,0,0.2);">
        <h3 style="font-size: 18px; font-weight: 600; margin-bottom: 16px;">Create Organization</h3>
        <input type="text" id="new-org-name" placeholder="Organization name" style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; margin-bottom: 16px;">
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
          <button onclick="hideCreateOrgModal()" style="padding: 8px 16px; background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 6px; cursor: pointer;">Cancel</button>
          <button onclick="createOrganization()" style="padding: 8px 20px; background: #111827; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: 500;">Create</button>
        </div>
      </div>
    </div>
  `;
}

async function loadMSPOrganizations() {
  try {
    const [orgsRes, statsRes] = await Promise.all([
      fetch('/api/msp/organizations'),
      fetch('/api/msp/dashboard')
    ]);
    const orgs = await orgsRes.json();
    const stats = await statsRes.json();

    // Render stats
    const statsEl = document.getElementById('msp-stats');
    if (statsEl) {
      statsEl.innerHTML = `
        <div style="background: #fff; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb;">
          <div style="font-size: 28px; font-weight: 700; color: #111827;">${stats.totalOrgs}</div>
          <div style="font-size: 13px; color: #6b7280; margin-top: 4px;">Total Organizations</div>
        </div>
        <div style="background: #fff; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb;">
          <div style="font-size: 28px; font-weight: 700; color: #059669;">${stats.activeOrgs}</div>
          <div style="font-size: 13px; color: #6b7280; margin-top: 4px;">Active Organizations</div>
        </div>
        <div style="background: #fff; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb;">
          <div style="font-size: 28px; font-weight: 700; color: #2563eb;">${stats.totalUsers}</div>
          <div style="font-size: 13px; color: #6b7280; margin-top: 4px;">Total Users</div>
        </div>
      `;
    }

    // Render org list
    const listEl = document.getElementById('msp-org-list');
    if (listEl) {
      if (orgs.length === 0) {
        listEl.innerHTML = '<div style="padding: 40px; text-align: center; color: #9ca3af;">No organizations yet. Create your first one!</div>';
        return;
      }
      listEl.innerHTML = `
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: #f9fafb; border-bottom: 1px solid #e5e7eb;">
              <th style="text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Organization</th>
              <th style="text-align: center; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Status</th>
              <th style="text-align: center; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Users</th>
              <th style="text-align: center; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Created</th>
              <th style="text-align: right; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${orgs.map(org => `
              <tr style="border-bottom: 1px solid #f3f4f6;">
                <td style="padding: 14px 16px;">
                  <div style="font-weight: 600; color: #111827;">${escapeHtml(org.name)}</div>
                  <div style="font-size: 12px; color: #9ca3af;">${escapeHtml(org.slug)}</div>
                </td>
                <td style="text-align: center; padding: 14px 16px;">
                  <span style="display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 500; ${org.is_active ? 'background: #d1fae5; color: #065f46;' : 'background: #fee2e2; color: #991b1b;'}">${org.is_active ? 'Active' : 'Inactive'}</span>
                </td>
                <td style="text-align: center; padding: 14px 16px; color: #374151; font-weight: 500;">${org.user_count || 0}</td>
                <td style="text-align: center; padding: 14px 16px; color: #6b7280; font-size: 13px;">${new Date(org.created_at).toLocaleDateString()}</td>
                <td style="text-align: right; padding: 14px 16px;">
                  <button onclick="enterOrg(${org.id})" style="padding: 6px 14px; background: #111827; color: #fff; border: none; border-radius: 5px; cursor: pointer; font-size: 12px; margin-right: 6px;">Open</button>
                  <button onclick="toggleOrgActive(${org.id}, ${org.is_active ? 0 : 1})" style="padding: 6px 14px; background: ${org.is_active ? '#fef3c7' : '#d1fae5'}; color: ${org.is_active ? '#92400e' : '#065f46'}; border: 1px solid ${org.is_active ? '#fcd34d' : '#6ee7b7'}; border-radius: 5px; cursor: pointer; font-size: 12px;">${org.is_active ? 'Deactivate' : 'Activate'}</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    }
  } catch (err) {
    console.error('Failed to load organizations:', err);
  }
}

function showCreateOrgModal() {
  const modal = document.getElementById('create-org-modal');
  if (modal) modal.style.display = 'flex';
}

function hideCreateOrgModal() {
  const modal = document.getElementById('create-org-modal');
  if (modal) modal.style.display = 'none';
  const input = document.getElementById('new-org-name');
  if (input) input.value = '';
}

async function createOrganization() {
  const name = document.getElementById('new-org-name')?.value?.trim();
  if (!name) return alert('Please enter an organization name');
  try {
    const res = await fetch('/api/msp/organizations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!res.ok) {
      const err = await res.json();
      return alert(err.error || 'Failed to create organization');
    }
    hideCreateOrgModal();
    await loadMSPOrganizations();
  } catch (err) {
    alert('Failed to create organization');
  }
}

async function toggleOrgActive(orgId, newState) {
  const action = newState ? 'activate' : 'deactivate';
  if (!confirm(`Are you sure you want to ${action} this organization?`)) return;
  try {
    await fetch(`/api/msp/organizations/${orgId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: newState })
    });
    await loadMSPOrganizations();
  } catch (err) {
    alert('Failed to update organization');
  }
}

async function enterOrg(orgId) {
  try {
    const res = await fetch('/api/msp/switch-org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization_id: orgId })
    });
    if (res.ok) {
      window.location.reload();
    }
  } catch (err) {
    alert('Failed to enter organization');
  }
}

async function backToMSP() {
  try {
    const res = await fetch('/api/msp/switch-org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization_id: null })
    });
    if (res.ok) {
      window.location.reload();
    }
  } catch (err) {
    alert('Failed to return to MSP portal');
  }
}

// ===========================================================================
// ORG BANNER (shown when superadmin is inside an org)
// ===========================================================================

function renderOrgBanner() {
  // Remove any existing banner
  const existing = document.getElementById('org-context-banner');
  if (existing) existing.remove();

  if (!isSuperadmin || !activeOrg) return;

  const banner = document.createElement('div');
  banner.id = 'org-context-banner';
  banner.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; z-index: 9999; background: linear-gradient(135deg, #f59e0b, #d97706); color: #fff; padding: 10px 24px; display: flex; align-items: center; justify-content: space-between; font-size: 14px; font-weight: 500; box-shadow: 0 2px 8px rgba(0,0,0,0.15);';
  banner.innerHTML = `
    <span>Viewing as: <strong>${escapeHtml(activeOrg.name)}</strong></span>
    <a href="#" onclick="backToMSP(); return false;" style="color: #fff; text-decoration: underline; font-weight: 600; cursor: pointer;">Back to MSP Portal</a>
  `;
  document.body.prepend(banner);

  // Push content down to make room for the banner
  document.body.style.paddingTop = '44px';
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Load user on page load — stored as promise so init can await it
const userReady = loadCurrentUser();

// --- Sidebar Toggle ---
function toggleSidebar() {
  const sb = document.querySelector('.sidebar');
  sb.classList.toggle('collapsed');
  localStorage.setItem('sidebarCollapsed', sb.classList.contains('collapsed'));
}
if (localStorage.getItem('sidebarCollapsed') === 'true') {
  document.querySelector('.sidebar').classList.add('collapsed');
}

// --- Navigation ---
// Module toggles (expand/collapse)
document.querySelectorAll('.module-toggle').forEach(toggle => {
  toggle.addEventListener('click', e => {
    e.preventDefault();
    const sb = document.querySelector('.sidebar');
    if (sb.classList.contains('collapsed')) {
      // Expand sidebar and open this module's submenu
      sb.classList.remove('collapsed');
      localStorage.setItem('sidebarCollapsed', 'false');
      // Close all submenus, open this one
      document.querySelectorAll('.module-submenu').forEach(s => s.classList.remove('open'));
      document.querySelectorAll('.module-toggle').forEach(t => t.classList.add('collapsed'));
      const submenu = toggle.nextElementSibling;
      submenu.classList.add('open');
      toggle.classList.remove('collapsed');
    } else {
      const submenu = toggle.nextElementSibling;
      submenu.classList.toggle('open');
      toggle.classList.toggle('collapsed');
    }
  });
});

// Sub-view links
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    switchView(link.dataset.view);
  });
});

// Maps each view to its parent module data-module attribute
const VIEW_TO_MODULE = {};
document.querySelectorAll('.nav-module').forEach(moduleEl => {
  const toggle = moduleEl.querySelector('.module-toggle');
  if (!toggle) return;
  const moduleId = toggle.dataset.module;
  moduleEl.querySelectorAll('.nav-link').forEach(link => {
    VIEW_TO_MODULE[link.dataset.view] = moduleId;
  });
});

// Reverse lookup: module → permission key
const MODULE_TO_PERM = Object.fromEntries(
  Object.entries(PERM_TO_MODULE).map(([perm, mod]) => [mod, perm])
);

function hasPermissionForView(view) {
  if (isSuperadmin) return true;
  if (!currentUser) return true; // not loaded yet, allow
  const moduleId = VIEW_TO_MODULE[view];
  if (!moduleId) return true; // unknown view, allow
  const requiredPerm = MODULE_TO_PERM[moduleId];
  if (!requiredPerm) return true;
  let perms = [];
  try { perms = JSON.parse(currentUser.permissions || '[]'); } catch (e) {}
  if (currentUser.role === 'admin' && !perms.includes('admin')) perms.push('admin');
  return perms.includes(requiredPerm);
}

function switchView(view) {
  if (!hasPermissionForView(view)) return;
  currentView = view;
  closeDayDetail();
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(`view-${view}`).classList.remove('hidden');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const activeLink = document.querySelector(`[data-view="${view}"]`);
  if (activeLink) activeLink.classList.add('active');

  // Remove active from all module toggles first
  document.querySelectorAll('.module-toggle').forEach(t => t.classList.remove('active'));

  // Ensure parent module is expanded and marked active
  const parentSubmenu = activeLink?.closest('.module-submenu');
  if (parentSubmenu) {
    if (!parentSubmenu.classList.contains('open')) {
      parentSubmenu.classList.add('open');
    }
    const parentToggle = parentSubmenu.previousElementSibling;
    if (parentToggle) {
      parentToggle.classList.remove('collapsed');
      parentToggle.classList.add('active');
    }
  }

  if (view === 'dashboard') loadDashboard();
  else if (view === 'tasks') loadTasks();
  else if (view === 'yearly') loadYearlyPlan();
  else if (view === 'actions') loadActions();
  else if (view === 'history') loadHistory();
  else if (view === 'audit-plan') loadAuditPlan();
  else if (view === 'audit-execute') loadAuditExecuteView();
  else if (view === 'audit-ncrs') loadNcrs();
  else if (view === 'audit-requirements') loadRequirements();
  else if (view === 'threat-intelligence') loadThreatIntelligence();
  else if (view === 'risk-identification') loadRiskIdentification();
  else if (view === 'risk-treatment') loadRiskTreatmentView();
  else if (view === 'risk-soa') loadSoA();
  else if (view === 'mission-control') loadMissionControl();
  else if (view === 'architecture') loadArchitecture();
  else if (view === 'document-control') loadDocumentControl();
  // Admin views
  else if (view === 'admin-overview') loadAdminOverview();
  else if (view === 'admin-users') loadAdminUsers();
  else if (view === 'admin-audit-log') loadAdminAuditLog();
  else if (view === 'admin-settings') loadAdminSettings();
  else if (view === 'admin-data') loadAdminData();
  else if (view === 'admin-integrations') loadAdminIntegrations();
}

// --- API helpers ---
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return res.json();
}

// --- Cross-Link System ---
const linkableTypes = {
  risk: { label: 'Risk', icon: '&#9888;', canLink: ['role','process','system','asset','facility','requirement','document','task','action'] },
  task: { label: 'Task', icon: '&#9881;', canLink: ['role','process','asset','facility','risk','document','requirement','action'] },
  action: { label: 'Action', icon: '&#9889;', canLink: ['role','process','task','risk','document','requirement'] },
  audit: { label: 'Audit', icon: '&#9998;', canLink: ['role','process','requirement','risk','document'] },
  requirement: { label: 'Requirement', icon: '&#128220;', canLink: ['risk','task','audit','document','role','process','action'] },
  role: { label: 'Role', icon: '&#128100;', canLink: ['risk','task','audit','process','system','document','action'] },
  process: { label: 'Process', icon: '&#128260;', canLink: ['risk','task','audit','role','system','asset','document','action'] },
  system: { label: 'System', icon: '&#128187;', canLink: ['risk','process','role','asset','document'] },
  asset: { label: 'Asset', icon: '&#128230;', canLink: ['risk','task','process','facility','document'] },
  facility: { label: 'Facility', icon: '&#127970;', canLink: ['risk','task','asset','document'] },
  document: { label: 'Document', icon: '&#128196;', canLink: ['risk','task','audit','requirement','role','process','system','asset','facility','action'] },
  ncr: { label: 'NCR', icon: '&#9888;', canLink: ['risk','requirement','document','role','action'] },
  treatment: { label: 'Treatment', icon: '&#128737;', canLink: ['requirement','document','role','process','system','asset'] },
  checklist: { label: 'Checklist Item', icon: '&#9745;', canLink: ['document','process','system','asset'] },
};

async function renderCrossLinks(entityType, entityId, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const links = await api(`/api/cross-links/${entityType}/${entityId}`);
  const allowed = linkableTypes[entityType]?.canLink || [];

  const typeIcons = {};
  for (const [k, v] of Object.entries(linkableTypes)) typeIcons[k] = v.icon;
  const typeLabels = {};
  for (const [k, v] of Object.entries(linkableTypes)) typeLabels[k] = v.label;

  // Group links by type
  const grouped = {};
  for (const l of links) {
    if (!grouped[l.type]) grouped[l.type] = [];
    grouped[l.type].push(l);
  }

  const collapseId = `cl-collapse-${entityType}-${entityId}`;
  let html = '<div class="cross-links">';
  html += '<div class="cross-links-header">';
  html += `<span class="cross-links-title" style="cursor:pointer" onclick="document.getElementById('${collapseId}').classList.toggle('collapsed');this.querySelector('.cl-toggle-icon').textContent=document.getElementById('${collapseId}').classList.contains('collapsed')?'+':'−'">&#128279; Linked Items (${links.length}) <span class="cl-toggle-icon">−</span></span>`;
  html += `<button class="btn btn-secondary btn-sm" onclick="openCrossLinkPicker('${entityType}',${entityId},'${containerId}')">+ Link</button>`;
  html += '</div>';
  html += `<div id="${collapseId}" class="cross-links-body collapsed">`;

  if (links.length === 0) {
    html += '<div class="cross-links-empty">No linked items yet.</div>';
  } else {
    for (const [type, items] of Object.entries(grouped)) {
      html += `<div class="cross-link-group"><span class="cross-link-group-label">${typeIcons[type] || ''} ${typeLabels[type] || type}s</span>`;
      for (const item of items) {
        const viewTarget = getViewForType(item.type, item.id);
        html += `<div class="cross-link-item">
          <span class="cross-link-name"${viewTarget ? ` onclick="${viewTarget}" style="cursor:pointer;text-decoration:underline"` : ''}>${esc(item.name)}</span>
          <button class="cross-link-remove" onclick="removeCrossLink(${item.link_id},'${entityType}',${entityId},'${containerId}')" title="Remove link">&times;</button>
        </div>`;
      }
      html += '</div>';
    }
  }
  html += '</div></div>';
  container.innerHTML = html;
}

function getViewForType(type, id) {
  const archTypes = ['role','process','system','asset','facility'];
  if (archTypes.includes(type)) {
    return `currentArchTab='${type}';switchView('architecture')`;
  }
  const viewMap = {
    risk: 'risk-identification', task: 'tasks', audit: 'audit-plan',
    requirement: 'audit-requirements', document: 'document-control', ncr: 'audit-ncrs',
    action: 'actions',
  };
  const view = viewMap[type];
  return view ? `switchView('${view}')` : null;
}

async function openCrossLinkPicker(entityType, entityId, containerId) {
  const allowed = linkableTypes[entityType]?.canLink || [];
  // Build a modal dynamically
  let existing = document.getElementById('cross-link-picker-modal');
  if (!existing) {
    existing = document.createElement('div');
    existing.id = 'cross-link-picker-modal';
    existing.className = 'modal hidden';
    document.body.appendChild(existing);
  }
  existing.innerHTML = `
    <div class="modal-overlay" onclick="closeCrossLinkPicker()"></div>
    <div class="modal-content modal-sm">
      <div class="modal-header">
        <h3>Link to...</h3>
        <button class="modal-close" onclick="closeCrossLinkPicker()">&times;</button>
      </div>
      <div class="form-group">
        <label>Type</label>
        <select id="cl-pick-type" onchange="loadCrossLinkOptions()">
          <option value="">-- Select type --</option>
          ${allowed.map(t => `<option value="${t}">${linkableTypes[t]?.label || t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Item</label>
        <select id="cl-pick-item"><option value="">-- Select type first --</option></select>
      </div>
      <div class="form-actions">
        <button class="btn btn-secondary" onclick="closeCrossLinkPicker()">Cancel</button>
        <button class="btn btn-primary" onclick="addCrossLink('${entityType}',${entityId},'${containerId}')">Link</button>
      </div>
    </div>`;
  existing.classList.remove('hidden');
}

function closeCrossLinkPicker() {
  const m = document.getElementById('cross-link-picker-modal');
  if (m) m.classList.add('hidden');
}

async function loadCrossLinkOptions() {
  const type = document.getElementById('cl-pick-type').value;
  const sel = document.getElementById('cl-pick-item');
  if (!type) { sel.innerHTML = '<option value="">-- Select type first --</option>'; return; }
  const items = await api(`/api/linkable/${type}`);
  sel.innerHTML = '<option value="">-- Select --</option>' + items.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('');
}

async function addCrossLink(sourceType, sourceId, containerId) {
  const targetType = document.getElementById('cl-pick-type').value;
  const targetId = document.getElementById('cl-pick-item').value;
  if (!targetType || !targetId) return alert('Please select a type and item');
  await api('/api/cross-links', { method: 'POST', body: { source_type: sourceType, source_id: sourceId, target_type: targetType, target_id: parseInt(targetId) } });
  closeCrossLinkPicker();
  renderCrossLinks(sourceType, sourceId, containerId);
}

async function removeCrossLink(linkId, entityType, entityId, containerId) {
  await api(`/api/cross-links/${linkId}`, { method: 'DELETE' });
  renderCrossLinks(entityType, entityId, containerId);
}

async function ensureMeta() {
  if (meta.assignees.length === 0 && meta.categories.length === 0) {
    meta = await api('/api/meta');
  }
}

// --- Dashboard ---
async function loadDashboard() {
  const stats = await api('/api/dashboard');
  const grid = document.getElementById('stats-grid');
  grid.innerHTML = `
    <div class="stat-card"><div class="stat-value">${stats.totalActive}</div><div class="stat-label">Active Tasks</div></div>
    <div class="stat-card today clickable" onclick="switchView('tasks')"><div class="stat-value">${stats.dueToday}</div><div class="stat-label">Due Today</div></div>
    <div class="stat-card overdue clickable" onclick="switchView('tasks')"><div class="stat-value">${stats.overdue}</div><div class="stat-label">Overdue</div></div>
    <div class="stat-card done"><div class="stat-value">${stats.completedThisWeek}</div><div class="stat-label">Done This Week</div></div>
    <div class="stat-card done clickable" onclick="switchView('yearly')"><div class="stat-value">${stats.completedThisMonth}</div><div class="stat-label">Done This Month</div></div>
    <div class="stat-card${stats.openActions > 0 ? ' overdue' : ''} clickable" onclick="switchView('actions')"><div class="stat-value">${stats.openActions}</div><div class="stat-label">Open Actions</div></div>
  `;

  // KPI cards
  const kpiGrid = document.getElementById('kpi-grid');
  const apc = stats.actionsPerCheck ?? 0;
  const apcTotal = stats.totalActionsCount ?? 0;
  const apcChecks = stats.totalCompletions ?? 0;
  const apcThisMonth = stats.actionsPerCheckThisMonth ?? 0;
  const apcLastMonth = stats.actionsPerCheckLastMonth ?? 0;
  const apcTrend = apcLastMonth > 0
    ? Number(((apcThisMonth - apcLastMonth) / apcLastMonth * 100).toFixed(0))
    : null;
  const apcArrow = apcTrend === null ? '' : (apcTrend > 0 ? `<span class="kpi-trend up">&uarr; ${apcTrend}%</span>` : apcTrend < 0 ? `<span class="kpi-trend down">&darr; ${Math.abs(apcTrend)}%</span>` : `<span class="kpi-trend flat">&rarr; 0%</span>`);
  const apcColor = apcTrend === null ? '' : (apcTrend > 0 ? 'trend-bad' : apcTrend < 0 ? 'trend-good' : '');

  const otCurrent = stats.onTimeRateCurrent;
  const otPrevious = stats.onTimeRatePrevious;
  const otDelta = (otCurrent != null && otPrevious != null) ? otCurrent - otPrevious : null;
  const otArrow = otDelta === null ? '' : (otDelta > 0 ? `<span class="kpi-trend down">&uarr; +${otDelta}pp</span>` : otDelta < 0 ? `<span class="kpi-trend up">&darr; ${otDelta}pp</span>` : `<span class="kpi-trend flat">&rarr; 0pp</span>`);
  const otColor = otDelta === null ? '' : (otDelta > 0 ? 'trend-good' : otDelta < 0 ? 'trend-bad' : '');

  kpiGrid.innerHTML = `
    <div class="kpi-card ${apcColor}">
      <div class="kpi-header">Actions per Check</div>
      <div class="kpi-value">${apc}</div>
      <div class="kpi-detail">${apcTotal} action${apcTotal !== 1 ? 's' : ''} from ${apcChecks} check${apcChecks !== 1 ? 's' : ''}</div>
      <div class="kpi-footer">This month: ${apcThisMonth} ${apcArrow}</div>
    </div>
    <div class="kpi-card ${otColor}">
      <div class="kpi-header">On-Time Completion</div>
      <div class="kpi-value">${otCurrent != null ? otCurrent + '%' : 'N/A'}</div>
      <div class="kpi-detail">${otCurrent != null ? 'Last 30 days' : 'No completions yet'}</div>
      <div class="kpi-footer">Previous 30d: ${otPrevious != null ? otPrevious + '%' : 'N/A'} ${otArrow}</div>
    </div>
  `;

  // Overdue tasks
  const overdueList = document.getElementById('overdue-list');
  if (stats.overdueTasks.length === 0) {
    overdueList.innerHTML = '<div class="empty-state">No overdue tasks</div>';
  } else {
    overdueList.innerHTML = stats.overdueTasks.map(t => taskCard(t)).join('');
  }

  // Overdue actions
  const overdueActionsList = document.getElementById('overdue-actions-list');
  if (stats.overdueActions > 0) {
    const actions = await api('/api/actions?status=open');
    const today = new Date().toISOString().split('T')[0];
    const overdueActions = actions.filter(a => a.due_date && a.due_date < today);
    if (overdueActions.length > 0) {
      overdueActionsList.innerHTML = overdueActions.map(a => `
        <div class="task-card">
          <div class="task-card-info" style="cursor:pointer" onclick="openActionModal(${a.id})">
            <h4 style="color:var(--primary)">${esc(a.title)}</h4>
            <div class="meta">From: ${esc(a.task_title)} &middot; ${esc(a.assignee || 'Unassigned')} &middot; Due: ${a.due_date}</div>
          </div>
          ${actionMenu([
            { label: '&#9654; Start', onclick: `updateActionStatusAndRefresh(${a.id},'in_progress')`, cls: 'primary' },
            { label: '&#9998; Edit', onclick: `openActionModal(${a.id})` },
          ])}
        </div>`).join('');
    } else {
      overdueActionsList.innerHTML = '<div class="empty-state">No overdue actions</div>';
    }
  } else {
    overdueActionsList.innerHTML = '<div class="empty-state">No overdue actions</div>';
  }

  // Upcoming tasks
  const upcomingList = document.getElementById('upcoming-list');
  if (stats.upcomingTasks.length === 0) {
    upcomingList.innerHTML = '<div class="empty-state">No upcoming tasks</div>';
  } else {
    upcomingList.innerHTML = stats.upcomingTasks.map(t => taskCard(t)).join('');
  }
}

function taskCard(task) {
  return `
    <div class="task-card">
      <div class="task-card-info" style="cursor:pointer" onclick="openTaskModal(${task.id})">
        <h4 style="color:var(--primary)">${esc(task.title)}</h4>
        <div class="meta">${esc(task.assignee || 'Unassigned')} &middot; ${task.recurrence} &middot; Due: ${task.next_due}</div>
      </div>
      ${actionMenu([
        { label: '&#10003; Mark Done', onclick: `openCompleteModal(${task.id})`, cls: 'success' },
        { label: '&#9998; Edit', onclick: `openTaskModal(${task.id})` },
      ])}
    </div>`;
}

// --- Tasks View ---
async function loadTasks() {
  meta = await api('/api/meta');
  await renderFilters();

  const params = new URLSearchParams();
  if (filters.active) params.set('active', filters.active);
  if (filters.assignee) params.set('assignee', filters.assignee);
  if (filters.category) params.set('category', filters.category);
  if (filters.priority) params.set('priority', filters.priority);

  allTasks = await api(`/api/tasks?${params}`);
  renderTaskTable();
}

async function renderFilters() {
  const bar = document.getElementById('filters-bar');
  // Fetch roles and processes from Architecture for filters
  const roles = await api('/api/architecture?arch_type=role');
  const processes = await api('/api/architecture?arch_type=process');

  bar.innerHTML = `
    <select onchange="filters.active=this.value;loadTasks()">
      <option value="true" ${filters.active==='true'?'selected':''}>Active</option>
      <option value="false" ${filters.active==='false'?'selected':''}>Inactive</option>
      <option value="" ${filters.active===''?'selected':''}>All</option>
    </select>
    <select onchange="filters.priority=this.value;loadTasks()">
      <option value="">All Priorities</option>
      <option value="Low" ${filters.priority==='Low'?'selected':''}>Low</option>
      <option value="Medium" ${filters.priority==='Medium'?'selected':''}>Medium</option>
      <option value="High" ${filters.priority==='High'?'selected':''}>High</option>
      <option value="Critical" ${filters.priority==='Critical'?'selected':''}>Critical</option>
    </select>
    <select onchange="filters.assignee=this.value;loadTasks()">
      <option value="">All Roles</option>
      ${roles.map(r => `<option value="${esc(r.name)}" ${filters.assignee===r.name?'selected':''}>${esc(r.name)}</option>`).join('')}
      ${meta.assignees.filter(a => !roles.find(r => r.name === a)).map(a => `<option value="${esc(a)}" ${filters.assignee===a?'selected':''}>${esc(a)}</option>`).join('')}
    </select>
    <select onchange="filters.category=this.value;loadTasks()">
      <option value="">All Processes</option>
      ${processes.map(p => `<option value="${esc(p.name)}" ${filters.category===p.name?'selected':''}>${esc(p.name)}</option>`).join('')}
      ${meta.categories.filter(c => !processes.find(p => p.name === c)).map(c => `<option value="${esc(c)}" ${filters.category===c?'selected':''}>${esc(c)}</option>`).join('')}
    </select>
  `;
}

function renderTaskTable() {
  const tbody = document.getElementById('task-table-body');
  const today = new Date().toISOString().split('T')[0];
  if (allTasks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No tasks found</td></tr>';
    return;
  }
  tbody.innerHTML = allTasks.map(t => {
    const status = t.next_due < today ? 'overdue' : t.next_due === today ? 'due-today' : 'upcoming';
    const statusLabel = status === 'overdue' ? 'Overdue' : status === 'due-today' ? 'Due Today' : 'Upcoming';
    return `<tr>
      <td><strong style="cursor:pointer;color:var(--primary)" onclick="openTaskModal(${t.id})">${esc(t.title)}</strong>${t.description ? '<br><small style="color:var(--text-muted);cursor:pointer" onclick="openTaskModal(' + t.id + ')">' + esc(t.description) + '</small>' : ''}
        <div id="task-links-${t.id}" class="task-inline-links"></div>
      </td>
      <td>${esc(t.assignee || '-')}</td>
      <td>${esc(t.category)}</td>
      <td><span class="badge badge-${t.priority.toLowerCase()}">${t.priority}</span></td>
      <td>${t.recurrence}${t.recurrence === 'custom' ? ' (' + t.custom_days + 'd)' : ''}</td>
      <td>${t.next_due}</td>
      <td><span class="badge badge-${status}">${statusLabel}</span></td>
      <td>${actionMenu([
        { label: '&#10003; Mark Done', onclick: `openCompleteModal(${t.id})`, cls: 'success' },
        { label: '&#128279; Links', onclick: `toggleTaskLinks(${t.id})` },
        { label: '&#9998; Edit', onclick: `openTaskModal(${t.id})` },
        'sep',
        { label: '&#128465; Delete', onclick: `deleteTask(${t.id})`, cls: 'danger' },
      ])}</td>
    </tr>`;
  }).join('');
}

function toggleTaskLinks(taskId) {
  const el = document.getElementById(`task-links-${taskId}`);
  if (el.innerHTML) { el.innerHTML = ''; return; }
  renderCrossLinks('task', taskId, `task-links-${taskId}`);
}

// --- History ---
async function loadHistory() {
  const completions = await api('/api/completions?limit=100');
  const list = document.getElementById('history-list');
  if (completions.length === 0) {
    list.innerHTML = '<div class="empty-state">No completions yet</div>';
    return;
  }
  list.innerHTML = completions.map(c => `
    <div class="history-item">
      <div class="hi-info">
        <strong>${esc(c.task_title)}</strong>
        <div class="hi-meta">${c.completed_by ? 'by ' + esc(c.completed_by) : ''}${c.notes ? ' — ' + esc(c.notes) : ''}</div>
        ${c.action_count > 0 ? `<div class="hi-meta"><span class="badge badge-${c.open_action_count > 0 ? 'high' : 'low'}">${c.open_action_count} open / ${c.action_count} actions</span></div>` : ''}
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <div class="hi-date">${new Date(c.completed_at).toLocaleString()}</div>
        ${actionMenu([
          { label: '&#128203; View Actions', onclick: `viewCompletionActions(${c.id}, ${c.task_id})` },
        ])}
      </div>
    </div>
  `).join('');
}

// --- Task Modal ---
async function openTaskModal(id) {
  await ensureMeta();
  const modal = document.getElementById('task-modal');
  const form = document.getElementById('task-form');
  form.reset();
  document.getElementById('task-id').value = '';
  document.getElementById('task-start').value = new Date().toISOString().split('T')[0];
  document.getElementById('modal-title').textContent = 'New Task';
  document.getElementById('custom-days-group').classList.add('hidden');

  // Populate Role dropdown from Architecture roles
  const roles = await api('/api/architecture?arch_type=role');
  const assigneeSelect = document.getElementById('task-assignee');
  assigneeSelect.innerHTML = '<option value="">-- Select Role --</option>' +
    roles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');

  // Populate Process dropdown from Architecture processes
  const processes = await api('/api/architecture?arch_type=process');
  const categorySelect = document.getElementById('task-category');
  categorySelect.innerHTML = '<option value="">-- Select Process --</option>' +
    processes.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');

  if (id) {
    const task = await api(`/api/tasks/${id}`);
    document.getElementById('modal-title').textContent = 'Edit Task';
    document.getElementById('task-id').value = task.id;
    document.getElementById('task-title').value = task.title;
    document.getElementById('task-desc').value = task.description;
    document.getElementById('task-assignee').value = task.assignee;
    document.getElementById('task-category').value = task.category;
    document.getElementById('task-priority').value = task.priority;
    document.getElementById('task-recurrence').value = task.recurrence;
    document.getElementById('task-custom-days').value = task.custom_days || 1;
    document.getElementById('task-start').value = task.start_date;
    toggleCustomDays();
  }

  modal.classList.remove('hidden');
}

function closeTaskModal() {
  document.getElementById('task-modal').classList.add('hidden');
}

function toggleCustomDays() {
  const sel = document.getElementById('task-recurrence').value;
  document.getElementById('custom-days-group').classList.toggle('hidden', sel !== 'custom');
}

async function saveTask(e) {
  e.preventDefault();
  const id = document.getElementById('task-id').value;
  const assigneeName = document.getElementById('task-assignee').value;
  const categoryName = document.getElementById('task-category').value || 'General';
  const body = {
    title: document.getElementById('task-title').value,
    description: document.getElementById('task-desc').value,
    assignee: assigneeName,
    category: categoryName,
    priority: document.getElementById('task-priority').value,
    recurrence: document.getElementById('task-recurrence').value,
    custom_days: parseInt(document.getElementById('task-custom-days').value) || null,
    start_date: document.getElementById('task-start').value,
  };

  let taskId = id;
  if (id) {
    await api(`/api/tasks/${id}`, { method: 'PUT', body });
  } else {
    const result = await api('/api/tasks', { method: 'POST', body });
    taskId = result.id;
  }

  // Create cross-links for role and process
  if (taskId) {
    // Get existing links to avoid duplicates
    const existingLinks = await api(`/api/cross-links/task/${taskId}`);
    const existingTargets = new Set(existingLinks.map(l => `${l.type}:${l.id}`));

    // Link assignee (role) by name lookup
    if (assigneeName) {
      const roles = await api('/api/architecture?arch_type=role');
      const role = roles.find(r => r.name === assigneeName);
      if (role && !existingTargets.has(`role:${role.id}`)) {
        await api('/api/cross-links', { method: 'POST', body: { source_type: 'task', source_id: parseInt(taskId), target_type: 'role', target_id: role.id } });
      }
    }
    // Link category (process) by name lookup
    if (categoryName && categoryName !== 'General') {
      const processes = await api('/api/architecture?arch_type=process');
      const proc = processes.find(p => p.name === categoryName);
      if (proc && !existingTargets.has(`process:${proc.id}`)) {
        await api('/api/cross-links', { method: 'POST', body: { source_type: 'task', source_id: parseInt(taskId), target_type: 'process', target_id: proc.id } });
      }
    }
  }

  closeTaskModal();
  invalidateYearlyCache();
  meta = await api('/api/meta'); // refresh meta after adding new assignees/categories
  refreshCurrentView();
}

// --- Complete Modal ---
function openCompleteModal(taskId) {
  document.getElementById('complete-form').reset();
  document.getElementById('complete-task-id').value = taskId;
  document.getElementById('complete-modal').classList.remove('hidden');
}

function closeCompleteModal() {
  document.getElementById('complete-modal').classList.add('hidden');
}

async function submitComplete(e) {
  e.preventDefault();
  const taskId = document.getElementById('complete-task-id').value;
  const result = await api(`/api/tasks/${taskId}/complete`, {
    method: 'POST',
    body: {
      completed_by: document.getElementById('complete-by').value,
      notes: document.getElementById('complete-notes').value,
    },
  });
  closeCompleteModal();
  invalidateYearlyCache();
  // Show post-completion action prompt
  lastCompletionContext = { completion_id: result.completion_id, task_id: parseInt(taskId) };
  await openPostCompleteModal();
}

// --- Delete ---
async function deleteTask(id) {
  if (!confirm('Delete this task and all its history?')) return;
  await api(`/api/tasks/${id}`, { method: 'DELETE' });
  invalidateYearlyCache();
  refreshCurrentView();
}

// --- Post-completion Actions ---
async function openPostCompleteModal() {
  document.getElementById('post-complete-actions-list').innerHTML = '';
  document.getElementById('quick-action-title').value = '';
  document.getElementById('quick-action-priority').value = 'Medium';
  document.getElementById('quick-action-due').value = '';

  // Populate Role dropdown from Architecture
  const roles = await api('/api/architecture?arch_type=role');
  const assigneeSelect = document.getElementById('quick-action-assignee');
  assigneeSelect.innerHTML = '<option value="">-- Select Role --</option>' +
    roles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');

  document.getElementById('post-complete-modal').classList.remove('hidden');
}

function closePostCompleteModal() {
  document.getElementById('post-complete-modal').classList.add('hidden');
  lastCompletionContext = null;
  refreshCurrentView();
}

async function addQuickAction() {
  const title = document.getElementById('quick-action-title').value.trim();
  if (!title) return alert('Action title is required');

  const assigneeName = document.getElementById('quick-action-assignee').value;
  const taskId = lastCompletionContext.task_id;

  const action = await api('/api/actions', {
    method: 'POST',
    body: {
      completion_id: lastCompletionContext.completion_id,
      task_id: taskId,
      title,
      assignee: assigneeName,
      priority: document.getElementById('quick-action-priority').value,
      due_date: document.getElementById('quick-action-due').value || null,
    },
  });

  // Create cross-links for role and source task
  if (action.id) {
    // Link assignee (role) by name lookup
    if (assigneeName) {
      const roles = await api('/api/architecture?arch_type=role');
      const role = roles.find(r => r.name === assigneeName);
      if (role) {
        await api('/api/cross-links', { method: 'POST', body: { source_type: 'action', source_id: action.id, target_type: 'role', target_id: role.id } });
      }
    }
    // Link source task
    if (taskId) {
      await api('/api/cross-links', { method: 'POST', body: { source_type: 'action', source_id: action.id, target_type: 'task', target_id: parseInt(taskId) } });
    }
  }

  // Add to the visible list
  const list = document.getElementById('post-complete-actions-list');
  list.innerHTML += `<div class="task-card" style="margin-bottom:8px">
    <div class="task-card-info">
      <h4>${esc(action.title)}</h4>
      <div class="meta">${esc(action.assignee || 'Unassigned')} &middot; <span class="badge badge-${action.priority.toLowerCase()}">${action.priority}</span>${action.due_date ? ' &middot; Due: ' + action.due_date : ''}</div>
    </div>
  </div>`;

  // Reset inputs
  document.getElementById('quick-action-title').value = '';
  document.getElementById('quick-action-assignee').value = '';
  document.getElementById('quick-action-priority').value = 'Medium';
  document.getElementById('quick-action-due').value = '';
}

// --- Actions View ---
async function loadActions() {
  const params = new URLSearchParams();
  if (actionFilters.status) params.set('status', actionFilters.status);

  const actions = await api(`/api/actions?${params}`);
  renderActionFilters();
  renderActionTable(actions);
}

function renderActionFilters() {
  const bar = document.getElementById('action-filters-bar');
  bar.innerHTML = `
    <select onchange="actionFilters.status=this.value;loadActions()">
      <option value="open" ${actionFilters.status==='open'?'selected':''}>Open</option>
      <option value="in_progress" ${actionFilters.status==='in_progress'?'selected':''}>In Progress</option>
      <option value="resolved" ${actionFilters.status==='resolved'?'selected':''}>Resolved</option>
      <option value="closed" ${actionFilters.status==='closed'?'selected':''}>Closed</option>
      <option value="" ${actionFilters.status===''?'selected':''}>All</option>
    </select>
  `;
}

function renderActionTable(actions) {
  const tbody = document.getElementById('action-table-body');
  const today = new Date().toISOString().split('T')[0];
  if (actions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No actions found</td></tr>';
    return;
  }
  tbody.innerHTML = actions.map(a => {
    const isOverdue = a.due_date && a.due_date < today && (a.status === 'open' || a.status === 'in_progress');
    const statusClass = a.status === 'open' ? 'badge-high' : a.status === 'in_progress' ? 'badge-medium' : 'badge-low';
    const statusLabel = a.status.replace('_', ' ');
    return `<tr>
      <td><strong style="cursor:pointer;color:var(--primary)" onclick="openActionModal(${a.id})">${esc(a.title)}</strong>${a.description ? '<br><small style="color:var(--text-muted);cursor:pointer" onclick="openActionModal(' + a.id + ')">' + esc(a.description) + '</small>' : ''}</td>
      <td>${esc(a.task_title)}</td>
      <td>${esc(a.assignee || '-')}</td>
      <td><span class="badge badge-${a.priority.toLowerCase()}">${a.priority}</span></td>
      <td>${a.due_date ? (isOverdue ? '<span style="color:var(--danger);font-weight:600">' + a.due_date + '</span>' : a.due_date) : '-'}</td>
      <td><span class="badge ${statusClass}">${statusLabel}</span></td>
      <td>${actionMenu([
        ...(a.status === 'open' ? [{ label: '&#9654; Start', onclick: `updateActionStatus(${a.id},'in_progress')`, cls: 'primary' }] : []),
        ...(a.status === 'in_progress' ? [{ label: '&#10003; Resolve', onclick: `resolveAction(${a.id})`, cls: 'success' }] : []),
        { label: '&#9998; Edit', onclick: `openActionModal(${a.id})` },
        'sep',
        { label: '&#128465; Delete', onclick: `deleteAction(${a.id})`, cls: 'danger' },
      ])}</td>
    </tr>`;
  }).join('');
}

async function updateActionStatus(id, status) {
  await api(`/api/actions/${id}`, { method: 'PUT', body: { status } });
  refreshCurrentView();
}

async function updateActionStatusAndRefresh(id, status) {
  await api(`/api/actions/${id}`, { method: 'PUT', body: { status } });
  loadDashboard();
}

async function resolveAction(id) {
  const resolvedBy = prompt('Resolved by (your name):');
  if (resolvedBy === null) return;
  await api(`/api/actions/${id}`, { method: 'PUT', body: { status: 'resolved', resolved_by: resolvedBy } });
  refreshCurrentView();
}

async function deleteAction(id) {
  if (!confirm('Delete this action?')) return;
  await api(`/api/actions/${id}`, { method: 'DELETE' });
  refreshCurrentView();
}

// --- Action Modal (edit) ---
let actionStatusHandler = null;

async function openActionModal(id) {
  const modal = document.getElementById('action-modal');
  const form = document.getElementById('action-form');
  form.reset();
  document.getElementById('action-id').value = '';
  document.getElementById('action-modal-title').textContent = 'New Follow-up Action';
  document.getElementById('action-resolved-by-group').classList.add('hidden');

  // Populate Role dropdown from Architecture
  const roles = await api('/api/architecture?arch_type=role');
  const assigneeSelect = document.getElementById('action-assignee');
  assigneeSelect.innerHTML = '<option value="">-- Select Role --</option>' +
    roles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');

  if (id) {
    const action = await api(`/api/actions/${id}`);
    document.getElementById('action-modal-title').textContent = 'Edit Action';
    document.getElementById('action-id').value = action.id;
    document.getElementById('action-completion-id').value = action.completion_id;
    document.getElementById('action-task-id').value = action.task_id;
    document.getElementById('action-title').value = action.title;
    document.getElementById('action-description').value = action.description;
    document.getElementById('action-assignee').value = action.assignee;
    document.getElementById('action-priority').value = action.priority;
    document.getElementById('action-due-date').value = action.due_date || '';
    document.getElementById('action-status').value = action.status;
    document.getElementById('action-resolved-by').value = action.resolved_by || '';
    if (action.status === 'resolved' || action.status === 'closed') {
      document.getElementById('action-resolved-by-group').classList.remove('hidden');
    }
  }

  // Remove old listener before adding new one
  const statusEl = document.getElementById('action-status');
  if (actionStatusHandler) statusEl.removeEventListener('change', actionStatusHandler);
  actionStatusHandler = function() {
    document.getElementById('action-resolved-by-group').classList.toggle('hidden',
      this.value !== 'resolved' && this.value !== 'closed');
  };
  statusEl.addEventListener('change', actionStatusHandler);

  modal.classList.remove('hidden');
}

function closeActionModal() {
  document.getElementById('action-modal').classList.add('hidden');
}

async function saveAction(e) {
  e.preventDefault();
  const id = document.getElementById('action-id').value;
  const assigneeName = document.getElementById('action-assignee').value;
  const body = {
    title: document.getElementById('action-title').value,
    description: document.getElementById('action-description').value,
    assignee: assigneeName,
    priority: document.getElementById('action-priority').value,
    due_date: document.getElementById('action-due-date').value || null,
    status: document.getElementById('action-status').value,
    resolved_by: document.getElementById('action-resolved-by').value,
  };

  let actionId = id;
  let taskId = null;
  if (id) {
    await api(`/api/actions/${id}`, { method: 'PUT', body });
  } else {
    body.completion_id = document.getElementById('action-completion-id').value;
    taskId = document.getElementById('action-task-id').value;
    body.task_id = taskId;
    const result = await api('/api/actions', { method: 'POST', body });
    actionId = result.id;
  }

  // Create cross-links for role and source task
  if (actionId) {
    // Get existing links to avoid duplicates
    const existingLinks = await api(`/api/cross-links/action/${actionId}`);
    const existingTargets = new Set(existingLinks.map(l => `${l.type}:${l.id}`));

    // Link assignee (role) by name lookup
    if (assigneeName) {
      const roles = await api('/api/architecture?arch_type=role');
      const role = roles.find(r => r.name === assigneeName);
      if (role && !existingTargets.has(`role:${role.id}`)) {
        await api('/api/cross-links', { method: 'POST', body: { source_type: 'action', source_id: parseInt(actionId), target_type: 'role', target_id: role.id } });
      }
    }
    // Link source task (only for new actions)
    if (taskId && !existingTargets.has(`task:${taskId}`)) {
      await api('/api/cross-links', { method: 'POST', body: { source_type: 'action', source_id: parseInt(actionId), target_type: 'task', target_id: parseInt(taskId) } });
    }
  }

  closeActionModal();
  refreshCurrentView();
}

// View actions for a specific completion (from history)
async function viewCompletionActions(completionId, taskId) {
  lastCompletionContext = { completion_id: completionId, task_id: taskId };
  const actions = await api(`/api/actions?completion_id=${completionId}`);

  const list = document.getElementById('post-complete-actions-list');
  list.innerHTML = actions.map(a => {
    const statusClass = a.status === 'open' ? 'badge-high' : a.status === 'in_progress' ? 'badge-medium' : 'badge-low';
    return `<div class="task-card" style="margin-bottom:8px">
      <div class="task-card-info">
        <h4>${esc(a.title)}</h4>
        <div class="meta">${esc(a.assignee || 'Unassigned')} &middot; <span class="badge badge-${a.priority.toLowerCase()}">${a.priority}</span> &middot; <span class="badge ${statusClass}">${a.status.replace('_',' ')}</span>${a.due_date ? ' &middot; Due: ' + a.due_date : ''}</div>
      </div>
    </div>`;
  }).join('');

  document.getElementById('quick-action-title').value = '';
  document.getElementById('quick-action-assignee').value = '';
  document.getElementById('quick-action-priority').value = 'Medium';
  document.getElementById('quick-action-due').value = '';
  document.getElementById('post-complete-modal').classList.remove('hidden');
}

// --- Yearly Plan ---
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAY_LABELS = ['Mo','Tu','We','Th','Fr','Sa','Su'];

function changeYear(delta) {
  if (delta === 0) yearlyYear = new Date().getFullYear();
  else yearlyYear += delta;
  invalidateYearlyCache();
  loadYearlyPlan();
}

function invalidateYearlyCache() {
  yearlyData = null;
}

async function loadYearlyPlan() {
  document.getElementById('yearly-title').textContent = `Yearly Plan ${yearlyYear}`;
  const data = await api(`/api/yearly?year=${yearlyYear}`);
  yearlyData = data;
  const grid = document.getElementById('yearly-grid');
  const today = new Date().toISOString().split('T')[0];

  // Compute per-month stats
  const monthStats = [];
  let totalDue = 0, totalCompleted = 0, totalOverdue = 0;
  for (let m = 0; m < 12; m++) {
    const daysInMonth = new Date(yearlyYear, m + 1, 0).getDate();
    let due = 0, completed = 0, overdue = 0;
    const taskDates = {}; // { task_id: { title, assignee, priority, recurrence, dates: [{date, type}] } }

    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${yearlyYear}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      if (data.dueDates[ds]) {
        due += data.dueDates[ds].length;
        if (ds < today) overdue += data.dueDates[ds].length;
        for (const t of data.dueDates[ds]) {
          if (!taskDates[t.task_id]) taskDates[t.task_id] = { ...t, dates: [] };
          taskDates[t.task_id].dates.push({ date: ds, type: ds < today ? 'overdue' : 'due' });
        }
      }
      if (data.completedDates[ds]) {
        completed += data.completedDates[ds].length;
        for (const t of data.completedDates[ds]) {
          if (!taskDates[t.task_id]) taskDates[t.task_id] = { ...t, dates: [] };
          taskDates[t.task_id].dates.push({ date: ds, type: 'completed' });
        }
      }
    }
    monthStats.push({ due, completed, overdue, taskDates });
    totalDue += due;
    totalCompleted += completed;
    totalOverdue += overdue;
  }

  // Render yearly summary stats
  const summaryEl = document.getElementById('yearly-summary');
  const pct = totalDue > 0 ? Math.round((totalCompleted / totalDue) * 100) : 0;
  summaryEl.innerHTML = `
    <div class="stat-card"><div class="stat-value">${totalDue}</div><div class="stat-label">Total Scheduled (${yearlyYear})</div></div>
    <div class="stat-card done"><div class="stat-value">${totalCompleted}</div><div class="stat-label">Completed</div></div>
    <div class="stat-card${totalOverdue > 0 ? ' overdue' : ''}"><div class="stat-value">${totalOverdue}</div><div class="stat-label">Overdue</div></div>
    <div class="stat-card"><div class="stat-value">${pct}%</div><div class="stat-label">Completion Rate</div></div>
  `;

  // Render Gantt chart
  renderGanttChart(data, monthStats, today);

  // Render Coming Up & Overdue section
  const upcomingEl = document.getElementById('yearly-upcoming');
  const todayDate = new Date(today);
  const fourWeeksOut = new Date(todayDate);
  fourWeeksOut.setDate(fourWeeksOut.getDate() + 28);
  const fourWeeksStr = fourWeeksOut.toISOString().split('T')[0];

  // Collect overdue tasks
  const overdueItems = [];
  const upcomingItems = [];
  for (const [dateStr, tasks] of Object.entries(data.dueDates)) {
    for (const t of tasks) {
      if (dateStr < today) {
        // Check if completed on this date
        const completedOnDate = data.completedDates[dateStr] && data.completedDates[dateStr].some(c => c.task_id === t.task_id);
        if (!completedOnDate) {
          overdueItems.push({ ...t, date: dateStr });
        }
      } else if (dateStr >= today && dateStr <= fourWeeksStr) {
        upcomingItems.push({ ...t, date: dateStr });
      }
    }
  }

  overdueItems.sort((a, b) => a.date.localeCompare(b.date));
  upcomingItems.sort((a, b) => a.date.localeCompare(b.date));

  const priorityBadge = p => p === 'High' ? 'badge-high' : p === 'Medium' ? 'badge-medium' : 'badge-low';
  const dayLabel = ds => {
    const d = new Date(ds + 'T00:00:00');
    const diff = Math.round((d - todayDate) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff < 7) return MONTH_NAMES[d.getMonth()].substring(0, 3) + ' ' + d.getDate() + ' (' + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()] + ')';
    return MONTH_NAMES[d.getMonth()].substring(0, 3) + ' ' + d.getDate();
  };
  const overdueDayLabel = ds => {
    const d = new Date(ds + 'T00:00:00');
    const diff = Math.round((todayDate - d) / 86400000);
    return MONTH_NAMES[d.getMonth()].substring(0, 3) + ' ' + d.getDate() + ` (${diff}d ago)`;
  };

  let html = '';

  // Overdue section
  if (overdueItems.length > 0) {
    html += `<h3 class="section-title" style="margin-top:28px;color:var(--danger)">Overdue Tasks</h3>
    <div class="upcoming-table">
      <div class="upcoming-table-head">
        <div class="upcoming-col-task">Task</div>
        <div class="upcoming-col-date">Due Date</div>
        <div class="upcoming-col-assign">Assignee</div>
        <div class="upcoming-col-priority">Priority</div>
        <div class="upcoming-col-recurrence">Recurrence</div>
        <div class="upcoming-col-actions"></div>
      </div>`;
    for (const item of overdueItems) {
      html += `<div class="upcoming-table-row upcoming-overdue">
        <div class="upcoming-col-task">
          <span class="upcoming-task-title">${esc(item.title)}</span>
          ${item.category ? `<span class="upcoming-task-cat">${esc(item.category)}</span>` : ''}
        </div>
        <div class="upcoming-col-date"><span class="upcoming-date overdue">${overdueDayLabel(item.date)}</span></div>
        <div class="upcoming-col-assign"><span style="font-size:12px">${esc(item.assignee || '-')}</span></div>
        <div class="upcoming-col-priority"><span class="badge ${priorityBadge(item.priority)}">${item.priority}</span></div>
        <div class="upcoming-col-recurrence"><span style="font-size:12px">${esc(item.recurrence)}</span></div>
        <div class="upcoming-col-actions">
          <button class="btn btn-primary btn-sm" style="font-size:11px;padding:2px 8px" onclick="quickComplete(${item.task_id},'${item.date}')">Complete</button>
        </div>
      </div>`;
    }
    html += '</div>';
  }

  // Upcoming section
  html += `<h3 class="section-title" style="margin-top:28px">Coming Up — Next 4 Weeks</h3>`;
  if (upcomingItems.length === 0) {
    html += '<div class="empty-state">No tasks scheduled in the next 4 weeks.</div>';
  } else {
    // Group by week
    const weeks = {};
    for (const item of upcomingItems) {
      const d = new Date(item.date + 'T00:00:00');
      const diffDays = Math.round((d - todayDate) / 86400000);
      const weekNum = diffDays < 7 ? 'This Week' : diffDays < 14 ? 'Next Week' : diffDays < 21 ? 'In 2 Weeks' : 'In 3 Weeks';
      if (!weeks[weekNum]) weeks[weekNum] = [];
      weeks[weekNum].push(item);
    }

    for (const [weekLabel, items] of Object.entries(weeks)) {
      html += `<div class="upcoming-group">
        <div class="upcoming-group-header">${weekLabel} <span class="req-cat-count">(${items.length})</span></div>
        <div class="upcoming-table">
          <div class="upcoming-table-head">
            <div class="upcoming-col-task">Task</div>
            <div class="upcoming-col-date">Due Date</div>
            <div class="upcoming-col-assign">Assignee</div>
            <div class="upcoming-col-priority">Priority</div>
            <div class="upcoming-col-recurrence">Recurrence</div>
            <div class="upcoming-col-actions"></div>
          </div>`;
      for (const item of items) {
        html += `<div class="upcoming-table-row">
          <div class="upcoming-col-task">
            <span class="upcoming-task-title">${esc(item.title)}</span>
            ${item.category ? `<span class="upcoming-task-cat">${esc(item.category)}</span>` : ''}
          </div>
          <div class="upcoming-col-date"><span class="upcoming-date">${dayLabel(item.date)}</span></div>
          <div class="upcoming-col-assign"><span style="font-size:12px">${esc(item.assignee || '-')}</span></div>
          <div class="upcoming-col-priority"><span class="badge ${priorityBadge(item.priority)}">${item.priority}</span></div>
          <div class="upcoming-col-recurrence"><span style="font-size:12px">${esc(item.recurrence)}</span></div>
          <div class="upcoming-col-actions">
            <button class="btn btn-secondary btn-sm" style="font-size:11px;padding:2px 8px" onclick="quickComplete(${item.task_id},'${item.date}')">Complete</button>
          </div>
        </div>`;
      }
      html += '</div></div>';
    }
  }

  upcomingEl.innerHTML = html;
}

async function quickComplete(taskId, dateStr) {
  await api('/api/completions', { method: 'POST', body: { task_id: taskId, completed_at: dateStr, notes: '' } });
  loadYearlyPlan();
}

let activePopover = null;

function showDayDetail(event, dateStr) {
  event.stopPropagation();
  closeDayDetail();
  if (!yearlyData) return;
  renderDayPopover(event, dateStr, yearlyData);
}

function renderDayPopover(event, dateStr, data) {
  const due = data.dueDates[dateStr] || [];
  const completed = data.completedDates[dateStr] || [];
  const today = new Date().toISOString().split('T')[0];

  const pop = document.createElement('div');
  pop.className = 'day-popover';

  let items = '';
  for (const t of completed) {
    items += `<div class="day-popover-item" style="border-left:3px solid var(--success)">
      <strong>${esc(t.title)}</strong>
      <div class="dpi-meta">Completed${t.completed_by ? ' by ' + esc(t.completed_by) : ''} &middot; ${esc(t.recurrence)} &middot; ${esc(t.assignee || 'Unassigned')}</div>
    </div>`;
  }
  for (const t of due) {
    const isOverdue = dateStr < today;
    const color = isOverdue ? 'var(--danger)' : 'var(--primary)';
    const label = isOverdue ? 'Overdue' : 'Scheduled';
    items += `<div class="day-popover-item" style="border-left:3px solid ${color}">
      <div style="display:flex;justify-content:space-between;align-items:start">
        <div>
          <strong>${esc(t.title)}</strong> <span class="badge badge-${t.priority.toLowerCase()}">${t.priority}</span>
          <div class="dpi-meta">${label} &middot; ${esc(t.recurrence)} &middot; ${esc(t.assignee || 'Unassigned')}</div>
        </div>
        <div style="margin-left:8px;flex-shrink:0">
          ${actionMenu([
            { label: '&#10003; Mark Done', onclick: `closeDayDetail();openCompleteModal(${t.task_id})`, cls: 'success' },
            { label: '&#9998; Edit', onclick: `closeDayDetail();openTaskModal(${t.task_id})` },
          ])}
        </div>
      </div>
    </div>`;
  }

  if (!items) items = '<div class="empty-state" style="padding:16px">No tasks on this date</div>';

  const formattedDate = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  pop.innerHTML = `
    <div class="day-popover-header">
      <h4>${formattedDate}</h4>
      <button class="modal-close" onclick="closeDayDetail()">&times;</button>
    </div>
    ${items}
  `;

  document.body.appendChild(pop);
  activePopover = pop;

  // Position near click
  const rect = event.target.getBoundingClientRect();
  let left = rect.right + 8;
  let top = rect.top;
  if (left + 330 > window.innerWidth) left = rect.left - 330;
  if (top + 400 > window.innerHeight) top = window.innerHeight - 410;
  if (top < 10) top = 10;
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', closeDayDetailOutside);
  }, 10);
}

function closeDayDetail() {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
  document.removeEventListener('click', closeDayDetailOutside);
}

function closeDayDetailOutside(e) {
  if (activePopover && !activePopover.contains(e.target)) {
    closeDayDetail();
  }
}

// --- Audit Module ---
let auditFilters = { status: '' };
let auditYear = new Date().getFullYear();

function changeAuditYear(delta) {
  if (delta === 0) auditYear = new Date().getFullYear();
  else auditYear += delta;
  loadAuditPlan();
}
let ncrFilters = { status: '', audit_id: '' };
let currentAuditId = null;

async function loadAuditPlan() {
  const params = new URLSearchParams();
  if (auditFilters.status) params.set('status', auditFilters.status);
  const audits = await api(`/api/audits?${params}`);
  renderAuditFilters();
  const list = document.getElementById('audit-list');
  if (audits.length === 0) {
    list.innerHTML = '<div class="empty-state">No audits planned yet. Create one to get started.</div>';
    return;
  }
  // Render audit timeline Gantt
  renderAuditGantt(audits);

  list.innerHTML = audits.map(a => {
    const recurrenceLabel = { monthly: 'Monthly', quarterly: 'Quarterly', 'semi-annual': 'Semi-Annual', annual: 'Annual' };
    const hasEvents = a.all_events && a.all_events.length > 0;
    const isRecurring = a.recurrence && a.recurrence !== 'none';

    // Calculate aggregate stats across all events
    const totalAssessed = a.all_events ? a.all_events.reduce((sum, e) => sum + (e.assessed_count || 0), 0) : a.assessed_count;
    const totalChecklist = a.all_events ? a.all_events.reduce((sum, e) => sum + (e.checklist_count || 0), 0) : a.checklist_count;
    const totalNc = a.all_events ? a.all_events.reduce((sum, e) => sum + (e.nc_count || 0), 0) : a.nc_count;
    const totalOpenNc = a.all_events ? a.all_events.reduce((sum, e) => sum + (e.open_nc_count || 0), 0) : a.open_nc_count;
    const completedEvents = a.all_events ? a.all_events.filter(e => e.status === 'completed').length : 0;
    const inProgressEvents = a.all_events ? a.all_events.filter(e => e.status === 'in_progress').length : 0;

    // Build ALL events section (including event #1 - the parent)
    let eventsHtml = '';
    if (hasEvents) {
      eventsHtml = `<div class="audit-children collapsed" id="audit-children-${a.id}">
        ${a.all_events.map(ev => {
          const evStatusCls = ev.status === 'completed' ? 'badge-low' : ev.status === 'in_progress' ? 'badge-medium' : ev.status === 'cancelled' ? 'badge-inactive' : 'badge-upcoming';
          return `<div class="audit-child-event">
            <div class="audit-child-main">
              <span class="audit-child-date">${ev.planned_date || 'No date'}</span>
              <span class="audit-child-instance">Event #${ev.instance_number || 1}</span>
              <span class="badge ${evStatusCls}">${ev.status.replace('_', ' ')}</span>
              <span class="audit-child-stats">${ev.assessed_count || 0}/${ev.checklist_count || 0} assessed</span>
            </div>
            <div class="audit-child-actions">
              ${ev.status === 'planned' ? `<button class="btn btn-secondary btn-sm" onclick="startAudit(${ev.id})">Start</button>` : ''}
              ${ev.status === 'in_progress' ? `<button class="btn btn-primary btn-sm" onclick="switchToExecute(${ev.id})">Execute</button>` : ''}
              ${ev.status === 'completed' ? `<button class="btn btn-secondary btn-sm" onclick="switchToExecute(${ev.id})">View</button>` : ''}
              <button class="btn btn-secondary btn-sm" onclick="openAuditModal(${ev.id})">Edit</button>
            </div>
          </div>`;
        }).join('')}
      </div>`;
    }

    return `<div class="audit-card${isRecurring ? ' audit-recurring' : ''}">
      <div class="audit-card-header">
        <div>
          <h3>${esc(a.title)}</h3>
          <div class="audit-meta">
            ${esc(a.standard)} &middot; Lead: ${esc(a.lead_auditor || 'Unassigned')}
            ${isRecurring ? ` &middot; <span class="audit-recurrence-badge">${recurrenceLabel[a.recurrence] || a.recurrence}</span>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${hasEvents ? `<button class="btn btn-secondary btn-sm" onclick="toggleAuditChildren(${a.id})"><span id="audit-toggle-${a.id}">&#9660;</span> ${a.total_instances} Event${a.total_instances !== 1 ? 's' : ''}</button>` : ''}
        </div>
      </div>
      ${a.scope ? `<div class="audit-scope">${esc(a.scope)}</div>` : ''}
      <div class="audit-card-footer">
        <div class="audit-stats">
          <span>${completedEvents}/${a.total_instances} completed</span>
          <span>${inProgressEvents} in progress</span>
          <span>${totalNc} NC${totalNc !== 1 ? 's' : ''}${totalOpenNc > 0 ? ` (${totalOpenNc} open)` : ''}</span>
        </div>
        ${actionMenu([
          { label: '&#128279; Links', onclick: `toggleAuditLinks(${a.id})` },
          { label: '&#9998; Edit Config', onclick: `openAuditModal(${a.id})` },
          'sep',
          { label: '&#128465; Delete All', onclick: `deleteAudit(${a.id})`, cls: 'danger' },
        ])}
      </div>
      ${eventsHtml}
      <div id="audit-links-${a.id}"></div>
    </div>`;
  }).join('');
}

function toggleAuditLinks(id) {
  const el = document.getElementById(`audit-links-${id}`);
  if (el.innerHTML) { el.innerHTML = ''; return; }
  renderCrossLinks('audit', id, `audit-links-${id}`);
}

function toggleAuditChildren(id) {
  const el = document.getElementById(`audit-children-${id}`);
  const toggle = document.getElementById(`audit-toggle-${id}`);
  if (el.classList.contains('collapsed')) {
    el.classList.remove('collapsed');
    toggle.innerHTML = '&#9650;';
  } else {
    el.classList.add('collapsed');
    toggle.innerHTML = '&#9660;';
  }
}

function renderAuditGantt(audits) {
  const wrap = document.getElementById('audit-gantt-wrap');
  const today = new Date().toISOString().split('T')[0];
  const todayDate = new Date(today + 'T12:00:00');
  const todayMonth = todayDate.getFullYear() === auditYear ? todayDate.getMonth() : -1;
  const todayDayOfMonth = todayDate.getDate();
  const shortMonths = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Flatten all audit events for the timeline (including all instances)
  const allEvents = [];
  for (const a of audits) {
    if (a.all_events && a.all_events.length > 0) {
      for (const ev of a.all_events) {
        allEvents.push({
          ...ev,
          parent_title: a.title,
          display_title: a.total_instances > 1 ? `${a.title} #${ev.instance_number || 1}` : a.title
        });
      }
    } else {
      allEvents.push({
        ...a,
        parent_title: a.title,
        display_title: a.title
      });
    }
  }

  // Filter events that fall within the selected year
  const yearEvents = allEvents.filter(ev => {
    const d = ev.planned_date || ev.created_at?.split(' ')[0];
    if (!d) return false;
    return d.startsWith(String(auditYear));
  });

  if (yearEvents.length === 0) {
    wrap.innerHTML = `<div class="empty-state" style="padding:20px">No audit events planned for ${auditYear}</div>`;
    return;
  }

  // Sort events by planned date
  yearEvents.sort((a, b) => (a.planned_date || '').localeCompare(b.planned_date || ''));

  let html = '<table class="gantt-table"><thead><tr><th>Audit Event</th>';
  for (let m = 0; m < 12; m++) html += `<th>${shortMonths[m]}</th>`;
  html += '</tr></thead><tbody>';

  for (const ev of yearEvents) {
    const plannedDate = ev.planned_date || ev.created_at?.split(' ')[0];
    const plannedMonth = plannedDate ? parseInt(plannedDate.split('-')[1]) - 1 : -1;
    const completedDate = ev.completed_date;
    const completedMonth = completedDate ? parseInt(completedDate.split('-')[1]) - 1 : -1;

    const statusColor = ev.status === 'completed' ? 'completed' : ev.status === 'in_progress' ? 'due' : ev.status === 'cancelled' ? '' : (plannedDate && plannedDate < today ? 'overdue' : 'due');

    html += `<tr><td title="${esc(ev.display_title)}">${esc(ev.display_title)}</td>`;
    for (let m = 0; m < 12; m++) {
      const daysInMonth = new Date(auditYear, m + 1, 0).getDate();
      html += '<td class="gantt-cell"><div class="gantt-bar">';
      if (m === todayMonth) {
        const pct = ((todayDayOfMonth - 0.5) / daysInMonth) * 100;
        html += `<div class="gantt-today-line" style="left:${pct}%"></div>`;
      }
      if (m === plannedMonth) {
        html += `<span class="gantt-dot ${statusColor}" title="Planned: ${plannedDate}"></span>`;
      }
      if (m === completedMonth && completedMonth !== plannedMonth) {
        html += `<span class="gantt-dot completed" title="Completed: ${completedDate}"></span>`;
      }
      html += '</div></td>';
    }
    html += '</tr>';
  }

  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function renderAuditFilters() {
  document.getElementById('audit-filters-bar').innerHTML = `
    <select onchange="auditFilters.status=this.value;loadAuditPlan()">
      <option value="" ${auditFilters.status===''?'selected':''}>All Status</option>
      <option value="planned" ${auditFilters.status==='planned'?'selected':''}>Planned</option>
      <option value="in_progress" ${auditFilters.status==='in_progress'?'selected':''}>In Progress</option>
      <option value="completed" ${auditFilters.status==='completed'?'selected':''}>Completed</option>
      <option value="cancelled" ${auditFilters.status==='cancelled'?'selected':''}>Cancelled</option>
    </select>`;
}

async function startAudit(id) {
  await api(`/api/audits/${id}`, { method: 'PUT', body: { status: 'in_progress' } });
  loadAuditPlan();
}

async function deleteAudit(id) {
  if (!confirm('Delete this audit and all its data?')) return;
  await api(`/api/audits/${id}`, { method: 'DELETE' });
  loadAuditPlan();
}

async function switchToExecute(id) {
  currentView = 'audit-execute';
  closeDayDetail();
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById('view-audit-execute').classList.remove('hidden');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const activeLink = document.querySelector('[data-view="audit-execute"]');
  if (activeLink) activeLink.classList.add('active');
  const parentSubmenu = activeLink?.closest('.module-submenu');
  if (parentSubmenu && !parentSubmenu.classList.contains('open')) {
    parentSubmenu.classList.add('open');
    parentSubmenu.previousElementSibling?.classList.remove('collapsed');
  }
  await loadAuditExecuteView();
  document.getElementById('audit-exec-select').value = String(id);
  loadAuditExecution(id);
}

async function openAuditModal(id) {
  const modal = document.getElementById('audit-modal');
  document.getElementById('audit-form').reset();
  document.getElementById('audit-id').value = '';
  document.getElementById('audit-modal-title').textContent = 'New Audit';
  document.getElementById('audit-status-group').classList.add('hidden');
  document.getElementById('audit-summary-group').classList.add('hidden');
  document.getElementById('audit-recurrence-end-group').classList.add('hidden');

  // Dynamically populate standards and other dropdowns
  const [activeStandards, archRoles, archProcesses] = await Promise.all([
    api('/api/requirements/standards'),
    api('/api/architecture?arch_type=role'),
    api('/api/architecture?arch_type=process'),
  ]);
  let editStandards = [];

  // Populate standards picker with checkboxes
  const stdPicker = document.getElementById('audit-standards-picker');
  stdPicker.innerHTML = activeStandards.length === 0
    ? '<span style="font-size:12px;color:var(--text-muted)">No standards imported. Import templates in Requirements view first.</span>'
    : activeStandards.map(s => `<label class="arch-picker-item"><input type="checkbox" name="audit-std" value="${esc(s)}" onchange="onAuditStandardsChange()"> ${esc(s)}</label>`).join('');

  // Populate lead auditor dropdown from roles
  const leadSel = document.getElementById('audit-lead');
  leadSel.innerHTML = '<option value="">-- Select Role --</option>' + archRoles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');

  // Populate scope processes as checkboxes with auto-select handler
  const scopeWrap = document.getElementById('audit-scope-processes');
  scopeWrap.innerHTML = archProcesses.length === 0
    ? '<span style="font-size:12px;color:var(--text-muted)">No processes defined in Architecture.</span>'
    : archProcesses.map(p => `<label class="arch-picker-item"><input type="checkbox" name="audit-scope-proc" value="${p.id}" data-name="${esc(p.name)}" onchange="onAuditProcessChange(this)"> ${esc(p.name)}</label>`).join('');

  // Populate auditee dropdown from roles
  const auditeeSel = document.getElementById('audit-auditee');
  auditeeSel.innerHTML = '<option value="">-- Select Role --</option>' + archRoles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');

  if (id) {
    const a = await api(`/api/audits/${id}`);
    try { editStandards = JSON.parse(a.standards || '[]'); } catch(e) { editStandards = a.standard ? [a.standard] : []; }
    document.getElementById('audit-modal-title').textContent = 'Edit Audit';
    document.getElementById('audit-id').value = a.id;
    document.getElementById('audit-title').value = a.title;
    leadSel.value = a.lead_auditor || '';
    auditeeSel.value = a.auditee || '';

    // Check standards
    editStandards.forEach(s => {
      const cb = stdPicker.querySelector(`input[value="${s}"]`);
      if (cb) cb.checked = true;
    });

    // Check scope processes from cross-links
    const auditLinks = await api(`/api/cross-links/audit/${id}`);
    auditLinks.filter(l => l.type === 'process').forEach(l => {
      const cb = scopeWrap.querySelector(`input[value="${l.id}"]`);
      if (cb) cb.checked = true;
    });
    document.getElementById('audit-planned-date').value = a.planned_date || '';
    document.getElementById('audit-recurrence').value = a.recurrence || 'none';
    if (a.recurrence && a.recurrence !== 'none') {
      document.getElementById('audit-recurrence-end-group').classList.remove('hidden');
      document.getElementById('audit-recurrence-end').value = a.recurrence_end_date || '';
    }
    document.getElementById('audit-status-field').value = a.status;
    document.getElementById('audit-summary').value = a.summary || '';
    document.getElementById('audit-status-group').classList.remove('hidden');
    document.getElementById('audit-summary-group').classList.remove('hidden');
  } else if (activeStandards.length > 0) {
    // Default to first standard for new audits
    const firstCb = stdPicker.querySelector('input[name="audit-std"]');
    if (firstCb) firstCb.checked = true;
  }

  // Load requirements picker based on selected standards
  await populateAuditReqPicker(id);

  modal.classList.remove('hidden');
}

function toggleAuditRecurrenceEnd() {
  const recurrence = document.getElementById('audit-recurrence').value;
  if (recurrence === 'none') {
    document.getElementById('audit-recurrence-end-group').classList.add('hidden');
  } else {
    document.getElementById('audit-recurrence-end-group').classList.remove('hidden');
  }
}

function onAuditStandardsChange() {
  const auditId = document.getElementById('audit-id').value;
  populateAuditReqPicker(auditId || null);
}

async function populateAuditReqPicker(auditId) {
  // Get all selected standards
  const selectedStandards = [...document.querySelectorAll('#audit-standards-picker input[name="audit-std"]:checked')].map(cb => cb.value);
  if (selectedStandards.length === 0) {
    document.getElementById('audit-req-checklist').innerHTML = '<div class="empty-state" style="padding:12px;font-size:13px">Select at least one standard to see requirements.</div>';
    document.getElementById('audit-req-count').textContent = '';
    auditReqProcessMap = {};
    return;
  }

  // Fetch requirements for all selected standards
  const allReqs = await api('/api/requirements');
  const reqs = allReqs.filter(r => selectedStandards.includes(r.standard));
  const container = document.getElementById('audit-req-checklist');

  // If editing, find which clauses already have checklist items
  let existingClauses = [];
  let existingStandards = [];
  if (auditId) {
    const audit = await api(`/api/audits/${auditId}`);
    existingClauses = audit.checklist.map(c => c.clause);
    existingStandards = audit.checklist.map(c => c.standard);
  }

  if (reqs.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:12px;font-size:13px">No requirements found for this standard. Import a template in the Requirements view first.</div>';
    document.getElementById('audit-req-count').textContent = '';
    auditReqProcessMap = {};
    return;
  }

  // Fetch cross-links for all requirements to build process mapping
  auditReqProcessMap = {};
  const linkPromises = reqs.map(async r => {
    const links = await api(`/api/cross-links/requirement/${r.id}`);
    const processIds = links.filter(l => l.type === 'process').map(l => l.id);
    if (processIds.length > 0) {
      auditReqProcessMap[r.id] = processIds;
    }
  });
  await Promise.all(linkPromises);

  // Group by standard first, then by category
  const standardGroups = {};
  for (const r of reqs) {
    if (!standardGroups[r.standard]) standardGroups[r.standard] = {};
    const cat = r.category || 'Uncategorized';
    if (!standardGroups[r.standard][cat]) standardGroups[r.standard][cat] = [];
    standardGroups[r.standard][cat].push(r);
  }

  let html = '';
  for (const [std, catGroups] of Object.entries(standardGroups)) {
    // Add standard header if multiple standards selected
    if (selectedStandards.length > 1) {
      html += `<div class="req-picker-standard" style="font-size:12px;font-weight:700;padding:8px 12px;background:var(--primary);color:#fff;position:sticky;top:0;z-index:2">${esc(std)}</div>`;
    }
    for (const [cat, items] of Object.entries(catGroups)) {
      html += `<div class="req-picker-category">${esc(cat)}</div>`;
      for (const r of items) {
        const alreadyAdded = existingClauses.includes(r.clause) && existingStandards.includes(r.standard);
        const linkedProcesses = auditReqProcessMap[r.id] || [];
        const processHint = linkedProcesses.length > 0 ? ` data-processes="${linkedProcesses.join(',')}"` : '';
        html += `<label class="req-picker-item${alreadyAdded ? ' already-added' : ''}"${processHint} data-standard="${esc(r.standard)}">
          <input type="checkbox" name="audit_req_ids" value="${r.id}" ${alreadyAdded ? 'disabled checked' : ''} onchange="updateAuditReqCount()">
          <span class="req-picker-clause">${esc(r.clause)}</span>
          <span class="req-picker-title">${esc(r.title)}</span>
          ${selectedStandards.length > 1 ? `<span style="font-size:9px;color:var(--text-muted);flex-shrink:0">[${esc(r.standard.replace('ISO ',''))}]</span>` : ''}
          ${linkedProcesses.length > 0 ? `<span style="font-size:10px;color:var(--primary);flex-shrink:0" title="Linked to process(es)">&#128260;</span>` : ''}
          ${alreadyAdded ? '<span class="badge badge-low" style="font-size:10px;flex-shrink:0">already added</span>' : ''}
        </label>`;
      }
    }
  }
  container.innerHTML = html;
  updateAuditReqCount();

  // Auto-select requirements for already checked processes
  document.querySelectorAll('#audit-scope-processes input[name="audit-scope-proc"]:checked').forEach(cb => {
    onAuditProcessChange(cb);
  });
}

function updateAuditReqCount() {
  const checked = document.querySelectorAll('#audit-req-checklist input[name="audit_req_ids"]:checked:not(:disabled)').length;
  const total = document.querySelectorAll('#audit-req-checklist input[name="audit_req_ids"]:not(:disabled)').length;
  document.getElementById('audit-req-count').textContent = `${checked} of ${total} selected`;
}

function auditReqSelectAll(select) {
  document.querySelectorAll('#audit-req-checklist input[name="audit_req_ids"]:not(:disabled)').forEach(cb => {
    cb.checked = select;
  });
  updateAuditReqCount();
}


// Store requirement-to-process mapping for auto-selection
let auditReqProcessMap = {}; // { reqId: [processId, ...] }

async function onAuditProcessChange(checkbox) {
  const processId = parseInt(checkbox.value);
  const isChecked = checkbox.checked;

  // Find all requirements linked to this process and auto-select/deselect them
  for (const [reqIdStr, processIds] of Object.entries(auditReqProcessMap)) {
    if (processIds.includes(processId)) {
      const reqCheckbox = document.querySelector(`#audit-req-checklist input[name="audit_req_ids"][value="${reqIdStr}"]:not(:disabled)`);
      if (reqCheckbox) {
        if (isChecked) {
          reqCheckbox.checked = true;
        }
        // Note: We don't auto-uncheck when process is deselected, as user may have manually selected it
      }
    }
  }
  updateAuditReqCount();
}

function closeAuditModal() {
  document.getElementById('audit-modal').classList.add('hidden');
}

async function saveAudit(e) {
  e.preventDefault();
  const id = document.getElementById('audit-id').value;
  const selectedStandards = [...document.querySelectorAll('#audit-standards-picker input[name="audit-std"]:checked')].map(cb => cb.value);
  if (selectedStandards.length === 0) {
    alert('Please select at least one standard.');
    return;
  }
  const body = {
    title: document.getElementById('audit-title').value,
    standards: selectedStandards,
    standard: selectedStandards[0], // Primary standard for backwards compatibility
    lead_auditor: document.getElementById('audit-lead').value,
    auditee: document.getElementById('audit-auditee').value,
    planned_date: document.getElementById('audit-planned-date').value || null,
    recurrence: document.getElementById('audit-recurrence').value,
    recurrence_end_date: document.getElementById('audit-recurrence-end').value || null,
  };

  // Collect selected requirement IDs (only non-disabled = new selections)
  const selectedReqIds = [...document.querySelectorAll('#audit-req-checklist input[name="audit_req_ids"]:checked:not(:disabled)')].map(cb => parseInt(cb.value));
  if (selectedReqIds.length > 0) {
    body.requirement_ids = selectedReqIds;
  }

  let auditId = id;
  if (id) {
    body.status = document.getElementById('audit-status-field').value;
    body.summary = document.getElementById('audit-summary').value;
    await api(`/api/audits/${id}`, { method: 'PUT', body });
  } else {
    const result = await api('/api/audits', { method: 'POST', body });
    auditId = result.id;
  }
  // Auto-link selected scope processes
  if (auditId) {
    const selectedProcs = [...document.querySelectorAll('#audit-scope-processes input[name="audit-scope-proc"]:checked')].map(cb => parseInt(cb.value));
    for (const procId of selectedProcs) {
      await api('/api/cross-links', { method: 'POST', body: { source_type: 'audit', source_id: parseInt(auditId), target_type: 'process', target_id: procId } });
    }
  }
  closeAuditModal();
  refreshCurrentView();
}

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
  await api(`/api/checklist/${itemId}`, { method: 'PUT', body: { [field]: value } });
  // Re-render on rating change so badge and Raise NCR button update
  if (field === 'rating' && currentAuditId) {
    loadAuditExecution(currentAuditId);
  }
}

// PDF Export for Audit Report
async function exportAuditPDF(auditId) {
  const audit = await api(`/api/audits/${auditId}`);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  // Colors
  const primaryColor = [99, 102, 241];
  const successColor = [16, 185, 129];
  const warningColor = [245, 158, 11];
  const dangerColor = [239, 68, 68];
  const textColor = [26, 26, 46];
  const mutedColor = [107, 122, 153];

  // Standards
  let auditStandards = [];
  try { auditStandards = JSON.parse(audit.standards || '[]'); } catch(e) { auditStandards = audit.standard ? [audit.standard] : []; }
  if (auditStandards.length === 0 && audit.standard) auditStandards = [audit.standard];

  // Stats
  const totalItems = audit.checklist.length;
  const assessed = audit.checklist.filter(c => c.rating !== 'not_assessed').length;
  const conforming = audit.checklist.filter(c => c.rating === 'conforming').length;
  const observations = audit.checklist.filter(c => c.rating === 'observation').length;
  const minorNc = audit.checklist.filter(c => c.rating === 'minor_nc').length;
  const majorNc = audit.checklist.filter(c => c.rating === 'major_nc').length;

  // Header with gradient-like effect
  doc.setFillColor(...primaryColor);
  doc.rect(0, 0, 210, 45, 'F');
  doc.setFillColor(118, 75, 162);
  doc.rect(0, 0, 210, 25, 'F');

  // Title
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(24);
  doc.setFont('helvetica', 'bold');
  doc.text('Audit Report', 15, 18);

  doc.setFontSize(12);
  doc.setFont('helvetica', 'normal');
  doc.text(audit.title, 15, 30);
  doc.setFontSize(10);
  doc.text(`Generated: ${new Date().toLocaleDateString()}`, 15, 38);

  // Company info on right
  doc.setFontSize(10);
  doc.text('Bop', 195, 18, { align: 'right' });
  doc.text('Business Orchestration Platform', 195, 25, { align: 'right' });

  let yPos = 55;

  // Audit Details Box
  doc.setDrawColor(...primaryColor);
  doc.setLineWidth(0.5);
  doc.roundedRect(15, yPos, 180, 35, 3, 3, 'S');

  doc.setTextColor(...textColor);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Audit Details', 20, yPos + 8);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...mutedColor);
  doc.text(`Standard${auditStandards.length > 1 ? 's' : ''}:`, 20, yPos + 17);
  doc.text('Lead Auditor:', 20, yPos + 25);
  doc.text('Auditee:', 110, yPos + 17);
  doc.text('Status:', 110, yPos + 25);

  doc.setTextColor(...textColor);
  doc.text(auditStandards.join(', '), 55, yPos + 17);
  doc.text(audit.lead_auditor || 'Unassigned', 55, yPos + 25);
  doc.text(audit.auditee || 'Unassigned', 135, yPos + 17);
  doc.text(audit.status.replace('_', ' ').toUpperCase(), 135, yPos + 25);

  yPos += 45;

  // Executive Summary Box
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(15, yPos, 180, 32, 3, 3, 'F');
  doc.setDrawColor(...primaryColor);
  doc.roundedRect(15, yPos, 180, 32, 3, 3, 'S');

  doc.setTextColor(...textColor);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Executive Summary', 20, yPos + 8);

  // Stats boxes
  const boxWidth = 32;
  const startX = 20;
  const statY = yPos + 15;

  // Total
  doc.setFillColor(240, 244, 255);
  doc.roundedRect(startX, statY, boxWidth, 12, 2, 2, 'F');
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...primaryColor);
  doc.text(String(totalItems), startX + boxWidth/2, statY + 8, { align: 'center' });
  doc.setFontSize(7);
  doc.setTextColor(...mutedColor);
  doc.text('TOTAL', startX + boxWidth/2, statY + 11.5, { align: 'center' });

  // Conforming
  doc.setFillColor(209, 250, 229);
  doc.roundedRect(startX + 36, statY, boxWidth, 12, 2, 2, 'F');
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...successColor);
  doc.text(String(conforming), startX + 36 + boxWidth/2, statY + 8, { align: 'center' });
  doc.setFontSize(7);
  doc.setTextColor(...mutedColor);
  doc.text('CONFORM', startX + 36 + boxWidth/2, statY + 11.5, { align: 'center' });

  // Observations
  doc.setFillColor(254, 243, 199);
  doc.roundedRect(startX + 72, statY, boxWidth, 12, 2, 2, 'F');
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...warningColor);
  doc.text(String(observations), startX + 72 + boxWidth/2, statY + 8, { align: 'center' });
  doc.setFontSize(7);
  doc.setTextColor(...mutedColor);
  doc.text('OBS', startX + 72 + boxWidth/2, statY + 11.5, { align: 'center' });

  // Minor NC
  doc.setFillColor(254, 226, 226);
  doc.roundedRect(startX + 108, statY, boxWidth, 12, 2, 2, 'F');
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...dangerColor);
  doc.text(String(minorNc), startX + 108 + boxWidth/2, statY + 8, { align: 'center' });
  doc.setFontSize(7);
  doc.setTextColor(...mutedColor);
  doc.text('MINOR NC', startX + 108 + boxWidth/2, statY + 11.5, { align: 'center' });

  // Major NC
  doc.setFillColor(237, 233, 254);
  doc.roundedRect(startX + 144, statY, boxWidth, 12, 2, 2, 'F');
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(139, 92, 246);
  doc.text(String(majorNc), startX + 144 + boxWidth/2, statY + 8, { align: 'center' });
  doc.setFontSize(7);
  doc.setTextColor(...mutedColor);
  doc.text('MAJOR NC', startX + 144 + boxWidth/2, statY + 11.5, { align: 'center' });

  yPos += 42;

  // Findings Table
  doc.setTextColor(...textColor);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Audit Findings', 15, yPos);
  yPos += 5;

  const ratingLabels = {
    not_assessed: 'Not Assessed',
    conforming: 'Conforming',
    observation: 'Observation',
    minor_nc: 'Minor NC',
    major_nc: 'Major NC'
  };

  const tableData = audit.checklist.map(item => [
    item.clause,
    item.standard || audit.standard,
    (item.requirement || '').substring(0, 40) + ((item.requirement || '').length > 40 ? '...' : ''),
    ratingLabels[item.rating] || item.rating,
    (item.finding || '-').substring(0, 50) + ((item.finding || '').length > 50 ? '...' : '')
  ]);

  doc.autoTable({
    startY: yPos,
    head: [['Clause', 'Standard', 'Requirement', 'Rating', 'Finding']],
    body: tableData,
    theme: 'striped',
    styles: {
      fontSize: 8,
      cellPadding: 3,
      overflow: 'linebreak',
      textColor: textColor
    },
    headStyles: {
      fillColor: primaryColor,
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8
    },
    columnStyles: {
      0: { cellWidth: 20 },
      1: { cellWidth: 25 },
      2: { cellWidth: 45 },
      3: { cellWidth: 25 },
      4: { cellWidth: 65 }
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252]
    },
    didParseCell: function(data) {
      if (data.column.index === 3 && data.section === 'body') {
        const rating = audit.checklist[data.row.index]?.rating;
        if (rating === 'conforming') data.cell.styles.textColor = successColor;
        else if (rating === 'observation') data.cell.styles.textColor = warningColor;
        else if (rating === 'minor_nc') data.cell.styles.textColor = dangerColor;
        else if (rating === 'major_nc') data.cell.styles.textColor = [139, 92, 246];
      }
    }
  });

  // Non-Conformities Section (if any)
  if (audit.non_conformities && audit.non_conformities.length > 0) {
    yPos = doc.lastAutoTable.finalY + 10;

    if (yPos > 250) {
      doc.addPage();
      yPos = 20;
    }

    doc.setTextColor(...textColor);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('Non-Conformity Reports (NCRs)', 15, yPos);
    yPos += 5;

    const ncrData = audit.non_conformities.map(nc => [
      nc.description?.substring(0, 60) + ((nc.description || '').length > 60 ? '...' : '') || '-',
      nc.root_cause?.substring(0, 40) + ((nc.root_cause || '').length > 40 ? '...' : '') || '-',
      nc.status?.replace('_', ' ').toUpperCase() || 'OPEN'
    ]);

    doc.autoTable({
      startY: yPos,
      head: [['Description', 'Root Cause', 'Status']],
      body: ncrData,
      theme: 'striped',
      styles: {
        fontSize: 8,
        cellPadding: 3,
        textColor: textColor
      },
      headStyles: {
        fillColor: dangerColor,
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 8
      },
      columnStyles: {
        0: { cellWidth: 80 },
        1: { cellWidth: 70 },
        2: { cellWidth: 30 }
      },
      alternateRowStyles: {
        fillColor: [254, 242, 242]
      }
    });
  }

  // Footer
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(...mutedColor);
    doc.text(`Page ${i} of ${pageCount}`, 105, 290, { align: 'center' });
    doc.text('Generated by Bop', 15, 290);
    doc.text(new Date().toISOString().split('T')[0], 195, 290, { align: 'right' });
  }

  // Save
  const filename = `Audit_Report_${audit.title.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.pdf`;
  doc.save(filename);
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
  const fileInput = document.getElementById(`cl-evidence-file-${itemId}`);
  if (!fileInput.files.length) return;

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);

  await fetch(`/api/checklist/${itemId}/evidence`, { method: 'POST', body: formData });
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

// --- Non-Conformities View ---
async function loadNcrs() {
  const params = new URLSearchParams();
  if (ncrFilters.status) params.set('status', ncrFilters.status);
  if (ncrFilters.audit_id) params.set('audit_id', ncrFilters.audit_id);
  const ncrs = await api(`/api/ncrs?${params}`);
  await renderNcrFilters();
  renderNcrTable(ncrs);
}

async function renderNcrFilters() {
  const audits = await api('/api/audits');
  document.getElementById('ncr-filters-bar').innerHTML = `
    <select onchange="ncrFilters.status=this.value;loadNcrs()">
      <option value="" ${ncrFilters.status===''?'selected':''}>All Status</option>
      <option value="open" ${ncrFilters.status==='open'?'selected':''}>Open</option>
      <option value="in_progress" ${ncrFilters.status==='in_progress'?'selected':''}>In Progress</option>
      <option value="closed" ${ncrFilters.status==='closed'?'selected':''}>Closed</option>
      <option value="verified" ${ncrFilters.status==='verified'?'selected':''}>Verified</option>
    </select>
    <select onchange="ncrFilters.audit_id=this.value;loadNcrs()">
      <option value="">All Audits</option>
      ${audits.map(a => `<option value="${a.id}" ${ncrFilters.audit_id==a.id?'selected':''}>${esc(a.title)}</option>`).join('')}
    </select>`;
}

function renderNcrTable(ncrs) {
  const tbody = document.getElementById('ncr-table-body');
  const today = new Date().toISOString().split('T')[0];
  if (ncrs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No non-conformities found</td></tr>';
    return;
  }
  tbody.innerHTML = ncrs.map(n => {
    const sevBadge = n.severity === 'major' ? 'badge-critical' : 'badge-high';
    const stBadge = n.status === 'open' ? 'badge-high' : n.status === 'in_progress' ? 'badge-medium' : 'badge-low';
    const isOverdue = n.due_date && n.due_date < today && (n.status === 'open' || n.status === 'in_progress');
    return `<tr>
      <td><strong style="cursor:pointer;color:var(--primary)" onclick="openNcrModal(${n.id})">${esc(n.description.substring(0, 80))}${n.description.length > 80 ? '...' : ''}</strong>
        <div id="ncr-links-${n.id}"></div>
      </td>
      <td><span class="badge badge-inactive" style="font-size:11px">${esc(n.ncr_standard || n.audit_standard || '-')}</span></td>
      <td>${esc(n.audit_title)}</td>
      <td>${esc(n.clause || '-')}</td>
      <td><span class="badge ${sevBadge}">${n.severity.charAt(0).toUpperCase() + n.severity.slice(1)}</span></td>
      <td>${esc(n.responsible || '-')}</td>
      <td>${n.due_date ? (isOverdue ? '<span style="color:var(--danger);font-weight:600">' + n.due_date + '</span>' : n.due_date) : '-'}</td>
      <td><span class="badge ${stBadge}">${n.status.replace(/_/g, ' ')}</span></td>
      <td>${actionMenu([
        ...(n.status === 'open' ? [{ label: '&#9654; Start', onclick: `updateNcrStatus(${n.id},'in_progress')`, cls: 'primary' }] : []),
        ...(n.status === 'in_progress' ? [{ label: '&#10003; Close', onclick: `updateNcrStatus(${n.id},'closed')`, cls: 'success' }] : []),
        ...(n.status === 'closed' ? [{ label: '&#10003; Verify', onclick: `updateNcrStatus(${n.id},'verified')`, cls: 'success' }] : []),
        { label: '&#128279; Links', onclick: `toggleNcrLinks(${n.id})` },
        { label: '&#9998; Edit', onclick: `openNcrModal(${n.id})` },
        'sep',
        { label: '&#128465; Delete', onclick: `deleteNcr(${n.id})`, cls: 'danger' },
      ])}</td>
    </tr>`;
  }).join('');
}

function toggleNcrLinks(id) {
  const el = document.getElementById(`ncr-links-${id}`);
  if (el.innerHTML) { el.innerHTML = ''; return; }
  renderCrossLinks('ncr', id, `ncr-links-${id}`);
}

async function updateNcrStatus(id, status) {
  await api(`/api/ncrs/${id}`, { method: 'PUT', body: { status } });
  refreshCurrentView();
}

async function deleteNcr(id) {
  if (!confirm('Delete this non-conformity?')) return;
  await api(`/api/ncrs/${id}`, { method: 'DELETE' });
  refreshCurrentView();
}

async function openNcrModal(id) {
  const modal = document.getElementById('ncr-modal');
  document.getElementById('ncr-form').reset();
  document.getElementById('ncr-id').value = '';
  document.getElementById('ncr-checklist-item-id').value = '';
  document.getElementById('ncr-modal-title').textContent = 'New Non-Conformity';
  document.getElementById('ncr-status-row').classList.add('hidden');

  // Populate audit dropdown — flatten all events for recurring audits
  const audits = await api('/api/audits');
  const allAuditEvents = [];
  for (const a of audits) {
    if (a.all_events && a.all_events.length > 0) {
      for (const ev of a.all_events) {
        if (ev.status !== 'cancelled') {
          allAuditEvents.push({ id: ev.id, label: a.total_instances > 1 ? `${a.title} — Event #${ev.instance_number || 1} (${ev.planned_date || 'No date'})` : a.title });
        }
      }
    } else {
      allAuditEvents.push({ id: a.id, label: a.title });
    }
  }
  document.getElementById('ncr-audit-id').innerHTML = '<option value="">-- Select Audit --</option>' + allAuditEvents.map(e =>
    `<option value="${e.id}">${esc(e.label)}</option>`
  ).join('');

  // Populate clause datalist from requirements
  const allReqs = await api('/api/requirements');
  document.getElementById('ncr-clause-list').innerHTML = allReqs.map(r =>
    `<option value="${esc(r.clause)} - ${esc(r.title)}">`
  ).join('');

  if (id) {
    const allNcrs = await api('/api/ncrs');
    const ncrData = allNcrs.find(x => x.id === id);
    if (ncrData) {
      document.getElementById('ncr-modal-title').textContent = 'Edit Non-Conformity';
      document.getElementById('ncr-id').value = ncrData.id;
      document.getElementById('ncr-audit-id').value = ncrData.audit_id;
      document.getElementById('ncr-clause').value = ncrData.clause || '';
      document.getElementById('ncr-severity').value = ncrData.severity;
      document.getElementById('ncr-description').value = ncrData.description;
      document.getElementById('ncr-root-cause').value = ncrData.root_cause || '';
      document.getElementById('ncr-correction').value = ncrData.correction || '';
      document.getElementById('ncr-corrective-action').value = ncrData.corrective_action || '';
      document.getElementById('ncr-responsible').value = ncrData.responsible || '';
      document.getElementById('ncr-due-date').value = ncrData.due_date || '';
      document.getElementById('ncr-status-field').value = ncrData.status;
      document.getElementById('ncr-verification-notes').value = ncrData.verification_notes || '';
      document.getElementById('ncr-status-row').classList.remove('hidden');
    }
  }
  modal.classList.remove('hidden');
}

function closeNcrModal() {
  document.getElementById('ncr-modal').classList.add('hidden');
}

async function saveNcr(e) {
  e.preventDefault();
  const id = document.getElementById('ncr-id').value;
  const body = {
    audit_id: parseInt(document.getElementById('ncr-audit-id').value),
    clause: document.getElementById('ncr-clause').value,
    description: document.getElementById('ncr-description').value,
    severity: document.getElementById('ncr-severity').value,
    root_cause: document.getElementById('ncr-root-cause').value,
    correction: document.getElementById('ncr-correction').value,
    corrective_action: document.getElementById('ncr-corrective-action').value,
    responsible: document.getElementById('ncr-responsible').value,
    due_date: document.getElementById('ncr-due-date').value || null,
  };
  if (id) {
    body.status = document.getElementById('ncr-status-field').value;
    body.verification_notes = document.getElementById('ncr-verification-notes').value;
    await api(`/api/ncrs/${id}`, { method: 'PUT', body });
  } else {
    body.checklist_item_id = document.getElementById('ncr-checklist-item-id').value || null;
    await api('/api/ncrs', { method: 'POST', body });
  }
  closeNcrModal();
  refreshCurrentView();
}

// --- Gantt Chart ---
function renderGanttChart(data, monthStats, today) {
  const wrap = document.getElementById('gantt-wrap');
  // Collect all unique tasks across the year
  const taskMap = {};
  for (let m = 0; m < 12; m++) {
    for (const t of Object.values(monthStats[m].taskDates)) {
      if (!taskMap[t.task_id]) {
        taskMap[t.task_id] = { task_id: t.task_id, title: t.title, priority: t.priority, assignee: t.assignee, recurrence: t.recurrence, months: {} };
      }
      if (!taskMap[t.task_id].months[m]) taskMap[t.task_id].months[m] = [];
      for (const d of t.dates) {
        taskMap[t.task_id].months[m].push(d);
      }
    }
  }

  const tasks = Object.values(taskMap);
  if (tasks.length === 0) {
    wrap.innerHTML = '<div class="empty-state" style="padding:20px">No tasks to display in timeline</div>';
    return;
  }

  // Sort by title
  tasks.sort((a, b) => a.title.localeCompare(b.title));

  // Determine today position for the marker
  const todayDate = new Date(today + 'T12:00:00');
  const todayMonth = todayDate.getFullYear() === yearlyYear ? todayDate.getMonth() : -1;
  const todayDayOfMonth = todayDate.getDate();

  // Build table
  let html = '<table class="gantt-table"><thead><tr><th>Task</th>';
  const shortMonths = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  for (let m = 0; m < 12; m++) {
    html += `<th>${shortMonths[m]}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (const task of tasks) {
    html += `<tr><td title="${esc(task.title)}">${esc(task.title)}</td>`;
    for (let m = 0; m < 12; m++) {
      const daysInMonth = new Date(yearlyYear, m + 1, 0).getDate();
      const dates = task.months[m] || [];
      html += '<td class="gantt-cell"><div class="gantt-bar">';
      // Today marker
      if (m === todayMonth) {
        const pct = ((todayDayOfMonth - 0.5) / daysInMonth) * 100;
        html += `<div class="gantt-today-line" style="left:${pct}%"></div>`;
      }
      for (const d of dates) {
        html += `<span class="gantt-dot ${d.type}" title="${d.date}"></span>`;
      }
      html += '</div></td>';
    }
    html += '</tr>';
  }

  html += '</tbody></table>';
  wrap.innerHTML = html;
}

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

async function loadRequirements() {
  const params = new URLSearchParams();
  if (reqFilters.standard) params.set('standard', reqFilters.standard);
  const reqs = await api(`/api/requirements?${params}`);
  const standards = await api('/api/requirements/standards');

  // Prefetch cross-links for all requirements
  const allLinks = {};
  await Promise.all(reqs.map(async r => { allLinks[r.id] = await api(`/api/cross-links/requirement/${r.id}`); }));

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

  // Stats
  const statsEl = document.getElementById('req-stats');
  statsEl.innerHTML = `
    <div class="req-stats-grid">
      <div class="stat-card"><div class="stat-value">${reqs.length}</div><div class="stat-label">Total Requirements</div></div>
      <div class="stat-card"><div class="stat-value">${standards.length}</div><div class="stat-label">Standards</div></div>
      <div class="stat-card"><div class="stat-value">${Object.keys(groups).length}</div><div class="stat-label">Categories</div></div>
    </div>`;

  // List
  const list = document.getElementById('req-list');
  if (reqs.length === 0) {
    list.innerHTML = '<div class="empty-state">No requirements yet. Add manually or import a standard template.</div>';
    return;
  }

  let html = '';
  for (const [cat, items] of Object.entries(groups)) {
    items.sort((a, b) => a.clause.localeCompare(b.clause, undefined, { numeric: true }));
    html += `<div class="req-category-group">
      <div class="req-category-header">${esc(cat)} <span class="req-cat-count">(${items.length})</span></div>
      <div class="req-table">
        <div class="req-table-head">
          <div class="req-col-clause">Clause</div>
          <div class="req-col-title">Requirement</div>
          <div class="req-col-audit">Last Audit</div>
          <div class="req-col-nc">NCs</div>
          <div class="req-col-links">Links</div>
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

      // Build links column: show processes inline, rest behind collapse
      const links = allLinks[r.id] || [];
      const processLinks = links.filter(l => l.type === 'process');
      const otherLinks = links.filter(l => l.type !== 'process');
      const collapseId = `req-cl-${r.id}`;
      let linksHtml;
      if (links.length === 0) {
        linksHtml = '<span style="color:var(--text-muted);font-size:11px">-</span>';
      } else {
        const procLabel = processLinks.length > 0 ? processLinks.map(l => esc(l.name)).join(', ') : '';
        const otherCount = otherLinks.length;
        linksHtml = `<span style="font-size:12px;cursor:pointer" onclick="document.getElementById('${collapseId}').classList.toggle('collapsed');this.querySelector('.cl-toggle-icon').textContent=document.getElementById('${collapseId}').classList.contains('collapsed')?'+':'−'">`;
        if (procLabel) linksHtml += procLabel;
        if (otherCount > 0) linksHtml += `${procLabel ? ' ' : ''}<span style="color:var(--text-muted)">(+${otherCount})</span>`;
        linksHtml += ` <span class="cl-toggle-icon">+</span></span>`;
      }

      html += `<div class="req-table-row">
          <div class="req-col-clause" style="cursor:pointer" onclick="openRequirementModal(${r.id})"><span class="req-clause">${esc(r.clause)}</span></div>
          <div class="req-col-title" style="cursor:pointer" onclick="openRequirementModal(${r.id})">
            <span class="req-title" style="color:var(--primary)">${esc(r.title)}</span>
            ${r.description ? `<span class="req-desc">${esc(r.description)}</span>` : ''}
          </div>
          <div class="req-col-audit">${lastAuditLabel}</div>
          <div class="req-col-nc">${ncBadge}</div>
          <div class="req-col-links">${linksHtml}</div>
          <div class="req-col-actions">
            ${actionMenu([
              { label: '&#128279; Link Items', onclick: `openCrossLinkPicker('requirement',${r.id},'req-expand-${r.id}')` },
              { label: '&#9998; Edit', onclick: `openRequirementModal(${r.id})` },
              'sep',
              { label: '&#128465; Delete', onclick: `deleteRequirement(${r.id})`, cls: 'danger' },
            ])}
          </div>
        </div>
        <div id="req-expand-${r.id}" class="req-expand-row">
          <div id="${collapseId}" class="req-links-detail collapsed">
            ${links.length > 0 ? buildInlineLinksDetail(links, 'requirement', r.id, `req-expand-${r.id}`) : ''}
          </div>
        </div>`;
    }
    html += '</div></div>';
  }
  list.innerHTML = html;
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
      // Annex A - AI Controls
      { clause: 'A.2', title: 'AI policies', category: 'Annex A - AI Controls' },
      { clause: 'A.3', title: 'Internal organization for AI', category: 'Annex A - AI Controls' },
      { clause: 'A.4', title: 'Resources for AI systems', category: 'Annex A - AI Controls' },
      { clause: 'A.5', title: 'Assessing impacts of AI systems', category: 'Annex A - AI Controls' },
      { clause: 'A.6', title: 'AI system life cycle', category: 'Annex A - AI Controls' },
      { clause: 'A.6.1', title: 'AI system life cycle management', category: 'Annex A - AI Controls' },
      { clause: 'A.6.2', title: 'AI system requirements and design', category: 'Annex A - AI Controls' },
      { clause: 'A.6.3', title: 'Data for AI systems', category: 'Annex A - AI Controls' },
      { clause: 'A.6.4', title: 'AI model building and validation', category: 'Annex A - AI Controls' },
      { clause: 'A.6.5', title: 'AI system verification and validation', category: 'Annex A - AI Controls' },
      { clause: 'A.6.6', title: 'AI system deployment', category: 'Annex A - AI Controls' },
      { clause: 'A.6.7', title: 'AI system operation and monitoring', category: 'Annex A - AI Controls' },
      { clause: 'A.6.8', title: 'AI system retirement', category: 'Annex A - AI Controls' },
      { clause: 'A.7', title: 'Data management', category: 'Annex A - AI Controls' },
      { clause: 'A.8', title: 'Technology and AI system monitoring', category: 'Annex A - AI Controls' },
      { clause: 'A.9', title: 'Third-party and customer relationships', category: 'Annex A - AI Controls' },
      { clause: 'A.9.1', title: 'Use of AI as third-party or customer', category: 'Annex A - AI Controls' },
      { clause: 'A.9.2', title: 'Supplying AI to third parties', category: 'Annex A - AI Controls' },
      { clause: 'A.9.3', title: 'Responsible provision of AI', category: 'Annex A - AI Controls' },
      { clause: 'A.9.4', title: 'AI system end-user communication', category: 'Annex A - AI Controls' },
      { clause: 'A.10', title: 'Documentation and record management for AI', category: 'Annex A - AI Controls' },
      // Annex B - AI implementation guidance
      { clause: 'B.2', title: 'AI policy objectives', category: 'Annex B - Implementation Guidance' },
      { clause: 'B.3', title: 'Roles and responsibilities for AI', category: 'Annex B - Implementation Guidance' },
      { clause: 'B.4', title: 'AI resources and competence', category: 'Annex B - Implementation Guidance' },
      { clause: 'B.5', title: 'Impact assessment process', category: 'Annex B - Implementation Guidance' },
      { clause: 'B.6', title: 'AI system life cycle processes', category: 'Annex B - Implementation Guidance' },
      { clause: 'B.7', title: 'Data for AI systems guidance', category: 'Annex B - Implementation Guidance' },
      { clause: 'B.8', title: 'Monitoring and measurement of AI systems', category: 'Annex B - Implementation Guidance' },
      { clause: 'B.9', title: 'Third-party relationship management', category: 'Annex B - Implementation Guidance' },
      { clause: 'B.10', title: 'AI documentation and information management', category: 'Annex B - Implementation Guidance' },
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

  // Stats
  const totalNew = feeds.reduce((s, f) => s + f.new_count, 0);
  const totalItems = feeds.reduce((s, f) => s + f.item_count, 0);
  document.getElementById('ti-stats').innerHTML = `
    <div class="stats-grid" style="margin-bottom:20px">
      <div class="stat-card"><div class="stat-value">${feeds.length}</div><div class="stat-label">Active Feeds</div></div>
      <div class="stat-card${totalNew > 0 ? ' overdue' : ''}"><div class="stat-value">${totalNew}</div><div class="stat-label">New Threats</div></div>
      <div class="stat-card"><div class="stat-value">${totalItems}</div><div class="stat-label">Total Items</div></div>
      <div class="stat-card"><div class="stat-value">${feeds.filter(f => f.tier === 1).length}</div><div class="stat-label">Tier 1 Feeds</div></div>
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

// --- Risk Management Module ---
let riskFilters = { status: '', category: '' };

// Standard to risk category mapping
const standardToCategoryMap = {
  'ISO 9001': 'Quality',
  'ISO 14001': 'Environment',
  'ISO 45001': 'Health & Safety',
  'ISO 27001': 'Information Security',
  'ISO 27001 Annex A': 'Information Security',
  'ISO 22000': 'Food Safety',
  'ISO 42001': 'AI',
  'ISO 42001:2023': 'AI',
};

async function getRiskCategoriesFromStandards() {
  const standards = await api('/api/requirements/standards');
  const categories = new Set();
  for (const std of standards) {
    const cat = standardToCategoryMap[std];
    if (cat) categories.add(cat);
  }
  // Always include some defaults if no standards selected
  if (categories.size === 0) {
    categories.add('Information Security');
    categories.add('Operational');
  }
  return [...categories].sort();
}

function riskScoreClass(score) {
  if (score >= 20) return 'risk-critical';
  if (score >= 15) return 'risk-high';
  if (score >= 8) return 'risk-medium';
  return 'risk-low';
}
function riskScoreLabel(score) {
  if (score >= 20) return 'Critical';
  if (score >= 15) return 'High';
  if (score >= 8) return 'Medium';
  return 'Low';
}

async function loadRiskIdentification() {
  const params = new URLSearchParams();
  if (riskFilters.status) params.set('status', riskFilters.status);
  if (riskFilters.category) params.set('category', riskFilters.category);
  const risks = await api(`/api/risks?${params}`);

  // Prefetch cross-links
  const allLinks = {};
  await Promise.all(risks.map(async r => { allLinks[r.id] = await api(`/api/cross-links/risk/${r.id}`); }));

  // Filters
  const categories = [...new Set(risks.map(r => r.category).filter(Boolean))];
  document.getElementById('risk-filters-bar').innerHTML = `
    <select onchange="riskFilters.status=this.value;loadRiskIdentification()">
      <option value="">All Status</option>
      <option value="identified" ${riskFilters.status==='identified'?'selected':''}>Identified</option>
      <option value="analyzing" ${riskFilters.status==='analyzing'?'selected':''}>Analyzing</option>
      <option value="treating" ${riskFilters.status==='treating'?'selected':''}>Treating</option>
      <option value="accepted" ${riskFilters.status==='accepted'?'selected':''}>Accepted</option>
      <option value="closed" ${riskFilters.status==='closed'?'selected':''}>Closed</option>
    </select>
    <select onchange="riskFilters.category=this.value;loadRiskIdentification()">
      <option value="">All Categories</option>
      ${categories.map(c => `<option value="${esc(c)}" ${riskFilters.category===c?'selected':''}>${esc(c)}</option>`).join('')}
    </select>
    <span style="font-size:13px;color:var(--text-muted)">${risks.length} risk${risks.length!==1?'s':''}</span>`;

  // Risk matrix (5x5 heat map)
  let matrix = '<h3 class="section-title" style="margin-bottom:8px">Risk Heat Map</h3>';
  matrix += '<table class="risk-matrix"><thead><tr><th></th>';
  for (let i = 1; i <= 5; i++) matrix += `<th>Impact ${i}</th>`;
  matrix += '</tr></thead><tbody>';
  for (let l = 5; l >= 1; l--) {
    matrix += `<tr><td class="rm-label">Likelihood ${l}</td>`;
    for (let i = 1; i <= 5; i++) {
      const score = l * i;
      const cls = riskScoreClass(score);
      const count = risks.filter(r => r.likelihood === l && r.impact === i).length;
      matrix += `<td class="rm-cell ${cls}">${count > 0 ? count : ''}</td>`;
    }
    matrix += '</tr>';
  }
  matrix += '</tbody></table>';
  document.getElementById('risk-matrix-wrap').innerHTML = matrix;

  // Risk Register table
  const list = document.getElementById('risk-list');
  if (risks.length === 0) {
    list.innerHTML = '<div class="empty-state">No risks identified yet. Add one to get started.</div>';
    return;
  }

  let html = '<h3 class="section-title" style="margin-top:20px">Risk Register</h3>';
  html += `<div class="risk-table">
    <div class="risk-table-head">
      <div class="risk-col-title">Risk</div>
      <div class="risk-col-cat">Category</div>
      <div class="risk-col-owner">Owner</div>
      <div class="risk-col-score">Score</div>
      <div class="risk-col-status">Status</div>
      <div class="risk-col-treat">Treatments</div>
      <div class="risk-col-links">Links</div>
      <div class="risk-col-actions"></div>
    </div>`;

  for (const r of risks) {
    const cls = riskScoreClass(r.inherent_score);
    const stBadge = r.status === 'closed' ? 'badge-low' : r.status === 'accepted' ? 'badge-medium' : r.status === 'treating' ? 'badge-medium' : r.status === 'analyzing' ? 'badge-medium' : 'badge-high';
    const links = allLinks[r.id] || [];
    const linkCount = links.length;
    const collapseId = `risk-cl-${r.id}`;

    html += `<div class="risk-table-row">
        <div class="risk-col-title" style="cursor:pointer" onclick="openRiskModal(${r.id})">
          <span class="risk-row-title" style="color:var(--primary)">${esc(r.title)}</span>
          ${r.asset ? `<span class="risk-row-sub">Asset: ${esc(r.asset)}</span>` : ''}
        </div>
        <div class="risk-col-cat"><span style="font-size:12px">${esc(r.category || '-')}</span></div>
        <div class="risk-col-owner"><span style="font-size:12px">${esc(r.risk_owner || '-')}</span></div>
        <div class="risk-col-score"><span class="badge risk-score-badge ${cls}">${r.inherent_score}</span></div>
        <div class="risk-col-status"><span class="badge ${stBadge}">${r.status.charAt(0).toUpperCase() + r.status.slice(1)}</span></div>
        <div class="risk-col-treat">${r.treatment_count > 0 ? `<span style="font-size:12px">${r.treatment_count}${r.open_treatments > 0 ? ` (${r.open_treatments} open)` : ''}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}</div>
        <div class="risk-col-links">
          ${linkCount > 0 ? `<span style="cursor:pointer;font-size:12px" onclick="document.getElementById('${collapseId}').classList.toggle('collapsed');this.querySelector('.cl-toggle-icon').textContent=document.getElementById('${collapseId}').classList.contains('collapsed')?'+':'−'">${linkCount} linked <span class="cl-toggle-icon">+</span></span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}
        </div>
        <div class="risk-col-actions">
          ${actionMenu([
            { label: '&#128736; Add Treatment', onclick: `openTreatmentModalForRisk(${r.id})` },
            { label: '&#128279; Link Items', onclick: `openCrossLinkPicker('risk',${r.id},'risk-expand-${r.id}')` },
            { label: '&#9998; Edit', onclick: `openRiskModal(${r.id})` },
            'sep',
            { label: '&#128465; Delete', onclick: `deleteRisk(${r.id})`, cls: 'danger' },
          ])}
        </div>
      </div>
      <div id="risk-expand-${r.id}" class="risk-expand-row">
        <div id="${collapseId}" class="risk-links-detail collapsed">
          ${linkCount === 0 ? '' : buildInlineLinksDetail(links, 'risk', r.id, `risk-expand-${r.id}`)}
        </div>
      </div>`;
  }
  html += '</div>';
  list.innerHTML = html;
}

function buildInlineLinksDetail(links, entityType, entityId, containerId) {
  const typeIcons = {};
  const typeLabels = {};
  for (const [k, v] of Object.entries(linkableTypes)) { typeIcons[k] = v.icon; typeLabels[k] = v.label; }
  const grouped = {};
  for (const l of links) { if (!grouped[l.type]) grouped[l.type] = []; grouped[l.type].push(l); }
  let html = '';
  for (const [type, items] of Object.entries(grouped)) {
    html += `<div class="cross-link-group"><span class="cross-link-group-label">${typeIcons[type] || ''} ${typeLabels[type] || type}s</span>`;
    for (const item of items) {
      const viewTarget = getViewForType(item.type, item.id);
      html += `<div class="cross-link-item">
        <span class="cross-link-name"${viewTarget ? ` onclick="${viewTarget}" style="cursor:pointer;text-decoration:underline"` : ''}>${esc(item.name)}</span>
        <button class="cross-link-remove" onclick="removeCrossLink(${item.link_id},'${entityType}',${entityId},'${containerId}');setTimeout(()=>refreshCurrentView(),300)" title="Remove link">&times;</button>
      </div>`;
    }
    html += '</div>';
  }
  return html;
}

async function openRiskModal(id) {
  const modal = document.getElementById('risk-modal');
  document.getElementById('risk-form').reset();
  document.getElementById('risk-id').value = '';
  document.getElementById('risk-modal-title').textContent = 'New Risk';
  document.getElementById('risk-status-group').classList.add('hidden');

  // Populate architecture dropdowns and category from standards
  const [roles, systems, assets, processes, facilities, riskCategories] = await Promise.all([
    api('/api/architecture?arch_type=role'),
    api('/api/architecture?arch_type=system'),
    api('/api/architecture?arch_type=asset'),
    api('/api/architecture?arch_type=process'),
    api('/api/architecture?arch_type=facility'),
    getRiskCategoriesFromStandards(),
  ]);

  // Populate category dropdown from standards
  const catSel = document.getElementById('risk-category');
  catSel.innerHTML = '<option value="">-- Select --</option>' + riskCategories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (riskCategories.length > 0) catSel.value = riskCategories[0]; // Default to first category

  const ownerSel = document.getElementById('risk-owner');
  ownerSel.innerHTML = '<option value="">-- Select Role --</option>' + roles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
  const assetSel = document.getElementById('risk-asset');
  assetSel.innerHTML = '<option value="">-- Select --</option>'
    + (systems.length > 0 ? `<optgroup label="Systems">${systems.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('')}</optgroup>` : '')
    + (assets.length > 0 ? `<optgroup label="Assets">${assets.map(a => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join('')}</optgroup>` : '');
  const procSel = document.getElementById('risk-process');
  procSel.innerHTML = '<option value="">-- None --</option>' + processes.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const facSel = document.getElementById('risk-facility');
  facSel.innerHTML = '<option value="">-- None --</option>' + facilities.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');

  if (id) {
    const r = await api(`/api/risks/${id}`);
    document.getElementById('risk-modal-title').textContent = 'Edit Risk';
    document.getElementById('risk-id').value = r.id;
    document.getElementById('risk-title').value = r.title;
    document.getElementById('risk-description').value = r.description;
    document.getElementById('risk-category').value = r.category;
    ownerSel.value = r.risk_owner || '';
    assetSel.value = r.asset || '';
    document.getElementById('risk-source').value = r.source;
    document.getElementById('risk-threat').value = r.threat;
    document.getElementById('risk-vulnerability').value = r.vulnerability;
    document.getElementById('risk-likelihood').value = r.likelihood;
    document.getElementById('risk-impact').value = r.impact;
    document.getElementById('risk-status-field').value = r.status;
    document.getElementById('risk-status-group').classList.remove('hidden');

    // Pre-select linked process/facility from cross-links
    const links = await api(`/api/cross-links/risk/${id}`);
    const procLink = links.find(l => l.type === 'process');
    const facLink = links.find(l => l.type === 'facility');
    if (procLink) procSel.value = procLink.id;
    if (facLink) facSel.value = facLink.id;
  }
  modal.classList.remove('hidden');
}

function closeRiskModal() { document.getElementById('risk-modal').classList.add('hidden'); }

async function saveRisk(e) {
  e.preventDefault();
  const id = document.getElementById('risk-id').value;
  const ownerName = document.getElementById('risk-owner').value;
  const assetName = document.getElementById('risk-asset').value;
  const body = {
    title: document.getElementById('risk-title').value,
    description: document.getElementById('risk-description').value,
    category: document.getElementById('risk-category').value,
    risk_owner: ownerName,
    asset: assetName,
    source: document.getElementById('risk-source').value,
    threat: document.getElementById('risk-threat').value,
    vulnerability: document.getElementById('risk-vulnerability').value,
    likelihood: parseInt(document.getElementById('risk-likelihood').value),
    impact: parseInt(document.getElementById('risk-impact').value),
  };
  let riskId = id;
  if (id) {
    body.status = document.getElementById('risk-status-field').value;
    await api(`/api/risks/${id}`, { method: 'PUT', body });
  } else {
    const result = await api('/api/risks', { method: 'POST', body });
    riskId = result.id;
  }
  // Auto-link selected architecture elements
  if (riskId) {
    const procId = document.getElementById('risk-process').value;
    const facId = document.getElementById('risk-facility').value;

    // Get existing links to avoid duplicates
    const existingLinks = await api(`/api/cross-links/risk/${riskId}`);
    const existingTargets = new Set(existingLinks.map(l => `${l.type}:${l.id}`));

    // Link process
    if (procId && !existingTargets.has(`process:${procId}`)) {
      await api('/api/cross-links', { method: 'POST', body: { source_type: 'risk', source_id: parseInt(riskId), target_type: 'process', target_id: parseInt(procId) } });
    }
    // Link facility
    if (facId && !existingTargets.has(`facility:${facId}`)) {
      await api('/api/cross-links', { method: 'POST', body: { source_type: 'risk', source_id: parseInt(riskId), target_type: 'facility', target_id: parseInt(facId) } });
    }
    // Link owner (role) by name lookup
    if (ownerName) {
      const roles = await api('/api/architecture?arch_type=role');
      const role = roles.find(r => r.name === ownerName);
      if (role && !existingTargets.has(`role:${role.id}`)) {
        await api('/api/cross-links', { method: 'POST', body: { source_type: 'risk', source_id: parseInt(riskId), target_type: 'role', target_id: role.id } });
      }
    }
    // Link asset/system by name lookup
    if (assetName) {
      const [systems, assets] = await Promise.all([
        api('/api/architecture?arch_type=system'),
        api('/api/architecture?arch_type=asset')
      ]);
      let arch = systems.find(s => s.name === assetName);
      let archType = 'system';
      if (!arch) {
        arch = assets.find(a => a.name === assetName);
        archType = 'asset';
      }
      if (arch && !existingTargets.has(`${archType}:${arch.id}`)) {
        await api('/api/cross-links', { method: 'POST', body: { source_type: 'risk', source_id: parseInt(riskId), target_type: archType, target_id: arch.id } });
      }
    }
  }
  closeRiskModal();
  refreshCurrentView();
}

async function deleteRisk(id) {
  if (!confirm('Delete this risk and all its treatments?')) return;
  await api(`/api/risks/${id}`, { method: 'DELETE' });
  refreshCurrentView();
}

// --- Risk Treatment View ---
async function loadRiskTreatmentView() {
  const risks = await api('/api/risks');
  // Fetch all treatment details
  const details = {};
  await Promise.all(risks.map(async r => { details[r.id] = await api(`/api/risks/${r.id}`); }));

  // Fetch treatment links
  const treatmentLinks = {};
  const allTreatments = Object.values(details).flatMap(d => d.treatments || []);
  await Promise.all(allTreatments.map(async t => {
    treatmentLinks[t.id] = await api(`/api/cross-links/treatment/${t.id}`);
  }));

  const totalTreatments = Object.values(details).reduce((s, d) => s + (d.treatments || []).length, 0);
  const openTreatments = Object.values(details).reduce((s, d) => s + (d.treatments || []).filter(t => t.status === 'planned' || t.status === 'in_progress').length, 0);

  document.getElementById('treatment-filters-bar').innerHTML = `<span style="font-size:13px;color:var(--text-muted)">${risks.length} risk${risks.length !== 1 ? 's' : ''}, ${totalTreatments} treatment${totalTreatments !== 1 ? 's' : ''}, ${openTreatments} open</span>`;

  if (risks.length === 0) {
    document.getElementById('treatment-list').innerHTML = '<div class="empty-state">No risks identified yet. Go to Risk Identification first.</div>';
    return;
  }

  let html = `<div class="treat-table">
    <div class="treat-table-head">
      <div class="treat-col-risk">Risk</div>
      <div class="treat-col-score">Inherent</div>
      <div class="treat-col-score">Residual</div>
      <div class="treat-col-count">Actions</div>
      <div class="treat-col-status">Progress</div>
      <div class="treat-col-actions"></div>
    </div>`;

  for (const r of risks) {
    const detail = details[r.id];
    const treatments = detail.treatments || [];
    const cls = riskScoreClass(r.inherent_score);

    // Calculate residual score as average of all treatments with residual values
    let residualScore = r.inherent_score;
    const treatmentsWithResidual = treatments.filter(t => t.residual_likelihood && t.residual_impact);
    if (treatmentsWithResidual.length > 0) {
      const totalResidual = treatmentsWithResidual.reduce((sum, t) => sum + (t.residual_likelihood * t.residual_impact), 0);
      residualScore = Math.round(totalResidual / treatmentsWithResidual.length);
    }
    const resCls = riskScoreClass(residualScore);
    const done = treatments.filter(t => t.status === 'implemented' || t.status === 'verified').length;
    const pct = treatments.length > 0 ? Math.round((done / treatments.length) * 100) : 0;
    const collapseId = `treat-expand-${r.id}`;

    html += `<div class="treat-table-row">
        <div class="treat-col-risk" style="cursor:pointer" onclick="openRiskModal(${r.id})">
          <span class="risk-row-title" style="color:var(--primary)">${esc(r.title)}</span>
          <span class="risk-row-sub">${esc(r.category || '')}${r.risk_owner ? ' · ' + esc(r.risk_owner) : ''}</span>
        </div>
        <div class="treat-col-score"><span class="badge risk-score-badge ${cls}">${r.inherent_score}</span></div>
        <div class="treat-col-score">${residualScore !== r.inherent_score ? `<span class="badge risk-score-badge ${resCls}">${residualScore}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}</div>
        <div class="treat-col-count">
          ${treatments.length > 0 ? `<span style="cursor:pointer;font-size:12px" onclick="document.getElementById('${collapseId}').classList.toggle('collapsed');this.querySelector('.cl-toggle-icon').textContent=document.getElementById('${collapseId}').classList.contains('collapsed')?'+':'−'">${treatments.length} action${treatments.length !== 1 ? 's' : ''} <span class="cl-toggle-icon">+</span></span>` : '<span style="color:var(--text-muted);font-size:11px">none</span>'}
        </div>
        <div class="treat-col-status">
          ${treatments.length > 0 ? `<div class="treat-progress-bar"><div class="treat-progress-fill" style="width:${pct}%"></div></div><span style="font-size:11px;color:var(--text-muted)">${pct}%</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}
        </div>
        <div class="treat-col-actions">
          ${actionMenu([
            { label: '+ Add Treatment', onclick: `openTreatmentModalForRisk(${r.id})` },
          ])}
        </div>
      </div>
      <div class="treat-expand-row">
        <div id="${collapseId}" class="treat-detail collapsed">
          ${treatments.length === 0 ? '' : buildTreatmentDetail(treatments, treatmentLinks)}
        </div>
      </div>`;
  }
  html += '</div>';
  document.getElementById('treatment-list').innerHTML = html;
}

function buildTreatmentDetail(treatments, treatmentLinks) {
  let html = '<div class="treat-sub-table">';
  html += `<div class="treat-sub-head">
    <div class="treat-sub-type">Type</div>
    <div class="treat-sub-desc">Description</div>
    <div class="treat-sub-ref">Links</div>
    <div class="treat-sub-resp">Responsible</div>
    <div class="treat-sub-due">Due</div>
    <div class="treat-sub-st">Status</div>
    <div class="treat-sub-act"></div>
  </div>`;
  for (const t of treatments) {
    const stBadge = t.status === 'verified' ? 'badge-low' : t.status === 'implemented' ? 'badge-low' : t.status === 'in_progress' ? 'badge-medium' : 'badge-high';
    const links = treatmentLinks[t.id] || [];
    const linkCount = links.length;
    html += `<div class="treat-sub-row">
      <div class="treat-sub-type"><span class="badge badge-inactive">${t.treatment_type}</span></div>
      <div class="treat-sub-desc" style="cursor:pointer" onclick="openTreatmentModal(${t.id})">
        <span style="font-size:12px;color:var(--primary)">${esc(t.description)}</span>
      </div>
      <div class="treat-sub-ref"><span style="font-size:12px;color:var(--primary)">${linkCount > 0 ? `${linkCount} link${linkCount !== 1 ? 's' : ''}` : '-'}</span></div>
      <div class="treat-sub-resp"><span style="font-size:12px">${t.responsible ? esc(t.responsible) : '-'}</span></div>
      <div class="treat-sub-due"><span style="font-size:12px">${t.due_date || '-'}</span></div>
      <div class="treat-sub-st"><span class="badge ${stBadge}">${t.status.replace(/_/g, ' ')}</span></div>
      <div class="treat-sub-act">
        ${actionMenu([
          ...(t.status === 'planned' ? [{ label: '&#9654; Start', onclick: `updateTreatmentStatus(${t.id},'in_progress')` }] : []),
          ...(t.status === 'in_progress' ? [{ label: '&#10003; Implement', onclick: `updateTreatmentStatus(${t.id},'implemented')` }] : []),
          ...(t.status === 'implemented' ? [{ label: '&#10003; Verify', onclick: `updateTreatmentStatus(${t.id},'verified')` }] : []),
          { label: '&#9998; Edit', onclick: `openTreatmentModal(${t.id})` },
          'sep',
          { label: '&#128465; Delete', onclick: `deleteTreatment(${t.id})`, cls: 'danger' },
        ])}
      </div>
    </div>`;
  }
  html += '</div>';
  return html;
}

async function populateTreatmentRoles() {
  const roles = await api('/api/architecture?arch_type=role');
  const sel = document.getElementById('treatment-responsible');
  sel.innerHTML = '<option value="">-- Select Role --</option>' + roles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
}

async function populateTreatmentControls() {
  const soaData = await api('/api/soa');
  const select = document.getElementById('treatment-control-ref');
  select.innerHTML = '<option value="">-- Select Control (optional) --</option>' +
    soaData.map(c => `<option value="${esc(c.clause)}">${esc(c.clause)} - ${esc(c.title)}</option>`).join('');
}

async function openTreatmentModalForRisk(riskId) {
  document.getElementById('treatment-form').reset();
  document.getElementById('treatment-id').value = '';
  document.getElementById('treatment-risk-id').value = riskId;
  document.getElementById('treatment-modal-title').textContent = 'New Treatment';
  document.getElementById('treatment-status-group').classList.add('hidden');
  document.getElementById('treatment-crosslinks').classList.add('hidden');
  document.getElementById('treatment-crosslinks').innerHTML = '';
  await Promise.all([populateTreatmentRoles(), populateTreatmentControls()]);
  document.getElementById('treatment-modal').classList.remove('hidden');
}

async function openTreatmentModal(id) {
  const treatments = await api('/api/treatments');
  const t = treatments.find(x => x.id === id);
  if (!t) return;
  document.getElementById('treatment-form').reset();
  document.getElementById('treatment-id').value = t.id;
  document.getElementById('treatment-risk-id').value = t.risk_id;
  document.getElementById('treatment-modal-title').textContent = 'Edit Treatment';
  document.getElementById('treatment-type').value = t.treatment_type;
  document.getElementById('treatment-description').value = t.description;
  document.getElementById('treatment-due-date').value = t.due_date || '';
  document.getElementById('treatment-res-likelihood').value = t.residual_likelihood || '';
  document.getElementById('treatment-res-impact').value = t.residual_impact || '';
  document.getElementById('treatment-notes').value = t.notes || '';
  document.getElementById('treatment-status-field').value = t.status;
  document.getElementById('treatment-status-group').classList.remove('hidden');
  await Promise.all([populateTreatmentRoles(), populateTreatmentControls()]);
  document.getElementById('treatment-responsible').value = t.responsible || '';
  document.getElementById('treatment-control-ref').value = t.control_reference || '';
  // Show cross-links section for existing treatments
  const clContainer = document.getElementById('treatment-crosslinks');
  clContainer.classList.remove('hidden');
  renderCrossLinks('treatment', id, 'treatment-crosslinks');
  document.getElementById('treatment-modal').classList.remove('hidden');
}

function closeTreatmentModal() { document.getElementById('treatment-modal').classList.add('hidden'); }

async function saveTreatment(e) {
  e.preventDefault();
  const id = document.getElementById('treatment-id').value;
  const body = {
    risk_id: parseInt(document.getElementById('treatment-risk-id').value),
    treatment_type: document.getElementById('treatment-type').value,
    description: document.getElementById('treatment-description').value,
    control_reference: document.getElementById('treatment-control-ref').value,
    responsible: document.getElementById('treatment-responsible').value,
    due_date: document.getElementById('treatment-due-date').value || null,
    residual_likelihood: document.getElementById('treatment-res-likelihood').value ? parseInt(document.getElementById('treatment-res-likelihood').value) : null,
    residual_impact: document.getElementById('treatment-res-impact').value ? parseInt(document.getElementById('treatment-res-impact').value) : null,
    notes: document.getElementById('treatment-notes').value,
  };
  if (id) {
    body.status = document.getElementById('treatment-status-field').value;
    await api(`/api/treatments/${id}`, { method: 'PUT', body });
  } else {
    await api('/api/treatments', { method: 'POST', body });
  }
  closeTreatmentModal();
  refreshCurrentView();
}

async function updateTreatmentStatus(id, status) {
  await api(`/api/treatments/${id}`, { method: 'PUT', body: { status } });
  refreshCurrentView();
}

async function deleteTreatment(id) {
  if (!confirm('Delete this treatment?')) return;
  await api(`/api/treatments/${id}`, { method: 'DELETE' });
  refreshCurrentView();
}

// --- Statement of Applicability ---
let soaProcesses = [];

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

  // Group by category
  const groups = {};
  for (const d of data) {
    const cat = d.category || 'Uncategorized';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(d);
  }

  let html = '';
  for (const [cat, items] of Object.entries(groups)) {
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

// --- Organizational Planning: Mission Control ---
async function loadMissionControl() {
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
  const d = await api('/api/kpis/auto');
  if (d.error) { console.warn('KPI auto load failed:', d.error); return; }
  const soaPct = d.soa_applicable > 0 ? Math.round((d.soa_implemented / d.soa_applicable) * 100) : 0;
  const kpiStat = (val, label, cls) => `<div class="kpi-tile-stat${cls ? ' ' + cls : ''}"><span class="kpi-tile-val">${val}</span><span class="kpi-tile-lbl">${label}</span></div>`;

  document.getElementById('auto-kpi-grid').innerHTML = `
    <div class="kpi-tile" onclick="switchView('tasks')">
      <h4 class="kpi-tile-title">&#9881; Task Management</h4>
      <div class="kpi-tile-stats">
        ${kpiStat(d.tasks_active, 'Active', '')}
        ${kpiStat(d.tasks_overdue, 'Overdue', d.tasks_overdue > 0 ? 'kpi-danger' : 'kpi-ok')}
        ${kpiStat(d.completions_this_month, 'Done (mo)', 'kpi-ok')}
      </div>
    </div>
    <div class="kpi-tile" onclick="switchView('audit-plan')">
      <h4 class="kpi-tile-title">&#9998; Audits &amp; Compliance</h4>
      <div class="kpi-tile-stats">
        ${kpiStat(d.audits_planned, 'Planned', '')}
        ${kpiStat(d.audits_completed, 'Completed', 'kpi-ok')}
        ${kpiStat(d.open_ncrs, 'Open NCRs', d.open_ncrs > 0 ? 'kpi-danger' : 'kpi-ok')}
        ${kpiStat(d.open_actions, 'Open Actions', d.open_actions > 0 ? 'kpi-danger' : 'kpi-ok')}
        ${kpiStat(d.standards_count, 'Standards', '')}
      </div>
    </div>
    <div class="kpi-tile" onclick="switchView('risk-identification')">
      <h4 class="kpi-tile-title">&#9888; Risk Management</h4>
      <div class="kpi-tile-stats">
        ${kpiStat(d.total_risks, 'Total', '')}
        ${kpiStat(d.high_risks, 'High/Crit', d.high_risks > 0 ? 'kpi-danger' : 'kpi-ok')}
        ${kpiStat(d.open_treatments, 'Open Treat.', '')}
        ${kpiStat(soaPct + '%', 'SoA Impl.', soaPct >= 80 ? 'kpi-ok' : '')}
        ${kpiStat(d.threat_items_new, 'New Threats', d.threat_items_new > 0 ? 'kpi-danger' : '')}
      </div>
    </div>
    <div class="kpi-tile" onclick="switchView('document-control')">
      <h4 class="kpi-tile-title">&#128196; Document Control</h4>
      <div class="kpi-tile-stats">
        ${kpiStat(d.total_documents, 'Documents', '')}
        ${kpiStat(d.docs_due_review, 'Due Review', d.docs_due_review > 0 ? 'kpi-danger' : 'kpi-ok')}
      </div>
    </div>
    <div class="kpi-tile" onclick="switchView('architecture')">
      <h4 class="kpi-tile-title">&#127970; Architecture</h4>
      <div class="kpi-tile-stats">
        ${kpiStat(d.arch_processes, 'Processes', '')}
        ${kpiStat(d.arch_roles, 'Roles', '')}
        ${kpiStat(d.arch_systems, 'Systems', '')}
        ${kpiStat(d.arch_facilities, 'Facilities', '')}
      </div>
    </div>`;

  // Custom KPIs
  const kpis = await api('/api/kpis');
  const customList = document.getElementById('custom-kpi-list');
  if (kpis.length === 0) {
    customList.innerHTML = '<div class="empty-state" style="padding:20px">No custom KPIs yet. Create one to track organizational metrics.</div>';
    return;
  }
  customList.innerHTML = kpis.map(k => {
    const vals = k.values || [];
    const latest = vals.length > 0 ? vals[0].value : null;
    const prev = vals.length > 1 ? vals[1].value : null;
    const trend = (latest !== null && prev !== null) ? latest - prev : null;
    const trendHtml = trend !== null ? `<span class="kpi-trend ${trend > 0 ? 'up' : trend < 0 ? 'down' : 'flat'}">${trend > 0 ? '+' : ''}${Number(trend.toFixed(2))}${k.unit}</span>` : '';
    const targetHtml = k.target_value !== null ? `<div style="font-size:12px;color:var(--text-muted)">Target: ${k.target_value}${k.unit}</div>` : '';
    // Mini sparkline using bars
    const sparkVals = vals.slice(0, 6).reverse();
    const max = sparkVals.length > 0 ? Math.max(...sparkVals.map(v => v.value), 1) : 1;
    const sparkHtml = sparkVals.length > 0 ? `<div class="kpi-spark">${sparkVals.map(v => {
      const h = Math.max(4, (v.value / max) * 28);
      return `<div class="kpi-spark-bar" style="height:${h}px" title="${v.period}: ${v.value}${k.unit}"></div>`;
    }).join('')}</div>` : '';
    return `<div class="kpi-card-custom">
      <div class="kpi-card-custom-header">
        <div style="cursor:pointer" onclick="openKpiModal(${k.id})">
          <div class="kpi-header" style="color:var(--primary)">${esc(k.name)}</div>
          ${k.description ? `<div style="font-size:12px;color:var(--text-muted)">${esc(k.description)}</div>` : ''}
        </div>
        ${actionMenu([
          { label: '&#128200; Record Value', onclick: `openKpiValueModal(${k.id})`, cls: 'primary' },
          { label: '&#9998; Edit', onclick: `openKpiModal(${k.id})` },
          'sep',
          { label: '&#128465; Delete', onclick: `deleteKpi(${k.id})`, cls: 'danger' },
        ])}
      </div>
      <div style="display:flex;align-items:end;gap:16px">
        <div>
          <div class="kpi-value">${latest !== null ? latest + (k.unit || '') : 'N/A'}</div>
          ${targetHtml}
          <div style="display:flex;gap:6px;align-items:center">${trendHtml}</div>
        </div>
        ${sparkHtml}
      </div>
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
      document.getElementById('kpi-target').value = k.target_value || '';
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

// --- Organizational Planning: Architecture ---
let currentArchTab = 'role';
const archTypeLabels = { role: 'Roles & Responsibilities', process: 'Processes', system: 'Systems / Data', asset: 'Assets', facility: 'Facilities' };

function switchArchTab(type) {
  currentArchTab = type;
  document.querySelectorAll('.arch-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.arch-tab[onclick="switchArchTab('${type}')"]`).classList.add('active');
  loadArchitecture();
}

let orgChartZoom = 1;

async function loadArchitecture() {
  const items = await api(`/api/architecture?arch_type=${currentArchTab}`);
  const list = document.getElementById('arch-list');

  // Update Add button label to match current tab
  const archSingular = { role: 'Role', process: 'Process', system: 'System', asset: 'Asset', facility: 'Facility' };
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

  // Fetch cross-links for all items
  const allLinks = {};
  await Promise.all(items.map(async item => {
    allLinks[item.id] = await api(`/api/cross-links/${currentArchTab}/${item.id}`);
  }));

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
    const links = allLinks[item.id] || [];
    html += buildArchTableRow(item, meta, links, currentArchTab);
  }

  html += '</div>';
  list.innerHTML = html;
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
  if (meta.contact_name || meta.contact_email) {
    const parts = [meta.contact_name, meta.contact_email].filter(Boolean);
    contact = `<div class="org-node-contact">${esc(parts.join(' · '))}</div>`;
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
    role: ['Name', 'Contact', 'Reports to', 'Status', 'Links', ''],
    process: ['Name', 'Description', 'Owner', 'Status', 'Links', ''],
    system: ['Name', 'Criticality', 'Owner', 'Status', 'Links', ''],
    asset: ['Name', 'Description', 'Owner', 'Status', 'Links', ''],
    facility: ['Name', 'Address', 'Owner', 'Status', 'Links', ''],
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
    const contact = [meta.contact_name, meta.contact_email].filter(Boolean).join(' · ');
    detailCol = contact ? `<span style="font-size:12px">${esc(contact)}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>';
  } else if (archType === 'system') {
    if (meta.criticality) {
      const critBadge = meta.criticality === 'critical' ? 'badge-critical' : meta.criticality === 'high' ? 'badge-high' : meta.criticality === 'medium' ? 'badge-medium' : 'badge-low';
      detailCol = `<span class="badge ${critBadge}">${meta.criticality}</span>`;
    } else {
      detailCol = '<span style="color:var(--text-muted);font-size:11px">-</span>';
    }
  } else if (archType === 'facility') {
    detailCol = meta.address ? `<span style="font-size:12px">${esc(meta.address.substring(0, 40))}${meta.address.length > 40 ? '...' : ''}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>';
  } else {
    detailCol = item.description ? `<span style="font-size:12px">${esc(item.description.substring(0, 50))}${item.description.length > 50 ? '...' : ''}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>';
  }

  // Build links detail section
  const linksDetailId = `arch-links-${archType}-${item.id}`;
  let linksDetail = '';
  if (linkCount > 0) {
    const typeIcons = { role: '&#128100;', process: '&#9881;', system: '&#128187;', asset: '&#128230;', facility: '&#127970;', document: '&#128196;', risk: '&#9888;', task: '&#9745;', requirement: '&#128203;' };
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

  return `<div class="arch-table-row-wrap">
    <div class="arch-table-row">
      <div class="arch-col-name" style="cursor:pointer" onclick="openArchModal(${item.id})">
        <span class="arch-name" style="color:var(--primary)">${esc(item.name)}</span>
        ${archType === 'role' && item.description ? `<span class="arch-desc">${esc(item.description)}</span>` : ''}
      </div>
      <div class="arch-col-detail">${detailCol}</div>
      <div class="arch-col-detail"><span style="font-size:12px">${item.owner ? esc(item.owner) : '-'}</span></div>
      <div class="arch-col-detail"><span class="badge ${stBadge}">${item.status}</span></div>
      <div class="arch-col-detail arch-col-links">
        ${linkCount > 0 ? `<span class="arch-link-toggle" onclick="toggleArchLinks('${linksDetailId}')">${linkCount} link${linkCount !== 1 ? 's' : ''} <span class="arch-link-arrow" id="${linksDetailId}-arrow">&#9660;</span></span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}
      </div>
      <div class="arch-col-actions">
        ${actionMenu([
          { label: '&#128279; Link Items', onclick: `openCrossLinkPicker('${archType}',${item.id},'arch-expand-${item.id}')` },
          { label: '&#9998; Edit', onclick: `openArchModal(${item.id})` },
          'sep',
          { label: '&#128465; Delete', onclick: `deleteArch(${item.id})`, cls: 'danger' },
        ])}
      </div>
    </div>
    ${linkCount > 0 ? `<div class="arch-links-detail collapsed" id="${linksDetailId}">${linksDetail}</div>` : ''}
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
    extraFields.innerHTML = `
      <div class="form-group"><label>Contact Name</label><input type="text" id="arch-contact-name" value="${esc(metadata.contact_name || '')}" placeholder="Full name of person in this role"></div>
      <div class="form-group"><label>Contact Email</label><input type="email" id="arch-contact-email" value="${esc(metadata.contact_email || '')}" placeholder="Email address"></div>
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
  } else {
    extraFields.innerHTML = '';
  }

  document.getElementById('arch-modal').classList.remove('hidden');
}
function closeArchModal() { document.getElementById('arch-modal').classList.add('hidden'); }

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
  }
  const body = {
    arch_type: archType,
    name: document.getElementById('arch-name').value,
    description: document.getElementById('arch-description').value,
    owner: document.getElementById('arch-owner').value,
    status: document.getElementById('arch-status').value,
    metadata: JSON.stringify(metadata),
  };
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

// --- Document Control ---
let docFilters = { doc_type: '', status: '', classification: '', process: '', owner: '', search: '' };

async function loadDocumentControl() {
  const params = new URLSearchParams();
  if (docFilters.doc_type) params.set('doc_type', docFilters.doc_type);
  if (docFilters.status) params.set('status', docFilters.status);
  if (docFilters.classification) params.set('classification', docFilters.classification);
  let docs = await api(`/api/documents?${params}`);

  // Prefetch all cross-links for documents
  const allLinks = {};
  await Promise.all(docs.map(async d => {
    allLinks[d.id] = await api(`/api/cross-links/document/${d.id}`);
  }));

  // Fetch processes for filter dropdown
  const processes = await api('/api/architecture?arch_type=process');

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

  document.getElementById('doc-filters-bar').innerHTML = `
    <div class="filter-row" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px">
      <input type="text" placeholder="&#128269; Search documents..." value="${esc(docFilters.search || '')}"
        style="padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius);font-size:13px;min-width:200px"
        oninput="docFilters.search=this.value;loadDocumentControl()">
      <select onchange="docFilters.doc_type=this.value;loadDocumentControl()">
        <option value="">All Types</option>
        <option value="policy" ${docFilters.doc_type==='policy'?'selected':''}>Policy</option>
        <option value="procedure" ${docFilters.doc_type==='procedure'?'selected':''}>Procedure</option>
        <option value="work_instruction" ${docFilters.doc_type==='work_instruction'?'selected':''}>Work Instruction</option>
        <option value="record" ${docFilters.doc_type==='record'?'selected':''}>Record</option>
        <option value="form" ${docFilters.doc_type==='form'?'selected':''}>Form / Template</option>
        <option value="report" ${docFilters.doc_type==='report'?'selected':''}>Report</option>
        <option value="other" ${docFilters.doc_type==='other'?'selected':''}>Other</option>
      </select>
      <select onchange="docFilters.status=this.value;loadDocumentControl()">
        <option value="">All Status</option>
        <option value="draft" ${docFilters.status==='draft'?'selected':''}>Draft</option>
        <option value="review" ${docFilters.status==='review'?'selected':''}>Under Review</option>
        <option value="approved" ${docFilters.status==='approved'?'selected':''}>Approved</option>
        <option value="obsolete" ${docFilters.status==='obsolete'?'selected':''}>Obsolete</option>
      </select>
      <select onchange="docFilters.classification=this.value;loadDocumentControl()">
        <option value="">All Classifications</option>
        <option value="public" ${docFilters.classification==='public'?'selected':''}>Public</option>
        <option value="internal" ${docFilters.classification==='internal'?'selected':''}>Internal</option>
        <option value="confidential" ${docFilters.classification==='confidential'?'selected':''}>Confidential</option>
        <option value="restricted" ${docFilters.classification==='restricted'?'selected':''}>Restricted</option>
      </select>
      <select onchange="docFilters.process=this.value;loadDocumentControl()">
        <option value="">All Processes</option>
        ${processes.map(p => `<option value="${esc(p.name)}" ${docFilters.process===p.name?'selected':''}>${esc(p.name)}</option>`).join('')}
      </select>
      <select onchange="docFilters.owner=this.value;loadDocumentControl()">
        <option value="">All Owners</option>
        ${uniqueOwners.map(o => `<option value="${esc(o)}" ${docFilters.owner===o?'selected':''}>${esc(o)}</option>`).join('')}
      </select>
      ${(docFilters.doc_type || docFilters.status || docFilters.classification || docFilters.process || docFilters.owner || docFilters.search) ?
        `<button class="btn btn-secondary btn-sm" onclick="docFilters={doc_type:'',status:'',classification:'',process:'',owner:'',search:''};loadDocumentControl()">Clear Filters</button>` : ''}
    </div>
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px">${docs.length} document${docs.length!==1?'s':''} found</div>`;

  const list = document.getElementById('doc-list');
  if (docs.length === 0) {
    list.innerHTML = '<div class="empty-state">No documents yet. Upload one to get started.</div>';
    return;
  }

  const docTypeLabels = { policy: 'Policy', procedure: 'Procedure', work_instruction: 'Work Instruction', record: 'Record', form: 'Form', report: 'Report', other: 'Other' };
  const statusBadge = s => s === 'approved' ? 'badge-low' : s === 'review' ? 'badge-medium' : s === 'obsolete' ? 'badge-inactive' : 'badge-high';
  const classificationBadge = c => c === 'restricted' ? 'badge-critical' : c === 'confidential' ? 'badge-high' : c === 'internal' ? 'badge-medium' : 'badge-low';
  const today = new Date().toISOString().split('T')[0];

  // Group by doc_type
  const groups = {};
  for (const d of docs) {
    const t = docTypeLabels[d.doc_type] || d.doc_type || 'Other';
    if (!groups[t]) groups[t] = [];
    groups[t].push(d);
  }

  let html = '';
  for (const [typeName, items] of Object.entries(groups)) {
    html += `<div class="doc-type-group">
      <div class="doc-type-header">${esc(typeName)} <span class="req-cat-count">(${items.length})</span></div>
      <div class="doc-table">
        <div class="doc-table-head">
          <div class="doc-col-title">Document</div>
          <div class="doc-col-class">Classification</div>
          <div class="doc-col-status">Status</div>
          <div class="doc-col-ver">Version</div>
          <div class="doc-col-owner">Owner</div>
          <div class="doc-col-review">Review</div>
          <div class="doc-col-links">Linked Items</div>
          <div class="doc-col-actions"></div>
        </div>`;
    for (const d of items) {
      const reviewOverdue = d.review_date && d.review_date < today;
      const links = allLinks[d.id] || [];
      const processLinks = links.filter(l => l.type === 'process');
      const reqLinks = links.filter(l => l.type === 'requirement');
      const otherLinks = links.filter(l => l.type !== 'process' && l.type !== 'requirement');
      // Build a brief summary for the links column
      const linkParts = [];
      if (reqLinks.length > 0) linkParts.push(reqLinks.length + ' standard' + (reqLinks.length !== 1 ? 's' : ''));
      if (processLinks.length > 0) linkParts.push(processLinks.length + ' process' + (processLinks.length !== 1 ? 'es' : ''));
      if (otherLinks.length > 0) linkParts.push(otherLinks.length + ' other');
      const linkSummary = linkParts.length > 0 ? linkParts.join(', ') : '-';
      const collapseId = `doc-cl-${d.id}`;

      html += `<div class="doc-table-row${d.status === 'obsolete' ? ' doc-obsolete' : ''}">
          <div class="doc-col-title" style="cursor:pointer" onclick="openDocModal(${d.id})">
            <span class="doc-row-title" style="color:var(--primary)">${esc(d.title)}</span>
            ${d.file_name ? `<span class="doc-row-file">${esc(d.file_name)}</span>` : ''}
          </div>
          <div class="doc-col-class">
            ${d.classification ? `<span class="badge ${classificationBadge(d.classification)}">${esc(d.classification)}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}
          </div>
          <div class="doc-col-status"><span class="badge ${statusBadge(d.status)}">${esc(d.status)}</span></div>
          <div class="doc-col-ver">v${esc(d.version)}</div>
          <div class="doc-col-owner">${d.owner ? `<span style="font-size:12px">${esc(d.owner)}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}</div>
          <div class="doc-col-review">${d.review_date ? `<span style="font-size:12px;${reviewOverdue ? 'color:var(--danger);font-weight:600' : ''}">${d.review_date}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}</div>
          <div class="doc-col-links">
            <span class="doc-link-summary" style="cursor:pointer;font-size:12px" onclick="document.getElementById('${collapseId}').classList.toggle('collapsed');this.querySelector('.cl-toggle-icon').textContent=document.getElementById('${collapseId}').classList.contains('collapsed')?'+':'−'">${linkSummary} <span class="cl-toggle-icon">${links.length > 0 ? '+' : ''}</span></span>
          </div>
          <div class="doc-col-actions">
            ${actionMenu([
              ...(d.file_name ? [{ label: '&#128229; Download', onclick: `downloadDoc(${d.id})` }] : []),
              { label: '&#128279; Link Items', onclick: `openCrossLinkPicker('document',${d.id},'doc-expand-${d.id}')` },
              { label: '&#9998; Edit', onclick: `openDocModal(${d.id})` },
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
    html += '</div></div>';
  }
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
    html += `<div class="cross-link-group"><span class="cross-link-group-label">${typeIcons[type] || ''} ${typeLabels[type] || type}s</span>`;
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
  if (refVal) {
    const [refType, refId] = refVal.split(':');
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

// --- Helpers ---
function refreshCurrentView() {
  switchView(currentView);
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ===== ADMIN MODULE =====

let adminUserFilters = { status: '', role: '', search: '' };
let auditLogFilters = { action: '', entity_type: '' };
let auditLogPage = 0;

// --- Admin: System Overview ---
async function loadAdminOverview() {
  const stats = await api('/api/admin/overview');

  // Health grid
  const healthGrid = document.getElementById('admin-health-grid');
  const dbSizeMB = (stats.databaseSize / (1024 * 1024)).toFixed(2);
  const lastBackupDate = stats.lastBackup ? new Date(stats.lastBackup.created_at).toLocaleDateString() : 'Never';

  healthGrid.innerHTML = `
    <div class="admin-health-card">
      <div class="health-icon success">&#9889;</div>
      <div class="health-info">
        <div class="health-label">System Status</div>
        <div class="health-value">Operational</div>
      </div>
    </div>
    <div class="admin-health-card">
      <div class="health-icon info">&#128451;</div>
      <div class="health-info">
        <div class="health-label">Database Size</div>
        <div class="health-value">${dbSizeMB} MB</div>
      </div>
    </div>
    <div class="admin-health-card">
      <div class="health-icon ${stats.lastBackup ? 'success' : 'warning'}">&#128190;</div>
      <div class="health-info">
        <div class="health-label">Last Backup</div>
        <div class="health-value">${lastBackupDate}</div>
      </div>
    </div>
    <div class="admin-health-card">
      <div class="health-icon info">&#128100;</div>
      <div class="health-info">
        <div class="health-label">Active Users</div>
        <div class="health-value">${stats.activeUsers} / ${stats.users}</div>
      </div>
    </div>
  `;

  // Module stats
  const moduleStats = document.getElementById('admin-module-stats');
  moduleStats.innerHTML = `
    <div class="module-stat-grid">
      <div class="module-stat-card">
        <div class="module-stat-header">
          <span class="module-stat-icon">&#9881;</span>
          <span class="module-stat-title">Operational Planning</span>
        </div>
        <div class="module-stat-body">
          <div class="stat-row"><span>Active Tasks</span><strong>${stats.activeTasks}</strong></div>
          <div class="stat-row"><span>Total Completions</span><strong>${stats.completions}</strong></div>
          <div class="stat-row ${stats.openActions > 0 ? 'warning' : ''}"><span>Open Actions</span><strong>${stats.openActions}</strong></div>
        </div>
      </div>
      <div class="module-stat-card">
        <div class="module-stat-header">
          <span class="module-stat-icon">&#9888;</span>
          <span class="module-stat-title">Risk Management</span>
        </div>
        <div class="module-stat-body">
          <div class="stat-row"><span>Total Risks</span><strong>${stats.risks}</strong></div>
          <div class="stat-row ${stats.highRisks > 0 ? 'danger' : ''}"><span>High/Critical Risks</span><strong>${stats.highRisks}</strong></div>
          <div class="stat-row"><span>Treatments</span><strong>${stats.treatments}</strong></div>
        </div>
      </div>
      <div class="module-stat-card">
        <div class="module-stat-header">
          <span class="module-stat-icon">&#9998;</span>
          <span class="module-stat-title">Audits</span>
        </div>
        <div class="module-stat-body">
          <div class="stat-row"><span>Total Audits</span><strong>${stats.audits}</strong></div>
          <div class="stat-row"><span>Planned</span><strong>${stats.plannedAudits}</strong></div>
          <div class="stat-row ${stats.openNcrs > 0 ? 'warning' : ''}"><span>Open NCRs</span><strong>${stats.openNcrs}</strong></div>
        </div>
      </div>
      <div class="module-stat-card">
        <div class="module-stat-header">
          <span class="module-stat-icon">&#127970;</span>
          <span class="module-stat-title">Organization</span>
        </div>
        <div class="module-stat-body">
          <div class="stat-row"><span>Architecture Items</span><strong>${stats.architecture}</strong></div>
          <div class="stat-row"><span>Requirements</span><strong>${stats.requirements}</strong></div>
          <div class="stat-row"><span>Documents</span><strong>${stats.documents}</strong></div>
        </div>
      </div>
    </div>
  `;

  // Recent activity
  const activityList = document.getElementById('admin-recent-activity');
  if (stats.recentAuditLogs.length === 0) {
    activityList.innerHTML = '<div class="empty-state">No recent activity recorded.</div>';
  } else {
    activityList.innerHTML = stats.recentAuditLogs.map(log => {
      const actionIcons = {
        user_created: '&#128100;', user_updated: '&#128100;', user_deleted: '&#128100;', user_password_reset: '&#128274;',
        settings_updated: '&#9881;', data_exported: '&#128229;', backup_created: '&#128190;',
        api_key_created: '&#128273;', webhook_created: '&#128279;'
      };
      const icon = actionIcons[log.action] || '&#128196;';
      const time = new Date(log.created_at).toLocaleString();
      return `
        <div class="activity-item">
          <div class="activity-icon">${icon}</div>
          <div class="activity-content">
            <div class="activity-action">${formatAuditAction(log.action)}${log.entity_name ? `: ${esc(log.entity_name)}` : ''}</div>
            <div class="activity-meta">${esc(log.user_name)} &middot; ${time}</div>
          </div>
        </div>
      `;
    }).join('');
  }
}

function formatAuditAction(action) {
  const map = {
    user_created: 'User created', user_updated: 'User updated', user_deleted: 'User deleted', user_password_reset: 'Password reset',
    settings_updated: 'Settings updated', data_exported: 'Data exported', backup_created: 'Backup created',
    backup_deleted: 'Backup deleted', data_cleanup: 'Data cleanup', api_key_created: 'API key created',
    api_key_revoked: 'API key revoked', webhook_created: 'Webhook created', webhook_updated: 'Webhook updated',
    webhook_deleted: 'Webhook deleted'
  };
  return map[action] || action.replace(/_/g, ' ');
}

// --- Toast notification ---
function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast-notification');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = `toast-notification toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3500);
}

// --- Admin: User Management ---
let userSearchDebounce = null;

async function loadAdminUsers() {
  const params = new URLSearchParams();
  if (adminUserFilters.status) params.set('status', adminUserFilters.status);
  if (adminUserFilters.role) params.set('role', adminUserFilters.role);
  if (adminUserFilters.search) params.set('search', adminUserFilters.search);

  let users;
  try {
    users = await api(`/api/admin/users?${params}`);
    if (users.error) { showToast(users.error, 'error'); return; }
  } catch (e) { showToast('Failed to load users', 'error'); return; }

  // Stats
  const statsEl = document.getElementById('admin-users-stats');
  const totalUsers = users.length;
  const activeUsers = users.filter(u => u.status === 'active').length;
  const admins = users.filter(u => u.role === 'admin').length;
  const pending = users.filter(u => u.status === 'pending').length;

  statsEl.innerHTML = `
    <div class="stats-grid" style="margin-bottom:20px">
      <div class="stat-card"><div class="stat-value">${totalUsers}</div><div class="stat-label">Total Users</div></div>
      <div class="stat-card done"><div class="stat-value">${activeUsers}</div><div class="stat-label">Active</div></div>
      <div class="stat-card today"><div class="stat-value">${admins}</div><div class="stat-label">Administrators</div></div>
      <div class="stat-card ${pending > 0 ? 'overdue' : ''}"><div class="stat-value">${pending}</div><div class="stat-label">Pending</div></div>
    </div>
  `;

  // Filters
  const filtersEl = document.getElementById('admin-users-filters');
  filtersEl.innerHTML = `
    <input type="text" placeholder="&#128269; Search users..." value="${esc(adminUserFilters.search || '')}"
      style="padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius);font-size:13px;min-width:180px"
      oninput="adminUserFilters.search=this.value;clearTimeout(userSearchDebounce);userSearchDebounce=setTimeout(loadAdminUsers,300)">
    <select onchange="adminUserFilters.status=this.value;loadAdminUsers()">
      <option value="">All Status</option>
      <option value="active" ${adminUserFilters.status==='active'?'selected':''}>Active</option>
      <option value="pending" ${adminUserFilters.status==='pending'?'selected':''}>Pending</option>
      <option value="suspended" ${adminUserFilters.status==='suspended'?'selected':''}>Suspended</option>
      <option value="inactive" ${adminUserFilters.status==='inactive'?'selected':''}>Inactive</option>
    </select>
    <select onchange="adminUserFilters.role=this.value;loadAdminUsers()">
      <option value="">All Roles</option>
      <option value="viewer" ${adminUserFilters.role==='viewer'?'selected':''}>Viewer</option>
      <option value="user" ${adminUserFilters.role==='user'?'selected':''}>User</option>
      <option value="manager" ${adminUserFilters.role==='manager'?'selected':''}>Manager</option>
      <option value="admin" ${adminUserFilters.role==='admin'?'selected':''}>Administrator</option>
    </select>
  `;

  // Table
  const tbody = document.getElementById('admin-users-body');
  if (users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">No users found</td></tr>';
    return;
  }

  const roleLabels = { viewer: 'Viewer', user: 'User', manager: 'Manager', admin: 'Administrator' };
  const roleBadge = r => r === 'admin' ? 'badge-critical' : r === 'manager' ? 'badge-high' : r === 'user' ? 'badge-medium' : 'badge-low';
  const statusBadge = s => s === 'active' ? 'badge-low' : s === 'pending' ? 'badge-medium' : s === 'suspended' ? 'badge-high' : 'badge-inactive';
  const isSelf = id => currentUser && currentUser.id === id;

  tbody.innerHTML = users.map(u => {
    let permissions = [];
    try { permissions = JSON.parse(u.permissions || '[]'); } catch(e) {}
    const permLabels = permissions.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(', ');
    const lastActive = u.last_active ? new Date(u.last_active).toLocaleDateString() : 'Never';
    const selfTag = isSelf(u.id) ? ' <span style="font-size:10px;color:var(--primary)">(you)</span>' : '';

    const menuItems = [
      { label: '&#9998; Edit', onclick: `openUserModal(${u.id})` },
    ];
    if (!isSelf(u.id)) {
      menuItems.push(
        u.status === 'active'
          ? { label: '&#128683; Suspend', onclick: `toggleUserStatus(${u.id}, 'suspended')` }
          : { label: '&#9989; Activate', onclick: `toggleUserStatus(${u.id}, 'active')` }
      );
      menuItems.push('sep');
      menuItems.push({ label: '&#128465; Delete', onclick: `deleteUser(${u.id}, '${esc(u.name)}')`, cls: 'danger' });
    }

    return `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          <div class="user-avatar">${u.name.charAt(0).toUpperCase()}</div>
          <div>
            <strong style="cursor:pointer;color:var(--primary)" onclick="openUserModal(${u.id})">${esc(u.name)}</strong>${selfTag}
            ${u.department ? `<div style="font-size:11px;color:var(--text-muted)">${esc(u.department)}</div>` : ''}
          </div>
        </div>
      </td>
      <td><span style="font-size:13px">${esc(u.email)}</span></td>
      <td><span class="badge ${roleBadge(u.role)}">${roleLabels[u.role] || u.role}</span></td>
      <td><span style="font-size:12px;color:var(--text-muted)">${permLabels || '-'}</span></td>
      <td><span style="font-size:12px">${lastActive}</span></td>
      <td><span class="badge ${statusBadge(u.status)}">${u.status}</span></td>
      <td>${actionMenu(menuItems)}</td>
    </tr>`;
  }).join('');
}

function showModalError(containerId, msg) {
  const el = document.getElementById(containerId);
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideModalError(containerId) {
  const el = document.getElementById(containerId);
  el.textContent = '';
  el.classList.add('hidden');
}

async function openUserModal(id) {
  const form = document.getElementById('user-form');
  form.reset();
  document.getElementById('user-id').value = '';
  hideModalError('user-modal-error');

  const isEdit = !!id;
  document.getElementById('user-modal-title').textContent = isEdit ? 'Edit User' : 'Add User';
  document.getElementById('user-save-btn').textContent = isEdit ? 'Save Changes' : 'Create User';

  // Password section: show for create, hide for edit (show reset button instead)
  document.getElementById('user-password-section').classList.toggle('hidden', isEdit);
  document.getElementById('reset-pw-section').classList.toggle('hidden', !isEdit);
  if (!isEdit) {
    document.getElementById('user-password').required = true;
    document.getElementById('user-password-confirm').required = true;
  } else {
    document.getElementById('user-password').required = false;
    document.getElementById('user-password-confirm').required = false;
  }

  // Populate department datalist from architecture roles
  try {
    const roles = await api('/api/architecture?arch_type=role');
    const datalist = document.getElementById('department-list');
    if (Array.isArray(roles)) {
      datalist.innerHTML = roles.map(r => `<option value="${esc(r.name)}">`).join('');
    }
  } catch(e) { /* datalist stays empty, user can still type freely */ }

  if (isEdit) {
    try {
      const u = await api(`/api/admin/users/${id}`);
      if (u.error) { showToast(u.error, 'error'); return; }

      document.getElementById('user-id').value = u.id;
      document.getElementById('user-fullname').value = u.name;
      document.getElementById('user-email').value = u.email;
      document.getElementById('user-role').value = u.role;
      document.getElementById('user-department').value = u.department || '';
      document.getElementById('user-status').value = u.status;
      document.getElementById('user-expiry').value = u.expiry_date || '';
      document.getElementById('user-notes').value = u.notes || '';

      let perms = [];
      try { perms = JSON.parse(u.permissions || '[]'); } catch(e) {}
      document.getElementById('perm-org').checked = perms.includes('org');
      document.getElementById('perm-risk').checked = perms.includes('risk');
      document.getElementById('perm-ops').checked = perms.includes('ops');
      document.getElementById('perm-audit').checked = perms.includes('audit');
      document.getElementById('perm-admin').checked = perms.includes('admin');
    } catch(e) {
      showToast('Failed to load user details', 'error');
      return;
    }
  }

  document.getElementById('user-modal').classList.remove('hidden');
}

function closeUserModal() {
  document.getElementById('user-modal').classList.add('hidden');
  hideModalError('user-modal-error');
}

async function saveUser(e) {
  e.preventDefault();
  hideModalError('user-modal-error');

  const id = document.getElementById('user-id').value;
  const isEdit = !!id;

  const permissions = [];
  if (document.getElementById('perm-org').checked) permissions.push('org');
  if (document.getElementById('perm-risk').checked) permissions.push('risk');
  if (document.getElementById('perm-ops').checked) permissions.push('ops');
  if (document.getElementById('perm-audit').checked) permissions.push('audit');
  if (document.getElementById('perm-admin').checked) permissions.push('admin');

  const body = {
    name: document.getElementById('user-fullname').value.trim(),
    email: document.getElementById('user-email').value.trim(),
    role: document.getElementById('user-role').value,
    department: document.getElementById('user-department').value.trim(),
    permissions,
    status: document.getElementById('user-status').value,
    expiry_date: document.getElementById('user-expiry').value || null,
    notes: document.getElementById('user-notes').value.trim(),
  };

  if (!body.name || !body.email) {
    showModalError('user-modal-error', 'Name and email are required.');
    return;
  }

  // For new users, validate and include password
  if (!isEdit) {
    const pw = document.getElementById('user-password').value;
    const pwConfirm = document.getElementById('user-password-confirm').value;
    if (!pw || pw.length < 6) {
      showModalError('user-modal-error', 'Password must be at least 6 characters.');
      return;
    }
    if (pw !== pwConfirm) {
      showModalError('user-modal-error', 'Passwords do not match.');
      return;
    }
    body.password = pw;
  }

  const saveBtn = document.getElementById('user-save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    let result;
    if (isEdit) {
      result = await api(`/api/admin/users/${id}`, { method: 'PUT', body });
    } else {
      result = await api('/api/admin/users', { method: 'POST', body });
    }

    if (result.error) {
      showModalError('user-modal-error', result.error);
      return;
    }

    closeUserModal();
    showToast(isEdit ? `User "${body.name}" updated successfully` : `User "${body.name}" created successfully`);
    loadAdminUsers();
  } catch(e) {
    showModalError('user-modal-error', 'An unexpected error occurred. Please try again.');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = isEdit ? 'Save Changes' : 'Create User';
  }
}

async function toggleUserStatus(id, status) {
  try {
    const result = await api(`/api/admin/users/${id}`, { method: 'PUT', body: { status } });
    if (result.error) { showToast(result.error, 'error'); return; }
    showToast(`User ${status === 'active' ? 'activated' : 'suspended'} successfully`);
    loadAdminUsers();
  } catch(e) {
    showToast('Failed to update user status', 'error');
  }
}

async function deleteUser(id, name) {
  if (!confirm(`Permanently delete user "${name || ''}"? This action cannot be undone.`)) return;
  try {
    const result = await api(`/api/admin/users/${id}`, { method: 'DELETE' });
    if (result.error) { showToast(result.error, 'error'); return; }
    showToast('User deleted successfully');
    loadAdminUsers();
  } catch(e) {
    showToast('Failed to delete user', 'error');
  }
}

// --- Password Reset ---
function openResetPasswordModal() {
  document.getElementById('reset-pw-form').reset();
  hideModalError('reset-pw-error');
  document.getElementById('reset-pw-modal').classList.remove('hidden');
}

function closeResetPasswordModal() {
  document.getElementById('reset-pw-modal').classList.add('hidden');
  hideModalError('reset-pw-error');
}

async function submitResetPassword(e) {
  e.preventDefault();
  hideModalError('reset-pw-error');

  const pw = document.getElementById('reset-pw-new').value;
  const pwConfirm = document.getElementById('reset-pw-confirm').value;

  if (!pw || pw.length < 6) {
    showModalError('reset-pw-error', 'Password must be at least 6 characters.');
    return;
  }
  if (pw !== pwConfirm) {
    showModalError('reset-pw-error', 'Passwords do not match.');
    return;
  }

  const userId = document.getElementById('user-id').value;
  if (!userId) {
    showModalError('reset-pw-error', 'No user selected.');
    return;
  }

  try {
    const result = await api(`/api/admin/users/${userId}/password`, { method: 'PUT', body: { password: pw } });
    if (result.error) {
      showModalError('reset-pw-error', result.error);
      return;
    }
    closeResetPasswordModal();
    showToast('Password reset successfully');
  } catch(e) {
    showModalError('reset-pw-error', 'Failed to reset password. Please try again.');
  }
}

// --- Admin: Audit Log ---
async function loadAdminAuditLog() {
  const params = new URLSearchParams();
  if (auditLogFilters.action) params.set('action', auditLogFilters.action);
  if (auditLogFilters.entity_type) params.set('entity_type', auditLogFilters.entity_type);
  params.set('limit', '50');
  params.set('offset', auditLogPage * 50);

  const result = await api(`/api/admin/audit-log?${params}`);

  // Filters
  document.getElementById('audit-log-filters').innerHTML = `
    <input type="text" placeholder="&#128269; Search actions..." value="${esc(auditLogFilters.action || '')}"
      style="padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius);font-size:13px;min-width:200px"
      oninput="auditLogFilters.action=this.value;auditLogPage=0;loadAdminAuditLog()">
    <select onchange="auditLogFilters.entity_type=this.value;auditLogPage=0;loadAdminAuditLog()">
      <option value="">All Types</option>
      <option value="user" ${auditLogFilters.entity_type==='user'?'selected':''}>Users</option>
      <option value="settings" ${auditLogFilters.entity_type==='settings'?'selected':''}>Settings</option>
      <option value="api_key" ${auditLogFilters.entity_type==='api_key'?'selected':''}>API Keys</option>
      <option value="webhook" ${auditLogFilters.entity_type==='webhook'?'selected':''}>Webhooks</option>
      <option value="backup" ${auditLogFilters.entity_type==='backup'?'selected':''}>Backups</option>
      <option value="system" ${auditLogFilters.entity_type==='system'?'selected':''}>System</option>
    </select>
    <span style="font-size:13px;color:var(--text-muted)">Showing ${result.logs.length} of ${result.total} entries</span>
  `;

  // Log list
  const list = document.getElementById('audit-log-list');
  if (result.logs.length === 0) {
    list.innerHTML = '<div class="empty-state">No audit log entries found.</div>';
  } else {
    list.innerHTML = result.logs.map(log => {
      const time = new Date(log.created_at).toLocaleString();
      const typeIcon = {
        user: '&#128100;', settings: '&#9881;', api_key: '&#128273;', webhook: '&#128279;',
        backup: '&#128190;', system: '&#128187;'
      }[log.entity_type] || '&#128196;';

      return `
        <div class="audit-log-item">
          <div class="audit-log-icon">${typeIcon}</div>
          <div class="audit-log-content">
            <div class="audit-log-action">
              <strong>${formatAuditAction(log.action)}</strong>
              ${log.entity_name ? `<span class="audit-log-entity">${esc(log.entity_name)}</span>` : ''}
            </div>
            <div class="audit-log-meta">
              <span class="audit-log-user">${esc(log.user_name)}</span>
              <span class="audit-log-time">${time}</span>
              ${log.details ? `<span class="audit-log-details">${esc(log.details.substring(0, 100))}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // Pagination
  const pagination = document.getElementById('audit-log-pagination');
  const totalPages = Math.ceil(result.total / 50);
  if (totalPages > 1) {
    pagination.innerHTML = `
      <button class="btn btn-secondary btn-sm" ${auditLogPage === 0 ? 'disabled' : ''} onclick="auditLogPage--;loadAdminAuditLog()">Previous</button>
      <span style="font-size:13px;color:var(--text-muted)">Page ${auditLogPage + 1} of ${totalPages}</span>
      <button class="btn btn-secondary btn-sm" ${auditLogPage >= totalPages - 1 ? 'disabled' : ''} onclick="auditLogPage++;loadAdminAuditLog()">Next</button>
    `;
  } else {
    pagination.innerHTML = '';
  }
}

async function exportAuditLog() {
  const result = await api('/api/admin/audit-log?limit=10000');
  const csv = 'Timestamp,User,Action,Entity Type,Entity Name,Details\n' +
    result.logs.map(l => `"${l.created_at}","${l.user_name}","${l.action}","${l.entity_type || ''}","${l.entity_name || ''}","${(l.details || '').replace(/"/g, '""')}"`).join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-log-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Admin: System Settings ---
async function loadAdminSettings() {
  const settings = await api('/api/admin/settings');

  // Populate form fields
  if (settings['org-name']) document.getElementById('setting-org-name').value = settings['org-name'];
  if (settings['language']) document.getElementById('setting-language').value = settings['language'];
  if (settings['date-format']) document.getElementById('setting-date-format').value = settings['date-format'];
  if (settings['fiscal-start']) document.getElementById('setting-fiscal-start').value = settings['fiscal-start'];

  document.getElementById('setting-2fa').checked = settings['2fa'] === true || settings['2fa'] === 'true';
  if (settings['session-timeout']) document.getElementById('setting-session-timeout').value = settings['session-timeout'];
  if (settings['password-expiry']) document.getElementById('setting-password-expiry').value = settings['password-expiry'];
  document.getElementById('setting-log-actions').checked = settings['log-actions'] !== false && settings['log-actions'] !== 'false';

  document.getElementById('setting-email-notifications').checked = settings['email-notifications'] !== false;
  if (settings['overdue-reminder']) document.getElementById('setting-overdue-reminder').value = settings['overdue-reminder'];
  document.getElementById('setting-audit-alerts').checked = settings['audit-alerts'] !== false;
  document.getElementById('setting-risk-alerts').checked = settings['risk-alerts'] !== false;

  if (settings['items-per-page']) document.getElementById('setting-items-per-page').value = settings['items-per-page'];
  if (settings['default-dashboard']) document.getElementById('setting-default-dashboard').value = settings['default-dashboard'];
  document.getElementById('setting-show-completed').checked = settings['show-completed'] === true;
  document.getElementById('setting-compact-mode').checked = settings['compact-mode'] === true;
}

async function saveSystemSettings() {
  const settings = {
    'org-name': document.getElementById('setting-org-name').value,
    'language': document.getElementById('setting-language').value,
    'date-format': document.getElementById('setting-date-format').value,
    'fiscal-start': document.getElementById('setting-fiscal-start').value,
    '2fa': document.getElementById('setting-2fa').checked,
    'session-timeout': parseInt(document.getElementById('setting-session-timeout').value),
    'password-expiry': parseInt(document.getElementById('setting-password-expiry').value),
    'log-actions': document.getElementById('setting-log-actions').checked,
    'email-notifications': document.getElementById('setting-email-notifications').checked,
    'overdue-reminder': parseInt(document.getElementById('setting-overdue-reminder').value),
    'audit-alerts': document.getElementById('setting-audit-alerts').checked,
    'risk-alerts': document.getElementById('setting-risk-alerts').checked,
    'items-per-page': document.getElementById('setting-items-per-page').value,
    'default-dashboard': document.getElementById('setting-default-dashboard').value,
    'show-completed': document.getElementById('setting-show-completed').checked,
    'compact-mode': document.getElementById('setting-compact-mode').checked,
  };

  await api('/api/admin/settings', { method: 'PUT', body: settings });
  alert('Settings saved successfully!');
}

// --- Admin: Data Management ---
async function loadAdminData() {
  // Load backups
  const backups = await api('/api/admin/backups');
  const backupList = document.getElementById('backup-list');

  if (backups.length === 0) {
    backupList.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px 0">No backups available.</div>';
  } else {
    backupList.innerHTML = `
      <table class="task-table" style="margin-top:12px">
        <thead><tr><th>Filename</th><th>Size</th><th>Type</th><th>Created</th><th></th></tr></thead>
        <tbody>
          ${backups.slice(0, 10).map(b => {
            const sizeMB = (b.size / (1024 * 1024)).toFixed(2);
            const created = new Date(b.created_at).toLocaleString();
            return `<tr>
              <td style="font-size:13px">${esc(b.filename)}</td>
              <td style="font-size:13px">${sizeMB} MB</td>
              <td><span class="badge ${b.type === 'scheduled' ? 'badge-low' : 'badge-medium'}">${b.type}</span></td>
              <td style="font-size:12px">${created}</td>
              <td>
                <button class="btn btn-secondary btn-sm" onclick="downloadBackup(${b.id})">&#128229;</button>
                <button class="btn btn-secondary btn-sm" onclick="deleteBackup(${b.id})" style="color:var(--danger)">&#128465;</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  // Import dropzone
  const dropzone = document.getElementById('import-dropzone');
  dropzone.onclick = () => document.getElementById('import-file').click();
  dropzone.ondragover = (e) => { e.preventDefault(); dropzone.classList.add('dragover'); };
  dropzone.ondragleave = () => dropzone.classList.remove('dragover');
  dropzone.ondrop = (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleImportFile({ files: e.dataTransfer.files });
  };
}

function handleImportFile(input) {
  const file = input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      const preview = document.getElementById('import-preview');

      let summary = '<strong>Import Preview:</strong><ul style="margin-top:8px;font-size:13px">';
      if (data.tasks) summary += `<li>${data.tasks.length} tasks</li>`;
      if (data.risks) summary += `<li>${data.risks.length} risks</li>`;
      if (data.audits) summary += `<li>${data.audits.length} audits</li>`;
      if (data.architecture) summary += `<li>${data.architecture.length} architecture items</li>`;
      if (data.requirements) summary += `<li>${data.requirements.length} requirements</li>`;
      if (data.documents) summary += `<li>${data.documents.length} documents</li>`;
      summary += '</ul>';

      preview.innerHTML = summary;
      preview.classList.remove('hidden');
      document.getElementById('import-btn').disabled = false;
      window._importData = data;
    } catch (err) {
      alert('Invalid file format. Please upload a valid JSON export file.');
    }
  };
  reader.readAsText(file);
}

async function executeImport() {
  if (!window._importData) return alert('No file loaded');
  if (!confirm('This will import the data. Existing items will be skipped. Continue?')) return;

  const btn = document.getElementById('import-btn');
  btn.disabled = true;
  btn.textContent = 'Importing...';

  try {
    const result = await api('/api/admin/import', { method: 'POST', body: window._importData });

    let summary = 'Import completed!\n\n';
    if (result.imported) {
      for (const [key, count] of Object.entries(result.imported)) {
        if (count > 0) summary += `- ${key}: ${count} items\n`;
      }
    }
    if (result.errors && result.errors.length > 0) {
      summary += `\nErrors: ${result.errors.length}`;
    }

    alert(summary);
    document.getElementById('import-preview').classList.add('hidden');
    document.getElementById('import-preview').innerHTML = '';
    window._importData = null;
    btn.textContent = 'Import Data';
  } catch (err) {
    alert('Import failed: ' + err.message);
    btn.textContent = 'Import Data';
  }
  btn.disabled = true;
}

async function exportData(format) {
  const includes = [];
  if (document.getElementById('export-tasks').checked) includes.push('tasks');
  if (document.getElementById('export-risks').checked) includes.push('risks');
  if (document.getElementById('export-audits').checked) includes.push('audits');
  if (document.getElementById('export-architecture').checked) includes.push('architecture');
  if (document.getElementById('export-requirements').checked) includes.push('requirements');
  if (document.getElementById('export-documents').checked) includes.push('documents');

  if (includes.length === 0) {
    alert('Please select at least one data type to export.');
    return;
  }

  window.open(`/api/admin/export?format=${format}&include=${includes.join(',')}`, '_blank');
}

async function createBackup() {
  const result = await api('/api/admin/backups', { method: 'POST', body: { type: 'manual' } });
  alert(`Backup created: ${result.filename}`);
  loadAdminData();
}

function downloadBackup(id) {
  window.open(`/api/admin/backups/${id}/download`, '_blank');
}

async function deleteBackup(id) {
  if (!confirm('Delete this backup?')) return;
  await api(`/api/admin/backups/${id}`, { method: 'DELETE' });
  loadAdminData();
}

async function cleanupData(type) {
  const messages = {
    history: 'This will permanently delete completion history older than 1 year.',
    archive: 'This will archive closed items.',
    logs: 'This will permanently delete audit logs older than 90 days.'
  };
  if (!confirm(messages[type] + ' Continue?')) return;

  const result = await api('/api/admin/cleanup', { method: 'POST', body: { type } });
  alert(`Cleanup complete. ${result.affected} items affected.`);
}

// --- Admin: Integrations ---
async function loadAdminIntegrations() {
  // Load settings and API keys in parallel
  const [apiKeys, settings] = await Promise.all([
    api('/api/admin/api-keys'),
    api('/api/admin/settings')
  ]);
  const keysList = document.getElementById('api-keys-list');

  if (apiKeys.length === 0) {
    keysList.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No API keys generated yet.</div>';
  } else {
    keysList.innerHTML = apiKeys.map(k => {
      let perms = [];
      try { perms = JSON.parse(k.permissions || '[]'); } catch(e) {}
      const lastUsed = k.last_used ? new Date(k.last_used).toLocaleDateString() : 'Never';
      const statusClass = k.status === 'active' ? 'badge-low' : 'badge-inactive';

      return `
        <div class="api-key-item">
          <div class="api-key-info">
            <strong>${esc(k.name)}</strong>
            <code class="api-key-prefix">${esc(k.key_prefix)}</code>
            <span class="badge ${statusClass}">${k.status}</span>
          </div>
          <div class="api-key-meta">
            <span>Permissions: ${perms.join(', ')}</span>
            <span>Last used: ${lastUsed}</span>
          </div>
          ${k.status === 'active' ? `<button class="btn btn-danger btn-sm" onclick="revokeApiKey(${k.id})">Revoke</button>` : ''}
        </div>
      `;
    }).join('');
  }

  // Load webhooks
  const webhooks = await api('/api/admin/webhooks');
  const webhooksList = document.getElementById('webhooks-list');

  if (webhooks.length === 0) {
    webhooksList.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No webhooks configured yet.</div>';
  } else {
    webhooksList.innerHTML = webhooks.map(w => {
      let events = [];
      try { events = JSON.parse(w.events || '[]'); } catch(e) {}
      const statusClass = w.status === 'active' ? 'badge-low' : 'badge-inactive';
      const lastTriggered = w.last_triggered ? new Date(w.last_triggered).toLocaleDateString() : 'Never';

      return `
        <div class="webhook-item">
          <div class="webhook-info">
            <strong style="cursor:pointer;color:var(--primary)" onclick="openWebhookModal(${w.id})">${esc(w.name)}</strong>
            <span class="badge ${statusClass}">${w.status}</span>
            ${w.failure_count > 0 ? `<span class="badge badge-high" style="cursor:pointer" onclick="resetWebhookFailures(${w.id})" title="Click to reset">${w.failure_count} failures</span>` : ''}
          </div>
          <div class="webhook-url">${esc(w.url)}</div>
          <div class="webhook-meta">
            <span>Events: ${events.length > 0 ? events.join(', ') : 'None'}</span>
            <span>Last triggered: ${lastTriggered}</span>
          </div>
          <div class="webhook-actions">
            <button class="btn btn-secondary btn-sm" onclick="testWebhook(${w.id})" title="Send test payload">&#128172; Test</button>
            <button class="btn btn-secondary btn-sm" onclick="openWebhookModal(${w.id})">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteWebhook(${w.id})">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // Update connected services status
  const servicesContainer = document.getElementById('connected-services');
  if (servicesContainer) {
    const smtpConfigured = settings['smtp-server'] && settings['smtp-server'].length > 0;
    const slackConfigured = settings['slack-webhook'] && settings['slack-webhook'].length > 0;

    servicesContainer.innerHTML = `
      <div class="service-card ${smtpConfigured ? 'connected' : 'available'}">
        <div class="service-icon">&#128231;</div>
        <div class="service-info">
          <h4>Email (SMTP)</h4>
          <p>${smtpConfigured ? 'Connected to ' + esc(settings['smtp-server']) : 'Send notifications via your email server'}</p>
        </div>
        <span class="service-status ${smtpConfigured ? 'connected' : ''}">${smtpConfigured ? '&#9989; Connected' : ''}</span>
        <button class="btn btn-secondary btn-sm" onclick="configureService('smtp')">${smtpConfigured ? 'Reconfigure' : 'Configure'}</button>
      </div>
      <div class="service-card ${slackConfigured ? 'connected' : 'available'}">
        <div class="service-icon">&#128172;</div>
        <div class="service-info">
          <h4>Slack</h4>
          <p>${slackConfigured ? 'Connected to ' + esc(settings['slack-channel'] || 'Slack') : 'Send alerts to Slack channels'}</p>
        </div>
        <span class="service-status ${slackConfigured ? 'connected' : ''}">${slackConfigured ? '&#9989; Connected' : ''}</span>
        <button class="btn btn-secondary btn-sm" onclick="configureService('slack')">${slackConfigured ? 'Reconfigure' : 'Connect'}</button>
      </div>
      <div class="service-card available">
        <div class="service-icon">&#128196;</div>
        <div class="service-info">
          <h4>Microsoft 365</h4>
          <p>Sync with SharePoint and Teams</p>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="configureService('m365')">Connect</button>
      </div>
      <div class="service-card available">
        <div class="service-icon">&#128200;</div>
        <div class="service-info">
          <h4>Power BI</h4>
          <p>Export data to Power BI dashboards</p>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="configureService('powerbi')">Connect</button>
      </div>
    `;
  }

  // Load SAML configuration
  loadSamlConfig();
}

// --- SAML/SSO Functions ---
async function loadSamlConfig() {
  const config = await api('/api/admin/saml/config');
  const baseUrl = window.location.origin;

  // Update SP info
  document.getElementById('sp-entity-id').textContent = `${baseUrl}/saml/metadata`;
  document.getElementById('sp-acs-url').textContent = `${baseUrl}/saml/callback`;
  document.getElementById('sp-metadata-url').textContent = `${baseUrl}/saml/metadata`;

  // Update status
  const statusIndicator = document.querySelector('#saml-status .status-indicator');
  const statusText = document.querySelector('#saml-status .status-text');
  const enabledCheckbox = document.getElementById('saml-enabled');

  if (config.enabled) {
    statusIndicator.className = 'status-indicator enabled';
    statusText.textContent = 'SSO Enabled';
    enabledCheckbox.checked = true;
  } else {
    statusIndicator.className = 'status-indicator disabled';
    statusText.textContent = 'SSO Disabled';
    enabledCheckbox.checked = false;
  }

  // Populate form fields
  document.getElementById('saml-entity-id').value = config.entity_id || '';
  document.getElementById('saml-sso-url').value = config.sso_url || '';
  document.getElementById('saml-slo-url').value = config.slo_url || '';
  document.getElementById('saml-certificate').value = config.certificate || '';
  document.getElementById('saml-auto-provision').checked = config.auto_provision !== 0;
  document.getElementById('saml-default-role').value = config.default_role || 'user';
  document.getElementById('saml-allowed-domains').value = config.allowed_domains || '';

  // Show certificate placeholder if configured
  if (config.has_certificate) {
    document.getElementById('saml-certificate').placeholder = '[Certificate configured - enter new to replace]';
  }
}

function toggleSamlEnabled() {
  const enabled = document.getElementById('saml-enabled').checked;
  const statusIndicator = document.querySelector('#saml-status .status-indicator');
  const statusText = document.querySelector('#saml-status .status-text');

  if (enabled) {
    statusIndicator.className = 'status-indicator enabled';
    statusText.textContent = 'SSO Enabled';
  } else {
    statusIndicator.className = 'status-indicator disabled';
    statusText.textContent = 'SSO Disabled';
  }
}

async function saveSamlConfig() {
  const config = {
    enabled: document.getElementById('saml-enabled').checked,
    entity_id: document.getElementById('saml-entity-id').value,
    sso_url: document.getElementById('saml-sso-url').value,
    slo_url: document.getElementById('saml-slo-url').value,
    certificate: document.getElementById('saml-certificate').value,
    auto_provision: document.getElementById('saml-auto-provision').checked,
    default_role: document.getElementById('saml-default-role').value,
    allowed_domains: document.getElementById('saml-allowed-domains').value
  };

  // Validate required fields if enabled
  if (config.enabled) {
    if (!config.entity_id || !config.sso_url) {
      alert('Please fill in the required IdP Entity ID and SSO URL fields.');
      return;
    }
  }

  try {
    await api('/api/admin/saml/config', { method: 'PUT', body: config });
    alert('SAML configuration saved successfully!');
    loadSamlConfig();
  } catch (err) {
    alert('Failed to save SAML configuration: ' + err.message);
  }
}

async function testSamlConfig() {
  const resultEl = document.getElementById('saml-test-result');
  resultEl.classList.remove('hidden');
  resultEl.className = 'saml-test-result loading';
  resultEl.innerHTML = '<span>&#8987;</span> Testing configuration...';

  try {
    const result = await api('/api/admin/saml/test', { method: 'POST' });

    if (result.success) {
      resultEl.className = 'saml-test-result success';
      resultEl.innerHTML = `
        <div class="test-success">
          <span>&#9989;</span> ${esc(result.message)}
        </div>
        <div class="test-urls">
          <div><strong>Metadata URL:</strong> <code>${esc(result.metadata_url)}</code></div>
          <div><strong>Callback URL:</strong> <code>${esc(result.callback_url)}</code></div>
        </div>
        <a href="/saml/login" target="_blank" class="btn btn-primary btn-sm" style="margin-top:12px">&#128274; Test SSO Login</a>
      `;
    } else {
      resultEl.className = 'saml-test-result error';
      resultEl.innerHTML = `
        <div class="test-error">
          <span>&#10060;</span> Configuration issues found:
        </div>
        <ul class="test-issues">
          ${result.issues.map(i => `<li>${esc(i)}</li>`).join('')}
        </ul>
      `;
    }
  } catch (err) {
    resultEl.className = 'saml-test-result error';
    resultEl.innerHTML = `<span>&#10060;</span> Test failed: ${esc(err.message)}`;
  }
}

function copySamlField(fieldId) {
  const text = document.getElementById(fieldId).textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.querySelector(`#${fieldId} + .btn-copy`);
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '&#9989;';
    setTimeout(() => btn.innerHTML = originalHtml, 1500);
  });
}

function generateApiKey() {
  // Open the API key modal
  document.getElementById('api-key-form').reset();
  document.getElementById('api-key-result').classList.add('hidden');
  document.getElementById('api-key-modal').classList.remove('hidden');
}

function closeApiKeyModal() {
  document.getElementById('api-key-modal').classList.add('hidden');
  // Refresh list if a key was created
  if (!document.getElementById('api-key-result').classList.contains('hidden')) {
    loadAdminIntegrations();
  }
}

async function createApiKey(e) {
  e.preventDefault();

  const permissions = [];
  if (document.getElementById('api-perm-read').checked) permissions.push('read');
  if (document.getElementById('api-perm-write').checked) permissions.push('write');
  if (document.getElementById('api-perm-delete').checked) permissions.push('delete');
  if (document.getElementById('api-perm-admin').checked) permissions.push('admin');

  const body = {
    name: document.getElementById('api-key-name').value,
    permissions,
    expires_at: document.getElementById('api-key-expiry').value || null
  };

  const result = await api('/api/admin/api-keys', { method: 'POST', body });

  // Show the key
  document.getElementById('api-key-display').textContent = result.key;
  document.getElementById('api-key-result').classList.remove('hidden');

  // Hide the form
  document.getElementById('api-key-form').classList.add('hidden');
}

function copyApiKey() {
  const key = document.getElementById('api-key-display').textContent;
  navigator.clipboard.writeText(key).then(() => {
    alert('API key copied to clipboard!');
  });
}

async function revokeApiKey(id) {
  if (!confirm('Revoke this API key? Applications using it will stop working.')) return;
  await api(`/api/admin/api-keys/${id}`, { method: 'DELETE' });
  loadAdminIntegrations();
}

function openWebhookModal(id) {
  document.getElementById('webhook-form').reset();
  document.getElementById('webhook-id').value = '';
  document.getElementById('webhook-modal-title').textContent = 'Add Webhook';

  if (id) {
    api('/api/admin/webhooks').then(webhooks => {
      const w = webhooks.find(x => x.id === id);
      if (w) {
        document.getElementById('webhook-modal-title').textContent = 'Edit Webhook';
        document.getElementById('webhook-id').value = w.id;
        document.getElementById('webhook-name').value = w.name;
        document.getElementById('webhook-url').value = w.url;
        document.getElementById('webhook-secret').value = w.secret || '';
        document.getElementById('webhook-status').value = w.status;

        let events = [];
        try { events = JSON.parse(w.events || '[]'); } catch(e) {}
        document.getElementById('hook-task-complete').checked = events.includes('task_complete');
        document.getElementById('hook-task-overdue').checked = events.includes('task_overdue');
        document.getElementById('hook-risk-high').checked = events.includes('risk_high');
        document.getElementById('hook-audit-complete').checked = events.includes('audit_complete');
        document.getElementById('hook-ncr-created').checked = events.includes('ncr_created');
        document.getElementById('hook-doc-approved').checked = events.includes('doc_approved');
      }
    });
  }

  document.getElementById('webhook-modal').classList.remove('hidden');
}

function closeWebhookModal() {
  document.getElementById('webhook-modal').classList.add('hidden');
}

async function saveWebhook(e) {
  e.preventDefault();
  const id = document.getElementById('webhook-id').value;

  const events = [];
  if (document.getElementById('hook-task-complete').checked) events.push('task_complete');
  if (document.getElementById('hook-task-overdue').checked) events.push('task_overdue');
  if (document.getElementById('hook-risk-high').checked) events.push('risk_high');
  if (document.getElementById('hook-audit-complete').checked) events.push('audit_complete');
  if (document.getElementById('hook-ncr-created').checked) events.push('ncr_created');
  if (document.getElementById('hook-doc-approved').checked) events.push('doc_approved');

  const body = {
    name: document.getElementById('webhook-name').value,
    url: document.getElementById('webhook-url').value,
    events,
    secret: document.getElementById('webhook-secret').value,
    status: document.getElementById('webhook-status').value,
  };

  if (id) {
    await api(`/api/admin/webhooks/${id}`, { method: 'PUT', body });
  } else {
    await api('/api/admin/webhooks', { method: 'POST', body });
  }

  closeWebhookModal();
  loadAdminIntegrations();
}

async function deleteWebhook(id) {
  if (!confirm('Delete this webhook?')) return;
  await api(`/api/admin/webhooks/${id}`, { method: 'DELETE' });
  loadAdminIntegrations();
}

async function testWebhook(id) {
  const btn = event.target;
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '&#8987; Testing...';

  try {
    const result = await api(`/api/admin/webhooks/${id}/test`, { method: 'POST' });
    if (result.success) {
      alert(`Webhook test successful!\n\nStatus: ${result.statusCode}\nResponse: ${result.response || '(empty)'}`);
    } else {
      alert(`Webhook test failed:\n${result.error}`);
    }
  } catch (err) {
    alert(`Webhook test failed:\n${err.message}`);
  }

  btn.disabled = false;
  btn.innerHTML = originalText;
  loadAdminIntegrations();
}

async function resetWebhookFailures(id) {
  if (!confirm('Reset failure count for this webhook?')) return;
  await api(`/api/admin/webhooks/${id}/reset-failures`, { method: 'POST' });
  loadAdminIntegrations();
}

function configureService(service) {
  const modal = document.getElementById('service-modal');
  const content = document.getElementById('service-modal-content');
  document.getElementById('service-modal-title').textContent = 'Configure ' + service.toUpperCase();

  const configs = {
    smtp: `
      <form id="smtp-form" onsubmit="saveServiceConfig('smtp', event)">
        <div class="form-group"><label>SMTP Server</label><input type="text" id="smtp-server" placeholder="smtp.example.com"></div>
        <div class="form-row">
          <div class="form-group"><label>Port</label><input type="number" id="smtp-port" value="587"></div>
          <div class="form-group"><label>Encryption</label><select id="smtp-encryption"><option value="tls">TLS</option><option value="ssl">SSL</option><option value="none">None</option></select></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Username</label><input type="text" id="smtp-user" placeholder="Email or username"></div>
          <div class="form-group"><label>Password</label><input type="password" id="smtp-pass"></div>
        </div>
        <div class="form-group"><label>From Address</label><input type="email" id="smtp-from" placeholder="noreply@example.com"></div>
        <div class="form-actions"><button type="button" class="btn btn-secondary" onclick="closeServiceModal()">Cancel</button><button type="submit" class="btn btn-primary">Save Configuration</button></div>
      </form>`,
    slack: `
      <form id="slack-form" onsubmit="saveServiceConfig('slack', event)">
        <div class="form-group"><label>Slack Webhook URL</label><input type="url" id="slack-webhook" placeholder="https://hooks.slack.com/services/..."></div>
        <div class="form-group"><label>Default Channel</label><input type="text" id="slack-channel" placeholder="#notifications"></div>
        <div class="form-actions"><button type="button" class="btn btn-secondary" onclick="closeServiceModal()">Cancel</button><button type="submit" class="btn btn-primary">Connect Slack</button></div>
      </form>`,
    m365: `<div style="text-align:center;padding:40px"><p style="color:var(--text-muted);margin-bottom:20px">Microsoft 365 integration requires OAuth setup.</p><button class="btn btn-primary" onclick="alert('OAuth flow would start here')">Sign in with Microsoft</button></div>`,
    powerbi: `<div style="text-align:center;padding:40px"><p style="color:var(--text-muted);margin-bottom:20px">Power BI integration requires OAuth setup.</p><button class="btn btn-primary" onclick="alert('OAuth flow would start here')">Connect Power BI</button></div>`,
  };

  content.innerHTML = configs[service] || '<p>Configuration not available.</p>';
  modal.classList.remove('hidden');
}

function closeServiceModal() {
  document.getElementById('service-modal').classList.add('hidden');
}

async function saveServiceConfig(service, e) {
  e.preventDefault();
  // Save configuration to system settings
  const settings = {};
  if (service === 'smtp') {
    settings['smtp-server'] = document.getElementById('smtp-server').value;
    settings['smtp-port'] = document.getElementById('smtp-port').value;
    settings['smtp-encryption'] = document.getElementById('smtp-encryption').value;
    settings['smtp-user'] = document.getElementById('smtp-user').value;
    settings['smtp-from'] = document.getElementById('smtp-from').value;
  } else if (service === 'slack') {
    settings['slack-webhook'] = document.getElementById('slack-webhook').value;
    settings['slack-channel'] = document.getElementById('slack-channel').value;
  }

  await api('/api/admin/settings', { method: 'PUT', body: settings });
  closeServiceModal();
  alert('Configuration saved!');
}

// --- Init ---
// Wait for auth check before loading the default view. Superadmins without an
// active org context see the MSP portal instead. Non-superadmin users land on
// the first view they have permission for (mission-control if 'org' is allowed).
userReady.then(showingMSP => {
  if (showingMSP) return;
  if (hasPermissionForView('mission-control')) {
    loadMissionControl();
  }
  // If mission-control is not permitted, applyModulePermissions() in
  // loadCurrentUser already navigated to the first accessible view.
});
