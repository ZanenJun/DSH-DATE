import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CalendarStore } from '../src/store.js';
import { ReminderScheduler } from '../src/scheduler.js';
import { ReminderAgent } from '../src/reminder-agent.js';
import { calendarMemory } from '../src/memory.js';
import { OneBot } from '../src/onebot.js';
import { fakeAgents } from './agent-fixture.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-agent-test-'));
  let now = Date.now(); const clock = () => now;
  const store = await new CalendarStore(dir, {clock}).open();
  const input = {title:'学习',dueAt:new Date(now).toISOString()};
  await store.upsert({id:'task',item:input});
  t.after(async()=>{await store.close();await fs.rm(dir,{recursive:true,force:true});});
  const scheduler = new ReminderScheduler(store,{clock,ownerQQ:'123',botQQ:'456',send:async()=>({message_id:1})});
  return {store,scheduler,input,clock,advance:n=>now+=n};
}

test('agent receives unacknowledged history, no tools, and outputs text via an owned DSH turn',async t=>{
  const s=await fixture(t), ctx=fakeAgents(); const generator=new ReminderAgent(ctx,{tone:'友好直接',timeoutMs:1000});
  s.scheduler.send=async batch=>{Object.assign(batch,await generator.generate(batch,s.store.snapshot()));return {message_id:9};};
  await s.scheduler.tick();s.advance(30000);await s.scheduler.tick();
  assert.equal(ctx.calls.length,2);assert.equal(ctx.disposed.length,2);
  assert.deepEqual(ctx.restrictions,[{allow:[]},{allow:[]}]);
  const prompt=ctx.calls[1].content[0].text;
  assert.ok(prompt.includes('友好直接'));assert.ok(prompt.includes('该喝水了'));assert.ok(prompt.includes('"sentCount":1'));
  assert.equal(s.store.snapshot().memory.filter(x=>x.type==='reminder-sent').length,2);
  await s.store.close();await s.store.open();
  assert.equal(calendarMemory(s.store.snapshot()).recentHistory.at(-1).agentSessionId,ctx.disposed[1]);
});

for (const change of ['reschedule','reply','complete','delete','snooze']) test(`${change} during generation discards draft before QQ delivery`,async t=>{
  const s=await fixture(t);let release, entered;
  const started=new Promise(r=>entered=r), blocked=new Promise(r=>release=r);
  const ctx=fakeAgents(async()=>{entered();await blocked;return '旧时间提醒';});
  const generator=new ReminderAgent(ctx,{tone:'简洁',timeoutMs:1000});let delivered=0;
  s.scheduler.send=async batch=>{
    const output=await generator.generate(batch,s.store.snapshot());
    if(!output||!batch.isCurrent())return {skipped:true};
    Object.assign(batch,output);delivered++;return {message_id:1};
  };
  const tick=s.scheduler.tick();await started;
  if(change==='reschedule')await s.store.upsert({id:'task',baseRevision:1,item:{...s.input,dueAt:new Date(s.clock()+3600000).toISOString()}});
  if(change==='reply')await s.scheduler.receive({post_type:'message',message_type:'private',self_id:456,user_id:123,message_id:8,time:Math.floor(s.clock()/1000),raw_message:'我知道了'});
  if(change==='complete')await s.scheduler.act({action:'complete',itemId:'task'});
  if(change==='delete')await s.store.remove({id:'task',baseRevision:1});
  if(change==='snooze')await s.scheduler.act({action:'snooze',itemId:'task',minutes:10});
  release();await tick;
  assert.equal(delivered,0);assert.equal(s.store.snapshot().memory.filter(x=>x.type==='reminder-sent').length,0);
});

test('changing a due time cancels old reminders; a past replacement is a new overdue occurrence',async t=>{
  const s=await fixture(t);let count=0;
  s.scheduler.send=async()=>{count++;return {message_id:count};};
  await s.scheduler.tick();
  await s.store.upsert({id:'task',baseRevision:1,item:{...s.input,dueAt:new Date(s.clock()+3600000).toISOString()}});
  s.advance(30000);await s.scheduler.tick();assert.equal(count,1);
  await s.store.upsert({id:'task',baseRevision:2,item:{...s.input,dueAt:new Date(s.clock()-60000).toISOString()}});
  await s.scheduler.tick();assert.equal(count,2);
  const occurrences=Object.values(s.store.snapshot().occurrences);
  assert.equal(occurrences[0].state,'cancelled');assert.equal(occurrences.at(-1).state,'active');
});

test('model failure never falls back to a fixed template and cadence starts after delivery',async t=>{
  const s=await fixture(t); const ctx=fakeAgents(async()=>{throw Error('provider offline');});
  const generator=new ReminderAgent(ctx,{tone:'简洁',timeoutMs:1000});
  s.scheduler.send=async batch=>generator.generate(batch,s.store.snapshot());
  await s.scheduler.tick();await s.scheduler.tick();assert.equal(ctx.calls.length,1);
  assert.equal(s.store.snapshot().memory.filter(x=>x.type==='reminder-sent').length,0);
  s.advance(30000);s.scheduler.send=async batch=>{s.advance(20000);batch.text='Agent 正文';return {message_id:2};};
  await s.scheduler.tick();const sentAt=s.clock();s.advance(29999);await s.scheduler.tick();
  assert.equal(s.store.snapshot().lastDeliveryAt,sentAt);
});

test('calendar memory includes Mac-style edits and authentic replies without completing the item',async t=>{
  const s=await fixture(t);await s.scheduler.tick();
  await s.store.upsert({id:'task',baseRevision:1,item:{...s.input,title:'Mac 修改后的学习安排'}});
  const event={post_type:'message',message_type:'private',self_id:456,user_id:123,message_id:9,time:Math.floor(s.clock()/1000),message:[{type:'text',data:{text:'晚点再做'}}]};
  await s.scheduler.receive(event);await s.scheduler.receive(event);
  const m=calendarMemory(s.store.snapshot());
  assert.equal(m.items[0].title,'Mac 修改后的学习安排');assert.equal(m.items[0].status,'open');
  assert.equal(m.recentHistory.filter(x=>x.type==='user-reply').length,1);
  assert.equal(m.recentHistory.at(-1).text,'晚点再做');
});

test('OneBot checks draft validity again after awaiting account verification', async()=>{
  const transport=new OneBot({botQQ:'456',ownerQQ:'123'},()=>{});transport.connected=true;
  let valid=true;const calls=[];
  transport.call=async action=>{calls.push(action);valid=false;return {user_id:456};};
  const result=await transport.send({text:'stale',isCurrent:()=>valid});
  assert.deepEqual(result,{skipped:true});assert.deepEqual(calls,['get_login_info']);
});
