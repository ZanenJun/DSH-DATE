import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CalendarStore,atomicJSON} from '../src/store.js';
import {readStorageSync,partition} from '../src/storage-layout.js';
import {goalInput} from '../src/routines.js';
import {editable} from '../src/model.js';

const goal={title:'读完一本书',deadlineDate:'2026-11-02',dailyTitle:'阅读一小节',defaultStartTime:'09:30',defaultDurationMinutes:45};
const daily={title:'每日运动',defaultStartTime:'10:00',defaultDurationMinutes:30};
const habit={title:'喝水',defaultTime:'10:00'};
async function fixture(t,initial='2026-10-31T07:59:00+08:00') {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calendar-goals-'));
  let now=Date.parse(initial);
  const store=await new CalendarStore(dir,{clock:()=>now}).open();
  t.after(async()=>{await store.close();await fs.rm(dir,{recursive:true,force:true});});
  return {dir,store,setNow:value=>{now=Date.parse(value);},read:async name=>JSON.parse(await fs.readFile(path.join(dir,name),'utf8'))};
}

test('goal input requires a real deadline and explicit daily work, rejects readonly fields and late endings',()=>{
  assert.equal(goalInput.parse(goal).status,'open');
  for(const key of ['deadlineDate','dailyTitle','defaultStartTime','defaultDurationMinutes']) {
    const missing={...goal};delete missing[key];assert.throws(()=>goalInput.parse(missing));
  }
  for(const bad of [{...goal,deadlineDate:'2026-02-29'},{...goal,deadlineDate:'2026-2-03'},
    {...goal,dailyTitle:' '},{...goal,defaultDurationMinutes:1441},{...goal,defaultDurationMinutes:'45'},
    {...goal,defaultStartTime:'24:00'},{...goal,startDate:'2026-10-01'},{...goal,status:'complete'},
    {...goal,goalId:'forged'},{...goal,defaultStartTime:'23:30',defaultDurationMinutes:31}])assert.throws(()=>goalInput.parse(bad));
  assert.equal(goalInput.parse({...goal,defaultStartTime:'23:30',defaultDurationMinutes:30}).defaultDurationMinutes,30);
  const dst={...goal,timeZone:'America/New_York',deadlineDate:'2026-03-08',defaultStartTime:'00:00'};
  assert.equal(goalInput.parse({...dst,defaultDurationMinutes:1380}).defaultDurationMinutes,1380);
  assert.throws(()=>goalInput.parse({...dst,defaultDurationMinutes:1381}));
});

test('goals, generated monthly tasks, generation markers and conversation text use separate files',async t=>{
  const {dir,store,read,setNow}=await fixture(t);
  const saved=await store.saveRoutine({collection:'goals',id:'reading',item:goal});
  assert.equal(saved.startDate,'2026-10-31');
  await store.transact(d=>{d.memory.push({type:'user-reply',text:'PRIVATE_REPLY'});});
  setNow('2026-10-31T08:00:00+08:00');const [instance]=await store.generateDailies();
  assert.equal(instance.title,goal.dailyTitle);assert.equal(instance.kind,'todo');assert.equal(instance.recurrence,null);
  assert.equal(instance.goalId,'reading');assert.equal(instance.goalDate,'2026-10-31');
  assert.equal((await read('goals.json')).items.reading.deadlineDate,goal.deadlineDate);
  assert.equal((await read('calendar/2026-10.json')).items[instance.id].goalId,'reading');
  const state=await read('state.json');assert.equal(state.goals,undefined);assert.equal(state.items,undefined);
  assert.equal(state.goalGenerations['reading:2026-10-31'],instance.id);
  for(const name of ['goals.json','calendar/2026-10.json'])assert.doesNotMatch(await fs.readFile(path.join(dir,name),'utf8'),/PRIVATE_REPLY/);
  assert.equal((await fs.stat(path.join(dir,'goals.json'))).mode&0o777,0o600);
  const before=store.snapshot();await store.close();await store.open();assert.deepEqual(store.snapshot(),before);
});

test('goal generation starts at local 08:00, includes deadline day and catches up only today across months',async t=>{
  const {store,setNow,read}=await fixture(t);
  await store.saveRoutine({collection:'goals',id:'reading',item:goal});
  assert.deepEqual(await store.generateDailies(),[]);
  setNow('2026-10-31T08:00:00+08:00');const [first]=await store.generateDailies();
  assert.equal(first.dueAt,'2026-10-31T01:30:00.000Z');assert.deepEqual(await store.generateDailies(),[]);
  await store.close();await store.open();assert.deepEqual(await store.generateDailies(),[]);
  setNow('2026-11-02T12:00:00+08:00');const [last]=await store.generateDailies();
  assert.equal(last.goalDate,'2026-11-02');assert.equal(last.durationMinutes,45);
  assert.deepEqual((await read('calendar.json')).months,['2026-10','2026-11']);
  assert.equal(Object.values(store.snapshot().items).some(item=>item.goalDate==='2026-11-01'),false);
  setNow('2026-11-03T08:00:00+08:00');assert.deepEqual(await store.generateDailies(),[]);
  assert.equal(store.snapshot().goals.reading.status,'open');
});

test('editing a goal changes future tasks without overwriting rescheduled or deleted instances',async t=>{
  const {store,setNow,read}=await fixture(t,'2026-10-31T08:00:00+08:00');
  await store.saveRoutine({collection:'goals',id:'reading',item:goal});const [first]=await store.generateDailies();
  const moved=await store.upsert({id:first.id,baseRevision:1,item:{...editable(first),dueAt:'2026-11-01T14:00:00+08:00',durationMinutes:10}});
  assert.equal(moved.goalId,'reading');assert.equal(moved.goalDate,'2026-10-31');
  const nextGoal={...goal,dailyTitle:'阅读新一节',defaultStartTime:'11:00',defaultDurationMinutes:60};
  await store.saveRoutine({collection:'goals',id:'reading',baseRevision:1,item:nextGoal});
  assert.deepEqual(await store.generateDailies(),[]);assert.equal(store.snapshot().items[first.id].dueAt,moved.dueAt);
  assert.equal((await read('calendar/2026-10.json')).items[first.id],undefined);
  assert.equal((await read('calendar/2026-11.json')).items[first.id].goalDate,'2026-10-31');
  await store.remove({id:first.id,baseRevision:moved.revision});assert.deepEqual(await store.generateDailies(),[]);
  setNow('2026-11-01T08:00:00+08:00');const [second]=await store.generateDailies();
  assert.equal(second.title,nextGoal.dailyTitle);assert.equal(second.durationMinutes,60);assert.equal(second.dueAt,'2026-11-01T03:00:00.000Z');
  await store.upsert({id:second.id,baseRevision:1,item:{...editable(second),status:'done'}});
  assert.deepEqual(await store.generateDailies(),[]);assert.equal(store.snapshot().goals.reading.status,'open');
});

test('disabling, completing, cancelling and deleting goals stop generation without deleting prior tasks',async t=>{
  for(const change of ['disabled','done','cancelled','deleted'])await t.test(change,async sub=>{
    const {store,setNow}=await fixture(sub,'2026-10-31T08:00:00+08:00');
    await store.saveRoutine({collection:'goals',id:'reading',item:goal});const [first]=await store.generateDailies();
    if(change==='deleted')await store.removeRoutine({collection:'goals',id:'reading',baseRevision:1});
    else await store.saveRoutine({collection:'goals',id:'reading',baseRevision:1,item:{...goal,...(change==='disabled'?{enabled:false}:{status:change})}});
    setNow('2026-11-01T08:00:00+08:00');assert.deepEqual(await store.generateDailies(),[]);
    assert.equal(store.snapshot().items[first.id].deletedAt,null);assert.equal(store.snapshot().items[first.id].status,'open');
  });
});

test('goal CAS, id collisions, immutable receipts and start dates remain independent of calendar items',async t=>{
  const {store,setNow}=await fixture(t);
  const first=await store.saveRoutine({collection:'goals',operationId:'first-create',item:goal});
  first.title='caller mutation';const stable=store.snapshot().goals[first.id];
  setNow('2026-11-01T08:00:00+08:00');
  const edited=await store.saveRoutine({collection:'goals',id:first.id,baseRevision:1,item:{...goal,title:'新的目标'}});
  assert.equal(edited.startDate,'2026-10-31');
  assert.deepEqual(await store.saveRoutine({collection:'goals',operationId:'first-create',item:goal}),stable);
  await assert.rejects(store.saveRoutine({collection:'goals',id:first.id,baseRevision:1,item:goal}),{status:409});
  await assert.rejects(store.saveRoutine({collection:'goals',operationId:'first-create',item:{...goal,title:'different'}}),{status:409});
  for(const [collection,item] of [['dailyTasks',daily],['habits',habit]])await assert.rejects(store.saveRoutine({collection,id:first.id,item}),{status:409});
  await assert.rejects(store.upsert({id:first.id,item:{title:'collision',dueAt:'2026-11-01T08:00:00+08:00'}}),{status:409});
  await store.saveRoutine({collection:'dailyTasks',id:'daily',item:daily});
  await store.saveRoutine({collection:'habits',id:'habit',item:habit});
  await store.upsert({id:'ordinary',item:{title:'普通事项',dueAt:'2026-11-01T08:00:00+08:00'}});
  for(const id of ['daily','habit','ordinary'])await assert.rejects(store.saveRoutine({collection:'goals',id,item:goal}),{status:409});
  await assert.rejects(store.removeRoutine({collection:'goals',id:'ordinary',baseRevision:1}),{status:404});
  await assert.rejects(store.remove({id:first.id,baseRevision:2}),{status:404});
  const removed=await store.removeRoutine({collection:'goals',id:first.id,baseRevision:2,operationId:'delete-once'});
  assert.deepEqual(await store.removeRoutine({collection:'goals',id:first.id,baseRevision:2,operationId:'delete-once'}),removed);
  await assert.rejects(store.saveRoutine({collection:'goals',id:first.id,baseRevision:3,item:goal}),{status:409});
  await assert.rejects(store.saveRoutine({collection:'goals',id:'__proto__',item:goal}),{status:400});
  await assert.rejects(store.saveRoutine({collection:'goals',id:'x'.repeat(73),item:goal}),{status:400});
});

test('new goals reject an already elapsed deadline without silently modifying it',async t=>{
  const {store}=await fixture(t);
  await assert.rejects(store.saveRoutine({collection:'goals',item:{...goal,deadlineDate:'2026-10-30'}}),{status:400});
  assert.deepEqual(store.snapshot().goals,{});
});

test('goals obey their own timezone and use local wall times across DST without adding 24 hours',async t=>{
  const {store,setNow}=await fixture(t,'2026-03-07T23:30:00-05:00');
  const dst={...goal,timeZone:'America/New_York',deadlineDate:'2026-03-09',defaultStartTime:'02:30'};
  const saved=await store.saveRoutine({collection:'goals',id:'dst',item:dst});assert.equal(saved.startDate,'2026-03-07');
  setNow('2026-03-08T07:59:59-04:00');assert.deepEqual(await store.generateDailies(),[]);
  setNow('2026-03-08T08:00:00-04:00');const [gap]=await store.generateDailies();
  assert.equal(gap.goalDate,'2026-03-08');assert.equal(gap.dueAt,'2026-03-08T07:30:00.000Z');
  setNow('2026-03-09T08:00:00-04:00');const [normal]=await store.generateDailies();assert.equal(normal.dueAt,'2026-03-09T06:30:00.000Z');
  setNow('2026-03-10T08:00:00-04:00');assert.deepEqual(await store.generateDailies(),[]);
});

test('layout 2 migrates atomically to goals and keeps a durable immutable snapshot after later edits',async t=>{
  const {dir,store,read}=await fixture(t);
  await store.saveRoutine({collection:'dailyTasks',id:'daily',item:daily});
  await store.saveRoutine({collection:'habits',id:'habit',item:habit});
  await store.transact(d=>{d.syncClients.icloud={maps:{kept:{revision:4}}};d.memory.push({type:'user-reply',text:'keep this'});});
  const expected=store.snapshot(),parts=structuredClone(store.parts);await store.close();
  parts['calendar.json'].layoutVersion=2;parts['calendar.json'].collections=['daily-tasks.json','habits.json'];delete parts['goals.json'];
  for(const [name,value] of Object.entries(parts))await atomicJSON(path.join(dir,name),value);
  await fs.unlink(path.join(dir,'goals.json'));
  assert.deepEqual(readStorageSync(dir).data,expected);
  await store.open();assert.deepEqual(store.snapshot(),expected);
  assert.equal((await read('calendar.json')).layoutVersion,3);assert.deepEqual((await read('goals.json')).items,{});
  assert.deepEqual(readStorageSync(path.join(dir,'legacy/layout-2')).data,expected);
  await store.saveRoutine({collection:'goals',id:'reading',item:goal});
  await store.saveRoutine({collection:'goals',id:'reading',baseRevision:1,item:{...goal,title:'edited'}});
  assert.deepEqual(readStorageSync(path.join(dir,'legacy/layout-2')).data,expected);
});

test('legacy mixed v1 gains an empty goal collection while preserving its exact original snapshot',async t=>{
  const {dir,store,read}=await fixture(t);await store.upsert({id:'keep',item:{title:'旧待办',dueAt:'2026-10-31T08:00:00+08:00'}});
  const legacy=store.snapshot();delete legacy.goals;await store.close();await atomicJSON(path.join(dir,'calendar.json'),legacy);
  await store.open();assert.deepEqual(store.snapshot(),{...legacy,goals:{}});
  assert.deepEqual(await read('legacy/calendar-v1.json'),legacy);assert.deepEqual((await read('goals.json')).items,{});
});

test('goal journal recovery publishes template, generated task and marker in one coherent snapshot',async t=>{
  const {dir,store,setNow}=await fixture(t);
  await store.saveRoutine({collection:'goals',id:'reading',item:goal});setNow('2026-10-31T08:00:00+08:00');await store.generateDailies();
  const next=store.snapshot();next.revision++;next.goals.reading.title='Recovered goal';
  const parts=partition(next,'Asia/Shanghai');await store.close();
  await atomicJSON(path.join(dir,'.transaction.json'),{schemaVersion:1,parts});await fs.unlink(path.join(dir,'goals.json'));
  assert.deepEqual(readStorageSync(dir).data,next);await store.open();assert.deepEqual(store.snapshot(),next);
  assert.deepEqual(await store.generateDailies(),[]);await assert.rejects(fs.access(path.join(dir,'.transaction.json')));
});

test('missing or invalid declared goal files and cross-collection identities fail closed',async t=>{
  for(const mode of ['missing','invalid','collision'])await t.test(mode,async sub=>{
    const {dir,store,read}=await fixture(sub);await store.saveRoutine({collection:'dailyTasks',id:'daily',item:daily});
    await store.saveRoutine({collection:'goals',id:'reading',item:goal});const saved=store.snapshot().goals.reading;await store.close();
    const index=await read('calendar.json');
    if(mode==='missing')await fs.unlink(path.join(dir,'goals.json'));
    else await atomicJSON(path.join(dir,'goals.json'),mode==='invalid'?{schemaVersion:1,items:[]}:{schemaVersion:1,items:{daily:{...saved,id:'daily'}}});
    await assert.rejects(store.open(),/refusing to overwrite/);assert.deepEqual(await read('calendar.json'),index);
  });
});

test('generated goal ids cannot overwrite another template or calendar item',async t=>{
  for(const mode of ['template','calendar'])await t.test(mode,async sub=>{
    const {store}=await fixture(sub,'2026-10-31T08:00:00+08:00');await store.saveRoutine({collection:'goals',id:'reading',item:goal});
    const id='goal_reading_20261031';
    if(mode==='template')await store.saveRoutine({collection:'dailyTasks',id,item:daily});
    else await store.upsert({id,item:{title:'untouched',dueAt:'2026-10-31T08:00:00+08:00'}});
    const before=store.snapshot();await assert.rejects(store.generateDailies(),{status:409});assert.deepEqual(store.snapshot(),before);
  });
});
