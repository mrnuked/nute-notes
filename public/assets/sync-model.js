import { validateVault } from './model.js?v=0.4.0';
import { seal, open } from './crypto.js?v=0.4.0';

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export async function fingerprint(value) {
  if (value == null) return null;
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function replica(value) {
  const result = structuredClone(validateVault(value, { recovery: true })); result.version = 3;
  const sync = result.sync || { removedNotes: [], removedFolders: [] };
  for (const name of ['removedNotes','removedFolders']) {
    if (!Array.isArray(sync[name]) || sync[name].length > 50000 || sync[name].some(id => typeof id !== 'string' || id.length > 200)) throw new Error('Повреждена история синхронизации.');
  }
  const recent=sync.recent || [];
  if(!Array.isArray(recent)||recent.length>5000||recent.some(id=>!uuid.test(id)))throw new Error('Повреждена история изменений.');
  result.sync = { removedNotes: [...new Set(sync.removedNotes)], removedFolders: [...new Set(sync.removedFolders)],recent:[...new Set(recent)] }; return result;
}
export async function changesBetween(before, after) {
  validateVault(before, { recovery: true }); validateVault(after, { recovery: true }); const changes = [];
  for (const [kind, field] of [['folder','folders'],['note','notes']]) {
    const old = new Map(before[field].map(item => [item.id, item])), next = new Map(after[field].map(item => [item.id, item]));
    for (const id of new Set([...old.keys(), ...next.keys()])) {
      if (kind === 'folder' && id === 'notes') continue;
      const a = old.get(id) || null, b = next.get(id) || null;
      if (canonical(a) === canonical(b)) continue;
      changes.push({ kind, id, before: await fingerprint(a), after: b ? structuredClone(b) : null, ...(kind === 'note' && a?.deleted !== null && a?.deleted !== undefined && b?.deleted === null ? { restore: true } : {}) });
    }
  }
  return changes;
}
function validateChanges(patch) {
  if (patch?.v !== 1 || !Array.isArray(patch.changes) || patch.changes.length > 5100) throw new Error('Неподдерживаемое изменение заметок.');
  const ids = new Set();
  for (const change of patch.changes) {
    if (!['note','folder'].includes(change.kind) || typeof change.id !== 'string' || !change.id || change.id.length > 200 || ids.has(change.kind + ':' + change.id)
      || !(change.before === null || /^[a-f0-9]{64}$/.test(change.before)) || !(change.after === null || (typeof change.after === 'object' && change.after.id === change.id))
      || (change.restore !== undefined && change.restore !== true)) throw new Error('Повреждено изменение заметки.');
    ids.add(change.kind + ':' + change.id);
    if (change.after !== null) {
      if (change.kind === 'note') validateVault({ version: 3, folders: [{id:'notes',name:'Заметки'}, ...(change.after.folder === 'notes' ? [] : [{id:change.after.folder,name:''}])], notes: [change.after] });
      else if (typeof change.after.name !== 'string' || change.after.name.length > 120 || change.id === 'notes') throw new Error('Повреждено изменение папки.');
    }
  }
  return patch;
}
export async function makeOperation(key, changes) {
  const id = crypto.randomUUID(), patch = validateChanges({ v: 1, changes });
  const bytes = encoder.encode(JSON.stringify(patch));
  try { return { id, data: await seal(key, bytes, 'NUTE/change/v1/' + id) }; } finally { bytes.fill(0); }
}
export async function readOperation(key, operation) {
  if (!uuid.test(operation?.id || '')) throw new Error('Повреждён идентификатор изменения.');
  const bytes = new Uint8Array(await open(key, operation.data, 'NUTE/change/v1/' + operation.id));
  try { return validateChanges(JSON.parse(decoder.decode(bytes))); } finally { bytes.fill(0); }
}
export async function applyOperation(vault, operation, patch) {
  const next = replica(vault); validateChanges(patch);
  if(next.sync.recent.includes(operation.id))return next;
  const removedNotes = new Set(next.sync.removedNotes), removedFolders = new Set(next.sync.removedFolders);
  // Apply folders first even when a caller encoded changes in a different order.
  const changes = [...patch.changes].sort((a,b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1));
  for (const change of changes) {
    const field = change.kind === 'note' ? 'notes' : 'folders', removed = change.kind === 'note' ? removedNotes : removedFolders;
    const index = next[field].findIndex(item => item.id === change.id), current = index < 0 ? null : next[field][index];
    if (change.after === null) {
      if (change.id === 'notes' && change.kind === 'folder') continue;
      removed.add(change.id); if (index >= 0) next[field].splice(index, 1);
      if (change.kind === 'folder') for (const note of next.notes) if (note.folder === change.id) note.folder = 'notes';
      continue;
    }
    if (removed.has(change.id)) continue; // A stale offline edit never revives a permanently removed entity.
    let after = structuredClone(change.after);
    if (change.kind === 'note') {
      if (!next.folders.some(folder => folder.id === after.folder)) after.folder = 'notes';
      if (current && after.deleted !== null) {
        // Deleting an old offline copy keeps the newest contents in Trash.
        after = { ...current, deleted: after.deleted, updated: Math.max(current.updated, after.updated) };
      } else if (current?.deleted !== null && current?.deleted !== undefined && after.deleted === null && !change.restore) {
        continue; // Soft deletion also wins over a stale edit.
      } else if (current && canonical(current) !== canonical(after) && change.before !== await fingerprint(current)) {
        // A stale restore expresses an intent to reopen, not permission to
        // discard content written since its old snapshot. Likewise, an offline
        // unprotected edit cannot remove a PIN installed on another device.
        // Both versions survive; ordered operations choose the same original
        // and conflict identity independently on every device.
        const keepCurrent = change.restore || (current.pin && !after.pin);
        const copy = keepCurrent ? after : current;
        const copyId = 'conflict-' + operation.id + '-' + (await fingerprint(change.id)).slice(0,12);
        if (!next.notes.some(note => note.id === copyId) && !removedNotes.has(copyId)) next.notes.push({ ...copy, id: copyId, title: (copy.title || 'Заметка').slice(0, 270) + ' (конфликт)' });
        if (keepCurrent) {
          after = change.restore ? { ...current, deleted: null, updated: Math.max(current.updated, after.updated) } : current;
        }
      }
    }
    if (index < 0) next[field].push(after); else next[field][index] = after;
  }
  next.sync = { removedNotes: [...removedNotes], removedFolders: [...removedFolders], recent:[...next.sync.recent,operation.id].slice(-5000) };
  return replica(next);
}
