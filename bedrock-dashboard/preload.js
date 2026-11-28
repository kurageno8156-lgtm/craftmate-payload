const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bedrock', {
  status: () => ipcRenderer.invoke('bedrock:bds-status'),
  start: () => ipcRenderer.invoke('bedrock:bds-start'),
  stop: () => ipcRenderer.invoke('bedrock:bds-stop'),
  cmd: (c) => ipcRenderer.invoke('bedrock:bds-cmd', c),
  logs: () => ipcRenderer.invoke('bedrock:logs'),
  onLog: (cb) => ipcRenderer.on('bedrock:log', (_e, l) => cb(l)),
  propsGet: () => ipcRenderer.invoke('bedrock:props-get'),
  propsSet: (p) => ipcRenderer.invoke('bedrock:props-set', p),
  listJson: (n) => ipcRenderer.invoke('bedrock:list-json', n),
  writeJson: (n, d) => ipcRenderer.invoke('bedrock:write-json', n, d),
  backupCreate: () => ipcRenderer.invoke('bedrock:backup-create'),
  backupList: () => ipcRenderer.invoke('bedrock:backup-list'),
  backupRestore: (n) => ipcRenderer.invoke('bedrock:backup-restore', n),
  versionCheck: () => ipcRenderer.invoke('bedrock:version-check'),
  pickBdsDir: () => ipcRenderer.invoke('bedrock:pick-bds-dir'),
});
