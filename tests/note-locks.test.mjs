import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePin, sealPinContent, openPinContent } from '../public/assets/note-pin.js';
import { createNoteLocks } from '../public/assets/note-locks.js';
import { emptyVault, makeNote, validateVault } from '../public/assets/model.js';
import { plainDocument } from '../public/assets/document.js';

async function fixture() {
  const prepared = await preparePin('0042'), content = { body: 'Private original', document: plainDocument('Private original') };
  const note = { ...makeNote(), pin: { v: 1, id: prepared.id, salt: prepared.salt, data: await sealPinContent(prepared.key, prepared.id, content) } };
  const vault = emptyVault(); vault.notes.push(note); const locks = createNoteLocks(); locks.open(note, prepared.key, content);
  return { key: prepared.key, note, vault, locks };
}
test('open PIN content never enters the persisted vault; snapshots and close preserve latest rich edits', async () => {
  const { key, note, vault, locks } = await fixture();
  locks.update(note, { body: 'Private edited', document: plainDocument('Private edited') });
  const snapshot = validateVault(await locks.snapshot(vault));
  assert.equal(note.body, ''); assert.equal(Object.hasOwn(note, 'document'), false);
  assert.equal(JSON.stringify(snapshot).includes('Private'), false);
  assert.equal((await openPinContent(key, snapshot.notes[0].pin)).body, 'Private edited');
  locks.update(note, { body: 'Last unsaved edit' }); await locks.close(note);
  assert.equal(locks.get(note), null);
  assert.equal((await openPinContent(key, note.pin)).body, 'Last unsaved edit');
});
test('a snapshot captures its own revision while later edits and clearing cannot be resurrected', async () => {
  const { key, note, vault, locks } = await fixture();
  locks.update(note, { body: 'First revision' }); const first = locks.snapshot(vault);
  locks.update(note, { body: 'Second revision' }); const second = locks.snapshot(vault);
  assert.equal((await openPinContent(key, (await first).notes[0].pin)).body, 'First revision');
  assert.equal((await openPinContent(key, (await second).notes[0].pin)).body, 'Second revision');
  assert.equal((await openPinContent(key, note.pin)).body, 'Second revision');
  locks.update(note, { body: 'In-flight at logout' }); const pending = locks.snapshot(vault); locks.clear();
  assert.equal((await openPinContent(key, (await pending).notes[0].pin)).body, 'In-flight at logout');
  assert.equal(locks.get(note), null);
  assert.equal((await openPinContent(key, note.pin)).body, 'Second revision');
});
test('closing a cloned note after an in-flight seal preserves its latest content for subsequent saves', async () => {
  const { key, note, vault, locks } = await fixture();
  locks.update(note, { body: 'Latest before import' });
  const saving = locks.snapshot(vault), merged = structuredClone(vault);
  await saving; await locks.snapshot(merged); await locks.close(merged.notes[0]);
  assert.equal(locks.get(merged.notes[0]), null);
  const laterSave = await locks.snapshot(merged);
  assert.equal((await openPinContent(key, laterSave.notes[0].pin)).body, 'Latest before import');
});

