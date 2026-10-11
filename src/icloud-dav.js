import fs from 'node:fs/promises';
import { DAVClient } from 'tsdav';

export function appleURL(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.search || (u.port && u.port !== '443')
    || !/^(?:caldav|p\d+-caldav|p\d+\.caldav)\.icloud\.com(?:\.cn)?$/.test(u.hostname)) throw Object.assign(Error('只允许 Apple iCloud CalDAV HTTPS 地址'),{code:'DAV_UNTRUSTED_URL'});
  return u.href;
}
export function cloudError(message, status) { return Object.assign(new Error(message), {status}); }

const networkCodes=new Set(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID','DAV_UNTRUSTED_URL']);
function failureCode(e,depth=0) {
  if(!e || depth>4)return null;
  if(networkCodes.has(e.code))return e.code;
  if(e.name==='TimeoutError')return 'ETIMEDOUT';
  return failureCode(e.cause,depth+1) || e.errors?.map(x=>failureCode(x,depth+1)).find(Boolean) || null;
}
function requestStage(init) {
  const body=typeof init.body==='string'?init.body:'';
  if(body.includes('current-user-principal'))return '查找账户入口';
  if(body.includes('calendar-home-set'))return '查找日历目录';
  if(body.includes('supported-report-set'))return '查询日历能力';
  if(body.includes('displayname'))return '列出日历';
  return '连接日历服务';
}
// Only report our own stage, HTTP status and allowlisted error codes. Never expose
// library messages, request headers, account paths, response bodies or credentials.
export function cloudFailureMessage(diagnostic={}) {
  const {status,code,stage}=diagnostic;
  let reason;
  if(code==='DAV_UNTRUSTED_URL')reason='日历发现返回了尚未支持的地址，已阻止发送凭据；需要检查区域服务兼容性';
  else if(code==='ENOTFOUND'||code==='EAI_AGAIN')reason='DNS 解析失败，请检查服务器 DNS';
  else if(code==='ETIMEDOUT'||code?.endsWith('_TIMEOUT'))reason='连接 Apple 超时，请检查服务器到 iCloud 的网络';
  else if(code?.includes('CERT')||code?.includes('SELF_SIGNED')||code?.includes('ISSUER')||code==='UNABLE_TO_VERIFY_LEAF_SIGNATURE')reason='TLS 证书验证失败，请检查服务器时间、证书或代理';
  else if(code)reason='连接 Apple 时发生网络错误';
  else if(status===401)reason='Apple 拒绝了认证。请确认邮箱是生成该 App 专用密码的 Apple 账户，且填写的是完整专用密码';
  else if(status===403)reason='Apple 拒绝访问。请检查账户的 iCloud 日历权限及 App 专用密码';
  else if(status===429)reason='Apple 请求限流，请稍后重试';
  else if(status>=500)reason='Apple 日历服务暂时出错，请稍后重试';
  else reason='未能解析或发现 iCloud 日历，请将这条错误信息交给维护者排查';
  const detail=[stage,status?`HTTP ${status}`:null,code].filter(Boolean).join('；');
  return `${reason}${detail?`（${detail}）`:''}。未保存配置。`;
}

export class ICloudDAV {
  constructor(credentials, { fetchImpl = fetch } = {}) {
    this.credentials = credentials; this.fetchImpl = fetchImpl;
    this.lifetime = new AbortController();
    this.client = new DAVClient({ serverUrl:'https://caldav.icloud.com/', credentials,
      authMethod:'Basic', defaultAccountType:'caldav', fetch:(u, init) => this.request(u, init) });
  }
  async request(value, init = {}) {
    const diagnostic={stage:requestStage(init),status:null,code:null};
    try {const response=await this.performRequest(value,init,diagnostic);this.diagnostic=diagnostic;return response;}
    catch(e) {diagnostic.code=failureCode(e);this.diagnostic=diagnostic;e.cloudDiagnostic=diagnostic;throw e;}
  }
  async performRequest(value, init, diagnostic) {
    let url = appleURL(String(value));
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(20000), ...(init.signal ? [init.signal] : [])]);
    for (let n=0;n<5;n++) {
      const res = await this.fetchImpl(url, {...init,redirect:'manual',signal});
      diagnostic.status=res.status;
      if ([301,302,307,308].includes(res.status)) {
        const location=res.headers.get('location'); await res.body?.cancel();
        if (!location) throw Error('iCloud 重定向缺少地址');
        const destination=appleURL(new URL(location,url).href);
        // Discovery needs the redirect itself to resolve subsequent relative DAV paths.
        if(init.redirect==='manual')return new Response(null,{status:res.status,headers:{location:destination}});
        url=destination;diagnostic.status=null;continue;
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
    // A global principal may point to a China-region home. Resolve collection
    // hrefs against the home that returned them, not the original global root.
    const account={...this.client.account,rootUrl:this.client.account.homeUrl};
    return (await this.client.fetchCalendars({account})).filter(c => !c.components?.length || c.components.includes('VEVENT'))
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
      const data=r.props?.calendarData,raw=typeof data==='string'?data:data?._cdata,etag=r.props?.getetag;
      const href=r.href?appleURL(new URL(r.href,url).href):null;
      // iCloud includes the calendar collection itself, including when empty:
      // getetag is 200 but calendar-data is 404 because a directory is not a VEVENT.
      // Only ignore this exact self-resource shape; missing event data still fails.
      if(href===url && r.ok && !r.error && !r.parseError && typeof etag==='string' && etag && data===undefined
        && r.propStats?.some(p=>p.status===404 && Object.hasOwn(p.props??{},'calendarData'))
        && r.propStats.every(p=>p.ok || (p.status===404 && Object.keys(p.props??{}).length===1 && Object.hasOwn(p.props,'calendarData'))))return null;
      if(!r.ok || r.parseError || !r.href || typeof raw!=='string' || typeof etag!=='string' || !etag || r.propStats?.some(p=>!p.ok))throw Error('iCloud 返回不完整事件清单，已停止本轮同步');
      if(!href.startsWith(url) || href===url || seen.has(href))throw Error('iCloud 事件地址无效或重复');
      seen.add(href);return {href,etag,raw};
    }).filter(Boolean);
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
