import { validateDocument, documentText } from './document.js?v=0.4.0';
import { validatePin } from './note-pin.js?v=0.4.0';
export function emptyVault() { return { version: 3, folders: [{ id: 'notes', name: 'Заметки' }], notes: [] }; }
const validTimestamp = value => Number.isFinite(value) && Math.abs(value) <= 8640000000000000;
export function validateVault(vault, { recovery = false } = {}) {
  // Concurrent offline peers can each remain below the normal creation limit
  // while their merged replica exceeds it. Read that bounded recovery state so
  // the owner can delete/move items; ordinary callers keep the original limits.
  const maxNotes = recovery ? 10000 : 5000, maxFolders = recovery ? 200 : 100;
  if (!vault || ![1, 2, 3].includes(vault.version) || !Array.isArray(vault.folders) || !Array.isArray(vault.notes) || vault.notes.length > maxNotes || vault.folders.length > maxFolders) throw new Error('Неподдерживаемый формат заметок.');
  const ids = new Set();
  for (const folder of vault.folders) {
    if (!folder || typeof folder.id !== 'string' || ids.has(folder.id) || typeof folder.name !== 'string' || folder.name.length > 120) throw new Error('Повреждён список папок.');
    ids.add(folder.id);
  }
  if (!ids.has('notes')) throw new Error('Основная папка отсутствует.');
  const noteIds = new Set();
  for (const note of vault.notes) {
    if (!note || typeof note.id !== 'string' || noteIds.has(note.id) || !ids.has(note.folder) || typeof note.title !== 'string' || note.title.length > 300 || typeof note.body !== 'string' || note.body.length > 500000 || !validTimestamp(note.updated) || typeof note.pinned !== 'boolean' || (note.deleted !== null && !validTimestamp(note.deleted))) throw new Error('Повреждены данные заметки.');
    noteIds.add(note.id);
    if (Object.hasOwn(note, 'pin')) {
      if (vault.version < 3 || note.body !== '' || Object.hasOwn(note, 'document')) throw new Error('Содержимое защищённой заметки должно быть зашифровано.');
      validatePin(note.pin);
    }
    if (note.document !== undefined) {
      validateDocument(note.document);
      if (documentText(note.document) !== note.body) throw new Error('Текст заметки не соответствует форматированию.');
    }
  }
  return vault;
}
export function visibleNotes(vault, folder = 'all', search = '') {
  const query = search.trim().toLocaleLowerCase('ru');
  return vault.notes.filter(note => (folder === 'trash' ? note.deleted !== null : note.deleted === null && (folder === 'all' || note.folder === folder)) && (!query || `${note.title}\n${note.pin ? '' : note.body}`.toLocaleLowerCase('ru').includes(query)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated - a.updated);
}
export const noteTitle = note => note.title.trim() || 'Новая заметка';
export function makeNote(folder = 'notes') { return { id: crypto.randomUUID(), folder, title: '', body: '', pinned: false, deleted: null, updated: Date.now() }; }
