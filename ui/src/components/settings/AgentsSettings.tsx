import { useEffect, useState } from 'react'
import { fetchAgents, rescanAgents, type Agent } from '../../api'

export function AgentsSettings() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [rescanning, setRescanning] = useState(false)
  const [collapsedContexts, setCollapsedContexts] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('qalatra-collapsed-contexts') ?? '[]'))
    } catch {
      return new Set()
    }
  })

  useEffect(() => {
    fetchAgents().then(setAgents).catch(() => {})
  }, [])

  function toggleContext(ctx: string) {
    setCollapsedContexts(prev => {
      const next = new Set(prev)
      if (next.has(ctx)) next.delete(ctx)
      else next.add(ctx)
      localStorage.setItem('qalatra-collapsed-contexts', JSON.stringify([...next]))
      return next
    })
  }

  async function rescan() {
    setRescanning(true)
    await rescanAgents()
    setAgents(await fetchAgents())
    setRescanning(false)
  }

  function groupedAgents() {
    const byContext = new Map<string, Map<string, Agent[]>>()
    for (const agent of agents) {
      const ctx = agent.context ?? '(no context)'
      const project = agent.project ?? '(no project)'
      if (!byContext.has(ctx)) byContext.set(ctx, new Map())
      const byProject = byContext.get(ctx)!
      if (!byProject.has(project)) byProject.set(project, [])
      byProject.get(project)!.push(agent)
    }
    return byContext
  }

  return (
    <>
      <div className="settings-section-header" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
        Discovered Agents ({agents.length})
      </div>

      <div style={{ marginBottom: 12 }}>
        <button
          className="settings-save"
          style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
          disabled={rescanning}
          onClick={rescan}
        >
          {rescanning ? 'Scanning...' : 'Rescan agents'}
        </button>
      </div>

      {agents.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>No agents found. Set an agents scan root in General settings.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {[...groupedAgents().entries()].map(([ctx, byProject]) => {
            const collapsed = collapsedContexts.has(ctx)
            return (
              <div key={ctx}>
                <button
                  onClick={() => toggleContext(ctx)}
                  style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, marginBottom: collapsed ? 0 : 12, width: '100%' }}
                >
                  <span style={{ fontSize: 10, color: 'var(--muted)', transition: 'transform 0.15s', display: 'inline-block', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>v</span>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent)' }}>{ctx}</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>({[...byProject.values()].reduce((n, group) => n + group.length, 0)})</span>
                </button>
                {!collapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                    {[...byProject.entries()].map(([project, group]) => (
                      <div key={project}>
                        {byProject.size > 1 && (
                          <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', marginBottom: 8, paddingBottom: 4, borderBottom: '1px solid var(--border)' }}>{project}</div>
                        )}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                          {group.map(agent => (
                            <div key={agent.path} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '11px 13px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.3 }}>{agent.name}</div>
                              {agent.description && (
                                <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5 }}>{agent.description}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
