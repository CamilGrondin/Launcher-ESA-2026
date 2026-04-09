const fs = require('fs/promises')
const fsSync = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const PROJECTS = [
  {
    id: 'navigation-display',
    name: 'Navigation Display',
    directory: 'Navigation-Display',
    repo: 'https://github.com/CamilGrondin/Navigation-Display.git',
    pythonCommand: 'python3.13',
    startCommand: {
      label: 'Exécuter le projet Navigation Display',
      command: 'python3.13',
      args: ['Navigation Display.py'],
    },
    extraInstallSteps: [
      {
        label: 'Installer les dépendances Python du Navigation Display',
        command: 'python3.13',
        args: [
          '-m',
          'pip',
          'install',
          '--user',
          '--break-system-packages',
          'PyQt5',
          'PyQtWebEngine',
          'pyserial',
        ],
      },
    ],
  },
  {
    id: 'primary-flight-display',
    name: 'Primary Flight Display',
    directory: 'PrimaryFlightDisplay',
    repo: 'https://github.com/CamilGrondin/PrimaryFlightDisplay.git',
    pythonCommand: 'python3.13',
    startCommand: {
      label: 'Exécuter main.py (python3.13)',
      command: 'python3.13',
      args: ['main.py'],
    },
    extraInstallSteps: [
      {
        label: 'Installer les dépendances Python du Primary Flight Display',
        command: 'python3.13',
        args: [
          '-m',
          'pip',
          'install',
          '--user',
          '--break-system-packages',
          'numpy',
          'pygame',
          'pyserial',
        ],
      },
    ],
  },
  {
    id: 'warning-panel',
    name: 'Warning Panel',
    directory: 'Warning-Panel',
    repo: 'https://github.com/CamilGrondin/Warning-Panel.git',
    startCommand: {
      label: 'Ouvrir la prévisualisation Warning Panel',
      command: 'python3.13',
      args: ['-m', 'webbrowser', 'preview-warning-panel.html'],
    },
  },
]

const SCRIPT_PRIORITY = ['start', 'dev', 'launch', 'serve']
const RUNNING_PROCESSES = new Map()

function getDefaultBaseDir() {
  return path.join(os.homedir(), 'GEII-ESA-2026-Simulateur')
}

function normalizeBaseDir(input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return getDefaultBaseDir()
  }

  return path.resolve(input.trim())
}

function nowIso() {
  return new Date().toISOString()
}

function emitLog(logEmitter, payload) {
  if (typeof logEmitter !== 'function') {
    return
  }

  logEmitter({ timestamp: nowIso(), ...payload })
}

function emitStatus(statusEmitter) {
  if (typeof statusEmitter !== 'function') {
    return
  }

  statusEmitter({ statuses: getRuntimeStatus() })
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

function parseChunkToLines(chunk) {
  return chunk
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

function getProjectById(projectId) {
  const project = PROJECTS.find((item) => item.id === projectId)

  if (!project) {
    throw new Error(`Projet inconnu: ${projectId}`)
  }

  return project
}

function getProjectDir(baseDir, project) {
  return path.join(baseDir, project.directory)
}

function normalizeString(value, fallback) {
  if (typeof value !== 'string') {
    return fallback
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function normalizeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeMode(value, allowed, fallback) {
  const parsed = normalizeInteger(value, fallback)
  return allowed.includes(parsed) ? parsed : fallback
}

function buildLaunchOptions(project, launchConfig) {
  const config =
    launchConfig && typeof launchConfig === 'object' ? launchConfig[project.id] || {} : {}

  if (project.id === 'primary-flight-display') {
    const mode = normalizeMode(config.mode, [1, 2, 3], 2)
    const stdinLines = [String(mode)]
    let hint = `mode=${mode}`

    if (mode === 1) {
      const joystickName = normalizeString(config.joystickName, 'X52')
      stdinLines.push(joystickName)
      hint = `${hint}, joystick=${joystickName}`
    } else if (mode === 2) {
      const xplaneIp = normalizeString(config.xplaneIp, '127.0.0.1')
      const xplanePort = normalizeInteger(config.xplanePort, 49000)
      stdinLines.push(xplaneIp, String(xplanePort))
      hint = `${hint}, xplane=${xplaneIp}:${xplanePort}`
    } else {
      const mspPort = normalizeString(config.mspPort, '/dev/tty.usbserial')
      const mspBaud = normalizeInteger(config.mspBaud, 115200)
      stdinLines.push(mspPort, String(mspBaud))
      hint = `${hint}, msp=${mspPort}@${mspBaud}`
    }

    return {
      env: {},
      stdinInput: `${stdinLines.join('\n')}\n`,
      hint,
    }
  }

  if (project.id === 'navigation-display') {
    const mode = normalizeMode(config.mode, [1, 2, 3], 2)
    const layoutToken = normalizeString(config.layout, '1').toLowerCase()
    const layoutValue = ['2', 'center', 'minimal', 'no-panels'].includes(layoutToken) ? '2' : '1'

    const env = {
      NAVIGATION_DISPLAY_MODE: String(mode),
      NAVIGATION_DISPLAY_LAYOUT: layoutValue,
    }

    let hint = `mode=${mode}, layout=${layoutValue === '1' ? 'full' : 'center'}`

    if (mode === 2) {
      const xplaneIp = normalizeString(config.xplaneIp, '127.0.0.1')
      const xplanePort = normalizeInteger(config.xplanePort, 49000)
      const localPort = normalizeInteger(config.localPort, 49005)

      env.NAVIGATION_DISPLAY_XPLANE_IP = xplaneIp
      env.NAVIGATION_DISPLAY_XPLANE_PORT = String(xplanePort)
      env.NAVIGATION_DISPLAY_XPLANE_LOCAL_PORT = String(localPort)
      hint = `${hint}, xplane=${xplaneIp}:${xplanePort}, local=${localPort}`
    } else if (mode === 3) {
      const mspPort = normalizeString(config.mspPort, '/dev/tty.usbserial')
      const mspBaud = normalizeInteger(config.mspBaud, 115200)

      env.NAVIGATION_DISPLAY_MSP_PORT = mspPort
      env.NAVIGATION_DISPLAY_MSP_BAUDRATE = String(mspBaud)
      hint = `${hint}, msp=${mspPort}@${mspBaud}`
    }

    return {
      env,
      stdinInput: null,
      hint,
    }
  }

  return {
    env: {},
    stdinInput: null,
    hint: '',
  }
}

function getPackageManager(projectDir) {
  if (
    fsSync.existsSync(path.join(projectDir, 'bun.lockb')) ||
    fsSync.existsSync(path.join(projectDir, 'bun.lock'))
  ) {
    return 'bun'
  }

  if (fsSync.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) {
    return 'pnpm'
  }

  if (fsSync.existsSync(path.join(projectDir, 'yarn.lock'))) {
    return 'yarn'
  }

  return 'npm'
}

function getInstallCommand(manager) {
  if (manager === 'bun') {
    return { command: 'bun', args: ['install'] }
  }

  if (manager === 'pnpm') {
    return { command: 'pnpm', args: ['install'] }
  }

  if (manager === 'yarn') {
    return { command: 'yarn', args: ['install'] }
  }

  return { command: 'npm', args: ['install'] }
}

function getRunScriptCommand(manager, scriptName) {
  if (manager === 'bun') {
    return { command: 'bun', args: ['run', scriptName] }
  }

  if (manager === 'pnpm') {
    return { command: 'pnpm', args: ['run', scriptName] }
  }

  if (manager === 'yarn') {
    return { command: 'yarn', args: [scriptName] }
  }

  return { command: 'npm', args: ['run', scriptName] }
}

async function readPackageJson(projectDir) {
  const packageJsonPath = path.join(projectDir, 'package.json')

  if (!(await pathExists(packageJsonPath))) {
    return null
  }

  const rawContent = await fs.readFile(packageJsonPath, 'utf8')

  try {
    return JSON.parse(rawContent)
  } catch {
    throw new Error(`package.json invalide dans ${projectDir}`)
  }
}

async function runCommand({ command, args, cwd, projectId, projectName, logEmitter }) {
  const preview = [command, ...args].join(' ')
  emitLog(logEmitter, { level: 'command', projectId, message: `$ ${preview}` })

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env },
      shell: process.platform === 'win32',
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text

      parseChunkToLines(text).forEach((line) => {
        emitLog(logEmitter, {
          level: 'output',
          projectId,
          message: `${projectName}: ${line}`,
        })
      })
    })

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text

      parseChunkToLines(text).forEach((line) => {
        emitLog(logEmitter, {
          level: 'error-output',
          projectId,
          message: `${projectName}: ${line}`,
        })
      })
    })

    child.on('error', (error) => {
      reject(new Error(`Impossible d'exécuter "${preview}": ${error.message}`))
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }

      reject(new Error(`La commande "${preview}" a échoué avec le code ${code}.`))
    })
  })
}

async function detectInstallSteps(project, projectDir) {
  const steps = []
  const packageJson = await readPackageJson(projectDir)
  const pythonCommand = project.pythonCommand || 'python3'

  if (packageJson) {
    const manager = getPackageManager(projectDir)
    const installCommand = getInstallCommand(manager)

    steps.push({
      label: `Installer les dépendances JavaScript (${manager})`,
      command: installCommand.command,
      args: installCommand.args,
    })
  }

  if (await pathExists(path.join(projectDir, 'uv.lock'))) {
    steps.push({
      label: 'Installer les dépendances Python (uv sync)',
      command: 'uv',
      args: ['sync'],
    })
  } else if (await pathExists(path.join(projectDir, 'poetry.lock'))) {
    steps.push({
      label: 'Installer les dépendances Python (poetry install)',
      command: 'poetry',
      args: ['install'],
    })
  } else if (await pathExists(path.join(projectDir, 'Pipfile'))) {
    steps.push({
      label: 'Installer les dépendances Python (pipenv install)',
      command: 'pipenv',
      args: ['install'],
    })
  } else if (await pathExists(path.join(projectDir, 'requirements.txt'))) {
    steps.push({
      label: 'Installer les dépendances Python (pip requirements)',
      command: pythonCommand,
      args: [
        '-m',
        'pip',
        'install',
        '--user',
        '--break-system-packages',
        '-r',
        'requirements.txt',
      ],
    })
  }

  if (Array.isArray(project.extraInstallSteps)) {
    steps.push(...project.extraInstallSteps)
  }

  return steps
}

async function detectStartCommand(project, projectDir) {
  if (project.startCommand && Array.isArray(project.startCommand.args)) {
    return project.startCommand
  }

  const packageJson = await readPackageJson(projectDir)
  const pythonCommand = project.pythonCommand || 'python3'

  if (packageJson?.scripts) {
    const manager = getPackageManager(projectDir)

    for (const scriptName of SCRIPT_PRIORITY) {
      if (typeof packageJson.scripts[scriptName] === 'string') {
        const runScriptCommand = getRunScriptCommand(manager, scriptName)

        return {
          label: `Exécuter le script ${scriptName} (${manager})`,
          command: runScriptCommand.command,
          args: runScriptCommand.args,
        }
      }
    }
  }

  const pythonEntries = ['main.py', 'app.py', 'run.py', 'launcher.py']

  for (const entrypoint of pythonEntries) {
    if (await pathExists(path.join(projectDir, entrypoint))) {
      return {
        label: `Exécuter ${entrypoint} (${pythonCommand})`,
        command: pythonCommand,
        args: [entrypoint],
      }
    }
  }

  if (await pathExists(path.join(projectDir, 'run.sh'))) {
    return {
      label: 'Exécuter run.sh',
      command: 'sh',
      args: ['run.sh'],
    }
  }

  return null
}

async function ensureBaseDirectory(baseDir, logEmitter) {
  const resolved = normalizeBaseDir(baseDir)
  await fs.mkdir(resolved, { recursive: true })
  emitLog(logEmitter, { level: 'info', message: `Dossier prêt: ${resolved}` })
  return resolved
}

async function syncProject(baseDir, projectId, logEmitter) {
  const resolvedBaseDir = await ensureBaseDirectory(baseDir, logEmitter)
  const project = getProjectById(projectId)
  const projectDir = getProjectDir(resolvedBaseDir, project)
  const gitPath = path.join(projectDir, '.git')

  if (await pathExists(gitPath)) {
    emitLog(logEmitter, {
      level: 'info',
      projectId,
      message: `Mise à jour de ${project.name}`,
    })

    await runCommand({
      command: 'git',
      args: ['-C', projectDir, 'pull', '--ff-only'],
      cwd: resolvedBaseDir,
      projectId,
      projectName: project.name,
      logEmitter,
    })

    return {
      projectId,
      action: 'pulled',
      path: projectDir,
    }
  }

  emitLog(logEmitter, {
    level: 'info',
    projectId,
    message: `Clone de ${project.name}`,
  })

  await runCommand({
    command: 'git',
    args: ['clone', project.repo, projectDir],
    cwd: resolvedBaseDir,
    projectId,
    projectName: project.name,
    logEmitter,
  })

  return {
    projectId,
    action: 'cloned',
    path: projectDir,
  }
}

async function installProject(baseDir, projectId, logEmitter) {
  const resolvedBaseDir = normalizeBaseDir(baseDir)
  const project = getProjectById(projectId)
  const projectDir = getProjectDir(resolvedBaseDir, project)

  if (!(await pathExists(projectDir))) {
    throw new Error(
      `Le dossier ${project.directory} est introuvable. Lancez d'abord un pull/clone du projet.`,
    )
  }

  const steps = await detectInstallSteps(project, projectDir)

  if (steps.length === 0) {
    emitLog(logEmitter, {
      level: 'warning',
      projectId,
      message: `Aucune étape d'installation détectée pour ${project.name}`,
    })

    return {
      projectId,
      skipped: true,
      steps: [],
    }
  }

  for (const step of steps) {
    emitLog(logEmitter, { level: 'info', projectId, message: step.label })

    await runCommand({
      command: step.command,
      args: step.args,
      cwd: projectDir,
      projectId,
      projectName: project.name,
      logEmitter,
    })
  }

  return {
    projectId,
    skipped: false,
    steps: steps.map((step) => step.label),
  }
}

async function startProject(baseDir, projectId, logEmitter, statusEmitter, launchConfig) {
  const resolvedBaseDir = normalizeBaseDir(baseDir)
  const project = getProjectById(projectId)
  const projectDir = getProjectDir(resolvedBaseDir, project)

  if (!(await pathExists(projectDir))) {
    throw new Error(
      `Le dossier ${project.directory} est introuvable. Lancez d'abord un pull/clone du projet.`,
    )
  }

  if (RUNNING_PROCESSES.has(projectId)) {
    return {
      projectId,
      running: true,
      alreadyRunning: true,
    }
  }

  const startCommand = await detectStartCommand(project, projectDir)

  if (!startCommand) {
    throw new Error(
      `Aucune commande de lancement détectée pour ${project.name}. Ajoutez un script npm (start/dev) ou un fichier main.py/app.py.`,
    )
  }

  const launchOptions = buildLaunchOptions(project, launchConfig)
  const commandPreview = [startCommand.command, ...startCommand.args].join(' ')
  emitLog(logEmitter, {
    level: 'info',
    projectId,
    message: `Démarrage de ${project.name} avec: ${commandPreview}`,
  })

  if (launchOptions.hint.length > 0) {
    emitLog(logEmitter, {
      level: 'info',
      projectId,
      message: `Configuration de lancement: ${launchOptions.hint}`,
    })
  }

  const child = spawn(startCommand.command, startCommand.args, {
    cwd: projectDir,
    env: { ...process.env, ...launchOptions.env },
    shell: process.platform === 'win32',
  })

  if (typeof launchOptions.stdinInput === 'string' && launchOptions.stdinInput.length > 0) {
    try {
      child.stdin.write(launchOptions.stdinInput)
      child.stdin.end()
    } catch {
      emitLog(logEmitter, {
        level: 'warning',
        projectId,
        message: 'Impossible d\'écrire la configuration de mode sur stdin.',
      })
    }
  }

  child.stdout.on('data', (chunk) => {
    parseChunkToLines(chunk.toString()).forEach((line) => {
      emitLog(logEmitter, {
        level: 'runtime',
        projectId,
        message: `${project.name}: ${line}`,
      })
    })
  })

  child.stderr.on('data', (chunk) => {
    parseChunkToLines(chunk.toString()).forEach((line) => {
      emitLog(logEmitter, {
        level: 'error-output',
        projectId,
        message: `${project.name}: ${line}`,
      })
    })
  })

  child.on('error', (error) => {
    RUNNING_PROCESSES.delete(projectId)

    emitLog(logEmitter, {
      level: 'error',
      projectId,
      message: `Erreur au démarrage de ${project.name}: ${error.message}`,
    })

    emitStatus(statusEmitter)
  })

  child.on('close', (code, signal) => {
    RUNNING_PROCESSES.delete(projectId)

    const level = code === 0 || signal === 'SIGTERM' ? 'info' : 'error'

    emitLog(logEmitter, {
      level,
      projectId,
      message: `${project.name} arrêté (code=${code ?? 'null'}, signal=${signal ?? 'none'})`,
    })

    emitStatus(statusEmitter)
  })

  RUNNING_PROCESSES.set(projectId, {
    child,
    startedAt: nowIso(),
    command: commandPreview,
  })

  emitStatus(statusEmitter)

  return {
    projectId,
    running: true,
    command: commandPreview,
  }
}

function stopProject(projectId, logEmitter, statusEmitter) {
  const project = getProjectById(projectId)
  const running = RUNNING_PROCESSES.get(projectId)

  if (!running) {
    return {
      projectId,
      stopped: false,
      reason: 'not-running',
    }
  }

  running.child.kill('SIGTERM')

  emitLog(logEmitter, {
    level: 'info',
    projectId,
    message: `Demande d'arrêt envoyée à ${project.name}`,
  })

  setTimeout(() => {
    const stillRunning = RUNNING_PROCESSES.get(projectId)

    if (stillRunning) {
      stillRunning.child.kill('SIGKILL')

      emitLog(logEmitter, {
        level: 'warning',
        projectId,
        message: `Arrêt forcé de ${project.name}`,
      })
    }
  }, 5000)

  emitStatus(statusEmitter)

  return {
    projectId,
    stopped: true,
  }
}

async function syncAll(baseDir, logEmitter) {
  const resolvedBaseDir = await ensureBaseDirectory(baseDir, logEmitter)
  const results = []
  const errors = []

  for (const project of PROJECTS) {
    try {
      const result = await syncProject(resolvedBaseDir, project.id, logEmitter)
      results.push(result)
    } catch (error) {
      errors.push({ projectId: project.id, message: error.message })
      emitLog(logEmitter, {
        level: 'error',
        projectId: project.id,
        message: error.message,
      })
    }
  }

  return {
    baseDir: resolvedBaseDir,
    results,
    errors,
  }
}

async function installAll(baseDir, logEmitter) {
  const resolvedBaseDir = normalizeBaseDir(baseDir)
  const results = []
  const errors = []

  for (const project of PROJECTS) {
    try {
      const result = await installProject(resolvedBaseDir, project.id, logEmitter)
      results.push(result)
    } catch (error) {
      errors.push({ projectId: project.id, message: error.message })
      emitLog(logEmitter, {
        level: 'error',
        projectId: project.id,
        message: error.message,
      })
    }
  }

  return {
    baseDir: resolvedBaseDir,
    results,
    errors,
  }
}

async function setupAll(baseDir, logEmitter) {
  const resolvedBaseDir = await ensureBaseDirectory(baseDir, logEmitter)
  const sync = await syncAll(resolvedBaseDir, logEmitter)
  const install = await installAll(resolvedBaseDir, logEmitter)

  return {
    baseDir: resolvedBaseDir,
    sync,
    install,
  }
}

async function launchAll(baseDir, logEmitter, statusEmitter, launchConfig) {
  const resolvedBaseDir = normalizeBaseDir(baseDir)
  const results = []
  const errors = []

  for (const project of PROJECTS) {
    try {
      const result = await startProject(
        resolvedBaseDir,
        project.id,
        logEmitter,
        statusEmitter,
        launchConfig,
      )
      results.push(result)
    } catch (error) {
      errors.push({ projectId: project.id, message: error.message })
      emitLog(logEmitter, {
        level: 'error',
        projectId: project.id,
        message: error.message,
      })
    }
  }

  emitStatus(statusEmitter)

  return {
    baseDir: resolvedBaseDir,
    results,
    errors,
    statuses: getRuntimeStatus(),
  }
}

function stopAll(logEmitter, statusEmitter) {
  const results = PROJECTS.map((project) => stopProject(project.id, logEmitter, statusEmitter))
  emitStatus(statusEmitter)

  return {
    results,
    statuses: getRuntimeStatus(),
  }
}

function shutdown(logEmitter, statusEmitter) {
  for (const [projectId, running] of RUNNING_PROCESSES.entries()) {
    const project = getProjectById(projectId)

    try {
      running.child.kill('SIGTERM')
    } catch {
      emitLog(logEmitter, {
        level: 'warning',
        projectId,
        message: `Impossible de terminer ${project.name} proprement`,
      })
    }
  }

  RUNNING_PROCESSES.clear()
  emitStatus(statusEmitter)
}

function getRuntimeStatus() {
  return PROJECTS.map((project) => ({
    id: project.id,
    running: RUNNING_PROCESSES.has(project.id),
  }))
}

function getProjects(baseDir) {
  const resolvedBaseDir = normalizeBaseDir(baseDir)

  return PROJECTS.map((project) => ({
    ...project,
    path: getProjectDir(resolvedBaseDir, project),
  }))
}

module.exports = {
  getDefaultBaseDir,
  normalizeBaseDir,
  getProjects,
  getRuntimeStatus,
  syncProject,
  installProject,
  startProject,
  stopProject,
  syncAll,
  installAll,
  setupAll,
  launchAll,
  stopAll,
  shutdown,
}