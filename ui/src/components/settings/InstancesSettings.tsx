import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import {
  createAccessToken, getAccessTokenExpiryLabel, getActiveInstanceId, getDefaultInstanceId,
  getHideLocalInstance, getInstances,
  getLocalServerServiceStatus, getLocalServerStatus, installLocalServerService,
  listAccessTokens, removeInstance, restartLocalServer, restartLocalServerService,
  revokeAccessToken, saveSettings, setActiveInstance, setDefaultInstance,
  setHideLocalInstance, startLocalServer, startLocalServerService, stopLocalServerService,
  testInstanceConnection, tokenIsExpired, uninstallLocalServerService, upsertInstance,
  type AccessToken, type LocalServerServiceStatus, type LocalServerStatus,
  type QalatraInstance,
} from '../../api'

const TOKEN_EXPIRY_OPTIONS = [
  { label: '30 days', value: '30' },
  { label: '90 days', value: '90' },
  { label: '1 year', value: '365' },
  { label: 'No expiry', value: '' },
]

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

interface InstancesSettingsProps {
  settings: Record<string, string>
  setSettings: Dispatch<SetStateAction<Record<string, string>>>
  markSaved: () => void
}

export function InstancesSettings({ settings, setSettings, markSaved }: InstancesSettingsProps) {
  const [instances, setInstances] = useState<QalatraInstance[]>([])
  const [activeInstanceId, setActiveInstanceIdState] = useState<string | null>(null)
  const [defaultInstanceId, setDefaultInstanceIdState] = useState<string | null>(null)
  const [hideLocalInstance, setHideLocalInstanceState] = useState(false)
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

  useEffect(() => {
    refreshInstances()
    refreshLocalServer()
    refreshAccessTokens()
  }, [])

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
    markSaved()
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
    } catch (error: unknown) {
      setLocalServiceMsg(errorMessage(error))
    } finally {
      setLocalServiceBusy(false)
    }
  }

  function refreshInstances() {
    setInstances(getInstances())
    setActiveInstanceIdState(getActiveInstanceId())
    setDefaultInstanceIdState(getDefaultInstanceId())
    setHideLocalInstanceState(getHideLocalInstance())
  }

  function selectInstance(id: string | null) {
    setActiveInstance(id)
    refreshInstances()
    window.location.reload()
  }

  function chooseDefaultInstance(id: string | null) {
    setDefaultInstance(id)
    refreshInstances()
  }

  function toggleHideLocalInstance(checked: boolean) {
    setHideLocalInstance(checked)
    refreshInstances()
  }

  async function refreshAccessTokens() {
    try {
      setAccessTokens(await listAccessTokens())
      setTokenMsg(null)
    } catch (error: unknown) {
      setTokenMsg(errorMessage(error))
    }
  }

  return (
    <>
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
            {localServer?.running && (
              <button
                className="settings-save"
                style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                onClick={() => selectInstance(null)}
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
              onClick={() => selectInstance(null)}
            >
              Local Server
            </button>
            {instances.map(instance => (
              <button
                key={instance.id}
                className="settings-save"
                style={{ background: activeInstanceId === instance.id ? 'var(--accent)' : 'transparent', border: '1px solid var(--border)', color: activeInstanceId === instance.id ? '#fff' : 'var(--muted)' }}
                onClick={() => selectInstance(instance.id)}
              >
                {instance.name}
              </button>
            ))}
          </div>
          <span className="settings-hint">
            Active Instance applies to the current app session. Startup Default controls which server is selected after a full restart.
          </span>
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-label">Startup Default</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="settings-save"
              style={{ background: !defaultInstanceId ? 'var(--accent)' : 'transparent', border: '1px solid var(--border)', color: !defaultInstanceId ? '#fff' : 'var(--muted)' }}
              onClick={() => chooseDefaultInstance(null)}
            >
              Local Server
            </button>
            {instances.map(instance => (
              <button
                key={instance.id}
                className="settings-save"
                style={{ background: defaultInstanceId === instance.id ? 'var(--accent)' : 'transparent', border: '1px solid var(--border)', color: defaultInstanceId === instance.id ? '#fff' : 'var(--muted)' }}
                onClick={() => chooseDefaultInstance(instance.id)}
              >
                {instance.name}
              </button>
            ))}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text)' }}>
            <input
              type="checkbox"
              checked={hideLocalInstance}
              onChange={e => toggleHideLocalInstance(e.target.checked)}
            />
            Hide Local Server in the header instance switcher
          </label>
          <span className="settings-hint">
            Local Server remains available here even when hidden from the header. Remote instances use the same authenticated API with their own URL and token.
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

      {/* The "Tools" (boxWeb) sidebar item moved to Settings → Sidebar, where it's
          configured per backend alongside the rest of the nav (show/hide + label),
          so it's no longer set here. */}

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
              } catch (error: unknown) {
                setTokenMsg(errorMessage(error))
              } finally {
                setTokenBusy(false)
              }
            }}
          >
            {tokenBusy ? 'Creating...' : 'Create full-access token'}
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
                  <span style={{ color: 'var(--muted)' }}>{getAccessTokenExpiryLabel(token)}</span>
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
            {testingInstance ? 'Testing...' : 'Test'}
          </button>
          <button
            className="settings-save"
            disabled={!instanceName.trim() || !instanceUrl.trim() || !instanceToken.trim()}
            onClick={() => {
              const savedInstance = upsertInstance({ name: instanceName, url: instanceUrl, token: instanceToken })
              setDefaultInstance(savedInstance.id)
              setActiveInstance(savedInstance.id)
              setInstanceName('')
              setInstanceUrl('')
              setInstanceToken('')
              refreshInstances()
              setInstanceMsg('Saved. Reloading against the new server...')
              setTimeout(() => window.location.reload(), 400)
            }}
          >
            Save &amp; Use
          </button>
        </div>
        {instanceMsg && <span className="settings-hint" style={{ color: instanceMsg.includes('Connected') || instanceMsg.includes('Saved') ? '#4ade80' : '#ef4444' }}>{instanceMsg}</span>}
      </div>
    </>
  )
}
