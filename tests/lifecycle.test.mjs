import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as cryptoFunctions from '../public/assets/crypto.js';
import * as modelFunctions from '../public/assets/model.js';
import * as folderFunctions from '../public/assets/folders.js';
import * as pinFunctions from '../public/assets/note-pin.js';
import { createNoteLocks } from '../public/assets/note-locks.js';
import { createSyncEngine } from '../public/assets/sync-engine.js';
import { changesBetween, canonical } from '../public/assets/sync-model.js';
import * as resumeFunctions from '../public/assets/session-resume.js';
import { plainDocument } from '../public/assets/document.js';

// Execute the complete production module with its real model and cryptography.
// Only browser DOM, timer, storage, and network boundaries are replaced. The
// appended test accessor exposes state transitions without copying their code.
const source = (await readFile(new URL('../public/assets/app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const html = await readFile(new URL('../public/app.html', import.meta.url), 'utf8');
const pendingName = 'nute:encrypted-pending:v1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await delay(2); }
  assert.fail('Timed out waiting for the observable asynchronous boundary');
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Element {
  constructor() { this.value = ''; this.textContent = ''; this.hidden = false; this.inert = false; this.open = false; this.children = []; this.listeners = new Map(); this.attributes = new Map(); const classes = new Set(); this.classList = { add: item => classes.add(item), remove: item => classes.delete(item), contains: item => classes.has(item) }; }
  addEventListener(type, listener, options = {}) { const entries = this.listeners.get(type) || []; entries.push({ listener, once: options.once }); this.listeners.set(type, entries); }
  async emit(type, event = {}) {
    const entries = [...(this.listeners.get(type) || [])];
    for (const entry of entries) { if (entry.once) this.listeners.set(type, this.listeners.get(type).filter(item => item !== entry)); await entry.listener({ target: this, preventDefault() {}, ...event }); }
  }
  dispatchEvent(event) { this.emit(event.type); return true; }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  focus() {}
  click() { this.emit('click'); }
  closest() { return null; }
  reset() {}
  getContext() { return { clearRect() {} }; }
  showModal() { this.open = true; }
  close(value) { if (!this.open) return; this.open = false; this.returnValue = value; this.emit('close'); }
}
async function harness(native = null) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const storage = new Map();
  const requests = [];
  const timers = new Map();
  const intervals = [];
  const downloads = [];
  const durable = {cache:null,unlock:null,pending:[]};
  const localStore = {async load(){return structuredClone(durable);},async save(fields){Object.assign(durable,structuredClone(fields));},async enqueue({operations}){durable.pending.push(...structuredClone(operations));},async ack({ids}){durable.pending=durable.pending.filter(op=>!ids.includes(op.id));},async clear(){durable.unlock=null;return {ok:true};}};
  let noteActions;
  let storageUnavailable = false;
  let timerId = 0;
  let clockOffset = 0;
  class TestDate extends Date { static now() { return Date.now() + clockOffset; } }
  let handler = async (action, options) => {
    if (action === 'bootstrap') return { initialized: true, csrf: 'test-csrf' };
    if (action === 'logout') return { ok: true };
    if (action === 'pin_register' || action === 'pin_check') return { ok: true };
    if (action === 'vault' && options.method === 'PUT') return { revision: JSON.parse(options.body).revision + 1 };
    throw new Error('Unexpected test network request');
  };
  const browserWindow = new Element();
  const document = new Element();
  document.getElementById = id => { assert.ok(elements.has(id), `Known DOM element ${id}`); return elements.get(id); };
  document.createElement = () => new Element();
  document.createTextNode = value => ({ textContent: value });
  const sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (storageUnavailable) throw new Error('Storage quota exceeded'); storage.set(key, value); }, removeItem: key => storage.delete(key) };
  const context = vm.createContext({
    ...cryptoFunctions, ...modelFunctions, ...folderFunctions, ...resumeFunctions, ...pinFunctions, createNoteLocks,
    nativePlatform:()=>native, localStore, createSyncEngine, changesBetween, canonical,
    readResume: () => resumeFunctions.readResume(sessionStorage), writeResume: capsule => resumeFunctions.writeResume(capsule, sessionStorage), clearResume: () => resumeFunctions.clearResume(sessionStorage),
    createNoteEditor: element => ({ setNote(note) { element.value = note.body; }, clear() { element.value = ''; }, command() {}, focus() {} }),
    createNoteMenu: (element, options) => { noteActions = options; return { bind() {}, close() {} }; },
    document, window: browserWindow, crypto: globalThis.crypto, Intl, Date: TestDate, structuredClone, TextEncoder, TextDecoder,
    URLSearchParams, AbortSignal, Event, Blob,
    URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
    location: { search: '', pathname: '/', reload() {} }, history: { replaceState() {} },
    QRCode: { toCanvas: async () => {} }, Option: class extends Element { constructor(text, value) { super(); this.textContent = text; this.value = value; } },
    sessionStorage,
    setTimeout: (callback, milliseconds) => { timers.set(++timerId, { callback, milliseconds }); return timerId; },
    clearTimeout: id => timers.delete(id), setInterval: callback => { intervals.push(callback); return intervals.length; },
    fetch: async (url, options) => {
      const action = new URL(url, 'http://localhost').searchParams.get('action');
      requests.push({ action, ...options });
      const body = await handler(action, options);
      return { ok: true, status: 200, json: async () => body };
    },
  });
  vm.runInContext(source + '\n;globalThis.testApp = { state, enter, lock, flush, persistLocal, mergeVault, encryptedBackup, exportBackup, clearPrivateUI, updateDocument, finishLogin, restoreSession, boot, protectNote, removeNotePin, noteLocks };', context, { filename: 'app.js' });
  await until(() => context.testApp.state.csrf !== '');
  const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const { key, wrappedKey } = await cryptoFunctions.createVaultKey(wrappingKey);
  const salt = cryptoFunctions.randomSalt();
  const vault = modelFunctions.emptyVault();
  vault.notes.push({ ...modelFunctions.makeNote(), body: 'Server contents' });
  const result = { email: 'owner@example.com', revision: 1, wrappedKey, vault: await cryptoFunctions.encryptVault(key, vault), resumeSecret: cryptoFunctions.toBase64(crypto.getRandomValues(new Uint8Array(32))) };
  const app = context.testApp;
  await app.enter(result, key, salt);
  return { ...app, durable, localStore, noteActions, elements, storage, requests, intervals, timers, key, wrappingKey, salt, result, downloads, browserWindow, document, advanceClock: ms => { clockOffset += ms; }, failStorage: () => { storageUnavailable = true; }, setHandler: next => { handler = next; }, async input(body) { app.updateDocument(plainDocument(body.slice(0,500000)), body); } };
}

async function submitPin(h, value, repeat = value) {
  h.elements.get('pin-value').value = value; h.elements.get('pin-repeat').value = repeat;
  await h.elements.get('pin-form').emit('submit');
}
test('first-login fields remain editable while bootstrap waits and early submit uses one initialization', async () => {
  const h = await harness(); h.clearPrivateUI(); h.state.csrf = '';
  const gate = deferred(); const calls = [];
  h.setHandler(async action => {
    calls.push(action);
    if (action === 'bootstrap') return gate.promise;
    if (action === 'email') return { salt: h.salt };
    throw new Error('Unexpected login request');
  });
  const starting = h.boot();
  await until(() => calls.includes('bootstrap'));
  assert.equal(h.elements.get('login-form').inert, false, 'Typing must not depend on a server response');
  h.elements.get('email').value = 'owner@example.com';
  const submitting = h.elements.get('login-form').emit('submit');
  await h.elements.get('login-form').emit('submit');
  assert.deepEqual(calls, ['bootstrap'], 'Repeated submit waits for the current initialization');
  gate.resolve({ initialized: true, csrf: 'ready-csrf' });
  await Promise.all([starting, submitting]);
  assert.deepEqual(calls, ['bootstrap', 'email']);
  assert.equal(h.state.step, 'password');
  assert.equal(h.elements.get('email').value, 'owner@example.com');
  assert.equal(h.elements.get('continue').disabled, false);
});

test('failed first bootstrap keeps typed email editable and Continue retries after reconnection', async () => {
  const h = await harness(); h.clearPrivateUI(); h.state.csrf = '';
  const gate = deferred();
  h.setHandler(async () => gate.promise);
  const starting = h.boot();
  h.elements.get('email').value = 'owner@example.com';
  assert.equal(h.elements.get('login-form').inert, false);
  gate.reject(new Error('Нет связи с сервером.'));
  await starting;
  assert.equal(h.elements.get('login-form').inert, false);
  assert.equal(h.elements.get('email').value, 'owner@example.com');
  assert.match(h.elements.get('auth-message').textContent, /Нет связи/);
  h.setHandler(async action => action === 'bootstrap' ? { initialized: true, csrf: 'retry-csrf' } : { salt: h.salt });
  await h.elements.get('login-form').emit('submit');
  assert.equal(h.state.step, 'password');
});

test('the complete app durably saves offline edits and keeps edits typed during a delayed pull',async()=>{
  const h=await harness();let offline=false,head=0,ops=[],pause=null;
  h.setHandler(async(action,options)=>{
    if(offline)throw new Error('Offline');const data=JSON.parse(options.body||'{}');
    if(action==='sync_pull'){
      if(pause)await pause.promise;
      return {baseline:data.after===0?{cursor:0,vault:h.result.vault}:null,changes:ops.filter(op=>op.seq>data.after),cursor:head,hasMore:false,received:(data.pendingIds||[]).filter(id=>ops.some(op=>op.id===id))};
    }
    if(action==='sync_push'){for(const op of data.operations)if(!ops.some(item=>item.id===op.id))ops.push({...op,seq:++head});return {accepted:data.operations.map(op=>op.id),cursor:head};}
    throw new Error('Unexpected sync request');
  });
  await h.enter({...h.result,syncProtocol:1},h.key,h.salt);await h.flush();offline=true;
  await h.input('Offline durable text');await h.persistLocal();assert.equal(h.durable.pending.length,1);
  await assert.rejects(h.flush(),/Offline/);assert.equal(h.state.vault.notes[0].body,'Offline durable text');
  offline=false;pause=deferred();const syncing=h.flush();
  await until(()=>h.requests.filter(r=>r.action==='sync_pull').length>=4);
  await h.input('Latest while pull waits');await h.persistLocal();assert.equal(h.durable.pending.length,2);
  pause.resolve();pause=null;await syncing;await h.flush();
  assert.equal(h.state.vault.notes[0].body,'Latest while pull waits');assert.equal(h.durable.pending.length,0);assert.equal(h.state.saved,h.state.generation);
});
test('0042 protects rich content, validates repeats, survives edits and F5 closed, and can be removed', async () => {
  const h = await harness(), note = h.state.vault.notes[0], proofs = new Map();
  h.setHandler(async (action, options) => {
    const body = JSON.parse(options.body || '{}');
    if (action === 'pin_register') { proofs.set(body.id, body.proof); return { ok: true }; }
    if (action === 'pin_check') {
      if (proofs.get(body.id) !== body.proof) throw Object.assign(new Error('Неверный PIN-код.'), { status: 403, code: 'pin_invalid' });
      return { ok: true };
    }
    if (action === 'vault') return { revision: body.revision + 1 };
    return { ok: true };
  });
  await h.input('Rich original');
  const setting = h.protectNote(note.id);
  await submitPin(h, '0042', '0000'); assert.match(h.elements.get('pin-message').textContent, /не совпадают/); assert.equal(note.pin, undefined);
  await submitPin(h, 'ab42'); assert.match(h.elements.get('pin-message').textContent, /четыре цифры/);
  await submitPin(h, '0042'); await setting;
  assert.equal(note.body, ''); assert.equal(Object.hasOwn(note, 'document'), false); assert.equal(h.elements.get('note-locked').hidden, false);
  const opening = h.protectNote(note.id); await submitPin(h, '0041');
  assert.equal(h.elements.get('pin-dialog').open, true); assert.equal(h.noteLocks.get(note), null);
  await submitPin(h, '0042'); await opening; assert.equal(h.elements.get('note-body').value, 'Rich original');
  await h.input('Latest protected text');
  const exported = await cryptoFunctions.decryptVault(h.key, (await h.encryptedBackup()).vault);
  assert.equal(JSON.stringify(exported).includes('Latest protected text'), false);
  await h.protectNote(note.id); assert.equal(h.elements.get('note-body').value, ''); assert.equal(h.noteLocks.get(note), null);
  const saved = JSON.parse(h.requests.findLast(r => r.action === 'vault').body).vault;
  await h.enter({ ...h.result, vault: saved }, h.key, h.salt);
  assert.ok(h.state.key); assert.equal(h.elements.get('note-locked').hidden, false, 'reloaded vault stays logged in but PIN stays closed');
  const reloaded = h.state.vault.notes[0]; const reopening = h.protectNote(reloaded.id);
  await submitPin(h, '0042'); await reopening; assert.equal(h.elements.get('note-body').value, 'Latest protected text');
  await h.input('Last edit before removing PIN');
  const removing = h.removeNotePin(reloaded.id); await submitPin(h, '0042'); await removing;
  assert.equal(reloaded.pin, undefined); assert.equal(reloaded.body, 'Last edit before removing PIN'); assert.ok(reloaded.document);
});

test('cancelled PIN verification cannot reopen a note and missing backup records register only after valid decryption', async () => {
  const h = await harness(), note = h.state.vault.notes[0];
  const setting = h.protectNote(note.id); await submitPin(h, '0042'); await setting;
  const gate = deferred(); h.setHandler(async () => gate.promise);
  const opening = h.protectNote(note.id), submit = submitPin(h, '0042');
  await until(() => h.requests.some(r => r.action === 'pin_check'));
  h.elements.get('pin-dialog').close('cancel'); gate.resolve({ ok: true }); await submit; await opening;
  assert.equal(h.noteLocks.get(note), null);
  let registered = 0;
  h.setHandler(async action => {
    if (action === 'pin_check') throw Object.assign(new Error('Missing'), { status: 404, code: 'pin_missing' });
    if (action === 'pin_register') { registered++; return { ok: true }; }
    throw new Error('Unexpected request');
  });
  const restored = h.protectNote(note.id); await submitPin(h, '9999'); assert.equal(registered, 0); assert.equal(h.noteLocks.get(note), null);
  await submitPin(h, '0042'); await restored; assert.equal(registered, 1); assert.ok(h.noteLocks.get(note));
});

test('context actions affect their target while preserving the selected note, rich content and encrypted persistence', async () => {
  const h=await harness(), selected=h.state.vault.notes[0];
  const other={...modelFunctions.makeNote(),title:'Context target',body:'Keep this text',document:plainDocument('Keep this text')};
  h.state.vault.notes.push(other); const original=JSON.stringify(other.document);
  h.noteActions.onAction('pin',other.id); assert.equal(other.pinned,true); assert.equal(selected.pinned,false);
  await h.noteActions.onAction('delete',other.id); assert.equal(typeof other.deleted,'number'); assert.equal(selected.deleted,null);
  assert.equal(h.state.vault.notes.length,2); assert.equal(JSON.stringify(other.document),original);
  h.noteActions.onAction('restore',other.id); assert.equal(other.deleted,null);
  await h.flush(); const saved=await cryptoFunctions.decryptVault(h.key,JSON.parse(h.requests.findLast(r=>r.action==='vault').body).vault);
  assert.equal(saved.notes.find(note=>note.id===other.id).pinned,true); assert.equal(saved.notes.find(note=>note.id===other.id).body,'Keep this text');
  h.state.locking=true; h.noteActions.onAction('pin',other.id); await h.noteActions.onAction('delete',other.id); assert.equal(other.pinned,true); assert.equal(other.deleted,null);
});

test('lock freezes editing immediately, serializes repeated requests, and saves the last permitted edit', async () => {
  const h = await harness();
  const logout = deferred();
  h.setHandler(async (action, options) => {
    if (action === 'vault') return { revision: JSON.parse(options.body).revision + 1 };
    if (action === 'logout') return logout.promise;
    return { initialized: true, csrf: 'after-lock' };
  });
  await h.input('Must survive logout');
  const first = h.lock();
  const second = h.lock(true);
  assert.equal(first, second, 'one lock operation owns the transition');
  assert.equal(h.elements.get('workspace').inert, true, 'browser stops user interaction before network work');
  await h.input('Late input must not mutate the vault');
  assert.equal(h.state.vault.notes[0].body, 'Must survive logout');
  await until(() => h.requests.some(request => request.action === 'logout'));
  const put = h.requests.find(request => request.action === 'vault');
  assert.equal((await cryptoFunctions.decryptVault(h.key, JSON.parse(put.body).vault)).notes[0].body, 'Must survive logout');
  assert.equal(h.requests.filter(request => request.action === 'logout').length, 1);
  logout.resolve({ ok: true });
  await first;
  assert.equal(h.state.key, null);
  assert.equal(h.state.vault, null);
  assert.equal(h.elements.get('note-body').value, '');
  assert.equal(h.elements.get('workspace').hidden, true);
  assert.equal(h.elements.get('password').required, false);
  assert.equal(h.elements.get('otp').required, false);
});

test('manual lock while offline preserves encrypted dirty notes and clears plaintext', async () => {
  const h = await harness();
  await h.input('Unsynced personal note');
  h.setHandler(async () => { throw new Error('Offline'); });
  const locking = h.lock();
  assert.equal(h.elements.get('workspace').inert, true);
  await until(() => h.state.key === null);
  await locking;
  const pending = JSON.parse(h.storage.get(pendingName));
  assert.equal((await cryptoFunctions.decryptVault(h.key, pending.vault)).notes[0].body, 'Unsynced personal note');
  assert.ok(!h.storage.get(pendingName).includes('Unsynced personal note'));
  assert.equal(h.elements.get('note-body').value, '');
});

test('automatic lock offers encrypted rescue when both network and browser storage fail', async () => {
  const h = await harness();
  await h.input('Rescue this otherwise unsaved private note');
  h.setHandler(async () => { throw new Error('Offline'); });
  h.failStorage();
  await h.lock(true);
  assert.equal(h.state.key, null);
  assert.equal(h.state.vault, null);
  assert.equal(h.elements.get('note-body').value, '');
  assert.equal(h.storage.has(pendingName), false);
  assert.equal(h.elements.get('download-rescue').hidden, false);
  let warnedBeforeDownload = false;
  await h.browserWindow.emit('beforeunload', { preventDefault() { warnedBeforeDownload = true; } });
  assert.equal(warnedBeforeDownload, true, 'tab close warns while the encrypted rescue exists only in memory');
  await h.elements.get('download-rescue').emit('click');
  assert.equal(h.downloads.length, 1);
  const text = await h.downloads[0].text();
  assert.ok(!text.includes('Rescue this otherwise unsaved private note'));
  const backup = JSON.parse(text);
  assert.equal(backup.format, 'NUTE-ENCRYPTED-BACKUP');
  assert.equal((await cryptoFunctions.decryptVault(h.key, backup.vault)).notes[0].body, 'Rescue this otherwise unsaved private note');
  assert.equal(h.elements.get('download-rescue').hidden, true);
  let warnedAfterDownload = false;
  await h.browserWindow.emit('beforeunload', { preventDefault() { warnedAfterDownload = true; } });
  assert.equal(warnedAfterDownload, false, 'download clears the in-memory rescue warning');
});

test('a completed old save cannot update the revision after the session was cleared', async () => {
  const h = await harness();
  const save = deferred();
  h.setHandler(async action => action === 'vault' ? save.promise : { initialized: true, csrf: 'new' });
  await h.input('Old session edit');
  const running = h.flush();
  await until(() => h.requests.some(request => request.action === 'vault'));
  h.clearPrivateUI();
  h.storage.clear();
  await h.enter({ ...h.result, revision: 10 }, h.key, h.salt);
  save.resolve({ revision: 2 });
  await running;
  assert.equal(h.state.revision, 10);
  assert.equal(h.state.generation, 0);
  assert.equal(h.state.saved, 0);
  assert.equal(h.state.vault.notes[0].body, 'Server contents');
});

test('oversized editor output cannot replace the previous valid note', async () => {
  const h = await harness();
  await h.input('Keep this complete note');
  await h.input('x'.repeat(500001));
  assert.equal(h.state.vault.notes[0].body, 'Keep this complete note');
  await h.lock(true);
  const put = h.requests.find(request => request.action === 'vault');
  const restored = await cryptoFunctions.decryptVault(h.key, JSON.parse(put.body).vault);
  assert.doesNotThrow(() => modelFunctions.validateVault(restored));
  assert.equal(restored.notes[0].body, 'Keep this complete note');
  assert.equal(h.elements.get('note-body').value, '');
});

test('an invalid merged backup leaves the current vault and generation unchanged', async () => {
  const h = await harness();
  for (let i = 1; i < 100; i++) h.state.vault.folders.push({ id: `folder-${i}`, name: `Folder ${i}` });
  const before = JSON.stringify(h.state.vault);
  const incoming = modelFunctions.emptyVault();
  incoming.folders.push({ id: 'one-too-many', name: 'Extra' });
  assert.throws(() => h.mergeVault(incoming), /Неподдерживаемый формат заметок/);
  assert.equal(JSON.stringify(h.state.vault), before);
  assert.equal(h.state.generation, 0);
  assert.doesNotThrow(() => h.mergeVault(modelFunctions.emptyVault()), 'identical existing folders do not count twice');
});

test('importing a permanently deleted note and folder assigns fresh identities that survive sync tombstones',async()=>{
  const h=await harness(),old=structuredClone(h.state.vault.notes[0]);old.folder='purged-folder';
  h.state.vault.notes=[];h.state.vault.sync={removedNotes:[old.id],removedFolders:['purged-folder'],recent:[]};
  h.mergeVault({version:3,folders:[{id:'notes',name:'Заметки'},{id:'purged-folder',name:'Restored folder'}],notes:[old]});
  assert.equal(h.state.vault.notes.length,1);assert.notEqual(h.state.vault.notes[0].id,old.id);assert.notEqual(h.state.vault.notes[0].folder,'purged-folder');
  assert.ok(h.state.vault.folders.some(f=>f.id===h.state.vault.notes[0].folder));
});

test('native backup cancellation is awaited and cannot report a successful protective export',async()=>{
  const gate=deferred();
  const h=await harness({request:async()=>({status:200,body:{initialized:true,csrf:'native-test'}}),saveFile:()=>gate.promise});
  let done=false;const exporting=h.exportBackup().then(result=>{done=true;return result;});
  await delay(10);assert.equal(done,false);gate.reject(new Error('Сохранение отменено'));
  assert.equal(await exporting,false);assert.equal(h.elements.get('toast').textContent,'Сохранение отменено');
});

test('a native save dialog returning ok:false also preserves the protective export failure',async()=>{
  const h=await harness({request:async()=>({status:200,body:{initialized:true,csrf:'native-test'}}),saveFile:async()=>({ok:false})});
  assert.equal(await h.exportBackup(),false);assert.equal(h.elements.get('toast').textContent,'Сохранение отменено.');
});

test('recovered pending ciphertext remains available until the merged vault is saved', async () => {
  const h = await harness();
  const recovered = modelFunctions.emptyVault();
  recovered.notes.push({ ...modelFunctions.makeNote(), body: 'Previously unsaved note' });
  const backup = { email: h.result.email, salt: h.salt, vault: await cryptoFunctions.encryptVault(h.key, recovered) };
  h.storage.set(pendingName, JSON.stringify(backup));
  const entering = h.enter(h.result, h.key, h.salt);
  await until(() => h.elements.get('dialog').open);
  h.elements.get('dialog').close('confirm');
  await entering;
  assert.ok(h.storage.has(pendingName), 'recovery cannot discard the only durable copy before the debounce fires');
  assert.equal(h.state.vault.notes.length, 2);
  await h.flush();
  assert.equal(h.storage.has(pendingName), false);
});

test('reload does not replace unsaved data when its protective export fails', async () => {
  const h = await harness();
  h.state.vault.notes[0].body = 'x'.repeat(500001);
  const reload = h.elements.get('reload-vault').emit('click');
  await until(() => h.elements.get('dialog').open);
  h.elements.get('dialog').close('confirm');
  await reload;
  assert.equal(h.requests.filter(request => request.action === 'vault').length, 0);
  assert.equal(h.state.vault.notes[0].body.length, 500001);
  assert.equal(h.elements.get('workspace').inert, false);
});

test('idle time and a day in the background keep notes open and still save changes', async () => {
  const h = await harness();
  await h.input('Keep this open');
  h.document.hidden = true;
  await h.document.emit('visibilitychange');
  h.advanceClock(24 * 60 * 60 * 1000);
  for (const interval of h.intervals) interval();
  h.document.hidden = false;
  await h.document.emit('visibilitychange');
  await h.flush();
  assert.equal(h.state.key, h.key);
  assert.equal(h.elements.get('workspace').hidden, false);
  assert.equal(h.requests.some(request => request.action === 'logout'), false);
  assert.equal(h.state.saved, h.state.generation);
});

test('page reload resumes from fresh server ciphertext and retains selected note and folder', async () => {
  const h = await harness();
  const fresh = structuredClone(h.state.vault);
  fresh.notes.push({ ...modelFunctions.makeNote(), title: 'Newest server note', body: 'Arrived from another device' });
  await h.finishLogin({ ...h.result }, h.key, h.salt, h.wrappingKey);
  h.state.folder = 'notes'; h.state.selected = fresh.notes[1].id;
  h.elements.get('workspace').classList.add('editing');
  await h.browserWindow.emit('pagehide');
  assert.equal(h.state.key, null);
  assert.ok(h.storage.has(resumeFunctions.resumeName));
  const response = { ...h.result, revision: 9, vault: await cryptoFunctions.encryptVault(h.key, fresh) };
  h.setHandler(async action => action === 'bootstrap' ? { initialized: true, csrf: 'resume-csrf' } : { ...response });
  await h.boot();
  assert.equal(h.state.revision, 9);
  assert.equal(h.state.folder, 'notes'); assert.equal(h.state.selected, fresh.notes[1].id);
  assert.equal(h.elements.get('workspace').classList.contains('editing'), true);
  assert.equal(h.elements.get('note-title').value, 'Newest server note');
  assert.equal(h.state.key.extractable, false);
  assert.equal(h.requests.filter(request => request.action === 'login' || request.action === 'email').length, 0);
  const resumeRequest = h.requests.find(request => request.action === 'resume');
  assert.equal(resumeRequest.method, 'POST'); assert.equal(resumeRequest.body, '{}');
  assert.equal(resumeRequest.headers['X-CSRF-Token'], 'resume-csrf');
  assert.ok(!h.storage.get(resumeFunctions.resumeName).includes('owner@example.com'));
});

test('manual lock clears the reload capsule before network work and prevents a later restore', async () => {
  const h = await harness();
  await h.finishLogin({ ...h.result }, h.key, h.salt, h.wrappingKey);
  const logout = deferred();
  h.setHandler(async action => action === 'logout' ? logout.promise : { initialized: true, csrf: 'after-lock' });
  const locking = h.lock();
  assert.equal(h.storage.has(resumeFunctions.resumeName), false);
  logout.resolve({ ok: true }); await locking;
  const requests = h.requests.length;
  await h.boot();
  assert.equal(h.state.key, null);
  assert.deepEqual(h.requests.slice(requests).map(request => request.action), ['bootstrap']);
});

test('an in-flight restore and an old login cannot reopen after explicit lock', async () => {
  const h = await harness();
  await h.finishLogin({ ...h.result }, h.key, h.salt, h.wrappingKey);
  const capsule = JSON.parse(h.storage.get(resumeFunctions.resumeName));
  await h.browserWindow.emit('pagehide');
  const response = deferred(), oldEpoch = h.state.epoch;
  h.setHandler(async () => response.promise);
  const restoring = h.restoreSession(capsule);
  await h.lock();
  response.resolve({ ...h.result }); await restoring;
  await h.finishLogin({ ...h.result }, h.key, h.salt, h.wrappingKey, oldEpoch);
  assert.equal(h.state.key, null); assert.equal(h.state.vault, null);
  assert.equal(h.storage.has(resumeFunctions.resumeName), false);
});

test('revoked server session falls back to login and discards its capsule', async () => {
  const h = await harness();
  await h.finishLogin({ ...h.result }, h.key, h.salt, h.wrappingKey);
  await h.browserWindow.emit('pagehide');
  h.setHandler(async action => {
    if (action === 'bootstrap') return { initialized: true, csrf: 'new-csrf' };
    const error = new Error('Expired'); error.status = 401; throw error;
  });
  await h.boot();
  assert.equal(h.state.key, null); assert.equal(h.storage.has(resumeFunctions.resumeName), false);
  assert.equal(h.elements.get('login-form').inert, false);
  assert.equal(h.elements.get('auth-message').textContent, 'Сеанс завершён. Войдите снова.');
});

test('native lock waits for durable revocation, preserves edits, and retries a failed clear without false success', async () => {
  const h = await harness();
  await h.input('Pending note must survive failed lock');
  const gate = deferred(); h.localStore.clear = () => gate.promise;
  h.setHandler(async () => { throw new Error('Offline'); });
  const locking = h.lock(false, true);
  await until(() => h.state.key === null);
  assert.doesNotMatch(h.elements.get('auth-message').textContent, /Вы вышли|Хранилище заблокировано/);
  assert.equal(h.elements.get('continue').disabled, true);
  gate.reject(new Error('ENOSPC')); await locking;
  assert.match(h.elements.get('auth-message').textContent, /Не удалось завершить блокировку/);
  assert.equal(h.elements.get('retry-lock').hidden, false);
  const backup = JSON.parse(h.storage.get(pendingName));
  assert.equal((await cryptoFunctions.decryptVault(h.key, backup.vault)).notes[0].body, 'Pending note must survive failed lock');
  const calls = h.requests.length; await h.boot(); assert.equal(h.requests.length, calls, 'failed lock cannot auto-restore');
  h.localStore.clear = async () => ({ok:true});
  await h.elements.get('retry-lock').emit('click');
  await until(() => h.elements.get('retry-lock').hidden);
  await until(() => h.requests.slice(calls).some(r => r.action === 'logout'));
  assert.equal(JSON.parse(h.requests.findLast(r => r.action === 'logout').body).forgetDevice, true, 'retry retains explicit forget-device choice');
  assert.equal(h.storage.get(pendingName), JSON.stringify(backup), 'retry retains encrypted pending backup');
});

test('native lock drains in-flight login unlock save and rejects a false clear acknowledgement', async () => {
  const native = {request:async () => ({status:200,body:{initialized:true,csrf:'native-test'}})};
  const h = await harness(native), gate = deferred(); let saving = false;
  h.localStore.save = async fields => { if (fields.unlock) { saving = true; await gate.promise; } Object.assign(h.durable, structuredClone(fields)); };
  const entering = h.finishLogin({...h.result}, h.key, h.salt, h.wrappingKey);
  await until(() => saving);
  let cleared = false;
  h.localStore.clear = async options => { assert.equal(options.credentials, false); cleared = true; h.durable.unlock = null; return {ok:true}; };
  const locking = h.lock(); await until(() => h.state.key === null);
  assert.equal(cleared, false, 'revocation waits for queued login save');
  gate.resolve(); await entering; await locking;
  assert.equal(cleared, true); assert.equal(h.durable.unlock, null);
  h.localStore.clear = async () => ({ok:false}); await h.lock();
  assert.match(h.elements.get('auth-message').textContent, /Не удалось завершить блокировку/);
  assert.equal(h.elements.get('retry-lock').hidden, false);
});

test('native lock never discards the last edit when durable outbox and export both fail', async () => {
  const native = {request:async () => ({status:200,body:{initialized:true,csrf:'native-test'}}),saveFile:async () => ({ok:false})};
  const h = await harness(native);
  await h.enter({...h.result,syncProtocol:1},h.key,h.salt);
  h.localStore.enqueue = async () => { throw new Error('Disk full'); };
  let cleared = false; h.localStore.clear = async () => { cleared = true; return {ok:true}; };
  await h.input('The only copy is still in memory');
  await assert.rejects(h.persistLocal(), /Disk full/);
  await h.lock();
  assert.equal(cleared, false); assert.equal(h.state.key, h.key);
  assert.equal(h.state.vault.notes[0].body, 'The only copy is still in memory');
  assert.equal(h.elements.get('workspace').hidden, false);
  assert.equal(h.elements.get('workspace').inert, false);
  let warned = false; await h.browserWindow.emit('beforeunload', {preventDefault(){warned=true;}});
  assert.equal(warned, true);
});
