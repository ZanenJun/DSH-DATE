#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultConfigPath, readConfig } from '../src/config.js';
import { atomicJSON } from '../src/store.js';
import { tokenFor, startService } from '../src/service.js';
import { localClient } from '../src/client.js';
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: {type:'string'}, owner: {type:'string'}, bot: {type:'string'}, onebot: {type:'string'},
  port: {type:'string'}, 'dsh-home': {type:'string'}, profile: {type:'string'}, 'show-token': {type:'boolean'},prefer:{type:'string'}
} });
const command = positionals[0]; const configFile = path.resolve(values.config || defaultConfigPath());
try {
  if(command==='icloud-setup') {
    await (await import('./icloud-setup.js')).setupICloud(configFile);
  } else if(['icloud-status','icloud-sync','icloud-resolve'].includes(command)) {
    const api=await localClient(configFile);
    const result=command==='icloud-status'?await api('icloud/status'):command==='icloud-sync'?await api('icloud/sync',{}):await api('icloud/resolve',{id:positionals[1],prefer:values.prefer});
    console.log(JSON.stringify(result,null,2));
  } else if (command === 'init') {
    if (!values.owner || !values.bot || !values.onebot) throw Error('init requires --owner QQ --bot QQ --onebot /path/to/onebot_ACCOUNT.json');
    await fs.mkdir(path.dirname(configFile), { recursive:true,mode:0o700 });
    const config = { dataDir:'./data', port:Number(values.port ?? 3217), timeZone:'Asia/Shanghai',repeatMs:30000,
      onebot: { ownerQQ:values.owner,botQQ:values.bot,configFile:path.resolve(values.onebot),httpUrl:'http://127.0.0.1:3000',wsUrl:'ws://127.0.0.1:3001' } };
    await fs.writeFile(configFile, JSON.stringify(config,null,2)+'\n', {flag:'wx',mode:0o600});
    try { await readConfig(configFile); } catch(e) { await fs.unlink(configFile); throw e; }
    await tokenFor((await readConfig(configFile)).dataDir);
    console.log(`Created ${configFile}`);
  } else if (command === 'install') {
    const home = path.resolve(values['dsh-home'] || process.env.DSH_HOME || path.join(os.homedir(),'.dsh'));
    const profile = values.profile || 'web';
    if (!/^[\w-]+$/.test(profile)) throw Error('Invalid profile');
    const dir = path.join(home,'profiles',profile); const manifest = path.join(dir,'package.json');
    const pkg = JSON.parse(await fs.readFile(manifest,'utf8')); const root = path.resolve(fileURLToPath(new URL('..',import.meta.url)));
    const standardConfig = path.join(home,'calendar-agent','config.json');
    if (configFile !== standardConfig && !process.env.DSH_CALENDAR_CONFIG) throw Error('Set DSH_CALENDAR_CONFIG in the DSH service environment when using a custom config path');
    await readConfig(configFile);
    if (!pkg.dsh?.profile?.bundles) throw Error('Not a DSH profile manifest');
    await fs.mkdir(path.join(dir,'node_modules'),{recursive:true});
    const link = path.join(dir,'node_modules','dsh-calendar-agent');
    try { if (await fs.realpath(link) !== root) throw Error('Another calendar plugin is already linked'); }
    catch(e) { if(e.code==='ENOENT') await fs.symlink(root,link,'dir'); else throw e; }
    const backup = manifest+'.calendar-backup-'+Date.now(); await fs.copyFile(manifest,backup);
    pkg.dependencies ??= {}; pkg.dependencies['dsh-calendar-agent'] = `link:${root}`;
    if (!pkg.dsh.profile.bundles.includes('dsh-calendar-agent')) pkg.dsh.profile.bundles.push('dsh-calendar-agent');
    await atomicJSON(manifest,pkg);
    console.log(`Installed into profile ${profile}. Restart DSH; select calendar-assistant in qq-bridge. Backup: ${backup}`);
  } else if (command === 'status') {
    const state = await (await localClient(configFile))('state');
    console.log(JSON.stringify({now:state.now,qqConnected:state.qqConnected,items:state.items.filter(i=>!i.deletedAt).length,activeReminders:state.occurrences.filter(o=>o.state==='active').length,syncBackend:state.syncBackend,icloud:state.icloud},null,2));
  } else if (command === 'pair') {
    const config = await readConfig(configFile);
    console.log(`Mac URL over an SSH tunnel: http://127.0.0.1:${config.port}`);
    console.log(`Token file: ${path.join(config.dataDir,'access-token')}`);
    if (values['show-token']) console.log(await tokenFor(config.dataDir));
  } else if (command === 'serve') {
    const service = await startService(await readConfig(configFile), {log: m=>console.error(m)});
    console.error(`Calendar service listening on 127.0.0.1:${service.port}`);
    for(const signal of ['SIGINT','SIGTERM']) process.once(signal,async()=>{await service.close();process.exit(0);});
  } else console.log('dsh-calendar init | install | status | icloud-setup | icloud-status | icloud-sync | icloud-resolve ID --prefer local|remote | pair [--show-token] | serve\nUse --config PATH to select a configuration.');
} catch(e) { console.error(e.message); process.exitCode=1; }
