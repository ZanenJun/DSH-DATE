import ICAL from 'ical.js';
import { DateTime, IANAZone } from 'luxon';
import { createHash } from 'node:crypto';
import { normalizeItem } from './model.js';

export const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 40);
export const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function fieldsFor(item) {
  return { title: (item.status === 'done' ? '✓ ' : !item.enabled || item.status === 'cancelled' ? '⏸ ' : '') + item.title,
    notes: item.notes, dueAt: item.dueAt, durationMinutes: item.durationMinutes, timeZone: item.timeZone };
}
function timeValue(property, fallback) {
  const t = property?.getFirstValue();
  if (!t || t.isDate) throw Error('全天事件暂不支持');
  const tzid = property.getParameter('tzid');
  const zone = t.zone?.tzid === 'UTC' ? 'UTC' : tzid || fallback;
  if (!IANAZone.isValidZone(zone)) throw Error('事件时区无法识别');
  const d = DateTime.fromObject({ year:t.year, month:t.month, day:t.day, hour:t.hour, minute:t.minute, second:t.second }, {zone});
  if (!d.isValid) throw Error('事件时间无效');
  return d.toUTC().toISO();
}
export function parseEvent(raw, fallback = 'Asia/Shanghai') {
  const root = new ICAL.Component(ICAL.parse(raw));
  const events = root.getAllSubcomponents('vevent');
  const e = events[0];
  if (root.name !== 'vcalendar' || !e) throw Error('不是日历事件');
  const uid = e.getFirstPropertyValue('uid');
  if (typeof uid !== 'string' || !uid) throw Error('事件缺少 UID');
  const url = e.getFirstPropertyValue('url');
  let legacyId, occurrence;
  try { const u = new URL(url); if (u.protocol === 'dshcalendar:') {
    if (u.hostname === 'item') legacyId = decodeURIComponent(u.pathname.slice(1));
    if (u.hostname === 'occurrence') occurrence = decodeURIComponent(u.pathname.slice(1));
  } } catch { /* Unmanaged calendar URL. */ }
  const itemId = e.getFirstPropertyValue('x-dsh-item-id') || legacyId;
  occurrence = e.getFirstPropertyValue('x-dsh-occurrence') || occurrence;
  const identity = { uid, itemId, occurrence };
  try {
    if (events.length !== 1 || ['rrule','rdate','exdate','recurrence-id'].some(p => e.hasProperty(p))) throw Error('原生重复事件暂不支持，请通过 QQ 管理习惯');
    if (e.hasProperty('organizer') || e.hasProperty('attendee')) throw Error('会议邀请暂不支持');
    const tzid = e.getFirstProperty('dtstart')?.getParameter('tzid');
    const timeZone = e.getFirstPropertyValue('x-dsh-timezone') || tzid || fallback;
    if (!IANAZone.isValidZone(timeZone)) throw Error('事件时区无法识别');
    const dueAt = timeValue(e.getFirstProperty('dtstart'), timeZone);
    let durationMinutes = 30;
    if (e.hasProperty('dtend')) durationMinutes = (Date.parse(timeValue(e.getFirstProperty('dtend'), timeZone)) - Date.parse(dueAt)) / 60000;
    else if (e.hasProperty('duration')) durationMinutes = e.getFirstPropertyValue('duration').toSeconds() / 60;
    const fields = { title: e.getFirstPropertyValue('summary') || '未命名', notes:e.getFirstPropertyValue('description') || '', dueAt, durationMinutes, timeZone };
    normalizeItem({...fields,title:fields.title.replace(/^(?:✓ |⏸ |↻ )+/, '')});
    return { ...identity, fields, root };
  } catch (e) { return { ...identity, unsupported: e.message }; }
}

export function encodeEvent({uid, itemId, occurrence, fields, raw}) {
  const root = raw ? new ICAL.Component(ICAL.parse(raw)) : new ICAL.Component(['vcalendar', [], []]);
  root.updatePropertyWithValue('version', '2.0'); root.updatePropertyWithValue('prodid', '-//DSH-DATE//iCloud Sync//ZH');
  let e = root.getFirstSubcomponent('vevent');
  if (!e) { e = new ICAL.Component('vevent'); root.addSubcomponent(e); }
  if (root.getAllSubcomponents('vevent').length !== 1) throw Error('拒绝覆盖重复事件');
  for (const name of ['dtstart','dtend','duration']) e.removeAllProperties(name);
  const asTime = ms => ICAL.Time.fromJSDate(new Date(ms), true);
  e.updatePropertyWithValue('uid', uid);
  e.updatePropertyWithValue('summary', fields.title);
  e.updatePropertyWithValue('description', fields.notes);
  e.updatePropertyWithValue('dtstart', asTime(Date.parse(fields.dueAt)));
  e.updatePropertyWithValue('dtend', asTime(Date.parse(fields.dueAt) + fields.durationMinutes * 60000));
  e.updatePropertyWithValue('dtstamp', asTime(Date.now()));
  e.updatePropertyWithValue('sequence', Number(e.getFirstPropertyValue('sequence') || 0) + 1);
  e.updatePropertyWithValue('x-dsh-timezone', fields.timeZone);
  if (itemId) e.updatePropertyWithValue('x-dsh-item-id', itemId);
  if (occurrence) e.updatePropertyWithValue('x-dsh-occurrence', occurrence);
  return root.toString() + '\r\n';
}
