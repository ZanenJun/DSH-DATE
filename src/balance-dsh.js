import {createHash} from 'node:crypto';

const endpoint='https://api.deepseek.com/user/balance';
const official=/^https:\/\/api\.deepseek\.com(?:\/(?:v1|anthropic))?\/?$/;
const refName=/^[A-Za-z_][A-Za-z0-9_]*$/;
const recordName=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const service=(ctx,name)=>typeof ctx.get==='function'?ctx.get(name):ctx[name];
class BalanceError extends Error {constructor(code,message){super(message);this.code=code;}}
const failure=(code,message)=>new BalanceError(code,message);
const unavailable=()=>failure('BALANCE_TARGET_UNAVAILABLE','当前模型未配置可查询的 DeepSeek 官方 API 账户。');
function atPath(value,path) {
  for(const key of path){if(typeof key!=='string' || !Object.hasOwn(value??{},key))return null;value=value[key];}
  return value;
}
function usableKey(value) {
  if(typeof value!=='string')return null;
  const key=value.trim();return key.length>0 && key.length<=4096 && /^[\x21-\x7e]+$/.test(key)?key:null;
}
function decodeBalance(value) {
  const decimal=x=>typeof x==='string' && /^-?\d{1,18}(?:\.\d{1,12})?$/.test(x);
  if(typeof value?.is_available!=='boolean' || !Array.isArray(value.balance_infos) || value.balance_infos.length>8)throw Error('schema');
  const balance_infos=value.balance_infos.map(row=>{
    if(!['CNY','USD'].includes(row?.currency) || !['total_balance','granted_balance','topped_up_balance'].every(k=>decimal(row[k])))throw Error('schema');
    return Object.fromEntries(['currency','total_balance','granted_balance','topped_up_balance'].map(k=>[k,row[k]]));
  });
  if(new Set(balance_infos.map(row=>row.currency)).size!==balance_infos.length)throw Error('schema');
  return {is_available:value.is_available,balance_infos};
}

/**
 * DSH 0.2.0-rc.2 adapter. Inject llm, settings, agentDefaultModel; credentials
 * is optional and read through ctx.get, just like the upstream adapters.
 * Targets contain only an account binding and route, never credentials. The
 * key is re-resolved per operation and is never retained in a target/cache.
 */
export function createDshBalanceAdapter(ctx,{providerId,fetchImpl=globalThis.fetch,timeoutMs=8000,maxBytes=16384}={}) {
  if(!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>30000 || !Number.isInteger(maxBytes) || maxBytes<1 || maxBytes>65536)throw failure('BALANCE_CONFIG','余额查询超时或响应大小配置无效。');
  let closed=false;
  const issued=new WeakSet(),controllers=new Set(),subscriptions=new Set(),tasks=new Set();
  const environment=name=>{const snapshot=service(ctx,'launchEnvironment');return snapshot?snapshot.get(name)?.value:process.env[name];};
  async function credential(ref) {
    if(!refName.test(ref))return null;
    const credentials=service(ctx,'credentials');
    return usableKey(credentials?(await credentials.resolve(ref))?.value:environment(ref));
  }
  async function resolveSecret() {
    if(closed)return null;
    try {
      const selection=service(ctx,'agentDefaultModel')?.currentSelection();
      const provider=providerId??selection?.provider;
      if(typeof provider!=='string' || !provider)return null;
      const llm=service(ctx,'llm');
      if(!llm?.listProviders().some(p=>p.id===provider))return null;
      const entry=llm.listConfigurableProviders().find(p=>p.provider===provider);
      if(!entry || entry.error || !Array.isArray(entry.settingsPath))return null;
      const descriptor=service(ctx,'settings')?.describe({redactSecrets:true}).find(d=>d.ns===entry.settingsNs);
      const profile=atPath(descriptor?.value,entry.settingsPath);
      if(!profile || typeof profile!=='object')return null;
      const native=provider==='deepseek-official' && entry.settingsPath.length===0;
      const pi=entry.settingsPath.length===2 && entry.settingsPath[0]==='providers' && entry.settingsPath[1]===provider;
      if(!native && !pi)return null;
      // Auth override headers can make the model use an account other than the
      // credential seam. Refuse that ambiguity rather than report mixed balances.
      if(Object.keys(profile.headers??{}).some(key=>['authorization','x-api-key','api-key'].includes(key.toLowerCase())))return null;
      const baseURL=profile.baseURL??(native?environment('DEEPSEEK_BASE_URL')??'https://api.deepseek.com/anthropic':provider==='deepseek'?'https://api.deepseek.com':null);
      if(typeof baseURL!=='string' || !official.test(baseURL))return null;
      let apiKey;
      if(native || profile.apiKeyEnv!==undefined)apiKey=await credential(profile.apiKeyEnv??'DEEPSEEK_API_KEY');
      else {
        const credentials=service(ctx,'credentials');
        const record=recordName.test(provider)?await credentials?.readRecord(`llm-pi-ai/${provider}`):undefined;
        if(record && record.kind!=='api-key')return null;
        apiKey=usableKey(record?.key);
        // The shipped DeepSeek catalog's ambient auth uses this exact ref;
        // custom provider routes have no implicit DeepSeek environment fallback.
        if(!apiKey && provider==='deepseek')apiKey=await credential('DEEPSEEK_API_KEY');
      }
      if(!apiKey || closed)return null;
      const model=selection?.provider===provider && typeof selection.model==='string'?selection.model:null;
      const binding=createHash('sha256').update(JSON.stringify([provider,baseURL.replace(/\/$/,''),apiKey])).digest('hex');
      return {target:Object.freeze({binding,provider,model}),apiKey};
    }catch{return null;}
  }
  async function resolveTarget() {
    let timer;
    try {
      const resolved=await Promise.race([resolveSecret(),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),Math.min(timeoutMs,1000));})]);
      if(!resolved || closed)return null;
      issued.add(resolved.target);return resolved.target;
    }finally{clearTimeout(timer);}
  }
  async function fetchBalance(target) {
    if(!target || !issued.has(target) || closed)throw unavailable();
    const controller=new AbortController();controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    let reader,response;
    const cancelled=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(failure('BALANCE_TIMEOUT','DeepSeek 余额查询超时或已停止，请稍后重试。')),{once:true}));
    const bounded=promise=>Promise.race([promise,cancelled]);
    try {
      const current=await bounded(resolveSecret());
      if(!current)throw unavailable();
      if(current.target.binding!==target.binding)throw failure('BALANCE_ACCOUNT_CHANGED','DeepSeek 账户配置已变化，请重新查询余额。');
      response=await bounded(fetchImpl(endpoint,{method:'GET',headers:{Authorization:`Bearer ${current.apiKey}`,Accept:'application/json'},redirect:'error',signal:controller.signal}));
      if(response.redirected || (response.url && response.url!==endpoint) || (response.status>=300 && response.status<400))throw failure('BALANCE_REDIRECT','DeepSeek 余额接口发生重定向，已停止查询。');
      if(!response.ok)throw failure(`BALANCE_HTTP_${Number.isInteger(response.status)?response.status:0}`,
        response.status===401||response.status===403?'DeepSeek 余额查询认证失败，请检查 API 配置。':'DeepSeek 余额接口暂不可用，请稍后重试。');
      const length=response.headers.get('content-length');
      if(length!==null && (!/^\d+$/.test(length) || Number(length)>maxBytes))throw failure('BALANCE_RESPONSE_SIZE','DeepSeek 余额响应大小异常，已停止读取。');
      if(!response.body?.getReader)throw failure('BALANCE_RESPONSE','DeepSeek 余额响应格式异常，请稍后重试。');
      reader=response.body.getReader();const chunks=[];let size=0;
      while(true) {
        const {value,done}=await bounded(reader.read());if(done)break;
        size+=value.byteLength;
        if(size>maxBytes)throw failure('BALANCE_RESPONSE_SIZE','DeepSeek 余额响应大小异常，已停止读取。');
        chunks.push(value);
      }
      let payload;
      try{payload=decodeBalance(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
      catch{throw failure('BALANCE_RESPONSE','DeepSeek 余额响应格式异常，请稍后重试。');}
      // A response from an old account must not populate the current cache.
      const latest=await bounded(resolveSecret());
      if(latest?.target.binding!==target.binding)throw failure('BALANCE_ACCOUNT_CHANGED','DeepSeek 账户配置已变化，请重新查询余额。');
      return payload;
    }catch(error) {
      if(error instanceof BalanceError)throw error;
      throw failure('BALANCE_NETWORK','DeepSeek 余额查询网络异常，请稍后重试。');
    }finally {
      clearTimeout(timer);controller.abort();controllers.delete(controller);
      if(reader)void reader.cancel().catch(()=>{});
      else if(response?.body)void response.body.cancel().catch(()=>{});
    }
  }
  const background=fn=>{
    if(closed)return;
    const task=Promise.resolve().then(fn).catch(()=>{}).finally(()=>tasks.delete(task));tasks.add(task);
  };
  function subscribe({onTurnEnd=()=>{},onInsufficient=()=>{}}={}) {
    if(closed)return ()=>{};
    const states=new WeakMap();let disposed=false;
    const stateFor=(session,turn)=>{
      let state=states.get(session);
      if(!state || state.turn!==turn){state={turn,route:session.requestHeader?.()?.config?.provider,target:resolveTarget(),entered:false,reported:false,ended:false};states.set(session,state);}
      return state;
    };
    const matching=async(state,provider)=>{
      const target=await state.target,current=await resolveTarget();
      return !closed && !disposed && target && current && state.route===provider && target.provider===provider && target.binding===current.binding?target:null;
    };
    const insufficient=async(state,provider)=>{
      const target=await matching(state,provider);
      if(!target || state.reported)return;
      state.reported=true;await onInsufficient({binding:target.binding,provider:target.provider});
    };
    // Binding before dispatch avoids attributing a late 402 to a newly selected
    // account. This waterfall delegates the request unchanged, including errors.
    const offRequest=ctx.on('agent/request',async(payload,next)=>{
      const request=await next();
      try {
        if(!closed && !disposed){
          const state=stateFor(payload.agent.session,payload.turn);
          state.route=request.provider;state.target=resolveTarget();state.entered=true;
          await state.target;
        }
      }catch{/* Monitoring never vetoes a model request. */}
      return request;
    });
    const offSession=ctx.on('session/event',(session,event)=>{
      if(closed || disposed)return;
      try {
        if(event.type==='turn/start'){stateFor(session,event.data.turn);return;}
        if(event.type==='step/start'){
          const state=stateFor(session,event.data.turn);state.entered=true;state.target=resolveTarget();return;
        }
        if(event.type==='request/header'){
          const state=states.get(session);if(state)state.route=event.data.header.config.provider;return;
        }
        if(event.type!=='turn/end')return;
        const state=states.get(session);
        if(!state || state.turn!==event.data.turn || !state.entered || state.ended)return;
        state.ended=true;
        const reason=event.data.reason,provider=state.route;
        background(async()=>{
          if(reason?.kind==='error' && reason.error?.status===402)await insufficient(state,provider);
          const target=await matching(state,provider);
          if(target)await onTurnEnd({binding:target.binding,provider:target.provider,successful:['completed','max-tokens'].includes(reason?.kind)});
        });
      }catch{/* Session observers may not change the committed event's outcome. */}
    });
    const offError=ctx.on('agent/request-error',(payload,next)=>{
      try {
        const state=states.get(payload.agent.session);
        if(!closed && !disposed && state?.turn===payload.turn && payload.failure?.status===402)background(()=>insufficient(state,payload.provider));
      }catch{/* Only structured provider failures are inspected, never text. */}
      return next();
    });
    const dispose=()=>{if(disposed)return;disposed=true;offRequest();offSession();offError();subscriptions.delete(dispose);};
    subscriptions.add(dispose);return dispose;
  }
  function close(){closed=true;for(const dispose of subscriptions)dispose();for(const controller of controllers)controller.abort();}
  return {resolveTarget,fetchBalance,subscribe,close,async whenIdle(){while(tasks.size)await Promise.all([...tasks]);}};
}
