const spherePalette = {
  process:'#66ddc1',role:'#b4d5ff',system:'#8db9ff',asset:'#9bb6cb',facility:'#b5ccc2',
  task:'#ffd18a',instance:'#e6af6e',action:'#ffbda4',plan_bundle:'#d8c591',
  risk:'#eb9fae',treatment:'#d6b1d8',threat:'#e6b1b8',requirement:'#b6a9ef',
  audit:'#b4c2f2',checklist:'#cbd4f1',ncr:'#e8a89e',document:'#91d5e5',
  supplier:'#c5cda0',kpi:'#8de0bb',management_review:'#c3baf2',review_output:'#d6c7e9',
  usecase:'#beaffe',arch_ai_usecase:'#c9bfff',ai_model:'#bcbbef',ai_dataset:'#a4c7e1',cluster:'#a9ded4',
};
const sphereState = {
  graph:null, scene:null, records:[], selected:'', hover:'', focused:false, depth:1,
  drill:null, drillName:'', mode:'map', page:0, relationPage:0, yaw:-.25, pitch:.12, zoom:1,
  request:0, detailRequest:0, loading:false, controller:null, detailController:null,
  context:'', initialized:false, frame:0, rotating:true, lastFrame:0, projected:[], pointers:new Map(), drag:null,
};
function sphereLabel(type) { return sphereState.graph?.types.find(item=>item.type===type)?.label || type.replace(/_/g,' '); }
function sphereColor(type) { return spherePalette[type] || '#c8d5e2'; }
function sphereVisible() { return currentView==='mission-control' && !document.getElementById('mission-panel-sphere')?.hidden && !document.hidden; }
function suspendSphere() {
  cancelAnimationFrame(sphereState.frame); sphereState.frame=0;sphereState.lastFrame=0;
  sphereState.pointers.clear(); sphereState.drag=null;
  if (sphereState.loading) { sphereState.controller?.abort(); sphereState.request++; sphereState.loading=false; }
  sphereState.detailController?.abort(); sphereState.detailRequest++;
}
function initializeSphere() {
  if (sphereState.initialized) return;
  sphereState.initialized=true;
  const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
  if(reducedMotion.matches)sphereState.rotating=false;
  updateSphereRotationButton();
  reducedMotion.addEventListener('change',event=>{if(event.matches)pauseSphereRotation();});
  const canvas=document.getElementById('sphere-canvas');
  new ResizeObserver(()=>scheduleSphereDraw()).observe(document.getElementById('sphere-stage'));
  canvas.addEventListener('pointerdown',event=>{
    if (event.button!==0 && event.pointerType==='mouse') return;
    pauseSphereRotation();canvas.focus({preventScroll:true}); canvas.setPointerCapture(event.pointerId);
    sphereState.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    sphereState.drag={x:event.clientX,y:event.clientY,moved:false};
    if (sphereState.pointers.size>1) sphereState.drag.moved=true;
  });
  canvas.addEventListener('pointermove',event=>{
    const points=sphereState.pointers, previous=points.get(event.pointerId);
    if (previous) {
      const other=[...points].find(([id])=>id!==event.pointerId)?.[1];
      if (other) {
        const before=Math.hypot(previous.x-other.x,previous.y-other.y),after=Math.hypot(event.clientX-other.x,event.clientY-other.y);
        if (before>5) zoomSphere(after/before);
      } else rotateSphere((event.clientX-previous.x)*.007,(event.clientY-previous.y)*.007);
      points.set(event.pointerId,{x:event.clientX,y:event.clientY});
      if (sphereState.drag && Math.hypot(event.clientX-sphereState.drag.x,event.clientY-sphereState.drag.y)>5) sphereState.drag.moved=true;
      hideSphereTooltip();
    } else {
      const rect=canvas.getBoundingClientRect();
      const hit=sphereHit(event.clientX-rect.left,event.clientY-rect.top);
      sphereState.hover=hit?.key||''; canvas.style.cursor=hit?'pointer':'grab';
      const tip=document.getElementById('sphere-tooltip'); tip.hidden=!hit;
      if (hit) {
        tip.textContent=hit.name+(hit.members.length>1 ? ` · ${hit.members.length} records` : ` · ${sphereLabel(hit.type)}`);
        tip.style.left=Math.max(12,Math.min(rect.width-220,event.clientX-rect.left+14))+'px';
        tip.style.top=Math.max(60,Math.min(rect.height-115,event.clientY-rect.top-38))+'px';
      }
      scheduleSphereDraw();
    }
  });
  canvas.addEventListener('pointerup',event=>{
    const single=sphereState.pointers.size===1 && sphereState.drag && !sphereState.drag.moved;
    sphereState.pointers.delete(event.pointerId);
    if (single) { const rect=canvas.getBoundingClientRect(); const hit=sphereHit(event.clientX-rect.left,event.clientY-rect.top); if (hit) chooseSpherePoint(hit.key); }
    if (!sphereState.pointers.size) sphereState.drag=null;
  });
  canvas.addEventListener('pointercancel',()=>{sphereState.pointers.clear();sphereState.drag=null;});
  canvas.addEventListener('pointerleave',()=>{if(!sphereState.pointers.size)hideSphereTooltip();});
  canvas.addEventListener('wheel',event=>{
    if(document.activeElement!==canvas)return;
    event.preventDefault(); zoomSphere(Math.exp(-event.deltaY*.001));
  },{passive:false});
  canvas.addEventListener('keydown',event=>{
    if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','Home'].includes(event.key)) event.preventDefault();
    if(event.key==='ArrowLeft')rotateSphere(-.15,0);
    if(event.key==='ArrowRight')rotateSphere(.15,0);
    if(event.key==='ArrowUp')rotateSphere(0,-.15);
    if(event.key==='ArrowDown')rotateSphere(0,.15);
    if(event.key==='+'||event.key==='=')zoomSphere(1.2);
    if(event.key==='-')zoomSphere(1/1.2);
    if(event.key==='Home')resetSphereCamera();
  });
  document.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||!sphereVisible()||event.target.closest('.modal,dialog'))return;
    const options=document.getElementById('sphere-options');
    if(options.open){options.open=false;options.querySelector('summary').focus();}
    else if(sphereState.selected)closeSphereSelection();
  });
  document.addEventListener('pointerdown',event=>{
    if(!event.target.closest('.sphere-options'))document.getElementById('sphere-options').open=false;
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(sphereState.frame);sphereState.frame=0;}else scheduleSphereDraw();});
  if(!canvas.getContext('2d'))setSphereMode('list');
}
function hideSphereTooltip(){sphereState.hover='';document.getElementById('sphere-tooltip').hidden=true;scheduleSphereDraw();}
async function loadSphere(force=false) {
  initializeSphere();
  const context=JSON.stringify([activeOrg?.id,currentUser?.id,currentUser?.permissions,currentUser?.role]);
  if(context!==sphereState.context){sphereState.graph=null;sphereState.selected='';sphereState.focused=false;sphereState.drill=null;sphereState.context=context;resetSphereFilters(false);}
  if(sphereState.loading && !force)return;
  if(sphereState.graph && !force){renderSphere(); if(sphereState.selected)selectSphereRecord(sphereState.selected,false);return;}
  sphereState.controller?.abort(); const controller=new AbortController();sphereState.controller=controller;
  const request=++sphereState.request; sphereState.loading=true;sphereState.graph=null;sphereState.scene=null;sphereState.records=[];
  sphereState.detailController?.abort();sphereState.detailRequest++;
  document.getElementById('sphere-detail').hidden=true;
  document.getElementById('sphere-detail').innerHTML='<div class="sphere-detail-empty"><span class="sphere-orbit-icon" aria-hidden="true">◎</span><h3>Gathering your connections</h3><p>Reading the records available to your account.</p></div>';
  document.getElementById('sphere-counts').textContent='Loading organization relationships…';
  document.getElementById('sphere-record-list').replaceChildren();document.getElementById('sphere-legend').replaceChildren();document.getElementById('sphere-scope').hidden=true;
  sphereMessage('Loading your organization’s relationship map…');scheduleSphereDraw();
  try {
    const data=await api('/api/sphere',{signal:controller.signal});
    if(request!==sphereState.request)return;
    sphereState.graph=sphereIndex(data);sphereState.loading=false;
    sphereMessage('');
    const type=document.getElementById('sphere-type'),process=document.getElementById('sphere-process');
    const oldType=type.value,oldProcess=process.value;
    type.innerHTML='<option value="">All types</option>'+data.types.filter(item=>data.nodes.some(node=>node.type===item.type)).map(item=>`<option value="${item.type}">${esc(item.label)}</option>`).join('');
    process.innerHTML='<option value="">All processes</option>'+sphereState.graph.processes.map(node=>`<option value="${node.key}">${esc(node.name)}</option>`).join('');
    type.value=oldType;process.value=oldProcess;
    if(!type.value)type.value='';if(!process.value)process.value='';
    if(!sphereState.graph.nodes.has(sphereState.selected)){sphereState.selected='';sphereState.focused=false;}
    sphereState.drill=null;sphereState.page=0;renderSphere();
    if(sphereState.selected)selectSphereRecord(sphereState.selected,false);
  } catch(error) {
    if(request!==sphereState.request || controller.signal.aborted)return;
    sphereState.loading=false;sphereState.graph=null;sphereState.scene=null;
    sphereMessage('The relationship map could not be loaded. Please try again.',true);
    document.getElementById('sphere-counts').textContent='Relationships unavailable';renderSphereDetailEmpty();scheduleSphereDraw();
  }
}
function sphereMessage(message,retry=false) {
  const el=document.getElementById('sphere-message');el.hidden=!message;
  el.innerHTML=message ? `<span>${esc(message)}</span>${retry?'<button type="button" class="btn btn-secondary" onclick="loadSphere(true)">Try again</button>':''}` : '';
}
function changeSphereFilters(){sphereState.page=0;sphereState.drill=null;sphereState.focused=false;renderSphere();}
function resetSphereFilters(render=true){for(const id of ['sphere-search','sphere-type','sphere-process']){const el=document.getElementById(id);if(el)el.value='';}sphereState.drill=null;sphereState.focused=false;sphereState.page=0;if(render)renderSphere();}
function setSphereMode(mode){
  sphereState.mode=mode;document.getElementById('sphere-stage').hidden=mode!=='map';document.getElementById('sphere-record-list').hidden=mode!=='list';
  document.getElementById('sphere-map-mode').setAttribute('aria-pressed',String(mode==='map'));document.getElementById('sphere-list-mode').setAttribute('aria-pressed',String(mode==='list'));
  if(mode==='list')renderSphereList();else scheduleSphereDraw();
}
function renderSphere() {
  const graph=sphereState.graph;if(!graph)return;
  const search=document.getElementById('sphere-search').value,type=document.getElementById('sphere-type').value,process=document.getElementById('sphere-process').value;
  sphereState.records=sphereFilter(graph,{search,type,process,focus:sphereState.focused?sphereState.selected:'',depth:sphereState.depth,drill:sphereState.drill});
  sphereState.scene=sphereScene(graph,sphereState.records,sphereState.selected,180,!!sphereState.drill);
  const keys=new Set(sphereState.records.map(node=>node.key));
  const links=graph.edges.filter(edge=>keys.has(edge.source)&&keys.has(edge.target)).length;
  document.getElementById('sphere-counts').textContent=`${sphereState.records.length.toLocaleString()} of ${graph.nodes.size.toLocaleString()} records · ${links.toLocaleString()} relationships`;
  document.getElementById('sphere-options').classList.toggle('has-filters',!!(search||type||process));
  const clusters=sphereState.scene.nodes.filter(node=>node.members.length>1).length;
  document.getElementById('sphere-stage-caption').textContent=clusters ? `${clusters} groups · select a group to expand` : 'Select a record. Follow its connections.';
  const empty=document.getElementById('sphere-stage-empty');empty.hidden=!!sphereState.records.length;
  empty.innerHTML=graph.nodes.size ? '<h3>No matching records</h3><p>Try another search or clear the filters.</p><button type="button" onclick="resetSphereFilters()">Clear filters</button>' : '<h3>Your organization starts here</h3><p>Add records in BOP. Their saved relationships will appear here automatically.</p>';
  const scope=document.getElementById('sphere-scope');scope.hidden=!sphereState.focused&&!sphereState.drill;
  scope.innerHTML=sphereState.focused ? `<span>Connections around <strong>${esc(graph.nodes.get(sphereState.selected)?.name||'')}</strong></span><label>Depth <select onchange="setSphereDepth(this.value)"><option value="1" ${sphereState.depth===1?'selected':''}>Direct connections</option><option value="2" ${sphereState.depth===2?'selected':''}>Two steps</option></select></label><button type="button" onclick="clearSphereFocus()">Show full network</button>` : sphereState.drill ? `<span>Exploring <strong>${esc(sphereState.drillName)}</strong></span><button type="button" onclick="clearSphereFocus()">Back to full network</button>` : '';
  document.getElementById('sphere-legend').innerHTML=[...new Set(sphereState.records.map(node=>node.type))].map(type=>`<button type="button" onclick="filterSphereType('${type}')" aria-pressed="${document.getElementById('sphere-type').value===type}"><i style="--sphere-color:${sphereColor(type)}" aria-hidden="true"></i>${esc(sphereLabel(type))}</button>`).join('');
  renderSphereList();if(!sphereState.selected)renderSphereDetailEmpty();scheduleSphereDraw();
}
function filterSphereType(type){document.getElementById('sphere-type').value=document.getElementById('sphere-type').value===type?'':type;changeSphereFilters();}
function setSphereDepth(value){sphereState.depth=Number(value)===2?2:1;sphereState.page=0;renderSphere();}
function clearSphereFocus(){sphereState.focused=false;sphereState.drill=null;sphereState.page=0;renderSphere();}
function focusSphereRecord(){if(!sphereState.selected)return;resetSphereFilters(false);sphereState.focused=true;sphereState.page=0;renderSphere();}
function pageSphere(delta){sphereState.page+=delta;renderSphereList();document.getElementById('sphere-record-list').scrollTop=0;}
function renderSphereList(){
  const el=document.getElementById('sphere-record-list');if(!sphereState.graph){el.replaceChildren();return;}
  const rows=[...sphereState.records].sort((a,b)=>a.name.localeCompare(b.name)||a.key.localeCompare(b.key));
  const pages=Math.max(1,Math.ceil(rows.length/40));sphereState.page=Math.max(0,Math.min(pages-1,sphereState.page));
  el.innerHTML=`<div class="sphere-list-heading"><h3>Records</h3><span>${rows.length.toLocaleString()} results</span></div>`+(rows.length?`<ul>${rows.slice(sphereState.page*40,sphereState.page*40+40).map(node=>`<li><button type="button" aria-pressed="${sphereState.selected===node.key}" onclick="selectSphereRecord('${node.key}')"><i style="--sphere-color:${sphereColor(node.type)}" aria-hidden="true"></i><span><strong>${esc(node.name)}</strong><small>${esc(sphereLabel(node.type))}${node.status?' · '+esc(experienceStatus(node.status)):''}</small></span><span class="sphere-list-degree">${node.degree}<small>connections</small></span></button></li>`).join('')}</ul><div class="sphere-pagination"><button type="button" onclick="pageSphere(-1)" ${sphereState.page===0?'disabled':''}>Previous</button><span>Page ${sphereState.page+1} of ${pages}</span><button type="button" onclick="pageSphere(1)" ${sphereState.page===pages-1?'disabled':''}>Next</button></div>`:'<p class="sphere-list-empty">No records match. Try clearing the filters.</p>');
}
function renderSphereDetailEmpty(){const panel=document.getElementById('sphere-detail');panel.hidden=true;panel.replaceChildren();}
function chooseSpherePoint(key){
  const point=sphereState.scene?.nodes.find(node=>node.key===key);if(!point)return;
  if(point.members.length>1){sphereState.drill=new Set(point.members);sphereState.drillName=point.name;sphereState.focused=false;sphereState.page=0;renderSphere();resetSphereCamera();}
  else selectSphereRecord(point.members[0]);
}
function closeSphereSelection(){sphereState.detailController?.abort();sphereState.detailRequest++;sphereState.selected='';sphereState.focused=false;renderSphere();document.getElementById(sphereState.mode==='map'?'sphere-canvas':'sphere-list-mode').focus({preventScroll:true});}
async function selectSphereRecord(key,center=true){
  const graph=sphereState.graph,node=graph?.nodes.get(key);if(!node)return;
  // Selection reveals every permitted direct connection, including other types
  // that a search or type filter had hidden. Preserve explicit neighborhood focus.
  const wasFocused=sphereState.focused;resetSphereFilters(false);sphereState.focused=wasFocused;
  pauseSphereRotation();hideSphereTooltip();sphereState.selected=key;sphereState.relationPage=0;
  renderSphere();
  if(center){
    const point=sphereState.scene.nodes.find(item=>item.key===key)?.position;
    if(point){sphereState.yaw=Math.atan2(-point.x,point.z);sphereState.pitch=Math.atan2(point.y,Math.hypot(point.x,point.z));}
  }
  sphereState.detailController?.abort();const controller=new AbortController();sphereState.detailController=controller;const request=++sphereState.detailRequest;
  const panel=document.getElementById('sphere-detail');
  panel.hidden=false;document.getElementById('sphere-options').open=false;
  panel.innerHTML=`<header><span class="sphere-type-label"><i style="--sphere-color:${sphereColor(node.type)}"></i>${esc(sphereLabel(node.type))}</span><button type="button" class="sphere-close" aria-label="Close record details" onclick="closeSphereSelection()">×</button></header><h3>${esc(node.name)}</h3><div id="sphere-record-description" aria-live="polite"><p class="sphere-muted">Loading record details…</p></div><div class="sphere-detail-actions"><button type="button" id="sphere-open-record" class="btn btn-primary" disabled onclick="openSphereRecord()">Open record ↗</button><button type="button" class="btn btn-secondary" onclick="focusSphereRecord()">Focus connections</button></div><div class="sphere-connections-heading"><h4>Integrations &amp; connections</h4><span>${graph.neighbors.get(key).size}</span></div><div id="sphere-connections"></div>`;
  renderSphereConnections();scheduleSphereDraw();panel.querySelector('.sphere-close').focus({preventScroll:true});
  if(center && matchMedia('(max-width: 767px)').matches)panel.scrollIntoView({block:'start',behavior:'instant'});
  try{
    const detail=await api(`/api/sphere/record/${node.type}/${node.id}`,{signal:controller.signal});
    if(request!==sphereState.detailRequest||sphereState.selected!==key)return;
    document.getElementById('sphere-record-description').innerHTML=`<div class="sphere-record-meta"><span>${esc(experienceStatus(detail.status))}</span><span>Record #${detail.id}</span></div><p class="sphere-description">${detail.description?esc(detail.description):'No description has been added to this record.'}</p>`;
    document.getElementById('sphere-open-record').disabled=false;
  }catch(error){if(controller.signal.aborted||request!==sphereState.detailRequest)return;document.getElementById('sphere-record-description').innerHTML='<p role="alert" class="sphere-muted">This record could not be loaded. Refresh the map to check its availability.</p>';}
}
function renderSphereConnections(){
  const graph=sphereState.graph,key=sphereState.selected;if(!graph||!key)return;
  const related=new Map();
  for(const edge of graph.relations.get(key)||[]){
    const other=edge.source===key?edge.target:edge.source;
    if(!related.has(other))related.set(other,[]);
    related.get(other).push(edge);
  }
  const rows=[...related].sort(([a],[b])=>sphereLabel(graph.nodes.get(a).type).localeCompare(sphereLabel(graph.nodes.get(b).type))||graph.nodes.get(a).name.localeCompare(graph.nodes.get(b).name));
  const counts=new Map();for(const [other] of rows){const type=graph.nodes.get(other).type;counts.set(type,(counts.get(type)||0)+1);}
  const pages=Math.max(1,Math.ceil(rows.length/12));sphereState.relationPage=Math.min(pages-1,sphereState.relationPage);
  let lastType='';
  const connections=rows.slice(sphereState.relationPage*12,sphereState.relationPage*12+12).map(([other,edges])=>{
    const node=graph.nodes.get(other),newGroup=node.type!==lastType;lastType=node.type;
    const heading=newGroup?`<li class="sphere-connection-group"><h5><i style="--sphere-color:${sphereColor(node.type)}" aria-hidden="true"></i>${esc(sphereLabel(node.type))}<span>${counts.get(node.type)}</span></h5></li>`:'';
    return heading+`<li><button type="button" onclick="selectSphereRecord('${other}')"><strong>${esc(node.name)} <span aria-hidden="true">↗</span></strong></button>${edges.map(edge=>`<p>${esc(experienceStatus(edge.label))}<small>${edge.origin==='cross_link'?'Saved relationship':edge.origin==='saved_name'?'Planning assignment':edge.origin==='hierarchy'?'Hierarchy':'Linked in the record'}${edge.directed?(edge.source===key?' · From this record':' · To this record'):''}</small></p>${edge.notes?`<details><summary>Connection note</summary><p>${esc(edge.notes)}</p></details>`:''}`).join('')}</li>`;
  }).join('');
  document.getElementById('sphere-connections').innerHTML=rows.length?`<ul class="sphere-connections">${connections}</ul>${pages>1?`<div class="sphere-pagination"><button type="button" onclick="pageSphereConnections(-1)" ${sphereState.relationPage===0?'disabled':''}>Previous</button><span>${sphereState.relationPage+1} / ${pages}</span><button type="button" onclick="pageSphereConnections(1)" ${sphereState.relationPage===pages-1?'disabled':''}>Next</button></div>`:''}`:'<p class="sphere-muted">No saved integrations or connections. Open this record to add a relationship.</p>';
}
function pageSphereConnections(delta){sphereState.relationPage=Math.max(0,sphereState.relationPage+delta);renderSphereConnections();}
async function openSphereRecord(){
  const graph=sphereState.graph,node=graph?.nodes.get(sphereState.selected);if(!node)return;
  try{
    if(node.type==='arch_ai_usecase'){await switchView('architecture');switchArchTab('ai_usecase');await openArchModal(node.id);}
    else if(node.type==='review_output'){
      const edge=graph.relations.get(node.key).find(edge=>edge.label==='Management review');const parent=edge&&graph.nodes.get(edge.target);
      if(parent){await switchView('management-reviews');await openManagementReview(parent.id);await openOutputModal(parent.id,node.id);}else await openRelatedRecord(node.type,node.id);
    }else if(node.type==='checklist'){
      const edge=graph.relations.get(node.key).find(edge=>edge.label==='Audit');const parent=edge&&graph.nodes.get(edge.target);
      if(parent){await switchView('audit-execute');document.getElementById('audit-exec-select').value=parent.id;await loadAuditExecution(parent.id);}else await openRelatedRecord(node.type,node.id);
    }else await openRelatedRecord(node.type,node.id);
  }catch(error){showToast('Could not open record: '+error.message,'error');}
}
function rotateSphere(yaw,pitch){pauseSphereRotation();sphereState.yaw+=yaw;sphereState.pitch=Math.max(-Math.PI/2,Math.min(Math.PI/2,sphereState.pitch+pitch));scheduleSphereDraw();}
function zoomSphere(factor){pauseSphereRotation();sphereState.zoom=Math.max(.5,Math.min(2.6,sphereState.zoom*factor));scheduleSphereDraw();}
function resetSphereCamera(){sphereState.yaw=-.25;sphereState.pitch=.12;sphereState.zoom=1;scheduleSphereDraw();}
function updateSphereRotationButton(){
  const button=document.getElementById('sphere-rotation');
  const label=sphereState.rotating?'Pause rotation':'Resume rotation';button.setAttribute('aria-label',label);button.title=label;
  button.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true">${sphereState.rotating?'<path d="M9 5v14M15 5v14"/>':'<path d="m8 5 11 7-11 7Z"/>'}</svg>`;
}
function pauseSphereRotation(){sphereState.rotating=false;sphereState.lastFrame=0;updateSphereRotationButton();}
function toggleSphereRotation(){sphereState.rotating=!sphereState.rotating;sphereState.lastFrame=0;updateSphereRotationButton();scheduleSphereDraw();}
function scheduleSphereDraw(){
  if(sphereState.frame||!sphereVisible()||sphereState.mode!=='map')return;
  sphereState.frame=requestAnimationFrame(time=>{
    sphereState.frame=0;
    if(!sphereVisible()||sphereState.mode!=='map'){sphereState.lastFrame=0;return;}
    if(sphereState.rotating&&sphereState.scene){
      if(sphereState.lastFrame&&!sphereState.hover)sphereState.yaw+=Math.min(50,Math.max(0,time-sphereState.lastFrame))*.000035;
      sphereState.lastFrame=time;
    }else sphereState.lastFrame=0;
    drawSphere();
    if(sphereState.rotating&&sphereState.scene)scheduleSphereDraw();
  });
}
function sphereHit(x,y){return [...sphereState.projected].reverse().find(point=>Math.hypot(point.x-x,point.y-y)<Math.max(14,point.radius+5));}
function drawSphere(){
  if(!sphereVisible()||sphereState.mode!=='map')return;
  const canvas=document.getElementById('sphere-canvas'),ctx=canvas.getContext('2d');if(!ctx)return;
  const rect=canvas.getBoundingClientRect(),width=rect.width,height=rect.height;if(!width||!height)return;
  const ratio=Math.min(devicePixelRatio||1,2);if(canvas.width!==Math.round(width*ratio)||canvas.height!==Math.round(height*ratio)){canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);}
  ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);
  const detail=document.getElementById('sphere-detail');
  const sceneWidth=!detail.hidden&&!matchMedia('(max-width: 767px)').matches ? Math.max(220,width-detail.getBoundingClientRect().width-28) : width;
  const project=point=>sphereProject(point,sphereState.yaw,sphereState.pitch,sphereState.zoom,sceneWidth,height);
  // Quiet spherical guides. All points and lines below come from the real graph.
  ctx.lineWidth=.7;ctx.strokeStyle='rgba(150,196,205,.085)';
  for(let ring=0;ring<5;ring++){
    ctx.beginPath();for(let i=0;i<=100;i++){const a=i*Math.PI*2/100,b=ring*Math.PI/5;const p=project({x:Math.cos(a)*Math.cos(b),y:Math.sin(a),z:Math.cos(a)*Math.sin(b)});if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);}ctx.stroke();
  }
  for(const latitude of [-.6,0,.6]){ctx.beginPath();for(let i=0;i<=100;i++){const a=i*Math.PI*2/100,r=Math.sqrt(1-latitude*latitude);const p=project({x:Math.cos(a)*r,y:latitude,z:Math.sin(a)*r});if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);}ctx.stroke();}
  if(!sphereState.scene){sphereState.projected=[];return;}
  const scene=sphereState.scene,focus=sphereState.hover||sphereState.selected;
  const points=scene.nodes.map(node=>({...node,...project(node.position)})).sort((a,b)=>a.z-b.z);
  const byKey=new Map(points.map(point=>[point.key,point]));
  const connected=new Set([focus]);for(const edge of scene.edges)if(edge.source===focus||edge.target===focus){connected.add(edge.source);connected.add(edge.target);}
  // Bounded visual edge density; the complete relationships remain in details.
  const visibleEdges=focus?scene.edges.filter(edge=>edge.source===focus||edge.target===focus):scene.edges;
  const stride=Math.max(1,Math.ceil(visibleEdges.length/2200));
  for(let i=0;i<visibleEdges.length;i+=stride){const edge=visibleEdges[i],a=byKey.get(edge.source),b=byKey.get(edge.target);if(!a||!b)continue;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.lineWidth=focus?1.25:Math.min(1.2,.45+Math.log2(edge.count+1)*.12);ctx.strokeStyle=focus?'rgba(119,222,198,.65)':'rgba(158,196,205,.19)';ctx.stroke();}
  const nodeLabels=[];
  for(const point of points){
    const selected=point.key===sphereState.selected,hovered=point.key===sphereState.hover,cluster=point.members.length>1;
    point.radius=(cluster?Math.min(18,9+Math.log2(point.members.length)):point.type==='process'?6:3.2+Math.min(3,Math.sqrt(point.degree)*.55))*point.perspective;
    const opacity=focus&&!connected.has(point.key) ? .22 : Math.max(.45,(point.z+1.7)/2.7);ctx.globalAlpha=opacity;
    ctx.fillStyle=sphereColor(point.recordType||point.type);ctx.shadowColor=sphereColor(point.recordType||point.type);ctx.shadowBlur=selected||hovered?20:cluster?13:7;
    ctx.beginPath();ctx.arc(point.x,point.y,point.radius,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
    if(selected||hovered){ctx.strokeStyle='#e3fff6';ctx.lineWidth=1.2;ctx.beginPath();ctx.arc(point.x,point.y,point.radius+5,0,Math.PI*2);ctx.stroke();}
    if(cluster){ctx.fillStyle='#15342f';ctx.font='600 10px system-ui';ctx.textAlign='center';ctx.fillText(String(point.members.length),point.x,point.y+3.5);}
    if(selected||hovered||cluster||(focus&&connected.has(point.key)))nodeLabels.push({point,selected,opacity});
    ctx.globalAlpha=1;
  }
  const occupied=[];
  for(const {point,selected,opacity} of nodeLabels.sort((a,b)=>Number(b.selected)-Number(a.selected)||b.point.z-a.point.z)){
    const name=point.name.length>34?point.name.slice(0,33)+'…':point.name;
    ctx.font=(selected?'600':'500')+' 11px system-ui';ctx.textAlign='center';
    const w=ctx.measureText(name).width+14,x=Math.max(w/2+6,Math.min(sceneWidth-w/2-6,point.x));
    const base=point.y+point.radius+19;let y=Math.max(20,Math.min(height-12,base));
    for(let attempt=0;attempt<30&&occupied.some(label=>Math.abs(label.y-y)<20&&Math.abs(label.x-x)<(label.w+w)/2);attempt++){
      y=Math.max(20,Math.min(height-12,base+(attempt%2?1:-1)*Math.ceil((attempt+1)/2)*21));
    }
    occupied.push({x,y,w});ctx.globalAlpha=opacity;
    if(Math.abs(y-base)>8){ctx.beginPath();ctx.moveTo(point.x,point.y);ctx.lineTo(x,y-8);ctx.strokeStyle='rgba(174,209,201,.35)';ctx.lineWidth=.6;ctx.stroke();}
    ctx.fillStyle='rgba(12,29,39,.9)';ctx.fillRect(x-w/2,y-12,w,18);ctx.fillStyle='#deebe9';ctx.fillText(name,x,y);ctx.globalAlpha=1;
  }
  if(!focus){
    const labels=[];ctx.font='500 11px system-ui';ctx.textAlign='center';
    for(const region of [...scene.regions].sort((a,b)=>project(b.position).z-project(a.position).z)){
      const p=project(region.position),text=sphereLabel(region.type),w=ctx.measureText(text).width+12;
      const x=Math.max(w/2+12,Math.min(sceneWidth-w/2-12,p.x));let y=Math.max(78,Math.min(height-20,p.y));
      for(let attempts=0;attempts<12 && labels.some(label=>Math.abs(label.y-y)<19&&Math.abs(label.x-x)<(label.w+w)/2);attempts++)y+=20;
      if(y>height-15)continue;
      labels.push({x,y,w});ctx.globalAlpha=Math.max(.5,(p.z+1.7)/2.7);ctx.fillStyle='rgba(12,29,39,.7)';ctx.fillRect(x-w/2,y-12,w,18);ctx.fillStyle=sphereColor(region.type);ctx.fillText(text,x,y);ctx.globalAlpha=1;
    }
  }
  sphereState.projected=points;
}
