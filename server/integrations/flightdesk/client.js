// Minimal GraphQL client for the FlightDesk API — the same three operations the FlightDesk CLI
// uses (`flightdesk dispatch list/update`, `questions answers`). Plain fetch, no SDK dependency.

export class FlightDeskAuthError extends Error {
  constructor(message = 'FlightDesk rejected the credential') { super(message); this.name = 'FlightDeskAuthError' }
}

const LIST_DISPATCHES = 'query { userDispatchRequests }'
const UPDATE_DISPATCH = 'mutation($input: JSON!) { userUpdateDispatch(input: $input) }'
const CONSUME_ANSWERS = 'mutation($taskId: String!) { userConsumeAnswers(taskId: $taskId) }'

export function createFlightDeskClient({ apiUrl, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
  if (!apiKey) throw new Error('apiKey required')
  const endpoint = `${String(apiUrl).replace(/\/+$/, '')}/graphql`

  async function graphql(query, variables) {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 401 || res.status === 403) throw new FlightDeskAuthError(`FlightDesk HTTP ${res.status}`)
    if (!res.ok) throw new Error(`FlightDesk HTTP ${res.status}`)
    const json = await res.json()
    if (Array.isArray(json.errors) && json.errors.length) {
      const message = json.errors[0]?.message || 'FlightDesk GraphQL error'
      if (/unauthori[sz]ed|forbidden/i.test(message)) throw new FlightDeskAuthError(message)
      const err = new Error(message)
      err.graphql = true
      throw err
    }
    return json.data ?? {}
  }

  return {
    endpoint,
    graphql,
    async listDispatches() {
      const data = await graphql(LIST_DISPATCHES)
      return Array.isArray(data.userDispatchRequests) ? data.userDispatchRequests : []
    },
    async updateDispatch(input) {
      const data = await graphql(UPDATE_DISPATCH, { input })
      return data.userUpdateDispatch ?? null
    },
    async consumeAnswers(taskId) {
      const data = await graphql(CONSUME_ANSWERS, { taskId })
      return data.userConsumeAnswers ?? { questions: [], blocked: false, blockingQuestions: [] }
    },
  }
}

// "Already past that step" — the dispatch lifecycle is a ladder and FlightDesk refuses to step
// backwards. When walking a job up the ladder after a lost ack or a restart, these are expected.
export function isTransitionRejection(err) {
  return Boolean(err?.graphql) && /invalid dispatch transition|dispatch changed/i.test(err.message)
}
