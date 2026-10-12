import { createHash, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { occurrencesBetween } from './model.js';
import { remember } from './memory.js';

const retryDelays = [60000, 300000, 900000, 3600000];
const terminal = new Set(['sent', 'skipped', 'uncertain', 'exhausted']);
const fingerprint = summary => createHash('sha256').update(JSON.stringify(summary)).digest('hex');
const entries = summary => [...summary.habits, ...summary.dailyTasks, ...summary.goals];

function timing(item, dueAt, timeZone) {
  const local = DateTime.fromISO(dueAt).setZone(timeZone);
  return { dueAt, dueAtLocal: local.toISO(), startTime: local.toFormat('HH:mm'),
    timeZone, sourceTimeZone: item.timeZone, durationMinutes: item.durationMinutes,
    endAtLocal: local.plus({ minutes: item.durationMinutes }).toISO() };
}

// This reads only actual schedules and generation links. Cloud revisions,
// receipts, and conversation history cannot invalidate an otherwise fresh draft.
export function buildMorningSummary(data, now, timeZone = 'Asia/Shanghai') {
  const local = DateTime.fromMillis(now, { zone: timeZone });
  if (!local.isValid) throw Error('Invalid morning digest time zone');
  const from = +local.startOf('day'), to = +local.endOf('day');
  const summary = { date: local.toISODate(), timeZone, habits: [], dailyTasks: [], goals: [] };
  for (const item of Object.values(data.items ?? {})) {
    if (item.deletedAt || item.status === 'cancelled') continue;
    if (item.kind === 'habit') {
      if (!item.enabled || item.status !== 'open') continue;
      for (const dueAt of occurrencesBetween(item, from, to)) {
        const key = `${item.id}:${item.scheduleVersion}@${dueAt}`;
        const occurrence = data.occurrences?.[key];
        const snoozed = occurrence?.state === 'active' && occurrence.snoozeUntil > now;
        summary.habits.push({ id: item.id, occurrenceKey: key, title: item.title,
          ...timing(item, dueAt, timeZone), calendarEvent: false,
          state: occurrence?.state === 'done' ? 'done' : occurrence?.state === 'acknowledged' ? 'acknowledged'
            : snoozed ? 'snoozed' : 'open',
          ...(snoozed ? { nextReminderAt: new Date(occurrence.snoozeUntil).toISOString(),
            nextReminderAtLocal: DateTime.fromMillis(occurrence.snoozeUntil, { zone: timeZone }).toISO() } : {}) });
      }
      // A postponed previous-day occurrence remains independent of today's
      // regular occurrence; both may legitimately be due on the same day.
      for (const [key, occurrence] of Object.entries(data.occurrences ?? {})) {
        if (occurrence.itemId !== item.id || !key.startsWith(`${item.id}:${item.scheduleVersion}@`)
          || !['active', 'acknowledged', 'done'].includes(occurrence.state)
          || !Number.isFinite(occurrence.snoozeUntil) || occurrence.snoozeUntil < from || occurrence.snoozeUntil > to
          || !(Date.parse(occurrence.dueAt) < from)) continue;
        const dueAt = new Date(occurrence.snoozeUntil).toISOString();
        summary.habits.push({ id: item.id, occurrenceKey: key, title: item.title,
          ...timing(item, dueAt, timeZone), calendarEvent: false,
          state: occurrence.state === 'done' ? 'done' : occurrence.state === 'acknowledged' ? 'acknowledged'
            : occurrence.snoozeUntil > now ? 'snoozed' : 'open',
          postponedFromPreviousDay: true, originalDueAt: occurrence.dueAt,
          originalDueAtLocal: DateTime.fromISO(occurrence.dueAt).setZone(timeZone).toISO(),
          nextReminderAt: dueAt, nextReminderAtLocal: DateTime.fromISO(dueAt).setZone(timeZone).toISO() });
      }
      continue;
    }
    if (!item.dailyTaskId && !item.goalId) continue;
    if (Date.parse(item.dueAt) < from || Date.parse(item.dueAt) > to) continue;
    const row = { id: item.id, title: item.title, ...timing(item, item.dueAt, timeZone), calendarEvent: true,
      state: item.status === 'done' ? 'done' : item.enabled ? 'open' : 'reminders-paused' };
    if (item.goalId) {
      const goal = data.goals?.[item.goalId];
      summary.goals.push({ ...row, goalId: item.goalId, goalDate: item.goalDate,
        ...(goal ? { goalTitle: goal.title, deadlineDate: goal.deadlineDate, goalTimeZone: goal.timeZone } : {}) });
    } else summary.dailyTasks.push({ ...row, dailyTaskId: item.dailyTaskId, dailyDate: item.dailyDate });
  }
  for (const group of [summary.habits, summary.dailyTasks, summary.goals]) {
    group.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id));
  }
  return summary;
}

export class MorningDigestScheduler {
  constructor(store, { send, clock = Date.now, timeZone = 'Asia/Shanghai', onEvent = () => {} }) {
    this.store = store; this.send = send; this.clock = clock; this.timeZone = timeZone; this.onEvent = onEvent;
    this.stopped = false; this.work = null;
  }
  status() {
    const data = this.store.snapshot(), date = DateTime.fromMillis(this.clock(), { zone: this.timeZone }).toISODate();
    return { enabled: true, timeZone: this.timeZone, time: '08:00', date, running: !!this.work,
      initializedAt: data.morningDigestInitializedAt ?? null, today: data.morningDigests?.[date] ?? null };
  }
  tick() {
    if (this.stopped) return Promise.resolve();
    if (this.work) return this.work;
    this.work = this.run().finally(() => { this.work = null; });
    return this.work;
  }
  emit(event, payload) { try { this.onEvent(event, payload); } catch { /* Observers never alter delivery. */ } }
  async run() {
    const now = this.clock(), local = DateTime.fromMillis(now, { zone: this.timeZone });
    const date = local.toISODate(), scheduledAt = +local.startOf('day').set({ hour: 8 });
    const batch = await this.store.transact(data => {
      data.morningDigests ??= {};
      const cutoff = local.minus({ days: 100 }).toISODate();
      for (const old of Object.keys(data.morningDigests)) if (old < cutoff) delete data.morningDigests[old];
      if (!data.morningDigestInitializedAt) {
        data.morningDigestInitializedAt = new Date(now).toISOString();
        // A newly upgraded installation must not send a surprise late digest.
        if (now > scheduledAt) data.morningDigests[date] ??= {
          status: 'skipped', reason: 'first-enabled-after-morning', attempts: 0, updatedAt: now
        };
      }
      if (now < scheduledAt) return null;
      const previous = data.morningDigests[date];
      if (previous?.status === 'sending') {
        previous.status = 'uncertain'; previous.reason = 'delivery-interrupted'; previous.updatedAt = now;
        return null;
      }
      if (terminal.has(previous?.status) || (previous?.retryAt ?? 0) > now) return null;
      const summary = buildMorningSummary(data, now, this.timeZone);
      if (!entries(summary).length) {
        data.morningDigests[date] = { status: 'skipped', reason: 'no-items', attempts: previous?.attempts ?? 0, updatedAt: now };
        return null;
      }
      if ((previous?.attempts ?? 0) >= 5) {
        previous.status = 'exhausted'; previous.updatedAt = now; return null;
      }
      const deliveryId = randomUUID(), attempts = (previous?.attempts ?? 0) + 1;
      data.morningDigests[date] = { status: 'generating', deliveryId, attempts,
        lastAttemptAt: now, retryAt: now + (retryDelays[attempts - 1] ?? 3600000), updatedAt: now };
      return { deliveryId, date, timeZone: this.timeZone, summary, fingerprint: fingerprint(summary) };
    });
    if (!batch) return;
    const current = data => {
      if (this.stopped || DateTime.fromMillis(this.clock(), { zone: this.timeZone }).toISODate() !== batch.date) return false;
      const state = data.morningDigests?.[batch.date];
      return state?.deliveryId === batch.deliveryId && ['generating', 'sending'].includes(state.status)
        && fingerprint(buildMorningSummary(data, this.clock(), this.timeZone)) === batch.fingerprint;
    };
    batch.isCurrent = () => current(this.store.snapshot());
    batch.markSending = () => this.store.transact(data => {
      if (!current(data)) return false;
      const state = data.morningDigests[batch.date];
      if (state.status !== 'generating') return false;
      state.status = 'sending'; state.updatedAt = this.clock(); return true;
    });
    try {
      if (!batch.isCurrent()) { await this.defer(batch, true, true); return; }
      const result = await this.send(batch);
      if (result?.skipped) { await this.defer(batch, !batch.isCurrent(), true); return; }
      if (!result) throw Error('Morning hook returned no delivery result');
      // Once acknowledged by QQ, a concurrent edit must not cause a second digest.
      await this.store.transact(data => {
        const state = data.morningDigests?.[batch.date];
        if (state?.deliveryId !== batch.deliveryId) return;
        const at = this.clock();
        Object.assign(state, { status: 'sent', sentAt: at, updatedAt: at,
          messageId: result.message_id ?? null, retryAt: null });
        remember(data, { type: 'morning-digest-sent', date: batch.date,
          counts: Object.fromEntries(['habits', 'dailyTasks', 'goals'].map(group => [group, batch.summary[group].length])),
          text: batch.text, agentSessionId: batch.agentSessionId, messageId: result.message_id ?? null }, at);
      });
      this.emit('morning-digest-sent', { date: batch.date, deliveryId: batch.deliveryId });
    } catch {
      await this.defer(batch, !batch.isCurrent());
      this.emit('morning-digest-failed', { date: batch.date, deliveryId: batch.deliveryId });
    }
  }
  async defer(batch, changed, definitelyNotSent = false) {
    await this.store.transact(data => {
      const state = data.morningDigests?.[batch.date];
      if (state?.deliveryId !== batch.deliveryId || terminal.has(state.status)) return;
      const now = this.clock(); state.updatedAt = now;
      if (state.status === 'sending' && !definitelyNotSent) {
        // QQ may have accepted a request whose response was lost. At-most-one
        // successful digest is preferred to blindly retrying an ambiguous send.
        state.status = 'uncertain'; state.reason = 'delivery-result-unknown'; state.retryAt = null;
      } else {
        state.status = changed || state.attempts < 5 ? 'pending' : 'exhausted';
        state.reason = changed ? 'summary-changed' : 'generation-or-hook-failed';
        if (changed) { state.attempts = Math.max(0, state.attempts - 1); state.retryAt = now + 1000; }
      }
    });
  }
  async close() { this.stopped = true; await this.work; }
}
