import { useState, useEffect, useRef, useCallback } from 'react'
import { fetchDailyNote, saveDailyNote } from '../api'
import BottomPanel from './BottomPanel'
import './DailyNote.css'

interface Props {
  open: boolean
  fullscreen: boolean
  onClose: () => void
  onToggleFullscreen: () => void
  date: string
}

export default function DailyNote({ open, fullscreen, onClose, onToggleFullscreen, date }: Props) {
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
    <BottomPanel
      title={<>Daily Note — {date}{saving && <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 8, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>saving…</span>}</>}
      open={open}
      fullscreen={fullscreen}
      onClose={onClose}
      onToggleFullscreen={onToggleFullscreen}
      dockedHeight={300}
      zIndex={99}
    >
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
    </BottomPanel>
  )
}
