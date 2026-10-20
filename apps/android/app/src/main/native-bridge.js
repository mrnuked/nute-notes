/* Loaded before app.js, only from the packaged HTTPS asset origin. */
(() => {
  'use strict';
  if (location.origin !== 'https://appassets.androidplatform.net' || window !== window.top || !window.NuteAndroid) return;
  let serial = 0;
  const waiting = new Map();
  window.NuteAndroid.onmessage = event => {
    let reply; try { reply = JSON.parse(event.data); } catch { return; }
    const pending = waiting.get(reply.id); if (!pending) return;
    waiting.delete(reply.id); clearTimeout(pending.timer);
    if (reply.error) pending.reject(new Error(reply.error)); else pending.resolve(reply.result);
  };
  const call = (method, value = {}) => new Promise((resolve, reject) => {
    const id = String(++serial);
    const timer = method === 'saveFile' ? null : setTimeout(() => { waiting.delete(id); reject(new Error('Приложение не ответило. Повторите действие.')); }, 120000);
    waiting.set(id, { resolve, reject, timer });
    try { window.NuteAndroid.postMessage(JSON.stringify({ id, method, value })); }
    catch (error) { waiting.delete(id); clearTimeout(timer); reject(error); }
  });
  const bridge = {};
  for (const method of ['request', 'load', 'save', 'enqueue', 'ack', 'clear', 'saveFile', 'openExternal']) bridge[method] = value => call(method, value);
  Object.defineProperty(window, 'NuteNative', { value: Object.freeze(bridge), writable: false, configurable: false });
})();
