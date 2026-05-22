import { useState } from 'react'
import { syncAttachments, testS3Connection } from '../../api'

interface StorageSettingsProps {
  settings: Record<string, string>
  setSetting: (key: string, value: string) => void
  saved: boolean
  onSave: () => Promise<void>
}

export function StorageSettings({ settings, setSetting, saved, onSave }: StorageSettingsProps) {
  const [s3TestResult, setS3TestResult] = useState<'ok' | 'fail' | null>(null)
  const [syncResult, setSyncResult] = useState<{ synced: number; failed: number; total: number } | null>(null)
  const [syncing, setSyncing] = useState(false)

  async function testConnection() {
    setS3TestResult(null)
    const data = await testS3Connection({
      s3Endpoint: settings.s3Endpoint,
      s3Bucket: settings.s3Bucket,
      s3AccessKey: settings.s3AccessKey,
      s3SecretKey: settings.s3SecretKey,
    })
    setS3TestResult(data.ok ? 'ok' : 'fail')
  }

  async function syncPendingAttachments() {
    setSyncing(true)
    setSyncResult(null)
    const data = await syncAttachments()
    setSyncing(false)
    if (data.ok && data.total !== undefined) {
      setSyncResult({ synced: data.synced ?? 0, failed: data.failed ?? 0, total: data.total })
    }
  }

  return (
    <>
      <div className="settings-section-header" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>Attachments &amp; Storage</div>

      <div className="settings-row">
        <label className="settings-label">S3 Endpoint URL</label>
        <input
          className="settings-input"
          type="text"
          value={settings.s3Endpoint ?? ''}
          onChange={e => setSetting('s3Endpoint', e.target.value)}
          placeholder="https://<account_id>.r2.cloudflarestorage.com"
          spellCheck={false}
        />
        <span className="settings-hint">Cloudflare R2 recommended. Any S3-compatible endpoint works.</span>
      </div>
      <div className="settings-row">
        <label className="settings-label">Bucket Name</label>
        <input
          className="settings-input"
          type="text"
          value={settings.s3Bucket ?? ''}
          onChange={e => setSetting('s3Bucket', e.target.value)}
          placeholder="qalatra-attachments"
          spellCheck={false}
        />
      </div>
      <div className="settings-row">
        <label className="settings-label">Access Key ID</label>
        <input
          className="settings-input"
          type="text"
          value={settings.s3AccessKey ?? ''}
          onChange={e => setSetting('s3AccessKey', e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="settings-row">
        <label className="settings-label">Secret Access Key</label>
        <input
          className="settings-input"
          type="password"
          value={settings.s3SecretKey ?? ''}
          onChange={e => setSetting('s3SecretKey', e.target.value)}
        />
      </div>
      <div className="settings-row">
        <label className="settings-label">Public Base URL <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
        <input
          className="settings-input"
          type="text"
          value={settings.s3PublicUrl ?? ''}
          onChange={e => setSetting('s3PublicUrl', e.target.value)}
          placeholder="https://assets.yourdomain.com - leave blank to use presigned URLs"
          spellCheck={false}
        />
      </div>
      <div className="settings-row">
        <label className="settings-label">Local Attachment Cache</label>
        <input
          className="settings-input"
          type="text"
          value={settings.attachmentCacheDir ?? ''}
          onChange={e => setSetting('attachmentCacheDir', e.target.value)}
          placeholder="~/Library/Application Support/qalatra/attachments"
          spellCheck={false}
        />
        <span className="settings-hint">Files are always cached here locally regardless of cloud storage.</span>
      </div>

      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            className="settings-save"
            style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
            onClick={testConnection}
          >
            Test Connection
          </button>
          {s3TestResult === 'ok' && <span style={{ fontSize: 12, color: '#4ade80' }}>Connected</span>}
          {s3TestResult === 'fail' && <span style={{ fontSize: 12, color: '#ef4444' }}>Failed</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            className="settings-save"
            style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
            disabled={syncing}
            onClick={syncPendingAttachments}
          >
            {syncing ? 'Syncing...' : 'Sync Pending'}
          </button>
          {syncResult !== null && (
            <span style={{ fontSize: 12, color: syncResult.failed > 0 ? '#f59e0b' : '#4ade80' }}>
              {syncResult.total === 0 ? 'Nothing pending' : `${syncResult.synced}/${syncResult.total} synced${syncResult.failed > 0 ? `, ${syncResult.failed} failed` : ''}`}
            </span>
          )}
        </div>
      </div>

      <div className="settings-actions">
        <button className="settings-save" onClick={onSave}>{saved ? 'Saved' : 'Save'}</button>
      </div>
    </>
  )
}
