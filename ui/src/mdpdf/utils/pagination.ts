import { marked, Lexer } from 'marked'
import { type StyleConfig } from '../types'

export interface Block {
  html: string
  isBreak: boolean
  sourceCharEnd: number    // char position in md after this block — insert pagebreak here
  suppressBreakZone: boolean  // true for mid-table rows (no break zone shown)
}

export interface PageBlock {
  html: string
  globalIndex: number
  sourceCharEnd: number
  suppressBreakZone: boolean
}

export interface PageData {
  blocks: PageBlock[]
  isManualBreak: boolean
}

const BREAK_RE = /<!--\s*pagebreak\s*-->/i

function listItemHtml(tag: string, startAttr: string, itemRaw: string, margin: string): string {
  const parsed = marked.parse(itemRaw)
  const html = parsed instanceof Promise ? '' : parsed
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const li = doc.querySelector('li')
  if (!li) return ''
  return `<${tag}${startAttr} style="margin:${margin};padding-left:1.6em;list-style-position:outside">${li.outerHTML}</${tag}>`
}

export function parseMarkdownToBlocks(md: string): Block[] {
  const result: Block[] = []
  const tokens = Lexer.lex(md)
  let charPos = 0

  for (const token of tokens) {
    const len = token.raw?.length ?? 0

    if (token.type === 'space') {
      charPos += len
      continue
    }

    if (token.type === 'html' && BREAK_RE.test(token.raw ?? '')) {
      result.push({ html: '', isBreak: true, sourceCharEnd: charPos + len, suppressBreakZone: false })
      charPos += len
      continue
    }

    if (token.type === 'list') {
      const tag = token.ordered ? 'ol' : 'ul'
      let itemCharPos = charPos
      const items = (token as any).items as any[]
      items.forEach((item: any, idx: number) => {
        const isLast = idx === items.length - 1
        const startAttr = token.ordered ? ` start="${idx + 1}"` : ''
        const margin = isLast ? '0 0 0.9em' : '0'
        const html = listItemHtml(tag, startAttr, item.raw, margin)
        if (html) {
          result.push({
            html,
            isBreak: false,
            sourceCharEnd: itemCharPos + item.raw.length,
            suppressBreakZone: false,
          })
        }
        itemCharPos += item.raw.length
      })
      charPos += len
      continue
    }

    if (token.type === 'table') {
      const tableHtml = marked.parse(token.raw)
      const parsed = tableHtml instanceof Promise ? '' : tableHtml
      const doc = new DOMParser().parseFromString(parsed, 'text/html')
      const tableEl = doc.querySelector('table')
      if (tableEl) {
        const thead = tableEl.querySelector('thead')
        const theadHtml = thead?.outerHTML ?? ''
        const tbody = tableEl.querySelector('tbody')
        const rows = Array.from(
          tbody ? tbody.querySelectorAll(':scope > tr') : tableEl.querySelectorAll(':scope > tr')
        )
        // Count columns from header so every row table uses identical fixed widths
        const colCount = thead ? thead.querySelectorAll('th').length : (rows[0]?.querySelectorAll('td').length ?? 1)
        const colPct = (100 / colCount).toFixed(4)
        const colgroup = `<colgroup>${Array.from({ length: colCount }, () => `<col style="width:${colPct}%">`).join('')}</colgroup>`
        const tableEnd = charPos + len
        rows.forEach((row, idx) => {
          const isFirst = idx === 0
          const isLast = idx === rows.length - 1
          const marginTop = isFirst ? '0' : '-1px'
          const marginBottom = isLast ? '1em' : '0'
          const inner = isFirst && theadHtml
            ? `${colgroup}${theadHtml}<tbody>${row.outerHTML}</tbody>`
            : `${colgroup}<tbody>${row.outerHTML}</tbody>`
          result.push({
            html: `<table style="width:100%;table-layout:fixed;border-collapse:collapse;font-size:0.95em;margin:${marginTop} 0 ${marginBottom}">${inner}</table>`,
            isBreak: false,
            sourceCharEnd: tableEnd,
            suppressBreakZone: !isLast,
          })
        })
      }
      charPos += len
      continue
    }

    // Regular block token
    const tokenHtml = marked.parse(token.raw)
    const parsed = tokenHtml instanceof Promise ? '' : tokenHtml
    const doc = new DOMParser().parseFromString(parsed, 'text/html')
    for (const child of doc.body.children) {
      const text = child.textContent?.trim().replace(/\u00a0/g, '') ?? ''
      if (!text && child.tagName.toLowerCase() === 'p') continue
      result.push({
        html: child.outerHTML,
        isBreak: false,
        sourceCharEnd: charPos + len,
        suppressBreakZone: false,
      })
    }
    charPos += len
  }

  return result.length
    ? result
    : [{ html: '<p>&nbsp;</p>', isBreak: false, sourceCharEnd: 0, suppressBreakZone: false }]
}

export function measureBlockHeights(
  contentBlocks: string[],
  style: StyleConfig,
  contentWidthPx: number,
): number[] {
  if (contentBlocks.length === 0) return []

  const s = style.fontSize
  const sc = style.headingScale
  const styleEl = document.createElement('style')
  styleEl.textContent = `
    .__m__ h1 { font-size:${(s*sc*2).toFixed(1)}pt; font-weight:700; margin:0 0 0.4em; line-height:1.2; }
    .__m__ h2 { font-size:${(s*sc*1.5).toFixed(1)}pt; font-weight:700; margin:1.2em 0 0.4em; line-height:1.25; }
    .__m__ h3 { font-size:${(s*sc*1.2).toFixed(1)}pt; font-weight:600; margin:1em 0 0.3em; line-height:1.3; }
    .__m__ h4,.__m__ h5,.__m__ h6 { font-size:${(s*sc).toFixed(1)}pt; font-weight:600; margin:0.8em 0 0.2em; }
    .__m__ p { margin:0 0 0.9em; }
    .__m__ ul { list-style-type:disc; margin:0 0 0.9em; padding-left:1.6em; }
    .__m__ ol { list-style-type:decimal; margin:0 0 0.9em; padding-left:1.6em; }
    .__m__ li { margin-bottom:0.25em; }
    .__m__ pre { padding:1em 1.2em; margin:0 0 1em; }
    .__m__ blockquote { margin:0 0 1em; padding:0.4em 1em; }
    .__m__ table { margin-bottom:1em; border-collapse:collapse; width:100%; }
    .__m__ th,.__m__ td { padding:0.5em 0.75em; border:1px solid #ddd; }
    .__m__ hr { margin:1.5em 0; }
    .__m__ img { max-width:100%; height:auto; }
  `
  const container = document.createElement('div')
  Object.assign(container.style, {
    position: 'fixed',
    top: '-9999px',
    left: '-9999px',
    width: `${contentWidthPx}px`,
    visibility: 'hidden',
    pointerEvents: 'none',
    fontFamily: style.fontFamily,
    fontSize: `${style.fontSize}pt`,
    lineHeight: `${style.lineHeight}`,
  })
  container.classList.add('__m__')
  document.head.appendChild(styleEl)
  document.body.appendChild(container)

  const wrappers: HTMLDivElement[] = contentBlocks.map((html) => {
    const w = document.createElement('div')
    w.innerHTML = html
    container.appendChild(w)
    return w
  })

  const tops = wrappers.map((w) => w.getBoundingClientRect().top)
  const containerBottom = container.getBoundingClientRect().bottom
  const heights: number[] = tops.map((top, i) =>
    (i < tops.length - 1 ? tops[i + 1] : containerBottom) - top
  )

  document.body.removeChild(container)
  document.head.removeChild(styleEl)
  return heights
}

export function buildPages(
  blocks: Block[],
  heights: number[],
  pageContentHeightPx: number,
): PageData[] {
  const pages: PageData[] = []
  let cur: { blocks: PageBlock[]; height: number; isManualBreak: boolean } = {
    blocks: [],
    height: 0,
    isManualBreak: false,
  }
  let globalIndex = 0

  const flush = (isManual: boolean) => {
    if (cur.blocks.length) pages.push({ blocks: cur.blocks, isManualBreak: cur.isManualBreak })
    cur = { blocks: [], height: 0, isManualBreak: isManual }
  }

  for (const block of blocks) {
    if (block.isBreak) {
      flush(true)
      continue
    }
    const h = heights[globalIndex] ?? 16
    if (cur.blocks.length > 0 && cur.height + h > pageContentHeightPx) {
      flush(false)
    }
    cur.blocks.push({
      html: block.html,
      globalIndex,
      sourceCharEnd: block.sourceCharEnd,
      suppressBreakZone: block.suppressBreakZone,
    })
    cur.height += h
    globalIndex++
  }

  if (cur.blocks.length) pages.push({ blocks: cur.blocks, isManualBreak: cur.isManualBreak })
  return pages.length
    ? pages
    : [{ blocks: [{ html: '<p>&nbsp;</p>', globalIndex: 0, sourceCharEnd: 0, suppressBreakZone: false }], isManualBreak: false }]
}
