import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BalanceMonitor} from '../src/balance-monitor.js';

const hour=3600000,day=24*hour,minute=60000;
const accountA='a'.repeat(64),accountB='b'.repeat(64);
const balance=(amount='10.00',extra={})=>({is_available:true,balance_infos:[{currency:'CNY',total_balance:amount,granted_balance:'0.00',topped_up_balance:amount}],...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function fixture(t,options={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'balance-monitor-'));
  let now=Date.parse('2026-10-12T00:00:00Z'),response=balance(),failure=null,fetches=0;
  const sent=[],logs=[],instances=[];
  const create=async(overrides={})=>{
    const monitor=new BalanceMonitor(directory,options.config??{},{clock:()=>now,
      fetchBalance:async args=>{fetches++;if(options.fetchBalance)return options.fetchBalance(args);if(failure)throw failure;return response;},
      send:async(text,args)=>{if(options.send)await options.send(text,args);sent.push(text);},log:text=>logs.push(text),...overrides});
    instances.push(monitor);return monitor.open();
  };
  const monitor=await create();
  t.after(async()=>{await Promise.all(instances.map(instance=>instance.close()));await fs.rm(directory,{recursive:true,force:true});});
  return {directory,monitor,create,sent,logs,fetches:()=>fetches,now:()=>now,advance:ms=>{now+=ms;},respond:value=>{response=value;failure=null;},fail:value=>{failure=value;}};
}
async function settled(monitor) {await monitor.queryPromise;await monitor.notifyPromise;await monitor.tail;}
async function waitFor(predicate) {
  for(let attempt=0;attempt<1000;attempt++) {if(predicate())return;await new Promise(resolve=>setTimeout(resolve,1));}
  throw Error('Timed out waiting for test barrier');
}

test('startup, hourly fallback and active ten-minute checks share cached successful query time',async t=>{
  const s=await fixture(t);await s.monitor.refresh({reason:'startup'});
  assert.equal(s.fetches(),1);assert.equal(s.monitor.status().level,'normal');assert.equal(s.sent.length,0);
  s.advance(10*minute-1);await s.monitor.afterTurn();await s.monitor.tick();assert.equal(s.fetches(),1);
  s.advance(1);await s.monitor.afterTurn();assert.equal(s.fetches(),2);
  s.advance(hour-1);await s.monitor.tick();assert.equal(s.fetches(),2);
  s.advance(1);await s.monitor.tick();assert.equal(s.fetches(),3);
  assert.equal(s.monitor.status().lastSuccessAt,new Date(s.now()).toISOString());
  assert.equal(s.monitor.status().nextCheckAt,new Date(s.now()+hour).toISOString());
});

test('decimal thresholds, escalation, same-level cooldown and recovery do not spam',async t=>{
  const s=await fixture(t);s.respond(balance('5.00'));await s.monitor.refresh();assert.equal(s.monitor.status().level,'low');assert.equal(s.sent.length,1);
  s.respond(balance('4.99'));await s.monitor.refresh();assert.equal(s.sent.length,1);
  s.respond(balance('1.00'));await s.monitor.refresh();assert.equal(s.monitor.status().level,'critical');assert.equal(s.sent.length,2);
  s.respond(balance('0.00',{is_available:false}));await s.monitor.refresh();assert.equal(s.monitor.status().level,'exhausted');assert.equal(s.sent.length,3);
  s.advance(day-1);await s.monitor.refresh();assert.equal(s.sent.length,3);
  s.advance(1);await s.monitor.refresh();assert.equal(s.sent.length,4);
  s.respond(balance('5.000000000000000001'));await s.monitor.refresh();assert.equal(s.monitor.status().level,'normal');assert.equal(s.sent.length,5);assert.match(s.sent.at(-1),/恢复正常/);
  await s.monitor.refresh();assert.equal(s.sent.length,5);
  s.respond(balance('5.00'));await s.monitor.refresh();assert.equal(s.sent.length,6,'a new decline after recovery alerts immediately');
});

test('escalating again after partial recovery alerts immediately despite an earlier same-level notice',async t=>{
  const s=await fixture(t);s.respond(balance('0.50'));await s.monitor.refresh();assert.equal(s.sent.length,1);
  s.respond(balance('4.00'));await s.monitor.refresh();assert.equal(s.sent.length,1);
  s.respond(balance('0.50'));await s.monitor.refresh();assert.equal(s.sent.length,2);
});

test('unknown currencies stay separate and cannot masquerade as a configured safe balance',async t=>{
  const s=await fixture(t);
  s.respond({is_available:true,balance_infos:[{currency:'USD',total_balance:'200.00',granted_balance:'20.00',topped_up_balance:'180.00'}],secret:'NEVER_PERSIST'});
  await s.monitor.refresh();assert.equal(s.monitor.status().level,'unknown');assert.equal(s.sent.length,0);
  assert.equal(s.monitor.status().balance.balance_infos[0].currency,'USD');
  assert.doesNotMatch(await fs.readFile(path.join(s.directory,'balance.json'),'utf8'),/NEVER_PERSIST/);
  s.respond({is_available:false,balance_infos:[{currency:'USD',total_balance:'0.00',granted_balance:'0.00',topped_up_balance:'0.00'}]});
  await s.monitor.refresh();assert.equal(s.monitor.status().level,'exhausted');assert.equal(s.sent.length,1);
  s.respond(balance('0.90',{balance_infos:[...balance('0.90').balance_infos,{currency:'USD',total_balance:'200',granted_balance:'0',topped_up_balance:'200'}]}));
  await s.monitor.refresh();assert.equal(s.monitor.status().level,'critical','USD must not be converted or added to CNY');
});

test('state permissions and restart preserve alert cooldown and recovery exactly once',async t=>{
  const s=await fixture(t);s.respond(balance('2.00'));await s.monitor.refresh();assert.equal(s.sent.length,1);
  assert.equal((await fs.stat(path.join(s.directory,'balance.json'))).mode&0o777,0o600);
  await s.monitor.close();const restarted=await s.create();await restarted.refresh({reason:'startup'});assert.equal(s.sent.length,1);
  s.respond(balance('20.00'));await restarted.refresh();assert.equal(s.sent.length,2);
  await restarted.close();const again=await s.create();await again.refresh({reason:'startup'});assert.equal(s.sent.length,2);
});

test('query failures retain known balance, redact errors, and back off across active turns and restart',async t=>{
  const s=await fixture(t);await s.monitor.refresh();s.fail(Error('https://secret-api-key.example/SECRET'));
  s.advance(10*minute);await s.monitor.afterTurn();assert.equal(s.fetches(),2);
  assert.equal(s.monitor.status().balance.balance_infos[0].total_balance,'10.00');assert.equal(s.monitor.status().level,'normal');assert.equal(s.sent.length,0);
  await Promise.all(Array.from({length:20},()=>s.monitor.afterTurn()));assert.equal(s.fetches(),2);
  assert.doesNotMatch(JSON.stringify(s.monitor.status())+JSON.stringify(s.logs)+await fs.readFile(path.join(s.directory,'balance.json'),'utf8'),/SECRET|secret-api/);
  await s.monitor.close();const restarted=await s.create();await restarted.refresh({reason:'startup'});assert.equal(s.fetches(),2);
  s.advance(minute);await restarted.afterTurn();assert.equal(s.fetches(),3);
  s.advance(minute);await restarted.afterTurn();assert.equal(s.fetches(),3,'the second failure backs off for two minutes');
});

test('malformed balance payloads fail safely instead of being treated as zero or persisted verbatim',async t=>{
  const s=await fixture(t);await s.monitor.refresh();
  for(const invalid of [null,{is_available:true},balance('NaN'),balance('1',{balance_infos:[...balance('1').balance_infos,...balance('2').balance_infos]}),{is_available:true,balance_infos:[{currency:'SECRET_URL',total_balance:'0',granted_balance:'0',topped_up_balance:'0'}]}]) {
    s.respond(invalid);await s.monitor.refresh();assert.equal(s.monitor.status().balance.balance_infos[0].total_balance,'10.00');assert.equal(s.sent.length,0);
  }
});

test('simultaneous refresh and turn hooks coalesce into one request and one notification',async t=>{
  const gate=deferred();const s=await fixture(t,{fetchBalance:()=>gate.promise});
  const calls=[s.monitor.refresh({reason:'startup'}),...Array.from({length:12},()=>s.monitor.afterTurn()),s.monitor.tick()];
  await waitFor(()=>s.fetches()===1);assert.equal(s.fetches(),1);
  gate.resolve(balance('2.00'));await Promise.all(calls);assert.equal(s.fetches(),1);assert.equal(s.sent.length,1);
});

test('confirmed 402 alerts immediately while a query is blocked and stale high balance cannot clear it',async t=>{
  let gate=deferred();const s=await fixture(t,{fetchBalance:()=>gate.promise});
  const query=s.monitor.refresh({reason:'startup'});await waitFor(()=>s.fetches()===1);
  await s.monitor.insufficient();assert.equal(s.sent.length,1);assert.match(s.sent[0],/402/);assert.equal(s.monitor.status().confirmedInsufficient,true);
  gate.resolve(balance('10.00'));await query;await settled(s.monitor);assert.equal(s.monitor.status().level,'exhausted');assert.equal(s.sent.length,1);
  gate=deferred();gate.resolve(balance('10.00'));await s.monitor.insufficient();await settled(s.monitor);assert.equal(s.sent.length,1);
  await s.monitor.afterTurn({successful:false});assert.equal(s.monitor.status().confirmedInsufficient,true);
  await s.monitor.afterTurn({successful:true});assert.equal(s.monitor.status().level,'normal');assert.equal(s.monitor.status().confirmedInsufficient,false);assert.equal(s.sent.length,2);
});

test('a confirmed 402 query failure does not prevent notification or cause repeated alerts',async t=>{
  const s=await fixture(t);s.fail(Error('SECRET 402 test'));
  await s.monitor.insufficient();await settled(s.monitor);assert.equal(s.sent.length,1);assert.equal(s.fetches(),1);
  await Promise.all(Array.from({length:10},()=>s.monitor.insufficient()));await settled(s.monitor);
  assert.equal(s.sent.length,1);assert.equal(s.fetches(),1);assert.equal(s.monitor.status().level,'exhausted');
  s.respond(balance('0',{is_available:false}));s.advance(minute);await s.monitor.refresh({reason:'active'});
  s.respond(balance('20'));await s.monitor.refresh();assert.equal(s.monitor.status().level,'normal');assert.equal(s.sent.length,2);
});

test('balance growth after a 402 proves recharge while an unchanged positive cache does not',async t=>{
  const s=await fixture(t);await s.monitor.refresh();await s.monitor.insufficient();await settled(s.monitor);
  assert.equal(s.monitor.status().level,'exhausted');s.respond(balance('11.00'));await s.monitor.refresh();
  assert.equal(s.monitor.status().level,'normal');assert.equal(s.sent.length,2);assert.match(s.sent[1],/恢复/);
});

test('delivery failures retain the notification with exponential retries and survive restart',async t=>{
  let attempts=0,fail=true;const s=await fixture(t,{send:()=>{attempts++;if(fail)throw Error('SECRET transport');}});
  s.respond(balance('0.90'));await s.monitor.refresh();assert.equal(attempts,1);assert.equal(s.monitor.status().notification.pending,true);
  await s.monitor.tick();await s.monitor.afterTurn();assert.equal(attempts,1);
  s.advance(minute);await s.monitor.tick();assert.equal(attempts,2);
  await s.monitor.close();const restarted=await s.create();await restarted.tick();assert.equal(attempts,2);
  s.advance(2*minute);fail=false;await restarted.tick();assert.equal(attempts,3);assert.equal(s.sent.length,1);
  assert.equal(restarted.status().notification.pending,false);assert.doesNotMatch(JSON.stringify(s.logs)+JSON.stringify(restarted.status()),/SECRET/);
});

test('crash during notification preserves uncertainty and does not resend the same level on restart',async t=>{
  const gate=deferred();let attempts=0;const s=await fixture(t,{send:()=>{attempts++;return gate.promise;}});
  s.respond(balance('2'));const query=s.monitor.refresh();
  while(attempts===0)await new Promise(resolve=>setImmediate(resolve));
  await s.monitor.close();await query;assert.equal(s.monitor.status().notification.state,'sending');
  const restarted=await s.create({send:async text=>s.sent.push(text)});
  assert.equal(restarted.status().notification.state,'uncertain');await restarted.refresh({reason:'startup'});assert.equal(s.sent.length,0);
  s.advance(day);await restarted.tick();assert.equal(s.sent.length,1);
  gate.resolve();
});

test('manual notify:false defers only a new balance alert until the next successful automatic query',async t=>{
  const s=await fixture(t);s.respond(balance('2'));
  await s.monitor.refresh({reason:'manual',notify:false});assert.equal(s.sent.length,0);assert.equal(s.monitor.status().notification.pending,true);
  await s.monitor.tick();assert.equal(s.sent.length,0);
  s.advance(10*minute);await s.monitor.afterTurn();assert.equal(s.sent.length,1);
  s.respond(balance('20'));await s.monitor.refresh({notify:false});assert.equal(s.sent.length,1);
  s.advance(10*minute);await s.monitor.afterTurn();assert.equal(s.sent.length,2);assert.match(s.sent[1],/恢复/);
});

test('a manual exhausted result cannot defer an actual confirmed 402 notice',async t=>{
  const s=await fixture(t);s.respond(balance('0',{is_available:false}));await s.monitor.refresh({notify:false});assert.equal(s.sent.length,0);
  await s.monitor.insufficient();await settled(s.monitor);assert.equal(s.sent.length,1);assert.match(s.sent[0],/402/);
});

test('binding changes discard old balances, cooldowns and 402 evidence without leaking binding IDs',async t=>{
  const s=await fixture(t);s.respond(balance('0.50',{binding:accountA}));await s.monitor.refresh();assert.equal(s.sent.length,1);
  await s.monitor.insufficient({binding:accountA});await settled(s.monitor);assert.equal(s.sent.length,2);
  s.respond(balance('0.50',{binding:accountB}));await s.monitor.afterTurn({binding:accountB,successful:true});
  assert.equal(s.monitor.status().confirmedInsufficient,false);assert.equal(s.monitor.status().level,'critical');assert.equal(s.sent.length,3,'the new account needs its own alert despite the old cooldown');
  assert.doesNotMatch(JSON.stringify(s.monitor.status()),new RegExp(`${accountA}|${accountB}`));
});

test('a delayed old-account request cannot overwrite a newly selected account',async t=>{
  const gate=deferred();let calls=0;
  const s=await fixture(t,{fetchBalance:()=>++calls===1?gate.promise:balance('20',{binding:accountB})});
  const old=s.monitor.refresh({binding:accountA});await waitFor(()=>s.fetches()===1);
  const changed=s.monitor.afterTurn({binding:accountB});await waitFor(()=>s.monitor.data.binding===accountB);
  gate.resolve(balance('0',{is_available:false,binding:accountA}));await Promise.all([old,changed]);
  assert.equal(s.monitor.status().level,'normal');assert.equal(s.monitor.status().balance.balance_infos[0].total_balance,'20');assert.equal(s.sent.length,0);assert.equal(s.fetches(),2);
});

test('closing cancels a blocked query and prevents later cache mutation or notification',async t=>{
  const gate=deferred();let signal;
  const s=await fixture(t,{fetchBalance:args=>{signal=args.signal;return gate.promise;}});
  const running=s.monitor.refresh();await waitFor(()=>!!signal);
  await s.monitor.close();await running;assert.equal(signal.aborted,true);
  gate.resolve(balance('0',{is_available:false}));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(s.monitor.status().balance,null);assert.equal(s.sent.length,0);
  await s.monitor.insufficient();await s.monitor.afterTurn();await s.monitor.tick();assert.equal(s.sent.length,0);
});

test('corrupt state is never replaced with an empty balance or an exhausted alert',async t=>{
  const s=await fixture(t);await s.monitor.close();const file=path.join(s.directory,'balance.json');
  await fs.writeFile(file,'{broken');await assert.rejects(s.create(),/拒绝覆盖/);assert.equal(await fs.readFile(file,'utf8'),'{broken');assert.equal(s.sent.length,0);
});

test('queued notifications pass their captured account binding to the sender for route verification',async t=>{
  let activeAccount=accountA;const received=[];
  const s=await fixture(t,{send:async(text,{binding,signal})=>{
    received.push({binding,aborted:signal.aborted});
    if(binding!==activeAccount)throw Error('account route changed');
  }});
  s.respond(balance('2',{binding:accountA}));await s.monitor.refresh();assert.deepEqual(received,[{binding:accountA,aborted:false}]);
  activeAccount=accountB;s.advance(day);await s.monitor.tick();
  assert.equal(received.at(-1).binding,accountA);assert.equal(s.sent.length,1,'a stale account notice is not delivered to the newly routed account');
  s.respond(balance('2',{binding:accountB}));await s.monitor.afterTurn({binding:accountB});
  assert.equal(received.at(-1).binding,accountB);assert.equal(s.sent.length,2);
});

test('a successful business turn refreshes before retrying an obsolete 402 notification',async t=>{
  let fail=true,attempts=0;
  const s=await fixture(t,{send:async()=>{attempts++;if(fail)throw Error('transport temporarily unavailable');}});
  s.respond(balance('0',{is_available:false}));await s.monitor.insufficient();await settled(s.monitor);
  assert.equal(attempts,1);assert.equal(s.monitor.status().notification.pending,true);
  fail=false;s.respond(balance('20'));s.advance(minute);
  await s.monitor.afterTurn({successful:true});
  assert.equal(attempts,2);assert.equal(s.sent.length,1);assert.match(s.sent[0],/恢复正常/);assert.doesNotMatch(s.sent[0],/402/);
});

test('manual refresh does not suppress a previously failed notification retry',async t=>{
  let fail=true;
  const s=await fixture(t,{send:async()=>{if(fail)throw Error('retry');}});s.respond(balance('2'));
  await s.monitor.refresh();assert.equal(s.monitor.status().notification.pending,true);
  await s.monitor.refresh({notify:false});s.advance(minute);fail=false;await s.monitor.tick();assert.equal(s.sent.length,1);
});

test('closing before the query starts prevents the fetch itself',async t=>{
  const s=await fixture(t);const running=s.monitor.refresh();await s.monitor.close();await running;
  assert.equal(s.fetches(),0);assert.equal(s.sent.length,0);
});

test('query timeout is bounded, keeps prior information and backs off instead of becoming zero',async t=>{
  const s=await fixture(t,{config:{requestTimeoutMs:10},fetchBalance:()=>new Promise(()=>{})});
  await s.monitor.refresh();assert.equal(s.monitor.status().balance,null);assert.equal(s.monitor.status().level,'unknown');
  assert.ok(s.monitor.status().lastError);assert.equal(s.sent.length,0);await s.monitor.afterTurn();assert.equal(s.fetches(),1);
});
