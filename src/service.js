import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DateTime } from 'luxon';
import { CalendarStore } from './store.js';
import { ReminderScheduler } from './scheduler.js';
import { OneBot } from './onebot.js';
import { errorStatus, problem, occurrencesBetween } from './model.js';
import { calendarMemory, localTime } from './memory.js';

export async function tokenFor(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'access-token');
  try { await fs.writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  const token = (await fs.readFile(file, 'utf8')).trim();
  if (token.length < 32) throw new Error('Calendar access token is invalid');
  return token;
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const part of req) {
    size += part.length;
    if (size > 256 * 1024) throw problem('Request too large', 413);
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw problem('Expected a JSON body'); }
}
export async function startService(config, options = {}) {
  const store = await new CalendarStore(config.dataDir, { clock: options.clock }).open();
  const diagnostics = { startedAt: new Date().toISOString(), requests: {} };
  let server, timer, transport, scheduler;
  try {
    const token = await tokenFor(config.dataDir);
    transport = options.transport ?? new OneBot(config.onebot, e => options.receiveHook ? options.receiveHook(e) : scheduler.receive(e), options.log ?? (() => {}));
    scheduler = new ReminderScheduler(store, {
      clock: options.clock, repeatMs: config.repeatMs, ...config.onebot,
      send: options.sendHook ?? (async () => { throw Error('Reminder delivery requires the DSH Agent plugin'); }), onEvent: options.onEvent
    });
    server = http.createServer(async (req, res) => {
      const route = ['/v1/state', '/v1/projections', '/v1/upsert', '/v1/delete', '/v1/action', '/v1/diagnostics', '/v1/reminder-preview'].includes(req.url?.split('?')[0]) ? req.url.split('?')[0] : 'other';
      const client = /DSHCalendarSync|CFNetwork|Darwin/i.test(req.headers['user-agent'] ?? '') ? 'mac' : 'other';
      const method = ['GET', 'POST'].includes(req.method) ? req.method : 'other';
      res.on('finish', () => {
        const key = `${client} ${method} ${route}`;
        const entry = diagnostics.requests[key] ??= { count: 0, lastAt: null, lastStatus: null, successes: 0, failures: 0 };
        entry.count++; entry.lastAt = new Date().toISOString(); entry.lastStatus = res.statusCode;
        entry[res.statusCode < 400 ? 'successes' : 'failures']++;
      });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const reply = (status, data) => { res.writeHead(status); res.end(JSON.stringify(data)); };
      try {
        const supplied = Buffer.from(req.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw problem('Unauthorized', 401);
        // This is a local API for MCP / a native Mac app, never a browser origin.
        if (req.headers.origin) throw problem('Browser origins are not supported', 403);
        const url = new URL(req.url, 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/v1/diagnostics') return reply(200, diagnostics);
        if (req.method === 'GET' && url.pathname === '/v1/state') {
          const d = store.snapshot();
          return reply(200, { schemaVersion: 1, revision: d.revision,
            now: DateTime.fromMillis(options.clock?.() ?? Date.now()).setZone(config.timeZone).toISO(), timeZone: config.timeZone,
            weekday: DateTime.fromMillis(options.clock?.() ?? Date.now()).setZone(config.timeZone).setLocale('zh-CN').toFormat('cccc'),
            qqConnected: transport.connected === true,
            items: Object.values(d.items).map(i => ({ ...i, dueAtLocal: localTime(i.dueAt, i.timeZone) })),
            occurrences: Object.values(d.occurrences).map(o => ({ ...o, dueAtLocal: localTime(o.dueAt, d.items[o.itemId].timeZone) })), memory: calendarMemory(d) });
        }
        if (req.method === 'GET' && url.pathname === '/v1/projections') {
          const now = options.clock?.() ?? Date.now();
          const from = url.searchParams.has('from') ? Date.parse(url.searchParams.get('from')) : now - 7 * 86400000;
          const to = url.searchParams.has('to') ? Date.parse(url.searchParams.get('to')) : now + 90 * 86400000;
          if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 366 * 86400000) throw problem('Projection range must be <= 366 days');
          const d = store.snapshot(); const events = [];
          for (const item of Object.values(d.items)) {
            if (!item.recurrence || item.deletedAt || !item.enabled || item.status !== 'open') continue;
            for (const dueAt of occurrencesBetween(item, from, to)) {
              const key = `${item.id}:${item.scheduleVersion}@${dueAt}`;
              events.push({ key, itemId: item.id, title: item.title, notes: item.notes, dueAt,
                durationMinutes: item.durationMinutes, timeZone: item.timeZone, state: d.occurrences[key]?.state ?? 'scheduled' });
            }
          }
          return reply(200, { from, to, events });
        }
        if (req.method === 'POST') {
          const input = await body(req);
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw problem('Expected an object');
          if (url.pathname === '/v1/reminder-preview') {
            if (!options.previewHook) throw problem('Preview requires the DSH plugin', 503);
            return reply(200, await options.previewHook(input));
          }
          if (url.pathname === '/v1/upsert') return reply(200, await store.upsert(input));
          if (url.pathname === '/v1/delete') return reply(200, await store.remove(input));
          if (url.pathname === '/v1/action') return reply(200, await scheduler.act(input));
        }
        throw problem('Not found', 404);
      } catch (e) { reply(errorStatus(e), { error: errorStatus(e) === 500 ? 'Calendar operation failed' : e.message }); }
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
    if (options.startTransport !== false) transport.start();
    if (options.startTimer !== false && options.sendHook) {
      timer = setInterval(() => scheduler.tick().catch(() => options.log?.('Calendar tick failed')), 1000);
      timer.unref();
    }
    return { store, scheduler, transport, port: server.address().port,
      async close() {
        scheduler.stopped = true; clearInterval(timer); transport.close();
        await new Promise(resolve => server.close(resolve));
        while (scheduler.busy) await new Promise(resolve => setTimeout(resolve, 10));
        await store.close();
      }
    };
  } catch (e) { clearInterval(timer); transport?.close(); server?.close(); await store.close(); throw e; }
}
