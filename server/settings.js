import fs from 'fs'
import path from 'path'

let settingsFile = null

export const DEFAULT_MAX_CONCURRENT_JOBS = 3
const validJobLimit = value => Number.isSafeInteger(value) && value >= 0

export function validateSettings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw Object.assign(new Error('Settings must be a JSON object'), { status: 400 })
  }
  if (Object.hasOwn(data, 'maxConcurrentJobs') && !validJobLimit(data.maxConcurrentJobs)) {
    throw Object.assign(new Error('maxConcurrentJobs must be a nonnegative safe integer'), { status: 400 })
  }
}

export function resolveMaxConcurrentJobs(settings, onWarn = console.error) {
  if (!Object.hasOwn(settings ?? {}, 'maxConcurrentJobs')) return DEFAULT_MAX_CONCURRENT_JOBS
  if (validJobLimit(settings.maxConcurrentJobs)) return settings.maxConcurrentJobs
  onWarn(`[workers] invalid persisted maxConcurrentJobs; using bounded default ${DEFAULT_MAX_CONCURRENT_JOBS}`)
  return DEFAULT_MAX_CONCURRENT_JOBS
}

export function initSettings(file) {
  settingsFile = file
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
}

export function loadSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings object')
    return settings
  } catch (err) {
    // Do not print a JSON parse error: it can include settings contents/credentials.
    if (err.code !== 'ENOENT') console.error('[settings] Unable to read a valid settings object; using defaults')
    return {}
  }
}

export function saveSettings(data) {
  validateSettings(data)
  fs.writeFileSync(settingsFile, JSON.stringify(data, null, 2))
}

export function getSettingsFile() {
  return settingsFile
}
