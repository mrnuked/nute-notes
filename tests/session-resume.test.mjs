import test from 'node:test';
import assert from 'node:assert/strict';
import { createResumeCapsule, openResumeCapsule, readResume, writeResume, clearResume, resumeName } from '../public/assets/session-resume.js';
import { createVaultKey, randomSalt, toBase64, encryptVault, decryptVault } from '../public/assets/crypto.js';

async function fixture() {
  const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const { key, wrappedKey } = await createVaultKey(wrappingKey);
  const salt = randomSalt();
  const result = { email: 'private-owner@example.com', wrappedKey, resumeSecret: toBase64(crypto.getRandomValues(new Uint8Array(32))) };
  return { key, wrappingKey, salt, result, capsule: await createResumeCapsule(wrappingKey, result, salt) };
}
test('reload capsule recovers a nonextractable vault key without persisting account data or session secret', async () => {
  const f = await fixture();
  const saved = JSON.stringify(f.capsule);
  assert.ok(!saved.includes(f.result.email) && !saved.includes(f.result.resumeSecret) && !saved.includes(f.salt));
  const reopened = await openResumeCapsule(JSON.parse(saved), f.result);
  assert.equal(reopened.key.extractable, false);
  assert.equal(reopened.salt, f.salt);
  const vault = { title: 'Private note, never present in capsule' };
  assert.deepEqual(await decryptVault(reopened.key, await encryptVault(f.key, vault)), vault);
  await assert.rejects(crypto.subtle.exportKey('raw', reopened.key));
});
test('other sessions, modified ciphertext and other vaults cannot reopen a capsule', async () => {
  const a = await fixture(), b = await fixture();
  await assert.rejects(openResumeCapsule(a.capsule, { ...a.result, resumeSecret: b.result.resumeSecret }));
  await assert.rejects(openResumeCapsule(a.capsule, { ...a.result, email: 'someone-else@example.com' }));
  await assert.rejects(openResumeCapsule(a.capsule, { ...a.result, wrappedKey: b.result.wrappedKey }));
  const damaged = structuredClone(a.capsule);
  damaged.envelope.ciphertext = (damaged.envelope.ciphertext[0] === 'A' ? 'B' : 'A') + damaged.envelope.ciphertext.slice(1);
  await assert.rejects(openResumeCapsule(damaged, a.result));
});
test('storage failures and invalid capsules fail closed', async () => {
  const f = await fixture(), data = new Map();
  const storage = { getItem: k => data.get(k), setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) };
  assert.equal(writeResume(f.capsule, storage), true);
  assert.deepEqual(readResume(storage), f.capsule);
  clearResume(storage); assert.equal(readResume(storage), null);
  for (const bad of ['{broken', 'x'.repeat(4097), JSON.stringify({v:9})]) {
    data.set(resumeName, bad); assert.equal(readResume(storage), null); assert.equal(data.has(resumeName), false);
  }
  storage.setItem = () => { throw new Error('Storage unavailable'); };
  assert.equal(writeResume(f.capsule, storage), false);
});
