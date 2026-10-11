import Schema from '@deepseek-ai/schemastery';
import { readConfig } from './config.js';
import { startService } from './service.js';
import { ReminderAgent } from './reminder-agent.js';
import { randomUUID } from 'node:crypto';
import { problem } from './model.js';
export const name = 'calendar-agent';
export const inject = ['agents', 'agentDefaultModel', 'tools', 'systemPrompt'];
export const Config = Schema.object({ configFile: Schema.string().default('') });
export async function apply(ctx, options) {
  const config = await readConfig(options.configFile || undefined);
  const generator = new ReminderAgent(ctx, config.reminder);
  let service, previewing = false;
  // Awaited DSH hooks own delivery and incoming-message acknowledgement.
  ctx.on('calendar-agent/message', event => service.scheduler.receive(event));
  ctx.on('calendar-agent/reminder-due', async batch => {
    if (!service.transport.connected || !batch.isCurrent()) { batch.result = { skipped: true }; return; }
    const generated = await generator.generate(batch, service.store.snapshot());
    if (!generated || !batch.isCurrent()) { batch.result = { skipped: true }; return; }
    Object.assign(batch, generated);
    batch.result = await service.transport.send(batch);
  });
  service = await startService(config, {
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
    onEvent: (event, payload) => ctx.emit(`calendar-agent/${event}`, payload),
    log: message => ctx.logger.warn(message)
  });
  ctx.effect(() => async () => { await generator.close(); await service.close(); }, 'calendar-agent.service');
  ctx.logger.info(`Calendar agent listening on 127.0.0.1:${service.port}`);
}
