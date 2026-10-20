import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {createHmac,randomBytes} from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createSyncEngine} from '../public/assets/sync-engine.js';
import {changesBetween} from '../public/assets/sync-model.js';
import {emptyVault,makeNote} from '../public/assets/model.js';
import {createVaultKey,encryptVault,decryptVault} from '../public/assets/crypto.js';

test('real PHP sessions and encrypted sync survive offline process restart, background upload, checkpoint and deletion', {timeout:30000},async()=>{
  const root=path.resolve(import.meta.dirname,'..'),directory=await mkdtemp(path.join(os.tmpdir(),'nute-sync-http-'));
  const php=process.env.PHP_BINARY||(process.platform==='win32'?path.join(root,'.tools/php/php.exe'):'php');
  let processHandle;
  try{
    const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
    const origin=`http://127.0.0.1:${port}`,config=path.join(directory,'private/config.php');
    const init=spawnSync(php,['scripts/init.php',`--config=${config}`],{cwd:root,encoding:'utf8',input:JSON.stringify({environment:'local',origin,dsn:`sqlite:${path.join(directory,'fixture.sqlite')}`,db_user:'',db_password:''}),windowsHide:true});
    assert.equal(init.status,0,init.stderr);const token=init.stdout.match(/^[a-f0-9]{64}$/m)?.[0];assert.ok(token);
    processHandle=spawn(php,['-S',`127.0.0.1:${port}`,'-t','public'],{cwd:root,env:{...process.env,NUTE_CONFIG_PATH:config},stdio:'ignore',windowsHide:true});
    for(let i=0;i<100;i++){try{if((await fetch(origin+'/api.php?action=bootstrap')).ok)break;}catch{}await new Promise(r=>setTimeout(r,25));}
    function session(){const cookies=new Map();let csrf='';return async(action,data)=>{
      const response=await fetch(`${origin}/api.php?action=${action}`,{method:data===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Nute-Client':'0.4','X-CSRF-Token':csrf,Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')},body:data===undefined?undefined:JSON.stringify(data)});
      for(const header of response.headers.getSetCookie()){const part=header.split(';')[0],i=part.indexOf('=');cookies.set(part.slice(0,i),part.slice(i+1));}
      const value=await response.json();if(value.csrf)csrf=value.csrf;if(!response.ok)throw Object.assign(new Error(value.message),{status:response.status,code:value.error});return value;
    };}
    const phone=session(),web=session();await phone('bootstrap');
    const wrappingKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']),{key,wrappedKey}=await createVaultKey(wrappingKey);
    const initial=emptyVault();initial.notes.push({...makeNote(),body:'Original fixture'});
    const salt=randomBytes(16).toString('base64'),authProof=randomBytes(32).toString('base64'),email='sync-fixture@example.test';
    const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const hash=createHmac('sha1',Buffer.from('12345678901234567890')).update(counter).digest();const otp=String((hash.readUInt32BE(hash.at(-1)&15)&0x7fffffff)%1000000).padStart(6,'0');
    const owner=await phone('setup',{token,email,salt,authProof,wrappedKey,vault:await encryptVault(key,initial),totpSecret:'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',otp}); // gitleaks:allow -- Public RFC 6238 test vector in an isolated temporary account.
    await web('bootstrap');await web('login',{email,authProof,otp:owner.recoveryCodes[0],rememberDevice:true});
    const account={email,salt,wrappedKey},stores=new Map();
    async function diskStore(name){const file=path.join(directory,`${name}.json`);let state;try{state=JSON.parse(await readFile(file,'utf8'));}catch{state={cache:null,pending:[]};}const commit=()=>writeFile(file,JSON.stringify(state));stores.set(name,file);return {load:async()=>structuredClone(state),save:async fields=>{Object.assign(state,structuredClone(fields));await commit();},enqueue:async({operations})=>{state.pending.push(...structuredClone(operations));await commit();},ack:async({ids})=>{state.pending=state.pending.filter(op=>!ids.includes(op.id));await commit();}};}
    let online=true;const phoneRequest=(a,d)=>online?phone(a,d):Promise.reject(new Error('Offline'));
    let phoneStore=await diskStore('phone'),a=createSyncEngine({key,account,store:phoneStore,request:phoneRequest});
    const b=createSyncEngine({key,account,store:await diskStore('web'),request:web});await a.initialize(initial);await b.initialize(initial);await a.synchronize();await b.synchronize();
    const edit=async(engine,fn)=>{const before=await engine.view(),after=structuredClone(before);fn(after);await engine.stage(await changesBetween(before,after));};
    online=false;await edit(a,v=>v.notes.push({...makeNote(),title:'Offline phone',body:'Secret persisted while offline'}));await assert.rejects(a.synchronize(),/Offline/);a.close();
    const disk=await readFile(stores.get('phone'),'utf8');assert.ok(!disk.includes('Secret persisted while offline'),'only ciphertext reaches local disk');
    phoneStore=await diskStore('phone');a=createSyncEngine({key,account,store:phoneStore,request:phoneRequest});await a.initialize(initial);assert.equal((await a.view()).notes[1].body,'Secret persisted while offline');
    // UI closes; the native-worker-equivalent sends only durable opaque operations.
    a.close();online=true;await phone('sync_push',{operations:(await phoneStore.load()).pending});
    await edit(b,v=>v.notes[0].body='Web edited a different note');await b.synchronize();
    await web('sync_checkpoint',{cursor:b.cursor,vault:await encryptVault(key,await b.view())});
    a=createSyncEngine({key,account,store:await diskStore('phone'),request:phoneRequest});await a.initialize(initial);await a.synchronize();assert.deepEqual(await a.view(),await b.view());
    await edit(a,v=>v.notes[1].body='Stale disconnected edit');await edit(b,v=>v.notes[1].deleted=Date.now());await b.synchronize();await a.synchronize();await b.synchronize();assert.deepEqual(await a.view(),await b.view());assert.notEqual((await a.view()).notes[1].deleted,null);
    await edit(b,v=>v.notes=v.notes.filter(n=>n.deleted===null));await b.synchronize();await a.synchronize();assert.equal((await a.view()).notes.length,1);
    const cache=JSON.parse(await readFile(stores.get('phone'),'utf8'));assert.equal(cache.pending.length,0);assert.equal((await decryptVault(key,cache.cache.vault)).notes[0].body,'Web edited a different note');
    a.close();b.close();
  }finally{if(processHandle){processHandle.kill();await new Promise(r=>processHandle.once('exit',r));}await rm(directory,{recursive:true,force:true});}
});
