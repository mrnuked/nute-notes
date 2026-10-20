import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePin, derivePin, sealPinContent, openPinContent, validatePin, PIN_LENGTH } from '../public/assets/note-pin.js';
import { deriveKeys, fromBase64, toBase64, seal } from '../public/assets/crypto.js';
import { documentText } from '../public/assets/document.js';

const salt = 'AAECAwQFBgcICQoLDA0ODw==';
const id = 'e441e5d0-44a9-45b0-b685-f38171afdb15';

test('PIN is exactly four ASCII digits and preserves leading zeroes', async () => {
  assert.equal(PIN_LENGTH, 4);
  for (const input of ['', '123', '12345', '12a4', '１２３４', '١٢٣٤', ' 1234', '1234\n', 1234, null]) {
    await assert.rejects(preparePin(input), /4|цифр/);
    await assert.rejects(derivePin(input, salt), /4|цифр/);
  }
  const value = await derivePin('0007', salt);
  const independent = await deriveKeys('0007', salt);
  assert.equal(value.authProof, independent.authProof);
  assert.equal(value.key.extractable, false);
  assert.deepEqual(value.key.usages, ['encrypt', 'decrypt']);
  const prepared = await preparePin('0000');
  assert.match(prepared.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(fromBase64(prepared.salt).length, 16);
  assert.equal(prepared.key.extractable, false);
  assert.equal((await derivePin('0000', prepared.salt)).authProof, prepared.authProof);
});

test('PIN content preserves formatting, checklists and tables without plaintext persisted fields', async () => {
  const prepared = await preparePin('0123');
  const paragraph = value => ({ type: 'paragraph', content: [{ type: 'text', text: value }] });
  const document = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Секрет', marks: [{ type: 'bold' }] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraph('Готово')] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph('Пароль 🗝️')] }] }] },
  ] };
  const content = { body: documentText(document), document };
  const data = await sealPinContent(prepared.key, prepared.id, content);
  const pin = { v: 1, id: prepared.id, salt: prepared.salt, data };
  assert.equal(validatePin(pin), pin);
  assert.deepEqual(await openPinContent(prepared.key, JSON.parse(JSON.stringify(pin))), content);
  assert.equal(JSON.stringify(pin).includes('Секрет'), false);
  assert.deepEqual(Object.keys(pin.data).sort(), ['ciphertext', 'iv', 'v']);
  const repeated = await sealPinContent(prepared.key, prepared.id, content);
  assert.notEqual(repeated.iv, data.iv);
  assert.notEqual(repeated.ciphertext, data.ciphertext);
  const plain = await sealPinContent(prepared.key, prepared.id, { body: 'Обычная заметка\n<literal>' });
  assert.deepEqual(await openPinContent(prepared.key, { ...pin, data: plain }), { body: 'Обычная заметка\n<literal>' });
});

test('wrong PIN, altered ciphertext and another note binding cannot unlock content', async () => {
  const { key } = await derivePin('0042', salt);
  const data = await sealPinContent(key, id, { body: 'private content' });
  const pin = { v: 1, id, salt, data };
  const wrong = await derivePin('0043', salt);
  await assert.rejects(openPinContent(wrong.key, pin));
  const bytes = fromBase64(data.ciphertext); bytes[0] ^= 1;
  await assert.rejects(openPinContent(key, { ...pin, data: { ...data, ciphertext: toBase64(bytes) } }));
  await assert.rejects(openPinContent(key, { ...pin, id: '39e573f8-520f-427b-aeec-baf19c03dcad' }));
  await assert.rejects(openPinContent(key, { ...pin, v: 2 }));
  await assert.rejects(sealPinContent(key, '../invalid-id', { body: 'X' }));
});

test('envelopes and decrypted payloads are validated before editor use', async () => {
  const { key } = await derivePin('1234', salt);
  const data = await sealPinContent(key, id, { body: '' });
  const pin = { v: 1, id, salt, data };
  for (const invalid of [
    null, [], { ...pin, password: '1234' }, { ...pin, id: 'invalid' }, { ...pin, id: 'e441e5d0-44a9-15b0-b685-f38171afdb15' },
    { ...pin, salt: toBase64(new Uint8Array(15)) }, { ...pin, salt: `${salt.slice(0, -3)}x==` },
    { ...pin, data: { ...data, v: 2 } }, { ...pin, data: { ...data, body: 'plaintext' } },
    { ...pin, data: { ...data, iv: toBase64(new Uint8Array(11)) } },
    { ...pin, data: { ...data, ciphertext: '' } }, { ...pin, data: { ...data, ciphertext: 'A'.repeat(2800004) } },
  ]) assert.throws(() => validatePin(invalid));
  const validDocument = { type: 'doc', content: [{ type: 'paragraph' }] };
  for (const content of [null, [], { body: 7 }, { body: '', title: 'extra' }, { body: 'x'.repeat(500001) }, { body: 'mismatch', document: validDocument }, { body: '', document: { type: 'doc', content: [{ type: 'image' }] } }]) {
    await assert.rejects(sealPinContent(key, id, content));
    const poisoned = await seal(key, new TextEncoder().encode(JSON.stringify(content)), `NUTE/PIN-note/v1/${id}`);
    await assert.rejects(openPinContent(key, { ...pin, data: poisoned }));
  }
  await assert.rejects(sealPinContent(key, id, { body: '\u0000'.repeat(500000) }), /размер|больш/);
  const invalidUtf8 = await seal(key, new Uint8Array([0xc3, 0x28]), `NUTE/PIN-note/v1/${id}`);
  await assert.rejects(openPinContent(key, { ...pin, data: invalidUtf8 }));
});
