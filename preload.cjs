const { contextBridge, ipcRenderer } = require('electron')

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
  onAgentJobComplete: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('agent-job:complete', handler)
    return () => ipcRenderer.removeListener('agent-job:complete', handler)
  },

  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdaterStatus: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('updater:status', handler)
    return () => ipcRenderer.removeListener('updater:status', handler)
  },
})
