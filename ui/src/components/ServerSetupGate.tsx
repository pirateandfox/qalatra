import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import {
  accountPortalUrl, clearAccountToken, getActiveInstanceId, getInstances, getPlatform,
  onInstanceConfigChange, setActiveInstance, setDefaultInstance, testInstanceConnection,
  upsertInstance,
} from '@qalatra/shared'
import './AccountGate.css'
import './ServerSetupGate.css'

export function ServerSetupGate({ children }: { children: ReactNode }) {
  const activeId = useSyncExternalStore(onInstanceConfigChange, getActiveInstanceId)
  // Desktop can resolve its bundled server without a saved remote connection.
  if (getPlatform().capabilities.canManageLocalServer || activeId) return children
  return <ServerSetup />
}

function ServerSetup() {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const savedInstances = getInstances()

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const serverUrl = url.trim().replace(/\/+$/, '')
    let parsed: URL
    try {
      parsed = new URL(serverUrl)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('Invalid server URL')
      }
    } catch {
      setError('Enter your server’s HTTPS URL, for example https://qalatra.example.com.')
      return
    }
    setBusy(true)
    try {
      const result = await testInstanceConnection({ url: serverUrl, token: token.trim() })
      if (!result.ok) {
        setError('We couldn’t connect. Check the server URL and access token, and make sure the server is online and allows connections from this web app.')
        return
      }
      const instance = upsertInstance({
        name: name.trim() || result.name || parsed.hostname,
        url: serverUrl,
        token: token.trim(),
      })
      setDefaultInstance(instance.id)
      setActiveInstance(instance.id)
    } catch {
      setError('We couldn’t save this connection. Check that your browser allows site storage, then try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="account-gate server-setup">
      <section className="account-card server-setup-card" aria-labelledby="server-setup-title">
        <header className="server-setup-header">
          <div className="account-mark" aria-hidden="true">Q</div>
          <p className="account-eyebrow">Your workspace, connected</p>
          <h1 id="server-setup-title">Connect your Qalatra server</h1>
          <p>You’re signed in. Add the server where your tasks live to start using your workspace here.</p>
        </header>

        <div className="server-setup-columns">
          <div className="server-setup-guide">
            <h2>Find your connection details</h2>
            <ol className="server-setup-steps">
              <li>
                <h3>Get your server URL</h3>
                <p>Use the HTTPS address of your Qalatra server. If someone manages it for you, ask them for the URL and an access token.</p>
              </li>
              <li>
                <h3>Create an access token</h3>
                <p>In Qalatra Desktop, select that server, then open <strong>Settings → Instances → Access Tokens</strong>. Give it a name like “Web app” and choose <strong>Create full-access token</strong>. Copy the new token while it’s shown.</p>
              </li>
              <li>
                <h3>Paste it here and connect</h3>
                <p>Enter the URL and token in this form. We’ll check the connection and open your tasks.</p>
              </li>
            </ol>
            <div className="server-setup-cloud">
              <h3>Using Qalatra Cloud?</h3>
              <p>Open <a href={accountPortalUrl('/servers')} target="_blank" rel="noopener noreferrer">Servers in the account portal ↗</a>, select your server, and look under <strong>Connection credentials</strong> for its Server URL and Access token.</p>
            </div>
          </div>

          <div className="server-setup-connection">
            <h2>Add your server</h2>
            {savedInstances.length > 0 && (
              <div className="server-setup-saved">
                <p>Or choose a server you’ve already saved:</p>
                {savedInstances.map(instance => (
                  <button key={instance.id} className="account-secondary" onClick={() => {
                    setDefaultInstance(instance.id)
                    setActiveInstance(instance.id)
                  }}>{instance.name}</button>
                ))}
              </div>
            )}
            <form onSubmit={connect}>
              <fieldset disabled={busy}>
                <label htmlFor="setup-server-name">Server name <span className="server-setup-optional">(optional)</span>
                  <input id="setup-server-name" value={name} onChange={event => setName(event.target.value)} placeholder="My Qalatra" autoComplete="off" />
                </label>
                <label htmlFor="setup-server-url">Server URL
                  <input id="setup-server-url" type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://qalatra.example.com" autoComplete="url" spellCheck={false} required />
                </label>
                <label htmlFor="setup-server-token">Access token
                  <input id="setup-server-token" type="password" value={token} onChange={event => setToken(event.target.value)} placeholder="qalatra_…" autoComplete="off" spellCheck={false} required aria-describedby="setup-token-hint" />
                </label>
                <p id="setup-token-hint" className="server-setup-hint">This is the key issued by your server. Your Qalatra account password won’t work here.</p>
                {error && <p className="account-error" role="alert">{error}</p>}
                <button type="submit" disabled={busy || !url.trim() || !token.trim()}>{busy ? 'Connecting…' : 'Connect server'}</button>
              </fieldset>
            </form>
            <p className="server-setup-hint">Your connection is saved in this browser. You can manage it later in Settings → Instances.</p>
          </div>
        </div>

        <footer className="server-setup-footer">
          <span>Need a server? <a href={accountPortalUrl('/servers')} target="_blank" rel="noopener noreferrer">Open the account portal ↗</a></span>
          <button className="account-tertiary" onClick={clearAccountToken}>Use another account</button>
        </footer>
      </section>
    </main>
  )
}
