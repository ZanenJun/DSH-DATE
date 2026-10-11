#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { localClient } from './client.js';
import { itemInput } from './model.js';
const server = new McpServer({ name: 'dsh-calendar-agent', version: '0.2.0' });
const call = async (route, args) => {
  try {
    const client = await localClient(process.argv[2]);
    return { content: [{ type: 'text', text: JSON.stringify(await client(route, args)) }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
};
server.registerTool('calendar_list', {
  description: 'Read current local time, items, revisions, reminder occurrences and persistent shared calendar memory. dueAt is normalized UTC; dueAtLocal is the SAME instant in timeZone, use it when speaking to the user. Always read before editing or interpreting dates. Any QQ reply only acknowledges reminders; it does not complete them.', inputSchema: {}
}, () => call('state'));
server.registerTool('calendar_save', {
  description: 'Create or replace a calendar item. For editing, retain all existing fields and pass its current revision. Dates must include a UTC offset. Habits require daily/weekly recurrence. operationId must be a fresh UUID for each logical edit and reused unchanged on retries.',
  inputSchema: { id: z.string().optional(), baseRevision: z.number().int().min(0).default(0), item: itemInput, operationId: z.string().optional() }
}, args => call('upsert', args));
server.registerTool('calendar_delete', {
  description: 'Delete a specifically requested item using its current revision. Deletion is synchronized to the dedicated Mac calendar.',
  inputSchema: { id: z.string(), baseRevision: z.number().int().min(1), operationId: z.string().optional() }
}, args => call('delete', args));
server.registerTool('calendar_reminder', {
  description: 'complete only when the user explicitly says done/finished; acknowledge stops nagging without completing; snooze resumes after minutes. For a habit this changes only one due occurrence. Read calendar_list to identify the intended item; ask user if ambiguous.',
  inputSchema: { action: z.enum(['complete', 'acknowledge', 'snooze']), itemId: z.string(), occurrenceKey: z.string().optional(), minutes: z.number().int().min(1).max(10080).optional() }
}, args => call('action', args));
await server.connect(new StdioServerTransport());
