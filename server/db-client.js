import fs from 'fs'
import path from 'path'
import { Worker } from 'worker_threads'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

let worker = null
let seq = 0
const pending = new Map()

export async function initDbWorker(dbDir) {
  fs.mkdirSync(dbDir, { recursive: true })
  const dbPath = path.join(dbDir, 'tasks.db')
  worker = new Worker(path.join(ROOT, 'db-worker.js'), { workerData: { dbPath } })

  worker.on('message', ({ ready, id, result, error }) => {
    if (ready) return
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    error ? p.reject(new Error(error)) : p.resolve(result)
  })

  worker.on('error', err => {
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  })

  worker.on('exit', code => {
    if (code !== 0) {
      const err = new Error(`DB worker exited with code ${code}`)
      for (const p of pending.values()) p.reject(err)
      pending.clear()
    }
  })

  await new Promise((resolve, reject) => {
    worker.once('message', msg => { if (msg.ready) resolve() })
    worker.once('error', reject)
  })
}

export function dbCall(method, ...args) {
  return new Promise((resolve, reject) => {
    if (!worker) return reject(new Error('DB worker not initialized'))
    const id = ++seq
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, method, args })
  })
}

export async function closeDbWorker() {
  if (!worker) return
  const w = worker
  worker = null
  await w.terminate()
}
