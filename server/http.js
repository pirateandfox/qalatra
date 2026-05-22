import fs from 'fs'
import path from 'path'
import { mimeTypeForPath } from './files.js'

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const MAX_JSON_BODY_BYTES = parseInt(process.env.QALATRA_MAX_JSON_BODY_BYTES || String(1024 * 1024), 10)
const MAX_RAW_BODY_BYTES = parseInt(process.env.QALATRA_MAX_RAW_BODY_BYTES || String(256 * 1024 * 1024), 10)

class BodyTooLargeError extends Error {
  constructor(limit) {
    super(`Request body exceeds ${limit} bytes`)
    this.status = 413
  }
}

export function applyCors(res) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value)
}

export function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...CORS_HEADERS,
  })
  res.end(JSON.stringify(body))
}

export function sendBinary(res, status, buffer, mimeType, filename) {
  const headers = {
    'Content-Type': mimeType || 'application/octet-stream',
    'Content-Length': buffer.length,
    ...CORS_HEADERS,
  }
  if (filename) headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(filename)}`
  res.writeHead(status, headers)
  res.end(buffer)
}

export async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    let bytes = 0
    req.on('data', chunk => {
      bytes += chunk.length
      if (bytes > MAX_JSON_BODY_BYTES) {
        req.destroy(new BodyTooLargeError(MAX_JSON_BODY_BYTES))
        return
      }
      data += chunk
    })
    req.on('end', () => {
      if (!data.trim()) return resolve({})
      try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

export async function parseRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    req.on('data', chunk => {
      bytes += chunk.length
      if (bytes > MAX_RAW_BODY_BYTES) {
        req.destroy(new BodyTooLargeError(MAX_RAW_BODY_BYTES))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function streamFile(req, res, filePath) {
  const stat = fs.statSync(filePath)
  const mimeType = mimeTypeForPath(filePath)
  const baseHeaders = {
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
    ...CORS_HEADERS,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
  }
  const range = req.headers.range
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0
      const end = match[2] ? parseInt(match[2], 10) : stat.size - 1
      if (start <= end && end < stat.size) {
        res.writeHead(206, {
          ...baseHeaders,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        })
        fs.createReadStream(filePath, { start, end }).pipe(res)
        return
      }
    }
  }

  res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size })
  fs.createReadStream(filePath).pipe(res)
}
