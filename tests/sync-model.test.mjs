import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyVault, makeNote, validateVault } from '../public/assets/model.js';
import { replica, changesBetween, applyOperation } from '../public/assets/sync-model.js';
import { preparePin, sealPinContent, openPinContent } from '../public/assets/note-pin.js';

const operation = () => ({ id: crypto.randomUUID() });
const apply = async (current, before, after, op = operation()) => applyOperation(current, op, { v: 1, changes: await changesBetween(before, after) });
function initial({ deleted = null } = {}) {
  const vault = emptyVault();
  vault.notes.push({ ...makeNote(), title: 'Shared note', body: 'Original text', updated: 1000, deleted });
  return replica(vault);
}

test('stale concurrent restore preserves the newer original and an active conflict copy', async () => {
  const before = initial({ deleted: 1000 });
  const fresh = structuredClone(before), stale = structuredClone(before);
  fresh.notes[0].deleted = null; fresh.notes[0].body = 'New text after restoring'; fresh.notes[0].updated = 2000;
  stale.notes[0].deleted = null; stale.notes[0].updated = 2100;
  const current = await apply(before, before, fresh);
  const op = operation(), patch = { v: 1, changes: await changesBetween(before, stale) };
  const merged = await applyOperation(current, op, patch);
  assert.equal(merged.notes[0].id, before.notes[0].id);
  assert.equal(merged.notes[0].body, 'New text after restoring');
  assert.deepEqual(merged.notes.map(note => note.body).sort(), ['New text after restoring', 'Original text']);
  assert.ok(merged.notes.every(note => note.deleted === null));
  assert.match(merged.notes[1].title, /\(конфликт\)$/);
  assert.deepEqual(await applyOperation(current, op, patch), merged, 'independent peers derive identical conflict identities');
  assert.deepEqual(await applyOperation(merged, op, patch), merged, 'replaying restore never creates a duplicate copy');
});

test('stale restore after another restore-edit-delete cycle retains both versions', async () => {
  const before = initial({ deleted: 1000 });
  const edited = structuredClone(before); edited.notes[0].deleted = null; edited.notes[0].body = 'Edited before deleting again'; edited.notes[0].updated = 2000;
  const active = await apply(before, before, edited);
  const deleted = structuredClone(active); deleted.notes[0].deleted = 3000;
  const current = await apply(active, active, deleted);
  const stale = structuredClone(before); stale.notes[0].deleted = null; stale.notes[0].updated = 4000;
  const merged = await apply(current, before, stale);
  assert.equal(merged.notes[0].body, 'Edited before deleting again');
  assert.equal(merged.notes[0].deleted, null, 'explicit restore activates the latest version');
  assert.deepEqual(merged.notes.map(note => note.body).sort(), ['Edited before deleting again', 'Original text']);
});

test('stale unprotected edit cannot silently remove a remotely installed PIN', async () => {
  const before = initial(), protectedCopy = structuredClone(before), staleEdit = structuredClone(before);
  const pin = await preparePin('0042');
  protectedCopy.notes[0].body = '';
  protectedCopy.notes[0].pin = { v: 1, id: pin.id, salt: pin.salt, data: await sealPinContent(pin.key, pin.id, { body: 'Original text' }) };
  protectedCopy.notes[0].updated = 2000;
  staleEdit.notes[0].body = 'Offline unprotected edit'; staleEdit.notes[0].updated = 2500;
  const current = await apply(before, before, protectedCopy);
  const op = operation(), patch = { v: 1, changes: await changesBetween(before, staleEdit) };
  const merged = await applyOperation(current, op, patch);
  assert.equal(merged.notes[0].id, before.notes[0].id);
  assert.deepEqual(merged.notes[0].pin, current.notes[0].pin, 'original keeps the exact encrypted payload and PIN identity');
  assert.equal(merged.notes[0].body, '');
  assert.equal((await openPinContent(pin.key, merged.notes[0].pin)).body, 'Original text');
  assert.equal(merged.notes[1].body, 'Offline unprotected edit', 'offline contents are retained visibly as a separate conflict version');
  assert.equal(merged.notes[1].pin, undefined);
  assert.deepEqual(await applyOperation(current, op, patch), merged);
  const remove = structuredClone(merged); delete remove.notes[0].pin; remove.notes[0].body = 'Original text'; remove.notes[0].updated = 3000;
  const explicit = await apply(merged, merged, remove);
  assert.equal(explicit.notes[0].pin, undefined, 'matching-current explicit PIN removal remains allowed');
  assert.equal(explicit.notes.length, 2);
});

test('ordinary concurrent edits retain both versions and deletion still dominates stale updates', async () => {
  const before = initial(), a = structuredClone(before), b = structuredClone(before);
  a.notes[0].body = 'A'; b.notes[0].body = 'B';
  const first = await apply(before, before, a), merged = await apply(first, before, b);
  assert.equal(merged.notes[0].body, 'B');
  assert.deepEqual(merged.notes.map(note => note.body).sort(), ['A', 'B']);
  const trash = structuredClone(first); trash.notes[0].deleted = 4000;
  const deleted = await apply(first, first, trash);
  const stale = await apply(deleted, before, b);
  assert.equal(stale.notes.length, 1); assert.equal(stale.notes[0].deleted, 4000); assert.equal(stale.notes[0].body, 'A');
  const purged = structuredClone(deleted); purged.notes = [];
  const removed = await apply(deleted, deleted, purged);
  const restored = structuredClone(deleted); restored.notes[0].deleted = null;
  assert.equal((await apply(removed, deleted, restored)).notes.length, 0, 'permanent deletion remains authoritative');
});

test('offline merges can read bounded note overflow and generate a shrinking recovery operation', async () => {
  const before = initial(); before.notes = Array.from({ length: 5000 }, (_, index) => ({ ...before.notes[0], id: `note-${index}` }));
  validateVault(before);
  const incoming = { ...before.notes[0], id: 'new-from-another-offline-peer' };
  const merged = await applyOperation(before, operation(), { v: 1, changes: [{ kind: 'note', id: incoming.id, before: null, after: incoming }] });
  assert.equal(merged.notes.length, 5001);
  assert.throws(() => validateVault(merged), /формат/, 'normal callers retain their original limit');
  assert.equal(validateVault(merged, { recovery: true }), merged);
  const shrunk = structuredClone(merged); shrunk.notes.pop();
  const changes = await changesBetween(merged, shrunk);
  assert.equal(changes.length, 1); assert.equal(changes[0].after, null);
  assert.equal((await applyOperation(merged, operation(), { v: 1, changes })).notes.length, 5000);
  const oversized = structuredClone(merged); oversized.notes = Array.from({ length: 10001 }, (_, index) => ({ ...incoming, id: `excess-${index}` }));
  assert.throws(() => replica(oversized), /формат/, 'recovery allowance remains bounded');
});

test('folder overflow remains recoverable while ordinary validation stays at one hundred folders', async () => {
  const before = initial();
  for (let i = 1; i < 100; i++) before.folders.push({ id: `folder-${i}`, name: `Folder ${i}` });
  const folder = { id: 'offline-folder', name: 'From another peer' };
  const merged = await applyOperation(before, operation(), { v: 1, changes: [{ kind: 'folder', id: folder.id, before: null, after: folder }] });
  assert.equal(merged.folders.length, 101);
  assert.throws(() => validateVault(merged), /формат/);
  const shrunk = structuredClone(merged); shrunk.folders.pop();
  assert.equal((await apply(merged, merged, shrunk)).folders.length, 100);
  const oversized = structuredClone(merged); for (let i = 101; i <= 200; i++) oversized.folders.push({ id: `excess-${i}`, name: 'Excess' });
  assert.throws(() => replica(oversized), /формат/);
});
