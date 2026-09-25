// CSRF: every state-changing same-origin fetch echoes the csrf_token cookie
// back in an X-CSRF-Token header so the server can validate double-submit.
(function installCsrfFetchWrapper() {
  const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  function readCsrf() {
    const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  const origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    init = init || {};
    const method = (init.method ||
      (typeof input === 'object' && input && input.method) ||
      'GET').toUpperCase();
    if (!UNSAFE.has(method)) return origFetch(input, init);
    let url;
    try {
      url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
    } catch { return origFetch(input, init); }
    if (url.origin !== window.location.origin) return origFetch(input, init);
    const token = readCsrf();
    if (!token) return origFetch(input, init);
    const headers = new Headers(init.headers ||
      (typeof input === 'object' && input ? input.headers : undefined));
    if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
    return origFetch(input, { ...init, headers });
  };
})();

// --- State ---
let currentView = 'mission-control';
let allTasks = [];
let meta = { assignees: [], categories: [] };
let filters = { active: 'true', assignee: '', priority: '', search: '' };
let yearlyFilters = { status: '' };
let yearlyYear = new Date().getFullYear();
let lastInstanceContext = null; // { instance_id, task_id, scheduled_date }
let yearlyData = null; // cached yearly API data
let yearlyUpcomingCache = []; // raw overdue+upcoming items for filter re-renders
let currentUser = null;
let isSuperadmin = false;
let activeOrg = null; // { id, name, slug } when superadmin is inside an org

// --- Operational Planning process context ---
const OP_PLAN_VIEWS = ['yearly', 'operational-tasks'];
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
  await loadMSPSupportTickets();
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

      ${renderSupportTicketsPanel()}

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

VIEW_TO_MODULE['mission-control'] = 'org-planning';

// Retain the permission boundary for existing task shortcuts and relationship links.
VIEW_TO_MODULE.tasks = VIEW_TO_MODULE.yearly;
VIEW_TO_MODULE['task-log'] = VIEW_TO_MODULE.actions = VIEW_TO_MODULE['operational-tasks'];

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

async function switchView(view) {
  if (!hasPermissionForView(view)) return;
  workSourceRequest++;
  if (view === 'tasks') { yearlyTab = 'series'; view = 'yearly'; }
  if (view === 'task-log' || view === 'actions') {
    workTab = view === 'actions' ? 'followups' : 'tickets';
    workActionSource = null;
    view = 'operational-tasks';
  }
  closeControlTicket();
  currentView = view;
  if (view !== 'mission-control') suspendSphere();
  updateExperienceChrome();
  closeExperienceDossier('risk', false);
  closeExperienceDossier('document', false);
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
      parentToggle.setAttribute('aria-expanded', 'true');
    }
  }

  // Show or hide the process context bar
  const ctxBar = document.getElementById('op-plan-context-bar');
  if (ctxBar) {
    if (OP_PLAN_VIEWS.includes(view)) {
      ctxBar.classList.remove('hidden');
      const slot = document.getElementById(view === 'yearly' ? 'yearly-context-slot' : 'work-context-slot');
      slot.appendChild(ctxBar);
      await loadOpPlanContextData();
      if (currentView !== view) return;
      renderOpPlanContextBar();
    } else {
      ctxBar.classList.add('hidden');
    }
  }

  if (view === 'tasks') await loadTasks();
  else if (view === 'yearly') await loadYearlyPlan();
  else if (view === 'operational-tasks') await loadOperationalTasks();
  else if (view === 'audit-plan') await loadAuditPlan();
  else if (view === 'audit-execute') await loadAuditExecuteView();
  else if (view === 'audit-ncrs') await loadNcrs();
  else if (view === 'audit-requirements') await loadRequirements();
  else if (view === 'threat-intelligence') await loadThreatIntelligence();
  else if (view === 'risk-identification') await loadRiskIdentification();
  else if (view === 'risk-treatment') await loadRiskTreatmentView();
  else if (view === 'risk-soa') await loadSoA();
  else if (view === 'mission-control') await loadMissionControl();
  else if (view === 'architecture') await loadArchitecture();
  else if (view === 'document-control') await loadDocumentControl();
  else if (view === 'my-tasks') await loadMyTasks();
  else if (view === 'management-reviews') await loadManagementReviews();
  else if (view === 'use-cases') await loadUseCases();
  // Admin views
  else if (view === 'admin-users') await loadAdminUsers();
  else if (view === 'admin-audit-log') await loadAdminAuditLog();
  else if (view === 'admin-settings') await loadAdminSettings();
  else if (view === 'admin-data') await loadAdminData();
  else if (view === 'admin-integrations') await loadAdminIntegrations();
  else if (view === 'ai-agent') await loadAIAgent();
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
  const links = await api(`/api/relations/${entityType}/${entityId}`);
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
  html += `<div id="${collapseId}" class="cross-links-body">`;

  if (links.length === 0) {
    html += '<div class="cross-links-empty">No linked items yet.</div>';
  } else {
    for (const [type, items] of Object.entries(grouped)) {
      html += `<div class="cross-link-group"><span class="cross-link-group-label">${typeIcons[type] || ''} ${typeLabels[type] || type}</span>`;
      for (const item of items) {
        const viewTarget = getViewForType(item.type, item.id);
        html += `<div class="cross-link-item">
          <button type="button" class="cross-link-name relation-link"${viewTarget ? ` onclick="${viewTarget}"` : ' disabled'}>${esc(item.name)}</button>
          ${item.read_only ? '<span class="workflow-relation-label">From workflow</span>' : `<button type="button" class="cross-link-remove" onclick="removeCrossLink(${item.link_id},'${entityType}',${entityId},'${containerId}')" title="Remove link">&times;</button>`}
        </div>`;
      }
      html += '</div>';
    }
  }
  html += '</div></div>';
  container.innerHTML = html;
}

function getViewForType(type, id) {
  return Object.hasOwn(linkableTypes,type) && Number.isSafeInteger(Number(id)) && Number(id)>0
    ? `openRelatedRecord('${type}',${Number(id)})` : null;
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
