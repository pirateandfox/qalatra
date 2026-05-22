import { useState, useEffect } from 'react'
import {
  fetchSettings, saveSettings, fetchAgents, syncAttachments, getMcpStatus, applyMcpPort,
  createContext, updateContext, deleteContext, rescanAgents,
  getKeyStatus, generateKey, exportKey, importKey,
  runBackup, getBackupStatus, listBackups, restoreBackup,
  exportSettings, importSettings, getActiveInstanceId, getInstances, getLocalServerStatus, removeInstance,
  setActiveInstance, testInstanceConnection, testS3Connection, upsertInstance,
  listAccessTokens, createAccessToken, revokeAccessToken,
  getLocalServerServiceStatus, installLocalServerService, restartLocalServer, restartLocalServerService,
  startLocalServer, startLocalServerService, stopLocalServerService, uninstallLocalServerService,
  type AccessToken, type Agent, type BackupItem, type LocalServerServiceStatus, type LocalServerStatus, type QalatraInstance,
} from '../api'
import { useContexts } from '../lib/ContextsProvider'
import { useTheme } from '../lib/ThemeProvider'
import { TOKEN_KEYS, TOKEN_LABELS, DARK_TOKENS, LIGHT_TOKENS, type ThemeMode } from '../lib/theme'
import './Settings.css'
import './SettingsView.css'

type Tab = 'general' | 'instances' | 'storage' | 'encryption' | 'contexts' | 'agents'

const TABS: { key: Tab; label: string }[] = [
  { key: 'general',    label: 'General' },
  { key: 'instances',  label: 'Instances' },
  { key: 'storage',    label: 'Storage' },
  { key: 'encryption', label: 'Encryption & Backup' },
  { key: 'contexts',   label: 'Contexts' },
  { key: 'agents',     label: 'Agents' },
]

const TOKEN_EXPIRY_OPTIONS = [
  { label: '30 days', value: '30' },
  { label: '90 days', value: '90' },
  { label: '1 year', value: '365' },
  { label: 'No expiry', value: '' },
]

function parseServerDate(value: string | null) {
  if (!value) return null
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

function tokenIsExpired(token: AccessToken) {
  const expiresAt = parseServerDate(token.expires_at)
  return !!expiresAt && expiresAt.getTime() <= Date.now()
}

function tokenExpiryLabel(token: AccessToken) {
  const expiresAt = parseServerDate(token.expires_at)
  if (!expiresAt) return 'No expiry'
  return expiresAt.getTime() <= Date.now()
    ? `Expired ${token.expires_at}`
    : `Expires ${token.expires_at}`
}

export default function SettingsView() {
  const [tab, setTab] = useState<Tab>('general')
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [agents, setAgents] = useState<Agent[]>([])
  const [saved, setSaved] = useState(false)
  const [s3TestResult, setS3TestResult] = useState<'ok' | 'fail' | null>(null)
  const [syncResult, setSyncResult] = useState<{ synced: number; failed: number; total: number } | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [rescanning, setRescanning] = useState(false)
  const [collapsedContexts, setCollapsedContexts] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('qalatra-collapsed-contexts') ?? '[]')) }
    catch { return new Set() }
  })
  const toggleContext = (ctx: string) => {
    setCollapsedContexts(prev => {
      const next = new Set(prev)
      next.has(ctx) ? next.delete(ctx) : next.add(ctx)
      localStorage.setItem('qalatra-collapsed-contexts', JSON.stringify([...next]))
      return next
    })
  }
  // Encryption
  const [keyPresent, setKeyPresent] = useState(false)
  const [exportedKey, setExportedKey] = useState<string | null>(null)
  const [importKeyInput, setImportKeyInput] = useState('')
  const [keyMsg, setKeyMsg] = useState<string | null>(null)
  // Backup
  const [backupStatus, setBackupStatus] = useState<{ lastTime: string | null; lastStatus: string | null } | null>(null)
  const [backupRunning, setBackupRunning] = useState(false)
  const [backupMsg, setBackupMsg] = useState<string | null>(null)
  const [backupList, setBackupList] = useState<BackupItem[] | null>(null)
  const [backupListLoading, setBackupListLoading] = useState(false)
  const [restoringKey, setRestoringKey] = useState<string | null>(null)
  // Recovery
  const [exportedSettings, setExportedSettings] = useState<string | null>(null)
  const [importSettingsInput, setImportSettingsInput] = useState('')
  const [recoveryMsg, setRecoveryMsg] = useState<string | null>(null)
  // MCP
  const [mcpPort, setMcpPort] = useState('3457')
  const [mcpStatus, setMcpStatus] = useState<{ isHttpConfigured: boolean } | null>(null)
  const [mcpApplying, setMcpApplying] = useState(false)
  const [mcpResult, setMcpResult] = useState<'ok' | 'fail' | null>(null)
  // Instances
  const [instances, setInstances] = useState<QalatraInstance[]>([])
  const [activeInstanceId, setActiveInstanceIdState] = useState<string | null>(null)
  const [instanceName, setInstanceName] = useState('')
  const [instanceUrl, setInstanceUrl] = useState('')
  const [instanceToken, setInstanceToken] = useState('')
  const [instanceMsg, setInstanceMsg] = useState<string | null>(null)
  const [testingInstance, setTestingInstance] = useState(false)
  const [localServer, setLocalServer] = useState<LocalServerStatus | null>(null)
  const [localServerBusy, setLocalServerBusy] = useState(false)
  const [localService, setLocalService] = useState<LocalServerServiceStatus | null>(null)
  const [localServiceBusy, setLocalServiceBusy] = useState(false)
  const [localServiceMsg, setLocalServiceMsg] = useState<string | null>(null)
  const [accessTokens, setAccessTokens] = useState<AccessToken[]>([])
  const [tokenLabel, setTokenLabel] = useState('Desktop client')
  const [tokenExpiryDays, setTokenExpiryDays] = useState('90')
  const [createdToken, setCreatedToken] = useState<string | null>(null)
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenMsg, setTokenMsg] = useState<string | null>(null)

  const { contexts, refresh: refreshContexts } = useContexts()
  const { mode: themeMode, effectiveMode, tokens, setMode: setThemeMode, setToken, resetOverrides } = useTheme()
  const [newSlug, setNewSlug] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newColor, setNewColor] = useState('#888888')
  const [editingSlug, setEditingSlug] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editColor, setEditColor] = useState('')

  useEffect(() => {
    fetchSettings().then(setSettings)
    fetchAgents().then(setAgents)
    getMcpStatus().then(s => { setMcpPort(String(s.port)); setMcpStatus(s) })
    setInstances(getInstances())
    setActiveInstanceIdState(getActiveInstanceId())
    refreshLocalServer()
    refreshAccessTokens()
    refreshContexts()
    getKeyStatus().then(s => setKeyPresent(s.present))
    getBackupStatus().then(setBackupStatus)
  }, [])

  async function handleSave() {
    await saveSettings(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  function set(key: string, value: string) {
    setSettings(s => ({ ...s, [key]: value }))
  }

  async function refreshLocalServer() {
    await Promise.all([
      getLocalServerStatus().then(status => {
        setLocalServer(status)
        if (status.service) setLocalService(status.service)
      }).catch(() => {}),
      getLocalServerServiceStatus().then(setLocalService).catch(() => {}),
    ])
  }

  async function setKeepServerRunning(checked: boolean) {
    const next = { ...settings, keepServerRunning: checked ? 'true' : 'false' }
    setSettings(next)
    await saveSettings(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
    refreshLocalServer()
  }

  async function runLocalServiceAction(action: 'install' | 'uninstall' | 'start' | 'stop' | 'restart') {
    setLocalServiceBusy(true)
    setLocalServiceMsg(null)
    try {
      const result =
        action === 'install' ? await installLocalServerService() :
        action === 'uninstall' ? await uninstallLocalServerService() :
        action === 'start' ? await startLocalServerService() :
        action === 'stop' ? await stopLocalServerService() :
        await restartLocalServerService()
      if (!result.ok) throw new Error(result.error || 'Service command failed')
      if (result.status) setLocalService(result.status)
      await refreshLocalServer()
      setLocalServiceMsg('Updated')
    } catch (e: any) {
      setLocalServiceMsg(e?.message ?? String(e))
    } finally {
      setLocalServiceBusy(false)
    }
  }

  function refreshInstances() {
    setInstances(getInstances())
    setActiveInstanceIdState(getActiveInstanceId())
  }

  async function refreshAccessTokens() {
    try {
      setAccessTokens(await listAccessTokens())
      setTokenMsg(null)
    } catch (e: any) {
      setTokenMsg(e?.message ?? String(e))
    }
  }

  return (
    <div className="sv-root">
      <div className="sv-tabs">
        {TABS.map(t => (
          <button
            key={t.key}
            className={`sv-tab${tab === t.key ? ' active' : ''}`}
            onClick={() => setTab(t.key)}
          >{t.label}</button>
        ))}
      </div>

      <div className="sv-body settings-body">

        {/* ── General ── */}
        {tab === 'general' && <>
          <div className="settings-section-header" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>Appearance</div>

          <div className="settings-row">
            <label className="settings-label">Theme</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['system', 'light', 'dark'] as ThemeMode[]).map(m => (
                <button
                  key={m}
                  className="settings-save"
                  style={{
                    padding: '4px 14px', fontSize: 12,
                    background: themeMode === m ? 'var(--accent)' : 'transparent',
                    border: '1px solid var(--border)',
                    color: themeMode === m ? '#fff' : 'var(--muted)',
                  }}
                  onClick={() => setThemeMode(m)}
                >
                  {m === 'system' ? '◑ System' : m === 'light' ? '☀ Light' : '☾ Dark'}
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
              <button className="settings-save" style={{ padding: '4px 12px', fontSize: 12, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                onClick={() => { Object.entries(DARK_TOKENS).forEach(([k, v]) => setToken(k as any, v)) }}>Reset to Dark</button>
              <button className="settings-save" style={{ padding: '4px 12px', fontSize: 12, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                onClick={() => { Object.entries(LIGHT_TOKENS).forEach(([k, v]) => setToken(k as any, v)) }}>Reset to Light</button>
              <button className="settings-save" style={{ padding: '4px 12px', fontSize: 12, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                onClick={resetOverrides}>Reset to Preset</button>
            </div>
          </div>

          <div className="settings-section-header">Terminal &amp; Agents</div>

          <div className="settings-row">
            <label className="settings-label">Terminal working directory</label>
            <input className="settings-input" type="text" value={settings.terminalCwd ?? ''}
              onChange={e => set('terminalCwd', e.target.value)}
              placeholder="e.g. /Users/you/Projects" spellCheck={false} />
            <span className="settings-hint">Takes effect on next terminal open</span>
          </div>
          <div className="settings-row">
            <label className="settings-label">Agents scan root</label>
            <input className="settings-input" type="text" value={settings.agentsRoot ?? ''}
              onChange={e => set('agentsRoot', e.target.value)}
              placeholder="Defaults to terminal working directory" spellCheck={false} />
            <span className="settings-hint">Folder scanned recursively for agent.config files. Set wider than terminal CWD to find agents in sister repos.</span>
          </div>
          <div className="settings-row">
            <label className="settings-label">Exclude agent folders</label>
            <input className="settings-input" type="text" value={settings.agentExcludeFolders ?? ''}
              onChange={e => set('agentExcludeFolders', e.target.value)}
              placeholder="e.g. projects-template, sandbox" spellCheck={false} />
            <span className="settings-hint">Comma-separated folder names to skip when scanning for agents.</span>
          </div>
          <div className="settings-row">
            <label className="settings-label">Terminal auto-run command</label>
            <input className="settings-input" type="text" value={settings.terminalAutoRun ?? ''}
              onChange={e => set('terminalAutoRun', e.target.value)}
              placeholder="e.g. dangerclaude" spellCheck={false} />
            <span className="settings-hint">Runs automatically when terminal opens. Takes effect on next terminal open.</span>
          </div>
          <div className="settings-row">
            <label className="settings-label">Default agent command</label>
            <input className="settings-input" type="text" value={settings.defaultAgentCommand ?? ''}
              onChange={e => set('defaultAgentCommand', e.target.value)}
              placeholder="claude --dangerously-skip-permissions" spellCheck={false} />
            <span className="settings-hint">Used when launching agents from task queue and the "Chat" button in file previewers. Per-agent agent.config overrides this.</span>
          </div>

          <div className="settings-section-header">MCP Server</div>

          <div className="settings-row">
            <label className="settings-label">HTTP Port</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input className="settings-input" type="number" min={1024} max={65535}
                value={mcpPort} onChange={e => { setMcpPort(e.target.value); setMcpResult(null) }}
                style={{ width: 100, flex: 'unset' }} />
              <button className="settings-save" disabled={mcpApplying}
                onClick={async () => {
                  setMcpApplying(true); setMcpResult(null)
                  const data = await applyMcpPort(parseInt(mcpPort, 10))
                  setMcpApplying(false)
                  if (data.ok) { setMcpResult('ok'); setMcpStatus({ isHttpConfigured: true }) }
                  else setMcpResult('fail')
                }}>{mcpApplying ? 'Applying…' : 'Apply'}</button>
              {mcpResult === 'ok'   && <span style={{ fontSize: 12, color: '#4ade80' }}>✓ Applied</span>}
              {mcpResult === 'fail' && <span style={{ fontSize: 12, color: '#ef4444' }}>✕ Failed</span>}
            </div>
            <span className="settings-hint">
              {mcpStatus?.isHttpConfigured
                ? '✓ Claude Code is configured to use HTTP transport'
                : 'Claude Code is using stdio — click Apply to switch to HTTP'}
            </span>
            {mcpResult === 'ok' && <span className="settings-hint" style={{ color: '#f59e0b' }}>Restart Claude Code to pick up the change.</span>}
          </div>

          <div className="settings-actions">
            <button className="settings-save" onClick={handleSave}>{saved ? 'Saved ✓' : 'Save'}</button>
          </div>
        </>}

        {/* ── Instances ── */}
        {tab === 'instances' && <>
          <div className="settings-section-header" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>Server Connections</div>

          <div className="settings-row">
            <label className="settings-label">Local HTTP Bridge</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: localServer?.running ? '#4ade80' : 'var(--muted)' }}>
                  {localServer?.running ? `Running at ${localServer.url}` : 'Not running'}
                </span>
                <button
                  className="settings-save"
                  disabled={localServerBusy}
                  style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                  onClick={async () => {
                    setLocalServerBusy(true)
                    const status = localServer?.running ? await restartLocalServer() : await startLocalServer()
                    setLocalServer(status)
                    setLocalServerBusy(false)
                  }}
                >
                  {localServerBusy ? 'Starting...' : localServer?.running ? 'Restart' : 'Start'}
                </button>
                {localServer?.running && localServer.token && (
                  <button
                    className="settings-save"
                    style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                    onClick={() => {
                      const savedInstance = upsertInstance({ name: 'Local Server', url: localServer.url, token: localServer.token! })
                      setActiveInstance(savedInstance.id)
                      refreshInstances()
                      window.location.reload()
                    }}
                  >
                    Use Local Server
                  </button>
                )}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text)' }}>
                <input
                  type="checkbox"
                  checked={(settings.keepServerRunning ?? (localServer?.keepServerRunning ? 'true' : 'false')) === 'true'}
                  onChange={e => setKeepServerRunning(e.target.checked)}
                />
                Keep local server and MCP running after Electron quits
              </label>
              <span className="settings-hint">
                The authenticated local server API runs against this machine's Qalatra database and owns MCP, agent workers, and backups.
                {localServer?.running && !localServer.managed ? ' This server is already running outside the Electron process.' : ''}
              </span>
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-label">Start at Login</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: localService?.installed ? '#4ade80' : 'var(--muted)' }}>
                  {localService?.disabledInDev
                    ? 'Disabled in electron-dev'
                    : localService?.supported === false
                    ? 'Unsupported on this platform'
                    : localService?.installed
                      ? `${localService.label}: ${localService.running ? 'running' : 'installed'}`
                      : `${localService?.label ?? 'Service'} not installed`}
                </span>
                {!localService?.installed ? (
                  <button
                    className="settings-save"
                    disabled={localServiceBusy || localService?.supported === false}
                    style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                    onClick={() => runLocalServiceAction('install')}
                  >
                    {localServiceBusy ? 'Installing...' : 'Install'}
                  </button>
                ) : (
                  <>
                    <button
                      className="settings-save"
                      disabled={localServiceBusy}
                      style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                      onClick={() => runLocalServiceAction(localService.running ? 'restart' : 'start')}
                    >
                      {localServiceBusy ? 'Working...' : localService.running ? 'Restart' : 'Start'}
                    </button>
                    <button
                      className="settings-save"
                      disabled={localServiceBusy}
                      style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                      onClick={() => runLocalServiceAction('stop')}
                    >
                      Stop
                    </button>
                    <button
                      className="settings-save"
                      disabled={localServiceBusy}
                      style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                      onClick={() => runLocalServiceAction('uninstall')}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
              <span className="settings-hint">
                {localService?.disabledInDev
                  ? 'Dev mode ignores installed OS services so npm run electron-dev always tests the current checkout. Set QALATRA_DEV_USE_SERVICE=1 only on a dedicated service test run.'
                  : 'Starts Qalatra Server automatically at user login using launchd, systemd, or Windows Task Scheduler. The API token is still required for every client.'}
              </span>
              {localService?.file && <span className="settings-hint">Service file: {localService.file}</span>}
              {localServiceMsg && (
                <span className="settings-hint" style={{ color: localServiceMsg === 'Updated' ? '#4ade80' : '#ef4444' }}>
                  {localServiceMsg}
                </span>
              )}
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-label">Active Instance</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button
                  className="settings-save"
                  style={{ background: !activeInstanceId ? 'var(--accent)' : 'transparent', border: '1px solid var(--border)', color: !activeInstanceId ? '#fff' : 'var(--muted)' }}
                  onClick={() => {
                    setActiveInstance(null)
                    refreshInstances()
                    window.location.reload()
                  }}
                >
                  Local Server
                </button>
                {instances.map(instance => (
                  <button
                    key={instance.id}
                    className="settings-save"
                    style={{ background: activeInstanceId === instance.id ? 'var(--accent)' : 'transparent', border: '1px solid var(--border)', color: activeInstanceId === instance.id ? '#fff' : 'var(--muted)' }}
                    onClick={() => {
                      setActiveInstance(instance.id)
                      refreshInstances()
                      window.location.reload()
                    }}
                  >
                    {instance.name}
                  </button>
                ))}
              </div>
              <span className="settings-hint">
                Local Server is the default authenticated API running against this machine's Qalatra database. Remote instances use the same API with their own URL and token.
              </span>
            </div>
          </div>

          {instances.length > 0 && (
            <div className="settings-row">
              <label className="settings-label">Saved Servers</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {instances.map(instance => (
                  <div key={instance.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) minmax(220px, 2fr) auto', gap: 8, alignItems: 'center', fontSize: 12 }}>
                    <strong style={{ color: 'var(--text)' }}>{instance.name}</strong>
                    <span style={{ color: 'var(--muted)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>{instance.url}</span>
                    <button
                      className="settings-save"
                      style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', padding: '3px 8px', fontSize: 11 }}
                      onClick={() => {
                        if (!confirm(`Remove ${instance.name}?`)) return
                        removeInstance(instance.id)
                        refreshInstances()
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="settings-section-header">Access Tokens</div>

          <div className="settings-row">
            <label className="settings-label">Create Token</label>
            <input className="settings-input" type="text" value={tokenLabel}
              onChange={e => setTokenLabel(e.target.value)}
              placeholder="Linux worker, iPhone, web app" spellCheck={false} />
            <select className="settings-input" value={tokenExpiryDays}
              onChange={e => setTokenExpiryDays(e.target.value)}
              style={{ marginTop: 8 }}>
              {TOKEN_EXPIRY_OPTIONS.map(option => (
                <option key={option.value || 'none'} value={option.value}>{option.label}</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button
                className="settings-save"
                disabled={tokenBusy || !tokenLabel.trim()}
                onClick={async () => {
                  setTokenBusy(true)
                  setCreatedToken(null)
                  try {
                    const expiresInDays = tokenExpiryDays ? Number(tokenExpiryDays) : null
                    const created = await createAccessToken(tokenLabel.trim(), 'full_access', expiresInDays)
                    setCreatedToken(created.token)
                    await refreshAccessTokens()
                  } catch (e: any) {
                    setTokenMsg(e?.message ?? String(e))
                  } finally {
                    setTokenBusy(false)
                  }
                }}
              >
                {tokenBusy ? 'Creating…' : 'Create full-access token'}
              </button>
              <button
                className="settings-save"
                style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                onClick={refreshAccessTokens}
              >
                Refresh
              </button>
            </div>
            {createdToken && (
              <div style={{ marginTop: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', fontSize: 12 }}>
                <div style={{ color: 'var(--muted)', marginBottom: 6 }}>New token. It is shown once; store it before leaving this screen.</div>
                <code style={{ color: 'var(--text)', wordBreak: 'break-all' }}>{createdToken}</code>
              </div>
            )}
            {tokenMsg && <span className="settings-hint" style={{ color: '#ef4444' }}>{tokenMsg}</span>}
          </div>

          {accessTokens.length > 0 && (
            <div className="settings-row">
              <label className="settings-label">Existing Tokens</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {accessTokens.map(token => {
                  const inactive = !!token.revoked_at || tokenIsExpired(token)
                  return (
                    <div key={token.id} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, alignItems: 'center', fontSize: 12 }}>
                      <strong style={{ color: inactive ? 'var(--muted)' : 'var(--text)', textDecoration: inactive ? 'line-through' : 'none' }}>{token.label}</strong>
                      <span style={{ color: 'var(--muted)', fontFamily: 'monospace' }}>{token.scopes}</span>
                      <span style={{ color: 'var(--muted)' }}>{tokenExpiryLabel(token)}</span>
                      <span style={{ color: 'var(--muted)' }}>{token.last_used_at ? `Used ${token.last_used_at}` : 'Never used'}</span>
                      <button
                        className="settings-save"
                        disabled={!!token.revoked_at}
                        style={{ background: 'transparent', border: '1px solid var(--border)', color: token.revoked_at ? 'var(--muted)' : '#ef4444', padding: '3px 8px', fontSize: 11 }}
                        onClick={async () => {
                          if (!confirm(`Revoke ${token.label}?`)) return
                          await revokeAccessToken(token.id)
                          await refreshAccessTokens()
                        }}
                      >
                        {token.revoked_at ? 'Revoked' : 'Revoke'}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className="settings-section-header">Add Server</div>

          <div className="settings-row">
            <label className="settings-label">Name</label>
            <input className="settings-input" type="text" value={instanceName}
              onChange={e => setInstanceName(e.target.value)}
              placeholder="Linux Worker 1" spellCheck={false} />
          </div>
          <div className="settings-row">
            <label className="settings-label">URL</label>
            <input className="settings-input" type="text" value={instanceUrl}
              onChange={e => setInstanceUrl(e.target.value)}
              placeholder="https://worker.example.com or http://127.0.0.1:3456" spellCheck={false} />
          </div>
          <div className="settings-row">
            <label className="settings-label">Access Token</label>
            <input className="settings-input" type="password" value={instanceToken}
              onChange={e => setInstanceToken(e.target.value)}
              placeholder="qalatra_..." spellCheck={false} />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                className="settings-save"
                disabled={testingInstance || !instanceUrl.trim() || !instanceToken.trim()}
                onClick={async () => {
                  setTestingInstance(true)
                  setInstanceMsg(null)
                  const result = await testInstanceConnection({ url: instanceUrl, token: instanceToken })
                  setTestingInstance(false)
                  if (result.ok) setInstanceMsg(`Connected${result.name ? ` to ${result.name}` : ''}.`)
                  else setInstanceMsg(result.error ?? 'Connection failed.')
                }}
              >
                {testingInstance ? 'Testing…' : 'Test'}
              </button>
              <button
                className="settings-save"
                disabled={!instanceName.trim() || !instanceUrl.trim() || !instanceToken.trim()}
                onClick={() => {
                  const savedInstance = upsertInstance({ name: instanceName, url: instanceUrl, token: instanceToken })
                  setActiveInstance(savedInstance.id)
                  setInstanceName('')
                  setInstanceUrl('')
                  setInstanceToken('')
                  refreshInstances()
                  setInstanceMsg('Saved. Reloading against the new server…')
                  setTimeout(() => window.location.reload(), 400)
                }}
              >
                Save &amp; Use
              </button>
            </div>
            {instanceMsg && <span className="settings-hint" style={{ color: instanceMsg.includes('Connected') || instanceMsg.includes('Saved') ? '#4ade80' : '#ef4444' }}>{instanceMsg}</span>}
          </div>
        </>}

        {/* ── Storage ── */}
        {tab === 'storage' && <>
          <div className="settings-section-header" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>Attachments &amp; Storage</div>

          <div className="settings-row">
            <label className="settings-label">S3 Endpoint URL</label>
            <input className="settings-input" type="text" value={settings.s3Endpoint ?? ''}
              onChange={e => set('s3Endpoint', e.target.value)}
              placeholder="https://<account_id>.r2.cloudflarestorage.com" spellCheck={false} />
            <span className="settings-hint">Cloudflare R2 recommended. Any S3-compatible endpoint works.</span>
          </div>
          <div className="settings-row">
            <label className="settings-label">Bucket Name</label>
            <input className="settings-input" type="text" value={settings.s3Bucket ?? ''}
              onChange={e => set('s3Bucket', e.target.value)}
              placeholder="qalatra-attachments" spellCheck={false} />
          </div>
          <div className="settings-row">
            <label className="settings-label">Access Key ID</label>
            <input className="settings-input" type="text" value={settings.s3AccessKey ?? ''}
              onChange={e => set('s3AccessKey', e.target.value)} spellCheck={false} />
          </div>
          <div className="settings-row">
            <label className="settings-label">Secret Access Key</label>
            <input className="settings-input" type="password" value={settings.s3SecretKey ?? ''}
              onChange={e => set('s3SecretKey', e.target.value)} />
          </div>
          <div className="settings-row">
            <label className="settings-label">Public Base URL <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
            <input className="settings-input" type="text" value={settings.s3PublicUrl ?? ''}
              onChange={e => set('s3PublicUrl', e.target.value)}
              placeholder="https://assets.yourdomain.com — leave blank to use presigned URLs" spellCheck={false} />
          </div>
          <div className="settings-row">
            <label className="settings-label">Local Attachment Cache</label>
            <input className="settings-input" type="text" value={settings.attachmentCacheDir ?? ''}
              onChange={e => set('attachmentCacheDir', e.target.value)}
              placeholder="~/Library/Application Support/qalatra/attachments" spellCheck={false} />
            <span className="settings-hint">Files are always cached here locally regardless of cloud storage.</span>
          </div>

          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="settings-save" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                onClick={async () => {
                  setS3TestResult(null)
                  const data = await testS3Connection({
                    s3Endpoint: settings.s3Endpoint, s3Bucket: settings.s3Bucket,
                    s3AccessKey: settings.s3AccessKey, s3SecretKey: settings.s3SecretKey,
                  })
                  setS3TestResult(data.ok ? 'ok' : 'fail')
                }}>Test Connection</button>
              {s3TestResult === 'ok'   && <span style={{ fontSize: 12, color: '#4ade80' }}>✓ Connected</span>}
              {s3TestResult === 'fail' && <span style={{ fontSize: 12, color: '#ef4444' }}>✕ Failed</span>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="settings-save" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                disabled={syncing}
                onClick={async () => {
                  setSyncing(true); setSyncResult(null)
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

          <div className="settings-actions">
            <button className="settings-save" onClick={handleSave}>{saved ? 'Saved ✓' : 'Save'}</button>
          </div>
        </>}

        {/* ── Encryption & Backup ── */}
        {tab === 'encryption' && <>
          <div className="settings-section-header" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>Encryption Key</div>

          <div className="settings-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {keyPresent
                ? <span style={{ fontSize: 12, color: '#4ade80' }}>✓ Key present</span>
                : <span style={{ fontSize: 12, color: 'var(--muted)' }}>No key — attachments and backups will not be encrypted</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="settings-save" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                onClick={async () => {
                  if (keyPresent && !window.confirm('A key already exists. Generating a new one will make existing encrypted data unreadable unless you re-encrypt it. Continue?')) return
                  const res = await generateKey()
                  if (res.ok) { setKeyPresent(true); setKeyMsg('Key generated and saved to keystore.') }
                  else setKeyMsg('Failed to generate key.')
                  setTimeout(() => setKeyMsg(null), 4000)
                }}>{keyPresent ? 'Regenerate key' : 'Generate key'}</button>
              {keyPresent && (
                <button className="settings-save" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                  onClick={async () => {
                    const res = await exportKey()
                    if (res.ok && res.key) setExportedKey(res.key)
                    else setKeyMsg(res.error ?? 'Export failed.')
                  }}>Export key</button>
              )}
            </div>
            {exportedKey && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Copy this key and store it in 1Password or a secure drive:</div>
                <textarea readOnly value={exportedKey} rows={3}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: 11, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: 6, resize: 'none' }}
                  onClick={e => (e.target as HTMLTextAreaElement).select()} />
                <button className="settings-save" style={{ marginTop: 4, padding: '3px 10px', fontSize: 11, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                  onClick={() => setExportedKey(null)}>Hide</button>
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Import key (paste base64 key from recovery kit):</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="settings-input" type="text" value={importKeyInput}
                  onChange={e => setImportKeyInput(e.target.value)}
                  placeholder="Paste base64 key…" spellCheck={false}
                  style={{ fontFamily: 'monospace', fontSize: 11 }} />
                <button className="settings-save" disabled={!importKeyInput.trim()}
                  onClick={async () => {
                    const res = await importKey(importKeyInput.trim())
                    if (res.ok) { setKeyPresent(true); setImportKeyInput(''); setKeyMsg('Key imported successfully.') }
                    else setKeyMsg(res.error ?? 'Import failed.')
                    setTimeout(() => setKeyMsg(null), 4000)
                  }}>Import</button>
              </div>
            </div>
            {keyMsg && <span style={{ fontSize: 12, color: '#4ade80', marginTop: 6, display: 'block' }}>{keyMsg}</span>}
          </div>

          <div className="settings-section-header">Backup</div>

          <div className="settings-row">
            <label className="settings-label">Backup Bucket Name</label>
            <input className="settings-input" type="text" value={settings.backupBucket ?? ''}
              onChange={e => set('backupBucket', e.target.value)}
              placeholder="qalatra-backups" spellCheck={false} />
            <span className="settings-hint">Separate R2 bucket for encrypted DB backups. Uses same endpoint, access key, and secret as attachments.</span>
          </div>

          <div className="settings-row">
            <label className="settings-label">Database Backup</label>
            {backupStatus && (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
                Last backup:{' '}
                {backupStatus.lastTime
                  ? <><span style={{ color: backupStatus.lastStatus === 'ok' ? '#4ade80' : '#ef4444' }}>{backupStatus.lastStatus === 'ok' ? '✓' : '✕'}</span>{' '}{new Date(backupStatus.lastTime).toLocaleString()}</>
                  : 'Never'}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="settings-save" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                disabled={backupRunning}
                onClick={async () => {
                  setBackupRunning(true); setBackupMsg(null)
                  const res = await runBackup()
                  setBackupRunning(false)
                  if (res.ok) {
                    setBackupMsg(`Backup complete${res.size ? ` (${(res.size / 1024).toFixed(0)} KB)` : ''}`)
                    getBackupStatus().then(setBackupStatus)
                  } else {
                    setBackupMsg(res.error ?? 'Backup failed.')
                  }
                  setTimeout(() => setBackupMsg(null), 5000)
                }}>{backupRunning ? 'Backing up…' : 'Run backup now'}</button>
              <button className="settings-save" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                disabled={backupListLoading}
                onClick={async () => {
                  if (backupList !== null) { setBackupList(null); return }
                  setBackupListLoading(true)
                  const res = await listBackups()
                  setBackupListLoading(false)
                  setBackupList(res.items ?? [])
                }}>{backupListLoading ? 'Loading…' : backupList !== null ? 'Hide history' : 'Show backup history'}</button>
            </div>
            {backupMsg && <span style={{ fontSize: 12, color: '#4ade80', marginTop: 6, display: 'block' }}>{backupMsg}</span>}
            {backupList !== null && (
              <div style={{ marginTop: 8 }}>
                {backupList.length === 0
                  ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>No backups found.</span>
                  : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {backupList.map(item => (
                        <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                          <span style={{ color: 'var(--text)', fontFamily: 'monospace' }}>{item.date}</span>
                          <span style={{ color: 'var(--muted)' }}>{(item.size / 1024).toFixed(0)} KB</span>
                          <button className="settings-save"
                            style={{ padding: '2px 8px', fontSize: 11, background: restoringKey === item.key ? 'var(--accent)' : 'transparent', border: '1px solid var(--border)', color: restoringKey === item.key ? '#fff' : 'var(--muted)' }}
                            disabled={restoringKey !== null}
                            onClick={async () => {
                              if (!window.confirm(`Restore backup from ${item.date}? The app will need to restart to apply it.`)) return
                              setRestoringKey(item.key)
                              const res = await restoreBackup(item.key)
                              setRestoringKey(null)
                              if (res.ok) alert(res.message ?? 'Restore queued. Restart the app to apply.')
                              else alert(res.error ?? 'Restore failed.')
                            }}>{restoringKey === item.key ? 'Restoring…' : 'Restore'}</button>
                        </div>
                      ))}
                    </div>
                  )}
              </div>
            )}
          </div>

          <div className="settings-section-header">Recovery Kit</div>

          <div className="settings-row">
            <label className="settings-label">Export Settings</label>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              Save your settings (S3 credentials, bucket names, etc.) to 1Password or a secure drive as part of your recovery kit.
            </div>
            <button className="settings-save" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
              onClick={async () => {
                const res = await exportSettings()
                if (res.ok && res.json) setExportedSettings(res.json)
              }}>Export settings</button>
            {exportedSettings && (
              <div style={{ marginTop: 8 }}>
                <textarea readOnly value={exportedSettings} rows={6}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: 11, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: 6, resize: 'vertical' }}
                  onClick={e => (e.target as HTMLTextAreaElement).select()} />
                <button className="settings-save" style={{ marginTop: 4, padding: '3px 10px', fontSize: 11, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                  onClick={() => setExportedSettings(null)}>Hide</button>
              </div>
            )}
          </div>

          <div className="settings-row">
            <label className="settings-label">Import Settings</label>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              Paste your exported settings JSON to restore configuration on a new machine.
            </div>
            <textarea className="settings-input" value={importSettingsInput}
              onChange={e => setImportSettingsInput(e.target.value)}
              placeholder="Paste settings JSON…" rows={4} spellCheck={false}
              style={{ fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }} />
            <button className="settings-save" style={{ marginTop: 6, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
              disabled={!importSettingsInput.trim()}
              onClick={async () => {
                const res = await importSettings(importSettingsInput.trim())
                if (res.ok) {
                  setImportSettingsInput('')
                  setRecoveryMsg('Settings imported. Reload to apply.')
                  fetchSettings().then(setSettings)
                } else {
                  setRecoveryMsg(res.error ?? 'Import failed.')
                }
                setTimeout(() => setRecoveryMsg(null), 5000)
              }}>Import</button>
            {recoveryMsg && <span style={{ fontSize: 12, color: '#4ade80', marginTop: 6, display: 'block' }}>{recoveryMsg}</span>}
          </div>

          <div className="settings-actions">
            <button className="settings-save" onClick={handleSave}>{saved ? 'Saved ✓' : 'Save'}</button>
          </div>
        </>}

        {/* ── Contexts ── */}
        {tab === 'contexts' && <>
          <div className="settings-section-header" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>Contexts</div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {contexts.map(c => (
              <div key={c.slug} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {editingSlug === c.slug ? (
                  <>
                    <input type="color" value={editColor} onChange={e => setEditColor(e.target.value)}
                      style={{ width: 28, height: 28, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
                    <input className="settings-input" style={{ width: 180, flex: 'unset' }} value={editLabel}
                      onChange={e => setEditLabel(e.target.value)} />
                    <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>{c.slug}</span>
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
                    <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{c.label}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>{c.slug}</span>
                    <button style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12, padding: '2px 6px' }}
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
        </>}

        {/* ── Agents ── */}
        {tab === 'agents' && <>
          <div className="settings-section-header" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
            Discovered Agents ({agents.length})
          </div>

          <div style={{ marginBottom: 12 }}>
            <button className="settings-save" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
              disabled={rescanning}
              onClick={async () => {
                setRescanning(true)
                await rescanAgents()
                const fresh = await fetchAgents()
                setAgents(fresh)
                setRescanning(false)
              }}>{rescanning ? 'Scanning…' : 'Rescan agents'}</button>
          </div>

          {agents.length === 0
            ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>No agents found. Set an agents scan root in General settings.</div>
            : (() => {
                // Group: context → project → agents
                const byContext = new Map<string, Map<string, typeof agents>>()
                for (const a of agents) {
                  const ctx = a.context ?? '(no context)'
                  const proj = a.project ?? '(no project)'
                  if (!byContext.has(ctx)) byContext.set(ctx, new Map())
                  const byProject = byContext.get(ctx)!
                  if (!byProject.has(proj)) byProject.set(proj, [])
                  byProject.get(proj)!.push(a)
                }
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                    {[...byContext.entries()].map(([ctx, byProject]) => {
                      const collapsed = collapsedContexts.has(ctx)
                      return (
                        <div key={ctx}>
                          <button
                            onClick={() => toggleContext(ctx)}
                            style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, marginBottom: collapsed ? 0 : 12, width: '100%' }}
                          >
                            <span style={{ fontSize: 10, color: 'var(--muted)', transition: 'transform 0.15s', display: 'inline-block', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▾</span>
                            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent)' }}>{ctx}</span>
                            <span style={{ fontSize: 11, color: 'var(--muted)' }}>({[...byProject.values()].reduce((n, g) => n + g.length, 0)})</span>
                          </button>
                          {!collapsed && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                              {[...byProject.entries()].map(([proj, group]) => (
                                <div key={proj}>
                                  {byProject.size > 1 && (
                                    <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', marginBottom: 8, paddingBottom: 4, borderBottom: '1px solid var(--border)' }}>{proj}</div>
                                  )}
                                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                                    {group.map(a => (
                                      <div key={a.path} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '11px 13px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.3 }}>{a.name}</div>
                                        {a.description && (
                                          <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5 }}>{a.description}</div>
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
                )
              })()
            }
        </>}

      </div>
    </div>
  )
}
