import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyVault, makeNote, validateVault } from '../public/assets/model.js';
import { renameFolder, removeFolder } from '../public/assets/folders.js';
test('rename retains identity, notes and literal user text', () => {
  const vault = emptyVault(); vault.folders.push({ id:'work', name:'Работа' }); const note = makeNote('work'); vault.notes.push(note);
  renameFolder(vault, 'work', '  <img onerror=alert(1)>  ');
  assert.equal(vault.folders[1].name, '<img onerror=alert(1)>'); assert.equal(note.folder, 'work'); validateVault(vault);
  assert.throws(() => renameFolder(vault, 'notes', 'Other')); assert.throws(() => renameFolder(vault, 'work', ' '));
});
test('folder removal preserves all active and trashed notes, rich content, dates and IDs', () => {
  const vault = emptyVault(); vault.folders.push({ id:'work', name:'Работа' });
  vault.notes.push({ ...makeNote('work'), body:'active' }, { ...makeNote('work'), body:'trash', deleted:1 });
  const before = structuredClone(vault.notes);
  removeFolder(vault, 'work');
  assert.deepEqual(vault.notes, before.map(note => ({ ...note, folder:'notes' }))); validateVault(vault);
  assert.throws(() => removeFolder(vault, 'notes')); assert.throws(() => removeFolder(vault, 'missing'));
});
