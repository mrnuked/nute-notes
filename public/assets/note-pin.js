import { deriveKeys, randomSalt, seal, open, fromBase64, toBase64 } from './crypto.js?v=0.4.0';
import { validateDocument, documentText } from './document.js?v=0.4.0';

export const PIN_LENGTH = 4;
const MAX_CIPHERTEXT = 2800000;
const MAX_CONTENT_BYTES = 2099984; // Existing envelope limit, less the AES-GCM tag.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const invalid = () => { throw new Error('Повреждены данные защищённой заметки.'); };

function objectKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  for (const name of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (typeof name !== 'string' || !allowed.includes(name) || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
  }
}

function base64(value, bytes) {
  if (typeof value !== 'string' || value.length !== Math.ceil(bytes / 3) * 4) invalid();
  const decoded = fromBase64(value);
  if (decoded.length !== bytes || toBase64(decoded) !== value) invalid();
}

function validateId(id) {
  if (typeof id !== 'string' || id.length !== 36 || !UUID_V4.test(id)) invalid();
}

function validateContent(content) {
  objectKeys(content, ['body', 'document']);
  if (typeof content.body !== 'string' || content.body.length > 500000) invalid();
  if (content.document !== undefined) {
    validateDocument(content.document);
    if (documentText(content.document) !== content.body) invalid();
  }
  return content;
}

export function validatePin(pin) {
  objectKeys(pin, ['v', 'id', 'salt', 'data']);
  if (pin.v !== 1) invalid();
  validateId(pin.id);
  base64(pin.salt, 16);
  objectKeys(pin.data, ['v', 'iv', 'ciphertext']);
  if (pin.data.v !== 1) invalid();
  base64(pin.data.iv, 12);
  const ciphertext = pin.data.ciphertext;
  if (typeof ciphertext !== 'string' || ciphertext.length < 24 || ciphertext.length > MAX_CIPHERTEXT) invalid();
  const bytes = fromBase64(ciphertext);
  if (bytes.length < 16 || toBase64(bytes) !== ciphertext) invalid();
  return pin;
}

/** Four digits provide casual privacy, not resistance to offline enumeration after vault compromise.
 * Normal online attempts are checked and limited by the server before opening this inner envelope. */
export async function derivePin(pin, salt) {
  if (typeof pin !== 'string' || pin.length !== PIN_LENGTH || !/^[0-9]{4}$/.test(pin)) throw new Error('PIN должен состоять ровно из 4 цифр.');
  base64(salt, 16);
  const { authProof, wrappingKey } = await deriveKeys(pin, salt);
  return { authProof, key: wrappingKey };
}

export async function preparePin(pin) {
  const salt = randomSalt();
  const derived = await derivePin(pin, salt);
  return { id: crypto.randomUUID(), salt, ...derived };
}

export async function sealPinContent(key, id, content) {
  validateId(id);
  validateContent(content);
  const bytes = encoder.encode(JSON.stringify(content));
  try {
    if (bytes.length > MAX_CONTENT_BYTES) throw new Error('Защищённая заметка слишком большая: превышен допустимый размер.');
    return await seal(key, bytes, `NUTE/PIN-note/v1/${id}`);
  } finally { bytes.fill(0); }
}

export async function openPinContent(key, pin) {
  validatePin(pin);
  const bytes = new Uint8Array(await open(key, pin.data, `NUTE/PIN-note/v1/${pin.id}`));
  try { return validateContent(JSON.parse(decoder.decode(bytes))); }
  finally { bytes.fill(0); }
}
