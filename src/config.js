import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { IANAZone } from 'luxon';

export const defaultConfigPath = () => process.env.DSH_CALENDAR_CONFIG || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'calendar-agent', 'config.json');
const localURL = protocol => z.string().url().refine(value => {
  const u = new URL(value);
  return protocol.includes(u.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username && !u.password && !u.search && !u.hash;
}, 'Use a loopback URL (SSH forward remote services)');
const configSchema = z.object({
  dataDir: z.string().min(1), port: z.number().int().min(0).max(65535).default(3217),
  timeZone: z.string().refine(v => IANAZone.isValidZone(v), 'Invalid time zone').default('Asia/Shanghai'), repeatMs: z.number().int().min(30000).default(30000),
  onebot: z.object({
    ownerQQ: z.string().regex(/^\d+$/), botQQ: z.string().regex(/^\d+$/),
    httpUrl: localURL(['http:', 'https:']).default('http://127.0.0.1:3000'),
    wsUrl: localURL(['ws:', 'wss:']).default('ws://127.0.0.1:3001'),
    configFile: z.string().optional(), httpTokenFile: z.string().optional(), wsTokenFile: z.string().optional()
  }).refine(v => v.configFile || (v.httpTokenFile && v.wsTokenFile), 'Provide configFile or both token files').refine(v => v.ownerQQ !== v.botQQ, 'Owner and bot must be different QQ accounts')
}).strict();
export async function readConfig(file = defaultConfigPath()) {
  const c = configSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
  c.dataDir = path.resolve(path.dirname(file), c.dataDir);
  for (const k of ['configFile', 'httpTokenFile', 'wsTokenFile']) if (c.onebot[k]) c.onebot[k] = path.resolve(path.dirname(file), c.onebot[k]);
  return c;
}
