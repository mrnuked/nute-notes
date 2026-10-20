import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync, hkdfSync } from 'node:crypto';
import { deriveKeys, randomSalt, createVaultKey, unwrapVaultKey, encryptVault, decryptVault, fromBase64, toBase64, open } from '../public/assets/crypto.js';

test('browser derivation agrees with independent Node crypto PBKDF2/HKDF', async () => {
  const salt = 'AAECAwQFBgcICQoLDA0ODw==';
  const result = await deriveKeys('длинный пароль: 🗝️ Correct Horse', salt);
  const seed = pbkdf2Sync('длинный пароль: 🗝️ Correct Horse', Buffer.from(salt, 'base64'), 600000, 32, 'sha256');
  const proof = hkdfSync('sha256', seed, Buffer.alloc(32), 'NUTE/auth/v1', 32);
  assert.equal(result.authProof, Buffer.from(proof).toString('base64'));
  assert.equal(result.wrappingKey.extractable, false);
});
test('wrapped key and vault roundtrip; ciphertext randomized, bound and tamper evident', async () => {
  const { wrappingKey } = await deriveKeys('test master secret long enough', randomSalt());
  const { key, wrappedKey } = await createVaultKey(wrappingKey);
  const restored = await unwrapVaultKey(wrappingKey, wrappedKey);
  const payload = { title: '<script>alert(1)</script>', body: 'Секрет: 🗝️\nlong password' };
  const a = await encryptVault(key, payload), b = await encryptVault(key, payload);
  assert.notEqual(a.iv, b.iv); assert.notEqual(a.ciphertext, b.ciphertext);
  assert.deepEqual(await decryptVault(restored, a), payload);
  assert.equal(restored.extractable, false);
  const bytes = fromBase64(a.ciphertext); bytes[0] ^= 1;
  await assert.rejects(decryptVault(key, { ...a, ciphertext: toBase64(bytes) }));
  await assert.rejects(open(key, a, 'NUTE/key/v1'));
  const wrong = await deriveKeys('different master password', randomSalt());
  await assert.rejects(unwrapVaultKey(wrong.wrappingKey, wrappedKey));
  await assert.rejects(decryptVault(key, { ...a, v: 9 }));
});
