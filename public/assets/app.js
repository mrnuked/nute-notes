import { deriveKeys, randomSalt, createVaultKey, unwrapVaultKey, encryptVault, decryptVault, randomTotpSecret } from './crypto.js?v=0.4.3';
import { emptyVault, validateVault, visibleNotes, noteTitle, makeNote } from './model.js?v=0.4.3';
import { renameFolder, removeFolder } from './folders.js?v=0.4.3';
import { createNoteEditor } from './editor.js?v=0.4.3';
import { createNoteMenu } from './note-menu.js?v=0.4.3';
import { preparePin, derivePin, sealPinContent, openPinContent } from './note-pin.js?v=0.4.3';
import { createNoteLocks } from './note-locks.js?v=0.4.3';
import { createResumeCapsule, openResumeCapsule, readResume, writeResume, clearResume } from './session-resume.js?v=0.4.3';
import QRCode from './qr.js';
import { localStore, nativePlatform } from './platform.js?v=0.4.3';
import { createSyncEngine } from './sync-engine.js?v=0.4.3';
import { changesBetween, canonical } from './sync-model.js?v=0.4.3';

const $ = id => document.getElementById(id);
const state = { csrf: '', step: 'email', salt: '', email: '', key: null, wrappedKey: null, vault: null, revision: 0, folder: 'all', selected: null, generation: 0, saved: 0, saving: null, conflict: false, epoch: 0, locking: false };
let saveTimer, toastTimer, setupSecret = '', lockPromise = null, rescueCopy = null, trustedDevice = false;
let pinRequest = null, pinClosing = false;
let bootPromise = null, loginSubmitting = false;
let unlockSaving = Promise.resolve(), lockIncomplete = false;
let logoutPending = false, forgetPending = false;
const noteLocks = createNoteLocks();
let syncSupported = false, syncEngine = null, syncBase = null, localSaving = null, localSaved = 0;
const formatNames = ['bold','italic','underline','strike','title','heading','subheading','paragraph','mono','bullet','dash','ordered'];
const tableNames = ['row-before','row-after','column-before','column-after','delete-row','delete-column','delete-table'];
const richEditor = createNoteEditor($('note-body'), { onChange: updateDocument, onError: toast, onState: active => {
  for (const name of formatNames) $('format-' + name).setAttribute('aria-pressed', String(!!active[name]));
  $('checklist').setAttribute('aria-pressed', String(!!active.checklist));
  for (const name of tableNames) $('table-' + name).disabled = !active.table;
} });
const pendingName = 'nute:encrypted-pending:v1';
const noteMenu = createNoteMenu($('note-menu'), {
  getNote: id => !state.locking && state.key ? state.vault?.notes.find(note => note.id === id) : null,
  isUnlocked: note => !!noteLocks.get(note),
  beforeOpen: () => { closeEditorMenus(); $('account-menu').hidden = true; },
  onAction: (action, id) => action === 'pin' ? togglePinned(id) : action === 'restore' ? restoreNote(id) : action === 'protect' ? protectNote(id) : action === 'unprotect' ? removeNotePin(id) : deleteNote(id),
});
const shortDate = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
const longDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const icon = name => { const element = document.createElement('i'); element.className = `ph ph-${name}`; element.setAttribute('aria-hidden', 'true'); return element; };
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
async function api(action, data, method = 'POST') {
  const native = nativePlatform();
  const response = native ? await native.request({action, method, data:data || {}}) : await fetch(`api.php?action=${action}`, { method, credentials: 'same-origin', cache: 'no-store', headers: { 'X-Nute-Client': '0.4', ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(data || {}) } : {}), signal: AbortSignal.timeout(20000) });
  let result;
  try { result = native ? response.body : await response.json(); } catch { throw new Error('Сервер недоступен. Попробуйте ещё раз.'); }
  if (result.syncProtocol === 1) syncSupported = true;
  if (result.csrf) state.csrf = result.csrf;
  if (typeof result.trustedDevice === 'boolean') trustedDevice = result.trustedDevice;
  if (native ? response.status < 200 || response.status >= 300 : !response.ok) { const error = new Error(result.message || 'Запрос не выполнен.'); error.status = response.status; error.code = result.error; throw error; }
  return result;
}
function ask(title, description, options = {}) {
  return new Promise(resolve => {
    $('dialog-title').textContent = title; $('dialog-description').textContent = description;
    const field = $('dialog-input'); field.hidden = !options.input; field.value = options.value || ''; field.type = options.password ? 'password' : 'text'; field.maxLength = options.password ? 1024 : 120;
    field.setAttribute('aria-label', title); $('dialog-extra').replaceChildren();
    $('dialog-confirm').textContent = options.confirm || 'Продолжить'; $('dialog-cancel').hidden = !!options.noCancel;
    if (options.extra) $('dialog-extra').append(options.extra);
    $('dialog').returnValue = ''; $('dialog').showModal();
    $('dialog').addEventListener('close', () => { const value = $('dialog').returnValue === 'confirm' ? (options.input ? field.value : true) : null; field.value = ''; $('dialog-extra').replaceChildren(); resolve(value); }, { once: true });
    if (options.input) field.focus();
  });
}
function download(data, filename) {
  if (nativePlatform()?.saveFile) return nativePlatform().saveFile({name:filename, data:JSON.stringify(data,null,2)}).then(result => { if (result?.ok !== true) throw new Error('Сохранение отменено.'); return result; });
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function encryptedBackup() {
  if (!state.key || !state.vault) throw new Error('Сначала откройте хранилище.');
  validateVault(state.vault, {recovery:true});
  const { key, salt, wrappedKey } = state;
  const snapshot = validateVault(await noteLocks.snapshot(state.vault), {recovery:true});
  return { format: 'NUTE-ENCRYPTED-BACKUP', version: 1, kdf: { name: 'PBKDF2-SHA256', iterations: 600000 }, salt, wrappedKey, vault: await encryptVault(key, snapshot), created: new Date().toISOString() };
}
async function exportBackup() {
  try { await download(await encryptedBackup(), `NUTE-${new Date().toISOString().replaceAll(':', '-')}.json`); toast('Зашифрованная копия скачана'); return true; } catch (error) { toast(error.message); return false; }
}
function rememberPending(backup, generation) {
  try { sessionStorage.setItem(pendingName, JSON.stringify({ ...backup, email: state.email, generation })); return true; } catch { return false; }
}
async function enter(result, key, salt, epoch = state.epoch, view = {}) {
  let vault = validateVault(await decryptVault(key, result.vault), {recovery:true});
  if (epoch !== state.epoch || state.locking) return;
  let engine = null;
  if (syncSupported || result.syncProtocol === 1) {
    engine = createSyncEngine({key, account:{email:result.email,salt,wrappedKey:result.wrappedKey,syncProtocol:1},store:localStore,request:api});
    vault = await engine.initialize(vault);
    if (epoch !== state.epoch || state.locking) { engine.close(); return; }
  }
  syncEngine?.close(); syncEngine = engine; syncBase = structuredClone(vault); localSaved = 0; localSaving = null;
  noteLocks.clear();
  const folder = ['all','trash',...vault.folders.map(item => item.id)].includes(view.folder) ? view.folder : 'all';
  Object.assign(state, { key, salt, wrappedKey: result.wrappedKey, vault, revision: result.revision, email: result.email, folder, selected: typeof view.selected === 'string' ? view.selected : null, generation: 0, saved: 0, conflict: false, epoch: state.epoch + 1, locking: false });
  if (view.editing === true) $('workspace').classList.add('editing');
  $('workspace').inert = false;
  $('password').value = ''; $('otp').value = ''; $('setup-form').reset(); $('setup-token').value = ''; $('totp-secret').textContent = ''; setupSecret = '';
  $('totp-qr').getContext('2d').clearRect(0,0,$('totp-qr').width,$('totp-qr').height);
  $('login').hidden = true; $('setup').hidden = true; $('workspace').hidden = false; $('account-email').textContent = result.email;
  $('sync-error').hidden = true; status('Сохранено'); render();
  let pending;
  try { pending = JSON.parse(sessionStorage.getItem(pendingName) || 'null'); } catch { sessionStorage.removeItem(pendingName); }
  if (pending && pending.email === state.email && pending.salt === state.salt) {
    try {
      const recovered = validateVault(await decryptVault(key, pending.vault), {recovery:true});
      if (JSON.stringify(recovered) === JSON.stringify(vault)) sessionStorage.removeItem(pendingName);
      else if (await ask('Есть несохранённая копия', 'В этой вкладке остались изменения после прерванного соединения. Добавить их как отдельные заметки, сохранив серверную версию?', { confirm: 'Добавить' })) mergeVault(recovered);
    } catch { toast('Локальную копию не удалось прочитать. Серверная версия доступна.'); }
  }
  if (syncEngine) flush().catch(() => {});
}
function status(message) { $('save-status').textContent = message; }
function selectedNote() { return state.vault?.notes.find(note => note.id === state.selected); }
function requestNotePin(mode, note, run) {
  if (pinRequest || state.locking) return Promise.resolve(false);
  return new Promise(resolve => {
    const request = { mode, note, run, resolve, epoch: state.epoch, pin: note.pin, busy: false };
    pinRequest = request;
    $('pin-title').textContent = mode === 'set' ? 'Установить PIN-код' : mode === 'remove' ? 'Снять PIN-код' : 'Открыть заметку';
    $('pin-description').textContent = mode === 'set' ? 'Придумайте код из четырёх цифр. Название заметки останется видно. Запомните код: восстановить его нельзя.' : mode === 'remove' ? 'Введите текущий PIN-код. После этого заметка будет открываться без него.' : 'Введите четыре цифры, которыми защищена эта заметка.';
    $('pin-repeat-wrap').hidden = mode !== 'set'; $('pin-repeat').required = mode === 'set';
    $('pin-value').value = ''; $('pin-repeat').value = ''; $('pin-message').textContent = ''; $('pin-submit').disabled = false;
    $('pin-submit').textContent = mode === 'set' ? 'Установить' : mode === 'remove' ? 'Снять защиту' : 'Открыть';
    $('pin-dialog').showModal(); $('pin-value').focus();
  });
}
function activePinRequest(request) {
  return pinRequest === request && state.epoch === request.epoch && !state.locking && state.vault?.notes.includes(request.note) && request.note.pin === request.pin;
}
$('pin-cancel').addEventListener('click', () => $('pin-dialog').close('cancel'));
$('pin-dialog').addEventListener('close', () => {
  const request = pinRequest; pinRequest = null;
  $('pin-value').value = ''; $('pin-repeat').value = ''; $('pin-message').textContent = '';
  request?.resolve($('pin-dialog').returnValue === 'confirm');
});
$('pin-form').addEventListener('submit', async event => {
  event.preventDefault(); const request = pinRequest;
  if (!request || request.busy || !activePinRequest(request)) return;
  const pin = $('pin-value').value;
  if (!/^[0-9]{4}$/.test(pin)) { $('pin-message').textContent = 'Введите ровно четыре цифры.'; return; }
  if (request.mode === 'set' && pin !== $('pin-repeat').value) { $('pin-message').textContent = 'PIN-коды не совпадают.'; return; }
  request.busy = true; $('pin-submit').disabled = true; $('pin-message').textContent = '';
  $('pin-value').value = ''; $('pin-repeat').value = '';
  try {
    await request.run(pin, () => activePinRequest(request));
    if (pinRequest === request && request.epoch === state.epoch && !state.locking) $('pin-dialog').close('confirm');
  } catch (error) {
    if (activePinRequest(request)) { $('pin-message').textContent = error.name === 'OperationError' ? 'Неверный PIN-код или повреждённая заметка.' : error.message; $('pin-value').focus(); }
  } finally { if (pinRequest === request) { request.busy = false; $('pin-submit').disabled = false; } }
});
async function verifyNotePin(note, pin, active) {
  const protectedData = note.pin;
  const { key, authProof } = await derivePin(pin, protectedData.salt);
  if (!active()) return null;
  let missing = false;
  try { await api('pin_check', { id: protectedData.id, proof: authProof }); }
  catch (error) { if (error.status === 404 && error.code === 'pin_missing') missing = true; else throw error; }
  if (!active()) return null;
  const content = await openPinContent(key, protectedData);
  if (!active()) return null;
  // A restored backup can lack a server record. Register only after authenticated decryption.
  if (missing) { await api('pin_register', { id: protectedData.id, proof: authProof }); if (!active()) return null; }
  return { key, content };
}
async function saveProtection(message) {
  changed(); render();
  try { await flush(); toast(message); } catch { toast('Изменение сохранено в этой вкладке. Подключитесь к серверу для синхронизации.'); }
}
function protectNote(id) {
  const note = state.vault?.notes.find(item => item.id === id);
  if (!note || state.locking || pinClosing || (note.deleted !== null && !note.pin)) return Promise.resolve();
  if (note.pin && noteLocks.get(note)) return closeProtectedNote(note);
  if (note.pin) return requestNotePin('open', note, async (pin, active) => {
    const opened = await verifyNotePin(note, pin, active); if (!opened || !active()) return;
    noteLocks.open(note, opened.key, opened.content); state.selected = note.id; $('workspace').classList.add('editing'); renderList(); renderEditor();
  });
  return requestNotePin('set', note, async (pin, active) => {
    const prepared = await preparePin(pin); if (!active()) return;
    const content = structuredClone({ body: note.body, ...(note.document ? { document: note.document } : {}) });
    const data = await sealPinContent(prepared.key, prepared.id, content); if (!active()) return;
    await api('pin_register', { id: prepared.id, proof: prepared.authProof }); if (!active()) return;
    note.pin = structuredClone({ v: 1, id: prepared.id, salt: prepared.salt, data }); note.body = ''; delete note.document;
    note.updated = Date.now(); state.vault.version = 3;
    await saveProtection('PIN-код установлен');
  });
}
async function closeProtectedNote(note) {
  const epoch = state.epoch; pinClosing = true; $('editor-panel').inert = true;
  try {
    await noteLocks.close(note);
    if (epoch !== state.epoch || state.locking) return;
    renderList(); renderEditor(); await flush();
  } catch (error) { if (epoch === state.epoch) toast(error.message); }
  finally { pinClosing = false; $('editor-panel').inert = false; }
}
function removeNotePin(id) {
  const note = state.vault?.notes.find(item => item.id === id);
  if (!note?.pin || state.locking || note.deleted !== null) return Promise.resolve();
  return requestNotePin('remove', note, async (pin, active) => {
    const opened = await verifyNotePin(note, pin, active); if (!opened || !active()) return;
    const content = structuredClone(noteLocks.get(note)?.content || opened.content);
    noteLocks.forget(note); delete note.pin; note.body = content.body;
    if (content.document) note.document = content.document; else delete note.document;
    note.updated = Date.now(); state.vault.version = 3; await saveProtection('PIN-код снят');
  });
}
$('protect-note').addEventListener('click', () => protectNote(state.selected));
$('unlock-note').addEventListener('click', () => protectNote(state.selected));
function folderName(id) { return state.vault.folders.find(folder => folder.id === id)?.name || 'Заметки'; }
function renderFolders() {
  const options = [{ id: 'all', name: 'Все NUTE' }, ...state.vault.folders, { id: 'trash', name: 'Недавно удалённые' }];
  $('folders').replaceChildren(); $('folder-select').replaceChildren(); $('move-folder').replaceChildren();
  for (const folder of options) {
    const button = document.createElement('button'); button.className = `folder-button${folder.id === state.folder ? ' selected' : ''}${folder.id === 'trash' ? ' trash' : ''}`;
    button.append(icon(folder.id === 'trash' ? 'trash' : 'folder'));
    const name = document.createElement('span'); name.className = 'folder-name'; name.textContent = folder.name; button.append(name);
    const count = visibleNotes(state.vault, folder.id).length;
    if (count) { const label = document.createElement('span'); label.className = 'folder-count'; label.textContent = count; button.append(label); }
    button.setAttribute('aria-pressed', String(folder.id === state.folder)); button.addEventListener('click', () => selectFolder(folder.id));
    if (!['all','notes','trash'].includes(folder.id)) {
      const row = document.createElement('div'); row.className = 'folder-row'; row.append(button);
      const menu = document.createElement('button'); menu.className = 'folder-more icon-button'; menu.setAttribute('aria-label', `Изменить папку ${folder.name}`); menu.append(icon('dots-three')); menu.addEventListener('click', () => manageFolder(folder.id)); row.append(menu); $('folders').append(row);
    } else $('folders').append(button);
    const option = new Option(folder.name, folder.id); $('folder-select').append(option);
    if (!['all','trash'].includes(folder.id)) $('move-folder').append(new Option(folder.name, folder.id));
  }
  $('folder-select').value = state.folder;
  $('mobile-folder-menu').disabled = ['all','notes','trash'].includes(state.folder);
}
function renderList() {
  noteMenu.close();
  const notes = visibleNotes(state.vault, state.folder, $('search').value); const list = $('notes-list'); list.replaceChildren();
  let previousSection = null;
  for (const note of notes) {
    const section = state.folder === 'trash' ? 'Удалённые' : note.pinned ? 'Прикреплено' : 'Заметки';
    if (section !== previousSection) { const label = document.createElement('div'); label.className = 'section-label'; if (note.pinned) label.append(icon('push-pin')); label.append(document.createTextNode(section)); list.append(label); previousSection = section; }
    const card = document.createElement('button'); card.className = `note-card${note.id === state.selected ? ' selected' : ''}`; card.setAttribute('aria-pressed', String(note.id === state.selected));
    const title = document.createElement('h3'); if (note.pin) { const symbol = icon(noteLocks.get(note) ? 'lock-key-open' : 'lock-key'); symbol.classList.add('note-lock-symbol'); title.append(symbol); } title.append(document.createTextNode(noteTitle(note))); card.append(title);
    if (note.pinned) { const pin = icon('push-pin'); pin.classList.add('note-pin'); card.append(pin); }
    const preview = document.createElement('div'); preview.className = 'note-preview'; const date = document.createElement('time'); date.textContent = shortDate.format(note.updated); preview.append(date, document.createTextNode(note.pin ? (noteLocks.get(note) ? 'Открыта по PIN-коду' : 'Установлена защита') : note.body.replace(/\s+/g, ' ').slice(0,90) || 'Нет дополнительного текста')); card.append(preview);
    const folder = document.createElement('div'); folder.className = 'note-folder'; folder.append(icon('folder'), document.createTextNode(folderName(note.folder))); card.append(folder);
    noteMenu.bind(card, note.id);
    card.addEventListener('click', () => { state.selected = note.id; $('workspace').classList.add('editing'); renderList(); renderEditor(); }); list.append(card);
  }
  if (!notes.length) { const empty = document.createElement('p'); empty.className = 'list-empty'; empty.textContent = $('search').value ? 'Ничего не найдено' : state.folder === 'trash' ? 'Корзина пуста' : 'Пока нет заметок'; list.append(empty); }
  $('notes-count').textContent = `Заметок: ${notes.length}`;
}
function renderEditor() {
  const note = selectedNote(), opened = noteLocks.get(note), closed = !!note?.pin && !opened;
  $('editor-empty').hidden = !!note; $('editor').hidden = !note || closed; $('note-locked').hidden = !closed;
  closeEditorMenus();
  for (const id of ['delete-note','pin-note','checklist','move-folder','format-button','table-button','protect-note']) $(id).disabled = !note;
  $('restore-note').hidden = !note || note.deleted === null;
  if (!note) { $('note-title').value = ''; richEditor.clear(); return; }
  const protectionLabel = !note.pin ? 'Установить PIN-код' : opened ? 'Закрыть заметку' : 'Открыть заметку';
  $('protect-note').title = protectionLabel; $('protect-note').setAttribute('aria-label', protectionLabel); $('protect-note').disabled = note.deleted !== null && !note.pin;
  $('note-title').value = closed ? '' : note.title;
  if (closed) richEditor.clear(); else richEditor.setNote(opened ? { ...note, ...opened.content } : note);
  $('note-date').textContent = longDate.format(note.updated);
  $('note-title').readOnly = note.deleted !== null;
  for (const id of ['pin-note','checklist','move-folder','format-button','table-button']) $(id).disabled = note.deleted !== null;
  for (const id of ['checklist','format-button','table-button']) $(id).disabled = closed || note.deleted !== null;
  $('pin-note').setAttribute('aria-pressed', String(note.pinned)); $('pin-note').title = note.pinned ? 'Открепить' : 'Закрепить'; $('move-folder').value = note.folder;
  $('delete-note').title = note.deleted !== null ? 'Удалить навсегда' : 'Переместить в корзину'; $('delete-note').setAttribute('aria-label', $('delete-note').title);
}
function render() {
  if (!state.vault) return;
  const notes = visibleNotes(state.vault, state.folder, $('search').value);
  if (!notes.some(note => note.id === state.selected)) state.selected = notes[0]?.id || null;
  renderFolders(); renderList(); renderEditor();
}
function selectFolder(folder) { state.folder = folder; state.selected = null; $('workspace').classList.remove('editing'); render(); }
function changed() {
  state.generation++; status('Сохранение…'); clearTimeout(saveTimer); saveTimer = setTimeout(() => flush().catch(() => {}), 650);
  if (syncEngine) persistLocal().catch(error => { status('Не сохранено на устройстве'); $('sync-error').hidden=false; $('sync-message').textContent=error.message; });
}
async function persistLocal() {
  const epoch = state.epoch, engine = syncEngine;
  if (!engine || !state.key) return;
  if (localSaving) { await localSaving; if (epoch === state.epoch && localSaved !== state.generation) return persistLocal(); return; }
  const running = (async () => {
    while (epoch === state.epoch && state.key && localSaved !== state.generation) {
      const generation = state.generation, snapshot = await noteLocks.snapshot(state.vault);
      const changes = await changesBetween(syncBase, snapshot);
      if (epoch !== state.epoch) return;
      await engine.stage(changes); if (epoch !== state.epoch) return;
      syncBase = snapshot; localSaved = generation;
      status(engine.pendingCount ? 'На устройстве · синхронизация…' : 'Сохранено');
    }
  })(); localSaving = running;
  try { await running; } finally { if (localSaving === running) localSaving = null; }
}
async function flushSync() {
  const epoch = state.epoch, engine = syncEngine;
  if (state.saving) { await state.saving; if (epoch === state.epoch && (localSaved !== state.generation || engine.pendingCount)) return flushSync(); return; }
  const running = (async () => {
    await persistLocal(); if (epoch !== state.epoch) return;
    await engine.synchronize(); if (epoch !== state.epoch) return;
    // Edits made while a pull was in flight must enter the durable queue before replacing the UI replica.
    let generation, merged;
    do { await persistLocal(); generation=state.generation; merged=await engine.view(); if(epoch!==state.epoch)return; } while(generation!==state.generation);
    const different = canonical(state.vault) !== canonical(merged);
    noteLocks.reconcile(merged); state.vault=merged; syncBase=structuredClone(merged);
    if (!engine.pendingCount) state.saved=state.generation;
    $('sync-error').hidden=true; state.conflict=false;
    status(engine.pendingCount ? 'На устройстве · ожидает отправки' : 'Синхронизировано');
    if (different) render();
  })(); state.saving=running;
  try { await running; }
  catch(error) {
    if(epoch===state.epoch){const durable=localSaved===state.generation;status(durable ? 'На устройстве · нет синхронизации' : 'Не сохранено');$('sync-error').hidden=false;$('retry-save').hidden=false;$('sync-message').textContent=!durable?`Последние правки ещё не записаны на устройство. Не закрывайте приложение; скачайте резервную копию. ${error.message}`:error.status===401?'Сеанс истёк. Изменения сохранены на устройстве; войдите снова для отправки.':`Изменения остаются на устройстве. Повторим синхронизацию автоматически. ${error.message}`;}
    throw error;
  } finally { if(state.saving===running)state.saving=null; }
}
function updateDocument(document, body) {
  const note = selectedNote(); if (!note || note.deleted !== null || state.locking || pinClosing || (note.pin && !noteLocks.get(note))) return;
  if (body.length > 500000) return toast('Текст заметки не должен превышать 500 000 символов.');
  if (note.pin) noteLocks.update(note, { document, body }); else { note.document = document; note.body = body; }
  state.vault.version = 3; note.updated = Date.now(); changed(); renderList();
}
function closeEditorMenus() {
  $('format-menu').hidden = true; $('table-menu').hidden = true;
  $('format-button').setAttribute('aria-expanded', 'false'); $('table-button').setAttribute('aria-expanded', 'false');
}
function updateTrustUI() {
  $('otp').hidden = trustedDevice; $('otp').required = !trustedDevice && state.step === 'password';
  $('trusted-notice').hidden = !trustedDevice; $('remember-label').hidden = trustedDevice;
}
function manageFolder(id) {
  if (!state.vault || state.locking || id === 'notes') return;
  const folder = state.vault.folders.find(item => item.id === id); if (!folder) return;
  const epoch = state.epoch, dialog = $('folder-dialog'); $('folder-name-input').value = folder.name; dialog.returnValue = ''; dialog.showModal(); $('folder-name-input').focus();
  dialog.addEventListener('close', async () => {
    const action = dialog.returnValue, name = $('folder-name-input').value; $('folder-name-input').value = '';
    if (!state.vault || state.epoch !== epoch || state.locking) return;
    try {
      if (action === 'rename') renameFolder(state.vault, id, name);
      else if (action === 'delete') {
        if (!await ask('Удалить папку?', 'Все её заметки будут перенесены в основную папку «Заметки». Содержимое заметок сохранится.', { confirm: 'Удалить папку' })) return;
        if (!state.vault || state.epoch !== epoch || state.locking) return;
        removeFolder(state.vault, id); if (state.folder === id) state.folder = 'notes';
      } else return;
      state.vault.version = 3; changed(); render();
    } catch (error) { toast(error.message); }
  }, { once: true });
}
async function flush() {
  clearTimeout(saveTimer);
  if (syncEngine) return flushSync();
  const epoch = state.epoch;
  if (state.saving) { await state.saving; if (epoch !== state.epoch) return; if (state.generation !== state.saved) return flush(); return; }
  if (!state.key || state.generation === state.saved) return;
  if (state.conflict) throw new Error('Конфликт версий. Скачайте свою копию или загрузите серверную.');
  const running = (async () => {
    while (state.key && epoch === state.epoch && state.generation !== state.saved) {
      const generation = state.generation;
      const encrypted = await encryptedBackup();
      if (epoch !== state.epoch) return;
      if (encrypted.vault.ciphertext.length > 2800000) throw new Error('Хранилище превышает 2 МБ. Скачайте копию и уменьшите объём заметок.');
      rememberPending(encrypted, generation);
      const result = await api('vault', { revision: state.revision, vault: encrypted.vault }, 'PUT');
      if (epoch !== state.epoch) return;
      state.revision = result.revision; state.saved = generation;
      if (state.saved === state.generation) sessionStorage.removeItem(pendingName);
    }
    if (epoch === state.epoch) { $('sync-error').hidden = true; status('Сохранено'); }
  })();
  state.saving = running;
  try { await running; }
  catch (error) { if (epoch === state.epoch) { state.conflict = error.status === 409 || error.status === 426; status('Не сохранено'); $('sync-error').hidden = false; $('sync-message').textContent = error.status === 409 ? 'Эти заметки изменены на другом устройстве. Ваша версия сохранена в этой вкладке. Скачайте копию перед загрузкой серверной версии.' : `Изменения ещё не на сервере. ${error.message}`; $('retry-save').hidden = state.conflict; } throw error; }
  finally { if (state.saving === running) state.saving = null; }
}
function clearPrivateUI(preserveSession = false) {
  if (!preserveSession) clearResume();
  syncEngine?.close(); syncEngine=null; syncBase=null; localSaving=null; localSaved=0;
  noteLocks.clear(); $('pin-dialog').close('cancel'); $('pin-value').value = ''; $('pin-repeat').value = ''; $('note-locked').hidden = true;
  state.epoch++; state.locking = false; $('workspace').inert = false;
  state.key = null; state.vault = null; state.wrappedKey = null; state.selected = null; state.email = ''; state.salt = ''; state.step = 'email'; state.generation = 0; state.saved = 0; state.conflict = false;
  richEditor.clear(); closeEditorMenus(); noteMenu.close(); $('folder-dialog').close('cancel'); $('folder-name-input').value = '';
  $('notes-list').replaceChildren(); $('folders').replaceChildren(); $('move-folder').replaceChildren(); $('folder-select').replaceChildren(); $('note-title').value = ''; $('search').value = ''; $('account-email').textContent = ''; $('chosen-email').textContent = ''; $('note-date').textContent = ''; $('account-menu').hidden = true;
  $('workspace').hidden = true; $('workspace').classList.remove('editing'); $('login').hidden = false; $('password-step').hidden = true; $('email-step').hidden = false; $('email').value = ''; $('password').value = ''; $('otp').value = ''; $('password').required = false; $('otp').required = false; $('auth-message').textContent = '';
  $('dialog').close('cancel'); $('dialog-extra').replaceChildren(); clearTimeout(saveTimer);
}
function lock(automatic = false, forgetDevice = false) {
  if (lockPromise) return lockPromise;
  const hadKey = !!state.key;
  logoutPending ||= hadKey; forgetPending ||= forgetDevice;
  const epoch = state.epoch;
  clearResume();
  state.locking = true; noteMenu.close(); $('workspace').inert = true; $('dialog').close('cancel'); $('pin-dialog').close('cancel');
  lockPromise = (async () => {
    let preserved = true;
    try { if (hadKey) await flush(); } catch {
      if (epoch !== state.epoch) return;
      // sessionStorage is not a durable native outbox. If the last edits could
      // not reach disk, keep the open copy until storage recovers or the owner
      // saves an explicit encrypted export. Never silently clear those edits.
      if (nativePlatform() && state.generation !== (syncEngine ? localSaved : state.saved)) {
        await exportBackup();
        toast('Блокировка не завершена: последние правки ещё не сохранены на устройстве. Сохраните резервную копию или повторите после восстановления записи.');
        return;
      }
      const backup = await encryptedBackup();
      preserved = rememberPending(backup, state.generation);
      if (!preserved && automatic) rescueCopy = backup;
      if (!preserved && !automatic) { await exportBackup(); toast('Сохраните скачанную копию перед выходом'); return; }
    }
    if (epoch !== state.epoch) return;
    // Drain a pending login save before revoking, so it cannot resurrect unlock.
    // The native clear keeps encrypted cache, pending operations and trust cookies.
    lockIncomplete = true;
    const revocation = (async () => {
      await unlockSaving.catch(() => {});
      const cleared = await localStore.clear({credentials:false});
      if (cleared?.ok !== true) throw new Error('Устройство не подтвердило блокировку.');
      if (nativePlatform() && (await localStore.load()).unlock) throw new Error('Сохранённый доступ ещё не удалён.');
    })();
    clearPrivateUI();
    $('continue').disabled = true;
    $('auth-message').textContent = 'Завершаем блокировку на устройстве…';
    try { await revocation; }
    catch {
      $('auth-message').textContent = 'Не удалось завершить блокировку на устройстве. Заметки и несинхронизированные правки сохранены. Повторите блокировку; пока не передавайте устройство другим людям.';
      $('retry-lock').hidden = false;
      return;
    }
    lockIncomplete = false; $('retry-lock').hidden = true; $('continue').disabled = false;
    let forgetFailed = false;
    const sendLogout = logoutPending || forgetPending;
    try { if (sendLogout) await api('logout', { forgetDevice: forgetPending }); } catch { forgetFailed = forgetPending; /* Local unlock has already been durably revoked. */ }
    logoutPending = false; forgetPending = false;
    $('auth-message').textContent = automatic ? 'Хранилище заблокировано.' : 'Вы вышли из хранилища.';
    if (forgetFailed) $('auth-message').textContent += ' Не удалось отозвать доверие устройству: нет связи с сервером. Повторите отзыв после подключения.';
    if (!preserved) { $('auth-message').textContent += ' Скачайте несохранённую зашифрованную копию перед закрытием вкладки.'; $('download-rescue').hidden = false; }
    try { if (sendLogout) { const result = await api('bootstrap', null, 'GET'); state.csrf = result.csrf; } } catch { /* Next submit retries bootstrap. */ }
  })().finally(() => { lockPromise = null; state.locking = false; $('workspace').inert = false; });
  return lockPromise;
}
function newNote() {
  if (!state.vault || state.locking) return;
  if (state.vault.notes.length >= 5000) return toast('Можно хранить не более 5000 заметок');
  const note = makeNote(['all','trash'].includes(state.folder) ? 'notes' : state.folder); state.vault.notes.push(note); state.folder = note.folder; state.selected = note.id; $('search').value = ''; changed(); render(); $('workspace').classList.add('editing'); $('note-title').focus();
}
function mergeVault(incoming) {
  if (!state.vault || state.locking) return;
  const merged = structuredClone(state.vault);
  merged.version = 3;
  const removedNotes = new Set(merged.sync?.removedNotes || []), removedFolders = new Set(merged.sync?.removedFolders || []), folderIds = new Map();
  for (const folder of incoming.folders) {
    const id = removedFolders.has(folder.id) ? crypto.randomUUID() : folder.id;
    folderIds.set(folder.id,id);
    if (!merged.folders.some(f => f.id === id)) merged.folders.push({...folder,id});
  }
  for (const original of incoming.notes) {
    const note = {...original,folder:folderIds.get(original.folder) || 'notes'};
    const current = merged.notes.find(n => n.id === note.id);
    if (current && JSON.stringify(current) === JSON.stringify(note)) continue;
    merged.notes.push(current || removedNotes.has(note.id) ? { ...note, id: crypto.randomUUID(), title: `${note.title.slice(0,280)} (из копии)` } : note);
  }
  validateVault(merged); state.vault = merged; changed(); render();
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (loginSubmitting || lockPromise || lockIncomplete) return;
  loginSubmitting = true; $('continue').disabled = true; $('auth-message').textContent = '';
  const epoch = state.epoch;
  try {
    // Let the user type immediately, but serialize authentication with startup.
    if (bootPromise) { $('auth-message').textContent = 'Подключаемся к серверу…'; await bootPromise; }
    if (epoch !== state.epoch || state.key) return;
    if (!state.csrf) { const result = await api('bootstrap', null, 'GET'); state.csrf = result.csrf; }
    if (epoch !== state.epoch) return;
    $('auth-message').textContent = '';
    if (state.step === 'email') {
      const email = $('email').value.trim().toLowerCase(); const result = await api('email', { email });
      if (epoch !== state.epoch) return;
      state.email = email; state.salt = result.salt; state.step = 'password';
      $('chosen-email').textContent = email; $('email-step').hidden = true; $('password-step').hidden = false; $('password').required = true; updateTrustUI(); $('password').focus();
    } else {
      const { authProof, wrappingKey } = await deriveKeys($('password').value, state.salt);
      const result = await api('login', { email: state.email, authProof, otp: $('otp').value.trim(), rememberDevice: !trustedDevice && $('remember-device').checked });
      const key = await unwrapVaultKey(wrappingKey, result.wrappedKey); await finishLogin(result, key, state.salt, wrappingKey, epoch);
    }
  } catch (error) { if (trustedDevice && state.step === 'password' && error.status === 401) { trustedDevice = false; updateTrustUI(); } $('auth-message').textContent = error.name === 'OperationError' ? 'Не удалось расшифровать хранилище.' : error.message; }
  finally { loginSubmitting = false; $('continue').disabled = false; }
});
$('back-email').addEventListener('click', () => { state.step = 'email'; $('email-step').hidden = false; $('password-step').hidden = true; $('password').value = ''; $('otp').value = ''; $('password').required = false; $('otp').required = false; $('auth-message').textContent = ''; $('email').focus(); });
async function updateQr() {
  const label = `NUTE:${$('setup-email').value.trim() || 'Личное хранилище'}`;
  const uri = `otpauth://totp/${encodeURIComponent(label)}?secret=${setupSecret}&issuer=NUTE&algorithm=SHA1&digits=6&period=30`;
  await QRCode.toCanvas($('totp-qr'), uri, { width: 220, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
}
$('setup-email').addEventListener('change', () => updateQr().catch(() => toast('Не удалось обновить QR-код')));
$('setup-form').addEventListener('submit', async event => {
  event.preventDefault(); $('setup-submit').disabled = true; $('setup-message').textContent = '';
  const epoch = state.epoch;
  try {
    const password = $('setup-password').value;
    if (password.length < 16 || password !== $('setup-repeat').value) throw new Error('Пароли должны совпадать и содержать не менее 16 символов.');
    const salt = randomSalt(); const { authProof, wrappingKey } = await deriveKeys(password, salt); const { key, wrappedKey } = await createVaultKey(wrappingKey);
    const result = await api('setup', { token: $('setup-token').value.trim(), email: $('setup-email').value.trim().toLowerCase(), authProof, salt, wrappedKey, vault: await encryptVault(key, emptyVault()), totpSecret: setupSecret, otp: $('setup-otp').value.trim() });
    if (!await finishLogin(result, key, salt, wrappingKey, epoch)) return;
    history.replaceState(null, '', location.pathname);
    const extra = document.createElement('div'); const codes = document.createElement('pre'); codes.textContent = result.recoveryCodes.join('\n'); extra.append(codes);
    const downloadButton = document.createElement('button'); downloadButton.type = 'button'; downloadButton.className = 'recovery-download'; downloadButton.textContent = 'Скачать резервные коды'; downloadButton.addEventListener('click', async () => { try { await download({ account: result.email, recoveryCodes: result.recoveryCodes }, 'NUTE-recovery-codes.json'); } catch(error) { toast(error.message); } }); extra.append(downloadButton);
    await ask('Сохраните резервные коды', 'Каждый код заменяет код аутентификатора только один раз. Храните отдельно от заметок. Эти коды не заменяют мастер-пароль.', { extra, confirm: 'Я сохранил коды', noCancel: true });
    result.recoveryCodes.fill('');
  } catch (error) { $('setup-message').textContent = error.message; }
  finally { $('setup-submit').disabled = false; }
});
$('search').addEventListener('input', () => render()); $('folder-select').addEventListener('change', event => selectFolder(event.target.value));
for (const id of ['new-note','mobile-new','empty-create']) $(id).addEventListener('click', newNote);
$('mobile-back').addEventListener('click', () => $('workspace').classList.remove('editing'));
$('note-title').addEventListener('input', () => { const note = selectedNote(); if (!note || note.deleted !== null || state.locking || pinClosing || (note.pin && !noteLocks.get(note))) return; note.title = $('note-title').value.slice(0,300); note.updated = Date.now(); changed(); renderList(); });
function togglePinned(id) {
  const note = state.vault?.notes.find(item => item.id === id);
  if (!note || state.locking || note.deleted !== null) return;
  note.pinned = !note.pinned; changed(); renderList(); renderEditor();
}
$('pin-note').addEventListener('click', () => togglePinned(state.selected));
$('checklist').addEventListener('click', () => { closeEditorMenus(); richEditor.command('checklist'); });
$('format-button').addEventListener('click', () => { const open = $('format-menu').hidden; closeEditorMenus(); $('format-menu').hidden = !open; $('format-button').setAttribute('aria-expanded', String(open)); });
$('table-button').addEventListener('click', () => { const open = $('table-menu').hidden; closeEditorMenus(); if (richEditor.command('table')) { $('table-menu').hidden = !open; $('table-button').setAttribute('aria-expanded', String(open)); } });
for (const name of formatNames) $('format-' + name).addEventListener('click', () => { richEditor.command(name); if (!['bold','italic','underline','strike'].includes(name)) closeEditorMenus(); });
for (const name of tableNames) $('table-' + name).addEventListener('click', () => { richEditor.command(name); closeEditorMenus(); });
for (const id of ['format-button','checklist','table-button', ...formatNames.map(name => 'format-' + name), ...tableNames.map(name => 'table-' + name)]) $(id).addEventListener('mousedown', event => event.preventDefault());
document.addEventListener('click', event => { if (!event.target.closest('.editor-popover') && !event.target.closest('#format-button') && !event.target.closest('#table-button')) closeEditorMenus(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && (!$('format-menu').hidden || !$('table-menu').hidden)) { closeEditorMenus(); richEditor.focus(); } });
$('mobile-folder-menu').addEventListener('click', () => manageFolder(state.folder));
$('move-folder').addEventListener('change', event => { const note = selectedNote(); if (!note) return; note.folder = event.target.value; note.updated = Date.now(); changed(); render(); });
for (const id of ['new-folder','mobile-new-folder']) $(id).addEventListener('click', async () => { const epoch = state.epoch; const name = await ask('Новая папка', 'Название папки', { input: true, confirm: 'Создать' }); if (!state.vault || state.epoch !== epoch || state.locking || !name?.trim()) return; if (state.vault.folders.length >= 100) return toast('Можно создать не более 100 папок'); const folder = { id: crypto.randomUUID(), name: name.trim() }; state.vault.folders.push(folder); state.folder = folder.id; changed(); render(); });
async function deleteNote(id) {
  const note = state.vault?.notes.find(item => item.id === id), epoch = state.epoch;
  if (!note || state.locking) return;
  if (noteLocks.get(note)) { await closeProtectedNote(note); if (epoch !== state.epoch || state.locking || noteLocks.get(note)) return; }
  if (note.deleted !== null) { if (!await ask('Удалить заметку навсегда?', 'Вернуть её можно будет только из вашей резервной копии.', { confirm: 'Удалить' })) return; if (!state.vault || state.locking || state.epoch !== epoch || !state.vault.notes.includes(note) || note.deleted === null) return; state.vault.notes = state.vault.notes.filter(item => item.id !== note.id); }
  else { note.deleted = Date.now(); note.updated = Date.now(); }
  noteLocks.forget(note); changed(); render();
}
function restoreNote(id) {
  const note = state.vault?.notes.find(item => item.id === id);
  if (!note || state.locking || note.deleted === null) return;
  note.deleted = null; note.updated = Date.now(); changed(); render(); toast('Заметка восстановлена');
}
$('delete-note').addEventListener('click', () => deleteNote(state.selected));
$('restore-note').addEventListener('click', () => restoreNote(state.selected));
$('account-button').addEventListener('click', () => { $('account-menu').hidden = !$('account-menu').hidden; $('account-button').setAttribute('aria-expanded', String(!$('account-menu').hidden)); });
document.addEventListener('click', event => { if (!event.target.closest('.account-menu') && !event.target.closest('#account-button')) { $('account-menu').hidden = true; $('account-button').setAttribute('aria-expanded','false'); } });
$('backup').addEventListener('click', exportBackup); $('rescue-backup').addEventListener('click', exportBackup);
$('download-rescue').addEventListener('click', async () => { if (!rescueCopy) return; try { await download(rescueCopy, 'NUTE-unsaved-encrypted.json'); rescueCopy = null; $('download-rescue').hidden = true; toast('Зашифрованная копия скачана'); } catch(error) { toast(error.message); } });
$('lock').addEventListener('click', () => lock().catch(error => toast(error.message)));
// A retry must preserve the original choice to forget the device, if requested.
$('retry-lock').addEventListener('click', () => lock(false, forgetPending).catch(error => toast(error.message)));
$('logout').addEventListener('click', () => lock(false, true).catch(error => toast(error.message)));
$('trusted-devices').addEventListener('click', async () => {
  $('account-menu').hidden = true; const epoch = state.epoch;
  try {
    const result = await api('devices', null, 'GET'); if (!state.key || state.epoch !== epoch) return;
    const extra = document.createElement('div'); extra.className = 'device-list';
    for (const device of result.devices) {
      const row = document.createElement('div'); row.className = 'device-row'; const text = document.createElement('span');
      text.textContent = `${device.label}${device.current ? ' — это устройство' : ''}\nДо ${shortDate.format(device.expiresAt * 1000)}`;
      const button = document.createElement('button'); button.className = 'danger-text'; button.textContent = 'Отозвать';
      button.type = 'button'; button.addEventListener('click', async () => { button.disabled = true; try { await api('revoke_device', { id: device.id }); if (state.epoch !== epoch) return; if (device.current) trustedDevice = false; button.textContent = 'Отозвано'; } catch (error) { button.disabled = false; toast(error.message); } });
      row.append(text, button); extra.append(row);
    }
    await ask('Доверенные устройства', result.devices.length ? 'Доверие действует 180 дней с подтверждения. Отзыв потребует 2FA при следующем входе; уже открытый сеанс продолжит работу.' : 'Пока нет доверенных устройств. При входе отметьте «Доверять этому устройству 180 дней».', { extra, confirm: 'Закрыть', noCancel: true });
  } catch (error) { toast(error.message); }
});
$('retry-save').addEventListener('click', () => flush().catch(() => {}));
$('reload-vault').addEventListener('click', async () => {
  if (syncEngine) { await flush().catch(() => {}); return; }
  if (!await ask('Загрузить серверную версию?', 'Сначала будет скачана зашифрованная копия ваших текущих изменений. Затем редактор откроет последнюю сохранённую версию.', { confirm: 'Скачать и загрузить' })) return;
  const epoch = state.epoch; $('workspace').inert = true; clearTimeout(saveTimer);
  try { if (state.saving) await state.saving.catch(() => {}); if (!state.key || !await exportBackup()) return; const result = await api('vault', null, 'GET'); if (epoch !== state.epoch) return; const vault = validateVault(await decryptVault(state.key, result.vault)); if (epoch !== state.epoch) return; noteLocks.clear(); state.vault = vault; state.revision = result.revision; state.generation = 0; state.saved = 0; state.conflict = false; sessionStorage.removeItem(pendingName); $('sync-error').hidden = true; status('Сохранено'); render(); } catch(error) { toast(error.message); } finally { if (!state.locking) $('workspace').inert = false; }
});
$('restore-backup').addEventListener('click', () => { $('account-menu').hidden = true; $('backup-file').click(); });
$('backup-file').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return; const epoch = state.epoch;
  try {
    if (file.size > 64 * 1024 * 1024 + 65536) throw new Error('Файл резервной копии слишком большой.');
    const backup = JSON.parse(await file.text());
    if (backup.format !== 'NUTE-ENCRYPTED-BACKUP' || backup.version !== 1 || backup.kdf?.iterations !== 600000 || backup.kdf?.name !== 'PBKDF2-SHA256') throw new Error('Это не резервная копия NUTE.');
    const password = await ask('Пароль резервной копии', 'Введите мастер-пароль, которым была зашифрована эта копия. Заметки из неё будут добавлены; существующие сохранятся.', { input: true, password: true, confirm: 'Расшифровать' });
    if (!password || !state.key || epoch !== state.epoch || state.locking) return;
    const { wrappingKey } = await deriveKeys(password, backup.salt); const key = await unwrapVaultKey(wrappingKey, backup.wrappedKey); const incoming = validateVault(await decryptVault(key, backup.vault), {recovery:true});
    if (!state.key || epoch !== state.epoch || state.locking) return;
    await noteLocks.snapshot(state.vault); if (!state.key || epoch !== state.epoch || state.locking) return; mergeVault(incoming); await flush(); toast('Заметки из копии добавлены');
  } catch (error) { toast(error.name === 'OperationError' ? 'Неверный пароль или повреждённая копия.' : error.message); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && state.key) flush().catch(() => {}); });
window.addEventListener('beforeunload', event => { if (lockPromise || lockIncomplete || rescueCopy || (state.key && state.generation !== (syncEngine ? localSaved : state.saved))) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => {
  const capsule = readResume();
  if (capsule && state.key && !state.locking) writeResume({ ...capsule, view: { folder: state.folder, selected: state.selected, editing: $('workspace').classList.contains('editing') } });
  clearPrivateUI(true);
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
window.addEventListener('online', () => { if (state.key) flush().catch(() => {}); });
document.addEventListener('keydown', event => { if (state.key && (event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); flush().catch(() => {}); } });
async function finishLogin(result, key, salt, wrappingKey, epoch = state.epoch) {
  if (epoch !== state.epoch) { delete result.resumeSecret; return false; }
  clearResume();
  let capsule; const resumeSecret = result.resumeSecret;
  try { capsule = await createResumeCapsule(wrappingKey, result, salt); }
  catch { /* The vault can still open when reload continuity is unavailable. */ }
  finally { delete result.resumeSecret; }
  if (epoch !== state.epoch) return false;
  await enter(result, key, salt, epoch);
  if (state.epoch !== epoch + 1 || state.key !== key || state.locking) return false;
  if (!capsule || !writeResume(capsule)) toast('Не удалось сохранить сеанс вкладки. После обновления потребуется вход.');
  if (capsule && nativePlatform()) {
    unlockSaving = localStore.save({unlock:{capsule,resumeSecret}});
    await unlockSaving;
  }
  return state.epoch === epoch + 1 && state.key === key && !state.locking;
}
async function restoreSession(capsule, epoch = state.epoch) {
  if (epoch !== state.epoch) return;
  let result;
  try { result = await api('resume'); }
  catch (error) { if (epoch === state.epoch && error.status === 401) clearResume(); throw error; }
  let restored;
  try { restored = await openResumeCapsule(capsule, result); }
  catch (error) { if (epoch === state.epoch) clearResume(); throw error; }
  finally { delete result.resumeSecret; }
  if (epoch !== state.epoch) return;
  await enter(result, restored.key, restored.salt, epoch, capsule.view);
}
function boot() {
  if (!bootPromise) bootPromise = initialize().finally(() => { bootPromise = null; });
  return bootPromise;
}
async function initialize() {
  if (lockPromise || lockIncomplete) return;
  const epoch = state.epoch;
  const capsule = readResume();
  // A first launch must accept touch/IME input even while the network is slow.
  // Only an existing session restore temporarily owns the login form.
  $('login-form').inert = !!capsule;
  if (capsule) $('auth-message').textContent = 'Открываем заметки…';
  try {
    if (!crypto.subtle) throw new Error('Для NUTE необходимо защищённое HTTPS-соединение.');
    if (nativePlatform()) {
      const local = await localStore.load();
      if (local.cache && local.unlock) {
        $('login-form').inert = true;
        const restored = await openResumeCapsule(local.unlock.capsule, {...local.cache,resumeSecret:local.unlock.resumeSecret});
        if (epoch !== state.epoch) return;
        syncSupported = true;
        await enter({...local.cache,revision:0,syncProtocol:1},restored.key,restored.salt,epoch);
        // Native sender retains its own authenticated cookies/CSRF while offline.
        api('bootstrap',null,'GET').then(()=>flush()).catch(()=>{});
        return;
      }
    }
    const result = await api('bootstrap', null, 'GET'); state.csrf = result.csrf;
    if (epoch !== state.epoch) return;
    if (result.initialized && capsule) {
      try { await restoreSession(capsule, epoch); }
      catch (error) {
        if (epoch !== state.epoch) return;
        $('auth-message').textContent = error.status === 401 ? 'Сеанс завершён. Войдите снова.' : 'Не удалось восстановить сеанс. Обновите страницу или войдите снова.';
      }
    }
    if (new URLSearchParams(location.search).has('setup') && !result.initialized) { $('login').hidden = true; $('setup').hidden = false; setupSecret = randomTotpSecret(); $('totp-secret').textContent = setupSecret; await updateQr(); }
  } catch (error) { $('auth-message').textContent = error.message; }
  finally { $('login-form').inert = false; }
}
setInterval(() => { if (state.key && syncEngine && !state.locking) flush().catch(() => {}); }, 5000);
window.addEventListener('focus', () => { if(state.key && syncEngine)flush().catch(()=>{}); });
boot();
