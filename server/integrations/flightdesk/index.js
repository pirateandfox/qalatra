// FlightDesk integration wiring: the tick, the lifecycle hooks, and a status view.
// Inert unless at least one scanned agent folder holds a `.flightdeskrc` (see rc.js), and off
// entirely when settings.flightdeskEnabled === false. No FlightDesk code runs otherwise.

import { onJobStarted, onJobFinished, orphanedAtBoot } from '../../workers.js'
import { loadFolderRc } from './rc.js'
import { createFlightDeskClient } from './client.js'
import { createFlightDeskDispatcher } from './dispatch.js'
import { createSessionOps } from '../../session-ops.js'

export const POLL_INTERVAL_MS = 30_000
// A folder whose credential was rejected keeps trying, slowly, so the attempt stays visible on
// both sides once the token is fixed — but it must not hammer a 401 every tick.
export const REJECTED_RETRY_MS = 5 * 60_000

export function startFlightDeskIntegration(ctx, { setIntervalImpl = setInterval, setTimeoutImpl = setTimeout } = {}) {
  const { dbCall, loadSettings, log = console } = ctx
  const clients = new Map() // agentPath -> { key, client }

  function clientFor(agentPath) {
    const rc = loadFolderRc(agentPath)
    if (!rc) { clients.delete(agentPath); return null }
    const key = `${rc.apiUrl}\n${rc.apiKey}`
    const hit = clients.get(agentPath)
    if (hit && hit.key === key) return hit.client
    const client = createFlightDeskClient({ apiUrl: rc.apiUrl, apiKey: rc.apiKey })
    clients.set(agentPath, { key, client })
    return client
  }

  const dispatcher = createFlightDeskDispatcher({ dbCall, clientFor, log, sessionOps: createSessionOps() })
  const enabled = () => loadSettings()?.flightdeskEnabled !== false

  let polling = false
  async function tick() {
    if (polling || !enabled()) return
    polling = true
    try {
      const agents = await dbCall('listAgentsDb')
      for (const agent of agents) {
        if (!loadFolderRc(agent.path)) continue
        const status = dispatcher.folders.get(agent.path)
        if (status?.rejectedAt && Date.now() - Date.parse(status.lastPollAt) < REJECTED_RETRY_MS) continue
        await dispatcher.pollFolder(agent)
      }
    } catch (err) {
      log.error(`[flightdesk] tick failed: ${err.message}`)
    } finally {
      polling = false
    }
  }

  const offStarted = onJobStarted(payload => enabled() ? dispatcher.onJobStarted(payload) : undefined)
  const offFinished = onJobFinished(payload => enabled() ? dispatcher.onJobFinished(payload) : undefined)
  orphanedAtBoot.then(jobs => enabled() ? dispatcher.reportOrphaned(jobs) : undefined).catch(() => {})

  const first = setTimeoutImpl(() => tick().catch(() => {}), 5_000)
  const timer = setIntervalImpl(() => tick().catch(() => {}), POLL_INTERVAL_MS)
  timer.unref?.(); first.unref?.()

  return {
    name: 'flightdesk',
    tick,
    status() {
      return {
        enabled: enabled(),
        pollIntervalMs: POLL_INTERVAL_MS,
        folders: [...dispatcher.folders.values()].map(f => ({ ...f, apiUrl: loadFolderRc(f.path)?.apiUrl ?? null })),
      }
    },
    stop() { clearInterval(timer); clearTimeout(first); offStarted(); offFinished() },
  }
}
