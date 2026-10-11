import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { ICloudDAV, appleURL } from '../src/icloud-dav.js';
import { digest } from '../src/icloud-codec.js';
import { readConfig } from '../src/config.js';
import { atomicJSON } from '../src/store.js';
import { localClient } from '../src/client.js';

async function question(text) {
  const r=readline.createInterface({input:process.stdin,output:process.stdout});
  try{return (await r.question(text)).trim();}finally{r.close();}
}
async function secret(text) {
  if(!process.stdin.isTTY)throw Error('请在交互终端运行配置命令，密码不会回显');
  process.stdout.write(text);process.stdin.setRawMode(true);process.stdin.resume();
  return new Promise((resolve,reject)=>{
    let value='';
    const finish=(error)=>{process.stdin.off('data',onData);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');error?reject(error):resolve(value);};
    const onData=chunk=>{for(const c of chunk.toString()){
      if(c==='\u0003'){finish(Error('已取消'));return;}
      if(c==='\r'||c==='\n'){finish();return;}
      if(c==='\u007f'||c==='\b')value=value.slice(0,-1);
      else if(/[a-z-]/i.test(c))value+=c;
    }};
    process.stdin.on('data',onData);
  });
}
export async function setupICloud(configFile) {
  if(!process.stdin.isTTY)throw Error('请在服务器交互终端运行 icloud-setup');
  const config=await readConfig(configFile);
  console.log('在 https://account.apple.com 的“登录与安全 → App 专用密码”生成专用密码。无需输入 Apple 主密码。');
  const username=await question('Apple 账户邮箱：');
  const password=await secret('App 专用密码（输入不显示）：');
  if(!username.includes('@') || !/^(?:[a-z]{4}-){3}[a-z]{4}$/i.test(password))throw Error('邮箱或 App 专用密码格式不正确；未保存');
  const dav=new ICloudDAV({username,password});
  try {
    let calendars;
    try{calendars=await dav.discover();}catch{throw Error('无法连接 iCloud。请检查网络、Apple 账户和 App 专用密码；未保存配置。');}
    if(!calendars.length)throw Error('未找到可用日历。请先在 iCloud 日历中创建“DSH 日历助手”');
    console.log('选择专用日历（不要选择包含私人会议或邀请的主日历）：');
    calendars.forEach((c,i)=>console.log(`${i+1}. ${c.name}`));
    const chosen=Number(await question('日历序号：'))-1;
    if(!Number.isInteger(chosen)||!calendars[chosen])throw Error('无效序号；未保存配置');
    const calendarUrl=appleURL(calendars[chosen].url);
    let state;
    try{state=JSON.parse(await fs.readFile(path.join(config.dataDir,'calendar.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    const bound=state?.syncClients?.icloud?.binding;
    if(bound && (bound.account!==digest(username.toLowerCase()) || bound.calendarUrl!==calendarUrl))throw Error('已有另一账户/日历的同步映射；为避免重复导入，需先迁移，未覆盖配置');
    const creds=path.join(config.dataDir,'icloud-credentials.json');
    await fs.mkdir(config.dataDir,{recursive:true,mode:0o700});
    const raw=JSON.parse(await fs.readFile(configFile,'utf8'));
    await fs.copyFile(configFile,`${configFile}.before-icloud-${Date.now()}`);
    await atomicJSON(creds,{username,password});
    raw.icloud={enabled:true,intervalMs:10000,credentialsFile:creds,calendarUrl};
    await atomicJSON(configFile,raw);
    try {
      const api=await localClient(configFile);const status=await api('icloud/reload',{});
      if(status.lastError)throw Error('reload failed');
      console.log('配置已保存，Linux 已启用直连 iCloud，每 10 秒启动一轮同步。请退出旧 Mac 同步程序；系统日历继续正常使用。');
      console.log('查看同步结果：dsh-calendar icloud-status（或 node bin/calendar.js icloud-status）');
    } catch { console.log('配置已保存。请重启 DSH 使配置生效，再运行 icloud-status 检查连接。'); }
  }finally{dav.close();}
}
