const { HttpError } = require('./errors');
const { positiveId, requireEntity } = require('./entities');
const enums = {
  tasks: { priority: ['Low','Medium','High','Critical'], recurrence: ['daily','weekly','biweekly','monthly','quarterly','yearly','custom'] },
  actions: { priority: ['Low','Medium','High','Critical'], status: ['open','in_progress','resolved','closed'] },
  risks: { status: ['identified','analyzing','treating','accepted','closed'] },
  treatments: { status: ['planned','in_progress','implemented','verified'], treatment_type: ['mitigate','accept','transfer','avoid'] },
  audits: { status: ['planned','in_progress','completed','cancelled'] },
  checklist: { rating: ['not_assessed','conforming','observation','minor_nc','major_nc'] },
  ncrs: { severity: ['minor','major'], status: ['open','in_progress','closed','verified'] },
  soa: { implementation_status: ['not_implemented','partial','implemented'] },
  documents: { status: ['draft','review','approved','obsolete'], doc_type: ['policy','procedure','work_instruction','record','form','report','evidence','other'] },
  'threat-items': { status: ['new','reviewed','dismissed','risk_created'] },
  'management-reviews': { status: ['scheduled','in_progress','completed'] },
  architecture: { arch_type: ['role','process','system','asset','facility','ai_model','ai_dataset','ai_usecase'] },
};
async function validateRequest(req, db) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method) || !req.orgId) return;
  const body = req.body || {};
  const parts = req.path.split('/').filter(Boolean);
  const module = parts[1];
  if (!Object.hasOwn(enums,module) && !['kpis','plan-bundles','task-instances','suppliers','use-cases'].includes(module)) return;
  // Validate the main record only; nested resources have their own states.
  let rules = parts.length <= 3 ? enums[module] || {} : {};
  if (module === 'management-reviews' && parts[3] === 'outputs' && parts.length <= 5) rules = { type: ['improvement','resource','change'], status: ['open','in_progress','completed'] };
  for (const [field, allowed] of Object.entries(rules)) {
    if (body[field] !== undefined && !allowed.includes(body[field])) throw new HttpError(400, `Invalid ${field}`);
  }
  for (const field of ['title', 'name']) {
    if (body[field] !== undefined && (typeof body[field] !== 'string' || !body[field].trim())) throw new HttpError(400, `${field} cannot be empty`);
  }
  for (const field of ['start_date','next_due','due_date','planned_date','completed_date','review_date','next_review_date','contract_expiry_date','dpa_review_date','go_live_date','target_go_live','approval_date']) {
    const value = body[field];
    if (value == null || value === '') continue;
    const date = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value) throw new HttpError(400, `Invalid ${field}`);
  }
  for (const [field, min, max] of [['likelihood',1,5],['impact',1,5],['residual_likelihood',1,5],['residual_impact',1,5],['day_of_week',0,6],['day_of_month',1,31],['custom_days',1,36500]]) {
    const value = body[field];
    if (value == null || value === '') continue;
    if (!Number.isInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new HttpError(400, `${field} must be between ${min} and ${max}`);
  }
  for (const field of module === 'kpis' ? ['value', 'target_value'] : []) {
    if (body[field] != null && body[field] !== '' && !Number.isFinite(Number(body[field]))) throw new HttpError(400, `Invalid ${field}`);
  }
  const refs = {
    actions: { task_id: 'task', instance_id: 'instance', process_id: 'process' },
    ncrs: { audit_id: 'audit', checklist_item_id: 'checklist' },
    treatments: { risk_id: 'risk', requirement_id: 'requirement' },
    kpis: { process_id: 'process' },
    'threat-items': { created_risk_id: 'risk' },
    'management-reviews': { linked_action_id: 'action' },
  }[module] || {};
  for (const [field, type] of Object.entries(refs)) if (body[field] != null && body[field] !== '') await requireEntity(db, req.orgId, type, body[field]);
  if (module === 'actions' && body.instance_id) {
    const completion = await db.get('SELECT task_id FROM task_instances WHERE id = ? AND organization_id = ?', body.instance_id, req.orgId);
    if (body.task_id && Number(body.task_id) !== completion.task_id) throw new HttpError(400, 'Execution belongs to a different task');
    body.task_id = completion.task_id;
  }
  if (module === 'ncrs' && body.checklist_item_id) {
    const item = await db.get('SELECT audit_id FROM audit_checklist WHERE id = ? AND organization_id = ?', body.checklist_item_id, req.orgId);
    if (body.audit_id && Number(body.audit_id) !== item.audit_id) throw new HttpError(400, 'Checklist item belongs to a different audit');
    body.audit_id = item.audit_id;
  }
  if (module === 'audits' && parts[3] === 'checklist') await requireEntity(db, req.orgId, 'audit', parts[2]);
  if (module === 'kpis' && parts[3] === 'values') await requireEntity(db, req.orgId, 'kpi', parts[2]);
  if (module === 'soa' && /^\d+$/.test(parts[2] || '')) await requireEntity(db, req.orgId, 'requirement', parts[2]);
  if (module === 'plan-bundles' && body.process_ids !== undefined) {
    if (!Array.isArray(body.process_ids) || body.process_ids.length > 1000) throw new HttpError(400, 'process_ids must be a list of up to 1000 process IDs');
    body.process_ids = [...new Set(body.process_ids.map(positiveId))];
    for (const id of body.process_ids) await requireEntity(db, req.orgId, 'process', id);
  }
  if (module === 'soa' && body.linked_processes !== undefined) {
    if (!Array.isArray(body.linked_processes)) throw new HttpError(400, 'linked_processes must be a list');
    for (const id of body.linked_processes) await requireEntity(db, req.orgId, 'process', id);
  }
  if (module === 'documents' && (body.linked_ref_id !== undefined || body.linked_ref_type !== undefined)) {
    const existing = parts[2] ? await db.get('SELECT linked_ref_type, linked_ref_id FROM documents WHERE id=? AND organization_id=?',parts[2],req.orgId) : {};
    const type = body.linked_ref_type ?? existing?.linked_ref_type;
    const id = body.linked_ref_id ?? existing?.linked_ref_id;
    if (id) await requireEntity(db,req.orgId,type,id);
  }
  if (module === 'architecture' && body.parent_id) {
    const currentId = parts[2] ? positiveId(parts[2]) : null;
    const visited = new Set(currentId ? [currentId] : []);
    let id = positiveId(body.parent_id);
    while (id) {
      if (visited.has(id)) throw new HttpError(400, 'This parent would create a circular hierarchy');
      visited.add(id);
      const parent = await db.get('SELECT parent_id FROM org_architecture WHERE id = ? AND organization_id = ?', id, req.orgId);
      if (!parent) throw new HttpError(404, 'Parent not found in this organization');
      id = parent.parent_id;
    }
  }
  if (module === 'use-cases') {
    for (const field of ['owner_id','implementation_owner_id','approved_by_id','user_id']) {
      if (!body[field]) continue;
      const user = await db.get('SELECT id FROM users WHERE id=? AND organization_id=?',positiveId(body[field]),req.orgId);
      if (!user) throw new HttpError(404,'Selected user not found in this organization');
    }
    if (body.status !== undefined && (parts.length <= 3 || parts[3] === 'stage')) {
      if (!['new','assessment','approved','development','production','retired'].includes(body.status)) throw new HttpError(400,'Invalid use case stage');
      const current = parts[2] ? await db.get('SELECT * FROM use_cases WHERE id=? AND organization_id=?',parts[2],req.orgId) : {};
      const merged = {...current,...body};
      if (body.status==='approved' && (!merged.approved_by_id || !merged.approval_date)) throw new HttpError(422,'Set Approved By and Approval Date before moving to Approved.');
      if (body.status==='development' && !merged.implementation_owner_id) throw new HttpError(422,'Assign an Implementation Owner before starting Development.');
      if (body.status==='production' && !merged.go_live_date) throw new HttpError(422,'Set a Go-Live Date before moving to Production.');
    }
  }
  if (module==='management-reviews' && parts[3]==='outputs' && parts.length<=5) {
    const current=parts[4] ? await db.get('SELECT * FROM management_review_outputs WHERE id=? AND review_id=? AND organization_id=?',parts[4],parts[2],req.orgId) : {};
    const actionId=body.linked_action_id !== undefined ? body.linked_action_id : current?.linked_action_id;
    if(actionId){
      const action=await db.get('SELECT status FROM actions WHERE id=? AND organization_id=?',actionId,req.orgId);
      if(!action)throw new HttpError(404,'Linked action not found');
      body.status=['resolved','closed'].includes(action.status)?'completed':action.status==='in_progress'?'in_progress':'open';
    }
  }
}
async function validateScope(req,db) {
  const parts=req.path.split('/').filter(Boolean);
  if(req.orgId && parts[1]==='use-cases' && parts[2] && ['members','approvals','stage'].includes(parts[3])) await requireEntity(db,req.orgId,'usecase',parts[2]);
}
function installRouteHandling(app, db) {
  for (const method of ['get','post','put','patch','delete']) {
    const register = app[method].bind(app);
    app[method] = (path, ...handlers) => {
      if (!handlers.length) return register(path); // app.get(setting)
      const wrapped = handlers.map((handler, index) => {
        if (typeof handler !== 'function' || handler.length === 4) return handler;
        return (req, res, next) => {
          Promise.resolve().then(async () => {
            const finalHandler = index === handlers.length - 1;
            const atomic = finalHandler && req.orgId && ['POST','PUT','DELETE'].includes(req.method)
              && /^\/api\/(tasks|task-instances|cross-links|soa|actions|ncrs|checklist|risks|treatments|kpis|architecture|plan-bundles|management-reviews|audits|use-cases)(\/|$)/.test(req.path)
              && !/evidence|upload|report|reference-data/.test(req.path);
            if (!atomic) {
              if (finalHandler) { await validateScope(req,db); await validateRequest(req, db); }
              return handler(req, res, next);
            }
            // Do not acknowledge success before COMMIT. All participating writes
            // within an organization are serialized, including reference checks.
            const sendJson = res.json;
            let payload;
            res.json = value => { payload = value; return res; };
            try {
              await db.transaction(async () => {
                await db.get('SELECT pg_advisory_xact_lock(?)', req.orgId);
                await validateScope(req,db);
                await validateRequest(req, db);
                await handler(req, res, next);
                if (res.statusCode >= 400) { const error = new HttpError(res.statusCode, payload?.error || 'Request failed'); throw error; }
              });
            } finally { res.json = sendJson; }
            if (payload !== undefined) res.json(payload);
          }).catch(next);
        };
      });
      return register(path, ...wrapped);
    };
  }
}
module.exports = { installRouteHandling, validateRequest };
