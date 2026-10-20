import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/desktop-config.cjs';

test('server setting accepts only a canonical HTTPS domain origin, without credentials or paths', () => {
  assert.equal(config.serverOrigin(' https://Notes.Example.com/ '), 'https://notes.example.com');
  for (const bad of ['http://notes.example.com', 'https://user:pass@notes.example.com', 'https://notes.example.com/api',
    'https://notes.example.com?x=1', 'https://notes.example.com#x', 'https://notes.example.com:443',
    'https://127.0.0.1', 'https://localhost', 'https://notes.example.com\\@evil.example', 'file:///etc/passwd', null]) {
    assert.throws(() => config.serverOrigin(bad), undefined, String(bad));
  }
});
test('server identities cannot share a local vault path', () => {
  assert.equal(config.profileName('https://Notes.Example.com/'), config.profileName('https://notes.example.com'));
  assert.notEqual(config.profileName('https://notes.example.com'), config.profileName('https://other.example.com'));
  assert.match(config.profileName('https://notes.example.com'), /^[a-f0-9]{64}$/);
});
test('Linux refuses plaintext and unavailable secret stores; Windows remains DPAPI', () => {
  const fake = (available, backend) => ({ isEncryptionAvailable: () => available, getSelectedStorageBackend: () => backend });
  for (const backend of ['basic_text', 'unknown', undefined]) assert.throws(() => config.requireSecureStorage('linux', fake(true, backend)));
  assert.throws(() => config.requireSecureStorage('linux', fake(false, 'gnome_libsecret')));
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) assert.equal(config.requireSecureStorage('linux', fake(true, backend)), backend);
  assert.equal(config.requireSecureStorage('win32', fake(true)), 'DPAPI');
});
