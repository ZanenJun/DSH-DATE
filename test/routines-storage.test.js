import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CalendarStore,atomicJSON} from '../src/store.js';
import {readStorageSync,partition} from '../src/storage-layout.js';
import {dailyTaskInput,habitInput,habitTime} from '../src/routines.js';
import {editable,latestDue,occurrencesBetween} from '../src/model.js';
import {ReminderScheduler} from '../src/scheduler.js';

const daily={title:'每日阅读',defaultStartTime:'09:30',defaultDurationMinutes:45};
const habit={title:'喝水',defaultTime:'10:00'};
async function fixture(t,initial='2026-10-11T07:59:00+08:00') {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calendar-routines-'));
  let now=Date.parse(initial);
  const store=await new CalendarStore(dir,{clock:()=>now}).open();
  t.after(async()=>{await store.close();await fs.rm(dir,{recursive:true,force:true});});
  return {dir,store,setNow:value=>{now=Date.parse(value);},read:async name=>JSON.parse(await fs.readFile(path.join(dir,name),'utf8'))};
}

test('routine inputs require default times and daily duration with strict typed fields',()=>{
  assert.equal(dailyTaskInput.parse(daily).timeZone,'Asia/Shanghai');
  assert.equal(habitInput.parse(habit).enabled,true);
  for(const bad of [{title:'x',defaultDurationMinutes:30},{title:'x',defaultStartTime:'08:00'},
    {...daily,defaultStartTime:'24:00'},{...daily,defaultDurationMinutes:0},
    {...daily,defaultDurationMinutes:'30'},{...daily,timeZone:'invalid/zone'}, {...daily,unexpected:true}])assert.throws(()=>dailyTaskInput.parse(bad));
  for(const bad of [{title:'x'},{...habit,defaultTime:'8:00'},{...habit,durationMinutes:30}])assert.throws(()=>habitInput.parse(bad));
});

test('daily templates, habits, month calendars and conversation text have separate durable files',async t=>{
  const {dir,store,read}=await fixture(t);
  await store.saveRoutine({collection:'dailyTasks',id:'reading',item:daily});
  const saved=await store.saveRoutine({collection:'habits',id:'water',item:habit});
  await store.upsert({id:'ordinary',item:{title:'会议',dueAt:'2026-10-11T12:00:00+08:00'}});
  await store.transact(data=>{
    data.occurrences.water={key:'water',itemId:'water',dueAt:saved.dueAt,state:'active',lastText:'PRIVATE_NAG'};
    data.memory.push({type:'user-reply',text:'PRIVATE_REPLY'});
  });
  assert.deepEqual(Object.keys((await read('daily-tasks.json')).items),['reading']);
  const habits=await read('habits.json');assert.equal(habits.items.water.defaultTime,'10:00');assert.ok(habits.occurrences.water);
  assert.equal(habits.occurrences.water.lastText,undefined);
  assert.deepEqual(Object.keys((await read('calendar/2026-10.json')).items),['ordinary']);
  for(const name of ['daily-tasks.json','habits.json','calendar/2026-10.json'])assert.doesNotMatch(await fs.readFile(path.join(dir,name),'utf8'),/PRIVATE_NAG|PRIVATE_REPLY/);
  const state=await read('state.json');assert.equal(state.dailyTasks,undefined);assert.equal(state.items,undefined);
  const snapshot=store.snapshot();await store.close();await store.open();assert.deepEqual(store.snapshot(),snapshot);
  assert.equal(readStorageSync(path.join(dir,'backup')).data.items.water.kind,'habit');
});

test('legacy v2 monthly habits migrate without losing occurrences, sync metadata or receipts',async t=>{
  const {dir,store,read}=await fixture(t);
  const saved=await store.upsert({id:'legacy-habit',operationId:'legacy-op',item:{title:'旧习惯',kind:'habit',dueAt:'2026-10-11T10:00:00+08:00',recurrence:{frequency:'daily'}}});
  await store.transact(d=>{d.occurrences.old={itemId:saved.id,key:'old',dueAt:saved.dueAt,state:'acknowledged',lastText:'kept text'};d.syncClients.icloud={maps:{legacy:{href:'private-mapping'}}};});
  const expected=store.snapshot(),parts=structuredClone(store.parts);
  await store.close();delete parts['calendar.json'].layoutVersion;delete parts['calendar.json'].collections;
  parts['calendar.json'].months=['2026-10'];
  parts['calendar/2026-10.json']={schemaVersion:1,month:'2026-10',items:parts['habits.json'].items,occurrences:parts['habits.json'].occurrences};
  delete parts['daily-tasks.json'];delete parts['habits.json'];
  await fs.mkdir(path.join(dir,'calendar'),{recursive:true});
  for(const [name,value] of Object.entries(parts))await atomicJSON(path.join(dir,name),value);
  await fs.unlink(path.join(dir,'daily-tasks.json'));await fs.unlink(path.join(dir,'habits.json'));
  await store.open();assert.deepEqual(store.snapshot(),expected);
  assert.equal((await read('calendar.json')).layoutVersion,2);
  assert.equal((await read('habits.json')).items[saved.id].revision,1);
  assert.deepEqual((await read('calendar/2026-10.json')).items,{});
  assert.equal((await read('backup/calendar.json')).layoutVersion,undefined);
  assert.deepEqual(readStorageSync(path.join(dir,'backup')).data,expected);
});

test('missing declared routine files and missing indexes fail closed',async t=>{
  for(const name of ['daily-tasks.json','habits.json'])await t.test(name,async sub=>{
    const {dir,store,read}=await fixture(sub);
    await store.saveRoutine({collection:'dailyTasks',id:'keep',item:daily});await store.close();
    const before=await read('calendar.json');await fs.unlink(path.join(dir,name));
    await assert.rejects(store.open(),/refusing to overwrite/);assert.deepEqual(await read('calendar.json'),before);
  });
  await t.test('index',async sub=>{
    const {dir,store}=await fixture(sub);await store.close();
    await fs.unlink(path.join(dir,'calendar.json'));await fs.unlink(path.join(dir,'state.json'));await fs.unlink(path.join(dir,'history.json'));
    await assert.rejects(store.open(),/refusing to overwrite/);
    await assert.rejects(fs.access(path.join(dir,'calendar.json')));
  });
});

test('routine collections and generated markers are recovered together from the transaction journal',async t=>{
  const {dir,store}=await fixture(t);
  await store.saveRoutine({collection:'dailyTasks',id:'reading',item:daily});
  const next=store.snapshot();await store.close();
  next.revision++;next.dailyTasks.reading.title='更新后';
  next.items.recovered={title:'恢复实例',kind:'todo',notes:'',dueAt:'2026-10-11T01:30:00.000Z',durationMinutes:45,timeZone:'Asia/Shanghai',recurrence:null,enabled:true,status:'open',id:'recovered',revision:1,createdAt:'2026-10-11T00:00:00.000Z',updatedAt:'2026-10-11T00:00:00.000Z',deletedAt:null,scheduleVersion:1,dailyTaskId:'reading',dailyDate:'2026-10-11'};
  next.dailyGenerations={'reading:2026-10-11':'recovered'};
  const parts=partition(next,'Asia/Shanghai');
  await atomicJSON(path.join(dir,'.transaction.json'),{schemaVersion:1,parts});
  await atomicJSON(path.join(dir,'daily-tasks.json'),parts['daily-tasks.json']);
  assert.deepEqual(readStorageSync(dir).data,next);
  await store.open();assert.deepEqual(store.snapshot(),next);assert.deepEqual(await store.generateDailies(),[]);
});

test('08:00 generates once per local date and restart only catches up the current day',async t=>{
  const {store,setNow}=await fixture(t);
  await store.saveRoutine({collection:'dailyTasks',id:'reading',item:daily});
  assert.deepEqual(await store.generateDailies(),[]);
  setNow('2026-10-11T08:00:00+08:00');const [first]=await store.generateDailies();
  assert.equal(first.dueAt,'2026-10-11T01:30:00.000Z');assert.equal(first.durationMinutes,45);assert.equal(first.kind,'todo');
  assert.equal(first.dailyTaskId,'reading');assert.equal(first.dailyDate,'2026-10-11');
  assert.deepEqual(await store.generateDailies(),[]);
  await store.close();await store.open();assert.deepEqual(await store.generateDailies(),[]);
  setNow('2026-10-15T07:59:59+08:00');assert.deepEqual(await store.generateDailies(),[]);
  setNow('2026-10-15T13:00:00+08:00');const [latest]=await store.generateDailies();assert.equal(latest.dailyDate,'2026-10-15');
  assert.equal(Object.keys(store.snapshot().items).length,2);
});

test('daily instances retain manual rescheduling and deletion while template edits affect future dates',async t=>{
  const {store,setNow}=await fixture(t,'2026-10-11T08:00:00+08:00');
  await store.saveRoutine({collection:'dailyTasks',id:'reading',item:daily});
  const [first]=await store.generateDailies();
  const edited=await store.upsert({id:first.id,baseRevision:1,item:{...editable(first),dueAt:'2026-10-11T14:00:00+08:00',durationMinutes:10}});
  assert.equal(edited.dailyTaskId,'reading');assert.equal(edited.dailyDate,'2026-10-11');
  await store.saveRoutine({collection:'dailyTasks',id:'reading',baseRevision:1,item:{...daily,title:'新标题',defaultStartTime:'11:00',defaultDurationMinutes:60}});
  assert.deepEqual(await store.generateDailies(),[]);assert.equal(store.snapshot().items[first.id].dueAt,edited.dueAt);
  await store.remove({id:first.id,baseRevision:edited.revision});assert.deepEqual(await store.generateDailies(),[]);
  setNow('2026-10-12T08:00:00+08:00');const [next]=await store.generateDailies();
  assert.equal(next.title,'新标题');assert.equal(next.durationMinutes,60);assert.equal(next.dueAt,'2026-10-12T03:00:00.000Z');
  await store.removeRoutine({collection:'dailyTasks',id:'reading',baseRevision:2});assert.equal(store.snapshot().items[next.id].deletedAt,null);
  setNow('2026-10-13T08:00:00+08:00');assert.deepEqual(await store.generateDailies(),[]);
});

test('disabled templates and habits do not generate calendars; enabled templates created after 08:00 do',async t=>{
  const {store}=await fixture(t,'2026-10-11T12:00:00+08:00');
  await store.saveRoutine({collection:'dailyTasks',id:'disabled',item:{...daily,enabled:false}});
  await store.saveRoutine({collection:'habits',id:'water',item:habit});
  assert.deepEqual(await store.generateDailies(),[]);
  await store.saveRoutine({collection:'dailyTasks',id:'disabled',baseRevision:1,item:daily});
  const [saved]=await store.generateDailies();assert.equal(saved.dailyDate,'2026-10-11');
  assert.equal(Object.values(store.snapshot().items).filter(item=>item.kind==='todo').length,1);
});

test('routine CAS, collection collisions and operation receipts preserve independent identities',async t=>{
  const {store,setNow}=await fixture(t);
  const saved=await store.saveRoutine({collection:'dailyTasks',operationId:'same-create',item:daily});
  setNow('2026-10-12T10:00:00+08:00');assert.deepEqual(await store.saveRoutine({collection:'dailyTasks',operationId:'same-create',item:daily}),saved);
  await assert.rejects(store.saveRoutine({collection:'dailyTasks',id:saved.id,item:daily}),{status:409});
  await assert.rejects(store.saveRoutine({collection:'habits',id:saved.id,item:habit}),{status:409});
  await assert.rejects(store.upsert({id:saved.id,item:{title:'collision',dueAt:'2026-10-11T08:00:00+08:00'}}),{status:409});
  await store.upsert({id:'ordinary',item:{title:'普通事项',dueAt:'2026-10-11T08:00:00+08:00'}});
  await assert.rejects(store.saveRoutine({collection:'dailyTasks',id:'ordinary',item:daily}),{status:409});
  await assert.rejects(store.saveRoutine({collection:'habits',id:'ordinary',baseRevision:1,item:habit}),{status:409});
  await assert.rejects(store.removeRoutine({collection:'habits',id:'ordinary',baseRevision:1}),{status:404});
  const removed=await store.removeRoutine({collection:'dailyTasks',id:saved.id,baseRevision:1,operationId:'remove-once'});
  assert.deepEqual(await store.removeRoutine({collection:'dailyTasks',id:saved.id,baseRevision:1,operationId:'remove-once'}),removed);
  await assert.rejects(store.saveRoutine({collection:'dailyTasks',id:saved.id,baseRevision:2,item:daily}),{status:409});
  await assert.rejects(store.saveRoutine({collection:'dailyTasks',id:'x'.repeat(73),item:daily}),{status:400});
  await assert.rejects(store.saveRoutine({collection:'habits',id:'__proto__',item:habit}),{status:400});
});

test('habit metadata edits retain the anchor; changing default time cancels the old reminder',async t=>{
  const {store,setNow}=await fixture(t);
  const first=await store.saveRoutine({collection:'habits',id:'water',item:habit});
  await store.transact(d=>{d.occurrences.water={itemId:first.id,dueAt:first.dueAt,state:'active'};});
  setNow('2026-10-14T09:00:00+08:00');
  const renamed=await store.saveRoutine({collection:'habits',id:first.id,baseRevision:1,item:{...habit,title:'每日喝水'}});
  assert.equal(renamed.dueAt,first.dueAt);assert.equal(renamed.scheduleVersion,first.scheduleVersion);assert.equal(store.snapshot().occurrences.water.state,'active');
  const shifted=await store.saveRoutine({collection:'habits',id:first.id,baseRevision:2,item:{...habit,defaultTime:'11:00'}});
  assert.equal(shifted.dueAt,'2026-10-14T03:00:00.000Z');assert.equal(shifted.defaultTime,'11:00');assert.equal(store.snapshot().occurrences.water.state,'cancelled');
  const oldAPI=await store.upsert({id:first.id,baseRevision:3,item:{...editable(shifted),dueAt:'2026-10-14T04:00:00.000Z'}});
  assert.equal(oldAPI.defaultTime,'12:00');
});

test('routine editing preserves existing weekly habit rules that are not exposed in its input',async t=>{
  const {store,setNow}=await fixture(t);
  const saved=await store.upsert({id:'weekly',item:{title:'周习惯',kind:'habit',dueAt:'2026-10-11T10:00:00+08:00',recurrence:{frequency:'weekly',weekdays:[2,4],interval:2}}});
  setNow('2026-10-14T09:00:00+08:00');
  const edited=await store.saveRoutine({collection:'habits',id:saved.id,baseRevision:1,item:{title:'更名周习惯',defaultTime:'10:00'}});
  assert.deepEqual(edited.recurrence,saved.recurrence);assert.equal(edited.dueAt,saved.dueAt);assert.equal(edited.scheduleVersion,saved.scheduleVersion);
});

test('generation uses each template timezone and maintains default wall time across DST',async t=>{
  const {store,setNow}=await fixture(t,'2026-03-08T07:59:59-04:00');
  await store.saveRoutine({collection:'dailyTasks',id:'dst',item:{...daily,defaultStartTime:'02:30',timeZone:'America/New_York'}});
  assert.deepEqual(await store.generateDailies(),[]);
  setNow('2026-03-08T08:00:00-04:00');const [gap]=await store.generateDailies();assert.equal(gap.dueAt,'2026-03-08T07:30:00.000Z');
  const saved=await store.saveRoutine({collection:'habits',id:'gap-habit',item:{...habit,defaultTime:'02:30',timeZone:'America/New_York'}});
  assert.equal(saved.defaultTime,'02:30');assert.equal(habitTime(saved),'02:30');
  assert.equal(latestDue(saved,Date.parse('2026-03-09T08:00:00-04:00')),'2026-03-09T06:30:00.000Z');
  assert.deepEqual(occurrencesBetween(saved,Date.parse('2026-03-09T00:00:00-04:00'),Date.parse('2026-03-09T23:59:00-04:00')),['2026-03-09T06:30:00.000Z']);
  const shifted=await store.saveRoutine({collection:'habits',id:saved.id,baseRevision:1,item:{...habit,defaultTime:'03:30',timeZone:'America/New_York'}});
  assert.equal(shifted.dueAt,saved.dueAt);assert.equal(shifted.defaultTime,'03:30');assert.equal(shifted.scheduleVersion,saved.scheduleVersion+1);
  const restored=await store.saveRoutine({collection:'habits',id:saved.id,baseRevision:2,item:{...habit,defaultTime:'02:30',timeZone:'America/New_York'}});
  assert.equal(restored.dueAt,saved.dueAt);assert.equal(restored.defaultTime,'02:30');
  setNow('2026-03-09T08:00:00-04:00');const [normal]=await store.generateDailies();assert.equal(normal.dueAt,'2026-03-09T06:30:00.000Z');
  const updated=await store.saveRoutine({collection:'habits',id:saved.id,baseRevision:3,item:{...habit,defaultTime:'02:30',timeZone:'America/New_York'}});
  assert.equal(updated.dueAt,saved.dueAt);assert.equal(updated.defaultTime,'02:30');
});

test('an explicitly snoozed habit crosses midnight, repeats, and accepts a reply and completion',async t=>{
  const {store,setNow}=await fixture(t,'2026-10-11T23:55:00+08:00');
  let now=Date.parse('2026-10-11T23:55:00+08:00'),sent=0;
  const advance=value=>{now=Date.parse(value);setNow(value);};
  const scheduler=new ReminderScheduler(store,{clock:()=>now,ownerQQ:'1',botQQ:'2',send:async()=>({message_id:++sent})});
  await store.saveRoutine({collection:'habits',id:'water',item:{...habit,defaultTime:'23:55'}});
  await scheduler.tick();assert.equal(sent,1);
  const initial=Object.values(store.snapshot().occurrences)[0];
  await scheduler.act({action:'snooze',itemId:'water',occurrenceKey:initial.key,minutes:10});
  advance('2026-10-12T00:04:59+08:00');await scheduler.tick();assert.equal(sent,1);
  assert.equal(store.snapshot().occurrences[initial.key].state,'active');
  advance('2026-10-12T00:05:00+08:00');await scheduler.tick();assert.equal(sent,2);
  advance('2026-10-12T00:05:30+08:00');await scheduler.tick();assert.equal(sent,3);
  await scheduler.receive({post_type:'message',message_type:'private',self_id:2,user_id:1,message_id:9,time:now/1000,raw_message:'收到'});
  assert.equal(store.snapshot().occurrences[initial.key].state,'acknowledged');
  advance('2026-10-12T00:06:00+08:00');await scheduler.tick();assert.equal(sent,3);
  const done=await scheduler.act({action:'complete',itemId:'water',occurrenceKey:initial.key});
  assert.equal(done.occurrence.state,'done');assert.equal(done.item.status,'open');
});

test('a future explicit habit snooze survives a newer daily occurrence',async t=>{
  const {store,setNow}=await fixture(t,'2026-10-11T08:00:00+08:00');
  let now=Date.parse('2026-10-11T08:00:00+08:00');const batches=[];
  const advance=value=>{now=Date.parse(value);setNow(value);};
  const scheduler=new ReminderScheduler(store,{clock:()=>now,ownerQQ:'1',botQQ:'2',send:async batch=>{batches.push(batch.keys);return {message_id:batches.length};}});
  await store.saveRoutine({collection:'habits',id:'water',item:{...habit,defaultTime:'08:00'}});
  await scheduler.tick();const original=Object.values(store.snapshot().occurrences)[0];
  await scheduler.act({action:'snooze',itemId:'water',occurrenceKey:original.key,minutes:2*24*60+5});
  advance('2026-10-12T08:00:00+08:00');await scheduler.tick();
  assert.equal(store.snapshot().occurrences[original.key].state,'active');
  assert.equal(batches[1].includes(original.key),false);
  advance('2026-10-13T08:00:00+08:00');await scheduler.tick();
  assert.equal(store.snapshot().occurrences[original.key].state,'active');
  assert.equal(batches[2].includes(original.key),false);
  advance('2026-10-13T08:05:00+08:00');await scheduler.tick();
  assert.equal(batches.at(-1).includes(original.key),true);
});

test('an unsnoozed previous-day habit is not caught up or nagged before today\'s time',async t=>{
  const {store,setNow}=await fixture(t,'2026-10-11T23:55:00+08:00');
  let now=Date.parse('2026-10-11T23:55:00+08:00'),sent=0;
  const advance=value=>{now=Date.parse(value);setNow(value);};
  const scheduler=new ReminderScheduler(store,{clock:()=>now,ownerQQ:'1',botQQ:'2',send:async()=>({message_id:++sent})});
  await store.saveRoutine({collection:'habits',id:'water',item:{...habit,defaultTime:'23:55'}});
  await store.saveRoutine({collection:'habits',id:'unobserved',item:{...habit,defaultTime:'23:56'}});
  await scheduler.tick();assert.equal(sent,1);
  advance('2026-10-12T00:05:00+08:00');await scheduler.tick();assert.equal(sent,1);
  const rows=Object.values(store.snapshot().occurrences);
  assert.equal(rows.length,1);assert.equal(rows[0].state,'superseded');
  advance('2026-10-12T23:55:00+08:00');await scheduler.tick();assert.equal(sent,2);
});
