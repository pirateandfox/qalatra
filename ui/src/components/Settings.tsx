import { useState, useEffect } from 'react'
import { fetchSettings, saveSettings, fetchAgents, syncAttachments, getMcpStatus, applyMcpPort, createContext, updateContext, deleteContext, type Agent } from '../api'
import { useContexts } from '../lib/ContextsProvider'
import './Settings.css'

interface Props {
  open: boolean
  onClose: () => void
}

export default function Settings({ open, onClose }: Props) {
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [agents, setAgents] = useState<Agent[]>([])
  const [saved, setSaved] = useState(false)
  const [s3TestResult, setS3TestResult] = useState<'ok' | 'fail' | null>(null)
  const [syncResult, setSyncResult] = useState<{ synced: number; failed: number; total: number } | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [mcpPort, setMcpPort] = useState('3457')
  const [mcpStatus, setMcpStatus] = useState<{ isHttpConfigured: boolean } | null>(null)
  const [mcpApplying, setMcpApplying] = useState(false)
  const [mcpResult, setMcpResult] = useState<'ok' | 'fail' | null>(null)
  const { contexts, refresh: refreshContexts } = useContexts()
  const [newSlug, setNewSlug] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newColor, setNewColor] = useState('#888888')
  const [editingSlug, setEditingSlug] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editColor, setEditColor] = useState('')

  useEffect(() => {
    if (open) {
      fetchSettings().then(setSettings)
      fetchAgents().then(setAgents)
      getMcpStatus().then(s => { setMcpPort(String(s.port)); setMcpStatus(s) })
      refreshContexts()
    }
  }, [open])

  async function handleSave() {
    await saveSettings(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  function set(key: string, value: string) {
    setSettings(s => ({ ...s, [key]: value }))
  }

  return (
    <div className={`settings-panel ${open ? 'open' : ''}`}>
      <div className="terminal-toolbar">
        <span className="terminal-title">Settings</span>
        <button className="terminal-close" onClick={onClose}>✕</button>
      </div>
      <div className="settings-body">
        <div className="settings-row">
          <label className="settings-label">Terminal working directory</label>
          <input
            className="settings-input"
            type="text"
            value={settings.terminalCwd ?? ''}
            onChange={e => set('terminalCwd', e.target.value)}
            placeholder="e.g. /Users/you/Projects or C:\Users\you\Projects"
            spellCheck={false}
          />
          <span className="settings-hint">Takes effect on next terminal open</span>
        </div>
        <div className="settings-row">
          <label className="settings-label">Agents scan root</label>
          <input
            className="settings-input"
            type="text"
            value={settings.agentsRoot ?? ''}
            onChange={e => set('agentsRoot', e.target.value)}
            placeholder={`Defaults to terminal working directory`}
            spellCheck={false}
          />
          <span className="settings-hint">Folder scanned recursively for agent.config files. Set wider than terminal CWD to find agents in sister repos.</span>
        </div>
        <div className="settings-row">
          <label className="settings-label">Terminal auto-run command</label>
          <input
            className="settings-input"
            type="text"
            value={settings.terminalAutoRun ?? ''}
            onChange={e => set('terminalAutoRun', e.target.value)}
            placeholder="e.g. dangerclaude"
            spellCheck={false}
          />
          <span className="settings-hint">Runs automatically when terminal opens. Takes effect on next terminal open.</span>
        </div>
        <div className="settings-row">
          <label className="settings-label">Default agent command</label>
          <input
            className="settings-input"
            type="text"
            value={settings.defaultAgentCommand ?? ''}
            onChange={e => set('defaultAgentCommand', e.target.value)}
            placeholder="claude --dangerously-skip-permissions"
            spellCheck={false}
          />
          <span className="settings-hint">Used when launching agents from task queue and the "Chat" button in file previewers. Per-agent agent.config overrides this.</span>
        </div>
        <div className="settings-section-header">Attachments &amp; Storage</div>

        <div className="settings-row">
          <label className="settings-label">S3 Endpoint URL</label>
          <input className="settings-input" type="text" value={settings.s3Endpoint ?? ''} onChange={e => set('s3Endpoint', e.target.value)}
            placeholder="https://<account_id>.r2.cloudflarestorage.com" spellCheck={false} />
          <span className="settings-hint">Cloudflare R2 recommended. Any S3-compatible endpoint works.</span>
        </div>

        <div className="settings-row">
          <label className="settings-label">Bucket Name</label>
          <input className="settings-input" type="text" value={settings.s3Bucket ?? ''} onChange={e => set('s3Bucket', e.target.value)}
            placeholder="task-os-attachments" spellCheck={false} />
        </div>

        <div className="settings-row">
          <label className="settings-label">Access Key ID</label>
          <input className="settings-input" type="text" value={settings.s3AccessKey ?? ''} onChange={e => set('s3AccessKey', e.target.value)}
            placeholder="" spellCheck={false} />
        </div>

        <div className="settings-row">
          <label className="settings-label">Secret Access Key</label>
          <input className="settings-input" type="password" value={settings.s3SecretKey ?? ''} onChange={e => set('s3SecretKey', e.target.value)} />
        </div>

        <div className="settings-row">
          <label className="settings-label">Public Base URL <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
          <input className="settings-input" type="text" value={settings.s3PublicUrl ?? ''} onChange={e => set('s3PublicUrl', e.target.value)}
            placeholder="https://assets.yourdomain.com — leave blank to use presigned URLs" spellCheck={false} />
        </div>

        <div className="settings-row">
          <label className="settings-label">Local Attachment Cache</label>
          <input className="settings-input" type="text" value={settings.attachmentCacheDir ?? ''} onChange={e => set('attachmentCacheDir', e.target.value)}
            placeholder="e.g. ~/Library/Application Support/task-os/attachments or C:\Users\you\AppData\Roaming\task-os" spellCheck={false} />
          <span className="settings-hint">Files are always cached here locally regardless of cloud storage.</span>
        </div>

        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="settings-save" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
              onClick={async () => {
                setS3TestResult(null)
                const data = await (window as any).electronAPI.invoke('s3:test', { s3Endpoint: settings.s3Endpoint, s3Bucket: settings.s3Bucket, s3AccessKey: settings.s3AccessKey, s3SecretKey: settings.s3SecretKey })
                setS3TestResult(data.ok ? 'ok' : 'fail')
              }}>Test Connection</button>
            {s3TestResult === 'ok' && <span style={{ fontSize: 12, color: '#4ade80' }}>✓ Connected</span>}
            {s3TestResult === 'fail' && <span style={{ fontSize: 12, color: '#ef4444' }}>✕ Failed</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="settings-save" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
              disabled={syncing}
              onClick={async () => {
                setSyncing(true)
                setSyncResult(null)
                const data = await syncAttachments()
                setSyncing(false)
                if (data.ok && data.total !== undefined) {
                  setSyncResult({ synced: data.synced ?? 0, failed: data.failed ?? 0, total: data.total })
                }
              }}>{syncing ? 'Syncing…' : 'Sync Pending'}</button>
            {syncResult !== null && (
              <span style={{ fontSize: 12, color: syncResult.failed > 0 ? '#f59e0b' : '#4ade80' }}>
                {syncResult.total === 0 ? 'Nothing pending' : `${syncResult.synced}/${syncResult.total} synced${syncResult.failed > 0 ? `, ${syncResult.failed} failed` : ''}`}
              </span>
            )}
          </div>
        </div>

        <div className="settings-section-header">Contexts</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {contexts.map(c => (
            <div key={c.slug} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {editingSlug === c.slug ? (
                <>
                  <input type="color" value={editColor} onChange={e => setEditColor(e.target.value)}
                    style={{ width: 28, height: 28, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
                  <input className="settings-input" style={{ width: 180, flex: 'unset' }} value={editLabel}
                    onChange={e => setEditLabel(e.target.value)} />
                  <span style={{ fontSize: 11, color: '#4a5568', fontFamily: 'monospace' }}>{c.slug}</span>
                  <button className="settings-save" style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={async () => {
                      await updateContext(c.slug, { label: editLabel, color: editColor })
                      refreshContexts()
                      setEditingSlug(null)
                    }}>Save</button>
                  <button className="settings-save" style={{ padding: '4px 10px', fontSize: 12, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                    onClick={() => setEditingSlug(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <span style={{ width: 12, height: 12, borderRadius: '50%', background: c.color, flexShrink: 0, display: 'inline-block' }} />
                  <span style={{ fontSize: 13, color: '#e2e8f0', flex: 1 }}>{c.label}</span>
                  <span style={{ fontSize: 11, color: '#4a5568', fontFamily: 'monospace' }}>{c.slug}</span>
                  <button style={{ background: 'none', border: 'none', color: '#4a5568', cursor: 'pointer', fontSize: 12, padding: '2px 6px' }}
                    onClick={() => { setEditingSlug(c.slug); setEditLabel(c.label); setEditColor(c.color) }}>Edit</button>
                  <button style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 12, padding: '2px 6px' }}
                    onClick={async () => { await deleteContext(c.slug); refreshContexts() }}>✕</button>
                </>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <input type="color" value={newColor} onChange={e => setNewColor(e.target.value)}
            style={{ width: 28, height: 28, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
          <input className="settings-input" style={{ width: 120, flex: 'unset' }} placeholder="slug" value={newSlug}
            onChange={e => setNewSlug(e.target.value.toLowerCase().replace(/\s+/g, ''))} />
          <input className="settings-input" style={{ width: 160, flex: 'unset' }} placeholder="Display name" value={newLabel}
            onChange={e => setNewLabel(e.target.value)} />
          <button className="settings-save" style={{ padding: '4px 12px', fontSize: 12 }}
            disabled={!newSlug.trim() || !newLabel.trim()}
            onClick={async () => {
              await createContext(newSlug.trim(), newLabel.trim(), newColor)
              refreshContexts()
              setNewSlug(''); setNewLabel(''); setNewColor('#888888')
            }}>Add</button>
        </div>

        <div className="settings-section-header">MCP Server</div>

        <div className="settings-row">
          <label className="settings-label">HTTP Port</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              className="settings-input"
              type="number"
              min={1024}
              max={65535}
              value={mcpPort}
              onChange={e => { setMcpPort(e.target.value); setMcpResult(null); }}
              style={{ width: 100, flex: 'unset' }}
            />
            <button
              className="settings-save"
              disabled={mcpApplying}
              onClick={async () => {
                setMcpApplying(true)
                setMcpResult(null)
                const data = await applyMcpPort(parseInt(mcpPort, 10))
                setMcpApplying(false)
                if (data.ok) {
                  setMcpResult('ok')
                  setMcpStatus({ isHttpConfigured: true })
                } else {
                  setMcpResult('fail')
                }
              }}
            >{mcpApplying ? 'Applying…' : 'Apply'}</button>
            {mcpResult === 'ok'  && <span style={{ fontSize: 12, color: '#4ade80' }}>✓ Applied</span>}
            {mcpResult === 'fail' && <span style={{ fontSize: 12, color: '#ef4444' }}>✕ Failed</span>}
          </div>
          <span className="settings-hint">
            {mcpStatus?.isHttpConfigured
              ? '✓ Claude Code is configured to use HTTP transport'
              : 'Claude Code is using stdio — click Apply to switch to HTTP'}
          </span>
          {mcpResult === 'ok' && (
            <span className="settings-hint" style={{ color: '#f59e0b' }}>
              Restart Claude Code to pick up the change.
            </span>
          )}
        </div>

        <div className="settings-section-header">Terminal</div>

        {agents.length > 0 && (
          <div className="settings-row">
            <label className="settings-label">Discovered agents ({agents.length})</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {agents.map(a => (
                <div key={a.path} style={{ fontSize: 12, color: '#94a3b8' }}>
                  <span style={{ color: '#e2e8f0', fontWeight: 500 }}>{a.name}</span>
                  {a.description && <span style={{ marginLeft: 8, color: '#4a5568' }}>{a.description}</span>}
                  <div style={{ fontSize: 11, color: '#4a5568', fontFamily: 'monospace' }}>{a.relativePath}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="settings-actions">
          <button className="settings-save" onClick={handleSave}>
            {saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
