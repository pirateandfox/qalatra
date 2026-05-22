import { useState } from 'react'
import { createContext, deleteContext, updateContext } from '../../api'
import { useContexts } from '../../lib/ContextsProvider'

export function ContextsSettings() {
  const { contexts, refresh: refreshContexts } = useContexts()
  const [newSlug, setNewSlug] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newColor, setNewColor] = useState('#888888')
  const [editingSlug, setEditingSlug] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editColor, setEditColor] = useState('')

  async function saveContext(slug: string) {
    await updateContext(slug, { label: editLabel, color: editColor })
    refreshContexts()
    setEditingSlug(null)
  }

  async function addContext() {
    await createContext(newSlug.trim(), newLabel.trim(), newColor)
    refreshContexts()
    setNewSlug('')
    setNewLabel('')
    setNewColor('#888888')
  }

  return (
    <>
      <div className="settings-section-header" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>Contexts</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {contexts.map(c => (
          <div key={c.slug} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {editingSlug === c.slug ? (
              <>
                <input
                  type="color"
                  value={editColor}
                  onChange={e => setEditColor(e.target.value)}
                  style={{ width: 28, height: 28, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
                />
                <input
                  className="settings-input"
                  style={{ width: 180, flex: 'unset' }}
                  value={editLabel}
                  onChange={e => setEditLabel(e.target.value)}
                />
                <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>{c.slug}</span>
                <button className="settings-save" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => saveContext(c.slug)}>
                  Save
                </button>
                <button
                  className="settings-save"
                  style={{ padding: '4px 10px', fontSize: 12, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                  onClick={() => setEditingSlug(null)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: c.color, flexShrink: 0, display: 'inline-block' }} />
                <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{c.label}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>{c.slug}</span>
                <button
                  style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12, padding: '2px 6px' }}
                  onClick={() => {
                    setEditingSlug(c.slug)
                    setEditLabel(c.label)
                    setEditColor(c.color)
                  }}
                >
                  Edit
                </button>
                <button
                  style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 12, padding: '2px 6px' }}
                  onClick={async () => {
                    await deleteContext(c.slug)
                    refreshContexts()
                  }}
                >
                  Remove
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <input
          type="color"
          value={newColor}
          onChange={e => setNewColor(e.target.value)}
          style={{ width: 28, height: 28, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
        />
        <input
          className="settings-input"
          style={{ width: 120, flex: 'unset' }}
          placeholder="slug"
          value={newSlug}
          onChange={e => setNewSlug(e.target.value.toLowerCase().replace(/\s+/g, ''))}
        />
        <input
          className="settings-input"
          style={{ width: 160, flex: 'unset' }}
          placeholder="Display name"
          value={newLabel}
          onChange={e => setNewLabel(e.target.value)}
        />
        <button
          className="settings-save"
          style={{ padding: '4px 12px', fontSize: 12 }}
          disabled={!newSlug.trim() || !newLabel.trim()}
          onClick={addContext}
        >
          Add
        </button>
      </div>
    </>
  )
}
