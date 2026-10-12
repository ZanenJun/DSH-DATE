import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJSON} from './store.js';

const ranks={unknown:0,normal:0,low:1,critical:2,exhausted:3};
const queryError='余额查询失败；保留上次结果，稍后重试。';
const deliveryError='余额通知发送失败，稍后重试。';
const iso=value=>value==null?null:new Date(value).toISOString();
const decimal=value=>typeof value==='string' && value.length<=128 && /^-?\d+(?:\.\d{1,18})?$/.test(value);
function compare(a,b) {
  const parse=value=>{const negative=value.startsWith('-'),[whole,fraction='']=value.replace(/^-/,'').split('.');return {number:BigInt(whole+fraction)*(negative?-1n:1n),scale:fraction.length};};
  const x=parse(a),y=parse(b),scale=Math.max(x.scale,y.scale);
  const first=x.number*10n**BigInt(scale-x.scale),second=y.number*10n**BigInt(scale-y.scale);
  return first<second?-1:first>second?1:0;
}
function validateBinding(binding) {
  if(binding!==undefined && (typeof binding!=='string' || !/^[\w:-]{1,200}$/.test(binding)))throw Error('Invalid balance account binding');
  return binding;
}
function normalizeBalance(raw) {
  if(!raw || typeof raw.is_available!=='boolean' || !Array.isArray(raw.balance_infos) || raw.balance_infos.length>32)throw Error('Invalid balance response');
  const seen=new Set();
  const balance_infos=raw.balance_infos.map(row=>{
    if(!row || typeof row.currency!=='string' || !/^[A-Z]{3}$/.test(row.currency) || seen.has(row.currency))throw Error('Invalid balance currency');
    seen.add(row.currency);
    const fields=['total_balance','granted_balance','topped_up_balance'];
    if(fields.some(key=>!decimal(row[key])))throw Error('Invalid balance amount');
    return {currency:row.currency,...Object.fromEntries(fields.map(key=>[key,row[key]]))};
  }).sort((a,b)=>a.currency.localeCompare(b.currency));
  return {is_available:raw.is_available,balance_infos};
}
function blank(binding=null) {
  return {schemaVersion:1,binding,balance:null,level:'unknown',lastSuccessAt:null,lastAttemptAt:null,
    lastError:null,queryFailures:0,queryRetryAt:null,insufficient:null,lastNotification:null,pending:null,notificationError:null};
}
function validState(raw) {
  if(raw?.schemaVersion!==1 || !Object.hasOwn(ranks,raw.level) || (raw.binding!==null && validateBinding(raw.binding)===undefined))throw Error('Invalid balance state');
  if(raw.balance!==null)normalizeBalance(raw.balance);
  for(const key of ['lastSuccessAt','lastAttemptAt','queryRetryAt'])if(raw[key]!==null && (!Number.isFinite(raw[key]) || raw[key]<0))throw Error('Invalid balance state');
  if(!Number.isInteger(raw.queryFailures) || raw.queryFailures<0)throw Error('Invalid balance state');
  if(raw.lastError!==null && raw.lastError!==queryError)throw Error('Invalid balance state');
  if(raw.notificationError!==null && raw.notificationError!==deliveryError)throw Error('Invalid balance state');
  if(raw.lastNotification && (!Object.hasOwn(ranks,raw.lastNotification.level) || !Number.isFinite(raw.lastNotification.at)))throw Error('Invalid balance notification');
  if(raw.pending && (typeof raw.pending.id!=='string' || !Object.hasOwn(ranks,raw.pending.level)
    || !['pending','sending','uncertain'].includes(raw.pending.state) || typeof raw.pending.text!=='string'
    || raw.pending.text.length>10000 || !Number.isFinite(raw.pending.retryAt)
    || !Number.isInteger(raw.pending.attempts) || raw.pending.attempts<0))throw Error('Invalid pending balance notification');
  if(raw.insufficient) {
    if(!Number.isFinite(raw.insufficient.at) || typeof raw.insufficient.canClear!=='boolean')throw Error('Invalid insufficient balance evidence');
    if(raw.insufficient.baseline!==null)normalizeBalance(raw.insufficient.baseline);
  }
  return raw;
}

// Amounts remain decimal strings. There is deliberately no currency conversion.
export class BalanceMonitor {
  constructor(directory,config={}, {fetchBalance,send,clock=Date.now,log=()=>{}}={}) {
    this.directory=directory;this.file=path.join(directory,'balance.json');
    this.config={intervalMs:3600000,activeIntervalMs:600000,cooldownMs:86400000,requestTimeoutMs:20000,
      thresholds:{CNY:{low:'5.00',critical:'1.00'}},...config};
    for(const field of ['intervalMs','activeIntervalMs','cooldownMs','requestTimeoutMs'])if(!Number.isFinite(this.config[field]) || this.config[field]<1)throw Error('Invalid balance timing configuration');
    for(const [currency,threshold] of Object.entries(this.config.thresholds)) {
      if(!/^[A-Z]{3}$/.test(currency) || !decimal(threshold?.low) || !decimal(threshold?.critical)
        || compare(threshold.critical,'0')<0 || compare(threshold.low,threshold.critical)<0)throw Error('Invalid balance threshold');
    }
    if(typeof fetchBalance!=='function' || typeof send!=='function')throw Error('Balance monitor requires a fetcher and sender');
    this.fetchBalance=fetchBalance;this.send=send;this.clock=clock;this.log=log;
    this.data=blank();this.tail=Promise.resolve();this.queryPromise=null;this.notifyPromise=null;
    this.bindingGeneration=0;this.evidenceGeneration=0;this.controllers=new Set();this.closed=false;this.opened=false;this.poisoned=false;
  }
  async open() {
    await fs.mkdir(this.directory,{recursive:true,mode:0o700});
    try {this.data=validState(JSON.parse(await fs.readFile(this.file,'utf8')));await fs.chmod(this.file,0o600);}
    catch(error) {
      if(error.code!=='ENOENT')throw Error('余额状态文件不可读取，拒绝覆盖。');
      await atomicJSON(this.file,this.data);
    }
    if(this.data.pending?.state==='sending') {
      // QQ has no idempotency key. A crash after sending but before confirmation
      // leaves delivery uncertain: retain the durable cooldown, do not resend on restart.
      this.data.pending.state='uncertain';await atomicJSON(this.file,this.data);
    }
    this.opened=true;return this;
  }
  async update(fn) {
    const work=this.tail.then(async()=>{
      if(this.poisoned)throw Error('余额状态保存中断，需要重启恢复。');
      const next=structuredClone(this.data),result=fn(next);
      if(JSON.stringify(next)!==JSON.stringify(this.data)) {
        try {await atomicJSON(this.file,next);}catch{this.poisoned=true;throw Error('余额状态保存失败。');}
        this.data=next;
      }
      return result;
    });
    this.tail=work.catch(()=>{});return work;
  }
  switchBinding(data,binding) {
    if(binding===undefined || data.binding===binding)return false;
    Object.assign(data,blank(binding));this.bindingGeneration++;this.evidenceGeneration++;
    this.sendController?.abort();return true;
  }
  async bindAccount(binding) {
    if(this.closed)return;
    validateBinding(binding);
    await this.update(data=>this.switchBinding(data,binding));
  }
  levelFor(balance) {
    if(!balance.is_available)return 'exhausted';
    let level='unknown';
    for(const row of balance.balance_infos) {
      const threshold=this.config.thresholds[row.currency];if(!threshold)continue;
      const candidate=compare(row.total_balance,threshold.critical)<=0?'critical':compare(row.total_balance,threshold.low)<=0?'low':'normal';
      if(level==='unknown' || ranks[candidate]>ranks[level])level=candidate;
    }
    return level;
  }
  details(balance) {
    return balance?.balance_infos.length?balance.balance_infos.map(row=>`${row.currency}：${row.total_balance}（赠送 ${row.granted_balance}，充值 ${row.topped_up_balance}）`).join('\n'):'余额明细暂不可用。';
  }
  notificationText(level,balance,{confirmed=false,recovered=false}={}) {
    const title=confirmed?'DeepSeek API 已返回 402：当前请求因余额不足失败。'
      :recovered?(level==='normal'?'DeepSeek 余额已恢复正常。':'DeepSeek 余额已恢复可用；当前币种尚未设置提醒阈值。')
      :level==='exhausted'?'DeepSeek 余额不可用，请充值后重试。'
      :level==='critical'?'DeepSeek 余额严重偏低，请及时充值。':'DeepSeek 余额偏低，请留意充值。';
    return `${title}\n${confirmed && balance?'上次查询余额（不代表当前余额）：\n':''}${this.details(balance)}`;
  }
  plan(data,previous,{confirmed=false}={}) {
    const now=this.clock(),level=data.level,alert=ranks[level]>0;
    if(data.pending && data.pending.level!==level){data.pending=null;this.sendController?.abort();}
    const escalation=alert && ranks[level]>ranks[previous];
    const recovered=!alert && ranks[previous]>0;
    const elapsed=data.lastNotification==null || now-data.lastNotification.at>=this.config.cooldownMs;
    if(data.pending) {
      if(data.pending.state!=='sending')data.pending.text=this.notificationText(level,data.balance,{confirmed:confirmed||!!data.insufficient,recovered:!alert});
      return;
    }
    if(!(recovered || escalation || (alert && elapsed)))return;
    data.pending={id:randomUUID(),level,text:this.notificationText(level,data.balance,{confirmed,recovered}),
      state:'pending',attempts:0,retryAt:now,createdAt:now};
    data.notificationError=null;
  }
  async bounded(callback,controller) {
    let timeout,abort;
    const cancelled=new Promise((_,reject)=>{
      abort=()=>reject(Error('Balance operation cancelled'));
      controller.signal.addEventListener('abort',abort,{once:true});
      if(controller.signal.aborted)abort();
      timeout=setTimeout(()=>controller.abort(),this.config.requestTimeoutMs);
    });
    this.controllers.add(controller);
    try {return await Promise.race([Promise.resolve().then(()=>callback(controller.signal)),cancelled]);}
    finally {clearTimeout(timeout);controller.signal.removeEventListener('abort',abort);this.controllers.delete(controller);}
  }
  drainNotifications() {
    if(this.closed)return Promise.resolve();
    if(this.notifyPromise)return this.notifyPromise;
    this.notifyPromise=(async()=>{
      while(!this.closed) {
        const candidate=await this.update(data=>{
          const pending=data.pending;if(!pending || pending.waitForRefresh || this.clock()<pending.retryAt)return null;
          pending.state='sending';pending.attempts++;pending.retryAt=this.clock()+this.config.cooldownMs;
          return {...structuredClone(pending),binding:data.binding};
        });
        if(!candidate || this.closed)return;
        const controller=new AbortController();this.sendController=controller;
        try {
          await this.bounded(signal=>this.send(candidate.text,{signal,binding:candidate.binding}),controller);
          await this.update(data=>{
            if(data.pending?.id!==candidate.id)return;
            data.lastNotification={level:candidate.level,at:this.clock()};data.pending=null;data.notificationError=null;
          });
        }catch {
          if(this.closed)return;
          await this.update(data=>{
            if(data.pending?.id!==candidate.id)return;
            data.pending.state='pending';data.pending.retryAt=this.clock()+Math.min(3600000,60000*2**Math.min(candidate.attempts-1,6));
            data.notificationError=deliveryError;
          });
          this.log(deliveryError);
        }finally{if(this.sendController===controller)this.sendController=null;}
      }
    })().finally(()=>{this.notifyPromise=null;});
    return this.notifyPromise;
  }
  recoveredFrom402(evidence,balance,freshEvidence) {
    if(!balance.is_available)return false;
    if(evidence.canClear)return true;
    if(!freshEvidence || !evidence.baseline)return false;
    if(!evidence.baseline.is_available)return true;
    return balance.balance_infos.some(row=>{
      const previous=evidence.baseline.balance_infos.find(old=>old.currency===row.currency);
      return previous && compare(row.total_balance,previous.total_balance)>0;
    });
  }
  async refresh({reason='manual',binding,notify=true}={}) {
    if(this.closed)return this.status();
    if(!this.opened)throw Error('Balance monitor is not open');
    validateBinding(binding);
    if(binding!==undefined)await this.update(data=>this.switchBinding(data,binding));
    if(this.queryPromise) {
      const needsFollowUp=this.queryGeneration!==this.bindingGeneration;
      await this.queryPromise;
      return needsFollowUp && !this.closed?this.refresh({reason,binding,notify}):this.status();
    }
    if(reason!=='manual' && this.data.queryRetryAt!=null && this.clock()<this.data.queryRetryAt) {
      if(notify)await this.drainNotifications();return this.status();
    }
    this.queryGeneration=this.bindingGeneration;
    this.queryPromise=(async()=>{
      const generation=this.bindingGeneration,evidence=this.evidenceGeneration;
      await this.update(data=>{data.lastAttemptAt=this.clock();});
      if(this.closed)return this.status();
      const controller=new AbortController();
      try {
        const raw=await this.bounded(signal=>this.fetchBalance({signal}),controller);
        const balance=normalizeBalance(raw),nextBinding=validateBinding(raw.binding);
        if(this.closed || generation!==this.bindingGeneration)return this.status();
        await this.update(data=>{
          if(generation!==this.bindingGeneration)return;
          if(data.binding!==null && nextBinding===undefined)throw Error('Balance account binding missing');
          this.switchBinding(data,nextBinding);
          const previous=data.level,at=this.clock(),previousPending=data.pending?.id;
          data.balance=balance;data.lastSuccessAt=at;data.lastAttemptAt??=at;
          data.lastError=null;data.queryFailures=0;data.queryRetryAt=null;
          if(data.insufficient) {
            if(this.recoveredFrom402(data.insufficient,balance,evidence===this.evidenceGeneration))data.insufficient=null;
            else if(!data.insufficient.baseline || !balance.is_available)data.insufficient.baseline=balance;
          }
          data.level=data.insufficient?'exhausted':this.levelFor(balance);
          this.plan(data,previous);
          if(data.pending && notify)delete data.pending.waitForRefresh;
          else if(data.pending && data.pending.id!==previousPending)data.pending.waitForRefresh=true;
        });
      }catch {
        if(this.closed || generation!==this.bindingGeneration || this.poisoned)return this.status();
        await this.update(data=>{
          data.lastError=queryError;data.queryFailures++;
          data.queryRetryAt=this.clock()+Math.min(this.config.intervalMs,60000*2**Math.min(data.queryFailures-1,6));
        });
        this.log(queryError);
      }
      if(notify)await this.drainNotifications();return this.status();
    })().finally(()=>{this.queryPromise=null;});
    await this.queryPromise;return this.status();
  }
  async tick() {
    if(this.closed)return this.status();
    await this.drainNotifications();
    if(this.data.lastSuccessAt===null || this.clock()-this.data.lastSuccessAt>=this.config.intervalMs)return this.refresh({reason:'hourly'});
    return this.status();
  }
  async afterTurn({successful=true,binding}={}) {
    if(this.closed)return this.status();validateBinding(binding);
    let recovered=false;
    await this.update(data=>{
      this.switchBinding(data,binding);
      if(successful && data.insufficient) {
        data.insufficient.canClear=true;recovered=true;
        if(data.pending?.level==='exhausted')data.pending.waitForRefresh=true;
      }
    });
    if(recovered || this.data.lastSuccessAt===null || this.clock()-this.data.lastSuccessAt>=this.config.activeIntervalMs)return this.refresh({reason:'active',binding});
    await this.drainNotifications();
    return this.status();
  }
  async insufficient({binding}={}) {
    if(this.closed)return this.status();validateBinding(binding);
    let newlyInsufficient=false;
    await this.update(data=>{
      this.switchBinding(data,binding);
      const previous=data.level;
      if(!data.insufficient) {data.insufficient={at:this.clock(),baseline:structuredClone(data.balance),canClear:false};newlyInsufficient=true;}
      else data.insufficient.canClear=false;
      this.evidenceGeneration++;
      data.level='exhausted';this.plan(data,previous,{confirmed:true});
      if(data.pending)delete data.pending.waitForRefresh;
    });
    // The fixed 402 notice does not wait for the balance API or the Agent.
    await this.drainNotifications();
    if(newlyInsufficient || this.data.lastSuccessAt===null || this.clock()-this.data.lastSuccessAt>=this.config.activeIntervalMs)
      void this.refresh({reason:'insufficient',binding}).catch(()=>this.log(queryError));
    return this.status();
  }
  status() {
    const data=this.data,pending=data.pending;
    const scheduled=data.lastSuccessAt==null?this.clock():data.lastSuccessAt+this.config.intervalMs;
    return {level:data.level,balance:structuredClone(data.balance),lastSuccessAt:iso(data.lastSuccessAt),
      lastAttemptAt:iso(data.lastAttemptAt),lastError:data.lastError,nextCheckAt:iso(Math.max(scheduled,data.queryRetryAt??0)),
      running:!!this.queryPromise,confirmedInsufficient:!!data.insufficient,
      notification:{pending:!!pending,state:pending?.state??'idle',level:pending?.level??null,retryAt:iso(pending?.retryAt),
        lastSentAt:iso(data.lastNotification?.at),lastSentLevel:data.lastNotification?.level??null,lastError:data.notificationError}};
  }
  async close() {
    this.closed=true;for(const controller of this.controllers)controller.abort();
    await Promise.allSettled([this.queryPromise,this.notifyPromise]);await this.tail;
  }
}
