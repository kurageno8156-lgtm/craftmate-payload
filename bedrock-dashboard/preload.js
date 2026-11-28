const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bedrock', {
  status: () => ipcRenderer.invoke('bedrock:bds-status'),
  start: () => ipcRenderer.invoke('bedrock:bds-start'),
  stop: () => ipcRenderer.invoke('bedrock:bds-stop'),
  getConfig: () => ipcRenderer.invoke('bedrock:get-config'),
});
