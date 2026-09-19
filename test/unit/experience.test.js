const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
function fixture(api) {
  const html = fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([,id]) => [id,{hidden:true,innerHTML:'',querySelector:()=>({focus(){}}),scrollIntoView(){}}]));
  const context = vm.createContext({
    document:{getElementById:id=>elements.get(id),activeElement:{isConnected:true,focus(){}}},
    esc:value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    hasPermissionForView:()=>true, api, relationshipViews:{risk:'risk-identification',document:'document-control'},linkableTypes:{document:{label:'Document'}},
  });
  vm.runInContext(fs.readFileSync(path.join(root,'src/client/risks.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(root,'src/client/experience.js'),'utf8'),context);
  return {context,elements};
}
test('risk dossier preserves assessment fields, treatment status and escaped linked metadata',async()=>{
  const {context,elements}=fixture(async url=>url.includes('cross-links')?[{type:'document',id:2,name:'Policy <img src=x onerror=alert(1)>'}]:{id:1,title:'Risk <script>bad</script>',description:'Description',likelihood:4,impact:5,inherent_score:20,status:'treating',risk_owner:'Security',source:'Audit',threat:'Access',vulnerability:'Permissions',treatments:[{id:3,description:'Review & confirm',responsible:'Owner',status:'verified'}]});
  await vm.runInContext('openRiskDossier(1)',context);
  const html=elements.get('risk-dossier').innerHTML;
  assert.match(html,/Critical inherent risk · 20/);assert.match(html,/Treating/);assert.match(html,/Verified/);
  assert.match(html,/Risk &lt;script&gt;/);assert.doesNotMatch(html,/<script>|<img/i);
  assert.match(html,/openRiskModal\(1\)/);assert.match(html,/openTreatmentModal\(3\)/);assert.match(html,/openRelatedRecord\('document',2\)/);
});
test('document dossier uses the existing list API and keeps approval separate from overdue review',async()=>{
  const calls=[];
  const {context,elements}=fixture(async url=>{calls.push(url);return url==='/api/documents'?[{id:4,title:'Policy',status:'approved',version:'2.3',review_date:'2000-01-01',classification:'internal'}]:[];});
  await vm.runInContext('openDocumentDossier(4)',context);
  assert.deepEqual(calls,['/api/documents','/api/cross-links/document/4']);
  const html=elements.get('document-dossier').innerHTML;
  assert.match(html,/Approved/);assert.match(html,/Review overdue/);assert.match(html,/Version 2.3/);assert.match(html,/openDocModal\(4\)/);
});
test('closing a dossier while its request is pending cannot reopen it with stale data',async()=>{
  let release;
  const {context,elements}=fixture(url=>url.includes('cross-links')?Promise.resolve([]):new Promise(resolve=>{release=resolve;}));
  const pending=vm.runInContext('openRiskDossier(1)',context);
  vm.runInContext("closeExperienceDossier('risk',false)",context);
  release({id:1,title:'Old response',inherent_score:9,treatments:[]}); await pending;
  assert.equal(elements.get('risk-dossier').hidden,true);assert.equal(elements.get('risk-dossier').innerHTML,'');
});
test('dossier refuses inaccessible modules and invalid record IDs before requesting data',async()=>{
  let calls=0;const {context}=fixture(async()=>{calls++;return [];});
  context.hasPermissionForView=()=>false;
  await vm.runInContext('openRiskDossier(1);openDocumentDossier(2)',context);
  context.hasPermissionForView=()=>true;
  await vm.runInContext("openRiskDossier('1;bad');openDocumentDossier(-1)",context);
  assert.equal(calls,0);
});
test('permission-limited Mission Control does not render inaccessible KPI domains',()=>{
  const {context,elements}=fixture(async()=>[]);
  context.hasPermissionForView=view=>['document-control','architecture','use-cases'].includes(view);
  context.values={docs_due_review:2,total_documents:6};
  vm.runInContext('renderMissionExperience(values)',context);
  assert.match(elements.get('experience-mission-metrics').innerHTML,/Documents due review/);
  assert.doesNotMatch(elements.get('experience-mission-metrics').innerHTML,/High \/ critical|Overdue tasks|non-conformities/);
  assert.doesNotMatch(elements.get('auto-kpi-grid').innerHTML,/Task Management|Risk &amp; controls|Audits &amp; Compliance/);
});
