import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeItem, editable, problem } from './model.js';

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

export class CalendarStore {
  constructor(directory, { clock = Date.now } = {}) {
    this.directory = directory; this.file = path.join(directory, 'calendar.json');
    this.lock = path.join(directory, 'writer.lock'); this.clock = clock; this.tail = Promise.resolve();
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
      try { this.data = JSON.parse(await fs.readFile(this.file, 'utf8')); }
      catch (e) {
        if (e.code !== 'ENOENT') throw new Error('calendar.json is unreadable; refusing to overwrite it', { cause: e });
        this.data = { schemaVersion: 1, revision: 0, items: {}, occurrences: {}, receipts: {}, seenMessages: [], lastDeliveryAt: null, syncClients: {} };
        await atomicJSON(this.file, this.data);
      }
      if (this.data.schemaVersion !== 1 || !this.data.items || !this.data.occurrences || !Number.isInteger(this.data.revision)) throw new Error('Unsupported calendar data schema');
      for (const item of Object.values(this.data.items)) normalizeItem(editable(item));
      return this;
    } catch (e) { await this.close(); throw e; }
  }
  snapshot() { return structuredClone(this.data); }
  async transact(fn) {
    const run = this.tail.then(async () => {
      const next = structuredClone(this.data);
      const result = await fn(next);
      if (JSON.stringify(next) !== JSON.stringify(this.data)) {
        next.revision++;
        await atomicJSON(this.file + '.backup', this.data);
        await atomicJSON(this.file, next);
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
  async upsert({ id = randomUUID(), baseRevision = 0, item, operationId = randomUUID() }) {
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
      for (const occurrence of Object.values(d.occurrences)) {
        if (occurrence.itemId === id && ['active', 'acknowledged'].includes(occurrence.state) && (scheduleChanged || !next.enabled || next.status !== 'open')) occurrence.state = 'cancelled';
      }
      d.receipts[operationId] = { fingerprint, result: structuredClone(next) };
      return next;
    });
  }
  async remove({ id, baseRevision, operationId = randomUUID() }) {
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
      for (const o of Object.values(d.occurrences)) if (o.itemId === id && ['active', 'acknowledged'].includes(o.state)) o.state = 'cancelled';
      d.receipts[operationId] = { fingerprint, result: structuredClone(item) };
      return item;
    });
  }
}
