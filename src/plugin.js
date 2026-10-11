import Schema from '@deepseek-ai/schemastery';
import { readConfig } from './config.js';
import { startService } from './service.js';
export const name = 'calendar-agent';
export const Config = Schema.object({ configFile: Schema.string().default('') });
export async function apply(ctx, options) {
  const config = await readConfig(options.configFile || undefined);
  let service;
  // Awaited DSH hooks own delivery and incoming-message acknowledgement.
  ctx.on('calendar-agent/message', event => service.scheduler.receive(event));
  ctx.on('calendar-agent/reminder-due', async batch => { batch.result = await service.transport.send(batch); });
  service = await startService(config, {
    receiveHook: event => ctx.parallel('calendar-agent/message', event),
    sendHook: async batch => { await ctx.parallel('calendar-agent/reminder-due', batch); return batch.result; },
    onEvent: (event, payload) => ctx.emit(`calendar-agent/${event}`, payload),
    log: message => ctx.logger.warn(message)
  });
  ctx.effect(() => () => service.close(), 'calendar-agent.service');
  ctx.logger.info(`Calendar agent listening on 127.0.0.1:${service.port}`);
}
