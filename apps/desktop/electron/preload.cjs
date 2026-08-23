const { contextBridge, ipcRenderer } = require('electron');

async function rendererStateInvoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result?.ok) throw new Error(result?.error || '无法保存界面状态。');
  return result.value;
}

contextBridge.exposeInMainWorld('myScholarDesktop', Object.freeze({
  platform: process.platform,
  versions: Object.freeze({ electron: process.versions.electron, chrome: process.versions.chrome }),
  copyImage: (dataURL) => ipcRenderer.invoke('my-scholar:copy-image', dataURL),
  openSourcePdf: (jobId) => ipcRenderer.invoke('my-scholar:open-source-pdf', jobId),
  showItemInFolder: (jobId) => ipcRenderer.invoke('my-scholar:show-item-in-folder', jobId),
  getLibraryLocation: () => ipcRenderer.invoke('my-scholar:get-library-location'),
  chooseLibraryLocation: () => ipcRenderer.invoke('my-scholar:choose-library-location'),
  chooseMineruComponent: () => ipcRenderer.invoke('my-scholar:choose-mineru-component'),
  getStartupContext: () => ipcRenderer.invoke('my-scholar:get-startup-context'),
  selectStartupLibrary: (selectedPath) => ipcRenderer.invoke('my-scholar:select-startup-library', selectedPath),
  checkForUpdates: () => ipcRenderer.invoke('my-scholar:check-for-updates'),
  openUpdateDownload: () => ipcRenderer.invoke('my-scholar:open-update-download'),
  state: Object.freeze({
    loadAll: () => rendererStateInvoke('my-scholar:state-load'),
    set: (key, value) => rendererStateInvoke('my-scholar:state-set', key, value),
    remove: (key) => rendererStateInvoke('my-scholar:state-remove', key),
  }),
  onLibraryMigrationProgress: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('迁移进度回调必须是函数。');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('my-scholar:library-migration-progress', listener);
    return () => ipcRenderer.removeListener('my-scholar:library-migration-progress', listener);
  },
}));
