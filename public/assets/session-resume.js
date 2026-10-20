import { fromBase64, toBase64, seal, open } from './crypto.js?v=0.4.0';

export const resumeName = 'nute:session-resume:v1';
const context = 'NUTE/session-resume/v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

async function sessionKey(secret) {
  const bytes = fromBase64(secret);
  try {
    if (bytes.length !== 32) throw new Error('Некорректный ключ сеанса.');
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } finally { bytes.fill(0); }
}

// Only this encrypted capsule is kept in the tab. Its wrapping secret stays in
// the authenticated HTTP session; neither the capsule nor the vault key is sent
// to the server. The master password and its derived keys are never persisted.
export async function createResumeCapsule(wrappingKey, result, salt) {
  const bytes = new Uint8Array(await open(wrappingKey, result.wrappedKey, 'NUTE/key/v1'));
  let payload;
  try {
    if (bytes.length !== 32 || fromBase64(salt).length !== 16) throw new Error('Некорректный ключ хранилища.');
    payload = encoder.encode(JSON.stringify({ key: toBase64(bytes), salt, email: result.email, wrappedKey: result.wrappedKey }));
    return { v: 1, envelope: await seal(await sessionKey(result.resumeSecret), payload, context) };
  } finally { bytes.fill(0); payload?.fill(0); }
}

export async function openResumeCapsule(capsule, result) {
  if (capsule?.v !== 1) throw new Error('Неподдерживаемый сеанс.');
  const payload = new Uint8Array(await open(await sessionKey(result.resumeSecret), capsule.envelope, context));
  let bytes;
  try {
    const data = JSON.parse(decoder.decode(payload));
    if (data.email !== result.email || fromBase64(data.salt).length !== 16
      || data.wrappedKey?.v !== result.wrappedKey?.v || data.wrappedKey?.iv !== result.wrappedKey?.iv
      || data.wrappedKey?.ciphertext !== result.wrappedKey?.ciphertext) throw new Error('Сеанс принадлежит другому хранилищу.');
    bytes = fromBase64(data.key);
    if (bytes.length !== 32) throw new Error('Некорректный ключ хранилища.');
    const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { key, salt: data.salt };
  } finally { payload.fill(0); bytes?.fill(0); }
}

export function clearResume(storage = sessionStorage) {
  try { storage.removeItem(resumeName); } catch { /* Storage may be unavailable. */ }
}
export function readResume(storage = sessionStorage) {
  try {
    const text = storage.getItem(resumeName);
    if (!text) return null;
    if (text.length > 4096) throw new Error('Invalid capsule');
    const capsule = JSON.parse(text);
    if (capsule?.v !== 1 || !capsule.envelope) throw new Error('Invalid capsule');
    return capsule;
  } catch { clearResume(storage); return null; }
}
export function writeResume(capsule, storage = sessionStorage) {
  try { storage.setItem(resumeName, JSON.stringify(capsule)); return true; }
  catch { clearResume(storage); return false; }
}
