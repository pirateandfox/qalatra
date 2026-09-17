// External orchestrators plug in here. Each integration is opt-in and self-describing; the core
// job pipeline exposes only generic hooks (see workers.js onJobStarted/onJobFinished/orphanedAtBoot
// and db-worker queueExternalJob) and never knows which orchestrator, if any, is attached.
import { startFlightDeskIntegration } from './flightdesk/index.js'

export function startIntegrations(ctx) {
  const integrations = {}
  try {
    integrations.flightdesk = startFlightDeskIntegration(ctx)
  } catch (err) {
    console.error(`[integrations] flightdesk failed to start: ${err.message}`)
  }
  return {
    status() {
      return Object.fromEntries(Object.entries(integrations).map(([name, i]) => [name, i.status()]))
    },
    get(name) { return integrations[name] ?? null },
    stop() { for (const i of Object.values(integrations)) i.stop?.() },
  }
}
