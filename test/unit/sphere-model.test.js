const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const ctx=vm.createContext({});vm.runInContext(fs.readFileSync('src/client/organization/sphere-model.js','utf8'),ctx);
const node=(id,type='asset')=>({id,key:`${type}:${id}`,type,name:`${type} ${id}`,status:'active'});
function graph(nodes,edges){ctx.data={nodes,edges,types:[{type:'asset',label:'Asset'},{type:'process',label:'Process'}]};return vm.runInContext('sphereIndex(data)',ctx);}
test('Sphere keeps isolated records, indexes bidirectional edges and traverses cycles safely',()=>{
 ctx.g=graph([node(1,'process'),node(2),node(3),node(4)], [{source:'process:1',target:'asset:2'},{source:'asset:2',target:'asset:3'},{source:'asset:3',target:'process:1'},{source:'asset:4',target:'missing:9'}]);
 assert.equal(ctx.g.edges.length,3);assert.equal(ctx.g.nodes.get('asset:4').degree,0);
 assert.deepEqual([...vm.runInContext("sphereNeighborhood(g,'asset:2',1)",ctx)].sort(),['asset:2','asset:3','process:1']);
 assert.equal(vm.runInContext("sphereNeighborhood(g,'process:1').size",ctx),3);
 assert.equal(vm.runInContext("sphereFilter(g,{search:'asset 4'})[0].key",ctx),'asset:4');
 assert.equal(vm.runInContext("sphereFilter(g,{focus:'asset:2',type:'asset',depth:1}).length",ctx),2);
});
test('large scenes are bounded and every record remains expandable and searchable',()=>{
 const nodes=Array.from({length:2200},(_,i)=>node(i+1,'process'));ctx.g=graph(nodes,[]);
 const scene=vm.runInContext('sphereScene(g,[...g.nodes.values()])',ctx);
 assert.ok(scene.nodes.length<=180);assert.equal(new Set(scene.nodes.flatMap(node=>node.members)).size,2200);
 assert.equal(vm.runInContext("sphereFilter(g,{search:'process 2199'})[0].key",ctx),'process:2199');
 ctx.memberKeys=new Set(scene.nodes[0].members);assert.equal(vm.runInContext('sphereFilter(g,{drill:memberKeys}).length',ctx),scene.nodes[0].members.length);
});
test('projection rotates in three dimensions and preserves finite coordinates at zoom limits',()=>{
 for(const yaw of [0,Math.PI/2,Math.PI])for(const pitch of [-Math.PI/2,0,Math.PI/2]){
  ctx.args={yaw,pitch};const p=vm.runInContext('sphereProject({x:.5,y:.5,z:.5},args.yaw,args.pitch,2.6,390,460)',ctx);
  assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y)&&Number.isFinite(p.z));
 }
 const a=vm.runInContext('sphereProject({x:1,y:0,z:0},0,0,1,600,600)',ctx);
 const b=vm.runInContext('sphereProject({x:1,y:0,z:0},Math.PI/2,0,1,600,600)',ctx);
 assert.notEqual(a.x,b.x);assert.notEqual(a.z,b.z);
});
test('types occupy distinct regions and large single-type groups always expand to smaller sets',()=>{
 ctx.g=graph([node(1,'process'),node(2,'process'),node(3),node(4)], [{source:'process:1',target:'asset:3'}]);
 assert.equal(ctx.g.nodes.get('asset:3').group,ctx.g.nodes.get('asset:4').group);
 assert.notEqual(ctx.g.nodes.get('asset:3').group,ctx.g.nodes.get('process:1').group);
 const scene=vm.runInContext('sphereScene(g,[...g.nodes.values()])',ctx);
 assert.equal(scene.regions.length,2);
 assert.notDeepEqual(scene.nodes.find(n=>n.key==='process:1').position,scene.nodes.find(n=>n.key==='process:2').position);
 ctx.g=graph(Array.from({length:2200},(_,i)=>node(i+1)),[]);
 ctx.records=[...ctx.g.nodes.values()];
 for(let i=0;i<5&&ctx.records.length>180;i++){
  const previous=ctx.records.length;const step=vm.runInContext("sphereScene(g,records,'',180,true)",ctx);
  const largest=step.nodes.reduce((a,b)=>a.members.length>b.members.length?a:b);
  assert.ok(largest.members.length<previous);
  ctx.records=largest.members.map(key=>ctx.g.nodes.get(key));
 }
 assert.ok(ctx.records.length<=180);
});
test('large typed scenes expose a selected record and its direct neighbors individually',()=>{
 const nodes=[node(1,'process'),...Array.from({length:600},(_,i)=>node(i+2))];
 ctx.g=graph(nodes,[{source:'process:1',target:'asset:2'},{source:'process:1',target:'asset:3'}]);
 const scene=vm.runInContext("sphereScene(g,[...g.nodes.values()],'process:1')",ctx);
 for(const key of ['process:1','asset:2','asset:3'])assert.ok(scene.nodes.some(n=>n.key===key&&n.members.length===1));
 assert.ok(scene.nodes.length<=180);assert.equal(new Set(scene.nodes.flatMap(n=>n.members)).size,601);
});
