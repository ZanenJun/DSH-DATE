import { DateTime } from 'luxon';
// Durable, bounded calendar memory shared by QQ conversations and reminder turns.
export const localTime = (iso, zone) => DateTime.fromISO(iso).setZone(zone).toISO();
export function remember(data, event, now = Date.now()) {
  data.memory ??= [];
  data.memory.push({ at: new Date(now).toISOString(), ...event });
  data.memory = data.memory.slice(-200);
}

export function calendarMemory(data) {
  const items = Object.values(data.items).filter(i => !i.deletedAt);
  return {
    revision: data.revision, totalItems: items.length,
    items: items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 60)
      .map(i => ({ id: i.id, title: i.title, notes: i.notes.slice(0, 500), dueAt: i.dueAt,
        dueAtLocal: localTime(i.dueAt, i.timeZone), timeZone: i.timeZone, status: i.status, enabled: i.enabled, recurrence: i.recurrence })),
    occurrences: Object.values(data.occurrences).sort((a, b) => b.dueAt.localeCompare(a.dueAt)).slice(0, 40),
    recentHistory: (data.memory ?? []).slice(-40)
  };
}

export function replyText(event) {
  if (Array.isArray(event.message)) return event.message.filter(s => s.type === 'text').map(s => s.data?.text ?? '').join('').slice(0, 2000);
  return String(event.raw_message ?? event.message ?? '').slice(0, 2000);
}
