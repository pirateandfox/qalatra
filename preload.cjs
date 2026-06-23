const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  onOpenFile: (callback) => {
    ipcRenderer.on('open-file', (_event, filePath) => callback(filePath))
  },

  // Generic IPC invoke — used by api.ts to replace all fetch() calls
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),

  // Terminal IPC (replaces WebSocket)
  terminalStart: (cols, rows) => ipcRenderer.invoke('terminal:start', cols, rows),
  terminalInput: (data) => ipcRenderer.send('terminal:input', data),
  terminalResize: (cols, rows) => ipcRenderer.send('terminal:resize', cols, rows),
  onTerminalOutput: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('terminal:output', handler)
    return () => ipcRenderer.removeListener('terminal:output', handler)
  },
  onTerminalExit: (callback) => {
    const handler = (_event, code) => callback(code)
    ipcRenderer.on('terminal:exit', handler)
    return () => ipcRenderer.removeListener('terminal:exit', handler)
  },
  writeClipboard: (text) => ipcRenderer.send('clipboard:write', text),
  // Resolve a dragged-in File to its absolute path (File.path was removed in
  // modern Electron; webUtils is the sandbox-safe replacement). Used for
  // non-image files dropped onto the terminal on a same-machine backend.
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file) } catch { return '' } },
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdaterStatus: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('updater:status', handler)
    return () => ipcRenderer.removeListener('updater:status', handler)
  },
})
