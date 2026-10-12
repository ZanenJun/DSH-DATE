import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {CalendarStore} from '../src/store.js';
import {MorningDigestScheduler} from '../src/morning-digest.js';
import {OneBot} from '../src/onebot.js';

async function fixture(t,{failure,beforeMark}={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'calendar-morning-onebot-'));
  const tokenFile=path.join(directory,'onebot-token');
  await fs.writeFile(tokenFile,'isolated-test-token',{mode:0o600});
  let now=Date.parse('2026-10-12T07:59:59+08:00');
  const state={requests:[],marks:0,results:[],failure};
  const store=await new CalendarStore(path.join(directory,'data'),{clock:()=>now}).open();
  const server=http.createServer(async(req,res)=>{
    try {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const input=JSON.parse(Buffer.concat(chunks).toString());
      const action=req.url.slice(1);state.requests.push({action,input});
      assert.equal(req.headers.authorization,'Bearer isolated-test-token');
      if(action==='get_login_info') {
        if(state.failure==='login-http') {res.writeHead(503);res.end('temporary login check failure');return;}
        if(state.failure==='credentials')await fs.unlink(tokenFile);
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({status:'ok',retcode:0,data:{user_id:state.failure==='account'?999:456}}));
      } else if(action==='send_private_msg') {
        if(state.failure==='response-lost') {req.socket.destroy();return;}
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:1234}}));
      } else {res.writeHead(404);res.end();}
    }catch(error){res.writeHead(500);res.end(error.message);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const bot=new OneBot({botQQ:'456',ownerQQ:'123',httpUrl:`http://127.0.0.1:${server.address().port}`,httpTokenFile:tokenFile},()=>{});
  bot.connected=true;
  const scheduler=new MorningDigestScheduler(store,{clock:()=>now,send:async batch=>{
    batch.text='今日习惯：09:00 喝水';
    const mark=batch.markSending;
    batch.markSending=async()=>{state.marks++;await beforeMark?.(store,batch);return mark();};
    const result=await bot.send(batch);state.results.push(result);return result;
  }});
  t.after(async()=>{
    await scheduler.close();bot.close();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await store.close();await fs.rm(directory,{recursive:true,force:true});
  });
  await store.saveRoutine({collection:'habits',id:'water',item:{title:'喝水',defaultTime:'09:00'}});
  await scheduler.tick();
  now=Date.parse('2026-10-12T08:00:01+08:00');
  return {store,scheduler,state,tokenFile,setNow:value=>{now=value;}};
}

for(const [failure,label] of [['login-http','get_login_info HTTP failure'],['account','wrong bot account'],['credentials','credential read failure before send_private_msg']]) {
  test(`morning ${label} stays retryable and does not persist a send intent`,async t=>{
    const f=await fixture(t,{failure});
    await f.scheduler.tick();
    let today=f.scheduler.status().today;
    assert.equal(today.status,'pending');
    assert.equal(f.state.marks,0,'no send intent before identity and request preparation succeed');
    assert.deepEqual(f.state.requests.map(row=>row.action),['get_login_info']);
    await f.scheduler.tick();
    assert.equal(f.state.requests.length,1,'failure backoff prevents an immediate retry');
    f.state.failure=null;
    await fs.writeFile(f.tokenFile,'isolated-test-token',{mode:0o600});
    f.setNow(today.retryAt);await f.scheduler.tick();
    today=f.scheduler.status().today;
    assert.equal(today.status,'sent');
    assert.equal(today.attempts,2);
    assert.equal(f.state.marks,1);
    assert.equal(f.state.requests.filter(row=>row.action==='send_private_msg').length,1);
    assert.equal(f.store.snapshot().memory.filter(row=>row.type==='morning-digest-sent').length,1);
  });
}

test('morning send_private_msg with a lost response is uncertain and does not resend that day',async t=>{
  const f=await fixture(t,{failure:'response-lost'});
  await f.scheduler.tick();
  const today=f.scheduler.status().today;
  assert.equal(today.status,'uncertain');
  assert.equal(today.reason,'delivery-result-unknown');
  assert.equal(f.state.marks,1);
  assert.deepEqual(f.state.requests.map(row=>row.action),['get_login_info','send_private_msg']);
  f.state.failure=null;
  f.setNow(Date.parse('2026-10-12T11:00:00+08:00'));await f.scheduler.tick();
  assert.equal(f.state.requests.filter(row=>row.action==='send_private_msg').length,1,'an accepted request with an unknown reply cannot be blindly resent');
  assert.equal(f.store.snapshot().memory.some(row=>row.type==='morning-digest-sent'),false,'unknown delivery is never claimed as confirmed success');
});

test('morning summary invalidated while committing send intent skips the actual QQ request',async t=>{
  const f=await fixture(t,{beforeMark:store=>store.transact(data=>{data.items.water.title='喝两口水';})});
  await f.scheduler.tick();
  assert.equal(f.state.marks,1);
  assert.deepEqual(f.state.results,[{skipped:true}]);
  assert.deepEqual(f.state.requests.map(row=>row.action),['get_login_info']);
  assert.equal(f.scheduler.status().today.status,'pending');
  assert.equal(f.scheduler.status().today.reason,'summary-changed');
});
