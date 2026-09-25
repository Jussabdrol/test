const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {installTestDatabase}=require('../support/database');
const db=installTestDatabase();
const {app}=require('../../src/server/app');
const {sphereGraph}=require('../../src/server/services/sphere');
let server,base,org,other,admin,limited,ops,processId,taskId,ticketId,actionId,riskId,foreignId,docId,legacyId;
function session(user,role,organizationId){const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');const b=Buffer.from(JSON.stringify({userId:user,userRole:role,organizationId,activeOrgId:organizationId,sv:0,exp:Date.now()+3600000})).toString('base64url');return 'session_token='+`${h}.${b}.${crypto.createHmac('sha256',process.env.SESSION_SECRET).update(`${h}.${b}`).digest('base64url')}`;}
async function get(path,cookie=admin){const response=await fetch(base+path,{headers:{cookie}});return {status:response.status,body:await response.json(),cache:response.headers.get('cache-control')};}
async function insert(sql,...args){return (await db.run(sql,...args)).lastInsertRowid;}
before(async()=>{
 await db.initDatabase();org=(await db.get('SELECT id FROM organizations LIMIT 1')).id;
 other=await insert("INSERT INTO organizations(name,slug) VALUES ('Other sphere','other-sphere')");
 for(const [role,permissions,label] of [['org_admin','[]','admin'],['viewer','["org"]','limited'],['viewer','["ops"]','ops']]){
  const user=await insert('INSERT INTO users(organization_id,name,email,role,status,permissions) VALUES (?,?,?,?,?,?)',org,label,label+'@sphere.invalid',role,'active',permissions);
  const cookie=session(user,role,org);if(label==='admin')admin=cookie;else if(label==='limited')limited=cookie;else ops=cookie;
 }
 processId=await insert("INSERT INTO org_architecture(organization_id,arch_type,name) VALUES (?,'process','Security')",org);
 const role=await insert("INSERT INTO org_architecture(organization_id,arch_type,name,parent_id) VALUES (?,'role','Control owner',?)",org,processId);
 legacyId=await insert("INSERT INTO org_architecture(organization_id,arch_type,name) VALUES (?,'ai_usecase','Legacy AI design')",org);
 taskId=await insert("INSERT INTO tasks(organization_id,title,category,assignee,recurrence,start_date,next_due) VALUES (?,'Access review','Security','Control owner','monthly','2026-01-01','2026-10-01')",org);
 ticketId=await insert("INSERT INTO task_instances(organization_id,task_id,scheduled_date) VALUES (?,?,'2026-09-01')",org,taskId);
 actionId=await insert("INSERT INTO actions(organization_id,title,task_id,instance_id,process_id) VALUES (?,'Remove account',?,?,?)",org,taskId,ticketId,processId);
 riskId=await insert("INSERT INTO risks(organization_id,title,description) VALUES (?,'Access risk','Private risk description')",org);
 foreignId=await insert("INSERT INTO risks(organization_id,title) VALUES (?,'FOREIGN SECRET')",other);
 docId=await insert("INSERT INTO documents(organization_id,title,description,linked_ref_type,linked_ref_id) VALUES (?,'Access policy','<img src=x onerror=alert(1)>','risk',?)",org,riskId);
 await insert("INSERT INTO cross_links(organization_id,source_type,source_id,target_type,target_id,relationship_type,notes) VALUES (?,'process',?,'risk',?,'influence','Real saved relationship')",org,processId,riskId);
 await insert("INSERT INTO cross_links(organization_id,source_type,source_id,target_type,target_id) VALUES (?,'process',?,'risk',?)",org,processId,foreignId);
 await insert("INSERT INTO cross_links(organization_id,source_type,source_id,target_type,target_id) VALUES (?,'__proto__',1,'process',?)",org,processId);
 const usecase=await insert("INSERT INTO use_cases(organization_id,title) VALUES (?,'AI governance record')",org);
 await insert("INSERT INTO cross_links(organization_id,source_type,source_id,target_type,target_id) VALUES (?,'ai_usecase',?,'role',?)",org,usecase,role);
 await insert("INSERT INTO suppliers(organization_id,name,metadata) VALUES (?,'Supplier',?)",org,JSON.stringify({arch_links:[{type:'process',id:processId},null,{type:'risk',id:foreignId}]}));
 await insert("INSERT INTO suppliers(organization_id,name,metadata) VALUES (?,'Malformed','not-json')",org);
 await insert("INSERT INTO plan_bundles(organization_id,name,process_ids) VALUES (?,'Programme',?)",org,JSON.stringify([processId]));
 const requirement=await insert("INSERT INTO standard_requirements(organization_id,standard,clause,title) VALUES (?,'ISO 27001','5','Access')",org);
 await insert("INSERT INTO soa_entries(organization_id,requirement_id,linked_processes) VALUES (?,?,?)",org,requirement,JSON.stringify([processId]));
 await insert("INSERT INTO risk_treatments(organization_id,risk_id,requirement_id,description) VALUES (?,?,?,'Quarterly check')",org,riskId,requirement);
 await insert("INSERT INTO org_kpis(organization_id,name,process_id) VALUES (?,'Coverage',?)",org,processId);
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await db.close();});
test('Sphere exposes saved explicit, structural, legacy and planning relationships without generating tickets',async()=>{
 const before=(await db.get('SELECT COUNT(*)::int AS n FROM task_instances')).n;
 const {status,body,cache}=await get('/api/sphere');assert.equal(status,200,JSON.stringify(body));assert.equal(cache,'no-store');
 const keys=new Set(body.nodes.map(node=>node.key));assert.equal(keys.size,body.nodes.length);
 for(const label of ['influence','Control series','Control ticket','Process','Parent','Document reference','Supplier architecture','Contains process','SoA process','Treats risk','Requirement','Planning process','Assigned role'])assert.ok(body.edges.some(edge=>edge.label===label),label);
 assert.ok(body.nodes.some(node=>node.key===`arch_ai_usecase:${legacyId}`));
 assert.ok(!body.nodes.some(node=>node.type==='ai_usecase'));
 assert.ok(body.edges.some(edge=>edge.source.startsWith('usecase:')));
 assert.ok(body.nodes.find(node=>node.key===`instance:${ticketId}`).name.includes('Access review'));
 for(const edge of body.edges){assert.ok(keys.has(edge.source)&&keys.has(edge.target));if(edge.origin==='cross_link')assert.equal(edge.directed,false);}
 assert.ok(!JSON.stringify(body).includes('FOREIGN SECRET'));assert.ok(!keys.has(`risk:${foreignId}`));
 assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM task_instances')).n,before);
});
test('Sphere filters both endpoints and details by current module access and tenant',async()=>{
 const {body,status}=await get('/api/sphere',limited);assert.equal(status,200);
 assert.ok(body.nodes.some(node=>node.type==='process'));assert.ok(!body.nodes.some(node=>['risk','requirement','treatment'].includes(node.type)));
 assert.ok(!JSON.stringify(body).includes('Access risk'));assert.ok(!body.edges.some(edge=>edge.source.startsWith('risk:')||edge.target.startsWith('risk:')));
 assert.equal((await get(`/api/sphere/record/risk/${riskId}`,limited)).status,403);
 assert.equal((await get(`/api/sphere/record/risk/${foreignId}`)).status,404);
 assert.equal((await get('/api/sphere',ops)).status,403);
 assert.equal((await get('/api/sphere','')).status,401);
 assert.equal((await get('/api/sphere/record/__proto__/1')).status,400);
 assert.equal((await get('/api/sphere/record/process/1e2')).status,400);
 assert.equal((await get(`/api/sphere/record/arch_ai_usecase/${legacyId}`)).body.name,'Legacy AI design');
 assert.equal((await get(`/api/sphere/record/document/${docId}`)).body.description,'<img src=x onerror=alert(1)>');
});
test('graph query count is bounded by registries, not record count; ambiguous names never create links',async()=>{
 await insert("INSERT INTO org_architecture(organization_id,arch_type,name) VALUES (?,'process','Security')",org);
 await db.run("INSERT INTO org_architecture(organization_id,arch_type,name) SELECT ?,'asset','Synthetic asset ' || generate_series(1,1200)",org);
 let queries=0;const tracked={all:async(...args)=>{queries++;return db.all(...args);}};
 const graph=await sphereGraph(tracked,org,()=>true);assert.ok(graph.nodes.length>1200);assert.ok(queries<35,`queries=${queries}`);
 assert.ok(!graph.edges.some(edge=>edge.source===`task:${taskId}`&&edge.label==='Planning process'));
});
test('My Tasks is a safe landing page for risk-only, audit-only and no-module accounts',async()=>{
 for(const permission of ['risk','audit','']){
  const user=await insert('INSERT INTO users(organization_id,name,email,role,status,permissions) VALUES (?,?,?,?,?,?)',org,'Landing tester','landing-'+permission+'@sphere.invalid','viewer','active',JSON.stringify(permission?[permission]:[]));
  const cookie=session(user,'viewer',org);
  await db.run("UPDATE tasks SET assignee='Landing tester' WHERE id=?",taskId);
  await db.run("UPDATE risk_treatments SET responsible='Landing tester' WHERE risk_id=?",riskId);
  const audit=await insert("INSERT INTO audits(organization_id,title,lead_auditor) VALUES (?,'Personal audit','Landing tester')",org);
  const result=await get('/api/my-tasks',cookie);assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.tasks.length,0);assert.equal(result.body.actions.length,0);assert.equal(result.body.mgmtOutputs.length,0);
  assert.equal(result.body.treatments.length,permission==='risk'?1:0);
  assert.ok(permission==='audit'?result.body.audits.some(row=>row.id===audit):result.body.audits.length===0);
  assert.equal((await get('/api/sphere',cookie)).status,403);
 }
 assert.equal((await get('/api/my-tasks','')).status,401);
});
