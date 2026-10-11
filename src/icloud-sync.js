import { randomUUID } from 'node:crypto';
import { editable, occurrencesBetween, problem } from './model.js';
import { digest, equal, fieldsFor, parseEvent, encodeEvent } from './icloud-codec.js';
import {syncWindow,withinWindow} from './sync-window.js';

const stateOf = d => d.syncClients.icloud;
const stripStatus = title => title.replace(/^(?:✓ |⏸ )/, '');
export class ICloudSync {
  constructor(store, dav, config, {clock=Date.now,log=()=>{}}={}) {
    this.store=store;this.dav=dav;this.config=config;this.clock=clock;this.log=log;
    this.inflight=null;this.requested=null;this.closed=false;this.failures=0;this.nextAt=0;
  }
  status() {
    const d=this.store.snapshot(),s=stateOf(d);
    const window=this.window(),pending=Object.entries(s?.pending??{}).filter(([id,p])=>this.pendingInWindow(id,p,s,window,d.items[id])).length;
    return {enabled:true,running:!!this.inflight,lastSyncAt:s?.lastSyncAt??null,lastError:s?.lastError??null,
      conflicts:Object.entries(s?.conflicts??{}).map(([id,c])=>({id,reason:c.reason,at:c.at})),
      mapped:Object.keys(s?.maps??{}).length,pending,deferredPending:Object.keys(s?.pending??{}).length-pending,window,unsupported:s?.unsupported??0,intervalMs:this.config.intervalMs};
  }
  window(){return syncWindow(this.clock(),this.config.timeZone);}
  pendingInWindow(id,p,s,window,item){return withinWindow(p.fields,window)||withinWindow(s?.maps?.[id]?.base,window)||withinWindow(item,window);}
  async initialize() {
    const binding={account:digest(this.dav.credentials.username.toLowerCase()),calendarUrl:this.config.calendarUrl};
    await this.store.transact(d=>{
      d.syncClients??={};
      if(stateOf(d) && !equal(stateOf(d).binding,binding))throw Error('iCloud 账户或日历绑定已变化；请先迁移同步记录');
      d.syncClients.icloud??={binding,maps:{},pending:{},conflicts:{},lastSyncAt:null,lastError:null};
    });
  }
  tick(force=false) {
    if(this.closed)return Promise.resolve();
    if(this.inflight)return this.inflight;
    if(!force && this.clock()<this.nextAt)return Promise.resolve();
    this.inflight=this.cycle().then(async()=>{
      this.failures=0;this.nextAt=this.clock()+this.config.intervalMs;
      await this.store.transact(d=>{stateOf(d).lastSyncAt=new Date(this.clock()).toISOString();stateOf(d).lastError=null;});
    }).catch(async e=>{
      this.nextAt=this.clock()+Math.min(300000,this.config.intervalMs*2**Math.min(++this.failures,5));
      // Library/network errors may contain response text. Persist only our bounded diagnostic class.
      const message=e.status===401||e.status===403?'iCloud 认证失败，请重新配置 App 专用密码':
        e.status===409?'iCloud 版本冲突，等待处理':'iCloud 同步未完成；数据保留，将重试。检查网络、凭据及日历绑定。';
      await this.store.transact(d=>{stateOf(d).lastError=message;});this.log(message);
    }).finally(()=>{this.inflight=null;});
    return this.inflight;
  }
  // A tool write may occur after the running cycle took its snapshot. Join one
  // queued follow-up, whose cycle must START after that write was committed.
  requestSync() {
    if(this.closed)return Promise.resolve();
    if(this.requested)return this.requested;
    const previous=this.inflight??Promise.resolve();
    this.requested=previous.catch(()=>{}).then(()=>{
      this.requested=null;
      return this.tick(true);
    });
    return this.requested;
  }
  async conflict(id,reason,remote) {
    await this.store.transact(d=>{stateOf(d).conflicts[id]??={reason,at:new Date(this.clock()).toISOString(),remote:remote?{href:remote.href,etag:remote.etag,raw:remote.raw}:null};});
  }
  decode(object) { return object && {...object,...parseEvent(object.raw,this.config.timeZone)}; }
  async setMap(id,map) { await this.store.transact(d=>{stateOf(d).maps[id]=map;}); }
  mapFor(id,remote,item,kind='item') {
    return {kind,uid:remote.uid,href:remote.href,etag:remote.etag,revision:item.revision,base:remote.fields,missing:0};
  }
  async importEvent(id,remote,old) {
    const values={...(old?editable(old):{kind:'todo',enabled:true,status:'open',recurrence:null}),...remote.fields};
    if(old)values.title=stripStatus(values.title);
    try {
      await this.store.upsert({id,baseRevision:old?.revision??0,item:values,operationId:randomUUID()},(d,item)=>{
        stateOf(d).maps[id]=this.mapFor(id,remote,item);delete stateOf(d).conflicts[id];
      });
    } catch(e) { if(e.status!==409)throw e; await this.conflict(id,'本地在云端改动导入期间发生变化',remote); }
  }
  async queuePut(id,item,map,remote,kind='item',occurrence) {
    const fields=kind==='item'?fieldsFor(item):item.fields;
    const uid=map?.uid??`dsh-${id}@dsh-calendar`;
    const href=map?.href??new URL(`${encodeURIComponent(uid)}.ics`,this.config.calendarUrl).href;
    const raw=encodeEvent({uid,itemId:kind==='item'?id:undefined,occurrence,fields,raw:remote?.raw});
    await this.store.transact(d=>{stateOf(d).pending[id]={action:'put',kind,uid,href,etag:map?.etag??null,revision:item.revision,fields,raw};});
  }
  async queueDelete(id,map) {
    await this.store.transact(d=>{stateOf(d).pending[id]={action:'delete',kind:map.kind,href:map.href,etag:map.etag,uid:map.uid};});
  }
  async finishPending(id,p,remote) {
    await this.store.transact(d=>{
      if(p.action==='delete')delete stateOf(d).maps[id];
      else stateOf(d).maps[id]={kind:p.kind,uid:p.uid,href:p.href,etag:remote.etag,revision:p.revision,base:remote.fields,missing:0};
      delete stateOf(d).pending[id];
    });
  }
  async drainPending(window=this.window()) {
    const data=this.store.snapshot(),state=stateOf(data);
    for(const [id,p] of Object.entries(state.pending).filter(([id,p])=>!state.conflicts[id] && this.pendingInWindow(id,p,state,window,data.items[id])).slice(0,20)) {
      if(this.closed)return;
      if(stateOf(this.store.snapshot()).conflicts[id])continue;
      try {
        let remote=this.decode(await this.dav.get(p.href));
        if(p.action==='delete') {
          if(remote && remote.etag!==p.etag){await this.conflict(id,'删除前云端事件已经修改',remote);continue;}
          if(remote)await this.dav.remove(p.href,p.etag);
          await this.finishPending(id,p,null);continue;
        }
        // Recover a successful PUT whose response or local commit was lost.
        if(remote && remote.uid===p.uid && equal(remote.fields,p.fields)) {await this.finishPending(id,p,remote);continue;}
        if((remote?.etag??null)!==p.etag || remote?.unsupported) {await this.conflict(id,'上传前云端版本已经变化',remote);continue;}
        await this.dav.put(p.href,p.raw,p.etag);
        remote=this.decode(await this.dav.get(p.href));
        if(!remote || remote.uid!==p.uid || !equal(remote.fields,p.fields)){await this.conflict(id,'上传后读回内容与预期不同',remote);continue;}
        await this.finishPending(id,p,remote);
      } catch(e) {
        if(e.status!==409)throw e;
        await this.conflict(id,'iCloud 条件写入冲突',null);
      }
    }
  }
  async cycle() {
    const window=this.window();
    await this.drainPending(window);
    if(this.closed)return;
    const remote=(await this.dav.list(this.config.calendarUrl,window)).map(o=>this.decode(o)).filter(r=>r.unsupported || withinWindow(r.fields,window));
    const uids=new Set(),linkedIds=new Set();
    for(const r of remote) {
      if(uids.has(r.uid) || (r.itemId && linkedIds.has(r.itemId)))throw Error('云端事件身份重复');
      uids.add(r.uid);if(r.itemId)linkedIds.add(r.itemId);
    }
    await this.store.transact(d=>{stateOf(d).unsupported=remote.filter(r=>r.unsupported).length;});
    for(const r of remote) {
      if(this.closed)return;
      const d=this.store.snapshot(),s=stateOf(d);
      const entry=Object.entries(s.maps).find(([,m])=>m.href===r.href || m.uid===r.uid);
      if(entry?.[1].kind==='projection' || r.occurrence)continue;
      const id=entry?.[0]??(r.itemId && Object.hasOwn(d.items,r.itemId)?r.itemId:`icloud-${digest(this.config.calendarUrl+r.uid)}`);
      if(s.conflicts[id] || s.pending[id])continue;
      const item=d.items[id],map=entry?.[1];
      if(r.unsupported) {if(map || item)await this.conflict(id,r.unsupported,r);continue;}
      if(!map) {
        if(item) {
          // Adopt old Mac mappings only when both sides agree; never duplicate/resurrect them.
          if(item.deletedAt || item.recurrence || !equal(fieldsFor(item),r.fields))await this.conflict(id,'首次接管时本地和 iCloud 内容不同',r);
          else await this.setMap(id,this.mapFor(id,r,item));
        } else await this.importEvent(id,r);
        continue;
      }
      if(!item) {await this.conflict(id,'本地事项映射缺失',r);continue;}
      if(equal(r.fields,map.base)) {
        if(map.etag!==r.etag || map.href!==r.href || map.missing)await this.setMap(id,{...map,etag:r.etag,href:r.href,missing:0});
      } else if(item.revision!==map.revision || item.deletedAt || item.recurrence)await this.conflict(id,'两端同时修改了同一事项',r);
      else await this.importEvent(id,r,item);
    }
    // Absence must be observed in two complete reports and confirmed by GET 404.
    for(const [id,map] of Object.entries(stateOf(this.store.snapshot()).maps)) {
      if(map.kind!=='item' || !withinWindow(map.base,window) || remote.some(r=>r.uid===map.uid || r.href===map.href))continue;
      const d=this.store.snapshot(),s=stateOf(d),item=d.items[id];
      if(s.pending[id] || s.conflicts[id])continue;
      if(!item || (!item.deletedAt && item.revision!==map.revision)){await this.conflict(id,'云端删除与本地修改冲突');continue;}
      const found=this.decode(await this.dav.get(map.href));
      if(found) {
        if(found.unsupported){await this.conflict(id,found.unsupported,found);continue;}
        if(withinWindow(found.fields,window))throw Error('云端查询暂时遗漏事件');
        if(found.uid!==map.uid || item.deletedAt || item.revision!==map.revision){await this.conflict(id,'移出同步范围与本地修改冲突',found);continue;}
        // Import this known event's boundary move once, then stop tracking it
        // until it enters the rolling window again. It is not a deletion.
        await this.importEvent(id,found,item);continue;
      }
      const missing=(map.missing??0)+1;await this.setMap(id,{...map,missing});
      if(missing<2)continue;
      if(item.deletedAt){await this.store.transact(d=>{delete stateOf(d).maps[id];});continue;}
      try { await this.store.remove({id,baseRevision:item.revision},d=>{delete stateOf(d).maps[id];}); }
      catch(e){if(e.status!==409)throw e;await this.conflict(id,'删除导入时本地已变化');}
    }
    for(const item of Object.values(this.store.snapshot().items)) {
      if(this.closed)return;
      const id=item.id,s=stateOf(this.store.snapshot()),map=s.maps[id];
      if(!withinWindow(item,window) && !withinWindow(map?.base,window))continue;
      if(s.conflicts[id] || s.pending[id] || map?.missing)continue;
      if(item.recurrence){if(map)await this.queueDelete(id,map);continue;}
      if(item.deletedAt) {if(map)await this.queueDelete(id,map);continue;}
      if(!map || item.revision!==map.revision) {
        const r=remote.find(r=>r.href===map?.href);
        await this.queuePut(id,item,map,r);
      }
    }
    await this.syncProjections(remote,window);
    await this.drainPending(window);
  }
  async syncProjections(remote,window) {
    const d=this.store.snapshot(),wanted=new Map();const now=this.clock();
    for(const item of Object.values(d.items)) {
      if(!item.recurrence || item.deletedAt || !item.enabled || item.status!=='open')continue;
      for(const dueAt of occurrencesBetween(item,window.from,window.to-1)) {
        const key=`${item.id}:${item.scheduleVersion}@${dueAt}`,id=`occ-${digest(key)}`;
        const fields=fieldsFor({...item,title:`↻ ${item.title}`,dueAt,status:d.occurrences[key]?.state==='done'?'done':'open'});
        wanted.set(id,{fields,key,revision:digest(JSON.stringify(fields))});
      }
    }
    for(const [id,target] of wanted) {
      const s=stateOf(this.store.snapshot());if(s.pending[id]||s.conflicts[id])continue;
      let map=s.maps[id];const r=remote.find(r=>r.occurrence===target.key || r.href===map?.href);
      if(r?.unsupported){await this.conflict(id,r.unsupported,r);continue;}
      if(r && !map){map={kind:'projection',uid:r.uid,href:r.href,etag:r.etag,revision:equal(r.fields,target.fields)?target.revision:null,base:r.fields};await this.setMap(id,map);}
      if(map && !r){
        if(await this.dav.get(map.href))throw Error('云端查询暂时遗漏习惯投影');
        await this.store.transact(d=>{delete stateOf(d).maps[id];});map=null;
      }
      if(!map || map.revision!==target.revision || !equal(r?.fields,target.fields)) {
        if(map && r)map={...map,etag:r.etag};
        await this.queuePut(id,target,map,r,'projection',target.key);
      }
    }
    for(const [id,map] of Object.entries(stateOf(this.store.snapshot()).maps)) {
      if(map.kind!=='projection' || wanted.has(id) || !withinWindow(map.base,window))continue;
      const s=stateOf(this.store.snapshot());if(s.pending[id]||s.conflicts[id])continue;
      const r=remote.find(r=>r.href===map.href);
      if(!r){if(await this.dav.get(map.href))throw Error('云端查询暂时遗漏过期投影');await this.store.transact(d=>{delete stateOf(d).maps[id];});}
      else if(r.etag===map.etag)await this.queueDelete(id,map);
      else await this.conflict(id,'过期习惯投影被手动修改，未自动删除',r);
    }
  }
  async resolve(id,prefer) {
    if(this.closed)throw problem('同步服务正在停止，请稍后重试',409);
    if(this.inflight)throw problem('正在同步，请稍后重试',409);
    if(!['local','remote'].includes(prefer))throw problem('prefer 必须是 local 或 remote');
    this.inflight=this.resolveConflict(id,prefer);
    try {await this.inflight;}finally{this.inflight=null;}
  }
  async resolveConflict(id,prefer) {
    const d=this.store.snapshot(),s=stateOf(d),c=s.conflicts[id],map=s.maps[id],p=s.pending[id],item=d.items[id];
    if(!c)throw problem('冲突不存在',404);
    if(!item || map?.kind==='projection' || p?.kind==='projection')throw problem('该冲突需要先在 iCloud 恢复事件格式或移除重复项，再联系维护者处理');
    const href=map?.href??p?.href??c.remote?.href;
    const remote=href?this.decode(await this.dav.get(href)):null;
    if(!withinWindow(item,this.window()) && !withinWindow(map?.base,this.window()) && !withinWindow(remote?.fields,this.window()))throw problem('该事项在三个月同步范围外，保留归档，暂不处理云端冲突',409);
    if(remote?.unsupported)throw problem(remote.unsupported);
    if(prefer==='remote') {
      if(item.deletedAt && remote)throw problem('本地已删除；请保留云端副本并以新事件重新导入，不能复活删除记录');
      const commit=(d,next)=>{if(remote)stateOf(d).maps[id]=this.mapFor(id,remote,next);else delete stateOf(d).maps[id];delete stateOf(d).conflicts[id];delete stateOf(d).pending[id];};
      if(remote)await this.store.upsert({id,baseRevision:item.revision,item:{...editable(item),...remote.fields,title:stripStatus(remote.fields.title)}},commit);
      else if(!item.deletedAt)await this.store.remove({id,baseRevision:item.revision},commit);
      else await this.store.transact(d=>commit(d,item));
    } else {
      const currentMap=remote?{...map,kind:'item',href:remote.href,uid:remote.uid,etag:remote.etag}:null;
      if(item.deletedAt && currentMap)await this.queueDelete(id,currentMap);
      else if(!item.deletedAt)await this.queuePut(id,item,currentMap,remote);
      await this.store.transact(d=>{delete stateOf(d).conflicts[id];if(item.deletedAt&&!remote){delete stateOf(d).pending[id];delete stateOf(d).maps[id];}});
      await this.drainPending();
    }
  }
  async close() {this.closed=true;this.dav.close();await Promise.all([this.inflight,this.requested]);}
}
