import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
    // An app router can pushState to a root path (/mail/…) that has left the proxy prefix;
    // on the same origin that path is still the tool's own route, so carry it over whole.
    if (!match && current.origin !== next.origin) return nextSession.url

    const basePath = next.pathname.replace(/\/$/, '')
    const suffix = (match ? match[1] : current.pathname) || '/'
    next.pathname = suffix === '/' ? `${basePath}/` : `${basePath}${suffix}`
    next.search = current.search
    next.hash = current.hash
    return next.toString()
  } catch {
    return nextSession.url
  }
}

type Connection = 'connecting' | 'connected' | 'unavailable'

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  unavailable: 'Unavailable',
}

export default function BoxWebView({ label }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [session, setSession] = useState<BoxWebSession | null>(null)
  const [status, setStatus] = useState<BoxWebStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [frameKey, setFrameKey] = useState(0)
  // True from the moment a session URL is handed to the iframe until the
  // embedded tool fires onLoad, so the loading state covers the tool itself and
  // not just the status/session round-trip.
  const [frameLoading, setFrameLoading] = useState(false)

  // The proxied tool is served from the Qalatra server's origin, not the UI's, so its location
  // can't be read across the frame boundary. The proxy's injected runtime posts it instead.
  const reportedUrlRef = useRef<string | null>(null)

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      const data = event.data as { type?: unknown; url?: unknown } | null
      if (data?.type === 'qalatra-box-web:url' && typeof data.url === 'string') reportedUrlRef.current = data.url
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const currentFrameUrl = useCallback(() => {
    if (reportedUrlRef.current) return reportedUrlRef.current
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
        setFrameLoading(false)
        return
      }
      const nextSession = await createBoxWebSession()
      setSession({ ...nextSession, url: remapSessionUrl(currentUrl, nextSession) })
      setFrameKey(key => key + 1)
      setFrameLoading(true)
    } catch (err: unknown) {
      setSession(null)
      setFrameLoading(false)
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [currentFrameUrl])

  useEffect(() => {
    load()
  }, [load])

  const busy = loading || frameLoading
  const target = status?.target ?? session?.target ?? null
  let connection: Connection = 'unavailable'
  if (busy) connection = 'connecting'
  else if (session && !error && status?.available !== false) connection = 'connected'

  // Proxy details stay out of the toolbar; they live in the status tooltip.
  const connectionTitle = [
    target ? `Target: ${target}` : null,
    session?.expiresAt ? `Session until ${new Date(session.expiresAt).toLocaleTimeString()}` : null,
    connection === 'unavailable' ? (error || status?.error || null) : null,
  ].filter(Boolean).join('\n')

  let body: ReactNode = null
  if (error) {
    body = (
      <div className="box-web-state box-web-state-error">
        <strong>Could not open {label}</strong>
        <span>{error}</span>
      </div>
    )
  } else if (status && !status.available && !loading) {
    body = (
      <div className="box-web-state">
        <strong>{label} is not running</strong>
        <span>Start the web app{status.target ? <> on <code>{status.target}</code></> : null}, then press Reconnect.</span>
        {status.error && <span>{status.error}</span>}
      </div>
    )
  } else if (session) {
    // Kept mounted during a Reconnect so the loading overlay sits on top of the
    // current page instead of blanking it.
    body = (
      <iframe
        ref={frameRef}
        key={`${session.url}:${frameKey}`}
        className="box-web-frame"
        title={label}
        src={session.url}
        sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={() => setFrameLoading(false)}
      />
    )
  } else if (!loading) {
    body = <div className="box-web-state">No {label} session is available.</div>
  }

  return (
    <div className="box-web-view">
      <header className="box-web-toolbar">
        <div className="box-web-title">
          <span className="box-web-icon">▣</span>
          <span className="box-web-label">{label}</span>
        </div>
        <div className="box-web-actions">
          <span
            className={`box-web-status box-web-status-${connection}`}
            title={connectionTitle || undefined}
            role="status"
            aria-live="polite"
          >
            <span className="box-web-status-dot" aria-hidden="true" />
            <span className="box-web-status-text">{CONNECTION_LABEL[connection]}</span>
          </span>
          <button
            className="box-web-button"
            onClick={() => load({ preservePath: true })}
            disabled={loading}
            title={`Create a fresh ${label} session and keep the current path`}
            aria-label="Reconnect"
          >
            <span className="box-web-button-icon" aria-hidden="true">↻</span>
            <span className="box-web-button-text">Reconnect</span>
          </button>
        </div>
      </header>

      <div className="box-web-body">
        {body}
        {busy && !error && (
          <div className={`box-web-loading${session ? ' box-web-loading-overlay' : ''}`}>
            <span className="box-web-spinner" aria-hidden="true" />
            <span>{loading ? `Connecting to ${label}...` : `Loading ${label}...`}</span>
          </div>
        )}
      </div>
    </div>
  )
}
