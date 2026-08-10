import { spawnSync } from 'node:child_process'

// Expo 56 currently pulls image-size through Metro. The two advisories below have no patched
// image-size release as of 2026-08-10. Metro only parses trusted, repository-owned image assets at
// build time; it is not reachable from remote input in the shipped app. Keep this narrow allowlist
// until Expo/Metro moves to a patched image-size, while continuing to fail on every other advisory.
const allowed = new Map([
  ['GHSA-w3rx-r6r6-pgpr', 'ICNS parser infinite loop in Metro build tooling'],
  ['GHSA-5p2g-fcmc-qvqq', 'JXL/HEIF parser infinite loop in Metro build tooling'],
])

const audit = spawnSync('npm', ['audit', '--json', '--prefix', 'mobile'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
})

let report
try {
  report = JSON.parse(audit.stdout)
} catch {
  process.stderr.write(audit.stderr || audit.stdout || 'npm audit returned no report\n')
  process.exit(audit.status || 1)
}

const vulnerabilities = Object.values(report.vulnerabilities || {})
const advisories = new Map()
for (const vulnerability of vulnerabilities) {
  for (const item of vulnerability.via || []) {
    if (typeof item !== 'object' || !item.url) continue
    const id = item.url.split('/').pop()
    advisories.set(id, item)
  }
}

const unexpected = [...advisories.entries()].filter(([id]) => !allowed.has(id))
const invalidExceptions = [...advisories.entries()].filter(
  ([id, advisory]) => allowed.has(id) && advisory.name !== 'image-size',
)

if (unexpected.length || invalidExceptions.length || (vulnerabilities.length && !advisories.size)) {
  process.stderr.write(audit.stdout)
  process.exit(1)
}

if (advisories.size) {
  console.log(`mobile audit passed with ${advisories.size} temporary build-tool exception(s):`)
  for (const [id] of advisories) console.log(`- ${id}: ${allowed.get(id)}`)
} else {
  console.log('mobile audit passed with 0 vulnerabilities')
}
