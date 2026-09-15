// Register on the shared app to retain middleware and transaction boundaries.
function registerSamlRoutes(app, { crypto, db, deflateRaw, express, logAuditAction, requireAdmin }) {
  // ===== SAML/SSO ENDPOINTS =====

  // ---------------------------------------------------------------------------
  // SAML signature verification
  // Verifies the ds:Signature inside a decoded SAMLResponse XML using the
  // configured IdP certificate (PEM). Supports RSA-SHA256 and RSA-SHA1.
  //
  // Note: canonicalization (C14N) is not implemented here. This works for
  // well-formed responses from major IdPs (Entra ID, Okta, Google Workspace)
  // that produce canonical SignedInfo bytes before signing. For strict
  // production compliance, consider 'saml2-js' or 'passport-saml'.
  // ---------------------------------------------------------------------------
  function verifySamlSignature(decodedXml, certPem) {
    // Extract <ds:SignatureValue>
    const sigValueMatch = decodedXml.match(
      /<(?:[^:>\s]+:)?SignatureValue[^>]*>\s*([\s\S]+?)\s*<\/(?:[^:>\s]+:)?SignatureValue>/
    );
    if (!sigValueMatch) return { valid: false, reason: 'No SignatureValue found' };
    const sigBytes = Buffer.from(sigValueMatch[1].replace(/\s+/g, ''), 'base64');

    // Extract <ds:SignedInfo>
    const signedInfoMatch = decodedXml.match(
      /(<(?:[^:>\s]+:)?SignedInfo[\s\S]+?<\/(?:[^:>\s]+:)?SignedInfo>)/
    );
    if (!signedInfoMatch) return { valid: false, reason: 'No SignedInfo element found' };
    const signedInfo = signedInfoMatch[1];

    // Normalise PEM format
    let pem = certPem.trim();
    if (!pem.startsWith('-----BEGIN')) {
      pem = `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----`;
    }

    // Determine hash algorithm from the <ds:SignatureMethod> URI
    const algoMatch = signedInfo.match(/Algorithm="([^"]+)"/);
    const algoUri = algoMatch?.[1] || '';
    const hashAlgo = algoUri.includes('sha512') ? 'SHA512'
      : algoUri.includes('sha1') || algoUri.includes('SHA1') ? 'SHA1'
      : 'SHA256'; // default to SHA256

    // Attempt verification; try both raw bytes and CRLF-normalised form
    for (const candidate of [signedInfo, signedInfo.replace(/\r\n|\r/g, '\n')]) {
      try {
        const verify = crypto.createVerify(`RSA-${hashAlgo}`);
        verify.update(candidate, 'utf8');
        if (verify.verify(pem, sigBytes)) return { valid: true };
      } catch (_) { /* try next */ }
    }

    return { valid: false, reason: `RSA-${hashAlgo} signature did not match configured certificate` };
  }

  // SAML config is initialized in db.js seedSQLiteData()/seedPostgresData()

  // Get SAML configuration (org-scoped: admins only see their own org's config)
  app.get('/api/admin/saml/config', requireAdmin, async (req, res) => {
    const config = await db.prepare(
      'SELECT * FROM saml_config WHERE organization_id = $1'
    ).get(req.orgId)
      ?? await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();

    if (config) {
      config.has_certificate = !!(config.certificate);
      config.certificate = config.certificate ? '[CONFIGURED]' : '';
    }
    res.json(config || {});
  });

  // Update SAML configuration (org-scoped UPSERT)
  app.put('/api/admin/saml/config', requireAdmin, async (req, res) => {
    const {
      enabled, entity_id, sso_url, slo_url, certificate,
      name_id_format, attribute_mapping, auto_provision,
      default_role, allowed_domains
    } = req.body;

    const current = await db.prepare(
      'SELECT * FROM saml_config WHERE organization_id = $1'
    ).get(req.orgId)
      ?? await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();

    const certToStore = certificate && certificate !== '[CONFIGURED]'
      ? certificate
      : (current?.certificate || '');

    const attrMappingJson = typeof attribute_mapping === 'object'
      ? JSON.stringify(attribute_mapping)
      : (attribute_mapping || '{}');

    if (current && current.organization_id === req.orgId) {
      // Update the existing org-specific row
      await db.prepare(`
        UPDATE saml_config SET
          enabled = $1, entity_id = $2, sso_url = $3, slo_url = $4, certificate = $5,
          name_id_format = $6, attribute_mapping = $7, auto_provision = $8,
          default_role = $9, allowed_domains = $10, updated_at = NOW()
        WHERE organization_id = $11
      `).run(
        enabled ? 1 : 0, entity_id || '', sso_url || '', slo_url || '', certToStore,
        name_id_format || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        attrMappingJson, auto_provision ? 1 : 0,
        default_role || 'org_user', allowed_domains || '', req.orgId
      );
    } else {
      // Associate the singleton row with this org (or insert a new org-specific row)
      await db.prepare(`
        UPDATE saml_config SET
          organization_id = $1, enabled = $2, entity_id = $3, sso_url = $4,
          slo_url = $5, certificate = $6, name_id_format = $7, attribute_mapping = $8,
          auto_provision = $9, default_role = $10, allowed_domains = $11, updated_at = NOW()
        WHERE id = 1
      `).run(
        req.orgId, enabled ? 1 : 0, entity_id || '', sso_url || '', slo_url || '', certToStore,
        name_id_format || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        attrMappingJson, auto_provision ? 1 : 0,
        default_role || 'org_user', allowed_domains || ''
      );
    }

    await logAuditAction(req.session.userId, 'Admin', 'saml_config_updated', 'saml', 1, null, `Enabled: ${enabled}`, req.orgId);
    res.json({ success: true });
  });

  // Generate Service Provider metadata
  app.get('/saml/metadata', async (req, res) => {
    const config = await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const metadata = `<?xml version="1.0" encoding="UTF-8"?>
  <md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${baseUrl}/saml/metadata">
    <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <md:NameIDFormat>${config?.name_id_format || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'}</md:NameIDFormat>
      <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${baseUrl}/saml/callback" index="0" isDefault="true"/>
      <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${baseUrl}/saml/logout"/>
    </md:SPSSODescriptor>
    <md:Organization>
      <md:OrganizationName xml:lang="en">Let The Frame Work</md:OrganizationName>
      <md:OrganizationDisplayName xml:lang="en">Let The Frame Work</md:OrganizationDisplayName>
      <md:OrganizationURL xml:lang="en">${baseUrl}</md:OrganizationURL>
    </md:Organization>
  </md:EntityDescriptor>`;

    res.set('Content-Type', 'application/xml');
    res.send(metadata);
  });

  // Initiate SAML login
  // Accepts ?org=<orgId> to select the right SAML configuration in multi-org setups.
  // The orgId is forwarded as RelayState so the callback can look up the same config.
  app.get('/saml/login', async (req, res) => {
    const orgId = req.query.org ? parseInt(req.query.org, 10) : null;

    // Look up config: prefer org-specific row, fall back to the singleton (id = 1)
    const config = orgId
      ? await db.prepare('SELECT * FROM saml_config WHERE organization_id = $1 AND enabled = 1').get(orgId)
        ?? await db.prepare('SELECT * FROM saml_config WHERE id = 1').get()
      : await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();

    if (!config || !config.enabled) {
      return res.status(400).send('SAML SSO is not enabled for this organisation');
    }
    if (!config.sso_url || !config.entity_id) {
      return res.status(400).send('SAML is not properly configured (missing SSO URL or Entity ID)');
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const requestId = '_' + crypto.randomBytes(16).toString('hex');
    const issueInstant = new Date().toISOString();
    const relayState = String(orgId || config.organization_id || '');

    const authnRequest = `<?xml version="1.0" encoding="UTF-8"?>
  <samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
      ID="${requestId}"
      Version="2.0"
      IssueInstant="${issueInstant}"
      Destination="${config.sso_url}"
      AssertionConsumerServiceURL="${baseUrl}/saml/callback"
      ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
    <saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${baseUrl}/saml/metadata</saml:Issuer>
    <samlp:NameIDPolicy Format="${config.name_id_format}" AllowCreate="true"/>
  </samlp:AuthnRequest>`;

    // SAML HTTP-Redirect binding requires deflateRaw + base64 (NOT plain base64)
    const deflated = await deflateRaw(Buffer.from(authnRequest, 'utf8'));
    const encodedRequest = deflated.toString('base64');

    const redirectUrl = new URL(config.sso_url);
    redirectUrl.searchParams.set('SAMLRequest', encodedRequest);
    if (relayState) redirectUrl.searchParams.set('RelayState', relayState);

    res.redirect(redirectUrl.toString());
  });

  // Handle SAML callback (Assertion Consumer Service)
  app.post('/saml/callback', express.urlencoded({ extended: true }), async (req, res) => {
    try {
      const samlResponse = req.body.SAMLResponse;
      const relayState   = req.body.RelayState || '';

      if (!samlResponse) {
        return res.status(400).send('No SAML response received');
      }

      // Resolve the correct SAML config: prefer org from RelayState, fall back to singleton
      const relayOrgId = parseInt(relayState, 10) || null;
      const config = (relayOrgId
        ? await db.prepare('SELECT * FROM saml_config WHERE organization_id = $1').get(relayOrgId)
        : null)
        ?? await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();

      if (!config || !config.enabled) {
        return res.status(400).send('SAML SSO is not enabled for this organisation');
      }

      // Decode the SAMLResponse (POST binding = plain base64, no deflate)
      const decodedResponse = Buffer.from(samlResponse, 'base64').toString('utf8');

      // --- Signature validation ---
      if (config.certificate) {
        const sigResult = verifySamlSignature(decodedResponse, config.certificate);
        if (!sigResult.valid) {
          console.error('[SAML] Signature verification failed:', sigResult.reason);
          return res.status(403).send(`SAML signature verification failed: ${sigResult.reason}`);
        }
      } else {
        console.warn('[SAML] No certificate configured – skipping signature verification');
      }

      // --- Extract user attributes via attribute-name patterns ---
      const emailMatch =
        decodedResponse.match(/<(?:[^:>\s]+:)?Attribute[^>]+Name="[^"]*email[^"]*"[^>]*>[\s\S]*?<(?:[^:>\s]+:)?AttributeValue[^>]*>([^<]+)/i) ||
        decodedResponse.match(/<(?:[^:>\s]+:)?NameID[^>]*>([^<]+)/);
      const nameMatch =
        decodedResponse.match(/<(?:[^:>\s]+:)?Attribute[^>]+Name="[^"]*(?:displayname|name|givenname)[^"]*"[^>]*>[\s\S]*?<(?:[^:>\s]+:)?AttributeValue[^>]*>([^<]+)/i);

      let email = emailMatch?.[2] ?? emailMatch?.[1] ?? null;
      let name  = nameMatch?.[1] ?? null;

      if (!email) return res.status(400).send('Could not extract email from SAML assertion');

      email = email.trim().toLowerCase();
      name  = name ? name.trim() : email.split('@')[0];

      // --- Domain allowlist ---
      if (config.allowed_domains) {
        const allowed = config.allowed_domains.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
        const domain  = email.split('@')[1];
        if (allowed.length > 0 && !allowed.includes(domain)) {
          return res.status(403).send('Your email domain is not permitted to access this application');
        }
      }

      const orgId = config.organization_id;

      // --- Find or auto-provision user ---
      let user = await db.prepare('SELECT * FROM users WHERE email = $1').get(email);

      if (!user && config.auto_provision) {
        // Create user linked to the org that owns this SAML config
        const result = await db.prepare(`
          INSERT INTO users (name, email, role, permissions, status, sso_provider, organization_id)
          VALUES ($1, $2, $3, $4, 'active', 'saml', $5)
        `).run(name, email, config.default_role || 'org_user',
               JSON.stringify(['org', 'risk', 'ops', 'audit']), orgId);

        user = await db.prepare('SELECT * FROM users WHERE id = $1').get(result.lastInsertRowid);
        await logAuditAction(user.id, user.name, 'user_provisioned_saml', 'user', user.id, user.name, '', orgId);
      } else if (!user) {
        return res.status(403).send('User not found and auto-provisioning is disabled');
      } else {
        await db.prepare("UPDATE users SET last_active = NOW() WHERE id = $1").run(user.id);
      }

      // --- Record SAML session (for SLO / audit trail) ---
      const samlSessionId = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await db.prepare(`
        INSERT INTO saml_sessions (id, user_id, name_id, expires_at)
        VALUES ($1, $2, $3, $4)
      `).run(samlSessionId, user.id, email, expiresAt);

      await logAuditAction(user.id, user.name, 'saml_login', 'user', user.id, user.name, '', orgId);

      // --- Establish a standard cookie-JWT session ---
      // This integrates with the existing requireOrgContext / requireAdmin middleware
      // so no special handling is needed anywhere else in the app.
      req.session.userId         = user.id;
      req.session.userRole       = user.role;
      req.session.organizationId = user.organization_id || orgId;
      req.session.activeOrgId    = user.organization_id || orgId;
      req.session.save();

      res.redirect('/');

    } catch (err) {
      console.error('[SAML] Callback error:', err);
      res.status(500).send('Error processing SAML response. Please contact your administrator.');
    }
  });

  // SAML logout – clears both the cookie-JWT session and the saml_sessions record
  app.get('/saml/logout', async (req, res) => {
    // Clear the standard session cookie so requireOrgContext stops accepting the user
    req.session.destroy();

    // Also clean up the saml_sessions record if a session id was provided
    // (used when the IdP initiates SLO and passes the session back via query param)
    const samlSessionId = req.query.session || req.query.sid;
    if (samlSessionId) {
      const samlSess = await db.prepare('SELECT * FROM saml_sessions WHERE id = $1').get(samlSessionId);
      if (samlSess) {
        await db.prepare('DELETE FROM saml_sessions WHERE id = $1').run(samlSessionId);
        const u = await db.prepare('SELECT organization_id FROM users WHERE id = $1').get(samlSess.user_id);
        await logAuditAction(samlSess.user_id, 'User', 'saml_logout', 'user', samlSess.user_id, samlSess.name_id, '', u?.organization_id ?? null);
      }
    }

    res.redirect('/login');
  });

  // Validate SAML session
  app.get('/api/auth/session', async (req, res) => {
    const sessionId = req.headers['x-saml-session'];
    if (!sessionId) {
      return res.json({ authenticated: false });
    }

    const session = await db.prepare(`
      SELECT s.*, u.name, u.email, u.role, u.permissions
      FROM saml_sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.id = ? AND s.expires_at > datetime('now')
    `).get(sessionId);

    if (!session) {
      return res.json({ authenticated: false });
    }

    res.json({
      authenticated: true,
      user: {
        id: session.user_id,
        name: session.name,
        email: session.email,
        role: session.role,
        permissions: JSON.parse(session.permissions || '[]')
      }
    });
  });

  // Test SAML configuration
  app.post('/api/admin/saml/test', requireAdmin, async (req, res) => {
    const config = await db.prepare('SELECT * FROM saml_config WHERE organization_id = $1').get(req.orgId)
      ?? await db.prepare('SELECT * FROM saml_config WHERE id = 1').get();

    const issues = [];
    if (!config.entity_id) issues.push('Identity Provider Entity ID is not configured');
    if (!config.sso_url) issues.push('SSO URL is not configured');
    if (!config.certificate) issues.push('IdP Certificate is not configured');

    if (issues.length > 0) {
      return res.json({ success: false, issues });
    }

    // Validate certificate format
    if (!config.certificate.includes('BEGIN CERTIFICATE')) {
      issues.push('Certificate does not appear to be in PEM format');
    }

    // Validate URL format
    try {
      new URL(config.sso_url);
    } catch {
      issues.push('SSO URL is not a valid URL');
    }

    if (issues.length > 0) {
      return res.json({ success: false, issues });
    }

    const base = `${req.protocol}://${req.get('host')}`;
    res.json({
      success: true,
      message: 'SAML configuration appears valid. Test login to verify full functionality.',
      metadata_url: `${base}/saml/metadata`,
      callback_url: `${base}/saml/callback`,
      login_url: `${base}/saml/login?org=${req.orgId}`,
    });
  });
}

module.exports = { registerSamlRoutes };
