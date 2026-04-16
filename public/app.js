// --- State ---
let currentView = 'mission-control';
let allTasks = [];
let meta = { assignees: [], categories: [] };
let filters = { active: 'true', assignee: '', category: '', priority: '', search: '' };
let actionFilters = { status: '', priority: '', assignee: '' };
let yearlyFilters = { priority: '', overdue_only: false, search: '' };
let historySearch = '';
let yearlyYear = new Date().getFullYear();
let lastCompletionContext = null; // { completion_id, task_id }
let yearlyData = null; // cached yearly API data
let yearlyUpcomingCache = []; // raw overdue+upcoming items for filter re-renders
let currentUser = null;
let isSuperadmin = false;
let activeOrg = null; // { id, name, slug } when superadmin is inside an org

// --- Operational Planning process context ---
const OP_PLAN_VIEWS = ['tasks', 'yearly', 'actions', 'history'];
let opPlanContext = { type: 'all', id: null }; // type: 'all' | 'process' | 'bundle'
let opPlanProcesses = []; // cached list of processes from org_architecture
let opPlanBundles = [];   // cached list of plan_bundles

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
          <span style="color: #6b7280; font-size: 13px;">Logged in as <strong>${esc(currentUser?.name || 'Superadmin')}</strong></span>
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
  banner.innerHTML = `
    <span>Viewing as: <strong>${escapeHtml(activeOrg.name)}</strong></span>
    <a href="#" onclick="backToMSP(); return false;" style="color: #fff; text-decoration: underline; font-weight: 600; cursor: pointer;">Back to MSP Portal</a>
  `;
  document.body.prepend(banner);
  document.body.classList.add('has-org-banner');
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Load user on page load — stored as promise so init can await it
const userReady = loadCurrentUser();

// --- Sidebar Toggle (desktop: icon-rail collapse) ---
function toggleSidebar() {
  const sb = document.querySelector('.sidebar');
  sb.classList.toggle('collapsed');
  localStorage.setItem('sidebarCollapsed', sb.classList.contains('collapsed'));
}
if (localStorage.getItem('sidebarCollapsed') === 'true') {
  document.querySelector('.sidebar').classList.add('collapsed');
}

// --- Mobile Navigation (hamburger drawer) ---
function isMobile() { return window.matchMedia('(max-width: 767px)').matches; }

function toggleMobileNav() {
  const sb  = document.querySelector('.sidebar');
  const ov  = document.getElementById('sidebar-overlay');
  const btn = document.getElementById('hamburger-btn');
  const open = sb.classList.toggle('mobile-open');
  ov.classList.toggle('active', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  // Prevent body scroll when drawer is open
  document.body.style.overflow = open ? 'hidden' : '';
}

function closeMobileNav() {
  const sb  = document.querySelector('.sidebar');
  const ov  = document.getElementById('sidebar-overlay');
  const btn = document.getElementById('hamburger-btn');
  if (!sb) return;
  sb.classList.remove('mobile-open');
  ov.classList.remove('active');
  btn.setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
}

// Close drawer automatically when a view is selected on mobile
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', () => { if (isMobile()) closeMobileNav(); });
});

// Close drawer on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeMobileNav();
});

// --- Navigation ---
// Module toggles (expand/collapse, or direct navigation when data-view is set)
document.querySelectorAll('.module-toggle').forEach(toggle => {
  toggle.addEventListener('click', e => {
    e.preventDefault();

    // Modules with data-view navigate directly (e.g. AI Agent – no submenu)
    if (toggle.dataset.view) {
      switchView(toggle.dataset.view);
      if (isMobile()) closeMobileNav();
      return;
    }

    const sb = document.querySelector('.sidebar');
    const submenu = toggle.nextElementSibling;
    if (!submenu) return; // guard for direct-nav modules

    // On mobile the drawer is always full-width – just toggle the submenu
    if (!isMobile() && sb.classList.contains('collapsed')) {
      // Desktop collapsed: expand sidebar and open this module's submenu
      sb.classList.remove('collapsed');
      localStorage.setItem('sidebarCollapsed', 'false');
      document.querySelectorAll('.module-submenu').forEach(s => s.classList.remove('open'));
      document.querySelectorAll('.module-toggle').forEach(t => t.classList.add('collapsed'));
      submenu.classList.add('open');
      toggle.classList.remove('collapsed');
    } else {
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

function showViewLoadingState(viewId) {
  const panel = document.getElementById(`view-${viewId}`);
  if (!panel) return;
  const body = panel.querySelector('.view-body');
  if (!body) return;
  body.innerHTML = `
    <div class="loading-skeleton" aria-label="Loading" role="status">
      <div class="skeleton-row"></div>
      <div class="skeleton-row skeleton-row--short"></div>
      <div class="skeleton-row"></div>
      <div class="skeleton-row skeleton-row--short"></div>
      <div class="skeleton-row"></div>
    </div>`;
}

function switchView(view) {
  if (!hasPermissionForView(view)) return;
  currentView = view;
  closeDayDetail();
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(`view-${view}`).classList.remove('hidden');
  showViewLoadingState(view);
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

  // Show or hide the process context bar
  const ctxBar = document.getElementById('op-plan-context-bar');
  if (ctxBar) {
    if (OP_PLAN_VIEWS.includes(view)) {
      ctxBar.classList.remove('hidden');
      loadOpPlanContextData().then(() => renderOpPlanContextBar());
    } else {
      ctxBar.classList.add('hidden');
    }
  }

  if (view === 'tasks') loadTasks();
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
  else if (view === 'my-tasks') loadMyTasks();
  else if (view === 'management-reviews') loadManagementReviews();
  else if (view === 'use-cases') loadUseCases();
  // Admin views
  else if (view === 'admin-users') loadAdminUsers();
  else if (view === 'admin-audit-log') loadAdminAuditLog();
  else if (view === 'admin-settings') loadAdminSettings();
  else if (view === 'admin-data') loadAdminData();
  else if (view === 'admin-integrations') loadAdminIntegrations();
  else if (view === 'ai-agent') loadAIAgent();
}

// --- API helpers ---
async function api(url, options = {}) {
  const { signal: callerSignal, timeout = 20000, ...fetchOptions } = options;

  // Combine an optional caller AbortSignal with a per-request timeout so that:
  //   • switching tabs aborts all in-flight requests immediately (callerSignal)
  //   • a hung corporate proxy / SSL-inspection box never blocks forever (timeout)
  const timeoutCtrl = new AbortController();
  const timerId = setTimeout(() => timeoutCtrl.abort(new DOMException('Request timed out', 'TimeoutError')), timeout);

  let signal;
  if (callerSignal && typeof AbortSignal.any === 'function') {
    // Modern browsers: combine both signals natively
    signal = AbortSignal.any([callerSignal, timeoutCtrl.signal]);
  } else if (callerSignal) {
    // Fallback: forward caller's abort into the timeout controller
    callerSignal.addEventListener('abort', () => timeoutCtrl.abort(callerSignal.reason), { once: true });
    signal = timeoutCtrl.signal;
  } else {
    signal = timeoutCtrl.signal;
  }

  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...fetchOptions,
      body: fetchOptions.body ? JSON.stringify(fetchOptions.body) : undefined,
      signal,
    });
    clearTimeout(timerId);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body.error || `HTTP ${res.status}`;
      console.error(`[API] ${fetchOptions.method || 'GET'} ${url} → ${res.status}: ${msg}`);
      throw new Error(msg);
    }
    return res.json();
  } catch (err) {
    clearTimeout(timerId);
    throw err;
  }
}

// Run async tasks with bounded concurrency to avoid overwhelming connections
async function batchAll(items, fn, concurrency = 6) {
  const results = [];
  let i = 0;
  async function next() {
    const idx = i++;
    if (idx >= items.length) return;
    results[idx] = await fn(items[idx], idx);
    await next();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
  return results;
}

// --- Cross-Link System ---
const linkableTypes = {
  risk: { label: 'Risk', icon: '&#9888;', canLink: ['role','process','system','asset','facility','requirement','document','task','action','usecase','ai_model','ai_dataset','ai_usecase'] },
  task: { label: 'Task', icon: '&#9881;', canLink: ['role','process','asset','facility','risk','document','requirement','action','usecase'] },
  action: { label: 'Action', icon: '&#9889;', canLink: ['role','process','task','risk','document','requirement','usecase'] },
  audit: { label: 'Audit', icon: '&#9998;', canLink: ['role','process','requirement','risk','document','usecase','ai_usecase'] },
  requirement: { label: 'Requirement', icon: '&#128220;', canLink: ['process','role','document','risk','treatment','task','action','system','asset','audit','usecase','ai_model','ai_usecase'] },
  role: { label: 'Role', icon: '&#128100;', canLink: ['risk','task','audit','process','system','document','action','usecase','ai_model','ai_dataset','ai_usecase'] },
  process: { label: 'Process', icon: '&#128260;', canLink: ['risk','task','audit','role','system','asset','document','action','usecase','ai_model','ai_usecase'] },
  system: { label: 'System', icon: '&#128187;', canLink: ['risk','process','role','asset','document','usecase','ai_model','ai_dataset'] },
  asset: { label: 'Asset', icon: '&#128230;', canLink: ['risk','task','process','facility','document','usecase'] },
  facility: { label: 'Facility', icon: '&#127970;', canLink: ['risk','task','asset','document','usecase'] },
  document: { label: 'Document', icon: '&#128196;', canLink: ['risk','task','audit','requirement','role','process','system','asset','facility','action','usecase','ai_model','ai_dataset','ai_usecase'] },
  ncr: { label: 'NCR', icon: '&#9888;', canLink: ['risk','requirement','document','role','action','usecase'] },
  treatment: { label: 'Treatment', icon: '&#128737;', canLink: ['requirement','document','role','process','system','asset','usecase'] },
  checklist: { label: 'Checklist Item', icon: '&#9745;', canLink: ['document','process','system','asset','usecase'] },
  usecase: { label: 'AI Use Case', icon: '&#127919;', canLink: ['risk','task','action','requirement','document','role','process','system','asset','audit','ncr','treatment','ai_model','ai_dataset','ai_usecase'] },
  ai_model:   { label: 'AI Model',   icon: '&#129302;', canLink: ['system','process','role','risk','document','ai_dataset','ai_usecase','requirement'] },
  ai_dataset: { label: 'Dataset',    icon: '&#128202;', canLink: ['ai_model','system','process','role','risk','document','supplier'] },
  ai_usecase: { label: 'AI Use Case',icon: '&#127919;', canLink: ['ai_model','ai_dataset','process','role','risk','document','system','audit','requirement'] },
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
  // ai_usecase items live in the Kanban board, not the Architecture view
  if (type === 'ai_usecase') return `openUseCaseModal(${id})`;
  const archTypes = ['role','process','system','asset','facility','ai_model','ai_dataset'];
  if (archTypes.includes(type)) {
    return `currentArchTab='${type}';switchView('architecture')`;
  }
  const viewMap = {
    risk: 'risk-identification', task: 'tasks', audit: 'audit-plan',
    requirement: 'audit-requirements', document: 'document-control', ncr: 'audit-ncrs',
    action: 'actions', usecase: 'use-cases',
  };
  const view = viewMap[type];
  return view ? `switchView('${view}')` : null;
}

async function openCrossLinkPicker(entityType, entityId, containerId, preselectedType) {
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
          ${allowed.map(t => `<option value="${t}"${preselectedType === t ? ' selected' : ''}>${linkableTypes[t]?.label || t}</option>`).join('')}
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
  if (preselectedType) loadCrossLinkOptions();
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
  if (sourceType === 'requirement') {
    loadRequirements();
  } else {
    renderCrossLinks(sourceType, sourceId, containerId);
  }
}

async function removeCrossLink(linkId, entityType, entityId, containerId) {
  await api(`/api/cross-links/${linkId}`, { method: 'DELETE' });
  if (entityType === 'requirement') {
    loadRequirements();
  } else {
    renderCrossLinks(entityType, entityId, containerId);
  }
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
  updateOverdueBadge();
}

async function renderFilters() {
  const bar = document.getElementById('filters-bar');
  const roles = await api('/api/architecture?arch_type=role');
  const processes = await api('/api/architecture?arch_type=process');
  // Only show process dropdown when context is "All" — context bar handles it otherwise
  const showProcessFilter = opPlanContext.type === 'all';

  bar.innerHTML = `
    <input type="search" placeholder="Search tasks..." value="${esc(filters.search)}"
      style="min-width:180px" oninput="filters.search=this.value;renderTaskTable()">
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
    ${showProcessFilter ? `<select onchange="filters.category=this.value;loadTasks()">
      <option value="">All Processes</option>
      ${processes.map(p => `<option value="${esc(p.name)}" ${filters.category===p.name?'selected':''}>${esc(p.name)}</option>`).join('')}
      ${meta.categories.filter(c => !processes.find(p => p.name === c)).map(c => `<option value="${esc(c)}" ${filters.category===c?'selected':''}>${esc(c)}</option>`).join('')}
    </select>` : ''}
  `;
}

function renderTaskTable() {
  const container = document.getElementById('task-table-body');
  const today = new Date().toISOString().split('T')[0];
  // Client-side context filter (used for bundles; single-process is already server-filtered)
  const ctxNames = getOpPlanContextNames();
  let tasks = ctxNames ? allTasks.filter(t => ctxNames.includes(t.category)) : allTasks;
  if (filters.search) {
    const q = filters.search.toLowerCase();
    tasks = tasks.filter(t => t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
  }
  if (tasks.length === 0) {
    container.innerHTML = '<div class="empty-state">No tasks found.</div>';
    return;
  }
  const recurrenceLabel = r => ({ daily:'Daily', weekly:'Weekly', biweekly:'Biweekly', monthly:'Monthly', quarterly:'Quarterly', yearly:'Yearly', custom:'Custom' }[r] || r);
  let html = `<div class="task-list-table">
    <div class="task-list-head">
      <div>Title</div>
      <div>Assignee · Category</div>
      <div>Priority</div>
      <div>Status</div>
      <div>Due Date</div>
      <div>Recurrence</div>
      <div></div>
    </div>`;
  html += tasks.map(t => {
    const status = !t.is_active ? 'inactive' : t.next_due < today ? 'overdue' : t.next_due === today ? 'due-today' : 'upcoming';
    const statusLabel = { inactive:'Inactive', overdue:'Overdue', 'due-today':'Due Today', upcoming:'Upcoming' }[status];
    const statusBadge = { inactive:'badge-inactive', overdue:'badge-overdue', 'due-today':'badge-due-today', upcoming:'badge-upcoming' }[status];
    const recLabel = t.recurrence === 'custom' ? `Every ${t.custom_days}d` : t.day_of_week != null && t.recurrence === 'weekly' ? `${recurrenceLabel(t.recurrence)} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][t.day_of_week]})` : t.day_of_month != null && t.recurrence === 'monthly' ? `Monthly (${t.day_of_month}th)` : recurrenceLabel(t.recurrence);
    const assigneeParts = [t.assignee ? esc(t.assignee) : null, t.category && t.category !== 'General' ? esc(t.category) : null].filter(Boolean);
    return `<div class="task-list-row-wrap status-${status}${!t.is_active ? ' task-inactive' : ''}">
      <div class="task-list-row">
        <div class="task-list-col-title">
          <span class="task-list-title" onclick="openTaskDetailModal(${t.id})">${esc(t.title)}</span>
          ${t.description ? `<span class="task-list-desc">${esc(t.description)}</span>` : ''}
        </div>
        <div class="task-list-col">${assigneeParts.length ? `<span style="font-size:12px;color:var(--text-muted)">${assigneeParts.join(' · ')}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}</div>
        <div class="task-list-col"><span class="badge badge-${t.priority.toLowerCase()}">${t.priority}</span></div>
        <div class="task-list-col"><span class="badge ${statusBadge}">${statusLabel}</span></div>
        <div class="task-list-col"><span style="font-size:12px">${esc(t.next_due)}</span></div>
        <div class="task-list-col"><span class="task-recurrence-badge">&#8635; ${recLabel}</span></div>
        <div class="task-list-col-actions">
          ${t.is_active ? `<button class="btn btn-primary btn-sm" style="font-size:11px" onclick="openCompleteModal(${t.id})">&#10003;</button>` : ''}
          ${actionMenu([
            { label: '&#10003; Complete', onclick: `openCompleteModal(${t.id})`, cls: 'success' },
            { label: '&#128279; Links', onclick: `toggleTaskLinks(${t.id})` },
            { label: '&#9998; Edit', onclick: `openTaskModal(${t.id})` },
            'sep',
            { label: '&#128465; Delete', onclick: `deleteTask(${t.id})`, cls: 'danger' },
          ])}
        </div>
      </div>
      <div id="task-links-${t.id}" class="task-inline-links"></div>
    </div>`;
  }).join('');
  html += '</div>';
  container.innerHTML = html;
}

function updateOverdueBadge() {
  const today = new Date().toISOString().split('T')[0];
  const count = allTasks.filter(t => t.is_active && t.next_due < today).length;
  const link = document.querySelector('.nav-link[data-view="tasks"]');
  if (!link) return;
  let badge = link.querySelector('.nav-overdue-badge');
  if (count === 0) { if (badge) badge.remove(); return; }
  if (!badge) { badge = document.createElement('span'); badge.className = 'nav-overdue-badge'; link.appendChild(badge); }
  badge.textContent = count;
}

function toggleTaskLinks(taskId) {
  const el = document.getElementById(`task-links-${taskId}`);
  if (el.innerHTML) { el.innerHTML = ''; return; }
  renderCrossLinks('task', taskId, `task-links-${taskId}`);
}

// --- History ---
let historyFilters = { task_id: '', completed_by: '', from: '', to: '' };

async function loadHistory() {
  const params = new URLSearchParams({ limit: '200' });
  if (historyFilters.task_id) params.set('task_id', historyFilters.task_id);
  if (historyFilters.completed_by) params.set('completed_by', historyFilters.completed_by);
  if (historyFilters.from) params.set('from', historyFilters.from);
  if (historyFilters.to) params.set('to', historyFilters.to);
  let completions = await api(`/api/completions?${params}`);
  // Apply process context filter
  const histCtxNames = getOpPlanContextNames();
  if (histCtxNames) completions = completions.filter(c => histCtxNames.includes(c.task_category));
  // Apply client-side search
  if (historySearch) {
    const q = historySearch.toLowerCase();
    completions = completions.filter(c =>
      (c.task_title || '').toLowerCase().includes(q) ||
      (c.completed_by || '').toLowerCase().includes(q) ||
      (c.notes || '').toLowerCase().includes(q)
    );
  }
  renderHistoryFilters(completions);
  const list = document.getElementById('history-list');
  if (completions.length === 0) {
    list.innerHTML = '<div class="empty-state">No completions match filters</div>';
    return;
  }
  list.innerHTML = completions.map(c => {
    let evidenceFiles = [];
    try { evidenceFiles = JSON.parse(c.evidence_files || '[]'); } catch(e) {}
    return `<div class="history-item">
      <div class="hi-info">
        <strong style="cursor:pointer;color:var(--primary)" onclick="openTaskDetailModal(${c.task_id})">${esc(c.task_title)}</strong>
        ${c.task_category && c.task_category !== 'General' ? `<span class="op-ctx-process-tag" style="margin-left:6px">${esc(c.task_category)}</span>` : ''}
        <div class="hi-meta">${c.completed_by ? 'by ' + esc(c.completed_by) : 'Unknown'}${c.notes ? ' — ' + esc(c.notes) : ''}</div>
        ${evidenceFiles.length > 0 ? `<div class="hi-meta">${evidenceFiles.map(ef => `<span style="font-size:11px;cursor:pointer;text-decoration:underline;margin-right:8px" onclick="window.open('/api/completions/${c.id}/evidence/${ef.id}/download','_blank')">&#128206; ${esc(ef.name)}</span>`).join('')}</div>` : ''}
        ${c.action_count > 0 ? `<div class="hi-meta"><span class="badge badge-${c.open_action_count > 0 ? 'high' : 'low'}">${c.open_action_count} open / ${c.action_count} actions</span></div>` : ''}
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <div class="hi-date">${new Date(c.completed_at).toLocaleString()}</div>
        ${actionMenu([
          { label: '&#128203; View Actions', onclick: `viewCompletionActions(${c.id}, ${c.task_id})` },
        ])}
      </div>
    </div>`;
  }).join('');
}

function renderHistoryFilters(completions) {
  const bar = document.getElementById('history-filters-bar');
  // Use allTasks (stable list) for task dropdown so options don't disappear when other filters narrow results
  const taskOptions = allTasks.length
    ? allTasks.map(t => `<option value="${t.id}" ${historyFilters.task_id == t.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('')
    : [...new Map(completions.map(c => [c.task_id, c.task_title])).entries()]
        .map(([id, title]) => `<option value="${id}" ${historyFilters.task_id == id ? 'selected' : ''}>${esc(title)}</option>`).join('');
  const completers = [...new Set(completions.map(c => c.completed_by).filter(Boolean))];
  bar.innerHTML = `
    <input type="search" placeholder="Search completions..." value="${esc(historySearch)}"
      style="min-width:180px" oninput="historySearch=this.value;loadHistory()">
    <select onchange="historyFilters.task_id=this.value;loadHistory()">
      <option value="">All Tasks</option>
      ${taskOptions}
    </select>
    <select onchange="historyFilters.completed_by=this.value;loadHistory()">
      <option value="">All Completers</option>
      ${completers.map(n => `<option value="${esc(n)}" ${historyFilters.completed_by === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}
    </select>
    <input type="date" value="${historyFilters.from}" onchange="historyFilters.from=this.value;loadHistory()" placeholder="From" title="From date">
    <input type="date" value="${historyFilters.to}" onchange="historyFilters.to=this.value;loadHistory()" placeholder="To" title="To date">
  `;
}

function exportCompletionLog() {
  const rows = document.querySelectorAll('#history-list .history-item');
  if (rows.length === 0) return alert('No data to export');
  // Re-fetch and build CSV from what's loaded
  api(`/api/completions?limit=500`).then(completions => {
    let csv = 'Date,Task,Completed By,Notes,Actions,Evidence Files\n';
    for (const c of completions) {
      let evidenceFiles = [];
      try { evidenceFiles = JSON.parse(c.evidence_files || '[]'); } catch(e) {}
      csv += `"${c.completed_at}","${(c.task_title || '').replace(/"/g, '""')}","${(c.completed_by || '').replace(/"/g, '""')}","${(c.notes || '').replace(/"/g, '""')}","${c.action_count || 0}","${evidenceFiles.map(f => f.name).join('; ')}"\n`;
    }
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `completion-log-${new Date().toISOString().split('T')[0]}.csv`;
    a.click(); URL.revokeObjectURL(url);
  });
}

// --- Task Detail Modal (read-only timeline view) ---
async function openTaskDetailModal(taskId) {
  const modal = document.getElementById('task-detail-modal');
  const body = document.getElementById('task-detail-body');
  body.innerHTML = '<div class="empty-state">Loading...</div>';
  modal.classList.remove('hidden');

  const task = await api(`/api/tasks/${taskId}`);
  const completions = task.completions || [];
  document.getElementById('task-detail-title').textContent = task.title;
  document.getElementById('task-detail-edit-btn').onclick = () => { closeTaskDetailModal(); openTaskModal(taskId); };
  document.getElementById('task-detail-complete-btn').onclick = () => { closeTaskDetailModal(); openCompleteModal(taskId); };

  const recLabel = { daily:'Daily', weekly:'Weekly', biweekly:'Biweekly', monthly:'Monthly', quarterly:'Quarterly', yearly:'Yearly', custom:'Custom' }[task.recurrence] || task.recurrence;
  const today = new Date().toISOString().split('T')[0];
  const statusLabel = !task.is_active ? 'Inactive' : task.next_due < today ? 'Overdue' : task.next_due === today ? 'Due Today' : 'Upcoming';
  const statusBadge = !task.is_active ? 'badge-inactive' : task.next_due < today ? 'badge-overdue' : task.next_due === today ? 'badge-due-today' : 'badge-upcoming';

  let html = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
    <span class="badge badge-${task.priority.toLowerCase()}">${task.priority}</span>
    <span class="badge ${statusBadge}">${statusLabel}</span>
    <span class="task-recurrence-badge">&#8635; ${recLabel}</span>
  </div>`;
  if (task.description) html += `<p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">${esc(task.description)}</p>`;
  html += `<div style="display:flex;gap:16px;font-size:13px;color:var(--text-muted);margin-bottom:16px;flex-wrap:wrap">
    ${task.assignee ? `<span>&#128100; ${esc(task.assignee)}</span>` : ''}
    ${task.category && task.category !== 'General' ? `<span>&#128260; ${esc(task.category)}</span>` : ''}
    <span>Next due: <strong>${task.next_due}</strong></span>
    <span>Start: ${task.start_date}</span>
  </div>`;

  // Completion timeline
  html += `<h4 style="font-size:13px;font-weight:600;text-transform:uppercase;color:var(--text-muted);letter-spacing:.5px;margin-bottom:12px;padding-top:12px;border-top:1px solid var(--border)">Completion History (${completions.length})</h4>`;
  if (completions.length === 0) {
    html += '<div class="empty-state" style="padding:16px 0">No completions yet</div>';
  } else {
    for (const c of completions) {
      let evidenceFiles = [];
      try { evidenceFiles = JSON.parse(c.evidence_files || '[]'); } catch(e) {}
      const actions = await api(`/api/actions?completion_id=${c.id}`);
      html += `<div style="border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;margin-bottom:10px;background:#fafbfc">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span style="font-size:13px;font-weight:600">${new Date(c.completed_at).toLocaleDateString()}</span>
          <span style="font-size:12px;color:var(--text-muted)">${c.completed_by ? 'by ' + esc(c.completed_by) : ''}</span>
        </div>
        ${c.notes ? `<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">${esc(c.notes)}</div>` : ''}
        ${evidenceFiles.length > 0 ? `<div style="margin-bottom:6px">${evidenceFiles.map(ef => `<span style="font-size:12px;cursor:pointer;text-decoration:underline;margin-right:10px" onclick="window.open('/api/completions/${c.id}/evidence/${ef.id}/download','_blank')">&#128206; ${esc(ef.name)}</span>`).join('')}</div>` : ''}
        ${actions.length > 0 ? `<div style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--border)">${actions.map(a => {
          const cls = a.status === 'open' ? 'badge-high' : a.status === 'in_progress' ? 'badge-medium' : 'badge-low';
          return `<div style="display:flex;align-items:center;gap:6px;font-size:12px;padding:2px 0">
            <span class="badge ${cls}" style="font-size:10px;padding:1px 6px">${a.status.replace('_',' ')}</span>
            <span>${esc(a.title)}</span>
            ${a.assignee ? `<span style="color:var(--text-muted)">— ${esc(a.assignee)}</span>` : ''}
          </div>`;
        }).join('')}</div>` : ''}
      </div>`;
    }
  }

  body.innerHTML = html;
}

function closeTaskDetailModal() {
  document.getElementById('task-detail-modal').classList.add('hidden');
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
  toggleRecurrenceFields();

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
    if (task.day_of_week != null) document.getElementById('task-day-of-week').value = task.day_of_week;
    if (task.day_of_month != null) document.getElementById('task-day-of-month').value = task.day_of_month;
    document.getElementById('task-start').value = task.start_date;
    toggleRecurrenceFields();
  }

  modal.classList.remove('hidden');
}

function closeTaskModal() {
  document.getElementById('task-modal').classList.add('hidden');
}

function toggleCustomDays() { toggleRecurrenceFields(); } // backwards compat alias
function toggleRecurrenceFields() {
  const sel = document.getElementById('task-recurrence').value;
  document.getElementById('custom-days-group').classList.toggle('hidden', sel !== 'custom');
  document.getElementById('task-day-of-week-group').classList.toggle('hidden', sel !== 'weekly');
  document.getElementById('task-day-of-month-group').classList.toggle('hidden', sel !== 'monthly');
}

async function saveTask(e) {
  e.preventDefault();
  const id = document.getElementById('task-id').value;
  const assigneeName = document.getElementById('task-assignee').value;
  const categoryName = document.getElementById('task-category').value || 'General';
  const recurrence = document.getElementById('task-recurrence').value;
  const body = {
    title: document.getElementById('task-title').value,
    description: document.getElementById('task-desc').value,
    assignee: assigneeName,
    category: categoryName,
    priority: document.getElementById('task-priority').value,
    recurrence,
    custom_days: recurrence === 'custom' ? (parseInt(document.getElementById('task-custom-days').value) || null) : null,
    day_of_week: recurrence === 'weekly' ? parseInt(document.getElementById('task-day-of-week').value) : null,
    day_of_month: recurrence === 'monthly' ? parseInt(document.getElementById('task-day-of-month').value) : null,
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
let activeCompletionId = null; // set after first save so evidence can be uploaded

async function openCompleteModal(taskId) {
  document.getElementById('complete-form').reset();
  document.getElementById('complete-task-id').value = taskId;
  activeCompletionId = null;
  document.getElementById('complete-evidence-list').innerHTML = '';
  document.getElementById('complete-evidence-upload').style.display = 'none';
  document.getElementById('complete-modal-title').textContent = 'Mark Complete';

  // Populate role dropdown
  const roles = await api('/api/architecture?arch_type=role');
  const sel = document.getElementById('complete-by');
  sel.innerHTML = '<option value="">-- Select Role --</option>' +
    roles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
  // Auto-select from logged-in user name if it matches a role
  if (currentUser && currentUser.name) {
    const match = roles.find(r => r.name === currentUser.name);
    if (match) sel.value = match.name;
  }

  document.getElementById('complete-modal').classList.remove('hidden');
}

function closeCompleteModal() {
  document.getElementById('complete-modal').classList.add('hidden');
  activeCompletionId = null;
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
  activeCompletionId = result.completion_id;
  // Enable evidence upload now that we have a completion ID
  document.getElementById('complete-evidence-upload').style.display = 'block';
  document.getElementById('complete-modal-title').textContent = 'Completed — Attach Evidence';
  // Swap the form buttons to a "Done" + "Attach More" pattern
  closeCompleteModal();
  invalidateYearlyCache();
  // Show post-completion action prompt (includes evidence upload option)
  lastCompletionContext = { completion_id: result.completion_id, task_id: parseInt(taskId) };
  await openPostCompleteModal();
}

async function uploadCompletionEvidence() {
  if (!activeCompletionId) return;
  const fileInput = document.getElementById('complete-evidence-file');
  if (!fileInput.files.length) return;
  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  try {
    const res = await fetch(`/api/completions/${activeCompletionId}/evidence`, { method: 'POST', body: formData });
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
  await refreshCompletionEvidence(activeCompletionId);
}

async function refreshCompletionEvidence(completionId) {
  const completions = await api(`/api/completions?limit=1`);
  const comp = completions.find(c => c.id === completionId);
  let evidenceFiles = [];
  try { evidenceFiles = JSON.parse(comp?.evidence_files || '[]'); } catch(e) {}
  const container = document.getElementById('complete-evidence-list') || document.getElementById('post-complete-evidence-list');
  if (!container) return;
  if (evidenceFiles.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;font-style:italic">No evidence attached</div>';
    return;
  }
  container.innerHTML = evidenceFiles.map(ef => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px">
    <span>&#128206;</span>
    <span style="cursor:pointer;text-decoration:underline;flex:1" onclick="window.open('/api/completions/${completionId}/evidence/${ef.id}/download','_blank')">${esc(ef.name)}</span>
    <span style="color:var(--text-muted);font-size:11px">${ef.size ? (ef.size / 1024).toFixed(1) + ' KB' : ''}</span>
    <button class="btn btn-secondary btn-sm" style="font-size:10px;padding:1px 6px" onclick="removeCompletionEvidence(${completionId},${ef.id})">&times;</button>
  </div>`).join('');
}

async function removeCompletionEvidence(completionId, fileId) {
  if (!confirm('Remove this evidence file?')) return;
  await api(`/api/completions/${completionId}/evidence/${fileId}`, { method: 'DELETE' });
  await refreshCompletionEvidence(completionId);
}

async function uploadPostCompleteEvidence() {
  if (!lastCompletionContext) return;
  const fileInput = document.getElementById('post-complete-evidence-file');
  if (!fileInput.files.length) return;
  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  await fetch(`/api/completions/${lastCompletionContext.completion_id}/evidence`, { method: 'POST', body: formData });
  fileInput.value = '';
  await refreshCompletionEvidence(lastCompletionContext.completion_id);
}


// --- Delete (soft-delete: deactivates task, preserves history) ---
async function deleteTask(id) {
  if (!confirm('Deactivate this task? Its completion history will be preserved.')) return;
  await api(`/api/tasks/${id}`, { method: 'PUT', body: { is_active: 0 } });
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

  // Show evidence section for this completion
  const evidenceWrap = document.getElementById('post-complete-evidence-wrap');
  if (evidenceWrap && lastCompletionContext) {
    evidenceWrap.style.display = 'block';
    activeCompletionId = lastCompletionContext.completion_id;
    await refreshCompletionEvidence(lastCompletionContext.completion_id);
  }

  document.getElementById('post-complete-modal').classList.remove('hidden');
}

function closePostCompleteModal() {
  document.getElementById('post-complete-modal').classList.add('hidden');
  lastCompletionContext = null;
  activeCompletionId = null;
  refreshCurrentView();
}

async function linkCompletionToAudit() {
  if (!lastCompletionContext) return;
  // Fetch active audits with checklist items
  const audits = await api('/api/audits?status=in_progress');
  if (audits.length === 0) return alert('No in-progress audits found. Start an audit first.');
  const auditOptions = audits.map(a => `${a.id}: ${a.title}`).join('\n');
  const auditChoice = prompt(`Select an audit ID to link to:\n\n${auditOptions}`);
  if (!auditChoice) return;
  const auditId = parseInt(auditChoice);
  if (isNaN(auditId)) return;
  // Create cross-link: task → audit
  await api('/api/cross-links', {
    method: 'POST',
    body: { source_type: 'task', source_id: lastCompletionContext.task_id, target_type: 'audit', target_id: auditId }
  });
  const container = document.getElementById('post-complete-crosslinks');
  const audit = audits.find(a => a.id === auditId);
  container.innerHTML += `<div style="font-size:12px;padding:4px 0">&#9745; Linked to audit: <strong>${esc(audit?.title || 'Audit #' + auditId)}</strong></div>`;
}

async function createNcrFromCompletion() {
  if (!lastCompletionContext) return;
  const title = prompt('NCR title (describe the nonconformity):');
  if (!title) return;
  // Create a new action flagged as NCR-type
  const action = await api('/api/actions', {
    method: 'POST',
    body: {
      completion_id: lastCompletionContext.completion_id,
      task_id: lastCompletionContext.task_id,
      title: '[NCR] ' + title,
      description: 'Nonconformity raised from task completion',
      priority: 'High',
    },
  });
  // Also try to create as a real NCR if the endpoint exists
  try {
    const ncr = await api('/api/ncrs', {
      method: 'POST',
      body: { title, source: 'task_completion', source_id: lastCompletionContext.task_id, severity: 'major' }
    });
    if (ncr && ncr.id) {
      await api('/api/cross-links', {
        method: 'POST',
        body: { source_type: 'action', source_id: action.id, target_type: 'ncr', target_id: ncr.id }
      });
    }
  } catch (e) { /* NCR module may not exist, the action is the fallback */ }
  const container = document.getElementById('post-complete-crosslinks');
  container.innerHTML += `<div style="font-size:12px;padding:4px 0">&#9888; NCR raised: <strong>${esc(title)}</strong></div>`;
  // Also add to actions list visually
  const list = document.getElementById('post-complete-actions-list');
  list.innerHTML += `<div class="task-card" style="margin-bottom:8px">
    <div class="task-card-info"><h4>[NCR] ${esc(title)}</h4><div class="meta">High priority</div></div>
  </div>`;
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
  if (opPlanContext.type === 'process' && opPlanContext.id) params.set('process_id', opPlanContext.id);

  const [actions, roles] = await Promise.all([
    api(`/api/actions?${params}`),
    api('/api/architecture?arch_type=role'),
  ]);
  renderActionFilters(roles);
  // For bundle context: filter client-side by process_id membership
  let filtered = actions;
  if (opPlanContext.type === 'bundle') {
    const bundle = opPlanBundles.find(b => b.id === opPlanContext.id);
    const ids = bundle ? JSON.parse(bundle.process_ids || '[]') : [];
    filtered = actions.filter(a => ids.includes(a.process_id));
  }
  if (actionFilters.priority) filtered = filtered.filter(a => a.priority === actionFilters.priority);
  if (actionFilters.assignee) filtered = filtered.filter(a => a.assignee === actionFilters.assignee);
  renderActionTable(filtered);
}

function renderActionFilters(roles = []) {
  const bar = document.getElementById('action-filters-bar');
  bar.innerHTML = `
    <select onchange="actionFilters.status=this.value;loadActions()">
      <option value="" ${actionFilters.status===''?'selected':''}>All Statuses</option>
      <option value="open" ${actionFilters.status==='open'?'selected':''}>Open</option>
      <option value="in_progress" ${actionFilters.status==='in_progress'?'selected':''}>In Progress</option>
      <option value="resolved" ${actionFilters.status==='resolved'?'selected':''}>Resolved</option>
      <option value="closed" ${actionFilters.status==='closed'?'selected':''}>Closed</option>
    </select>
    <select onchange="actionFilters.priority=this.value;loadActions()">
      <option value="">All Priorities</option>
      <option value="Low" ${actionFilters.priority==='Low'?'selected':''}>Low</option>
      <option value="Medium" ${actionFilters.priority==='Medium'?'selected':''}>Medium</option>
      <option value="High" ${actionFilters.priority==='High'?'selected':''}>High</option>
      <option value="Critical" ${actionFilters.priority==='Critical'?'selected':''}>Critical</option>
    </select>
    <select onchange="actionFilters.assignee=this.value;loadActions()">
      <option value="">All Assignees</option>
      ${roles.map(r => `<option value="${esc(r.name)}" ${actionFilters.assignee===r.name?'selected':''}>${esc(r.name)}</option>`).join('')}
    </select>
  `;
}

function renderActionTable(actions) {
  const tbody = document.getElementById('action-table-body');
  const today = new Date().toISOString().split('T')[0];
  if (actions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No actions found</td></tr>';
    return;
  }
  tbody.innerHTML = actions.map(a => {
    const isOverdue = a.due_date && a.due_date < today && (a.status === 'open' || a.status === 'in_progress');
    const statusClass = a.status === 'open' ? 'badge-high' : a.status === 'in_progress' ? 'badge-medium' : 'badge-low';
    const statusLabel = a.status.replace('_', ' ');
    return `<tr>
      <td><strong style="cursor:pointer;color:var(--primary)" onclick="openActionModal(${a.id})">${esc(a.title)}</strong>${a.description ? '<br><small style="color:var(--text-muted);cursor:pointer" onclick="openActionModal(' + a.id + ')">' + esc(a.description) + '</small>' : ''}</td>
      <td>${a.process_name ? `<span class="op-ctx-process-tag">${esc(a.process_name)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
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
  refreshCurrentView();
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
  document.getElementById('action-completion-id').value = '';
  document.getElementById('action-task-id').value = '';
  document.getElementById('action-modal-title').textContent = 'New Action';
  document.getElementById('action-resolved-by-group').classList.add('hidden');

  // Populate Role + Process dropdowns from Architecture
  const [roles, processes] = await Promise.all([
    api('/api/architecture?arch_type=role'),
    opPlanProcesses.length ? Promise.resolve(opPlanProcesses) : api('/api/architecture?arch_type=process'),
  ]);
  const assigneeSelect = document.getElementById('action-assignee');
  assigneeSelect.innerHTML = '<option value="">-- Select Role --</option>' +
    roles.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
  const processSelect = document.getElementById('action-process-id');
  processSelect.innerHTML = '<option value="">— Not linked to a process —</option>' +
    processes.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');

  // Pre-select process from context bar if creating new action
  if (!id && opPlanContext.type === 'process' && opPlanContext.id) {
    processSelect.value = opPlanContext.id;
  }

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
    processSelect.value = action.process_id || '';
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
  const processIdVal = document.getElementById('action-process-id').value;
  const body = {
    title: document.getElementById('action-title').value,
    description: document.getElementById('action-description').value,
    assignee: assigneeName,
    priority: document.getElementById('action-priority').value,
    due_date: document.getElementById('action-due-date').value || null,
    status: document.getElementById('action-status').value,
    resolved_by: document.getElementById('action-resolved-by').value,
    process_id: processIdVal ? parseInt(processIdVal) : null,
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

function filterYearlyDataByCategories(data, names) {
  const filterEntries = obj => {
    const out = {};
    for (const [ds, items] of Object.entries(obj)) {
      const filtered = items.filter(t => names.includes(t.category));
      if (filtered.length) out[ds] = filtered;
    }
    return out;
  };
  return {
    ...data,
    dueDates: filterEntries(data.dueDates || {}),
    completedDates: filterEntries(data.completedDates || {}),
  };
}

function renderYearlyUpcoming() {
  const upcomingEl = document.getElementById('yearly-upcoming');
  if (!upcomingEl) return;
  const today = new Date().toISOString().split('T')[0];
  const todayDate = new Date(today);
  const priorityBadge = p => p === 'Critical' ? 'badge-critical' : p === 'High' ? 'badge-high' : p === 'Medium' ? 'badge-medium' : 'badge-low';
  const recurrenceLabel = r => ({ daily:'Daily', weekly:'Weekly', biweekly:'Biweekly', monthly:'Monthly', quarterly:'Quarterly', yearly:'Yearly', custom:'Custom' }[r] || r);
  const formatDueDate = (ds, isOverdue) => {
    const d = new Date(ds + 'T00:00:00');
    const diff = Math.round((d - todayDate) / 86400000);
    const label = MONTH_NAMES[d.getMonth()].substring(0, 3) + ' ' + d.getDate();
    if (isOverdue) {
      const daysAgo = Math.round((todayDate - d) / 86400000);
      return `<span style="color:var(--danger);font-size:12px">${label} · <span style="font-size:11px">${daysAgo}d ago</span></span>`;
    }
    if (diff === 0) return `<span style="font-weight:600;font-size:12px">Today</span>`;
    if (diff === 1) return `<span style="font-size:12px">Tomorrow</span>`;
    return `<span style="font-size:12px">${label} · <span style="color:var(--text-muted);font-size:11px">in ${diff}d</span></span>`;
  };

  let items = yearlyUpcomingCache;
  if (yearlyFilters.overdue_only) items = items.filter(i => i._status === 'overdue');
  if (yearlyFilters.priority) items = items.filter(i => i.priority === yearlyFilters.priority);
  if (yearlyFilters.search) {
    const q = yearlyFilters.search.toLowerCase();
    items = items.filter(i => i.title.toLowerCase().includes(q) || (i.category || '').toLowerCase().includes(q));
  }

  const overdueCount = items.filter(i => i._status === 'overdue').length;
  const upcomingCount = items.filter(i => i._status === 'upcoming').length;
  const upcomingGridCols = '2fr 140px 90px 1fr 80px 100px 110px';
  const buildTableRow = item => {
    const isOverdue = item._status === 'overdue';
    return `<div class="arch-table-row" style="grid-template-columns:${upcomingGridCols}${isOverdue ? ';background:var(--danger-bg,#fff5f5)' : ''}">
      <div class="arch-col-name" style="cursor:pointer" onclick="openTaskModal(${item.task_id})">
        <span class="arch-name" style="color:var(--primary)">${esc(item.title)}</span>
        ${item.category ? `<span class="arch-desc">${esc(item.category)}</span>` : ''}
      </div>
      <div class="arch-col-detail">${formatDueDate(item.date, isOverdue)}</div>
      <div class="arch-col-detail">
        ${isOverdue
          ? `<span class="badge badge-critical">Overdue</span>`
          : `<span class="badge badge-low" style="background:var(--success-light,#e6f9ee);color:var(--success,#16a34a)">Upcoming</span>`}
      </div>
      <div class="arch-col-detail"><span style="font-size:12px">${item.assignee ? esc(item.assignee) : '<span style="color:var(--text-muted)">—</span>'}</span></div>
      <div class="arch-col-detail"><span class="badge ${priorityBadge(item.priority)}">${item.priority}</span></div>
      <div class="arch-col-detail"><span class="task-recurrence-badge">&#8635; ${recurrenceLabel(item.recurrence)}</span></div>
      <div class="arch-col-actions" style="gap:6px">
        <button class="btn btn-secondary btn-sm" style="font-size:11px" onclick="openTaskModal(${item.task_id})">&#9998; Edit</button>
        <button class="btn btn-primary btn-sm" style="font-size:11px" onclick="quickComplete(${item.task_id},'${item.date}')">&#10003;</button>
      </div>
    </div>`;
  };

  let html = `<h3 class="section-title" style="margin-top:28px">
    Tasks — Overdue &amp; Next 4 Weeks
    <span class="req-cat-count" style="margin-left:6px">(${items.length})</span>
    ${overdueCount > 0 ? `<span class="badge badge-critical" style="margin-left:8px;font-size:11px">${overdueCount} overdue</span>` : ''}
    ${upcomingCount > 0 ? `<span style="font-size:12px;color:var(--text-muted);margin-left:6px">${upcomingCount} upcoming</span>` : ''}
  </h3>`;
  if (items.length === 0) {
    html += '<div class="empty-state">No overdue or upcoming tasks match the filters.</div>';
  } else {
    html += `<div class="arch-table">
      <div class="arch-table-head" style="grid-template-columns:${upcomingGridCols}">
        <div>Task</div><div>Due Date</div><div>Status</div><div>Assignee</div><div>Priority</div><div>Recurrence</div><div></div>
      </div>
      <div>${items.map(buildTableRow).join('')}</div>
    </div>`;
  }
  upcomingEl.innerHTML = html;
}

function renderYearlyFilters() {
  const bar = document.getElementById('yearly-filters-bar');
  if (!bar) return;
  bar.innerHTML = `
    <input type="search" placeholder="Search tasks..." value="${esc(yearlyFilters.search)}"
      style="min-width:160px" oninput="yearlyFilters.search=this.value;renderYearlyUpcoming()">
    <select onchange="yearlyFilters.priority=this.value;renderYearlyUpcoming()">
      <option value="">All Priorities</option>
      <option value="Low" ${yearlyFilters.priority==='Low'?'selected':''}>Low</option>
      <option value="Medium" ${yearlyFilters.priority==='Medium'?'selected':''}>Medium</option>
      <option value="High" ${yearlyFilters.priority==='High'?'selected':''}>High</option>
      <option value="Critical" ${yearlyFilters.priority==='Critical'?'selected':''}>Critical</option>
    </select>
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
      <input type="checkbox" ${yearlyFilters.overdue_only?'checked':''} onchange="yearlyFilters.overdue_only=this.checked;renderYearlyUpcoming()">
      Overdue only
    </label>
  `;
}

async function loadYearlyPlan() {
  document.getElementById('yearly-title').textContent = `Yearly Plan ${yearlyYear}`;
  renderYearlyFilters();
  try {
  const rawData = await api(`/api/yearly?year=${yearlyYear}`);
  // Apply process context filter to yearly data
  const yearCtxNames = getOpPlanContextNames();
  const data = yearCtxNames ? filterYearlyDataByCategories(rawData, yearCtxNames) : rawData;
  yearlyData = data;
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
        for (const t of data.dueDates[ds]) {
          const wasCompleted = data.completedDates[ds] && data.completedDates[ds].some(c => c.task_id === t.task_id);
          const isOverdue = ds < today && !wasCompleted;
          if (isOverdue) overdue++;
          if (!taskDates[t.task_id]) taskDates[t.task_id] = { ...t, dates: [] };
          taskDates[t.task_id].dates.push({ date: ds, type: isOverdue ? 'overdue' : 'due' });
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

  // Collect all overdue+upcoming items and store for filter re-render
  const todayDate = new Date(today);
  const fourWeeksOut = new Date(todayDate);
  fourWeeksOut.setDate(fourWeeksOut.getDate() + 28);
  const fourWeeksStr = fourWeeksOut.toISOString().split('T')[0];

  const overdueItems = [];
  const upcomingItems = [];
  for (const [dateStr, tasks] of Object.entries(data.dueDates)) {
    for (const t of tasks) {
      if (dateStr < today) {
        const completedOnDate = data.completedDates[dateStr] && data.completedDates[dateStr].some(c => c.task_id === t.task_id);
        if (!completedOnDate) overdueItems.push({ ...t, date: dateStr, _status: 'overdue' });
      } else if (dateStr >= today && dateStr <= fourWeeksStr) {
        upcomingItems.push({ ...t, date: dateStr, _status: 'upcoming' });
      }
    }
  }
  overdueItems.sort((a, b) => a.date.localeCompare(b.date));
  upcomingItems.sort((a, b) => a.date.localeCompare(b.date));
  // Cache raw items for filter re-renders
  yearlyUpcomingCache = [...overdueItems, ...upcomingItems];

  renderYearlyUpcoming();
  } catch (err) {
    console.error('[loadYearlyPlan] Failed:', err);
    const el = document.getElementById('yearly-summary');
    if (el) el.innerHTML = `<div class="empty-state" style="color:var(--danger)">Failed to load yearly plan: ${esc(err.message)}</div>`;
  }
}

async function quickComplete(taskId, dateStr) {
  // Open the full complete modal so the user can record who did it, add notes & evidence
  openCompleteModal(taskId);
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
        const dayNum = parseInt(d.date.split('-')[2]);
        const pct = ((dayNum - 0.5) / daysInMonth) * 100;
        html += `<span class="gantt-dot ${d.type}" style="left:calc(${pct}% - 5px)" title="${d.date}"></span>`;
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
let reqColWidths = {}; // persists resize state across re-renders

function _getReqGridCols(dynCols) {
  const w = reqColWidths;
  return [
    (w.clause || 80) + 'px',
    (w.title  || 280) + 'px',
    (w.audit  || 100) + 'px',
    (w.nc     || 80)  + 'px',
    ...dynCols.map(t => (w['dyn_' + t] || 130) + 'px'),
    '44px', // actions — always fixed
  ].join(' ');
}

function _initReqResize(dynCols) {
  document.querySelectorAll('.req-resize-handle').forEach(handle => {
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      const colKey = handle.dataset.col;
      const startX = e.clientX;
      const startW = reqColWidths[colKey] || parseInt(handle.dataset.default, 10) || 130;
      handle.classList.add('dragging');

      const onMove = ev => {
        const newW = Math.max(50, startW + ev.clientX - startX);
        reqColWidths[colKey] = newW;
        const cols = _getReqGridCols(dynCols);
        document.querySelectorAll('.req-table-head, .req-table-row').forEach(el => {
          el.style.gridTemplateColumns = cols;
        });
        // Keep the sticky 'Requirement' column's left offset in sync with clause width
        if (colKey === 'clause') {
          document.querySelectorAll('.req-col-title').forEach(el => {
            el.style.left = newW + 'px';
          });
        }
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

async function loadRequirements() {
  try {
  const params = new URLSearchParams();
  if (reqFilters.standard) params.set('standard', reqFilters.standard);
  const reqs = await api(`/api/requirements?${params}`);
  const standards = await api('/api/requirements/standards');

  // Fetch cross-links for all requirements in a single bulk request
  // (previously: N individual requests via batchAll)
  const allLinks = reqs.length
    ? await api(`/api/cross-links/batch/requirement?ids=${reqs.map(r => r.id).join(',')}`)
    : {};

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

  // Derive dynamic columns from which entity types are actually linked
  const AUDIT_COL_TYPES = ['process', 'role', 'document', 'risk', 'treatment', 'task', 'action', 'system', 'asset'];
  const AUDIT_COL_LABELS = { process: 'Processes', role: 'Roles', document: 'Documents', risk: 'Risks', treatment: 'Treatments', task: 'Tasks', action: 'Actions', system: 'Systems', asset: 'Assets' };
  const typeLabels = Object.fromEntries(Object.entries(linkableTypes).map(([k,v]) => [k, v.label]));
  const typeIcons  = Object.fromEntries(Object.entries(linkableTypes).map(([k,v]) => [k, v.icon]));
  const _linkedTypesPresent = new Set();
  for (const ls of Object.values(allLinks)) for (const l of ls) if (AUDIT_COL_TYPES.includes(l.type)) _linkedTypesPresent.add(l.type);
  const dynamicCols = AUDIT_COL_TYPES.filter(t => _linkedTypesPresent.has(t));
  const gridCols = _getReqGridCols(dynamicCols);

  // Evidence coverage: % of requirements with at least one linked document
  const withEvidence = reqs.filter(r => (allLinks[r.id] || []).some(l => l.type === 'document')).length;
  const evPct = reqs.length ? Math.round(withEvidence / reqs.length * 100) : 0;

  // Stats
  const statsEl = document.getElementById('req-stats');
  statsEl.innerHTML = `
    <div class="req-stats-grid">
      <div class="stat-card"><div class="stat-value">${reqs.length}</div><div class="stat-label">Total Requirements</div></div>
      <div class="stat-card"><div class="stat-value">${standards.length}</div><div class="stat-label">Standards</div></div>
      <div class="stat-card"><div class="stat-value">${Object.keys(groups).length}</div><div class="stat-label">Categories</div></div>
      <div class="stat-card" title="${withEvidence} of ${reqs.length} requirements have linked evidence documents"><div class="stat-value" style="color:${evPct>=80?'var(--success)':evPct>=40?'var(--warning)':'var(--danger)'}">${evPct}%</div><div class="stat-label">Evidence Coverage</div></div>
    </div>`;

  // List
  const list = document.getElementById('req-list');
  if (reqs.length === 0) {
    list.innerHTML = '<div class="empty-state">No requirements yet. Add manually or import a standard template.</div>';
    return;
  }

  // Sort categories: HLS chapters numerically (4→10), annex categories (A.x.x) always last
  const _clauseSortKey = clause => {
    if (/^[A-Za-z]/.test(clause)) return 1e9; // annex — always after numbered clauses
    const parts = clause.split('.').map(Number);
    return parts[0] * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0);
  };
  const sortedGroupEntries = Object.entries(groups).sort(([, aItems], [, bItems]) => {
    const aMin = Math.min(...aItems.map(i => _clauseSortKey(i.clause)));
    const bMin = Math.min(...bItems.map(i => _clauseSortKey(i.clause)));
    return aMin - bMin;
  });

  let html = '';
  for (const [cat, items] of sortedGroupEntries) {
    items.sort((a, b) => a.clause.localeCompare(b.clause, undefined, { numeric: true }));
    html += `<div class="req-category-group">
      <div class="req-category-header">${esc(cat)} <span class="req-cat-count">(${items.length})</span></div>
      <div class="req-table-wrap"><div class="req-table">
        <div class="req-table-head" style="grid-template-columns:${gridCols}">
          <div class="req-col-clause">Clause<div class="req-resize-handle" data-col="clause" data-default="80"></div></div>
          <div class="req-col-title">Requirement<div class="req-resize-handle" data-col="title" data-default="280"></div></div>
          <div class="req-col-audit">Last Audit<div class="req-resize-handle" data-col="audit" data-default="100"></div></div>
          <div class="req-col-nc">NCs<div class="req-resize-handle" data-col="nc" data-default="80"></div></div>
          ${dynamicCols.map(t => `<div class="req-col-dynamic">${AUDIT_COL_LABELS[t] || typeLabels[t]}<div class="req-resize-handle" data-col="dyn_${t}" data-default="130"></div></div>`).join('')}
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

      // Dynamic entity-type columns — one column per linked entity type present across all requirements
      const links = allLinks[r.id] || [];
      const collapseId = `req-cl-${r.id}`;
      const dynColsHtml = dynamicCols.map(t => {
        const tLinks = links.filter(l => l.type === t);
        const addBtn = `<button class="add-link-btn" onclick="openCrossLinkPicker('requirement',${r.id},null,'${t}')" title="Add link">+</button>`;
        if (!tLinks.length) return `<div class="req-col-dynamic"><span class="req-no-link">-</span>${addBtn}</div>`;
        return `<div class="req-col-dynamic">${tLinks.map(l => {
          const nav = getViewForType(l.type, l.id);
          return `<span class="req-linked-chip${nav ? ' clickable' : ''}" title="${esc(l.name)}"><span class="chip-nav"${nav ? ` onclick="${nav}"` : ''}>${esc(l.name)}</span><button class="chip-remove" onclick="event.stopPropagation();removeCrossLink(${l.link_id},'requirement',${r.id},null)" title="Remove link">&times;</button></span>`;
        }).join('')}${addBtn}</div>`;
      }).join('');

      html += `<div class="req-table-row" style="grid-template-columns:${gridCols}">
          <div class="req-col-clause" style="cursor:pointer" onclick="openRequirementModal(${r.id})"><span class="req-clause">${esc(r.clause)}</span></div>
          <div class="req-col-title" style="cursor:pointer" onclick="openRequirementModal(${r.id})">
            <span class="req-title" style="color:var(--primary)">${esc(r.title)}</span>
            ${r.description ? `<span class="req-desc">${esc(r.description)}</span>` : ''}
          </div>
          <div class="req-col-audit">${lastAuditLabel}</div>
          <div class="req-col-nc">${ncBadge}</div>
          ${dynColsHtml}
          <div class="req-col-actions">
            ${actionMenu([
              ...(links.length > 0 ? [{ label: `&#128279; All Links (${links.length})`, onclick: `toggleArchLinks('${collapseId}')` }] : []),
              { label: '&#128279; Link Items', onclick: `openCrossLinkPicker('requirement',${r.id},'req-expand-${r.id}')` },
              { label: '&#9998; Edit', onclick: `openRequirementModal(${r.id})` },
              'sep',
              { label: '&#128465; Delete', onclick: `deleteRequirement(${r.id})`, cls: 'danger' },
            ])}
          </div>
        </div>
        <div id="req-expand-${r.id}" class="req-expand-row">
          <div id="${collapseId}" class="arch-links-detail collapsed">
            ${links.length > 0 ? buildInlineLinksDetail(links, 'requirement', r.id, `req-expand-${r.id}`) : ''}
          </div>
        </div>`;
    }
    html += '</div></div></div>';
  }
  list.innerHTML = html;
  _initReqResize(dynamicCols);
  } catch (err) {
    console.error('[loadRequirements] Failed:', err);
    const list = document.getElementById('req-list');
    if (list) list.innerHTML = `<div class="empty-state" style="color:var(--danger)">Failed to load requirements: ${esc(err.message)}</div>`;
  }
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
    ],
    'ISO 42001:2023 Annex A': [
      { clause: 'A.2', title: 'AI policies', category: 'AI Controls' },
      { clause: 'A.3', title: 'Internal organization for AI', category: 'AI Controls' },
      { clause: 'A.4', title: 'Resources for AI systems', category: 'AI Controls' },
      { clause: 'A.5', title: 'Assessing impacts of AI systems', category: 'AI Controls' },
      { clause: 'A.6', title: 'AI system life cycle', category: 'AI Controls' },
      { clause: 'A.6.1', title: 'AI system life cycle management', category: 'AI Controls' },
      { clause: 'A.6.2', title: 'AI system requirements and design', category: 'AI Controls' },
      { clause: 'A.6.3', title: 'Data for AI systems', category: 'AI Controls' },
      { clause: 'A.6.4', title: 'AI model building and validation', category: 'AI Controls' },
      { clause: 'A.6.5', title: 'AI system verification and validation', category: 'AI Controls' },
      { clause: 'A.6.6', title: 'AI system deployment', category: 'AI Controls' },
      { clause: 'A.6.7', title: 'AI system operation and monitoring', category: 'AI Controls' },
      { clause: 'A.6.8', title: 'AI system retirement', category: 'AI Controls' },
      { clause: 'A.7', title: 'Data management', category: 'AI Controls' },
      { clause: 'A.8', title: 'Technology and AI system monitoring', category: 'AI Controls' },
      { clause: 'A.9', title: 'Third-party and customer relationships', category: 'AI Controls' },
      { clause: 'A.9.1', title: 'Use of AI as third-party or customer', category: 'AI Controls' },
      { clause: 'A.9.2', title: 'Supplying AI to third parties', category: 'AI Controls' },
      { clause: 'A.9.3', title: 'Responsible provision of AI', category: 'AI Controls' },
      { clause: 'A.9.4', title: 'AI system end-user communication', category: 'AI Controls' },
      { clause: 'A.10', title: 'Documentation and record management for AI', category: 'AI Controls' },
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
  'ISO 42001:2023 Annex A': 'AI',
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
  await batchAll(risks, async r => { allLinks[r.id] = await api(`/api/cross-links/risk/${r.id}`); });

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
  await batchAll(risks, async r => { details[r.id] = await api(`/api/risks/${r.id}`); });

  // Fetch treatment links
  const treatmentLinks = {};
  const allTreatments = Object.values(details).flatMap(d => d.treatments || []);
  await batchAll(allTreatments, async t => {
    treatmentLinks[t.id] = await api(`/api/cross-links/treatment/${t.id}`);
  });

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

// --- Use Cases ---
// ===== AI Use Cases – Kanban Board =====

const UC_STAGES = [
  { id: 'new',         label: 'New',             color: '#6b7280' },
  { id: 'assessment',  label: 'Under Assessment', color: '#f59e0b' },
  { id: 'approved',    label: 'Approved',         color: '#3b82f6' },
  { id: 'development', label: 'In Development',   color: '#8b5cf6' },
  { id: 'production',  label: 'In Production',    color: '#10b981' },
  { id: 'retired',     label: 'Retired',          color: '#94a3b8' },
];

const UC_RISK_BADGE = { 'Minimal': 'badge-low', 'Limited': 'badge-medium', 'High': 'badge-high', 'Unacceptable': 'badge-critical' };
const UC_PRIORITY_DOT = { low: '#22c55e', medium: '#f59e0b', high: '#ef4444', critical: '#7c3aed' };
const UC_DOMAINS = ['HR','Finance','Operations','Customer Service','Legal','IT','R&D','Marketing'];
const UC_APPROACHES = ['Generative AI','Supervised Learning','Unsupervised Learning','Reinforcement Learning','RPA','Rules-based'];
const UC_RISK_TIERS = ['Minimal','Limited','High','Unacceptable'];
const UC_OVERSIGHT = ['Required','Optional','None'];
const UC_CATEGORIES = ['AI','Process Automation','Analytics','Integration','Other'];

let ucAllUsecases = [];
let ucUsersCache = null;
let ucDragId = null;

function ucApplyFilter() { renderUseCaseBoard(); }

async function loadUseCases() {
  const [cases, users] = await Promise.all([
    api('/api/use-cases'),
    ucUsersCache ? Promise.resolve(ucUsersCache) : api('/api/org-users'),
  ]);
  ucAllUsecases = cases;
  ucUsersCache = users;
  renderUseCaseBoard();
}

function ucFilteredCases() {
  const domain   = document.getElementById('uc-filter-domain')?.value   || '';
  const category = document.getElementById('uc-filter-category')?.value || '';
  const priority = document.getElementById('uc-filter-priority')?.value || '';
  return ucAllUsecases.filter(uc =>
    (!domain   || uc.business_domain === domain) &&
    (!category || uc.category === category) &&
    (!priority || uc.priority === priority)
  );
}

function renderUseCaseBoard() {
  const board = document.getElementById('uc-kanban-board');
  if (!board) return;
  const cases = ucFilteredCases();

  // Stats bar
  const statsBar = document.getElementById('uc-stats-bar');
  if (statsBar) {
    statsBar.innerHTML = UC_STAGES.map(s => {
      const count = ucAllUsecases.filter(uc => uc.status === s.id).length;
      return `<div class="uc-stat-item">
        <span class="uc-stat-count" style="color:${s.color}">${count}</span>
        <span class="uc-stat-label">${s.label}</span>
      </div>`;
    }).join('');
  }

  // Columns
  board.innerHTML = UC_STAGES.map(stage => {
    const stageCases = cases.filter(uc => uc.status === stage.id);
    return `<div class="kanban-column"
        ondragover="event.preventDefault();this.classList.add('kanban-drag-over')"
        ondragleave="this.classList.remove('kanban-drag-over')"
        ondrop="ucDropCard(event,'${stage.id}');this.classList.remove('kanban-drag-over')"
        data-stage="${stage.id}">
      <div class="kanban-col-header" style="border-top:3px solid ${stage.color}">
        <span class="kanban-col-title">${stage.label}</span>
        <span class="kanban-col-count" style="background:${stage.color}18;color:${stage.color}">${stageCases.length}</span>
      </div>
      <div class="kanban-col-body">
        ${stageCases.map(uc => ucRenderCard(uc)).join('')}
        ${stage.id === 'new' ? `<button class="kanban-add-btn" onclick="openUseCaseModal()">+ New Use Case</button>` : ''}
        ${stageCases.length === 0 && stage.id !== 'new' ? `<div class="kanban-empty">Drop here</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function ucRenderCard(uc) {
  const riskBadge = uc.risk_tier
    ? `<span class="badge ${UC_RISK_BADGE[uc.risk_tier]||'badge-inactive'}" style="font-size:10px;padding:1px 5px">${esc(uc.risk_tier)}</span>`
    : '';
  const catStyle  = uc.category === 'AI' ? 'background:#ede9fe;color:#5b21b6' : 'background:#f1f5f9;color:#475569';
  const catBadge  = uc.category
    ? `<span class="badge" style="${catStyle};font-size:10px;padding:1px 5px">${esc(uc.category)}</span>`
    : '';
  const domBadge  = uc.business_domain
    ? `<span class="badge badge-inactive" style="font-size:10px;padding:1px 5px">${esc(uc.business_domain)}</span>`
    : '';
  const dot = `<span style="width:8px;height:8px;border-radius:50%;background:${UC_PRIORITY_DOT[uc.priority]||'#6b7280'};display:inline-block;flex-shrink:0;margin-top:4px" title="Priority: ${uc.priority}"></span>`;
  const owner = uc.owner_name
    ? `<div style="font-size:11px;color:var(--text-muted);margin-top:5px">&#128100; ${esc(uc.owner_name)}</div>`
    : '';
  const desc = uc.description
    ? `<p style="font-size:11px;color:var(--text-muted);margin:4px 0 5px;line-height:1.4">${esc(uc.description.substring(0,90))}${uc.description.length>90?'…':''}</p>`
    : '';
  return `<div class="kanban-card"
      draggable="true"
      ondragstart="ucDragStart(event,${uc.id})"
      ondragend="ucDragEnd(event)"
      onclick="openUseCaseModal(${uc.id})"
      data-id="${uc.id}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px">
      <span style="font-weight:600;font-size:13px;line-height:1.35;flex:1">${esc(uc.title)}</span>
      ${dot}
    </div>
    ${desc}
    <div style="display:flex;flex-wrap:wrap;gap:3px">${catBadge}${riskBadge}${domBadge}</div>
    ${owner}
  </div>`;
}

function ucDragStart(event, id) {
  ucDragId = id;
  event.dataTransfer.effectAllowed = 'move';
  event.currentTarget.classList.add('kanban-card-dragging');
}

function ucDragEnd(event) {
  event.currentTarget.classList.remove('kanban-card-dragging');
  document.querySelectorAll('.kanban-column').forEach(c => c.classList.remove('kanban-drag-over'));
}

async function ucDropCard(event, targetStage) {
  event.preventDefault();
  if (!ucDragId) return;
  const card = ucAllUsecases.find(uc => uc.id === ucDragId);
  ucDragId = null;
  if (!card || card.status === targetStage) return;
  try {
    const updated = await api(`/api/use-cases/${card.id}/stage`, { method: 'PUT', body: { status: targetStage } });
    const idx = ucAllUsecases.findIndex(uc => uc.id === updated.id);
    if (idx !== -1) ucAllUsecases[idx] = updated;
    renderUseCaseBoard();
  } catch (err) {
    alert(err.message || 'Cannot move to this stage. Check required fields first.');
    renderUseCaseBoard();
  }
}

// ---- Modal ----

let ucModalData = null; // current use case being edited

async function openUseCaseModal(id) {
  if (!ucUsersCache) ucUsersCache = await api('/api/org-users');
  ucModalData = id ? await api(`/api/use-cases/${id}`) : null;
  const members = id ? await api(`/api/use-cases/${id}/members`) : [];
  const approvals = id ? await api(`/api/use-cases/${id}/approvals`) : [];
  ucRenderModal(ucModalData, members, approvals);
  document.getElementById('usecase-modal').classList.remove('hidden');
}

function closeUseCaseModal() {
  document.getElementById('usecase-modal').classList.add('hidden');
  ucModalData = null;
}

function ucUserOptions(selectedId) {
  const opts = (ucUsersCache || []).map(u =>
    `<option value="${u.id}" ${u.id == selectedId ? 'selected' : ''}>${esc(u.name)}${u.department ? ` (${esc(u.department)})` : ''}</option>`
  ).join('');
  return `<option value="">— None —</option>${opts}`;
}

function ucRenderModal(uc, members, approvals) {
  const isNew = !uc;
  const stage = uc?.status || 'new';
  const stageObj = UC_STAGES.find(s => s.id === stage) || UC_STAGES[0];
  const stageBadge = `<span class="badge" style="background:${stageObj.color}18;color:${stageObj.color};border:1px solid ${stageObj.color}40">${stageObj.label}</span>`;

  // Next stage button (not shown for retired or production-without-next)
  const stageIdx = UC_STAGES.findIndex(s => s.id === stage);
  const nextStage = stageIdx < UC_STAGES.length - 1 ? UC_STAGES[stageIdx + 1] : null;
  const nextBtn = (!isNew && nextStage)
    ? `<button type="button" class="btn btn-primary" onclick="ucMoveStage('${nextStage.id}')" style="background:${nextStage.color}">&#8594; Move to ${nextStage.label}</button>`
    : '';

  const membersHtml = members.map(m =>
    `<span class="uc-member-chip">&#128100; ${esc(m.name)}<button type="button" onclick="ucRemoveMember(${uc?.id},${m.user_id})" title="Remove">&times;</button></span>`
  ).join('') || '<span style="color:var(--text-muted);font-size:12px">No members yet</span>';

  const approvalsHtml = approvals.length ? `
    <div class="uc-approvals-list">
      ${approvals.map(a => `
        <div class="uc-approval-item">
          <span class="badge ${a.decision==='approved'?'badge-active':a.decision==='rejected'?'badge-high':'badge-medium'}">${a.decision}</span>
          <span style="font-size:12px;margin-left:6px"><strong>${esc(a.approver_name||'Unknown')}</strong></span>
          ${a.notes ? `<span style="font-size:12px;color:var(--text-muted);margin-left:6px">${esc(a.notes)}</span>` : ''}
          <span style="font-size:11px;color:var(--text-muted);margin-left:auto">${a.created_at ? new Date(a.created_at).toLocaleDateString() : ''}</span>
        </div>`).join('')}
    </div>` : '';

  document.getElementById('usecase-modal-content').innerHTML = `
    <div class="modal-header" style="align-items:flex-start;gap:12px">
      <div style="flex:1">
        <input type="text" id="uc-title" value="${isNew?'':esc(uc.title)}" placeholder="Use case title *" required
          style="font-size:18px;font-weight:700;border:none;border-bottom:2px solid var(--border);border-radius:0;width:100%;padding:4px 0;background:transparent;outline:none">
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
        ${isNew?'':stageBadge}
        <button class="modal-close" onclick="closeUseCaseModal()">&times;</button>
      </div>
    </div>

    <div class="modal-body" style="overflow-y:auto;max-height:70vh;padding:0 24px 8px">

      <!-- OVERVIEW -->
      <div class="uc-section">
        <div class="uc-section-title">Overview</div>
        <div class="form-group">
          <label>Description</label>
          <textarea id="uc-description" rows="2" placeholder="What problem does this solve?">${isNew?'':esc(uc.description||'')}</textarea>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Category</label>
            <select id="uc-category">
              ${UC_CATEGORIES.map(c=>`<option value="${c}" ${uc?.category===c?'selected':''}>${c}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Business Domain</label>
            <select id="uc-domain">
              <option value="">— None —</option>
              ${UC_DOMAINS.map(d=>`<option value="${d}" ${uc?.business_domain===d?'selected':''}>${d}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>AI Approach</label>
            <select id="uc-approach">
              <option value="">— None —</option>
              ${UC_APPROACHES.map(a=>`<option value="${a}" ${uc?.ai_approach===a?'selected':''}>${a}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Priority</label>
            <select id="uc-priority">
              <option value="low"      ${uc?.priority==='low'      ?'selected':''}>Low</option>
              <option value="medium"   ${(!uc||uc.priority==='medium')?'selected':''}>Medium</option>
              <option value="high"     ${uc?.priority==='high'     ?'selected':''}>High</option>
              <option value="critical" ${uc?.priority==='critical' ?'selected':''}>Critical</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Business Value</label>
          <textarea id="uc-business-value" rows="2" placeholder="Expected business value or outcomes">${isNew?'':esc(uc.business_value||'')}</textarea>
        </div>
      </div>

      <!-- PEOPLE -->
      <div class="uc-section">
        <div class="uc-section-title">People &amp; Ownership</div>
        <div class="form-row">
          <div class="form-group">
            <label>Business Owner / Sponsor</label>
            <select id="uc-owner">${ucUserOptions(uc?.owner_id)}</select>
          </div>
          <div class="form-group">
            <label>Implementation Owner</label>
            <select id="uc-impl-owner">${ucUserOptions(uc?.implementation_owner_id)}</select>
          </div>
        </div>
        ${!isNew ? `
        <div class="form-group">
          <label>Team Members</label>
          <div id="uc-members-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">${membersHtml}</div>
          <div style="display:flex;gap:8px">
            <select id="uc-add-member-sel" style="flex:1">
              <option value="">Add member…</option>
              ${(ucUsersCache||[]).filter(u=>!members.find(m=>m.user_id===u.id)).map(u=>`<option value="${u.id}">${esc(u.name)}</option>`).join('')}
            </select>
            <button type="button" class="btn btn-secondary btn-sm" onclick="ucAddMember(${uc?.id})">Add</button>
          </div>
        </div>` : ''}
      </div>

      <!-- ASSESSMENT -->
      <div class="uc-section">
        <div class="uc-section-title">Risk &amp; Assessment</div>
        <div class="form-row">
          <div class="form-group">
            <label>Risk Tier (EU AI Act)</label>
            <select id="uc-risk-tier">
              <option value="">— Not assessed —</option>
              ${UC_RISK_TIERS.map(t=>`<option value="${t}" ${uc?.risk_tier===t?'selected':''}>${t}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Human Oversight</label>
            <select id="uc-oversight">
              <option value="">— Not set —</option>
              ${UC_OVERSIGHT.map(o=>`<option value="${o}" ${uc?.human_oversight===o?'selected':''}>${o}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Fallback Process (if use case fails)</label>
          <textarea id="uc-fallback" rows="2" placeholder="What happens if this use case is unavailable?">${isNew?'':esc(uc.fallback_process||'')}</textarea>
        </div>
        <div class="form-group">
          <label>Success KPIs</label>
          <textarea id="uc-kpis" rows="2" placeholder="How will success be measured?">${isNew?'':esc(uc.success_kpis||'')}</textarea>
        </div>
      </div>

      <!-- GOVERNANCE -->
      <div class="uc-section">
        <div class="uc-section-title">Governance &amp; Approval</div>
        <div class="form-row">
          <div class="form-group">
            <label>Approved By</label>
            <select id="uc-approved-by">${ucUserOptions(uc?.approved_by_id)}</select>
          </div>
          <div class="form-group">
            <label>Approval Date</label>
            <input type="date" id="uc-approval-date" value="${uc?.approval_date||''}">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Target Go-Live</label>
            <input type="date" id="uc-target-live" value="${uc?.target_go_live||''}">
          </div>
          <div class="form-group">
            <label>Next Review Date</label>
            <input type="date" id="uc-review-date" value="${uc?.next_review_date||''}">
          </div>
        </div>
        ${!isNew ? `
        <details style="margin-top:8px">
          <summary style="cursor:pointer;font-size:12px;color:var(--text-muted);user-select:none">Approval History (${approvals.length})</summary>
          ${approvalsHtml || '<p style="font-size:12px;color:var(--text-muted);margin:8px 0 0">No approval records yet.</p>'}
          <div style="display:flex;gap:8px;margin-top:8px">
            <select id="uc-approval-user" style="flex:1">${ucUserOptions(null)}</select>
            <select id="uc-approval-decision" style="width:110px">
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
            <input type="text" id="uc-approval-notes" placeholder="Notes" style="flex:2;min-width:0">
            <button type="button" class="btn btn-secondary btn-sm" onclick="ucRecordApproval(${uc?.id})">Record</button>
          </div>
        </details>` : ''}
      </div>

      <!-- PRODUCTION -->
      <div class="uc-section">
        <div class="uc-section-title">Production &amp; Monitoring</div>
        <div class="form-row">
          <div class="form-group">
            <label>Go-Live Date</label>
            <input type="date" id="uc-go-live" value="${uc?.go_live_date||''}">
          </div>
          <div class="form-group">
            <label>Incident Reporting Active</label>
            <select id="uc-incident">
              <option value="0" ${!uc?.incident_reporting?'selected':''}>No</option>
              <option value="1" ${uc?.incident_reporting?'selected':''}>Yes</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Performance Notes</label>
          <textarea id="uc-perf-notes" rows="2" placeholder="Observations, metrics, issues in production">${isNew?'':esc(uc.performance_notes||'')}</textarea>
        </div>
        ${!isNew && stage === 'retired' ? `
        <div class="form-group">
          <label>Retirement Reason</label>
          <textarea id="uc-retire-reason" rows="2">${esc(uc.retirement_reason||'')}</textarea>
        </div>` : ''}
      </div>

      <!-- LINKED ITEMS -->
      ${!isNew ? `
      <div class="uc-section">
        <div class="uc-section-title">Linked Architectural Items</div>
        <div id="uc-crosslinks-${uc.id}"></div>
      </div>` : ''}

    </div><!-- end modal-body -->

    <div class="modal-footer" style="display:flex;justify-content:space-between;align-items:center;padding:12px 24px;border-top:1px solid var(--border);flex-wrap:wrap;gap:8px">
      <div style="display:flex;gap:8px">
        ${!isNew ? `<button type="button" class="btn btn-secondary" style="color:var(--danger)" onclick="ucDelete(${uc.id})">Delete</button>` : ''}
      </div>
      <div style="display:flex;gap:8px">
        <button type="button" class="btn btn-secondary" onclick="closeUseCaseModal()">Cancel</button>
        <button type="button" class="btn btn-primary" onclick="ucSave(${isNew?'null':uc.id})">Save</button>
        ${nextBtn}
      </div>
    </div>`;

  // Load cross-links after render
  if (!isNew) {
    setTimeout(() => renderCrossLinks('usecase', uc.id, `uc-crosslinks-${uc.id}`), 0);
  }
}

async function ucSave(id) {
  const title = document.getElementById('uc-title').value.trim();
  if (!title) { alert('Title is required'); return; }
  const body = {
    title,
    description:             document.getElementById('uc-description').value.trim(),
    category:                document.getElementById('uc-category').value,
    business_domain:         document.getElementById('uc-domain').value,
    ai_approach:             document.getElementById('uc-approach').value,
    priority:                document.getElementById('uc-priority').value,
    business_value:          document.getElementById('uc-business-value').value.trim(),
    owner_id:                document.getElementById('uc-owner').value || null,
    implementation_owner_id: document.getElementById('uc-impl-owner').value || null,
    risk_tier:               document.getElementById('uc-risk-tier').value,
    human_oversight:         document.getElementById('uc-oversight').value,
    fallback_process:        document.getElementById('uc-fallback').value.trim(),
    success_kpis:            document.getElementById('uc-kpis').value.trim(),
    approved_by_id:          document.getElementById('uc-approved-by').value || null,
    approval_date:           document.getElementById('uc-approval-date').value || null,
    target_go_live:          document.getElementById('uc-target-live').value || null,
    next_review_date:        document.getElementById('uc-review-date').value || null,
    go_live_date:            document.getElementById('uc-go-live').value || null,
    incident_reporting:      document.getElementById('uc-incident').value,
    performance_notes:       document.getElementById('uc-perf-notes').value.trim(),
  };
  const retireEl = document.getElementById('uc-retire-reason');
  if (retireEl) body.retirement_reason = retireEl.value.trim();

  try {
    let updated;
    if (id) {
      updated = await api(`/api/use-cases/${id}`, { method: 'PUT', body });
      const idx = ucAllUsecases.findIndex(uc => uc.id === updated.id);
      if (idx !== -1) ucAllUsecases[idx] = updated;
    } else {
      updated = await api('/api/use-cases', { method: 'POST', body });
      ucAllUsecases.push(updated);
    }
    closeUseCaseModal();
    renderUseCaseBoard();
  } catch (err) {
    alert(err.message || 'Failed to save');
  }
}

async function ucMoveStage(targetStage) {
  if (!ucModalData) return;
  // Save current edits first
  await ucSave(ucModalData.id);
  try {
    const updated = await api(`/api/use-cases/${ucModalData.id}/stage`, { method: 'PUT', body: { status: targetStage } });
    const idx = ucAllUsecases.findIndex(uc => uc.id === updated.id);
    if (idx !== -1) ucAllUsecases[idx] = updated;
    closeUseCaseModal();
    renderUseCaseBoard();
  } catch (err) {
    alert(err.message || 'Cannot advance stage. Check required fields.');
  }
}

async function ucDelete(id) {
  if (!confirm('Delete this use case? This cannot be undone.')) return;
  await api(`/api/use-cases/${id}`, { method: 'DELETE' });
  ucAllUsecases = ucAllUsecases.filter(uc => uc.id !== id);
  closeUseCaseModal();
  renderUseCaseBoard();
}

async function ucAddMember(useCaseId) {
  const sel = document.getElementById('uc-add-member-sel');
  const userId = sel?.value;
  if (!userId) return;
  const members = await api(`/api/use-cases/${useCaseId}/members`, { method: 'POST', body: { user_id: parseInt(userId) } });
  const chipsEl = document.getElementById('uc-members-chips');
  if (chipsEl) {
    chipsEl.innerHTML = members.map(m =>
      `<span class="uc-member-chip">&#128100; ${esc(m.name)}<button type="button" onclick="ucRemoveMember(${useCaseId},${m.user_id})" title="Remove">&times;</button></span>`
    ).join('') || '<span style="color:var(--text-muted);font-size:12px">No members yet</span>';
  }
  // Remove the added user from the dropdown
  const opt = sel.querySelector(`option[value="${userId}"]`);
  if (opt) opt.remove();
  sel.value = '';
}

async function ucRemoveMember(useCaseId, userId) {
  await api(`/api/use-cases/${useCaseId}/members/${userId}`, { method: 'DELETE' });
  const members = await api(`/api/use-cases/${useCaseId}/members`);
  const chipsEl = document.getElementById('uc-members-chips');
  if (chipsEl) {
    chipsEl.innerHTML = members.map(m =>
      `<span class="uc-member-chip">&#128100; ${esc(m.name)}<button type="button" onclick="ucRemoveMember(${useCaseId},${m.user_id})" title="Remove">&times;</button></span>`
    ).join('') || '<span style="color:var(--text-muted);font-size:12px">No members yet</span>';
    // Re-add user to add-member select
    const sel = document.getElementById('uc-add-member-sel');
    const user = (ucUsersCache||[]).find(u => u.id === userId);
    if (sel && user) {
      const opt = document.createElement('option');
      opt.value = user.id;
      opt.textContent = user.name;
      sel.appendChild(opt);
    }
  }
}

async function ucRecordApproval(useCaseId) {
  const approved_by_id = document.getElementById('uc-approval-user')?.value || null;
  const decision       = document.getElementById('uc-approval-decision')?.value;
  const notes          = document.getElementById('uc-approval-notes')?.value.trim() || '';
  if (!decision) return;
  await api(`/api/use-cases/${useCaseId}/approvals`, { method: 'POST', body: { approved_by_id, decision, notes } });
  // Refresh modal to show new approval
  const members  = await api(`/api/use-cases/${useCaseId}/members`);
  const approvals = await api(`/api/use-cases/${useCaseId}/approvals`);
  ucModalData = await api(`/api/use-cases/${useCaseId}`);
  ucRenderModal(ucModalData, members, approvals);
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
    </div>
    <div class="kpi-tile" onclick="switchView('use-cases')">
      <h4 class="kpi-tile-title">&#128221; Use Cases</h4>
      <div class="kpi-tile-stats">
        ${kpiStat(d.usecases_total, 'Total', '')}
        ${kpiStat(d.usecases_active, 'Active', d.usecases_active > 0 ? 'kpi-ok' : '')}
        ${kpiStat(d.usecases_proposed, 'Proposed', '')}
        ${kpiStat(d.usecases_draft, 'Draft', '')}
        ${kpiStat(d.usecases_deprecated, 'Deprecated', d.usecases_deprecated > 0 ? 'kpi-danger' : '')}
      </div>
    </div>`;

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
const archTypeLabels = { role: 'Roles & Responsibilities', process: 'Processes', system: 'Systems / Data', asset: 'Assets', facility: 'Facilities', supplier: 'Suppliers', ai_model: 'AI Model Inventory', ai_dataset: 'Data Catalog', ai_usecase: 'AI Use Cases' };

function switchArchTab(type) {
  currentArchTab = type;
  document.querySelectorAll('.arch-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.arch-tab[onclick="switchArchTab('${type}')"]`).classList.add('active');

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

// --- Document Control ---
let docFilters = { doc_type: '', status: '', classification: '', process: '', owner: '', search: '' };

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
  let cols = '1fr';
  if (vis.type) cols += ' 110px';
  if (vis.classification) cols += ' 100px';
  if (vis.status) cols += ' 80px';
  if (vis.version) cols += ' 60px';
  if (vis.owner) cols += ' 90px';
  if (vis.review) cols += ' 90px';
  if (vis.links) cols += ' 120px';
  cols += ' 44px';
  return cols;
}

async function loadDocumentControl() {
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
        <option value="evidence" ${docFilters.doc_type==='evidence'?'selected':''}>Evidence</option>
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
      <div class="doc-col-toggle" style="margin-left:auto">
        <button class="doc-col-toggle-btn" onclick="this.nextElementSibling.classList.toggle('open')" type="button">&#9881; Columns</button>
        <div class="doc-col-dropdown">
          ${DOC_COLUMNS.map(c => `<label><input type="checkbox" ${vis[c.key] ? 'checked' : ''} onchange="toggleDocColumn('${c.key}')"> ${esc(c.label)}</label>`).join('')}
        </div>
      </div>
    </div>
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px">${docs.length} document${docs.length!==1?'s':''} found</div>`;

  // Close column dropdown when clicking outside
  document.addEventListener('click', function _closeDocColDrop(e) {
    if (!e.target.closest('.doc-col-toggle')) {
      const dd = document.querySelector('.doc-col-dropdown.open');
      if (dd) dd.classList.remove('open');
    }
  }, { once: true });

  const list = document.getElementById('doc-list');
  if (docs.length === 0) {
    list.innerHTML = '<div class="empty-state">No documents yet. Upload one to get started.</div>';
    return;
  }

  const docTypeLabels = { policy: 'Policy', procedure: 'Procedure', work_instruction: 'Work Instruction', record: 'Record', form: 'Form', report: 'Report', evidence: 'Evidence', other: 'Other' };
  const docTypeBadge = t => t === 'policy' ? 'badge-critical' : t === 'procedure' ? 'badge-high' : t === 'work_instruction' ? 'badge-medium' : t === 'evidence' ? 'badge-inactive' : 'badge-low';
  const statusBadge = s => s === 'approved' ? 'badge-low' : s === 'review' ? 'badge-medium' : s === 'obsolete' ? 'badge-inactive' : 'badge-high';
  const classificationBadge = c => c === 'restricted' ? 'badge-critical' : c === 'confidential' ? 'badge-high' : c === 'internal' ? 'badge-medium' : 'badge-low';
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
        <div class="doc-col-title" style="cursor:pointer" onclick="openDocModal(${d.id})">
          <span class="doc-row-title" style="color:var(--primary)">${esc(d.title)}</span>
          ${d.file_name ? `<span class="doc-row-file">${esc(d.file_name)}</span>` : ''}
        </div>
        ${vis.type ? `<div class="doc-col-type"><span class="badge ${docTypeBadge(d.doc_type)}">${esc(typeLabel)}</span></div>` : ''}
        ${vis.classification ? `<div class="doc-col-class">
          ${d.classification ? `<span class="badge ${classificationBadge(d.classification)}">${esc(d.classification)}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}
        </div>` : ''}
        ${vis.status ? `<div class="doc-col-status"><span class="badge ${statusBadge(d.status)}">${esc(d.status)}</span></div>` : ''}
        ${vis.version ? `<div class="doc-col-ver">v${esc(d.version)}</div>` : ''}
        ${vis.owner ? `<div class="doc-col-owner">${d.owner ? `<span style="font-size:12px">${esc(d.owner)}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}</div>` : ''}
        ${vis.review ? `<div class="doc-col-review">${d.review_date ? `<span style="font-size:12px;${reviewOverdue ? 'color:var(--danger);font-weight:600' : ''}">${d.review_date}</span>` : '<span style="color:var(--text-muted);font-size:11px">-</span>'}</div>` : ''}
        ${vis.links ? `<div class="doc-col-links">
          <span class="doc-link-summary" style="cursor:pointer;font-size:12px" onclick="document.getElementById('${collapseId}').classList.toggle('collapsed');this.querySelector('.cl-toggle-icon').textContent=document.getElementById('${collapseId}').classList.contains('collapsed')?'+':'−'">${linkSummary} <span class="cl-toggle-icon">${links.length > 0 ? '+' : ''}</span></span>
        </div>` : ''}
        <div class="doc-col-actions">
          ${actionMenu([
            ...(d.file_name ? [{ label: '&#128229; Download', onclick: `downloadDoc(${d.id})` }] : []),
            ...(/\.(docx?|xlsx?|pptx?)$/i.test(d.file_name || '') ? [{ label: '&#9998;&#65039; Edit in Browser', onclick: `openDocEditor(${d.id},${JSON.stringify(d.title)})` }] : []),
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
let _ooEditor = null;  // active DocsAPI.DocEditor instance

async function openDocEditor(id, title) {
  _docEditorId = id;
  const modal = document.getElementById('doc-editor-modal');
  const body = document.getElementById('doc-editor-body');
  const saveBtn = document.getElementById('doc-editor-save-btn');
  const modalContent = modal.querySelector('.modal-content');

  document.getElementById('doc-editor-title').textContent = `Edit: ${title || 'Document'}`;
  body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">Loading editor\u2026</div>';
  saveBtn.style.display = 'none';
  modal.classList.remove('hidden');

  // Try ONLYOFFICE first
  let ooConfig;
  try {
    ooConfig = await api(`/api/documents/${id}/onlyoffice-config`);
  } catch (e) {
    // ONLYOFFICE not configured or file type unsupported — fall back to simple editor
    saveBtn.style.display = '';
    modalContent.classList.remove('doc-editor-fullscreen');
    await _openSimpleEditor(id, body);
    return;
  }

  // ONLYOFFICE is available — switch to full-screen modal
  modalContent.classList.add('doc-editor-fullscreen');
  body.innerHTML = '<div id="oo-editor-placeholder" style="width:100%;height:100%"></div>';

  try {
    await _loadScript(`${ooConfig.serverUrl}/web-apps/apps/api/documents/api.js`);
    _ooEditor = new DocsAPI.DocEditor('oo-editor-placeholder', {
      ...ooConfig.editorConfig,
      events: {
        onRequestClose() { closeDocEditor(); },
        onError(e) {
          showToast('Editor error: ' + (e?.data?.errorDescription || 'unknown error'), 'error');
        },
      },
    });
  } catch (e) {
    // ONLYOFFICE script failed to load — fall back to simple editor
    _ooEditor = null;
    modalContent.classList.remove('doc-editor-fullscreen');
    saveBtn.style.display = '';
    await _openSimpleEditor(id, body);
  }
}

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${CSS.escape ? src : src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

async function _openSimpleEditor(id, body) {
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
  if (_ooEditor) {
    try { _ooEditor.destroyEditor(); } catch {}
    _ooEditor = null;
  }
  const modal = document.getElementById('doc-editor-modal');
  modal.querySelector('.modal-content').classList.remove('doc-editor-fullscreen');
  modal.classList.add('hidden');
  document.getElementById('doc-editor-save-btn').style.display = '';
  _docEditorId = null; _docEditorType = null;
  _docEditorSheets = null; _docEditorSheetNames = null;
  loadDocumentControl(); // refresh list so updated_at changes reflect
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

// --- User Widget Dropdown ---
function toggleUserDropdown(e) {
  e.stopPropagation();
  const dropdown = document.getElementById('user-widget-dropdown');
  const trigger = document.getElementById('user-widget-trigger');
  const isOpen = dropdown.classList.contains('open');
  if (isOpen) {
    dropdown.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
  } else {
    dropdown.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
  }
}

function closeUserDropdown() {
  const dropdown = document.getElementById('user-widget-dropdown');
  const trigger = document.getElementById('user-widget-trigger');
  if (dropdown) dropdown.classList.remove('open');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  const widget = document.getElementById('user-widget');
  if (widget && !widget.contains(e.target)) closeUserDropdown();
});

// --- My Tasks View ---
async function loadMyTasks() {
  const container = document.getElementById('my-tasks-content');
  if (!container) return;
  container.innerHTML = '<div class="empty-state">Loading your tasks…</div>';
  try {
    const data = await api('/api/my-tasks');
    container.innerHTML = renderMyTasksContent(data);
  } catch (err) {
    container.innerHTML = `<div class="empty-state" style="color:var(--danger)">Failed to load tasks: ${esc(err.message)}</div>`;
  }
}

function renderMyTasksContent(data) {
  const { tasks = [], actions = [], ncrs = [], audits = [], treatments = [], mgmtOutputs = [], assignedRoles = [] } = data;
  const today = new Date().toISOString().split('T')[0];
  const roleSet = new Set(assignedRoles);

  // ── Shared helpers ─────────────────────────────────────────────────────────

  function priorityBadge(p) {
    const map = { Critical: 'badge-critical', High: 'badge-high', Medium: 'badge-medium', Low: 'badge-low' };
    return `<span class="badge ${map[p] || 'badge-low'}">${p || 'Medium'}</span>`;
  }

  function statusBadge(s, statusMap) {
    const map = statusMap || { open: 'badge-medium', in_progress: 'badge-high', resolved: 'badge-low', closed: 'badge-inactive' };
    return `<span class="badge ${map[s] || 'badge-medium'}">${(s || '').replace(/_/g, ' ')}</span>`;
  }

  function dueDateLabel(dateStr) {
    if (!dateStr) return '<span class="my-tasks-due">—</span>';
    const isOverdue = dateStr < today;
    const isToday = dateStr === today;
    const cls = isOverdue ? 'my-tasks-overdue' : isToday ? 'my-tasks-today' : '';
    const label = isOverdue ? '⚠ Overdue · ' : isToday ? '● Due Today · ' : '';
    return `<span class="my-tasks-due ${cls}">${label}${dateStr}</span>`;
  }

  // Returns a "via Role" chip when the assignee field is a role name (not the user directly)
  function roleTag(assigneeField) {
    if (assigneeField && roleSet.has(assigneeField)) {
      return `<span class="my-tasks-role-tag" title="Assigned via role">&#128100; ${esc(assigneeField)}</span>`;
    }
    return '';
  }

  // ── Section builder ────────────────────────────────────────────────────────

  function section(icon, title, count, body) {
    return `
      <div class="my-tasks-section">
        <div class="my-tasks-section-header">
          <span class="my-tasks-section-icon">${icon}</span>
          <h3>${title} <span class="my-tasks-count">${count}</span></h3>
        </div>
        ${body}
      </div>`;
  }

  function emptyMsg(msg) {
    return `<div class="my-tasks-empty">${msg}</div>`;
  }

  function itemRowCls(dateStr) {
    if (!dateStr) return 'my-tasks-item';
    return dateStr < today ? 'my-tasks-item overdue' : dateStr === today ? 'my-tasks-item today' : 'my-tasks-item';
  }

  // ── Assigned-roles header ──────────────────────────────────────────────────
  let headerHtml = '';
  if (assignedRoles.length > 0) {
    headerHtml = `
      <div class="my-tasks-roles-bar">
        <span class="my-tasks-roles-label">&#128100; Your roles:</span>
        ${assignedRoles.map(r => `<span class="my-tasks-role-chip">${esc(r)}</span>`).join('')}
      </div>`;
  }

  // ── Recurring Tasks ────────────────────────────────────────────────────────
  let tasksBody = '';
  if (tasks.length === 0) {
    tasksBody = emptyMsg('No recurring tasks assigned to you or your roles.');
  } else {
    tasksBody = '<div class="my-tasks-list">';
    for (const t of tasks) {
      tasksBody += `
        <div class="${itemRowCls(t.next_due)}" onclick="switchView('tasks')">
          <div class="my-tasks-item-main">
            <div class="my-tasks-item-title">${esc(t.title)}</div>
            <div class="my-tasks-item-sub">
              ${t.category ? `<span class="my-tasks-cat">${esc(t.category)}</span>` : ''}
              ${roleTag(t.assignee)}
            </div>
          </div>
          <div class="my-tasks-item-meta">
            ${priorityBadge(t.priority)}
            <span class="my-tasks-recurrence">&#8635; ${t.recurrence}</span>
            ${dueDateLabel(t.next_due)}
          </div>
        </div>`;
    }
    tasksBody += '</div>';
  }

  // ── Follow-up Actions ──────────────────────────────────────────────────────
  let actionsBody = '';
  const actionStatusMap = { open: 'badge-medium', in_progress: 'badge-high', resolved: 'badge-low', closed: 'badge-inactive' };
  if (actions.length === 0) {
    actionsBody = emptyMsg('No open actions assigned to you or your roles.');
  } else {
    actionsBody = '<div class="my-tasks-list">';
    for (const a of actions) {
      actionsBody += `
        <div class="${itemRowCls(a.due_date)}" onclick="switchView('actions')">
          <div class="my-tasks-item-main">
            <div class="my-tasks-item-title">${esc(a.title)}</div>
            <div class="my-tasks-item-sub">
              ${a.task_title ? `<span class="my-tasks-cat">&#128279; ${esc(a.task_title)}</span>` : ''}
              ${roleTag(a.assignee)}
            </div>
          </div>
          <div class="my-tasks-item-meta">
            ${priorityBadge(a.priority)}
            ${statusBadge(a.status, actionStatusMap)}
            ${dueDateLabel(a.due_date)}
          </div>
        </div>`;
    }
    actionsBody += '</div>';
  }

  // ── Audits ─────────────────────────────────────────────────────────────────
  let auditsBody = '';
  const auditStatusMap = { planned: 'badge-medium', in_progress: 'badge-high', completed: 'badge-low' };
  if (audits.length === 0) {
    auditsBody = emptyMsg('No upcoming audits assigned to you or your roles.');
  } else {
    auditsBody = '<div class="my-tasks-list">';
    for (const a of audits) {
      // Determine whether user is lead auditor, auditee, or both (via direct match or role)
      const roles = [];
      if (a.lead_auditor) roles.push({ field: a.lead_auditor, label: 'Lead Auditor' });
      if (a.auditee) roles.push({ field: a.auditee, label: 'Auditee' });
      const roleChips = roles.map(r =>
        `<span class="my-tasks-cat">${r.label}: ${esc(r.field)}${roleSet.has(r.field) ? ' <span class="my-tasks-role-tag" title="Via role">&#128100;</span>' : ''}</span>`
      ).join('');
      auditsBody += `
        <div class="${itemRowCls(a.planned_date)}" onclick="switchView('audit-plan')">
          <div class="my-tasks-item-main">
            <div class="my-tasks-item-title">${esc(a.title)}</div>
            <div class="my-tasks-item-sub">${roleChips}</div>
          </div>
          <div class="my-tasks-item-meta">
            ${statusBadge(a.status, auditStatusMap)}
            ${dueDateLabel(a.planned_date)}
          </div>
        </div>`;
    }
    auditsBody += '</div>';
  }

  // ── Risk Treatments ────────────────────────────────────────────────────────
  let treatmentsBody = '';
  const treatmentStatusMap = { planned: 'badge-medium', in_progress: 'badge-high', completed: 'badge-low', accepted: 'badge-inactive' };
  if (treatments.length === 0) {
    treatmentsBody = emptyMsg('No open risk treatments assigned to you or your roles.');
  } else {
    treatmentsBody = '<div class="my-tasks-list">';
    for (const t of treatments) {
      const desc = t.description ? (t.description.length > 90 ? t.description.substring(0, 90) + '…' : t.description) : '—';
      treatmentsBody += `
        <div class="${itemRowCls(t.due_date)}" onclick="switchView('risk-treatment')">
          <div class="my-tasks-item-main">
            <div class="my-tasks-item-title">${esc(desc)}</div>
            <div class="my-tasks-item-sub">
              ${t.risk_title ? `<span class="my-tasks-cat">&#9888; ${esc(t.risk_title)}</span>` : ''}
              ${roleTag(t.responsible)}
            </div>
          </div>
          <div class="my-tasks-item-meta">
            ${t.treatment_type ? `<span class="my-tasks-recurrence">${esc(t.treatment_type)}</span>` : ''}
            ${statusBadge(t.status, treatmentStatusMap)}
            ${dueDateLabel(t.due_date)}
          </div>
        </div>`;
    }
    treatmentsBody += '</div>';
  }

  // ── Non-Conformities ───────────────────────────────────────────────────────
  let ncrsBody = '';
  const ncrStatusMap = { open: 'badge-medium', in_progress: 'badge-high', closed: 'badge-low', verified: 'badge-inactive' };
  if (ncrs.length === 0) {
    ncrsBody = emptyMsg('No open non-conformities assigned to you or your roles.');
  } else {
    ncrsBody = '<div class="my-tasks-list">';
    for (const n of ncrs) {
      const desc = n.description.length > 100 ? n.description.substring(0, 100) + '…' : n.description;
      ncrsBody += `
        <div class="${itemRowCls(n.due_date)}" onclick="switchView('audit-ncrs')">
          <div class="my-tasks-item-main">
            <div class="my-tasks-item-title">${esc(desc)}</div>
            <div class="my-tasks-item-sub">
              ${n.audit_title ? `<span class="my-tasks-cat">&#9998; ${esc(n.audit_title)}</span>` : ''}
              ${roleTag(n.responsible)}
            </div>
          </div>
          <div class="my-tasks-item-meta">
            <span class="badge ${n.severity === 'major' ? 'badge-critical' : 'badge-medium'}">${n.severity || 'minor'}</span>
            ${statusBadge(n.status, ncrStatusMap)}
            ${dueDateLabel(n.due_date)}
          </div>
        </div>`;
    }
    ncrsBody += '</div>';
  }

  // ── Management Review Outputs ──────────────────────────────────────────────
  let mgmtOutputsBody = '';
  const mgmtStatusMap = { open: 'badge-medium', in_progress: 'badge-high', completed: 'badge-low' };
  const mgmtTypeLabels = { improvement: 'Improvement', resource: 'Resource Need', change: 'System Change' };
  if (mgmtOutputs.length === 0) {
    mgmtOutputsBody = emptyMsg('No open management review outputs assigned to you or your roles.');
  } else {
    mgmtOutputsBody = '<div class="my-tasks-list">';
    for (const o of mgmtOutputs) {
      const desc = o.description.length > 100 ? o.description.substring(0, 100) + '…' : o.description;
      mgmtOutputsBody += `
        <div class="${itemRowCls(o.due_date)}" onclick="switchView('management-reviews')">
          <div class="my-tasks-item-main">
            <div class="my-tasks-item-title">${esc(desc)}</div>
            <div class="my-tasks-item-sub">
              ${o.review_title ? `<span class="my-tasks-cat">&#128203; ${esc(o.review_title)}</span>` : ''}
              ${o.type ? `<span class="my-tasks-cat">${mgmtTypeLabels[o.type] || o.type}</span>` : ''}
              ${roleTag(o.assigned_to)}
            </div>
          </div>
          <div class="my-tasks-item-meta">
            ${statusBadge(o.status, mgmtStatusMap)}
            ${dueDateLabel(o.due_date)}
          </div>
        </div>`;
    }
    mgmtOutputsBody += '</div>';
  }

  // ── All-done state ─────────────────────────────────────────────────────────
  const totalCount = tasks.length + actions.length + ncrs.length + audits.length + treatments.length + mgmtOutputs.length;
  if (totalCount === 0) {
    return `${headerHtml}
      <div class="my-tasks-all-done">
        <div class="my-tasks-all-done-icon">&#10003;</div>
        <div class="my-tasks-all-done-text">You're all caught up! Nothing is currently assigned to you${assignedRoles.length ? ' or your roles' : ''}.</div>
      </div>`;
  }

  return headerHtml
    + section('&#9745;', 'Recurring Tasks', tasks.length, tasksBody)
    + section('&#9889;', 'Follow-up Actions', actions.length, actionsBody)
    + section('&#9998;', 'Audits', audits.length, auditsBody)
    + section('&#128737;', 'Risk Treatments', treatments.length, treatmentsBody)
    + section('&#9888;', 'Non-Conformities', ncrs.length, ncrsBody)
    + section('&#128203;', 'Management Review Actions', mgmtOutputs.length, mgmtOutputsBody);
}

// --- Helpers ---
// ─── Op-Plan Process Context Bar ─────────────────────────────────────────────

const BUNDLE_COLORS = ['#6366f1','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6'];

async function loadOpPlanContextData() {
  try {
    const [procs, bundles] = await Promise.all([
      api('/api/architecture?arch_type=process'),
      api('/api/plan-bundles'),
    ]);
    opPlanProcesses = procs;
    opPlanBundles = bundles;
  } catch(e) { /* silently ignore */ }
}

function getOpPlanContextNames() {
  // Returns array of process names matching current context, or null for 'all'
  if (opPlanContext.type === 'all') return null;
  if (opPlanContext.type === 'process') {
    const p = opPlanProcesses.find(p => p.id === opPlanContext.id);
    return p ? [p.name] : null;
  }
  if (opPlanContext.type === 'bundle') {
    const bundle = opPlanBundles.find(b => b.id === opPlanContext.id);
    if (!bundle) return null;
    const ids = JSON.parse(bundle.process_ids || '[]');
    return opPlanProcesses.filter(p => ids.includes(p.id)).map(p => p.name);
  }
  return null;
}

function renderOpPlanContextBar() {
  const bar = document.getElementById('op-plan-context-bar');
  if (!bar) return;

  const allPill = `<button class="op-ctx-pill${opPlanContext.type==='all'?' active':''}" onclick="setOpPlanContext('all',null)">All Processes</button>`;

  const procPills = opPlanProcesses.map(p =>
    `<button class="op-ctx-pill${opPlanContext.type==='process'&&opPlanContext.id===p.id?' active':''}"
      onclick="setOpPlanContext('process',${p.id})">${esc(p.name)}</button>`
  ).join('');

  const bundlePills = opPlanBundles.map(b => {
    const active = opPlanContext.type === 'bundle' && opPlanContext.id === b.id;
    return `<button class="op-ctx-bundle-pill${active?' active':''}" style="--bundle-color:${esc(b.color||'#6366f1')}"
      onclick="setOpPlanContext('bundle',${b.id})"
      title="Edit bundle" ondblclick="openBundleModal(${b.id})">&#128230; ${esc(b.name)}</button>`;
  }).join('');

  bar.innerHTML = `
    <div class="op-plan-ctx-bar">
      <div class="op-ctx-pills">
        ${allPill}
        ${procPills}
        ${opPlanBundles.length > 0 ? '<span class="op-ctx-sep"></span>' : ''}
        ${bundlePills}
        <button class="op-ctx-add-btn" onclick="openBundleModal()" title="Create bundle">&#43; Bundle</button>
      </div>
    </div>`;
}

async function setOpPlanContext(type, id) {
  opPlanContext = { type, id };
  // For single-process context, mirror into task category filter (server-side)
  if (type === 'process') {
    const p = opPlanProcesses.find(p => p.id === id);
    filters.category = p ? p.name : '';
  } else {
    filters.category = '';
  }
  renderOpPlanContextBar();
  // Reload the current view with the new context applied
  if (currentView === 'tasks') loadTasks();
  else if (currentView === 'yearly') loadYearlyPlan();
  else if (currentView === 'actions') loadActions();
  else if (currentView === 'history') loadHistory();
}

// ─── Bundle modal ─────────────────────────────────────────────────────────────

async function openBundleModal(id) {
  await loadOpPlanContextData();
  const modal = document.getElementById('bundle-modal');
  document.getElementById('bundle-id').value = id || '';
  document.getElementById('bundle-modal-title').textContent = id ? 'Edit Bundle' : 'New Process Bundle';

  let selectedColor = '#6366f1';
  let selectedIds = [];

  if (id) {
    const bundle = opPlanBundles.find(b => b.id === id);
    if (bundle) {
      document.getElementById('bundle-name').value = bundle.name;
      selectedColor = bundle.color || '#6366f1';
      try { selectedIds = JSON.parse(bundle.process_ids || '[]'); } catch(e) {}
    }
  } else {
    document.getElementById('bundle-name').value = '';
  }

  // Colour swatches
  const swatchEl = document.getElementById('bundle-color-swatches');
  swatchEl.innerHTML = BUNDLE_COLORS.map(c =>
    `<span class="bundle-color-swatch${c===selectedColor?' selected':''}" style="background:${c}" data-color="${c}" onclick="selectBundleColor('${c}')"></span>`
  ).join('');

  // Process checklist
  const listEl = document.getElementById('bundle-process-checklist');
  if (opPlanProcesses.length === 0) {
    listEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No processes defined in Architecture yet.</div>';
  } else {
    listEl.innerHTML = opPlanProcesses.map(p =>
      `<label class="bundle-proc-item">
        <input type="checkbox" value="${p.id}" ${selectedIds.includes(p.id)?'checked':''}>
        ${esc(p.name)}
      </label>`
    ).join('');
  }

  // Delete button (edit mode only)
  const existing = document.getElementById('bundle-delete-btn');
  if (existing) existing.remove();
  if (id) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'bundle-delete-btn';
    btn.className = 'btn btn-danger';
    btn.textContent = 'Delete Bundle';
    btn.onclick = () => deletePlanBundle(id);
    document.querySelector('#bundle-form .form-actions').prepend(btn);
  }

  modal.classList.remove('hidden');
}

function selectBundleColor(color) {
  document.querySelectorAll('.bundle-color-swatch').forEach(s => s.classList.toggle('selected', s.dataset.color === color));
}

function closeBundleModal() {
  document.getElementById('bundle-modal').classList.add('hidden');
}

async function saveBundleModal(e) {
  e.preventDefault();
  const id = document.getElementById('bundle-id').value;
  const name = document.getElementById('bundle-name').value.trim();
  const color = document.querySelector('.bundle-color-swatch.selected')?.dataset.color || '#6366f1';
  const process_ids = [...document.querySelectorAll('#bundle-process-checklist input:checked')].map(cb => parseInt(cb.value));

  if (!name) return;
  if (id) {
    await api(`/api/plan-bundles/${id}`, { method: 'PUT', body: { name, color, process_ids } });
  } else {
    await api('/api/plan-bundles', { method: 'POST', body: { name, color, process_ids } });
  }
  closeBundleModal();
  await loadOpPlanContextData();
  renderOpPlanContextBar();
}

async function deletePlanBundle(id) {
  if (!confirm('Delete this bundle?')) return;
  await api(`/api/plan-bundles/${id}`, { method: 'DELETE' });
  if (opPlanContext.type === 'bundle' && opPlanContext.id === id) {
    opPlanContext = { type: 'all', id: null };
    filters.category = '';
  }
  closeBundleModal();
  await loadOpPlanContextData();
  renderOpPlanContextBar();
}

// ─── End context bar ──────────────────────────────────────────────────────────

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

// formatAuditAction is used by audit log views

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

  if (settings['org-name']) document.getElementById('setting-org-name').value = settings['org-name'];
  if (settings['language']) document.getElementById('setting-language').value = settings['language'];
  if (settings['date-format']) document.getElementById('setting-date-format').value = settings['date-format'];
  if (settings['fiscal-start']) document.getElementById('setting-fiscal-start').value = settings['fiscal-start'];
}

async function saveSystemSettings() {
  const settings = {
    'org-name': document.getElementById('setting-org-name').value,
    'language': document.getElementById('setting-language').value,
    'date-format': document.getElementById('setting-date-format').value,
    'fiscal-start': document.getElementById('setting-fiscal-start').value,
  };

  await api('/api/admin/settings', { method: 'PUT', body: settings });
  alert('Settings saved successfully!');
}

// --- Admin: Data Management ---
async function loadAdminData() {
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

async function cleanupData(type) {
  const messages = {
    history: 'This will permanently delete completion history older than 1 year.',
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
        document.getElementById('hook-usecase-created').checked = events.includes('usecase_created');
        document.getElementById('hook-usecase-stage').checked = events.includes('usecase_stage_changed');
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
  if (document.getElementById('hook-usecase-created').checked) events.push('usecase_created');
  if (document.getElementById('hook-usecase-stage').checked) events.push('usecase_stage_changed');

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
      rows.push(row('&#9998;', `${esc(a.title)} — ${badge(stBadge, a.status)} ${a.open_ncr_count > 0 ? badge('badge-critical', a.open_ncr_count + ' open NCR' + (a.open_ncr_count !== 1 ? 's' : '')) : ''} ${a.planned_date || ''}`));
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
        <div style="font-size:12px">${o.due_date || '—'}</div>
        <div><span class="badge ${statusClasses[o.status] || 'badge-secondary'}">${o.status.replace('_', ' ')}</span></div>
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

// =====================================================================
// AI AGENT – Chat module
// =====================================================================

let agentHistory = []; // { role: 'user'|'assistant', content }
let agentConfigured = true; // set to false when backend reports 503

async function loadAIAgent() {
  // On first load, probe the endpoint to know if the key is set
  if (agentConfigured) return; // already checked
  try {
    const r = await fetch('/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '__probe__' }) });
    if (r.status === 503) _markAgentUnconfigured();
    else agentConfigured = true;
  } catch { /* network error – assume configured, will surface on send */ }
}

function _markAgentUnconfigured() {
  agentConfigured = false;
  const inputRow = document.getElementById('agent-input-row');
  const unconfigured = document.getElementById('agent-unconfigured');
  if (inputRow) inputRow.style.display = 'none';
  if (unconfigured) unconfigured.style.display = 'flex';
}

function clearAgentChat() {
  agentHistory = [];
  const msgs = document.getElementById('agent-messages');
  if (!msgs) return;
  msgs.innerHTML = `
    <div class="agent-welcome">
      <div class="agent-avatar">&#10024;</div>
      <p>Hello! I'm your BOP AI assistant. What would you like to know?</p>
    </div>`;
}

function agentKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAgentMessage(); }
}

function agentAutoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// Minimal, safe markdown → HTML renderer
function renderAgentMarkdown(raw) {
  // Escape HTML first, then selectively un-escape for markdown
  let t = raw
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Code spans (must come before other transforms)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    // Bold / italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Headings (line-level)
    .replace(/^#{3,} (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm,  '<h3>$1</h3>')
    // Unordered list items
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    // Numbered list items
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Wrap consecutive <li> runs in <ul>
  t = t.replace(/((<li>.*?<\/li>\n?)+)/gs, '<ul>$1</ul>');

  // Paragraphs: split by blank lines, wrap non-block lines
  t = t.split(/\n{2,}/).map(chunk => {
    chunk = chunk.trim();
    if (!chunk) return '';
    if (/^<(h3|ul|ol|li|pre|code|blockquote)/.test(chunk)) return chunk;
    return `<p>${chunk.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  return t;
}

function _appendAgentMsg(role, htmlContent) {
  const msgs = document.getElementById('agent-messages');
  if (!msgs) return;
  msgs.querySelector('.agent-welcome')?.remove();

  const row = document.createElement('div');
  row.className = `agent-msg-row ${role}`;
  row.innerHTML = `<div class="agent-bubble">${htmlContent}</div>`;
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
  return row;
}

function _showTyping() {
  const msgs = document.getElementById('agent-messages');
  if (!msgs) return;
  const row = document.createElement('div');
  row.id = 'agent-typing';
  row.className = 'agent-msg-row assistant agent-typing';
  row.innerHTML = '<div class="agent-bubble"><div class="agent-typing-dots"><span></span><span></span><span></span></div></div>';
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
}
function _hideTyping() { document.getElementById('agent-typing')?.remove(); }

async function sendAgentMessage() {
  const input   = document.getElementById('agent-input');
  const sendBtn = document.getElementById('agent-send-btn');
  const message = input?.value.trim();
  if (!message) return;

  input.value = '';
  input.style.height = 'auto';
  input.disabled = true;
  sendBtn.disabled = true;

  _appendAgentMsg('user', esc(message));
  agentHistory.push({ role: 'user', content: message });
  _showTyping();

  try {
    const data = await api('/api/agent', {
      method: 'POST',
      body: { message, history: agentHistory.slice(-20) },
      timeout: 60000,
    });
    _hideTyping();
    _appendAgentMsg('assistant', renderAgentMarkdown(data.reply));
    agentHistory.push({ role: 'assistant', content: data.reply });
  } catch (err) {
    _hideTyping();
    const msg = err.message || 'Something went wrong. Please try again.';
    // Check if this is the "not configured" error
    if (msg.includes('not configured') || msg.includes('OPENAI_API_KEY')) _markAgentUnconfigured();
    _appendAgentMsg('assistant', `<span style="color:var(--danger)">&#9888; ${esc(msg)}</span>`);
  } finally {
    if (input)   { input.disabled = false; input.focus(); }
    if (sendBtn) sendBtn.disabled = false;
  }
}

// ===========================================================================
// PROCESS FLOWCHART  (editor powered by React Flow via flowchart-editor.mjs)
// ===========================================================================

// Toggle the flowchart expand panel for a process row (same pattern as KPI panel)
function toggleProcessFlowchartPanel(processId) {
  const panel = document.getElementById(`proc-flowchart-panel-${processId}`);
  const arrow = document.getElementById(`proc-flowchart-arrow-${processId}`);
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  arrow.innerHTML = isOpen ? '&#9650;' : '&#9660;';
  if (isOpen) {
    if (!panel.dataset.loaded) {
      panel.dataset.loaded = '1';
      loadProcessFlowchartPanel(processId);
    }
  } else {
    // Unmount React component when panel collapses to free memory
    if (window.FlowchartEditor) window.FlowchartEditor.unmount(`proc-flowchart-canvas-${processId}`);
    panel.dataset.loaded = '';   // allow fresh mount next open
  }
}

async function loadProcessFlowchartPanel(processId) {
  const panel = document.getElementById(`proc-flowchart-panel-${processId}`);
  if (!panel) return;
  panel.innerHTML = '<div class="proc-flowchart-loading">Loading…</div>';

  // flowchart-editor.mjs loads asynchronously; wait briefly if not ready yet
  if (!window.FlowchartEditor) {
    await new Promise(r => setTimeout(r, 600));
    if (!window.FlowchartEditor) {
      panel.innerHTML = '<div class="proc-flowchart-empty">Flowchart editor unavailable – please reload the page.</div>';
      return;
    }
  }

  const items = await api('/api/architecture?arch_type=process');
  const item = items.find(i => i.id === processId);
  const flowchartData = item?.flowchart || null;

  panel.innerHTML = `<div class="proc-flowchart-canvas" id="proc-flowchart-canvas-${processId}"></div>`;

  window.FlowchartEditor.mount(
    `proc-flowchart-canvas-${processId}`,
    flowchartData,
    async (data) => {
      await api(`/api/architecture/${processId}`, {
        method: 'PUT',
        body: { flowchart: JSON.stringify(data) },
      });
    }
  );
}
