const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

// Use the actual page's element IDs. A fixture that invented IDs would miss a
// broken modal even though all HTTP workflows passed.
function pageContext() {
  const ids = [...fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  const elements = new Map(ids.map(id => [id, {
    value: '', textContent: '', innerHTML: '', dataset: {}, style: {},
    classList: { remove() {}, add() {} },
  }]));
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id) || null },
    currentUser: { name: 'Tester' }, esc: String,
    lastInstanceContext: null,
    api: async url => url.includes('/task-instances/')
      ? { id: 42, task_id: 5, task_title: 'Access review', scheduled_date: '2026-04-30', notes: 'Retain existing work' }
      : [],
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/client/operations/layout.js'), 'utf8'), context);
  return { context, elements };
}

test('opening an execution from the plan uses real page controls and preserves its date and notes', async () => {
  const { context, elements } = pageContext();
  vm.runInContext(fs.readFileSync(path.join(root, 'src/client/operations/tasks.js'), 'utf8'), context);
  await vm.runInContext('openInstanceCompleteModal(42)', context);
  assert.equal(elements.get('complete-form').dataset.instanceId, 42);
  assert.match(elements.get('complete-modal-title').textContent, /Access review.*2026-04-30/);
  assert.equal(elements.get('complete-notes').value, 'Retain existing work');
});

test('a stale date selection never falls back to completing a different occurrence', async () => {
  const { context } = pageContext();
  let fallback = false, refreshed = false;
  Object.assign(context, {
    api: async () => [], showToast() {},
    openCompleteModal: () => { fallback = true; },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/client/operations/yearly-plan.js'), 'utf8'), context);
  context.loadYearlyPlan = () => { refreshed = true; };
  await vm.runInContext("quickComplete(5, '2026-04-30')", context);
  assert.equal(fallback, false);
  assert.equal(refreshed, true);
});

function planningContext() {
  const {context,elements} = pageContext();
  Object.assign(context, {
    filters: {active:'true',search:'',priority:'',assignee:''}, yearlyFilters:{status:''},
    yearlyYear:2026, yearlyData:null, yearlyUpcomingCache:[], currentView:'yearly',
    allTasks:[], meta:{assignees:[]}, getOpPlanContextNames:()=>null,
    selectExperienceTab(){}, renderGanttChart(){}, renderOpPlanContextBar(){},
  });
  context.document.removeEventListener=()=>{};
  vm.runInContext(fs.readFileSync(path.join(root,'src/client/operations/tasks.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(root,'src/client/operations/yearly-plan.js'),'utf8'),context);
  return {context,elements};
}
const samplePlan = {
  dueDates:{'2026-01-01':[
    {task_id:1,title:'Access review',category:'Security, privacy',assignee:'Owner',priority:'High',recurrence:'monthly',status:'completed'},
    {task_id:2,title:'Onboarding',category:'People',assignee:'HR',priority:'Low',recurrence:'monthly',status:'pending'},
  ],'2026-02-01':[{task_id:1,title:'Access review',category:'Security, privacy',assignee:'Owner',priority:'High',recurrence:'monthly',status:'pending'}]},
  completedDates:{'2026-01-01':[{task_id:1,title:'Access review',category:'Security, privacy',assignee:'Owner',priority:'High',recurrence:'monthly',status:'completed'}]},
};

test('shared scope, search, role and priority filter the timeline, totals and upcoming work together',()=>{
  const {context,elements}=planningContext();
  context.plan=structuredClone(samplePlan);
  context.getOpPlanContextNames=()=>['Security, privacy'];
  Object.assign(context.filters,{search:' OWNER ',assignee:'Owner',priority:'High'});
  let chart;
  context.renderGanttChart=(data)=>{chart=data;};
  vm.runInContext('yearlyRawData=plan;renderYearlyPlan()',context);
  assert.equal(chart.dueDates['2026-01-01'].length,1);
  assert.equal(chart.completedDates['2026-01-01'].length,1);
  const values=[...elements.get('yearly-summary').innerHTML.matchAll(/<dd>([^<]+)/g)].map(m=>m[1]);
  assert.deepEqual(values,['2','1','1','0','50%']);
  assert.match(elements.get('yearly-upcoming').innerHTML,/Access review/);
  assert.doesNotMatch(elements.get('yearly-upcoming').innerHTML,/Onboarding/);
  assert.equal(context.plan.dueDates['2026-01-01'].length,2,'raw data remains reusable');
});

test('empty bundle scope shows no occurrences and completed status keeps scheduled-date outcomes',()=>{
  const {context}=planningContext();
  context.plan=samplePlan;
  context.getOpPlanContextNames=()=>[];
  assert.equal(Object.keys(vm.runInContext('filterYearlyData(plan).dueDates',context)).length,0);
  context.getOpPlanContextNames=()=>null;
  context.yearlyFilters.status='completed';
  const data=vm.runInContext('filterYearlyData(plan)',context);
  assert.equal(Object.keys(data.dueDates).length,1);
  assert.equal(data.dueDates['2026-01-01'][0].task_id,1);
  assert.equal(data.completedDates['2026-01-01'][0].task_id,1);
});

test('series status is independent of occurrence status and reset clears both tabs and scope',()=>{
  const {context,elements}=planningContext();
  context.allTasks=[{id:1,title:'Inactive control',is_active:0,category:'People',priority:'Low',recurrence:'monthly',next_due:'2026-01-01'}];
  context.actionMenu=()=>'';
  context.filters.active='false';
  context.yearlyFilters.status='completed';
  vm.runInContext("yearlyTab='series';renderTaskTable()",context);
  assert.match(elements.get('task-table-body').innerHTML,/Inactive control/);
  context.filters.search='Nothing';
  context.opPlanContext={type:'bundle',id:4};
  vm.runInContext('resetPlanningFilters()',context);
  assert.equal(context.filters.search,'');
  assert.equal(context.filters.active,'true');
  assert.equal(context.yearlyFilters.status,'');
  assert.equal(context.opPlanContext.type,'all');
  assert.match(elements.get('task-table-body').innerHTML,/No series match/);
});

test('an older year response cannot replace the most recently selected timeline',async()=>{
  const {context,elements}=planningContext();
  const requests=new Map();
  context.api=url=>url==='/api/meta'?Promise.resolve({assignees:[]}):new Promise(resolve=>requests.set(url,resolve));
  const old=vm.runInContext('loadYearlyPlan()',context);
  const latest=vm.runInContext('yearlyYear=2027;loadYearlyPlan()',context);
  requests.get('/api/yearly?year=2027')({dueDates:{},completedDates:{}});
  await latest;
  requests.get('/api/yearly?year=2026')(samplePlan);
  await old;
  assert.match(elements.get('yearly-summary').innerHTML,/2027/);
  assert.equal(Object.keys(context.yearlyData.dueDates).length,0);
});

test('filters survive tab switches and series refresh after returning to the tab',async()=>{
  const {context}=planningContext();
  const calls=[];
  context.api=async url=>{calls.push(url);return url==='/api/meta'?{assignees:['Owner']}:url==='/api/tasks'?[]:samplePlan;};
  Object.assign(context.filters,{search:'access',priority:'High',assignee:'Owner'});
  await vm.runInContext("selectYearlyTab('series');",context);
  await vm.runInContext("selectYearlyTab('timeline');",context);
  await vm.runInContext("selectYearlyTab('series');",context);
  assert.equal(context.filters.search,'access');
  assert.equal(context.filters.priority,'High');
  assert.equal(context.filters.assignee,'Owner');
  assert.equal(calls.filter(url=>url==='/api/tasks').length,2);
});
