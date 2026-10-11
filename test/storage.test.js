import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CalendarStore,atomicJSON} from '../src/store.js';
import {partition,readStorageSync} from '../src/storage-layout.js';
import {syncWindow} from '../src/sync-window.js';

async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calendar-months-'));
  const store=await new CalendarStore(dir).open();
  t.after(async()=>{await store.close();await fs.rm(dir,{recursive:true,force:true});});
  return {dir,store};
}
test('monthly storage keeps replies and reminder text separate and moves rescheduled items once',async t=>{
  const {dir,store}=await fixture(t);
  const saved=await store.upsert({id:'move',operationId:'first',item:{title:'月末',dueAt:'2026-10-31T23:00:00+08:00'}});
  await store.transact(d=>{
    d.memory.push({type:'user-reply',text:'PRIVATE_REPLY'});
    d.occurrences.old={key:'old',itemId:'move',dueAt:saved.dueAt,state:'acknowledged',lastText:'PRIVATE_REMINDER'};
  });
  const oldFile=path.join(dir,'calendar','2026-10.json');
  assert.doesNotMatch(await fs.readFile(oldFile,'utf8'),/PRIVATE_REPLY|PRIVATE_REMINDER/);
  const history=JSON.parse(await fs.readFile(path.join(dir,'history.json'),'utf8'));
  assert.ok(history.memory.some(m=>m.text==='PRIVATE_REPLY'));assert.equal(history.occurrenceTexts.old,'PRIVATE_REMINDER');
  await store.upsert({id:'move',baseRevision:1,operationId:'second',item:{title:'移到下月',dueAt:'2026-10-31T16:30:00Z'}});
  assert.equal(Object.keys(JSON.parse(await fs.readFile(oldFile,'utf8')).items).length,0);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'calendar','2026-11.json'),'utf8')).items.move.title,'移到下月');
  await store.close();await store.open();
  assert.equal(Object.keys(store.snapshot().items).length,1);assert.equal(store.snapshot().occurrences.old.lastText,'PRIVATE_REMINDER');
  const retry=await store.upsert({id:'move',operationId:'first',item:{title:'月末',dueAt:'2026-10-31T23:00:00+08:00'}});
  assert.equal(retry.revision,1);assert.equal(store.snapshot().items.move.revision,2);
});
test('v1 migration preserves items, replies, CAS receipts and sync mappings without an active mixed file',async t=>{
  const {dir,store}=await fixture(t);await store.upsert({id:'existing',operationId:'create',item:{title:'迁移',dueAt:'2026-10-11T08:00:00+08:00'}});
  await store.transact(d=>{d.syncClients={icloud:{binding:{account:'digest'},maps:{existing:{revision:1}}}};d.memory.push({type:'user-reply',text:'keep'});});
  const legacy=JSON.parse(JSON.stringify(store.snapshot()));await store.close();await fs.rm(path.join(dir,'calendar'),{recursive:true});
  await fs.writeFile(path.join(dir,'calendar.json'),JSON.stringify(legacy));
  await store.open();assert.deepEqual(store.snapshot(),legacy);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'legacy','calendar-v1.json'),'utf8')),legacy);
  const index=JSON.parse(await fs.readFile(path.join(dir,'calendar.json'),'utf8'));
  assert.equal(index.schemaVersion,2);assert.equal(index.items,undefined);assert.equal(index.memory,undefined);
});
test('an interrupted cross-month commit is coherent for readers and replays on startup',async t=>{
  const {dir,store}=await fixture(t);await store.upsert({id:'recover',item:{title:'原计划',dueAt:'2026-10-11T08:00:00+08:00'}});
  const loaded=readStorageSync(dir),next=JSON.parse(JSON.stringify(store.snapshot()));await store.close();
  next.revision++;next.items.recover.dueAt='2026-11-11T00:00:00.000Z';next.items.recover.revision++;
  next.memory.push({type:'user-reply',text:'new history'});
  const parts=partition(next,'Asia/Shanghai',loaded.parts['calendar.json'].months);
  await atomicJSON(path.join(dir,'.transaction.json'),{schemaVersion:1,parts});
  await atomicJSON(path.join(dir,'calendar','2026-10.json'),parts['calendar/2026-10.json']);
  assert.deepEqual(readStorageSync(dir).data,next);
  await store.open();assert.deepEqual(store.snapshot(),next);
  assert.equal(Object.keys(JSON.parse(await fs.readFile(path.join(dir,'calendar','2026-10.json'),'utf8')).items).length,0);
  assert.ok(JSON.parse(await fs.readFile(path.join(dir,'calendar','2026-11.json'),'utf8')).items.recover);
  await assert.rejects(fs.access(path.join(dir,'.transaction.json')));
});
test('a missing monthly file fails closed instead of replacing the index with an empty calendar',async t=>{
  const {dir,store}=await fixture(t);await store.upsert({id:'safe',item:{title:'不可丢失',dueAt:'2026-10-11T08:00:00+08:00'}});await store.close();
  const index=await fs.readFile(path.join(dir,'calendar.json'),'utf8');
  await fs.unlink(path.join(dir,'calendar','2026-10.json'));await assert.rejects(store.open(),/refusing to overwrite/);
  assert.equal(await fs.readFile(path.join(dir,'calendar.json'),'utf8'),index);
});
test('a missing index cannot silently reinitialize existing monthly data',async t=>{
  const {dir,store}=await fixture(t);await store.upsert({id:'safe',item:{title:'不可丢失',dueAt:'2026-10-11T08:00:00+08:00'}});await store.close();
  await fs.unlink(path.join(dir,'calendar.json'));await assert.rejects(store.open(),/refusing to overwrite/);
  await assert.rejects(fs.access(path.join(dir,'calendar.json')));
  assert.ok(JSON.parse(await fs.readFile(path.join(dir,'calendar','2026-10.json'),'utf8')).items.safe);
});
test('three calendar months use the configured timezone and roll across year and DST boundaries',()=>{
  const w=syncWindow(Date.parse('2026-12-31T16:30:00Z'),'Asia/Shanghai');
  assert.deepEqual(w.months,['2026-12','2027-01','2027-02']);assert.equal(w.fromISO,'2026-11-30T16:00:00.000Z');assert.equal(w.toISO,'2027-02-28T16:00:00.000Z');
  const dst=syncWindow(Date.parse('2026-03-15T12:00:00Z'),'America/New_York');
  assert.equal(dst.fromISO,'2026-02-01T05:00:00.000Z');assert.equal(dst.toISO,'2026-05-01T04:00:00.000Z');
});
