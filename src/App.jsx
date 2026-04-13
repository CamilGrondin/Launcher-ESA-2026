import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import wallpaperVideo from './assets/wallpaper.mp4'

const MAX_LOG_ENTRIES = 900
const STORAGE_LAUNCH_CONFIG = 'esa-launcher.launch-config.v1'
const STORAGE_PROFILES = 'esa-launcher.mode-profiles.v1'

const DEFAULT_LAUNCH_CONFIG = {
  'primary-flight-display': {
    mode: '2',
    joystickName: 'X52',
    xplaneIp: '127.0.0.1',
    xplanePort: '49000',
    mspPort: '/dev/tty.usbserial',
    mspBaud: '115200',
  },
  'navigation-display': {
    mode: '2',
    layout: '1',
    xplaneIp: '127.0.0.1',
    xplanePort: '49000',
    localPort: '49005',
    mspPort: '/dev/tty.usbserial',
    mspBaud: '115200',
  },
}

const BUILTIN_PROFILES = [
  {
    id: 'preset-xplane-demo',
    name: 'Preset X-Plane Demo',
    config: {
      'primary-flight-display': {
        mode: '2',
        xplaneIp: '127.0.0.1',
        xplanePort: '49000',
      },
      'navigation-display': {
        mode: '2',
        layout: '1',
        xplaneIp: '127.0.0.1',
        xplanePort: '49000',
        localPort: '49005',
      },
    },
    readonly: true,
  },
  {
    id: 'preset-msp-bench',
    name: 'Preset MSP Bench',
    config: {
      'primary-flight-display': {
        mode: '3',
        mspPort: '/dev/tty.usbserial',
        mspBaud: '115200',
      },
      'navigation-display': {
        mode: '3',
        layout: '2',
        mspPort: '/dev/tty.usbserial',
        mspBaud: '115200',
      },
    },
    readonly: true,
  },
  {
    id: 'preset-joystick-check',
    name: 'Preset Joystick Check',
    config: {
      'primary-flight-display': {
        mode: '1',
        joystickName: 'X52',
      },
      'navigation-display': {
        mode: '1',
        layout: '2',
      },
    },
    readonly: true,
  },
]

const STATUS_META = {
  stopped: { label: 'Stopped', tone: 'stopped' },
  ready: { label: 'Ready', tone: 'ready' },
  checking: { label: 'Pre-check', tone: 'checking' },
  launching: { label: 'Launching', tone: 'launching' },
  active: { label: 'Active', tone: 'active' },
  stopping: { label: 'Stopping', tone: 'stopping' },
  timeout: { label: 'Timeout', tone: 'timeout' },
  error: { label: 'Error', tone: 'error' },
  'deps-missing': { label: 'Missing deps', tone: 'error' },
}

function PlaneIcon({ className = '' }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M2 13.4L22 3L16.1 21L11.4 14.8L6.2 17.1L8.5 10.9L2 13.4Z"
        fill="currentColor"
      />
      <path d="M10.7 11.5L16.7 6.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createDefaultLaunchConfig() {
  return clone(DEFAULT_LAUNCH_CONFIG)
}

function mergeWithDefaults(candidate) {
  const base = createDefaultLaunchConfig()

  if (!candidate || typeof candidate !== 'object') {
    return base
  }

  for (const projectId of Object.keys(base)) {
    if (candidate[projectId] && typeof candidate[projectId] === 'object') {
      base[projectId] = {
        ...base[projectId],
        ...candidate[projectId],
      }
    }
  }

  return base
}

function loadLaunchConfigFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_LAUNCH_CONFIG)

    if (!raw) {
      return createDefaultLaunchConfig()
    }

    return mergeWithDefaults(JSON.parse(raw))
  } catch {
    return createDefaultLaunchConfig()
  }
}

function loadProfilesFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_PROFILES)

    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)

    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed
      .filter((profile) => {
        return (
          profile &&
          typeof profile.id === 'string' &&
          typeof profile.name === 'string' &&
          profile.config &&
          typeof profile.config === 'object'
        )
      })
      .map((profile) => ({
        id: profile.id,
        name: profile.name,
        config: mergeWithDefaults(profile.config),
        readonly: false,
      }))
  } catch {
    return []
  }
}

function trimLogs(entries) {
  if (entries.length <= MAX_LOG_ENTRIES) {
    return entries
  }

  return entries.slice(entries.length - MAX_LOG_ENTRIES)
}

function toStatusMap(statuses = []) {
  return statuses.reduce((result, status) => {
    result[status.id] = status
    return result
  }, {})
}

function normalizeLevel(level = 'info') {
  if (level.startsWith('error')) {
    return 'error'
  }

  if (level === 'warning') {
    return 'warning'
  }

  if (level === 'success') {
    return 'success'
  }

  return 'info'
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('fr-FR', { hour12: false })
}

function getStatusMeta(state) {
  return STATUS_META[state] || { label: state || 'Unknown', tone: 'stopped' }
}

function isProjectRunning(status) {
  if (!status) {
    return false
  }

  if (status.running) {
    return true
  }

  return ['launching', 'active', 'stopping'].includes(status.state)
}

function summarizeSingleProjectDiagnostics(report) {
  const summary = report?.summary || { pass: 0, warn: 0, fail: 0 }

  return {
    generatedAt: new Date().toISOString(),
    reports: [report],
    summary: {
      projectPass: report?.status === 'pass' ? 1 : 0,
      projectWarn: report?.status === 'warn' ? 1 : 0,
      projectFail: report?.status === 'fail' ? 1 : 0,
      checksPass: summary.pass || 0,
      checksWarn: summary.warn || 0,
      checksFail: summary.fail || 0,
    },
  }
}

function App() {
  const [baseDir, setBaseDir] = useState('')
  const [projects, setProjects] = useState([])
  const [scenarios, setScenarios] = useState([])
  const [statusById, setStatusById] = useState({})
  const [logs, setLogs] = useState([])
  const [globalBusy, setGlobalBusy] = useState('')
  const [projectBusy, setProjectBusy] = useState({})
  const [scenarioBusy, setScenarioBusy] = useState(false)
  const [logExportBusy, setLogExportBusy] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [showModePage, setShowModePage] = useState(true)
  const [launchConfig, setLaunchConfig] = useState(() => loadLaunchConfigFromStorage())
  const [savedProfiles, setSavedProfiles] = useState(() => loadProfilesFromStorage())
  const [selectedProfileId, setSelectedProfileId] = useState(BUILTIN_PROFILES[0].id)
  const [newProfileName, setNewProfileName] = useState('')
  const [selectedScenarioId, setSelectedScenarioId] = useState('')
  const [diagnostics, setDiagnostics] = useState(null)
  const [autotest, setAutotest] = useState(null)
  const [logQuery, setLogQuery] = useState('')
  const [logLevelFilter, setLogLevelFilter] = useState('all')
  const [logSourceFilter, setLogSourceFilter] = useState('all')

  const projectNames = useMemo(
    () => Object.fromEntries(projects.map((project) => [project.id, project.name])),
    [projects],
  )

  const allProfiles = useMemo(() => [...BUILTIN_PROFILES, ...savedProfiles], [savedProfiles])

  const selectedScenario = useMemo(
    () => scenarios.find((scenario) => scenario.id === selectedScenarioId) || null,
    [scenarios, selectedScenarioId],
  )

  const logSources = useMemo(() => {
    const sources = new Map()
    sources.set('GLOBAL', 'GLOBAL')

    projects.forEach((project) => {
      sources.set(project.id, project.name)
    })

    logs.forEach((entry) => {
      if (entry.projectId && !sources.has(entry.projectId)) {
        sources.set(entry.projectId, projectNames[entry.projectId] || entry.projectId)
      }
    })

    return Array.from(sources.entries())
  }, [projects, logs, projectNames])

  const appendLog = useCallback((level, message, projectId) => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      projectId,
    }

    setLogs((previous) => trimLogs([...previous, entry]))
  }, [])

  const applySnapshot = useCallback((snapshot) => {
    if (!snapshot || typeof snapshot !== 'object') {
      return
    }

    if (Array.isArray(snapshot.projects)) {
      setProjects(snapshot.projects)
    }

    if (Array.isArray(snapshot.scenarios)) {
      setScenarios(snapshot.scenarios)
      setSelectedScenarioId((previous) => previous || snapshot.scenarios[0]?.id || '')
    }

    if (Array.isArray(snapshot.statuses)) {
      setStatusById(toStatusMap(snapshot.statuses))
    }

    if (typeof snapshot.baseDir === 'string' && snapshot.baseDir.length > 0) {
      setBaseDir(snapshot.baseDir)
    }
  }, [])

  const callApi = useCallback(async (methodName, payload) => {
    if (!window.launcherApi || typeof window.launcherApi[methodName] !== 'function') {
      throw new Error('Electron API is unavailable. Start with npm run dev or npm start.')
    }

    const response = await window.launcherApi[methodName](payload)

    if (!response?.ok) {
      throw new Error(response?.error || 'Unknown error')
    }

    return response.data
  }, [])

  const refreshState = useCallback(
    async (candidateBaseDir) => {
      const snapshot = await callApi('getState', candidateBaseDir)
      applySnapshot(snapshot)
    },
    [applySnapshot, callApi],
  )

  const updateLaunchConfig = useCallback((projectId, field, value) => {
    setLaunchConfig((previous) => ({
      ...previous,
      [projectId]: {
        ...(previous[projectId] || {}),
        [field]: value,
      },
    }))
  }, [])

  const runGlobalAction = async ({
    label,
    methodName,
    includeLaunchConfig = false,
    refreshAfter = true,
  }) => {
    if (globalBusy.length > 0) {
      return
    }

    const currentBaseDir = baseDir.trim()
    setGlobalBusy(label)
    appendLog('info', `${label} in progress...`)

    try {
      let payload

      if (['stopAll', 'installSdrPlusPlus', 'openBetaflight'].includes(methodName)) {
        payload = undefined
      } else if (includeLaunchConfig) {
        payload = { baseDir: currentBaseDir, launchConfig }
      } else {
        payload = currentBaseDir
      }

      const result = await callApi(methodName, payload)

      if (Array.isArray(result?.statuses)) {
        setStatusById(toStatusMap(result.statuses))
      }

      if (methodName === 'runDiagnostics') {
        setDiagnostics(result)
      }

      if (methodName === 'runAutotest') {
        setAutotest(result)
        setDiagnostics(result)
      }

      if (methodName === 'stopAll' && Array.isArray(result?.stopOrder) && result.stopOrder.length > 0) {
        appendLog('info', `Stop order: ${result.stopOrder.join(' -> ')}`)
      }

      if (methodName === 'installSdrPlusPlus' && result?.assetName) {
        appendLog('info', `SDR++ asset: ${result.assetName}`)
      }

      appendLog('success', `${label} completed.`)

      if (refreshAfter) {
        await refreshState(result?.baseDir || currentBaseDir)
      }
    } catch (error) {
      appendLog('error', error.message)
    } finally {
      setGlobalBusy('')
    }
  }

  const runProjectAction = async (projectId, label, methodName) => {
    if (projectBusy[projectId]) {
      return
    }

    const currentBaseDir = baseDir.trim()
    setProjectBusy((previous) => ({ ...previous, [projectId]: label }))
    appendLog('info', `${label} - ${projectNames[projectId] || projectId}`, projectId)

    try {
      const payload = { baseDir: currentBaseDir, projectId }

      if (methodName === 'launchProject') {
        payload.launchConfig = launchConfig
      }

      const result = await callApi(methodName, payload)

      if (Array.isArray(result?.statuses)) {
        setStatusById(toStatusMap(result.statuses))
      }

      if (result?.diagnostics) {
        setDiagnostics(summarizeSingleProjectDiagnostics(result.diagnostics))
      }

      appendLog('success', `${label} completed.`, projectId)
      await refreshState(currentBaseDir)
    } catch (error) {
      appendLog('error', error.message, projectId)
    } finally {
      setProjectBusy((previous) => {
        const next = { ...previous }
        delete next[projectId]
        return next
      })
    }
  }

  const applySelectedProfile = useCallback(() => {
    const profile = allProfiles.find((item) => item.id === selectedProfileId)

    if (!profile) {
      return
    }

    setLaunchConfig(mergeWithDefaults(profile.config))
    appendLog('info', `Profile applied: ${profile.name}`)
  }, [allProfiles, appendLog, selectedProfileId])

  const saveCurrentProfile = useCallback(() => {
    const name = newProfileName.trim()

    if (name.length === 0) {
      appendLog('warning', 'Provide a profile name before saving.')
      return
    }

    const profileId = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

    setSavedProfiles((previous) => {
      const next = [...previous]
      const existingIndex = next.findIndex((profile) => profile.id === profileId)

      const profile = {
        id: profileId,
        name,
        config: mergeWithDefaults(launchConfig),
        readonly: false,
      }

      if (existingIndex >= 0) {
        next[existingIndex] = profile
      } else {
        next.push(profile)
      }

      return next
    })

    setSelectedProfileId(profileId)
    setNewProfileName('')
    appendLog('success', `Profile saved: ${name}`)
  }, [appendLog, launchConfig, newProfileName])

  const deleteSelectedProfile = useCallback(() => {
    const profile = savedProfiles.find((item) => item.id === selectedProfileId)

    if (!profile) {
      appendLog('warning', 'Select a custom profile to delete.')
      return
    }

    setSavedProfiles((previous) => previous.filter((item) => item.id !== selectedProfileId))
    setSelectedProfileId(BUILTIN_PROFILES[0].id)
    appendLog('info', `Profile deleted: ${profile.name}`)
  }, [appendLog, savedProfiles, selectedProfileId])

  const runScenario = useCallback(async () => {
    if (!selectedScenarioId || scenarioBusy || globalBusy) {
      return
    }

    const currentBaseDir = baseDir.trim()
    setScenarioBusy(true)
    appendLog('info', `Scenario running: ${selectedScenario?.name || selectedScenarioId}`)

    try {
      const result = await callApi('runScenario', {
        baseDir: currentBaseDir,
        scenarioId: selectedScenarioId,
        launchConfig,
      })

      if (Array.isArray(result?.statuses)) {
        setStatusById(toStatusMap(result.statuses))
      }

      appendLog('success', `Scenario completed: ${selectedScenario?.name || selectedScenarioId}`)
      await refreshState(result?.baseDir || currentBaseDir)
    } catch (error) {
      appendLog('error', error.message)
    } finally {
      setScenarioBusy(false)
    }
  }, [
    appendLog,
    baseDir,
    callApi,
    globalBusy,
    launchConfig,
    refreshState,
    scenarioBusy,
    selectedScenario,
    selectedScenarioId,
  ])

  const exportFilteredLogs = useCallback(
    async (entries) => {
      if (logExportBusy) {
        return
      }

      const currentBaseDir = baseDir.trim()
      setLogExportBusy(true)

      try {
        const result = await callApi('exportLogs', {
          baseDir: currentBaseDir,
          logs: entries,
        })

        appendLog('success', `Logs exported to ${result.path}`)
      } catch (error) {
        appendLog('error', error.message)
      } finally {
        setLogExportBusy(false)
      }
    },
    [appendLog, baseDir, callApi, logExportBusy],
  )

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_LAUNCH_CONFIG, JSON.stringify(launchConfig))
    } catch {
      // Ignore storage failures.
    }
  }, [launchConfig])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_PROFILES, JSON.stringify(savedProfiles))
    } catch {
      // Ignore storage failures.
    }
  }, [savedProfiles])

  useEffect(() => {
    if (!window.launcherApi) {
      appendLog('error', 'Electron is not available. Run via npm run dev.')
      setIsLoading(false)
      return () => {}
    }

    let mounted = true

    const unsubscribeLog = window.launcherApi.onLog((entry) => {
      if (!mounted) {
        return
      }

      setLogs((previous) => trimLogs([...previous, entry]))
    })

    const unsubscribeStatus = window.launcherApi.onStatus((payload) => {
      if (!mounted || !Array.isArray(payload?.statuses)) {
        return
      }

      setStatusById(toStatusMap(payload.statuses))
    })

    const bootstrap = async () => {
      try {
        await refreshState('')
      } catch (error) {
        if (mounted) {
          appendLog('error', error.message)
        }
      } finally {
        if (mounted) {
          setIsLoading(false)
        }
      }
    }

    bootstrap()

    return () => {
      mounted = false
      unsubscribeLog()
      unsubscribeStatus()
    }
  }, [appendLog, refreshState])

  const latestLogs = useMemo(() => logs.slice().reverse(), [logs])

  const filteredLogs = useMemo(() => {
    const query = logQuery.trim().toLowerCase()

    return latestLogs.filter((entry) => {
      const normalized = normalizeLevel(entry.level)
      const sourceId = entry.projectId || 'GLOBAL'
      const sourceName = entry.projectId ? projectNames[entry.projectId] || entry.projectId : 'GLOBAL'

      if (logLevelFilter !== 'all' && normalized !== logLevelFilter) {
        return false
      }

      if (logSourceFilter !== 'all' && sourceId !== logSourceFilter) {
        return false
      }

      if (!query) {
        return true
      }

      const haystack = `${entry.message || ''} ${sourceName} ${sourceId}`.toLowerCase()
      return haystack.includes(query)
    })
  }, [latestLogs, logLevelFilter, logQuery, logSourceFilter, projectNames])

  const controlsDisabled = isLoading || globalBusy.length > 0
  const electronReady = Boolean(window.launcherApi)
  const modeEditorDisabled = !electronReady || controlsDisabled
  const cockpitStatusLabel = globalBusy || (isLoading ? 'Aligning systems...' : 'Ready for takeoff')
  const pfdConfig = launchConfig['primary-flight-display'] || DEFAULT_LAUNCH_CONFIG['primary-flight-display']
  const navConfig = launchConfig['navigation-display'] || DEFAULT_LAUNCH_CONFIG['navigation-display']

  const diagnosticsBannerTone = useMemo(() => {
    if (!diagnostics) {
      return 'idle'
    }

    if (diagnostics.summary?.projectFail > 0) {
      return 'fail'
    }

    if (diagnostics.summary?.projectWarn > 0) {
      return 'warn'
    }

    return 'pass'
  }, [diagnostics])

  return (
    <div className="flight-scene">
      <video className="sky-video" autoPlay loop muted playsInline>
        <source src={wallpaperVideo} type="video/mp4" />
      </video>
      <div className="sky-vignette" aria-hidden="true" />
      <div className="sky-grid" aria-hidden="true" />

      {isLoading ? (
        <div className="cloud-loader" role="status" aria-live="polite">
          <div className="cloud-bank" aria-hidden="true">
            <span className="cloud cloud-1" />
            <span className="cloud cloud-2" />
            <span className="cloud cloud-3" />
            <span className="cloud cloud-4" />
            <span className="cloud cloud-5" />
          </div>
          <div className="loader-card">
            <PlaneIcon className="loader-plane-icon" />
            <p>Boot sequence in progress</p>
          </div>
        </div>
      ) : null}

      <div className="app-shell">
        <header className="hero-panel fade-in">
          <div className="hero-copy">
            <p className="project-badge">GEII ESA 2026</p>
            <h1>
              <PlaneIcon className="hero-flight-icon" />
              Launcher Simulateur d'Avion
            </h1>
            <p className="subtitle">
              Tour de controle unique pour pre-checks, scenarios, diagnostics, lancements et journaux runtime.
            </p>
            <div className="hero-telemetry">
              <span>Modules {projects.length}</span>
              <span>Scenarios {scenarios.length}</span>
              <span>Profiles {allProfiles.length}</span>
            </div>
          </div>
          <div className={`status-chip ${globalBusy ? 'busy' : 'idle'}`}>{cockpitStatusLabel}</div>
        </header>

        <section className="control-panel fade-in delay-1">
          <label htmlFor="base-dir">Simulator root folder</label>
          <div className="path-row">
            <input
              id="base-dir"
              type="text"
              value={baseDir}
              onChange={(event) => setBaseDir(event.target.value)}
              placeholder="/Users/.../GEII-ESA-2026-Simulateur"
              disabled={!electronReady || isLoading}
            />
            <button
              className="ghost"
              type="button"
              disabled={!electronReady || controlsDisabled}
              onClick={() => refreshState(baseDir)}
            >
              Refresh
            </button>
          </div>

          <div className="global-actions">
            <button
              type="button"
              disabled={!electronReady || controlsDisabled}
              onClick={() => runGlobalAction({ label: 'Setup + install all', methodName: 'setupAll' })}
            >
              Setup + Install all
            </button>
            <button
              type="button"
              disabled={!electronReady || controlsDisabled}
              onClick={() => runGlobalAction({ label: 'Sync all', methodName: 'syncAll' })}
            >
              Pull all
            </button>
            <button
              type="button"
              disabled={!electronReady || controlsDisabled}
              onClick={() =>
                runGlobalAction({
                  label: 'Launch all',
                  methodName: 'launchAll',
                  includeLaunchConfig: true,
                })
              }
            >
              Launch all
            </button>
            <button
              className="danger"
              type="button"
              disabled={!electronReady || isLoading}
              onClick={() => runGlobalAction({ label: 'Stop all', methodName: 'stopAll' })}
            >
              Stop all
            </button>
          </div>
        </section>

        <section className={`diagnostics-banner fade-in delay-2 ${diagnosticsBannerTone}`}>
          <div>
            <h2>Diagnostics and autotest</h2>
            {diagnostics ? (
              <p>
                Project pass: {diagnostics.summary?.projectPass || 0} | warnings:{' '}
                {diagnostics.summary?.projectWarn || 0} | fails: {diagnostics.summary?.projectFail || 0}
              </p>
            ) : (
              <p>No diagnostics report yet.</p>
            )}
            {autotest ? <p>Autotest verdict: {autotest.verdict || 'unknown'}</p> : null}
          </div>
          <div className="diag-actions">
            <button
              type="button"
              disabled={!electronReady || controlsDisabled}
              onClick={() =>
                runGlobalAction({
                  label: 'Installer SDR++',
                  methodName: 'installSdrPlusPlus',
                  refreshAfter: false,
                })
              }
            >
              Installer SDR++
            </button>
            <button
              type="button"
              disabled={!electronReady || controlsDisabled}
              onClick={() =>
                runGlobalAction({
                  label: 'Ouvrir BetaFlight',
                  methodName: 'openBetaflight',
                  refreshAfter: false,
                })
              }
            >
              Ouvrir BetaFlight
            </button>
          </div>
        </section>

        {diagnostics?.reports?.length ? (
          <section className="diag-report-panel fade-in delay-2">
            <div className="panel-head compact">
              <h2>Pre-check reports</h2>
              <span>{diagnostics.reports.length} module(s)</span>
            </div>
            <div className="diag-report-grid">
              {diagnostics.reports.map((report) => {
                const firstFail = report.checks?.find((check) => check.status === 'fail')
                const firstWarn = report.checks?.find((check) => check.status === 'warn')
                const note = firstFail || firstWarn

                return (
                  <article key={report.projectId} className={`diag-card ${report.status || 'pass'}`}>
                    <h3>{report.projectName || report.projectId}</h3>
                    <p>
                      pass {report.summary?.pass || 0} | warn {report.summary?.warn || 0} | fail{' '}
                      {report.summary?.fail || 0}
                    </p>
                    <p>{note ? `${note.label}: ${note.details}` : 'No blocking issue detected.'}</p>
                  </article>
                )
              })}
            </div>
          </section>
        ) : null}

        <section className="modes-panel fade-in delay-2">
          <div className="panel-head">
            <h2>Modes and profiles</h2>
            <button
              type="button"
              className="ghost"
              onClick={() => setShowModePage((previous) => !previous)}
            >
              {showModePage ? 'Hide' : 'Show'}
            </button>
          </div>

          <p className="modes-help">Profiles are saved locally and can be re-applied before launch.</p>

          <div className="profile-toolbar">
            <select
              value={selectedProfileId}
              onChange={(event) => setSelectedProfileId(event.target.value)}
              disabled={modeEditorDisabled}
            >
              {allProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
            <button type="button" disabled={modeEditorDisabled} onClick={applySelectedProfile}>
              Apply
            </button>
            <input
              type="text"
              value={newProfileName}
              placeholder="Profile name"
              onChange={(event) => setNewProfileName(event.target.value)}
              disabled={modeEditorDisabled}
            />
            <button type="button" disabled={modeEditorDisabled} onClick={saveCurrentProfile}>
              Save current
            </button>
            <button
              type="button"
              className="danger"
              disabled={
                modeEditorDisabled || BUILTIN_PROFILES.some((profile) => profile.id === selectedProfileId)
              }
              onClick={deleteSelectedProfile}
            >
              Delete profile
            </button>
          </div>

          {showModePage ? (
            <div className="mode-grid">
              <article className="mode-card">
                <h3>Primary Flight Display</h3>

                <div className="mode-row">
                  <label htmlFor="pfd-mode">Mode</label>
                  <select
                    id="pfd-mode"
                    value={pfdConfig.mode}
                    disabled={modeEditorDisabled}
                    onChange={(event) => {
                      updateLaunchConfig('primary-flight-display', 'mode', event.target.value)
                    }}
                  >
                    <option value="1">Mode 1 - Joystick X52</option>
                    <option value="2">Mode 2 - X-Plane UDP</option>
                    <option value="3">Mode 3 - MSP (IMU)</option>
                  </select>
                </div>

                {pfdConfig.mode === '1' ? (
                  <div className="mode-row">
                    <label htmlFor="pfd-joystick">Joystick name</label>
                    <input
                      id="pfd-joystick"
                      type="text"
                      value={pfdConfig.joystickName}
                      disabled={modeEditorDisabled}
                      onChange={(event) => {
                        updateLaunchConfig('primary-flight-display', 'joystickName', event.target.value)
                      }}
                    />
                  </div>
                ) : null}

                {pfdConfig.mode === '2' ? (
                  <div className="mode-row two-cols">
                    <div>
                      <label htmlFor="pfd-xplane-ip">X-Plane IP</label>
                      <input
                        id="pfd-xplane-ip"
                        type="text"
                        value={pfdConfig.xplaneIp}
                        disabled={modeEditorDisabled}
                        onChange={(event) => {
                          updateLaunchConfig('primary-flight-display', 'xplaneIp', event.target.value)
                        }}
                      />
                    </div>
                    <div>
                      <label htmlFor="pfd-xplane-port">UDP port</label>
                      <input
                        id="pfd-xplane-port"
                        type="text"
                        value={pfdConfig.xplanePort}
                        disabled={modeEditorDisabled}
                        onChange={(event) => {
                          updateLaunchConfig('primary-flight-display', 'xplanePort', event.target.value)
                        }}
                      />
                    </div>
                  </div>
                ) : null}

                {pfdConfig.mode === '3' ? (
                  <div className="mode-row two-cols">
                    <div>
                      <label htmlFor="pfd-msp-port">MSP port</label>
                      <input
                        id="pfd-msp-port"
                        type="text"
                        value={pfdConfig.mspPort}
                        disabled={modeEditorDisabled}
                        onChange={(event) => {
                          updateLaunchConfig('primary-flight-display', 'mspPort', event.target.value)
                        }}
                      />
                    </div>
                    <div>
                      <label htmlFor="pfd-msp-baud">Baudrate</label>
                      <input
                        id="pfd-msp-baud"
                        type="text"
                        value={pfdConfig.mspBaud}
                        disabled={modeEditorDisabled}
                        onChange={(event) => {
                          updateLaunchConfig('primary-flight-display', 'mspBaud', event.target.value)
                        }}
                      />
                    </div>
                  </div>
                ) : null}
              </article>

              <article className="mode-card">
                <h3>Navigation Display</h3>

                <div className="mode-row two-cols">
                  <div>
                    <label htmlFor="nav-mode">Mode</label>
                    <select
                      id="nav-mode"
                      value={navConfig.mode}
                      disabled={modeEditorDisabled}
                      onChange={(event) => {
                        updateLaunchConfig('navigation-display', 'mode', event.target.value)
                      }}
                    >
                      <option value="1">Mode 1 - Manual</option>
                      <option value="2">Mode 2 - X-Plane UDP</option>
                      <option value="3">Mode 3 - MSP GPS</option>
                    </select>
                  </div>

                  <div>
                    <label htmlFor="nav-layout">Layout</label>
                    <select
                      id="nav-layout"
                      value={navConfig.layout}
                      disabled={modeEditorDisabled}
                      onChange={(event) => {
                        updateLaunchConfig('navigation-display', 'layout', event.target.value)
                      }}
                    >
                      <option value="1">Full</option>
                      <option value="2">Center map</option>
                    </select>
                  </div>
                </div>

                {navConfig.mode === '2' ? (
                  <>
                    <div className="mode-row two-cols">
                      <div>
                        <label htmlFor="nav-xplane-ip">X-Plane IP</label>
                        <input
                          id="nav-xplane-ip"
                          type="text"
                          value={navConfig.xplaneIp}
                          disabled={modeEditorDisabled}
                          onChange={(event) => {
                            updateLaunchConfig('navigation-display', 'xplaneIp', event.target.value)
                          }}
                        />
                      </div>
                      <div>
                        <label htmlFor="nav-xplane-port">Remote port</label>
                        <input
                          id="nav-xplane-port"
                          type="text"
                          value={navConfig.xplanePort}
                          disabled={modeEditorDisabled}
                          onChange={(event) => {
                            updateLaunchConfig('navigation-display', 'xplanePort', event.target.value)
                          }}
                        />
                      </div>
                    </div>
                    <div className="mode-row">
                      <label htmlFor="nav-xplane-local-port">Local listen port</label>
                      <input
                        id="nav-xplane-local-port"
                        type="text"
                        value={navConfig.localPort}
                        disabled={modeEditorDisabled}
                        onChange={(event) => {
                          updateLaunchConfig('navigation-display', 'localPort', event.target.value)
                        }}
                      />
                    </div>
                  </>
                ) : null}

                {navConfig.mode === '3' ? (
                  <div className="mode-row two-cols">
                    <div>
                      <label htmlFor="nav-msp-port">MSP port</label>
                      <input
                        id="nav-msp-port"
                        type="text"
                        value={navConfig.mspPort}
                        disabled={modeEditorDisabled}
                        onChange={(event) => {
                          updateLaunchConfig('navigation-display', 'mspPort', event.target.value)
                        }}
                      />
                    </div>
                    <div>
                      <label htmlFor="nav-msp-baud">Baudrate</label>
                      <input
                        id="nav-msp-baud"
                        type="text"
                        value={navConfig.mspBaud}
                        disabled={modeEditorDisabled}
                        onChange={(event) => {
                          updateLaunchConfig('navigation-display', 'mspBaud', event.target.value)
                        }}
                      />
                    </div>
                  </div>
                ) : null}
              </article>
            </div>
          ) : null}
        </section>

        <section className="scenario-panel fade-in delay-3">
          <div className="panel-head">
            <h2>Launch scenarios</h2>
            <span>{scenarios.length} scenario(s)</span>
          </div>

          <div className="scenario-toolbar">
            <select
              value={selectedScenarioId}
              onChange={(event) => setSelectedScenarioId(event.target.value)}
              disabled={!electronReady || controlsDisabled || scenarios.length === 0}
            >
              {scenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={
                !electronReady ||
                controlsDisabled ||
                scenarioBusy ||
                scenarios.length === 0 ||
                !selectedScenarioId
              }
              onClick={runScenario}
            >
              {scenarioBusy ? 'Scenario running...' : 'Run scenario'}
            </button>
          </div>

          {selectedScenario ? (
            <article className="scenario-card">
              <h3>{selectedScenario.name}</h3>
              <p>{selectedScenario.description || 'No description.'}</p>
              <p>
                Steps: {(selectedScenario.steps || []).map((step) => step.action).join(' -> ') || 'No steps'}
              </p>
            </article>
          ) : (
            <p className="placeholder">No scenario loaded.</p>
          )}
        </section>

        <main className="dashboard">
          <section className="projects-panel fade-in delay-3">
            <div className="panel-head">
              <h2>Simulator modules</h2>
              <span>{projects.length} project(s)</span>
            </div>

            {!electronReady ? (
              <p className="placeholder">Browser mode detected. System actions require Electron.</p>
            ) : (
              <div className="project-grid">
                {projects.map((project) => {
                  const status = statusById[project.id] || {
                    state: 'stopped',
                    running: false,
                    message: 'Waiting',
                    attempt: 0,
                  }

                  const running = isProjectRunning(status)
                  const currentBusy = projectBusy[project.id]
                  const meta = getStatusMeta(status.state)

                  return (
                    <article key={project.id} className="project-card">
                      <div className="project-title-row">
                        <h3>{project.name}</h3>
                        <span className={`state ${meta.tone}`}>{meta.label}</span>
                      </div>

                      <p className="project-meta">{project.repo}</p>
                      <p className="project-path">{project.path}</p>
                      <p className="project-status-message">{status.message || 'No message'}</p>

                      {status.attempt > 0 ? (
                        <p className="task-state">Auto-restart attempt: {status.attempt}</p>
                      ) : null}

                      <div className="card-actions">
                        <button
                          type="button"
                          disabled={controlsDisabled || Boolean(currentBusy)}
                          onClick={() => runProjectAction(project.id, 'Pull', 'syncProject')}
                        >
                          Pull
                        </button>
                        <button
                          type="button"
                          disabled={controlsDisabled || Boolean(currentBusy)}
                          onClick={() => runProjectAction(project.id, 'Install', 'installProject')}
                        >
                          Install
                        </button>
                        <button
                          type="button"
                          disabled={
                            controlsDisabled ||
                            running ||
                            Boolean(currentBusy) ||
                            status.state === 'checking' ||
                            status.state === 'launching' ||
                            status.state === 'stopping'
                          }
                          onClick={() => runProjectAction(project.id, 'Launch', 'launchProject')}
                        >
                          Launch
                        </button>
                        <button
                          className="danger"
                          type="button"
                          disabled={isLoading || !running || Boolean(currentBusy)}
                          onClick={() => runProjectAction(project.id, 'Stop', 'stopProject')}
                        >
                          Stop
                        </button>
                      </div>

                      {currentBusy ? <p className="task-state">{currentBusy}...</p> : null}
                    </article>
                  )
                })}
              </div>
            )}
          </section>

          <aside className="logs-panel fade-in delay-4">
            <div className="panel-head">
              <h2>Execution logs</h2>
              <div className="inline-actions">
                <button type="button" className="ghost" onClick={() => setLogs([])}>
                  Clear
                </button>
                <button
                  type="button"
                  disabled={filteredLogs.length === 0 || logExportBusy}
                  onClick={() => exportFilteredLogs(filteredLogs)}
                >
                  {logExportBusy ? 'Export...' : 'Export'}
                </button>
              </div>
            </div>

            <div className="log-toolbar">
              <input
                type="text"
                placeholder="Search text"
                value={logQuery}
                onChange={(event) => setLogQuery(event.target.value)}
              />
              <select value={logLevelFilter} onChange={(event) => setLogLevelFilter(event.target.value)}>
                <option value="all">All levels</option>
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="error">Error</option>
                <option value="success">Success</option>
              </select>
              <select value={logSourceFilter} onChange={(event) => setLogSourceFilter(event.target.value)}>
                <option value="all">All sources</option>
                {logSources.map(([sourceId, label]) => (
                  <option key={sourceId} value={sourceId}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            {filteredLogs.length === 0 ? (
              <p className="placeholder">No event matching the filters.</p>
            ) : (
              <ul className="log-list">
                {filteredLogs.map((entry, index) => {
                  const level = normalizeLevel(entry.level)

                  return (
                    <li key={`${entry.timestamp}-${index}`} className={`log-item ${level}`}>
                      <span className="log-time">{formatTime(entry.timestamp)}</span>
                      <span className="log-source">
                        {entry.projectId ? projectNames[entry.projectId] || entry.projectId : 'GLOBAL'}
                      </span>
                      <span className="log-message">{entry.message}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </aside>
        </main>
      </div>
    </div>
  )
}
export default App
