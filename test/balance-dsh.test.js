import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDshBalanceAdapter} from '../src/balance-dsh.js';
import {Context} from '@deepseek-ai/cordis';
import {SessionStore} from '@deepseek-ai/dsh-session';

const payload={is_available:true,balance_infos:[{currency:'CNY',total_balance:'12.50',granted_balance:'2.50',topped_up_balance:'10.00'}]};
function fixture({native=false,profile={},provider=native?'deepseek-official':'deepseek',apiKey='test-api-key'}={}) {
  const listeners=new Map(),refs=new Map([['DEEPSEEK_API_KEY',apiKey]]),records=new Map(),env=new Map();
  let selection={provider,model:'deepseek-chat'};
  const root=native?profile:{providers:{[provider]:profile}};
  const entry={provider,settingsNs:native?'configured-native':'configured-pi',settingsPath:native?[]:['providers',provider]};
  const registered=[{id:provider}],entries=[entry],descriptors=[{ns:entry.settingsNs,value:root}];
  const reads=[];
  const services={
    agentDefaultModel:{currentSelection:()=>({...selection})},
    llm:{listProviders:()=>registered,listConfigurableProviders:()=>entries},
    settings:{describe:options=>{assert.deepEqual(options,{redactSecrets:true});return descriptors;}},
    credentials:{resolve:async ref=>{reads.push(['ref',ref]);return refs.has(ref)?{value:refs.get(ref),source:'file'}:undefined;},readRecord:async key=>{reads.push(['record',key]);return records.get(key);}},
    launchEnvironment:{get:name=>env.has(name)?{value:env.get(name)}:undefined}
  };
  const ctx={get:name=>services[name],on(name,fn){let set=listeners.get(name);if(!set)listeners.set(name,set=new Set());set.add(fn);return()=>set.delete(fn);}};
  const emit=(session,type,data)=>{for(const fn of listeners.get('session/event')??[])fn(session,{type,data});};
  const request=async(session,turn=1,provider=selection.provider)=>{
    emit(session,'turn/start',{turn});emit(session,'step/start',{turn,step:0});
    const config={provider,model:'deepseek-chat'};
    for(const fn of listeners.get('agent/request')??[])assert.equal(await fn({agent:{session},turn,step:0},async()=>config),config);
    session.header={config};emit(session,'request/header',{header:session.header,reason:'initial'});
  };
  const requestError=async(session,{provider=selection.provider,turn=1,status=402,code='QUOTA',message='provider failure'}={})=>{
    let delegated=0;
    for(const fn of listeners.get('agent/request-error')??[])assert.equal(await fn({agent:{session},provider,turn,step:0,failure:{status,code,message}},async()=>{delegated++;return 'delegated';}),'delegated');
    return delegated;
  };
  return {ctx,services,refs,records,env,reads,profile,registered,entries,descriptors,listeners,emit,request,requestError,
    select:next=>{selection=next;},session:id=>({id,requestHeader(){return this.header;}})};
}
const adapterFor=(t,f,options={})=>{const a=createDshBalanceAdapter(f.ctx,options);t.after(()=>a.close());return a;};
const safeCode=(code,secret='test-api-key')=>error=>{
  assert.equal(error.code,code);assert.ok(!String(error).includes(secret));assert.equal(error.cause,undefined);return true;
};

test('DSH native and pi-ai resolve the actual credential precedence and expose only an opaque target',async t=>{
  for(const native of [false,true]) {
    const f=fixture({native,profile:{apiKeyEnv:'CUSTOM_KEY',baseURL:native?'https://api.deepseek.com/anthropic':'https://api.deepseek.com/v1'}});
    f.refs.set('CUSTOM_KEY','explicit-key');f.records.set('llm-pi-ai/deepseek',{kind:'api-key',key:'different-stored-key'});
    const a=adapterFor(t,f,{fetchImpl:async(url,init)=>{
      assert.equal(url,'https://api.deepseek.com/user/balance');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
      assert.equal(init.headers.Authorization,'Bearer explicit-key');assert.equal(init.headers.Accept,'application/json');assert.ok(init.signal instanceof AbortSignal);
      return Response.json({...payload,secret:'must-not-return'});
    }});
    const target=await a.resolveTarget();assert.deepEqual(Object.keys(target).sort(),['binding','model','provider']);assert.match(target.binding,/^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(target).includes('explicit-key'));assert.deepEqual(await a.fetchBalance(target),payload);
    assert.ok(f.reads.every(([kind,ref])=>kind==='ref' && ref==='CUSTOM_KEY'));
  }
});
test('pi-ai stored key precedes ambient auth and native default uses the launch environment endpoint',async t=>{
  const f=fixture();f.records.set('llm-pi-ai/deepseek',{kind:'api-key',key:'stored-key'});
  const a=adapterFor(t,f,{fetchImpl:async(url,init)=>{assert.equal(init.headers.Authorization,'Bearer stored-key');return Response.json(payload);}});
  const target=await a.resolveTarget();await a.fetchBalance(target);assert.ok(f.reads.every(([kind])=>kind==='record'));
  const n=fixture({native:true});n.env.set('DEEPSEEK_BASE_URL','https://example.test/anthropic');
  assert.equal(await adapterFor(t,n).resolveTarget(),null);assert.equal(n.reads.length,0);
  n.env.set('DEEPSEEK_BASE_URL','https://api.deepseek.com/anthropic');assert.ok(await adapterFor(t,n).resolveTarget());
});
test('strict official endpoint validation precedes credential reads and never sends keys to custom servers',async t=>{
  const f=fixture(),a=adapterFor(t,f,{fetchImpl:()=>{throw Error('must not fetch');}});
  for(const baseURL of ['http://api.deepseek.com','https://api.deepseek.com.evil.test','https://user:secret@api.deepseek.com',
    'https://api.deepseek.com:443','https://api.deepseek.com:8443','https://api.deepseek.com/v1?x=1','https://api.deepseek.com/#fragment',
    'https://api.deepseek.com/other','https://api.deepseek.com/x/../v1','https://api.deepseek.com//v1','https://api.deepseek.com/%76%31']) {
    f.profile.baseURL=baseURL;assert.equal(await a.resolveTarget(),null);
  }
  assert.equal(f.reads.length,0);
  for(const baseURL of ['https://api.deepseek.com','https://api.deepseek.com/','https://api.deepseek.com/v1','https://api.deepseek.com/v1/','https://api.deepseek.com/anthropic']) {
    f.profile.baseURL=baseURL;assert.ok(await a.resolveTarget());
  }
  f.profile.headers={Authorization:'other-key'};assert.equal(await a.resolveTarget(),null);
});
test('missing refs do not fall back to other accounts, grant records are unsupported, and credentials remain optional',async t=>{
  const f=fixture({profile:{apiKeyEnv:'MISSING_KEY'}});f.records.set('llm-pi-ai/deepseek',{kind:'api-key',key:'wrong-key'});
  const a=adapterFor(t,f);assert.equal(await a.resolveTarget(),null);
  f.profile.apiKeyEnv='BAD\nREF';assert.equal(await a.resolveTarget(),null);
  delete f.profile.apiKeyEnv;f.records.set('llm-pi-ai/deepseek',{kind:'grant',payload:{access:'oauth-secret'}});assert.equal(await a.resolveTarget(),null);
  f.records.clear();delete f.services.credentials;f.env.set('DEEPSEEK_API_KEY','launch-only-key');assert.ok(await a.resolveTarget());
  f.env.set('DEEPSEEK_API_KEY','bad\nheader');assert.equal(await a.resolveTarget(),null);
});
test('account changes invalidate old targets before request and discard stale responses after request',async t=>{
  const f=fixture();let calls=0,rotate=false;
  const a=adapterFor(t,f,{fetchImpl:async()=>{calls++;if(rotate)f.refs.set('DEEPSEEK_API_KEY','third-account');return Response.json(payload);}});
  const first=await a.resolveTarget();f.refs.set('DEEPSEEK_API_KEY','second-account');
  await assert.rejects(a.fetchBalance(first),safeCode('BALANCE_ACCOUNT_CHANGED'));assert.equal(calls,0);
  const second=await a.resolveTarget();assert.notEqual(second.binding,first.binding);rotate=true;
  await assert.rejects(a.fetchBalance(second),safeCode('BALANCE_ACCOUNT_CHANGED'));assert.equal(calls,1);
  await assert.rejects(a.fetchBalance({...second}),safeCode('BALANCE_TARGET_UNAVAILABLE'));
});
test('HTTP errors, redirect responses and arbitrary transport errors never expose body or credentials',async t=>{
  const f=fixture();let response;
  const a=adapterFor(t,f,{fetchImpl:async()=>{if(response instanceof Error)throw response;return response;}}),target=await a.resolveTarget();
  for(const status of [301,302,307,308]) {
    response=new Response('test-api-key',{status,headers:{location:'https://evil.test'}});
    await assert.rejects(a.fetchBalance(target),safeCode('BALANCE_REDIRECT'));
  }
  for(const status of [401,402,403,500]){
    response=new Response('test-api-key',{status});await assert.rejects(a.fetchBalance(target),safeCode(`BALANCE_HTTP_${status}`));
  }
  response=Object.assign(Error('test-api-key'),{code:'BALANCE_FORGED'});
  await assert.rejects(a.fetchBalance(target),safeCode('BALANCE_NETWORK'));
});
test('response validation bounds content length, streamed bytes and accepted official fields',async t=>{
  const f=fixture();let response;
  const a=adapterFor(t,f,{maxBytes:512,fetchImpl:async()=>response}),target=await a.resolveTarget();
  response=new Response('{}',{headers:{'content-length':'513'}});await assert.rejects(a.fetchBalance(target),safeCode('BALANCE_RESPONSE_SIZE'));
  response=new Response('x'.repeat(513));await assert.rejects(a.fetchBalance(target),safeCode('BALANCE_RESPONSE_SIZE'));
  for(const data of [{is_available:'true',balance_infos:[]},{is_available:true,balance_infos:[{currency:'CNY',total_balance:'NaN'}]},
    {is_available:true,balance_infos:[{...payload.balance_infos[0],currency:'EUR'}]},
    {is_available:true,balance_infos:[payload.balance_infos[0],payload.balance_infos[0]]}]) {
    response=Response.json(data);await assert.rejects(a.fetchBalance(target),safeCode('BALANCE_RESPONSE'));
  }
  response=new Response('test-api-key');await assert.rejects(a.fetchBalance(target),safeCode('BALANCE_RESPONSE'));
  response=Response.json({is_available:false,balance_infos:[]});assert.deepEqual(await a.fetchBalance(target),{is_available:false,balance_infos:[]});
});
test('timeouts include stalled fetch and stalled response body; close aborts active queries',async t=>{
  const f=fixture();let body=false;
  const a=adapterFor(t,f,{timeoutMs:20,fetchImpl:()=>body?new Response(new ReadableStream({start(){}})):new Promise(()=>{})});
  const target=await a.resolveTarget();await assert.rejects(a.fetchBalance(target),safeCode('BALANCE_TIMEOUT'));
  body=true;await assert.rejects(a.fetchBalance(target),safeCode('BALANCE_TIMEOUT'));
  const pending=a.fetchBalance(target);a.close();await assert.rejects(pending,error=>['BALANCE_TIMEOUT','BALANCE_TARGET_UNAVAILABLE'].includes(error.code));
});
test('global DSH lifecycle monitoring covers chat and reminder turns, deduplicates 402 and delegates retries',async t=>{
  const f=fixture(),a=adapterFor(t,f),turns=[],insufficient=[];
  a.subscribe({onTurnEnd:x=>turns.push(x),onInsufficient:x=>insufficient.push(x)});
  const chat=f.session('qq-chat'),reminder=f.session('calendar-reminder-delivery');
  await f.request(chat);f.emit(chat,'turn/end',{turn:1,reason:{kind:'completed'}});
  await f.request(reminder);assert.equal(await f.requestError(reminder),1);
  f.emit(reminder,'turn/end',{turn:1,reason:{kind:'error',error:{status:402,code:'QUOTA',message:'private provider detail'}}});
  await a.whenIdle();assert.equal(turns.length,2);assert.equal(turns[0].successful,true);assert.equal(turns[1].successful,false);assert.equal(insufficient.length,1);
  for(const value of [...turns,...insufficient]){assert.equal(value.provider,'deepseek');assert.ok(value.binding);assert.ok(!JSON.stringify(value).includes('private'));}
});
test('provider-specific 402 filtering ignores user text, model text, tool errors and other provider failures',async t=>{
  const f=fixture(),a=adapterFor(t,f),insufficient=[],turns=[];
  a.subscribe({onInsufficient:x=>insufficient.push(x),onTurnEnd:x=>turns.push(x)});
  const chat=f.session('chat');await f.request(chat);
  for(const type of ['user/message','assistant/message','tool/result','error'])f.emit(chat,type,{message:{content:[{type:'text',text:'HTTP 402 insufficient balance'}]},status:402,error:{status:402}});
  await f.requestError(chat,{provider:'openai',status:402});await f.requestError(chat,{status:500,message:'402 insufficient balance'});
  f.emit(chat,'turn/end',{turn:1,reason:{kind:'error',error:{code:'UNKNOWN',message:'402 payment required'}}});
  const other=f.session('other-route');await f.request(other,1,'openai');await f.requestError(other,{provider:'openai'});
  f.emit(other,'turn/end',{turn:1,reason:{kind:'error',error:{status:402,code:'QUOTA'}}});
  await a.whenIdle();assert.equal(insufficient.length,0);assert.equal(turns.length,1);
});
test('provider override follows only the explicitly selected official route and changed bindings suppress late errors',async t=>{
  const f=fixture({provider:'configured-deepseek',profile:{baseURL:'https://api.deepseek.com/v1',apiKeyEnv:'DEEPSEEK_API_KEY'}});
  f.select({provider:'openai',model:'other'});
  const a=adapterFor(t,f,{providerId:'configured-deepseek'}),seen=[];
  a.subscribe({onInsufficient:x=>seen.push(x)});
  const s=f.session('explicit-route');await f.request(s,1,'configured-deepseek');await f.requestError(s,{provider:'configured-deepseek'});await a.whenIdle();assert.equal(seen.length,1);
  await f.request(s,2,'configured-deepseek');f.refs.set('DEEPSEEK_API_KEY','new-account');
  await f.requestError(s,{provider:'configured-deepseek',turn:2});f.emit(s,'turn/end',{turn:2,reason:{kind:'error',error:{status:402}}});
  await a.whenIdle();assert.equal(seen.length,1);
});
test('reused headers identify later turns but pre-step errors and duplicate turn-end notifications do not trigger monitoring',async t=>{
  const f=fixture(),a=adapterFor(t,f),seen=[];a.subscribe({onTurnEnd:x=>seen.push(x)});
  const s=f.session('same-header');await f.request(s);f.emit(s,'turn/end',{turn:1,reason:{kind:'completed'}});
  f.emit(s,'turn/start',{turn:2});f.emit(s,'step/start',{turn:2,step:0});
  f.emit(s,'turn/end',{turn:2,reason:{kind:'completed'}});f.emit(s,'turn/end',{turn:2,reason:{kind:'completed'}});
  f.emit(s,'turn/start',{turn:3});f.emit(s,'turn/end',{turn:3,reason:{kind:'error',error:{status:402}}});
  await a.whenIdle();assert.equal(seen.length,2);
});
test('credential and callback failures cannot veto DSH requests and disposal unregisters all hooks',async t=>{
  const f=fixture(),a=adapterFor(t,f);let calls=0;
  const off=a.subscribe({onTurnEnd:()=>{calls++;throw Error('consumer failed');},onInsufficient:()=>{throw Error('consumer failed');}});
  const s=f.session('isolation');await f.request(s);f.emit(s,'turn/end',{turn:1,reason:{kind:'completed'}});await a.whenIdle();assert.equal(calls,1);
  f.services.credentials.resolve=async()=>{throw Error('do not expose this credential error');};
  assert.equal(await a.resolveTarget(),null);await f.request(s,2);await f.requestError(s,{turn:2});await a.whenIdle();
  off();for(const value of f.listeners.values())assert.equal(value.size,0);
});
test('a stalled credential service times out safely without indefinitely blocking the model request',async t=>{
  const f=fixture(),a=adapterFor(t,f,{timeoutMs:20});
  f.services.credentials.resolve=()=>new Promise(()=>{});
  assert.equal(await a.resolveTarget(),null);a.subscribe();
  await f.request(f.session('credential-timeout'));
});
test('installed DSH SessionStore publishes the real header and turn-end shapes to the global subscriber',async t=>{
  const root=new Context(),store=new SessionStore(root),f=fixture(),seen=[];
  const ctx={get:f.ctx.get,on:root.on.bind(root)},a=createDshBalanceAdapter(ctx);
  t.after(async()=>{a.close();await root.fiber.dispose();});
  a.subscribe({onTurnEnd:value=>seen.push(value)});
  for(const id of ['real-qq-session','calendar-reminder-real-session']) {
    const session=store.create(id);
    session.append('turn/start',{turn:1});session.append('step/start',{turn:1,step:0});
    session.append('request/header',{header:{config:{provider:'deepseek',model:'deepseek-chat'}},reason:'initial'});
    session.append('step/end',{turn:1,step:0});session.append('turn/end',{turn:1,reason:{kind:'completed'}});
  }
  await a.whenIdle();assert.equal(seen.length,2);assert.ok(seen.every(value=>value.provider==='deepseek' && value.successful));
});
