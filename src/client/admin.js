
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
