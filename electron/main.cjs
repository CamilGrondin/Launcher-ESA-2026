const path = require('path')
const fs = require('fs/promises')
const { createWriteStream } = require('fs')
const { spawn } = require('child_process')
const { pipeline } = require('stream/promises')
const { Readable } = require('stream')
const { app, BrowserWindow, ipcMain, shell } = require('electron')
const launcherService = require('./launcherService.cjs')

let mainWindow = null

const SDRPP_RELEASE_PAGE_URL = 'https://github.com/AlexandreRouma/SDRPlusPlus/releases/tag/nightly'
const SDRPP_RELEASE_API_URL =
  'https://api.github.com/repos/AlexandreRouma/SDRPlusPlus/releases/tags/nightly'
const BETAFLIGHT_URL = 'https://app.betaflight.com'

function makeLog(level, message) {
  return {
    timestamp: new Date().toISOString(),
    level,
    message,
  }
}

function getArchAliases() {
  if (process.arch === 'arm64') {
    return ['arm64', 'aarch64']
  }

  if (process.arch === 'x64') {
    return ['x64', 'amd64', 'x86_64', 'intel']
  }

  if (process.arch === 'arm') {
    return ['arm', 'armhf', 'armv7']
  }

  return [process.arch]
}

function containsAny(value, candidates) {
  return candidates.some((candidate) => value.includes(candidate))
}

function scoreSdrAsset(assetName) {
  const lower = assetName.toLowerCase()

  if (lower.startsWith('source code') || lower.endsWith('.sig') || lower.endsWith('.sha256')) {
    return -1
  }

  if (lower.endsWith('.apk')) {
    return -1
  }

  let score = 0
  const isMacAsset = containsAny(lower, ['mac', 'macos', 'darwin', 'osx'])
  const isWindowsAsset = containsAny(lower, ['windows', 'win32', 'win64'])
  const isLinuxAsset = containsAny(lower, ['linux', 'ubuntu', 'debian', 'raspios'])

  if (process.platform === 'darwin') {
    if (isMacAsset) {
      score += 120
    }
    if (isWindowsAsset || isLinuxAsset) {
      score -= 120
    }
    if (lower.endsWith('.dmg')) {
      score += 60
    }
    if (lower.endsWith('.pkg')) {
      score += 50
    }
    if (lower.endsWith('.zip')) {
      score += 35
    }
  }

  if (process.platform === 'win32') {
    if (isWindowsAsset) {
      score += 120
    }
    if (isMacAsset || isLinuxAsset) {
      score -= 120
    }
    if (lower.endsWith('.exe')) {
      score += 60
    }
    if (lower.endsWith('.msi')) {
      score += 50
    }
    if (lower.endsWith('.zip')) {
      score += 35
    }
  }

  if (process.platform === 'linux') {
    if (isLinuxAsset) {
      score += 120
    }
    if (isMacAsset || isWindowsAsset) {
      score -= 120
    }
    if (lower.endsWith('.appimage')) {
      score += 70
    }
    if (lower.endsWith('.deb')) {
      score += 55
    }
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      score += 40
    }
    if (lower.endsWith('.zip')) {
      score += 30
    }
  }

  const archAliases = getArchAliases()
  const hasArchMatch = archAliases.some((alias) => lower.includes(alias))

  if (hasArchMatch) {
    score += 40
  } else if (containsAny(lower, ['arm64', 'aarch64', 'x64', 'amd64', 'x86_64', 'intel', 'armhf'])) {
    score -= 60
  }

  return score
}

function pickBestSdrAsset(assets) {
  let best = null
  let bestScore = -1

  for (const asset of assets) {
    if (!asset || typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') {
      continue
    }

    const score = scoreSdrAsset(asset.name)

    if (score > bestScore) {
      best = asset
      bestScore = score
    }
  }

  if (!best || bestScore <= 0) {
    throw new Error(
      `No compatible SDR++ nightly asset found for ${process.platform}/${process.arch}. Open ${SDRPP_RELEASE_PAGE_URL} manually.`,
    )
  }

  return best
}

async function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Command failed (${code}): ${command} ${args.join(' ')}`))
      }
    })
  })
}

function runDetached(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  })

  child.unref()
}

function toPowerShellLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`
}

async function extractZip(zipPath, outputDir) {
  await fs.rm(outputDir, { recursive: true, force: true })
  await fs.mkdir(outputDir, { recursive: true })

  if (process.platform === 'win32') {
    await runCommand('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath ${toPowerShellLiteral(zipPath)} -DestinationPath ${toPowerShellLiteral(outputDir)} -Force`,
    ])
    return
  }

  if (process.platform === 'darwin') {
    await runCommand('ditto', ['-x', '-k', zipPath, outputDir])
    return
  }

  try {
    await runCommand('unzip', ['-o', zipPath, '-d', outputDir])
  } catch {
    await runCommand('bsdtar', ['-xf', zipPath, '-C', outputDir])
  }
}

async function findInTree(rootDir, predicate) {
  const queue = [rootDir]

  while (queue.length > 0) {
    const currentDir = queue.shift()
    const entries = await fs.readdir(currentDir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)

      if (predicate(entry, fullPath)) {
        return fullPath
      }

      if (entry.isDirectory()) {
        queue.push(fullPath)
      }
    }
  }

  return null
}

async function launchExtractedSdrpp(extractDir) {
  if (process.platform === 'darwin') {
    const appBundle = await findInTree(extractDir, (entry) => {
      const lower = entry.name.toLowerCase()
      return entry.isDirectory() && lower.endsWith('.app') && lower.includes('sdr')
    })

    if (!appBundle) {
      throw new Error(`Unable to find SDR++ app bundle in ${extractDir}`)
    }

    await runCommand('open', [appBundle])
    return {
      launchMode: 'open-app-bundle',
      launchedPath: appBundle,
    }
  }

  if (process.platform === 'win32') {
    const executable = await findInTree(extractDir, (entry) => {
      const lower = entry.name.toLowerCase()
      return entry.isFile() && (lower === 'sdrpp.exe' || lower === 'sdr++.exe')
    })

    if (!executable) {
      throw new Error(`Unable to find SDR++ executable in ${extractDir}`)
    }

    runDetached(executable, [])
    return {
      launchMode: 'spawn-exe',
      launchedPath: executable,
    }
  }

  const executable = await findInTree(extractDir, (entry) => {
    const lower = entry.name.toLowerCase()
    return entry.isFile() && (lower === 'sdrpp' || lower === 'sdr++')
  })

  if (!executable) {
    throw new Error(`Unable to find SDR++ executable in ${extractDir}`)
  }

  await fs.chmod(executable, 0o755)
  runDetached(executable, [])

  return {
    launchMode: 'spawn-binary',
    launchedPath: executable,
  }
}

async function openDownloadedAsset(assetPath) {
  if (process.platform === 'linux') {
    try {
      await runCommand('xdg-open', [assetPath])
      return {
        launchMode: 'xdg-open',
        launchedPath: assetPath,
      }
    } catch {
      // Fallback to shell.openPath below.
    }
  }

  const openError = await shell.openPath(assetPath)

  if (openError) {
    throw new Error(openError)
  }

  return {
    launchMode: 'shell-open-path',
    launchedPath: assetPath,
  }
}

async function downloadToFile(downloadUrl, destinationPath) {
  const response = await fetch(downloadUrl, {
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': 'GEII-ESA-Launcher/0.0.1',
    },
  })

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${downloadUrl} (HTTP ${response.status})`)
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true })
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destinationPath))
}

function stripArchiveExtension(fileName) {
  return fileName.replace(/(\.tar\.gz|\.tgz|\.zip)$/i, '')
}

async function installSdrPlusPlus() {
  const releaseResponse = await fetch(SDRPP_RELEASE_API_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'GEII-ESA-Launcher/0.0.1',
    },
  })

  if (!releaseResponse.ok) {
    throw new Error(
      `Unable to read SDR++ nightly release metadata (HTTP ${releaseResponse.status}). Open ${SDRPP_RELEASE_PAGE_URL} manually.`,
    )
  }

  const releaseData = await releaseResponse.json()
  const assets = Array.isArray(releaseData?.assets) ? releaseData.assets : []
  const bestAsset = pickBestSdrAsset(assets)

  const downloadRoot = path.join(app.getPath('downloads'), 'GEII-ESA-Launcher', 'sdrpp-nightly')
  const downloadedAssetPath = path.join(downloadRoot, bestAsset.name)

  await downloadToFile(bestAsset.browser_download_url, downloadedAssetPath)

  const lowerName = bestAsset.name.toLowerCase()

  if (lowerName.endsWith('.zip')) {
    const extractDir = path.join(downloadRoot, stripArchiveExtension(bestAsset.name))
    await extractZip(downloadedAssetPath, extractDir)
    const launchResult = await launchExtractedSdrpp(extractDir)

    return {
      assetName: bestAsset.name,
      assetUrl: bestAsset.browser_download_url,
      downloadPath: downloadedAssetPath,
      extractedPath: extractDir,
      ...launchResult,
    }
  }

  const launchResult = await openDownloadedAsset(downloadedAssetPath)

  return {
    assetName: bestAsset.name,
    assetUrl: bestAsset.browser_download_url,
    downloadPath: downloadedAssetPath,
    ...launchResult,
  }
}

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

  registerIpcHandler('launcher:install-sdrpp', async () => {
    emitLog(makeLog('info', 'SDR++: fetching nightly release metadata...'))
    const result = await installSdrPlusPlus()
    emitLog(makeLog('success', `SDR++: launched ${result.assetName}`))
    return result
  })

  registerIpcHandler('launcher:open-betaflight', async () => {
    await shell.openExternal(BETAFLIGHT_URL)
    emitLog(makeLog('info', `Opened BetaFlight: ${BETAFLIGHT_URL}`))
    return { url: BETAFLIGHT_URL }
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