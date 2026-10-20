'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ServerPicker', Object.freeze({
  info: () => ipcRenderer.invoke('nute:pick-server-info'),
  select: origin => ipcRenderer.invoke('nute:pick-server', origin),
}));
