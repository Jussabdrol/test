const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {installTestDatabase}=require('../support/database');
const db=installTestDatabase();
process.env.SESSION_SECRET='isolated-support-test-secret';
const {app}=require('../../src/server/app');
let server,base,anonymous,admin,member,superId,ticketId;
const migration=fs.readFileSync(path.join(__dirname,'../../supabase/migrations/20260919141357_support_tickets.sql'),'utf8');
function token(payload){const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');const b=Buffer.from(JSON.stringify({...payload,sv:0,exp:Date.now()+3600000})).toString('base64url');return `${h}.${b}.${crypto.createHmac('sha256',process.env.SESSION_SECRET).update(`${h}.${b}`).digest('base64url')}`;}
async function session(payload){const cookie=payload?'session_token='+token(payload):'';const r=await fetch(base+'/contact',{headers:{cookie}});const cookies=r.headers.getSetCookie().map(v=>v.split(';')[0]);const csrf=cookies.find(c=>c.startsWith('csrf_token='));return {cookie:[cookie,...cookies].filter(Boolean).join('; '),csrf:decodeURIComponent(csrf.slice(11))};}
async function request(url,method='GET',body,auth=anonymous,csrf=true){const r=await fetch(base+url,{method,headers:{cookie:auth.cookie,'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':auth.csrf}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});return {status:r.status,body:await r.json()};}
function submission(){return {submission_id:crypto.randomUUID(),name:'Test Visitor',email:'visitor@example.invalid',organization:'Synthetic',topic:'technical',subject:'Test issue with recurring tasks',message:'Synthetic test message with enough detail to investigate.',website:''};}
before(async()=>{
  await db.initDatabase();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
  await db.exec(migration);await db.exec(migration);
  const org=(await db.get('SELECT id FROM organizations LIMIT 1')).id;
  superId=(await db.run("INSERT INTO users(name,email,role,status) VALUES ('Platform','platform@example.invalid','superadmin','active')")).lastInsertRowid;
  const memberId=(await db.run("INSERT INTO users(name,email,role,status,organization_id) VALUES ('Member','member@example.invalid','org_admin','active',?)",org)).lastInsertRowid;
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  anonymous=await session();admin=await session({userId:superId,userRole:'superadmin',organizationId:null,activeOrgId:null});member=await session({userId:memberId,userRole:'org_admin',organizationId:org,activeOrgId:org});
});
after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await db.close();});
test('public pages are accessible, protected console stays protected and commerce remains disabled',async()=>{
  for(const url of ['/','/tour','/guides','/contact','/security','/start','/welcome','/robots.txt','/sitemap.xml']){const r=await fetch(base+url,{redirect:'manual'});assert.equal(r.status,200,url);}
  assert.equal((await fetch(base+'/console',{redirect:'manual'})).status,302);
  assert.equal((await request('/api/commerce/catalog')).body.enabled,false);
  assert.equal((await request('/api/commerce/checkout','POST',{})).status,401);
});
test('anonymous submission requires CSRF, validates input and creates only one ticket on simultaneous retries',async()=>{
  const payload=submission();
  assert.equal((await request('/api/support/tickets','POST',payload,anonymous,false)).status,403);
  assert.equal((await request('/api/support/tickets','POST',{...payload,email:'invalid'})).status,400);
  assert.equal((await request('/api/support/tickets','POST',{...payload,message:'short'})).status,400);
  assert.equal((await request('/api/support/tickets','POST',{...payload,website:'bot.invalid'})).status,400);
  const results=await Promise.all([request('/api/support/tickets','POST',payload),request('/api/support/tickets','POST',payload)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(results[0].body.reference,results[1].body.reference);
  assert.deepEqual(Object.keys(results[0].body),['reference']);
  assert.equal((await db.get('SELECT count(*)::int AS n FROM support_tickets')).n,1);
  ticketId=(await db.get('SELECT id FROM support_tickets')).id;
  assert.equal((await request('/api/support/tickets','POST',{...payload,subject:'A different subject'})).status,409);
});
test('only current superadmins can read or update tickets; stale edits cannot overwrite newer notes',async()=>{
  const url='/api/msp/support-tickets';
  for(const method of ['GET','PATCH']){
    const target=method==='GET'?url:url+'/'+ticketId;
    const body=method==='GET'?undefined:{status:'resolved',internal_notes:'denied',revision:1};
    assert.equal((await request(target,method,body)).status,401);
    assert.equal((await request(target,method,body,member)).status,403);
  }
  assert.equal((await request('/api/support/tickets')).status,401);
  const list=await request(url,'GET',undefined,admin);assert.equal(list.status,200);assert.equal(list.body.tickets.length,1);assert.equal(list.body.tickets[0].email,'visitor@example.invalid');
  const update={status:'in_progress',internal_notes:'Private investigation notes',revision:1};
  assert.equal((await request(url+'/'+ticketId,'PATCH',update,admin,false)).status,403);
  assert.equal((await request(url+'/'+ticketId,'PATCH',update,admin)).status,200);
  assert.equal((await request(url+'/'+ticketId,'PATCH',{...update,status:'resolved'},admin)).status,409);
  assert.equal((await db.get('SELECT internal_notes FROM support_tickets WHERE id=?',ticketId)).internal_notes,update.internal_notes);
  assert.equal((await request(url+'?status=open','GET',undefined,admin)).body.tickets.length,0);
  assert.equal((await request(url+'?status=in_progress','GET',undefined,admin)).body.tickets.length,1);
  assert.equal((await request(url+'?status=bad','GET',undefined,admin)).status,400);
  await db.run('UPDATE users SET session_version=1 WHERE id=?',superId);
  assert.equal((await request(url,'GET',undefined,admin)).status,401);
});
test('migration preserves tickets on retry and denies direct Data API roles',async()=>{
  await db.exec(migration);
  assert.equal((await db.get('SELECT count(*)::int AS n FROM support_tickets')).n,1);
  assert.equal((await db.get("SELECT relrowsecurity FROM pg_class WHERE oid='public.support_tickets'::regclass")).relrowsecurity,true);
  for(const role of ['anon','authenticated']){
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(db.all('SELECT * FROM support_tickets'),/permission denied/);
    await assert.rejects(db.exec("UPDATE support_tickets SET status='resolved'"),/permission denied/);
    await db.exec('RESET ROLE');
  }
});
test('contact rate limit bounds anonymous intake',async()=>{
  let last;
  for(let i=0;i<11;i++)last=await request('/api/support/tickets','POST',{website:'bot'});
  assert.equal(last.status,429);
});
