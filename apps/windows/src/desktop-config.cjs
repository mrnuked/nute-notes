'use strict';
const { createHash } = require('node:crypto');
function serverOrigin(input) {
  if (typeof input !== 'string') throw new Error('Введите HTTPS-адрес сервера.');
  const value = input.trim();
  // A DNS domain only; reject parser aliases, userinfo, ports and URL suffixes.
  if (!/^https:\/\/(?=.{1,253}\/?$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}\/?$/i.test(value)) {
    throw new Error('Укажите https://ваш-домен без пути, порта, параметров и пароля.');
  }
  const url = new URL(value);
  return url.origin;
}
function profileName(origin) { return createHash('sha256').update(serverOrigin(origin)).digest('hex'); }
function requireSecureStorage(platform, storage) {
  if (!storage.isEncryptionAvailable()) throw new Error('Системное хранилище ключей недоступно. Разблокируйте связку ключей и повторите запуск.');
  if (platform === 'win32') return 'DPAPI';
  const backend = platform === 'linux' && storage.getSelectedStorageBackend();
  if (!['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)) {
    throw new Error('Нужна защищённая связка ключей GNOME Keyring или KWallet. Режим basic_text запрещён; секреты не сохранены.');
  }
  return backend;
}
module.exports = { serverOrigin, profileName, requireSecureStorage };
