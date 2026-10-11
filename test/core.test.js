import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CalendarStore } from '../src/store.js';
import { ReminderScheduler } from '../src/scheduler.js';
import { normalizeItem, occurrencesBetween } from '../src/model.js';
import { startService, tokenFor } from '../src/service.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fakeAgents } from './agent-fixture.js';
import {readStorageSync} from '../src/storage-layout.js';

const epoch = Date.parse('2026-10-11T02:00:00Z');
const input = (extra = {}) => ({ title: '喝水', dueAt: new Date(epoch).toISOString(), ...extra });
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-test-'));
  let now = epoch; const clock = () => now;
  const store = await new CalendarStore(dir, { clock }).open();
  const sent = []; const scheduler = new ReminderScheduler(store, { clock, ownerQQ: '123', botQQ: '456', send: async b => { sent.push(b); return { message_id: sent.length }; } });
  t.after(async () => { await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, store, scheduler, sent, advance: n => now += n, reply: (id = 1, extra = {}) => scheduler.receive({ post_type: 'message', message_type: 'private', user_id: 123, self_id: 456, message_id: id, time: Math.floor(now / 1000), ...extra }) };
}
test('30 second cadence; any authentic reply acknowledges but does not complete; restart preserves state', async t => {
  const s = await setup(t); const item = await s.store.upsert({ id: 'water', item: input() });
  await s.scheduler.tick(); assert.equal(s.sent.length, 1);
  s.advance(29999); await s.scheduler.tick(); assert.equal(s.sent.length, 1);
  s.advance(1); await s.scheduler.tick(); assert.equal(s.sent.length, 2);
  await s.reply(2, { user_id: 789 }); s.advance(30000); await s.scheduler.tick(); assert.equal(s.sent.length, 3);
  await s.reply(); s.advance(30000); await s.scheduler.tick(); assert.equal(s.sent.length, 3);
  assert.equal(s.store.snapshot().items.water.status, 'open');
  await s.store.close(); await s.store.open(); s.advance(30000); await s.scheduler.tick(); assert.equal(s.sent.length, 3);
  await s.scheduler.act({ action: 'complete', itemId: item.id }); assert.equal(s.store.snapshot().items.water.status, 'done');
  await assert.rejects(s.scheduler.act({ action: 'snooze', itemId: item.id, minutes: 1 }));
});
test('snooze resumes; replay and pre-reminder messages do not acknowledge new reminders', async t => {
  const s = await setup(t); await s.store.upsert({ id: 'water', item: input() });
  await s.scheduler.tick(); await s.reply(); await s.scheduler.act({ action: 'snooze', itemId: 'water', minutes: 1 });
  s.advance(59000); await s.scheduler.tick(); assert.equal(s.sent.length, 1);
  s.advance(1000); await s.scheduler.tick(); assert.equal(s.sent.length, 2);
  await s.reply(1); await s.reply(2, { time: epoch / 1000 }); s.advance(30000); await s.scheduler.tick(); assert.equal(s.sent.length, 3);
});
test('habit completion affects only current occurrence, with latest-only catch-up', async t => {
  const s = await setup(t); await s.store.upsert({ id: 'water', item: input({ kind: 'habit', recurrence: { frequency: 'daily' } }) });
  await s.scheduler.tick(); await s.scheduler.act({ action: 'complete', itemId: 'water' });
  s.advance(86400000 * 5); await s.scheduler.tick(); assert.equal(s.sent.length, 2);
  assert.equal(s.store.snapshot().items.water.status, 'open');
  assert.equal(Object.values(s.store.snapshot().occurrences).filter(o => o.state === 'active').length, 1);
});
test('wall clock recurrence survives DST and weekly weekdays', () => {
  const item = normalizeItem(input({ dueAt: '2026-03-07T09:00:00-05:00', kind: 'habit', timeZone: 'America/New_York', recurrence: { frequency: 'daily' } }));
  assert.deepEqual(occurrencesBetween(item, Date.parse(item.dueAt), Date.parse('2026-03-09T20:00Z')), ['2026-03-07T14:00:00.000Z','2026-03-08T13:00:00.000Z','2026-03-09T13:00:00.000Z']);
  const weekly = normalizeItem(input({ recurrence: { frequency: 'weekly', weekdays: [1,3] } }));
  assert.deepEqual(occurrencesBetween(weekly, epoch, epoch + 7 * 86400000), ['2026-10-12T02:00:00.000Z','2026-10-14T02:00:00.000Z']);
});
test('CAS rejects concurrent edits; receipts make retries idempotent; tombstones reject resurrection', async t => {
  const { store } = await setup(t);
  const req = { id: 'water', operationId: 'op1', item: input() }; const item = await store.upsert(req);
  assert.deepEqual(await store.upsert(req), item);
  const changes = await Promise.allSettled(['甲','乙'].map(title => store.upsert({ id: item.id, baseRevision: 1, item: input({ title }) })));
  assert.equal(changes.filter(r => r.status === 'fulfilled').length, 1);
  await store.remove({ id: item.id, baseRevision: 2, operationId: 'delete1' });
  assert.deepEqual(await store.upsert(req), item, 'an idempotency receipt must not mutate with the item');
  await assert.rejects(store.upsert({ id: item.id, baseRevision: 3, item: input() }), /resurrected/);
  await assert.rejects(store.upsert({ id: '__proto__', item: input() }));
  await assert.rejects(store.remove({ id: 'water', baseRevision: 3, operationId: '__proto__' }));
});
test('rescheduling cancels old nagging, failed sends back off, many pending items do not starve', async t => {
  const s = await setup(t);
  for (let i=0;i<23;i++) await s.store.upsert({ id: `item-${i}`, item: input() });
  await s.scheduler.tick(); assert.equal(s.sent[0].keys.length, 20);
  s.advance(30000); await s.scheduler.tick(); assert.ok(s.sent[1].keys.some(k => k.startsWith('item-22:')));
  const item = s.store.snapshot().items['item-22'];
  await s.store.upsert({ id: item.id, baseRevision: item.revision, item: input({ dueAt: new Date(epoch + 86400000).toISOString() }) });
  assert.equal(Object.values(s.store.snapshot().occurrences).find(o => o.itemId === item.id).state, 'cancelled');
  let failures = 0; s.scheduler.send = async () => { failures++; throw Error('offline'); };
  s.advance(30000); await s.scheduler.tick(); await s.scheduler.tick(); assert.equal(failures, 1);
});
test('second writer and corrupt state fail closed', async t => {
  const s = await setup(t);
  await assert.rejects(new CalendarStore(s.dir).open(), /already has a writer/);
  await s.store.close(); await fs.writeFile(s.store.file, '{bad');
  await assert.rejects(new CalendarStore(s.dir).open(), /refusing to overwrite/);
  assert.equal(await fs.readFile(s.store.file, 'utf8'), '{bad');
});
test('authenticated HTTP API and real stdio MCP client can list/create; browser and invalid writes rejected', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-mcp-'));
  const config = { dataDir: dir, port: 0, timeZone: 'Asia/Shanghai', repeatMs: 30000, onebot: { ownerQQ:'123', botQQ:'456', configFile: '/unused' } };
  const service = await startService(config, { startTimer: false, startTransport: false, transport: { connected:true, close(){} } });
  t.after(async () => { await service.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${service.port}/v1/`; const token = await tokenFor(dir);
  assert.equal((await fetch(url+'state')).status, 401);
  assert.equal((await fetch(url+'state', { headers: { Authorization:`Bearer ${token}`, Origin:'http://evil.test' } })).status, 403);
  const cfg = path.join(dir, 'config.json'); await fs.writeFile(cfg, JSON.stringify({ ...config, port: service.port }));
  const client = new Client({ name:'test',version:'1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('src/mcp.js'), cfg], stderr: 'pipe' }));
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 6);
  const added = await client.callTool({ name:'calendar_save', arguments: { id:'mcp-task', item:input() } }); assert.ok(!added.isError, JSON.stringify(added));
  const state = JSON.parse((await client.callTool({ name:'calendar_list',arguments:{} })).content[0].text);
  assert.equal(state.items[0].id, 'mcp-task'); assert.equal(state.qqConnected, true);
  assert.equal(state.items[0].dueAtLocal, '2026-10-11T10:00:00.000+08:00');
  assert.equal(state.memory.recentHistory.at(-1).type, 'item-created');
  const bad = await client.callTool({ name:'calendar_save',arguments: { id:'mcp-task',baseRevision:0,item:input() } }); assert.equal(bad.isError,true);
});
test('latest due is consistent with enumeration across intervals, weekdays, ending rules and DST', async () => {
  const { latestDue } = await import('../src/model.js');
  for (const zone of ['Asia/Shanghai','America/New_York','Europe/Berlin']) {
    for (const frequency of ['daily','weekly']) for (const interval of [1,2,7,52]) {
      const item = normalizeItem(input({timeZone:zone,dueAt:'2025-01-02T08:30:00Z', recurrence:{frequency,interval,...(frequency==='weekly'?{weekdays:[1,3,7]}:{})}}));
      for (const offset of [0,1,7,30,70,300,367,500]) {
        const now=Date.parse(item.dueAt)+offset*86400000-1000;
        const all=occurrencesBetween(item,Date.parse(item.dueAt),now,1000);
        assert.equal(latestDue(item,now),all.at(-1)??null,`${zone} ${frequency} ${interval} ${offset}`);
      }
    }
  }
});
test('plugin lifecycle hooks deliver through OneBot HTTP and acknowledge through its WebSocket', async t => {
  const http = await import('node:http'); const { WebSocketServer } = await import('ws');
  const { apply } = await import('../src/plugin.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-hook-')); const sent=[];
  const onebot = http.createServer(async (req,res) => {
    if(req.headers.authorization!=='Bearer test-token') {res.writeHead(401);res.end();return;}
    let text='';for await(const part of req)text+=part;
    const data=JSON.parse(text||'{}');res.setHeader('content-type','application/json');
    if(req.url==='/get_login_info') res.end(JSON.stringify({status:'ok',retcode:0,data:{user_id:456}}));
    else if(req.url==='/send_private_msg') {sent.push(data);res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:12}}));}
    else {res.writeHead(404);res.end('{}');}
  });
  await new Promise(r=>onebot.listen(0,'127.0.0.1',r)); const port=onebot.address().port;
  const wss = new WebSocketServer({server:onebot}); let socket;
  wss.on('connection',ws=>socket=ws);
  const handlers=new Map(),disposers=[],seen=[];
  const ctx={ ...fakeAgents(), on(n,fn){handlers.set(n,fn);},async parallel(n,x){seen.push(n);return handlers.get(n)?.(x);},emit(n){seen.push(n);},effect(fn){disposers.push(fn());},logger:{info(){},warn(){}} };
  t.after(async()=>{for(const dispose of disposers)await dispose();wss.close();await new Promise(r=>onebot.close(r));await fs.rm(dir,{recursive:true,force:true});});
  await fs.writeFile(path.join(dir,'token'),'test-token');
  const cfg=path.join(dir,'config.json');
  await fs.writeFile(cfg,JSON.stringify({dataDir:dir,port:0,onebot:{ownerQQ:'123',botQQ:'456',httpUrl:`http://127.0.0.1:${port}`,wsUrl:`ws://127.0.0.1:${port}`,httpTokenFile:'token',wsTokenFile:'token'}}));
  await apply(ctx,{configFile:cfg});
  const waitFor=async predicate=>{const until=Date.now()+8000;while(!await predicate()){if(Date.now()>until)throw Error('timed out');await new Promise(r=>setTimeout(r,30));}};
  await waitFor(()=>socket);
  // Exercise plugin hooks with mock OneBot endpoints; never contact real QQ.
  const batch={deliveryId:'test',keys:[],isCurrent:()=>true};
  await ctx.parallel('calendar-agent/reminder-due',batch);
  assert.equal(sent.length,1);assert.equal(sent[0].user_id,123);assert.equal(batch.result.message_id,12);
  assert.equal(ctx.calls.length,1); assert.equal(ctx.calls[0].source.kind,'calendar-reminder');
  assert.equal(sent[0].message[0].data.text,'该喝水了，先拿起水杯喝几口吧。');
  socket.send(JSON.stringify({post_type:'message',message_type:'private',self_id:456,user_id:123,message_id:13,time:Math.floor(Date.now()/1000)}));
  await waitFor(async()=>readStorageSync(dir).data.seenMessages.length===1);
  assert.ok(seen.includes('calendar-agent/message'));
});

test('receipts stay immutable when completing an item without replacing it', async t => {
  const s=await setup(t);const req={id:'receipt',operationId:'create-receipt',item:input()};
  const created=await s.store.upsert(req);await s.scheduler.act({action:'complete',itemId:'receipt'});
  assert.deepEqual(await s.store.upsert(req),created);
  await assert.rejects(s.store.upsert({id:'toString',item:input()}));
});

test('HTTP diagnostics distinguishes Mac requests and failures without retaining tokens or payloads', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-diag-'));
  const service = await startService({dataDir:dir, port:0, timeZone:'Asia/Shanghai', repeatMs:30000, onebot:{}}, {startTimer:false,startTransport:false,transport:{close(){}}});
  t.after(async()=>{await service.close();await fs.rm(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${service.port}/v1/`;const token=await tokenFor(dir);
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json','User-Agent':'DSHCalendarSync/2 CFNetwork/1 Darwin/1'};
  const body={id:'mac-test',baseRevision:0,operationId:'mac-op',item:input({title:'private event',dueAt:'2026-10-11T04:00:00.000Z',durationMinutes:60,timeZone:'Asia/Shanghai',recurrence:null,enabled:true,status:'open'})};
  assert.equal((await fetch(base+'upsert',{method:'POST',headers,body:JSON.stringify(body)})).status,200);
  assert.equal((await fetch(base+'upsert',{method:'POST',headers,body:'{}'})).status,400);
  assert.equal((await fetch(base+'state',{headers:{'User-Agent':headers['User-Agent']}})).status,401);
  assert.equal((await fetch(base+'diagnostics')).status,401);
  const d=await (await fetch(base+'diagnostics',{headers:{Authorization:`Bearer ${token}`}})).json();
  assert.equal(d.requests['mac POST /v1/upsert'].successes,1);
  assert.equal(d.requests['mac POST /v1/upsert'].failures,1);
  assert.equal(d.requests['mac GET /v1/state'].lastStatus,401);
  assert.ok(!JSON.stringify(d).includes(token));assert.ok(!JSON.stringify(d).includes('private event'));
});
