import {DateTime} from 'luxon';
export function syncWindow(now=Date.now(),timeZone='Asia/Shanghai') {
  const month=DateTime.fromMillis(now,{zone:timeZone}).startOf('month');
  const start=month.minus({months:1}),end=month.plus({months:2});
  return {from:+start,to:+end,fromISO:start.toUTC().toISO(),toISO:end.toUTC().toISO(),timeZone,
    months:[-1,0,1].map(n=>month.plus({months:n}).toFormat('yyyy-MM'))};
}
export function withinWindow(fields,window) {
  if(!fields?.dueAt)return false;
  const start=Date.parse(fields.dueAt),end=start+(fields.durationMinutes??30)*60000;
  return start<window.to && end>window.from;
}
