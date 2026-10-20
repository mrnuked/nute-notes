import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import storeModule from '../src/store.cjs';
import serviceModule from '../src/service.cjs';
import workerModule from '../src/worker.cjs';
import C from '../src/contracts.cjs';
const { Store } = storeModule, { Service } = serviceModule, { Worker } = workerModule;
const op = () => ({ id: randomUUID(), data: { v: 1, iv: randomBytes(12).toString('base64'), ciphertext: randomBytes(48).toString('base64') } });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nute-windows-'));
  t.after(async () => { assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('nute-windows-')); await rm(dir, { recursive: true, force: true }); });
  const key = randomBytes(32);
  const protect = { encrypt(value) { const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv); const bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]); return Buffer.concat([iv,cipher.getAuthTag(),bytes]); },
    decrypt(value) { const cipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12)); cipher.setAuthTag(value.subarray(12,28)); return Buffer.concat([cipher.update(value.subarray(28)),cipher.final()]).toString('utf8'); } };
  const store = await new Store(dir, protect).initialize();
  await store.transaction(s => { s.credentials = { csrf: 'a'.repeat(64), cookies: {'__Host-nute':{value:'private-cookie',expires:null}} }; });
  return { store, dir, protect, async restart() { return new Store(dir,protect).initialize(); } };
}
test('atomic protected storage survives restart and preserves delivered outbox until UI cache acknowledgement', async t => {
  const f=await fixture(t), a=op(), b=op();
  await f.store.save({cache:{cursor:0,vault:'encrypted'},unlock:{resumeSecret:'private-unlock'}});
  await f.store.enqueue({operations:[a,b]}); await f.store.delivered({ids:[a.id]});
  const restarted=await f.restart(); const loaded=await restarted.load();
  assert.deepEqual(loaded.pending,[a,b]); assert.equal(loaded.unlock.resumeSecret,'private-unlock');
  const text=await readFile(f.store.file,'utf8'); assert.ok(!text.includes('private-cookie') && !text.includes('private-unlock'));
  await Promise.all([restarted.save({cache:{cursor:9,vault:'new-encrypted'}}),restarted.ack({ids:[a.id]}),restarted.enqueue({operations:[op()]})]);
  const again=await f.restart(); assert.equal((await again.load()).cache.cursor,9); assert.equal((await again.load()).pending.length,2); assert.ok(!(await again.load()).pending.some(x=>x.id===a.id));
  await again.clear({credentials:true}); assert.equal((await again.load()).unlock,null); assert.equal((await again.load()).pending.length,2); assert.equal((await again.load()).cache.cursor,9);
});

test('custom server owns request origin and cookies; redirects cannot move credentials elsewhere', async t => {
  const f = await fixture(t), sent = [];
  const service = new Service(f.store, async (url, options) => {
    sent.push({url, options});
    return new Response(JSON.stringify({ok:true}), {status:200,headers:{'Content-Type':'application/json'}});
  }, 'https://vault.example.net');
  await service.request({action:'sync_pull',method:'POST',data:{}});
  assert.equal(sent[0].url,'https://vault.example.net/api.php?action=sync_pull');
  assert.equal(sent[0].options.headers.Origin,'https://vault.example.net');
  assert.equal(sent[0].options.redirect,'manual');
  const redirect = new Service(f.store, async () => new Response('',{status:302,headers:{Location:'https://other.example.net/'}}), 'https://vault.example.net');
  await assert.rejects(redirect.request({action:'bootstrap',method:'GET'}), /Перенаправление/);
  assert.throws(() => new Service(f.store, globalThis.fetch, 'http://vault.example.net'));
});
test('duplicate operation payload cannot change and failed persistence leaves prior durable state intact', async t => {
  const f=await fixture(t), a=op(); await f.store.enqueue({operations:[a,a]});
  assert.equal((await f.store.load()).pending.length,1);
  await assert.rejects(f.store.enqueue({operations:[{...op(),id:a.id}]}), /Повторный/);
  const encrypt=f.protect.encrypt; f.protect.encrypt=()=>{throw new Error('DPAPI unavailable');};
  await assert.rejects(f.store.save({cache:{cursor:99}}),/DPAPI/); f.protect.encrypt=encrypt;
  assert.equal((await f.store.load()).cache,null); assert.deepEqual((await(await f.restart()).load()).pending,[a]);
});

test('durable revocation survives failed state rewrite and restart without deleting notes, queue or trust', async t => {
  const f = await fixture(t), a = op();
  const cache = {cursor:7,vault:'ciphertext'}, unlock = {resumeSecret:'synthetic-secret'};
  await f.store.save({cache,unlock}); await f.store.enqueue({operations:[a]});
  const before = await f.store.snapshot(), persist = f.store.persist;
  f.store.persist = async () => { throw new Error('ENOSPC'); };
  await assert.rejects(f.store.clear({credentials:false}), /ENOSPC/);
  const restarted = await f.restart(), view = await restarted.load();
  assert.equal(view.unlock, null); assert.equal(view.lockPending, true);
  assert.deepEqual(view.cache, cache); assert.deepEqual(view.pending, [a]);
  assert.deepEqual((await restarted.snapshot()).credentials, before.credentials);
  await restarted.setError('Background sender failed');
  assert.equal((await (await f.restart()).load()).unlock, null, 'background credential/cache rewrites cannot remove revocation');
  f.store.persist = persist; await restarted.clear({credentials:false});
  await restarted.save({unlock:{resumeSecret:'fresh-password-login'}});
  assert.equal((await (await f.restart()).load()).unlock.resumeSecret, 'fresh-password-login');
  assert.deepEqual((await restarted.load()).pending, [a]);
});

test('failure to create revocation barrier never acknowledges successful clear', async t => {
  const f = await fixture(t); await f.store.save({unlock:{resumeSecret:'synthetic'}});
  f.store.revokeUnlock = async () => { throw new Error('EACCES'); };
  await assert.rejects(f.store.clear({credentials:false}), /EACCES/);
  assert.equal((await (await f.restart()).load()).unlock.resumeSecret, 'synthetic', 'caller must show incomplete lock when even the independent barrier cannot persist');
});
test('temporary Windows file sharing lock retries replacement without deleting the existing queue', async t => {
  const f=await fixture(t), a=op(); await f.store.enqueue({operations:[a]}); const rename=fs.rename; let retries=0;
  fs.rename=async(source,target)=>{if(target===f.store.file && retries++===0){const error=new Error('Scanner holds file');error.code='EPERM';throw error;}return rename(source,target);};
  try { await f.store.save({cache:{cursor:1,vault:'encrypted'}}); } finally { fs.rename=rename; }
  assert.equal(retries,2); assert.deepEqual((await(await f.restart()).load()).pending,[a]); assert.equal((await f.store.load()).cache.cursor,1);
});
test('background delivery retains ciphertext for offline restart and never removes concurrent enqueues', async t => {
  const f=await fixture(t), a=op(), b=op(), response=deferred(), requested=deferred(); await f.store.enqueue({operations:[a]});
  let requests=0;
  const worker=new Worker(f.store,{request:async request=>{requests++; assert.equal(request.action,'sync_push'); requested.resolve(); if(requests===1)return response.promise; return {status:200,body:{accepted:request.data.operations.map(x=>x.id)}}; }});
  const sending=worker.run(); await requested.promise; await f.store.enqueue({operations:[b]});
  response.resolve({status:200,body:{accepted:[a.id]}}); await sending; worker.stop();
  const restarted=await f.restart(); assert.deepEqual((await restarted.load()).pending,[a,b]);
  let resent=false; const afterRestart=new Worker(restarted,{request:async()=>{resent=true;throw new Error('Must not resend delivered');}});
  await afterRestart.run(); afterRestart.stop(); assert.equal(resent,false);
  await restarted.save({cache:{cursor:2,vault:'both-encrypted'}}); await restarted.ack({ids:[a.id,b.id]}); assert.deepEqual((await restarted.load()).pending,[]);
});
test('lost upload response retries immutable operation, while 401 retains queue without a rapid retry', async t => {
  const f=await fixture(t), a=op(); await f.store.enqueue({operations:[a]}); const timers=[]; const accepted=new Set(); let attempts=0;
  const worker=new Worker(f.store,{request:async request=>{attempts++; for(const value of request.data.operations)accepted.add(value.id); if(attempts===1)throw new Error('Response lost'); return {status:200,body:{accepted:[a.id]}};}},{setTimeout:(cb,ms)=>{timers.push({cb,ms});return timers.length;},clearTimeout(){}});
  await worker.run(); assert.equal((await f.store.load()).pending.length,1); assert.equal(timers[0].ms,5000); await worker.run(); worker.stop(); assert.equal(accepted.size,1); assert.equal(attempts,2);
  const b=op(); await f.store.enqueue({operations:[b]}); let scheduled=false;
  const blocked=new Worker(f.store,{request:async()=>({status:401,body:{}})},{setTimeout:()=>{scheduled=true;},clearTimeout(){}});
  await blocked.run(); blocked.stop(); assert.equal(scheduled,false); assert.equal((await f.store.load()).pending.length,2); assert.match((await f.store.load()).lastError,/войдите/);
});
test('native HTTP restricts origin/method, persists secure cookies and CSRF, and serializes credential clearing', async t => {
  const f=await fixture(t), response=deferred(), called=deferred(); const seen=[];
  const service=new Service(f.store,async(url,options)=>{seen.push({url,options}); if(seen.length===1){called.resolve();return response.promise;}return new Response('{}',{status:200});});
  const request=service.request({action:'bootstrap',method:'GET'}); await called.promise;
  const clearing=service.clear({credentials:true});
  response.resolve(new Response(JSON.stringify({csrf:'b'.repeat(64)}),{status:200,headers:{'Set-Cookie':'__Host-nute=replacement; Path=/; Secure; HttpOnly; SameSite=Strict'}}));
  await request; await clearing;
  assert.deepEqual((await f.store.snapshot()).credentials,{cookies:{},csrf:''});
  await f.store.transaction(s=>{s.credentials.csrf='c'.repeat(64);});
  await service.request({action:'sync_push',method:'POST',data:{operations:[]}});
  assert.equal(seen[1].url,'https://notes.example.org/api.php?action=sync_push'); assert.equal(seen[1].options.headers.Origin,'https://notes.example.org'); assert.equal(seen[1].options.headers['X-CSRF-Token'],'c'.repeat(64)); assert.equal(seen[1].options.headers['X-Nute-Client'],'0.4'); assert.equal(seen[1].options.redirect,'manual');
  assert.throws(()=>service.request({action:'https://evil.example',method:'GET'})); assert.throws(()=>service.request({action:'bootstrap',method:'POST'}));
  const redirect=new Service(f.store,async()=>new Response('',{status:302,headers:{Location:'https://evil.example'}})); await assert.rejects(redirect.request({action:'bootstrap',method:'GET'}),/Перенаправление/);
});
test('IPC sender and local asset validation reject remote frames, path escapes and arbitrary external protocols', () => {
  const contents={isDestroyed:()=>false,mainFrame:{url:'nute://app/index.html'}};
  assert.equal(C.senderAllowed({sender:contents,senderFrame:contents.mainFrame},contents),true);
  assert.equal(C.senderAllowed({sender:contents,senderFrame:{url:'nute://app/index.html'}},contents),false);
  contents.mainFrame.url='https://notes.example.org/'; assert.equal(C.senderAllowed({sender:contents,senderFrame:contents.mainFrame},contents),false);
  for(const url of ['nute://evil/index.html','nute://app/assets/%2e%2e/%2e%2e/private/config.php','nute://app/assets/%5csecret.js','file:///C:/secret.js'])assert.equal(C.assetPath(url,'C:/nute/ui'),null);
  assert.ok(C.assetPath('nute://app/assets/app.js?v=0.4','C:/nute/ui'));
  assert.equal(C.externalUrl('https://www.icloud.com/notes/note/'),true);
  for(const url of ['file:///cmd.exe','https://icloud.com.evil.example','https://evil@icloud.com','https://icloud.com:444'])assert.equal(C.externalUrl(url),false);
});

test('PIN registration and checks reach fixed native service with CSRF and preserve throttling responses', async t => {
  const f=await fixture(t), seen=[], data={id:randomUUID(),proof:'d'.repeat(64)};
  const service=new Service(f.store,async(url,options)=>{seen.push({url,options});return new Response(JSON.stringify({message:'PIN attempt throttled',retryAfter:30}),{status:429});});
  for(const action of ['pin_register','pin_check']) {
    const result=await service.request({action,method:'POST',data});
    assert.equal(result.status,429); assert.equal(result.body.retryAfter,30);
    const sent=seen.at(-1); assert.equal(sent.url,'https://notes.example.org/api.php?action='+action);
    assert.deepEqual(JSON.parse(sent.options.body),data); assert.equal(sent.options.headers['X-CSRF-Token'],'a'.repeat(64));
    assert.throws(()=>C.request({action,method:'GET'}));
  }
});
test('large recovery cache and checkpoint keep distinct bounds from operation batches', async t => {
  const f=await fixture(t), cache={cursor:20,vault:{ciphertext:'A'.repeat(18*1024*1024)}};
  await f.store.save({cache}); assert.equal((await(await f.restart()).load()).cache.vault.ciphertext.length,18*1024*1024);
  const data={vault:{ciphertext:'A'.repeat(5*1024*1024)}};
  assert.throws(()=>C.request({action:'sync_push',method:'POST',data}));
  assert.equal(C.request({action:'sync_checkpoint',method:'POST',data}).data.vault.ciphertext.length,5*1024*1024);
  let sent=0; const service=new Service(f.store,async(_url,options)=>{sent=Buffer.byteLength(options.body);return new Response(JSON.stringify({ok:true,padding:'x'.repeat(17*1024*1024)}),{status:200});});
  const response=await service.request({action:'sync_checkpoint',method:'POST',data}); assert.ok(sent>4*1024*1024);assert.equal(response.status,200);
  assert.throws(()=>C.operations({operations:[{...op(),data:{v:1,iv:'AAAAAAAAAAAAAAAA',ciphertext:'A'.repeat(2800004)}}]}));
  await assert.rejects(async()=>f.store.save({unlock:{data:'A'.repeat(65536)}}));
});
