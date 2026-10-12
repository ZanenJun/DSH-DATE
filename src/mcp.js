#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { localClient } from './client.js';
import { itemInput } from './model.js';
import {dailyTaskInput,habitInput} from './routines.js';
const server = new McpServer({ name: 'dsh-calendar-agent', version: '0.5.0' });
const call = async (route, args) => {
  try {
    const client = await localClient(process.argv[2]);
    return { content: [{ type: 'text', text: JSON.stringify(await client(`agent/${route}`, args)) }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
};
server.registerTool('calendar_list', {
  description: 'Automatically sync then read current time, ordinary calendar items, dailyTasks templates, local-only habits, reminder occurrences, latestUserReply timestamp and shared memory. toolSync/icloud disclose failed or unfinished sync. dueAtLocal is the same instant as UTC dueAt. Read before changes. Any reply only pauses nagging; explicit start/finish may update ordinary items using the matching reply timestamp via calendar_save, never inference from a generic acknowledgement.', inputSchema: {}
}, () => call('state'));
server.registerTool('calendar_save', {
  description: 'Save a calendar item locally, then automatically request iCloud sync (wait up to 8 seconds). Report sync.state accurately: pending/error/conflict is NOT synced; toolSync.finished only means the cycle ended. Only sync.state=synced confirms that item revision in iCloud, never device refresh. Retain editable fields and pass the current revision; omit read-only sync and dueAtLocal. Past open/enabled items can trigger overdue reminders. Dates require a UTC offset; create/edit habit rules and daily templates with routine_save. Use a fresh operationId per edit and reuse it unchanged on retries.',
  inputSchema: { id: z.string().optional(), baseRevision: z.number().int().min(0).default(0), item: itemInput, operationId: z.string().optional() }
}, args => call('upsert', args));
server.registerTool('calendar_delete', {
  description: 'Delete a specifically requested item using its current revision, then automatically request iCloud sync. Inspect toolSync, icloud and sync; a finished cycle alone does not confirm cloud deletion, and local deletion does not confirm device refresh.',
  inputSchema: { id: z.string(), baseRevision: z.number().int().min(1), operationId: z.string().optional() }
}, args => call('delete', args));
server.registerTool('calendar_reminder', {
  description: 'complete only when the user explicitly says done/finished; acknowledge stops nagging without completing; snooze resumes after minutes. Automatically requests iCloud sync after the action; inspect returned sync status. For a habit this changes only one due occurrence. Read calendar_list to identify the intended item; ask user if ambiguous.',
  inputSchema: { action: z.enum(['complete', 'acknowledge', 'snooze']), itemId: z.string(), occurrenceKey: z.string().optional(), minutes: z.number().int().min(1).max(10080).optional() }
}, args => call('action', args));
server.registerTool('routine_save',{
  description:'Create or edit a dailyTasks template or habits rule in its own JSON. dailyTasks REQUIRES defaultStartTime HH:mm and defaultDurationMinutes; at 08:00 in its timeZone it generates one ordinary calendar todo per day (late start catches up today only). Changes affect future generations; edit today via calendar_save. habits REQUIRES defaultTime HH:mm; only Agent spoken reminders, never calendar events. Read calendar_list before editing, pass baseRevision and reuse operationId on retries. Ask for missing required times/durations.',
  inputSchema:{collection:z.enum(['dailyTasks','habits']),id:z.string().optional(),baseRevision:z.number().int().min(0).default(0),operationId:z.string().optional(),item:z.union([dailyTaskInput,habitInput])}
},args=>call('routines/upsert',args));
server.registerTool('routine_delete',{
  description:'Delete a specifically requested dailyTasks template or habits rule with its current revision. Template deletion stops future generation and keeps already generated calendar items. Habit deletion cancels its reminders. Ask which collection/item if ambiguous.',
  inputSchema:{collection:z.enum(['dailyTasks','habits']),id:z.string(),baseRevision:z.number().int().min(1),operationId:z.string().optional()}
},args=>call('routines/delete',args));
await server.connect(new StdioServerTransport());
