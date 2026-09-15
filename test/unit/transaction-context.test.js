const {test}=require('node:test');
const assert=require('node:assert/strict');
test('concurrent transactions retain separate clients and release effects only after commit',async()=>{
  const calls=[];let clientNumber=0;
  class Pool {
    on(){}
    async query(sql){calls.push(['pool',sql]);return {rows:[{c:1,id:1}],rowCount:1};}
    async connect(){const id=++clientNumber;return {query:async sql=>{calls.push([id,sql]);return {rows:[{id}],rowCount:1};},release:()=>calls.push([id,'RELEASE'])};}
    async end(){}
  }
  require('pg').Pool=Pool;
  const db=require('../../src/server/database');await db.initDatabase();calls.length=0;
  let releaseA,startedA;
  const ready=new Promise(resolve=>{startedA=resolve;});
  const blocked=new Promise(resolve=>{releaseA=resolve;});
  let effect=false;
  const first=db.transaction(async tx=>{
    await db.get('SELECT 101');startedA();await blocked;
    await tx.run('UPDATE example SET value=1');
    await db.transaction(()=>db.all('SELECT 102'));
    db.deferUntilCommit(()=>{effect=true;assert.ok(calls.some(([id,sql])=>id===1&&sql==='COMMIT'));});
  });
  await ready;
  await db.transaction(async()=>{await db.exec('SELECT 201');assert.equal(effect,false);});
  releaseA();await first;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(clientNumber,2);
  assert.deepEqual(calls.filter(([,sql])=>sql.startsWith('SELECT')).map(([id,sql])=>[id,sql]),[[1,'SELECT 101'],[2,'SELECT 201'],[1,'SELECT 102']]);
  assert.ok(!calls.some(([id])=>id==='pool'));assert.equal(effect,true);
  await db.close();
});
