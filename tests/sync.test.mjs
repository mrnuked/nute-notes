import test from 'node:test';
import assert from 'node:assert/strict';
import {createSyncEngine} from '../public/assets/sync-engine.js';
import {changesBetween, replica} from '../public/assets/sync-model.js';
import {emptyVault,makeNote} from '../public/assets/model.js';
import {encryptVault} from '../public/assets/crypto.js';

function store() {
  const state={cache:null,unlock:null,pending:[],lastError:null};
  return {state, async load(){return structuredClone(state);},async save(fields){Object.assign(state,structuredClone(fields));},async enqueue({operations}){for(const op of operations)if(!state.pending.some(item=>item.id===op.id))state.pending.push(structuredClone(op));},async ack({ids}){state.pending=state.pending.filter(op=>!ids.includes(op.id));}};
}
async function fixture() {
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const initial=emptyVault(); initial.notes.push({...makeNote(),title:'Shared',body:'Original'});
  let baseline={cursor:0,vault:await encryptVault(key,initial)},head=0,changes=[],online=true;
  const receipts=new Map(),account={email:'fixture@example.test',salt:'fixture',wrappedKey:{ciphertext:'fixture'}};
  const request=async(action,data)=>{
    if(!online)throw new Error('Offline');
    if(action==='sync_pull'){
      const base=data.after<=baseline.cursor?baseline:null,start=base?base.cursor:data.after;
      const page=changes.filter(op=>op.seq>start).slice(0,2),cursor=page.at(-1)?.seq??start;
      return {baseline:base,changes:page,cursor,hasMore:head>cursor,received:data.pendingIds.filter(id=>(receipts.get(id)?.seq??Infinity)<=cursor)};
    }
    if(action==='sync_push'){
      for(const op of data.operations){const previous=receipts.get(op.id);if(previous){assert.deepEqual(previous.data,op.data);continue;}const item={...structuredClone(op),seq:++head};changes.push(item);receipts.set(op.id,item);}
      return {accepted:data.operations.map(op=>op.id),cursor:head};
    }
    if(action==='sync_checkpoint'){assert.equal(data.cursor,head);baseline={cursor:head,vault:data.vault};changes=[];return {ok:true};}
    throw new Error('Unexpected request');
  };
  const make=async(local=store(),transport=request)=>{const engine=createSyncEngine({key,account,store:local,request:transport});await engine.initialize(initial);return {engine,local};};
  const edit=async(engine,change)=>{const before=await engine.view(),after=structuredClone(before);change(after);await engine.stage(await changesBetween(before,after));};
  return {key,initial,request,make,edit,offline:()=>online=false,online:()=>online=true,receipts};
}
test('two offline devices merge different notes and converge after reconnect without discarding queued edits',async()=>{
  const f=await fixture(),a=await f.make(),b=await f.make();await a.engine.synchronize();await b.engine.synchronize();f.offline();
  await f.edit(a.engine,v=>v.notes.push({...makeNote(),title:'Phone',body:'Offline phone'}));
  await f.edit(b.engine,v=>v.notes[0].body='Desktop edit');
  await assert.rejects(a.engine.synchronize(),/Offline/);assert.equal(a.local.state.pending.length,1);
  f.online();await b.engine.synchronize();await a.engine.synchronize();await b.engine.synchronize();
  assert.deepEqual(await a.engine.view(),await b.engine.view());
  assert.deepEqual((await a.engine.view()).notes.map(n=>n.body),['Desktop edit','Offline phone']);
  assert.equal(a.local.state.pending.length,0);assert.equal(b.local.state.pending.length,0);
});
test('soft and permanent deletions win over stale offline edits; explicit restore still works',async()=>{
  const f=await fixture(),a=await f.make(),b=await f.make();await a.engine.synchronize();await b.engine.synchronize();
  await f.edit(b.engine,v=>v.notes[0].body='Stale offline edit');
  await f.edit(a.engine,v=>v.notes[0].deleted=Date.now());await a.engine.synchronize();await b.engine.synchronize();await a.engine.synchronize();
  assert.notEqual((await b.engine.view()).notes[0].deleted,null);assert.equal((await b.engine.view()).notes.length,1);
  await f.edit(a.engine,v=>v.notes[0].deleted=null);await a.engine.synchronize();await b.engine.synchronize();assert.equal((await b.engine.view()).notes[0].deleted,null);
  await f.edit(b.engine,v=>v.notes[0].body='Stale after purge');
  await f.edit(a.engine,v=>v.notes=[]);await a.engine.synchronize();await b.engine.synchronize();assert.equal((await b.engine.view()).notes.length,0);
});
test('simultaneous same-note edits retain both versions identically across peers',async()=>{
  const f=await fixture(),a=await f.make(),b=await f.make();await a.engine.synchronize();await b.engine.synchronize();
  await f.edit(a.engine,v=>v.notes[0].body='Version A');await f.edit(b.engine,v=>v.notes[0].body='Version B');
  await a.engine.synchronize();await b.engine.synchronize();await a.engine.synchronize();
  const value=await a.engine.view();assert.deepEqual(value,await b.engine.view());assert.deepEqual(value.notes.map(n=>n.body).sort(),['Version A','Version B']);
});
test('background delivery followed by checkpoint and offline restart retains edits and retires exact receipts',async()=>{
  const f=await fixture(),a=await f.make(),b=await f.make();await a.engine.synchronize();await b.engine.synchronize();
  await f.edit(a.engine,v=>v.notes.push({...makeNote(),title:'Closed app',body:'Sent in background'}));
  // Native worker delivers ciphertext but keeps the local operation until UI receipt reconciliation.
  await f.request('sync_push',{operations:a.local.state.pending});
  await b.engine.synchronize();await f.request('sync_checkpoint',{cursor:b.engine.cursor,vault:await encryptVault(f.key,await b.engine.view())});
  a.engine.close();f.offline();const restarted=await f.make(a.local);
  assert.equal((await restarted.engine.view()).notes[1].body,'Sent in background');
  f.online();await restarted.engine.synchronize();assert.equal((await restarted.engine.view()).notes.length,2);assert.equal(a.local.state.pending.length,0);
});
test('cache-before-ack crash recovery never applies a received operation twice',async()=>{
  const f=await fixture(),a=await f.make();await a.engine.synchronize();await f.edit(a.engine,v=>v.notes[0].body='Durable edit');
  const realAck=a.local.ack;let fail=true;a.local.ack=async args=>{if(fail&&args.ids.length)throw new Error('Process interrupted');return realAck(args);};
  await assert.rejects(a.engine.synchronize(),/interrupted/);assert.equal(a.local.state.pending.length,1);assert.equal(a.local.state.cache.acknowledged.length,1);
  a.engine.close();fail=false;const restarted=await f.make(a.local);assert.equal(a.local.state.pending.length,0);assert.equal((await restarted.engine.view()).notes.length,1);assert.equal((await restarted.engine.view()).notes[0].body,'Durable edit');
});
test('a hanging network request cannot delay durable local edits',async()=>{
  const f=await fixture();let release,started;
  const reached=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
  const a=await f.make(store(),async(action,data)=>{if(action==='sync_pull'){started();await gate;}return f.request(action,data);});
  const syncing=a.engine.synchronize();await reached;
  await f.edit(a.engine,v=>v.notes[0].body='Written while request hangs');
  assert.equal(a.local.state.pending.length,1,'outbox is durable before stalled network resolves');
  release();await syncing;assert.equal((await a.engine.view()).notes[0].body,'Written while request hangs');
});

test('a replica larger than the legacy vault cap remains readable after restart and compacts by bytes',async()=>{
  const f=await fixture();let checkpoints=0;
  const a=await f.make(store(),async(action,data)=>{if(action==='sync_checkpoint')checkpoints++;return f.request(action,data);});
  for(let i=0;i<8;i++){await f.edit(a.engine,v=>v.notes.push({...makeNote(),body:'x'.repeat(450000)}));await a.engine.synchronize();}
  assert.ok(a.local.state.cache.vault.ciphertext.length>2800000);assert.ok(checkpoints>0,'compaction precedes100operations');
  a.engine.close();const restarted=await f.make(a.local);assert.equal((await restarted.engine.view()).notes.length,9);
  assert.equal((await restarted.engine.view()).notes[8].body.length,450000);
});

test('a full server journal is compacted before retrying the same durable pending batch',async()=>{
  const f=await fixture();let used=0,compactions=0;
  const a=await f.make(store(),async(action,data)=>{
    if(action==='sync_push'&&used>=2)throw Object.assign(new Error('Journal full'),{status:413,code:'sync_journal_full'});
    const result=await f.request(action,data);
    if(action==='sync_push')used++;
    if(action==='sync_checkpoint'){used=0;compactions++;}
    return result;
  });
  for(let i=0;i<5;i++){await f.edit(a.engine,v=>v.notes[0].body='Edit '+i);await a.engine.synchronize();}
  assert.equal(compactions,2);assert.equal((await a.engine.view()).notes[0].body,'Edit 4');assert.equal(a.local.state.pending.length,0);assert.equal(f.receipts.size,5);
});

test('cache write failure never advances the durable cursor or retires unrecorded operations',async()=>{
  const f=await fixture(),a=await f.make();await a.engine.synchronize();await f.edit(a.engine,v=>v.notes[0].body='Must survive quota error');
  const save=a.local.save;a.local.save=async fields=>{if(fields.cache.cursor>0)throw new Error('Disk full');return save(fields);};
  await assert.rejects(a.engine.synchronize(),/Disk full/);assert.equal(a.local.state.cache.cursor,0);assert.equal(a.local.state.pending.length,1);assert.equal(a.engine.cursor,0);
  a.local.save=save;await a.engine.synchronize();assert.equal((await a.engine.view()).notes[0].body,'Must survive quota error');assert.equal(a.local.state.pending.length,0);
});

test('a merged note-count overflow can be reduced through the normal Trash then purge sequence',async()=>{
  const f=await fixture(),local=store(),value=structuredClone(f.initial);
  while(value.notes.length<5001)value.notes.push({...makeNote(),body:'small'});
  local.state.cache={email:'fixture@example.test',salt:'fixture',wrappedKey:{ciphertext:'fixture'},cursor:0,acknowledged:[],vault:await encryptVault(f.key,value)};
  const a=await f.make(local);await f.edit(a.engine,v=>v.notes[0].deleted=Date.now());assert.notEqual((await a.engine.view()).notes[0].deleted,null);
  await f.edit(a.engine,v=>v.notes.shift());assert.equal((await a.engine.view()).notes.length,5000);assert.equal(local.state.pending.length,2);
});
