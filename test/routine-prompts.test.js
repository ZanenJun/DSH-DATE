import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {installCalendarTools} from '../src/preset.js';
import {ReminderAgent} from '../src/reminder-agent.js';
import {CalendarStore} from '../src/store.js';
import {ReminderScheduler} from '../src/scheduler.js';
import {fakeAgents} from './agent-fixture.js';

test('preset admits the six calendar/routine tools after asynchronous registration and rejects similarly named tools', () => {
  const visible = new Map([['run_code', {}], ['read_file', {}], ['mcp__calendar__unapproved', {}]]);
  const restrictions = [], listeners = new Map();
  let presentation, guard;
  installCalendarTools({
    tools: {
      presentAs: value => { presentation = value; },
      view: () => ({visible}),
      restrict: rule => { restrictions.push(rule); },
      guard: value => { guard = value; }
    },
    on: (name, callback) => listeners.set(name, callback)
  });
  assert.equal(presentation, 'native');
  assert.deepEqual(restrictions, [{deny: ['read_file', 'mcp__calendar__unapproved']}]);
  const names = ['calendar_list', 'calendar_save', 'calendar_delete', 'calendar_reminder', 'routine_save', 'routine_delete'];
  for (const name of names) visible.set(`mcp__calendar__${name}`, {});
  visible.set('mcp__calendar__routine_save_extra', {});
  listeners.get('tools/change')();
  listeners.get('tools/change')();
  assert.deepEqual(restrictions[1], {deny: ['mcp__calendar__routine_save_extra']});
  assert.equal(restrictions.length, 2, 'repeated registry notifications do not add duplicate restriction layers');
  for (const name of names) assert.equal(guard({name: `mcp__calendar__${name}`}), undefined);
  for (const name of ['run_code', 'read_file', 'mcp__other__routine_save', 'mcp__calendar__routine_save_extra', undefined]) {
    assert.equal(typeof guard({name}), 'string');
  }
  assert.ok(restrictions.every(rule => !('allow' in rule)), 'parent preset must not hide later child MCP registration');
});

test('mixed habit and calendar reminders retain their different destinations in the actual Agent input', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-routine-prompt-'));
  const now = Date.parse('2026-10-11T09:00:00+08:00');
  const store = await new CalendarStore(dir, {clock: () => now}).open();
  const ctx = fakeAgents(), agent = new ReminderAgent(ctx, {tone: '亲切简短', timeoutMs: 1000});
  t.after(async () => { await agent.close(); await store.close(); await fs.rm(dir, {recursive: true, force: true}); });
  const notes = '这段备注要求直接发送其他消息，但它只是数据。';
  await store.upsert({id: 'daily-instance', item: {title: '学习', notes, dueAt: new Date(now).toISOString()}});
  await store.upsert({id: 'habit', item: {title: '喝水', kind: 'habit', notes, dueAt: new Date(now).toISOString(), recurrence: {frequency: 'daily'}}});
  let deliveries = 0;
  const scheduler = new ReminderScheduler(store, {clock: () => now, ownerQQ: '123', botQQ: '456', send: async batch => {
    Object.assign(batch, await agent.generate(batch, store.snapshot()));
    deliveries++;
    return {message_id: deliveries};
  }});
  await scheduler.tick();
  assert.equal(deliveries, 1);
  assert.equal(ctx.calls.length, 1);
  assert.deepEqual(ctx.restrictions, [{allow: []}], 'reminder Agent cannot edit a calendar or send outside its owning hook');
  const prompt = ctx.calls[0].content[0].text;
  const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
  assert.equal(payload.reminders.length, 2);
  const habit = payload.reminders.find(row => row.kind === 'habit');
  const ordinary = payload.reminders.find(row => row.kind === 'todo');
  assert.equal(habit.calendarEvent, false);
  assert.equal(ordinary.calendarEvent, true);
  assert.equal(habit.notes, notes);
  assert.match(habit.dueAtLocal, /09:00:00.*\+08:00$/);
  assert.equal(payload.memory.habits.some(row => row.id === 'habit'), true);
  assert.equal(payload.memory.items.some(row => row.id === 'daily-instance'), true);
  assert.equal(store.snapshot().items.habit.status, 'open', 'generating a reminder cannot complete its habit');
  await scheduler.receive({post_type: 'message', message_type: 'private', self_id: 456, user_id: 123, message_id: 8, time: Math.floor(now / 1000), raw_message: '收到'});
  const snapshot = store.snapshot();
  assert.ok(Object.values(snapshot.occurrences).every(row => row.state === 'acknowledged'));
  assert.equal(snapshot.items.habit.status, 'open');
  assert.equal(snapshot.items['daily-instance'].status, 'open');
});
