import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const repo = path.resolve(root, '../..');
for (const name of ['src', 'ui']) await mkdir(path.join(root, name), { recursive: true });
await cp(path.join(repo, 'apps/windows/src'), path.join(root, 'src'), { recursive: true });
await cp(path.join(repo, 'public/assets'), path.join(root, 'ui/assets'), { recursive: true });
await cp(path.join(repo, 'public/app.html'), path.join(root, 'ui/index.html'));
await cp(path.join(repo, 'public/favicon.png'), path.join(root, 'ui/favicon.png'));
async function inspect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Symlink in application assets');
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await inspect(file);
    else if (/\.(php|sqlite|db|pem|key|env)$/i.test(entry.name)) throw new Error('Private file in application: ' + entry.name);
  }
}
await inspect(path.join(root, 'src')); await inspect(path.join(root, 'ui'));
console.log('Ubuntu staging: shared desktop source, public UI; no server configuration, accounts or keys.');
