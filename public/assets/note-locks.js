import { sealPinContent } from './note-pin.js?v=0.4.0';

// Open content lives only in this map. The persisted vault always contains
// ciphertext, including while a protected note is being edited or exported.
export function createNoteLocks() {
  const entries = new Map();
  const get = note => note?.pin && entries.get(note.id)?.pinId === note.pin.id ? entries.get(note.id) : null;
  function open(note, key, content) {
    entries.set(note.id, { pinId: note.pin.id, key, content: structuredClone(content), revision: 0, sealedRevision: 0, data: note.pin.data, sealing: null });
  }
  function update(note, content) {
    const entry = get(note);
    if (!entry) throw new Error('Сначала откройте заметку PIN-кодом.');
    entry.content = structuredClone(content); entry.revision++;
  }
  async function serialize(note, entry) {
    const revision = entry.revision, pin = note.pin;
    if (entry.sealedRevision === revision) return entry.data;
    if (entry.sealing?.revision === revision) return entry.sealing.promise;
    const content = structuredClone(entry.content);
    const promise = sealPinContent(entry.key, entry.pinId, content).then(data => {
      if (get(note) === entry && entry.revision === revision && note.pin === pin) {
        entry.data = data; entry.sealedRevision = revision; note.pin.data = data;
      }
      return data;
    });
    entry.sealing = { revision, promise };
    return promise;
  }
  async function snapshot(vault) {
    const copy = structuredClone(vault);
    copy.version = 3;
    // Capture every serialization before yielding so revisions remain coherent.
    const work = vault.notes.map((note, index) => {
      const entry = get(note);
      return entry ? serialize(note, entry).then(data => { copy.notes[index].pin.data = data; }) : null;
    });
    await Promise.all(work);
    return copy;
  }
  async function close(note) {
    const entry = get(note); if (!entry) return;
    const revision = entry.revision;
    const data = await serialize(note, entry);
    if (get(note) !== entry) return;
    if (entry.revision !== revision) throw new Error('Заметка изменилась. Повторите закрытие.');
    // Import/merge can replace the note object while a seal is in flight.
    // Persist the returned ciphertext onto this exact note before dropping RAM.
    note.pin.data = data;
    entries.delete(note.id);
  }
  function reconcile(vault) {
    for (const [id, entry] of entries) {
      const note = vault.notes.find(item => item.id === id);
      if (!note?.pin || note.pin.id !== entry.pinId || JSON.stringify(note.pin.data) !== JSON.stringify(entry.data)) entries.delete(id);
    }
  }
  return { get, open, update, snapshot, close, reconcile, forget: note => entries.delete(note.id), clear: () => entries.clear() };
}
