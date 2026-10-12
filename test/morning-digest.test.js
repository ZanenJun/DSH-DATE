import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CalendarStore } from '../src/store.js';
import { normalizeItem } from '../src/model.js';
import { MorningDigestScheduler, buildMorningSummary } from '../src/morning-digest.js';
import { MorningAgent, morningPrompt } from '../src/morning-agent.js';
import { fakeAgents } from './agent-fixture.js';

const beforeEight = Date.parse('2026-10-12T07:59:00+08:00');
const atEight = beforeEight + 60000;
function item(id, extra = {}) {
  return { ...normalizeItem({ title: id, dueAt: '2026-10-12T09:00:00+08:00', durationMinutes: 30, ...extra }),
    id, revision: 1, scheduleVersion: 1, deletedAt: null };
}
function data() {
  return { items: {
    habit: item('habit', { title: '喝水', kind: 'habit', recurrence: { frequency: 'daily' } }),
    daily: { ...item('daily', { title: '整理笔记', dueAt: '2026-10-12T07:00:00+08:00' }), dailyTaskId: 'routine', dailyDate: '2026-10-12' },
    goal: { ...item('goal', { title: '读十页', dueAt: '2026-10-12T20:00:00+08:00', durationMinutes: 45 }), goalId: 'book', goalDate: '2026-10-12' },
    ordinary: item('ordinary', { title: '临时会议' })
  }, occurrences: {}, goals: { book: { id: 'book', title: '读完这本书', deadlineDate: '2026-10-31',
    dailyTitle: '读十页', defaultStartTime: '20:00', defaultDurationMinutes: 45,
    timeZone: 'Asia/Shanghai', enabled: true, status: 'open', startDate: '2026-10-12', notes: '', revision: 1 } } };
}
async function fixture(t, now = beforeEight) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-morning-'));
  const clock = () => now;
  const store = await new CalendarStore(directory, { clock }).open();
  await store.transact(d => Object.assign(d, data()));
  const sent = [];
  const scheduler = new MorningDigestScheduler(store, { clock, send: async batch => {
    assert.equal(await batch.markSending(), true);
    assert.equal(store.snapshot().morningDigests[batch.date].status, 'sending');
    batch.text = '今日清单'; batch.agentSessionId = 'test-morning'; sent.push(batch);
    return { message_id: sent.length };
  } });
  t.after(async () => { await scheduler.close(); await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, store, scheduler, sent, clock, set: value => now = value, advance: value => now += value };
}

test('08:00 sends one three-list digest, persists history, and never creates nagging occurrences', async t => {
  const f = await fixture(t);
  await f.scheduler.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(f.scheduler.status().initializedAt, new Date(beforeEight).toISOString());
  f.set(atEight); await f.scheduler.tick();
  const [batch] = f.sent;
  assert.equal(batch.summary.habits[0].title, '喝水');
  assert.equal(batch.summary.dailyTasks[0].startTime, '07:00', 'already elapsed tasks still belong to today');
  assert.equal(batch.summary.goals[0].deadlineDate, '2026-10-31');
  assert.equal(batch.summary.goals[0].durationMinutes, 45);
  assert.equal(JSON.stringify(batch.summary).includes('临时会议'), false);
  assert.deepEqual(f.store.snapshot().occurrences, {});
  assert.equal(f.store.snapshot().memory.at(-1).type, 'morning-digest-sent');
  f.advance(30000); await f.scheduler.tick(); assert.equal(f.sent.length, 1);
  await f.scheduler.close(); await f.store.close(); await f.store.open();
  const restored = new MorningDigestScheduler(f.store, { clock: f.clock, send: () => assert.fail('duplicate digest') });
  await restored.tick(); assert.equal(restored.status().today.status, 'sent'); await restored.close();
});

test('first enable after 08:00 skips today; next day works normally and startup never backfills yesterday', async t => {
  const f = await fixture(t, atEight + 6 * 3600000);
  await f.scheduler.tick(); assert.equal(f.sent.length, 0);
  assert.equal(f.scheduler.status().today.reason, 'first-enabled-after-morning');
  f.set(atEight + 86400000 - 1000); await f.scheduler.tick(); assert.equal(f.sent.length, 0);
  f.advance(1000); await f.scheduler.tick(); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].date, '2026-10-13');
  assert.equal(f.sent[0].summary.dailyTasks.length, 0);
  assert.equal(f.sent[0].summary.goals.length, 0);
});

test('previously initialized installation catches up only current day after downtime', async t => {
  const f = await fixture(t); await f.scheduler.tick();
  f.set(atEight + 2 * 86400000 + 2 * 3600000); await f.scheduler.tick();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].date, '2026-10-14');
  assert.deepEqual(Object.keys(f.store.snapshot().morningDigests), ['2026-10-14']);
});

test('summary respects recurrence, real single-instance edits, completed and paused states', () => {
  const d = data();
  d.items.habit.dueAt = '2026-10-11T01:00:00.000Z';
  d.items.weekly = item('weekly', { kind: 'habit', recurrence: { frequency: 'weekly', weekdays: [2] } });
  d.items.disabledHabit = { ...item('disabledHabit', { kind: 'habit', recurrence: { frequency: 'daily' }, enabled: false }) };
  d.items.deleted = { ...d.items.daily, id: 'deleted', deletedAt: new Date(atEight).toISOString() };
  d.items.cancelled = { ...d.items.daily, id: 'cancelled', status: 'cancelled' };
  d.items.tomorrow = { ...d.items.daily, id: 'tomorrow', dueAt: '2026-10-13T09:00:00+08:00' };
  d.items.goal.status = 'done'; d.items.goal.enabled = false;
  d.items.daily.enabled = false;
  d.occurrences['habit:1@2026-10-12T01:00:00.000Z'] = { state: 'acknowledged' };
  let summary = buildMorningSummary(d, atEight);
  assert.deepEqual(summary.habits.map(x => x.id), ['habit']);
  assert.equal(summary.habits[0].state, 'acknowledged');
  assert.deepEqual(summary.dailyTasks.map(x => x.id), ['daily']);
  assert.equal(summary.dailyTasks[0].state, 'reminders-paused');
  assert.equal(summary.goals[0].state, 'done');
  d.occurrences['habit:1@2026-10-12T01:00:00.000Z'].state = 'done';
  summary = buildMorningSummary(d, atEight);
  assert.equal(summary.habits[0].state, 'done');
  assert.equal(summary.habits[0].calendarEvent, false);
});

test('habit wall-clock schedules use the service date and keep snooze facts distinct', () => {
  const d = data();
  d.items = { habit: item('habit', { title: '纽约散步', kind: 'habit', dueAt: '2026-03-07T09:00:00-05:00',
    timeZone: 'America/New_York', recurrence: { frequency: 'daily' } }) };
  const now = Date.parse('2026-03-08T08:00:00-04:00');
  const key = 'habit:1@2026-03-08T13:00:00.000Z';
  d.occurrences[key] = { state: 'active', snoozeUntil: Date.parse('2026-03-09T10:00:00-04:00') };
  const summary = buildMorningSummary(d, now, 'America/New_York');
  assert.equal(summary.habits[0].dueAt, '2026-03-08T13:00:00.000Z');
  assert.equal(summary.habits[0].startTime, '09:00');
  assert.equal(summary.habits[0].state, 'snoozed');
  assert.equal(summary.habits[0].nextReminderAtLocal, '2026-03-09T10:00:00.000-04:00');
});

test('previous-day habit snoozed into today is listed separately from the regular daily occurrence', () => {
  const d = data(); d.items.habit.dueAt = '2026-10-11T01:00:00.000Z';
  d.occurrences['habit:1@2026-10-11T01:00:00.000Z'] = {
    itemId: 'habit', dueAt: '2026-10-11T01:00:00.000Z', state: 'active',
    snoozeUntil: Date.parse('2026-10-12T10:00:00+08:00')
  };
  const summary = buildMorningSummary(d, atEight);
  assert.equal(summary.habits.length, 2);
  assert.deepEqual(summary.habits.map(row => row.startTime), ['09:00', '10:00']);
  assert.equal(summary.habits[1].postponedFromPreviousDay, true);
  assert.equal(summary.habits[1].originalDueAtLocal, '2026-10-11T09:00:00.000+08:00');
  assert.equal(summary.habits[1].state, 'snoozed');
  assert.equal(new Set(summary.habits.map(row => row.occurrenceKey)).size, 2);
  d.occurrences['habit:1@2026-10-11T01:00:00.000Z'].state = 'done';
  assert.equal(buildMorningSummary(d, atEight).habits[1].state, 'done');
});

test('empty day stays silent and is durably skipped', async t => {
  const f = await fixture(t); await f.scheduler.tick();
  await f.store.transact(d => { d.items = {}; });
  f.set(atEight); await f.scheduler.tick();
  assert.equal(f.scheduler.status().today.reason, 'no-items');
  await f.store.transact(d => Object.assign(d, data()));
  await f.scheduler.tick(); assert.equal(f.sent.length, 0);
});

test('unrelated sync/history writes do not invalidate draft, while actual schedule edits do', async t => {
  const f = await fixture(t); await f.scheduler.tick(); f.set(atEight);
  let inspected = false;
  f.scheduler.send = async batch => {
    await f.store.transact(d => { d.syncClients.test = { seen: 'change' }; (d.memory ??= []).push({ text: 'hello' }); });
    assert.equal(batch.isCurrent(), true);
    await f.store.transact(d => { d.items.daily.dueAt = '2026-10-13T07:00:00+08:00'; });
    assert.equal(batch.isCurrent(), false); assert.equal(await batch.markSending(), false);
    inspected = true; return { skipped: true };
  };
  await f.scheduler.tick(); assert.equal(inspected, true);
  assert.equal(f.scheduler.status().today.status, 'pending');
  assert.equal(f.scheduler.status().today.attempts, 0);
  f.advance(1000);
  f.scheduler.send = async batch => {
    assert.equal(batch.summary.dailyTasks.length, 0); assert.equal(await batch.markSending(), true);
    return { message_id: 4 };
  };
  await f.scheduler.tick(); assert.equal(f.scheduler.status().today.status, 'sent');
});

test('generation failures back off instead of nagging every 30 seconds and stop after five attempts', async t => {
  const f = await fixture(t); await f.scheduler.tick(); f.set(atEight);
  let attempts = 0;
  f.scheduler.send = async () => { attempts++; throw Error('model unavailable'); };
  await f.scheduler.tick(); assert.equal(attempts, 1);
  f.advance(30000); await f.scheduler.tick(); assert.equal(attempts, 1);
  for (const wait of [30000, 300000, 900000, 3600000]) {
    f.advance(wait); await f.scheduler.tick();
  }
  assert.equal(attempts, 5); assert.equal(f.scheduler.status().today.status, 'exhausted');
  f.advance(3600000); await f.scheduler.tick(); assert.equal(attempts, 5);
});

test('ambiguous QQ send is not retried even if source data changes during the failed request', async t => {
  const f = await fixture(t); await f.scheduler.tick(); f.set(atEight);
  f.scheduler.send = async batch => {
    assert.equal(await batch.markSending(), true);
    await f.store.transact(d => { d.items.daily.title = '改名了'; });
    throw Error('reply lost after QQ might have accepted');
  };
  await f.scheduler.tick(); assert.equal(f.scheduler.status().today.status, 'uncertain');
  f.advance(3600000); f.scheduler.send = () => assert.fail('unsafe duplicate');
  await f.scheduler.tick();
});

test('restart distinguishes unfinished generation from interrupted transport delivery', async t => {
  const f = await fixture(t); await f.scheduler.tick(); f.set(atEight);
  await f.store.transact(d => { d.morningDigests['2026-10-12'] = {
    status: 'generating', attempts: 1, deliveryId: 'crashed-generation', retryAt: atEight + 60000
  }; });
  await f.scheduler.tick(); assert.equal(f.sent.length, 0);
  f.advance(60000); await f.scheduler.tick(); assert.equal(f.sent.length, 1);
  await f.store.transact(d => { d.morningDigests['2026-10-12'] = {
    status: 'sending', attempts: 1, deliveryId: 'crashed-send'
  }; });
  await f.scheduler.tick(); assert.equal(f.scheduler.status().today.status, 'uncertain');
  assert.equal(f.sent.length, 1);
});

test('closing invalidates an in-progress draft before transport is allowed', async t => {
  const f = await fixture(t); await f.scheduler.tick(); f.set(atEight);
  let release, entered;
  const started = new Promise(resolve => entered = resolve);
  f.scheduler.send = async batch => {
    entered(); await new Promise(resolve => release = resolve);
    assert.equal(batch.isCurrent(), false); assert.equal(await batch.markSending(), false);
    return { skipped: true };
  };
  const work = f.scheduler.tick(); await started;
  const closed = f.scheduler.close(); release(); await closed; await work;
  assert.equal(f.scheduler.status().today.status, 'pending');
});

test('Morning Agent uses real detached tool-free turn and requires every scheduled title/time', async () => {
  const summary = buildMorningSummary(data(), atEight);
  const text = '今天这三件记好了：习惯 09:00 喝水；每日必做 07:00 整理笔记，30分钟；待完成目标“读完这本书”在2026-10-31前完成，今天20:00 读十页，45分钟。';
  const ctx = fakeAgents(async () => text), generator = new MorningAgent(ctx, { timeoutMs: 1000 });
  const batch = { deliveryId: 'morning-test', summary, isCurrent: () => true };
  const result = await generator.generate(batch);
  assert.equal(result.text, text);
  assert.equal(result.agentSessionId, 'calendar-morning-morning-test');
  assert.deepEqual(ctx.restrictions, [{ allow: [] }]);
  assert.equal(ctx.disposed.length, 1);
  assert.match(JSON.stringify(ctx.calls[0]), /calendar-morning/);
  assert.match(morningPrompt(summary), /不要求用户确认总览/);
  assert.match(morningPrompt(summary), /reminders-paused/);
  await generator.close();
  const incomplete = new MorningAgent(fakeAgents(async () => '今天记得09:00 喝水哦。'));
  await assert.rejects(incomplete.generate(batch), /complete morning digest/); await incomplete.close();
});
