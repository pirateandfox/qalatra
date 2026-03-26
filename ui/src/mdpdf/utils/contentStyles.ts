import { type StyleConfig, COLOR_PRESETS } from '../types'

export function resolveColors(style: StyleConfig): StyleConfig['customColors'] {
  if (style.colorScheme === 'custom') return style.customColors
  return COLOR_PRESETS[style.colorScheme] ?? style.customColors
}

export function getContentCSS(style: StyleConfig): string {
  const c = resolveColors(style)
  const basePt = style.fontSize
  const scale = style.headingScale
  const font = style.fontFamily

  return `
    font-family: ${font};
    font-size: ${basePt}pt;
    line-height: ${style.lineHeight};
    color: ${c.body};
    background-color: ${c.bg};

    h1 { font-size: ${(basePt * scale * 2).toFixed(1)}pt; color: ${c.heading}; font-weight: 700; margin: 0 0 0.4em; line-height: 1.2; }
    h2 { font-size: ${(basePt * scale * 1.5).toFixed(1)}pt; color: ${c.heading}; font-weight: 700; margin: 1.2em 0 0.4em; line-height: 1.25; }
    h3 { font-size: ${(basePt * scale * 1.2).toFixed(1)}pt; color: ${c.heading}; font-weight: 600; margin: 1em 0 0.3em; line-height: 1.3; }
    h4, h5, h6 { font-size: ${(basePt * scale).toFixed(1)}pt; color: ${c.heading}; font-weight: 600; margin: 0.8em 0 0.2em; }
    p { margin: 0 0 0.9em; }
    ul, ol { margin: 0 0 0.9em; padding-left: 1.6em; }
    li { margin-bottom: 0.25em; }
    li > p { margin: 0; }
    code { font-family: 'Courier New', Courier, monospace; font-size: 0.88em; color: ${c.code}; background: ${c.bg === '#ffffff' || c.bg === '#fafafa' ? '#f0f0f0' : 'rgba(255,255,255,0.1)'}; padding: 0.15em 0.35em; border-radius: 3px; }
    pre { background: ${c.bg === '#ffffff' || c.bg === '#fafafa' ? '#f4f4f4' : 'rgba(255,255,255,0.07)'}; padding: 1em 1.2em; border-radius: 4px; margin: 0 0 1em; overflow: hidden; }
    pre code { background: none; padding: 0; font-size: 0.87em; color: ${c.code}; }
    blockquote { border-left: 3px solid ${c.heading}40; margin: 0 0 1em; padding: 0.4em 1em; color: ${c.body}99; font-style: italic; }
    a { color: ${c.link}; text-decoration: underline; }
    hr { border: none; border-top: 1px solid ${c.body}22; margin: 1.5em 0; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 1em; font-size: 0.95em; }
    th, td { border: 1px solid ${c.body}22; padding: 0.5em 0.75em; text-align: left; }
    th { background: ${c.body}0d; font-weight: 600; color: ${c.heading}; }
    img { max-width: 100%; height: auto; display: block; margin: 0.5em 0; }
    strong { color: ${c.heading}; }
  `
}
