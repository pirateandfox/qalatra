import { createEmitter } from './emitter'
import {
  AccountServiceError,
  getAccountEntitlement,
  getAccountToken,
  hydrateAccount,
  onAccountChange,
  type AccountEntitlement,
} from './account'

export const ACCOUNT_RECHECK_MS = 60_000
export const ACCOUNT_OUTAGE_GRACE_MS = 5 * 60_000

export type AccountAccess = {
  status: 'checking' | 'login' | 'licensed' | 'unlicensed' | 'error'
  message: string
}

/** In-memory grace only: a cold start always verifies access with the account service. */
export function createAccountAccessController(deps = {
  token: getAccountToken,
  entitlement: getAccountEntitlement as () => Promise<AccountEntitlement | null>,
  hydrate: hydrateAccount,
  onChange: onAccountChange,
  now: Date.now,
}) {
  const events = createEmitter()
  let state: AccountAccess = { status: 'checking', message: '' }
  let verifiedAt: number | null = null
  let verifiedToken: string | null = null
  let generation = 0
  let pending: Promise<void> | null = null
  let pendingToken: string | null = null
  let graceTimer: ReturnType<typeof setTimeout> | undefined

  function clearGraceTimer() {
    clearTimeout(graceTimer)
    graceTimer = undefined
  }

  function set(status: AccountAccess['status'], message = '') {
    state = { status, message }
    events.emit()
  }

  function invalidate() {
    clearGraceTimer()
    generation++
    pending = null
    pendingToken = null
    verifiedAt = null
    verifiedToken = null
    set(deps.token() ? 'checking' : 'login')
  }

  async function check(): Promise<void> {
    const token = deps.token()
    if (!token) {
      invalidate()
      return
    }
    if (pending && pendingToken === token) return pending
    const run = ++generation
    if (verifiedToken !== token) {
      clearGraceTimer()
      verifiedAt = null
      verifiedToken = null
      set('checking')
    }
    pendingToken = token
    const current = () => run === generation && deps.token() === token
    pending = (async () => {
      try {
        const entitlement = await deps.entitlement()
        if (!current()) return
        clearGraceTimer()
        if (entitlement?.active && entitlement.hasSeat) {
          verifiedAt = deps.now()
          verifiedToken = token
          set('licensed')
        } else {
          verifiedAt = null
          verifiedToken = null
          set('unlicensed')
        }
      } catch (error) {
        if (!current()) return
        const temporary = error instanceof AccountServiceError && error.temporary
        if (temporary && verifiedToken === token && verifiedAt !== null &&
            deps.now() - verifiedAt < ACCOUNT_OUTAGE_GRACE_MS) {
          clearGraceTimer()
          graceTimer = setTimeout(() => {
            verifiedAt = null
            verifiedToken = null
            set('error', 'Could not verify your access. Please try again.')
          }, ACCOUNT_OUTAGE_GRACE_MS - (deps.now() - verifiedAt))
          return
        }
        clearGraceTimer()
        verifiedAt = null
        verifiedToken = null
        set('error', error instanceof Error ? error.message : 'Could not verify your access.')
      } finally {
        if (run === generation) {
          pending = null
          pendingToken = null
        }
      }
    })()
    return pending
  }

  function start() {
    let stopped = false
    const unsubscribe = deps.onChange(() => {
      invalidate()
      void check()
    })
    void deps.hydrate().then(() => {
      if (!stopped) void check()
    }).catch(() => {
      if (!stopped) set('error', 'Could not load your account. Please try again.')
    })
    const timer = setInterval(() => { void check() }, ACCOUNT_RECHECK_MS)
    return () => {
      stopped = true
      clearInterval(timer)
      clearGraceTimer()
      unsubscribe()
      generation++
      pending = null
      pendingToken = null
    }
  }

  return { subscribe: events.on, getSnapshot: () => state, check, start }
}
