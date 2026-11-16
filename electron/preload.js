const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('craftmateInstaller', {
  status: () => ipcRenderer.invoke('craftmate:status'),
  install: () => ipcRenderer.invoke('craftmate:install'),
  launch: () => ipcRenderer.invoke('craftmate:launch'),
});
