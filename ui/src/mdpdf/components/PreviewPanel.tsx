import { useEffect, useRef, useState } from 'react'
import { type StyleConfig, PAGE_DIMS, isGoogleFont, googleFontUrl } from '../types'
import { resolveColors } from '../utils/contentStyles'
import { parseMarkdownToBlocks, measureBlockHeights, buildPages, type PageData } from '../utils/pagination'

interface Props {
  markdown: string
  style: StyleConfig
  onInsertBreakAfter?: (sourceCharEnd: number) => void
  onRemoveBreak?: (breakIndex: number) => void
}

function BreakZone({ sourceCharEnd, onInsert }: { sourceCharEnd: number; onInsert: (pos: number) => void }) {
  const [hovered, setHovered] = useState(false)
  // height: 0 so it adds no space to the layout (matching the PDF which has no such zones).
  // The hit area is absolutely positioned, extending 8px above and below.
  return (
    <div style={{ position: 'relative', height: 0, overflow: 'visible' }}>
      <div
        style={{
          position: 'absolute', left: 0, right: 0, top: -8, height: 16,
          cursor: 'pointer', zIndex: 10,
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => onInsert(sourceCharEnd)}
      >
        <div style={{
          position: 'absolute', left: 0, right: 0, top: '50%',
          transform: 'translateY(-50%)',
          height: hovered ? 2 : 0,
          background: '#3b82f6',
          borderRadius: 1,
        }} />
        {hovered && (
          <div style={{
            position: 'absolute', left: '50%', top: '50%',
            transform: 'translate(-50%, -50%)',
            background: '#2563eb', color: 'white', fontSize: 10, fontWeight: 600,
            padding: '2px 10px', borderRadius: 4, whiteSpace: 'nowrap',
            pointerEvents: 'none', fontFamily: 'system-ui, sans-serif', lineHeight: 1.5,
          }}>
            + Insert page break
          </div>
        )}
      </div>
    </div>
  )
}

function pageCSS(cls: string, style: StyleConfig, colors: ReturnType<typeof resolveColors>): string {
  const s = style.fontSize
  const sc = style.headingScale
  const codeBg = colors.bg === '#ffffff' || colors.bg === '#fafafa' ? '#f0f0f0' : 'rgba(255,255,255,0.1)'
  const preBg  = colors.bg === '#ffffff' || colors.bg === '#fafafa' ? '#f4f4f4' : 'rgba(255,255,255,0.07)'
  return `
    .${cls} h1 { font-size:${(s*sc*2).toFixed(1)}pt; color:${colors.heading}; font-weight:700; margin:0 0 0.4em; line-height:1.2; }
    .${cls} h2 { font-size:${(s*sc*1.5).toFixed(1)}pt; color:${colors.heading}; font-weight:700; margin:1.2em 0 0.4em; line-height:1.25; }
    .${cls} h3 { font-size:${(s*sc*1.2).toFixed(1)}pt; color:${colors.heading}; font-weight:600; margin:1em 0 0.3em; line-height:1.3; }
    .${cls} h4,.${cls} h5,.${cls} h6 { font-size:${(s*sc).toFixed(1)}pt; color:${colors.heading}; font-weight:600; margin:0.8em 0 0.2em; }
    .${cls} p { margin:0 0 0.9em; }
    .${cls} ul { list-style-type:disc; margin:0 0 0.9em; padding-left:1.6em; }
    .${cls} ol { list-style-type:decimal; margin:0 0 0.9em; padding-left:1.6em; }
    .${cls} li { margin-bottom:0.25em; }
    .${cls} li > p { margin:0; }
    .${cls} code { font-family:'Courier New',monospace; font-size:0.88em; color:${colors.code}; background:${codeBg}; padding:0.15em 0.35em; border-radius:3px; }
    .${cls} pre { background:${preBg}; padding:1em 1.2em; border-radius:4px; margin:0 0 1em; overflow:hidden; }
    .${cls} pre code { background:none; padding:0; font-size:0.87em; }
    .${cls} blockquote { border-left:3px solid ${colors.heading}40; margin:0 0 1em; padding:0.4em 1em; color:${colors.body}99; font-style:italic; }
    .${cls} a { color:${colors.link}; text-decoration:underline; }
    .${cls} hr { border:none; border-top:1px solid ${colors.body}22; margin:1.5em 0; }
    .${cls} table { border-collapse:collapse; width:100%; margin-bottom:1em; font-size:0.95em; }
    .${cls} th,.${cls} td { border:1px solid ${colors.body}22; padding:0.5em 0.75em; text-align:left; }
    .${cls} th { background:${colors.body}0d; font-weight:600; }
    .${cls} img { max-width:100%; height:auto; display:block; margin:0.5em 0; }
    .${cls} strong { color:${colors.heading}; }
    .${cls} > div:first-child > div:first-child > * { margin-top: 0; }
  `
}

export function PreviewPanel({ markdown, style, onInsertBreakAfter, onRemoveBreak }: Props) {
  const [pages, setPages] = useState<PageData[]>([])
  const [scale, setScale] = useState(1)
  const panelRef = useRef<HTMLDivElement>(null)

  const pageDims = PAGE_DIMS[style.pageSize]
  const DPR = 96
  const marginPx = {
    top: style.margins.top * DPR,
    right: style.margins.right * DPR,
    bottom: style.margins.bottom * DPR,
    left: style.margins.left * DPR,
  }
  const contentW = pageDims.width - marginPx.left - marginPx.right
  const contentH = pageDims.height - marginPx.top - marginPx.bottom
  const colors = resolveColors(style)

  useEffect(() => {
    if (!panelRef.current) return
    const obs = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width
      setScale(Math.min(1, (w - 40) / pageDims.width))
    })
    obs.observe(panelRef.current)
    return () => obs.disconnect()
  }, [pageDims.width])

  useEffect(() => {
    const linkId = '__topdf_gfont__'
    const existing = document.getElementById(linkId)
    if (isGoogleFont(style.fontFamily)) {
      const url = googleFontUrl(style.fontFamily)
      if (existing instanceof HTMLLinkElement && existing.href === url) return
      existing?.remove()
      const link = document.createElement('link')
      link.id = linkId
      link.rel = 'stylesheet'
      link.href = url
      document.head.appendChild(link)
    } else {
      existing?.remove()
    }
  }, [style.fontFamily])

  useEffect(() => {
    const blocks = parseMarkdownToBlocks(markdown)
    const contentBlocks = blocks.filter((b) => !b.isBreak).map((b) => b.html)
    const heights = measureBlockHeights(contentBlocks, style, contentW)
    setPages(buildPages(blocks, heights, contentH))
  }, [markdown, style, contentW, contentH])

  const scaledH = pageDims.height * scale

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="preview-header">
        <span>Preview</span>
        <span style={{ fontSize: 11, color: '#52525b' }}>
          Tip: hover between paragraphs to insert a page break
        </span>
        <span style={{ marginLeft: 'auto' }}>
          {pages.length} page{pages.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div
        ref={panelRef}
        style={{
          flex: 1, overflowY: 'auto', overflowX: 'hidden',
          padding: '24px 16px', display: 'flex', flexDirection: 'column',
          alignItems: 'center', background: '#121214',
        }}
      >
        <div style={{ width: pageDims.width * scale }}>
          {(() => {
            let bc = 0
            const breakIndices = pages.map((p) => (p.isManualBreak ? bc++ : -1))
            return pages.map((page, pageIdx) => {
              const cls = `pi${pageIdx}`
              const currentBreakIdx = breakIndices[pageIdx]
              const totalBlocks = pages.reduce((n, p) => n + p.blocks.length, 0)
              return (
                <div key={pageIdx}>
                  {pageIdx > 0 && page.isManualBreak && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      margin: '0 0 8px', padding: '4px 12px',
                      background: '#1e1b4b', border: '1px solid #4338ca40',
                      borderRadius: 4, fontSize: 11, color: '#818cf8',
                      fontFamily: 'system-ui, sans-serif',
                    }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                      </svg>
                      Manual page break
                      <span style={{ color: '#4338ca', marginLeft: 4, fontSize: 10 }}>
                        {'<!-- pagebreak -->'}
                      </span>
                      <button
                        onClick={() => onRemoveBreak?.(currentBreakIdx)}
                        title="Remove this page break"
                        style={{
                          marginLeft: 'auto', background: 'none', border: 'none',
                          color: '#818cf8', cursor: 'pointer', fontSize: 14,
                          lineHeight: 1, padding: '0 2px', borderRadius: 3,
                          display: 'flex', alignItems: 'center',
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff' }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#818cf8' }}
                      >×</button>
                    </div>
                  )}

                  <div style={{
                    width: pageDims.width, height: pageDims.height,
                    transform: `scale(${scale})`, transformOrigin: 'top left',
                    marginBottom: scaledH - pageDims.height + 24,
                    background: colors.bg, boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
                    borderRadius: 2, overflow: 'hidden', position: 'relative',
                  }}>
                    <style>{pageCSS(cls, style, colors)}</style>
                    <div className={cls} style={{
                      position: 'absolute',
                      top: marginPx.top, left: marginPx.left,
                      right: marginPx.right, bottom: marginPx.bottom,
                      overflow: 'visible',
                      fontFamily: style.fontFamily,
                      fontSize: `${style.fontSize}pt`,
                      lineHeight: style.lineHeight,
                      color: colors.body,
                    }}>
                      {page.blocks.map((block, blockIdx) => {
                        const isLastInDoc = block.globalIndex === totalBlocks - 1
                        const showZone = !isLastInDoc && !block.suppressBreakZone
                        return (
                          <div key={blockIdx}>
                            <div dangerouslySetInnerHTML={{ __html: block.html }} />
                            {showZone && (
                              <BreakZone
                                sourceCharEnd={block.sourceCharEnd}
                                onInsert={onInsertBreakAfter ?? (() => {})}
                              />
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )
            })
          })()}
        </div>
      </div>
    </div>
  )
}
