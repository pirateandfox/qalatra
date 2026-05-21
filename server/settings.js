import fs from 'fs'
import path from 'path'

let settingsFile = null

export function initSettings(file) {
  settingsFile = file
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
}

export function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')) } catch { return {} }
}

export function saveSettings(data) {
  fs.writeFileSync(settingsFile, JSON.stringify(data, null, 2))
}

export function getSettingsFile() {
  return settingsFile
}
