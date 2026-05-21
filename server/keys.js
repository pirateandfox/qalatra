import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

function keyPath(dataDir) {
  return process.env.QALATRA_KEY_FILE || path.join(dataDir, 'server-keystore')
}

function normalizeKey(base64) {
  const key = Buffer.from(String(base64 || '').trim(), 'base64')
  if (key.length !== 32) throw new Error('Invalid key; must be 32 bytes (256-bit)')
  return key
}

export function loadEncryptionKey(dataDir) {
  if (process.env.QALATRA_ENCRYPTION_KEY) {
    return normalizeKey(process.env.QALATRA_ENCRYPTION_KEY)
  }

  try {
    return normalizeKey(fs.readFileSync(keyPath(dataDir), 'utf8'))
  } catch {
    return null
  }
}

export function saveEncryptionKey(dataDir, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid key; must be 32 bytes (256-bit)')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(keyPath(dataDir), `${key.toString('base64')}\n`, { mode: 0o600 })
  return { ok: true }
}

export function keyStatus(dataDir) {
  return { present: !!loadEncryptionKey(dataDir), serverManaged: true }
}

export function generateKey(dataDir) {
  saveEncryptionKey(dataDir, crypto.randomBytes(32))
  return { ok: true }
}

export function exportKey(dataDir) {
  const key = loadEncryptionKey(dataDir)
  if (!key) return { ok: false, error: 'No key found' }
  return { ok: true, key: key.toString('base64') }
}

export function importKey(dataDir, base64) {
  try {
    saveEncryptionKey(dataDir, normalizeKey(base64))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
