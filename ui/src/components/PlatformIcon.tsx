interface Props {
  url: string
  size?: number
}

export default function PlatformIcon({ url, size = 14 }: Props) {
  const s = size

  if (/asana\.com/.test(url))
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor">
        <circle cx="12" cy="6.5" r="4"/>
        <circle cx="5.5" cy="16" r="4"/>
        <circle cx="18.5" cy="16" r="4"/>
      </svg>
    )

  if (/missiveapp\.com/.test(url))
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="4" width="20" height="16" rx="2"/>
        <polyline points="2,4 12,14 22,4"/>
      </svg>
    )

  if (/notion\.so/.test(url))
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor">
        <path d="M4 3h10l6 6v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h-.5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9l-6-6H4z"/>
        <path d="M14 3v6h6"/>
        <line x1="8" y1="13" x2="16" y2="13"/>
        <line x1="8" y1="17" x2="13" y2="17"/>
      </svg>
    )

  if (/linear\.app/.test(url))
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.5 14.5L9.5 20.5L20.5 3.5"/>
        <path d="M3.5 3.5L20.5 20.5"/>
      </svg>
    )

  if (/github\.com/.test(url))
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.34-3.369-1.34-.454-1.154-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/>
      </svg>
    )

  if (/slack\.com/.test(url))
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 4a2 2 0 1 0 0 4h2V4a2 2 0 0 0-2-2z"/>
        <path d="M4 9a2 2 0 0 0 0 4h4V9H4z"/>
        <path d="M15 20a2 2 0 0 0 0-4h-2v4a2 2 0 0 0 2 2z"/>
        <path d="M20 15a2 2 0 0 0 0-4h-4v4h4z"/>
      </svg>
    )

  if (/youtu\.be|youtube\.com/.test(url))
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="5" width="20" height="14" rx="4"/>
        <path d="M10 9l5 3-5 3V9z" fill="currentColor" stroke="none"/>
      </svg>
    )

  if (/flightdesk\.dev/.test(url))
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 17L12 5l9 12H3z"/>
      </svg>
    )

  // fallback: generic link icon
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>
  )
}
