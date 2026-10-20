'use strict';
const { app, BrowserWindow, Menu, Tray, protocol, ipcMain, safeStorage, dialog, shell, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Store } = require('./store.cjs');
const { Service } = require('./service.cjs');
const { Worker } = require('./worker.cjs');
const C = require('./contracts.cjs');
const { requireSecureStorage, profileName } = require('./desktop-config.cjs');

const smoke = process.argv.includes('--nute-self-test') || (!app.isPackaged && process.argv.includes('--nute-smoke'));
const smokeDirectory = process.platform === 'linux' ? path.join(app.getPath('temp'), 'nute-self-test-' + Date.now())
  : app.isPackaged ? path.join(path.dirname(process.execPath), 'nute-self-test-' + Date.now()) : path.join(__dirname, '../artifacts', 'smoke-' + Date.now());
if (smoke) app.setPath('userData', smokeDirectory);
app.setAppUserModelId('org.nutenotes.app');
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: 'nute', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
let window, tray, store, service, worker, quitting = false, quitReady = false, quitFlushing = false;
let storageBackend, serverOrigin = C.ORIGIN;
const uiRoot = path.join(__dirname, '../ui');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8' };
function open() { if (!window || window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
async function external(url) { if (!C.externalUrl(url)) throw new Error('Этот внешний адрес не разрешён.'); await shell.openExternal(url); return { ok: true }; }
function registerBridge() {
  const actions = {
    request: input => service.request(input), load: () => store.load(), save: input => store.save(input),
    enqueue: async input => { const result = await store.enqueue(input); worker.wake(); return result; },
    ack: input => store.ack(input), clear: input => service.clear(input),
    openExternal: input => external(input?.url),
    saveFile: async input => {
      if (!C.object(input) || typeof input.name !== 'string' || !/^[A-Za-zА-Яа-яЁё0-9 _().-]{1,120}\.json$/u.test(input.name)
        || typeof input.data !== 'string' || Buffer.byteLength(input.data) > C.MAX_CACHE + 65536) throw new Error('Некорректный файл резервной копии.');
      JSON.parse(input.data);
      const result = await dialog.showSaveDialog(window, { title: 'Сохранить резервную копию NUTE', defaultPath: input.name, filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['showOverwriteConfirmation'] });
      if (result.canceled || !result.filePath) return { ok: false };
      if (path.extname(result.filePath).toLowerCase() !== '.json') throw new Error('Резервная копия должна иметь расширение .json.');
      await fs.writeFile(result.filePath, input.data, { encoding: 'utf8', mode: 0o600 }); return { ok: true };
    },
  };
  for (const [name, action] of Object.entries(actions)) ipcMain.handle('nute:' + name, (event, input) => {
    if (!C.senderAllowed(event, window?.webContents)) throw new Error('Недопустимый источник запроса.');
    return action(input);
  });
}
function menu() {
  return Menu.buildFromTemplate([
    { label: 'Открыть NUTE', click: open },
    { label: 'Синхронизировать', click: () => worker.wake() },
    ...(process.platform === 'win32' ? [{ label: 'Запускать вместе с Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: item => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }); } }] : []),
    { type: 'separator' },
    { label: 'Завершить NUTE', click: () => app.quit() },
  ]);
}
async function createWindow() {
  window = new BrowserWindow({ title: 'Nute Notes — ' + new URL(serverOrigin).hostname, width: 1180, height: 820, minWidth: 390, minHeight: 480,
    show: false, backgroundColor: '#1d1d1f', icon: path.join(uiRoot, 'assets/nute-logo.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: !app.isPackaged,
      spellcheck: false, backgroundThrottling: true, partition: 'nute-renderer' } });
  const session = window.webContents.session;
  session.setPermissionRequestHandler((_contents,_permission,callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on('will-download', event => event.preventDefault());
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !C.localUrl(details.url) && !details.url.startsWith('data:') && !details.url.startsWith('blob:') }));
  session.protocol.handle('nute', async request => {
    const file = C.assetPath(request.url, uiRoot);
    if (request.method !== 'GET' || !file) return new Response('', { status: 404 });
    try { return new Response(await fs.readFile(file), { headers: { 'Content-Type': types[path.extname(file)], 'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } }); }
    catch { return new Response('', { status: 404 }); }
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-navigate', (event, url) => { event.preventDefault(); if (C.externalUrl(url)) external(url).catch(() => {}); });
  window.webContents.setWindowOpenHandler(({ url }) => { if (C.externalUrl(url)) external(url).catch(() => {}); return { action: 'deny' }; });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.webContents.on('will-prevent-unload', () => { quitting = false; quitReady = false; worker.stopped = false; worker.wake(); open(); });
  window.on('ready-to-show', () => { if (!smoke && !process.argv.includes('--hidden')) window.show(); });
  await window.loadURL(C.LOCAL_ORIGIN + '/index.html');
}

async function runtimeSmoke() {
  const prefs = window.webContents.getLastWebPreferences();
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await window.webContents.executeJavaScript("!document.getElementById('login-form').inert")) break;
    if (attempt === 99) throw new Error('UI boot did not complete');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const result = await window.webContents.executeJavaScript(`(async () => {
    if (typeof require !== 'undefined' || typeof process !== 'undefined') throw new Error('Node leaked to renderer');
    if (!window.isSecureContext || !crypto.subtle) throw new Error('Local protocol is not secure');
    const native = window.NuteNative;
    if (!native || typeof native.request !== 'function') throw new Error('Bridge missing');
    await native.save({cache:{smoke:'ciphertext-fixture'},unlock:{capsule:'encrypted-fixture',resumeSecret:'smoke-protected-value'}});
    const loaded = await native.load();
    if (loaded.unlock.resumeSecret !== 'smoke-protected-value') throw new Error('Protected store round trip failed');
    let denied = 0;
    for (const request of [{action:'https://attacker.example',method:'GET'},{action:'bootstrap',method:'DELETE'}]) {
      try { await native.request(request); } catch { denied++; }
    }
    try { await native.openExternal({url:'file:///C:/Windows/System32/cmd.exe'}); } catch { denied++; }
    await native.request({action:'bootstrap',method:'GET'});
    const pinActions=[];
    for (const action of ['pin_register','pin_check']) {
      const pin=await native.request({action,method:'POST',data:{id:'smoke-pin',proof:'a'.repeat(64)}});
      if(pin.status!==200 || pin.body.pinForwarded!==action) throw new Error('PIN action did not cross native bridge');
      pinActions.push(action);
    }
    const id=crypto.randomUUID();
    await native.enqueue({operations:[{id,data:{v:1,iv:btoa('123456789012'),ciphertext:btoa('fixture-encrypted-operation-data!')}}]});
    return {secureContext:window.isSecureContext,bridgeMethods:Object.keys(native),denied,pinActions,title:document.title,id};
  })()`);
  assert.equal(result.denied, 3);
  const disk = await fs.readFile(store.file, 'utf8'); assert.ok(!disk.includes('smoke-protected-value'));
  window.close(); assert.equal(window.isVisible(), false); assert.equal(window.isDestroyed(), false);
  await worker.run();
  const workerState = await store.snapshot();
  assert.equal(workerState.pending.find(op => op.id === result.id)?.delivered, true,
    JSON.stringify({ pending: workerState.pending.map(op => ({ id: op.id, delivered: op.delivered })), lastError: workerState.lastError, cookies: Object.keys(workerState.credentials.cookies), failure: worker.lastFailure?.message }));
  const restored = await new Store(path.dirname(store.file), { encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) }).initialize();
  assert.deepEqual((await restored.load()).cache, { smoke: 'ciphertext-fixture' });
  assert.ok((await restored.load()).pending.some(op => op.id === result.id));
  let screenshotStatus = 'captured';
  try { const screenshot = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await fs.writeFile(path.join(smokeDirectory, 'runtime.png'), screenshot.toPNG()); }
  catch (error) { screenshotStatus = 'unavailable: ' + error.message; }
  await fs.writeFile(path.join(smokeDirectory, 'result.json'), JSON.stringify({ ...result, electron: process.versions.electron, platform: process.platform, serverOrigin, storageBackend, sandbox: true, contextIsolation: true, nodeIntegration: false, encryptedStorage: safeStorage.isEncryptionAvailable(), closeKeepsTrayProcess: true, backgroundDeliveredAfterWindowClosed: true, deliveredCiphertextSurvivesRestart: true, screenshotStatus }, null, 2));
  console.log('NUTE_DESKTOP_SMOKE_OK ' + path.join(smokeDirectory, 'result.json'));
  app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', open);
  app.on('before-quit', event => {
    quitting = true; worker?.stop();
    if (quitReady || !store) return;
    event.preventDefault();
    if (quitFlushing) return;
    quitFlushing = true;
    // Already-enqueued filesystem transactions must finish before process exit.
    // The renderer's beforeunload guard separately protects edits not yet queued.
    store.tail.then(() => { quitFlushing = false; quitReady = true; app.quit(); });
  });
  app.on('window-all-closed', () => { /* Tray owns the process lifetime. */ });
  app.whenReady().then(async () => {
    storageBackend = requireSecureStorage(process.platform, safeStorage);
    if (['linux', 'win32'].includes(process.platform)) {
      const { pickServer } = require('./server-picker.cjs');
      serverOrigin = await pickServer({ BrowserWindow, ipcMain, userData: app.getPath('userData'), defaultOrigin: '', testSelection: smoke ? 'https://smoke.nute.example' : null });
      if (!serverOrigin) { quitting = true; app.quit(); return; }
    }
    const vaultPath = ['linux', 'win32'].includes(process.platform) ? path.join(app.getPath('userData'), 'servers', profileName(serverOrigin), 'vault') : path.join(app.getPath('userData'), 'vault');
    store = await new Store(vaultPath, { encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) }).initialize();
    const transport = smoke ? async (url, options) => {
      const action = new URL(url).searchParams.get('action');
      const body = action === 'sync_push' ? { accepted: JSON.parse(options.body).operations.map(op => op.id), cursor: 1 }
        : ['pin_register','pin_check'].includes(action) ? { ok: true, pinForwarded: action }
        : { initialized: true, csrf: 'a'.repeat(64), trustedDevice: false };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': '__Host-nute=smoke-session; Path=/; Secure; HttpOnly; SameSite=Strict' } });
    } : globalThis.fetch;
    service = new Service(store, transport, serverOrigin); worker = new Worker(store, service); service.onAuthenticated = () => worker.wake();
    registerBridge();
    Menu.setApplicationMenu(process.platform === 'linux' ? Menu.buildFromTemplate([{ label: 'NUTE', submenu: [
      { label: new URL(serverOrigin).hostname, enabled: false },
      { label: 'Синхронизировать', click: () => worker.wake() },
      { label: 'Завершить NUTE', click: () => app.quit() },
    ] }]) : null);
    tray = new Tray(nativeImage.createFromPath(path.join(uiRoot, 'assets/nute-logo.png')).resize({ width: 32, height: 32 }));
    tray.setToolTip('NUTE — зашифрованные заметки'); tray.setContextMenu(menu()); tray.on('double-click', open);
    await createWindow();
    if (smoke) await runtimeSmoke(); else worker.wake(1500);
  }).catch(async error => {
    if (smoke) { await fs.mkdir(smokeDirectory, { recursive: true }); await fs.writeFile(path.join(smokeDirectory, 'error.txt'), error.stack || error.message); console.error(error.stack); }
    else dialog.showErrorBox('NUTE', 'Не удалось запустить приложение. Ваши локальные данные сохранены.\n' + error.message);
    quitting = true; app.exit(1);
  });
}
