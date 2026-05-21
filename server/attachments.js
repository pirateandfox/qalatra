import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { decrypt, encrypt } from '../crypto.js'
import { deleteFromS3, downloadFromS3, getPresignedUrl, getS3Client, uploadToS3 } from '../s3.js'
import { loadEncryptionKey } from './keys.js'

const MIME_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
}

function expandHome(p) {
  if (!p) return p
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}

function extFromMime(mime) {
  return MIME_EXTENSIONS[mime] || ''
}

function getAttachmentCacheDir(settings, dataDir) {
  const raw = settings.attachmentCacheDir || path.join(dataDir, 'attachments')
  const dir = path.resolve(expandHome(raw))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function localPathForAttachment(settings, dataDir, attachment) {
  const ext = path.extname(attachment.filename || '')
  return path.join(getAttachmentCacheDir(settings, dataDir), `${attachment.id}${ext}`)
}

function bufferFromArray(bufferArray) {
  if (Buffer.isBuffer(bufferArray)) return bufferArray
  if (Array.isArray(bufferArray)) return Buffer.from(bufferArray)
  throw new Error('Attachment payload must be a byte array')
}

export async function listAttachments(ctx, taskId) {
  const rows = await ctx.dbCall('listAttachments', taskId)
  const settings = ctx.loadSettings()
  const client = getS3Client(settings)
  return Promise.all(rows.map(async row => {
    if (!row.url && row.bucket && row.key && client && !row.encrypted) {
      try {
        return { ...row, url: await getPresignedUrl(client, row.bucket, row.key) }
      } catch {}
    }
    return row
  }))
}

export async function uploadAttachment(ctx, taskId, filename, mimeType, bufferArray) {
  if (!taskId) throw new Error('taskId is required')
  if (!filename) throw new Error('filename is required')

  const settings = ctx.loadSettings()
  const client = getS3Client(settings)
  const bucket = settings.s3Bucket || null
  const encKey = loadEncryptionKey(ctx.dataDir)
  const id = uuidv4()
  const safeExt = path.extname(filename) || extFromMime(mimeType)
  const key = `attachments/${taskId}/${id}${safeExt}`
  const localPath = path.join(getAttachmentCacheDir(settings, ctx.dataDir), `${id}${safeExt}`)
  const plainBuffer = bufferFromArray(bufferArray)

  fs.writeFileSync(localPath, plainBuffer)

  let url = null
  let uploadedBucket = null
  let uploadedKey = null
  let warning = null
  let encrypted = 0

  if (client && bucket) {
    try {
      let uploadBuffer = plainBuffer
      if (encKey) {
        uploadBuffer = encrypt(plainBuffer, encKey)
        encrypted = 1
      }
      await uploadToS3(client, bucket, key, uploadBuffer, mimeType)
      uploadedBucket = bucket
      uploadedKey = key
      url = (!encrypted && settings.s3PublicUrl) ? `${settings.s3PublicUrl.replace(/\/$/, '')}/${key}` : null
    } catch {
      warning = 's3_upload_failed'
    }
  }

  const attachment = await ctx.dbCall('insertAttachment', {
    id,
    taskId,
    filename,
    mimeType,
    sizeBytes: plainBuffer.length,
    bucket: uploadedBucket,
    key: uploadedKey,
    url,
    localPath,
    encrypted,
  })
  return { ok: true, warning, attachment }
}

export async function deleteAttachment(ctx, id) {
  const att = await ctx.dbCall('getAttachment', id)
  if (!att) throw new Error('Attachment not found')
  const settings = ctx.loadSettings()
  const client = getS3Client(settings)
  if (client && att.bucket && att.key) {
    try { await deleteFromS3(client, att.bucket, att.key) } catch {}
  }
  if (att.local_path && fs.existsSync(att.local_path)) {
    try { fs.unlinkSync(att.local_path) } catch {}
  }
  return ctx.dbCall('deleteAttachment', id)
}

export async function syncPendingAttachments(ctx) {
  const settings = ctx.loadSettings()
  const client = getS3Client(settings)
  const bucket = settings.s3Bucket
  if (!client || !bucket) return { ok: true, synced: 0, failed: 0, total: 0 }

  const encKey = loadEncryptionKey(ctx.dataDir)
  const pending = await ctx.dbCall('getPendingAttachments')
  let synced = 0
  let failed = 0

  for (const att of pending) {
    if (!att.local_path || !fs.existsSync(att.local_path)) {
      failed++
      continue
    }
    try {
      let buffer = fs.readFileSync(att.local_path)
      const ext = path.extname(att.filename || '')
      const key = `attachments/${att.task_id}/${att.id}${ext}`
      let encrypted = 0
      if (encKey) {
        buffer = encrypt(buffer, encKey)
        encrypted = 1
      }
      await uploadToS3(client, bucket, key, buffer, att.mimetype)
      const url = (!encrypted && settings.s3PublicUrl) ? `${settings.s3PublicUrl.replace(/\/$/, '')}/${key}` : null
      await ctx.dbCall('updateAttachmentStorage', att.id, bucket, key, url, encrypted)
      synced++
    } catch {
      failed++
    }
  }

  return { ok: true, synced, failed, total: pending.length }
}

export async function readAttachmentContent(ctx, id) {
  const att = await ctx.dbCall('getAttachment', id)
  if (!att) throw new Error('Attachment not found')

  if (att.local_path && fs.existsSync(att.local_path)) {
    return {
      attachment: att,
      buffer: fs.readFileSync(att.local_path),
      mimeType: att.mimetype || 'application/octet-stream',
    }
  }

  if (!att.bucket || !att.key) throw new Error('No remote copy')
  const settings = ctx.loadSettings()
  const client = getS3Client(settings)
  if (!client) throw new Error('S3 not configured')

  let buffer = await downloadFromS3(client, att.bucket, att.key)
  if (att.encrypted) {
    const encKey = loadEncryptionKey(ctx.dataDir)
    if (!encKey) throw new Error('No encryption key; import your key in Settings')
    buffer = decrypt(buffer, encKey)
  }

  const localPath = localPathForAttachment(settings, ctx.dataDir, att)
  fs.writeFileSync(localPath, buffer)
  return {
    attachment: { ...att, local_path: localPath },
    buffer,
    mimeType: att.mimetype || 'application/octet-stream',
  }
}
