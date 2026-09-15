// Register on the shared app to retain middleware and transaction boundaries.
function registerLinksRoutes(app, { db, requireOrgContext }) {
  // --- Universal Cross-Linking API ---

  require('../services/entities').registerLinkRoutes(app, db, requireOrgContext);
  require('../routes/relationships').registerRelationships(app, db, requireOrgContext);
  require('../routes/overview').registerOverview(app, db, requireOrgContext);

  // Cross-linking references endpoint (legacy for document control)
  app.get('/api/link-references', requireOrgContext, async (req, res) => {
    const { module } = req.query;
    const refs = [];
    if (module === 'audits') {
      const reqs = await db.prepare('SELECT id, clause, title, standard FROM standard_requirements WHERE organization_id = ? ORDER BY standard, sort_order').all(req.orgId);
      reqs.forEach(r => refs.push({ id: r.id, type: 'requirement', label: `${r.clause} - ${r.title} (${r.standard})` }));
    } else if (module === 'risk-management') {
      const risks = await db.prepare('SELECT id, title FROM risks WHERE organization_id = ? ORDER BY title').all(req.orgId);
      risks.forEach(r => refs.push({ id: r.id, type: 'risk', label: r.title }));
    } else if (module === 'operational-planning') {
      const tasks = await db.prepare('SELECT id, title FROM tasks WHERE organization_id = ? ORDER BY title').all(req.orgId);
      tasks.forEach(t => refs.push({ id: t.id, type: 'task', label: t.title }));
      const actions = await db.prepare('SELECT id, title FROM actions WHERE organization_id = ? ORDER BY title').all(req.orgId);
      actions.forEach(a => refs.push({ id: a.id, type: 'action', label: a.title }));
    } else if (module === 'org-planning') {
      const arch = await db.prepare('SELECT id, name, arch_type FROM org_architecture WHERE organization_id = ? ORDER BY arch_type, name').all(req.orgId);
      arch.forEach(a => refs.push({ id: a.id, type: a.arch_type, label: `${a.name} (${a.arch_type})` }));
    }
    res.json(refs);
  });
}

module.exports = { registerLinksRoutes };
