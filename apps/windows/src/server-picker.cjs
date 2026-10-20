'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { serverOrigin } = require('./desktop-config.cjs');
async function pickServer({ BrowserWindow, ipcMain, userData, defaultOrigin, testSelection = null }) {
  const settingsFile = path.join(userData, 'server.json');
  let previous = defaultOrigin;
  try { previous = serverOrigin(JSON.parse(await fs.readFile(settingsFile, 'utf8')).origin); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Не удалось прочитать настройку сервера. Файл сохранён: ' + settingsFile); }
  const filename = path.join(__dirname, 'server-picker.html');
  const expected = pathToFileURL(filename).href;
  const picker = new BrowserWindow({ width: 540, height: 380, resizable: false, backgroundColor: '#1d1d1f',
    title: 'NUTE — сервер заметок', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'server-picker-preload.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, partition: 'nute-picker' } });
  picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  picker.webContents.on('will-navigate', event => event.preventDefault());
  picker.webContents.session.setPermissionRequestHandler((_a, _b, done) => done(false));
  const allowed = event => event.sender === picker.webContents && event.senderFrame === picker.webContents.mainFrame && event.senderFrame.url === expected;
  return new Promise((resolve, reject) => {
    let selected = false;
    ipcMain.handle('nute:pick-server-info', event => {
      if (!allowed(event)) throw new Error('Недопустимый источник.');
      return { origin: previous };
    });
    ipcMain.handle('nute:pick-server', async (event, value) => {
      if (!allowed(event) || selected) throw new Error('Недопустимый источник.');
      let origin;
      try { origin = serverOrigin(value); } catch (error) { return { error: error.message }; }
      await fs.mkdir(userData, { recursive: true });
      const temporary = settingsFile + '.tmp';
      await fs.writeFile(temporary, JSON.stringify({ origin }) + '\n', { mode: 0o600 });
      await fs.rename(temporary, settingsFile);
      selected = true; resolve(origin); picker.close();
      return { ok: true };
    });
    picker.on('closed', () => {
      ipcMain.removeHandler('nute:pick-server-info'); ipcMain.removeHandler('nute:pick-server');
      if (!selected) resolve(null);
    });
    picker.loadFile(filename).then(async () => {
      if (testSelection) {
        const result = await picker.webContents.executeJavaScript("window.ServerPicker.select('http://unsafe.example')");
        if (!result.error) throw new Error('Unsafe server selection accepted');
        // Exercise the real isolated preload/IPC bridge, with no remote request.
        await picker.webContents.executeJavaScript(`window.ServerPicker.select(${JSON.stringify(testSelection)})`);
      }
    }).catch(reject);
  });
}
module.exports = { pickServer };
