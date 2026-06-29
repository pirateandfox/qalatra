import { useCallback, useEffect, useRef, useState } from 'react'
import { createBoxWebSession, getBoxWebStatus, type BoxWebSession, type BoxWebStatus } from '../api'
import './BoxWebView.css'

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

interface Props {
  label: string
}

function remapSessionUrl(currentUrl: string | null, nextSession: BoxWebSession) {
  if (!currentUrl) return nextSession.url
  try {
    const current = new URL(currentUrl)
    const next = new URL(nextSession.url)
    const match = current.pathname.match(/^\/api\/box-web\/proxy\/[^/]+(\/.*)?$/)
    if (!match) return nextSession.url

    const basePath = next.pathname.replace(/\/$/, '')
    const suffix = match[1] || '/'
    next.pathname = suffix === '/' ? `${basePath}/` : `${basePath}${suffix}`
    next.search = current.search
    next.hash = current.hash
    return next.toString()
  } catch {
    return nextSession.url
  }
}

export default function BoxWebView({ label }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [session, setSession] = useState<BoxWebSession | null>(null)
  const [status, setStatus] = useState<BoxWebStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [frameKey, setFrameKey] = useState(0)

  const currentFrameUrl = useCallback(() => {
    const frame = frameRef.current
    if (!frame) return null
    try {
      return frame.contentWindow?.location.href ?? frame.src ?? null
    } catch {
      return frame.src || null
    }
  }, [])

  const load = useCallback(async ({ preservePath = false }: { preservePath?: boolean } = {}) => {
    const currentUrl = preservePath ? currentFrameUrl() : null
    setLoading(true)
    setError(null)
    try {
      const currentStatus = await getBoxWebStatus()
      setStatus(currentStatus)
      if (!currentStatus.available) {
        setSession(null)
        return
      }
      const nextSession = await createBoxWebSession()
      setSession({ ...nextSession, url: remapSessionUrl(currentUrl, nextSession) })
      setFrameKey(key => key + 1)
    } catch (err: unknown) {
      setSession(null)
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [currentFrameUrl])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="box-web-view">
      <header className="box-web-toolbar">
        <div className="box-web-title">
          <span className="box-web-icon">▣</span>
          <span>{label}</span>
        </div>
        <div className="box-web-meta">
          <code>{status?.target ?? session?.target ?? 'http://127.0.0.1:8080'}</code>
          {session?.expiresAt && <span>session until {new Date(session.expiresAt).toLocaleTimeString()}</span>}
        </div>
        <div className="box-web-actions">
          <button className="box-web-button" onClick={() => load({ preservePath: true })} disabled={loading} title={`Create a fresh ${label} session and keep the current path`}>
            {loading ? 'Loading...' : 'Reconnect'}
          </button>
        </div>
      </header>

      <div className="box-web-body">
        {loading ? (
          <div className="box-web-state">Loading {label}...</div>
        ) : error ? (
          <div className="box-web-state box-web-state-error">
            <strong>Could not open {label}</strong>
            <span>{error}</span>
          </div>
        ) : status && !status.available ? (
          <div className="box-web-state">
            <strong>{label} is not running</strong>
            <span>Start the web app on <code>{status.target}</code>, then reload this view.</span>
            {status.error && <span>{status.error}</span>}
          </div>
        ) : session ? (
          <iframe
            ref={frameRef}
            key={`${session.url}:${frameKey}`}
            className="box-web-frame"
            title={label}
            src={session.url}
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="box-web-state">No Box Web App session is available.</div>
        )}
      </div>
    </div>
  )
}
