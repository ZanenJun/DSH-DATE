import {syncWindow,withinWindow} from './sync-window.js';
// Sync receipts are derived from the current item revision and cloud read-back map,
// never from a successful local save alone. Device-side refresh is not observable.
export function itemSyncStatus(item, data, {enabled=false,available=false,error=null,now=Date.now(),timeZone='Asia/Shanghai'}={}) {
  if(item.kind==='habit')return {backend:'local',state:'local-only',message:'习惯仅保存在本地，通过 Agent 口头提醒并等待回复，不写入日历。'};
  if(!enabled)return {backend:'mac',state:'unverified',message:'已保存到 Linux；未确认 Mac 日历同步。'};
  const s=data.syncClients?.icloud,map=s?.maps?.[item.id];
  const base={backend:'icloud',lastSyncAt:s?.lastSyncAt??null};
  const window=syncWindow(now,timeZone);
  if(!item.recurrence && !withinWindow(item,window) && !withinWindow(map?.base,window))return {...base,state:'archived',window,message:'已按月归档；当前只同步上个月、本月和下个月，本项暂不参与同步。'};
  if(s?.conflicts?.[item.id])return {...base,state:'conflict',message:'两端版本冲突，尚未完成同步。'};
  if(item.deletedAt && !map && !s?.pending?.[item.id])return {...base,state:'unverified',message:'本地已删除，当前无云端映射及待发送请求；不将历史删除记录算作待上传事项。'};
  if(!available || error || s?.lastError)return {...base,state:'error',message:'已保存到 Linux；iCloud 同步异常，尚未确认本次更改上传。'};
  if(item.recurrence)return {...base,state:'projection',message:'重复事项通过多个日历投影异步同步，请勿将本次本地保存称为已同步。'};
  if(!item.deletedAt && s?.lastSyncAt && map?.kind==='item' && map.revision===item.revision && !map.missing && !s.pending?.[item.id]) {
    return {...base,state:'synced',confirmedRevision:map.revision,message:'本次版本已由 iCloud 写入后读回确认；iPhone/Mac 是否刷新仍需在设备查看。'};
  }
  return {...base,state:'pending',message:'已保存到 Linux；等待 iCloud 同步确认。'};
}
