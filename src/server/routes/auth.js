// Register on the shared app to retain middleware and transaction boundaries.
function registerAuthRoutes(app, { authRateLimiter, bcrypt, bumpUserSessionVersion, db, getOrgId, requireSuperadmin, supabase, supabaseAdmin }) {
  // --- Authentication Routes ---

  // Check if user is authenticated
  app.get('/api/auth/check', async (req, res) => {
    if (req.session.userId) {
      const user = await db.prepare('SELECT id, name, email, role, permissions, organization_id FROM users WHERE id = ?').get(req.session.userId);
      if (user) {
        const orgId = getOrgId(req);
        let activeOrg = null;
        if (orgId) {
          activeOrg = await db.prepare('SELECT id, name, slug FROM organizations WHERE id = ?').get(orgId);
        }
        return res.json({
          authenticated: true,
          user,
          activeOrg,
          isSuperadmin: user.role === 'superadmin',
        });
      }
    }
    res.json({ authenticated: false });
  });

  // Login – authenticates via Supabase Auth first (if available), falls back to local bcrypt
  app.post('/api/auth/login', authRateLimiter, async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      // --- Try Supabase Auth first ---
      let supabaseUser = null;
      if (supabase) {
        try {
          const { data, error } = await supabase.auth.signInWithPassword({ email, password });
          if (!error && data?.user) {
            supabaseUser = data.user;
          }
        } catch (_) { /* Supabase Auth unavailable – fall through to local auth */ }
      }

      // --- Look up the user in our database ---
      const user = await db.prepare('SELECT * FROM users WHERE email = ? AND status = ?').get(email.toLowerCase().trim(), 'active');
      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      // --- If Supabase Auth didn't authenticate, try local bcrypt ---
      if (!supabaseUser) {
        if (!user.password) {
          return res.status(401).json({ error: 'Account not set up. Please contact administrator.' });
        }
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
          return res.status(401).json({ error: 'Invalid email or password' });
        }
      }

      // --- Check org is active (for non-superadmins) ---
      if (user.role !== 'superadmin' && user.organization_id) {
        const org = await db.prepare('SELECT is_active FROM organizations WHERE id = ?').get(user.organization_id);
        if (!org || !org.is_active) {
          return res.status(403).json({ error: 'Your organization has been deactivated. Contact your MSP administrator.' });
        }
      }

      // Update last active
      await db.prepare("UPDATE users SET last_active = datetime('now') WHERE id = ?").run(user.id);

      // Sync Supabase Auth metadata (org_id, role) if admin client available
      if (supabaseAdmin && (supabaseUser || user.supabase_uid)) {
        const uid = supabaseUser?.id || user.supabase_uid;
        try {
          await supabaseAdmin.auth.admin.updateUserById(uid, {
            app_metadata: { organization_id: user.organization_id, role: user.role },
            user_metadata: { name: user.name, department: user.department || '' },
          });
          // Store supabase_uid if not already stored
          if (!user.supabase_uid && supabaseUser?.id) {
            await db.prepare('UPDATE users SET supabase_uid = ? WHERE id = ?').run(supabaseUser.id, user.id);
          }
        } catch (_) { /* Non-critical – continue login */ }
      }

      req.session.userId = user.id;
      req.session.userRole = user.role;
      req.session.organizationId = user.organization_id || null;
      // For non-superadmin users, activeOrgId is always their own org
      req.session.activeOrgId = user.role === 'superadmin' ? null : (user.organization_id || null);
      req.session.sv = user.session_version ?? 0;

      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('Session save error:', saveErr);
          return res.status(500).json({ error: 'Session could not be saved' });
        }
        res.json({
          success: true,
          user: {
            id: user.id, name: user.name, email: user.email, role: user.role,
            permissions: user.permissions, organization_id: user.organization_id,
          },
          isSuperadmin: user.role === 'superadmin',
        });
      });
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // Logout — clears only the current cookie
  app.post('/api/auth/logout', async (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: 'Logout failed' });
      }
      res.json({ success: true });
    });
  });

  // Logout everywhere — bump session_version to invalidate all outstanding tokens
  app.post('/api/auth/logout-all', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
    try {
      await bumpUserSessionVersion(req.session.userId);
    } catch (err) {
      console.error('[logout-all] bump failed:', err.message);
      return res.status(500).json({ error: 'Logout failed' });
    }
    req.session.destroy(() => res.json({ success: true }));
  });

  // ===========================================================================
  // MSP PORTAL API (superadmin-only)
  // ===========================================================================

  // List all organizations with user counts
  app.get('/api/msp/organizations', requireSuperadmin, async (req, res) => {
    const orgs = await db.prepare(`
      SELECT o.*, COUNT(u.id) as user_count
      FROM organizations o
      LEFT JOIN users u ON u.organization_id = o.id AND u.role != 'superadmin'
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `).all();
    res.json(orgs);
  });

  // Get single organization
  app.get('/api/msp/organizations/:id', requireSuperadmin, async (req, res) => {
    const org = await db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    const users = await db.prepare("SELECT id, name, email, role, status FROM users WHERE organization_id = ? AND role != 'superadmin'").all(org.id);
    org.users = users;
    res.json(org);
  });

  // Create organization
  app.post('/api/msp/organizations', requireSuperadmin, async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Organization name is required' });

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const existing = await db.prepare('SELECT id FROM organizations WHERE slug = ?').get(slug);
    if (existing) return res.status(409).json({ error: 'An organization with this name already exists' });

    const result = await db.prepare('INSERT INTO organizations (name, slug, is_active) VALUES (?, ?, 1)').run(name, slug);
    const orgId = result.lastInsertRowid;

    // Seed essential data for the new organization
    await db.prepare("INSERT INTO org_mission (organization_id, content) VALUES (?, '')").run(orgId);
    for (const f of require('../database/schema').DEFAULT_THREAT_FEEDS) {
      await db.prepare('INSERT INTO threat_feeds (organization_id, name, url, tier) VALUES (?, ?, ?, ?)').run(orgId, f.name, f.url, f.tier);
    }

    res.status(201).json(await db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId));
  });

  // Activate / deactivate organization
  app.put('/api/msp/organizations/:id', requireSuperadmin, async (req, res) => {
    const org = await db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const { name, is_active } = req.body;
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    await db.prepare(`UPDATE organizations SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json(await db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id));
  });

  // Superadmin: enter an organization's environment
  app.post('/api/msp/switch-org', requireSuperadmin, async (req, res) => {
    const { organization_id } = req.body;
    if (!organization_id) {
      // Clear org context – return to MSP dashboard
      req.session.activeOrgId = null;
      req.session.save((err) => {
        if (err) return res.status(500).json({ error: 'Failed to update session' });
        res.json({ success: true, activeOrg: null });
      });
      return;
    }
    const org = await db.prepare('SELECT * FROM organizations WHERE id = ?').get(organization_id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    req.session.activeOrgId = org.id;
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Failed to update session' });
      res.json({ success: true, activeOrg: { id: org.id, name: org.name, slug: org.slug } });
    });
  });

  // MSP Dashboard stats
  app.get('/api/msp/dashboard', requireSuperadmin, async (req, res) => {
    const totalOrgs = (await db.prepare('SELECT COUNT(*) as c FROM organizations').get()).c;
    const activeOrgs = (await db.prepare('SELECT COUNT(*) as c FROM organizations WHERE is_active = 1').get()).c;
    const totalUsers = (await db.prepare("SELECT COUNT(*) as c FROM users WHERE role != 'superadmin'").get()).c;
    res.json({ totalOrgs, activeOrgs, totalUsers });
  });

  // ===========================================================================
  // ORG-SCOPED API ROUTES
  // All routes below require an active org context via requireOrgContext
  // ===========================================================================
}

module.exports = { registerAuthRoutes };
