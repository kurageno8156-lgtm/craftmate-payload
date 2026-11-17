const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('craftmateInstaller', {
  status: () => ipcRenderer.invoke('craftmate:status'),
  install: () => ipcRenderer.invoke('craftmate:install'),
  launch: () => ipcRenderer.invoke('craftmate:launch'),
});

contextBridge.exposeInMainWorld('craftmateUpdate', {
  apply: (opts) => ipcRenderer.invoke('craftmate:update:apply', opts),
  onProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('craftmate:update-progress', handler);
    return () => ipcRenderer.removeListener('craftmate:update-progress', handler);
  },
});
