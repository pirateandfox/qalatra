import { useEffect, useState } from 'react'
import { applyMcpPort, getMcpStatus } from '../../api'
import { DARK_TOKENS, LIGHT_TOKENS, TOKEN_KEYS, TOKEN_LABELS, type ThemeMode, type TokenKey } from '../../lib/theme'
import { useTheme } from '../../lib/ThemeProvider'

interface GeneralSettingsProps {
  settings: Record<string, string>
  setSetting: (key: string, value: string) => void
  saved: boolean
  onSave: () => Promise<void>
}

export function GeneralSettings({ settings, setSetting, saved, onSave }: GeneralSettingsProps) {
  const { mode: themeMode, effectiveMode, tokens, setMode: setThemeMode, setToken, resetOverrides } = useTheme()
  const [mcpPort, setMcpPort] = useState('3457')
  const [mcpStatus, setMcpStatus] = useState<{ isHttpConfigured: boolean } | null>(null)
  const [mcpApplying, setMcpApplying] = useState(false)
  const [mcpResult, setMcpResult] = useState<'ok' | 'fail' | null>(null)

  useEffect(() => {
    getMcpStatus().then(s => {
      setMcpPort(String(s.port))
      setMcpStatus(s)
    }).catch(() => {})
  }, [])

  async function applyPort() {
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
  }

  return (
    <>
      <div className="settings-section-header" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>Appearance</div>

      <div className="settings-row">
        <label className="settings-label">Theme</label>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['system', 'light', 'dark'] as ThemeMode[]).map(m => (
            <button
              key={m}
              className="settings-save"
              style={{
                padding: '4px 14px',
                fontSize: 12,
                background: themeMode === m ? 'var(--accent)' : 'transparent',
                border: '1px solid var(--border)',
                color: themeMode === m ? '#fff' : 'var(--muted)',
              }}
              onClick={() => setThemeMode(m)}
            >
              {m === 'system' ? 'System' : m === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
        <span className="settings-hint">Currently using {effectiveMode} theme.</span>
      </div>

      <div className="settings-row">
        <label className="settings-label">Color Tokens</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
          {TOKEN_KEYS.map(key => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="color"
                value={tokens[key]}
                onChange={e => setToken(key, e.target.value)}
                style={{ width: 28, height: 28, border: 'none', background: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}
              />
              <div>
                <div style={{ fontSize: 12, color: 'var(--text)' }}>{TOKEN_LABELS[key]}</div>
                <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace' }}>{tokens[key]}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            className="settings-save"
            style={{ padding: '4px 12px', fontSize: 12, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
            onClick={() => { (Object.entries(DARK_TOKENS) as [TokenKey, string][]).forEach(([k, v]) => setToken(k, v)) }}
          >
            Reset to Dark
          </button>
          <button
            className="settings-save"
            style={{ padding: '4px 12px', fontSize: 12, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
            onClick={() => { (Object.entries(LIGHT_TOKENS) as [TokenKey, string][]).forEach(([k, v]) => setToken(k, v)) }}
          >
            Reset to Light
          </button>
          <button
            className="settings-save"
            style={{ padding: '4px 12px', fontSize: 12, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
            onClick={resetOverrides}
          >
            Reset to Preset
          </button>
        </div>
      </div>

      <div className="settings-section-header">Terminal &amp; Agents</div>

      <div className="settings-row">
        <label className="settings-label">Workspace root</label>
        <input
          className="settings-input"
          type="text"
          value={settings.workspaceRoot ?? ''}
          onChange={e => setSetting('workspaceRoot', e.target.value)}
          placeholder="e.g. /home/qalatra/workspaces"
          spellCheck={false}
        />
        <span className="settings-hint">Primary root for Agent IDE terminals and file browsing.</span>
      </div>
      <div className="settings-row">
        <label className="settings-label">Additional file roots</label>
        <input
          className="settings-input"
          type="text"
          value={settings.fileRoots ?? ''}
          onChange={e => setSetting('fileRoots', e.target.value)}
          placeholder="Comma-separated absolute paths"
          spellCheck={false}
        />
        <span className="settings-hint">Allowed roots for remote file browsing/editing. Keep this narrower than the whole machine.</span>
      </div>
      <div className="settings-row">
        <label className="settings-label">Terminal working directory</label>
        <input
          className="settings-input"
          type="text"
          value={settings.terminalCwd ?? ''}
          onChange={e => setSetting('terminalCwd', e.target.value)}
          placeholder="e.g. /Users/you/Projects"
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
          onChange={e => setSetting('agentsRoot', e.target.value)}
          placeholder="Defaults to terminal working directory"
          spellCheck={false}
        />
        <span className="settings-hint">Folder scanned recursively for agent.config files. Set wider than terminal CWD to find agents in sister repos.</span>
      </div>
      <div className="settings-row">
        <label className="settings-label">Exclude agent folders</label>
        <input
          className="settings-input"
          type="text"
          value={settings.agentExcludeFolders ?? ''}
          onChange={e => setSetting('agentExcludeFolders', e.target.value)}
          placeholder="e.g. projects-template, sandbox"
          spellCheck={false}
        />
        <span className="settings-hint">Comma-separated folder names to skip when scanning for agents.</span>
      </div>
      <div className="settings-row">
        <label className="settings-label">Terminal auto-run command</label>
        <input
          className="settings-input"
          type="text"
          value={settings.terminalAutoRun ?? ''}
          onChange={e => setSetting('terminalAutoRun', e.target.value)}
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
          onChange={e => setSetting('defaultAgentCommand', e.target.value)}
          placeholder="claude --dangerously-skip-permissions"
          spellCheck={false}
        />
        <span className="settings-hint">Used when launching agents from task queue and the Chat button in file previewers. Per-agent agent.config overrides this.</span>
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
            onChange={e => {
              setMcpPort(e.target.value)
              setMcpResult(null)
            }}
            style={{ width: 100, flex: 'unset' }}
          />
          <button className="settings-save" disabled={mcpApplying} onClick={applyPort}>
            {mcpApplying ? 'Applying...' : 'Apply'}
          </button>
          {mcpResult === 'ok' && <span style={{ fontSize: 12, color: '#4ade80' }}>Applied</span>}
          {mcpResult === 'fail' && <span style={{ fontSize: 12, color: '#ef4444' }}>Failed</span>}
        </div>
        <span className="settings-hint">
          {mcpStatus?.isHttpConfigured
            ? 'Claude Code is configured to use HTTP transport'
            : 'Claude Code is using stdio; click Apply to switch to HTTP'}
        </span>
        {mcpResult === 'ok' && <span className="settings-hint" style={{ color: '#f59e0b' }}>Restart Claude Code to pick up the change.</span>}
      </div>

      <div className="settings-actions">
        <button className="settings-save" onClick={onSave}>{saved ? 'Saved' : 'Save'}</button>
      </div>
    </>
  )
}
