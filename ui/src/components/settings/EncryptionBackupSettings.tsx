import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import {
  exportKey,
  exportSettings,
  fetchSettings,
  generateKey,
  getBackupStatus,
  getKeyStatus,
  importKey,
  importSettings,
  listBackups,
  restoreBackup,
  runBackup,
  type BackupItem,
} from '../../api'

interface EncryptionBackupSettingsProps {
  settings: Record<string, string>
  setSettings: Dispatch<SetStateAction<Record<string, string>>>
  setSetting: (key: string, value: string) => void
  saved: boolean
  onSave: () => Promise<void>
}

export function EncryptionBackupSettings({ settings, setSettings, setSetting, saved, onSave }: EncryptionBackupSettingsProps) {
  const [keyPresent, setKeyPresent] = useState(false)
  const [exportedKey, setExportedKey] = useState<string | null>(null)
  const [importKeyInput, setImportKeyInput] = useState('')
  const [keyMsg, setKeyMsg] = useState<string | null>(null)
  const [backupStatus, setBackupStatus] = useState<{ lastTime: string | null; lastStatus: string | null } | null>(null)
  const [backupRunning, setBackupRunning] = useState(false)
  const [backupMsg, setBackupMsg] = useState<string | null>(null)
  const [backupList, setBackupList] = useState<BackupItem[] | null>(null)
  const [backupListLoading, setBackupListLoading] = useState(false)
  const [restoringKey, setRestoringKey] = useState<string | null>(null)
  const [exportedSettings, setExportedSettings] = useState<string | null>(null)
  const [importSettingsInput, setImportSettingsInput] = useState('')
  const [recoveryMsg, setRecoveryMsg] = useState<string | null>(null)

  useEffect(() => {
    getKeyStatus().then(s => setKeyPresent(s.present)).catch(() => {})
    getBackupStatus().then(setBackupStatus).catch(() => {})
  }, [])

  function setTransientKeyMessage(message: string) {
    setKeyMsg(message)
    setTimeout(() => setKeyMsg(null), 4000)
  }

  async function generateEncryptionKey() {
    if (keyPresent && !window.confirm('A key already exists. Generating a new one will make existing encrypted data unreadable unless you re-encrypt it. Continue?')) return
    const res = await generateKey()
    if (res.ok) {
      setKeyPresent(true)
      setTransientKeyMessage('Key generated and saved to keystore.')
    } else {
      setTransientKeyMessage('Failed to generate key.')
    }
  }

  async function exportEncryptionKey() {
    const res = await exportKey()
    if (res.ok && res.key) setExportedKey(res.key)
    else setTransientKeyMessage(res.error ?? 'Export failed.')
  }

  async function importEncryptionKey() {
    const res = await importKey(importKeyInput.trim())
    if (res.ok) {
      setKeyPresent(true)
      setImportKeyInput('')
      setTransientKeyMessage('Key imported successfully.')
    } else {
      setTransientKeyMessage(res.error ?? 'Import failed.')
    }
  }

  async function runManualBackup() {
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
  }

  async function toggleBackupHistory() {
    if (backupList !== null) {
      setBackupList(null)
      return
    }
    setBackupListLoading(true)
    const res = await listBackups()
    setBackupListLoading(false)
    setBackupList(res.items ?? [])
  }

  async function restoreBackupItem(item: BackupItem) {
    if (!window.confirm(`Restore backup from ${item.date}? The app will need to restart to apply it.`)) return
    setRestoringKey(item.key)
    const res = await restoreBackup(item.key)
    setRestoringKey(null)
    if (res.ok) alert(res.message ?? 'Restore queued. Restart the app to apply.')
    else alert(res.error ?? 'Restore failed.')
  }

  async function exportRecoverySettings() {
    const res = await exportSettings()
    if (res.ok && res.json) setExportedSettings(res.json)
  }

  async function importRecoverySettings() {
    const res = await importSettings(importSettingsInput.trim())
    if (res.ok) {
      setImportSettingsInput('')
      setRecoveryMsg('Settings imported. Reload to apply.')
      fetchSettings().then(setSettings)
    } else {
      setRecoveryMsg(res.error ?? 'Import failed.')
    }
    setTimeout(() => setRecoveryMsg(null), 5000)
  }

  return (
    <>
      <div className="settings-section-header" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>Encryption Key</div>

      <div className="settings-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {keyPresent
            ? <span style={{ fontSize: 12, color: '#4ade80' }}>Key present</span>
            : <span style={{ fontSize: 12, color: 'var(--muted)' }}>No key - attachments and backups will not be encrypted</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <button
            className="settings-save"
            style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
            onClick={generateEncryptionKey}
          >
            {keyPresent ? 'Regenerate key' : 'Generate key'}
          </button>
          {keyPresent && (
            <button
              className="settings-save"
              style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
              onClick={exportEncryptionKey}
            >
              Export key
            </button>
          )}
        </div>
        {exportedKey && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Store this key in 1Password or a secure drive:</div>
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
            >
              Hide
            </button>
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
              placeholder="Paste base64 key..."
              spellCheck={false}
              style={{ fontFamily: 'monospace', fontSize: 11 }}
            />
            <button className="settings-save" disabled={!importKeyInput.trim()} onClick={importEncryptionKey}>Import</button>
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
          onChange={e => setSetting('backupBucket', e.target.value)}
          placeholder="qalatra-backups"
          spellCheck={false}
        />
        <span className="settings-hint">Separate R2 bucket for encrypted DB backups. Uses same endpoint, access key, and secret as attachments.</span>
      </div>

      <div className="settings-row">
        <label className="settings-label">Database Backup</label>
        {backupStatus && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
            Last backup:{' '}
            {backupStatus.lastTime
              ? <><span style={{ color: backupStatus.lastStatus === 'ok' ? '#4ade80' : '#ef4444' }}>{backupStatus.lastStatus === 'ok' ? 'OK' : 'Failed'}</span>{' '}{new Date(backupStatus.lastTime).toLocaleString()}</>
              : 'Never'}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="settings-save"
            style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
            disabled={backupRunning}
            onClick={runManualBackup}
          >
            {backupRunning ? 'Backing up...' : 'Run backup now'}
          </button>
          <button
            className="settings-save"
            style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
            disabled={backupListLoading}
            onClick={toggleBackupHistory}
          >
            {backupListLoading ? 'Loading...' : backupList !== null ? 'Hide history' : 'Show backup history'}
          </button>
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
                        onClick={() => restoreBackupItem(item)}
                      >
                        {restoringKey === item.key ? 'Restoring...' : 'Restore'}
                      </button>
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
          onClick={exportRecoverySettings}
        >
          Export settings
        </button>
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
            >
              Hide
            </button>
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
          placeholder="Paste settings JSON..."
          rows={4}
          spellCheck={false}
          style={{ fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }}
        />
        <button
          className="settings-save"
          style={{ marginTop: 6, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
          disabled={!importSettingsInput.trim()}
          onClick={importRecoverySettings}
        >
          Import
        </button>
        {recoveryMsg && <span style={{ fontSize: 12, color: '#4ade80', marginTop: 6, display: 'block' }}>{recoveryMsg}</span>}
      </div>

      <div className="settings-actions">
        <button className="settings-save" onClick={onSave}>{saved ? 'Saved' : 'Save'}</button>
      </div>
    </>
  )
}
