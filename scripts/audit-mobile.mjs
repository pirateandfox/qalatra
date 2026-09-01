import { spawnSync } from 'node:child_process'

// Narrow, temporary allowlist. Every entry names the package it was reasoned about, so an advisory
// id cannot silently start covering a different dependency later; everything else still fails.
const allowed = new Map([
  // Expo 56 pulls image-size through Metro, with no patched release as of 2026-08-10. Metro only
  // parses trusted, repository-owned image assets at build time, so this is not reachable from
  // remote input. Remove when Expo/Metro moves to a patched image-size.
  ['GHSA-w3rx-r6r6-pgpr', { package: 'image-size', why: 'ICNS parser infinite loop in Metro build tooling' }],
  ['GHSA-5p2g-fcmc-qvqq', { package: 'image-size', why: 'JXL/HEIF parser infinite loop in Metro build tooling' }],
  // Unlike the two above this one is RUNTIME code, not build tooling: @react-navigation/native ->
  // core -> query-string@7 -> decode-uri-component, i.e. deep-link URL parsing. It is allowed only
  // because there is no installable fix and nothing ships today:
  //   - vulnerable range is <=0.4.2 and the only fixed release, 0.5.0, is ESM-only, while
  //     query-string@7 is CommonJS — an override breaks the bundle rather than fixing it, which is
  //     why npm reports fixAvailable:false;
  //   - the release workflow installs mobile dependencies for this gate but publishes no mobile
  //     artifact, so no user runs this code.
  // Remove as soon as @react-navigation moves to query-string v8+, which drops this dependency.
  // If mobile builds are ever published, this exception must be re-argued before that ships.
  ['GHSA-vcc3-ghjq-m6fr', { package: 'decode-uri-component', why: 'DoS in deep-link URL parsing; no installable fix, and no mobile artifact is published' }],
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
