import { cp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(root, '../../public');
const target = path.join(root, 'ui');
// Rebuild only this generated directory so removed assets never linger in ASAR.
if (path.dirname(target) !== root || path.basename(target) !== 'ui') throw new Error('Unexpected UI staging path.');
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(path.join(source, 'assets'), path.join(target, 'assets'), { recursive: true });
await cp(path.join(source, 'favicon.png'), path.join(target, 'favicon.png'));
await cp(path.join(source, 'app.html'), path.join(target, 'index.html'));
async function inspect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await inspect(file);
    else if (/\.(?:php|sqlite|db|pem|key|env)$/i.test(entry.name)) throw new Error('Private/server file in packaged UI: ' + entry.name);
  }
}
await inspect(target);
const app = await readFile(path.join(target, 'assets/app.js'), 'utf8');
const platform = await readFile(path.join(target, 'assets/platform.js'), 'utf8');
if (!app.includes('nativePlatform') || !platform.includes('NuteNative')) throw new Error('The shared UI does not contain the native bridge integration.');
await writeFile(path.join(root, 'ui-build.json'), JSON.stringify({ createdAt: new Date().toISOString(), nativeBridge: true, source: 'public/app.html + public/assets + public/favicon.png' }, null, 2));
console.log('Copied local UI only; no PHP, configuration, credentials, or database.');
