import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Task } from '../types/task'
import './CompletionControls.css'

interface Props {
  task: Pick<Task, 'id' | 'status' | 'recurrence' | 'task_type'> & { outcome?: string | null }
  /** Called after any successful state change (complete, skip, reopen). */
  onChanged: () => void
  /** Noun used in confirm copy for incomplete children ("subtask" / "agenda item"). */
  childNoun?: string
  /** Which edge the note popover anchors to. */
  align?: 'left' | 'right'
}

// Manual Complete / Skip controls for a single task, event or meeting — the UI path to the same
// transitions MCP complete_task / skip_task perform (recurring items spawn their next occurrence
// server-side). Complete is one click; the ▾ opens an optional outcome note.
export default function CompletionControls({ task, onChanged, childNoun = 'subtask', align = 'left' }: Props) {
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)

  const isDone = task.status === 'done'
  const isEvent = task.task_type === 'event'
  const isRecurring = !!task.recurrence

  useEffect(() => {
    setNoteOpen(false)
    setNote('')
    setError(null)
  }, [task.id])

  useEffect(() => {
    if (noteOpen) noteRef.current?.focus()
  }, [noteOpen])

  async function run(action: () => Promise<boolean>) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (await action()) {
        setNoteOpen(false)
        setNote('')
        onChanged()
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const complete = (withNote: boolean) => run(async () => {
    const text = withNote ? note.trim() || undefined : undefined
    const result = await api.complete(task.id, text)
    if (result?.ok === false) {
      if (result.reason !== 'subtasks_incomplete') return false
      const n = result.count as number
      const yes = window.confirm(`Complete all ${n} ${childNoun}${n > 1 ? 's' : ''} and mark this done?`)
      if (!yes) return false
      await api.completeWithSubtasks(task.id, text)
    }
    return true
  })

  const skip = () => run(async () => {
    const result = await api.skip(task.id)
    return result?.ok !== false
  })

  const reopen = () => run(async () => {
    const result = await api.uncomplete(task.id)
    return result?.ok !== false
  })

  if (isDone) {
    const skipped = task.outcome === 'skipped'
    return (
      <div className="completion-controls">
        <span className={`completion-state${skipped ? ' skipped' : ''}`}>{skipped ? '⊟ Skipped' : '✓ Done'}</span>
        {/* Events never get status transitions beyond "mark done", so no reopen for them. */}
        {!isEvent && (
          <button className="completion-btn" onClick={reopen} disabled={busy} title="Mark active again">
            Reopen
          </button>
        )}
        {error && <span className="completion-error" title={error}>Failed</span>}
      </div>
    )
  }

  return (
    <div className={`completion-wrap${align === 'right' ? ' align-right' : ''}`}>
      <div className="completion-controls">
        <div className="completion-split">
          <button
            className="completion-btn completion-primary"
            onClick={() => complete(false)}
            disabled={busy}
            title={isRecurring ? 'Mark done and create the next occurrence' : 'Mark done'}
          >
            ✓ Complete
          </button>
          <button
            className={`completion-btn completion-primary completion-caret${noteOpen ? ' open' : ''}`}
            onClick={() => setNoteOpen(o => !o)}
            disabled={busy}
            title="Complete with note…"
            aria-label="Complete with note"
            aria-expanded={noteOpen}
          >
            ▾
          </button>
        </div>
        {isRecurring && (
          <button
            className="completion-btn"
            onClick={skip}
            disabled={busy}
            title="Skip this occurrence and create the next one"
          >
            ⊟ Skip
          </button>
        )}
        {error && <span className="completion-error" title={error}>Failed</span>}
      </div>
      {noteOpen && (
        <div className="completion-note">
          <textarea
            ref={noteRef}
            className="completion-note-input"
            placeholder="Outcome / completion note (optional)…"
            value={note}
            rows={3}
            maxLength={4000}
            onChange={e => setNote(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); complete(true) }
              if (e.key === 'Escape') { e.preventDefault(); setNoteOpen(false) }
            }}
          />
          <div className="completion-note-actions">
            <span className="completion-note-hint">⌘↵ to complete</span>
            <button className="completion-btn" onClick={() => setNoteOpen(false)} disabled={busy}>Cancel</button>
            <button className="completion-btn completion-primary" onClick={() => complete(true)} disabled={busy}>
              ✓ Complete with note
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
