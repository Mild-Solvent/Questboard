const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('questboard', {
  readFile: (name) => ipcRenderer.invoke('data:read', name),
  writeFile: (name, text) => ipcRenderer.invoke('data:write', name, text),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (v) => ipcRenderer.invoke('autostart:set', v),
  appInfo: () => ipcRenderer.invoke('app:info'),
  minimize: () => ipcRenderer.send('window:minimize'),
  hide: () => ipcRenderer.send('window:hide'),
  quit: () => ipcRenderer.send('window:quit'),
  openExternal: (url) => ipcRenderer.send('app:openExternal', url),
  openDataDir: () => ipcRenderer.send('app:openDataDir'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onQuestsChanged: (cb) => ipcRenderer.on('quests:changed', (_e, text) => cb(text)),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, s) => cb(s)),
  onIdle: (cb) => ipcRenderer.on('app:idle', (_e, v) => cb(v)),
});
