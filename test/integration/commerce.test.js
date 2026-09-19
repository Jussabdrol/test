const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { installTestDatabase } = require('../support/database');
const db = installTestDatabase();
const commerce = require('../../src/server/services/commerce');
const { app } = require('../../src/server/app');
let server, base, order, session;
const checkout = { organization: 'Commerce test', name: 'Test owner', email: 'owner@example.invalid', password: 'a-long-test-password', interval: 'month', accepted: true };
const end = Math.floor(Date.now()/1000) + 30*86400;
let subStatus='active', invoiceStatus='paid';
const stripe = {
  checkout: { sessions: {
    create: async (params, options) => { assert.equal(params.line_items[0].price_data.unit_amount,14900); assert.equal(params.automatic_tax.enabled,true); assert.match(options.idempotencyKey,/^bop-checkout-/);session={ id:'cs_test_bop',url:'https://checkout.stripe.com/test',mode:'subscription',status:'open',payment_status:'unpaid',client_reference_id:params.client_reference_id,subscription:null,customer:'cus_test_bop' }; return session; },
    retrieve: async () => session,
  } },
  subscriptions: { retrieve: async () => ({ id:'sub_test_bop',status:subStatus,metadata:{bop_license_id:order.id},latest_invoice:{status:invoiceStatus},items:{data:[{current_period_end:end}]}}) },
};
function token(user) {
  const h=Buffer.from('{}').toString('base64url'),b=Buffer.from(JSON.stringify({userId:user.id,userRole:user.role,organizationId:user.organization_id,activeOrgId:user.organization_id,sv:0,exp:Date.now()+3600000})).toString('base64url');
  return `${h}.${b}.${crypto.createHmac('sha256',process.env.SESSION_SECRET).update(`${h}.${b}`).digest('base64url')}`;
}
before(async()=>{
  await db.initDatabase();
  server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await db.close();});
test('public website opens anonymously while console and organization data remain protected',async()=>{
  for(const path of ['/','/start','/welcome','/brand.css','/website/style.css','/website.js'])assert.equal((await fetch(base+path)).status,200,path);
  assert.equal((await fetch(base+'/console',{redirect:'manual'})).headers.get('location'),'/login');
  assert.equal((await fetch(base+'/api/tasks')).status,401);
  assert.equal((await fetch(base+'/api/commerce/catalog')).status,200);
  assert.equal((await (await fetch(base+'/api/commerce/catalog')).json()).enabled,false);
  assert.equal((await fetch(base+'/api/commerce/checkout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(checkout)})).status,403);
  assert.equal((await (await fetch(base+'/api/commerce/status')).json()).status,'unavailable');
});
test('checkout fails closed without configuration and requires valid input',async()=>{
  await assert.rejects(commerce.createCheckout(db,bcrypt,checkout,stripe),error=>error.status===503);
  for(const body of [{...checkout,interval:'free'},{...checkout,accepted:false},{...checkout,password:'short'},{...checkout,email:'invalid'}])assert.throws(()=>commerce.validateCheckout(body));
  process.env.BOP_CHECKOUT_ENABLED='true';process.env.STRIPE_SECRET_KEY='sk_test_fake';process.env.STRIPE_WEBHOOK_SECRET='whsec_fake';process.env.STRIPE_PRODUCT_ID='prod_test';process.env.BOP_PUBLIC_URL='https://go-bop.com';process.env.BOP_TERMS_URL='https://go-bop.com/terms';process.env.BOP_PRIVACY_URL='https://go-bop.com/privacy';
});
test('concurrent checkout retries reserve one inactive organization and one pending owner',async()=>{
  const results=await Promise.all([commerce.createCheckout(db,bcrypt,checkout,stripe),commerce.createCheckout(db,bcrypt,checkout,stripe)]);
  assert.equal(results[0].id,results[1].id);order=await db.get('SELECT * FROM bop_licenses WHERE id=?',results[0].id);
  assert.equal((await db.get('SELECT is_active FROM organizations WHERE id=?',order.organization_id)).is_active,0);
  const user=await db.get('SELECT * FROM users WHERE id=?',order.owner_id);assert.equal(user.status,'pending');assert.ok(await bcrypt.compare(checkout.password,user.password));assert.notEqual(user.password,checkout.password);
  await assert.rejects(commerce.createCheckout(db,bcrypt,{...checkout,password:'another-password'},stripe),error=>error.status===409);
  await assert.rejects(commerce.createCheckout(db,bcrypt,{...checkout,interval:'year'},stripe),error=>error.status===409);
});
test('unpaid or forged confirmations cannot activate a license; paid retries are idempotent',async()=>{
  await commerce.syncLicense(db,order.id,stripe);assert.equal((await db.get('SELECT status FROM bop_licenses WHERE id=?',order.id)).status,'pending');
  const response=await fetch(base+'/api/commerce/webhook',{method:'POST',headers:{'content-type':'application/json','stripe-signature':'forged'},body:'{}'});assert.equal(response.status,400);
  session={...session,status:'complete',payment_status:'paid',subscription:'sub_test_bop'};
  await Promise.all([commerce.syncLicense(db,order.id,stripe),commerce.syncLicense(db,order.id,stripe)]);
  assert.equal((await db.get('SELECT status FROM bop_licenses WHERE id=?',order.id)).status,'active');assert.equal((await db.get('SELECT is_active FROM organizations WHERE id=?',order.organization_id)).is_active,1);assert.equal((await db.get('SELECT status FROM users WHERE id=?',order.owner_id)).status,'active');
  assert.equal((await db.get('SELECT COUNT(*)::int AS count FROM users WHERE email=?',checkout.email)).count,1);
  const signed=commerce.orderCookie(order.id);assert.equal(commerce.readOrderCookie(signed),order.id);assert.equal(commerce.readOrderCookie(signed.slice(0,-1)+'z'),null);
  assert.equal((await (await fetch(base+'/api/commerce/status',{headers:{cookie:`bop_order=${signed}`}})).json()).status,'active');
});
test('expired entitlement blocks every organization member even when new checkout is disabled',async()=>{
  process.env.BOP_CHECKOUT_ENABLED='false';
  const member=await db.get("INSERT INTO users(organization_id,name,email,role,status) VALUES (?,'Member','member@example.invalid','org_user','active') RETURNING *",order.organization_id);
  const cookie='session_token='+token(member);
  assert.equal((await fetch(base+'/api/tasks',{headers:{cookie}})).status,200);
  await db.run("UPDATE bop_licenses SET access_until=NOW()-INTERVAL '1 day' WHERE id=?",order.id);
  assert.equal((await fetch(base+'/api/tasks',{headers:{cookie}})).status,402);
  assert.equal((await fetch(base+'/console',{headers:{cookie},redirect:'manual'})).headers.get('location'),'/billing');
  assert.equal((await fetch(base+'/billing',{headers:{cookie}})).status,200);
  const other=await db.get("SELECT * FROM users WHERE organization_id<>? AND status='active' LIMIT 1",order.organization_id);
  if(other)assert.notEqual((await fetch(base+'/api/tasks',{headers:{cookie:'session_token='+token(other)}})).status,402);
});
test('failed payment never extends access; renewal and cancellation follow current provider state',async()=>{
  invoiceStatus='open';subStatus='past_due';await commerce.syncLicense(db,order.id,stripe);assert.equal((await db.get('SELECT status FROM bop_licenses WHERE id=?',order.id)).status,'expired');
  invoiceStatus='paid';subStatus='active';await commerce.syncLicense(db,order.id,stripe);assert.equal((await db.get('SELECT status FROM bop_licenses WHERE id=?',order.id)).status,'active');
  subStatus='canceled';await commerce.syncLicense(db,order.id,stripe);assert.equal((await db.get('SELECT status FROM bop_licenses WHERE id=?',order.id)).status,'cancelled');
});
test('billing records are unavailable to browser database roles',async()=>{
  for(const role of ['anon','authenticated']){
    await db.exec(`SET ROLE ${role}`);
    try{await assert.rejects(db.get('SELECT * FROM bop_licenses'),error=>error.code==='42501');}finally{await db.exec('RESET ROLE');}
  }
});
