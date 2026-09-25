// Pure graph operations shared by the canvas and the accessible record list.
function sphereIndex(data) {
  const nodes = new Map(data.nodes.map(node => [node.key, { ...node }]));
  const neighbors = new Map([...nodes.keys()].map(key => [key, new Set()]));
  const relations = new Map([...nodes.keys()].map(key => [key, []]));
  const edges = data.edges.filter(edge => nodes.has(edge.source) && nodes.has(edge.target));
  for (const edge of edges) {
    neighbors.get(edge.source).add(edge.target); neighbors.get(edge.target).add(edge.source);
    relations.get(edge.source).push(edge); relations.get(edge.target).push(edge);
  }
  const processes = [...nodes.values()].filter(node => node.type === 'process').sort((a,b) => a.name.localeCompare(b.name) || a.id-b.id);
  // Each record type occupies its own region. Only saved edges join regions.
  for (const node of nodes.values()) {
    node.group = `type:${node.type}`;
    node.degree=neighbors.get(node.key).size;
  }
  return { ...data, nodes, neighbors, relations, edges, processes };
}
function sphereNeighborhood(graph, start, depth = Infinity, stopAtProcesses = false) {
  const found=new Set(); if (!graph.nodes.has(start)) return found;
  found.add(start); const queue=[[start,0]];
  for (let i=0;i<queue.length;i++) {
    const [key,distance]=queue[i];
    if (distance>=depth || (stopAtProcesses && key!==start && graph.nodes.get(key).type==='process')) continue;
    for (const other of graph.neighbors.get(key)) if (!found.has(other)) { found.add(other); queue.push([other,distance+1]); }
  }
  return found;
}
function sphereFilter(graph, {search='',type='',process='',focus='',depth=1,drill=null}={}) {
  const query=search.trim().toLowerCase();
  const scope=process ? sphereNeighborhood(graph,process,Infinity,true) : null;
  const local=focus ? sphereNeighborhood(graph,focus,depth) : null;
  return [...graph.nodes.values()].filter(node => (!type || node.type===type) && (!query || `${node.name} ${node.type} ${node.status}`.toLowerCase().includes(query)) && (!scope || scope.has(node.key)) && (!local || local.has(node.key)) && (!drill || drill.has(node.key)));
}
function spherePoint(index,count,radius=1) {
  const y=1-2*(index+.5)/Math.max(1,count), angle=index*Math.PI*(3-Math.sqrt(5));
  const r=Math.sqrt(1-y*y)*radius;
  return {x:Math.cos(angle)*r,y:y*radius,z:Math.sin(angle)*r};
}
function sphereScene(graph, records, selected='', maxNodes=180, expanding=false) {
  let visual=records.map(node=>({...node,members:[node.key]}));
  if (visual.length>maxNodes) {
    const groups=new Map();
    const typeCount=new Set(records.map(node=>node.type)).size;
    const visibleKeys=new Set(records.map(node=>node.key));
    const individual=new Set([selected,...(graph.neighbors.get(selected)||[])].filter(key=>visibleKeys.has(key)).slice(0,Math.max(1,maxNodes-typeCount)));
    for (const node of visual) {
      const key=individual.has(node.key) ? node.key : node.group;
      if (!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(node);
    }
    visual=[...groups].map(([key,members])=>members.length===1 ? members[0] : ({key:`cluster:${key}`,name:graph.nodes.get(key)?.name || graph.types.find(type=>`type:${type.type}`===key)?.label || 'Records',group:key,recordType:members[0].type,type:'cluster',members:members.map(node=>node.key),degree:0}));
    if (visual.length>maxNodes || expanding || visual.length===1) {
      // A bounded scene even when every record is a separate process. No records
      // are discarded: each range can be expanded and remains in the list/search.
      const size=Math.ceil(records.length/Math.min(60,maxNodes)); visual=[];
      for(let i=0;i<records.length;i+=size) visual.push({key:`cluster:range:${i}`,name:`Records ${i+1}–${Math.min(i+size,records.length)}`,type:'cluster',group:`range:${i}`,members:records.slice(i,i+size).map(node=>node.key),degree:0});
    }
  }
  const groups=[...new Set(visual.map(node=>node.group))].sort();
  const regions=[];
  for (const [index,group] of groups.entries()) {
    const center=groups.length===1 ? {x:0,y:0,z:0} : spherePoint(index,groups.length,.66);
    const members=visual.filter(node=>node.group===group);
    if(groups.length>1 && members.length>1 && group.startsWith('type:')) regions.push({type:group.slice(5),position:{...center,y:center.y+.22},count:members.reduce((n,node)=>n+node.members.length,0)});
    members.sort((a,b)=>a.key.localeCompare(b.key));
    members.forEach((node,i)=>{
      const radius=groups.length===1 ? .83 : Math.min(.32,.14+Math.sqrt(members.length)*.012);
      const offset=members.length===1 && groups.length>1 ? {x:0,y:0,z:0} : spherePoint(i,members.length,radius);
      node.position={x:center.x+offset.x,y:center.y+offset.y,z:center.z+offset.z};
    });
  }
  const membership=new Map();
  for (const node of visual) for (const member of node.members) membership.set(member,node.key);
  const links=new Map();
  for (const edge of graph.edges) {
    const source=membership.get(edge.source),target=membership.get(edge.target);
    if (!source || !target || source===target) continue;
    const key=[source,target].sort().join('|');
    if (!links.has(key)) links.set(key,{source,target,count:0});
    links.get(key).count++;
  }
  return {nodes:visual,edges:[...links.values()],regions};
}
function sphereProject(point,yaw,pitch,scale,width,height) {
  const x=point.x*Math.cos(yaw)+point.z*Math.sin(yaw);
  const z=-point.x*Math.sin(yaw)+point.z*Math.cos(yaw);
  const y=point.y*Math.cos(pitch)-z*Math.sin(pitch);
  const depth=point.y*Math.sin(pitch)+z*Math.cos(pitch);
  const perspective=3.4/(3.4-depth);
  const radius=Math.min(width,height)*.37*scale;
  return {x:width/2+x*radius*perspective,y:height/2-y*radius*perspective,z:depth,perspective};
}
