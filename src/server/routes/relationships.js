const { requireEntity, listEntities, linksFor } = require('../services/entities');
// [child entity, parent entity, foreign-key column]
const relationships = [
  ['action','task','task_id'], ['action','instance','instance_id'], ['action','process','process_id'],
  ['instance','task','task_id'], ['checklist','audit','audit_id'],
  ['ncr','audit','audit_id'], ['ncr','checklist','checklist_item_id'],
  ['treatment','risk','risk_id'], ['treatment','requirement','requirement_id'],
  ['kpi','process','process_id'], ['review_output','management_review','review_id'],
  ['review_output','action','linked_action_id'], ['threat','risk','created_risk_id'],
];
const { definition } = require('../services/entities');
async function relatedItems(db, orgId, type, id) {
  await requireEntity(db, orgId, type, id);
  const result = (await linksFor(db, orgId, type, [id]))[id] || [];
  const seen = new Set(result.map(row => `${row.type}:${row.id}`));
  for (const [child,parent,column] of relationships) {
    if (type !== child && type !== parent) continue;
    const childTable = definition(child).table;
    const otherType = type === child ? parent : child;
    const rows = type === child
      ? await db.all(`SELECT ${column} AS id FROM ${childTable} WHERE organization_id = ? AND id = ? AND ${column} IS NOT NULL`, orgId,id)
      : await db.all(`SELECT id FROM ${childTable} WHERE organization_id = ? AND ${column} = ?`,orgId,id);
    for (const row of await listEntities(db, orgId, otherType, rows.map(row=>row.id))) {
      const key = `${otherType}:${row.id}`;
      if (!seen.has(key)) { result.push({...row,type:otherType,link_id:null,read_only:true}); seen.add(key); }
    }
  }
  async function include(otherType, otherId) {
    if (!Object.hasOwn(require('../services/entities').entities, otherType) || !/^[1-9]\d*$/.test(String(otherId))) return;
    const key = `${otherType}:${otherId}`;
    if (seen.has(key)) return;
    const [row] = await listEntities(db, orgId, otherType, [otherId]);
    if (row) { result.push({ ...row, type: otherType, link_id: null, read_only: true }); seen.add(key); }
  }
  function array(value) { try { const parsed=JSON.parse(value||'[]'); return Array.isArray(parsed)?parsed:[]; } catch { return []; } }
  // Existing document-control and supplier metadata relations remain visible.
  if (type === 'document') {
    const document = await db.get('SELECT linked_ref_type, linked_ref_id FROM documents WHERE id=? AND organization_id=?', id,orgId);
    if (document.linked_ref_id) await include(document.linked_ref_type,document.linked_ref_id);
  }
  for (const document of await db.all('SELECT id FROM documents WHERE organization_id=? AND linked_ref_type=? AND linked_ref_id=?',orgId,type,id)) await include('document',document.id);
  if (type === 'supplier' || ['role','process','system','asset','facility','ai_model','ai_dataset'].includes(type)) {
    const suppliers = type === 'supplier'
      ? await db.all('SELECT id, metadata FROM suppliers WHERE id=? AND organization_id=?',id,orgId)
      : await db.all('SELECT id, metadata FROM suppliers WHERE organization_id=?',orgId);
    for (const supplier of suppliers) {
      let metadata; try {metadata=JSON.parse(supplier.metadata||'{}');} catch {continue;}
      for (const link of Array.isArray(metadata.arch_links)?metadata.arch_links:[]) {
        if (type === 'supplier') await include(link.type,link.id);
        else if(link.type===type&&Number(link.id)===Number(id)) await include('supplier',supplier.id);
      }
    }
  }
  if(type==='requirement'||type==='process'){
    const rows=await db.all('SELECT requirement_id, linked_processes FROM soa_entries WHERE organization_id=?',orgId);
    for(const row of rows){
      const processes=array(row.linked_processes);
      if(type==='requirement'&&row.requirement_id===Number(id)) for(const processId of processes) await include('process',processId);
      if(type==='process'&&processes.some(processId=>Number(processId)===Number(id))) await include('requirement',row.requirement_id);
    }
  }
  if (type === 'plan_bundle' || type === 'process') {
    const bundles = await db.all('SELECT id, process_ids FROM plan_bundles WHERE organization_id=?',orgId);
    for (const bundle of bundles) {
      const ids = array(bundle.process_ids);
      if (type === 'plan_bundle' && bundle.id === Number(id)) for (const process of ids) await include('process',process);
      if (type === 'process' && ids.some(value=>Number(value)===Number(id))) await include('plan_bundle',bundle.id);
    }
  }
  return result.sort((a,b)=>a.type.localeCompare(b.type) || String(a.name || '').localeCompare(String(b.name || '')));
}
function registerRelationships(app,db,requireOrgContext) {
  app.get('/api/relations/:type/:id',requireOrgContext,async(req,res)=>res.json(await relatedItems(db,req.orgId,req.params.type,req.params.id)));
}
module.exports={ relatedItems,registerRelationships };
