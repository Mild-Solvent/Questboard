const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('questboard', {
  loadQuests: () => ipcRenderer.invoke('quests:load'),
  saveQuests: (md) => ipcRenderer.invoke('quests:save', md),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (s) => ipcRenderer.invoke('state:save', s),
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
});
