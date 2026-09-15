const { test }=require('node:test');
const assert=require('node:assert/strict');
const {computeNextDue}=require('../../src/server/services/recurrence');
test('calendar recurrence handles month ends, leap years, Sundays and invalid intervals',()=>{
  for(const [from,recurrence,expected] of [['2026-01-31','monthly','2026-02-28'],['2024-01-31','monthly','2024-02-29'],['2024-02-29','yearly','2025-02-28'],['2026-11-30','quarterly','2027-02-28']]) assert.equal(computeNextDue(from,recurrence),expected);
  assert.equal(computeNextDue('2026-02-28','monthly',null,null,31),'2026-03-31');
  assert.equal(computeNextDue('2026-09-14','weekly',null,0),'2026-09-27');
  assert.throws(()=>computeNextDue('2026-02-31','daily'));
  assert.throws(()=>computeNextDue('2026-01-01','custom',-2));
});
