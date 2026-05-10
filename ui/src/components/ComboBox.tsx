import { useState, useRef, useEffect, useCallback } from 'react'
import './ComboBox.css'

export interface ComboOption {
  value: string
  label: string
  sublabel?: string
  color?: string
}

interface Props {
  options: ComboOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  nullable?: boolean   // allows clearing back to ""
  emptyText?: string   // shown when no options match filter
  disabled?: boolean
}

export default function ComboBox({ options, value, onChange, placeholder = 'Select…', nullable = false, emptyText = 'No matches', disabled = false }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = options.find(o => o.value === value)

  const filtered = query.trim()
    ? options.filter(o =>
        o.label.toLowerCase().includes(query.toLowerCase()) ||
        (o.sublabel ?? '').toLowerCase().includes(query.toLowerCase())
      )
    : options

  useEffect(() => {
    setHighlighted(0)
  }, [query, open])

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  useEffect(() => {
    if (!open) return
    function onOutside(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open, close])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  function select(val: string) {
    onChange(val)
    close()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) }
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted(h => Math.min(h + 1, filtered.length - 1)) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)) }
    if (e.key === 'Enter')     { e.preventDefault(); if (filtered[highlighted]) select(filtered[highlighted].value) }
  }

  return (
    <div className={`combobox${open ? ' open' : ''}${disabled ? ' disabled' : ''}`} ref={containerRef}>
      <button
        type="button"
        className="combobox-trigger"
        onClick={() => !disabled && setOpen(v => !v)}
        onKeyDown={onKeyDown}
        disabled={disabled}
      >
        {selected ? (
          <span className="combobox-value">
            {selected.color && <span className="combobox-dot" style={{ background: selected.color }} />}
            {selected.label}
            {selected.sublabel && <span className="combobox-sublabel">{selected.sublabel}</span>}
          </span>
        ) : (
          <span className="combobox-placeholder">{placeholder}</span>
        )}
        <svg className="combobox-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>

      {open && (
        <div className="combobox-dropdown">
          <div className="combobox-search-wrap">
            <input
              ref={inputRef}
              className="combobox-search"
              placeholder="Search…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
          <div className="combobox-list">
            {nullable && (
              <button
                type="button"
                className={`combobox-option combobox-option--none${!value ? ' active' : ''}`}
                onMouseDown={() => select('')}
              >
                None
              </button>
            )}
            {filtered.length === 0 && (
              <div className="combobox-empty">{emptyText}</div>
            )}
            {filtered.map((o, i) => (
              <button
                key={o.value}
                type="button"
                className={`combobox-option${o.value === value ? ' selected' : ''}${i === highlighted ? ' highlighted' : ''}`}
                onMouseDown={() => select(o.value)}
                onMouseEnter={() => setHighlighted(i)}
              >
                {o.color && <span className="combobox-dot" style={{ background: o.color }} />}
                <span className="combobox-option-label">{o.label}</span>
                {o.sublabel && <span className="combobox-sublabel">{o.sublabel}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
