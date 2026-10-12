import Schema from '@deepseek-ai/schemastery';
import { readConfig } from './config.js';
import { startService } from './service.js';
import { ReminderAgent } from './reminder-agent.js';
import { randomUUID } from 'node:crypto';
import { problem } from './model.js';
import {createBalanceRuntime,sendBalanceNotification} from './balance-runtime.js';
import {MorningAgent} from './morning-agent.js';
import {buildMorningSummary} from './morning-digest.js';
export const name = 'calendar-agent';
export const inject = ['agents', 'agentDefaultModel', 'tools', 'systemPrompt', 'llm', 'settings'];
export const Config = Schema.object({ configFile: Schema.string().default('') });
export async function apply(ctx, options) {
  const config = await readConfig(options.configFile || undefined);
  const generator = new ReminderAgent(ctx, config.reminder);
  const morningGenerator=new MorningAgent(ctx,config.morning);
  let service, previewing = false, morningPreviewing=false;
  const balance=await createBalanceRuntime(ctx,config.balance,config.dataDir,{send:(text,options)=>sendBalanceNotification(service?.transport,text,options)});
  // Awaited DSH hooks own delivery and incoming-message acknowledgement.
  ctx.on('calendar-agent/message', event => service.scheduler.receive(event));
  ctx.on('calendar-agent/reminder-due', async batch => {
    if (!service.transport.connected || !batch.isCurrent()) { batch.result = { skipped: true }; return; }
    const generated = await generator.generate(batch, service.store.snapshot());
    if (!generated || !batch.isCurrent()) { batch.result = { skipped: true }; return; }
    Object.assign(batch, generated);
    batch.result = await service.transport.send(batch);
  });
  ctx.on('calendar-agent/morning-due',async batch=>{
    if(!service.transport.connected)throw Error('QQ 暂未连接，稍后重试早晨汇总');
    if(!batch.isCurrent()){batch.result={skipped:true};return;}
    const generated=await morningGenerator.generate(batch);
    if(!generated || !batch.isCurrent()){batch.result={skipped:true};return;}
    if(!service.transport.connected)throw Error('QQ 暂未连接，稍后重试早晨汇总');
    Object.assign(batch,generated);
    batch.result=await service.transport.send(batch);
  });
  try {service = await startService(config, {
    balance,
    startTransport:false,
    previewMorningHook:async()=>{
      if(morningPreviewing)throw problem('A morning preview is already running',409);
      const summary=buildMorningSummary(service.store.snapshot(),Date.now(),config.timeZone);
      if(!['habits','dailyTasks','goals'].some(key=>summary[key].length))return {dryRun:true,summary,text:null};
      const fingerprint=JSON.stringify(summary);
      morningPreviewing=true;
      try {
        const generated=await morningGenerator.generate({deliveryId:randomUUID(),summary,date:summary.date,timeZone:config.timeZone,
          isCurrent:()=>!service.scheduler.stopped && JSON.stringify(buildMorningSummary(service.store.snapshot(),Date.now(),config.timeZone))===fingerprint});
        return {...generated,summary,dryRun:true};
      }finally{morningPreviewing=false;}
    },
    previewHook: async ({ itemId }) => {
      if (previewing) throw problem('A reminder preview is already running', 409);
      const data = service.store.snapshot();
      // An omitted item previews a synthetic example in this detached snapshot only.
      if (itemId === undefined) {
        itemId = 'preview-example';
        data.items[itemId] = { id: itemId, title: '起身活动一下', notes: '', dueAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(), timeZone: config.timeZone, enabled: true, status: 'open', recurrence: null };
      }
      const item = Object.hasOwn(data.items, itemId ?? '') && data.items[itemId];
      if (!item || item.deletedAt) throw problem('Item not found', 404);
      const key = 'preview';
      data.occurrences[key] = { key, itemId, dueAt: item.dueAt, attempts: 1, state: 'active' };
      previewing = true;
      try {
        return { ...await generator.generate({ deliveryId: randomUUID(), keys: [key], isCurrent: () => !service.scheduler.stopped }, data), dryRun: true };
      } finally { previewing = false; }
    },
    receiveHook: event => ctx.parallel('calendar-agent/message', event),
    sendHook: async batch => { await ctx.parallel('calendar-agent/reminder-due', batch); return batch.result; },
    morningSendHook:async batch=>{await ctx.parallel('calendar-agent/morning-due',batch);return batch.result;},
    onEvent: (event, payload) => ctx.emit(`calendar-agent/${event}`, payload),
    log: message => ctx.logger.warn(message)
  });} catch(error){await balance.close();await morningGenerator.close();await generator.close();throw error;}
  service.transport.start();
  balance.start();
  ctx.effect(() => async () => { await balance.close(); await morningGenerator.close(); await generator.close(); await service.close(); }, 'calendar-agent.service');
  ctx.logger.info(`Calendar agent listening on 127.0.0.1:${service.port}`);
}
