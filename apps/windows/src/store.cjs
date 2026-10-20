'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const C = require('./contracts.cjs');
const initial = () => ({ version: 1, cache: null, unlock: null, pending: [], lastError: null, credentials: { cookies: {}, csrf: '' } });

class Store {
  constructor(directory, protection) { this.file = path.join(directory, 'state-v1.json'); this.revocationFile = path.join(directory, 'unlock-revoked'); this.protection = protection; this.tail = Promise.resolve(); this.state = null; }
  async unlockRevoked() {
    try { await fs.stat(this.revocationFile); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async revokeUnlock() {
    // Independent of the potentially large cache/outbox rewrite. A failed
    // clear can never re-enable the old unlock on the next launch.
    const handle = await fs.open(this.revocationFile, 'a', 0o600);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async initialize() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      if ((await fs.stat(this.file)).size > C.MAX_STATE) throw new Error('Хранилище приложения превышает допустимый размер.');
      const file = await fs.readFile(this.file);
      if (file.length > C.MAX_STATE) throw new Error('Хранилище приложения превышает допустимый размер.');
      const disk = JSON.parse(file.toString('utf8'));
      if (disk.version !== 1 || !Array.isArray(disk.pending) || typeof disk.protected !== 'string') throw new Error('Неизвестный формат локального хранилища.');
      const secret = JSON.parse(this.protection.decrypt(Buffer.from(disk.protected, 'base64')));
      if (!C.object(secret.credentials) || !C.object(secret.credentials.cookies) || typeof secret.credentials.csrf !== 'string') throw new Error('Повреждён защищённый сеанс.');
      this.state = { version: 1, cache: disk.cache ?? null, pending: disk.pending, lastError: disk.lastError ?? null, unlock: secret.unlock ?? null, credentials: secret.credentials };
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Не удалось открыть локальные данные. Файл сохранён без изменений. ' + error.message);
      this.state = initial();
      await this.persist(this.state);
    }
    return this;
  }
  transaction(change, afterPersist = null) {
    const operation = this.tail.then(async () => {
      const draft = structuredClone(this.state);
      const result = await change(draft);
      await this.persist(draft);
      if (afterPersist) await afterPersist();
      this.state = draft;
      return result ?? { ok: true };
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  async persist(state) {
    const protectedData = this.protection.encrypt(JSON.stringify({ credentials: state.credentials, unlock: state.unlock })).toString('base64');
    const bytes = JSON.stringify({ version: 1, cache: state.cache, pending: state.pending, lastError: state.lastError, protected: protectedData });
    if (Buffer.byteLength(bytes) > C.MAX_STATE) throw new Error('Хранилище приложения превышает допустимый размер.');
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      // Windows virus scanners can briefly hold the destination without delete
      // sharing. Retry replacement, never unlink the previous durable state.
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temporary, this.file); break; }
        catch (error) {
          if (attempt >= 6 || !['EPERM','EACCES','EBUSY'].includes(error.code)) throw error;
          await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
        }
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }
  async snapshot() { await this.tail; return structuredClone(this.state); }
  async load() { const { cache, unlock, pending, lastError } = await this.snapshot(); const lockPending = await this.unlockRevoked(); return { cache, unlock: lockPending ? null : unlock, lockPending, pending: pending.map(({ id, data }) => ({ id, data })), lastError }; }
  save(input) {
    if (!C.object(input) || Object.keys(input).some(key => !['cache','unlock'].includes(key))) throw new Error('Некорректное сохранение приложения.');
    for (const name of ['cache','unlock']) if (Object.hasOwn(input, name) && input[name] !== null && !C.object(input[name])) throw new Error('Ожидается объект хранилища.');
    if (input.cache !== undefined) C.bounded(input.cache, C.MAX_CACHE + 65536);
    if (input.unlock !== undefined) C.bounded(input.unlock, 65536);
    C.bounded(input, C.MAX_CACHE + 131072);
    const copy = structuredClone(input);
    return this.transaction(state => { for (const name of ['cache','unlock']) if (Object.hasOwn(copy, name)) state[name] = copy[name]; }, copy.unlock ? async () => {
      // Only a fresh password login writes unlock; cache/background writes do not.
      try { await fs.unlink(this.revocationFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } : null);
  }
  enqueue(input) {
    const operations = C.operations(input);
    return this.transaction(state => {
      const existing = new Map(state.pending.map(op => [op.id, op]));
      for (const op of operations) {
        const previous = existing.get(op.id);
        if (previous && JSON.stringify(previous.data) !== JSON.stringify(op.data)) throw new Error('Повторный идентификатор с другим содержимым.');
        if (!previous) { state.pending.push(op); existing.set(op.id, op); }
      }
      C.bounded(state.pending, C.MAX_QUEUE);
    });
  }
  ack(input) { const ids = new Set(C.ids(input)); return this.transaction(state => { state.pending = state.pending.filter(op => !ids.has(op.id)); }); }
  delivered(input) { const ids = new Set(C.ids(input)); return this.transaction(state => { for (const op of state.pending) if (ids.has(op.id)) op.delivered = true; }); }
  clear(input = {}) {
    if (!C.object(input) || (input.credentials !== undefined && typeof input.credentials !== 'boolean')) throw new Error('Некорректный выход.');
    return this.transaction(async state => { await this.revokeUnlock(); state.unlock = null; if (input.credentials) state.credentials = { cookies: {}, csrf: '' }; });
  }
  setError(error) { return this.transaction(state => { state.lastError = error; }); }
}
module.exports = { Store };
