import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import {
  accountPortalUrl,
  clearAccountToken,
  completeAccount2FA,
  getAccountEntitlement,
  getAccountToken,
  getPlatform,
  hydrateAccount,
  loginAccount,
} from '@qalatra/shared'
import './AccountGate.css'

type GateState =
  'checking' | 'login' | 'two_factor' | 'licensed' | 'unlicensed' | 'error'

export function AccountGate({ children }: { children: ReactNode }) {
  const platform = getPlatform()
  const [state, setState] = useState<GateState>(
    platform.capabilities.requiresAccountAuth ? 'checking' : 'licensed',
  )
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [tempToken, setTempToken] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  async function checkLicense() {
    if (!platform.capabilities.requiresAccountAuth) {
      setState('licensed')
      return
    }
    if (!getAccountToken()) {
      setState('login')
      return
    }
    setState('checking')
    try {
      const entitlement = await getAccountEntitlement()
      setState(
        entitlement?.active && entitlement.hasSeat ? 'licensed' : 'unlicensed',
      )
      setMessage('')
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Could not check your Qalatra license.',
      )
      setState('error')
    }
  }

  useEffect(() => {
    void hydrateAccount().then(checkLicense)
    // Platform configuration is immutable for the lifetime of the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submitLogin(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      const result = await loginAccount(email.trim(), password)
      if (result.status === 'requires_2fa') {
        setTempToken(result.tempToken)
        setState('two_factor')
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
            <button
              className="account-secondary"
              onClick={() => {
                clearAccountToken()
                setState('login')
              }}
            >
              Use another account
            </button>
          </>
        )}
        {state === 'error' && (
          <>
            <h1>We couldn’t verify your license</h1>
            <p>{message}</p>
            <button onClick={() => void checkLicense()}>Try again</button>
            <button
              className="account-secondary"
              onClick={() => {
                clearAccountToken()
                setState('login')
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
