import { useState, useEffect, useCallback } from 'react'
import {
  createHeartbeat,
  deleteHeartbeat,
  fetchAgents,
  listHeartbeatJobs,
  listHeartbeats,
  previewHeartbeatSchedule,
  toggleHeartbeat,
  updateHeartbeat,
  type Agent,
} from '../api'
import { useContexts } from '../lib/ContextsProvider'
import './HeartbeatsView.css'

type ScheduleType = 'interval' | 'daily' | 'cron'

const INTERVAL_OPTIONS = [
  { value: 5,    label: 'Every 5 min' },
  { value: 10,   label: 'Every 10 min' },
  { value: 15,   label: 'Every 15 min' },
  { value: 30,   label: 'Every 30 min' },
  { value: 60,   label: 'Every hour' },
  { value: 120,  label: 'Every 2 hours' },
  { value: 240,  label: 'Every 4 hours' },
  { value: 1440, label: 'Every day' },
]

function offsetOptions(intervalMinutes: number): { value: number; label: string }[] {
  if (intervalMinutes >= 1440 || intervalMinutes < 30) return []
  const step = intervalMinutes <= 60 ? 15 : Math.floor(intervalMinutes / 4)
  const opts = []
  for (let o = 0; o < intervalMinutes; o += step) {
    const h = Math.floor(o / 60)
    const m = o % 60
    opts.push({ value: o, label: h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `:${String(m).padStart(2, '0')}` })
  }
  return opts
}

// Monday-first for display; values are cron day-of-week numbers (0 = Sunday).
const WEEKDAYS = [
  { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' }, { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' }, { value: 0, label: 'Sun' },
]
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Weekday checkboxes + a time → a cron expression, e.g. Tue–Fri 05:00 → "0 5 * * 2-5".
// Runs of three or more days become a range; no days (or all seven) means every day.
function cronFromWeekdays(time: string, days: number[]): string {
  const [h, m] = time.split(':').map(Number)
  const sorted = [...new Set(days)].sort((a, b) => a - b)
  let dow = '*'
  if (sorted.length > 0 && sorted.length < 7) {
    const parts: string[] = []
    for (let i = 0; i < sorted.length;) {
      let j = i
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
      if (j - i >= 2) parts.push(`${sorted[i]}-${sorted[j]}`)
      else for (let k = i; k <= j; k++) parts.push(String(sorted[k]))
      i = j + 1
    }
    dow = parts.join(',')
  }
  return `${m} ${h} * * ${dow}`
}

// The inverse, for expressions the checkboxes can represent ("M H * * <days>"); null otherwise.
function weekdaysFromCron(expr: string): { time: string; days: number[] } | null {
  const match = expr.trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+([\d,*-]+)$/)
  if (!match) return null
  const [, m, h, dowField] = match
  if (Number(m) > 59 || Number(h) > 23) return null
  const days = new Set<number>()
  if (dowField === '*') [0, 1, 2, 3, 4, 5, 6].forEach(d => days.add(d))
  else {
    for (const part of dowField.split(',')) {
      const range = part.match(/^(\d)(?:-(\d))?$/)
      if (!range) return null
      const lo = Number(range[1]), hi = Number(range[2] ?? range[1])
      if (hi < lo || hi > 7) return null
      for (let d = lo; d <= hi; d++) days.add(d % 7)
    }
  }
  return { time: `${h.padStart(2, '0')}:${m.padStart(2, '0')}`, days: [...days] }
}

function weekdaysLabel(days: number[]): string {
  const set = new Set(days)
  if (set.size === 7) return 'Every day'
  if (set.size === 5 && [1, 2, 3, 4, 5].every(d => set.has(d))) return 'Weekdays'
  // Monday-first, collapsing runs: Tue–Fri, Mon, Wed
  const ordered = WEEKDAYS.map(w => w.value).filter(d => set.has(d))
  const order = WEEKDAYS.map(w => w.value)
  const parts: string[] = []
  for (let i = 0; i < ordered.length;) {
    let j = i
    while (j + 1 < ordered.length && order.indexOf(ordered[j + 1]) === order.indexOf(ordered[j]) + 1) j++
    parts.push(j - i >= 2 ? `${DAY_NAMES[ordered[i]]}–${DAY_NAMES[ordered[j]]}` : ordered.slice(i, j + 1).map(d => DAY_NAMES[d]).join(', '))
    i = j + 1
  }
  return parts.join(', ')
}

function scheduleLabel(hb: Heartbeat) {
  if (hb.cron_expression) {
    const simple = weekdaysFromCron(hb.cron_expression)
    const what = simple ? `${weekdaysLabel(simple.days)} at ${simple.time}` : `Cron ${hb.cron_expression}`
    return `${what} (${hb.timezone})`
  }
  return intervalLabel(hb.interval_minutes, hb.run_at_time, hb.minute_offset)
}

// A run instant in the schedule's own timezone and in UTC, e.g. "Tue, Oct 20, 05:00 AST · 09:00 UTC".
function formatRun(iso: string, timeZone: string | null | undefined) {
  const d = new Date(iso)
  let local: string
  try {
    local = d.toLocaleString(undefined, { timeZone: timeZone ?? undefined, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' })
  } catch {
    local = d.toLocaleString()
  }
  const utc = d.toLocaleString(undefined, { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return `${local} · ${utc} UTC`
}

function timeZoneOptions(current: string): string[] {
  let zones: string[] = []
  try { zones = Intl.supportedValuesOf('timeZone') } catch { /* older runtime: fall back to current only */ }
  if (!zones.includes('UTC')) zones = ['UTC', ...zones]
  if (current && !zones.includes(current)) zones = [current, ...zones]
  return zones
}

function intervalLabel(minutes: number, runAtTime?: string | null, minuteOffset?: number | null) {
  if (minutes === 1440 && runAtTime) return `Daily at ${runAtTime}`
  const base = INTERVAL_OPTIONS.find(o => o.value === minutes)?.label
    ?? (minutes < 60 ? `Every ${minutes} min` : minutes === 60 ? 'Every hour' : `Every ${minutes / 60}h`)
  if (minuteOffset != null) {
    const h = Math.floor(minuteOffset / 60)
    const m = minuteOffset % 60
    return `${base} at ${h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `:${String(m).padStart(2, '0')}`}`
  }
  return base
}

function relativeTime(isoStr: string | null): string {
  if (!isoStr) return '—'
  const d = new Date(isoStr.includes('T') ? isoStr : isoStr.replace(' ', 'T') + 'Z')
  const diffMs = d.getTime() - Date.now()
  const diffSec = Math.round(diffMs / 1000)
  const absSec = Math.abs(diffSec)
  if (absSec < 60) return diffSec < 0 ? `${absSec}s ago` : `in ${absSec}s`
  const absMins = Math.round(absSec / 60)
  if (absMins < 60) return diffSec < 0 ? `${absMins}m ago` : `in ${absMins}m`
  const absHrs = Math.round(absSec / 3600)
  if (absHrs < 24) return diffSec < 0 ? `${absHrs}h ago` : `in ${absHrs}h`
  const absDays = Math.round(absSec / 86400)
  return diffSec < 0 ? `${absDays}d ago` : `in ${absDays}d`
}

function agentDisplayName(a: Agent) {
  return (!a.context && a.folder) ? `${a.folder} / ${a.name}` : a.name
}

interface AgentJob {
  id: string
  status: string
  result: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

interface Heartbeat {
  id: string
  title: string
  description: string | null
  agent_path: string
  prompt: string
  interval_minutes: number
  run_at_time: string | null
  minute_offset: number | null
  cron_expression?: string | null
  timezone?: string | null
  active: number
  last_run_at: string | null
  next_run_at: string | null
  upcoming_runs?: string[]
  created_at: string
  runs_done: number
  runs_failed: number
  runs_pending: number
}

// ── Agent picker sub-form ─────────────────────────────────────────────────────

interface AgentPickerProps {
  agents: Agent[]
  context: string
  project: string
  agentPath: string
  onContextChange: (ctx: string) => void
  onProjectChange: (proj: string) => void
  onAgentChange: (path: string, description: string | null) => void
}

function AgentPicker({ agents, context, project, agentPath, onContextChange, onProjectChange, onAgentChange }: AgentPickerProps) {
  const { contexts } = useContexts()

  // Unique projects among agents filtered by current context
  const projectsForContext = [...new Set(
    agents
      .filter(a => !context || !a.context || a.context === context)
      .map(a => a.project)
      .filter((p): p is string => !!p)
  )].sort()

  // Agents filtered by context + project
  const filteredAgents = agents.filter(a =>
    (!context || !a.context || a.context === context) &&
    (!project || !a.project || a.project === project)
  )

  return (
    <div className="hb-agent-picker">
      <div className="hb-picker-row">
        <select
          className="hb-select"
          value={context}
          onChange={e => { onContextChange(e.target.value); onProjectChange('') }}
        >
          <option value="">Any context</option>
          {contexts.map(c => (
            <option key={c.slug} value={c.slug}>{c.label ?? c.slug}</option>
          ))}
        </select>

        {projectsForContext.length > 0 && (
          <select
            className="hb-select"
            value={project}
            onChange={e => onProjectChange(e.target.value)}
          >
            <option value="">Any project</option>
            {projectsForContext.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        )}
      </div>

      <select
        className="hb-select hb-agent-select"
        value={agentPath}
        onChange={e => {
          const selected = agents.find(a => a.path === e.target.value) ?? null
          onAgentChange(e.target.value, selected?.description ?? null)
        }}
        required
      >
        <option value="">— Select agent —</option>
        {filteredAgents.map(a => (
          <option key={a.path} value={a.path} title={a.description ?? undefined}>
            {agentDisplayName(a)}
          </option>
        ))}
      </select>

      {agentPath && (
        <div className="hb-selected-path" title={agentPath}>{agentPath}</div>
      )}
    </div>
  )
}

// ── Schedule sub-form ─────────────────────────────────────────────────────────

interface ScheduleForm {
  schedule_type: ScheduleType
  interval_minutes: number
  run_at_time: string
  minute_offset: number | null
  cron_expression: string
  cron_time: string
  cron_days: number[]
  timezone: string
}

// The schedule part of a create/update body. Non-cron schedules send cron_expression: null so an
// edit can switch a cron heartbeat back to an interval (the server rejects cron mixed with interval
// fields, and refuses interval fields on a cron heartbeat unless cron is cleared).
function schedulePayload(f: ScheduleForm): Record<string, unknown> {
  if (f.schedule_type === 'cron') return { cron_expression: f.cron_expression.trim(), timezone: f.timezone || undefined }
  const mins = f.schedule_type === 'daily' ? 1440 : f.interval_minutes
  return {
    cron_expression: null,
    timezone: null,
    interval_minutes: mins,
    run_at_time: mins === 1440 ? f.run_at_time : null,
    minute_offset: mins < 1440 ? f.minute_offset : null,
  }
}

function ScheduleFields<F extends ScheduleForm>({ form, setForm }: { form: F; setForm: (update: (f: F) => F) => void }) {
  const [preview, setPreview] = useState<{ runs: string[]; error: string | null }>({ runs: [], error: null })
  const isCron = form.schedule_type === 'cron'

  useEffect(() => {
    if (!isCron) return
    let cancelled = false
    const timer = setTimeout(() => {
      previewHeartbeatSchedule({ cron_expression: form.cron_expression, timezone: form.timezone || undefined })
        .then(p => { if (!cancelled) setPreview({ runs: p.upcoming_runs, error: null }) })
        .catch((err: Error) => { if (!cancelled) setPreview({ runs: [], error: err.message }) })
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [isCron, form.cron_expression, form.timezone])

  function setWeekdays(time: string, days: number[]) {
    setForm(f => ({ ...f, cron_time: time, cron_days: days, cron_expression: cronFromWeekdays(time, days) }))
  }

  const custom = isCron && !weekdaysFromCron(form.cron_expression)

  return (
    <div className="hb-schedule">
      <div className="hb-form-row">
        <select
          className="hb-select hb-schedule-type"
          value={form.schedule_type}
          onChange={e => setForm(f => ({ ...f, schedule_type: e.target.value as ScheduleType }))}
        >
          <option value="interval">Interval</option>
          <option value="daily">Daily at a time</option>
          <option value="cron">Weekdays / cron</option>
        </select>

        {form.schedule_type === 'interval' && (
          <>
            <select
              className="hb-select"
              value={form.interval_minutes}
              onChange={e => setForm(f => ({ ...f, interval_minutes: Number(e.target.value), minute_offset: null }))}
            >
              {INTERVAL_OPTIONS.filter(o => o.value < 1440).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {offsetOptions(form.interval_minutes).length > 0 && (
              <select
                className="hb-select"
                value={form.minute_offset ?? ''}
                onChange={e => setForm(f => ({ ...f, minute_offset: e.target.value === '' ? null : Number(e.target.value) }))}
              >
                <option value="">Any time</option>
                {offsetOptions(form.interval_minutes).map(o => (
                  <option key={o.value} value={o.value}>at {o.label}</option>
                ))}
              </select>
            )}
          </>
        )}

        {form.schedule_type === 'daily' && (
          <input
            type="time"
            className="hb-input hb-time-input"
            value={form.run_at_time}
            onChange={e => setForm(f => ({ ...f, run_at_time: e.target.value }))}
            required
          />
        )}

        {isCron && (
          <input
            type="time"
            className="hb-input hb-time-input"
            value={form.cron_time}
            onChange={e => e.target.value && setWeekdays(e.target.value, form.cron_days)}
            disabled={custom}
          />
        )}
      </div>

      {isCron && (
        <>
          <div className={`hb-weekdays${custom ? ' hb-weekdays-disabled' : ''}`}>
            {WEEKDAYS.map(d => (
              <label key={d.value} className="hb-weekday">
                <input
                  type="checkbox"
                  checked={form.cron_days.includes(d.value)}
                  disabled={custom}
                  onChange={e => setWeekdays(form.cron_time, e.target.checked
                    ? [...form.cron_days, d.value]
                    : form.cron_days.filter(x => x !== d.value))}
                />
                {d.label}
              </label>
            ))}
          </div>

          <div className="hb-form-row">
            <input
              className="hb-input hb-cron-input"
              value={form.cron_expression}
              onChange={e => {
                const expr = e.target.value
                const simple = weekdaysFromCron(expr)
                setForm(f => ({ ...f, cron_expression: expr, ...(simple ? { cron_time: simple.time, cron_days: simple.days } : {}) }))
              }}
              placeholder="0 5 * * 2-5"
              spellCheck={false}
              aria-label="Cron expression"
              required
            />
            <select
              className="hb-select"
              value={form.timezone}
              onChange={e => setForm(f => ({ ...f, timezone: e.target.value }))}
              aria-label="Timezone"
            >
              {!form.timezone && <option value="">Server timezone</option>}
              {timeZoneOptions(form.timezone).map(z => <option key={z} value={z}>{z}</option>)}
            </select>
          </div>
          {custom && <div className="hb-hint">Custom expression — edit it directly, or clear it to a simple “M H * * days” form to use the checkboxes.</div>}

          {preview.error
            ? <div className="hb-preview hb-preview-error">{preview.error}</div>
            : preview.runs.length > 0 && (
              <div className="hb-preview">
                <span className="hb-preview-label">Next runs</span>
                {preview.runs.map(r => <span key={r} className="hb-preview-run">{formatRun(r, form.timezone)}</span>)}
              </div>
            )}
        </>
      )}
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

interface Props {
  onMutate?: () => void
}

const BLANK_FORM = {
  title: '', context: '', project: '', agent_path: '', prompt: '',
  schedule_type: 'interval' as ScheduleType,
  interval_minutes: 60, run_at_time: '09:00', minute_offset: null as number | null,
  cron_expression: '0 9 * * 1-5', cron_time: '09:00', cron_days: [1, 2, 3, 4, 5], timezone: '',
}
type HeartbeatForm = typeof BLANK_FORM

export default function HeartbeatsView({ onMutate }: Props) {
  const [heartbeats, setHeartbeats] = useState<Heartbeat[]>([])
  const [loading, setLoading]       = useState(true)
  const [agents, setAgents]         = useState<Agent[]>([])
  const [creating, setCreating]     = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [jobs, setJobs]             = useState<Record<string, AgentJob[]>>({})
  const [expandedJobIds, setExpandedJobIds] = useState<Set<string>>(new Set())
  const [serverTz, setServerTz]     = useState('')
  const blankForm                   = useCallback((): HeartbeatForm => ({ ...BLANK_FORM, timezone: serverTz }), [serverTz])
  const [form, setForm]             = useState<HeartbeatForm>(BLANK_FORM)
  const [formError, setFormError]   = useState<string | null>(null)
  const [editId, setEditId]         = useState<string | null>(null)
  const [editForm, setEditForm]     = useState<HeartbeatForm>(BLANK_FORM)
  const [editError, setEditError]   = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    const data = await listHeartbeats()
    setHeartbeats(data)
    if (!silent) setLoading(false)
  }, [])

  useEffect(() => {
    load()
    fetchAgents().then(setAgents).catch(() => {})
    // An empty preview returns the server's timezone: the default for a new cron schedule.
    previewHeartbeatSchedule({}).then(p => {
      setServerTz(p.server_timezone)
      setForm(f => f.timezone ? f : { ...f, timezone: p.server_timezone })
    }).catch(() => {})
  }, [load])

  useEffect(() => {
    const interval = setInterval(() => load(true), 30_000)
    return () => clearInterval(interval)
  }, [load])

  async function loadJobs(id: string) {
    const data = await listHeartbeatJobs(id, 10)
    setJobs(prev => ({ ...prev, [id]: data }))
  }

  function toggleExpand(id: string) {
    if (expandedId === id) { setExpandedId(null) }
    else { setExpandedId(id); loadJobs(id) }
  }

  function toggleJobExpand(jobId: string) {
    setExpandedJobIds(prev => {
      const next = new Set(prev)
      if (next.has(jobId)) next.delete(jobId)
      else next.add(jobId)
      return next
    })
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim() || !form.agent_path || !form.prompt.trim()) return
    try {
      await createHeartbeat({
        title: form.title.trim(),
        agent_path: form.agent_path,
        prompt: form.prompt.trim(),
        ...schedulePayload(form),
      })
    } catch (err) {
      setFormError((err as Error).message)
      return
    }
    setFormError(null)
    setForm(blankForm())
    setCreating(false)
    load()
    onMutate?.()
  }

  async function handleToggle(id: string) {
    await toggleHeartbeat(id)
    load(true)
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this heartbeat and all its job history?')) return
    await deleteHeartbeat(id)
    if (expandedId === id) setExpandedId(null)
    load()
    onMutate?.()
  }

  function startEdit(hb: Heartbeat) {
    const agent = agents.find(a => a.path === hb.agent_path)
    const simple = hb.cron_expression ? weekdaysFromCron(hb.cron_expression) : null
    setEditId(hb.id)
    setEditError(null)
    setEditForm({
      ...blankForm(),
      title: hb.title,
      context: agent?.context ?? '',
      project: agent?.project ?? '',
      agent_path: hb.agent_path,
      prompt: hb.prompt,
      schedule_type: hb.cron_expression ? 'cron' : hb.interval_minutes === 1440 ? 'daily' : 'interval',
      interval_minutes: hb.interval_minutes === 1440 ? 60 : hb.interval_minutes,
      run_at_time: hb.run_at_time ?? '09:00',
      minute_offset: hb.minute_offset ?? null,
      ...(hb.cron_expression ? { cron_expression: hb.cron_expression, timezone: hb.timezone ?? serverTz } : {}),
      ...(simple ? { cron_time: simple.time, cron_days: simple.days } : {}),
    })
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault()
    if (!editId) return
    try {
      await updateHeartbeat(editId, {
        title: editForm.title.trim(),
        agent_path: editForm.agent_path,
        prompt: editForm.prompt.trim(),
        ...schedulePayload(editForm),
      })
    } catch (err) {
      setEditError((err as Error).message)
      return
    }
    setEditId(null)
    load(true)
  }

  const active  = heartbeats.filter(h => h.active === 1)
  const paused  = heartbeats.filter(h => h.active === 0)
  const running = heartbeats.filter(h => h.runs_pending > 0)

  if (loading) return <div className="heartbeats-empty">Loading…</div>

  return (
    <div className="heartbeats-view">
      <div className="heartbeats-header">
        <div className="heartbeats-summary">
          <span className="hb-stat-active">{active.length} active</span>
          {running.length > 0 && <span className="hb-stat-running">{running.length} running</span>}
          {paused.length > 0 && <span className="hb-stat-paused">{paused.length} paused</span>}
        </div>
        <button className="hb-add-btn" onClick={() => setCreating(c => !c)}>
          {creating ? '✕' : '+ New heartbeat'}
        </button>
      </div>

      {creating && (
        <form className="hb-form" onSubmit={handleCreate}>
          <input
            className="hb-input"
            placeholder="Name (e.g. Monitor inbox)"
            value={form.title}
            onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            autoFocus
            required
          />

          <AgentPicker
            agents={agents}
            context={form.context}
            project={form.project}
            agentPath={form.agent_path}
            onContextChange={ctx => setForm(f => ({ ...f, context: ctx, project: '', agent_path: '' }))}
            onProjectChange={proj => setForm(f => ({ ...f, project: proj, agent_path: '' }))}
            onAgentChange={(path, desc) => setForm(f => ({
              ...f,
              agent_path: path,
              prompt: f.prompt || desc || '',
            }))}
          />

          <textarea
            className="hb-textarea"
            placeholder="Prompt sent to the agent on each run"
            value={form.prompt}
            onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))}
            rows={4}
            required
          />

          <ScheduleFields form={form} setForm={setForm} />

          {formError && <div className="hb-form-error">{formError}</div>}
          <div className="hb-form-row hb-form-actions">
            <button type="submit" className="hb-btn-primary" disabled={!form.agent_path}>Create</button>
            <button type="button" className="hb-btn-cancel" onClick={() => { setCreating(false); setForm(blankForm()); setFormError(null) }}>Cancel</button>
          </div>
        </form>
      )}

      {heartbeats.length === 0 && !creating && (
        <div className="heartbeats-empty">No heartbeats yet. Add one above to start running background agents on a schedule.</div>
      )}

      {heartbeats.length > 0 && (
        <div className="hb-list">
          {heartbeats.map(hb => (
            <div key={hb.id} className={`hb-card${hb.active === 0 ? ' hb-paused' : ''}`}>
              {editId === hb.id ? (
                <form className="hb-edit-form" onSubmit={handleUpdate}>
                  <input className="hb-input" value={editForm.title} onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))} required />

                  <AgentPicker
                    agents={agents}
                    context={editForm.context}
                    project={editForm.project}
                    agentPath={editForm.agent_path}
                    onContextChange={ctx => setEditForm(f => ({ ...f, context: ctx, project: '', agent_path: '' }))}
                    onProjectChange={proj => setEditForm(f => ({ ...f, project: proj, agent_path: '' }))}
                    onAgentChange={path => setEditForm(f => ({ ...f, agent_path: path }))}
                  />

                  <textarea className="hb-textarea" value={editForm.prompt} onChange={e => setEditForm(f => ({ ...f, prompt: e.target.value }))} rows={4} required />

                  <ScheduleFields form={editForm} setForm={setEditForm} />

                  {editError && <div className="hb-form-error">{editError}</div>}
                  <div className="hb-form-row hb-form-actions">
                    <button type="submit" className="hb-btn-primary" disabled={!editForm.agent_path}>Save</button>
                    <button type="button" className="hb-btn-cancel" onClick={() => setEditId(null)}>Cancel</button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="hb-card-header">
                    <div className="hb-card-left">
                      <span className={`hb-indicator${hb.runs_pending > 0 ? ' hb-indicator-running' : hb.active ? ' hb-indicator-active' : ' hb-indicator-paused'}`} />
                      <div className="hb-card-info">
                        <span className="hb-title">{hb.title}</span>
                        {hb.description && <span className="hb-desc">{hb.description}</span>}
                      </div>
                    </div>
                    <div className="hb-card-actions">
                      <button className="hb-toggle-btn" onClick={() => handleToggle(hb.id)} title={hb.active ? 'Pause' : 'Resume'}>
                        {hb.active ? '⏸' : '▶'}
                      </button>
                      <button className="hb-icon-btn" onClick={() => startEdit(hb)} title="Edit">✎</button>
                      <button className="hb-icon-btn hb-delete-btn" onClick={() => handleDelete(hb.id)} title="Delete">✕</button>
                    </div>
                  </div>

                  <div className="hb-card-meta">
                    <span className="hb-meta-item">{scheduleLabel(hb)}</span>
                    <span className="hb-meta-sep">·</span>
                    <span className="hb-meta-item" title={hb.last_run_at ?? undefined}>Last: {relativeTime(hb.last_run_at)}</span>
                    {hb.active === 1 && (
                      <>
                        <span className="hb-meta-sep">·</span>
                        <span className="hb-meta-item" title={hb.next_run_at ?? undefined}>Next: {relativeTime(hb.next_run_at)}</span>
                      </>
                    )}
                    {(hb.runs_done > 0 || hb.runs_failed > 0) && (
                      <>
                        <span className="hb-meta-sep">·</span>
                        <span className="hb-meta-item hb-runs-done">{hb.runs_done} done</span>
                        {hb.runs_failed > 0 && <span className="hb-meta-item hb-runs-failed">{hb.runs_failed} failed</span>}
                      </>
                    )}
                    {hb.runs_pending > 0 && (
                      <>
                        <span className="hb-meta-sep">·</span>
                        <span className="hb-meta-item hb-running-badge">running…</span>
                      </>
                    )}
                  </div>

                  {hb.active === 1 && (hb.upcoming_runs?.length ?? 0) > 0 && (
                    <div className="hb-preview hb-card-upcoming">
                      <span className="hb-preview-label">Next runs</span>
                      {hb.upcoming_runs!.map(r => <span key={r} className="hb-preview-run">{formatRun(r, hb.timezone)}</span>)}
                    </div>
                  )}

                  <div className="hb-card-path" title={hb.agent_path}>
                    <span className="hb-path-label">path</span> {hb.agent_path}
                  </div>

                  <button className="hb-expand-btn" onClick={() => toggleExpand(hb.id)}>
                    {expandedId === hb.id ? '▴ hide history' : '▾ show history'}
                  </button>

                  {expandedId === hb.id && (
                    <div className="hb-jobs">
                      {!jobs[hb.id] && <div className="hb-jobs-empty">Loading…</div>}
                      {jobs[hb.id]?.length === 0 && <div className="hb-jobs-empty">No runs yet.</div>}
                      {jobs[hb.id]?.map(job => {
                        const isJobExpanded = expandedJobIds.has(job.id)
                        const truncated = job.result && job.result.length > 300
                        return (
                          <div key={job.id} className={`hb-job hb-job-${job.status}`}>
                            <div className="hb-job-header">
                              <span className="hb-job-status">{job.status}</span>
                              <span className="hb-job-time">{relativeTime(job.completed_at ?? job.created_at)}</span>
                            </div>
                            {job.result && (
                              <>
                                <div className="hb-job-result">
                                  {isJobExpanded ? job.result : job.result.slice(0, 300)}{!isJobExpanded && truncated ? '…' : ''}
                                </div>
                                {truncated && (
                                  <button className="hb-job-expand-btn" onClick={() => toggleJobExpand(job.id)}>
                                    {isJobExpanded ? 'show less' : 'show more'}
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
