import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startService,tokenFor} from '../src/service.js';
import {editable} from '../src/model.js';

async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calendar-routines-api-'));
  let now=Date.parse('2026-10-12T07:59:59+08:00');const sent=[];
  const config={dataDir:dir,port:0,timeZone:'Asia/Shanghai',repeatMs:30000,onebot:{ownerQQ:'1',botQQ:'2',configFile:'/unused'}};
  const svc=await startService(config,{clock:()=>now,startTimer:false,startCloudTimer:false,startTransport:false,transport:{close(){}},sendHook:async batch=>{sent.push(batch);return {message_id:sent.length};}});
  const file=path.join(dir,'config.json');await fs.writeFile(file,JSON.stringify({...config,port:svc.port}));
  const client=new Client({name:'routine-test',version:'1'});
  t.after(async()=>{await client.close();await svc.close();await fs.rm(dir,{recursive:true,force:true});});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('src/mcp.js'),file],stderr:'pipe'}));
  const call=async(name,args={})=>{
    const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);
  };
  return {dir,svc,sent,client,call,setNow(v){now=typeof v==='string'?Date.parse(v):v;},now:()=>now};
}
test('MCP routines require parameters, generate today at 08:00, and separate habits from calendar',async t=>{
  const s=await fixture(t);
  const incomplete=await s.client.callTool({name:'routine_save',arguments:{collection:'dailyTasks',item:{title:'阅读',defaultStartTime:'09:00'}}});
  assert.equal(incomplete.isError,true);
  const daily=await s.call('routine_save',{collection:'dailyTasks',id:'reading',item:{title:'阅读',defaultStartTime:'09:00',defaultDurationMinutes:45}});
  assert.equal(daily.generated.length,0);
  const habit=await s.call('routine_save',{collection:'habits',id:'water',item:{title:'喝水',defaultTime:'08:00'}});
  assert.equal(habit.sync.state,'local-only');
  let state=await s.call('calendar_list');assert.equal(state.items.length,0);assert.equal(state.dailyTasks.length,1);assert.equal(state.habits.length,1);
  s.setNow('2026-10-12T08:00:00+08:00');
  state=await s.call('calendar_list');assert.equal(state.items.length,1);assert.equal(state.items[0].durationMinutes,45);
  assert.equal(state.items[0].dueAtLocal,'2026-10-12T09:00:00.000+08:00');assert.equal(state.items[0].dailyTaskId,daily.id);
  await s.call('calendar_list');assert.equal((await s.call('calendar_list')).items.length,1);
  const projections=await (await fetch(`http://127.0.0.1:${s.svc.port}/v1/projections`,{headers:{Authorization:`Bearer ${await tokenFor(s.dir)}`}})).json();
  assert.deepEqual(projections.events,[]);
  await s.call('routine_delete',{collection:'dailyTasks',id:daily.id,baseRevision:daily.revision});
  state=await s.call('calendar_list');assert.equal(state.items.length,1);assert.ok(state.dailyTasks[0].deletedAt);
});
test('habit hook repeats until reply, completes only the occurrence, and starts again next day',async t=>{
  const s=await fixture(t);await s.call('routine_save',{collection:'habits',id:'water',item:{title:'喝水',defaultTime:'08:00'}});
  await s.svc.scheduler.tick();assert.equal(s.sent.length,0);
  s.setNow('2026-10-12T08:00:00+08:00');await s.svc.scheduler.tick();assert.equal(s.sent.length,1);
  s.setNow(s.now()+30000);await s.svc.scheduler.tick();assert.equal(s.sent.length,2);
  const messageAt=s.now()-2000;
  await s.svc.scheduler.receive({post_type:'message',message_type:'private',self_id:2,user_id:1,message_id:44,time:messageAt/1000,message:[{type:'text',data:{text:'收到'}}]});
  s.setNow(s.now()+30000);await s.svc.scheduler.tick();assert.equal(s.sent.length,2);
  let state=await s.call('calendar_list');assert.equal(state.habits[0].status,'open');assert.equal(state.latestUserReply.at,new Date(messageAt).toISOString());
  const done=await s.call('calendar_reminder',{action:'complete',itemId:'water'});assert.equal(done.occurrence.state,'done');assert.equal(done.item.status,'open');
  s.setNow('2026-10-13T07:59:59+08:00');await s.svc.scheduler.tick();assert.equal(s.sent.length,2);
  s.setNow('2026-10-13T08:00:00+08:00');await s.svc.scheduler.tick();assert.equal(s.sent.length,3);
  await s.call('routine_delete',{collection:'habits',id:'water',baseRevision:state.habits[0].revision});
  s.setNow(s.now()+30000);await s.svc.scheduler.tick();assert.equal(s.sent.length,3);
});
test('existing update API records actual reply start and adjusted finish without renewed nagging',async t=>{
  const s=await fixture(t);const saved=await s.call('calendar_save',{id:'study',item:{title:'学习',dueAt:'2026-10-12T07:50:00+08:00',durationMinutes:60}});
  await s.svc.scheduler.tick();assert.equal(s.sent.length,1);
  const at=Date.parse('2026-10-12T07:59:42+08:00');
  await s.svc.scheduler.receive({post_type:'message',message_type:'private',self_id:2,user_id:1,message_id:45,time:at/1000,message:[{type:'text',data:{text:'开始学习了'}}]});
  let state=await s.call('calendar_list');assert.equal(state.items[0].dueAt,saved.dueAt,'reply hook must not infer start');
  const started=await s.call('calendar_save',{id:saved.id,baseRevision:saved.revision,item:{...editable(saved),dueAt:state.latestUserReply.at,enabled:false}});
  assert.equal(started.durationMinutes,60);assert.equal(started.dueAt,new Date(at).toISOString());
  s.setNow('2026-10-12T08:05:00+08:00');await s.svc.scheduler.tick();assert.equal(s.sent.length,1);
  const extended=await s.call('calendar_save',{id:saved.id,baseRevision:started.revision,item:{...editable(started),durationMinutes:90}});
  const finishAt=Date.parse('2026-10-12T08:20:05+08:00');s.setNow(finishAt+10000);
  await s.svc.scheduler.receive({post_type:'message',message_type:'private',self_id:2,user_id:1,message_id:46,time:finishAt/1000,message:[{type:'text',data:{text:'提前做完了'}}]});
  state=await s.call('calendar_list');
  const finished=await s.call('calendar_save',{id:saved.id,baseRevision:extended.revision,item:{...editable(extended),status:'done',durationMinutes:Math.max(1,Math.ceil((Date.parse(state.latestUserReply.at)-Date.parse(extended.dueAt))/60000))}});
  assert.equal(finished.dueAt,started.dueAt);assert.equal(finished.durationMinutes,21);assert.equal(finished.status,'done');
  await s.svc.scheduler.tick();assert.equal(s.sent.length,1);
});
