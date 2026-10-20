import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyVault, makeNote, visibleNotes, validateVault } from '../public/assets/model.js';
test('folders, trash, Cyrillic search and pinned ordering preserve private note semantics', () => {
  const vault = emptyVault();
  const a = { ...makeNote(), title: 'Планы', updated: 1, pinned: true };
  const b = { ...makeNote(), body: 'Купить молоко', updated: 3 };
  const c = { ...makeNote(), title: 'Удалено', updated: 4, deleted: 5 };
  vault.notes.push(a,b,c); validateVault(vault);
  assert.deepEqual(visibleNotes(vault).map(n=>n.id), [a.id,b.id]);
  assert.equal(visibleNotes(vault, 'all', 'МОЛОКО')[0].id, b.id);
  assert.deepEqual(visibleNotes(vault,'trash').map(n=>n.id), [c.id]);
});
test('malformed backup cannot inject invalid fields or duplicate identifiers', () => {
  assert.throws(()=>validateVault({ version: 5, folders: [], notes: [] }));
  const vault = emptyVault(); const note = makeNote();
  vault.notes.push(note, structuredClone(note));
  assert.throws(()=>validateVault(vault));
});

test('backup timestamps must be representable by the editor date formatter', () => {
  for (const value of [1e100, -1e100, 8640000000000001, -8640000000000001, Infinity, NaN]) {
    const vault = emptyVault();
    const note = makeNote();
    vault.notes.push({ ...note, updated: value });
    assert.throws(() => validateVault(vault), /Повреждены данные заметки/);
    vault.notes[0] = { ...note, deleted: value };
    assert.throws(() => validateVault(vault), /Повреждены данные заметки/);
  }
  for (const value of [-8640000000000000, 0, Date.now(), 8640000000000000]) {
    const vault = emptyVault();
    vault.notes.push({ ...makeNote(), updated: value, deleted: value });
    assert.equal(validateVault(vault), vault);
    assert.doesNotThrow(() => new Intl.DateTimeFormat('ru-RU').format(value));
  }
});

test('version 3 PIN notes persist only an encrypted payload and remain searchable by visible title', () => {
  const pin = { v: 1, id: 'e441e5d0-44a9-45b0-b685-f38171afdb15', salt: 'AAECAwQFBgcICQoLDA0ODw==', data: { v: 1, iv: 'AAECAwQFBgcICQoL', ciphertext: 'AAECAwQFBgcICQoLDA0ODw==' } };
  const vault = emptyVault();
  assert.equal(vault.version, 3);
  const note = { ...makeNote(), title: 'Личный доступ', pin };
  vault.notes.push(note);
  assert.equal(validateVault(vault), vault);
  assert.equal(visibleNotes(vault, 'all', 'ЛИЧНЫЙ')[0].id, note.id);
  assert.equal(visibleNotes(vault, 'all', pin.data.ciphertext).length, 0);
  assert.equal(visibleNotes({ ...vault, notes: [{ ...note, body: 'accidental transient plaintext' }] }, 'all', 'transient').length, 0);
  for (const changed of [{ body: 'plaintext' }, { document: { type: 'doc', content: [{ type: 'paragraph' }] } }, { document: undefined }, { pin: null }, { pin: { ...pin, password: '1234' } }]) {
    assert.throws(() => validateVault({ ...vault, notes: [{ ...note, ...changed }] }));
  }
  for (const version of [1, 2]) {
    assert.throws(() => validateVault({ ...vault, version }));
    assert.doesNotThrow(() => validateVault({ ...vault, version, notes: [makeNote()] }));
  }
  // Backup recovery may copy a note under a new note ID; its encryption binding stays stable.
  assert.doesNotThrow(() => validateVault({ ...vault, notes: [note, { ...note, id: crypto.randomUUID() }] }));
});
