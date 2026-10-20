'use strict';
const path = require('node:path');
const ORIGIN = 'https://notes.example.org';
const LOCAL_ORIGIN = 'nute://app';
const MAX_REQUEST = 4 * 1024 * 1024;
const MAX_RESPONSE = 24 * 1024 * 1024;
const MAX_CHECKPOINT = 20 * 1024 * 1024;
const MAX_CACHE = 64 * 1024 * 1024;
const MAX_STATE = 150 * 1024 * 1024;
const MAX_QUEUE = 64 * 1024 * 1024;
const METHODS = Object.freeze({ bootstrap: ['GET'], email: ['POST'], setup: ['POST'], login: ['POST'], resume: ['POST'],
  vault: ['GET', 'PUT'], logout: ['POST'], devices: ['GET'], revoke_device: ['POST'], pin_check: ['POST'], pin_register: ['POST'],
  sync_pull: ['POST'], sync_push: ['POST'], sync_checkpoint: ['POST'] });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function bounded(value, max = MAX_REQUEST) {
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || Buffer.byteLength(text) > max) throw new Error('Данные превышают допустимый размер.');
  return text;
}
function request(input) {
  if (!object(input) || !Object.hasOwn(METHODS, input.action) || !METHODS[input.action].includes(input.method)) throw new Error('Недопустимый запрос NUTE.');
  if (input.method !== 'GET' && !object(input.data ?? {})) throw new Error('Ожидается JSON-объект.');
  return { action: input.action, method: input.method, data: input.method === 'GET' ? undefined : JSON.parse(bounded(input.data ?? {}, input.action === 'sync_checkpoint' ? MAX_CHECKPOINT : MAX_REQUEST)) };
}
function envelope(value) {
  if (!object(value) || value.v !== 1 || typeof value.iv !== 'string' || typeof value.ciphertext !== 'string') return false;
  const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  return value.iv.length === 16 && base64.test(value.iv) && Buffer.from(value.iv, 'base64').length === 12
    && value.ciphertext.length >= 24 && value.ciphertext.length <= 2800000 && base64.test(value.ciphertext);
}
function operations(input) {
  if (!object(input) || !Array.isArray(input.operations) || input.operations.length > 5000) throw new Error('Некорректная очередь изменений.');
  bounded(input);
  return input.operations.map(op => {
    if (!object(op) || !UUID.test(op.id) || !envelope(op.data)) throw new Error('Ожидается зашифрованная операция.');
    return { id: op.id.toLowerCase(), data: { v: 1, iv: op.data.iv, ciphertext: op.data.ciphertext } };
  });
}
function ids(input) {
  if (!object(input) || !Array.isArray(input.ids) || input.ids.length > 5000 || input.ids.some(id => typeof id !== 'string' || !UUID.test(id))) throw new Error('Некорректное подтверждение изменений.');
  return input.ids.map(id => id.toLowerCase());
}
function localUrl(value) {
  try { const url = new URL(value); return url.protocol === 'nute:' && url.hostname === 'app' && !url.port && !url.username && !url.password; } catch { return false; }
}
function senderAllowed(event, contents) {
  return !!contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame
    && localUrl(event.senderFrame.url) && ['/', '/index.html'].includes(new URL(event.senderFrame.url).pathname);
}
function externalUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && ['icloud.com','www.icloud.com'].includes(url.hostname) && !url.port && !url.username && !url.password; } catch { return false; }
}
function assetPath(url, root) {
  if (!localUrl(url)) return null;
  let pathname;
  try { pathname = decodeURIComponent(new URL(url).pathname); } catch { return null; }
  if (pathname === '/') pathname = '/index.html';
  if (pathname.includes('\\') || pathname.includes('\0') || !/^\/(?:index\.html|favicon\.png|assets\/[A-Za-z0-9_./-]+)$/.test(pathname)) return null;
  const file = path.resolve(root, '.' + pathname), relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !/\.(html|js|css|png|svg|woff2?|ttf|txt)$/i.test(file)) return null;
  return file;
}
module.exports = { ORIGIN, LOCAL_ORIGIN, MAX_REQUEST, MAX_RESPONSE, MAX_CHECKPOINT, MAX_CACHE, MAX_STATE, MAX_QUEUE, UUID, object, bounded, request, envelope, operations, ids, localUrl, senderAllowed, externalUrl, assetPath };
