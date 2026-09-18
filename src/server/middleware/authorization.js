const { HttpError } = require('../shared/errors');
const MODULES = ['org', 'risk', 'ops', 'audit'];
const entityModules = {
  risk: ['risk'], treatment: ['risk'], threat: ['risk'], soa: ['risk'],
  audit: ['audit'], checklist: ['audit'], ncr: ['audit'], requirement: ['audit', 'risk'],
  task: ['ops', 'org'], action: ['ops', 'org'], instance: ['ops', 'org'], plan_bundle: ['ops', 'org'],
  document: MODULES, management_review: ['org'], review_output: ['org'],
  supplier: ['org'], kpi: ['org'], usecase: ['org'], ai_usecase: ['org'],
  role: ['org'], process: ['org'], system: ['org'], asset: ['org'], facility: ['org'], ai_model: ['org'], ai_dataset: ['org'],
};
const routeModules = {
  risks: ['risk'], treatments: ['risk'], 'threat-feeds': ['risk'], 'threat-items': ['risk'], soa: ['risk'],
  audits: ['audit'], checklist: ['audit'], ncrs: ['audit'], requirements: ['audit', 'risk'],
  tasks: ['ops', 'org'], actions: ['ops', 'org'], 'task-instances': ['ops', 'org'],
  'plan-bundles': ['ops', 'org'], dashboard: ['ops', 'org'], yearly: ['ops', 'org'], meta: MODULES,
  mission: ['org'], kpis: ['org'], architecture: ['org'], 'use-cases': ['org'], suppliers: ['org'],
  'management-reviews': ['org'], 'my-tasks': ['ops', 'org'], 'org-users': MODULES,
  documents: MODULES, agent: MODULES, 'entity-types': MODULES, 'compliance-overview': MODULES,
};
function permissions(user) {
  try { const values = JSON.parse(user?.permissions || '[]'); return Array.isArray(values) ? values.filter(p => MODULES.includes(p)) : []; }
  catch { return []; }
}
function isAdministrator(user) { return ['superadmin', 'org_admin', 'admin'].includes(user?.role); }
function canAccessEntity(user, type) {
  const allowed = entityModules[type];
  return !!allowed && (isAdministrator(user) || allowed.some(p => permissions(user).includes(p)));
}
function authorizeApi(db) {
  return async (req, res, next) => {
    const path = req.originalUrl.split('?')[0].split('/').filter(Boolean);
    const resource = path[1];
    if (['auth', 'msp', 'admin'].includes(resource)) return next(); // Dedicated authentication/admin middleware.
    const user = req.authUser;
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    req.canAccessEntity = type => canAccessEntity(user, type);
    const checkType = type => { if (!req.canAccessEntity(type)) throw new HttpError(403, 'Access to this module is not permitted'); };
    if (['linkable', 'linked-record', 'relations'].includes(resource)) checkType(path[2]);
    else if (resource === 'cross-links') {
      if (req.method === 'POST') { checkType(req.body.source_type); checkType(req.body.target_type); }
      else if (req.method === 'DELETE') {
        const orgId = user.role === 'superadmin' ? req.session.activeOrgId : user.organization_id;
        const link = await db.get('SELECT source_type, target_type FROM cross_links WHERE id=? AND organization_id=?', path[2], orgId);
        if (!link) throw new HttpError(404, 'Link not found');
        checkType(link.source_type); checkType(link.target_type);
      } else checkType(path[2] === 'batch' ? path[3] : path[2]);
    } else if (resource === 'link-references') {
      const types = { audits: 'requirement', 'risk-management': 'risk', 'operational-planning': 'task', 'org-planning': 'process' };
      checkType(types[req.query.module]);
    } else {
      const allowed = routeModules[resource];
      if (!allowed) return res.status(404).json({ error: 'API endpoint not found' });
      if (!isAdministrator(user) && !allowed.some(p => permissions(user).includes(p))) throw new HttpError(403, 'Access to this module is not permitted');
    }
    // A viewer never writes, regardless of its module visibility.
    if (user.role === 'viewer' && !['GET','HEAD','OPTIONS'].includes(req.method)) throw new HttpError(403, 'Read-only account');
    if (resource === 'kpis' && path[2] === 'auto' && !isAdministrator(user) && !MODULES.every(p => permissions(user).includes(p))) throw new HttpError(403, 'Cross-module KPI calculation requires access to all modules');
    for (const field of ['source_type','target_type','linked_ref_type']) if (req.body?.[field]) checkType(req.body[field]);
    // Shared relationship pickers must not reveal names from a hidden module.
    if (['entity-types','cross-links','relations'].includes(resource) && req.method === 'GET') {
      const send = res.json;
      res.json = value => {
        const visible = rows => rows.filter(row => req.canAccessEntity(row.type));
        const filtered = Array.isArray(value) ? visible(value) : resource === 'cross-links' && value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key,rows]) => [key,Array.isArray(rows) ? visible(rows) : rows])) : value;
        return send.call(res, filtered);
      };
    }
    next();
  };
}
module.exports = { authorizeApi, canAccessEntity, permissions, isAdministrator, MODULES };
