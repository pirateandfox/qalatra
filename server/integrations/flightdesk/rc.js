import fs from 'fs'
import path from 'path'

// A folder takes part in FlightDesk dispatch by holding its own `.flightdeskrc`: FlightDesk binds
// one AGENT user per agent folder, so the credential *is* the folder's identity and a folder
// without one is simply not bound. There is deliberately no fallback to ~/.flightdeskrc — that
// would make every folder on the box poll as the same user and hand one folder's dispatches to
// whichever polled first.
export const DEFAULT_API_URL = 'https://api.flightdesk.dev'
export const RC_FILENAME = '.flightdeskrc'

const cache = new Map() // agentPath -> { mtimeMs, rc }

export function loadFolderRc(agentPath, { env = process.env } = {}) {
  const file = path.join(agentPath, RC_FILENAME)
  let stat
  try { stat = fs.statSync(file) } catch { cache.delete(agentPath); return null }
  const hit = cache.get(agentPath)
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.rc
  let rc = null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : ''
    if (apiKey) {
      rc = {
        apiKey,
        apiUrl: (typeof parsed.apiUrl === 'string' && parsed.apiUrl.trim()) || env.FLIGHTDESK_API_URL || DEFAULT_API_URL,
        // Optional in the CLI's own schema ({ apiKey, apiUrl?, organizationId? }); scopes the
        // agent user to one org when the token spans several.
        organizationId: (typeof parsed.organizationId === 'string' && parsed.organizationId.trim()) || null,
        file,
      }
    }
  } catch { rc = null }
  cache.set(agentPath, { mtimeMs: stat.mtimeMs, rc })
  return rc
}

export function clearRcCache() { cache.clear() }
