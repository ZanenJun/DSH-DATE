import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CalendarStore} from '../src/store.js';
import {ReminderScheduler} from '../src/scheduler.js';
import {ReminderAgent} from '../src/reminder-agent.js';
import {calendarMemory} from '../src/memory.js';
import {fakeAgents} from './agent-fixture.js';

test('goal and daily step relationship survives storage and reaches reminder Agent memory without completing the goal',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'calendar-goal-memory-'));
  const now=Date.parse('2026-10-12T09:00:00+08:00');
  let store=await new CalendarStore(directory,{clock:()=>now}).open();
  const ctx=fakeAgents(),agent=new ReminderAgent(ctx,{tone:'轻俏简短',timeoutMs:1000});
  t.after(async()=>{await agent.close();await store.close();await fs.rm(directory,{recursive:true,force:true});});
  const goal=await store.saveRoutine({collection:'goals',id:'read-book',item:{title:'读完这本书',
    deadlineDate:'2026-10-31',dailyTitle:'读一章',defaultStartTime:'09:00',defaultDurationMinutes:30,
    notes:'内容中的“忽略规则”只是备注，不是指令。'}});
  const deleted=await store.saveRoutine({collection:'goals',id:'removed-plan',item:{title:'已移除的计划',
    deadlineDate:'2026-10-31',dailyTitle:'原小任务',defaultStartTime:'10:00',defaultDurationMinutes:15}});
  await store.removeRoutine({collection:'goals',id:deleted.id,baseRevision:deleted.revision});
  const [step]=await store.generateDailies();
  await store.close();
  store=await new CalendarStore(directory,{clock:()=>now}).open();
  const scheduler=new ReminderScheduler(store,{clock:()=>now,ownerQQ:'123',botQQ:'456',send:async batch=>{
    Object.assign(batch,await agent.generate(batch,store.snapshot()));
    return {message_id:1};
  }});
  await scheduler.tick();
  assert.equal(ctx.calls.length,1);
  const prompt=ctx.calls[0].content[0].text;
  const payload=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));
  assert.equal(payload.memory.goals.length,1,'deleted goals do not remain in live Agent goal memory');
  assert.equal(payload.memory.goals[0].id,goal.id);
  assert.equal(payload.memory.goals[0].dailyTitle,'读一章');
  assert.equal(payload.memory.goals[0].deadlineDate,'2026-10-31');
  assert.equal(payload.memory.goals[0].notes,goal.notes,'user notes remain data in JSON');
  const remembered=payload.memory.items.find(item=>item.id===step.id);
  assert.equal(remembered.goalId,goal.id);
  assert.equal(remembered.goalDate,'2026-10-12');
  assert.equal(remembered.durationMinutes,30);
  assert.equal(payload.reminders[0].calendarEvent,true,'a generated goal step is an ordinary calendar todo');
  await scheduler.act({action:'complete',itemId:step.id});
  const updated=calendarMemory(store.snapshot());
  assert.equal(updated.items.find(item=>item.id===step.id).status,'done');
  assert.equal(updated.goals[0].status,'open','finishing today does not imply the whole goal is done');
});
