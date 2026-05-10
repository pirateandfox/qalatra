import { useState, useEffect } from 'react'
import { fetchSettings, saveSettings, fetchAgents, syncAttachments, getMcpStatus, applyMcpPort, createContext, updateContext, deleteContext, getKeyStatus, generateKey, exportKey, importKey, runBackup, getBackupStatus, listBackups, restoreBackup, exportSettings, importSettings, type Agent, type BackupItem } from '../api'
import { useContexts } from '../lib/ContextsProvider'
import { useTheme } from '../lib/ThemeProvider'
import { TOKEN_KEYS, TOKEN_LABELS, DARK_TOKENS, LIGHT_TOKENS, type ThemeMode } from '../lib/theme'
import BottomPanel from './BottomPanel'
import './Settings.css'

interface Props {
  open: boolean
  fullscreen: boolean
  onClose: () => void
  onToggleFullscreen: () => void
}

export default function Settings({ open, fullscreen, onClose, onToggleFullscreen }: Props) {
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [agents, setAgents] = useState<Agent[]>([])
  const [saved, setSaved] = useState(false)
  const [s3TestResult, setS3TestResult] = useState<'ok' | 'fail' | null>(null)
  const [syncResult, setSyncResult] = useState<{ synced: number; failed: number; total: number } | null>(null)
  const [syncing, setSyncing] = useState(false)
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
  const [mcpPort, setMcpPort] = useState('3457')
  const [mcpStatus, setMcpStatus] = useState<{ isHttpConfigured: boolean } | null>(null)
  const [mcpApplying, setMcpApplying] = useState(false)
  const [mcpResult, setMcpResult] = useState<'ok' | 'fail' | null>(null)
  const { contexts, refresh: refreshContexts } = useContexts()
  const { mode: themeMode, effectiveMode, tokens, setMode: setThemeMode, setToken, resetOverrides } = useTheme()
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
      getKeyStatus().then(s => setKeyPresent(s.present))
      getBackupStatus().then(setBackupStatus)
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
    <BottomPanel
      title="Settings"
      open={open}
      fullscreen={fullscreen}
      onClose={onClose}
      onToggleFullscreen={onToggleFullscreen}
      dockedHeight={520}
      zIndex={98}
    >
      <div className="settings-body">

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
            <button
              className="settings-save"
              style={{ padding: '4px 12px', fontSize: 12, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
              onClick={() => { Object.entries(DARK_TOKENS).forEach(([k, v]) => setToken(k as any, v)) }}
            >Reset to Dark</button>
            <button
              className="settings-save"
              style={{ padding: '4px 12px', fontSize: 12, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
              onClick={() => { Object.entries(LIGHT_TOKENS).forEach(([k, v]) => setToken(k as any, v)) }}
            >Reset to Light</button>
            <button
              className="settings-save"
              style={{ padding: '4px 12px', fontSize: 12, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
              onClick={resetOverrides}
            >Reset to Preset</button>
          </div>
        </div>

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
          <label className="settings-label">Exclude agent folders</label>
          <input
            className="settings-input"
            type="text"
            value={settings.agentExcludeFolders ?? ''}
            onChange={e => set('agentExcludeFolders', e.target.value)}
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
            placeholder="qalatra-attachments" spellCheck={false} />
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
            placeholder="e.g. ~/Library/Application Support/qalatra/attachments or C:\Users\you\AppData\Roaming\qalatra" spellCheck={false} />
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

        <div className="settings-section-header">Encryption</div>

        <div className="settings-row">
          <label className="settings-label">Encryption Key</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {keyPresent
              ? <span style={{ fontSize: 12, color: '#4ade80' }}>✓ Key present</span>
              : <span style={{ fontSize: 12, color: 'var(--muted)' }}>No key — attachments and backups will not be encrypted</span>}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button
              className="settings-save"
              style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
              onClick={async () => {
                if (keyPresent && !window.confirm('A key already exists. Generating a new one will make existing encrypted data unreadable unless you re-encrypt it. Continue?')) return
                const res = await generateKey()
                if (res.ok) { setKeyPresent(true); setKeyMsg('Key generated and saved to keystore.') }
                else setKeyMsg('Failed to generate key.')
                setTimeout(() => setKeyMsg(null), 4000)
              }}
            >{keyPresent ? 'Regenerate key' : 'Generate key'}</button>
            {keyPresent && (
              <button
                className="settings-save"
                style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                onClick={async () => {
                  const res = await exportKey()
                  if (res.ok && res.key) setExportedKey(res.key)
                  else setKeyMsg(res.error ?? 'Export failed.')
                }}
              >Export key</button>
            )}
          </div>
          {exportedKey && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Copy this key and store it in 1Password or a secure drive:</div>
              <textarea
                readOnly
                value={exportedKey}
                rows={3}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: 11, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: 6, resize: 'none' }}
                onClick={e => (e.target as HTMLTextAreaElement).select()}
              />
              <button
                className="settings-save"
                style={{ marginTop: 4, padding: '3px 10px', fontSize: 11, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                onClick={() => setExportedKey(null)}
              >Hide</button>
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Import key (paste base64 key from recovery kit):</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="settings-input"
                type="text"
                value={importKeyInput}
                onChange={e => setImportKeyInput(e.target.value)}
                placeholder="Paste base64 key…"
                spellCheck={false}
                style={{ fontFamily: 'monospace', fontSize: 11 }}
              />
              <button
                className="settings-save"
                disabled={!importKeyInput.trim()}
                onClick={async () => {
                  const res = await importKey(importKeyInput.trim())
                  if (res.ok) { setKeyPresent(true); setImportKeyInput(''); setKeyMsg('Key imported successfully.') }
                  else setKeyMsg(res.error ?? 'Import failed.')
                  setTimeout(() => setKeyMsg(null), 4000)
                }}
              >Import</button>
            </div>
          </div>
          {keyMsg && <span style={{ fontSize: 12, color: '#4ade80', marginTop: 6, display: 'block' }}>{keyMsg}</span>}
        </div>

        <div className="settings-section-header">Backup</div>

        <div className="settings-row">
          <label className="settings-label">Backup Bucket Name</label>
          <input
            className="settings-input"
            type="text"
            value={settings.backupBucket ?? ''}
            onChange={e => set('backupBucket', e.target.value)}
            placeholder="qalatra-backups"
            spellCheck={false}
          />
          <span className="settings-hint">Separate R2 bucket for encrypted DB backups. Uses same endpoint, access key, and secret as attachments.</span>
        </div>

        <div className="settings-row">
          <label className="settings-label">Database Backup</label>
          {backupStatus && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              Last backup: {backupStatus.lastTime
                ? <>
                    <span style={{ color: backupStatus.lastStatus === 'ok' ? '#4ade80' : '#ef4444' }}>
                      {backupStatus.lastStatus === 'ok' ? '✓' : '✕'}
                    </span>
                    {' '}{new Date(backupStatus.lastTime).toLocaleString()}
                  </>
                : 'Never'}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="settings-save"
              style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
              disabled={backupRunning}
              onClick={async () => {
                setBackupRunning(true)
                setBackupMsg(null)
                const res = await runBackup()
                setBackupRunning(false)
                if (res.ok) {
                  setBackupMsg(`Backup complete${res.size ? ` (${(res.size / 1024).toFixed(0)} KB)` : ''}`)
                  getBackupStatus().then(setBackupStatus)
                } else {
                  setBackupMsg(res.error ?? 'Backup failed.')
                }
                setTimeout(() => setBackupMsg(null), 5000)
              }}
            >{backupRunning ? 'Backing up…' : 'Run backup now'}</button>
            <button
              className="settings-save"
              style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
              disabled={backupListLoading}
              onClick={async () => {
                if (backupList !== null) { setBackupList(null); return }
                setBackupListLoading(true)
                const res = await listBackups()
                setBackupListLoading(false)
                setBackupList(res.items ?? [])
              }}
            >{backupListLoading ? 'Loading…' : backupList !== null ? 'Hide history' : 'Show backup history'}</button>
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
                        <button
                          className="settings-save"
                          style={{ padding: '2px 8px', fontSize: 11, background: restoringKey === item.key ? 'var(--accent)' : 'transparent', border: '1px solid var(--border)', color: restoringKey === item.key ? '#fff' : 'var(--muted)' }}
                          disabled={restoringKey !== null}
                          onClick={async () => {
                            if (!window.confirm(`Restore backup from ${item.date}? The app will need to restart to apply it.`)) return
                            setRestoringKey(item.key)
                            const res = await restoreBackup(item.key)
                            setRestoringKey(null)
                            if (res.ok) alert(res.message ?? 'Restore queued. Restart the app to apply.')
                            else alert(res.error ?? 'Restore failed.')
                          }}
                        >{restoringKey === item.key ? 'Restoring…' : 'Restore'}</button>
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
          <button
            className="settings-save"
            style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
            onClick={async () => {
              const res = await exportSettings()
              if (res.ok && res.json) setExportedSettings(res.json)
            }}
          >Export settings</button>
          {exportedSettings && (
            <div style={{ marginTop: 8 }}>
              <textarea
                readOnly
                value={exportedSettings}
                rows={6}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: 11, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: 6, resize: 'vertical' }}
                onClick={e => (e.target as HTMLTextAreaElement).select()}
              />
              <button
                className="settings-save"
                style={{ marginTop: 4, padding: '3px 10px', fontSize: 11, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                onClick={() => setExportedSettings(null)}
              >Hide</button>
            </div>
          )}
        </div>

        <div className="settings-row">
          <label className="settings-label">Import Settings</label>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
            Paste your exported settings JSON to restore configuration on a new machine.
          </div>
          <textarea
            className="settings-input"
            value={importSettingsInput}
            onChange={e => setImportSettingsInput(e.target.value)}
            placeholder="Paste settings JSON…"
            rows={4}
            spellCheck={false}
            style={{ fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }}
          />
          <button
            className="settings-save"
            style={{ marginTop: 6, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
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
            }}
          >Import</button>
          {recoveryMsg && <span style={{ fontSize: 12, color: '#4ade80', marginTop: 6, display: 'block' }}>{recoveryMsg}</span>}
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
                <div key={a.path} style={{ fontSize: 12, color: 'var(--muted)' }}>
                  <span style={{ color: 'var(--text)', fontWeight: 500 }}>{a.name}</span>
                  {a.description && <span style={{ marginLeft: 8, color: 'var(--muted)' }}>{a.description}</span>}
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>{a.relativePath}</div>
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
    </BottomPanel>
  )
}
