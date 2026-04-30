import { app, BrowserWindow, shell, nativeImage, dialog, utilityProcess, Menu, ipcMain } from 'electron'
import { createServer } from 'net'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'
import pty from 'node-pty'
import { initDbWorker, initSettings, setupIpcHandlers, startBackgroundWorkers } from './ipc-handlers.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = process.env.NODE_ENV === 'development'
const DEV_PORT = 5173

let mcpProcess = null
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

  // On first production launch, offer to migrate existing dev data
  if (!fs.existsSync(targetDb)) {
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

async function startMcpServer(dbDir) {
  const env = {
    ...process.env,
    TASKOS_DB_DIR: dbDir,
    TASKOS_SETTINGS_FILE: path.join(dbDir, 'settings.json'),
  }
  let mcpPort = 3457
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dbDir, 'settings.json'), 'utf8'))
    if (s.mcpPort) mcpPort = parseInt(s.mcpPort, 10)
  } catch {}

  const mcpTaken = await isPortTaken(mcpPort)
  if (mcpTaken) {
    console.log(`mcp already running on :${mcpPort}`)
    return
  }
  console.log(`starting mcp on :${mcpPort}`)
  mcpProcess = utilityProcess.fork(getEntryPath('mcp/http-server-entry.cjs'), [], { stdio: 'pipe', env })
  pipeToLog(mcpProcess, 'mcp')
  mcpProcess.on('exit', (code, signal) => {
    if (signal !== 'SIGTERM' && code !== 0) console.error(`mcp exited: code=${code} signal=${signal}`)
    mcpProcess = null
  })
}

function restartMcpServer(dbDir, newPort) {
  if (mcpProcess) { mcpProcess.kill(); mcpProcess = null }
  startMcpServer(dbDir).catch(err => console.error('[mcp] restart failed:', err.message))
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
    console.error('[updater] Error:', err.message)
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setProgressBar(-1)
    if (autoUpdater._verbose) {
      const isAvailability = /404|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|certificate|getaddrinfo|net::/i.test(err.message)
      sendUpdaterStatus('error', { message: isAvailability ? 'Update server not currently available.' : 'Could not check for updates.' })
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
    // All data goes through IPC now — no HTTP server needed. Load UI from disk.
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
      label: app.name,
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
    const settings = (await import('./ipc-handlers.js').catch(() => null))
    const { loadSettingsDirect } = await import('./ipc-handlers.js').catch(() => ({ loadSettingsDirect: () => ({}) }))
    let cwd = os.homedir()
    try {
      const s = JSON.parse(fs.readFileSync(path.join(win._dbDir || os.homedir(), 'settings.json'), 'utf8'))
      if (s.terminalCwd) cwd = s.terminalCwd
    } catch {}
    const shell = process.platform === 'win32'
      ? (process.env.ComSpec || 'cmd.exe')
      : (process.env.SHELL || '/bin/zsh')
    console.log(`[terminal] spawning pty: shell=${shell} cwd=${cwd}`)
    const thisPty = pty.spawn(shell, [], { name: 'xterm-256color', cols: cols || 80, rows: rows || 24, cwd, env: process.env })
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
}

function setupUpdaterIpc() {
  ipcMain.handle('updater:check', () => checkForUpdatesManually())
  ipcMain.handle('updater:download', async () => {
    const au = await getAutoUpdater().catch(() => null)
    if (au) au.downloadUpdate().catch(err => console.error('[updater] download error:', err.message))
  })
  ipcMain.handle('updater:install', async () => {
    const au = await getAutoUpdater().catch(() => null)
    if (au) au.quitAndInstall()
  })
}

app.whenReady().then(async () => {
  setupLogging()

  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets/icon.png'))
  app.dock?.setIcon(icon)

  // In dev, data stays in the project's db/ dir; in production, migrate to userData
  const dbDir = isDev
    ? path.join(__dirname, 'db')
    : await ensureUserData()

  // Initialise IPC handlers
  await initDbWorker(dbDir)
  initSettings(dbDir)
  setupIpcHandlers((newPort) => restartMcpServer(dbDir, newPort))
  startBackgroundWorkers()

  // MCP server (Claude integration) — always start via utilityProcess (dev and prod)
  await startMcpServer(dbDir)

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

app.on('before-quit', () => {
  try { ptyProcess?.kill() } catch {}
  mcpProcess?.kill()
})
