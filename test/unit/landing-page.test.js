const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync('src/client/init.js','utf8');
for(const allowed of [true,false])test(`authenticated landing routes to ${allowed?'Mission Control':'My Tasks'}`,async()=>{
 const views=[];let initialized=0;
 const context=vm.createContext({document:{readyState:'complete'},userReady:Promise.resolve(false),initializeExperience(){initialized++;},hasPermissionForView:()=>allowed,switchView:async view=>views.push(view),showToast:()=>assert.fail('Unexpected load error')});
 vm.runInContext(source,context);await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(views,[allowed?'mission-control':'my-tasks']);assert.equal(initialized,1);
});
test('superadmin without an organization stays in the MSP portal',async()=>{
 const context=vm.createContext({document:{readyState:'complete'},userReady:Promise.resolve(true),initializeExperience:()=>assert.fail('Organization UI initialized'),switchView:()=>assert.fail('MSP context lost')});
 vm.runInContext(source,context);await new Promise(resolve=>setImmediate(resolve));
});
test('Mission Control access is checked even though its shortcut is outside the module tree',()=>{
 const core=fs.readFileSync('src/client/core.js','utf8');
 const permissionCode=core.slice(core.indexOf('const VIEW_TO_MODULE = {}'),core.indexOf('function showViewLoadingState'));
 for(const permissions of ['["org"]','["ops"]','["risk"]','["audit"]','[]']){
  const context=vm.createContext({document:{querySelectorAll:()=>[]},PERM_TO_MODULE:{org:'org-planning',ops:'operational-planning',risk:'risk-management',audit:'audits'},isSuperadmin:false,currentUser:{role:'viewer',permissions}});
  vm.runInContext(permissionCode,context);
  assert.equal(vm.runInContext("hasPermissionForView('mission-control')",context),permissions==='["org"]');
  assert.equal(vm.runInContext("hasPermissionForView('my-tasks')",context),true);
 }
});
