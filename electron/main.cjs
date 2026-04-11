const path = require('path')
const { app, BrowserWindow, ipcMain, shell } = require('electron')
const launcherService = require('./launcherService.cjs')

let mainWindow = null

function emitLog(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  mainWindow.webContents.send('launcher:log', payload)
}

function emitStatus(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  mainWindow.webContents.send('launcher:status', payload)
}

function makeStateSnapshot(baseDir) {
  const resolvedBaseDir = launcherService.normalizeBaseDir(baseDir)

  return {
    defaultBaseDir: launcherService.getDefaultBaseDir(),
    baseDir: resolvedBaseDir,
    projects: launcherService.getProjects(resolvedBaseDir),
    scenarios: launcherService.getScenarios(),
    statuses: launcherService.getRuntimeStatus(),
  }
}

function registerIpcHandler(channel, task) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      const data = await task(payload)
      return { ok: true, data }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      emitLog({
        timestamp: new Date().toISOString(),
        level: 'error',
        message,
      })

      return { ok: false, error: message }
    }
  })
}

function registerIpcHandlers() {
  registerIpcHandler('launcher:get-state', async (baseDir) => makeStateSnapshot(baseDir))

  registerIpcHandler('launcher:get-scenarios', async () => launcherService.getScenarios())

  registerIpcHandler('launcher:setup-all', async (baseDir) => {
    const result = await launcherService.setupAll(baseDir, emitLog, emitStatus)
    return {
      ...result,
      projects: launcherService.getProjects(result.baseDir),
      statuses: launcherService.getRuntimeStatus(),
    }
  })

  registerIpcHandler('launcher:sync-all', async (baseDir) => {
    const result = await launcherService.syncAll(baseDir, emitLog, emitStatus)
    return {
      ...result,
      projects: launcherService.getProjects(result.baseDir),
      statuses: launcherService.getRuntimeStatus(),
    }
  })

  registerIpcHandler('launcher:install-all', async (baseDir) => {
    const result = await launcherService.installAll(baseDir, emitLog, emitStatus)
    return {
      ...result,
      projects: launcherService.getProjects(result.baseDir),
      statuses: launcherService.getRuntimeStatus(),
    }
  })

  registerIpcHandler('launcher:launch-all', async (payload) => {
    const baseDir = typeof payload === 'string' ? payload : payload?.baseDir
    const launchConfig = typeof payload === 'object' ? payload?.launchConfig : undefined

    return launcherService.launchAll(baseDir, emitLog, emitStatus, launchConfig)
  })

  registerIpcHandler('launcher:stop-all', async () => launcherService.stopAll(emitLog, emitStatus))

  registerIpcHandler('launcher:sync-project', async (payload) => {
    const result = await launcherService.syncProject(
      payload?.baseDir,
      payload?.projectId,
      emitLog,
      emitStatus,
    )
    return {
      ...result,
      statuses: launcherService.getRuntimeStatus(),
    }
  })

  registerIpcHandler('launcher:install-project', async (payload) => {
    const result = await launcherService.installProject(
      payload?.baseDir,
      payload?.projectId,
      emitLog,
      emitStatus,
    )
    return {
      ...result,
      statuses: launcherService.getRuntimeStatus(),
    }
  })

  registerIpcHandler('launcher:launch-project', async (payload) => {
    return launcherService.startProject(
      payload?.baseDir,
      payload?.projectId,
      emitLog,
      emitStatus,
      payload?.launchConfig,
    )
  })

  registerIpcHandler('launcher:stop-project', async (payload) => {
    return launcherService.stopProject(payload?.projectId, emitLog, emitStatus)
  })

  registerIpcHandler('launcher:run-diagnostics', async (payload) => {
    const result = await launcherService.runDiagnostics(
      payload?.baseDir,
      payload?.launchConfig,
      emitStatus,
    )

    return {
      ...result,
      statuses: launcherService.getRuntimeStatus(),
    }
  })

  registerIpcHandler('launcher:run-autotest', async (payload) => {
    const result = await launcherService.runAutotest(payload?.baseDir, payload?.launchConfig, emitStatus)

    return {
      ...result,
      statuses: launcherService.getRuntimeStatus(),
    }
  })

  registerIpcHandler('launcher:run-scenario', async (payload) => {
    return launcherService.runScenario(
      payload?.baseDir,
      payload?.scenarioId,
      payload?.launchConfig,
      emitLog,
      emitStatus,
    )
  })

  registerIpcHandler('launcher:export-logs', async (payload) => {
    return launcherService.exportLogs(payload?.baseDir, payload?.logs)
  })
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 920,
    minWidth: 1120,
    minHeight: 760,
    title: 'GEII ESA 2026 - Launcher',
    backgroundColor: '#071628',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('before-quit', () => {
  launcherService.shutdown(emitLog, emitStatus)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})