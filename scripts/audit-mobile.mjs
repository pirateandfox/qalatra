import { spawnSync } from 'node:child_process'

// Narrow, temporary allowlist. Every entry names the package it was reasoned about, so an advisory
// id cannot silently start covering a different dependency later; everything else still fails.
const allowed = new Map([
  // Expo 56 pulls image-size through Metro, with no patched release as of 2026-08-10. Metro only
  // parses trusted, repository-owned image assets at build time, so this is not reachable from
  // remote input. Remove when Expo/Metro moves to a patched image-size.
  ['GHSA-w3rx-r6r6-pgpr', { package: 'image-size', why: 'ICNS parser infinite loop in Metro build tooling' }],
  ['GHSA-5p2g-fcmc-qvqq', { package: 'image-size', why: 'JXL/HEIF parser infinite loop in Metro build tooling' }],
  // No patched braces release exists as of 2026-10-03 (all versions <= 3.0.3). Reached only through
  // micromatch in Metro's / @expo/metro-file-map's file watcher, matching repository-owned glob
  // patterns at bundle time — never app input. Remove when braces publishes a fix or Metro drops it.
  ['GHSA-vfj7-8cjw-p6xm', { package: 'braces', why: 'brace-pattern stack exhaustion in Metro file-watcher build tooling' }],
  // No patched node-forge release exists as of 2026-10-03 (<= 1.4.0). Used by
  // @expo/code-signing-certificates in the Expo CLI and expo-updates' `cli/` signing-key commands;
  // the shipped app verifies update signatures natively and never loads node-forge. Remove when
  // node-forge publishes a fix.
  ['GHSA-86w9-cpqp-85rv', { package: 'node-forge', why: 'RSA signature parsing in Expo CLI code-signing tooling, not the app' }],
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
  ([id, advisory]) => allowed.has(id) && advisory.name !== allowed.get(id).package,
)

if (unexpected.length || invalidExceptions.length || (vulnerabilities.length && !advisories.size)) {
  process.stderr.write(audit.stdout)
  process.exit(1)
}

if (advisories.size) {
  console.log(`mobile audit passed with ${advisories.size} temporary exception(s) — see scripts/audit-mobile.mjs for why each is allowed:`)
  for (const [id] of advisories) console.log(`- ${id} (${allowed.get(id).package}): ${allowed.get(id).why}`)
} else {
  console.log('mobile audit passed with 0 vulnerabilities')
}
