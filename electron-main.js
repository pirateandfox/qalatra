import { app, BrowserWindow, shell, nativeImage, dialog, utilityProcess, Menu, ipcMain } from 'electron'
import http from 'http'
import { createServer } from 'net'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = process.env.NODE_ENV === 'development'
const API_PORT = 3456
const DEV_PORT = 5173

let apiProcess = null
let mcpProcess = null

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
    const devDb = path.join(os.homedir(), 'IdeaProjects', 'task-os', 'db', 'tasks.db')
    const devSettings = path.join(os.homedir(), 'IdeaProjects', 'task-os', 'db', 'settings.json')

    if (fs.existsSync(devDb)) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Copy my data', 'Start fresh'],
        defaultId: 0,
        title: 'Task OS — First Launch',
        message: 'Found existing Task OS data',
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
  console.log(`Task OS starting — version ${app.getVersion()} pid=${process.pid}`)
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

async function startBackends(dbDir) {
  console.log(`startBackends: dbDir=${dbDir}`)
  const env = {
    ...process.env,
    TASKOS_DB_DIR: dbDir,
    TASKOS_SETTINGS_FILE: path.join(dbDir, 'settings.json'),
  }

  // API server
  const apiTaken = await isPortTaken(API_PORT)
  if (apiTaken) {
    console.log(`api already running on :${API_PORT}`)
  } else {
    console.log(`starting api: ${getEntryPath('api-entry.cjs')}`)
    apiProcess = utilityProcess.fork(getEntryPath('api-entry.cjs'), [], {
      stdio: 'pipe',
      env,
    })
    pipeToLog(apiProcess, 'api')
    apiProcess.on('exit', (code, signal) => {
      if (signal !== 'SIGTERM' && code !== 0) {
        console.error(`api exited: code=${code} signal=${signal}`)
        dialog.showMessageBox({
          type: 'error',
          title: 'Task OS — Backend Crashed',
          message: 'The API process exited unexpectedly.',
          detail: `Exit code: ${code}. Tasks cannot be loaded until the app is restarted.\n\nLog: ${app.getPath('logs')}/main.log`,
          buttons: ['Restart Now', 'Dismiss'],
          defaultId: 0,
        }).then(({ response }) => {
          if (response === 0) { app.relaunch(); app.quit() }
        })
      }
      apiProcess = null
    })
  }

  // MCP HTTP server — read port from settings if available
  let mcpPort = 3457
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dbDir, 'settings.json'), 'utf8'))
    if (s.mcpPort) mcpPort = parseInt(s.mcpPort, 10)
  } catch {}

  const mcpTaken = await isPortTaken(mcpPort)
  if (mcpTaken) {
    console.log(`mcp already running on :${mcpPort}`)
  } else {
    mcpProcess = utilityProcess.fork(getEntryPath('mcp/http-server-entry.cjs'), [], {
      stdio: 'pipe',
      env,
    })
    pipeToLog(mcpProcess, 'mcp')
    mcpProcess.on('exit', (code, signal) => {
      if (signal !== 'SIGTERM' && code !== 0) console.error(`mcp exited: code=${code} signal=${signal}`)
      mcpProcess = null
    })
  }

  // Wait for API to be ready (up to 15 seconds — accounts for cold starts on new machines)
  if (!isDev) {
    for (let i = 0; i < 75; i++) {
      const ready = await new Promise(resolve => {
        const req = http.request({ hostname: '127.0.0.1', port: API_PORT, path: '/', method: 'GET' }, () => resolve(true))
        req.on('error', () => resolve(false))
        req.setTimeout(150, () => { req.destroy(); resolve(false) })
        req.end()
      })
      if (ready) break
      await new Promise(r => setTimeout(r, 200))
    }
  } else {
    await new Promise(resolve => setTimeout(resolve, 600))
  }
}

// ── Auto-updater ──────────────────────────────────────────────────────────────

let _autoUpdater = null

async function getAutoUpdater() {
  if (_autoUpdater) return _autoUpdater
  const mod = await import('electron-updater')
  const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater ?? mod.default
  autoUpdater.logger = { info: m => console.log('[updater]', m), warn: m => console.warn('[updater]', m), error: m => console.error('[updater]', m) }
  autoUpdater.on('checking-for-update', () => console.log('[updater] Checking for update...'))
  autoUpdater.on('update-not-available', info => console.log('[updater] Up to date:', info.version))
  autoUpdater.on('update-available', info => {
    console.log('[updater] Update available:', info.version)
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setProgressBar(0.01) // start indeterminate-ish progress in dock
  })
  autoUpdater.on('download-progress', p => {
    console.log(`[updater] Downloading: ${Math.round(p.percent)}%`)
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setProgressBar(p.percent / 100)
  })
  autoUpdater.on('update-downloaded', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setProgressBar(-1) // clear dock progress
    dialog.showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: 'A new version of Task OS is ready.',
      detail: 'It will be installed the next time you restart the app.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall()
    })
  })
  autoUpdater.on('error', err => {
    console.error('[updater] Error:', err.message)
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setProgressBar(-1) // clear dock progress on error
    // Only show a dialog for manual checks — suppress the noisy startup check errors
    // (those just log to the file). The manual check path sets a flag we read here.
    if (!autoUpdater._silentCheck) {
      const isAvailability = /404|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|certificate|getaddrinfo|net::/i.test(err.message)
      dialog.showMessageBox({
        type: 'warning',
        title: 'Update check failed',
        message: isAvailability ? 'Update server not currently available.' : 'Could not check for updates.',
        detail: isAvailability
          ? 'The update server may still be building the latest release. Please try again in a few minutes.'
          : err.message.slice(0, 300),
        buttons: ['OK'],
      })
    }
  })
  _autoUpdater = autoUpdater
  return autoUpdater
}

function setupAutoUpdater() {
  if (isDev) return
  getAutoUpdater().then(au => {
    au._silentCheck = true  // suppress error dialogs on background startup check
    // checkForUpdates() both emits 'error' AND rejects the promise — catch both
    au.checkForUpdates().catch(err => console.error('[updater] silent check failed:', err.message))
  }).catch(err => console.error('[updater] init error:', err.message))
}

async function checkForUpdatesManually() {
  if (isDev) {
    dialog.showMessageBox({ type: 'info', title: 'Dev mode', message: 'Auto-updater is disabled in dev mode.' })
    return
  }
  try {
    const au = await getAutoUpdater()
    au._silentCheck = false  // show error dialogs for manual checks
    await au.checkForUpdates()
  } catch (err) {
    console.error('[updater] manual check error:', err.message)
  }
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Task OS',
    icon: path.join(__dirname, 'assets/icon.png'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 20 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
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
    const uiPath = path.join(__dirname, 'ui', 'dist', 'index.html')
    console.log(`[window] loadFile: ${uiPath}`)
    console.log(`[window] uiPath exists: ${fs.existsSync(uiPath)}`)
    win.loadFile(uiPath)
  }
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

app.whenReady().then(async () => {
  setupLogging()

  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets/icon.png'))
  app.dock?.setIcon(icon)

  // In dev, data stays in the project's db/ dir; in production, migrate to userData
  const dbDir = isDev
    ? path.join(__dirname, 'db')
    : await ensureUserData()

  if (!isDev) await startBackends(dbDir)
  setupMenu()
  createWindow()
  setupAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  apiProcess?.kill()
  mcpProcess?.kill()
})
