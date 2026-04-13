const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  if (typeof callback !== 'function') {
    return () => {}
  }

  const listener = (_event, payload) => {
    callback(payload)
  }

  ipcRenderer.on(channel, listener)

  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('launcherApi', {
  getState: (baseDir) => ipcRenderer.invoke('launcher:get-state', baseDir),
  getScenarios: () => ipcRenderer.invoke('launcher:get-scenarios'),
  setupAll: (baseDir) => ipcRenderer.invoke('launcher:setup-all', baseDir),
  syncAll: (baseDir) => ipcRenderer.invoke('launcher:sync-all', baseDir),
  installAll: (baseDir) => ipcRenderer.invoke('launcher:install-all', baseDir),
  launchAll: (payload) => ipcRenderer.invoke('launcher:launch-all', payload),
  stopAll: () => ipcRenderer.invoke('launcher:stop-all'),
  syncProject: (payload) => ipcRenderer.invoke('launcher:sync-project', payload),
  installProject: (payload) => ipcRenderer.invoke('launcher:install-project', payload),
  launchProject: (payload) => ipcRenderer.invoke('launcher:launch-project', payload),
  stopProject: (payload) => ipcRenderer.invoke('launcher:stop-project', payload),
  runDiagnostics: (payload) => ipcRenderer.invoke('launcher:run-diagnostics', payload),
  runAutotest: (payload) => ipcRenderer.invoke('launcher:run-autotest', payload),
  installSdrPlusPlus: () => ipcRenderer.invoke('launcher:install-sdrpp'),
  openBetaflight: () => ipcRenderer.invoke('launcher:open-betaflight'),
  runScenario: (payload) => ipcRenderer.invoke('launcher:run-scenario', payload),
  exportLogs: (payload) => ipcRenderer.invoke('launcher:export-logs', payload),
  onLog: (callback) => subscribe('launcher:log', callback),
  onStatus: (callback) => subscribe('launcher:status', callback),
})