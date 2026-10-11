import fs from 'node:fs/promises';
import { DAVClient } from 'tsdav';

export function appleURL(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.search || (u.port && u.port !== '443')
    || !(u.hostname === 'caldav.icloud.com' || /^p\d+-caldav\.icloud\.com$/.test(u.hostname) || /^p\d+\.caldav\.icloud\.com$/.test(u.hostname))) throw Error('只允许 Apple iCloud CalDAV HTTPS 地址');
  return u.href;
}
export function cloudError(message, status) { return Object.assign(new Error(message), {status}); }

export class ICloudDAV {
  constructor(credentials, { fetchImpl = fetch } = {}) {
    this.credentials = credentials; this.fetchImpl = fetchImpl;
    this.lifetime = new AbortController();
    this.client = new DAVClient({ serverUrl:'https://caldav.icloud.com/', credentials,
      authMethod:'Basic', defaultAccountType:'caldav', fetch:(u, init) => this.request(u, init) });
  }
  async request(value, init = {}) {
    let url = appleURL(String(value));
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(20000), ...(init.signal ? [init.signal] : [])]);
    for (let n=0;n<5;n++) {
      const res = await this.fetchImpl(url, {...init,redirect:'manual',signal});
      if ([301,302,307,308].includes(res.status)) {
        const location=res.headers.get('location'); await res.body?.cancel();
        if (!location) throw Error('iCloud 重定向缺少地址');
        const destination=appleURL(new URL(location,url).href);
        // Discovery needs the redirect itself to resolve subsequent relative DAV paths.
        if(init.redirect==='manual')return new Response(null,{status:res.status,headers:{location:destination}});
        url=destination; continue;
      }
      if (!res.ok && ![404,412].includes(res.status)) {
        await res.body?.cancel();
        throw cloudError(res.status===401 || res.status===403 ? 'iCloud 认证失败，请检查 Apple 账户及 App 专用密码' : `iCloud 请求失败（HTTP ${res.status}）`,res.status);
      }
      // Bound response size before feeding XML/calendar parsers. Never log credentials or response bodies.
      const chunks=[];let size=0;
      if(res.body) for await(const chunk of res.body) {
        size+=chunk.length;if(size>16*1024*1024)throw Error('iCloud 响应过大，已停止本轮同步');chunks.push(chunk);
      }
      return new Response([204,205,304].includes(res.status)?null:Buffer.concat(chunks),{status:res.status,statusText:res.statusText,headers:res.headers});
    }
    throw Error('iCloud 重定向次数过多');
  }
  async discover() {
    await this.client.login({loadCollections:false,loadObjects:false});
    return (await this.client.fetchCalendars()).filter(c => !c.components?.length || c.components.includes('VEVENT'))
      .map(c=>({url:appleURL(c.url),name:typeof c.displayName==='string'?c.displayName:'未命名'}));
  }
  headers(extra={}) { return {Authorization:`Basic ${Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64')}`,...extra}; }
  async list(calendarUrl) {
    const url=appleURL(calendarUrl);
    // One full, unexpanded report. Partial/failed responses must never imply deletion.
    const rows=await this.client.calendarQuery({url,depth:'1',headers:this.headers(),
      props:{'d:getetag':{},'c:calendar-data':{}},
      filters:[{'comp-filter':{_attributes:{name:'VCALENDAR'},'comp-filter':{_attributes:{name:'VEVENT'}}}}]});
    const seen=new Set();
    return rows.map(r=>{
      const raw=r.props?.calendarData,etag=r.props?.getetag;
      if(!r.ok || r.parseError || !r.href || typeof raw!=='string' || typeof etag!=='string' || !etag || r.propStats?.some(p=>!p.ok))throw Error('iCloud 返回不完整事件清单，已停止本轮同步');
      const href=appleURL(new URL(r.href,url).href);
      if(!href.startsWith(url) || href===url || seen.has(href))throw Error('iCloud 事件地址无效或重复');
      seen.add(href);return {href,etag,raw};
    });
  }
  async get(href) {
    const r=await this.request(href,{method:'GET',headers:this.headers()});
    if(r.status===404)return null;
    if(!r.ok || !r.headers.get('etag'))throw Error('无法读取 iCloud 事件版本');
    return {href,etag:r.headers.get('etag'),raw:await r.text()};
  }
  async put(href, raw, etag) {
    const r=await this.request(href,{method:'PUT',headers:this.headers({'Content-Type':'text/calendar; charset=utf-8',...(etag?{'If-Match':etag}:{'If-None-Match':'*'})}),body:raw});
    if(r.status===412 || r.status===404)throw cloudError('iCloud 事件版本冲突',409);
    if(!r.ok)throw Error('iCloud 写入失败');
  }
  async remove(href,etag) {
    const r=await this.request(href,{method:'DELETE',headers:this.headers({'If-Match':etag})});
    if(r.status===412)throw cloudError('iCloud 删除版本冲突',409);
    if(!r.ok && r.status!==404)throw Error('iCloud 删除失败');
  }
  close() { this.lifetime.abort(); }
}

export async function loadCloudCredentials(file) {
  const stat=await fs.stat(file);
  if(stat.mode & 0o077)throw Error('iCloud 凭据文件必须仅当前用户可读写（chmod 600）');
  const c=JSON.parse(await fs.readFile(file,'utf8'));
  if(typeof c.username!=='string' || !c.username.trim() || typeof c.password!=='string' || !/^(?:[a-z]{4}-){3}[a-z]{4}$/i.test(c.password))throw Error('请填写 Apple 账户邮箱和 App 专用密码');
  return {username:c.username.trim(),password:c.password};
}
