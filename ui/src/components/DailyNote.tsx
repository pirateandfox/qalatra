import { useState, useEffect, useRef, useCallback } from 'react'
import { fetchDailyNote, saveDailyNote } from '../api'
import './DailyNote.css'

interface Props {
  open: boolean
  onClose: () => void
  date: string
}

export default function DailyNote({ open, onClose, date }: Props) {
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSaved = useRef('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    fetchDailyNote(date).then(r => {
      setContent(r.content)
      lastSaved.current = r.content
    })
  }, [date])

  useEffect(() => {
    if (open) setTimeout(() => textareaRef.current?.focus(), 50)
  }, [open])

  const save = useCallback(async (text: string) => {
    if (text === lastSaved.current) return
    setSaving(true)
    await saveDailyNote(date, text)
    lastSaved.current = text
    setSaving(false)
  }, [date])

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const text = e.target.value
    setContent(text)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => save(text), 800)
  }

  function handleBlur() {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    save(content)
  }

  return (
    <div className={`note-panel ${open ? 'open' : ''}`}>
      <div className="terminal-toolbar">
        <span className="terminal-title">Daily Note — {date}</span>
        {saving && <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 8 }}>saving…</span>}
        <button className="terminal-close" onClick={onClose}>✕</button>
      </div>
      <div className="note-body">
        <textarea
          ref={textareaRef}
          className="note-textarea"
          value={content}
          onChange={handleChange}
          onBlur={handleBlur}
          placeholder="What's on your mind today? Jot down thoughts, context, intentions…"
        />
      </div>
    </div>
  )
}
