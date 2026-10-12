import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { IANAZone } from 'luxon';
import { appleURL } from './icloud-dav.js';

export const defaultConfigPath = () => process.env.DSH_CALENDAR_CONFIG || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'calendar-agent', 'config.json');
const localURL = protocol => z.string().url().refine(value => {
  const u = new URL(value);
  return protocol.includes(u.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username && !u.password && !u.search && !u.hash;
}, 'Use a loopback URL (SSH forward remote services)');
const amount=z.string().regex(/^\d{1,12}(?:\.\d{1,8})?$/, 'Use a positive decimal amount string');
const thresholds=z.partialRecord(z.enum(['CNY','USD']),z.object({low:amount,critical:amount}).strict()
  .refine(v=>Number(v.critical)>0 && Number(v.low)>Number(v.critical),'low must be greater than critical, both positive'));
export const balanceDefaults={enabled:false,intervalMs:3600000,activeIntervalMs:600000,cooldownMs:86400000,timeoutMs:10000,thresholds:{CNY:{low:'5.00',critical:'1.00'}}};
const configSchema = z.object({
  dataDir: z.string().min(1), port: z.number().int().min(0).max(65535).default(3217),
  timeZone: z.string().refine(v => IANAZone.isValidZone(v), 'Invalid time zone').default('Asia/Shanghai'), repeatMs: z.number().int().min(30000).default(30000),
  reminder: z.object({
    tone: z.string().min(1).max(1000).default('像熟悉我的日程助理，亲切、简洁，连续未回复时逐渐直接，但不施压或责备。'),
    timeoutMs: z.number().int().min(1000).max(120000).default(45000)
  }).default({ tone: '像熟悉我的日程助理，亲切、简洁，连续未回复时逐渐直接，但不施压或责备。', timeoutMs: 45000 }),
  balance:z.object({
    enabled:z.boolean().default(false),providerId:z.string().min(1).max(200).optional(),
    intervalMs:z.number().int().min(60000).max(86400000).default(3600000),
    activeIntervalMs:z.number().int().min(60000).max(86400000).default(600000),
    cooldownMs:z.number().int().min(60000).max(604800000).default(86400000),
    timeoutMs:z.number().int().min(1000).max(20000).default(10000),
    thresholds:thresholds.default({CNY:{low:'5.00',critical:'1.00'}})
  }).strict().default(balanceDefaults),
  icloud: z.object({
    enabled:z.boolean().default(false),intervalMs:z.number().int().min(10000).max(3600000).default(20000),
    credentialsFile:z.string().optional(),
    calendarUrl:z.string().refine(v=>{try{return appleURL(v).endsWith('/');}catch{return false;}},'Use the discovered iCloud calendar URL').optional()
  }).refine(v=>!v.enabled || (v.credentialsFile && v.calendarUrl),'启用 iCloud 前请运行 icloud-setup').default({enabled:false,intervalMs:20000}),
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
  if(c.icloud.credentialsFile)c.icloud.credentialsFile=path.resolve(path.dirname(file),c.icloud.credentialsFile);
  Object.defineProperty(c,'sourceFile',{value:path.resolve(file)});
  return c;
}
