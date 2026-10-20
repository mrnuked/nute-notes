'use strict';
const C = require('./contracts.cjs');
const { serverOrigin } = require('./desktop-config.cjs');
const COOKIE_NAMES = new Set(['__Host-nute', '__Host-nute_device']);
function absorbCookies(jar, lines, now) {
  for (const line of lines) {
    const parts = line.split(';').map(value => value.trim()), split = parts[0].indexOf('=');
    const name = parts[0].slice(0, split), value = parts[0].slice(split + 1);
    if (!COOKIE_NAMES.has(name) || value.length > 256 || !/^[A-Za-z0-9,._-]*$/.test(value)) continue;
    const attrs = new Map(parts.slice(1).map(part => { const n = part.indexOf('='); return n < 0 ? [part.toLowerCase(),true] : [part.slice(0,n).toLowerCase(),part.slice(n+1)]; }));
    if (!attrs.has('secure') || !attrs.has('httponly') || attrs.has('domain') || attrs.get('path') !== '/') continue;
    const expires = attrs.has('max-age') ? now + Number(attrs.get('max-age')) * 1000 : attrs.has('expires') ? Date.parse(attrs.get('expires')) : null;
    if (!value || (expires !== null && (!Number.isFinite(expires) || expires <= now))) delete jar[name];
    else jar[name] = { value, expires };
  }
}
class Service {
  constructor(store, transport = globalThis.fetch, origin = C.ORIGIN) { this.store = store; this.transport = transport; this.origin = serverOrigin(origin); this.tail = Promise.resolve(); this.onAuthenticated = () => {}; }
  serial(operation) { const result = this.tail.then(operation); this.tail = result.catch(() => {}); return result; }
  request(input) { const request = C.request(input); return this.serial(() => this.perform(request)); }
  clear(input) { return this.serial(() => this.store.clear(input)); }
  async perform(input) {
    const state = await this.store.snapshot(), now = Date.now();
    const cookie = Object.entries(state.credentials.cookies).filter(([name,entry]) => COOKIE_NAMES.has(name) && (entry.expires === null || entry.expires > now)).map(([name,entry]) => name + '=' + entry.value).join('; ');
    const mutation = input.method !== 'GET';
    const response = await this.transport(this.origin + '/api.php?action=' + input.action, {
      method: input.method, redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { Accept: 'application/json', 'X-Nute-Client': '0.4', ...(cookie ? { Cookie: cookie } : {}),
        ...(mutation ? { Origin: this.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': state.credentials.csrf } : {}) },
      ...(mutation ? { body: C.bounded(input.data, input.action === 'sync_checkpoint' ? C.MAX_CHECKPOINT : C.MAX_REQUEST) } : {}),
    });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('Перенаправление сервера запрещено.'); }
    if (Number(response.headers.get('content-length') || 0) > C.MAX_RESPONSE) { await response.body?.cancel(); throw new Error('Ответ сервера слишком велик.'); }
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > C.MAX_RESPONSE) throw new Error('Ответ сервера слишком велик.'); chunks.push(Buffer.from(item.value)); } }
    catch (error) { await reader.cancel().catch(() => {}); throw error; }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Сервер вернул некорректный ответ.'); }
    if (!C.object(body)) throw new Error('Сервер вернул некорректный ответ.');
    await this.store.transaction(draft => {
      absorbCookies(draft.credentials.cookies, response.headers.getSetCookie(), Date.now());
      if (typeof body.csrf === 'string' && /^[a-f0-9]{64}$/.test(body.csrf)) draft.credentials.csrf = body.csrf;
      if (response.status === 200 && ['setup','login','resume'].includes(input.action)) draft.lastError = null;
    });
    if (response.status === 200 && ['setup','login','resume'].includes(input.action)) this.onAuthenticated();
    return { status: response.status, body };
  }
}
module.exports = { Service, absorbCookies };
