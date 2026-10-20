import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir(new URL('../public/assets/', import.meta.url), { recursive: true });
await build({ entryPoints: ['src/editor.js'], outfile: 'public/assets/editor.js', bundle: true, format: 'esm', target: ['es2022'], minify: true, legalComments: 'eof' });
const libraries = ['@tiptap/core','@tiptap/starter-kit','@tiptap/extension-list','@tiptap/extension-table','prosemirror-model','prosemirror-state','prosemirror-view','prosemirror-transform','prosemirror-tables','prosemirror-history','prosemirror-schema-list','prosemirror-commands','prosemirror-keymap','prosemirror-inputrules','prosemirror-gapcursor','prosemirror-dropcursor','orderedmap','rope-sequence','w3c-keyname'];
const licenses = [];
for (const name of libraries) {
  const root = new URL(`../node_modules/${name}/`, import.meta.url);
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  let license;
  for (const file of ['LICENSE','LICENSE.md','LICENSE.txt']) { try { license = await readFile(new URL(file, root), 'utf8'); break; } catch {} }
  if (!license) throw new Error(`Missing license for ${name}`);
  licenses.push(`${name} ${pkg.version}\n${license}`);
}
await writeFile(new URL('../public/assets/editor-LICENSE.txt', import.meta.url), licenses.join('\n\n---\n\n'));
console.log('Rich editor bundled locally, without CDN dependencies.');
