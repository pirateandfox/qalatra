import { getPlatform } from './platform'
import { createEmitter } from './emitter'

const accountChanges = createEmitter()
export const onAccountChange = accountChanges.on

export class AccountServiceError extends Error {
  readonly temporary: boolean
  constructor(message: string, temporary = false) {
    super(message)
    this.temporary = temporary
    this.name = 'AccountServiceError'
  }
}

const TOKEN_KEY = 'qalatra.account.token'

export type AccountUser = {
  id: string
  displayName?: string | null
  activeOrganizationId?: string | null
}

export type AccountLoginResult =
  | { status: 'authenticated'; token: string; user: AccountUser | null }
  | { status: 'requires_2fa'; tempToken: string }

export type AccountEntitlement = {
  productKey: string
  planName?: string | null
  status?: string | null
  active: boolean
  hasSeat: boolean
  seatsTotal?: number
  seatsUsed?: number
  currentPeriodEnd?: string | null
}

type GraphqlEnvelope<T> = {
  data?: T
  errors?: Array<{ message?: string; extensions?: { code?: string } }>
}

function tokenStorage() {
  const platform = getPlatform()
  return platform.secure ?? platform.persistent
}

function config() {
  const account = getPlatform().account
  if (!account)
    throw new Error(
      'Qalatra account endpoint is not configured for this build.',
    )
  return account
}

async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  token?: string,
): Promise<T> {
  const { graphqlUrl } = config()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  let response: Response
  let result: GraphqlEnvelope<T>
  try {
    response = await fetch(graphqlUrl, {
    signal: controller.signal,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  })
    result = (await response.json().catch(() => ({}))) as GraphqlEnvelope<T>
  } catch {
    throw new AccountServiceError('The account service could not be reached. Please try again.', true)
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok || result.errors?.length || !result.data) {
    const unauthorized =
      response.status === 401 ||
      result.errors?.some(
        (error) =>
          error.extensions?.code === 'UNAUTHENTICATED' ||
          /unauthori[sz]ed|invalid session|expired token/i.test(
            error.message ?? '',
          ),
      )
    if (token && unauthorized) {
      if (getAccountToken() === token) clearAccountToken()
      throw new Error(
        'Your Qalatra session expired or was revoked. Sign in again.',
      )
    }
    throw new AccountServiceError(
      result.errors?.[0]?.message ||
        `Account service returned HTTP ${response.status}`,
      response.status >= 500 || response.status === 429,
    )
  }
  return result.data
}

export function getAccountToken(): string | null {
  return tokenStorage().getItem(TOKEN_KEY)
}

export function clearAccountToken(): void {
  tokenStorage().removeItem(TOKEN_KEY)
  accountChanges.emit()
}

export async function hydrateAccount(): Promise<void> {
  await tokenStorage().hydrate?.([TOKEN_KEY])
}

function saveLogin(result: {
  token?: string | null
  user?: AccountUser | null
  requires2FA?: boolean | null
  tempToken?: string | null
}): AccountLoginResult {
  if (result.requires2FA && result.tempToken) {
    return { status: 'requires_2fa', tempToken: result.tempToken }
  }
  if (!result.token)
    throw new Error('Login succeeded without an account token.')
  tokenStorage().setItem(TOKEN_KEY, result.token)
  accountChanges.emit()
  return {
    status: 'authenticated',
    token: result.token,
    user: result.user ?? null,
  }
}

export async function loginAccount(
  email: string,
  password: string,
): Promise<AccountLoginResult> {
  const data = await graphql<{
    login: {
      token?: string | null
      user?: AccountUser | null
      requires2FA?: boolean | null
      tempToken?: string | null
    } | null
  }>(
    `
      mutation AccountLogin($input: LoginInput!) {
        login(input: $input) {
          token
          requires2FA
          tempToken
          user {
            id
            displayName
            activeOrganizationId
          }
        }
      }
    `,
    { input: { email, password, remember: true } },
  )
  if (!data.login) throw new Error('Login failed.')
  return saveLogin(data.login)
}

export async function completeAccount2FA(
  tempToken: string,
  code: string,
): Promise<AccountLoginResult> {
  const data = await graphql<{
    complete2FALogin: {
      token?: string | null
      user?: AccountUser | null
    } | null
  }>(
    `
      mutation AccountComplete2FA($tempToken: String!, $code: String!) {
        complete2FALogin(tempToken: $tempToken, code: $code) {
          token
          user {
            id
            displayName
            activeOrganizationId
          }
        }
      }
    `,
    { tempToken, code },
  )
  if (!data.complete2FALogin) throw new Error('Two-factor verification failed.')
  return saveLogin(data.complete2FALogin)
}

export async function getAccountEntitlement(
  productKey = config().productKey,
): Promise<AccountEntitlement | null> {
  const token = getAccountToken()
  if (!token) return null
  const data = await graphql<{ entitlements: AccountEntitlement[] }>(
    `
      query AccountEntitlements {
        entitlements: accountEntitlements {
          productKey
          planName
          status
          active
          hasSeat
          currentPeriodEnd
        }
      }
    `,
    {},
    token,
  )
  const exact = data.entitlements.find(
    (entitlement) => entitlement.productKey === productKey && entitlement.active && entitlement.hasSeat,
  )
  if (exact?.active && exact.hasSeat) return exact

  // Every Cloud node subscription includes one hosted-client admin seat. Checkout assigns that
  // seat to the purchaser on the Cloud entitlement, so no synthetic second Stripe subscription is
  // needed just to unlock the web/mobile client.
  if (productKey === 'connect') {
    const includedCloudSeat = data.entitlements.find(
      (entitlement) =>
        entitlement.productKey === 'cloud' &&
        entitlement.active &&
        entitlement.hasSeat,
    )
    if (includedCloudSeat) return includedCloudSeat
  }
  return data.entitlements.find(entitlement => entitlement.productKey === productKey) ?? null
}

export function accountPortalUrl(path = ''): string {
  const base = config().portalUrl.replace(/\/$/, '')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}
