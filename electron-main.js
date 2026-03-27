import { app, BrowserWindow, shell, nativeImage, dialog, utilityProcess, Menu, ipcMain } from 'electron'
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

// ── Backend processes ─────────────────────────────────────────────────────────

function getEntryPath(filename) {
  if (app.isPackaged) {
    // In packaged app, asarUnpack files live in app.asar.unpacked
    return path.join(process.resourcesPath, 'app.asar.unpacked', filename)
  }
  return path.join(__dirname, filename)
}

async function startBackends(dbDir) {
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
    apiProcess = utilityProcess.fork(getEntryPath('api-entry.cjs'), [], {
      stdio: isDev ? 'inherit' : 'pipe',
      env,
    })
    apiProcess.on('exit', (code, signal) => {
      if (signal !== 'SIGTERM' && code !== 0) console.error(`api exited: code=${code} signal=${signal}`)
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
      stdio: isDev ? 'inherit' : 'pipe',
      env,
    })
    mcpProcess.on('exit', (code, signal) => {
      if (signal !== 'SIGTERM' && code !== 0) console.error(`mcp exited: code=${code} signal=${signal}`)
      mcpProcess = null
    })
  }

  // Give backends a moment to bind their ports
  await new Promise(resolve => setTimeout(resolve, isDev ? 600 : 1000))
}

// ── Auto-updater ──────────────────────────────────────────────────────────────

function setupAutoUpdater() {
  if (isDev) return

  // Dynamic import so electron-updater is only loaded when needed
  import('electron-updater').then(({ autoUpdater }) => {
    autoUpdater.checkForUpdatesAndNotify()

    autoUpdater.on('update-downloaded', () => {
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

    autoUpdater.on('error', err => console.error('[updater]', err.message))
  }).catch(() => {})
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

  if (isDev) {
    win.loadURL(`http://localhost:${DEV_PORT}`)
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, 'ui/dist/index.html'))
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
