const { HttpError } = require('../shared/errors');
// One registry for link pickers, name resolution and relationship validation.
const entities = {
  risk: { table: 'risks', label: 'Risk', name: 'title' },
  task: { table: 'tasks', label: 'Task', name: 'title' },
  action: { table: 'actions', label: 'Action', name: 'title' },
  audit: { table: 'audits', label: 'Audit', name: 'title' },
  requirement: { table: 'standard_requirements', label: 'Requirement', name: "clause || ' - ' || title || ' (' || standard || ')'" },
  ncr: { table: 'non_conformities', label: 'Non-conformity', name: "clause || ' - ' || substr(description, 1, 100)" },
  treatment: { table: 'risk_treatments', label: 'Treatment', name: "COALESCE(NULLIF(description, ''), 'Treatment #' || id)" },
  document: { table: 'documents', label: 'Document', name: 'title' },
  checklist: { table: 'audit_checklist', label: 'Checklist item', name: "clause || ' - ' || requirement" },
  supplier: { table: 'suppliers', label: 'Supplier', name: 'name' },
  kpi: { table: 'org_kpis', label: 'KPI', name: 'name' },
  management_review: { table: 'management_reviews', label: 'Management review', name: 'title' },
  review_output: { table: 'management_review_outputs', label: 'Review decision', name: 'description' },
  threat: { table: 'threat_items', label: 'Threat', name: 'title' },
  instance: { table: 'task_instances', label: 'Task execution', name: "'Execution #' || id || ' (' || scheduled_date || ')'" },
  usecase: { table: 'use_cases', label: 'AI use case', name: 'title' },
  ai_usecase: { table: 'use_cases', label: 'AI use case', name: 'title' },
  plan_bundle: { table: 'plan_bundles', label: 'Process group', name: 'name' },
};
for (const type of ['role', 'process', 'system', 'asset', 'facility', 'ai_model', 'ai_dataset']) {
  entities[type] = { table: 'org_architecture', label: type[0].toUpperCase() + type.slice(1), name: 'name', subtype: type };
}
function definition(type) {
  if (!Object.hasOwn(entities, type)) throw new HttpError(400, 'Unknown entity type');
  return entities[type];
}
function positiveId(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) throw new HttpError(400, 'Invalid record ID');
  return Number(value);
}
async function listEntities(db, orgId, type, ids) {
  const def = definition(type);
  const params = [orgId];
  let where = 'organization_id = ?';
  if (def.subtype) { where += ' AND arch_type = ?'; params.push(def.subtype); }
  if (ids) {
    if (!ids.length) return [];
    where += ` AND id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids.map(positiveId));
  }
  return db.all(`SELECT id, ${def.name} AS name FROM ${def.table} WHERE ${where} ORDER BY name, id`, ...params);
}
async function requireEntity(db, orgId, type, id) {
  const rows = await listEntities(db, orgId, type, [positiveId(id)]);
  if (!rows.length) throw new HttpError(404, `${definition(type).label} not found in this organization`);
  return rows[0];
}
function canonicalLink(sourceType, sourceId, targetType, targetId) {
  definition(sourceType); definition(targetType);
  sourceId = positiveId(sourceId); targetId = positiveId(targetId);
  if (sourceType === targetType && sourceId === targetId) throw new HttpError(400, 'A record cannot link to itself');
  return sourceType < targetType || (sourceType === targetType && sourceId < targetId)
    ? [sourceType, sourceId, targetType, targetId] : [targetType, targetId, sourceType, sourceId];
}
const relationshipTypes = ['association','composition','aggregation','assignment','realization','serving','triggering','flow','influence','access'];
async function addLink(db, orgId, sourceType, sourceId, targetType, targetId, relationshipType = 'association', notes = '') {
  if (!relationshipTypes.includes(relationshipType)) throw new HttpError(400, 'Invalid relationship type');
  if (typeof notes !== 'string' || notes.length > 10000) throw new HttpError(400, 'Notes must be text of at most 10000 characters');
  const values = canonicalLink(sourceType, sourceId, targetType, targetId);
  await requireEntity(db, orgId, sourceType, sourceId);
  await requireEntity(db, orgId, targetType, targetId);
  const existing = await db.get(`SELECT id, relationship_type FROM cross_links WHERE organization_id = ? AND
    ((source_type = ? AND source_id = ? AND target_type = ? AND target_id = ?) OR
     (target_type = ? AND target_id = ? AND source_type = ? AND source_id = ?))`, orgId, ...values, ...values);
  if (existing) {
    // Existing schema permits one relationship per endpoint pair. Do not silently
    // overwrite ArchiMate semantics when an association picker submits again.
    if ((existing.relationship_type || 'association') !== relationshipType) throw new HttpError(409, 'These records already have a different relationship type');
    return existing.id;
  }
  const result = await db.run(`INSERT INTO cross_links (organization_id, source_type, source_id, target_type, target_id, relationship_type, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, orgId, ...values, relationshipType, notes);
  return result.lastInsertRowid;
}
async function linksFor(db, orgId, type, ids) {
  definition(type);
  ids = [...new Set(ids.map(positiveId))];
  if (!ids.length) return {};
  if (ids.length > 1000) throw new HttpError(400, 'Request at most 1000 records at a time');
  const visible = new Set((await listEntities(db, orgId, type, ids)).map(row => row.id));
  const ph = ids.map(() => '?').join(',');
  const rows = await db.all(`SELECT * FROM cross_links WHERE organization_id = ? AND
    ((source_type = ? AND source_id IN (${ph})) OR (target_type = ? AND target_id IN (${ph})))`, orgId, type, ...ids, type, ...ids);
  const needed = new Map();
  const byItem = Object.fromEntries([...visible].map(id => [id, []]));
  for (const row of rows) {
    // Both endpoints may occur in the same batch (e.g. process -> process).
    for (const side of ['source', 'target']) {
      const other = side === 'source' ? 'target' : 'source';
      const itemId = row[`${side}_id`];
      const otherType = row[`${other}_type`];
      const otherId = row[`${other}_id`];
      if (row[`${side}_type`] !== type || !visible.has(itemId) || !Object.hasOwn(entities, otherType)) continue;
      byItem[itemId].push({ link_id: row.id, type: otherType, id: otherId, relationship_type: row.relationship_type || 'association', notes: row.notes || '' });
      if (!needed.has(otherType)) needed.set(otherType, new Set());
      needed.get(otherType).add(otherId);
    }
  }
  const names = new Map();
  for (const [otherType, otherIds] of needed) {
    for (const row of await listEntities(db, orgId, otherType, [...otherIds])) names.set(`${otherType}:${row.id}`, row.name);
  }
  for (const id of Object.keys(byItem)) {
    const seen = new Set();
    byItem[id] = byItem[id].filter(link => {
      const key = `${link.type}:${link.id}`;
      if (!names.has(key) || seen.has(key)) return false;
      seen.add(key); link.name = names.get(key); return true;
    }).sort((a, b) => a.type.localeCompare(b.type) || String(a.name || '').localeCompare(String(b.name || '')));
  }
  return byItem;
}
function registerLinkRoutes(app, db, requireOrgContext) {
  app.get('/api/linked-record/:type/:id', requireOrgContext, async(req,res)=>res.json(await requireEntity(db,req.orgId,req.params.type,req.params.id)));
  app.get('/api/entity-types', requireOrgContext, (req, res) => res.json(Object.entries(entities).map(([type, def]) => ({ type, label: def.label }))));
  app.get('/api/cross-links/batch/:type', requireOrgContext, async (req, res) => {
    const ids = req.query.ids ? String(req.query.ids).split(',') : [];
    res.json(await linksFor(db, req.orgId, req.params.type, ids));
  });
  app.get('/api/cross-links/:type/:id', requireOrgContext, async (req, res) => {
    await requireEntity(db, req.orgId, req.params.type, req.params.id);
    res.json((await linksFor(db, req.orgId, req.params.type, [req.params.id]))[req.params.id]);
  });
  app.post('/api/cross-links', requireOrgContext, async (req, res) => {
    const { source_type, source_id, target_type, target_id, relationship_type, notes } = req.body;
    const id = await db.transaction(() => addLink(db, req.orgId, source_type, source_id, target_type, target_id, relationship_type, notes));
    res.status(201).json({ success: true, id, link_id: id, relationship_type: relationship_type || 'association' });
  });
  app.delete('/api/cross-links/:id', requireOrgContext, async (req, res) => {
    const result = await db.run('DELETE FROM cross_links WHERE id = ? AND organization_id = ?', positiveId(req.params.id), req.orgId);
    if (!result.changes) throw new HttpError(404, 'Link not found');
    res.json({ success: true });
  });
  app.get('/api/linkable/:type', requireOrgContext, async (req, res) => res.json(await listEntities(db, req.orgId, req.params.type)));
}
module.exports = { entities, definition, positiveId, requireEntity, canonicalLink, addLink, linksFor, listEntities, registerLinkRoutes };
