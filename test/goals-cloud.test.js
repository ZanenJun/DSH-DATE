import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CalendarStore} from '../src/store.js';
import {ICloudSync} from '../src/icloud-sync.js';
import {ReminderScheduler} from '../src/scheduler.js';
import {encodeEvent,parseEvent} from '../src/icloud-codec.js';
import {withinWindow} from '../src/sync-window.js';

const base='https://p12-caldav.icloud.com/123/calendars/dsh/';
class FakeDAV {
  credentials={username:'test@example.com'};objects=new Map();version=0;puts=0;
  async list(url,window){return [...this.objects.values()].filter(object=>withinWindow(parseEvent(object.raw).fields,window)).map(object=>({...object}));}
  async get(href){return this.objects.get(href)??null;}
  async put(href,raw,etag){
    assert.equal(this.objects.get(href)?.etag??null,etag,'Cloud updates must use the current ETag');
    this.puts++;this.objects.set(href,{href,raw,etag:`"${++this.version}"`});
  }
  edit(href,changes){
    const old=this.objects.get(href),event=parseEvent(old.raw);
    this.objects.set(href,{...old,etag:`"${++this.version}"`,raw:encodeEvent({uid:event.uid,fields:{...event.fields,...changes},raw:old.raw})});
  }
  close(){}
}

test('generated goal tasks sync through CalDAV both ways, keep their identity when moved and complete independently',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calendar-goals-cloud-'));
  let now=Date.parse('2026-10-31T08:00:00+08:00');const clock=()=>now;
  const store=await new CalendarStore(dir,{clock}).open(),dav=new FakeDAV();
  const sync=new ICloudSync(store,dav,{calendarUrl:base,intervalMs:20000,timeZone:'Asia/Shanghai'},{clock});
  t.after(async()=>{await sync.close();await store.close();await fs.rm(dir,{recursive:true,force:true});});
  await sync.initialize();
  const goal=await store.saveRoutine({collection:'goals',id:'book',item:{title:'读完一本书',deadlineDate:'2026-11-02',dailyTitle:'阅读一小节',defaultStartTime:'09:30',defaultDurationMinutes:45}});
  const [first]=await store.generateDailies();await sync.tick(true);
  assert.equal(dav.objects.size,1);assert.equal(dav.puts,1);
  const href=store.snapshot().syncClients.icloud.maps[first.id].href;
  const exported=parseEvent((await dav.get(href)).raw);
  assert.equal(exported.itemId,first.id);assert.equal(exported.fields.title,goal.dailyTitle);
  assert.equal(exported.fields.dueAt,'2026-10-31T01:30:00.000Z');assert.equal(exported.fields.durationMinutes,45);

  now=Date.parse('2026-10-31T09:30:00+08:00');let deliveries=0;
  const scheduler=new ReminderScheduler(store,{clock,ownerQQ:'1',botQQ:'2',send:async()=>({message_id:++deliveries})});
  await scheduler.tick();assert.equal(deliveries,1);
  dav.edit(href,{dueAt:'2026-11-01T06:00:00.000Z',durationMinutes:75});await sync.tick(true);
  const moved=store.snapshot().items[first.id];
  assert.equal(moved.dueAt,'2026-11-01T06:00:00.000Z');assert.equal(moved.durationMinutes,75);
  assert.equal(moved.goalId,goal.id);assert.equal(moved.goalDate,'2026-10-31');
  assert.ok(Object.values(store.snapshot().occurrences).every(occurrence=>occurrence.state==='cancelled'));
  await scheduler.tick();assert.equal(deliveries,1,'The obsolete schedule must stop reminding');
  assert.deepEqual(await store.generateDailies(),[]);await sync.tick(true);
  assert.equal(dav.objects.size,1);assert.equal(dav.puts,1,'Importing the move must not duplicate or re-upload it');
  const october=JSON.parse(await fs.readFile(path.join(dir,'calendar/2026-10.json'),'utf8'));
  const november=JSON.parse(await fs.readFile(path.join(dir,'calendar/2026-11.json'),'utf8'));
  assert.equal(october.items[first.id],undefined);assert.equal(november.items[first.id].goalId,goal.id);

  await scheduler.act({action:'complete',itemId:first.id});await sync.tick(true);
  assert.equal(store.snapshot().items[first.id].status,'done');assert.equal(store.snapshot().goals[goal.id].status,'open');
  assert.equal(parseEvent((await dav.get(href)).raw).fields.title,`✓ ${goal.dailyTitle}`);
  assert.deepEqual(await store.generateDailies(),[]);
  await store.close();await store.open();assert.equal(store.snapshot().items[first.id].goalDate,'2026-10-31');
  now=Date.parse('2026-11-01T08:00:00+08:00');const [second]=await store.generateDailies();
  assert.equal(second.goalId,goal.id);assert.equal(second.goalDate,'2026-11-01');assert.notEqual(second.id,first.id);
  assert.equal(second.dueAt,'2026-11-01T01:30:00.000Z');assert.equal(second.durationMinutes,45);assert.equal(second.status,'open');
  await sync.tick(true);assert.equal(dav.objects.size,2);
  assert.equal(sync.status().lastError,null);assert.deepEqual(sync.status().conflicts,[]);assert.equal(sync.status().pending,0);
});
