import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

const MAX_LOG_ENTRIES = 700

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

function createDefaultLaunchConfig() {
  return {
    'primary-flight-display': { ...DEFAULT_LAUNCH_CONFIG['primary-flight-display'] },
    'navigation-display': { ...DEFAULT_LAUNCH_CONFIG['navigation-display'] },
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
    result[status.id] = Boolean(status.running)
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

function App() {
  const [baseDir, setBaseDir] = useState('')
  const [projects, setProjects] = useState([])
  const [statuses, setStatuses] = useState({})
  const [logs, setLogs] = useState([])
  const [globalBusy, setGlobalBusy] = useState('')
  const [projectBusy, setProjectBusy] = useState({})
  const [isLoading, setIsLoading] = useState(true)
  const [showModePage, setShowModePage] = useState(true)
  const [launchConfig, setLaunchConfig] = useState(() => createDefaultLaunchConfig())

  const projectNames = useMemo(
    () => Object.fromEntries(projects.map((project) => [project.id, project.name])),
    [projects],
  )

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
    if (!snapshot) {
      return
    }

    if (Array.isArray(snapshot.projects)) {
      setProjects(snapshot.projects)
    }

    if (Array.isArray(snapshot.statuses)) {
      setStatuses(toStatusMap(snapshot.statuses))
    }

    if (typeof snapshot.baseDir === 'string' && snapshot.baseDir.length > 0) {
      setBaseDir(snapshot.baseDir)
    }
  }, [])

  const callApi = useCallback(async (methodName, payload) => {
    if (!window.launcherApi || typeof window.launcherApi[methodName] !== 'function') {
      throw new Error(
        'API Electron indisponible. Démarrez l\'application avec npm run dev ou npm start.',
      )
    }

    const response = await window.launcherApi[methodName](payload)

    if (!response?.ok) {
      throw new Error(response?.error || 'Une erreur inconnue est survenue.')
    }

    return response.data
  }, [])

  const refreshState = useCallback(async (candidateBaseDir) => {
    const snapshot = await callApi('getState', candidateBaseDir)
    applySnapshot(snapshot)
  }, [applySnapshot, callApi])

  const updateLaunchConfig = useCallback((projectId, field, value) => {
    setLaunchConfig((previous) => ({
      ...previous,
      [projectId]: {
        ...(previous[projectId] || {}),
        [field]: value,
      },
    }))
  }, [])

  const runGlobalAction = async (label, methodName) => {
    if (globalBusy.length > 0) {
      return
    }

    const currentBaseDir = baseDir.trim()
    setGlobalBusy(label)
    appendLog('info', `${label} en cours...`)

    try {
      const payload =
        methodName === 'launchAll'
          ? {
              baseDir: currentBaseDir,
              launchConfig,
            }
          : currentBaseDir

      const result = await callApi(methodName, payload)

      if (Array.isArray(result?.statuses)) {
        setStatuses(toStatusMap(result.statuses))
      }

      appendLog('success', `${label} terminé.`)
      await refreshState(result?.baseDir || currentBaseDir)
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
        setStatuses(toStatusMap(result.statuses))
      }

      appendLog('success', `${label} terminé.`, projectId)
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

  useEffect(() => {
    if (!window.launcherApi) {
      appendLog('error', 'Electron n\'est pas détecté. Lancez le projet via npm run dev.')
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

      setStatuses(toStatusMap(payload.statuses))
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
  const controlsDisabled = isLoading || globalBusy.length > 0
  const electronReady = Boolean(window.launcherApi)
  const modeEditorDisabled = !electronReady || controlsDisabled
  const pfdConfig = launchConfig['primary-flight-display'] || DEFAULT_LAUNCH_CONFIG['primary-flight-display']
  const navConfig = launchConfig['navigation-display'] || DEFAULT_LAUNCH_CONFIG['navigation-display']

  return (
    <div className="app-shell">
      <header className="hero-panel fade-in">
        <div>
          <p className="project-badge">GEII ESA 2026</p>
          <h1>Launcher Simulateur d&apos;Avion</h1>
          <p className="subtitle">
            Créez le dossier de travail, mettez les dépôts à jour, installez les dépendances
            et lancez tous les modules du simulateur depuis une seule interface.
          </p>
        </div>
        <div className={`status-chip ${globalBusy ? 'busy' : 'idle'}`}>
          {globalBusy || (isLoading ? 'Initialisation...' : 'Prêt')}
        </div>
      </header>

      <section className="control-panel fade-in delay-1">
        <label htmlFor="base-dir">Dossier racine du simulateur</label>
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
            Actualiser
          </button>
        </div>

        <div className="global-actions">
          <button
            type="button"
            disabled={!electronReady || controlsDisabled}
            onClick={() => runGlobalAction('Préparation complète', 'setupAll')}
          >
            Préparer tout
          </button>
          <button
            type="button"
            disabled={!electronReady || controlsDisabled}
            onClick={() => runGlobalAction('Mise à jour des dépôts', 'syncAll')}
          >
            Pull tous
          </button>
          <button
            type="button"
            disabled={!electronReady || controlsDisabled}
            onClick={() => runGlobalAction('Installation des dépendances', 'installAll')}
          >
            Installer tout
          </button>
          <button
            type="button"
            disabled={!electronReady || controlsDisabled}
            onClick={() => runGlobalAction('Lancement de tous les projets', 'launchAll')}
          >
            Lancer tous
          </button>
          <button
            className="danger"
            type="button"
            disabled={!electronReady || isLoading}
            onClick={() => runGlobalAction('Arrêt global', 'stopAll')}
          >
            Arrêter tous
          </button>
        </div>
      </section>

      <section className="modes-panel fade-in delay-2">
        <div className="panel-head">
          <h2>Page des modes</h2>
          <button
            type="button"
            className="ghost"
            onClick={() => setShowModePage((previous) => !previous)}
          >
            {showModePage ? 'Masquer les modes' : 'Ouvrir les modes'}
          </button>
        </div>

        <p className="modes-help">
          Configurez les modes avant de lancer les projets. Le launcher injecte ces valeurs
          automatiquement pour éviter les prompts interactifs dans le terminal.
        </p>

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
                  <label htmlFor="pfd-joystick">Nom joystick</label>
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
                <>
                  <div className="mode-row two-cols">
                    <div>
                      <label htmlFor="pfd-xplane-ip">IP X-Plane</label>
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
                      <label htmlFor="pfd-xplane-port">Port UDP</label>
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
                </>
              ) : null}

              {pfdConfig.mode === '3' ? (
                <div className="mode-row two-cols">
                  <div>
                    <label htmlFor="pfd-msp-port">Port MSP</label>
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
                    <option value="1">Mode 1 - Manuel</option>
                    <option value="2">Mode 2 - X-Plane UDP</option>
                    <option value="3">Mode 3 - MSP GPS</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="nav-layout">Affichage</label>
                  <select
                    id="nav-layout"
                    value={navConfig.layout}
                    disabled={modeEditorDisabled}
                    onChange={(event) => {
                      updateLaunchConfig('navigation-display', 'layout', event.target.value)
                    }}
                  >
                    <option value="1">Complet (panneaux + carte)</option>
                    <option value="2">Carte centrale uniquement</option>
                  </select>
                </div>
              </div>

              {navConfig.mode === '2' ? (
                <>
                  <div className="mode-row two-cols">
                    <div>
                      <label htmlFor="nav-xplane-ip">IP X-Plane</label>
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
                      <label htmlFor="nav-xplane-port">Port distant</label>
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
                    <label htmlFor="nav-xplane-local-port">Port local d&apos;écoute</label>
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
                    <label htmlFor="nav-msp-port">Port MSP</label>
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

      <main className="dashboard">
        <section className="projects-panel fade-in delay-3">
          <div className="panel-head">
            <h2>Modules du simulateur</h2>
            <span>{projects.length} projets</span>
          </div>

          {!electronReady ? (
            <p className="placeholder">
              Mode navigateur détecté. Les actions système nécessitent Electron.
            </p>
          ) : (
            <div className="project-grid">
              {projects.map((project) => {
                const running = Boolean(statuses[project.id])
                const currentBusy = projectBusy[project.id]

                return (
                  <article key={project.id} className="project-card">
                    <div className="project-title-row">
                      <h3>{project.name}</h3>
                      <span className={`state ${running ? 'running' : 'stopped'}`}>
                        {running ? 'En cours' : 'À l\'arrêt'}
                      </span>
                    </div>

                    <p className="project-meta">{project.repo}</p>
                    <p className="project-path">{project.path}</p>

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
                        onClick={() => runProjectAction(project.id, 'Installation', 'installProject')}
                      >
                        Installer
                      </button>
                      <button
                        type="button"
                        disabled={controlsDisabled || running || Boolean(currentBusy)}
                        onClick={() => runProjectAction(project.id, 'Lancement', 'launchProject')}
                      >
                        Lancer
                      </button>
                      <button
                        className="danger"
                        type="button"
                        disabled={isLoading || !running || Boolean(currentBusy)}
                        onClick={() => runProjectAction(project.id, 'Arrêt', 'stopProject')}
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
            <h2>Journal d&apos;exécution</h2>
            <button type="button" className="ghost" onClick={() => setLogs([])}>
              Effacer
            </button>
          </div>

          {latestLogs.length === 0 ? (
            <p className="placeholder">Aucun événement pour le moment.</p>
          ) : (
            <ul className="log-list">
              {latestLogs.map((entry, index) => {
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
  )
}

export default App
