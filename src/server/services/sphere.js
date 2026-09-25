const { entities, positiveId } = require('./entities');
const { relationships } = require('../routes/relationships');
const { HttpError } = require('../shared/errors');

// Fixed SQL definitions only. No field, table or expression comes from a request.
const sphereTypes = Object.fromEntries(Object.entries(entities).filter(([type]) => type !== 'ai_usecase'));
// Legacy Architecture AI records are distinct from the AI governance register.
sphereTypes.arch_ai_usecase = { table: 'org_architecture', name: 'name', label: 'Architecture AI use case', subtype: 'ai_usecase' };
const canonical = type => type === 'ai_usecase' ? 'usecase' : type;
const accessType = type => type === 'arch_ai_usecase' ? 'process' : type;
const statuses = { task: "CASE WHEN is_active=1 THEN 'active' ELSE 'inactive' END", requirement: "''", checklist: 'rating', kpi: "''", plan_bundle: "''" };
const descriptions = { ncr: 'description', checklist: 'requirement', supplier: 'services_provided', management_review: 'summary', review_output: 'description', threat: 'description', instance: 'notes', plan_bundle: "''" };
const extraColumns = {
  task: ['category', 'assignee'], document: ['linked_ref_type', 'linked_ref_id'], supplier: ['metadata'],
  plan_bundle: ['process_ids'], audit: ['parent_audit_id'], management_review: ['report_doc_id'],
};
const relationLabels = {
  task_id: 'Control series', instance_id: 'Control ticket', process_id: 'Process', audit_id: 'Audit',
  checklist_item_id: 'Audit finding', risk_id: 'Treats risk', requirement_id: 'Requirement',
  review_id: 'Management review', linked_action_id: 'Follow-up action', created_risk_id: 'Created risk',
};
function parseJson(value, fallback) { try { return JSON.parse(value || 'null') ?? fallback; } catch { return fallback; } }
function mayRead(canAccess, type) { return Object.hasOwn(sphereTypes, type) && canAccess(accessType(type)); }
function detailExpression(type) {
  // Some registries carry their full meaning in the name rather than a description.
  if (type === 'task' || type === 'risk' || type === 'action' || type === 'treatment' || type === 'document' || type === 'usecase' || type === 'requirement' || type === 'kpi' || sphereTypes[type]?.subtype) return 'description';
  if (type === 'audit') return 'scope';
  return descriptions[type] || "''";
}

async function sphereGraph(db, orgId, canAccess) {
  const nodes = new Map(); const rowsByType = new Map(); const edges = new Map();
  // Batch each registry once, not one request/query per node or connection.
  for (const [type, def] of Object.entries(sphereTypes)) {
    if (!mayRead(canAccess, type)) continue;
    const fields = new Set(extraColumns[type] || []);
    for (const [child, , column] of relationships) if (child === type) fields.add(column);
    if (def.subtype) fields.add('parent_id');
    const rows = await db.all(`SELECT id, ${def.name} AS name, ${statuses[type] || 'status'} AS status${fields.size ? ', ' + [...fields].join(', ') : ''}
      FROM ${def.table} WHERE organization_id = ?${def.subtype ? ' AND arch_type = ?' : ''} ORDER BY id`, orgId, ...(def.subtype ? [def.subtype] : []));
    rowsByType.set(type, rows);
    for (const row of rows) nodes.set(`${type}:${row.id}`, { key: `${type}:${row.id}`, type, id: row.id, name: String(row.name || `${def.label} #${row.id}`), status: row.status || '' });
  }
  function connect(sourceType, sourceId, targetType, targetId, label, origin, notes = '', directed = false) {
    const source = `${canonical(sourceType)}:${Number(sourceId)}`, target = `${canonical(targetType)}:${Number(targetId)}`;
    // Both endpoints must exist, in this organization, in a permitted registry.
    if (source === target || !nodes.has(source) || !nodes.has(target)) return;
    const pair = [source, target].sort().join('|');
    const key = `${pair}|${origin}|${label}`;
    if (!edges.has(key)) edges.set(key, { source, target, label, origin, directed, ...(notes ? { notes: String(notes).slice(0, 2000) } : {}) });
  }
  const explicit = await db.all('SELECT source_type,source_id,target_type,target_id,relationship_type,notes FROM cross_links WHERE organization_id=? ORDER BY id', orgId);
  for (const row of explicit) {
    // Cross-links are stored canonically, not directionally: do not invent arrows.
    connect(row.source_type, row.source_id, row.target_type, row.target_id, row.relationship_type || 'association', 'cross_link', row.notes);
  }
  for (const [child, parent, column] of relationships) {
    for (const row of rowsByType.get(child) || []) connect(child, row.id, parent, row[column], relationLabels[column], 'record', '', true);
  }
  const architecture = new Map();
  for (const [type, rows] of rowsByType) if (sphereTypes[type].subtype) for (const row of rows) architecture.set(row.id, { ...row, type });
  for (const row of architecture.values()) {
    const parent = architecture.get(row.parent_id);
    if (parent) connect(row.type, row.id, parent.type, parent.id, 'Parent', 'hierarchy', '', true);
  }
  for (const row of rowsByType.get('document') || []) connect('document', row.id, row.linked_ref_type, row.linked_ref_id, 'Document reference', 'record', '', true);
  for (const row of rowsByType.get('supplier') || []) {
    const metadata = parseJson(row.metadata, {});
    for (const link of Array.isArray(metadata?.arch_links) ? metadata.arch_links : []) if (link && typeof link === 'object') connect('supplier', row.id, link.type, link.id, 'Supplier architecture', 'record');
  }
  for (const row of rowsByType.get('plan_bundle') || []) {
    const ids = parseJson(row.process_ids, []);
    for (const id of Array.isArray(ids) ? ids : []) connect('plan_bundle', row.id, 'process', id, 'Contains process', 'record', '', true);
  }
  if (mayRead(canAccess, 'requirement') && mayRead(canAccess, 'process') && canAccess('soa')) {
    for (const row of await db.all('SELECT requirement_id,linked_processes FROM soa_entries WHERE organization_id=?', orgId)) {
      const ids = parseJson(row.linked_processes, []);
      for (const id of Array.isArray(ids) ? ids : []) connect('requirement', row.requirement_id, 'process', id, 'SoA process', 'record');
    }
  }
  for (const row of rowsByType.get('audit') || []) connect('audit', row.id, 'audit', row.parent_audit_id, 'Recurring audit', 'record', '', true);
  for (const row of rowsByType.get('management_review') || []) connect('management_review', row.id, 'document', row.report_doc_id, 'Review report', 'record', '', true);
  // Planning stores these references as names. Resolve exact, unambiguous matches
  // only, and expose their provenance instead of pretending they are ID links.
  for (const [type, field, label] of [['process', 'category', 'Planning process'], ['role', 'assignee', 'Assigned role']]) {
    const byName = new Map();
    for (const row of rowsByType.get(type) || []) byName.set(row.name, byName.has(row.name) ? null : row.id);
    for (const task of rowsByType.get('task') || []) {
      const id = byName.get(task[field]);
      if (id) connect('task', task.id, type, id, label, 'saved_name', 'Exact, unique name saved in the control series.', true);
    }
  }
  // Use the authoritative series name for tickets only when that series is visible.
  for (const row of rowsByType.get('instance') || []) {
    const task = nodes.get(`task:${row.task_id}`);
    if (task) nodes.get(`instance:${row.id}`).name = `${task.name} · ${row.name}`;
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], types: Object.entries(sphereTypes).filter(([type]) => mayRead(canAccess, type)).map(([type, def]) => ({ type, label: type === 'task' ? 'Control series' : type === 'instance' ? 'Control ticket' : type === 'action' ? 'Follow-up' : def.label })), as_of: new Date().toISOString() };
}

async function sphereDetail(db, orgId, canAccess, type, rawId) {
  if (!Object.hasOwn(sphereTypes, type)) throw new HttpError(400, 'Unknown record type');
  if (!mayRead(canAccess, type)) throw new HttpError(403, 'Access to this module is not permitted');
  const def = sphereTypes[type]; const id = positiveId(rawId);
  const row = await db.get(`SELECT id, ${def.name} AS name, ${statuses[type] || 'status'} AS status, LEFT(${detailExpression(type)}, 4000) AS description
    FROM ${def.table} WHERE organization_id=? AND id=?${def.subtype ? ' AND arch_type=?' : ''}`, orgId, id, ...(def.subtype ? [def.subtype] : []));
  if (!row) throw new HttpError(404, 'Record no longer available');
  return { ...row, type };
}
module.exports = { sphereGraph, sphereDetail };
