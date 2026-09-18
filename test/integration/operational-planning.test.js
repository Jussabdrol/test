const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { installTestDatabase } = require('../support/database');
const db = installTestDatabase();
process.env.SESSION_SECRET = 'isolated-test-session-secret';
const { app } = require('../../src/server/app');
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


async function instance(task, date, status = 'pending') {
  return (await db.run("INSERT INTO task_instances(organization_id,task_id,scheduled_date,status) VALUES (?,?,?,?)",org,task.id,date,status)).lastInsertRowid;
}
test('yearly plan tracks outcomes by scheduled date, including late and skipped executions', async () => {
  const task = await create('/api/tasks',{title:'Late monthly review',start_date:'2026-01-31',recurrence:'monthly'});
  const late = await instance(task,'2026-01-31','completed');
  await db.run("UPDATE task_instances SET completed_at='2026-02-03T12:00:00Z' WHERE id=?",late);
  await instance(task,'2026-02-28','skipped');
  const plan = (await api('/api/yearly?year=2026')).body;
  assert.equal(plan.dueDates['2026-01-31'].find(t=>t.task_id===task.id).status,'completed');
  assert.equal(plan.dueDates['2026-02-28'].find(t=>t.task_id===task.id).status,'skipped');
  assert.equal(plan.completedDates['2026-01-31'].find(t=>t.task_id===task.id).instance_id,late);
  assert.match(plan.completedDates['2026-01-31'].find(t=>t.task_id===task.id).completed_at,/2026-02-03/);
});
test('date-filtered task log materializes the selected occurrence and fills holes before a future completion', async () => {
  const task=await create('/api/tasks',{title:'Exact selected occurrence',start_date:'2026-01-01',recurrence:'monthly'});
  await instance(task,'2026-04-01','completed');
  const result=await api(`/api/task-instances?task_id=${task.id}&from=2026-03-01&to=2026-03-01`);
  assert.equal(result.status,200);
  assert.equal(result.body.length,1);
  assert.equal(result.body[0].scheduled_date,'2026-03-01');
  assert.equal((await api(`/api/task-instances/${result.body[0].id}/complete`,'POST',{})).status,200);
  assert.equal((await db.get('SELECT next_due FROM tasks WHERE id=?',task.id)).next_due,'2026-01-01');
});
test('out-of-order completion skips finished occurrences and reopen restores the oldest due date', async () => {
  const task=await create('/api/tasks',{title:'Out of order',start_date:'2026-01-01',recurrence:'monthly'});
  const first=await instance(task,'2026-01-01');
  const second=await instance(task,'2026-02-01');
  await api(`/api/task-instances/${second}/complete`,'POST',{});
  await api(`/api/task-instances/${first}/complete`,'POST',{});
  assert.equal((await db.get('SELECT next_due FROM tasks WHERE id=?',task.id)).next_due,'2026-03-01');
  await api(`/api/task-instances/${first}/reopen`,'POST',{});
  assert.equal((await db.get('SELECT next_due FROM tasks WHERE id=?',task.id)).next_due,'2026-01-01');
  const completed=await api(`/api/tasks/${task.id}/complete`,'POST',{expected_due:'2026-01-01'});
  assert.equal(completed.body.next_due,'2026-03-01');
});
test('a follow-up inherits its task process and owner and is visible in process bundles and My Tasks', async () => {
  const user=await db.get("SELECT id FROM users WHERE email='test@example.invalid'");
  await create('/api/architecture',{arch_type:'role',name:'Control Owner',metadata:JSON.stringify({assigned_user_id:user.id})});
  const process=await create('/api/architecture',{arch_type:'process',name:'Access control'});
  const task=await create('/api/tasks',{title:'Access review',category:process.name,assignee:'Control Owner',start_date:'2026-01-01',recurrence:'monthly'});
  const id=await instance(task,'2026-01-01');
  const action=await create('/api/actions',{title:'Remove access',instance_id:id});
  assert.equal(action.process_id,process.id);
  assert.equal(action.assignee,'Control Owner');
  assert.ok((await api(`/api/actions?process_ids=${process.id}`)).body.some(a=>a.id===action.id));
  assert.ok((await api('/api/my-tasks')).body.actions.some(a=>a.id===action.id));
});
test('inactive series retains outcomes but stops presenting pending work', async () => {
  const task=await create('/api/tasks',{title:'Retired control',start_date:'2026-01-01',recurrence:'monthly'});
  const done=await instance(task,'2026-01-01','completed');
  await db.run("UPDATE task_instances SET completed_at='2026-01-02T12:00:00Z' WHERE id=?",done);
  await instance(task,'2026-02-01');
  await api(`/api/tasks/${task.id}`,'PUT',{is_active:0});
  assert.deepEqual((await api(`/api/task-instances?task_id=${task.id}&status=pending`)).body,[]);
  const plan=(await api('/api/yearly?year=2026')).body;
  assert.ok(plan.completedDates['2026-01-01'].some(t=>t.task_id===task.id));
  assert.ok(!(await api('/api/compliance-overview')).body.attention.some(row=>row.type==='instance' && row.title==='Retired control'));
});
test('task log rejects malformed ranges and protects foreign executions', async () => {
  assert.equal((await api('/api/task-instances?from=2026-02-30')).status,400);
  assert.equal((await api('/api/task-instances?from=2026-03-01&to=2026-01-01')).status,400);
  const t=(await db.run("INSERT INTO tasks(organization_id,title,start_date,next_due) VALUES (?,'Foreign','2026-01-01','2026-01-01')",otherOrg)).lastInsertRowid;
  const i=(await db.run("INSERT INTO task_instances(organization_id,task_id,scheduled_date) VALUES (?,?,'2026-01-01')",otherOrg,t)).lastInsertRowid;
  for(const verb of ['complete','skip','reopen']) assert.equal((await api(`/api/task-instances/${i}/${verb}`,'POST',{})).status,404);
  assert.deepEqual((await api(`/api/task-instances?task_id=${t}&from=2026-01-01&to=2026-01-01`)).body,[]);
});

test('date parameter tampering is rejected before any execution is generated', async () => {
  const task=await create('/api/tasks',{title:'Unmaterialized control',start_date:'2026-01-01',recurrence:'monthly'});
  for (const key of ['from','to']) {
    for (const query of [`${key}=2026-01-01&${key}=2026-02-01`,`${key}[]=2026-01-01`,`${key}[date]=2026-01-01`]) {
      assert.equal((await api(`/api/task-instances?task_id=${task.id}&${query}`)).status,400,query);
    }
  }
  assert.equal((await db.get('SELECT COUNT(*)::int AS count FROM task_instances WHERE task_id=?',task.id)).count,0);
});

test('process renaming preserves task execution filters, bundle membership and action linkage', async () => {
  const process=await create('/api/architecture',{arch_type:'process',name:'Original process'});
  const bundle=await create('/api/plan-bundles',{name:'Operations',process_ids:[process.id]});
  const task=await create('/api/tasks',{title:'Rename check',category:process.name,start_date:'2026-01-01',recurrence:'monthly'});
  const id=await instance(task,'2026-01-01');
  const rename=await api(`/api/architecture/${process.id}`,'PUT',{name:'Renamed process'});
  assert.equal(rename.status,200);
  assert.equal((await api(`/api/tasks/${task.id}`)).body.category,'Renamed process');
  assert.ok((await api('/api/task-instances?categories=Renamed%20process')).body.some(i=>i.id===id));
  assert.deepEqual(JSON.parse((await api('/api/plan-bundles')).body.find(b=>b.id===bundle.id).process_ids),[process.id]);
  assert.equal((await create('/api/actions',{title:'Rename follow-up',task_id:task.id})).process_id,process.id);
});
test('on-time KPI measures due dates rather than treating the first completion as on time', async () => {
  await db.run("UPDATE task_instances SET completed_at='2020-01-01' WHERE status='completed' AND organization_id=?",org);
  const today=new Date().toISOString().slice(0,10);
  const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);
  for(const [title,date] of [['Late control',yesterday],['Timely control',today]]) {
    const task=await create('/api/tasks',{title,start_date:date,recurrence:'monthly'});
    const id=await instance(task,date);
    assert.equal((await api(`/api/task-instances/${id}/complete`,'POST',{})).status,200);
  }
  assert.equal((await api('/api/dashboard')).body.onTimeRateCurrent,50);
});
test('schedule generation is idempotent and reaches today for a daily series older than 400 days', async () => {
  const start=new Date(Date.now()-500*86400000).toISOString().slice(0,10);
  const today=new Date().toISOString().slice(0,10);
  const task=await create('/api/tasks',{title:'Long-running daily control',start_date:start,recurrence:'daily'});
  const path=`/api/task-instances?task_id=${task.id}&from=${today}&to=${today}`;
  const first=await api(path); assert.equal(first.body.length,1);
  const second=await api(path); assert.equal(second.body[0].id,first.body[0].id);
  assert.equal((await db.get('SELECT COUNT(*)::int AS count FROM task_instances WHERE task_id=?',task.id)).count,501);
});

test('operational endpoints reject a user without planning permissions', async () => {
  const user=(await db.run("INSERT INTO users(organization_id,name,email,role,status,permissions) VALUES (?,'Restricted','restricted@example.invalid','org_user','active','[]')",org)).lastInsertRowid;
  const limitedCookie='session_token='+token({userId:user,userRole:'org_user',activeOrgId:org,organizationId:org,sv:0});
  for(const path of ['/api/tasks','/api/task-instances','/api/yearly','/api/actions','/api/plan-bundles']) {
    assert.equal((await fetch(base+path,{headers:{cookie:limitedCookie}})).status,403,path);
  }
});

test('execution evidence relationships remain navigable from requirements and audit checklists', async () => {
  const task=await create('/api/tasks',{title:'Auditable control',start_date:'2026-01-01',recurrence:'yearly'});
  const id=await instance(task,'2026-01-01');
  const requirement=await create('/api/requirements',{standard:'Test Standard',clause:'1',title:'Review access'});
  const audit=await create('/api/audits',{title:'Control audit'});
  const checklist=await create(`/api/audits/${audit.id}/checklist`,{clause:'1',requirement:'Review access'});
  await create('/api/cross-links',{source_type:'requirement',source_id:requirement.id,target_type:'task',target_id:task.id});
  await create('/api/cross-links',{source_type:'checklist',source_id:checklist.id,target_type:'instance',target_id:id});
  await api(`/api/task-instances/${id}/complete`,'POST',{notes:'Access reviewed'});
  await api(`/api/task-instances/${id}/reopen`,'POST',{});
  assert.ok((await api(`/api/relations/requirement/${requirement.id}`)).body.some(r=>r.type==='task'&&r.id===task.id));
  assert.ok((await api(`/api/relations/instance/${id}`)).body.some(r=>r.type==='checklist'&&r.id===checklist.id));
});
