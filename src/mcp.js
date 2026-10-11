#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { localClient } from './client.js';
import { itemInput } from './model.js';
const server = new McpServer({ name: 'dsh-calendar-agent', version: '0.3.1' });
const call = async (route, args) => {
  try {
    const client = await localClient(process.argv[2]);
    return { content: [{ type: 'text', text: JSON.stringify(await client(`agent/${route}`, args)) }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
};
server.registerTool('calendar_list', {
  description: 'Automatically request iCloud sync before reading current local time, items, revisions, reminder occurrences and shared memory. Inspect toolSync and icloud for unfinished/failed sync; local data remains readable. dueAt is UTC; dueAtLocal is the SAME instant in timeZone, use it when speaking. Always read before editing or interpreting dates. Any QQ reply only acknowledges reminders; it does not complete them.', inputSchema: {}
}, () => call('state'));
server.registerTool('calendar_save', {
  description: 'Save a calendar item locally, then automatically request iCloud sync (wait up to 8 seconds). Report sync.state accurately: pending/error/conflict is NOT synced; toolSync.finished only means the cycle ended. Only sync.state=synced confirms that item revision in iCloud, never device refresh. Retain editable fields and pass the current revision; omit read-only sync and dueAtLocal. Past open/enabled items can trigger overdue reminders. Dates require a UTC offset; habits require recurrence. Use a fresh operationId per edit and reuse it unchanged on retries.',
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
await server.connect(new StdioServerTransport());
