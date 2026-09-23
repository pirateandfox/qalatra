import { type FormEvent, type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'
import {
  accountPortalUrl,
  clearAccountToken,
  completeAccount2FA,
  createAccountAccessController,
  getPlatform,
  loginAccount,
} from '@qalatra/shared'
import './AccountGate.css'

export function AccountGate({ children }: { children: ReactNode }) {
  return getPlatform().capabilities.requiresAccountAuth
    ? <AuthenticatedAccountGate>{children}</AuthenticatedAccountGate>
    : children
}

function AuthenticatedAccountGate({ children }: { children: ReactNode }) {
  const [access] = useState(() => createAccountAccessController())
  const snapshot = useSyncExternalStore(access.subscribe, access.getSnapshot)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [tempToken, setTempToken] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const state = snapshot.status === 'login' && tempToken ? 'two_factor' : snapshot.status
  const checkLicense = access.check

  useEffect(() => {
    const stop = access.start()
    const recheck = () => { if (document.visibilityState === 'visible') void access.check() }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => {
      stop()
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck)
    }
  }, [access])

  async function submitLogin(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      const result = await loginAccount(email.trim(), password)
      setPassword('')
      if (result.status === 'requires_2fa') {
        setTempToken(result.tempToken)
      } else {
        await checkLicense()
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Sign in failed.')
    } finally {
      setBusy(false)
    }
  }

  async function submit2FA(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      await completeAccount2FA(tempToken, code.trim())
      setTempToken('')
      setCode('')
      await checkLicense()
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Verification failed.',
      )
    } finally {
      setBusy(false)
    }
  }

  if (state === 'licensed') return children

  return (
    <main className="account-gate">
      <section className="account-card">
        <div className="account-mark">Q</div>
        <p className="account-eyebrow">Qalatra account</p>
        {state === 'checking' && <h1>Checking your license…</h1>}
        {state === 'login' && (
          <>
            <h1>Sign in to Qalatra</h1>
            <p>
              Your hosted web and mobile access follows your Qalatra Connect
              seat or the admin seat included with a Cloud node.
            </p>
            <form onSubmit={submitLogin}>
              <label>
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  minLength={8}
                  required
                />
              </label>
              <button type="submit" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
            <a href={accountPortalUrl('/register')}>Create an account</a>
          </>
        )}
        {state === 'two_factor' && (
          <>
            <h1>Enter your verification code</h1>
            <p>Use your authenticator code or one of your backup codes.</p>
            <form onSubmit={submit2FA}>
              <label>
                Verification code
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  autoComplete="one-time-code"
                  required
                  autoFocus
                />
              </label>
              <button type="submit" disabled={busy}>
                {busy ? 'Verifying…' : 'Verify'}
              </button>
            </form>
            <button className="account-secondary" onClick={() => { setTempToken(''); setCode(''); setMessage('') }}>Back to sign in</button>
          </>
        )}
        {state === 'unlicensed' && (
          <>
            <h1>A hosted-app seat is required</h1>
            <p>
              Your account is valid, but it does not currently have an active
              Connect seat or the admin seat included with a Cloud node. An
              organization owner can purchase or assign access in the portal.
            </p>
            <a
              className="account-primary-link"
              href={accountPortalUrl('/team')}
            >
              Open the Qalatra portal
            </a>
            <button onClick={() => void checkLicense()}>Check access again</button>
            <button
              className="account-secondary"
              onClick={() => {
                clearAccountToken()
                setTempToken('')
                setPassword('')
              }}
            >
              Use another account
            </button>
          </>
        )}
        {state === 'error' && (
          <>
            <h1>We couldn’t verify your license</h1>
            <p>{snapshot.message}</p>
            <button onClick={() => void checkLicense()}>Try again</button>
            <button
              className="account-secondary"
              onClick={() => {
                clearAccountToken()
                setTempToken('')
                setPassword('')
              }}
            >
              Sign in again
            </button>
          </>
        )}
        {message && state !== 'error' && (
          <p className="account-error">{message}</p>
        )}
      </section>
    </main>
  )
}
