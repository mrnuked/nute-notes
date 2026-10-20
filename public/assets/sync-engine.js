import { encryptVault, decryptVault, vaultCiphertextSize, SYNC_VAULT_BYTES } from './crypto.js?v=0.4.0';
import { replica, makeOperation, readOperation, applyOperation } from './sync-model.js?v=0.4.0';

export function createSyncEngine({key, account, store, request}) {
  let confirmed = null, cursor = 0, pending = [], acknowledged = [], sinceCheckpoint = 0, checkpointBytes = 0, tail = Promise.resolve(), closed = false, syncing = null;
  const exclusive = run => { const task = tail.then(() => { if (closed) throw new Error('Хранилище закрыто.'); return run(); }); tail = task.catch(() => {}); return task; };
  const sameAccount = cache => cache?.email === account.email && cache?.salt === account.salt && cache?.wrappedKey?.ciphertext === account.wrappedKey?.ciphertext;
  async function view() {
    let value = replica(confirmed);
    for (const operation of pending) if (!acknowledged.includes(operation.id)) value = await applyOperation(value, operation, await readOperation(key, operation));
    return value;
  }
  async function persist(value = confirmed, position = cursor, receipts = acknowledged) {
    if (closed) return;
    await store.save({cache: {...account, cursor:position, acknowledged:receipts, vault: await encryptVault(key, value)}});
  }
  async function refreshPending() {
    pending = (await store.load()).pending || [];
    if (pending.length > 5000) throw new Error('Слишком много ожидающих изменений.');
  }
  async function pull() {
    let more;
    do {
      const query = await exclusive(async () => { await refreshPending(); return {after:cursor,pendingIds:pending.map(op=>op.id)}; });
      const result = await request('sync_pull', query);
      if (closed) return;
      await exclusive(async () => {
      let next = confirmed;
      if (result.baseline) next = replica(await decryptVault(key, result.baseline.vault));
      if (!next || !Number.isSafeInteger(result.cursor) || result.cursor < cursor || !Array.isArray(result.changes) || !Array.isArray(result.received)) throw new Error('Некорректный ответ синхронизации.');
      let sequence = result.baseline?.cursor ?? cursor;
      for (const operation of result.changes) {
        if (!Number.isSafeInteger(operation.seq) || operation.seq <= sequence || operation.seq > result.cursor) throw new Error('Нарушен порядок синхронизации.');
        next = await applyOperation(next, operation, await readOperation(key, operation)); sequence = operation.seq;
      }
      const receipts = [...new Set([...result.received,...result.changes.map(op=>op.id),...next.sync.recent])].filter(id => pending.some(op => op.id === id));
      // The local cache must cover accepted changes BEFORE removing their durable outbox records.
      await persist(next, result.cursor, receipts); if (closed) return;
      confirmed = next; cursor = result.cursor; acknowledged = receipts;
      await store.ack({ids:acknowledged}); pending = pending.filter(op => !acknowledged.includes(op.id));
      sinceCheckpoint += result.changes.length; checkpointBytes += result.changes.reduce((sum,op)=>sum+op.data.ciphertext.length,0); more = result.hasMore === true;
      });
    } while (more);
  }
  async function compact(force = false) {
    const checkpoint = await exclusive(async () => {
      if (!force && sinceCheckpoint < 100 && checkpointBytes < 4 * 1024 * 1024) return null;
      if (vaultCiphertextSize(confirmed) > SYNC_VAULT_BYTES) return null;
      return {cursor,vault:await encryptVault(key,confirmed)};
    });
    if (!checkpoint) return false;
    try { await request('sync_checkpoint',checkpoint); sinceCheckpoint=0; checkpointBytes=0; return true; }
    catch (error) { if (error.status === 409) return false; throw error; }
  }
  async function synchronize() {
    if (syncing) return syncing;
    const running = (async () => {
      await pull(); if (closed) return;
      await compact(); if (closed) return;
      const upload = await exclusive(async () => structuredClone(pending));
      for (let offset = 0; offset < upload.length;) {
        const batch=[]; let bytes=32;
        for(const op of upload.slice(offset,offset+64)){const size=JSON.stringify(op).length+1;if(batch.length&&bytes+size>3.5*1024*1024)break;batch.push(op);bytes+=size;}
        try { await request('sync_push',{operations:batch}); }
        catch (error) {
          if (error.code !== 'sync_journal_full') throw error;
          // A long-closed native worker may have filled the journal. Compact
          // the confirmed prefix before retrying; never drop the durable batch.
          await pull();
          if (!await compact(true)) throw error;
          await request('sync_push',{operations:batch});
        }
        if(closed)return;offset+=batch.length;
        await pull(); if (closed) return; await compact();
      }
      await pull(); if(closed)return;
      await compact();
      if (vaultCiphertextSize(confirmed) > SYNC_VAULT_BYTES) throw new Error('Объединённые заметки превышают 16 МиБ. Сохраните резервную копию и удалите лишнее для продолжения синхронизации.');
      if(closed)return;return exclusive(view);
    })(); syncing=running;
    try{return await running;}finally{if(syncing===running)syncing=null;}
  }
  return {
    initialize: initial => exclusive(async () => {
      const local = await store.load();
      if (local.cache && !sameAccount(local.cache) && local.pending?.length) throw new Error('На устройстве остались изменения другого хранилища. Сначала сохраните их.');
      if (sameAccount(local.cache)) { confirmed = replica(await decryptVault(key, local.cache.vault)); cursor = local.cache.cursor || 0; acknowledged = local.cache.acknowledged || []; }
      else { confirmed = replica(initial); cursor = 0; acknowledged = []; await persist(); }
      await refreshPending();
      if (acknowledged.length) { await store.ack({ids:acknowledged}); pending = pending.filter(op => !acknowledged.includes(op.id)); }
      return view();
    }),
    stage: changes => exclusive(async () => {
      if (!changes.length) return view();
      if (pending.length >= 5000) throw new Error('Очередь заполнена. Подключитесь к сети.');
      const operation = await makeOperation(key, changes);
      if (operation.data.ciphertext.length > 2800000) throw new Error('Слишком большое изменение. Разделите текст на несколько заметок или импортируйте меньшую копию.');
      // Validate the resulting replica before making it durable.
      const before = await view(), after = await applyOperation(before, operation, await readOperation(key, operation));
      const deletionOnly = changes.every(change => change.after === null || (change.kind === 'note' && change.after.deleted !== null));
      if (vaultCiphertextSize(after) > SYNC_VAULT_BYTES && vaultCiphertextSize(after) > vaultCiphertextSize(before) && !deletionOnly) throw new Error('Хранилище достигло 16 МиБ. Сохраните резервную копию и удалите лишнее.');
      for (const [field, limit] of [['notes',5000],['folders',100]]) if (after[field].length > limit && after[field].length > before[field].length) throw new Error('Достигнут предел заметок или папок. Удалите лишнее.');
      await store.enqueue({operations:[operation]}); pending.push(operation);
      return view();
    }),
    synchronize,
    view: () => exclusive(view),
    close: () => { closed = true; pending = []; confirmed = null; },
    get pendingCount() { return pending.length; },
    get cursor() { return cursor; },
  };
}
