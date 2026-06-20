// Detect the source platform of a task's link URL. Pure data + matcher, shared
// across desktop and mobile.

export const PLATFORMS = [
  { key: 'asana',      pattern: /asana\.com/,            label: 'Asana' },
  { key: 'missive',    pattern: /missiveapp\.com/,        label: 'Missive' },
  { key: 'notion',     pattern: /notion\.so/,             label: 'Notion' },
  { key: 'linear',     pattern: /linear\.app/,            label: 'Linear' },
  { key: 'github',     pattern: /github\.com/,            label: 'GitHub' },
  { key: 'slack',      pattern: /slack\.com/,             label: 'Slack' },
  { key: 'youtube',    pattern: /youtu\.be|youtube\.com/, label: 'YouTube' },
  { key: 'flightdesk', pattern: /flightdesk\.dev/,        label: 'FlightDesk' },
]

export function detectPlatform(url: string) {
  return PLATFORMS.find(p => p.pattern.test(url)) ?? { key: 'link', label: '🔗' }
}
