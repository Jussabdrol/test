const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname,'../..');
function fixture() {
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,{
    value:'',innerHTML:'',textContent:'',hidden:false,open:false,dataset:{},
    setAttribute(name,value){this[name]=value;},showModal(){this.open=true;},close(){this.open=false;},classList:{add(){},remove(){}},
  }]));
  const context=vm.createContext({
    document:{getElementById:id=>elements.get(id)},currentView:'operational-tasks',
    opPlanContext:{type:'all',id:null},opPlanBundles:[],opPlanProcesses:[],
    getOpPlanContextNames:()=>null,selectExperienceTab(){},renderOpPlanContextBar(){},
    hasPermissionForView:()=>true,showToast(){},URLSearchParams,
    esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    api:async()=>[],actionMenu:()=>'',
  });
  for(const name of ['layout','tasks','actions','workspace'])vm.runInContext(fs.readFileSync(path.join(root,`src/client/operations/${name}.js`),'utf8'),context);
  return {context,elements};
}
function run(context,code){return vm.runInContext(code,context);}
const ticket={id:11,task_id:3,task_title:'Access review',task_category:'Security, privacy',task_assignee:'Owner',task_priority:'High',scheduled_date:'2026-01-01',status:'pending',action_count:1,open_action_count:1};
const action={id:20,task_id:3,instance_id:11,task_title:'Access review',title:'Revoke access',assignee:'Owner',priority:'High',status:'open',due_date:'2026-01-02',instance_scheduled_date:'2026-01-01'};

test('shared filters and separate statuses keep ticket and follow-up views consistent',()=>{
  const {context,elements}=fixture();
  context.tickets=[ticket,{...ticket,id:12,task_assignee:'HR'}];context.actions=[action,{...action,id:21,status:'closed'}];
  run(context,"workTickets=tickets;workActions=actions;workFilters={search:'access',assignee:'Owner',priority:'High',series:'3'};renderWorkTickets();renderWorkActions()");
  assert.match(elements.get('task-log-summary').innerHTML,/1 tickets shown/);
  assert.match(elements.get('work-action-summary').textContent,/1 actions shown/);
  assert.match(elements.get('task-log-table-body').innerHTML,/openControlTicket\(11\)/);
  assert.match(elements.get('action-table-body').innerHTML,/Ticket #11 · 2026-01-01/);
  run(context,"workActionStatus='closed';renderWorkActions()");
  assert.match(elements.get('action-table-body').innerHTML,/closed/);
  assert.equal(run(context,'workTicketStatus'),'pending');
});

test('searching ticket notes and completer does not reload or replace the search controls',()=>{
  const {context,elements}=fixture();context.tickets=[{...ticket,status:'completed',notes:'Account removed',completed_by:'Tester'}];
  let calls=0;context.api=async()=>{calls++;return [];};
  elements.get('work-filters').innerHTML='input with focus';
  run(context,"workTickets=tickets;workTicketStatus='completed';workFilters.search='removed';workCompletedBy='test';renderWorkTickets()");
  assert.equal(calls,0);assert.equal(elements.get('work-filters').innerHTML,'input with focus');
  assert.match(elements.get('task-log-summary').innerHTML,/1 tickets shown/);
});

test('opening a tickets follow-ups includes resolved actions and restores previous shared filters',async()=>{
  const {context,elements}=fixture();context.actions=[action,{...action,id:21,status:'resolved'}];
  run(context,"workTab='followups';workFilters.search='unrelated';workFilters.assignee='Another owner';workActionSource={id:11,task_title:'Access review',scheduled_date:'2026-01-01'};workActions=actions;renderWorkChrome();renderWorkActions()");
  assert.equal(elements.get('work-filter-panel').hidden,true);
  assert.match(elements.get('work-action-summary').textContent,/2 actions shown/);
  context.api=async()=>context.actions;
  await run(context,'clearWorkSource()');
  assert.equal(elements.get('work-filter-panel').hidden,false);
  assert.equal(run(context,'workFilters.search'),'unrelated');
  assert.match(elements.get('work-action-summary').textContent,/0 actions shown/);
});

test('late ticket responses cannot overwrite a newer status selection',async()=>{
  const {context,elements}=fixture();const pending=[];
  context.api=url=>new Promise(resolve=>pending.push({url,resolve}));
  const first=run(context,'loadWorkTickets()');
  const second=run(context,"workTicketStatus='completed';loadWorkTickets()");
  assert.match(pending[1].url,/status=completed/);
  pending[1].resolve([{...ticket,status:'completed'}]);await second;
  pending[0].resolve([ticket]);await first;
  assert.match(elements.get('task-log-table-body').innerHTML,/Completed/);
  assert.doesNotMatch(elements.get('task-log-table-body').innerHTML,/>Complete<\/button>/);
});

test('empty bundle and invalid date range never request or display unrelated control tickets',async()=>{
  const {context,elements}=fixture();let calls=0;context.api=async()=>{calls++;return [ticket];};
  context.getOpPlanContextNames=()=>[];
  await run(context,'loadWorkTickets()');assert.equal(calls,0);
  assert.match(elements.get('task-log-table-body').innerHTML,/No control tickets match/);
  await run(context,"workDates={from:'2026-10-01',to:'2026-09-01'};loadWorkTickets()");
  assert.equal(calls,0);assert.match(elements.get('task-log-table-body').innerHTML,/end date on or after/);
});

test('failed loads clear stale results and expose a retry',async()=>{
  const {context,elements}=fixture();context.tickets=[ticket];run(context,'workTickets=tickets;renderWorkTickets()');
  context.api=async()=>{throw new Error('Unavailable');};
  await run(context,'loadWorkTickets()');
  run(context,"workFilters.search='x';renderWorkTickets()");
  assert.match(elements.get('task-log-table-body').innerHTML,/Unavailable.*Retry/);
  assert.doesNotMatch(elements.get('task-log-table-body').innerHTML,/Access review/);
});

test('ticket detail escapes notes and cannot reopen after it was closed while loading',async()=>{
  const {context,elements}=fixture();
  context.api=async url=>url.includes('/api/actions')?[action]:{...ticket,notes:'<img src=x onerror=bad()>',evidence_files:'[]'};
  await run(context,'openControlTicket(11)');
  assert.match(elements.get('control-ticket-content').innerHTML,/&lt;img/);
  assert.doesNotMatch(elements.get('control-ticket-content').innerHTML,/<img/);
  let release;context.api=url=>url.includes('/api/actions')?Promise.resolve([]):new Promise(resolve=>{release=resolve;});
  const promise=run(context,'openControlTicket(12)');run(context,'closeControlTicket()');release({...ticket,id:12});await promise;
  assert.equal(elements.get('control-ticket-dialog').open,false);
  assert.doesNotMatch(elements.get('control-ticket-content').innerHTML,/Access review/);
});

test('follow-up creation targets the authoritative instance and shows its scheduled date',async()=>{
  const {context,elements}=fixture();
  context.api=async()=>ticket;context.openActionModal=async()=>{};
  await run(context,'createFollowUpForInstance(11,999)');
  assert.equal(elements.get('action-instance-id').value,11);
  assert.equal(elements.get('action-task-id').value,3);
  assert.match(elements.get('action-source-ticket').textContent,/2026-01-01/);
});


test('collapsing extra filters keeps restrictions visible and reset clears the summary',async()=>{
  const {context,elements}=fixture();context.tickets=[ticket];
  elements.get('work-extra-filters').hidden=true;
  run(context,"workTickets=tickets;workFilters.assignee='Owner';workFilters.priority='High';renderWorkPanel();togglePlanningFilters('work')");
  assert.equal(elements.get('work-filter-toggle')['aria-expanded'],'true');
  run(context,"togglePlanningFilters('work')");
  assert.equal(elements.get('work-extra-filters').hidden,true);
  assert.equal(elements.get('work-filter-toggle')['aria-expanded'],'false');
  assert.equal(elements.get('work-filter-toggle').textContent,'More filters (2)');
  assert.equal(elements.get('work-active-filters').textContent,'Role: Owner · Priority: High');
  assert.match(elements.get('task-log-summary').innerHTML,/1 tickets shown/);
  await run(context,'resetWorkFilters()');
  assert.equal(elements.get('work-active-filters').hidden,true);
  assert.equal(elements.get('work-filter-toggle').textContent,'More filters');
});
