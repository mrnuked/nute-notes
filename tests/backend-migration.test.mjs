import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const php = process.env.PHP_BINARY || (process.platform === 'win32' ? path.join(root, '.tools', 'php', 'php.exe') : 'php');

test('0.2 migration is additive, idempotent, and preserves owner, ciphertext, revision and config', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nute-migration-'));
  try {
    const config = path.join(temporary, 'private', 'config.php');
    const database = path.join(temporary, 'test.sqlite');
    const installed = spawnSync(php, ['scripts/init.php', `--config=${config}`], {
      cwd: root, encoding: 'utf8',
      input: JSON.stringify({ environment: 'local', origin: 'http://127.0.0.1:8123', dsn: `sqlite:${database}`, db_user: '', db_password: '' }),
    });
    assert.equal(installed.status, 0, installed.stderr);
    const originalConfig = await readFile(config);
    const fixture = spawnSync(php, ['-r', `
      $c=require $argv[1]; $db=new PDO($c['dsn']);
      $db->exec('DROP TABLE nute_trusted_devices');
      $q=$db->prepare('INSERT INTO nute_owner VALUES (1, ?, ?, ?, ?, ?, 37, ?, 123, ?, 1000, 2000)');
      $q->execute(['owner@example.com', base64_encode(random_bytes(16)), password_hash('fixture', PASSWORD_BCRYPT),
        json_encode(['v'=>1,'iv'=>base64_encode(random_bytes(12)),'ciphertext'=>base64_encode(random_bytes(48))]),
        json_encode(['v'=>1,'iv'=>base64_encode(random_bytes(12)),'ciphertext'=>base64_encode(random_bytes(128))]),
        base64_encode(random_bytes(60)), '[]']);
      $db->exec("INSERT INTO nute_rate_limits VALUES ('fixture-bucket', 3, 5000)");
      echo hash('sha256', json_encode([$db->query('SELECT * FROM nute_owner')->fetchAll(PDO::FETCH_ASSOC),
        $db->query('SELECT * FROM nute_rate_limits')->fetchAll(PDO::FETCH_ASSOC)]));`, config], { cwd: root, encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);
    for (let pass = 0; pass < 2; pass++) {
      const migrated = spawnSync(php, ['scripts/migrate-0.2.0.php'], {
        cwd: root, encoding: 'utf8', env: { ...process.env, NUTE_CONFIG_PATH: config },
      });
      assert.equal(migrated.status, 0, migrated.stderr);
      assert.match(migrated.stdout, /schema ready/);
      assert.deepEqual(await readFile(config), originalConfig, 'configuration and encryption key remain byte-identical');
      const preserved = spawnSync(php, ['-r', `
        $c=require $argv[1]; $db=new PDO($c['dsn']);
        $db->query('SELECT id, owner_id, token_hash, label, created_at, expires_at, last_used_at FROM nute_trusted_devices');
        echo hash('sha256', json_encode([$db->query('SELECT * FROM nute_owner')->fetchAll(PDO::FETCH_ASSOC),
          $db->query('SELECT * FROM nute_rate_limits')->fetchAll(PDO::FETCH_ASSOC)]));`, config], { cwd: root, encoding: 'utf8' });
      assert.equal(preserved.status, 0, preserved.stderr);
      assert.equal(preserved.stdout, fixture.stdout, 'all preexisting rows remain byte-identical');
    }
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('nute-migration-'));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('0.4 sync migration only adds empty journal tables and preserves old data plus existing journal on rerun', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nute-migration-'));
  try {
    const config = path.join(temporary, 'private', 'config.php');
    const database = path.join(temporary, 'test.sqlite');
    const installed = spawnSync(php, ['scripts/init.php', `--config=${config}`], {
      cwd: root, encoding: 'utf8',
      input: JSON.stringify({ environment: 'local', origin: 'http://127.0.0.1:8123', dsn: `sqlite:${database}`, db_user: '', db_password: '' }),
    });
    assert.equal(installed.status, 0, installed.stderr);
    const originalConfig = await readFile(config);
    const snapshot = `
      $rows=[]; foreach (['nute_owner','nute_rate_limits','nute_trusted_devices','nute_note_pins'] as $t)
        $rows[$t]=$db->query('SELECT * FROM '.$t)->fetchAll(PDO::FETCH_ASSOC);
      echo hash('sha256',json_encode($rows));`;
    const fixture = spawnSync(php, ['-r', `
      $c=require $argv[1]; $db=new PDO($c['dsn']);
      foreach (['nute_sync_changes','nute_sync_receipts','nute_sync_state'] as $t) $db->exec('DROP TABLE '.$t);
      $q=$db->prepare('INSERT INTO nute_owner VALUES (1, ?, ?, ?, ?, ?, 37, ?, 123, ?, 1000, 2000)');
      $q->execute(['owner@example.com', base64_encode(random_bytes(16)), password_hash('fixture', PASSWORD_BCRYPT),
        json_encode(['v'=>1,'iv'=>base64_encode(random_bytes(12)),'ciphertext'=>base64_encode(random_bytes(48))]),
        json_encode(['v'=>1,'iv'=>base64_encode(random_bytes(12)),'ciphertext'=>base64_encode(random_bytes(128))]),
        base64_encode(random_bytes(60)), '[]']);
      $db->exec("INSERT INTO nute_rate_limits VALUES ('fixture-bucket', 3, 5000)");
      $db->exec("INSERT INTO nute_trusted_devices VALUES ('fixture-device',1,'device-hash','Browser',1,50000,2)");
      $db->exec("INSERT INTO nute_note_pins VALUES ('00000000-0000-4000-8000-000000000001',1,'proof-hash',123)");
      ${snapshot}`, config], { cwd: root, encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);
    for (let pass = 0; pass < 2; pass++) {
      const migrated = spawnSync(php, ['scripts/migrate-0.4.0.php', `--config=${config}`], { cwd: root, encoding: 'utf8' });
      assert.equal(migrated.status, 0, migrated.stderr);
      assert.match(migrated.stdout, /0\.4\.0 schema ready/);
      assert.deepEqual(await readFile(config), originalConfig, 'existing config and server key remain byte-identical');
      const preserved = spawnSync(php, ['-r', `$c=require $argv[1];$db=new PDO($c['dsn']);${snapshot}`, config], { cwd: root, encoding: 'utf8' });
      assert.equal(preserved.status, 0, preserved.stderr);
      assert.equal(preserved.stdout, fixture.stdout, 'owner, ciphertext, revision, PINs, devices and rate limits remain byte-identical');
      const journal = spawnSync(php, ['-r', `
        $c=require $argv[1];$db=new PDO($c['dsn']);$rows=[];
        foreach (['nute_sync_state','nute_sync_receipts','nute_sync_changes'] as $t) $rows[$t]=$db->query('SELECT * FROM '.$t)->fetchAll(PDO::FETCH_ASSOC);
        echo json_encode($rows);
        if ($argv[2]==='0') {
          $db->exec("INSERT INTO nute_sync_state VALUES (1,0,'old-baseline',1,500)");
          $db->exec("INSERT INTO nute_sync_receipts VALUES (1,'00000000-0000-4000-8000-000000000002',1,'digest',123)");
          $db->exec("INSERT INTO nute_sync_changes VALUES (1,1,'00000000-0000-4000-8000-000000000002','ciphertext',10)");
        }`, config, String(pass)], { cwd: root, encoding: 'utf8' });
      assert.equal(journal.status, 0, journal.stderr);
      const rows = JSON.parse(journal.stdout);
      if (pass === 0) assert.deepEqual(rows, { nute_sync_state: [], nute_sync_receipts: [], nute_sync_changes: [] }, 'migration does not prematurely freeze an old writer or initialize a baseline');
      else {
        assert.deepEqual(rows.nute_sync_state, [{ owner_id: 1, baseline_cursor: 0, baseline_vault: 'old-baseline', head: 1, bytes_used: 500 }]);
        assert.deepEqual(rows.nute_sync_receipts, [{ owner_id: 1, id: '00000000-0000-4000-8000-000000000002', seq: 1, data_hash: 'digest', created_at: 123 }]);
        assert.deepEqual(rows.nute_sync_changes, [{ owner_id: 1, seq: 1, id: '00000000-0000-4000-8000-000000000002', data: 'ciphertext', byte_size: 10 }]);
      }
    }
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('nute-migration-'));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('0.3 PIN migration preserves all previous data and an existing PIN table on repeated runs', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nute-migration-'));
  try {
    const config = path.join(temporary, 'private', 'config.php');
    const database = path.join(temporary, 'test.sqlite');
    const installed = spawnSync(php, ['scripts/init.php', `--config=${config}`], {
      cwd: root, encoding: 'utf8',
      input: JSON.stringify({ environment: 'local', origin: 'http://127.0.0.1:8123', dsn: `sqlite:${database}`, db_user: '', db_password: '' }),
    });
    assert.equal(installed.status, 0, installed.stderr);
    const originalConfig = await readFile(config);
    const snapshot = `
      echo hash('sha256', json_encode([$db->query('SELECT * FROM nute_owner')->fetchAll(PDO::FETCH_ASSOC),
        $db->query('SELECT * FROM nute_rate_limits')->fetchAll(PDO::FETCH_ASSOC),
        $db->query('SELECT * FROM nute_trusted_devices')->fetchAll(PDO::FETCH_ASSOC)]));`;
    const fixture = spawnSync(php, ['-r', `
      $c=require $argv[1]; $db=new PDO($c['dsn']);
      $db->exec('DROP TABLE nute_note_pins');
      $q=$db->prepare('INSERT INTO nute_owner VALUES (1, ?, ?, ?, ?, ?, 37, ?, 123, ?, 1000, 2000)');
      $q->execute(['owner@example.com', base64_encode(random_bytes(16)), password_hash('fixture', PASSWORD_BCRYPT),
        json_encode(['v'=>1,'iv'=>base64_encode(random_bytes(12)),'ciphertext'=>base64_encode(random_bytes(48))]),
        json_encode(['v'=>1,'iv'=>base64_encode(random_bytes(12)),'ciphertext'=>base64_encode(random_bytes(128))]),
        base64_encode(random_bytes(60)), '[]']);
      $db->exec("INSERT INTO nute_rate_limits VALUES ('fixture-bucket', 3, 5000)");
      $db->exec("INSERT INTO nute_trusted_devices VALUES ('fixture-device', 1, 'device-hash', 'Browser', 1, 50000, 2)");
      ${snapshot}`, config], { cwd: root, encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);
    for (let pass = 0; pass < 2; pass++) {
      const migrated = spawnSync(php, ['scripts/migrate-0.3.0.php', `--config=${config}`], { cwd: root, encoding: 'utf8' });
      assert.equal(migrated.status, 0, migrated.stderr);
      assert.match(migrated.stdout, /0\.3\.0 schema ready/);
      assert.deepEqual(await readFile(config), originalConfig, 'migration never writes the existing configuration');
      const preserved = spawnSync(php, ['-r', `
        $c=require $argv[1]; $db=new PDO($c['dsn']);
        $db->query('SELECT id, owner_id, proof_hash, created_at FROM nute_note_pins');
        ${snapshot}`, config], { cwd: root, encoding: 'utf8' });
      assert.equal(preserved.status, 0, preserved.stderr);
      assert.equal(preserved.stdout, fixture.stdout, 'owner, encrypted vault, recovery codes, devices and rate limits remain byte-identical');
      const pinFixture = spawnSync(php, ['-r', `
        $c=require $argv[1]; $db=new PDO($c['dsn']);
        if ($argv[2] === '0') $db->exec("INSERT INTO nute_note_pins VALUES ('00000000-0000-4000-8000-000000000001', 1, 'proof-hash', 123)");
        echo json_encode($db->query('SELECT * FROM nute_note_pins')->fetchAll(PDO::FETCH_ASSOC));`, config, String(pass)], { cwd: root, encoding: 'utf8' });
      assert.equal(pinFixture.status, 0, pinFixture.stderr);
      assert.deepEqual(JSON.parse(pinFixture.stdout), [{ id: '00000000-0000-4000-8000-000000000001', owner_id: 1, proof_hash: 'proof-hash', created_at: 123 }]);
    }
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('nute-migration-'));
    await rm(temporary, { recursive: true, force: true });
  }
});
