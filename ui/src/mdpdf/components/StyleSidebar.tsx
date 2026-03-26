import { useState } from 'react'
import { type StyleConfig, FONT_OPTIONS, GOOGLE_FONTS, COLOR_PRESETS } from '../types'

interface Props {
  style: StyleConfig
  onChange: (style: StyleConfig) => void
}

function Slider({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit?: string
  onChange: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  function commit(raw: string) {
    const parsed = parseFloat(raw)
    if (!isNaN(parsed)) {
      const clamped = Math.min(max, Math.max(min, parsed))
      onChange(parseFloat((Math.round(clamped / step) * step).toFixed(10)))
    }
    setDraft(null)
  }
  return (
    <div className="slider-row">
      <span className="slider-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} />
      <input type="text" className="slider-value"
        value={draft !== null ? draft : `${value}${unit ?? ''}`}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => { setDraft(String(value)); e.target.select() }}
        onBlur={(e) => commit(e.target.value.replace(unit ?? '', ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit((e.target as HTMLInputElement).value.replace(unit ?? '', '')); e.currentTarget.blur() }
          if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur() }
        }}
        style={{ cursor: 'text' }}
      />
    </div>
  )
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="color-input-row">
      <div className="color-swatch" style={{ background: value }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
      <span style={{ fontSize: 12, color: '#a1a1aa', flex: 1 }}>{label}</span>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)}
        style={{ width: 72, background: '#27272a', color: '#e4e4e7', border: '1px solid #3f3f46',
          borderRadius: 4, padding: '2px 6px', fontSize: 11, fontFamily: 'monospace', outline: 'none' }} />
    </div>
  )
}

export function StyleSidebar({ style, onChange }: Props) {
  function update(partial: Partial<StyleConfig>) { onChange({ ...style, ...partial }) }
  function updateMargin(side: keyof StyleConfig['margins'], value: number) {
    onChange({ ...style, margins: { ...style.margins, [side]: value } })
  }
  function updateColor(key: keyof StyleConfig['customColors'], value: string) {
    onChange({ ...style, colorScheme: 'custom', customColors: { ...style.customColors, [key]: value } })
  }
  function applyPreset(scheme: StyleConfig['colorScheme']) {
    if (scheme === 'custom') update({ colorScheme: 'custom' })
    else update({ colorScheme: scheme, customColors: COLOR_PRESETS[scheme] })
  }

  return (
    <div className="sidebar" style={{ height: '100%' }}>
      <div className="sidebar-section">
        <div className="sidebar-label">Typography</div>
        <div style={{ marginBottom: 10 }}>
          <select value={style.fontFamily} onChange={(e) => update({ fontFamily: e.target.value })}>
            <optgroup label="System Fonts">
              {FONT_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
            </optgroup>
            <optgroup label="Google Fonts">
              {GOOGLE_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
            </optgroup>
          </select>
        </div>
        <Slider label="Body size" value={style.fontSize} min={8} max={18} step={0.5} unit="pt" onChange={(v) => update({ fontSize: v })} />
        <Slider label="Line height" value={style.lineHeight} min={1.0} max={2.5} step={0.05} onChange={(v) => update({ lineHeight: v })} />
        <Slider label="Heading scale" value={style.headingScale} min={0.8} max={2.0} step={0.05} onChange={(v) => update({ headingScale: v })} />
      </div>

      <div className="sidebar-section">
        <div className="sidebar-label">Page</div>
        <div className="toggle-group" style={{ marginBottom: 12 }}>
          {(['letter', 'a4'] as const).map((size) => (
            <button key={size} className={`toggle-btn ${style.pageSize === size ? 'active' : ''}`}
              onClick={() => update({ pageSize: size })}>
              {size === 'letter' ? 'Letter' : 'A4'}
            </button>
          ))}
        </div>
        <div className="sidebar-label" style={{ marginTop: 4 }}>Margins (inches)</div>
        <Slider label="Top" value={style.margins.top} min={0.25} max={2} step={0.05} unit="″" onChange={(v) => updateMargin('top', v)} />
        <Slider label="Bottom" value={style.margins.bottom} min={0.25} max={2} step={0.05} unit="″" onChange={(v) => updateMargin('bottom', v)} />
        <Slider label="Left" value={style.margins.left} min={0.25} max={2} step={0.05} unit="″" onChange={(v) => updateMargin('left', v)} />
        <Slider label="Right" value={style.margins.right} min={0.25} max={2} step={0.05} unit="″" onChange={(v) => updateMargin('right', v)} />
      </div>

      <div className="sidebar-section">
        <div className="sidebar-label">Color Scheme</div>
        <div className="preset-grid" style={{ marginBottom: 12 }}>
          {(['default', 'minimal', 'print-dark'] as const).map((key) => (
            <button key={key} className={`preset-btn ${style.colorScheme === key ? 'active' : ''}`}
              onClick={() => applyPreset(key)}>
              {key === 'print-dark' ? 'Print Dark' : key.charAt(0).toUpperCase() + key.slice(1)}
            </button>
          ))}
          <button className={`preset-btn ${style.colorScheme === 'custom' ? 'active' : ''}`}
            onClick={() => applyPreset('custom')}>Custom</button>
        </div>
        <ColorRow label="Body text" value={style.customColors.body} onChange={(v) => updateColor('body', v)} />
        <ColorRow label="Headings" value={style.customColors.heading} onChange={(v) => updateColor('heading', v)} />
        <ColorRow label="Links" value={style.customColors.link} onChange={(v) => updateColor('link', v)} />
        <ColorRow label="Code" value={style.customColors.code} onChange={(v) => updateColor('code', v)} />
        <ColorRow label="Background" value={style.customColors.bg} onChange={(v) => updateColor('bg', v)} />
      </div>
    </div>
  )
}
