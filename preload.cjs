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
})
