import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const php = process.env.PHP_BINARY || (existsSync(resolve(root, '.tools/php/php.exe')) ? resolve(root, '.tools/php/php.exe') : 'php');
const port = Number(process.env.PORT || 4173);
const config = resolve(root, 'private/local-config.php');
mkdirSync(resolve(root, 'private/sessions'), { recursive: true });
if (!existsSync(config)) {
  const run = spawnSync(php, [resolve(root, 'scripts/init.php'), `--config=${config}`], { cwd: root, input: JSON.stringify({ environment: 'local', origin: `http://127.0.0.1:${port}`, dsn: `sqlite:${resolve(root, 'private/local.sqlite')}`, db_user: '', db_password: '' }), encoding: 'utf8' });
  if (run.status !== 0) { process.stderr.write(run.stderr || 'PHP initialization failed'); process.exit(1); }
  const token = run.stdout.match(/\b[a-f0-9]{64}\b/)?.[0];
  writeFileSync(resolve(root, 'private/local-setup-token.txt'), token || run.stdout, { mode: 0o600 });
  console.log('Local setup key saved to private/local-setup-token.txt. Open /?setup to create your local account.');
}
console.log(`NUTE local preview: http://127.0.0.1:${port}`);
const child = spawn(php, ['-d', `session.save_path=${resolve(root, 'private/sessions')}`, '-S', `127.0.0.1:${port}`, '-t', resolve(root, 'public'), resolve(root, 'scripts/router.php')], { cwd: root, stdio: 'inherit', env: { ...process.env, NUTE_CONFIG_PATH: config }, windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
process.on('SIGINT', () => child.kill()); process.on('SIGTERM', () => child.kill());
