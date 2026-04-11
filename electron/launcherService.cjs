const fs = require('fs/promises')
const fsSync = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const PROJECTS_CONFIG_PATH = path.join(__dirname, '..', 'config', 'projects.json')
const SCENARIOS_CONFIG_PATH = path.join(__dirname, '..', 'config', 'scenarios.json')

const SCRIPT_PRIORITY = ['start', 'dev', 'launch', 'serve']
const RUNNING_PROCESSES = new Map()
const PROJECT_STATES = new Map()

const PROJECTS_CONFIG = readJsonConfig(PROJECTS_CONFIG_PATH, { defaults: {}, projects: [] })
const SCENARIOS_CONFIG = readJsonConfig(SCENARIOS_CONFIG_PATH, { scenarios: [] })

const CONFIG_DEFAULTS = {
  pythonCommand: 'python3.13',
  launchStableAfterMs: 7000,
  launchTimeoutMs: 20000,
  maxRestartAttempts: 1,
  restartDelayMs: 2500,
  ...PROJECTS_CONFIG.defaults,
}

const PROJECTS = Array.isArray(PROJECTS_CONFIG.projects) ? PROJECTS_CONFIG.projects : []
const SCENARIOS = Array.isArray(SCENARIOS_CONFIG.scenarios) ? SCENARIOS_CONFIG.scenarios : []

function readJsonConfig(filePath, fallback) {
  try {
    const raw = fsSync.readFileSync(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function nowIso() {
  return new Date().toISOString()
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value), 10)

  if (!Number.isFinite(parsed)) {
    return { value: fallback, valid: false }
  }

  return {
    value: parsed,
    valid: isValidPort(parsed),
  }
}

function isLikelyLocalHost(host) {
  if (typeof host !== 'string') {
    return false
  }

  const normalized = host.trim().toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '0.0.0.0' || normalized === '::1'
}

function isWindowsComPort(portName) {
  return typeof portName === 'string' && /^COM\d+$/i.test(portName.trim())
}

function firstLine(text) {
  if (typeof text !== 'string') {
    return ''
  }

  const line = text.replace(/\r/g, '').split('\n').find((item) => item.trim().length > 0)
  return line ? line.trim() : ''
}

function parseChunkToLines(chunk) {
  return chunk
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

function getDefaultBaseDir() {
  return path.join(os.homedir(), 'GEII-ESA-2026-Simulateur')
}

function normalizeBaseDir(input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return getDefaultBaseDir()
  }

  return path.resolve(input.trim())
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

function ensureProjectStates() {
  for (const project of PROJECTS) {
    if (!PROJECT_STATES.has(project.id)) {
      PROJECT_STATES.set(project.id, {
        id: project.id,
        state: 'stopped',
        running: false,
        message: 'En attente',
        attempt: 0,
        updatedAt: nowIso(),
        lastExitCode: null,
        lastSignal: null,
      })
    }
  }
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

function setProjectState(projectId, patch, statusEmitter) {
  ensureProjectStates()

  const current = PROJECT_STATES.get(projectId) || {}
  const inferredRunning = RUNNING_PROCESSES.has(projectId)

  const next = {
    id: projectId,
    state: patch.state || current.state || 'stopped',
    message: patch.message ?? current.message ?? 'En attente',
    running: patch.running ?? inferredRunning,
    attempt: patch.attempt ?? current.attempt ?? 0,
    lastExitCode: patch.lastExitCode ?? current.lastExitCode ?? null,
    lastSignal: patch.lastSignal ?? current.lastSignal ?? null,
    updatedAt: nowIso(),
  }

  PROJECT_STATES.set(projectId, next)
  emitStatus(statusEmitter)

  return next
}

function getRuntimeStatus() {
  ensureProjectStates()

  return PROJECTS.map((project) => {
    const current = PROJECT_STATES.get(project.id) || {}
    const running = RUNNING_PROCESSES.has(project.id) || Boolean(current.running)

    return {
      id: project.id,
      state: current.state || (running ? 'active' : 'stopped'),
      running,
      message: current.message || '',
      attempt: current.attempt || 0,
      updatedAt: current.updatedAt || nowIso(),
      lastExitCode: current.lastExitCode ?? null,
      lastSignal: current.lastSignal ?? null,
    }
  })
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

function getProjects(baseDir) {
  const resolvedBaseDir = normalizeBaseDir(baseDir)

  return PROJECTS.map((project) => ({
    id: project.id,
    name: project.name,
    directory: project.directory,
    repo: project.repo,
    path: getProjectDir(resolvedBaseDir, project),
    dependsOn: Array.isArray(project.dependsOn) ? project.dependsOn : [],
    stopPriority: normalizeInteger(project.stopPriority, 0),
  }))
}

function mergeLaunchConfig(baseConfig, overrideConfig) {
  const base = baseConfig && typeof baseConfig === 'object' ? baseConfig : {}
  const override = overrideConfig && typeof overrideConfig === 'object' ? overrideConfig : {}
  const merged = { ...base }

  for (const [projectId, values] of Object.entries(override)) {
    merged[projectId] = {
      ...(base[projectId] || {}),
      ...(values || {}),
    }
  }

  return merged
}

function buildLaunchOptions(project, launchConfig) {
  const config =
    launchConfig && typeof launchConfig === 'object' ? launchConfig[project.id] || {} : {}

  if (project.id === 'primary-flight-display') {
    const mode = normalizeMode(config.mode, [1, 2, 3], 2)
    const stdinLines = [String(mode)]
    let hint = `mode=${mode}`

    const runtime = { mode }

    if (mode === 1) {
      const joystickName = normalizeString(config.joystickName, 'X52')
      stdinLines.push(joystickName)
      hint = `${hint}, joystick=${joystickName}`
      runtime.joystickName = joystickName
    } else if (mode === 2) {
      const xplaneIp = normalizeString(config.xplaneIp, '127.0.0.1')
      const xplanePort = normalizeInteger(config.xplanePort, 49000)
      stdinLines.push(xplaneIp, String(xplanePort))
      hint = `${hint}, xplane=${xplaneIp}:${xplanePort}`
      runtime.xplaneIp = xplaneIp
      runtime.xplanePort = xplanePort
    } else {
      const mspPort = normalizeString(config.mspPort, '/dev/tty.usbserial')
      const mspBaud = normalizeInteger(config.mspBaud, 115200)
      stdinLines.push(mspPort, String(mspBaud))
      hint = `${hint}, msp=${mspPort}@${mspBaud}`
      runtime.mspPort = mspPort
      runtime.mspBaud = mspBaud
    }

    return {
      env: {},
      stdinInput: `${stdinLines.join('\n')}\n`,
      hint,
      runtime,
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

    const runtime = {
      mode,
      layout: layoutValue,
    }

    let hint = `mode=${mode}, layout=${layoutValue === '1' ? 'full' : 'center'}`

    if (mode === 2) {
      const xplaneIp = normalizeString(config.xplaneIp, '127.0.0.1')
      const xplanePort = normalizeInteger(config.xplanePort, 49000)
      const localPort = normalizeInteger(config.localPort, 49005)

      env.NAVIGATION_DISPLAY_XPLANE_IP = xplaneIp
      env.NAVIGATION_DISPLAY_XPLANE_PORT = String(xplanePort)
      env.NAVIGATION_DISPLAY_XPLANE_LOCAL_PORT = String(localPort)

      runtime.xplaneIp = xplaneIp
      runtime.xplanePort = xplanePort
      runtime.localPort = localPort

      hint = `${hint}, xplane=${xplaneIp}:${xplanePort}, local=${localPort}`
    } else if (mode === 3) {
      const mspPort = normalizeString(config.mspPort, '/dev/tty.usbserial')
      const mspBaud = normalizeInteger(config.mspBaud, 115200)

      env.NAVIGATION_DISPLAY_MSP_PORT = mspPort
      env.NAVIGATION_DISPLAY_MSP_BAUDRATE = String(mspBaud)

      runtime.mspPort = mspPort
      runtime.mspBaud = mspBaud

      hint = `${hint}, msp=${mspPort}@${mspBaud}`
    }

    return {
      env,
      stdinInput: null,
      hint,
      runtime,
    }
  }

  return {
    env: {},
    stdinInput: null,
    hint: '',
    runtime: {},
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

function commandExists(command) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return Promise.resolve(false)
  }

  return new Promise((resolve) => {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
    const child = spawn(lookupCommand, [command], {
      stdio: 'ignore',
      shell: false,
    })

    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

async function runCommandCapture({ command, args, cwd, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: process.platform === 'win32',
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', (error) => {
      resolve({ ok: false, code: null, stdout, stderr, error })
    })

    child.on('close', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr, error: null })
    })
  })
}

async function runCommand({
  command,
  args,
  cwd,
  projectId,
  projectName,
  logEmitter,
  env = {},
  stdinInput,
}) {
  const preview = [command, ...args].join(' ')
  emitLog(logEmitter, { level: 'command', projectId, message: `$ ${preview}` })

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: process.platform === 'win32',
    })

    let stdout = ''
    let stderr = ''

    if (typeof stdinInput === 'string' && stdinInput.length > 0) {
      try {
        child.stdin.write(stdinInput)
        child.stdin.end()
      } catch {
        emitLog(logEmitter, {
          level: 'warning',
          projectId,
          message: `${projectName}: impossible d'envoyer le stdin demandé`,
        })
      }
    }

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

async function detectInstallSteps(project, projectDir) {
  const steps = []
  const packageJson = await readPackageJson(projectDir)
  const pythonCommand = project.pythonCommand || CONFIG_DEFAULTS.pythonCommand

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
    steps.push({ label: 'Installer les dépendances Python (uv sync)', command: 'uv', args: ['sync'] })
  } else if (await pathExists(path.join(projectDir, 'poetry.lock'))) {
    steps.push({ label: 'Installer les dépendances Python (poetry install)', command: 'poetry', args: ['install'] })
  } else if (await pathExists(path.join(projectDir, 'Pipfile'))) {
    steps.push({ label: 'Installer les dépendances Python (pipenv install)', command: 'pipenv', args: ['install'] })
  } else if (await pathExists(path.join(projectDir, 'requirements.txt'))) {
    steps.push({
      label: 'Installer les dépendances Python (pip requirements)',
      command: pythonCommand,
      args: ['-m', 'pip', 'install', '--user', '--break-system-packages', '-r', 'requirements.txt'],
    })
  }

  if (Array.isArray(project.extraInstallSteps)) {
    for (const step of project.extraInstallSteps) {
      if (step && typeof step.command === 'string' && Array.isArray(step.args)) {
        steps.push({
          label: step.label || `Installer dépendances supplémentaires (${project.name})`,
          command: step.command,
          args: step.args,
        })
      }
    }
  }

  return steps
}

async function detectStartCommand(project, projectDir) {
  if (
    project.startCommand &&
    typeof project.startCommand.command === 'string' &&
    Array.isArray(project.startCommand.args)
  ) {
    return project.startCommand
  }

  const packageJson = await readPackageJson(projectDir)
  const pythonCommand = project.pythonCommand || CONFIG_DEFAULTS.pythonCommand

  if (packageJson?.scripts) {
    const manager = getPackageManager(projectDir)

    for (const scriptName of SCRIPT_PRIORITY) {
      if (typeof packageJson.scripts[scriptName] === 'string') {
        const runScriptCommand = getRunScriptCommand(manager, scriptName)

        return {
          label: `Exécuter le script ${scriptName} (${manager})`,
          command: runScriptCommand.command,
          args: runScriptCommand.args,
          persistent: true,
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
        persistent: true,
      }
    }
  }

  if (await pathExists(path.join(projectDir, 'run.sh'))) {
    return {
      label: 'Exécuter run.sh',
      command: 'sh',
      args: ['run.sh'],
      persistent: true,
    }
  }

  return null
}

async function checkUdpPortInUse(port) {
  if (!isValidPort(port) || process.platform === 'win32') {
    return null
  }

  const result = await runCommandCapture({
    command: 'sh',
    args: ['-lc', `lsof -nP -iUDP:${port}`],
    cwd: process.cwd(),
  })

  if (!result.ok && result.code === 127) {
    return null
  }

  if (!result.ok) {
    return false
  }

  return result.stdout.trim().length > 0
}

function summarizeChecks(checks) {
  const summary = { pass: 0, warn: 0, fail: 0 }

  for (const check of checks) {
    if (check.status === 'pass') {
      summary.pass += 1
    } else if (check.status === 'warn') {
      summary.warn += 1
    } else {
      summary.fail += 1
    }
  }

  return summary
}

function inferReportStatus(summary) {
  if (summary.fail > 0) {
    return 'fail'
  }

  if (summary.warn > 0) {
    return 'warn'
  }

  return 'pass'
}

async function runProjectDiagnostics(baseDir, projectId, launchConfig) {
  const resolvedBaseDir = normalizeBaseDir(baseDir)
  const project = getProjectById(projectId)
  const projectDir = getProjectDir(resolvedBaseDir, project)
  const launchOptions = buildLaunchOptions(project, launchConfig)
  const checks = []

  const addCheck = (code, label, status, details) => {
    checks.push({ code, label, status, details })
  }

  const projectExists = await pathExists(projectDir)
  if (projectExists) {
    addCheck('project-dir', 'Dossier du projet', 'pass', projectDir)
  } else {
    addCheck('project-dir', 'Dossier du projet', 'fail', `${projectDir} introuvable`)
  }

  let startCommand = null
  try {
    startCommand = await detectStartCommand(project, projectDir)
  } catch (error) {
    addCheck('start-command', 'Commande de lancement', 'fail', error.message)
  }

  if (!startCommand) {
    addCheck(
      'start-command',
      'Commande de lancement',
      'fail',
      'Aucune commande détectée (script start/dev ou fichier main.py/app.py)',
    )
  } else {
    const exists = await commandExists(startCommand.command)
    addCheck(
      'start-command',
      'Binaire de lancement',
      exists ? 'pass' : 'fail',
      exists ? `${startCommand.command} disponible` : `${startCommand.command} introuvable dans PATH`,
    )
  }

  const pythonCommand = project.pythonCommand || CONFIG_DEFAULTS.pythonCommand
  const requiredImports = Array.isArray(project.requiredImports) ? project.requiredImports : []

  const requiresPythonCheck =
    typeof project.pythonCommand === 'string' ||
    requiredImports.length > 0 ||
    (startCommand && startCommand.command.startsWith('python'))

  let pythonAvailable = true

  if (requiresPythonCheck) {
    pythonAvailable = await commandExists(pythonCommand)
    addCheck(
      'python-command',
      'Interpréteur Python',
      pythonAvailable ? 'pass' : 'fail',
      pythonAvailable ? `${pythonCommand} disponible` : `${pythonCommand} introuvable dans PATH`,
    )
  }

  const requiredFiles = new Set(Array.isArray(project.requiredFiles) ? project.requiredFiles : [])

  if (startCommand && Array.isArray(startCommand.args) && startCommand.args.length > 0) {
    const firstArg = startCommand.args[0]
    if (typeof firstArg === 'string' && !firstArg.startsWith('-') && !firstArg.includes('://')) {
      if (firstArg.endsWith('.py') || firstArg.endsWith('.html') || firstArg.endsWith('.txt')) {
        requiredFiles.add(firstArg)
      }
    }
  }

  for (const relativeFile of requiredFiles) {
    const candidate = path.join(projectDir, relativeFile)
    const exists = await pathExists(candidate)
    addCheck(
      `required-file:${relativeFile}`,
      `Fichier requis: ${relativeFile}`,
      exists ? 'pass' : 'fail',
      exists ? 'présent' : 'absent',
    )
  }

  if (requiredImports.length > 0 && pythonAvailable && projectExists) {
    const importScript = `import ${requiredImports.join(',')}`
    const result = await runCommandCapture({
      command: pythonCommand,
      args: ['-c', importScript],
      cwd: projectDir,
    })

    addCheck(
      'python-imports',
      'Imports Python requis',
      result.ok ? 'pass' : 'fail',
      result.ok
        ? requiredImports.join(', ')
        : firstLine(result.stderr) || firstLine(result.stdout) || 'import impossible',
    )
  }

  const runtime = launchOptions.runtime || {}

  if (runtime.mode === 2) {
    const ip = normalizeString(runtime.xplaneIp, '')
    const parsedPort = parsePort(runtime.xplanePort, 49000)

    addCheck('xplane-host', 'Hôte X-Plane', ip.length > 0 ? 'pass' : 'fail', ip.length > 0 ? ip : 'ip vide')

    addCheck(
      'xplane-port',
      'Port X-Plane',
      parsedPort.valid ? 'pass' : 'fail',
      parsedPort.valid ? String(parsedPort.value) : `port invalide: ${runtime.xplanePort}`,
    )

    if (ip.length > 0 && parsedPort.valid) {
      if (isLikelyLocalHost(ip)) {
        const inUse = await checkUdpPortInUse(parsedPort.value)

        if (inUse === true) {
          addCheck(
            'xplane-local-udp',
            'X-Plane local (UDP)',
            'pass',
            `service local détecté sur UDP ${parsedPort.value}`,
          )
        } else if (inUse === false) {
          addCheck(
            'xplane-local-udp',
            'X-Plane local (UDP)',
            'warn',
            `aucun service détecté sur UDP ${parsedPort.value}`,
          )
        } else {
          addCheck(
            'xplane-local-udp',
            'X-Plane local (UDP)',
            'warn',
            'impossible de vérifier le port UDP local',
          )
        }
      } else {
        addCheck(
          'xplane-remote-reachability',
          'X-Plane distant',
          'warn',
          `reachability distante non vérifiable automatiquement (${ip}:${parsedPort.value})`,
        )
      }
    }
  }

  if (runtime.mode === 3) {
    const mspPort = normalizeString(runtime.mspPort, '')

    if (mspPort.length === 0) {
      addCheck('serial-port', 'Port série MSP', 'fail', 'port MSP vide')
    } else if (isWindowsComPort(mspPort)) {
      addCheck('serial-port', 'Port série MSP', 'warn', `${mspPort} (vérification fichier ignorée sous Windows)`)
    } else {
      const exists = await pathExists(mspPort)
      addCheck(
        'serial-port',
        'Port série MSP',
        exists ? 'pass' : 'fail',
        exists ? `${mspPort} disponible` : `${mspPort} introuvable`,
      )
    }
  }

  const summary = summarizeChecks(checks)

  return {
    projectId: project.id,
    projectName: project.name,
    projectPath: projectDir,
    status: inferReportStatus(summary),
    summary,
    checks,
    runtime,
  }
}

function applyDiagnosticsState(report, statusEmitter) {
  if (RUNNING_PROCESSES.has(report.projectId)) {
    return
  }

  const firstFail = report.checks.find((check) => check.status === 'fail')
  const firstWarn = report.checks.find((check) => check.status === 'warn')

  if (report.status === 'fail') {
    setProjectState(
      report.projectId,
      {
        state: 'deps-missing',
        running: false,
        message: firstFail ? `${firstFail.label}: ${firstFail.details}` : 'Dépendances manquantes',
      },
      statusEmitter,
    )
    return
  }

  setProjectState(
    report.projectId,
    {
      state: 'ready',
      running: false,
      message: firstWarn ? `Prêt (attention: ${firstWarn.details})` : 'Prêt',
    },
    statusEmitter,
  )
}

async function runGlobalChecks(baseDir) {
  const resolvedBaseDir = normalizeBaseDir(baseDir)
  const checks = []

  const addCheck = (code, label, status, details) => {
    checks.push({ code, label, status, details })
  }

  try {
    await fs.mkdir(resolvedBaseDir, { recursive: true })
    addCheck('base-dir', 'Dossier racine', 'pass', resolvedBaseDir)
  } catch (error) {
    addCheck('base-dir', 'Dossier racine', 'fail', error.message)
  }

  const gitAvailable = await commandExists('git')
  addCheck('git', 'Binaire git', gitAvailable ? 'pass' : 'fail', gitAvailable ? 'git disponible' : 'git introuvable dans PATH')

  const nodeAvailable = await commandExists('node')
  addCheck('node', 'Binaire node', nodeAvailable ? 'pass' : 'fail', nodeAvailable ? 'node disponible' : 'node introuvable dans PATH')

  const pythonCheck = await commandExists(CONFIG_DEFAULTS.pythonCommand)
  addCheck(
    'python-default',
    'Python par défaut',
    pythonCheck ? 'pass' : 'warn',
    pythonCheck
      ? `${CONFIG_DEFAULTS.pythonCommand} disponible`
      : `${CONFIG_DEFAULTS.pythonCommand} absent, certains modules peuvent échouer`,
  )

  const summary = summarizeChecks(checks)

  return {
    status: inferReportStatus(summary),
    summary,
    checks,
  }
}

function summarizeProjectReports(reports) {
  const summary = {
    projectPass: 0,
    projectWarn: 0,
    projectFail: 0,
    checksPass: 0,
    checksWarn: 0,
    checksFail: 0,
  }

  for (const report of reports) {
    if (report.status === 'pass') {
      summary.projectPass += 1
    } else if (report.status === 'warn') {
      summary.projectWarn += 1
    } else {
      summary.projectFail += 1
    }

    summary.checksPass += report.summary.pass
    summary.checksWarn += report.summary.warn
    summary.checksFail += report.summary.fail
  }

  return summary
}

async function runDiagnostics(baseDir, launchConfig, statusEmitter) {
  const resolvedBaseDir = normalizeBaseDir(baseDir)
  ensureProjectStates()

  const reports = []

  for (const project of PROJECTS) {
    const report = await runProjectDiagnostics(resolvedBaseDir, project.id, launchConfig)
    reports.push(report)
    applyDiagnosticsState(report, statusEmitter)
  }

  return {
    generatedAt: nowIso(),
    baseDir: resolvedBaseDir,
    reports,
    summary: summarizeProjectReports(reports),
  }
}

async function runAutotest(baseDir, launchConfig, statusEmitter) {
  const diagnostics = await runDiagnostics(baseDir, launchConfig, statusEmitter)
  const global = await runGlobalChecks(baseDir)

  return {
    ...diagnostics,
    global,
    verdict:
      diagnostics.summary.projectFail > 0 || global.summary.fail > 0
        ? 'fail'
        : diagnostics.summary.projectWarn > 0 || global.summary.warn > 0
          ? 'warn'
          : 'pass',
  }
}

async function exportLogs(baseDir, logs) {
  const resolvedBaseDir = normalizeBaseDir(baseDir)
  const outputDir = path.join(resolvedBaseDir, 'launcher-logs')
  await fs.mkdir(outputDir, { recursive: true })

  const sanitizedLogs = Array.isArray(logs) ? logs : []
  const timestamp = new Date().toISOString().replace(/[.:]/g, '-')
  const outputPath = path.join(outputDir, `launcher-${timestamp}.log`)

  const content = sanitizedLogs
    .map((entry) => {
      const time = entry?.timestamp || nowIso()
      const level = entry?.level || 'info'
      const source = entry?.projectId || 'GLOBAL'
      const message = entry?.message || ''
      return `[${time}] [${level}] [${source}] ${message}`
    })
    .join('\n')

  await fs.writeFile(outputPath, `${content}\n`, 'utf8')

  return {
    path: outputPath,
    count: sanitizedLogs.length,
  }
}

async function ensureBaseDirectory(baseDir, logEmitter) {
  const resolved = normalizeBaseDir(baseDir)
  await fs.mkdir(resolved, { recursive: true })
  emitLog(logEmitter, { level: 'info', message: `Dossier prêt: ${resolved}` })
  return resolved
}

async function syncProject(baseDir, projectId, logEmitter, statusEmitter) {
  const resolvedBaseDir = await ensureBaseDirectory(baseDir, logEmitter)
  const project = getProjectById(projectId)
  const projectDir = getProjectDir(resolvedBaseDir, project)
  const gitPath = path.join(projectDir, '.git')

  setProjectState(projectId, { state: 'checking', running: false, message: 'Synchronisation en cours' }, statusEmitter)

  if (await pathExists(gitPath)) {
    emitLog(logEmitter, { level: 'info', projectId, message: `Mise à jour de ${project.name}` })

    await runCommand({
      command: 'git',
      args: ['-C', projectDir, 'pull', '--ff-only'],
      cwd: resolvedBaseDir,
      projectId,
      projectName: project.name,
      logEmitter,
    })

    setProjectState(projectId, { state: 'ready', running: false, message: 'Synchronisé' }, statusEmitter)

    return {
      projectId,
      action: 'pulled',
      path: projectDir,
    }
  }

  emitLog(logEmitter, { level: 'info', projectId, message: `Clone de ${project.name}` })

  await runCommand({
    command: 'git',
    args: ['clone', project.repo, projectDir],
    cwd: resolvedBaseDir,
    projectId,
    projectName: project.name,
    logEmitter,
  })

  setProjectState(projectId, { state: 'ready', running: false, message: 'Cloné' }, statusEmitter)

  return {
    projectId,
    action: 'cloned',
    path: projectDir,
  }
}

async function installProject(baseDir, projectId, logEmitter, statusEmitter) {
  const resolvedBaseDir = normalizeBaseDir(baseDir)
  const project = getProjectById(projectId)
  const projectDir = getProjectDir(resolvedBaseDir, project)

  if (!(await pathExists(projectDir))) {
    throw new Error(`Le dossier ${project.directory} est introuvable. Lancez d'abord un pull/clone du projet.`)
  }

  const steps = await detectInstallSteps(project, projectDir)

  if (steps.length === 0) {
    emitLog(logEmitter, { level: 'warning', projectId, message: `Aucune étape d'installation détectée pour ${project.name}` })
    setProjectState(projectId, { state: 'ready', running: false, message: 'Aucune installation requise' }, statusEmitter)
    return {
      projectId,
      skipped: true,
      steps: [],
    }
  }

  setProjectState(projectId, { state: 'checking', running: false, message: 'Installation des dépendances' }, statusEmitter)

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

  setProjectState(projectId, { state: 'ready', running: false, message: 'Dépendances installées' }, statusEmitter)

  return {
    projectId,
    skipped: false,
    steps: steps.map((step) => step.label),
  }
}

function clearRuntimeTimers(runtime) {
  if (runtime.stableTimer) {
    clearTimeout(runtime.stableTimer)
  }

  if (runtime.timeoutTimer) {
    clearTimeout(runtime.timeoutTimer)
  }
}

function resolveLaunchPolicy(project, startCommand) {
  const source = project.launchPolicy || {}

  return {
    stableAfterMs: normalizeInteger(startCommand.stableAfterMs, normalizeInteger(source.stableAfterMs, CONFIG_DEFAULTS.launchStableAfterMs)),
    timeoutMs: normalizeInteger(startCommand.timeoutMs, normalizeInteger(source.timeoutMs, CONFIG_DEFAULTS.launchTimeoutMs)),
    maxRestartAttempts: normalizeInteger(startCommand.maxRestartAttempts, normalizeInteger(source.maxRestartAttempts, CONFIG_DEFAULTS.maxRestartAttempts)),
    restartDelayMs: normalizeInteger(startCommand.restartDelayMs, normalizeInteger(source.restartDelayMs, CONFIG_DEFAULTS.restartDelayMs)),
  }
}

function scheduleRestart(runtime, reason) {
  if (runtime.attempt >= runtime.policy.maxRestartAttempts) {
    return false
  }

  const nextAttempt = runtime.attempt + 1

  emitLog(runtime.logEmitter, {
    level: 'warning',
    projectId: runtime.project.id,
    message: `Redémarrage automatique (${nextAttempt}/${runtime.policy.maxRestartAttempts}) après ${reason}`,
  })

  setProjectState(
    runtime.project.id,
    {
      state: 'launching',
      running: true,
      attempt: nextAttempt,
      message: `Redémarrage en attente (${nextAttempt}/${runtime.policy.maxRestartAttempts + 1})`,
    },
    runtime.statusEmitter,
  )

  setTimeout(() => {
    if (RUNNING_PROCESSES.has(runtime.project.id)) {
      return
    }

    spawnManagedProcess({
      project: runtime.project,
      projectDir: runtime.projectDir,
      startCommand: runtime.startCommand,
      launchOptions: runtime.launchOptions,
      policy: runtime.policy,
      attempt: nextAttempt,
      logEmitter: runtime.logEmitter,
      statusEmitter: runtime.statusEmitter,
    })
  }, runtime.policy.restartDelayMs)

  return true
}

function spawnManagedProcess(context) {
  const { project, projectDir, startCommand, launchOptions, policy, attempt, logEmitter, statusEmitter } = context
  const commandPreview = [startCommand.command, ...startCommand.args].join(' ')

  const child = spawn(startCommand.command, startCommand.args, {
    cwd: projectDir,
    env: { ...process.env, ...(launchOptions.env || {}) },
    shell: process.platform === 'win32',
  })

  const runtime = {
    ...context,
    child,
    stable: false,
    stopping: false,
    timeoutTriggered: false,
    stableTimer: null,
    timeoutTimer: null,
  }

  RUNNING_PROCESSES.set(project.id, runtime)

  setProjectState(
    project.id,
    {
      state: 'launching',
      running: true,
      attempt,
      message: `Lancement (${attempt + 1}/${policy.maxRestartAttempts + 1})`,
    },
    statusEmitter,
  )

  if (typeof launchOptions.stdinInput === 'string' && launchOptions.stdinInput.length > 0) {
    try {
      child.stdin.write(launchOptions.stdinInput)
      child.stdin.end()
    } catch {
      emitLog(logEmitter, { level: 'warning', projectId: project.id, message: `Impossible d'écrire le stdin de ${project.name}` })
    }
  }

  child.stdout.on('data', (chunk) => {
    parseChunkToLines(chunk.toString()).forEach((line) => {
      emitLog(logEmitter, { level: 'runtime', projectId: project.id, message: `${project.name}: ${line}` })
    })
  })

  child.stderr.on('data', (chunk) => {
    parseChunkToLines(chunk.toString()).forEach((line) => {
      emitLog(logEmitter, { level: 'error-output', projectId: project.id, message: `${project.name}: ${line}` })
    })
  })

  runtime.stableTimer = setTimeout(() => {
    const activeRuntime = RUNNING_PROCESSES.get(project.id)

    if (!activeRuntime || activeRuntime !== runtime || runtime.stopping) {
      return
    }

    runtime.stable = true

    setProjectState(
      project.id,
      {
        state: 'active',
        running: true,
        attempt,
        message: `Actif (${commandPreview})`,
      },
      statusEmitter,
    )
  }, policy.stableAfterMs)

  runtime.timeoutTimer = setTimeout(() => {
    const activeRuntime = RUNNING_PROCESSES.get(project.id)

    if (!activeRuntime || activeRuntime !== runtime || runtime.stable || runtime.stopping) {
      return
    }

    runtime.timeoutTriggered = true

    emitLog(logEmitter, {
      level: 'error',
      projectId: project.id,
      message: `${project.name}: timeout de démarrage (${policy.timeoutMs} ms)`,
    })

    setProjectState(
      project.id,
      {
        state: 'timeout',
        running: true,
        attempt,
        message: `Timeout démarrage (${policy.timeoutMs} ms)`,
      },
      statusEmitter,
    )

    try {
      runtime.child.kill('SIGTERM')
    } catch {
      // ignore
    }

    setTimeout(() => {
      const pendingRuntime = RUNNING_PROCESSES.get(project.id)
      if (pendingRuntime && pendingRuntime === runtime) {
        try {
          runtime.child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
    }, 2000)
  }, policy.timeoutMs)

  child.on('error', (error) => {
    clearRuntimeTimers(runtime)

    if (RUNNING_PROCESSES.get(project.id) === runtime) {
      RUNNING_PROCESSES.delete(project.id)
    }

    emitLog(logEmitter, {
      level: 'error',
      projectId: project.id,
      message: `Erreur au démarrage de ${project.name}: ${error.message}`,
    })

    const restarted = scheduleRestart(runtime, 'erreur de spawn')

    if (!restarted) {
      setProjectState(
        project.id,
        {
          state: 'error',
          running: false,
          attempt,
          message: `Erreur de démarrage: ${error.message}`,
        },
        statusEmitter,
      )
    }
  })

  child.on('close', (code, signal) => {
    clearRuntimeTimers(runtime)

    if (RUNNING_PROCESSES.get(project.id) === runtime) {
      RUNNING_PROCESSES.delete(project.id)
    }

    const crash = code !== 0 && signal !== 'SIGTERM'
    const exitedEarly = !runtime.stable

    if (runtime.stopping) {
      setProjectState(
        project.id,
        {
          state: 'stopped',
          running: false,
          attempt,
          lastExitCode: code,
          lastSignal: signal,
          message: `${project.name} arrêté`,
        },
        statusEmitter,
      )
      return
    }

    if (runtime.timeoutTriggered) {
      const restarted = scheduleRestart(runtime, 'timeout de démarrage')

      if (!restarted) {
        setProjectState(
          project.id,
          {
            state: 'timeout',
            running: false,
            attempt,
            lastExitCode: code,
            lastSignal: signal,
            message: `${project.name} stoppé après timeout`,
          },
          statusEmitter,
        )
      }

      return
    }

    if (crash || exitedEarly) {
      const reason = crash
        ? `crash (code=${code ?? 'null'}, signal=${signal ?? 'none'})`
        : `arrêt prématuré (code=${code ?? 'null'}, signal=${signal ?? 'none'})`

      const restarted = scheduleRestart(runtime, reason)

      if (!restarted) {
        setProjectState(
          project.id,
          {
            state: 'error',
            running: false,
            attempt,
            lastExitCode: code,
            lastSignal: signal,
            message: `${project.name} en erreur: ${reason}`,
          },
          statusEmitter,
        )
      }

      return
    }

    setProjectState(
      project.id,
      {
        state: 'stopped',
        running: false,
        attempt,
        lastExitCode: code,
        lastSignal: signal,
        message: `${project.name} arrêté`,
      },
      statusEmitter,
    )
  })
}

async function startProject(baseDir, projectId, logEmitter, statusEmitter, launchConfig) {
  const resolvedBaseDir = normalizeBaseDir(baseDir)
  const project = getProjectById(projectId)
  const projectDir = getProjectDir(resolvedBaseDir, project)

  if (!(await pathExists(projectDir))) {
    throw new Error(`Le dossier ${project.directory} est introuvable. Lancez d'abord un pull/clone du projet.`)
  }

  if (RUNNING_PROCESSES.has(projectId)) {
    return {
      projectId,
      running: true,
      alreadyRunning: true,
    }
  }

  setProjectState(projectId, { state: 'checking', running: false, message: 'Pré-check en cours' }, statusEmitter)

  const diagnostics = await runProjectDiagnostics(resolvedBaseDir, projectId, launchConfig)
  applyDiagnosticsState(diagnostics, statusEmitter)

  if (diagnostics.status === 'fail') {
    const failingChecks = diagnostics.checks
      .filter((check) => check.status === 'fail')
      .map((check) => `${check.label}: ${check.details}`)

    throw new Error(`Pré-check bloquant (${project.name}): ${failingChecks.join(' | ')}`)
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

  const persistent = startCommand.persistent !== false

  if (!persistent) {
    setProjectState(projectId, { state: 'launching', running: false, message: 'Commande ponctuelle en cours' }, statusEmitter)

    await runCommand({
      command: startCommand.command,
      args: startCommand.args,
      cwd: projectDir,
      projectId,
      projectName: project.name,
      logEmitter,
      env: launchOptions.env,
      stdinInput: launchOptions.stdinInput,
    })

    setProjectState(projectId, { state: 'ready', running: false, message: 'Commande ponctuelle exécutée' }, statusEmitter)

    return {
      projectId,
      running: false,
      command: commandPreview,
      ephemeral: true,
    }
  }

  const policy = resolveLaunchPolicy(project, startCommand)

  spawnManagedProcess({
    project,
    projectDir,
    startCommand,
    launchOptions,
    policy,
    attempt: 0,
    logEmitter,
    statusEmitter,
  })

  return {
    projectId,
    running: true,
    command: commandPreview,
    diagnostics,
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

  running.stopping = true

  setProjectState(projectId, { state: 'stopping', running: true, message: `Arrêt de ${project.name} en cours` }, statusEmitter)

  running.child.kill('SIGTERM')

  emitLog(logEmitter, { level: 'info', projectId, message: `Demande d'arrêt envoyée à ${project.name}` })

  setTimeout(() => {
    const stillRunning = RUNNING_PROCESSES.get(projectId)

    if (stillRunning && stillRunning === running) {
      stillRunning.child.kill('SIGKILL')

      emitLog(logEmitter, { level: 'warning', projectId, message: `Arrêt forcé de ${project.name}` })
    }
  }, 5000)

  emitStatus(statusEmitter)

  return {
    projectId,
    stopped: true,
  }
}

function projectDependsOn(project, targetId, projectMap, seen = new Set()) {
  if (!project || seen.has(project.id)) {
    return false
  }

  seen.add(project.id)
  const dependencies = Array.isArray(project.dependsOn) ? project.dependsOn : []

  for (const dependencyId of dependencies) {
    if (dependencyId === targetId) {
      return true
    }

    const dependency = projectMap.get(dependencyId)
    if (dependency && projectDependsOn(dependency, targetId, projectMap, seen)) {
      return true
    }
  }

  return false
}

function getStartupOrder() {
  const projectMap = new Map(PROJECTS.map((project) => [project.id, project]))
  const visited = new Set()
  const visiting = new Set()
  const ordered = []

  const visit = (project) => {
    if (visited.has(project.id) || visiting.has(project.id)) {
      return
    }

    visiting.add(project.id)

    const dependencies = Array.isArray(project.dependsOn) ? project.dependsOn : []
    for (const dependencyId of dependencies) {
      const dependency = projectMap.get(dependencyId)
      if (dependency) {
        visit(dependency)
      }
    }

    visiting.delete(project.id)
    visited.add(project.id)
    ordered.push(project)
  }

  for (const project of PROJECTS) {
    visit(project)
  }

  return ordered
}

function getStopOrder() {
  const projectMap = new Map(PROJECTS.map((project) => [project.id, project]))
  const ordered = [...PROJECTS]

  ordered.sort((left, right) => {
    const leftDependsOnRight = projectDependsOn(left, right.id, projectMap)
    const rightDependsOnLeft = projectDependsOn(right, left.id, projectMap)

    if (leftDependsOnRight && !rightDependsOnLeft) {
      return -1
    }

    if (rightDependsOnLeft && !leftDependsOnRight) {
      return 1
    }

    const leftPriority = normalizeInteger(left.stopPriority, 0)
    const rightPriority = normalizeInteger(right.stopPriority, 0)

    if (leftPriority !== rightPriority) {
      return rightPriority - leftPriority
    }

    return left.name.localeCompare(right.name)
  })

  return ordered
}

async function syncAll(baseDir, logEmitter, statusEmitter) {
  const resolvedBaseDir = await ensureBaseDirectory(baseDir, logEmitter)
  const results = []
  const errors = []

  for (const project of PROJECTS) {
    try {
      const result = await syncProject(resolvedBaseDir, project.id, logEmitter, statusEmitter)
      results.push(result)
    } catch (error) {
      errors.push({ projectId: project.id, message: error.message })
      setProjectState(project.id, { state: 'error', running: false, message: error.message }, statusEmitter)
      emitLog(logEmitter, { level: 'error', projectId: project.id, message: error.message })
    }
  }

  return {
    baseDir: resolvedBaseDir,
    results,
    errors,
  }
}

async function installAll(baseDir, logEmitter, statusEmitter) {
  const resolvedBaseDir = normalizeBaseDir(baseDir)
  const results = []
  const errors = []

  for (const project of PROJECTS) {
    try {
      const result = await installProject(resolvedBaseDir, project.id, logEmitter, statusEmitter)
      results.push(result)
    } catch (error) {
      errors.push({ projectId: project.id, message: error.message })
      setProjectState(project.id, { state: 'error', running: false, message: error.message }, statusEmitter)
      emitLog(logEmitter, { level: 'error', projectId: project.id, message: error.message })
    }
  }

  return {
    baseDir: resolvedBaseDir,
    results,
    errors,
  }
}

async function setupAll(baseDir, logEmitter, statusEmitter) {
  const resolvedBaseDir = await ensureBaseDirectory(baseDir, logEmitter)
  const sync = await syncAll(resolvedBaseDir, logEmitter, statusEmitter)
  const install = await installAll(resolvedBaseDir, logEmitter, statusEmitter)

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
  const launchOrder = getStartupOrder()

  for (const project of launchOrder) {
    try {
      const result = await startProject(resolvedBaseDir, project.id, logEmitter, statusEmitter, launchConfig)
      results.push(result)
    } catch (error) {
      errors.push({ projectId: project.id, message: error.message })
      setProjectState(project.id, { state: 'error', running: false, message: error.message }, statusEmitter)
      emitLog(logEmitter, { level: 'error', projectId: project.id, message: error.message })
    }
  }

  emitStatus(statusEmitter)

  return {
    baseDir: resolvedBaseDir,
    launchOrder: launchOrder.map((project) => project.id),
    results,
    errors,
    statuses: getRuntimeStatus(),
  }
}

function stopAll(logEmitter, statusEmitter) {
  const stopOrder = getStopOrder()
  const results = []

  for (const project of stopOrder) {
    results.push(stopProject(project.id, logEmitter, statusEmitter))
  }

  emitStatus(statusEmitter)

  return {
    stopOrder: stopOrder.map((project) => project.id),
    results,
    statuses: getRuntimeStatus(),
  }
}

function getScenarios() {
  return SCENARIOS.map((scenario) => ({
    id: scenario.id,
    name: scenario.name,
    description: scenario.description || '',
    runDiagnosticsFirst: Boolean(scenario.runDiagnosticsFirst),
    syncBeforeLaunch: Boolean(scenario.syncBeforeLaunch),
    installBeforeLaunch: Boolean(scenario.installBeforeLaunch),
    launchConfig: scenario.launchConfig || {},
    steps: Array.isArray(scenario.steps) ? scenario.steps : [],
  }))
}

async function runScenario(baseDir, scenarioId, launchConfig, logEmitter, statusEmitter) {
  const scenario = SCENARIOS.find((item) => item.id === scenarioId)

  if (!scenario) {
    throw new Error(`Scénario introuvable: ${scenarioId}`)
  }

  const resolvedBaseDir = normalizeBaseDir(baseDir)
  const scenarioConfig = mergeLaunchConfig(launchConfig, scenario.launchConfig || {})
  const results = []

  emitLog(logEmitter, { level: 'info', message: `Scénario sélectionné: ${scenario.name}` })

  if (scenario.runDiagnosticsFirst) {
    const diagnostics = await runDiagnostics(resolvedBaseDir, scenarioConfig, statusEmitter)

    if (diagnostics.summary.projectFail > 0) {
      throw new Error(`Scénario interrompu: ${diagnostics.summary.projectFail} projet(s) en échec de pré-check.`)
    }
  }

  if (scenario.syncBeforeLaunch) {
    results.push({ action: 'sync-all', result: await syncAll(resolvedBaseDir, logEmitter, statusEmitter) })
  }

  if (scenario.installBeforeLaunch) {
    results.push({ action: 'install-all', result: await installAll(resolvedBaseDir, logEmitter, statusEmitter) })
  }

  const steps = Array.isArray(scenario.steps) ? scenario.steps : []

  for (const step of steps) {
    if (step.action === 'delay') {
      const delayMs = normalizeInteger(step.delayMs, 1000)
      emitLog(logEmitter, { level: 'info', message: `Scénario ${scenario.name}: attente ${delayMs} ms` })
      await wait(delayMs)
      results.push({ action: 'delay', delayMs })
      continue
    }

    if (step.action === 'start') {
      const started = await startProject(resolvedBaseDir, step.projectId, logEmitter, statusEmitter, scenarioConfig)
      results.push({ action: 'start', projectId: step.projectId, result: started })
      continue
    }

    if (step.action === 'stop-all') {
      const stopped = stopAll(logEmitter, statusEmitter)
      results.push({ action: 'stop-all', result: stopped })
      continue
    }

    emitLog(logEmitter, { level: 'warning', message: `Action de scénario ignorée: ${step.action}` })
  }

  emitStatus(statusEmitter)

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    baseDir: resolvedBaseDir,
    launchConfig: scenarioConfig,
    results,
    statuses: getRuntimeStatus(),
  }
}

function shutdown(logEmitter, statusEmitter) {
  for (const [projectId, runtime] of RUNNING_PROCESSES.entries()) {
    runtime.stopping = true

    try {
      runtime.child.kill('SIGTERM')
    } catch {
      emitLog(logEmitter, {
        level: 'warning',
        projectId,
        message: `Impossible de terminer ${runtime.project?.name || projectId} proprement`,
      })
    }
  }

  RUNNING_PROCESSES.clear()

  for (const project of PROJECTS) {
    setProjectState(project.id, { state: 'stopped', running: false, message: 'Arrêté' }, statusEmitter)
  }

  emitStatus(statusEmitter)
}

module.exports = {
  getDefaultBaseDir,
  normalizeBaseDir,
  getProjects,
  getRuntimeStatus,
  getScenarios,
  syncProject,
  installProject,
  startProject,
  stopProject,
  syncAll,
  installAll,
  setupAll,
  launchAll,
  stopAll,
  runDiagnostics,
  runAutotest,
  runScenario,
  exportLogs,
  shutdown,
}
