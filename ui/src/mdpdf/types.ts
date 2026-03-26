export interface StyleConfig {
  fontFamily: string
  fontSize: number
  lineHeight: number
  pageSize: 'letter' | 'a4'
  margins: { top: number; right: number; bottom: number; left: number }
  headingScale: number
  colorScheme: 'default' | 'minimal' | 'print-dark' | 'custom'
  customColors: {
    body: string
    heading: string
    link: string
    code: string
    bg: string
  }
}

export interface DocumentConfig {
  filePath: string
  pageBreaks: number[]
  style: StyleConfig
}

export const DEFAULT_STYLE: StyleConfig = {
  fontFamily: 'Georgia',
  fontSize: 12,
  lineHeight: 1.4,
  pageSize: 'letter',
  margins: { top: 1, right: 1, bottom: 1, left: 1 },
  headingScale: 1.0,
  colorScheme: 'default',
  customColors: {
    body: '#1a1a1a',
    heading: '#111111',
    link: '#2563eb',
    code: '#374151',
    bg: '#ffffff',
  },
}

export const COLOR_PRESETS: Record<string, StyleConfig['customColors']> = {
  default: { body: '#1a1a1a', heading: '#111111', link: '#2563eb', code: '#374151', bg: '#ffffff' },
  minimal: { body: '#333333', heading: '#111111', link: '#555555', code: '#444444', bg: '#fafafa' },
  'print-dark': {
    body: '#f0f0f0',
    heading: '#ffffff',
    link: '#93c5fd',
    code: '#d1d5db',
    bg: '#1a1a2e',
  },
}

// Kept as fallback if Rust font enumeration fails
export const FONT_OPTIONS = [
  'Georgia', 'Palatino', 'Times New Roman', 'Helvetica Neue', 'Arial',
  'Gill Sans', 'Optima', 'Avenir', 'Futura', 'Courier New', 'Menlo',
]

export const GOOGLE_FONTS = [
  // Sans-serif
  'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins',
  'Raleway', 'Nunito', 'Oswald', 'Source Sans 3', 'Ubuntu', 'Rubik',
  'Work Sans', 'Mulish', 'Quicksand', 'DM Sans', 'Josefin Sans',
  'Fira Sans', 'Noto Sans', 'PT Sans', 'Cabin', 'Oxygen', 'Karla',
  'Barlow', 'Exo 2', 'Titillium Web', 'Jost', 'Plus Jakarta Sans',
  'Outfit', 'Figtree', 'IBM Plex Sans', 'Manrope',
  // Serif
  'Playfair Display', 'Merriweather', 'Lora', 'EB Garamond',
  'Libre Baskerville', 'Cormorant Garamond', 'Crimson Text', 'Spectral',
  'Source Serif 4', 'PT Serif', 'Noto Serif', 'Bitter', 'Arvo',
  'Libre Caslon Text', 'Cardo', 'Vollkorn', 'Frank Ruhl Libre',
  'Domine', 'Zilla Slab', 'Unna', 'IBM Plex Serif',
  // Monospace
  'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'Space Mono',
  'Roboto Mono', 'IBM Plex Mono', 'Inconsolata', 'DM Mono', 'Oxanium',
  // Display / Decorative
  'Bebas Neue', 'Abril Fatface', 'Pacifico', 'Righteous', 'Lobster',
  'Dancing Script', 'Sacramento', 'Great Vibes',
]

export function googleFontUrl(family: string): string {
  const encoded = encodeURIComponent(family).replace(/%20/g, '+')
  return `https://fonts.googleapis.com/css2?family=${encoded}:ital,wght@0,400;0,700;1,400&display=swap`
}

export function isGoogleFont(family: string): boolean {
  return GOOGLE_FONTS.includes(family)
}

export const PAGE_DIMS = {
  letter: { width: 816, height: 1056 },
  a4: { width: 794, height: 1123 },
}
