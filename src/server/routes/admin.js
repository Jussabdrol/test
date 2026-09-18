// Register on the shared app to retain middleware and transaction boundaries.
function registerAdminRoutes(app, { UPLOADS_BUCKET, bcrypt, bumpUserSessionVersion, crypto, db, deleteFromSupabase, getSignedUrl, logAuditAction, parseIntParam, requireAdmin, sendValidatedWebhook, storageClient, supabaseAdmin, validateWebhookUrl }) {
  // ===== ADMIN API ENDPOINTS =====

  // Admin: System Overview Stats
  // Admin-only middleware (org_admin or superadmin with active org context)


  // Admin: Users CRUD
  app.get('/api/admin/users', requireAdmin, async (req, res) => {
    const { status, role, search } = req.query;
    let sql = "SELECT id, name, email, role, department, permissions, status, last_active, expiry_date, notes, created_at, updated_at FROM users WHERE organization_id = ? AND role != 'superadmin'";
    const params = [req.orgId];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (role) { sql += ' AND role = ?'; params.push(role); }
    if (search) {
      sql += ' AND (name ILIKE ? OR email ILIKE ? OR department ILIKE ?)';
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern);
    }
    sql += ' ORDER BY name';
    res.json(await db.prepare(sql).all(...params));
  });

  app.get('/api/admin/users/:id', requireAdmin, async (req, res) => {
    const user = await db.prepare('SELECT id, name, email, role, department, permissions, status, last_active, expiry_date, notes, created_at, updated_at FROM users WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'superadmin') return res.status(403).json({ error: 'Platform accounts cannot be modified here' });
    res.json(user);
  });

  app.post('/api/admin/users', requireAdmin, async (req, res) => {
    const { name, email, password, role, department, permissions, status, expiry_date, notes } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
    if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 72) return res.status(400).json({ error: 'Password must be 12–72 bytes long' });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email format' });

    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      const userRole = role || 'org_user';
      if (!['viewer','user','manager','admin','org_admin','org_user'].includes(userRole)) return res.status(400).json({ error: 'Invalid organization role' });
      const normalizedEmail = email.toLowerCase().trim();

      // Create user in Supabase Auth if admin client is available
      let supabaseUid = null;
      if (supabaseAdmin) {
        try {
          const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email: normalizedEmail,
            password,
            email_confirm: true,
            app_metadata: { organization_id: req.orgId, role: userRole },
            user_metadata: { name, department: department || '' },
          });
          if (!authError && authData?.user) {
            supabaseUid = authData.user.id;
          }
        } catch (_) { /* Supabase Auth unavailable – continue with local auth */ }
      }

      const result = await db.prepare(`
        INSERT INTO users (organization_id, name, email, password, role, department, permissions, status, expiry_date, notes, supabase_uid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.orgId, name, normalizedEmail, hashedPassword, userRole, department || '',
             JSON.stringify(permissions || ['org','risk','ops','audit']),
             status || 'active', expiry_date || null, notes || '', supabaseUid);

      const admin = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.session.userId);
      await logAuditAction(req.session.userId, admin?.name || 'Admin', 'user_created', 'user', result.lastInsertRowid, name, '', req.orgId);

      const newUser = await db.prepare('SELECT id, name, email, role, department, permissions, status, last_active, expiry_date, notes, created_at, updated_at FROM users WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json(newUser);
    } catch (e) {
      if (e.message.includes('unique') || e.message.includes('UNIQUE') || e.message.includes('duplicate')) {
        return res.status(409).json({ error: 'A user with this email already exists' });
      }
      console.error('Create user error:', e);
      res.status(500).json({ error: 'Failed to create user' });
    }
  });

  app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
    if (req.body.role !== undefined && !['viewer','user','manager','admin','org_admin','org_user'].includes(req.body.role)) return res.status(400).json({ error: 'Invalid organization role' });
    const user = await db.prepare('SELECT * FROM users WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'superadmin') return res.status(403).json({ error: 'Platform accounts cannot be modified here' });

    // Prevent self-demotion from admin
    if (parseInt(req.params.id) === req.session.userId) {
      if (req.body.role && req.body.role !== user.role) {
        return res.status(400).json({ error: 'You cannot change your own admin role. Ask another admin.' });
      }
      if (req.body.status && req.body.status !== 'active') {
        return res.status(400).json({ error: 'You cannot deactivate your own account.' });
      }
    }

    if (req.body.email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(req.body.email)) return res.status(400).json({ error: 'Invalid email format' });
      req.body.email = req.body.email.toLowerCase().trim();
    }

    if (user.role === 'superadmin') return res.status(403).json({ error: 'Platform accounts cannot be modified here' });

    const fields = ['name', 'email', 'role', 'department', 'permissions', 'status', 'expiry_date', 'notes'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        params.push(f === 'permissions' ? JSON.stringify(req.body[f]) : req.body[f]);
      }
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);

    try {
      await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);

      // Revoke outstanding sessions when an admin suspends/deactivates a user or
      // strips superadmin/org_admin privileges.
      const statusNowRestricted = req.body.status && req.body.status !== 'active';
      const roleDowngraded = req.body.role && req.body.role !== user.role &&
        (user.role === 'superadmin' || user.role === 'org_admin') && req.body.role === 'org_user';
      if (statusNowRestricted || roleDowngraded || ['role','permissions','email','expiry_date'].some(key => req.body[key] !== undefined)) {
        await bumpUserSessionVersion(user.id);
      }

      const admin = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.session.userId);
      await logAuditAction(req.session.userId, admin?.name || 'Admin', 'user_updated', 'user', user.id, user.name,
        JSON.stringify(Object.keys(req.body).filter(k => k !== 'password')), req.orgId);
      const updated = await db.prepare('SELECT id, name, email, role, department, permissions, status, last_active, expiry_date, notes, created_at, updated_at FROM users WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
      res.json(updated);
    } catch (e) {
      if (e.message.includes('unique') || e.message.includes('UNIQUE') || e.message.includes('duplicate')) {
        return res.status(409).json({ error: 'A user with this email already exists' });
      }
      console.error('Update user error:', e);
      res.status(500).json({ error: 'Failed to update user' });
    }
  });

  // Admin: Reset user password
  app.put('/api/admin/users/:id/password', requireAdmin, async (req, res) => {
    const { password } = req.body;
    if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 72) return res.status(400).json({ error: 'Password must be 12–72 bytes long' });

    const user = await db.prepare('SELECT * FROM users WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'superadmin') return res.status(403).json({ error: 'Platform accounts cannot be modified here' });

    const hashedPassword = await bcrypt.hash(password, 10);
    await db.prepare("UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?").run(hashedPassword, req.params.id, req.orgId);

    // Sync password to Supabase Auth if available
    if (supabaseAdmin && user.supabase_uid) {
      try {
        await supabaseAdmin.auth.admin.updateUserById(user.supabase_uid, { password });
      } catch (_) { /* Non-critical */ }
    }

    // Password reset invalidates any outstanding sessions for this user
    await bumpUserSessionVersion(user.id);

    const admin = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.session.userId);
    await logAuditAction(req.session.userId, admin?.name || 'Admin', 'user_password_reset', 'user', user.id, user.name, '', req.orgId);
    res.json({ success: true });
  });

  app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    if (parseInt(req.params.id) === req.session.userId) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }

    const user = await db.prepare('SELECT * FROM users WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'superadmin') return res.status(403).json({ error: 'Platform accounts cannot be modified here' });

    // Remove from Supabase Auth if available
    if (supabaseAdmin && user.supabase_uid) {
      try {
        await supabaseAdmin.auth.admin.deleteUser(user.supabase_uid);
      } catch (_) { /* Non-critical */ }
    }

    await db.prepare('DELETE FROM users WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
    const admin = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.session.userId);
    await logAuditAction(req.session.userId, admin?.name || 'Admin', 'user_deleted', 'user', user.id, user.name, '', req.orgId);
    res.json({ success: true });
  });

  // Admin: Audit Log
  app.get('/api/admin/audit-log', requireAdmin, async (req, res) => {
    const { action, entity_type, user_name, limit = 100, offset = 0 } = req.query;
    let sql = 'SELECT * FROM admin_audit_log WHERE organization_id = ?';
    const params = [req.orgId];
    if (action) { sql += ' AND action LIKE ?'; params.push(`%${action}%`); }
    if (entity_type) { sql += ' AND entity_type = ?'; params.push(entity_type); }
    if (user_name) { sql += ' AND user_name LIKE ?'; params.push(`%${user_name}%`); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    const safeLimit = parseIntParam(limit, 100, { min: 1, max: 500 });
    const safeOffset = parseIntParam(offset, 0, { min: 0, max: 100_000 });
    params.push(safeLimit, safeOffset);

    const logs = await db.prepare(sql).all(...params);
    const total = (await db.prepare('SELECT COUNT(*) as c FROM admin_audit_log WHERE organization_id = ?').get(req.orgId)).c;
    res.json({ logs, total, limit: safeLimit, offset: safeOffset });
  });

  // Helper function to log audit actions


  // Admin: System Settings
  app.get('/api/admin/settings', requireAdmin, async (req, res) => {
    const settings = await db.prepare('SELECT * FROM system_settings WHERE organization_id = ?').all(req.orgId);
    const result = {};
    for (const s of settings) {
      try { result[s.key] = JSON.parse(s.value); }
      catch { result[s.key] = s.value; }
    }
    res.json(result);
  });

  app.put('/api/admin/settings', requireAdmin, async (req, res) => {
    const settings = req.body;
    const upsert = db.prepare(`
      INSERT INTO system_settings (key, value, organization_id, updated_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `);

    for (const [key, value] of Object.entries(settings)) {
      await upsert.run(key, typeof value === 'object' ? JSON.stringify(value) : String(value), req.orgId);
    }

    await logAuditAction(null, 'System', 'settings_updated', 'settings', null, null, JSON.stringify(Object.keys(settings)), req.orgId);
    res.json({ success: true });
  });

  // Admin: API Keys
  app.get('/api/admin/api-keys', requireAdmin, async (req, res) => {
    res.json(await db.prepare("SELECT id, name, key_prefix, permissions, last_used, expires_at, status, created_at FROM api_keys WHERE organization_id = ? ORDER BY created_at DESC").all(req.orgId));
  });

  app.post('/api/admin/api-keys', requireAdmin, async (req, res) => {
    const { name, permissions, expires_at } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    // Generate a random API key
    const key = 'ltfw_' + crypto.randomBytes(24).toString('hex');
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    const keyPrefix = key.substring(0, 12) + '...';

    const result = await db.prepare(`
      INSERT INTO api_keys (organization_id, name, key_hash, key_prefix, permissions, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.orgId, name, keyHash, keyPrefix, JSON.stringify(permissions || ['read']), expires_at || null);

    await logAuditAction(null, 'System', 'api_key_created', 'api_key', result.lastInsertRowid, name, '', req.orgId);

    // Return the full key only once (won't be stored/retrievable later)
    res.status(201).json({
      id: result.lastInsertRowid,
      name,
      key, // Full key shown only once!
      key_prefix: keyPrefix,
      permissions: permissions || ['read'],
      created_at: new Date().toISOString()
    });
  });

  app.delete('/api/admin/api-keys/:id', requireAdmin, async (req, res) => {
    const key = await db.prepare('SELECT * FROM api_keys WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!key) return res.status(404).json({ error: 'API key not found' });

    await db.prepare("UPDATE api_keys SET status = 'revoked' WHERE id = ? AND organization_id = ?").run(req.params.id, req.orgId);
    await logAuditAction(null, 'System', 'api_key_revoked', 'api_key', key.id, key.name, '', req.orgId);
    res.json({ success: true });
  });

  // Admin: Webhooks
  app.get('/api/admin/webhooks', requireAdmin, async (req, res) => {
    res.json(await db.prepare('SELECT * FROM webhooks WHERE organization_id = ? ORDER BY created_at DESC').all(req.orgId));
  });

  app.post('/api/admin/webhooks', requireAdmin, async (req, res) => {
    const { name, url, events, secret, status } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'Name and URL required' });

    try { await validateWebhookUrl(url); }
    catch (err) { return res.status(400).json({ error: err.message }); }

    const result = await db.prepare(`
      INSERT INTO webhooks (organization_id, name, url, events, secret, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.orgId, name, url, JSON.stringify(events || []), secret || '', status || 'active');

    await logAuditAction(null, 'System', 'webhook_created', 'webhook', result.lastInsertRowid, name, '', req.orgId);
    res.status(201).json(await db.prepare('SELECT * FROM webhooks WHERE id = ?').get(result.lastInsertRowid));
  });

  app.put('/api/admin/webhooks/:id', requireAdmin, async (req, res) => {
    const webhook = await db.prepare('SELECT * FROM webhooks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

    const { name, url, events, secret, status } = req.body;
    if (url && url !== webhook.url) {
      try { await validateWebhookUrl(url); }
      catch (err) { return res.status(400).json({ error: err.message }); }
    }
    await db.prepare(`
      UPDATE webhooks SET name = ?, url = ?, events = ?, secret = ?, status = ? WHERE id = ? AND organization_id = ?
    `).run(name || webhook.name, url || webhook.url, JSON.stringify(events || JSON.parse(webhook.events)),
           secret !== undefined ? secret : webhook.secret, status || webhook.status, req.params.id, req.orgId);

    await logAuditAction(null, 'System', 'webhook_updated', 'webhook', webhook.id, webhook.name, '', req.orgId);
    res.json(await db.prepare('SELECT * FROM webhooks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
  });

  app.delete('/api/admin/webhooks/:id', requireAdmin, async (req, res) => {
    const webhook = await db.prepare('SELECT * FROM webhooks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

    await db.prepare('DELETE FROM webhooks WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
    await logAuditAction(null, 'System', 'webhook_deleted', 'webhook', webhook.id, webhook.name, '', req.orgId);
    res.json({ success: true });
  });

  // Admin: Data Export
  app.get('/api/admin/export', requireAdmin, async (req, res) => {
    const { format = 'json', include } = req.query;
    const includes = include ? include.split(',') : ['tasks', 'risks', 'audits', 'architecture', 'requirements', 'documents'];

    const data = {
      exportedAt: new Date().toISOString(),
      version: '1.0',
    };

    if (includes.includes('tasks')) {
      data.tasks = await db.prepare('SELECT * FROM tasks WHERE organization_id = ?').all(req.orgId);
      data.taskInstances = await db.prepare('SELECT * FROM task_instances WHERE organization_id = ?').all(req.orgId);
      data.actions = await db.prepare('SELECT * FROM actions WHERE organization_id = ?').all(req.orgId);
    }
    if (includes.includes('risks')) {
      data.risks = await db.prepare('SELECT * FROM risks WHERE organization_id = ?').all(req.orgId);
      data.treatments = await db.prepare('SELECT * FROM risk_treatments WHERE organization_id = ?').all(req.orgId);
    }
    if (includes.includes('audits')) {
      data.audits = await db.prepare('SELECT * FROM audits WHERE organization_id = ?').all(req.orgId);
      data.auditChecklist = await db.prepare('SELECT * FROM audit_checklist WHERE organization_id = ?').all(req.orgId);
      data.ncrs = await db.prepare('SELECT * FROM non_conformities WHERE organization_id = ?').all(req.orgId);
    }
    if (includes.includes('architecture')) {
      data.architecture = await db.prepare('SELECT * FROM org_architecture WHERE organization_id = ?').all(req.orgId);
      data.kpis = await db.prepare('SELECT * FROM org_kpis WHERE organization_id = ?').all(req.orgId);
    }
    if (includes.includes('requirements')) {
      data.requirements = await db.prepare('SELECT * FROM standard_requirements WHERE organization_id = ?').all(req.orgId);
      data.soaEntries = await db.prepare('SELECT * FROM soa_entries WHERE organization_id = ?').all(req.orgId);
    }
    if (includes.includes('documents')) {
      data.documents = await db.prepare('SELECT id, title, description, doc_type, version, owner, status, classification, linked_module, review_date, created_at FROM documents WHERE organization_id = ?').all(req.orgId);
    }

    // Cross-links
    data.crossLinks = await db.prepare('SELECT * FROM cross_links WHERE organization_id = ?').all(req.orgId);

    await logAuditAction(null, 'System', 'data_exported', 'system', null, null, `Format: ${format}, Includes: ${includes.join(',')}`, req.orgId);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="ltfw-export-${new Date().toISOString().split('T')[0]}.json"`);
    res.json(data);
  });

  // Admin: Create Backup
  app.post('/api/admin/backups', requireAdmin, async (req, res) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${timestamp}.json`;

    // Get all data
    const data = {
      exportedAt: new Date().toISOString(),
      version: '1.0',
      tasks: await db.prepare('SELECT * FROM tasks WHERE organization_id = ?').all(req.orgId),
      taskInstances: await db.prepare('SELECT * FROM task_instances WHERE organization_id = ?').all(req.orgId),
      actions: await db.prepare('SELECT * FROM actions WHERE organization_id = ?').all(req.orgId),
      risks: await db.prepare('SELECT * FROM risks WHERE organization_id = ?').all(req.orgId),
      treatments: await db.prepare('SELECT * FROM risk_treatments WHERE organization_id = ?').all(req.orgId),
      audits: await db.prepare('SELECT * FROM audits WHERE organization_id = ?').all(req.orgId),
      auditChecklist: await db.prepare('SELECT * FROM audit_checklist WHERE organization_id = ?').all(req.orgId),
      ncrs: await db.prepare('SELECT * FROM non_conformities WHERE organization_id = ?').all(req.orgId),
      architecture: await db.prepare('SELECT * FROM org_architecture WHERE organization_id = ?').all(req.orgId),
      requirements: await db.prepare('SELECT * FROM standard_requirements WHERE organization_id = ?').all(req.orgId),
      soaEntries: await db.prepare('SELECT * FROM soa_entries WHERE organization_id = ?').all(req.orgId),
      documents: await db.prepare('SELECT * FROM documents WHERE organization_id = ?').all(req.orgId),
      kpis: await db.prepare('SELECT * FROM org_kpis WHERE organization_id = ?').all(req.orgId),
      kpiValues: await db.prepare('SELECT * FROM org_kpi_values WHERE organization_id = ?').all(req.orgId),
      crossLinks: await db.prepare('SELECT * FROM cross_links WHERE organization_id = ?').all(req.orgId),
      threatFeeds: await db.prepare('SELECT * FROM threat_feeds WHERE organization_id = ?').all(req.orgId),
      users: await db.prepare('SELECT id, name, email, role, department, permissions, status FROM users WHERE organization_id = ?').all(req.orgId),
      settings: await db.prepare('SELECT * FROM system_settings WHERE organization_id = ?').all(req.orgId),
    };

    const content = JSON.stringify(data, null, 2);
    const size = Buffer.byteLength(content, 'utf8');

    // Upload backup to Supabase Storage
    if (!storageClient) return res.status(500).json({ error: 'Supabase is not configured (missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY)' });
    const { error: uploadError } = await storageClient.storage
      .from(UPLOADS_BUCKET)
      .upload(`backups/${filename}`, Buffer.from(content, 'utf8'), { contentType: 'application/json', upsert: false });
    if (uploadError) return res.status(500).json({ error: `Backup storage failed: ${uploadError.message}` });

    // Save backup record
    const result = await db.prepare(`
      INSERT INTO backups (organization_id, filename, size, type, status) VALUES (?, ?, ?, ?, 'completed')
    `).run(req.orgId, filename, size, req.body.type || 'manual');

    await logAuditAction(null, 'System', 'backup_created', 'backup', result.lastInsertRowid, filename, '', req.orgId);
    res.status(201).json(await db.prepare('SELECT * FROM backups WHERE id = ?').get(result.lastInsertRowid));
  });

  app.get('/api/admin/backups', requireAdmin, async (req, res) => {
    res.json(await db.prepare("SELECT * FROM backups WHERE organization_id = ? ORDER BY created_at DESC").all(req.orgId));
  });

  app.get('/api/admin/backups/:id/download', requireAdmin, async (req, res) => {
    const backup = await db.prepare('SELECT * FROM backups WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!backup) return res.status(404).json({ error: 'Backup not found' });

    try {
      const signedUrl = await getSignedUrl(`backups/${backup.filename}`, 300, backup.filename || true);
      res.redirect(signedUrl);
    } catch (err) {
      res.status(404).json({ error: 'Backup file not found in storage' });
    }
  });

  app.delete('/api/admin/backups/:id', requireAdmin, async (req, res) => {
    const backup = await db.prepare('SELECT * FROM backups WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!backup) return res.status(404).json({ error: 'Backup not found' });

    await deleteFromSupabase(`backups/${backup.filename}`);
    await db.prepare('DELETE FROM backups WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
    await logAuditAction(null, 'System', 'backup_deleted', 'backup', backup.id, backup.filename, '', req.orgId);
    res.json({ success: true });
  });

  // Admin: Data Cleanup
  app.post('/api/admin/cleanup', requireAdmin, async (req, res) => {
    const { type } = req.body;
    let result = { affected: 0 };

    if (type === 'history') {
      // Delete completed/skipped task instances older than 1 year (scoped to current org)
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      const r = await db.prepare(
        "DELETE FROM task_instances WHERE status IN ('completed','skipped') AND scheduled_date < ? AND organization_id = ?"
      ).run(oneYearAgo.toISOString().split('T')[0], req.orgId);
      result.affected = r.changes;
    } else if (type === 'logs') {
      // Delete audit logs older than 90 days (scoped to current org)
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const r = await db.prepare("DELETE FROM admin_audit_log WHERE created_at < ? AND organization_id = ?").run(ninetyDaysAgo.toISOString(), req.orgId);
      result.affected = r.changes;
    }

    await logAuditAction(null, 'System', 'data_cleanup', 'system', null, null, `Type: ${type}, Affected: ${result.affected}`, req.orgId);
    res.json(result);
  });

  // Admin: Data Import
  app.post('/api/admin/import', requireAdmin, async (req, res) => {
    const data = req.body;
    const result = { imported: {}, errors: [] };

    try {
      // Import tasks
      if (data.tasks && Array.isArray(data.tasks)) {
        let count = 0;
        const insertTask = db.prepare(`
          INSERT OR IGNORE INTO tasks (organization_id, title, description, assignee, category, priority, recurrence, next_due, is_active, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `);
        for (const task of data.tasks) {
          try {
            await insertTask.run(req.orgId, task.title, task.description || '', task.assignee || '', task.category || '',
              task.priority || 'medium', task.recurrence || 'monthly', task.next_due || null, task.is_active !== false ? 1 : 0);
            count++;
          } catch (e) { /* Skip duplicates */ }
        }
        result.imported.tasks = count;
      }

      // Import risks
      if (data.risks && Array.isArray(data.risks)) {
        let count = 0;
        const insertRisk = db.prepare(`
          INSERT OR IGNORE INTO risks (organization_id, title, description, category, status, risk_owner, threat, vulnerability, asset, likelihood, impact, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `);
        for (const risk of data.risks) {
          try {
            await insertRisk.run(req.orgId, risk.title, risk.description || '', risk.category || '', risk.status || 'identified',
              risk.risk_owner || risk.owner || '', risk.threat || '', risk.vulnerability || '', risk.asset || risk.asset_system || '',
              risk.likelihood || 3, risk.impact || 3);
            count++;
          } catch (e) { /* Skip duplicates */ }
        }
        result.imported.risks = count;
      }

      // Import architecture items
      if (data.architecture && Array.isArray(data.architecture)) {
        let count = 0;
        const insertArch = db.prepare(`
          INSERT OR IGNORE INTO org_architecture (organization_id, arch_type, name, description, owner, parent_id, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `);
        for (const item of data.architecture) {
          try {
            await insertArch.run(req.orgId, item.arch_type || 'role', item.name, item.description || '', item.owner || '',
              item.parent_id || null, item.status || 'active');
            count++;
          } catch (e) { /* Skip duplicates */ }
        }
        result.imported.architecture = count;
      }

      // Import requirements
      if (data.requirements && Array.isArray(data.requirements)) {
        let count = 0;
        const insertReq = db.prepare(`
          INSERT OR IGNORE INTO standard_requirements (organization_id, standard, clause, title, description, category, created_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `);
        for (const item of data.requirements) {
          try {
            await insertReq.run(req.orgId, item.standard || '', item.clause || '', item.title, item.description || '',
              item.category || '');
            count++;
          } catch (e) { /* Skip duplicates */ }
        }
        result.imported.requirements = count;
      }

      // Import documents
      if (data.documents && Array.isArray(data.documents)) {
        let count = 0;
        const insertDoc = db.prepare(`
          INSERT OR IGNORE INTO documents (organization_id, title, description, doc_type, version, owner, status, classification, linked_module, review_date, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `);
        for (const doc of data.documents) {
          try {
            await insertDoc.run(req.orgId, doc.title, doc.description || '', doc.doc_type || 'policy', doc.version || '1.0',
              doc.owner || '', doc.status || 'draft', doc.classification || 'internal',
              doc.linked_module || '', doc.review_date || null);
            count++;
          } catch (e) { /* Skip duplicates */ }
        }
        result.imported.documents = count;
      }

      // Import audits
      if (data.audits && Array.isArray(data.audits)) {
        let count = 0;
        const insertAudit = db.prepare(`
          INSERT OR IGNORE INTO audits (organization_id, title, standard, lead_auditor, scope, status, planned_date, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `);
        for (const audit of data.audits) {
          try {
            await insertAudit.run(req.orgId, audit.title, audit.standard || '', audit.lead_auditor || '',
              audit.scope || '', audit.status || 'planned', audit.planned_date || audit.scheduled_date || null);
            count++;
          } catch (e) { /* Skip duplicates */ }
        }
        result.imported.audits = count;
      }

      await logAuditAction(null, 'System', 'data_imported', 'system', null, null, JSON.stringify(result.imported), req.orgId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Admin: Test Webhook
  app.post('/api/admin/webhooks/:id/test', requireAdmin, async (req, res) => {
    const webhook = await db.prepare('SELECT * FROM webhooks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

    const testPayload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      organization_id: req.orgId,
      data: {
        message: 'This is a test webhook from Let The Frame Work',
        webhook_id: webhook.id,
        webhook_name: webhook.name,
        configured_events: (() => { try { return JSON.parse(webhook.events || '[]'); } catch { return []; } })(),
      },
    };

    try {
      const payload = JSON.stringify(testPayload);
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'LetTheFrameWork/1.0',
      };
      if (webhook.secret) {
        headers['X-Webhook-Signature'] = 'sha256=' + crypto.createHmac('sha256', webhook.secret).update(payload).digest('hex');
      }

      const validated = await validateWebhookUrl(webhook.url);
      const result = await sendValidatedWebhook(validated, payload, headers);

      // Update last triggered
      await db.prepare("UPDATE webhooks SET last_triggered = datetime('now') WHERE id = ? AND organization_id = ?").run(webhook.id, req.orgId);

      res.json({ success: true, statusCode: result.statusCode, response: result.body });
    } catch (err) {
      // Increment failure count
      await db.prepare("UPDATE webhooks SET failure_count = failure_count + 1 WHERE id = ? AND organization_id = ?").run(webhook.id, req.orgId);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Admin: Reset Webhook Failures
  app.post('/api/admin/webhooks/:id/reset-failures', requireAdmin, async (req, res) => {
    const webhook = await db.prepare('SELECT * FROM webhooks WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

    await db.prepare("UPDATE webhooks SET failure_count = 0 WHERE id = ? AND organization_id = ?").run(req.params.id, req.orgId);
    res.json({ success: true });
  });
}

module.exports = { registerAdminRoutes };
