import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { normalizeItem, editable, problem } from './model.js';
import { remember } from './memory.js';
import {partition,readStorageSync,validateJournal} from './storage-layout.js';
import {dailyTaskInput,habitInput,goalInput,calendarDate,habitItem,habitTime,timeOnDate} from './routines.js';

function validId(value,max=100) {
  return typeof value==='string' && !Object.hasOwn(Object.prototype,value) && value!=='prototype'
    && new RegExp(`^[\\w-]{1,${max}}$`).test(value);
}
function validateRoutineRequest(collection,id,baseRevision,operationId,remove=false) {
  if(!['dailyTasks','habits','goals'].includes(collection) || !validId(id,collection==='habits'?100:72)
    || !validId(operationId,128) || !Number.isInteger(baseRevision) || baseRevision<(remove?1:0))throw problem('Invalid routine request');
}
function writeItem(data,id,normalized,now,defaultTime) {
  const old=data.items[id],at=new Date(now).toISOString();
  const next={...normalized,id,revision:(old?.revision??0)+1,createdAt:old?.createdAt??at,updatedAt:at,deletedAt:null};
  for(const field of ['dailyTaskId','dailyDate','goalId','goalDate'])if(old?.[field]!==undefined)next[field]=old[field];
  if(next.kind==='habit')next.defaultTime=defaultTime ?? (old?.kind==='habit' && old.dueAt===next.dueAt && old.timeZone===next.timeZone
    ? habitTime(old) : habitTime(next));
  const scheduleChanged=old && (['dueAt','timeZone','recurrence'].some(key=>JSON.stringify(old[key])!==JSON.stringify(next[key]))
    || (old.kind==='habit' && next.kind==='habit' && habitTime(old)!==next.defaultTime)
    || (!old.enabled && next.enabled) || (old.status!=='open' && next.status==='open'));
  next.scheduleVersion=(old?.scheduleVersion??1)+(scheduleChanged?1:0);
  data.items[id]=next;
  remember(data,{type:old?'item-updated':'item-created',itemId:id,title:next.title,dueAt:next.dueAt,
    ...(old?{previousDueAt:old.dueAt}:{}),timeZone:next.timeZone,revision:next.revision},now);
  for(const occurrence of Object.values(data.occurrences)) {
    if(occurrence.itemId===id && ['active','acknowledged'].includes(occurrence.state)
      && (scheduleChanged || !next.enabled || next.status!=='open'))occurrence.state='cancelled';
  }
  return next;
}

export async function atomicJSON(file, data) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(data, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await fs.rename(tmp, file);
    const dir = await fs.open(path.dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
}

async function applyParts(directory,parts,previous={}) {
  await fs.mkdir(path.join(directory,'calendar'),{recursive:true,mode:0o700});
  // The index is replaced last. .transaction.json remains authoritative until
  // every destination is durable, so a crash is replayable without a partial month move.
  for(const name of [...Object.keys(parts).filter(n=>n!=='calendar.json'),'calendar.json']) {
    if(JSON.stringify(parts[name])!==JSON.stringify(previous[name]))await atomicJSON(path.join(directory,name),parts[name]);
  }
  await fs.unlink(path.join(directory,'.transaction.json'));
  const dir=await fs.open(directory,'r');try{await dir.sync();}finally{await dir.close();}
}
async function publishParts(directory,parts,previous={}) {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  await atomicJSON(path.join(directory,'.transaction.json'),{schemaVersion:1,parts});
  await applyParts(directory,parts,previous);
}

export class CalendarStore {
  constructor(directory, { clock = Date.now, timeZone='Asia/Shanghai' } = {}) {
    this.directory = directory; this.file = path.join(directory, 'calendar.json');
    this.lock = path.join(directory, 'writer.lock'); this.clock = clock; this.tail = Promise.resolve();
    this.timeZone=timeZone;
  }
  async open() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.lockId = randomUUID();
    for (let n = 0; n < 2; n++) {
      try {
        const h = await fs.open(this.lock, 'wx', 0o600);
        await h.writeFile(JSON.stringify({ pid: process.pid, id: this.lockId })); await h.close(); break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const owner = JSON.parse(await fs.readFile(this.lock, 'utf8'));
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (err) { if (err.code === 'ESRCH') alive = false; }
        if (alive || n === 1) throw new Error('Calendar data directory already has a writer');
        await fs.unlink(this.lock);
      }
    }
    try {
      this.poisoned=false;
      try {
        const journal=JSON.parse(await fs.readFile(path.join(this.directory,'.transaction.json'),'utf8'));
        await applyParts(this.directory,validateJournal(journal));
      }catch(e){if(e.code!=='ENOENT')throw e;}
      try {const loaded=readStorageSync(this.directory);this.data=loaded.data;this.parts=loaded.parts;}
      catch (e) {
        const indexExists=await fs.access(this.file).then(()=>true,err=>{if(err.code==='ENOENT')return false;throw err;});
        if (e.code !== 'ENOENT' || indexExists) throw new Error('calendar.json is unreadable; refusing to overwrite it', { cause: e });
        const layoutFiles=await Promise.all(['state.json','history.json','daily-tasks.json','habits.json','goals.json'].map(name=>fs.access(path.join(this.directory,name)).then(()=>true,err=>{if(err.code==='ENOENT')return false;throw err;})));
        const months=await fs.readdir(path.join(this.directory,'calendar')).catch(err=>{if(err.code==='ENOENT')return [];throw err;});
        if(layoutFiles.some(Boolean)||months.length)throw Error('calendar.json index is missing; refusing to overwrite existing partitions');
        this.data = { schemaVersion: 1, revision: 0, items: {}, occurrences: {}, dailyTasks:{}, goals:{}, receipts: {}, seenMessages: [], lastDeliveryAt: null, syncClients: {} };
        this.parts=null;
      }
      if (this.data.schemaVersion !== 1 || !this.data.items || !this.data.occurrences || !Number.isInteger(this.data.revision)) throw new Error('Unsupported calendar data schema');
      for (const item of Object.values(this.data.items)) normalizeItem(editable(item));
      this.data.dailyTasks??={};
      for(const item of Object.values(this.data.dailyTasks))dailyTaskInput.parse(Object.fromEntries(['title','notes','timeZone','enabled','defaultStartTime','defaultDurationMinutes'].map(key=>[key,item[key]])));
      this.data.goals??={};
      for(const [id,item] of Object.entries(this.data.goals)) {
        goalInput.parse(Object.fromEntries(['title','notes','timeZone','enabled','status','deadlineDate','dailyTitle','defaultStartTime','defaultDurationMinutes'].map(key=>[key,item[key]])));
        calendarDate.parse(item.startDate);
        if(!validId(id,72) || item.id!==id || item.deadlineDate<item.startDate
          || Object.hasOwn(this.data.items,id) || Object.hasOwn(this.data.dailyTasks,id))throw Error('Invalid stored goal');
      }
      if(!this.parts) {
        // Preserve the original mixed v1 file once, outside the active layout.
        await fs.mkdir(path.join(this.directory,'legacy'),{recursive:true,mode:0o700});
        for(const suffix of ['','.backup'])try {
          await fs.copyFile(this.file+suffix,path.join(this.directory,'legacy',`calendar-v1${suffix}.json`),fs.constants.COPYFILE_EXCL);
        }catch(e){if(!['ENOENT','EEXIST'].includes(e.code))throw e;}
        this.parts=partition(this.data,this.timeZone);
        await publishParts(this.directory,this.parts);
        await fs.unlink(this.file+'.backup').catch(e=>{if(e.code!=='ENOENT')throw e;});
      } else if(this.parts['calendar.json'].layoutVersion!==3) {
        // Retain an immutable pre-migration snapshot as well as the rolling
        // backup; later routine edits must not erase the original layout.
        const legacy=path.join(this.directory,'legacy',`layout-${this.parts['calendar.json'].layoutVersion??'monthly'}`);
        const preserved=await fs.access(path.join(legacy,'calendar.json')).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
        if(!preserved)await publishParts(legacy,this.parts);
        await publishParts(path.join(this.directory,'backup'),this.parts);
        this.backupParts=this.parts;
        const parts=partition(this.data,this.timeZone,this.parts['calendar.json'].months);
        await publishParts(this.directory,parts,this.parts);
        this.parts=parts;
      }
      return this;
    } catch (e) { await this.close(); throw e; }
  }
  snapshot() {if(this.poisoned)throw Error('Calendar commit interrupted; restart to recover');return structuredClone(this.data);}
  async transact(fn) {
    const run = this.tail.then(async () => {
      if(this.poisoned)throw Error('Calendar commit interrupted; restart to recover the durable transaction');
      const next = structuredClone(this.data);
      const result = await fn(next);
      if (JSON.stringify(next) !== JSON.stringify(this.data)) {
        next.revision++;
        const parts=partition(next,this.timeZone,this.parts['calendar.json'].months);
        try {
          await publishParts(path.join(this.directory,'backup'),this.parts,this.backupParts??{});
          this.backupParts=this.parts;
          await publishParts(this.directory,parts,this.parts);
        }catch(e){this.poisoned=true;throw e;}
        this.parts=parts;
        this.data = next;
      }
      return structuredClone(result);
    });
    this.tail = run.catch(() => {});
    return run;
  }
  async close() {
    await this.tail;
    try {
      const owner = JSON.parse(await fs.readFile(this.lock, 'utf8'));
      if (owner.id === this.lockId) await fs.unlink(this.lock);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  async upsert({ id = randomUUID(), baseRevision = 0, item, operationId = randomUUID() }, onCommit = () => {}) {
    const normalized = normalizeItem(item);
    if (typeof id !== 'string' || typeof operationId !== 'string' || Object.hasOwn(Object.prototype, id) || id === 'prototype' || Object.hasOwn(Object.prototype, operationId) || operationId === 'prototype' || !/^[\w-]{1,100}$/.test(id) || !/^[\w-]{1,128}$/.test(operationId) || !Number.isInteger(baseRevision) || baseRevision < 0) throw problem('Invalid id');
    return this.transact(d => {
      const fingerprint = JSON.stringify({ id, baseRevision, item: normalized });
      if (d.receipts[operationId]) {
        if (d.receipts[operationId].fingerprint !== fingerprint) throw problem('operationId was reused for a different change', 409);
        return d.receipts[operationId].result;
      }
      const old = d.items[id];
      if(Object.hasOwn(d.dailyTasks??{},id) || Object.hasOwn(d.goals??{},id))throw problem('ID already belongs to a routine template',409);
      if ((old?.revision ?? 0) !== baseRevision) throw problem('Revision conflict: reload item before editing', 409);
      if (old?.deletedAt) throw problem('Deleted items cannot be resurrected; create a new item', 409);
      const next = writeItem(d,id,normalized,this.clock());
      d.receipts[operationId] = { fingerprint, result: structuredClone(next) };
      onCommit(d, next);
      return next;
    });
  }
  async remove({ id, baseRevision, operationId = randomUUID() }, onCommit = () => {}) {
    if (typeof id !== 'string' || typeof operationId !== 'string' || Object.hasOwn(Object.prototype, id) || id === 'prototype' || Object.hasOwn(Object.prototype, operationId) || operationId === 'prototype' || !/^[\w-]{1,100}$/.test(id) || !/^[\w-]{1,128}$/.test(operationId) || !Number.isInteger(baseRevision) || baseRevision < 1) throw problem('Invalid delete request');
    return this.transact(d => {
      const fingerprint = JSON.stringify({ delete: id, baseRevision });
      if (d.receipts[operationId]) {
        if (d.receipts[operationId].fingerprint !== fingerprint) throw problem('operationId reused', 409);
        return d.receipts[operationId].result;
      }
      const item = d.items[id];
      if (!item) throw problem('Item not found', 404);
      if (item.revision !== baseRevision) throw problem('Revision conflict: reload before deleting', 409);
      item.deletedAt = new Date(this.clock()).toISOString(); item.updatedAt = item.deletedAt; item.revision++;
      remember(d, { type: 'item-deleted', itemId: id, title: item.title }, this.clock());
      for (const o of Object.values(d.occurrences)) if (o.itemId === id && ['active', 'acknowledged'].includes(o.state)) o.state = 'cancelled';
      d.receipts[operationId] = { fingerprint, result: structuredClone(item) };
      onCommit(d, item);
      return item;
    });
  }
  async saveRoutine({collection,id,baseRevision=0,operationId=randomUUID(),item}) {
    id??=`routine_${createHash('sha256').update(String(operationId)).digest('hex').slice(0,32)}`;
    validateRoutineRequest(collection,id,baseRevision,operationId);
    const parsed=({dailyTasks:dailyTaskInput,habits:habitInput,goals:goalInput}[collection]).parse(item);
    return this.transact(d=>{
      const fingerprint=JSON.stringify({collection,id,baseRevision,item:parsed});
      if(d.receipts[operationId]) {
        if(d.receipts[operationId].fingerprint!==fingerprint)throw problem('operationId was reused for a different change',409);
        return d.receipts[operationId].result;
      }
      const dailyTasks=d.dailyTasks??={},goals=d.goals??={};
      const templates=collection==='goals'?goals:dailyTasks,old=collection==='habits'?d.items[id]:templates[id];
      if((collection==='dailyTasks' && (Object.hasOwn(d.items,id) || Object.hasOwn(goals,id)))
        || (collection==='goals' && (Object.hasOwn(d.items,id) || Object.hasOwn(dailyTasks,id)))
        || (collection==='habits' && (Object.hasOwn(dailyTasks,id) || Object.hasOwn(goals,id) || (old && old.kind!=='habit'))))throw problem('ID belongs to a different collection',409);
      if((old?.revision??0)!==baseRevision)throw problem('Revision conflict: reload routine before editing',409);
      if(old?.deletedAt)throw problem('Deleted routines cannot be resurrected; create a new routine',409);
      const now=this.clock(),at=new Date(now).toISOString();
      let next;
      if(collection==='habits')next=writeItem(d,id,habitItem(parsed,now,old),now,parsed.defaultTime);
      else {
        next={...parsed,id,revision:(old?.revision??0)+1,createdAt:old?.createdAt??at,updatedAt:at,deletedAt:null};
        if(collection==='goals') {
          next.startDate=old?.startDate??DateTime.fromMillis(now,{zone:next.timeZone}).toISODate();
          if(next.deadlineDate<next.startDate)throw problem('Goal deadline must be on or after its start date');
        }
        templates[id]=next;
        remember(d,{type:collection==='goals'?(old?'goal-updated':'goal-created'):(old?'daily-task-updated':'daily-task-created'),itemId:id,title:next.title,
          defaultStartTime:next.defaultStartTime,defaultDurationMinutes:next.defaultDurationMinutes,timeZone:next.timeZone,revision:next.revision,
          ...(collection==='goals'?{deadlineDate:next.deadlineDate,dailyTitle:next.dailyTitle,status:next.status}:{})},now);
      }
      d.receipts[operationId]={fingerprint,result:structuredClone(next)};
      return next;
    });
  }
  async removeRoutine({collection,id,baseRevision,operationId=randomUUID()}) {
    validateRoutineRequest(collection,id,baseRevision,operationId,true);
    return this.transact(d=>{
      const fingerprint=JSON.stringify({deleteRoutine:collection,id,baseRevision});
      if(d.receipts[operationId]) {
        if(d.receipts[operationId].fingerprint!==fingerprint)throw problem('operationId reused',409);
        return d.receipts[operationId].result;
      }
      const item=collection==='dailyTasks'?d.dailyTasks?.[id]:collection==='goals'?d.goals?.[id]:d.items[id];
      if(!item || (collection==='habits' && item.kind!=='habit'))throw problem('Routine not found',404);
      if(item.revision!==baseRevision)throw problem('Revision conflict: reload before deleting routine',409);
      if(item.deletedAt)throw problem('Routine is already deleted',409);
      const now=this.clock();item.deletedAt=new Date(now).toISOString();item.updatedAt=item.deletedAt;item.revision++;
      for(const occurrence of Object.values(d.occurrences)) {
        if(occurrence.itemId===id && ['active','acknowledged'].includes(occurrence.state))occurrence.state='cancelled';
      }
      remember(d,{type:collection==='dailyTasks'?'daily-task-deleted':collection==='goals'?'goal-deleted':'item-deleted',itemId:id,title:item.title},now);
      d.receipts[operationId]={fingerprint,result:structuredClone(item)};
      return item;
    });
  }
  async generateDailies() {
    return this.transact(d=>{
      const created=[],now=this.clock();
      const templates=[...Object.values(d.dailyTasks??{}).map(template=>({template,goal:false})),...Object.values(d.goals??{}).map(template=>({template,goal:true}))];
      for(const {template,goal} of templates) {
        if(template.deletedAt || !template.enabled || (goal && template.status!=='open'))continue;
        const local=DateTime.fromMillis(now,{zone:template.timeZone});
        if(local.hour<8)continue;
        const date=local.toISODate();
        if(goal && (date<template.startDate || date>template.deadlineDate))continue;
        const marker=`${template.id}:${date}`,id=`${goal?'goal':'daily'}_${template.id}_${date.replaceAll('-','')}`;
        const generations=goal?'goalGenerations':'dailyGenerations',sourceId=goal?'goalId':'dailyTaskId',sourceDate=goal?'goalDate':'dailyDate';
        if(d[generations]?.[marker])continue;
        const existing=d.items[id];
        if(existing) {
          if(existing[sourceId]!==template.id || existing[sourceDate]!==date)throw problem('Generated routine task ID belongs to another item',409);
          continue;
        }
        if(Object.hasOwn(d.dailyTasks??{},id) || Object.hasOwn(d.goals??{},id))throw problem('Generated routine task ID belongs to a template',409);
        const normalized=normalizeItem({title:goal?template.dailyTitle:template.title,notes:template.notes,kind:'todo',
          dueAt:timeOnDate(date,template.defaultStartTime,template.timeZone),durationMinutes:template.defaultDurationMinutes,
          timeZone:template.timeZone,enabled:true,status:'open',recurrence:null});
        const saved=writeItem(d,id,normalized,now);
        saved[sourceId]=template.id;saved[sourceDate]=date;
        d[generations]??={};d[generations][marker]=id;
        created.push(saved);
      }
      return created;
    });
  }
}
