import { randomUUID } from 'node:crypto';
import { latestDue, problem } from './model.js';
import { remember, replyText } from './memory.js';

export class ReminderScheduler {
  constructor(store, { send, clock = Date.now, repeatMs = 30000, ownerQQ, botQQ, onEvent = () => {} }) {
    this.store = store; this.send = send; this.clock = clock; this.repeatMs = repeatMs;
    this.ownerQQ = String(ownerQQ); this.botQQ = String(botQQ); this.onEvent = onEvent;
    this.busy = false; this.stopped = false;
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const now = this.clock();
      const batch = await this.store.transact(d => {
        for (const item of Object.values(d.items)) {
          if (item.deletedAt || !item.enabled || item.status !== 'open') continue;
          const dueAt = latestDue(item, now);
          if (!dueAt) continue;
          const key = `${item.id}:${item.scheduleVersion}@${dueAt}`;
          // A new habit occurrence supersedes yesterday's nagging, never its history.
          for (const o of Object.values(d.occurrences)) {
            if (o.itemId === item.id && o.key !== key && o.state === 'active' && item.recurrence) o.state = 'superseded';
          }
          d.occurrences[key] ??= { key, itemId: item.id, dueAt, state: 'active', attempts: 0, firstAttemptAt: null, lastAttemptAt: null, acknowledgedAt: null, completedAt: null, snoozeUntil: null };
        }
        if (d.lastDeliveryAt !== null && now - d.lastDeliveryAt < this.repeatMs) return null;
        const pending = Object.values(d.occurrences).filter(o => o.state === 'active'
          && (!o.snoozeUntil || now >= o.snoozeUntil)
          && (o.lastAttemptAt === null || now - o.lastAttemptAt >= this.repeatMs));
        if (!pending.length) return null;
        // Persist BEFORE the send. A crash cannot produce a tight re-send loop.
        d.lastDeliveryAt = now;
        const chosen = pending.sort((a, b) => (a.lastAttemptAt ?? -Infinity) - (b.lastAttemptAt ?? -Infinity)).slice(0, 20);
        for (const o of chosen) { o.firstAttemptAt ??= now; o.lastAttemptAt = now; o.attempts++; }
        const deliveryId = randomUUID();
        return { deliveryId, keys: chosen.map(o => o.key), lastReplyId: d.lastReplyId,
          revisions: Object.fromEntries(chosen.map(o => [o.itemId, d.items[o.itemId].revision])) };
      });
      if (!batch || this.stopped) return;
      // Generation may take seconds. Invalidate the entire draft if any fact changed.
      batch.isCurrent = () => {
        const d = this.store.snapshot();
        return !this.stopped && d.lastReplyId === batch.lastReplyId && batch.keys.every(k => {
          const o = d.occurrences[k], i = o && d.items[o.itemId];
          return o?.state === 'active' && i?.enabled && !i.deletedAt && i.status === 'open'
            && i.revision === batch.revisions[i.id] && (!o.snoozeUntil || this.clock() >= o.snoozeUntil);
        });
      };
      if (!batch.isCurrent()) return;
      try {
        const result = await this.send(batch);
        if (result?.skipped) return;
        const sentAt = this.clock();
        await this.store.transact(d => {
          d.lastDeliveryAt = sentAt;
          for (const key of batch.keys) {
            const o = d.occurrences[key];
            if (o) { o.lastSentAt = sentAt; o.lastMessageId = result?.message_id ?? null; o.lastError = null;
              o.sentCount = (o.sentCount ?? 0) + 1; o.lastText = batch.text; }
          }
          remember(d, { type: 'reminder-sent', keys: batch.keys, text: batch.text,
            agentSessionId: batch.agentSessionId, messageId: result?.message_id ?? null }, sentAt);
        });
        this.onEvent('reminded', { deliveryId: batch.deliveryId, count: batch.keys.length });
      } catch {
        await this.store.transact(d => {
          d.lastDeliveryAt = this.clock();
          for (const key of batch.keys) if (d.occurrences[key]) d.occurrences[key].lastError = 'Agent generation or QQ delivery failed; retry at next reminder interval';
        });
        this.onEvent('delivery-failed', { deliveryId: batch.deliveryId });
      }
    } finally { this.busy = false; }
  }
  async receive(event) {
    if (event.post_type !== 'message' || event.message_type !== 'private'
      || String(event.user_id) !== this.ownerQQ || String(event.self_id) !== this.botQQ) return [];
    if (!Number.isFinite(event.time) || event.message_id === undefined) return [];
    const id = `${event.self_id}:${event.user_id}:${event.message_id}`;
    const at = event.time * 1000;
    if (at > this.clock() + 30000) return [];
    const changed = await this.store.transact(d => {
      if (d.seenMessages.includes(id)) return [];
      d.seenMessages.push(id); d.seenMessages = d.seenMessages.slice(-2000);
      if (at >= (d.lastReplyAt ?? 0)) { d.lastReplyAt = at; d.lastReplyId = id; }
      remember(d, { type: 'user-reply', text: replyText(event), messageAt: at }, this.clock());
      const keys = [];
      for (const o of Object.values(d.occurrences)) {
        if (o.state === 'active' && o.firstAttemptAt !== null && at >= Math.floor(o.firstAttemptAt / 1000) * 1000) {
          o.state = 'acknowledged'; o.acknowledgedAt = this.clock(); keys.push(o.key);
        }
      }
      return keys;
    });
    if (changed.length) this.onEvent('acknowledged', { count: changed.length });
    return changed;
  }
  async act({ action, itemId, occurrenceKey, minutes }) {
    if (!['complete', 'snooze', 'acknowledge'].includes(action)) throw problem('Unknown reminder action');
    if (action === 'snooze' && (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080)) throw problem('minutes must be 1..10080');
    return this.store.transact(d => {
      const item = d.items[itemId];
      if (!Object.hasOwn(d.items, itemId) || !item || item.deletedAt) throw problem('Item not found', 404);
      let o = occurrenceKey ? d.occurrences[occurrenceKey] : Object.values(d.occurrences)
        .filter(x => x.itemId === itemId && ['active', 'acknowledged'].includes(x.state))
        .sort((a, b) => Date.parse(b.dueAt) - Date.parse(a.dueAt))[0];
      if (o && o.itemId !== itemId) throw problem('Occurrence does not belong to item');
      if (occurrenceKey && !o) throw problem('Occurrence not found', 404);
      if (action === 'snooze' && (item.status !== 'open' || !item.enabled)) throw problem('Only open enabled items can be snoozed', 409);
      if (item.recurrence && !o) throw problem('No due habit occurrence; supply a valid occurrenceKey');
      if (o && ['cancelled', 'superseded'].includes(o.state)) throw problem('Occurrence is no longer current', 409);
      const now = this.clock();
      if (!o && action === 'snooze') {
        const key = `${item.id}:${item.scheduleVersion}@${item.dueAt}`;
        o = d.occurrences[key] = { key, itemId, dueAt: item.dueAt, state: 'active', attempts: 0, firstAttemptAt: null, lastAttemptAt: null, acknowledgedAt: null, completedAt: null, snoozeUntil: null };
      }
      if (action === 'complete') {
        if (o && o.state !== 'done') { o.state = 'done'; o.completedAt = now; }
        if (!item.recurrence && item.status !== 'done') { item.status = 'done'; item.revision++; item.updatedAt = new Date(now).toISOString(); }
      } else if (action === 'snooze') {
        if (o.state === 'done') throw problem('Completed occurrence cannot be snoozed', 409);
        o.state = 'active'; o.snoozeUntil = now + minutes * 60000; o.lastAttemptAt = null; o.firstAttemptAt = null;
      } else if (o && o.state !== 'done') { o.state = 'acknowledged'; o.acknowledgedAt = now; }
      remember(d, { type: action, itemId, title: item.title, occurrenceKey: o?.key, minutes }, now);
      return { item, occurrence: o ?? null };
    });
  }
}
