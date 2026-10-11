import { z } from 'zod';
import { DateTime, IANAZone } from 'luxon';

export const iso = z.string().datetime({ offset: true });
export const recurrenceSchema = z.object({
  frequency: z.enum(['daily', 'weekly']),
  interval: z.number().int().min(1).max(52).default(1),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  until: iso.optional()
}).strict();
export const itemInput = z.object({
  title: z.string().trim().min(1).max(200),
  kind: z.enum(['event', 'todo', 'habit']).default('todo'),
  notes: z.string().max(10000).default(''),
  dueAt: iso,
  durationMinutes: z.number().int().min(1).max(10080).default(30),
  timeZone: z.string().refine(x => IANAZone.isValidZone(x), 'Use an IANA time zone').default('Asia/Shanghai'),
  recurrence: recurrenceSchema.nullable().default(null),
  enabled: z.boolean().default(true),
  status: z.enum(['open', 'done', 'cancelled']).default('open')
}).strict().superRefine((v, ctx) => {
  if (v.kind === 'habit' && !v.recurrence) ctx.addIssue({ code: 'custom', message: 'Habits require recurrence' });
  if (v.recurrence?.until && Date.parse(v.recurrence.until) < Date.parse(v.dueAt)) ctx.addIssue({ code: 'custom', message: 'until must be after dueAt' });
  if (v.recurrence?.frequency === 'daily' && v.recurrence.weekdays) ctx.addIssue({ code: 'custom', message: 'weekdays is only supported for weekly recurrence' });
});
export const itemFields = ['title', 'kind', 'notes', 'dueAt', 'durationMinutes', 'timeZone', 'recurrence', 'enabled', 'status'];
export function editable(item) { return Object.fromEntries(itemFields.map(k => [k, item[k]])); }
export function normalizeItem(input) {
  const out = itemInput.parse(input);
  out.dueAt = new Date(out.dueAt).toISOString();
  if (out.recurrence?.weekdays) out.recurrence.weekdays = [...new Set(out.recurrence.weekdays)].sort();
  return out;
}

function wallTime(item,start) {
  if(item.kind==='habit' && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.defaultTime??'')) {
    const [hour,minute]=item.defaultTime.split(':').map(Number);
    return {hour,minute,second:0,millisecond:0};
  }
  return {hour:start.hour,minute:start.minute,second:start.second,millisecond:start.millisecond};
}

// Enumerate wall-clock dates, not multiples of 24h: DST must not shift a habit's time.
export function occurrencesBetween(item, from, to, limit = 400) {
  const start = DateTime.fromISO(item.dueAt).setZone(item.timeZone);
  const lower = DateTime.fromMillis(from, { zone: item.timeZone });
  const upper = DateTime.fromMillis(to, { zone: item.timeZone });
  if (!item.recurrence) return +start >= from && +start <= to ? [start.toUTC().toISO()] : [];
  const rule = item.recurrence;
  const until = rule.until ? Date.parse(rule.until) : Infinity;
  let day = (+lower < +start ? start : lower).startOf('day');
  const results = [];
  let scans = 0;
  while (+day <= +upper && scans++ < 80000 && results.length < limit) {
    const days = Math.round(day.diff(start.startOf('day'), 'days').days);
    const weeks = Math.floor(day.startOf('week').diff(start.startOf('week'), 'weeks').weeks);
    const selected = rule.frequency === 'daily'
      ? days >= 0 && days % rule.interval === 0
      : weeks >= 0 && weeks % rule.interval === 0 && (rule.weekdays ?? [start.weekday]).includes(day.weekday);
    if (selected) {
      const candidate = day.set(wallTime(item,start));
      if (+candidate >= +start && +candidate >= from && +candidate <= to && +candidate <= until) results.push(candidate.toUTC().toISO());
    }
    day = day.plus({ days: 1 });
  }
  return results;
}

export function latestDue(item, now) {
  if (!item.recurrence) return Date.parse(item.dueAt) <= now ? item.dueAt : null;
  const start = DateTime.fromISO(item.dueAt).setZone(item.timeZone);
  const rule = item.recurrence;
  const end = DateTime.fromMillis(Math.min(now, rule.until ? Date.parse(rule.until) : now)).setZone(item.timeZone);
  if (+end < +start) return null;
  const atTime = day => day.set(wallTime(item,start));
  if (rule.frequency === 'daily') {
    const days = Math.floor(end.startOf('day').diff(start.startOf('day'), 'days').days);
    let candidate = atTime(start.startOf('day').plus({ days: Math.floor(days / rule.interval) * rule.interval }));
    if (+candidate > +end) candidate = atTime(candidate.minus({ days: rule.interval }));
    return +candidate >= +start ? candidate.toUTC().toISO() : null;
  }
  const firstWeek = start.startOf('week');
  const weeks = Math.floor(end.startOf('week').diff(firstWeek, 'weeks').weeks);
  let week = firstWeek.plus({ weeks: Math.floor(weeks / rule.interval) * rule.interval });
  const weekdays = [...(rule.weekdays ?? [start.weekday])].sort((a,b) => b-a);
  for (let attempt = 0; attempt < 2; attempt++, week = week.minus({ weeks: rule.interval })) {
    for (const weekday of weekdays) {
      const candidate = atTime(week.plus({ days: weekday - 1 }));
      if (+candidate <= +end && +candidate >= +start) return candidate.toUTC().toISO();
    }
  }
  return null;
}

export function errorStatus(error) { return error.status ?? (error instanceof z.ZodError ? 400 : 500); }
export function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }
