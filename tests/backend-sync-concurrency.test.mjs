import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const php = process.env.PHP_BINARY || (process.platform === 'win32' ? path.join(root, '.tools', 'php', 'php.exe') : 'php');
const envelope = () => ({ v: 1, iv: randomBytes(12).toString('base64'), ciphertext: randomBytes(96).toString('base64') });

test('sync writers serialize baseline freeze, replay receipts and conditional checkpoints', { timeout: 30000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nute-sync-'));
  try {
    const config = path.join(temporary, 'private', 'config.php');
    const database = path.join(temporary, 'sync.sqlite');
    const installed = spawnSync(php, ['scripts/init.php', `--config=${config}`], {
      cwd: root, encoding: 'utf8',
      input: JSON.stringify({ environment: 'local', origin: 'http://127.0.0.1:8123', dsn: `sqlite:${database}`, db_user: '', db_password: '' }),
    });
    assert.equal(installed.status, 0, installed.stderr);
    const original = envelope(), changed = envelope();
    const fixture = spawnSync(php, ['-r', String.raw`
      require 'server/App.php';$c=require $argv[1];$db=Nute\Config::connect($c);
      $q=$db->prepare("INSERT INTO nute_owner VALUES (1,'owner@example.com','salt','hash','wrapped',?,7,'totp',10,'[]',1,1)");
      $q->execute([$argv[2]]);`, config, JSON.stringify(original)], { cwd: root, encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);
    const code = String.raw`
      require 'server/App.php';$c=require $argv[1];$db=Nute\Config::connect($c);$app=new Nute\App($db,$c);
      try {$method=$argv[2];$result=$app->$method(json_decode($argv[3],true),1800000000);echo json_encode(['status'=>200,'body'=>$result]);}
      catch(Nute\ApiError $error){echo json_encode(['status'=>$error->status,'error'=>$error->error]);}`;
    const request = (method, data) => new Promise((resolve, reject) => {
      const worker = spawn(php, ['-r', code, config, method, JSON.stringify(data)], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', error = '';
      worker.stdout.on('data', data => out += data.toString());
      worker.stderr.on('data', data => error += data.toString());
      worker.on('error', reject);
      worker.on('exit', status => {
        if (status !== 0) return reject(new Error(error));
        try { resolve(JSON.parse(out)); } catch (error) { reject(error); }
      });
    });
    const [save, first] = await Promise.all([
      request('saveVault', { revision: 7, vault: changed }), request('syncPull', { after: 0 }),
    ]);
    assert.ok([200, 426].includes(save.status));
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.baseline.vault, save.status === 200 ? changed : original, 'successful legacy write is captured; frozen writer never slips after baseline');
    const a = { id: '00000000-0000-4000-8000-000000000001', data: envelope() };
    const b = { id: '00000000-0000-4000-8000-000000000002', data: envelope() };
    const writers = await Promise.all(Array.from({ length: 10 }, (_, index) => request('syncPush', { operations: [index % 2 ? a : b] })));
    assert.ok(writers.every(result => result.status === 200));
    const ordered = (await request('syncPull', { after: 0 })).body;
    assert.deepEqual(ordered.changes.map(change => change.seq), [1, 2]);
    assert.deepEqual(ordered.changes.map(change => change.id).sort(), [a.id, b.id]);
    const c = { id: '00000000-0000-4000-8000-000000000003', data: envelope() };
    const checkpoint = envelope();
    const [compacted, append] = await Promise.all([
      request('syncCheckpoint', { cursor: 2, vault: checkpoint }), request('syncPush', { operations: [c] }),
    ]);
    assert.ok([200, 409].includes(compacted.status));
    assert.equal(append.status, 200);
    const final = (await request('syncPull', { after: 0, pendingIds: [a.id, b.id, c.id] })).body;
    assert.equal(final.cursor, 3);
    assert.deepEqual(final.received, [a.id, b.id, c.id]);
    assert.ok(final.changes.some(change => change.id === c.id), 'racing checkpoint cannot remove a newly accepted operation');
    if (compacted.status === 200) {
      assert.equal(final.baseline.cursor, 2);
      assert.deepEqual(final.changes, [{ seq: 3, ...c }]);
    } else assert.deepEqual(final.changes.map(change => change.seq), [1, 2, 3]);
    assert.equal((await request('syncPush', { operations: [a, b, c] })).body.cursor, 3, 'all retries remain deduplicated after checkpoint race');
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('nute-sync-'));
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
