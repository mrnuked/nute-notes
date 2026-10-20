import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const php = process.env.PHP_BINARY || (process.platform === 'win32' ? path.join(root, '.tools', 'php', 'php.exe') : 'php');

function otpAt(secret, now = Date.now()) {
  const binary = [...secret].map(c => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(binary.match(/.{8}/g).map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const hash = createHmac('sha1', key).update(counter).digest();
  const code = (hash.readUInt32BE(hash.at(-1) & 15) & 0x7fffffff) % 1000000;
  return String(code).padStart(6, '0');
}

const envelope = bytes => ({ v: 1, iv: randomBytes(12).toString('base64'), ciphertext: randomBytes(bytes).toString('base64') });

test('HTTP authentication, CSRF, recovery, isolation, and encrypted vault lifecycle', { timeout: 30000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nute-http-'));
  let server;
  try {
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const config = path.join(temporary, 'private', 'config.php');
    const database = path.join(temporary, 'test.sqlite');
    const sessions = await mkdtemp(path.join(temporary, 'sessions-'));
    const installed = spawnSync(php, ['scripts/init.php', `--config=${config}`], {
      cwd: root,
      encoding: 'utf8',
      input: JSON.stringify({ environment: 'local', origin, dsn: `sqlite:${database}`, db_user: '', db_password: '' }),
    });
    assert.equal(installed.status, 0, installed.stderr);
    const token = installed.stdout.match(/^[a-f0-9]{64}$/m)?.[0];
    assert.ok(token, 'CLI generated a setup token');
    const duplicate = spawnSync(php, ['scripts/init.php', `--config=${config}`], {
      cwd: root, encoding: 'utf8', input: '{}',
    });
    assert.equal(duplicate.status, 1, 'installer refuses to overwrite config');
    let serverLog = '';
    let readinessStatus = '';
    server = spawn(php, ['-d', `session.save_path=${sessions}`, '-S', `127.0.0.1:${port}`, '-t', 'public'], {
      cwd: root, env: { ...process.env, NUTE_CONFIG_PATH: config }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    server.stderr.on('data', data => { serverLog = (serverLog + data.toString()).slice(-2000); });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const result = await fetch(`${origin}/api.php?action=bootstrap`);
        readinessStatus = `${result.status} ${await result.text()}`;
        if (result.status === 200) { ready = true; break; }
      } catch (error) { readinessStatus = String(error.cause ?? error); }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(ready, `PHP test server starts: ${readinessStatus}; ${serverLog}`);
    // Exercise the real file handler, including PHP strict-mode replacement of
    // attacker-selected IDs, across GET and rejected mutation paths.
    for (const forged of ['', 'a'.repeat(32), 'pre.1000000000.' + 'b'.repeat(64) + '.' + 'c'.repeat(64)]) {
      for (const action of ['bootstrap', 'vault', 'devices', 'login', 'resume', 'sync_push']) {
        const mutation = ['login', 'resume', 'sync_push'].includes(action);
        const response = await fetch(`${origin}/api.php?action=${action}`, {
          method: mutation ? 'POST' : 'GET',
          headers: { ...(forged ? { Cookie: `nute_local=${forged}` } : {}), ...(mutation ? { Origin: origin, 'Content-Type': 'application/json' } : {}) },
          ...(mutation ? { body: '{}' } : {}),
        });
        assert.equal(response.status, action === 'bootstrap' ? 200 : mutation ? 403 : 401);
        await response.text();
        assert.deepEqual((await readdir(sessions)).filter(name => name.startsWith('sess_')), [], `No retained anonymous session: ${action}, forged=${!!forged}`);
      }
    }
    let cookie = '';
    const cookieJar = new Map();
    let csrf = '';
    async function request(action, { method = 'GET', data, headers = {}, raw, useCookie = true, useCsrf = true, useOrigin = true } = {}) {
      const result = await fetch(`${origin}/api.php?action=${action}`, {
        method,
        headers: {
          'X-Nute-Client': '0.4',
          ...(useCookie && cookie ? { Cookie: cookie } : {}),
          ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
          ...(method !== 'GET' && useOrigin ? { Origin: origin } : {}),
          ...(method !== 'GET' && useCsrf ? { 'X-CSRF-Token': csrf } : {}),
          ...headers,
        },
        body: raw ?? (data === undefined ? undefined : JSON.stringify(data)),
      });
      if (useCookie) {
        for (const setCookie of result.headers.getSetCookie()) {
          const pair = setCookie.split(';', 1)[0];
          const separator = pair.indexOf('=');
          const name = pair.slice(0, separator);
          const value = pair.slice(separator + 1);
          const expiry = setCookie.match(/Expires=([^;]+)/i)?.[1];
          if (!value || (expiry && Date.parse(expiry) <= Date.now())) cookieJar.delete(name);
          else cookieJar.set(name, value);
        }
        cookie = [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ');
      }
      const body = await result.json();
      if (body.csrf && useCookie) csrf = body.csrf;
      return { status: result.status, body, headers: result.headers };
    }
    let result = await request('bootstrap');
    assert.equal(result.status, 200);
    assert.equal(result.body.initialized, false);
    assert.equal(result.body.syncProtocol, 1);
    assert.equal(result.body.trustedDevice, false);
    assert.equal('resumeSecret' in result.body, false, 'bootstrap never exposes a resume secret');
    assert.match(csrf, /^[0-9a-f]{64}$/);
    assert.match(result.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(result.headers.get('set-cookie'), /SameSite=Strict/i);
    assert.match(result.headers.get('cache-control'), /no-store/);
    assert.match(result.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const beforeLoginCookie = cookie;
    assert.equal((await request('vault')).status, 401);
    assert.equal((await request('devices')).status, 401);
    assert.equal((await request('resume', { method: 'POST', data: {} })).status, 401);
    assert.equal((await request('resume')).status, 405, 'resume requires a protected POST');
    const pin = { id: '00000000-0000-4000-8000-000000000001', proof: randomBytes(32).toString('base64') };
    const wrongPin = { ...pin, proof: randomBytes(32).toString('base64') };
    for (const action of ['pin_register', 'pin_check']) {
      assert.equal((await request(action, { method: 'POST', data: pin })).status, 401, `${action} requires authentication`);
      assert.equal((await request(action)).status, 405, `${action} requires POST`);
    }
    for (const action of ['sync_pull', 'sync_push', 'sync_checkpoint']) {
      assert.equal((await request(action, { method: 'POST', data: {} })).status, 401, `${action} requires authentication`);
      assert.equal((await request(action)).status, 405, `${action} requires POST`);
    }
    assert.equal((await request('email', { method: 'POST', data: { email: 'owner@example.com' }, useOrigin: false })).status, 403);
    assert.equal((await request('email', { method: 'POST', data: { email: 'owner@example.com' }, useCsrf: false })).status, 403);
    assert.equal((await request('email', { method: 'POST', data: { email: 'owner@example.com' }, headers: { Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await request('email', { method: 'POST', raw: 'invalid' })).status, 400);
    assert.equal((await request('email', { method: 'POST', raw: '[]' })).status, 400);
    assert.equal((await request('email', { method: 'POST', data: {}, headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await request('email', { method: 'POST', raw: '{"padding":"' + 'A'.repeat(4194304) + '"}' })).status, 413);
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // gitleaks:allow -- RFC 4226 public test vector, not a deployment credential.
    const proof = randomBytes(32).toString('base64');
    const vault = envelope(80);
    const setup = { token, email: 'owner@example.com', authProof: proof, salt: randomBytes(16).toString('base64'),
      wrappedKey: envelope(48), vault, totpSecret: secret, otp: otpAt(secret) };
    result = await request('setup', { method: 'POST', data: setup });
    assert.equal(result.status, 200);
    assert.equal(result.body.revision, 1);
    assert.equal(result.body.syncProtocol, 1);
    assert.equal(result.body.recoveryCodes.length, 10);
    const setupResumeSecret = result.body.resumeSecret;
    assert.equal(Buffer.from(setupResumeSecret, 'base64').length, 32, 'setup issues a 256-bit resume secret');
    assert.notEqual(cookie, beforeLoginCookie, 'session rotates after authentication');
    assert.equal((await readdir(sessions)).filter(name => name.startsWith('sess_')).length, 1, 'Only successful owner authentication allocates a durable session');
    assert.deepEqual(result.body.vault, vault);
    const recoveryCodes = result.body.recoveryCodes;
    assert.equal((await request('setup', { method: 'POST', data: setup })).status, 409);
    assert.equal((await request('bootstrap')).body.initialized, true);
    assert.equal('resumeSecret' in (await request('bootstrap')).body, false, 'authenticated bootstrap does not expose the secret');
    for (const action of ['pin_register', 'pin_check']) {
      assert.equal((await request(action, { method: 'POST', data: pin, useCsrf: false })).status, 403, `${action} requires CSRF`);
      assert.equal((await request(action, { method: 'POST', data: pin, useOrigin: false })).status, 403, `${action} requires Origin`);
      assert.equal((await request(action, { method: 'POST', data: pin, headers: { Origin: 'https://attacker.example' } })).status, 403, `${action} rejects cross-origin callers`);
      assert.equal((await request(action, { method: 'POST', data: pin, headers: { 'X-Nute-Client': '0.2' } })).status, 426, `${action} requires current client`);
      assert.equal((await request(action, { method: 'POST', data: { ...pin, proof: '1234' } })).status, 422, `${action} never accepts a raw PIN`);
    }
    assert.deepEqual((await request('pin_register', { method: 'POST', data: pin })).body, { ok: true });
    result = await request('pin_check', { method: 'POST', data: wrongPin });
    assert.equal(result.status, 403);
    assert.equal(result.body.error, 'pin_invalid');
    assert.deepEqual((await request('pin_check', { method: 'POST', data: pin })).body, { ok: true });
    result = await request('pin_register', { method: 'POST', data: wrongPin });
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'pin_exists');
    assert.deepEqual((await request('pin_register', { method: 'POST', data: pin })).body, { ok: true });
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await request('pin_check', { method: 'POST', data: wrongPin })).status, 403, 'successful registration reset earlier note failures');
    }
    result = await request('pin_check', { method: 'POST', data: pin });
    assert.equal(result.status, 429, 'sixth check is rate limited');
    assert.equal(result.headers.get('retry-after'), '900');
    assert.equal((await request('pin_register', { method: 'POST', data: pin })).status, 429, 'registration shares the per-note attempt limit');
    assert.equal((await request('resume', { method: 'POST', data: {}, useCsrf: false })).status, 403);
    assert.equal((await request('resume', { method: 'POST', data: {}, useOrigin: false })).status, 403);
    assert.equal((await request('resume', { method: 'POST', data: {}, headers: { Origin: 'https://attacker.example' } })).status, 403);
    result = await request('resume', { method: 'POST', data: {} });
    assert.equal(result.status, 200);
    assert.equal(result.body.resumeSecret, setupResumeSecret, 'same authenticated session keeps its resume secret');
    assert.deepEqual(result.body.vault, vault);
    result = await request('vault', { useCookie: false, headers: { Cookie: beforeLoginCookie } });
    assert.equal(result.status, 401, 'old session cannot read vault');
    assert.deepEqual((await request('vault')).body.vault, vault);
    const changed = envelope(100);
    result = await request('vault', { method: 'PUT', data: { revision: 1, vault: changed }, headers: { 'X-Nute-Client': '' } });
    assert.equal(result.status, 426, 'missing version cannot overwrite rich notes');
    assert.equal(result.body.error, 'client_update_required');
    assert.equal((await request('vault', { method: 'PUT', data: { revision: 1, vault: changed }, headers: { 'X-Nute-Client': '0.1' } })).status, 426);
    assert.equal((await request('vault', { method: 'PUT', data: { revision: 1, vault: changed }, headers: { 'X-Nute-Client': '0.2' } })).status, 426, 'pre-PIN clients cannot overwrite protected notes');
    assert.equal((await request('vault')).body.revision, 1, 'rejected old clients leave revision unchanged');
    assert.equal((await request('vault', { method: 'PUT', data: { revision: 1, vault: changed }, headers: { 'X-Nute-Client': '0.3' } })).body.revision, 2, 'legacy PIN client can save before sync baseline exists');
    result = await request('vault', { method: 'PUT', data: { revision: 1, vault } });
    assert.equal(result.status, 409);
    assert.deepEqual((await request('vault')).body.vault, changed);
    result = await request('resume', { method: 'POST', data: {} });
    assert.equal(result.body.revision, 2, 'resume returns the newest vault revision');
    assert.deepEqual(result.body.vault, changed, 'resume reads fresh encrypted data');
    assert.equal(result.body.resumeSecret, setupResumeSecret);
    assert.equal(result.body.syncProtocol, 1);
    for (const action of ['sync_pull', 'sync_push', 'sync_checkpoint']) {
      assert.equal((await request(action, { method: 'POST', data: {}, useCsrf: false })).status, 403, `${action} requires CSRF`);
      assert.equal((await request(action, { method: 'POST', data: {}, useOrigin: false })).status, 403, `${action} requires Origin`);
      assert.equal((await request(action, { method: 'POST', data: {}, headers: { Origin: 'https://attacker.example' } })).status, 403, `${action} refuses cross-origin requests`);
      assert.equal((await request(action, { method: 'POST', data: {}, headers: { 'X-Nute-Client': '0.3' } })).status, 426, `${action} requires sync-aware version 0.4`);
    }
    result = await request('sync_pull', { method: 'POST', data: { after: 0 } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.baseline, { cursor: 0, vault: changed });
    assert.deepEqual(result.body.received, []);
    for (const version of ['0.3', '0.4']) {
      assert.equal((await request('vault', { method: 'PUT', data: { revision: 2, vault }, headers: { 'X-Nute-Client': version } })).status, 426, 'baseline initialization atomically freezes every legacy vault writer');
    }
    const operation = { id: '00000000-0000-4000-8000-000000000101', data: envelope(100) };
    result = await request('sync_push', { method: 'POST', data: { operations: [operation] } });
    assert.deepEqual(result.body, { accepted: [operation.id], cursor: 1 });
    assert.deepEqual((await request('sync_push', { method: 'POST', data: { operations: [operation] } })).body, result.body, 'HTTP retry is idempotent');
    result = await request('sync_pull', { method: 'POST', data: { after: 0, pendingIds: [operation.id] } });
    assert.deepEqual(result.body.changes, [{ seq: 1, ...operation }]);
    assert.deepEqual(result.body.received, [operation.id]);
    assert.equal((await request('sync_checkpoint', { method: 'POST', data: { cursor: 0, vault } })).status, 409);
    assert.deepEqual((await request('sync_checkpoint', { method: 'POST', data: { cursor: 1, vault } })).body, { ok: true });
    result = await request('sync_pull', { method: 'POST', data: { after: 0, pendingIds: [operation.id] } });
    assert.deepEqual(result.body.baseline, { cursor: 1, vault });
    assert.deepEqual(result.body.changes, []);
    assert.deepEqual(result.body.received, [operation.id], 'compacted operation remains acknowledged on reconnect');
    const authenticatedCookie = cookie;
    assert.equal((await request('logout', { method: 'POST', data: {} })).status, 200);
    assert.equal((await request('resume', { method: 'POST', data: {}, useCookie: false, headers: { Cookie: authenticatedCookie } })).status, 403, 'destroyed session cannot resume with the old cookie and CSRF token');
    assert.equal((await request('vault')).status, 401);
    await request('bootstrap');
    assert.equal((await request('resume', { method: 'POST', data: {} })).status, 401, 'logged out session cannot resume');
    assert.equal((await request('email', { method: 'POST', data: { email: 'missing@example.com' } })).status, 401);
    assert.equal((await request('email', { method: 'POST', data: { email: setup.email } })).body.salt, setup.salt);
    result = await request('login', { method: 'POST', data: { email: setup.email, authProof: proof, otp: recoveryCodes[0] } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.vault, changed);
    assert.equal(Buffer.from(result.body.resumeSecret, 'base64').length, 32);
    assert.notEqual(result.body.resumeSecret, setupResumeSecret, 'new authentication rotates the resume secret');
    assert.equal((await request('pin_check', { method: 'POST', data: pin })).status, 429, 'new authenticated session does not reset PIN attempts');
    await request('logout', { method: 'POST', data: {} });
    await request('bootstrap');
    assert.equal((await request('login', { method: 'POST', data: { email: setup.email, authProof: proof, otp: recoveryCodes[0] } })).status, 401);
    result = await request('login', { method: 'POST', data: { email: setup.email, authProof: proof, otp: recoveryCodes[1], rememberDevice: true } });
    assert.equal(result.status, 200);
    const deviceCookie = result.headers.getSetCookie().find(value => value.startsWith('nute_device_local='));
    assert.match(deviceCookie, /HttpOnly/i);
    assert.match(deviceCookie, /SameSite=Strict/i);
    assert.match(deviceCookie, /path=\//i);
    assert.ok(!/Domain=/i.test(deviceCookie), 'device cookie is host-only');
    const expires = Date.parse(deviceCookie.match(/Expires=([^;]+)/i)[1]);
    assert.ok(Math.abs(expires - Date.now() - 180 * 86400 * 1000) < 5000, 'cookie expires in 180 days');
    assert.ok(!JSON.stringify(result.body).includes(cookieJar.get('nute_device_local')), 'device credential never appears in JSON');
    const trustedCookie = cookieJar.get('nute_device_local');
    assert.equal((await request('bootstrap')).body.trustedDevice, true);
    await request('logout', { method: 'POST', data: {} });
    assert.equal(cookieJar.get('nute_device_local'), trustedCookie, 'ordinary lock/logout preserves trust');
    await request('bootstrap');
    const noOtp = { email: setup.email, authProof: proof };
    assert.equal((await request('login', { method: 'POST', data: noOtp })).status, 200);
    let devices = (await request('devices')).body.devices;
    assert.equal(devices.length, 1);
    assert.equal(devices[0].current, true);
    assert.equal((await request('revoke_device', { method: 'POST', data: { id: devices[0].id }, useCsrf: false })).status, 403);
    await request('logout', { method: 'POST', data: {} });
    await request('bootstrap');
    assert.equal((await request('login', { method: 'POST', data: { ...noOtp, authProof: randomBytes(32).toString('base64') } })).status, 401);
    assert.equal((await request('login', { method: 'POST', data: noOtp })).status, 200);
    result = await request('revoke_device', { method: 'POST', data: { id: devices[0].id } });
    assert.equal(result.body.current, true);
    assert.equal(cookieJar.has('nute_device_local'), false);
    assert.equal((await request('devices')).body.devices.length, 0);
    await request('logout', { method: 'POST', data: {} });
    await request('bootstrap');
    assert.equal((await request('login', { method: 'POST', data: noOtp })).status, 401);
    assert.equal((await request('login', { method: 'POST', data: { ...noOtp, otp: recoveryCodes[2], rememberDevice: true } })).status, 200);
    await request('logout', { method: 'POST', data: { forgetDevice: true } });
    assert.equal(cookieJar.has('nute_device_local'), false, 'explicit logout forgets the device');
    await request('bootstrap');
    assert.equal((await request('bootstrap')).body.trustedDevice, false);
    assert.equal((await request('login', { method: 'POST', data: noOtp })).status, 401);
    const wrongProof = randomBytes(32).toString('base64');
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal((await request('login', { method: 'POST', data: { email: setup.email, authProof: wrongProof, otp: '000000' } })).status, 401);
    }
    assert.equal((await request('login', { method: 'POST', data: { email: setup.email, authProof: proof, otp: recoveryCodes[3] } })).status, 429);
    const stored = spawnSync(php, ['-r', '$c=require $argv[1];$db=new PDO($c["dsn"]);echo json_encode($db->query("SELECT * FROM nute_owner")->fetch(PDO::FETCH_ASSOC));', config], { encoding: 'utf8' });
    assert.equal(stored.status, 0);
    const row = JSON.parse(stored.stdout);
    assert.equal(JSON.parse(row.vault).ciphertext, changed.ciphertext);
    assert.ok(!stored.stdout.includes(proof), 'authentication proof is never stored plaintext');
    assert.ok(!stored.stdout.includes(secret), 'TOTP secret is never stored plaintext');
    assert.ok(!stored.stdout.includes(recoveryCodes[0]), 'recovery codes are never stored plaintext');
    assert.ok(!stored.stdout.includes(setupResumeSecret), 'session resume secret is never stored in the vault database');
    const storedPins = spawnSync(php, ['-r', '$c=require $argv[1];$db=new PDO($c["dsn"]);echo json_encode($db->query("SELECT * FROM nute_note_pins")->fetchAll(PDO::FETCH_ASSOC));', config], { encoding: 'utf8' });
    assert.equal(storedPins.status, 0);
    const pinRows = JSON.parse(storedPins.stdout);
    assert.equal(pinRows.length, 1);
    assert.deepEqual(Object.keys(pinRows[0]), ['id', 'owner_id', 'proof_hash', 'created_at']);
    assert.equal(pinRows[0].id, pin.id);
    assert.ok(!storedPins.stdout.includes(pin.proof), 'PIN proof is never stored plaintext');
    assert.ok(!storedPins.stdout.includes(wrongPin.proof), 'wrong proof is never persisted');
  } finally {
    if (server && server.exitCode === null) {
      server.kill();
      await new Promise(resolve => server.once('exit', resolve));
    }
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()), 'cleanup stays in the system temporary directory');
    assert.ok(path.basename(temporary).startsWith('nute-http-'), 'cleanup targets only this test fixture');
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('concurrent PIN checks retain failures and serialize successful note-counter resets', { timeout: 30000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nute-http-'));
  try {
    const config = path.join(temporary, 'private', 'config.php');
    const database = path.join(temporary, 'pins.sqlite');
    const installed = spawnSync(php, ['scripts/init.php', `--config=${config}`], {
      cwd: root, encoding: 'utf8',
      input: JSON.stringify({ environment: 'local', origin: 'http://127.0.0.1:8123', dsn: `sqlite:${database}`, db_user: '', db_password: '' }),
    });
    assert.equal(installed.status, 0, installed.stderr);
    const pin = { id: '00000000-0000-4000-8000-000000000002', proof: randomBytes(32).toString('base64') };
    const fixture = spawnSync(php, ['-r', `
      require 'server/App.php'; $c=require $argv[1]; $db=Nute\\Config::connect($c);
      $db->exec("INSERT INTO nute_owner VALUES (1, 'owner@example.com', 'salt', 'hash', 'wrapped', 'vault', 7, 'totp', 10, '[]', 1, 1)");
      (new Nute\\App($db,$c))->registerPin(json_decode($argv[2],true),1800000000);`, config, JSON.stringify(pin)], { cwd: root, encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);
    const code = `
      require 'server/App.php'; $c=require $argv[1]; $db=Nute\\Config::connect($c);
      try { (new Nute\\App($db,$c))->checkPin(json_decode($argv[2],true),(int)$argv[3]); echo '200'; }
      catch (Nute\\ApiError $error) { echo $error->status; }`;
    const check = (proof, now) => new Promise((resolve, reject) => {
      const worker = spawn(php, ['-r', code, config, JSON.stringify({ ...pin, proof }), String(now)], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '', errors = '';
      worker.stdout.on('data', data => output += data.toString());
      worker.stderr.on('data', data => errors += data.toString());
      worker.on('error', reject);
      worker.on('exit', status => status === 0 ? resolve(Number(output)) : reject(new Error(errors)));
    });
    const wrong = randomBytes(32).toString('base64');
    const workers = await Promise.allSettled(Array.from({ length: 6 }, () => check(wrong, 1800000000)));
    for (const worker of workers) assert.equal(worker.status, 'fulfilled', worker.reason?.message);
    const failures = workers.map(worker => worker.value);
    assert.deepEqual(failures.sort(), [403, 403, 403, 403, 403, 429], 'parallel failures never lose increments');
    const blockedSuccesses = await Promise.all(Array.from({ length: 3 }, () => check(pin.proof, 1800000000)));
    assert.deepEqual(blockedSuccesses, [429, 429, 429], 'parallel correct proofs cannot reset an already blocked note');
    const reopened = await Promise.all(Array.from({ length: 10 }, () => check(pin.proof, 1800000900)));
    assert.deepEqual(reopened, Array(10).fill(200), 'parallel successful opens reset their note counters without blocking one another');
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('nute-http-'));
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
