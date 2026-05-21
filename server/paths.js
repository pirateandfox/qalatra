import os from 'os'
import path from 'path'
import fs from 'fs'

export function defaultDataDir() {
  if (process.env.QALATRA_DATA_DIR) return process.env.QALATRA_DATA_DIR
  if (process.env.TASKOS_DB_DIR) return process.env.TASKOS_DB_DIR
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(base, 'Qalatra', 'db')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Qalatra', 'db')
  }
  return path.join(os.homedir(), '.local', 'share', 'qalatra', 'db')
}

export function ensureDataDir(dataDir = defaultDataDir()) {
  fs.mkdirSync(dataDir, { recursive: true })
  return dataDir
}

export function settingsPath(dataDir) {
  return process.env.TASKOS_SETTINGS_FILE || path.join(dataDir, 'settings.json')
}
