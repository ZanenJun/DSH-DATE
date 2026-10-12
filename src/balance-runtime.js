import {BalanceMonitor} from './balance-monitor.js';
import {createDshBalanceAdapter} from './balance-dsh.js';

export async function sendBalanceNotification(transport,text,{signal,isCurrent}={}) {
  if(signal?.aborted || !transport?.connected)throw Error('QQ 暂未连接');
  const result=await transport.send({text,isCurrent:async()=>!signal?.aborted && (!isCurrent || await isCurrent())});
  if(result?.skipped)throw Error('余额通知已失效');
  return result;
}

// The calendar service remains available if balance monitoring cannot start.
// Only this runtime owns its timer, DSH hooks and the separate balance store.
export async function createBalanceRuntime(ctx,config,directory,{send,adapterFactory=createDshBalanceAdapter,monitorFactory=(...args)=>new BalanceMonitor(...args),timerMs=10000}={}) {
  let adapter,monitor,unsubscribe,timer,started=false,closed=false,initializationError=null;
  const activity={observedTurns:0,observedInsufficient:0,lastTurnAt:null};
  const enabled=config?.enabled===true;
  const warn=()=>ctx.logger.warn('余额监测暂不可用；日历服务继续运行。');
  if(enabled)try {
    adapter=adapterFactory(ctx,{providerId:config.providerId,timeoutMs:config.timeoutMs});
    monitor=monitorFactory(directory,config,{
      fetchBalance:async({signal}={})=>{
        const target=await adapter.resolveTarget();
        if(!target)throw Error('当前未配置可查询的官方 DeepSeek 提供方');
        const value=await adapter.fetchBalance(target,{signal});
        return {...value,binding:target.binding};
      },
      send:async(text,{signal,binding}={})=>{
        const target=await adapter.resolveTarget();
        if(closed || signal?.aborted || !target || target.binding!==binding)throw Error('余额通知所属账户已经变化');
        return send(text,{signal,isCurrent:async()=>{
          const current=await adapter.resolveTarget();
          return !closed && !signal?.aborted && current?.binding===binding;
        }});
      },log:warn
    });
    await monitor.open();
  } catch {
    initializationError='余额监测初始化失败；请检查独立状态文件与提供方配置。';
    await adapter?.close();await monitor?.close().catch(()=>{});monitor=null;warn();
  }
  const background=operation=>{if(!closed && monitor)Promise.resolve().then(operation).catch(warn);};
  const withCurrentTarget=async operation=>{
    const target=await adapter.resolveTarget();
    if(closed)return;
    await monitor.bindAccount(target?.binding??'unavailable');
    const result=await operation(target);
    const current=await adapter.resolveTarget();
    if(!closed && current?.binding!==target?.binding)await monitor.bindAccount(current?.binding??'unavailable');
    return result;
  };
  return {
    status(){return {enabled,...(monitor?monitor.status():{level:'unknown',balance:null,lastError:initializationError}),activity:{...activity}};},
    async refresh(input){
      if(closed || !enabled || !monitor)throw Error('余额监测暂不可用');
      await withCurrentTarget(()=>monitor.refresh(input));
      return this.status();
    },
    start(){
      if(closed || started || !monitor)return;
      started=true;
      unsubscribe=adapter.subscribe({
        onTurnEnd:event=>background(()=>withCurrentTarget(target=>{
          if(target?.binding!==event.binding)return;
          activity.observedTurns++;activity.lastTurnAt=new Date().toISOString();return monitor.afterTurn(event);
        })),
        onInsufficient:event=>background(()=>withCurrentTarget(target=>{
          if(target?.binding!==event.binding)return;
          activity.observedInsufficient++;return monitor.insufficient(event);
        }))
      });
      timer=setInterval(()=>background(()=>withCurrentTarget(()=>monitor.tick())),timerMs);timer.unref();
      background(()=>withCurrentTarget(()=>monitor.refresh({reason:'startup'})));
    },
    async close(){
      if(closed)return;closed=true;clearInterval(timer);unsubscribe?.();
      await adapter?.close();await monitor?.close();
    }
  };
}
