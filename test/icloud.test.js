import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CalendarStore} from '../src/store.js';
import {ReminderScheduler} from '../src/scheduler.js';
import {ICloudSync} from '../src/icloud-sync.js';
import {ICloudDAV,appleURL,loadCloudCredentials,cloudFailureMessage} from '../src/icloud-dav.js';
import {encodeEvent,parseEvent,fieldsFor} from '../src/icloud-codec.js';
import {startService,tokenFor} from '../src/service.js';
import {readConfig} from '../src/config.js';

const base='https://p12-caldav.icloud.com/123/calendars/dsh/';
const at=Date.parse('2026-10-11T07:00:00Z');
const item=(extra={})=>({title:'学习',notes:'',dueAt:new Date(at).toISOString(),durationMinutes:30,timeZone:'Asia/Shanghai',...extra});
class FakeDAV {
  credentials={username:'test@example.com'};objects=new Map();puts=0;deletes=0;version=0;
  async list(){if(this.listFailure)throw Error('offline');return [...this.objects.values()].map(x=>({...x}));}
  async get(href){return this.objects.get(href)??null;}
  async put(href,raw,etag){
    const old=this.objects.get(href);if((old?.etag??null)!==etag)throw Object.assign(Error('CAS'),{status:409});
    this.puts++;this.objects.set(href,{href,raw,etag:`"${++this.version}"`});
    if(this.loseResponse){this.loseResponse=false;throw Error('lost response');}
  }
  async remove(href,etag){const old=this.objects.get(href);if(old && old.etag!==etag)throw Object.assign(Error('CAS'),{status:409});this.deletes++;this.objects.delete(href);}
  seed(uid,values,extra={}){const href=base+encodeURIComponent(uid)+'.ics';this.objects.set(href,{href,etag:`"${++this.version}"`,raw:encodeEvent({uid,fields:values,...extra})});return href;}
  edit(href,changes){const o=this.objects.get(href),p=parseEvent(o.raw);this.objects.set(href,{...o,etag:`"${++this.version}"`,raw:encodeEvent({uid:p.uid,fields:{...p.fields,...changes},raw:o.raw})});}
  close(){}
}
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'icloud-sync-test-'));
  const store=await new CalendarStore(dir,{clock:()=>at}).open(),dav=new FakeDAV();
  const config={calendarUrl:base,intervalMs:10000,timeZone:'Asia/Shanghai'};
  let sync=new ICloudSync(store,dav,config,{clock:()=>at});await sync.initialize();
  t.after(async()=>{await sync.close();await store.close();await fs.rm(dir,{recursive:true,force:true});});
  return {store,dav,sync,dir,async restart(){await sync.close();await store.close();await store.open();sync=new ICloudSync(store,dav,config,{clock:()=>at});await sync.initialize();return sync;}};
}
test('CalDAV codec round-trips escaped text and preserves unrelated event properties',()=>{
  const values=item({title:'会议,准备;\n材料',notes:'备注\\换行\n第二行'});
  const raw=encodeEvent({uid:'one',itemId:'task',fields:values}).replace('END:VEVENT','LOCATION:办公室\r\nEND:VEVENT');
  assert.deepEqual(parseEvent(raw).fields,values);
  const edited=encodeEvent({uid:'one',fields:{...values,title:'更新'},raw});
  assert.ok(edited.includes('LOCATION:办公室'));assert.equal(parseEvent(edited).itemId,'task');
  const local='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:tz\r\nSUMMARY:test\r\nDTSTART;TZID=Asia/Shanghai:20261011T153000\r\nDTEND;TZID=Asia/Shanghai:20261011T163000\r\nEND:VEVENT\r\nEND:VCALENDAR';
  assert.equal(parseEvent(local).fields.dueAt,'2026-10-11T07:30:00.000Z');
  assert.ok(parseEvent(local.replace('DTSTART;TZID=Asia/Shanghai:20261011T153000','DTSTART;VALUE=DATE:20261011')).unsupported);
  assert.ok(parseEvent(local.replace('END:VEVENT','RRULE:FREQ=DAILY\r\nEND:VEVENT')).unsupported);
});
test('iCloud imports, exports and reschedules both ways; remote reschedule cancels old reminder',async t=>{
  const s=await fixture(t);const href=s.dav.seed('apple-one',item());
  await s.sync.tick(true);let local=Object.values(s.store.snapshot().items)[0];assert.equal(local.title,'学习');
  const scheduler=new ReminderScheduler(s.store,{clock:()=>at,ownerQQ:'1',botQQ:'2',send:async()=>({message_id:1})});await scheduler.tick();
  s.dav.edit(href,{dueAt:new Date(at+3600000).toISOString()});await s.sync.tick(true);
  local=s.store.snapshot().items[local.id];assert.equal(local.dueAt,new Date(at+3600000).toISOString());
  assert.equal(Object.values(s.store.snapshot().occurrences)[0].state,'cancelled');
  await s.store.upsert({id:local.id,baseRevision:local.revision,item:item({title:'QQ 修改',dueAt:new Date(at+7200000).toISOString()})});
  await s.sync.tick(true);assert.equal(parseEvent((await s.dav.get(href)).raw).fields.title,'QQ 修改');
  assert.equal(s.sync.status().conflicts.length,0);assert.equal(s.sync.status().lastError,null);
});
test('conditional PUT retry after response loss and restart creates only one event',async t=>{
  const s=await fixture(t);await s.store.upsert({id:'local',item:item()});s.dav.loseResponse=true;
  await s.sync.tick(true);assert.equal(s.dav.objects.size,1);assert.equal(s.sync.status().pending,1);
  const resumed=await s.restart();await resumed.tick(true);
  assert.equal(s.dav.objects.size,1);assert.equal(s.dav.puts,1);assert.equal(resumed.status().pending,0);
  assert.equal(Object.keys(s.store.snapshot().items).length,1);
});
test('two-sided edits preserve both versions until explicit resolution',async t=>{
  const s=await fixture(t),href=s.dav.seed('conflict',item());await s.sync.tick(true);
  let local=Object.values(s.store.snapshot().items)[0];
  await s.store.upsert({id:local.id,baseRevision:local.revision,item:item({title:'本地'})});s.dav.edit(href,{title:'云端'});
  await s.sync.tick(true);assert.equal(s.sync.status().conflicts.length,1);
  assert.equal(s.store.snapshot().items[local.id].title,'本地');assert.equal(parseEvent((await s.dav.get(href)).raw).fields.title,'云端');
  await s.sync.resolve(local.id,'remote');assert.equal(s.store.snapshot().items[local.id].title,'云端');
  local=s.store.snapshot().items[local.id];await s.store.upsert({id:local.id,baseRevision:local.revision,item:item({title:'保留本地'})});s.dav.edit(href,{title:'又改云端'});
  await s.sync.tick(true);await s.sync.resolve(local.id,'local');
  assert.equal(parseEvent((await s.dav.get(href)).raw).fields.title,'保留本地');assert.equal(s.sync.status().conflicts.length,0);
});
test('cloud deletion needs two full rounds and failed requests never delete local data',async t=>{
  const s=await fixture(t),href=s.dav.seed('delete',item());await s.sync.tick(true);const id=Object.keys(s.store.snapshot().items)[0];
  s.dav.objects.delete(href);s.dav.listFailure=true;await s.sync.tick(true);assert.equal(s.store.snapshot().items[id].deletedAt,null);
  s.dav.listFailure=false;await s.sync.tick(true);assert.equal(s.store.snapshot().items[id].deletedAt,null);
  await s.sync.tick(true);assert.ok(s.store.snapshot().items[id].deletedAt);
});
test('local deletion uses cloud ETag and does not resurrect tombstones',async t=>{
  const s=await fixture(t);await s.store.upsert({id:'delete-local',item:item()});await s.sync.tick(true);
  await s.store.remove({id:'delete-local',baseRevision:1});await s.sync.tick(true);
  assert.equal(s.dav.objects.size,0);assert.equal(s.dav.deletes,1);assert.ok(s.store.snapshot().items['delete-local'].deletedAt);
});
test('migration adopts old Mac URL mapping rather than duplicating an event',async t=>{
  const s=await fixture(t);await s.store.upsert({id:'mac-item',item:item()});
  const href=s.dav.seed('apple-generated-uid',item());let o=s.dav.objects.get(href);
  s.dav.objects.set(href,{...o,raw:o.raw.replace('END:VEVENT','URL:dshcalendar://item/mac-item\r\nEND:VEVENT')});
  await s.sync.tick(true);assert.equal(Object.keys(s.store.snapshot().items).length,1);assert.equal(s.dav.puts,0);
  assert.equal(s.sync.status().mapped,1);
});
test('unsupported events stay intact; supported items sync across the full calendar, including future years',async t=>{
  const s=await fixture(t),href=s.dav.seed('repeating',item());let o=s.dav.objects.get(href);
  s.dav.objects.set(href,{...o,raw:o.raw.replace('END:VEVENT','RRULE:FREQ=DAILY\r\nEND:VEVENT')});
  s.dav.seed('future',item({dueAt:'2036-10-11T07:00:00.000Z'}));await s.sync.tick(true);
  assert.equal(Object.keys(s.store.snapshot().items).length,1);assert.equal(s.sync.status().unsupported,1);assert.equal(s.dav.objects.size,2);
});
test('habit projections stay one-way and completed occurrences are reflected without creating todos',async t=>{
  const s=await fixture(t);await s.store.upsert({id:'habit',item:{...item(),kind:'habit',recurrence:{frequency:'daily',until:new Date(at+86400000).toISOString()}}});
  await s.sync.tick(true);assert.equal(s.dav.objects.size,2);
  await s.sync.tick(true);assert.equal(s.dav.puts,2);assert.equal(Object.keys(s.store.snapshot().items).length,1);
  const scheduler=new ReminderScheduler(s.store,{clock:()=>at,ownerQQ:'1',botQQ:'2',send:async()=>({message_id:1})});await scheduler.tick();await scheduler.act({action:'complete',itemId:'habit'});
  await s.sync.tick(true);assert.ok([...s.dav.objects.values()].some(o=>parseEvent(o.raw).fields.title.startsWith('✓')));
});
test('a concurrent local update during outbound PUT remains queued for the next round',async t=>{
  const s=await fixture(t);await s.store.upsert({id:'racing',item:item()});const put=s.dav.put.bind(s.dav);let once=true;
  s.dav.put=async(...args)=>{await put(...args);if(once){once=false;await s.store.upsert({id:'racing',baseRevision:1,item:item({title:'更新版本'})});}};
  await s.sync.tick(true);await s.sync.tick(true);
  assert.equal(parseEvent([...s.dav.objects.values()][0].raw).fields.title,'更新版本');assert.equal(s.sync.status().conflicts.length,0);
});
test('credentials and authenticated redirects cannot leave Apple CalDAV hosts',async t=>{
  assert.throws(()=>appleURL('https://caldav.icloud.com.evil.test/'));
  assert.throws(()=>appleURL('http://caldav.icloud.com/'));
  let count=0;const dav=new ICloudDAV({username:'test',password:'secret'},{fetchImpl:async()=>{count++;return new Response(null,{status:302,headers:{location:'https://evil.test/'}});}});
  await assert.rejects(dav.get(base+'a.ics'));assert.equal(count,1);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'icloud-credentials-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'credentials');await fs.writeFile(file,JSON.stringify({username:'test@example.com',password:'aaaa-bbbb-cccc-dddd'}),{mode:0o644});
  await assert.rejects(loadCloudCredentials(file),/600/);await fs.chmod(file,0o600);assert.equal((await loadCloudCredentials(file)).username,'test@example.com');
});
test('real DAV request/response parsing accepts an empty complete report but rejects partial or malformed reports',async()=>{
  let xml='<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"></d:multistatus>';
  const calls=[];const dav=new ICloudDAV({username:'test',password:'test'},{fetchImpl:async(u,init)=>{calls.push(init);return new Response(xml,{status:207,headers:{'content-type':'application/xml'}});}});
  assert.deepEqual(await dav.list(base),[]);assert.equal(calls[0].method,'REPORT');assert.ok(calls[0].body.includes('calendar-data'));
  xml='<d:multistatus xmlns:d="DAV:"><d:response><d:href>/123/calendars/dsh/x.ics</d:href><d:status>HTTP/1.1 500 Failed</d:status></d:response></d:multistatus>';
  await assert.rejects(dav.list(base));xml='<html>login</html>';await assert.rejects(dav.list(base));
  const raw=encodeEvent({uid:'real',fields:item()}).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  xml=`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/123/calendars/dsh/x.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag><c:calendar-data>${raw}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
  const objects=await dav.list(base);assert.equal(objects.length,1);assert.equal(parseEvent(objects[0].raw).fields.title,'学习');
});

test('Apple collection metadata is ignored while actual event failures still stop the report',async()=>{
  const self='<d:response><d:href>/123/calendars/dsh/</d:href><d:propstat><d:prop><d:getetag>"collection"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><c:calendar-data/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>';
  const wrap=body=>`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`;
  let xml=wrap(self);
  const dav=new ICloudDAV({username:'test',password:'test'},{fetchImpl:async()=>new Response(xml,{status:207,headers:{'content-type':'application/xml'}})});
  assert.deepEqual(await dav.list(base),[]);
  const raw=encodeEvent({uid:'event',fields:item()});
  const event=`<d:response><d:href>/123/calendars/dsh/event.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag><c:calendar-data><![CDATA[${raw}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  xml=wrap(self+event);const rows=await dav.list(base);assert.equal(rows.length,1);assert.equal(parseEvent(rows[0].raw).fields.title,'学习');
  xml=wrap(self+self.replace('/123/calendars/dsh/','/123/calendars/dsh/broken.ics'));await assert.rejects(dav.list(base));
  xml=wrap(self.replace('404 Not Found','500 Failed'));await assert.rejects(dav.list(base));
});
test('cloud mode rejects the legacy Mac writer and exposes status through authenticated API',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'icloud-service-test-')),dav=new FakeDAV();
  const svc=await startService({dataDir:dir,port:0,timeZone:'Asia/Shanghai',onebot:{},icloud:{enabled:true,calendarUrl:base,intervalMs:10000}},
    {cloudDAV:dav,startCloudTimer:false,startTimer:false,startTransport:false,transport:{close(){}}});
  t.after(async()=>{await svc.close();await fs.rm(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${svc.port}/v1/`,token=await tokenFor(dir);
  const headers={Authorization:`Bearer ${token}`};
  assert.equal((await fetch(url+'state',{headers:{...headers,'User-Agent':'DSHCalendarSync/0.1.3'}})).status,409);
  assert.equal((await fetch(url+'icloud/status')).status,401);
  const state=await(await fetch(url+'state',{headers})).json();assert.equal(state.syncBackend,'icloud');
  assert.equal((await fetch(url+'icloud/sync',{method:'POST',headers,body:'{}'})).status,200);
});

test('save receipts distinguish local storage, verified iCloud revisions, and sync errors',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'icloud-receipt-test-')),dav=new FakeDAV();
  const svc=await startService({dataDir:dir,port:0,timeZone:'Asia/Shanghai',onebot:{},icloud:{enabled:true,calendarUrl:base,intervalMs:10000}},
    {cloudDAV:dav,startCloudTimer:false,startTimer:false,startTransport:false,transport:{close(){}}});
  t.after(async()=>{await svc.close();await fs.rm(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${svc.port}/v1/`,headers={Authorization:`Bearer ${await tokenFor(dir)}`};
  const post=async(route,input)=>(await fetch(url+route,{method:'POST',headers,body:JSON.stringify(input)})).json();
  const state=async()=>(await fetch(url+'state',{headers})).json();
  const first=await post('upsert',{id:'receipt',item:item()});assert.equal(first.sync.state,'pending');
  await post('icloud/sync',{});let current=(await state()).items[0];assert.equal(current.sync.state,'synced');assert.equal(current.sync.confirmedRevision,1);
  const changed=await post('upsert',{id:'receipt',baseRevision:1,item:item({title:'new revision'})});assert.equal(changed.sync.state,'pending');
  dav.listFailure=true;await post('icloud/sync',{});current=(await state()).items[0];assert.equal(current.sync.state,'error');assert.equal(current.title,'new revision');
  dav.listFailure=false;await post('icloud/sync',{});current=(await state()).items[0];assert.equal(current.sync.state,'synced');assert.equal(current.sync.confirmedRevision,2);
  await post('upsert',{id:'legacy-deleted',item:item()});await post('delete',{id:'legacy-deleted',baseRevision:1});
  const deleted=(await state()).items.find(i=>i.id==='legacy-deleted');assert.equal(deleted.sync.state,'unverified');
});

test('CalDAV discovers principal, home and VEVENT calendars across Apple redirects',async()=>{
  const host='https://p12-caldav.icloud.com';const calls=[];
  const response=(href,props)=>new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,{status:207,headers:{"content-type":"application/xml"}});
  const dav=new ICloudDAV({username:'test@example.com',password:'test'},{fetchImpl:async(url,init)=>{
    calls.push(url);assert.equal(init.method,'PROPFIND');
    assert.equal(new Headers(init.headers).get('authorization'),`Basic ${Buffer.from('test@example.com:test').toString('base64')}`);
    if(url==='https://caldav.icloud.com/.well-known/caldav')return new Response(null,{status:301,headers:{location:host+'/'}});
    if(url===host+'/')return response('/', '<d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal>');
    if(url===host+'/123/principal/')return response('/123/principal/','<c:calendar-home-set><d:href>/123/calendars/</d:href></c:calendar-home-set>');
    if(url===host+'/123/calendars/')return response('/123/calendars/dsh/','<d:displayname>DSH 日历助手</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>');
    if(url===base)return response('/123/calendars/dsh/','<d:supported-report-set><d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report></d:supported-report-set>');
    throw Error(`unexpected discovery URL: ${url}; called ${calls.join(', ')}`);
  }});
  assert.deepEqual(await dav.discover(),[{url:base,name:'DSH 日历助手'}]);assert.equal(calls.length,5);
});

test('global discovery can follow a China calendar home and resolve its relative calendar hrefs',async()=>{
  const global='https://caldav.icloud.com',regional='https://p231-caldav.icloud.com.cn';
  const home=regional+'/123/calendars/',calendar=home+'dsh/';const calls=[];
  const response=(href,props)=>new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,{status:207,headers:{'content-type':'application/xml'}});
  const dav=new ICloudDAV({username:'test@example.com',password:'test'},{fetchImpl:async(url,init)=>{
    calls.push(url);assert.equal(init.method,'PROPFIND');
    assert.equal(new Headers(init.headers).get('authorization'),`Basic ${Buffer.from('test@example.com:test').toString('base64')}`);
    if(url===global+'/.well-known/caldav')return new Response(null,{status:301,headers:{location:global+'/'}});
    if(url===global+'/')return response('/','<d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal>');
    if(url===global+'/123/principal/')return response('/123/principal/',`<c:calendar-home-set><d:href>${home}</d:href></c:calendar-home-set>`);
    if(url===home)return response('dsh/','<d:displayname>DSH 日历助手</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>');
    if(url===calendar)return response('/123/calendars/dsh/','<d:supported-report-set><d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report></d:supported-report-set>');
    throw Error('Unexpected discovery request');
  }});
  assert.deepEqual(await dav.discover(),[{url:calendar,name:'DSH 日历助手'}]);assert.equal(calls.length,5);
});

test('China-region redirects retain authentication while host lookalikes and unsafe URLs remain blocked',async()=>{
  for(const host of ['caldav.icloud.com.cn','p231-caldav.icloud.com.cn','p231.caldav.icloud.com.cn'])assert.equal(appleURL(`https://${host}/`),`https://${host}/`);
  const regional='https://p231-caldav.icloud.com.cn/123/calendars/dsh/item.ics';const calls=[];
  const dav=new ICloudDAV({username:'test',password:'test'},{fetchImpl:async(url,init)=>{
    calls.push(url);assert.equal(new Headers(init.headers).get('authorization'),`Basic ${Buffer.from('test:test').toString('base64')}`);
    if(url===base+'item.ics')return new Response(null,{status:307,headers:{location:regional}});
    assert.equal(url,regional);return new Response('event',{status:200,headers:{etag:'"1"'}});
  }});
  assert.equal((await dav.get(base+'item.ics')).etag,'"1"');assert.equal(calls.length,2);
  for(const url of ['https://caldav.icloud.com.cn.evil.test/','https://evil-icloud.com.cn/','https://evil.icloud.com.cn/','http://caldav.icloud.com.cn/','https://caldav.icloud.com.cn:8443/','https://user:secret@caldav.icloud.com.cn/','https://caldav.icloud.com.cn/?secret=test']) {
    await assert.rejects(dav.request(url),e=>e.code==='DAV_UNTRUSTED_URL');
  }
  assert.equal(calls.length,2);
});

test('DAV conditional writes handle empty 204 responses, conflicts and authenticated redirects',async()=>{
  const calls=[];let status=204;
  const dav=new ICloudDAV({username:'test',password:'test'},{fetchImpl:async(url,init)=>{
    calls.push({url,init});
    if(url==='https://caldav.icloud.com/redirect.ics')return new Response(null,{status:307,headers:{location:base+'item.ics'}});
    return new Response(null,{status});
  }});
  await dav.put(base+'item.ics','event',null);assert.equal(calls.at(-1).init.headers['If-None-Match'],'*');
  await dav.put(base+'item.ics','event','"2"');assert.equal(calls.at(-1).init.headers['If-Match'],'"2"');
  await dav.remove('https://caldav.icloud.com/redirect.ics','"3"');assert.equal(calls.at(-1).init.method,'DELETE');assert.equal(calls.at(-1).init.headers['If-Match'],'"3"');
  status=412;await assert.rejects(dav.put(base+'item.ics','event','"2"'),e=>e.status===409);
  await assert.rejects(dav.remove(base+'item.ics','"2"'),e=>e.status===409);
  status=404;await dav.remove(base+'item.ics','"2"');assert.equal(await dav.get(base+'item.ics'),null);
});

test('running service reloads cloud configuration without opening a second store or losing data',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'icloud-reload-test-')),dav=new FakeDAV(),file=path.join(dir,'config.json');
  const config={dataDir:'./data',port:0,timeZone:'Asia/Shanghai',onebot:{ownerQQ:'1',botQQ:'2',configFile:'./onebot.json'}};
  await fs.writeFile(file,JSON.stringify(config));
  const svc=await startService(await readConfig(file),{cloudDAV:dav,startCloudTimer:false,startTimer:false,startTransport:false,transport:{close(){}}});
  t.after(async()=>{await svc.close();await fs.rm(dir,{recursive:true,force:true});});
  const headers={Authorization:`Bearer ${await tokenFor(path.join(dir,'data'))}`},url=`http://127.0.0.1:${svc.port}/v1/`;
  assert.equal((await(await fetch(url+'state',{headers})).json()).syncBackend,'mac');
  config.icloud={enabled:true,calendarUrl:base,intervalMs:10000,credentialsFile:'./credentials.json'};
  await fs.writeFile(file,JSON.stringify(config));
  assert.equal((await fetch(url+'icloud/reload',{method:'POST',headers,body:'{}'})).status,200);
  dav.seed('reload',item());await fetch(url+'icloud/sync',{method:'POST',headers,body:'{}'});
  const state=await(await fetch(url+'state',{headers})).json();assert.equal(state.syncBackend,'icloud');assert.equal(state.items.length,1);
  config.icloud.enabled=false;await fs.writeFile(file,JSON.stringify(config));
  await fetch(url+'icloud/reload',{method:'POST',headers,body:'{}'});
  const after=await(await fetch(url+'state',{headers})).json();assert.equal(after.syncBackend,'mac');assert.equal(after.items.length,1);
});

test('setup discovery distinguishes rejected authentication without leaking response bodies or credentials',async()=>{
  const dav=new ICloudDAV({username:'private@example.com',password:'private-password'},{fetchImpl:async()=>new Response('private response',{status:401})});
  let error;try{await dav.discover();}catch(e){error=e;}
  assert.ok(error);
  const message=cloudFailureMessage(error.cloudDiagnostic??dav.diagnostic);
  assert.match(message,/Apple 拒绝了认证/);assert.match(message,/HTTP 401/);assert.match(message,/查找账户入口/);
  assert.doesNotMatch(message,/private|Basic/);
});

test('setup diagnostics separate DNS, timeouts, TLS, forbidden endpoints and DAV discovery failures',async()=>{
  for(const [code,pattern] of [['ENOTFOUND',/DNS/],['ETIMEDOUT',/超时/],['UNABLE_TO_VERIFY_LEAF_SIGNATURE',/TLS/]]) {
    const dav=new ICloudDAV({username:'private',password:'private'},{fetchImpl:async()=>{throw new TypeError('private-error',{cause:new AggregateError([Object.assign(Error('private-error'),{code})])});}});
    await assert.rejects(dav.discover());const message=cloudFailureMessage(dav.diagnostic);
    assert.match(message,pattern);assert.doesNotMatch(message,/private-error/);
  }
  const blocked=new ICloudDAV({username:'private',password:'private'},{fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://outside.invalid/private-account'}})});
  await assert.rejects(blocked.discover());assert.match(cloudFailureMessage(blocked.diagnostic),/尚未支持的地址/);
  assert.doesNotMatch(cloudFailureMessage(blocked.diagnostic),/outside|private-account/);
  const malformed=new ICloudDAV({username:'private',password:'private'},{fetchImpl:async()=>new Response('<html>private response</html>',{status:200})});
  await assert.rejects(malformed.discover());const message=cloudFailureMessage(malformed.diagnostic);
  assert.match(message,/未能解析或发现/);assert.match(message,/HTTP 200/);assert.doesNotMatch(message,/private/);
});
