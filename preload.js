const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('flashka', {
  inspect: () => ipcRenderer.invoke('inspect'),
  detect: () => ipcRenderer.invoke('detect'),
  installTools: () => ipcRenderer.invoke('installTools'),
  pickStick: () => ipcRenderer.invoke('pickStick'),
  download: o => ipcRenderer.invoke('download', o),
  open: u => ipcRenderer.invoke('open', u),
  onProgress: cb => ipcRenderer.on('progress', (e, d) => cb(d))
});
