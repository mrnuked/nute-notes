'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const methods = ['request','load','save','enqueue','ack','clear','saveFile','openExternal'];
const bridge = {};
for (const method of methods) bridge[method] = value => ipcRenderer.invoke('nute:' + method, value);
contextBridge.exposeInMainWorld('NuteNative', Object.freeze(bridge));
