import { useEffect, useState } from 'react'
import { fetchIntegrations, pollIntegration, type IntegrationStatus } from '../../api'

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  return `${Math.round(ms / 3_600_000)}h ago`
}

// External orchestrators (FlightDesk first). Read-only: binding is a `.flightdeskrc` in the agent
// folder, and the poller runs on its own; this panel only shows whether each bound folder is
// reaching FlightDesk and what it has moved. Nothing here appears unless a folder is bound.
export function IntegrationsSettings() {
  const [integrations, setIntegrations] = useState<Record<string, IntegrationStatus>>({})
  const [polling, setPolling] = useState<string | null>(null)

  async function refresh() {
    try { setIntegrations(await fetchIntegrations()) } catch { /* server without integrations */ }
  }

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 15_000)
    return () => clearInterval(timer)
  }, [])

  async function pollNow(name: string) {
    setPolling(name)
    try { await pollIntegration(name); await refresh() } finally { setPolling(null) }
  }

  const entries = Object.entries(integrations)

  return (
    <>
      <div className="settings-section-header" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
        External orchestrators
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.5 }}>
        An orchestrator like FlightDesk decides when an agent should run; Qalatra polls for its requests, runs the job,
        and reports back. A folder takes part by holding its own <code>.flightdeskrc</code> — see{' '}
        <code>docs/flightdesk-integration.md</code>. Folders without one are never polled.
      </div>

      {entries.length === 0 && <div style={{ fontSize: 13, color: 'var(--muted)' }}>No integrations reported by this server.</div>}

      {entries.map(([name, status]) => (
        <div key={name} style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent)' }}>{name}</span>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              {status.enabled ? `polling every ${Math.round(status.pollIntervalMs / 1000)}s` : 'disabled in settings'}
            </span>
            <button
              className="settings-save"
              style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
              disabled={polling === name || !status.enabled}
              onClick={() => pollNow(name)}
            >
              {polling === name ? 'Polling…' : 'Poll now'}
            </button>
          </div>

          {status.folders.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>No bound agent folders on this box.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {status.folders.map(f => {
                const state = f.rejectedAt ? 'credential rejected' : f.lastError ? 'error' : f.lastOkAt ? 'ok' : 'waiting'
                const color = state === 'ok' ? 'var(--accent)' : state === 'waiting' ? 'var(--muted)' : 'var(--danger, #c0392b)'
                return (
                  <div key={f.path} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 12 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'var(--mono, monospace)', wordBreak: 'break-all' }}>{f.path}</span>
                      <span style={{ color, fontWeight: 600, marginLeft: 'auto' }}>{state}</span>
                    </div>
                    <div style={{ color: 'var(--muted)', marginTop: 4, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                      <span>last poll {ago(f.lastPollAt)}</span>
                      <span>last ok {ago(f.lastOkAt)}</span>
                      <span>open {f.open}</span>
                      <span>queued {f.queuedTotal}</span>
                      <span>session ops {f.sessionOpsTotal}</span>
                      <span>outbox sent {f.outbox.sent} · pending {f.outbox.pending} · failed {f.outbox.failed}</span>
                    </div>
                    {f.lastError && <div style={{ color: 'var(--danger, #c0392b)', marginTop: 4, wordBreak: 'break-word' }}>{f.lastError}</div>}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ))}
    </>
  )
}
