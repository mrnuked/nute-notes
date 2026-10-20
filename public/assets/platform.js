export const nativePlatform = () => globalThis.NuteNative || null;
let database;
async function db() {
  if (!database) database = new Promise((resolve,reject) => {
    const request = indexedDB.open('nute-offline-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  return database;
}
async function transact(change) {
  const database = await db();
  return new Promise((resolve,reject) => {
    const transaction = database.transaction('state', 'readwrite'), store = transaction.objectStore('state'), request = store.get('owner');
    let result;
    request.onsuccess = () => {
      try { const state = request.result || {cache:null,unlock:null,pending:[],lastError:null}; result = change(state); store.put(state,'owner'); }
      catch (error) { transaction.abort(); reject(error); }
    };
    transaction.oncomplete = () => resolve(result); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error || new Error('Не удалось сохранить изменения на устройстве.'));
  });
}
export const localStore = {
  async load() { return nativePlatform() ? nativePlatform().load() : transact(state => structuredClone(state)); },
  async save(fields) { return nativePlatform() ? nativePlatform().save(fields) : transact(state => { if ('cache' in fields && (!fields.cache || !state.cache || fields.cache.cursor >= state.cache.cursor)) state.cache = fields.cache; /* Web never persists a resume secret. */ return {ok:true}; }); },
  async enqueue({operations}) {
    if (nativePlatform()) return nativePlatform().enqueue({operations});
    return transact(state => {
      for (const op of operations) { const previous = state.pending.find(item => item.id === op.id); if (previous && JSON.stringify(previous) !== JSON.stringify(op)) throw new Error('Конфликт очереди изменений.'); if (!previous) state.pending.push(op); }
      if (state.pending.length > 5000 || JSON.stringify(state.pending).length > 64 * 1024 * 1024) throw new Error('Очередь заполнена. Подключитесь к сети для синхронизации.');
      return {ok:true};
    });
  },
  async ack({ids}) { return nativePlatform() ? nativePlatform().ack({ids}) : transact(state => { const set = new Set(ids); state.pending = state.pending.filter(op => !set.has(op.id)); return {ok:true}; }); },
  async clear(options={credentials:false}) { return nativePlatform() ? nativePlatform().clear(options) : {ok:true}; },
};
