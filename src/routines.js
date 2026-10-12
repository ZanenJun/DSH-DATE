import { z } from 'zod';
import { DateTime, IANAZone } from 'luxon';
import { normalizeItem, problem } from './model.js';

const wallTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
const fields = {
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(10000).default(''),
  timeZone: z.string().refine(value => IANAZone.isValidZone(value), 'Use an IANA time zone').default('Asia/Shanghai'),
  enabled: z.boolean().default(true)
};

export const dailyTaskInput = z.object({
  ...fields,
  defaultStartTime: wallTime,
  defaultDurationMinutes: z.number().int().min(1).max(10080)
}).strict();

export const habitInput = z.object({ ...fields, defaultTime: wallTime }).strict();

export const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(value => {
  const date = DateTime.fromISO(value, { zone: 'UTC' });
  return date.isValid && date.toISODate() === value;
}, 'Use a real calendar date');

export const goalInput = z.object({
  ...fields,
  status: z.enum(['open', 'done', 'cancelled']).default('open'),
  deadlineDate: calendarDate,
  dailyTitle: z.string().trim().min(1).max(200),
  defaultStartTime: wallTime,
  defaultDurationMinutes: z.number().int().min(1).max(1440)
}).strict().superRefine((item,ctx)=>{
  const start=DateTime.fromISO(`${item.deadlineDate}T${item.defaultStartTime}:00`,{zone:item.timeZone});
  const end=DateTime.fromISO(item.deadlineDate,{zone:item.timeZone}).plus({days:1}).startOf('day');
  if(start.isValid && end.isValid && (start.toISODate()!==item.deadlineDate || +start+item.defaultDurationMinutes*60000>+end)) {
    ctx.addIssue({code:'custom',path:['defaultDurationMinutes'],message:'Daily work must finish within the goal deadline date'});
  }
});

export function habitTime(item) {
  return wallTime.safeParse(item.defaultTime).success ? item.defaultTime
    : DateTime.fromISO(item.dueAt).setZone(item.timeZone).toFormat('HH:mm');
}

// Construct each wall-clock time independently. Adding 24 hours would shift it
// after a DST transition. Luxon advances a nonexistent spring-forward time to
// the corresponding valid time (02:30 becomes 03:30 on that one date).
export function timeOnDate(date, time, timeZone) {
  const value = DateTime.fromISO(`${date}T${time}:00`, { zone: timeZone });
  if (!value.isValid) throw problem('Invalid local routine time');
  return value.toUTC().toISO();
}

export function habitItem(input, now, old) {
  const parsed = habitInput.parse(input);
  const sameTime = old && old.timeZone === parsed.timeZone && habitTime(old) === parsed.defaultTime;
  const date = DateTime.fromMillis(now, { zone: parsed.timeZone }).toISODate();
  return normalizeItem({
    title: parsed.title, notes: parsed.notes, kind: 'habit',
    dueAt: sameTime ? old.dueAt : timeOnDate(date, parsed.defaultTime, parsed.timeZone),
    durationMinutes: old?.durationMinutes ?? 1, timeZone: parsed.timeZone,
    recurrence: old?.recurrence ?? { frequency: 'daily', interval: 1 }, enabled: parsed.enabled,
    status: old?.status ?? 'open'
  });
}
