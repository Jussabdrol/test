const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function fixture(api=async()=>({id:1,status:'active',description:'Safe description'})){
 const elements=new Map();
 const element=id=>{if(!elements.has(id))elements.set(id,{hidden:true,value:'',innerHTML:'',title:'',attributes:{},getBoundingClientRect:()=>({width:310}),focus(){},replaceChildren(){this.innerHTML='';},setAttribute(k,v){this.attributes[k]=v;},querySelector:()=>({focus(){}})});return elements.get(id);};
 const frames=[];let draws=0;
 const context=vm.createContext({document:{hidden:false,getElementById:element},api,AbortController,matchMedia:()=>({matches:false}),requestAnimationFrame:callback=>{frames.push(callback);return frames.length;},cancelAnimationFrame(){},esc:value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),experienceStatus:s=>s||'Not set'});
 vm.runInContext(fs.readFileSync('src/client/organization/sphere-model.js','utf8'),context);
 vm.runInContext(fs.readFileSync('src/client/organization/sphere.js','utf8'),context);
 const realDraw=context.drawSphere;context.sphereVisible=()=>true;context.drawSphere=()=>draws++;
 context.data={nodes:[{key:'system:1',id:1,type:'system',name:'Platform <img src=x onerror=alert(1)>'},{key:'process:2',id:2,type:'process',name:'Process'},{key:'document:3',id:3,type:'document',name:'Policy'}],edges:[{source:'system:1',target:'process:2',label:'serving',origin:'cross_link',notes:'Note <script>bad</script>'},{source:'system:1',target:'document:3',label:'Document reference',origin:'record',directed:true}],types:[{type:'system',label:'System'},{type:'process',label:'Process'},{type:'document',label:'Document'}]};
 vm.runInContext('sphereState.graph=sphereIndex(data);sphereState.records=[...sphereState.graph.nodes.values()];sphereState.scene=sphereScene(sphereState.graph,sphereState.records)',context);
 context.renderSphere=()=>vm.runInContext('if(!sphereState.selected)renderSphereDetailEmpty()',context);
 return {context,elements,frames,realDraw,draws:()=>draws};
}
test('Sphere rotates gradually, pauses on request and does not animate a hidden view',()=>{
 const {context,elements,frames,draws}=fixture();
 vm.runInContext('scheduleSphereDraw()',context);frames.shift()(100);const before=vm.runInContext('sphereState.yaw',context);frames.shift()(150);
 const after=vm.runInContext('sphereState.yaw',context);assert.ok(after>before&&after-before<.002);
 vm.runInContext('toggleSphereRotation()',context);frames.shift()(200);assert.equal(frames.length,0);
 assert.equal(elements.get('sphere-rotation').attributes['aria-label'],'Resume rotation');
 assert.equal(vm.runInContext('sphereState.yaw',context),after);
 vm.runInContext('toggleSphereRotation()',context);context.sphereVisible=()=>false;const n=draws();frames.shift()(250);assert.equal(draws(),n);assert.equal(frames.length,0);
});
test('record selection pauses motion and groups escaped integration metadata by type',async()=>{
 const {context,elements}=fixture(async()=>({id:1,status:'active',description:'<img src=x onerror=alert(1)>'}));
 await vm.runInContext("selectSphereRecord('system:1')",context);
 assert.equal(vm.runInContext('sphereState.rotating',context),false);
 assert.equal(elements.get('sphere-detail').hidden,false);
 assert.match(elements.get('sphere-detail').innerHTML,/Platform &lt;img/);
 const html=elements.get('sphere-connections').innerHTML;
 assert.match(html,/sphere-connection-group/);assert.match(html,/Document/);assert.match(html,/Process/);assert.match(html,/serving/);
 assert.match(html,/Note &lt;script&gt;/);assert.doesNotMatch(html,/<script>|<img/i);
 assert.match(elements.get('sphere-record-description').innerHTML,/&lt;img/);
 assert.equal(elements.get('sphere-open-record').disabled,false);
});
test('closed selections cannot be reopened by delayed detail requests',async()=>{
 let release;const {context,elements}=fixture(()=>new Promise(resolve=>{release=resolve;}));
 const pending=vm.runInContext("selectSphereRecord('system:1')",context);
 vm.runInContext('closeSphereSelection()',context);release({id:1,status:'active',description:'Late response'});await pending;
 assert.equal(elements.get('sphere-detail').hidden,true);assert.equal(elements.get('sphere-detail').innerHTML,'');
 assert.ok(!elements.has('sphere-record-description'));
});
test('highlighted neighboring records receive labels; unrelated records stay unlabeled',()=>{
 const {context,elements,realDraw}=fixture();const labels=[];
 const graphics={setTransform(){},clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){},fill(){},fillRect(){},measureText:text=>({width:text.length*6}),fillText:text=>labels.push(text)};
 elements.set('sphere-canvas',{getContext:()=>graphics,getBoundingClientRect:()=>({width:800,height:600})});context.devicePixelRatio=1;
 context.data.nodes.push({key:'asset:4',id:4,type:'asset',name:'Unrelated asset'});
 vm.runInContext("sphereState.graph=sphereIndex(data);sphereState.scene=sphereScene(sphereState.graph,[...sphereState.graph.nodes.values()]);sphereState.selected='system:1'",context);
 realDraw();assert.ok(labels.includes('Process'));assert.ok(labels.includes('Policy'));assert.ok(labels.some(text=>text.startsWith('Platform')));assert.ok(!labels.includes('Unrelated asset'));
});
