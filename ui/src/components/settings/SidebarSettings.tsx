import { getActiveInstance } from '../../api'
import { NAV_ITEMS, normalizeSidebarConfig, type NavSection, type SidebarConfig } from '../../lib/nav'

interface SidebarSettingsProps {
  config: SidebarConfig
  onChange: (config: SidebarConfig) => void
}

export function SidebarSettings({ config, onChange }: SidebarSettingsProps) {
  const hidden = new Set(config.hidden)
  const backendName = getActiveInstance()?.name ?? 'this machine (local)'

  function toggleVisible(key: NavSection) {
    if (config.landing === key) return // the default view can't be hidden
    const next = new Set(hidden)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(normalizeSidebarConfig({ ...config, hidden: [...next], landing: config.landing }))
  }

  function setLanding(key: NavSection) {
    // Making a section the default also unhides it (normalize enforces this).
    onChange(normalizeSidebarConfig({ ...config, hidden: config.hidden, landing: key }))
  }

  function patch(fields: Partial<SidebarConfig>) {
    onChange(normalizeSidebarConfig({ ...config, ...fields }))
  }

  return (
    <>
      <div className="settings-section-header" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
        Sidebar Navigation
      </div>
      <p className="settings-hint" style={{ marginTop: 0, marginBottom: 16, maxWidth: 560 }}>
        Configuring the sidebar for <strong style={{ color: 'var(--text)' }}>{backendName}</strong>.
        Choose which sections appear and which one loads on launch. This is set per backend and stored
        on this device, so switching backends swaps the sidebar to that backend&apos;s view — a personal
        backend can show everything while a remote server hides what it doesn&apos;t use. The default view
        is always shown and can&apos;t be hidden.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 560 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 8px 6px', fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          <span style={{ width: 28 }}>Show</span>
          <span style={{ flex: 1 }}>Section</span>
          <span style={{ width: 70, textAlign: 'center' }}>Default</span>
        </div>

        {NAV_ITEMS.map(item => {
          const isLanding = config.landing === item.key
          const isVisible = !hidden.has(item.key)
          return (
            <div
              key={item.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '8px',
                borderRadius: 6,
                background: isLanding ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
              }}
            >
              <input
                type="checkbox"
                checked={isVisible}
                disabled={isLanding}
                onChange={() => toggleVisible(item.key)}
                title={isLanding ? 'The default view is always shown' : isVisible ? 'Hide from sidebar' : 'Show in sidebar'}
                style={{ width: 28, cursor: isLanding ? 'not-allowed' : 'pointer' }}
              />
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, opacity: isVisible ? 1 : 0.5 }}>
                <span style={{ width: 20, textAlign: 'center', fontSize: 14 }}>{item.icon}</span>
                <span style={{ color: 'var(--text)' }}>{item.label}</span>
              </span>
              <label
                style={{ width: 70, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: 'var(--muted)' }}
                title="Load this section on launch"
              >
                <input
                  type="radio"
                  name="sidebar-landing"
                  checked={isLanding}
                  onChange={() => setLanding(item.key)}
                  style={{ cursor: 'pointer' }}
                />
              </label>
            </div>
          )
        })}
      </div>

      <div className="settings-section-header">Tools (web)</div>
      <p className="settings-hint" style={{ marginTop: 0, marginBottom: 12, maxWidth: 560 }}>
        An optional sidebar item that opens this backend&apos;s web tool. Off by default; give it any
        label you like.
      </p>
      <div className="settings-row">
        <label className="settings-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={config.toolsEnabled}
            onChange={e => patch({ toolsEnabled: e.target.checked })}
            style={{ cursor: 'pointer' }}
          />
          Show Tools item
        </label>
        <input
          className="settings-input"
          type="text"
          value={config.toolsLabel}
          onChange={e => patch({ toolsLabel: e.target.value })}
          placeholder="Tools"
          disabled={!config.toolsEnabled}
          spellCheck={false}
          style={{ maxWidth: 240 }}
        />
        <span className="settings-hint">The name shown in the sidebar for the web tool.</span>
      </div>
    </>
  )
}
