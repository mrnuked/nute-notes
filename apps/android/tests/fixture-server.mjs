// Synthetic localhost fixture. No owner credentials or production API requests.
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { randomSalt, deriveKeys, createVaultKey, encryptVault } from '../../../public/assets/crypto.js';
import { emptyVault, makeNote } from '../../../public/assets/model.js';
const salt=randomSalt(), {authProof,wrappingKey}=await deriveKeys('Android fixture password 2026!',salt), {key,wrappedKey}=await createVaultKey(wrappingKey);
const plain=emptyVault(), note={...makeNote(),title:'Android fixture',body:'Initial fixture text'}; plain.notes.push(note);
const vault=await encryptVault(key,plain), csrf='android_fixture_csrf_2026', resumeSecret=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
const changes=[], seen=new Set(); let unavailable=false,delayPull=false,delayBootstrap=false;const waiting=[],bootstrapWaiting=[];
const report=()=>writeFileSync(new URL('../.emulator/fixture-result.json',import.meta.url),JSON.stringify({accepted:changes.map(x=>x.id),unavailable,count:changes.length},null,2));
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const b of req)raw+=b;let data={};try{data=JSON.parse(raw||'{}');}catch{}
 const url=new URL(req.url,'http://127.0.0.1:4187');
 const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':'__Host-nute=fixture-session; Secure; HttpOnly; Path=/; SameSite=Strict'});res.end(JSON.stringify(body));};
 if(url.pathname==='/control'){if(typeof data.unavailable==='boolean')unavailable=data.unavailable;if(typeof data.delayPull==='boolean'){delayPull=data.delayPull;if(!delayPull)while(waiting.length)waiting.shift()();}if(typeof data.delayBootstrap==='boolean'){delayBootstrap=data.delayBootstrap;if(!delayBootstrap)while(bootstrapWaiting.length)bootstrapWaiting.shift()();}report();return send(200,{unavailable,count:changes.length,waiting:waiting.length,bootstrapWaiting:bootstrapWaiting.length});}
 if(unavailable)return send(503,{message:'Fixture temporarily offline'});
 const action=url.searchParams.get('action'), base={csrf,syncProtocol:1,trustedDevice:true};
 if(action==='bootstrap'){if(delayBootstrap)await new Promise(resolve=>bootstrapWaiting.push(resolve));return send(200,{...base,initialized:true});}
 if(req.headers.origin!=='http://127.0.0.1:4187'||req.headers['x-nute-client']!=='0.4'||(req.method!=='GET'&&req.headers['x-csrf-token']!==csrf)||!req.headers.cookie?.includes('__Host-nute=fixture-session'))return send(403,{message:'Native cookie/CSRF headers missing'});
 if(action==='email')return send(200,{...base,salt});
 if(action==='login' && data.authProof!==authProof)return send(401,{message:'Invalid synthetic credentials'});
 if(action==='login'||action==='resume')return send(200,{...base,email:'android@example.test',salt,wrappedKey,vault,revision:1,resumeSecret});
 if(action==='sync_pull'){if(delayPull)await new Promise(resolve=>waiting.push(resolve));return send(200,{...base,baseline:data.after===0?{cursor:0,vault}:null,cursor:changes.length,changes:changes.filter(x=>x.seq>data.after),received:(data.pendingIds||[]).filter(id=>seen.has(id)),hasMore:false});}
 if(action==='sync_push'){
  const accepted=[];for(const op of data.operations||[]){if(!seen.has(op.id)){changes.push({...op,seq:changes.length+1});seen.add(op.id);}accepted.push(op.id);}report();return send(200,{...base,accepted,cursor:changes.length});
 }
 if(action==='sync_checkpoint')return send(200,{...base,ok:true});
 if(action==='devices')return send(200,{...base,devices:[]});
 send(400,{message:'Unsupported fixture action'});
});
server.listen(4187,'127.0.0.1',()=>{report();process.stdout.write('Synthetic Android fixture ready on localhost:4187\n');});
