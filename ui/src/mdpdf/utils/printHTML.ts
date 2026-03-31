import { marked } from 'marked'
import { type StyleConfig, PAGE_DIMS, isGoogleFont, googleFontUrl } from '../types'
import { resolveColors } from './contentStyles'
import { type PageData } from './pagination'

const BREAK_RE = /(?:^|\r?\n)[ \t]*<!--\s*pagebreak\s*-->[ \t]*(?:\r?\n|$)/gim

function buildPagesHTML(markdown: string): string {
  const segments = markdown.split(new RegExp(BREAK_RE.source, BREAK_RE.flags))
  return segments
    .map((seg, i) => {
      const html = marked.parse(seg.trim())
      const content = html instanceof Promise ? '' : html
      // Strip empty paragraphs so they don't create blank space in the PDF
      const cleaned = content.replace(/<p>(\s|&nbsp;)*<\/p>/gi, '')
      // Apply break-before directly to the segment rather than a separate zero-height
      // div — avoids WKWebView adding a gap at the top of the new page.
      const cls = i > 0 ? 'segment page-break' : 'segment'
      return `<div class="${cls}">${cleaned}</div>`
    })
    .join('')
}

/**
 * Build typography/content CSS, with selectors optionally prefixed by `scope`.
 * Does NOT include @page — caller handles that separately.
 */
function buildContentCSS(style: StyleConfig, scope: string): string {
  const colors = resolveColors(style)
  const s = style.fontSize
  const sc = style.headingScale
  const codeBg = colors.bg === '#ffffff' || colors.bg === '#fafafa' ? '#f0f0f0' : 'rgba(0,0,0,0.1)'
  const preBg  = colors.bg === '#ffffff' || colors.bg === '#fafafa' ? '#f4f4f4' : 'rgba(0,0,0,0.06)'
  const bodySelector = scope || 'body'
  const p = scope ? `${scope} ` : ''

  return `
    ${bodySelector} {
      margin: 0; padding: 0;
      background: ${colors.bg};
      font-family: ${style.fontFamily};
      font-size: ${s}pt;
      line-height: ${style.lineHeight};
      color: ${colors.body};
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    ${p}.page-break { break-before: page; page-break-before: always; }
    ${p}.segment > *:first-child { margin-top: 0; }
    ${p}h1 { font-size:${(s*sc*2).toFixed(1)}pt; color:${colors.heading}; font-weight:700; margin:0 0 0.4em; line-height:1.2; }
    ${p}h2 { font-size:${(s*sc*1.5).toFixed(1)}pt; color:${colors.heading}; font-weight:700; margin:1.2em 0 0.4em; line-height:1.25; }
    ${p}h3 { font-size:${(s*sc*1.2).toFixed(1)}pt; color:${colors.heading}; font-weight:600; margin:1em 0 0.3em; line-height:1.3; }
    ${p}h4,${p}h5,${p}h6 { font-size:${(s*sc).toFixed(1)}pt; color:${colors.heading}; font-weight:600; margin:0.8em 0 0.2em; }
    ${p}p { margin:0 0 0.9em; }
    ${p}ul { list-style-type:disc; margin:0 0 0.9em; padding-left:1.6em; }
    ${p}ol { list-style-type:decimal; margin:0 0 0.9em; padding-left:1.6em; }
    ${p}li { margin-bottom:0.25em; }
    ${p}li > p { margin:0; }
    ${p}code { font-family:'Courier New',Courier,monospace; font-size:0.88em; color:${colors.code}; background:${codeBg}; padding:0.15em 0.35em; border-radius:3px; }
    ${p}pre { background:${preBg}; padding:1em 1.2em; border-radius:4px; margin:0 0 1em; }
    ${p}pre code { background:none; padding:0; font-size:0.87em; }
    ${p}blockquote { border-left:3px solid ${colors.heading}40; margin:0 0 1em; padding:0.4em 1em; color:${colors.body}99; font-style:italic; }
    ${p}a { color:${colors.link}; }
    ${p}hr { border:none; border-top:1px solid ${colors.body}22; margin:1.5em 0; }
    ${p}table { border-collapse:collapse; width:100%; margin-bottom:1em; font-size:0.95em; }
    ${p}th,${p}td { border:1px solid ${colors.body}22; padding:0.5em 0.75em; text-align:left; }
    ${p}th { background:${colors.body}0d; font-weight:600; }
    ${p}img { max-width:100%; height:auto; }
    ${p}strong { color:${colors.heading}; }
  `
}

function buildPageAtRule(style: StyleConfig): string {
  const pageDims = PAGE_DIMS[style.pageSize]
  const pageWIn = (pageDims.width / 96).toFixed(4)
  const pageHIn = (pageDims.height / 96).toFixed(4)
  const m = style.margins
  return `@page { margin: ${m.top}in ${m.right}in ${m.bottom}in ${m.left}in; size: ${pageWIn}in ${pageHIn}in; }`
}

/** Full standalone HTML document for silent PDF export (no print dialog trigger) */
export function buildExportHTML(markdown: string, style: StyleConfig): string {
  const pageRule = buildPageAtRule(style)
  const css = buildContentCSS(style, '')
  const body = buildPagesHTML(markdown)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  ${pageRule}
  ${css}
</style>
</head>
<body>${body}</body>
</html>`
}

/** Full standalone HTML document — opens in browser for printing */
export function buildPrintHTML(markdown: string, style: StyleConfig): string {
  const pageRule = buildPageAtRule(style)
  const css = buildContentCSS(style, '')
  const body = buildPagesHTML(markdown)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  ${pageRule}
  ${css}
</style>
</head>
<body>${body}<script>
window.addEventListener('load', function() {
  setTimeout(function() { window.print(); }, 200);
});
</script></body>
</html>`
}

export function buildPagedExportHTML(
  _markdown: string,
  style: StyleConfig,
  pages: PageData[],
  pageDims: { width: number; height: number },
  marginPx: { top: number; right: number; bottom: number; left: number },
): string {
  const pageWIn = (pageDims.width / 96).toFixed(4)
  const pageHIn = (pageDims.height / 96).toFixed(4)
  const css = buildContentCSS(style, '.print-page')

  const pagesHTML = pages
    .map((page, i) => {
      const isLast = i === pages.length - 1
      const breakAfter = isLast ? 'avoid' : 'always'
      const blocksHTML = page.blocks.map((b) => b.html).join('\n')
      return `<div class="print-page" style="width:${pageDims.width}px;height:${pageDims.height}px;padding:${marginPx.top}px ${marginPx.right}px ${marginPx.bottom}px ${marginPx.left}px;page-break-after:${breakAfter};overflow:hidden;box-sizing:border-box;position:relative;">${blocksHTML}</div>`
    })
    .join('\n')

  const googleLink = isGoogleFont(style.fontFamily)
    ? `<link rel="stylesheet" href="${googleFontUrl(style.fontFamily)}">`
    : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${googleLink}
<style>
  *, *::before, *::after { box-sizing: border-box; }
  @page { margin: 0; size: ${pageWIn}in ${pageHIn}in; }
  body { margin: 0; padding: 0; }
  .print-page > *:first-child { margin-top: 0; }
  ${css}
</style>
</head>
<body>${pagesHTML}</body>
</html>`
}

const OVERLAY_ID = '__topdf_print__'
const STYLE_ID   = '__topdf_style__'

/**
 * Inject print content into the live DOM under @media print styles.
 * Does NOT call window.print() — the caller decides whether to print or
 * pass control to the Rust NSPrintOperation command.
 * Returns a cleanup function to remove the injected nodes.
 */
export function injectPrintContent(markdown: string, style: StyleConfig): () => void {
  document.getElementById(OVERLAY_ID)?.remove()
  document.getElementById(STYLE_ID)?.remove()

  const pageRule   = buildPageAtRule(style)
  const contentCSS = buildContentCSS(style, `#${OVERLAY_ID}`)
  const pagesHTML  = buildPagesHTML(markdown)

  const styleEl = document.createElement('style')
  styleEl.id = STYLE_ID
  styleEl.textContent = `
    ${pageRule}
    #${OVERLAY_ID} { display: none !important; }
    @media print {
      html, body { margin: 0 !important; padding: 0 !important; height: auto !important; overflow: visible !important; }
      #root { display: none !important; }
      #${OVERLAY_ID} { display: block !important; height: auto !important; overflow: visible !important; }
      ${contentCSS}
    }
  `

  const overlayEl = document.createElement('div')
  overlayEl.id = OVERLAY_ID
  overlayEl.innerHTML = pagesHTML

  document.head.appendChild(styleEl)
  document.body.appendChild(overlayEl)

  return () => {
    document.getElementById(OVERLAY_ID)?.remove()
    document.getElementById(STYLE_ID)?.remove()
  }
}
