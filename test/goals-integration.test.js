import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startService,tokenFor} from '../src/service.js';
import {editable} from '../src/model.js';
import {fakeAgents} from './agent-fixture.js';

const goal={title:'读完这本书',deadlineDate:'2026-10-13',dailyTitle:'阅读十页',defaultStartTime:'09:40',defaultDurationMinutes:25};
async function fixture(t,{morningEnabled=true}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calendar-goals-api-'));
  let now=Date.parse('2026-10-12T07:59:59+08:00');const digests=[],reminders=[];
  const config={dataDir:dir,port:0,timeZone:'Asia/Shanghai',repeatMs:30000,morning:{enabled:morningEnabled},onebot:{ownerQQ:'1',botQQ:'2',configFile:'/unused'}};
  const svc=await startService(config,{clock:()=>now,startTimer:false,startCloudTimer:false,startTransport:false,transport:{close(){}},
    sendHook:async batch=>{reminders.push(batch);return {message_id:reminders.length};},
    morningSendHook:async batch=>{assert.equal(await batch.markSending(),true);batch.text='今日三类事项汇总';digests.push(batch.summary);return {message_id:100+digests.length};},
    previewMorningHook:async()=>({dryRun:true,text:'preview'})});
  const file=path.join(dir,'config.json');await fs.writeFile(file,JSON.stringify({...config,port:svc.port}));
  const client=new Client({name:'goals-test',version:'1'});
  t.after(async()=>{await client.close();await svc.close();await fs.rm(dir,{recursive:true,force:true});});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('src/mcp.js'),file],stderr:'pipe'}));
  const call=async(name,args={})=>{
    const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);
  };
  return {dir,svc,digests,reminders,client,call,setNow(value){now=Date.parse(value);}};
}

test('real MCP goal tools generate before the 08:00 digest and distinguish a daily completion from the whole goal',async t=>{
  const s=await fixture(t);assert.equal((await s.client.listTools()).tools.length,6);
  for(const missing of ['deadlineDate','dailyTitle','defaultStartTime','defaultDurationMinutes']) {
    const item={...goal};delete item[missing];
    assert.equal((await s.client.callTool({name:'routine_save',arguments:{collection:'goals',item}})).isError,true);
  }
  const saved=await s.call('routine_save',{collection:'goals',id:'book',item:goal});
  assert.equal(saved.sync.state,'template');assert.equal(saved.generated.length,0);
  await s.call('routine_save',{collection:'dailyTasks',id:'stretch',item:{title:'拉伸',defaultStartTime:'10:00',defaultDurationMinutes:10}});
  await s.call('routine_save',{collection:'habits',id:'water',item:{title:'喝水',defaultTime:'18:00'}});
  await s.svc.tickRoutines();assert.equal(s.digests.length,0);
  s.setNow('2026-10-12T08:00:01+08:00');await s.svc.tickRoutines();
  assert.equal(s.digests.length,1);
  assert.equal(s.digests[0].goals[0].title,goal.dailyTitle);
  assert.equal(s.digests[0].goals[0].startTime,'09:40');
  assert.equal(s.digests[0].dailyTasks.length,1);assert.equal(s.digests[0].habits.length,1);
  let state=await s.call('calendar_list');const step=state.items.find(item=>item.goalId===saved.id);
  assert.ok(step);assert.equal(state.goals.length,1);assert.equal(state.morningDigest.today.status,'sent');
  assert.deepEqual(state.occurrences,[],'morning overview does not create early reminders');
  assert.equal(state.memory.recentHistory.at(-1).type,'morning-digest-sent');
  s.setNow('2026-10-12T08:00:31+08:00');await s.svc.tickRoutines();await s.svc.scheduler.tick();
  assert.equal(s.digests.length,1);assert.equal(s.reminders.length,0);
  const moved=await s.call('calendar_save',{id:step.id,baseRevision:step.revision,item:{...editable(step),dueAt:'2026-10-12T11:00:00+08:00'}});
  assert.equal(moved.goalId,saved.id);assert.equal(moved.goalDate,'2026-10-12');
  await s.call('calendar_reminder',{action:'complete',itemId:step.id});
  state=await s.call('calendar_list');assert.equal(state.goals[0].status,'open');
  s.setNow('2026-10-13T08:00:01+08:00');await s.svc.tickRoutines();
  assert.equal(s.digests.length,2);assert.equal(s.digests[1].goals[0].startTime,'09:40');
  assert.equal(s.digests[1].goals[0].deadlineDate,'2026-10-13');
  s.setNow('2026-10-14T08:00:01+08:00');await s.svc.tickRoutines();
  state=await s.call('calendar_list');assert.equal(state.items.filter(item=>item.goalId===saved.id).length,2);
  assert.equal(s.digests.at(-1).goals.length,0);assert.equal(state.goals[0].status,'open');
  await s.call('routine_save',{collection:'goals',id:saved.id,baseRevision:saved.revision,item:{...goal,status:'done',enabled:false}});
  state=await s.call('calendar_list');assert.equal(state.goals[0].status,'done');
  await s.call('routine_delete',{collection:'goals',id:saved.id,baseRevision:state.goals[0].revision});
  state=await s.call('calendar_list');assert.ok(state.goals[0].deletedAt);assert.equal(state.items.filter(item=>item.goalId===saved.id).length,2);
});

test('morning preview uses authenticated empty input and disabling summaries preserves goal generation',async t=>{
  const s=await fixture(t,{morningEnabled:false}),url=`http://127.0.0.1:${s.svc.port}/v1/morning-preview`;
  const headers={Authorization:`Bearer ${await tokenFor(s.dir)}`,'Content-Type':'application/json'};
  assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://example.test'},body:'{}'})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers,body:'{"send":true}'})).status,400);
  const before=s.svc.store.snapshot();
  assert.deepEqual(await (await fetch(url,{method:'POST',headers,body:'{}'})).json(),{dryRun:true,text:'preview'});
  assert.deepEqual(s.svc.store.snapshot(),before);
  await s.call('routine_save',{collection:'goals',id:'book',item:goal});
  s.setNow('2026-10-12T08:00:00+08:00');await s.svc.tickRoutines();
  assert.equal(s.digests.length,0);const state=await s.call('calendar_list');
  assert.equal(state.items.length,1);assert.equal(state.morningDigest.enabled,false);
});

test('morning DSH hook generates with no tools, persists send intent, then delivers through mock OneBot',async t=>{
  const http=await import('node:http');const {WebSocketServer}=await import('ws');const {apply}=await import('../src/plugin.js');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calendar-morning-hook-')),sent=[];
  const server=http.createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer test-token');let raw='';for await(const chunk of req)raw+=chunk;
    res.setHeader('content-type','application/json');
    if(req.url==='/get_login_info')res.end(JSON.stringify({status:'ok',retcode:0,data:{user_id:456}}));
    else if(req.url==='/send_private_msg'){sent.push(JSON.parse(raw));res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:19}}));}
    else{res.writeHead(404);res.end('{}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const wss=new WebSocketServer({server});let socket;wss.on('connection',value=>socket=value);
  const handlers=new Map(),disposers=[],ctx={...fakeAgents(async message=>{
    const summary=JSON.parse(message.content[0].text.split('可信事项数据：\n')[1]);
    return [...summary.habits,...summary.dailyTasks,...summary.goals].map(row=>`${row.startTime} ${row.title}，${row.durationMinutes} 分钟`).join('\n');
  }),on(name,fn){handlers.set(name,fn);},async parallel(name,batch){return handlers.get(name)?.(batch);},emit(){},effect(fn){disposers.push(fn());},logger:{info(){},warn(){}}};
  t.after(async()=>{for(const dispose of disposers)await dispose();wss.close();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
  await fs.writeFile(path.join(dir,'token'),'test-token');const configFile=path.join(dir,'config.json'),port=server.address().port;
  await fs.writeFile(configFile,JSON.stringify({dataDir:dir,port:0,morning:{enabled:false},onebot:{ownerQQ:'123',botQQ:'456',httpUrl:`http://127.0.0.1:${port}`,wsUrl:`ws://127.0.0.1:${port}`,httpTokenFile:'token',wsTokenFile:'token'}}));
  await apply(ctx,{configFile});
  const until=Date.now()+5000;while(!socket){assert.ok(Date.now()<until);await new Promise(resolve=>setTimeout(resolve,20));}
  let marked=0;const batch={deliveryId:'mock-overview',date:'2026-10-12',isCurrent:()=>true,async markSending(){marked++;return true;},
    summary:{date:'2026-10-12',timeZone:'Asia/Shanghai',habits:[],dailyTasks:[],goals:[{title:'阅读十页',startTime:'09:40',durationMinutes:25}]}};
  await ctx.parallel('calendar-agent/morning-due',batch);
  assert.equal(marked,1);assert.equal(sent.length,1);assert.equal(batch.result.message_id,19);
  assert.equal(ctx.calls[0].source.kind,'calendar-morning');assert.deepEqual(ctx.restrictions,[{allow:[]}]);
  assert.equal(sent[0].user_id,123);assert.match(sent[0].message[0].data.text,/09:40 阅读十页/);
  batch.markSending=async()=>false;await ctx.parallel('calendar-agent/morning-due',batch);
  assert.equal(sent.length,1);assert.equal(batch.result.skipped,true);
});
