import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { decrypt, encrypt } from '../crypto.js'
import { deleteFromS3, downloadFromS3, getBackupS3Client, listS3Objects, uploadToS3 } from '../s3.js'
import { loadEncryptionKey } from './keys.js'

let lastBackupTime = null
let lastBackupStatus = null

async function pruneOldBackups(client, bucket) {
  try {
    const objects = await listS3Objects(client, bucket, 'db/')
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    for (const obj of objects) {
      if (obj.LastModified && new Date(obj.LastModified) < cutoff) {
        await deleteFromS3(client, bucket, obj.Key).catch(() => {})
      }
    }
  } catch {}
}

export async function runBackup(ctx) {
  const key = loadEncryptionKey(ctx.dataDir)
  if (!key) return { ok: false, error: 'No encryption key; generate one in Settings first' }

  const settings = ctx.loadSettings()
  const client = getBackupS3Client(settings)
  if (!client) return { ok: false, error: 'Backup bucket not configured' }

  const dbPath = path.join(ctx.dataDir, 'tasks.db')
  const tmpPath = path.join(os.tmpdir(), `qalatra-backup-${Date.now()}.db`)
  let backupDb

  try {
    backupDb = new Database(dbPath, { readonly: true })
    await backupDb.backup(tmpPath)
    backupDb.close()
    backupDb = null

    const enc = encrypt(fs.readFileSync(tmpPath), key)
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const objKey = `db/tasks-${ts}.db.enc`
    await uploadToS3(client, settings.backupBucket, objKey, enc, 'application/octet-stream')
    await pruneOldBackups(client, settings.backupBucket)

    lastBackupTime = new Date().toISOString()
    lastBackupStatus = 'ok'
    return { ok: true, key: objKey, size: enc.length, timestamp: lastBackupTime }
  } catch (e) {
    lastBackupStatus = 'failed'
    return { ok: false, error: e.message }
  } finally {
    backupDb?.close()
    try { fs.unlinkSync(tmpPath) } catch {}
  }
}

export function backupStatus() {
  return { lastTime: lastBackupTime, lastStatus: lastBackupStatus }
}

export async function listBackups(ctx) {
  const settings = ctx.loadSettings()
  const client = getBackupS3Client(settings)
  if (!client) return { ok: false, error: 'Backup bucket not configured' }

  try {
    const objects = await listS3Objects(client, settings.backupBucket, 'db/')
    const items = objects
      .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified))
      .slice(0, 20)
      .map(o => ({ key: o.Key, size: o.Size, date: o.LastModified }))
    return { ok: true, items }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// Apply a pending DB restore written by restoreBackup (bug C11). restoreBackup only writes
// tasks.db.restore; the code that actually swaps it into place used to live ONLY in
// electron-main.js, so on a headless install (systemd -> node server/index.js) a restore
// reported success and then silently never applied. Call this at server startup, before the
// DB worker opens tasks.db, so both Electron and headless paths apply the restore. Idempotent:
// a no-op when there is no pending restore file.
export function applyPendingRestore(dataDir) {
  const restorePath = path.join(dataDir, 'tasks.db.restore')
  if (!fs.existsSync(restorePath)) return { ok: true, applied: false }
  const dbPath = path.join(dataDir, 'tasks.db')
  try {
    if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, `${dbPath}.pre-restore`)
    fs.renameSync(restorePath, dbPath)
    for (const ext of ['-wal', '-shm']) {
      const f = dbPath + ext
      if (fs.existsSync(f)) { try { fs.unlinkSync(f) } catch {} }
    }
    return { ok: true, applied: true }
  } catch (e) {
    return { ok: false, applied: false, error: e.message }
  }
}

export async function restoreBackup(ctx, objKey) {
  const key = loadEncryptionKey(ctx.dataDir)
  if (!key) return { ok: false, error: 'No encryption key; import your key first' }

  const settings = ctx.loadSettings()
  const client = getBackupS3Client(settings)
  if (!client) return { ok: false, error: 'Backup bucket not configured' }

  try {
    const enc = await downloadFromS3(client, settings.backupBucket, objKey)
    const plain = decrypt(enc, key)
    const restorePath = path.join(ctx.dataDir, 'tasks.db.restore')
    fs.writeFileSync(restorePath, plain)
    return { ok: true, message: 'Restore file written; restart Qalatra Server to apply.' }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
