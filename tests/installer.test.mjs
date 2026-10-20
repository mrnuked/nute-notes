import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const bash = process.env.NUTE_TEST_BASH || (process.platform === 'win32'
  ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const php = process.env.NUTE_TEST_PHP || (process.platform === 'win32'
  ? path.join(root, '.tools/php/php.exe') : 'php');
function run(args) {
  const result = spawnSync(bash, ['installer/install.sh', ...args], { cwd: root, encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}
function render(name) {
  const result = run(['--domain', 'vault.example.net', '--render', name]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('shell syntax and LF-only distribution files', () => {
  for (const name of ['install.sh', 'backup.sh', 'renewal-hook.sh']) {
    assert.ok(!readFileSync(path.join(root, 'installer', name)).includes(13), `${name} has CRLF`);
    const result = spawnSync(bash, ['-n', `installer/${name}`], { cwd: root, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
});
test('render is usable without root, contact email, Linux system or mutation', () => {
  const http = render('nginx-http');
  assert.match(http, /server_name vault\.example\.net;/);
  assert.match(http, /location \^~ \/\.well-known\/acme-challenge\//);
  assert.match(http, /location \/ \{ return 503; \}/);
  assert.doesNotMatch(http, /fastcgi_pass|default_server/);
});
test('TLS config isolates public root and exact PHP entrypoints, keeping ACME reachable', () => {
  const tls = render('nginx-tls');
  assert.match(tls, /root \/srv\/nute\/current\/public;/);
  assert.match(tls, /client_max_body_size 20m;/);
  assert.match(tls, /return 308 https:\/\/vault\.example\.net\$request_uri;/);
  assert.match(tls, /\/etc\/letsencrypt\/live\/vault\.example\.net\/fullchain\.pem/);
  assert.match(tls, /\^\^?\/\(index\|api\)\\\.php\$/);
  assert.match(tls, /location = \/app\.html \{ return 404; \}/);
  assert.match(tls, /fastcgi_param HTTPS on;/);
  assert.match(tls, /fastcgi_pass unix:\/run\/php\/nute\.sock;/);
  assert.doesNotMatch(tls, /default_server|root \/srv\/nute;/);
});
test('dedicated FPM pool preserves 180 days and checkpoint capacity', () => {
  const pool = render('php-pool');
  assert.match(pool, /session\.gc_maxlifetime\] = 15552000/);
  assert.match(pool, /session\.save_path\] = \/var\/lib\/nute\/sessions/);
  assert.match(pool, /post_max_size\] = 20M/);
  assert.match(pool, /memory_limit\] = 192M/);
  assert.match(pool, /env\[NUTE_CONFIG_PATH\] = \/srv\/nute\/private\/config\.php/);
  assert.match(pool, /^user = nute$/m);
});
test('schema initialization permits foreign keys and leaves only runtime CRUD privileges', () => {
  const script = readFileSync(path.join(root, 'installer/install.sh'), 'utf8');
  const schema = readFileSync(path.join(root, 'database/mysql.sql'), 'utf8');
  assert.match(schema, /FOREIGN KEY\s*\([^)]+\)\s+REFERENCES\s+nute_owner/i);
  const grant = /GRANT ([A-Z, ]+) ON nute\.\* TO 'nute'@'localhost';/.exec(script);
  const revoke = /REVOKE ([A-Z, ]+) ON nute\.\* FROM 'nute'@'localhost';/.exec(script);
  assert.ok(grant, 'Missing scoped bootstrap permissions');
  assert.ok(revoke, 'Missing bootstrap permission removal');
  const granted = new Set(grant[1].split(',').map(value => value.trim()));
  const revoked = new Set(revoke[1].split(',').map(value => value.trim()));
  for (const privilege of ['CREATE', 'REFERENCES']) {
    assert.ok(granted.has(privilege), `${privilege} is needed to initialize the foreign-key schema`);
    assert.ok(revoked.has(privilege), `${privilege} must not remain after initialization`);
  }
  const init = script.indexOf('| php /srv/nute/current/scripts/init.php');
  assert.ok(grant.index < init && init < revoke.index, 'DDL permissions must bracket initialization');
  assert.deepEqual([...granted].filter(value => !revoked.has(value)).sort(),
    ['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
});
test('reject injection, URLs, invalid labels, IPs and incompatible modes before system operations', () => {
  for (const domain of ['https://notes.example.org', 'notes.example.org;id', 'a..example.org',
    '-bad.example.org', 'bad-.example.org', 'x/example.org', '*.example.org', '127.0.0.1',
    'notes.example.org\nserver {}', 'localhost', 'example.org.', `${'a'.repeat(64)}.org`]) {
    assert.notEqual(run(['--domain', domain, '--render', 'nginx-tls']).status, 0, domain);
  }
  assert.notEqual(run(['--domain', 'notes.example.org', '--email', 'a@b.org;id', '--check']).status, 0);
  assert.notEqual(run(['--domain', 'notes.example.org', '--render', 'nginx-http', '--check']).status, 0);
  assert.notEqual(run(['--domain', 'notes.example.org', '--render', 'unknown']).status, 0);
});
test('initializer builds new-instance configuration through stdin without inherited account material', () => {
  if (process.platform === 'win32') assert.ok(existsSync(php), 'Set NUTE_TEST_PHP to a local PHP CLI');
  const result = spawnSync(php, ['installer/init-input.php'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, NUTE_INSTALL_DOMAIN: 'vault.example.net', NUTE_INSTALL_DB_PASSWORD: 'a'.repeat(64) },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    environment: 'production', origin: 'https://vault.example.net',
    dsn: 'mysql:host=localhost;dbname=nute;charset=utf8mb4', db_user: 'nute', db_password: 'a'.repeat(64),
  });
  const invalid = spawnSync(php, ['installer/init-input.php'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NUTE_INSTALL_DB_PASSWORD: 'unsafe' },
  });
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, '');
});
