'use strict';
const C = require('./contracts.cjs');
function batch(pending) {
  const result = [];
  for (const { id, data } of pending.filter(op => !op.delivered).slice(0,64)) {
    const operation = { id, data };
    if (Buffer.byteLength(JSON.stringify({ operations: [...result, operation] })) > C.MAX_REQUEST) break;
    result.push(operation);
  }
  return result;
}
class Worker {
  constructor(store, service, timers = { setTimeout, clearTimeout }) { this.store = store; this.service = service; this.timers = timers; this.timer = null; this.running = null; this.failures = 0; this.stopped = false; }
  wake(delay = 0) { if (this.stopped) return; if (this.timer) this.timers.clearTimeout(this.timer); this.timer = this.timers.setTimeout(() => { this.timer = null; this.run().catch(() => {}); }, delay); this.timer?.unref?.(); }
  stop() { this.stopped = true; if (this.timer) this.timers.clearTimeout(this.timer); }
  run() {
    if (this.running) return this.running;
    this.running = this.upload().finally(() => { this.running = null; });
    return this.running;
  }
  async upload() {
    if (this.stopped) return;
    for (let page = 0; page < 8; page++) {
      const state = await this.store.snapshot();
      if (!state.pending.some(op => !op.delivered)) { this.failures = 0; return; }
      if (!state.credentials.cookies['__Host-nute']) { await this.store.setError('Для синхронизации войдите в NUTE. Изменения сохранены на устройстве.'); return; }
      const operations = batch(state.pending);
      if (!operations.length) { await this.store.setError('Изменение превышает допустимый размер отправки. Оно сохранено на устройстве.'); return; }
      try {
        const result = await this.service.request({ action: 'sync_push', method: 'POST', data: { operations } });
        if (result.status === 200) {
          const accepted = result.body.accepted, sent = new Set(operations.map(op => op.id));
          if (!Array.isArray(accepted) || !accepted.length || accepted.some(id => !sent.has(id))) throw new Error('Некорректное подтверждение сервера.');
          // Keep delivered ciphertext until the UI has durably folded it into
          // its encrypted cache and explicitly acknowledges those IDs.
          await this.store.delivered({ ids: accepted }); await this.store.setError(null); this.failures = 0;
          continue;
        }
        if ([401,403].includes(result.status)) { await this.store.setError('Для синхронизации войдите в NUTE. Изменения сохранены на устройстве.'); return; }
        if (result.status === 429 || result.status >= 500) throw new Error('Сервер временно недоступен.');
        await this.store.setError('Синхронизация остановлена: ' + (typeof result.body.message === 'string' ? result.body.message.slice(0,300) : 'ошибка ' + result.status)); return;
      } catch (error) {
        this.lastFailure = error;
        await this.store.setError('Нет связи с сервером. Изменения сохранены и будут отправлены автоматически.');
        this.failures++; this.wake(Math.min(300000, 5000 * 2 ** Math.min(this.failures - 1,6))); return;
      }
    }
    this.wake(1000);
  }
}
module.exports = { Worker, batch };
