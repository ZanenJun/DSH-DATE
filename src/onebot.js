import fs from 'node:fs/promises';
import WebSocket from 'ws';

export class OneBot {
  constructor(config, receive, log = () => {}) {
    this.config = config; this.receive = receive; this.log = log;
    this.closed = false; this.connected = false; this.accountOnline = null; this.retries = 0;
  }
  async credentials() {
    const c = this.config;
    if (c.configFile) {
      const value = JSON.parse(await fs.readFile(c.configFile, 'utf8'));
      const http = value.networks?.httpServers?.[0]; const ws = value.networks?.wsServers?.[0];
      if (!http || !ws) throw new Error('OneBot HTTP and WebSocket servers must be configured');
      return { httpToken: http.accessToken, wsToken: ws.accessToken };
    }
    return { httpToken: (await fs.readFile(c.httpTokenFile, 'utf8')).trim(), wsToken: (await fs.readFile(c.wsTokenFile ?? c.httpTokenFile, 'utf8')).trim() };
  }
  async call(action, body = {}, {beforeRequest} = {}) {
    const { httpToken } = await this.credentials();
    const url=`${this.config.httpUrl.replace(/\/$/, '')}/${action}`;
    const request={
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${httpToken}` },
      body: JSON.stringify(body), redirect: 'error'
    };
    // Only claim a delivery once credentials and request preparation succeeded.
    if(beforeRequest && !await beforeRequest())return {skipped:true};
    request.signal=AbortSignal.timeout(10000);
    const r = await fetch(url,request);
    if (!r.ok) throw new Error(`OneBot HTTP ${r.status}`);
    const value = await r.json();
    if (value.status !== 'ok' || value.retcode !== 0) throw new Error(`OneBot retcode ${value.retcode}`);
    return value.data;
  }
  async send(batch) {
    // No nagging while the acknowledgement channel is disconnected.
    if (!this.connected) throw new Error('QQ reply hook disconnected');
    const self = await this.call('get_login_info');
    if (String(self.user_id) !== String(this.config.botQQ)) throw new Error('Unexpected bot QQ; refusing to send');
    if (batch.isCurrent && !await batch.isCurrent()) return { skipped: true };
    return this.call('send_private_msg', { user_id: Number(this.config.ownerQQ), message: [{ type: 'text', data: { text: batch.text } }] },{
      beforeRequest:async()=>{
        if(this.closed || !this.connected)throw Error('QQ reply hook disconnected');
        if(batch.isCurrent && !await batch.isCurrent())return false;
        if(batch.markSending && !await batch.markSending())return false;
        return !this.closed && this.connected && (!batch.isCurrent || await batch.isCurrent());
      }
    });
  }
  async start() {
    if (this.closed) return;
    try {
      const { wsToken } = await this.credentials();
      if (this.closed) return;
      const ws = this.socket = new WebSocket(this.config.wsUrl, { headers: { Authorization: `Bearer ${wsToken}` }, handshakeTimeout: 10000, maxPayload: 1024 * 1024 });
      let lastPacket = Date.now();
      const health = setInterval(() => { if (Date.now() - lastPacket > 90000) ws.terminate(); }, 30000);
      health.unref();
      ws.on('open', () => { this.connected = true; this.retries = 0; this.log('QQ reply hook connected'); });
      ws.on('message', data => {
        lastPacket = Date.now();
        try {
          const event = JSON.parse(data.toString());
          if (event.meta_event_type === 'heartbeat') this.accountOnline = event.status?.online ?? null;
          Promise.resolve(this.receive(event)).catch(() => this.log('QQ reply hook failed; state retained'));
        } catch { /* An unrelated/non-JSON frame must not crash the hook. */ }
      });
      ws.on('error', () => { this.log('QQ reply hook connection error'); });
      ws.on('close', () => { clearInterval(health); this.connected = false; this.reconnect(); });
    } catch { this.log('QQ connection settings unavailable'); this.reconnect(); }
  }
  reconnect() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), Math.min(30000, 1000 * 2 ** Math.min(this.retries++, 5)));
    this.timer.unref();
  }
  close() { this.closed = true; this.connected = false; clearTimeout(this.timer); this.socket?.terminate(); }
}
