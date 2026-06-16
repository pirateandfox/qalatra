import { app, BrowserWindow, shell, nativeImage, dialog, Menu, ipcMain, safeStorage, clipboard } from 'electron'
import { createServer } from 'net'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { execFileSync, spawn } from 'child_process'
import pty from 'node-pty'
import {
  getServiceDescriptor,
  getServiceStatus,
  installService,
  restartService,
  startService,
  stopService,
  uninstallService,
} from './server/service-manager.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
app.name = 'Qalatra'
const isDev = process.env.NODE_ENV === 'development'
const DEV_PORT = 5173

let apiProcess = null
let activeDbDir = null
let ptyProcess = null

// ── Port check ────────────────────────────────────────────────────────────────

function isPortTaken(port) {
  return new Promise(resolve => {
    const tester = createServer()
      .once('error', () => resolve(true))
      .once('listening', () => tester.close(() => resolve(false)))
      .listen(port, '127.0.0.1')
  })
}

// ── Data directory setup & migration ─────────────────────────────────────────

async function ensureUserData() {
  const userData = app.getPath('userData')
  const dbDir = path.join(userData, 'db')
  const targetDb = path.join(dbDir, 'tasks.db')
  const targetSettings = path.join(dbDir, 'settings.json')

  fs.mkdirSync(dbDir, { recursive: true })

  if (!fs.existsSync(targetDb)) {
    // Check for Task OS data first (rename upgrade path)
    const taskOsDir = path.join(app.getPath('appData'), 'Task OS', 'db')
    const taskOsDb  = path.join(taskOsDir, 'tasks.db')

    if (fs.existsSync(taskOsDb)) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Migrate my data', 'Start fresh'],
        defaultId: 0,
        title: 'Welcome to Qalatra',
        message: 'Your Task OS data was found',
        detail: 'Qalatra is the new name for Task OS. Your tasks, notes, habits, and history will be migrated automatically.\n\nYour original Task OS data is not affected.',
      })
      if (response === 0) {
        for (const file of ['tasks.db', 'tasks.db-wal', 'tasks.db-shm', 'settings.json']) {
          const src = path.join(taskOsDir, file)
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dbDir, file))
        }
        console.log('Migrated Task OS data to', dbDir)
      }
    } else {
      // On first production launch, offer to migrate existing dev data
      const devDb = path.join(os.homedir(), 'IdeaProjects', 'qalatra', 'db', 'tasks.db')
      const devSettings = path.join(os.homedir(), 'IdeaProjects', 'qalatra', 'db', 'settings.json')

      if (fs.existsSync(devDb)) {
        const { response } = await dialog.showMessageBox({
          type: 'question',
          buttons: ['Copy my data', 'Start fresh'],
          defaultId: 0,
          title: 'Qalatra — First Launch',
          message: 'Found existing Qalatra data',
          detail: `Copy your database from:\n${devDb}\n\nto the app data directory?`,
        })
        if (response === 0) {
          fs.copyFileSync(devDb, targetDb)
          for (const ext of ['-wal', '-shm']) {
            if (fs.existsSync(devDb + ext)) fs.copyFileSync(devDb + ext, targetDb + ext)
          }
          if (fs.existsSync(devSettings)) fs.copyFileSync(devSettings, targetSettings)
          console.log('Data migrated to', dbDir)
        }
      }
    }
  }

  return dbDir
}

// ── Logging ───────────────────────────────────────────────────────────────────

let logStream = null

function setupLogging() {
  if (isDev) return
  const logDir = app.getPath('logs')
  fs.mkdirSync(logDir, { recursive: true })
  const logFile = path.join(logDir, 'main.log')
  logStream = fs.createWriteStream(logFile, { flags: 'a' })
  const tag = () => `[${new Date().toISOString()}]`
  const orig = { log: console.log, error: console.error, warn: console.warn }
  console.log   = (...a) => { orig.log(...a);   logStream.write(`${tag()} INFO  ${a.join(' ')}\n`) }
  console.error = (...a) => { orig.error(...a); logStream.write(`${tag()} ERROR ${a.join(' ')}\n`) }
  console.warn  = (...a) => { orig.warn(...a);  logStream.write(`${tag()} WARN  ${a.join(' ')}\n`) }
  console.log(`Qalatra starting — version ${app.getVersion()} pid=${process.pid}`)
}

// ── Backend processes ─────────────────────────────────────────────────────────

function getEntryPath(filename) {
  return path.join(__dirname, filename)
}

function pipeToLog(proc, label) {
  if (!proc.stdout || !proc.stderr) return
  proc.stdout.on('data', d => console.log(`[${label}]`, d.toString().trim()))
  proc.stderr.on('data', d => console.error(`[${label}]`, d.toString().trim()))
}

async function clearPort(port, label = 'port') {
  const taken = await isPortTaken(port)
  if (!taken) return
  console.log(`[${label}] port ${port} in use — killing stale process`)
  try {
    const pids = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' }).trim()
    if (pids) execFileSync('kill', ['-9', ...pids.split('\n').filter(Boolean)])
  } catch {}
  await new Promise(r => setTimeout(r, 500))
}

function readApiPort(dbDir) {
  const s = readLocalSettings(dbDir)
  if (s.apiPort) return parseInt(s.apiPort, 10)
  return 3456
}

function readLocalSettings(dbDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dbDir, 'settings.json'), 'utf8')) } catch { return {} }
}

function settingEnabled(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes'
}

function shouldKeepServerRunning(dbDir) {
  return settingEnabled(readLocalSettings(dbDir).keepServerRunning)
}

function readLocalApiToken(dbDir) {
  try { return fs.readFileSync(path.join(dbDir, 'admin-token.txt'), 'utf8').trim() } catch { return null }
}

async function isLocalApiHealthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    return res.ok
  } catch {
    return false
  }
}

async function waitForLocalApi(port) {
  for (let i = 0; i < 30; i++) {
    if (await isLocalApiHealthy(port)) return true
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

function getEncryptionKeyForServerEnv(dbDir) {
  try {
    const encrypted = fs.readFileSync(path.join(dbDir, 'keystore'))
    return safeStorage.decryptString(encrypted)
  } catch {
    return null
  }
}

function ensureServerEncryptionKey(dbDir) {
  const serverKeyPath = path.join(dbDir, 'server-keystore')
  if (fs.existsSync(serverKeyPath)) return true
  const key = getEncryptionKeyForServerEnv(dbDir)
  if (!key) return false
  try {
    const decoded = Buffer.from(String(key).trim(), 'base64')
    if (decoded.length !== 32) return false
    fs.writeFileSync(serverKeyPath, `${String(key).trim()}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

function getLocalServerServiceOptions(dbDir) {
  return {
    dataDir: dbDir,
    apiHost: '127.0.0.1',
    apiPort: readApiPort(dbDir),
    mcpHost: '127.0.0.1',
    runtimePath: process.execPath,
    useElectronRunAsNode: true,
    serverPath: getEntryPath('server/index.js'),
    workingDir: __dirname,
    startMcp: true,
    startWorkers: true,
  }
}

function localServerServiceEnabled() {
  return !isDev || process.env.QALATRA_DEV_USE_SERVICE === '1'
}

function disabledLocalServerServiceStatus(dbDir) {
  return {
    ...getServiceDescriptor(getLocalServerServiceOptions(dbDir)),
    supported: false,
    installed: false,
    running: false,
    enabled: false,
    disabledInDev: true,
    error: 'Start at Login is disabled in electron-dev. Set QALATRA_DEV_USE_SERVICE=1 to test OS service management.',
  }
}

function disabledLocalServerServiceResult(dbDir) {
  const status = disabledLocalServerServiceStatus(dbDir)
  return { ok: false, error: status.error, status }
}

function getLocalServerServiceStatus(dbDir) {
  if (!localServerServiceEnabled()) return disabledLocalServerServiceStatus(dbDir)
  return getServiceStatus(getLocalServerServiceOptions(dbDir))
}

async function installLocalServerService(dbDir) {
  if (!localServerServiceEnabled()) return disabledLocalServerServiceResult(dbDir)
  ensureServerEncryptionKey(dbDir)
  const options = getLocalServerServiceOptions(dbDir)
  if (getServiceStatus(options).installed) stopService(options)
  await stopLocalApiServer(dbDir, { clearAnyProcessOnPort: true })
  const result = installService(options)
  if (result.ok) await waitForLocalApi(readApiPort(dbDir))
  return result
}

async function uninstallLocalServerService(dbDir) {
  if (!localServerServiceEnabled()) return disabledLocalServerServiceResult(dbDir)
  const result = uninstallService(getLocalServerServiceOptions(dbDir))
  if (result.ok) await startLocalApiServer(dbDir)
  return result
}

async function startLocalServerService(dbDir) {
  if (!localServerServiceEnabled()) return disabledLocalServerServiceResult(dbDir)
  const options = getLocalServerServiceOptions(dbDir)
  const status = getServiceStatus(options)
  if (!status.installed) return { ok: false, error: 'Local server service is not installed' }
  ensureServerEncryptionKey(dbDir)
  if (apiProcess) {
    apiProcess.kill('SIGTERM')
    apiProcess = null
    await new Promise(r => setTimeout(r, 300))
  }
  const result = startService(options)
  if (result.ok) await waitForLocalApi(readApiPort(dbDir))
  return result
}

async function stopLocalServerService(dbDir) {
  if (!localServerServiceEnabled()) return disabledLocalServerServiceResult(dbDir)
  const result = stopService(getLocalServerServiceOptions(dbDir))
  return result
}

async function restartLocalServerService(dbDir) {
  if (!localServerServiceEnabled()) return disabledLocalServerServiceResult(dbDir)
  ensureServerEncryptionKey(dbDir)
  if (apiProcess) {
    apiProcess.kill('SIGTERM')
    apiProcess = null
    await new Promise(r => setTimeout(r, 300))
  }
  const result = restartService(getLocalServerServiceOptions(dbDir))
  if (result.ok) await waitForLocalApi(readApiPort(dbDir))
  return result
}

async function ensureLocalServerRunning(dbDir, { restart = false } = {}) {
  const service = getLocalServerServiceStatus(dbDir)
  if (service.installed) {
    const result = restart ? await restartLocalServerService(dbDir) : await startLocalServerService(dbDir)
    if (result.ok || await isLocalApiHealthy(readApiPort(dbDir))) {
      return { ...(await localApiStatus(dbDir)), ok: true }
    }
  }
  return startLocalApiServer(dbDir, { restart })
}

async function startLocalApiServer(dbDir, { restart = false } = {}) {
  const apiPort = readApiPort(dbDir)
  const healthy = await isLocalApiHealthy(apiPort)
  if (healthy && !restart) {
    return await localApiStatus(dbDir)
  }
  if (apiProcess && !restart) {
    apiProcess.kill('SIGTERM')
    apiProcess = null
    await new Promise(r => setTimeout(r, 300))
  }
  if (apiProcess) {
    apiProcess.kill('SIGTERM')
    apiProcess = null
    await new Promise(r => setTimeout(r, 300))
  }

  await clearPort(apiPort, 'api')
  const serverPath = getEntryPath('server/index.js')
  ensureServerEncryptionKey(dbDir)
  const encryptionKey = getEncryptionKeyForServerEnv(dbDir)
  const keepRunning = shouldKeepServerRunning(dbDir)
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    QALATRA_DATA_DIR: dbDir,
    QALATRA_API_HOST: '127.0.0.1',
    QALATRA_API_PORT: String(apiPort),
    QALATRA_START_MCP: '1',
    QALATRA_START_WORKERS: '1',
    QALATRA_BACKUP_ON_SHUTDOWN: '0',
    QALATRA_BOOTSTRAP_TOKEN_FILE: '1',
    ...(encryptionKey ? { QALATRA_ENCRYPTION_KEY: encryptionKey } : {}),
  }
  console.log(`[api] starting local server on :${apiPort}${keepRunning ? ' (detached)' : ''}`)
  const child = spawn(process.execPath, [serverPath], keepRunning
    ? { detached: true, stdio: 'ignore', env }
    : { stdio: 'pipe', env })
  if (keepRunning) {
    child.unref()
    apiProcess = null
  } else {
    apiProcess = child
    pipeToLog(apiProcess, 'api')
    apiProcess.on('exit', (code, signal) => {
      apiProcess = null
      if (signal === 'SIGTERM') return
      console.error(`[api] exited: code=${code} signal=${signal}`)
    })
  }

  const ready = await waitForLocalApi(apiPort)
  return { ...(await localApiStatus(dbDir)), ok: ready, running: ready }
}

async function runLocalServerBackup(dbDir) {
  const token = readLocalApiToken(dbDir)
  if (!token) return { ok: false, error: 'Local server token is missing' }
  const port = readApiPort(dbDir)
  if (!(await isLocalApiHealthy(port))) return { ok: false, error: 'Local server is not running' }
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/backup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) return { ok: false, error: data.error || `HTTP ${res.status}` }
  return data.result ?? data
}

async function stopLocalApiServer(dbDir, { clearAnyProcessOnPort = false } = {}) {
  if (apiProcess) {
    apiProcess.kill('SIGTERM')
    apiProcess = null
  }
  if (clearAnyProcessOnPort) await clearPort(readApiPort(dbDir), 'api')
  return { ok: true }
}

async function localApiStatus(dbDir) {
  const port = readApiPort(dbDir)
  const running = !!apiProcess || await isLocalApiHealthy(port)
  const service = getLocalServerServiceStatus(dbDir)
  return {
    running,
    port,
    url: `http://127.0.0.1:${port}`,
    token: readLocalApiToken(dbDir),
    keepServerRunning: shouldKeepServerRunning(dbDir),
    managed: !!apiProcess,
    service,
  }
}

// ── Auto-updater ──────────────────────────────────────────────────────────────

let _autoUpdater = null

function sendUpdaterStatus(status, payload = {}) {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) win.webContents.send('updater:status', { status, ...payload })
}

async function getAutoUpdater() {
  if (_autoUpdater) return _autoUpdater
  const mod = await import('electron-updater')
  const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater ?? mod.default
  autoUpdater.autoDownload = false
  autoUpdater.logger = { info: m => console.log('[updater]', m), warn: m => console.warn('[updater]', m), error: m => console.error('[updater]', m) }
  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] Checking for update...')
    if (autoUpdater._verbose) sendUpdaterStatus('checking')
  })
  autoUpdater.on('update-not-available', info => {
    console.log('[updater] Up to date:', info.version)
    if (autoUpdater._verbose) sendUpdaterStatus('not-available', { version: info.version })
  })
  autoUpdater.on('update-available', info => {
    console.log('[updater] Update available:', info.version)
    // Always show the banner when an update is found — whether from manual check or scheduled poll
    sendUpdaterStatus('available', { version: info.version })
  })
  autoUpdater.on('download-progress', p => {
    console.log(`[updater] Downloading: ${Math.round(p.percent)}%`)
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setProgressBar(p.percent / 100)
    sendUpdaterStatus('downloading', { percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', info => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setProgressBar(-1)
    sendUpdaterStatus('downloaded', { version: info.version })
  })
  autoUpdater.on('error', err => {
    console.error('[updater] Error:', err.message, err.stack)
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setProgressBar(-1)
    if (autoUpdater._verbose) {
      const isAvailability = /404|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|certificate|getaddrinfo|net::/i.test(err.message)
      const msg = isAvailability ? 'Update server not currently available.' : `Update error: ${err.message}`
      sendUpdaterStatus('error', { message: msg })
    }
  })
  _autoUpdater = autoUpdater
  return autoUpdater
}

async function pollForUpdates(verbose = false) {
  try {
    const au = await getAutoUpdater()
    au._verbose = verbose
    await au.checkForUpdates()
  } catch (err) {
    console.error('[updater] poll error:', err.message)
  }
}

function setupAutoUpdater() {
  if (isDev) return
  // Check on launch, then every 4 hours
  pollForUpdates(false)
  setInterval(() => pollForUpdates(false), 4 * 60 * 60 * 1000)
}

async function checkForUpdatesManually() {
  if (isDev) {
    sendUpdaterStatus('checking')
    setTimeout(() => sendUpdaterStatus('not-available', { version: 'dev' }), 1000)
    return
  }
  await pollForUpdates(true)
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Qalatra',
    icon: path.join(__dirname, 'assets/icon.png'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 20 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      // Disable Chromium web security so the renderer can POST to localhost.
      // Chromium's Private Network Access policy silently blocks POST+JSON
      // preflights to 127.0.0.1 on some systems even when the page is same-origin.
      // This is a local desktop app — all communication is with its own backend.
      webSecurity: false,
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Intercept in-window navigation (plain <a href> without target="_blank").
  // The app itself loads from localhost:5173 (dev) or file:// (prod) — any
  // other http/https URL is an external link and must open in the system browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (/^https?:\/\//.test(url) && !url.startsWith('http://localhost:5173')) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  // Forward renderer console messages to main.log so we can diagnose remote issues
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['verbose', 'info', 'warn', 'error'][level] ?? 'info'
    const src = sourceId ? ` (${path.basename(sourceId)}:${line})` : ''
    if (tag === 'error' || tag === 'warn') {
      console.error(`[renderer:${tag}]${src} ${message}`)
    } else {
      console.log(`[renderer:${tag}]${src} ${message}`)
    }
  })

  win.webContents.on('did-finish-load', () => console.log('[window] did-finish-load'))
  win.webContents.on('did-fail-load', (_e, code, desc) => console.error(`[window] did-fail-load code=${code} desc=${desc}`))
  win.webContents.on('render-process-gone', (_e, details) => console.error(`[window] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`))
  win.webContents.on('unresponsive', () => console.error('[window] renderer unresponsive'))

  if (isDev) {
    win.loadURL(`http://localhost:${DEV_PORT}`)
    win.webContents.openDevTools()
  } else {
    // Desktop shell loads the bundled UI; data goes through Qalatra Server.
    const uiPath = path.join(__dirname, 'ui', 'dist', 'index.html')
    console.log(`[window] loadFile: ${uiPath}`)
    win.loadFile(uiPath)
  }
  return win
}

// ── Menu ──────────────────────────────────────────────────────────────────────

function setupMenu() {
  const template = [
    {
      label: 'Qalatra',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => checkForUpdatesManually() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Open File…',
          accelerator: 'CmdOrCtrl+O',
          async click() {
            const win = BrowserWindow.getFocusedWindow()
            if (!win) return
            const { canceled, filePaths } = await dialog.showOpenDialog(win, {
              properties: ['openFile'],
              filters: [
                { name: 'Supported Files', extensions: ['md', 'html', 'eml'] },
                { name: 'All Files', extensions: ['*'] },
              ],
            })
            if (!canceled && filePaths.length > 0) {
              win.webContents.send('open-file', filePaths[0])
            }
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

// ── Terminal IPC ──────────────────────────────────────────────────────────────
// Spawns node-pty in the main process and streams output to the renderer via webContents.send.

function setupTerminalIpc(win) {
  ipcMain.handle('terminal:start', async (_, cols, rows) => {
    if (ptyProcess) { try { ptyProcess.kill() } catch {} ptyProcess = null }
    let cwd = os.homedir()
    try {
      const s = JSON.parse(fs.readFileSync(path.join(win._dbDir || os.homedir(), 'settings.json'), 'utf8'))
      if (s.terminalCwd) cwd = s.terminalCwd
    } catch {}
    try {
      if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory')
    } catch (err) {
      console.warn(`[terminal] configured cwd is unavailable (${cwd}); falling back to ${os.homedir()}: ${err.message}`)
      cwd = os.homedir()
    }
    const shell = process.platform === 'win32'
      ? (process.env.ComSpec || 'cmd.exe')
      : (process.env.SHELL || '/bin/zsh')
    console.log(`[terminal] spawning pty: shell=${shell} cwd=${cwd}`)
    let thisPty
    try {
      thisPty = pty.spawn(shell, [], { name: 'xterm-256color', cols: cols || 80, rows: rows || 24, cwd, env: process.env })
    } catch (err) {
      console.error(`[terminal] failed to spawn pty: ${err.message}`)
      throw err
    }
    ptyProcess = thisPty
    thisPty.onData(data => { if (!win.isDestroyed()) win.webContents.send('terminal:output', data) })
    thisPty.onExit(({ exitCode }) => {
      console.log(`[terminal] pty exited code=${exitCode}`)
      // Only clear ptyProcess and notify the renderer if this is still the active pty.
      // If terminal:start was called again before this fires (e.g. panel reopen), the
      // old pty's exit must NOT null out the new pty or trigger a "Process exited" message.
      if (ptyProcess === thisPty) {
        ptyProcess = null
        if (!win.isDestroyed()) win.webContents.send('terminal:exit', exitCode)
      }
    })
    console.log(`[terminal] pty spawned pid=${thisPty.pid}`)
    return { ok: true }
  })
  ipcMain.on('terminal:input', (_, data) => { ptyProcess?.write(data) })
  ipcMain.on('terminal:resize', (_, cols, rows) => { try { ptyProcess?.resize(cols, rows) } catch {} })
  // Clipboard writes must go through the main process: the preload runs sandboxed,
  // where require('electron') does not expose the `clipboard` module.
  ipcMain.on('clipboard:write', (_, text) => { try { clipboard.writeText(String(text ?? '')) } catch {} })
}

function setupUpdaterIpc() {
  ipcMain.handle('updater:check', () => checkForUpdatesManually())
  ipcMain.handle('updater:download', async () => {
    const au = await getAutoUpdater().catch(() => null)
    if (au) au.downloadUpdate().catch(err => console.error('[updater] download error:', err.message))
  })
  ipcMain.handle('updater:install', async () => {
    const au = await getAutoUpdater().catch(() => null)
    if (!au) return
    try {
      console.log('[updater] quitAndInstall called')
      au.quitAndInstall()
    } catch (err) {
      console.error('[updater] quitAndInstall error:', err.message, err.stack)
      sendUpdaterStatus('error', { message: `Install error: ${err.message}` })
    }
  })
}

function setupLocalApiIpc(dbDir) {
  ipcMain.handle('server:status', () => localApiStatus(dbDir))
  ipcMain.handle('server:start', () => ensureLocalServerRunning(dbDir))
  ipcMain.handle('server:restart', () => ensureLocalServerRunning(dbDir, { restart: true }))
  ipcMain.handle('server:stop', async () => {
    const service = getLocalServerServiceStatus(dbDir)
    if (service.installed) await stopLocalServerService(dbDir)
    return stopLocalApiServer(dbDir, { clearAnyProcessOnPort: true })
  })
  ipcMain.handle('server:service-status', () => getLocalServerServiceStatus(dbDir))
  ipcMain.handle('server:service-install', () => installLocalServerService(dbDir))
  ipcMain.handle('server:service-uninstall', () => uninstallLocalServerService(dbDir))
  ipcMain.handle('server:service-start', () => startLocalServerService(dbDir))
  ipcMain.handle('server:service-stop', () => stopLocalServerService(dbDir))
  ipcMain.handle('server:service-restart', () => restartLocalServerService(dbDir))
}

app.whenReady().then(async () => {
  setupLogging()

  const iconFile = process.platform === 'darwin' ? 'icon.icns' : 'icon.png'
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', iconFile))
  app.dock?.setIcon(icon)

  // In dev, data stays in the project's db/ dir; in production, migrate to userData
  const dbDir = isDev
    ? path.join(__dirname, 'db')
    : await ensureUserData()
  activeDbDir = dbDir

  // Apply any pending DB restore before opening the worker
  const restorePending = path.join(dbDir, 'tasks.db.restore')
  if (fs.existsSync(restorePending)) {
    const dbPath = path.join(dbDir, 'tasks.db')
    console.log('[restore] applying pending DB restore')
    try {
      fs.copyFileSync(dbPath, `${dbPath}.pre-restore`)
      fs.renameSync(restorePending, dbPath)
      for (const ext of ['-wal', '-shm']) {
        const f = dbPath + ext
        if (fs.existsSync(f)) { try { fs.unlinkSync(f) } catch {} }
      }
      console.log('[restore] DB restored successfully')
    } catch (e) { console.error('[restore] failed:', e.message) }
  }

  setupLocalApiIpc(dbDir)
  await ensureLocalServerRunning(dbDir)

  setupMenu()
  const win = createWindow()
  win._dbDir = dbDir  // stash for terminal IPC
  setupTerminalIpc(win)
  setupUpdaterIpc()
  setupAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitFinalized = false
app.on('before-quit', (event) => {
  if (quitFinalized) return
  try { ptyProcess?.kill() } catch {}
  event.preventDefault()
  const keepRunning = activeDbDir ? shouldKeepServerRunning(activeDbDir) : false
  const finish = async () => {
    if (quitFinalized) return
    quitFinalized = true
    if (activeDbDir) {
      try {
        const service = getLocalServerServiceStatus(activeDbDir)
        if (service.installed) {
          // OS service owns lifecycle across login/restart.
        } else if (keepRunning) {
          if (apiProcess) await startLocalApiServer(activeDbDir, { restart: true })
        } else {
          await stopLocalApiServer(activeDbDir, { clearAnyProcessOnPort: true })
        }
      } catch {}
    }
    app.exit(0)
  }
  const timer = setTimeout(() => { finish() }, 10_000)
  const backup = activeDbDir ? runLocalServerBackup(activeDbDir) : Promise.resolve()
  backup
    .catch(() => {})
    .finally(() => { clearTimeout(timer); finish() })
})
