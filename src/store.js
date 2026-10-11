import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeItem, editable, problem } from './model.js';
import { remember } from './memory.js';
import {partition,readStorageSync,validateJournal} from './storage-layout.js';

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
        const layoutFiles=await Promise.all(['state.json','history.json'].map(name=>fs.access(path.join(this.directory,name)).then(()=>true,err=>{if(err.code==='ENOENT')return false;throw err;})));
        const months=await fs.readdir(path.join(this.directory,'calendar')).catch(err=>{if(err.code==='ENOENT')return [];throw err;});
        if(layoutFiles.some(Boolean)||months.length)throw Error('calendar.json index is missing; refusing to overwrite existing partitions');
        this.data = { schemaVersion: 1, revision: 0, items: {}, occurrences: {}, receipts: {}, seenMessages: [], lastDeliveryAt: null, syncClients: {} };
        this.parts=null;
      }
      if (this.data.schemaVersion !== 1 || !this.data.items || !this.data.occurrences || !Number.isInteger(this.data.revision)) throw new Error('Unsupported calendar data schema');
      for (const item of Object.values(this.data.items)) normalizeItem(editable(item));
      if(!this.parts) {
        // Preserve the original mixed v1 file once, outside the active layout.
        await fs.mkdir(path.join(this.directory,'legacy'),{recursive:true,mode:0o700});
        for(const suffix of ['','.backup'])try {
          await fs.copyFile(this.file+suffix,path.join(this.directory,'legacy',`calendar-v1${suffix}.json`),fs.constants.COPYFILE_EXCL);
        }catch(e){if(!['ENOENT','EEXIST'].includes(e.code))throw e;}
        this.parts=partition(this.data,this.timeZone);
        await publishParts(this.directory,this.parts);
        await fs.unlink(this.file+'.backup').catch(e=>{if(e.code!=='ENOENT')throw e;});
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
      if ((old?.revision ?? 0) !== baseRevision) throw problem('Revision conflict: reload item before editing', 409);
      if (old?.deletedAt) throw problem('Deleted items cannot be resurrected; create a new item', 409);
      const now = new Date(this.clock()).toISOString();
      const next = { ...normalized, id, revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? now, updatedAt: now, deletedAt: null };
      const scheduleChanged = old && (['dueAt', 'timeZone', 'recurrence'].some(k => JSON.stringify(old[k]) !== JSON.stringify(next[k])) || (!old.enabled && next.enabled) || (old.status !== 'open' && next.status === 'open'));
      next.scheduleVersion = (old?.scheduleVersion ?? 1) + (scheduleChanged ? 1 : 0);
      d.items[id] = next;
      remember(d, { type: old ? 'item-updated' : 'item-created', itemId: id, title: next.title,
        dueAt: next.dueAt, previousDueAt: old?.dueAt, timeZone: next.timeZone, revision: next.revision }, this.clock());
      for (const occurrence of Object.values(d.occurrences)) {
        if (occurrence.itemId === id && ['active', 'acknowledged'].includes(occurrence.state) && (scheduleChanged || !next.enabled || next.status !== 'open')) occurrence.state = 'cancelled';
      }
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
}
