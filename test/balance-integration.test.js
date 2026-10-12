import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readConfig,balanceDefaults} from '../src/config.js';
import {startService,tokenFor} from '../src/service.js';
import {formatBalance} from '../src/balance-format.js';
import {createBalanceRuntime,sendBalanceNotification} from '../src/balance-runtime.js';
import {BalanceMonitor} from '../src/balance-monitor.js';
import {OneBot} from '../src/onebot.js';

async function directory(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calendar-balance-integration-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;
}
const sample={is_available:true,balance_infos:[{currency:'CNY',total_balance:'3.40',granted_balance:'0.00',topped_up_balance:'3.40'}]};
test('balance configuration is opt-in with explicit per-currency thresholds',async t=>{
  const dir=await directory(t),file=path.join(dir,'config.json');
  const original={dataDir:dir,onebot:{ownerQQ:'123',botQQ:'456',configFile:'/unused'}};
  await fs.writeFile(file,JSON.stringify(original));
  assert.deepEqual((await readConfig(file)).balance,balanceDefaults);
  await fs.writeFile(file,JSON.stringify({...original,balance:{enabled:true}}));
  assert.deepEqual((await readConfig(file)).balance,{...balanceDefaults,enabled:true});
  await fs.writeFile(file,JSON.stringify({...original,balance:{enabled:true,thresholds:{CNY:{low:'5',critical:'1'}}}}));
  assert.deepEqual((await readConfig(file)).balance.thresholds,{CNY:{low:'5',critical:'1'}});
  for(const balance of [{enabled:true,thresholds:{CNY:{low:'1',critical:'5'}}},{enabled:true,thresholds:{CNY:{low:'-5',critical:'1'}}},{enabled:true,apiKey:'do-not-store-keys-here'}]) {
    await fs.writeFile(file,JSON.stringify({...original,balance}));await assert.rejects(readConfig(file));
  }
});
test('authenticated balance API refreshes without a calendar transaction, MCP or iCloud call',async t=>{
  const dir=await directory(t),calls=[];
  let status={enabled:true,level:'unknown',balance:null,lastSuccessAt:null,lastError:null};
  const balance={status:()=>status,async refresh(input){calls.push(input);status={...status,level:'low',balance:sample,lastSuccessAt:'2026-10-12T01:23:45Z'};}};
  const config={dataDir:dir,port:0,timeZone:'Asia/Shanghai',repeatMs:30000,onebot:{},balance:{enabled:true}};
  const service=await startService(config,{startTimer:false,startCloudTimer:false,startTransport:false,transport:{close(){}},balance});
  t.after(()=>service.close());
  const base=`http://127.0.0.1:${service.port}/v1/`,headers={Authorization:`Bearer ${await tokenFor(dir)}`,'Content-Type':'application/json'};
  const before=service.store.snapshot();
  assert.equal((await fetch(base+'balance/status')).status,401);
  assert.equal((await fetch(base+'balance/refresh',{method:'POST',headers:{...headers,Origin:'https://untrusted.invalid'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'balance/refresh',{method:'POST',headers,body:'{"apiKey":"never-accepted"}'})).status,400);
  const result=await (await fetch(base+'balance/refresh',{method:'POST',headers,body:'{}'})).json();
  assert.deepEqual(calls,[{reason:'manual',notify:false}]);assert.match(result.text,/3.40 元/);assert.match(result.text,/09:23:45/);
  assert.deepEqual(service.store.snapshot(),before);
  await fetch(base+'balance/status',{headers});assert.equal(calls.length,1,'status only reads cache');
  status={...status,lastError:'余额查询暂不可用'};
  const cached=await (await fetch(base+'balance/status',{headers})).json();
  assert.match(cached.text,/缓存不代表当前余额/);assert.match(cached.text,/3.40/);assert.doesNotMatch(cached.text,/接口显示账户可继续调用/);
  config.balance.enabled=false;
  assert.equal((await fetch(base+'balance/refresh',{method:'POST',headers,body:'{}'})).status,503);
});
test('formatter separates unavailable, stale cache and a confirmed 402 without inventing zero',()=>{
  assert.match(formatBalance({enabled:false}),/尚未开启/);
  const failed=formatBalance({enabled:true,balance:null,lastError:'failure'});
  assert.match(failed,/暂不可查询/);assert.doesNotMatch(failed,/余额：0/);
  const noQuota=formatBalance({enabled:true,balance:sample,confirmedInsufficient:true,lastSuccessAt:'2026-10-12T01:23:45Z'});
  assert.match(noQuota,/已确认额度不足/);assert.doesNotMatch(noQuota,/接口显示账户可继续调用/);
});
test('runtime wires startup, turn completion and 402 independently and closes all hooks',async()=>{
  const calls=[],warnings=[];let callbacks,fetchBalance,disposed=false;
  const ctx={logger:{warn:x=>warnings.push(x)}};
  const adapterFactory=()=>({
    async resolveTarget(){return {binding:'test-binding',provider:'deepseek'};},
    async fetchBalance(target){assert.equal(target.binding,'test-binding');calls.push('fetch');return sample;},
    subscribe(value){callbacks=value;return ()=>{disposed=true;};},close(){calls.push('adapter-close');}
  });
  const monitorFactory=(dir,config,options)=>{
    fetchBalance=options.fetchBalance;
    return {async open(){calls.push('open');},async bindAccount(){},status(){return {balance:sample};},async refresh(input){calls.push(input);},async tick(){calls.push('tick');},async afterTurn(event){calls.push({turn:event});},async insufficient(event){calls.push({error:event});},async close(){calls.push('monitor-close');}};
  };
  const runtime=await createBalanceRuntime(ctx,{...balanceDefaults,enabled:true},'/unused',{send:async()=>{},adapterFactory,monitorFactory,timerMs:60000});
  assert.equal(runtime.status().enabled,true);runtime.start();runtime.start();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.slice(0,2),['open',{reason:'startup'}]);
  const event={provider:'deepseek',binding:'test-binding',successful:true};
  callbacks.onTurnEnd(event);callbacks.onInsufficient(event);
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(calls.some(v=>v?.turn===event));assert.ok(calls.some(v=>v?.error===event));
  assert.equal(runtime.status().activity.observedTurns,1);assert.equal(runtime.status().activity.observedInsufficient,1);
  assert.deepEqual(await fetchBalance(),{...sample,binding:'test-binding'});
  await runtime.close();assert.ok(disposed);const count=calls.length;
  callbacks.onTurnEnd(event);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,count);
  assert.deepEqual(warnings,[]);
});
test('a damaged balance store does not prevent calendar runtime and disabled mode resolves no credentials',async()=>{
  const ctx={logger:{warn(){}}};let created=0;
  const disabled=await createBalanceRuntime(ctx,{enabled:false},'/unused',{adapterFactory(){created++;throw Error('should not resolve');}});
  disabled.start();assert.equal(disabled.status().enabled,false);assert.equal(created,0);await disabled.close();
  const failed=await createBalanceRuntime(ctx,{enabled:true},'/unused',{
    adapterFactory:()=>({close(){}}),monitorFactory:()=>({async open(){throw Error('private corrupt content');},async close(){}})
  });
  failed.start();assert.match(failed.status().lastError,/初始化失败/);assert.doesNotMatch(JSON.stringify(failed.status()),/private corrupt/);
  await assert.rejects(failed.refresh({reason:'manual'}),/暂不可用/);await failed.close();
});
test('real balance state connects startup, manual HTTP and an active-turn recovery without calendar writes',async t=>{
  const dir=await directory(t),sent=[];let callbacks,now=Date.parse('2026-10-12T09:00:00+08:00'),value=sample,queries=0;
  const ctx={logger:{warn(){}}},settings={...balanceDefaults,enabled:true};
  const adapterFactory=()=>({async resolveTarget(){return {binding:'account-fixture',provider:'deepseek'};},
    async fetchBalance(){queries++;return value;},subscribe(value){callbacks=value;return ()=>{};},close(){}});
  const runtime=await createBalanceRuntime(ctx,settings,dir,{adapterFactory,send:async text=>{sent.push(text);},
    monitorFactory:(dir,config,options)=>new BalanceMonitor(dir,config,{...options,clock:()=>now}),timerMs:60000});
  const service=await startService({dataDir:dir,port:0,timeZone:'Asia/Shanghai',onebot:{},balance:settings},
    {balance:runtime,startTimer:false,startCloudTimer:false,startTransport:false,transport:{close(){}}});
  t.after(async()=>{await runtime.close();await service.close();});
  const before=service.store.snapshot(),waitFor=async predicate=>{
    const until=Date.now()+3000;
    while(!predicate()){if(Date.now()>until)throw Error('balance integration timed out');await new Promise(resolve=>setTimeout(resolve,10));}
  };
  runtime.start();await waitFor(()=>sent.length===1 && !runtime.status().running);
  assert.match(sent[0],/偏低/);assert.equal(queries,1);
  const headers={Authorization:`Bearer ${await tokenFor(dir)}`,'Content-Type':'application/json'};
  value={is_available:true,balance_infos:[{currency:'CNY',total_balance:'20.00',granted_balance:'0.00',topped_up_balance:'20.00'}]};
  const response=await fetch(`http://127.0.0.1:${service.port}/v1/balance/refresh`,{method:'POST',headers,body:'{}'});
  assert.equal(response.status,200);assert.match((await response.json()).text,/20.00 元/);assert.equal(sent.length,1,'manual reply does not separately send a new notification');
  now+=600001;callbacks.onTurnEnd({binding:'account-fixture',provider:'deepseek',successful:true});
  await waitFor(()=>sent.length===2 && !runtime.status().running);
  assert.match(sent[1],/恢复正常/);assert.equal(queries,3);
  assert.deepEqual(service.store.snapshot(),before,'balance operations never modify calendar data');
  const persisted=await fs.readFile(path.join(dir,'balance.json'),'utf8');assert.doesNotMatch(persisted,/apiKey|Authorization/);
});
test('account switch clears old balance before a failed query and unavailable targets clear old cache',async t=>{
  const dir=await directory(t);let binding='account-a';
  const runtime=await createBalanceRuntime({logger:{warn(){}}},{...balanceDefaults,enabled:true},dir,{
    send:async()=>{},adapterFactory:()=>({async resolveTarget(){return binding?{binding,provider:'deepseek'}:null;},
      async fetchBalance(){if(binding!=='account-a')throw Error('authentication failed');return sample;},close(){}})
  });
  t.after(()=>runtime.close());
  await runtime.refresh({reason:'manual',notify:false});assert.equal(runtime.status().balance.balance_infos[0].total_balance,'3.40');
  binding='account-b';await runtime.refresh({reason:'manual',notify:false});
  assert.equal(runtime.status().balance,null);assert.ok(runtime.status().lastError);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'balance.json'),'utf8')).binding,'account-b');
  binding=null;await runtime.refresh({reason:'manual',notify:false});assert.equal(runtime.status().balance,null);
});
test('shutdown while QQ identity check is pending cancels the real balance send adapter',async t=>{
  const dir=await directory(t);let entered,release,sent=0;
  const started=new Promise(resolve=>entered=resolve),blocked=new Promise(resolve=>release=resolve);
  const bot=new OneBot({botQQ:'456',ownerQQ:'123'},()=>{});bot.connected=true;
  bot.call=async action=>{
    if(action==='get_login_info'){entered();await blocked;return {user_id:456};}
    sent++;return {message_id:1};
  };
  const runtime=await createBalanceRuntime({logger:{warn(){}}},{...balanceDefaults,enabled:true},dir,{
    send:(text,options)=>sendBalanceNotification(bot,text,options),
    adapterFactory:()=>({async resolveTarget(){return {binding:'account-a',provider:'deepseek'};},async fetchBalance(){return sample;},subscribe(){return ()=>{};},close(){}})
  });
  runtime.start();await started;await runtime.close();release();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(sent,0);
});
