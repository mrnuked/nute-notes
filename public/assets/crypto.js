const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const ITERATIONS = 600000;
export const SYNC_VAULT_BYTES = 16 * 1024 * 1024;
export const RECOVERY_VAULT_BYTES = 64 * 1024 * 1024;
export const vaultCiphertextSize = vault => 4 * Math.ceil((encoder.encode(JSON.stringify(vault)).length + 16) / 3);
export function toBase64(bytes) {
  const value = new Uint8Array(bytes), chunks = [];
  for (let offset = 0; offset < value.length; offset += 32768) chunks.push(String.fromCharCode(...value.subarray(offset, offset + 32768)));
  return btoa(chunks.join(''));
}
export function fromBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4) throw new Error('Некорректные зашифрованные данные.');
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
export const randomSalt = () => toBase64(crypto.getRandomValues(new Uint8Array(16)));
export async function deriveKeys(password, salt) {
  if (typeof password !== 'string' || password.length > 1024 || fromBase64(salt).length !== 16) throw new Error('Некорректные параметры ключа.');
  const input = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const seed = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: fromBase64(salt), iterations: ITERATIONS, hash: 'SHA-256' }, input, 256));
  const hkdf = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveBits', 'deriveKey']);
  seed.fill(0);
  const parameters = info => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode(info) });
  const authProof = toBase64(await crypto.subtle.deriveBits(parameters('NUTE/auth/v1'), hkdf, 256));
  const wrappingKey = await crypto.subtle.deriveKey(parameters('NUTE/wrapping/v1'), hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { authProof, wrappingKey };
}
export async function seal(key, bytes, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context), tagLength: 128 }, key, bytes);
  return { v: 1, iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
}
export async function open(key, envelope, context, maxBytes = 2800000) {
  if (!envelope || envelope.v !== 1 || fromBase64(envelope.iv).length !== 12 || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > maxBytes) throw new Error('Неподдерживаемый формат хранилища.');
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: encoder.encode(context), tagLength: 128 }, key, fromBase64(envelope.ciphertext));
}
export async function createVaultKey(wrappingKey) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const wrappedKey = await seal(wrappingKey, bytes, 'NUTE/key/v1');
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  bytes.fill(0);
  return { key, wrappedKey };
}
export async function unwrapVaultKey(wrappingKey, envelope) {
  const bytes = new Uint8Array(await open(wrappingKey, envelope, 'NUTE/key/v1'));
  if (bytes.length !== 32) throw new Error('Некорректный ключ хранилища.');
  const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  bytes.fill(0);
  return key;
}
export const encryptVault = (key, vault) => {
  if (vaultCiphertextSize(vault) > RECOVERY_VAULT_BYTES) throw new Error('Размер локальной копии превышает 64 МиБ. Изменения сохранены в очереди; уменьшите хранилище на другом устройстве.');
  return seal(key, encoder.encode(JSON.stringify(vault)), 'NUTE/vault/v1');
};
export async function decryptVault(key, envelope) {
  const bytes = new Uint8Array(await open(key, envelope, 'NUTE/vault/v1', RECOVERY_VAULT_BYTES));
  try { return JSON.parse(decoder.decode(bytes)); } finally { bytes.fill(0); }
}
export function randomTotpSecret() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0, bits = 0, output = '';
  for (const byte of crypto.getRandomValues(new Uint8Array(20))) {
    buffer = (buffer << 8) | byte; bits += 8;
    while (bits >= 5) { output += alphabet[(buffer >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return output;
}
