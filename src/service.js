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
import { ICloudDAV, loadCloudCredentials } from './icloud-dav.js';
import { ICloudSync } from './icloud-sync.js';
import { readConfig } from './config.js';
import { itemSyncStatus } from './sync-status.js';
import {syncWindow} from './sync-window.js';

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
  const store = await new CalendarStore(config.dataDir, { clock: options.clock,timeZone:config.timeZone }).open();
  const diagnostics = { startedAt: new Date().toISOString(), requests: {} };
  let server, timer, transport, scheduler, cloud, cloudTimer, cloudError=null, cloudReloadPromise=null;
  const cloudStatus=()=>cloud?.status()??{enabled:!!config.icloud?.enabled,lastError:cloudError};
  const syncFor=(item,data=store.snapshot())=>itemSyncStatus(item,data,{enabled:!!config.icloud?.enabled,available:!!cloud,error:cloudError,now:options.clock?.()??Date.now(),timeZone:config.timeZone});
  const syncForTool=async()=>{
    if(!cloud)return {state:config.icloud?.enabled?'unavailable':'disabled'};
    let timeout;
    try {
      const finished=cloud.requestSync().then(()=>({state:cloudStatus().lastError?'error':'finished'}),()=>({state:'error'}));
      // Slow Apple requests keep running; never turn a committed local write
      // into a tool failure merely because the network exceeded this budget.
      return await Promise.race([finished,new Promise(resolve=>{
        timeout=setTimeout(()=>resolve({state:'running'}),options.toolSyncWaitMs??8000);
      })]);
    }finally{clearTimeout(timeout);}
  };
  const reloadCloud=next=>{
    if(cloudReloadPromise)throw problem('正在加载 iCloud 配置，请稍后重试',409);
    cloudReloadPromise=(async()=>{
    config.icloud=next;
    await cloud?.close();cloud=null;cloudError=null;
    if(!next?.enabled)return;
    try {
      const dav=options.cloudDAV??new ICloudDAV(await loadCloudCredentials(next.credentialsFile));
      const candidate=new ICloudSync(store,dav,{...next,timeZone:config.timeZone},{clock:options.clock,log:options.log});
      try {await candidate.initialize();}catch(e){await candidate.close();throw e;}
      cloud=candidate;
    }catch(e){cloudError='iCloud 尚未连接：请检查专用密码文件权限、日历地址及既有绑定';throw e;}
    })();
    return cloudReloadPromise.finally(()=>{cloudReloadPromise=null;});
  };
  try {
    const token = await tokenFor(config.dataDir);
    transport = options.transport ?? new OneBot(config.onebot, e => options.receiveHook ? options.receiveHook(e) : scheduler.receive(e), options.log ?? (() => {}));
    scheduler = new ReminderScheduler(store, {
      clock: options.clock, repeatMs: config.repeatMs, ...config.onebot,
      send: options.sendHook ?? (async () => { throw Error('Reminder delivery requires the DSH Agent plugin'); }), onEvent: options.onEvent
    });
    server = http.createServer(async (req, res) => {
      const route = ['/v1/agent/state', '/v1/agent/upsert', '/v1/agent/delete', '/v1/agent/action', '/v1/state', '/v1/projections', '/v1/upsert', '/v1/delete', '/v1/action', '/v1/diagnostics', '/v1/reminder-preview', '/v1/icloud/status', '/v1/icloud/reload', '/v1/icloud/sync', '/v1/icloud/resolve'].includes(req.url?.split('?')[0]) ? req.url.split('?')[0] : 'other';
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
        if(config.icloud?.enabled && client==='mac')throw problem('已启用 Linux 直连 iCloud。请退出旧 DSH 日历同步程序，使用系统日历的 iCloud 同步。',409);
        const url = new URL(req.url, 'http://127.0.0.1');
        const agentRoute=['/v1/agent/state','/v1/agent/upsert','/v1/agent/delete','/v1/agent/action'].includes(url.pathname);
        if(agentRoute)url.pathname=url.pathname.replace('/agent/','/');
        if (req.method === 'GET' && url.pathname === '/v1/diagnostics') return reply(200, diagnostics);
        if (req.method === 'GET' && url.pathname === '/v1/icloud/status') return reply(200,cloudStatus());
        if (req.method === 'GET' && url.pathname === '/v1/state') {
          const toolSync=agentRoute?await syncForTool():undefined;
          const d = store.snapshot();
          return reply(200, { schemaVersion: 1, revision: d.revision,toolSync,
            now: DateTime.fromMillis(options.clock?.() ?? Date.now()).setZone(config.timeZone).toISO(), timeZone: config.timeZone,
            weekday: DateTime.fromMillis(options.clock?.() ?? Date.now()).setZone(config.timeZone).setLocale('zh-CN').toFormat('cccc'),
            qqConnected: transport.connected === true,syncBackend:config.icloud?.enabled?'icloud':'mac',icloud:cloudStatus(),syncWindow:syncWindow(options.clock?.()??Date.now(),config.timeZone),
            items: Object.values(d.items).map(i => ({ ...i, dueAtLocal: localTime(i.dueAt, i.timeZone),sync:syncFor(i,d) })),
            occurrences: Object.values(d.occurrences).map(o => ({ ...o, dueAtLocal: localTime(o.dueAt, d.items[o.itemId].timeZone) })), memory: calendarMemory(d) });
        }
        if (req.method === 'GET' && url.pathname === '/v1/projections') {
          const now = options.clock?.() ?? Date.now();
          const window=syncWindow(now,config.timeZone);
          const from = url.searchParams.has('from') ? Date.parse(url.searchParams.get('from')) : window.from;
          const to = url.searchParams.has('to') ? Date.parse(url.searchParams.get('to')) : window.to-1;
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
          if(url.pathname==='/v1/icloud/reload') {
            if(!config.sourceFile)throw problem('当前服务没有配置文件位置',409);
            const next=await readConfig(config.sourceFile);
            if(next.dataDir!==config.dataDir || next.port!==config.port)throw problem('端口或数据目录变化需要重启 DSH',409);
            await reloadCloud(next.icloud);return reply(200,cloudStatus());
          }
          if(url.pathname==='/v1/icloud/sync') {
            if(!cloud)throw problem('iCloud 尚未配置或连接',409);
            await cloud.tick(true);return reply(200,cloudStatus());
          }
          if(url.pathname==='/v1/icloud/resolve') {
            if(!cloud)throw problem('iCloud 尚未配置或连接',409);
            await cloud.resolve(input.id,input.prefer);return reply(200,cloudStatus());
          }
          if (url.pathname === '/v1/reminder-preview') {
            if (!options.previewHook) throw problem('Preview requires the DSH plugin', 503);
            return reply(200, await options.previewHook(input));
          }
          if (url.pathname === '/v1/upsert') {
            const saved=await store.upsert(input);
            if(agentRoute){const toolSync=await syncForTool();return reply(200,{...saved,sync:syncFor(saved),toolSync,icloud:cloudStatus()});}
            return reply(200,{...saved,sync:syncFor(saved)});
          }
          if (url.pathname === '/v1/delete' || url.pathname === '/v1/action') {
            const result=url.pathname==='/v1/delete'?await store.remove(input):await scheduler.act(input);
            if(agentRoute){const toolSync=await syncForTool();return reply(200,{...result,sync:syncFor(result.item??result),toolSync,icloud:cloudStatus()});}
            return reply(200,result);
          }
        }
        throw problem('Not found', 404);
      } catch (e) { reply(errorStatus(e), { error: errorStatus(e) === 500 ? 'Calendar operation failed' : e.message }); }
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
    if (options.startTransport !== false) transport.start();
    await reloadCloud(config.icloud).catch(()=>options.log?.(cloudError));
    if(options.startCloudTimer!==false){cloudTimer=setInterval(()=>cloud?.tick().catch(()=>options.log?.('iCloud 同步状态保存失败')),1000);cloudTimer.unref();}
    if (options.startTimer !== false && options.sendHook) {
      timer = setInterval(() => scheduler.tick().catch(() => options.log?.('Calendar tick failed')), 1000);
      timer.unref();
    }
    return { store, scheduler, transport, port: server.address().port,
      async close() {
        scheduler.stopped = true; clearInterval(timer);clearInterval(cloudTimer); transport.close();
        await new Promise(resolve => server.close(resolve));
        await cloudReloadPromise?.catch(()=>{});
        await cloud?.close();
        while (scheduler.busy) await new Promise(resolve => setTimeout(resolve, 10));
        await store.close();
      }
    };
  } catch (e) { clearInterval(timer);clearInterval(cloudTimer);await cloud?.close(); transport?.close(); server?.close(); await store.close(); throw e; }
}
