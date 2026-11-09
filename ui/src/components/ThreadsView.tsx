import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  closeThread,
  fetchAgentsDb,
  freezeThread,
  getThread,
  listThreads,
  openThread,
  postThreadMessage,
  readThreadMessages,
  subscribeServerEvents,
  type AgentRecord,
  type Thread,
  type ThreadDetail,
  type ThreadMessage,
} from '../api'
import './ThreadsView.css'

// Agent-to-agent threads (docs/agent-to-agent-threads.md). The app acts as the human participant.
// Agents post through MCP in a different process, which cannot reach this window's event stream,
// so the open view also polls; API-side writes arrive at once via the `thread:message` event.
const POLL_MS = 5000

type Filter = 'open' | 'all'

function relTime(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

function clock(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function statusLabel(t: Thread): string {
  if (t.status === 'open') return 'open'
  return t.closed_reason ? `${t.status} · ${t.closed_reason.replace(/_/g, ' ')}` : t.status
}

export default function ThreadsView() {
  const [filter, setFilter] = useState<Filter>('open')
  const [threads, setThreads] = useState<Thread[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ThreadDetail | null>(null)
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)

  const loadList = useCallback(async () => {
    try {
      setThreads(await listThreads(filter === 'open' ? { status: 'open' } : {}))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [filter])

  const loadThread = useCallback(async (id: string) => {
    try {
      const [d, page] = await Promise.all([getThread(id, 0), readThreadMessages(id, 0, 200)])
      setDetail(d)
      setMessages(page.messages)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => { loadList() }, [loadList])
  useEffect(() => {
    if (selectedId) loadThread(selectedId)
    else { setDetail(null); setMessages([]) }
  }, [selectedId, loadThread])

  // Refresh: poll while visible, plus push for writes made through the API.
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return
      loadList()
      if (selectedId) loadThread(selectedId)
    }
    const interval = setInterval(tick, POLL_MS)
    let unsub = () => {}
    try {
      unsub = subscribeServerEvents(event => { if (event.type === 'thread:message') tick() })
    } catch { /* event stream unavailable — polling covers it */ }
    return () => { clearInterval(interval); unsub() }
  }, [loadList, loadThread, selectedId])

  const afterChange = useCallback(async (id: string) => {
    await Promise.all([loadList(), loadThread(id)])
  }, [loadList, loadThread])

  return (
    <div className="threads-view">
      <aside className="threads-list">
        <div className="threads-list-header">
          <div className="threads-filter">
            <button className={filter === 'open' ? 'active' : ''} onClick={() => setFilter('open')}>Open</button>
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
          </div>
          <button className="threads-new-btn" onClick={() => { setComposing(true); setSelectedId(null) }}>+ New</button>
        </div>
        {threads.length === 0 ? (
          <div className="threads-empty">
            {filter === 'open' ? 'No open threads.' : 'No threads yet.'}
            <div className="threads-empty-hint">Agents open threads with the <code>open_thread</code> MCP tool, or start one here.</div>
          </div>
        ) : threads.map(t => (
          <button
            key={t.id}
            className={`threads-item ${t.id === selectedId ? 'selected' : ''} ${t.status !== 'open' ? 'ended' : ''}`}
            onClick={() => { setComposing(false); setSelectedId(t.id) }}
          >
            <div className="threads-item-title">
              {t.status === 'open' && (t.unread_for_human ?? 0) > 0 && <span className="threads-unread" title={`${t.unread_for_human} unread`}>●</span>}
              {t.subject}
            </div>
            <div className="threads-item-meta">{t.participant_names} · {t.message_count} msg</div>
            <div className="threads-item-meta">{statusLabel(t)} · {relTime(t.last_message_at ?? t.created_at)}</div>
          </button>
        ))}
      </aside>

      <section className="threads-detail">
        {error && <div className="threads-error">{error}</div>}
        {composing ? (
          <NewThreadForm
            onCancel={() => setComposing(false)}
            onOpened={async id => { setComposing(false); setFilter('open'); await loadList(); setSelectedId(id) }}
          />
        ) : detail ? (
          <ThreadPane detail={detail} messages={messages} onChanged={() => afterChange(detail.thread.id)} />
        ) : (
          <div className="threads-placeholder">Select a thread to read it.</div>
        )}
      </section>
    </div>
  )
}

function ThreadPane({ detail, messages, onChanged }: { detail: ThreadDetail; messages: ThreadMessage[]; onChanged: () => Promise<void> }) {
  const { thread, participants } = detail
  const [draft, setDraft] = useState('')
  const [decision, setDecision] = useState('')
  const [closing, setClosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const isOpen = thread.status === 'open'
  const lastSeq = messages.length ? messages[messages.length - 1].seq : 0

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [thread.id, lastSeq])
  useEffect(() => { setDraft(''); setDecision(''); setClosing(false); setError(null) }, [thread.id])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try { await fn(); await onChanged() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const send = () => {
    const body = draft.trim()
    if (!body || busy) return
    run(async () => { await postThreadMessage(thread.id, body); setDraft('') })
  }

  const policy = thread.policy ?? {}
  const budget = [
    policy.max_messages ? `limit ${policy.max_messages} msgs` : null,
    policy.expires_at ? `expires ${clock(policy.expires_at)}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <div className="thread-pane">
      <header className="thread-pane-header">
        <h2>{thread.subject}</h2>
        <div className="thread-pane-meta">
          <span className={`thread-status thread-status--${thread.status}`}>{statusLabel(thread)}</span>
          {thread.project && <span>· {thread.project}</span>}
          {budget && <span>· {budget}</span>}
        </div>
        <div className="thread-participants">
          {participants.map(p => (
            <span key={p.id} className={`thread-chip thread-chip--${p.kind}`} title={p.agent_path ?? p.kind}>
              {p.display_name}{p.role === 'owner' && p.kind !== 'human' ? ' (owner)' : ''}
            </span>
          ))}
        </div>
        {isOpen && (
          <div className="thread-actions">
            <button disabled={busy} onClick={() => setClosing(c => !c)}>Close with decision</button>
            <button disabled={busy} onClick={() => run(() => freezeThread(thread.id))}>Freeze</button>
          </div>
        )}
        {closing && isOpen && (
          <div className="thread-close-form">
            <textarea
              value={decision}
              onChange={e => setDecision(e.target.value)}
              placeholder="What was decided? Written to the task as a note if the thread is attached to one."
              rows={2}
            />
            <button disabled={busy || !decision.trim()} onClick={() => run(() => closeThread(thread.id, decision.trim()))}>Close thread</button>
          </div>
        )}
      </header>

      <div className="thread-transcript">
        {messages.map(m => (
          <div key={m.id} className={`thread-msg thread-msg--${m.kind} thread-msg--${m.author_kind}`}>
            {m.kind === 'system' ? (
              <div className="thread-msg-system">{m.body} <span className="thread-msg-date">{clock(m.created_at)}</span></div>
            ) : (
              <>
                <div className="thread-msg-meta">
                  <span className="thread-msg-author">{m.kind === 'decision' ? `Decision · ${m.author}` : m.author}</span>
                  <span className="thread-msg-date">#{m.seq} · {clock(m.created_at)}</span>
                </div>
                <div className="thread-msg-body">{m.body}</div>
                {m.redacted_count > 0 && (
                  <div className="thread-msg-redacted">⚠ {m.redacted_count} span{m.redacted_count === 1 ? '' : 's'} redacted</div>
                )}
              </>
            )}
          </div>
        ))}
        {thread.decision && thread.status === 'closed' && thread.decision_note_id && (
          <div className="thread-decision-note">Decision written to the task as a note.</div>
        )}
        <div ref={endRef} />
      </div>

      {error && <div className="threads-error">{error}</div>}
      {isOpen ? (
        <div className="thread-composer">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } }}
            placeholder="Add a message as yourself… (⌘↵ to send)"
            rows={3}
          />
          <button disabled={busy || !draft.trim()} onClick={send}>Send</button>
        </div>
      ) : (
        <div className="thread-ended">This thread is {thread.status}; it stays readable but takes no new messages.</div>
      )}
    </div>
  )
}

function NewThreadForm({ onCancel, onOpened }: { onCancel: () => void; onOpened: (id: string) => Promise<void> }) {
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [subject, setSubject] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { fetchAgentsDb().then(setAgents).catch(e => setError((e as Error).message)) }, [])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return agents
      .filter(a => !q || a.name.toLowerCase().includes(q) || a.path.toLowerCase().includes(q))
      .slice(0, 50)
  }, [agents, query])

  const toggle = (path: string) => setPicked(p => (p.includes(path) ? p.filter(x => x !== path) : [...p, path]))

  const submit = async () => {
    if (!subject.trim() || picked.length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      const opened = await openThread({ subject: subject.trim(), participants: picked.map(agent => ({ kind: 'agent' as const, agent })) })
      if (message.trim()) await postThreadMessage(opened.thread.id, message.trim())
      await onOpened(opened.thread.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="thread-new">
      <h2>New thread</h2>
      <label>Subject
        <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="The question, in one line" autoFocus />
      </label>
      <label>Agents
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter agent folders…" />
      </label>
      <div className="thread-agent-picker">
        {visible.length === 0 && <div className="threads-empty-hint">No registered agents. Rescan agents in Settings.</div>}
        {visible.map(a => (
          <label key={a.path} className="thread-agent-option" title={a.path}>
            <input type="checkbox" checked={picked.includes(a.path)} onChange={() => toggle(a.path)} />
            <span>{a.name}</span>
            <span className="thread-agent-path">{a.relative_path ?? a.path}</span>
          </label>
        ))}
      </div>
      <label>First message (optional)
        <textarea value={message} onChange={e => setMessage(e.target.value)} rows={3} />
      </label>
      {error && <div className="threads-error">{error}</div>}
      <div className="thread-actions">
        <button disabled={busy || !subject.trim() || picked.length === 0} onClick={submit}>Open thread</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
