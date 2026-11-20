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
  pluginRuntimeCheck: (request) => ipcRenderer.invoke('my-scholar:plugin-runtime-check', request),
  onPluginStopped: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('插件停止回调必须是函数。');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('my-scholar:plugin-stopped', listener);
    return () => ipcRenderer.removeListener('my-scholar:plugin-stopped', listener);
  },
  getMcpConfig: () => ipcRenderer.invoke('my-scholar:mcp-config'),
  selectStartupLibrary: (selectedPath) => ipcRenderer.invoke('my-scholar:select-startup-library', selectedPath),
  checkForUpdates: () => ipcRenderer.invoke('my-scholar:check-for-updates'),
  getUpdateState: () => ipcRenderer.invoke('my-scholar:get-update-state'),
  downloadUpdate: () => ipcRenderer.invoke('my-scholar:download-update'),
  installUpdate: () => ipcRenderer.invoke('my-scholar:install-update'),
  onUpdateState: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('更新状态回调必须是函数。');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('my-scholar:update-state', listener);
    return () => ipcRenderer.removeListener('my-scholar:update-state', listener);
  },
  // 谷子云端 MCP（统一账号）
  cloud: Object.freeze({
    getState: () => rendererStateInvoke('my-scholar:cloud-state'),
    requestCode: (purpose, email) => rendererStateInvoke('my-scholar:cloud-request-code', { purpose, email }),
    login: (identifier, password) => rendererStateInvoke('my-scholar:cloud-login', { identifier, password }),
    loginWithCode: (email, code) => rendererStateInvoke('my-scholar:cloud-login-code', { email, code }),
    register: (input) => rendererStateInvoke('my-scholar:cloud-register', input),
    logout: () => rendererStateInvoke('my-scholar:cloud-logout'),
    setEnabled: (enabled) => rendererStateInvoke('my-scholar:cloud-set-enabled', enabled === true),
    listTokens: () => rendererStateInvoke('my-scholar:cloud-tokens'),
    createToken: (name, bindDevice) => rendererStateInvoke('my-scholar:cloud-create-token', { name, bindDevice: bindDevice === true }),
    revokeToken: (id) => rendererStateInvoke('my-scholar:cloud-revoke-token', id),
    toolsChanged: () => rendererStateInvoke('my-scholar:cloud-tools-changed'),
    openAccount: () => rendererStateInvoke('my-scholar:cloud-open-account'),
    onState: (callback) => {
      if (typeof callback !== 'function') throw new TypeError('云端状态回调必须是函数。');
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('my-scholar:cloud-state', listener);
      return () => ipcRenderer.removeListener('my-scholar:cloud-state', listener);
    },
  }),
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
