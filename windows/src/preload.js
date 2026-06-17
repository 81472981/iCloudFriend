const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('iCloudFriend', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  chooseFolder: () => ipcRenderer.invoke('dialog:choose-folder'),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  scanBackup: () => ipcRenderer.invoke('backup:scan'),
  listPhotos: () => ipcRenderer.invoke('photos:list'),
  openPhoto: (filePath) => ipcRenderer.invoke('photo:open', filePath),
  getShareStatus: () => ipcRenderer.invoke('share:status'),
  createShare: () => ipcRenderer.invoke('share:create'),
  getReceiverStatus: () => ipcRenderer.invoke('receiver:status'),
  onBackupUpdate: (callback) => {
    const listener = (_event, stats) => callback(stats);
    ipcRenderer.on('backup:update', listener);
    return () => ipcRenderer.removeListener('backup:update', listener);
  }
});
