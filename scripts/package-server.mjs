import { cp, mkdir, readdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const stage=path.join(root,'dist',`nute-notes-${version}-${Date.now()}`);
await mkdir(stage,{recursive:true});
async function copy(relative) {
  const from=path.join(root,relative), info=await lstat(from);
  if(info.isSymbolicLink()) throw new Error('Symlink forbidden: '+relative);
  if(info.isDirectory()) { for(const file of await readdir(from)) await copy(relative+'/'+file); return; }
  if(/(^|\/)(private|node_modules|\.tools|\.git)(\/|$)|\.(sqlite|db|pem|key|env|p12|jks)$/i.test(relative)) throw new Error('Private file forbidden');
  await mkdir(path.dirname(path.join(stage,relative)),{recursive:true});
  await cp(from,path.join(stage,relative));
}
for(const name of ['public','server','database','installer','docs','README.md','README.en.md','LICENSE','SECURITY.md','THIRD_PARTY_NOTICES.md',
  'scripts/init.php','scripts/migrate-0.2.0.php','scripts/migrate-0.3.0.php','scripts/migrate-0.4.0.php']) await copy(name);
async function files(dir) { const out=[];for(const item of await readdir(dir,{withFileTypes:true})) {
  const file=path.join(dir,item.name); if(item.isDirectory())out.push(...await files(file));else out.push(file);
}return out.sort(); }
const lines=[];
for(const file of await files(stage)) lines.push(`${createHash('sha256').update(await readFile(file)).digest('hex')}  ${path.relative(stage,file).replaceAll('\\','/')}`);
await writeFile(path.join(stage,'SHA256SUMS.txt'),lines.join('\n')+'\n');
const archive=path.join(root,'dist',`nute-notes-server-${version}.tar.gz`);
const result=spawnSync('tar',['-czf',archive,'-C',stage,'.'],{encoding:'utf8',windowsHide:true});
if(result.error || result.status!==0) throw new Error(result.error?.message || result.stderr);
await writeFile(archive+'.sha256',createHash('sha256').update(await readFile(archive)).digest('hex')+'  '+path.basename(archive)+'\n');
console.log(`Server archive: ${archive} (${lines.length} public files; no accounts or configuration)`);
