const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { installTestDatabase } = require('../support/database');
const db = installTestDatabase();
process.env.SESSION_SECRET = 'isolated-test-session-secret';
const { app, executeAgentTool } = require('../../src/server/app');
let server, base, org, otherOrg, cookie, csrfToken;
function token(payload) {
  const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const b=Buffer.from(JSON.stringify({...payload,exp:Date.now()+3600000})).toString('base64url');
  return `${h}.${b}.${crypto.createHmac('sha256',process.env.SESSION_SECRET).update(`${h}.${b}`).digest('base64url')}`;
}
async function api(path, method='GET', body) {
  const response=await fetch(base+path,{method,headers:{cookie,'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
}
async function create(path,body) {const r=await api(path,'POST',body);assert.equal(r.status,201,JSON.stringify(r.body));return r.body;}
before(async()=>{
  await db.initDatabase();
  org=(await db.get('SELECT id FROM organizations LIMIT 1')).id;
  otherOrg=(await db.run("INSERT INTO organizations(name,slug) VALUES ('Other','other')")).lastInsertRowid;
  const user=(await db.run("INSERT INTO users(organization_id,name,email,role,status) VALUES (?,'Test','test@example.invalid','org_admin','active')",org)).lastInsertRowid;
  cookie='session_token='+token({userId:user,userRole:'org_admin',activeOrgId:org,organizationId:org,sv:0});
  server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});base=`http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base+'/health',{headers:{cookie}});
  const csrfCookie = response.headers.getSetCookie().find(value=>value.startsWith('csrf_token=')).split(';')[0];
  csrfToken = decodeURIComponent(csrfCookie.slice('csrf_token='.length));
  cookie += '; '+csrfCookie;
});
after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await db.close();});

test('browser entry points and locally referenced assets survive source relocation', async () => {
  const anonymous = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(anonymous.status, 200);
  assert.match(await anonymous.text(), /Your ISO work/);
  const consolePage = await fetch(base + '/console', { redirect: 'manual' });
  assert.equal(consolePage.status, 302);
  assert.equal(consolePage.headers.get('location'), '/login');
  const login = await fetch(base + '/login');
  assert.equal(login.status, 200);
  assert.match(await login.text(), /<html/);
  const page = await fetch(base + '/console', { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="([^"#]+\.(?:js|mjs|css))"/g)]
    .map(match => match[1]).filter(url => !url.startsWith('http'));
  assert.ok(assets.includes('/app.js'));
  for (const asset of assets) {
    const result = await fetch(new URL(asset, base + '/'), { headers: { cookie } });
    assert.equal(result.status, 200, asset);
    assert.match(result.headers.get('content-type'), /javascript|css/, asset);
    assert.ok((await result.text()).length > 0, asset);
  }
});

test('production schema supports all registered module types',async()=>{
  const types=(await api('/api/entity-types')).body;
  assert.ok(types.some(t=>t.type==='ai_model'));
  assert.ok(types.some(t=>t.type==='instance'));
  for(const {type} of types)assert.equal((await api(`/api/linkable/${type}`)).status,200,type);
});
test('implicit, explicit and nested queries roll back together; effects do not escape rollback',async()=>{
  let called=false;
  await assert.rejects(db.transaction(async tx=>{
    await tx.run("INSERT INTO risks(organization_id,title) VALUES (?,'rollback-explicit')",org);
    await db.transaction(()=>db.run("INSERT INTO risks(organization_id,title) VALUES (?,'rollback-nested')",org));
    db.deferUntilCommit(()=>{called=true;});
    throw Error('rollback');
  }),/rollback/);
  assert.equal((await db.get("SELECT COUNT(*)::int AS c FROM risks WHERE title LIKE 'rollback-%'")).c,0);
  assert.equal(called,false);
});
test('same-type links are visible at both ends, preserve semantics and isolate organizations',async()=>{
  const a=await create('/api/risks',{title:'Risk A'}),b=await create('/api/risks',{title:'Risk B'});
  const link={source_type:'risk',source_id:a.id,target_type:'risk',target_id:b.id,relationship_type:'influence',notes:'Risk propagation'};
  const responses=await Promise.all([api('/api/cross-links','POST',link),api('/api/cross-links','POST',{...link,source_id:b.id,target_id:a.id})]);
  for(const r of responses)assert.equal(r.status,201,JSON.stringify(r.body));
  assert.equal(responses[0].body.id,responses[1].body.id);
  const batch=(await api(`/api/cross-links/batch/risk?ids=${a.id},${b.id}`)).body;
  assert.equal(batch[a.id][0].relationship_type,'influence');assert.equal(batch[b.id][0].id,a.id);
  assert.equal((await api('/api/cross-links','POST',{...link,relationship_type:'association'})).status,409);
  const foreign=(await db.run("INSERT INTO risks(organization_id,title) VALUES (?,'private')",otherOrg)).lastInsertRowid;
  assert.equal((await api('/api/cross-links','POST',{...link,target_id:foreign})).status,404);
  assert.equal((await api('/api/cross-links','POST',{...link,target_id:a.id})).status,400);
  // Legacy bad data cannot reveal another organization's record name.
  await db.run("INSERT INTO cross_links(organization_id,source_type,source_id,target_type,target_id) VALUES (?,'risk',?,'risk',?)",org,a.id,foreign);
  assert.equal((await api(`/api/cross-links/risk/${a.id}`)).body.length,1);
});
test('parallel task completion advances only the expected occurrence and retains monthly anchor',async()=>{
  const task=await create('/api/tasks',{title:'Monthly control',recurrence:'monthly',start_date:'2026-01-31',day_of_week:0});
  assert.equal(task.day_of_week,0);
  const rs=await Promise.all([api(`/api/tasks/${task.id}/complete`,'POST',{expected_due:'2026-01-31'}),api(`/api/tasks/${task.id}/complete`,'POST',{expected_due:'2026-01-31'})]);
  assert.deepEqual(rs.map(r=>r.status).sort(),[200,409]);
  assert.equal((await db.get('SELECT next_due FROM tasks WHERE id=?',task.id)).next_due,'2026-02-28');
  assert.equal((await db.get('SELECT COUNT(*)::int AS c FROM task_instances WHERE task_id=?',task.id)).c,1);
  assert.equal((await api(`/api/tasks/${task.id}/complete`,'POST',{expected_due:'2026-02-28'})).body.next_due,'2026-03-31');
});
test('instance completion is repeat-safe and action references must match the instance task',async()=>{
  const task=await create('/api/tasks',{title:'Instance task',start_date:'2026-09-15'});
  const id=(await db.run("INSERT INTO task_instances(organization_id,task_id,scheduled_date) VALUES (?,?,'2026-09-15')",org,task.id)).lastInsertRowid;
  const rs=await Promise.all([api(`/api/task-instances/${id}/complete`,'POST',{}),api(`/api/task-instances/${id}/complete`,'POST',{})]);
  assert.deepEqual(rs.map(r=>r.status).sort(),[200,409]);
  const action=await create('/api/actions',{title:'Follow-up',instance_id:id});assert.equal(action.task_id,task.id);
  const task2=await create('/api/tasks',{title:'Other task',start_date:'2026-09-15'});
  assert.equal((await api('/api/actions','POST',{title:'Wrong task',instance_id:id,task_id:task2.id})).status,400);
  const relations=(await api(`/api/relations/instance/${id}`)).body;
  assert.ok(relations.some(r=>r.type==='action'&&r.id===action.id&&r.read_only));
  assert.ok(relations.some(r=>r.type==='task'&&r.id===task.id));
});
test('parallel review promotion creates one action; action state feeds back to the decision',async()=>{
  const review=await create('/api/management-reviews',{title:'Quarterly',review_date:'2026-09-15'});
  const output=await create(`/api/management-reviews/${review.id}/outputs`,{description:'Improve controls'});
  const path=`/api/management-reviews/${review.id}/outputs/${output.id}/push-to-actions`;
  const rs=await Promise.all([api(path,'POST',{}),api(path,'POST',{})]);
  for(const r of rs)assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(rs[0].body.action_id,rs[1].body.action_id);
  const id=rs[0].body.action_id;
  await api(`/api/actions/${id}`,'PUT',{status:'resolved'});
  assert.equal((await db.get('SELECT status FROM management_review_outputs WHERE id=?',output.id)).status,'completed');
  await api(`/api/actions/${id}`,'PUT',{status:'open'});
  assert.equal((await db.get('SELECT status FROM management_review_outputs WHERE id=?',output.id)).status,'open');
  assert.equal((await db.get('SELECT resolved_at FROM actions WHERE id=?',id)).resolved_at,null);
  assert.ok((await api(`/api/relations/action/${id}`)).body.some(r=>r.type==='review_output'&&r.id===output.id));
});
test('changing an audit rating preserves NCR corrective work and evidence',async()=>{
  const audit=await create('/api/audits',{title:'Audit',planned_date:'2026-09-15'});
  const item=await create(`/api/audits/${audit.id}/checklist`,{clause:'1',requirement:'Control'});
  assert.equal((await api(`/api/checklist/${item.id}`,'PUT',{rating:'minor_nc',finding:'Finding'})).status,200);
  const ncr=await db.get('SELECT * FROM non_conformities WHERE checklist_item_id=?',item.id);
  await db.run("UPDATE non_conformities SET corrective_action='Work in progress' WHERE id=?",ncr.id);
  await api(`/api/checklist/${item.id}`,'PUT',{rating:'conforming'});
  assert.equal((await db.get('SELECT corrective_action FROM non_conformities WHERE id=?',ncr.id)).corrective_action,'Work in progress');
});
test('relationships validate IDs, hierarchy cycles and zero KPI targets',async()=>{
  const process=await create('/api/architecture',{arch_type:'process',name:'Control process'});
  assert.equal((await api(`/api/architecture/${process.id}`,'PUT',{parent_id:process.id})).status,400);
  const kpi=await create('/api/kpis',{name:'Open findings',process_id:process.id,target_value:0});assert.equal(kpi.target_value,0);
  assert.equal((await api('/api/actions','POST',{title:'Invalid',process_id:999999})).status,404);
  assert.equal((await api('/api/kpis/999999/values','POST',{value:3,period:'2026-09'})).status,404);
  assert.equal((await api('/api/cross-links/batch/risk?ids=-1')).status,400);
  assert.equal((await api('/api/no-such-endpoint')).status,404);
});
test('AI use case gates and team histories remain inside their organization',async()=>{
  const uc=await create('/api/use-cases',{title:'Governed AI use case'});
  assert.equal((await api(`/api/use-cases/${uc.id}`,'PUT',{status:'production'})).status,422);
  const foreign=(await db.run("INSERT INTO use_cases(organization_id,title) VALUES (?,'Private AI')",otherOrg)).lastInsertRowid;
  const foreignUser=(await db.run("INSERT INTO users(organization_id,name,email) VALUES (?,'Other member','other@example.invalid')",otherOrg)).lastInsertRowid;
  for(const suffix of ['members','approvals']) {
    assert.equal((await api(`/api/use-cases/${foreign}/${suffix}`)).status,404);
    assert.equal((await api(`/api/use-cases/${foreign}/${suffix}`,'POST',{user_id:foreignUser,decision:'approved'})).status,404);
  }
  assert.equal((await api(`/api/use-cases/${uc.id}/members`,'POST',{user_id:foreignUser})).status,404);
  assert.equal((await api(`/api/use-cases/${uc.id}`,'PUT',{owner_id:foreignUser})).status,404);
});
test('overview and production module entry points return valid JSON',async()=>{
  for(const path of ['/api/dashboard','/api/meta','/api/tasks','/api/task-instances','/api/actions','/api/plan-bundles','/api/audits','/api/ncrs','/api/requirements','/api/threat-feeds','/api/threat-items','/api/risks','/api/treatments','/api/soa','/api/mission','/api/kpis','/api/kpis/auto','/api/architecture','/api/use-cases','/api/documents','/api/suppliers','/api/management-reviews','/api/compliance-overview']) {
    const r=await api(path);assert.equal(r.status,200,path+': '+JSON.stringify(r.body));
  }
  const overview=(await api('/api/compliance-overview')).body;
  assert.ok(overview.attention.every(r=>r.title!=='private'&&r.title!=='Private AI'));
  assert.ok(overview.modules.some(m=>m.type==='usecase'));
});
test('AI assistant shares task, checklist and action workflows with the interface',async()=>{
  assert.ok(Object.hasOwn(await executeAgentTool('get_dashboard_summary',{},org),'overdue_tasks'));
  const task=await create('/api/tasks',{title:'AI completion',recurrence:'custom',custom_days:3,start_date:'2026-09-15'});
  const result=await executeAgentTool('complete_task',{task_id:task.id,expected_due:task.next_due},org);
  assert.equal(result.next_due,'2026-09-18');assert.ok(result.instance_id);
  await assert.rejects(executeAgentTool('complete_task',{task_id:task.id,expected_due:task.next_due},org),e=>e.status===409);
  const audit=await create('/api/audits',{title:'AI checklist',planned_date:'2026-09-15'});
  const item=await create(`/api/audits/${audit.id}/checklist`,{clause:'2'});
  await executeAgentTool('rate_checklist_item',{checklist_id:item.id,rating:'major_nc'},org);
  const ncr=await db.get('SELECT * FROM non_conformities WHERE checklist_item_id=?',item.id);assert.equal(ncr.severity,'major');
  await executeAgentTool('rate_checklist_item',{checklist_id:item.id,rating:'conforming'},org);
  assert.ok(await db.get('SELECT id FROM non_conformities WHERE id=?',ncr.id));
  const action=await create('/api/actions',{title:'AI action'});
  await executeAgentTool('update_action',{action_id:action.id,status:'resolved'},org);
  await executeAgentTool('update_action',{action_id:action.id,status:'open'},org);
  assert.equal((await db.get('SELECT resolved_at FROM actions WHERE id=?',action.id)).resolved_at,null);
});
test('Excel and Word document conversion still produce usable files after dependency updates',async()=>{
  const XLSX=require('xlsx');const sheet=XLSX.utils.aoa_to_sheet([['Control','Score'],['Access review',0]]);
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'Controls');
  const result=XLSX.read(XLSX.write(book,{type:'buffer',bookType:'xlsx'}),{type:'buffer'});
  assert.equal(XLSX.utils.sheet_to_json(result.Sheets.Controls)[0].Score,0);
  const bytes=await require('../../src/server/services/document-conversion').convertToDocx('<h1>Control report</h1><p>Evidence retained.</p>');
  const parsed=await require('mammoth').extractRawText({buffer:Buffer.from(bytes)});
  assert.match(parsed.value,/Control report/);assert.match(parsed.value,/Evidence retained/);
});


test('CSRF rejects missing, forged and session-mismatched tokens without writes', async () => {
  const before = await db.get('SELECT COUNT(*)::int AS count FROM risks');
  const sessionCookie = cookie.split(';')[0];
  for (const headers of [
    {cookie},
    {cookie, 'X-CSRF-Token':'forged'},
    {cookie: sessionCookie+'; csrf_token=forged', 'X-CSRF-Token':'forged'},
    {cookie:'session_token=different; csrf_token='+csrfToken, 'X-CSRF-Token':csrfToken},
  ]) {
    const response=await fetch(base+'/api/risks',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({title:'forged request'})});
    assert.equal(response.status,403);
  }
  assert.deepEqual(await db.get('SELECT COUNT(*)::int AS count FROM risks'),before);
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(login.status,403);
});

test('prepared statements keep SQL-looking values separate from query text', async () => {
  const value="x'); DROP TABLE risks; --";
  await db.transaction(async()=>{
    const row=await db.prepare('INSERT INTO risks(organization_id,title) VALUES (?,?)').run(org,value);
    assert.equal((await db.prepare('SELECT title FROM risks WHERE id=?').get([row.lastInsertRowid])).title,value);
    assert.equal((await db.prepare('SELECT title FROM risks WHERE title=?').all(value))[0].title,value);
    await db.prepare('DELETE FROM risks WHERE id=?').run([row.lastInsertRowid]);
  });
});

test('browser login rotates the CSRF token and allows the next protected request', async () => {
  const password=crypto.randomBytes(24).toString('hex');
  const hash=await require('bcryptjs').hash(password,4);
  await db.run('UPDATE users SET password=? WHERE email=?',hash,'test@example.invalid');
  const page=await fetch(base+'/login');
  const jar=new Map(page.headers.getSetCookie().map(c=>c.split(';')[0].split('=')));
  const anonymousToken=decodeURIComponent(jar.get('csrf_token'));
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),'Content-Type':'application/json','X-CSRF-Token':anonymousToken},body:JSON.stringify({email:'test@example.invalid',password})});
  assert.equal(login.status,200,await login.text());
  for(const c of login.headers.getSetCookie()){const [key,value]=c.split(';')[0].split('=');jar.set(key,value);}
  const signedToken=decodeURIComponent(jar.get('csrf_token'));
  assert.notEqual(signedToken,anonymousToken);
  const created=await fetch(base+'/api/risks',{method:'POST',headers:{cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),'Content-Type':'application/json','X-CSRF-Token':signedToken},body:JSON.stringify({title:'Login session check'})});
  assert.equal(created.status,201);
  await db.run('DELETE FROM risks WHERE id=?',(await created.json()).id);
});

test('deployment health checks the database and fails closed without error details', async () => {
  const healthy=await api('/health');
  assert.equal(healthy.status,200);
  assert.equal(healthy.body.database,'ready');
  const original=db.get;
  db.get=async sql=>{assert.equal(sql,'SELECT 1 AS ready');throw Error('private connection details');};
  try {
    const failed=await api('/health');
    assert.equal(failed.status,503);
    assert.deepEqual(failed.body,{status:'unavailable',database:'unavailable'});
  } finally {db.get=original;}
});

test('security: tenant admins cannot promote users to platform roles', async () => {
  const member=(await db.run("INSERT INTO users(organization_id,name,email,role,status) VALUES (?,'Member','restricted@example.invalid','org_user','active')",org)).lastInsertRowid;
  const result=await api(`/api/admin/users/${member}`,'PUT',{role:'superadmin'});
  assert.equal(result.status,400);
  assert.equal((await db.get('SELECT role FROM users WHERE id=?',member)).role,'org_user');
  assert.equal((await api(`/api/admin/users/${member}`,'PUT',{role:'org_admin'})).status,200);
  await db.run('DELETE FROM users WHERE id=?',member);
});

async function restrictedClient(role='org_user',perms=[]) {
  const email=crypto.randomUUID()+'@example.invalid';
  const id=(await db.run('INSERT INTO users(organization_id,name,email,role,status,permissions) VALUES (?, ?, ?, ?, ?, ?)',org,'Restricted',email,role,'active',JSON.stringify(perms))).lastInsertRowid;
  let jar='session_token='+token({userId:id,userRole:role,organizationId:org,activeOrgId:org,sv:0});
  const initial=await fetch(base+'/health',{headers:{cookie:jar}});
  const csrf=initial.headers.getSetCookie().find(v=>v.startsWith('csrf_token=')).split(';')[0];
  jar+='; '+csrf;
  return {id,request:async(path,method='GET',body)=>{
    const r=await fetch(base+path,{method,headers:{cookie:jar,'Content-Type':'application/json','X-CSRF-Token':decodeURIComponent(csrf.slice(11))},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  }};
}
test('security: permissions cover direct APIs and cross-module references',async()=>{
  const member=await restrictedClient();
  for(const route of ['/api/risks','/api/audits','/api/mission','/api/tasks','/api/linkable/risk']) assert.equal((await member.request(route)).status,403,route);
  assert.equal((await member.request('/api/risks','POST',{title:'Forbidden'})).status,403);
  const riskUser=await restrictedClient('org_user',['risk']);
  assert.equal((await riskUser.request('/api/risks')).status,200);
  assert.equal((await riskUser.request('/api/mission')).status,403);
  const types=await riskUser.request('/api/entity-types');
  assert.ok(types.body.some(t=>t.type==='risk'));assert.ok(!types.body.some(t=>t.type==='process'));
  const overview=await riskUser.request('/api/compliance-overview');
  assert.ok(overview.body.modules.every(m=>['risk','treatment','threat','requirement','soa','document'].includes(m.type)));
  const viewer=await restrictedClient('viewer',['risk']);
  assert.equal((await viewer.request('/api/risks')).status,200);
  assert.equal((await viewer.request('/api/risks','POST',{title:'Forbidden'})).status,403);
});
test('combined release: planning outcomes remain writable only by authorized operators and overview respects module permissions',async()=>{
  const task=await create('/api/tasks',{title:'Authorized planning control',assignee:'Control owner',start_date:'2026-01-01',recurrence:'monthly'});
  const operator=await restrictedClient('org_user',['ops']);
  const executions=await operator.request(`/api/task-instances?task_id=${task.id}&from=2026-01-01&to=2026-01-01`);
  assert.equal(executions.status,200);
  assert.equal(executions.body.length,1);
  const execution=executions.body[0];
  const overview=await operator.request('/api/compliance-overview');
  assert.equal(overview.status,200);
  assert.ok(overview.body.modules.every(m=>['task','instance','action','document'].includes(m.type)));
  assert.ok(overview.body.attention.some(row=>row.type==='instance' && row.id===execution.id && row.title===task.title && row.owner==='Control owner'));
  const viewer=await restrictedClient('viewer',['ops']);
  assert.equal((await viewer.request('/api/yearly?year=2026')).status,200);
  for(const action of ['complete','skip','reopen']) {
    assert.equal((await viewer.request(`/api/task-instances/${execution.id}/${action}`,'POST',{})).status,403);
  }
  assert.equal((await db.get('SELECT status FROM task_instances WHERE id=?',execution.id)).status,'pending');
  assert.equal((await operator.request(`/api/task-instances/${execution.id}/complete`,'POST',{notes:'Reviewed'})).status,200);
  const plan=await operator.request('/api/yearly?year=2026');
  assert.equal(plan.body.completedDates['2026-01-01'].find(row=>row.task_id===task.id).instance_id,execution.id);
  assert.equal((await operator.request('/api/risks')).status,403);
});
test('security: deactivation, expiry, role changes and revocation invalidate existing sessions',async()=>{
  for(const [field,value] of [['status','suspended'],['role','org_admin'],['expiry_date','2020-01-01'],['session_version',1]]){
    const member=await restrictedClient('org_user',['risk']);
    await db.run(`UPDATE users SET ${field}=? WHERE id=?`,value,member.id);
    assert.equal((await member.request('/api/risks')).status,401,field);
    assert.equal((await member.request('/api/auth/check')).body.authenticated,false,field);
  }
  const member=await restrictedClient('org_user',['risk']);
  await db.run('UPDATE organizations SET is_active=0 WHERE id=?',org);
  try{assert.equal((await member.request('/api/risks')).status,401);}
  finally{await db.run('UPDATE organizations SET is_active=1 WHERE id=?',org);}
});
test('security: legacy SAML cannot be enabled and seeded passwords do not exist',async()=>{
  assert.equal((await api('/api/admin/saml/config','PUT',{enabled:1})).status,503);
  assert.equal((await api('/api/admin/saml/config')).body.enabled,0);
  assert.equal((await db.get("SELECT count(*)::int AS n FROM users WHERE email IN ('superadmin@lettheframework.local','admin@lettheframework.local')")).n,0);
});

test('website exposes only public product content and keeps checkout unavailable', async () => {
  for (const path of ['/start','/welcome','/brand.css','/website/style.css','/website.js']) {
    assert.equal((await fetch(base+path)).status,200,path);
  }
  const catalog=await (await fetch(base+'/api/commerce/catalog')).json();
  assert.equal(catalog.enabled,false);assert.equal(catalog.monthly,14900);assert.equal(catalog.yearly,149000);
  assert.deepEqual(await (await fetch(base+'/api/commerce/status')).json(),{status:'unavailable'});
  assert.equal((await fetch(base+'/billing',{redirect:'manual'})).headers.get('location'),'/login');
  assert.equal((await fetch(base+'/api/tasks')).status,401);
  assert.equal((await fetch(base+'/api/commerce/checkout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
});
